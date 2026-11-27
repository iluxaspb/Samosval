// Параллельные смены включены в канале по умолчанию (решение владельца
// 27.11.2026), поэтому мост v2 поднимается у всех, в том числе там, где сервер
// v2 ещё не отвечает. Проверяем поведение настоящего 21-nas-runtime.js в vm:
//
//   1) без флага мост не поднимается (отладочное выключение остаётся рабочим);
//   2) с флагом, но без единого ответа сервера, сбой моста НЕ попадает в общий
//      индикатор синхронизации — иначе экран показывал бы «Ошибка загрузки:
//      nas-shifts» вместо обычной работы v1;
//   3) когда мост уже отдал данные, сбой видим (проверка не вакуумная);
//   4) первый успешный ответ снимает накопленную ошибку, а не оставляет
//      «Перечитываем: nas-shifts» навсегда.
//
// Запуск: node --test working-test/source/core/v2-bridge-default.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const runtimeFile = fileURLToPath(new URL('./21-nas-runtime.js', import.meta.url));
const runtimeSource = readFileSync(runtimeFile, 'utf8');

function harness() {
  const reported = [];
  const marked = [];
  const warns = [];
  const events = [];
  const quietConsole = Object.create(console);
  quietConsole.warn = (...args) => warns.push(args);
  const c = {
    console: quietConsole,
    URL,
    Map,
    Set,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    WORKSPACE_ID: 'main_workspace',
    WORKING_TEST_UBUNTU_API_BASE: 'https://stand.test',
    currentUid: 'uid_one',
    currentEmail: 'one@example.test',
    currentUserRole: 'admin',
    currentUserStatus: 'active',
    permissionsLoaded: true,
    state: { trucks: [], logs: [], truckStatus: {}, shift: null, objects: [], users: [] },
    settings: {},
    appConfig: {},
    syncState: { errors: {}, everConnected: {}, fromCache: {}, docCount: {}, pendingWrites: {} },
    document: {
      baseURI: 'https://stand.test/index-working-test.html',
      hidden: false,
      body: { setAttribute() {}, removeAttribute() {} },
      getElementById: () => ({ style: {}, textContent: '', classList: { add() {}, remove() {} } }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    window: {
      dispatchEvent: event => { events.push(event); return true; },
      addEventListener() {}
    },
    navigator: { onLine: true },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    reportSyncError: (source, error) => reported.push({ source, error }),
    markSync: (source, fromCache, hasPending, count) => {
      marked.push({ source, fromCache, hasPending, count });
      if (!fromCache) delete c.syncState.errors[source];
    },
    updateSyncUI() {}
  };
  vm.createContext(c);
  vm.runInContext(runtimeSource, c, { filename: runtimeFile });
  return { c, reported, marked, warns, events };
}

// Мост поднимается вручную: фейковые store и транспорт повторяют контракт
// 40-shift-contexts.js / 41-v2-transport.js только в той части, которую читает
// 21-nas-runtime.js (visibleShifts и подписка с колбэками).
function bridge(h, { rows = [] } = {}) {
  const state = { rows, handlers: null, closed: false };
  const store = { visibleShifts: () => state.rows.slice() };
  h.c.WorkingTestShiftContexts = { createShiftContextStore: () => store };
  h.c.WorkingTestV2Transport = {
    createV2Transport: () => ({
      subscribeShifts(handlers) {
        state.handlers = handlers;
        return { close() { state.closed = true; }, wake() {} };
      }
    })
  };
  const client = { uid: 'uid_one', workspaceId: 'main_workspace', requestV2: async () => ({}) };
  h.c.__client = client;
  vm.runInContext('nasRuntimeClient=__client;nasRuntimeEpoch=1;', h.c);
  const started = h.c.nasStartV2Shifts(1, client);
  return { started, state, store, client };
}

test('без флага мост не поднимается и не подписывается на сервер', () => {
  const h = harness();
  const fake = bridge(h);
  assert.equal(fake.started, null, 'флаг не выставлен — мост молчит');
  assert.equal(fake.state.handlers, null, 'подписки нет: запросов v2 нет');
  assert.equal(h.c.nasV2Shifts(), null);
});

test('с флагом мост поднимается даже там, где сервер v2 ещё не отвечает', () => {
  const h = harness();
  h.c.WORKING_TEST_V2_SHIFTS = true;
  const fake = bridge(h);
  assert.ok(fake.started, 'мост поднят');
  assert.equal(typeof fake.state.handlers.onList, 'function');
  assert.equal(typeof fake.state.handlers.onError, 'function');
});

test('до первого ответа сбой моста не красит общий индикатор синхронизации', () => {
  const h = harness();
  h.c.WORKING_TEST_V2_SHIFTS = true;
  const fake = bridge(h);
  const error = Object.assign(new Error('api-http-404'), { code: 'api-http-404', status: 404 });
  fake.state.handlers.onError(error);
  fake.state.handlers.onError(error);
  assert.deepEqual(h.reported, [], 'баннер «Ошибка загрузки: nas-shifts» не появляется');
  assert.equal(h.c.syncState.errors['nas-shifts'], undefined, 'ошибки в syncState нет');
  assert.equal(h.warns.length, 1, 'причина видна в консоли ровно один раз, без спама каждые 4 с');
});

test('когда мост уже отдал данные, сбой видим пользователю', () => {
  const h = harness();
  h.c.WORKING_TEST_V2_SHIFTS = true;
  const fake = bridge(h, { rows: [{ shiftId: 'shift_a', state: 'active' }] });
  fake.state.handlers.onError(Object.assign(new Error('api-http-500'), { code: 'api-http-500', status: 500 }));
  assert.equal(h.reported.length, 1, 'реальный сбой работающего моста не скрывается');
  assert.equal(h.reported[0].source, 'nas-shifts');
});

test('первый успешный ответ снимает накопленную ошибку моста', () => {
  const h = harness();
  h.c.WORKING_TEST_V2_SHIFTS = true;
  const fake = bridge(h, { rows: [{ shiftId: 'shift_a', state: 'active' }] });
  h.c.syncState.errors['nas-shifts'] = { code: 'unavailable', message: 'нет связи', at: 1 };
  fake.state.handlers.onList({ listGeneration: 2, items: [{ shiftId: 'shift_a' }], nextCursor: null });
  assert.equal(h.c.syncState.errors['nas-shifts'], undefined, '«Перечитываем: nas-shifts» не остаётся навсегда');
  assert.deepEqual(h.marked, [{ source: 'nas-shifts', fromCache: false, hasPending: false, count: 1 }]);
  assert.equal(h.events.length, 1, 'список по-прежнему доходит до интерфейса');
  assert.equal(h.events[0].type, 'samosval-working-test-shifts');
});

test('снимок смены тоже считается успехом моста и доходит до интерфейса', () => {
  const h = harness();
  h.c.WORKING_TEST_V2_SHIFTS = true;
  const fake = bridge(h, { rows: [{ shiftId: 'shift_a', state: 'active' }] });
  h.c.syncState.errors['nas-shifts'] = { code: 'unavailable', message: 'нет связи', at: 1 };
  fake.state.handlers.onSnapshot({ generation: 4, shiftId: 'shift_a', revision: 2, applied: true, visible: true });
  assert.equal(h.c.syncState.errors['nas-shifts'], undefined);
  assert.equal(h.events[0].type, 'samosval-working-test-shift-snapshot');
  assert.equal(h.events[0].detail.generation, 4);
});
