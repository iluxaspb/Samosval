// Real Firebase SDK + deployed-source test rules, with isolated demo data only.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const firebase = require('firebase/compat/app'); require('firebase/compat/firestore');
const {initializeTestEnvironment} = require('@firebase/rules-unit-testing');
const {doc, setDoc} = require('firebase/firestore');
const {client, server, plain} = require('./offline-harness.cjs');
const root = path.resolve(__dirname, '../..'), project = 'demo-offline-audit';
const port = Number(process.env.OFFLINE_FIRESTORE_PORT || 8098), apps = [];
const jar = process.env.FIRESTORE_EMULATOR_JAR;
assert(jar && fs.existsSync(jar), 'Set FIRESTORE_EMULATOR_JAR to the local emulator JAR');
const emulator = spawn('java', ['-Xmx512m', '-jar', jar, '--host', '127.0.0.1', '--port', String(port), '--project_id', project]);
let log = '', env;
emulator.stdout.on('data', chunk => log += chunk); emulator.stderr.on('data', chunk => log += chunk);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {console.error('FAIL emulator suite timed out\n' + log.slice(-3000)); emulator.kill(); process.exit(1);}, 90000);

function connect(uid, options = {}) {
  const x = client(server(), {uid, ...options});
  const app = firebase.initializeApp({projectId: project, apiKey: 'local-demo'}, 'offline-' + uid + '-' + apps.length);
  apps.push(app); const db = app.firestore();
  db.useEmulator('127.0.0.1', port, {mockUserToken: {sub: uid, email: uid + '@example.com'}});
  const ws = db.collection('workspaces').doc('main_workspace');
  x.c.refs.shift = ws.collection('shift').doc('current');
  for (const name of ['truckStatus', 'logs']) x.c.refs[name] = ws.collection(name);
  for (const name of ['audit', 'notifications']) x.c.refs[name] = {doc: id => {
    const ref = ws.collection(name).doc(id);
    return {get: opts => ref.get(opts), set: data => ref.set(plain(data))};
  }};
  x.c.appConfigRef = db.doc('settings/appConfig');
  x.c.setTimeout = setTimeout; x.c.clearTimeout = clearTimeout;
  x.c.db.runTransaction = async fn => {
    const result = await db.runTransaction(tx => fn({get: ref => tx.get(ref),
      set: (ref, data) => tx.set(ref, plain(data)), update: (ref, data) => tx.update(ref, plain(data))}));
    if (x.loseReply && result.didCommit) {x.loseReply = false; throw {code: 'unavailable', message: 'Injected lost commit reply'};}
    return result;
  };
  x.db = db; return x;
}
async function seed() {
  await env.clearFirestore(); const initial = server();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await Promise.all([
      setDoc(doc(db, 'settings/appConfig'), {cycleMinutes: 15}),
      setDoc(doc(db, 'settings/permissions'), {lopater: {actions: ['action_load', 'action_arrive', 'action_ttn', 'undo_action']}}),
      ...['a', 'b'].map(uid => setDoc(doc(db, 'users/' + uid), {email: uid + '@example.com', role: 'lopater', status: 'active'})),
      setDoc(doc(db, 'workspaces/main_workspace/shift/current'), initial.rows.get('shift')),
      setDoc(doc(db, 'workspaces/main_workspace/truckStatus/t'), initial.rows.get('truckStatus/t'))
    ]);
  });
}
async function replay(x) {x.c.navigator.onLine = true; await x.c.offlineReplayJournal(); await x.c.offlineReplayEffects();}
const queue = x => assert(x.c.offlineQueueAction('load', 't', x.c.captureLineIntent('t')));

(async () => {
  for (let attempt = 0; attempt < 300 && !log.includes('Dev App Server is now running'); attempt++) await delay(100);
  assert(log.includes('Dev App Server is now running'), log.slice(-3000));
  env = await initializeTestEnvironment({projectId: project, firestore: {host: '127.0.0.1', port,
    rules: fs.readFileSync(path.join(root, 'firestore-timesheet-test.rules'), 'utf8')}});
  await seed(); const a = connect('a'), b = connect('b'); queue(a); queue(b);
  await Promise.all([replay(a), replay(b)]);
  assert.equal((await a.c.refs.logs.get()).size, 1);
  assert.deepEqual([a, b].map(x => x.c.offlineJournalRead()[0].status).sort(), ['confirmed', 'rejected']);
  assert.equal((await a.db.collection('workspaces/main_workspace/audit').get()).size, 1);
  assert.equal((await a.db.collection('workspaces/main_workspace/notifications').get()).size, 1);
  console.log('PASS REAL FIRESTORE two competing offline clients produce one trip, audit and notification under current test rules');

  await seed(); const first = connect('a'); queue(first); first.loseReply = true;
  await replay(first); assert.equal(first.c.offlinePendingCount(), 1);
  const restarted = connect('a', {storage: first.storage}); await replay(restarted);
  assert.equal(restarted.c.offlinePendingCount(), 0); assert.equal((await restarted.c.refs.logs.get()).size, 1);
  assert.equal((await restarted.db.collection('workspaces/main_workspace/audit').get()).size, 1);
  console.log('PASS REAL FIRESTORE successful commit with lost acknowledgement survives restart without duplicate');

  await seed(); const denied = connect('a'); queue(denied);
  await env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'settings/permissions'), {lopater: {actions: []}}));
  await replay(denied); assert.equal((await denied.c.refs.logs.get()).size, 0);
  assert.equal(denied.c.offlineJournalRead()[0].status, 'rejected');
  console.log('PASS REAL FIRESTORE changed permissions reject the queued action without creating a trip');

  await seed(); const closed = connect('a'); queue(closed);
  await env.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'workspaces/main_workspace/shift/current'), {id: 'next', isActive: true}));
  await replay(closed); assert.equal((await closed.c.refs.logs.get()).size, 0);
  assert.equal(closed.c.offlineJournalRead()[0].result, 'shift-changed');
  console.log('PASS REAL FIRESTORE stale queued action cannot enter a newer shift');
})().catch(error => {console.error(error); console.error(log.slice(-2000)); process.exitCode = 1;})
  .finally(async () => {for (const app of apps) await app.delete(); if (env) await env.cleanup(); emulator.kill(); clearTimeout(watchdog);});
