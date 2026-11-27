// Восстановленный архив и история ревизий (45-restored-archive.js).
//
// Контракт design §5.6 (latest finalized по умолчанию, explicit revision
// отдельно и не меняет default, provenance = original opener/type + отдельный
// restoring actor), §10.2 (буквальные тексты и запрет fallback), §10.1
// (восстановленный архив — отдельный режим, никогда не в полосе смен).
//
// Проверяем фактический classic script, который уходит в сборку: файл грузится
// в vm без сети и DOM, а результаты читаются по фактическим строкам/полям.
//
// Запуск: node --test working-test/source/core/45-restored-archive.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('./', import.meta.url));
const file = here + '45-restored-archive.js';
const source = readFileSync(file, 'utf8');
const sandbox = { console, structuredClone };
const context = vm.createContext(sandbox);
vm.runInContext(source, context, { filename: file });
const api = sandbox.WorkingTestRestoredArchive || {};

const MISSING_AUTHOR = 'Автор не установлен';
const MISSING_TYPE = 'Тип смены не подтверждён';

function archive(options = {}) {
  return api.createRestoredArchive(options);
}

function revisions() {
  return [
    { archiveRevision: 1, archiveSha256: 'sha-one', publishedAt: '2026-11-20T10:00:00+03:00', finalized: true },
    { archiveRevision: 2, archiveSha256: 'sha-two', publishedAt: '2026-11-21T10:00:00+03:00', finalized: true },
    { archiveRevision: 3, archiveSha256: 'sha-three', publishedAt: '2026-11-22T10:00:00+03:00', finalized: true },
    { archiveRevision: 4, archiveSha256: 'sha-draft', publishedAt: '2026-11-23T10:00:00+03:00', finalized: false }
  ];
}

// Фейковый DOM: ровно те операции, которые нужны полосе 43 и карточке 09.
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this._text = '';
    this.parentNode = null;
    this.hidden = false;
    this.innerHTML = '';
    this.classList = { add() {}, remove() {} };
  }
  set className(value) { this.attrs.class = String(value); }
  get className() { return this.attrs.class || ''; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name]; }
  set textContent(value) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    this._text = String(value);
  }
  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._text;
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); }
  scrollIntoView() {}
  querySelector() { return null; }
}

test('модуль публикует createRestoredArchive, работает без сети и DOM', () => {
  assert.equal(typeof api.createRestoredArchive, 'function', 'глобальный контракт WorkingTestRestoredArchive');
  const instance = archive();
  for (const name of [
    'describeProvenance', 'resolveDefault', 'selectRevision', 'canCorrect',
    'canFinalize', 'canResolveManually', 'describeRevision', 'isRestoredRow'
  ]) {
    assert.equal(typeof instance[name], 'function', name);
  }
  for (const name of [
    'canArrive', 'canLoad', 'canReset', 'canAddTruck', 'canRemoveTruck',
    'canAddMember', 'canRemoveMember', 'canCloseShift', 'arrive', 'load', 'reset'
  ]) {
    assert.equal(instance[name], undefined, 'активной line-команды ' + name + ' нет');
  }
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'в модуле нет сетевых запросов');
  assert.doesNotMatch(source, /XMLHttpRequest/, 'в модуле нет XHR');
  assert.doesNotMatch(source, /\bdocument\./, 'в модуле нет DOM');
});

test('неразрешённый автор показан ровно «Автор не установлен» без fallback на sender/displayName/email/createdBy', () => {
  const info = archive().describeProvenance({
    opener: null,
    openerResolution: 'unresolved',
    sender: 'Иван Петров',
    displayName: 'Иван Петров',
    email: 'ivan@example.com',
    createdBy: 'Иван Петров',
    shiftType: 'day',
    shiftTypeResolution: 'resolved'
  });
  assert.equal(info.opener, MISSING_AUTHOR, 'буквальный текст автора');
  assert.ok(info.lines.includes('Автор: ' + MISSING_AUTHOR), 'строка автора ровно с буквальным текстом');
  assert.ok(info.unresolved.includes('opener'), 'автор помечен неразрешённым');
  const dumped = JSON.stringify(info);
  assert.ok(!dumped.includes('Иван'), 'sender/displayName/createdBy не попали в вывод');
  assert.ok(!dumped.includes('ivan@example.com'), 'email не попал в вывод');
});

test('неподтверждённый тип смены показан ровно «Тип смены не подтверждён» и не выводится из часа', () => {
  const info = archive().describeProvenance({
    opener: { uid: 'uid_a', name: 'Сидоров' },
    openerResolution: 'resolved',
    shiftType: null,
    shiftTypeResolution: 'unresolved',
    hour: 14,
    workShift: 'night'
  });
  assert.equal(info.shiftType, MISSING_TYPE, 'буквальный текст типа');
  assert.ok(info.lines.includes('Тип смены: ' + MISSING_TYPE), 'строка типа ровно с буквальным текстом');
  assert.ok(info.unresolved.includes('shiftType'), 'тип помечен неподтверждённым');
  const dumped = JSON.stringify(info);
  assert.ok(!dumped.includes('Ночь'), 'тип не выведен из workShift');
  assert.ok(!dumped.includes('14'), 'час не стал типом смены');
});

test('подтверждённые автор и тип берутся только из provenance', () => {
  const info = archive().describeProvenance({
    opener: { uid: 'uid_a', name: 'Сидоров' },
    openerResolution: 'resolved',
    shiftType: 'night',
    shiftTypeResolution: 'resolved'
  });
  assert.equal(info.opener, 'Сидоров');
  assert.equal(info.shiftType, 'Ночь');
  assert.ok(info.lines.includes('Автор: Сидоров'));
  assert.ok(info.lines.includes('Тип смены: Ночь'));
  assert.equal(info.unresolved.join(','), 'restoringActor', 'не разрешён только восстановивший');
});

test('восстановивший выводится отдельной строкой и не подменяет автора смены', () => {
  const info = archive().describeProvenance({
    opener: { uid: 'uid_a', name: 'Сидоров' },
    openerResolution: 'resolved',
    shiftType: 'day',
    shiftTypeResolution: 'resolved',
    restoringActor: { uid: 'uid_b', name: 'Петров' }
  });
  assert.equal(info.opener, 'Сидоров', 'автор смены остаётся исходным');
  assert.equal(info.restoringActor, 'Петров');
  assert.ok(info.lines.includes('Автор: Сидоров'));
  assert.ok(info.lines.includes('Восстановил: Петров'), 'восстановивший — отдельная строка');
  assert.ok(!info.lines.some(line => line === 'Автор: Петров'), 'восстановивший не подменяет автора');
});

test('при отсутствии восстановившего исходный автор не подменяется', () => {
  const info = archive().describeProvenance({
    opener: { uid: 'uid_a', name: 'Сидоров' },
    openerResolution: 'resolved',
    shiftType: 'day',
    shiftTypeResolution: 'resolved',
    restoringActor: null
  });
  assert.equal(info.opener, 'Сидоров');
  assert.equal(info.restoringActor, MISSING_AUTHOR);
  assert.ok(info.lines.includes('Восстановил: ' + MISSING_AUTHOR));
  assert.ok(info.unresolved.includes('restoringActor'));
  assert.ok(!info.unresolved.includes('opener'), 'исходный автор не стал неразрешённым');
});

test('по умолчанию берётся последняя опубликованная ревизия', () => {
  const latest = archive().resolveDefault(revisions());
  assert.equal(latest.archiveRevision, 3, 'черновик 4 не является default');
  assert.equal(latest.archiveSha256, 'sha-three');
  assert.equal(latest.explicit, false);
});

test('пустой или битый список ревизий не выдумывает ревизию 1', () => {
  const instance = archive();
  assert.equal(instance.resolveDefault([]), null);
  assert.equal(instance.resolveDefault(null), null);
  assert.equal(instance.resolveDefault('ревизии'), null);
  assert.equal(instance.resolveDefault([{ archiveRevision: 'x' }, { finalized: true }]), null);
  assert.equal(instance.resolveDefault([{ archiveRevision: 1, finalized: false }]), null, 'неопубликованная не default');
});

test('явный выбор ревизии не меняет default', () => {
  const instance = archive();
  const list = revisions();
  const selected = instance.selectRevision(list, 1);
  assert.equal(selected.archiveRevision, 1);
  assert.equal(selected.archiveSha256, 'sha-one');
  assert.equal(selected.explicit, true);
  assert.equal(instance.resolveDefault(list).archiveRevision, 3, 'default остался последним опубликованным');
});

test('выбор несуществующей ревизии возвращает null', () => {
  const instance = archive();
  assert.equal(instance.selectRevision(revisions(), 99), null);
  assert.equal(instance.selectRevision(revisions(), 0), null);
  assert.equal(instance.selectRevision(revisions(), 'три'), null);
  assert.equal(instance.selectRevision(revisions(), 4), null, 'неопубликованная ревизия не выбирается');
});

test('описание не последней ревизии только для чтения и не предлагает правок', () => {
  const instance = archive({ latestRevision: 3 });
  const described = instance.describeRevision(instance.selectRevision(revisions(), 1));
  assert.equal(described.revision, 1);
  assert.equal(described.sha256, 'sha-one');
  assert.equal(described.publishedAt, '2026-11-20T10:00:00+03:00');
  assert.equal(described.readOnly, true, 'явная старая ревизия read-only');
  assert.deepEqual(
    Object.keys(described).sort(),
    ['label', 'publishedAt', 'readOnly', 'revision', 'sha256'],
    'в описании нет редактируемых полей и команд'
  );
});

test('описание последней опубликованной ревизии доступно для правок', () => {
  const instance = archive({ latestRevision: 3 });
  const described = instance.describeRevision(instance.resolveDefault(revisions()));
  assert.equal(described.revision, 3);
  assert.equal(described.readOnly, false);
  assert.match(described.label, /Ревизия 3/);
});

test('права архивной правки и публикации считаются по переданному rights', () => {
  const withContext = archive({ restoredContextId: 'ctx_1' });
  assert.equal(withContext.canCorrect({ archive_edit: true }), true);
  assert.equal(withContext.canCorrect({}), false);
  assert.equal(withContext.canCorrect(null), false);
  assert.equal(withContext.canFinalize({ archive_edit: true }), true);
  assert.equal(withContext.canFinalize({}), false, 'без archive_edit публикации нет');
  const withoutContext = archive();
  assert.equal(withoutContext.canFinalize({ archive_edit: true }), false, 'без restoredContextId публикации нет');
  assert.equal(withContext.canFinalize({ archive_edit: true }, ''), false, 'пустой restoredContextId не годится');
});

test('ручное уточнение авторства доступно только admin или legacy_resolve', () => {
  const instance = archive();
  assert.equal(instance.canResolveManually({ admin: true }), true);
  assert.equal(instance.canResolveManually({ legacy_resolve: true }), true);
  assert.equal(instance.canResolveManually({ role: 'admin' }), true);
  assert.equal(instance.canResolveManually({ archive_edit: true }), false);
  assert.equal(instance.canResolveManually({}), false);
  assert.equal(instance.canResolveManually(null), false);
});

test('восстановленная строка распознаётся по всем признакам и не путается с активной', () => {
  const instance = archive();
  assert.equal(instance.isRestoredRow({ restored: true }), true);
  assert.equal(instance.isRestoredRow({ restoredFrom: 'shift_old' }), true);
  assert.equal(instance.isRestoredRow({ restoredContext: { archiveId: 'archive_1' } }), true);
  assert.equal(instance.isRestoredRow({ restoredContextId: 'ctx_1' }), true);
  assert.equal(instance.isRestoredRow({ state: 'historical' }), true);
  assert.equal(instance.isRestoredRow({ shiftId: 'shift_a', state: 'active' }), false, 'активная смена — не restored');
  assert.equal(instance.isRestoredRow({ shiftId: 'shift_b', state: 'closed' }), false);
  assert.equal(instance.isRestoredRow(null), false);
});

// Связка с полосой смен 43: восстановленный/исторический ряд не становится
// вкладкой открытой линии, даже если источник ошибочно отдал его как active.
test('восстановленный ряд не попадает в полосу смен 43', () => {
  const selectorFile = here + '43-shift-selector.js';
  const selectorSandbox = { console, structuredClone };
  const selectorContext = vm.createContext(selectorSandbox);
  vm.runInContext(readFileSync(selectorFile, 'utf8'), selectorContext, { filename: selectorFile });
  const selectorApi = selectorSandbox.WorkingTestShiftSelector;

  const active = { shiftId: 'shift_a', state: 'active', objectName: 'Невский', shiftType: 'day' };
  const archived = {
    shiftId: 'shift_restored', state: 'active', objectName: 'Архивная', shiftType: 'night',
    restored: true, restoredContextId: 'ctx_1'
  };
  const historical = { shiftId: 'shift_hist', state: 'historical', objectName: 'Старая', shiftType: 'day' };
  const rows = [active, archived, historical];
  const mount = new FakeElement('div');
  const store = {
    visibleShifts: () => rows.map(row => ({ ...row })),
    activeShiftId: () => 'shift_a',
    context: () => null,
    selectShift: () => true,
    projectActiveContextToLegacyState: target => target
  };
  const selector = selectorApi.createShiftSelector({
    store,
    doc: { createElement: tag => new FakeElement(tag) },
    mount,
    legacyState: {},
    minShifts: 1
  });
  selector.render();
  const ids = mount.children
    .filter(child => String(child.className).includes('shift-tab'))
    .map(tab => tab.dataset.shiftId);
  assert.deepEqual(ids, ['shift_a'], 'в полосе только настоящая активная смена');
  assert.equal(api.createRestoredArchive().isRestoredRow(archived), true, '45 считает тот же ряд восстановленным');
});

// Интеграция с карточкой восстановленной смены (09-reports.js).
function loadReports(withArchiveModule) {
  const reportsFile = here + '09-reports.js';
  const elements = { restoredShiftsContainer: new FakeElement('div') };
  const state = {
    restoredShifts: [{
      shift: { id: 'shift_r', objectId: 'object_1', objectName: 'Невский проспект', startDate: '23.11.2026' },
      logs: [{ id: 'log_r', truckId: 'truck_1', truckName: 'Камаз', volume: 12, isGAI: false }],
      provenance: {
        opener: null,
        openerResolution: 'unresolved',
        shiftType: 'night',
        shiftTypeResolution: 'resolved',
        restoringActor: { uid: 'uid_b', name: 'Петров' }
      }
    }]
  };
  const reportsSandbox = {
    console,
    document: { getElementById: id => elements[id] || null },
    state,
    hasPermission: () => false,
    objectTitle: (id, fallback) => fallback || id,
    escapeHtml: value => String(value)
  };
  if (withArchiveModule) reportsSandbox.WorkingTestRestoredArchive = api;
  const reportsContext = vm.createContext(reportsSandbox);
  vm.runInContext(readFileSync(reportsFile, 'utf8'), reportsContext, { filename: reportsFile });
  vm.runInContext('renderRestoredShifts()', reportsContext);
  return elements.restoredShiftsContainer.innerHTML;
}

test('карточка восстановленной смены показывает provenance и архивную плашку', () => {
  const html = loadReports(true);
  assert.match(html, /Архивная смена · только правки рейсов\/ТТН/, 'явная архивная плашка');
  assert.match(html, /Автор: Автор не установлен/, 'буквальный автор в карточке');
  assert.match(html, /Тип смены: Ночь/);
  assert.match(html, /Восстановил: Петров/);
});

test('без данных provenance карточка восстановленной смены выглядит как раньше', () => {
  const reportsFile = here + '09-reports.js';
  const elements = { restoredShiftsContainer: new FakeElement('div') };
  const reportsSandbox = {
    console,
    document: { getElementById: id => elements[id] || null },
    state: {
      restoredShifts: [{
        shift: { id: 'shift_r', objectId: 'object_1', objectName: 'Невский проспект', startDate: '23.11.2026' },
        logs: []
      }]
    },
    hasPermission: () => false,
    objectTitle: (id, fallback) => fallback || id,
    escapeHtml: value => String(value)
  };
  const reportsContext = vm.createContext(reportsSandbox);
  vm.runInContext(readFileSync(reportsFile, 'utf8'), reportsContext, { filename: reportsFile });
  vm.runInContext('renderRestoredShifts()', reportsContext);
  const html = elements.restoredShiftsContainer.innerHTML;
  assert.match(html, /Восстановленная смена/, 'старый блок на месте');
  assert.doesNotMatch(html, /Архивная смена · только правки рейсов\/ТТН/, 'без provenance плашки нет');
  assert.doesNotMatch(html, /Автор:/, 'без provenance provenance-строк нет');
});

// Интеграция с модалкой архива (10-archive.js): честный текст и ревизии.
function loadArchiveModal(withProvider) {
  const archiveFile = here + '10-archive.js';
  const ids = {};
  for (const id of [
    'modalArchiveBody', 'modalArchiveTitle', 'archiveRestoreBtn', 'archiveDeleteBtn',
    'archiveProvenanceSection', 'archiveRevisionHistory'
  ]) {
    ids[id] = new FakeElement('div');
  }
  const state = {
    archive: [{ id: 'archive_1', date: '23.11.2026', objectId: 'object_1', objectName: 'Невский проспект', logs: [] }]
  };
  const windowStub = {};
  if (withProvider) {
    windowStub.__wtArchiveRevisionProvider = {
      archiveId: 'archive_1',
      revisions: revisions(),
      provenance: {
        opener: { uid: 'uid_a', name: 'Сидоров' },
        openerResolution: 'resolved',
        shiftType: 'day',
        shiftTypeResolution: 'resolved',
        restoringActor: { uid: 'uid_b', name: 'Петров' }
      }
    };
  }
  const archiveSandbox = {
    console,
    window: windowStub,
    document: { getElementById: id => ids[id] || null },
    state,
    hasTabAccess: () => true,
    hasPermission: () => false,
    findTruck: () => null,
    resolveUserDisplayName: () => '',
    objectTitle: (id, fallback) => fallback || id,
    escapeHtml: value => String(value),
    WorkingTestRestoredArchive: api
  };
  const archiveContext = vm.createContext(archiveSandbox);
  vm.runInContext('var viewingArchiveId = "archive_1"; var viewingArchiveGAITable = false;', archiveContext);
  vm.runInContext(readFileSync(archiveFile, 'utf8'), archiveContext, { filename: archiveFile });
  vm.runInContext('renderArchiveModalContent(state.archive[0])', archiveContext);
  return { ids, window: windowStub, context: archiveContext };
}

test('без провайдера ревизий модалка архива честно говорит «История ревизий недоступна в этом канале»', () => {
  const { ids } = loadArchiveModal(false);
  assert.match(ids.archiveRevisionHistory.innerHTML, /История ревизий недоступна в этом канале/);
  assert.equal(ids.archiveProvenanceSection.innerHTML, '', 'выдуманного provenance нет');
});

test('модалка архива показывает provenance и последнюю ревизию с SHA-256 и датой', () => {
  const { ids } = loadArchiveModal(true);
  assert.match(ids.archiveProvenanceSection.innerHTML, /Автор: Сидоров/);
  assert.match(ids.archiveProvenanceSection.innerHTML, /Тип смены: День/);
  assert.match(ids.archiveProvenanceSection.innerHTML, /Восстановил: Петров/);
  assert.match(ids.archiveProvenanceSection.innerHTML, /Архивная смена · только правки рейсов\/ТТН/);
  const history = ids.archiveRevisionHistory.innerHTML;
  assert.match(history, /История ревизий/);
  assert.match(history, /По умолчанию: ревизия 3/, 'default — последняя опубликованная');
  assert.match(history, /sha-three/, 'SHA-256 ревизии виден');
  assert.match(history, /2026-11-22T10:00:00\+03:00/, 'дата публикации видна');
  assert.match(history, /openArchiveRevision\(/, 'есть explicit-выбор ревизии');
  assert.doesNotMatch(history, /onclick="(arrive|load|reset|closeShift|addTruck|removeTruck|addMember|removeMember)/, 'никаких активных line-команд');
});

test('явный просмотр ревизии не меняет default и помечается только для чтения', () => {
  const { ids, window, context } = loadArchiveModal(true);
  assert.equal(vm.runInContext('openArchiveRevisionView(1)', context), true);
  assert.equal(window.__wtArchiveRevisionView.revision, 1);
  assert.equal(window.__wtArchiveRevisionView.explicit, true);
  assert.equal(window.__wtArchiveRevisionView.readOnly, true);
  assert.match(ids.archiveRevisionHistory.innerHTML, /Выбрана ревизия 1/);
  assert.match(ids.archiveRevisionHistory.innerHTML, /только для чтения/);
  assert.equal(vm.runInContext('openArchiveRevisionView(99)', context), false, 'несуществующая ревизия не выбирается');
  assert.equal(vm.runInContext('closeArchiveRevisionView()', context), true);
  assert.equal(window.__wtArchiveRevisionView, null, 'возврат к default');
  assert.match(ids.archiveRevisionHistory.innerHTML, /По умолчанию: ревизия 3/);
});

// Глобальные хендлеры живут в 19-navigation.js и только делегируют в модалку.
test('глобальные хендлеры openArchiveRevision/closeArchiveRevision не ходят в сеть', () => {
  const navigationFile = here + '19-navigation.js';
  const windowStub = {
    listeners: {},
    addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); }
  };
  const navigationSandbox = {
    console,
    window: windowStub,
    document: { getElementById: () => null },
    setInterval: () => 1,
    setTimeout: () => 1,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { onLine: true },
    state: { archive: [] },
    updateSyncUI: () => {},
    offlineReplayJournal: () => {},
    openArchiveRevisionView: () => 'delegated-open',
    closeArchiveRevisionView: () => 'delegated-close'
  };
  const navigationContext = vm.createContext(navigationSandbox);
  vm.runInContext(readFileSync(navigationFile, 'utf8'), navigationContext, { filename: navigationFile });
  assert.equal(typeof windowStub.openArchiveRevision, 'function');
  assert.equal(typeof windowStub.closeArchiveRevision, 'function');
  assert.equal(windowStub.openArchiveRevision(2), 'delegated-open');
  assert.equal(windowStub.closeArchiveRevision(), 'delegated-close');
  const navigationSource = readFileSync(navigationFile, 'utf8');
  const handlers = navigationSource.slice(
    navigationSource.indexOf('window.openArchiveRevision'),
    navigationSource.indexOf('window.closeArchiveRevision') + 400
  );
  assert.doesNotMatch(handlers, /\bfetch\s*\(|XMLHttpRequest|nasArchiveAction/, 'хендлеры без сети и v1-подмен');
});
