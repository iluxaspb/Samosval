const assert = require("node:assert/strict"),
  { spawn } = require("node:child_process");
const { chromium } = require(
  process.env.PLAYWRIGHT_PACKAGE ||
    process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + "/playwright",
);
const server = spawn(
  "python3",
  ["-m", "http.server", "8792", "--bind", "127.0.0.1"],
  { stdio: "ignore" },
);
let browser;
(async () => {
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || "/tmp/tabel-chromium",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const ctx = await browser.newContext({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.clock.setFixedTime(new Date("2026-10-28T09:00:00+03:00"));
    await p.goto("http://127.0.0.1:8792/tests/tabel-v2/harness.html");
    await p.waitForFunction(() => ready);
    await p.evaluate(() => seedLegacy());
    await p.locator("#open").click();
    await p.locator("[data-view=request]").waitFor();
    assert.equal(await p.evaluate(() => session.objectId), null);
    assert.equal(
      await p.locator("[data-view=request]").getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await p.locator("[name=equipment]:checked").count(), 1);
    const action = (a) => p.locator('[data-action="' + a + '"]');
    const save = async () => {
      await p.locator("dialog[open] [type=submit]").click();
      await p.locator("dialog[open]").waitFor({ state: "hidden" });
    };
    await action("settings-menu").click();
    await p.locator(".tn-settings-menu").waitFor();
    assert.equal(await p.locator(".tn-settings-menu button").count(), 6);
    await p.locator("dialog[open] [data-action=workers]").click();
    await p.locator("dialog[open] [data-search]").fill("Иван");
    await p.locator("dialog[open]").getByLabel("Иван Петров").check();
    await p.locator("dialog[open] [data-search]").fill("Олег");
    await p.locator("dialog[open]").getByLabel("Олег Соколов").check();
    await save();
    await action("settings-menu").click();
    await p.locator('[data-table-mode]').selectOption('full');
    await p.locator('[data-action=save-mode]').click();
    await p.locator('dialog[open]').waitFor({state:'hidden'});
    await p.locator("[data-view=table]").click();
    await p.locator(".tn-grid").waitFor();
    assert((await p.locator(".tn-grid").innerText()).includes("52"));
    const headers = await p
      .locator("tbody tr")
      .nth(1)
      .locator("td")
      .allTextContents();
    assert(headers.includes("27.10\nНочь"));
    const col = headers.findIndex((t) => t.includes("27.10")),
      cell = await p
        .locator("tbody tr")
        .nth(4)
        .locator("td")
        .nth(col)
        .getAttribute("data-cell");
    await p.locator("[data-range]").fill(cell);
    await p.locator("[data-range]").press("Tab");
    await p.locator("[data-editor]").fill("26");
    await action("apply").click();
    await p.waitForFunction(
      (k) =>
        document.querySelector('[data-cell="' + k + '"]').textContent === "26",
      cell,
    );
    const rect = await p.locator(".tn-app").boundingBox();
    assert.equal(rect.width, 393);
    assert.equal(rect.height, 852);
    const dateWidth = await p
      .locator("tbody tr")
      .nth(1)
      .locator("td")
      .nth(1)
      .evaluate((e) => e.getBoundingClientRect().width);
    assert(dateWidth <= 70, "date column too wide: " + dateWidth);
    await p.screenshot({ path: "tests/tabel-v2/full-table-mobile.png" });
    await p.locator("[data-view=catalog]").click();
    await action("materials").click();
    await p.locator("dialog[open] [name=name]").fill("Песок");
    await p.locator("dialog[open] [name=unit]").fill("м³");
    await save();
    await action("works").click();
    await p.locator("dialog[open] [name=name]").fill("Устройство основания");
    await p.locator("dialog[open] [name=plan]").fill("1500");
    await save();
    await action("settings-menu").click();
    await p.locator(".tn-settings-menu").waitFor();
    await p.locator("dialog[open] [data-action=materials]").click();
    assert((await p.locator("dialog[open]").innerText()).includes("Песок"));
    await p.locator("dialog[open] [data-action=close]").first().click();
    await p.locator("[data-view=request]").click();
    await action("defaults").click();
    await save();
    await action("object").click();
    await p.locator("dialog[open] [name=name]").fill("Новый объект");
    await save();
    assert(await p.locator("[name=equipment]").first().isChecked());
    await p.locator("[data-view=catalog]").click();
    await p.getByText("Песок", { exact: false }).first().waitFor();
    await p.locator("[data-view=table]").click();
    await action("new-sheet").click();
    await save();
    await p.locator("[data-cell=A1]").click();
    await p.locator("[data-editor]").fill("2");
    await action("apply").click();
    await p.locator("[data-cell=B1]").click();
    await p.locator("[data-editor]").fill("=A1*3");
    await action("apply").click();
    await p.waitForFunction(
      () => document.querySelector("[data-cell=B1]").textContent === "6",
    );
    await action("exit").click();
    await p.locator("#open").click();
    await p.locator("[data-view=table]").click();
    assert((await p.locator(".tn-grid").innerText()).includes("26"));
    assert(
      await p.evaluate(
        () =>
          localStorage.getItem(
            JSON.stringify([
              "tabel-v2-draft",
              1,
              session.projectId,
              session.workspaceId,
              session.uid,
              "site-a",
            ]),
          ) !== null,
      ),
    );
    await p.evaluate(() => (session.active = false));
    await p.waitForFunction(() => !document.querySelector(".tn-app"));
    assert.deepEqual(errors, []);
    console.log(
      "PASS full UI: no shift entry, migration, six menus, search selection, linked table, compact dates, shared catalogs, new object/defaults, formulas, reopen and revoked session",
    );
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
