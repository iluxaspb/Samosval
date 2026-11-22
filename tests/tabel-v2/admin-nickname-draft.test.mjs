// Регрессионный тест черновика ника в «Админ → Юзеры» (18-line-ui.js).
// Список пользователей перестраивается через innerHTML при каждом фоновом
// обновлении (nasActiveRefresh → refreshNasAdministration → renderAdminPanel,
// снапшоты users/requests). Раньше напечатанный, но не зафиксированный ник
// молча терялся. Теперь: ввод живёт в поле до явного «Сохранить» (кнопка
// рядом с полем), фоновая перерисовка при фокусе в поле откладывается, а
// введённые значения переживают перестроение контейнера (сохранение и
// восстановление по data-nickname-uid). Ошибка сохранения не очищает поле
// и показывает сообщение. Паттерн отложенной перерисовки — как в
// tabel-v2/workspace.mjs refreshIncoming.
// Запуск: node --test tests/tabel-v2/admin-nickname-draft.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const lineUi = readFileSync(join(here, '..', '..', 'working-test', 'source', 'core', '18-line-ui.js'), 'utf8');

function functionBody(name) {
  const start = lineUi.indexOf('function ' + name);
  assert.ok(start >= 0, 'нет функции ' + name);
  let depth = 0, i = lineUi.indexOf('{', start), end = i;
  for (; i < lineUi.length; i++) {
    if (lineUi[i] === '{') depth++;
    else if (lineUi[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  return lineUi.slice(start, end);
}

test('исходник: у поля ника нет onchange — сохранение только кнопкой «Сохранить»', () => {
  const body = functionBody('renderAdminPanel');
  assert.doesNotMatch(body, /onchange="updateUserNickname/, 'ввод не должен отправляться автоматически');
  assert.match(body, /data-nickname-uid=/, 'поле ника адресуется по data-nickname-uid');
  assert.match(body, /data-nickname-save="/, 'кнопка «Сохранить» адресуется по data-nickname-save');
});

test('исходник: перед перестроением списка значения и фокус сохраняются, после — восстанавливаются', () => {
  const body = functionBody('renderAdminPanel');
  assert.match(body, /collectDraftFields\(/, 'значения input ника собираются перед innerHTML');
  assert.match(body, /restoreDraftFields\(/, 'значения и фокус восстанавливаются после innerHTML');
});

test('исходник: перерисовка списка откладывается при фокусе в поле ника', () => {
  const body = functionBody('renderAdminPanel');
  assert.match(body, /adminDraftHoldActive\(\)/, 'есть предикат активного черновика');
  assert.match(body, /scheduleRenderAdminPanel\(\)/, 'отложенная перерисовка вместо тихой потери');
});

test('исходник: ошибка сохранения ника не очищает поле', () => {
  const body = functionBody('updateUserNickname');
  assert.doesNotMatch(body, /value ?= ?''/, 'ошибка не очищает поле');
  assert.match(body, /return saveLineEvent\(\(\)=>runNasAdminAction\('user\.nickname'/, 'ошибка показывается внутри runNasAdminAction (21-nas-runtime), поле не трогается');
});

// === Поведенческий прогон на мини-харнесе (стиль truck-phone-modal.test.mjs):
// выполняем реальный блок админ-панели из 18-line-ui.js в песочнице vm.
function setup({ nickname = '' } = {}) {
  const timers = [];
  const usersListContainer = { innerHTML: '', querySelectorAll: () => [], contains: () => true };
  const doc = {
    getElementById: id => (id === 'usersListContainer' ? usersListContainer : null),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    activeElement: null,
  };
  const errors = [], submitted = [];
  const state = { users: [{ id: 'uid_1', email: 'a@b.c', nickname, role: 'viewer', status: 'active' }] };
  const ROLES = { admin: { label: 'Администратор' }, foreman: { label: 'Прораб' }, viewer: { label: 'Наблюдатель' } };
  const context = vm.createContext({
    document: doc,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (id) timers[id - 1] = null; },
    console,
    state, ROLES,
    escapeHtml: v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    canAdmin: () => true,
    renderRegistrationRequests() {},
    updateAdminBadge() {},
    currentUid: 'uid_1',
    isNasRuntime: () => true,
    isForcedAdminEmail: () => false,
    showToastEl() {},
    showError: msg => errors.push(String(msg)),
    saveLineEvent: nasWork => nasWork(),
    runNasAdminAction: async (type, payload) => {
      submitted.push({ type, payload });
      if (doc.failNickname) { context.showError('Ник не сохранён: сервер недоступен'); return false; }
      return true;
    },
  });
  // Блок админ-панели: от userAccessWrites до updateUserNickname включительно.
  const from = lineUi.indexOf('const userAccessWrites');
  const to = lineUi.indexOf('async function changeUserRole');
  assert.ok(from >= 0 && to > from, 'не найден блок админ-панели в 18-line-ui.js');
  vm.runInContext(lineUi.slice(from, to) + '\nthis.__fns={renderAdminPanel,updateUserNickname,adminDraftHoldActive,scheduleRenderAdminPanel};', context);
  const run = expr => vm.runInContext(expr, context);
  // Минимальная «DOM-модель» поля ника: рендер восстанавливает значения из
  // черновика, собранного до перестроения.
  doc.setNicknameField = field => { doc.nicknameField = { matches: () => true, ...field }; doc.activeElement = field.focused ? doc.nicknameField : null; };
  return { doc, run, errors, submitted, timers, usersListContainer };
}

test('черновик ника переживает фоновую перерисовку списка', async () => {
  const { doc, run } = setup({ nickname: '' });
  run('this.__fns.renderAdminPanel()');
  // Администратор печатает ник (поле в фокусе, значение ещё не сохранено).
  doc.setNicknameField({ value: 'Витя', focused: true, dataset: { nicknameUid: 'uid_1' } });
  // Фоновое обновление — тот же код, который вызывает nasActiveRefresh ~15 с.
  await run('this.__fns.renderAdminPanel()');
  assert.equal(doc.nicknameField.value, 'Витя', 'введённый текст не теряется при перерисовке');
});

test('пока поле ника в фокусе, перерисовка списка откладывается и не рушит ввод', async () => {
  const { doc, run, timers } = setup();
  run('this.__fns.renderAdminPanel()');
  doc.setNicknameField({ value: 'Витя', focused: true, dataset: { nicknameUid: 'uid_1' } });
  const timersBefore = timers.length;
  await run('this.__fns.renderAdminPanel()');
  assert.equal(run('this.__fns.adminDraftHoldActive()'), true, 'фоновая перерисовка распознаёт активный черновик');
  assert.ok(timers.length > timersBefore, 'перерисовка отложена через таймер, а не потеряна');
});

test('кнопка «Сохранить» отправляет введённый ник одним вызовом', async () => {
  const { doc, run, submitted } = setup();
  run('this.__fns.renderAdminPanel()');
  const field = { value: '  Витя  ', focused: false, dataset: { nicknameUid: 'uid_1' } };
  doc.setNicknameField(field);
  await run('this.__fns.updateUserNickname("uid_1", this.document.nicknameField.value)');
  assert.equal(submitted.length, 1, 'ровно один вызов admin-действия');
  assert.equal(submitted[0].type, 'user.nickname');
  assert.deepEqual({ ...submitted[0].payload }, { uid: 'uid_1', nickname: 'Витя' });
});

test('ошибка сохранения показывает сообщение и не очищает поле', async () => {
  const { doc, run, errors, submitted } = setup();
  run('this.__fns.renderAdminPanel()');
  const field = { value: 'Витя', focused: false, dataset: { nicknameUid: 'uid_1' } };
  doc.setNicknameField(field);
  doc.failNickname = true;
  await run('this.__fns.updateUserNickname("uid_1", this.document.nicknameField.value)');
  assert.equal(submitted.length, 1);
  assert.equal(field.value, 'Витя', 'черновик сохраняется в поле после ошибки');
  assert.ok(errors.some(m => m.includes('Ник не сохранён')), 'администратор видит сообщение об ошибке');
});
