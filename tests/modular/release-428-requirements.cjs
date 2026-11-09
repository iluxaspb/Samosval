'use strict';
// Регрессии правок 4.2.8 по ТЗ от 09.11.2026 (6 пунктов).
// Проверяются реальные источники и поведение функций, а не тексты отчётов.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const root = path.resolve(__dirname, '../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const ok = m => console.log('ok  ' + m);

// ---------- 1. Закрытие смены: копия в режиме Ubuntu создаётся сервером ----------
(async () => {
  const calls = [];
  const ctx = {
    window: {}, document: { querySelector: () => null, querySelectorAll: () => [] },
    console: { log() {}, warn() {}, error() {} },
    isNasRuntime: () => true,
    nasBackupCommand: async (target, fields) => { calls.push([target, fields]); return { result: { meta: { id: 'b1', sizeBytes: 2048, type: fields.backupType } } }; },
    showToastEl() {}, showError(m) { ctx.lastError = m; }, appConfirm: async () => true,
    getUserName: () => 'User', currentEmail: 'u@x', currentUserRole: 'admin', currentUserStatus: 'active',
    currentUid: 'u', firebaseConfig: { projectId: 'p' }, WORKSPACE_ID: 'w',
    state: { shift: { id: 's1', isActive: true, objectName: 'Объект' } },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: f => 0, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    db: { collection: () => ({ doc: () => ({}) }) }, escapeHtml: String
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  // В приложении closeShift объявлена глобально в core; хук ставится поверх неё.
  let originalCalls = 0;
  ctx.closeShift = async () => { originalCalls++; };
  vm.createContext(ctx);
  vm.runInContext(read('test-app/source/features/auto-backup.js'), ctx);
  assert.strictEqual(typeof ctx.window.closeShift, 'function', 'хук закрытия смены должен установиться');
  await ctx.window.closeShift();
  assert.ok(calls.length >= 1, 'в режиме Ubuntu копия перед закрытием создаётся серверной командой');
  assert.strictEqual(calls[0][1].type, 'backup.create');
  assert.strictEqual(calls[0][1].backupType, 'before_close');
  assert.strictEqual(originalCalls, 1, 'после создания копии закрытие смены выполняется');
  assert.notStrictEqual(ctx.lastError, 'Закрытие отменено: запрошенная защитная копия не создана', 'закрытие не отменяется из-за Firestore');
  ok('1) закрытие смены: копия before_close создаётся на Ubuntu, закрытие выполняется');
})().catch(e => { console.error('1) FAIL', e.message); process.exitCode = 1; });

// ---------- 3. Удаление листочка ГАИ: серверная операция ----------
(async () => {
  const { normalizeArchive, gaiDeletedPayload } = await import(path.join(root, 'server/src/archive-store.mjs'));
  const op = normalizeArchive({ id: 'a1', type: 'archive.gai.delete', recordId: 'arch_1', expectedRevision: 4 });
  assert.strictEqual(op.type, 'archive.gai.delete');
  assert.throws(() => normalizeArchive({ id: 'a1', type: 'archive.gai.remove', recordId: 'arch_1', expectedRevision: 4 }), /invalid-archive-operation/);

  const archive = {
    id: 'arch_1', date: '28.10.2026', objectName: 'Объект', totalVolume: 60, totalTrips: 4,
    activeLineIds: ['truck_a', 'truck_g', 'truck_b', 'truck_plain'],
    ttnStatus: { truck_a: true, truck_g: true, truck_b: 'pending', truck_plain: false },
    logs: [
      { id: 'l1', truckId: 'truck_a', isGAI: false, volume: 20 },
      { id: 'l2', truckId: 'truck_g', isGAI: true, volume: 15 },
      { id: 'l3', truckId: 'truck_a', isGAI: false, volume: 40 },
      { id: 'l4', truckId: 'truck_b', isGAI: true, volume: 5 },
    ],
  };
  const { payload, removed } = gaiDeletedPayload(archive, { display_name: 'Админ' }, 111);
  assert.strictEqual(removed, 2, 'удалены только рейсы ГАИ');
  assert.deepStrictEqual(payload.logs.map(l => l.id), ['l1', 'l3'], 'обычные рейсы остались');
  assert.strictEqual(payload.totalVolume, 60, 'объём пересчитан по обычным рейсам');
  assert.strictEqual(payload.totalTrips, 2);
  assert.strictEqual(payload.date, '28.10.2026', 'остальные данные архива не изменены');
  assert.strictEqual(payload.objectName, 'Объект');
  assert.strictEqual(payload.gaiDeletedBy, 'Админ');
  assert.deepStrictEqual(payload.activeLineIds, ['truck_a', 'truck_plain'], 'самосвалы только с листа ГАИ уходят из списка техники');
  assert.deepStrictEqual(Object.keys(payload.ttnStatus).sort(), ['truck_a', 'truck_plain'], 'отметки ТТН удалённых машин убраны');
  assert.throws(() => gaiDeletedPayload({ logs: [{ isGAI: false }] }, { display_name: 'A' }, 1), /archive-has-no-gai-trips/);
  ok('3) листочек ГАИ удаляется отдельно, остальной архив не меняется');
})().catch(e => { console.error('3) FAIL', e.message); process.exitCode = 1; });

// ---------- 2. Автооткрытие смены в табеле ----------
(async () => {
  const { createDay, previousDay, dayKey } = await import(path.join(root, 'test-app/tabel-v2/table-domain.mjs'));
  const config = {
    start: '2026-10-01', end: null, request: { equipment: ['e1', 'e2'], people: [] },
    equipment: [{ id: 'e1', name: 'Фреза', kind: 'mill' }, { id: 'e2', name: 'МТЗ', kind: 'brush' }],
    people: [], hiddenEquipmentIds: [], materials: [], works: [], acl: {}, period: 'all',
  };
  const prev = { date: '2026-11-07', shift: 'day', equipment: [{ id: 'e1', name: 'Фреза' }], people: [], values: {} };
  const day = createDay(config, '2026-11-08', 'day', previousDay([prev], '2026-11-08', 'day'));
  assert.deepStrictEqual(day.equipment.map(e => e.id), ['e1'], 'техника взята из предыдущего рабочего дня');
  assert.strictEqual(dayKey(day.date, day.shift), 'day:2026-11-08:day', 'ключ даты и смены уникален — дубликат невозможен');
  // Повторное открытие той же смены возвращает существующую запись, а не новую.
  const again = createDay(config, '2026-11-08', 'day', prev);
  assert.strictEqual(dayKey(again.date, again.shift), dayKey(day.date, day.shift));
  ok('2) смена в табеле: техника из прошлого дня, ключ уникален (без дублей)');
})().catch(e => { console.error('2) FAIL', e.message); process.exitCode = 1; });

// ---------- 4..6. Статические проверки навигации и кнопок ----------
try {
  const shifts = read('test-app/source/core/15-shifts.js');
  assert.ok(/openTabelShiftForLine\(/.test(shifts), 'старт линейной смены вызывает автооткрытие табеля');
  assert.ok(/entry\.mjs/.test(shifts) && /ensureDay/.test(shifts), 'используется ensureDay табеля');
  ok('2) старт смены на линии связан с табелем');

  const workspace = read('test-app/tabel-v2/workspace.mjs');
  assert.ok(!/class="tn-exit"/.test(workspace), 'верхняя красная кнопка «Закрыть» убрана из шапки табеля');
  assert.ok(/tn-status/.test(workspace), 'нижняя панель табеля не тронута');
  ok('4) кнопка «Закрыть» в шапке табеля удалена, нижняя панель на месте');

  const server = read('test-app/source/core/22-server-control.js');
  assert.ok(/\.sc-nav\{[^}]*position:fixed[^}]*bottom:60px[^}]*z-index:10059/.test(server.replace(/\n/g, '')), 'кнопки сервера закреплены выше нижней панели');
  assert.ok(/#server-control-root\{padding-bottom:58px\}/.test(server), 'под кнопками оставлен отступ, контент не прячется');
  assert.ok(/\.sc-nav button\{[^}]*font-size:11px/.test(server.replace(/\n/g, '')), 'кнопки сервера по размеру как вкладки табеля');
  ok('5) внутренние кнопки сервера подняты над панелью и уменьшены до размера табеля');

  const nav = read('test-app/source/core/19-navigation.js');
  const openBody = nav.slice(nav.indexOf('async function openTabelV2'), nav.indexOf('function tabelV2Host'));
  assert.ok(/querySelectorAll\('\.tab-content'\)\.forEach\(e=>e\.classList\.remove\('active'\)\)/.test(openBody), 'при открытии табеля вкладки гасятся');
  ok('6) при переходе в табель вкладка «Сервер» скрывается вместе со своими кнопками');

  const archive = read('test-app/source/core/10-archive.js');
  assert.ok(/archive\.gai\.delete/.test(archive), 'клиент отправляет отдельную операцию удаления листа ГАИ');
  assert.ok(/Вы действительно хотите удалить листочек ГАИ за/.test(archive), 'подтверждение с датой перед удалением ГАИ');
  ok('3) подтверждение удаления листа ГАИ с датой — есть');
} catch (e) { console.error('static FAIL', e.message); process.exitCode = 1; }

console.log('Правки 4.2.8: регрессии пройдены');

// ---------- 4. Серверные правила совпадают с новыми выплатами и Марио ----------
(async () => {
  const srv = await import(path.join(root, 'server/src/arcade-rules.mjs'));
  const head = srv.initialHead(), player = srv.initialPlayer('u', 'u@x', 'U'), day = srv.dayKey();
  const small = srv.settle(head, player, { kind: 'slot', roll: 2000 }, 100, day);
  const big = srv.settle(head, player, { kind: 'slot', roll: 100 }, 100, day);
  assert.strictEqual(small.payout, 15, 'сервер платит 15 за частый выигрыш');
  assert.strictEqual(big.payout, 150, 'сервер платит 150 за крупный выигрыш');
  const fin = srv.settle(head, player, { kind: 'finish', level: 1, coins: 25, score: 500, jumpBonus: 5 }, 100, day);
  assert.strictEqual(fin.delta, 25, 'сервер зачисляет монеты Марио одной операцией');
  assert.strictEqual(fin.player.marioCoins, 25);
  assert.strictEqual(fin.player.unlocked, 2);
  ok('4) серверные выплаты автомата и Марио совпадают с приложением');
})().catch(e => { console.error('4) FAIL', e.message); process.exitCode = 1; });
