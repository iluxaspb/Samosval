import test from "node:test";
import assert from "node:assert/strict";
import { readFlight } from "../../test-app/tabel-v2/read-flight.mjs";
import { firestoreRemote } from "../../test-app/tabel-v2/store.mjs";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
test("ten overlapping identical reads share one load; settled values are never cached", async () => {
  const group = readFlight(() => ({ uid: "a" })),
    gate = deferred();
  let calls = 0;
  const load = () => {
    calls++;
    return gate.promise;
  };
  const jobs = Array.from({ length: 10 }, () => group.run("same", load));
  await turn();
  assert.equal(calls, 1);
  gate.resolve(12);
  assert.deepEqual(await Promise.all(jobs), Array(10).fill(12));
  assert.equal(await group.run("same", () => ++calls), 2);
});
test("failures retry; different keys, identity, roles and rights never share", async () => {
  let scope = { uid: "a", role: "admin", edit: true };
  const group = readFlight(() => scope),
    a = deferred();
  let calls = 0;
  const load = () => {
    calls++;
    return a.promise;
  };
  const tasks = [group.run("one", load), group.run("two", load)];
  scope = { ...scope, uid: "b" };
  tasks.push(group.run("one", load));
  scope = { ...scope, role: "viewer", edit: false };
  tasks.push(group.run("one", load));
  const outcomes = Promise.allSettled(tasks);
  await turn();
  assert.equal(calls, 4);
  a.reject(Error("offline"));
  assert((await outcomes).every((x) => x.status === "rejected"));
  assert.equal(await group.run("one", () => 99), 99);
});
test("invalidation starts fresh requests, and an old completion cannot discard a newer request", async () => {
  const group = readFlight(() => 1),
    old = deferred(),
    fresh = deferred();
  const first = group.run("one", () => old.promise);
  await turn();
  group.invalidate();
  const second = group.run("one", () => fresh.promise);
  await turn();
  old.resolve("old");
  await first;
  const third = group.run("one", () => {
    throw Error("must join newer request");
  });
  fresh.resolve("new");
  assert.deepEqual(await Promise.all([second, third]), ["new", "new"]);
});
function harness() {
  let actor = {
      uid: "a",
      name: "A",
      role: "admin",
      active: true,
      view: true,
      edit: true,
    },
    transactionGate = null;
  const calls = [],
    watchers = [],
    records = new Map();
  const query = (collection, parts = []) => ({
    doc: (id) => ({
      collection,
      id,
      get: () => request(collection, [["doc", id]]),
      onSnapshot: (cb) => {
        watchers.push({ collection, parts: [["doc", id]], cb });
        return () => {};
      },
    }),
    where: (...args) => query(collection, [...parts, ["where", ...args]]),
    orderBy: (...args) => query(collection, [...parts, ["orderBy", ...args]]),
    startAt: (...args) => query(collection, [...parts, ["startAt", ...args]]),
    endAt: (...args) => query(collection, [...parts, ["endAt", ...args]]),
    startAfter: (d) => query(collection, [...parts, ["startAfter", d.id]]),
    limit: (n) => query(collection, [...parts, ["limit", n]]),
    get: (options) => request(collection, parts, options),
    onSnapshot: (cb) => {
      watchers.push({ collection, parts, cb });
      return () => {};
    },
  });
  function request(collection, parts, options) {
    const gate = deferred();
    calls.push({ collection, parts, options, ...gate });
    return gate.promise;
  }
  const snapshot = (data) => ({
    exists: !!data,
    data: () => structuredClone(data),
  });
  const host = {
    workspace: { collection: (name) => query(name) },
    session: () => actor,
    documentId: () => "__name__",
    transaction: async (fn) => {
      if (transactionGate) await transactionGate.promise;
      return fn({
        get: async (r) => snapshot(records.get(r.collection + "/" + r.id)),
        set: (r, data) =>
          records.set(r.collection + "/" + r.id, structuredClone(data)),
      });
    },
  };
  return {
    remote: firestoreRemote(host, () => {}),
    calls,
    watchers,
    records,
    snapshot,
    setActor: (x) => {
      actor = { ...actor, ...x };
    },
    blockCommit: () => (transactionGate = deferred()),
  };
}
test("remote document reads share the SDK snapshot but return independent data and fresh subsequent results", async () => {
  const h = harness(),
    a = h.remote.read("site/config"),
    b = h.remote.read("site/config");
  await turn();
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(h.snapshot({ revision: 1, data: { name: "A" } }));
  const [x, y] = await Promise.all([a, b]);
  x.data.name = "local";
  assert.equal(y.data.name, "A");
  const c = h.remote.read("site/config");
  await turn();
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve(h.snapshot({ revision: 2, data: { name: "server" } }));
  assert.equal((await c).revision, 2);
});
test("overlapping object reads keep every page, future/night records, sheets and tombstones", async () => {
  const h = harness(),
    a = h.remote.list("site"),
    b = h.remote.list("site");
  await turn();
  assert.equal(h.calls.length, 1);
  const docs = Array.from({ length: 200 }, (_, i) => ({
    id: "site~" + i,
    data: () => ({ key: "site/day:" + i, data: { deleted: i === 2 } }),
  }));
  h.calls[0].resolve({ docs });
  await turn();
  assert.equal(h.calls.length, 2);
  const last = { key: "site/sheet:future", data: { name: "Full sheet" } };
  h.calls[1].resolve({
    docs: [{ id: "last", data: () => structuredClone(last) }],
  });
  const [x, y] = await Promise.all([a, b]);
  assert.equal(x.length, 201);
  assert.deepEqual(x, y);
  assert.equal(x[2][1].data.deleted, true);
  assert.equal(x.at(-1)[0], "site/sheet:future");
});
test("history shares only simultaneous downloads and preserves every operation", async () => {
  const h = harness(),
    a = h.remote.history("site"),
    b = h.remote.history("site");
  await turn();
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve({
    docs: [
      {
        id: "op",
        data: () => ({
          key: "site/config",
          before: {},
          after: { data: { name: "A" }, authorName: "A" },
          time: 1,
          author: "a",
        }),
      },
    ],
  });
  const [x, y] = await Promise.all([a, b]);
  assert.deepEqual(x, y);
  assert.equal(x[0].id, "op");
  assert.equal(x[0].data.name, "A");
  const c = h.remote.history("site");
  await turn();
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ docs: [] });
  await c;
});
test("local commit start and completion invalidate overlapping reads without deduplicating transactions", async () => {
  const h = harness(),
    first = h.remote.read("site/config");
  await turn();
  const gate = h.blockCommit();
  const job = {
    id: "op",
    key: "site/config",
    before: { revision: 0, data: null },
    data: { name: "Saved" },
  };
  const saving = h.remote.commit(job);
  const during = h.remote.read("site/config");
  await turn();
  assert.equal(h.calls.length, 2);
  gate.resolve();
  await saving;
  const after = h.remote.read("site/config");
  await turn();
  assert.equal(h.calls.length, 3);
  h.calls[0].resolve(h.snapshot(null));
  h.calls[1].resolve(h.snapshot(null));
  h.calls[2].resolve(h.snapshot(h.records.get("tabelNextRecords/site~config")));
  await Promise.all([first, during]);
  assert.equal((await after).data.name, "Saved");
  assert(h.records.has("tabelNextOperations/op"));
});
test("server snapshots invalidate pending reads, while independent realtime listeners remain independent", async () => {
  const h = harness(),
    a = h.remote.read("site/config");
  await turn();
  let received = 0;
  h.remote.watch(
    "site",
    null,
    null,
    () => received++,
    () => {},
  );
  h.remote.watch(
    "site",
    null,
    null,
    () => received++,
    () => {},
  );
  assert.equal(h.watchers.length, 6);
  h.watchers[0].cb({ metadata: { fromCache: false }, docs: [] });
  const b = h.remote.read("site/config");
  await turn();
  assert.equal(h.calls.length, 2);
  assert.equal(received, 1);
  h.calls[0].resolve(h.snapshot(null));
  h.calls[1].resolve(h.snapshot(null));
  await Promise.all([a, b]);
});
