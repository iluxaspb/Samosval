import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { preferredObjectId } from "../../tabel-v2/object-default.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const objects = [
  { id: "obj-a", name: "Адрес A" },
  { id: "obj-b", name: "Адрес B" },
];
const shiftOnB = { isActive: true, objectId: "obj-b" };

test("сценарий владельца: сохранённый адрес заявки (A) побеждает активную смену (B)", () => {
  const id = preferredObjectId({
    objects,
    requestObjectId: null, // табель уже открыт / страница перезагружена
    requestAddressId: "obj-a", // localStorage 'tabel-v2-last-request-object:*'
    shift: shiftOnB,
    archive: [],
  });
  assert.equal(id, "obj-a");
});

test("явный requestObjectId хоста выше сохранённого адреса заявки", () => {
  const id = preferredObjectId({
    objects,
    requestObjectId: "obj-a",
    requestAddressId: "obj-b",
    shift: shiftOnB,
    archive: [],
  });
  assert.equal(id, "obj-a");
});

test("нет сохранённого адреса и нет явного requestObjectId → активная смена (старое поведение)", () => {
  const id = preferredObjectId({
    objects,
    requestObjectId: null,
    requestAddressId: null,
    shift: shiftOnB,
    archive: [],
  });
  assert.equal(id, "obj-b");
});

test("requestAddressId не влияет на обычный (не-заявочный) выбор: смена побеждает", () => {
  // defaultObject(false) не передаёт requestAddressId вовсе — проверяем сигнатуру
  const id = preferredObjectId({ objects, shift: shiftOnB, archive: [] });
  assert.equal(id, "obj-b");
});

test("сохранённый адрес с неизвестным id игнорируется", () => {
  const id = preferredObjectId({
    objects,
    requestObjectId: null,
    requestAddressId: "obj-deleted",
    shift: shiftOnB,
    archive: [],
  });
  assert.equal(id, "obj-b");
});

test("UI: шапка на виде «Заявка» — зелёный класс и верхняя кнопка Сохранить", () => {
  const src = readFileSync(join(here, "..", "..", "tabel-v2", "workspace.mjs"), "utf8");
  assert.match(src, /tn-request-address/,
    "шапка должна получать класс tn-request-address на виде request");
  assert.match(src, /form="tn-request-form"/,
    "верхняя кнопка Сохранить должна быть type=submit с form=tn-request-form");
  assert.match(src, /<form class="tn-request" id="tn-request-form">/,
    "форма заявки должна иметь id=tn-request-form");
  const css = readFileSync(join(here, "..", "..", "tabel-v2", "workspace.css"), "utf8");
  assert.match(css, /\.tn-header\.tn-request-address/,
    "в workspace.css должна быть зелёная стилизация tn-request-address");
});

test("workspace.mjs: defaultObject читает сохранённый адрес только при explicitRequest", () => {
  const src = readFileSync(join(here, "..", "..", "tabel-v2", "workspace.mjs"), "utf8");
  assert.match(src, /if \(explicitRequest && !host\.requestObjectId\)/,
    "localStorage-адрес заявки должен читаться только для explicitRequest=true и без явного requestObjectId");
  assert.match(src, /tabel-v2-last-request-object:/,
    "ключ последнего адреса заявки должен читаться в defaultObject");
});

test("смена адреса на виде «Заявка» перезаписывает ключ localStorage", () => {
  const src = readFileSync(join(here, "..", "..", "tabel-v2", "workspace.mjs"), "utf8");
  const handler = src.match(/\[data-object\]"\)\.onchange([\s\S]*?)\.catch\(error\);/);
  assert.ok(handler, "обработчик select data-object должен существовать");
  assert.match(handler[1], /s\.view === "request"/,
    "перезапись ключа должна действовать только на виде request");
  assert.match(handler[1], /tabel-v2-last-request-object:/,
    "при выборе адреса на виде request ключ должен перезаписываться");
});
