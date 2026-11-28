// Отладочная смена аккаунта (features/debug-accounts.js).
//
// Проверяем тот самый classic script, который уходит в сборку: файл грузится в
// vm без сети и DOM, зависимости передаются фабрике явно. Проверяется
// фактическое поведение — какие адреса уходят на вход, в каком порядке
// гасится прежняя сессия, что происходит при неверном пароле и кто вообще
// может открыть окно.
//
// Запуск: node --test working-test/source/features/debug-accounts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('./', import.meta.url));
const source = readFileSync(here + 'debug-accounts.js', 'utf8');
const serverSeed = readFileSync(here + '../../..' + '/server/scripts/seed-debug-accounts.mjs', 'utf8');

const sandbox = { console };
const context = vm.createContext(sandbox);
vm.runInContext(source, context, { filename: here + 'debug-accounts.js' });
const api = sandbox.WorkingTestDebugAccounts;
const ROLE_ORDER = ['senior_foreman', 'foreman', 'master', 'lopater', 'viewer'];

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: key => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: key => { delete data[key]; }
  };
}

function harness(overrides = {}) {
  const calls = [];
  const storage = overrides.storage || memoryStorage();
  const deps = {
    storage,
    doc: null,
    isAdmin: () => true,
    currentProfile: () => ({ name: 'Илья', roleLabel: 'Администратор' }),
    previousRefreshToken: () => 'old-refresh',
    leavePresence: async () => calls.push('leave-presence'),
    login: async (email, password) => { calls.push(['login', email, password]); return { profile: { uid: 'x' }, accessToken: 'new-access', refreshToken: 'new-refresh' }; },
    snapshotSession: () => { calls.push('snapshot'); return { marker: 'admin-session' }; },
    restoreSession: async snapshot => calls.push(['restore', snapshot.marker]),
    applySession: async data => calls.push(['apply', data.profile.uid]),
    revokeRefreshToken: async token => calls.push(['revoke', token]),
    reload: () => calls.push('reload'),
    notify: (message, isError) => calls.push(['notify', message, isError]),
    ...overrides
  };
  return { deps, calls, storage, instance: api.createDebugAccounts(deps) };
}

test('список ролей совпадает с серверным скриптом тестовых учёток', () => {
  // Массивы и объекты из vm принадлежат другому realm: сравниваем значения,
  // приведённые к текущему realm, иначе deepStrictEqual ругается на прототип.
  assert.deepEqual(Array.from(api.ACCOUNTS, a => a.role), ROLE_ORDER, 'в окне ровно пять ролей в понятном порядке');
  const emails = Array.from(api.ACCOUNTS, a => a.email);
  for (const email of emails) {
    assert.ok(serverSeed.includes("'" + email + "'"), 'адрес ' + email + ' есть в seed-debug-accounts.mjs');
  }
  const seedEmails = [...serverSeed.matchAll(/email: '([^']+)'/g)].map(m => m[1]);
  assert.deepEqual([...seedEmails].sort(), [...emails].sort(), 'списки адресов на клиенте и сервере не расходятся');
});

test('смена аккаунта входит под выбранной ролью и только потом гасит прежнюю сессию', async () => {
  const { instance, calls } = harness();
  const result = await instance.switchTo('lopater', 'admin-pass');
  assert.equal(result.role, 'lopater');
  assert.equal(result.email, 'debug-lopater@debug.samosval.test');
  const loginIndex = calls.findIndex(call => Array.isArray(call) && call[0] === 'login');
  const revokeIndex = calls.findIndex(call => Array.isArray(call) && call[0] === 'revoke');
  assert.ok(loginIndex >= 0, 'вход выполнен');
  assert.equal(calls[loginIndex][1], 'debug-lopater@debug.samosval.test', 'вход под адресом выбранной роли');
  assert.equal(calls[loginIndex][2], 'admin-pass', 'пароль передан как есть');
  const applyIndex = calls.findIndex(call => Array.isArray(call) && call[0] === 'apply');
  assert.ok(applyIndex > loginIndex, 'новая сессия сохраняется после успешного входа');
  assert.ok(revokeIndex > applyIndex, 'прежняя сессия гасится только после сохранения новой');
  assert.equal(calls[revokeIndex][1], 'old-refresh', 'гасится именно прежний refresh-токен');
  assert.equal(calls[calls.length - 1], 'reload', 'после смены приложение перезагружается под новой ролью');
});

test('неверный пароль не выкидывает администратора: вход не выполнен, перезагрузки нет', async () => {
  const { instance, calls } = harness({ login: async () => { throw new Error('Неверная почта или пароль.'); } });
  await assert.rejects(instance.switchTo('viewer', 'wrong'), /Неверная почта или пароль/);
  assert.equal(calls.some(call => call === 'reload'), false, 'перезагрузки при ошибке нет');
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'revoke'), false, 'прежняя сессия не отозвана');
  assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'apply'), false, 'новая сессия не сохранена');
  assert.deepEqual(calls.find(call => Array.isArray(call) && call[0] === 'restore'), ['restore', 'admin-session'], 'админская сессия восстановлена из снимка');
});

test('без пароля вход не начинается, а с сохранённым паролем — начинается', async () => {
  const storage = memoryStorage();
  const first = harness({ storage });
  await assert.rejects(first.instance.switchTo('foreman', ''), /Введите пароль/);
  assert.equal(first.calls.some(call => Array.isArray(call) && call[0] === 'login'), false, 'без пароля вход не выполняется');

  assert.equal(first.instance.savePassword('admin-pass'), true, 'пароль сохраняется по галочке');
  assert.equal(storage.data[api.PASSWORD_KEY], 'admin-pass', 'ключ хранения — собственный ключ канала');
  const second = harness({ storage });
  assert.equal(second.instance.savedPassword(), 'admin-pass', 'сохранённый пароль читается в следующем окне');
  await second.instance.switchTo('foreman');
  const login = second.calls.find(call => Array.isArray(call) && call[0] === 'login');
  assert.equal(login[1], 'debug-foreman@debug.samosval.test', 'вход под прорабом');
  assert.equal(login[2], 'admin-pass', 'пароль взят из сохранённого');
});

test('«Забыть пароль» удаляет сохранённое значение', () => {
  const storage = memoryStorage();
  const { instance } = harness({ storage });
  instance.savePassword('admin-pass');
  instance.forgetPassword();
  assert.equal(instance.savedPassword(), '', 'после забывания пароля нет');
  assert.equal(Object.keys(storage.data).length, 0, 'ключ удалён из хранилища целиком');
});

test('смена аккаунта запрещена не администратору', async () => {
  const { instance, calls } = harness({ isAdmin: () => false });
  await assert.rejects(instance.switchTo('master', 'admin-pass'), /только администратору/);
  assert.equal(calls.length, 0, 'никаких входов и перезагрузок для обычной роли');
});

test('неизвестная роль и повторный запуск смены отклоняются', async () => {
  const { instance } = harness();
  await assert.rejects(instance.switchTo('admin', 'admin-pass'), /Неизвестная роль/);
  const slow = harness({ login: () => new Promise(resolve => setTimeout(() => resolve({ profile: { uid: 'x' }, accessToken: 'a', refreshToken: 'b' }), 50)) });
  const first = slow.instance.switchTo('viewer', 'admin-pass');
  await assert.rejects(slow.instance.switchTo('viewer', 'admin-pass'), /уже выполняется/);
  await first;
});
