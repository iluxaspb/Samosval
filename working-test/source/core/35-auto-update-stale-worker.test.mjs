// Регрессия 1.8.4: обновление полностью автоматическое (решение владельца
// 23.11.2026). SW сам делает skipWaiting после SHA-проверки файлов, страница
// по controllerchange показывает оверлей и перезагружается — без кнопок и
// блокировок. Живое выполнение pwa.js в vm с моками. Сценарии:
// (A) published новее buildVersion → registration.update() вызван;
// (B) published==buildVersion==activeVersion → update() НЕ вызван;
// (C) controllerchange → показан оверлей и вызван location.reload;
// (D) фокус в input → reload отложен (нет оверлея), после потери фокуса — reload;
// (E) 3 неудачные попытки → строка со ссылкой на queue-doctor.html;
// (F) несохранённые данные больше НЕ блокируют обновление.
// Плюс статические проверки обеих копий pwa.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const source = readFileSync(path.join(root, 'working-test/source/src/pwa.js'), 'utf8');

const NEW_BUILD = 'aaaaaaaaaaaaaaaa', OLD_BUILD = 'bbbbbbbbbbbbbbbb', FUTURE_BUILD = 'cccccccccccccccc';

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

// Мок-воркер: на TEST_PWA_STATUS отвечает своей версией с complete:true.
function fakeWorker(version) {
  return {
    state: 'activated',
    addEventListener: () => {},
    postMessage: (msg, ports) => {
      if (!ports?.[0] || msg?.type !== 'TEST_PWA_STATUS') return;
      queueMicrotask(() => ports[0].postMessage({ type: 'TEST_PWA_STATUS', version, complete: true }));
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

// Запускает pwa.js в песочнице.
async function runPwa({ published, active, focused = null, confirmOpen = false, initialController = true } = {}) {
  timeShift.ms = 0;
  let updateCalls = 0, reloadCalls = 0;
  const overlays = [];
  const listeners = {}; // document + window + navigator.serviceWorker
  const timers = []; // все setInterval/setTimeout песочницы для dispose()
  let disposed = false;
  const activeWorker = active ? fakeWorker(active) : null;
  const reg = { active: activeWorker, waiting: null, installing: null, addEventListener: () => {} };
  reg.update = async () => { updateCalls++; };
  const sandbox = {
    console: { warn: () => {}, log: () => {} },
    location: {
      protocol: 'https:', pathname: '/index-working-test.html', href: 'https://t/index-working-test.html',
      reload: () => { reloadCalls++; }
    },
    navigator: {
      onLine: true, standalone: false,
      serviceWorker: {
        controller: initialController ? { fake: 'old' } : null,
        register: async () => reg,
        addEventListener: (type, fn) => { (listeners['sw:' + type] ||= []).push(fn); }
      }
    },
    document: {
      hidden: false,
      activeElement: focused,
      // Страница может быть уже «свежей» по network-first: её скрипт
      // указывает на опубликованную сборку NEW_BUILD (currentScript).
      currentScript: { src: 'https://t/working-test/build/' + NEW_BUILD + '/pwa.js' },
      // Confirm-диалог приложения помечается классом pcm-overlay pcm-open.
      querySelector: selector => confirmOpen && selector === '.pcm-overlay.pcm-open' ? {} : null,
      querySelectorAll: () => [],
      createElement: tag => {
        const el = makeElement();
        return new Proxy(el, {
          set(t, p, v) {
            t[p] = v;
            if (p === 'textContent' && v === 'Обновление установлено — перезагружаюсь…') overlays.push(v);
            return true;
          }
        });
      },
      createTextNode: text => ({ textContent: text, nodeType: 3 }),
      addEventListener: () => {}, body: makeElement(), head: makeElement()
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
    addEventListener: (type, fn) => { (listeners['win:' + type] ||= []).push(fn); },
    dispatchEvent: () => {},
    // Честные интервалы (reloadWhenSafe работает на setInterval); после
    // dispose() новые таймеры не создаются — иначе бесконечная цепочка
    // повторов autoUpdate держала бы процесс теста навсегда.
    setInterval: (fn, ms) => { if (disposed) return 0; const id = setInterval(fn, ms || 0); timers.push(id); return id; },
    // setTimeout: честные таймеры, но большие задержки (15 с повтор, 3 мин
    // defer) укорачиваем до 50 мс, чтобы сценарии завершались быстро.
    setTimeout: (fn, delay) => { if (disposed) return 0; const id = setTimeout(fn, delay > 1000 ? 50 : (delay || 0)); timers.push(id); return id; },
    clearTimeout: id => clearTimeout(id), clearInterval: id => clearInterval(id),
    AbortSignal: { timeout: () => undefined },
    Date: FakeDate, JSON, Math, Object, Array, String, Number, Boolean, Promise, Error, WeakSet, Set, RegExp, Proxy, Symbol,
    queueMicrotask,
    // Несохранённые данные: раньше блокировали установку, теперь НЕ должны.
    offlinePendingCount: () => 3,
    pendingOps: 0,
    currentUid: null, permissionsLoaded: true, currentUserStatus: 'active',
    isSecureContext: true
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'pwa.js' });
  const flush = async (n = 50) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
  timeShift.ms = 60000;
  await flush();
  return {
    sandbox,
    snapshot: () => sandbox.TestPWA.snapshot(),
    updateCalls: () => updateCalls,
    reloadCalls: () => reloadCalls,
    overlays: () => overlays.length,
    // Симулируем смену контроллера: новый SW забрал окно.
    fireControllerChange: async () => {
      for (const fn of listeners['sw:controllerchange'] || []) fn();
      await flush();
    },
    flush,
    dispose: () => { disposed = true; for (const id of timers) { clearTimeout(id); clearInterval(id); } }
  };
}

test('сценарий A: version.json новее → registration.update() вызван (без кнопок)', async t => {
  const run = await runPwa({ published: FUTURE_BUILD, active: OLD_BUILD });
  t.after(() => run.dispose());
  // buildVersion страницы = NEW_BUILD (скрипт в песочнице), published новее.
  assert.ok(run.updateCalls() > 0, 'registration.update() обязан вызываться автоматически при более новой версии');
});

test('сценарий B: страница и активный воркер равны published — update() не вызван', async t => {
  const run = await runPwa({ published: NEW_BUILD, active: NEW_BUILD });
  t.after(() => run.dispose());
  assert.equal(run.updateCalls(), 0, 'update() не должен вызываться, когда всё уже актуально');
});

test('сценарий C: controllerchange → оверлей «Обновление установлено» и location.reload', async t => {
  const run = await runPwa({ published: FUTURE_BUILD, active: OLD_BUILD });
  t.after(() => run.dispose());
  await run.fireControllerChange();
  // reloadWhenSafe работает на интервале 500 мс — нужно реальное время.
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.ok(run.overlays() > 0, 'должен быть показан оверлей обновления');
  // reload выполняется через ~1.6 с после оверлея; таймеры укорочены в моке.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(run.reloadCalls() > 0, 'location.reload должен быть вызван после controllerchange');
});

test('сценарий D: фокус в input → reload отложен; потеря фокуса → reload', async t => {
  const input = { tagName: 'INPUT' };
  const run = await runPwa({ published: FUTURE_BUILD, active: OLD_BUILD, focused: input });
  t.after(() => run.dispose());
  await run.fireControllerChange();
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(run.reloadCalls(), 0, 'перезагрузка не должна выполняться при фокусе в поле ввода');
  // Пользователь закрыл поле: потеря фокуса → цикл замечает и перезагружает.
  run.sandbox.document.activeElement = null;
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.ok(run.reloadCalls() > 0, 'после потери фокуса перезагрузка обязана выполниться');
});

test('сценарий E: 3 неудачные попытки → показана ссылка на queue-doctor', async t => {
  const run = await runPwa({ published: FUTURE_BUILD, active: OLD_BUILD });
  t.after(() => run.dispose());
  // Первая попытка уже сделана при старте; дожидаемся, пока цепочка повторов
  // (интервал 15 с укорочен до 50 мс в моке) дойдёт до лимита.
  await new Promise(resolve => setTimeout(resolve, 1500));
  const line = run.sandbox.__wtStatusLine;
  assert.ok(line, 'строка статуса под шапкой должна существовать');
  const markup = String(line.innerHTML || '') + String(line.textContent || '');
  assert.match(markup, /Обновление не применилось/,
    'после трёх неудачных попыток должна появиться строка про queue-doctor');
  assert.ok(markup.includes('queue-doctor.html'),
    'строка обязана содержать ссылку на queue-doctor.html');
});

test('сценарий F: несохранённые данные НЕ блокируют автообновление', async t => {
  // offlinePendingCount() в моке возвращает 3 — раньше assertUpdateSafe
  // блокировал установку. Теперь update() обязан быть вызван всё равно.
  const run = await runPwa({ published: FUTURE_BUILD, active: OLD_BUILD });
  t.after(() => run.dispose());
  assert.ok(run.updateCalls() > 0, 'несохранённые данные не должны блокировать update()');
});

test('статически: баннер «Доступно обновление» и кнопка «Установить» удалены (обе копии)', () => {
  const buildPwa = readFileSync(path.join(root, 'working-test/src/pwa.js'), 'utf8');
  for (const [name, pwa] of [['source', source], ['published', buildPwa]]) {
    assert.doesNotMatch(pwa, /app-update-banner/, name + ': баннер обновления должен быть удалён');
    assert.doesNotMatch(pwa, /app-update-apply/, name + ': кнопка «Установить» удалена из основного пути');
    assert.doesNotMatch(pwa, /Доступно обновление/, name + ': текст баннера удалён');
    assert.doesNotMatch(pwa, /function\s+assertUpdateSafe|function\s+updateBlockReason/, name + ': блокировки удалены из пути обновления');
    assert.doesNotMatch(pwa, /installPublishedUpdate/, name + ': путь ручной установки удалён');
    assert.match(pwa, /обновление установлено/, name + ': тихая строка статуса «обновление установлено»');
  }
});

test('статически: откладывание reload при активном вводе с пределом 3 минуты (обе копии)', () => {
  const buildPwa = readFileSync(path.join(root, 'working-test/src/pwa.js'), 'utf8');
  for (const [name, pwa] of [['source', source], ['published', buildPwa]]) {
    assert.match(pwa, /180000/, name + ': максимум откладывания — 3 минуты');
    assert.match(pwa, /Обновление установлено — перезагружаюсь…/, name + ': текст оверлея');
    assert.match(pwa, /location\.reload\(\)/, name + ': перезагрузка страницы');
    assert.match(pwa, /1800000/, name + ': периодическая проверка раз в 30 минут');
  }
});

test('статически: копии pwa.js различаются только префиксом сообщений', () => {
  const buildPwa = readFileSync(path.join(root, 'working-test/src/pwa.js'), 'utf8');
  const normalized = buildPwa.replaceAll('WORKING_TEST_PWA_', 'TEST_PWA_');
  assert.equal(normalized, source, 'копии pwa.js различаются больше чем префиксом сообщений');
});

console.log('OK: полностью автоматическое обновление 1.8.4 работает');
