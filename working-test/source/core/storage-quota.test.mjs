// Регрессионный тест квоты localStorage (кризис 23.11.2026: владелец не мог
// сохранять погрузки — журнал офлайн-действий и аудит росли вечно, память
// телефона переполнилась). Проверяет: подтверждённые записи покидают журнал
// сразу после доставки уведомления/аудита (журнал не растёт); отказы сервера
// держатся непросмотренными и не больше 50; при quota-ошибке аварийная чистка
// освобождает место и запись проходит, а если не помогло — человекочитаемая
// ошибка с флагом storageQuota; миграция при старте чистит раздутые ключи;
// сообщение об ошибке сохранения понятно владельцу; оверлей ошибки — по центру
// экрана, выше нижнего меню; индикация режима не уходит в Firebase при
// quota-ошибке. Запуск:
//   node --test working-test/source/core/storage-quota.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const shifts = readFileSync(join(here, '15-shifts.js'), 'utf8');
const replay = readFileSync(join(here, '16-offline-replay.js'), 'utf8');
const backendMode = readFileSync(join(here, '20-backend-mode.js'), 'utf8');
const css = readFileSync(join(here, '..', 'styles', 'style-04.css'), 'utf8');

// localStorage в памяти с опциональным отказом setItem по квоте.
function makeStorage(initial = {}, quotaFail = null) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      if (quotaFail && quotaFail(k)) { const e = new Error('Failed to execute \'setItem\' on \'Storage\': Setting the value of \'' + k + '\' exceeded the quota.'); e.name = 'QuotaExceededError'; e.code = 22; throw e; }
      map.set(k, String(v));
    },
    removeItem: k => { map.delete(k); },
    key: i => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
}

function op(i, status = 'pending', extra = {}) {
  return { id: 'op' + i, truckId: 't1', shiftId: 's1', status, createdAt: i, ...extra };
}

// Выделяет из 15-shifts.js блок журнала (ключ, чтение, компакция, запись,
// миграция) и исполняет его в песочнице.
function runJournalSandbox(storage) {
  const start = shifts.indexOf('const offlineJournalKey=');
  const end = shifts.indexOf('function offlinePendingForTruck', start);
  assert.ok(start >= 0 && end > start, 'блок журнала найден в 15-shifts.js');
  const sandbox = {
    localStorage: storage,
    isNasRuntime: () => false,
    state: { shift: { id: 's1' } },
    currentUid: 'u1',
    firebaseConfig: { projectId: 'samosval-test' },
    WORKSPACE_ID: 'main_workspace',
    updateSyncUI() {},
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(shifts.slice(start, end), sandbox, { filename: '15-shifts.js' });
  return sandbox;
}

test('saveCache: audit и lineAudit режутся до 200 записей', () => {
  const formatting = readFileSync(join(here, '03-formatting.js'), 'utf8');
  const body = formatting.slice(formatting.indexOf('function saveCache'), formatting.indexOf('function loadCache'));
  assert.match(body, /audit:\s*state\.audit\.slice\(0,\s*200\)/, 'audit ограничен 200');
  assert.match(body, /lineAudit:\s*\(state\.lineAudit \|\| \[\]\)\.slice\(0,\s*200\)/, 'lineAudit ограничен 200, а не пишется целиком');
});

test('подтверждённое действие покидает журнал сразу после доставки уведомления/аудита', () => {
  const storage = makeStorage({});
  const sb = runJournalSandbox(storage);
  // offlineResolve из 16-offline-replay.js исполняется в той же песочнице.
  const resolveStart = replay.indexOf('function offlineResolve');
  const resolveEnd = replay.indexOf('function offlineAdoptResult', resolveStart);
  assert.ok(resolveStart >= 0 && resolveEnd > resolveStart, 'offlineResolve найден');
  vm.runInContext(replay.slice(resolveStart, resolveEnd), sandboxOf(sb), { filename: '16-offline-replay.js#offlineResolve' });

  sb.offlineJournalWrite([op(1, 'pending')]);
  sb.offlineResolve('op1', 'confirmed', 'confirmed');
  let stored = sb.offlineJournalRead();
  assert.equal(stored.length, 1, 'подтверждённая запись ещё в журнале — уведомление/аудит не доставлены');
  assert.equal(stored[0].status, 'confirmed');

  // Уведомление/аудит доставлены (offlineNotifyAccepted ставит effectsDelivered)
  // — следующая же запись журнала удаляет подтверждённое действие навсегда.
  stored[0].effectsDelivered = true;
  sb.offlineJournalWrite(stored);
  assert.equal(sb.offlineJournalRead().length, 0, 'после доставки эффектов подтверждённая запись удалена');
});

test('журнал не растёт: тысячи подтверждённых записей не задерживаются', () => {
  const storage = makeStorage({});
  const sb = runJournalSandbox(storage);
  // Реальная история старых версий: сотни confirmed с доставленными эффектами.
  const history = Array.from({ length: 500 }, (_, i) => op(i, 'confirmed', { effectsDelivered: true }));
  sb.offlineJournalWrite([...history, op(999, 'pending')]);
  const stored = sb.offlineJournalRead();
  assert.equal(stored.filter(x => x.status === 'confirmed').length, 0, 'доставленные подтверждённые записи удаляются');
  assert.equal(stored.filter(x => x.status === 'pending').length, 1, 'очередь неотправленных действий сохраняется');
});

test('отказы сервера: непросмотренные держатся не больше 50, просмотренные удаляются', () => {
  const storage = makeStorage({});
  const sb = runJournalSandbox(storage);
  const items = [
    ...Array.from({ length: 80 }, (_, i) => op(i, 'confirmed', { effectsDelivered: true })),
    ...Array.from({ length: 70 }, (_, i) => op(100 + i, 'rejected', { reviewed: i < 10 })),
    op(200, 'pending'),
  ];
  sb.offlineJournalWrite(items);
  const stored = sb.offlineJournalRead();
  assert.equal(stored.filter(x => x.status === 'confirmed').length, 0, 'журнал не растёт: confirmed удаляются');
  assert.equal(stored.filter(x => x.status === 'rejected' && x.reviewed).length, 0, 'просмотренные отказы удаляются сразу');
  assert.equal(stored.filter(x => x.status === 'rejected').length, 50, 'непросмотренные отказы держатся не больше 50');
  const kept = stored.filter(x => x.status === 'rejected');
  assert.ok(kept.every(x => Number(x.createdAt) >= 110), 'держатся последние 50 отказов, старые срезаются');
  assert.ok(stored.some(x => x.status === 'pending'), 'очередь неотправленных действий сохраняется');
});

test('quota-ошибка: аварийная чистка спасает запись — очередь pending выживает', () => {
  const KEY = 'samosval_working_test_offline_v1_samosval-test_main_workspace_u1';
  const map = new Map([[KEY, JSON.stringify(Array.from({ length: 300 }, (_, i) => op(i, 'rejected')))]]);
  // Квота ломает любую запись, содержащую rejected-строки (раздутые отказы);
  // аварийная чистка убирает их — и повторная запись очереди проходит.
  const storage = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      if (k === KEY && v.includes('"rejected"')) { const e = new Error('...exceeded the quota'); e.name = 'QuotaExceededError'; e.code = 22; throw e; }
      map.set(k, String(v));
    },
    removeItem: k => map.delete(k),
    key: i => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
  const sb = runJournalSandbox(storage);
  sb.offlineJournalWrite([op(1, 'rejected'), op(2, 'pending'), op(3, 'pending')]);
  const stored = JSON.parse(map.get(KEY));
  assert.equal(stored.length, 2, 'после аварийной чистки остались только pending-действия');
  assert.ok(stored.every(x => x.status === 'pending'), 'запись не потеряна: очередь сохранена');
});

test('quota-ошибка не лечится: понятная ошибка с флагом storageQuota, без setItem в тексте', () => {
  const KEY = 'samosval_working_test_offline_v1_samosval-test_main_workspace_u1';
  const storage = makeStorage({}, () => true); // память забита намертво
  const sb = runJournalSandbox(storage);
  assert.throws(() => sb.offlineJournalWrite([op(1, 'pending')]), e => {
    assert.equal(e.storageQuota, true, 'ошибка помечена флагом storageQuota для человекочитаемой панели');
    assert.match(e.message, /Память устройства переполнена/, 'текст понятен владельцу');
    assert.doesNotMatch(e.message, /setItem|quota/i, 'технические термины не в тексте ошибки');
    return true;
  });
});

test('миграция при старте чистит раздутый журнал и audit/lineAudit в кешах сессии', () => {
  const KEY = 'samosval_working_test_offline_v1_samosval-test_main_workspace_u1';
  const CACHE = 'samosval-working-test-cache-nas-v1:test-scope';
  // Реальный раздутый журнал: подтверждённые с доставленными эффектами.
  const bloatedJournal = [
    ...Array.from({ length: 120 }, (_, i) => op(i, 'confirmed', { effectsDelivered: true })),
    ...Array.from({ length: 60 }, (_, i) => op(300 + i, 'rejected', { reviewed: i < 30 })),
  ];
  const bloatedCache = { audit: Array.from({ length: 3591 }, (_, i) => ({ i })), lineAudit: Array.from({ length: 900 }, (_, i) => ({ i })) };
  const storage = makeStorage({
    [KEY]: JSON.stringify(bloatedJournal),
    [CACHE]: JSON.stringify(bloatedCache),
    'unrelated-key': 'untouched',
  });
  runJournalSandbox(storage); // миграция выполняется при загрузке модуля
  const journal = JSON.parse(storage.getItem(KEY));
  assert.equal(journal.filter(x => x.status === 'confirmed').length, 0, 'подтверждённые записи срезаны миграцией');
  assert.equal(journal.filter(x => x.status === 'rejected').length, 30, 'непросмотренные отказы уложены в лимит 50');
  const cache = JSON.parse(storage.getItem(CACHE));
  assert.ok(cache.audit.length <= 200, 'audit в кеше сессии урезан до 200');
  assert.ok(cache.lineAudit.length <= 200, 'lineAudit в кеше сессии урезан до 200');
  assert.equal(storage.getItem('unrelated-key'), 'untouched', 'посторонние ключи не тронуты');
});

test('текст ошибки сохранения человекочитаемый: причина — мелким текстом внутри, не в заголовке', () => {
  const idx = replay.indexOf('function offlineShowQuotaPanel');
  assert.ok(idx >= 0, 'есть функция показа человекочитаемой ошибки квоты');
  const body = replay.slice(idx, replay.indexOf('function', idx + 10));
  assert.ok(body.includes('Не удалось сохранить погрузку. Память телефона переполнена старыми записями — попробуйте ещё раз, приложение почистит их автоматически.'), 'заголовок — человеческий текст');
  assert.ok(!/Не удалось сохранить погрузку[^<]*setItem|Не удалось сохранить погрузку[^<]*quota/i.test(body), 'в заголовке нет технических терминов');
  assert.match(body, /class="error-panel-tech"/, 'техническая причина оформлена отдельным мелким текстом');
  assert.match(body, /escapeHtml\(\(e&&e\.message\)\|\|String\(e\)\)/, 'техническая причина (e.message) мелким текстом внутри');
  // Вызов из catch в offlineQueueAction: и флаг storageQuota, и распознавание quota.
  const catchIdx = replay.indexOf("if((e&&e.storageQuota)||offlineQuotaError(e))offlineShowQuotaPanel(e)");
  assert.ok(catchIdx >= 0, 'ошибка сохранения уходит в человекочитаемую панель');
});

test('оверлей ошибки центрирован по экрану и выше нижнего меню', () => {
  const start = css.indexOf('.error-panel {');
  const body = css.slice(start, css.indexOf('.ru-plate', start));
  assert.match(body, /top:\s*50%;\s*left:\s*50%/, 'панель позиционируется в центре экрана');
  assert.match(css, /\.error-panel\.open\s*\{[^}]*translate\(-50%,\s*-50%\)/, 'открытая панель центрирована по обеим осям');
  assert.doesNotMatch(body, /bottom:\s*0/, 'панель больше не прижата к нижнему краю');
  const zIndex = Number((body.match(/z-index:\s*(\d+)/) || [])[1]);
  const navIndex = Number((css.match(/nav\s*\{[^}]*z-index:\s*(\d+)/) || [])[1]);
  assert.ok(zIndex > navIndex, `z-index панели (${zIndex}) выше нижнего меню (${navIndex}) — кнопка «Понятно» не уходит под навигацию`);
  assert.match(css, /\.error-panel-tech\s*\{[^}]*font-size:\s*11px/, 'есть стиль мелкого технического текста внутри панели');
});

test('индикация режима: quota-ошибка localStorage не переключает индикатор на Firebase', () => {
  const start = backendMode.indexOf('function getTestBackendIndicator');
  const end = backendMode.indexOf('let testUbuntuCheckPending', start);
  const body = backendMode.slice(start, end);
  const storage = makeStorage({});
  const sandbox = {
    localStorage: storage,
    isNasRuntime: () => false,
    currentUid: 'u1',
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(body + ';this.__indicator=getTestBackendIndicator;', sandbox);
  const ok = sandbox.__indicator({ state: 'ok' });
  assert.equal(ok.provider, 'firebase', 'без quota-ошибки индикация прежняя');
  // Память телефона переполнена: даже чтение режима из localStorage падает —
  // индикатор обязан остаться на Ubuntu, а не «уходить в Firebase».
  const broken = makeStorage({}, () => true);
  broken.getItem = () => { throw Object.assign(new Error('...exceeded the quota'), { name: 'QuotaExceededError', code: 22 }); };
  const sb2 = { localStorage: broken, isNasRuntime: () => false, currentUid: 'u1', console: { log() {}, warn() {}, error() {} } };
  vm.createContext(sb2);
  vm.runInContext(body + ';this.__indicator=getTestBackendIndicator;', sb2);
  const quota = sb2.__indicator({ state: 'ok' });
  assert.equal(quota.provider, 'ubuntu', 'при quota-ошибке индикатор остаётся на Ubuntu');
  assert.match(quota.label, /Ubuntu/, 'метка режима человекочитаемая и называет Ubuntu');
});

// vm.runInContext требует контекст, а не саму песочницу-объект: берём её же.
function sandboxOf(sb) { return sb; }
