// Регрессионный тест выбранной роли в заявках на регистрацию (04-subscriptions.js).
// Список заявок перестраивается через innerHTML при фоновых снапшотах
// users/requests (acceptRegistrationSnapshot), и select#req_role_* молча
// сбрасывался до viewer. Теперь: выбранная роль переживает перерисовку
// (значения select сохраняются/восстанавливаются по id заявки), а пока админ
// взаимодействует с блоком заявок (фокус/недавно изменённый выбор),
// фоновая перерисовка блока откладывается и повторяется таймером.
// Запуск: node --test tests/tabel-v2/registration-role-keep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const subs = readFileSync(join(here, '..', '..', 'working-test', 'source', 'core', '04-subscriptions.js'), 'utf8');

function functionBody(name) {
  const start = subs.indexOf('function ' + name);
  assert.ok(start >= 0, 'нет функции ' + name);
  let depth = 0, i = subs.indexOf('{', start), end = i;
  for (; i < subs.length; i++) {
    if (subs[i] === '{') depth++;
    else if (subs[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  return subs.slice(start, end);
}

test('исходник: значения select ролей переживают перерисовку блока заявок', () => {
  const body = functionBody('renderRegistrationRequests');
  assert.match(body, /saveRoleSelections\(/, 'выбранные роли сохраняются перед innerHTML');
  assert.match(body, /restoreRoleSelections\(/, 'выбранные роли восстанавливаются после innerHTML');
});

test('исходник: пока админ взаимодействует с блоком заявок, перерисовка откладывается', () => {
  const body = functionBody('renderRegistrationRequests');
  assert.match(body, /registrationRoleHoldActive\(\)/, 'есть предикат взаимодействия с блоком заявок');
  assert.match(body, /scheduleRenderRegistrationRequests\(\)/, 'отложенная перерисовка вместо сброса выбора');
});

// === Поведенческий прогон: реальный renderRegistrationRequests в песочнице vm.
function setup() {
  const timers = [];
  const renders = [];
  const fakeBtn = () => ({ onclick: null });
  const requestsListContainer = {
    innerHTML: '', contains: () => true, _cache: new Map(),
    querySelector(sel) {
      if (sel === '#refreshRegistrationRequestsBtn') return this._btn || (this._btn = fakeBtn());
      return null;
    },
    querySelectorAll() { return []; },
  };
  const pendingCount = { textContent: '' };
  const doc = {
    getElementById: id => (id === 'requestsListContainer' ? requestsListContainer : id === 'pendingCount' ? pendingCount : null),
    querySelectorAll: () => [],
    addEventListener() {},
    activeElement: null,
  };
  const state = {
    users: [{ id: 'req_1', email: 'new@b.c', status: 'pending', createdAt: 2 }],
    requests: [{ id: 'req_1', uid: 'req_1', email: 'new@b.c', status: 'pending', createdAt: 2 }],
  };
  const ROLES = { admin: { label: 'Администратор' }, foreman: { label: 'Прораб' }, viewer: { label: 'Наблюдатель' } };
  const errors = [];
  const context = vm.createContext({
    document: doc,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (id) timers[id - 1] = null; },
    console,
    state, ROLES,
    escapeHtml: v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    canAdmin: () => true,
    refreshRegistrationRequests() {},
    approveRequest() {}, rejectRequest() {},
    updateAdminBadge() {},
    renderAdminPanel() {},
    showError: msg => errors.push(String(msg)),
    reportSyncError() {},
  });
  // Блок заявок: от requestSyncStatus до конца renderRegistrationRequests.
  const from = subs.indexOf('const requestSyncStatus');
  const to = subs.indexOf('function acceptRegistrationSnapshot');
  assert.ok(from >= 0 && to > from, 'не найден блок заявок в 04-subscriptions.js');
  vm.runInContext(subs.slice(from, to) + '\nthis.__fns={renderRegistrationRequests,registrationRoleHoldActive,scheduleRenderRegistrationRequests};', context);
  const run = expr => vm.runInContext(expr, context);
  // Минимальная «DOM-модель» select роли: id = req_role_<id заявки>.
  doc.setRoleSelect = (id, value, focused) => {
    doc.roleSelect = { id: 'req_role_' + id, value, matches: () => true };
    doc.activeElement = focused ? doc.roleSelect : null;
  };
  doc.getRoleValue = id => {
    const sel = doc.roleSelect;
    return sel && sel.id === 'req_role_' + id ? sel.value : null;
  };
  return { doc, run, errors, timers, requestsListContainer, renders };
}

test('выбранная роль переживает фоновую перерисовку блока заявок', () => {
  const { doc, run } = setup();
  run('this.__fns.renderRegistrationRequests()');
  // Админ выбрал роль «Прораб» в заявке req_1.
  doc.setRoleSelect('req_1', 'foreman', false);
  // Фоновый снапшот users/requests — тот же код, что зовёт acceptRegistrationSnapshot.
  run('this.__fns.renderRegistrationRequests()');
  assert.equal(doc.getRoleValue('req_1'), 'foreman', 'выбранная роль не сбрасывается до viewer');
});

test('пока select роли в фокусе, перерисовка блока откладывается', () => {
  const { doc, run, timers } = setup();
  run('this.__fns.renderRegistrationRequests()');
  doc.setRoleSelect('req_1', 'foreman', true);
  const timersBefore = timers.length;
  run('this.__fns.renderRegistrationRequests()');
  assert.equal(run('this.__fns.registrationRoleHoldActive()'), true, 'перерисовка распознаёт взаимодействие с блоком заявок');
  assert.ok(timers.length > timersBefore, 'перерисовка отложена через таймер, а не выполнена сразу');
});

test('после снятия фокуса отложенная перерисовка выполняется и роль сохраняется', () => {
  const { doc, run, timers } = setup();
  run('this.__fns.renderRegistrationRequests()');
  doc.setRoleSelect('req_1', 'foreman', true);
  run('this.__fns.renderRegistrationRequests()');
  // Фокус ушёл (админ закрыл select), таймер отложенной перерисовки сработал.
  doc.setRoleSelect('req_1', 'foreman', false);
  const pending = timers.filter(t => t && typeof t.fn === 'function');
  assert.ok(pending.length, 'есть отложенная перерисовка');
  for (const t of pending) t.fn();
  assert.equal(doc.getRoleValue('req_1'), 'foreman', 'роль переживает и отложенную перерисовку');
});
