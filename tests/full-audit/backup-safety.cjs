'use strict';
const assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {harness,fixture,W,copy}=require('./backup-harness.cjs');
const pure=v=>JSON.parse(JSON.stringify(v));
async function saved(h){const m=await h.api.createBackup('manual','fixture');assert(m,h.errors.join('\n'));return m;}
async function noRestore(h,id,sections={base:true}){const before=h.live(),writes=h.liveWrites().length;assert.equal(await h.api.restoreBackup(id,sections),false);assert.deepEqual(h.live(),before);assert.equal(h.liveWrites().length,writes);}
function rewrite(h,m,change){const prefix='backups/'+m.id+'/chunks/';const json=[...h.values].filter(([p])=>p.startsWith(prefix)).sort((a,b)=>a[1].idx-b[1].idx).map(([,v])=>v.data).join('');const payload=JSON.parse(json);change(payload);const text=JSON.stringify(payload);for(const [p]of h.values)if(p.startsWith(prefix))h.values.delete(p);h.values.set(prefix+'0',{idx:0,data:text});const meta=h.values.get('backups/'+m.id);Object.assign(meta,{chunkCount:1,sizeBytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')});}
(async()=>{
  let cases=0;
  for(const path of ['settings/permissions','settings/appConfig','settings/appConfig_test',W+'shift/current',...['audit','timesheetPeople','timesheetEquipment','timesheetEntries','timesheetMaterials','timesheetChanges'].map(n=>W+n)]){
    const h=harness();h.fail.read=p=>p===path;
    assert.equal(await h.api.createBackup('manual','denied'),null,path);assert.equal(h.metas().length,0);assert.equal(h.liveWrites().length,0);assert(!h.toasts.some(t=>t.includes('Бэкап проверен')));cases++;
  }
  for(const flag of ['fromCache','hasPendingWrites']){
    const h=harness();h.fail.metadata=p=>p===W+'trucks'?{[flag]:true}:{};
    assert.equal(await h.api.createBackup('manual','unconfirmed'),null);assert.equal(h.metas().length,0);cases++;
  }
  for(const mutate of [
    p=>delete p.data.appConfig,
    p=>p.data.trucks.push(p.data.trucks[0]),
    p=>p.data.trucks[0].id='bad/id',
    p=>p.data.trucks[0].data.extra='unaccounted field',
    p=>p.manifest.permissions.count=0,
    p=>p.manifest.appConfig.status='missing',
    p=>p.data.shift[0].id='wrong',
    p=>p.data.appConfig_test[0].data.clock.nanoseconds=1000000000,
    p=>p.complete=false,
    p=>p.exclusions=[],
    p=>p.data.audit=null,
    p=>p.data.unexpected=[],
    p=>p.version=999
  ]){const h=harness(),m=await saved(h);rewrite(h,m,mutate);await noRestore(h,m.id);assert.equal(h.transactions(),0);cases++;}
  for(const mutate of [
    (h,m)=>h.values.delete('backups/'+m.id+'/chunks/0'),
    (h,m)=>h.values.get('backups/'+m.id+'/chunks/0').idx=4,
    (h,m)=>h.values.get('backups/'+m.id+'/chunks/0').data=h.values.get('backups/'+m.id+'/chunks/0').data.replace('Объект','объект'),
    (h,m)=>h.values.get('backups/'+m.id).sizeBytes++,
    (h,m)=>h.values.get('backups/'+m.id).counts.trucks++,
    (h,m)=>h.values.get('backups/'+m.id).complete=false
  ]){const h=harness(),m=await saved(h);mutate(h,m);await noRestore(h,m.id);cases++;}
  for(const category of ['audit','timesheet']){const h=harness(),m=await saved(h);await noRestore(h,m.id,{[category]:true});assert(h.errors.at(-1).includes('миграция'));cases++;}
  {
    const h=harness(),m=await saved(h);h.values.set(W+'trucks/one',{newer:true});
    h.fail.read=p=>p==='settings/permissions';await noRestore(h,m.id);
    assert.equal(h.transactions(),0,'pre-restore copy failure blocks writes');assert(h.errors.at(-1).includes('Защитная копия'));cases++;
  }
  {
    const h=harness(),m=await saved(h);h.values.set(W+'trucks/one',{newer:true});
    h.fail.write=p=>p.startsWith('backups/')&&p.includes('/chunks/');await noRestore(h,m.id);
    assert.equal(h.transactions(),0,'safety-copy write failure blocks writes');cases++;
  }
  {
    const h=harness(),m=await saved(h);h.values.set(W+'trucks/one',{newer:true});h.values.set(W+'objects/one',{newer:true});
    h.fail.write=p=>p===W+'objects/one';await noRestore(h,m.id);
    assert.equal(h.transactions(),1);assert(h.metas().some(([,v])=>v.type==='before_restore'&&v.important));cases++;
  }
  {
    const h=harness(),m=await saved(h);h.values.set(W+'trucks/one',{before:'newer'});
    h.fail.transaction=()=>h.values.set(W+'trucks/one',{concurrent:'do not overwrite'});
    assert.equal(await h.api.restoreBackup(m.id,{base:true}),false);
    assert.deepEqual(h.values.get(W+'trucks/one'),{concurrent:'do not overwrite'});assert.equal(h.liveWrites().length,0);cases++;
  }
  {
    const h=harness(),m=await saved(h);h.values.set(W+'trucks/one',{before:'newer'});h.fail.afterCommit=true;
    assert.equal(await h.api.restoreBackup(m.id,{base:true}),false);
    assert.equal(h.transactions(),1,'ambiguous acknowledgement must not trigger application retry');
    assert(h.errors.at(-1).includes('не подтверждён'));assert(!h.toasts.some(t=>t.includes('Восстановлено атомарно')));cases++;
  }
  {
    const h=harness(),m=await saved(h);for(let i=0;i<401;i++)h.values.set(W+'trucks/large-'+i,{i});
    await noRestore(h,m.id);assert(h.errors.at(-1).includes('400'));assert.equal(h.transactions(),0);cases++;
  }
  {
    const h=harness(),m=await saved(h);h.sandbox.currentUserRole='foreman';await noRestore(h,m.id);
    assert.equal(await h.api.createBackup('manual','wrong-role'),null);assert.equal(h.transactions(),0);cases++;
  }
  {
    const h=harness(),m=await saved(h);h.fail.beforeRead=p=>{if(p==='settings/permissions')h.sandbox.currentUid='different-admin';};
    await noRestore(h,m.id);assert.equal(h.transactions(),0);cases++;
  }
  {
    const h=harness();h.values.set('settings/appConfig',{unsupported:Infinity});
    assert.equal(await h.api.createBackup('manual','unsupported-type'),null);assert.equal(h.metas().length,0);cases++;
  }
  {
    const h=harness(),m=await saved(h);
    const first=h.api.restoreBackup(m.id,{base:true}), second=h.api.restoreBackup(m.id,{base:true});
    assert.equal(await second,false);assert.equal(await first,true);assert.equal(h.transactions(),1);cases++;
  }
  {
    const h=harness(),payload={version:1,data:{trucks:[],objects:[],archive:[],permissions:[],appConfig:[],appConfig_test:[],shift:[]}};
    const json=JSON.stringify(payload);h.values.set('backups/legacy',{id:'legacy',chunkCount:1,sizeBytes:Buffer.byteLength(json)});h.values.set('backups/legacy/chunks/0',{idx:0,data:json});
    assert.equal((await h.api.readBackupData('legacy',true)).version,1);
    await noRestore(h,'legacy',{settings:true,shift:true});assert.equal(h.transactions(),0);cases++;
  }
  for (const setup of [
    h=>h.sandbox.offlinePendingCount=()=>1,
    h=>h.sandbox.offlineJournalReadError='corrupt journal',
    h=>h.sandbox.offlinePendingCount=undefined,
    h=>h.sandbox.offlineUndeliveredEffects=()=>[{id:'pending-effect'}],
    h=>h.sandbox.offlineJournalCanWrite=()=>false,
    h=>h.sandbox.navigator.onLine=false,
    h=>h.sandbox.state.shift.isActive=true,
    h=>h.values.set(W+'shift/current',{id:'active',isActive:true})
  ]) {
    const h=harness(),m=await saved(h);setup(h);await noRestore(h,m.id);
    assert.equal(h.transactions(),0,'unsafe local/server state rejected before writes');cases++;
  }
  {
    const h=harness(),m=await saved(h);
    h.fail.beforeRead=p=>{if(p==='settings/permissions')h.sandbox.offlinePendingCount=()=>1;};
    await noRestore(h,m.id);assert.equal(h.transactions(),0,'queue rechecked after safety copy');cases++;
  }
  {
    const h=harness(),m=await saved(h);
    h.fail.transaction=()=>h.values.set(W+'shift/current',{id:'started-elsewhere',isActive:true});
    assert.equal(await h.api.restoreBackup(m.id,{base:true}),false);assert.equal(h.liveWrites().length,0);
    assert.equal(h.values.get(W+'shift/current').id,'started-elsewhere','active shift checked inside transaction');cases++;
  }
  for (const lifecycle of ['closing','restoring']) {
    const frozen = {id:'resumable-shift',isActive:false,[lifecycle]:true,
      ...(lifecycle==='closing'?{closeArchiveId:'reserved'}:{restoredFrom:'reserved'})};
    for (const scope of ['local','server']) for (const sections of [{archive:true},{shift:true}]) {
      const h=harness(),m=await saved(h);
      h.values.set(W+'archive/reserved',{sourceShiftId:'resumable-shift',logs:[{id:'already-cleaned',volume:20}]});
      h.values.set(W+'logs/partial',{shiftId:'resumable-shift',volume:10});
      if(scope==='local')h.sandbox.state.shift=copy(frozen);else h.values.set(W+'shift/current',copy(frozen));
      await noRestore(h,m.id,sections);
      assert.equal(h.transactions(),0,lifecycle+' '+scope+' blocked in preflight');
      assert(h.errors.at(-1).includes('ещё не завершено'));
      assert(h.values.has('backups/'+m.id),'existing recovery copy retained');cases++;
    }
    {
      const h=harness(),m=await saved(h);
      h.values.set(W+'archive/reserved',{sourceShiftId:'resumable-shift',logs:[{id:'already-cleaned',volume:20}]});
      h.values.set(W+'logs/partial',{shiftId:'resumable-shift',volume:10});
      const expected=h.live();expected.set(W+'shift/current',copy(frozen));
      h.fail.transaction=()=>h.values.set(W+'shift/current',copy(frozen));
      assert.equal(await h.api.restoreBackup(m.id,{archive:true,shift:true}),false);
      assert.deepEqual(h.live(),expected,'concurrent '+lifecycle+' is the only state change');
      assert.equal(h.liveWrites().length,0);assert.equal(h.transactions(),1);
      const safety=h.metas().find(([,v])=>v.type==='before_restore'&&v.important)?.[1];
      assert(safety,'already verified protective copy retained after lifecycle race');
      const payload=await h.api.readBackupData(safety.id);
      assert(payload.data.archive.some(row=>row.id==='reserved'));
      assert(payload.data.logs.some(row=>row.id==='partial'));
      assert(h.errors.at(-1).includes(safety.id));cases++;
    }
    {
      const h=harness(),m=await saved(h);let transactionStarted=false;
      h.values.set(W+'archive/reserved',{sourceShiftId:'resumable-shift',logs:[{id:'already-cleaned',volume:20}]});
      h.fail.transaction=()=>{transactionStarted=true;};
      h.fail.read=path=>{if(transactionStarted&&path===W+'archive/reserved')h.sandbox.state.shift=copy(frozen);return false;};
      await noRestore(h,m.id,{archive:true});
      assert.equal(h.transactions(),1,'late local lifecycle checked again after awaited transaction reads');
      assert(h.metas().some(([,v])=>v.type==='before_restore'&&v.important));cases++;
    }
  }
  console.log('PASS backup safety: '+cases+' adversarial cases; denied/cache reads, corruption, missing/duplicate/wrong chunks, mandatory safety copy, atomic permission rejection, large restore rejection, concurrent change/account switch, protected ledgers, legacy destructive restore blocked, local queue/corruption/ownership, active-shift and closing/restoring lifecycle guards rechecked; reserved archives/partial logs and safety copies preserved');
})().catch(e=>{console.error(e);process.exitCode=1;});
