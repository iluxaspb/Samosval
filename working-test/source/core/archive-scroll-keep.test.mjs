// Регрессионный тест прокрутки списка архива (10-archive.js, П5).
// Список архива пересобирается через container.innerHTML при каждом фоновом
// снапшоте архива/объектов. Раньше страница «подпрыгивала» к началу: позиция
// прокрутки не сохранялась. Теперь перед перестроением запоминается
// scrollTop контейнера и вертикальная позиция страницы (window.scrollY),
// после перестроения — восстанавливаются. Раскрытость групп объектов уже
// переживает перерисовку (archiveExpandedObjects) — это не должно сломаться.
// Запуск: node --test working-test/source/core/archive-scroll-keep.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "10-archive.js"), "utf8");

function functionBody(name) {
  const start = src.indexOf("function " + name);
  assert.ok(start >= 0, "нет функции " + name);
  let depth = 0, i = src.indexOf("{", start), end = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (!depth) { end = i; break; } }
  }
  return src.slice(start, end + 1);
}

// === Часть 1: статические проверки источника ===
test("исходник: renderArchive сохраняет прокрутку до innerHTML и восстанавливает после", () => {
  const body = functionBody("renderArchive");
  const firstInner = body.indexOf("container.innerHTML");
  assert.ok(firstInner > 0, "есть перестроение списка");
  const captures = [
    body.indexOf("window.scrollY"),
    body.indexOf("container.scrollTop"),
  ].filter((i) => i >= 0);
  assert.ok(captures.length === 2, "читаются и window.scrollY, и container.scrollTop");
  assert.ok(Math.max(...captures) < firstInner, "позиция читается ДО перестроения списка");
  assert.match(body, /window\.scrollTo\(/, "позиция страницы восстанавливается после перестроения");
  assert.ok(body.indexOf("window.scrollTo(") > firstInner, "восстановление — ПОСЛЕ перестроения");
  assert.ok(/\bcontainer\.scrollTop\s*=/.test(body), "scrollTop контейнера восстанавливается после перестроения");
});

test("исходник: раскрытость групп архива по-прежнему живёт в archiveExpandedObjects", () => {
  const body = functionBody("renderArchive");
  assert.match(body, /archiveExpandedObjects\.has\(/, "состояние раскрытости читается при сборке");
  assert.match(src, /archiveExpandedObjects\.add\(/, "клик по группе сохраняет раскрытость");
});

// === Часть 2: поведенческий прогон renderArchive на мини-харнесе ===
class FakeElement {
  constructor(tag) { this.tagName = tag; this.attrs = {}; this.listeners = {}; this._html = ""; this.scrollTop = 0; this.scrollLeft = 0; this.value = ""; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  getAttribute(n) { return this.attrs[n]; }
  addEventListener(t, h) { (this.listeners[t] || (this.listeners[t] = [])).push(h); }
  contains() { return true; }
  querySelector() { return null; }
  set innerHTML(v) { this._html = String(v); this.scrollTop = 0; /* перестроение сбрасывает прокрутку, как в браузере */ }
  get innerHTML() { return this._html; }
}

function runRenderArchive(scrollYBefore) {
  const container = new FakeElement("div");
  const search = new FakeElement("input");
  search.value = "";
  let currentScrollY = scrollYBefore;
  const scrollToCalls = [];
  const context = {
    hasTabAccess: () => true,
    hasPermission: () => false,
    document: { getElementById: (id) => (id === "archiveContainer" ? container : id === "archiveSearchInput" ? search : new FakeElement("div")), documentElement: {}, body: null },
    state: {
      archive: [
        { id: "a1", date: "2026-11-01", objectId: "o1", objectName: "Объект А", logs: [{ volume: 10 }] },
        { id: "a2", date: "2026-11-02", objectId: "o1", objectName: "Объект А", logs: [{ volume: 5 }] },
        { id: "a3", date: "2026-11-03", objectId: "o2", objectName: "Объект Б", logs: [] },
      ],
      trash: [],
    },
    objectTitle: (id, name) => name || id,
    escapeHtml: (s) => String(s),
    renderTrash: () => {},
    openArchiveModal: () => {}, closeArchiveModal: () => {},
    viewingArchiveId: null,
    window: { scrollY: currentScrollY, scrollTo: (x, y) => { scrollToCalls.push([x, y]); currentScrollY = y; } },
  };
  context.window.document = context.document;
  context.archiveExpandedObjects = new Set(["Объект Б"]);
  vm.runInNewContext(
    functionBody("renderArchive") + "\nrenderArchive();",
    context,
  );
  return { container, scrollToCalls, get scrollY() { return currentScrollY; } };
}

test("поведение: перерисовка списка архива сохраняет позицию страницы", () => {
  const h = runRenderArchive(320);
  assert.match(h.container.innerHTML, /Объект А/, "список собран");
  h.scrollY; // позиция страницы 320 (оператор прокрутил список)
  const first = h.container.innerHTML;
  assert.ok(first.length > 0);
  // Фоновый снапшот вызывает renderArchive повторно — прокрутка не должна сброситься.
  const again = runRenderArchive(320);
  assert.deepEqual(again.scrollToCalls.at(-1), [0, 320], "window.scrollTo восстанавливает позицию страницы");
});

test("поведение: повторная сборка не теряет группы объектов", () => {
  const h = runRenderArchive(0);
  assert.match(h.container.innerHTML, /Объект Б/, "группы объектов на месте после перерисовки");
});

// === Ф3 (владелец, 1.8.1): горизонтальная прокрутка отчёта архивной смены ===
// «Схлопывается обратно к самосвалам» — администратор листает таблицу отчёта
// (paper-scroll-wrapper, колонки «Рейс 1..N») влево к дальним рейсам, а
// фоновый снапшот вызывает renderArchive → openArchiveModal → innerHTML —
// scrollLeft обнуляется и таблица возвращается к колонке «Самосвал».
test("исходник: горизонтальная прокрутка отчёта читается до innerHTML и восстанавливается после", () => {
  const body = functionBody("renderArchiveModalContent");
  const innerAt = body.search(/\.innerHTML\s*=/);
  assert.ok(innerAt > 0, "отчёт перестраивается через innerHTML");
  const readAt = body.indexOf("keepScrollLeft");
  assert.ok(readAt > 0 && readAt < innerAt, "scrollLeft читается ДО перестроения отчёта");
  assert.match(body, /\.scrollLeft\s*=\s*keepScrollLeft/, "scrollLeft восстанавливается после перестроения");
});

// Поведенческий прогон: реальная функция renderArchiveModalContent на мини-харнесе.
// «Браузер» до innerHTML отдаёт старый wrapper (прокрученный к дальним рейсам),
// после innerHTML — новый со scrollLeft=0.
function runModalRender({ scrollLeftBefore = 0, logs = [] } = {}) {
  const oldWrapper = { scrollLeft: scrollLeftBefore };
  const newWrapper = { scrollLeft: 0 };
  let rebuilt = false;
  const modalBody = {
    _html: "",
    scrollTop: 0,
    set innerHTML(v) { this._html = String(v); rebuilt = true; },
    get innerHTML() { return this._html; },
    querySelector: (sel) => (sel === ".paper-scroll-wrapper" ? (rebuilt ? newWrapper : oldWrapper) : null),
  };
  const byId = { modalArchiveBody: modalBody };
  const context = {
    hasTabAccess: () => true,
    hasPermission: () => true,
    document: {
      getElementById: (id) => byId[id] || (byId[id] = { textContent: "", style: {} }),
    },
    state: { archive: [] },
    findTruck: () => null,
    objectTitle: (id, name) => name || id,
    escapeHtml: (s) => String(s),
    resolveUserDisplayName: () => "Имя",
    viewingArchiveGAITable: false,
    viewingArchiveId: "a1",
    window: {},
  };
  const shift = {
    id: "a1",
    date: "2026-11-01",
    objectId: "o1",
    objectName: "Объект А",
    activeLineIds: [],
    ttnStatus: {},
    logs: logs.length ? logs : [
      { truckId: "t1", volume: 10, timeStr: "08:00", createdBy: "u1" },
      { truckId: "t1", volume: 8, timeStr: "09:00", createdBy: "u1" },
      { truckId: "t2", volume: 6, timeStr: "08:30", createdBy: "u1" },
    ],
  };
  vm.runInNewContext(
    functionBody("renderArchiveModalContent") + "\nrenderArchiveModalContent(shift);",
    { ...context, shift },
  );
  return { modalBody, oldWrapper, newWrapper };
}

test("поведение: горизонтальная прокрутка отчёта переживает фоновую перерисовку", () => {
  const h = runModalRender({ scrollLeftBefore: 420 });
  assert.ok(h.modalBody.innerHTML.includes("paper-scroll-wrapper"), "отчёт собран");
  assert.equal(h.newWrapper.scrollLeft, 420, "после перестроения таблица осталась на дальних рейсах, а не «схлопнулась к самосвалам»");
});

test("поведение: свежее открытие отчёта стартует с начала", () => {
  // Модального DOM ещё нет: до innerHTML wrapper не существует.
  const h = runModalRender({ scrollLeftBefore: 0 });
  h.oldWrapper.scrollLeft = 0;
  assert.equal(h.newWrapper.scrollLeft, 0, "новый просмотр начинается с первой колонки");
});
