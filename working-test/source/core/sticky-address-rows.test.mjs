// Регрессия «белой пустой строки» в Табеле (tabel-v2, linked-лист).
// В full-режиме (с осями) над адресом залипает шапка колонок (thead, 26px).
// Старый код ставил адресу sticky top:0 (под шапкой), а строке дат — top без
// учёта высоты thead: строки наезжали на шапку, между видимыми полосами
// оставалась светлая полоса. Тест фиксирует источник и стили.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "working-test", "tabel-v2");
const css = readFileSync(join(dir, "workspace.css"), "utf8");
const grid = readFileSync(join(dir, "grid.mjs"), "utf8");

test("css: в full-режиме адрес залипает под шапкой колонок (top:26px), а не под верхом (top:0)", () => {
  // Порядок правил важен: более специфичное .tn-grid-axis-правило идёт после
  // базового top:0 и переопределяет его только при наличии шапки (full-режим).
  const base = css.indexOf(".tn-linked tbody tr:nth-child(1) > * {");
  const axis = css.indexOf(".tn-grid.tn-grid-axis.tn-linked tbody tr:nth-child(1) > *");
  assert.ok(base >= 0, "нет базового sticky-правила строки адреса");
  assert.ok(axis > base, "нет правила .tn-grid.tn-grid-axis.tn-linked для строки адреса после базового");
  const axisBlock = css.slice(axis, css.indexOf("}", axis));
  assert.match(axisBlock, /top:\s*26px/, "адрес в full-режиме должен залипать на top:26px (под thead)");
});

test("grid: офсет строки дат учитывает высоту thead и фактическую высоту адреса", () => {
  // Старый код: td.style.top = высота_адреса — без thead датная строка
  // залипала на 26px выше, оставляя видимый зазор/наложение.
  assert.match(grid, /const theadH = table\.querySelector\("thead"\)\?\.getBoundingClientRect\(\)\.height \|\| 0/, "grid.mjs должен измерять высоту thead");
  const idx = grid.indexOf("td.style.top =");
  const expr = grid.slice(idx, grid.indexOf("+ \"px\"", idx));
  assert.match(expr, /theadH \+/, "top строки дат = theadH + высота адреса");
  assert.match(expr, /tn-address/, "высота адреса берётся из фактического .tn-address rect");
});

test("grid: порядок строк linked-листа — адрес (r=0), затем даты (r=1), техника (r>=2)", () => {
  assert.match(grid, /if \(sheetId === "linked" && r === 0\)\s*\n\s*return `<tr class="tn-address"/, "r=0 — строка адреса");
  assert.match(grid, /r === 1 \? " tn-weekend-date" : ""/, "r=1 — строка дат");
});
