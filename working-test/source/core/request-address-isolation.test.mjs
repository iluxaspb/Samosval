import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { preferredObjectId } from "../../tabel-v2/object-default.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = () => readFileSync(join(here, "..", "..", "tabel-v2", "workspace.mjs"), "utf8");

const objects = [
  { id: "obj-a", name: "Адрес A" },
  { id: "obj-b", name: "Адрес B" },
];
const shiftOnB = { isActive: true, objectId: "obj-b" };

// (а) вход на «Заявку» берёт адрес из localStorage-ключа заявки,
// не трогая общий ключ. Логика выбора — preferredObjectId с
// requestAddressId (как его вызывает s.requestAddressId/defaultObject(true)).
test("вход на вид request: адрес заявки (A) из ключа, смена (B) его не перебивает", () => {
  const id = preferredObjectId({
    objects,
    requestObjectId: null,
    requestAddressId: "obj-a",
    shift: shiftOnB,
    archive: [],
  });
  assert.equal(id, "obj-a");
});

test("уход с «Заявки»: общий объект = defaultObject(false) — смена/последний, без адреса заявки", () => {
  const id = preferredObjectId({
    objects,
    requestObjectId: null,
    requestAddressId: null, // defaultObject(false) его не передаёт
    shift: shiftOnB,
    archive: [],
  });
  assert.equal(id, "obj-b");
});

test("общий выбор: без адреса заявки работает прежняя цепочка (смена > закрытая > lastObject > первый)", () => {
  assert.equal(
    preferredObjectId({ objects, shift: shiftOnB, archive: [], lastObject: "obj-a" }),
    "obj-b",
  );
  assert.equal(
    preferredObjectId({ objects, shift: null, archive: [], lastObject: "obj-a" }),
    "obj-a",
  );
  assert.equal(preferredObjectId({ objects, shift: null, archive: [] }), "obj-a");
});

// (в) mount/show без requestFirst не берут адрес из ключа заявки.
test("mount: s.object = s.defaultObject(!!host.requestObjectId), а не defaultObject(true)", () => {
  const s = src();
  assert.match(s, /s\.object = s\.defaultObject\(!!host\.requestObjectId\);/,
    "при обычном открытии (requestObjectId=null) приоритет адреса заявки не действует");
});

test("show(): вызывает s.defaultObject(false)", () => {
  const s = src();
  const show = s.match(/async show\(\)\s*\{[\s\S]*?\n    \},/);
  assert.ok(show, "метод show() должен существовать");
  assert.match(show[0], /s\.defaultObject\(false\)/,
    "возврат в табель не должен подставлять адрес заявки общим объектом");
});

// (б) выбор адреса на виде «Заявка» (select с isolate) не пишет общий ключ.
test("select поддерживает isolate и не вызывает remember при isolate", () => {
  const s = src();
  assert.match(s, /s\.select = async \(id, \{ isolate = false \} = \{\}\) =>/,
    "select должен принимать параметр isolate");
  assert.match(s, /if \(!isolate\) remember\(\);/,
    "при isolate=true общий ключ 'tabel-v2-last-object' не перезаписывается");
});

test("header-select: на виде request — s.select(value, { isolate: ... })", () => {
  const s = src();
  const handler = s.match(/\[data-object\]"\)\.onchange([\s\S]*?)\.catch\(error\);/);
  assert.ok(handler, "обработчик select data-object должен существовать");
  assert.match(handler[1], /isolate: s\.view === "request"/,
    "смена адреса на виде «Заявка» должна идти с isolate");
  assert.match(handler[1], /tabel-v2-last-request-object:/,
    "запись ключа адреса заявки на виде request сохранена");
});

// (а)/(г) переключение вкладок.
test("переключение вкладок: вход на request — select(req, {isolate:true}), уход — общий select", () => {
  const s = src();
  const handler = s.match(/\[data-view\]"\)\.forEach\([\s\S]*?\n  \);/);
  assert.ok(handler, "обработчик [data-view] должен существовать");
  assert.match(handler[0], /s\.requestAddressId\(\)/,
    "при входе на «Заявку» берётся адрес заявки");
  assert.match(handler[0], /await s\.select\(req, \{ isolate: true \}\)/,
    "вход на «Заявку» выбирает адрес изолированно");
  assert.match(handler[0], /s\.defaultObject\(false\)/,
    "уход с «Заявки» возвращает общий объект от defaultObject(false)");
});

test("хелпер requestAddressId: requestObjectId хоста или localStorage-ключ", () => {
  const s = src();
  assert.match(s, /s\.requestAddressId = \(\) => \{/,
    "хелпер s.requestAddressId должен существовать");
  assert.match(s, /tabel-v2-last-request-object:/,
    "хелпер читает ключ последнего адреса заявки");
});

test("remember() не пишет общий ключ, пока открыт вид «Заявка»", () => {
  assert.match(src(), /if \(s\.object && s\.view !== "request"\)/,
    "remember должен пропускать запись на виде request");
});
