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

// Ф1: открытый список ролей (select) не должен закрываться фоновой перерисовкой.
test('исходник: select роли адресуется по data-role-uid и входит в предикат удержания', () => {
  const body = functionBody('renderAdminPanel');
  assert.match(body, /select[^>]*data-role-uid=/, 'select роли помечен data-role-uid');
  assert.match(body, /onchange="changeUserRole\(/, 'сохранение роли осталось мгновенным по onchange');
  const pred = functionBody('adminDraftFieldActive');
  assert.match(pred, /select\[data-role-uid\]/, 'фокус в select роли откладывает перерисовку');
});

// Ф2: кнопки «Сохранить»/«Отмена» появляются только после ввода.
test('исходник: кнопки действий ника скрыты по умолчанию и адресуются по data-nickname-actions', () => {
  const body = functionBody('renderAdminPanel');
  assert.match(body, /data-nickname-actions[^>]*style="display:none/, 'контейнер кнопок скрыт в разметке');
  assert.match(body, /data-nickname-cancel="/, 'кнопка «Отмена» адресуется по data-nickname-cancel');
  assert.match(body, /setNicknameActionsVisible\(/, 'видимость кнопок управляется программно');
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
  // Минимальная «DOM-модель» строки пользователя: поле ника, контейнер
  // кнопок (скрыт по умолчанию) и сами кнопки. Рендер в харнесе не парсит
  // innerHTML — тесты регистрируют элементы через doc.setNicknameField.
  const actions = { style: { display: 'none' }, get hidden() { return this.style.display === 'none'; } };
  const saveBtn = { dataset: { nicknameSave: 'uid_1' }, onclick: null };
  const cancelBtn = { dataset: { nicknameCancel: 'uid_1' }, onclick: null };
  const row = {
    querySelector: sel => (sel === '[data-nickname-actions]' ? actions : null),
  };
  const usersListContainer = {
    innerHTML: '',
    contains: () => true,
    querySelectorAll: sel => {
      if (sel === '[data-nickname-uid]') return doc.nicknameField ? [doc.nicknameField] : [];
      if (sel === '[data-nickname-save]') return [saveBtn];
      if (sel === '[data-nickname-cancel]') return [cancelBtn];
      return [];
    },
  };
  const doc = {
    getElementById: id => (id === 'usersListContainer' ? usersListContainer : null),
    querySelectorAll: () => [],
    querySelector: () => doc.nicknameField || null,
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
  // Блок админ-панели: от userAccessWrites до changeUserRole включительно.
  const from = lineUi.indexOf('const userAccessWrites');
  const to = lineUi.indexOf('const registrationDecisions');
  assert.ok(from >= 0 && to > from, 'не найден блок админ-панели в 18-line-ui.js');
  vm.runInContext(lineUi.slice(from, to) + '\nthis.__fns={renderAdminPanel,updateUserNickname,saveUserNicknameDraft,cancelUserNicknameDraft,changeUserRole,adminDraftHoldActive,scheduleRenderAdminPanel};', context);
  const run = expr => vm.runInContext(expr, context);
  // Поле ника: рендер восстанавливает значения из черновика, собранного до
  // перестроения; контейнер кнопок ищется через родителя поля.
  doc.setNicknameField = field => {
    doc.nicknameField = { parentElement: row, matches: () => true, oninput: null, ...field };
    if (field.focused) doc.activeElement = doc.nicknameField;
    else doc.activeElement = null;
  };
  doc.setRoleSelectFocused = () => { doc.activeElement = { matches: sel => sel.includes('select'), tagName: 'SELECT' }; };
  return { doc, run, errors, submitted, timers, usersListContainer, actions, saveBtn, cancelBtn };
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

// === Ф1 (владелец, 1.8.1): открытый список ролей закрывался фоновой перерисовкой ===

test('Ф1: пока select роли в фокусе (список открыт), перерисовка откладывается', async () => {
  const { doc, run, timers, usersListContainer } = setup();
  run('this.__fns.renderAdminPanel()');
  const htmlBefore = usersListContainer.innerHTML;
  doc.setRoleSelectFocused();
  const timersBefore = timers.length;
  await run('this.__fns.renderAdminPanel()');
  assert.equal(run('this.__fns.adminDraftHoldActive()'), true, 'фокус в select роли распознаётся как активный ввод');
  assert.equal(usersListContainer.innerHTML, htmlBefore, 'разметка списка не перестраивается — открытый список не закрывается');
  assert.ok(timers.length > timersBefore, 'перерисовка отложена через таймер');
});

test('Ф1: после ухода фокуса из select отложенная перерисовка выполняется', async () => {
  const { doc, run, timers, usersListContainer } = setup();
  run('this.__fns.renderAdminPanel()');
  doc.setRoleSelectFocused();
  await run('this.__fns.renderAdminPanel()');
  assert.ok(timers.length === 1, 'запланирована одна отложенная перерисовка');
  doc.activeElement = null; // администратор выбрал роль, список закрылся
  usersListContainer.innerHTML = '';
  timers[0].fn();
  assert.ok(usersListContainer.innerHTML.length > 0, 'список перестроен после снятия фокуса');
});

test('Ф1: смена роли по-прежнему отправляется сразу одним вызовом', async () => {
  const { run, submitted } = setup();
  await run('this.__fns.changeUserRole("uid_1","foreman")');
  assert.equal(submitted.length, 1, 'onchange → один вызов admin-действия');
  assert.equal(submitted[0].type, 'user.role');
  assert.deepEqual({ ...submitted[0].payload }, { uid: 'uid_1', role: 'foreman' });
});

// === Ф2 (владелец, 1.8.1): кнопки действий ника появляются только после ввода ===

test('Ф2: без ввода кнопки «Сохранить»/«Отмена» скрыты', () => {
  const { run, usersListContainer } = setup();
  run('this.__fns.renderAdminPanel()');
  assert.match(usersListContainer.innerHTML, /data-nickname-actions[^>]*style="display:none/, 'в разметке кнопки скрыты по умолчанию');
});

test('Ф2: после ввода появляются «Сохранить» и «Отмена»; кнопки привязаны', () => {
  const { doc, run, actions, saveBtn, cancelBtn } = setup({ nickname: 'Вова' });
  run('this.__fns.renderAdminPanel()');
  // Поле не в фокусе — реальная (не отложенная) перерисовка привязывает oninput.
  doc.setNicknameField({ value: 'Вова', focused: false, dataset: { nicknameUid: 'uid_1' } });
  run('this.__fns.renderAdminPanel()');
  assert.equal(actions.hidden, true, 'исходное значение — кнопки скрыты');
  doc.nicknameField.value = 'Витя';
  doc.nicknameField.oninput();
  assert.equal(actions.hidden, false, 'после ввода кнопки показаны');
  assert.equal(typeof saveBtn.onclick, 'function', '«Сохранить» привязана');
  assert.equal(typeof cancelBtn.onclick, 'function', '«Отмена» привязана');
});

test('Ф2: «Отмена» возвращает исходный ник и прячет кнопки', () => {
  const { doc, run, actions, submitted } = setup({ nickname: 'Вова' });
  run('this.__fns.renderAdminPanel()');
  doc.setNicknameField({ value: 'Вова', focused: false, dataset: { nicknameUid: 'uid_1' } });
  run('this.__fns.renderAdminPanel()');
  doc.nicknameField.value = 'Витя';
  doc.nicknameField.oninput();
  assert.equal(actions.hidden, false);
  run('this.__fns.cancelUserNicknameDraft("uid_1")');
  assert.equal(doc.nicknameField.value, 'Вова', 'поле возвращает исходный ник');
  assert.equal(actions.hidden, true, 'кнопки спрятаны');
  assert.equal(submitted.length, 0, 'отмена ничего не отправляет');
});

test('Ф2: состояние ввода переживает фоновую перерисовку — кнопки остаются видимыми', async () => {
  const { doc, run, actions } = setup({ nickname: 'Вова' });
  run('this.__fns.renderAdminPanel()');
  doc.setNicknameField({ value: 'Вова', focused: false, dataset: { nicknameUid: 'uid_1' } });
  run('this.__fns.renderAdminPanel()');
  doc.nicknameField.value = 'Витя';
  doc.nicknameField.oninput();
  // Поле не в фокусе (администратор ушёл из поля) — фоновая перерисовка выполняется.
  await run('this.__fns.renderAdminPanel()');
  assert.equal(doc.nicknameField.value, 'Витя', 'черновик сохранён');
  assert.equal(actions.hidden, false, 'кнопки по-прежнему видны для изменённого ника');
});

test('Ф2: после успешного сохранения кнопки исчезают', async () => {
  const { doc, run, actions, submitted } = setup({ nickname: 'Вова' });
  run('this.__fns.renderAdminPanel()');
  doc.setNicknameField({ value: 'Вова', focused: false, dataset: { nicknameUid: 'uid_1' } });
  run('this.__fns.renderAdminPanel()');
  doc.nicknameField.value = 'Витя';
  doc.nicknameField.oninput();
  assert.equal(actions.hidden, false);
  await run('this.__fns.saveUserNicknameDraft("uid_1")');
  assert.equal(submitted.length, 1, 'ник отправлен');
  assert.deepEqual({ ...submitted[0].payload }, { uid: 'uid_1', nickname: 'Витя' });
  assert.equal(actions.hidden, true, 'после сохранения кнопки спрятаны');
});

test('Ф2: при ошибке сохранения черновик и кнопки остаются', async () => {
  const { doc, run, actions, errors } = setup({ nickname: 'Вова' });
  run('this.__fns.renderAdminPanel()');
  doc.setNicknameField({ value: 'Вова', focused: false, dataset: { nicknameUid: 'uid_1' } });
  run('this.__fns.renderAdminPanel()');
  doc.nicknameField.value = 'Витя';
  doc.nicknameField.oninput();
  doc.failNickname = true;
  await run('this.__fns.saveUserNicknameDraft("uid_1")');
  assert.equal(doc.nicknameField.value, 'Витя', 'черновик не потерян');
  assert.equal(actions.hidden, false, 'кнопки остались — можно повторить или отменить');
  assert.ok(errors.some(m => m.includes('Ник не сохранён')));
});
