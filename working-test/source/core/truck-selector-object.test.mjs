// Окно выбора самосвалов называет объект выбранной смены.
//
// Владелец (28.11.2026): при нескольких открытых сменах в окне «Выбор
// самосвалов» не видно, на какую линию добавляется машина. Название объекта
// должно быть сверху модалки.
//
// Проверяем фактический 11-truck-selector.js сборки: имя берётся из снимка
// смены, при его отсутствии — из базы объектов по objectId, а без смены
// строка скрыта.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('./', import.meta.url));
const file = here + '11-truck-selector.js';
const shell = readFileSync(new URL('../shell.html', import.meta.url), 'utf8');

class FakeElement {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.classList = { add() {}, remove() {} };
  }
}

function load(state) {
  const elements = {
    truckSearchInput: new FakeElement('truckSearchInput'),
    selectorListContainer: new FakeElement('selectorListContainer'),
    selectorModal: new FakeElement('selectorModal'),
    selectorObjectName: new FakeElement('selectorObjectName'),
    selectorObjectValue: new FakeElement('selectorObjectValue')
  };
  const sandbox = {
    console,
    state,
    document: { getElementById: id => elements[id] || null },
    requireEdit: () => true,
    getActiveLineIds: () => [],
    hasPermission: () => true,
    escapeHtml: value => String(value == null ? '' : value),
    renderRussianPlate: value => String(value == null ? '' : value)
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInContext(readFileSync(file, 'utf8'), vm.createContext(sandbox), { filename: file });
  return { sandbox, elements };
}

test('в окне выбора сверху видно объект выбранной смены', () => {
  const { sandbox, elements } = load({
    shift: { id: 'shift_a', objectId: 'obj_1', objectName: 'Киевское шоссе ТР-13' },
    objects: [{ id: 'obj_1', name: 'Киевское шоссе ТР-13' }],
    trucks: []
  });
  sandbox.openSelectorModal();
  assert.equal(elements.selectorObjectName.hidden, false, 'строка объекта показана');
  assert.equal(elements.selectorObjectValue.textContent, 'Киевское шоссе ТР-13');
});

test('без имени в снимке объект берётся из базы по objectId', () => {
  const { sandbox, elements } = load({
    shift: { id: 'shift_a', objectId: 'obj_2' },
    objects: [{ id: 'obj_2', name: 'Николаевский проезд' }],
    trucks: []
  });
  sandbox.openSelectorModal();
  assert.equal(elements.selectorObjectName.hidden, false);
  assert.equal(elements.selectorObjectValue.textContent, 'Николаевский проезд');
});

test('если объект не определён, строка не показывается', () => {
  const { sandbox, elements } = load({
    shift: { id: 'shift_a', objectId: 'obj_missing' },
    objects: [],
    trucks: []
  });
  sandbox.openSelectorModal();
  assert.equal(elements.selectorObjectName.hidden, true, 'пустая подпись не занимает место');
  assert.equal(elements.selectorObjectValue.textContent, '');
});

test('строка объекта есть в разметке окна выбора над поиском', () => {
  assert.match(shell, /id="selectorModal"[\s\S]*?id="selectorObjectName"/);
  assert.match(shell, /id="selectorObjectName"[\s\S]*?id="truckSearchInput"/,
    'название объекта выше поля поиска, то есть сверху модалки');
});
