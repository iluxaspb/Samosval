const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const root = path.resolve(__dirname, '../..');
const lineSource = fs.readFileSync(path.join(root, 'test-app/src/core/19-line-state.js'), 'utf8');
const queueSource = fs.readFileSync(path.join(root, 'test-app/src/core/20-offline-journal.js'), 'utf8');

function createLockManager() {
  const locks = new Map();
  function pump(name) {
    const state = locks.get(name);
    if (state.active || !state.waiting.length) return;
    const entry = state.waiting.shift(); state.active = entry;
    Promise.resolve(entry.callback({name, mode: 'exclusive'})).then(entry.resolve, entry.reject)
      .finally(() => {state.active = null; pump(name);});
  }
  return {request(name, options, callback) {
    return new Promise((resolve, reject) => {
      if (!locks.has(name)) locks.set(name, {active: null, waiting: []});
      const entry = {callback, resolve, reject}, state = locks.get(name);
      const abort = () => {const i = state.waiting.indexOf(entry); if (i >= 0) {state.waiting.splice(i, 1); reject(Object.assign(new Error('Aborted'), {name: 'AbortError'}));}};
      if(options.signal?.aborted){reject(Object.assign(new Error('Aborted'), {name:'AbortError'}));return;}
      options.signal?.addEventListener('abort', abort, {once: true});
      state.waiting.push(entry); pump(name);
    });
  }};
}

function server() {
  const rows = new Map(), versions = new Map();
  const put = (key, value) => {rows.set(key, plain(value)); versions.set(key, (versions.get(key) || 0) + 1);};
  put('policy', {cycleMinutes: 15});
  put('shift', {id: 's', isActive: true, objectId: 'object-original', objectName: 'Original object'});
  put('truckStatus/t', {id: 't', onLine: true, shiftId: 's', cycleRevision: 1, ttnRevision: 0,
    arriveStatus: '10:00', arriveTimestamp: 999000, lastLoadTimestamp: 0, ttnStatus: null});
  const snap = key => ({id: key.split('/').pop(), exists: rows.has(key), data: () => plain(rows.get(key))});
  const state = {rows, versions, put, snap, retries: 0, beforeCommit: null, afterCommit: null};
  state.transaction = async fn => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const reads = new Map(), writes = [];
      const result = await fn({
        get: async ref => {reads.set(ref.path, versions.get(ref.path) || 0); return snap(ref.path);},
        set: (ref, data) => writes.push([ref.path, plain(data)]),
        update: (ref, data) => writes.push([ref.path, {...rows.get(ref.path), ...plain(data)}]),
        delete: ref => writes.push([ref.path, undefined])
      });
      if (state.beforeCommit) await state.beforeCommit();
      if ([...reads].some(([key, rev]) => (versions.get(key) || 0) !== rev)) {state.retries++; continue;}
      for (const [key, value] of writes) {if(value===undefined){rows.delete(key);versions.set(key,(versions.get(key)||0)+1);}else put(key, value);}
      if (state.afterCommit) await state.afterCommit(writes);
      return result;
    }
    throw {code: 'aborted', message: 'Too many conflicts'};
  };
  return state;
}

function client(shared = server(), options = {}) {
  const storage = options.storage || new Map(), notices = [], errors = [], warnings = [];
  const clock = options.clock || {now: 1000000};
  const timers = new Map(); let timerId = 0;
  const control = {effectGet: null, effectSet: null, renders: 0, writes: 0};
  const events = new Map();
  const ref = key => ({path: key, id: key.split('/').pop(),
    get: async () => {if (control.effectGet) await control.effectGet(key); return shared.snap(key);},
    set: async value => {if (control.effectSet) await control.effectSet(key, value); shared.put(key, value); control.writes++;}
  });
  const refs = {shift: ref('shift')};
  for (const name of ['truckStatus', 'logs', 'audit', 'notifications']) refs[name] = {doc: id => ref(name + '/' + id)};
  const uid = options.uid || 'a';
  const c = {
    console: {log() {}, warn: (...args) => warnings.push(args), error: (...args) => errors.push(args)},
    Date: class extends Date {static now() {return clock.now;}}, Math,
    setTimeout: fn => {const id = ++timerId; timers.set(id, fn); return id;}, clearTimeout: id => timers.delete(id),
    localStorage: {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value)},
    navigator: {onLine: false, locks: options.locks === undefined ? createLockManager() : options.locks}, AbortController,
    firebaseConfig: {projectId: 'demo-offline-audit'}, WORKSPACE_ID: 'main_workspace',
    currentUid: uid, currentEmail: uid + '@example.com', currentUserStatus: 'active', currentUserRole: 'lopater', permissionsLoaded: true,
    MIN_CYCLE_MINUTES: 15, settings: {cycleMinutes: 15}, appConfig: {maxEnabled: false}, appConfigRef: ref('policy'),
    state: {shift: plain(shared.rows.get('shift')), truckStatus: {t: plain(shared.rows.get('truckStatus/t'))}, logs: [], notifications: []},
    syncState: {pendingWrites: {}, errors: {}}, confirmedLoadIds: new Set(), loadInFlight: {},
    refs, db: {runTransaction: fn => shared.transaction(fn)},
    window: {__gamePenaltyKey: (type, truck, status, log, id) => id, addEventListener: (name, fn) => events.set(name, fn)},
    getUserName: () => c.currentUid, findTruck: () => ({id: 't', brand: 'Truck', number: '123', defaultVol: 20}),
    truckName: () => 'Truck 123', truckLabelHtml: () => 'Truck 123', escapeHtml: String,
    hasPermission: () => true, requireEdit: () => true, canAdmin: () => true,
    updateSyncUI() {}, saveCache() {}, renderLine: () => control.renders++, renderHeaderStats() {}, renderStatusTicker() {},
    scheduleRenderForTab() {}, markSync() {}, showToastEl: (...args) => notices.push(args), showError: message => errors.push(message),
    pendingStart() {}, pendingEnd() {}, enqueueMax() {}, addAudit: async()=>{}, tfAwait: promise=>promise,
    getLogs: () => c.state.logs
  };
  vm.createContext(c);
  vm.runInContext(lineSource, c, {filename: '19-line-state.js'});
  vm.runInContext(queueSource, c, {filename: '20-offline-journal.js'});
  vm.runInContext('offlineRemoteStatuses={t:{...state.truckStatus.t}};', c);
  if(c.offlineEnsureJournalOwnership)c.offlineEnsureJournalOwnership();
  const run = code => vm.runInContext(code, c);
  const tick = async (rounds = 30) => {for (let n = 0; n < rounds; n++) await Promise.resolve();};
  const expire = () => {for (const fn of [...timers.values()]) fn();};
  return {c, shared, storage, clock, control, notices, errors, warnings, run, tick, expire, ref, events};
}
module.exports = {client, server, plain, createLockManager, AbortController};
