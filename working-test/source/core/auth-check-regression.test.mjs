// Регрессионный тест (1.7.11): после удаления Firebase SDK (1.7.10)
// 04-subscriptions.js проверял `typeof auth !== 'undefined' && auth.currentUser`.
// typeof null === 'object', поэтому условие проходило, auth.currentUser бросал
// TypeError синхронно внутри wtApplyAuthUser ДО вызова startNasRuntime — и UI
// навсегда оставался на «Проверка учётной записи…» без единого сетевого запроса.
//
// Тест функциональный: фрагмент wtApplyAuthUser (до ветки NAS/Firestore-дока)
// исполняется в vm с auth === null и заглушками окружения. Условия:
//  1) с auth === null wtApplyAuthUser не бросает и ДОХОДИТ до startNasRuntime;
//  2) при постановке бейджа запускается страховочный таймаут 45 секунд;
//  3) если проверка не завершилась, таймаут показывает понятную ошибку и тост;
//  4) в исходнике не осталось null-unsafe паттерна typeof auth !== 'undefined'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '04-subscriptions.js'), 'utf8');

// Вырезаем тело wtApplyAuthUser: от объявления до первой точки ветвления
// (NAS-рантайм / onSnapshot пользовательского документа).
function extractApplyAuthUser(text) {
  const start = text.indexOf('async function wtApplyAuthUser');
  // Обрезаем сразу после await startNasRuntime(user) (NAS-ветка, за ней return)
  // и закрываем оставшиеся незакрытыми скобки по фактическому балансу.
  const nasCall = 'await startNasRuntime(user);';
  const end = text.indexOf(nasCall, start) + nasCall.length;
  assert.ok(text.indexOf(nasCall, start) !== -1, 'в wtApplyAuthUser найден вызов startNasRuntime');
  const body = text.slice(start, end);
  let depth = 0;
  for (const ch of body) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  return body + '\nreturn;\n' + '}'.repeat(depth);
}

function makeHarness({ authValue }) {
  const calls = { startNasRuntime: 0, toast: [], timeouts: [] };
  const badge = { textContent: '' };
  const document = {
    body: { removeAttribute() {} },
    getElementById(id) {
      if (id === 'userBadgeLabel') return badge;
      return { style: {}, textContent: '' };
    }
  };
  const sandbox = {
    console, JSON, Date,
    document,
    // Firebase-заглушки 1.7.10+: auth всегда null, SDK не загружается.
    auth: authValue,
    // Объявления модульной области видимости, которые использует фрагмент.
    wtAuthCheckTimer: null,
    wtAuthCheckLastError: null,
    authSessionGeneration: 0,
    currentUid: '', currentUserRole: null, currentUserStatus: null,
    currentUserNickname: '', activeProfileKey: '', initialized: false,
    profileServerConfirmed: false, permissionsServerConfirmed: false,
    permissionsLoaded: false, appConfigSyncUid: '',
    permissionsConfig: {}, DEFAULT_PERMISSIONS: {},
    confirmedLoadIds: new Set(), syncState: {}, state: {},
    offlineRemoteStatuses: null, offlineRemoteLogs: null,
    nasRuntimeClient: null, userDocUnsubscriber: null,
    // Заглушки окружения.
    setTimeout: (fn, ms) => { calls.timeouts.push({ fn, ms }); return 1; },
    clearTimeout() {},
    showToastEl: (msg, isError) => calls.toast.push({ msg, isError }),
    stopSync() {}, loadCache() {}, offlineProjectState() {}, renderAll() {},
    updateSyncUI() {},
    isNasRuntime: () => true, // рабочий канал всегда работает через Ubuntu API
    startNasRuntime: async () => { calls.startNasRuntime++; },
    ensureWorkingAuthority: async () => {},
    watchWorkingAuthority() {},
  };
  return { sandbox, calls, badge };
}

async function runApplyAuthUser(authValue) {
  const { sandbox, calls } = makeHarness({ authValue });
  const context = vm.createContext(sandbox);
  vm.runInContext(extractApplyAuthUser(source) + '\nglobalThis.__wtApplyAuthUser = wtApplyAuthUser;', context);
  await vm.runInContext('globalThis.__wtApplyAuthUser({ uid: "u1", email: "user@example.com" })', context);
  return { calls, sandbox };
}

test('wtApplyAuthUser с auth === null не бросает и доходит до startNasRuntime', async () => {
  const { calls } = await runApplyAuthUser(null);
  assert.equal(calls.startNasRuntime, 1, 'startNasRuntime вызван (обмен с сервером запущен)');
});

test('страховочный таймаут 45 с ставится вместе с бейджем «Проверка учётной записи…»', async () => {
  const { calls } = await runApplyAuthUser(null);
  const guard = calls.timeouts.find(t => t.ms === 45000);
  assert.ok(guard, 'зарегистрирован таймаут 45000 мс');
});

test('таймаут-страховка: при незавершившейся проверке — понятная ошибка и тост', async () => {
  const { calls, sandbox, badge } = (() => {
    const h = makeHarness({ authValue: null });
    return { calls: h.calls, sandbox: h.sandbox, badge: h.badge };
  })();
  const context = vm.createContext(sandbox);
  vm.runInContext(extractApplyAuthUser(source) + '\nglobalThis.__f = wtApplyAuthUser;', context);
  await vm.runInContext('globalThis.__f({ uid: "u1", email: "user@example.com" })', context);
  const guard = calls.timeouts.find(t => t.ms === 45000);
  assert.ok(guard, 'таймаут-страховка зарегистрирован');
  // Проверка не завершилась: роль/статус не установлены, NAS-клиент не создан.
  const errors = [];
  const originalError = console.error;
  console.error = (...a) => errors.push(a);
  try { guard.fn(); } finally { console.error = originalError; }
  assert.equal(badge.textContent, '👤 Не удалось проверить учётную запись', 'бейдж показывает ошибку');
  assert.ok(calls.toast.some(t => /Обновите страницу или войдите заново/.test(t.msg)), 'показан тост с подсказкой');
  assert.ok(errors.length > 0, 'console.error вызван с текстом последней ошибки');
});

test('таймаут-страховка отменяется, когда проверка завершилась (роль установлена)', async () => {
  const h = makeHarness({ authValue: null });
  const context = vm.createContext(h.sandbox);
  vm.runInContext(extractApplyAuthUser(source) + '\nglobalThis.__f = wtApplyAuthUser;', context);
  await vm.runInContext('globalThis.__f({ uid: "u1", email: "user@example.com" })', context);
  // NAS-рантайм подтвердил профиль: статус установлен — страховка не должна срабатывать.
  h.sandbox.currentUserStatus = 'active';
  h.sandbox.currentUserRole = 'viewer';
  const guard = h.calls.timeouts.find(t => t.ms === 45000);
  guard.fn();
  assert.ok(!h.badge.textContent.includes('Не удалось проверить учётную запись'), 'бейдж не перезаписан ошибкой');
  assert.deepEqual(h.calls.toast, [], 'тост не показан');
});

test('в исходнике 04-subscriptions.js не осталось null-unsafe обращения к auth', () => {
  assert.ok(
    !source.includes("typeof auth !== 'undefined'"),
    'паттерн `typeof auth !== \'undefined\' && auth...\' пропускает auth === null (typeof null === \'object\')'
  );
  assert.ok(/if \(auth && auth\.currentUser\) \{/.test(source), 'проверка заменена на null-safe `auth && auth.currentUser`');
});
