import {createHash} from 'node:crypto';
import {v2Error} from './v2-errors.mjs';
import {canonicalJson, runV2Command} from './v2-command.mjs';
import {authorizeShift, loadActor} from './shift-access-v2.mjs';
import {
  lockShift,
  requireId,
  requireOperation,
  requireProtocol,
  requireRevision,
  requireShiftChanged,
  requireShiftRevision,
  requireWorkspace,
  statusConflict,
} from './shift-trucks-v2.mjs';
import {buildShiftArchive} from './shift-archive.mjs';

// Two-phase close and the material marker (design §3.1, §4.5, §4.6, §5.5, §7,
// §11, plan Task 22).
//
// This module is a phase + gate + CAS layer, not a second archive
// implementation:
//   * the archive document itself is the v1 calculation
//     (`shift-archive.mjs` → `buildShiftArchive`), written once by `prepare` as
//     immutable revision 1 and published unchanged by `finish`;
//   * receipts/audit/replay come from `runV2Command`, authorization from
//     `authorizeShift` (re-read on every call), and the shift lock from
//     `lockShift` — the shared order (shift row → status rows → detached row) is
//     never reordered here.
//
// Lifecycle (§3.1, §11): `active → closing → closed`, with three commands that map
// exactly onto it:
//   `prepare`  active  → closing (archive candidate + close token)
//   `material` closing → closing (confirmed material marker, revision +1)
//   `finish`   closing → closed  (publishes the prepared revision, drops statuses)
//
// `historical` is a cutover classification and never enters close; a
// `closed`/`historical` row answers a stable `409 shift-closed` (not the generic
// `410`), because the close domain owns the phase vocabulary. A shift with no
// trips closes with zero totals and no material marker; a shift with trips requires
// a confirmed marker at the expected revision — which only `material` can create,
// so the rule is executable through the API and not only through direct SQL.
//
// Only the current `line_truck_statuses` of the addressed shift are deleted by
// `finish`. Logs/history, the shift row, memberships, receipts, audit, archive and
// marker survive; there is no workspace-wide DELETE.

export const CLOSE_SOURCE_KIND = 'native-close';
export const CLOSE_PAYLOAD_SCHEMA_VERSION = 2;

const TOKEN = /^[A-Za-z0-9_-]{16,160}$/;

function authorizeOnShift(action, workspaceId, shiftId) {
  return async (client, context) => {
    const actor = await loadActor(client, context.uid);
    await authorizeShift(client, actor, {action, workspaceId, shiftId});
    return actor;
  };
}

// `active` accepts prepare; `closing` accepts material and finish (and an
// identical prepare replay, which never reaches this point because the receipt
// answers first). Everything else is a stable close-phase refusal, never a
// synthetic close.
function requireClosePhase(shift, phase) {
  if (phase === 'prepare') {
    if (shift.state === 'active') return;
    if (shift.state === 'closing') throw v2Error('shift-closing', 409, {shiftId: shift.shift_id, state: shift.state});
    throw v2Error('shift-closed', 409, {shiftId: shift.shift_id, state: shift.state});
  }
  // `material` and `finish` both require the prepared phase: material is confirmed
  // only while the shift is closing.
  if (shift.state === 'closing') return;
  if (shift.state === 'active') throw v2Error('shift-changed', 409, {shiftId: shift.shift_id});
  throw v2Error('shift-closed', 409, {shiftId: shift.shift_id, state: shift.state});
}

// §5.5/§7: a committed receipt whose result is still the `{}` placeholder is an
// unconfirmed server operation of this shift. The current operation's own
// pending row is excluded — it is created by `runV2Command` right before mutate.
// Inflight line operations are not listed here: they hold `FOR UPDATE` on the same
// shift row, so `lockShift` already waited for them.
//
// The shift-scoped column arrives with 029; without it no receipt can name a
// shift, so there is nothing to gate on (the close schema itself is missing then).
async function pendingReceipts(client, workspaceId, shiftId, operationId) {
  const scoped = (await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='shift_operation_receipts' AND column_name='shift_id'`,
  )).rowCount > 0;
  if (!scoped) return 0;
  const row = (await client.query(
    `SELECT count(*)::int AS pending FROM shift_operation_receipts
      WHERE workspace_id=$1 AND shift_id=$2 AND result='{}'::jsonb AND operation_id <> $3`,
    [workspaceId, shiftId, operationId],
  )).rows[0];
  return Number(row?.pending ?? 0);
}

async function openDetachedTripForShift(client, workspaceId, shiftId) {
  const present = (await client.query(
    "SELECT to_regclass('public.detached_open_trips') IS NOT NULL AS present",
  )).rows[0]?.present === true;
  if (!present) return null;
  return (await client.query(
    `SELECT source_shift_id,destination_shift_id FROM detached_open_trips
      WHERE workspace_id=$1 AND state='open'
        AND (source_shift_id=$2 OR destination_shift_id=$2)
      ORDER BY source_shift_id COLLATE "C", cycle_id COLLATE "C"
      LIMIT 1`,
    [workspaceId, shiftId],
  )).rows[0] ?? null;
}

// Both gates are structural: they are decided before any CAS counter is read, so
// a stale client learns the real reason (§7).
async function requireNoBlockingWork(client, workspaceId, shiftId, operationId) {
  if (await pendingReceipts(client, workspaceId, shiftId, operationId)) {
    throw v2Error('pending-operations', 409, {shiftId});
  }
  const detached = await openDetachedTripForShift(client, workspaceId, shiftId);
  if (detached) {
    throw v2Error('detached-trip-open', 409, {
      shiftId,
      sourceShiftId: detached.source_shift_id,
      destinationShiftId: detached.destination_shift_id,
    });
  }
}

// The v1 line document is the archive source, in the same deterministic order the
// archive already uses (byte order, not locale order).
async function loadLineSource(client, workspaceId, shiftId) {
  const logs = (await client.query(
    `SELECT log_id,payload FROM line_logs
      WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id COLLATE "C"`,
    [workspaceId, shiftId],
  )).rows.map(row => ({...row.payload, id: row.log_id}));
  const statuses = Object.fromEntries((await client.query(
    `SELECT truck_id,payload FROM line_truck_statuses
      WHERE workspace_id=$1 AND shift_id=$2 ORDER BY truck_id COLLATE "C"`,
    [workspaceId, shiftId],
  )).rows.map(row => [row.truck_id, row.payload]));
  return {logs, statuses};
}

// `buildShiftArchive` answers null for a shift without trips. An empty shift still
// needs a real archive document (§5.5: zero totals), so the same field set is
// built with empty lists — the shape never depends on the presence of trips.
function emptyArchiveDocument(shift, statuses, closedAt) {
  const activeLineIds = [];
  const ttnStatus = {};
  for (const [truckId, status] of Object.entries(statuses)) {
    if (status?.onLine) activeLineIds.push(truckId);
    if (status?.ttnStatus !== undefined && status?.ttnStatus !== null) ttnStatus[truckId] = status.ttnStatus;
  }
  return {
    sourceShiftId: shift.id,
    objectName: shift.objectName || '',
    objectId: shift.objectId || '',
    date: shift.startDate || '',
    closedAt,
    closedBy: shift.closingBy,
    logs: [],
    activeLineIds,
    ttnStatus,
    totalVolume: 0,
    totalTrips: 0,
  };
}

async function buildCloseArchive(client, workspaceId, shiftId, closingPayload) {
  const closedAt = Number(closingPayload.closingStartedAt);
  const {logs, statuses} = await loadLineSource(client, workspaceId, shiftId);
  let archive;
  try {
    archive = buildShiftArchive(closingPayload, logs, statuses, closedAt);
  } catch (error) {
    // The v1 calculator refuses foreign/invalid trip data (`fail()` carries the
    // code). Inside the close that is a source which no longer matches, not an
    // internal failure; anything else is a real bug and is rethrown unchanged.
    if (!error?.code) throw error;
    throw v2Error('archive-changed', 409, {shiftId});
  }
  if (!archive) archive = emptyArchiveDocument(closingPayload, statuses, closedAt);
  const bytes = Buffer.from(canonicalJson(archive), 'utf8');
  return {archive, bytes, sha256: createHash('sha256').update(bytes).digest('hex')};
}

async function loadCloseRow(client, workspaceId, shiftId) {
  return (await client.query(
    `SELECT payload,close_token,close_token_operation_id
       FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
    [workspaceId, shiftId],
  )).rows[0] ?? null;
}

function requireMarkerRevision(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw v2Error('invalid-command', 400, {field: 'expectedMaterialMarkerRevision'});
  }
  return value;
}

function requireCloseToken(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw v2Error('invalid-command', 400, {field: 'closeToken'});
  }
  return value;
}

// The marker columns are `material_id text CHECK (length BETWEEN 1 AND 160)` and
// `volume numeric CHECK (volume >= 0)`. The id format is the column's, not a new
// vocabulary: any non-empty text up to 160 characters is a legal material.
function requireMaterialId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160) {
    throw v2Error('invalid-command', 400, {field: 'materialId'});
  }
  return value;
}

function requireVolume(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw v2Error('invalid-command', 400, {field: 'volume'});
  }
  return value;
}

// The token names exactly (shiftId, next shift revision, archive candidate hash):
// a different prepare can never produce the same token, and a token from another
// shift/revision/hash cannot finish this one.
function closeTokenFor(shiftId, shiftRevision, archiveSha256, operationId) {
  return createHash('sha256')
    .update(`${shiftId}:${shiftRevision}:${archiveSha256}:${operationId}`)
    .digest('hex');
}

// POST /api/v2/shifts/{shiftId}/close/prepare
//
// `active → closing` only. The shift revision is bumped exactly once, the archive
// candidate is written as immutable revision 1 (not yet published), and the token
// is stored on the row. The archive is built from the actual rows under the shift
// lock, so a concurrent line operation either lands before (and is archived) or
// waits for the close.
export async function prepareShiftClose(pool, actor, input) {
  const options = input ?? {};
  const workspaceId = requireWorkspace(options.workspaceId);
  const shiftId = requireId(options.shiftId, 'shiftId');
  const operationId = requireOperation(options.operationId);
  const protocolVersion = requireProtocol(options.protocolVersion);
  const expectedShiftRevision = requireRevision(options.expectedShiftRevision, 'expectedShiftRevision');
  const body = {expectedShiftRevision};

  const mutate = async (client, context) => {
    const shift = await lockShift(client, workspaceId, shiftId);
    if (!shift) throw v2Error('shift-not-visible', 404, {shiftId});
    requireClosePhase(shift, 'prepare');
    await requireNoBlockingWork(client, workspaceId, shiftId, operationId);
    requireShiftChanged(shift, expectedShiftRevision);

    const row = await loadCloseRow(client, workspaceId, shiftId);
    const archiveId = `closed_${shiftId}`;
    const closingStartedAt = Date.now();
    const closingPayload = {
      ...row.payload,
      state: 'closing',
      isActive: true,
      closing: true,
      closingStartedAt,
      closingBy: context.actor.displayName,
      closingByUid: context.actor.uid,
      closeArchiveId: archiveId,
    };
    const {bytes, sha256} = await buildCloseArchive(client, workspaceId, shiftId, closingPayload);

    // One canonical series per business shift (025 UNIQUE workspace+source_shift).
    const series = (await client.query(
      `INSERT INTO shift_archive_series(workspace_id,archive_id,source_shift_id)
       VALUES($1,$2,$3) ON CONFLICT (workspace_id,archive_id) DO NOTHING
       RETURNING archive_id`,
      [workspaceId, archiveId, shiftId],
    )).rows[0];
    if (!series) throw v2Error('archive-changed', 409, {shiftId});
    await client.query(
      `INSERT INTO shift_archive_revisions(
         workspace_id,archive_id,archive_revision,previous_revision,previous_sha256,
         payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_by_uid)
       VALUES($1,$2,1,NULL,NULL,$3,$4,$5,$6,$7,$8)`,
      [workspaceId, archiveId, bytes, sha256, CLOSE_PAYLOAD_SCHEMA_VERSION, CLOSE_SOURCE_KIND,
        `close:${archiveId}:1`, context.actor.uid],
    );

    const shiftRevision = expectedShiftRevision + 1;
    const closeToken = closeTokenFor(shiftId, shiftRevision, sha256, operationId);
    const updated = (await client.query(
      `UPDATE shifts
          SET payload=$3::jsonb,revision=revision+1,close_token=$4,close_token_operation_id=$5
        WHERE workspace_id=$1 AND shift_id=$2 AND revision=$6
        RETURNING revision`,
      [workspaceId, shiftId, closingPayload, closeToken, operationId, expectedShiftRevision],
    )).rows[0];
    if (!updated) {
      throw v2Error('revision-conflict', 409, {shiftId, expectedShiftRevision});
    }

    await client.query(
      `INSERT INTO archive_audit(workspace_id,archive_id,source_shift_id,before_state,after_state,actor_uid)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [workspaceId, archiveId, shiftId,
        JSON.stringify({state: shift.state, shiftRevision: expectedShiftRevision, archiveRevision: null}),
        JSON.stringify({state: 'closing', shiftRevision, archiveRevision: 1, archiveSha256: sha256}),
        context.actor.uid],
    );

    return {
      result: {
        phase: 'prepared',
        closeToken,
        shiftRevision,
        archiveId,
        archiveRevision: 1,
        materialMarkerRevision: null,
      },
      before: {state: shift.state, shiftRevision: expectedShiftRevision, archiveRevision: null},
      after: {state: 'closing', shiftRevision, archiveRevision: 1, archiveSha256: sha256},
    };
  };

  return runV2Command({
    pool, uid: actor?.uid, workspaceId, shiftId, protocolVersion,
    operation: operationId, type: 'shift.close.prepare', body,
    authorize: authorizeOnShift('shift.close.prepare', workspaceId, shiftId),
    mutate,
  });
}

// POST /api/v2/shifts/{shiftId}/close/material
//
// The only command that creates a material marker, and therefore the only path by
// which a shift with trips can be closed (§4.6, §7 row `material confirm`).
//
// Phase: `closing` only. The marker is bound to (shift, close token, archive
// revision) and to the candidate that is still unpublished: after `finish` the
// material follows the finalized archive revision through the archive workflow, not
// through this phase.
//
// Revision contract: `expectedMaterialMarkerRevision: null` means "there must be no
// marker yet" and inserts revision 1; a number means "the marker is at exactly that
// revision" and updates it to `revision + 1`. One row per shift (PK), so a second
// confirmation can never become a second transfer.
//
// Volume: a confirmed import can never exceed what the archive proves was hauled
// (`400 invalid-command {field:'volume'}`); `finish` still requires the marker to
// match the published total exactly, so a shortfall is corrected here before the
// close, never silently accepted by it.
export async function confirmShiftMaterial(pool, actor, input) {
  const options = input ?? {};
  const workspaceId = requireWorkspace(options.workspaceId);
  const shiftId = requireId(options.shiftId, 'shiftId');
  const operationId = requireOperation(options.operationId);
  const protocolVersion = requireProtocol(options.protocolVersion);
  const closeToken = requireCloseToken(options.closeToken);
  const materialId = requireMaterialId(options.materialId);
  const volume = requireVolume(options.volume);
  const expectedShiftRevision = requireRevision(options.expectedShiftRevision, 'expectedShiftRevision');
  const expectedArchiveRevision = requireRevision(options.expectedArchiveRevision, 'expectedArchiveRevision');
  const expectedMaterialMarkerRevision = requireMarkerRevision(options.expectedMaterialMarkerRevision);
  const body = {
    closeToken,
    materialId,
    volume,
    expectedShiftRevision,
    expectedArchiveRevision,
    expectedMaterialMarkerRevision,
  };

  const mutate = async (client, context) => {
    const shift = await lockShift(client, workspaceId, shiftId);
    if (!shift) throw v2Error('shift-not-visible', 404, {shiftId});
    requireClosePhase(shift, 'material');
    const row = await loadCloseRow(client, workspaceId, shiftId);
    if (!row?.close_token || row.close_token !== closeToken) {
      throw v2Error('revision-conflict', 409, {field: 'closeToken'});
    }
    requireShiftRevision(shift, expectedShiftRevision);

    const archiveId = `closed_${shiftId}`;
    const series = (await client.query(
      `SELECT latest_finalized_revision FROM shift_archive_series
        WHERE workspace_id=$1 AND archive_id=$2 FOR UPDATE`,
      [workspaceId, archiveId],
    )).rows[0];
    if (!series) throw v2Error('archive-changed', 409, {shiftId});
    const revisionRow = (await client.query(
      `SELECT archive_revision,payload_bytes FROM shift_archive_revisions
        WHERE workspace_id=$1 AND archive_id=$2
        ORDER BY archive_revision DESC LIMIT 1`,
      [workspaceId, archiveId],
    )).rows[0];
    if (!revisionRow) throw v2Error('archive-changed', 409, {shiftId});
    const archiveRevision = Number(revisionRow.archive_revision);
    if (archiveRevision !== expectedArchiveRevision) {
      throw statusConflict('ArchiveRevision', expectedArchiveRevision, archiveRevision);
    }
    // A marker is confirmed against the prepared candidate only. Once the revision
    // is published the material is reconciled by the archive workflow (§4.6), so
    // this phase refuses instead of writing a marker for a finalized archive.
    if (series.latest_finalized_revision !== null) {
      throw v2Error('archive-changed', 409, {shiftId});
    }
    const candidateBytes = Buffer.isBuffer(revisionRow.payload_bytes)
      ? revisionRow.payload_bytes
      : Buffer.from(revisionRow.payload_bytes);
    let candidateTotal;
    try {
      candidateTotal = Number(JSON.parse(candidateBytes.toString('utf8')).totalVolume ?? 0);
    } catch {
      throw v2Error('archive-changed', 409, {shiftId});
    }

    const marker = (await client.query(
      `SELECT revision FROM shift_material_markers
        WHERE workspace_id=$1 AND shift_id=$2 FOR UPDATE`,
      [workspaceId, shiftId],
    )).rows[0] ?? null;
    const markerRevision = marker ? Number(marker.revision) : null;
    if (markerRevision !== expectedMaterialMarkerRevision) {
      throw statusConflict('MaterialMarkerRevision', expectedMaterialMarkerRevision, markerRevision);
    }
    if (!Number.isFinite(candidateTotal) || volume > candidateTotal) {
      throw v2Error('invalid-command', 400, {field: 'volume'});
    }

    const nextRevision = markerRevision === null ? 1 : markerRevision + 1;
    if (markerRevision === null) {
      await client.query(
        `INSERT INTO shift_material_markers(
           workspace_id,shift_id,material_id,source_archive_revision,volume,revision,
           confirmed_at,confirmed_by_uid)
         VALUES($1,$2,$3,$4,$5,1,now(),$6)`,
        [workspaceId, shiftId, materialId, archiveRevision, volume, context.actor.uid],
      );
    } else {
      // The row is locked FOR UPDATE above, so this CAS cannot lose a race: a
      // concurrent confirmation is serialized behind the same lock. The row count
      // is still checked so a silently lost update can never be reported as success.
      const updated = await client.query(
        `UPDATE shift_material_markers
            SET material_id=$3,source_archive_revision=$4,volume=$5,revision=revision+1,
                confirmed_at=now(),confirmed_by_uid=$6
          WHERE workspace_id=$1 AND shift_id=$2 AND revision=$7`,
        [workspaceId, shiftId, materialId, archiveRevision, volume, context.actor.uid, markerRevision],
      );
      if (updated.rowCount !== 1) {
        // Unreachable behind FOR UPDATE; if it ever happens the client is told the
        // marker moved instead of receiving a success that was not written.
        throw v2Error('revision-conflict', 409, {expectedMaterialMarkerRevision: markerRevision});
      }
    }

    // No `archive_audit` row: the archive itself did not change. The marker carries
    // its own provenance (`confirmed_at`/`confirmed_by_uid`) and `runV2Command`
    // records the command in `workspace_service_audit`.
    return {
      result: {
        phase: 'material-confirmed',
        materialId,
        volume,
        archiveId,
        archiveRevision,
        materialMarkerRevision: nextRevision,
        shiftRevision: Number(shift.revision),
      },
      before: {
        state: 'closing',
        shiftRevision: expectedShiftRevision,
        archiveRevision,
        materialMarkerRevision: markerRevision,
      },
      after: {
        state: 'closing',
        shiftRevision: expectedShiftRevision,
        archiveRevision,
        materialMarkerRevision: nextRevision,
        materialId,
        volume,
      },
    };
  };

  return runV2Command({
    pool, uid: actor?.uid, workspaceId, shiftId, protocolVersion,
    operation: operationId, type: 'shift.close.material', body,
    authorize: authorizeOnShift('shift.close.material', workspaceId, shiftId),
    mutate,
  });
}

// POST /api/v2/shifts/{shiftId}/close/finish
//
// Publishes exactly the revision prepared earlier (no rewrite), requires the
// exact token and all three revisions, deletes only this shift's current statuses
// and moves the shift to `closed`.
export async function finishShiftClose(pool, actor, input) {
  const options = input ?? {};
  const workspaceId = requireWorkspace(options.workspaceId);
  const shiftId = requireId(options.shiftId, 'shiftId');
  const operationId = requireOperation(options.operationId);
  const protocolVersion = requireProtocol(options.protocolVersion);
  const closeToken = requireCloseToken(options.closeToken);
  const expectedShiftRevision = requireRevision(options.expectedShiftRevision, 'expectedShiftRevision');
  const expectedArchiveRevision = requireRevision(options.expectedArchiveRevision, 'expectedArchiveRevision');
  const expectedMaterialMarkerRevision = requireMarkerRevision(options.expectedMaterialMarkerRevision);
  const body = {
    closeToken, expectedShiftRevision, expectedArchiveRevision, expectedMaterialMarkerRevision,
  };

  const mutate = async (client, context) => {
    const shift = await lockShift(client, workspaceId, shiftId);
    if (!shift) throw v2Error('shift-not-visible', 404, {shiftId});
    requireClosePhase(shift, 'finish');
    const row = await loadCloseRow(client, workspaceId, shiftId);
    if (!row?.close_token || row.close_token !== closeToken) {
      throw v2Error('revision-conflict', 409, {field: 'closeToken'});
    }
    await requireNoBlockingWork(client, workspaceId, shiftId, operationId);
    requireShiftRevision(shift, expectedShiftRevision);

    const archiveId = `closed_${shiftId}`;
    const series = (await client.query(
      `SELECT source_shift_id,latest_finalized_revision,latest_finalized_sha256
         FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2 FOR UPDATE`,
      [workspaceId, archiveId],
    )).rows[0];
    if (!series) throw v2Error('archive-changed', 409, {shiftId});
    const revisionRow = (await client.query(
      `SELECT archive_revision,payload_bytes,payload_sha256
         FROM shift_archive_revisions
        WHERE workspace_id=$1 AND archive_id=$2
        ORDER BY archive_revision DESC LIMIT 1`,
      [workspaceId, archiveId],
    )).rows[0];
    if (!revisionRow) throw v2Error('archive-changed', 409, {shiftId});
    const archiveRevision = Number(revisionRow.archive_revision);
    if (archiveRevision !== expectedArchiveRevision) {
      throw statusConflict('ArchiveRevision', expectedArchiveRevision, archiveRevision);
    }
    if (series.latest_finalized_revision !== null) {
      throw v2Error('archive-changed', 409, {shiftId});
    }

    const publishedBytes = Buffer.isBuffer(revisionRow.payload_bytes)
      ? revisionRow.payload_bytes
      : Buffer.from(revisionRow.payload_bytes);
    const publishedSha256 = revisionRow.payload_sha256;
    let publishedPayload;
    try {
      publishedPayload = JSON.parse(publishedBytes.toString('utf8'));
    } catch {
      throw v2Error('archive-changed', 409, {shiftId});
    }
    // The archive must still be the source, byte for byte: a line change after
    // prepare is not silently published as if it had been archived.
    const rebuilt = await buildCloseArchive(client, workspaceId, shiftId, row.payload);
    if (rebuilt.bytes.compare(publishedBytes) !== 0 || rebuilt.sha256 !== publishedSha256) {
      throw v2Error('archive-changed', 409, {shiftId});
    }

    const marker = (await client.query(
      `SELECT material_id,source_archive_revision,volume,revision
         FROM shift_material_markers WHERE workspace_id=$1 AND shift_id=$2`,
      [workspaceId, shiftId],
    )).rows[0] ?? null;
    const markerRevision = marker ? Number(marker.revision) : null;
    if (markerRevision !== expectedMaterialMarkerRevision) {
      throw statusConflict('MaterialMarkerRevision', expectedMaterialMarkerRevision, markerRevision);
    }
    const totalTrips = Number(publishedPayload.totalTrips ?? 0);
    if (totalTrips > 0 && !marker) {
      // A shift with trips always needs a confirmed material marker; a client that
      // expected none is told which revision is missing.
      throw statusConflict('MaterialMarkerRevision', expectedMaterialMarkerRevision ?? 1, null);
    }
    if (marker && (Number(marker.source_archive_revision) !== archiveRevision
      || Number(marker.volume) !== Number(publishedPayload.totalVolume))) {
      throw v2Error('archive-changed', 409, {shiftId});
    }

    const shiftRevision = expectedShiftRevision + 1;
    await client.query(
      `INSERT INTO archive_audit(workspace_id,archive_id,source_shift_id,before_state,after_state,actor_uid)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [workspaceId, archiveId, shiftId,
        JSON.stringify({state: 'closing', shiftRevision: expectedShiftRevision,
          archiveRevision, latestFinalizedRevision: null}),
        JSON.stringify({state: 'closed', shiftRevision, archiveRevision, archiveSha256: publishedSha256}),
        context.actor.uid],
    );
    const moved = (await client.query(
      `UPDATE shift_archive_series
          SET latest_finalized_revision=$3,latest_finalized_sha256=$4,series_revision=series_revision+1
        WHERE workspace_id=$1 AND archive_id=$2 AND latest_finalized_revision IS NULL`,
      [workspaceId, archiveId, archiveRevision, publishedSha256],
    ));
    if (!moved.rowCount) throw v2Error('archive-changed', 409, {shiftId});

    // §5.5: only the current statuses of this shift are removed. Logs/history,
    // the shift row, memberships, receipts, audit, archive and marker survive.
    await client.query(
      'DELETE FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2',
      [workspaceId, shiftId],
    );

    const closedAt = Date.now();
    const closedPayload = {
      ...row.payload,
      state: 'closed',
      isActive: false,
      closedAt,
      closedBy: context.actor.displayName,
      closedByUid: context.actor.uid,
      closeArchiveId: archiveId,
    };
    delete closedPayload.closing;
    const updated = (await client.query(
      `UPDATE shifts SET payload=$3::jsonb,revision=revision+1
        WHERE workspace_id=$1 AND shift_id=$2 AND revision=$4
        RETURNING revision`,
      [workspaceId, shiftId, closedPayload, expectedShiftRevision],
    )).rows[0];
    if (!updated) {
      throw v2Error('revision-conflict', 409, {shiftId, expectedShiftRevision});
    }

    return {
      result: {
        phase: 'closed',
        shiftRevision,
        archiveId,
        archiveRevision,
        archiveSha256: publishedSha256,
        materialMarkerRevision: markerRevision,
      },
      before: {state: 'closing', shiftRevision: expectedShiftRevision, archiveRevision},
      after: {state: 'closed', shiftRevision, archiveRevision, archiveSha256: publishedSha256},
    };
  };

  return runV2Command({
    pool, uid: actor?.uid, workspaceId, shiftId, protocolVersion,
    operation: operationId, type: 'shift.close.finish', body,
    authorize: authorizeOnShift('shift.close.finish', workspaceId, shiftId),
    mutate,
  });
}
