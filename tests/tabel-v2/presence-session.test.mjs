import test from "node:test";
import assert from "node:assert/strict";
import { presence } from "../../test-app/tabel-v2/presence.mjs";
import { nasPresence } from "../../test-app/tabel-v2/presence-nas.mjs";

// A picked cell must stay visible for other users until the user picks another cell
// or leaves the table. Focus loss (tab switch, another app, clicking elsewhere) is not leaving.

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeDocument(hidden = false) {
  const listeners = new Map();
  return {
    hidden,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    fire(name) { listeners.get(name)?.(); },
  };
}

function firebaseEnv() {
  const written = [], deleted = [], subscriptions = [];
  const collection = {
    doc: (id) => ({
      set: async (value) => { written.push(structuredClone(value)); },
      delete: async () => { deleted.push(id); },
    }),
    where() { return this; },
    onSnapshot(ok) {
      const entry = { ok, active: true };
      subscriptions.push(entry);
      return () => { entry.active = false; };
    },
  };
  const s = {
    host: { workspace: { collection: () => collection }, session: () => ({ uid: "u1", name: "Илья", provider: "firebase" }) },
    root: { hidden: false, isConnected: true },
    object: { id: "site" },
    remote: true,
    sheetVisible: () => true,
  };
  const peerSnapshot = (cell = "C3") => ({ docs: [{ id: "p", data: () => ({ uid: "u2", name: "Алексей", objectId: "site", sheetId: "one", selection: { a: cell, b: cell }, seen: Date.now() }) }] });
  return { s, written, deleted, subscriptions, peerSnapshot };
}

const activeSubscriptions = (env) => env.subscriptions.filter((entry) => entry.active).length;

test("Firebase presence survives a hidden tab and releases only on dispose", async () => {
  const document = fakeDocument(false);
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: document, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });
  globalThis.MutationObserver = class { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} };
  const events = new Map();
  const setIntervalOriginal = globalThis.setInterval;
  globalThis.addEventListener = (name, fn) => events.set(name, fn);
  globalThis.removeEventListener = (name, fn) => { if (events.get(name) === fn) events.delete(name); };
  globalThis.setInterval = () => 0; // the heartbeat is irrelevant to this test
  try {
    const env = firebaseEnv();
    let peers = [];
    const live = presence(env.s, (next) => { peers = next; });
    live.update("one", "B2", "B2", true);
    await tick();
    assert.equal(env.written.at(-1).selection.a, "B2");

    // Focus/visibility is lost: nothing is re-published and the record is kept.
    document.hidden = true;
    const count = env.written.length;
    document.fire("visibilitychange");
    await tick();
    assert.equal(env.written.length, count, "a hidden tab must not re-publish");
    assert.deepEqual(env.deleted, [], "a hidden tab must not delete the presence record");

    // Coming back re-checks the same cell instead of waiting for the next click.
    document.hidden = false;
    document.fire("visibilitychange");
    await tick();
    assert.equal(env.written.at(-1).selection.a, "B2");
    assert.deepEqual(env.deleted, []);

    // Other users see exactly one live subscription per sheet, and the cell is shown.
    assert.equal(activeSubscriptions(env), 1);
    env.subscriptions.at(-1).ok(env.peerSnapshot());
    assert.equal(peers.length, 1);
    assert.equal(peers[0].selection.a, "C3");

    // A second focus loss keeps our record and does not send it again.
    document.hidden = true;
    const count2 = env.written.length;
    document.fire("visibilitychange");
    await tick();
    assert.deepEqual(env.deleted, [], "a hidden tab keeps its own record");
    assert.equal(env.written.length, count2, "hiding the tab adds no write");

    // Returning subscribes again and shows peers at once.
    document.hidden = false;
    document.fire("visibilitychange");
    await tick();
    assert.equal(activeSubscriptions(env), 1);
    env.subscriptions.at(-1).ok(env.peerSnapshot("D7"));
    assert.equal(peers[0].selection.a, "D7");

    // Picking another cell publishes immediately.
    live.update("one", "E9", "E9", true);
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(env.written.at(-1).selection.a, "E9");

    // Leaving the table releases the record and the subscription.
    live.dispose();
    await tick();
    assert.equal(env.deleted.length, 1);
    assert.equal(activeSubscriptions(env), 0);
  } finally {
    delete globalThis.addEventListener;
    delete globalThis.removeEventListener;
    globalThis.setInterval = setIntervalOriginal;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete globalThis.document;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
});

test("Synology presence keeps the selection while the table is hidden, then leaves", async () => {
  const document = fakeDocument(false);
  const events = { addEventListener() {}, removeEventListener() {} };
  let onLeave = null;
  let visible = true, notified = 0;
  const screen = { fire() {} };
  const remote = {
    files: [],
    async write(value) { this.files.push(structuredClone(value)); },
    async remove() { this.removed = true; },
    async list() { return { peers: [] }; },
  };
  const s = {
    root: Object.defineProperty({ isConnected: true }, "hidden", {
      get: () => !visible,
      set: (value) => { visible = !value; if (value) screen.fire(); },
    }),
    object: { id: "site" }, sheetVisible: () => true,
    get host() {
      return s._host ||= {
        session: () => ({ uid: "u1", name: "Илья", provider: "synology", providerScope: "s1" }),
        presenceRemote: remote,
        registerPresenceLeave: (fn) => { onLeave = fn; return () => { onLeave = null; }; },
      };
    },
  };
  const live = nasPresence(s, () => {}, {
    doc: document, nav: { onLine: true }, events,
    setTimer: (fn) => setTimeout(fn, 0), clearTimer: clearTimeout,
    setEvery: () => 0, clearEvery: () => {},
    observe: (callback) => (screen.fire = () => { notified++; callback(); }, { observe() {}, disconnect() {} }),
  });
  live.update("one", "D5", "D5", true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(s.host.presenceRemote.files.at(-1).selection.a, "D5");

  s.root.hidden = true; // the table was dismissed without a focus event
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert(s.host.presenceRemote.removed, "leaving the table removes the presence record");
  assert.equal(typeof onLeave, "function", "logging out still releases the record");
  live.dispose();
  assert.equal(onLeave, null);
});
