// TEST-only Spark phone promotion. No trusted API, Cloud Run, Cloud
// Functions or privileged Firebase credentials. Security Rules are the final
// authority: NAS lease+grace, exact SQL016-certified generation, UID/ACL,
// pending intents, and one-epoch state transition MUST all be checked there.
// This module is NOT enabled by normal index-test.html.
export class SparkPromotionError extends Error{
 constructor(code,{retryable=true}={}){super(code);this.code=code;
  this.name='SparkPromotionError';this.retryable=retryable;}
}
const bad=code=>new SparkPromotionError(code);
const ROOT='samosval_test_replica/v1',OWNER='samosval_test_replica/write_owner';
const GRACE_MS=30000,PROJECT='samosval-offline';
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const data=s=>s?.exists?s.data():null;
export function createSparkClientPromoter({firestore,getUser,ownerReader,
 clock=Date.now,onDiagnostic=()=>{}}={}){
 if(firestore?.app?.options?.projectId!==PROJECT||
    typeof firestore.doc!=='function'||typeof firestore.runTransaction!=='function'||
    typeof getUser!=='function'||typeof ownerReader?.readOwner!=='function'||
    typeof clock!=='function'||typeof onDiagnostic!=='function')
  throw new TypeError('spark-promotion-invalid-options');
 const user=getUser(),uid=user?.uid;
 if(typeof uid!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(uid))
  throw bad('spark-promotion-auth-required');
 let stopped=false,attempting=null;
 function guard(){
  if(stopped||getUser()!==user||user.uid!==uid)
   throw bad('spark-promotion-session-changed');
 }
 async function execute(){
  guard();
  const head=await ownerReader.readOwner();
  guard();
  if(head.owner!=='synology'||head.promotionCertified!==true)
   return {promoted:false,reason:'not-certified'};
  if(!integer(head.leaseUntil)||head.leaseUntil+GRACE_MS>=clock())
   return {promoted:false,reason:'lease-active'};
  const metaRef=firestore.doc(ROOT),ownerRef=firestore.doc(OWNER);
  let expectedEpoch=head.epoch;
  try{
   await firestore.runTransaction(async tx=>{
    guard();
    const [mSnap,oSnap]=await Promise.all([tx.get(metaRef),tx.get(ownerRef)]);
    const m=data(mSnap),o=data(oSnap),proof=m?.promotionProof;
    if(!m||m.protocol!==1||m.projectId!==PROJECT||m.channel!=='test'||
       m.writer!=='synology'||m.readyForFailover!==true||
       m.typedProtocol!==1||m.typedSequence!==m.lastSequence||
       m.accessProtocol!==1||proof?.protocol!==2||
       proof.writerGate!=='sql016'||proof.generation!==m.generation||
       proof.epoch!==expectedEpoch||proof.hash!==m.hash||
       proof.sequence!==m.lastSequence||
       !o||o.owner!=='synology'||o.epoch!==expectedEpoch||
       o.generation!==m.generation||o.observedSequence!==m.lastSequence||
       !integer(o.leaseUntil)||o.leaseUntil+GRACE_MS>=clock()||
       !o.pending||Object.keys(o.pending).length!==0||
       o.reserveSequence!==0)
     throw bad('spark-promotion-not-certified');
    // Phone cannot mutate a lease, ACL, pending permit, checkpoint, metadata,
    // or field other than the strict three-field owner transition.
    tx.update(ownerRef,{owner:'firebase',holder:'firebase_reserve',epoch:expectedEpoch+1});
   });
  }catch(e){
   if(e instanceof SparkPromotionError)throw e;
   try{onDiagnostic(e);}catch{}
   throw bad('spark-promotion-transaction-unavailable');
  }
  const confirmed=await ownerReader.readOwner();
  guard();
  if(confirmed.owner!=='firebase'||!confirmed.readyForFailover||
     confirmed.epoch!==expectedEpoch+1||
     confirmed.generation!==head.generation)
   throw bad('spark-promotion-result-unverified');
  return {promoted:true,epoch:confirmed.epoch,generation:confirmed.generation};
 }
 function tryPromote(){
  guard();
  if(attempting)return attempting;
  const flight=execute().finally(()=>{if(attempting===flight)attempting=null;});
  attempting=flight;
  return flight;
 }
 return Object.freeze({uid,tryPromote,stop(){stopped=true;}});
}
