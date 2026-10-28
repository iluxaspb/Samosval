import test from "node:test";
import assert from "node:assert/strict";
import { oldBrushes } from "../../test-app/tabel-v2/legacy-equipment.mjs";
import * as D from "../../test-app/tabel-v2/table-domain.mjs";
test("cleanup targets only orphan hired brush without crew label; registered machinery and facts preserved", () => {
  const old = { id: "old", name: "Щётка", ownership: "hired", hours: 12 },
    real = {
      id: "real",
      name: "МТЗ щётка",
      ownership: "own",
      crewLabel: "Тракторист",
      hours: 12,
    };
  const days = [
      { date: "2026-10-15", equipment: [old, real], people: [], values: {} },
    ],
    c = D.config({ id: "site", name: "A", startDate: "2026-10-10" });
  c.equipment = [real];
  c.request.equipment = ["real"];
  assert.deepEqual(
    oldBrushes(c, days, [real]).map((x) => x.id),
    ["old"],
  );
  c.hiddenEquipmentIds = ["old"];
  assert(!D.rows(c, days).some((r) => r.entity === "old"));
  assert(D.rows(c, days).some((r) => r.entity === "real"));
  assert.equal(days[0].equipment[0].hours, 12);
  assert.equal(D.equipmentCount(days, [], c), 1);
  assert.equal(oldBrushes(c, days, [real]).length, 0);
  assert.equal(oldBrushes({}, days, []).length, 0);
});
