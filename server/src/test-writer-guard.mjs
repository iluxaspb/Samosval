// TEST-only primary write gate. All permissions and owner state stay on the server.
// When enabled, any failure to reach the Firebase authority rejects NAS writes.
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
// A permit is propagated only through the async call that owns the SQL
// transaction. An unrelated timer or connection never inherits it.
const permitContext=new AsyncLocalStorage();
export function currentNasWriterPermit(){return permitContext.getStore()||null;}
export function withNasWriterPermit(permit,work){
 if(!permit||typeof work!=='function'||
    !Number.isSafeInteger(permit.epoch)||permit.epoch<1||
    typeof permit.permitId!=='string'||!/^[A-Za-z0-9_-]{8,160}$/.test(permit.permitId))
  throw new TypeError('writer-permit-context-invalid');
 return permitContext.run({epoch:permit.epoch,permitId:permit.permitId},work);
}
import {claimNasOwnership,acquireNasWritePermit,releaseNasWritePermit,
 assertCoordinatorProject,OPERATION_HOLD_MS} from './test-writer-coordinator.mjs';

export const nasWriterFenceRuntime={enabled:false,epoch:null,leaseUntil:null,
 lastConfirmedAt:null,lastError:null,allowedWrites:0,refusedWrites:0};
function boundedError(error){
 const code=String(error?.code||error?.message||'');
 return /^writer-[a-z0-9-]{1,90}$/.test(code)?code:'writer-authority-unavailable';
}
// SQL 016 is a *separate*, durable authority fence. A Firestore permit
// cannot justify a PostgreSQL write if that fence is absent, disarmed,
// uncertified, or still bound to the previous NAS ownership epoch.
async function assertSqlWriterGate(pool,epoch=null){
 let result;
 try{
  result=await pool.query(
   'SELECT current_database() AS database,armed,coverage_certified,'+
   ' owner_epoch::text AS epoch FROM reserve_control.writer_gate WHERE singleton=true'
  );
 }catch(error){
  if(error.code==='42P01'||error.code==='3F000')
   throw Error('writer-sql016-required');
  throw error;
 }
 const gate=result.rows?.[0];
 if(gate?.database!=='samosval_test'&&!/^sc_verify_[0-9]+$/.test(gate?.database||''))
  throw Error('writer-sql016-test-database-required');
 if(gate?.armed!==true||gate.coverage_certified!==true)
  throw Error('writer-sql016-not-certified');
 if(epoch!==null&&String(epoch)!==gate.epoch)
  throw Error('writer-sql016-epoch-mismatch');
 return gate;
}
export function startNasWriterFence({pool,projectId,env=process.env,
 firestoreFactory,clock=()=>Date.now(),intervalMs=30000}={}){
 // A 30-second heartbeat uses approximately 2,880 Firestore owner writes/day
 // instead of ~10,800 at 8 seconds, while the 60-second lease remains valid.
 // Every business write still obtains its own transactional permit.
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
  nasWriterFenceRuntime.epoch=null;
  nasWriterFenceRuntime.leaseUntil=null;
  // Reject startup even before claiming Firestore ownership if SQL 016
  // was never installed/armed on this isolated TEST database.
  await assertSqlWriterGate(pool);
  const result=await pool.query('SELECT sequence,hash FROM reserve_replica_receipt WHERE singleton=true');
  const raw=result.rows?.[0],sequence=Number(raw?.sequence);
  if(!raw||!Number.isSafeInteger(sequence)||sequence<0||
   !/^[0-9a-f]{64}$/.test(raw.hash||''))throw Error('writer-confirmed-receipt-required');
  const latest=await pool.query('SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true');
  const headSequence=Number(latest.rows?.[0]?.n);
  if(!Number.isSafeInteger(headSequence)||headSequence<sequence)
   throw Error('writer-invalid-nas-head');
  const stamp=clock();
  const lease=await claimNasOwnership({firestore:await getDb(),projectId,
   nodeId,checkpoint:{sequence,hash:raw.hash},headSequence,now:stamp});
  // In particular, a handback that increments the Firestore epoch cannot
  // silently resume NAS writes against an older local SQL gate. An explicit
  // separately verified SQL epoch rebind is required before serving traffic.
  await assertSqlWriterGate(pool,lease.epoch);
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
   await assertSqlWriterGate(pool,nasWriterFenceRuntime.epoch);
   const db=await getDb();
   const permit=await acquireNasWritePermit({firestore:db,projectId,nodeId,now});
   try{
    if(permit.epoch!==nasWriterFenceRuntime.epoch)
     throw Error('writer-sql016-epoch-mismatch');
    await assertSqlWriterGate(pool,permit.epoch);
   }catch(error){
    // Do not leave an unnecessary pending remote permit after rejecting a
    // local SQL mismatch. Failure to release still fails closed.
    await releaseNasWritePermit({firestore:db,projectId,nodeId,permit}).catch(()=>{});
    throw error;
   }
   nasWriterFenceRuntime.allowedWrites++;
   return {epoch:permit.epoch,permitId:permit.permitId,release:async()=>{
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
