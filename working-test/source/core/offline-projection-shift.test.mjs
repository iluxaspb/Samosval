// Карточки самосвалов принадлежат выбранной смене.
//
// Жалоба владельца (28.11.2026): при двух-трёх открытых сменах после
// перерисовки на линии появлялись карточки из другой смены, а сразу после
// действия линия на миг показывала «Нет машин».
//
// Причина: проекция линии (16-offline-replay.js) строилась от глобальной
// основы `offlineRemoteStatuses`, которая о сменах ничего не знает. В режиме
// параллельных смен она не заполнялась снимком выбранной смены, поэтому
// проекция стирала линию, а подтверждённый повтор действия соседней смены
// оставлял в основе её самосвал и он рисовался под чужой сменой.
//
// Проверяем фактический файл сборки: фильтр строк по shiftId и перенос основы
// вместе с выбором смены.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('./', import.meta.url));
const file = here + '16-offline-replay.js';

function load() {
  const sandbox = {
    console,
    // Глобальные переменные, объявленные в других файлах канала.
    state: { shift: { id: 'shift_a', objectId: 'obj_1' }, truckStatus: {}, logs: [], restoredShifts: [] },
    settings: { cycleMinutes: 15 },
    offlineRemoteStatuses: {},
    offlineRemoteLogs: [],
    confirmedLoadIds: new Set(),
    currentUid: 'uid_1',
    WORKSPACE_ID: 'main_workspace',
    navigator: { onLine: true },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    // Очередь действий в этом тесте пуста: проверяется только основа.
    offlineShiftPending: () => [],
    offlineJournalRead: () => [],
    offlineProjectTicker: () => {},
    refreshLineViews: () => {},
    saveCache: () => {},
    renderLine: () => {},
    updateSyncUI: () => {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInContext(readFileSync(file, 'utf8'), vm.createContext(sandbox), { filename: file });
  return sandbox;
}

function row(id, shiftId, extra) {
  return Object.assign({ id, truckId: id, onLine: true, shiftId }, extra || {});
}

test('строка чужой смены в линию выбранной не попадает', () => {
  const sandbox = load();
  const filtered = sandbox.offlineStatusesForShift({
    truck_a: row('truck_a', 'shift_a'),
    truck_b: row('truck_b', 'shift_b')
  }, 'shift_a');
  assert.deepEqual(Object.keys(filtered), ['truck_a'], 'остаётся только самосвал выбранной смены');
  assert.equal(filtered.truck_b, undefined);
});

test('строки старого канала без shiftId не теряются', () => {
  const sandbox = load();
  const filtered = sandbox.offlineStatusesForShift({
    truck_a: { id: 'truck_a', onLine: true },
    truck_b: { id: 'truck_b', onLine: true }
  }, 'shift_a');
  assert.deepEqual(Object.keys(filtered).sort(), ['truck_a', 'truck_b'],
    'v1-снимок не писал shiftId: такие строки принадлежат единственной линии');
});

test('смешанная основа не подмешивает строки без смены к выбранной', () => {
  const sandbox = load();
  const filtered = sandbox.offlineStatusesForShift({
    truck_a: row('truck_a', 'shift_a'),
    truck_legacy: { id: 'truck_legacy', onLine: true }
  }, 'shift_a');
  assert.deepEqual(Object.keys(filtered), ['truck_a'],
    'если смена у строк известна, безымянная строка не считается своей');
});

test('проекция не рисует самосвал другой смены', () => {
  const sandbox = load();
  sandbox.offlineRemoteStatuses = {
    truck_a: row('truck_a', 'shift_a', { arriveStatus: true, arriveTimestamp: 10 }),
    truck_b: row('truck_b', 'shift_b', { arriveStatus: true, arriveTimestamp: 20 })
  };
  sandbox.offlineProjectState();
  assert.deepEqual(Object.keys(sandbox.state.truckStatus), ['truck_a'],
    'под выбранной сменой не должно быть карточек соседней');
});

test('проекция не стирает линию, если основа ещё пуста', () => {
  const sandbox = load();
  // Снимок v2 спроецировал смену в state, но основа не заполнена.
  sandbox.state.truckStatus = {
    truck_a: row('truck_a', 'shift_a', { arriveStatus: true, arriveTimestamp: 10 })
  };
  sandbox.offlineProjectState();
  assert.deepEqual(Object.keys(sandbox.state.truckStatus), ['truck_a'],
    'линия не должна на миг показывать «Нет машин»');
  assert.deepEqual(Object.keys(sandbox.offlineRemoteStatuses), ['truck_a'],
    'основа подхватывает проекцию, чтобы следующая перерисовка была целой');
});

test('основа проекции переезжает вместе с выбором смены', () => {
  const sandbox = load();
  sandbox.state.shift = { id: 'shift_b', objectId: 'obj_2' };
  sandbox.state.truckStatus = { truck_b: row('truck_b', 'shift_b') };
  sandbox.state.logs = [{ id: 'log_b1', shiftId: 'shift_b' }];
  sandbox.offlineRemoteStatuses = { truck_a: row('truck_a', 'shift_a') };
  sandbox.offlineAdoptShiftProjection();
  assert.deepEqual(Object.keys(sandbox.offlineRemoteStatuses), ['truck_b'],
    'после переключения основа — снимок новой смены, а не прежней');
  sandbox.offlineProjectState();
  assert.deepEqual(Object.keys(sandbox.state.truckStatus), ['truck_b']);
});

test('рейсы восстановленных смен не выпадают из основы проекции', () => {
  const sandbox = load();
  sandbox.state.truckStatus = { truck_a: row('truck_a', 'shift_a') };
  sandbox.state.logs = [{ id: 'log_a1', shiftId: 'shift_a' }];
  sandbox.state.restoredShifts = [{ shift: { id: 'shift_old' }, logs: [{ id: 'log_old1' }] }];
  sandbox.offlineAdoptShiftProjection();
  const ids = sandbox.offlineRemoteLogs.map(log => log.id);
  assert.ok(ids.includes('log_a1'), 'рейс выбранной смены на месте');
  assert.ok(ids.includes('log_old1'), 'рейс восстановленной смены нужен правкам из отчёта');
});

test('подтверждённый результат чужой смены не подмешивается в основу', () => {
  const sandbox = load();
  sandbox.state.shift = { id: 'shift_a' };
  sandbox.offlineRemoteStatuses = { truck_a: row('truck_a', 'shift_a') };
  sandbox.offlineAdoptResult(
    { id: 'op_1', shiftId: 'shift_b', truckId: 'truck_b' },
    { status: { shiftId: 'shift_b', cycleRevision: 3, arriveStatus: true } }
  );
  assert.equal(sandbox.offlineRemoteStatuses.truck_b, undefined,
    'чужая смена придёт своим снимком, а не через основу выбранной');
});
