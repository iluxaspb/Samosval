'use strict';
const assert=require('node:assert/strict');
const {harness,fixture,W}=require('./backup-harness.cjs');
(async()=>{
  let cases=0;
  for(const data of [
    null,{}, {trucks:{}}, {trucks:[{name:'missing-id'}]}, {trucks:[{id:'bad/id'}]},
    {trucks:[{id:'same'},{id:'same'}]}, {trucks:[{id:'valid'},null]},
    {trucks:[{id:'valid'}],archive:[{id:'../bad'}]},
    {trucks:[{id:'__forbidden__'}]}, {trucks:[{id:'bad',data:NaN}]},
    {format:'unknown',trucks:[]}, {format:'samosval-backup',version:999,trucks:[]},
    JSON.parse('{"trucks":[{"id":"safe","__proto__":{"polluted":true}}]}'),
    {trucks:Array.from({length:401},(_,i)=>({id:'item-'+i,name:'x'}))}
  ]){
    const h=harness(),before=h.live();await assert.rejects(()=>h.api.importRows(data));
    assert.deepEqual(h.live(),before);assert.equal(h.liveWrites().length,0);assert.equal(h.transactions(),0);cases++;
  }
  {
    const h=harness(),before=h.live();h.fail.read=p=>p===W+'timesheetChanges';
    await assert.rejects(()=>h.api.importRows({trucks:[{id:'one',name:'changed'}]}),/Защитная копия/);
    assert.deepEqual(h.live(),before);assert.equal(h.transactions(),0);cases++;
  }
  {
    const h=harness(),before=h.live();h.fail.write=p=>p===W+'objects/one';
    await assert.rejects(()=>h.api.importRows({trucks:[{id:'one',name:'changed'}],objects:[{id:'one',name:'changed'}]}));
    assert.deepEqual(h.live(),before);assert.equal(h.liveWrites().length,0);cases++;
  }
  {
    const h=harness();h.values.set(W+'trucks/keep',{name:'keep'});
    const result=await h.api.importRows({version:2.88,trucks:[{id:'one',name:'legacy'}]});
    assert.equal(result.written,1);assert.equal(h.values.get(W+'trucks/one').name,'legacy');assert(h.values.has(W+'trucks/keep'));
    assert(h.confirms[0].includes('Старые копии могли быть неполными'));assert(h.confirms[0].includes('ничего не удалит'));cases++;
  }
  {
    const h=harness(),meta=await h.api.createBackup('manual','fixture');
    const file=await h.api.fileEnvelope(await h.api.readBackupData(meta.id));file.payload.data.trucks[0].data.name='tampered';
    await assert.rejects(()=>h.api.importRows(file),/Контрольная сумма/);assert.equal(h.transactions(),0);cases++;
  }
  {
    const h=harness();let release;h.fail.confirm=()=>new Promise(r=>release=r);
    const first=h.api.importRows({trucks:[{id:'one',name:'cancel'}]});
    await assert.rejects(()=>h.api.importRows({trucks:[{id:'one',name:'second'}]}),/Другая операция/);
    release(false);assert.equal(await first,null);assert.equal(h.transactions(),0);
    h.fail.confirm=null;assert(await h.api.importRows({trucks:[{id:'one',name:'after cancel'}]}));cases++;
  }
  {
    const h=harness();const ev={target:{files:[{text:async()=>'{broken'}],value:'selected'}};
    await h.sandbox.importBackupFile(ev);assert.equal(ev.target.value,'');assert(h.errors.length);assert.equal(h.transactions(),0);cases++;
  }
  {
    const h=harness();h.sandbox.SamosvalBackup=null;await h.sandbox.exportBackupFile();assert.equal(h.downloads.length,0);assert(h.errors.at(-1).includes('ещё не готов'));cases++;
  }
  {
    const h=harness();h.sandbox.offlinePendingCount=()=>1;
    await assert.rejects(()=>h.api.importRows({trucks:[{id:'one',name:'blocked'}]}),/очереди/);
    assert.equal(h.transactions(),0);assert.equal(h.metas().length,0);cases++;
  }
  {
    const h=harness();h.fail.confirm=()=>{h.sandbox.offlineJournalReadError='corrupt';return true;};
    await assert.rejects(()=>h.api.importRows({trucks:[{id:'one',name:'blocked'}]}),/очереди/);
    assert.equal(h.transactions(),0);assert.equal(h.metas().length,0);cases++;
  }
  {
    const h=harness();h.fail.beforeRead=p=>{if(p==='settings/permissions')h.sandbox.offlinePendingCount=()=>2;};
    await assert.rejects(()=>h.api.importRows({trucks:[{id:'one',name:'blocked'}]}),/очереди/);
    assert.equal(h.transactions(),0);assert.equal(h.liveWrites().length,0);cases++;
  }
  {
    const h=harness();let release;h.fail.confirm=()=>new Promise(r=>release=r);
    const first=h.api.importRows({trucks:[{id:'one',name:'cancel'}]});
    await assert.rejects(()=>h.api.exportFileData(),/Другая операция/);
    release(false);await first;cases++;
  }
  for (const lifecycle of ['closing','restoring']) {
    const frozen={id:'resumable-shift',isActive:false,[lifecycle]:true,
      ...(lifecycle==='closing'?{closeArchiveId:'reserved'}:{restoredFrom:'reserved'})};
    for (const scope of ['local','server']) {
      const h=harness();
      h.values.set(W+'archive/reserved',{sourceShiftId:'resumable-shift',logs:[{id:'already-cleaned',volume:20}]});
      h.values.set(W+'logs/partial',{shiftId:'resumable-shift',volume:10});
      if(scope==='local')h.sandbox.state.shift={...frozen};else h.values.set(W+'shift/current',{...frozen});
      const before=h.live();
      await assert.rejects(()=>h.api.importRows({archive:[{id:'reserved',logs:[]}]}),/ещё не завершено/);
      assert.deepEqual(h.live(),before,'merge import cannot overwrite '+lifecycle+' source');
      assert.equal(h.liveWrites().length,0);assert.equal(h.transactions(),0);cases++;
    }
    {
      const h=harness();
      h.values.set(W+'archive/reserved',{sourceShiftId:'resumable-shift',logs:[{id:'already-cleaned',volume:20}]});
      h.values.set(W+'logs/partial',{shiftId:'resumable-shift',volume:10});
      const expected=h.live();expected.set(W+'shift/current',{...frozen});
      h.fail.transaction=()=>h.values.set(W+'shift/current',{...frozen});
      await assert.rejects(()=>h.api.importRows({trucks:[{id:'one',name:'must remain unchanged'}],archive:[{id:'reserved',logs:[]}]}),/ещё не завершено/);
      assert.deepEqual(h.live(),expected,'concurrent '+lifecycle+' is the only state change');
      assert.equal(h.liveWrites().length,0);assert.equal(h.transactions(),1);
      assert(h.calls.some(c=>c[0]==='transaction-read'&&c[1]===W+'shift/current'),'merge transaction reads lifecycle guard');
      const safety=h.metas().find(([,v])=>v.type==='before_restore'&&v.important)?.[1];assert(safety);
      const payload=await h.api.readBackupData(safety.id);
      assert(payload.data.archive.some(row=>row.id==='reserved'&&row.data.logs.length===1));
      assert(payload.data.logs.some(row=>row.id==='partial'));cases++;
    }
    {
      const h=harness();let transactionStarted=false;
      h.values.set(W+'archive/reserved',{sourceShiftId:'resumable-shift',logs:[{id:'already-cleaned',volume:20}]});
      const before=h.live();
      h.fail.transaction=()=>{transactionStarted=true;};
      h.fail.read=path=>{if(transactionStarted&&path===W+'archive/reserved')h.sandbox.state.shift={...frozen};return false;};
      await assert.rejects(()=>h.api.importRows({archive:[{id:'reserved',logs:[]}]}),/ещё не завершено/);
      assert.deepEqual(h.live(),before);assert.equal(h.liveWrites().length,0);assert.equal(h.transactions(),1);
      assert(h.metas().some(([,v])=>v.type==='before_restore'&&v.important));cases++;
    }
  }
  {
    const h=harness();h.sandbox.state.shift={id:'active',isActive:true};h.values.set(W+'shift/current',{id:'active',isActive:true});
    const result=await h.api.importRows({trucks:[{id:'one',name:'safe merge during ordinary active shift'}]});
    assert.equal(result.written,1);assert.equal(h.values.get(W+'shift/current').isActive,true);
    assert(h.calls.some(c=>c[0]==='transaction-read'&&c[1]===W+'shift/current'));cases++;
  }
  // UTF-8 chunking and partial-publication failure. Under one Firestore source-document limit.
  const input=fixture();input.set(W+'trucks/large',{text:'я😀'.repeat(150000)});
  {
    const h=harness(input),m=await h.api.createBackup('manual','unicode');assert(m,h.errors.join('\n'));
    const chunks=[...h.values].filter(([p])=>p.startsWith('backups/'+m.id+'/chunks/')).sort((a,b)=>a[1].idx-b[1].idx);
    assert(chunks.length>=2);for(const [,row]of chunks)assert(Buffer.byteLength(row.data,'utf8')<=700000);
    const payload=await h.api.readBackupData(m.id);assert.equal(payload.data.trucks.find(r=>r.id==='large').data.text,input.get(W+'trucks/large').text);cases++;
  }
  {
    const h=harness(input);h.fail.write=p=>p.endsWith('/chunks/1');
    assert.equal(await h.api.createBackup('manual','partial'),null);assert.equal(h.metas().length,0);assert.equal([...h.values].filter(([p])=>p.startsWith('backups/')).length,0);
    assert(!h.toasts.some(t=>t.includes('Бэкап проверен')));cases++;
  }
  {
    const h=harness();h.fail.beforeRead=p=>{if(/^backups\/[^/]+\/chunks$/.test(p)){const row=h.values.get(p+'/0');if(row)row.idx=999;}};
    assert.equal(await h.api.createBackup('manual','bad-readback'),null);assert.equal(h.metas().length,0);assert.equal(h.transactions(),0);cases++;
  }
  console.log('PASS backup files/chunks: '+cases+' cases; upfront row validation, no partial imports, legacy explicit merge, file SHA-256, cancellation/repeated-click lock, missing module, Unicode chunks <=700KB, incomplete write/readback never reported successful, closing/restoring sources and verified safety copies preserved in merge-import races');
})().catch(e=>{console.error(e);process.exitCode=1;});
