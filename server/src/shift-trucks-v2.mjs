import { v2Error } from './v2-errors.mjs';
import { runV2Command } from './v2-command.mjs';
import { authorizeShift, loadActor } from './shift-access-v2.mjs';

// Truck assignment and removal (design §3.3, §4.3, §6, §7, plan Task 20).
//
// One current status per truck is a database invariant (PK
// `(workspace_id,truck_id)`), so the module never creates a second row: it either
// inserts the first one, answers an honest no-op, or refuses with the other
// shift named in safe details.
//
// Lock order (shared with `shift-transfer-v2.mjs`, §5.2):
//   1. shift row(s) sorted by shift_id — a fixed order, so A→B and B→A can
//      never deadlock;
//   2. the truck status row;
//   3. the detached trip row.
// The truck catalog row itself is not locked explicitly: the FK from
// `line_truck_statuses` to `line_trucks` already takes the `KEY SHARE` lock that
// a concurrent truck delete has to wait for, so an extra `FOR SHARE` would only
// add a second, redundant lock. Every command starts from the shift row, so the
// order is the same for every caller.
//
// The canonical status payload is the v1 line document (`id`, `shiftId`,
// `onLine`, the cycle fields and the normalized revisions). A clean assignment
// starts a fresh cycle at revision 1/1; the trigger in 025 validates it.

const ID = /^[A-Za-z0-9_-]{1,160}$/;

const STATUS_FIELDS = `truck_id,shift_id,status_revision,cycle_revision,ttn_revision,payload`;

export function requireWorkspace(value) {
  const workspaceId = value ?? process.env.WORKSPACE_ID ?? 'main_workspace';
  if (typeof workspaceId !== 'string' || !ID.test(workspaceId)) {
    throw v2Error('invalid-command', 400, { field: 'workspaceId' });
  }
  return workspaceId;
}

export function requireId(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) throw v2Error('invalid-command', 400, { field });
  return value;
}

export function requireOperation(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw v2Error('invalid-command', 400, { field: 'operationId' });
  return value;
}

// A missing or old declaration is a protocol answer, not a schema error.
export function requireProtocol(value) {
  if (value === 2) return 2;
  const declared = Number(value);
  throw v2Error('protocol-upgrade-required', 426, {
    protocolVersion: Number.isSafeInteger(declared) && declared > 0 ? declared : 0,
  });
}

export function requireRevision(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw v2Error('invalid-command', 400, { field });
  return value;
}

// `true` exactly; a truthy string is a client that did not understand the
// confirmation, and a transfer must never run on a guess.
export function requireConfirmation(value) {
  if (value !== true) throw v2Error('force-transfer-confirmation-required', 409);
  return true;
}

// A command that may not be replayed from an offline queue (§9) says so: an
// offline envelope is refused before any mutation.
export function requireOnline(options) {
  if (options?.offlineReplay === true || options?.offline === true) {
    throw v2Error('online-required', 409);
  }
}

export function shiftView(row) {
  return { shiftId: row.shift_id, shiftRevision: Number(row.revision) };
}

export async function lockShift(client, workspaceId, shiftId) {
  return (await client.query(
    `SELECT shift_id,state,revision,object_id,object_name_snapshot,
            to_char(work_date,'YYYY-MM-DD') AS work_date_text,shift_type
       FROM shifts WHERE workspace_id=$1 AND shift_id=$2 FOR UPDATE`,
    [workspaceId, shiftId],
  )).rows[0] ?? null;
}

// Lock several shifts in one fixed order (sorted by id). The destination of a
// force transfer and the source of a completion both end up here, so the order
// is the single source of truth for "both shifts are locked".
export async function lockShifts(client, workspaceId, shiftIds) {
  const ordered = [...new Set(shiftIds)].sort();
  const rows = new Map();
  for (const shiftId of ordered) {
    const row = await lockShift(client, workspaceId, shiftId);
    if (!row) throw v2Error('shift-not-visible', 404, { shiftId });
    rows.set(shiftId, row);
  }
  return rows;
}

export function requireActive(shift) {
  if (shift.state === 'active') return shift;
  throw v2Error(shift.state === 'closing' ? 'shift-closing' : 'shift-closed',
    shift.state === 'closing' ? 409 : 410, { shiftId: shift.shift_id, state: shift.state });
}

// §7: a CAS mismatch on the shift revision of a single-shift command is the
// same `shift-changed` the sibling membership commands answer; a two-shift
// command (force transfer) names `revision-conflict` with the field instead.
export function requireShiftChanged(shift, expected) {
  if (Number(shift.revision) !== expected) {
    throw v2Error('shift-changed', 409, {
      expectedShiftRevision: expected,
      actualShiftRevision: Number(shift.revision),
    });
  }
  return shift;
}

export function requireShiftRevision(shift, expected) {
  if (Number(shift.revision) !== expected) {
    throw v2Error('revision-conflict', 409, {
      shiftId: shift.shift_id,
      expectedShiftRevision: expected,
      actualShiftRevision: Number(shift.revision),
    });
  }
  return shift;
}

export async function lockStatus(client, workspaceId, truckId) {
  return (await client.query(
    `SELECT ${STATUS_FIELDS} FROM line_truck_statuses
      WHERE workspace_id=$1 AND truck_id=$2 FOR UPDATE`,
    [workspaceId, truckId],
  )).rows[0] ?? null;
}

// §3.3/§4.4: the unfinished stage is derived from the locked normalized
// revisions and the canonical payload, never from the UI.
//   * a confirmed arrival is waiting for its load            -> 'load'
//   * a confirmed load is waiting for the ТТН collection     -> 'ttn'
//   * nothing is pending                                     -> null (finished)
export function deriveStage(payload) {
  const source = payload ?? {};
  // «Самосвал больше не приедет» не имеет незавершённого этапа: прибытие снято,
  // а прошлая ходка не ждёт ТТН, пока машина не вернётся на линию.
  if (source.noReturn === true) return null;
  const loaded = Number(source.lastLoadTimestamp || 0) > 0;
  if (loaded) return source.ttnStatus === true ? null : 'ttn';
  const arrived = Number(source.arriveTimestamp || 0) > 0
    || (typeof source.arriveStatus === 'string' && source.arriveStatus.trim() !== '');
  return arrived ? 'load' : null;
}

// A clean assignment carries no stage of the previous cycle (§3.3): the
// destination must not inherit an arrival, a load or a ТТН from the source.
export function cleanStatusPayload(truckId, shiftId) {
  return {
    id: truckId,
    truckId,
    shiftId,
    onLine: true,
    arriveStatus: null,
    arriveTimestamp: null,
    arriveBy: null,
    loadedAfterArrive: false,
    lastLoadTimestamp: null,
    lastLoadBy: null,
    lastLoadLogId: null,
    ttnStatus: null,
    ttnBy: null,
    ttnLogId: null,
    cycleRevision: 1,
    ttnRevision: 1,
  };
}

export function statusView(row) {
  return {
    truckId: row.truck_id ?? row.payload?.id ?? null,
    shiftId: row.shift_id,
    statusRevision: Number(row.status_revision),
    cycleRevision: Number(row.cycle_revision),
    ttnRevision: Number(row.ttn_revision),
    stage: deriveStage(row.payload),
  };
}

// The client is told exactly which counter disagreed, using the same
// `expected*/actual*` names the two-shift commands use.
export function statusConflict(field, expected, actual) {
  return v2Error('revision-conflict', 409, {
    [`expected${field}`]: expected,
    [`actual${field}`]: actual,
  });
}

export async function openDetachedTrip(client, workspaceId, truckId) {
  return (await client.query(
    `SELECT cycle_id,source_shift_id,destination_shift_id,stage,cycle_revision
       FROM detached_open_trips
      WHERE workspace_id=$1 AND truck_id=$2 AND state='open' FOR UPDATE`,
    [workspaceId, truckId],
  )).rows[0] ?? null;
}

async function requireTruck(client, workspaceId, truckId) {
  const row = (await client.query(
    'SELECT payload FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2',
    [workspaceId, truckId],
  )).rows[0];
  // A deleted truck is as unavailable as an unknown one; the client gets a
  // stable schema refusal instead of an FK error.
  if (!row || row.payload?.deleted === true) throw v2Error('invalid-command', 400, { field: 'truckId' });
  return row;
}

function authorizeOnShift(action, workspaceId, shiftId) {
  return async (client, context) => {
    const actor = await loadActor(client, context.uid);
    await authorizeShift(client, actor, { action, workspaceId, shiftId });
    return actor;
  };
}

async function bumpShiftRevision(client, workspaceId, shiftId, expected) {
  const updated = (await client.query(
    `UPDATE shifts SET revision = revision + 1
      WHERE workspace_id=$1 AND shift_id=$2 AND revision=$3
      RETURNING shift_id,revision`,
    [workspaceId, shiftId, expected],
  )).rows[0];
  if (!updated) throw v2Error('revision-conflict', 409, { shiftId, expectedShiftRevision: expected });
  return shiftView(updated);
}

// POST /api/v2/shifts/{shiftId}/trucks — one current assignment per truck.
export async function assignTruck(pool, actor, input) {
  const options = input ?? {};
  const workspaceId = requireWorkspace(options.workspaceId);
  const shiftId = requireId(options.shiftId, 'shiftId');
  const truckId = requireId(options.truckId, 'truckId');
  const operationId = requireOperation(options.operationId);
  const protocolVersion = requireProtocol(options.protocolVersion);
  const expectedShiftRevision = requireRevision(options.expectedShiftRevision, 'expectedShiftRevision');
  const body = { truckId, expectedShiftRevision };

  const mutate = async (client) => {
    const shift = await lockShift(client, workspaceId, shiftId);
    if (!shift) throw v2Error('shift-not-visible', 404, { shiftId });
    requireActive(shift);
    requireShiftChanged(shift, expectedShiftRevision);
    await requireTruck(client, workspaceId, truckId);

    const existing = await lockStatus(client, workspaceId, truckId);
    const onLine = existing?.payload?.onLine === true;
    if (existing && onLine && existing.shift_id === shiftId) {
      // The same assignment repeated is an honest no-op: no second row, no
      // invented revision bump.
      const view = statusView(existing);
      return {
        result: { assignment: view, shift: shiftView(shift) },
        before: { shiftRevision: Number(shift.revision), assignment: view },
        after: { shiftRevision: Number(shift.revision), assignment: view },
      };
    }
    if (existing && onLine) {
      // §3.3: a double assignment is refused with the other shift's safe
      // context — object, date, day/night and the unfinished stage, no people.
      const other = (await client.query(
        `SELECT shift_id,object_id,to_char(work_date,'YYYY-MM-DD') AS work_date_text,shift_type
           FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
        [workspaceId, existing.shift_id],
      )).rows[0];
      const detached = await openDetachedTrip(client, workspaceId, truckId);
      throw v2Error('truck-assigned-to-other-shift', 409, {
        truckId,
        sourceShiftId: existing.shift_id,
        objectId: other?.object_id ?? null,
        workDate: other?.work_date_text ?? null,
        shiftType: other?.shift_type ?? null,
        stage: detached?.stage ?? deriveStage(existing.payload),
      });
    }

    // A row with `onLine:false` is what the v1 `line.remove` leaves behind: it is
    // not a current assignment, because a v2 remove deletes the row. It is
    // revived in place (one row per truck is a database invariant), never
    // duplicated, and only when no detached trip still owns this truck.
    const open = await openDetachedTrip(client, workspaceId, truckId);
    if (open) throw v2Error('truck-detached-trip-open', 409, { truckId, stage: open.stage });

    const payload = cleanStatusPayload(truckId, shiftId);
    const inserted = existing
      ? (await client.query(
        `UPDATE line_truck_statuses
            SET shift_id=$3, payload=$4::jsonb, status_revision=status_revision+1,
                cycle_revision=1, ttn_revision=1
          WHERE workspace_id=$1 AND truck_id=$2
          RETURNING ${STATUS_FIELDS}`,
        [workspaceId, truckId, shiftId, payload],
      )).rows[0]
      : (await client.query(
        `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload,status_revision,cycle_revision,ttn_revision)
         VALUES($1,$2,$3,$4::jsonb,1,1,1)
         RETURNING ${STATUS_FIELDS}`,
        [workspaceId, truckId, shiftId, payload],
      )).rows[0];
    const assignment = statusView(inserted);
    const bumped = await bumpShiftRevision(client, workspaceId, shiftId, expectedShiftRevision);
    return {
      result: { assignment, shift: bumped },
      before: { shiftRevision: expectedShiftRevision, assignment: null },
      after: { shiftRevision: bumped.shiftRevision, assignment },
    };
  };

  return runV2Command({
    pool, uid: actor.uid, workspaceId, shiftId, protocolVersion,
    operation: operationId, type: 'shift.truck.add', body,
    authorize: authorizeOnShift('shift.truck.add', workspaceId, shiftId),
    mutate,
  });
}

// DELETE /api/v2/shifts/{shiftId}/trucks/{truckId} — only a finished cycle and
// only without an open detached trip (§3.3, §7).
export async function removeTruck(pool, actor, input) {
  const options = input ?? {};
  const workspaceId = requireWorkspace(options.workspaceId);
  const shiftId = requireId(options.shiftId, 'shiftId');
  const truckId = requireId(options.truckId, 'truckId');
  const operationId = requireOperation(options.operationId);
  const protocolVersion = requireProtocol(options.protocolVersion);
  const expectedShiftRevision = requireRevision(options.expectedShiftRevision, 'expectedShiftRevision');
  const expectedStatusRevision = requireRevision(options.expectedStatusRevision, 'expectedStatusRevision');
  const expectedCycleRevision = requireRevision(options.expectedCycleRevision, 'expectedCycleRevision');
  const expectedTtnRevision = requireRevision(options.expectedTtnRevision, 'expectedTtnRevision');
  const body = {
    truckId, expectedShiftRevision, expectedStatusRevision, expectedCycleRevision, expectedTtnRevision,
  };

  const mutate = async (client) => {
    const shift = await lockShift(client, workspaceId, shiftId);
    if (!shift) throw v2Error('shift-not-visible', 404, { shiftId });
    requireActive(shift);
    requireShiftChanged(shift, expectedShiftRevision);
    const existing = await lockStatus(client, workspaceId, truckId);
    if (!existing || existing.shift_id !== shiftId) {
      throw v2Error('truck-not-on-shift', 409, { truckId, shiftId });
    }
    // An open detached trip means the truck still belongs to a cross-shift
    // pair; removing it would make the "member of the new line" right ambiguous.
    // The structural refusal is decided before the CAS, so a stale client learns
    // the real reason instead of a counter mismatch (§3.3, §7).
    if (await openDetachedTrip(client, workspaceId, truckId)) {
      throw v2Error('truck-detached-trip-open', 409, { truckId });
    }
    for (const [field, column, expected] of [
      ['StatusRevision', 'status_revision', expectedStatusRevision],
      ['CycleRevision', 'cycle_revision', expectedCycleRevision],
      ['TtnRevision', 'ttn_revision', expectedTtnRevision],
    ]) {
      const actual = Number(existing[column]);
      if (actual !== expected) throw statusConflict(field, expected, actual);
    }
    const stage = deriveStage(existing.payload);
    if (stage !== null) throw v2Error('truck-cycle-incomplete', 409, { truckId, stage });

    await client.query(
      'DELETE FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2 AND shift_id=$3',
      [workspaceId, truckId, shiftId],
    );
    const bumped = await bumpShiftRevision(client, workspaceId, shiftId, expectedShiftRevision);
    return {
      result: { removed: true, truckId, shift: bumped },
      before: {
        shiftRevision: expectedShiftRevision,
        statusRevision: Number(existing.status_revision),
        cycleRevision: Number(existing.cycle_revision),
        ttnRevision: Number(existing.ttn_revision),
      },
      after: { shiftRevision: bumped.shiftRevision, removed: true, truckId },
    };
  };

  return runV2Command({
    pool, uid: actor.uid, workspaceId, shiftId, protocolVersion,
    operation: operationId, type: 'shift.truck.remove', body,
    authorize: authorizeOnShift('shift.truck.remove', workspaceId, shiftId),
    mutate,
  });
}
