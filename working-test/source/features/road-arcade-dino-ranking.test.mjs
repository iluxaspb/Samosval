import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Доработка 1.7.8: рейтинг игроков по «Дино». dinoStats() агрегирует записи
// kind='dino' из журнала: сумма payout и максимум score по каждому игроку;
// в renderRanking появляется третья кнопка «🦖 Дино».

const uiSource = readFileSync(new URL('./road-arcade-ui.js', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('./road-arcade-runtime.js', import.meta.url), 'utf8');

// Вырезаем функцию dinoStats из рантайма и исполняем её в песочнице, где
// isNasRuntime()=true и nasGameSnapshot — наш журнал записей.
function dinoStatsFor(records) {
  const start = runtimeSource.indexOf('function dinoStats(){');
  assert.ok(start > 0, 'функция dinoStats не найдена в рантайме');
  let depth = 0, i = runtimeSource.indexOf('{', start);
  const from = i;
  for (; i < runtimeSource.length; i++) {
    if (runtimeSource[i] === '{') depth++;
    else if (runtimeSource[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = runtimeSource.slice(from, i + 1);
  const sandbox = {
    isNasRuntime: () => true,
    nasGameSnapshot: records ? { records } : null,
    players: {},
  };
  const fn = vm.runInNewContext('(function dinoStats()' + body + ')', sandbox);
  return fn();
}

test('dinoStats: сумма монет, максимум очков и разные игроки по записям kind=dino', () => {
  const stats = dinoStatsFor([
    { eventType: 'game_arcade', kind: 'dino', payout: 5, result: { type: 'dino_run', score: 120 }, userUid: 'u1', userEmail: 'a@x', userName: 'Анна' },
    { eventType: 'game_arcade', kind: 'dino', payout: 7, result: { type: 'dino_run', score: 300 }, userUid: 'u1', userEmail: 'a@x', userName: 'Анна' },
    { eventType: 'game_arcade', kind: 'dino', payout: 2, result: { type: 'dino_run', score: 900 }, userUid: 'u2', userEmail: 'b@x', userName: 'Борис' },
    // посторонние записи не должны попадать в агрегат
    { eventType: 'game_arcade', kind: 'slot', payout: 999, result: {}, userUid: 'u3', userEmail: 'c@x', userName: 'Виктор' },
    { eventType: 'game_penalty', kind: 'dino', payout: 50, result: { score: 5000 }, userUid: 'u3', userEmail: 'c@x', userName: 'Виктор' },
  ]);
  assert.equal(stats.u1.coins, 12, 'монеты u1 суммируются по двум заездам');
  assert.equal(stats.u1.best, 300, 'лучшие очки u1 — максимум из заездов');
  assert.equal(stats.u2.coins, 2);
  assert.equal(stats.u2.best, 900);
  assert.ok(!stats.u3, 'записи не-dino и не-game_arcade игнорируются');
  assert.equal(stats.u1.name, 'Анна');
});

test('dinoStats: без журнала и пустой журнал дают пустой результат, не выдумывают данные', () => {
  assert.equal(Object.keys(dinoStatsFor(null)).length, 0);
  assert.equal(Object.keys(dinoStatsFor([])).length, 0);
});

test('dinoStats: доступен в window.RoadArcade', () => {
  assert.match(runtimeSource, /window\.RoadArcade=\{[\s\S]{0,300}?dinoStats/, 'метод экспортирован в RoadArcade');
});

test('кнопка «Дино» и таблица очков/монет есть в renderRanking', () => {
  const at = uiSource.indexOf('function renderRanking(host){');
  assert.ok(at > 0, 'renderRanking не найден');
  let depth = 0, i = uiSource.indexOf('{', at);
  for (; i < uiSource.length; i++) {
    if (uiSource[i] === '{') depth++;
    else if (uiSource[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = uiSource.slice(at, i + 1);
  assert.match(body, /data-rank="dino"[^>]*>🦖 Дино</, 'третья кнопка переключения рейтинга');
  assert.match(body, /rankMode==='dino'/, 'ветка отрисовки динозаврного рейтинга');
  assert.match(body, /Лучшие очки/, 'колонка лучших очков');
  assert.match(body, /Монеты/, 'колонка монет');
  assert.match(body, /A\.dinoStats\(\)/, 'таблица строится из dinoStats()');
  assert.match(body, /b\.best-a\.best/, 'сортировка по очкам');
});
