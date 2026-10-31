// TEST-only typed Spark -> PostgreSQL recovery worker. Never started by the
// HTTP API, updater, or replication timer. Owner must be frozen explicitly;
// SQL writes and durable checkpoint commit together. NO automatic handback.
import {createHash} from 'node:crypto';
import {applyLineOperation} from './line-rules.mjs';
import {recordLineHistory} from './history-store.mjs';
import {canonical,assertTestProject,REPLICA_DOC} from './test-replica.mjs';
import {OWNER_DOC} from './test-writer-coordinator.mjs';
import {readNasReplayBaseline} from './test-reconcile-line.mjs';
import {inspectFrozenSparkHistory} from './test-spark-replay-inspect.mjs';
import {planSparkPostgresReplay} from './test-spark-pg-dry-run.mjs';

const WS='main_workspace',HEX=/^[0-9a-f]{64}$/,GEN=/^[0-9a-f]{24}$/;
const MAX_PLAN_BYTES=16000000;
const RECEIPT_FIELDS=['id','type','truckId','shiftId','createdAt','expectedRevision',
 'expectedTtnRevision','arrivalTimestamp','lastLoadTimestamp','wantArrived',
 'collect','cycleMinutes','logId'];
const fail=code=>Object.assign(new Error(code),{code});
const digest=x=>createHash('sha256').update(canonical(x)).digest('hex');
const snap=s=>s?.exists?s.data():null;
const safeInt=x=>Number.isSafeInteger(x)&&x>=0;
const equal=(a,b)=>canonical(a)===canonical(b);
function guarded(projectId,fenceEnabled){
 if(!fenceEnabled)throw fail('spark-replay-nas-fence-required');
 assertTestProject(projectId);
}
function checkDatabase(row){
 if(row?.name!=='samosval_test'&&!/^sc_verify_[0-9]+$/.test(row?.name||''))
  throw fail('spark-replay-test-db-required');
}
function assertTypedMeta(m){
 if(m?.protocol!==1||m?.projectId!=='samosval-offline'||m.channel!=='test'||
    m.typedProtocol!==1||m.typedSequence!==m.lastSequence||
    m.readyForFailover!==true||!GEN.test(m.generation||'')||
    !safeInt(m.lastSequence)||!HEX.test(m.hash||''))
  throw fail('spark-replay-typed-mirror-not-certified');
}
// Atomic epoch bump fences every client transaction that read the Firebase
// owner. The legacy reserve_ops protocol is intentionally NOT mixed in.
export async function beginSparkTypedRecovery({firestore,projectId,pool,
 now=Date.now(),fenceEnabled=process.env.TEST_WRITER_FENCE_ENABLED==='1'}={}){
 guarded(projectId,fenceEnabled);
 if(!firestore?.runTransaction||!pool)throw fail('spark-replay-invalid-dependencies');
 const base=await readNasReplayBaseline(pool);
 const metaRef=firestore.doc(REPLICA_DOC),ownerRef=firestore.doc(OWNER_DOC);
 return firestore.runTransaction(async tx=>{
  const [ms,os]=await Promise.all([tx.get(metaRef),tx.get(ownerRef)]);
  const m=snap(ms),o=snap(os);
  assertTypedMeta(m);
  if(base.sequence!==m.lastSequence||base.hash!==m.hash)
   throw fail('spark-replay-nas-base-diverged');
  if(o?.owner==='reconciling'&&o?.holder==='reconcile_worker'&&
     o.generation===m.generation&&o.recovery?.typedProtocol===1&&
     o.recovery.baseSequence===m.lastSequence&&o.recovery.baseHash===m.hash&&
     o.epoch===o.recovery.fromEpoch+1)
   return {resumed:true,epoch:o.epoch,generation:m.generation};
  if(o?.protocol!==1||o.projectId!=='samosval-offline'||
     o.owner!=='firebase'||o.holder!=='firebase_reserve'||
     o.generation!==m.generation||!safeInt(o.epoch)||o.epoch<1||
     o.observedSequence!==m.lastSequence||!o.pending||
     Object.keys(o.pending).length!==0||o.reserveSequence!==0)
   throw fail('spark-replay-reserve-not-exclusive');
  const recovery={typedProtocol:1,generation:m.generation,fromEpoch:o.epoch,
   baseSequence:m.lastSequence,baseHash:m.hash,status:'frozen',startedAt:now};
  tx.update(ownerRef,{owner:'reconciling',holder:'reconcile_worker',
   epoch:o.epoch+1,leaseUntil:now+60000,updatedAt:now,recovery});
  return {frozen:true,epoch:o.epoch+1,generation:m.generation};
 });
}

// All SQL baseline rows come from ONE read-only MVCC snapshot. Its outbox
// high-water must equal the last independently confirmed Firebase receipt.
export async function readSparkPostgresBaseline(pool){
 const c=await pool.connect();
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  checkDatabase((await c.query('SELECT current_database() AS name')).rows[0]);
  const h=(await c.query('SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true')).rows[0];
  const receipt=(await c.query('SELECT sequence::text AS n,hash FROM reserve_replica_receipt WHERE singleton=true')).rows[0];
  const sequence=Number(h?.n),confirmed=Number(receipt?.n);
  if(!safeInt(sequence)||confirmed!==sequence||!HEX.test(receipt?.hash||''))
   throw fail('spark-replay-nas-not-replicated');
  const workspace=(await c.query('SELECT cycle_minutes FROM workspaces WHERE id=$1',[WS])).rows[0];
  const cycleMinutes=workspace?.cycle_minutes;
  if(!Number.isSafeInteger(cycleMinutes)||cycleMinutes<15||cycleMinutes>10080)
   throw fail('spark-replay-workspace-invalid');
  const shifts=(await c.query('SELECT shift_id,is_active,payload FROM shifts WHERE workspace_id=$1 AND is_active=true',[WS])).rows;
  if(shifts.length!==1||shifts[0].payload?.closing===true)
   throw fail('spark-replay-shift-invalid');
  const statuses=(await c.query('SELECT truck_id,payload FROM line_truck_statuses WHERE workspace_id=$1',[WS])).rows;
  const trucks=(await c.query('SELECT truck_id,payload FROM line_trucks WHERE workspace_id=$1',[WS])).rows;
  const users=(await c.query('SELECT uid,display_name,email,role,status FROM app_users')).rows;
  const permissions=(await c.query('SELECT role,action FROM role_permissions WHERE allowed=true')).rows;
  const actions=new Map();
  for(const row of permissions){
   if(!actions.has(row.role))actions.set(row.role,[]);
   actions.get(row.role).push(row.action);
  }
  const actors=Object.fromEntries(users.map(u=>[u.uid,{
   name:u.display_name,email:u.email,role:u.role,status:u.status,
   actions:u.role==='admin'?['action_arrive','action_load','action_ttn']:
    actions.get(u.role)||[]
  }]));
  await c.query('COMMIT');
  return {sequence,hash:receipt.hash,cycleMinutes,shiftId:shifts[0].shift_id,
   shiftActive:true,statuses:Object.fromEntries(statuses.map(x=>[x.truck_id,x.payload])),
   trucks:Object.fromEntries(trucks.map(x=>[x.truck_id,x.payload])),actors};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}

function assertCheckpoint(row,manifest){
 if(!row||row.workspace_id!==WS||row.generation!==manifest.generation||
    Number(row.from_epoch)!==manifest.fromEpoch||
    Number(row.base_sequence)!==manifest.baseSequence||
    row.base_hash!==manifest.baseHash||row.manifest_hash!==manifest.sha256||
    Number(row.event_count)!==manifest.eventCount||!safeInt(row.applied_count)||
    row.applied_count>row.event_count||!safeInt(Number(row.outbox_sequence))||
    !row.plan||row.plan.format!=='spark-typed-pg-dry-run'||
    row.plan.plannedHash!==row.planned_hash||
    row.plan.generation!==manifest.generation||
    row.plan.fromEpoch!==manifest.fromEpoch||
    row.plan.eventCount!==manifest.eventCount||
    !Array.isArray(row.plan.operations)||
    row.plan.operations.length!==manifest.eventCount||
    digest(row.plan.operations)!==row.planned_hash||
    !['replaying','applied'].includes(row.state)||
    (row.state==='applied')!==(row.applied_count===row.event_count))
  throw fail('spark-replay-checkpoint-diverged');
 return row.plan;
}
async function inspected(firestore,projectId){
 if(!firestore)throw fail('spark-replay-firestore-required');
 return inspectFrozenSparkHistory({firestore,projectId});
}
export async function startSparkPostgresReplay({firestore,projectId,pool,
 fenceEnabled=process.env.TEST_WRITER_FENCE_ENABLED==='1'}={}){
 guarded(projectId,fenceEnabled);
 const manifest=await inspected(firestore,projectId);
 // A prior PostgreSQL commit is authoritative after lost HTTP/Firestore ACK.
 // Never recalculate the initial dry-run on already replayed SQL statuses.
 const previous=(await pool.query('SELECT * FROM reserve_spark_replay_checkpoint WHERE singleton=true')).rows[0];
 if(previous){
  assertCheckpoint(previous,manifest);
  return {resumed:true,applied:previous.applied_count,total:manifest.eventCount,
   state:previous.state,plannedHash:previous.planned_hash};
 }
 const baseline=await readSparkPostgresBaseline(pool);
 const plan=planSparkPostgresReplay({manifest,baseline});
 if(Buffer.byteLength(JSON.stringify(plan),'utf8')>MAX_PLAN_BYTES)
  throw fail('spark-replay-plan-too-large');
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  checkDatabase((await c.query('SELECT current_database() AS name')).rows[0]);
  // Lock commit-ordered outbox cursor, blocking concurrent SQL writers until
  // this baseline is certified. No SQL writes are made on mismatch.
  const h=Number((await c.query('SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true FOR UPDATE')).rows[0]?.n);
  const receipt=(await c.query('SELECT sequence::text AS n,hash FROM reserve_replica_receipt WHERE singleton=true')).rows[0];
  if(h!==baseline.sequence||Number(receipt?.n)!==h||receipt?.hash!==baseline.hash)
   throw fail('spark-replay-baseline-changed');
  const created=await c.query(
   'INSERT INTO reserve_spark_replay_checkpoint (singleton,workspace_id,generation,from_epoch,base_sequence,base_hash,manifest_hash,planned_hash,event_count,applied_count,outbox_sequence,state,plan) VALUES (true,$1,$2,$3,$4,$5,$6,$7,$8,0,$4,$9,$10::jsonb) ON CONFLICT DO NOTHING RETURNING singleton',
   [WS,plan.generation,plan.fromEpoch,plan.baseSequence,plan.baseHash,
    manifest.sha256,plan.plannedHash,plan.eventCount,
    plan.eventCount===0?'applied':'replaying',JSON.stringify(plan)]);
  if(!created.rowCount)throw fail('spark-replay-competing-initializer');
  await c.query('COMMIT');
  return {started:true,applied:0,total:plan.eventCount,
   state:plan.eventCount===0?'applied':'replaying',plannedHash:plan.plannedHash};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}

// One operation is one PostgreSQL transaction, including receipt, action
// history, audit, log, alias, outbox and checkpoint. If COMMIT succeeded but
// its acknowledgment vanished, the next invocation skips the committed event.
export async function replaySparkPostgresNext({firestore,projectId,pool,
 fenceEnabled=process.env.TEST_WRITER_FENCE_ENABLED==='1'}={}){
 guarded(projectId,fenceEnabled);
 const manifest=await inspected(firestore,projectId);
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  checkDatabase((await c.query('SELECT current_database() AS name')).rows[0]);
  const checkpoint=(await c.query('SELECT * FROM reserve_spark_replay_checkpoint WHERE singleton=true FOR UPDATE')).rows[0];
  const plan=assertCheckpoint(checkpoint,manifest);
  const head=Number((await c.query('SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true FOR UPDATE')).rows[0]?.n);
  if(head!==Number(checkpoint.outbox_sequence))
   throw fail('spark-replay-unexpected-postgres-writes');
  if(checkpoint.applied_count===checkpoint.event_count){
   await c.query('COMMIT');
   return {complete:true,applied:checkpoint.applied_count,total:checkpoint.event_count};
  }
  const step=plan.operations[checkpoint.applied_count];
  if(!step||step.serverAt<=0||!HEX.test(step.originalRequestHash||'')||
     !step.pgIntent||step.pgIntent.id!==step.operationId||
     step.pgIntent.createdAt!==step.serverAt||
     step.pgReceipt?.outcome!=='confirmed'||!step.pgReceipt.status)
   throw fail('spark-replay-step-invalid');
  const ws=(await c.query('SELECT cycle_minutes FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[WS])).rows[0];
  if(ws?.cycle_minutes!==step.cycleMinutes)
   throw fail('spark-replay-cycle-policy-changed');
  const profile=(await c.query('SELECT email,display_name,role,status FROM app_users WHERE uid=$1 FOR SHARE',[step.uid])).rows[0];
  if(profile?.status!=='active'||profile.role!==step.actor.role||
     profile.display_name!==step.actor.name||profile.email!==step.actor.email)
   throw fail('spark-replay-actor-changed');
  const shift=(await c.query('SELECT is_active,payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2 FOR SHARE',[WS,step.pgIntent.shiftId])).rows[0];
  if(shift?.is_active!==true||shift.payload?.closing===true)
   throw fail('spark-replay-shift-changed');
  const row=(await c.query('SELECT payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2 FOR UPDATE',[WS,step.pgIntent.truckId])).rows[0];
  const truck=(await c.query('SELECT payload FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2',[WS,step.pgIntent.truckId])).rows[0]?.payload;
  if(!row||!equal(row.payload,step.beforeStatus)||!equal(truck,step.truck))
   throw fail('spark-replay-postgres-state-diverged');
  const result=applyLineOperation({op:step.pgIntent,before:row.payload,truck,
   actor:{name:profile.display_name,email:profile.email,isAdmin:profile.role==='admin'},
   cycleMinutes:ws.cycle_minutes,now:step.serverAt});
  if(!equal(result,step.pgReceipt)||result.outcome!=='confirmed')
   throw fail('spark-replay-business-diverged');
  const normalized=Object.fromEntries(RECEIPT_FIELDS.filter(k=>step.pgIntent[k]!==undefined)
   .map(k=>[k,step.pgIntent[k]]));
  const hash=createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  const already=(await c.query('SELECT operation_id FROM line_operation_receipts WHERE workspace_id=$1 AND operation_id=$2',[WS,step.operationId])).rowCount;
  if(already)throw fail('spark-replay-operation-id-conflict');
  const saved={outcome:'confirmed',reason:null,status:result.status,log:result.log||null};
  await c.query('INSERT INTO line_operation_receipts(workspace_id,operation_id,uid,request_hash,result,recorded_at) VALUES ($1,$2,$3,$4,$5::jsonb,to_timestamp($6::double precision/1000))',
   [WS,step.operationId,step.uid,hash,JSON.stringify(saved),step.serverAt]);
  if(result.log){
   if(step.reserveLogId!=='load_'+step.operationId||
      step.postgresLogId!==result.log.id)
    throw fail('spark-replay-log-alias-invalid');
   await c.query('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES ($1,$2,$3,$4,$5::jsonb)',
    [WS,result.log.id,step.pgIntent.shiftId,step.pgIntent.truckId,JSON.stringify(result.log)]);
   await c.query('INSERT INTO reserve_spark_log_aliases(workspace_id,generation,operation_id,reserve_log_id,postgres_log_id) VALUES ($1,$2,$3,$4,$5)',
    [WS,manifest.generation,step.operationId,step.reserveLogId,result.log.id]);
  }
  await recordLineHistory(c,{workspaceId:WS,uid:step.uid,op:step.pgIntent,
   before:row.payload,result,profile,shift:shift.payload,
   replayAt:step.serverAt,suppressNotifications:true});
  await c.query('UPDATE line_truck_statuses SET payload=$3::jsonb WHERE workspace_id=$1 AND truck_id=$2',
   [WS,step.pgIntent.truckId,JSON.stringify(result.status)]);
  await c.query('INSERT INTO line_audit(workspace_id,operation_id,uid,type,status,created_at) VALUES ($1,$2,$3,$4,$5,to_timestamp($6::double precision/1000))',
   [WS,step.operationId,step.uid,step.pgIntent.type,'confirmed',step.serverAt]);
  const updatedHead=Number((await c.query('SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true')).rows[0]?.n);
  if(!safeInt(updatedHead)||updatedHead<=head)
   throw fail('spark-replay-outbox-not-recorded');
  const next=checkpoint.applied_count+1;
  await c.query('UPDATE reserve_spark_replay_checkpoint SET applied_count=$1,outbox_sequence=$2,last_operation_id=$3,state=$4,updated_at=now() WHERE singleton=true',
   [next,updatedHead,step.operationId,next===checkpoint.event_count?'applied':'replaying']);
  await c.query('COMMIT');
  return {applied:next,total:checkpoint.event_count,
   remaining:checkpoint.event_count-next,complete:next===checkpoint.event_count,
   operationId:step.operationId,postgresLogId:result.log?.id||null};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}
