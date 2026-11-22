// Регрессионный тест (П4): карточки «Линии» пересобираются innerHTML по событиям
// другого оператора — во время удержания кнопки (holdTimer, core/17) карточка
// «уезжала» из-под пальца. Теперь (core/18-line-ui.js) флаг
// window.__lineHoldActive = удержание (.holding) или касание контейнера линии
// (pointerdown до pointerup/cancel + грейс ~400 мс), а расписание renderLine
// (core/04-subscriptions.js scheduleRenderLine) при активном флаге копит долг и
// выполняет перерисовку после снятия флага (__lineFlushDeferred) — чужие
// действия не теряются. Паттерн отложенной перерисовки — tabel-v2/workspace.mjs
// refreshIncoming.
// Запуск: node --test working-test/source/core/line-hold-freeze.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const lineUiSrc = readFileSync(path.join(here, "18-line-ui.js"), "utf8");
const subsSrc = readFileSync(path.join(here, "04-subscriptions.js"), "utf8");

// ===== Реальный фрагмент core/18-line-ui.js (трекинг удержания/касания) =====
function extractLineHoldFragment() {
  const start = lineUiSrc.indexOf("  // === П4:");
  const end = lineUiSrc.indexOf("  function renderLine() {", start);
  assert.ok(start > 0 && end > start, "фрагмент заморозки линии найден в 18-line-ui.js");
  return lineUiSrc.slice(start, end);
}

function setupLineHold({ holding = false } = {}) {
  const handlers = {};
  const graceFns = [];
  const document = {
    addEventListener(type, fn) { handlers[type] = fn; },
    querySelector(sel) { return sel === ".holding" && holding ? { className: "holding" } : null; },
  };
  const win = {};
  const factory = new Function("window", "document", "setTimeout", "clearTimeout",
    extractLineHoldFragment() + "\nreturn window.__lineHoldActive;");
  const active = factory(
    win, document,
    fn => { graceFns.push(fn); return graceFns.length; },
    () => {},
  );
  const lineTarget = () => ({ closest: sel => sel === "#trucksLineList" });
  const outsideTarget = () => ({ closest: () => null });
  const pointerDown = target => handlers.pointerdown({ target });
  const pointerUp = () => handlers.pointerup();
  const pointerCancel = () => handlers.pointercancel();
  const runGrace = () => { const fn = graceFns.pop(); if (fn) fn(); };
  return { win, active, lineTarget, outsideTarget, pointerDown, pointerUp, pointerCancel, runGrace };
}

// ===== Реальный фрагмент core/04-subscriptions.js (отложенная перерисовка) =====
function extractScheduleFragment() {
  const start = subsSrc.indexOf("  let renderLineDeferredByHold = false;");
  const end = subsSrc.indexOf("  function scheduleRenderForTab", start);
  assert.ok(start > 0 && end > start, "фрагмент отложенной перерисовки найден в 04-subscriptions.js");
  return subsSrc.slice(start, end);
}

function setupScheduler(holdFlag) {
  const win = { __lineHoldActive: () => holdFlag.v };
  let renderCalls = 0, timer = null;
  const factory = new Function("window", "renderLinePending", "renderLine", "setTimeout", "requestAnimationFrame",
    extractScheduleFragment() + "\nreturn { schedule: scheduleRenderLine, flush: window.__lineFlushDeferred, pending: () => renderLinePending };");
  const api = factory(win, false, () => renderCalls++,
    fn => { timer = fn; return 1; },
    cb => cb(), // rAF синхронно, как в браузере до кадра
  );
  return { ...api, runTimer: () => { const fn = timer; timer = null; if (fn) fn(); }, renderCalls: () => renderCalls };
}

// ===== Трекинг удержания (18-line-ui) =====

test("удержание: касание карточки замораживает перерисовку, грейс после pointerup её держит", () => {
  const s = setupLineHold();
  let flushed = 0;
  s.win.__lineFlushDeferred = () => flushed++;
  assert.equal(s.active(), false, "до касания флаг снят");
  s.pointerDown(s.lineTarget());
  assert.equal(s.active(), true, "pointerdown на контейнере линии — перерисовка отложена");
  s.pointerUp();
  assert.equal(s.active(), true, "после pointerup действует грейс-период");
  s.runGrace();
  assert.equal(s.active(), false, "после грейса флаг снят");
  assert.equal(flushed, 1, "отложенная перерисовка запрошена после снятия флага");
});

test("удержание: pointercancel завершает касание так же, как pointerup", () => {
  const s = setupLineHold();
  let flushed = 0;
  s.win.__lineFlushDeferred = () => flushed++;
  s.pointerDown(s.lineTarget());
  s.pointerCancel();
  assert.equal(s.active(), true, "грейс активен после pointercancel");
  s.runGrace();
  assert.equal(s.active(), false);
  assert.equal(flushed, 1, "перерисовка не потеряна");
});

test("удержание: касание вне линии не замораживает", () => {
  const s = setupLineHold();
  s.pointerDown(s.outsideTarget());
  assert.equal(s.active(), false, "тап по другим элементам перерисовку не блокирует");
});

test("удержание: активный holdTimer (.holding) замораживает без учёта касаний", () => {
  const s = setupLineHold({ holding: true });
  assert.equal(s.active(), true, "кнопка в состоянии .holding — контейнер не пересобирается");
});

// ===== Отложенное расписание (04-subscriptions) =====

test("линия: при активном удержании перерисовка откладывается и выполняется после", () => {
  const hold = { v: true };
  const s = setupScheduler(hold);
  s.schedule();
  assert.equal(s.renderCalls(), 0, "во время удержания renderLine не вызывается");
  assert.equal(s.pending(), false, "пустой таймер не висит");
  hold.v = false;
  s.flush();
  s.runTimer();
  assert.equal(s.renderCalls(), 1, "после снятия флага отложенная перерисовка выполнена");
  assert.equal(s.pending(), false);
});

test("линия: удержание началось после запуска 50-мс таймера — rAF повторно проверяет флаг", () => {
  const hold = { v: false };
  const s = setupScheduler(hold);
  s.schedule();
  hold.v = true; // палец лёг на карточку, пока таймер уже тикает
  s.runTimer();
  assert.equal(s.renderCalls(), 0, "перерисовка отменена в rAF, карточка не «уехала»");
  assert.equal(s.pending(), false);
  hold.v = false;
  s.flush();
  s.runTimer();
  assert.equal(s.renderCalls(), 1, "долг выполнен после завершения удержания");
});

test("линия: дебаунс сохранён — повторные schedule не плодят перерисовки", () => {
  const s = setupScheduler({ v: false });
  s.schedule();
  s.schedule();
  s.schedule();
  s.runTimer();
  assert.equal(s.renderCalls(), 1, "одна перерисовка на серию событий (как раньше, 50 мс + rAF)");
});

test("линия: flush без долга безопасен", () => {
  const s = setupScheduler({ v: false });
  s.flush();
  assert.equal(s.renderCalls(), 0);
});

// ===== Контракт источников =====

test("renderAll() гоняет линию через расписание, уважающее удержания", () => {
  assert.ok(lineUiSrc.includes("if (hasTabAccess('line')) scheduleRenderLine();"),
    "путь renderAll (снапшоты shift/permissions) тоже откладывается при удержании");
});
