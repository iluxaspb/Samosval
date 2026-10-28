import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../../test-app/tabel-v2/table-domain.mjs";

test("hired truck rows separate contractors and reuse returning company without editing earlier days", () => {
  const truck = { id: "t", name: "Самосвал", ownership: "hired" },
    c = D.config({ id: "site", name: "A", startDate: "2026-10-10" });
  c.equipment = [truck];
  c.request.equipment = ["t"];
  const ds = [
    ["2026-10-10", "ИП", 12],
    ["2026-10-11", "ДСК", 12],
    ["2026-10-12", "ИП", 14],
  ].map(([date, contractor, hours]) => ({
    date,
    shift: "day",
    equipment: [
      { ...truck, contractor, contractorId: contractor.toLowerCase(), hours },
    ],
    people: [],
    values: {},
  }));
  const rows = D.rows(c, ds).filter((x) => x.entity === "t");
  assert.equal(rows.length, 3);
  const ip = rows.find((r) => r.contractor === "ип");
  assert.equal(D.value(ip, ds[0]), 12);
  assert.equal(D.value(ip, ds[1]), null);
  assert.equal(D.value(ip, ds[2]), 14);
  assert.equal(c.equipment.length, 1);
});
