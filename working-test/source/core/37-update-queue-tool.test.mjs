// Панель «Неподтверждённые изменения»: инструмент разбора блокировки
// обновления (2026-11). Владелец видел «Установить» → «Обновление отложено:
// есть неподтверждённые изменения на сервере: 1» без способа разобраться.
// Проверяем сам модуль core/37-update-queue-tool.js в vm-песочнице без DOM и
// сети, плюс текстовые якоря в 21-nas-runtime.js и pwa.js (обе копии).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = rel => readFileSync(path.resolve(here, '..', rel), 'utf8');
const text = readSource('core/37-update-queue-tool.js');
const runtimeText = readSource('core/21-nas-runtime.js');

// --- vm-харнес: модуль + минимальные зависимости приложения ---
function makeContext() {
  const storage = new Map();
  const sandbox = {
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k)
    },
    navigator: { onLine: true },
    state: { objects: [{ id: 'obj1', name: 'Лесная' }] },
    truckName: () => 'КАМАЗ 123',
    offlinePendingOps: () => [],
    offlinePendingCount: () => 0,
    pendingOps: 0,
    offlineServerUnreachable: false,
    nasRuntimeClient: null,
    nasIdentityJournalKey: () => 'identity-key',
    window: {}
  };
  sandbox.globalThis = sandbox;
  sandbox.window.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(text, context, { filename: '37-update-queue-tool.js' });
  return { sandbox, storage };
}

const queueKey = 'samosval_nas_commands_v1:test-scope';
const stuckEntry = JSON.stringify([
  {
    slot: 'control:shift-object:shift1', intent: '{}', scope: 'test-scope',
    createdAt: 1732400000000,
    operation: { id: 'cmd_stuck', type: 'shift.object', shiftId: 'shift1', objectId: 'obj1', expectedObjectId: '' },
    lastError: { status: 0, message: 'Failed to fetch', at: 1732400100000 }
  },
  {
    slot: 'control:truck:t1', intent: '{}', scope: 'test-scope',
    operation: { id: 'cmd_ok', type: 'truck.update', recordId: 't1', data: { brand: 'КАМАЗ' } }
  }
]);

test('(а) застрявшая NAS-команда определяется с причиной', () => {
  const { sandbox, storage } = makeContext();
  sandbox.nasRuntimeClient = { scope: 'test-scope' };
  storage.set(queueKey, stuckEntry);
  storage.set('identity-key', JSON.stringify([
    { type: 'user.role', target: 'u1', operation: { id: 'identity_1', type: 'user.role', uid: 'u1', role: 'admin' } }
  ]));
  return sandbox.collectUnsyncedUpdates().then(report => {
    const server = report.categories.find(c => c.id === 'server');
    assert.ok(server, 'должна быть категория «Команды сервера»');
    assert.equal(server.count, 3, 'две команды очереди + одна identity');
    const stuck = server.items.find(i => i.operationId === 'cmd_stuck');
    assert.ok(stuck, 'застрявшая команда попадает в панель');
    assert.match(stuck.title, /Смена объекта/);
    assert.match(stuck.title, /Лесная/, 'объект назван человеческим именем');
    assert.match(stuck.detail, /Нет связи|отправится автоматически/, 'причина застревания объяснена');
    const identity = server.items.find(i => i.operationId === 'identity_1');
    assert.ok(identity, 'команда изменения доступа показана');
    assert.match(identity.title, /Смена роли/);
  });
});

test('(а2) отказ сервера 4xx (кроме 408/429) помечается как «отбросить», повторы — нет', () => {
  const { sandbox } = makeContext();
  assert.equal(sandbox.nasToolPermanentReject(403), true);
  assert.equal(sandbox.nasToolPermanentReject(400), true);
  assert.equal(sandbox.nasToolPermanentReject(408), false, '408 — повторить позже');
  assert.equal(sandbox.nasToolPermanentReject(429), false, '429 — повторить позже');
  assert.equal(sandbox.nasToolPermanentReject(500), false, '5xx — повторить позже');
  assert.equal(sandbox.nasToolPermanentReject(0), false, 'транспортная ошибка — не отбрасывать');
  const reason = sandbox.nasQueueStuckReason({ lastError: { status: 403, message: 'нет прав' } });
  assert.equal(reason.stuck, true);
  assert.match(reason.text, /доступ/, '403 объясняется отказом в доступе');
});

test('(б) панель формирует список по категориям с человеческими названиями', () => {
  const { sandbox, storage } = makeContext();
  sandbox.nasRuntimeClient = { scope: 'test-scope' };
  storage.set(queueKey, stuckEntry);
  sandbox.offlinePendingOps = () => [{ id: 'op1', status: 'pending', type: 'load', truckId: 't1', truckName: 'КАМАЗ 555', createdAt: Date.now() }];
  sandbox.offlinePendingCount = () => 1;
  sandbox.offlineServerUnreachable = true;
  sandbox.window.__tabelPrepareUpdate = () => Promise.resolve({ pending: 2, uploading: false });
  return sandbox.collectUnsyncedUpdates().then(report => {
    const ids = report.categories.map(c => c.id);
    assert.deepEqual(ids.join(','), 'trips,server,tabel');
    const trips = report.categories[0].items[0];
    assert.match(trips.title, /Погрузка/);
    assert.match(trips.title, /КАМАЗ 555/);
    assert.match(trips.detail, /нет связи/, 'рейсы объясняют отсутствие связи');
    assert.match(report.categories[2].items[0].title, /Табель: 2/);
  });
});

test('(в) «Удалить» убирает только выбранную команду', () => {
  const { sandbox, storage } = makeContext();
  storage.set(queueKey, stuckEntry);
  return sandbox.discardNasQueueEntry(queueKey, 'cmd_stuck', async () => true).then(removed => {
    assert.equal(removed, true);
    const rest = JSON.parse(storage.get(queueKey));
    assert.deepEqual(rest.map(x => x.operation.id), ['cmd_ok'], 'остальная очередь не тронута');
  });
});

test('(г) после очистки очереди updateBlockReason через панель пуст', () => {
  const { sandbox, storage } = makeContext();
  sandbox.nasRuntimeClient = { scope: 'test-scope' };
  storage.set(queueKey, stuckEntry);
  storage.set('identity-key', '[]');
  return sandbox.collectUnsyncedUpdates().then(report => {
    assert.ok(report.categories.length);
    return sandbox.discardNasQueueEntry(queueKey, 'cmd_stuck', async () => true)
      .then(() => sandbox.discardNasQueueEntry(queueKey, 'cmd_ok', async () => true))
      .then(() => sandbox.collectUnsyncedUpdates());
  }).then(report => {
    assert.equal(report.categories.length, 0, 'после разбора панели блокировать нечего');
    assert.equal(storage.get(queueKey), '[]');
  });
});

test('(д) ничего не удаляется без подтверждения пользователя', async () => {
  const { sandbox, storage } = makeContext();
  storage.set(queueKey, stuckEntry);
  const removed = await sandbox.discardNasQueueEntry(queueKey, 'cmd_stuck', async () => false);
  assert.equal(removed, false, 'без «да» команда остаётся');
  assert.equal(JSON.parse(storage.get(queueKey)).length, 2);
  // confirm по умолчанию (не передан) — тоже отказ
  const removed2 = await sandbox.discardNasQueueEntry(queueKey, 'cmd_stuck');
  assert.equal(removed2, false);
  assert.equal(JSON.parse(storage.get(queueKey)).length, 2);
  // текст подтверждения объясняет, что именно будет отброшено
  let asked = '';
  await sandbox.discardNasQueueEntry(queueKey, 'cmd_stuck', async q => { asked = q; return false; });
  assert.match(asked, /Смена объекта/);
  assert.match(asked, /НЕ применено на сервере/);
});

test('(е) повтор отправки: успех удаляет, неудача помечает причину', async () => {
  const { sandbox, storage } = makeContext();
  storage.set(queueKey, stuckEntry);
  const calls = [];
  sandbox.nasRuntimeClient = {
    scope: 'test-scope',
    submitControl: async op => { calls.push(op.id); return { ok: true }; }
  };
  await sandbox.retryNasQueueEntry(queueKey, 'cmd_ok');
  assert.deepEqual(calls, ['cmd_ok']);
  assert.deepEqual(JSON.parse(storage.get(queueKey)).map(x => x.operation.id), ['cmd_stuck'], 'успешная команда покидает очередь');
  // неудача: команда остаётся, получает причину
  sandbox.nasRuntimeClient.submitControl = async () => { throw Object.assign(Error('нет прав'), { status: 403 }); };
  await assert.rejects(() => sandbox.retryNasQueueEntry(queueKey, 'cmd_stuck'), /нет прав/);
  const rest = JSON.parse(storage.get(queueKey));
  assert.equal(rest.length, 1);
  assert.equal(rest[0].lastError.status, 403, 'последняя ошибка сохранена в команде');
  assert.equal(rest[0].failed, true, 'окончательный отказ помечен failed');
});

test('(ж) рантайм: ошибки отправки (кроме 400/409) записываются в команду очереди, а не молча теряются', () => {
  assert.match(runtimeText, /markNasCommandFailed\(key,pending\.operation\.id,error\)/,
    'nasBusinessCommand обязан фиксировать причину застревания');
  assert.match(runtimeText, /markIdentityCommandFailed/,
    'nasAdminAction тоже фиксирует причину');
});

test('(з) баннер обновления ведёт в панель: обе копии pwa.js', () => {
  for (const pwa of [readSource('src/pwa.js'), readSource('../src/pwa.js')]) {
    assert.match(pwa, /Что не сохранено\?/, 'нужна кнопка разбора в баннере');
    assert.match(pwa, /__wtShowUnsyncedPanel/, 'кнопка открывает панель');
    assert.match(pwa, /Нажмите «Что не сохранено\?»/);
    assert.match(pwa, /updatePaused\)[^;]*__wtShowUnsyncedPanel|updatePaused&&[^;]*__wtShowUnsyncedPanel/,
      'блокировка установки открывает панель, а не только текст');
  }
});

test('(и) диагностика синхронизации открывает ту же панель', () => {
  const formatting = readSource('core/03-formatting.js');
  assert.match(formatting, /__wtShowUnsyncedPanel/, 'showSyncDiagnostics открывает панель');
});

test('(к) модуль подключён в сборку core', () => {
  const modules = JSON.parse(readFileSync(path.resolve(here, '../../modules.json'), 'utf8'));
  const core = modules.modules.find(m => m.name === 'core');
  assert.ok(core.sources.includes('core/37-update-queue-tool.js'), 'файл должен входить в модуль core');
});

console.log('OK: панель неподтверждённых изменений проверена');
