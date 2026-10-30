const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('test-app/source/core/20-backend-mode.js','utf8');
function harness(){
 const nodes=Object.fromEntries(['admin-backend-settings','testBackendMode','testBackendActual','testBackendModeNote','testSynologyCheck','testSynologyCheckResult'].map(id=>[id,{}]));
 const c={isNasRuntime:()=>false,currentUid:'admin-a',permissionsLoaded:true,currentUserStatus:'active',currentUserRole:'admin',firebaseConfig:{projectId:'samosval-offline'},WORKSPACE_ID:'main_workspace',navigator:{onLine:true},
 document:{getElementById:id=>nodes[id]},localStorage:{getItem:()=>null},canAdmin:()=>c.currentUserStatus==='active'&&c.currentUserRole==='admin',getSyncStatus:()=>({state:'ok'}),auth:{currentUser:{getIdToken:async()=> 'test'}}};
 vm.createContext(c);vm.runInContext(source,c);return {c,nodes};
}
(async()=>{
 const {c,nodes}=harness();let requests=0,release;
 c.loadTestSynologyChecker=async()=>({checkSynology:async({guard})=>{requests++;await new Promise(r=>release=r);guard();return {trucks:23,normal:20,volume:530};}});
 const task=c.checkTestSynologyConnection();await new Promise(setImmediate);
 assert.equal(nodes.testSynologyCheck.disabled,true);
 await c.checkTestSynologyConnection();assert.equal(requests,1,'double click does not duplicate a probe');
 release();await task;
 assert.match(nodes.testSynologyCheckResult.textContent,/530/);
 assert.match(nodes.testSynologyCheckResult.textContent,/остаются в Firebase/);
 assert.equal(c.getTestBackendIndicator({state:'ok'}).letter,'F','probe success cannot switch indicator');
 for(const change of [{currentUid:'other'},{currentUserStatus:'disabled'}]){
  c.currentUid='admin-a';c.currentUserStatus='active';c.renderTestBackendControls();
  const pending=c.checkTestSynologyConnection();await new Promise(setImmediate);
  Object.assign(c,change);c.renderTestBackendControls();release();await pending;
  assert.equal(nodes.testSynologyCheckResult.textContent,'','stale result cleared after session change');
 }
 const before=requests;
 await c.checkTestSynologyConnection();assert.equal(requests,before,'disabled account cannot probe');
 c.currentUserStatus='active';c.navigator.onLine=false;c.renderTestBackendControls();
 assert.equal(nodes.testSynologyCheck.disabled,true);
 await c.checkTestSynologyConnection();assert.equal(requests,before,'offline probe does not submit');
 c.navigator.onLine=true;c.loadTestSynologyChecker=async()=>({checkSynology:async()=>{throw Object.assign(Error('not found'),{status:404});}});
 await c.checkTestSynologyConnection();assert.match(nodes.testSynologyCheckResult.textContent,/HTTPS-маршрут/);
 const shell=fs.readFileSync('test-app/source/shell.html','utf8');
 assert.match(shell,/id="testSynologyCheck"[^>]+onclick="checkTestSynologyConnection\(\)" disabled/);
 assert.match(shell,/id="testSynologyCheckResult"[^>]+aria-live="polite"/);
 console.log('PASS NAS probe UI: access, duplicate click, stale account, disabled account, offline, old route and unchanged Firebase indicator');
})().catch(error=>{console.error(error);process.exitCode=1;});
