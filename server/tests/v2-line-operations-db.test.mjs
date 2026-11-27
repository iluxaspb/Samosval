import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrationsThrough} from './helpers/isolated-db.mjs';
import {loadActor} from '../src/shift-access-v2.mjs';
import {changeShiftObject, createShift} from '../src/shift-members-v2.mjs';
import {assignTruck, removeTruck} from '../src/shift-trucks-v2.mjs';
import {forceTransferTruck} from '../src/shift-transfer-v2.mjs';
import {submitLineOperationV2} from '../src/line-store-v2.mjs';

// Scoped line operations and the object lock (design §3.1, §3.3, §4.3, §5.4,
// §6, §7, §15, plan Task 21).
//
// The root runs on the frozen S25 baseline and applies 026/027/028 through the
// privileged bootstrap connection; every assertion stays on the app role.
//
// Covered contract:
//   * the shift comes only from the path — a body `shiftId` that disagrees is
//     `400 invalid-command` before any mutation, and no receipt is written;
//   * a truck of another shift, or a legacy off-line row, is
//     `409 truck-not-on-shift` and neither shift changes by one byte;
//   * the first confirmed `arrive` sets `object_locked_at` /
//     `object_locked_by_operation_id` in the receipt transaction and bumps the
//     shift revision exactly once; a later arrive on the same shift locks
//     nothing and bumps nothing;
//   * `changeShiftObject` still works before that arrive and answers
//     `409 object-locked` afterwards, including after the trip is removed;
//   * a defensive confirmed `load` on a shift without a lock (legacy/imported
//     rows) takes the lock, once; a cancelled arrival (`wantArrived:false`) does
//     not take it, because no arrival marker and no trip remain;
//   * CAS mismatches are `409 revision-conflict` with the exact
//     `expected*/actual*` field in the documented order (shift → status →
//     cycle → ttn), and a shift revision mismatch is the single-shift
//     `409 shift-changed` (docs/opyt-oshibok.md, lesson 50.3);
//   * the same `operationId` + hash replays the stored result, a different body
//     with the same id is `409 operation-id-reused`;
//   * trap A≠B: an operation on one shift never changes the other shift's
//     statuses, logs, revision or object lock;
//   * the ordinary endpoint never touches `detached_open_trips`: a detached
//     cycle belongs to the destination and is completed only by Task 20's
//     endpoint.
//
// Numbers (revisions, counters) are derived from the actual rows, never
// hardcoded: a hardcoded revision silently turns a refusal test into a real
// mutation (docs/opyt-oshibok.md, lesson 50.1).

const WORKSPACE = 'main_workspace';

function moscowTime(ms) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms));
}

function moscowDate(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ms);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

test('v2 scoped line operations and object lock', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const pool = new pg.Pool({connectionString: process.env.TEST_DATABASE_URL, max: 5});
  pool.on('error', () => {});
  const prefix = 'line_' + randomUUID().replaceAll('-', '');
  const ids = {
    admin: prefix + '_admin',
    senior: prefix + '_senior',
  };
  const objects = {
    a: prefix + '_object_a',
    b: prefix + '_object_b',
    c: prefix + '_object_c',
  };
  const trucks = {
    arrive: prefix + '_truck_arrive',
    other: prefix + '_truck_other',
    offline: prefix + '_truck_offline',
    cas: prefix + '_truck_cas',
    replay: prefix + '_truck_replay',
    detach: prefix + '_truck_detach',
    reset: prefix + '_truck_reset',
    legacy: prefix + '_truck_legacy',
    trapB: prefix + '_truck_trap_b',
    cancel: prefix + '_truck_cancel',
  };
  const workDate = moscowDate();

  const capture = async promise => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error;
    }
  };
  const expectError = async (promise, code, status) => {
    const error = await capture(promise);
    assert.ok(error, `expected ${code}`);
    assert.equal(error.name, 'V2Error', `expected a V2Error, got ${error?.message}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return error;
  };
  const actors = {};
  let operation = 0;
  const nextOperation = label => `${prefix}_${label}_${++operation}`;

  const statusRow = async truckId => (await pool.query(
    `SELECT shift_id,status_revision,cycle_revision,ttn_revision,payload
       FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2`,
    [WORKSPACE, truckId],
  )).rows[0];
  const shiftRow = async shiftId => (await pool.query(
    `SELECT shift_id,state,revision,object_id,object_locked_at,object_locked_by_operation_id
       FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
    [WORKSPACE, shiftId],
  )).rows[0];
  const shiftRevision = async shiftId => Number((await shiftRow(shiftId)).revision);
  const logsFor = async shiftId => (await pool.query(
    `SELECT log_id,shift_id,truck_id,payload FROM line_logs
      WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id COLLATE "C"`,
    [WORKSPACE, shiftId],
  )).rows;
  const receiptRow = async operationId => (await pool.query(
    'SELECT uid,request_hash,result FROM shift_operation_receipts WHERE workspace_id=$1 AND operation_id=$2',
    [WORKSPACE, operationId],
  )).rows[0];
  const auditRow = async operationId => (await pool.query(
    'SELECT uid,type,before_data,after_data FROM workspace_service_audit WHERE workspace_id=$1 AND operation_id=$2',
    [WORKSPACE, operationId],
  )).rows[0];
  const detachedRows = async truckId => (await pool.query(
    `SELECT cycle_id,state,stage,cycle_revision,source_shift_id,destination_shift_id,
            completion_operation_id,transfer_operation_id
       FROM detached_open_trips WHERE workspace_id=$1 AND truck_id=$2
      ORDER BY cycle_id COLLATE "C"`,
    [WORKSPACE, truckId],
  )).rows;
  // One shift's whole line, byte for byte: the trap test compares this object.
  const lineState = async shiftId => ({
    shift: await shiftRow(shiftId),
    statuses: (await pool.query(
      `SELECT truck_id,shift_id,status_revision,cycle_revision,ttn_revision,payload
         FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2
        ORDER BY truck_id COLLATE "C"`,
      [WORKSPACE, shiftId],
    )).rows,
    logs: await logsFor(shiftId),
  });

  const createBody = (objectId, shiftType) => ({
    operationId: nextOperation(`create_${shiftType}`),
    protocolVersion: 2,
    objectId,
    workDate,
    shiftType,
    cycleMinutes: 30,
  });
  const assign = async (shiftId, truckId) => assignTruck(pool, actors[ids.senior], {
    workspaceId: WORKSPACE,
    shiftId,
    truckId,
    operationId: nextOperation(`assign_${truckId.slice(-6)}`),
    protocolVersion: 2,
    expectedShiftRevision: await shiftRevision(shiftId),
  });
  // A line command whose CAS counters are the current ones; an explicit field
  // overrides the derived value, which is how the mismatch cases stay honest.
  const lineOp = async ({shiftId, truckId, type, operationId, createdAt, ...fields}) => {
    const row = await statusRow(truckId);
    return {
      workspaceId: WORKSPACE,
      shiftId,
      operationId,
      protocolVersion: 2,
      type,
      truckId,
      expectedShiftRevision: await shiftRevision(shiftId),
      expectedStatusRevision: Number(row.status_revision),
      expectedCycleRevision: Number(row.cycle_revision),
      expectedTtnRevision: Number(row.ttn_revision),
      createdAt,
      ...fields,
    };
  };
  // A legacy/imported row that already carries an arrival but no object lock:
  // the exact case the defensive `load` fallback exists for (§3.1).
  const seedArrival = async (truckId, shiftId, arriveTimestamp) => {
    const row = await statusRow(truckId);
    const cycleRevision = Number(row.cycle_revision) + 1;
    const payload = {
      ...row.payload,
      arriveStatus: moscowTime(arriveTimestamp),
      arriveTimestamp,
      arriveBy: 'Импорт',
      loadedAfterArrive: false,
      cycleRevision,
    };
    await pool.query(
      `UPDATE line_truck_statuses SET payload=$3::jsonb, cycle_revision=$4
        WHERE workspace_id=$1 AND truck_id=$2`,
      [WORKSPACE, truckId, payload, cycleRevision],
    );
    return cycleRevision;
  };

  let shiftA;
  let shiftB;
  let shiftC;

  try {
    await applyMigrationsThrough(28);
    await pool.query('INSERT INTO workspaces(id) VALUES ($1) ON CONFLICT(id) DO NOTHING', [WORKSPACE]);
    for (const [uid, name, role] of [
      [ids.admin, 'Line admin', 'admin'],
      [ids.senior, 'Line senior', 'senior_foreman'],
    ]) {
      await pool.query(
        'INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,$4,$5)',
        [uid, `${uid}@example.test`, name, role, 'active'],
      );
    }
    for (const [objectId, name] of [
      [objects.a, 'Object line A'],
      [objects.b, 'Object line B'],
      [objects.c, 'Object line C'],
    ]) {
      await pool.query(
        'INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',
        [WORKSPACE, objectId, {id: objectId, name}],
      );
    }
    for (const truckId of Object.values(trucks)) {
      await pool.query(
        'INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)',
        [WORKSPACE, truckId, {
          id: truckId, brand: 'Камаз', number: truckId.slice(-4), defaultVol: 10, isGAI: false,
        }],
      );
    }
    // The isolated matrix starts nearly empty (019/020 rows only); grant the
    // ordinary rights the same way the admin UI would.
    for (const action of [
      'start_shift', 'edit_line', 'tab_line', 'manage_trucks',
      'action_arrive', 'action_load', 'action_ttn', 'line_timer_reset',
    ]) {
      await pool.query(
        `INSERT INTO role_permissions(role,action,allowed) VALUES($1,$2,true)
         ON CONFLICT(role,action) DO UPDATE SET allowed=true`,
        ['senior_foreman', action],
      );
    }
    for (const uid of Object.values(ids)) actors[uid] = await loadActor(pool, uid);

    shiftA = (await createShift(pool, actors[ids.senior], {
      workspaceId: WORKSPACE, ...createBody(objects.a, 'day'),
    })).result.shift.shiftId;
    shiftB = (await createShift(pool, actors[ids.senior], {
      workspaceId: WORKSPACE, ...createBody(objects.a, 'night'),
    })).result.shift.shiftId;
    shiftC = (await createShift(pool, actors[ids.senior], {
      workspaceId: WORKSPACE, ...createBody(objects.b, 'day'),
    })).result.shift.shiftId;
    assert.equal(new Set([shiftA, shiftB, shiftC]).size, 3);

    for (const truckId of [trucks.arrive, trucks.cas, trucks.replay, trucks.detach]) {
      await assign(shiftA, truckId);
    }
    await assign(shiftB, trucks.other);
    await assign(shiftB, trucks.trapB);
    await assign(shiftC, trucks.reset);
    await assign(shiftC, trucks.legacy);
    // The v1 `line.remove` leaves a row with `onLine:false`; it is not a current
    // assignment and no line command may write it.
    await pool.query(
      `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload,status_revision,cycle_revision,ttn_revision)
       VALUES($1,$2,$3,$4::jsonb,1,1,1)`,
      [WORKSPACE, trucks.offline, shiftA, {
        id: trucks.offline, shiftId: shiftA, onLine: false,
        arriveStatus: null, arriveTimestamp: null, arriveBy: null, loadedAfterArrive: false,
        lastLoadTimestamp: null, lastLoadBy: null, lastLoadLogId: null,
        ttnStatus: null, ttnBy: null, ttnLogId: null, cycleRevision: 1, ttnRevision: 1,
      }],
    );

    await t.test('a_body_shift_that_disagrees_with_the_path_is_refused_before_any_mutation', async () => {
      const before = {status: await statusRow(trucks.arrive), shift: await shiftRow(shiftA)};
      const operationId = nextOperation('body_shift');
      const body = {
        ...await lineOp({
          shiftId: shiftA,
          truckId: trucks.arrive,
          type: 'arrive',
          operationId,
          createdAt: Date.now(),
          wantArrived: true,
          cycleMinutes: 30,
        }),
        shiftId: shiftB,
      };
      const error = await expectError(submitLineOperationV2(pool, actors[ids.senior], {
        ...body,
        // The router passes the path shift and the raw body value separately.
        shiftId: shiftA,
        bodyShiftId: body.shiftId,
      }), 'invalid-command', 400);
      assert.deepEqual(error.details, {field: 'shiftId'});
      assert.deepEqual(await statusRow(trucks.arrive), before.status);
      assert.deepEqual(await shiftRow(shiftA), before.shift);
      assert.equal(await receiptRow(operationId), undefined);
      assert.equal(await auditRow(operationId), undefined);
    });

    await t.test('a_truck_of_another_shift_is_never_written_across_shifts', async () => {
      const stateA = await lineState(shiftA);
      const stateB = await lineState(shiftB);
      const foreign = await statusRow(trucks.other);
      const operationId = nextOperation('foreign_truck');
      const error = await expectError(submitLineOperationV2(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId,
        protocolVersion: 2,
        type: 'arrive',
        truckId: trucks.other,
        expectedShiftRevision: Number(stateA.shift.revision),
        expectedStatusRevision: Number(foreign.status_revision),
        expectedCycleRevision: Number(foreign.cycle_revision),
        expectedTtnRevision: Number(foreign.ttn_revision),
        createdAt: Date.now(),
        wantArrived: true,
        cycleMinutes: 30,
      }), 'truck-not-on-shift', 409);
      assert.equal(error.details.truckId, trucks.other);
      assert.equal(error.details.shiftId, shiftA);
      // Neither shift moved: not the source, not the owner.
      assert.deepEqual(await lineState(shiftA), stateA);
      assert.deepEqual(await lineState(shiftB), stateB);
      assert.equal(await receiptRow(operationId), undefined);
      assert.equal(await auditRow(operationId), undefined);

      // A legacy off-line row is not a current assignment either.
      const offline = await statusRow(trucks.offline);
      const offlineOperation = nextOperation('offline_row');
      await expectError(submitLineOperationV2(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: offlineOperation,
        protocolVersion: 2,
        type: 'arrive',
        truckId: trucks.offline,
        expectedShiftRevision: Number(stateA.shift.revision),
        expectedStatusRevision: Number(offline.status_revision),
        expectedCycleRevision: Number(offline.cycle_revision),
        expectedTtnRevision: Number(offline.ttn_revision),
        createdAt: Date.now(),
        wantArrived: true,
        cycleMinutes: 30,
      }), 'truck-not-on-shift', 409);
      assert.deepEqual(await statusRow(trucks.offline), offline);
      assert.equal(await receiptRow(offlineOperation), undefined);
    });

    await t.test('the_first_confirmed_arrive_locks_the_object_in_the_receipt_transaction', async () => {
      // §15: before the first confirmed arrive `change object` still passes.
      const unlocked = await shiftRow(shiftA);
      assert.equal(unlocked.object_locked_at, null);
      const changed = await changeShiftObject(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('object_before_lock'),
        protocolVersion: 2,
        objectId: objects.c,
        expectedShiftRevision: Number(unlocked.revision),
      });
      assert.equal(changed.result.shift.objectId, objects.c);
      const restored = await changeShiftObject(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('object_before_lock_back'),
        protocolVersion: 2,
        objectId: objects.a,
        expectedShiftRevision: changed.result.shift.shiftRevision,
      });
      assert.equal(restored.result.shift.objectId, objects.a);

      const before = {status: await statusRow(trucks.arrive), shift: await shiftRow(shiftA)};
      const createdAt = Date.now();
      const operationId = nextOperation('first_arrive');
      const response = await submitLineOperationV2(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        // The body may repeat the path shift; only a disagreement is refused.
        bodyShiftId: shiftA,
        operationId,
        protocolVersion: 2,
        type: 'arrive',
        truckId: trucks.arrive,
        expectedShiftRevision: Number(before.shift.revision),
        expectedStatusRevision: Number(before.status.status_revision),
        expectedCycleRevision: Number(before.status.cycle_revision),
        expectedTtnRevision: Number(before.status.ttn_revision),
        createdAt,
        wantArrived: true,
        cycleMinutes: 30,
      });
      assert.equal(response.replayed, false);
      assert.equal(response.result.confirmed, true);
      assert.equal(response.result.type, 'arrive');
      assert.equal(response.result.truckId, trucks.arrive);
      assert.equal(response.result.shiftId, shiftA);
      assert.equal(response.result.shift.shiftRevision, Number(before.shift.revision) + 1);
      assert.equal(response.result.assignment.statusRevision, Number(before.status.status_revision) + 1);
      assert.equal(response.result.assignment.cycleRevision, Number(before.status.cycle_revision) + 1);
      assert.equal(response.result.assignment.ttnRevision, Number(before.status.ttn_revision));
      assert.equal(response.result.assignment.stage, 'load');
      assert.equal(response.result.log, null);
      assert.equal(typeof response.result.objectLockedAt, 'string');
      assert.equal(new Date(response.result.objectLockedAt).toISOString(), response.result.objectLockedAt);

      const after = await shiftRow(shiftA);
      assert.equal(Number(after.revision), Number(before.shift.revision) + 1);
      assert.ok(after.object_locked_at instanceof Date);
      assert.equal(after.object_locked_by_operation_id, operationId);
      const status = await statusRow(trucks.arrive);
      assert.equal(Number(status.status_revision), Number(before.status.status_revision) + 1);
      assert.equal(Number(status.cycle_revision), Number(before.status.cycle_revision) + 1);
      assert.equal(Number(status.ttn_revision), Number(before.status.ttn_revision));
      assert.equal(Number(status.payload.arriveTimestamp), createdAt);
      assert.equal(status.payload.arriveStatus, moscowTime(createdAt));
      assert.equal(status.payload.arriveBy, 'Line senior');
      assert.equal(status.payload.loadedAfterArrive, false);
      assert.equal(status.payload.shiftId, shiftA);
      assert.equal(Number(status.payload.cycleRevision), Number(status.cycle_revision));

      // Receipt and audit are written in the same transaction as the lock.
      const receipt = await receiptRow(operationId);
      assert.ok(receipt, 'a confirmed command leaves a receipt');
      assert.equal(receipt.uid, ids.senior);
      assert.match(receipt.request_hash, /^[a-f0-9]{64}$/);
      assert.equal(receipt.result.confirmed, true);
      assert.equal(receipt.result.shift.shiftRevision, Number(before.shift.revision) + 1);
      const audit = await auditRow(operationId);
      assert.ok(audit, 'a confirmed command leaves an audit row');
      assert.equal(audit.type, 'shift.line.arrive');
      assert.equal(audit.before_data.shiftId, shiftA);
      assert.equal(audit.after_data.shiftId, shiftA);
      assert.equal(audit.before_data.objectLocked, false);
      assert.equal(audit.after_data.objectLocked, true);

      // The lock is taken once: a second truck arriving on the same shift moves
      // its own status but neither the shift revision nor the lock owner.
      const locked = await shiftRow(shiftA);
      const secondOperation = nextOperation('second_arrive');
      const second = await submitLineOperationV2(pool, actors[ids.senior], {
        ...await lineOp({
          shiftId: shiftA,
          truckId: trucks.cas,
          type: 'arrive',
          operationId: secondOperation,
          createdAt: createdAt + 1000,
          wantArrived: true,
          cycleMinutes: 30,
        }),
      });
      assert.equal(second.result.confirmed, true);
      assert.equal(second.result.shift.shiftRevision, Number(locked.revision));
      const stillLocked = await shiftRow(shiftA);
      assert.equal(Number(stillLocked.revision), Number(locked.revision));
      assert.equal(stillLocked.object_locked_by_operation_id, operationId);
      assert.equal(stillLocked.object_locked_at.toISOString(), locked.object_locked_at.toISOString());
    });

    await t.test('a_cas_mismatch_names_the_exact_counter_in_the_documented_order', async () => {
      const row = await statusRow(trucks.cas);
      const shift = await shiftRow(shiftA);
      const base = {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        protocolVersion: 2,
        type: 'load',
        truckId: trucks.cas,
        createdAt: Date.now(),
        cycleMinutes: 30,
      };
      const current = {
        expectedShiftRevision: Number(shift.revision),
        expectedStatusRevision: Number(row.status_revision),
        expectedCycleRevision: Number(row.cycle_revision),
        expectedTtnRevision: Number(row.ttn_revision),
      };

      // The status counter is checked before the cycle and ttn counters, so all
      // three wrong at once still names the status.
      let error = await expectError(submitLineOperationV2(pool, actors[ids.senior], {
        ...base,
        ...current,
        operationId: nextOperation('cas_status_all'),
        expectedStatusRevision: Number(row.status_revision) + 1,
        expectedCycleRevision: Number(row.cycle_revision) + 1,
        expectedTtnRevision: Number(row.ttn_revision) + 1,
      }), 'revision-conflict', 409);
      assert.deepEqual(error.details, {
        expectedStatusRevision: Number(row.status_revision) + 1,
        actualStatusRevision: Number(row.status_revision),
      });

      error = await expectError(submitLineOperationV2(pool, actors[ids.senior], {
        ...base,
        ...current,
        operationId: nextOperation('cas_status'),
        expectedStatusRevision: Number(row.status_revision) + 1,
      }), 'revision-conflict', 409);
      assert.deepEqual(error.details, {
        expectedStatusRevision: Number(row.status_revision) + 1,
        actualStatusRevision: Number(row.status_revision),
      });

      error = await expectError(submitLineOperationV2(pool, actors[ids.senior], {
        ...base,
        ...current,
        operationId: nextOperation('cas_cycle'),
        expectedCycleRevision: Number(row.cycle_revision) + 1,
      }), 'revision-conflict', 409);
      assert.deepEqual(error.details, {
        expectedCycleRevision: Number(row.cycle_revision) + 1,
        actualCycleRevision: Number(row.cycle_revision),
      });

      error = await expectError(submitLineOperationV2(pool, actors[ids.senior], {
        ...base,
        ...current,
        operationId: nextOperation('cas_ttn'),
        expectedTtnRevision: Number(row.ttn_revision) + 1,
      }), 'revision-conflict', 409);
      assert.deepEqual(error.details, {
        expectedTtnRevision: Number(row.ttn_revision) + 1,
        actualTtnRevision: Number(row.ttn_revision),
      });

      // A single-shift command answers `shift-changed` for its shift counter.
      error = await expectError(submitLineOperationV2(pool, actors[ids.senior], {
        ...base,
        ...current,
        operationId: nextOperation('cas_shift'),
        expectedShiftRevision: Number(shift.revision) + 1,
      }), 'shift-changed', 409);
      assert.deepEqual(error.details, {
        expectedShiftRevision: Number(shift.revision) + 1,
        actualShiftRevision: Number(shift.revision),
      });

      // No refused command mutated anything or left a receipt behind.
      assert.deepEqual(await statusRow(trucks.cas), row);
      assert.deepEqual(await shiftRow(shiftA), shift);
      assert.equal((await logsFor(shiftA)).filter(item => item.truck_id === trucks.cas).length, 0);
    });

    await t.test('trap_a_line_operation_never_crosses_the_shift_boundary', async () => {
      const stateA = await lineState(shiftA);
      const shiftBBefore = await shiftRow(shiftB);
      const bArrive = await submitLineOperationV2(pool, actors[ids.senior], await lineOp({
        shiftId: shiftB,
        truckId: trucks.trapB,
        type: 'arrive',
        operationId: nextOperation('trap_b_arrive'),
        createdAt: Date.now(),
        wantArrived: true,
        cycleMinutes: 30,
      }));
      assert.equal(bArrive.result.confirmed, true);
      // Shift B moved exactly as its own command says…
      const shiftBAfter = await shiftRow(shiftB);
      assert.equal(Number(shiftBAfter.revision), Number(shiftBBefore.revision) + 1);
      assert.ok(shiftBAfter.object_locked_at instanceof Date);
      assert.equal(shiftBAfter.object_locked_by_operation_id, bArrive.operationId);
      // …and shift A is byte for byte what it was.
      assert.deepEqual(await lineState(shiftA), stateA);

      const stateB = await lineState(shiftB);
      const arriveTs = Number((await statusRow(trucks.arrive)).payload.arriveTimestamp);
      const aLoad = await submitLineOperationV2(pool, actors[ids.senior], await lineOp({
        shiftId: shiftA,
        truckId: trucks.arrive,
        type: 'load',
        operationId: nextOperation('trap_a_load'),
        createdAt: Math.max(Date.now(), arriveTs + 1),
        cycleMinutes: 30,
      }));
      assert.equal(aLoad.result.confirmed, true);
      assert.deepEqual(await lineState(shiftB), stateB);
      assert.notDeepEqual(await lineState(shiftA), stateA);
    });

    await t.test('a_replay_returns_the_stored_result_and_a_new_body_reuses_the_id', async () => {
      const arriveTs = Date.now();
      await submitLineOperationV2(pool, actors[ids.senior], await lineOp({
        shiftId: shiftA,
        truckId: trucks.replay,
        type: 'arrive',
        operationId: nextOperation('replay_arrive'),
        createdAt: arriveTs,
        wantArrived: true,
        cycleMinutes: 30,
      }));
      const beforeLoad = await statusRow(trucks.replay);
      const canonicalLogId = `load_${trucks.replay}_${shiftA}_cycle_${Number(beforeLoad.cycle_revision)}_${Number(beforeLoad.payload.arriveTimestamp)}`;
      const loadInput = await lineOp({
        shiftId: shiftA,
        truckId: trucks.replay,
        type: 'load',
        operationId: nextOperation('replay_load'),
        createdAt: Math.max(Date.now(), Number(beforeLoad.payload.arriveTimestamp) + 1),
        cycleMinutes: 30,
      });
      const first = await submitLineOperationV2(pool, actors[ids.senior], loadInput);
      assert.equal(first.result.confirmed, true);
      assert.equal(first.result.log.logId, canonicalLogId);
      assert.equal(first.result.assignment.stage, 'ttn');
      const [log] = (await logsFor(shiftA)).filter(item => item.log_id === canonicalLogId);
      assert.ok(log, 'the canonical trip is stored in the shift');
      assert.equal(log.truck_id, trucks.replay);
      assert.equal(log.payload.truckName, `Камаз ${trucks.replay.slice(-4)}`);
      assert.equal(Number(log.payload.volume), 10);
      assert.equal(log.payload.createdBy, 'Line senior');
      assert.equal(log.payload.createdByEmail, `${ids.senior}@example.test`);
      assert.equal(log.payload.clientOperationId, loadInput.operationId);
      assert.equal(Number(log.payload.arrivalTimestamp), Number(beforeLoad.payload.arriveTimestamp));
      const afterLoad = await statusRow(trucks.replay);

      const replay = await submitLineOperationV2(pool, actors[ids.senior], loadInput);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, first.result);
      assert.equal((await logsFor(shiftA)).filter(item => item.log_id === canonicalLogId).length, 1);
      assert.deepEqual(await statusRow(trucks.replay), afterLoad);

      // A different body under the same id is not a replay.
      await expectError(submitLineOperationV2(pool, actors[ids.senior], {
        ...loadInput,
        createdAt: loadInput.createdAt + 1,
      }), 'operation-id-reused', 409);
      assert.deepEqual(await statusRow(trucks.replay), afterLoad);
      assert.equal((await logsFor(shiftA)).filter(item => item.log_id === canonicalLogId).length, 1);
    });

    await t.test('the_cycle_finishes_and_the_object_stays_locked_after_the_trip_is_removed', async () => {
      const loaded = await statusRow(trucks.arrive);
      const ttn = await submitLineOperationV2(pool, actors[ids.senior], await lineOp({
        shiftId: shiftA,
        truckId: trucks.arrive,
        type: 'ttn',
        operationId: nextOperation('ttn_collect'),
        createdAt: Date.now(),
        collect: true,
        cycleMinutes: 30,
      }));
      assert.equal(ttn.result.confirmed, true);
      assert.equal(ttn.result.assignment.ttnRevision, Number(loaded.ttn_revision) + 1);
      assert.equal(ttn.result.assignment.cycleRevision, Number(loaded.cycle_revision));
      assert.equal(ttn.result.assignment.stage, null);
      const collected = await statusRow(trucks.arrive);
      assert.equal(collected.payload.ttnStatus, true);
      assert.equal(collected.payload.ttnBy, 'Line senior');
      assert.equal(collected.payload.ttnLogId, collected.payload.lastLoadLogId);
      assert.equal(Number(collected.payload.ttnRevision), Number(collected.ttn_revision));

      // A finished cycle can be removed; the object lock is not a cycle fact and
      // survives the removal (§3.1).
      const lockBefore = await shiftRow(shiftA);
      const removed = await removeTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('remove_finished'),
        protocolVersion: 2,
        truckId: trucks.arrive,
        expectedShiftRevision: Number(lockBefore.revision),
        expectedStatusRevision: Number(collected.status_revision),
        expectedCycleRevision: Number(collected.cycle_revision),
        expectedTtnRevision: Number(collected.ttn_revision),
      });
      assert.equal(removed.result.removed, true);
      assert.equal(removed.result.shift.shiftRevision, Number(lockBefore.revision) + 1);
      assert.equal(await statusRow(trucks.arrive), undefined);
      const lockAfter = await shiftRow(shiftA);
      assert.equal(lockAfter.object_locked_at.toISOString(), lockBefore.object_locked_at.toISOString());
      assert.equal(lockAfter.object_locked_by_operation_id, lockBefore.object_locked_by_operation_id);

      const error = await expectError(changeShiftObject(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('object_after_lock'),
        protocolVersion: 2,
        objectId: objects.c,
        expectedShiftRevision: Number(lockAfter.revision),
      }), 'object-locked', 409);
      assert.deepEqual(error.details, {shiftId: shiftA});
      assert.equal((await shiftRow(shiftA)).object_id, objects.a);
    });

    await t.test('a_defensive_load_without_a_lock_takes_the_lock_once', async () => {
      // A reset is a cycle fact, not an arrival: it never locks the object and
      // never bumps the shift revision.
      const resetArrival = Date.now() - 60_000;
      await seedArrival(trucks.reset, shiftC, resetArrival);
      const shiftBeforeReset = await shiftRow(shiftC);
      assert.equal(shiftBeforeReset.object_locked_at, null);
      const resetRow = await statusRow(trucks.reset);
      const reset = await submitLineOperationV2(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftC,
        operationId: nextOperation('reset_legacy'),
        protocolVersion: 2,
        type: 'reset',
        truckId: trucks.reset,
        expectedShiftRevision: Number(shiftBeforeReset.revision),
        expectedStatusRevision: Number(resetRow.status_revision),
        expectedCycleRevision: Number(resetRow.cycle_revision),
        expectedTtnRevision: Number(resetRow.ttn_revision),
        createdAt: Date.now(),
        cycleMinutes: 30,
      });
      assert.equal(reset.result.confirmed, true);
      assert.equal(reset.result.assignment.stage, null);
      assert.equal(reset.result.objectLockedAt, null);
      const afterReset = await statusRow(trucks.reset);
      assert.equal(afterReset.payload.arriveStatus ?? null, null);
      assert.equal(Number(afterReset.cycle_revision), Number(resetRow.cycle_revision) + 1);
      const shiftAfterReset = await shiftRow(shiftC);
      assert.equal(shiftAfterReset.object_locked_at, null, 'a reset never locks the object');
      assert.equal(Number(shiftAfterReset.revision), Number(shiftBeforeReset.revision));

      // The imported arrival row has no lock: a confirmed load takes it.
      const loadArrival = Date.now() - 30_000;
      await seedArrival(trucks.legacy, shiftC, loadArrival);
      const shiftBeforeLoad = await shiftRow(shiftC);
      const legacyRow = await statusRow(trucks.legacy);
      const loadOperation = nextOperation('defensive_load');
      const load = await submitLineOperationV2(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftC,
        operationId: loadOperation,
        protocolVersion: 2,
        type: 'load',
        truckId: trucks.legacy,
        expectedShiftRevision: Number(shiftBeforeLoad.revision),
        expectedStatusRevision: Number(legacyRow.status_revision),
        expectedCycleRevision: Number(legacyRow.cycle_revision),
        expectedTtnRevision: Number(legacyRow.ttn_revision),
        createdAt: Math.max(Date.now(), Number(legacyRow.payload.arriveTimestamp) + 1),
        cycleMinutes: 30,
      });
      assert.equal(load.result.confirmed, true);
      assert.equal(load.result.shift.shiftRevision, Number(shiftBeforeLoad.revision) + 1);
      const shiftAfterLoad = await shiftRow(shiftC);
      assert.ok(shiftAfterLoad.object_locked_at instanceof Date);
      assert.equal(shiftAfterLoad.object_locked_by_operation_id, loadOperation);
      assert.equal(Number(shiftAfterLoad.revision), Number(shiftBeforeLoad.revision) + 1);

      // Once: the following ТТН steps change the status but not the lock.
      const ttn = await submitLineOperationV2(pool, actors[ids.senior], await lineOp({
        shiftId: shiftC,
        truckId: trucks.legacy,
        type: 'ttn',
        operationId: nextOperation('legacy_ttn'),
        createdAt: Date.now(),
        collect: true,
        cycleMinutes: 30,
      }));
      assert.equal(ttn.result.confirmed, true);
      const undo = await submitLineOperationV2(pool, actors[ids.senior], await lineOp({
        shiftId: shiftC,
        truckId: trucks.legacy,
        type: 'ttn',
        operationId: nextOperation('legacy_ttn_undo'),
        createdAt: Date.now(),
        collect: false,
        cycleMinutes: 30,
      }));
      assert.equal(undo.result.confirmed, true);
      const shiftAfterTtn = await shiftRow(shiftC);
      assert.equal(shiftAfterTtn.object_locked_at.toISOString(), shiftAfterLoad.object_locked_at.toISOString());
      assert.equal(shiftAfterTtn.object_locked_by_operation_id, loadOperation);
      assert.equal(Number(shiftAfterTtn.revision), Number(shiftAfterLoad.revision));
    });

    await t.test('the_ordinary_endpoint_never_touches_detached_trips', async () => {
      const arriveTs = Date.now();
      const arrived = await submitLineOperationV2(pool, actors[ids.senior], await lineOp({
        shiftId: shiftA,
        truckId: trucks.detach,
        type: 'arrive',
        operationId: nextOperation('detach_arrive'),
        createdAt: arriveTs,
        wantArrived: true,
        cycleMinutes: 30,
      }));
      assert.equal(arrived.result.confirmed, true);
      const status = await statusRow(trucks.detach);
      const transferred = await forceTransferTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftB,
        destinationShiftId: shiftB,
        sourceShiftId: shiftA,
        truckId: trucks.detach,
        operationId: nextOperation('detach_transfer'),
        protocolVersion: 2,
        expectedSourceShiftRevision: await shiftRevision(shiftA),
        expectedDestinationShiftRevision: await shiftRevision(shiftB),
        expectedStatusRevision: Number(status.status_revision),
        expectedCycleRevision: Number(status.cycle_revision),
        expectedTtnRevision: Number(status.ttn_revision),
        confirmTransfer: true,
      });
      assert.equal(transferred.result.detachedTrip.stage, 'load');
      const [detached] = await detachedRows(trucks.detach);
      assert.equal(detached.state, 'open');

      // The truck now lives in the destination; the ordinary endpoint of the
      // source answers "not on this shift" and writes nothing anywhere.
      const stateA = await lineState(shiftA);
      const moved = await statusRow(trucks.detach);
      for (const type of ['arrive', 'load']) {
        const operationId = nextOperation(`detached_${type}_on_source`);
        await expectError(submitLineOperationV2(pool, actors[ids.senior], {
          workspaceId: WORKSPACE,
          shiftId: shiftA,
          operationId,
          protocolVersion: 2,
          type,
          truckId: trucks.detach,
          expectedShiftRevision: Number(stateA.shift.revision),
          expectedStatusRevision: Number(moved.status_revision),
          expectedCycleRevision: Number(moved.cycle_revision),
          expectedTtnRevision: Number(moved.ttn_revision),
          createdAt: Date.now(),
          wantArrived: true,
          cycleMinutes: 30,
        }), 'truck-not-on-shift', 409);
        assert.equal(await receiptRow(operationId), undefined);
      }
      assert.deepEqual(await lineState(shiftA), stateA);
      const [stillOpen] = await detachedRows(trucks.detach);
      assert.equal(stillOpen.state, 'open');
      assert.equal(Number(stillOpen.cycle_revision), 1);
      assert.equal(stillOpen.completion_operation_id, null);
      assert.equal(stillOpen.cycle_id, detached.cycle_id);
      // The only detached row in the whole fixture is the one force transfer
      // created: the ordinary endpoint never opened one.
      const detachedTotal = (await pool.query(
        'SELECT count(*)::int AS total FROM detached_open_trips WHERE workspace_id=$1 AND truck_id = ANY($2::text[])',
        [WORKSPACE, Object.values(trucks)],
      )).rows[0].total;
      assert.equal(detachedTotal, 1);
    });

    await t.test('a_cancelled_arrival_never_locks_the_object', async () => {
      // §3.1: the lock follows real work — a saved trip or an arrival/load marker
      // in the status. A cancelled arrival ("↩️ Снял прибытие") clears those
      // markers and records nothing, so the shift keeps the right to correct its
      // object. A fresh shift is used on purpose: every other shift in this root
      // is already locked by the subtests above, and a locked shift could not
      // tell "the cancel did not lock" from "it was locked before".
      const shiftD = (await createShift(pool, actors[ids.senior], {
        workspaceId: WORKSPACE, ...createBody(objects.b, 'night'),
      })).result.shift.shiftId;
      await assign(shiftD, trucks.cancel);

      const arriveTs = Date.now() - 45_000;
      await seedArrival(trucks.cancel, shiftD, arriveTs);
      const before = await shiftRow(shiftD);
      assert.equal(before.object_locked_at, null);
      assert.equal(before.object_locked_by_operation_id, null);
      const row = await statusRow(trucks.cancel);
      assert.equal(row.payload.arriveStatus, moscowTime(arriveTs));

      const cancelled = await submitLineOperationV2(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftD,
        operationId: nextOperation('cancel_arrive'),
        protocolVersion: 2,
        type: 'arrive',
        truckId: trucks.cancel,
        expectedShiftRevision: Number(before.revision),
        expectedStatusRevision: Number(row.status_revision),
        expectedCycleRevision: Number(row.cycle_revision),
        expectedTtnRevision: Number(row.ttn_revision),
        createdAt: Date.now(),
        wantArrived: false,
        cycleMinutes: 30,
      });
      assert.equal(cancelled.result.confirmed, true);
      assert.equal(cancelled.result.objectLockedAt, null);

      const after = await statusRow(trucks.cancel);
      assert.equal(after.payload.arriveStatus, null);
      assert.equal(after.payload.arriveTimestamp, null);
      assert.equal(after.payload.arriveBy, null);
      assert.equal(after.payload.loadedAfterArrive, false);
      assert.equal(Number(after.cycle_revision), Number(row.cycle_revision) + 1);
      assert.equal(Number(after.status_revision), Number(row.status_revision) + 1);
      assert.equal(Number(after.ttn_revision), Number(row.ttn_revision));

      const shiftAfter = await shiftRow(shiftD);
      assert.equal(shiftAfter.object_locked_at, null, 'a cancelled arrival never locks the object');
      assert.equal(shiftAfter.object_locked_by_operation_id, null);
      assert.equal(Number(shiftAfter.revision), Number(before.revision), 'a cancelled arrival never bumps the shift');

      // The object is still correctable — and the correction is undone so the
      // fixture ends in the state it started in.
      const changed = await changeShiftObject(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftD,
        operationId: nextOperation('cancel_object_change'),
        protocolVersion: 2,
        objectId: objects.c,
        expectedShiftRevision: Number(shiftAfter.revision),
      });
      assert.equal(changed.result.shift.objectId, objects.c);
      const restored = await changeShiftObject(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftD,
        operationId: nextOperation('cancel_object_change_back'),
        protocolVersion: 2,
        objectId: objects.b,
        expectedShiftRevision: changed.result.shift.shiftRevision,
      });
      assert.equal(restored.result.shift.objectId, objects.b);
      const finalShift = await shiftRow(shiftD);
      assert.equal(finalShift.object_locked_at, null);
      assert.equal(finalShift.object_locked_by_operation_id, null);
    });
  } finally {
    await pool.end();
  }
});
