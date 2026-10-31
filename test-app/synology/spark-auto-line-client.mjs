// TEST-only phone router: Synology is primary; direct Firestore Web SDK
// handles ARRIVE/LOAD/TTN only after a certified Firebase owner epoch.
// A NAS timeout NEVER promotes Firebase. No Cloud Run, REST reserve proxy,
// or localStorage setting can authorize a second writer.
export class SparkAutoLineError extends Error{
 constructor(code,{retryable=true,uncertain=false}={}){
  super(code);this.name='SparkAutoLineError';
  Object.assign(this,{code,retryable,uncertain});
 }
}
const bad=(code,props)=>new SparkAutoLineError(code,props);
const same=(a,b)=>a&&b&&a.owner===b.owner&&a.epoch===b.epoch&&
 a.generation===b.generation&&a.confirmedSequence===b.confirmedSequence;
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const OWNER='samosval_test_replica/write_owner',META='samosval_test_replica/v1';

export function createSparkAutoLineClient({nasClient,reader,writer,ownerReader,
 firestore,getUser,promoter=null,onProviderChange=()=>{},clock=Date.now,
 heartbeatMs=120000}={}){
 if(!nasClient||nasClient.workspaceId!=='main_workspace'||!nasClient.scope||
    !nasClient.uid||typeof nasClient.submitLine!=='function'||
    typeof nasClient.subscribeLine!=='function'||typeof nasClient.stop!=='function'||
    !reader||typeof reader.readSession!=='function'||typeof reader.readLine!=='function'||
    typeof reader.watchStatuses!=='function'||typeof reader.stop!=='function'||
    !writer||typeof writer.submitLine!=='function'||typeof writer.stop!=='function'||
    !ownerReader||typeof ownerReader.readOwner!=='function'||
    !firestore?.doc||typeof getUser!=='function'||
    typeof onProviderChange!=='function'||typeof clock!=='function'||
    !Number.isSafeInteger(heartbeatMs)||heartbeatMs<30000||heartbeatMs>300000)
  throw new TypeError('spark-auto-invalid-options');
 if(promoter!==null&&typeof promoter.tryPromote!=='function')
  throw new TypeError('spark-auto-promoter-invalid');
 if(firestore.app?.options?.projectId!=='samosval-offline')
  throw new TypeError('spark-test-project-required');
 const user=getUser(),uid=user?.uid;
 if(uid!==nasClient.uid||reader.uid!==uid||writer.uid!==uid)
  throw bad('spark-auto-session-mismatch',{retryable:false});
 let stopped=false,provider=null,ownerState=null;
 const closes=new Set();
 function guard(){
  if(stopped||getUser()!==user||user.uid!==uid)
   throw bad('spark-auto-session-changed',{retryable:false});
 }
 function publish(next){
  guard();
  if(provider!==next){provider=next;onProviderChange(next);}
 }
 function invalidate(){
  ownerState=null;
  // A previously displayed NAS/Firebase state is not permission to keep
  // showing editable controls after an unverified ownership transition.
  if(!stopped&&getUser()===user)publish(null);
 }
 async function authority(){
  guard();
  let state;
  try{state=await ownerReader.readOwner();}
  catch(error){invalidate();throw error;}
  guard();
  if(!state||state.projectId!=='samosval-offline'||
     !['firebase','synology','handoff','reconciling'].includes(state.owner)){
   invalidate();throw bad('spark-auto-owner-invalid');
  }
  if(['handoff','reconciling'].includes(state.owner)){
   invalidate();throw bad('spark-auto-handoff-active');
  }
  if(state.owner==='firebase'&&!state.readyForFailover){
   invalidate();throw bad('spark-auto-firebase-not-certified');
  }
  if(state.owner==='synology'&&state.readyForFailover){
   invalidate();throw bad('spark-auto-owner-inconsistent');
  }
  return state;
 }
 async function verifiedRead(kind){
  const a=await authority();
  const api=a.owner==='synology'?nasClient:reader;
  const value=await api[kind]();
  const b=await authority();
  guard();
  if(!same(a,b)){
   invalidate();throw bad('spark-auto-owner-changed-during-read');
  }
  ownerState=b;publish(a.owner);
  return value;
 }
 async function submitLine(operation,{operationScope}={}){
  guard();
  if(operationScope!==nasClient.scope)
   throw bad('spark-auto-outbox-scope-mismatch',{retryable:false});
  if(!record(operation)||typeof operation.id!=='string'||
    !/^[A-Za-z0-9_-]{1,128}$/.test(operation.id))
   throw bad('spark-auto-invalid-operation',{retryable:false});
  const op=JSON.parse(JSON.stringify(operation));
  const a=await authority();
  if(a.owner==='firebase'&&!['arrive','load','ttn'].includes(op.type))
   throw bad('spark-auto-reserve-unsupported');
  let result;
  try{
   result=await (a.owner==='synology'?
    nasClient.submitLine(op,{operationScope}):
    writer.submitLine(op,{operationScope}));
  }catch(e){
   // Unknown outcomes retain the SAME durable offline operation ID.
   if(e?.retryable||e?.uncertain)throw e;
   throw e;
  }
  const b=await authority().catch(()=>{
   throw bad('spark-auto-write-result-uncertain',{uncertain:true});
  });
  if(!same(a,b)){
   invalidate();throw bad('spark-auto-owner-changed-after-write',{uncertain:true});
  }
  if(!record(result)||result.outcome!=='confirmed'&&result.outcome!=='rejected')
   throw bad('spark-auto-write-result-invalid',{uncertain:true});
  ownerState=b;publish(a.owner);
  return result;
 }
 function subscribeLine({onSession,onSnapshot,onError,intervalMs=4000}={}){
  guard();
  if(![onSession,onSnapshot,onError].every(f=>typeof f==='function')||
     !Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>60000)
   throw new TypeError('spark-auto-subscription-invalid');
  let closed=false,timer=null,nasClose=null,typedClose=null,promotionTimer=null,unsubscribe=[];
  let inFlight=false,scheduled=false,again=false,kind='all',lastSnapshot=null;
  const changedTrucks=new Set();
  const ownerRefs=[firestore.doc(META),firestore.doc(OWNER)];
  const accessPath=gen=>META+'/access_'+gen+'/'+uid;
  let accessWatchGen=null,accessClose=null;
  function stopProvider(){
   nasClose?.();nasClose=null;
   typedClose?.();typedClose=null;
   clearTimeout(promotionTimer);promotionTimer=null;
   lastSnapshot=null;
  }
  function close(){
   if(closed)return;
   closed=true;clearTimeout(timer);
   stopProvider();
   accessClose?.();accessClose=null;
   for(const off of unsubscribe)off();
   closes.delete(close);
  }
  closes.add(close);
  function report(e){
   if(closed)return;
   try{onError(e);}catch{}
   if(e?.code==='spark-auto-session-changed'){close();return;}
  }
  function wake(request='all',delay=150,truckId=null){
   if(closed||stopped)return;
   if(request==='all'){kind='all';changedTrucks.clear();}
   else if(kind!=='all')kind=request;
   if(request==='line'&&truckId)changedTrucks.add(truckId);
   if(inFlight){again=true;return;}
   if(scheduled)return;
   scheduled=true;
   timer=setTimeout(()=>{scheduled=false;void refresh();},delay);
  }
  function schedulePromotion(state){
   clearTimeout(promotionTimer);promotionTimer=null;
   if(!promoter||!state||state.owner!=='synology'||
      state.promotionCertified!==true||
      !Number.isSafeInteger(state.leaseUntil))return;
   const millis=Math.max(0,state.leaseUntil+30000-clock()+250);
   promotionTimer=setTimeout(async()=>{
    if(closed||stopped)return;
    try{
     // No NAS timeout grants write permission. Firestore transaction AND
     // Security Rules independently verify the expired lease and SQL seal.
     const result=await promoter.tryPromote();
     if(result?.promoted)wake('all',0);
    }catch(e){report(e);}
   },Math.min(millis,2147483647));
  }
  function watchAccess(gen){
   if(accessWatchGen===gen)return;
   accessClose?.();accessClose=null;accessWatchGen=gen;
   const ref=firestore.doc(accessPath(gen));
   if(typeof ref.onSnapshot!=='function')return;
   let first=true;
   accessClose=ref.onSnapshot(s=>{
    if(first){first=false;return;}
    if(!s?.metadata?.fromCache)wake('all');
   },report);
  }
  function watchTyped(snapshot){
   const fingerprint=snapshot.typedGeneration+':'+snapshot.statuses.map(x=>x.id).sort().join('|');
   if(lastSnapshot===fingerprint)return;
   typedClose?.();typedClose=null;lastSnapshot=fingerprint;
   typedClose=reader.watchStatuses(snapshot,id=>wake('line',250,id),report);
  }
  async function refresh(){
   if(inFlight||closed||stopped)return;
   inFlight=true;
   const requestKind=kind,changedIds=[...changedTrucks];
   kind='line';changedTrucks.clear();
   try{
    const before=await authority();
    if(closed)return;
    // On ownership changes detach the previous provider BEFORE presenting a
    // new dataset. An error leaves both providers blocked, not a stale view.
    if(provider!==before.owner)stopProvider();
    if(before.owner==='synology'){
     accessClose?.();accessClose=null;accessWatchGen=null;
     const after=await authority();
     if(!same(before,after))throw bad('spark-auto-owner-changed-during-read');
     ownerState=after;publish('synology');
     schedulePromotion(after);
     if(!nasClose){
      const generation=before.generation,epoch=before.epoch;
      nasClose=nasClient.subscribeLine({
       intervalMs,onSession:session=>{
        if(closed||provider!=='synology'||ownerState?.generation!==generation||
           ownerState?.epoch!==epoch)return;
        onSession(session);
       },onSnapshot:snapshot=>{
        if(closed||provider!=='synology'||ownerState?.generation!==generation||
           ownerState?.epoch!==epoch)return;
        onSnapshot(snapshot);
       },onError:report
      });
     }
    }else{
     // Firestore mode is event-driven: no four-second Firestore polling.
     // Every delivered snapshot is re-checked with authoritative owner state.
     const session=await reader.readSession();
     if(closed)return;
     const validLine=session.identityReady&&session.profile?.status==='active'&&
      !session.profile.deleted&&session.permissions?.tabs?.includes('line');
     const snapshot=validLine?await reader.readLine(
      requestKind==='line'&&changedIds.length>0?
       {changedTruckIds:changedIds}:{}
     ):null;
     const after=await authority();
     if(!same(before,after))throw bad('spark-auto-owner-changed-during-read');
     if(closed)return;
     ownerState=after;publish('firebase');
     onSession(session);
     if(snapshot){onSnapshot(snapshot);watchTyped(snapshot);}
     else{typedClose?.();typedClose=null;lastSnapshot=null;}
     watchAccess(before.generation);
    }
   }catch(e){
    // Invalidate old provider immediately on any unresolved authority or
    // adapter failure. A timeout cannot force a Firebase promotion.
    stopProvider();ownerState=null;kind='all';changedTrucks.clear();
    if(!closed&&getUser()===user)publish(null);
    report(e);
   }finally{
    inFlight=false;
    if(again&&!closed){
     again=false;
     if(!scheduled){scheduled=true;timer=setTimeout(()=>{
      scheduled=false;void refresh();
     },100);}
    }
   }
  }
  try{
   for(const ref of ownerRefs){
    if(typeof ref.onSnapshot!=='function')throw bad('spark-auto-owner-listeners-required');
    let first=true;
    unsubscribe.push(ref.onSnapshot(s=>{
     if(first){first=false;return;}
     if(!s?.metadata?.fromCache)wake('all');
    },e=>{publish(null);report(e);wake('all',2000);}));
   }
   // A bounded heartbeat handles missed websocket notifications and browser
   // resume. It does NOT scan Firestore tables on every NAS polling cycle.
   const heartbeat=setInterval(()=>wake('all',0),heartbeatMs);
   unsubscribe.push(()=>clearInterval(heartbeat));
   wake('all',0);
  }catch(e){close();throw e;}
  return close;
 }
 const client={...nasClient,readSession:()=>verifiedRead('readSession'),
  readLine:()=>verifiedRead('readLine'),submitLine,subscribeLine,
  stop(){if(stopped)return;stopped=true;for(const close of [...closes])close();
   reader.stop();writer.stop();promoter?.stop?.();ownerReader.stop?.();nasClient.stop();}};
 // Every other NAS operation must be explicitly denied while Firebase owns
 // the line. Never accidentally fall back to an unavailable/stale NAS.
 for(const [name,method] of Object.entries(nasClient)){
  if(typeof method!=='function'||
     ['readSession','readLine','submitLine','subscribeLine','stop'].includes(name))continue;
  client[name]=async(...args)=>{
   const a=await authority();
   if(a.owner!=='synology')throw bad('spark-auto-reserve-unsupported');
   return method(...args);
  };
 }
 Object.defineProperty(client,'activeProvider',{enumerable:true,get:()=>provider});
 return Object.freeze(client);
}
