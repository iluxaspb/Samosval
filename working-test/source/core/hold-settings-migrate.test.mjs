// Регрессионный тест единого ключа настроек удержаний (reset-hold).
// Раньше настройка holdResetCycle жила в отдельном ключе
// 'working-test-settings-test347', а остальные настройки шелла — в
// 'working-test-settings'. Теперь ключ один, а при первом чтении значение
// переносится из старого ключа, и старый ключ удаляется.
// Запуск: node --test working-test/source/core/hold-settings-migrate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, '..', 'features', 'reset-hold.js');
const code = readFileSync(sourcePath, 'utf8');

const NEW_KEY = 'working-test-settings';
const LEGACY_KEY = 'working-test-settings-test347';

// Минимальный localStorage в памяти: reset-hold.js трогает только его до
// первого обращения к DOM (IIFE читает настройки в начале исполнения).
function makeStorage(initial) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
  };
}

function runResetHold(storage) {
  const sandbox = {
    localStorage: storage,
    window: { addEventListener() {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({ style: {}, remove() {} }),
      addEventListener() {},
      head: { appendChild() {} },
    },
    navigator: {},
    setInterval: () => 0,
    setTimeout: () => 0,
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: sourcePath });
  return sandbox;
}

test('исходник reset-hold.js упоминает старый ключ только в константе миграции', () => {
  const legacyLiterals = code.split(LEGACY_KEY);
  // Литерал допустим ровно один раз — в объявлении константы LEGACY_KEY.
  assert.equal(legacyLiterals.length, 2, 'ключ test347 должен использоваться только как константа');
});

test('миграция: значение из старого ключа переносится в новый, старый удаляется', () => {
  const storage = makeStorage({
    [NEW_KEY]: '{}',
    [LEGACY_KEY]: JSON.stringify({ holdResetCycle: 2.5 }),
  });
  runResetHold(storage);
  const migrated = JSON.parse(storage.getItem(NEW_KEY));
  assert.equal(migrated.holdResetCycle, 2.5, 'значение удержания перенесено в общий ключ');
  assert.equal(storage.getItem(LEGACY_KEY), null, 'старый ключ удалён после миграции');
});

test('без старого ключа значение по умолчанию пишется сразу в новый ключ', () => {
  const storage = makeStorage({ [NEW_KEY]: '{}' });
  runResetHold(storage);
  const stored = JSON.parse(storage.getItem(NEW_KEY));
  assert.equal(stored.holdResetCycle, 0.5, 'значение по умолчанию 0.5');
  assert.equal(storage.getItem(LEGACY_KEY), null, 'старого ключа нет и после инициализации');
});

test('существующее значение в новом ключе не перезаписывается дефолтом', () => {
  const storage = makeStorage({
    [NEW_KEY]: JSON.stringify({ holdResetCycle: 1.5 }),
    [LEGACY_KEY]: JSON.stringify({ holdResetCycle: 9 }),
  });
  runResetHold(storage);
  const stored = JSON.parse(storage.getItem(NEW_KEY));
  assert.equal(stored.holdResetCycle, 1.5, 'новый ключ приоритетнее старого');
  assert.equal(storage.getItem(LEGACY_KEY), null, 'старый ключ всё равно удаляется');
});

test('повреждённый старый ключ не ломает инициализацию', () => {
  const storage = makeStorage({
    [NEW_KEY]: '{bad json',
    [LEGACY_KEY]: '{bad json',
  });
  runResetHold(storage);
  const stored = JSON.parse(storage.getItem(NEW_KEY));
  assert.equal(stored.holdResetCycle, 0.5, 'после сбоя разбора применяется значение по умолчанию');
  assert.equal(storage.getItem(LEGACY_KEY), null, 'повреждённый старый ключ удалён');
});
