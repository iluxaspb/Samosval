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

function loadSheet(cycleMinutes) {
  const calls = [];
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
    state: { objects: [{ id: 'object_1', name: 'Объект' }], users: [] },
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
  return { button, calls };
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
