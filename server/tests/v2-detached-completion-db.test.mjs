import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrationsThrough} from './helpers/isolated-db.mjs';
import {loadActor} from '../src/shift-access-v2.mjs';
import {createShift, addShiftMember, removeShiftMember} from '../src/shift-members-v2.mjs';
import {assignTruck} from '../src/shift-trucks-v2.mjs';
import {forceTransferTruck} from '../src/shift-transfer-v2.mjs';
import {completeDetachedTrip} from '../src/shift-transfer-v2.mjs';

// Detached trip completion (design §3.3, §4.4, §5.4, §6, §7, plan Task 20).
//
// A force transfer can leave exactly one unfinished cycle behind. That cycle is
// addressed `(source_shift_id, cycle_id)` forever, and the only command that may
// touch it is the online completion of the saved stage. Completion writes the
// trip and its effects into the SOURCE shift, marks the detached row completed,
// and never starts or edits a cycle in the destination shift.
//
// Covered contract:
//   * the saved stage decides the allowed completing operation, and only that
//     operation is accepted;
//   * the trip, its log and the source revision land in the source shift while
//     the destination status stays byte-identical;
//   * the detached row is completed, not deleted, and keeps both operation links;
//   * replay is idempotent and a second completion is a stable 409;
//   * access is recomputed per call: a current destination membership is enough;
//   * a missing row is 404, a stale detached revision is a revision conflict.

const WORKSPACE = 'main_workspace';
const ARRIVE_TS = 1795420800000;
const LOAD_TS = ARRIVE_TS + 1_800_000;

function moscowDate(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ms);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

test('v2 detached trip completion', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const pool = new pg.Pool({connectionString: process.env.TEST_DATABASE_URL, max: 5});
  pool.on('error', () => {});
  const prefix = 'detached_' + randomUUID().replaceAll('-', '');
  const ids = {
    admin: prefix + '_admin',
    senior: prefix + '_senior',
    foreman: prefix + '_foreman',
  };
  const object = {a: prefix + '_object_a'};
  const trucks = {
    arrived: prefix + '_truck_arrived',
    loaded: prefix + '_truck_loaded',
    access: prefix + '_truck_access',
    access2: prefix + '_truck_access2',
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
  const operationId = label => `${prefix}_${label}_${++operation}`;

  const shiftRevision = async shiftId => Number((await pool.query(
    'SELECT revision FROM shifts WHERE workspace_id=$1 AND shift_id=$2',
    [WORKSPACE, shiftId],
  )).rows[0].revision);
  const statusRow = async truckId => (await pool.query(
    `SELECT shift_id,status_revision,cycle_revision,ttn_revision,payload
       FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2`,
    [WORKSPACE, truckId],
  )).rows[0];
  const detachedRow = async cycleId => (await pool.query(
    `SELECT workspace_id,source_shift_id,destination_shift_id,truck_id,cycle_id,state,stage,
            cycle_revision,source_status_revision,source_ttn_revision,payload,
            detached_at,detached_by_uid,completed_at,completed_by_uid,
            transfer_operation_id,completion_operation_id
       FROM detached_open_trips WHERE workspace_id=$1 AND cycle_id=$2`,
    [WORKSPACE, cycleId],
  )).rows[0];
  const logs = async shiftId => (await pool.query(
    'SELECT log_id,truck_id,payload FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id COLLATE "C"',
    [WORKSPACE, shiftId],
  )).rows;
  const auditRows = async type => (await pool.query(
    'SELECT operation_id,uid,type,before_data,after_data FROM workspace_service_audit WHERE workspace_id=$1 AND type=$2 ORDER BY operation_id COLLATE "C"',
    [WORKSPACE, type],
  )).rows;

  // The exact row a confirmed line operation leaves behind; the line-operations
  // task owns the writer, this root seeds the same canonical columns.
  const seedStage = async (truckId, shiftId, stage) => {
    const row = await statusRow(truckId);
    const payload = {...row.payload};
    let cycle = Number(row.cycle_revision);
    let ttn = Number(row.ttn_revision);
    let logId = null;
    if (stage === 'arrive') {
      cycle += 1;
      Object.assign(payload, {
        arriveStatus: '08:15', arriveTimestamp: ARRIVE_TS, arriveBy: 'Сеньор', loadedAfterArrive: false,
      });
    }
    if (stage === 'load' || stage === 'ttn') {
      cycle += 1;
      logId = `load_${truckId}_${shiftId}_cycle_${cycle}_${ARRIVE_TS}`;
      Object.assign(payload, {
        lastLoadTimestamp: LOAD_TS, lastLoadLogId: logId, lastLoadBy: 'Сеньор',
        arriveStatus: null, arriveTimestamp: null, arriveBy: null, loadedAfterArrive: true,
      });
      await pool.query(
        `INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload)
         VALUES($1,$2,$3,$4,$5::jsonb)`,
        [WORKSPACE, logId, shiftId, truckId, {
          id: logId, shiftId, truckId, truckName: truckId, volume: 10,
          timeStr: '08:45', timestamp: LOAD_TS, arrivalTimestamp: ARRIVE_TS,
          createdBy: 'Сеньор', createdByEmail: `${ids.senior}@example.test`,
          isGAI: false, comment: '', clientOperationId: `seed_${logId}`,
        }],
      );
    }
    if (stage === 'ttn') {
      ttn += 1;
      Object.assign(payload, {ttnStatus: 'pending', ttnBy: 'Сеньор', ttnLogId: logId});
    }
    payload.cycleRevision = cycle;
    payload.ttnRevision = ttn;
    await pool.query(
      `UPDATE line_truck_statuses
          SET payload=$3::jsonb, cycle_revision=$4, ttn_revision=$5
        WHERE workspace_id=$1 AND truck_id=$2`,
      [WORKSPACE, truckId, payload, cycle, ttn],
    );
    return {cycle, ttn, logId};
  };

  const detach = async (truckId, stage, sourceShiftId, destinationShiftId) => {
    await assignTruck(pool, actors[ids.senior], {
      workspaceId: WORKSPACE,
      shiftId: sourceShiftId,
      operationId: operationId(`assign_${truckId.slice(-6)}`),
      protocolVersion: 2,
      truckId,
      expectedShiftRevision: await shiftRevision(sourceShiftId),
    });
    const seeded = await seedStage(truckId, sourceShiftId, stage);
    const before = await statusRow(truckId);
    const transferred = await forceTransferTruck(pool, actors[ids.senior], {
      workspaceId: WORKSPACE,
      operationId: operationId(`transfer_${truckId.slice(-6)}`),
      protocolVersion: 2,
      sourceShiftId,
      destinationShiftId,
      truckId,
      expectedSourceShiftRevision: await shiftRevision(sourceShiftId),
      expectedDestinationShiftRevision: await shiftRevision(destinationShiftId),
      expectedStatusRevision: Number(before.status_revision),
      expectedCycleRevision: seeded.cycle,
      expectedTtnRevision: seeded.ttn,
      confirmTransfer: true,
    });
    return {seeded, transferred, cycleId: transferred.result.detachedTrip.cycleId};
  };

  try {
    await applyMigrationsThrough(28);
    await pool.query('INSERT INTO workspaces(id) VALUES ($1) ON CONFLICT(id) DO NOTHING', [WORKSPACE]);
    for (const [uid, name, role] of [
      [ids.admin, 'Detached admin', 'admin'],
      [ids.senior, 'Detached senior', 'senior_foreman'],
      [ids.foreman, 'Detached foreman', 'foreman'],
    ]) {
      await pool.query(
        'INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,$4,$5)',
        [uid, `${uid}@example.test`, name, role, 'active'],
      );
    }
    await pool.query(
      'INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',
      [WORKSPACE, object.a, {id: object.a, name: 'Object detached'}],
    );
    for (const truckId of Object.values(trucks)) {
      await pool.query(
        'INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)',
        [WORKSPACE, truckId, {id: truckId, brand: 'Камаз', number: truckId.slice(-4), defaultVol: 10}],
      );
    }
    for (const role of ['senior_foreman', 'foreman']) {
      for (const action of ['start_shift', 'edit_line', 'tab_line', 'manage_trucks', 'action_arrive', 'action_load', 'action_ttn']) {
        await pool.query(
          `INSERT INTO role_permissions(role,action,allowed) VALUES($1,$2,true)
           ON CONFLICT(role,action) DO UPDATE SET allowed=true`,
          [role, action],
        );
      }
    }
    for (const uid of Object.values(ids)) actors[uid] = await loadActor(pool, uid);

    const createBody = shiftType => ({
      operationId: operationId(`create_${shiftType}`),
      protocolVersion: 2,
      objectId: object.a,
      workDate,
      shiftType,
      cycleMinutes: 30,
    });
    const shiftA = (await createShift(pool, actors[ids.senior], {workspaceId: WORKSPACE, ...createBody('day')})).result.shift.shiftId;
    const shiftB = (await createShift(pool, actors[ids.senior], {workspaceId: WORKSPACE, ...createBody('night')})).result.shift.shiftId;

    await t.test('completing_the_saved_load_stage_writes_the_trip_into_the_source_shift', async () => {
      const {seeded, transferred, cycleId} = await detach(trucks.arrived, 'arrive', shiftA, shiftB);
      assert.equal(transferred.result.detachedTrip.stage, 'load');
      const sourceRevision = await shiftRevision(shiftA);
      const destinationRevision = await shiftRevision(shiftB);
      const destinationStatus = await statusRow(trucks.arrived);
      const before = await detachedRow(cycleId);
      assert.equal(before.state, 'open');

      const completed = await completeDetachedTrip(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        sourceShiftId: shiftA,
        cycleId,
        operationId: operationId('complete_load'),
        protocolVersion: 2,
        truckId: trucks.arrived,
        destinationShiftId: shiftB,
        type: 'load',
        createdAt: LOAD_TS,
        expectedSourceShiftRevision: sourceRevision,
        expectedDestinationShiftRevision: destinationRevision,
        expectedDetachedCycleRevision: 1,
      });
      assert.equal(completed.replayed, false);
      assert.equal(completed.result.truckId, trucks.arrived);
      assert.equal(completed.result.sourceShiftId, shiftA);
      assert.equal(completed.result.cycleId, cycleId);
      assert.equal(completed.result.stage, 'load');
      assert.equal(completed.result.state, 'completed');
      assert.equal(completed.result.detachedCycleRevision, 2);
      assert.equal(completed.result.shift.shiftRevision, sourceRevision + 1);

      // The trip exists exactly once, in the SOURCE shift, with the derived id
      // the line protocol uses for a load of that cycle.
      const logId = `load_${trucks.arrived}_${shiftA}_cycle_${seeded.cycle}_${ARRIVE_TS}`;
      assert.equal(completed.result.log.logId, logId);
      const sourceLogs = await logs(shiftA);
      assert.deepEqual(sourceLogs.map(row => row.log_id), [logId]);
      assert.equal(sourceLogs[0].truck_id, trucks.arrived);
      assert.equal(Number(sourceLogs[0].payload.timestamp), LOAD_TS);
      assert.equal(sourceLogs[0].payload.shiftId, shiftA);
      assert.deepEqual(await logs(shiftB), [], 'the destination shift gets no trip');

      // The detached row is completed, not deleted, and keeps both links.
      const after = await detachedRow(cycleId);
      assert.equal(after.state, 'completed');
      assert.equal(Number(after.cycle_revision), 2);
      assert.equal(after.completed_by_uid, ids.senior);
      assert.ok(after.completed_at instanceof Date);
      assert.equal(after.transfer_operation_id, transferred.operationId);
      assert.equal(after.completion_operation_id, completed.operationId);
      assert.equal(after.payload.arriveStatus, '08:15');

      // The destination keeps its clean cycle byte for byte.
      const destinationAfter = await statusRow(trucks.arrived);
      assert.equal(destinationAfter.shift_id, destinationStatus.shift_id);
      assert.equal(Number(destinationAfter.status_revision), Number(destinationStatus.status_revision));
      assert.equal(Number(destinationAfter.cycle_revision), Number(destinationStatus.cycle_revision));
      assert.equal(Number(destinationAfter.ttn_revision), Number(destinationStatus.ttn_revision));
      assert.deepEqual(destinationAfter.payload, destinationStatus.payload);
      assert.equal(await shiftRevision(shiftB), destinationRevision);

      // One audit row, and the receipt is scoped to the source shift.
      const audits = await auditRows('shift.detached.complete');
      assert.equal(audits.length, 1);
      assert.equal(audits[0].operation_id, completed.operationId);
      assert.equal(audits[0].uid, ids.senior);
      assert.equal(audits[0].after_data.shiftId, shiftA);

      // Replay returns the stored answer and changes nothing.
      const replay = await completeDetachedTrip(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        sourceShiftId: shiftA,
        cycleId,
        operationId: completed.operationId,
        protocolVersion: 2,
        truckId: trucks.arrived,
        destinationShiftId: shiftB,
        type: 'load',
        createdAt: LOAD_TS,
        expectedSourceShiftRevision: sourceRevision,
        expectedDestinationShiftRevision: destinationRevision,
        expectedDetachedCycleRevision: 1,
      });
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, completed.result);
      assert.equal((await logs(shiftA)).length, 1);
      assert.equal(await shiftRevision(shiftA), sourceRevision + 1);

      // A completed trip never completes twice.
      await expectError(completeDetachedTrip(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        sourceShiftId: shiftA,
        cycleId,
        operationId: operationId('complete_again'),
        protocolVersion: 2,
        truckId: trucks.arrived,
        destinationShiftId: shiftB,
        type: 'load',
        createdAt: LOAD_TS + 60_000,
        expectedSourceShiftRevision: await shiftRevision(shiftA),
        expectedDestinationShiftRevision: await shiftRevision(shiftB),
        expectedDetachedCycleRevision: 2,
      }), 'detached-trip-completed', 409);
    });

    await t.test('completion_rejects_a_wrong_stage_and_a_stale_detached_revision', async () => {
      const {cycleId} = await detach(trucks.loaded, 'ttn', shiftA, shiftB);
      const sourceRevision = await shiftRevision(shiftA);
      const destinationRevision = await shiftRevision(shiftB);
      // The saved stage is the ТТН step; a load is not the completing operation.
      await expectError(completeDetachedTrip(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        sourceShiftId: shiftA,
        cycleId,
        operationId: operationId('complete_wrong_type'),
        protocolVersion: 2,
        truckId: trucks.loaded,
        destinationShiftId: shiftB,
        type: 'load',
        createdAt: LOAD_TS,
        expectedSourceShiftRevision: sourceRevision,
        expectedDestinationShiftRevision: destinationRevision,
        expectedDetachedCycleRevision: 1,
      }), 'invalid-command', 400);
      // A stale detached CAS never completes.
      await expectError(completeDetachedTrip(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        sourceShiftId: shiftA,
        cycleId,
        operationId: operationId('complete_stale'),
        protocolVersion: 2,
        truckId: trucks.loaded,
        destinationShiftId: shiftB,
        type: 'ttn',
        createdAt: LOAD_TS + 60_000,
        expectedSourceShiftRevision: sourceRevision,
        expectedDestinationShiftRevision: destinationRevision,
        expectedDetachedCycleRevision: 5,
      }), 'revision-conflict', 409);
      // An unknown cycle is a stable 404, not a guess by truck.
      await expectError(completeDetachedTrip(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        sourceShiftId: shiftA,
        cycleId: `${cycleId}_missing`,
        operationId: operationId('complete_missing'),
        protocolVersion: 2,
        truckId: trucks.loaded,
        destinationShiftId: shiftB,
        type: 'ttn',
        createdAt: LOAD_TS + 60_000,
        expectedSourceShiftRevision: sourceRevision,
        expectedDestinationShiftRevision: destinationRevision,
        expectedDetachedCycleRevision: 1,
      }), 'detached-trip-not-found', 404);
      assert.equal((await detachedRow(cycleId)).state, 'open');
    });

    await t.test('completing_the_ttn_stage_updates_the_saved_trip_only', async () => {
      const [openRow] = (await pool.query(
        `SELECT cycle_id,payload FROM detached_open_trips
          WHERE workspace_id=$1 AND truck_id=$2 AND state='open'`,
        [WORKSPACE, trucks.loaded],
      )).rows;
      const cycleId = openRow.cycle_id;
      const logId = openRow.payload.lastLoadLogId;
      assert.ok(logId, 'the detached snapshot names its trip');
      const sourceRevision = await shiftRevision(shiftA);
      const destinationRevision = await shiftRevision(shiftB);
      const destinationStatus = await statusRow(trucks.loaded);

      const completed = await completeDetachedTrip(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        sourceShiftId: shiftA,
        cycleId,
        operationId: operationId('complete_ttn'),
        protocolVersion: 2,
        truckId: trucks.loaded,
        destinationShiftId: shiftB,
        type: 'ttn',
        createdAt: LOAD_TS + 600_000,
        collect: true,
        expectedSourceShiftRevision: sourceRevision,
        expectedDestinationShiftRevision: destinationRevision,
        expectedDetachedCycleRevision: 1,
      });
      assert.equal(completed.result.stage, 'ttn');
      assert.equal(completed.result.log.logId, logId);
      // No new trip is invented: the saved one is updated in place.
      const sourceLogs = await logs(shiftA);
      assert.deepEqual(sourceLogs.filter(row => row.log_id === logId).map(row => row.log_id), [logId]);
      const trip = sourceLogs.find(row => row.log_id === logId);
      assert.equal(trip.payload.ttnStatus, true);
      // The person who confirmed the collection is the one recorded, not the
      // actor who once wrote the pending snapshot.
      assert.equal(trip.payload.ttnBy, 'Detached senior');
      assert.equal(await shiftRevision(shiftA), sourceRevision + 1);
      assert.equal(await shiftRevision(shiftB), destinationRevision);
      assert.deepEqual((await statusRow(trucks.loaded)).payload, destinationStatus.payload);
    });

    await t.test('completion_access_is_recomputed_on_every_call', async () => {
      const {cycleId} = await detach(trucks.access, 'arrive', shiftA, shiftB);
      const {cycleId: secondCycle} = await detach(trucks.access2, 'arrive', shiftA, shiftB);
      // The senior leaves the source shift; the current destination membership
      // alone must still allow the completion (§6).
      const membership = (await pool.query(
        `SELECT revision FROM shift_members
          WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3 AND removed_at IS NULL`,
        [WORKSPACE, shiftA, ids.senior],
      )).rows[0];
      await removeShiftMember(pool, actors[ids.admin], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        uid: ids.senior,
        operationId: operationId('remove_source_member'),
        protocolVersion: 2,
        expectedShiftRevision: await shiftRevision(shiftA),
        expectedMembershipRevision: Number(membership.revision),
      });
      assert.equal((await pool.query(
        `SELECT count(*)::int AS total FROM shift_members
          WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3 AND removed_at IS NULL`,
        [WORKSPACE, shiftA, ids.senior],
      )).rows[0].total, 0);

      const sourceRevision = await shiftRevision(shiftA);
      const destinationRevision = await shiftRevision(shiftB);
      const body = {
        workspaceId: WORKSPACE,
        sourceShiftId: shiftA,
        cycleId,
        operationId: operationId('complete_via_destination'),
        protocolVersion: 2,
        truckId: trucks.access,
        destinationShiftId: shiftB,
        type: 'load',
        createdAt: LOAD_TS,
        expectedSourceShiftRevision: sourceRevision,
        expectedDestinationShiftRevision: destinationRevision,
        expectedDetachedCycleRevision: 1,
      };
      // The body must name the stored trip exactly.
      await expectError(completeDetachedTrip(pool, actors[ids.senior], {
        ...body, operationId: operationId('complete_wrong_truck'), truckId: trucks.loaded,
      }), 'transfer-context-changed', 409);
      const completed = await completeDetachedTrip(pool, actors[ids.senior], body);
      assert.equal(completed.result.state, 'completed');
      assert.equal(completed.result.shift.shiftRevision, sourceRevision + 1);

      // A member of the source without the completing right is refused by the
      // matrix, never by a missing membership code.
      await pool.query(
        "UPDATE role_permissions SET allowed=false WHERE role='foreman' AND action='action_load'",
      );
      await addShiftMember(pool, actors[ids.admin], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        uid: ids.foreman,
        operationId: operationId('add_foreman'),
        protocolVersion: 2,
        expectedShiftRevision: await shiftRevision(shiftA),
        expectedMembershipRevision: null,
      });
      actors[ids.foreman] = await loadActor(pool, ids.foreman);
      await expectError(completeDetachedTrip(pool, actors[ids.foreman], {
        workspaceId: WORKSPACE,
        sourceShiftId: shiftA,
        cycleId: secondCycle,
        operationId: operationId('complete_without_right'),
        protocolVersion: 2,
        truckId: trucks.access2,
        destinationShiftId: shiftB,
        type: 'load',
        createdAt: LOAD_TS,
        expectedSourceShiftRevision: await shiftRevision(shiftA),
        expectedDestinationShiftRevision: await shiftRevision(shiftB),
        expectedDetachedCycleRevision: 1,
      }), 'forbidden', 403);
      // Admin needs no membership at all.
      const adminCompleted = await completeDetachedTrip(pool, actors[ids.admin], {
        workspaceId: WORKSPACE,
        sourceShiftId: shiftA,
        cycleId: secondCycle,
        operationId: operationId('complete_admin'),
        protocolVersion: 2,
        truckId: trucks.access2,
        destinationShiftId: shiftB,
        type: 'load',
        createdAt: LOAD_TS,
        expectedSourceShiftRevision: await shiftRevision(shiftA),
        expectedDestinationShiftRevision: await shiftRevision(shiftB),
        expectedDetachedCycleRevision: 1,
      });
      assert.equal(adminCompleted.result.state, 'completed');
    });
  } finally {
    await pool.end();
  }
});
