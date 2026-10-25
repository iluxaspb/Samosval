const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {fixture}=require('./reports-edit.cjs');
const manifest=JSON.parse(fs.readFileSync('test-app/modules.json','utf8'));
const files=manifest.modules.flatMap(module=>module.kind==='style'?[]:module.sources);
const handlerNames=['deleteLog','saveLogEdit','openEditLog','saveArchivePNG','generatePNGFromHTML','exportCurrentReportPNG','exportArchivePNG'];
const overridePattern=new RegExp('(?:window\\.)?(?:'+handlerNames.join('|')+')\\s*=(?!=)');
const overrides=files.filter(file=>file.startsWith('features/')&&overridePattern.test(fs.readFileSync('test-app/src/'+file,'utf8')));
assert.deepEqual(overrides,['features/delete-trip.js'],'new effective report overrides must be added to the regression harness');
function effective(){
  const f=fixture(),timers=[],rendered=[];f.c.window=f.c;
  f.c.console={log(){},warn(){},error(e){throw e;}};
  f.c.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};
  f.c.hasTabAccess=()=>true;f.c.hasPermission=()=>true;
  f.c.document.getElementById=id=>id==='report-viewer-overlay'?null:f.el(id);
  f.c.renderReport=()=>rendered.push('report');
  // Follow actual manifest order; the final window handlers are the ones invoked below.
  for(const file of overrides)vm.runInContext(fs.readFileSync('test-app/src/'+file,'utf8'),f.c,{filename:file});
  assert.equal(f.c.__fixLogDeleteV1,true);
  return {...f,timers,rendered};
}
(async()=>{
  const ok=effective();await ok.c.deleteLog('log');assert.equal(ok.server.log,undefined);assert.equal(ok.writes[0][0],'delete');assert.equal(ok.success.length,1);assert(ok.rendered.length>0);
  for(const reason of ['closing','restoring','inactive','other-shift','conflict','missing','permission','pending']){
    const t=effective();
    if(reason==='closing')t.server.shift.closing=true;
    if(reason==='restoring')t.server.shift.restoring=true;
    if(reason==='inactive')t.server.shift.isActive=false;
    if(reason==='other-shift')t.server.shift.id='other';
    if(reason==='conflict')t.server.log.volume=99;
    if(reason==='missing')delete t.server.log;
    if(reason==='permission')t.c.requireEdit=()=>false;
    if(reason==='pending')t.c.state.logs[0].offlinePending=true;
    await t.c.deleteLog('log');assert.equal(t.writes.length,0,reason);assert.equal(t.success.length,0,reason);assert.equal(t.c.state.logs.length,1,reason);
  }
  const confirm=effective();confirm.c.appConfirm=async()=>{confirm.server.log.comment='edited on second device';return true;};await confirm.c.deleteLog('log');assert.equal(confirm.writes.length,0,'snapshot captured before confirmation detects intervening edit');
  const account=effective();account.c.appConfirm=async()=>{account.c.currentUid='another-user';return true;};await account.c.deleteLog('log');assert.equal(account.writes.length,0,'confirmation cannot authorize a different account');
  const revoked=effective();revoked.c.appConfirm=async()=>{revoked.c.requireEdit=()=>false;return true;};await revoked.c.deleteLog('log');assert.equal(revoked.writes.length,0,'permissions rechecked after confirmation');

  const rejection=effective();let rejectCommit;rejection.setCommit(()=>new Promise((resolve,reject)=>{rejectCommit=reject;}));
  const pending=rejection.c.deleteLog('log');while(!rejectCommit)await Promise.resolve();
  rejection.c.state.logs=[];rejectCommit(Error('write failed'));await pending;
  assert.equal(rejection.c.state.logs.length,0,'failed delete never resurrects a record removed by a remote snapshot');assert.equal(rejection.success.length,0);

  const edit=effective();let finishCommit;edit.setCommit(()=>new Promise(resolve=>{finishCommit=resolve;}));const saved=edit.c.saveLogEdit();while(!finishCommit)await Promise.resolve();assert.equal(edit.success.length,0);assert.equal(edit.c.state.logs[0].volume,10);finishCommit();await saved;assert.equal(edit.server.log.volume,25);assert.equal(edit.success.length,1);
  const editBlocked=effective();editBlocked.server.shift.closing=true;await editBlocked.c.saveLogEdit();assert.equal(editBlocked.writes.length,0,'effective save wrapper keeps core freeze guard');
  const double=effective();let finishConfirm;double.c.appConfirm=()=>new Promise(resolve=>{finishConfirm=resolve;});const first=double.c.deleteLog('log');await double.c.deleteLog('log');finishConfirm(true);await first;assert.equal(double.writes.length,1,'repeat clicks cannot perform duplicate delete');
  console.log('PASS effective TEST handlers: manifest-loaded delete override keeps transaction/freeze/conflict/permission/account guards; no rollback resurrection; wrapped save preserves core behavior; report PNG handlers have no later replacement');
})().catch(e=>{console.error(e);process.exitCode=1;});
