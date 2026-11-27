import { v2Error } from './v2-errors.mjs';
import { runV2Command } from './v2-command.mjs';
import { authorizeShift, loadActor } from './shift-access-v2.mjs';
import { applyLineOperation, validateLineOperation } from './line-rules.mjs';
import {
  lockShift,
  lockStatus,
  requireActive,
  requireId,
  requireOperation,
  requireProtocol,
  requireRevision,
  requireShiftChanged,
  requireWorkspace,
  shiftView,
  statusConflict,
  statusView,
} from './shift-trucks-v2.mjs';

// Shift-scoped line operations and the object lock (design §3.1, §3.3, §4.3,
// §5.4, §6, §7, §15, plan Task 21).
//
// The arrive/load/ttn/reset semantics already live in `line-rules.mjs`; this
// module is only the v2 scope + CAS + receipt + lock layer around them:
//
//   * the shift comes only from the path — a body `shiftId` that disagrees is
//     `400 invalid-command` before any transaction opens, and the receipt hash is
//     bound to the path shift;
//   * the truck must be the current `onLine` assignment of THIS shift, so a
//     truck of another shift is `409 truck-not-on-shift` and never a cross-shift
//     or detached-trip write;
//   * structural invariants are decided before the CAS counters (§3.3, §7);
//   * the first confirmed `arrive` — and, defensively, the first confirmed
//     `load` on a legacy/imported row without a lock — sets
//     `object_locked_at`/`object_locked_by_operation_id` and bumps the shift
//     revision once, in the same transaction as the receipt (§15). A cancelled
//     arrival (`wantArrived:false`, "снял прибытие") is not an arrival: the
//     status row loses `arriveStatus`/`arriveTimestamp`/`arriveBy`, no work is
//     recorded, so the object stays unlocked and the shift keeps the right to
//     correct it;
//   * a finished cycle can be removed; the lock is not a cycle fact and survives
//     the removal;
//   * the same `operationId` + hash replays the stored result; a different body
//     is `409 operation-id-reused`.
//
// Lock order (shared with `shift-trucks-v2.mjs`, §5.2): the shift row first, then
// the truck status row. The shift lock is the shared `lockShift`; the extra
// `object_locked_at` read happens in the same transaction on the already locked
// row, so it cannot race.

const LINE_TYPES = Object.freeze(['arrive', 'load', 'ttn', 'reset']);
const LINE_ACTIONS = Object.freeze({
  arrive: 'shift.line.arrive',
  load: 'shift.line.load',
  ttn: 'shift.line.ttn',
  reset: 'shift.line.reset',
});

const STATUS_FIELDS = 'truck_id,shift_id,status_revision,cycle_revision,ttn_revision,payload';

// `validateLineOperation` speaks the v1 reason vocabulary; the v2 contract has
// one stable code per refusal. Only the field name is client-visible.
const FIELD_BY_REASON = Object.freeze({
  'invalid-operation': 'body',
  'invalid-id': 'operationId',
  'invalid-shiftId': 'shiftId',
  'invalid-truckId': 'truckId',
  'invalid-type': 'type',
  'invalid-createdAt': 'createdAt',
  'invalid-expectedRevision': 'expectedCycleRevision',
  'invalid-expectedTtnRevision': 'expectedTtnRevision',
  'invalid-arrivalTimestamp': 'arrivalTimestamp',
  'invalid-lastLoadTimestamp': 'lastLoadTimestamp',
  'invalid-intent': 'body',
  'invalid-cycleMinutes': 'cycleMinutes',
  'invalid-logId': 'logId',
});

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw v2Error('invalid-command', 400, { field });
  return value;
}

function requireLineType(value) {
  if (typeof value !== 'string' || !LINE_TYPES.includes(value)) {
    throw v2Error('invalid-command', 400, { field: 'type' });
  }
  return value;
}

// The path shift wins. A body that names a different shift is a client error,
// refused before the command transaction even opens, so no receipt can exist.
function requirePathShift(shiftId, bodyShiftId) {
  if (bodyShiftId === undefined) return shiftId;
  if (bodyShiftId !== shiftId) throw v2Error('invalid-command', 400, { field: 'shiftId' });
  return shiftId;
}

// A refused domain step keeps its exact v2 code. The counters named here are the
// ones the CAS already read from the locked row.
function domainRefusal(reason, context) {
  switch (reason) {
    case 'truck-not-on-line':
      return v2Error('truck-not-on-shift', 409, { truckId: context.truckId, shiftId: context.shiftId });
    case 'permission-denied':
      return v2Error('forbidden', 403, { reason: 'missing-right' });
    case 'arrival-changed':
    case 'duplicate-or-arrival-changed':
      return statusConflict('CycleRevision', context.expectedCycleRevision, context.actualCycleRevision);
    case 'ttn-changed':
      return statusConflict('TtnRevision', context.expectedTtnRevision, context.actualTtnRevision);
    case 'invalid-log-id':
      return v2Error('invalid-command', 400, { field: 'logId' });
    case 'unsupported':
      return v2Error('invalid-command', 400, { field: 'type' });
    default:
      // `cycle-time` and `invalid-time-order` are both "this createdAt cannot be
      // used now"; the client retries with a fresh clock instead of a stale one.
      return v2Error('invalid-command', 400, { field: 'createdAt' });
  }
}

// POST /api/v2/shifts/{shiftId}/line-operations
//
// `bodyShiftId` is the raw value the router read from the body. It is never used
// as the addressed shift; it only exists so a disagreement can be refused.
export async function submitLineOperationV2(pool, actor, input) {
  const options = input ?? {};
  const workspaceId = requireWorkspace(options.workspaceId);
  const shiftId = requirePathShift(requireId(options.shiftId, 'shiftId'), options.bodyShiftId);
  const type = requireLineType(options.type);
  const truckId = requireId(options.truckId, 'truckId');
  const operationId = requireOperation(options.operationId);
  const protocolVersion = requireProtocol(options.protocolVersion);
  const expectedShiftRevision = requireRevision(options.expectedShiftRevision, 'expectedShiftRevision');
  const expectedStatusRevision = requireRevision(options.expectedStatusRevision, 'expectedStatusRevision');
  const expectedCycleRevision = requireRevision(options.expectedCycleRevision, 'expectedCycleRevision');
  const expectedTtnRevision = requireRevision(options.expectedTtnRevision, 'expectedTtnRevision');
  const createdAt = options.createdAt;
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw v2Error('invalid-command', 400, { field: 'createdAt' });
  }
  const cycleMinutes = options.cycleMinutes;
  if (!Number.isFinite(cycleMinutes) || cycleMinutes < 15 || cycleMinutes > 10080) {
    throw v2Error('invalid-command', 400, { field: 'cycleMinutes' });
  }
  // `line-rules.mjs` reads an absent `wantArrived` as "arrived" (`op.wantArrived
  // !== false`), so the v2 layer must not silently turn a missing intent into a
  // cancellation: only an explicit `false` cancels the arrival.
  const wantArrived = requireBoolean(
    options.wantArrived === undefined ? type === 'arrive' : options.wantArrived,
    'wantArrived',
  );
  const collect = requireBoolean(options.collect === undefined ? false : options.collect, 'collect');
  const logId = options.logId;
  if (logId !== undefined && (typeof logId !== 'string' || logId.length > 512)) {
    throw v2Error('invalid-command', 400, { field: 'logId' });
  }

  const action = LINE_ACTIONS[type];
  const body = {
    truckId,
    createdAt,
    cycleMinutes,
    wantArrived,
    collect,
    expectedShiftRevision,
    expectedStatusRevision,
    expectedCycleRevision,
    expectedTtnRevision,
    ...(logId === undefined ? {} : { logId }),
  };

  const authorize = async (client, context) => {
    const profile = await loadActor(client, context.uid);
    await authorizeShift(client, profile, { action, workspaceId, shiftId });
    // The canonical load document carries the author's e-mail, and the reset
    // rule asks whether the actor may reset the timer. Both are answered from
    // the profile and the right that just authorized this exact command.
    const email = (await client.query(
      'SELECT email FROM app_users WHERE uid=$1',
      [context.uid],
    )).rows[0]?.email ?? '';
    return Object.freeze({
      uid: profile.uid,
      name: profile.displayName,
      displayName: profile.displayName,
      role: profile.role,
      email,
      isAdmin: profile.role === 'admin',
      canResetTimer: true,
    });
  };

  const mutate = async (client, context) => {
    // 1. The shift row first — the shared lock order. The lock columns are read
    //    on the same already locked row, never with a second competing lock.
    const shift = await lockShift(client, workspaceId, shiftId);
    if (!shift) throw v2Error('shift-not-visible', 404, { shiftId });
    requireActive(shift);
    const lock = (await client.query(
      `SELECT object_locked_at,object_locked_by_operation_id
         FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [workspaceId, shiftId],
    )).rows[0] ?? { object_locked_at: null, object_locked_by_operation_id: null };

    // 2. The truck status row, then the structural invariants: one current
    //    assignment, on this shift, still on the line. A detached cycle already
    //    lives in its destination, so the source answers exactly this.
    const existing = await lockStatus(client, workspaceId, truckId);
    if (!existing || existing.shift_id !== shiftId || existing.payload?.onLine !== true) {
      throw v2Error('truck-not-on-shift', 409, { truckId, shiftId });
    }

    // 3. Only now the CAS counters, in the documented order.
    requireShiftChanged(shift, expectedShiftRevision);
    for (const [field, column, expected] of [
      ['StatusRevision', 'status_revision', expectedStatusRevision],
      ['CycleRevision', 'cycle_revision', expectedCycleRevision],
      ['TtnRevision', 'ttn_revision', expectedTtnRevision],
    ]) {
      const actual = Number(existing[column]);
      if (actual !== expected) throw statusConflict(field, expected, actual);
    }

    // 4. The domain step. `before` is the canonical payload; the counters and the
    //    arrival timestamp come from the locked row, never from the client.
    const before = existing.payload ?? {};
    const op = {
      id: operationId,
      shiftId,
      truckId,
      type,
      createdAt,
      expectedRevision: expectedCycleRevision,
      expectedTtnRevision,
      arrivalTimestamp: Number(before.arriveTimestamp || 0),
      lastLoadTimestamp: Number(before.lastLoadTimestamp || 0),
      wantArrived,
      collect,
      cycleMinutes,
      ...(logId === undefined ? {} : { logId }),
    };
    const invalid = validateLineOperation(op, Date.now());
    if (invalid) {
      throw v2Error('invalid-command', 400, { field: FIELD_BY_REASON[invalid] ?? 'body' });
    }
    const truck = (await client.query(
      'SELECT payload FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2',
      [workspaceId, truckId],
    )).rows[0]?.payload ?? {};
    const outcome = applyLineOperation({
      op,
      before,
      truck,
      actor: context.actor,
      cycleMinutes,
      now: Date.now(),
    });
    if (outcome.outcome !== 'confirmed') {
      throw domainRefusal(outcome.reason, {
        truckId,
        shiftId,
        expectedCycleRevision,
        actualCycleRevision: Number(existing.cycle_revision),
        expectedTtnRevision,
        actualTtnRevision: Number(existing.ttn_revision),
      });
    }

    // 5. Normalized counters: the touched one moves by exactly one, the other is
    //    carried as is. The payload mirrors the columns (025 invariant).
    const nextStatusRevision = Number(existing.status_revision) + 1;
    const nextCycleRevision = type === 'ttn'
      ? Number(existing.cycle_revision)
      : Number(existing.cycle_revision) + 1;
    const nextTtnRevision = type === 'ttn'
      ? Number(existing.ttn_revision) + 1
      : Number(existing.ttn_revision);
    const payload = {
      ...outcome.status,
      id: truckId,
      shiftId,
      onLine: true,
      cycleRevision: nextCycleRevision,
      ttnRevision: nextTtnRevision,
    };
    const updated = (await client.query(
      `UPDATE line_truck_statuses
          SET payload=$3::jsonb, status_revision=$4, cycle_revision=$5, ttn_revision=$6
        WHERE workspace_id=$1 AND truck_id=$2
        RETURNING ${STATUS_FIELDS}`,
      [workspaceId, truckId, payload, nextStatusRevision, nextCycleRevision, nextTtnRevision],
    )).rows[0];
    if (!updated) throw v2Error('truck-not-on-shift', 409, { truckId, shiftId });

    // 6. A confirmed load saves its canonical trip in this shift. The log id is
    //    derived from the locked cycle revision and arrival, so a duplicate is a
    //    conflict, never a second row.
    let logView = null;
    if (outcome.log) {
      const inserted = await client.query(
        `INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload)
         VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING log_id`,
        [workspaceId, outcome.log.id, shiftId, truckId, outcome.log],
      );
      if (!inserted.rowCount) {
        throw v2Error('revision-conflict', 409, {
          expectedCycleRevision,
          actualCycleRevision: nextCycleRevision,
        });
      }
      logView = { logId: outcome.log.id, truckId, timestamp: Number(outcome.log.timestamp) };
    }

    // 7. The first confirmed arrival locks the object (§15). A defensive load on
    //    a legacy/imported row without a lock takes it as well. The lock and the
    //    revision bump are one statement, so they can never be observed apart.
    //
    //    A cancelled arrival is not an arrival: `wantArrived:false` clears the
    //    arrival fields and records no work, so the design predicate ("a
    //    `line_logs` trip or an arrival/load marker in the status") is not met and
    //    the object must stay correctable. Only `load` counts unconditionally —
    //    it always leaves a trip.
    const recordsArrival = type === 'load' || (type === 'arrive' && wantArrived === true);
    let bumped = null;
    if (lock.object_locked_at === null && recordsArrival) {
      bumped = (await client.query(
        `UPDATE shifts
            SET revision=revision+1, object_locked_at=now(), object_locked_by_operation_id=$3
          WHERE workspace_id=$1 AND shift_id=$2 AND revision=$4 AND object_locked_at IS NULL
          RETURNING shift_id,revision,object_locked_at`,
        [workspaceId, shiftId, operationId, Number(shift.revision)],
      )).rows[0] ?? null;
      if (!bumped) {
        // The row is locked for this transaction, so this is unreachable; the
        // honest answer is still a counter refusal, not an internal error.
        throw v2Error('shift-changed', 409, {
          expectedShiftRevision: Number(shift.revision),
          actualShiftRevision: Number(shift.revision),
        });
      }
    }
    const shiftResult = bumped ? shiftView(bumped) : { shiftId, shiftRevision: Number(shift.revision) };
    const objectLockedAt = bumped
      ? new Date(bumped.object_locked_at).toISOString()
      : (lock.object_locked_at === null ? null : new Date(lock.object_locked_at).toISOString());

    const assignment = statusView(updated);
    return {
      result: {
        confirmed: true,
        type,
        truckId,
        shiftId,
        shift: shiftResult,
        assignment,
        log: logView,
        objectLockedAt,
      },
      before: {
        type,
        truckId,
        shiftRevision: Number(shift.revision),
        objectLocked: lock.object_locked_at !== null,
        statusRevision: Number(existing.status_revision),
        cycleRevision: Number(existing.cycle_revision),
        ttnRevision: Number(existing.ttn_revision),
      },
      after: {
        type,
        truckId,
        shiftRevision: shiftResult.shiftRevision,
        objectLocked: objectLockedAt !== null,
        statusRevision: assignment.statusRevision,
        cycleRevision: assignment.cycleRevision,
        ttnRevision: assignment.ttnRevision,
      },
    };
  };

  return runV2Command({
    pool, uid: actor.uid, workspaceId, shiftId, protocolVersion,
    operation: operationId, type: action, body, authorize, mutate,
  });
}
