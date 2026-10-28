const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  { spawn } = require("node:child_process");
const firebase = require(
  process.env.TABEL_FIREBASE_MODULE || "firebase/compat/app",
);
require(process.env.TABEL_FIRESTORE_MODULE || "firebase/compat/firestore");
const { initializeTestEnvironment, assertFails } = require(
  process.env.TABEL_RULES_TEST_MODULE || "@firebase/rules-unit-testing",
);
const port = 8096,
  project = "demo-tabel-next";
let env,
  log = "";
const apps = [];
const child = spawn("java", [
  "-jar",
  process.env.FIRESTORE_EMULATOR_JAR,
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "--project_id",
  project,
]);
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
(async () => {
  try {
    for (
      let i = 0;
      i < 150 && !log.includes("Dev App Server is now running");
      i++
    )
      await new Promise((r) => setTimeout(r, 100));
    if (!log.includes("Dev App Server is now running")) throw Error(log);
    const fragment = fs.readFileSync(
      "test-app/tabel-next/proposals/firestore.fragment.rules",
      "utf8",
    );
    const isolatedRules = `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents {
 function account(){return get(/databases/$(database)/documents/users/$(request.auth.uid)).data;}
 function active(){return request.auth != null && account().status == 'active';}
 function admin(){return active() && account().role == 'admin';}
 function can(action){return active() && (admin() || action in get(/databases/$(database)/documents/settings/permissions).data.get(account().role,{}).get('actions',[]));}
 match /workspaces/main_workspace { ${fragment} }
}}`;
    const rules = process.env.TABEL_NEXT_INTEGRATED
      ? fs.readFileSync(
          "test-app/tabel-next/proposals/firestore.integrated.rules",
          "utf8",
        )
      : isolatedRules;
    env = await initializeTestEnvironment({
      projectId: project,
      firestore: { host: "127.0.0.1", port, rules },
    });
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      for (const [uid, role, status] of [
        ["admin", "admin", "active"],
        ["editor", "editor", "active"],
        ["viewer", "viewer", "active"],
        ["disabled", "admin", "disabled"],
      ])
        await db.doc("users/" + uid).set({ role, status });
      await db
        .doc("settings/permissions")
        .set({
          editor: { tabs: ["timesheet"], actions: ["timesheet_edit"] },
          viewer: { tabs: ["timesheet"], actions: [] },
        });
    });
    const { firestoreRemote } = await import(
        "../../test-app/tabel-next/store.mjs"
      ),
      D = await import("../../test-app/tabel-next/domain.mjs");
    function client(uid) {
      const app = firebase.initializeApp(
        { projectId: project, apiKey: "demo" },
        uid,
      );
      apps.push(app);
      const db = app.firestore();
      db.useEmulator("127.0.0.1", port, { mockUserToken: { sub: uid } });
      const host = {
        workspace: db.collection("workspaces").doc("main_workspace"),
        session: () => ({ uid, name: uid }),
        transaction: (fn) => db.runTransaction(fn),
      };
      return { remote: firestoreRemote(host, () => {}), db, host };
    }
    const admin = client("admin"),
      editor = client("editor"),
      viewer = client("viewer"),
      disabled = client("disabled");
    let n = 0;
    const operation = (key, data, before = { revision: 0, data: null }) => ({
      id: "op-" + ++n,
      key,
      data,
      before,
    });
    const c = D.config({ id: "site", name: "Site", startDate: "2026-10-10" });
    c.acl = {
      "role:editor": {
        "table.view": true,
        "table.edit": true,
        "shift.view": true,
        "shift.edit": true,
        "request.view": true,
        "request.edit": true,
      },
      "role:viewer": { "table.view": true },
    };
    console.log("STEP config");
    const config = await admin.remote.commit(operation("site/config", c));
    assert.equal(config.revision, 1);
    await editor.remote.read("site/config");
    console.log("STEP day");
    const day = D.createDay(c, "2026-10-10");
    const first = operation("site/day:2026-10-10:day", day);
    await editor.remote.commit(first);
    await editor.remote.commit(first);
    assert.equal((await editor.remote.read(first.key)).revision, 1);
    console.log("STEP race");
    const base = await editor.remote.read(first.key);
    const results = await Promise.all([
      editor.remote.commit(
        operation(first.key, { ...day, closed: true }, base),
      ),
      admin.remote.commit(
        operation(first.key, { ...day, planned: true }, base),
      ),
    ]);
    assert.equal(results.filter((x) => x.conflict).length, 1);
    console.log("STEP denies");
    await assertFails(
      viewer.remote.commit(
        operation("site/day:2026-10-11:day", D.createDay(c, "2026-10-11")),
      ),
    );
    await assertFails(disabled.remote.read(first.key));
    await assertFails(
      editor.remote.commit(operation("other/day:2026-10-10:day", day)),
    );
    await assertFails(
      editor.remote.commit(
        operation(
          "site/config",
          { ...c, acl: { "role:editor": { "settings.edit": true } } },
          config,
        ),
      ),
    );
    console.log("STEP request");
    await editor.remote.commit(
      operation(
        "site/config",
        { ...c, request: { ...c.request, note: "Request edit" } },
        config,
      ),
    );
    await assertFails(
      admin.host.workspace
        .collection("tabelNextRecords")
        .doc("site~day~2026-10-12~day")
        .set({ revision: 1, data: day }),
    );
    console.log(
      "PASS real Firebase SDK + emulator: draft rules compile, atomic receipt, idempotence, racing revisions, request-only permission, ACL escalation denied, viewer/disabled/cross-object writes denied",
    );
  } finally {
    await Promise.all(apps.map((a) => a.delete()));
    await env?.cleanup();
    child.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
