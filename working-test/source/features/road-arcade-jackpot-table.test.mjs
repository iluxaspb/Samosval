import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Таблица выплат автомата «Джекпот» по решению владельца от 23.11.2026.
// Классика: три одинаковых символа платят по нарастающей, ровно две вишни —
// утешительные 5 монет, разнобой — ничего. Ставка BET=10, отдача ~96%.
// Таблица ниже — СПЕЦИФИКАЦИЯ для проверки, а не копия кода.

const coreSource = readFileSync(new URL('./road-arcade-core.js', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('./road-arcade-runtime.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('./road-arcade-ui.js', import.meta.url), 'utf8');

function loadCore() {
  const sandbox = {};
  vm.runInNewContext(coreSource, sandbox);
  return sandbox.RoadArcadeCore;
}

const PAYTABLE = {
  jackpot: { symbols: ['👑','👑','👑'], payout: 'bank' },
  seven:   { symbols: ['7️⃣','7️⃣','7️⃣'], payout: 500 },
  diamond: { symbols: ['💎','💎','💎'], payout: 150 },
  cone:    { symbols: ['🚧','🚧','🚧'], payout: 70 },
  lemon:   { symbols: ['🍋','🍋','🍋'], payout: 50 },
  bell:    { symbols: ['🔔','🔔','🔔'], payout: 40 },
  star:    { symbols: ['⭐','⭐','⭐'], payout: 30 },
  cherry:  { symbols: ['🍒','🍒','🍒'], payout: 20 },
  cherry2: { payout: 5 },
  loss:    { payout: 0 }
};
const BANK = 1000, BET = 10;

test('таблица выплат: все 10 000 бросков дают символы и выплату по типу', () => {
  const C = loadCore();
  for (let roll = 0; roll < 10000; roll++) {
    const outcome = C.slotOutcome(roll, BANK);
    const expected = PAYTABLE[outcome.type];
    assert.ok(expected, `roll=${roll}: неизвестный тип ${outcome.type}`);
    if (expected.symbols) {
      assert.equal(outcome.symbols.join('|'), expected.symbols.join('|'), `roll=${roll}: символы не соответствуют типу ${outcome.type}`);
      assert.equal(outcome.payout, expected.payout === 'bank' ? BANK + BET : expected.payout, `roll=${roll}: выплата не по таблице для ${outcome.type}`);
    } else if (outcome.type === 'cherry2') {
      const cherries = outcome.symbols.filter(s => s === '🍒').length;
      assert.equal(cherries, 2, `roll=${roll}: «две вишни» показывают ${cherries} вишен`);
      assert.equal(outcome.payout, 5, `roll=${roll}: две вишни должны платить 5`);
    } else {
      assert.equal(outcome.payout, 0, `roll=${roll}: проигрыш платит ${outcome.payout}`);
      const [a, b, c] = outcome.symbols;
      assert.ok(a !== b && b !== c && a !== c, `roll=${roll}: проигрыш показывает совпадение ${outcome.symbols}`);
      assert.ok(!outcome.symbols.includes('🍒'), `roll=${roll}: проигрыш с вишнями обманывает игрока: ${outcome.symbols}`);
    }
  }
});

test('показанная комбинация всегда честна: совпадение платит, разнобой — нет', () => {
  const C = loadCore();
  for (let roll = 0; roll < 10000; roll++) {
    const { symbols, payout } = C.slotOutcome(roll, BANK);
    const same = symbols[0] === symbols[1] && symbols[1] === symbols[2];
    const cherries = symbols.filter(s => s === '🍒').length;
    if (same) assert.ok(payout > 0, `roll=${roll}: три одинаковых ${symbols[0]} не платят — обман`);
    else if (cherries === 2) assert.equal(payout, 5, `roll=${roll}: две вишни должны платить 5`);
    else assert.equal(payout, 0, `roll=${roll}: разнобой ${symbols} платит ${payout}`);
  }
});

test('суммарная отдача всех 10 000 бросков в границах 93–100% ставки', () => {
  const C = loadCore();
  let total = 0;
  for (let roll = 0; roll < 10000; roll++) {
    const outcome = C.slotOutcome(roll, BANK);
    // Джекпот платит «банк + ставка» — величина переменная, поэтому для
    // расчёта отдачи фиксируем его щедрой константой (см. задание).
    total += outcome.type === 'jackpot' ? 1000 : outcome.payout;
  }
  const stakes = 10000 * BET;
  assert.ok(total / stakes >= 0.93 && total / stakes <= 1.00,
    `отдача ${(total / stakes * 100).toFixed(2)}% вне диапазона 93–100% (сумма ${total} при ставках ${stakes})`);
});

test('ровно две вишни — 5 монет, три вишни — 20: комбинации различаются', () => {
  const C = loadCore();
  let twoRoll = -1, threeRoll = -1;
  for (let roll = 0; roll < 10000; roll++) {
    const o = C.slotOutcome(roll, BANK);
    if (o.type === 'cherry2' && twoRoll < 0) twoRoll = roll;
    if (o.type === 'cherry' && threeRoll < 0) threeRoll = roll;
  }
  assert.ok(twoRoll >= 0, 'в таблице нет комбинации «ровно две вишни»');
  assert.ok(threeRoll >= 0, 'в таблице нет комбинации «три вишни»');
  const two = C.slotOutcome(twoRoll, BANK), three = C.slotOutcome(threeRoll, BANK);
  assert.equal(two.payout, 5);
  assert.equal(three.payout, 20);
  assert.equal(two.symbols.filter(s => s === '🍒').length, 2);
  assert.equal(three.symbols.filter(s => s === '🍒').length, 3);
});

test('джекпот выпадает не чаще 1 из 10 000 бросков', () => {
  const C = loadCore();
  let count = 0;
  for (let roll = 0; roll < 10000; roll++) if (C.slotOutcome(roll, BANK).type === 'jackpot') count++;
  assert.ok(count >= 1, 'джекпот недостижим вообще — автомат обманывает');
  assert.ok(count <= 10000 / 10000, `джекпот выпадает ${count} раз из 10 000 — чаще разрешения`);
});

test('ЖЕЛЕЗНОЕ ПРАВИЛО: администратору джекпот не выпадает ни на одном броске', () => {
  const C = loadCore();
  const head = C.initialHead(), player = C.initialPlayer('admin', 'admin@example.test', 'Admin');
  for (let roll = 0; roll < 10000; roll++) {
    const preview = C.slotOutcome(roll, head.bank, { isAdmin: true });
    assert.notEqual(preview.type, 'jackpot', `roll=${roll}: администратору выпал джекпот`);
    const settled = C.settle(head, player, { kind: 'slot', roll }, 10000, '2026-11-23', { isAdmin: true });
    assert.notEqual(settled.result.type, 'jackpot', `roll=${roll}: settle вернул администратору джекпот`);
    assert.deepEqual(settled.result.symbols, preview.symbols, `roll=${roll}: settle и предрасчёт разошлись для администратора`);
    assert.equal(settled.payout, preview.payout, `roll=${roll}: выплата разошлась с символами для администратора`);
  }
  // Единственный джекпотный бросок для админа детерминированно заменяется.
  const corrected = C.slotOutcome(0, head.bank, { isAdmin: true });
  assert.equal(corrected.payout, 0);
  assert.equal(new Set(corrected.symbols).size, 3);
});

test('обычному игроку джекпот по-прежнему выпадает и платит весь банк со ставкой', () => {
  const C = loadCore();
  const head = C.initialHead(), player = C.initialPlayer('u', 'u@example.test', 'U');
  const outcome = C.slotOutcome(0, head.bank);
  assert.equal(outcome.type, 'jackpot');
  assert.deepEqual([...outcome.symbols], ['👑','👑','👑']);
  assert.equal(outcome.payout, head.bank + BET);
  const settled = C.settle(head, player, { kind: 'slot', roll: 0 }, 10000, '2026-11-23');
  assert.equal(settled.result.type, 'jackpot');
  assert.equal(settled.payout, head.bank + BET);
  assert.equal(settled.player.jackpots, 1);
});

test('клиент и сервер согласованы для администратора: roll уводится из джекпота до анимации', () => {
  // Runtime генерирует бросок без джекпотного диапазона для админа — тогда
  // барабаны никогда не остановятся на трёх коронах, и серверу нечего менять.
  assert.match(runtimeSource, /currentUserRole==='admin'&&base===0\?9999:base/,
    'newSpin для администратора не уводит бросок из джекпот-диапазона');
  // Предрасчёт символов в spin() передаёт тот же флаг — даже повтор старой
  // записи с roll=0 покажет администратору согласованный результат.
  assert.match(uiSource, /C\.slotOutcome\(operation\.roll,[\s\S]*?currentUserRole==='admin'/,
    'предрасчёт символов в spin() не передаёт флаг администратора');
});
