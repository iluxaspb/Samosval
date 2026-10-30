// TEST mirror protocol v1: PostgreSQL is the only writer.
// This namespace is NOT the legacy application Firestore schema or a failover endpoint.
// The server must never enable Firebase business writes based on these checkpoints alone.
import {createHash, randomUUID} from 'node:crypto';

export const REPLICA_DOC='samosval_test_replica/v1';
const OWNER_DOC='samosval_test_replica/write_owner';
// Every forward commit must be fenced by the same Firestore writer epoch.
export function assertMirrorWriter(state,metadata,now=Date.now()){
 if(!state)return;
 if(!metadata||state.protocol!==1||state.projectId!=='samosval-offline'||
   state.owner!=='synology'||state.generation!==metadata.generation||
   !Number.isSafeInteger(state.leaseUntil)||state.leaseUntil<=now)
  throw Error('replica-writer-not-synology');
}

export const MIRROR_TABLES=Object.freeze([
 'app_users','archive_overrides','control_audit','control_operation_receipts',
 'game_records','history_audit','history_receipts','identity_audit','identity_receipts',
 'identity_state','line_audit','line_history','line_logs','line_operation_receipts',
 'line_truck_statuses','line_trucks','migration_documents','migration_imports',
 'notification_outbox','registration_requests','role_permission_versions',
 'role_permissions','server_control_events','server_control_jobs','server_control_state',
 'shift_archives','shift_operation_receipts','shifts','tabel_policy','tabel_receipts',
 'tabel_records','workspace_aux_records','workspace_backups','workspace_objects',
 'workspace_service_audit','workspace_service_receipts','workspace_services_state',
 'workspace_settings','workspaces'
]);
const LIMIT_ROWS=50000, LIMIT_BYTES=70000000, CHUNK=20, MAX_BATCH_BYTES=6500000;
export function assertTestProject(projectId){
 if(projectId!=='samosval-offline')throw Error('replica-test-project-required');
}
export function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
export const sha256=s=>createHash('sha256').update(s).digest('hex');
const int=x=>{
 const n=Number(x);
 if(!Number.isSafeInteger(n)||n<0)throw Error('replica-unsafe-sequence');
 return n;
};
const hex=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
export function rowId(table,key){
 if(!MIRROR_TABLES.includes(table)||!key||typeof key!=='object'||Array.isArray(key)||!Object.keys(key).length)throw Error('replica-invalid-row-key');
 return table+'_'+sha256(table+'\n'+canonical(key));
}
export const rowRef=(db,generation,table,key)=>db.doc(REPLICA_DOC+'/rows_'+generation+'/'+rowId(table,key));
const eventRef=(db,generation,sequence)=>db.doc(REPLICA_DOC+'/events_'+generation+'/'+String(sequence).padStart(20,'0'));
const rowEnvelope=(table,key,row,seq)=>({
 table,keyJson:canonical(key),rowJson:canonical(row),appliedSequence:seq
});
function validateRowSize(x){
 if(Buffer.byteLength(JSON.stringify(x),'utf8')>900000)throw Error('replica-firestore-document-too-large');
 return x;
}
export function nextHash(previous,event){
 if(!hex(previous)||!MIRROR_TABLES.includes(event.table_name)||!['upsert','delete'].includes(event.action)||!event.row_key||
 (event.action==='upsert'&&!event.row_data)||(event.action==='delete'&&event.row_data!==null))throw Error('replica-invalid-event');
 return sha256(previous+'\n'+canonical({
  sequence:int(event.sequence),table:event.table_name,action:event.action,
  key:event.row_key,row:event.row_data
 }));
}
function metadataValid(m){
 return m&&m.protocol===1&&m.channel==='test'&&m.writer==='synology'&&m.projectId==='samosval-offline'&&
 /^[0-9a-f]{24}$/.test(m.generation||'')&&hex(m.snapshotHash)&&hex(m.baseHash)&&hex(m.hash)&&
 Number.isSafeInteger(m.baseSequence)&&Number.isSafeInteger(m.lastSequence)&&m.baseSequence>=0&&
 m.lastSequence>=m.baseSequence&&m.readyForFailover===false;
}
const readMeta=async db=>{
 const snap=await db.doc(REPLICA_DOC).get();
 if(!snap.exists)return null;
 const m=snap.data();
 if(!metadataValid(m))throw Error('replica-remote-protocol-mismatch');
 return m;
};
async function readReceipt(pool){
 const r=await pool.query('SELECT sequence::text,hash,updated_at FROM reserve_replica_receipt WHERE singleton=true');
 return r.rows.length?{sequence:int(r.rows[0].sequence),hash:r.rows[0].hash,updatedAt:r.rows[0].updated_at}:null;
}
export async function storeReceipt(pool,sequence,hash){
 if(!hex(hash))throw Error('replica-invalid-hash');
 await pool.query(
 'INSERT INTO reserve_replica_receipt(singleton,sequence,hash) VALUES(true,$1,$2) '+
 'ON CONFLICT(singleton) DO UPDATE SET sequence=EXCLUDED.sequence,hash=EXCLUDED.hash,updated_at=now() '+
 'WHERE reserve_replica_receipt.sequence<=EXCLUDED.sequence',
 [sequence,hash]);
}
async function cursor(pool){
 const r=await pool.query('SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true');
 if(r.rows.length!==1)throw Error('replica-outbox-cursor-missing');
 return int(r.rows[0].n);
}
async function eventsAfter(pool,sequence,limit=CHUNK){
 const rows=(await pool.query(
  'SELECT sequence::text,table_name,action,row_key,row_data FROM reserve_replica_outbox WHERE sequence>$1 ORDER BY sequence LIMIT $2',
  [sequence,limit])).rows;
 return rows.map(e=>({...e,sequence:int(e.sequence)}));
}
function contiguous(events,start){
 events.forEach((e,i)=>{if(e.sequence!==start+i+1)throw Error('replica-outbox-sequence-gap');});
}
async function verifyChain(pool,meta){
 let seq=meta.baseSequence,hash=meta.baseHash;
 if(hash!==sha256('snapshot:'+meta.snapshotHash+':'+seq))throw Error('replica-base-hash-mismatch');
 while(seq<meta.lastSequence){
  const rows=await eventsAfter(pool,seq,Math.min(CHUNK,meta.lastSequence-seq));
  if(!rows.length)throw Error('replica-outbox-history-missing');
  contiguous(rows,seq);
  for(const row of rows)hash=nextHash(hash,row);
  seq=rows.at(-1).sequence;
 }
 if(hash!==meta.hash)throw Error('replica-checkpoint-hash-mismatch');
 if(meta.lastSequence>await cursor(pool))throw Error('replica-remote-ahead-of-postgres');
 return {sequence:seq,hash};
}
function sqlIdentifier(x){
 if(!/^[a-z][a-z0-9_]*$/.test(x))throw Error('replica-invalid-table');
 return '"'+x+'"';
}
export async function collectSnapshot(pool){
 const c=await pool.connect(),h=createHash('sha256'),rows=[];
 let totalBytes=0,sequence=0;
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  // Read the committed outbox high-water in the SAME MVCC snapshot as the rows.
  sequence=int((await c.query('SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true')).rows[0]?.n);
  const names=(await c.query(
   "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN "+
   "('reserve_outbox_cursor','reserve_replica_outbox','reserve_replica_receipt','migration_probe_evidence') ORDER BY tablename"
  )).rows.map(x=>x.tablename).sort();
  if(canonical(names)!==canonical([...MIRROR_TABLES].sort()))throw Error('replica-inventory-mismatch');
  for(const table of MIRROR_TABLES){
   const keys=(await c.query(
    'SELECT a.attname FROM pg_index i JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(num,ord) ON true '+
    'JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num '+
    'WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY a.attname',
    ['public.'+table])).rows.map(r=>r.attname);
   if(!keys.length)throw Error('replica-primary-key-missing');
   const data=(await c.query('SELECT to_jsonb(t) AS value FROM public.'+sqlIdentifier(table)+' t')).rows;
   for(const entry of data){
    const value=entry.value,key=Object.fromEntries(keys.map(k=>[k,value[k]]));
    if(keys.some(k=>value[k]===undefined||value[k]===null))throw Error('replica-row-key-null');
    const envelope=validateRowSize(rowEnvelope(table,key,value,sequence));
    totalBytes+=Buffer.byteLength(JSON.stringify(envelope));
    if(rows.length>=LIMIT_ROWS||totalBytes>LIMIT_BYTES)throw Error('replica-snapshot-cap-exceeded');
    rows.push({table,key,envelope,id:rowId(table,key)});
   }
  }
  rows.sort((a,b)=>a.id.localeCompare(b.id,'en'));
  for(const row of rows)h.update(row.table+'\n'+row.envelope.keyJson+'\n'+row.envelope.rowJson+'\n');
  await c.query('COMMIT');
  return {rows,sequence,snapshotHash:h.digest('hex')};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}
async function assertFreshVerifiedBackup(pool){
 const state=(await pool.query("SELECT heartbeat,payload FROM server_control_state WHERE channel='test'")).rows[0];
 const freshness=Date.now()-Date.parse(state?.heartbeat||0);
 if(!Number.isFinite(freshness)||freshness<0||freshness>120000)
  throw Error('replica-control-worker-not-current');
 const copies=state.payload?.backups||[];
 if(!Array.isArray(copies)||!copies.some(b=>b.restored===true&&
  Number.isFinite(Number(b.createdAt))&&Date.now()-Number(b.createdAt)>=0&&
  Date.now()-Number(b.createdAt)<6*60*60*1000))
   throw Error('replica-fresh-verified-backup-required');
}
async function bootstrap(pool,db){
 // The initial transfer requires a restored DB backup made within 6 hours.
 // It does not use or restore that dump, so no stale state overwrites NAS.
 await assertFreshVerifiedBackup(pool);
 // Keep all unverified rows invisible in a new immutable generation.
 const snapshot=await collectSnapshot(pool);
 const generation=sha256(randomUUID()).slice(0,24),metaRef=db.doc(REPLICA_DOC);
 for(let start=0;start<snapshot.rows.length;){
  const batch=db.batch();let total=0,count=0;
  for(const row of snapshot.rows.slice(start,start+CHUNK)){
   const bytes=Buffer.byteLength(JSON.stringify(row.envelope),'utf8')+1024;
   if(count&&total+bytes>MAX_BATCH_BYTES)break;
   if(bytes>MAX_BATCH_BYTES)throw Error('replica-snapshot-write-too-large');
   batch.set(rowRef(db,generation,row.table,row.key),row.envelope);
   total+=bytes;count++;
  }
  await batch.commit();start+=count;
 }
 // Verify the actual remote generation, not just local checksum calculations.
 // An incomplete upload is never published by the singleton metadata pointer.
 const remoteDocs=(await db.collection(REPLICA_DOC+'/rows_'+generation).get()).docs;
 if(remoteDocs.length!==snapshot.rows.length)throw Error('replica-snapshot-row-count-mismatch');
 const check=createHash('sha256');
 remoteDocs.sort((a,b)=>a.id.localeCompare(b.id,'en'));
 for(const doc of remoteDocs){
  const value=doc.data(),key=JSON.parse(value?.keyJson||'null');
  if(value?.appliedSequence!==snapshot.sequence||!MIRROR_TABLES.includes(value?.table)||
    doc.id!==rowId(value.table,key)||typeof value.rowJson!=='string')
   throw Error('replica-snapshot-document-mismatch');
  check.update(value.table+'\n'+value.keyJson+'\n'+value.rowJson+'\n');
 }
 if(check.digest('hex')!==snapshot.snapshotHash)throw Error('replica-snapshot-hash-mismatch');
 const baseHash=sha256('snapshot:'+snapshot.snapshotHash+':'+snapshot.sequence);
 const m={protocol:1,channel:'test',writer:'synology',projectId:'samosval-offline',
  generation,snapshotHash:snapshot.snapshotHash,baseSequence:snapshot.sequence,
  baseHash,lastSequence:snapshot.sequence,hash:baseHash,
  rowCount:snapshot.rows.length,readyForFailover:false,updatedAt:Date.now()};
 await db.runTransaction(async tx=>{
  const old=await tx.get(metaRef);
  if(old.exists)throw Error('replica-remote-already-initialized');
  tx.create(metaRef,m);
 });
 await storeReceipt(pool,m.lastSequence,m.hash);
 return {bootstrapped:true,sequence:m.lastSequence,rows:snapshot.rows.length};
}
async function confirmRemoteAhead(pool,remote,receipt){
 if(remote.lastSequence<receipt.sequence)throw Error('replica-remote-checkpoint-regressed');
 if(remote.lastSequence===receipt.sequence&&remote.hash!==receipt.hash)throw Error('replica-checkpoint-diverged');
 if(remote.lastSequence>receipt.sequence){
  const verified=await verifyChain(pool,remote);
  if(receipt.sequence<remote.baseSequence)throw Error('replica-local-receipt-before-snapshot');
  // Verify that the remote's chain includes the exact locally confirmed digest.
  let seq=remote.baseSequence,h=remote.baseHash;
  while(seq<receipt.sequence){
   const rows=await eventsAfter(pool,seq,Math.min(CHUNK,receipt.sequence-seq));
   if(!rows.length)throw Error('replica-outbox-history-missing');
   contiguous(rows,seq);
   for(const r of rows)h=nextHash(h,r);
   seq=rows.at(-1).sequence;
  }
  if(h!==receipt.hash)throw Error('replica-confirmed-history-conflict');
  await storeReceipt(pool,verified.sequence,verified.hash);
  return {recovered:true,sequence:verified.sequence};
 }
 return null;
}
export async function replicateOnce({pool,firestore,projectId}){
 assertTestProject(projectId);
 if(!pool||!firestore||typeof firestore.runTransaction!=='function')throw Error('replica-invalid-dependencies');
 let receipt=await readReceipt(pool),remote=await readMeta(firestore);
 const ownerSnap=await firestore.doc(OWNER_DOC).get();
 assertMirrorWriter(ownerSnap.exists?ownerSnap.data():null,remote);
 if(!receipt&&!remote)return bootstrap(pool,firestore);
 if(!remote)throw Error('replica-remote-checkpoint-missing');
 if(!receipt){
  const verified=await verifyChain(pool,remote);
  await storeReceipt(pool,verified.sequence,verified.hash);
  return {recovered:true,sequence:verified.sequence};
 }
 const recovered=await confirmRemoteAhead(pool,remote,receipt);
 if(recovered)return recovered;
 const pending=await eventsAfter(pool,receipt.sequence);
 if(!pending.length)return {idle:true,sequence:receipt.sequence,lag:(await cursor(pool))-receipt.sequence};
 // Firestore transaction size is capped. Every event stores both an immutable
 // ledger entry and (if upsert) one materialized row, so count BOTH payloads.
 const rows=[];let batchBytes=0;
 for(const item of pending){
  const ledger=validateRowSize({
   sequence:item.sequence,table:item.table_name,action:item.action,
   keyJson:canonical(item.row_key),rowJson:item.row_data===null?null:canonical(item.row_data)
  });
  const row=item.action==='upsert'?validateRowSize(rowEnvelope(item.table_name,item.row_key,item.row_data,item.sequence)):null;
  const bytes=Buffer.byteLength(JSON.stringify(ledger),'utf8')+
    (row?Buffer.byteLength(JSON.stringify(row),'utf8'):256)+2048;
  if(rows.length&&batchBytes+bytes>MAX_BATCH_BYTES)break;
  if(bytes>MAX_BATCH_BYTES)throw Error('replica-transaction-too-large');
  rows.push(item);batchBytes+=bytes;
 }
 contiguous(rows,receipt.sequence);
 let hash=receipt.hash;
 for(const event of rows)hash=nextHash(hash,event);
 const latest=rows.at(-1).sequence;
 const ref=firestore.doc(REPLICA_DOC);
 await firestore.runTransaction(async tx=>{
  const [snap,ownership]=await Promise.all([tx.get(ref),tx.get(firestore.doc(OWNER_DOC))]);
  const m=snap.exists?snap.data():null;
  assertMirrorWriter(ownership.exists?ownership.data():null,m);
  if(!metadataValid(m)||m.generation!==remote.generation||
    m.lastSequence!==receipt.sequence||m.hash!==receipt.hash)throw Error('replica-remote-write-owner-changed');
  // Multiple changes to the same row can appear in one transaction. Fold
  // materialized rows to their last state but retain every journal event.
  const finalRows=new Map();
  for(const event of rows){
   const item=rowRef(firestore,m.generation,event.table_name,event.row_key);
   finalRows.set(item.path,{item,event});
   tx.create(eventRef(firestore,m.generation,event.sequence),validateRowSize({
    sequence:event.sequence,table:event.table_name,action:event.action,
    keyJson:canonical(event.row_key),rowJson:event.row_data===null?null:canonical(event.row_data),
    previousCheckpoint:receipt.sequence
   }));
  }
  for(const {item,event} of finalRows.values()){
   if(event.action==='delete')tx.delete(item);
   else tx.set(item,validateRowSize(rowEnvelope(event.table_name,event.row_key,event.row_data,event.sequence)));
  }
  tx.update(ref,{lastSequence:latest,hash,updatedAt:Date.now(),readyForFailover:false});
 });
 // If the Firebase commit succeeded but the reply was lost, the next tick
 // verifies the exact remote journal chain before acknowledging locally.
 await storeReceipt(pool,latest,hash);
 return {delivered:rows.length,sequence:latest,lag:(await cursor(pool))-latest};
}
export async function readReplicaStatus(pool,runner={}){
 const enabled=runner.enabled===true;
 try{
  const [receipt,head]=await Promise.all([readReceipt(pool),cursor(pool)]);
  return {enabled,mode:'passive-mirror',projectId:enabled?'samosval-offline':null,
   activeOwner:'synology',readyForFailover:false,reverseSyncEnabled:false,
   lastSequence:head,deliveredSequence:receipt?.sequence??null,
   lag:receipt?Math.max(0,head-receipt.sequence):null,
   lastConfirmedAt:receipt?.updatedAt??null,
   lastSuccessAt:runner.lastSuccessAt||null,
   lastError:runner.lastError||null};
 }catch{
  return {enabled,mode:'passive-mirror',activeOwner:'synology',
   readyForFailover:false,reverseSyncEnabled:false,lastError:'replica-journal-unavailable'};
 }
}
