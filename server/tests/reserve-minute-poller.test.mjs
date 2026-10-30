import test from 'node:test';
import assert from 'node:assert/strict';
import {createMinuteReservePoller} from '../src/reserve-minute-poller.mjs';
import {MINUTE_REPLICA_MS} from '../src/reserve-minute-replication.mjs';
function fixture({pending=0,ack=true,maxBatches=10}={}){
  let time=100000,writes=0,head={sequence:0,hash:'a'.repeat(64)},remaining=pending;
  const runner={tick:async({previous,force})=>{
    assert.equal(force,true);
    assert.deepEqual(previous,head,'next packet must start from durable receipt');
    if(!remaining)return {status:'unchanged',writes:0};
    const n=Math.min(2,remaining);remaining-=n;writes++;
    const receipt={sequence:head.sequence+n,hash:String(writes%10).repeat(64)};
    if(ack)head=receipt;
    return {status:'replicated',writes:1,events:n,receipt,morePending:remaining>0};
  }};
  const poller=createMinuteReservePoller({runner,readReceipt:async()=>({...head}),
    now:()=>time,maxBatches});
  return {poller,writes:()=>writes,remaining:()=>remaining,clock:t=>{time=t;}};
}
test('one minute drains multiple bounded documents and only confirms persisted receipts',async()=>{
  const f=fixture({pending:5});
  const r=await f.poller.poll();
  assert.equal(r.status,'replicated');
  assert.equal(r.writes,3);assert.equal(r.events,5);
  assert.equal(r.receipt.sequence,5);assert.equal(f.writes(),3);
  assert.equal(f.remaining(),0);
  assert.deepEqual(await f.poller.poll(),{status:'not-due',writes:0,nextDueAt:100000+MINUTE_REPLICA_MS});
});
test('quiet minutes do not create Firebase writes',async()=>{
  const f=fixture();
  assert.equal((await f.poller.poll()).status,'unchanged');
  assert.equal(f.writes(),0);
  f.clock(100000+MINUTE_REPLICA_MS);
  assert.equal((await f.poller.poll()).writes,0);
});
test('bounded catch-up preserves remaining queue for next tick',async()=>{
  const f=fixture({pending:7,maxBatches:2});
  const first=await f.poller.poll();assert.equal(first.status,'backlog-remains');
  assert.equal(first.writes,2);assert.equal(first.events,4);
  assert.equal(f.remaining(),3);
  f.clock(100000+MINUTE_REPLICA_MS);
  const second=await f.poller.poll();
  assert.equal(second.status,'replicated');assert.equal(second.writes,2);
  assert.equal(f.remaining(),0);assert.equal(second.receipt.sequence,7);
});
test('unpersisted NAS receipt must halt multi-packet drain rather than silently lose data',async()=>{
  const f=fixture({pending:5,ack:false});
  await assert.rejects(f.poller.poll(),/minute-durable-receipt-mismatch/);
  assert.equal(f.writes(),1,'later packets must not be sent after receipt mismatch');
  assert.equal(f.poller.lastAttemptAt,null,'unconfirmed cycle must be retryable');
});
test('two overlapping scheduler calls cannot duplicate one minute',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  let writes=0;let head={sequence:0,hash:'a'.repeat(64)};
  const poller=createMinuteReservePoller({now:()=>100000,readReceipt:async()=>({...head}),runner:{
    tick:async()=>{await gate;writes++;head={sequence:1,hash:'b'.repeat(64)};
      return {status:'replicated',writes:1,events:1,receipt:head,morePending:false};}
  }});
  const first=poller.poll();
  assert.deepEqual(await poller.poll(),{status:'busy',writes:0});
  release();
  assert.equal((await first).status,'replicated');
  assert.equal(writes,1);
});
test('invalid runner output and clock never count as a completed minute',async()=>{
  const h={sequence:0,hash:'a'.repeat(64)};
  const poller=createMinuteReservePoller({now:()=>100000,readReceipt:async()=>h,
    runner:{tick:async()=>({status:'replicated',writes:1,events:0,receipt:h,morePending:false})}});
  await assert.rejects(poller.poll(),/invalid-minute-replica-result/);
  assert.equal(poller.lastAttemptAt,null);
  assert.throws(()=>createMinuteReservePoller({runner:{tick(){}},readReceipt(){},maxBatches:0}),/invalid-minute-poller/);
});
