// TEST ONLY. Re-certify a complete PostgreSQL -> Firestore Spark generation.
// Never runs on the NAS schedule, HTTP API, updater, or user's phone.
// It cannot arm SQL 016: the DBA must first prove every background worker
// participates in the same Firestore permit / PostgreSQL transaction fence.
import {Timestamp} from 'firebase-admin/firestore';
import {assertTestProject,REPLICA_DOC,canonical,collectSnapshot,rowRef,
 sha256} from './test-replica.mjs';
import {OWNER_DOC,OPERATION_HOLD_MS} from './test-writer-coordinator.mjs';
import {buildSparkTypedLineSnapshot,sparkTypedPaths} from './test-spark-typed.mjs';
import {accessRowsFromMirrorSnapshot,sparkAccessRef} from './test-spark-access.mjs';
import {assertSparkBootstrapBudget} from './test-spark-limits.mjs';

const TEST_DB=/^sc_verify_[0-9]+$/,WS='main_workspace',GEN=/^[0-9a-f]{24}$/,HEX=/^[0-9a-f]{64}$/;
const bad=code=>Object.assign(new Error(code),{code});
const snap=s=>s?.exists?s.data():null;
const seq=x=>Number.isSafeInteger(x)&&x>=0;
const equal=(a,b)=>canonical(a)===canonical(b);
const normalize=s=>{
 if(!s||typeof s!=='object')return s;
 const {sourceSequence,...row}=s;
 return row;
};
function guard({projectId,firestore,pool,fenceEnabled}){
 if(fenceEnabled!==true)throw bad('spark-certify-fence-not-enabled');
 assertTestProject(projectId);
 if(!firestore?.doc||!firestore?.collection||!firestore?.runTransaction||!pool?.connect)
  throw bad('spark-certify-dependencies-required');
}
function state(m,o,now){
 if(m?.protocol!==1||m.channel!=='test'||m.projectId!=='samosval-offline'||
    m.writer!=='synology'||!GEN.test(m.generation||'')||
    !HEX.test(m.hash||'')||!seq(m.lastSequence)||
    m.typedProtocol!==1||m.typedSequence!==m.lastSequence||
    m.accessProtocol!==1||!seq(m.rowCount)||!seq(m.accessCount)||
    o?.protocol!==1||o.projectId!=='samosval-offline'||
    o.owner!=='synology'||o.generation!==m.generation||
    !seq(o.epoch)||o.epoch<1||!seq(o.observedSequence)||
    o.observedSequence!==m.lastSequence||!seq(o.leaseUntil)||
    o.leaseUntil<=now+OPERATION_HOLD_MS||
    !o.pending||Object.keys(o.pending).length!==0)
   throw bad('spark-certify-owner-not-ready');
}
async function sqlProof(pool){
 const c=await pool.connect();
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const db=(await c.query('SELECT current_database() AS name')).rows[0]?.name;
  if(db!=='samosval_test'&&!TEST_DB.test(db||''))
   throw bad('spark-certify-test-database-required');
  let gate;
  try{
   gate=(await c.query('SELECT armed,coverage_certified,owner_epoch::text AS epoch '+
    'FROM reserve_control.writer_gate WHERE singleton=true')).rows[0];
  }catch(error){
   if(error.code==='42P01'||error.code==='3F000')throw bad('spark-certify-sql016-required');
   throw error;
  }
  if(gate?.armed!==true||gate.coverage_certified!==true||
     !seq(Number(gate.epoch))||Number(gate.epoch)<1)
   throw bad('spark-certify-global-writer-coverage-required');
  const triggers=(await c.query(
   "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='spark_writer_gate' AND NOT tgisinternal"
  )).rows[0]?.n;
  if(triggers!==39)throw bad('spark-certify-global-fence-inventory-diverged');
  const head=Number((await c.query(
   'SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true'
  )).rows[0]?.n);
  const receipt=(await c.query(
   'SELECT sequence::text AS n,hash FROM reserve_replica_receipt WHERE singleton=true'
  )).rows[0];
  if(!seq(head)||Number(receipt?.n)!==head||!HEX.test(receipt?.hash||''))
   throw bad('spark-certify-nas-not-fully-mirrored');
  await c.query('COMMIT');
  return {epoch:Number(gate.epoch),sequence:head,hash:receipt.hash};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}
async function fullCollection(firestore,path,expected,{normalizeSource=false}={}){
 const docs=(await firestore.collection(path).get()).docs;
 if(docs.length!==expected.size)throw bad('spark-certify-remote-document-count-diverged');
 const seen=new Set();
 for(const item of docs){
  if(!expected.has(item.id)||seen.has(item.id))
   throw bad('spark-certify-unexpected-remote-document');
  seen.add(item.id);
  const value=item.data(),wanted=expected.get(item.id);
  if(normalizeSource){
   if(!seq(value?.sourceSequence)||value.sourceSequence>wanted.sourceSequence||
      !equal(normalize(value),normalize(wanted)))
    throw bad('spark-certify-projection-diverged');
  }else{
   if(value?.table!==wanted.table||value.keyJson!==wanted.keyJson||
      value.rowJson!==wanted.rowJson||!seq(value.appliedSequence)||
      value.appliedSequence>wanted.appliedSequence)
    throw bad('spark-certify-mirror-row-diverged');
  }
 }
}
function sourceProof(m,o){
 return {generation:m.generation,epoch:o.epoch,sequence:m.lastSequence,
  hash:m.hash};
}
async function readRemote(db){
 const [ms,os]=await Promise.all([
  db.doc(REPLICA_DOC).get(),db.doc(OWNER_DOC).get()
 ]);
 return {m:snap(ms),o:snap(os)};
}
function sameSource(a,b){
 return equal(sourceProof(a.m,a.o),sourceProof(b.m,b.o))&&
  equal(a.o.pending,b.o.pending)&&a.o.owner===b.o.owner&&
  a.m.readyForFailover===b.m.readyForFailover;
}
export async function inspectSparkPromotionReadiness({
 firestore,pool,projectId,fenceEnabled=process.env.TEST_WRITER_FENCE_ENABLED==='1',
 now=Date.now()
}={}){
 guard({firestore,pool,projectId,fenceEnabled});
 const first=await readRemote(firestore);
 state(first.m,first.o,now);
 const sql=await sqlProof(pool);
 if(sql.epoch!==first.o.epoch||sql.sequence!==first.m.lastSequence||
    sql.hash!==first.m.hash)
  throw bad('spark-certify-nas-replica-head-diverged');
 const snapshot=await collectSnapshot(pool);
 if(snapshot.sequence!==sql.sequence||snapshot.rows.length!==first.m.rowCount)
  throw bad('spark-certify-postgres-snapshot-diverged');
 const typed=buildSparkTypedLineSnapshot({
  snapshot,generation:first.m.generation,fromMillis:ms=>Timestamp.fromMillis(ms)
 });
 const access=accessRowsFromMirrorSnapshot(snapshot,first.m.generation);
 const p=sparkTypedPaths(first.m.generation);
 const raw=new Map(snapshot.rows.map(row=>[row.id,row.envelope]));
 const config=new Map([['active',typed.config]]);
 const trucks=new Map(typed.trucks),statuses=new Map(typed.statuses);
 const grants=new Map(access.map(a=>[a.uid,a]));
 const docCount=raw.size+config.size+trucks.size+statuses.size+grants.size;
 assertSparkBootstrapBudget(docCount);
 if(access.length!==first.m.accessCount)throw bad('spark-certify-access-count-diverged');
 const prefix=REPLICA_DOC+'/';
 await fullCollection(firestore,prefix+'rows_'+first.m.generation,raw);
 await fullCollection(firestore,prefix+'typed_config_'+first.m.generation,config,
  {normalizeSource:true});
 await fullCollection(firestore,prefix+'typed_trucks_'+first.m.generation,trucks,
  {normalizeSource:true});
 await fullCollection(firestore,prefix+'typed_status_'+first.m.generation,statuses,
  {normalizeSource:true});
 await fullCollection(firestore,prefix+'access_'+first.m.generation,grants,
  {normalizeSource:true});
 const after=await readRemote(firestore);
 if(!sameSource(first,after))throw bad('spark-certify-owner-changed-during-audit');
 const local=await sqlProof(pool);
 if(local.epoch!==sql.epoch||local.sequence!==sql.sequence||local.hash!==sql.hash)
  throw bad('spark-certify-sql-changed-during-audit');
 return Object.freeze({...sourceProof(first.m,first.o),documents:docCount,
  rows:raw.size,grants:grants.size,typedStatuses:statuses.size,
  snapshotHash:snapshot.snapshotHash});
}
export async function certifySparkPromotion({
 firestore,pool,projectId,fenceEnabled=process.env.TEST_WRITER_FENCE_ENABLED==='1',
 now=Date.now()
}={}){
 const inspected=await inspectSparkPromotionReadiness({
  firestore,pool,projectId,fenceEnabled,now
 });
 const metaRef=firestore.doc(REPLICA_DOC),ownerRef=firestore.doc(OWNER_DOC);
 const proof={protocol:2,writerGate:'sql016',generation:inspected.generation,
  epoch:inspected.epoch,sequence:inspected.sequence,hash:inspected.hash,
  snapshotHash:inspected.snapshotHash,documents:inspected.documents};
 return firestore.runTransaction(async tx=>{
  const [ms,os]=await Promise.all([tx.get(metaRef),tx.get(ownerRef)]);
  const m=snap(ms),o=snap(os);
  state(m,o,now);
  if(m.generation!==proof.generation||m.hash!==proof.hash||
     m.lastSequence!==proof.sequence||o.epoch!==proof.epoch)
   throw bad('spark-certify-owner-changed-before-publish');
  if(m.readyForFailover===true){
   if(!equal(m.promotionProof,proof))
    throw bad('spark-certify-existing-certificate-diverged');
   return {certified:true,resumed:true,...inspected};
  }
  if(m.readyForFailover!==false)
   throw bad('spark-certify-metadata-invalid');
  tx.update(metaRef,{readyForFailover:true,promotionProof:proof,
   updatedAt:now});
  return {certified:true,resumed:false,...inspected};
 });
}
