import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ACTIONS, roleView } from '../src/identity-rules.mjs';
import { runV2Command } from '../src/v2-command.mjs';
import { applyMigrationsThrough } from './helpers/isolated-db.mjs';
import {
  authorizeShift,
  loadActor,
  visibleShiftPredicate,
} from '../src/shift-access-v2.mjs';

// Parallel shift ACL (design §6, plan Task 17).
//
// Every rule below is checked independently: an active app_users row, the global
// role/action matrix, an active membership (except admin) and the resource's
// workspace+shift. The file also proves the two new default-deny rights added by
// migration 027 and that a revoked member never receives a stored receipt.

const WORKSPACE = 'main_workspace';
const OTHER_WORKSPACE = 'main_workspace_other';
const DAY_START = 1795420800000; // 2026-11-23T11:00:00+03:00
const NIGHT_START = 1795453200000; // 2026-11-23T20:00:00+03:00

function moscowParts(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ms);
  const part = type => parts.find(item => item.type === type)?.value;
  return { date: `${part('year')}-${part('month')}-${part('day')}`, startDate: `${part('day')}.${part('month')}.${part('year')}` };
}

// Exact published v2 start document (025 requires precisely these 14 keys on
// INSERT); it keeps the shift a real live line so the ACL sees a real resource.
function shiftPayload({ id, objectId, workShift, startedAt, uid, name }) {
  const { date, startDate } = moscowParts(startedAt);
  return {
    payloadSchemaVersion: 2, id, shiftId: id, objectId,
    objectName: `Object ${objectId}`, startDate, date,
    workShift, type: workShift, state: 'active', isActive: true, startedAt,
    startedByUid: uid, startedBy: name,
  };
}

test('parallel shift ACL: defaults, membership, visibility, closing and replay', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
  pool.on('error', () => {});
  const prefix = 'acl_' + randomUUID().replaceAll('-', '');
  const ids = {
    admin: prefix + '_admin',
    senior: prefix + '_senior',
    foreman: prefix + '_foreman',
    other: prefix + '_other',
    both: prefix + '_both',
    viewer: prefix + '_viewer',
    inactive: prefix + '_inactive',
  };
  const shift = {
    main: prefix + '_shift_main',
    hidden: prefix + '_shift_hidden',
    closing: prefix + '_shift_closing',
    closed: prefix + '_shift_closed',
  };
  const object = {
    main: prefix + '_object_main',
    hidden: prefix + '_object_hidden',
    closing: prefix + '_object_closing',
    closed: prefix + '_object_closed',
  };
  const users = [
    [ids.admin, 'ACL admin', 'admin', 'active'],
    [ids.senior, 'ACL senior', 'senior_foreman', 'active'],
    [ids.foreman, 'ACL foreman', 'foreman', 'active'],
    [ids.other, 'ACL other', 'foreman', 'active'],
    [ids.both, 'ACL both', 'foreman', 'active'],
    [ids.viewer, 'ACL viewer', 'viewer', 'active'],
    [ids.inactive, 'ACL inactive', 'foreman', 'disabled'],
  ];
  const memberships = [
    [shift.main, ids.foreman],
    [shift.hidden, ids.senior],
    [shift.main, ids.both],
    [shift.hidden, ids.both],
  ];
  const granted = ['tab_line', 'action_arrive', 'action_load', 'action_ttn', 'edit_line', 'manage_trucks', 'close_shift'];
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
  const addMember = (shiftId, uid, by = ids.admin) => pool.query(
    `INSERT INTO shift_members(workspace_id,shift_id,uid,assigned_at,assigned_by_uid)
     VALUES($1,$2,$3,now(),$4)
     ON CONFLICT(workspace_id,shift_id,uid)
     DO UPDATE SET removed_at=NULL, removed_by_uid=NULL, revision=shift_members.revision+1`,
    [WORKSPACE, shiftId, uid, by],
  );
  const removeMember = (shiftId, uid, by = ids.admin) => pool.query(
    `UPDATE shift_members SET removed_at=now(), removed_by_uid=$4, revision=revision+1
      WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3 AND removed_at IS NULL`,
    [WORKSPACE, shiftId, uid, by],
  );
  const activeMembership = async (shiftId, uid) => (await pool.query(
    'SELECT 1 FROM shift_members WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3 AND removed_at IS NULL',
    [WORKSPACE, shiftId, uid],
  )).rowCount === 1;

  try {
    // The root runs on the frozen S25 baseline (024 + redesigned 025); the ACL
    // itself needs 026/027 on top, applied through the privileged bootstrap
    // connection exactly as a release would. Assertions stay on the app role.
    await applyMigrationsThrough(27);
    await pool.query("INSERT INTO workspaces(id) VALUES ($1) ON CONFLICT(id) DO NOTHING", [WORKSPACE]);
    for (const [uid, name, role, status] of users) {
      await pool.query(
        'INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,$4,$5)',
        [uid, `${uid}@example.test`, name, role, status],
      );
    }
    for (const objectId of Object.values(object)) {
      await pool.query(
        'INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',
        [WORKSPACE, objectId, { id: objectId, name: `Object ${objectId}` }],
      );
    }
    // The isolated matrix starts nearly empty (only 019/020 rows), so the test
    // grants the ordinary line rights the same way the admin UI would. The two
    // 027 rights are deliberately NOT touched here: their defaults are asserted.
    for (const role of ['foreman', 'senior_foreman']) {
      for (const action of granted) {
        await pool.query(
          `INSERT INTO role_permissions(role,action,allowed) VALUES($1,$2,true)
           ON CONFLICT(role,action) DO UPDATE SET allowed=true`,
          [role, action],
        );
      }
    }
    await pool.query(
      `INSERT INTO role_permissions(role,action,allowed) VALUES('viewer','tab_line',true)
       ON CONFLICT(role,action) DO UPDATE SET allowed=true`,
    );

    const createShift = (id, objectId, workShift, startedAt) => pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)',
      [WORKSPACE, id, shiftPayload({ id, objectId, workShift, startedAt, uid: ids.admin, name: 'ACL admin' })],
    );
    await createShift(shift.main, object.main, 'day', DAY_START);
    await createShift(shift.hidden, object.hidden, 'night', NIGHT_START);
    await createShift(shift.closing, object.closing, 'day', DAY_START);
    await createShift(shift.closed, object.closed, 'night', NIGHT_START);
    for (const [shiftId, uid] of memberships) await addMember(shiftId, uid);

    // A state transition keeps the published v2 document and adds only the
    // lifecycle markers, exactly as the close writer does.
    const setShiftState = async (shiftId, state) => {
      const row = (await pool.query('SELECT payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2', [WORKSPACE, shiftId])).rows[0];
      const now = Date.now();
      const payload = state === 'closing'
        ? { ...row.payload, state, closing: true, closingStartedAt: now, closingByUid: ids.admin }
        : { ...row.payload, state, isActive: false, closing: false, closedAt: now, closedByUid: ids.admin };
      await pool.query('UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2', [WORKSPACE, shiftId, payload]);
    };

    await t.test('migration 027 adds both rights with default deny and the spec defaults', async () => {
      const rows = (await pool.query(
        'SELECT role,action,allowed FROM role_permissions WHERE action = ANY($1::text[])',
        [['manage_shift_members', 'force_transfer_truck']],
      )).rows;
      const matrix = new Map(rows.map(row => [`${row.role}/${row.action}`, row.allowed]));
      // §6: add/remove member is "admin or прораб + manage_shift_members", so
      // both foreman roles are enabled by default.
      assert.equal(matrix.get('senior_foreman/manage_shift_members'), true);
      assert.equal(matrix.get('foreman/manage_shift_members'), true);
      // §6: force transfer is only admin/senior_foreman, never foreman.
      assert.equal(matrix.get('senior_foreman/force_transfer_truck'), true);
      assert.equal(matrix.get('foreman/force_transfer_truck'), false);
      // Everything else is default deny, and admin has no row at all (roleView
      // already grants admin every action).
      for (const role of ['master', 'lopater', 'viewer']) {
        assert.equal(matrix.get(`${role}/manage_shift_members`), false, `${role} manage_shift_members`);
        assert.equal(matrix.get(`${role}/force_transfer_truck`), false, `${role} force_transfer_truck`);
      }
      assert.equal(rows.some(row => row.role === 'admin'), false);
      // The server allow-list and the matrix view agree with the migration.
      assert.ok(ACTIONS.includes('manage_shift_members'));
      assert.ok(ACTIONS.includes('force_transfer_truck'));
      assert.ok(roleView('admin', []).actions.includes('force_transfer_truck'));
      const view = role => roleView(role, rows.filter(row => row.role === role).map(row => ({ ...row }))).actions;
      assert.ok(view('senior_foreman').includes('force_transfer_truck'));
      assert.ok(view('foreman').includes('manage_shift_members'));
      assert.equal(view('foreman').includes('force_transfer_truck'), false);
      assert.equal(view('viewer').includes('manage_shift_members'), false);
    });

    await t.test('loadActor accepts only an active profile and never returns 500', async () => {
      const actor = await loadActor(pool, ids.foreman);
      assert.deepEqual(actor, { uid: ids.foreman, displayName: 'ACL foreman', role: 'foreman', status: 'active' });
      await expectError(loadActor(pool, prefix + '_missing'), 'unauthenticated', 401);
      await expectError(loadActor(pool, ids.inactive), 'forbidden', 403);
      await expectError(loadActor(pool, ''), 'unauthenticated', 401);
      await expectError(loadActor(pool, null), 'unauthenticated', 401);
    });

    await t.test('admin passes every action without membership but only inside the workspace', async () => {
      const admin = await loadActor(pool, ids.admin);
      for (const action of ['shift.read', 'shift.member.add', 'shift.truck.add', 'shift.line.load', 'shift.close.finish']) {
        const allowed = await authorizeShift(pool, admin, { workspaceId: WORKSPACE, shiftId: shift.main, action });
        assert.equal(allowed.via, 'admin', action);
        assert.equal(allowed.membership, null, action);
        assert.equal(allowed.shift.shiftId, shift.main, action);
        assert.equal(allowed.shift.state, 'active', action);
      }
      // Admin is not a member (the 025 trigger refuses that), yet sees the shift.
      assert.equal(await activeMembership(shift.main, ids.admin), false);
      await expectError(authorizeShift(pool, admin, { workspaceId: OTHER_WORKSPACE, shiftId: shift.main, action: 'shift.read' }), 'shift-not-visible', 404);
      await expectError(authorizeShift(pool, admin, { workspaceId: WORKSPACE, shiftId: prefix + '_missing', action: 'shift.read' }), 'shift-not-visible', 404);
    });

    await t.test('a foreman member gets member rights by default but never force transfer', async () => {
      const foreman = await loadActor(pool, ids.foreman);
      const read = await authorizeShift(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.read' });
      assert.equal(read.via, 'shift');
      assert.equal(read.membership.uid, ids.foreman);
      assert.equal(read.membership.removedAt, null);
      const add = await authorizeShift(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.member.add' });
      assert.equal(add.via, 'shift');
      // Force transfer is a role gate on top of the right: even a member with the
      // right enabled stays refused for foreman (§6: only admin/senior_foreman).
      await addMember(shift.hidden, ids.foreman);
      await pool.query("UPDATE role_permissions SET allowed=true WHERE role='foreman' AND action='force_transfer_truck'");
      try {
        const denied = await expectError(authorizeShift(pool, foreman, {
          workspaceId: WORKSPACE, shiftId: shift.hidden, action: 'shift.truck.force-transfer', sourceShiftId: shift.main,
        }), 'forbidden', 403);
        assert.equal(denied.details.reason, 'force-transfer-role');
      } finally {
        await pool.query("UPDATE role_permissions SET allowed=false WHERE role='foreman' AND action='force_transfer_truck'");
        await removeMember(shift.hidden, ids.foreman);
      }
    });

    await t.test('senior force transfer needs the matrix right and a destination membership', async () => {
      const senior = await loadActor(pool, ids.senior);
      const allowed = await authorizeShift(pool, senior, {
        workspaceId: WORKSPACE, shiftId: shift.hidden, action: 'shift.truck.force-transfer', sourceShiftId: shift.main,
      });
      assert.equal(allowed.via, 'destination');
      assert.equal(allowed.shift.shiftId, shift.hidden);
      assert.equal(allowed.sourceShift.shiftId, shift.main);
      // The source is not disclosed when it does not exist in this workspace.
      const missing = await expectError(authorizeShift(pool, senior, {
        workspaceId: WORKSPACE, shiftId: shift.hidden, action: 'shift.truck.force-transfer', sourceShiftId: prefix + '_missing',
      }), 'shift-not-visible', 404);
      assert.equal(missing.details.shiftId, prefix + '_missing');
      // Right revoked between calls: the very next call is refused.
      await pool.query("UPDATE role_permissions SET allowed=false WHERE role='senior_foreman' AND action='force_transfer_truck'");
      try {
        await expectError(authorizeShift(pool, senior, {
          workspaceId: WORKSPACE, shiftId: shift.hidden, action: 'shift.truck.force-transfer', sourceShiftId: shift.main,
        }), 'forbidden', 403);
      } finally {
        await pool.query("UPDATE role_permissions SET allowed=true WHERE role='senior_foreman' AND action='force_transfer_truck'");
      }
      // Destination membership revoked: the cross-shift right alone is not enough.
      await removeMember(shift.hidden, ids.senior);
      try {
        await expectError(authorizeShift(pool, senior, {
          workspaceId: WORKSPACE, shiftId: shift.hidden, action: 'shift.truck.force-transfer', sourceShiftId: shift.main,
        }), 'not-shift-member', 403);
      } finally {
        await addMember(shift.hidden, ids.senior);
      }
    });

    await t.test('a hidden shift is 404 for read and 403 not-shift-member for a known command', async () => {
      const other = await loadActor(pool, ids.other);
      await expectError(authorizeShift(pool, other, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.read' }), 'shift-not-visible', 404);
      const denied = await expectError(authorizeShift(pool, other, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.member.add' }), 'not-shift-member', 403);
      assert.equal(denied.details.shiftId, shift.main);
      // An unknown shift and an invisible shift answer the same code: existence
      // is never disclosed to a non-member.
      await expectError(authorizeShift(pool, other, { workspaceId: WORKSPACE, shiftId: prefix + '_missing', action: 'shift.read' }), 'shift-not-visible', 404);
      // The matrix is not a substitute for membership: a viewer with tab_line
      // still gets 404 on read.
      const viewer = await loadActor(pool, ids.viewer);
      await expectError(authorizeShift(pool, viewer, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.read' }), 'shift-not-visible', 404);
      // A member without the action right is refused even though the shift is visible.
      await pool.query("UPDATE role_permissions SET allowed=false WHERE role='foreman' AND action='action_load'");
      try {
        const foreman = await loadActor(pool, ids.foreman);
        const rightDenied = await expectError(authorizeShift(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.line.load' }), 'forbidden', 403);
        assert.equal(rightDenied.details.reason, 'missing-right');
        // Read only needs tab_line, so the same member still reads the shift.
        assert.equal((await authorizeShift(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.read' })).via, 'shift');
      } finally {
        await pool.query("UPDATE role_permissions SET allowed=true WHERE role='foreman' AND action='action_load'");
      }
    });

    await t.test('closing forbids new line/member/truck/object commands but allows snapshot and close', async () => {
      await setShiftState(shift.closing, 'closing');
      await addMember(shift.closing, ids.foreman);
      const foreman = await loadActor(pool, ids.foreman);
      for (const action of ['shift.line.arrive', 'shift.line.load', 'shift.member.add', 'shift.member.remove', 'shift.truck.add', 'shift.truck.remove', 'shift.object.change']) {
        const error = await expectError(authorizeShift(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.closing, action }), 'shift-closing', 409);
        assert.equal(error.details.state, 'closing');
      }
      for (const action of ['shift.read', 'shift.close.prepare', 'shift.close.finish']) {
        const allowed = await authorizeShift(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.closing, action });
        assert.equal(allowed.shift.state, 'closing', action);
      }
      // Admin is bound by the same lifecycle rule.
      const admin = await loadActor(pool, ids.admin);
      await expectError(authorizeShift(pool, admin, { workspaceId: WORKSPACE, shiftId: shift.closing, action: 'shift.line.load' }), 'shift-closing', 409);
    });

    await t.test('a closed shift answers 410 for commands and stays readable for its member', async () => {
      await setShiftState(shift.closed, 'closed');
      await addMember(shift.closed, ids.foreman);
      const foreman = await loadActor(pool, ids.foreman);
      assert.equal((await authorizeShift(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.closed, action: 'shift.read' })).shift.state, 'closed');
      const error = await expectError(authorizeShift(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.closed, action: 'shift.line.load' }), 'shift-closed', 410);
      assert.equal(error.details.state, 'closed');
      // The close domain owns the terminal answer (§5.5/§11): the ACL lets the two
      // close actions through on a closed row, so an identical replay still reaches
      // its receipt and a new close is refused by the domain with a stable 409
      // instead of the generic 410. Permissions are still re-checked here.
      for (const action of ['shift.close.prepare', 'shift.close.finish']) {
        const allowed = await authorizeShift(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.closed, action });
        assert.equal(allowed.shift.state, 'closed', action);
      }
    });

    await t.test('detached completion is allowed through source OR current destination membership', async () => {
      const options = (uid) => ({ workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.detached.complete', destinationShiftId: shift.hidden, lineAction: 'load' });
      const foreman = await loadActor(pool, ids.foreman); // source only
      const viaSource = await authorizeShift(pool, foreman, options(ids.foreman));
      assert.equal(viaSource.via, 'source');
      assert.equal(viaSource.destinationShift.shiftId, shift.hidden);
      const senior = await loadActor(pool, ids.senior); // destination only
      const viaDestination = await authorizeShift(pool, senior, options(ids.senior));
      assert.equal(viaDestination.via, 'destination');
      const other = await loadActor(pool, ids.other); // neither
      await expectError(authorizeShift(pool, other, options(ids.other)), 'not-shift-member', 403);
      // Both memberships: losing one still leaves the other route open.
      const both = await loadActor(pool, ids.both);
      assert.equal((await authorizeShift(pool, both, options(ids.both))).via, 'source');
      await removeMember(shift.main, ids.both);
      try {
        assert.equal((await authorizeShift(pool, both, options(ids.both))).via, 'destination');
      } finally {
        await addMember(shift.main, ids.both);
      }
      // Losing both memberships closes the pair: the ACL is recomputed per call.
      await removeMember(shift.hidden, ids.both);
      await removeMember(shift.main, ids.both);
      try {
        await expectError(authorizeShift(pool, both, options(ids.both)), 'not-shift-member', 403);
      } finally {
        await addMember(shift.main, ids.both);
        await addMember(shift.hidden, ids.both);
      }
      // The completing action right is still required.
      await pool.query("UPDATE role_permissions SET allowed=false WHERE role='foreman' AND action='action_load'");
      try {
        await expectError(authorizeShift(pool, foreman, options(ids.foreman)), 'forbidden', 403);
      } finally {
        await pool.query("UPDATE role_permissions SET allowed=true WHERE role='foreman' AND action='action_load'");
      }
      // Admin needs no membership, but the destination must exist.
      const admin = await loadActor(pool, ids.admin);
      assert.equal((await authorizeShift(pool, admin, options(ids.admin))).via, 'admin');
      await expectError(authorizeShift(pool, admin, { ...options(ids.admin), destinationShiftId: prefix + '_missing' }), 'shift-not-visible', 404);
      // A detached completion without a completing line action is a schema error.
      await expectError(authorizeShift(pool, admin, { ...options(ids.admin), lineAction: undefined }), 'invalid-command', 400);
    });

    await t.test('visibleShiftPredicate is parameterized and follows active membership', async () => {
      const admin = await loadActor(pool, ids.admin);
      const foreman = await loadActor(pool, ids.foreman);
      assert.deepEqual(visibleShiftPredicate(admin, 's'), { sql: 'TRUE', params: [] });
      const predicate = visibleShiftPredicate(foreman, 's');
      assert.deepEqual(predicate.params, [ids.foreman]);
      assert.match(predicate.sql, /\$1/);
      assert.equal(predicate.sql.includes(ids.foreman), false, 'the uid must never be interpolated');
      assert.match(predicate.sql, /removed_at IS NULL/);
      const offset = visibleShiftPredicate(foreman, 's', 3);
      assert.deepEqual(offset.params, [ids.foreman]);
      assert.match(offset.sql, /\$3/);
      assert.throws(() => visibleShiftPredicate(foreman, 's; DROP TABLE shifts'), TypeError);
      assert.throws(() => visibleShiftPredicate({ uid: ids.foreman, role: 'made-up' }, 's'), TypeError);
      const expected = (await pool.query(
        'SELECT shift_id FROM shift_members WHERE workspace_id=$1 AND uid=$2 AND removed_at IS NULL ORDER BY shift_id',
        [WORKSPACE, ids.foreman],
      )).rows.map(row => row.shift_id);
      // The caller's own workspace parameter occupies $1, so the fragment is
      // placed at $2 here — the index is explicit, never inferred.
      const scoped = visibleShiftPredicate(foreman, 's', 2);
      const found = (await pool.query(
        `SELECT s.shift_id FROM shifts s WHERE s.workspace_id=$1 AND ${scoped.sql} ORDER BY s.shift_id`,
        [WORKSPACE, ...scoped.params],
      )).rows.map(row => row.shift_id);
      assert.deepEqual(found, expected);
      assert.equal(found.includes(shift.hidden), false);
      assert.ok(found.includes(shift.main));
    });

    await t.test('a revoked member never receives a stored receipt on replay', async () => {
      const operation = prefix + '_op_replay';
      const logId = prefix + '_log_replay';
      const body = { truckId: prefix + '_truck', volume: 24 };
      const command = () => ({
        pool,
        uid: ids.foreman,
        workspaceId: WORKSPACE,
        shiftId: shift.main,
        protocolVersion: 2,
        operation,
        type: 'shift.line.load',
        body,
        authorize: async (client) => {
          const actor = await loadActor(client, ids.foreman);
          return authorizeShift(client, actor, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.line.load' });
        },
        mutate: async client => {
          await client.query(
            'INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)',
            [WORKSPACE, logId, shift.main, body.truckId, { shiftId: shift.main, truckId: body.truckId, volume: 24 }],
          );
          return { result: { logId, shiftId: shift.main }, after: { logs: 1 } };
        },
      });
      const first = await runV2Command(command());
      assert.equal(first.replayed, false);
      assert.deepEqual(first.result, { logId, shiftId: shift.main });
      assert.equal((await runV2Command(command())).replayed, true);
      const receipt = (await pool.query(
        'SELECT result FROM shift_operation_receipts WHERE workspace_id=$1 AND operation_id=$2',
        [WORKSPACE, operation],
      )).rows[0];
      assert.deepEqual(receipt.result, { logId, shiftId: shift.main });
      // Membership revoked between two identical calls: authorization runs before
      // the receipt is read, so the stored result is never returned.
      await removeMember(shift.main, ids.foreman);
      const revoked = await expectError(runV2Command(command()), 'not-shift-member', 403);
      assert.deepEqual(revoked.body, { protocolVersion: 2, error: 'not-shift-member', details: { shiftId: shift.main } });
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM line_logs WHERE workspace_id=$1 AND log_id=$2', [WORKSPACE, logId],
      )).rows[0].n, 1);
      // The receipt still exists — it is only gated by the live ACL.
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM shift_operation_receipts WHERE workspace_id=$1 AND operation_id=$2', [WORKSPACE, operation],
      )).rows[0].n, 1);
      // Reactivation makes the very same replay succeed again.
      await addMember(shift.main, ids.foreman);
      assert.equal((await runV2Command(command())).replayed, true);
      // A removed member then gets 404 on read and 403 on a command (§6).
      await removeMember(shift.main, ids.foreman);
      const foreman = await loadActor(pool, ids.foreman);
      await expectError(authorizeShift(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.read' }), 'shift-not-visible', 404);
      await expectError(authorizeShift(pool, foreman, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.member.add' }), 'not-shift-member', 403);
    });

    await t.test('worker/driver-style roles never become shift members', async () => {
      for (const uid of [ids.viewer, ids.inactive]) {
        const error = await capture(pool.query(
          `INSERT INTO shift_members(workspace_id,shift_id,uid,assigned_at,assigned_by_uid)
           VALUES($1,$2,$3,now(),$4)`,
          [WORKSPACE, shift.main, uid, ids.admin],
        ));
        assert.ok(error, `${uid} must not become a member`);
        assert.equal(error.code, '23514');
        assert.match(error.message, /shift member must be an active foreman/);
      }
    });

    await t.test('unknown actions and malformed identifiers are schema errors, not 500', async () => {
      const admin = await loadActor(pool, ids.admin);
      await expectError(authorizeShift(pool, admin, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.unknown' }), 'invalid-command', 400);
      // Inherited Object.prototype names are not actions either.
      await expectError(authorizeShift(pool, admin, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'toString' }), 'invalid-command', 400);
      await expectError(authorizeShift(pool, admin, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'constructor' }), 'invalid-command', 400);
      await expectError(authorizeShift(pool, admin, {
        workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.detached.complete',
        destinationShiftId: shift.hidden, lineAction: 'toString',
      }), 'invalid-command', 400);
      await expectError(authorizeShift(pool, admin, { workspaceId: WORKSPACE, shiftId: '', action: 'shift.read' }), 'invalid-command', 400);
      await expectError(authorizeShift(pool, { uid: ids.admin, role: 'nope' }, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.read' }), 'invalid-command', 400);
      await expectError(authorizeShift(pool, admin, { workspaceId: WORKSPACE, shiftId: shift.main, action: 'shift.truck.force-transfer' }), 'invalid-command', 400);
    });
  } finally {
    const uids = Object.values(ids);
    await pool.query('DELETE FROM shift_members WHERE workspace_id=$1 AND shift_id LIKE $2', [WORKSPACE, prefix + '%']);
    await pool.query('DELETE FROM line_logs WHERE workspace_id=$1 AND shift_id LIKE $2', [WORKSPACE, prefix + '%']);
    await pool.query('DELETE FROM shift_operation_receipts WHERE uid = ANY($1)', [uids]);
    await pool.query('DELETE FROM workspace_service_audit WHERE uid = ANY($1)', [uids]);
    await pool.query('DELETE FROM shifts WHERE workspace_id=$1 AND shift_id LIKE $2', [WORKSPACE, prefix + '%']);
    await pool.query('DELETE FROM workspace_objects WHERE workspace_id=$1 AND object_id LIKE $2', [WORKSPACE, prefix + '%']);
    await pool.query('DELETE FROM app_users WHERE uid = ANY($1)', [uids]);
    await pool.query("UPDATE role_permissions SET allowed=true WHERE role='senior_foreman' AND action='force_transfer_truck'");
    await pool.query("UPDATE role_permissions SET allowed=false WHERE role='foreman' AND action='force_transfer_truck'");
    await pool.end();
  }
});
