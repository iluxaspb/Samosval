import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { preferredObjectId } from "../../working-test/tabel-v2/object-default.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const objects = [
  { id: "obj-request" },
  { id: "obj-shift" },
  { id: "obj-other" },
];

test("preferredObjectId: адрес заявки побеждает активную смену", () => {
  const id = preferredObjectId({
    objects,
    requestObjectId: "obj-request",
    shift: { isActive: true, objectId: "obj-shift" },
    archive: [],
  });
  assert.equal(id, "obj-request");
});

test("preferredObjectId: без заявки активная смена побеждает", () => {
  const id = preferredObjectId({
    objects,
    requestObjectId: null,
    shift: { isActive: true, objectId: "obj-shift" },
    archive: [],
  });
  assert.equal(id, "obj-shift");
});

test("source anchor: show() вызывает defaultObject(true) в working-test", () => {
  const src = readFileSync(
    join(here, "..", "..", "working-test", "tabel-v2", "workspace.mjs"),
    "utf8"
  );
  assert.match(src, /s\.object = s\.defaultObject\(!!host\.requestObjectId\);/,
    "адрес заявки (requestObjectId) должен учитываться при выборе объекта, иначе изолированный адрес сбрасывается на объект активной смены");
});
