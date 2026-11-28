// Полоса открытых смен (43-shift-selector.js) — контракт design §10.1.
//
// Проверяем тот самый classic script, который уходит в сборку: файл грузится в
// vm без сети, DOM передаётся фейковый (jsdom в репозитории не установлен).
// Каждая проверка читает фактическое содержимое полосы и фактический вызов
// onSwitch, а не «функция вернула ok».
//
// Запуск: node --test working-test/source/core/43-shift-selector.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('./', import.meta.url));
const file = here + '43-shift-selector.js';
const source = readFileSync(file, 'utf8');

const scrollCalls = [];
const windowStub = { scrollTo: (...args) => scrollCalls.push(args) };
const sandbox = { console, structuredClone, window: windowStub };
const context = vm.createContext(sandbox);
vm.runInContext(source, context, { filename: file });
const selectorApi = sandbox.WorkingTestShiftSelector || windowStub.WorkingTestShiftSelector || {};

// Фейковый DOM: ровно те операции, которые нужны полосе. textContent ведёт
// себя как в браузере — установка очищает детей и заменяет их текстом.
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
    this.scrollTop = 0;
    this.scrollIntoViewCalls = [];
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
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); }
  dispatch(type, event) { (this.listeners[type] || []).forEach(handler => handler(event)); }
  scrollIntoView(options) { this.scrollIntoViewCalls.push(options); }
  get firstChild() { return this.children[0] || null; }
}

function makeDoc() {
  return { createElement: tag => new FakeElement(tag) };
}

const shiftA = {
  shiftId: 'shift_a', state: 'active', objectId: 'object_1', objectName: 'Невский проспект',
  workDate: '2026-11-23', shiftType: 'day', shiftRevision: 3
};
const shiftB = {
  shiftId: 'shift_b', state: 'closing', objectId: 'object_2', objectName: 'Пулково',
  workDate: '2026-11-23', shiftType: 'night', shiftRevision: 5
};

// Store контекстов: только те методы, которые полоса имеет право вызывать.
// Проекция намеренно повторяет семантику 40-shift-contexts.js: пишется ровно
// контекст выбранной смены, незагруженный контекст даёт пустые logs/statuses.
function makeStore(rows, options = {}) {
  const visible = rows.map(row => ({ ...row }));
  const contexts = options.contexts || {};
  let activeId = options.active === undefined
    ? (visible[0] ? (visible[0].shiftId || visible[0].id) : null)
    : options.active;
  const idOf = row => row.shiftId || row.id;
  return {
    visibleShifts() { return visible.map(row => ({ ...row })); },
    activeShiftId() { return activeId; },
    selectShift(shiftId) {
      if (!visible.some(row => idOf(row) === shiftId)) return false;
      activeId = shiftId;
      return true;
    },
    context(shiftId) {
      const entry = contexts[shiftId];
      return entry ? JSON.parse(JSON.stringify(entry)) : null;
    },
    projectActiveContextToLegacyState(target) {
      const row = visible.find(item => idOf(item) === activeId) || null;
      const entry = activeId ? contexts[activeId] : null;
      const snapshot = entry && entry.snapshot ? entry.snapshot : null;
      target.shift = entry && entry.shift ? JSON.parse(JSON.stringify(entry.shift)) : (row ? { ...row } : null);
      target.logs = snapshot && Array.isArray(snapshot.logs) ? JSON.parse(JSON.stringify(snapshot.logs)) : [];
      const statuses = snapshot && Array.isArray(snapshot.statuses) ? snapshot.statuses : [];
      const truckStatus = {};
      statuses.forEach(status => { truckStatus[status.id] = { ...status }; });
      target.truckStatus = truckStatus;
      target.status = JSON.parse(JSON.stringify(truckStatus));
      return target;
    }
  };
}

function setup({ rows, contexts = {}, active, legacyState, minShifts, onSwitch, offline, transport, queue,
                 lastActionAt, seenAt, markSeen } = {}) {
  const doc = makeDoc();
  const mount = new FakeElement('div');
  // Разметку контейнера задаёт shell.html: полоса не обязана её переписывать.
  mount.setAttribute('role', 'tablist');
  mount.setAttribute('aria-label', 'Открытые смены');
  mount.scrollTop = 137;
  const store = makeStore(rows, { contexts, active });
  const switches = [];
  const state = legacyState || {};
  scrollCalls.length = 0;
  const selector = selectorApi.createShiftSelector({
    store,
    doc,
    mount,
    legacyState: state,
    onSwitch: onSwitch || (id => switches.push(id)),
    minShifts,
    offline,
    transport,
    queue,
    lastActionAt,
    seenAt,
    markSeen,
    window: windowStub
  });
  return { doc, mount, store, selector, state, switches };
}

function tabs(mount) {
  return mount.children.filter(child => String(child.className || '').includes('shift-tab'));
}
function tabOf(mount, shiftId) {
  return tabs(mount).find(tab => tab.dataset.shiftId === shiftId) || null;
}
function activeTabs(mount) {
  return tabs(mount).filter(tab => tab.getAttribute('aria-selected') === 'true');
}

test('модуль публикует createShiftSelector и ничего не требует от сети', () => {
  assert.equal(typeof selectorApi.createShiftSelector, 'function', 'глобальный контракт WorkingTestShiftSelector');
  const { selector } = setup({ rows: [shiftA] });
  for (const name of ['render', 'switchTo', 'refreshBadges', 'activeShiftId', 'destroy']) {
    assert.equal(typeof selector[name], 'function', name);
  }
});

test('полоса показывает только видимые смены active и closing, архив не появляется', () => {
  const rows = [
    shiftA,
    { shiftId: 'shift_closed', state: 'closed', objectName: 'Закрытая', shiftType: 'day' },
    { shiftId: 'shift_hist', state: 'historical', objectName: 'Историческая', shiftType: 'night' },
    { shiftId: 'shift_restored', state: 'active', objectName: 'Восстановленная', shiftType: 'day', restoredContext: { archiveId: 'archive_1' } },
    shiftB
  ];
  const { mount, selector } = setup({ rows });
  selector.render();
  const ids = tabs(mount).map(tab => tab.dataset.shiftId);
  assert.deepEqual(ids, ['shift_a', 'shift_b'], 'закрытая, историческая и восстановленная смены в полосу не попали');
  assert.equal(mount.hidden, false);
});

test('подпись вкладки — объект · день/ночь, счётчик pending только своей смены', () => {
  const rows = [
    shiftA,
    shiftB,
    { shiftId: 'shift_c', state: 'active', objectId: 'object_3', type: 'day' },
    { shiftId: 'shift_d', state: 'active', objectName: 'Софийская', workShift: 'night' }
  ];
  const contexts = {
    shift_a: { shiftId: 'shift_a', revisions: { shift: 3 }, badge: { pending: 2, closing: false, conflict: false } },
    shift_b: { shiftId: 'shift_b', revisions: { shift: 5 }, badge: { pending: 0, closing: true, conflict: false } }
  };
  const { mount, selector } = setup({ rows, contexts });
  selector.render();
  assert.match(tabOf(mount, 'shift_a').textContent, /Невский проспект · День/, 'объект и тип из shiftType');
  assert.match(tabOf(mount, 'shift_b').textContent, /Пулково · Ночь/, 'объект и тип из shiftType=night');
  assert.match(tabOf(mount, 'shift_c').textContent, /object_3 · День/, 'тип читается и из поля type');
  assert.match(tabOf(mount, 'shift_d').textContent, /Софийская · Ночь/, 'тип читается и из поля workShift');
  assert.match(tabOf(mount, 'shift_a').textContent, /2/, 'счётчик pending своей смены виден');
  assert.doesNotMatch(tabOf(mount, 'shift_b').textContent, /2/, 'счётчик чужой смены на вкладку не попадает');
  assert.match(tabOf(mount, 'shift_b').textContent, /закрывается/, 'индикатор closing у закрывающейся смены');
  assert.doesNotMatch(tabOf(mount, 'shift_a').textContent, /закрывается/, 'у активной смены индикатора closing нет');
});

test('индикатор конфликта и офлайна виден на вкладке своей смены', () => {
  const rows = [shiftA, shiftB];
  const contexts = {
    shift_a: { shiftId: 'shift_a', revisions: { shift: 3 }, badge: { pending: 0, closing: false, conflict: true } },
    shift_b: { shiftId: 'shift_b', revisions: { shift: 5 }, badge: { pending: 0, closing: true, conflict: false } }
  };
  const { mount, selector } = setup({ rows, contexts, offline: () => true });
  selector.render();
  assert.match(tabOf(mount, 'shift_a').textContent, /конфликт/, 'конфликт показан у своей смены');
  assert.doesNotMatch(tabOf(mount, 'shift_b').textContent, /конфликт/);
  assert.match(tabOf(mount, 'shift_a').textContent, /офлайн/, 'офлайн-индикатор на вкладке');
  assert.match(tabOf(mount, 'shift_b').textContent, /офлайн/);
});

test('переключение атомарное: в legacyState нет строк прежней смены', () => {
  const rows = [shiftA, shiftB];
  const contexts = {
    shift_a: {
      shiftId: 'shift_a',
      shift: { ...shiftA },
      revisions: { shift: 3 },
      badge: { pending: 0, closing: false, conflict: false },
      snapshot: {
        logs: [{ id: 'log_a', shiftId: 'shift_a', truckId: 'truck_a', volume: 10 }],
        statuses: [{ id: 'truck_a', shiftId: 'shift_a' }]
      }
    },
    shift_b: {
      shiftId: 'shift_b',
      shift: { ...shiftB },
      revisions: { shift: 5 },
      badge: { pending: 0, closing: true, conflict: false },
      snapshot: {
        logs: [{ id: 'log_b', shiftId: 'shift_b', truckId: 'truck_b', volume: 4 }],
        statuses: [{ id: 'truck_b', shiftId: 'shift_b' }]
      }
    }
  };
  const legacyState = {
    shift: { shiftId: 'shift_a', objectName: 'Невский проспект' },
    logs: [{ id: 'log_a', shiftId: 'shift_a' }],
    truckStatus: { truck_a: { id: 'truck_a', shiftId: 'shift_a' } },
    status: { truck_a: { id: 'truck_a', shiftId: 'shift_a' } }
  };
  let atSwitch = null;
  const { selector } = setup({
    rows,
    contexts,
    legacyState,
    onSwitch: () => { atSwitch = JSON.parse(JSON.stringify(legacyState)); }
  });
  assert.equal(selector.switchTo('shift_b'), true);
  assert.equal(atSwitch.shift.shiftId, 'shift_b', 'шапка уже новой смены');
  assert.deepEqual(atSwitch.logs.map(log => log.shiftId), ['shift_b'], 'ни одной строки прежней смены');
  assert.deepEqual(Object.keys(atSwitch.truckStatus), ['truck_b'], 'статусы прежней смены вычищены');
  assert.deepEqual(Object.keys(atSwitch.status), ['truck_b'], 'поле status тоже очищено');
});

test('переключение на смену без загруженного контекста не оставляет данных прежней', () => {
  const rows = [shiftA, shiftB];
  const contexts = {
    shift_a: {
      shiftId: 'shift_a', shift: { ...shiftA }, revisions: { shift: 3 },
      badge: { pending: 0, closing: false, conflict: false },
      snapshot: { logs: [{ id: 'log_a', shiftId: 'shift_a' }], statuses: [{ id: 'truck_a', shiftId: 'shift_a' }] }
    },
    shift_b: { shiftId: 'shift_b', shift: { ...shiftB }, revisions: { shift: 5 }, badge: { pending: 0, closing: true, conflict: false } }
  };
  const legacyState = {
    shift: { shiftId: 'shift_a' },
    logs: [{ id: 'log_a', shiftId: 'shift_a' }],
    truckStatus: { truck_a: { id: 'truck_a', shiftId: 'shift_a' } },
    status: { truck_a: { id: 'truck_a', shiftId: 'shift_a' } }
  };
  let atSwitch = null;
  const { selector } = setup({ rows, contexts, legacyState, onSwitch: () => { atSwitch = JSON.parse(JSON.stringify(legacyState)); } });
  assert.equal(selector.switchTo('shift_b'), true);
  assert.equal(atSwitch.shift.shiftId, 'shift_b');
  assert.deepEqual(atSwitch.logs, [], 'рейсы прежней смены не остались под новой шапкой');
  assert.deepEqual(atSwitch.truckStatus, {}, 'статусы прежней смены не остались');
});

test('переключение на невидимую смену ничего не меняет и возвращает false', () => {
  const rows = [shiftA, shiftB];
  const contexts = {
    shift_a: { shiftId: 'shift_a', shift: { ...shiftA }, revisions: { shift: 3 }, badge: { pending: 0, closing: false, conflict: false }, snapshot: { logs: [{ id: 'log_a', shiftId: 'shift_a' }], statuses: [] } }
  };
  const legacyState = {
    shift: { shiftId: 'shift_a' },
    logs: [{ id: 'log_a', shiftId: 'shift_a' }],
    truckStatus: { truck_a: { id: 'truck_a', shiftId: 'shift_a' } },
    status: { truck_a: { id: 'truck_a', shiftId: 'shift_a' } }
  };
  const before = JSON.parse(JSON.stringify(legacyState));
  const { selector, switches } = setup({ rows, contexts, legacyState });
  assert.equal(selector.switchTo('shift_closed'), false, 'закрытая смена не переключается');
  assert.equal(selector.switchTo(''), false, 'пустой id не переключается');
  assert.deepEqual(legacyState, before, 'legacyState не тронут');
  assert.deepEqual(switches, [], 'onSwitch не вызван');
});

test('вкладки не запускают команд транспорта и не пишут в очередь', () => {
  const rows = [shiftA, shiftB];
  const contexts = {
    shift_a: { shiftId: 'shift_a', shift: { ...shiftA }, revisions: { shift: 3 }, badge: { pending: 0, closing: false, conflict: false } },
    shift_b: { shiftId: 'shift_b', shift: { ...shiftB }, revisions: { shift: 5 }, badge: { pending: 0, closing: true, conflict: false } }
  };
  const calls = [];
  const reads = [];
  const spy = new Proxy({}, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      reads.push(prop);
      if (!(prop in target)) target[prop] = (...args) => { calls.push({ prop, args }); return Promise.resolve({ ok: true, result: {} }); };
      return target[prop];
    }
  });
  const queueCalls = [];
  const queue = new Proxy({}, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!(prop in target)) target[prop] = (...args) => { queueCalls.push({ prop, args }); };
      return target[prop];
    }
  });
  const { mount, selector } = setup({ rows, contexts, transport: spy, queue });
  selector.render();
  assert.equal(selector.switchTo('shift_b'), true);
  tabOf(mount, 'shift_a').dispatch('click', {});
  assert.deepEqual(calls, [], 'ни одна команда транспорта не вызвана');
  assert.deepEqual(reads, [], 'полоса даже не обращается к транспорту');
  assert.deepEqual(queueCalls, [], 'в очередь ничего не записано');
});

test('выбранная вкладка доводится в видимую область без сброса вертикальной прокрутки', () => {
  const rows = [
    shiftA,
    shiftB,
    { shiftId: 'shift_c', state: 'active', objectName: 'Софийская', shiftType: 'day' },
    { shiftId: 'shift_d', state: 'active', objectName: 'Московская', shiftType: 'night' }
  ];
  const contexts = {
    shift_c: { shiftId: 'shift_c', revisions: { shift: 1 }, badge: { pending: 0, closing: false, conflict: false } }
  };
  const { mount, selector } = setup({ rows, contexts, active: 'shift_c' });
  selector.render();
  const active = tabOf(mount, 'shift_c');
  assert.equal(JSON.stringify(active.scrollIntoViewCalls), JSON.stringify([{ block: 'nearest', inline: 'nearest' }]), 'аргументы доводки — block/inline nearest');
  assert.equal(tabs(mount).filter(tab => tab.scrollIntoViewCalls.length).length, 1, 'доводится только выбранная вкладка');
  assert.deepEqual(scrollCalls, [], 'window.scrollTo не вызывается');
  assert.equal(mount.scrollTop, 137, 'вертикальная прокрутка центра не сброшена');
});

test('при одной смене полосы нет, при двух появляется', () => {
  const none = setup({ rows: [] });
  none.selector.render();
  assert.equal(none.mount.hidden, true, 'при нуле смен полоса скрыта');
  assert.equal(tabs(none.mount).length, 0);

  const one = setup({ rows: [shiftA] });
  one.selector.render();
  assert.equal(one.mount.hidden, true, 'v1-режим с одной сменой экран не меняет');
  assert.equal(tabs(one.mount).length, 0);

  const two = setup({ rows: [shiftA, shiftB] });
  two.selector.render();
  assert.equal(two.mount.hidden, false, 'при двух сменах полоса видна');
  assert.equal(tabs(two.mount).length, 2);

  const three = setup({ rows: [shiftA, shiftB], minShifts: 3 });
  three.selector.render();
  assert.equal(three.mount.hidden, true, 'явный minShifts соблюдается');
  assert.equal(tabs(three.mount).length, 0);
});

test('выбранная вкладка отличима не только цветом', () => {
  const rows = [shiftA, shiftB];
  const { mount, selector } = setup({ rows });
  selector.render();
  const active = tabOf(mount, 'shift_a');
  const other = tabOf(mount, 'shift_b');
  assert.equal(active.getAttribute('aria-selected'), 'true');
  assert.equal(other.getAttribute('aria-selected'), 'false');
  assert.equal(active.getAttribute('role'), 'tab', 'вкладка объявлена ролью tab');
  assert.match(active.className, /is-active/, 'класс is-active у выбранной');
  assert.doesNotMatch(other.className, /is-active/);
  assert.match(active.textContent, /✓/, 'текстовый маркер выбранной вкладки');
  assert.doesNotMatch(other.textContent, /✓/, 'у невыбранной маркера нет');
  assert.equal(mount.getAttribute('role'), 'tablist');
});

test('устаревший выбор не оставляет мёртвой вкладки', () => {
  const rows = [shiftA, shiftB];
  const stale = setup({ rows, active: 'shift_gone' });
  stale.selector.render();
  assert.equal(activeTabs(stale.mount).length, 1, 'выбрана ровно одна вкладка');
  assert.equal(activeTabs(stale.mount)[0].dataset.shiftId, 'shift_a', 'активной стала первая видимая');
  assert.equal(tabOf(stale.mount, 'shift_gone'), null, 'мёртвой вкладки нет');

  const reselected = setup({ rows, active: 'shift_b' });
  reselected.selector.render();
  assert.equal(activeTabs(reselected.mount)[0].dataset.shiftId, 'shift_b', 'выбор store после replaceVisibleShifts уважается');
  assert.equal(activeTabs(reselected.mount).length, 1);
});

test('refreshBadges обновляет счётчик closing/pending без перестройки полосы', () => {
  const rows = [shiftA, shiftB];
  const contexts = {
    shift_a: { shiftId: 'shift_a', revisions: { shift: 3 }, badge: { pending: 2, closing: false, conflict: false } },
    shift_b: { shiftId: 'shift_b', revisions: { shift: 5 }, badge: { pending: 0, closing: false, conflict: false } }
  };
  const { mount, selector } = setup({ rows, contexts });
  selector.render();
  const before = tabs(mount);
  const tabA = tabOf(mount, 'shift_a');
  assert.match(tabA.textContent, /2/);

  contexts.shift_a.badge.pending = 5;
  contexts.shift_a.badge.conflict = true;
  contexts.shift_b.badge.closing = true;
  selector.refreshBadges();

  const after = tabs(mount);
  assert.equal(after.length, before.length);
  assert.equal(tabOf(mount, 'shift_a'), tabA, 'вкладка не пересобрана');
  assert.match(tabOf(mount, 'shift_a').textContent, /5/, 'счётчик pending обновлён');
  assert.match(tabOf(mount, 'shift_a').textContent, /конфликт/, 'индикатор конфликта обновлён без перестройки');
  assert.match(tabOf(mount, 'shift_b').textContent, /закрывается/, 'closing-индикатор обновлён');
});

test('destroy убирает полосу и вкладки', () => {
  const rows = [shiftA, shiftB];
  const { mount, selector } = setup({ rows });
  selector.render();
  assert.equal(tabs(mount).length, 2);
  selector.destroy();
  assert.equal(tabs(mount).length, 0, 'вкладки удалены');
  assert.equal(mount.hidden, true, 'полоса скрыта');
});

// Точка непросмотренного действия (решение владельца 28.11.2026): уведомления
// разных смен не смешиваются, а вкладка чужой смены подсказывает, что там было
// действие. Точка гаснет, когда смену открыли.
function actionDot(tab) {
  if (!tab) return null;
  const badges = tab.children.filter(child => String(child.className || '').includes('shift-tab-badges'));
  const list = badges.length ? badges[0].children : [];
  return list.find(badge => String(badge.className || '').includes('shift-tab-action')) || null;
}

test('точка непросмотренного действия: у другой смены есть, у выбранной нет', () => {
  const actions = { shift_a: 1000, shift_b: 2000 };
  const seen = { shift_a: 0, shift_b: 0 };
  const { mount, selector } = setup({
    rows: [shiftA, shiftB], active: 'shift_a',
    lastActionAt: id => actions[id] || 0,
    seenAt: id => seen[id] || 0,
    markSeen: id => { seen[id] = Date.now(); }
  });
  selector.render();
  assert.equal(actionDot(tabOf(mount, 'shift_a')), null, 'у выбранной смены точки нет');
  const dot = actionDot(tabOf(mount, 'shift_b'));
  assert.ok(dot, 'у другой смены точка есть');
  assert.equal(dot.getAttribute('title'), 'новое действие в этой смене');
});

test('точка гаснет после просмотра смены и возвращается при новом действии', () => {
  const actions = { shift_a: 1000, shift_b: 2000 };
  const seen = { shift_a: 0, shift_b: 0 };
  const { mount, selector } = setup({
    rows: [shiftA, shiftB], active: 'shift_a',
    lastActionAt: id => actions[id] || 0,
    seenAt: id => seen[id] || 0,
    markSeen: id => { seen[id] = Date.now(); }
  });
  selector.render();
  assert.ok(actionDot(tabOf(mount, 'shift_b')), 'до просмотра точка есть');

  assert.equal(selector.switchTo('shift_b'), true);
  assert.equal(selector.switchTo('shift_a'), true);
  assert.equal(actionDot(tabOf(mount, 'shift_b')), null, 'после просмотра точка погасла');

  actions.shift_b = Date.now() + 5000;
  selector.refreshBadges();
  assert.ok(actionDot(tabOf(mount, 'shift_b')), 'новое действие снова поднимает точку');
});

test('без колбэков полоса работает как раньше: точек нет', () => {
  const { mount, selector } = setup({ rows: [shiftA, shiftB], active: 'shift_a' });
  selector.render();
  assert.equal(actionDot(tabOf(mount, 'shift_b')), null);
  assert.equal(actionDot(tabOf(mount, 'shift_a')), null);
});

test('отметка просмотра не мешает прежним бейджам pending и closing', () => {
  const contexts = {
    shift_a: { shiftId: 'shift_a', revisions: { shift: 3 }, badge: { pending: 2, closing: false, conflict: false } },
    shift_b: { shiftId: 'shift_b', revisions: { shift: 5 }, badge: { pending: 0, closing: true, conflict: false } }
  };
  const { mount, selector } = setup({
    rows: [shiftA, shiftB], contexts, active: 'shift_a',
    lastActionAt: () => 5000,
    seenAt: () => 0,
    markSeen: () => {}
  });
  selector.render();
  assert.match(tabOf(mount, 'shift_a').textContent, /2/, 'pending своей смены остался');
  assert.match(tabOf(mount, 'shift_b').textContent, /закрывается/, 'closing остался');
  assert.ok(actionDot(tabOf(mount, 'shift_b')), 'точка добавлена рядом с прежними бейджами');
});
