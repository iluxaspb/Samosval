const assert = require("node:assert/strict"),
  { spawn } = require("node:child_process");
const { chromium } = require(
  process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + "/playwright",
);
const server = spawn(
  "python3",
  ["-m", "http.server", "8813", "--bind", "127.0.0.1"],
  { stdio: "ignore" },
);
(async () => {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: "/tmp/tabel-chromium",
      args: ["--no-sandbox"],
    });
    const p = await browser.newPage({
        viewport: { width: 393, height: 852 },
        permissions: ["clipboard-read", "clipboard-write"],
      }),
      errors = [];
    p.setDefaultTimeout(8000);
    p.on("pageerror", (e) => {
      errors.push(e.message);
      console.log(e.stack);
    });
    await p.clock.setFixedTime(new Date("2026-10-28T12:00:00+03:00"));
    await p.goto("http://127.0.0.1:8813/tests/tabel-v2/harness.html");
    await p.waitForFunction(() => ready);
    await p.evaluate(async () => {
      const { Store } = await import("/test-app/tabel-v2/store.mjs");
      const original = Store.prototype.open;
      Store.prototype.open = async function () {
        window.qaStore = this;
        return original.call(this);
      };
    });
    await p.locator("#open").click();
    await p.locator("button[data-view=table]").click();
    const action = (a) => p.locator('[data-action="' + a + '"]'),
      cell = (k) => p.locator('[data-cell="' + k + '"]');
    await action("new-sheet")
      .waitFor()
      .catch(async (e) => {
        console.log(await p.locator(".tn-app").innerText());
        throw e;
      });
    await action("new-sheet").click();
    await p.locator("dialog[open] [type=submit]").click();
    await p.locator("dialog[open]").waitFor({ state: "hidden" });
    const editor = p.locator("[data-editor]");
    // Change of selected cell commits the prior value without using the checkmark.
    await cell("A1").click();
    await editor.fill("5");
    await cell("A2").click();
    await p.waitForFunction(
      () => document.querySelector("[data-cell=A1]").textContent === "5",
    );
    await editor.fill("7");
    await cell("B1").click();
    await p.waitForFunction(
      () => document.querySelector("[data-cell=A2]").textContent === "7",
    );
    // Default drag selection changes no values and shows the sum immediately.
    const drag = async (a, b) => {
      await cell(a).scrollIntoViewIfNeeded();
      const formula = (await editor.inputValue()).startsWith("=");
      if (!formula) {
        await p.locator("[data-range]").fill(a);
        await p.locator("[data-range]").dispatchEvent("change");
        await cell(a).click();
        if (await p.locator("dialog[open]").count())
          await p.locator("dialog[open] footer [data-action=close]").click();
      }
      const x = formula
          ? await cell(a).boundingBox()
          : await p.locator(".tn-fill").boundingBox(),
        y = await cell(b).boundingBox();
      await p.mouse.move(x.x + x.width / 2, x.y + x.height / 2);
      await p.mouse.down();
      await p.mouse.move(y.x + y.width / 2, y.y + y.height / 2, { steps: 6 });
      await p.mouse.up();
    };
    await drag("A1", "A2");
    assert.equal(await p.locator(".tn-selected").count(), 2);
    assert.match(
      await p.locator("[data-selection-total]").innerText(),
      /Сумма: 12/,
    );
    await cell("A1").click();
    await p.locator("dialog[open]").waitFor();
    assert.match(await p.locator("dialog[open]").innerText(), /Копировать/);
    await p.locator("dialog[open] [data-action=copy]").click();
    assert.equal(
      await p.evaluate(() => navigator.clipboard.readText()),
      "5\n7",
    );
    await cell("C1").click();
    await cell("C1").click();
    await p.locator("dialog[open] [data-action=paste]").click();
    await p.waitForFunction(
      () => document.querySelector("[data-cell=C2]").textContent === "7",
    );
    // Reference picking retains destination, and supports sums of dragged ranges.
    await cell("B1").click();
    await editor.fill("=");
    await cell("A1").click();
    assert.equal(await editor.inputValue(), "=A1");
    await editor.press("Enter");
    await p.waitForFunction(
      () => document.querySelector("[data-cell=B1]").textContent === "5",
    );
    await cell("B2").click();
    await editor.fill("=СУММ");
    await drag("A1", "A2");
    assert.equal(await editor.inputValue(), "=СУММ(A1:A2)");
    await editor.press("Enter");
    await p.waitForFunction(
      () => document.querySelector("[data-cell=B2]").textContent === "12",
    );
    await cell("A1").click();
    await editor.fill("10");
    await cell("D1").click();
    await p.waitForFunction(
      () => document.querySelector("[data-cell=B2]").textContent === "17",
    );
    await editor.fill("=24*34");
    await cell("D2").click();
    await p.waitForFunction(
      () => document.querySelector("[data-cell=D1]").textContent === "816",
    );
    // Blur saves, and clearing a selected range clears its content.
    await editor.fill("9");
    await p.locator("[data-zoom]").focus();
    await p.waitForFunction(
      () => document.querySelector("[data-cell=D2]").textContent === "9",
    );
    await drag("C1", "C2");
    await cell("C1").click();
    await p.locator("dialog[open] [data-action=clear]").click();
    await p.waitForFunction(
      () => document.querySelector("[data-cell=C1]").textContent === "",
    );
    assert.equal(await cell("C2").innerText(), "");
    await p.screenshot({ path: "/tmp/tabel3442-grid.png" });
    // Sheet switch and workspace navigation preserve unsaved editor values.
    await cell("E1").click();
    await editor.fill("11");
    await p.locator("[data-action=sheet][data-id=linked]").click();
    await p.locator("[data-action=sheet]").last().click();
    await p.waitForFunction(
      () => document.querySelector("[data-cell=E1]")?.textContent === "11",
    );
    await cell("E2").click();
    await editor.fill("15");
    await p.locator("button[data-view=shift]").click();
    await p.locator("button[data-view=table]").click();
    await p.waitForFunction(
      () => document.querySelector("[data-cell=E2]")?.textContent === "15",
    );
    // Standard palettes expose exactly eight shades and apply to every selected cell.
    await drag("A1", "A2");
    await action("tool-fill").click();
    await p.locator("[data-family=red]").click();
    assert.equal(await p.locator(".tn-color-shades [data-color]").count(), 8);
    const red = await p
      .locator(".tn-color-shades [data-color]")
      .nth(6)
      .getAttribute("data-color");
    await p.locator(".tn-color-shades [data-color]").nth(6).click();
    await p.locator("dialog[open]").waitFor({ state: "hidden" });
    await p.waitForFunction(
      (color) =>
        document.querySelector("[data-cell=A1]").style.background === color,
      await p.evaluate((color) => {
        const e = document.createElement("div");
        e.style.background = color;
        return e.style.background;
      }, red),
    );
    assert.equal(
      await cell("A1").evaluate((e) => getComputedStyle(e).boxShadow),
      "none",
    );
    assert.equal(
      await p
        .locator(".tn-selection-box")
        .evaluate((e) => getComputedStyle(e).borderTopWidth),
      "1px",
    );
    await action("tool-text").click();
    await p.locator("[data-family=blue]").click();
    await p.locator(".tn-color-shades [data-color]").nth(3).click();
    await action("tool-border").click();
    await p.locator("[data-action=border-outer]").click();
    await p.waitForFunction(
      () =>
        document.querySelector("[data-cell=A1]").style.borderTopWidth === "1px",
    );
    // Empty ranges do not advertise clearing, copying or autofilling empty content.
    await drag("C3", "C4");
    await cell("C3").click();
    assert.equal(
      await p.locator("dialog[open] [data-action=copy]").isVisible(),
      false,
    );
    assert.equal(
      await p.locator("dialog[open] [data-action=fill]").isVisible(),
      false,
    );
    assert.equal(
      await p.locator("dialog[open] [data-action=clear]").isVisible(),
      false,
    );
    await p.locator("dialog[open] footer [data-action=close]").click();
    await p.screenshot({ path: "/tmp/tabel3442-palette-grid.png" });
    // The required first sheet supports the same default selection and arithmetic.
    await p.evaluate(async () => {
      const D = await import("/test-app/tabel-v2/table-domain.mjs"),
        key = "site-a/config",
        base = qaStore.get(key),
        c =
          base.data ||
          D.config({ id: "site-a", name: "Объект А", startDate: "2026-10-27" });
      c.start = "2026-10-27";
      c.tableMode = "full";
      c.equipment = [
        { id: "mill", name: "Фреза", kind: "mill", ownership: "own" },
      ];
      c.request.equipment = ["mill"];
      await qaStore.save(key, c, base, "Config");
      for (const date of ["2026-10-27", "2026-10-28"]) {
        const k = "site-a/" + D.dayKey(date, "day");
        await qaStore.save(
          k,
          D.createDay(c, date, "day"),
          qaStore.get(k),
          "Shift",
        );
      }
    });
    await p.locator("button[data-view=shift]").click();
    await p.locator("button[data-view=table]").click();
    await p.locator("[data-action=sheet][data-id=linked]").click();
    await cell("B4").click();
    await editor.fill("12");
    await cell("C4").click();
    await editor.fill("14");
    await cell("B5").click();
    await editor.fill("=");
    await cell("B4").click();
    await editor.type("+");
    await cell("C4").click();
    assert.equal(await editor.inputValue(), "=B4+C4");
    await editor.press("Enter");

    await p.waitForFunction(
      () => document.querySelector("[data-cell=B5]").textContent === "26",
    );
    assert.equal(
      await p.evaluate(
        () =>
          qaStore.get("site-a/day:2026-10-27:day").data.equipment[0].crewHours,
      ),
      26,
    );
    await cell("B4").click();
    await editor.fill("10");
    await cell("C5").click();
    await p.waitForFunction(
      () => document.querySelector("[data-cell=B5]").textContent === "24",
    );
    await drag("B4", "C4");
    assert.match(
      await p.locator("[data-selection-total]").innerText(),
      /Сумма: 24/,
    );
    await cell("B4").click();
    assert.match(await p.locator("dialog[open]").innerText(), /Копировать/);
    await p.locator("dialog[open] footer [data-action=close]").click();
    assert.deepEqual(errors, []);
    console.log(
      "PASS grid 3.4.42: drag selection, live sum, tap-menu copy/paste/clear, direct reference and SUM range picking, dependency recalculation, arithmetic, automatic commit on cell/blur/sheet/view change",
    );
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
