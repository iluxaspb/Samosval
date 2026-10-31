// Direct browser-side Spark Firestore coordinator reader.
// No Cloud Run, Cloud Functions, REST proxy or long-running Google server.
// This does NOT promote Firebase or authorize browser business writes.
export class SparkOwnerError extends Error {
 constructor(code,{retryable=true}={}){super(code);this.name='SparkOwnerError';
  this.code=code;this.retryable=retryable;}
}
const bad=code=>new SparkOwnerError(code);
const protocolHash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const generation=value=>typeof value==='string'&&/^[0-9a-f]{24}$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;

export function createSparkOwnerReader({firestore,getUser,clock=Date.now}={}){
 if(!firestore||typeof firestore.doc!=='function'||
  typeof firestore.runTransaction!=='function'||typeof getUser!=='function'||
  typeof clock!=='function')throw new TypeError('spark-invalid-reader-options');
 // The Firebase compat SDK exposes the Firebase project through app.options.
 if(firestore.app?.options?.projectId!=='samosval-offline')
  throw new TypeError('spark-test-project-required');
 const initialUser=getUser(),uid=initialUser?.uid;
 if(typeof uid!=='string'||!uid)throw bad('spark-auth-required');
 let stopped=false;
 const metaRef=firestore.doc('samosval_test_replica/v1');
 const ownerRef=firestore.doc('samosval_test_replica/write_owner');
 function session(){
  if(stopped||getUser()!==initialUser||initialUser.uid!==uid)
   throw bad('spark-session-changed');
 }
 async function readOwner(){
  session();
  let pair;
  try{
   pair=await firestore.runTransaction(async tx=>{
    const [meta,owner]=await Promise.all([tx.get(metaRef),tx.get(ownerRef)]);
    return {meta:meta.exists?meta.data():null,owner:owner.exists?owner.data():null};
   });
  }catch(e){
   if(e instanceof SparkOwnerError)throw e;
   throw bad('spark-authority-unavailable');
  }
  session();
  const m=pair?.meta,o=pair?.owner;
  if(!m||m.protocol!==1||m.channel!=='test'||m.projectId!=='samosval-offline'||
   !generation(m.generation)||!protocolHash(m.hash)||!Number.isSafeInteger(m.lastSequence)||
   m.lastSequence<0||typeof m.readyForFailover!=='boolean')
   throw bad('spark-replica-invalid');
  if(!o||o.protocol!==1||o.projectId!=='samosval-offline'||
   !['synology','firebase','reconciling','handoff'].includes(o.owner)||
   o.generation!==m.generation||!positive(o.epoch)||
   !Number.isSafeInteger(o.observedSequence)||o.observedSequence<0||
   !Number.isSafeInteger(o.leaseUntil)||o.leaseUntil<0)
   throw bad('spark-writer-invalid');
  const consistent=o.observedSequence===m.lastSequence;
  const proof=m.promotionProof;
  const promotionCertified=o.owner==='synology'&&m.readyForFailover===true&&
   m.typedProtocol===1&&m.typedSequence===m.lastSequence&&
   m.accessProtocol===1&&proof?.protocol===2&&
   proof.writerGate==='sql016'&&proof.epoch===o.epoch&&
   proof.sequence===m.lastSequence&&proof.hash===m.hash&&
   proof.generation===m.generation&&consistent;
  const reserveActive=o.owner==='firebase'&&o.holder==='firebase_reserve'&&
   m.readyForFailover===true&&consistent;
  if(o.owner==='firebase'&&!reserveActive)throw bad('spark-reserve-not-certified');
  // The server timestamp is authoritative for Security Rules. This local
  // checkedAt is only for rendering status; never use it to promote a writer.
  return Object.freeze({
   format:'samosval-owner-status',version:1,projectId:'samosval-offline',
   owner:o.owner,epoch:o.epoch,generation:m.generation,
   confirmedSequence:m.lastSequence,reserveSequence:o.reserveSequence||0,
   readyForFailover:reserveActive,promotionCertified,
   leaseUntil:o.leaseUntil,lag:Math.max(0,o.observedSequence-m.lastSequence),
   checkedAt:clock(),source:'spark-firestore'
  });
 }
 return Object.freeze({readOwner,stop:()=>{stopped=true;},get uid(){return uid;}});
}
