const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('test-app/source/core/20-backend-mode.js','utf8');
function harness(){
 const saved=new Map(),errors=[],toasts=[];
 const nodes=Object.fromEntries(['admin-backend-settings','testBackendMode','testBackendActual','testBackendModeNote'].map(id=>[id,{}]));
 const c={isNasRuntime:()=>false,currentUid:'admin-a',permissionsLoaded:true,currentUserStatus:'active',currentUserRole:'admin',firebaseConfig:{projectId:'samosval-offline'},WORKSPACE_ID:'main_workspace',
 document:{getElementById:id=>nodes[id]},localStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)},
 canAdmin:()=>c.currentUserStatus==='active'&&c.currentUserRole==='admin',getSyncStatus:()=>({state:'ok'}),
 showError:s=>errors.push(s),showToastEl:s=>toasts.push(s),updateSyncUI:()=>c.renderTestBackendControls()};
 vm.createContext(c);vm.runInContext(source,c);return {c,saved,nodes,errors,toasts};
}
const h=harness(),{c,nodes,saved}=h;
assert.equal(c.getTestBackendMode(),'firebase');
assert.equal(c.setTestBackendMode('auto'),true);assert.equal(c.getTestBackendMode(),'auto');
assert.equal(nodes.testBackendMode.value,'auto');assert.match(nodes.testBackendModeNote.textContent,/автоматически используется Firebase/);
assert.equal(c.getTestBackendIndicator({state:'ok'}).letter,'F');
assert.equal(c.getTestBackendIndicator({state:'syncing'}).letter,'F');
assert.equal(c.getTestBackendIndicator({state:'offline'}).letter,'О');
assert.equal(c.getTestBackendIndicator({state:'init'}).letter,'…');
assert.equal(c.getTestBackendIndicator({state:'error'}).letter,'!');
assert.equal(c.setTestBackendMode('synology'),false);assert.equal(c.getTestBackendMode(),'auto');assert.equal(c.getTestBackendIndicator({state:'ok'}).letter,'F');
assert.equal(c.setTestBackendMode('unexpected'),false);assert.equal(c.getTestBackendMode(),'auto');
const before=[...saved];
for(const change of [{currentUserRole:'viewer'},{currentUserRole:'admin',currentUserStatus:'disabled'},{currentUserStatus:'active',permissionsLoaded:false}]){
 Object.assign(c,change);assert.equal(c.setTestBackendMode('firebase'),false);assert.deepEqual([...saved],before);assert.equal(nodes['admin-backend-settings'].hidden,true);
}
Object.assign(c,{permissionsLoaded:true,currentUserRole:'admin',currentUserStatus:'active'});
c.currentUid='admin-b';assert.equal(c.getTestBackendMode(),'firebase');assert.equal(c.setTestBackendMode('firebase'),true);
c.currentUid='admin-a';assert.equal(c.getTestBackendMode(),'auto');
saved.set(c.testBackendPreferenceKey(),'synology');assert.equal(c.getTestBackendMode(),'firebase','unsupported stored selection cannot enable NAS');
c.currentUid='';assert.equal(c.getTestBackendIndicator({state:'ok'}).letter,'…');assert.equal(c.setTestBackendMode('auto'),false);
c.currentUid='admin-a';c.localStorage.setItem=()=>{throw Error('quota')};assert.equal(c.setTestBackendMode('auto'),false);assert.equal(nodes.testBackendMode.value,'firebase');
const shell=fs.readFileSync('test-app/source/shell.html','utf8');
assert.match(shell,/<button[^>]+class="sync-dot-wrap"/);
assert.match(shell,/<option value="synology" disabled>/);
assert.match(shell,/id="testBackendMode"[^>]+aria-describedby="testBackendModeNote" disabled/);
c.isNasRuntime=()=>true;c.localStorage.setItem=(k,v)=>saved.set(k,v);c.currentUid='admin-a';
assert.equal(c.getTestBackendMode(),'synology');assert.equal(c.getTestBackendIndicator({state:'ok'}).letter,'S');assert.equal(c.getTestBackendIndicator({state:'offline'}).letter,'О');
console.log('PASS backend controls: admin checks, account isolation, persistence failure, honest F/O/init/error states, unavailable NAS rejection; no business writes or queue mutations');
