// Real lifecycle, queue, history recorder, coin calculator and undo. Local mocks only.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {integrated}=require('./receipt-history-integration.cjs');
const {clone}=require('./shift-harness.cjs');
const tests=[],test=(name,run)=>tests.push({name,run});
function setup(options={}){
 const x=integrated({role:'admin',...options});x.c.canAdmin=()=>true;
 let time=2000000;x.c.Date=class extends Date{static now(){return ++time;}};
 x.e.seed('objects','policy',{cycleMinutes:15,gameRewardSchedule:[{effectiveAt:1,load:5,arrive:7,ttn:3}]});
 x.e.seed('truckStatus','t1',{...x.e.read('truckStatus','t1'),arriveTimestamp:time-1000});
 x.tick=(ms=900001)=>{time+=ms;x.c.navigator.onLine=false;};
 x.project=()=>{x.e.sync();vm.runInContext('offlineRemoteStatuses={...state.truckStatus};offlineRemoteLogs=state.logs.slice();',x.c);};x.project();
 x.score=(filter={})=>x.c.window.__gameCoinsCore.calculate(x.records(),filter)[0]?.coins||0;
 x.loads=()=>x.totals()[0]?.loads||0;
 x.load=async()=>{x.c.navigator.onLine=false;const op=x.queue('load');await x.replay();return op;};
 x.reportDelete=async id=>{
  if(!x.c.commitReportLogChange)vm.runInContext(fs.readFileSync('test-app/src/core/13-reports.js','utf8'),x.c);
  const before=x.c.logEditSnapshot(x.e.read('logs',id));await x.c.commitReportLogChange(id,before,null);
 };
 return x;
}
const history=x=>x.records().filter(row=>row.eventType==='history');
test('Close and cleanup retry preserve frozen load reward; restore and reclose never mint or remove a second reward',async()=>{
 const x=setup({failCleanupChunk:1});const op=await x.load();assert.equal(x.score(),5);assert.equal(x.loads(),1);
 x.e.seed('objects','policy',{cycleMinutes:15,gameRewardSchedule:[{effectiveAt:1,load:99,arrive:99,ttn:99}]});
 await x.e.close();assert(x.e.read('shift','current').closing);assert.equal(x.score(),5);assert.equal(x.e.errors.length,1);
 await x.e.close();assert.equal(x.e.read('shift','current'),undefined);assert.equal(x.score(),5);assert.equal(x.loads(),1);
 const proofs=history(x).filter(row=>row.history.archiveCleanup);assert.equal(proofs.length,1);
 assert.deepEqual(proofs[0].history.archiveCleanup,{version:1,shiftId:'s1',archiveId:'closed_s1',logIds:[op.logId]});
 await x.e.restore('closed_s1');assert.equal(x.e.read('shift','current').isActive,true);assert.equal(x.score(),5);assert.equal(x.loads(),1);
 const restored=x.e.selected('logs','restored_closed_s1')[0];assert.equal(restored.gameRewardLogId,op.logId);assert.equal(restored.clientOperationId,undefined);
 x.project();await x.e.close();assert.equal(x.e.read('shift','current'),undefined);assert.equal(x.score(),5);assert.equal(x.loads(),1);
 assert.equal(x.e.read('archive','closed_restored_closed_s1').logs[0].gameRewardLogId,op.logId);
 assert.equal(x.score({shiftId:'s1'}),5);assert.equal(x.score({shiftId:'restored_closed_s1'}),0,'Original work retains its original shift scope');
 assert.equal(x.score({objectKey:'id:o1'}),5);
});
test('Partial multi-chunk cleanup preserves every load reward and resumes idempotently',async()=>{
 const x=setup({failCleanupChunk:2});
 for(let i=0;i<22;i++){
  if(i){x.tick();x.queue('arrive');await x.replay();}
  await x.load();
 }
 const before=x.score();assert.equal(x.loads(),22);
 await x.e.close();assert.equal(x.e.errors.length,1);assert.equal(x.e.selected('logs','s1').length,2);assert.equal(x.score(),before);assert.equal(x.loads(),22);
 await x.e.close();assert.equal(x.score(),before);assert.equal(x.loads(),22);assert.equal(x.e.selected('logs','s1').length,0);
 assert.equal(history(x).filter(row=>row.history.archiveCleanup).length,2);
});
test('Lost cleanup acknowledgement preserves archived rewards and retry never writes a second cleanup history',async()=>{
 let lose=true;
 const x=setup({afterCommit:async commit=>{if(lose&&commit.business.some(write=>write.method==='delete'&&write.path.includes('/logs/'))){lose=false;throw Error('lost cleanup acknowledgement');}}});
 await x.load();await x.e.close();assert.equal(x.e.errors.length,1);assert.equal(x.e.selected('logs','s1').length,0);assert.equal(x.score(),5);
 assert(x.e.read('archive','closed_s1'));await x.e.close();assert.equal(x.e.read('shift','current'),undefined);assert.equal(x.score(),5);
 assert.equal(history(x).filter(row=>row.history.archiveCleanup).length,1);
});
test('Close/restore retain TTN and return rewards without duplicates, repricing or cross-object leakage',async()=>{
 const x=setup();await x.load();x.tick();x.queue('arrive');await x.replay();x.c.navigator.onLine=false;x.queue('ttn');await x.replay();
 assert.equal(x.score(),15);const earned=clone(x.totals());await x.e.close();assert.deepEqual(clone(x.totals()),earned);
 await x.e.restore('closed_s1');assert.deepEqual(clone(x.totals()),earned);x.project();await x.e.close();assert.deepEqual(clone(x.totals()),earned);
 await x.c.startShiftWithObject('Second object','o2');const second=x.c.state.shift.id;
 x.e.seed('truckStatus','t1',{id:'t1',onLine:true,shiftId:second,cycleRevision:0,ttnRevision:0,arriveStatus:'12:00',arriveTimestamp:1000,loadedAfterArrive:false});x.project();await x.load();
 assert.equal(x.score(),20);assert.equal(x.score({shiftId:'s1'}),15);assert.equal(x.score({shiftId:second}),5);assert.equal(x.score({objectKey:'id:o1'}),15);assert.equal(x.score({objectKey:'id:o2'}),5);
 await x.e.close();assert.equal(x.score(),20);assert.equal(x.score({objectKey:'id:o2'}),5);
});
test('Deleting restored trip removes its original load reward; history undo/redo preserves attribution and charges one penalty',async()=>{
 const x=setup();const op=await x.load();await x.e.close();await x.e.restore('closed_s1');x.project();
 const restored=x.e.selected('logs','restored_closed_s1')[0];await x.reportDelete(restored.id);assert.equal(x.score(),0);assert.equal(x.loads(),0);
 const deletion=history(x).find(row=>row.history.operations.some(o=>o.collection==='logs'&&o.id===restored.id&&!o.after)).history;
 assert.equal(deletion.archiveCleanup,undefined);
 x.c.window.__setGameTestRecords(x.records());await x.c.applyHistoryOperations(deletion.operations,'before',deletion);
 assert.equal(x.score(),2,'Original five coins restored, with one three-coin undo penalty');assert.equal(x.loads(),1);
 const undone=x.e.read('audit',deletion.id).history;
 await assert.rejects(()=>x.c.applyHistoryOperations(deletion.operations,'before',deletion),/уже изменено/);
 await x.c.applyHistoryOperations(undone.operations,'after',undone);assert.equal(x.score(),-3);assert.equal(x.loads(),0);
 assert.equal(x.records().filter(row=>row.eventType==='game_penalty').length,1);assert.equal(x.e.selected('logs',x.c.state.shift.id).length,0);
 assert.equal(op.id,x.records().find(row=>row.offlineReceipt).offlineOperationId);
});
test('Live delete and causal quick undo still remove earned load coins exactly once',async()=>{
 const deleted=setup(),op=await deleted.load();await deleted.reportDelete(op.logId);assert.equal(deleted.score(),0);assert.equal(deleted.loads(),0);
 const x=setup(),queued=await x.load();x.c.state.notifications=x.e.selected('notifications');await x.c.undoLastAction();
 assert.equal(x.score(),-3);assert.equal(x.loads(),0);await x.retry(queued);assert.equal(x.score(),-3);assert.equal(x.records().filter(row=>row.eventType==='game_penalty').length,1);
});
test('Equal confirmation timestamps order a queued load before its later quick undo using the frozen action time',async()=>{
 const x=setup(),op=await x.load();x.c.state.notifications=x.e.selected('notifications');await x.c.undoLastAction();
 const rows=x.records(),creation=rows.find(row=>row.history?.operations.some(o=>o.collection==='logs'&&!o.before&&o.after)),deletion=rows.find(row=>row.history?.operations.some(o=>o.collection==='logs'&&o.before&&!o.after));
 for(const ids of [['z-load','a-delete'],['a-load','z-delete']]){
  creation.id=ids[0];deletion.id=ids[1];creation.timestamp=deletion.timestamp=4000000;
  creation.history.gameRewards.actionAt=2000000;deletion.history.gameRewards.actionAt=4000000;
  assert.equal(x.c.window.__gameCoinsCore.calculate(rows)[0].coins,-3);
 }
 assert.equal(x.e.read('logs',op.logId),undefined);
});
test('An unrelated archive write or invalid cleanup claim cannot shield a real deletion',async()=>{
 let x=setup(),op=await x.load();
 await assert.rejects(()=>x.c.db.runTransaction(async tx=>{tx.delete(x.e.refs.logs.doc(op.logId));return {archiveCleanup:{version:1,shiftId:'s1',archiveId:'not-created'}};}),/Архивная очистка/);
 assert(x.e.read('logs',op.logId));assert.equal(x.score(),5);
 await x.c.db.runTransaction(async tx=>{tx.set(x.e.refs.archive.doc('unrelated'),{sourceShiftId:'other',logs:[]});tx.delete(x.e.refs.logs.doc(op.logId));});assert.equal(x.score(),0);
 const rows=x.records(),entry=rows.find(row=>row.history?.operations.some(o=>o.collection==='logs'&&!o.after));
 for(const proof of [{version:1,archiveId:'a',shiftId:'wrong',logIds:[op.logId]},{version:1,archiveId:'a',shiftId:'s1',logIds:['wrong']},{version:2,archiveId:'a',shiftId:'s1',logIds:[op.logId]}]){
  entry.history.archiveCleanup=proof;assert.equal(x.c.window.__gameCoinsCore.calculate(rows)[0]?.coins||0,0);
 }
});
(async()=>{let failed=0;for(const {name,run}of tests){try{await run();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name,error);}}console.log(`${tests.length-failed}/${tests.length} archive/coin integration groups passed`);if(failed)process.exitCode=1;})();
