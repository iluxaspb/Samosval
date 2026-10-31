// TEST ONLY: rebind the armed SQL016 business-write gate to a newly claimed
// Synology owner epoch AFTER a completed, checked Spark -> PostgreSQL handback.
// Not an HTTP route, scheduler, updater, or automatic NAS migration.
// Firestore remains the ownership authority. No change to production databases.
import {assertTestProject,REPLICA_DOC,canonical,collectSnapshot,sha256}
 from './test-replica.mjs';
import {OWNER_DOC,OPERATION_HOLD_MS} from './test-writer-coordinator.mjs';

const TEST_DB=/^sc_verify_[0-9]+$/,WS='main_workspace';
const GEN=/^[a-f0-9]{24}$/,HEX=/^[a-f0-9]{64}$/,NODE=/^[A-Za-z0-9_-]{8,160}$/;
const bad=code=>Object.assign(new Error(code),{code});
const seq=n=>Number.isSafeInteger(n)&&n>=0;
const snap=s=>s?.exists?s.data():null;
async function remote(firestore){
 const [m,o]=await Promise.all([
  firestore.doc(REPLICA_DOC).get(),firestore.doc(OWNER_DOC).get()
 ]);
 return {m:snap(m),o:snap(o)};
}
function assertRemote({m,o},{nodeId,expectedEpoch,now}){
 const r=o?.recovery;
 if(m?.protocol!==1||m.projectId!=='samosval-offline'||
    m.channel!=='test'||m.writer!=='synology'||
    m.readyForFailover!==false||!GEN.test(m.generation||'')||
    !HEX.test(m.hash||'')||!HEX.test(m.snapshotHash||'')||
    !seq(m.lastSequence)||m.baseSequence!==m.lastSequence||
    m.baseHash!==m.hash||
    sha256('snapshot:'+m.snapshotHash+':'+m.lastSequence)!==m.hash||
    m.typedProtocol!==1||m.typedSequence!==m.lastSequence||
    m.accessProtocol!==1||!seq(m.accessCount)||!seq(m.rowCount)||
    o?.protocol!==1||o.projectId!=='samosval-offline'||
    o.owner!=='synology'||o.holder!==nodeId||o.epoch!==expectedEpoch||
    o.generation!==m.generation||o.observedSequence!==m.lastSequence||
    !seq(o.leaseUntil)||o.leaseUntil<=now+OPERATION_HOLD_MS||
    !o.pending||Array.isArray(o.pending)||Object.keys(o.pending).length!==0||
    o.reserveSequence!==0||o.reserveHash!==null||
    r?.status!=='completed'||r.typedProtocol!==1||
    !GEN.test(r.generation||'')||!HEX.test(r.baseHash||'')||
    !HEX.test(r.manifestHash||'')||
    !seq(r.fromEpoch)||r.fromEpoch<2||!seq(r.baseSequence)||
    !seq(r.eventCount)||!seq(r.frozenEpoch)||
    o.epoch<=r.frozenEpoch+2||
    r.newGeneration!==m.generation||r.newHash!==m.hash||
    r.newSnapshotHash!==m.snapshotHash||r.newSequence!==m.lastSequence)
  throw bad('spark-rebind-firestore-owner-not-certified');
 return r;
}
function sameRemote(a,b){
 // Includes the owner lease, pending map, all handback identifiers, and all
 // metadata. If anything changed while PostgreSQL was locked, fail closed.
 return canonical(a)===canonical(b);
}
function assertCheckpoint(cp,r,m,head,receipt){
 if(!cp||cp.workspace_id!==WS||cp.state!=='applied'||
    cp.generation!==r.generation||Number(cp.from_epoch)!==r.fromEpoch||
    Number(cp.base_sequence)!==r.baseSequence||
    cp.base_hash!==r.baseHash||cp.manifest_hash!==r.manifestHash||
    Number(cp.event_count)!==r.eventCount||
    Number(cp.applied_count)!==r.eventCount||
    Number(cp.outbox_sequence)!==m.lastSequence||
    head!==m.lastSequence||Number(receipt?.sequence)!==m.lastSequence||
    receipt?.hash!==m.hash||
    !HEX.test(cp.planned_hash||'')||
    cp.plan?.format!=='spark-typed-pg-dry-run'||cp.plan.version!==1||
    cp.plan.generation!==r.generation||
    cp.plan.fromEpoch!==r.fromEpoch||
    cp.plan.baseSequence!==r.baseSequence||
    cp.plan.baseHash!==r.baseHash||
    cp.plan.eventCount!==r.eventCount||
    cp.plan.plannedHash!==cp.planned_hash||
    !Array.isArray(cp.plan.operations)||
    cp.plan.operations.length!==r.eventCount||
    sha256(canonical(cp.plan.operations))!==cp.planned_hash)
  throw bad('spark-rebind-sql015-checkpoint-diverged');
}
async function verifyGateInventory(c){
 const totals=(await c.query(
  "SELECT count(*) FILTER(WHERE tgname='spark_writer_gate')::int AS rows,"+
  " count(*) FILTER(WHERE tgname='spark_writer_gate_truncate')::int AS truncates"+
  " FROM pg_trigger WHERE NOT tgisinternal"
 )).rows[0];
 const uncovered=(await c.query(
  "SELECT count(*)::int AS n FROM pg_trigger src "+
  "WHERE src.tgname='reserve_row_change' AND NOT src.tgisinternal "+
  "AND (NOT EXISTS(SELECT 1 FROM pg_trigger gate WHERE gate.tgrelid=src.tgrelid "+
  "AND gate.tgname='spark_writer_gate' AND NOT gate.tgisinternal) "+
  "OR NOT EXISTS(SELECT 1 FROM pg_trigger gate WHERE gate.tgrelid=src.tgrelid "+
  "AND gate.tgname='spark_writer_gate_truncate' AND NOT gate.tgisinternal))"
 )).rows[0]?.n;
 if(totals?.rows!==39||totals?.truncates!==39||uncovered!==0)
  throw bad('spark-rebind-sql016-inventory-diverged');
}
export async function rebindSparkSqlWriterEpoch({
 firestore,pool,projectId,nodeId,expectedEpoch,now=Date.now(),
 fenceEnabled=process.env.TEST_WRITER_FENCE_ENABLED==='1'
}={}){
 if(fenceEnabled!==true)throw bad('spark-rebind-fence-required');
 assertTestProject(projectId);
 if(!pool?.connect||!firestore?.doc||!NODE.test(nodeId||'')||
    !seq(expectedEpoch)||expectedEpoch<1||!seq(now)||now<1)
  throw bad('spark-rebind-options-invalid');
 const first=await remote(firestore);
 const recovery=assertRemote(first,{nodeId,expectedEpoch,now});
 const c=await pool.connect();
 let committed=false,rebound=false,previousEpoch=null;
 try{
  await c.query('BEGIN');
  const db=(await c.query('SELECT current_database() AS name')).rows[0]?.name;
  if(db!=='samosval_test'&&!TEST_DB.test(db||''))
   throw bad('spark-rebind-test-database-required');
  let gate;
  try{
   // Lock this row FIRST. SQL016 write triggers acquire FOR SHARE on the
   // same row before SQL014 advances the outbox, so no old-epoch write
   // can commit between our verification and the epoch transition.
   gate=(await c.query('SELECT armed,coverage_certified,owner_epoch::text AS epoch '+
    'FROM reserve_control.writer_gate WHERE singleton=true FOR UPDATE')).rows[0];
  }catch(error){
   if(error.code==='42P01'||error.code==='3F000')
    throw bad('spark-rebind-sql016-required');
   throw error;
  }
  const old=Number(gate?.epoch);
  if(gate?.armed!==true||gate.coverage_certified!==true||
     !seq(old)||old<1||old>expectedEpoch)
   throw bad('spark-rebind-sql016-not-certified');
  previousEpoch=old;
  await verifyGateInventory(c);
  const head=Number((await c.query(
   'SELECT last_sequence::text AS sequence FROM reserve_outbox_cursor WHERE singleton=true FOR UPDATE'
  )).rows[0]?.sequence);
  const cp=(await c.query(
   'SELECT * FROM reserve_spark_replay_checkpoint WHERE singleton=true FOR SHARE'
  )).rows[0];
  const receipt=(await c.query(
   'SELECT sequence::text AS sequence,hash FROM reserve_replica_receipt WHERE singleton=true FOR SHARE'
  )).rows[0];
  assertCheckpoint(cp,recovery,first.m,head,receipt);
  const snapshot=await collectSnapshot(pool);
  if(snapshot.sequence!==first.m.lastSequence||
     snapshot.snapshotHash!==first.m.snapshotHash||
     snapshot.rows.length!==first.m.rowCount)
   throw bad('spark-rebind-postgres-snapshot-diverged');
  const second=await remote(firestore);
  assertRemote(second,{nodeId,expectedEpoch,now});
  if(!sameRemote(first,second))
   throw bad('spark-rebind-firestore-changed-during-verification');
  if(old!==expectedEpoch){
   const result=await c.query(
    'UPDATE reserve_control.writer_gate SET owner_epoch=$1,updated_at=now() '+
    'WHERE singleton=true AND owner_epoch=$2 AND armed=true AND coverage_certified=true',
    [expectedEpoch,old]);
   if(result.rowCount!==1)throw bad('spark-rebind-sql016-race');
   rebound=true;
  }
  await c.query('COMMIT');committed=true;
 }catch(error){
  if(!committed)await c.query('ROLLBACK').catch(()=>{});
  throw error;
 }finally{c.release();}
 // If ownership changed after SQL committed, the new Firestore epoch no
 // longer matches this gate: all SQL writes fail closed until re-certified.
 const final=await remote(firestore);
 assertRemote(final,{nodeId,expectedEpoch,now:Date.now()});
 if(!sameRemote(first,final))
  throw bad('spark-rebind-firestore-changed-after-commit');
 return {rebound:true,resumed:!rebound,epoch:expectedEpoch,
  previousEpoch,generation:first.m.generation,sequence:first.m.lastSequence};
}
