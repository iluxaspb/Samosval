const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('index-test.html','utf8');
const context={appConfig:{},console};vm.createContext(context);
vm.runInContext(html.slice(html.indexOf('  const ROLES ='),html.indexOf('  firebase.initializeApp('))+'\nglobalThis.roleTest={ROLES,DEFAULT_PERMISSIONS,normalizePermissionsConfig,canAssignRole};',context);
const {ROLES,DEFAULT_PERMISSIONS,normalizePermissionsConfig,canAssignRole}=context.roleTest;
const plain=x=>JSON.parse(JSON.stringify(x));
const old={foreman:{tabs:['archive'],actions:['archive_edit','custom_existing_permission']},master:{tabs:['line'],actions:['action_arrive']},viewer:{tabs:[],actions:[]}};
const next=normalizePermissionsConfig(old);
assert.deepEqual(plain(next.senior_foreman),old.foreman);assert.deepEqual(plain(next.foreman),old.master);
assert.deepEqual(plain(next.master),old.master);assert(!Object.hasOwn(old,'_roleHierarchyVersion'));
assert.deepEqual(plain(normalizePermissionsConfig(next)),plain(next));
const explicit=normalizePermissionsConfig({...old,senior_foreman:{tabs:[],actions:[]}});assert.deepEqual(plain(explicit.senior_foreman),{tabs:[],actions:[]});
assert.equal(ROLES.senior_foreman.label,'Старший прораб');assert.deepEqual(plain(DEFAULT_PERMISSIONS.foreman),plain(DEFAULT_PERMISSIONS.master));
assert(!DEFAULT_PERMISSIONS.senior_foreman.tabs.includes('admin'));
context.appConfig={testReviewFlags:{senior_foreman_role:false}};
assert(!canAssignRole('senior_foreman'));assert(canAssignRole('senior_foreman','senior_foreman'));assert(canAssignRole('foreman'));assert(!canAssignRole('not-a-role'));

const original=fs.readFileSync('tests/offline-fixes/verify-offline-fixes.cjs','utf8'),h={require,console,__dirname:__dirname,process};vm.createContext(h);
vm.runInContext(original.slice(0,original.indexOf('(async()=>{'))+'\nglobalThis.makeFixture=make;',h);
(async()=>{
  for(const role of ['master','foreman','lopater','viewer']){const {c,server}=h.makeFixture();c.canAdmin=()=>false;c.currentUserRole=role;c.showError=()=>{};assert(!c.offlineQueueAction('reset','t',{shiftId:'s',status:server.status}));}
  let {c,server}=h.makeFixture();c.canAdmin=()=>false;c.currentUserRole='senior_foreman';c.currentEmail='senior@example.com';
  server.status.lastLoadTimestamp=90000000;c.state.truckStatus.t={...server.status};vm.runInContext('offlineRemoteStatuses={t:{...state.truckStatus.t}}',c);
  assert(c.offlineQueueAction('reset','t',{shiftId:'s',status:{...server.status}}));assert.equal(c.state.truckStatus.t.lastLoadTimestamp,null);assert.equal(server.status.lastLoadTimestamp,90000000);
  c.navigator.onLine=true;await c.offlineReplayJournal();assert.equal(server.status.lastLoadTimestamp,null);assert.equal(c.offlineJournalRead()[0].status,'confirmed');assert.equal(c.audit.userEmail,'senior@example.com');
  ({c,server}=h.makeFixture());c.canAdmin=()=>false;c.currentUserRole='senior_foreman';assert(c.offlineQueueAction('reset','t',{shiftId:'s',status:{...server.status}}));
  const oldRun=c.db.runTransaction;c.db.runTransaction=fn=>oldRun(tx=>{const oldGet=tx.get;tx.get=ref=>ref.kind==='policy'?Promise.resolve({exists:true,data:()=>({cycleMinutes:60,testReviewFlags:{senior_foreman_reset:false}})}):oldGet(ref);return fn(tx);});
  c.navigator.onLine=true;await c.offlineReplayJournal();assert.equal(c.offlineJournalRead()[0].status,'rejected');assert.equal(server.status.cycleRevision,1);
  console.log('PASS role mapping preserves custom rights, migrates once, respects empty rights, and restricts offline reset to senior foreman/admin');
})().catch(e=>{console.error(e);process.exitCode=1;});
