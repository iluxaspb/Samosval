const assert = require("node:assert/strict"),
  { spawn } = require("node:child_process");
const { chromium } = require(
  process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + "/playwright",
);
const server = spawn(
  "python3",
  ["-m", "http.server", "8815", "--bind", "127.0.0.1"],
  { stdio: "ignore" },
);
(async () => {
  let b;
  try {
    b = await chromium.launch({
      executablePath: "/tmp/tabel-chromium",
      args: ["--no-sandbox"],
    });
    const p = await b.newPage({ viewport: { width: 393, height: 852 } });
    p.setDefaultTimeout(7000);
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.clock.setFixedTime(new Date("2026-10-28T12:00:00+03:00"));
    await p.goto("http://127.0.0.1:8815/tests/tabel-v2/harness.html");
    await p.waitForFunction(() => ready);
    await p.evaluate(async () => {
      const { Store } = await import("/test-app/tabel-v2/store.mjs");
      const open = Store.prototype.open;
      Store.prototype.open = async function () {
        window.qaStore = this;
        return open.call(this);
      };
    });
    await p.locator("#open").click();
    await p.waitForFunction(() => window.qaStore);
    await p.evaluate(async () => {
      const D = await import("/test-app/tabel-v2/table-domain.mjs"),
        c = D.config({
          id: "site-a",
          name: "Объект А",
          startDate: "2026-10-10",
        });
      c.equipment = [
        {
          id: "truck",
          name: "Самосвал",
          ownership: "hired",
          contractor: "ИП",
          contractorId: "ип",
        },
        { id: "mill", name: "W205", kind: "mill", ownership: "own" },
      ];
      c.request.equipment = ["truck", "mill"];
      await qaStore.save(
        "site-a/config",
        c,
        qaStore.get("site-a/config"),
        "Config",
      );
      for (const date of ["2026-10-10", "2026-10-28"]) {
        const d = D.createDay(c, date);
        d.equipment[0].hours = 12;
        const key = "site-a/" + D.dayKey(date, "day");
        await qaStore.save(key, d, qaStore.get(key), "Shift");
      }
    });
    await p.locator("button[data-view=shift]").click();
    await p.locator("[data-card=truck] .tn-contractor").click();
    await p.locator("dialog[open] [name=contractor]").fill("ДСК");
    const save = async () => {
      await p.locator("dialog[open] [type=submit]").last().click();
      await p.locator("dialog[open]").waitFor({ state: "hidden" });
    };
    await save();
    assert.equal(
      await p.evaluate(
        () =>
          qaStore.get("site-a/day:2026-10-10:day").data.equipment[0].contractor,
      ),
      "ИП",
    );
    assert.equal(
      await p.evaluate(
        () =>
          qaStore.get("site-a/day:2026-10-28:day").data.equipment[0].contractor,
      ),
      "ДСК",
    );
    assert(
      await p.evaluate(() =>
        qaStore
          .get("_catalog/config")
          .data.contractors.some((x) => x.name === "ДСК"),
      ),
    );
    await p.locator("[data-open=mill]").click();
    await p.locator("[data-double-crew]").check();
    await save();
    await p.locator("[data-open=mill]").click();
    assert(await p.locator("[data-double-crew]").isChecked());
    await p.locator("[data-double-crew]").uncheck();
    await save();
    await p.locator("[data-open=mill]").click();
    assert(!(await p.locator("[data-double-crew]").isChecked()));
    await p.locator("dialog[open] [data-action=close]").first().click();
    await p.locator("button[data-view=catalog]").click();
    await p.locator("[data-action=edit-catalog][data-id=mill]").click();
    await p.locator("[data-color-field=color]").click();
    await p.locator("[data-family=blue]").click();
    await p.locator("[data-color]").nth(5).click();
    await save();
    assert(
      await p.evaluate(() =>
        /^#/.test(
          qaStore
            .get("_catalog/config")
            .data.equipment.find((x) => x.id === "mill").color,
        ),
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS hired contractor history/dictionary; mill x2 persists on/off after saving; catalog color picker saves",
    );
  } finally {
    await b?.close();
    server.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
