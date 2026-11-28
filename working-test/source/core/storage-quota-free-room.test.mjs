// Место на устройстве: переполнение памяти не должно терять действие.
//
// Жалоба владельца (28.11.2026): при трёх открытых сменах погрузка падала с
// «Память телефона переполнена». Кеш сессии и журналы других аккаунтов — это
// восстановимые данные, и освобождать место нужно ими, а не отказом в записи.
//
// Проверяем фактический 15-shifts.js: при нехватке места освобождаются кеш и
// чужие журналы, незавершённое действие текущего пользователя и вход остаются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('./', import.meta.url));
const file = here + '15-shifts.js';

const JOURNAL = 'samosval_working_test_offline_nas_v1:scope1';
const CACHE = 'samosval-working-test-cache-nas-v1:scope1';
const FOREIGN = 'samosval_working_test_offline_nas_v1:scope_other';
const TOKEN = 'wt_access_token';

function load() {
  const store = new Map();
  const limit = { bytes: Infinity };
  let total = 0;
  const recount = () => { total = [...store.values()].reduce((sum, value) => sum + value.length, 0); };
  const storage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem(key, value) {
      const text = String(value);
      const next = total - (store.get(key) || '').length + text.length;
      if (next > limit.bytes) {
        const error = new Error('quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      store.set(key, text);
      recount();
    },
    removeItem(key) { store.delete(key); recount(); },
    key: index => [...store.keys()][index] ?? null,
    get length() { return store.size; },
    _store: store,
    _limit: limit,
    _total: () => total
  };
  const sandbox = {
    console,
    localStorage: storage,
    currentUid: 'uid_1',
    WORKSPACE_ID: 'main_workspace',
    firebaseConfig: { projectId: 'samosval-test' },
    location: { pathname: '/index-working-test.html' },
    isNasRuntime: () => true,
    nasStorageScope: () => 'scope1',
    updateSyncUI: () => {},
    state: { shift: { id: 'shift_a' } },
    settings: { cycleMinutes: 15 },
    navigator: { onLine: false },
    renderLine: () => {}, renderHeaderStats: () => {}, renderStatusTicker: () => {},
    saveCache: () => {}, offlineProjectState: () => {}, refreshLineViews: () => {},
    confirmedLoadIds: new Set()
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInContext(readFileSync(file, 'utf8'), vm.createContext(sandbox), { filename: file });
  return { sandbox, storage, store };
}

function seed(storage) {
  const logs = Array.from({ length: 400 }, (_, i) => ({ id: 'log_' + i, truckId: 'truck_1', volume: 20, shiftId: 'shift_old', comment: 'старый рейс '.repeat(6) }));
  storage.setItem(CACHE, JSON.stringify({
    trucks: [{ id: 'truck_1', brand: 'Вольво', number: 'у180хн198' }],
    objects: [], logs: [], truckStatus: {},
    archive: [{ id: 'archive_1', date: '01.11.2026', logs }],
    audit: Array.from({ length: 200 }, (_, i) => ({ id: 'a' + i, text: 'аудит '.repeat(30) })),
    lineAudit: [], notifications: [], savedAt: 1
  }));
  // Журнал другого аккаунта: подтверждённые записи уже доставлены на сервер.
  storage.setItem(FOREIGN, JSON.stringify([
    { id: 'op_old_1', shiftId: 'shift_x', truckId: 'truck_1', status: 'confirmed', effectsDelivered: true },
    { id: 'op_old_2', shiftId: 'shift_x', truckId: 'truck_1', status: 'confirmed', effectsDelivered: true }
  ]));
  storage.setItem(TOKEN, 'access-token-value');
  // Текущее незавершённое действие: терять его нельзя.
  storage.setItem(JOURNAL, JSON.stringify([
    { id: 'op_pending', shiftId: 'shift_a', truckId: 'truck_1', status: 'pending', createdAt: 1 }
  ]));
}

test('при нехватке места освобождаются кеш и чужие журналы, действие сохраняется', () => {
  const { sandbox, storage, store } = load();
  seed(storage);
  const before = (store.get(CACHE) || '').length;
  // Место кончилось: запись новой очереди не проходит, пока не освободим.
  storage._limit.bytes = storage._total() - 200;
  assert.doesNotThrow(() => sandbox.offlineJournalWrite([
    { id: 'op_pending', shiftId: 'shift_a', truckId: 'truck_1', status: 'pending', createdAt: 1 },
    { id: 'op_new', shiftId: 'shift_a', truckId: 'truck_2', status: 'pending', createdAt: 2 }
  ]), 'погрузка не должна падать из-за нехватки места');
  const journal = JSON.parse(store.get(JOURNAL));
  assert.ok(journal.some(op => op.id === 'op_new'), 'новое действие записано в журнал');
  assert.ok(journal.some(op => op.id === 'op_pending'), 'прежнее незавершённое действие не потеряно');
  assert.equal(store.get(TOKEN), 'access-token-value', 'вход не тронут');
  assert.ok((store.get(CACHE) || '').length < before, 'кеш уменьшился, место освободилось');
  assert.ok(!(store.get(FOREIGN) || '').includes('op_old_1'), 'доставленные записи чужого журнала убраны');
});

test('освобождение места не удаляет незавершённые действия других аккаунтов', () => {
  const { sandbox, storage, store } = load();
  seed(storage);
  storage.setItem(FOREIGN, JSON.stringify([
    { id: 'op_other_pending', shiftId: 'shift_x', truckId: 'truck_9', status: 'pending', createdAt: 3 }
  ]));
  sandbox.offlineStorageFreeRoom();
  const foreign = JSON.parse(store.get(FOREIGN));
  assert.deepEqual(foreign.map(op => op.id), ['op_other_pending'], 'чужое неотправленное действие остаётся в очереди');
});
