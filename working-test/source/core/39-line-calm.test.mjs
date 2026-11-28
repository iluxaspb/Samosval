// Регрессионный тест «спокойной линии» (жалоба владельца 23.11.2026):
// жёлтый баннер «Ошибка загрузки … нажмите точку синхронизации» мельтешил
// на каждый фоновый сбой чтения, а карточки «Линии» дёргались от полной
// перерисовки неизменных снапшотов и FLIP-анимации без реального сдвига.
//
// Правила, которые держит этот файл:
// 1) баннер «Ошибка загрузки» — только когда НИ ОДИН успешный источник ещё
//    не читался (первичная загрузка не удалась); фоновый сбой источника с
//    уже успешным чтением даёт состояние degraded: баннер скрыт, ошибка
//    видна на точке синхронизации (жёлтая, без пульсации) и в диагностике;
// 2) неизменный снапшот линии (applyNasSession/acceptNasLineSnapshot) не
//    гоняет renderAll/renderLine; изменившийся — гоняет;
// 3) FLIP-анимация пересортировки не запускается, если порядок карточек
//    не изменился;
// 4) nasActiveRefresh не перечитывает источник, чья последняя ошибка моложе
//    текущего бэкоффа надзирателя (26-nas-resume);
// 5) фоновая ошибка чтения монет при подтверждённом кошельке не поднимает
//    глобальный баннер (nasGameReadError пишет ошибку только в точку).
// Запуск: node --test working-test/source/core/39-line-calm.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const formattingSrc = readFileSync(path.join(here, '03-formatting.js'), 'utf8');
const runtimeSrc = readFileSync(path.join(here, '21-nas-runtime.js'), 'utf8');
const lineUiSrc = readFileSync(path.join(here, '18-line-ui.js'), 'utf8');
const cssSrc = readFileSync(path.join(here, '..', 'styles', 'style-04.css'), 'utf8');

function functionBody(src, name) {
  // async-функции ищем вместе с модификатором, иначе тело без него не парсится.
  let start = src.indexOf('function ' + name);
  const asyncAt = src.lastIndexOf('async function ' + name);
  if (asyncAt >= 0 && (start < 0 || asyncAt <= start)) start = asyncAt;
  assert.ok(start >= 0, 'нет функции ' + name);
  // Тело начинается после списка параметров: параметры вида {force=true}={}
  // содержат собственные фигурные скобки, поэтому ищем закрывающую ")" и
  // только затем открывающую "{" тела функции.
  const parens = src.indexOf('(', start);
  let parenDepth = 0, bodyOpen = -1;
  for (let i = parens; i < src.length && bodyOpen < 0; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')') { parenDepth--; if (!parenDepth) bodyOpen = src.indexOf('{', i); }
  }
  let depth = 0, i = bodyOpen, end = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  return src.slice(start, end + 1);
}

// ===== Часть 1: баннер только при реальной проблеме =====

// vm-харнес реального getSyncStatus: зависимости описаны минимально, чтобы
// путь «ошибка источника» ветвился ровно по everConnected — так поле называется
// в 00-config-state.js и так его пишет markSync.
function runGetSyncStatus({ errors, everConnected, queued = 0, offline = false, role = 'driver' }) {
  let calls = 0;
  const context = {
    offlinePendingCount: () => queued,
    offlineServerUnreachable: offline,
    offlineStatusSince: 0,
    OFFLINE_UI_GRACE_MS: 3000,
    syncState: { errors, everConnected, fromCache: {}, docCount: {}, pendingWrites: {}, lastSuccessAt: 0 },
    navigator: { onLine: true },
    currentUserRole: role,
    initialized: true,
    permissionsLoaded: true,
    pendingOps: 0,
    offlineUnreviewedFailures: () => [],
    Date,
  };
  const result = vm.runInNewContext(functionBody(formattingSrc, 'getSyncStatus') + '\ngetSyncStatus()', context);
  return result;
}

test('v2: legacy-снимок выключается сразу после старта моста', () => {
  assert.match(runtimeSrc, /lineEnabled:nasLegacyLineReadAllowed/, 'v1-подписка проверяет владельца линии');
  assert.match(runtimeSrc, /function nasLegacyLineReadAllowed\(\)[\s\S]*?if\(nasV2BridgeActive&&!nasV2Unsupported\)return false;/,
    'пока мост поднят, v1-снимок не запрашивается даже до первого ответа');
  assert.match(runtimeSrc, /nasV2BridgeActive=true/,
    'мост объявляет себя владельцем линии при старте');
  assert.match(runtimeSrc, /status===404\|\|status===405\|\|status===426\|\|status===501\)nasV2Unsupported=true/,
    'старый сервер без v2-маршрутов возвращает линию на v1');
  assert.match(runtimeSrc, /nasV2BridgeLive=false;nasV2LineRefused=false;\n\s*nasV2BridgeActive=false;nasV2Unsupported=false;/,
    'при остановке моста политика сбрасывается');
  assert.match(runtimeSrc, /nasV2LineRefused=true/,
    'ожидаемый отказ v1 фиксируется, чтобы не повторять бессмысленный запрос');
  assert.match(runtimeSrc, /function nasRefreshLine\(\)[\s\S]*?if\(!nasLegacyLineReadAllowed\(\)\)[\s\S]*?nasV2Bridge\?\.handle\?\.wake\?\.\(\)/,
    'ручное обновление будит v2-мост вместо заведомо конфликтного v1-запроса');
  assert.match(runtimeSrc, /reportSyncError\('nas',error\)/,
    'остальные ошибки legacy-снимка по-прежнему видны пользователю');
});

test('баннер: повторная ошибка источника после успешного чтения не показывает «Ошибка загрузки»', () => {
  const st = runGetSyncStatus({ errors: { 'nas-games': { code: 'unknown', message: 'x', at: 1 } }, everConnected: { 'nas-games': true } });
  assert.equal(st.state, 'degraded', 'фоновый сбой уже читавшегося источника — degraded, а не error');
  assert.ok(!st.text.startsWith('Ошибка загрузки'), 'текст баннера «Ошибка загрузки» не показывается: ' + st.text);
});

test('баннер: первичная ошибка (источник ещё ни разу не читался) показывает «Ошибка загрузки»', () => {
  const st = runGetSyncStatus({ errors: { 'nas-settings': { code: 'unknown', message: 'x', at: 1 } }, everConnected: {} });
  assert.equal(st.state, 'error');
  assert.ok(st.text.startsWith('Ошибка загрузки'), 'первичная неудача загрузки остаётся полноэкранным баннером');
});

test('баннер: смесь первичной и фоновой ошибки считается первичной (ошибка на весь экран)', () => {
  const st = runGetSyncStatus({
    errors: { 'nas-settings': { code: 'x', message: 'x', at: 1 }, 'nas-games': { code: 'x', message: 'x', at: 1 } },
    everConnected: { 'nas-games': true },
  });
  assert.equal(st.state, 'error', 'хотя бы один не читавшийся источник — это проблема первичной загрузки');
});

test('updateSyncUI скрывает жёлтый баннер для degraded и красит точку без пульсации', () => {
  const body = functionBody(formattingSrc, 'updateSyncUI');
  assert.match(body, /st\.state === 'degraded'/, 'degraded входит в условие скрытия баннера');
  assert.match(cssSrc, /\.sync-dot\.degraded/, 'у точки есть отдельный жёлтый класс без анимации');
  assert.doesNotMatch(cssSrc.slice(cssSrc.indexOf('.sync-dot.degraded'), cssSrc.indexOf('.sync-dot.degraded') + 200), /animation/, 'точка degraded не пульсирует');
});

test('диагностика: ошибки источников по-прежнему перечисляются (showSyncDiagnostics)', () => {
  const body = functionBody(formattingSrc, 'showSyncDiagnostics');
  assert.match(body, /ОШИБКА /, 'ошибки остаются видимыми в диагностике точки синхронизации');
});

// Возврат на экран обрывает текущие чтения (abortInflight) — это наша команда,
// а не сбой связи. До исправления такой обрыв записывался как api-timeout и
// после каждого пробуждения телефона показывал «Ошибка загрузки: nas».
function runReportSyncError(error) {
  const context = {
    syncState: { errors: {} },
    offlineTransportError: () => false,
    offlineTransportFailed: () => {},
    nasConnectionHeart: () => {},
    console: { error() {}, warn() {} },
    updateSyncUI() {},
  };
  const report = vm.runInNewContext(functionBody(formattingSrc, 'reportSyncError') + '\nreportSyncError', context);
  report('nas', error);
  return context.syncState.errors;
}

test('обрыв по нашей команде не записывается как ошибка синхронизации', () => {
  const errors = runReportSyncError(Object.assign(new Error('api-aborted: response-headers'), { code: 'api-aborted', retryable: true }));
  assert.deepEqual(errors, {}, 'abortInflight при возврате на экран не рисует «Ошибка загрузки»');
});

test('настоящий таймаут остаётся видимой ошибкой источника', () => {
  const errors = runReportSyncError(Object.assign(new Error('api-timeout: response-headers'), { code: 'api-timeout', retryable: true }));
  assert.equal(errors.nas.code, 'api-timeout', 'настоящий сбой связи по-прежнему виден');
});

// ===== Часть 2: перерисовка линии только при изменениях =====

// Точная копия хэша из 21-nas-runtime.js: снапшоты сравниваются строкой.
function nasStableHash(value) { try { return JSON.stringify(value); } catch (_) { return null; } }

function runLineSnapshotHarness() {
  let renderAllCalls = 0, saveCacheCalls = 0, projectCalls = 0;
  const context = {
    nasReceiptFloors: new Map(),
    state: { shift: null, trucks: [], logs: [], truckStatus: {}, restoredShifts: [], notifications: [] },
    offlineRemoteLogs: [],
    offlineRemoteStatuses: {},
    settings: { cycleMinutes: 15 },
    confirmedLoadIds: new Set(),
    initialized: false,
    nasStableHash,
    nasLineHash: null,
    nasRestoredV1: [],
    nasRestoredShiftsCombined: () => [],
    markSync: () => {},
    offlineProjectState: () => { projectCalls++; },
    refreshNasLineNotificationDisplay: () => {},
    saveCache: () => { saveCacheCalls++; },
    renderAll: () => { renderAllCalls++; },
  };
  const api = vm.runInNewContext(
    functionBody(runtimeSrc, 'acceptNasLineSnapshot') + '\nacceptNasLineSnapshot',
    context,
  );
  const snapshot = () => ({
    shift: { id: 's1' }, trucks: [{ id: 't1' }], statuses: [{ id: 't1', onLine: true }],
    logs: [{ id: 'l1', shiftId: 's1', truckId: 't1', volume: 10 }], cycleMinutes: 15,
  });
  return { api, snapshot, counts: () => ({ renderAllCalls, saveCacheCalls, projectCalls }) };
}

test('линия: повторный идентичный снапшот не вызывает renderAll и saveCache', () => {
  const h = runLineSnapshotHarness();
  assert.equal(h.api(h.snapshot()), true, 'первый снапшот принимается');
  const first = h.counts();
  assert.equal(first.renderAllCalls, 1, 'первый снапшот перерисовывает интерфейс');
  assert.equal(h.api(h.snapshot()), true, 'второй идентичный снапшот тоже принимается');
  assert.equal(h.counts().renderAllCalls, 1, 'неизменный снапшот не гоняет renderAll');
  assert.equal(h.counts().saveCacheCalls, 1, 'неизменный снапшот не пишет кеш');
});

test('линия: изменившийся снапшот вызывает renderAll', () => {
  const h = runLineSnapshotHarness();
  const base = h.snapshot();
  assert.equal(h.api(base), true);
  const changed = { ...base, logs: [...base.logs, { id: 'l2', shiftId: 's1', truckId: 't1', volume: 5 }] };
  assert.equal(h.api(changed), true);
  assert.equal(h.counts().renderAllCalls, 2, 'изменение рейсов перерисовывает линию');
});

// ===== Часть 3: FLIP не запускается при неизменных позициях =====

test('FLIP: анимация сдвига выполняется только при изменении порядка карточек', () => {
  const body = functionBody(lineUiSrc, 'renderLine');
  const flipBranch = body.slice(body.indexOf('if (flipNeeded'));
  assert.ok(flipBranch.length > 0, 'есть ветка FLIP');
  assert.match(body, /renderLineOrderKey/, 'порядок карточек запоминается между рендерами');
  assert.match(body, /flipNeeded = renderLineOrderKey === null \|\| renderLineOrderKey !== orderKey/,
    'первый рендер и смена порядка — единственные поводы для FLIP');
});

// ===== Часть 4: бэкофф nasActiveRefresh =====

test('nasActiveRefresh пропускает источник, чья ошибка моложе бэкоффа надзирателя', () => {
  const body = functionBody(runtimeSrc, 'nasActiveRefresh');
  assert.match(body, /!resume\.due\(nasSyncRetry,\s*source,\s*Date\.now\(\)\)\)return Promise\.resolve\(\)/,
    'источник в паузе повтора не читается этим циклом');
  assert.match(body, /syncErrors\[source\]/, 'пауза применяется только к упавшим источникам');
});

// ===== Часть 5: ошибка монет при подтверждённом кошельке =====

test('ошибка монет при подтверждённом кошельке не ставит глобальный баннер', () => {
  const body = functionBody(runtimeSrc, 'nasGameReadError');
  // nasGameReady не сбрасывается при ошибке без 401/403, а состояние degraded
  // из getSyncStatus прячет баннер: проверяем связку.
  assert.match(body, /nasGameReady=false/, '401/403 по-прежнему отзывают кошелёк');
  assert.match(body, /reportSyncError\('nas-games',error\)/, 'ошибка регистрируется для точки синхронизации');
  const st = runGetSyncStatus({ errors: { 'nas-games': { code: 'unknown', message: 'x', at: 1 } }, everConnected: { 'nas-games': true } });
  assert.equal(st.state, 'degraded', 'подтверждённый ранее кошелёк + фоновая ошибка = без баннера');
});

// ===== Страховка: ранний выход renderLine при неизменных данных =====

test('renderLine не пересобирает карточки, когда значимые данные не изменились', () => {
  const body = functionBody(lineUiSrc, 'renderLine');
  assert.match(body, /renderLineDataKey/, 'есть ключ данных последней отрисовки');
  assert.match(body, /if \(renderKey === renderLineDataKey\) return;/, 'неизменный набор данных — ранний выход до innerHTML');
});

// ===== Поведенческий прогон renderLine: пересборка и FLIP =====

// Фейковый DOM: контейнер линии умеет «парсить» карточки из innerHTML,
// каждая карточка знает свою вершину (top), FLIP-таймеры перехватываются.
function runRenderLineHarness() {
  const flips = [], timeouts = [];
  let rebuilds = 0, cards = [];
  const mkCard = (id, top) => ({ dataset: { truckId: id }, style: {}, __top: top, offsetWidth: 0,
    getBoundingClientRect() { return { top: this.__top }; } });
  const container = {
    set innerHTML(html) { rebuilds++; const ids = [...String(html).matchAll(/data-truck-id="([^"]+)"/g)].map(m => m[1]);
      cards = ids.map((id, i) => mkCard(id, i * 100)); },
    get innerHTML() { return ''; },
    querySelectorAll(sel) { return sel.includes('data-truck-id') || sel === '.truck-card' ? cards : []; },
  };
  const state = {
    shift: { id: 's1' }, trucks: [
      { id: 't1', brand: 'КамАЗ', number: 'а123во77', defaultVol: 10 },
      { id: 't2', brand: 'МАЗ', number: 'в222му77', defaultVol: 12 },
    ],
    truckStatus: { t1: { onLine: true, arriveStatus: true }, t2: { onLine: true, arriveStatus: true } },
    logs: [],
  };
  const context = {
    document: { getElementById: id => ({ trucksLineList: container, startShiftContainer: { style: {} }, activeShiftContainer: { style: {} }, changeObjBtn: { style: {} } })[id] || null },
    state,
    settings: { cycleMinutes: 15 },
    renderLineDataKey: null, renderLineOrderKey: null,
    hasPermission: () => true, hasTabAccess: () => true,
    getActiveLineIds: () => Object.keys(state.truckStatus).filter(id => state.truckStatus[id].onLine === true),
    getLogs: () => state.logs,
    findTruck: id => state.trucks.find(t => t.id === id),
    offlinePendingForTruck: () => null,
    truckPhoneIcon: () => '', escapeHtml: s => String(s), renderRussianPlate: () => '',
    svgTtnIcon: () => '<svg></svg>', svgNoReturnIcon: () => '<svg></svg>',
    formatIdleDuration: () => '0:00', formatTimeAgo: () => 'только что',
    setTimeout: fn => { timeouts.push(fn); return 1; }, clearTimeout: () => {},
    requestAnimationFrame: fn => fn(),
    Date,
  };
  const render = vm.runInNewContext(functionBody(lineUiSrc, 'renderLine') + '\nrenderLine', context);
  return {
    render,
    flips, timeouts,
    rebuilds: () => rebuilds,
    moved: () => cards.filter(c => c.style.transform).length,
    setLogs: logs => { state.logs = logs; },
  };
}

test('поведение: идентичные данные — ни пересборки, ни FLIP; изменение порядка — FLIP', () => {
  const h = runRenderLineHarness();
  const logT2 = [{ id: 'l2', truckId: 't2', volume: 8, timestamp: 1000 }];
  h.setLogs(logT2.slice());
  h.render();
  assert.equal(h.rebuilds(), 1, 'первая отрисовка собирает карточки');
  assert.equal(h.timeouts.length, 0, 'на первой отрисовке FLIP не нужен');
  h.render();
  assert.equal(h.rebuilds(), 1, 'повторный рендер с теми же данными не пересобирает карточки');
  // Данные изменились, но порядок прежний: пересборка есть, FLIP — нет.
  h.setLogs([{ ...logT2[0], volume: 9 }]);
  h.render();
  assert.equal(h.rebuilds(), 2, 'изменение данных пересобирает карточки');
  assert.equal(h.timeouts.length, 0, 'порядок карточек не изменился — FLIP не запускается');
  assert.equal(h.moved(), 0, 'никакая карточка не получила transform');
  // Изменился порядок (у t1 рейс позже t2): FLIP запускается.
  h.setLogs([{ id: 'l2', truckId: 't2', volume: 8, timestamp: 1000 }, { id: 'l1', truckId: 't1', volume: 5, timestamp: 2000 }]);
  h.render();
  assert.equal(h.rebuilds(), 3, 'изменение порядка пересобирает карточки');
  assert.ok(h.timeouts.length > 0, 'реальный сдвиг запускает FLIP-анимацию');
  assert.ok(h.moved() > 0, 'сдвинутые карточки получают transform');
});

// ===== Поведенческий прогон nasActiveRefresh: бэкофф уважается =====

test('поведение: nasActiveRefresh читает живые источники и пропускает источник в бэкоффе', async () => {
  const calls = { nas: 0, 'nas-objects': 0, 'nas-settings': 0, 'nas-auxiliary': 0, 'nas-games': 0 };
  let resetCalls = 0;
  const context = {
    nasRuntimeClient: { tag: 'client' }, nasRuntimeEpoch: 7, currentUserStatus: 'active',
    nasScreenActive: () => true, nasConnectionOnline: () => true,
    nasActivityApi: () => null, nasActivityGateState: () => ({}),
    nasActivityInFlight: false, nasActivityPending: false,
    nasNetworkWake: async () => {}, nasRefreshLine: async () => { calls.nas++; },
    nasSyncApi: () => ({
      due: (state, source) => source !== 'nas-games', // games «в бэкоффе»
      recordSuccess: () => {}, recordFailure: () => {},
      reset: () => { resetCalls++; },
    }),
    nasSyncRetry: { items: {} },
    syncState: { errors: { 'nas-games': { code: 'unknown', message: 'x', at: 1 } } },
    refreshNasObjects: async () => { calls['nas-objects']++; },
    refreshNasSettings: async () => { calls['nas-settings']++; },
    refreshNasAuxiliary: async () => { calls['nas-auxiliary']++; },
    refreshNasGames: async () => { calls['nas-games']++; },
    hasTabAccess: () => false, canAdmin: () => false,
    replayNasOfflineJournal: async () => {},
    setTimeout: () => 1, clearTimeout: () => {},
    Date,
  };
  const refresh = vm.runInNewContext(functionBody(runtimeSrc, 'nasActiveRefresh') + '\nnasActiveRefresh', context);
  const ok = await refresh('poll', { force: true });
  assert.equal(ok, true, 'цикл завершился успешно');
  assert.equal(calls.nas, 1, 'линия перечитывается');
  assert.equal(calls['nas-objects'], 1, 'живой источник перечитывается');
  assert.equal(calls['nas-games'], 0, 'источник в бэкоффе надзирателя пропускается');
  assert.equal(resetCalls, 0, '15-с цикл больше не сбрасывает бэкофф надзирателя');
});
