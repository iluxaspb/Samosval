# Полоса уведомлений по выбранной смене — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native execution: владелец просил не останавливаться на каждом шаге). Шаги отмечены `- [ ]`.

**Goal:** Зелёная полоса «ПОСЛЕДНЕЕ ДЕЙСТВИЕ» показывает только уведомления выбранной смены, а вкладки других смен получают точку о непросмотренных действиях.

**Architecture:** Фильтрация по `shiftId` на существующем `state.notifications` (без изменения сервера), локальные отметки просмотра по каждой смене, бейдж `action` в полосе смен.

**Tech Stack:** classic-скрипты канала `working-test`, `node --test`, Playwright для браузерной проверки.

**Spec:** `docs/superpowers/specs/2026-11-28-ticker-per-shift-design.md`

## Global Constraints
- Версия канала после выпуска: `1.10.2`, синхронно в `shell.html`, `working-test-release.js`, первой записи `release-history.js`, `tools/verify-working-test.py`.
- Рабочая версия и рабочая база не меняются.
- Никаких новых серверных полей: только клиент.
- Язык интерфейса — русский.

## Review Focus
- Уведомление без `shiftId` не должно попадать в полосу выбранной смены.
- Погрузка показывается только после подтверждённого рейса (`validTickerNotification`), фильтрация по смене не должна это ослаблять.
- Полоса скрывается, если у выбранной смены нет уведомлений (не показывает «чужое» последнее действие).
- Точка на вкладке не должна появляться у выбранной смены и должна гаснуть после выбора.
- Переключение смен не должно ломать существующие бейджи `pending`/`conflict`/`closing`/`offline`.

---

### Task 1: Фильтрация полосы по выбранной смене

**Files:**
- Modify: `working-test/source/core/00-config-state.js` (`lastValidNotification`)
- Modify: `working-test/source/core/18-line-ui.js` (`renderStatusTicker`)
- Test: `working-test/source/core/ticker-per-shift.test.mjs` (создать)

**Interfaces:**
- Produces: `tickerBelongsToShift(item, shiftId) -> boolean` в области `00-config-state.js`; `tickerScopeLabel(item) -> string` в `18-line-ui.js`.

- [ ] **Step 1: Написать падающий тест**

```js
test('полоса берёт уведомление только выбранной смены', () => {
  assert.match(configSrc, /function tickerBelongsToShift\(item,shiftId\)/);
  assert.match(configSrc, /if\(!shiftId\)return false;/);
  assert.match(configSrc, /if\(isNonEmptyString\(item\.shiftId\)\)return item\.shiftId===shiftId;/);
  assert.match(configSrc, /function lastValidNotification\(\)[\s\S]*?tickerBelongsToShift\(item,state\.shift\.id\)/);
});
```
плюс проверка, что `renderStatusTicker` не показывает запись чужой смены (см. Step 3 теста).

- [ ] **Step 2: Убедиться, что тест красный** — `node --test working-test/source/core/ticker-per-shift.test.mjs`.

- [ ] **Step 3: Реализовать**

В `00-config-state.js`:
```js
function tickerBelongsToShift(item, shiftId) {
  if (!item || !isNonEmptyString(shiftId)) return false;
  if (isNonEmptyString(item.shiftId)) return item.shiftId === shiftId;
  return false; // запись без смены не показываем в конкретной смене
}
function lastValidNotification() {
  const shiftId = state.shift && state.shift.id;
  return (state.notifications || []).find(item => validTickerNotification(item) && tickerBelongsToShift(item, shiftId)) || null;
}
```
В `18-line-ui.js` заголовок полосы получает имя объекта, когда открыто больше одной смены:
`ПОСЛЕДНЕЕ ДЕЙСТВИЕ · <objectName>`; при одной смене — как раньше. Имя берётся из `last.objectName` либо `state.shift.objectName`, экранируется `escapeHtml`.

- [ ] **Step 4: Тест зелёный.**

- [ ] **Step 5: Commit.**

---

### Task 2: Точка непросмотренных действий на вкладке смены

**Files:**
- Modify: `working-test/source/core/43-shift-selector.js` (`badgeState`, `badgeList`, `syncVisuals`)
- Modify: `working-test/source/core/19-navigation.js` (передача `lastActionAt`/`seenAt`/`markSeen`, `__wtRefreshShiftBadges`, `__wtVisibleShiftCount`)
- Modify: `working-test/source/styles/style-04.css` (`.shift-tab-action`)
- Modify: `working-test/source/core/18-line-ui.js` (`renderStatusTicker` → обновить бейджи)
- Test: `working-test/source/core/43-shift-selector.test.mjs` (дополнить), `working-test/source/core/ticker-per-shift.test.mjs`

**Interfaces:**
- Consumes: `config.lastActionAt(shiftId) -> number`, `config.seenAt(shiftId) -> number`, `config.markSeen(shiftId)` — все необязательные; при отсутствии поведение прежнее.
- Produces: бейдж вида `['action', '•']`, класс `shift-tab-badge shift-tab-action`; `window.__wtRefreshShiftBadges()`, `window.__wtVisibleShiftCount() -> number`.

- [ ] **Step 1: Тест на бейдж** — в фейковом DOM две смены, `lastActionAt` у второй больше `seenAt` → у вкладки второй смены есть `shift-tab-action`, у выбранной нет; после `switchTo` и `markSeen` бейдж исчезает.

- [ ] **Step 2: Красный тест.**

- [ ] **Step 3: Реализовать**
  - `badgeState`: `fresh = row.shiftId !== selectedId && actionAt > seenAt` (оба числа через `Number(...) || 0`).
  - `badgeList`: `if (state.fresh) list.push(['action', '•'])`; в `syncBadges` для `action` ставить `title='новое действие в этой смене'` и `aria-label`.
  - `syncVisuals`: для выбранной вкладки вызывать `config.markSeen(shiftId)`.
  - `19-navigation.js`: `shiftSeen` в `localStorage` по ключу `samosval-wt-shift-seen-v1:<workspace>:<uid>`, `lastActionAt` по `state.notifications` с `shiftId`, `markSeen` пишет текущее время; `window.__wtRefreshShiftBadges = () => shiftSelector?.refreshBadges()`; `window.__wtVisibleShiftCount` считает `bridge.store.visibleShifts().length`.
  - `renderStatusTicker` после отрисовки вызывает `window.__wtRefreshShiftBadges?.()`.
  - CSS: маленькая точка 8×8, цвет `#fde68a` на тёмной вкладке.

- [ ] **Step 4: Тесты зелёные, полный набор `core/*.test.mjs` зелёный.**

- [ ] **Step 5: Commit.**

---

### Task 3: Версия 1.10.2 и выпуск в тестовый канал

**Files:**
- Modify: `working-test/source/shell.html` (3 места), `working-test/source/features/working-test-release.js`, `working-test/source/features/release-history.js`, `tools/verify-working-test.py`, `docs/opyt-oshibok.md`

- [ ] **Step 1: Поднять версию и запись истории** с описанием: полоса показывает действия только выбранной смены, точка на вкладке другой смены, рабочая версия не менялась.
- [ ] **Step 2: `tools/build-working-test.py` + `tools/verify-working-test.py`** — успешно.
- [ ] **Step 3: Браузер 393×852 на QA-стенде** — сценарий: две смены, действие в A, переключение на B (полоса B или скрыта), точка на A, возврат на A (точка погасла). Плюс существующие `qa-browser-scenarios.py`, `qa-browser-parallel.py`, `qa-browser-multi.py`.
- [ ] **Step 4: CI `synology-server-tests`** на ветке `feature/synology-snapshot-cache-20261128`.
- [ ] **Step 5: Публикация** `tools/publish-wtest.py` (все адреса RECORDS) + проверка live `version.json`, 143 SHA, SW-кэш, страница без ошибок.
