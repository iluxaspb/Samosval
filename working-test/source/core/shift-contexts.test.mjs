import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Проверяем тот самый файл, который уходит в сборку, а не его копию.
const file = fileURLToPath(new URL('./40-shift-contexts.js', import.meta.url));
const sandbox = { structuredClone };
vm.runInContext(readFileSync(file, 'utf8'), vm.createContext(sandbox), { filename: file });
const { createShiftContextStore } = sandbox.WorkingTestShiftContexts || {};

const WORKSPACE = 'workspace_main';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    get length() { return map.size; },
    key: index => [...map.keys()][index] ?? null,
    _map: map
  };
}

function makeStore({ storage = memoryStorage(), uid = 'uid_alpha', workspaceId = WORKSPACE } = {}) {
  return createShiftContextStore({ storage, uid, workspaceId });
}

const shiftA = { shiftId: 'shift_a', state: 'active', objectId: 'object_1', objectName: 'Невский проспект', workDate: '2026-11-23', shiftType: 'day', shiftRevision: 3 };
const shiftB = { shiftId: 'shift_b', state: 'active', objectId: 'object_2', objectName: 'Пулково', workDate: '2026-11-23', shiftType: 'night', shiftRevision: 5 };
const shiftC = { shiftId: 'shift_c', state: 'closing', objectId: 'object_3', objectName: 'Шушары', workDate: '2026-11-24', shiftType: 'day', shiftRevision: 2 };
const archived = { shiftId: 'shift_old', state: 'closed', objectId: 'object_9', objectName: 'Архив', workDate: '2026-11-01', shiftType: 'day', shiftRevision: 9 };

function snapshotFor(shift, overrides = {}) {
  const shiftRevision = overrides.shiftRevision ?? shift.shiftRevision;
  return {
    protocolVersion: 2,
    workspaceId: WORKSPACE,
    shiftId: shift.shiftId,
    shiftRevision,
    shift: { ...shift, shiftRevision },
    members: [],
    statuses: [],
    logs: [],
    detachedOpenTrips: [],
    revisions: { shift: shiftRevision },
    serverGeneration: 'server-' + shiftRevision,
    pendingServerReceipts: 0,
    ...overrides
  };
}

function loadSnapshot(store, shift, overrides = {}) {
  const token = store.beginRequest({ shiftId: shift.shiftId, requestKind: 'snapshot' });
  const result = store.applySnapshot({ generation: token, snapshot: snapshotFor(shift, overrides) });
  assert.equal(result.applied, true, 'fixture snapshot must apply');
  return result;
}

test('visible list keeps only active and closing shifts and auto-selects the first', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA, shiftB, shiftC, archived]);
  assert.deepEqual(store.visibleShifts().map(s => s.shiftId), ['shift_a', 'shift_b', 'shift_c']);
  assert.equal(store.activeShiftId(), 'shift_a');
  assert.equal(store.context('shift_old'), null);
});

test('selection is restored only for a visible active or closing shift', () => {
  const storage = memoryStorage();
  const first = makeStore({ storage });
  first.replaceVisibleShifts([shiftA, shiftB]);
  assert.equal(first.selectShift('shift_b'), true);

  const restored = makeStore({ storage });
  restored.replaceVisibleShifts([shiftA, shiftB]);
  assert.equal(restored.activeShiftId(), 'shift_b');

  const shifted = makeStore({ storage });
  shifted.replaceVisibleShifts([shiftA]);
  assert.equal(shifted.activeShiftId(), 'shift_a', 'a hidden shift must not stay selected');

  const archiveOnly = makeStore({ storage });
  archiveOnly.replaceVisibleShifts([archived]);
  assert.equal(archiveOnly.activeShiftId(), null);
});

test('selection is bound to the uid and workspace key', () => {
  const storage = memoryStorage();
  const owner = makeStore({ storage, uid: 'uid_alpha' });
  owner.replaceVisibleShifts([shiftA, shiftB]);
  assert.equal(owner.selectShift('shift_b'), true);

  const otherUser = makeStore({ storage, uid: 'uid_beta' });
  otherUser.replaceVisibleShifts([shiftA, shiftB]);
  assert.equal(otherUser.activeShiftId(), 'shift_a', 'another uid must not inherit the selection');

  const otherWorkspace = makeStore({ storage, uid: 'uid_alpha', workspaceId: 'workspace_other' });
  otherWorkspace.replaceVisibleShifts([shiftA, shiftB]);
  assert.equal(otherWorkspace.activeShiftId(), 'shift_a', 'another workspace must not inherit the selection');
});

test('archived shift never changes the active shift id', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA, shiftB]);
  assert.equal(store.selectShift('shift_a'), true);

  store.replaceVisibleShifts([shiftA, shiftB, archived]);
  assert.equal(store.activeShiftId(), 'shift_a');

  assert.equal(store.selectShift('shift_old'), false, 'archived shift cannot be selected');
  assert.equal(store.activeShiftId(), 'shift_a');

  store.replaceVisibleShifts([archived]);
  assert.equal(store.activeShiftId(), null, 'archived shift must never become active');
  assert.deepEqual(store.visibleShifts(), []);
});

test('forms are isolated between shifts', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA, shiftB]);
  store.setForm('shift_a', 'ttn', '111');
  store.setForm('shift_a', 'comment', 'первая смена');
  store.setForm('shift_b', 'ttn', '222');

  assert.equal(store.context('shift_a').ui.forms.ttn, '111');
  assert.equal(store.context('shift_a').ui.forms.comment, 'первая смена');
  assert.equal(store.context('shift_b').ui.forms.ttn, '222');
  assert.equal(store.context('shift_b').ui.forms.comment, undefined);

  store.selectShift('shift_b');
  assert.deepEqual(store.visibleContext().ui.forms, { ttn: '222' });
});

test('scroll and focus are isolated between shifts', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA, shiftB]);
  store.setScroll('shift_a', { top: 480, left: 0 });
  store.setScroll('shift_b', { top: 12, left: 0 });
  store.setFocus('shift_a', 'truck-card-1');
  store.setFocus('shift_b', 'truck-card-2');

  store.selectShift('shift_a');
  assert.deepEqual(store.visibleContext().ui.scroll, { top: 480, left: 0 });
  assert.equal(store.visibleContext().ui.focus, 'truck-card-1');

  store.selectShift('shift_b');
  assert.deepEqual(store.visibleContext().ui.scroll, { top: 12, left: 0 });
  assert.equal(store.visibleContext().ui.focus, 'truck-card-2');
  assert.deepEqual(store.context('shift_a').ui.scroll, { top: 480, left: 0 });
});

test('inflight and pending are isolated between shifts', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA, shiftB]);
  const tokenA = store.beginRequest({ shiftId: 'shift_a', requestKind: 'line-action' });
  const tokenB = store.beginRequest({ shiftId: 'shift_b', requestKind: 'line-action' });
  store.setPending('shift_a', [{ operationId: 'op-a', shiftId: 'shift_a' }]);
  store.setPending('shift_b', [{ operationId: 'op-b', shiftId: 'shift_b' }, { operationId: 'op-b2', shiftId: 'shift_b' }]);

  assert.equal(store.context('shift_a').pending.length, 1);
  assert.equal(store.context('shift_a').badge.pending, 1);
  assert.equal(store.context('shift_b').pending.length, 2);
  assert.equal(store.context('shift_b').badge.pending, 2);
  assert.equal(store.context('shift_a').inflight['line-action'].generation, tokenA.generation);
  assert.equal(store.context('shift_b').inflight['line-action'].generation, tokenB.generation);

  store.selectShift('shift_a');
  assert.deepEqual(store.visibleContext().pending.map(x => x.operationId), ['op-a']);
  assert.deepEqual(Object.keys(store.visibleContext().inflight), ['line-action']);

  loadSnapshot(store, shiftB);
  assert.equal(store.context('shift_a').inflight['line-action'].generation, tokenA.generation, 'B response must not clear A inflight');
  assert.equal(store.context('shift_a').pending.length, 1, 'B response must not change A pending');
  assert.equal(store.context('shift_b').inflight['line-action'].generation, tokenB.generation);
});

test('generation key includes uid, workspace, shift and request kind', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA, shiftB]);
  const token = store.beginRequest({ shiftId: 'shift_a', requestKind: 'snapshot' });
  assert.equal(token.uid, 'uid_alpha');
  assert.equal(token.workspaceId, WORKSPACE);
  assert.equal(token.shiftId, 'shift_a');
  assert.equal(token.requestKind, 'snapshot');
  assert.equal(token.generation, 1);

  const logsToken = store.beginRequest({ shiftId: 'shift_a', requestKind: 'logs' });
  assert.equal(logsToken.generation, 1, 'each request kind has its own counter');
  const next = store.beginRequest({ shiftId: 'shift_a', requestKind: 'snapshot' });
  assert.equal(next.generation, 2);

  const otherShift = store.beginRequest({ shiftId: 'shift_b', requestKind: 'snapshot' });
  assert.equal(otherShift.generation, 1);
});

test('late_response_is_rejected_by_full_generation_key', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA]);
  const first = store.beginRequest({ shiftId: 'shift_a', requestKind: 'snapshot' });
  const second = store.beginRequest({ shiftId: 'shift_a', requestKind: 'snapshot' });

  const late = store.applySnapshot({ generation: first, snapshot: snapshotFor(shiftA, { shiftRevision: 4 }) });
  assert.equal(late.applied, false);
  assert.equal(late.reason, 'stale-generation');

  const foreignStore = makeStore({ uid: 'uid_beta' });
  foreignStore.replaceVisibleShifts([shiftA]);
  const foreignToken = foreignStore.beginRequest({ shiftId: 'shift_a', requestKind: 'snapshot' });
  const foreign = store.applySnapshot({ generation: foreignToken, snapshot: snapshotFor(shiftA) });
  assert.equal(foreign.applied, false);
  assert.equal(foreign.reason, 'foreign-generation-scope');

  const logsToken = store.beginRequest({ shiftId: 'shift_a', requestKind: 'logs' });
  const logsApplied = store.applySnapshot({ generation: logsToken, snapshot: snapshotFor(shiftA, { shiftRevision: 4 }) });
  assert.equal(logsApplied.applied, true);
  assert.equal(store.context('shift_a').inflight['snapshot'].generation, second.generation, 'another request kind must not clear the snapshot generation');

  const accepted = store.applySnapshot({ generation: second, snapshot: snapshotFor(shiftA, { shiftRevision: 4 }) });
  assert.equal(accepted.applied, true);
  assert.equal(store.context('shift_a').revisions.shift, 4);
});

test('snapshot for another shift or workspace is rejected', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA, shiftB]);
  const token = store.beginRequest({ shiftId: 'shift_a', requestKind: 'snapshot' });

  const wrongShift = store.applySnapshot({ generation: token, snapshot: snapshotFor(shiftB) });
  assert.equal(wrongShift.applied, false);
  assert.equal(wrongShift.reason, 'snapshot-shift-mismatch');

  const wrongWorkspace = store.applySnapshot({ generation: token, snapshot: snapshotFor(shiftA, { workspaceId: 'workspace_other' }) });
  assert.equal(wrongWorkspace.applied, false);
  assert.equal(wrongWorkspace.reason, 'snapshot-workspace-mismatch');
  assert.equal(store.context('shift_a').loaded, false);
});

test('snapshot with an older shift revision is ignored and marks the context stale', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA]);
  loadSnapshot(store, shiftA, { shiftRevision: 5 });

  const token = store.beginRequest({ shiftId: 'shift_a', requestKind: 'snapshot' });
  const result = store.applySnapshot({ generation: token, snapshot: snapshotFor(shiftA, { shiftRevision: 4 }) });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'stale-shift-revision');
  assert.equal(store.context('shift_a').revisions.shift, 5);
  assert.equal(store.context('shift_a').stale, true);
  assert.equal(store.context('shift_a').badge.conflict, true);
});

test('background shift update only touches its own badge', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA, shiftB, shiftC]);
  store.selectShift('shift_a');
  loadSnapshot(store, shiftA, { logs: [{ id: 'log_a', shiftId: 'shift_a', truckId: 'truck_1' }] });
  assert.equal(store.context('shift_a').badge.pending, 0);

  loadSnapshot(store, shiftB, { logs: [{ id: 'log_b', shiftId: 'shift_b', truckId: 'truck_2' }], pendingServerReceipts: 2 });
  loadSnapshot(store, shiftC, { pendingServerReceipts: 1 });

  assert.equal(store.activeShiftId(), 'shift_a');
  assert.deepEqual(store.visibleContext().snapshot.logs.map(l => l.id), ['log_a']);
  assert.equal(store.context('shift_b').badge.pending, 2);
  assert.equal(store.context('shift_b').badge.closing, false);
  assert.equal(store.context('shift_c').badge.closing, true);
  assert.equal(store.context('shift_a').badge.pending, 0);
  assert.deepEqual(store.context('shift_a').snapshot.logs.map(l => l.id), ['log_a']);
});

test('stale cross-shift result requires refreshing both shifts', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA, shiftB]);
  loadSnapshot(store, shiftA, { shiftRevision: 5 });
  loadSnapshot(store, shiftB, { shiftRevision: 7 });

  const sourceToken = store.beginRequest({ shiftId: 'shift_a', requestKind: 'cross-shift' });
  const destinationToken = store.beginRequest({ shiftId: 'shift_b', requestKind: 'cross-shift' });
  const result = store.applyCrossShiftResult({
    sourceShiftId: 'shift_a',
    destinationShiftId: 'shift_b',
    requestKind: 'cross-shift',
    sourceGeneration: sourceToken,
    destinationGeneration: destinationToken,
    sourceRevision: 5,
    destinationRevision: 6,
    sourceSnapshot: snapshotFor(shiftA, { shiftRevision: 6 }),
    destinationSnapshot: snapshotFor(shiftB, { shiftRevision: 8 })
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'stale-cross-shift-result');
  assert.deepEqual(result.refresh, ['shift_a', 'shift_b']);
  assert.equal(store.context('shift_a').stale, true);
  assert.equal(store.context('shift_b').stale, true);
  assert.equal(store.context('shift_a').badge.conflict, true);
  assert.equal(store.context('shift_b').badge.conflict, true);
  assert.equal(store.context('shift_a').revisions.shift, 5);
  assert.equal(store.context('shift_b').revisions.shift, 7);
});

test('cross-shift result applies only when both generations and revisions match', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA, shiftB]);
  loadSnapshot(store, shiftA, { shiftRevision: 5 });
  loadSnapshot(store, shiftB, { shiftRevision: 7 });

  const sourceToken = store.beginRequest({ shiftId: 'shift_a', requestKind: 'cross-shift' });
  const destinationToken = store.beginRequest({ shiftId: 'shift_b', requestKind: 'cross-shift' });
  const result = store.applyCrossShiftResult({
    sourceShiftId: 'shift_a',
    destinationShiftId: 'shift_b',
    requestKind: 'cross-shift',
    sourceGeneration: sourceToken,
    destinationGeneration: destinationToken,
    sourceRevision: 5,
    destinationRevision: 7,
    sourceSnapshot: snapshotFor(shiftA, { shiftRevision: 6, logs: [{ id: 'log_source', shiftId: 'shift_a' }] }),
    destinationSnapshot: snapshotFor(shiftB, { shiftRevision: 8, logs: [{ id: 'log_destination', shiftId: 'shift_b' }] })
  });

  assert.equal(result.applied, true);
  assert.equal(store.context('shift_a').revisions.shift, 6);
  assert.equal(store.context('shift_b').revisions.shift, 8);
  assert.deepEqual(store.context('shift_a').snapshot.logs.map(l => l.id), ['log_source']);
  assert.deepEqual(store.context('shift_b').snapshot.logs.map(l => l.id), ['log_destination']);
  assert.equal(store.context('shift_a').inflight['cross-shift'], undefined);
  assert.equal(store.context('shift_b').inflight['cross-shift'], undefined);
});

test('legacy projection is a read-only view of the selected context', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA, shiftB]);
  loadSnapshot(store, shiftA, {
    logs: [{ id: 'log_a', shiftId: 'shift_a', truckId: 'truck_1' }],
    statuses: [{ id: 'truck_1', shiftId: 'shift_a', arriveStatus: 'arrived' }]
  });
  loadSnapshot(store, shiftB, {
    logs: [{ id: 'log_b', shiftId: 'shift_b', truckId: 'truck_2' }],
    statuses: [{ id: 'truck_2', shiftId: 'shift_b', arriveStatus: 'arrived' }]
  });
  store.selectShift('shift_a');

  const legacy = { shift: null, logs: [], truckStatus: {} };
  const projected = store.projectActiveContextToLegacyState(legacy);
  assert.equal(projected, legacy);
  assert.equal(legacy.shift.shiftId, 'shift_a');
  assert.deepEqual(legacy.logs.map(l => l.id), ['log_a']);
  assert.deepEqual(Object.keys(legacy.truckStatus), ['truck_1']);
  assert.equal(legacy.status.truck_1.id, 'truck_1', 'legacy status alias mirrors truck statuses');

  legacy.logs.push({ id: 'fake' });
  legacy.truckStatus.truck_1.arriveStatus = 'mutated';
  legacy.shift.objectName = 'mutated';
  assert.deepEqual(store.context('shift_a').snapshot.logs.map(l => l.id), ['log_a']);
  assert.equal(store.context('shift_a').snapshot.statuses[0].arriveStatus, 'arrived');
  assert.equal(store.context('shift_a').shift.objectName, 'Невский проспект');
});

test('detached trips are addressed by source shift and cycle', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA, shiftB, shiftC]);
  const detached = {
    sourceShiftId: 'shift_a',
    cycleId: 'cycle_1',
    destinationShiftId: 'shift_b',
    truckId: 'truck_1',
    stage: 'loaded',
    state: 'open',
    cycleRevision: 2
  };
  loadSnapshot(store, shiftA, { detachedOpenTrips: [detached] });

  assert.equal(store.detachedTrip('shift_a', 'cycle_1').destinationShiftId, 'shift_b');
  assert.equal(store.detachedTrip('cycle_1', 'shift_a'), null);
  assert.equal(store.detachedTrip('shift_a', 'cycle_2'), null);
  assert.deepEqual(store.detachedTripsFor('shift_a').map(t => t.cycleId), ['cycle_1']);
  assert.deepEqual(store.detachedTripsFor('shift_b').map(t => t.cycleId), ['cycle_1']);
  assert.deepEqual(store.detachedTripsFor('shift_c'), []);

  loadSnapshot(store, shiftA, { detachedOpenTrips: [] });
  assert.equal(store.detachedTrip('shift_a', 'cycle_1'), null, 'completed detached trip disappears with a fresh snapshot');
});

test('restored archive context never changes the active shift', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA, shiftB]);
  store.selectShift('shift_a');

  store.setRestoredContext({ archiveId: 'archive_1', sourceShiftId: 'shift_old', archiveRevision: 4 });
  assert.equal(store.activeShiftId(), 'shift_a');
  assert.equal(store.visibleContext().shiftId, 'shift_a');
  assert.equal(store.restoredContext().archiveId, 'archive_1');

  store.setRestoredContext({ archiveId: 'archive_2', sourceShiftId: 'shift_old', archiveRevision: 5 });
  assert.equal(store.activeShiftId(), 'shift_a');
  assert.equal(store.restoredContext().archiveRevision, 5);

  assert.equal(store.selectShift('shift_old'), false);
  assert.equal(store.activeShiftId(), 'shift_a');
});

test('clear session removes selection and every context', () => {
  const storage = memoryStorage();
  const store = makeStore({ storage });
  store.replaceVisibleShifts([shiftA, shiftB]);
  store.selectShift('shift_b');
  loadSnapshot(store, shiftB);
  store.setPending('shift_b', [{ operationId: 'op-b', shiftId: 'shift_b' }]);
  store.setRestoredContext({ archiveId: 'archive_1', sourceShiftId: 'shift_old', archiveRevision: 4 });
  assert.equal(storage._map.size, 1);

  store.clearSession();
  assert.equal(store.activeShiftId(), null);
  assert.equal(store.visibleContext(), null);
  assert.equal(store.context('shift_b'), null);
  assert.equal(store.restoredContext(), null);
  assert.equal(storage._map.size, 0, 'selection key must be removed');

  const fresh = makeStore({ storage });
  fresh.replaceVisibleShifts([shiftA, shiftB]);
  assert.equal(fresh.activeShiftId(), 'shift_a', 'cleared selection must not be restored');
});

test('unknown or hidden shift requests and selections are rejected', () => {
  const store = makeStore();
  store.replaceVisibleShifts([shiftA]);
  assert.equal(store.beginRequest({ shiftId: 'shift_unknown', requestKind: 'snapshot' }), null);
  assert.equal(store.selectShift('shift_unknown'), false);
  assert.equal(store.applySnapshot({
    generation: { uid: 'uid_alpha', workspaceId: WORKSPACE, shiftId: 'shift_unknown', requestKind: 'snapshot', generation: 1 },
    snapshot: snapshotFor(shiftA)
  }).reason, 'shift-not-visible');
});
