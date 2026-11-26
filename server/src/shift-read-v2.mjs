import { v2Error } from './v2-errors.mjs';
import { ROLES } from './identity-rules.mjs';
import { authorizeShift, visibleShiftPredicate } from './shift-access-v2.mjs';

// Visible shift list and scoped snapshot (design §5.1, §6, §8, plan Task 18).
//
// Reads are workspace+shift scoped and never workspace-wide: the list is one
// keyset page of the caller's visible active/closing shifts, and the snapshot
// loads exactly one shift plus its own members, statuses, logs and the detached
// trips that legitimately reference it. Authorization is not re-implemented
// here — it is `visibleShiftPredicate` (list) and `authorizeShift('shift.read')`
// (snapshot), the only two ACL paths of the parallel-shift domain.
//
// Two rows can never be listed:
//   * `historical` — an unproven legacy row is not a live line and not a list
//     state at all (`state` is a whitelist of active/closing);
//   * `restored` — a restored archive copy is a separate read-only context, not
//     a line (025 D7 keeps it historical; the explicit filter is the second belt).
// `shift_type_resolution='unresolved'` is also excluded so an unproven day/night
// can never back a live tab, even if a future whitelist grows.

const ID = /^[A-Za-z0-9_-]{1,160}$/;
const CURSOR_PREFIX = 'v2.1.';
const CURSOR_MAX = 512;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const LIST_STATES = Object.freeze(['active', 'closing']);
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

function requireWorkspace(value) {
  const workspaceId = value ?? process.env.WORKSPACE_ID ?? 'main_workspace';
  if (typeof workspaceId !== 'string' || !ID.test(workspaceId)) {
    throw v2Error('invalid-command', 400, { field: 'workspaceId' });
  }
  return workspaceId;
}

function requireShiftId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw v2Error('invalid-command', 400, { field: 'shiftId' });
  return value;
}

function requireActor(actor) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)
      || typeof actor.uid !== 'string' || actor.uid.length === 0 || actor.uid.length > 128
      || !ROLES.includes(actor.role)) {
    throw v2Error('unauthenticated', 401);
  }
  return actor;
}

// `state` is a closed whitelist, never free text: a client asking for
// `historical` or `closed` gets a schema error instead of another line's data.
function parseStates(value) {
  if (value === undefined || value === null || value === '') return [...LIST_STATES];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  if (raw.length === 0 || raw.length > LIST_STATES.length * 2) {
    throw v2Error('invalid-command', 400, { field: 'state' });
  }
  const states = [];
  for (const item of raw) {
    const state = typeof item === 'string' ? item.trim() : '';
    if (!LIST_STATES.includes(state)) throw v2Error('invalid-command', 400, { field: 'state' });
    if (!states.includes(state)) states.push(state);
  }
  return states;
}

function parseLimit(value) {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,2}$/.test(text)) {
    throw v2Error('invalid-command', 400, { field: 'limit' });
  }
  const limit = Number(text);
  if (limit < 1 || limit > MAX_LIST_LIMIT) throw v2Error('invalid-command', 400, { field: 'limit' });
  return limit;
}

// Opaque keyset cursor: explicit version prefix + base64url of the exact
// `opened_at`/`shift_id` pair. It is decoded into bound parameters only — client
// input is never interpolated into SQL — and every malformed value is a schema
// error, not a silently different page.
export function encodeShiftCursor({ openedAt, shiftId }) {
  const at = openedAt instanceof Date ? openedAt.toISOString() : String(openedAt);
  if (!ISO_MS.test(at) || typeof shiftId !== 'string' || !ID.test(shiftId)) {
    throw new TypeError('encodeShiftCursor requires an ISO timestamp and a shift id');
  }
  return CURSOR_PREFIX + Buffer.from(JSON.stringify({ o: at, s: shiftId }), 'utf8').toString('base64url');
}

export function decodeShiftCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length <= CURSOR_PREFIX.length + 1
      || cursor.length > CURSOR_MAX || !cursor.startsWith(CURSOR_PREFIX)) {
    throw v2Error('invalid-command', 400, { field: 'cursor' });
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw v2Error('invalid-command', 400, { field: 'cursor' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(',') !== 'o,s'
      || typeof parsed.o !== 'string' || !ISO_MS.test(parsed.o)
      || typeof parsed.s !== 'string' || !ID.test(parsed.s)
      || !Number.isFinite(Date.parse(parsed.o))) {
    throw v2Error('invalid-command', 400, { field: 'cursor' });
  }
  return { openedAt: new Date(Date.parse(parsed.o)), shiftId: parsed.s };
}

// `shift_operation_receipts` becomes shift-scoped in a later migration (§4.5).
// Until then a pending receipt cannot be attributed to a shift, so the honest
// answer is zero; the moment `shift_id` exists the same query counts the rows
// that are still unfinished (`result='{}'` is the in-transaction placeholder).
async function pendingReceiptsByShift(client, workspaceId, shiftIds) {
  if (shiftIds.length === 0) return new Map();
  const hasShift = (await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='shift_operation_receipts' AND column_name='shift_id'`,
  )).rowCount > 0;
  if (!hasShift) return new Map();
  const rows = (await client.query(
    `SELECT shift_id, count(*)::int AS pending
       FROM shift_operation_receipts
      WHERE workspace_id=$1 AND shift_id = ANY($2::text[]) AND result = '{}'::jsonb
      GROUP BY shift_id`,
    [workspaceId, shiftIds],
  )).rows;
  return new Map(rows.map(row => [row.shift_id, Number(row.pending)]));
}

export async function listVisibleShifts(pool, actor, options = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('listVisibleShifts requires a database pool');
  const who = requireActor(actor);
  const workspaceId = requireWorkspace(options.workspaceId);
  const states = parseStates(options.state);
  const limit = parseLimit(options.limit);
  const cursor = options.cursor === undefined || options.cursor === null
    ? null
    : decodeShiftCursor(options.cursor);

  // `$1` workspace, `$2` states; the visibility predicate takes `$3` for uid.
  const visible = visibleShiftPredicate(who, 's', 3);
  const params = [workspaceId, states, ...visible.params];
  let keyset = '';
  if (cursor) {
    params.push(cursor.openedAt.toISOString(), cursor.shiftId);
    const at = `$${params.length - 1}`;
    const id = `$${params.length}`;
    keyset = `AND (s.opened_at < ${at}::timestamptz OR (s.opened_at = ${at}::timestamptz AND s.shift_id COLLATE "C" > ${id}::text))`;
  }
  params.push(limit + 1);
  const pageSize = `$${params.length}`;

  const client = await pool.connect();
  try {
    // One consistent read: the page and its receipt counts cannot disagree.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows = (await client.query(
      `SELECT s.shift_id, s.object_id, s.object_name_snapshot,
              to_char(s.work_date,'YYYY-MM-DD') AS work_date,
              s.shift_type, s.state, s.opened_at, s.revision,
              (SELECT count(*)::int FROM shift_members m
                WHERE m.workspace_id=s.workspace_id AND m.shift_id=s.shift_id
                  AND m.removed_at IS NULL) AS active_members,
              (SELECT COALESCE(sum(m.revision),0)::bigint FROM shift_members m
                WHERE m.workspace_id=s.workspace_id AND m.shift_id=s.shift_id) AS member_revision_sum
         FROM shifts s
        WHERE s.workspace_id=$1
          AND s.state = ANY($2::text[])
          AND s.shift_type_resolution IN ('source','manual')
          AND s.payload->>'restored' IS DISTINCT FROM 'true'
          AND ${visible.sql}
          ${keyset}
        ORDER BY s.opened_at DESC, s.shift_id COLLATE "C" ASC
        LIMIT ${pageSize}`,
      params,
    )).rows;
    const page = rows.slice(0, limit);
    const pending = await pendingReceiptsByShift(client, workspaceId, page.map(row => row.shift_id));
    await client.query('COMMIT');
    return {
      items: page.map(row => ({
        shiftId: row.shift_id,
        objectId: row.object_id,
        objectName: row.object_name_snapshot,
        workDate: row.work_date,
        shiftType: row.shift_type,
        state: row.state,
        openedAt: new Date(row.opened_at).toISOString(),
        shiftRevision: Number(row.revision),
        memberRevisionSummary: {
          activeMembers: Number(row.active_members),
          revisionSum: Number(row.member_revision_sum),
        },
        pendingServerReceipts: pending.get(row.shift_id) ?? 0,
      })),
      nextCursor: rows.length > limit
        ? encodeShiftCursor({ openedAt: new Date(page[page.length - 1].opened_at), shiftId: page[page.length - 1].shift_id })
        : null,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function isoOrNull(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function shiftLabel(row, prefix) {
  return {
    workspaceId: row.workspace_id,
    shiftId: row[`${prefix}_shift_id`],
    objectId: row[`${prefix}_object_id`],
    objectName: row[`${prefix}_object_name`],
    workDate: row[`${prefix}_work_date`],
    shiftType: row[`${prefix}_shift_type`],
  };
}

// §4.4 detached trips: `Task 20` ships the table; a read must not fail before it
// exists, and the columns below are the fixed design contract.
async function readDetachedOpenTrips(client, workspaceId, shiftId) {
  const present = (await client.query("SELECT to_regclass('public.detached_open_trips') IS NOT NULL AS present")).rows[0]?.present === true;
  if (!present) return [];
  const rows = (await client.query(
    `SELECT d.workspace_id, d.truck_id, d.cycle_id, d.source_shift_id, d.destination_shift_id,
            d.stage, d.cycle_revision, d.detached_at,
            ss.object_id AS source_object_id, ss.object_name_snapshot AS source_object_name,
            to_char(ss.work_date,'YYYY-MM-DD') AS source_work_date, ss.shift_type AS source_shift_type,
            ds.object_id AS destination_object_id, ds.object_name_snapshot AS destination_object_name,
            to_char(ds.work_date,'YYYY-MM-DD') AS destination_work_date, ds.shift_type AS destination_shift_type
       FROM detached_open_trips d
       JOIN shifts ss ON ss.workspace_id=d.workspace_id AND ss.shift_id=d.source_shift_id
       JOIN shifts ds ON ds.workspace_id=d.workspace_id AND ds.shift_id=d.destination_shift_id
      WHERE d.workspace_id=$1 AND d.state='open'
        AND (d.source_shift_id=$2 OR d.destination_shift_id=$2)
      ORDER BY d.detached_at ASC, d.source_shift_id COLLATE "C" ASC, d.cycle_id COLLATE "C" ASC`,
    [workspaceId, shiftId],
  )).rows;
  return rows.map(row => ({
    workspaceId: row.workspace_id,
    truckId: row.truck_id,
    cycleId: row.cycle_id,
    sourceShiftId: row.source_shift_id,
    destinationShiftId: row.destination_shift_id,
    state: 'open',
    stage: row.stage,
    cycleRevision: Number(row.cycle_revision),
    detachedAt: isoOrNull(row.detached_at),
    sourceShift: shiftLabel(row, 'source'),
    destinationShift: shiftLabel(row, 'destination'),
  }));
}

export async function readShiftSnapshot(pool, actor, options = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('readShiftSnapshot requires a database pool');
  requireActor(actor);
  const workspaceId = requireWorkspace(options.workspaceId);
  const shiftId = requireShiftId(options.shiftId);
  const client = await pool.connect();
  try {
    // Repeatable read keeps the snapshot internally consistent. It is not a
    // READ ONLY transaction because the mandatory ACL path takes `FOR SHARE`
    // on `role_permissions`, which PostgreSQL forbids in a read-only one.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    // The single authorization path: 404 for a missing or invisible shift, and
    // `shift.read` deliberately stays readable on a closed/historical row for a
    // member (design §6: closed answers 410 for commands, stays readable).
    await authorizeShift(client, actor, { workspaceId, shiftId, action: 'shift.read' });

    const shift = (await client.query(
      `SELECT shift_id, object_id, object_name_snapshot,
              to_char(work_date,'YYYY-MM-DD') AS work_date,
              shift_type, shift_type_resolution, state, opened_at, opened_by_uid,
              opened_by_name_snapshot, payload_schema_version, identity_resolution,
              revision, object_locked_at, closing_started_at, closing_by_uid,
              closed_at, closed_by_uid, payload
         FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [workspaceId, shiftId],
    )).rows[0];
    if (!shift) throw v2Error('shift-not-visible', 404, { shiftId });

    const members = (await client.query(
      `SELECT uid, assigned_at, assigned_by_uid, removed_at, removed_by_uid, revision
         FROM shift_members
        WHERE workspace_id=$1 AND shift_id=$2
        ORDER BY uid COLLATE "C"`,
      [workspaceId, shiftId],
    )).rows.map(row => ({
      workspaceId,
      shiftId,
      uid: row.uid,
      assignedAt: isoOrNull(row.assigned_at),
      assignedByUid: row.assigned_by_uid,
      removedAt: isoOrNull(row.removed_at),
      removedByUid: row.removed_by_uid,
      revision: Number(row.revision),
    }));

    const statuses = (await client.query(
      `SELECT truck_id, status_revision, cycle_revision, ttn_revision, payload
         FROM line_truck_statuses
        WHERE workspace_id=$1 AND shift_id=$2
        ORDER BY truck_id COLLATE "C"`,
      [workspaceId, shiftId],
    )).rows.map(row => ({
      ...row.payload,
      workspaceId,
      shiftId,
      id: row.truck_id,
      truckId: row.truck_id,
      statusRevision: Number(row.status_revision),
      cycleRevision: Number(row.cycle_revision),
      ttnRevision: Number(row.ttn_revision),
    }));

    const logs = (await client.query(
      `SELECT log_id, truck_id, payload
         FROM line_logs
        WHERE workspace_id=$1 AND shift_id=$2
        ORDER BY log_id COLLATE "C"`,
      [workspaceId, shiftId],
    )).rows.map(row => ({
      ...row.payload,
      workspaceId,
      shiftId,
      id: row.log_id,
      logId: row.log_id,
      truckId: row.truck_id,
    }));

    const detachedOpenTrips = await readDetachedOpenTrips(client, workspaceId, shiftId);
    const generation = (await client.query(
      'SELECT generation FROM server_authority WHERE workspace_id=$1',
      [workspaceId],
    )).rows[0];
    await client.query('COMMIT');

    const maxRevision = (items, key) => items.reduce((max, item) => Math.max(max, item[key]), 0);
    return {
      protocolVersion: 2,
      workspaceId,
      shiftId,
      shiftRevision: Number(shift.revision),
      shift: {
        workspaceId,
        shiftId,
        objectId: shift.object_id,
        objectName: shift.object_name_snapshot,
        workDate: shift.work_date,
        shiftType: shift.shift_type,
        shiftTypeResolution: shift.shift_type_resolution,
        state: shift.state,
        openedAt: isoOrNull(shift.opened_at),
        openedByUid: shift.opened_by_uid,
        openedByName: shift.opened_by_name_snapshot,
        payloadSchemaVersion: Number(shift.payload_schema_version),
        identityResolution: shift.identity_resolution,
        revision: Number(shift.revision),
        objectLockedAt: isoOrNull(shift.object_locked_at),
        closingStartedAt: isoOrNull(shift.closing_started_at),
        closingByUid: shift.closing_by_uid,
        closedAt: isoOrNull(shift.closed_at),
        closedByUid: shift.closed_by_uid,
        payload: shift.payload,
      },
      members,
      statuses,
      logs,
      detachedOpenTrips,
      revisions: {
        shift: Number(shift.revision),
        members: members.reduce((sum, member) => sum + member.revision, 0),
        statuses: maxRevision(statuses, 'statusRevision'),
        cycles: maxRevision(statuses, 'cycleRevision'),
        ttn: maxRevision(statuses, 'ttnRevision'),
        logs: logs.length,
        detached: maxRevision(detachedOpenTrips, 'cycleRevision'),
      },
      serverGeneration: generation ? Number(generation.generation) : 0,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
