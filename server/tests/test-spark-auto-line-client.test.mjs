import test from 'node:test';
import assert from 'node:assert/strict';
import {createSparkAutoLineClient} from '../../test-app/synology/spark-auto-line-client.mjs';

const GEN='0123456789abcdef01234567',UID='user_a',SCOPE=JSON.stringify(['synology','https://nas.test','main_workspace',UID]);
const owner=more=>({projectId:'samosval-offline',owner:'synology',
 readyForFailover:false,epoch:1,generation:GEN,confirmedSequence:20,
 reserveSequence:0,...more});
const line=source=>({source,format:'samosval-line-snapshot',version:1,
 workspaceId:'main_workspace',shift:{id:'shift_a',isActive:true},
 trucks:[{id:'truck_a'}],statuses:[{id:'truck_a'}],logs:[],
 cycleMinutes:60,...(source==='firebase'?{typedGeneration:GEN,reserveOperations:[]}:{})});
const session=source=>({source,format:'samosval-session',version:1,
 workspaceId:'main_workspace',identityReady:true,profile:{uid:UID,status:'active',deleted:false},
 permissions:{tabs:['line'],actions:['action_load']}});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=1300){
 const started=Date.now();
 while(!predicate()){
  if(Date.now()-started>timeout)throw Error('timed out awaiting subscription');
  await delay(10);
 }
}
function fixtures(){
 let auth={uid:UID},authority=owner(),authorityReads=0;
 let nasWrites=0,sparkWrites=0,nasReads=0,sparkReads=0,nasSessions=0,sparkSessions=0,
  readOptions=[],
  nasSubscriptions=0,nasStops=0,typedWatches=0,typedStop=null;
 let overrideNasRead=null,overrideSparkRead=null,overrideSparkWrite=null;
 const triggers=new Map(),subscriptions=new Map(),providerEvents=[];
 const firestore={app:{options:{projectId:'samosval-offline'}},
  doc(path){return {path,onSnapshot(cb,error){
   triggers.set(path,{cb,error});
   return ()=>triggers.delete(path);
  }}}
 };
 const nas={
  uid:UID,workspaceId:'main_workspace',scope:SCOPE,
  async readLine(){nasReads++;if(overrideNasRead)return overrideNasRead();return line('synology');},
  async readSession(){nasSessions++;return session('synology');},
  async submitLine(op){nasWrites++;return {outcome:'confirmed',status:{cycleRevision:2},operationId:op.id};},
  async readSettings(){return {source:'synology'};},
  subscribeLine({onSession,onSnapshot}){nasSubscriptions++;
   let open=true;
   queueMicrotask(()=>{if(open){onSession(session('synology'));onSnapshot(line('synology'));}});
   return ()=>{open=false;nasStops++;};
  },
  stop(){nasStops++;}
 };
 const reader={
  uid:UID,async readLine(options){sparkReads++;readOptions.push(options);
   if(overrideSparkRead)return overrideSparkRead();
   return line('firebase');
  },
  async readSession(){sparkSessions++;return session('firebase');},
  watchStatuses(_snapshot,onChange){typedWatches++;typedStop=onChange;return ()=>{typedStop=null;};},
  stop(){}
 };
 const writer={uid:UID,async submitLine(op){sparkWrites++;
   if(overrideSparkWrite)return overrideSparkWrite(op);
   return {outcome:'confirmed',operationId:op.id,revision:2};
  },stop(){}};
 const ownerReader={async readOwner(){authorityReads++;return {...authority};},stop(){}};
 const create=({promoter=null}={})=>createSparkAutoLineClient({nasClient:nas,reader,writer,ownerReader,
  promoter,firestore,getUser:()=>auth,onProviderChange:p=>providerEvents.push(p),heartbeatMs:30000});
 return {create,firestore,triggers,subscriptions,providerEvents,
  owner:changes=>{authority={...authority,...changes};},
  swap:()=>{auth={uid:UID};},
  sparkReadOverride:fn=>overrideSparkRead=fn,
  nasReadOverride:fn=>overrideNasRead=fn,
  sparkWriteOverride:fn=>overrideSparkWrite=fn,
  trigger:path=>triggers.get(path)?.cb({metadata:{fromCache:false}}),
  get typedStop(){return typedStop;},
  get nasReads(){return nasReads;},get sparkReads(){return sparkReads;},
  get nasWrites(){return nasWrites;},get sparkWrites(){return sparkWrites;},
  get readOptions(){return readOptions;},
  get nasSessions(){return nasSessions;},get sparkSessions(){return sparkSessions;},
  get authorityReads(){return authorityReads;},
  get nasSubscriptions(){return nasSubscriptions;},get nasStops(){return nasStops;},
  get typedWatches(){return typedWatches;}
 };
}
test('NAS is primary even when its transport is down: no automatic Firebase promotion',async()=>{
 const f=fixtures(),client=f.create();
 assert.equal((await client.readLine()).source,'synology');
 f.nasReadOverride(()=>{throw Object.assign(Error('offline'),{retryable:true});});
 await assert.rejects(client.readLine(),/offline/);
 assert.equal(f.sparkReads,0);
 assert.equal(f.sparkWrites,0);
 assert.equal(client.activeProvider,'synology');
 client.stop();
});
test('only a certified Firebase owner routes ARRIVE/LOAD/TTN to direct SDK',async()=>{
 const f=fixtures();
 f.owner({owner:'firebase',readyForFailover:true,holder:'firebase_reserve',epoch:8});
 const client=f.create();
 assert.equal((await client.readSession()).source,'firebase');
 assert.equal((await client.readLine()).source,'firebase');
 const op={id:'op_a',type:'load',truckId:'truck_a',shiftId:'shift_a'};
 const reply=await client.submitLine(op,{operationScope:SCOPE});
 assert.equal(reply.outcome,'confirmed');
 assert.equal(f.sparkWrites,1);
 assert.equal(f.nasWrites,0);
 assert.equal(client.activeProvider,'firebase');
 await assert.rejects(client.readSettings(),{code:'spark-auto-reserve-unsupported'});
 await assert.rejects(client.submitLine({...op,id:'reset_a',type:'reset'}, {operationScope:SCOPE}),
  {code:'spark-auto-reserve-unsupported'});
 client.stop();
});
test('handoff and uncertified Firebase never perform either provider read/write',async()=>{
 for(const state of [
  {owner:'reconciling',readyForFailover:false},
  {owner:'handoff',readyForFailover:false},
  {owner:'firebase',readyForFailover:false}
 ]){
  const f=fixtures();f.owner(state);
  const client=f.create();
  await assert.rejects(client.readLine(),e=>e.code?.startsWith('spark-auto-'));
  await assert.rejects(client.submitLine({id:'op_a',type:'load'}, {operationScope:SCOPE}),
   e=>e.code?.startsWith('spark-auto-'));
  assert.equal(f.nasReads+f.sparkReads+f.nasWrites+f.sparkWrites,0);
  client.stop();
 }
});
test('owner change during read discards a stale provider snapshot',async()=>{
 const f=fixtures();f.nasReadOverride(async()=>{
  f.owner({epoch:2});return line('synology');
 });
 const client=f.create();
 await assert.rejects(client.readLine(),{code:'spark-auto-owner-changed-during-read'});
 assert.equal(client.activeProvider,null);
 client.stop();
});
test('owner change after a Spark write has an uncertain receipt, not an invented rejection',async()=>{
 const f=fixtures();f.owner({owner:'firebase',readyForFailover:true,epoch:8});
 f.sparkWriteOverride(async op=>{
  f.owner({owner:'reconciling',readyForFailover:false,epoch:9});
  return {outcome:'confirmed',operationId:op.id};
 });
 const client=f.create();
 await assert.rejects(client.submitLine({id:'op_a',type:'load'}, {operationScope:SCOPE}),
  e=>e.code==='spark-auto-write-result-uncertain'&&e.uncertain===true);
 assert.equal(f.sparkWrites,1);assert.equal(f.nasWrites,0);
 client.stop();
});
test('firebase subscriptions are event-driven, not a four-second collection scan',async()=>{
 const f=fixtures();f.owner({owner:'firebase',readyForFailover:true,epoch:8});
 const client=f.create(),events=[];
 let close=()=>{};
 try{
  close=client.subscribeLine({
   onSession:s=>events.push('session:'+s.source),
   onSnapshot:s=>events.push('line:'+s.source),onError:e=>events.push('error:'+e.code)
  });
  await until(()=>events.includes('line:firebase'));
  assert.equal(f.nasSubscriptions,0);
  const readCount=f.sparkReads;
  await delay(90);
  assert.equal(f.sparkReads,readCount,'no timer-based Firestore polling');
  f.typedStop?.('truck_a');
  await until(()=>f.sparkReads>readCount);
  assert.deepEqual(f.readOptions.at(-1),{changedTruckIds:['truck_a']});
  assert.equal(events.at(-1),'line:firebase');
  assert.equal(f.nasWrites,0);
 }finally{close();client.stop();}
});
test('NAS subscription closes on ownership change and never emits the old dataset',async()=>{
 const f=fixtures(),client=f.create(),events=[];
 let close=()=>{};
 try{
  close=client.subscribeLine({onSession:s=>events.push('session:'+s.source),
   onSnapshot:s=>events.push('line:'+s.source),onError:e=>events.push('error:'+e.code)});
  await until(()=>events.includes('line:synology'));
  // Native Firestore listeners always deliver one initial snapshot. The
  // router ignores that initial event and reacts to the next owner change.
  f.trigger('samosval_test_replica/write_owner');
  f.owner({owner:'firebase',readyForFailover:true,epoch:2});
  f.trigger('samosval_test_replica/write_owner');
  await until(()=>events.includes('line:firebase'));
  assert.ok(f.nasStops>=1);
  assert.equal(client.activeProvider,'firebase');
 }finally{close();client.stop();}
});
test('session replacement blocks every authenticated reserve operation',async()=>{
 const f=fixtures(),client=f.create();
 f.swap();
 await assert.rejects(client.readLine(),{code:'spark-auto-session-changed'});
 await assert.rejects(client.submitLine({id:'op_a',type:'load'}, {operationScope:SCOPE}),
  {code:'spark-auto-session-changed'});
 assert.equal(f.nasWrites+f.sparkWrites,0);
 client.stop();
});

test('an expired, independently certified NAS lease schedules direct phone promotion',async()=>{
 const f=fixtures();let attempts=0;
 f.owner({leaseUntil:Date.now()-100000,promotionCertified:true});
 const promoter={async tryPromote(){
  attempts++;
  f.owner({owner:'firebase',epoch:2,readyForFailover:true,
   promotionCertified:false});
  return {promoted:true,epoch:2};
 },stop(){}};
 const client=f.create({promoter}),events=[];
 let close=()=>{};
 try{
  close=client.subscribeLine({onSession:s=>events.push('session:'+s.source),
   onSnapshot:s=>events.push('line:'+s.source),onError:e=>events.push('error:'+e.code)});
  await until(()=>events.includes('line:firebase'));
  assert.equal(attempts,1);
  assert.equal(client.activeProvider,'firebase');
  assert.equal(f.nasWrites,0,'promotion never writes a NAS business operation');
  assert.ok(f.nasStops>=1);
 }finally{close();client.stop();}
});
test('an expired NAS lease without SQL016 certificate never attempts promotion',async()=>{
 const f=fixtures();let attempts=0;
 f.owner({leaseUntil:Date.now()-100000,promotionCertified:false});
 const promoter={async tryPromote(){attempts++;return {promoted:true};},stop(){}};
 const client=f.create({promoter}),events=[];
 let close=()=>{};
 try{
  close=client.subscribeLine({onSession:s=>events.push('session:'+s.source),
   onSnapshot:s=>events.push('line:'+s.source),onError:e=>events.push('error:'+e.code)});
  await until(()=>events.includes('line:synology'));
  await delay(300);
  assert.equal(attempts,0);
  assert.equal(client.activeProvider,'synology');
 }finally{close();client.stop();}
});
