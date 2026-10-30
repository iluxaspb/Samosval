// TEST-only primary write gate. All permissions and owner state stay on the server.
// When enabled, any failure to reach the Firebase authority rejects NAS writes.
import {randomUUID} from 'node:crypto';
import {claimNasOwnership,acquireNasWritePermit,releaseNasWritePermit,
 assertCoordinatorProject,OPERATION_HOLD_MS} from './test-writer-coordinator.mjs';

export const nasWriterFenceRuntime={enabled:false,epoch:null,leaseUntil:null,
 lastConfirmedAt:null,lastError:null,allowedWrites:0,refusedWrites:0};
function boundedError(error){
 const code=String(error?.code||error?.message||'');
 return /^writer-[a-z0-9-]{1,90}$/.test(code)?code:'writer-authority-unavailable';
}
export function startNasWriterFence({pool,projectId,env=process.env,
 firestoreFactory,clock=()=>Date.now(),intervalMs=8000}={}){
 const enabled=env.TEST_WRITER_FENCE_ENABLED==='1';
 Object.assign(nasWriterFenceRuntime,{enabled,epoch:null,leaseUntil:null,
  lastConfirmedAt:null,lastError:null,allowedWrites:0,refusedWrites:0});
 if(!enabled)return {enabled:false,runOnce:async()=>({disabled:true}),
  acquire:async()=>{throw Error('writer-fence-not-enabled');},stop:async()=>{}};
 assertCoordinatorProject(projectId);
 const nodeId=randomUUID().replaceAll('-','');
 const getDb=async()=>firestoreFactory?firestoreFactory():
  import('firebase-admin/firestore').then(m=>m.getFirestore());
 let closed=false,timer=null,inFlight=null;
 async function renew(){
  if(closed)throw Error('writer-fence-stopped');
  const result=await pool.query('SELECT sequence,hash FROM reserve_replica_receipt WHERE singleton=true');
  const raw=result.rows?.[0],sequence=Number(raw?.sequence);
  if(!raw||!Number.isSafeInteger(sequence)||sequence<0||
   !/^[0-9a-f]{64}$/.test(raw.hash||''))throw Error('writer-confirmed-receipt-required');
  const stamp=clock();
  const lease=await claimNasOwnership({firestore:await getDb(),projectId,
   nodeId,checkpoint:{sequence,hash:raw.hash},now:stamp});
  nasWriterFenceRuntime.epoch=lease.epoch;
  nasWriterFenceRuntime.leaseUntil=lease.leaseUntil;
  nasWriterFenceRuntime.lastConfirmedAt=stamp;
  nasWriterFenceRuntime.lastError=null;
  return lease;
 }
 async function loop(){
  if(closed)return;
  inFlight=renew();
  try{await inFlight;}
  catch(e){nasWriterFenceRuntime.lastError=boundedError(e);}
  finally{inFlight=null;if(!closed)timer=setTimeout(loop,intervalMs);}
 }
 timer=setTimeout(loop,100);
 async function acquire(){
  try{
   const now=clock();
   if(closed||!nasWriterFenceRuntime.epoch||
     !nasWriterFenceRuntime.leaseUntil||
     nasWriterFenceRuntime.leaseUntil<=now+OPERATION_HOLD_MS)
    throw Error('writer-no-current-lease');
   const db=await getDb();
   const permit=await acquireNasWritePermit({firestore:db,projectId,nodeId,now});
   nasWriterFenceRuntime.allowedWrites++;
   return {epoch:permit.epoch,release:async()=>{
    try{
     // SQL 014 is commit ordered; read its head only AFTER the HTTP handler
     // finished its PG transaction. Release the remote write-intent and
     // advance the durable observed head together, atomically in Firestore.
     const result=await pool.query('SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true');
     const n=Number(result.rows?.[0]?.n);
     if(!Number.isSafeInteger(n)||n<0)throw Error('writer-outbox-head-unavailable');
     return await releaseNasWritePermit({firestore:db,projectId,nodeId,
      permit,committedSequence:n});
    }
    catch(e){nasWriterFenceRuntime.lastError=boundedError(e);throw e;}
   }};
  }catch(e){
   nasWriterFenceRuntime.refusedWrites++;
   nasWriterFenceRuntime.lastError=boundedError(e);
   throw e;
  }
 }
 return {enabled,runOnce:renew,acquire,stop:async()=>{
  closed=true;if(timer)clearTimeout(timer);
  if(inFlight)await inFlight.catch(()=>{});
 }};
}
