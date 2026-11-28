// Полоса «Последнее действие» принадлежит выбранной смене (решение владельца
// 28.11.2026): при двух открытых сменах прибытие на одном объекте больше не
// висит в шапке другого объекта, а вкладка чужой смены показывает точку
// непросмотренного действия.
//
// Файл проверяет именно те исходники, которые уходят в сборку: функции полосы
// живут в общих IIFE без модульного экспорта, поэтому контракт читается по
// тексту (как в 39-line-calm.test.mjs), а поведение бейджа проверяется
// отдельно — на настоящем модуле полосы в 43-shift-selector.test.mjs.
//
// Запуск: node --test working-test/source/core/ticker-per-shift.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('./', import.meta.url));
const configSrc = readFileSync(here + '00-config-state.js', 'utf8');
const lineUiSrc = readFileSync(here + '18-line-ui.js', 'utf8');
// Полосу в браузере рисует features/ticker-name.js: он загружается после ядра и
// перетирает renderStatusTicker из 18-line-ui.js. Проверять только ядро нельзя —
// именно так первый вариант правки прошёл юнит-тесты и не изменил экран.
const tickerSrc = readFileSync(here + '../features/ticker-name.js', 'utf8');
const navigationSrc = readFileSync(here + '19-navigation.js', 'utf8');
const styleSrc = readFileSync(here + '../styles/style-05.css', 'utf8');

test('полоса отбирает уведомление выбранной смены, а не общий журнал', () => {
  assert.match(configSrc, /function tickerBelongsToShift\(item, shiftId\)/,
    'правило принадлежности записи смене живёт рядом с валидацией уведомлений');
  assert.match(configSrc, /if \(!item \|\| typeof shiftId !== 'string' \|\| !shiftId\) return false;/,
    'без выбранной смены полоса ничего не показывает');
  assert.match(configSrc, /return item\.shiftId === shiftId;/,
    'запись показывается только своей смене');
  assert.match(configSrc, /function lastValidNotification\(\) \{\s*const shiftId = state\.shift && state\.shift\.id;\s*return \(state\.notifications \|\| \[\]\)\.find\(item => validTickerNotification\(item\) && tickerBelongsToShift\(item, shiftId\)\) \|\| null;/,
    'полоса ищет последнее уведомление только выбранной смены');
});

test('запись без shiftId не попадает в полосу конкретной смены', () => {
  // Старые записи канала не знают смены: показать их в выбранной смене значило
  // бы снова смешать объекты — ровно то, на что жаловался владелец.
  assert.match(configSrc, /function tickerBelongsToShift\(item, shiftId\)[\s\S]*?return false;/,
    'нет shiftId у записи — нет показа в смене');
  assert.doesNotMatch(configSrc, /function tickerBelongsToShift\(item, shiftId\)[\s\S]{0,400}?return true;\s*\n\s*\}\s*\n\s*function lastValidNotification/,
    'безусловного «показать всем» в правиле нет');
});

test('проверка погрузки по подтверждённому рейсу сохранена', () => {
  assert.match(configSrc, /function validTickerNotification\(item\) \{[\s\S]*?confirmedLoadIds\.has\(item\.logId\)/,
    'погрузка по-прежнему ждёт подтверждённого рейса');
  assert.match(configSrc, /log\.shiftId === state\.shift\.id/,
    'рейс сверяется со сменой');
});

test('заголовок полосы называет объект, когда открыто несколько смен', () => {
  assert.match(tickerSrc, /function tickerScopeLabel\(item\)/,
    'подпись полосы вычисляется в фактическом рендере полосы');
  assert.match(tickerSrc, /window\.__wtVisibleShiftCount/,
    'число открытых смен приходит из полосы смен');
  assert.match(tickerSrc, /base \+ ' · ' \+ name/,
    'при двух сменах в заголовке виден объект');
  assert.match(tickerSrc, /id="tickerScope"/,
    'заголовок обновляется вместе с переключением смены');
  assert.match(tickerSrc, /scopeEl\.textContent !== scopeText/,
    'после переключения смены заголовок правится без полной перестройки');
});

test('фактический рендер полосы тоже отбирает уведомление выбранной смены', () => {
  assert.match(tickerSrc, /function getLastNotification\(\)[\s\S]*?tickerBelongsToShift\(item, shiftId\)/,
    'features/ticker-name.js фильтрует записи по смене, а не берёт общий журнал');
  assert.match(tickerSrc, /const shiftId = state\.shift && state\.shift\.id \? state\.shift\.id : ''/,
    'смена берётся из выбранного контекста');
});

test('полоса обновляет точки на вкладках смен', () => {
  assert.match(tickerSrc, /window\.__wtRefreshShiftBadges/,
    'новое уведомление пересчитывает точки на вкладках');
  assert.match(lineUiSrc, /window\.__wtRefreshShiftBadges/,
    'резервный рендер ядра делает то же самое');
  assert.match(navigationSrc, /lastActionAt: shiftActionAt/,
    'полоса смен получает время последнего действия смены');
  assert.match(navigationSrc, /seenAt: shiftSeenAt/,
    'полоса смен получает время просмотра смены');
  assert.match(navigationSrc, /markSeen: markShiftSeen/,
    'выбор смены отмечает её просмотренной');
});

test('отметка просмотра хранится на устройстве отдельно по сменам', () => {
  assert.match(navigationSrc, /samosval-wt-shift-seen-v1/,
    'ключ локального хранилища назван явно');
  assert.match(navigationSrc, /map\[shiftId\] = Date\.now\(\)/,
    'просмотр пишется по конкретной смене');
  assert.match(navigationSrc, /item\.shiftId !== shiftId/,
    'время действия берётся только своей смены');
});

test('точка на вкладке описана стилем и не мешает прежним бейджам', () => {
  assert.match(styleSrc, /\.shift-tab-action \{/, 'стиль точки есть в общем CSS канала');
  assert.match(styleSrc, /\.shift-tab-action \{[^}]*width: 9px/, 'точка маленькая, а не текстовая плашка');
});
