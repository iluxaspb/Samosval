import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

import {
  canonicalLegacyGuardKey,
  legacyGuardLockIds,
  lockLegacyGuardKey,
  normalizeResolutionCommand,
  canonicalResolutionRequest,
  resolveActionAllowed,
  resolveLegacyShift,
  RESOLVE_ACTION,
  PROTOCOL_VERSION,
} from '../src/legacy-shift-resolution.mjs';
import {
  matchLegacyShiftResolutionPath,
  resolveLegacyShiftRoute,
} from '../src/legacy-shift-resolution-route.mjs';
import { ACTIONS, roleView } from '../src/identity-rules.mjs';
import {
  applyMigrationsThrough,
  requireIsolatedDatabase,
  resetIsolatedDatabase,
  seedParallelShiftFixture,
} from './helpers/isolated-db.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
let approved = false;
if (connectionString && process.env.SAMOSVAL_ISOLATED_TEST === '1') {
  try { requireIsolatedDatabase(connectionString); approved = true; } catch {}
}
const db = (max = 1) => new pg.Pool({ connectionString, max });
const WORK_DATE = '2026-11-23';
const STARTED_AT = 1795420800000;
const NOTE = 'Сверено с бумажным журналом смены';

// ---------- pure: permission matrix (D11) ----------

test('resolve_legacy_shift is a real action and the default matrix grants it to admin only', () => {
  assert.equal(ACTIONS.includes(RESOLVE_ACTION), true);
  assert.equal(RESOLVE_ACTION, 'resolve_legacy_shift');
  assert.equal(roleView('admin', []).actions.includes(RESOLVE_ACTION), true);
  // No explicit row for a non-admin role means default deny, even with every
  // other action allowed.
  const everythingElse = ACTIONS.filter(action => action !== RESOLVE_ACTION)
    .map(action => ({ action, allowed: true }));
  for (const role of ['senior_foreman', 'foreman', 'master', 'lopater', 'viewer']) {
    assert.equal(roleView(role, everythingElse).actions.includes(RESOLVE_ACTION), false, `${role} must not resolve`);
  }
});

test('the execution gate reads the exact action for an admin, not the role alone', () => {
  assert.equal(resolveActionAllowed('admin', []), true);
  assert.equal(resolveActionAllowed('admin', [{ action: RESOLVE_ACTION, allowed: false }]), false);
  assert.equal(resolveActionAllowed('admin', [{ action: RESOLVE_ACTION, allowed: true }]), true);
  assert.equal(resolveActionAllowed('senior_foreman', [{ action: RESOLVE_ACTION, allowed: true }]), false);
  assert.equal(resolveActionAllowed('foreman', [{ action: RESOLVE_ACTION, allowed: true }]), false);
});

// ---------- pure: canonical guard key (D13) ----------

test('canonical guard key is stable under object key order and changes with every field', () => {
  const base = { workspaceId: 'ws_1', objectId: 'object_1', workDate: WORK_DATE, shiftType: 'day' };
  const key = canonicalLegacyGuardKey(base);
  assert.equal(typeof key, 'string');
  assert.equal(canonicalLegacyGuardKey({ shiftType: 'day', workDate: WORK_DATE, objectId: 'object_1', workspaceId: 'ws_1' }), key);
  for (const [field, value] of [
    ['workspaceId', 'ws_2'], ['objectId', 'object_2'], ['workDate', '2026-11-24'], ['shiftType', 'night'],
  ]) {
    assert.notEqual(canonicalLegacyGuardKey({ ...base, [field]: value }), key, `${field} must change the key`);
  }
  assert.notEqual(canonicalLegacyGuardKey({ ...base, shiftType: null }), key, 'unresolved type is its own key');
  assert.match(key, /^\{.*\}$/, 'the key is a JCS string, not a hash');
});

test('guard lock ids are two deterministic signed 64-bit numbers derived from the key', () => {
  const key = canonicalLegacyGuardKey({ workspaceId: 'ws_1', objectId: 'object_1', workDate: WORK_DATE, shiftType: 'day' });
  const ids = legacyGuardLockIds(key);
  assert.equal(ids.length, 2);
  assert.deepEqual(legacyGuardLockIds(key), ids, 'no randomness');
  for (const id of ids) {
    assert.match(id, /^-?[0-9]{1,19}$/);
    const value = BigInt(id);
    assert.ok(value >= -(2n ** 63n) && value < 2n ** 63n, 'must fit a signed 64-bit advisory lock id');
  }
  assert.notEqual(ids[0], ids[1]);
  const other = legacyGuardLockIds(canonicalLegacyGuardKey({ workspaceId: 'ws_1', objectId: 'object_1', workDate: WORK_DATE, shiftType: 'night' }));
  assert.notDeepEqual(other, ids);
});

// ---------- pure: command validation (D12, D17, D19) ----------

const command = (overrides = {}) => ({
  operationId: 'op_1',
  protocolVersion: PROTOCOL_VERSION,
  expectedShiftRevision: 1,
  set: { shiftType: 'day' },
  evidenceNote: NOTE,
  ...overrides,
});

test('an empty or unknown set is an invalid command', () => {
  assert.throws(() => normalizeResolutionCommand(command({ set: {} })), { code: 'invalid-resolution-command' });
  assert.throws(() => normalizeResolutionCommand(command({ set: { workDate: '2026-11-23' } })), { code: 'invalid-resolution-command' });
  assert.throws(() => normalizeResolutionCommand(command({ set: { openedByUid: 'uid_1', shiftType: 'day', objectId: 'x' } })), { code: 'invalid-resolution-command' });
  assert.throws(() => normalizeResolutionCommand(command({ set: { shiftType: 'evening' } })), { code: 'invalid-resolution-command' });
  assert.throws(() => normalizeResolutionCommand(command({ operationId: '../escape' })), { code: 'invalid-resolution-command' });
  assert.throws(() => normalizeResolutionCommand(command({ expectedShiftRevision: 0 })), { code: 'invalid-resolution-command' });
  assert.throws(() => normalizeResolutionCommand(command({ protocolVersion: 'two' })), { code: 'invalid-resolution-command' });
  const normalized = normalizeResolutionCommand(command());
  assert.deepEqual(normalized.set, { shiftType: 'day' });
});

test('the evidence note is trimmed, 1..1000 characters and free of control characters', () => {
  assert.equal(normalizeResolutionCommand(command({ evidenceNote: `  ${NOTE}  ` })).evidenceNote, NOTE);
  assert.equal(normalizeResolutionCommand(command({ evidenceNote: 'a'.repeat(1000) })).evidenceNote, 'a'.repeat(1000));
  assert.throws(() => normalizeResolutionCommand(command({ evidenceNote: 'a'.repeat(1001) })), { code: 'invalid-resolution-command' });
  assert.throws(() => normalizeResolutionCommand(command({ evidenceNote: '' })), { code: 'evidence-note-required' });
  assert.throws(() => normalizeResolutionCommand(command({ evidenceNote: '   \t ' })), { code: 'evidence-note-required' });
  assert.throws(() => normalizeResolutionCommand(command({ evidenceNote: 'смена\u0007' })), { code: 'invalid-resolution-command' });
  assert.throws(() => normalizeResolutionCommand(command({ evidenceNote: 'смена\u007f' })), { code: 'invalid-resolution-command' });
  assert.throws(() => normalizeResolutionCommand(command({ evidenceNote: undefined })), { code: 'evidence-note-required' });
});

test('the canonical request hash covers operation, shift, protocol, set and evidence', () => {
  const base = normalizeResolutionCommand(command());
  const hash = canonicalResolutionRequest(base, { workspaceId: 'ws_1', shiftId: 'shift_1' }).hash;
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(canonicalResolutionRequest(normalizeResolutionCommand(command()), { workspaceId: 'ws_1', shiftId: 'shift_1' }).hash, hash);
  for (const changed of [
    command({ evidenceNote: 'другое основание' }),
    command({ expectedShiftRevision: 2 }),
    command({ set: { openedByUid: 'uid_1' } }),
  ]) {
    assert.notEqual(canonicalResolutionRequest(normalizeResolutionCommand(changed), { workspaceId: 'ws_1', shiftId: 'shift_1' }).hash, hash);
  }
  assert.notEqual(canonicalResolutionRequest(base, { workspaceId: 'ws_1', shiftId: 'shift_2' }).hash, hash);
  assert.notEqual(canonicalResolutionRequest(base, { workspaceId: 'ws_2', shiftId: 'shift_1' }).hash, hash);
});

// ---------- pure: route adapter ----------

test('the route adapter matches exactly the versioned admin resolve path', () => {
  assert.equal(matchLegacyShiftResolutionPath('/api/v2/admin/legacy-shifts/shift_a/resolve'), 'shift_a');
  assert.equal(matchLegacyShiftResolutionPath('/api/v2/admin/legacy-shifts/shift_a'), null);
  assert.equal(matchLegacyShiftResolutionPath('/api/v2/admin/legacy-shifts//resolve'), null);
  assert.equal(matchLegacyShiftResolutionPath('/api/v1/admin/legacy-shifts/shift_a/resolve'), null);
  assert.equal(matchLegacyShiftResolutionPath('/api/v2/admin/legacy-shifts/a/b/resolve'), null);
});

// ---------- DB fixtures ----------

// Legacy v1 rows must exist BEFORE 025: after it the trigger rejects v1 writes.
async function seedLegacyRow(pool, ids, {
  shiftId, identity = 'unresolved', type = null, restored = false, closing = false, closed = false, objectId,
}) {
  const payload = {
    id: shiftId,
    objectId: objectId ?? ids.objectAId,
    objectName: 'object',
    startDate: '23.11.2026',
    startedAt: STARTED_AT,
    startedBy: 'legacy',
    isActive: false,
    ...(identity === 'source' ? { startedByUid: ids.adminUid } : {}),
    ...(type ? { workShift: type } : {}),
    ...(restored ? { restored: true, restoredFrom: `${shiftId}_archive` } : {}),
    ...(closing ? { closing: true, closingStartedAt: STARTED_AT + 100000, closingBy: 'legacy', state: 'closing' } : {}),
    ...(closed ? { closedAt: STARTED_AT + 100000, closedByUid: ids.adminUid } : {}),
  };
  await pool.query(
    'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,false,$3)',
    [ids.workspaceId, shiftId, payload],
  );
}

async function prepare(suffix, rows = []) {
  await resetIsolatedDatabase();
  await applyMigrationsThrough(24);
  const ids = await seedParallelShiftFixture({ suffix });
  const pool = db();
  try {
    for (const row of rows) await seedLegacyRow(pool, ids, row);
  } finally { await pool.end(); }
  await applyMigrationsThrough(25);
  return ids;
}

const body = (overrides = {}) => command(overrides);
const call = (pool, ids, shiftId, overrides = {}, uid = ids.adminUid) => resolveLegacyShift(pool, {
  uid, workspaceId: ids.workspaceId, shiftId, body: body(overrides),
});

async function auditCount(pool) {
  return (await pool.query('SELECT count(*)::int AS n FROM shift_legacy_resolution_audit')).rows[0].n;
}
async function receiptCount(pool) {
  return (await pool.query('SELECT count(*)::int AS n FROM shift_legacy_resolution_receipts')).rows[0].n;
}
async function shiftRow(pool, ids, shiftId) {
  return (await pool.query('SELECT * FROM shifts WHERE workspace_id=$1 AND shift_id=$2', [ids.workspaceId, shiftId])).rows[0];
}

// ---------- DB: happy path, ACL, replay, CAS ----------

test('an active admin with the action resolves one dimension, one audit, one receipt', { skip: !approved }, async () => {
  const ids = await prepare('resolve_ok', [{ shiftId: 'shift_ok' }]);
  const pool = db();
  try {
    const result = await call(pool, ids, 'shift_ok');
    assert.equal(result.outcome, 'resolved');
    assert.equal(result.identityResolution, 'unresolved', 'the untouched dimension stays unresolved');
    assert.equal(result.shiftTypeResolution, 'manual');
    assert.equal(result.shiftType, 'day');
    assert.equal(result.revision, 2);
    const row = await shiftRow(pool, ids, 'shift_ok');
    assert.equal(row.shift_type, 'day');
    assert.equal(row.shift_type_resolution, 'manual');
    assert.equal(row.identity_resolution, 'unresolved');
    assert.equal(row.opened_by_uid, null);
    assert.equal(row.state, 'historical');
    assert.equal(row.is_active, false);
    assert.equal(Number(row.revision), 2);
    assert.equal(await auditCount(pool), 1);
    assert.equal(await receiptCount(pool), 1);
    const audit = (await pool.query('SELECT * FROM shift_legacy_resolution_audit')).rows[0];
    assert.equal(audit.operation_id, 'op_1');
    assert.equal(audit.actor_uid, ids.adminUid);
    assert.equal(audit.old_shift_type, null);
    assert.equal(audit.new_shift_type, 'day');
    assert.equal(audit.old_shift_type_resolution, 'unresolved');
    assert.equal(audit.new_shift_type_resolution, 'manual');
    assert.equal(audit.evidence_note, NOTE);
    assert.equal(Number(audit.expected_revision), 1);
    assert.equal(Number(audit.result_revision), 2);
    assert.equal(audit.command_hash, canonicalResolutionRequest(normalizeResolutionCommand(body()), {
      workspaceId: ids.workspaceId, shiftId: 'shift_ok',
    }).hash);
  } finally { await pool.end(); }
});

test('an identity-only resolution leaves the type unresolved', { skip: !approved }, async () => {
  const ids = await prepare('resolve_uid', [{ shiftId: 'shift_uid' }]);
  const pool = db();
  try {
    const result = await call(pool, ids, 'shift_uid', { set: { openedByUid: ids.foremanUid } });
    assert.equal(result.identityResolution, 'manual');
    assert.equal(result.openedByUid, ids.foremanUid);
    assert.equal(result.shiftTypeResolution, 'unresolved');
    const row = await shiftRow(pool, ids, 'shift_uid');
    assert.equal(row.opened_by_uid, ids.foremanUid);
    assert.equal(row.identity_resolution, 'manual');
    assert.equal(row.shift_type_resolution, 'unresolved');
    assert.equal(row.shift_type, null);
  } finally { await pool.end(); }
});

test('both dimensions can be resolved in one command', { skip: !approved }, async () => {
  const ids = await prepare('resolve_both', [{ shiftId: 'shift_both' }]);
  const pool = db();
  try {
    const result = await call(pool, ids, 'shift_both', { set: { openedByUid: ids.foremanUid, shiftType: 'night' } });
    assert.equal(result.identityResolution, 'manual');
    assert.equal(result.shiftTypeResolution, 'manual');
    const row = await shiftRow(pool, ids, 'shift_both');
    assert.equal(row.opened_by_uid, ids.foremanUid);
    assert.equal(row.shift_type, 'night');
    assert.equal(Number(row.revision), 2);
    assert.equal(await auditCount(pool), 1);
  } finally { await pool.end(); }
});

test('a disabled historical opener is a legal target, an unknown uid is refused', { skip: !approved }, async () => {
  const ids = await prepare('resolve_disabled_uid', [
    { shiftId: 'shift_disabled_uid' },
    { shiftId: 'shift_unknown_uid' },
  ]);
  const pool = db();
  try {
    await pool.query("UPDATE app_users SET status='disabled' WHERE uid=$1", [ids.foremanUid]);
    const result = await call(pool, ids, 'shift_disabled_uid', { operationId: 'op_disabled', set: { openedByUid: ids.foremanUid } });
    assert.equal(result.openedByUid, ids.foremanUid, 'a disabled account still proves the historical actor');
    await assert.rejects(
      () => call(pool, ids, 'shift_unknown_uid', { operationId: 'op_unknown', set: { openedByUid: 'uid_that_never_existed' } }),
      { code: 'legacy-opener-unknown' },
    );
    const row = await shiftRow(pool, ids, 'shift_unknown_uid');
    assert.equal(row.opened_by_uid, null);
    assert.equal(row.identity_resolution, 'unresolved');
    assert.equal(await auditCount(pool), 1, 'the refused command leaves no audit');
    assert.equal(await receiptCount(pool), 1, 'the refused command leaves no receipt');
  } finally { await pool.end(); }
});

test('senior_foreman with every other permission is denied', { skip: !approved }, async () => {
  const ids = await prepare('resolve_senior', [{ shiftId: 'shift_senior' }]);
  const pool = db();
  try {
    await pool.query(
      `INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,'senior_foreman','active')
       ON CONFLICT(uid) DO UPDATE SET role='senior_foreman',status='active'`,
      ['senior_resolve', 'senior_resolve@example.test', 'senior_resolve'],
    );
    const actions = (await pool.query(
      "SELECT action FROM role_permissions WHERE role='foreman' UNION SELECT action FROM role_permissions WHERE role='senior_foreman'",
    )).rows.map(row => row.action);
    for (const action of new Set([...actions, 'edit_line', 'archive_edit', 'close_shift', 'start_shift', 'undo_any'])) {
      if (action === RESOLVE_ACTION) continue;
      await pool.query(
        `INSERT INTO role_permissions(role,action,allowed) VALUES('senior_foreman',$1,true)
         ON CONFLICT(role,action) DO UPDATE SET allowed=true`,
        [action],
      );
    }
    await pool.query("DELETE FROM role_permissions WHERE role='senior_foreman' AND action=$1", [RESOLVE_ACTION]);
    await assert.rejects(() => call(pool, ids, 'shift_senior', {}, 'senior_resolve'), { code: 'owner-acl-denied' });
    const row = await shiftRow(pool, ids, 'shift_senior');
    assert.equal(row.shift_type_resolution, 'unresolved');
    assert.equal(await auditCount(pool), 0);
    assert.equal(await receiptCount(pool), 0);
  } finally { await pool.end(); }
});

test('an admin whose action was revoked in the matrix is denied (the gate is the action)', { skip: !approved }, async () => {
  const ids = await prepare('resolve_revoked', [{ shiftId: 'shift_revoked' }]);
  const pool = db();
  try {
    await pool.query(
      `INSERT INTO role_permissions(role,action,allowed) VALUES('admin',$1,false)
       ON CONFLICT(role,action) DO UPDATE SET allowed=false`,
      [RESOLVE_ACTION],
    );
    await assert.rejects(() => call(pool, ids, 'shift_revoked'), { code: 'owner-acl-denied' });
    const row = await shiftRow(pool, ids, 'shift_revoked');
    assert.equal(row.shift_type_resolution, 'unresolved');
    assert.equal(await auditCount(pool), 0);
  } finally { await pool.end(); }
});

test('a disabled or revoked admin cannot resolve, and cannot replay an earlier success', { skip: !approved }, async () => {
  const ids = await prepare('resolve_disabled_admin', [{ shiftId: 'shift_dadmin' }]);
  const pool = db();
  try {
    await call(pool, ids, 'shift_dadmin');
    await pool.query("UPDATE app_users SET status='disabled' WHERE uid=$1", [ids.adminUid]);
    await assert.rejects(() => call(pool, ids, 'shift_dadmin'), { code: 'owner-acl-denied' });
    await pool.query("UPDATE app_users SET status='active' WHERE uid=$1", [ids.adminUid]);
    await pool.query(
      `INSERT INTO role_permissions(role,action,allowed) VALUES('admin',$1,false)
       ON CONFLICT(role,action) DO UPDATE SET allowed=false`,
      [RESOLVE_ACTION],
    );
    await assert.rejects(() => call(pool, ids, 'shift_dadmin'), { code: 'owner-acl-denied' }, 'replay must re-check the ACL');
    await pool.query("DELETE FROM role_permissions WHERE role='admin' AND action=$1", [RESOLVE_ACTION]);
    const replay = await call(pool, ids, 'shift_dadmin');
    assert.equal(replay.replayed, true);
    assert.equal(await auditCount(pool), 1, 'the replay never writes a second audit');
    assert.equal(await receiptCount(pool), 1);
  } finally { await pool.end(); }
});

test('an identical replay returns the stored result with one audit and one receipt', { skip: !approved }, async () => {
  const ids = await prepare('resolve_replay', [{ shiftId: 'shift_replay' }]);
  const pool = db();
  try {
    const first = await call(pool, ids, 'shift_replay');
    const second = await call(pool, ids, 'shift_replay');
    assert.equal(second.replayed, true);
    for (const key of ['outcome', 'shiftId', 'revision', 'openedByUid', 'identityResolution', 'shiftType', 'shiftTypeResolution']) {
      assert.deepEqual(second[key], first[key], `${key} must be replayed unchanged`);
    }
    assert.equal(await auditCount(pool), 1);
    assert.equal(await receiptCount(pool), 1);
    assert.equal(Number((await shiftRow(pool, ids, 'shift_replay')).revision), 2, 'a replay never bumps the revision');
  } finally { await pool.end(); }
});

test('the same operation id with another hash, shift or protocol is a reuse', { skip: !approved }, async () => {
  const ids = await prepare('resolve_reuse', [
    { shiftId: 'shift_reuse_a' },
    { shiftId: 'shift_reuse_b' },
  ]);
  const pool = db();
  try {
    await call(pool, ids, 'shift_reuse_a');
    await assert.rejects(
      () => call(pool, ids, 'shift_reuse_a', { evidenceNote: 'другое основание' }),
      { code: 'operation-id-reused' },
    );
    await assert.rejects(
      () => call(pool, ids, 'shift_reuse_a', { expectedShiftRevision: 2 }),
      { code: 'operation-id-reused' },
    );
    await assert.rejects(
      () => call(pool, ids, 'shift_reuse_b'),
      { code: 'operation-id-reused' },
      'the same operation id cannot address another shift',
    );
    await assert.rejects(
      () => call(pool, ids, 'shift_reuse_a', { protocolVersion: 1 }),
      { code: 'operation-id-reused' },
      'a different protocol version under the same operation id is a reuse, not an upgrade request',
    );
    assert.equal(await auditCount(pool), 1);
    assert.equal(await receiptCount(pool), 1);
    assert.equal((await shiftRow(pool, ids, 'shift_reuse_b')).shift_type_resolution, 'unresolved');
  } finally { await pool.end(); }
});

test('a fresh command with the wrong protocol version is refused before any write', { skip: !approved }, async () => {
  const ids = await prepare('resolve_protocol', [{ shiftId: 'shift_protocol' }]);
  const pool = db();
  try {
    await assert.rejects(() => call(pool, ids, 'shift_protocol', { protocolVersion: 1 }), { code: 'protocol-upgrade-required' });
    assert.equal(await auditCount(pool), 0);
    assert.equal(await receiptCount(pool), 0);
    assert.equal((await shiftRow(pool, ids, 'shift_protocol')).shift_type_resolution, 'unresolved');
  } finally { await pool.end(); }
});

test('a stale expected revision is shift-changed without receipt or audit', { skip: !approved }, async () => {
  const ids = await prepare('resolve_stale', [{ shiftId: 'shift_stale' }]);
  const pool = db();
  try {
    await assert.rejects(
      () => call(pool, ids, 'shift_stale', { expectedShiftRevision: 7 }),
      { code: 'shift-changed' },
    );
    assert.equal(await auditCount(pool), 0);
    assert.equal(await receiptCount(pool), 0);
    assert.equal(Number((await shiftRow(pool, ids, 'shift_stale')).revision), 1);
  } finally { await pool.end(); }
});

test('two clients with the same expected revision: one wins, the loser leaves nothing', { skip: !approved }, async () => {
  const ids = await prepare('resolve_concurrent', [{ shiftId: 'shift_race' }]);
  const pool = db(2);
  try {
    const outcomes = await Promise.allSettled([
      call(pool, ids, 'shift_race', { operationId: 'op_race_a', set: { shiftType: 'day' } }),
      call(pool, ids, 'shift_race', { operationId: 'op_race_b', set: { shiftType: 'night' } }),
    ]);
    const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled');
    const rejected = outcomes.filter(outcome => outcome.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one command may win the CAS');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'shift-changed');
    assert.equal(await auditCount(pool), 1);
    assert.equal(await receiptCount(pool), 1);
    const receipts = (await pool.query('SELECT operation_id FROM shift_legacy_resolution_receipts')).rows;
    assert.deepEqual(receipts.map(row => row.operation_id), [fulfilled[0].value.operationId]);
    const row = await shiftRow(pool, ids, 'shift_race');
    assert.equal(Number(row.revision), 2);
    assert.equal(row.shift_type, fulfilled[0].value.shiftType);
  } finally { await pool.end(); }
});

test('a field that is already manual or source is never overwritten', { skip: !approved }, async () => {
  const ids = await prepare('resolve_frozen', [
    { shiftId: 'shift_source_identity', identity: 'source', type: null },
    { shiftId: 'shift_manual_type' },
    { shiftId: 'shift_null_clear' },
  ]);
  const pool = db();
  try {
    await assert.rejects(
      () => call(pool, ids, 'shift_source_identity', { set: { openedByUid: ids.foremanUid } }),
      { code: 'legacy-field-not-unresolved' },
    );
    const source = await shiftRow(pool, ids, 'shift_source_identity');
    assert.equal(source.opened_by_uid, ids.adminUid, 'a source value stays untouched');
    assert.equal(source.identity_resolution, 'source');
    assert.equal(source.shift_type_resolution, 'unresolved', 'the other dimension is untouched');
    // Manual: resolve the type once, then try to rewrite it.
    await call(pool, ids, 'shift_manual_type', { operationId: 'op_manual_1' });
    await assert.rejects(
      () => call(pool, ids, 'shift_manual_type', { operationId: 'op_manual_2', expectedShiftRevision: 2, set: { shiftType: 'night' } }),
      { code: 'legacy-field-not-unresolved' },
    );
    // Clearing an unresolved dimension with null is a refusal too, never a wipe.
    await assert.rejects(
      () => call(pool, ids, 'shift_null_clear', { operationId: 'op_manual_3', set: { openedByUid: null } }),
      { code: 'legacy-field-not-unresolved' },
    );
    const manual = await shiftRow(pool, ids, 'shift_manual_type');
    assert.equal(manual.shift_type, 'day');
    assert.equal(manual.shift_type_resolution, 'manual');
    assert.equal(Number(manual.revision), 2);
    const cleared = await shiftRow(pool, ids, 'shift_null_clear');
    assert.equal(cleared.opened_by_uid, null);
    assert.equal(cleared.identity_resolution, 'unresolved');
    assert.equal(Number(cleared.revision), 1);
    assert.equal(await auditCount(pool), 1);
    assert.equal(await receiptCount(pool), 1);
  } finally { await pool.end(); }
});

test('an unknown shift is not found, before any write', { skip: !approved }, async () => {
  const ids = await prepare('resolve_missing', [{ shiftId: 'shift_present' }]);
  const pool = db();
  try {
    await assert.rejects(() => call(pool, ids, 'shift_absent'), { code: 'legacy-shift-not-found', status: 404 });
    assert.equal(await auditCount(pool), 0);
    assert.equal(await receiptCount(pool), 0);
  } finally { await pool.end(); }
});

test('the evidence note is validated by the database path, not only by the pure parser', { skip: !approved }, async () => {
  const ids = await prepare('resolve_note', [
    { shiftId: 'shift_note_a' },
    { shiftId: 'shift_note_b' },
    { shiftId: 'shift_note_c' },
    { shiftId: 'shift_note_d' },
  ]);
  const pool = db();
  try {
    await assert.rejects(() => call(pool, ids, 'shift_note_a', { evidenceNote: '   ' }), { code: 'evidence-note-required' });
    await assert.rejects(() => call(pool, ids, 'shift_note_b', { evidenceNote: 'a'.repeat(1001) }), { code: 'invalid-resolution-command' });
    await assert.rejects(() => call(pool, ids, 'shift_note_c', { evidenceNote: 'смена\u0001' }), { code: 'invalid-resolution-command' });
    assert.equal(await auditCount(pool), 0);
    assert.equal(await receiptCount(pool), 0);
    const single = await call(pool, ids, 'shift_note_d', { evidenceNote: 'a' });
    assert.equal(single.outcome, 'resolved');
    const note = (await pool.query('SELECT evidence_note FROM shift_legacy_resolution_audit')).rows[0].evidence_note;
    assert.equal(note, 'a');
  } finally { await pool.end(); }
});

// ---------- DB: no activation (D15) ----------

test('a historical row gets a manual type without activation and without active uniqueness', { skip: !approved }, async () => {
  // The fixture's own line (object A, 23.11.2026, day, active) already holds the
  // exact canonical key this row would need to become live.
  const ids = await prepare('resolve_no_activation', [{ shiftId: 'shift_hist_same_key' }]);
  const pool = db();
  try {
    const active = await shiftRow(pool, ids, ids.shiftAId);
    assert.equal(active.state, 'active');
    assert.equal(active.shift_type, 'day');
    assert.equal(active.object_id, ids.objectAId);
    const before = await shiftRow(pool, ids, 'shift_hist_same_key');
    assert.equal(before.state, 'historical');
    const result = await call(pool, ids, 'shift_hist_same_key', { set: { shiftType: 'day' } });
    assert.equal(result.shiftType, 'day');
    const after = await shiftRow(pool, ids, 'shift_hist_same_key');
    // The same (object, date, type) key already backs an active line: resolution
    // must not consult that index, because it never makes the row live.
    assert.equal(after.state, 'historical');
    assert.equal(after.is_active, false);
    assert.equal(after.closed_at, null);
    assert.equal(after.closed_by_uid, null);
    assert.equal(after.closing_started_at, null);
    assert.equal(after.closing_by_uid, null);
    assert.equal(after.historicalized_at, null);
    assert.equal(after.historicalized_by_uid, null);
    assert.equal(after.historicalization_reason, null);
    assert.equal(after.historicalization_report_hash, null);
    assert.equal(after.object_id, before.object_id, 'object_id is not a resolution target');
    assert.equal(after.work_date.getTime(), before.work_date.getTime(), 'work_date is not a resolution target');
    assert.deepEqual(after.payload, before.payload, 'the payload document is never rewritten');
    assert.equal((await shiftRow(pool, ids, ids.shiftAId)).state, 'active');
  } finally { await pool.end(); }
});

test('a closed legacy row keeps its proven close fields while the type is resolved', { skip: !approved }, async () => {
  const ids = await prepare('resolve_closed', [{ shiftId: 'shift_closed_row', closed: true }]);
  const pool = db();
  try {
    const before = await shiftRow(pool, ids, 'shift_closed_row');
    assert.equal(before.state, 'closed');
    assert.notEqual(before.closed_at, null);
    await call(pool, ids, 'shift_closed_row', { set: { shiftType: 'night' } });
    const after = await shiftRow(pool, ids, 'shift_closed_row');
    assert.equal(after.state, 'closed');
    assert.equal(after.is_active, false);
    assert.equal(after.closed_at.getTime(), before.closed_at.getTime());
    assert.equal(after.closed_by_uid, before.closed_by_uid);
    assert.equal(after.shift_type, 'night');
    assert.equal(after.shift_type_resolution, 'manual');
  } finally { await pool.end(); }
});

// ---------- DB: audit and guard invariants (D18, D13) ----------

test('the resolution audit is append-only: update, delete and truncate are refused', { skip: !approved }, async () => {
  const ids = await prepare('resolve_audit', [{ shiftId: 'shift_audit' }]);
  const pool = db();
  try {
    await call(pool, ids, 'shift_audit');
    await assert.rejects(() => pool.query("UPDATE shift_legacy_resolution_audit SET evidence_note='подмена'"), { code: '23514' });
    await assert.rejects(() => pool.query('DELETE FROM shift_legacy_resolution_audit'), { code: '23514' });
    await assert.rejects(() => pool.query('TRUNCATE shift_legacy_resolution_audit'), { code: '23514' });
    await assert.rejects(() => pool.query('TRUNCATE shift_legacy_resolution_receipts'), { code: '23514' });
    assert.equal(await auditCount(pool), 1);
    assert.equal(await receiptCount(pool), 1);
    const note = (await pool.query('SELECT evidence_note FROM shift_legacy_resolution_audit')).rows[0].evidence_note;
    assert.equal(note, NOTE);
  } finally { await pool.end(); }
});

test('the guard row is unique per workspace and canonical key', { skip: !approved }, async () => {
  const ids = await prepare('resolve_guard', [{ shiftId: 'shift_guard' }]);
  const pool = db();
  try {
    await call(pool, ids, 'shift_guard');
    const key = canonicalLegacyGuardKey({
      workspaceId: ids.workspaceId, objectId: ids.objectAId, workDate: WORK_DATE, shiftType: 'day',
    });
    const rows = (await pool.query(
      'SELECT workspace_id, guard_key FROM shift_legacy_resolution_guard WHERE workspace_id=$1',
      [ids.workspaceId],
    )).rows;
    assert.deepEqual(rows, [{ workspace_id: ids.workspaceId, guard_key: key }]);
    await assert.rejects(
      () => pool.query('INSERT INTO shift_legacy_resolution_guard(workspace_id,guard_key) VALUES($1,$2)', [ids.workspaceId, key]),
      { code: '23505' },
    );
  } finally { await pool.end(); }
});

test('the canonical guard lock serializes one key and leaves another key free', { skip: !approved }, async () => {
  const ids = await prepare('resolve_mutex', [{ shiftId: 'shift_mutex' }]);
  const pool = db(2);
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    const key = canonicalLegacyGuardKey({
      workspaceId: ids.workspaceId, objectId: ids.objectAId, workDate: WORK_DATE, shiftType: 'day',
    });
    const otherKey = canonicalLegacyGuardKey({
      workspaceId: ids.workspaceId, objectId: ids.objectBId, workDate: WORK_DATE, shiftType: 'day',
    });
    const [lockA, lockB] = legacyGuardLockIds(key);
    await first.query('BEGIN');
    await lockLegacyGuardKey(first, key);
    // Same canonical key: the second session must not get the lock.
    assert.equal((await second.query('SELECT pg_try_advisory_xact_lock($1::bigint) AND pg_try_advisory_xact_lock($2::bigint) AS ok', [lockA, lockB])).rows[0].ok, false);
    // A different canonical key is independent and passes immediately.
    const [otherA, otherB] = legacyGuardLockIds(otherKey);
    await second.query('BEGIN');
    assert.equal((await second.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS ok', [otherA])).rows[0].ok, true);
    assert.equal((await second.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS ok', [otherB])).rows[0].ok, true);
    await second.query('ROLLBACK');
    await first.query('ROLLBACK');
  } finally {
    first.release();
    second.release();
    await pool.end();
  }
});

// ---------- route adapter end to end ----------

test('the route adapter resolves through the same domain command', { skip: !approved }, async () => {
  const ids = await prepare('resolve_route', [{ shiftId: 'shift_route' }]);
  const pool = db();
  try {
    assert.equal(matchLegacyShiftResolutionPath('/api/v2/admin/legacy-shifts/shift_route/resolve'), 'shift_route');
    const result = await resolveLegacyShiftRoute(pool, { uid: ids.adminUid, workspaceId: ids.workspaceId }, 'shift_route', body());
    assert.equal(result.outcome, 'resolved');
    assert.equal(result.shiftType, 'day');
    await assert.rejects(
      () => resolveLegacyShiftRoute(pool, { uid: ids.foremanUid, workspaceId: ids.workspaceId }, 'shift_route', body({ operationId: 'op_route_2' })),
      { code: 'owner-acl-denied' },
    );
  } finally { await pool.end(); }
});

// ---------- Minor M4: backup manifest format is checked at the entrance ----------

test('the preflight CLI refuses a malformed backup manifest hash before touching the database', () => {
  const result = spawnSync(process.execPath, [
    'scripts/preflight-parallel-shifts.mjs',
    '--out', '/tmp/opencode/p5/never-written',
    '--expires-at', '2099-01-01T00:00:00.000Z',
    '--backup-manifest-sha256', 'not-a-sha256',
  ], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', env: { ...process.env, TEST_DATABASE_URL: '' } });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /backup-manifest-sha256/);
});
