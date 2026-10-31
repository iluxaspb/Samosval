// Experimental direct Firestore Spark LINE writer. One atomic STATUS document
// update contains both the new state and a bounded immutable operation journal.
// No Cloud Run, no separate client-written receipt or log. NOT enabled in PWA.
export class SparkLineWriteError extends Error{
 constructor(code,{retryable=false,uncertain=false}={}){
  super(code);this.name='SparkLineWriteError';
  Object.assign(this,{code,retryable,uncertain});
 }
}
const bad=(code,opts)=>new SparkLineWriteError(code,opts);
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const GEN=/^[0-9a-f]{24}$/;
const ROOT='samosval_test_replica/v1',OWNER='samosval_test_replica/write_owner';
const PROJECT='samosval-offline';
export const MAX_SPARK_RESERVE_HISTORY=256;
const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):
 Array.isArray(x)?'['+x.map(canonical).join(',')+']':
 '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
async function hash(input,cryptoImpl){
 if(!cryptoImpl?.subtle?.digest)throw bad('spark-crypto-unavailable');
 const bytes=new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',
  new TextEncoder().encode(input)));
 return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const millis=x=>x?.toMillis?.()??(x instanceof Date?x.getTime():null);
const dataOf=s=>s?.exists?s.data():null;
function certify(meta,owner){
 if(meta?.protocol!==1||meta.channel!=='test'||meta.projectId!==PROJECT||
    !GEN.test(meta.generation||'')||meta.readyForFailover!==true||
    !integer(meta.lastSequence)||owner?.protocol!==1||
    owner.projectId!==PROJECT||owner.owner!=='firebase'||
    owner.holder!=='firebase_reserve'||owner.generation!==meta.generation||
    !integer(owner.observedSequence)||owner.observedSequence!==meta.lastSequence||
    !integer(owner.epoch)||owner.epoch<1||
    !integer(owner.reserveSequence)||!record(owner.pending)||
    Object.keys(owner.pending).length!==0)
  throw bad('spark-writer-not-certified',{retryable:true});
 return {generation:meta.generation,epoch:owner.epoch,sequence:meta.lastSequence};
}
export function createSparkLineWriter({firestore,getUser,serverTimestamp,
 cryptoImpl=globalThis.crypto,clock=Date.now,onDiagnostic=()=>{}}={}){
 if(!firestore||firestore.app?.options?.projectId!==PROJECT||
    typeof firestore.doc!=='function'||typeof firestore.runTransaction!=='function'||
    typeof getUser!=='function'||typeof serverTimestamp!=='function'||
    typeof clock!=='function'||typeof onDiagnostic!=='function')
  throw new TypeError('spark-line-writer-invalid-options');
 const sessionUser=getUser(),uid=sessionUser?.uid;
 if(!validId(uid))throw bad('spark-auth-required');
 let stopped=false;
 function guard(){
  if(stopped||getUser()!==sessionUser||sessionUser.uid!==uid)
   throw bad('spark-session-changed');
 }
 async function submitLine(input,{operationScope}={}){
  guard();
  if(!record(input)||!validId(input.id)||!validId(input.truckId)||
    !validId(input.shiftId)||!['arrive','load','ttn'].includes(input.type)||
    !integer(input.expectedRevision)||!integer(input.arrivalTimestamp)||
    !integer(input.lastLoadTimestamp)||!integer(input.createdAt)||
    input.createdAt>clock()+300000||
    !Number.isSafeInteger(input.cycleMinutes)||
    input.cycleMinutes<15||input.cycleMinutes>10080||
    (input.type==='arrive'&&input.wantArrived!==true)||
    (input.type==='ttn'&&(!integer(input.expectedTtnRevision)||
     typeof input.collect!=='boolean')))
   throw bad('spark-invalid-operation');
  if(typeof operationScope!=='string'||!operationScope.includes(uid))
   throw bad('spark-outbox-scope-mismatch');
  const requestHash=await hash(canonical(input),cryptoImpl);
  guard();
  let submitted=false;
  try{
   const result=await firestore.runTransaction(async tx=>{
    guard();
    const [metaSnapshot,ownerSnapshot]=await Promise.all([
     tx.get(firestore.doc(ROOT)),tx.get(firestore.doc(OWNER))
    ]);
    const state=certify(dataOf(metaSnapshot),dataOf(ownerSnapshot));
    const prefix=ROOT+'/',gen=state.generation;
    const [aclSnap,configSnap,truckSnap,statusSnap]=await Promise.all([
     tx.get(firestore.doc(prefix+'access_'+gen+'/'+uid)),
     tx.get(firestore.doc(prefix+'typed_config_'+gen+'/active')),
     tx.get(firestore.doc(prefix+'typed_trucks_'+gen+'/'+input.truckId)),
     tx.get(firestore.doc(prefix+'typed_status_'+gen+'/'+input.truckId))
    ]);
    const acl=dataOf(aclSnap),config=dataOf(configSnap);
    const truck=dataOf(truckSnap),before=dataOf(statusSnap);
    if(!acl||acl.uid!==uid||acl.active!==true||
       acl.generation!==gen||!integer(acl.sourceSequence)||
       acl.sourceSequence>state.sequence||
       !acl.permissions?.actions?.includes?.('action_'+input.type))
     throw bad('spark-permission-denied');
    if(!config||config.active!==true||config.generation!==gen||
       config.shiftId!==input.shiftId||!integer(config.sourceSequence)||
       config.sourceSequence>state.sequence||!truck||truck.id!==input.truckId||
       !before||before.shiftId!==input.shiftId||before.onLine!==true||
       before.generation!==gen||!integer(before.sourceSequence)||
       before.sourceSequence>state.sequence)
     throw bad('spark-line-stale',{retryable:true});
    if(!record(before.reserveHistory)||Object.keys(before.reserveHistory).length>MAX_SPARK_RESERVE_HISTORY)
     throw bad('spark-reserve-history-invalid');
    const previous=before.reserveHistory[input.id]||null;
    if(previous){
     if(previous.uid!==uid||previous.requestHash!==requestHash||
        previous.epoch!==state.epoch||
        !integer(previous.revision)||before.cycleRevision<previous.revision)
      throw bad('spark-operation-id-reused');
     return {outcome:'confirmed',replayed:true,operationId:input.id,
      revision:previous.revision,logId:previous.logId||''};
    }
    if(Object.keys(before.reserveHistory).length>=MAX_SPARK_RESERVE_HISTORY)
     throw bad('spark-reserve-history-full',{retryable:true});
    if(before.cycleRevision!==input.expectedRevision)
     throw bad('spark-line-stale',{retryable:true});
    const lastLoad=millis(before.lastLoadAt)||0;
    const arrival=millis(before.arrivedAt)||0;
    if(input.lastLoadTimestamp!==lastLoad)throw bad('spark-last-load-changed',{retryable:true});
    if(input.type==='ttn'){
     if(before.ttnRevision!==input.expectedTtnRevision||
        Boolean(before.ttnStatus)===input.collect)
      throw bad('spark-ttn-changed',{retryable:true});
    }else if(input.type==='arrive'){
     if(before.arrivedAt!==null||input.arrivalTimestamp!==0)
      throw bad('spark-arrival-changed',{retryable:true});
    }else if(!arrival||arrival!==input.arrivalTimestamp)
     throw bad('spark-duplicate-or-arrival-changed',{retryable:true});
    const eventAt=serverTimestamp();
    const revision=before.cycleRevision+(input.type==='ttn'?0:1);
    const event={
     operationId:input.id,uid,type:input.type,epoch:state.epoch,
     generation:gen,truckId:input.truckId,shiftId:input.shiftId,
     expectedRevision:input.expectedRevision,revision,
     cycleMinutes:input.cycleMinutes,requestHash,
     at:eventAt,logId:input.type==='load'?'load_'+input.id:'',
     volume:input.type==='load'?(truck.isGAI===true?0:truck.volume):0,
     isGAI:input.type==='load'&&truck.isGAI===true,
     ...(input.type==='ttn'?{
      collect:input.collect,expectedTtnRevision:input.expectedTtnRevision,
      ttnRevision:before.ttnRevision+1
     }:{})
    };
    const changes={
     lastOperationId:input.id,lastActionType:input.type,lastActorUid:uid,
     reserveHistory:{...before.reserveHistory,[input.id]:event}
    };
    if(input.type==='ttn'){
     changes.ttnRevision=before.ttnRevision+1;
     changes.ttnStatus=input.collect?
      (before.loadedAfterArrive&&before.lastLogId?true:'pending'):null;
     changes.ttnLogId=input.collect&&before.loadedAfterArrive?
      before.lastLogId:'';
     changes.ttnByUid=input.collect?uid:'';
    }else{
     changes.cycleRevision=revision;
     changes.arrivedAt=input.type==='arrive'?eventAt:null;
     changes.lastLoadAt=input.type==='load'?eventAt:before.lastLoadAt;
     changes.lastLogId=input.type==='load'?event.logId:before.lastLogId;
     changes.loadedAfterArrive=input.type==='load';
     if(input.type==='load'&&before.ttnStatus==='pending'){
      changes.ttnStatus=true;changes.ttnLogId=event.logId;
     }
    }
    submitted=true;
    tx.update(firestore.doc(prefix+'typed_status_'+gen+'/'+input.truckId),changes);
    return {outcome:'confirmed',operationId:input.id,
     revision,logId:event.logId,
     ...(input.type==='ttn'?{ttnRevision:before.ttnRevision+1}:{})};
   });
   guard();
   return result;
  }catch(e){
   if(e instanceof SparkLineWriteError)throw e;
   try{onDiagnostic(e);}catch{}
   throw bad('spark-transaction-unavailable',{retryable:true,uncertain:submitted});
  }
 }
 return Object.freeze({uid,submitLine,stop:()=>{stopped=true;}});
}
