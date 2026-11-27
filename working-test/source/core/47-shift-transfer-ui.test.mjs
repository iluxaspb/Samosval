// Крупное подтверждение перевода и блок «Рейсы, оставшиеся в прежней смене»
// (47-shift-transfer-ui.js) — контракт design §10.2.
//
// Проверяем тот самый classic script, который уходит в сборку: файл грузится в
// vm вместе с 46-detached-trips.js (модуль использует его через globalThis),
// DOM передаётся фейковый, транспорт — шпион, который считает вызовы.
//
// Запуск: node --test working-test/source/core/47-shift-transfer-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('./', import.meta.url));
const file = here + '47-shift-transfer-ui.js';
const source = readFileSync(file, 'utf8');
const detachedSource = readFileSync(here + '46-detached-trips.js', 'utf8');
const sandbox = { console, structuredClone };
const context = vm.createContext(sandbox);
vm.runInContext(detachedSource, context, { filename: here + '46-detached-trips.js' });
vm.runInContext(source, context, { filename: file });
const api = sandbox.WorkingTestShiftTransferUi || {};

// Фейковый DOM: ровно те операции, которые нужны блоку.
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
    this.disabled = false;
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
  dispatch(type, event) { return Promise.all((this.listeners[type] || []).map(handler => handler(event))); }
  all(className) {
    return this.children.filter(child => String(child.className).split(/\s+/).includes(className));
  }
}

function makeDoc() {
  return { createElement: tag => new FakeElement(tag) };
}

const DAY = {
  shiftId: 'shift_a', state: 'active', objectId: 'object_1', objectName: 'Невский проспект',
  workDate: '2026-11-27', shiftType: 'day'
};
const NIGHT = {
  shiftId: 'shift_b', state: 'active', objectId: 'object_1', objectName: 'Невский проспект',
  workDate: '2026-11-27', shiftType: 'night'
};
const TRIP = {
  sourceShiftId: 'shift_a',
  destinationShiftId: 'shift_b',
  cycleId: 'cycle_1',
  truckId: 'truck_1',
  stage: 'load',
  cycleRevision: 4,
  status: 'open',
  sourceShift: { objectId: 'object_1', objectName: 'Невский проспект', workDate: '2026-11-27', shiftType: 'day' },
  destinationShift: { objectId: 'object_1', objectName: 'Невский проспект', workDate: '2026-11-27', shiftType: 'night' }
};

function makeStore(options = {}) {
  const contexts = new Map([
    ['shift_a', {
      shift: DAY,
      revisions: { shift: options.sourceRevision ?? 7 },
      snapshot: { statuses: [{ id: 'truck_1', statusRevision: 3, cycleRevision: 5, ttnRevision: 2 }] }
    }],
    ['shift_b', {
      shift: NIGHT,
      revisions: { shift: options.destinationRevision ?? 9 },
      snapshot: { statuses: [] }
    }]
  ]);
  if (options.hideSource) contexts.delete('shift_a');
  if (options.hideDestination) contexts.delete('shift_b');
  const trips = options.trips ?? [TRIP];
  return {
    activeShiftId: () => options.activeShiftId ?? 'shift_b',
    context: id => contexts.has(id) ? contexts.get(id) : null,
    detachedTripsFor: id => trips.filter(trip => trip.sourceShiftId === id || trip.destinationShiftId === id)
  };
}

function spyTransport(overrides = {}) {
  const calls = [];
  const transport = {
    calls,
    addTruck: async input => { calls.push({ method: 'addTruck', input }); return overrides.addTruck ?? { ok: true, result: {} }; },
    forceTransferTruck: async input => { calls.push({ method: 'forceTransferTruck', input }); return overrides.forceTransferTruck ?? { ok: true, result: {} }; },
    completeDetachedTrip: async input => { calls.push({ method: 'completeDetachedTrip', input }); return overrides.completeDetachedTrip ?? { ok: true, result: {} }; },
    readShiftSnapshot: async input => { calls.push({ method: 'readShiftSnapshot', input }); return overrides.readShiftSnapshot ?? { ok: true }; }
  };
  return transport;
}

function makeUi(options = {}) {
  const mount = new FakeElement('div');
  const changes = [];
  const notices = [];
  const dialogs = [];
  const confirmAnswer = options.confirmAnswer !== false;
  const transport = options.transport || spyTransport();
  const ui = api.createShiftTransferUi({
    store: options.store || makeStore(),
    transport,
    doc: makeDoc(),
    mount,
    confirm: async (title, message, opts) => {
      dialogs.push({ title, message, opts });
      return confirmAnswer;
    },
    notify: (message, isError) => notices.push({ message, isError }),
    truckLabel: id => id === 'truck_1' ? 'КАМАЗ 123' : '',
    objectLabel: id => id === 'object_1' ? 'Невский проспект' : '',
    describeError: () => '',
    online: () => options.online !== false,
    rights: options.rights || {
      edit_line: true, manage_trucks: true, force_transfer_truck: true,
      action_arrive: true, action_load: true, action_ttn: true
    },
    forceTransferAllowed: options.forceTransferAllowed || (() => true),
    onChange: () => changes.push('change'),
    now: () => 1700000000000
  });
  return { ui, mount, changes, notices, dialogs, transport };
}

const occupied = {
  truckId: 'truck_1',
  sourceShiftId: 'shift_a',
  details: {
    truckId: 'truck_1', sourceShiftId: 'shift_a', objectId: 'object_1',
    workDate: '2026-11-27', shiftType: 'day', stage: 'load'
  }
};

test('модуль публикует интерфейс и не трогает document/fetch напрямую', () => {
  assert.equal(typeof api.createShiftTransferUi, 'function', 'глобальный контракт WorkingTestShiftTransferUi');
  const ui = api.createShiftTransferUi({});
  for (const name of ['describeForceTransfer', 'forceTransfer', 'addTruckToShift', 'describeDetached', 'completeDetached', 'render']) {
    assert.equal(typeof ui[name], 'function', name);
  }
  assert.doesNotMatch(source, /\bdocument\./, 'в модуле нет прямого document');
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest/, 'в модуле нет сети');
});

test('крупное подтверждение называет самосвал, откуда → куда, обе смены, стадию и последствия', () => {
  const { ui } = makeUi();
  const model = ui.describeForceTransfer(occupied);
  assert.equal(model.canConfirm, true);
  assert.equal(model.truckLabel, 'КАМАЗ 123');
  assert.equal(model.sourceLabel, 'Невский проспект · 27.11.2026 · День');
  assert.equal(model.destinationLabel, 'Невский проспект · 27.11.2026 · Ночь');
  assert.equal(model.stageLabel, 'Погрузка');
  assert.deepEqual(JSON.parse(JSON.stringify(model.lines)), [
    'Самосвал: КАМАЗ 123',
    'Из смены: Невский проспект · 27.11.2026 · День',
    'В смену: Невский проспект · 27.11.2026 · Ночь',
    'Незавершённый рейс: Погрузка'
  ]);
  assert.equal(model.consequences.length, 3);
  assert.match(model.consequences[0], /останется в прежней смене: Невский проспект · 27\.11\.2026 · День/);
  assert.match(model.consequences[1], /Новые рейсы.*Невский проспект · 27\.11\.2026 · Ночь/);
  assert.match(model.consequences[2], /Завершение старого рейса.*прежнюю смену/);
  assert.equal(model.irreversible, 'Отменить перевод будет нельзя.');
  assert.equal(model.title, 'Перевести самосвал в другую смену?');
  assert.equal(model.confirmLabel, 'Перевести самосвал');
  assert.equal(model.cancelLabel, 'Оставить как есть');
  assert.deepEqual(JSON.parse(JSON.stringify(model.revisions)), { source: 7, destination: 9, status: 3, cycle: 5, ttn: 2 });
  // HTML подтверждения содержит все четыре строки и необратимость.
  assert.match(model.message, /КАМАЗ 123/);
  assert.match(model.message, /Из смены:/);
  assert.match(model.message, /В смену:/);
  assert.match(model.message, /Отменить перевод будет нельзя\./);
});

test('подтверждение закрыто без права, без роли, офлайн и без известного CAS', () => {
  const noRight = makeUi({ rights: { edit_line: true, manage_trucks: true } }).ui.describeForceTransfer(occupied);
  assert.equal(noRight.canConfirm, false);
  assert.equal(noRight.blockedReason, 'forbidden');
  assert.ok(noRight.blockedMessage.length > 0);

  const noRole = makeUi({ forceTransferAllowed: () => false }).ui.describeForceTransfer(occupied);
  assert.equal(noRole.canConfirm, false, 'матрица прав без роли не открывает перевод (§6)');
  assert.equal(noRole.blockedReason, 'forbidden');

  const offline = makeUi({ online: false }).ui.describeForceTransfer(occupied);
  assert.equal(offline.canConfirm, false);
  assert.equal(offline.blockedReason, 'online-required');

  const noSource = makeUi({ store: makeStore({ hideSource: true }) }).ui.describeForceTransfer(occupied);
  assert.equal(noSource.canConfirm, false);
  assert.equal(noSource.blockedReason, 'revision-unknown', 'без ревизии прежней смены CAS выдумывать нельзя');
});

test('отмена подтверждения не отправляет перевод и не читает смены', async () => {
  const { ui, transport, changes, dialogs } = makeUi({ confirmAnswer: false });
  const result = await ui.forceTransfer(occupied);
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(dialogs.length, 1);
  // Безопасный default: фокус на отмене, Enter не подтверждает.
  assert.equal(dialogs[0].opts.focus, 'cancel');
  assert.equal(dialogs[0].opts.enterConfirms, false);
  assert.equal(dialogs[0].opts.variant, 'danger');
  assert.deepEqual(transport.calls, [], 'отмена не доходит до сервера');
  assert.deepEqual(changes, []);
});

test('подтверждение отправляет точный CAS двух смен и не переигрывает команду', async () => {
  const { ui, transport, changes, dialogs } = makeUi();
  const result = await ui.forceTransfer(occupied);
  assert.equal(result.ok, true);
  assert.equal(dialogs.length, 1);
  const calls = transport.calls.filter(call => call.method === 'forceTransferTruck');
  assert.equal(calls.length, 1);
  const input = calls[0].input;
  assert.equal(input.confirmTransfer, true);
  assert.equal(input.sourceShiftId, 'shift_a');
  assert.equal(input.destinationShiftId, 'shift_b');
  assert.equal(input.truckId, 'truck_1');
  assert.equal(input.expectedSourceShiftRevision, 7);
  assert.equal(input.expectedDestinationShiftRevision, 9);
  assert.equal(input.expectedStatusRevision, 3);
  assert.equal(input.expectedCycleRevision, 5);
  assert.equal(input.expectedTtnRevision, 2);
  assert.match(input.operationId, /^op_/);
  // Успешный перевод уже перечитал обе смены внутри транспорта: лишних
  // чтений по одной смене модуль не делает.
  assert.equal(transport.calls.filter(call => call.method === 'readShiftSnapshot').length, 0);
  assert.deepEqual(changes, ['change']);
});

test('конфликт CAS закрывает диалог, перечитывает обе смены и не повторяет перевод', async () => {
  const transport = spyTransport({
    forceTransferTruck: {
      ok: false,
      error: { code: 'revision-conflict', details: { expectedStatusRevision: 3, actualStatusRevision: 4 } }
    }
  });
  const { ui, changes, notices } = makeUi({ transport });
  const result = await ui.forceTransfer(occupied);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'revision-conflict');
  assert.match(result.message, /обновите экран и повторите/i);
  assert.equal(transport.calls.filter(call => call.method === 'forceTransferTruck').length, 1, 'повтор молча запрещён');
  const reads = transport.calls.filter(call => call.method === 'readShiftSnapshot').map(call => call.input.shiftId).sort();
  assert.deepEqual(reads, ['shift_a', 'shift_b'], 'обе смены перечитаны после конфликта');
  assert.deepEqual(changes, ['change']);
  assert.deepEqual(notices, [], 'сообщение покажет вызывающий экран, а не модуль');
});

test('добавление свободного самосвала идёт через v2-назначение и обновляет экран', async () => {
  const { ui, transport, changes } = makeUi({ store: makeStore({ activeShiftId: 'shift_b' }) });
  const result = await ui.addTruckToShift({ truckId: 'truck_1' });
  assert.equal(result.ok, true);
  const calls = transport.calls.filter(call => call.method === 'addTruck');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.shiftId, 'shift_b');
  assert.equal(calls[0].input.expectedShiftRevision, 9);
  assert.equal(transport.calls.filter(call => call.method === 'forceTransferTruck').length, 0);
  assert.deepEqual(changes, ['change']);
});

test('занятый самосвал без права перевода: предупреждение с исходной сменой и без обхода', async () => {
  const transport = spyTransport({
    addTruck: {
      ok: false,
      error: {
        code: 'truck-assigned-to-other-shift',
        details: { truckId: 'truck_1', sourceShiftId: 'shift_a', objectId: 'object_1', workDate: '2026-11-27', shiftType: 'day', stage: 'load' }
      }
    }
  });
  const { ui, notices, dialogs } = makeUi({
    transport,
    rights: { edit_line: true, manage_trucks: true, action_load: true }
  });
  const result = await ui.addTruckToShift({ truckId: 'truck_1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'truck-assigned-to-other-shift');
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /^Самосвал работает в другой активной смене: /);
  assert.match(notices[0].message, /Невский проспект · 27\.11\.2026 · День/);
  assert.equal(notices[0].isError, true);
  assert.deepEqual(dialogs, [], 'кнопки обхода нет');
  assert.equal(transport.calls.filter(call => call.method === 'forceTransferTruck').length, 0);
});

test('занятый самосвал с правом перевода открывает крупный confirm и переводит в выбранную смену', async () => {
  const transport = spyTransport({
    addTruck: {
      ok: false,
      error: {
        code: 'truck-assigned-to-other-shift',
        details: { truckId: 'truck_1', sourceShiftId: 'shift_a', objectId: 'object_1', workDate: '2026-11-27', shiftType: 'day', stage: 'load' }
      }
    }
  });
  const { ui, dialogs } = makeUi({ transport });
  const result = await ui.addTruckToShift({ truckId: 'truck_1' });
  assert.equal(result.ok, true);
  assert.equal(dialogs.length, 1);
  const input = transport.calls.find(call => call.method === 'forceTransferTruck').input;
  assert.equal(input.sourceShiftId, 'shift_a');
  assert.equal(input.destinationShiftId, 'shift_b', 'перевод идёт в выбранную смену');
});

test('занятый самосвал: неизвестный контекст прежней смены — честная причина вместо команды без CAS', async () => {
  const transport = spyTransport({
    addTruck: {
      ok: false,
      error: { code: 'truck-assigned-to-other-shift', details: { truckId: 'truck_1', sourceShiftId: 'shift_a' } }
    }
  });
  const { ui, notices, dialogs } = makeUi({ transport, store: makeStore({ hideSource: true }) });
  const result = await ui.addTruckToShift({ truckId: 'truck_1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'source-shift-unavailable');
  assert.match(result.message, /Прежняя смена не загружена/);
  assert.equal(notices.length, 1);
  assert.deepEqual(dialogs, []);
  assert.equal(transport.calls.filter(call => call.method === 'forceTransferTruck').length, 0);
});

test('блок оставшихся рейсов: подпись исходной смены, стадия и предупреждение', () => {
  const { ui } = makeUi();
  const rows = ui.describeDetached('shift_b');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.sourceLabel, 'Невский проспект · 2026-11-27 · День · Погрузка');
  assert.equal(row.stageLabel, 'Погрузка');
  assert.equal(row.warning, 'Действие будет записано в исходную смену: ' + row.sourceLabel);
  assert.equal(row.actionLabel, 'Завершить в прежней смене');
  assert.equal(row.canComplete, true);
  assert.equal(row.truckLabel, 'КАМАЗ 123');
  assert.equal(row.cycleId, 'cycle_1');
});

test('блок read-only офлайн, без права стадии и без ревизии второй смены', () => {
  const offline = makeUi({ online: false }).ui.describeDetached('shift_a');
  assert.equal(offline[0].canComplete, false);
  assert.match(offline[0].reasonText, /Нет сети/);

  const noRight = makeUi({ rights: { edit_line: true, manage_trucks: true } }).ui.describeDetached('shift_a');
  assert.equal(noRight[0].canComplete, false);
  assert.equal(noRight[0].reason, 'forbidden');

  const noDestination = makeUi({ store: makeStore({ hideDestination: true }) }).ui.describeDetached('shift_a');
  assert.equal(noDestination[0].canComplete, false);
  assert.equal(noDestination[0].reason, 'other-shift-unavailable');
  assert.match(noDestination[0].reasonText, /Данные второй смены/);
});

test('завершение рейса офлайн не доходит до сервера', async () => {
  const { ui, transport } = makeUi({ online: false });
  const result = await ui.completeDetached({ trip: TRIP });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'online-required');
  assert.deepEqual(transport.calls, []);
});

test('завершение рейса отправляет cross-shift CAS и записывает момент подтверждения', async () => {
  const { ui, transport, changes } = makeUi();
  const result = await ui.completeDetached({ trip: TRIP });
  assert.equal(result.ok, true);
  const calls = transport.calls.filter(call => call.method === 'completeDetachedTrip');
  assert.equal(calls.length, 1);
  const input = calls[0].input;
  assert.equal(input.sourceShiftId, 'shift_a');
  assert.equal(input.destinationShiftId, 'shift_b');
  assert.equal(input.cycleId, 'cycle_1');
  assert.equal(input.truckId, 'truck_1');
  assert.equal(input.type, 'load');
  assert.equal(input.expectedSourceShiftRevision, 7);
  assert.equal(input.expectedDestinationShiftRevision, 9);
  assert.equal(input.expectedDetachedCycleRevision, 4);
  assert.equal(input.fields.createdAt, 1700000000000);
  assert.equal('collect' in input.fields, false, 'модуль не выдумывает факт получения ТТН');
  assert.deepEqual(changes, ['change']);
});

test('конфликт завершения рейса не повторяется молча и перечитывает обе смены', async () => {
  const transport = spyTransport({
    completeDetachedTrip: { ok: false, error: { code: 'revision-conflict', details: { actualDetachedCycleRevision: 5 } } }
  });
  const { ui, changes } = makeUi({ transport });
  const result = await ui.completeDetached({ trip: TRIP });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'revision-conflict');
  assert.equal(transport.calls.filter(call => call.method === 'completeDetachedTrip').length, 1);
  const reads = transport.calls.filter(call => call.method === 'readShiftSnapshot').map(call => call.input.shiftId).sort();
  assert.deepEqual(reads, ['shift_a', 'shift_b']);
  assert.deepEqual(changes, ['change']);
});

test('блок на экране: пусто — скрыт, есть рейс — карточка с действием и обновление после успеха', async () => {
  const store = makeStore({ trips: [] });
  const { ui, mount, notices } = makeUi({ store });
  assert.equal(ui.render(), 0);
  assert.equal(mount.hidden, true);

  // Тот же store получает рейс: блок появляется без перезагрузки.
  store.detachedTripsFor = id => [TRIP].filter(trip => trip.sourceShiftId === id || trip.destinationShiftId === id);
  assert.equal(ui.render(), 1);
  assert.equal(mount.hidden, false);
  assert.equal(mount.all('detached-trips-title')[0].textContent, 'Рейсы, оставшиеся в прежней смене');
  const cards = mount.all('detached-trip-card');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].dataset.cycleId, 'cycle_1');
  assert.equal(cards[0].all('detached-trip-source')[0].textContent, 'Невский проспект · 2026-11-27 · День · Погрузка');
  assert.match(cards[0].all('detached-trip-warning')[0].textContent, /^Действие будет записано в исходную смену: /);
  const button = cards[0].all('detached-trip-action')[0];
  assert.equal(button.textContent, 'Завершить в прежней смене');
  assert.equal(button.disabled, false);

  // Нажатие завершает рейс; после успеха блок исчезает, потому что данные
  // перечитаны и рейса больше нет.
  store.detachedTripsFor = () => [];
  await button.dispatch('click');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].message, 'Рейс завершён в прежней смене');
  assert.equal(ui.render(), 0);
  assert.equal(mount.hidden, true);
});

test('блок офлайн: действие выключено и показана причина', () => {
  const { ui, mount } = makeUi({ online: false });
  ui.render();
  const button = mount.all('detached-trip-card')[0].all('detached-trip-action')[0];
  assert.equal(button.disabled, true);
  assert.match(mount.all('detached-trip-card')[0].all('detached-trip-reason')[0].textContent, /Нет сети/);
  assert.equal(mount.all('detached-trips-note').length, 1);
});
