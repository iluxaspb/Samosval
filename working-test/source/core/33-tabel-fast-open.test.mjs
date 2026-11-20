// Регрессионный тест (1.7.13): быстрое открытие Табеля и корректный PWA-манифест.
// Это тест-инвариант нового поведения: он обязан проходить на коде 1.7.13,
// но НЕ обязан падать на старом коде (до 1.7.12 индикатора и предзагрузки не было).
// Запуск: node --test working-test/source/core/33-tabel-fast-open.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const read = (p) => readFileSync(p, "utf8");
const manifest = read(path.join(root, "manifest-working-test.webmanifest"));
const nav = read(path.join(root, "working-test/source/core/19-navigation.js"));

test("manifest: scope указывает на каталог, а не на файл (PWA открывается standalone)", () => {
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.scope, "./", 'scope должен быть "./" (каталог)');
  assert.ok(!parsed.scope.endsWith(".html"), "scope не должен указывать на файл html");
  assert.equal(parsed.display, "standalone", "display остаётся standalone");
});

test("manifest: PNG-иконки 192/512 с purpose any maskable", () => {
  const pngs = (JSON.parse(manifest).icons || []).filter(
    (i) => i.type === "image/png" && /maskable/.test(i.purpose || "")
  );
  const sizes = pngs.map((i) => i.sizes).sort().join(",");
  assert.match(sizes, /192x192/, "есть PNG 192x192 maskable");
  assert.match(sizes, /512x512/, "есть PNG 512x512 maskable");
});

test("навигация: индикатор «Открываю табель…» показывается при нажатии и убирается в finally", () => {
  assert.match(nav, /showTabelOpeningIndicator\s*\(\)/, "вызов индикатора при открытии");
  assert.match(nav, /Открываю табель…/, "текст индикатора");
  assert.match(nav, /hideTabelOpeningIndicator\s*\(\);\s*tabelV2Opening\s*=\s*false/, "индикатор убирается в finally");
});

test("навигация: фоновая предзагрузка модулей tabel-v2 на requestIdleCallback/setTimeout", () => {
  assert.match(nav, /preloadTabelV2Modules/, "есть функция предзагрузки");
  assert.match(nav, /tabel-v2\/entry\.mjs[\s\S]{0,400}requestIdleCallback|requestIdleCallback[\s\S]{0,400}tabel-v2\/entry\.mjs/, "предзагрузка через requestIdleCallback");
  assert.match(nav, /workspace\.css/, "предзагрузка подтягивает workspace.css");
  assert.match(nav, /DOMContentLoaded[\s\S]{0,600}preloadTabelV2Modules\s*\(\)/, "предзагрузка запускается после старта приложения");
});
