import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Регрессия «подмены комбинации» автомата: барабаны останавливаются на одной
// комбинации (например три звезды), а через секунду кадры меняются на другую
// (три вишни). Железное правило: ЧТО ОСТАНОВИЛОСЬ — ТО ОСТАНОВИЛОСЬ.
// Результат фиксируется до анимации остановки, после остановки символы не
// перерисовываются, выплата соответствует показанной комбинации.

const coreSource = readFileSync(new URL('./road-arcade-core.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('./road-arcade-ui.js', import.meta.url), 'utf8');
const nasSource = readFileSync(new URL('../core/21-nas-runtime.js', import.meta.url), 'utf8');

function loadCore() {
  const sandbox = {};
  vm.runInNewContext(coreSource, sandbox);
  return sandbox.RoadArcadeCore;
}

function spinBody() {
  const start = uiSource.indexOf('async function spin(){');
  assert.ok(start > 0, 'функция spin() не найдена');
  let depth = 0, i = uiSource.indexOf('{', start);
  const from = i;
  for (; i < uiSource.length; i++) {
    if (uiSource[i] === '{') depth++;
    else if (uiSource[i] === '}') { depth--; if (depth === 0) return uiSource.slice(from, i + 1); }
  }
  throw new Error('не удалось выделить тело spin()');
}

const body = spinBody();

test('после остановки барабанов символы не перерисовываются (нет подмены)', () => {
  const transactAt = body.indexOf('await A.transact(operation)');
  assert.ok(transactAt > 0, 'нет вызова A.transact(operation)');
  // Транзакция уходит ПОСЛЕ остановки барабанов; всё, что присылает сервер,
  // не должно менять уже показанную комбинацию — иначе видна подмена.
  assert.ok(!/slotSymbols\s*=/.test(body.slice(transactAt)),
    'после A.transact(operation) символы барабанов менять нельзя — игрок видит подмену результата');
});

test('комбинация фиксируется до анимации остановки и барабаны останавливаются на ней', () => {
  const previewAt = body.indexOf('C.slotOutcome(operation.roll');
  const targetsAt = body.indexOf('reelAnim.targets=');
  assert.ok(previewAt > 0, 'нет предварительного расчёта символов из operation.roll');
  assert.ok(targetsAt > previewAt, 'цели остановки барабанов должны строиться из заранее зафиксированной комбинации');
});

test('клиент Ubuntu передаёт зафиксированный бросок на сервер, а не выбрасывает его', () => {
  assert.ok(!/\{\s*id\s*,\s*roll\s*,\s*\.\.\.gameAction\s*\}\s*=\s*action/.test(nasSource),
    'nasGameAction выбрасывает roll из запроса — сервер бросает своё число и подменяет показанную комбинацию');
});

test('выплата соответствует показанной после остановки комбинации', () => {
  const C = loadCore();
  const head = C.initialHead(), player = C.initialPlayer('u', 'u@example.test', 'U');
  // Границы всех типов исходов: джекпот, крупный, средний, частый, проигрыш.
  for (const roll of [0, 1, 149, 150, 949, 950, 4349, 4350, 5000, 9999]) {
    const preview = C.slotOutcome(roll, head.bank);
    const settled = C.settle(head, player, { kind: 'slot', roll }, 10000, '2026-11-23');
    assert.deepEqual(settled.result.symbols, preview.symbols, `roll=${roll}: расчёт выплаты по другим символам, чем показано`);
    assert.equal(settled.payout, preview.payout, `roll=${roll}: выплата не соответствует показанной комбинации`);
  }
});

test('повторные спины независимы, но результат каждого стабилен после остановки', () => {
  const C = loadCore();
  const head = C.initialHead(), player = C.initialPlayer('u', 'u@example.test', 'U');
  const play = roll => C.settle(head, player, { kind: 'slot', roll }, 10000, '2026-11-23');
  // Стабильность: тот же бросок даёт ту же комбинацию и выплату.
  const first = play(150), repeat = play(150);
  assert.deepEqual(repeat.result.symbols, first.result.symbols);
  assert.equal(repeat.payout, first.payout);
  // Независимость: другой бросок даёт свой результат, а не «докрутку» первого.
  const other = play(950);
  assert.notDeepEqual(other.result.symbols, first.result.symbols);
  assert.notEqual(other.payout, first.payout);
});
