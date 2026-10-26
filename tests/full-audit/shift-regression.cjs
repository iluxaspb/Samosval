const assert=require('node:assert/strict');
const {fixture,clone,path,shiftPath}=require('./shift-harness.cjs');
const tests=[];
const test=(name,fn)=>tests.push({name,fn});
const archive=(count=5)=>({sourceShiftId:'old',objectName:'Quarry',objectId:'o1',date:'24.10.2026',closedAt:90000,closedBy:'Operator',activeLineIds:['t1'],ttnStatus:{t1:'pending'},totalTrips:count,totalVolume:count*12,
  logs:Array.from({length:count},(_,i)=>({id:'old'+i,truckId:'t1',truckName:'Truck',volume:12,timestamp:10000+i*100,arrivalTimestamp:9990+i*100,returnedAt:10090+i*100,timeStr:'12:00',createdBy:'Author',createdByEmail:'author@example.test',isGAI:false,comment:'kept '+i}))});
const prepareRestore=(opts={},count=5)=>{const env=fixture({active:false,...opts});env.seed('archive','a1',archive(count));env.sync();return env;};
const assertHistory=env=>{
  for(const commit of env.commits){
    assert.equal(commit.history.length,1,'Each mutation is atomic with an actual history record');
    const ops=commit.history[0].data.history.operations;
    assert.equal(ops.length,commit.business.length);
    if(env.options.role&&env.options.role!=='admin')assert(ops.length<=4);
  }
};

test('Close: freezes server state, captures a new confirmation-window trip, chunks 522 trips and history, no MAX/photo waits',async()=>{
  const env=fixture({count:521,onConfirm:e=>e.seed('logs','late',e.log(900))});await env.close();
  assert.deepEqual(env.errors,[]);assert.equal(env.read('shift','current'),undefined);
  const saved=env.read('archive','closed_s1');assert.equal(saved.logs.length,522);assert.equal(saved.totalVolume,522*12);assert(saved.logs.some(log=>log.id==='late'));
  assert.equal(env.selected('logs','s1').length,0);assert(env.read('logs','foreign'));assert(env.read('truckStatus','foreign'));
  assert.equal(env.stats().maxCalls,0);assert(env.events.indexOf('freeze')<env.events.indexOf('archive'));assert(env.events.indexOf('archive')<env.events.indexOf('cleanup'));
  assert(env.commits.every(commit=>commit.business.length<=20));assertHistory(env);
});
test('Close: partial cleanup failure preserves complete archive and retry resumes once, including actual history wrapper',async()=>{
  const env=fixture({count:55,failCleanupChunk:2});await env.close();
  assert.equal(env.errors.length,1);assert.equal(env.read('archive','closed_s1').logs.length,55);assert.equal(env.selected('logs','s1').length,35);
  assert.equal(env.read('shift','current').closing,true);assert.equal(env.read('shift','current').isActive,false);
  await env.close();assert.equal(env.read('shift','current'),undefined);assert.equal(env.stats().archiveSets,1);assert.equal(env.read('archive','closed_s1').logs.length,55);assertHistory(env);
});
test('Close: concurrent archive is never overwritten by a partial snapshot',async()=>{
  let injected=false;
  const env=fixture({count:7,afterOutsideRead:(p,e)=>{
    if(injected||p!==path('archive','closed_s1'))return;injected=true;
    e.seed('archive','closed_s1',{...archive(7),sourceShiftId:'s1',logs:e.selected('logs','s1')});
    e.mutate(path('logs','l0'));e.mutate(path('logs','l1'));
  }});await env.close();assert.deepEqual(env.errors,[]);assert.equal(env.stats().archiveSets,0);assert.equal(env.read('archive','closed_s1').logs.length,7);assert.equal(env.read('shift','current'),undefined);
});
test('Close: archive failure keeps every live trip; non-admin retry respects four-write history limit',async()=>{
  const env=fixture({count:31,failArchive:true,role:'foreman'});await env.close();assert.equal(env.selected('logs','s1').length,31);assert.equal(env.stats().cleanupCount,0);assert(env.read('shift','current').closing);
  await env.close();assert.equal(env.read('shift','current'),undefined);assert(env.commits.every(commit=>commit.business.length<=4));assertHistory(env);
});
test('Close: queue, foreign archive and edited archived trip all block cleanup',async()=>{
  const pending=fixture({pending:1});await pending.close();assert.equal(pending.stats().confirms,0);assert.equal(pending.commits.length,0);
  const foreign=fixture();foreign.seed('archive','closed_s1',{sourceShiftId:'other',logs:[]});await foreign.close();assert.equal(foreign.stats().cleanupCount,0);assert.equal(foreign.selected('logs','s1').length,3);
  const edited=fixture({failCleanupChunk:1});await edited.close();edited.seed('logs','l0',{...edited.read('logs','l0'),volume:99});await edited.close();assert.equal(edited.selected('logs','s1').length,3);assert.match(edited.errors.at(-1),/изменён после архивации/);
});
test('Close: empty shift has a durable archive without creating photo metadata or reading removed photo APIs',async()=>{
  const env=fixture({count:0});await env.close();assert.deepEqual(env.errors,[]);assert.equal(env.read('archive','closed_s1').logs.length,0);assert.equal(env.read('archive','closed_s1').photoShiftIds,undefined);assert.equal(env.read('shift','current'),undefined);
});
test('Close: replacement shift between cleanup snapshot and transaction is never deleted',async()=>{
  let injected=false;
  const env=fixture({afterCollectionRead:(name,e)=>{
    // First status read is for archive. Replacement happens during the later cleanup read.
    if(name!=='truckStatus'||!e.read('archive','closed_s1')||injected)return;injected=true;
    e.seed('shift','current',{id:'new-shift',isActive:true});e.seed('truckStatus','t1',{id:'t1',shiftId:'new-shift',onLine:true});
  }});await env.close();assert.equal(env.read('shift','current').id,'new-shift');assert.equal(env.read('truckStatus','t1').shiftId,'new-shift');assert(env.errors.some(message=>message.includes('Новая смена не затронута')));
});
test('Close: optimistic conflict retries protect a status replaced while cleanup commits',async()=>{
  let injected=false;
  const env=fixture({beforeCommit:(commit,e)=>{
    if(injected||!commit.writes.some(write=>write.method==='delete'&&write.path===path('truckStatus','t1')))return;
    injected=true;e.seed('shift','current',{id:'new-shift',isActive:true});e.seed('truckStatus','t1',{id:'t1',shiftId:'new-shift',onLine:true});
  }});await env.close();assert(env.events.includes('conflict-retry'));assert.equal(env.read('truckStatus','t1').shiftId,'new-shift');assert.equal(env.read('shift','current').id,'new-shift');
});
test('Start: stale local state cannot overwrite an existing shift; orphan logs are preserved',async()=>{
  const blocked=fixture();blocked.ctx.state.shift=null;await blocked.ctx.startShiftWithObject('New','o2');assert.equal(blocked.read('shift','current').id,'s1');assert.equal(blocked.selected('logs','s1').length,3);assert.equal(blocked.commits.length,0);
  const clean=fixture({active:false});await clean.ctx.startShiftWithObject('New','o2');assert(clean.read('shift','current').isActive);assert(clean.read('logs','foreign'));assertHistory(clean);
});
test('Restore: active/closing/another restoring shift and pending offline operations never destroy current data',async()=>{
  for(const fields of [{isActive:true},{isActive:false,closing:true},{isActive:false,restoring:true,restoredFrom:'other'}]){
    const env=prepareRestore();env.seed('shift','current',{id:'existing',...fields});await env.restore();assert.equal(env.read('shift','current').id,'existing');assert(env.read('archive','a1'));assert.equal(env.commits.length,0);
  }
  const pending=prepareRestore({pending:1});await pending.restore();assert.equal(pending.commits.length,0);assert(pending.read('archive','a1'));
});
test('Restore: 523 trips are restored while frozen, then atomically activated with archive deletion; timing, pending TTN and history preserved',async()=>{
  const env=prepareRestore({},523);await env.restore();assert.deepEqual(env.errors,[]);
  const restored=env.read('shift','current');assert(restored.isActive);assert.equal(restored.restoring,false);assert.equal(env.read('archive','a1'),undefined);
  const logs=env.selected('logs',restored.id);assert.equal(logs.length,523);assert.equal(logs[0].arrivalTimestamp,9990);assert.equal(logs[0].returnedAt,10090);assert.equal(logs[0].createdByEmail,'author@example.test');
  const status=env.read('truckStatus','t1');assert.equal(status.ttnStatus,'pending');assert.equal(status.ttnLogId,null);assert.equal(status.lastLoadLogId,'restored_a1_522');assert.equal(status.arriveTimestamp,62290);assert.equal(status.loadedAfterArrive,false);
  assert.deepEqual(restored.photoShiftIds,['old']);assert(env.read('logs','foreign'));assert(env.read('truckStatus','foreign'));
  const final=env.commits.at(-1).business;assert.equal(final.length,2);assert(final.some(write=>write.method==='update'&&write.data.isActive));assert(final.some(write=>write.method==='delete'&&write.path===path('archive','a1')));
  assert(env.commits.every(commit=>commit.business.length<=20));assertHistory(env);
});
test('Restore: partial failure leaves original archive and frozen shift; retry uses identical IDs and skips existing records',async()=>{
  const env=prepareRestore({role:'foreman',failRestoreChunk:2},23);await env.restore();assert.equal(env.errors.length,1);assert(env.read('archive','a1'));assert(env.read('shift','current').restoring);assert.equal(env.read('shift','current').isActive,false);
  const partial=env.selected('logs','restored_a1');assert.equal(partial.length,4);const first=clone(partial[0]);
  const commitsBefore=env.commits.length;await env.restore();assert.equal(env.read('archive','a1'),undefined);assert.equal(env.selected('logs','restored_a1').length,23);assert.deepEqual(env.read('logs',first.id),Object.fromEntries(Object.entries(first).filter(([key])=>key!=='id')));
  const retriedWrites=env.commits.slice(commitsBefore).flatMap(commit=>commit.business);assert(!retriedWrites.some(write=>write.path===path('logs',first.id)),'archive_edit-only retry must not update existing logs');assertHistory(env);
});
test('Restore: failed activation keeps complete archive and frozen set; retry activates without duplicating data',async()=>{
  const env=prepareRestore({failFinalRestore:true},8);await env.restore();assert(env.read('archive','a1'));assert.equal(env.selected('logs','restored_a1').length,8);assert.equal(env.read('shift','current').isActive,false);
  await env.restore();assert.equal(env.read('archive','a1'),undefined);assert.equal(env.selected('logs','restored_a1').length,8);assert.equal(env.read('shift','current').isActive,true);assertHistory(env);
});
test('Restore: source changes after a partial restore block mixed data and preserve the original archive',async()=>{
  const env=prepareRestore({failRestoreChunk:2},30);await env.restore();const edited=env.read('archive','a1');edited.logs[0].volume=999;env.seed('archive','a1',edited);
  await env.restore();assert.equal(env.read('archive','a1').logs[0].volume,999);assert.equal(env.read('logs','restored_a1_0').volume,12);assert.equal(env.read('shift','current').isActive,false);assert.match(env.errors.at(-1),/Архив изменён/);
});
test('Restore: source mutation during final transaction forces retry and prevents archive deletion/activation',async()=>{
  let changed=false;
  const env=prepareRestore({beforeCommit:(commit,e)=>{
    if(changed||!commit.writes.some(write=>write.path===path('archive','a1')&&write.method==='delete'))return;changed=true;
    const data=e.read('archive','a1');data.objectName='Updated on another device';e.seed('archive','a1',data);
  }},3);await env.restore();assert(env.events.includes('conflict-retry'));assert(env.read('archive','a1'));assert.equal(env.read('shift','current').isActive,false);assert.match(env.errors.at(-1),/архив изменился/);
});
test('Restore: foreign status collision is retained; close/start cannot interfere with an unfinished restore',async()=>{
  const env=prepareRestore();env.seed('truckStatus','t1',{id:'t1',shiftId:'foreign-shift',onLine:true});await env.restore();assert.equal(env.read('truckStatus','t1').shiftId,'foreign-shift');assert(env.read('archive','a1'));assert(env.read('shift','current').restoring);
  const before=env.commits.length;await env.close();await env.ctx.startShiftWithObject('new','o2');assert.equal(env.commits.length,before);assert.equal(env.read('shift','current').id,'restored_a1');
});
test('Restore: stored truck state remaps log references and preserves returned trip, off-line truck and photo ancestry',async()=>{
  const env=prepareRestore({},2),source=env.read('archive','a1');source.photoShiftIds=['grandparent','old'];source.activeLineIds=[];source.truckStatuses={t1:{onLine:false,arriveStatus:'12:31',arriveTimestamp:15000,arriveBy:'Driver',ttnStatus:true,ttnLogId:'old1',ttnBy:'Dispatcher',lastLoadLogId:'old1',lastLoadTimestamp:10100,lastLoadBy:'Author',cycleRevision:6,ttnRevision:2,loadedAfterArrive:false}};env.seed('archive','a1',source);
  await env.restore();assert.deepEqual(env.errors,[]);const status=env.read('truckStatus','t1');assert.equal(status.onLine,false);assert.equal(status.ttnLogId,'restored_a1_1');assert.equal(status.lastLoadLogId,'restored_a1_1');assert.equal(status.arriveTimestamp,15000);assert.equal(status.cycleRevision,6);assert.deepEqual(env.read('shift','current').photoShiftIds,['grandparent','old']);
});
test('Concurrent restore: two devices converge on one set of records and one atomic activation',async()=>{
  const env=prepareRestore({},35),second=env.makeContext();await Promise.all([env.restore('a1'),env.restore('a1',second)]);
  assert.equal(env.read('archive','a1'),undefined);assert.equal(env.read('shift','current').isActive,true);assert.equal(env.selected('logs','restored_a1').length,35);
  assert.equal(env.events.filter(event=>event==='activate').length,1);assertHistory(env);
});
test('Restore: malformed archive is rejected before reserving or mutating the workspace',async()=>{
  const env=prepareRestore();const data=env.read('archive','a1');data.logs[1].truckId='bad/id';env.seed('archive','a1',data);await env.restore();assert.equal(env.commits.length,0);assert.equal(env.read('shift','current'),undefined);assert(env.read('archive','a1'));
});

test('Concurrent close: two devices produce one full archive and finish without overwriting each other',async()=>{
  const env=fixture({count:75}),second=env.makeContext();await Promise.all([env.close(),env.close(second)]);
  assert.deepEqual(env.errors,[]);assert.equal(env.read('shift','current'),undefined);assert.equal(env.stats().archiveSets,1);assert.equal(env.read('archive','closed_s1').logs.length,75);assertHistory(env);
});
test('Close: a trip written after the archive read is retained and blocks destructive cleanup',async()=>{
  let changed=false;
  const env=fixture({afterCollectionRead:(name,e)=>{
    if(changed||name!=='logs'||!e.read('archive','closed_s1'))return;changed=true;
    e.seed('logs','l0',{...e.read('logs','l0'),volume:999});
  }});await env.close();assert.equal(env.read('logs','l0').volume,999);assert.equal(env.read('archive','closed_s1').logs.find(log=>log.id==='l0').volume,12);assert(env.read('shift','current').closing);assert.equal(env.stats().cleanupCount,0);
});
test('Archive deletion: source archives required by close/restore are protected; regular delete and trash save are atomic',async()=>{
  for(const shift of [{id:'s1',isActive:false,closing:true,closeArchiveId:'a1'},{id:'restored_a1',isActive:false,restoring:true,restoredFrom:'a1'}]){
    const env=prepareRestore();env.seed('shift','current',shift);env.sync();env.ctx.viewingArchiveId='a1';await env.ctx.deleteArchiveShift();assert(env.read('archive','a1'));assert.equal(env.selected('trash').length,0);assert.equal(env.commits.length,0);
  }
  const env=prepareRestore({role:'foreman'});env.ctx.viewingArchiveId='a1';await env.ctx.deleteArchiveShift();assert.equal(env.read('archive','a1'),undefined);assert.equal(env.selected('trash').length,1);assert.equal(env.commits.length,1);assert.equal(env.commits[0].business.length,2);assertHistory(env);
});
test('Close: archive snapshot history size rejection leaves source trips intact',async()=>{
  const env=fixture({count:1});env.seed('logs','l0',{...env.read('logs','l0'),comment:'x'.repeat(900001)});await env.close();assert.equal(env.read('archive','closed_s1'),undefined);assert.equal(env.read('logs','l0').comment.length,900001);assert(env.read('shift','current').closing);assert.equal(env.stats().cleanupCount,0);assert.match(env.errors.at(-1),/слишком большое/);
});

test('Restore: concurrent trip removal conflicts with finalization and preserves the only full archive',async()=>{
  let removed=false;
  const env=prepareRestore({beforeCommit:(commit,e)=>{
    if(removed||!commit.writes.some(write=>write.path===path('archive','a1')&&write.method==='delete'))return;
    removed=true;e.mutate(path('logs','restored_a1_0'));
  }},4);await env.restore();assert(env.events.includes('conflict-retry'));assert(env.read('archive','a1'));assert.equal(env.read('shift','current').isActive,false);assert.match(env.errors.at(-1),/Восстановленные записи/);
  await env.restore();assert.equal(env.read('archive','a1'),undefined);assert.equal(env.selected('logs','restored_a1').length,4);assert.equal(env.read('shift','current').isActive,true);
});

test('Session change: close/restore stop between transactions instead of continuing as the next account',async()=>{
  const close=fixture({count:6,afterCommit:(commit,e)=>{if(commit.business.some(write=>write.path===path('archive','closed_s1')))e.ctx.currentUid='another-account';}});
  await close.close();assert(close.read('archive','closed_s1'));assert.equal(close.selected('logs','s1').length,6);assert(close.read('shift','current').closing);assert.match(close.errors.at(-1),/Учётная запись изменилась/);
  let changed=false;
  const restore=prepareRestore({role:'foreman',afterCommit:(commit,e)=>{if(!changed&&commit.business.some(write=>write.method==='set'&&write.path.startsWith(path('logs','restored_')))){changed=true;e.ctx.currentUid='another-account';}}},10);
  await restore.restore();assert(restore.read('archive','a1'));assert.equal(restore.selected('logs','restored_a1').length,4);assert.equal(restore.read('shift','current').isActive,false);assert.match(restore.errors.at(-1),/Учётная запись изменилась/);
});

(async()=>{let failed=0;for(const {name,fn} of tests){try{await fn();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name);console.error(error);}}console.log(`${tests.length-failed}/${tests.length} shift regressions passed`);if(failed)process.exitCode=1;})().catch(error=>{console.error(error);process.exitCode=1;});
