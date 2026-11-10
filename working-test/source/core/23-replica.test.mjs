// Проверка очереди репликации: большая база не должна вешать телефон.
// Запуск: node working-test/source/core/23-replica.test.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = process.argv[2] || path.join(here, '23-replica.js');
const code = await readFile(sourcePath, 'utf8');

class MemoryStorage {
  constructor(limit = 5 * 1024 * 1024) { this.map = new Map(); this.limit = limit; this.writes = 0; this.bytes = 0; }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    const next = this.bytes - (this.map.get(k)?.length || 0) + String(v).length;
    if (next > this.limit) { const error = new Error('QuotaExceededError'); error.name = 'QuotaExceededError'; throw error; }
    this.writes += 1;
    this.bytes = next;
    this.map.set(k, String(v));
  }
  removeItem(k) { if (this.map.has(k)) { this.bytes -= this.map.get(k).length; this.map.delete(k); } }
}

function fakeCollection(name, state) {
  return {
    onSnapshot(options, next) {
      const entry = { name, next, docs: [] };
      state.watchers.push(entry);
      return () => { state.watchers = state.watchers.filter(w => w !== entry); };
    }
  };
}

function buildSandbox() {
  const storage = new MemoryStorage();
  const state = { watchers: [] };
  const listeners = {};
  const timers = new Set();
  const windowObj = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    WorkingTestReplica: undefined
  };
  const documentObj = {
    addEventListener: (type, fn) => { (listeners['doc:' + type] = listeners['doc:' + type] || []).push(fn); },
    visibilityState: 'visible',
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ style: {}, dataset: {}, append() {} })
  };
  const refs = {};
  for (const name of ['trucks', 'objects', 'logs', 'truckStatus', 'archive', 'trash', 'audit', 'notifications', 'plugins', 'patches']) {
    refs[name] = fakeCollection(name, state);
  }
  const wsRef = { collection: name => fakeCollection(name, state) };
  const db = { collection: name => fakeCollection(name, state) };
  const sandbox = {
    firebaseConfig: { projectId: 'samosval-test' },
    WORKSPACE_ID: 'main_workspace',
    currentUid: 'uid_test',
    refs,
    wsRef,
    db,
    auth: { currentUser: { getIdToken: async () => 'token' } },
    WORKING_TEST_UBUNTU_API_BASE: 'https://example.invalid/wt-api',
    isNasRuntime: () => false,
    localStorage: storage,
    window: windowObj,
    document: documentObj,
    navigator: { onLine: true },
    console: { warn() {}, log() {} },
    crypto: { randomUUID: () => 'id-' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2) },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ seq: 1, appliedAt: Date.now() }) }),
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.add(t); return t; },
    clearTimeout: t => timers.delete(t),
    setInterval: () => ({}),
    clearInterval: () => {},
    state
  };
  const params = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...params, code + '\n; return {startReplica, stopReplica, flush: replicaFlush, size: () => replicaQueue.size};');
  const api = factory(...params.map(p => sandbox[p]));
  return { api, storage, state, timers, windowObj };
}

function makeSnap(docs) {
  return {
    docChanges: () => docs.map(({ path: docPath, data, removed }) => ({
      type: removed ? 'removed' : 'added',
      doc: {
        ref: { path: docPath },
        data: () => data,
        updateTime: { toMillis: () => Date.now() }
      }
    }))
  };
}

const { api, storage, state, timers } = buildSandbox();
const started = performance.now();
api.startReplica();
const watchers = state.watchers.filter(w => w.name !== 'shift');
const DOCS = 3000;
for (const watcher of watchers) {
  const docs = Array.from({ length: DOCS }, (_, i) => ({
    path: `workspaces/main_workspace/${watcher.name}/doc${i}`,
    data: { id: 'doc' + i, n: i, text: 'x'.repeat(200), at: Date.now() }
  }));
  watcher.next(makeSnap(docs));
}
const enqueueMs = performance.now() - started;
// Сохраняем очередь так, как это делает обработчик pagehide/visibilitychange.
for (const t of timers) t.fn();
const queueKeys = Array.from(storage.map.keys()).filter(k => k.includes('replica'));
const persisted = queueKeys.reduce((sum, k) => sum + storage.map.get(k).length, 0);
const size = api.size();

console.log(JSON.stringify({
  source: path.basename(sourcePath),
  watchers: watchers.length,
  docsPerCollection: DOCS,
  enqueueMs: Math.round(enqueueMs),
  queueSize: size,
  storageWrites: storage.writes,
  storageBytes: storage.bytes,
  replicaPersistedBytes: persisted,
  storageKeys: queueKeys.map(k => k.split(':').slice(0, 2).join(':'))
}, null, 2));

const failures = [];
if (enqueueMs > 2000) failures.push('обработка ' + DOCS + '×' + watchers.length + ' документов заняла ' + Math.round(enqueueMs) + ' мс — интерфейс зависнет');
if (storage.writes > 40) failures.push('слишком много записей в localStorage: ' + storage.writes);
if (persisted > 200000) failures.push('очередь на диске занимает ' + persisted + ' байт');
if (size > 2000) failures.push('очередь в памяти больше предела: ' + size);
if (failures.length) {
  console.error('ПРОВАЛ: ' + failures.join('; '));
  process.exit(1);
}
console.log('OK: большая база обрабатывается быстро, очередь ограничена, диск не переполняется');