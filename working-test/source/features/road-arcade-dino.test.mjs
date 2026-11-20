import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Регрессия «Дино-бегун»: монеты зачисляются ТОЛЬКО по факту завершённого
// заезда (game over), одной операцией kind:'dino', с уникальным requestId
// на заезд — повторная отправка того же итога не должна задваивать начисление.

const coreSource = readFileSync(new URL('./road-arcade-core.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('./road-arcade-ui.js', import.meta.url), 'utf8');

function loadCore() {
  const sandbox = {};
  vm.runInNewContext(coreSource, sandbox);
  return sandbox.RoadArcadeCore;
}

function creditDinoBody() {
  const start = uiSource.indexOf('async function creditDino(event){');
  assert.ok(start > 0, 'функция creditDino не найдена');
  let depth = 0, i = uiSource.indexOf('{', start);
  const from = i;
  for (; i < uiSource.length; i++) {
    if (uiSource[i] === '{') depth++;
    else if (uiSource[i] === '}') { depth--; if (depth === 0) return uiSource.slice(from, i + 1); }
  }
  throw new Error('не удалось выделить тело creditDino()');
}

test('settle: заезд «Дино» платит собранные монеты одной выплатой, без ставки', () => {
  const C = loadCore();
  const head = C.initialHead(), player = C.initialPlayer('u', 'e@x', 'Имя');
  const out = C.settle(head, player, { kind: 'dino', coins: 5, score: 120 }, 0, '2026-11-13');
  assert.equal(out.payout, 5);
  assert.equal(out.delta, 5);
  assert.equal(out.cost, 0);
  assert.equal(out.player.net, 5);
  assert.equal(out.head.bank, head.bank, 'банк автомата не меняется — игра безставочная');
  assert.equal(out.result.type, 'dino_run');
});

test('settle: выплата «Дино» ограничена 99 монетами и не бывает отрицательной', () => {
  const C = loadCore();
  const head = C.initialHead(), player = C.initialPlayer('u', 'e@x', 'Имя');
  assert.equal(C.settle(head, player, { kind: 'dino', coins: 500 }, 0, 'd').payout, 99);
  assert.equal(C.settle(head, player, { kind: 'dino', coins: -3 }, 0, 'd').payout, 0);
  assert.equal(C.settle(head, player, { kind: 'dino' }, 0, 'd').payout, 0);
});

test('геймплей: столкновение завершает заезд (game over), монеты собираются по пути', () => {
  const C = loadCore();
  const run = C.createDinoRun();
  // Монета вплотную к динозаврику — подбирается на первом же шаге.
  run.coins.push({ id: 999, x: 56, y: C.DINO.GROUND_Y - 50, w: 22, h: 22 });
  run.obstacles.length = 0; run.nextSpawn = 99; run.nextCoin = 99;
  const events = [];
  C.advanceDinoRun(run, {}, 0.016, e => events.push(e));
  assert.equal(run.collected, 1, 'монета должна быть подобрана');
  assert.ok(!run.over, 'без препятствия заезд продолжается');
  // Препятствие вплотную — game over на следующем шаге.
  run.obstacles.push({ kind: 'cactus', x: 60, y: C.DINO.GROUND_Y - 40, w: 20, h: 40 });
  C.advanceDinoRun(run, {}, 0.016, e => events.push(e));
  assert.ok(run.over, 'столкновение обязано завершить заезд');
  const over = events.find(e => e.type === 'gameover');
  assert.ok(over, 'событие gameover должно прилететь ровно с итогом заезда');
  assert.equal(over.coins, 1);
  assert.equal(over.score, run.score);
  // После завершения логика замирает: повторные шаги ничего не начисляют.
  const score = run.score;
  C.advanceDinoRun(run, {}, 0.016, e => events.push(e));
  assert.equal(run.score, score);
  assert.equal(events.filter(e => e.type === 'gameover').length, 1, 'второго gameover быть не должно');
});

test('геймплей: скорость растёт со временем и ограничена максимумом', () => {
  const C = loadCore();
  const run = C.createDinoRun();
  run.obstacles.length = 0; run.coins.length = 0; run.nextSpawn = 1e9; run.nextCoin = 1e9;
  for (let i = 0; i < 600 && !run.over; i++) C.advanceDinoRun(run, {}, 0.016);
  assert.ok(run.speed > C.DINO.START_SPEED, 'скорость должна расти');
  assert.ok(run.speed <= C.DINO.MAX_SPEED + 1, 'скорость ограничена максимумом');
});

test('UI: зачисление только из события gameover, до него нет вызова транзакции', () => {
  const creditAt = uiSource.indexOf('async function creditDino');
  const gameOverAt = uiSource.indexOf("event.type==='gameover'");
  assert.ok(creditAt > 0 && gameOverAt > 0, 'нет функции зачисления или обработчика gameover');
  assert.ok(gameOverAt < creditAt || uiSource.indexOf("void creditDino(event)", gameOverAt) > 0,
    'creditDino должен вызываться из обработчика gameover');
  // Во всём UI-файле транзакция «Дино» встречается только внутри creditDino —
  // во время бега и сбора монет кошелёк молчит.
  const body = creditDinoBody();
  const dinoTransacts = uiSource.split("kind:'dino'").length - 1;
  assert.equal(dinoTransacts, 1, 'операция kind:dino должна отправляться ровно из одного места');
  assert.ok(body.includes("kind:'dino'"), 'операция kind:dino должна быть внутри creditDino');
});

test('UI: повторное начисление гасится флагом dinoBusy, requestId уникален на заезд', () => {
  const body = creditDinoBody();
  assert.match(body, /if\s*\(\s*!session\s*\|\|\s*dinoBusy\s*\)\s*return/,
    'creditDino обязан выходить при dinoBusy — иначе задвоение по двойному gameover');
  assert.match(body, /id:\s*'dino_'?\s*\+\s*session\.startedAt\s*\+\s*'_'?\s*\+\s*session\.runId/,
    'requestId должен строиться из уникальных данных заезда (идемпотентность на сервере)');
  assert.equal(body.split('A.transact').length - 1, 1, 'в creditDino ровно один вызов транзакции');
});
