const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {fixture}=require('./reports-edit.cjs');
const manifest=JSON.parse(fs.readFileSync('test-app/modules.json','utf8'));
const files=manifest.modules.flatMap(module=>module.kind==='style'?[]:module.sources);
const handlerNames=['deleteLog','saveLogEdit','openEditLog','saveArchivePNG','generatePNGFromHTML','exportCurrentReportPNG','exportArchivePNG'];
const overridePattern=new RegExp('(?:window\\.)?(?:'+handlerNames.join('|')+')\\s*=(?!=)');
const overrides=files.filter(file=>file.startsWith('features/')&&overridePattern.test(fs.readFileSync('test-app/src/'+file,'utf8')));
// The approved unified paper viewer owns the final archive PNG aliases. Load it
// in actual manifest order; keep mutation and frozen-sheet checks below effective.
assert.deepEqual(overrides,['features/delete-trip.js','features/summary-viewer.js'],'new effective report overrides must be added to the regression harness');
function effective(){
  const f=fixture(),timers=[],rendered=[];f.c.window=f.c;
  f.c.console={log(){},warn(){},error(e){throw e;}};
  f.c.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};
  f.c.hasTabAccess=()=>true;f.c.hasPermission=()=>true;
  function decorate(node) {
    if(node.__paperFixture)return node;
    node.__paperFixture=true;node.style={};node.children=[];node.parentNode=null;
    const classes=new Set();node.classList={add:value=>classes.add(value),remove:value=>classes.delete(value),contains:value=>classes.has(value)};
    node.addEventListener=()=>{};node.removeEventListener=()=>{};node.setAttribute=()=>{};node.removeAttribute=()=>{};
    node.append=function(child){this.children.push(child);child.parentNode=this;};node.appendChild=node.append;
    node.remove=function(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null;};
    node.querySelector=()=>null;node.querySelectorAll=()=>[];
    return node;
  }
  const downloads=[],captures=[];
  const document=f.c.document;
  document.getElementById=id=>id==='report-viewer-overlay'?null:decorate(f.el(id));
  document.createElement=tag=>{const node=decorate({});if(tag==='a')node.click=()=>downloads.push({filename:node.download,href:node.href});return node;};
  document.head=decorate({});document.body=decorate({});document.addEventListener=()=>{};document.fonts={ready:Promise.resolve()};
  const body=document.getElementById('modalArchiveBody'),host=document.getElementById('archiveModal'),saveButton={disabled:false};
  function paper(html) {
    const node=decorate({innerHTML:html,scrollWidth:1400,scrollHeight:1000});
    node.cloneNode=()=>paper(node.innerHTML);node.getBoundingClientRect=()=>({left:0,width:1400,height:1000});
    node.querySelector=selector=>selector==='.paper-table'?{getBoundingClientRect:()=>({right:1380})}:null;
    return node;
  }
  host.querySelector=selector=>selector.includes('archive-paper-wrapper')?paper(body.innerHTML):saveButton;
  f.c.Blob=Blob;f.c.innerWidth=1200;f.c.innerHeight=800;
  f.c.URL={createObjectURL:blob=>{assert.equal(blob.type,'image/png');return 'blob:png';},revokeObjectURL(){}};
  f.c.resolveUserDisplayName=(email,name)=>name||'';f.c.findTruck=()=>({id:'truck',brand:'LIVE DIRECTORY',number:'',isGAI:false});f.c.renderRussianPlate=value=>value;
  f.c.viewingArchiveId=null;f.c.viewingArchiveGAITable=false;f.c.__closedShiftDupEnabled=()=>true;
  class Worker {
    constructor(){this.prop={};this.pending=Promise.resolve();}
    set(options){this.options=options;return this;}
    from(node){captures.push({html:node.innerHTML,options:this.options});return this;}
    toContainer(){this.pending=this.pending.then(()=>{this.prop.container=decorate({});this.prop.overlay=decorate({});});return this;}
    then(fn){this.pending=this.pending.then(()=>fn.call(this));return this;}
    toCanvas(){this.pending=this.pending.then(()=>{const {width,height,scale}=this.options.html2canvas;this.prop.canvas={width:width*scale,height:height*scale,toBlob:callback=>callback(new Blob(['png'],{type:'image/png'}))};});return this;}
    get(key){return this.pending.then(()=>this.prop[key]);}
  }
  f.c.html2pdf=()=>new Worker();
  f.paperFixture={downloads,captures,saveButton,body,host};
  f.c.renderReport=()=>rendered.push('report');
  // Follow actual manifest order; the final window handlers are the ones invoked below.
  for(const file of overrides)vm.runInContext(fs.readFileSync('test-app/src/'+file,'utf8'),f.c,{filename:file});
  assert.equal(f.c.__fixLogDeleteV1,true);
  assert.equal(f.c.__paperSheetViewerInstalled,true,'approved viewer override is actually loaded');
  assert.equal(f.c.saveArchivePNG,f.c.exportArchivePNG,'both archive export entry points use the final shared handler');
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
  const png=effective();
  png.c.state.archive=[{id:'archive-a',objectName:'SAVED SITE',date:'SAVED DATE',logs:[{truckId:'truck',truckName:'SAVED TRUCK',volume:10,isGAI:false,timeStr:'09:00',timestamp:1,createdBy:'SAVED AUTHOR'}],activeLineIds:['truck'],ttnStatus:{}},{id:'archive-b',objectName:'OTHER SITE',date:'OTHER DATE',logs:[],activeLineIds:[],ttnStatus:{}}];
  png.c.state.truckStatus={truck:{ttnStatus:true,arriveStatus:'LIVE ARRIVAL'}};
  png.c.openArchiveModal('archive-a');
  let releaseFonts;png.c.document.fonts.ready=new Promise(resolve=>{releaseFonts=resolve;});
  const download=png.c.exportArchivePNG();
  png.c.state.archive[0].objectName='MUTATED SITE';png.c.state.archive[0].logs=[];
  png.c.openArchiveModal('archive-b');releaseFonts();await download;
  assert.equal(png.paperFixture.downloads[0].filename,'SAVED SITE_SAVED DATE.png','final PNG handler freezes selected date before await');
  const captured=png.paperFixture.captures[0];assert(captured.html.includes('SAVED TRUCK'));assert(captured.html.includes('SAVED AUTHOR'));
  assert(!captured.html.includes('LIVE DIRECTORY'));assert(!captured.html.includes('LIVE ARRIVAL'));assert(!captured.html.includes('OTHER SITE'));assert(!captured.html.includes('MUTATED SITE'));
  assert(captured.html.includes('title="Дубликат" aria-label="Дубликат">D</span>'),'final PNG uses archived missing-TTN D, not live TTN');
  assert.equal(captured.options.html2canvas.width,1400);assert.equal(captured.options.html2canvas.height,1000);assert.equal(captured.options.pagebreak.mode.length,0);
  assert.equal(png.paperFixture.saveButton.disabled,false);assert.equal(png.c.document.body.children.length,0);assert.equal(png.writes.length,0,'paper snapshot/PNG never writes records');
  console.log('PASS effective TEST handlers: manifest-loaded delete override keeps transaction/freeze/conflict/permission/account guards; no rollback resurrection; wrapped save preserves core behavior; final shared archive PNG override preserves selected snapshot/TTN, saved identity and full-sheet capture');
})().catch(e=>{console.error(e);process.exitCode=1;});
