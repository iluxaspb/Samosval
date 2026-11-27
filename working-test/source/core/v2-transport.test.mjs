// Транспорт v2 параллельных смен (41-v2-transport.js).
//
// Проверяем тот самый файл, который уходит в сборку: classic script грузится в
// vm вместе с store контекстов задачи 13, поэтому тест доказывает и глобальный
// контракт (`globalThis.WorkingTestV2Transport`), и работу через store.
//
// Запуск: node --test working-test/source/core/v2-transport.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createNasClient } from '../../synology/session-client.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
// structuredClone и URLSearchParams передаём из хоста: иначе объекты из vm
// принадлежат другому realm и глубокое сравнение в тесте ведёт себя иначе.
const sandbox = { structuredClone, URLSearchParams, console };
const context = vm.createContext(sandbox);
for (const name of ['40-shift-contexts.js', '41-v2-transport.js']) {
  const file = here + name;
  vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
}
const contextsApi = sandbox.WorkingTestShiftContexts || {};
const transportApi = sandbox.WorkingTestV2Transport || {};

const WORKSPACE = 'workspace_main';
const UID = 'uid_alpha';

const shiftA = { shiftId: 'shift_a', state: 'active', objectId: 'object_1', objectName: 'Невский проспект', workDate: '2026-11-23', shiftType: 'day', shiftRevision: 3 };
const shiftB = { shiftId: 'shift_b', state: 'active', objectId: 'object_2', objectName: 'Пулково', workDate: '2026-11-23', shiftType: 'night', shiftRevision: 5 };

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); }
  };
}

function makeStore() {
  return contextsApi.createShiftContextStore({ storage: memoryStorage(), uid: UID, workspaceId: WORKSPACE });
}

function snapshot(shiftId, overrides = {}) {
  const revision = overrides.shiftRevision ?? 4;
  const base = shiftId === 'shift_b' ? shiftB : shiftA;
  return {
    protocolVersion: 2,
    workspaceId: WORKSPACE,
    shiftId,
    shiftRevision: revision,
    shift: { ...base, shiftId, id: shiftId, shiftRevision: revision },
    members: [{ uid: UID, shiftId }],
    statuses: [{ id: 'truck_1', shiftId, cycleRevision: 2, ttnRevision: 1 }],
    logs: [{ id: 'log_1', shiftId, truckId: 'truck_1' }],
    detachedOpenTrips: [],
    revisions: { shift: revision, status: 2, ttn: 1 },
    serverGeneration: 'server-' + revision,
    pendingServerReceipts: 0,
    ...overrides
  };
}

function receipt(operationId, result = {}) {
  return { protocolVersion: 2, operationId, replayed: false, result };
}

// Ошибка в том виде, в каком её бросает session-client.
function nasError(code, extra = {}) {
  const error = new Error(code);
  error.name = 'NasClientError';
  Object.assign(error, { code, status: 0, retryable: false, uncertain: false }, extra);
  return error;
}

// Фейковый общий запрос. handler(call, index) возвращает тело ответа или
// бросает ошибку; транспорт обязан сам разобрать ответ.
function harness(handler, options = {}) {
  const calls = [];
  const request = async (path, opts = {}) => {
    const call = {
      path,
      method: opts.method || (opts.operation === undefined ? 'GET' : 'POST'),
      body: opts.operation === undefined ? undefined : structuredClone(opts.operation)
    };
    calls.push(call);
    return handler(call, calls.length);
  };
  const store = options.store === undefined ? makeStore() : options.store;
  const transport = transportApi.createV2Transport({ request, uid: UID, workspaceId: WORKSPACE, store });
  return { calls, store, transport };
}

function silentTimers() {
  return { setTimeout: () => 0, clearTimeout: () => {} };
}

// Ожидание асинхронного состояния без таймеров и без «магических» пауз.
async function until(check, label) {
  for (let index = 0; index < 100; index++) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('не дождались: ' + label);
}

test('классический скрипт публикует полный набор команд v2', () => {
  assert.equal(typeof transportApi.createV2Transport, 'function', 'глобальный контракт WorkingTestV2Transport');
  const { transport } = harness(() => ({}));
  for (const name of [
    'listShifts', 'readShiftSnapshot', 'createShift', 'changeShiftObject',
    'addMember', 'removeMember', 'addTruck', 'removeTruck',
    'forceTransferTruck', 'completeDetachedTrip', 'submitLineV2',
    'prepareClose', 'confirmMaterial', 'finishClose', 'readRestoredArchive', 'submitArchiveV2',
    'subscribeShifts', 'refreshCrossShift'
  ]) assert.equal(typeof transport[name], 'function', name);
});

test('непрозрачный курсор передаётся и возвращается байт-в-байт', async () => {
  const cursor = 'eyJ2IjoxfQ==+/~x y';
  const nextCursor = 'eyJ2IjoyfQ==+/~z';
  const { transport, calls, store } = harness(() => ({ items: [shiftA], nextCursor }));
  const list = await transport.listShifts({ cursor });
  assert.equal(list.ok, true);
  assert.equal(list.nextCursor, nextCursor, 'nextCursor не пересобирается');
  const query = new URLSearchParams(calls[0].path.split('?')[1]);
  assert.equal(query.get('cursor'), cursor, 'курсор доезжает до сервера без потерь');
  assert.equal(query.get('state'), 'active,closing');
  assert.equal(query.get('limit'), '50');
  assert.equal(store.visibleShifts().map(row => row.shiftId).join(','), 'shift_a');
});

test('список с чужим workspace не публикуется в контексты', async () => {
  const { transport, store } = harness(() => ({ items: [{ ...shiftA, workspaceId: 'other_workspace' }], nextCursor: null }));
  store.replaceVisibleShifts([shiftB]);
  const list = await transport.listShifts({});
  assert.equal(list.ok, false);
  assert.equal(list.error.code, 'invalid-api-response');
  assert.equal(list.error.details.reason, 'workspace-mismatch');
  assert.equal(store.visibleShifts().map(row => row.shiftId).join(','), 'shift_b', 'прежний список сохранён');
});

test('поздний список отменённого поколения не публикуется', async () => {
  const pending = [];
  const { transport, store } = harness(call => new Promise(resolve => pending.push(resolve)));
  store.replaceVisibleShifts([shiftA]);
  const first = transport.listShifts({});
  const second = transport.listShifts({});
  await until(() => pending.length === 2, 'два списка');
  pending[1]({ items: [shiftB], nextCursor: null });
  const secondResult = await second;
  pending[0]({ items: [shiftA], nextCursor: null });
  const firstResult = await first;
  assert.equal(secondResult.ok, true);
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.error.code, 'stale-list-generation');
  assert.equal(store.visibleShifts().map(row => row.shiftId).join(','), 'shift_b', 'остался новый список');
});

test('снимок с другим protocolVersion не публикуется', async () => {
  const { transport, store } = harness(() => snapshot('shift_a', { protocolVersion: 1 }));
  store.replaceVisibleShifts([shiftA]);
  const result = await transport.readShiftSnapshot({ shiftId: 'shift_a' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-api-response');
  assert.equal(result.error.details.reason, 'protocol-version-mismatch');
  assert.equal(store.context('shift_a').loaded, false);
});

test('снимок другой смены не публикуется', async () => {
  const { transport, store } = harness(() => snapshot('shift_b'));
  store.replaceVisibleShifts([shiftA]);
  const result = await transport.readShiftSnapshot({ shiftId: 'shift_a' });
  assert.equal(result.ok, false);
  assert.equal(result.error.details.reason, 'shift-mismatch');
  assert.equal(store.context('shift_a').loaded, false);
});

test('снимок с чужим workspace не публикуется', async () => {
  const { transport, store } = harness(() => snapshot('shift_a', { workspaceId: 'other_workspace' }));
  store.replaceVisibleShifts([shiftA]);
  const result = await transport.readShiftSnapshot({ shiftId: 'shift_a' });
  assert.equal(result.ok, false);
  assert.equal(result.error.details.reason, 'workspace-mismatch');
  assert.equal(store.context('shift_a').loaded, false);
});

test('снимок со строкой статуса чужой смены не публикуется', async () => {
  const { transport, store } = harness(() => snapshot('shift_a', { statuses: [{ id: 'truck_1', shiftId: 'shift_b' }] }));
  store.replaceVisibleShifts([shiftA]);
  const result = await transport.readShiftSnapshot({ shiftId: 'shift_a' });
  assert.equal(result.ok, false);
  assert.equal(result.error.details.reason, 'entity-shift-mismatch');
  assert.equal(store.context('shift_a').loaded, false);
});

test('снимок без workspaceId или с неверной ревизией строки не публикуется', async () => {
  const noWorkspace = harness(() => {
    const data = snapshot('shift_a');
    delete data.workspaceId;
    return data;
  });
  noWorkspace.store.replaceVisibleShifts([shiftA]);
  let result = await noWorkspace.transport.readShiftSnapshot({ shiftId: 'shift_a' });
  assert.equal(result.ok, false);
  assert.equal(result.error.details.reason, 'workspace-mismatch');
  assert.equal(noWorkspace.store.context('shift_a').loaded, false);

  const badRevision = harness(() => snapshot('shift_a', { statuses: [{ id: 'truck_1', shiftId: 'shift_a', cycleRevision: -1 }] }));
  badRevision.store.replaceVisibleShifts([shiftA]);
  result = await badRevision.transport.readShiftSnapshot({ shiftId: 'shift_a' });
  assert.equal(result.ok, false);
  assert.equal(result.error.details.reason, 'invalid-entity-revision');
  assert.equal(badRevision.store.context('shift_a').loaded, false);
});

test('поздний ответ отменённого поколения запроса не публикуется', async () => {
  const pending = [];
  const { transport, store } = harness(call => new Promise(resolve => pending.push({ call, resolve })));
  store.replaceVisibleShifts([shiftA]);
  const first = transport.readShiftSnapshot({ shiftId: 'shift_a' });
  const second = transport.readShiftSnapshot({ shiftId: 'shift_a' });
  await Promise.resolve();
  assert.equal(pending.length, 2, 'оба запроса ушли');
  pending[1].resolve(snapshot('shift_a', { shiftRevision: 9 }));
  const secondResult = await second;
  pending[0].resolve(snapshot('shift_a', { shiftRevision: 5 }));
  const firstResult = await first;
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.applied, true);
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.applied, false);
  assert.equal(firstResult.error.code, 'snapshot-not-applied');
  assert.equal(store.context('shift_a').revisions.shift, 9, 'остался только новый снимок');
});

test('таймаут повторяется ровно один раз с тем же operationId', async () => {
  const { transport, calls } = harness((call, index) => {
    if (index === 1) throw nasError('api-timeout', { retryable: true, uncertain: true, phase: 'response-headers' });
    return receipt(call.body.operationId, { shift: { id: 'shift_new' } });
  });
  const result = await transport.createShift({ operationId: 'op-1', objectId: 'object_1', workDate: '2026-11-23', shiftType: 'day', cycleMinutes: 30 });
  assert.equal(result.ok, true);
  assert.equal(result.retried, true);
  assert.equal(calls.length, 2, 'ровно один повтор');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/v2/shifts');
  assert.equal(calls[0].body.operationId, 'op-1');
  assert.equal(calls[0].body.protocolVersion, 2);
  assert.deepEqual(calls[0].body, calls[1].body, 'повтор идёт с тем же телом и тем же operationId');
});

test('доменный конфликт не повторяется и сохраняет стабильный код', async () => {
  const { transport, calls } = harness(() => {
    throw nasError('api-http-409', { status: 409, retryable: false, serverCode: 'shift-changed', serverDetails: { expectedRevision: 3, currentRevision: 5 } });
  });
  const result = await transport.changeShiftObject({ shiftId: 'shift_a', operationId: 'op-2', objectId: 'object_2', expectedShiftRevision: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'shift-changed', 'код сервера не потерян');
  assert.equal(result.error.status, 409);
  assert.equal(result.error.details.expectedRevision, 3);
  assert.equal(result.error.details.currentRevision, 5);
  assert.equal(calls.length, 1, 'конфликт не повторяется');
});

test('детали ошибки сокращаются до безопасного белого списка', async () => {
  const { transport } = harness(() => {
    throw nasError('api-http-409', {
      status: 409,
      serverCode: 'truck-assigned-to-other-shift',
      serverDetails: {
        sourceShiftId: 'shift_b',
        objectName: 'Пулково',
        workDate: '2026-11-23',
        shiftType: 'night',
        driverPhone: '+79990000000',
        actorEmail: 'driver@example.com',
        nested: { uid: 'other' }
      }
    });
  });
  const result = await transport.addTruck({ shiftId: 'shift_a', operationId: 'op-3', truckId: 'truck_1', expectedShiftRevision: 2 });
  assert.equal(result.error.code, 'truck-assigned-to-other-shift');
  assert.deepEqual(Object.keys(result.error.details).sort(), ['objectName', 'shiftType', 'sourceShiftId', 'workDate']);
  assert.equal(result.error.details.driverPhone, undefined, 'телефон не попадает в результат');
  assert.equal(result.error.details.actorEmail, undefined);
});

test('конфликт ревизий доносит и ожидаемое, и фактическое число', async () => {
  const { transport } = harness(() => {
    throw nasError('api-http-409', {
      status: 409,
      retryable: false,
      serverCode: 'revision-conflict',
      serverDetails: {
        expectedShiftRevision: 5, actualShiftRevision: 6,
        expectedStatusRevision: 2, actualStatusRevision: 3,
        expectedCycleRevision: 2, actualCycleRevision: 3,
        expectedTtnRevision: 1, actualTtnRevision: 2,
        uid: 'uid_secret', email: 'secret@example.com'
      }
    });
  });
  const result = await transport.addTruck({ shiftId: 'shift_a', operationId: 'op-3', truckId: 'truck_1', expectedShiftRevision: 5 });
  assert.equal(result.error.code, 'revision-conflict');
  // Пара expected/actual — единственное, чем можно честно объяснить конфликт.
  // Клиентский белый список обязан совпадать с серверным DETAIL_KEYS.
  const details = JSON.parse(JSON.stringify(result.error.details));
  assert.deepEqual(details, {
    expectedShiftRevision: 5, actualShiftRevision: 6,
    expectedStatusRevision: 2, actualStatusRevision: 3,
    expectedCycleRevision: 2, actualCycleRevision: 3,
    expectedTtnRevision: 1, actualTtnRevision: 2
  });
  assert.equal(result.error.details.uid, undefined, 'uid не проходит');
  assert.equal(result.error.details.email, undefined, 'e-mail не проходит');
});

test('квитанция с чужим operationId или protocolVersion отклоняется', async () => {
  const wrongId = harness(() => receipt('op-other', {}));
  let result = await wrongId.transport.createShift({ operationId: 'op-4', objectId: 'object_1', workDate: '2026-11-23', shiftType: 'day' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-api-response');
  assert.equal(result.error.details.reason, 'operation-id-mismatch');

  const wrongVersion = harness(() => ({ ...receipt('op-4', {}), protocolVersion: 1 }));
  result = await wrongVersion.transport.createShift({ operationId: 'op-4', objectId: 'object_1', workDate: '2026-11-23', shiftType: 'day' });
  assert.equal(result.ok, false);
  assert.equal(result.error.details.reason, 'protocol-version-mismatch');
});

test('перевод самосвала без явного подтверждения не уходит на сервер', async () => {
  const { transport, calls } = harness(() => receipt('op-5', {}));
  const result = await transport.forceTransferTruck({
    destinationShiftId: 'shift_b', truckId: 'truck_1', operationId: 'op-5', sourceShiftId: 'shift_a',
    expectedSourceShiftRevision: 1, expectedDestinationShiftRevision: 1,
    expectedStatusRevision: 1, expectedCycleRevision: 1, expectedTtnRevision: 1,
    confirmTransfer: false
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'transfer-confirmation-required');
  assert.equal(calls.length, 0);
});

test('перевод самосвала публикует обе смены только вместе', async () => {
  const { transport, store, calls } = harness(call => {
    if (call.method === 'POST') return receipt('op-6', {});
    if (call.path.includes('/shift_a/')) return snapshot('shift_a', { shiftRevision: 6 });
    return snapshot('shift_b', { shiftRevision: 7 });
  });
  store.replaceVisibleShifts([shiftA, shiftB]);
  const result = await transport.forceTransferTruck({
    destinationShiftId: 'shift_b', truckId: 'truck_1', operationId: 'op-6', sourceShiftId: 'shift_a',
    expectedSourceShiftRevision: 3, expectedDestinationShiftRevision: 5,
    expectedStatusRevision: 2, expectedCycleRevision: 2, expectedTtnRevision: 1,
    confirmTransfer: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.crossShift.applied, true);
  assert.equal(store.context('shift_a').revisions.shift, 6);
  assert.equal(store.context('shift_b').revisions.shift, 7);
  const post = calls.find(call => call.method === 'POST');
  assert.equal(post.path, '/api/v2/shifts/shift_b/trucks/truck_1/force-transfer');
  // Смена назначения едет и в пути, и в теле: сервер сверяет их и без поля в
  // теле отвечает invalid-command/destinationShiftId (контракт §5.4).
  assert.deepEqual(post.body, {
    operationId: 'op-6',
    protocolVersion: 2,
    sourceShiftId: 'shift_a',
    destinationShiftId: 'shift_b',
    expectedSourceShiftRevision: 3,
    expectedDestinationShiftRevision: 5,
    expectedStatusRevision: 2,
    expectedCycleRevision: 2,
    expectedTtnRevision: 1,
    confirmTransfer: true
  });
  assert.equal(post.body.destinationShiftId, 'shift_b', 'тело называет ту же смену, что и путь');
});

test('завершение отсоединённого рейса называет исходную смену и в теле', async () => {
  const { transport, calls } = harness(call => {
    if (call.method === 'POST') return receipt('op-8', {});
    if (call.path.includes('/shift_a/')) return snapshot('shift_a', { shiftRevision: 6 });
    return snapshot('shift_b', { shiftRevision: 7 });
  });
  const result = await transport.completeDetachedTrip({
    operationId: 'op-8', sourceShiftId: 'shift_a', destinationShiftId: 'shift_b',
    cycleId: 'cycle_1', truckId: 'truck_1', type: 'load',
    expectedSourceShiftRevision: 3, expectedDestinationShiftRevision: 5,
    expectedDetachedCycleRevision: 4, fields: { createdAt: 1764000000000 }
  });
  assert.equal(result.ok, true);
  const post = calls.find(call => call.method === 'POST');
  assert.equal(post.path, '/api/v2/shifts/shift_a/detached-trips/cycle_1/complete');
  // Сервер читает sourceShiftId из тела и сверяет со сменой пути (§5.4):
  // без поля команда отвечала invalid-command/sourceShiftId.
  assert.equal(post.body.sourceShiftId, 'shift_a', 'исходная смена есть в теле');
  assert.equal(post.body.destinationShiftId, 'shift_b');
  assert.equal(post.body.createdAt, 1764000000000, 'момент подтверждения доходит до сервера');
});

test('несовпавший снимок второй смены не публикует ни одну', async () => {
  const { transport, store } = harness(call => {
    if (call.method === 'POST') return receipt('op-7', {});
    // На снимок shift_b сервер отвечает чужой сменой.
    return snapshot('shift_a', { shiftRevision: 6 });
  });
  store.replaceVisibleShifts([shiftA, shiftB]);
  const result = await transport.forceTransferTruck({
    destinationShiftId: 'shift_b', truckId: 'truck_1', operationId: 'op-7', sourceShiftId: 'shift_a',
    expectedSourceShiftRevision: 3, expectedDestinationShiftRevision: 5,
    expectedStatusRevision: 2, expectedCycleRevision: 2, expectedTtnRevision: 1,
    confirmTransfer: true
  });
  assert.equal(result.ok, true, 'сама команда принята сервером');
  assert.equal(result.crossShift.applied, false);
  assert.equal(result.crossShift.reason, 'snapshot-shift-mismatch');
  assert.equal(store.context('shift_a').loaded, false);
  assert.equal(store.context('shift_b').loaded, false);
  assert.equal(store.context('shift_b').badge.conflict, true, 'обе смены помечены на перечитывание');
});

test('подписка читает выбранную и фоновые смены с generation-токенами', async () => {
  const requested = [];
  const { transport, store } = harness(call => {
    if (call.path.startsWith('/api/v2/shifts?')) {
      requested.push('list');
      return { items: [shiftA, { ...shiftB, pendingServerReceipts: 2 }], nextCursor: null };
    }
    const shiftId = call.path.split('/')[4];
    requested.push(shiftId);
    return snapshot(shiftId);
  });
  store.replaceVisibleShifts([shiftA, shiftB]);
  store.selectShift('shift_a');
  const seen = [];
  const handle = transport.subscribeShifts({
    intervalMs: 4000,
    timers: silentTimers(),
    onList: list => seen.push({ kind: 'list', generation: list.listGeneration, items: list.items.map(row => row.shiftId) }),
    onSnapshot: result => seen.push({ kind: 'snapshot', shiftId: result.shiftId, generation: result.generation }),
    onError: error => seen.push({ kind: 'error', code: error.code })
  });
  await handle.tick();
  handle.close();
  assert.equal(requested.join(','), 'list,shift_a,shift_b', 'выбранная смена и фоновая с незавершёнными операциями');
  assert.equal(seen.length, 3);
  assert.equal(seen[0].kind, 'list');
  assert.equal(seen[0].items.join(','), 'shift_a,shift_b');
  assert.ok(seen[0].generation > 0, 'у списка своё поколение');
  assert.equal(seen[1].kind, 'snapshot');
  assert.equal(seen[1].shiftId, 'shift_a');
  assert.equal(seen[1].generation.shiftId, 'shift_a');
  assert.equal(seen[1].generation.workspaceId, WORKSPACE);
  assert.equal(seen[1].generation.uid, UID);
  assert.equal(typeof seen[1].generation.generation, 'number');
  assert.equal(seen[2].shiftId, 'shift_b');
});

test('подписка не публикует ответ, не совпавший с поколением', async () => {
  const pending = [];
  const { transport, store } = harness(call => {
    if (call.path.startsWith('/api/v2/shifts?')) return { items: [shiftA], nextCursor: null };
    return new Promise(resolve => pending.push(resolve));
  });
  store.replaceVisibleShifts([shiftA]);
  const seen = [];
  const handle = transport.subscribeShifts({
    timers: silentTimers(),
    onList: () => {},
    onSnapshot: result => seen.push(result),
    onError: () => {}
  });
  const tick = handle.tick();
  await until(() => pending.length === 1, 'снимок подписки');
  // Пока тик ждёт снимок, экран запросил смену заново — поколение выросло.
  const newer = transport.readShiftSnapshot({ shiftId: 'shift_a' });
  await until(() => pending.length === 2, 'снимок экрана');
  pending[1](snapshot('shift_a', { shiftRevision: 8 }));
  const newerResult = await newer;
  pending[0](snapshot('shift_a', { shiftRevision: 4 }));
  await tick;
  handle.close();
  assert.equal(newerResult.applied, true);
  assert.equal(seen.length, 0, 'устаревший ответ подписки не опубликован');
  assert.equal(store.context('shift_a').revisions.shift, 8);
});

test('подписка прекращает опрос после close', async () => {
  let calls = 0;
  const { transport, store } = harness(() => {
    calls++;
    return { items: [shiftA], nextCursor: null };
  });
  store.replaceVisibleShifts([shiftA]);
  const handle = transport.subscribeShifts({
    timers: silentTimers(),
    onList: () => {}, onSnapshot: () => {}, onError: () => {}
  });
  await handle.tick();
  const afterFirst = calls;
  handle.close();
  await handle.tick();
  assert.equal(calls, afterFirst, 'после close новых запросов нет');
});

test('закрытие смены отправляет точные поля CAS', async () => {
  const { transport, calls } = harness(call => receipt(call.body.operationId, { phase: call.path.endsWith('/prepare') ? 'prepared' : 'closed' }));
  await transport.prepareClose({ shiftId: 'shift_a', operationId: 'op-8', expectedShiftRevision: 4 });
  assert.equal(calls[0].path, '/api/v2/shifts/shift_a/close/prepare');
  assert.deepEqual(calls[0].body, { operationId: 'op-8', protocolVersion: 2, expectedShiftRevision: 4 });
  await transport.finishClose({ shiftId: 'shift_a', operationId: 'op-9', closeToken: 'token-1', expectedShiftRevision: 5, expectedArchiveRevision: 1, expectedMaterialMarkerRevision: 2 });
  assert.equal(calls[1].path, '/api/v2/shifts/shift_a/close/finish');
  assert.deepEqual(calls[1].body, {
    operationId: 'op-9',
    protocolVersion: 2,
    closeToken: 'token-1',
    expectedShiftRevision: 5,
    expectedArchiveRevision: 1,
    expectedMaterialMarkerRevision: 2
  });
});

test('подтверждение материала идёт на /close/material и сохраняет null-ревизию marker', async () => {
  const { transport, calls } = harness(call => receipt(call.body.operationId, { phase: 'material', materialMarkerRevision: 1 }));
  const result = await transport.confirmMaterial({
    shiftId: 'shift_a',
    operationId: 'op-material',
    closeToken: 'token-1',
    materialId: 'material_1',
    volume: 42.5,
    expectedShiftRevision: 5,
    expectedArchiveRevision: 1,
    expectedMaterialMarkerRevision: null
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].path, '/api/v2/shifts/shift_a/close/material');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, {
    operationId: 'op-material',
    protocolVersion: 2,
    closeToken: 'token-1',
    materialId: 'material_1',
    volume: 42.5,
    expectedShiftRevision: 5,
    expectedArchiveRevision: 1,
    expectedMaterialMarkerRevision: null
  });
  // §5.5: смена адресуется только путём, в теле её нет — иначе хеш операции
  // расходился бы у клиентов, которые кладут поле в тело и которые нет.
  assert.ok(!('shiftId' in calls[0].body), 'shiftId не уходит в тело close/material');
  assert.match(calls[0].path, /\/shifts\/shift_a\/close\/material$/, 'смена осталась в пути');
  // null — это значение CAS «marker ещё не создан», а не отсутствие поля.
  assert.ok('expectedMaterialMarkerRevision' in calls[0].body, 'null-ревизия не выбрасывается из тела');
});

test('finishClose передаёт expectedMaterialMarkerRevision: null как значение CAS', async () => {
  const { transport, calls } = harness(call => receipt(call.body.operationId, { phase: 'closed' }));
  await transport.finishClose({
    shiftId: 'shift_a',
    operationId: 'op-finish-null',
    closeToken: 'token-1',
    expectedShiftRevision: 5,
    expectedArchiveRevision: 1,
    expectedMaterialMarkerRevision: null
  });
  assert.ok('expectedMaterialMarkerRevision' in calls[0].body, 'поле осталось в теле');
  assert.equal(calls[0].body.expectedMaterialMarkerRevision, null);
});

test('подтверждение материала без обязательных полей не уходит на сервер', async () => {
  const { transport, calls } = harness(() => ({}));
  const missingVolume = await transport.confirmMaterial({
    shiftId: 'shift_a', operationId: 'op-m1', closeToken: 'token-1', materialId: 'material_1'
  });
  assert.equal(missingVolume.ok, false);
  assert.equal(missingVolume.error.code, 'invalid-argument');
  assert.equal(missingVolume.error.details.field, 'volume');
  const missingToken = await transport.confirmMaterial({
    shiftId: 'shift_a', operationId: 'op-m2', materialId: 'material_1', volume: 1
  });
  assert.equal(missingToken.error.details.field, 'closeToken');
  assert.equal(calls.length, 0, 'неполная команда не отправляется');
});

test('восстановленный архив читается с ревизией, лимитом и курсором', async () => {
  const { transport, calls } = harness(() => ({
    protocolVersion: 2,
    archiveId: 'archive_1',
    archiveRevision: 3,
    archiveSha256: 'a'.repeat(64),
    restoredContextId: 'ctx_1',
    contextRevision: 2,
    shiftSnapshot: {},
    trips: [],
    ttn: [],
    provenance: {}
  }));
  const result = await transport.readRestoredArchive({ archiveId: 'archive_1', revision: 3, limit: 100, cursor: 'c1==' });
  assert.equal(result.ok, true);
  assert.equal(result.data.restoredContextId, 'ctx_1');
  assert.equal(calls[0].path.split('?')[0], '/api/v2/archives/archive_1/restored');
  const query = new URLSearchParams(calls[0].path.split('?')[1]);
  assert.equal(query.get('revision'), '3');
  assert.equal(query.get('limit'), '100');
  assert.equal(query.get('cursor'), 'c1==');
});

test('правка восстановленного архива идёт в operations с protocolVersion 2', async () => {
  const { transport, calls } = harness(call => receipt(call.body.operationId, { archiveId: 'archive_1' }));
  const result = await transport.submitArchiveV2({
    archiveId: 'archive_1', operationId: 'op-10', restoredContextId: 'ctx_1', type: 'trip.update',
    recordId: 'trip_1', expectedContextRevision: 2, expectedBaseArchiveRevision: 3,
    expectedBaseSha256: 'b'.repeat(64), fields: { volume: 12 }
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/v2/archives/archive_1/operations');
  assert.deepEqual(calls[0].body, {
    operationId: 'op-10',
    protocolVersion: 2,
    restoredContextId: 'ctx_1',
    type: 'trip.update',
    recordId: 'trip_1',
    expectedContextRevision: 2,
    expectedBaseArchiveRevision: 3,
    expectedBaseSha256: 'b'.repeat(64),
    volume: 12
  });
});

test('транспорт никогда не откатывается на маршруты v1', async () => {
  const paths = [];
  const { transport, store } = harness(call => {
    paths.push(call.path);
    if (call.path.startsWith('/api/v2/shifts?')) return { items: [shiftA], nextCursor: null };
    if (call.path.endsWith('/snapshot')) return snapshot('shift_a');
    if (call.path.includes('/restored')) return { protocolVersion: 2, archiveId: 'archive_1', trips: [] };
    return receipt(call.body.operationId, {});
  });
  store.replaceVisibleShifts([shiftA]);
  await transport.listShifts({});
  await transport.readShiftSnapshot({ shiftId: 'shift_a' });
  await transport.createShift({ operationId: 'op-11', objectId: 'object_1', workDate: '2026-11-23', shiftType: 'day' });
  await transport.addMember({ shiftId: 'shift_a', operationId: 'op-12', uid: 'uid_b', expectedShiftRevision: 4, expectedMembershipRevision: null });
  await transport.removeMember({ shiftId: 'shift_a', uid: 'uid_b', operationId: 'op-13', expectedShiftRevision: 4, expectedMembershipRevision: 1 });
  await transport.addTruck({ shiftId: 'shift_a', operationId: 'op-14', truckId: 'truck_1', expectedShiftRevision: 4 });
  await transport.removeTruck({ shiftId: 'shift_a', truckId: 'truck_1', operationId: 'op-15', expectedShiftRevision: 4, expectedStatusRevision: 1, expectedCycleRevision: 1, expectedTtnRevision: 1 });
  await transport.submitLineV2({ shiftId: 'shift_a', operationId: 'op-16', type: 'arrive', truckId: 'truck_1', expectedShiftRevision: 4, expectedStatusRevision: 1, expectedCycleRevision: 1, expectedTtnRevision: 1, fields: { volume: 0 } });
  await transport.prepareClose({ shiftId: 'shift_a', operationId: 'op-17', expectedShiftRevision: 4 });
  await transport.readRestoredArchive({ archiveId: 'archive_1' });
  await transport.submitArchiveV2({ archiveId: 'archive_1', operationId: 'op-18', restoredContextId: 'ctx_1', type: 'trip.delete', recordId: 'trip_1', expectedContextRevision: 1, expectedBaseArchiveRevision: 1, expectedBaseSha256: 'c'.repeat(64) });
  assert.ok(paths.length >= 11, 'все команды дошли до транспорта');
  for (const path of paths) assert.match(path, /^\/api\/v2\//, 'только v2: ' + path);
});

// Скрипт включения флага из оболочки канала: берём ровно тот текст, который
// уходит в сборку, и исполняем его в vm. Так проверка не сверяет регулярку с
// регуляркой, а доказывает поведение: значение по умолчанию и защиту от
// перезаписи заранее выставленного (стенд, отладочное выключение).
function runShellFlagScript(preset) {
  const shell = readFileSync(new URL('../shell.html', import.meta.url), 'utf8');
  const match = /<script>([^<]*WORKING_TEST_V2_SHIFTS[^<]*)<\/script>/.exec(shell);
  assert.ok(match, 'в shell.html есть встроенный скрипт включения флага');
  const window = {};
  if (preset !== undefined) window.WORKING_TEST_V2_SHIFTS = preset;
  vm.runInContext(match[1], vm.createContext({ window }));
  return window.WORKING_TEST_V2_SHIFTS;
}

test('канал включает параллельные смены по умолчанию, но не перезаписывает заданное значение', () => {
  const shell = readFileSync(new URL('../shell.html', import.meta.url), 'utf8');
  const flagAt = shell.indexOf('WORKING_TEST_V2_SHIFTS');
  assert.ok(flagAt > 0, 'флаг упоминается в оболочке канала');
  assert.ok(flagAt < shell.indexOf('working-test/src/storage.js'), 'флаг выставляется до storage.js');
  assert.ok(flagAt < shell.indexOf('<!-- TEST-MODULE:core -->'), 'флаг выставляется до модулей ядра');
  // Включение защищено проверкой «значение ещё не задано»: переключателей
  // через адрес страницы и localStorage нет, иначе «выключить» можно было бы
  // только правкой кода.
  assert.match(shell, /if \(typeof window\.WORKING_TEST_V2_SHIFTS === 'undefined'\) window\.WORKING_TEST_V2_SHIFTS = true;/);
  assert.doesNotMatch(shell, /WORKING_TEST_V2_SHIFTS[^\n]*(localStorage|URLSearchParams)/, 'нет переключателя через localStorage или адрес');
  assert.equal(runShellFlagScript(), true, 'по умолчанию в канале флаг включён');
  assert.equal(runShellFlagScript(false), false, 'заранее выставленное false не перезаписывается');
  assert.equal(runShellFlagScript(true), true, 'заранее выставленное true остаётся true');
});

test('мост рантайма включается флагом и несёт generation в колбэках', () => {
  const runtime = readFileSync(here + '21-nas-runtime.js', 'utf8');
  assert.match(runtime, /typeof WORKING_TEST_V2_SHIFTS!=='undefined'&&WORKING_TEST_V2_SHIFTS===true/, 'включение только флагом');
  assert.match(runtime, /WorkingTestShiftContexts\.createShiftContextStore/, 'store контекстов задачи 13');
  assert.match(runtime, /WorkingTestV2Transport\.createV2Transport/, 'транспорт v2');
  assert.match(runtime, /client\.requestV2/, 'общий запрос session-client');
  assert.match(runtime, /detail:\{generation:list\.listGeneration/, 'колбэк списка несёт поколение');
  assert.match(runtime, /detail:\{generation:result\.generation/, 'колбэк снимка несёт поколение');
  assert.match(runtime, /nasStopV2Shifts\(\)/, 'мост останавливается при смене сеанса');
});

test('общий запрос session-client умеет GET, POST, PATCH, DELETE и сохраняет код v2', async () => {
  const seen = [];
  const reply = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    clone() { return this; },
    json: async () => structuredClone(body)
  });
  const fetchImpl = async (url, options) => {
    seen.push({ url, method: options.method, hasBody: 'body' in options, body: options.body, headers: options.headers });
    if (options.method === 'PATCH') return reply({ protocolVersion: 2, error: 'shift-changed', details: { expectedRevision: 3 } }, 409);
    return reply({ protocolVersion: 2, operationId: 'op', replayed: false, result: {} });
  };
  const client = createNasClient({ getUser: () => ({ uid: 'one', getIdToken: async () => 'token' }), fetchImpl });

  await client.requestV2({ method: 'GET', path: '/api/v2/shifts?limit=1', validate: () => true });
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].hasBody, false, 'GET без тела');

  await client.requestV2({ method: 'POST', path: '/api/v2/shifts', body: { operationId: 'op-1' }, validate: () => true });
  assert.equal(seen[1].method, 'POST');
  assert.equal(JSON.parse(seen[1].body).operationId, 'op-1');

  await client.requestV2({ method: 'DELETE', path: '/api/v2/shifts/shift_a/members/uid_b', body: { operationId: 'op-2' }, validate: () => true });
  assert.equal(seen[2].method, 'DELETE');
  assert.equal(JSON.parse(seen[2].body).operationId, 'op-2');
  assert.equal(seen[2].headers['Content-Type'], 'application/json');

  await assert.rejects(
    client.requestV2({ method: 'PATCH', path: '/api/v2/shifts/shift_a/object', body: { operationId: 'op-3' }, validate: () => true }),
    error => error.status === 409 && error.serverCode === 'shift-changed'
  );
  assert.equal(seen[3].method, 'PATCH');
  assert.equal(JSON.parse(seen[3].body).operationId, 'op-3');
  client.stop();
});
