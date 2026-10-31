// Experimental direct Web SDK LINE writer for Firestore Spark (no Cloud Run).
// NOT enabled in the published PWA. A Firestore Security Rules transaction
// MUST independently revalidate every field and cross-document invariant.
// This JS is never a source of authority; it only prepares immutable intents.
export class SparkLineWriteError extends Error {
 constructor(code,{retryable=false,uncertain=false}={}){
  super(code);this.name='SparkLineWriteError';
  Object.assign(this,{code,retryable,uncertain});
 }
}
const bad=(code,options)=>new SparkLineWriteError(code,options);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const seq=x=>Number.isSafeInteger(x)&&x>=0;
const GEN=/^[0-9a-f]{24}$/;
const ROOT='samosval_test_replica/v1';
const OWNER='samosval_test_replica/write_owner';
const PROJECT='samosval-offline';
const WORKSPACE='main_workspace';
const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):
 Array.isArray(x)?'['+x.map(canonical).join(',')+']':
 '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
async function hash(input,cryptoImpl){
 if(!cryptoImpl?.subtle?.digest)throw bad('spark-crypto-unavailable');
 const bytes=new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',
  new TextEncoder().encode(input)));
 return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const time=x=>x?.toMillis?.()??(x instanceof Date?x.getTime():null);
function certified(meta,owner){
 if(meta?.protocol!==1||meta.channel!=='test'||meta.projectId!==PROJECT||
    !GEN.test(meta.generation||'')||meta.readyForFailover!==true||
    !seq(meta.lastSequence)||owner?.protocol!==1||
    owner.projectId!==PROJECT||owner.owner!=='firebase'||
    owner.holder!=='firebase_reserve'||owner.generation!==meta.generation||
    !seq(owner.observedSequence)||owner.observedSequence!==meta.lastSequence||
    !Number.isSafeInteger(owner.epoch)||owner.epoch<1||
    !Number.isSafeInteger(owner.reserveSequence)||owner.reserveSequence<0||
    !obj(owner.pending)||Object.keys(owner.pending).length!==0)
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
 const current=getUser(),uid=current?.uid;
 if(!id(uid))throw bad('spark-auth-required');
 let stopped=false;
 function guard(){
  if(stopped||getUser()!==current||current.uid!==uid)
   throw bad('spark-session-changed');
 }
 async function submitLine(input,{operationScope}={}){
  guard();
  if(!obj(input)||!id(input.id)||!id(input.truckId)||!id(input.shiftId)||
    !['arrive','load'].includes(input.type)||!seq(input.expectedRevision)||
    !seq(input.arrivalTimestamp)||!seq(input.lastLoadTimestamp)||
    !Number.isFinite(input.cycleMinutes)||input.cycleMinutes<15||
    input.cycleMinutes>10080||!seq(input.createdAt)||
    input.createdAt>clock()+300000||(input.type==='arrive'&&input.wantArrived!==true))
   throw bad('spark-invalid-operation');
  // Scope preservation is mandatory: a previously persisted NAS outbox ID
  // must be retried without changing its payload or another user's session.
  if(typeof operationScope!=='string'||!operationScope.includes(uid))
   throw bad('spark-outbox-scope-mismatch');
  const requestHash=await hash(canonical(input),cryptoImpl);
  guard();
  let submitted=false;
  try{
   const result=await firestore.runTransaction(async tx=>{
    guard();
    const [metaSnap,ownerSnap]=await Promise.all([
     tx.get(firestore.doc(ROOT)),
     tx.get(firestore.doc(OWNER))
    ]);
    const state=certified(metaSnap.exists?metaSnap.data():null,
     ownerSnap.exists?ownerSnap.data():null);
    const prefix=ROOT+'/',g=state.generation;
    const docs={
     acl:firestore.doc(prefix+'access_'+g+'/'+uid),
     config:firestore.doc(prefix+'typed_config_'+g+'/active'),
     truck:firestore.doc(prefix+'typed_trucks_'+g+'/'+input.truckId),
     status:firestore.doc(prefix+'typed_status_'+g+'/'+input.truckId),
     receipt:firestore.doc(prefix+'typed_ops_'+g+'/'+input.id)
    };
    const [aclSnap,configSnap,truckSnap,statusSnap,receiptSnap]=await Promise.all([
     tx.get(docs.acl),tx.get(docs.config),tx.get(docs.truck),
     tx.get(docs.status),tx.get(docs.receipt)
    ]);
    const acl=aclSnap.exists?aclSnap.data():null;
    const config=configSnap.exists?configSnap.data():null;
    const truck=truckSnap.exists?truckSnap.data():null;
    const before=statusSnap.exists?statusSnap.data():null;
    if(!acl||acl.uid!==uid||acl.generation!==g||acl.active!==true||
       !seq(acl.sourceSequence)||acl.sourceSequence>state.sequence||
       !acl.permissions?.actions?.includes?.('action_'+input.type))
     throw bad('spark-permission-denied');
    // Idempotency wins over the later status revision. The previous write
    // may have succeeded even when its HTTP/WebSocket response was lost.
    if(receiptSnap.exists){
     const r=receiptSnap.data();
     if(r.uid!==uid||r.requestHash!==requestHash||r.epoch!==state.epoch)
      throw bad('spark-operation-id-reused');
     // A signed-in client can submit a well-formed intent independently.
     // A receipt alone is NOT evidence of an applied trip. Only an atomic
     // status revision with that operation ID proves confirmation.
     if(before?.lastOperationId!==input.id||
        before.cycleRevision!==input.expectedRevision+1)
      throw bad('spark-intent-not-confirmed',{retryable:true,uncertain:true});
     return {outcome:'confirmed',replayed:true,operationId:input.id,
      typedStatus:before};
    }
    if(!config||config.active!==true||config.generation!==g||
       config.shiftId!==input.shiftId||!seq(config.sourceSequence)||
       config.sourceSequence>state.sequence||!truck||truck.id!==input.truckId||
       !before||before.shiftId!==input.shiftId||before.onLine!==true||
       before.generation!==g||before.cycleRevision!==input.expectedRevision||
       !seq(before.sourceSequence)||before.sourceSequence>state.sequence)
     throw bad('spark-line-stale',{retryable:true});
    const previousLoad=time(before.lastLoadAt)||0;
    const arrival=time(before.arrivedAt)||0;
    if(input.type==='arrive'){
     if(before.arrivedAt!==null||input.arrivalTimestamp!==0||
        input.lastLoadTimestamp!==previousLoad)
      throw bad('spark-arrival-changed',{retryable:true});
    }else if(!arrival||input.arrivalTimestamp!==arrival||
      input.lastLoadTimestamp!==previousLoad||
      input.createdAt<arrival)
      throw bad('spark-duplicate-or-arrival-changed',{retryable:true});
    const minimum=Math.max(15,config.cycleMinutes,input.cycleMinutes)*60000;
    if(previousLoad&&clock()-previousLoad<minimum)
     throw bad('spark-cycle-time',{retryable:true});
    const stamp=serverTimestamp();
    const event={
     protocol:1,projectId:PROJECT,generation:g,epoch:state.epoch,
     uid,operationId:input.id,truckId:input.truckId,shiftId:input.shiftId,
     type:input.type,expectedRevision:input.expectedRevision,
     cycleMinutes:input.cycleMinutes,requestHash,
     at:stamp,logId:input.type==='load'?'load_'+input.id:'',
     // The immutable receipt itself is the audit/load ledger record. Do not
     // create a third document: that exceeds the Spark rules evaluation
     // budget and spends an extra Firestore write on every trip.
     volume:input.type==='load'?(truck.isGAI===true?0:truck.volume):0,
     isGAI:input.type==='load'&&truck.isGAI===true
    };
    const changes={
     cycleRevision:before.cycleRevision+1,
     arrivedAt:input.type==='arrive'?stamp:null,
     lastLoadAt:input.type==='load'?stamp:before.lastLoadAt,
     lastLogId:input.type==='load'?event.logId:before.lastLogId,
     loadedAfterArrive:input.type==='load',
     lastOperationId:input.id,lastActionType:input.type,lastActorUid:uid
    };
    // Two writes, one atomic transaction: status and immutable operation.
    // A LOAD operation is also the permanent log record.
    tx.update(docs.status,changes);
    tx.set(docs.receipt,event);
    submitted=true;
    return {outcome:'confirmed',operationId:input.id,
     expectedRevision:input.expectedRevision+1};
   });
   guard();
   return result;
  }catch(e){
   if(e instanceof SparkLineWriteError)throw e;
   // The optional diagnostic hook is for isolated acceptance tests only.
   // Never surface raw Firestore errors to end-users or durable local logs.
   try{onDiagnostic(e);}catch{}
   // Firestore may commit but lose the acknowledgement. Never create a new
   // operation ID or automatically retry a different server here.
   throw bad('spark-transaction-unavailable',{retryable:true,uncertain:submitted});
  }
 }
 return Object.freeze({uid,submitLine,stop:()=>{stopped=true;}});
}
