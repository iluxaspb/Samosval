// Runs in the TEST API process, independently of browser sessions.
// Opt-in only; never creates a Firebase business writer or transfers ownership.
import {replicateOnce,assertTestProject} from './test-replica.mjs';

export const replicaRuntime={enabled:false,lastSuccessAt:null,lastError:null,running:false};
const sleepError=e=>{
 const code=String(e?.message||'');
 return /^replica-[a-z0-9-]{1,110}$/.test(code)?code:'replica-remote-unavailable';
};
export function startTestReplica({pool,projectId,env=process.env,firestoreFactory,intervalMs=4000}={}){
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
    const db=await (firestoreFactory?firestoreFactory():import('firebase-admin/firestore').then(m=>m.getFirestore()));
    const result=await replicateOnce({pool,firestore:db,projectId});
    replicaRuntime.lastSuccessAt=Date.now();replicaRuntime.lastError=null;attempt=0;
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
 if(enabled)timer=setTimeout(loop,100);
 return {enabled,runOnce:tick,stop:async()=>{
  closed=true;if(timer)clearTimeout(timer);
  if(inFlight)await inFlight.catch(()=>{});
 }};
}
