import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Доработка 1.7.8: «Дино» только в горизонтальном режиме. В портрете поле
// закрыто оверлеем «Переверните телефон», заезд не стартует; поворот во время
// игры ставит заезд на паузу БЕЗ сброса dinoRun — прогресс не теряется.

const uiSource = readFileSync(new URL('./road-arcade-ui.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../styles/road-arcade-style.css', import.meta.url), 'utf8');

test('оверлей: класс dino-rotate-overlay с текстом «Переверните телефон» есть в разметке поля', () => {
  assert.match(uiSource, /class="dino-rotate-overlay"/, 'оверлей должен быть внутри .dino-field в renderDino');
  assert.ok(uiSource.includes('Переверните телефон в горизонтальный режим'), 'текст подсказки про горизонтальный режим');
});

test('оверлей: CSS показывает его только в портрете, поверх canvas и кнопки (z-index)', () => {
  assert.match(cssSource, /\.dino-rotate-overlay\{display:none\}/, 'в ландшафте оверлей скрыт');
  assert.match(cssSource, /@media \(orientation: portrait\)\{[\s\S]{0,400}?\.dino-rotate-overlay\{[\s\S]{0,200}?z-index/, 'в портрете оверлей на весь поле с z-index выше canvas/FAB');
});

test('ориентация: слушатель change у matchMedia(orientation) реагирует на поворот', () => {
  const at = uiSource.indexOf("matchMedia('(orientation: portrait)')");
  assert.ok(at > 0, 'используется portrait matchMedia');
  assert.match(uiSource, /matchMedia\('\(orientation: portrait\)'\)[\s\S]{0,200}?addEventListener\?\.\('change'/, 'подписка на change ориентации');
});

test('пауза: в портрете заезд останавливается через stopDino, dinoRun не сбрасывается', () => {
  const at = uiSource.indexOf("dinoOrient.addEventListener");
  const handler = uiSource.slice(at, at + 700);
  assert.match(handler, /if\(dinoOrient\.matches\)\{if\(dinoRun&&!dinoRun\.over\)stopDino\(\);/, 'портрет — пауза stopDino без обнуления dinoRun');
  assert.ok(!handler.slice(0, 300).includes('dinoRun=null'), 'dinoRun должен сохраниться для продолжения заезда');
  assert.match(handler, /else\{[\s\S]{0,400}?render\(true\)/, 'возврат в ландшафт пересобирает поле и продолжает луп');
});

test('старт: в портрете startDino не запускает заезд', () => {
  const start = uiSource.indexOf('function startDino()');
  assert.ok(start > 0, 'функция startDino не найдена');
  const head = uiSource.slice(start, start + 200);
  assert.match(head, /dinoPortrait\(\)/, 'guard на портрет в startDino');
});
