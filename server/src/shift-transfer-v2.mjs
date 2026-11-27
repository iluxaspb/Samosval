import { createHash } from 'node:crypto';
import { v2Error } from './v2-errors.mjs';
import { runV2Command } from './v2-command.mjs';
import { authorizeShift, loadActor } from './shift-access-v2.mjs';
import { timeStr } from './line-rules.mjs';
import {
  cleanStatusPayload,
  deriveStage,
  lockShifts,
  lockStatus,
  openDetachedTrip,
  requireActive,
  requireConfirmation,
  requireId,
  requireOnline,
  requireOperation,
  requireProtocol,
  requireRevision,
  requireShiftRevision,
  requireWorkspace,
  shiftView,
  statusView,
} from './shift-trucks-v2.mjs';

// Force transfer and detached completion (design §3.3, §4.4, §5.4, §6, §7,
// plan Task 20).
//
// A force transfer is the only way a truck crosses the day/night boundary while
// it is already assigned. It is one transaction over both shifts, the current
// status and (when the cycle is unfinished) one detached trip:
//
//   * a finished cycle is moved as is — no detached row is created;
//   * an unfinished cycle keeps its exact stage, revisions and payload in
//     `detached_open_trips`, and the destination gets a clean assignment;
//   * both shift revisions move by exactly one; nothing else changes.
//
// The detached trip stays addressed `(source_shift_id, cycle_id)` forever. The
// completing command writes the trip, its effects and the receipt into the
// SOURCE shift and never starts or edits a cycle in the destination.
//
// Lock order is the one in `shift-trucks-v2.mjs`: shifts sorted by id, then the
// status row, then the detached row. The truck is locked through its status row,
// which is the same row every other line command locks, so two concurrent
// transfers serialize instead of deadlocking.
//
// Both commands are online-only (§9): an offline envelope is refused before any
// mutation, because a lost receipt must become a safe replay, never a second
// transfer.

const STAGES = Object.freeze(['load', 'ttn']);
const MAX_ID = 160;

function requireStage(value) {
  if (!STAGES.includes(value)) throw v2Error('invalid-command', 400, { field: 'type' });
  return value;
}

function requireTimestamp(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw v2Error('invalid-command', 400, { field });
  return value;
}

function requireOptionalBoolean(value, field) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw v2Error('invalid-command', 400, { field });
  return value;
}

// The cycle id is deterministic for one transfer command: a retried transfer
// with the same operationId recomputes the same id, and two different
// operations can never collide even when the source cycle looks identical
// (a completed trip is never deleted, so its key is spent forever).
function detachedCycleId({ sourceShiftId, truckId, cycleRevision, anchor, operationId }) {
  const digest = createHash('sha256').update(operationId, 'utf8').digest('hex').slice(0, 12);
  const readable = `cycle_${sourceShiftId}_${truckId}_${cycleRevision}_${anchor}_${digest}`;
  if (readable.length <= MAX_ID && /^[A-Za-z0-9_-]+$/.test(readable)) return readable;
  return `cycle_${createHash('sha256')
    .update(`${sourceShiftId}|${truckId}|${cycleRevision}|${anchor}|${operationId}`, 'utf8')
    .digest('hex').slice(0, 40)}`;
}

function detachedView(row) {
  return {
    cycleId: row.cycle_id,
    state: row.state,
    stage: row.stage,
    cycleRevision: Number(row.cycle_revision),
    sourceStatusRevision: Number(row.source_status_revision),
    sourceCycleRevision: Number(row.source_cycle_revision),
    sourceTtnRevision: Number(row.source_ttn_revision),
    sourceShiftId: row.source_shift_id,
    destinationShiftId: row.destination_shift_id,
    truckId: row.truck_id,
  };
}

// The path shift is the destination. A body that names a different destination
// is a different command, not a rename of this one (§5.4).
function transferShiftId(options) {
  const destinationShiftId = requireId(options.destinationShiftId, 'destinationShiftId');
  if (options.shiftId !== undefined && options.shiftId !== destinationShiftId) {
    throw v2Error('transfer-context-changed', 409, { destinationShiftId });
  }
  return destinationShiftId;
}

// POST /api/v2/shifts/{destinationShiftId}/trucks/{truckId}/force-transfer
export async function forceTransferTruck(pool, actor, input) {
  const options = input ?? {};
  requireOnline(options);
  const workspaceId = requireWorkspace(options.workspaceId);
  const destinationShiftId = transferShiftId(options);
  const sourceShiftId = requireId(options.sourceShiftId, 'sourceShiftId');
  if (sourceShiftId === destinationShiftId) {
    throw v2Error('invalid-command', 400, { field: 'sourceShiftId' });
  }
  const truckId = requireId(options.truckId, 'truckId');
  const operationId = requireOperation(options.operationId);
  const protocolVersion = requireProtocol(options.protocolVersion);
  const expectedSourceShiftRevision = requireRevision(options.expectedSourceShiftRevision, 'expectedSourceShiftRevision');
  const expectedDestinationShiftRevision = requireRevision(options.expectedDestinationShiftRevision, 'expectedDestinationShiftRevision');
  const expectedStatusRevision = requireRevision(options.expectedStatusRevision, 'expectedStatusRevision');
  const expectedCycleRevision = requireRevision(options.expectedCycleRevision, 'expectedCycleRevision');
  const expectedTtnRevision = requireRevision(options.expectedTtnRevision, 'expectedTtnRevision');
  requireConfirmation(options.confirmTransfer);
  const body = {
    truckId,
    sourceShiftId,
    destinationShiftId,
    expectedSourceShiftRevision,
    expectedDestinationShiftRevision,
    expectedStatusRevision,
    expectedCycleRevision,
    expectedTtnRevision,
    confirmTransfer: true,
  };

  const mutate = async (client, context) => {
    // 1. Both shifts, always in the same order.
    const shifts = await lockShifts(client, workspaceId, [sourceShiftId, destinationShiftId]);
    const source = requireActive(shifts.get(sourceShiftId));
    const destination = requireActive(shifts.get(destinationShiftId));
    requireShiftRevision(source, expectedSourceShiftRevision);
    requireShiftRevision(destination, expectedDestinationShiftRevision);

    // 2. The truck: exactly one current status, and it must belong to the source.
    const status = await lockStatus(client, workspaceId, truckId);
    if (!status || status.shift_id !== sourceShiftId) {
      throw v2Error('truck-not-on-shift', 409, { truckId, shiftId: sourceShiftId });
    }

    // 3. An open detached trip is a structural invariant, not a counter: the
    //    truck already carries an unfinished cycle of another line, so a second
    //    transfer is refused by §3.3 before the CAS is even consulted. The
    //    refusal is the same whether the client is fresh or stale, and the row
    //    is locked in the documented order (status, then detached trip).
    const open = await openDetachedTrip(client, workspaceId, truckId);
    if (open) throw v2Error('truck-detached-trip-open', 409, { truckId, stage: open.stage });

    // 4. Optimistic concurrency on the current status: all three normalized
    //    revisions are named by the client and must still hold.
    if (Number(status.status_revision) !== expectedStatusRevision) {
      throw v2Error('revision-conflict', 409, {
        expectedStatusRevision, actualStatusRevision: Number(status.status_revision),
      });
    }
    if (Number(status.cycle_revision) !== expectedCycleRevision) {
      throw v2Error('revision-conflict', 409, {
        expectedCycleRevision, actualCycleRevision: Number(status.cycle_revision),
      });
    }
    if (Number(status.ttn_revision) !== expectedTtnRevision) {
      throw v2Error('revision-conflict', 409, {
        expectedTtnRevision, actualTtnRevision: Number(status.ttn_revision),
      });
    }

    const stage = deriveStage(status.payload);
    const cleanPayload = cleanStatusPayload(truckId, destinationShiftId);
    const moved = (await client.query(
      `UPDATE line_truck_statuses
          SET shift_id=$3, payload=$4::jsonb, status_revision=status_revision+1,
              cycle_revision=1, ttn_revision=1
        WHERE workspace_id=$1 AND truck_id=$2 AND shift_id=$5
        RETURNING truck_id,shift_id,status_revision,cycle_revision,ttn_revision,payload`,
      [workspaceId, truckId, destinationShiftId, cleanPayload, sourceShiftId],
    )).rows[0];

    // 5. The unfinished cycle is detached after the move: the database requires
    //    an open trip to sit next to a status that already belongs to the
    //    destination, so the order is fixed by the guard, not by taste.
    let detachedTrip = null;
    if (stage !== null) {
      const sourceCycleRevision = Number(status.cycle_revision);
      const anchor = Number(status.payload?.lastLoadTimestamp || 0)
        || Number(status.payload?.arriveTimestamp || 0) || 0;
      const cycleId = detachedCycleId({
        sourceShiftId, truckId, cycleRevision: sourceCycleRevision, anchor, operationId,
      });
      const inserted = (await client.query(
        `INSERT INTO detached_open_trips(
           workspace_id,source_shift_id,cycle_id,truck_id,destination_shift_id,state,stage,
           cycle_revision,source_status_revision,source_cycle_revision,source_ttn_revision,
           payload,detached_at,detached_by_uid,transfer_operation_id)
         VALUES($1,$2,$3,$4,$5,'open',$6,1,$7,$8,$9,$10::jsonb,now(),$11,$12)
         RETURNING *`,
        [
          workspaceId, sourceShiftId, cycleId, truckId, destinationShiftId, stage,
          Number(status.status_revision), sourceCycleRevision, Number(status.ttn_revision),
          status.payload, context.uid, operationId,
        ],
      )).rows[0];
      detachedTrip = detachedView(inserted);
    }

    // 6. Both revisions move by exactly one.
    const sourceAfter = (await client.query(
      `UPDATE shifts SET revision=revision+1 WHERE workspace_id=$1 AND shift_id=$2
        RETURNING shift_id,revision`,
      [workspaceId, sourceShiftId],
    )).rows[0];
    const destinationAfter = (await client.query(
      `UPDATE shifts SET revision=revision+1 WHERE workspace_id=$1 AND shift_id=$2
        RETURNING shift_id,revision`,
      [workspaceId, destinationShiftId],
    )).rows[0];

    return {
      result: {
        truckId,
        sourceShiftId,
        destinationShiftId,
        detachedTrip,
        assignment: statusView(moved),
        sourceShift: shiftView(sourceAfter),
        destinationShift: shiftView(destinationAfter),
      },
      before: {
        shiftRevision: Number(source.revision),
        destinationShiftRevision: Number(destination.revision),
        statusRevision: Number(status.status_revision),
        cycleRevision: Number(status.cycle_revision),
        ttnRevision: Number(status.ttn_revision),
        stage,
        truckId,
        sourceShiftId,
        destinationShiftId,
      },
      after: {
        shiftRevision: Number(sourceAfter.revision),
        destinationShiftRevision: Number(destinationAfter.revision),
        statusRevision: Number(moved.status_revision),
        cycleRevision: Number(moved.cycle_revision),
        ttnRevision: Number(moved.ttn_revision),
        stage,
        detachedCycleId: detachedTrip?.cycleId ?? null,
        truckId,
        sourceShiftId,
        destinationShiftId,
      },
    };
  };

  return runV2Command({
    pool, uid: actor.uid, workspaceId, shiftId: destinationShiftId, protocolVersion,
    operation: operationId, type: 'shift.truck.force-transfer', body,
    authorize: async (client, context) => {
      const profile = await loadActor(client, context.uid);
      await authorizeShift(client, profile, {
        action: 'shift.truck.force-transfer', workspaceId,
        shiftId: destinationShiftId, sourceShiftId,
      });
      return profile;
    },
    mutate,
  });
}

// The trip document a completed load writes into the source shift. It is the
// canonical line log shape (`line-rules.mjs`), built from the truck catalog row
// and the detached snapshot — no field is invented on the client's word.
function loadLog({ truckId, shiftId, cycleRevision, arrivalTimestamp, createdAt, actor, truck }) {
  const timestamp = Math.max(
    Number(createdAt),
    Number(arrivalTimestamp || 0) + 1,
  );
  return {
    id: `load_${truckId}_${shiftId}_cycle_${cycleRevision}_${Number(arrivalTimestamp || 0)}`,
    shiftId,
    truckId,
    truckName: `${String(truck.brand || '')} ${String(truck.number || '')}`.trim(),
    volume: truck.isGAI ? 0 : Number(truck.defaultVol || 0),
    timeStr: timeStr(timestamp),
    timestamp,
    arrivalTimestamp: Number(arrivalTimestamp || 0) || null,
    createdBy: actor.displayName,
    createdByEmail: actor.email ?? '',
    isGAI: truck.isGAI === true,
    comment: '',
    clientOperationId: `detached_${truckId}_${cycleRevision}`,
  };
}

// POST /api/v2/shifts/{sourceShiftId}/detached-trips/{cycleId}/complete
export async function completeDetachedTrip(pool, actor, input) {
  const options = input ?? {};
  requireOnline(options);
  const workspaceId = requireWorkspace(options.workspaceId);
  const sourceShiftId = requireId(options.sourceShiftId, 'sourceShiftId');
  if (options.shiftId !== undefined && options.shiftId !== sourceShiftId) {
    throw v2Error('transfer-context-changed', 409, { sourceShiftId });
  }
  const cycleId = requireId(options.cycleId, 'cycleId');
  const truckId = requireId(options.truckId, 'truckId');
  const destinationShiftId = requireId(options.destinationShiftId, 'destinationShiftId');
  const type = requireStage(options.type);
  const createdAt = requireTimestamp(options.createdAt, 'createdAt');
  const collect = requireOptionalBoolean(options.collect, 'collect');
  const operationId = requireOperation(options.operationId);
  const protocolVersion = requireProtocol(options.protocolVersion);
  const expectedSourceShiftRevision = requireRevision(options.expectedSourceShiftRevision, 'expectedSourceShiftRevision');
  const expectedDestinationShiftRevision = requireRevision(options.expectedDestinationShiftRevision, 'expectedDestinationShiftRevision');
  const expectedDetachedCycleRevision = requireRevision(options.expectedDetachedCycleRevision, 'expectedDetachedCycleRevision');
  const body = {
    truckId,
    destinationShiftId,
    type,
    createdAt,
    ...(options.collect === undefined ? {} : {collect}),
    expectedSourceShiftRevision,
    expectedDestinationShiftRevision,
    expectedDetachedCycleRevision,
  };

  const mutate = async (client, context) => {
    const completer = context.actor;
    // Same order as the transfer: shifts sorted, then the truck status, then the
    // detached row. The status is locked first because every other line command
    // does the same; taking the detached row first would let a concurrent
    // `assign`/`remove` of the same truck deadlock against this command.
    const shifts = await lockShifts(client, workspaceId, [sourceShiftId, destinationShiftId]);
    const source = requireActive(shifts.get(sourceShiftId));
    const destination = requireActive(shifts.get(destinationShiftId));
    requireShiftRevision(source, expectedSourceShiftRevision);
    requireShiftRevision(destination, expectedDestinationShiftRevision);
    const status = await lockStatus(client, workspaceId, truckId);

    const row = (await client.query(
      `SELECT * FROM detached_open_trips
        WHERE workspace_id=$1 AND source_shift_id=$2 AND cycle_id=$3 FOR UPDATE`,
      [workspaceId, sourceShiftId, cycleId],
    )).rows[0];
    if (!row) throw v2Error('detached-trip-not-found', 404, { shiftId: sourceShiftId });
    if (row.state !== 'open') throw v2Error('detached-trip-completed', 409, { shiftId: sourceShiftId });
    // The body must name the stored trip exactly; a different truck or
    // destination is a different context, never a retarget of this one.
    if (row.truck_id !== truckId || row.destination_shift_id !== destinationShiftId) {
      throw v2Error('transfer-context-changed', 409, { truckId, destinationShiftId });
    }
    if (Number(row.cycle_revision) !== expectedDetachedCycleRevision) {
      throw v2Error('revision-conflict', 409, {
        expectedDetachedCycleRevision,
        actualDetachedCycleRevision: Number(row.cycle_revision),
      });
    }
    // Only the operation that matches the saved stage may complete the trip.
    if (row.stage !== type) throw v2Error('invalid-command', 400, { field: 'type' });

    // The truck must still be assigned to the destination: a second transfer or
    // a removal would have changed the right that allowed this call.
    if (!status || status.shift_id !== destinationShiftId || status.payload?.onLine === false) {
      throw v2Error('transfer-context-changed', 409, { truckId, destinationShiftId });
    }

    const truck = (await client.query(
      'SELECT payload FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2',
      [workspaceId, truckId],
    )).rows[0]?.payload ?? {};
    // The trip author is the person confirming it, and the email is part of the
    // canonical log document, so it is read from the profile in this transaction.
    const profile = (await client.query(
      'SELECT email FROM app_users WHERE uid=$1',
      [completer.uid],
    )).rows[0];
    const author = { displayName: completer.displayName, email: profile?.email ?? '' };
    const snapshot = row.payload ?? {};
    let log;
    if (row.stage === 'load') {
      log = loadLog({
        truckId,
        shiftId: sourceShiftId,
        cycleRevision: Number(row.source_cycle_revision),
        arrivalTimestamp: Number(snapshot.arriveTimestamp || 0),
        createdAt,
        actor: author,
        truck,
      });
      const inserted = await client.query(
        `INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload)
         VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING log_id`,
        [workspaceId, log.id, sourceShiftId, truckId, log],
      );
      if (!inserted.rowCount) {
        // The trip of this cycle already exists: the stage was not 'load'.
        throw v2Error('transfer-context-changed', 409, { truckId, shiftId: sourceShiftId });
      }
    } else {
      // The ТТН step completes the trip the source shift already saved.
      const logId = snapshot.lastLoadLogId;
      if (typeof logId !== 'string' || logId === '') {
        throw v2Error('transfer-context-changed', 409, { truckId, shiftId: sourceShiftId });
      }
      const updated = (await client.query(
        `UPDATE line_logs
            SET payload = payload || jsonb_build_object(
                  'ttnStatus', $4::jsonb,
                  'ttnBy', $5::text,
                  'ttnLogId', $6::text)
          WHERE workspace_id=$1 AND shift_id=$2 AND log_id=$3 AND truck_id=$7
          RETURNING log_id,truck_id,payload`,
        [
          workspaceId, sourceShiftId, logId, collect ? true : null,
          collect ? author.displayName : null,
          collect ? logId : null,
          truckId,
        ],
      )).rows[0];
      if (!updated) throw v2Error('transfer-context-changed', 409, { truckId, shiftId: sourceShiftId });
      log = { logId: updated.log_id, truckId: updated.truck_id, timestamp: Number(updated.payload.timestamp) };
    }

    const completed = (await client.query(
      `UPDATE detached_open_trips
          SET state='completed', cycle_revision=cycle_revision+1,
              completed_at=now(), completed_by_uid=$4, completion_operation_id=$5
        WHERE workspace_id=$1 AND source_shift_id=$2 AND cycle_id=$3
        RETURNING *`,
      [workspaceId, sourceShiftId, cycleId, completer.uid, operationId],
    )).rows[0];

    // All effects belong to the source line; the destination is untouched.
    const sourceAfter = (await client.query(
      `UPDATE shifts SET revision=revision+1 WHERE workspace_id=$1 AND shift_id=$2
        RETURNING shift_id,revision`,
      [workspaceId, sourceShiftId],
    )).rows[0];

    return {
      result: {
        truckId,
        sourceShiftId,
        destinationShiftId,
        cycleId,
        stage: row.stage,
        state: 'completed',
        detachedCycleRevision: Number(completed.cycle_revision),
        log: { logId: log.id ?? log.logId, truckId },
        shift: shiftView(sourceAfter),
      },
      before: {
        shiftRevision: Number(source.revision),
        destinationShiftRevision: Number(destination.revision),
        detachedCycleRevision: Number(row.cycle_revision),
        stage: row.stage,
        state: row.state,
        truckId,
        sourceShiftId,
        destinationShiftId,
      },
      after: {
        shiftRevision: Number(sourceAfter.revision),
        detachedCycleRevision: Number(completed.cycle_revision),
        stage: row.stage,
        state: 'completed',
        truckId,
        sourceShiftId,
        destinationShiftId,
      },
    };
  };

  return runV2Command({
    pool, uid: actor.uid, workspaceId, shiftId: sourceShiftId, protocolVersion,
    operation: operationId, type: 'shift.detached.complete', body,
    // The completing right is the ordinary one of the saved stage; the caller
    // names it, and the mutation refuses a name that does not match the stage.
    authorize: async (client, context) => {
      const profile = await loadActor(client, context.uid);
      await authorizeShift(client, profile, {
        action: 'shift.detached.complete', workspaceId,
        shiftId: sourceShiftId, destinationShiftId, lineAction: type,
      });
      return profile;
    },
    mutate,
  });
}
