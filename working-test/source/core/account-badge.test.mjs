// Бейдж пользователя в шапке: администратору — окно аккаунта, остальным — выход.
//
// Тест читает фактические исходники сборки: обработчик бейджа в
// core/05-authentication.js, саму оболочку shell.html и модуль отладочной
// смены аккаунта. Проверяется, что простая роль не получает отладочный вход,
// а администратор не теряет обычный выход.
//
// Запуск: node --test working-test/source/core/account-badge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('./', import.meta.url));
const auth = readFileSync(here + '05-authentication.js', 'utf8');
const shell = readFileSync(here + '../shell.html', 'utf8');
const debug = readFileSync(here + '../features/debug-accounts.js', 'utf8');

test('бейдж в шапке вызывает обработчик, а не выход напрямую', () => {
  const badge = shell.match(/id="userBadgeLabel"[^>]*onclick="([^"]+)"/);
  assert.ok(badge, 'бейдж есть в оболочке');
  assert.equal(badge[1], 'handleUserBadgeClick()', 'нажатие идёт через общий обработчик');
  assert.equal((shell.match(/onclick="handleLogout\(\)"/g) || []).length >= 1, true, 'обычный выход остался на экранах доступа');
});

test('администратор получает окно аккаунта, остальные — прежний выход', () => {
  const start = auth.indexOf('function handleUserBadgeClick()');
  assert.ok(start >= 0, 'обработчик бейджа объявлен');
  const body = auth.slice(start, auth.indexOf('\n  }', start));
  assert.match(body, /typeof window\.openDebugAccounts === 'function'/, 'окно открывается только если модуль загружен');
  assert.match(body, /canAdmin\(\)/, 'окно открывается только администратору');
  assert.match(body, /handleLogout\(\)/, 'иначе выполняется обычный выход');
  assert.ok(body.indexOf('canAdmin()') < body.indexOf('handleLogout()'), 'проверка администратора идёт до выхода');
});

test('выход и отладочная смена используют одно завершение сессии', () => {
  assert.match(auth, /async function wtEndSessionQuietly\(\)/, 'завершение сессии вынесено отдельно');
  const logout = auth.slice(auth.indexOf('async function handleLogout()'));
  assert.match(logout.slice(0, 400), /await wtEndSessionQuietly\(\);/, 'обычный выход использует тот же код');
  assert.match(debug, /wtEndSessionQuietly|previousRefreshToken/, 'смена аккаунта гасит прежнюю сессию');
});

test('окно аккаунта есть в оболочке и содержит оба действия', () => {
  assert.match(shell, /id="accountModal"/, 'окно аккаунта объявлено');
  assert.match(shell, /id="accountModal"[\s\S]*?handleLogout\(\)/, 'в окне есть обычный выход');
  assert.match(shell, /id="debugAccountsList"/, 'в окне есть список ролей');
  assert.match(shell, /id="debugAccountPassword"/, 'в окне есть поле пароля тестовых учёток');
  assert.match(shell, /id="debugAccountSavePassword"/, 'в окне есть галочка сохранения пароля');
  assert.match(shell, /id="debugAccountForget"/, 'в окне есть кнопка «Забыть пароль»');
});

test('модуль отладочной смены подключён к сборке', () => {
  const modules = JSON.parse(readFileSync(here + '../../modules.json', 'utf8'));
  const entry = modules.modules.find(m => m.name === 'debug-accounts');
  assert.ok(entry, 'модуль зарегистрирован в modules.json');
  assert.deepEqual(entry.sources, ['features/debug-accounts.js']);
  assert.match(shell, /<!-- TEST-MODULE:debug-accounts -->/, 'место подключения есть в оболочке');
});
