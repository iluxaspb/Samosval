import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../src/test-replica.mjs';
import {planSparkPostgresReplay} from '../src/test-spark-pg-dry-run.mjs';

const H='a'.repeat(64),G='0123456789abcdef01234567',T=1800000000000;
const sha=x=>createHash('sha256').update(canonical(x)).digest('hex');
function event(type,id,at,rev,expected,other={}){
 const intent={id,type,truckId:'truckA',shiftId:'shiftA',
  createdAt:at-100,expectedRevision:expected,cycleMinutes:60,
  arrivalTimestamp:type==='load'?T:0,lastLoadTimestamp:0,
  wantArrived:type==='arrive',collect:type==='ttn'};
 if(type==='ttn')intent.expectedTtnRevision=0;
 const result={operationId:id,uid:'operatorA',type,epoch:9,
  generation:G,truckId:'truckA',shiftId:'shiftA',
  ordinal:other.ordinal??1,
  expectedRevision:expected,revision:rev,cycleMinutes:60,
  requestHash:sha(intent),intent,at:{toMillis:()=>at},serverAt:at,
  logId:type==='load'?'load_'+id:'',
  volume:type==='load'?24:0,isGAI:false,
  ...(type==='ttn'?{expectedTtnRevision:0,ttnRevision:1,collect:true}:{})};
 return result;
}
function fixture(){
 const ev=[
  event('arrive','arrive01',T,4,3,{ordinal:1}),
  event('ttn','ttn01',T+5000,4,4,{ordinal:2}),
  event('load','load01',T+15000,5,4,{ordinal:3})
 ];
 const manifest={format:'spark-typed-replay-manifest',version:1,
  generation:G,fromEpoch:9,ownerEpoch:10,baseSequence:42,baseHash:H,
  eventCount:ev.length,events:ev,
  sha256:sha(ev.map(({at,...e})=>e))};
 const baseline={sequence:42,hash:H,cycleMinutes:60,
  shiftId:'shiftA',shiftActive:true,
  statuses:{truckA:{id:'truckA',shiftId:'shiftA',onLine:true,
   cycleRevision:3,ttnRevision:0,ttnStatus:null,
   lastLoadTimestamp:null,lastLoadLogId:null,arriveStatus:null,
   arriveTimestamp:null,loadedAfterArrive:false}},
  trucks:{truckA:{brand:'КамАЗ',number:'А123АА',defaultVol:24,isGAI:false}},
  actors:{operatorA:{name:'Оператор А',email:'a@example.org',role:'lopater',
   status:'active',actions:['action_arrive','action_load','action_ttn']}}
 };
 return {manifest,baseline};
}
test('frozen Spark ARRIVE, TTN and LOAD replay dry-run matches NAS business rules',()=>{
 const f=fixture();
 const result=planSparkPostgresReplay(f);
 assert.equal(result.eventCount,3);
 assert.deepEqual(result.operations.map(x=>x.operationId),
  ['arrive01','ttn01','load01']);
 assert.equal(result.expectedStatuses.truckA.cycleRevision,5);
 assert.equal(result.expectedStatuses.truckA.ttnRevision,1);
 assert.equal(result.expectedStatuses.truckA.ttnStatus,true);
 const load=result.operations[2];
 assert.equal(load.pgIntent.createdAt,T+15000);
 assert.equal(load.pgReceipt.log.volume,24);
 assert.equal(load.reserveLogId,'load_load01');
 assert.equal(load.postgresLogId,'load_truckA_shiftA_cycle_4_'+T);
 assert.match(result.plannedHash,/^[a-f0-9]{64}$/);
 assert.equal(planSparkPostgresReplay(f).plannedHash,result.plannedHash);
});
test('stale NAS baseline and malformed frozen manifest never authorize replay',()=>{
 for(const update of [
  f=>{f.baseline.sequence=43;},
  f=>{f.baseline.hash='b'.repeat(64);},
  f=>{f.manifest.sha256='f'.repeat(64);},
  f=>{f.manifest.eventCount=2;},
  f=>{f.baseline.shiftActive=false;}
 ]){
  const f=fixture();update(f);
  assert.throws(()=>planSparkPostgresReplay(f),/spark-replay-/);
 }
});
test('revoked operator, conflicting revision and old arrival cause dry-run divergence',()=>{
 for(const update of [
  f=>{f.baseline.actors.operatorA.status='disabled';},
  f=>{f.baseline.actors.operatorA.actions=['action_arrive','action_ttn'];},
  f=>{f.baseline.statuses.truckA.cycleRevision=7;},
  f=>{f.baseline.statuses.truckA.arriveStatus='12:00';},
  f=>{f.baseline.trucks.truckA.defaultVol=99;}
 ]){
  const f=fixture();update(f);
  assert.throws(()=>planSparkPostgresReplay(f),/spark-replay-/);
 }
});
test('dry-run leaves PostgreSQL baseline and manifests unchanged',()=>{
 const f=fixture(),was=JSON.stringify(f.baseline);
 const result=planSparkPostgresReplay(f);
 assert.equal(JSON.stringify(f.baseline),was);
 assert.equal(result.operations.length,3);
 assert.notEqual(result.operations[0].pgIntent.createdAt,
  f.manifest.events[0].intent.createdAt);
});
