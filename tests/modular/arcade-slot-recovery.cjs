'use strict';
// Регрессия автомата: незавершённое вращение не должно запирать игру навсегда
// и кнопка не должна молча не реагировать.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const root = path.resolve(__dirname, '../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

// ---------- Часть A: чтение незавершённого вращения ----------
{
  const store = new Map(), handlers = {};
  const key = 'samosval-nas-arcade-spin-v1:scope';
  require('../../test-app/source/features/road-arcade-core.js');
  const ctx = {
    window: { RoadArcadeCore: global.RoadArcadeCore, addEventListener: (n, f) => (handlers[n] = f) },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    firebaseConfig: { projectId: 'p' }, WORKSPACE_ID: 'w', currentUid: 'u', currentEmail: 'u@x',
    permissionsLoaded: true, currentUserStatus: 'active', appConfig: {},
    isNasRuntime: () => true, nasStorageScope: () => 'scope', nasGameReady: false, nasGameSnapshot: null, getUserName: () => 'User',
    escapeHtml: String, crypto: { randomUUID: () => 'uuid', getRandomValues: a => a.fill(1) },
    setInterval: () => 0, clearInterval: () => {}, console, Date, JSON, Number, Error
  };
  ctx.globalThis = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(read('test-app/source/features/road-arcade-runtime.js'), ctx);
  const A = ctx.window.RoadArcade;
  assert.ok(A && typeof A.readSpin === 'function', 'runtime не отдал readSpin');

  assert.strictEqual(A.readSpin(), null, 'пустое хранилище не должно давать вращение');

  // Запись от старой сборки: без отметки времени. Раньше именно она навсегда
  // делала кнопку «Проверить незавершённое вращение» мёртвой.
  store.set(key, JSON.stringify({ id: 'legacy', kind: 'slot', roll: 7 }));
  assert.strictEqual(A.readSpin(), null, 'запись без времени должна сниматься');
  assert.ok(!store.has(key), 'старая запись должна быть удалена из хранилища');

  // Свежая запись повторяется — это безопасный возврат результата той же ставки.
  const fresh = { id: 'live', kind: 'slot', roll: 2500, createdAt: Date.now() };
  store.set(key, JSON.stringify(fresh));
  assert.deepStrictEqual(A.readSpin(), fresh, 'свежая запись должна возвращаться для повтора');

  // Просроченная запись не должна блокировать игру.
  store.set(key, JSON.stringify({ id: 'old', kind: 'slot', roll: 1, createdAt: Date.now() - 31 * 60 * 1000 }));
  assert.strictEqual(A.readSpin(), null, 'просроченная запись должна сниматься');
  assert.ok(!store.has(key), 'просроченная запись должна быть удалена');

  // Повреждённая запись не должна бросать исключение.
  store.set(key, '{broken');
  assert.strictEqual(A.readSpin(), null, 'повреждённая запись не должна ломать чтение');
  console.log('A) незавершённое вращение: старая, свежая, просроченная и повреждённая записи — ok');
}

// ---------- Часть B: кнопка автомата не молчит ----------
(async () => {
  const descendants = n => n.children.flatMap(c => [c, ...descendants(c)]);
  function simple(el, s) {
    if (s === '*') return true;
    const tag = s.match(/^[a-zA-Z][\w-]*/)?.[0];
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    for (const id of s.matchAll(/#([\w-]+)/g)) if (el.id !== id[1]) return false;
    for (const c of s.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(c[1])) return false;
    for (const a of s.matchAll(/\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
      const v = a[1] === 'open' ? (el.open ? '' : undefined) : el.getAttribute(a[1]);
      if (v === undefined || (a[2] !== undefined && v !== a[2])) return false;
    }
    return true;
  }
  function matches(el, s) {
    const parts = s.trim().split(/\s+/);
    if (!simple(el, parts.pop())) return false;
    let p = el.parentNode;
    while (parts.length) { const part = parts.pop(); while (p && !simple(p, part)) p = p.parentNode; if (!p) return false; p = p.parentNode; }
    return true;
  }
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.dataset = {}; this.style = {};
      this.events = {}; this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this.checked = false; this.textContent = ''; this.className = '';
      this.classList = { contains: c => this.className.split(' ').includes(c), add: c => { if (!this.classList.contains(c)) this.className += ' ' + c; }, remove: c => (this.className = this.className.split(' ').filter(x => x !== c).join(' ')) };
    }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = v; if (k === 'class') this.className = v; if (k === 'value') this.value = String(v); if (k === 'disabled') this.disabled = true; if (k === 'hidden') this.hidden = true; }
    getAttribute(k) { if (k === 'id') return this.id; if (k === 'class') return this.className; return this.attrs[k]; }
    append(...nodes) { for (const n of nodes) { if (n.parentNode) n.remove(); n.parentNode = this; this.children.push(n); } }
    insertBefore(n, b) { if (!b) return this.append(n); n.parentNode = this; this.children.splice(this.children.indexOf(b), 0, n); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; }
    set innerHTML(html) {
      this.children = []; const stack = [this];
      for (const m of html.matchAll(/(<[^>]*>)|([^<]+)/g)) {
        if (m[2]) { stack.at(-1).textContent += m[2]; continue; }
        const t = m[1]; if (t.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
        const tag = t.match(/^<([\w-]+)/)[1], el = new El(tag);
        for (const a of t.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.setAttribute(a[1], a[2] ?? a[3] ?? a[4] ?? '');
        stack.at(-1).append(el); if (!['input', 'br', 'hr', 'img', 'meta', 'link'].includes(tag)) stack.push(el);
      }
    }
    querySelectorAll(s) { return descendants(this).filter(el => s.split(',').some(q => matches(el, q))); }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
    closest(s) { let el = this; while (el) { if (s.split(',').some(q => matches(el, q))) return el; el = el.parentNode; } return null; }
    addEventListener(n, f) { (this.events[n] ??= []).push(f); }
    showModal() { this.open = true; } close() { this.open = false; for (const f of this.events.close || []) f(); }
    getContext() { return new Proxy({ createLinearGradient: () => ({ addColorStop() {} }) }, { get: (o, k) => (k in o ? o[k] : () => {}) }); }
    setPointerCapture() {}
  }
  const body = new El('body');
  const header = new El('header'); header.id = 'mainHeader';
  const top = new El('div'); top.className = 'top-row'; const gear = new El('button'); gear.className = 'gear-btn'; top.append(gear);
  header.append(top); body.append(header);
  const settings = new El('div'); settings.id = 'settingsModal'; const mb = new El('div'); mb.className = 'modal-body'; settings.append(mb); body.append(settings);
  const adminSlot = new El('div'); adminSlot.id = 'admin-game-settings-slot'; body.append(adminSlot);
  const joke = new El('aside'); joke.id = 'road-joke-toast'; joke.hidden = true; body.append(joke);

  require('../../test-app/source/features/road-arcade-core.js');
  const C = global.RoadArcadeCore;
  const handlers = {}, player = { ...C.initialPlayer('u', 'u@x', 'User'), net: 200, unlocked: 20 }, head = C.initialHead();
  let transactCalls = 0, pending = { id: 'p1', kind: 'slot', roll: 2500, createdAt: Date.now() }, readyState = false;
  const A = {
    visible: () => true, available: () => true, me: () => player, balance: () => 200, head: () => head, players: () => ({ u: player }), recent: () => [],
    status: () => ({ ready: readyState, error: readyState ? '' : 'Нет связи с игровым банком Ubuntu.' }),
    readSpin: () => pending, storeSpin: x => (pending = x), newSpin: () => ({ id: 'n', kind: 'slot', roll: 1, createdAt: Date.now() }),
    subscribe: () => () => {},
    // Настоящий transact сам отказывает, пока банк не синхронизирован.
    transact: async () => {
      if (!readyState) throw Error('Дождитесь связи и синхронизации кошелька.');
      transactCalls++;
      return { payout: 12, cost: 10, delta: 2, result: { type: 'small', symbols: ['🍒', '🍒', '🍒'] } };
    }
  };
  const ctx = {
    window: { RoadArcade: A, RoadArcadeCore: C, addEventListener: (n, f) => (handlers[n] = f), dispatchEvent: e => handlers[e.type]?.() },
    document: { body, hidden: false, createElement: t => new El(t), querySelector: s => body.querySelector(s), querySelectorAll: s => body.querySelectorAll(s), getElementById: id => body.querySelector('#' + id), addEventListener: (n, f) => (handlers[n] = f) },
    escapeHtml: String, resolveUserDisplayName: (e, n) => n, state: { shift: { id: 's', isActive: true } },
    currentUid: 'u', currentEmail: 'u@x', currentUserStatus: 'active', currentUserRole: 'admin', permissionsLoaded: true, appConfig: { testReviewFlags: {} },
    canAdmin: () => true, getUserName: () => 'User', firebaseConfig: { projectId: 'p' }, WORKSPACE_ID: 'w',
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, showError: e => { throw Error(e); }, closeSettingsModal() {},
    setInterval: () => 0, clearInterval: () => {}, setTimeout: f => { f(); return 0; }, clearTimeout: () => {}, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    performance: { now: () => 1000 }, Event, console, SpeechSynthesisUtterance: class {}, matchMedia: () => ({ matches: false }),
    isNasRuntime: () => false, nasSaveSettings: async () => {}
  };
  ctx.appConfigRef = { set: async () => {} };
  vm.createContext(ctx);
  vm.runInContext(read('test-app/source/features/road-arcade-ui.js'), ctx);

  ctx.window.openRoadArcade('slot');
  const dialog = body.querySelector('#arcade-dialog');
  assert.ok(dialog.open, 'экран автомата не открылся');
  const spinBtn = body.querySelector('#slot-spin');
  assert.ok(spinBtn, 'кнопка вращения не найдена');
  assert.strictEqual(spinBtn.disabled, false, 'кнопка не должна быть заблокирована при незавершённом вращении');

  spinBtn.onclick();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(transactCalls, 0, 'пока банк не готов, ставка не должна проходить');
  assert.deepStrictEqual(pending, { id: 'p1', kind: 'slot', roll: 2500, createdAt: pending.createdAt }, 'незавершённое вращение сохраняется до восстановления связи');
  const slotResult = body.querySelector('#slot-result');
  assert.ok(slotResult && /связи|синхронизации/i.test(slotResult.textContent), 'нажатие обязано объяснить причину, а не молчать');

  // Когда банк готов — то же нажатие проверяет незавершённое вращение и снимает его.
  readyState = true;
  spinBtn.onclick();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(transactCalls, 1, 'при готовом банке ставка проверяется');
  assert.strictEqual(pending, null, 'после успешной проверки запись снимается');
  console.log('B) кнопка автомата: не блокируется, объясняет причину и проводит проверку вращения — ok');
  console.log('Автомат: регрессия незавершённого вращения пройдена');
})().catch(e => { console.error(e); process.exitCode = 1; });
// ---------- Часть C: ставка проходит только при подтверждённой серверной сессии ----------
// Регрессия: в режиме Ubuntu (NAS) флаги profileServerConfirmed/permissionsServerConfirmed
// не выставлялись, поэтому isAuthSessionReady() всегда был false и любая ставка
// отклонялась сообщением «Дождитесь связи и синхронизации кошелька», хотя кошелёк
// показывал готовность.
(async () => {
  const store = new Map();
  let sessionReady = false, nasCalls = 0;
  const head = { gameRound: 5, bank: 1000, totalStakes: 0, totalPayouts: 0, actors: {} };
  const ctx = {
    window: {
      RoadArcadeCore: (() => { require('../../test-app/source/features/road-arcade-core.js'); return global.RoadArcadeCore; })(),
      addEventListener: () => {}, __gameEconomy: { snapshot: () => ({ enabled: true, ready: true, earned: 100, records: [], adjustments: [] }) }
    },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    firebaseConfig: { projectId: 'p' }, WORKSPACE_ID: 'w', currentUid: 'u', currentEmail: 'u@x',
    permissionsLoaded: true, currentUserStatus: 'active', currentUserRole: 'admin',
    appConfig: { testReviewFlags: {} }, state: { shift: { id: 's', isActive: true } },
    isNasRuntime: () => true, nasStorageScope: () => 'scope', nasGameReady: true,
    nasGameSnapshot: { head, players: {}, records: [] },
    isAuthSessionReady: () => sessionReady, authSessionGeneration: 1,
    nasGameAction: async () => { nasCalls++; return { payout: 12, cost: 10, delta: 2, result: { type: 'small', symbols: ['🍒', '🍒', '🍒'] } }; },
    getUserName: () => 'User', escapeHtml: String, navigator: { onLine: true },
    crypto: { randomUUID: () => 'uuid', getRandomValues: a => a.fill(1) },
    setInterval: () => 0, clearInterval: () => {}, console, Date, JSON, Number, Error, Promise
  };
  ctx.globalThis = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(read('test-app/source/features/road-arcade-runtime.js'), ctx);
  const A = ctx.window.RoadArcade;
  assert.ok(A && typeof A.transact === 'function', 'runtime не отдал transact');

  await assert.rejects(() => A.transact({ id: 'c1', kind: 'slot', roll: 1 }), /синхронизации кошелька/,
    'без подтверждённой серверной сессии ставка обязана отклоняться');
  assert.strictEqual(nasCalls, 0, 'до подтверждения сессии сервер не должен получать ставку');

  sessionReady = true;
  const result = await A.transact({ id: 'c2', kind: 'slot', roll: 1 });
  assert.strictEqual(nasCalls, 1, 'при подтверждённой сессии ставка уходит на сервер');
  assert.strictEqual(result.payout, 12, 'результат сервера возвращается как есть');
  console.log('C) ставка проходит только при подтверждённой серверной сессии — ok');

  // ---------- Часть D: контракт источника — сессия NAS подтверждает профиль и права ----------
  const nas = read('test-app/source/core/21-nas-runtime.js');
  assert.match(nas, /profileServerConfirmed=!!active;permissionsServerConfirmed=!!active;/,
    'applyNasSession обязан подтверждать профиль и права серверной сессией');
  assert.match(nas, /async function startNasRuntime\(user\) \{[\s\S]{0,300}?profileServerConfirmed=false;permissionsServerConfirmed=false;/,
    'до первой серверной сессии подтверждения быть не должно');
  const stopSync = read('test-app/source/core/03-formatting.js');
  assert.doesNotMatch(stopSync, /stopNasRuntime\(\)[\s\S]{0,400}?profileServerConfirmed=false/,
    'stopNasRuntime нельзя сбрасывать подтверждение: stopSync вызывается и в режиме Firebase');
  console.log('D) NAS-сессия подтверждает профиль и права, Firebase-путь не задет — ok');
  console.log('Автомат: подтверждение сессии и ставка — регрессия пройдена');
})().catch(e => { console.error(e); process.exitCode = 1; });
