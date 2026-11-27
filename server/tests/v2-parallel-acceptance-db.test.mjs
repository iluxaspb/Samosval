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
import {completeDetachedTrip, forceTransferTruck} from '../src/shift-transfer-v2.mjs';
import {submitLineOperationV2} from '../src/line-store-v2.mjs';
import {reportVersion, submitReport} from '../src/report-store.mjs';
import {historyOperation, recordLineHistory} from '../src/history-store.mjs';
import {
  readArchiveHistory, readArchiveRevision, readLatestFinalizedArchive,
} from '../src/archive-latest.mjs';
import {listVisibleShifts, readShiftSnapshot} from '../src/shift-read-v2.mjs';
import {
  confirmShiftMaterial, finishShiftClose, prepareShiftClose,
} from '../src/shift-close-v2.mjs';
import {readRestoredContext, submitRestoredCorrection} from '../src/restored-context-store.mjs';

// Full server acceptance of two parallel shifts (design §5.1–§5.6, §6, §7,
// §9, §11, §12, §15 «БД/сервер», plan Task 29B).
//
// Two foremen and one admin work on ONE object and ONE work date: A is the day
// shift of foreman A, B is the night shift of foreman B. The root drives the
// real services end to end — creation, membership, trucks, arrive/load/reset/
// ttn, report, history undo/redo, a force transfer of an unfinished cycle,
// completion of that detached trip from B into A, the two-phase close of A,
// both archive reads, and restored-context trip/TTN corrections of A — while B
// stays fully operational.
//
// Isolation is proved by rows, not by intent. B's whole shift-scoped surface is
// serialized to canonical JSON, hashed with SHA-256 and compared after every A
// phase. The one deliberate cross-shift mutation (the force transfer) changes B
// by design; after it the trap is re-frozen. Completing the detached trip is a
// cross-shift command that changes the detached row of B by design, so that
// phase compares B's core surface and checks the exact detached transition.
//
// Numbers (revisions, counters, archive totals, context revisions) are read from
// the rows the production writers just created; nothing is hardcoded
// (docs/opyt-oshibok.md, урок 50: ревизии выводятся из фактического состояния).

const WORKSPACE = 'main_workspace';

function moscowDate(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ms);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// Deterministic bytes: object keys are sorted at every level, arrays keep their
// order. Dates/Buffers keep the JSON.stringify representation, stable for
// unchanged rows.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

test('v2 parallel shifts accept the full server flow', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const pool = new pg.Pool({connectionString: process.env.TEST_DATABASE_URL, max: 5});
  pool.on('error', () => {});
  const prefix = 'accept_' + randomUUID().replaceAll('-', '');
  const ids = {
    admin: prefix + '_admin',
    foremanA: prefix + '_foreman_a',
    foremanB: prefix + '_foreman_b',
  };
  const objectId = prefix + '_object';
  const otherObjectId = prefix + '_object_other';
  const trucks = {
    a: prefix + '_truck_a',
    transfer: prefix + '_truck_transfer',
    extra: prefix + '_truck_extra',
    b: prefix + '_truck_b',
  };
  const workDate = moscowDate();
  const actors = {};
  let operation = 0;
  const nextOperation = label => `${prefix}_${label}_${++operation}`;

  const rows = async (sql, params) => (await pool.query(sql, params)).rows;
  const shiftRow = async shiftId => (await rows(
    'SELECT * FROM shifts WHERE workspace_id=$1 AND shift_id=$2',
    [WORKSPACE, shiftId],
  ))[0];
  const shiftRevision = async shiftId => Number((await shiftRow(shiftId)).revision);
  const statusRow = async truckId => (await rows(
    `SELECT shift_id,status_revision,cycle_revision,ttn_revision,payload
       FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2`,
    [WORKSPACE, truckId],
  ))[0];
  const seriesFor = async id => (await rows(
    `SELECT * FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2`,
    [WORKSPACE, id],
  ))[0] ?? null;
  const revisionsFor = async id => rows(
    `SELECT archive_revision,payload_sha256,previous_revision,previous_sha256,
            source_kind,source_locator,created_at,created_by_uid
       FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2
      ORDER BY archive_revision`,
    [WORKSPACE, id],
  );

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
    series: await seriesFor(`closed_${shiftId}`),
    revisions: await revisionsFor(`closed_${shiftId}`),
  });
  // B's own surface without the cross-shift detached row: the completion phase
  // is allowed to move exactly that row and nothing else.
  const coreSnapshot = async shiftId => {
    const {detached, ...core} = await snapshot(shiftId);
    return core;
  };

  const checkB = async (expected, label) => {
    const now = await snapshot(shiftB);
    assert.deepEqual(now, expected, `B rows changed after: ${label}`);
    assert.equal(digest(now), digest(expected), `B canonical digest changed after: ${label}`);
  };
  const checkBCore = async (expected, label) => {
    const now = await coreSnapshot(shiftB);
    assert.deepEqual(now, expected, `B core rows changed after: ${label}`);
    assert.equal(digest(now), digest(expected), `B core canonical digest changed after: ${label}`);
  };
  const checkA = async (expected, label) => {
    const now = await snapshot(shiftA);
    assert.deepEqual(now, expected, `A rows changed after: ${label}`);
    assert.equal(digest(now), digest(expected), `A canonical digest changed after: ${label}`);
  };

  const addHistory = async (shiftId, truckId, before, after) => {
    const actionId = nextOperation('history');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await recordLineHistory(client, {
        workspaceId: WORKSPACE,
        uid: ids.foremanA,
        op: {id: actionId, shiftId, truckId, type: 'reset', createdAt: Date.now()},
        before,
        result: {status: after, log: null},
        profile: {email: `${ids.foremanA}@example.test`, display_name: 'Acceptance foreman A'},
        shift: {objectId, objectName: 'Object acceptance'},
      });
      await client.query('COMMIT');
      return actionId;
    } finally {
      client.release();
    }
  };

  let shiftA;
  let shiftB;
  let trapB1;
  let trapB2;
  let trapB3;
  let trapA;
  let preparedArchiveRevision;

  try {
    await applyMigrationsThrough(29);
    await pool.query('INSERT INTO workspaces(id) VALUES ($1) ON CONFLICT(id) DO NOTHING', [WORKSPACE]);
    for (const [uid, name, role] of [
      [ids.admin, 'Acceptance admin', 'admin'],
      [ids.foremanA, 'Acceptance foreman A', 'foreman'],
      [ids.foremanB, 'Acceptance foreman B', 'foreman'],
    ]) {
      await pool.query(
        'INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,$4,$5)',
        [uid, `${uid}@example.test`, name, role, 'active'],
      );
    }
    for (const [id, name] of [[objectId, 'Object acceptance'], [otherObjectId, 'Object acceptance other']]) {
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
    for (const action of [
      'start_shift', 'close_shift', 'edit_line', 'tab_line', 'manage_trucks',
      'action_arrive', 'action_load', 'action_ttn', 'line_timer_reset',
      'manage_shift_members', 'edit_logs',
    ]) {
      await pool.query(
        `INSERT INTO role_permissions(role,action,allowed) VALUES('foreman',$1,true)
         ON CONFLICT(role,action) DO UPDATE SET allowed=true`,
        [action],
      );
    }
    for (const uid of Object.values(ids)) actors[uid] = await loadActor(pool, uid);
    const admin = actors[ids.admin];

    const create = async (actor, shiftType) => (await createShift(pool, actor, {
      workspaceId: WORKSPACE,
      operationId: nextOperation(`create_${shiftType}`),
      protocolVersion: 2,
      objectId,
      workDate,
      shiftType,
      cycleMinutes: 30,
    })).result.shift.shiftId;
    const assign = async (shiftId, truckId, actor = admin) => assignTruck(pool, actor, {
      workspaceId: WORKSPACE,
      shiftId,
      truckId,
      operationId: nextOperation(`assign_${truckId.slice(-8)}`),
      protocolVersion: 2,
      expectedShiftRevision: await shiftRevision(shiftId),
    });
    const lineCommand = async ({shiftId, truckId, type, createdAt, actor = admin, ...fields}) => {
      const row = await statusRow(truckId);
      return submitLineOperationV2(pool, actor, {
        workspaceId: WORKSPACE,
        shiftId,
        operationId: nextOperation(`${type}_${truckId.slice(-8)}`),
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
    const fullCycle = async (shiftId, truckId, actor = admin) => {
      const arrivedAt = Date.now();
      await lineCommand({shiftId, truckId, type: 'arrive', createdAt: arrivedAt, wantArrived: true, actor});
      const arrived = await statusRow(truckId);
      const loadedAt = Number(arrived.payload.arriveTimestamp) + 1;
      await lineCommand({shiftId, truckId, type: 'load', createdAt: loadedAt, actor});
      await lineCommand({shiftId, truckId, type: 'ttn', createdAt: loadedAt + 1, collect: true, actor});
    };

    // B is a fully alive shift of the same object and date before A exists: one
    // ordinary trip by its own foreman. This is the state the first trap freezes.
    shiftB = await create(actors[ids.foremanB], 'night');
    await assign(shiftB, trucks.b, actors[ids.foremanB]);
    await fullCycle(shiftB, trucks.b, actors[ids.foremanB]);
    assert.ok((await statusRow(trucks.b)).shift_id === shiftB);

    await t.test('two foremen and the admin see exactly their assigned shifts', async () => {
      shiftA = await create(actors[ids.foremanA], 'day');
      assert.notEqual(shiftA, shiftB);

      // Same object, same work date, different shift types: day and night do not
      // conflict, and no "current shift" singleton was involved.
      const pair = await rows(
        `SELECT shift_id,object_id,to_char(work_date,'YYYY-MM-DD') AS work_date_text,
                shift_type,state,opened_by_uid
           FROM shifts WHERE workspace_id=$1 AND shift_id = ANY($2::text[])
          ORDER BY shift_type`,
        [WORKSPACE, [shiftA, shiftB]],
      );
      assert.equal(pair.length, 2);
      assert.ok(pair.every(row => row.object_id === objectId && row.work_date_text === workDate));
      assert.deepEqual(pair.map(row => row.shift_type), ['day', 'night']);
      assert.deepEqual(pair.map(row => row.state), ['active', 'active']);
      assert.equal(pair[0].opened_by_uid, ids.foremanA);
      assert.equal(pair[1].opened_by_uid, ids.foremanB);

      const list = async actor => (await listVisibleShifts(pool, actor, {workspaceId: WORKSPACE})).items;
      const adminItems = await list(admin);
      const aItems = await list(actors[ids.foremanA]);
      const bItems = await list(actors[ids.foremanB]);
      assert.deepEqual(adminItems.map(item => item.shiftId).sort(), [shiftA, shiftB].sort());
      assert.deepEqual(aItems.map(item => item.shiftId), [shiftA]);
      assert.deepEqual(bItems.map(item => item.shiftId), [shiftB]);
      assert.equal(aItems[0].shiftType, 'day');
      assert.equal(bItems[0].shiftType, 'night');
      assert.equal(aItems[0].objectId, objectId);
      assert.equal(bItems[0].objectId, objectId);

      // A non-member cannot even read the other shift: existence is not disclosed.
      await assert.rejects(
        readShiftSnapshot(pool, actors[ids.foremanA], {workspaceId: WORKSPACE, shiftId: shiftB}),
        error => error?.code === 'shift-not-visible' && error?.status === 404,
      );
      await assert.rejects(
        readShiftSnapshot(pool, actors[ids.foremanB], {workspaceId: WORKSPACE, shiftId: shiftA}),
        error => error?.code === 'shift-not-visible' && error?.status === 404,
      );

      // The scoped snapshot of A carries A rows only, never a B truck or log.
      const snapshotA = await readShiftSnapshot(pool, admin, {workspaceId: WORKSPACE, shiftId: shiftA});
      const bStatuses = new Set((await snapshot(shiftB)).statuses.map(row => row.truck_id));
      const bLogs = new Set((await snapshot(shiftB)).logs.map(row => row.log_id));
      assert.equal(snapshotA.shiftId, shiftA);
      assert.ok(snapshotA.statuses.every(row => row.shiftId === shiftA));
      assert.ok(snapshotA.logs.every(row => row.shiftId === shiftA));
      assert.ok(snapshotA.statuses.every(row => !bStatuses.has(row.truckId)));
      assert.ok(snapshotA.logs.every(row => !bLogs.has(row.logId)));
    });

    // The first trap is frozen before any A phase.
    trapB1 = await snapshot(shiftB);
    assert.ok(trapB1.statuses.length > 0, 'B has its own current assignment');
    assert.ok(trapB1.logs.length > 0, 'B has its own trip');
    assert.ok(trapB1.receipts.length > 0, 'B has its own receipts');
    assert.equal(trapB1.series, null, 'B has no archive yet');

    await t.test('foreign, stale and old-protocol actions are refused without a mutation', async () => {
      // A foreman of B is not a member of A: the known command names the missing
      // membership (403) and writes no A status row.
      await assert.rejects(
        assignTruck(pool, actors[ids.foremanB], {
          workspaceId: WORKSPACE,
          shiftId: shiftA,
          truckId: trucks.extra,
          operationId: nextOperation('foreign_assign'),
          protocolVersion: 2,
          expectedShiftRevision: await shiftRevision(shiftA),
        }),
        error => error?.code === 'not-shift-member' && error?.status === 403,
      );
      assert.equal(await statusRow(trucks.extra), undefined);
      await checkB(trapB1, 'foreign assign on A');

      // The force-transfer right is role-gated: a foreman gets 403 even before
      // the domain is consulted, so it cannot promote itself with a matrix row.
      await assert.rejects(
        forceTransferTruck(pool, actors[ids.foremanA], {
          workspaceId: WORKSPACE,
          destinationShiftId: shiftB,
          sourceShiftId: shiftA,
          truckId: trucks.transfer,
          operationId: nextOperation('foreman_transfer'),
          protocolVersion: 2,
          expectedSourceShiftRevision: await shiftRevision(shiftA),
          expectedDestinationShiftRevision: await shiftRevision(shiftB),
          expectedStatusRevision: 1,
          expectedCycleRevision: 1,
          expectedTtnRevision: 1,
          confirmTransfer: true,
        }),
        error => error?.code === 'forbidden' && error?.status === 403
          && error?.details?.reason === 'force-transfer-role',
      );
      await checkB(trapB1, 'foreman force transfer');

      // An old client is a protocol answer (426), not a schema error, and it
      // leaves no receipt behind.
      const staleProtocol = nextOperation('stale_protocol');
      await assert.rejects(
        submitLineOperationV2(pool, actors[ids.foremanA], {
          workspaceId: WORKSPACE,
          shiftId: shiftA,
          operationId: staleProtocol,
          protocolVersion: 1,
          type: 'arrive',
          truckId: trucks.a,
          expectedShiftRevision: await shiftRevision(shiftA),
          expectedStatusRevision: 1,
          expectedCycleRevision: 1,
          expectedTtnRevision: 1,
          createdAt: Date.now(),
          cycleMinutes: 30,
          wantArrived: true,
        }),
        error => error?.code === 'protocol-upgrade-required' && error?.status === 426,
      );
      assert.equal((await rows(
        'SELECT 1 FROM shift_operation_receipts WHERE workspace_id=$1 AND operation_id=$2',
        [WORKSPACE, staleProtocol],
      )).length, 0);
      await checkB(trapB1, 'old protocol line command');
    });

    await t.test('membership changes visibility of exactly that shift', async () => {
      const added = await addShiftMember(pool, actors[ids.foremanA], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        uid: ids.foremanB,
        operationId: nextOperation('member_add'),
        protocolVersion: 2,
        expectedShiftRevision: await shiftRevision(shiftA),
        expectedMembershipRevision: null,
      });
      assert.equal(added.result.membership.uid, ids.foremanB);
      // The first write of a fresh membership row starts the chain at one; the
      // removal below proves the chain moves by exactly one from that actual.
      const firstMembershipRevision = added.result.membership.revision;
      assert.equal(firstMembershipRevision, 1);
      await checkB(trapB1, 'member add on A');

      const visibleToB = (await listVisibleShifts(pool, actors[ids.foremanB], {workspaceId: WORKSPACE})).items;
      assert.deepEqual(visibleToB.map(item => item.shiftId).sort(), [shiftA, shiftB].sort());
      const snapshotA = await readShiftSnapshot(pool, actors[ids.foremanB], {
        workspaceId: WORKSPACE, shiftId: shiftA,
      });
      assert.equal(snapshotA.shiftId, shiftA);

      const removed = await removeShiftMember(pool, actors[ids.foremanA], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        uid: ids.foremanB,
        operationId: nextOperation('member_remove'),
        protocolVersion: 2,
        expectedShiftRevision: await shiftRevision(shiftA),
        expectedMembershipRevision: firstMembershipRevision,
      });
      assert.equal(removed.result.membership.revision, firstMembershipRevision + 1);
      await checkB(trapB1, 'member remove on A');

      const hiddenAgain = (await listVisibleShifts(pool, actors[ids.foremanB], {workspaceId: WORKSPACE})).items;
      assert.deepEqual(hiddenAgain.map(item => item.shiftId), [shiftB]);
      await assert.rejects(
        readShiftSnapshot(pool, actors[ids.foremanB], {workspaceId: WORKSPACE, shiftId: shiftA}),
        error => error?.code === 'shift-not-visible' && error?.status === 404,
      );

      // Membership rows survive as history: the removed row is still on A.
      const membership = (await rows(
        `SELECT uid,removed_at,revision FROM shift_members
          WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3`,
        [WORKSPACE, shiftA, ids.foremanB],
      ))[0];
      assert.ok(membership.removed_at instanceof Date);
      assert.equal(Number(membership.revision), removed.result.membership.revision);
    });

    await t.test('A object, trucks and CAS stay inside A', async () => {
      // Before the first confirmed arrive the object is correctable; the stale
      // request then loses on the shift revision, not on a guess.
      await changeShiftObject(pool, actors[ids.foremanA], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('object_other'),
        protocolVersion: 2,
        objectId: otherObjectId,
        expectedShiftRevision: await shiftRevision(shiftA),
      });
      await checkB(trapB1, 'A object change to the other object');
      await changeShiftObject(pool, actors[ids.foremanA], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('object_back'),
        protocolVersion: 2,
        objectId,
        expectedShiftRevision: await shiftRevision(shiftA),
      });
      await checkB(trapB1, 'A object change back');

      await assert.rejects(
        changeShiftObject(pool, actors[ids.foremanA], {
          workspaceId: WORKSPACE,
          shiftId: shiftA,
          operationId: nextOperation('stale_object'),
          protocolVersion: 2,
          objectId: otherObjectId,
          expectedShiftRevision: 1,
        }),
        error => error?.code === 'shift-changed' && error?.status === 409,
      );
      await checkB(trapB1, 'stale object change');

      await assign(shiftA, trucks.extra, actors[ids.foremanA]);
      await checkB(trapB1, 'A truck add');
      const extra = await statusRow(trucks.extra);
      assert.equal(extra.shift_id, shiftA);
      await removeTruck(pool, actors[ids.foremanA], {
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
      assert.equal(await statusRow(trucks.extra), undefined);
      await checkB(trapB1, 'A truck remove');
    });

    await t.test('A line operations, report and history replay exactly once', async () => {
      await assign(shiftA, trucks.a, actors[ids.foremanA]);
      await checkB(trapB1, 'A truck assignment for the trip');

      const arrivedAt = Date.now();
      const arriveOperation = nextOperation('arrive_a');
      const arriveRow = await statusRow(trucks.a);
      const arriveInput = {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: arriveOperation,
        protocolVersion: 2,
        type: 'arrive',
        truckId: trucks.a,
        expectedShiftRevision: await shiftRevision(shiftA),
        expectedStatusRevision: Number(arriveRow.status_revision),
        expectedCycleRevision: Number(arriveRow.cycle_revision),
        expectedTtnRevision: Number(arriveRow.ttn_revision),
        createdAt: arrivedAt,
        cycleMinutes: 30,
        wantArrived: true,
      };
      const arrived = await submitLineOperationV2(pool, actors[ids.foremanA], arriveInput);
      assert.equal(arrived.replayed, false);
      await checkB(trapB1, 'A arrive');

      const arrivedRow = await statusRow(trucks.a);
      const loadedAt = Number(arrivedRow.payload.arriveTimestamp) + 1;
      await lineCommand({shiftId: shiftA, truckId: trucks.a, type: 'load', createdAt: loadedAt, actor: actors[ids.foremanA]});
      await checkB(trapB1, 'A load');
      await lineCommand({
        shiftId: shiftA, truckId: trucks.a, type: 'ttn',
        createdAt: loadedAt + 1, collect: true, actor: actors[ids.foremanA],
      });
      await checkB(trapB1, 'A ttn');

      // The object is locked by the first confirmed arrival: change is 409 forever.
      await assert.rejects(
        changeShiftObject(pool, actors[ids.foremanA], {
          workspaceId: WORKSPACE,
          shiftId: shiftA,
          operationId: nextOperation('locked_object'),
          protocolVersion: 2,
          objectId: otherObjectId,
          expectedShiftRevision: await shiftRevision(shiftA),
        }),
        error => error?.code === 'object-locked' && error?.status === 409,
      );
      await checkB(trapB1, 'object-locked change');

      // Receipt replay returns the stored result and never dispatches a second
      // arrival: counters, logs and the receipt set stay exactly as they were.
      const beforeReplay = await snapshot(shiftA);
      const replay = await submitLineOperationV2(pool, actors[ids.foremanA], arriveInput);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, arrived.result);
      assert.deepEqual(await snapshot(shiftA), beforeReplay, 'replay writes nothing');
      await checkB(trapB1, 'arrive replay');

      // A reset is a real second cycle step in A; then the report edits the trip
      // and history undo/redo move only A's own status/log rows.
      await lineCommand({
        shiftId: shiftA, truckId: trucks.a, type: 'reset',
        createdAt: loadedAt + 2, actor: actors[ids.foremanA],
      });
      await checkB(trapB1, 'A reset');

      const aLog = (await rows(
        'SELECT log_id,payload FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id COLLATE "C"',
        [WORKSPACE, shiftA],
      ))[0];
      assert.ok(aLog, 'A has its own trip to edit');
      const edited = await submitReport(pool, ids.foremanA, {
        id: `report_${prefix}_a_edit`,
        type: 'report.update',
        logId: aLog.log_id,
        expected: reportVersion(aLog.payload),
        data: {volume: 12, timeStr: '12:30', comment: 'edited in A'},
      });
      assert.equal(edited.result.log.shiftId, shiftA);
      assert.equal(Number(edited.result.log.volume), 12);
      await checkB(trapB1, 'A report edit');

      const settled = (await statusRow(trucks.a)).payload;
      const actionId = await addHistory(shiftA, trucks.a, settled, settled);
      await checkB(trapB1, 'A history row');
      const historyRevision = async () => Number((await rows(
        'SELECT revision FROM line_history WHERE workspace_id=$1 AND action_id=$2',
        [WORKSPACE, actionId],
      ))[0].revision);
      const undone = await historyOperation(pool, ids.admin, {
        id: nextOperation('history_undo'),
        actionId,
        direction: 'undo',
        expectedRevision: await historyRevision(),
      });
      assert.equal(undone.direction, 'undo');
      await checkB(trapB1, 'A history undo');
      const redone = await historyOperation(pool, ids.admin, {
        id: nextOperation('history_redo'),
        actionId,
        direction: 'redo',
        expectedRevision: await historyRevision(),
      });
      assert.equal(redone.direction, 'redo');
      await checkB(trapB1, 'A history redo');
    });

    await t.test('force transfer leaves an open detached trip in A and a clean assignment in B', async () => {
      await assign(shiftA, trucks.transfer, actors[ids.foremanA]);
      const arrivedAt = Date.now();
      await lineCommand({
        shiftId: shiftA, truckId: trucks.transfer, type: 'arrive',
        createdAt: arrivedAt, wantArrived: true, actor: actors[ids.foremanA],
      });
      await checkB(trapB1, 'A arrive before transfer');

      const beforeTransfer = await statusRow(trucks.transfer);
      const transferred = await forceTransferTruck(pool, admin, {
        workspaceId: WORKSPACE,
        operationId: nextOperation('transfer_unfinished'),
        protocolVersion: 2,
        sourceShiftId: shiftA,
        destinationShiftId: shiftB,
        truckId: trucks.transfer,
        expectedSourceShiftRevision: await shiftRevision(shiftA),
        expectedDestinationShiftRevision: await shiftRevision(shiftB),
        expectedStatusRevision: Number(beforeTransfer.status_revision),
        expectedCycleRevision: Number(beforeTransfer.cycle_revision),
        expectedTtnRevision: Number(beforeTransfer.ttn_revision),
        confirmTransfer: true,
      });
      assert.equal(transferred.result.detachedTrip.state, 'open');
      assert.equal(transferred.result.detachedTrip.stage, 'load');
      assert.equal(transferred.result.detachedTrip.sourceShiftId, shiftA);
      assert.equal(transferred.result.detachedTrip.destinationShiftId, shiftB);
      assert.equal(transferred.result.detachedTrip.sourceCycleRevision, Number(beforeTransfer.cycle_revision));
      assert.equal(transferred.result.assignment.shiftId, shiftB);
      // The destination receives a clean assignment: its counters are the
      // first-cycle ones of a fresh row, mirrored in payload and result alike.
      assert.equal(transferred.result.assignment.cycleRevision, 1);
      assert.equal(transferred.result.assignment.ttnRevision, 1);
      assert.equal(transferred.result.assignment.stage, null);

      // The truck now has exactly one current status and it belongs to B; A kept
      // the unfinished cycle only as the detached row.
      const moved = await statusRow(trucks.transfer);
      assert.equal(moved.shift_id, shiftB);
      assert.equal(moved.payload.onLine, true);
      assert.equal(transferred.result.assignment.cycleRevision, Number(moved.cycle_revision));
      assert.equal(transferred.result.assignment.ttnRevision, Number(moved.ttn_revision));
      assert.equal(moved.payload.cycleRevision, Number(moved.cycle_revision));
      assert.equal(moved.payload.ttnRevision, Number(moved.ttn_revision));
      assert.equal((await rows(
        `SELECT 1 FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2`,
        [WORKSPACE, trucks.transfer],
      )).length, 1);

      const detached = (await rows(
        `SELECT * FROM detached_open_trips WHERE workspace_id=$1
            AND source_shift_id=$2 AND state='open'`,
        [WORKSPACE, shiftA],
      ))[0];
      assert.ok(detached, 'A owns the detached row');
      assert.equal(detached.truck_id, trucks.transfer);
      assert.equal(detached.stage, 'load');
      // The detached row starts its own revision chain, while the source
      // counters are carried over unchanged, not reset.
      assert.equal(Number(detached.cycle_revision), transferred.result.detachedTrip.cycleRevision);
      assert.equal(Number(detached.source_status_revision), Number(beforeTransfer.status_revision));
      assert.equal(Number(detached.source_cycle_revision), Number(beforeTransfer.cycle_revision));
      assert.equal(Number(detached.source_ttn_revision), Number(beforeTransfer.ttn_revision));

      // A's own view lists the detached trip with both labels; B's snapshot too.
      const snapshotA = await readShiftSnapshot(pool, admin, {workspaceId: WORKSPACE, shiftId: shiftA});
      assert.equal(snapshotA.detachedOpenTrips.length, 1);
      assert.equal(snapshotA.detachedOpenTrips[0].sourceShift.shiftId, shiftA);
      assert.equal(snapshotA.detachedOpenTrips[0].destinationShift.shiftId, shiftB);
      assert.equal(snapshotA.detachedOpenTrips[0].stage, 'load');

      // The transfer is the one deliberate cross-shift write: B gained exactly a
      // clean assignment, its own revision bump and its receipt. Re-freeze B.
      trapB2 = await snapshot(shiftB);
      assert.equal(trapB2.statuses.length, 2, 'B keeps its own truck and gains the moved one');
      assert.ok(trapB2.statuses.some(row => row.truck_id === trucks.b));
      assert.ok(trapB2.statuses.some(row => row.truck_id === trucks.transfer));
      assert.equal(trapB2.receipts.length, trapB1.receipts.length + 1);
      assert.equal(trapB2.detached.length, 1);
      assert.equal(trapB2.detached[0].state, 'open');
    });

    await t.test('detached completion from B writes the trip once into A', async () => {
      const detached = (await rows(
        `SELECT * FROM detached_open_trips WHERE workspace_id=$1
            AND source_shift_id=$2 AND state='open'`,
        [WORKSPACE, shiftA],
      ))[0];
      assert.ok(detached);
      const bStatusBefore = await statusRow(trucks.transfer);
      const bCoreBefore = await coreSnapshot(shiftB);
      const aLogsBefore = (await rows(
        'SELECT * FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id COLLATE "C"',
        [WORKSPACE, shiftA],
      )).length;

      // foreman B is not a member of A: the right comes from the current
      // destination membership, and the saved stage is the only allowed action.
      const completed = await completeDetachedTrip(pool, actors[ids.foremanB], {
        workspaceId: WORKSPACE,
        sourceShiftId: shiftA,
        cycleId: detached.cycle_id,
        operationId: nextOperation('complete_detached'),
        protocolVersion: 2,
        truckId: trucks.transfer,
        destinationShiftId: shiftB,
        type: 'load',
        createdAt: Date.now(),
        expectedSourceShiftRevision: await shiftRevision(shiftA),
        expectedDestinationShiftRevision: await shiftRevision(shiftB),
        expectedDetachedCycleRevision: Number(detached.cycle_revision),
      });
      assert.equal(completed.result.state, 'completed');
      assert.equal(completed.result.sourceShiftId, shiftA);
      assert.equal(completed.result.destinationShiftId, shiftB);

      const aLogsAfter = await rows(
        'SELECT * FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id COLLATE "C"',
        [WORKSPACE, shiftA],
      );
      assert.equal(aLogsAfter.length, aLogsBefore + 1);
      const detachedLog = aLogsAfter.find(row => row.truck_id === trucks.transfer);
      assert.ok(detachedLog, 'the completed trip lands in A');
      assert.equal(completed.result.log.logId, detachedLog.log_id);
      assert.equal(completed.result.detachedCycleRevision, Number(detached.cycle_revision) + 1);
      assert.equal(detachedLog.shift_id, shiftA);
      assert.equal(detachedLog.payload.shiftId, shiftA);
      // The trip carries the truck's own volume, read from its row, never a
      // number typed into the test.
      const truckVolume = Number((await rows(
        'SELECT payload FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2',
        [WORKSPACE, trucks.transfer],
      ))[0].payload.defaultVol);
      assert.ok(truckVolume > 0);
      assert.equal(Number(detachedLog.payload.volume), truckVolume);
      // Exactly one row with this log id in the whole workspace.
      assert.equal(Number((await rows(
        'SELECT count(*)::int AS total FROM line_logs WHERE workspace_id=$1 AND log_id=$2',
        [WORKSPACE, detachedLog.log_id],
      ))[0].total), 1);

      // B's core surface is untouched; only the cross-shift detached row moves.
      await checkBCore(bCoreBefore, 'detached completion');
      const bStatusAfter = await statusRow(trucks.transfer);
      assert.deepEqual(bStatusAfter, bStatusBefore, 'completion never edits the destination status');
      const completedRow = (await rows(
        'SELECT * FROM detached_open_trips WHERE workspace_id=$1 AND source_shift_id=$2 AND cycle_id=$3',
        [WORKSPACE, shiftA, detached.cycle_id],
      ))[0];
      assert.equal(completedRow.state, 'completed');
      assert.equal(Number(completedRow.cycle_revision), Number(detached.cycle_revision) + 1);
      assert.equal(completedRow.completed_by_uid, ids.foremanB);
      assert.equal(completedRow.completion_operation_id, completed.operationId);

      // A second completion is a stable refusal, not a second trip.
      await assert.rejects(
        completeDetachedTrip(pool, actors[ids.foremanB], {
          workspaceId: WORKSPACE,
          sourceShiftId: shiftA,
          cycleId: detached.cycle_id,
          operationId: nextOperation('complete_detached_again'),
          protocolVersion: 2,
          truckId: trucks.transfer,
          destinationShiftId: shiftB,
          type: 'load',
          createdAt: Date.now(),
          expectedSourceShiftRevision: await shiftRevision(shiftA),
          expectedDestinationShiftRevision: await shiftRevision(shiftB),
          expectedDetachedCycleRevision: Number(completedRow.cycle_revision),
        }),
        error => error?.code === 'detached-trip-completed' && error?.status === 409,
      );

      trapB3 = await snapshot(shiftB);
      assert.equal(trapB3.detached.length, 1);
      assert.equal(trapB3.detached[0].state, 'completed');
      assert.deepEqual(trapB3.statuses, trapB2.statuses);
      assert.deepEqual(trapB3.logs, trapB2.logs);
    });

    await t.test('A prepares, confirms material and finishes without touching B', async () => {
      const prepared = await prepareShiftClose(pool, actors[ids.foremanA], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('prepare'),
        protocolVersion: 2,
        expectedShiftRevision: await shiftRevision(shiftA),
      });
      assert.equal(prepared.result.phase, 'prepared');
      preparedArchiveRevision = prepared.result.archiveRevision;
      await checkB(trapB3, 'A close prepare');

      // The prepared revision is the newest row the writer just appended, so the
      // test never types an archive revision number.
      const archiveId = prepared.result.archiveId;
      const chain = await revisionsFor(archiveId);
      assert.equal(prepared.result.archiveRevision, Number(chain.at(-1).archive_revision));
      const revision = await readArchiveRevision(
        pool, WORKSPACE, archiveId, prepared.result.archiveRevision,
      );
      assert.ok(revision);
      assert.equal(revision.revision, prepared.result.archiveRevision);
      const volume = Number(revision.payload.totalVolume);
      assert.ok(Number.isFinite(volume) && volume > 0);
      // A's archive is built from A's own rows only: its trips are exactly the A
      // logs, never a B trip.
      const aLogIds = new Set((await rows(
        'SELECT log_id FROM line_logs WHERE workspace_id=$1 AND shift_id=$2',
        [WORKSPACE, shiftA],
      )).map(row => row.log_id));
      assert.equal(revision.payload.logs.length, aLogIds.size);
      assert.ok(revision.payload.logs.every(log => aLogIds.has(log.id)));
      assert.ok(revision.payload.logs.every(log => log.truckId !== trucks.b));
      await checkB(trapB3, 'A explicit archive revision read');

      const material = await confirmShiftMaterial(pool, actors[ids.foremanA], {
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
      // The marker row is the one the confirmation just wrote.
      const marker = (await rows(
        `SELECT revision,volume,source_archive_revision FROM shift_material_markers
          WHERE workspace_id=$1 AND shift_id=$2`,
        [WORKSPACE, shiftA],
      ))[0];
      assert.ok(marker, 'the confirmation wrote the marker');
      assert.equal(material.result.materialMarkerRevision, Number(marker.revision));
      assert.equal(Number(material.result.volume), volume);
      assert.equal(Number(marker.volume), volume);
      assert.equal(Number(marker.source_archive_revision), revision.revision);
      await checkB(trapB3, 'A material confirm');

      // The last current status of A before the close: its counters are the ones
      // a post-close line command would name, so no revision is typed by hand.
      const lastStatusA = await statusRow(trucks.a);
      const finished = await finishShiftClose(pool, actors[ids.foremanA], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('finish'),
        protocolVersion: 2,
        closeToken: prepared.result.closeToken,
        expectedShiftRevision: prepared.result.shiftRevision,
        expectedArchiveRevision: revision.revision,
        expectedMaterialMarkerRevision: material.result.materialMarkerRevision,
      });
      assert.equal(finished.result.phase, 'closed');
      await checkB(trapB3, 'A close finish');

      const closed = await shiftRow(shiftA);
      assert.equal(closed.state, 'closed');
      assert.equal(closed.closed_by_uid, ids.foremanA);
      assert.ok(closed.closed_at instanceof Date);
      // Only A's current statuses were removed; logs, memberships and receipts stay.
      assert.equal((await rows(
        'SELECT 1 FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2',
        [WORKSPACE, shiftA],
      )).length, 0);
      assert.equal((await rows(
        'SELECT 1 FROM line_logs WHERE workspace_id=$1 AND shift_id=$2',
        [WORKSPACE, shiftA],
      )).length, aLogIds.size);
      assert.ok((await rows(
        'SELECT 1 FROM shift_members WHERE workspace_id=$1 AND shift_id=$2',
        [WORKSPACE, shiftA],
      )).length >= 2);
      // A's close created no archive for B.
      assert.equal(await seriesFor(`closed_${shiftB}`), null);

      // After finish the shift answers its terminal code: a line command is 410,
      // a new prepare is the close domain's 409 shift-closed.
      await assert.rejects(
        submitLineOperationV2(pool, actors[ids.foremanA], {
          workspaceId: WORKSPACE,
          shiftId: shiftA,
          operationId: nextOperation('closed_line'),
          protocolVersion: 2,
          type: 'arrive',
          truckId: trucks.a,
          expectedShiftRevision: await shiftRevision(shiftA),
          expectedStatusRevision: Number(lastStatusA.status_revision),
          expectedCycleRevision: Number(lastStatusA.cycle_revision),
          expectedTtnRevision: Number(lastStatusA.ttn_revision),
          createdAt: Date.now(),
          cycleMinutes: 30,
          wantArrived: true,
        }),
        error => error?.code === 'shift-closed' && error?.status === 410,
      );
      await assert.rejects(
        prepareShiftClose(pool, actors[ids.foremanA], {
          workspaceId: WORKSPACE,
          shiftId: shiftA,
          operationId: nextOperation('prepare_closed'),
          protocolVersion: 2,
          expectedShiftRevision: await shiftRevision(shiftA),
        }),
        error => error?.code === 'shift-closed' && error?.status === 409,
      );
      await checkB(trapB3, 'terminal refusals on A');
    });

    await t.test('A archive latest and explicit revision are read-only', async () => {
      const archiveId = `closed_${shiftA}`;
      const series = await seriesFor(archiveId);
      assert.equal(Number(series.latest_finalized_revision), preparedArchiveRevision);
      const latest = await readLatestFinalizedArchive(pool, WORKSPACE, archiveId);
      assert.ok(latest);
      assert.equal(latest.sourceShiftId, shiftA);
      assert.equal(latest.revision, preparedArchiveRevision);
      assert.equal(latest.sha256, series.latest_finalized_sha256);

      const explicit = await readArchiveRevision(pool, WORKSPACE, archiveId, preparedArchiveRevision);
      assert.equal(explicit.sha256, latest.sha256);
      assert.deepEqual(explicit.payload, latest.payload);
      const revisionsBefore = await revisionsFor(archiveId);
      const history = await readArchiveHistory(pool, WORKSPACE, archiveId);
      assert.deepEqual(history.revisions.map(row => row.revision), [preparedArchiveRevision]);
      assert.equal(history.latestFinalizedRevision, preparedArchiveRevision);

      // Neither read moved the default pointer or rewrote the immutable bytes.
      const after = await seriesFor(archiveId);
      assert.equal(Number(after.latest_finalized_revision), preparedArchiveRevision);
      assert.equal(after.latest_finalized_sha256, series.latest_finalized_sha256);
      assert.deepEqual(await revisionsFor(archiveId), revisionsBefore);
      assert.deepEqual(
        (await readArchiveRevision(pool, WORKSPACE, archiveId, preparedArchiveRevision)).payload,
        explicit.payload,
      );
      await checkB(trapB3, 'A archive reads');
    });

    await t.test('restored context of A edits trips and TTN without touching active rows', async () => {
      const archiveId = `closed_${shiftA}`;
      const series = await seriesFor(archiveId);
      const latest = await readLatestFinalizedArchive(pool, WORKSPACE, archiveId);
      assert.ok(latest);
      const archiveBytes = (await rows(
        `SELECT payload_bytes FROM shift_archive_revisions
          WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=$3`,
        [WORKSPACE, archiveId, latest.revision],
      ))[0].payload_bytes;
      const archive = JSON.parse(
        Buffer.isBuffer(archiveBytes) ? archiveBytes.toString('utf8') : Buffer.from(archiveBytes).toString('utf8'),
      );
      assert.equal(archive.sourceShiftId, shiftA);
      assert.ok(archive.logs.length > 0);
      assert.ok(archive.logs.every(log => log.truckId !== trucks.b));

      // The canonical restore creates a dedicated context, never a legacy shift
      // row (design §4.6). Production has no "create restored context" command
      // yet: the fixture seeds exactly the rows the restore path writes, from the
      // real published archive bytes, and every read/edit below is a real service.
      const closed = await shiftRow(shiftA);
      const closedDate = (await rows(
        `SELECT to_char(work_date,'YYYY-MM-DD') AS work_date_text
           FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
        [WORKSPACE, shiftA],
      ))[0].work_date_text;
      const restoredContextId = `restored_${shiftA}`;
      await pool.query(
        `INSERT INTO restored_shift_contexts(
           workspace_id,restored_context_id,archive_id,source_shift_id,mode,context_state,
           original_opened_by_uid,original_opened_by_name_snapshot,original_identity_resolution,
           original_shift_type,original_shift_type_resolution,
           restored_by_uid,restored_by_name_snapshot,restored_at,
           archive_revision,context_revision,restore_operation_id,
           source_state_snapshot,source_shift_revision,opened_at_snapshot,
           object_id,object_name,work_date)
         VALUES($1,$2,$3,$4,'parallel','open',$5,$6,'source','day','source',
                $7,'Acceptance admin',now(),$8,1,$9,$10,$11,$12,$13,$14,$15)`,
        [
          WORKSPACE, restoredContextId, archiveId, shiftA,
          ids.foremanA, 'Acceptance foreman A',
          ids.admin, latest.revision, nextOperation('restore'),
          {state: 'closed', shiftRevision: Number(closed.revision)},
          Number(closed.revision), closed.opened_at,
          closed.object_id, closed.object_name_snapshot, closedDate,
        ],
      );
      for (const log of archive.logs) {
        await pool.query(
          `INSERT INTO restored_context_logs(
             workspace_id,restored_context_id,log_id,truck_id,payload,log_revision,
             source_log_id,created_from_archive_revision)
           VALUES($1,$2,$3,$4,$5,1,$3,$6)`,
          [WORKSPACE, restoredContextId, log.id, log.truckId, log, latest.revision],
        );
      }
      for (const [truckId, ttnStatus] of Object.entries(archive.ttnStatus ?? {})) {
        await pool.query(
          `INSERT INTO restored_context_status_snapshots(
             workspace_id,restored_context_id,truck_id,payload,
             status_revision,cycle_revision,ttn_revision)
           VALUES($1,$2,$3,$4,1,1,1)`,
          [WORKSPACE, restoredContextId, truckId, {truckId, ttnStatus}],
        );
      }

      // The seeded counters are read back from the rows, never typed here.
      const seededContext = (await rows(
        `SELECT context_revision FROM restored_shift_contexts
          WHERE workspace_id=$1 AND restored_context_id=$2`,
        [WORKSPACE, restoredContextId],
      ))[0];
      const seededLogRevisions = new Map((await rows(
        `SELECT log_id,log_revision FROM restored_context_logs
          WHERE workspace_id=$1 AND restored_context_id=$2`,
        [WORKSPACE, restoredContextId],
      )).map(row => [row.log_id, Number(row.log_revision)]));

      const beforeA = await snapshot(shiftA);
      const context = await readRestoredContext(pool, {
        workspaceId: WORKSPACE,
        restoredContextId,
      });
      assert.equal(context.archiveId, archiveId);
      assert.equal(context.sourceShiftId, shiftA);
      assert.equal(context.archiveRevision, latest.revision);
      assert.equal(context.archiveSha256, series.latest_finalized_sha256);
      assert.equal(context.baseArchiveRevision, latest.revision);
      assert.equal(context.baseIsLatest, true);
      assert.equal(context.contextState, 'open');
      assert.equal(context.contextRevision, Number(seededContext.context_revision));
      assert.equal(context.trips.length, archive.logs.length);
      assert.ok(context.trips.every(item => archive.logs.some(log => log.id === item.logId)));
      assert.ok(context.trips.every(item => item.truckId !== trucks.b));
      assert.equal(context.provenance.originalOpenedByUid, ids.foremanA);
      assert.equal(context.provenance.originalShiftType, 'day');
      assert.equal(context.provenance.unresolvedAuthor, false);
      await checkB(trapB3, 'restored context read of A');
      await checkA(beforeA, 'restored context read of A');

      // trip.update goes to the dedicated context child, never to `line_logs`.
      const trip = context.trips[0];
      const updateOperation = nextOperation('restored_trip');
      const updateCommand = {
        operationId: updateOperation,
        protocolVersion: 2,
        type: 'trip.update',
        recordId: trip.logId,
        expectedContextRevision: context.contextRevision,
        expectedBaseArchiveRevision: context.archiveRevision,
        expectedBaseSha256: context.archiveSha256,
        data: {volume: 7, timeStr: '09:15', comment: 'restored edit'},
      };
      const updated = await submitRestoredCorrection(
        pool, {uid: ids.admin, workspaceId: WORKSPACE}, restoredContextId, updateCommand,
      );
      assert.equal(updated.result.type, 'trip.update');
      assert.equal(updated.result.contextRevision, context.contextRevision + 1);
      assert.equal(Number(updated.result.log.volume), updateCommand.data.volume);
      assert.equal(updated.result.log.comment, 'restored edit');
      await checkB(trapB3, 'restored trip update of A');
      await checkA(beforeA, 'restored trip update of A');
      assert.equal(Number((await rows(
        'SELECT log_revision FROM restored_context_logs WHERE workspace_id=$1 AND restored_context_id=$2 AND log_id=$3',
        [WORKSPACE, restoredContextId, trip.logId],
      ))[0].log_revision), seededLogRevisions.get(trip.logId) + 1);

      // TTN correction: the immutable snapshot stays, the journal carries it.
      const ttnOperation = nextOperation('restored_ttn');
      const ttnCommand = {
        operationId: ttnOperation,
        protocolVersion: 2,
        type: 'ttn.update',
        recordId: trucks.a,
        expectedContextRevision: updated.result.contextRevision,
        expectedBaseArchiveRevision: context.archiveRevision,
        expectedBaseSha256: context.archiveSha256,
        data: {ttnStatus: 'pending'},
      };
      const ttnUpdated = await submitRestoredCorrection(
        pool, {uid: ids.admin, workspaceId: WORKSPACE}, restoredContextId, ttnCommand,
      );
      assert.equal(ttnUpdated.result.type, 'ttn.update');
      assert.equal(ttnUpdated.result.contextRevision, updated.result.contextRevision + 1);
      assert.equal(ttnUpdated.result.ttn.ttnStatus, 'pending');
      await checkB(trapB3, 'restored ttn update of A');
      await checkA(beforeA, 'restored ttn update of A');
      const snapshotTtn = (await rows(
        'SELECT payload FROM restored_context_status_snapshots WHERE workspace_id=$1 AND restored_context_id=$2 AND truck_id=$3',
        [WORKSPACE, restoredContextId, trucks.a],
      ))[0].payload;
      assert.equal(snapshotTtn.ttnStatus, true, 'the immutable source snapshot is never rewritten');

      // Replay returns the same result and does not move the context revision.
      const replay = await submitRestoredCorrection(
        pool, {uid: ids.admin, workspaceId: WORKSPACE}, restoredContextId, ttnCommand,
      );
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, ttnUpdated.result);
      assert.equal(Number((await rows(
        'SELECT context_revision FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2',
        [WORKSPACE, restoredContextId],
      ))[0].context_revision), ttnUpdated.result.contextRevision);

      const reread = await readRestoredContext(pool, {
        workspaceId: WORKSPACE,
        restoredContextId,
      });
      assert.equal(reread.contextRevision, ttnUpdated.result.contextRevision);
      assert.equal(
        Number(reread.trips.find(item => item.logId === trip.logId).payload.volume),
        updateCommand.data.volume,
      );
      assert.equal(reread.ttn.find(item => item.truckId === trucks.a).ttnStatus, 'pending');
      assert.equal(reread.ttn.find(item => item.truckId === trucks.a).source, 'history');
      assert.equal(reread.provenance.originalOpenedByUid, ids.foremanA);

      // Restored edits never publish a new archive revision or move the pointer.
      const after = await seriesFor(archiveId);
      assert.equal(Number(after.latest_finalized_revision), preparedArchiveRevision);
      assert.equal(after.latest_finalized_sha256, series.latest_finalized_sha256);
      assert.equal(
        (await readArchiveRevision(pool, WORKSPACE, archiveId, preparedArchiveRevision)).sha256,
        latest.sha256,
      );
      assert.deepEqual(
        (await readArchiveHistory(pool, WORKSPACE, archiveId)).revisions.map(row => row.revision),
        [preparedArchiveRevision],
      );
    });

    // Freeze A as closed before proving that B keeps working.
    trapA = await snapshot(shiftA);

    await t.test('closed A stays frozen while B remains fully operational', async () => {
      // B is still an active shift of the same object and date and can take a
      // new truck and a full new cycle after A is closed.
      await assign(shiftB, trucks.extra, actors[ids.foremanB]);
      await fullCycle(shiftB, trucks.extra, actors[ids.foremanB]);
      const bLog = (await rows(
        `SELECT log_id,shift_id,truck_id,payload FROM line_logs
          WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id COLLATE "C"`,
        [WORKSPACE, shiftB],
      )).find(row => row.truck_id === trucks.extra);
      assert.ok(bLog, 'B wrote its own new trip');
      assert.equal(bLog.shift_id, shiftB);
      assert.equal((await shiftRow(shiftB)).state, 'active');

      // No B row of the closed A shift moved, and A did not absorb B's new trip.
      await checkA(trapA, 'B new cycle after A closed');
      assert.equal((await rows(
        'SELECT 1 FROM line_logs WHERE workspace_id=$1 AND shift_id=$2 AND log_id=$3',
        [WORKSPACE, shiftA, bLog.log_id],
      )).length, 0);

      const bItems = (await listVisibleShifts(pool, actors[ids.foremanB], {workspaceId: WORKSPACE})).items;
      assert.deepEqual(bItems.map(item => item.shiftId), [shiftB]);
      const adminItems = (await listVisibleShifts(pool, admin, {workspaceId: WORKSPACE})).items;
      assert.deepEqual(adminItems.map(item => item.shiftId), [shiftB]);
      // The closed A is not in the active list, but stays readable with its history.
      const closedA = await readShiftSnapshot(pool, actors[ids.foremanA], {
        workspaceId: WORKSPACE, shiftId: shiftA,
      });
      assert.equal(closedA.shift.state, 'closed');
      assert.equal(closedA.statuses.length, 0);
      assert.ok(closedA.logs.length >= 2);
      assert.equal(await seriesFor(`closed_${shiftB}`), null);
    });
  } finally {
    await pool.end();
  }
});
