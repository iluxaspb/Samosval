const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function coreFrom(script) {
  const boundary = script.indexOf('  let records=');
  assert(boundary > 0, 'Pure game calculation section must be available');
  const context = { window: {}, state: { objects: [] }, appConfig: { gameRewardSchedule: [] }, console };
  vm.runInNewContext(script.slice(0, boundary) + '})();', context);
  return context.window.__gameCoinsCore;
}
const testSource = require('../../tools/read-test-html.cjs')().match(/<script id="game-coins-v2">([\s\S]*?)<\/script>/)[1];
const productionHtml = require('../../tools/read-production-html.cjs')();
const productionSource = productionHtml.match(/<script\s+id="game-coins-v2"[^>]*>([\s\S]*?)<\/script>/)?.[1];
assert(productionSource, 'Production game module must exist');
const testCore = coreFrom(testSource), productionCore = coreFrom(productionSource);
const rates = { version: 1, actionAt: 1000, load: 5, arrive: 7, ttn: 3 };
const status = { shiftId: 's', onLine: true, cycleRevision: 2, lastLoadTimestamp: 200, lastLoadLogId: 'new-load', loadedAfterArrive: true, ttnStatus: null, ttnRevision: 0 };
function event(id, timestamp, operations, reward, extra = {}) {
  return { id, eventType: 'history', timestamp, userEmail: 'worker@example.test', userName: 'Работник', shiftId: 's', objectId: 'o',
    history: { id, timestamp, operations, undone: false, ...(reward ? { gameRewards: { ...reward, actionAt: timestamp } } : {}), ...extra } };
}
function load(id, timestamp, reward) {
  return event(id, timestamp, [{ collection: 'logs', id, before: null, after: { clientOperationId: 'op-' + id, createdByEmail: 'worker@example.test', timestamp, shiftId: 's' } }], reward);
}
function score(core, events) { return core.calculate(events).find(row => row.user === 'worker@example.test')?.coins || 0; }
function sameCase(label, events, expected) {
  assert.equal(score(testCore, events), expected, 'TEST: ' + label);
  assert.equal(score(productionCore, events), expected, 'production: ' + label);
}

const oldLoad = load('old-load', 100);
const newLoad = load('new-load', 200, rates);
const arrival = event('arrival', 300, [{ collection: 'truckStatus', id: 'truck', before: { ...status, arriveTimestamp: null }, after: { ...status, arriveTimestamp: 300, arriveStatus: '10:00' } }], rates);
const ttn = event('ttn', 400, [{ collection: 'truckStatus', id: 'truck', before: status, after: { ...status, ttnStatus: true, ttnLogId: 'new-load', ttnRevision: 1 } }], rates);
sameCase('legacy history retains its original 1 coin', [oldLoad], 1);
sameCase('new action freezes configured load reward', [newLoad], 5);
sameCase('return after a load uses its frozen reward', [arrival], 7);
sameCase('TTN collection earns its configured reward', [ttn], 3);
sameCase('old and new events combine without retrospective repricing', [oldLoad, newLoad, arrival, ttn], 16);
sameCase('duplicate audit delivery is idempotent', [oldLoad, newLoad, ttn, ttn], 9);
sameCase('undo removes the corresponding reward', [{ ...ttn, history: { ...ttn.history, undone: true } }], 0);
sameCase('redo restores the frozen amount', [ttn], 3);
sameCase('zero disables future TTN rewards', [{ ...ttn, history: { ...ttn.history, gameRewards: { ...rates, ttn: 0 } } }], 0);
const firstArrival = { ...arrival, history: { ...arrival.history, operations: [{ ...arrival.history.operations[0], before: { shiftId: 's', onLine: true }, after: { shiftId: 's', onLine: true, arriveTimestamp: 300 } }] } };
sameCase('first arrival remains without a return reward', [firstArrival], 0);

function ticket(id, time, revision, logId) {
  return event(id, time, [{ collection: 'truckStatus', id: 'truck',
    before: { ...status, lastLoadLogId: logId, ttnRevision: revision - 1 },
    after: { ...status, lastLoadLogId: logId, ttnStatus: true, ttnLogId: logId, ttnRevision: revision } }], rates);
}
const secondTicket = ticket('second-ticket', 600, 3, 'second-load');
const thirdTicket = ticket('third-ticket', 800, 5, 'third-load');
sameCase('two completed ticket cycles accumulate', [ttn, secondTicket], 6);
sameCase('three completed ticket cycles accumulate without duplicate delivery', [ttn, secondTicket, thirdTicket, thirdTicket], 9);
const cancelSecond = event('cancel-second', 700, [{ collection: 'truckStatus', id: 'truck',
  before: secondTicket.history.operations[0].after,
  after: { ...secondTicket.history.operations[0].after, ttnStatus: null, ttnBy: null, ttnLogId: null, ttnRevision: 4 } }], rates);
sameCase('cancelling latest ticket preserves earlier completed reward', [ttn, secondTicket, cancelSecond], 3);
sameCase('subsequent ticket adds once after latest cancellation', [ttn, secondTicket, cancelSecond, thirdTicket, thirdTicket], 6);
const pendingTicket = event('pending-ticket', 900, [{ collection: 'truckStatus', id: 'another-truck',
  before: { shiftId: 's', ttnStatus: null, ttnRevision: 0, loadedAfterArrive: false },
  after: { shiftId: 's', ttnStatus: 'pending', ttnRevision: 1, loadedAfterArrive: false } }], rates);
const boundStatus = { ...pendingTicket.history.operations[0].after, ttnStatus: true, ttnLogId: 'pending-load', lastLoadLogId: 'pending-load', loadedAfterArrive: true };
const bindPending = event('bind-pending', 1000, [
  { collection: 'logs', id: 'pending-load', before: null, after: { clientOperationId: 'pending-op', createdByEmail: 'worker@example.test', timestamp: 1000, shiftId: 's' } },
  { collection: 'truckStatus', id: 'another-truck', before: pendingTicket.history.operations[0].after, after: boundStatus }
], rates);
sameCase('pending TTN bound during load does not award twice', [pendingTicket, bindPending], 8);
const cancelPending = event('cancel-pending', 1100, [{ collection: 'truckStatus', id: 'another-truck', before: boundStatus,
  after: { ...boundStatus, ttnStatus: null, ttnLogId: null, ttnRevision: 2 } }], rates);
sameCase('cancelling bound pending TTN removes its single award only', [pendingTicket, bindPending, cancelPending], 5);

const historicalPhoto = { id: 'photo-kept', eventType: 'game_photo', amount: 1, photoId: 'kept', userEmail: 'worker@example.test', timestamp: 50 };
// The approved 3.4.11 baseline no longer counts historical photo events.
historicalPhoto.id = 'photo_' + historicalPhoto.photoId;
assert.equal(score(testCore, [historicalPhoto, oldLoad]), 1, 'Preserve the approved baseline treatment of historical photo events');
assert(!/capturePhoto|openCamera|PhotoFiles|ObjectPhotos|data-photo/.test(testSource), 'Coin settings must not restore removed photo controls');

const configSource = require('../../tools/read-test-html.cjs')();
assert(configSource.includes('gameRewardSchedule:'), 'TEST must preserve the shared reward schedule from app config');
assert(testSource.includes('appConfigRef'), 'TEST settings must use its own configured database reference');
console.log('PASS TEST/production reward parity: defaults, frozen rates, TTN, idempotence, undo/redo, zero reward and baseline photo-event handling');
