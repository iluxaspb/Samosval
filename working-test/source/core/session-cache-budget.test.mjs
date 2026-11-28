// Кеш сессии не должен занимать память телефона целиком.
//
// Жалоба владельца (28.11.2026): при трёх открытых сменах погрузка падала с
// «Память телефона переполнена». Кеш писал весь архив вместе с рейсами, аудит
// и восстановленные смены, а на реальном объекте с месяцами истории это
// мегабайты; когда места не оставалось, падала уже запись журнала действий.
//
// Проверяем фактический saveCache из сборки: рейсы архива не дублируются,
// размер ограничен бюджетом, а отказ браузера в записи не роняет действие.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('./', import.meta.url));
const file = here + '03-formatting.js';

function load({ failOver = Infinity } = {}) {
  const store = new Map();
  const storage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem(key, value) {
      const text = String(value);
      if (text.length > failOver) {
        const error = new Error('quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      store.set(key, text);
    },
    removeItem: key => store.delete(key),
    key: index => [...store.keys()][index] ?? null,
    get length() { return store.size; },
    _store: store
  };
  const sandbox = {
    console,
    localStorage: storage,
    state: { trucks: [], objects: [], logs: [], truckStatus: {}, shift: null, archive: [], trash: [], audit: [], lineAudit: [], notifications: [], restoredShifts: [] },
    currentUid: 'uid_1',
    WORKSPACE_ID: 'main_workspace',
    firebaseConfig: { projectId: 'samosval-test' },
    location: { pathname: '/index-working-test.html' },
    isNasRuntime: () => true,
    nasStorageScope: () => '["ubuntu","http://127.0.0.1:18095","main_workspace","uid_1"]',
    offlinePendingCount: () => 0,
    offlineRemoteLogs: [],
    offlineRemoteStatuses: {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInContext(readFileSync(file, 'utf8'), vm.createContext(sandbox), { filename: file });
  return { sandbox, storage, store };
}

function bigArchive(count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const logs = [];
    for (let n = 0; n < 40; n += 1) {
      logs.push({ id: 'log_' + i + '_' + n, truckId: 'truck_1', volume: 20, timestamp: 1764000000000 + n, shiftId: 'shift_old_' + i });
    }
    rows.push({ id: 'archive_' + i, date: '01.11.2026', objectId: 'obj_1', objectName: 'Объект', logs, closedAt: 1764000000000 + i });
  }
  return rows;
}

test('рейсы архива не дублируются в кеш, карточка остаётся', () => {
  const { sandbox, storage } = load();
  sandbox.state.archive = bigArchive(3);
  sandbox.state.shift = { id: 'shift_a', objectId: 'obj_1' };
  sandbox.saveCache();
  const key = [...storage._store.keys()].find(k => k.startsWith('samosval-working-test-cache-'));
  const saved = JSON.parse(storage._store.get(key));
  assert.equal(saved.archive.length, 3, 'карточки архива нужны для списка');
  assert.ok(saved.archive.every(card => card.logs === undefined), 'рейсы архива приходят с сервера');
});

test('кеш укладывается в бюджет даже при большом архиве и аудите', () => {
  const { sandbox, storage } = load();
  sandbox.state.archive = bigArchive(40);
  sandbox.state.audit = Array.from({ length: 3000 }, (_, i) => ({ id: 'a' + i, text: 'действие '.repeat(20) }));
  sandbox.state.lineAudit = sandbox.state.audit.slice();
  sandbox.state.shift = { id: 'shift_a', objectId: 'obj_1' };
  sandbox.state.logs = Array.from({ length: 2000 }, (_, i) => ({ id: 'l' + i, truckId: 'truck_1', volume: 20, timestamp: 1764000000000 + i, shiftId: 'shift_a' }));
  sandbox.saveCache();
  const key = [...storage._store.keys()].find(k => k.startsWith('samosval-working-test-cache-'));
  const size = storage._store.get(key).length;
  assert.ok(size <= 160 * 1024, 'кеш ограничен бюджетом 160 КБ, а не растёт вместе с историей: ' + size);
  assert.ok(JSON.parse(storage._store.get(key)).trucks !== undefined, 'линия и база остаются в кеше');
});

test('отказ браузера в записи не роняет сохранение действия', () => {
  const { sandbox, storage } = load({ failOver: 4096 });
  sandbox.state.archive = bigArchive(10);
  sandbox.state.shift = { id: 'shift_a' };
  assert.doesNotThrow(() => sandbox.saveCache(), 'переполнение кеша — не ошибка действия');
  // Даже когда не влезает ничего, ключ не остаётся мусором.
  const keys = [...storage._store.keys()].filter(k => k.startsWith('samosval-working-test-cache-'));
  assert.ok(keys.length <= 1, 'старая раздутая запись не остаётся рядом с новой');
});

test('восстановленные смены и корзина в кеш не пишутся', () => {
  const { sandbox, storage } = load();
  sandbox.state.restoredShifts = [{ shift: { id: 'shift_old' }, logs: [{ id: 'log_old' }] }];
  sandbox.state.trash = [{ id: 'trash_1', logs: [{ id: 'log_t' }] }];
  sandbox.state.shift = { id: 'shift_a' };
  sandbox.saveCache();
  const key = [...storage._store.keys()].find(k => k.startsWith('samosval-working-test-cache-'));
  const saved = JSON.parse(storage._store.get(key));
  assert.deepEqual(saved.restoredShifts, [], 'восстановленные смены читаются заново с сервера');
  assert.deepEqual(saved.trash, []);
});
