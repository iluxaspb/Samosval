const assert = require("node:assert/strict");
const { chromium } = require(
  process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
    ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + "/playwright"
    : "playwright",
);
const { spawn } = require("node:child_process");
const server = spawn(
  "python3",
  ["-m", "http.server", "8791", "--bind", "127.0.0.1"],
  { stdio: "ignore" },
);
let browser;
(async () => {
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TABEL_BROWSER_EXECUTABLE
        ? { executablePath: process.env.TABEL_BROWSER_EXECUTABLE }
        : {}),
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:8791/tests/tabel-next/harness.html");
    await page.waitForFunction(() => window.ready);
    const action = (a) => page.locator('[data-action="' + a + '"]');
    assert(
      !(await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .some((r) => r.name.includes("/grid.mjs")),
      )),
    );
    await action("add-equipment").click();
    await page.locator("dialog [name=name]").fill("Фреза W205");
    await page.locator("dialog [type=submit]").click();
    await page.locator("[name=equipment]").check();
    await page.locator(".tn-request [type=submit]").click();
    await action("add-day").click();
    await page.locator("dialog [name=date]").fill("2026-10-27");
    await page.locator("dialog [type=submit]").click();
    await page.locator("[data-view=shift]").click();
    await page.locator("input[name$=crewHours]").fill("52");
    await page.locator("input[name$=hours]").fill("12");
    await page.locator("[data-facts] [type=submit]").click();
    await page.locator("[data-view=table]").click();
    await page.locator(".tn-grid").waitFor();
    assert((await page.locator(".tn-grid").innerText()).includes("52"));
    await page.screenshot({ path: "tests/tabel-next/linked-mobile.png" });
    await page.setViewportSize({ width: 915, height: 412 });
    assert.equal((await page.locator(".tn-app").boundingBox()).height, 412);
    await page.setViewportSize({ width: 412, height: 915 });
    let rect = await page.locator(".tn-app").boundingBox();
    assert.equal(rect.width, 412);
    assert.equal(rect.height, 915);
    assert.equal(rect.x, 0);
    assert.equal(rect.y, 0);
    const dayCol = await page
      .locator(".tn-grid tbody tr")
      .nth(1)
      .locator("td")
      .evaluateAll((tds) => tds.findIndex((td) => td.textContent === "27"));
    const crewCell = await page
      .locator(".tn-grid tbody tr")
      .nth(4)
      .locator("td")
      .nth(dayCol)
      .getAttribute("data-cell");
    await page.locator("[data-range]").fill(crewCell);
    await page.locator("[data-range]").press("Tab");
    await page.locator("[data-editor]").focus();
    await page.locator("[data-editor]").fill("26");
    await action("apply").click();
    await action("menu").click();
    await page.locator("dialog [data-action=undo]").click();
    await page.waitForFunction(
      (k) =>
        document.querySelector('[data-cell="' + k + '"]').textContent === "52",
      crewCell,
    );
    await action("menu").click();
    await page.locator("dialog [data-action=redo]").click();
    await page.waitForFunction(
      (k) =>
        document.querySelector('[data-cell="' + k + '"]').textContent === "26",
      crewCell,
    );
    await page.locator("[data-view=shift]").click();
    assert.equal(
      await page.locator("input[name$=crewHours]").inputValue(),
      "26",
    );
    await page.locator("[data-view=table]").click();
    await action("day").click();
    await page.locator("dialog [name=date]").fill("2026-10-26");
    await page.locator("dialog [type=submit]").click();
    assert((await page.locator(".tn-grid").innerText()).includes("26"));
    await action("new-sheet").click();
    await page.locator("dialog [type=submit]").click();
    await page.locator("[data-cell=A1]").click();
    await page.locator("[data-editor]").fill("2");
    await action("apply").click();
    await page.locator("[data-cell=B1]").click();
    await page.locator("[data-editor]").fill("=A1*3");
    await action("apply").click();
    await page.waitForFunction(
      () => document.querySelector("[data-cell=B1]").textContent === "6",
    );
    await action("format").click();
    await page.locator("dialog [name=width]").fill("140");
    await page.locator("dialog [name=height]").fill("48");
    await page.locator("dialog [type=submit]").click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-cell=B1]").getBoundingClientRect()
          .width >= 140,
    );
    await page.locator("[data-editor]").focus();
    await page.locator('[data-symbol="+"]').click();
    assert(
      await page
        .locator("[data-editor]")
        .evaluate((el) => el === document.activeElement),
    );
    await page.screenshot({ path: "tests/tabel-next/mobile.png" });
    await page.reload();
    await page.waitForFunction(() => window.ready);
    await page.locator("[data-view=table]").click();
    await page.locator(".tn-sheets [data-action=sheet]").last().click();
    await page.waitForFunction(
      () => document.querySelector("[data-cell=B1]")?.textContent === "6",
    );
    await page.evaluate(() => (window.failNetwork = true));
    await page.locator("[data-cell=A1]").click();
    await page.locator("[data-editor]").fill("4");
    await action("apply").click();
    await page.waitForFunction(
      () => document.querySelector("[data-cell=B1]").textContent === "12",
    );
    await page.reload();
    await page.waitForFunction(() => window.ready);
    await page.locator("[data-view=table]").click();
    await page.locator(".tn-sheets [data-action=sheet]").last().click();
    await page.waitForFunction(
      () => document.querySelector("[data-cell=B1]")?.textContent === "12",
    );
    await page.locator("[data-view=request]").click();
    await action("defaults").click();
    await page.locator("dialog [type=submit]").click();
    await page.locator("dialog").waitFor({ state: "hidden" });
    await action("object").click();
    await page.locator("dialog [name=name]").fill("Новый объект из заявки");
    await page.locator("dialog [type=submit]").click();
    await page.locator("dialog").waitFor({ state: "hidden" });
    assert.equal(await page.locator("[name=equipment]").count(), 1);
    assert(await page.locator("[name=equipment]").isChecked());
    await page.locator("[data-view=table]").click();
    assert(
      (await page.locator(".tn-grid").innerText()).includes(
        "Новый объект из заявки",
      ),
    );
    assert(!(await page.locator(".tn-grid").innerText()).includes("52"));
    await page.goto(
      "http://127.0.0.1:8791/tests/tabel-next/harness.html?local=1",
    );
    await page.waitForFunction(() => window.ready);
    assert.equal(await page.evaluate(() => window.remoteCalls), 0);
    assert(
      (await page.locator("[data-status]").innerText()).includes(
        "Локальный режим",
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS browser: lazy grid, request, shift, 52 aggregate hours, two-way cell, dates, formula, resize, focus, persistence and offline edits",
    );
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
