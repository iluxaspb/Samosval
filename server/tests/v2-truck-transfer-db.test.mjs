import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrationsThrough} from './helpers/isolated-db.mjs';
import {loadActor} from '../src/shift-access-v2.mjs';
import {createShift} from '../src/shift-members-v2.mjs';
import {assignTruck, removeTruck} from '../src/shift-trucks-v2.mjs';
import {forceTransferTruck} from '../src/shift-transfer-v2.mjs';
import {readShiftSnapshot} from '../src/shift-read-v2.mjs';

// Truck assignment and force transfer (design §3.3, §4.3, §4.4, §5.4, §6, §7,
// plan Task 20).
//
// The root runs on the frozen S25 baseline and applies 026/027/028 through the
// privileged bootstrap connection; every assertion stays on the app role.
//
// Covered contract:
//   * one current status per truck; a second assignment to another shift is
//     `409 truck-assigned-to-other-shift` with safe warning details;
//   * the same assignment repeated is an honest no-op, not a second row;
//   * remove needs a finished cycle and no open detached trip;
//   * force transfer moves a finished cycle atomically and detaches an unfinished
//     one into `detached_open_trips` with the exact saved stage;
//   * both shift revisions move by exactly one, the destination gets a clean
//     assignment, the source keeps its cycle snapshot;
//   * confirmation, current revisions and replay are enforced;
//   * a concurrent double transfer has exactly one winner and one detached row.
//
// A confirmed arrive/load/ttn is written by the line-operations task; this root
// seeds the same canonical columns and payload fields directly so the transfer
// contract is proved against the real row shape instead of a stub.

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

test('v2 truck assignment and force transfer', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const pool = new pg.Pool({connectionString: process.env.TEST_DATABASE_URL, max: 5});
  pool.on('error', () => {});
  const prefix = 'transfer_' + randomUUID().replaceAll('-', '');
  const ids = {
    admin: prefix + '_admin',
    senior: prefix + '_senior',
    foreman: prefix + '_foreman',
  };
  const object = {a: prefix + '_object_a'};
  const trucks = {
    clean: prefix + '_truck_clean',
    arrived: prefix + '_truck_arrived',
    loaded: prefix + '_truck_loaded',
    race: prefix + '_truck_race',
    stale: prefix + '_truck_stale',
    other: prefix + '_truck_other',
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

  const statusRow = async truckId => (await pool.query(
    `SELECT shift_id,status_revision,cycle_revision,ttn_revision,payload
       FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2`,
    [WORKSPACE, truckId],
  )).rows[0];
  const shiftRevision = async shiftId => Number((await pool.query(
    'SELECT revision FROM shifts WHERE workspace_id=$1 AND shift_id=$2',
    [WORKSPACE, shiftId],
  )).rows[0].revision);
  const detachedRows = async truckId => (await pool.query(
    `SELECT workspace_id,source_shift_id,destination_shift_id,truck_id,cycle_id,state,stage,
            cycle_revision,source_status_revision,source_ttn_revision,payload,
            detached_at,detached_by_uid,completed_at,completed_by_uid,
            transfer_operation_id,completion_operation_id
       FROM detached_open_trips WHERE workspace_id=$1 AND truck_id=$2
      ORDER BY detached_at ASC, cycle_id COLLATE "C" ASC`,
    [WORKSPACE, truckId],
  )).rows;

  // The exact row a confirmed line operation leaves behind (design §4.3): the
  // normalized revision columns and the canonical payload agree.
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

  const createBody = (objectId, shiftType) => ({
    operationId: operationId(`create_${shiftType}`),
    protocolVersion: 2,
    objectId,
    workDate,
    shiftType,
    cycleMinutes: 30,
  });
  const transferBody = (sourceShiftId, destinationShiftId, truckId, extra = {}) => ({
    operationId: operationId(`transfer_${truckId.slice(-6)}`),
    protocolVersion: 2,
    sourceShiftId,
    destinationShiftId,
    truckId,
    expectedSourceShiftRevision: 1,
    expectedDestinationShiftRevision: 1,
    expectedStatusRevision: 1,
    expectedCycleRevision: 1,
    expectedTtnRevision: 1,
    confirmTransfer: true,
    ...extra,
  });

  try {
    await applyMigrationsThrough(28);
    await pool.query('INSERT INTO workspaces(id) VALUES ($1) ON CONFLICT(id) DO NOTHING', [WORKSPACE]);
    for (const [uid, name, role] of [
      [ids.admin, 'Transfer admin', 'admin'],
      [ids.senior, 'Transfer senior', 'senior_foreman'],
      [ids.foreman, 'Transfer foreman', 'foreman'],
    ]) {
      await pool.query(
        'INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,$4,$5)',
        [uid, `${uid}@example.test`, name, role, 'active'],
      );
    }
    await pool.query(
      'INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',
      [WORKSPACE, object.a, {id: object.a, name: 'Object transfer'}],
    );
    for (const truckId of Object.values(trucks)) {
      await pool.query(
        'INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)',
        [WORKSPACE, truckId, {id: truckId, brand: 'Камаз', number: truckId.slice(-4), defaultVol: 10}],
      );
    }
    // The isolated matrix starts nearly empty (019/020 rows only); grant the
    // ordinary rights the same way the admin UI would.
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

    const shiftA = (await createShift(pool, actors[ids.senior], {workspaceId: WORKSPACE, ...createBody(object.a, 'day')})).result.shift.shiftId;
    const shiftB = (await createShift(pool, actors[ids.senior], {workspaceId: WORKSPACE, ...createBody(object.a, 'night')})).result.shift.shiftId;
    assert.notEqual(shiftA, shiftB);

    await t.test('assignment_creates_one_clean_status_and_bumps_only_the_shift', async () => {
      const assigned = await assignTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: operationId('assign_clean'),
        protocolVersion: 2,
        truckId: trucks.clean,
        expectedShiftRevision: 1,
      });
      assert.equal(assigned.replayed, false);
      assert.equal(assigned.result.assignment.truckId, trucks.clean);
      assert.equal(assigned.result.assignment.shiftId, shiftA);
      assert.equal(assigned.result.assignment.statusRevision, 1);
      assert.equal(assigned.result.assignment.cycleRevision, 1);
      assert.equal(assigned.result.assignment.ttnRevision, 1);
      assert.equal(assigned.result.assignment.stage, null);
      assert.equal(assigned.result.shift.shiftRevision, 2);

      const row = await statusRow(trucks.clean);
      assert.equal(row.shift_id, shiftA);
      assert.equal(Number(row.status_revision), 1);
      assert.equal(Number(row.cycle_revision), 1);
      assert.equal(Number(row.ttn_revision), 1);
      assert.equal(row.payload.onLine, true);
      assert.equal(row.payload.shiftId, shiftA);
      assert.equal(row.payload.arriveStatus ?? null, null);
      assert.equal(row.payload.lastLoadTimestamp ?? null, null);

      // Repeating the same assignment is an honest no-op: no second row, no
      // invented revision bump.
      const repeat = await assignTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: operationId('assign_clean_repeat'),
        protocolVersion: 2,
        truckId: trucks.clean,
        expectedShiftRevision: 2,
      });
      assert.equal(repeat.replayed, false);
      assert.equal(repeat.result.shift.shiftRevision, 2);
      assert.equal((await pool.query(
        'SELECT count(*)::int AS total FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2',
        [WORKSPACE, trucks.clean],
      )).rows[0].total, 1);

      // A stale shift revision never assigns.
      await expectError(assignTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: operationId('assign_stale'),
        protocolVersion: 2,
        truckId: trucks.other,
        expectedShiftRevision: 1,
      }), 'shift-changed', 409);
    });

    await t.test('a_second_assignment_names_the_other_shift_without_personal_data', async () => {
      const error = await expectError(assignTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftB,
        operationId: operationId('assign_other'),
        protocolVersion: 2,
        truckId: trucks.clean,
        expectedShiftRevision: 1,
      }), 'truck-assigned-to-other-shift', 409);
      assert.equal(error.details.truckId, trucks.clean);
      assert.equal(error.details.sourceShiftId, shiftA);
      assert.equal(error.details.objectId, object.a);
      assert.equal(error.details.workDate, workDate);
      assert.equal(error.details.shiftType, 'day');
      assert.equal(error.details.stage, null);
      // Only the whitelisted keys survive; nothing about people leaks.
      assert.deepEqual(Object.keys(error.details).sort(),
        ['objectId', 'shiftType', 'sourceShiftId', 'stage', 'truckId', 'workDate']);
    });

    await t.test('remove_requires_a_finished_cycle_and_no_open_detached_trip', async () => {
      await assignTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: operationId('assign_arrived'),
        protocolVersion: 2,
        truckId: trucks.arrived,
        expectedShiftRevision: await shiftRevision(shiftA),
      });
      const seeded = await seedStage(trucks.arrived, shiftA, 'arrive');
      const revision = await shiftRevision(shiftA);
      await expectError(removeTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: operationId('remove_unfinished'),
        protocolVersion: 2,
        truckId: trucks.arrived,
        expectedShiftRevision: revision,
        expectedStatusRevision: 1,
        expectedCycleRevision: seeded.cycle,
        expectedTtnRevision: seeded.ttn,
      }), 'truck-cycle-incomplete', 409);
      assert.ok(await statusRow(trucks.arrived), 'the refused remove keeps the assignment');

      // A stale status revision is a revision conflict, not a silent delete.
      await expectError(removeTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: operationId('remove_stale'),
        protocolVersion: 2,
        truckId: trucks.arrived,
        expectedShiftRevision: revision,
        expectedStatusRevision: 2,
        expectedCycleRevision: seeded.cycle,
        expectedTtnRevision: seeded.ttn,
      }), 'revision-conflict', 409);

      // A finished cycle can be removed; the status row is gone and the shift
      // revision moved by exactly one.
      const before = await shiftRevision(shiftA);
      const removed = await removeTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: operationId('remove_clean'),
        protocolVersion: 2,
        truckId: trucks.clean,
        expectedShiftRevision: before,
        expectedStatusRevision: 1,
        expectedCycleRevision: 1,
        expectedTtnRevision: 1,
      });
      assert.equal(removed.result.removed, true);
      assert.equal(removed.result.shift.shiftRevision, before + 1);
      assert.equal(await statusRow(trucks.clean), undefined);
      // Removing an assignment that is not there is a stable refusal.
      await expectError(removeTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: operationId('remove_absent'),
        protocolVersion: 2,
        truckId: trucks.clean,
        expectedShiftRevision: before + 1,
        expectedStatusRevision: 1,
        expectedCycleRevision: 1,
        expectedTtnRevision: 1,
      }), 'truck-not-on-shift', 409);
    });

    await t.test('a_legacy_off_line_row_is_revived_in_place', async () => {
      // The v1 `line.remove` keeps the row with `onLine:false`. That is not a
      // current assignment (a v2 remove deletes the row), so the v2 add must
      // revive the same row instead of refusing or creating a second one.
      const legacy = {
        id: trucks.other, shiftId: shiftB, onLine: false,
        arriveStatus: null, arriveTimestamp: null, arriveBy: null, loadedAfterArrive: false,
        lastLoadTimestamp: null, lastLoadBy: null, lastLoadLogId: null,
        ttnStatus: null, ttnBy: null, ttnLogId: null,
        cycleRevision: 3, ttnRevision: 2, removedAt: 1764000000000, removedBy: 'Legacy',
      };
      await pool.query(
        `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload,status_revision,cycle_revision,ttn_revision)
         VALUES($1,$2,$3,$4::jsonb,4,3,2)`,
        [WORKSPACE, trucks.other, shiftB, legacy],
      );
      const revision = await shiftRevision(shiftB);
      const revived = await assignTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftB,
        operationId: operationId('assign_revive'),
        protocolVersion: 2,
        truckId: trucks.other,
        expectedShiftRevision: revision,
      });
      assert.equal(revived.result.assignment.shiftId, shiftB);
      assert.equal(revived.result.assignment.statusRevision, 5);
      assert.equal(revived.result.assignment.cycleRevision, 1);
      assert.equal(revived.result.assignment.ttnRevision, 1);
      assert.equal(revived.result.assignment.stage, null);
      assert.equal(revived.result.shift.shiftRevision, revision + 1);
      const rows = (await pool.query(
        `SELECT shift_id,status_revision,cycle_revision,ttn_revision,payload
           FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2`,
        [WORKSPACE, trucks.other],
      )).rows;
      assert.equal(rows.length, 1, 'one row per truck is a database invariant');
      assert.equal(rows[0].shift_id, shiftB);
      assert.equal(Number(rows[0].status_revision), 5);
      assert.equal(Number(rows[0].cycle_revision), 1);
      assert.equal(Number(rows[0].ttn_revision), 1);
      assert.equal(rows[0].payload.onLine, true);
      assert.equal(rows[0].payload.removedAt, undefined);
    });

    await t.test('force_transfer_requires_confirmation_and_current_revisions', async () => {
      const destinationRevision = await shiftRevision(shiftB);
      const body = transferBody(shiftA, shiftB, trucks.arrived, {
        expectedSourceShiftRevision: await shiftRevision(shiftA),
        expectedDestinationShiftRevision: destinationRevision,
        expectedCycleRevision: Number((await statusRow(trucks.arrived)).cycle_revision),
      });
      await expectError(forceTransferTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE, ...body, confirmTransfer: false,
      }), 'force-transfer-confirmation-required', 409);
      // A destination revision that is not the current one is refused before
      // anything moves; the number itself is never hardcoded, because the
      // previous tests decide how far the shift has moved.
      await expectError(forceTransferTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE, ...body, expectedDestinationShiftRevision: destinationRevision + 1,
      }), 'revision-conflict', 409);
      await expectError(forceTransferTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE, ...body, expectedStatusRevision: 7,
      }), 'revision-conflict', 409);
      // A source shift that does not own the truck cannot transfer it, even
      // when both revisions are current: the refusal is about ownership, not
      // about a stale counter.
      await expectError(forceTransferTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE, ...body,
        sourceShiftId: shiftB,
        destinationShiftId: shiftA,
        expectedSourceShiftRevision: await shiftRevision(shiftB),
        expectedDestinationShiftRevision: await shiftRevision(shiftA),
      }), 'truck-not-on-shift', 409);
      // The right is senior-only: a foreman is refused before any mutation.
      await expectError(forceTransferTruck(pool, actors[ids.foreman], {
        workspaceId: WORKSPACE, ...body,
      }), 'forbidden', 403);
      assert.equal(await statusRow(trucks.arrived).then(row => row.shift_id), shiftA);
      assert.deepEqual(await detachedRows(trucks.arrived), []);
    });

    await t.test('force_transfer_detaches_the_saved_arrival_stage', async () => {
      const sourceRevision = await shiftRevision(shiftA);
      const destinationRevision = await shiftRevision(shiftB);
      const before = await statusRow(trucks.arrived);
      const body = transferBody(shiftA, shiftB, trucks.arrived, {
        expectedSourceShiftRevision: sourceRevision,
        expectedDestinationShiftRevision: destinationRevision,
        expectedStatusRevision: Number(before.status_revision),
        expectedCycleRevision: Number(before.cycle_revision),
        expectedTtnRevision: Number(before.ttn_revision),
      });
      const transferred = await forceTransferTruck(pool, actors[ids.senior], {workspaceId: WORKSPACE, ...body});
      assert.equal(transferred.replayed, false);
      assert.equal(transferred.result.truckId, trucks.arrived);
      assert.equal(transferred.result.sourceShiftId, shiftA);
      assert.equal(transferred.result.destinationShiftId, shiftB);
      assert.equal(transferred.result.detachedTrip.state, 'open');
      assert.equal(transferred.result.detachedTrip.stage, 'load');
      assert.equal(transferred.result.detachedTrip.cycleRevision, 1);
      assert.equal(transferred.result.sourceShift.shiftRevision, sourceRevision + 1);
      assert.equal(transferred.result.destinationShift.shiftRevision, destinationRevision + 1);

      const rows = await detachedRows(trucks.arrived);
      assert.equal(rows.length, 1);
      const detached = rows[0];
      assert.equal(detached.source_shift_id, shiftA);
      assert.equal(detached.destination_shift_id, shiftB);
      assert.equal(detached.state, 'open');
      assert.equal(detached.stage, 'load');
      assert.equal(Number(detached.cycle_revision), 1);
      assert.equal(Number(detached.source_status_revision), Number(before.status_revision));
      assert.equal(Number(detached.source_ttn_revision), Number(before.ttn_revision));
      // The snapshot keeps the exact saved cycle, not a rewritten copy.
      assert.equal(detached.payload.arriveStatus, '08:15');
      assert.equal(Number(detached.payload.arriveTimestamp), ARRIVE_TS);
      assert.equal(Number(detached.payload.cycleRevision), Number(before.cycle_revision));
      assert.equal(detached.detached_by_uid, ids.senior);
      assert.equal(detached.completion_operation_id, null);

      // The destination gets a clean assignment with a fresh cycle.
      const after = await statusRow(trucks.arrived);
      assert.equal(after.shift_id, shiftB);
      assert.equal(Number(after.status_revision), Number(before.status_revision) + 1);
      assert.equal(Number(after.cycle_revision), 1);
      assert.equal(Number(after.ttn_revision), 1);
      assert.equal(after.payload.shiftId, shiftB);
      assert.equal(after.payload.onLine, true);
      assert.equal(after.payload.arriveStatus ?? null, null);
      assert.equal(after.payload.lastLoadTimestamp ?? null, null);
      assert.equal(after.payload.loadedAfterArrive, false);

      // Both lines show the open trip; a snapshot is the read contract §5.1.
      for (const shiftId of [shiftA, shiftB]) {
        const snapshot = await readShiftSnapshot(pool, actors[ids.senior], {workspaceId: WORKSPACE, shiftId});
        const listed = snapshot.detachedOpenTrips.filter(item => item.truckId === trucks.arrived);
        assert.equal(listed.length, 1, `shift ${shiftId} lists the open detached trip`);
        assert.equal(listed[0].cycleId, detached.cycle_id);
        assert.equal(listed[0].stage, 'load');
        assert.equal(listed[0].sourceShift.shiftId, shiftA);
        assert.equal(listed[0].destinationShift.shiftId, shiftB);
      }

      // An identical retry is a replay, never a second detached row or bump.
      const replay = await forceTransferTruck(pool, actors[ids.senior], {workspaceId: WORKSPACE, ...body});
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, transferred.result);
      assert.equal((await detachedRows(trucks.arrived)).length, 1);
      assert.equal(await shiftRevision(shiftA), sourceRevision + 1);

      // While the trip is open, neither a transfer nor a remove may run.
      await expectError(forceTransferTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        ...transferBody(shiftB, shiftA, trucks.arrived, {
          expectedSourceShiftRevision: await shiftRevision(shiftB),
          expectedDestinationShiftRevision: await shiftRevision(shiftA),
        }),
      }), 'truck-detached-trip-open', 409);
      await expectError(removeTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftB,
        operationId: operationId('remove_detached'),
        protocolVersion: 2,
        truckId: trucks.arrived,
        expectedShiftRevision: await shiftRevision(shiftB),
        expectedStatusRevision: Number(after.status_revision),
        expectedCycleRevision: 1,
        expectedTtnRevision: 1,
      }), 'truck-detached-trip-open', 409);
    });

    await t.test('force_transfer_moves_a_finished_cycle_and_detaches_a_pending_ttn', async () => {
      // A finished cycle is a plain atomic move: no detached row at all.
      await assignTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: operationId('assign_finished'),
        protocolVersion: 2,
        truckId: trucks.stale,
        expectedShiftRevision: await shiftRevision(shiftA),
      });
      const moved = await forceTransferTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        ...transferBody(shiftA, shiftB, trucks.stale, {
          expectedSourceShiftRevision: await shiftRevision(shiftA),
          expectedDestinationShiftRevision: await shiftRevision(shiftB),
        }),
      });
      assert.equal(moved.result.detachedTrip, null);
      assert.deepEqual(await detachedRows(trucks.stale), []);
      assert.equal((await statusRow(trucks.stale)).shift_id, shiftB);

      // Loaded but not yet collected: the cycle is not finished, so the stage is
      // the ТТН step.
      await assignTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: operationId('assign_loaded'),
        protocolVersion: 2,
        truckId: trucks.loaded,
        expectedShiftRevision: await shiftRevision(shiftA),
      });
      const seeded = await seedStage(trucks.loaded, shiftA, 'ttn');
      const before = await statusRow(trucks.loaded);
      const detached = await forceTransferTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        ...transferBody(shiftA, shiftB, trucks.loaded, {
          expectedSourceShiftRevision: await shiftRevision(shiftA),
          expectedDestinationShiftRevision: await shiftRevision(shiftB),
          expectedStatusRevision: Number(before.status_revision),
          expectedCycleRevision: Number(before.cycle_revision),
          expectedTtnRevision: Number(before.ttn_revision),
        }),
      });
      assert.equal(detached.result.detachedTrip.stage, 'ttn');
      const [row] = await detachedRows(trucks.loaded);
      assert.equal(row.stage, 'ttn');
      assert.equal(row.payload.ttnStatus, 'pending');
      assert.equal(row.payload.lastLoadLogId, seeded.logId);
      assert.equal((await statusRow(trucks.loaded)).payload.ttnStatus ?? null, null);
    });

    await t.test('concurrent_force_transfer_has_exactly_one_winner', async () => {
      await assignTruck(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: operationId('assign_race'),
        protocolVersion: 2,
        truckId: trucks.race,
        expectedShiftRevision: await shiftRevision(shiftA),
      });
      const seeded = await seedStage(trucks.race, shiftA, 'arrive');
      const sourceRevision = await shiftRevision(shiftA);
      const destinationRevision = await shiftRevision(shiftB);
      const status = await statusRow(trucks.race);
      const forward = transferBody(shiftA, shiftB, trucks.race, {
        expectedSourceShiftRevision: sourceRevision,
        expectedDestinationShiftRevision: destinationRevision,
        expectedStatusRevision: Number(status.status_revision),
        expectedCycleRevision: seeded.cycle,
        expectedTtnRevision: seeded.ttn,
      });
      const backward = transferBody(shiftB, shiftA, trucks.race, {
        expectedSourceShiftRevision: destinationRevision,
        expectedDestinationShiftRevision: sourceRevision,
        expectedStatusRevision: Number(status.status_revision),
        expectedCycleRevision: seeded.cycle,
        expectedTtnRevision: seeded.ttn,
      });
      const results = await Promise.allSettled([
        forceTransferTruck(pool, actors[ids.senior], {workspaceId: WORKSPACE, ...forward}),
        forceTransferTruck(pool, actors[ids.senior], {workspaceId: WORKSPACE, ...backward}),
      ]);
      const winners = results.filter(item => item.status === 'fulfilled');
      const losers = results.filter(item => item.status === 'rejected');
      assert.equal(winners.length, 1, 'exactly one transfer wins');
      assert.equal(losers.length, 1, 'exactly one transfer is refused');
      assert.equal(losers[0].reason.name, 'V2Error');
      assert.ok(
        ['truck-detached-trip-open', 'truck-not-on-shift', 'transfer-context-changed', 'revision-conflict']
          .includes(losers[0].reason.code),
        `unexpected loser code ${losers[0].reason.code}`,
      );
      const rows = await detachedRows(trucks.race);
      assert.equal(rows.length, 1, 'one truck never accumulates two open cycles');
      assert.equal(rows[0].state, 'open');
      assert.equal(rows[0].source_shift_id, winners[0].value.result.sourceShiftId);
    });
  } finally {
    await pool.end();
  }
});
