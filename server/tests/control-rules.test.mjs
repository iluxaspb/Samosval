import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeControl,membershipStatus} from '../src/control-rules.mjs';
import {applyLineOperation} from '../src/line-rules.mjs';
test('dictionary normalization accepts only business fields and never a client actor',()=>{
  assert.deepEqual(normalizeControl({id:'a',type:'truck.create',recordId:'truck',expectedRevision:0,data:{brand:' KAMAZ ',number:' TEST ',defaultVol:24,isGAI:true,createdBy:'Fake',deleted:true}}),{id:'a',type:'truck.create',recordId:'truck',expectedRevision:0,data:{brand:'KAMAZ',number:'TEST',defaultVol:0,isGAI:true}});
  assert.deepEqual(normalizeControl({id:'a',type:'object.update',recordId:'site',expectedRevision:2,data:{name:' Site ',createdBy:'Fake'}}).data,{name:'Site'});
});
test('invalid revisions, numbers, field types and unsupported operations are rejected',()=>{
  const truck={id:'a',type:'truck.create',recordId:'truck',expectedRevision:0,data:{brand:'KAMAZ',number:'TEST',defaultVol:24,isGAI:false}};
  for(const patch of [{type:'unknown'},{recordId:'a/b'},{expectedRevision:1},{data:{...truck.data,defaultVol:NaN}},{data:{...truck.data,defaultVol:-1}},{data:{...truck.data,isGAI:1}},{data:{...truck.data,brand:' '}}])assert.throws(()=>normalizeControl({...truck,...patch}));
  assert.throws(()=>normalizeControl({...truck,type:'truck.update',expectedRevision:Number.MAX_SAFE_INTEGER}));
  assert.throws(()=>normalizeControl({id:'a',type:'shift.object',shiftId:'s',objectId:'o'}));
});
test('leave/rejoin retains last load, TTN and fences stale queued requests',()=>{
  const ts=Date.now(),before={id:'t',shiftId:'s',onLine:true,cycleRevision:8,ttnRevision:4,lastLoadTimestamp:ts,lastLoadLogId:'previous',ttnStatus:true,arriveTimestamp:ts-1,arriveStatus:'10:00'};
  const removed=membershipStatus({type:'line.remove',truckId:'t',shiftId:'s',expectedRevision:8,expectedTtnRevision:4},before,'Actor',ts);
  const added=membershipStatus({type:'line.add',truckId:'t',shiftId:'s',expectedRevision:9,expectedTtnRevision:5},removed,'Actor',ts+1);
  assert.equal(added.lastLoadTimestamp,ts);assert.equal(added.lastLoadLogId,'previous');assert.equal(added.ttnStatus,true);
  assert.equal(added.cycleRevision,10);assert.equal(added.ttnRevision,6);assert.equal(added.arriveTimestamp,null);
  const op={id:'queued',type:'arrive',truckId:'t',shiftId:'s',expectedRevision:10,expectedTtnRevision:6,arrivalTimestamp:0,wantArrived:true,createdAt:ts+1,cycleMinutes:15};
  assert.equal(applyLineOperation({op,before:added,truck:{},actor:{name:'Actor'}}).reason,'cycle-time');
  assert.equal(applyLineOperation({op:{...op,expectedRevision:8},before:added,truck:{},actor:{name:'Actor'}}).reason,'arrival-changed');
  assert.throws(()=>membershipStatus({...op,type:'line.remove',expectedRevision:8},added,'Actor'),{code:'line-intent-changed'});
});
test('membership never overwrites another shift or treats a duplicate add as fresh state',()=>{
  const op={type:'line.add',truckId:'t',shiftId:'s',expectedRevision:0,expectedTtnRevision:0};
  assert.throws(()=>membershipStatus(op,{shiftId:'other'},'Actor'),{code:'status-shift-mismatch'});
  assert.throws(()=>membershipStatus(op,{shiftId:'s',onLine:true},'Actor'),{code:'already-on-line'});
  assert.throws(()=>membershipStatus({...op,type:'line.remove'},null,'Actor'),{code:'not-on-line'});
});
