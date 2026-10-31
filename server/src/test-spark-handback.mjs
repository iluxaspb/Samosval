// TEST only. Typed Spark -> PostgreSQL handback after SQL 015 replay.
// Deliberately NOT imported by the HTTP server, release updater or scheduler.
// An incomplete SQL replay can never make Synology the writer.
import {Timestamp} from 'firebase-admin/firestore';
import {assertTestProject,REPLICA_DOC,canonical,sha256,collectSnapshot,
 rowRef,storeReceipt} from './test-replica.mjs';
import {OWNER_DOC,OWNER_LEASE_MS,FENCE_GRACE_MS} from './test-writer-coordinator.mjs';
import {inspectFrozenSparkHistory} from './test-spark-replay-inspect.mjs';
import {buildSparkTypedLineSnapshot,sparkTypedPaths} from './test-spark-typed.mjs';
import {accessRowsFromMirrorSnapshot,sparkAccessRef} from './test-spark-access.mjs';
import {assertSparkBootstrapBudget} from './test-spark-limits.mjs';

const WS='main_workspace',GEN=/^[a-f0-9]{24}$/,HEX=/^[a-f0-9]{64}$/;
const CHUNK=20,MAX_BATCH_BYTES=6500000,MAX_DOCUMENT_BYTES=900000;
const bad=code=>Object.assign(new Error(code),{code});
const snap=s=>s?.exists?s.data():null;
const seq=n=>Number.isSafeInteger(n)&&n>=0;
function guard({projectId,pool,firestore,fenceEnabled}){
 if(fenceEnabled!==true)throw bad('spark-handback-nas-fence-required');
 assertTestProject(projectId);
 if(!pool?.connect||!firestore?.runTransaction||!firestore?.batch||
    !firestore?.collection)throw bad('spark-handback-dependencies-invalid');
}
function expectedSource(recovery){
 if(!recovery||recovery.typedProtocol!==1||!GEN.test(recovery.generation||'')||
    !HEX.test(recovery.baseHash||'')||!HEX.test(recovery.manifestHash||'')||
    !seq(recovery.fromEpoch)||recovery.fromEpoch<1||
    !seq(recovery.baseSequence)||!seq(recovery.eventCount))
  throw bad('spark-handback-recovery-invalid');
 return recovery;
}
// Snapshot-consistent checkpoint proof. The durable SQL checkpoint is the
// authority for applied count, while the original Firestore manifest hash
// proves the contents that were authorized for replay.
async function readAppliedProof(pool,recovery,newReceipt=null){
 expectedSource(recovery);
 const c=await pool.connect();
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const name=(await c.query('SELECT current_database() AS name')).rows[0]?.name;
  if(name!=='samosval_test'&&!/^sc_verify_[0-9]+$/.test(name||''))
   throw bad('spark-handback-test-database-required');
  const cp=(await c.query('SELECT * FROM reserve_spark_replay_checkpoint WHERE singleton=true')).rows[0];
  const head=Number((await c.query('SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true')).rows[0]?.n);
  const receipt=(await c.query('SELECT sequence::text AS n,hash FROM reserve_replica_receipt WHERE singleton=true')).rows[0];
  if(!cp||cp.workspace_id!==WS||cp.state!=='applied'||
     cp.generation!==recovery.generation||
     Number(cp.from_epoch)!==recovery.fromEpoch||
     Number(cp.base_sequence)!==recovery.baseSequence||
     cp.base_hash!==recovery.baseHash||
     cp.manifest_hash!==recovery.manifestHash||
     Number(cp.event_count)!==recovery.eventCount||
     !seq(cp.applied_count)||cp.applied_count!==cp.event_count||
     !seq(head)||head!==Number(cp.outbox_sequence)||
     !cp.plan||cp.plan.format!=='spark-typed-pg-dry-run'||
     cp.plan.generation!==cp.generation||
     cp.plan.version!==1||
     cp.plan.fromEpoch!==recovery.fromEpoch||
     cp.plan.baseSequence!==recovery.baseSequence||
     cp.plan.baseHash!==recovery.baseHash||
     cp.plan.eventCount!==recovery.eventCount||
     cp.plan.plannedHash!==cp.planned_hash||
     !Array.isArray(cp.plan.operations)||
     cp.plan.operations.length!==cp.event_count||
     sha256(canonical(cp.plan.operations))!==cp.planned_hash)
   throw bad('spark-handback-replay-not-complete');
  const receiptSeq=Number(receipt?.n);
  const atBase=receiptSeq===recovery.baseSequence&&receipt?.hash===recovery.baseHash;
  const atNew=newReceipt&&receiptSeq===newReceipt.sequence&&receipt?.hash===newReceipt.hash;
  if(!atBase&&!atNew)throw bad('spark-handback-receipt-diverged');
  const operations=cp.plan.operations;
  const ids=operations.map(o=>o.operationId);
  const byId=new Map(operations.map(o=>[o.operationId,o]));
  if(byId.size!==ids.length)throw bad('spark-handback-duplicate-operation');
  if(ids.length){
   const rows=(await c.query(
    'SELECT operation_id,uid FROM line_operation_receipts WHERE workspace_id=$1 AND operation_id=ANY($2::text[])',
    [WS,ids])).rows;
   if(rows.length!==ids.length||rows.some(r=>{
    const op=byId.get(r.operation_id);
    return !op||r.uid!==op.uid;
   }))throw bad('spark-handback-sql-receipts-missing');
  }
  const expectedAliases=operations.filter(o=>o.pgIntent?.type==='load');
  const aliases=(await c.query(
   'SELECT operation_id,reserve_log_id,postgres_log_id FROM reserve_spark_log_aliases WHERE workspace_id=$1 AND generation=$2',
   [WS,recovery.generation])).rows;
  const aliasById=new Map(expectedAliases.map(o=>[o.operationId,o]));
  if(aliases.length!==expectedAliases.length||
     aliases.some(r=>{
      const op=aliasById.get(r.operation_id);
      return !op||r.reserve_log_id!==op.reserveLogId||
       r.postgres_log_id!==op.postgresLogId;
     }))throw bad('spark-handback-log-aliases-diverged');
  await c.query('COMMIT');
  return {sequence:head,count:cp.event_count,manifestHash:cp.manifest_hash};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}
// Hold the SQL outbox cursor row lock during the brief Firestore owner
// transition. Business SQL commits use this same lock through the outbox
// trigger, so a NAS write cannot slip between the last check and handback.
async function withPgOutboxFence(pool,expectedSequence,commitRemote){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const name=(await c.query('SELECT current_database() AS name')).rows[0]?.name;
  if(name!=='samosval_test'&&!/^sc_verify_[0-9]+$/.test(name||''))
   throw bad('spark-handback-test-database-required');
  const checkpoint=(await c.query(
   'SELECT state,outbox_sequence::text AS sequence FROM reserve_spark_replay_checkpoint WHERE singleton=true FOR SHARE'
  )).rows[0];
  const head=Number((await c.query(
   'SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true FOR UPDATE'
  )).rows[0]?.n);
  if(checkpoint?.state!=='applied'||head!==expectedSequence||
     Number(checkpoint.sequence)!==expectedSequence)
   throw bad('spark-handback-outbox-changed-at-cutover');
  const value=await commitRemote();
  await c.query('COMMIT');
  return value;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}
function buildDocuments(snapshot,generation,firestore){
 const typed=buildSparkTypedLineSnapshot({snapshot,generation,
  fromMillis:ms=>Timestamp.fromMillis(ms)});
 const paths=sparkTypedPaths(generation);
 const access=accessRowsFromMirrorSnapshot(snapshot,generation);
 const documents=[
  ...snapshot.rows.map(r=>[rowRef(firestore,generation,r.table,r.key).path,r.envelope]),
  [paths.config,typed.config],
  ...[...typed.trucks].map(([id,row])=>[paths.truck(id),row]),
  ...[...typed.statuses].map(([id,row])=>[paths.status(id),row]),
  ...access.map(row=>[sparkAccessRef(firestore,generation,row.uid).path,row])
 ];
 assertSparkBootstrapBudget(documents.length);
 if(new Set(documents.map(([path])=>path)).size!==documents.length)
  throw bad('spark-handback-document-collision');
 const collections=new Map();
 for(const [path,value] of documents){
  const index=path.lastIndexOf('/');
  if(index<1)throw bad('spark-handback-path-invalid');
  const group=path.slice(0,index),id=path.slice(index+1);
  if(!collections.has(group))collections.set(group,new Map());
  collections.get(group).set(id,value);
 }
 return {documents,collections,accessCount:access.length,
  typedCount:1+typed.trucks.size+typed.statuses.size};
}
async function publishDocuments(firestore,documents){
 for(let offset=0;offset<documents.length;){
  const batch=firestore.batch();let bytes=0,count=0;
  for(const [path,value] of documents.slice(offset,offset+CHUNK)){
   const cost=Buffer.byteLength(JSON.stringify(value),'utf8')+1024;
   if(cost>MAX_DOCUMENT_BYTES)throw bad('spark-handback-document-too-large');
   if(count&&bytes+cost>MAX_BATCH_BYTES)break;
   batch.set(firestore.doc(path),value);bytes+=cost;count++;
  }
  if(!count)throw bad('spark-handback-empty-batch');
  await batch.commit();offset+=count;
 }
}
async function verifyDocuments(firestore,collections){
 // Full independent readback of every generation document and exact set
 // membership. Metadata is not made visible until this succeeds.
 for(const [path,expected] of collections){
  const found=(await firestore.collection(path).get()).docs;
  if(found.length!==expected.size)throw bad('spark-handback-document-count-diverged');
  const seen=new Set();
  for(const doc of found){
   if(seen.has(doc.id)||!expected.has(doc.id)||
      canonical(doc.data())!==canonical(expected.get(doc.id)))
    throw bad('spark-handback-document-diverged');
   seen.add(doc.id);
  }
 }
}
async function readRemote(firestore){
 const [ms,os]=await Promise.all([
  firestore.doc(REPLICA_DOC).get(),firestore.doc(OWNER_DOC).get()]);
 return {m:snap(ms),o:snap(os)};
}
function stagedOwner(m,o){
 const r=o?.recovery;
 if(o?.owner!=='handoff'||o?.holder!=='reconcile_worker'||
    !seq(o.epoch)||!m||m.protocol!==1||m.channel!=='test'||
    m.projectId!=='samosval-offline'||m.writer!=='synology'||
    m.readyForFailover!==false||m.typedProtocol!==1||
    m.typedSequence!==m.lastSequence||m.accessProtocol!==1||
    !seq(m.accessCount)||!seq(m.rowCount)||!GEN.test(m.generation||'')||
    !HEX.test(m.hash||'')||!HEX.test(m.snapshotHash||'')||
    !r||r.status!=='staged'||r.newGeneration!==m.generation||
    r.newSequence!==m.lastSequence||r.newHash!==m.hash||
    r.newSnapshotHash!==m.snapshotHash||
    o.generation!==m.generation||o.observedSequence!==m.lastSequence||
    o.epoch!==r.frozenEpoch+1||!r.newGeneration||
    !o.pending||Object.keys(o.pending).length!==0)
  throw bad('spark-handback-not-staged');
 expectedSource(r);
 return r;
}
async function verifyStaged({firestore,pool,m,o}){
 const recovery=stagedOwner(m,o);
 const proof=await readAppliedProof(pool,recovery,{sequence:m.lastSequence,hash:m.hash});
 if(proof.sequence!==m.lastSequence)throw bad('spark-handback-outbox-diverged');
 const snapshot=await collectSnapshot(pool);
 if(snapshot.sequence!==m.lastSequence||snapshot.snapshotHash!==m.snapshotHash||
    snapshot.rows.length!==m.rowCount)throw bad('spark-handback-snapshot-diverged');
 const expected=buildDocuments(snapshot,m.generation,firestore);
 if(expected.accessCount!==m.accessCount)
  throw bad('spark-handback-access-count-diverged');
 await verifyDocuments(firestore,expected.collections);
 return snapshot;
}
export async function stageSparkTypedHandback({firestore,projectId,pool,now=Date.now(),
 fenceEnabled=process.env.TEST_WRITER_FENCE_ENABLED==='1'}={}){
 guard({firestore,projectId,pool,fenceEnabled});
 const {m,o}=await readRemote(firestore);
 if(o?.owner==='handoff'){
  const snapshot=await verifyStaged({firestore,pool,m,o});
  return {staged:true,resumed:true,generation:m.generation,sequence:snapshot.sequence};
 }
 const manifest=await inspectFrozenSparkHistory({firestore,projectId});
 if(o?.owner!=='reconciling'||o.holder!=='reconcile_worker'||
    o.epoch!==manifest.ownerEpoch||o.recovery?.status!=='frozen'||
    o.recovery?.typedProtocol!==1)
  throw bad('spark-handback-owner-not-frozen');
 const recovery={...o.recovery,manifestHash:manifest.sha256,
  eventCount:manifest.eventCount};
 const proof=await readAppliedProof(pool,recovery);
 const snapshot=await collectSnapshot(pool);
 if(snapshot.sequence!==proof.sequence)throw bad('spark-handback-outbox-diverged');
 const generation=sha256(
  'spark-typed-handback\n'+manifest.generation+'\n'+manifest.sha256+'\n'+
   snapshot.sequence+'\n'+snapshot.snapshotHash).slice(0,24);
 if(generation===manifest.generation)throw bad('spark-handback-generation-reused');
 const entries=buildDocuments(snapshot,generation,firestore);
 await publishDocuments(firestore,entries.documents);
 await verifyDocuments(firestore,entries.collections);
 // A PostgreSQL writer that bypassed the Firestore permit fence is fatal.
 if((await readAppliedProof(pool,recovery)).sequence!==snapshot.sequence)
  throw bad('spark-handback-outbox-diverged');
 const baseHash=sha256('snapshot:'+snapshot.snapshotHash+':'+snapshot.sequence);
 const next={protocol:1,projectId:'samosval-offline',channel:'test',writer:'synology',
  generation,snapshotHash:snapshot.snapshotHash,
  baseSequence:snapshot.sequence,baseHash,
  lastSequence:snapshot.sequence,hash:baseHash,
  rowCount:snapshot.rows.length,accessProtocol:1,
  accessCount:entries.accessCount,typedProtocol:1,
  typedSequence:snapshot.sequence,readyForFailover:false,updatedAt:now};
 await withPgOutboxFence(pool,snapshot.sequence,()=>firestore.runTransaction(async tx=>{
  const [ms,os]=await Promise.all([
   tx.get(firestore.doc(REPLICA_DOC)),tx.get(firestore.doc(OWNER_DOC))]);
  const old=snap(ms),owner=snap(os);
  if(old?.generation!==manifest.generation||
     old.lastSequence!==manifest.baseSequence||old.hash!==manifest.baseHash||
     old.typedProtocol!==1||old.readyForFailover!==true||
     owner?.owner!=='reconciling'||owner.holder!=='reconcile_worker'||
     owner.epoch!==manifest.ownerEpoch||
     owner.recovery?.generation!==manifest.generation||
     owner.recovery?.status!=='frozen'||
     owner.pending&&Object.keys(owner.pending).length!==0)
   throw bad('spark-handback-ownership-changed');
  tx.set(firestore.doc(REPLICA_DOC),next);
  tx.update(firestore.doc(OWNER_DOC),{
   owner:'handoff',holder:'reconcile_worker',
   epoch:owner.epoch+1,generation,observedSequence:snapshot.sequence,
   leaseUntil:now+OWNER_LEASE_MS,updatedAt:now,pending:{},
   reserveSequence:0,reserveHash:null,
   recovery:{...recovery,status:'staged',frozenEpoch:owner.epoch,
    newGeneration:generation,newSequence:snapshot.sequence,
    newHash:baseHash,newSnapshotHash:snapshot.snapshotHash,stagedAt:now}
  });
 }));
 return {staged:true,resumed:false,generation,sequence:snapshot.sequence,
  documents:entries.documents.length,events:proof.count};
}
export async function completeSparkTypedHandback({firestore,projectId,pool,
 now=Date.now(),fenceEnabled=process.env.TEST_WRITER_FENCE_ENABLED==='1'}={}){
 guard({firestore,projectId,pool,fenceEnabled});
 const {m,o}=await readRemote(firestore);
 if(o?.owner==='synology'&&o.recovery?.status==='completed'&&
    o.recovery?.typedProtocol===1&&o.recovery?.newGeneration===m?.generation)
  return {completed:true,resumed:true,generation:m.generation};
 const snapshot=await verifyStaged({firestore,pool,m,o});
 // If the previous attempt wrote the SQL receipt but its ACK vanished,
 // this monotonic receipt update remains idempotent on retry.
 await storeReceipt(pool,m.lastSequence,m.hash);
 await withPgOutboxFence(pool,snapshot.sequence,()=>firestore.runTransaction(async tx=>{
  const [ms,os]=await Promise.all([
   tx.get(firestore.doc(REPLICA_DOC)),tx.get(firestore.doc(OWNER_DOC))]);
  const currentMeta=snap(ms),owner=snap(os);
  const r=stagedOwner(currentMeta,owner);
  if(owner.epoch!==o.epoch||currentMeta.generation!==m.generation||
     currentMeta.hash!==m.hash||currentMeta.snapshotHash!==m.snapshotHash||
     r.manifestHash!==o.recovery.manifestHash)
   throw bad('spark-handback-owner-changed');
  // Hold NAS fenced until it explicitly claims a NEW epoch in a fresh
  // process with the independently confirmed PostgreSQL receipt.
  tx.update(firestore.doc(OWNER_DOC),{
   owner:'synology',holder:'nas_handoff_pending',
   epoch:owner.epoch+1,leaseUntil:now-FENCE_GRACE_MS-OWNER_LEASE_MS-1,
   updatedAt:now,pending:{},observedSequence:m.lastSequence,
   recovery:{...r,status:'completed',completedAt:now}
  });
 }));
 return {completed:true,resumed:false,generation:m.generation,
  sequence:m.lastSequence};
}
