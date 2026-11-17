// Регрессионный тест (1.7.15): адресная строка табеля (лист linked, A1)
// не затирается живой перекраской refreshVisibleCells().
// До 1.7.15 refreshVisibleCells делал td.replaceChildren(textNode(computed))
// для ВСЕХ ячеек [data-cell], включая A1: div с названием объекта уничтожался,
// а формула для A1 возвращала метку «Адрес» — оставалась пустая оранжевая
// полоса или слово «Адрес». Схема теста: сначала воспроизводим draw()-логику
// адресной строки (div с названием), затем прогоняем реальный фрагмент
// refreshVisibleCells из grid.mjs на моках DOM и проверяем, что div жив.
// Запуск: node --test working-test/source/core/tabel-address-repaint.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "../../tabel-v2/grid.mjs"), "utf8");

// Мини-DOM: только то, что нужно проверяемому фрагменту.
function mockDocument() {
  return {
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    createElement: (tag) => ({ nodeType: 1, tagName: tag, textContent: "" }),
  };
}
function mockTd() {
  return { childNodes: [], style: {}, cssText: "",
    replaceChildren(...nodes) { this.childNodes = nodes; } };
}

// Извлекаем из grid.mjs реальный фрагмент refreshVisibleCells между
// вычислением contractor и td.style.cssText — он и решает, что попадёт в td.
function extractRepaintFragment() {
  const start = source.indexOf("const contractor=sheetId==='linked'&&pcol===0&&r>1");
  const end = source.indexOf("td.style.cssText=css(cellStyle(k));", start);
  assert.ok(start > 0 && end > start, "фрагмент перекраски найден в refreshVisibleCells");
  return source.slice(start, end);
}

const OBJECT_NAME = "Объект Пятницкая 1";

test("draw(): адресная строка рендерится как div с названием объекта", () => {
  const s = { config: () => ({ name: OBJECT_NAME }), object: { address: "", location: "" } };
  const c = s.config();
  // Копия draw()-логики строки .tn-address (grid.mjs, строка с tn-address).
  const td = mockTd();
  const div = mockDocument().createElement("div");
  div.textContent = String(c.name || s.object.address || s.object.location);
  td.replaceChildren(div);
  assert.equal(td.childNodes.length, 1);
  assert.equal(td.childNodes[0].tagName, "div");
  assert.equal(td.childNodes[0].textContent, OBJECT_NAME);
});

test("refreshVisibleCells(): живая перекраска НЕ затирает адресную строку A1 (баг 1.7.15)", () => {
  const s = { config: () => ({ name: OBJECT_NAME }), object: { address: "", location: "" } };
  const td = mockTd();
  // Состояние после draw(): div с названием объекта.
  const div = mockDocument().createElement("div");
  div.textContent = OBJECT_NAME;
  td.replaceChildren(div);

  // Прогоняем реальный фрагмент refreshVisibleCells для ячейки A1
  // (sheetId==='linked', r===0, pcol===0, value — computed формулы = «Адрес»).
  const sheetId = "linked", r = 0, pcol = 0, linkedRows = [], value = "Адрес";
  const document = mockDocument();
  const fragment = extractRepaintFragment();
  // eslint-disable-next-line no-new-func
  const run = new Function(
    "td", "document", "sheetId", "r", "pcol", "linkedRows", "value", "s",
    fragment,
  );
  run(td, document, sheetId, r, pcol, linkedRows, value, s);

  assert.equal(td.childNodes.length, 1, "в A1 ровно один узел");
  assert.equal(td.childNodes[0].tagName, "div",
    "адресная строка остаётся div, а не текстовым узлом");
  assert.equal(td.childNodes[0].textContent, OBJECT_NAME,
    "div содержит название объекта, а не метку «Адрес»");
  assert.notEqual(td.childNodes[0].textContent, "Адрес",
    "computed-значение формулы не затёрло адрес");
});

test("refreshVisibleCells(): обычные ячейки по-прежнему перекрашиваются текстом", () => {
  const td = mockTd();
  const document = mockDocument();
  const sheetId = "linked", r = 3, pcol = 1, linkedRows = [], value = 42;
  const s = { config: () => ({ name: OBJECT_NAME }), object: {} };
  const fragment = extractRepaintFragment();
  const run = new Function(
    "td", "document", "sheetId", "r", "pcol", "linkedRows", "value", "s",
    fragment,
  );
  run(td, document, sheetId, r, pcol, linkedRows, value, s);
  assert.equal(td.childNodes[0].nodeType, 3, "обычная ячейка — текстовый узел");
  assert.equal(td.childNodes[0].textContent, "42");
});
