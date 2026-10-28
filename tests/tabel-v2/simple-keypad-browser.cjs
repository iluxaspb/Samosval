const { spawn } = require("child_process"),
  assert = require("node:assert/strict");
const { chromium } = require(
  process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + "/playwright",
);
const server = spawn(
  "python3",
  ["-m", "http.server", "8816", "--bind", "127.0.0.1"],
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
    p.setDefaultTimeout(7000);
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto("http://127.0.0.1:8816/tests/tabel-v2/harness.html");
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
    await p.locator("button[data-view=table]").click();
    await p.locator(".tn-grid").waitFor();
    assert(!(await p.locator(".tn-cell-tools").isVisible()));
    await p.locator("[data-cell=S4]").tap();
    await p.locator("dialog.tn-hours-dialog[open]").waitFor();
    await p.locator('[data-value="12"]').click();
    await p.locator("dialog[open]").waitFor({ state: "hidden" });

    await p.locator("[data-cell=S4]").tap();
    await p.locator("dialog.tn-hours-dialog[open]").waitFor();
    await p.locator("dialog[open] [data-action=close]").first().click();
    await p.evaluate(async () => {
      const key = "site-a/config",
        base = qaStore.get(key),
        c = base.data;
      c.tableMode = "full";
      await qaStore.save(key, c, base, "Full mode");
    });
    await p.locator("button[data-view=catalog]").click();
    await p.locator("button[data-view=table]").click();
    await p.locator(".tn-grid").waitFor();
    assert(await p.locator(".tn-cell-tools").isVisible());
    await p.locator("[data-range]").fill("A4");
    await p.locator("[data-range]").dispatchEvent("change");
    const label = await p.locator("[data-cell=A4]").textContent();
    await p.locator("[data-action=menu]").click();
    await p
      .getByRole("button", { name: "Удалить строку целиком", exact: true })
      .click();
    await p.locator("dialog[open] [type=submit]").click();
    await p.locator("dialog[open]").waitFor({ state: "hidden" });
    assert.notEqual(await p.locator("[data-cell=A4]").textContent(), label);
    await p.locator("[data-action=undo]").click();
    await p.waitForFunction(
      (label) =>
        document.querySelector("[data-cell=A4]")?.textContent === label,
      label,
    );
    await p.locator("button[data-view=catalog]").click();
    assert.equal(
      await p
        .getByRole("button", { name: "Убрать старую щётку", exact: true })
        .count(),
      0,
    );
    await p.evaluate(async () => {
      const base = qaStore.get("_catalog/config"),
        c = base.data || {};
      for (const key of ["works", "materials", "contractors"])
        c[key] = [{ id: key + "-qa", name: "Удаляемая запись", unit: "м³" }];
      await qaStore.save("_catalog/config", c, base, "QA deletion");
    });
    for (const [tab, id] of [
      ["equipment", "mill"],
      ["worker", "w1"],
      ["itr", "itr"],
      ["works", "works-qa"],
      ["materials", "materials-qa"],
      ["contractors", "contractors-qa"],
    ]) {
      await p.locator("[data-tab=" + tab + "]").click();
      await p
        .locator("[data-action=delete-catalog][data-id=" + id + "]")
        .click();
      await p.locator("dialog[open] [type=submit]").click();
      await p.locator("dialog[open]").waitFor({ state: "hidden" });
      assert.equal(
        await p
          .locator("[data-action=edit-catalog][data-id=" + id + "]")
          .count(),
        0,
      );
      assert(
        await p.evaluate(
          ({ tab, id }) =>
            qaStore
              .get("_catalog/config")
              .data[
                ["worker", "itr"].includes(tab) ? "people" : tab
              ].find((x) => x.id === id).deleted,
          { tab, id },
        ),
      );
    }
    await p.locator("button[data-view=table]").click();
    await p.locator("button[data-view=catalog]").click();
    await p.locator("[data-tab=equipment]").click();
    assert.equal(
      await p.locator("[data-action=edit-catalog][data-id=mill]").count(),
      0,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS touch: simple-mode tap/repeated tap opens numeric panel; lower tools hidden only in simple mode",
    );
  } finally {
    await b?.close();
    server.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
