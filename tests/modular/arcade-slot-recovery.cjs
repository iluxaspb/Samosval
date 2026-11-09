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

// ---------- Часть E: поведение applyNasSession на настоящем исходнике ----------
// Выполняем реальную функцию из 21-nas-runtime.js и проверяем, что серверная
// сессия делает isAuthSessionReady() истинным, а неактивная — ложным.
{
  const nas = read('test-app/source/core/21-nas-runtime.js');
  const start = nas.indexOf('function applyNasSession(session)');
  assert.ok(start > 0, 'applyNasSession не найден');
  let depth = 0, end = -1;
  for (let i = nas.indexOf('{', start); i < nas.length; i++) {
    if (nas[i] === '{') depth++;
    else if (nas[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, 'не удалось выделить тело applyNasSession');
  const fnSource = nas.slice(start, end);

  const node = () => ({ style: {}, classList: { add() {}, remove() {} }, textContent: '' });
  const ctx = {
    currentUid: 'u1', currentEmail: 'u1@x', currentUserRole: null, currentUserStatus: null, currentUserNickname: '',
    permissionsConfig: {}, permissionsLoaded: false, profileServerConfirmed: false, permissionsServerConfirmed: false,
    nasAuthority: { provider: 'ubuntu', generation: 0 }, nasReadGeneration: 0, state: {}, appConfig: {},
    nasSettingsSnapshot: null, nasGameSnapshot: null, nasGameReady: true, nasGameReceiptFloor: 0,
    sanitizeName: () => 'User', markSync: () => {}, updateUserBadge: () => {}, updateNavUI: () => {},
    applyRoleUI: () => {}, renderAll: () => {}, cancelHold: () => {},
    document: { getElementById: () => node(), querySelector: () => node(), querySelectorAll: () => [], body: { setAttribute() {}, removeAttribute() {} } },
    window: { dispatchEvent: () => {}, __gameAccessChanged: null },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
    console, JSON
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext('var __f = ' + fnSource.replace(/^function applyNasSession/, 'function') + ';', ctx);

  const session = { identityReady: true, profile: { status: 'active', deleted: false, role: 'admin', nickname: 'Админ' },
    permissions: { tabs: ['line', 'timesheet'], actions: [] }, authority: { provider: 'ubuntu', generation: 3 } };
  ctx.__f(session);
  assert.strictEqual(ctx.profileServerConfirmed, true, 'активная NAS-сессия обязана подтвердить профиль');
  assert.strictEqual(ctx.permissionsServerConfirmed, true, 'активная NAS-сессия обязана подтвердить права');
  assert.strictEqual(ctx.permissionsLoaded, true, 'права должны считаться загруженными');
  const ready = () => ctx.currentUserStatus === 'active' && !!ctx.currentUid && ctx.profileServerConfirmed && ctx.permissionsServerConfirmed;
  assert.strictEqual(ready(), true, 'серверная сессия должна открывать ставки (isAuthSessionReady)');

  ctx.__f({ identityReady: true, profile: { status: 'pending', deleted: false, role: 'viewer' }, permissions: { tabs: [], actions: [] } });
  assert.strictEqual(ctx.profileServerConfirmed, false, 'неактивная учётная запись не подтверждается');
  assert.strictEqual(ready(), false, 'без активной сессии ставки запрещены');
  console.log('E) applyNasSession подтверждает активную сессию и снимает подтверждение у неактивной — ok');
}

// ---------- Часть C: щедрые выплаты 4.2.9 ----------
{
  const C = global.RoadArcadeCore, bank = 1000;
  const types = [0, 1, 900, 2000, 9000].map(roll => C.slotOutcome(roll, bank).type);
  assert.deepStrictEqual(types, ['jackpot', 'big', 'medium', 'small', 'loss'], 'пороги выплат сдвинулись');
  assert.strictEqual(C.slotOutcome(1, bank).payout, 150, 'крупный выигрыш — 150');
  assert.strictEqual(C.slotOutcome(900, bank).payout, 30, 'средний выигрыш — 30');
  assert.strictEqual(C.slotOutcome(2000, bank).payout, 15, 'частый выигрыш — 15');
  assert.strictEqual(C.slotOutcome(0, bank).payout, bank + C.BET, 'джекпот забирает банк и ставку');
  assert.strictEqual(C.slotOutcome(9000, bank).payout, 0, 'проигрыш без выплаты');
  const expected = (3400 * 15 + 800 * 30 + 149 * 150) / 10000;
  assert(expected > 9.6 && expected < 10.2, 'отдача ставки ушла из разумных пределов: ' + expected);
  console.log('Автомат 4.2.9: выплаты 15/30/150 и джекпот, отдача ставки ~' + (expected * 10).toFixed(1) + '%');
}

// ---------- Часть D: Марио 4.2.13 — монеты из блоков, врагов и финиш ----------
{
  const C = global.RoadArcadeCore;
  let run = C.createRun(1);
  assert(run.map.blocks.some(b => b.kind === 'question'), 'в уровне есть блоки с вопросом');
  assert(run.map.coins.length >= 20 && run.map.enemies.length >= 3 && run.map.pipes.length >= 1, 'уровень содержит монеты, врагов и трубы');
  const qb = run.map.blocks.find(b => b.kind === 'question' && !b.used);
  run.lives = 99; run.player.x = qb.x + 8; run.player.y = qb.y + qb.h + 2; run.player.vy = -600; run.player.grounded = false;
  let blockCoin = null;
  for (let i = 0; i < 30 && !blockCoin; i++) C.advanceRun(run, { axis: 0, jump: false }, 1 / 60, e => { if (e.type === 'blockCoin') blockCoin = e; });
  assert(blockCoin && blockCoin.coins >= 1, 'удар по блоку «?» даёт монету');
  assert.strictEqual(run.coins, blockCoin.coins, 'монета из блока сразу попадает в счётчик');

  run = C.createRun(1); run.lives = 99;
  const enemy = run.map.enemies[0];
  run.player.x = enemy.x + 2; run.player.y = enemy.y - 40; run.player.vy = 200; run.player.grounded = false;
  let stomp = null;
  for (let i = 0; i < 30 && !stomp; i++) C.advanceRun(run, { axis: 0, jump: false }, 1 / 60, e => { if (e.type === 'stomp') stomp = e; });
  assert(stomp && !enemy.alive, 'прыжок на врага убивает его');
  assert.strictEqual(run.coins, 1, 'за убитого врага начисляется монета');

  run = C.createRun(1); run.lives = 99; run.map.enemies.forEach(e => e.alive = false);
  run.player.x = run.map.flag - 20; run.player.y = 380; run.maxJumpHeight = 110;
  let fin = null;
  for (let i = 0; i < 30 && !fin; i++) C.advanceRun(run, { axis: 1, jump: false }, 1 / 60, e => { if (e.type === 'finish') fin = e; });
  assert(fin, 'финиш у флажка срабатывает');
  assert.strictEqual(fin.bonus, 10, 'высокий прыжок даёт максимальный бонус');
  assert(fin.coins >= 10, 'бонус входит в итоговые монеты уровня');

  const settle = C.settle(C.initialHead(), C.initialPlayer('u', 'u@x', 'U'), { kind: 'finish', level: 1, coins: 25, score: 500, jumpBonus: 5 }, 100, C.dayKey());
  assert.strictEqual(settle.delta, 25, 'монеты уровня зачисляются в кошелёк одной операцией');
  assert.strictEqual(settle.player.marioCoins, 25);
  assert.strictEqual(settle.player.unlocked, 2, 'уровень открывает следующий');
  console.log('Марио 4.2.13: блоки, враги, монеты и бонус флажка — проверено');
}
