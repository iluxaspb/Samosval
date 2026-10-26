const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// Exercise the real TEST queue, shift and archive code with retained user data.
// No Firebase connection or IndexedDB deletion is used in this fixture.
const scripts = ['06-sync', '14-archive', '18-shifts', '20-offline-journal']
  .map(name => fs.readFileSync('test-app/src/core/' + name + '.js', 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

function fixture({pending = [], logs = []} = {}) {
  const journalKey = 'samosval_offline_v1_test_workspace_user';
  const storage = new Map([
    [journalKey, JSON.stringify(pending)],
    ['dt_settings', JSON.stringify({cycleMinutes: 60})],
    ['dt_max_queue', JSON.stringify([{id: 'notification-1', type: 'text', text: 'Arrival'}])],
    ['timesheet-sentinel', JSON.stringify({hours: 8, material: 12})]
  ]);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {value: '', innerHTML: '', textContent: '', style: {}, classList: {add() {}, remove() {}}});
    return elements.get(id);
  };
  const archives = [], errors = [], notices = [], events = [];
  const rowMaps = {logs: new Map(logs.map((row, i) => ['log-' + i, clone(row)])), truckStatus: new Map([['truck', {onLine: true}]])};
  const refs = {
    archive: {doc: () => ({set: async value => {archives.push(clone(value)); events.push('archive');}})},
    shift: {delete: async () => {events.push('delete-shift');}}
  };
  for (const [name, rows] of Object.entries(rowMaps)) {
    refs[name] = {get: async () => ({size: rows.size, forEach: callback => {
      for (const id of rows.keys()) callback({ref: {name, id}});
    }})};
  }
  const context = {
    console, Date, Math, Set, Map,
    firebaseConfig: {projectId: 'test'}, WORKSPACE_ID: 'workspace', currentUid: 'user',
    currentEmail: 'operator@example.test', currentUserRole: 'admin', currentUserStatus: 'active',
    initialized: true, permissionsLoaded: true, pendingOps: 0,
    navigator: {onLine: true}, settings: {cycleMinutes: 60}, MIN_CYCLE_MINUTES: 15,
    syncState: {errors: {}, fromCache: {}, pendingWrites: {}, everConnected: Object.fromEntries(['profile', 'permissions', 'trucks', 'status', 'shift'].map(key => [key, true]))},
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value))},
    state: {shift: {id: 'shift', isActive: true, objectName: 'Object', objectId: 'object', startDate: '2026-10-26'}, logs: clone(logs), truckStatus: {truck: {onLine: true, ttnStatus: true}}, archive: [], trash: [], notifications: []},
    appConfig: {maxEnabled: false}, refs, confirmedLoadIds: new Set(),
    db: {batch() {const deletes = []; return {delete: ref => deletes.push(ref), commit: async () => {for (const ref of deletes) rowMaps[ref.name].delete(ref.id); events.push('cleanup');}};}},
    document: {getElementById: id => id === 'syncDot' ? null : element(id)},
    window: {}, viewingArchiveId: null, viewingArchiveGAITable: false,
    requireEdit: () => true, hasTabAccess: () => true, hasPermission: () => true,
    canAdmin: () => true, appConfirm: async () => true,
    getLogs: () => context.state.logs, getUserName: () => 'Operator',
    tfAwait: promise => promise, addAudit: async () => {}, clearAllNotifications: async () => {},
    sendShiftReportToMax: async () => {throw Error('MAX is disabled');},
    showToastEl: () => {}, appNotice: text => notices.push(text), showError: text => errors.push(text),
    escapeHtml: String, resolveUserDisplayName: (email, name) => name || email,
    findTruck: id => ({id, brand: 'Truck', number: '1', isGAI: false}),
    setTimeout() {},
  };
  Object.defineProperty(context.window, 'ObjectPhotos', {get() {throw Error('Removed photo service must not be read');}});
  Object.defineProperty(context.window, '__attachArchivePhotos', {get() {throw Error('Removed photo archive hook must not be called');}});
  Object.defineProperty(context, 'indexedDB', {get() {throw Error('Existing photos/timesheets must not be opened or deleted');}});
  vm.createContext(context);
  for (const script of scripts) vm.runInContext(script, context);
  return {context, storage, journalKey, archives, errors, notices, events, elements, element};
}

(async () => {
  const queued = Array.from({length: 24}, (_, i) => ({id: 'operation-' + i, shiftId: 'shift', truckId: 'truck', type: ['arrive', 'load', 'ttn', 'reset'][i % 4], status: 'pending', createdAt: i + 1}));
  let f = fixture({pending: queued});
  const before = [...f.storage.entries()];
  assert.equal(f.context.offlinePendingCount(), 24);
  assert.equal(f.context.getSyncStatus().text, 'Синхронизация... (24)');
  f.context.pendingOps = 3;
  assert.equal(f.context.getSyncStatus().text, 'Синхронизация... (27)');
  await f.context.closeShift();
  assert.deepEqual(f.errors, ['Сначала синхронизируйте действия перед закрытием смены']);
  assert.deepEqual(f.events, []);
  assert.deepEqual([...f.storage.entries()], before, 'Removing photos must not erase a pending trip, arrival, TTN, timer reset, notification or timesheet');
  assert.deepEqual(JSON.parse(f.storage.get(f.journalKey)), queued);

  f = fixture();
  await f.context.closeShift();
  assert.deepEqual(f.errors, []);
  assert.equal(f.archives.length, 0);
  assert(f.events.includes('delete-shift'), 'An empty shift can close without waiting for any photo service');

  const logs = [
    {truckId: 'truck', truckName: 'Truck 1', volume: 12, timestamp: 1000, timeStr: '10:00', createdBy: 'Operator', createdByEmail: 'operator@example.test', isGAI: false},
    {truckId: 'truck', truckName: 'Truck 1', volume: 18, timestamp: 2000, timeStr: '11:00', createdBy: 'Operator', createdByEmail: 'operator@example.test', isGAI: false}
  ];
  f = fixture({logs});
  await f.context.closeShift();
  assert.deepEqual(f.errors, []);
  assert.equal(f.archives.length, 1);
  assert.equal(f.archives[0].sourceShiftId, 'shift');
  assert.equal(f.archives[0].objectId, 'object');
  assert.equal(f.archives[0].totalTrips, 2);
  assert.equal(f.archives[0].totalVolume, 30);
  assert.deepEqual(f.archives[0].ttnStatus, {truck: true});
  assert.deepEqual(f.archives[0].logs.map(row => row.volume), [12, 18]);
  assert(f.events.indexOf('archive') < f.events.indexOf('cleanup'), 'Trip archive must be saved before cleanup');

  f.context.state.archive = [{id: 'archive', date: '2026-10-26', objectName: 'Object', objectId: 'object', logs, totalVolume: 30, activeLineIds: ['truck'], ttnStatus: {truck: true}}];
  f.context.renderArchive();
  assert(f.element('archiveContainer').innerHTML.includes('30'));
  assert(!f.element('archiveContainer').innerHTML.includes('data-photo-object'));
  f.context.openArchiveModal('archive');
  assert(f.element('modalArchiveBody').innerHTML.includes('paper-table'), 'Archive report remains available with no photo hook');
  assert(f.element('modalArchiveBody').innerHTML.includes('30'));

  console.log('PASS photo removal: 24 mixed business operations preserved; sync counts stay honest; empty/nonempty shifts close without photo service; trips, TTN and archive report retained');
})().catch(error => {console.error(error); process.exitCode = 1;});
