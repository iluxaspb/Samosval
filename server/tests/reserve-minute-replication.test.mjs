import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMinuteReserveBatch,verifyMinuteReserveBatch,createMinuteReplicaRunner,selectMinuteReserveBatch,MINUTE_REPLICA_MS} from '../src/reserve-minute-replication.mjs';
const previous={sequence:9,hash:'a'.repeat(64)};
function event(sequence,{table='line_logs',action='upsert',row={id:'trip-'+sequence},operationId='action-'+sequence}={}){
  return {sequence,operationId,rowId:'row-'+sequence,table,action,row,
    projectId:'samosval-offline',workspaceId:'main_workspace'};
}
function fixture({events=[event(10),event(11,{table:'tabel_records'})],clock=100000}={}){
  const docs=new Map(),stats={put:0,read:0,persist:0};let time=clock,damaged=false;
  const runner=createMinuteReplicaRunner({
    now:()=>time,
    readPending:async()=>events,
    putImmutable:async batch=>{stats.put++;const old=docs.get(batch.batchId);
      if(old&&JSON.stringify(old)!==JSON.stringify(batch.document))throw Error('immutable-conflict');
      docs.set(batch.batchId,structuredClone(batch.document));
    },
    readBack:async id=>{stats.read++;return damaged?{bad:true}:docs.get(id);},
    persistReceipt:async()=>{stats.persist++;}
  });
  return {runner,stats,docs,time:x=>{time=x;},damage:()=>{damaged=true;}};
}
test('minute packet combines different business tables into one immutable Firestore document',()=>{
  const batch=buildMinuteReserveBatch({previous,events:[
    event(10),event(11,{table:'tabel_records'}),
    event(12,{table:'line_operation_receipts'}),
    event(13,{table:'archive_overrides',action:'delete',row:null})
  ]});
  assert.equal(batch.document.from,10);assert.equal(batch.document.to,13);
  assert.equal(batch.document.events.length,4);
  assert.equal(verifyMinuteReserveBatch(batch),true);
  const tampered=structuredClone(batch);tampered.document.events[0].row.id='changed';
  assert.equal(verifyMinuteReserveBatch(tampered),false);
});
test('missing sequence, cross-project row or invalid deletion blocks sending entire packet',()=>{
  for(const events of [
    [event(11)],[event(10),event(12)],
    [{...event(10),projectId:'production'}],
    [{...event(10),workspaceId:'other'}],
    [{...event(10),table:'unrecognized'}],
    [{...event(10),action:'delete'}]
  ])assert.throws(()=>buildMinuteReserveBatch({previous,events}),/invalid-minute-event/);
  assert.throws(()=>buildMinuteReserveBatch({previous,events:[event(10,{row:{huge:'x'.repeat(3000)}})],maxBytes:1024}),/too-large/);
});
test('one minute with changes makes one document, verified before durable NAS receipt',async()=>{
  const f=fixture();
  const r=await f.runner.tick({previous});
  assert.equal(r.status,'replicated');
  assert.equal(r.writes,1);assert.equal(r.events,2);
  assert.deepEqual(f.stats,{put:1,read:1,persist:1});
  assert.equal(r.receipt.sequence,11);
  assert.equal(await f.runner.tick({previous,lastAttemptAt:100000}).then(x=>x.status),'not-due');
  f.time(100000+MINUTE_REPLICA_MS);
  assert.equal(await f.runner.tick({previous,lastAttemptAt:100000}).then(x=>x.status),'replicated');
  assert.equal(f.docs.size,1,'same committed events reuse same content ID');
});
test('quiet minute does not write a Firebase document',async()=>{
  const f=fixture({events:[]});
  assert.deepEqual(await f.runner.tick({previous}),{status:'unchanged',lastAttemptAt:100000,writes:0});
  assert.deepEqual(f.stats,{put:0,read:0,persist:0});
});
test('corrupt Firebase read-back blocks NAS confirmation',async()=>{
  const f=fixture();f.damage();
  await assert.rejects(f.runner.tick({previous}),/minute-batch-readback-mismatch/);
  assert.equal(f.stats.persist,0);
});
test('missing sequence blocks write and cannot advance confirmed checkpoint',async()=>{
  const f=fixture({events:[event(10),event(12)]});
  await assert.rejects(f.runner.tick({previous}),/invalid-minute-event/);
  assert.deepEqual(f.stats,{put:0,read:0,persist:0});
});
test('lost confirmation remains retryable with identical document ID',async()=>{
  const docs=new Map();let attempts=0,confirm=0;
  const runner=createMinuteReplicaRunner({
    now:()=>100000,readPending:async()=>[event(10)],
    putImmutable:async batch=>{attempts++;docs.set(batch.batchId,batch.document);},
    readBack:async id=>docs.get(id),
    persistReceipt:async()=>{confirm++;if(confirm===1)throw Error('NAS-disconnected');}
  });
  await assert.rejects(runner.tick({previous}),/NAS-disconnected/);
  const after=await runner.tick({previous});
  assert.equal(after.status,'replicated');
  assert.equal(docs.size,1);
  assert.equal(attempts,2);
  assert.equal(confirm,2);
});

test('minute outbox splits more than 500 records into consecutive documents', async()=>{
  const events=Array.from({length:502},(_,i)=>event(10+i));
  let cursor={...previous},writes=0;
  const runner=createMinuteReplicaRunner({
    now:()=>100000,
    readPending:async seq=>events.filter(e=>e.sequence>seq).slice(0,501),
    putImmutable:async()=>{writes++;},
    readBack:async id=>{
      const batch=latestBatch;return batch?.batchId===id?batch.document:null;
    },
    persistReceipt:async()=>{}
  });
  // Observe each generated document while preserving the same read-back contract.
  let latestBatch=null;
  // The first document contains 500 events, the second contains two.
  const first=selectMinuteReserveBatch({previous:cursor,events:events.slice(0,501)});
  assert.equal(first.document.events.length,500);
  assert.equal(first.morePending,true);
  cursor={sequence:first.document.to,hash:first.batchId};
  const second=selectMinuteReserveBatch({previous:cursor,events:events.slice(500)});
  assert.equal(second.document.from,510);
  assert.equal(second.document.events.length,2);
  assert.equal(second.morePending,false);
  assert.equal(new Set([...first.document.events,...second.document.events].map(e=>e.operationId)).size,502);
});
test('single oversized event cannot be silently lost',()=>{
  assert.throws(()=>selectMinuteReserveBatch({previous,
    events:[event(10,{row:{id:'huge',payload:'z'.repeat(3000)}})],maxBytes:1024}),/minute-event-exceeds-document-size/);
});
test('a row gap in the next packet blocks further acknowledgements',()=>{
  const initial=selectMinuteReserveBatch({previous,events:[event(10),event(11),event(13)],maxBytes:1024});
  // Either the preceding valid prefix can be safely staged, or the entire
  // attempt fails. It may never report 13 as contiguous with 11.
  assert.ok(initial.document.to<=11);
  assert.equal(initial.morePending,true);
  const next={sequence:initial.document.to,hash:initial.batchId};
  assert.throws(()=>selectMinuteReserveBatch({previous:next,events:[event(13)]}),/invalid-minute-event/);
});
test('size-based split retains the tail to send on the next tick',()=>{
  const events=Array.from({length:40},(_,i)=>event(10+i,{row:{id:'x'+i,comment:'abc'.repeat(80)}}));
  const first=selectMinuteReserveBatch({previous,events,maxBytes:2000});
  assert.ok(first.document.events.length>0&&first.document.events.length<40);
  assert.equal(first.morePending,true);
  const tail=events.slice(first.document.events.length);
  const next=selectMinuteReserveBatch({previous:{sequence:first.document.to,hash:first.batchId},events:tail,maxBytes:2000});
  assert.equal(next.document.from,first.document.to+1);
});
