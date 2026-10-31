// Isolated TEST Spark recovery preflight. Reads a frozen Firebase generation,
// validates every immutable typed status event and outputs a deterministic
// manifest. ZERO PostgreSQL writes. This is NOT an enabled handback path.
import {createHash} from 'node:crypto';
import {canonical,assertTestProject,REPLICA_DOC} from './test-replica.mjs';
import {OWNER_DOC} from './test-writer-coordinator.mjs';

const GEN=/^[0-9a-f]{24}$/;
const HEX=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const seq=x=>Number.isSafeInteger(x)&&x>=0;
const fail=code=>Object.assign(new Error(code),{code});
const hash=text=>createHash('sha256').update(text).digest('hex');
const snap=s=>s?.exists?s.data():null;
const checkedTime=x=>{
 const value=x?.toMillis?.();
 if(!Number.isSafeInteger(value)||value<=0)throw fail('spark-replay-invalid-server-time');
 return value;
};
function freezeContext(meta,owner){
 if(!meta||meta.protocol!==1||meta.projectId!=='samosval-offline'||
    meta.channel!=='test'||meta.typedProtocol!==1||
    !GEN.test(meta.generation||'')||!HEX.test(meta.hash||'')||
    meta.readyForFailover!==true||!seq(meta.lastSequence)||
    meta.typedSequence!==meta.lastSequence||
    !owner||owner.owner!=='reconciling'||owner.projectId!=='samosval-offline'||
    owner.holder!=='reconcile_worker'||owner.generation!==meta.generation||
    !seq(owner.epoch)||!seq(owner.observedSequence)||
    owner.observedSequence!==meta.lastSequence||
    !seq(owner.recovery?.fromEpoch)||owner.recovery.fromEpoch<1||
    owner.epoch!==owner.recovery.fromEpoch+1||
    owner.recovery.generation!==meta.generation||
    owner.recovery.baseSequence!==meta.lastSequence||
    owner.recovery.baseHash!==meta.hash||
    !obj(owner.pending)||Object.keys(owner.pending).length!==0)
  throw fail('spark-replay-owner-not-frozen');
 return {generation:meta.generation,fromEpoch:owner.recovery.fromEpoch,
  ownerEpoch:owner.epoch,baseSequence:meta.lastSequence,baseHash:meta.hash};
}
function verifyIntent(event,uid,truckId,context){
 if(!obj(event)||!obj(event.intent)||!ID.test(event.operationId||'')||
    !ID.test(event.uid||'')||!ID.test(event.truckId||'')||
    !ID.test(event.shiftId||'')||
    event.uid!==uid||event.truckId!==truckId||
    event.epoch!==context.fromEpoch||event.generation!==context.generation||
    !HEX.test(event.requestHash||'')||event.requestHash!==hash(canonical(event.intent))||
    !seq(event.ordinal)||event.ordinal<1||
    !seq(event.expectedRevision)||!seq(event.revision)||
    !seq(event.cycleMinutes)||event.cycleMinutes<15||event.cycleMinutes>10080||
    !['arrive','load','ttn'].includes(event.type))
  throw fail('spark-replay-event-invalid');
 const intent=event.intent;
 if(intent.id!==event.operationId||intent.type!==event.type||
    intent.truckId!==truckId||intent.shiftId!==event.shiftId||
    intent.expectedRevision!==event.expectedRevision||
    intent.cycleMinutes!==event.cycleMinutes||
    !seq(intent.createdAt)||!seq(intent.arrivalTimestamp)||
    !seq(intent.lastLoadTimestamp))
  throw fail('spark-replay-intent-mismatch');
 if(event.type==='ttn'){
  if(!seq(event.expectedTtnRevision)||!seq(event.ttnRevision)||
      intent.expectedTtnRevision!==event.expectedTtnRevision||
      typeof intent.collect!=='boolean'||event.collect!==intent.collect||
      event.revision!==event.expectedRevision||event.ttnRevision!==event.expectedTtnRevision+1||
      event.logId!==''||event.volume!==0||event.isGAI!==false)
   throw fail('spark-replay-ttn-invalid');
 }else{
  if(event.revision!==event.expectedRevision+1||
    (event.type==='arrive'&&(intent.wantArrived!==true||
     event.logId!==''||event.volume!==0||event.isGAI!==false))||
    (event.type==='load'&&event.logId!=='load_'+event.operationId))
   throw fail('spark-replay-cycle-invalid');
 }
 return {...event,serverAt:checkedTime(event.at)};
}
export function validateSparkFrozenHistory({metadata,owner,truckDocuments,statusDocuments,
 maxTrucks=200}={}){
 if(!Number.isSafeInteger(maxTrucks)||maxTrucks<1||maxTrucks>200)
  throw fail('spark-replay-invalid-limit');
 const context=freezeContext(metadata,owner);
 if(!Array.isArray(truckDocuments)||!Array.isArray(statusDocuments)||
    truckDocuments.length>maxTrucks||statusDocuments.length>maxTrucks)
  throw fail('spark-replay-too-many-trucks');
 const trucks=new Map();
 for(const row of truckDocuments){
  if(!ID.test(row?.id||'')||trucks.has(row.id)||!obj(row.data)||
     row.data.id!==row.id||row.data.generation!==context.generation||
     !seq(row.data.sourceSequence)||row.data.sourceSequence>context.baseSequence)
   throw fail('spark-replay-truck-invalid');
  trucks.set(row.id,row.data);
 }
 const events=[],ids=new Set();
 for(const row of statusDocuments){
  const s=row?.data,truckId=row?.id;
  if(!ID.test(truckId||'')||!trucks.has(truckId)||!obj(s)||
     s.id!==truckId||s.generation!==context.generation||
     s.workspaceId!=='main_workspace'||!seq(s.sourceSequence)||
     s.sourceSequence>context.baseSequence||
     !seq(s.cycleRevision)||!seq(s.ttnRevision)||
     !obj(s.reserveHistory)||Object.keys(s.reserveHistory).length>256)
   throw fail('spark-replay-status-invalid');
  const ordered=Object.entries(s.reserveHistory).map(([id,event])=>{
   if(id!==event?.operationId)throw fail('spark-replay-key-mismatch');
   return event;
  }).sort((a,b)=>a.ordinal-b.ordinal);
  let cycle=s.cycleRevision-ordered.filter(x=>x.type!=='ttn').length;
  let ttn=s.ttnRevision-ordered.filter(x=>x.type==='ttn').length;
  if(cycle<0||ttn<0)throw fail('spark-replay-inconsistent-revision');
  let at=0;
  for(let i=0;i<ordered.length;i++){
   const raw=ordered[i],event=verifyIntent(raw,raw.uid,truckId,context);
   if(event.ordinal!==i+1||event.shiftId!==s.shiftId||
      event.serverAt<at||ids.has(event.operationId))
    throw fail('spark-replay-out-of-order');
   ids.add(event.operationId);at=event.serverAt;
   if(event.expectedRevision!==cycle)throw fail('spark-replay-cycle-diverged');
   if(event.type==='ttn'){
    if(event.expectedTtnRevision!==ttn)throw fail('spark-replay-ttn-diverged');
    ttn++;
   }else cycle++;
   if(event.type==='load'){
    const truck=trucks.get(truckId);
    if(event.isGAI!==truck.isGAI||event.volume!==truck.volume)
     throw fail('spark-replay-volume-diverged');
   }
   events.push(event);
  }
  if(cycle!==s.cycleRevision||ttn!==s.ttnRevision||
    (ordered.length&&s.lastOperationId!==ordered.at(-1).operationId))
   throw fail('spark-replay-final-status-diverged');
 }
 events.sort((a,b)=>a.serverAt-b.serverAt||
  a.truckId.localeCompare(b.truckId,'en')||a.ordinal-b.ordinal);
 const digest=hash(canonical(events.map(({at,...e})=>e)));
 return Object.freeze({format:'spark-typed-replay-manifest',version:1,
  ...context,eventCount:events.length,sha256:digest,events});
}
// Cheap per-operation owner check (two document reads, zero collection scans).
// The full immutable manifest is frozen and fingerprinted during SQL staging,
// then independently re-inspected before any subsequent handback.
export async function readFrozenSparkContext({firestore,projectId}={}){
 assertTestProject(projectId);
 if(!firestore||typeof firestore.doc!=='function')
  throw fail('spark-replay-invalid-firestore');
 const [m,o]=await Promise.all([
  firestore.doc(REPLICA_DOC).get(),firestore.doc(OWNER_DOC).get()]);
 return freezeContext(snap(m),snap(o));
}

export async function inspectFrozenSparkHistory({firestore,projectId,maxTrucks=200}={}){
 assertTestProject(projectId);
 if(!firestore||typeof firestore.doc!=='function'||typeof firestore.collection!=='function')
  throw fail('spark-replay-invalid-firestore');
 const read=async()=>{const [m,o]=await Promise.all([
  firestore.doc(REPLICA_DOC).get(),firestore.doc(OWNER_DOC).get()]);
  return {metadata:snap(m),owner:snap(o)};
 };
 const before=await read();
 const context=freezeContext(before.metadata,before.owner);
 const prefix=REPLICA_DOC+'/';
 const [trucks,statuses]=await Promise.all([
  firestore.collection(prefix+'typed_trucks_'+context.generation).get(),
  firestore.collection(prefix+'typed_status_'+context.generation).get()
 ]);
 const manifest=validateSparkFrozenHistory({metadata:before.metadata,owner:before.owner,
  maxTrucks,truckDocuments:trucks.docs.map(d=>({id:d.id,data:d.data()})),
  statusDocuments:statuses.docs.map(d=>({id:d.id,data:d.data()}))});
 const after=await read();
 const confirmed=freezeContext(after.metadata,after.owner);
 if(canonical(context)!==canonical(confirmed))
  throw fail('spark-replay-ownership-changed-during-inspection');
 return manifest;
}
