const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('test-app/src/core/13-reports.js','utf8');
function fixture(){
  const initial={id:'log',shiftId:'shift',truckId:'truck',truckName:'Truck',volume:10,timeStr:'09:00',timestamp:1761382800000,comment:''};
  const server={shift:{id:'shift',isActive:true},log:{...initial}},elements=new Map(),errors=[],success=[],writes=[],notices=[];
  const el=id=>{if(!elements.has(id))elements.set(id,{value:'',classList:{add(){},remove(){}}});return elements.get(id);};
  let beforeCommit=async()=>{};
  const c={state:{shift:{...server.shift},logs:[{...initial}]},currentUid:'user',editingLogId:null,requireEdit:()=>true,document:{getElementById:el},escapeHtml:s=>s,tfAwait:p=>p,showToastEl:s=>success.push(s),showError:s=>errors.push(s),appNotice:s=>notices.push(s),appConfirm:async()=>true,addAudit:async()=>{},refs:{shift:'shift',logs:{doc:id=>id}},
    db:{runTransaction:async callback=>{const staged=[];await callback({get:async ref=>({exists:!!server[ref],data:()=>({...server[ref]})}),update:(ref,data)=>staged.push(['update',ref,data]),delete:ref=>staged.push(['delete',ref])});await beforeCommit();for(const [op,ref,data]of staged){writes.push([op,ref,data]);if(op==='update')Object.assign(server[ref],data);else delete server[ref];}}}};
  vm.createContext(c);vm.runInContext(source,c);c.openEditLog('log');
  el('editLogVolume').value='25';el('editLogTime').value='11:30';el('editLogComment').value='New';
  return {c,server,errors,success,writes,notices,el,setCommit:fn=>{beforeCommit=fn;}};
}
module.exports = { fixture };
if (require.main === module) (async()=>{
  const f=fixture();let resolveCommit;f.setCommit(()=>new Promise(resolve=>{resolveCommit=resolve;}));
  const save=f.c.saveLogEdit();while(!resolveCommit)await Promise.resolve();
  assert.equal(f.c.state.logs[0].volume,10,'no optimistic local rewrite');assert.equal(f.success.length,0,'no success before server commit');
  resolveCommit();await save;assert.equal(f.server.log.volume,25);assert.equal(f.success.length,1);assert.equal(f.errors.length,0);
  for(const fail of ['closing','restoring','other-shift','removed','concurrent-edit','permission','rejected']){
    const t=fixture();
    if(fail==='closing')t.server.shift={id:'shift',isActive:false,closing:true};
    if(fail==='restoring')t.server.shift.restoring=true;
    if(fail==='other-shift')t.server.shift.id='another';
    if(fail==='removed')delete t.server.log;
    if(fail==='concurrent-edit')t.server.log.volume=80;
    if(fail==='permission')t.c.requireEdit=()=>false;
    if(fail==='rejected')t.setCommit(async()=>{throw Error('permission-denied');});
    await t.c.saveLogEdit();assert.equal(t.writes.length,0,fail);assert.equal(t.c.state.logs[0].volume,10,fail);assert.equal(t.success.length,0,fail);
    if(fail!=='permission')assert(t.errors.length,fail);
  }
  for(const value of ['99:99','24:00','12:60']){const t=fixture();t.el('editLogTime').value=value;await t.c.saveLogEdit();assert.equal(t.writes.length,0);assert.equal(t.notices.length,1);}
  const e=fixture();e.el('editLogVolume').value='';await e.c.saveLogEdit();assert.equal(e.writes.length,0);
  const d=fixture();d.setCommit(async()=>{throw Error('offline');});await d.c.deleteLog('log');assert.equal(d.c.state.logs.length,1);assert.equal(d.success.length,0);assert(d.errors.includes('offline'));
  const closedDelete=fixture();closedDelete.server.shift.closing=true;await closedDelete.c.deleteLog('log');assert.equal(closedDelete.writes.length,0);
  const deleted=fixture();await deleted.c.deleteLog('log');assert.equal(deleted.server.log,undefined);assert.equal(deleted.success.length,1);
  console.log('PASS TEST report edits: transaction-only writes; close/restore/shift guards; conflicting edit detection; rejection preserves local rows; valid time/volume; success only after commit');
})().catch(e=>{console.error(e);process.exitCode=1;});
