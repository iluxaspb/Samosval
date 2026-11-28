import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Лист управления сменой (core/19-navigation.js) передаёт `cycleMinutes` в
// createShift. Сервер принимает только safe integer в 15…10080
// (server/src/shift-members-v2.mjs requireCycleMinutes), поэтому дробное
// значение из старых настроек или правки localStorage обязано округляться до
// отправки, иначе создание смены снова падает с invalid-command/cycleMinutes.
const here = fileURLToPath(new URL('./', import.meta.url));

class FakeElement {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = {};
    this.classList = { list: new Set(), add: name => this.classList.list.add(name), remove: name => this.classList.list.delete(name), contains: name => this.classList.list.has(name) };
    this.style = {}; this.dataset = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false;
  }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); }
  setAttribute() {}
  querySelectorAll() { return []; }
}

function loadSheet(cycleMinutes, options = {}) {
  const calls = [];
  const objectSaves = [];
  const ids = {
    shiftManagementModal: new FakeElement('div'),
    shiftManagementBody: new FakeElement('div'),
    shiftManagementBtn: new FakeElement('button'),
    shiftStrip: new FakeElement('div')
  };
  const bridge = {
    store: {
      activeShiftId: () => null,
      visibleShifts: () => [],
      context: () => null
    },
    transport: {},
    handle: {}
  };
  const sandbox = {
    console,
    document: {
      getElementById: id => ids[id] || null,
      createElement: tag => new FakeElement(tag),
      querySelectorAll: () => []
    },
    state: { objects: options.objects || [{ id: 'object_1', name: 'Объект' }], users: [] },
    nasSaveRecord: async (kind, id, data, revision) => {
      objectSaves.push({ kind, id, data, revision });
      return { result: { id: 'object_new' } };
    },
    settings: { cycleMinutes },
    nasV2Shifts: () => bridge,
    WorkingTestShiftSelector: { createShiftSelector: () => ({ render() {}, switchTo() { return true; }, refreshBadges() {}, activeShiftId: () => null, destroy() {} }) },
    WorkingTestShiftManagement: {
      createShiftManagement: () => ({
        canCreate: () => true,
        canManageMembers: () => true,
        describe: () => '',
        createShift: input => { calls.push(input); return Promise.resolve({ ok: true }); }
      })
    },
    hasPermission: () => true,
    hasTabAccess: () => true,
    renderAll: () => {},
    updateSyncUI: () => {},
    offlineReplayJournal: () => {},
    sanitizeName: value => value,
    setInterval: () => 1,
    setTimeout: () => 1,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { onLine: true }
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  const file = here + '19-navigation.js';
  vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
  sandbox.openShiftManagement();
  const body = ids.shiftManagementBody;
  const createBox = body.children.find(child => child.className === 'shift-management-section');
  const button = createBox.children.find(child => child.tagName === 'button');
  const objectSelect = createBox.children.find(child => child.tagName === 'select');
  const newObjectInput = createBox.children.find(child => child.tagName === 'input' && child.type === 'text');
  return { button, calls, objectSaves, objectSelect, newObjectInput, createBox };
}

test('создание смены отправляет целое cycleMinutes в границах 15…10080', async () => {
  const { button, calls } = loadSheet(17.5);
  await button.listeners.click[0]();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cycleMinutes, 18, 'дробное значение округляется, а не уходит как 17.5');
  assert.ok(Number.isSafeInteger(calls[0].cycleMinutes), 'сервер принимает только safe integer');
  assert.ok(calls[0].cycleMinutes >= 15 && calls[0].cycleMinutes <= 10080);
});

test('границы цикла сохраняются, а мусор в настройках не ломает тело', async () => {
  for (const [configured, expected] of [[5, 15], [999999, 10080], ['30', 30], [undefined, 15], ['abc', 15], [15.4, 15]]) {
    const { button, calls } = loadSheet(configured);
    await button.listeners.click[0]();
    assert.equal(calls[0].cycleMinutes, expected, 'cycleMinutes для ' + String(configured));
    assert.ok(Number.isSafeInteger(calls[0].cycleMinutes));
  }
});

// Жалоба владельца (28.11.2026): когда смены уже открыты, добавить смену на
// объект, которого нет в списке, было нечем — пункта «Новый объект» не было.
test('в списке объектов есть пункт «Новый объект» для права manage_objects', () => {
  const { objectSelect } = loadSheet(15);
  const labels = objectSelect.children.map(option => option.textContent);
  assert.ok(labels.some(label => String(label).includes('Новый объект')), 'пункт создания объекта на месте');
});

test('создание смены на новый объект сначала сохраняет объект, затем смену', async () => {
  const { button, calls, objectSaves, objectSelect, newObjectInput } = loadSheet(15);
  objectSelect.value = '__new_object__';
  newObjectInput.value = '  Киевское шоссе  ';
  await button.listeners.click[0]();
  assert.equal(objectSaves.length, 1, 'объект сохраняется в базу один раз');
  assert.equal(objectSaves[0].kind, 'object');
  assert.equal(objectSaves[0].data.name, 'Киевское шоссе', 'имя обрезается от пробелов');
  assert.equal(objectSaves[0].revision, 0, 'новый объект создаётся без ревизии');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].objectId, 'object_new', 'смена создаётся на только что созданный объект');
  assert.equal(newObjectInput.value, '', 'поле имени очищается после создания');
});

test('пустое имя нового объекта не создаёт ни объекта, ни смены', async () => {
  const { button, calls, objectSaves, objectSelect, newObjectInput } = loadSheet(15);
  objectSelect.value = '__new_object__';
  newObjectInput.value = '   ';
  await button.listeners.click[0]();
  assert.equal(objectSaves.length, 0);
  assert.equal(calls.length, 0, 'смена без объекта не отправляется');
});
