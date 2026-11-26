import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {v2Error, v2ErrorBody, V2_ERROR_CODES} from '../src/v2-errors.mjs';
import {canonicalJson, commandHash, runV2Command} from '../src/v2-command.mjs';

// The shared vector is part of the contract: the browser transport (Task 24)
// must produce the same commandHash for the same seven fields, so it is pinned
// here as a constant instead of being recomputed by the code under test.
const VECTOR = Object.freeze({
  uid: 'uid_fixture_admin',
  workspaceId: 'main_workspace',
  shiftId: 'shift_fixture_night',
  protocolVersion: 2,
  operation: 'op_fixture_0001',
  type: 'shift.member.add',
  body: {uid: 'uid_member', expectedShiftRevision: 3}
});
const VECTOR_CANONICAL = '{"body":{"expectedShiftRevision":3,"uid":"uid_member"},"operation":"op_fixture_0001","protocolVersion":2,"shiftId":"shift_fixture_night","type":"shift.member.add","uid":"uid_fixture_admin","workspaceId":"main_workspace"}';
const VECTOR_HASH = '1179ba8ae28353a50ba2bb6c3bb00d828c5b22127010366a5f1f6d9d80706a64';

test('canonicalJson sorts object keys by UTF-16 code units and keeps array order', () => {
  assert.equal(canonicalJson({b: 1, a: {d: 2, c: [3, 1, {z: true, y: null}]}}), '{"a":{"c":[3,1,{"y":null,"z":true}],"d":2},"b":1}');
  // 'A' (0x41) < 'z' (0x7a) < 'é' (0xe9): plain code-unit order, not locale order.
  assert.equal(canonicalJson({é: 1, z: 2, A: 3}), '{"A":3,"z":2,"é":1}');
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson({}), '{}');
  assert.equal(canonicalJson({nested: [[1], [2, 3]]}), '{"nested":[[1],[2,3]]}');
});

test('canonicalJson escapes strings exactly like JSON and keeps non-ASCII readable', () => {
  const raw = 'a"b\\c\n\u0001\t';
  assert.equal(canonicalJson(raw), JSON.stringify(raw));
  assert.equal(canonicalJson('привет'), '"привет"');
  assert.equal(canonicalJson({key: 'значение'}), '{"key":"значение"}');
});

test('canonicalJson rejects everything that is not finite JSON', () => {
  class Point { constructor() { this.x = 1; } }
  const cyclic = {a: 1};
  cyclic.self = cyclic;
  const symbolKeyed = {a: 1, [Symbol('hidden')]: 2};
  const sparse = [1, , 3];
  const cases = {
    undefined: undefined,
    function: () => 1,
    symbol: Symbol('x'),
    bigint: 10n,
    nan: Number.NaN,
    infinity: Number.POSITIVE_INFINITY,
    negativeInfinity: Number.NEGATIVE_INFINITY,
    date: new Date(0),
    map: new Map([['a', 1]]),
    set: new Set([1]),
    regexp: /x/,
    typedArray: new Uint8Array(1),
    classInstance: new Point(),
    undefinedValue: {a: undefined},
    undefinedElement: [1, undefined],
    sparse,
    symbolKeyed,
    cyclic,
    loneHighSurrogate: '\ud800',
    loneLowSurrogate: 'x\udc00',
    surrogateKey: {['\ud800']: 1}
  };
  for (const [name, value] of Object.entries(cases)) {
    assert.throws(() => canonicalJson(value), TypeError, `canonicalJson must reject ${name}`);
  }
  // -0 is not representable in JSON; JCS writes it as 0 and the normalization is
  // explicit, never a silent rounding of another value.
  assert.equal(canonicalJson({a: -0}), '{"a":0}');
  assert.equal(canonicalJson({a: 0}), '{"a":0}');
});

test('commandHash matches the pinned vector and its canonical preimage', () => {
  assert.equal(canonicalJson(VECTOR), VECTOR_CANONICAL);
  assert.equal(commandHash(VECTOR), VECTOR_HASH);
  assert.match(commandHash(VECTOR), /^[0-9a-f]{64}$/);
  // Key order inside body and in the parts object never changes the hash.
  assert.equal(commandHash({body: {expectedShiftRevision: 3, uid: 'uid_member'}, type: VECTOR.type, operation: VECTOR.operation, protocolVersion: 2, shiftId: VECTOR.shiftId, workspaceId: VECTOR.workspaceId, uid: VECTOR.uid}), VECTOR_HASH);
});

test('commandHash changes when any of the seven fields changes', () => {
  const changes = {
    uid: 'uid_fixture_other',
    workspaceId: 'other_workspace',
    shiftId: 'shift_fixture_day',
    protocolVersion: 3,
    operation: 'op_fixture_0002',
    type: 'shift.member.remove',
    body: {uid: 'uid_member', expectedShiftRevision: 4}
  };
  assert.deepEqual(Object.keys(changes).sort(), Object.keys(VECTOR).sort());
  for (const [field, value] of Object.entries(changes)) {
    const hash = commandHash({...VECTOR, [field]: value});
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.notEqual(hash, VECTOR_HASH, `changing ${field} must change the command hash`);
  }
});

test('commandHash requires exactly the seven command fields', () => {
  assert.throws(() => commandHash({...VECTOR, protocolVersion: undefined}), TypeError);
  const {body, ...withoutBody} = VECTOR;
  assert.throws(() => commandHash(withoutBody), TypeError);
  assert.throws(() => commandHash({...VECTOR, operationId: VECTOR.operation}), TypeError);
  assert.throws(() => commandHash({...VECTOR, expectedShiftRevision: 1}), TypeError);
  assert.throws(() => commandHash(null), TypeError);
  assert.throws(() => commandHash([VECTOR]), TypeError);
});

test('v2Error keeps a stable shape and only whitelisted safe details', () => {
  const details = {
    shiftId: 'shift_1',
    reason: 'not-member',
    expectedRevision: 4,
    replayed: false,
    expectedMembershipRevision: null,
    dsn: 'postgresql://user:secret@db.example/samosval',
    stack: 'Error: boom\n    at handler',
    email: 'driver@example.test',
    message: 'internal secret',
    password: 'secret',
    sql: 'SELECT * FROM app_users',
    nested: {uid: 'leak'},
    attempts: 3,
    control: 'a\nb',
    tooLong: 'x'.repeat(300)
  };
  const error = v2Error('forbidden', 403, details);
  assert.equal(error.name, 'V2Error');
  assert.equal(error.code, 'forbidden');
  assert.equal(error.status, 403);
  assert.deepEqual(error.details, {expectedMembershipRevision: null, expectedRevision: 4, reason: 'not-member', replayed: false, shiftId: 'shift_1'});
  assert.deepEqual(error.error, {code: 'forbidden', status: 403, details: error.details});
  assert.deepEqual(error.body, {protocolVersion: 2, error: 'forbidden', details: error.details});
  assert.deepEqual(v2ErrorBody(error), error.body);
  // Unknown codes and statuses fail closed: a typo must never reach the client.
  assert.throws(() => v2Error('made-up-code', 400), TypeError);
  assert.throws(() => v2Error('forbidden', 418), TypeError);
  assert.throws(() => v2Error('forbidden', '403'), TypeError);
  assert.ok(Object.isFrozen(V2_ERROR_CODES));
  assert.equal(V2_ERROR_CODES['protocol-upgrade-required'], 426);
  assert.equal(V2_ERROR_CODES['operation-id-reused'], 409);
  // Foreign errors never leak their message or stack through the response body.
  assert.deepEqual(v2ErrorBody(new Error('boom: postgresql://user:secret@host/db')), {protocolVersion: 2, error: 'internal', details: {}});
  assert.deepEqual(v2ErrorBody(undefined), {protocolVersion: 2, error: 'internal', details: {}});
});

test('v2 command receipts, replay, ACL and rollback are atomic', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const pool = new pg.Pool({connectionString: process.env.TEST_DATABASE_URL, max: 5});
  // Lesson 29.4: a terminated backend must not surface as an unhandled pool error.
  pool.on('error', () => {});
  const prefix = 'v2cmd_' + randomUUID().replaceAll('-', '');
  const workspaceId = 'main_workspace';
  const uid = prefix + '_admin';
  const otherUid = prefix + '_other';
  const shiftId = prefix + '_shift';
  const truckId = prefix + '_truck';
  const operation = prefix + '_op';
  const hash = over => commandHash({uid, workspaceId, shiftId, protocolVersion: 2, operation, type: 'shift.truck.add', body: {truckId}, ...over});
  const command = (over = {}) => ({
    pool,
    uid,
    workspaceId,
    shiftId,
    protocolVersion: 2,
    operation,
    type: 'shift.truck.add',
    body: {truckId},
    authorize: async () => ({uid, role: 'admin'}),
    mutate: async client => {
      await client.query('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ($1,$2,$3)', [workspaceId, truckId, {number: 'V2'}]);
      return {result: {truckId, shiftId}, before: {trucks: 0}, after: {trucks: 1}};
    },
    ...over
  });
  const receipts = op => pool.query('SELECT uid,request_hash,result FROM shift_operation_receipts WHERE workspace_id=$1 AND operation_id=$2', [workspaceId, op]);
  const audits = op => pool.query('SELECT uid,type,before_data,after_data FROM workspace_service_audit WHERE workspace_id=$1 AND operation_id=$2', [workspaceId, op]);
  const trucks = id => pool.query('SELECT count(*)::int AS n FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [workspaceId, id]);
  try {
    await pool.query("INSERT INTO workspaces(id) VALUES ('main_workspace') ON CONFLICT DO NOTHING");
    for (const id of [uid, otherUid]) {
      await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,'v2@example.test','Fixture','admin','active')", [id]);
    }

    await t.test('fresh command commits receipt, audit and mutation together', async () => {
      const envelope = await runV2Command(command());
      assert.deepEqual(envelope, {protocolVersion: 2, operationId: operation, replayed: false, result: {shiftId, truckId}});
      const receipt = (await receipts(operation)).rows[0];
      assert.equal(receipt.uid, uid);
      assert.equal(receipt.request_hash, hash({}));
      assert.deepEqual(receipt.result, {shiftId, truckId});
      const audit = (await audits(operation)).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].uid, uid);
      assert.equal(audit[0].type, 'shift.truck.add');
      assert.deepEqual(audit[0].before_data, {shiftId, trucks: 0});
      assert.deepEqual(audit[0].after_data, {shiftId, trucks: 1});
      assert.equal((await trucks(truckId)).rows[0].n, 1);
    });

    await t.test('identical replay returns the stored result without a second mutation or audit', async () => {
      let authorizeCalls = 0;
      const envelope = await runV2Command(command({authorize: async () => { authorizeCalls += 1; return {uid, role: 'admin'}; }}));
      assert.deepEqual(envelope, {protocolVersion: 2, operationId: operation, replayed: true, result: {shiftId, truckId}});
      // The session/ACL is re-checked even for an identical receipt.
      assert.equal(authorizeCalls, 1);
      assert.equal((await trucks(truckId)).rows[0].n, 1);
      assert.equal((await audits(operation)).rows.length, 1);
    });

    await t.test('authorization is re-checked before a replay result is returned', async () => {
      let mutated = 0;
      const denied = command({
        authorize: async () => { throw v2Error('forbidden', 403, {reason: 'session-revoked'}); },
        mutate: async () => { mutated += 1; return {result: {}}; }
      });
      await assert.rejects(runV2Command(denied), error => {
        assert.equal(error.name, 'V2Error');
        assert.equal(error.code, 'forbidden');
        assert.equal(error.status, 403);
        assert.deepEqual(error.details, {reason: 'session-revoked'});
        return true;
      });
      // A revoked admin never sees the stored result and never reaches the mutation.
      assert.equal(mutated, 0);
      assert.equal((await receipts(operation)).rows.length, 1);
      assert.equal((await audits(operation)).rows.length, 1);
    });

    await t.test('another hash or uid for the same operation id is operation-id-reused', async () => {
      const otherBody = {...command(), body: {truckId: truckId + '_other'}};
      await assert.rejects(runV2Command(otherBody), error => {
        assert.equal(error.code, 'operation-id-reused');
        assert.equal(error.status, 409);
        return true;
      });
      const otherActor = command({uid: otherUid, authorize: async () => ({uid: otherUid, role: 'admin'})});
      await assert.rejects(runV2Command(otherActor), error => {
        assert.equal(error.code, 'operation-id-reused');
        assert.equal(error.status, 409);
        return true;
      });
      const receipt = (await receipts(operation)).rows[0];
      assert.equal(receipt.uid, uid);
      assert.equal(receipt.request_hash, hash({}));
      assert.equal((await audits(operation)).rows.length, 1);
      assert.equal((await trucks(truckId)).rows[0].n, 1);
    });

    await t.test('a failing mutation rolls back receipt, audit and mutation', async () => {
      const failedOperation = prefix + '_op_fail';
      const failedTruck = prefix + '_truck_fail';
      await assert.rejects(runV2Command(command({
        operation: failedOperation,
        mutate: async client => {
          await client.query('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ($1,$2,$3)', [workspaceId, failedTruck, {number: 'FAIL'}]);
          throw new Error('mutation exploded');
        }
      })), /mutation exploded/);
      assert.equal((await receipts(failedOperation)).rows.length, 0);
      assert.equal((await audits(failedOperation)).rows.length, 0);
      assert.equal((await trucks(failedTruck)).rows[0].n, 0);
      // Nothing was poisoned: the same operation id succeeds on a clean retry.
      const retryTruck = prefix + '_truck_retry';
      const retried = await runV2Command(command({
        operation: failedOperation,
        mutate: async client => {
          await client.query('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ($1,$2,$3)', [workspaceId, retryTruck, {number: 'RETRY'}]);
          return {result: {truckId: retryTruck}, after: {trucks: 1}};
        }
      }));
      assert.equal(retried.replayed, false);
      assert.deepEqual(retried.result, {truckId: retryTruck});
      assert.equal((await trucks(retryTruck)).rows[0].n, 1);
      assert.equal((await receipts(failedOperation)).rows.length, 1);
      assert.equal((await audits(failedOperation)).rows.length, 1);
    });

    await t.test('a non-finite command result rolls back the whole transaction', async () => {
      const badOperation = prefix + '_op_bad_result';
      await assert.rejects(runV2Command(command({operation: badOperation, mutate: async () => ({result: {at: new Date()}})})), error => {
        assert.equal(error.code, 'invalid-command');
        assert.equal(error.status, 400);
        return true;
      });
      assert.equal((await receipts(badOperation)).rows.length, 0);
      assert.equal((await audits(badOperation)).rows.length, 0);
    });

    await t.test('protocolVersion other than 2 fails before authorization or any write', async () => {
      let authorized = 0;
      const legacy = command({protocolVersion: 1, operation: prefix + '_op_v1', authorize: async () => { authorized += 1; return {uid}; }});
      await assert.rejects(runV2Command(legacy), error => {
        assert.equal(error.code, 'protocol-upgrade-required');
        assert.equal(error.status, 426);
        assert.equal(error.details.protocolVersion, 1);
        return true;
      });
      assert.equal(authorized, 0);
      assert.equal((await receipts(prefix + '_op_v1')).rows.length, 0);
      assert.equal((await audits(prefix + '_op_v1')).rows.length, 0);
    });

    await t.test('malformed commands are rejected before the database is touched', async () => {
      await assert.rejects(runV2Command(command({operation: 'bad id with spaces'})), error => {
        assert.equal(error.code, 'invalid-command');
        assert.equal(error.status, 400);
        assert.equal(error.details.field, 'operationId');
        return true;
      });
      await assert.rejects(runV2Command(command({body: undefined})), error => {
        assert.equal(error.code, 'invalid-command');
        assert.equal(error.status, 400);
        assert.equal(error.details.field, 'body');
        return true;
      });
      await assert.rejects(runV2Command(command({mutate: 'not-a-function'})), error => {
        assert.equal(error.code, 'invalid-command');
        assert.equal(error.status, 400);
        return true;
      });
    });
  } finally {
    await pool.query('DELETE FROM shift_operation_receipts WHERE uid = ANY($1)', [[uid, otherUid]]);
    await pool.query('DELETE FROM workspace_service_audit WHERE uid = ANY($1)', [[uid, otherUid]]);
    await pool.query('DELETE FROM line_trucks WHERE workspace_id=$1 AND truck_id LIKE $2', [workspaceId, prefix + '%']);
    await pool.query('DELETE FROM app_users WHERE uid = ANY($1)', [[uid, otherUid]]);
    await pool.end();
  }
});
