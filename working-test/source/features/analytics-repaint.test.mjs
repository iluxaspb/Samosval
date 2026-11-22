// Регрессионный тест (П3): «Аналитика»/«Аудит» перестраивалась innerHTML на
// каждом событии (onSnapshot audit/objects/archive/users, renderAll) — сбивалась
// прокрутка и сворачивались раскрытые блоки ходок. Теперь (features/analytics-v2.js
// и features/trip-analytics.js): неизменный контент не перерисовывается вовсе
// (сравнение сигнатуры, паттерн game-coins-v2), а при изменении сохраняются
// позиция прокрутки и раскрытые <details> (ключ — текст summary) и
// восстанавливаются после перерисовки. Фильтр auditPeriod живёт в переменной
// модуля и перерисовку переживает — это не сломано.
// Запуск: node --test working-test/source/features/analytics-repaint.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const analyticsSrc = readFileSync(path.join(here, "analytics-v2.js"), "utf8");
const tripSrc = readFileSync(path.join(here, "trip-analytics.js"), "utf8");

// ===== Мини-DOM =====
// innerHTML-сеттер имитирует браузер: при пересборке свежие <details> закрыты,
// поэтому восстановление open должно произойти явно (как в реальном DOM).
function mockRoot({ details = [] } = {}) {
  const root = {
    writes: 0,
    _html: "",
    details,
    filterBtns: [{ dataset: { period: "today" }, onclick: null }],
    querySelectorAll(sel) {
      if (sel === "details[open]") return root.details.filter(d => d.open);
      if (sel === "details") return root.details.slice();
      if (sel === "#auditFilterRow .an-filter-btn") return root.filterBtns;
      return [];
    },
  };
  Object.defineProperty(root, "innerHTML", {
    get() { return root._html; },
    set(v) {
      root._html = String(v);
      root.writes++;
      root.details.forEach(d => { d.open = false; }); // пересборка = новые узлы
    },
  });
  return root;
}
function mockWindow(scrollY = 0) {
  return { scrollY, scrollToCalls: [], scrollTo(x, y) { this.scrollToCalls.push([x, y]); } };
}
function mockDetail(label, open = false) {
  return { open: !!open, querySelector(sel) { return sel === "summary" ? { textContent: "  " + label + "  " } : null; } };
}

// ===== Извлечение реального кода analytics-v2.js =====
function extractAnalyticsFragments() {
  const helpersStart = analyticsSrc.indexOf("  function collectOpenDetails");
  const mainStart = analyticsSrc.indexOf("  window.renderAnalytics = function");
  const mainEnd = analyticsSrc.indexOf("  setTimeout(() => {", mainStart);
  assert.ok(helpersStart > 0 && mainStart > helpersStart && mainEnd > mainStart,
    "фрагменты точечного обновления найдены в analytics-v2.js");
  return { helpers: analyticsSrc.slice(helpersStart, mainStart), main: analyticsSrc.slice(mainStart, mainEnd) };
}

function makeRenderer({ tab, win, auditText }) {
  const { helpers, main } = extractAnalyticsFragments();
  const document = { getElementById: id => (id === "tab-analytics" ? tab : null) };
  let t = 0;
  const DateMock = { now: () => (t += 1000) }; // обходим троттлинг 500 мс
  const factory = new Function(
    "window", "document", "Date", "hasTabAccess", "auditPeriod",
    "renderCurrentShiftStats", "renderCycles", "renderTopTrucks", "renderMonthly",
    "renderUserActivity", "renderAuditLog",
    helpers + "\n" + main + "\nreturn window.renderAnalytics;",
  );
  return factory(
    win, document, DateMock, () => true, "today",
    () => "shift", () => "cycles", () => "top", () => "monthly", () => "user",
    () => auditText.value,
  );
}

// ===== Извлечение реального кода trip-analytics.js =====
function extractTripRepaintFragment() {
  const start = tripSrc.indexOf("  function anDetailsKeys");
  const end = tripSrc.indexOf("  function render(){", start);
  assert.ok(start > 0 && end > start, "фрагмент точечной перерисовки найден в trip-analytics.js");
  return tripSrc.slice(start, end);
}

function makeTripApplier(win, dashboard) {
  const factory = new Function("window", "dashboard",
    extractTripRepaintFragment() + "\nreturn anApplyDashboardHtml;");
  return factory(win, dashboard);
}

// ===== analytics-v2 =====

test("analytics-v2: неизменные данные — перерисовки нет вообще (прокрутка не трогается)", () => {
  const tab = mockRoot(), win = mockWindow();
  const auditText = { value: "запись А" };
  const render = makeRenderer({ tab, win, auditText });
  render();
  assert.equal(tab.writes, 1, "первая отрисовка состоялась");
  assert.equal(win.scrollToCalls.length, 1, "при первой отрисовке позиция сохранена/восстановлена");
  render(); // данные те же, троттлинг обойдён через мок Date
  assert.equal(tab.writes, 1, "повторная перерисовка при тех же данных пропущена");
  assert.equal(win.scrollToCalls.length, 1, "scrollTo при пропуске не вызывается");
});

test("analytics-v2: изменение данных — перерисовка сохраняет прокрутку и раскрытые details", () => {
  const tab = mockRoot(), win = mockWindow();
  const auditText = { value: "запись А" };
  const render = makeRenderer({ tab, win, auditText });
  render();
  // Пользователь раскрыл блок и прокрутил страницу.
  const open = mockDetail("Журнал действий (аудит)", true);
  const closed = mockDetail("Как считаются показатели", false);
  tab.details.push(open, closed);
  win.scrollY = 234;
  auditText.value = "запись Б (новое событие другого оператора)";
  render();
  assert.equal(tab.writes, 2, "изменившийся контент перерисован");
  assert.deepEqual(win.scrollToCalls[win.scrollToCalls.length - 1], [0, 234],
    "позиция прокрутки восстановлена после перерисовки");
  assert.equal(open.open, true, "раскрытый details снова раскрыт");
  assert.equal(closed.open, false, "закрытый details не раскрывается сам");
});

test("analytics-v2: force обходит пропуск (фильтр auditPeriod перерисовывает сразу)", () => {
  const tab = mockRoot(), win = mockWindow();
  const render = makeRenderer({ tab, win, auditText: { value: "одинаково" } });
  render();
  render(true);
  assert.equal(tab.writes, 2, "форсированная перерисовка выполнена даже при том же HTML");
});

test("analytics-v2: фильтр auditPeriod по-прежнему живёт в переменной модуля", () => {
  assert.ok(analyticsSrc.includes("let auditPeriod = 'today'"),
    "переменная модуля auditPeriod не удалена (фильтр переживает перерисовку)");
});

// ===== trip-analytics =====

test("trip-analytics: неизменный HTML не применяется, при изменении сохраняются прокрутка и details", () => {
  const dashboard = mockRoot(), win = mockWindow(111);
  const apply = makeTripApplier(win, dashboard);
  assert.equal(apply("HTML-A"), true, "первое применение");
  assert.equal(dashboard.writes, 1);
  assert.deepEqual(win.scrollToCalls[0], [0, 111], "прокрутка восстановлена");
  assert.equal(apply("HTML-A"), false, "тот же HTML — перерисовки нет");
  assert.equal(dashboard.writes, 1, "DOM не перестраивался");
  const open = mockDetail("Журнал действий (аудит)", true);
  dashboard.details.push(open);
  win.scrollY = 222;
  assert.equal(apply("HTML-B"), true, "изменившийся HTML применён");
  assert.equal(dashboard.writes, 2);
  assert.deepEqual(win.scrollToCalls[win.scrollToCalls.length - 1], [0, 222],
    "прокрутка восстановлена после реальной перерисовки");
  assert.equal(open.open, true, "раскрытый блок ходок снова раскрыт");
});

test("trip-analytics: render() использует точечное применение и ранний возврат", () => {
  assert.ok(tripSrc.includes("if(!anApplyDashboardHtml(html))return;"),
    "render выходит без пересборки, когда контент не изменился");
});
