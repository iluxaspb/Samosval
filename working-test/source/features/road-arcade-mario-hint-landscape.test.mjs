import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Баг владельца (23.11.2026): после поворота телефона в горизонтальный режим
// памятка «Как играть» не помещается на низком экране (~393–420px): кнопка
// «Понятно, играть» уезжает за нижний край (диалог .mario-immersive обрезает
// контент с overflow:hidden), тап не проходит — в игру не попасть.
// Проверяем статически CSS и обработчики по источникам сборки working-test.

const uiSource = readFileSync(new URL('./road-arcade-ui.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../styles/road-arcade-style.css', import.meta.url), 'utf8');

test('карточка памятки ограничена по высоте и скроллится: кнопка не уезжает за экран', () => {
  const rule = cssSource.match(/\.mario-first-run \.mfr-card\{[^}]*\}/)?.[0] || '';
  assert.match(rule, /max-height:\s*calc\(100% - 24px\)/, 'у .mfr-card нет max-height с запасом — на низком экране кнопка за нижним краем');
  assert.match(rule, /overflow-y:\s*auto/, 'без overflow-y:auto длинная карточка не скроллится');
});

test('в landscape карточка компактнее: шрифты и отступы уменьшаются', () => {
  const block = cssSource.match(/@media \(orientation:landscape\) and \(max-height:520px\)\{[\s\S]*?\.mario-first-run[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(block.length > 0, 'нет landscape-компактного блока для памятки');
  assert.match(block, /mfr-card\{[^}]*padding:12px 16px/, 'паддинги карточки не уменьшены');
  assert.match(block, /mfr-icon\{[^}]*height:44px/, 'иконки не уменьшены');
});

test('оверлей памятки выше панели, выхода и зон управления', () => {
  const overlay = cssSource.match(/\.mario-first-run\{[^}]*\}/)?.[0] || '';
  assert.match(overlay, /z-index:\s*30/, 'базовый z-index оверлея должен быть не ниже 30');
  const raised = cssSource.match(/\.mario-game-wrapper \.mario-first-run\{[^}]*\}/)?.[0] || '';
  assert.match(raised, /z-index:\s*40/, 'памятка должна стоять выше mic-exit (z-index:20) и hud (z-index:8)');
});

test('у кнопки «Понятно, играть» есть pointerdown-обработчик, не только click', () => {
  const at = uiSource.indexOf("id=\"mario-first-run-ok\"");
  assert.ok(at > 0, 'кнопка памятки не найдена в разметке');
  const tail = uiSource.slice(at, at + 900);
  assert.match(tail, /addEventListener\('pointerdown'/, 'на мобильных WebView click под pointer-зонами глотается — нужен pointerdown');
  assert.match(tail, /e\.stopImmediatePropagation\(\)/, 'pointerdown не должен пропускать событие дальше под pointer-зоны');
});

test('закрытие памятки одинаково для click и pointerdown (одна функция)', () => {
  const at = uiSource.indexOf("id=\"mario-first-run-ok\"");
  const tail = uiSource.slice(at, at + 900);
  const closeDef = tail.match(/const closeHint=\(\)=>\{[\s\S]*?\};/)?.[0] || '';
  assert.ok(closeDef.length > 0, 'нет общей функции закрытия closeHint');
  assert.match(tail, /okBtn\.onclick=closeHint/, 'click закрывает памятку');
  assert.match(tail, /pointerdown[\s\S]{0,400}closeHint\(\)/, 'pointerdown закрывает памятку той же функцией');
});
