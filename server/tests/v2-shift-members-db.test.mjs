import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrationsThrough} from './helpers/isolated-db.mjs';
import {loadActor} from '../src/shift-access-v2.mjs';
import {
  addShiftMember,
  changeShiftObject,
  createShift,
  removeShiftMember,
} from '../src/shift-members-v2.mjs';

// Shift creation, object change and memberships (design §5.2, §5.3, §6, §7,
// plan Task 19).
//
// The root runs on the frozen S25 baseline (024 + redesigned 025) and applies
// 026/027 through the privileged bootstrap connection, exactly as a release
// would; every assertion stays on the app role. Creation is strict v2 only: a
// legacy v1 document is refused by the 025 trigger, and this module never calls
// a legacy resolution/activation path.
//
// Covered contract:
//   * creator membership rev=1 and shifts.revision=1 on create;
//   * day and night of one object/date coexist, an exact duplicate is 409;
//   * a concurrent duplicate race has exactly one winner;
//   * object change is CAS on the shift revision and dies after the first
//     confirmed arrive locks the object;
//   * member add/reactivate/remove are CAS on shift + membership revisions;
//   * the last active member cannot be removed by a foreman (§3.2 keeps the
//     admin orphan repair);
//   * worker/driver are never members — a stable code, not a 500.

const WORKSPACE = 'main_workspace';

function moscowDate(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ms);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

test('v2 shift create, object change and memberships', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const pool = new pg.Pool({connectionString: process.env.TEST_DATABASE_URL, max: 5});
  pool.on('error', () => {});
  const prefix = 'members_' + randomUUID().replaceAll('-', '');
  const ids = {
    admin: prefix + '_admin',
    foreman: prefix + '_foreman',
    foreman2: prefix + '_foreman2',
    worker: prefix + '_worker',
    driver: prefix + '_driver',
    disabled: prefix + '_disabled',
  };
  const object = {
    a: prefix + '_object_a',
    b: prefix + '_object_b',
    c: prefix + '_object_c',
    d: prefix + '_object_d',
    e: prefix + '_object_e',
    f: prefix + '_object_f',
    g: prefix + '_object_g',
    deleted: prefix + '_object_deleted',
    disabled: prefix + '_object_disabled',
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
  const shiftRow = async shiftId => (await pool.query(
    `SELECT workspace_id,shift_id,state,revision,object_id,object_name_snapshot,
            to_char(work_date,'YYYY-MM-DD') AS work_date_text,shift_type,
            opened_at,opened_by_uid,payload_schema_version,identity_resolution,shift_type_resolution,
            object_locked_at,object_locked_by_operation_id,payload
       FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
    [WORKSPACE, shiftId],
  )).rows[0];
  const membershipRow = async (shiftId, uid) => (await pool.query(
    `SELECT uid,assigned_at,assigned_by_uid,removed_at,removed_by_uid,revision
       FROM shift_members WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3`,
    [WORKSPACE, shiftId, uid],
  )).rows[0];
  const membershipCount = async shiftId => (await pool.query(
    'SELECT count(*)::int AS total FROM shift_members WHERE workspace_id=$1 AND shift_id=$2',
    [WORKSPACE, shiftId],
  )).rows[0].total;
  let operation = 0;
  const operationId = label => `${prefix}_${label}_${++operation}`;
  const createBody = (objectId, shiftType, extra = {}) => ({
    operationId: operationId(`create_${shiftType}_${objectId.slice(-2)}`),
    protocolVersion: 2,
    objectId,
    workDate,
    shiftType,
    cycleMinutes: 30,
    ...extra,
  });

  try {
    await applyMigrationsThrough(27);
    await pool.query('INSERT INTO workspaces(id) VALUES ($1) ON CONFLICT(id) DO NOTHING', [WORKSPACE]);
    for (const [uid, name, role, status] of [
      [ids.admin, 'Members admin', 'admin', 'active'],
      [ids.foreman, 'Members foreman', 'foreman', 'active'],
      [ids.foreman2, 'Members foreman two', 'foreman', 'active'],
      [ids.worker, 'Members worker', 'worker', 'active'],
      [ids.driver, 'Members driver', 'driver', 'active'],
      [ids.disabled, 'Members disabled', 'foreman', 'disabled'],
    ]) {
      await pool.query(
        'INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,$4,$5)',
        [uid, `${uid}@example.test`, name, role, status],
      );
    }
    for (const [objectId, extra] of [
      [object.a, {}],
      [object.b, {}],
      [object.c, {}],
      [object.d, {}],
      [object.e, {}],
      [object.f, {}],
      [object.g, {}],
      [object.deleted, {deleted: true}],
      [object.disabled, {disabled: true}],
    ]) {
      await pool.query(
        'INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',
        [WORKSPACE, objectId, {id: objectId, name: `Object ${objectId}`, ...extra}],
      );
    }
    // The isolated matrix starts nearly empty (019/020 rows only), so the
    // ordinary rights are granted the same way the admin UI would grant them.
    // `manage_shift_members` keeps its 027 default (true for both foreman roles).
    for (const role of ['foreman', 'senior_foreman']) {
      for (const action of ['start_shift', 'edit_line', 'tab_line']) {
        await pool.query(
          `INSERT INTO role_permissions(role,action,allowed) VALUES($1,$2,true)
           ON CONFLICT(role,action) DO UPDATE SET allowed=true`,
          [role, action],
        );
      }
    }
    for (const uid of Object.values(ids)) {
      if (uid === ids.disabled) continue; // a disabled profile is never an actor
      actors[uid] = await loadActor(pool, uid);
    }

    const shift = {
      day: prefix + '_shift_day',
      night: prefix + '_shift_night',
      race: prefix + '_shift_race',
      object: prefix + '_shift_object',
      members: prefix + '_shift_members',
      last: prefix + '_shift_last',
      adminCreated: prefix + '_shift_admin',
    };

    await t.test('create_shift_is_strict_v2_and_creator_gets_membership', async () => {
      const body = createBody(object.a, 'day');
      const created = await createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...body});
      assert.equal(created.protocolVersion, 2);
      assert.equal(created.operationId, body.operationId);
      assert.equal(created.replayed, false);
      assert.equal(created.result.shift.shiftId, `shift_${body.operationId}`);
      assert.equal(created.result.shift.shiftRevision, 1);
      assert.equal(created.result.shift.state, 'active');
      assert.equal(created.result.shift.shiftType, 'day');
      assert.equal(created.result.shift.workDate, workDate);
      assert.equal(created.result.membership.uid, ids.foreman);
      assert.equal(created.result.membership.revision, 1);
      assert.equal(created.result.membership.assignedByUid, ids.foreman);

      const row = await shiftRow(created.result.shift.shiftId);
      // Strict v2 only: the canonical columns are derived from the document.
      assert.equal(row.payload_schema_version, 2);
      assert.equal(row.identity_resolution, 'source');
      assert.equal(row.shift_type_resolution, 'source');
      assert.equal(row.opened_by_uid, ids.foreman);
      assert.equal(Number(row.revision), 1);
      assert.equal(row.object_id, object.a);
      assert.equal(row.payload.objectName, `Object ${object.a}`);

      const membership = await membershipRow(created.result.shift.shiftId, ids.foreman);
      assert.equal(Number(membership.revision), 1);
      assert.equal(membership.removed_at, null);
      assert.equal(membership.assigned_by_uid, ids.foreman);

      // An identical retry is a replay, not a second shift or membership.
      const replay = await createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...body});
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, created.result);
      assert.equal((await pool.query(
        'SELECT count(*)::int AS total FROM shifts WHERE workspace_id=$1 AND shift_id=$2',
        [WORKSPACE, created.result.shift.shiftId],
      )).rows[0].total, 1);
      assert.equal(await membershipCount(created.result.shift.shiftId), 1);

      // A new operation id for the same object/date/type is an exact duplicate.
      await expectError(
        createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...createBody(object.a, 'day')}),
        'shift-duplicate', 409,
      );
    });

    await t.test('day_and_night_of_one_object_and_date_coexist', async () => {
      const day = await createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...createBody(object.b, 'day')});
      const night = await createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...createBody(object.b, 'night')});
      assert.equal(day.result.shift.workDate, workDate);
      assert.equal(night.result.shift.workDate, workDate);
      assert.notEqual(day.result.shift.shiftId, night.result.shift.shiftId);
      assert.equal(day.result.shift.shiftType, 'day');
      assert.equal(night.result.shift.shiftType, 'night');
      // Both are live lines for the same object and date (§3.1: day and night
      // never conflict); only the exact pair is a duplicate.
      const live = (await pool.query(
        `SELECT shift_id,shift_type FROM shifts
          WHERE workspace_id=$1 AND object_id=$2 AND work_date=$3 AND state IN ('active','closing')
          ORDER BY shift_type`,
        [WORKSPACE, object.b, workDate],
      )).rows;
      assert.deepEqual(live.map(row => row.shift_type), ['day', 'night']);
      await expectError(
        createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...createBody(object.b, 'night')}),
        'shift-duplicate', 409,
      );
    });

    await t.test('duplicate_creation_race_has_exactly_one_winner', async () => {
      // Two operators create the same line at the same moment with different
      // operation ids: the DB unique key decides, never a read-then-insert.
      const first = createBody(object.c, 'day');
      const second = createBody(object.c, 'day');
      const results = await Promise.allSettled([
        createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...first}),
        createShift(pool, actors[ids.foreman2], {workspaceId: WORKSPACE, ...second}),
      ]);
      const winners = results.filter(item => item.status === 'fulfilled');
      const losers = results.filter(item => item.status === 'rejected');
      assert.equal(winners.length, 1, 'exactly one creator wins');
      assert.equal(losers.length, 1, 'exactly one creator is refused');
      assert.equal(losers[0].reason.name, 'V2Error');
      assert.equal(losers[0].reason.code, 'shift-duplicate');
      assert.equal(losers[0].reason.status, 409);
      assert.equal((await pool.query(
        `SELECT count(*)::int AS total FROM shifts
          WHERE workspace_id=$1 AND object_id=$2 AND work_date=$3 AND shift_type='day'
            AND state IN ('active','closing')`,
        [WORKSPACE, object.c, workDate],
      )).rows[0].total, 1);
      shift.race = winners[0].value.result.shift.shiftId;
    });

    await t.test('unavailable_object_and_ineligible_creator_are_stable_refusals', async () => {
      // §5.2/§3.1: a deleted or disabled object never starts a line.
      await expectError(
        createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...createBody(object.deleted, 'day')}),
        'object-not-available', 409,
      );
      await expectError(
        createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...createBody(object.disabled, 'night')}),
        'object-not-available', 409,
      );
      await expectError(
        createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...createBody(prefix + '_object_missing', 'day')}),
        'object-not-available', 409,
      );
      // A worker has no `start_shift` right at all.
      await expectError(
        createShift(pool, actors[ids.worker], {workspaceId: WORKSPACE, ...createBody(object.a, 'night')}),
        'forbidden', 403,
      );
      // §3.2: admin manages without a membership and is not forced to join.
      const adminShift = await createShift(pool, actors[ids.admin], {workspaceId: WORKSPACE, ...createBody(object.a, 'night')});
      assert.equal(adminShift.result.membership, null);
      assert.equal(adminShift.result.shift.shiftRevision, 1);
      shift.adminCreated = adminShift.result.shift.shiftId;
      assert.equal(await membershipCount(shift.adminCreated), 0);
    });

    await t.test('object_change_uses_shift_revision_and_object_lock', async () => {
      const created = await createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...createBody(object.d, 'day', {cycleMinutes: 30})});
      shift.object = created.result.shift.shiftId;
      const change = (body) => changeShiftObject(pool, actors[ids.foreman], {
        workspaceId: WORKSPACE, shiftId: shift.object, operationId: operationId('object'), protocolVersion: 2, ...body,
      });

      const changed = await change({objectId: object.e, expectedShiftRevision: 1});
      assert.equal(changed.replayed, false);
      assert.equal(changed.result.shift.shiftRevision, 2);
      assert.equal(changed.result.shift.objectId, object.e);
      assert.equal(changed.result.shift.objectName, `Object ${object.e}`);
      const row = await shiftRow(shift.object);
      assert.equal(row.object_id, object.e);
      assert.equal(row.object_name_snapshot, `Object ${object.e}`);
      // The published v2 document follows the object, so the trigger's
      // canonical columns stay derived and never drift.
      assert.equal(row.payload.objectId, object.e);
      assert.equal(Number(row.revision), 2);
      assert.equal(row.work_date_text, workDate);

      // A stale revision is a CAS refusal and changes nothing.
      await expectError(change({objectId: object.c, expectedShiftRevision: 1}), 'shift-changed', 409);
      assert.equal((await shiftRow(shift.object)).object_id, object.e);
      assert.equal(Number((await shiftRow(shift.object)).revision), 2);

      // The exact duplicate of another live line is refused before the write:
      // object A already carries a day line for the same work date.
      await expectError(change({objectId: object.a, expectedShiftRevision: 2}), 'shift-duplicate', 409);
      assert.equal((await shiftRow(shift.object)).object_id, object.e);

      // The first confirmed arrive locks the object (§3.1). Simulated here with
      // the exact columns the line command writes in the same transaction.
      await pool.query(
        `UPDATE shifts SET object_locked_at=now(), object_locked_by_operation_id=$3
          WHERE workspace_id=$1 AND shift_id=$2`,
        [WORKSPACE, shift.object, operationId('arrive')],
      );
      const locked = await expectError(change({objectId: object.c, expectedShiftRevision: 2}), 'object-locked', 409);
      assert.equal(locked.details.shiftId, shift.object);
      const afterLock = await shiftRow(shift.object);
      assert.equal(afterLock.object_id, object.e);
      assert.equal(Number(afterLock.revision), 2);
      assert.ok(afterLock.object_locked_at);
    });

    await t.test('member_add_reactivate_and_remove_use_cas', async () => {
      const created = await createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...createBody(object.f, 'night', {cycleMinutes: 30})});
      shift.members = created.result.shift.shiftId;
      const add = body => addShiftMember(pool, actors[ids.foreman], {
        workspaceId: WORKSPACE, shiftId: shift.members, operationId: operationId('member_add'), protocolVersion: 2, ...body,
      });
      const remove = (uid, body) => removeShiftMember(pool, actors[ids.foreman], {
        workspaceId: WORKSPACE, shiftId: shift.members, uid, operationId: operationId('member_remove'), protocolVersion: 2, ...body,
      });

      const added = await add({uid: ids.foreman2, expectedShiftRevision: 1, expectedMembershipRevision: null});
      assert.equal(added.result.shift.shiftRevision, 2);
      assert.equal(added.result.membership.uid, ids.foreman2);
      assert.equal(added.result.membership.revision, 1);
      assert.equal(added.result.membership.assignedByUid, ids.foreman);
      assert.equal(await membershipCount(shift.members), 2);
      assert.equal(Number((await shiftRow(shift.members)).revision), 2);

      // `null` means "no membership row at all": an existing row is a CAS loss.
      const staleNull = await expectError(
        add({uid: ids.foreman2, expectedShiftRevision: 2, expectedMembershipRevision: null}),
        'membership-changed', 409,
      );
      assert.equal(staleNull.details.actualMembershipRevision, 1);
      assert.equal(await membershipCount(shift.members), 2);

      const removed = await remove(ids.foreman2, {expectedShiftRevision: 2, expectedMembershipRevision: 1});
      assert.equal(removed.result.shift.shiftRevision, 3);
      assert.equal(removed.result.membership.revision, 2);
      assert.ok(removed.result.membership.removedAt);
      assert.equal(removed.result.membership.removedByUid, ids.foreman);
      assert.equal(Number((await shiftRow(shift.members)).revision), 3);

      // Reactivation updates the same row (PK unchanged) instead of inserting.
      const reactivated = await add({uid: ids.foreman2, expectedShiftRevision: 3, expectedMembershipRevision: 2});
      assert.equal(reactivated.result.shift.shiftRevision, 4);
      assert.equal(reactivated.result.membership.revision, 3);
      assert.equal(reactivated.result.membership.removedAt, null);
      assert.equal(await membershipCount(shift.members), 2);
      const row = await membershipRow(shift.members, ids.foreman2);
      assert.equal(Number(row.revision), 3);
      assert.equal(row.removed_at, null);
      assert.equal(row.removed_by_uid, null);

      // Stale membership and stale shift revisions are both refused.
      const staleMembership = await expectError(
        remove(ids.foreman2, {expectedShiftRevision: 4, expectedMembershipRevision: 2}),
        'membership-changed', 409,
      );
      assert.equal(staleMembership.details.actualMembershipRevision, 3);
      await expectError(
        remove(ids.foreman2, {expectedShiftRevision: 3, expectedMembershipRevision: 3}),
        'shift-changed', 409,
      );
      const unchanged = await membershipRow(shift.members, ids.foreman2);
      assert.equal(Number(unchanged.revision), 3);
      assert.equal(unchanged.removed_at, null);
    });

    await t.test('last_member_cannot_be_removed_by_a_foreman', async () => {
      const created = await createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...createBody(object.c, 'night')});
      shift.last = created.result.shift.shiftId;
      assert.equal(await membershipCount(shift.last), 1);
      // §3.2: the last active member cannot be removed by an ordinary member.
      const refused = await expectError(
        removeShiftMember(pool, actors[ids.foreman], {
          workspaceId: WORKSPACE, shiftId: shift.last, uid: ids.foreman,
          operationId: operationId('last_member'), protocolVersion: 2,
          expectedShiftRevision: 1, expectedMembershipRevision: 1,
        }),
        'last-shift-member', 409,
      );
      assert.equal(refused.details.shiftId, shift.last);
      const kept = await membershipRow(shift.last, ids.foreman);
      assert.equal(kept.removed_at, null);
      assert.equal(Number(kept.revision), 1);
      assert.equal(Number((await shiftRow(shift.last)).revision), 1);

      // §3.2 keeps the admin orphan repair: admin may remove the last member and
      // the shift then stays reachable for admin only.
      const repaired = await removeShiftMember(pool, actors[ids.admin], {
        workspaceId: WORKSPACE, shiftId: shift.last, uid: ids.foreman,
        operationId: operationId('admin_repair'), protocolVersion: 2,
        expectedShiftRevision: 1, expectedMembershipRevision: 1,
      });
      assert.equal(repaired.result.shift.shiftRevision, 2);
      assert.equal(repaired.result.membership.revision, 2);
      assert.equal(await membershipCount(shift.last), 1);
      assert.ok((await membershipRow(shift.last, ids.foreman)).removed_at);
    });

    await t.test('worker_and_driver_never_become_members', async () => {
      const created = await createShift(pool, actors[ids.foreman], {workspaceId: WORKSPACE, ...createBody(object.g, 'day', {cycleMinutes: 30})});
      const add = (uid, expectedShiftRevision) => addShiftMember(pool, actors[ids.foreman], {
        workspaceId: WORKSPACE, shiftId: created.result.shift.shiftId,
        operationId: operationId('ineligible'), protocolVersion: 2,
        uid, expectedShiftRevision, expectedMembershipRevision: null,
      });
      const shiftId = created.result.shift.shiftId;
      for (const uid of [ids.worker, ids.driver, ids.disabled, prefix + '_nobody']) {
        const error = await expectError(add(uid, 1), 'member-not-eligible', 400);
        assert.equal(error.details.field, 'uid');
        assert.equal((await pool.query(
          'SELECT count(*)::int AS total FROM shift_members WHERE workspace_id=$1 AND shift_id=$2',
          [WORKSPACE, shiftId],
        )).rows[0].total, 1);
        assert.equal(Number((await shiftRow(shiftId)).revision), 1);
      }
      // The 025 trigger stays the last line of defence for a direct write.
      const direct = await capture(pool.query(
        `INSERT INTO shift_members(workspace_id,shift_id,uid,assigned_at,assigned_by_uid)
         VALUES($1,$2,$3,now(),$4)`,
        [WORKSPACE, shiftId, ids.worker, ids.foreman],
      ));
      assert.ok(direct, 'the 025 member-role trigger must refuse a direct worker insert');
      assert.equal(direct.code, '23514');
    });

    await t.test('creation_has_no_legacy_shortcut', async () => {
      // The module must never resolve/activate a legacy shift or write a v1
      // document: creation is strict v2 only (plan Task 19 review focus).
      const source = await readFile(new URL('../src/shift-members-v2.mjs', import.meta.url), 'utf8');
      assert.equal(/resolveLegacyShift|resolve_legacy_shift/.test(source), false);
      assert.equal(/payloadSchemaVersion\s*:\s*1\b/.test(source), false);
      assert.equal((await pool.query('SELECT count(*)::int AS total FROM shift_legacy_resolution_receipts')).rows[0].total, 0);
      // Every shift this root created is a strict v2 row.
      assert.equal((await pool.query(
        'SELECT count(*)::int AS total FROM shifts WHERE workspace_id=$1 AND shift_id LIKE $2 AND payload_schema_version<>2',
        [WORKSPACE, prefix + '%'],
      )).rows[0].total, 0);
      // A v1 document is refused by the database, not silently upgraded.
      const legacy = await capture(pool.query(
        `INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)`,
        [WORKSPACE, prefix + '_legacy_shift', {
          id: prefix + '_legacy_shift', objectId: object.a, objectName: 'Legacy', startDate: '23.11.2026',
          startedAt: Date.now(), startedBy: 'Legacy author', isActive: true,
        }],
      ));
      assert.ok(legacy, 'a legacy v1 insert must be refused after 025');
      assert.equal(legacy.code, '23514');
      assert.match(String(legacy.message), /protocol-upgrade-required/);
    });
  } finally {
    await pool.end();
  }
});
