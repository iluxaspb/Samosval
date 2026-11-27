// Офлайн-журнал v2 (42-offline-v2.js) — контракт design §9.
//
// Проверяем тот самый файл, который уходит в сборку: classic script грузится в
// vm без DOM и без сети, storage инжектируется. Каждая проверка читает
// сохранённое хранилище и сравнивает конверт, а не «функция вернула ok».
//
// Запуск: node --test working-test/source/core/offline-v2.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('./', import.meta.url));
// 17-trip-actions.js на верхнем уровне вешает обработчики касаний: без DOM
// файл не загрузится, поэтому документ — пустая заглушка.
const sandbox = {
  structuredClone,
  console,
  document: { addEventListener() {}, querySelector() { return null; } },
  navigator: { onLine: true }
};
const context = vm.createContext(sandbox);
for (const name of ['42-offline-v2.js', '16-offline-replay.js', '17-trip-actions.js']) {
  const file = here + name;
  vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
}
const journalApi = sandbox.WorkingTestOfflineV2 || {};
// Настоящие функции очереди: часть тестов подменяет их заглушками, поэтому
// харнесс повтора возвращает именно загруженные из файлов реализации.
const realOfflineQueueAction = sandbox.offlineQueueAction;
const realOfflineReplayCommand = sandbox.offlineReplayCommand;

const WORKSPACE = 'workspace_main';
const UID = 'uid_alpha';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    get length() { return map.size; },
    key: index => [...map.keys()][index] ?? null,
    _map: map
  };
}

function command(overrides = {}) {
  return {
    shiftId: 'shift_a',
    operationId: 'op_vector_1',
    commandType: 'load',
    protocolVersion: 2,
    body: { truckId: 'truck_1', type: 'load', expectedCycleRevision: 4 },
    expectedRevisions: { shift: 7, status: 4, cycle: 4, ttn: 2 },
    createdAt: 1732800000000,
    ...overrides
  };
}

function makeJournal({ storage = memoryStorage(), uid = UID, workspaceId = WORKSPACE } = {}) {
  return journalApi.createOfflineJournalV2({ storage, uid, workspaceId });
}

// Объекты модуля живут в другом realm (vm): для сравнения переносим их в
// обычные JSON-значения хоста.
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function storedBytes(storage) {
  const out = {};
  for (const key of storage._map.keys()) out[key] = storage._map.get(key);
  return out;
}

test('журнал v2 публикует полный контракт интерфейса', () => {
  assert.equal(typeof journalApi.createOfflineJournalV2, 'function', 'глобальный контракт WorkingTestOfflineV2');
  const journal = makeJournal();
  for (const name of [
    'enqueue', 'readQueue', 'readAll', 'pendingCount', 'markSent',
    'markRejected', 'deadLetter', 'commandHash', 'seal', 'unseal'
  ]) assert.equal(typeof journal[name], 'function', name);
  assert.equal(journalApi.PROTOCOL_VERSION, 2);
});

test('persisted command неизменяем: смена смены и аккаунта не подменяет поля', () => {
  const storage = memoryStorage();
  const journal = makeJournal({ storage });
  const original = command();
  const enqueued = journal.enqueue(original);
  assert.equal(enqueued.ok, true);
  const persisted = enqueued.record;

  // Выбрали другую смену и вошли другим аккаунтом — журнал смотрит строго свой
  // scope, поэтому запись не «переезжает» и не переписывается.
  const other = makeJournal({ storage, uid: 'uid_beta' });
  other.enqueue(command({ shiftId: 'shift_b', operationId: 'op_other' }));
  assert.deepEqual(plain(journal.readQueue('shift_b')), [], 'чужой uid не виден');
  const [record] = journal.readQueue('shift_a');
  for (const field of ['uid', 'workspaceId', 'shiftId', 'protocolVersion', 'operationId', 'commandType', 'createdAt', 'commandHash']) {
    assert.equal(record[field], persisted[field], 'поле ' + field + ' не подменяется');
  }
  assert.deepEqual(plain(record.body), original.body);
  assert.deepEqual(plain(record.expectedRevisions), original.expectedRevisions);

  // Повторная запись того же конверта после перезапуска: те же значения в
  // хранилище побайтово.
  const raw = storedBytes(storage);
  const queueKey = Object.keys(raw).find(key => key.includes('shift_a') && key.endsWith('/queue'));
  assert.ok(queueKey, 'очередь смены A лежит в своём ключе');
  const persistedRow = JSON.parse(raw[queueKey])[0];
  assert.equal(persistedRow.commandHash, journal.commandHash(original));
  assert.equal(persistedRow.uid, UID);
  assert.equal(persistedRow.workspaceId, WORKSPACE);
  assert.equal(persistedRow.shiftId, 'shift_a');
  assert.equal(persistedRow.protocolVersion, 2);
});

test('commandHash — SHA-256 канонического JSON: фиксированный вектор', () => {
  const journal = makeJournal();
  // Литерал посчитан отдельно по каноническому JSON: клиент и сервер не могут
  // разъехаться молча, не уронив этот тест.
  assert.equal(
    journal.commandHash(command()),
    'ed310e608bc3c6bac8f69c91860955bd392d3dcad6d56448e90aa8a357816391'
  );
  // Порядок ключей во входе не влияет на хеш, изменённое semantic-поле — влияет.
  const reordered = {
    createdAt: 1732800000000,
    expectedRevisions: { ttn: 2, cycle: 4, status: 4, shift: 7 },
    body: { expectedCycleRevision: 4, type: 'load', truckId: 'truck_1' },
    protocolVersion: 2,
    commandType: 'load',
    operationId: 'op_vector_1',
    shiftId: 'shift_a'
  };
  assert.equal(journal.commandHash(reordered), journal.commandHash(command()));
  assert.notEqual(
    journal.commandHash(command({ body: { truckId: 'truck_1', type: 'load', expectedCycleRevision: 5 } })),
    journal.commandHash(command()),
    'другая ожидаемая ревизия — другой хеш'
  );
  assert.notEqual(
    journal.commandHash(command({ createdAt: 1732800000001 })),
    journal.commandHash(command()),
    'время создания входит в хеш'
  );
});

test('canonical JSON не содержит undefined и детерминирован', () => {
  assert.equal(
    journalApi.canonicalJson({ b: 1, a: { d: null, c: [1, 'два'] } }),
    '{"a":{"c":[1,"два"],"d":null},"b":1}'
  );
  assert.equal(journalApi.canonicalJson({ a: 1, b: undefined }), '{"a":1}', 'undefined не попадает в JSON');
  assert.equal(journalApi.canonicalJson({ a: -0 }), '{"a":0}', 'минус ноль нормализован');
});

test('две смены одного uid — независимые очереди, счётчик вкладки только свой', () => {
  const journal = makeJournal();
  journal.enqueue(command({ shiftId: 'shift_a', operationId: 'op_a1' }));
  journal.enqueue(command({ shiftId: 'shift_a', operationId: 'op_a2' }));
  journal.enqueue(command({ shiftId: 'shift_b', operationId: 'op_b1', commandType: 'arrive' }));

  assert.equal(journal.pendingCount('shift_a'), 2);
  assert.equal(journal.pendingCount('shift_b'), 1);
  assert.equal(journal.pendingCount(null), 3, 'общий бейдж — сумма по uid');
  assert.deepEqual(plain(journal.readQueue('shift_a').map(row => row.operationId)), ['op_a1', 'op_a2'], 'порядок enqueue');
  assert.deepEqual(plain(journal.readQueue('shift_b').map(row => row.operationId)), ['op_b1']);
  assert.deepEqual(plain(journal.readAll().map(group => [group.shiftId, group.commands.length])), [['shift_a', 2], ['shift_b', 1]]);
});

test('очередь чужого uid запечатана, не отправляется и не показывается', () => {
  const storage = memoryStorage();
  const journal = makeJournal({ storage });
  journal.enqueue(command({ operationId: 'op_alpha' }));
  const beforeSeal = journal.readQueue('shift_a');

  journal.seal();
  assert.deepEqual(plain(journal.readQueue('shift_a')), [], 'запечатанная очередь не показывается');
  assert.equal(journal.pendingCount('shift_a'), 0);
  assert.deepEqual(plain(journal.readAll()), []);
  assert.equal(journal.enqueue(command({ operationId: 'op_sealed' })).ok, false);
  assert.equal(journal.enqueue(command({ operationId: 'op_sealed' })).error.code, 'journal-sealed');

  // Чужой uid на том же устройстве не видит и не отправляет эти записи.
  const stranger = makeJournal({ storage, uid: 'uid_beta' });
  assert.deepEqual(plain(stranger.readQueue('shift_a')), []);
  assert.equal(stranger.pendingCount(null), 0);

  // Вернулся тот же uid — записи на месте и с прежними хешами.
  journal.unseal();
  const afterUnseal = journal.readQueue('shift_a');
  assert.deepEqual(plain(afterUnseal), plain(beforeSeal), 'конверт не изменился за время запечатывания');

  // Явное локальное удаление — единственный способ стереть чужую очередь.
  assert.equal(journal.purge('shift_a'), true);
  assert.deepEqual(plain(journal.readQueue('shift_a')), []);
});

test('logout и обновление PWA не стирают очередь: после входа тем же uid записи на месте', () => {
  const storage = memoryStorage();
  const first = makeJournal({ storage });
  first.enqueue(command({ operationId: 'op_restart_1' }));
  first.enqueue(command({ operationId: 'op_restart_2', commandType: 'arrive' }));
  const hashes = plain(first.readQueue('shift_a').map(row => row.commandHash));

  // Новый экземпляр = перезагрузка страницы/обновление PWA: ни один ключ не
  // удаляется и не пересобирается.
  const restarted = makeJournal({ storage });
  assert.deepEqual(plain(restarted.readQueue('shift_a').map(row => row.commandHash)), hashes);
  assert.equal(restarted.pendingCount('shift_a'), 2);
});

test('shift-closed → permanent rejected и dead-letter, без переадресации', () => {
  const journal = makeJournal();
  journal.enqueue(command({ shiftId: 'shift_a', operationId: 'op_closed' }));
  journal.enqueue(command({ shiftId: 'shift_b', operationId: 'op_alive' }));

  const rejected = journal.markRejected('op_closed', 'shift-closed', { shiftId: 'shift_a' });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.deadLetter, true);
  assert.equal(rejected.permanent, true);
  assert.deepEqual(plain(journal.deadLetter('shift_a').map(row => row.operationId)), ['op_closed']);
  assert.deepEqual(plain(journal.deadLetter('shift_b')), [], 'dead-letter смены B не пополняется');
  assert.equal(journal.pendingCount('shift_a'), 0);
  const decision = journal.resolveReplay('op_closed', journal.readQueue('shift_a')[0].commandHash);
  assert.equal(decision.action, 'dead-letter');
  assert.equal(decision.rejection.code, 'shift-closed');
});

test('not-shift-member → rejected без переадресации на другую смену', () => {
  const journal = makeJournal();
  const enqueued = journal.enqueue(command({ shiftId: 'shift_a', operationId: 'op_member' }));
  journal.markRejected('op_member', 'not-shift-member');
  const [record] = journal.readQueue('shift_a');
  assert.equal(record.shiftId, 'shift_a', 'запись осталась в исходной смене');
  assert.equal(record.commandHash, enqueued.record.commandHash);
  assert.deepEqual(plain(journal.readQueue('shift_b')), [], 'команда не перенесена в другую смену');
  assert.equal(journal.resolveReplay('op_member', record.commandHash).action, 'dead-letter');
});

test('protocol-upgrade-required/426 → rejected, очередь не переигрывается молча', () => {
  const journal = makeJournal();
  journal.enqueue(command({ operationId: 'op_protocol' }));
  const rejected = journal.markRejected('op_protocol', 'protocol-upgrade-required', { status: 426 });
  assert.equal(rejected.deadLetter, true);
  assert.equal(journal.pendingCount('shift_a'), 0, 'запись больше не считается отправляемой');
  const [record] = journal.readQueue('shift_a');
  assert.equal(record.status, 'rejected');
  assert.equal(journal.resolveReplay('op_protocol', record.commandHash).action, 'dead-letter');
});

test('conflict: shift-changed/revision-conflict/truck-not-on-shift — код и безопасные details', () => {
  const journal = makeJournal();
  for (const [operationId, code] of [
    ['op_shift_changed', 'shift-changed'],
    ['op_revision', 'revision-conflict'],
    ['op_truck', 'truck-not-on-shift']
  ]) {
    journal.enqueue(command({ operationId }));
    const result = journal.markRejected(operationId, code, {
      field: 'expectedCycleRevision',
      expectedRevision: 4,
      currentRevision: 5,
      uid: 'uid_secret',
      email: 'secret@example.com',
      nested: { phone: '+7 900 000-00-00' }
    });
    assert.equal(result.ok, true);
    assert.equal(result.deadLetter, false, code + ' — разрешимый конфликт, не dead-letter');
    const record = journal.readQueue('shift_a').find(row => row.operationId === operationId);
    assert.equal(record.rejection.code, code);
    assert.deepEqual(plain(record.rejection.details), {
      field: 'expectedCycleRevision',
      expectedRevision: 4,
      currentRevision: 5
    }, 'в details только безопасные поля');
    assert.equal(journal.resolveReplay(operationId, record.commandHash).action, 'rejected');
  }
});

test('журнал сохраняет пару expected/actual конфликта ревизий', () => {
  const journal = makeJournal();
  journal.enqueue(command({ operationId: 'op_pair' }));
  const result = journal.markRejected('op_pair', 'revision-conflict', {
    expectedStatusRevision: 2, actualStatusRevision: 3,
    expectedCycleRevision: 2, actualCycleRevision: 3,
    uid: 'uid_secret', email: 'secret@example.com'
  });
  assert.equal(result.ok, true);
  const record = journal.readQueue('shift_a').find(row => row.operationId === 'op_pair');
  assert.deepEqual(plain(record.rejection.details), {
    expectedStatusRevision: 2, actualStatusRevision: 3,
    expectedCycleRevision: 2, actualCycleRevision: 3
  }, 'фактические числа сохраняются: без них конфликт не объяснить');
});

test('повтор с тем же hash возвращает receipt, другой hash — конфликт, а не второй запрос', () => {
  const journal = makeJournal();
  const enqueued = journal.enqueue(command({ operationId: 'op_receipt' }));
  const hash = enqueued.record.commandHash;
  const receipt = { protocolVersion: 2, operationId: 'op_receipt', replayed: false, result: { logId: 'log_1' } };

  const pending = journal.resolveReplay('op_receipt', hash);
  assert.equal(pending.action, 'send');
  assert.deepEqual(plain(pending.command.body), command().body);

  journal.markSent('op_receipt', receipt);
  assert.equal(journal.pendingCount('shift_a'), 0);
  const replay = journal.resolveReplay('op_receipt', hash);
  assert.equal(replay.action, 'return-receipt');
  assert.deepEqual(plain(replay.receipt), receipt, 'сервер повторно не спрашивают');

  const conflict = journal.resolveReplay('op_receipt', 'f'.repeat(64));
  assert.equal(conflict.action, 'conflict');
  assert.equal(conflict.code, 'operation-hash-conflict');

  // Тот же operationId с другим телом — отказ, очередь не растёт.
  const second = journal.enqueue(command({ operationId: 'op_receipt', body: { truckId: 'truck_2' } }));
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'operation-hash-conflict');
  assert.equal(journal.readQueue('shift_a').length, 1);
});

test('force transfer и detached completion никогда не попадают в очередь', () => {
  const storage = memoryStorage();
  const journal = makeJournal({ storage });
  for (const commandType of ['force-transfer', 'detached-complete']) {
    const refused = journal.enqueue(command({ commandType, operationId: 'op_' + commandType }));
    assert.equal(refused.ok, false, commandType + ' не ставится в очередь');
    assert.equal(refused.error.code, 'online-only-command');
  }
  assert.equal(journal.pendingCount(null), 0);
  assert.deepEqual(plain(journal.readAll()), []);
  assert.deepEqual(storedBytes(storage), {}, 'в хранилище не появилось ни одной записи');
  assert.equal(journalApi.isOnlineOnlyCommand('force-transfer'), true);
  assert.equal(journalApi.isOnlineOnlyCommand('load'), false);
});

test('line-команды смены B не завершают detached trip смены A и не смешиваются с её очередью', () => {
  const journal = makeJournal();
  journal.enqueue(command({ shiftId: 'shift_a', operationId: 'op_a_load' }));
  journal.enqueue(command({ shiftId: 'shift_b', operationId: 'op_b_load' }));
  assert.equal(journal.readQueue('shift_b').map(row => row.operationId).join(','), 'op_b_load');
  assert.equal(journal.readQueue('shift_a').map(row => row.operationId).join(','), 'op_a_load');
  // Завершение detached trip — только онлайн, из очереди B невозможно.
  const detached = journal.enqueue(command({
    shiftId: 'shift_b',
    operationId: 'op_b_detached',
    commandType: 'detached-complete'
  }));
  assert.equal(detached.ok, false);
  assert.equal(detached.error.code, 'online-only-command');
  // Чужой operationId не находится в очереди B, поэтому replay не может
  // «завершить» им рейс смены A.
  assert.equal(journal.resolveReplay('op_a_load', journal.readQueue('shift_a')[0].commandHash).action, 'send');
  assert.equal(journal.resolveReplay('op_a_load', 'a'.repeat(64)).action, 'conflict');
  assert.deepEqual(plain(journal.deadLetter('shift_b')), []);
});

test('офлайн-очередь принимает только line-команды выбранной смены (17-trip-actions)', () => {
  const calls = [];
  const errors = [];
  sandbox.state = { shift: { id: 'shift_b' } };
  sandbox.offlineQueueAction = (type, id, intent) => { calls.push({ type, id, shiftId: intent.shiftId }); return true; };
  sandbox.offlineIsOnlineOnlyCommand = type => journalApi.isOnlineOnlyCommand(type);
  sandbox.showError = message => errors.push(message);
  sandbox.offlineReasonLabel = reason => (reason === 'online-only-command' ? 'Только при связи' : reason);

  const queued = sandbox.queueLineCommand('load', 'truck_1', { shiftId: 'shift_b' });
  assert.equal(queued, true);
  assert.deepEqual(calls, [{ type: 'load', id: 'truck_1', shiftId: 'shift_b' }]);

  for (const type of ['force-transfer', 'detached-complete']) {
    const refused = sandbox.queueLineCommand(type, 'truck_1', { shiftId: 'shift_b' });
    assert.equal(refused, false, type + ' не ставится в офлайн-очередь');
  }
  assert.equal(calls.length, 1, 'в очередь ушла только обычная line-команда');
  assert.equal(errors.length, 2, 'офлайн-попытка остаётся read-only с причиной');
  assert.match(errors[0], /Только при связи/);
});

test('карточка смены показывает только её очередь, dead-letter scoped (16-offline-replay)', () => {
  const journal = makeJournal();
  journal.enqueue(command({ shiftId: 'shift_a', operationId: 'op_a1' }));
  journal.enqueue(command({ shiftId: 'shift_a', operationId: 'op_a2', commandType: 'arrive' }));
  journal.enqueue(command({ shiftId: 'shift_b', operationId: 'op_b1' }));
  journal.markRejected('op_a1', 'shift-closed');

  const queue = journal.readAll();
  sandbox.offlineJournalRead = () => queue.flatMap(group => group.commands);
  sandbox.WorkingTestOfflineV2 = journalApi;
  sandbox.state = { shift: { id: 'shift_b' } };

  assert.deepEqual(plain(sandbox.offlineShiftQueue('shift_b').map(row => row.operationId)), ['op_b1']);
  assert.equal(sandbox.offlineShiftPending('shift_b').length, 1);
  assert.deepEqual(plain(sandbox.offlineShiftDeadLetter('shift_a').map(row => row.operationId)), ['op_a1']);
  assert.deepEqual(plain(sandbox.offlineShiftDeadLetter('shift_b')), [], 'отказ смены A не попадает в карточку B');
  assert.equal(sandbox.offlineUnreviewedFailures('shift_b').length, 0);
  assert.equal(sandbox.offlineUnreviewedFailures('shift_a').length, 1);
});

// ---------------------------------------------------------------------------
// Конверт §9 в runtime-очереди: сохранено ровно то, что уходит на сервер.
// Хранилище 15-shifts.js не переписывается — записи остаются плоским списком,
// а канонический конверт едет внутри записи (commandEnvelope + commandHash).
// ---------------------------------------------------------------------------

const JOURNAL_KEY = 'samosval_working_test_offline_v1:samosval-test:' + WORKSPACE + ':' + UID;
// Фиксированный вектор реальной line-команды: посчитан независимо через
// node:crypto по каноническому JSON тех же полей.
const LOAD_ENVELOPE_HASH = '22474dc37d2be4721ce2375c00785255026c7e8b85d366675a00d5c710b77944';
const LOAD_OP = {
  id: 'op_1732800000123_ab12cd',
  type: 'load',
  truckId: 'truck_1',
  shiftId: 'shift_a',
  createdAt: 1732800000123,
  expectedRevision: 4,
  expectedTtnRevision: 2,
  arrivalTimestamp: 1732799000000,
  lastLoadTimestamp: 0,
  wantArrived: true,
  collect: true,
  cycleMinutes: 15,
  truckName: 'КАМАЗ 555',
  volume: 20,
  isGAI: false
};
const SCOPE = { uid: UID, workspaceId: WORKSPACE };

// Песочница повтора: настоящие offlineQueueAction/offlineReplayCommand из
// 16-offline-replay.js, журнал — плоский список в памяти (как в 15-shifts.js),
// «сервер» — список отправленных команд.
function replayHarness() {
  const storage = memoryStorage();
  const queue = () => JSON.parse(storage.getItem(JOURNAL_KEY) || '[]');
  const save = items => storage.setItem(JOURNAL_KEY, JSON.stringify(items));
  const sent = [];
  const errors = [];
  Object.assign(sandbox, {
    localStorage: storage,
    currentUid: UID,
    currentEmail: 'alpha@example.com',
    WORKSPACE_ID: WORKSPACE,
    state: {
      shift: { id: 'shift_a', objectId: 'object_1', objectName: 'Невский проспект' },
      truckStatus: {},
      logs: [],
      notifications: []
    },
    settings: { cycleMinutes: 15 },
    MIN_CYCLE_MINUTES: 15,
    canAdmin: () => false,
    findTruck: id => ({ id, brand: 'КАМАЗ', number: '555', isGAI: false, defaultVol: 20 }),
    getUserName: () => 'Прораб',
    truckLabelHtml: id => 'самосвал ' + id,
    showError: message => errors.push(message),
    showErrorPanel: message => errors.push(message),
    showToastEl: () => {},
    refreshLineViews: () => {},
    signalLineTransition: () => {},
    isNasRuntime: () => false,
    nasStorageScope: () => 'nas-scope',
    offlineQuotaError: () => false,
    offlineShowQuotaPanel: () => {},
    escapeHtml: value => String(value),
    offlineJournalRead: queue,
    offlineJournalWrite: save,
    offlineRemoteStatuses: {},
    offlineRemoteLogs: [],
    offlineReplayJournal: () => {},
    offlineQueueAction: realOfflineQueueAction,
    offlineReplayCommand: realOfflineReplayCommand,
    window: {}
  });
  sandbox.navigator.onLine = false;
  return {
    storage,
    sent,
    errors,
    queue,
    save,
    // Повтор одной записи: то же, что делает цикл offlineReplayJournal —
    // страж, и только при успехе «запрос».
    replay(operationId) {
      const op = queue().find(row => row.id === operationId);
      assert.ok(op, 'запись ' + operationId + ' есть в очереди');
      const command = sandbox.offlineReplayCommand(op);
      if (command) sent.push(command);
      return command;
    },
    enqueueLoad(extra = {}) {
      const intent = {
        shiftId: 'shift_a',
        status: { cycleRevision: 4, ttnRevision: 2, arriveStatus: '10:00', arriveTimestamp: 1732799000000, lastLoadTimestamp: 0 },
        ...extra
      };
      assert.equal(sandbox.offlineQueueAction('load', 'truck_1', intent), true, 'команда поставлена в очередь');
      return queue().slice(-1)[0];
    }
  };
}

test('buildCommandEnvelope даёт канонический конверт §9 с фиксированным хешем', () => {
  const built = journalApi.buildCommandEnvelope(LOAD_OP, SCOPE);
  assert.equal(built.ok, true);
  assert.equal(built.commandHash, LOAD_ENVELOPE_HASH);
  assert.deepEqual(plain(built.envelope), {
    uid: UID,
    workspaceId: WORKSPACE,
    shiftId: 'shift_a',
    protocolVersion: 2,
    operationId: 'op_1732800000123_ab12cd',
    commandType: 'load',
    body: {
      truckId: 'truck_1',
      type: 'load',
      wantArrived: true,
      collect: true,
      cycleMinutes: 15,
      arrivalTimestamp: 1732799000000,
      lastLoadTimestamp: 0,
      volume: 20,
      isGAI: false,
      truckName: 'КАМАЗ 555'
    },
    expectedRevisions: { cycle: 4, ttn: 2 },
    createdAt: 1732800000123,
    commandHash: LOAD_ENVELOPE_HASH
  });
  // Хеш не зависит от порядка ключей и совпадает после сериализации в JSON.
  const roundTripped = JSON.parse(JSON.stringify(built.envelope));
  assert.equal(journalApi.commandHash(roundTripped, SCOPE), LOAD_ENVELOPE_HASH);
  // Изменённое semantic-поле — другой хеш.
  assert.notEqual(
    journalApi.commandHash({ ...roundTripped, body: { ...roundTripped.body, volume: 21 } }, SCOPE),
    LOAD_ENVELOPE_HASH
  );
});

test('конверт не собирается без обязательных полей команды', () => {
  for (const broken of [
    { ...LOAD_OP, truckId: '' },
    { ...LOAD_OP, shiftId: '' },
    { ...LOAD_OP, id: '' },
    { ...LOAD_OP, createdAt: 0 },
    { ...LOAD_OP, volume: 'много' }
  ]) {
    const built = journalApi.buildCommandEnvelope(broken, SCOPE);
    assert.equal(built.ok, false, 'неполная запись не превращается в конверт');
    assert.equal(built.error.code, 'invalid-command');
  }
  assert.equal(journalApi.buildCommandEnvelope(LOAD_OP, {}).ok, false, 'без uid/workspace конверта нет');
});

test('постановка в очередь сохраняет конверт и его хеш в хранилище', () => {
  const harness = replayHarness();
  const record = harness.enqueueLoad();
  assert.ok(record.commandEnvelope, 'конверт сохранён вместе с записью');
  assert.equal(record.commandHash, journalApi.commandHash(record.commandEnvelope, SCOPE));
  const stored = JSON.parse(harness.storage.getItem(JOURNAL_KEY));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].commandHash, stored[0].commandEnvelope.commandHash);
  assert.equal(stored[0].commandEnvelope.operationId, stored[0].id);
  assert.equal(stored[0].commandEnvelope.commandType, 'load');
  assert.equal(stored[0].commandEnvelope.body.volume, 20);
  assert.deepEqual(stored[0].commandEnvelope.expectedRevisions, { cycle: 4, ttn: 2 });
});

test('replay отправляет ровно сохранённое тело конверта', () => {
  const harness = replayHarness();
  const record = harness.enqueueLoad();
  const command = harness.replay(record.id);
  assert.ok(command, 'исправная запись уходит на сервер');
  assert.equal(harness.sent.length, 1);
  const envelope = record.commandEnvelope;
  assert.equal(command.id, envelope.operationId);
  assert.equal(command.type, envelope.commandType);
  assert.equal(command.shiftId, envelope.shiftId);
  assert.equal(command.createdAt, envelope.createdAt);
  for (const [field, value] of Object.entries(envelope.body)) {
    assert.equal(command[field], value, 'поле тела ' + field + ' взято из конверта');
  }
  assert.equal(command.expectedRevision, envelope.expectedRevisions.cycle);
  assert.equal(command.expectedTtnRevision, envelope.expectedRevisions.ttn);
  assert.ok(!('commandEnvelope' in command), 'служебный конверт не уходит на сервер');
  assert.ok(!('commandHash' in command), 'хеш не уходит на сервер');
});

test('подмена тела в хранилище → dead-letter, запрос не отправляется', () => {
  const harness = replayHarness();
  const record = harness.enqueueLoad();
  const tampered = JSON.parse(harness.storage.getItem(JOURNAL_KEY));
  tampered[0].commandEnvelope.body.volume = 999;
  harness.save(tampered);

  const command = harness.replay(record.id);
  assert.equal(command, null, 'повреждённый конверт не отправляется');
  assert.equal(harness.sent.length, 0, 'запрос не вызывался');
  const stored = JSON.parse(harness.storage.getItem(JOURNAL_KEY))[0];
  assert.equal(stored.status, 'rejected');
  assert.equal(stored.result, 'operation-hash-conflict');
  assert.equal(stored.deadLetter, true, 'запись ушла в dead-letter своей смены');
  assert.deepEqual(plain(sandbox.offlineShiftDeadLetter('shift_a').map(row => row.id)), [record.id]);
  assert.deepEqual(plain(sandbox.offlineShiftDeadLetter('shift_b')), [], 'чужая смена не пополняется');
});

test('смена выбранной смены и uid не подменяет сохранённый конверт', () => {
  const harness = replayHarness();
  const record = harness.enqueueLoad();
  const savedEnvelope = JSON.parse(JSON.stringify(record.commandEnvelope));

  // Пользователь переключился на смену B и вошёл другим аккаунтом.
  sandbox.state.shift = { id: 'shift_b', objectId: 'object_2', objectName: 'Пулково' };
  sandbox.currentUid = 'uid_beta';

  const command = harness.replay(record.id);
  assert.ok(command, 'запись всё равно отправляется своим конвертом');
  assert.equal(command.shiftId, 'shift_a', 'shiftId не подменён выбранной сменой');
  assert.equal(command.id, savedEnvelope.operationId);
  assert.deepEqual(
    Object.fromEntries(Object.keys(savedEnvelope.body).map(key => [key, command[key]])),
    savedEnvelope.body,
    'тело отправлено ровно сохранённое'
  );
  const stored = JSON.parse(harness.storage.getItem(JOURNAL_KEY))[0];
  assert.equal(stored.uid, UID, 'uid записи прежний');
  assert.equal(stored.commandHash, savedEnvelope.commandHash, 'хеш не пересобран под новый аккаунт');
});

test('старая запись без конверта получает его один раз и уходит с верным хешем', () => {
  const harness = replayHarness();
  const record = harness.enqueueLoad();
  // Эмуляция очереди, пережившей обновление PWA: конверта ещё нет.
  const legacy = JSON.parse(harness.storage.getItem(JOURNAL_KEY));
  delete legacy[0].commandEnvelope;
  delete legacy[0].commandHash;
  harness.save(legacy);

  const command = harness.replay(record.id);
  assert.ok(command, 'старая запись не теряется');
  const migrated = JSON.parse(harness.storage.getItem(JOURNAL_KEY))[0];
  assert.ok(migrated.commandEnvelope, 'конверт собран и сохранён');
  assert.equal(migrated.commandHash, journalApi.commandHash(migrated.commandEnvelope, SCOPE));
  assert.equal(migrated.commandHash, migrated.commandEnvelope.commandHash);
  assert.equal(command.id, migrated.commandEnvelope.operationId);
  assert.deepEqual(
    Object.fromEntries(Object.keys(migrated.commandEnvelope.body).map(key => [key, command[key]])),
    migrated.commandEnvelope.body
  );

  // Второй повтор использует уже сохранённый конверт и не пересобирает его.
  const before = migrated.commandEnvelope.commandHash;
  harness.replay(record.id);
  const again = JSON.parse(harness.storage.getItem(JOURNAL_KEY))[0];
  assert.equal(again.commandEnvelope.commandHash, before);
});

test('старая запись без обязательных полей → dead-letter, а не «примерно то же»', () => {
  const harness = replayHarness();
  const record = harness.enqueueLoad();
  const legacy = JSON.parse(harness.storage.getItem(JOURNAL_KEY));
  delete legacy[0].commandEnvelope;
  delete legacy[0].commandHash;
  legacy[0].truckId = '';
  harness.save(legacy);

  const command = harness.replay(record.id);
  assert.equal(command, null);
  assert.equal(harness.sent.length, 0);
  const stored = JSON.parse(harness.storage.getItem(JOURNAL_KEY))[0];
  assert.equal(stored.status, 'rejected');
  assert.equal(stored.result, 'operation-hash-conflict');
  assert.equal(stored.deadLetter, true);
});
