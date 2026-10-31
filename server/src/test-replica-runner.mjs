// Runs in the TEST API process, independently of browser sessions.
// Opt-in only; never creates a Firebase business writer or transfers ownership.
// Spark free tier: never poll two Firestore documents every four seconds while idle.
import {replicateOnce,assertTestProject} from './test-replica.mjs';

export const replicaRuntime={enabled:false,lastSuccessAt:null,lastError:null,running:false,
  skippedRemoteChecks:0,lastRemoteAuditAt:null};
export const SPARK_REMOTE_AUDIT_INTERVAL_MS=10*60*1000;
export function shouldAuditSparkRemote({now,lastAuditAt,head,receipt}){
  // No local receipt means the first snapshot has not yet been confirmed.
  if(!Number.isSafeInteger(head)||head<0||!Number.isSafeInteger(receipt)||receipt<0)
    return true;
  return head!==receipt||!Number.isSafeInteger(lastAuditAt)||
    now-lastAuditAt>=SPARK_REMOTE_AUDIT_INTERVAL_MS;
}
const sleepError=e=>{
 const code=String(e?.message||'');
 return /^replica-[a-z0-9-]{1,110}$/.test(code)?code:'replica-remote-unavailable';
};
export function startTestReplica({pool,projectId,env=process.env,firestoreFactory,
  intervalMs=4000,clock=Date.now,replicateImpl=replicateOnce,
  initialDelayMs=100}={}){
  if(typeof replicateImpl!=='function'||!Number.isSafeInteger(initialDelayMs)||initialDelayMs<0)
    throw TypeError('replica-invalid-runner-options');
  if(typeof clock!=='function')throw TypeError('replica-invalid-clock');
  let lastAuditAt=null;
  replicaRuntime.skippedRemoteChecks=0;
  replicaRuntime.lastRemoteAuditAt=null;
 const enabled=env.TEST_REPLICA_ENABLED==='1';
 replicaRuntime.enabled=enabled;
 let timer=null,closed=false,attempt=0,inFlight=null;
 if(enabled)assertTestProject(projectId);
 async function tick(){
  if(closed||!enabled)return;
  const conn=await pool.connect();
  try{
   const held=(await conn.query("SELECT pg_try_advisory_lock(hashtext('samosval-test-mirror-v1')) AS held")).rows[0]?.held;
   if(!held){replicaRuntime.lastError='replica-lock-owned-by-other-process';return;}
   try{
    // Local PostgreSQL reads do not consume any of Firestore's Spark quota.
    // This check happens while holding the single-runner advisory lock.
    const probe=await conn.query('SELECT (SELECT last_sequence::text FROM reserve_outbox_cursor WHERE singleton=true) AS head, '+
      '(SELECT sequence::text FROM reserve_replica_receipt WHERE singleton=true) AS receipt');
    const head=probe.rows?.[0]?.head===null?null:Number(probe.rows?.[0]?.head);
    const receipt=probe.rows?.[0]?.receipt===null?null:Number(probe.rows?.[0]?.receipt);
    const now=clock();
    if(!shouldAuditSparkRemote({now,lastAuditAt,head,receipt})){
      replicaRuntime.skippedRemoteChecks++;
      replicaRuntime.lastError=null;
      return {idle:true,skippedRemote:true,sequence:receipt,lag:0};
    }
    const db=await (firestoreFactory?firestoreFactory():import('firebase-admin/firestore').then(m=>m.getFirestore()));
    const result=await replicateImpl({pool,firestore:db,projectId});
    lastAuditAt=now;replicaRuntime.lastRemoteAuditAt=now;
    replicaRuntime.lastSuccessAt=now;replicaRuntime.lastError=null;attempt=0;
    return result;
   }finally{
    await conn.query("SELECT pg_advisory_unlock(hashtext('samosval-test-mirror-v1'))").catch(()=>{});
   }
  }finally{conn.release();}
 }
 async function loop(){
  if(closed)return;
  replicaRuntime.running=true;
  try{inFlight=tick();await inFlight;}
  catch(e){replicaRuntime.lastError=sleepError(e);attempt=Math.min(attempt+1,5);}
  finally{
   inFlight=null;replicaRuntime.running=false;
   if(!closed&&enabled)timer=setTimeout(loop,Math.min(60000,intervalMs*Math.pow(2,attempt)));
  }
 }
 if(enabled)timer=setTimeout(loop,initialDelayMs);
 return {enabled,runOnce:tick,stop:async()=>{
  closed=true;if(timer)clearTimeout(timer);
  if(inFlight)await inFlight.catch(()=>{});
 }};
}
