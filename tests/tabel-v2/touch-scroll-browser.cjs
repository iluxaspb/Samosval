const { spawn } = require("node:child_process"),
  assert = require("node:assert/strict");
const { chromium } = require(
  process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + "/playwright",
);
const server = spawn(
  "python3",
  ["-m", "http.server", "8817", "--bind", "127.0.0.1"],
  { stdio: "ignore" },
);
(async () => {
  let b;
  try {
    b = await chromium.launch({
      executablePath: "/tmp/tabel-chromium",
      args: ["--no-sandbox"],
    });
    const p = await b.newPage({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
    });
    p.setDefaultTimeout(8000);
    await p.goto("http://127.0.0.1:8817/tests/tabel-v2/harness.html");
    await p.waitForFunction(() => ready);
    await p.evaluate(async () => {
      const { Store } = await import("/test-app/tabel-v2/store.mjs"),
        open = Store.prototype.open;
      Store.prototype.open = async function () {
        window.qaStore = this;
        return open.call(this);
      };
      seedLegacy();
    });
    await p.locator("#open").click();
    await p.locator("[data-view=table]").click();
    await p.locator(".tn-grid").waitFor();
    await p.evaluate(async () => {
      const key = "site-a/config",
        base = qaStore.get(key),
        c = base.data;
      c.works = Array.from({ length: 45 }, (_, i) => ({
        id: "work-" + i,
        name: "Работа " + i,
        unit: "м²",
      }));
      await qaStore.save(key, c, base, "Tall sheet");
    });
    await p.locator("[data-view=shift]").click();
    await p.locator("[data-view=table]").click();
    await p.locator(".tn-grid").waitFor();
    const cdp = await p.context().newCDPSession(p);
    const gesture = async (a, z) => {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [a],
      });
      for (let i = 1; i <= 8; i++)
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            { x: a.x + ((z.x - a.x) * i) / 8, y: a.y + ((z.y - a.y) * i) / 8 },
          ],
        });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    };
    const scroll = p.locator(".tn-grid-scroll");
    const before = await scroll.evaluate((e) => ({
      x: e.scrollLeft,
      y: e.scrollTop,
    }));
    const range = await p.locator("[data-range]").inputValue(),
      box = await scroll.boundingBox();
    await gesture(
      { x: box.x + box.width - 35, y: box.y + box.height - 40 },
      { x: box.x + 30, y: box.y + 45 },
    );

    await p.waitForFunction((b) => {
      const e = document.querySelector(".tn-grid-scroll");
      return e.scrollLeft > b.x && e.scrollTop > b.y;
    }, before);
    assert.equal(await p.locator("[data-range]").inputValue(), range);
    assert.equal(await p.locator("dialog[open]").count(), 0);
    // Return to a known numeric cell, tap to open the branded keypad.
    await scroll.evaluate((e) => {
      e.scrollLeft = 0;
      e.scrollTop = 0;
    });
    await p.locator("[data-cell=B4]").tap();
    await p.locator("dialog.tn-hours-dialog[open]").waitFor();
    await p.locator("dialog[open] [data-action=close]").first().click();
    const daysBefore = await p.evaluate(() =>
      JSON.stringify(qaStore.list("site-a/day:").map((r) => r.data)),
    );
    const handle = await p.locator(".tn-fill").boundingBox(),
      target = await p.locator("[data-cell=D5]").boundingBox();
    await gesture(
      { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 },
      { x: target.x + target.width / 2, y: target.y + target.height / 2 },
    );
    assert.equal(await p.locator("[data-range]").inputValue(), "B4:D5");
    assert.equal(
      await p.evaluate(() =>
        JSON.stringify(qaStore.list("site-a/day:").map((r) => r.data)),
      ),
      daysBefore,
    );
    assert.equal(await p.locator("dialog[open]").count(), 0);
    await p.locator("[data-cell=C4]").tap();
    await p.locator("dialog[open]").waitFor();
    assert.match(await p.locator("dialog[open]").innerText(), /Ячейки B4:D5/);
    await p.locator("dialog[open] footer [data-action=close]").click();
    // A tap outside the range must still open the keypad after a drag.
    await p.locator("[data-cell=E4]").tap();
    await p.locator("dialog.tn-hours-dialog[open]").waitFor();
    await p.locator("dialog[open] [data-action=close]").first().click();
    await p.evaluate(async () => {
      const key = "site-a/config",
        base = qaStore.get(key),
        c = base.data;
      c.tableMode = "full";
      await qaStore.save(key, c, base, "Full mode");
    });
    await p.locator("[data-view=shift]").click();
    await p.locator("[data-view=table]").click();
    await p.locator(".tn-grid").waitFor();
    await scroll.evaluate((e) => {
      e.scrollLeft = 0;
      e.scrollTop = 0;
    });
    const fullBox = await scroll.boundingBox();
    await gesture(
      { x: fullBox.width - 35, y: fullBox.y + fullBox.height - 40 },
      { x: 30, y: fullBox.y + 45 },
    );
    await p.waitForFunction(() => {
      const e = document.querySelector(".tn-grid-scroll");
      return e.scrollLeft > 0 && e.scrollTop > 0;
    });
    assert.equal(await p.locator("dialog[open]").count(), 0);
    console.log(
      "PASS real touch: native two-axis scroll, corner-only range selection without writes, range tap menu, numeric tap after drag",
    );
  } finally {
    await b?.close();
    server.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
