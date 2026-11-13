import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Доработка 1.7.8: анимация ходьбы динозавра. Фаза бега накапливается в
// run.animT внутри advanceDinoRun (не зависит от fps, замирает на паузе),
// а drawDinoPlayer качает лапы противофазно (sin/cos), качает тело и хвост.

const coreSource = readFileSync(new URL('./road-arcade-core.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('./road-arcade-ui.js', import.meta.url), 'utf8');

function loadCore() {
  const sandbox = {};
  vm.runInNewContext(coreSource, sandbox);
  return sandbox.RoadArcadeCore;
}

test('advanceDinoRun: накапливает фазу анимации animT со временем', () => {
  const C = loadCore();
  const run = C.createDinoRun();
  assert.equal(run.animT, 0, 'новый заезд стартует с нулевой фазой');
  run.obstacles.length = 0; run.coins.length = 0; run.nextSpawn = 1e9; run.nextCoin = 1e9;
  for (let i = 0; i < 30; i++) C.advanceDinoRun(run, {}, 0.05);
  assert.ok(run.animT > 5, 'фаза растёт пропорционально времени и скорости');
  // пауза: пока advance не вызывается, фаза не меняется — она не в clock
  const frozen = run.animT;
  assert.equal(run.animT, frozen);
});

test('drawDinoPlayer: лапы качаются противофазно через sin/cos от фазы animT', () => {
  const at = uiSource.indexOf('function drawDinoPlayer(g,run,t){');
  assert.ok(at > 0, 'drawDinoPlayer не найден');
  let depth = 0, i = uiSource.indexOf('{', at);
  for (; i < uiSource.length; i++) {
    if (uiSource[i] === '{') depth++;
    else if (uiSource[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = uiSource.slice(at, i + 1);
  assert.match(body, /run\.animT/, 'фаза анимации читается из run.animT');
  assert.match(body, /legA=Math\.sin\(ph\)/, 'первая лапа — sin от фазы');
  assert.match(body, /legB=Math\.sin\(ph\+Math\.PI\)/, 'вторая лапа — в противофазе');
  assert.match(body, /legA\*[\d.]+/i, 'нога смещается по фазе (x/y колена и стопы)');
  assert.match(body, /legB\*[\d.]+/i, 'вторая нога смещается по своей фазе');
  assert.match(body, /bob/, 'вертикальное покачивание тела');
  assert.match(body, /tail\*/, 'хвост покачивается');
});
