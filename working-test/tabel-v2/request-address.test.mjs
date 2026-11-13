import { test } from "node:test";
import assert from "node:assert/strict";
import { preferredObjectId } from "./object-default.mjs";
import { isRequestOnlyChange } from "./request-domain.mjs";

const objects = [
  { id: "obj-a", name: "Адрес А" },
  { id: "obj-b", name: "Адрес Б" },
];
const activeShift = { isActive: true, objectId: "obj-b" };

test("preferredObjectId: явный requestObjectId побеждает объект активной смены", () => {
  const id = preferredObjectId({
    objects,
    requestObjectId: "obj-a",
    shift: activeShift,
  });
  assert.equal(id, "obj-a");
});

test("preferredObjectId: без requestObjectId активная смена побеждает", () => {
  const id = preferredObjectId({ objects, shift: activeShift });
  assert.equal(id, "obj-b");
});

test("isRequestOnlyChange: изменение только request → true", () => {
  const before = { name: "Адрес А", equipment: [{ id: "e1" }], request: { date: "2026-11-13" } };
  const after = { name: "Адрес А", equipment: [{ id: "e1" }], request: { date: "2026-11-14", people: ["p1"] } };
  assert.equal(isRequestOnlyChange(before, after), true);
});

test("isRequestOnlyChange: изменение name → false", () => {
  const before = { name: "Адрес А", request: { date: "2026-11-13" } };
  const after = { name: "Адрес Б", request: { date: "2026-11-13" } };
  assert.equal(isRequestOnlyChange(before, after), false);
});

test("isRequestOnlyChange: изменение sheetAccess → false", () => {
  const before = { name: "Адрес А", sheetAccess: { linked: { view: true } }, request: {} };
  const after = { name: "Адрес А", sheetAccess: { linked: { view: true, edit: true } }, request: {} };
  assert.equal(isRequestOnlyChange(before, after), false);
});

test("isRequestOnlyChange: base=null → false", () => {
  assert.equal(isRequestOnlyChange(null, { request: { date: "2026-11-13" } }), false);
});
