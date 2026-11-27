import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrationsThrough} from './helpers/isolated-db.mjs';
import {loadActor} from '../src/shift-access-v2.mjs';
import {
  addShiftMember, changeShiftObject, createShift, removeShiftMember,
} from '../src/shift-members-v2.mjs';
import {assignTruck, removeTruck} from '../src/shift-trucks-v2.mjs';
import {forceTransferTruck} from '../src/shift-transfer-v2.mjs';
import {submitLineOperationV2} from '../src/line-store-v2.mjs';
import {reportVersion, submitReport} from '../src/report-store.mjs';
import {historyOperation, readLineHistory, recordLineHistory} from '../src/history-store.mjs';
import {readArchiveRevision} from '../src/archive-latest.mjs';
import {readShiftSnapshot} from '../src/shift-read-v2.mjs';
import {confirmShiftMaterial, finishShiftClose, prepareShiftClose} from '../src/shift-close-v2.mjs';

// Workspace query isolation (design §12, plan Task 28).
//
// Two shifts of the SAME object and work date exist at once: A (day) and B
// (night). Every operation A performs is followed by a byte-level trap check of
// B: the whole shift-scoped surface is serialized to canonical JSON, hashed with
// SHA-256 and compared with the snapshot taken before the first A command.
//
// The trap covers `shifts`, `shift_members`, `line_truck_statuses`, `line_logs`,
// `line_history`, `shift_operation_receipts`, `detached_open_trips`,
// `shift_material_markers` and the archive series/revisions of B. Nothing is
// hardcoded: revisions, counters and the archive volume are read from the rows
// the production writers just created (docs/opyt-oshibok.md, lesson 50.1).
//
// `readLineHistory` is a workspace-wide catalog by design (every row carries its
// own `shift_id`, explicit LIMIT 300), so the isolation check for it is exact
// per-row attribution: no row of A is returned as B and vice versa. The
// shift-scoped read is `readShiftSnapshot`, which must never contain a B row.

const WORKSPACE = 'main_workspace';

function moscowDate(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ms);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// Deterministic bytes: object keys are sorted at every level, arrays keep their
// order. Dates/Buffers keep the JSON.stringify representation, which is stable
// for unchanged rows.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

test('v2 queries keep every shift inside its own rows', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const pool = new pg.Pool({connectionString: process.env.TEST_DATABASE_URL, max: 5});
  pool.on('error', () => {});
  const prefix = 'iso_' + randomUUID().replaceAll('-', '');
  const ids = {admin: prefix + '_admin', foreman: prefix + '_foreman'};
  const objectId = prefix + '_object';
  const otherObjectId = prefix + '_object_other';
  const trucks = {a: prefix + '_truck_a', b: prefix + '_truck_b', extra: prefix + '_truck_extra'};
  const workDate = moscowDate();

  let operation = 0;
  const nextOperation = label => `${prefix}_${label}_${++operation}`;
  let actors = {};

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
  const rows = async (sql, params) => (await pool.query(sql, params)).rows;

  // One shift's whole scoped surface. The trap compares this object, not intent.
  const snapshot = async shiftId => ({
    shift: await rows('SELECT * FROM shifts WHERE workspace_id=$1 AND shift_id=$2', [WORKSPACE, shiftId]),
    members: await rows(
      'SELECT * FROM shift_members WHERE workspace_id=$1 AND shift_id=$2 ORDER BY uid COLLATE "C"',
      [WORKSPACE, shiftId],
    ),
    statuses: await rows(
      `SELECT * FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2
        ORDER BY truck_id COLLATE "C"`,
      [WORKSPACE, shiftId],
    ),
    logs: await rows(
      'SELECT * FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id COLLATE "C"',
      [WORKSPACE, shiftId],
    ),
    history: await rows(
      'SELECT * FROM line_history WHERE workspace_id=$1 AND shift_id=$2 ORDER BY action_id COLLATE "C"',
      [WORKSPACE, shiftId],
    ),
    receipts: await rows(
      `SELECT operation_id,uid,request_hash,shift_id,result
         FROM shift_operation_receipts WHERE workspace_id=$1 AND shift_id=$2
        ORDER BY operation_id COLLATE "C"`,
      [WORKSPACE, shiftId],
    ),
    detached: await rows(
      `SELECT * FROM detached_open_trips WHERE workspace_id=$1
          AND (source_shift_id=$2 OR destination_shift_id=$2)
        ORDER BY cycle_id COLLATE "C"`,
      [WORKSPACE, shiftId],
    ),
    markers: await rows(
      'SELECT * FROM shift_material_markers WHERE workspace_id=$1 AND shift_id=$2',
      [WORKSPACE, shiftId],
    ),
    series: await rows(
      'SELECT * FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2',
      [WORKSPACE, `closed_${shiftId}`],
    ),
    revisions: await rows(
      `SELECT archive_revision,payload_sha256,previous_revision,previous_sha256,
              source_kind,source_locator,created_at,created_by_uid
         FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2
        ORDER BY archive_revision`,
      [WORKSPACE, `closed_${shiftId}`],
    ),
  });

  const addHistory = async (shiftId, truckId, before, after) => {
    const actionId = nextOperation('history');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await recordLineHistory(client, {
        workspaceId: WORKSPACE,
        uid: ids.admin,
        op: {id: actionId, shiftId, truckId, type: 'reset', createdAt: Date.now()},
        before,
        result: {status: after, log: null},
        profile: {email: `${ids.admin}@example.test`, display_name: 'Isolation admin'},
        shift: {objectId, objectName: 'Object isolation'},
      });
      await client.query('COMMIT');
      return actionId;
    } finally {
      client.release();
    }
  };

  let shiftA;
  let shiftB;
  let trapB;
  let trapBDigest;
  const checkB = async label => {
    const now = await snapshot(shiftB);
    assert.equal(digest(now), trapBDigest, `B canonical digest changed after: ${label}`);
    assert.deepEqual(now, trapB, `B rows changed after: ${label}`);
  };

  try {
    await applyMigrationsThrough(29);
    await pool.query('INSERT INTO workspaces(id) VALUES ($1) ON CONFLICT(id) DO NOTHING', [WORKSPACE]);
    for (const [uid, name, role] of [
      [ids.admin, 'Isolation admin', 'admin'],
      [ids.foreman, 'Isolation foreman', 'foreman'],
    ]) {
      await pool.query(
        'INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,$4,$5)',
        [uid, `${uid}@example.test`, name, role, 'active'],
      );
    }
    for (const [id, name] of [[objectId, 'Object isolation'], [otherObjectId, 'Object isolation other']]) {
      await pool.query(
        'INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',
        [WORKSPACE, id, {id, name}],
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
    for (const role of ['foreman']) {
      for (const action of [
        'start_shift', 'close_shift', 'edit_line', 'tab_line', 'manage_trucks',
        'action_arrive', 'action_load', 'action_ttn', 'line_timer_reset',
        'manage_shift_members', 'edit_logs', 'history_view',
      ]) {
        await pool.query(
          `INSERT INTO role_permissions(role,action,allowed) VALUES($1,$2,true)
           ON CONFLICT(role,action) DO UPDATE SET allowed=true`,
          [role, action],
        );
      }
    }
    for (const uid of Object.values(ids)) actors[uid] = await loadActor(pool, uid);
    const admin = actors[ids.admin];

    const create = async shiftType => (await createShift(pool, admin, {
      workspaceId: WORKSPACE,
      operationId: nextOperation(`create_${shiftType}`),
      protocolVersion: 2,
      objectId,
      workDate,
      shiftType,
      cycleMinutes: 30,
    })).result.shift.shiftId;
    const assign = async (shiftId, truckId) => assignTruck(pool, admin, {
      workspaceId: WORKSPACE,
      shiftId,
      truckId,
      operationId: nextOperation(`assign_${truckId.slice(-6)}`),
      protocolVersion: 2,
      expectedShiftRevision: await shiftRevision(shiftId),
    });
    const lineCommand = async ({shiftId, truckId, type, createdAt, ...fields}) => {
      const row = await statusRow(truckId);
      return submitLineOperationV2(pool, admin, {
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
    const fullCycle = async (shiftId, truckId) => {
      const arrivedAt = Date.now();
      await lineCommand({shiftId, truckId, type: 'arrive', createdAt: arrivedAt, wantArrived: true});
      const arrived = await statusRow(truckId);
      const loadedAt = Number(arrived.payload.arriveTimestamp) + 1;
      await lineCommand({shiftId, truckId, type: 'load', createdAt: loadedAt});
      await lineCommand({shiftId, truckId, type: 'ttn', createdAt: loadedAt + 1, collect: true});
    };

    // B is fully alive before A exists: one trip, one history row, its own
    // receipts. This is the state the trap freezes.
    shiftB = await create('night');
    await assign(shiftB, trucks.b);
    await fullCycle(shiftB, trucks.b);
    const bStatus = await statusRow(trucks.b);
    await addHistory(shiftB, trucks.b, bStatus.payload, bStatus.payload);

    trapB = await snapshot(shiftB);
    trapBDigest = digest(trapB);
    assert.ok(trapB.statuses.length > 0, 'B has a status row');
    assert.ok(trapB.logs.length > 0, 'B has its own trip');
    assert.ok(trapB.history.length > 0, 'B has a history row');
    assert.ok(trapB.receipts.length > 0, 'B has shift-scoped receipts');

    await t.test('creating A never reads B into A and leaves B byte-identical', async () => {
      shiftA = await create('day');
      assert.notEqual(shiftA, shiftB);
      await checkB('create A');
      // Two shifts of the same object/date with different types exist together;
      // a second shift of the same type is refused by the database key, not by a
      // "current shift" lookup.
      const pair = await rows(
        `SELECT shift_id,object_id,to_char(work_date,'YYYY-MM-DD') AS work_date_text,shift_type
           FROM shifts WHERE workspace_id=$1 AND shift_id = ANY($2::text[]) ORDER BY shift_type`,
        [WORKSPACE, [shiftA, shiftB]],
      );
      assert.equal(pair.length, 2);
      assert.ok(pair.every(row => row.object_id === objectId && row.work_date_text === workDate));
      assert.deepEqual(pair.map(row => row.shift_type), ['day', 'night']);
      await assert.rejects(
        createShift(pool, admin, {
          workspaceId: WORKSPACE,
          operationId: nextOperation('create_duplicate'),
          protocolVersion: 2,
          objectId,
          workDate,
          shiftType: 'day',
          cycleMinutes: 30,
        }),
        error => error?.code === 'shift-duplicate' && error?.status === 409,
      );
      await checkB('duplicate day shift refused');
    });

    await t.test('A commands that name B rows are refused and change no B byte', async () => {
      const bRow = await statusRow(trucks.b);
      await assert.rejects(
        submitLineOperationV2(pool, admin, {
          workspaceId: WORKSPACE,
          shiftId: shiftA,
          operationId: nextOperation('cross_line'),
          protocolVersion: 2,
          type: 'arrive',
          truckId: trucks.b,
          expectedShiftRevision: await shiftRevision(shiftA),
          expectedStatusRevision: Number(bRow.status_revision),
          expectedCycleRevision: Number(bRow.cycle_revision),
          expectedTtnRevision: Number(bRow.ttn_revision),
          createdAt: Date.now(),
          cycleMinutes: 30,
          wantArrived: true,
        }),
        error => error?.code === 'truck-not-on-shift',
      );
      await checkB('A line operation on B truck');

      await assert.rejects(
        removeTruck(pool, admin, {
          workspaceId: WORKSPACE,
          shiftId: shiftA,
          truckId: trucks.b,
          operationId: nextOperation('cross_remove'),
          protocolVersion: 2,
          expectedShiftRevision: await shiftRevision(shiftA),
          expectedStatusRevision: Number(bRow.status_revision),
          expectedCycleRevision: Number(bRow.cycle_revision),
          expectedTtnRevision: Number(bRow.ttn_revision),
        }),
        error => error?.code === 'truck-not-on-shift',
      );
      await checkB('A remove of B truck');

      await assert.rejects(
        forceTransferTruck(pool, admin, {
          workspaceId: WORKSPACE,
          destinationShiftId: shiftB,
          sourceShiftId: shiftA,
          truckId: trucks.b,
          operationId: nextOperation('cross_transfer'),
          protocolVersion: 2,
          expectedSourceShiftRevision: await shiftRevision(shiftA),
          expectedDestinationShiftRevision: await shiftRevision(shiftB),
          expectedStatusRevision: Number(bRow.status_revision),
          expectedCycleRevision: Number(bRow.cycle_revision),
          expectedTtnRevision: Number(bRow.ttn_revision),
          confirmTransfer: true,
        }),
        error => error?.code === 'truck-not-on-shift',
      );
      await checkB('A transfer that names B truck as its source');
    });

    await t.test('A object, members and trucks stay inside A', async () => {
      await changeShiftObject(pool, admin, {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('object_other'),
        protocolVersion: 2,
        objectId: otherObjectId,
        expectedShiftRevision: await shiftRevision(shiftA),
      });
      await checkB('A object change to the other object');
      await changeShiftObject(pool, admin, {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('object_back'),
        protocolVersion: 2,
        objectId,
        expectedShiftRevision: await shiftRevision(shiftA),
      });
      await checkB('A object change back');

      await addShiftMember(pool, admin, {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        uid: ids.foreman,
        operationId: nextOperation('member_add'),
        protocolVersion: 2,
        expectedShiftRevision: await shiftRevision(shiftA),
        expectedMembershipRevision: null,
      });
      await checkB('A member add');
      await removeShiftMember(pool, admin, {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        uid: ids.foreman,
        operationId: nextOperation('member_remove'),
        protocolVersion: 2,
        expectedShiftRevision: await shiftRevision(shiftA),
        expectedMembershipRevision: 1,
      });
      await checkB('A member remove');

      await assign(shiftA, trucks.extra);
      await checkB('A truck add');
      const extra = await statusRow(trucks.extra);
      await removeTruck(pool, admin, {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        truckId: trucks.extra,
        operationId: nextOperation('truck_remove'),
        protocolVersion: 2,
        expectedShiftRevision: await shiftRevision(shiftA),
        expectedStatusRevision: Number(extra.status_revision),
        expectedCycleRevision: Number(extra.cycle_revision),
        expectedTtnRevision: Number(extra.ttn_revision),
      });
      await checkB('A truck remove');

      await assign(shiftA, trucks.a);
      await checkB('A truck assignment for the trip');
    });

    await t.test('A line operations, report edit and history undo/redo leave B byte-identical', async () => {
      const arrivedAt = Date.now();
      await lineCommand({shiftId: shiftA, truckId: trucks.a, type: 'arrive', createdAt: arrivedAt, wantArrived: true});
      await checkB('A arrive');
      const arrived = await statusRow(trucks.a);
      const loadedAt = Number(arrived.payload.arriveTimestamp) + 1;
      await lineCommand({shiftId: shiftA, truckId: trucks.a, type: 'load', createdAt: loadedAt});
      await checkB('A load');
      await lineCommand({shiftId: shiftA, truckId: trucks.a, type: 'ttn', createdAt: loadedAt + 1, collect: true});
      await checkB('A ttn');

      await lineCommand({shiftId: shiftA, truckId: trucks.a, type: 'reset', createdAt: loadedAt + 2});
      await checkB('A reset');

      const aLog = (await rows(
        'SELECT log_id,payload FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id COLLATE "C"',
        [WORKSPACE, shiftA],
      ))[0];
      assert.ok(aLog, 'A has its own trip to edit');
      await submitReport(pool, ids.admin, {
        id: `report_${prefix}_edit`,
        type: 'report.update',
        logId: aLog.log_id,
        expected: reportVersion(aLog.payload),
        data: {volume: 12, timeStr: '12:30', comment: 'edited in A'},
      });
      await checkB('A report edit');

      // The report edit rewrites the status payload (last load markers and
      // revisions), so the history row is recorded from the settled state: undo
      // compares `after_status` with the current row and would otherwise answer
      // `dependent-changes`. The trap only needs a real history row of A.
      const settled = (await statusRow(trucks.a)).payload;
      const actionId = await addHistory(shiftA, trucks.a, settled, settled);
      await checkB('A history row');

      const historyRevision = async () => Number((await rows(
        'SELECT revision FROM line_history WHERE workspace_id=$1 AND action_id=$2',
        [WORKSPACE, actionId],
      ))[0].revision);
      await historyOperation(pool, ids.admin, {
        id: nextOperation('history_undo'),
        actionId,
        direction: 'undo',
        expectedRevision: await historyRevision(),
      });
      await checkB('A history undo');
      await historyOperation(pool, ids.admin, {
        id: nextOperation('history_redo'),
        actionId,
        direction: 'redo',
        expectedRevision: await historyRevision(),
      });
      await checkB('A history redo');
    });

    await t.test('A prepare, explicit archive read, material and finish leave B byte-identical', async () => {
      const prepared = await prepareShiftClose(pool, admin, {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('prepare'),
        protocolVersion: 2,
        expectedShiftRevision: await shiftRevision(shiftA),
      });
      await checkB('A close prepare');
      assert.equal(prepared.result.phase, 'prepared');

      const revision = await readArchiveRevision(pool, WORKSPACE, `closed_${shiftA}`, 1);
      assert.ok(revision, 'A prepared archive revision exists');
      const volume = Number(revision.payload.totalVolume);
      assert.ok(Number.isFinite(volume), 'A material volume comes from its own bytes');
      await checkB('A explicit archive revision read');

      const material = await confirmShiftMaterial(pool, admin, {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('material'),
        protocolVersion: 2,
        closeToken: prepared.result.closeToken,
        materialId: `material_${shiftA.slice(-8)}`,
        volume,
        expectedShiftRevision: prepared.result.shiftRevision,
        expectedArchiveRevision: revision.revision,
        expectedMaterialMarkerRevision: null,
      });
      assert.ok(Number.isInteger(material.result.materialMarkerRevision) && material.result.materialMarkerRevision > 0,
        'A material marker revision is written');
      await checkB('A material confirm');

      await finishShiftClose(pool, admin, {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('finish'),
        protocolVersion: 2,
        closeToken: prepared.result.closeToken,
        expectedShiftRevision: prepared.result.shiftRevision,
        expectedArchiveRevision: revision.revision,
        expectedMaterialMarkerRevision: material.result.materialMarkerRevision,
      });
      await checkB('A close finish');
      assert.equal((await shiftRow(shiftA)).state, 'closed');
      assert.equal((await shiftRow(shiftB)).state, 'active', 'B is still open');
    });

    await t.test('scoped reads return exactly the rows of the named shift', async () => {
      const snapshotA = await readShiftSnapshot(pool, admin, {workspaceId: WORKSPACE, shiftId: shiftA});
      const bStatuses = new Set(trapB.statuses.map(row => row.truck_id));
      const bLogs = new Set(trapB.logs.map(row => row.log_id));
      assert.equal(snapshotA.shiftId, shiftA);
      assert.ok(snapshotA.statuses.every(row => row.shiftId === shiftA), 'A snapshot has no B status');
      assert.ok(snapshotA.logs.every(row => row.shiftId === shiftA), 'A snapshot has no B log');
      assert.ok(snapshotA.statuses.every(row => !bStatuses.has(row.truckId)), 'A snapshot has no B truck');
      assert.ok(snapshotA.logs.every(row => !bLogs.has(row.logId)), 'A snapshot has no B log id');

      const snapshotB = await readShiftSnapshot(pool, admin, {workspaceId: WORKSPACE, shiftId: shiftB});
      assert.equal(snapshotB.shiftId, shiftB);
      assert.ok(snapshotB.statuses.every(row => row.shiftId === shiftB));
      assert.ok(snapshotB.logs.every(row => row.shiftId === shiftB));

      // The history endpoint is a workspace-wide catalog by design; each item
      // must carry its own shift id and must never mix A's truck into B or back.
      const history = (await readLineHistory(pool, ids.admin, WORKSPACE)).items;
      const aTrucks = new Set(['a', 'extra'].map(key => trucks[key]));
      const bTruck = trucks.b;
      for (const item of history) {
        assert.ok([shiftA, shiftB].includes(item.shiftId), 'every history row names one of the two shifts');
        if (item.shiftId === shiftA) assert.ok(aTrucks.has(item.truckId), 'A history row keeps an A truck');
        if (item.shiftId === shiftB) assert.equal(item.truckId, bTruck, 'B history row keeps the B truck');
      }
      assert.ok(history.some(item => item.shiftId === shiftA), 'A history is present');
      assert.ok(history.some(item => item.shiftId === shiftB), 'B history is present');
    });
  } finally {
    await pool.end();
  }
});
