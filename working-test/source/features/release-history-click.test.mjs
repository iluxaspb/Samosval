import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Нажатие на номер версии должно открывать историю изменений. Номер версии
// показан в двух местах — на экране входа и в шапке приложения, — и раньше
// кнопкой становился только первый найденный элемент. После входа нажатие на
// версию в шапке ничего не делало. Тест поднимает модуль в маленьком DOM и
// проверяет каждый номер версии отдельно.

const source = readFileSync(new URL('./release-history.js', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../shell.html', import.meta.url), 'utf8');

function element(tag, extra = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    className: '',
    id: '',
    type: '',
    title: '',
    textContent: '',
    disabled: false,
    children: [],
    listeners: {},
    attrs: {},
    focus() {},
    close() { this.open = false; this.listeners.close?.forEach((fn) => fn()); },
    showModal() { this.open = true; },
    remove() { this.removed = true; },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); return node; },
    replaceWith(node) { this.replacedWith = node; },
    click() { this.listeners.click?.forEach((fn) => fn()); },
    ...extra,
  };
  return node;
}

function boot({ versionTexts, allowed = true }) {
  const labels = versionTexts.map((text) => element('span', { textContent: text, title: 'История изменений' }));
  const dialogs = [];
  const document = {
    querySelectorAll(selector) {
      if (selector === '.version-text') return labels;
      return [];
    },
    querySelector(selector) {
      if (selector === 'meta[name="working-test-version"]') return { content: '9.9.9' };
      return null;
    },
    getElementById(id) { return dialogs.find((d) => d.id === id && !d.removed) || null; },
    createElement(tag) {
      const node = element(tag);
      if (tag === 'dialog') dialogs.push(node);
      return node;
    },
    head: element('head'),
    body: element('body', { append(node) { this.children.push(node); } }),
  };
  const context = vm.createContext({
    window: {},
    document,
    canViewReleaseHistory: () => allowed,
    console,
  });
  vm.runInContext(source, context, { filename: 'release-history.js' });
  return { labels, dialogs };
}

test('в приложении два номера версии: экран входа и шапка', () => {
  const ids = [...shell.matchAll(/class="version-text[^"]*"/g)];
  assert.ok(ids.length >= 2, 'ожидались номер версии на экране входа и в шапке, найдено ' + ids.length);
  assert.match(shell, /id="authVersionText"/, 'номер версии на экране входа');
  assert.match(shell, /id="mainHeader"[\s\S]*class="version-text"/, 'номер версии в шапке');
});

test('каждый номер версии становится кнопкой с обработчиком истории', () => {
  const { labels, dialogs } = boot({ versionTexts: ['Версия: 9.9.9', 'Версия: 9.9.9'] });
  for (const [index, label] of labels.entries()) {
    const button = label.replacedWith;
    assert.ok(button, 'номер версии ' + index + ' должен быть заменён кнопкой');
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.textContent, 'Версия: 9.9.9');
    assert.equal(button.attrs['aria-haspopup'], 'dialog');
    assert.equal(button.disabled, false);
    button.click();
    assert.equal(dialogs.length, index + 1, 'нажатие на номер версии ' + index + ' открывает историю');
    assert.equal(dialogs[index].open, true);
    dialogs[index].close();
    assert.equal(dialogs[index].removed, true, 'история закрывается');
  }
});

test('без права на историю кнопка выключена и ничего не открывает', () => {
  const { labels, dialogs } = boot({ versionTexts: ['Версия: 9.9.9'], allowed: false });
  const button = labels[0].replacedWith;
  assert.equal(button.disabled, true);
  assert.equal(button.title, 'Номер сборки');
  button.click();
  assert.equal(dialogs.length, 0);
});

test('в истории первой идёт текущая версия канала', () => {
  const version = JSON.parse(
    JSON.stringify(/window\.WORKING_TEST_RELEASE=\{[^}]*version:'([^']+)'/.exec(source)[1]),
  );
  const first = /const releases=\[\s*\{version:'([^']+)'/.exec(source)[1];
  assert.equal(first, version, 'первая запись истории должна совпадать с версией канала');
  assert.match(shell, new RegExp('Версия: ' + version.replace(/\./g, '\\.')));
});
