// TEST ONLY: a narrowly scoped RECOVERY transaction on a certified,
// ARMED SQL016 gate. The normal NAS API NEVER calls this module.
// It does not claim NAS ownership, promote Firebase, or install migrations.
// A TEST worker must first freeze Firestore (owner=reconciling) and durably
// stage the exact Spark SQL015 replay plan. No Cloud Run or live deployment.
import {randomUUID} from 'node:crypto';
import {REPLICA_DOC,assertTestProject,canonical} from './test-replica.mjs';
import {readFrozenSparkContext} from './test-spark-replay-inspect.mjs';
import {replaySparkPostgresNext} from './test-spark-pg-replay.mjs';
import {withNasWriterPermit} from './test-writer-guard.mjs';

const DB=/^sc_verify_[0-9]+$/,HEX=/^[0-9a-f]{64}$/;
const bad=code=>Object.assign(new Error(code),{code});
const snap=s=>s?.exists?s.data():null;
const num=x=>Number.isSafeInteger(x)&&x>=0;
function proofFromMeta(m,ctx,gate){
 const p=m?.promotionProof;
 if(m?.protocol!==1||m.channel!=='test'||m.projectId!=='samosval-offline'||
    m.readyForFailover!==true||m.typedProtocol!==1||
    m.typedSequence!==m.lastSequence||
    !HEX.test(m.hash||'')||!HEX.test(m.snapshotHash||'')||
    p?.protocol!==2||p.writerGate!=='sql016'||
    p.generation!==ctx.generation||p.generation!==m.generation||
    p.sequence!==ctx.baseSequence||p.hash!==ctx.baseHash||
    p.snapshotHash!==m.snapshotHash||
    !num(p.epoch)||p.epoch<1||
    ctx.fromEpoch!==p.epoch+1||gate!==p.epoch)
  throw bad('spark-recovery-sql016-proof-mismatch');
 return p;
}
export async function replaySparkFencedNext({
 pool,firestore,projectId,
 fenceEnabled=process.env.TEST_WRITER_FENCE_ENABLED==='1'
}={}){
 if(fenceEnabled!==true)throw bad('spark-recovery-sql016-fence-required');
 assertTestProject(projectId);
 if(!pool?.connect||!firestore?.doc)
  throw bad('spark-recovery-sql016-dependencies-invalid');
 // The remote freeze and planned business replay must already exist.
 const frozen=await readFrozenSparkContext({firestore,projectId});
 const meta=snap(await firestore.doc(REPLICA_DOC).get());
 const c=await pool.connect();
 let gateEpoch;
 try{
  await c.query('BEGIN READ ONLY');
  const db=(await c.query('SELECT current_database() AS name')).rows[0]?.name;
  if(db!=='samosval_test'&&!DB.test(db||''))
   throw bad('spark-recovery-sql016-test-database-required');
  let gate;
  try{
   gate=(await c.query('SELECT armed,coverage_certified,owner_epoch::text AS epoch '+
    'FROM reserve_control.writer_gate WHERE singleton=true')).rows[0];
  }catch(e){
   if(e.code==='42P01'||e.code==='3F000')
    throw bad('spark-recovery-sql016-missing');
   throw e;
  }
  gateEpoch=Number(gate?.epoch);
  if(gate?.armed!==true||gate.coverage_certified!==true||
     !num(gateEpoch)||gateEpoch<1)
   throw bad('spark-recovery-sql016-not-certified');
  proofFromMeta(meta,frozen,gateEpoch);
  const cp=(await c.query('SELECT generation,from_epoch::text AS from_epoch,'+
   'base_sequence::text AS base_sequence,base_hash,state '+
   'FROM reserve_spark_replay_checkpoint WHERE singleton=true')).rows[0];
  if(cp?.generation!==frozen.generation||
     Number(cp.from_epoch)!==frozen.fromEpoch||
     Number(cp.base_sequence)!==frozen.baseSequence||
     cp.base_hash!==frozen.baseHash||
     !['replaying','applied'].includes(cp.state))
   throw bad('spark-recovery-sql015-checkpoint-required');
  await c.query('COMMIT');
 }catch(e){
  await c.query('ROLLBACK').catch(()=>{});throw e;
 }finally{c.release();}
 // Preserve the frozen owner epoch across the independent SQL gate check.
 const current=await readFrozenSparkContext({firestore,projectId});
 if(canonical(current)!==canonical(frozen))
  throw bad('spark-recovery-owner-changed-before-write');
 // This scoped, random SQL recovery token is NOT a Firebase NAS permit.
 // It is accepted only by SQL016 in the controlled TEST worker's one
 // PostgreSQL transaction, once the exclusive frozen owner and certified
 // old SQL016 gate have been independently checked. The async context
 // transfers to SET LOCAL and is removed at COMMIT/ROLLBACK.
 const ticket={epoch:gateEpoch,
  permitId:'spark_recovery_'+randomUUID().replaceAll('-','')};
 const result=await withNasWriterPermit(ticket,()=>replaySparkPostgresNext({
  pool,firestore,projectId,fenceEnabled:true
 }));
 const after=await readFrozenSparkContext({firestore,projectId});
 if(canonical(after)!==canonical(frozen))
  throw bad('spark-recovery-owner-changed-after-commit');
 return result;
}
