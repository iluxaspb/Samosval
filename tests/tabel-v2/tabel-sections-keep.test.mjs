// Регрессионный тест не-табличных видов табеля (workspace.mjs, П6).
// Живые обновления вызывают render() → s.root.innerHTML целиком: на видах
// «Заявки / Смена / Справочник / История» сбрасывались прокрутка main и
// раскрытые сворачиваемые разделы. Теперь перед полной пересборкой
// сохраняются позиция прокрутки main и открытые <details>/aria-expanded
// разделы (ключ — summary/id), после — восстанавливаются (паттерн
// shiftContext из ~618-625, 758-763). Ввод в input/textarea по-прежнему
// откладывает перерисовку (refreshIncoming) — это не должно сломаться.
// Запуск: node --test tests/tabel-v2/tabel-sections-keep.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, "..", "..", "working-test", "tabel-v2", "workspace.mjs"),
  "utf8",
);

function functionBody(name) {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, "нет функции " + name);
  let depth = 0, i = src.indexOf("{", start), end = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (!depth) { end = i; break; } }
  }
  return src.slice(start, end + 1);
}

// === Часть 1: статические проверки источника ===
test("исходник: render() сохраняет прокрутку и раскрытые разделы до пересборки root", () => {
  const body = functionBody("render");
  const rebuild = body.indexOf("s.root.innerHTML");
  assert.ok(rebuild > 0, "есть полная пересборка");
  const saveCall = body.indexOf("keepViewLayout(");
  assert.ok(saveCall >= 0 && saveCall < rebuild, "раскладка вида сохраняется ДО s.root.innerHTML");
  const restoreMatch = body.match(/restoreViewLayout\(/g) || [];
  assert.ok(restoreMatch.length >= 1, "раскладка вида восстанавливается после пересборки");
});

test("исходник: сохранение/восстановление раскладки — общие помощники с ключами разделов", () => {
  assert.match(src, /function keepViewLayout\(/, "есть keepViewLayout");
  assert.match(src, /function restoreViewLayout\(/, "есть restoreViewLayout");
  const keep = functionBody("keepViewLayout");
  const restore = functionBody("restoreViewLayout");
  assert.match(keep, /scrollTop/, "keepViewLayout читает прокрутку");
  assert.match(keep, /details|open/i, "keepViewLayout собирает раскрытые разделы");
  assert.match(restore, /scrollTop/, "restoreViewLayout восстанавливает прокрутку");
  assert.match(restore, /details|open/i, "restoreViewLayout восстанавливает раскрытость");
});

test("исходник: защита ввода в refreshIncoming не тронута", () => {
  const body = functionBody("refreshIncoming");
  assert.match(body, /active\?\.matches\("input:not\(\[readonly\]\),textarea"\)/, "фокус в input/textarea по-прежнему откладывает перерисовку");
  assert.match(body, /setTimeout\(\(\) => refreshIncoming/, "отложенный повтор через таймер на месте");
});

// === Часть 2: поведенческий прогон помощников на мини-харнесе ===
class FakeElement {
  constructor(tag, html = "") {
    this.tagName = tag; this.children = []; this.attrs = {}; this._html = html;
    this.scrollTop = 0; this.scrollLeft = 0;
  }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  getAttribute(n) { return this.attrs[n]; }
  querySelectorAll() { return []; }
  querySelector(sel) {
    if (sel === "main") return this.main || null;
    return null;
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
}

// Извлекаем только тела keepViewLayout/restoreViewLayout и прогоняем сценарий:
// вид с прокруткой main=240 и раскрытым details восстанавливается после
// полной пересборки (новый root, новый main).
function extractHelpers() {
  const names = ["keepViewLayout", "restoreViewLayout"];
  const out = names
    .map((n) => "globalThis.__seen = globalThis.__seen || {};" + functionBody(n).replace("function " + n, "globalThis.__seen." + n + " = function"))
    .join("\n");
  return out;
}

test("поведение: после пересборки main получает сохранённую прокрутку, а раздел — раскрытость", () => {
  const code = extractHelpers() + `
    const openDetails = { open: true, attrs: {}, setAttribute(n, v) { this.attrs[n] = v; }, getAttribute() { return null; }, querySelector: () => ({ textContent: " Раздел Х " }) };
    const oldMain = { scrollTop: 240, scrollLeft: 0, querySelectorAll: (sel) => (sel === "details[open]" ? [openDetails] : sel === '[aria-expanded="true"]' ? [] : []) };
    const oldRoot = { querySelector: (sel) => (sel === "main" ? oldMain : null) };
    const s = { view: "history" };
    const saved = globalThis.__seen.keepViewLayout(s, oldRoot);
    const closedDetails = { open: false, attrs: {}, setAttribute(n, v) { this.attrs[n] = v; }, getAttribute() { return null; }, querySelector: () => ({ textContent: "Раздел Х" }) };
    const newMain = { scrollTop: 0, scrollLeft: 0, querySelectorAll: (sel) => (sel === "details" ? [closedDetails] : sel === "[aria-expanded]" ? [] : []) };
    const details = closedDetails;
    globalThis.__seen.restoreViewLayout(s, { querySelector: (sel) => (sel === "main" ? newMain : null) }, saved);
    return { top: newMain.scrollTop, left: newMain.scrollLeft, open: details.open };
  `;
  const result = new Function("globalThis", "return " + "(function(globalThis){" + code + "})")(globalThis)(globalThis);
  assert.equal(result.top, 240, "прокрутка main восстановлена");
  assert.equal(result.left, 0, "горизонтальная прокрутка восстановлена");
  assert.equal(result.open, true, "раскрытый раздел восстановлен");
});
