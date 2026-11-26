import test from 'node:test';
import assert from 'node:assert/strict';
import { v2Error } from '../src/v2-errors.mjs';
import { matchV2Route, handleV2Request } from '../src/v2-router.mjs';
import { decodeShiftCursor, encodeShiftCursor } from '../src/shift-read-v2.mjs';

// v2 router foundation (design §5, §14, plan Task 18).
//
// The router is pure: the pool, the session lookup and the three readers are
// injected, so this root proves the HTTP contract — stable error body with
// `protocolVersion:2`, 404 for unknown v2 paths, 405 for a wrong method, 426 for
// a v1 client on a v2 route, 401 before any reader — without a database.

const WORKSPACE = 'main_workspace';

function fakeRequest({ method = 'GET', headers = {} } = {}) {
  return { method, headers, url: '/api/v2/shifts' };
}

function fakeResponse() {
  return { status: 0, body: undefined };
}

function harness({ method = 'GET', path = '/api/v2/shifts', search = '', headers = {}, authenticate, services } = {}) {
  const req = fakeRequest({ method, headers });
  const res = fakeResponse();
  const sent = [];
  const calls = { list: [], snapshot: [], loadActor: 0 };
  const defaultActor = { uid: 'uid_reader', displayName: 'Reader', role: 'foreman', status: 'active' };
  const options = {
    pool: { connect() { throw new Error('the router must not open a connection itself'); } },
    req,
    res,
    method,
    url: new URL(`http://localhost${path}${search}`),
    workspaceId: WORKSPACE,
    authenticate: authenticate ?? (async () => 'uid_reader'),
    send: (target, status, body) => { target.status = status; target.body = body; sent.push({ status, body }); },
    services: {
      loadActor: async (pool, uid) => { calls.loadActor += 1; return { ...defaultActor, uid }; },
      listVisibleShifts: async (pool, actor, query) => {
        calls.list.push({ pool, actor, query });
        return { items: [], nextCursor: null };
      },
      readShiftSnapshot: async (pool, actor, query) => {
        calls.snapshot.push({ pool, actor, query });
        return { protocolVersion: 2, workspaceId: WORKSPACE, shiftId: query.shiftId };
      },
      ...services,
    },
  };
  return { req, res, sent, calls, options };
}

test('matchV2Route recognises exactly the two Task 18 read routes', () => {
  assert.deepEqual(matchV2Route('/api/v2/shifts'), { kind: 'list' });
  assert.deepEqual(matchV2Route('/api/v2/shifts/shift_a1/snapshot'), { kind: 'snapshot', shiftId: 'shift_a1' });
  for (const path of [
    '/api/v2', '/api/v2/', '/api/v2/shifts/', '/api/v2/shifts/a/b', '/api/v2/shifts/a/snapshot/',
    '/api/v2/archives', '/api/v1/shifts', '/api/v2/shifts/a/snapshotx',
  ]) {
    assert.equal(matchV2Route(path), null, path);
  }
  // An id that is not a plain token is not a route (never a crash, never SQL).
  assert.equal(matchV2Route('/api/v2/shifts/a%20b/snapshot'), null);
  assert.equal(matchV2Route(`/api/v2/shifts/${'x'.repeat(161)}/snapshot`), null);
});

test('unknown v2 path answers 404 with the stable v2 body', async () => {
  const { res, sent, calls, options } = harness({ path: '/api/v2/archives' });
  assert.equal(await handleV2Request(options), true);
  assert.deepEqual(sent, [{ status: 404, body: { protocolVersion: 2, error: 'not-found', details: {} } }]);
  assert.equal(res.status, 404);
  assert.equal(calls.loadActor, 0);
});

test('a non-GET method on a known v2 path answers 405', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    const { sent, options } = harness({ method });
    assert.equal(await handleV2Request(options), true);
    assert.deepEqual(sent, [{ status: 405, body: { protocolVersion: 2, error: 'method-not-allowed', details: {} } }]);
  }
});

test('a v1 client on a v2 route answers 426 protocol-upgrade-required', async () => {
  const { sent, calls, options } = harness({ headers: { 'x-samosval-protocol': '1' } });
  assert.equal(await handleV2Request(options), true);
  assert.deepEqual(sent, [{
    status: 426,
    body: { protocolVersion: 2, error: 'protocol-upgrade-required', details: { protocolVersion: 1 } },
  }]);
  assert.equal(calls.loadActor, 0);
  // A declared v2 client passes the gate.
  const ok = harness({ headers: { 'x-samosval-protocol': '2' } });
  await handleV2Request(ok.options);
  assert.equal(ok.res.status, 200);
});

test('an unauthenticated request is 401 before any reader runs', async () => {
  const { sent, calls, options } = harness({ authenticate: async () => null });
  assert.equal(await handleV2Request(options), true);
  assert.deepEqual(sent, [{ status: 401, body: { protocolVersion: 2, error: 'unauthenticated', details: {} } }]);
  assert.equal(calls.loadActor, 0);
  assert.deepEqual(calls.list, []);
});

test('GET /api/v2/shifts parses state, limit and cursor and returns items with nextCursor', async () => {
  const { res, calls, options } = harness({ search: '?state=active,closing&limit=2&cursor=v2.1.abc' });
  await handleV2Request(options);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { items: [], nextCursor: null });
  assert.equal(calls.loadActor, 1);
  assert.equal(calls.list.length, 1);
  assert.deepEqual(calls.list[0].query, { workspaceId: WORKSPACE, state: 'active,closing', limit: '2', cursor: 'v2.1.abc' });
  assert.equal(calls.list[0].actor.uid, 'uid_reader');
  // No query at all keeps the reader's defaults (the reader validates limits).
  const plain = harness();
  await handleV2Request(plain.options);
  assert.deepEqual(plain.calls.list[0].query, { workspaceId: WORKSPACE, state: undefined, limit: undefined, cursor: undefined });
});

test('GET /api/v2/shifts/{id}/snapshot passes the scoped ids to the reader', async () => {
  const { res, calls, options } = harness({ path: '/api/v2/shifts/shift_a1/snapshot' });
  await handleV2Request(options);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { protocolVersion: 2, workspaceId: WORKSPACE, shiftId: 'shift_a1' });
  assert.deepEqual(calls.snapshot[0].query, { workspaceId: WORKSPACE, shiftId: 'shift_a1' });
});

test('a V2Error from a reader becomes its stable status and body', async () => {
  const error = v2Error('shift-not-visible', 404, { shiftId: 'shift_hidden' });
  const { sent, options } = harness({
    path: '/api/v2/shifts/shift_hidden/snapshot',
    services: { readShiftSnapshot: async () => { throw error; } },
  });
  await handleV2Request(options);
  assert.deepEqual(sent, [{
    status: 404,
    body: { protocolVersion: 2, error: 'shift-not-visible', details: { shiftId: 'shift_hidden' } },
  }]);
  // An unexpected failure never leaks its message or stack.
  const boom = harness({ services: { listVisibleShifts: async () => { throw new Error('boom: postgresql://user:secret@host/db'); } } });
  await handleV2Request(boom.options);
  assert.deepEqual(boom.sent, [{ status: 500, body: { protocolVersion: 2, error: 'internal', details: {} } }]);
});

test('the router ignores everything outside /api/v2', async () => {
  const { sent, options } = harness({ path: '/api/v1/shifts' });
  assert.equal(await handleV2Request(options), false);
  assert.deepEqual(sent, []);
});

test('shift cursors are opaque, versioned and strictly validated', () => {
  const cursor = encodeShiftCursor({ openedAt: new Date('2026-11-23T17:00:00.000Z'), shiftId: 'shift_a1' });
  assert.match(cursor, /^v2\.1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeShiftCursor(cursor), { openedAt: new Date('2026-11-23T17:00:00.000Z'), shiftId: 'shift_a1' });
  assert.equal(encodeShiftCursor(decodeShiftCursor(cursor)), cursor);
  const bad = [
    undefined, null, 42, '', 'v2.1.', 'v2.1.!!!', 'v1.1.eyJvIjoiMjAyNi0xMS0yM1QxNzowMDowMC4wMDBaIiwicyI6InNoaWZ0In0',
    'v2.1.' + Buffer.from('[]').toString('base64url'),
    'v2.1.' + Buffer.from('{"o":"2026-11-23T17:00:00.000Z"}').toString('base64url'),
    'v2.1.' + Buffer.from('{"s":"shift_a1"}').toString('base64url'),
    'v2.1.' + Buffer.from('{"o":"23.11.2026","s":"shift_a1"}').toString('base64url'),
    'v2.1.' + Buffer.from('{"o":"2026-11-23T17:00:00.000Z","s":"a b"}').toString('base64url'),
    'v2.1.' + Buffer.from('{"o":"2026-11-23T17:00:00.000Z","s":"shift","x":1}').toString('base64url'),
  ];
  for (const value of bad) {
    assert.throws(() => decodeShiftCursor(value), error => {
      assert.equal(error.name, 'V2Error');
      assert.equal(error.code, 'invalid-command');
      assert.equal(error.status, 400);
      assert.deepEqual(error.details, { field: 'cursor' });
      return true;
    }, String(value));
  }
});
