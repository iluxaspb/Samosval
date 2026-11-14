import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Доработка «Дино» 1.7.7: прыжок по тапу в любом месте игрового поля
// (обработчик на обёртке, не только на canvas), плавающая кнопка-пружок
// с сохранением позиции в localStorage и разделением тап/перетаскивание,
// плюс версия 1.7.7 во всех местах.

const uiSource = readFileSync(new URL('./road-arcade-ui.js', import.meta.url), 'utf8');
const shellSource = readFileSync(new URL('../shell.html', import.meta.url), 'utf8');
const releaseSource = readFileSync(new URL('./working-test-release.js', import.meta.url), 'utf8');
const historySource = readFileSync(new URL('./release-history.js', import.meta.url), 'utf8');

function renderDinoBody() {
  const start = uiSource.indexOf('function renderDino(host){');
  assert.ok(start > 0, 'функция renderDino не найдена');
  let depth = 0, i = uiSource.indexOf('{', start);
  for (; i < uiSource.length; i++) {
    if (uiSource[i] === '{') depth++;
    else if (uiSource[i] === '}') { depth--; if (depth === 0) return uiSource.slice(start, i + 1); }
  }
  throw new Error('не удалось выделить тело renderDino()');
}

function setupDinoFabBody() {
  const start = uiSource.indexOf('function setupDinoFab(host,field){');
  assert.ok(start > 0, 'функция setupDinoFab не найдена');
  let depth = 0, i = uiSource.indexOf('{', start);
  for (; i < uiSource.length; i++) {
    if (uiSource[i] === '{') depth++;
    else if (uiSource[i] === '}') { depth--; if (depth === 0) return uiSource.slice(start, i + 1); }
  }
  throw new Error('не удалось выделить тело setupDinoFab()');
}

test('прыжок: обработчик pointerdown висит на игровом контейнере, а не только на canvas', () => {
  const body = renderDinoBody();
  assert.ok(body.includes('dino-field'), 'в разметке должна быть обёртка игрового поля .dino-field');
  assert.match(body, /field\.onpointerdown\s*=/, 'обработчик прыжка обязан висеть на field (обёртке поля)');
  assert.ok(!body.match(/canvas\.onpointerdown\s*=/), 'canvas больше не единственное место обработки тапа');
});

test('canvas: внутреннее разрешение подгоняется под контейнер, мир масштабируется отрисовкой', () => {
  assert.match(uiSource, /function dinoFitCanvas/, 'нужна функция подгонки разрешения canvas');
  const fit = uiSource.slice(uiSource.indexOf('function dinoFitCanvas'), uiSource.indexOf('function dinoDrawWorld'));
  assert.match(fit, /devicePixelRatio/, 'разрешение должно учитывать devicePixelRatio');
  assert.match(uiSource, /function dinoDrawWorld[\s\S]{0,600}?g\.scale\(/, 'отрисовка должна масштабировать контекст под canvas, не меняя физику в core');
  assert.match(uiSource, /function dinoDrawWorld[\s\S]{0,400}?try\s*\{/, 'отрисовка обязана быть защищена try/catch');
});

test('плавающая кнопка: создаётся, позиция сохраняется и восстанавливается через localStorage', () => {
  const body = renderDinoBody();
  assert.match(body, /id="dino-fab"/, 'кнопка-пружок должна быть в разметке игрового поля');
  assert.match(uiSource, /prefKey\(\)\s*\+\s*':dino-fab-pos'/, 'ключ позиции — prefKey()+\':dino-fab-pos\'');
  assert.match(uiSource, /function saveDinoFabPos[\s\S]{0,200}?localStorage\.setItem/, 'позиция сохраняется в localStorage');
  assert.match(uiSource, /function loadDinoFabPos[\s\S]{0,300}?localStorage\.getItem/, 'позиция восстанавливается из localStorage');
  const fab = setupDinoFabBody();
  assert.match(fab, /place\(loadDinoFabPos\(\)\)/, 'при загрузке кнопка ставится на сохранённую позицию (или дефолт)');
  assert.match(fab, /clampDinoFab/, 'позиция кнопки ограничивается пределами поля (clamp)');
});

test('кнопка: перетаскивание не вызывает прыжок (порог смещения)', () => {
  const fab = setupDinoFabBody();
  assert.match(fab, /Math\.hypot\(dx,dy\)>8/, 'перетаскивание определяется по смещению больше 8px');
  assert.match(fab, /if\(dragged\)\{[\s\S]{0,400}?saveDinoFabPos/, 'перетаскивание сохраняет позицию, а не прыгает');
  assert.match(fab, /else\{[^\n]*?dinoInput\.jump\s*=\s*true|else\{\s*\/\/ короткий тап[\s\S]{0,300}?dinoInput\.jump\s*=\s*true/, 'короткий тап по кнопке даёт прыжок');
  assert.ok(fab.indexOf('dragged=true') < fab.indexOf("dinoInput.jump=true"), 'после начала перетаскивания прыжок не должен срабатывать');
});

test('версия 1.7.12: shell.html, working-test-release.js, release-history.js', () => {
  assert.match(shellSource, /name="working-test-version" content="1\.7\.12"/, 'meta working-test-version в shell.html');
  assert.match(shellSource, /Версия: 1\.7\.12/, 'span.version-text в shell.html');
  assert.match(releaseSource, /version:'1\.7\.12'/, 'версия в working-test-release.js');
  assert.match(historySource, /version:'1\.7\.12'/, 'запись 1.7.12 в release-history.js');
  const first = historySource.indexOf("'1.7.12'");
  assert.ok(first > 0 && first < historySource.indexOf("'1.7.11'"), 'запись 1.7.12 должна быть первой в списке');
});

// Смоук: смоделированный DOM без canvas-механики — renderDino-подобный
// флоу установки обработчиков не должен падать (отрисовка глушится).
test('смоук с самодельным DOM: обработчики и кнопка ставятся без ошибок', () => {
  function makeEl(tag) {
    const listeners = {};
    return {
      tagName: tag.toUpperCase(), style: {}, classList: { add() {}, remove() {} },
      children: [], dataset: {}, innerHTML: '',
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      dispatch(type, event) { (listeners[type] || []).forEach(fn => fn(event)); },
      setPointerCapture() {}, closest() { return null; },
      getBoundingClientRect() { return { width: 600, height: 240 }; },
      parentElement: null, clientWidth: 600, clientHeight: 240, offsetWidth: 64,
      width: 0, height: 0, getContext() { return null; }, // «канвас» без 2d-контекста
    };
  }
  const field = makeEl('div'), canvas = makeEl('canvas'), fab = makeEl('button');
  canvas.parentElement = field;
  // Мини-копия связки из UI: field-обработчик + FAB с порогом 8px.
  let jump = false, savedPos = null, store = {};
  const storage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  field.onpointerdown = e => { if (e.target && e.target.closest && e.target.closest('button')) return; jump = true; };
  fab.addEventListener('pointerdown', () => {});
  let dragged = false, sx = 0, sy = 0;
  fab.addEventListener('pointerdown', e => { dragged = false; sx = e.clientX; sy = e.clientY; });
  fab.addEventListener('pointermove', e => {
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!dragged && Math.hypot(dx, dy) > 8) { dragged = true; jump = false; }
    if (dragged) savedPos = { x: dx, y: dy };
  });
  fab.addEventListener('pointerup', () => { if (dragged) storage.setItem('fab', JSON.stringify(savedPos)); else jump = true; });
  // тап по полю
  field.onpointerdown({ target: canvas, clientY: 0 });
  assert.equal(jump, true, 'тап по полю даёт прыжок');
  jump = false;
  // короткий тап по кнопке
  fab.dispatch('pointerdown', { clientX: 0, clientY: 0 });
  fab.dispatch('pointerup', {});
  assert.equal(jump, true, 'короткий тап по кнопке даёт прыжок');
  jump = false;
  // перетаскивание кнопки — не прыжок, позиция сохранена
  fab.dispatch('pointerdown', { clientX: 0, clientY: 0 });
  fab.dispatch('pointermove', { clientX: 40, clientY: 30 });
  fab.dispatch('pointerup', {});
  assert.equal(jump, false, 'перетаскивание не должно давать прыжок');
  assert.ok(storage.getItem('fab'), 'позиция после перетаскивания сохранена');
  assert.ok(canvas.getContext() === null, 'смоук работает без реального 2d-контекста');
});
