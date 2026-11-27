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

function commandEnvelope(operationId, result) {
  return { protocolVersion: 2, operationId, replayed: false, result };
}

function harness({ method = 'GET', path = '/api/v2/shifts', search = '', headers = {}, authenticate, services, body } = {}) {
  const req = fakeRequest({ method, headers });
  const res = fakeResponse();
  const sent = [];
  const calls = { list: [], snapshot: [], loadActor: 0, create: [], object: [], memberAdd: [], memberRemove: [], truckAdd: [], truckRemove: [], transfer: [], complete: [], line: [] };
  const defaultActor = { uid: 'uid_reader', displayName: 'Reader', role: 'foreman', status: 'active' };
  const options = {
    pool: { connect() { throw new Error('the router must not open a connection itself'); } },
    req,
    res,
    method,
    url: new URL(`http://localhost${path}${search}`),
    workspaceId: WORKSPACE,
    authenticate: authenticate ?? (async () => 'uid_reader'),
    send: (target, status, payload) => { target.status = status; target.body = payload; sent.push({ status, body: payload }); },
    ...(body === undefined ? {} : { body }),
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
      createShift: async (pool, actor, command) => {
        calls.create.push({ pool, actor, command });
        return commandEnvelope(command.operationId, { shift: { shiftId: `shift_${command.operationId}` } });
      },
      changeShiftObject: async (pool, actor, command) => {
        calls.object.push({ actor, command });
        return commandEnvelope(command.operationId, { shift: { shiftId: command.shiftId } });
      },
      addShiftMember: async (pool, actor, command) => {
        calls.memberAdd.push({ actor, command });
        return commandEnvelope(command.operationId, { membership: { uid: command.uid } });
      },
      removeShiftMember: async (pool, actor, command) => {
        calls.memberRemove.push({ actor, command });
        return commandEnvelope(command.operationId, { membership: { uid: command.uid } });
      },
      assignTruck: async (pool, actor, command) => {
        calls.truckAdd.push({ actor, command });
        return commandEnvelope(command.operationId, { assignment: { truckId: command.truckId } });
      },
      removeTruck: async (pool, actor, command) => {
        calls.truckRemove.push({ actor, command });
        return commandEnvelope(command.operationId, { removed: true, truckId: command.truckId });
      },
      forceTransferTruck: async (pool, actor, command) => {
        calls.transfer.push({ actor, command });
        return commandEnvelope(command.operationId, { truckId: command.truckId });
      },
      completeDetachedTrip: async (pool, actor, command) => {
        calls.complete.push({ actor, command });
        return commandEnvelope(command.operationId, { cycleId: command.cycleId });
      },
      submitLineOperationV2: async (pool, actor, command) => {
        calls.line.push({ actor, command });
        return commandEnvelope(command.operationId, { type: command.type, truckId: command.truckId });
      },
      ...services,
    },
  };
  return { req, res, sent, calls, options };
}

test('matchV2Route recognises the read and command routes per method', () => {
  assert.deepEqual(matchV2Route('/api/v2/shifts'), { kind: 'list' });
  assert.deepEqual(matchV2Route('/api/v2/shifts', 'POST'), { kind: 'create' });
  assert.deepEqual(matchV2Route('/api/v2/shifts/shift_a1/snapshot'), { kind: 'snapshot', shiftId: 'shift_a1' });
  assert.deepEqual(matchV2Route('/api/v2/shifts/shift_a1/object', 'PATCH'), { kind: 'shift-object', shiftId: 'shift_a1' });
  assert.deepEqual(matchV2Route('/api/v2/shifts/shift_a1/members', 'POST'), { kind: 'member-add', shiftId: 'shift_a1' });
  assert.deepEqual(matchV2Route('/api/v2/shifts/shift_a1/members/uid_member', 'DELETE'), {
    kind: 'member-remove', shiftId: 'shift_a1', uid: 'uid_member',
  });
  assert.deepEqual(matchV2Route('/api/v2/shifts/shift_a1/trucks', 'POST'), {
    kind: 'truck-add', shiftId: 'shift_a1',
  });
  assert.deepEqual(matchV2Route('/api/v2/shifts/shift_a1/trucks/truck_1', 'DELETE'), {
    kind: 'truck-remove', shiftId: 'shift_a1', truckId: 'truck_1',
  });
  assert.deepEqual(matchV2Route('/api/v2/shifts/shift_a1/trucks/truck_1/force-transfer', 'POST'), {
    kind: 'truck-force-transfer', shiftId: 'shift_a1', truckId: 'truck_1',
  });
  assert.deepEqual(matchV2Route('/api/v2/shifts/shift_a1/detached-trips/cycle_1/complete', 'POST'), {
    kind: 'detached-complete', shiftId: 'shift_a1', cycleId: 'cycle_1',
  });
  assert.deepEqual(matchV2Route('/api/v2/shifts/shift_a1/line-operations', 'POST'), {
    kind: 'line-operations', shiftId: 'shift_a1',
  });
  // A known path with a wrong method is not a route (the handler answers 405).
  for (const [path, method] of [
    ['/api/v2/shifts', 'PUT'], ['/api/v2/shifts', 'PATCH'], ['/api/v2/shifts', 'DELETE'],
    ['/api/v2/shifts/a/snapshot', 'POST'], ['/api/v2/shifts/a/object', 'GET'],
    ['/api/v2/shifts/a/object', 'POST'], ['/api/v2/shifts/a/members', 'GET'],
    ['/api/v2/shifts/a/members', 'DELETE'], ['/api/v2/shifts/a/members/u', 'POST'],
    ['/api/v2/shifts/a/members/u', 'PATCH'],
    ['/api/v2/shifts/a/trucks', 'GET'], ['/api/v2/shifts/a/trucks', 'PUT'],
    ['/api/v2/shifts/a/trucks', 'DELETE'], ['/api/v2/shifts/a/trucks/t', 'GET'],
    ['/api/v2/shifts/a/trucks/t', 'POST'], ['/api/v2/shifts/a/trucks/t', 'PATCH'],
    ['/api/v2/shifts/a/trucks/t/force-transfer', 'GET'],
    ['/api/v2/shifts/a/trucks/t/force-transfer', 'DELETE'],
    ['/api/v2/shifts/a/detached-trips/c/complete', 'GET'],
    ['/api/v2/shifts/a/detached-trips/c/complete', 'DELETE'],
    ['/api/v2/shifts/a/line-operations', 'GET'],
    ['/api/v2/shifts/a/line-operations', 'PATCH'],
    ['/api/v2/shifts/a/line-operations', 'DELETE'],
  ]) {
    assert.equal(matchV2Route(path, method), null, `${method} ${path}`);
  }
  for (const path of [
    '/api/v2', '/api/v2/', '/api/v2/shifts/', '/api/v2/shifts/a/b', '/api/v2/shifts/a/snapshot/',
    '/api/v2/archives', '/api/v1/shifts', '/api/v2/shifts/a/snapshotx',
    '/api/v2/shifts/a/object/x', '/api/v2/shifts/a/members/', '/api/v2/shifts/a/members/u/x',
    '/api/v2/shifts/a/trucks/', '/api/v2/shifts/a/trucks/t/x',
    '/api/v2/shifts/a/detached-trips/c', '/api/v2/shifts/a/detached-trips/c/complete/x',
    '/api/v2/shifts/a/line-operations/', '/api/v2/shifts/a/line-operations/x',
  ]) {
    assert.equal(matchV2Route(path), null, path);
  }
  // An id that is not a plain token is not a route (never a crash, never SQL).
  assert.equal(matchV2Route('/api/v2/shifts/a%20b/snapshot'), null);
  assert.equal(matchV2Route(`/api/v2/shifts/${'x'.repeat(161)}/snapshot`), null);
  assert.equal(matchV2Route('/api/v2/shifts/a%20b/object', 'PATCH'), null);
  assert.equal(matchV2Route('/api/v2/shifts/a/members/a%20b', 'DELETE'), null);
  assert.equal(matchV2Route('/api/v2/shifts/a/trucks/a%20b', 'DELETE'), null);
  assert.equal(matchV2Route('/api/v2/shifts/a/detached-trips/a%20b/complete', 'POST'), null);
  assert.equal(matchV2Route('/api/v2/shifts/a%20b/line-operations', 'POST'), null);
});

test('unknown v2 path answers 404 with the stable v2 body', async () => {
  const { res, sent, calls, options } = harness({ path: '/api/v2/archives' });
  assert.equal(await handleV2Request(options), true);
  assert.deepEqual(sent, [{ status: 404, body: { protocolVersion: 2, error: 'not-found', details: {} } }]);
  assert.equal(res.status, 404);
  assert.equal(calls.loadActor, 0);
});

test('a known v2 path with a wrong method answers 405', async () => {
  for (const [method, path] of [
    ['PUT', '/api/v2/shifts'], ['PATCH', '/api/v2/shifts'], ['DELETE', '/api/v2/shifts'],
    ['POST', '/api/v2/shifts/shift_a1/snapshot'], ['GET', '/api/v2/shifts/shift_a1/object'],
    ['GET', '/api/v2/shifts/shift_a1/members'], ['POST', '/api/v2/shifts/shift_a1/members/uid_member'],
    ['GET', '/api/v2/shifts/shift_a1/trucks'], ['POST', '/api/v2/shifts/shift_a1/trucks/truck_1'],
    ['GET', '/api/v2/shifts/shift_a1/trucks/truck_1/force-transfer'],
    ['GET', '/api/v2/shifts/shift_a1/detached-trips/cycle_1/complete'],
    ['GET', '/api/v2/shifts/shift_a1/line-operations'],
    ['PUT', '/api/v2/shifts/shift_a1/line-operations'],
  ]) {
    const { sent, calls, options } = harness({ method, path });
    assert.equal(await handleV2Request(options), true);
    assert.deepEqual(sent, [{ status: 405, body: { protocolVersion: 2, error: 'method-not-allowed', details: {} } }]);
    assert.equal(calls.loadActor, 0);
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

test('POST /api/v2/shifts creates with 201 and a replay answers 200', async () => {
  const body = {operationId: 'op_create_1', protocolVersion: 2, objectId: 'object_a', workDate: '2026-11-23', shiftType: 'day'};
  const created = harness({method: 'POST', body});
  await handleV2Request(created.options);
  assert.equal(created.res.status, 201);
  assert.equal(created.res.body.replayed, false);
  assert.equal(created.res.body.operationId, 'op_create_1');
  assert.equal(created.calls.create.length, 1);
  assert.equal(created.calls.create[0].actor.uid, 'uid_reader');
  assert.deepEqual(created.calls.create[0].command, {...body, workspaceId: WORKSPACE});

  // A persisted replay keeps the same body and only the status changes.
  const replay = harness({
    method: 'POST',
    body,
    services: {createShift: async (pool, actor, command) => ({protocolVersion: 2, operationId: command.operationId, replayed: true, result: {shift: {}}})},
  });
  await handleV2Request(replay.options);
  assert.equal(replay.res.status, 200);
  assert.equal(replay.res.body.replayed, true);
});

test('command routes take the shift and the uid from the path, never from the body', async () => {
  const object = harness({
    method: 'PATCH',
    path: '/api/v2/shifts/shift_path/object',
    body: {operationId: 'op_object_1', protocolVersion: 2, objectId: 'object_b', expectedShiftRevision: 3, shiftId: 'shift_body'},
  });
  await handleV2Request(object.options);
  assert.equal(object.res.status, 200);
  assert.equal(object.calls.object[0].command.shiftId, 'shift_path');
  assert.equal(object.calls.object[0].command.objectId, 'object_b');
  assert.equal(object.calls.object[0].command.expectedShiftRevision, 3);

  const add = harness({
    method: 'POST',
    path: '/api/v2/shifts/shift_path/members',
    body: {operationId: 'op_member_add', protocolVersion: 2, uid: 'uid_new', expectedShiftRevision: 4, expectedMembershipRevision: null},
  });
  await handleV2Request(add.options);
  assert.equal(add.res.status, 200);
  assert.equal(add.calls.memberAdd[0].command.shiftId, 'shift_path');
  assert.equal(add.calls.memberAdd[0].command.uid, 'uid_new');
  assert.equal(add.calls.memberAdd[0].command.expectedMembershipRevision, null);

  const remove = harness({
    method: 'DELETE',
    path: '/api/v2/shifts/shift_path/members/uid_path',
    body: {operationId: 'op_member_remove', protocolVersion: 2, uid: 'uid_body', expectedShiftRevision: 5, expectedMembershipRevision: 2},
  });
  await handleV2Request(remove.options);
  assert.equal(remove.res.status, 200);
  assert.equal(remove.calls.memberRemove[0].command.uid, 'uid_path');
  assert.equal(remove.calls.memberRemove[0].command.shiftId, 'shift_path');
});

test('truck routes take their ids from the path and refuse an offline envelope', async () => {
  const add = harness({
    method: 'POST',
    path: '/api/v2/shifts/shift_path/trucks',
    body: {operationId: 'op_truck_add', protocolVersion: 2, truckId: 'truck_body', expectedShiftRevision: 3},
  });
  await handleV2Request(add.options);
  assert.equal(add.res.status, 200);
  assert.equal(add.calls.truckAdd[0].command.shiftId, 'shift_path');
  assert.equal(add.calls.truckAdd[0].command.truckId, 'truck_body');

  const remove = harness({
    method: 'DELETE',
    path: '/api/v2/shifts/shift_path/trucks/truck_path',
    body: {
      operationId: 'op_truck_remove', protocolVersion: 2, truckId: 'truck_body',
      expectedShiftRevision: 4, expectedStatusRevision: 2,
      expectedCycleRevision: 2, expectedTtnRevision: 2,
    },
  });
  await handleV2Request(remove.options);
  assert.equal(remove.res.status, 200);
  assert.equal(remove.calls.truckRemove[0].command.shiftId, 'shift_path');
  assert.equal(remove.calls.truckRemove[0].command.truckId, 'truck_path');

  const transfer = harness({
    method: 'POST',
    path: '/api/v2/shifts/shift_dest/trucks/truck_path/force-transfer',
    body: {
      operationId: 'op_transfer', protocolVersion: 2, sourceShiftId: 'shift_source',
      truckId: 'truck_body', confirmTransfer: true,
      expectedSourceShiftRevision: 2, expectedDestinationShiftRevision: 3,
      expectedStatusRevision: 1, expectedCycleRevision: 2, expectedTtnRevision: 1,
    },
  });
  await handleV2Request(transfer.options);
  assert.equal(transfer.res.status, 200);
  assert.equal(transfer.calls.transfer[0].command.shiftId, 'shift_dest');
  assert.equal(transfer.calls.transfer[0].command.truckId, 'truck_path');
  assert.equal(transfer.calls.transfer[0].command.sourceShiftId, 'shift_source');
  assert.equal(transfer.calls.transfer[0].command.confirmTransfer, true);

  const complete = harness({
    method: 'POST',
    path: '/api/v2/shifts/shift_source/detached-trips/cycle_path/complete',
    body: {
      operationId: 'op_complete', protocolVersion: 2, cycleId: 'cycle_body',
      truckId: 'truck_1', destinationShiftId: 'shift_dest', type: 'load', createdAt: 1764000000000,
      expectedSourceShiftRevision: 3, expectedDestinationShiftRevision: 4,
      expectedDetachedCycleRevision: 1,
    },
  });
  await handleV2Request(complete.options);
  assert.equal(complete.res.status, 200);
  assert.equal(complete.calls.complete[0].command.shiftId, 'shift_source');
  assert.equal(complete.calls.complete[0].command.cycleId, 'cycle_path');
  assert.equal(complete.calls.complete[0].command.destinationShiftId, 'shift_dest');

  // Both online-only commands refuse a queued envelope before any mutation,
  // and the service never sees the command.
  for (const [path, calls] of [
    ['/api/v2/shifts/shift_dest/trucks/truck_path/force-transfer', 'transfer'],
    ['/api/v2/shifts/shift_source/detached-trips/cycle_path/complete', 'complete'],
  ]) {
    const offline = harness({
      method: 'POST',
      path,
      headers: {'x-samosval-offline': '1'},
      body: {operationId: 'op_offline', protocolVersion: 2},
    });
    await handleV2Request(offline.options);
    assert.deepEqual(offline.sent, [{
      status: 409,
      body: {protocolVersion: 2, error: 'online-required', details: {}},
    }], path);
    assert.deepEqual(offline.calls[calls], [], path);
  }
});

test('the line-operations route takes the shift from the path and forwards the raw body shift', async () => {
  const line = harness({
    method: 'POST',
    path: '/api/v2/shifts/shift_path/line-operations',
    body: {
      operationId: 'op_line_arrive', protocolVersion: 2, type: 'arrive', truckId: 'truck_1',
      shiftId: 'shift_path', createdAt: 1764000000000, wantArrived: true, cycleMinutes: 30,
      expectedShiftRevision: 3, expectedStatusRevision: 1,
      expectedCycleRevision: 1, expectedTtnRevision: 1,
    },
  });
  await handleV2Request(line.options);
  assert.equal(line.res.status, 200);
  assert.equal(line.calls.line.length, 1);
  assert.equal(line.calls.line[0].command.shiftId, 'shift_path');
  assert.equal(line.calls.line[0].command.bodyShiftId, 'shift_path');
  assert.equal(line.calls.line[0].command.truckId, 'truck_1');
  assert.equal(line.calls.line[0].command.type, 'arrive');

  // A body shift that disagrees is not silently replaced by the path: the raw
  // value reaches the command, which owns the refusal.
  const mismatch = harness({
    method: 'POST',
    path: '/api/v2/shifts/shift_path/line-operations',
    body: {
      operationId: 'op_line_mismatch', protocolVersion: 2, type: 'load', truckId: 'truck_1',
      shiftId: 'shift_body', createdAt: 1764000000000, cycleMinutes: 30,
      expectedShiftRevision: 3, expectedStatusRevision: 1,
      expectedCycleRevision: 1, expectedTtnRevision: 1,
    },
  });
  await handleV2Request(mismatch.options);
  assert.equal(mismatch.calls.line[0].command.shiftId, 'shift_path');
  assert.equal(mismatch.calls.line[0].command.bodyShiftId, 'shift_body');

  // A body without a shift leaves the raw value undefined, never a guess.
  const absent = harness({
    method: 'POST',
    path: '/api/v2/shifts/shift_path/line-operations',
    body: {operationId: 'op_line_no_shift', protocolVersion: 2, type: 'ttn', truckId: 'truck_1', createdAt: 1764000000000},
  });
  await handleV2Request(absent.options);
  assert.equal(absent.calls.line[0].command.shiftId, 'shift_path');
  assert.equal(absent.calls.line[0].command.bodyShiftId, undefined);
});

test('the workspace comes from the server configuration, not from the command body', async () => {
  const { calls, options } = harness({
    method: 'POST',
    body: {operationId: 'op_create_evil', protocolVersion: 2, objectId: 'object_a', shiftType: 'day', workspaceId: 'evil_workspace'},
  });
  await handleV2Request(options);
  assert.equal(calls.create[0].command.workspaceId, WORKSPACE);
});

test('a malformed or unreadable command body is a 400 invalid-command', async () => {
  for (const body of [[], 'text', 42, null]) {
    const { sent, calls, options } = harness({method: 'POST', body});
    await handleV2Request(options);
    assert.deepEqual(sent, [{
      status: 400,
      body: {protocolVersion: 2, error: 'invalid-command', details: {field: 'body'}},
    }], String(body));
    assert.deepEqual(calls.create, []);
  }
  // No reader at all: the router refuses instead of guessing an empty body.
  const missing = harness({method: 'POST'});
  await handleV2Request(missing.options);
  assert.equal(missing.res.status, 400);
  assert.equal(missing.res.body.error, 'invalid-command');
  // A reader that throws (invalid JSON / too large) is the same schema refusal.
  const broken = harness({
    method: 'POST',
    services: {},
  });
  broken.options.readBody = async () => { throw new Error('invalid-json'); };
  await handleV2Request(broken.options);
  assert.equal(broken.res.status, 400);
  assert.equal(broken.res.body.error, 'invalid-command');
});

test('a command V2Error keeps its stable status and body', async () => {
  const { sent, options } = harness({
    method: 'POST',
    body: {operationId: 'op_dup', protocolVersion: 2, objectId: 'object_a', shiftType: 'day'},
    services: {
      createShift: async () => { throw v2Error('shift-duplicate', 409, {objectId: 'object_a', workDate: '2026-11-23', shiftType: 'day'}); },
    },
  });
  await handleV2Request(options);
  assert.deepEqual(sent, [{
    status: 409,
    body: {protocolVersion: 2, error: 'shift-duplicate', details: {objectId: 'object_a', workDate: '2026-11-23', shiftType: 'day'}},
  }]);
  // A v1 client on a command route is refused before authentication.
  const oldClient = harness({
    method: 'POST',
    body: {operationId: 'op_dup', protocolVersion: 2},
    headers: {'x-samosval-protocol': '1'},
  });
  await handleV2Request(oldClient.options);
  assert.equal(oldClient.res.status, 426);
  assert.deepEqual(oldClient.calls.create, []);
});
