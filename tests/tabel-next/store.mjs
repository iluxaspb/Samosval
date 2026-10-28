import assert from "node:assert/strict";
const { indexedDB } = await import(
  process.env.TABEL_FAKE_IDB_MODULE || "fake-indexeddb"
);
import { Store } from "../../test-app/tabel-next/store.mjs";
globalThis.indexedDB = indexedDB;
globalThis.BroadcastChannel = undefined;
const server = new Map(),
  receipts = new Map();
let network = true,
  allowed = true;
const remote = {
  read: async (key) =>
    structuredClone(server.get(key) || { revision: 0, data: null }),
  commit: async (j) => {
    if (!network) throw Error("offline");
    if (!allowed) throw Error("permission-denied");
    if (receipts.has(j.id)) return receipts.get(j.id);
    const r = server.get(j.key) || { revision: 0, data: null };
    if (r.revision !== j.before.revision)
      return { conflict: true, current: structuredClone(r) };
    const after = { revision: r.revision + 1, data: j.data };
    server.set(j.key, after);
    receipts.set(j.id, after);
    return structuredClone(after);
  },
};
const actor = () => ({ uid: "qa", name: "QA" });
const a = await new Store("a", remote, actor).open(),
  b = await new Store("b", remote, actor).open();
try {
  await a.save("site/day", { hours: 12 }, a.get("site/day"), "first");
  assert.equal(a.get("site/day").data.hours, 12);
  await a.flush();
  await a.accept([["site/day", { revision: 0, data: null }]]);
  assert.equal(a.get("site/day").data.hours, 12);
  await b.pull("site/day");
  assert.equal(b.get("site/day").data.hours, 12);
  network = false;
  await b.save("site/day", { hours: 26 }, b.get("site/day"), "offline");
  await b.flush();
  assert.equal(b.state.jobs.length, 1);
  network = true;
  await a.save("site/day", { hours: 52 }, a.get("site/day"), "other");
  await a.flush();
  await b.flush();
  assert.equal(b.state.jobs[0].status, "conflict");
  assert.equal(b.state.jobs[0].data.hours, 26);
  assert.equal(b.state.jobs[0].remote.data.hours, 52);
  await b.resolve(b.state.jobs[0].id, "mine");
  assert.equal(server.get("site/day").data.hours, 26);
  assert.equal(b.state.jobs.length, 0);
  await b.save("site/day", { hours: 40 }, b.get("site/day"), "queued");
  allowed = false;
  await b.flush();
  assert.equal(b.state.jobs.length, 1);
  assert.equal(server.get("site/day").data.hours, 26);
  await b.close();
  const restored = await new Store("b", remote, actor).open();
  assert.equal(restored.get("site/day").data.hours, 40);
  assert.equal(restored.state.jobs.length, 1);
  await restored.close();
  console.log(
    "PASS store: optimistic durable writes, two-client conflict, both versions, explicit resolution, revoked permission, restart",
  );
} finally {
  await a.close();
  if (!b.closed) await b.close();
}
