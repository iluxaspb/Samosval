import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrationsThrough} from './helpers/isolated-db.mjs';
import {loadActor} from '../src/shift-access-v2.mjs';
import {
  addShiftMember,
  changeShiftObject,
  createShift,
} from '../src/shift-members-v2.mjs';
import {assignTruck} from '../src/shift-trucks-v2.mjs';
import {submitLineOperationV2} from '../src/line-store-v2.mjs';
import {readArchiveRevision, readLatestFinalizedArchive} from '../src/archive-latest.mjs';
import {confirmShiftMaterial, prepareShiftClose, finishShiftClose} from '../src/shift-close-v2.mjs';
import {closeShiftOperation} from '../src/shift-close.mjs';

// Two-phase close and the material marker (design §3.1, §4.5, §4.6, §5.5, §7,
// §11, §15, plan Task 22).
//
// The root runs on the frozen S25 baseline and applies 026–029 through the
// privileged bootstrap connection; every assertion stays on the app role.
//
// Covered contract (the nine scope rules of the task brief):
//   1. prepare moves only the addressed shift active → closing, bumps its
//      revision once, freezes that shift's line/member/truck/object commands and
//      leaves another active shift fully working;
//   2. pending server receipts and open detached trips (source OR destination)
//      refuse prepare with a stable 409 before any CAS counter is read;
//   3. finish requires the exact token and all three revisions; a mismatch is a
//      `revision-conflict` with the exact expected*/actual* field and no partial
//      write;
//   4. an empty shift closes without a marker, a shift with trips requires a
//      confirmed marker at the expected revision;
//   5. finish deletes only this shift's current statuses: the shift row,
//      memberships, logs, receipts, audit, archive and marker survive, and a trap
//      shift is byte-for-byte identical (no workspace-wide DELETE);
//   6. a historical row never enters close and a closed row answers a stable 409;
//   7. replay of both phases returns the stored result, a different body with the
//      same operation id is `operation-id-reused`, and a second finish is a
//      stable 409 without a second archive revision;
//   8. access is recomputed per call: a member removed between prepare and finish
//      loses the right (403) while admin keeps it;
//   9. the archive written by finish matches the source exactly and becomes the
//      latest finalized revision for default consumers;
//  10. the `material` command is the only way a shift with trips gets a marker:
//      it works in `closing` only, needs the exact token and archive revision,
//      inserts at `null`/updates at `revision`, bumps the marker revision by one
//      without creating a second row, and is replay-safe.
//
// Numbers (revisions, counters, volumes) are derived from the actual rows, never
// hardcoded: a hardcoded revision silently turns a refusal test into a real
// mutation (docs/opyt-oshibok.md, lesson 50.1).

const WORKSPACE = 'main_workspace';

function moscowDate(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ms);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('v2 two-phase shift close and material marker', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const pool = new pg.Pool({connectionString: process.env.TEST_DATABASE_URL, max: 5});
  pool.on('error', () => {});
  const prefix = 'close_' + randomUUID().replaceAll('-', '');
  const ids = {
    admin: prefix + '_admin',
    senior: prefix + '_senior',
    foreman: prefix + '_foreman',
    foreman2: prefix + '_foreman2',
  };
  const objects = {
    a: prefix + '_object_a',
    c: prefix + '_object_c',
    d: prefix + '_object_d',
    e: prefix + '_object_e',
    f: prefix + '_object_f',
    h: prefix + '_object_h',
    m: prefix + '_object_m',
    p: prefix + '_object_p',
    q: prefix + '_object_q',
    t: prefix + '_object_t',
  };
  const trucks = {
    a: prefix + '_truck_a',
    a2: prefix + '_truck_a2',
    c: prefix + '_truck_c',
    dq: prefix + '_truck_dq',
    f: prefix + '_truck_f',
    m: prefix + '_truck_m',
    t: prefix + '_truck_t',
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

  const shiftRow = async shiftId => (await pool.query(
    `SELECT workspace_id,shift_id,state,revision,object_id,shift_type,
            closing_started_at,closing_by_uid,closed_at,closed_by_uid,
            close_token,close_token_operation_id,payload
       FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
    [WORKSPACE, shiftId],
  )).rows[0];
  const shiftRevision = async shiftId => Number((await shiftRow(shiftId)).revision);
  const statusRow = async truckId => (await pool.query(
    `SELECT shift_id,status_revision,cycle_revision,ttn_revision,payload
       FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2`,
    [WORKSPACE, truckId],
  )).rows[0];
  const statusRows = async shiftId => (await pool.query(
    `SELECT truck_id,shift_id,status_revision,cycle_revision,ttn_revision,payload
       FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2
      ORDER BY truck_id COLLATE "C"`,
    [WORKSPACE, shiftId],
  )).rows;
  const statusCount = async () => Number((await pool.query(
    'SELECT count(*)::int AS total FROM line_truck_statuses WHERE workspace_id=$1',
    [WORKSPACE],
  )).rows[0].total);
  const logsFor = async shiftId => (await pool.query(
    `SELECT log_id,shift_id,truck_id,payload FROM line_logs
      WHERE workspace_id=$1 AND shift_id=$2 ORDER BY log_id COLLATE "C"`,
    [WORKSPACE, shiftId],
  )).rows;
  const receiptRow = async operationId => (await pool.query(
    'SELECT uid,request_hash,shift_id,result FROM shift_operation_receipts WHERE workspace_id=$1 AND operation_id=$2',
    [WORKSPACE, operationId],
  )).rows[0];
  const auditRow = async operationId => (await pool.query(
    'SELECT uid,type,before_data,after_data FROM workspace_service_audit WHERE workspace_id=$1 AND operation_id=$2',
    [WORKSPACE, operationId],
  )).rows[0];
  const seriesRow = async archiveId => (await pool.query(
    `SELECT source_shift_id,latest_finalized_revision,latest_finalized_sha256,series_revision
       FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2`,
    [WORKSPACE, archiveId],
  )).rows[0];
  const revisionCount = async archiveId => Number((await pool.query(
    'SELECT count(*)::int AS total FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2',
    [WORKSPACE, archiveId],
  )).rows[0].total);
  const markerRow = async shiftId => (await pool.query(
    `SELECT material_id,source_archive_revision,volume,revision,confirmed_by_uid
       FROM shift_material_markers WHERE workspace_id=$1 AND shift_id=$2`,
    [WORKSPACE, shiftId],
  )).rows[0];
  const archiveAuditRows = async archiveId => (await pool.query(
    `SELECT source_shift_id,before_state,after_state,actor_uid FROM archive_audit
      WHERE workspace_id=$1 AND archive_id=$2 ORDER BY audit_id`,
    [WORKSPACE, archiveId],
  )).rows;
  // One shift's whole line, byte for byte: the trap test compares this object.
  const lineState = async shiftId => ({
    shift: await shiftRow(shiftId),
    statuses: await statusRows(shiftId),
    logs: await logsFor(shiftId),
  });

  const createBody = (objectId, shiftType = 'day') => ({
    operationId: nextOperation(`create_${shiftType}_${objectId.slice(-2)}`),
    protocolVersion: 2,
    objectId,
    workDate,
    shiftType,
    cycleMinutes: 30,
  });
  const create = async (objectId, shiftType = 'day') => {
    const created = await createShift(pool, actors[ids.senior], {
      workspaceId: WORKSPACE,
      ...createBody(objectId, shiftType),
    });
    return created.result.shift.shiftId;
  };
  const assign = async (shiftId, truckId) => assignTruck(pool, actors[ids.senior], {
    workspaceId: WORKSPACE,
    shiftId,
    truckId,
    operationId: nextOperation(`assign_${truckId.slice(-6)}`),
    protocolVersion: 2,
    expectedShiftRevision: await shiftRevision(shiftId),
  });
  const lineCommand = async ({shiftId, truckId, type, operationId, createdAt, ...fields}) => {
    const row = await statusRow(truckId);
    return submitLineOperationV2(pool, actors[ids.senior], {
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
    });
  };
  // A complete ordinary cycle: arrive → load → collected TTN. It leaves one
  // non-GAI trip and a `ttnStatus` that the archive must reproduce exactly.
  const fullCycle = async (shiftId, truckId) => {
    const arrivedAt = Date.now();
    await lineCommand({
      shiftId, truckId, type: 'arrive', operationId: nextOperation(`arrive_${truckId.slice(-6)}`),
      createdAt: arrivedAt, wantArrived: true, cycleMinutes: 30,
    });
    const arrived = await statusRow(truckId);
    const loadedAt = Number(arrived.payload.arriveTimestamp) + 1;
    await lineCommand({
      shiftId, truckId, type: 'load', operationId: nextOperation(`load_${truckId.slice(-6)}`),
      createdAt: loadedAt, cycleMinutes: 30,
    });
    const loaded = await statusRow(truckId);
    await lineCommand({
      shiftId, truckId, type: 'ttn', operationId: nextOperation(`ttn_${truckId.slice(-6)}`),
      createdAt: loadedAt + 1, collect: true, cycleMinutes: 30,
    });
    return {loadedAt, loaded};
  };
  const prepare = (shiftId, actor, overrides = {}) => prepareShiftClose(pool, actor, {
    workspaceId: WORKSPACE,
    shiftId,
    operationId: nextOperation('prepare'),
    protocolVersion: 2,
    expectedShiftRevision: 1,
    ...overrides,
  });
  const finish = (shiftId, actor, overrides = {}) => finishShiftClose(pool, actor, {
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
  const confirmMaterial = (shiftId, actor, overrides = {}) => confirmShiftMaterial(pool, actor, {
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
  // Kept only for the schema proof below: a direct second INSERT must lose to the
  // (workspace_id, shift_id) primary key, so the table cannot hold two transfers
  // for one shift no matter which writer tries. Every contract path uses the
  // `material` command instead.
  const insertMarker = async (shiftId, archivePayload, actor) => {
    await pool.query(
      `INSERT INTO shift_material_markers(
         workspace_id,shift_id,material_id,source_archive_revision,volume,revision,confirmed_at,confirmed_by_uid)
       VALUES($1,$2,$3,$4,$5,1,now(),$6)`,
      [WORKSPACE, shiftId, `material_${shiftId.slice(-8)}`, 1,
        Number(archivePayload.totalVolume), actor.uid],
    );
  };

  const shiftA = await (async () => {
    try {
      await applyMigrationsThrough(29);
      await pool.query('INSERT INTO workspaces(id) VALUES ($1) ON CONFLICT(id) DO NOTHING', [WORKSPACE]);
      for (const [uid, name, role] of [
        [ids.admin, 'Close admin', 'admin'],
        [ids.senior, 'Close senior', 'senior_foreman'],
        [ids.foreman, 'Close foreman', 'foreman'],
        [ids.foreman2, 'Close foreman two', 'foreman'],
      ]) {
        await pool.query(
          'INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,$4,$5)',
          [uid, `${uid}@example.test`, name, role, 'active'],
        );
      }
      for (const [objectId, name] of Object.entries(objects).map(([key, id]) => [id, `Object ${key}`])) {
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
      for (const role of ['senior_foreman', 'foreman']) {
        for (const action of [
          'start_shift', 'close_shift', 'edit_line', 'tab_line', 'manage_trucks',
          'action_arrive', 'action_load', 'action_ttn', 'line_timer_reset',
          'manage_shift_members',
        ]) {
          await pool.query(
            `INSERT INTO role_permissions(role,action,allowed) VALUES($1,$2,true)
             ON CONFLICT(role,action) DO UPDATE SET allowed=true`,
            [role, action],
          );
        }
      }
      for (const uid of Object.values(ids)) actors[uid] = await loadActor(pool, uid);
      return await create(objects.a);
    } catch (error) {
      await pool.end().catch(() => {});
      throw error;
    }
  })();

  try {
    const shiftC = await create(objects.c);
    const shiftD = await create(objects.d);
    const shiftE = await create(objects.e);
    const shiftF = await create(objects.f);
    const shiftH = await create(objects.h);
    const shiftP = await create(objects.p);
    const shiftQ = await create(objects.q);
    const shiftT = await create(objects.t);

    // Shift A: one complete cycle plus a second assigned truck, and foreman as a
    // member. It is prepared by the foreman, so rule 1 and rule 8 share it.
    await assign(shiftA, trucks.a);
    await assign(shiftA, trucks.a2);
    await fullCycle(shiftA, trucks.a);
    const added = await addShiftMember(pool, actors[ids.senior], {
      workspaceId: WORKSPACE,
      shiftId: shiftA,
      uid: ids.foreman,
      operationId: nextOperation('add_foreman'),
      protocolVersion: 2,
      expectedShiftRevision: await shiftRevision(shiftA),
      expectedMembershipRevision: null,
    });
    assert.equal(added.result.membership.revision, 1);

    // Shift C is the trap: it keeps working while A is closing and its whole
    // line is compared byte for byte after another shift is finished.
    await assign(shiftC, trucks.c);
    const cBefore = await lineState(shiftC);
    const cRevisionBefore = Number(cBefore.shift.revision);
    await lineCommand({
      shiftId: shiftC, truckId: trucks.c, type: 'arrive',
      operationId: nextOperation('trap_arrive'), createdAt: Date.now(),
      wantArrived: true, cycleMinutes: 30,
    });
    const cAfter = await lineState(shiftC);
    assert.equal(Number(cAfter.shift.revision), cRevisionBefore + 1,
      'an unrelated shift still accepts a line operation and its revision advances');
    assert.equal(cAfter.statuses.length, 1);
    const trap = await lineState(shiftC);

    await t.test('prepare moves only the addressed shift to closing and freezes its commands', async () => {
      const before = await shiftRow(shiftA);
      const revision = Number(before.revision);
      const prepared = await prepare(shiftA, actors[ids.foreman], {expectedShiftRevision: revision});
      assert.equal(prepared.replayed, false);
      assert.equal(prepared.result.phase, 'prepared');
      assert.equal(prepared.result.shiftRevision, revision + 1);
      assert.equal(prepared.result.archiveId, `closed_${shiftA}`);
      assert.equal(prepared.result.archiveRevision, 1);
      assert.equal(prepared.result.materialMarkerRevision, null);
      assert.match(prepared.result.closeToken, /^[A-Za-z0-9_-]{16,160}$/);

      const after = await shiftRow(shiftA);
      assert.equal(after.state, 'closing');
      assert.equal(Number(after.revision), revision + 1, 'prepare bumps the shift revision exactly once');
      assert.equal(after.close_token, prepared.result.closeToken);
      assert.equal(after.close_token_operation_id, prepared.operationId);
      assert.equal(after.payload.closing, true);
      assert.equal(after.payload.closingByUid, ids.foreman);
      assert.equal(after.closing_by_uid, ids.foreman);
      assert.notEqual(after.closing_started_at, null);

      const series = await seriesRow(`closed_${shiftA}`);
      assert.ok(series, 'prepare writes the archive series');
      assert.equal(series.source_shift_id, shiftA);
      assert.equal(series.latest_finalized_revision, null, 'prepare does not publish the archive');
      assert.equal(await revisionCount(`closed_${shiftA}`), 1);

      // Line command: the shift itself answers shift-closing.
      const lineError = await expectError(lineCommand({
        shiftId: shiftA, truckId: trucks.a2, type: 'arrive',
        operationId: nextOperation('frozen_arrive'), createdAt: Date.now(),
        wantArrived: true, cycleMinutes: 30,
      }), 'shift-closing', 409);
      assert.deepEqual(lineError.details, {shiftId: shiftA, state: 'closing'});
      // Member, truck and object commands are frozen by the same lifecycle gate.
      await expectError(addShiftMember(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        uid: ids.foreman2,
        operationId: nextOperation('frozen_member'),
        protocolVersion: 2,
        expectedShiftRevision: await shiftRevision(shiftA),
        expectedMembershipRevision: null,
      }), 'shift-closing', 409);
      await expectError(assign(shiftA, trucks.f), 'shift-closing', 409);
      await expectError(changeShiftObject(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: nextOperation('frozen_object'),
        protocolVersion: 2,
        objectId: objects.c,
        expectedShiftRevision: await shiftRevision(shiftA),
      }), 'shift-closing', 409);

      // The trap shift is untouched by A's prepare.
      assert.deepEqual(await lineState(shiftC), trap, 'preparing A changes nothing in C');
    });

    await t.test('prepare refuses pending receipts and open detached trips before any CAS', async () => {
      // A committed pending receipt is the only observable form of an
      // unconfirmed server operation; it is addressed by shift_id (029).
      const pendingOperation = nextOperation('pending_receipt');
      await pool.query(
        `INSERT INTO shift_operation_receipts(workspace_id,operation_id,uid,request_hash,shift_id,result)
         VALUES($1,$2,$3,$4,$5,'{}')`,
        [WORKSPACE, pendingOperation, ids.admin, sha256('pending'), shiftP],
      );
      const pBefore = await shiftRow(shiftP);
      const pendingError = await expectError(prepare(shiftP, actors[ids.senior], {
        operationId: nextOperation('pending_prepare'),
        expectedShiftRevision: Number(pBefore.revision) + 1,
      }), 'pending-operations', 409);
      assert.equal(pendingError.details.shiftId, shiftP);
      assert.deepEqual(await shiftRow(shiftP), pBefore, 'a refused prepare writes nothing');
      assert.equal(await seriesRow(`closed_${shiftP}`), undefined);

      await pool.query(
        'DELETE FROM shift_operation_receipts WHERE workspace_id=$1 AND operation_id=$2',
        [WORKSPACE, pendingOperation],
      );
      // With the gate clear, the stale revision is finally the reason.
      await expectError(prepare(shiftP, actors[ids.senior], {
        operationId: nextOperation('stale_prepare'),
        expectedShiftRevision: Number(pBefore.revision) + 1,
      }), 'shift-changed', 409);

      // Open detached trip: source D and destination Q are both blocked.
      await assign(shiftQ, trucks.dq);
      const dqStatus = await statusRow(trucks.dq);
      await pool.query(
        `INSERT INTO detached_open_trips(
           workspace_id,source_shift_id,cycle_id,truck_id,destination_shift_id,state,stage,
           cycle_revision,source_status_revision,source_cycle_revision,source_ttn_revision,
           payload,detached_by_uid,transfer_operation_id)
         VALUES($1,$2,$3,$4,$5,'open','load',1,1,1,1,$6::jsonb,$7,$8)`,
        [WORKSPACE, shiftD, `cycle_${prefix}`, trucks.dq, shiftQ,
          {truckId: trucks.dq, sourceShiftId: shiftD, stage: 'load'},
          ids.admin, nextOperation('transfer_fixture')],
      );
      assert.equal(Number(dqStatus.status_revision), 1);
      const dBefore = await shiftRow(shiftD);
      const qBefore = await shiftRow(shiftQ);
      const sourceError = await expectError(prepare(shiftD, actors[ids.senior], {
        operationId: nextOperation('detached_source'),
        expectedShiftRevision: Number(dBefore.revision) + 1,
      }), 'detached-trip-open', 409);
      assert.equal(sourceError.details.shiftId, shiftD);
      assert.equal(sourceError.details.sourceShiftId, shiftD);
      assert.equal(sourceError.details.destinationShiftId, shiftQ);
      const destinationError = await expectError(prepare(shiftQ, actors[ids.senior], {
        operationId: nextOperation('detached_destination'),
        expectedShiftRevision: Number(qBefore.revision) + 1,
      }), 'detached-trip-open', 409);
      assert.equal(destinationError.details.shiftId, shiftQ);
      assert.deepEqual(await shiftRow(shiftD), dBefore);
      assert.deepEqual(await shiftRow(shiftQ), qBefore);
      assert.equal(await seriesRow(`closed_${shiftD}`), undefined);
      assert.equal(await seriesRow(`closed_${shiftQ}`), undefined);
    });

    await t.test('finish requires the exact token and all revisions without a partial write', async () => {
      // Shift T: one complete cycle, prepared by the senior. Its archive
      // revision is written by prepare but not published.
      await assign(shiftT, trucks.t);
      await fullCycle(shiftT, trucks.t);
      const tRevision = await shiftRevision(shiftT);
      const prepared = await prepare(shiftT, actors[ids.senior], {expectedShiftRevision: tRevision});
      assert.equal(prepared.result.materialMarkerRevision, null);
      const archiveId = `closed_${shiftT}`;
      const revision = await readArchiveRevision(pool, WORKSPACE, archiveId, 1);
      assert.ok(revision, 'prepare writes immutable revision 1');
      assert.equal(revision.previousRevision, null);
      assert.equal(revision.payload.sourceShiftId, shiftT);
      assert.equal(await readLatestFinalizedArchive(pool, WORKSPACE, archiveId), null,
        'an unpublished candidate is not the default archive');

      const closingState = await lineState(shiftT);
      const closingRevision = Number(closingState.shift.revision);
      const latestSha = revision.sha256;

      // Replay of prepare: same operation id + same body returns the stored result.
      const replayPrepare = await prepareShiftClose(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftT,
        operationId: prepared.operationId,
        protocolVersion: 2,
        expectedShiftRevision: tRevision,
      });
      assert.equal(replayPrepare.replayed, true);
      assert.deepEqual(replayPrepare.result, prepared.result);
      // A different body with the same operation id is refused.
      await expectError(prepareShiftClose(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftT,
        operationId: prepared.operationId,
        protocolVersion: 2,
        expectedShiftRevision: tRevision + 1,
      }), 'operation-id-reused', 409);

      const noMarker = await expectError(finish(shiftT, actors[ids.senior], {
        closeToken: prepared.result.closeToken,
        expectedShiftRevision: closingRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 1,
      }), 'revision-conflict', 409);
      assert.deepEqual(noMarker.details, {
        expectedMaterialMarkerRevision: 1,
        actualMaterialMarkerRevision: null,
      });

      // The marker is created by the `material` command, not by direct SQL: this is
      // the only production path by which a shift with trips can be closed.
      const confirmed = await confirmMaterial(shiftT, actors[ids.senior], {
        closeToken: prepared.result.closeToken,
        materialId: `material_${shiftT.slice(-8)}`,
        volume: Number(revision.payload.totalVolume),
        expectedShiftRevision: closingRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: null,
      });
      assert.equal(confirmed.replayed, false);
      assert.equal(confirmed.result.phase, 'material-confirmed');
      assert.equal(confirmed.result.materialMarkerRevision, 1);
      const marker = await markerRow(shiftT);
      assert.equal(Number(marker.revision), 1);
      assert.equal(Number(marker.source_archive_revision), 1);

      const wrongToken = await expectError(finish(shiftT, actors[ids.senior], {
        closeToken: 'wrong_token_000000000000',
        expectedShiftRevision: closingRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 1,
      }), 'revision-conflict', 409);
      assert.deepEqual(wrongToken.details, {field: 'closeToken'});

      const wrongShift = await expectError(finish(shiftT, actors[ids.senior], {
        closeToken: prepared.result.closeToken,
        expectedShiftRevision: closingRevision + 1,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 1,
      }), 'revision-conflict', 409);
      assert.deepEqual(wrongShift.details, {
        shiftId: shiftT,
        expectedShiftRevision: closingRevision + 1,
        actualShiftRevision: closingRevision,
      });

      const wrongArchive = await expectError(finish(shiftT, actors[ids.senior], {
        closeToken: prepared.result.closeToken,
        expectedShiftRevision: closingRevision,
        expectedArchiveRevision: 2,
        expectedMaterialMarkerRevision: 1,
      }), 'revision-conflict', 409);
      assert.deepEqual(wrongArchive.details, {expectedArchiveRevision: 2, actualArchiveRevision: 1});

      const wrongMarker = await expectError(finish(shiftT, actors[ids.senior], {
        closeToken: prepared.result.closeToken,
        expectedShiftRevision: closingRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 2,
      }), 'revision-conflict', 409);
      assert.deepEqual(wrongMarker.details, {
        expectedMaterialMarkerRevision: 2,
        actualMaterialMarkerRevision: 1,
      });

      // No refusal above wrote anything.
      assert.deepEqual(await lineState(shiftT), closingState, 'a refused finish is not a partial close');
      assert.equal(await revisionCount(archiveId), 1);
      assert.equal((await seriesRow(archiveId)).latest_finalized_revision, null);
      assert.equal((await seriesRow(archiveId)).latest_finalized_sha256, null);
      assert.equal(Number((await markerRow(shiftT)).revision), 1);

      // The correct finish publishes exactly the prepared revision.
      const countsBefore = await statusCount();
      const tStatuses = (await statusRows(shiftT)).length;
      assert.ok(tStatuses > 0);
      const closed = await finish(shiftT, actors[ids.senior], {
        closeToken: prepared.result.closeToken,
        expectedShiftRevision: closingRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 1,
      });
      assert.equal(closed.result.phase, 'closed');
      assert.equal(closed.result.shiftRevision, closingRevision + 1);
      assert.equal(closed.result.archiveId, archiveId);
      assert.equal(closed.result.archiveRevision, 1);
      assert.equal(closed.result.archiveSha256, latestSha);
      assert.equal(closed.result.materialMarkerRevision, 1);

      const afterFinish = await shiftRow(shiftT);
      assert.equal(afterFinish.state, 'closed');
      assert.equal(Number(afterFinish.revision), closingRevision + 1);
      assert.equal(afterFinish.payload.state, 'closed');
      assert.equal(afterFinish.payload.isActive, false);
      assert.equal(afterFinish.payload.closing, undefined);
      assert.equal(typeof afterFinish.payload.closedAt, 'number');
      assert.equal(afterFinish.payload.closedByUid, ids.senior);
      assert.notEqual(afterFinish.closed_at, null);
      assert.equal(afterFinish.closed_by_uid, ids.senior);
      assert.equal(await statusRows(shiftT).then(rows => rows.length), 0,
        'finish deletes only this shift current statuses');
      assert.equal(await statusCount(), countsBefore - tStatuses,
        'no workspace-wide DELETE: exactly this shift rows disappear');

      // Everything except the current statuses survives.
      assert.equal((await logsFor(shiftT)).length, closingState.logs.length, 'logs survive');
      assert.equal(Number((await markerRow(shiftT)).revision), 1, 'the marker survives');
      assert.equal(Number((await seriesRow(archiveId)).latest_finalized_revision), 1);
      assert.equal((await seriesRow(archiveId)).latest_finalized_sha256, latestSha);
      assert.equal(Number((await seriesRow(archiveId)).series_revision), 2);
      assert.equal(await revisionCount(archiveId), 1);
      const latest = await readLatestFinalizedArchive(pool, WORKSPACE, archiveId);
      assert.equal(latest.revision, 1);
      assert.equal(latest.sha256, latestSha);
      assert.equal(latest.payload.sourceShiftId, shiftT);

      // The archive is the source, exactly: trip ids, volumes, totals, line and
      // TTN state all come from the actual rows.
      const rawLogs = await logsFor(shiftT);
      const rawStatuses = await statusRows(shiftT);
      const ordinary = rawLogs.map(row => row.payload).filter(log => !log.isGAI);
      assert.equal(latest.payload.logs.length, rawLogs.length);
      assert.deepEqual(latest.payload.logs.map(log => log.id), rawLogs.map(row => row.log_id));
      for (const [index, row] of rawLogs.entries()) {
        assert.equal(latest.payload.logs[index].truckId, row.payload.truckId);
        assert.equal(latest.payload.logs[index].timestamp, row.payload.timestamp);
        assert.equal(latest.payload.logs[index].volume, row.payload.volume);
      }
      assert.equal(latest.payload.totalTrips, ordinary.length);
      assert.equal(latest.payload.totalVolume,
        ordinary.reduce((sum, log) => sum + Number(log.volume || 0), 0));
      assert.equal(latest.payload.objectId, afterFinish.object_id);
      assert.equal(latest.payload.date, afterFinish.payload.startDate);
      assert.equal(latest.payload.closedAt, Number(afterFinish.payload.closingStartedAt));
      assert.equal(latest.payload.closedBy, afterFinish.payload.closingBy);
      assert.equal(sha256(latest.payloadBytes), latestSha);
      assert.equal(Number((await markerRow(shiftT)).volume), Number(latest.payload.totalVolume));
      assert.deepEqual(rawStatuses, [], 'statuses are gone but their archive state is not');

      // Memberships, receipts and audit survive the close.
      const membership = (await pool.query(
        `SELECT uid,revision,removed_at FROM shift_members
          WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3`,
        [WORKSPACE, shiftT, ids.senior],
      )).rows[0];
      assert.ok(membership, 'memberships survive');
      assert.equal(membership.removed_at, null);
      const prepareReceipt = await receiptRow(prepared.operationId);
      const finishReceipt = await receiptRow(closed.operationId);
      assert.ok(prepareReceipt && finishReceipt, 'receipts survive');
      assert.notDeepEqual(prepareReceipt.result, {});
      assert.notDeepEqual(finishReceipt.result, {});
      assert.equal(prepareReceipt.shift_id, shiftT, 'receipts are shift-scoped');
      assert.equal(finishReceipt.shift_id, shiftT);
      assert.ok(await auditRow(prepared.operationId));
      assert.ok(await auditRow(closed.operationId));
      assert.equal((await archiveAuditRows(archiveId)).length, 2,
        'prepare and finish each leave an archive audit row');

      // Replay of finish after the shift is closed, and a new finish is a stable
      // 409 without a second archive revision.
      const replayFinish = await finishShiftClose(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftT,
        operationId: closed.operationId,
        protocolVersion: 2,
        closeToken: prepared.result.closeToken,
        expectedShiftRevision: closingRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 1,
      });
      assert.equal(replayFinish.replayed, true);
      assert.deepEqual(replayFinish.result, closed.result);
      await expectError(finishShiftClose(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftT,
        operationId: closed.operationId,
        protocolVersion: 2,
        closeToken: prepared.result.closeToken,
        expectedShiftRevision: closingRevision,
        expectedArchiveRevision: 2,
        expectedMaterialMarkerRevision: 1,
      }), 'operation-id-reused', 409);
      await expectError(finish(shiftT, actors[ids.senior], {
        closeToken: prepared.result.closeToken,
        expectedShiftRevision: Number(afterFinish.revision),
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 1,
      }), 'shift-closed', 409);
      await expectError(prepare(shiftT, actors[ids.senior], {
        expectedShiftRevision: Number(afterFinish.revision),
      }), 'shift-closed', 409);
      // The prepare replay still reaches its stored receipt on the closed row.
      const replayPrepared = await prepareShiftClose(pool, actors[ids.senior], {
        workspaceId: WORKSPACE,
        shiftId: shiftT,
        operationId: prepared.operationId,
        protocolVersion: 2,
        expectedShiftRevision: tRevision,
      });
      assert.equal(replayPrepared.replayed, true);
      assert.deepEqual(replayPrepared.result, prepared.result);
      assert.equal(await revisionCount(archiveId), 1, 'replay never writes a second revision');
      assert.deepEqual(await lineState(shiftC), trap, 'finishing T leaves the trap shift byte-identical');
    });

    await t.test('an empty shift closes without a marker; a shift with trips requires one', async () => {
      const emptyPrepared = await prepare(shiftE, actors[ids.senior], {
        expectedShiftRevision: await shiftRevision(shiftE),
      });
      assert.equal(emptyPrepared.result.materialMarkerRevision, null);
      const emptyRevision = await readArchiveRevision(pool, WORKSPACE, `closed_${shiftE}`, 1);
      assert.equal(emptyRevision.payload.totalTrips, 0);
      assert.equal(emptyRevision.payload.totalVolume, 0);
      assert.deepEqual(emptyRevision.payload.logs, []);
      await expectError(finish(shiftE, actors[ids.senior], {
        closeToken: emptyPrepared.result.closeToken,
        expectedShiftRevision: emptyPrepared.result.shiftRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 1,
      }), 'revision-conflict', 409);
      const emptyClosed = await finish(shiftE, actors[ids.senior], {
        closeToken: emptyPrepared.result.closeToken,
        expectedShiftRevision: emptyPrepared.result.shiftRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: null,
      });
      assert.equal(emptyClosed.result.phase, 'closed');
      assert.equal(emptyClosed.result.materialMarkerRevision, null);
      assert.equal(await markerRow(shiftE), undefined, 'an empty shift never creates a marker');

      await assign(shiftF, trucks.f);
      await fullCycle(shiftF, trucks.f);
      const fPrepared = await prepare(shiftF, actors[ids.senior], {
        expectedShiftRevision: await shiftRevision(shiftF),
      });
      const fRevision = await readArchiveRevision(pool, WORKSPACE, `closed_${shiftF}`, 1);
      assert.ok(fRevision.payload.totalTrips > 0);
      await expectError(finish(shiftF, actors[ids.senior], {
        closeToken: fPrepared.result.closeToken,
        expectedShiftRevision: fPrepared.result.shiftRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: null,
      }), 'revision-conflict', 409);
      const fConfirmed = await confirmMaterial(shiftF, actors[ids.senior], {
        closeToken: fPrepared.result.closeToken,
        volume: Number(fRevision.payload.totalVolume),
        expectedShiftRevision: fPrepared.result.shiftRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: null,
      });
      assert.equal(fConfirmed.result.materialMarkerRevision, 1);
      const fClosed = await finish(shiftF, actors[ids.senior], {
        closeToken: fPrepared.result.closeToken,
        expectedShiftRevision: fPrepared.result.shiftRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 1,
      });
      assert.equal(fClosed.result.phase, 'closed');
      assert.equal(fClosed.result.materialMarkerRevision, 1);
    });

    await t.test('material is confirmed only in closing, with the exact token and archive, one row per shift', async () => {
      const shiftM = await create(objects.m);
      await assign(shiftM, trucks.m);
      await fullCycle(shiftM, trucks.m);
      const mBefore = await shiftRow(shiftM);
      const mRevision = Number(mBefore.revision);

      // Not before prepare: the marker is a phase of the close, not of the active
      // shift, so an active row answers `shift-changed` and writes nothing.
      const early = await expectError(confirmMaterial(shiftM, actors[ids.senior], {
        expectedShiftRevision: mRevision,
      }), 'shift-changed', 409);
      assert.equal(early.details.shiftId, shiftM);
      assert.equal(await markerRow(shiftM), undefined, 'an active shift never gets a marker');
      assert.deepEqual(await shiftRow(shiftM), mBefore, 'a refused material writes nothing');

      const mPrepared = await prepare(shiftM, actors[ids.senior], {expectedShiftRevision: mRevision});
      const mArchive = await readArchiveRevision(pool, WORKSPACE, `closed_${shiftM}`, 1);
      const mTotal = Number(mArchive.payload.totalVolume);
      assert.ok(mTotal > 0, 'the fixture shift really hauled something');
      const mClosing = Number((await shiftRow(shiftM)).revision);
      const mToken = mPrepared.result.closeToken;
      const mState = await lineState(shiftM);

      // The token binds the confirmation to this prepare; a foreign token is a
      // field conflict, not a marker write.
      const badToken = await expectError(confirmMaterial(shiftM, actors[ids.senior], {
        closeToken: 'wrong_token_000000000000',
        volume: mTotal,
        expectedShiftRevision: mClosing,
      }), 'revision-conflict', 409);
      assert.deepEqual(badToken.details, {field: 'closeToken'});

      const badArchive = await expectError(confirmMaterial(shiftM, actors[ids.senior], {
        closeToken: mToken,
        volume: mTotal,
        expectedShiftRevision: mClosing,
        expectedArchiveRevision: 2,
      }), 'revision-conflict', 409);
      assert.deepEqual(badArchive.details, {expectedArchiveRevision: 2, actualArchiveRevision: 1});

      // The archive is the ceiling: a confirmed import cannot exceed what was hauled.
      const tooMuch = await expectError(confirmMaterial(shiftM, actors[ids.senior], {
        closeToken: mToken,
        volume: mTotal + 1,
        expectedShiftRevision: mClosing,
      }), 'invalid-command', 400);
      assert.deepEqual(tooMuch.details, {field: 'volume'});
      const negative = await expectError(confirmMaterial(shiftM, actors[ids.senior], {
        closeToken: mToken,
        volume: -1,
        expectedShiftRevision: mClosing,
      }), 'invalid-command', 400);
      assert.deepEqual(negative.details, {field: 'volume'});
      const noMaterial = await expectError(confirmMaterial(shiftM, actors[ids.senior], {
        closeToken: mToken,
        materialId: '',
        volume: mTotal,
        expectedShiftRevision: mClosing,
      }), 'invalid-command', 400);
      assert.deepEqual(noMaterial.details, {field: 'materialId'});

      // No refusal above wrote a marker or touched the closing line.
      assert.equal(await markerRow(shiftM), undefined);
      assert.deepEqual(await lineState(shiftM), mState);

      const first = await confirmMaterial(shiftM, actors[ids.senior], {
        closeToken: mToken,
        materialId: `material_${shiftM.slice(-8)}`,
        volume: mTotal,
        expectedShiftRevision: mClosing,
        expectedMaterialMarkerRevision: null,
      });
      assert.equal(first.replayed, false);
      assert.equal(first.result.phase, 'material-confirmed');
      assert.equal(first.result.materialMarkerRevision, 1);
      assert.equal(first.result.archiveRevision, 1);
      const mMarker = await markerRow(shiftM);
      assert.equal(Number(mMarker.revision), 1);
      assert.equal(Number(mMarker.source_archive_revision), 1);
      assert.equal(Number(mMarker.volume), mTotal);
      assert.equal(mMarker.confirmed_by_uid, ids.senior);
      // The marker is not a shift revision: the shift stays closing at the same revision.
      assert.equal(Number((await shiftRow(shiftM)).revision), mClosing);

      // Replay returns the stored result and never bumps the revision again.
      const replay = await confirmMaterial(shiftM, actors[ids.senior], {
        operationId: first.operationId,
        closeToken: mToken,
        materialId: `material_${shiftM.slice(-8)}`,
        volume: mTotal,
        expectedShiftRevision: mClosing,
        expectedMaterialMarkerRevision: null,
      });
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, first.result);
      assert.equal(Number((await markerRow(shiftM)).revision), 1, 'replay never writes a second revision');
      await expectError(confirmMaterial(shiftM, actors[ids.senior], {
        operationId: first.operationId,
        closeToken: mToken,
        volume: mTotal - 1,
        expectedShiftRevision: mClosing,
        expectedMaterialMarkerRevision: null,
      }), 'operation-id-reused', 409);

      // A null expectation on an existing marker is a conflict, not a silent insert.
      const staleNull = await expectError(confirmMaterial(shiftM, actors[ids.senior], {
        closeToken: mToken,
        volume: mTotal,
        expectedShiftRevision: mClosing,
        expectedMaterialMarkerRevision: null,
      }), 'revision-conflict', 409);
      assert.deepEqual(staleNull.details, {
        expectedMaterialMarkerRevision: null,
        actualMaterialMarkerRevision: 1,
      });

      // Correction: the same row moves to revision 2, never a second transfer.
      const shortfall = mTotal - 1;
      const corrected = await confirmMaterial(shiftM, actors[ids.senior], {
        closeToken: mToken,
        materialId: `material_${shiftM.slice(-8)}_fix`,
        volume: shortfall,
        expectedShiftRevision: mClosing,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 1,
      });
      assert.equal(corrected.result.materialMarkerRevision, 2);
      const rows = await pool.query(
        'SELECT revision,volume FROM shift_material_markers WHERE workspace_id=$1 AND shift_id=$2',
        [WORKSPACE, shiftM],
      );
      assert.equal(rows.rowCount, 1, 'a correction updates the one row instead of adding a transfer');
      assert.equal(Number(rows.rows[0].revision), 2);
      assert.equal(Number(rows.rows[0].volume), shortfall);

      // Finish on the old revision is a conflict; a shortfall against the archive
      // is refused by finish itself, not silently accepted.
      const oldMarker = await expectError(finish(shiftM, actors[ids.senior], {
        closeToken: mToken,
        expectedShiftRevision: mClosing,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 1,
      }), 'revision-conflict', 409);
      assert.deepEqual(oldMarker.details, {
        expectedMaterialMarkerRevision: 1,
        actualMaterialMarkerRevision: 2,
      });
      const shortClose = await expectError(finish(shiftM, actors[ids.senior], {
        closeToken: mToken,
        expectedShiftRevision: mClosing,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 2,
      }), 'archive-changed', 409);
      assert.equal(shortClose.details.shiftId, shiftM);
      assert.equal((await seriesRow(`closed_${shiftM}`)).latest_finalized_revision, null);

      // Restoring the exact archive volume is another correction (revision 3) and
      // then the close passes on that new revision.
      const restored = await confirmMaterial(shiftM, actors[ids.senior], {
        closeToken: mToken,
        materialId: `material_${shiftM.slice(-8)}_fix`,
        volume: mTotal,
        expectedShiftRevision: mClosing,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 2,
      });
      assert.equal(restored.result.materialMarkerRevision, 3);
      const mClosed = await finish(shiftM, actors[ids.senior], {
        closeToken: mToken,
        expectedShiftRevision: mClosing,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 3,
      });
      assert.equal(mClosed.result.phase, 'closed');
      assert.equal(mClosed.result.materialMarkerRevision, 3);

      // After finish the marker phase is over: the answer is the stable closed 409.
      const afterClose = await expectError(confirmMaterial(shiftM, actors[ids.senior], {
        closeToken: mToken,
        volume: mTotal,
        expectedShiftRevision: mClosed.result.shiftRevision,
        expectedMaterialMarkerRevision: 3,
      }), 'shift-closed', 409);
      assert.equal(afterClose.details.state, 'closed');
      assert.equal(Number((await markerRow(shiftM)).revision), 3, 'the closed marker survives');

      // Schema proof (the only place that writes the table directly): the primary
      // key admits exactly one marker row per shift, so no writer can create a
      // second transfer.
      await assert.rejects(
        insertMarker(shiftM, mArchive.payload, actors[ids.senior]),
        error => error.code === '23505',
      );
      assert.equal(Number((await markerRow(shiftM)).revision), 3);
    });

    await t.test('a historical row never enters close and a closed row is a stable 409', async () => {
      // The cutover classification is a historical state, not a synthetic close:
      // no closing/closed markers and no actor/time are invented.
      await pool.query(
        `UPDATE shifts
            SET payload = payload || '{"state":"historical","isActive":false}'::jsonb
          WHERE workspace_id=$1 AND shift_id=$2`,
        [WORKSPACE, shiftH],
      );
      const hBefore = await shiftRow(shiftH);
      assert.equal(hBefore.state, 'historical');
      assert.equal(hBefore.closing_started_at, null);
      assert.equal(hBefore.closing_by_uid, null);
      assert.equal(hBefore.closed_at, null);
      assert.equal(hBefore.closed_by_uid, null);
      const historical = await expectError(prepare(shiftH, actors[ids.senior], {
        expectedShiftRevision: Number(hBefore.revision),
      }), 'shift-closed', 409);
      assert.equal(historical.details.state, 'historical');
      assert.deepEqual(await shiftRow(shiftH), hBefore, 'a historical row is not rewritten');
      assert.equal(await seriesRow(`closed_${shiftH}`), undefined);

      const closed = await shiftRow(shiftT);
      const closedError = await expectError(prepare(shiftT, actors[ids.senior], {
        expectedShiftRevision: Number(closed.revision),
      }), 'shift-closed', 409);
      assert.equal(closedError.details.state, 'closed');
      assert.deepEqual(await shiftRow(shiftT), closed);
    });

    await t.test('access is recomputed between prepare and finish; admin keeps it', async () => {
      // Shift A was prepared by the foreman. Removing that membership after the
      // prepare is a direct row change here: the normal command is itself frozen
      // by closing, and this root proves the server re-reads the current ACL.
      const prepared = await (async () => {
        const row = await shiftRow(shiftA);
        return {closeToken: row.close_token, shiftRevision: Number(row.revision)};
      })();
      const aRevision = await readArchiveRevision(pool, WORKSPACE, `closed_${shiftA}`, 1);
      assert.ok(aRevision.payload.totalTrips > 0);
      const aTotal = Number(aRevision.payload.totalVolume);

      const membership = (await pool.query(
        `SELECT revision FROM shift_members
          WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3`,
        [WORKSPACE, shiftA, ids.foreman],
      )).rows[0];
      await pool.query(
        `UPDATE shift_members
            SET removed_at=now(), removed_by_uid=$4, revision=revision+1
          WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3`,
        [WORKSPACE, shiftA, ids.foreman, ids.senior],
      );
      const aBefore = await lineState(shiftA);
      // The removed member cannot confirm the material either: the right is
      // recomputed for every command, not carried over from the prepare.
      const removedMaterial = await expectError(confirmMaterial(shiftA, actors[ids.foreman], {
        closeToken: prepared.closeToken,
        volume: aTotal,
        expectedShiftRevision: prepared.shiftRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: null,
      }), 'not-shift-member', 403);
      assert.equal(removedMaterial.details.shiftId, shiftA);
      assert.equal(await markerRow(shiftA), undefined, 'a removed member writes no marker');
      const removed = await expectError(finish(shiftA, actors[ids.foreman], {
        closeToken: prepared.closeToken,
        expectedShiftRevision: prepared.shiftRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: null,
      }), 'not-shift-member', 403);
      assert.equal(removed.details.shiftId, shiftA);
      assert.deepEqual(await lineState(shiftA), aBefore, 'a removed member cannot partially close');
      assert.equal((await seriesRow(`closed_${shiftA}`)).latest_finalized_revision, null);
      // Even the prepare receipt is not disclosed to the removed member.
      await expectError(prepareShiftClose(pool, actors[ids.foreman], {
        workspaceId: WORKSPACE,
        shiftId: shiftA,
        operationId: `${prefix}_replay_prepare_a`,
        protocolVersion: 2,
        expectedShiftRevision: Number(aBefore.shift.revision),
      }), 'not-shift-member', 403);
      assert.equal(Number(membership.revision), 1);

      // Admin has no membership but keeps both rights: it confirms the material
      // and then closes.
      const adminMaterial = await confirmMaterial(shiftA, actors[ids.admin], {
        closeToken: prepared.closeToken,
        materialId: `material_${shiftA.slice(-8)}`,
        volume: aTotal,
        expectedShiftRevision: prepared.shiftRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: null,
      });
      assert.equal(adminMaterial.result.materialMarkerRevision, 1);
      const adminClosed = await finish(shiftA, actors[ids.admin], {
        closeToken: prepared.closeToken,
        expectedShiftRevision: prepared.shiftRevision,
        expectedArchiveRevision: 1,
        expectedMaterialMarkerRevision: 1,
      });
      assert.equal(adminClosed.result.phase, 'closed');
      const aAfter = await shiftRow(shiftA);
      assert.equal(aAfter.state, 'closed');
      assert.equal(aAfter.closed_by_uid, ids.admin);
    });

    // Regression for the owner's 28.11.2026 report: the legacy close writer
    // (`/api/v1/shifts/close`) passed `is_active=false` together with a
    // `closing:true` payload. Migration 025's strict bridge rejects that with
    // check_violation 23514, so the shift could not be closed at all. A closing
    // shift occupies the line (D1), and the writer must not touch the bridge
    // column.
    await t.test('legacy close writer accepts a strict v2 shift without bridge-column drift', async () => {
      const objectId = `${prefix}_object_legacy`;
      await pool.query(
        'INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',
        [WORKSPACE, objectId, {id: objectId, name: 'Object legacy'}],
      );
      const shiftId = await create(objectId);
      const prepared = await closeShiftOperation(pool, ids.admin, {
        id: `${prefix}_legacy_prepare`, type: 'prepare', shiftId,
      });
      assert.equal(prepared.phase, 'awaiting-material');
      const closing = (await pool.query(
        'SELECT state,is_active,closing_started_at,closing_by_uid,payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2',
        [WORKSPACE, shiftId],
      )).rows[0];
      assert.equal(closing.state, 'closing');
      assert.equal(closing.is_active, true, 'closing occupies the line');
      assert.ok(closing.closing_started_at);
      assert.equal(closing.closing_by_uid, ids.admin);
      assert.equal(closing.payload.closing, true);
      assert.equal(closing.payload.payloadSchemaVersion, 2);
      const finished = await closeShiftOperation(pool, ids.admin, {
        id: `${prefix}_legacy_finish`, type: 'finish', shiftId,
      });
      assert.equal(finished.phase, 'closed');
      const closed = (await pool.query(
        'SELECT state,is_active,closed_at,closed_by_uid,payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2',
        [WORKSPACE, shiftId],
      )).rows[0];
      assert.equal(closed.is_active, false);
      // The legacy writer proves only a display name, so the row is historical,
      // never a forged `closed` with a guessed actor (lesson 22).
      assert.equal(closed.state, 'historical');
      assert.equal(closed.closed_at, null);
      assert.equal(closed.closed_by_uid, null);
      assert.equal(closed.payload.closing, false);
    });
  } finally {
    await pool.end();
  }
});
