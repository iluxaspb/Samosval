'use strict';
const assert=require('node:assert/strict');
const {harness,fixture,W,Timestamp,copy}=require('./backup-harness.cjs');
(async()=>{
  const h=harness(), original=h.live();
  const meta=await h.api.createBackup('manual','Test full backup');
  assert(meta,h.errors.join('\n'));
  const payload=await h.api.readBackupData(meta.id);
  assert.equal(payload.version,2);
  assert.equal(Object.keys(payload.data).length,20);
  for(const name of ['permissions','appConfig','appConfig_test','shift']) assert.equal(payload.data[name].length,1,'critical document captured: '+name);
  for(const name of ['timesheetPeople','timesheetEquipment','timesheetEntries','timesheetMaterials','timesheetChanges']) {
    assert.equal(payload.data[name].length,1);
    assert.equal(payload.data[name][0].data.committedAt.nanoseconds,987654321);
    assert.equal(payload.data[name][0].data.committedAt.__backupType,'timestamp');
    assert.equal(payload.manifest[name].count,1);
    assert.equal(payload.manifest[name].fields,7);
  }
  assert.equal(payload.data.audit.length,701,'game economics and receipts never truncated to 500');
  assert.equal(meta.counts.audit,701);
  assert(payload.exclusions.includes('photo-jpeg-binaries'));
  assert(payload.exclusions.includes('photo-metadata-and-counters'));
  assert.equal(payload.manifest.permissions.fields,3);
  for(const [path] of original) if(!path.includes('/timesheet')&&!path.includes('/audit/')) h.values.set(path,{changed:true});
  h.values.set(W+'trucks/extra',{new:true});
  h.values.set(W+'audit/newer',{eventType:'game_purchase',price:25});
  h.values.set(W+'timesheetEntries/newer',{minutes:1440});
  assert.equal(await h.api.restoreBackup(meta.id,{base:true,archive:true,settings:true,users:true,shift:true}),true,h.errors.join('\n'));
  for(const [path,value] of original) assert.deepEqual(h.values.get(path),value,'full field roundtrip: '+path);
  assert(!h.values.has(W+'trucks/extra'));
  assert(h.values.has(W+'audit/newer'),'later game receipt preserved');
  assert(h.values.has(W+'timesheetEntries/newer'),'later ledger entry preserved');
  assert(h.values.get('settings/appConfig_test').clock instanceof Timestamp);
  const safety=h.metas().find(([,v])=>v.type==='before_restore')[1];
  assert(safety.important,'safety copy protected from rotation');
  assert.equal((await h.api.readBackupData(safety.id)).data.trucks.find(r=>r.id==='extra').data.new,true);
  assert.equal(h.transactions(),1,'all selected sections written atomically, never independent batches');

  const empty=fixture();empty.delete('settings/appConfig_test');
  const missing=harness(empty), missingMeta=await missing.api.createBackup('manual','missing document');
  const missingPayload=await missing.api.readBackupData(missingMeta.id);
  assert.equal(missingPayload.manifest.appConfig_test.status,'missing');
  missing.values.set('settings/appConfig_test',{new:true});
  assert(await missing.api.restoreBackup(missingMeta.id,{settings:true}));
  assert(!missing.values.has('settings/appConfig_test'),'explicit validated absence, unlike failed reads, may be restored');

  const file=await h.api.fileEnvelope(payload);
  assert.equal(file.sha256.length,64);
  const imported=harness();imported.values.set(W+'trucks/keep',{untouched:true});
  imported.values.set(W+'trucks/one',{preservedExtra:99});
  const result=await imported.api.importRows(JSON.parse(JSON.stringify(file)));
  assert.equal(result.written,3);
  assert.equal(imported.values.get(W+'trucks/one').preservedExtra,99,'file route retains merge semantics');
  assert.equal(imported.values.get(W+'trucks/one').name,payload.data.trucks[0].data.name);
  assert(imported.values.has(W+'trucks/keep'),'file import never deletes extras');
  assert(imported.confirms[0].includes('НЕ восстанавливаются'));
  assert.deepEqual(imported.values.get(W+'timesheetEntries/one'),original.get(W+'timesheetEntries/one'));

  await imported.sandbox.exportBackupFile();
  const blob=imported.downloads.find(v=>v instanceof Blob), exported=JSON.parse(await blob.text());
  assert.equal(exported.format,'samosval-backup-file');
  assert.equal(exported.payload.data.audit.length,701);
  assert(exported.payload.data.timesheetChanges.length);
  assert(imported.toasts.some(t=>t.includes('Фото')&&t.includes('НЕ включены')));
  console.log('PASS backup roundtrip: 20 sections, four critical documents, 701 audit events, five ledgers, field counts, Timestamp nanoseconds, atomic supported restore, protected ledgers, full checked file export/import');
})().catch(e=>{console.error(e);process.exitCode=1;});
