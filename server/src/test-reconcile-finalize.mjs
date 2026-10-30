// TEST reconciled handback: verified, signed full-generation rebase.
// A two-stage owner handoff prevents enabling NAS until its new PostgreSQL
// mirror receipt is written. No stale Firebase export is copied into NAS.
import {randomUUID,createHash} from 'node:crypto';
import {assertTestProject,REPLICA_DOC,collectSnapshot,rowRef,sha256,
 storeReceipt,canonical} from './test-replica.mjs';
import {OWNER_DOC,FENCE_GRACE_MS,OWNER_LEASE_MS} from './test-writer-coordinator.mjs';
const MAX_BYTES=6500000,CHUNK=20,ROW_LIMIT=900000;
const bad=code=>Object.assign(new Error(code),{code});
const snap=s=>s?.exists?s.data():null;
const hex=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
function validateReconcile(o,m){
 const r=o?.recovery;
 if(o?.owner!=='reconciling'||r?.status!=='applied'||
   r.appliedSequence!==r.targetSequence||r.appliedHash!==r.targetHash||
   r.generation!==m?.generation||r.baseHash!==m?.hash||
   r.baseSequence!==m?.lastSequence||m.readyForFailover!==true)
  throw bad('handoff-not-reconciled');
 return r;
}
function buildMeta(snapshot,generation){
 const baseHash=sha256('snapshot:'+snapshot.snapshotHash+':'+snapshot.sequence);
 return {protocol:1,channel:'test',writer:'synology',projectId:'samosval-offline',
  generation,snapshotHash:snapshot.snapshotHash,baseSequence:snapshot.sequence,
  baseHash,lastSequence:snapshot.sequence,hash:baseHash,
  rowCount:snapshot.rows.length,readyForFailover:false,updatedAt:Date.now()};
}
async function uploadGeneration(db,snapshot,generation){
 for(let offset=0;offset<snapshot.rows.length;){
  const batch=db.batch();let count=0,size=0;
  for(const row of snapshot.rows.slice(offset,offset+CHUNK)){
   const bytes=Buffer.byteLength(JSON.stringify(row.envelope),'utf8')+1024;
   if(bytes>ROW_LIMIT)throw bad('handoff-record-too-large');
   if(count&&size+bytes>MAX_BYTES)break;
   batch.set(rowRef(db,generation,row.table,row.key),row.envelope);
   size+=bytes;count++;
  }
  await batch.commit();offset+=count;
 }
 await verifyGeneration(db,snapshot,generation);
}
async function verifyGeneration(db,snapshot,generation){
 const docs=(await db.collection(REPLICA_DOC+'/rows_'+generation).get()).docs;
 if(docs.length!==snapshot.rows.length)throw bad('handoff-record-count-diverged');
 docs.sort((a,b)=>a.id.localeCompare(b.id,'en'));
 const hash=createHash('sha256');
 for(const doc of docs){
  const row=doc.data();
  if(!row||typeof row.table!=='string'||typeof row.keyJson!=='string'||
    typeof row.rowJson!=='string'||row.appliedSequence!==snapshot.sequence)
   throw bad('handoff-record-invalid');
  hash.update(row.table+'\n'+row.keyJson+'\n'+row.rowJson+'\n');
 }
 if(hash.digest('hex')!==snapshot.snapshotHash)
  throw bad('handoff-record-hash-diverged');
}
async function readRemote(db){
 const [m,o]=await Promise.all([db.doc(REPLICA_DOC).get(),db.doc(OWNER_DOC).get()]);
 return {m:snap(m),o:snap(o)};
}
export async function stageRecoveredGeneration({firestore,projectId,pool,
 snapshotReader=collectSnapshot,headReader=async pool=>{
  const r=await pool.query('SELECT last_sequence::text AS value FROM reserve_outbox_cursor WHERE singleton=true');
  return Number(r.rows[0]?.value);
 }}={}){
 assertTestProject(projectId);
 const {m,o}=await readRemote(firestore);
 if(o?.owner==='handoff'&&o.recovery?.status==='staged')
  return {staged:true,resumed:true,generation:m.generation};
 validateReconcile(o,m);
 const snapshot=await snapshotReader(pool);
 if(!Number.isSafeInteger(snapshot.sequence)||snapshot.sequence<m.lastSequence||
   !hex(snapshot.snapshotHash)||!Array.isArray(snapshot.rows))
  throw bad('handoff-invalid-snapshot');
 const latest=await headReader(pool);
 if(latest!==snapshot.sequence)throw bad('handoff-nas-changed-after-snapshot');
 const generation=sha256(randomUUID()).slice(0,24);
 await uploadGeneration(firestore,snapshot,generation);
 const next=buildMeta(snapshot,generation);
 const metaRef=firestore.doc(REPLICA_DOC),ownerRef=firestore.doc(OWNER_DOC);
 await firestore.runTransaction(async tx=>{
  const [ms,os]=await Promise.all([tx.get(metaRef),tx.get(ownerRef)]);
  const previous=snap(ms),state=snap(os);
  validateReconcile(state,previous);
  if(previous.generation!==m.generation||state.epoch!==o.epoch||
    state.recovery.appliedHash!==o.recovery.appliedHash)
   throw bad('handoff-generation-changed');
  tx.set(metaRef,next);
  tx.update(ownerRef,{owner:'handoff',holder:'reconcile_worker',epoch:state.epoch+1,
   generation,observedSequence:snapshot.sequence,leaseUntil:Date.now()+OWNER_LEASE_MS,
   pending:{},reserveSequence:0,reserveHash:null,
   recovery:{...state.recovery,status:'staged',
    newGeneration:generation,newSequence:snapshot.sequence,
    newHash:next.hash,newSnapshotHash:snapshot.snapshotHash}});
 });
 return {staged:true,resumed:false,generation,sequence:snapshot.sequence};
}
// On crash or lost Firestore ACK, recompute both local and remote fingerprints.
// Only then is it safe to acknowledge the new PostgreSQL snapshot and hand
// writer ownership back to NAS.
export async function completeNasHandback({firestore,projectId,pool,
 snapshotReader=collectSnapshot,receiptWriter=storeReceipt,now=Date.now()}={}){
 assertTestProject(projectId);
 const {m,o}=await readRemote(firestore);
 if(o?.owner==='synology'&&o.recovery?.status==='completed')
  return {completed:true,replayed:true,sequence:m.lastSequence};
 const staged=o?.owner==='handoff'&&o.recovery?.status==='staged'&&
   o.recovery.newGeneration===m?.generation&&
   o.recovery.newSequence===m.lastSequence&&
   o.recovery.newHash===m.hash&&m.readyForFailover===false;
 if(!staged)throw bad('handoff-not-staged');
 const local=await snapshotReader(pool);
 if(local.sequence!==m.lastSequence||local.snapshotHash!==m.snapshotHash||
   local.rows.length!==m.rowCount)throw bad('handoff-local-snapshot-diverged');
 await verifyGeneration(firestore,local,m.generation);
 await receiptWriter(pool,m.lastSequence,m.hash);
 const metaRef=firestore.doc(REPLICA_DOC),ownerRef=firestore.doc(OWNER_DOC);
 await firestore.runTransaction(async tx=>{
  const [ms,os]=await Promise.all([tx.get(metaRef),tx.get(ownerRef)]);
  const remote=snap(ms),owner=snap(os);
  if(owner?.owner!=='handoff'||owner?.epoch!==o.epoch||
   owner.recovery?.newGeneration!==m.generation||
   owner.recovery?.status!=='staged'||remote.generation!==m.generation||
   remote.hash!==m.hash)throw bad('handoff-owner-changed');
  const recovery={...owner.recovery,status:'completed',completedAt:now};
  // Previous node cannot claim a permit: holder is deliberately different.
  // Fresh NAS process must independently claim the next epoch.
  tx.update(ownerRef,{owner:'synology',holder:'nas_handoff_pending',
   epoch:owner.epoch+1,leaseUntil:now-FENCE_GRACE_MS-OWNER_LEASE_MS-1,
   observedSequence:m.lastSequence,recovery,updatedAt:now});
 });
 return {completed:true,replayed:false,sequence:m.lastSequence,
  generation:m.generation};
}
