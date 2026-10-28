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
    await p.evaluate(async()=>{const cb=qaStore.get('_catalog/config'),catalog=cb.data||{equipment:[],people:[]};catalog.equipment.push({id:'real-brush',name:'МТЗ щётка',kind:'brush',ownership:'own'});await qaStore.save('_catalog/config',catalog,cb,'Registered brush');const key='site-a/day:2026-10-27:night',base=qaStore.get(key),d=base.data;d.equipment.push({id:'legacy-brush',name:'Щётка старая',ownership:'hired',hours:5});await qaStore.save(key,d,base,'Legacy brush');});
    await p.locator('button[data-view=catalog]').click();await p.getByRole('button',{name:'Убрать старую щётку',exact:true}).click();await p.locator('dialog[open] [name=legacy][value=legacy-brush]').check();await p.locator('dialog[open] [type=submit]').click();await p.locator('dialog[open]').waitFor({state:'hidden'});assert(await p.evaluate(()=>qaStore.get('site-a/config').data.hiddenEquipmentIds.includes('legacy-brush')));assert.equal(await p.evaluate(()=>qaStore.get('site-a/day:2026-10-27:night').data.equipment.find(e=>e.id==='legacy-brush').hours),5);
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
