import test from 'node:test';
import assert from 'node:assert/strict';
import { v2Error } from '../src/v2-errors.mjs';
import { matchV2Route, handleV2Request } from '../src/v2-router.mjs';
import { openRestoredArchive, submitArchiveOperationV2 } from '../src/archive-restored-v2.mjs';

// Restored-archive v2 routes (design §5.6, §6, plan Task 26/§13 blocker).
//
// The router stays pure: `openRestoredArchive` and `submitArchiveOperationV2`
// are injected, so this root proves the HTTP contract without a database —
// matched paths, 404 for unknown, 405 for a wrong method, 426 for a v1 client,
// 401 before any reader, and a stable body for every refusal. The database
// behaviour (idempotent open, CAS, receipts, untouched active tables) is owned
// by `tests/v2-archive-restore-db.test.mjs`.

const WORKSPACE = 'main_workspace';
const ARCHIVE = 'archive_restore_a1';

function harness({ method = 'GET', path = `/api/v2/archives/${ARCHIVE}/restored`, search = '', headers = {}, authenticate, services, body } = {}) {
  const req = { method, headers, url: path };
  const res = { status: 0, body: undefined };
  const sent = [];
  const calls = { open: [], operation: [], loadActor: 0 };
  const options = {
    pool: { connect() { throw new Error('the router must not open a connection itself'); } },
    req,
    res,
    method,
    url: new URL(`http://localhost${path}${search}`),
    workspaceId: WORKSPACE,
    authenticate: authenticate ?? (async () => 'uid_archivist'),
    send: (target, status, payload) => { target.status = status; target.body = payload; sent.push({ status, body: payload }); },
    ...(body === undefined ? {} : { body }),
    services: {
      loadActor: async (pool, uid) => { calls.loadActor += 1; return { uid, displayName: 'Архивист', role: 'archivist', status: 'active' }; },
      openRestoredArchive: async (pool, actor, query) => {
        calls.open.push({ actor, query });
        return { protocolVersion: 2, workspaceId: WORKSPACE, archiveId: query.archiveId, restoredContextId: 'rctx_a1', contextRevision: 1 };
      },
      submitArchiveOperationV2: async (pool, actor, command) => {
        calls.operation.push({ actor, command });
        return { protocolVersion: 2, operationId: command.operationId, replayed: false, result: { restoredContextId: command.restoredContextId, contextRevision: 2 } };
      },
      ...services,
    },
  };
  return { req, res, sent, calls, options };
}

const failureBody = (code, details = {}) => ({ protocolVersion: 2, error: code, details });

test('the two restored-archive paths are known routes with exactly one method', () => {
  assert.deepEqual(matchV2Route(`/api/v2/archives/${ARCHIVE}/restored`, 'GET'), { kind: 'archive-restored', archiveId: ARCHIVE });
  assert.equal(matchV2Route(`/api/v2/archives/${ARCHIVE}/restored`, 'POST'), null);
  assert.deepEqual(matchV2Route(`/api/v2/archives/${ARCHIVE}/operations`, 'POST'), { kind: 'archive-operations', archiveId: ARCHIVE });
  assert.equal(matchV2Route(`/api/v2/archives/${ARCHIVE}/operations`, 'GET'), null);
  // An unknown sibling stays unknown: no silent fall-through to a near path.
  assert.equal(matchV2Route(`/api/v2/archives/${ARCHIVE}/finalize`, 'POST'), null);
  // Only the plain token form is an archive id.
  assert.equal(matchV2Route('/api/v2/archives/a%20b/restored', 'GET'), null);
  assert.equal(matchV2Route('/api/v2/archives//restored', 'GET'), null);
});

test('a wrong method on a known restored-archive path answers 405, an unknown path 404', async () => {
  const wrong = harness({ method: 'POST', path: `/api/v2/archives/${ARCHIVE}/restored`, body: {} });
  await handleV2Request(wrong.options);
  assert.deepEqual(wrong.sent, [{ status: 405, body: failureBody('method-not-allowed') }]);

  const unknown = harness({ path: `/api/v2/archives/${ARCHIVE}/nope` });
  await handleV2Request(unknown.options);
  assert.deepEqual(unknown.sent, [{ status: 404, body: failureBody('not-found') }]);

  // A v1 client is refused before authentication or any reader.
  const old = harness({ headers: { 'x-samosval-protocol': '1' } });
  await handleV2Request(old.options);
  assert.deepEqual(old.sent, [{ status: 426, body: failureBody('protocol-upgrade-required', { protocolVersion: 1 }) }]);
  assert.equal(old.calls.loadActor, 0);

  const anonymous = harness({ authenticate: async () => null });
  await handleV2Request(anonymous.options);
  assert.deepEqual(anonymous.sent, [{ status: 401, body: failureBody('unauthenticated') }]);
  assert.equal(anonymous.calls.open.length, 0);
});

test('GET restored passes the archive, revision, limit and cursor to the opener', async () => {
  const { res, calls, options } = harness({ search: '?revision=3&limit=50&cursor=log_c' });
  await handleV2Request(options);
  assert.equal(res.status, 200);
  assert.equal(res.body.archiveId, ARCHIVE);
  assert.equal(calls.loadActor, 1);
  assert.deepEqual(calls.open[0].query, { workspaceId: WORKSPACE, archiveId: ARCHIVE, revision: 3, limit: 50, cursor: 'log_c' });
  assert.equal(calls.open[0].actor.uid, 'uid_archivist');

  // No query at all: the latest finalized revision is chosen by the domain.
  const plain = harness();
  await handleV2Request(plain.options);
  assert.deepEqual(plain.calls.open[0].query, { workspaceId: WORKSPACE, archiveId: ARCHIVE, revision: undefined, limit: undefined, cursor: undefined });
});

test('GET restored validates the query before touching the domain', async () => {
  for (const [search, field] of [
    ['?revision=abc', 'revision'], ['?revision=0', 'revision'], ['?revision=1.5', 'revision'], ['?revision=-2', 'revision'],
    ['?limit=0', 'limit'], ['?limit=201', 'limit'], ['?limit=2.5', 'limit'],
    ['?cursor=a%2Fb', 'cursor'], ['?cursor=', 'cursor'],
  ]) {
    const { sent, calls, options } = harness({ search });
    await handleV2Request(options);
    assert.deepEqual(sent, [{ status: 400, body: failureBody('invalid-command', { field }) }], search);
    assert.equal(calls.open.length, 0, search);
  }
});

test('POST operations passes the path archive and the body to the command', async () => {
  const body = {
    operationId: 'op_archive_trip_1', protocolVersion: 2, restoredContextId: 'rctx_a1',
    type: 'trip.update', recordId: 'log_a', expectedContextRevision: 1,
    expectedBaseArchiveRevision: 1, expectedBaseSha256: 'a'.repeat(64),
    volume: 18, timeStr: '09:30', comment: 'правка',
  };
  const { res, calls, options } = harness({ method: 'POST', path: `/api/v2/archives/${ARCHIVE}/operations`, body });
  await handleV2Request(options);
  assert.equal(res.status, 200);
  assert.equal(res.body.operationId, 'op_archive_trip_1');
  assert.equal(calls.operation.length, 1);
  assert.equal(calls.operation[0].command.archiveId, ARCHIVE);
  assert.equal(calls.operation[0].command.workspaceId, WORKSPACE);
  assert.equal(calls.operation[0].command.restoredContextId, 'rctx_a1');
  assert.equal(calls.operation[0].command.type, 'trip.update');
  assert.equal(calls.operation[0].actor.uid, 'uid_archivist');
});

test('a domain refusal keeps its stable v2 code and never becomes a 500', async () => {
  const conflict = harness({
    path: `/api/v2/archives/${ARCHIVE}/restored`,
    services: { openRestoredArchive: async () => { throw v2Error('archive-changed', 409, { archiveId: ARCHIVE }); } },
  });
  await handleV2Request(conflict.options);
  assert.deepEqual(conflict.sent, [{ status: 409, body: failureBody('archive-changed', { archiveId: ARCHIVE }) }]);

  const finalized = harness({
    method: 'POST',
    path: `/api/v2/archives/${ARCHIVE}/operations`,
    body: { operationId: 'op_x', protocolVersion: 2, restoredContextId: 'rctx_a1', type: 'trip.delete', recordId: 'log_a', expectedContextRevision: 2, expectedBaseArchiveRevision: 1, expectedBaseSha256: 'a'.repeat(64) },
    services: { submitArchiveOperationV2: async () => { throw v2Error('archive-context-finalized', 409, { restoredContextId: 'rctx_a1' }); } },
  });
  await handleV2Request(finalized.options);
  assert.deepEqual(finalized.sent, [{ status: 409, body: failureBody('archive-context-finalized', { restoredContextId: 'rctx_a1' }) }]);

  // An unexpected failure is a bare `internal` — no SQL, DSN, stack or message.
  const boom = harness({ services: { openRestoredArchive: async () => { throw new Error('boom: postgresql://u:secret@host/db'); } } });
  await handleV2Request(boom.options);
  assert.deepEqual(boom.sent, [{ status: 500, body: failureBody('internal') }]);
});

test('the v2 wrapper refuses a bad command before it opens a connection', async () => {
  const pool = { connect() { throw new Error('validation must not touch the database'); } };
  const actor = { uid: 'uid_archivist', displayName: 'Архивист', role: 'archivist', status: 'active' };
  const base = {
    workspaceId: WORKSPACE, archiveId: ARCHIVE, operationId: 'op_bad', protocolVersion: 2,
    restoredContextId: 'rctx_a1', recordId: 'log_a', expectedContextRevision: 1,
    expectedBaseArchiveRevision: 1, expectedBaseSha256: 'a'.repeat(64),
  };
  const rejected = async (input, code, status, details) => assert.rejects(
    submitArchiveOperationV2(pool, actor, input),
    error => {
      assert.equal(error.name, 'V2Error');
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      if (details) assert.deepEqual(error.details, details);
      return true;
    },
  );
  // Only the four archive correction types exist; finalize has its own route.
  await rejected({ ...base, type: 'restored.finalize' }, 'archive-operation-not-allowed', 400, { field: 'type' });
  await rejected({ ...base, type: 'archive.restore' }, 'archive-operation-not-allowed', 400, { field: 'type' });
  await rejected({ ...base, type: 'trip.update', recordId: '' }, 'invalid-command', 400, { field: 'recordId' });
  await rejected({ ...base, type: 'trip.update', expectedContextRevision: 0 }, 'invalid-command', 400, { field: 'expectedContextRevision' });
  await rejected({ ...base, type: 'trip.update', expectedBaseArchiveRevision: '1' }, 'invalid-command', 400, { field: 'expectedBaseArchiveRevision' });
  await rejected({ ...base, type: 'trip.update', expectedBaseSha256: 'xyz' }, 'invalid-command', 400, { field: 'expectedBaseSha256' });
  await rejected({ ...base, type: 'trip.update', volume: -1, timeStr: '09:30', comment: '' }, 'invalid-command', 400, { field: 'data' });
  await rejected({ ...base, type: 'trip.update', volume: 10, timeStr: '25:00', comment: '' }, 'invalid-command', 400, { field: 'data' });
  await rejected({ ...base, type: 'trip.update', volume: 10, timeStr: '09:30' }, 'invalid-command', 400, { field: 'data' });
  await rejected({ ...base, type: 'ttn.update', ttnStatus: 'collected' }, 'invalid-command', 400, { field: 'data' });
  await rejected({ ...base, type: 'ttn.delete', ttnStatus: true }, 'invalid-command', 400, { field: 'data' });
  await rejected({ ...base, type: 'trip.delete', protocolVersion: 1 }, 'protocol-upgrade-required', 426);
  await rejected({ ...base, type: 'trip.delete', operationId: 'a b' }, 'invalid-command', 400, { field: 'operationId' });

  // Opening validates its own arguments the same way.
  await assert.rejects(
    openRestoredArchive(pool, actor, { workspaceId: WORKSPACE, archiveId: 'a b' }),
    error => error.name === 'V2Error' && error.code === 'invalid-command' && error.details.field === 'archiveId',
  );
  await assert.rejects(
    openRestoredArchive(pool, actor, { workspaceId: WORKSPACE, archiveId: ARCHIVE, limit: 500 }),
    error => error.name === 'V2Error' && error.code === 'invalid-command' && error.details.field === 'limit',
  );
  await assert.rejects(
    openRestoredArchive(pool, actor, { workspaceId: WORKSPACE, archiveId: ARCHIVE, revision: 0 }),
    error => error.name === 'V2Error' && error.code === 'invalid-command' && error.details.field === 'revision',
  );
});
