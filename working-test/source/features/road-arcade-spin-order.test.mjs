import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Регрессия: в автомате ставка и выплата должны записываться ТОЛЬКО после
// остановки барабанов. Раньше A.transact(operation) вызывался сразу после
// нажатия «Вращать», и кошелёк менялся до окончания анимации.
const source = readFileSync(new URL('./road-arcade-ui.js', import.meta.url), 'utf8');

function spinBody() {
  const start = source.indexOf('async function spin(){');
  assert.ok(start > 0, 'функция spin() не найдена');
  let depth = 0, i = source.indexOf('{', start);
  const from = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(from, i + 1); }
  }
  throw new Error('не удалось выделить тело spin()');
}

const body = spinBody();

test('ставка записывается после ожидания остановки барабанов', () => {
  const waitAt = body.indexOf('await Promise.race([Promise.all([spinDonePromise');
  const transactAt = body.indexOf('await A.transact(operation)');
  assert.ok(waitAt > 0, 'нет ожидания остановки барабанов (spinDonePromise)');
  assert.ok(transactAt > 0, 'нет вызова A.transact(operation)');
  assert.ok(transactAt > waitAt, 'A.transact вызывается ДО остановки барабанов — баланс меняется во время вращения');
});

test('до остановки барабанов нет ни одной записи транзакции', () => {
  const waitAt = body.indexOf('await Promise.race([Promise.all([spinDonePromise');
  const before = body.slice(0, waitAt);
  assert.ok(!/A\.transact\s*\(/.test(before), 'до остановки барабанов не должно быть вызова A.transact');
});

test('повторное нажатие во время вращения блокируется флагом slotBusy', () => {
  assert.match(body.slice(0, body.indexOf(';') + 1), /if\s*\(\s*slotBusy\s*\)\s*return/,
    'первая строка spin() должна выходить при slotBusy, иначе быстрые клики задвоят ставку');
});

test('символы барабанов вычисляются из сохранённого броска до записи ставки', () => {
  const previewAt = body.indexOf('C.slotOutcome(operation.roll');
  const transactAt = body.indexOf('await A.transact(operation)');
  assert.ok(previewAt > 0, 'нет предварительного расчёта символов из operation.roll');
  assert.ok(previewAt < transactAt, 'символы должны рассчитываться до записи ставки');
});