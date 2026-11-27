import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrationsThrough} from './helpers/isolated-db.mjs';
import {loadActor} from '../src/shift-access-v2.mjs';
import {createShift} from '../src/shift-members-v2.mjs';
import {assignTruck} from '../src/shift-trucks-v2.mjs';
import {forceTransferTruck, completeDetachedTrip} from '../src/shift-transfer-v2.mjs';
import {submitLineOperationV2} from '../src/line-store-v2.mjs';
import {reportVersion, submitReport} from '../src/report-store.mjs';
import {recordLineHistory} from '../src/history-store.mjs';
import {readArchiveRevision, readLatestFinalizedArchive} from '../src/archive-latest.mjs';
import {confirmShiftMaterial, finishShiftClose, prepareShiftClose} from '../src/shift-close-v2.mjs';

// Derived effects and source attribution (design §4.6, §8, §10.2, §11, §12,
// plan Task 27).
//
// Two shifts of the SAME object and work date (day A, night B) exist at the
// same time. The root proves with rows, not with intentions:
//   1. the material marker of A is untouched by B's trips, report edit and
//      close; `readLatestFinalizedArchive(A)` returns A's latest finalized
//      revision and its exact sha256, while an explicit revision read is
//      read-only and never moves the default pointer;
//   2. `line_logs` and `line_history` rows carry the source `shift_id`, and a
//      report edit in B changes no row of A (counts and checksums);
//   3. a completed detached A→B trip is written once into A and never appears
//      in B, so both report and material of B stay untouched by it;
//   4. a trap snapshot of B (shift, statuses, logs, history, marker, receipts,
//      archive series/revisions) is byte-identical before and after every A
//      phase — prepare, explicit revision read, material, finish.
//
// Numbers are read from the actual rows; nothing is hardcoded
// (docs/opyt-oshibok.md, lesson 50.1).

const WORKSPACE = 'main_workspace';

function moscowDate(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ms);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

test('v2 derived effects stay attributed to the source shift', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const pool = new pg.Pool({connectionString: process.env.TEST_DATABASE_URL, max: 5});
  pool.on('error', () => {});
  const prefix = 'derived_' + randomUUID().replaceAll('-', '');
  const ids = {
    admin: prefix + '_admin',
    senior: prefix + '_senior',
    foreman: prefix + '_foreman',
  };
  const objectId = prefix + '_object';
  const trucks = {
    a: prefix + '_truck_a',
    detached: prefix + '_truck_detached',
    b: prefix + '_truck_b',
  };
  const workDate = moscowDate();

  const actors = {};
  let operation = 0;
  const nextOperation = label => `${prefix}_${label}_${++operation}`;

  const shiftRow = async shiftId => (await pool.query(
    'SELECT * FROM shifts WHERE workspace_id=$1 AND shift_id=$2',
    [WORKSPACE, shiftId],
  )).rows[0];
  const shiftRevision = async shiftId => Number((await shiftRow(shiftId)).revision);
  const statusRow = async truckId => (await pool.query(
    `SELECT shift_id,status_revision,cycle_revision,ttn_revision,payload
       FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2`,
    [WORKSPACE, truckId],
  )).rows[0];
  const logsFor = async shiftId => (await pool.query(
    'SELECT * FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id COLLATE "C"',
    [WORKSPACE, shiftId],
  )).rows;
  const historyFor = async shiftId => (await pool.query(
    'SELECT * FROM line_history WHERE workspace_id=$1 AND shift_id=$2 ORDER BY action_id COLLATE "C"',
    [WORKSPACE, shiftId],
  )).rows;
  const markerFor = async shiftId => (await pool.query(
    `SELECT material_id,source_archive_revision,volume,revision,confirmed_by_uid
       FROM shift_material_markers WHERE workspace_id=$1 AND shift_id=$2`,
    [WORKSPACE, shiftId],
  )).rows[0];
  const seriesFor = async archiveId => (await pool.query(
    `SELECT source_shift_id,latest_finalized_revision,latest_finalized_sha256,series_revision
       FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2`,
    [WORKSPACE, archiveId],
  )).rows[0];
  const revisionsFor = async archiveId => (await pool.query(
    `SELECT archive_revision,payload_sha256,previous_revision,previous_sha256
       FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2
      ORDER BY archive_revision`,
    [WORKSPACE, archiveId],
  )).rows;
  // One shift's whole derived surface. A trap comparison uses this object.
  const snapshot = async shiftId => ({
    shift: await shiftRow(shiftId),
    statuses: (await pool.query(
      `SELECT * FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2
        ORDER BY truck_id COLLATE "C"`,
      [WORKSPACE, shiftId],
    )).rows,
    logs: await logsFor(shiftId),
    history: await historyFor(shiftId),
    marker: (await pool.query(
      'SELECT * FROM shift_material_markers WHERE workspace_id=$1 AND shift_id=$2',
      [WORKSPACE, shiftId],
    )).rows,
    receipts: (await pool.query(
      `SELECT operation_id,uid,request_hash,shift_id,result
         FROM shift_operation_receipts WHERE workspace_id=$1 AND shift_id=$2
        ORDER BY operation_id COLLATE "C"`,
      [WORKSPACE, shiftId],
    )).rows,
    series: await seriesFor(`closed_${shiftId}`),
    revisions: await revisionsFor(`closed_${shiftId}`),
  });

  const lineCommand = async ({shiftId, truckId, type, createdAt, ...fields}) => {
    const row = await statusRow(truckId);
    return submitLineOperationV2(pool, actors[ids.senior], {
      workspaceId: WORKSPACE,
      shiftId,
      operationId: nextOperation(`${type}_${truckId.slice(-6)}`),
      protocolVersion: 2,
      type,
      truckId,
      expectedShiftRevision: await shiftRevision(shiftId),
      expectedStatusRevision: Number(row.status_revision),
      expectedCycleRevision: Number(row.cycle_revision),
      expectedTtnRevision: Number(row.ttn_revision),
      createdAt,
      cycleMinutes: 30,
      ...fields,
    });
  };
  // One complete ordinary cycle: arrive → load → collected TTN. The only
  // derived row it leaves is the load log with the truck's default volume.
  const fullCycle = async (shiftId, truckId) => {
    const arrivedAt = Date.now();
    await lineCommand({
      shiftId, truckId, type: 'arrive', createdAt: arrivedAt, wantArrived: true,
    });
    const arrived = await statusRow(truckId);
    const loadedAt = Number(arrived.payload.arriveTimestamp) + 1;
    await lineCommand({shiftId, truckId, type: 'load', createdAt: loadedAt});
    await lineCommand({
      shiftId, truckId, type: 'ttn', createdAt: loadedAt + 1, collect: true,
    });
  };
  // A real history row through the production writer, so its `shift_id` is
  // written by the same code path the legacy line uses.
  const historyRow = async (shiftId, truckId) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await recordLineHistory(client, {
        workspaceId: WORKSPACE,
        uid: ids.senior,
        op: {
          id: `${prefix}_history_${shiftId.slice(-8)}`,
          shiftId,
          truckId,
          type: 'reset',
          createdAt: Date.now(),
        },
        before: {shiftId, truckId, cycleRevision: 1, ttnRevision: 0},
        result: {status: {shiftId, truckId, cycleRevision: 2, ttnRevision: 0}, log: null},
        profile: {email: `${ids.senior}@example.test`, display_name: 'Derived senior'},
        shift: {objectId, objectName: 'Object derived'},
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };
  const prepare = (shiftId, overrides = {}) => prepareShiftClose(pool, actors[ids.senior], {
    workspaceId: WORKSPACE,
    shiftId,
    operationId: nextOperation('prepare'),
    protocolVersion: 2,
    expectedShiftRevision: 1,
    ...overrides,
  });
  const confirmMaterial = (shiftId, overrides = {}) => confirmShiftMaterial(pool, actors[ids.senior], {
    workspaceId: WORKSPACE,
    shiftId,
    operationId: nextOperation('material'),
    protocolVersion: 2,
    closeToken: 'missing_token_000000',
    materialId: `material_${shiftId.slice(-8)}`,
    volume: 0,
    expectedShiftRevision: 1,
    expectedArchiveRevision: 1,
    expectedMaterialMarkerRevision: null,
    ...overrides,
  });
  const finish = (shiftId, overrides = {}) => finishShiftClose(pool, actors[ids.senior], {
    workspaceId: WORKSPACE,
    shiftId,
    operationId: nextOperation('finish'),
    protocolVersion: 2,
    closeToken: 'missing_token_000000',
    expectedShiftRevision: 1,
    expectedArchiveRevision: 1,
    expectedMaterialMarkerRevision: null,
    ...overrides,
  });

  let shiftA;
  let shiftB;
  try {
    await applyMigrationsThrough(29);
    await pool.query('INSERT INTO workspaces(id) VALUES ($1) ON CONFLICT(id) DO NOTHING', [WORKSPACE]);
    for (const [uid, name, role] of [
      [ids.admin, 'Derived admin', 'admin'],
      [ids.senior, 'Derived senior', 'senior_foreman'],
      [ids.foreman, 'Derived foreman', 'foreman'],
    ]) {
      await pool.query(
        'INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,$4,$5)',
        [uid, `${uid}@example.test`, name, role, 'active'],
      );
    }
    await pool.query(
      'INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',
      [WORKSPACE, objectId, {id: objectId, name: 'Object derived'}],
    );
    for (const truckId of Object.values(trucks)) {
      await pool.query(
        'INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)',
        [WORKSPACE, truckId, {
          id: truckId, brand: 'Камаз', number: truckId.slice(-4), defaultVol: 10, isGAI: false,
        }],
      );
    }
    for (const role of ['senior_foreman', 'foreman']) {
      for (const action of [
        'start_shift', 'close_shift', 'edit_line', 'tab_line', 'manage_trucks',
        'action_arrive', 'action_load', 'action_ttn', 'line_timer_reset',
        'manage_shift_members', 'edit_logs',
      ]) {
        await pool.query(
          `INSERT INTO role_permissions(role,action,allowed) VALUES($1,$2,true)
           ON CONFLICT(role,action) DO UPDATE SET allowed=true`,
          [role, action],
        );
      }
    }
    for (const uid of Object.values(ids)) actors[uid] = await loadActor(pool, uid);

    const create = async shiftType => (await createShift(pool, actors[ids.senior], {
      workspaceId: WORKSPACE,
      operationId: nextOperation(`create_${shiftType}`),
      protocolVersion: 2,
      objectId,
      workDate,
      shiftType,
      cycleMinutes: 30,
    })).result.shift.shiftId;
    shiftA = await create('day');
    shiftB = await create('night');

    // A: one ordinary trip and one truck that will be force-transferred while
    // its cycle is unfinished. The detached trip belongs to A forever.
    await assignTruck(pool, actors[ids.senior], {
      workspaceId: WORKSPACE,
      shiftId: shiftA,
      truckId: trucks.a,
      operationId: nextOperation('assign_a'),
      protocolVersion: 2,
      expectedShiftRevision: await shiftRevision(shiftA),
    });
    await fullCycle(shiftA, trucks.a);
    await assignTruck(pool, actors[ids.senior], {
      workspaceId: WORKSPACE,
      shiftId: shiftA,
      truckId: trucks.detached,
      operationId: nextOperation('assign_detached'),
      protocolVersion: 2,
      expectedShiftRevision: await shiftRevision(shiftA),
    });
    await lineCommand({
      shiftId: shiftA, truckId: trucks.detached, type: 'arrive',
      createdAt: Date.now(), wantArrived: true,
    });
    const beforeTransfer = await statusRow(trucks.detached);
    const transferred = await forceTransferTruck(pool, actors[ids.senior], {
      workspaceId: WORKSPACE,
      operationId: nextOperation('transfer_detached'),
      protocolVersion: 2,
      sourceShiftId: shiftA,
      destinationShiftId: shiftB,
      truckId: trucks.detached,
      expectedSourceShiftRevision: await shiftRevision(shiftA),
      expectedDestinationShiftRevision: await shiftRevision(shiftB),
      expectedStatusRevision: Number(beforeTransfer.status_revision),
      expectedCycleRevision: Number(beforeTransfer.cycle_revision),
      expectedTtnRevision: Number(beforeTransfer.ttn_revision),
      confirmTransfer: true,
    });
    assert.equal(transferred.result.detachedTrip.state, 'open');
    const cycleId = transferred.result.detachedTrip.cycleId;

    await historyRow(shiftA, trucks.a);
    await historyRow(shiftB, trucks.b);

    // B: its own ordinary trip, so its derived rows exist before A closes.
    await assignTruck(pool, actors[ids.senior], {
      workspaceId: WORKSPACE,
      shiftId: shiftB,
      truckId: trucks.b,
      operationId: nextOperation('assign_b'),
      protocolVersion: 2,
      expectedShiftRevision: await shiftRevision(shiftB),
    });
    await fullCycle(shiftB, trucks.b);

    await t.test('a report edit in B leaves every A row and the A history untouched', async () => {
      const aLogs = await logsFor(shiftA);
      const aHistory = await historyFor(shiftA);
      assert.equal(aLogs.length, 1, 'A holds exactly its own trip');
      assert.ok(aLogs.every(row => row.shift_id === shiftA), 'every A log carries the A shift id');
      assert.ok(aHistory.every(row => row.shift_id === shiftA), 'every A history row carries the A shift id');

      const bLog = (await logsFor(shiftB))[0];
      assert.equal(bLog.shift_id, shiftB);
      const edited = await submitReport(pool, ids.senior, {
        id: `report_${prefix}_b_edit`,
        type: 'report.update',
        logId: bLog.log_id,
        expected: reportVersion(bLog.payload),
        data: {volume: 12, timeStr: '12:30', comment: 'edited in B'},
      });
      assert.equal(edited.result.status.shiftId, shiftB);
      const bAudit = (await pool.query(
        `SELECT before_data,after_data FROM workspace_service_audit
          WHERE workspace_id=$1 AND operation_id=$2`,
        [WORKSPACE, `report_${prefix}_b_edit`],
      )).rows[0];
      assert.equal(bAudit.before_data.shiftId, shiftB);
      assert.equal(bAudit.after_data.shiftId, shiftB);

      assert.equal((await logsFor(shiftB))[0].shift_id, shiftB);
      assert.deepEqual(await logsFor(shiftA), aLogs, 'B edit changes no A log byte');
      assert.deepEqual(await historyFor(shiftA), aHistory, 'B edit changes no A history byte');
      assert.equal(digest(await logsFor(shiftA)), digest(aLogs));
    });

    await t.test('a completed detached A→B trip is written once into A and never into B', async () => {
      const bLogs = await logsFor(shiftB);
      const bHistory = await historyFor(shiftB);
      const aBefore = await logsFor(shiftA);
      const completed = await completeDetachedTrip(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        sourceShiftId: shiftA,
        cycleId,
        operationId: nextOperation('complete_detached'),
        protocolVersion: 2,
        truckId: trucks.detached,
        destinationShiftId: shiftB,
        type: 'load',
        createdAt: Date.now(),
        expectedSourceShiftRevision: await shiftRevision(shiftA),
        expectedDestinationShiftRevision: await shiftRevision(shiftB),
        expectedDetachedCycleRevision: 1,
      });
      assert.equal(completed.result.state, 'completed');
      assert.equal(completed.result.sourceShiftId, shiftA);

      const aAfter = await logsFor(shiftA);
      assert.equal(aAfter.length, aBefore.length + 1, 'the detached trip is one new A row');
      const detachedLog = aAfter.find(row => row.truck_id === trucks.detached);
      assert.ok(detachedLog, 'the detached trip lands in the source shift');
      assert.equal(detachedLog.shift_id, shiftA);
      assert.equal(detachedLog.payload.shiftId, shiftA);
      assert.equal(Number(detachedLog.payload.volume), 10);
      // Exactly one row with this log id in the whole workspace: no copy in B.
      const copies = Number((await pool.query(
        'SELECT count(*)::int AS total FROM line_logs WHERE workspace_id=$1 AND log_id=$2',
        [WORKSPACE, detachedLog.log_id],
      )).rows[0].total);
      assert.equal(copies, 1);
      assert.deepEqual(await logsFor(shiftB), bLogs, 'B gets no detached row');
      assert.deepEqual(await historyFor(shiftB), bHistory);
      assert.ok((await logsFor(shiftB)).every(row => row.truck_id !== trucks.detached));
    });

    // B's trap is frozen after all B-side work and before the first A phase.
    const trapB = await snapshot(shiftB);
    const trapBDigest = digest(trapB);
    let closeTokenA;
    let shiftRevisionA;
    let archiveTotalA;

    await t.test('prepare, explicit revision read, material and finish of A never touch B', async () => {
      const before = await shiftRow(shiftA);
      const prepared = await prepare(shiftA, {expectedShiftRevision: Number(before.revision)});
      assert.equal(prepared.result.phase, 'prepared');
      closeTokenA = prepared.result.closeToken;
      shiftRevisionA = prepared.result.shiftRevision;
      assert.equal(Number((await shiftRow(shiftA)).revision), shiftRevisionA);
      assert.deepEqual(await snapshot(shiftB), trapB, 'prepare A changes no B row');
      assert.equal(digest(await snapshot(shiftB)), trapBDigest);

      // The prepared archive is not published yet: the default resolver has no
      // latest finalized revision to return.
      assert.equal(await readLatestFinalizedArchive(pool, WORKSPACE, `closed_${shiftA}`), null);
      const revisionA = await readArchiveRevision(pool, WORKSPACE, `closed_${shiftA}`, 1);
      assert.ok(revisionA);
      archiveTotalA = Number(revisionA.payload.totalVolume);
      assert.equal(archiveTotalA, 20, 'A material counts its own trip and the detached one');
      assert.equal((await seriesFor(`closed_${shiftA}`)).latest_finalized_revision, null);
      assert.deepEqual(await snapshot(shiftB), trapB, 'explicit revision read is read-only for B');
      // The explicit read did not move A's own default pointer either.
      assert.equal((await seriesFor(`closed_${shiftA}`)).latest_finalized_revision, null);
      assert.equal(await readLatestFinalizedArchive(pool, WORKSPACE, `closed_${shiftA}`), null);

      const material = await confirmMaterial(shiftA, {
        closeToken: closeTokenA,
        volume: archiveTotalA,
        expectedShiftRevision: shiftRevisionA,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: null,
      });
      assert.equal(material.result.materialMarkerRevision, 1);
      assert.equal(Number((await markerFor(shiftA)).volume), archiveTotalA);
      assert.equal(await markerFor(shiftB), undefined, 'A material writes no B marker');
      assert.deepEqual(await snapshot(shiftB), trapB, 'material A changes no B row');

      const finished = await finish(shiftA, {
        closeToken: closeTokenA,
        expectedShiftRevision: shiftRevisionA,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 1,
      });
      assert.equal(finished.result.phase, 'closed');
      assert.deepEqual(await snapshot(shiftB), trapB, 'finish A changes no B row');
      assert.equal(digest(await snapshot(shiftB)), trapBDigest);

      const series = await seriesFor(`closed_${shiftA}`);
      assert.equal(Number(series.latest_finalized_revision), 1);
      const latest = await readLatestFinalizedArchive(pool, WORKSPACE, `closed_${shiftA}`);
      assert.ok(latest, 'the default resolver returns the latest finalized A revision');
      assert.equal(latest.sourceShiftId, shiftA);
      assert.equal(latest.revision, 1);
      assert.equal(latest.sha256, series.latest_finalized_sha256);
      assert.equal(latest.sha256, revisionA.sha256);
      assert.equal(Number((await markerFor(shiftA)).source_archive_revision), latest.revision);
    });

    const trapA = await snapshot(shiftA);
    const trapADigest = digest(trapA);
    const latestABefore = await readLatestFinalizedArchive(pool, WORKSPACE, `closed_${shiftA}`);

    await t.test('closing B leaves the A marker, archive pointer and derived rows intact', async () => {
      const prepared = await prepare(shiftB, {expectedShiftRevision: await shiftRevision(shiftB)});
      assert.equal(prepared.result.phase, 'prepared');
      assert.deepEqual(await snapshot(shiftA), trapA, 'prepare B changes no A row');

      const revisionB = await readArchiveRevision(pool, WORKSPACE, `closed_${shiftB}`, 1);
      const totalB = Number(revisionB.payload.totalVolume);
      assert.equal(totalB, 12, 'B material is the edited B trip only');
      const material = await confirmMaterial(shiftB, {
        closeToken: prepared.result.closeToken,
        volume: totalB,
        expectedShiftRevision: prepared.result.shiftRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: null,
      });
      assert.equal(material.result.materialMarkerRevision, 1);
      assert.deepEqual(await snapshot(shiftA), trapA, 'material B changes no A row');

      await finish(shiftB, {
        closeToken: prepared.result.closeToken,
        expectedShiftRevision: prepared.result.shiftRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 1,
      });
      assert.deepEqual(await snapshot(shiftA), trapA, 'finish B changes no A row');
      assert.equal(digest(await snapshot(shiftA)), trapADigest);

      // Two independent markers and two independent archives: B's close created
      // its own rows and reused none of A's.
      assert.equal(Number((await markerFor(shiftB)).volume), totalB);
      assert.equal(Number((await markerFor(shiftA)).volume), archiveTotalA);
      assert.notEqual((await markerFor(shiftA)).material_id, (await markerFor(shiftB)).material_id);
      assert.equal(Number((await seriesFor(`closed_${shiftB}`)).latest_finalized_revision), 1);
      const latestAAfter = await readLatestFinalizedArchive(pool, WORKSPACE, `closed_${shiftA}`);
      assert.equal(latestAAfter.sha256, latestABefore.sha256);
      assert.equal(latestAAfter.revision, latestABefore.revision);
      assert.equal(Number((await seriesFor(`closed_${shiftA}`)).latest_finalized_revision), 1);
    });
  } finally {
    await pool.end();
  }
});
