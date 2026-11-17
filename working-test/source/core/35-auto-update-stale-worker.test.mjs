// Регрессия 1.7.19: автообновление обязано срабатывать, когда страница уже
// новая (network-first отдал свежий index.html), а АКТИВНЫЙ service worker
// (офлайн-кэш) остался старым. Живое выполнение pwa.js в vm с моками
// registration/воркеров — без DOM-браузера и сети. Сценарии:
// (A) published==buildVersion, воркер старее — установка запускается;
// (B) published==buildVersion==activeVersion — автоустановка не запускается;
// (C) updatePaused (несохранённые данные) — авто не применяется, баннер.
// Обязан падать на коде 1.7.18 (сверка только с buildVersion) и проходить на 1.7.19.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const source = readFileSync(path.join(root, 'working-test/source/src/pwa.js'), 'utf8');

const NEW_BUILD = 'aaaaaaaaaaaaaaaa', OLD_BUILD = 'bbbbbbbbbbbbbbbb';

// Время в песочнице сдвинуто вперёд, чтобы прошли стартовые guards
// (30 с от открытия страницы) без real-time ожидания.
const timeShift = { ms: 0 };
class FakeDate extends Date {
  static now() { return super.now() + timeShift.ms; }
}

// Связанные порты: postMessage на одном асинхронно вызывает onmessage другого.
function linkedPorts() {
  const a = { onmessage: null, close: () => {}, postMessage: data => { if (b.onmessage) queueMicrotask(() => b.onmessage({ data })); } };
  const b = { onmessage: null, close: () => {}, postMessage: data => { if (a.onmessage) queueMicrotask(() => a.onmessage({ data })); } };
  return [a, b];
}

// Мок-воркер: на TEST_PWA_STATUS отвечает своей версией с complete:true,
// на TEST_PWA_APPLY подтверждает применение.
function fakeWorker(version) {
  return {
    state: 'activated',
    addEventListener: () => {},
    postMessage: (msg, ports) => {
      if (!ports?.[0]) return;
      const reply = msg?.type === 'TEST_PWA_STATUS'
        ? { type: 'TEST_PWA_STATUS', version, complete: true }
        : msg?.type === 'TEST_PWA_APPLY'
          ? { type: 'TEST_PWA_APPLY', version: msg.version, accepted: true }
          : null;
      // Код страницы слушает своим port1, воркеру передан port2: ответ в port2
      // асинхронно прилетает в onmessage.port1 (порты связаны через linkedPorts).
      if (reply) queueMicrotask(() => ports[0].postMessage(reply));
    }
  };
}

function makeElement() {
  return new Proxy({ style: {}, dataset: {}, hidden: false, textContent: '' }, {
    get(target, prop) {
      if (prop === 'querySelector') return () => makeElement();
      if (prop === 'querySelectorAll') return () => [];
      if (['append', 'appendChild', 'setAttribute', 'removeAttribute', 'addEventListener', 'removeEventListener', 'toggleAttribute', 'showModal', 'close', 'onclick'].includes(prop)) return () => {};
      if (prop === 'open') return false;
      return target[prop];
    },
    set(target, prop, value) { target[prop] = value; return true; }
  });
}

// Запускает pwa.js в песочнице; следит за registration.update() — он вызывается
// только когда ранний выход «уже актуальна» пройден и установка действительно пошла.
async function runPwa({ published, active, paused = false }) {
  timeShift.ms = 0;
  let updateCalls = 0, replaced = false;
  const activeWorker = active ? fakeWorker(active) : null;
  const reg = { active: activeWorker, waiting: null, installing: null, addEventListener: () => {}, update: async () => {} };
  reg.update = async () => { updateCalls++; };
  const sandbox = {
    console: { warn: () => {}, log: () => {} },
    location: {
      protocol: 'https:', pathname: '/index-working-test.html', href: 'https://t/index-working-test.html',
      replace: () => { replaced = true; }
    },
    navigator: { onLine: true, serviceWorker: { register: async () => reg, addEventListener: () => {} }, standalone: false },
    document: {
      hidden: false,
      // Страница уже «свежая»: её скрипт указывает на опубликованную сборку NEW_BUILD.
      currentScript: { src: 'https://t/working-test/build/' + NEW_BUILD + '/pwa.js' },
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => makeElement(), addEventListener: () => {}, body: makeElement(), head: makeElement()
    },
    window: null,
    sessionStorage: { getItem: () => null, setItem: () => {} },
    fetch: async url => {
      const s = String(url);
      if (s.includes('version.json')) return { ok: true, json: async () => ({ build: published }) };
      if (s.includes('build-manifest.json')) return { ok: false };
      return { ok: true, text: async () => 'const VERSION = \'' + published + '\'' };
    },
    matchMedia: () => ({ matches: false }),
    MessageChannel: class { constructor() { const [p1, p2] = linkedPorts(); this.port1 = p1; this.port2 = p2; } },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
    addEventListener: () => {}, dispatchEvent: () => {},
    setInterval: () => 0,
    // setTimeout с числовой задержкой — честный таймер: ответ воркера приходит
    // микрозадачей раньше 4-секундного таймаута workerStatus, а дедлайны
    // (45/90/120 с) не истекают, потому что тест завершается раньше.
    setTimeout: (fn, delay) => setTimeout(fn, typeof delay === 'number' ? Math.min(delay, 5000) : 0),
    clearTimeout: id => clearTimeout(id), clearInterval: id => clearInterval(id),
    AbortSignal: { timeout: () => undefined },
    Date: FakeDate, JSON, Math, Object, Array, String, Number, Boolean, Promise, Error, WeakSet, Set, RegExp, Proxy, Symbol,
    queueMicrotask,
    // несохранённые данные: очередь рейсов > 0 → assertUpdateSafe бросает updatePaused
    offlinePendingCount: () => (paused ? 3 : 0),
    pendingOps: 0,
    currentUid: null, permissionsLoaded: true, currentUserStatus: 'active',
    isSecureContext: true
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'pwa.js' });
  // pageStartedAt зафиксирован «сейчас»; сдвигаем время за 30-секундный guard
  // и даём стартовой цепочке checkForUpdates→discover→autoApply отработать.
  timeShift.ms = 60000;
  for (let i = 0; i < 500; i++) await new Promise(resolve => setImmediate(resolve));
  return {
    snapshot: () => sandbox.TestPWA.snapshot(),
    updateCalls: () => updateCalls,
    replaced: () => replaced
  };
}

test('сценарий A: страница новая, активный воркер старый — установка запускается', async () => {
  // buildVersion страницы == published (страница уже свежая по network-first),
  // но активный воркер держит старый офлайн-кэш. На коде 1.7.18 автоустановка
  // отсекалась ранним возвратом «Уже открыта актуальная сборка».
  const run = await runPwa({ published: NEW_BUILD, active: OLD_BUILD });
  assert.ok(run.updateCalls() > 0,
    'registration.update() не вызван: детектор вернулся по «уже актуальна», хотя активный воркер старый');
  assert.equal(run.snapshot().activeVersion, OLD_BUILD);
});

test('сценарий B: страница и активный воркер равны published — автоустановки нет', async () => {
  const run = await runPwa({ published: NEW_BUILD, active: NEW_BUILD });
  assert.equal(run.updateCalls(), 0, 'автоустановка не должна запускаться, когда всё уже актуально');
  assert.equal(run.snapshot().activeVersion, NEW_BUILD);
});

test('сценарий C: updatePaused (несохранённые данные) — авто не применяется', async () => {
  const run = await runPwa({ published: NEW_BUILD, active: OLD_BUILD, paused: true });
  assert.equal(run.updateCalls(), 0, 'при updatePaused установка не должна запускаться');
  assert.ok(!run.replaced(), 'перезапуск страницы не должен выполняться при updatePaused');
  assert.equal(run.snapshot().activeVersion, OLD_BUILD, 'воркер не должен меняться при updatePaused');
});

test('статически: условие автообновления сверяется с версией активного воркера (обе копии)', () => {
  const buildPwa = readFileSync(path.join(root, 'working-test/src/pwa.js'), 'utf8');
  for (const [name, pwa] of [['source', source], ['published', buildPwa]]) {
    assert.match(pwa, /if\(!latestPublished\|\|!updateNeeded\(latestPublished\.version\)\)return;/,
      name + ': автоустановка обязана идти через updateNeeded (сверка и со страницей, и с активным воркером)');
    assert.match(pwa, /function updateNeeded\(published\)/, name + ': нужна функция updateNeeded');
    const body = pwa.slice(pwa.indexOf('function updateNeeded'), pwa.indexOf('function workerStatus'));
    assert.match(body, /active !== published/, name + ': updateNeeded обязан видеть отставание активного воркера');
  }
  const normalized = buildPwa.replaceAll('WORKING_TEST_PWA_', 'TEST_PWA_');
  assert.equal(normalized, source, 'копии pwa.js различаются больше чем префиксом сообщений');
});

console.log('OK: автообновление при устаревшем воркере работает (1.7.19)');
