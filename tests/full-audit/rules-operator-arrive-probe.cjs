'use strict';
// Точечная проверка правил: может ли оператор с action_arrive отметить приезд
// на смене, открытой другим человеком.
const fs = require('fs'), path = require('path'), {spawn} = require('child_process');
const root = path.resolve(__dirname, '../..');
const port = 8098, PROJECT = 'demo-samosval-rules-probe';
const jar = process.env.FIRESTORE_EMULATOR_JAR;
const delay = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const emu = spawn('java', ['-Xmx512m', '-jar', jar, '--host', '127.0.0.1', '--port', String(port), '--project_id', PROJECT], {stdio: ['ignore', 'pipe', 'pipe']});
  let log = ''; emu.stdout.on('data', d => (log += d)); emu.stderr.on('data', d => (log += d));
  const until = Date.now() + 45000;
  while (!log.includes('Dev App Server is now running')) {
    if (Date.now() > until) throw new Error('emulator timeout ' + log.slice(-500));
    await delay(150);
  }
  const sdk = require('firebase/firestore');
  const {initializeTestEnvironment} = require('@firebase/rules-unit-testing');
  const env = await initializeTestEnvironment({projectId: PROJECT, firestore: {host: '127.0.0.1', port, rules: fs.readFileSync(path.join(root, 'firestore-coins-test.rules'), 'utf8')}});
  const W = 'workspaces/main_workspace';
  const seed = async (name, data) => env.withSecurityRulesDisabled(async ctx => sdk.setDoc(sdk.doc(ctx.firestore(), name), data));
  await seed('users/qa-operator', {email: 'qa-operator@example.test', nickname: 'Оператор', role: 'lopater', status: 'active'});
  await seed('settings/permissions', {admin: {tabs: [], actions: []}, viewer: {tabs: ['line'], actions: ['view_header']}, lopater: {tabs: ['line', 'report'], actions: ['action_arrive', 'action_load', 'action_ttn', 'view_header']}});
  await seed('settings/appConfig', {testReviewFlags: {}});
  await seed(`${W}/shift/current`, {id: 'current', objectId: 'qa-object', objectName: 'Объект', startDate: '09.11.2026', isActive: true});
  const base = {id: 'qa-truck', shiftId: 'current', onLine: true, addedBy: 'Админ', addedAt: 1, arriveStatus: null, arriveTimestamp: null, arriveBy: null, ttnStatus: null, ttnBy: null, ttnLogId: null, lastLoadTimestamp: null, lastLoadBy: null, lastLoadLogId: null, cycleRevision: 0, loadedAfterArrive: false};
  await seed(`${W}/truckStatus/qa-truck`, base);

  const op = env.authenticatedContext('qa-operator', {email: 'qa-operator@example.test'}).firestore();
  const ref = sdk.doc(op, `${W}/truckStatus/qa-truck`);
  const attempts = {
    'только разрешённые поля': {arriveStatus: '10:00', arriveTimestamp: 123, arriveBy: 'Оператор', loadedAfterArrive: false, cycleRevision: 1},
    'полный документ (как клиент)': {...base, arriveStatus: '10:00', arriveTimestamp: 123, arriveBy: 'Оператор', cycleRevision: 1, lastResetOperationId: 'op_1'},
  };
  for (const [name, payload] of Object.entries(attempts)) {
    try { await sdk.updateDoc(ref, payload); console.log('PASS', name); }
    catch (e) { console.log('FAIL', name, '→', e.code, e.message.split('\n')[0]); }
  }
  // Что видит оператор в документе прав — от этого зависит can('action_arrive').
  try {
    const snap = await sdk.getDoc(sdk.doc(op, 'settings/permissions'));
    console.log('PERMS READ', JSON.stringify(snap.data()));
  } catch (e) { console.log('PERMS READ FAIL', e.code); }
  // Контроль: та же запись от администратора.
  await seed('users/qa-admin', {email: 'qa-admin@example.test', nickname: 'Админ', role: 'admin', status: 'active'});
  const adm = env.authenticatedContext('qa-admin', {email: 'qa-admin@example.test'}).firestore();
  try { await sdk.updateDoc(sdk.doc(adm, `${W}/truckStatus/qa-truck`), {arriveStatus: '10:05', arriveTimestamp: 124, arriveBy: 'Админ', loadedAfterArrive: false, cycleRevision: 2}); console.log('PASS admin same payload'); }
  catch (e) { console.log('FAIL admin same payload →', e.code); }
  // Изоляция: может ли администратор писать туда вообще (правило manage_trucks).
  try { await sdk.updateDoc(sdk.doc(adm, `${W}/trucks/qa-truck`), {brand: 'Учебный КАМАЗ 2'}); console.log('PASS admin trucks write'); }
  catch (e) { console.log('FAIL admin trucks write →', e.code); }
  // Изоляция: только одно поле приезда.
  try { await sdk.updateDoc(sdk.doc(adm, `${W}/truckStatus/qa-truck`), {arriveStatus: '10:07'}); console.log('PASS admin single field'); }
  catch (e) { console.log('FAIL admin single field →', e.code); }
  // Изоляция: виден ли документ и работает ли общее правило записи.
  try { const t = await sdk.getDoc(sdk.doc(adm, `${W}/truckStatus/qa-truck`)); console.log('TRUCK READ exists=', t.exists(), JSON.stringify(t.data()).slice(0,120)); }
  catch (e) { console.log('TRUCK READ FAIL', e.code); }
  try { await sdk.setDoc(sdk.doc(adm, `${W}/zzz-probe/one`), {a: 1}); console.log('PASS admin catch-all write'); }
  catch (e) { console.log('FAIL admin catch-all write →', e.code); }
  // update (не create) в свободной коллекции — работает ли обновление вообще.
  try { await sdk.updateDoc(sdk.doc(adm, `${W}/zzz-probe/one`), {a: 2}); console.log('PASS admin catch-all update'); }
  catch (e) { console.log('FAIL admin catch-all update →', e.code); }
  // merge-set вместо update в truckStatus.
  try { await sdk.setDoc(sdk.doc(adm, `${W}/truckStatus/qa-truck`), {arriveStatus: '10:09'}, {merge: true}); console.log('PASS admin merge-set truckStatus'); }
  catch (e) { console.log('FAIL admin merge-set truckStatus →', e.code); }
  // Проверяем, читается ли профиль администратора в правилах.
  try { const u = await sdk.getDoc(sdk.doc(adm, 'users/qa-admin')); console.log('ADMIN PROFILE', JSON.stringify(u.data())); }
  catch (e) { console.log('ADMIN PROFILE FAIL', e.code); }
  await env.cleanup(); emu.kill();
  process.exit(0);
})().catch(e => { console.error('PROBE ERROR', e.message); process.exit(1); });