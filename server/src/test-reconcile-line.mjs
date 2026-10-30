// TEST-only reserve -> PostgreSQL replay, before any NAS owner handback.
// Does NOT overwrite NAS data with an old Firebase export. It freezes the
// reserve writer, validates every signed operation, then reuses the exact NAS
// business command with the ORIGINAL operation ID. Recovery stays fenced
// until a separately verified new mirror generation is published.
import {createHash} from 'node:crypto';
import {assertTestProject,REPLICA_DOC,canonical,sha256} from './test-replica.mjs';
import {OWNER_DOC} from './test-writer-coordinator.mjs';
import {submitLineOperation} from './line-store.mjs';

const HASH=/^[0-9a-f]{64}$/;
const FIELDS=['id','type','truckId','shiftId','createdAt','expectedRevision',
 'expectedTtnRevision','arrivalTimestamp','lastLoadTimestamp','wantArrived',
 'collect','cycleMinutes','logId'];
const fail=code=>Object.assign(new Error(code),{code});
const snap=s=>s?.exists?s.data():null;
const targetRef=(db,generation,n)=>
 db.doc(REPLICA_DOC+'/reserve_ops_'+generation+'/'+String(n).padStart(20,'0'));
function validBase(base,m){
 if(!base||base.sequence!==m.lastSequence||base.hash!==m.hash)
  throw fail('reconcile-nas-base-diverged');
}
export async function readNasReplayBaseline(pool){
 const c=await pool.connect();
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const [db,head,receipt]=await Promise.all([
   c.query('SELECT current_database() AS name'),
   c.query('SELECT last_sequence::text AS seq FROM reserve_outbox_cursor WHERE singleton=true'),
   c.query('SELECT sequence::text AS seq, hash FROM reserve_replica_receipt WHERE singleton=true')
  ]);
  if(db.rows[0]?.name!=='samosval_test'&&
   !/^sc_verify_[0-9]+$/.test(db.rows[0]?.name||''))
   throw fail('reconcile-test-db-required');
  const seq=Number(head.rows[0]?.seq),confirmed=Number(receipt.rows[0]?.seq);
  if(!Number.isSafeInteger(seq)||!Number.isSafeInteger(confirmed)||
   seq!==confirmed||!HASH.test(receipt.rows[0]?.hash||''))
   throw fail('reconcile-nas-has-unreplicated-changes');
  await c.query('COMMIT');
  return {sequence:seq,hash:receipt.rows[0].hash};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}
function recoveryState(s,m){
 const r=s?.recovery;
 if(!s||s.owner!=='reconciling'||!r||r.generation!==m?.generation||
   r.baseSequence!==m.lastSequence||r.baseHash!==m.hash||
   !Number.isSafeInteger(r.fromEpoch)||r.fromEpoch<1||
   !Number.isSafeInteger(r.targetSequence)||r.targetSequence<0||
   !Number.isSafeInteger(r.appliedSequence)||r.appliedSequence<0||
   r.appliedSequence>r.targetSequence||!HASH.test(r.appliedHash||'')||
   !HASH.test(r.targetHash||'')||!['replaying','applied'].includes(r.status))
  throw fail('reconcile-state-invalid');
 return r;
}
export async function beginReserveReplay({firestore,projectId,pool,
 baselineReader=readNasReplayBaseline,now=Date.now(),
 fenceEnabled=process.env.TEST_WRITER_FENCE_ENABLED==='1'}={}){
 if(!fenceEnabled)throw fail('reconcile-nas-fence-required');
 assertTestProject(projectId);
 const current=snap(await firestore.doc(OWNER_DOC).get());
 if(current?.owner==='reconciling'){
  const m=snap(await firestore.doc(REPLICA_DOC).get());
  return {resumed:true,...recoveryState(current,m)};
 }
 const base=await baselineReader(pool);
 const ref=firestore.doc(OWNER_DOC),metaRef=firestore.doc(REPLICA_DOC);
 return firestore.runTransaction(async tx=>{
  const [stateDoc,metaDoc]=await Promise.all([tx.get(ref),tx.get(metaRef)]);
  const o=snap(stateDoc),m=snap(metaDoc);
  if(!o||o.protocol!==1||o.projectId!=='samosval-offline'||
   o.owner!=='firebase'||o.holder!=='firebase_reserve'||o.pending&&
   Object.keys(o.pending).length>0||!Number.isSafeInteger(o.epoch)||
   !Number.isSafeInteger(o.reserveSequence)||o.reserveSequence<0)
   throw fail('reconcile-reserve-owner-invalid');
  if(!m||m.channel!=='test'||m.projectId!=='samosval-offline'||
   m.readyForFailover!==true||m.generation!==o.generation||
   o.observedSequence!==m.lastSequence||!HASH.test(m.hash||''))
   throw fail('reconcile-replica-invalid');
  validBase(base,m);
  const initial=sha256('reserve:'+m.hash+':'+o.epoch);
  const targetHash=o.reserveSequence===0?initial:o.reserveHash;
  if(!HASH.test(targetHash||''))throw fail('reconcile-reserve-checkpoint-invalid');
  const recovery={generation:m.generation,baseSequence:m.lastSequence,
   baseHash:m.hash,fromEpoch:o.epoch,targetSequence:o.reserveSequence,
   targetHash,appliedSequence:0,appliedHash:initial,
   status:'replaying',startedAt:now};
  // Every reserve transaction reads this same owner doc; changing epoch here
  // is an atomic cutover. NAS permits remain denied for non-NAS owners.
  tx.update(ref,{owner:'reconciling',holder:'reconcile_worker',epoch:o.epoch+1,
   leaseUntil:now+60000,updatedAt:now,recovery});
  return {started:true,...recovery};
 });
}
function validateEvent(event,recovery){
 if(!event||event.sequence!==recovery.appliedSequence+1||
   event.epoch!==recovery.fromEpoch||event.workspaceId!=='main_workspace'||
   !/^[A-Za-z0-9_-]{1,128}$/.test(event.uid||'')||
   event.previousHash!==recovery.appliedHash||!HASH.test(event.hash||'')||
   !event.op||typeof event.op!=='object'||!event.result)
  throw fail('reconcile-event-invalid');
 const {hash,...ledger}=event;
 if(sha256(event.previousHash+'\n'+canonical(ledger))!==hash)
  throw fail('reconcile-event-hash-mismatch');
 const original=Object.fromEntries(FIELDS.filter(k=>event.op[k]!==undefined)
  .map(k=>[k,event.op[k]]));
 if(createHash('sha256').update(JSON.stringify(original)).digest('hex')!==event.requestHash)
  throw fail('reconcile-operation-hash-mismatch');
 return original;
}
export async function replayReserveNext({firestore,projectId,pool,
 apply=submitLineOperation,
 fenceEnabled=process.env.TEST_WRITER_FENCE_ENABLED==='1'}={}){
 if(!fenceEnabled)throw fail('reconcile-nas-fence-required');
 assertTestProject(projectId);
 const ref=firestore.doc(OWNER_DOC),metaRef=firestore.doc(REPLICA_DOC);
 const [stateDoc,metaDoc]=await Promise.all([ref.get(),metaRef.get()]);
 const owner=snap(stateDoc),m=snap(metaDoc);
 const r=recoveryState(owner,m);
 if(r.appliedSequence===r.targetSequence){
  if(r.appliedHash!==r.targetHash)
   throw fail('reconcile-final-hash-mismatch');
  if(r.status==='applied')return {complete:true,applied:r.appliedSequence};
  await firestore.runTransaction(async tx=>{
   const cur=snap(await tx.get(ref)),check=recoveryState(cur,m);
   if(check.appliedSequence!==r.appliedSequence||check.appliedHash!==r.appliedHash)
    throw fail('reconcile-concurrent-worker');
   tx.update(ref,{recovery:{...check,status:'applied',completedAt:Date.now()}});
  });
  return {complete:true,applied:r.appliedSequence};
 }
 const sequence=r.appliedSequence+1;
 const record=snap(await targetRef(firestore,r.generation,sequence).get());
 const op=validateEvent(record,r);
 const applied=await apply(pool,record.uid,op);
 const {replayed,...stored}=applied;
 if(canonical(stored)!==canonical(record.result))
  throw fail('reconcile-business-result-diverged');
 // Commit the remote receipt only AFTER the corresponding PG operation and
 // its SQL 014 outbox commit. A lost Firestore ACK retries the same PG ID.
 await firestore.runTransaction(async tx=>{
  const [curDoc,ledgerDoc]=await Promise.all([tx.get(ref),
   tx.get(targetRef(firestore,r.generation,sequence))]);
  const current=recoveryState(snap(curDoc),m);
  if(current.appliedSequence!==r.appliedSequence||current.appliedHash!==r.appliedHash||
   snap(ledgerDoc)?.hash!==record.hash)throw fail('reconcile-concurrent-worker');
  tx.update(ref,{recovery:{...current,appliedSequence:sequence,
   appliedHash:record.hash,updatedAt:Date.now()}});
 });
 return {applied:sequence,remaining:r.targetSequence-sequence,
  pgReplayed:replayed===true};
}
