// TEST-only direct Spark LINE view: combine the immutable PostgreSQL baseline
// with the confirmed typed Firestore status journal. Without this overlay,
// reserve LOADs would be committed but invisible to the phone.
// The owner and per-UID ACL are verified by the underlying raw line reader;
// typed docs are read from the Firestore SERVER, never an offline cache.
import {createSparkLineReader} from './spark-line-reader.mjs';
import {createSparkOwnerReader,SparkOwnerError} from './spark-owner.mjs';

const ROOT='samosval_test_replica/v1',WS='main_workspace',PROJECT='samosval-offline';
const ID=/^[A-Za-z0-9_-]{1,128}$/,GEN=/^[a-f0-9]{24}$/;
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const seq=x=>Number.isSafeInteger(x)&&x>=0;
const bad=code=>new SparkOwnerError(code);
const moment=x=>x?.toMillis?.()??(x instanceof Date?x.getTime():null);
function lineTime(ms){
 return new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',
  minute:'2-digit',hourCycle:'h23'}).format(new Date(ms));
}
function validated(status,truck,owner,shiftId){
 if(!obj(status)||status.protocol!==1||status.projectId!==PROJECT||
    status.generation!==owner.generation||status.workspaceId!==WS||
    status.id!==truck.id||!ID.test(status.id)||status.shiftId!==shiftId||
    !seq(status.cycleRevision)||!seq(status.ttnRevision)||
    !seq(status.sourceSequence)||status.sourceSequence>owner.confirmedSequence||
    !obj(status.reserveHistory)||Object.keys(status.reserveHistory).length>256)
  throw bad('spark-typed-status-invalid');
 let ordinal=0,lastAt=0;
 const seen=new Set(),loads=[];
 const events=Object.entries(status.reserveHistory).map(([key,event])=>{
  if(!obj(event)||key!==event.operationId||!ID.test(key)||
     event.truckId!==truck.id||event.shiftId!==shiftId||
     event.generation!==owner.generation||!seq(event.ordinal)||
     !['arrive','load','ttn'].includes(event.type)||!ID.test(event.uid||'')||
     !seq(event.revision)||!seq(event.expectedRevision)||
     !seq(event.epoch)||event.epoch>owner.epoch)
   throw bad('spark-typed-event-invalid');
  const at=moment(event.at);
  if(!seq(at)||at===0)throw bad('spark-typed-event-time-invalid');
  return {...event,serverAt:at};
 }).sort((a,b)=>a.ordinal-b.ordinal);
 for(const e of events){
  if(e.ordinal!==++ordinal||e.serverAt<lastAt||seen.has(e.operationId))
   throw bad('spark-typed-history-order-invalid');
  seen.add(e.operationId);lastAt=e.serverAt;
  if(e.type==='load'){
   if(e.logId!=='load_'+e.operationId||!seq(e.volume)||
      e.isGAI!==(truck.isGAI===true))
    throw bad('spark-typed-load-invalid');
   loads.push(e);
  }
 }
 const atArrival=moment(status.arrivedAt),atLoad=moment(status.lastLoadAt);
 if((atArrival!==null&&(!seq(atArrival)||atArrival===0))||
    (atLoad!==null&&(!seq(atLoad)||atLoad===0))||
    (status.lastLogId&&!ID.test(status.lastLogId))||
    (status.ttnLogId&&!ID.test(status.ttnLogId)))
  throw bad('spark-typed-state-time-invalid');
 // The authoritative typed fields may reflect a reserved arrival or load.
 // Baseline rows cannot be trusted to reflect these new events.
 return {
  status: {
   id:status.id,shiftId,
   onLine:status.onLine===true,
   cycleRevision:status.cycleRevision,ttnRevision:status.ttnRevision,
   arriveStatus:atArrival===null?null:lineTime(atArrival),
   arriveTimestamp:atArrival,arriveBy:atArrival?status.lastActorUid||'':null,
   lastLoadTimestamp:atLoad,
   lastLoadLogId:status.lastLogId||null,
   lastLoadBy:status.lastActionType==='load'?status.lastActorUid||'':null,
   loadedAfterArrive:status.loadedAfterArrive===true,
   ttnStatus:status.ttnStatus??null,
   ttnLogId:status.ttnLogId||null,
   ttnBy:status.ttnByUid||null,
   lastOperationId:status.lastOperationId||''
  },
  events,loads
 };
}
export function createSparkTypedLineReader({firestore,getUser,ownerReader,rawReader,
 maxTrucks=200}={}){
 if(!firestore?.doc||firestore.app?.options?.projectId!==PROJECT||
    typeof getUser!=='function'||!seq(maxTrucks)||maxTrucks<1||maxTrucks>200)
  throw new TypeError('spark-typed-reader-invalid-options');
 const initial=getUser(),uid=initial?.uid;
 if(!ID.test(uid||''))throw bad('spark-auth-required');
 const authority=ownerReader||createSparkOwnerReader({firestore,getUser});
 const baseline=rawReader||createSparkLineReader({firestore,getUser,ownerReader:authority});
 let stopped=false;
 function guard(){
  if(stopped||getUser()!==initial||initial.uid!==uid)
   throw bad('spark-session-changed');
 }
 async function owner(){
  guard();
  const result=await authority.readOwner();
  guard();
  if(result.owner!=='firebase'||!result.readyForFailover||
     !GEN.test(result.generation))throw bad('spark-typed-owner-not-certified');
  return result;
 }
 async function doc(path){
  guard();
  let result;
  try{result=await firestore.doc(path).get({source:'server'});}
  catch{throw bad('spark-typed-server-unavailable');}
  guard();
  if(!result?.exists)throw bad('spark-typed-document-missing');
  return result.data();
 }
 async function readLine(){
  const before=await owner();
  const source=await baseline.readLine(); // server-side ACL and hash checks
  guard();
  if(source.workspaceId!==WS||source.source!=='firebase'||
     source.trucks.length>maxTrucks||!source.shift?.id||!source.shift.isActive)
   throw bad('spark-typed-shift-unavailable');
  const path=ROOT+'/typed_';
  const config=await doc(path+'config_'+before.generation+'/active');
  if(!obj(config)||config.protocol!==1||config.projectId!==PROJECT||
     config.generation!==before.generation||config.workspaceId!==WS||
     !config.active||config.shiftId!==source.shift.id||
     config.cycleMinutes!==source.cycleMinutes||
     !seq(config.sourceSequence)||config.sourceSequence>before.confirmedSequence)
   throw bad('spark-typed-config-diverged');
  const byTruck=new Map(source.trucks.map(truck=>[truck.id,truck]));
  if(byTruck.size!==source.trucks.length||source.statuses.length>maxTrucks)
   throw bad('spark-typed-duplicate-truck');
  const rawIds=new Set(source.statuses.map(s=>s.id));
  const statuses=[],reserveLogs=[],operations=[];
  // Firestore Rules disallow list() of typed status docs; fetch only verified IDs
  // in small concurrent groups to avoid large read spikes.
  for(let index=0;index<source.statuses.length;index+=8){
   const batch=source.statuses.slice(index,index+8);
   const values=await Promise.all(batch.map(async row=>{
    const truck=byTruck.get(row.id);
    if(!truck||!ID.test(row.id)||!rawIds.has(row.id))
     throw bad('spark-typed-truck-missing');
    const typed=await doc(path+'status_'+before.generation+'/'+row.id);
    return {row,truck,typed};
   }));
   for(const {row,truck,typed} of values){
    const rendered=validated(typed,truck,before,source.shift.id);
    statuses.push({...row,...rendered.status});
    for(const e of rendered.events)operations.push(e.operationId);
    for(const e of rendered.loads){
     const log={
      id:e.logId,shiftId:e.shiftId,truckId:e.truckId,
      truckName:[truck.brand,truck.number].filter(Boolean).join(' '),
      volume:e.volume,timeStr:lineTime(e.serverAt),timestamp:e.serverAt,
      arrivalTimestamp:e.intent?.arrivalTimestamp||null,
      createdBy:e.uid,createdByEmail:'',isGAI:e.isGAI===true,
      comment:'',clientOperationId:e.operationId,source:'firebase'
     };
     reserveLogs.push(log);
    }
   }
  }
  const logs=new Map(source.logs.map(log=>[log.id,log]));
  for(const log of reserveLogs){
   if(logs.has(log.id))throw bad('spark-typed-duplicate-load-id');
   logs.set(log.id,log);
  }
  const after=await owner();guard();
  if(before.generation!==after.generation||before.epoch!==after.epoch||
     before.confirmedSequence!==after.confirmedSequence||
     before.reserveSequence!==after.reserveSequence||before.owner!==after.owner)
   throw bad('spark-typed-owner-changed-during-read');
  return Object.freeze({
   ...source,statuses,logs:[...logs.values()],reserveOperations:operations,
   typedGeneration:before.generation,typedOwnerEpoch:before.epoch
  });
 }
 // One native Firestore listener per active truck. No periodic collection
 // scans while Firebase is owner. Listeners only WAKE the verified reader;
 // their cache snapshots are NEVER considered authoritative.
 function watchStatuses(snapshot,onChange,onError=()=>{}){
  guard();
  if(typeof onChange!=='function'||typeof onError!=='function'||
     snapshot?.typedGeneration===undefined||snapshot?.source!=='firebase'||
     !Array.isArray(snapshot.statuses))throw TypeError('spark-watch-invalid');
  const ids=[...new Set(snapshot.statuses.map(row=>row.id))];
  if(ids.length>maxTrucks)throw bad('spark-watch-too-many-trucks');
  const stops=[];
  for(const id of ids){
   if(!ID.test(id))throw bad('spark-watch-truck-id-invalid');
   const ref=firestore.doc(ROOT+'/typed_status_'+snapshot.typedGeneration+'/'+id);
   if(typeof ref.onSnapshot!=='function')throw bad('spark-watch-listeners-unavailable');
   let initialized=false;
   stops.push(ref.onSnapshot(s=>{
    if(stopped)return;
    // Initial cache/server deliveries often duplicate the first verified read.
    if(!initialized){initialized=true;return;}
    if(s.metadata?.fromCache===true)return;
    onChange();
   },onError));
  }
  return ()=>{for(const stop of stops)stop();};
 }
 return Object.freeze({
  uid,readLine,readSession:()=>baseline.readSession(),watchStatuses,
  stop(){stopped=true;if(!rawReader)baseline.stop();if(!ownerReader)authority.stop();}
 });
}
