const assert = require('node:assert/strict');
const {client, server, plain} = require('./offline-harness.cjs');
const count = (s, collection) => [...s.rows.keys()].filter(key => key.startsWith(collection + '/')).length;
const queue = (x, type = 'load') => assert(x.c.offlineQueueAction(type, 't', x.c.captureLineIntent('t')));
const replay = async x => {x.c.navigator.onLine = true; await x.c.offlineReplayJournal();};
// Pending mocked promises do not keep Node alive. A real watchdog ensures a
// stalled queue fails this suite instead of exiting early with a false pass.
const watchdog = setTimeout(() => {console.error('FAIL offline regression did not complete'); process.exit(1);}, 5000);

(async () => {
  // Both clients capture the same cycle. The emulator-like harness retries
  // conflicting transactions against a versioned, shared server.
  const shared = server(), a = client(shared, {uid: 'a'}), b = client(shared, {uid: 'b'});
  queue(a); queue(b); await Promise.all([replay(a), replay(b)]);
  assert.equal(count(shared, 'logs'), 1);
  assert.deepEqual([a, b].map(x => x.c.offlineJournalRead()[0].status).sort(), ['confirmed', 'rejected']);
  assert(shared.retries > 0);
  await Promise.all([a.c.offlineReplayEffects(), b.c.offlineReplayEffects()]);
  assert.equal(count(shared, 'notifications'), 1); assert.equal(count(shared, 'audit'), 1);
  console.log('PASS two clients and transaction retry produce one trip, one audit and one notification');

  // The first commit succeeds but its acknowledgement is lost. Recreate the
  // client from its durable storage, then resend exactly the same operation.
  let x = client(); queue(x);
  x.shared.afterCommit = async writes => {if (writes.length) {x.shared.afterCommit = null; throw {code: 'unavailable', message: 'Lost reply'};}};
  await replay(x); assert.equal(count(x.shared, 'logs'), 1); assert.equal(x.c.offlinePendingCount(), 1);
  x = client(x.shared, {storage: x.storage, clock: x.clock});
  await replay(x); await x.c.offlineReplayEffects();
  assert.equal(x.c.offlinePendingCount(), 0); assert.equal(count(x.shared, 'logs'), 1);
  assert.equal(count(x.shared, 'notifications'), 1); assert.equal(count(x.shared, 'audit'), 1);
  console.log('PASS commit acknowledgement loss + restart replays idempotently');

  x = client(); queue(x);
  const original = x.c.db.runTransaction;
  x.c.db.runTransaction = async () => {throw {code: 'unavailable', message: 'No route'};};
  await replay(x); assert.equal(x.c.offlinePendingCount(), 1); assert.equal(count(x.shared, 'logs'), 0);
  x.c.db.runTransaction = original; x.c.offlineTransportRecovered();
  await replay(x); await x.c.offlineReplayEffects(); assert.equal(count(x.shared, 'logs'), 1);
  console.log('PASS network failure retains durable action and reconnect commits it once');

  // An old confirmed effect is stuck on the server. Neither its get nor the
  // later notification set may hold the next operational transaction.
  for (const stage of ['effectGet', 'effectSet']) {
    x = client();
    const saved = {id: 'older', shiftId: 's', truckId: 't', status: 'confirmed', type: 'arrive', actor: 'a', email: 'a@example.com', createdAt: 998000, objectId: 'old-object', objectName: 'Old object', savedResult: {}};
    x.c.offlineJournalWrite([saved]);
    x.control[stage] = key => key.startsWith('notifications/') ? new Promise(() => {}) : undefined;
    queue(x); await replay(x);
    assert.equal(count(x.shared, 'logs'), 1, stage + ' stalled transaction queue');
    assert.equal(x.c.offlinePendingCount(), 0); assert.equal(x.run('offlineReplayRunning'), false);
    assert(x.c.offlineUndeliveredEffects().length > 0);
    for(let pass=0;pass<4;pass++){await x.tick();x.expire();}
    await x.tick();
    await x.c.offlineReplayEffects();
    x.control[stage] = null; x.clock.now += 8001;
    await x.c.offlineReplayEffects();
    assert.equal(x.c.offlineUndeliveredEffects().length, 0);
    assert.equal(count(x.shared, 'logs'), 1);
    assert.equal(count(x.shared, 'notifications'), 2); assert.equal(count(x.shared, 'audit'), 2);
    assert.equal(x.shared.rows.get('audit/offline_older').objectId, 'old-object');
  }
  console.log('PASS stalled notification get/set never blocks new trips; timeout retries durable effects once');

  x = client();
  x.c.offlineJournalWrite([{id: 'saved', shiftId: 's', truckId: 't', status: 'confirmed', type: 'load', createdAt: 999000, actor: 'a', email: 'a@example.com'}]);
  let release;
  x.control.effectGet = () => new Promise(resolve => {release = resolve;});
  const effect = x.c.offlineReplayEffects(); x.c.navigator.onLine = true;
  await effect; const pending = x.c.offlineReplayEffects(); await x.tick();
  x.c.currentUid = 'new-user'; release(); await pending;
  assert.equal(x.control.writes, 0); assert.equal(x.c.offlineJournalRead().length, 0);
  console.log('PASS logout during notification read never writes old actions under a new account');

  x = client();
  const op = {truckId: 't', shiftId: 's'};
  x.run("offlineRemoteStatuses.t={...offlineRemoteStatuses.t,cycleRevision:5,ttnRevision:9,ttnStatus:true,ttnBy:'newer',ttnLogId:'fresh'}");
  x.c.offlineAdoptResult(op, {status: {...x.c.state.truckStatus.t, cycleRevision: 5, ttnRevision: 8, ttnStatus: null}});
  let adopted = x.run('offlineRemoteStatuses.t');
  assert.equal(adopted.ttnRevision, 9); assert.equal(adopted.ttnStatus, true); assert.equal(adopted.ttnBy, 'newer');
  x.c.offlineAdoptResult(op, {status: {...plain(adopted), cycleRevision: 4, ttnRevision: 10, ttnStatus: null}});
  adopted = x.run('offlineRemoteStatuses.t'); assert.equal(adopted.cycleRevision, 5); assert.equal(adopted.ttnRevision, 10);
  x.c.state.shift = {id: 'next'};
  x.c.offlineAdoptResult(op, {status: {...plain(adopted), cycleRevision: 99}, log: {id: 'old-shift-log'}});
  assert.equal(x.run('offlineRemoteStatuses.t.cycleRevision'), 5); assert.equal(x.run('offlineRemoteLogs.length'), 0);
  console.log('PASS late responses merge independent cycle/TTN revisions and cannot enter a newer shift');

  x = client(); queue(x); x.control.renders = 0;
  await replay(x); await x.c.offlineReplayEffects();
  assert.equal(x.control.renders, 1);
  console.log('PASS one line render per confirmed operation instead of duplicate complete redraws');

  x = client();
  const row = (id, extra) => ({id, shiftId: 's', truckId: 't', ...extra});
  const history = Array.from({length: 3000}, (_, i) => row('settled-' + i, {status: 'confirmed', effectsDelivered: true}));
  const protectedRows = [
    row('dependency', {status: 'confirmed', effectsDelivered: true}),
    row('awaiting-delivery', {status: 'confirmed', effectsDelivered: false}),
    row('awaiting-penalty', {status: 'cancelled', penaltyDelivered: false}),
    row('unseen-conflict', {status: 'rejected', reviewed: false}),
    row('pending-action', {status: 'pending', dependencyId: 'dependency'})
  ];
  x.c.offlineJournalWrite([...protectedRows, ...history]);
  const compacted = x.c.offlineJournalRead();
  assert.equal(compacted.length, 205);
  for (const row of protectedRows) assert(compacted.some(x => x.id === row.id), row.id);
  assert(compacted.some(x => x.id === 'settled-2999')); assert(!compacted.some(x => x.id === 'settled-0'));
  x.c.offlineJournalWrite([...compacted, ...Array.from({length: 500}, (_, i) => row('unsent-' + i, {status: 'pending'}))]);
  assert.equal(x.c.offlinePendingCount(), 501, 'Pending records must never be pruned to meet the retention limit');
  console.log('PASS bounded settled journal retains all pending dependencies, unsent effects, penalties and unseen conflicts');

  x = client();
  const largeHistory = history.map(row => ({...row, savedResult: {memo: 'x'.repeat(1000)}}));
  x.storage.set(x.run('offlineJournalKey()'), JSON.stringify(largeHistory));
  x.c.localStorage.setItem = (key, value) => {
    if(value.length > 500000) throw Object.assign(new Error('Storage quota reached'), {name:'QuotaExceededError'});
    x.storage.set(key, value);
  };
  queue(x); assert.equal(x.c.offlinePendingCount(), 1); assert.equal(x.c.offlineJournalRead().length, 201);
  console.log('PASS old settled snapshots are compacted before a new action hits the storage quota');

  x = client();
  x.c.localStorage.setItem = () => {throw new Error('Storage quota reached');};
  assert.equal(x.c.offlineQueueAction('load', 't', x.c.captureLineIntent('t')), false);
  assert.equal(x.c.offlinePendingCount(), 0); assert.equal(x.c.state.logs.length, 0);
  assert.match(x.errors[0], /не сохранено/);
  console.log('PASS a genuine storage failure reports failure without displaying a phantom saved trip');
})().catch(error => {console.error(error); process.exitCode = 1;}).finally(() => clearTimeout(watchdog));
