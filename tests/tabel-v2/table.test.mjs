import assert from "node:assert/strict";
import * as D from "../../test-app/tabel-v2/table-domain.mjs";
const c = D.config({ id: "a", name: "A", startDate: "2026-10-10" });
c.equipment = [
  { id: "mill", name: "Фреза", ownership: "own" },
  { id: "water", name: "Поливомойка", ownership: "own", pump: true },
  { id: "hired", name: "Наёмный каток", ownership: "hired" },
];
c.request.equipment = c.equipment.map((e) => e.id);
const d = D.createDay(c, "2026-10-10");
const rows = D.rows(c, [d]);
assert.equal(rows.filter((r) => r.entity === "mill").length, 2);
assert.equal(rows.filter((r) => r.entity === "water").length, 3);
assert.equal(rows.filter((r) => r.entity === "hired").length, 1);
const crew = rows.find((r) => r.entity === "mill" && r.field === "crewHours");
D.setValue(crew, d, "52");
assert.equal(d.equipment[0].crewHours, 52);
assert.equal(D.value(crew, d), 52);
assert.throws(() => D.setValue({ ...crew, field: "hours" }, d, "25"));
assert.throws(() => D.createDay(c, "2026-10-09"));
const future = D.createDay(c, D.add(D.today(), 1));
assert.equal(future.equipment[0].hours, null);
assert.throws(() => D.setValue(crew, future, "12"));
assert.deepEqual(D.weeks("2026-10-11", "2026-10-18"), [
  { id: "2026-10-05", start: "2026-10-11", end: "2026-10-11" },
  { id: "2026-10-12", start: "2026-10-12", end: "2026-10-18" },
]);
assert.equal(
  D.formula(
    { A1: { raw: "2" }, B1: { raw: "3" }, C1: { raw: "=A1+B1" } },
    "C1",
  ),
  5,
);
assert.equal(
  D.formula({ A1: { raw: "=B1" }, B1: { raw: "=A1" } }, "A1"),
  "#ЦИКЛ!",
);
assert.equal(D.formula({ A1: { raw: "=1/0" } }, "A1"), "#ДЕЛ/0!");
assert.equal(D.formula({ A1: { raw: "=alert(1)" } }, "A1"), "#ИМЯ?"); // Excel-style unsupported function error
assert.equal(
  D.formula(
    { A1: { raw: "1,5" }, A2: { raw: "2" }, B1: { raw: "=СУММ(A1:A2)" } },
    "B1",
  ),
  3.5,
);
assert.equal(D.translate("=A1+B1", 2, 1), "=B3+C3");
assert.throws(() => D.range("A1", "A10002"));
assert.equal(
  D.equipmentCount(
    [{ equipment: [{ id: "a", plate: "А123ВС78" }] }],
    [
      { id: "b", plate: "A123BC78", arrived: true },
      { id: "gai", arrived: true, isGAI: true },
    ],
    c,
  ),
  1,
);
assert.equal(
  D.allowed(
    {
      uid: "x",
      status: "active",
      tabAccess: true,
      role: "operator",
      permissions: { view: true, edit: true },
    },
    c,
    "table",
  ),
  false,
);
console.log(
  "PASS domain: aggregate hours, optional pump, future plan, dates, formulas, deduplication, deny-by-default",
);

const { arrivals } = await import("../../test-app/tabel-v2/line.mjs");
const line = arrivals(
  {
    trucks: [
      { id: "t", number: "А123ВС78" },
      { id: "g", isGAI: true },
    ],
    audit: [
      {
        objectId: "a",
        timestamp: Date.parse("2026-10-10T10:00:00+03:00"),
        eventType: "arrive",
        text: "Прибытие на линию",
        truckId: "t",
      },
      {
        objectId: "a",
        timestamp: Date.parse("2026-10-10T11:00:00+03:00"),
        eventType: "arrive",
        text: "Прибытие на линию",
        truckId: "g",
      },
    ],
  },
  "a",
  "2026-10-10",
  [],
  true,
);
assert.equal(D.equipmentCount([], line.rows, c), 1);
assert(line.complete);
console.log(
  "PASS read-only Line adapter: arrival without load, calendar date, GAI exclusion",
);
