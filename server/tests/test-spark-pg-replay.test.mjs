import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {installDatasetGuard} from '../src/dataset-guard.mjs';
import {withNasWriterPermit} from '../src/test-writer-guard.mjs';
import {readFileSync,readdirSync} from 'node:fs';
import pg from 'pg';
import {REPLICA_DOC,canonical} from '../src/test-replica.mjs';
import {OWNER_DOC} from '../src/test-writer-coordinator.mjs';
import {beginSparkTypedRecovery,startSparkPostgresReplay,
 replaySparkPostgresNext} from '../src/test-spark-pg-replay.mjs';
import {stageSparkTypedHandback,completeSparkTypedHandback}
 from '../src/test-spark-handback.mjs';
import {claimNasOwnership,promoteTestReserve}
 from '../src/test-writer-coordinator.mjs';
import {submitLineOperation} from '../src/line-store.mjs';
import {exactSparkReplayAlias} from '../src/test-spark-replay-receipt.mjs';

const enabled=Boolean(process.env.TEST_DATABASE_URL);
const sqltest=(name,fn)=>test(name,{skip:!enabled},fn);
const GEN='0123456789abcdef01234567',H='a'.repeat(64),
 TIME=Date.now()-20*60*1000,UID='operatorA';
const sha=x=>createHash('sha256').update(canonical(x)).digest('hex');
const ts=millis=>({toMillis:()=>millis});
class MemoryFirestore{
 constructor(){this.docs=new Map();this.collectionReads=0;this.loseAck=false;}
 doc(path){return{path,get:async()=>({exists:this.docs.has(path),
  data:()=>this.docs.get(path)})};}
 collection(path){return{get:async()=>{this.collectionReads++;
  return {docs:[...this.docs.entries()]
   .filter(([key])=>key.startsWith(path+'/'))
   .map(([key,value])=>({id:key.slice(path.length+1),data:()=>value}))};
 }};}
 batch(){
  const writes=[];
  return {set:(ref,value)=>writes.push([ref.path,value]),
   commit:async()=>{for(const [path,value] of writes)this.docs.set(path,value);}};
 }
 async runTransaction(fn){
  const writes=[];
  const tx={get:async ref=>this.doc(ref.path).get(),
   set:(ref,value)=>writes.push(['set',ref.path,value]),
   update:(ref,value)=>writes.push(['update',ref.path,value])};
  const result=await fn(tx);
  for(const [mode,key,value] of writes){
   this.docs.set(key,mode==='set'?value:{...this.docs.get(key),...value});
  }
  if(this.loseAck){this.loseAck=false;throw Error('simulated-firestore-lost-ack');}
  return result;
 }
}
function event(type,id,at,expectedRevision,revision,ordinal){
 const intent={id,type,truckId:'truckA',shiftId:'shiftA',
  createdAt:at-100,expectedRevision,expectedTtnRevision:0,cycleMinutes:60,
  arrivalTimestamp:type==='load'?TIME:0,lastLoadTimestamp:0,
  wantArrived:type==='arrive',collect:type==='ttn',
  ...(type==='ttn'?{expectedTtnRevision:0}:{})};
 return {operationId:id,uid:UID,type,epoch:9,generation:GEN,
  truckId:'truckA',shiftId:'shiftA',ordinal,expectedRevision,revision,
  cycleMinutes:60,intent,requestHash:sha(intent),at:ts(at),
  logId:type==='load'?'load_'+id:'',
  volume:type==='load'?24:0,isGAI:false,
  ...(type==='ttn'?{collect:true,expectedTtnRevision:0,ttnRevision:1}:{})};
}
function remote(sequence){
 const db=new MemoryFirestore(),events=[
  event('arrive','arrive01',TIME,3,4,1),
  event('ttn','ttn01',TIME+5000,4,4,2),
  event('load','load01',TIME+15000,4,5,3)
 ];
 db.docs.set(REPLICA_DOC,{protocol:1,channel:'test',projectId:'samosval-offline',
  generation:GEN,hash:H,lastSequence:sequence,typedSequence:sequence,
  typedProtocol:1,readyForFailover:true});
 db.docs.set(OWNER_DOC,{protocol:1,projectId:'samosval-offline',
  owner:'firebase',holder:'firebase_reserve',epoch:9,generation:GEN,
  observedSequence:sequence,leaseUntil:TIME+60000,pending:{},reserveSequence:0});
 const prefix=REPLICA_DOC+'/';
 db.docs.set(prefix+'typed_trucks_'+GEN+'/truckA',{
  id:'truckA',workspaceId:'main_workspace',generation:GEN,
  sourceSequence:sequence,isGAI:false,volume:24});
 db.docs.set(prefix+'typed_status_'+GEN+'/truckA',{
  id:'truckA',workspaceId:'main_workspace',generation:GEN,
  sourceSequence:sequence,shiftId:'shiftA',cycleRevision:5,ttnRevision:1,
  lastOperationId:'load01',
  reserveHistory:Object.fromEntries(events.map(x=>[x.operationId,x]))
 });
 return db;
}
async function withIsolatedDatabase(fn){
 const name='sc_verify_'+String(Date.now())+String(Math.floor(Math.random()*1000));
 const root=new URL(process.env.TEST_DATABASE_URL),adminUrl=new URL(root);
 adminUrl.pathname='/postgres';
 const admin=new pg.Client({connectionString:adminUrl.toString()});
 await admin.connect();
 let pool=null,created=false;
 try{
  await admin.query('CREATE DATABASE '+name);
  created=true;
  root.pathname='/'+name;
  pool=new pg.Pool({connectionString:root.toString(),max:5});
  installDatasetGuard(pool); // Hook connections before any transaction starts.
  for(let n=1;n<=15;n++){
   const file=readdirSync(new URL('../sql/',import.meta.url))
    .find(f=>f.startsWith(String(n).padStart(3,'0')+'_')&&f.endsWith('.sql'));
   assert.ok(file,'missing schema '+n);
   let sql=readFileSync(new URL('../sql/'+file,import.meta.url),'utf8');
   if(n>=2&&n<=13)sql=sql.replace(/current_database\(\)\s*<>\s*'samosval_test'/g,
    "current_database() NOT IN ('samosval_test','"+name+"')");
   await pool.query(sql);
  }
  await pool.query("UPDATE workspaces SET cycle_minutes=60 WHERE id='main_workspace'");
  await pool.query("INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES('main_workspace','shiftA',true,'{}')");
  await pool.query("INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES('main_workspace','truckA',$1::jsonb)",
   [JSON.stringify({brand:'КамАЗ',number:'А123АА',defaultVol:24,isGAI:false})]);
  const status={id:'truckA',shiftId:'shiftA',onLine:true,cycleRevision:3,
   ttnRevision:0,ttnStatus:null,lastLoadTimestamp:null,lastLoadLogId:null,
   arriveStatus:null,arriveTimestamp:null,loadedAfterArrive:false};
  await pool.query("INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES('main_workspace','truckA','shiftA',$1::jsonb)",[JSON.stringify(status)]);
  await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,'a@example.org','Оператор А','lopater','active')",[UID]);
  for(const action of ['tab_line','action_arrive','action_load','action_ttn'])
   await pool.query('INSERT INTO role_permissions(role,action,allowed) VALUES($1,$2,true)',['lopater',action]);
  const sequence=Number((await pool.query('SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true')).rows[0].n);
  await pool.query('INSERT INTO reserve_replica_receipt(singleton,sequence,hash) VALUES(true,$1,$2)',[sequence,H]);
  const db=remote(sequence);
  return await fn({pool,db,sequence});
 }finally{
  if(pool)await pool.end();
  // Pool.end() must close every client first. Do not FORCE-disconnect a
  // still-closing driver socket: that creates a spurious uncaught PG error.
  if(created)await admin.query('DROP DATABASE '+name);
  await admin.end();
 }
}
const opts=({pool,db})=>({pool,firestore:db,projectId:'samosval-offline',fenceEnabled:true});
const count=async(pool,table)=>(await pool.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n;
sqltest('typed Spark is frozen and ARRIVE, TTN, LOAD commit atomically with PG aliases and audit',async()=>withIsolatedDatabase(async f=>{
 const locked=await beginSparkTypedRecovery(opts(f));
 assert.equal(locked.frozen,true);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'reconciling');
 const started=await startSparkPostgresReplay(opts(f));
 assert.equal(started.total,3);
 const arriving=await replaySparkPostgresNext(opts(f));
 assert.equal(arriving.operationId,'arrive01');
 const recoveredOwner=await beginSparkTypedRecovery(opts(f));
 assert.equal(recoveredOwner.resumed,true,'restarting after a committed SQL step is safe');
 const beforeTtnScans=f.db.collectionReads;
 const ttn=await replaySparkPostgresNext(opts(f));
 assert.equal(ttn.operationId,'ttn01');
 assert.equal(f.db.collectionReads,beforeTtnScans,
  'each SQL event reads only frozen metadata+owner, not all Firestore trucks');
 const load=await replaySparkPostgresNext(opts(f));
 assert.equal(load.complete,true);
 assert.equal(f.db.collectionReads,beforeTtnScans+2,
  'full history is re-verified once at completion');
 assert.equal(load.postgresLogId,'load_truckA_shiftA_cycle_4_'+TIME);
 assert.equal((await replaySparkPostgresNext(opts(f))).complete,true);
 const replayed=await startSparkPostgresReplay(opts(f));
 assert.equal(replayed.resumed,true);
 assert.equal(replayed.applied,3);
 assert.equal(await count(f.pool,'line_operation_receipts'),3);
 assert.equal(await count(f.pool,'line_history'),3);
 assert.equal(await count(f.pool,'line_audit'),3);
 assert.equal(await count(f.pool,'line_logs'),1);
 assert.equal(await count(f.pool,'reserve_spark_log_aliases'),1);
 const alias=(await f.pool.query('SELECT reserve_log_id,postgres_log_id FROM reserve_spark_log_aliases')).rows[0];
 assert.equal(alias.reserve_log_id,'load_load01');
 assert.equal(alias.postgres_log_id,load.postgresLogId);
 const status=(await f.pool.query("SELECT payload FROM line_truck_statuses WHERE truck_id='truckA'")).rows[0].payload;
 assert.equal(status.cycleRevision,5);
 assert.equal(status.ttnStatus,true);
 assert.equal(status.ttnLogId,load.postgresLogId);
 const c=(await f.pool.query('SELECT applied_count,event_count,state,last_operation_id FROM reserve_spark_replay_checkpoint')).rows[0];
 assert.equal(c.applied_count,3);
 assert.equal(c.event_count,3);
 assert.equal(c.state,'applied');
 assert.equal(c.last_operation_id,'load01');
 const times=(await f.pool.query('SELECT action_id,created_at FROM line_history ORDER BY created_at')).rows;
 assert.deepEqual(times.map(x=>new Date(x.created_at).getTime()),[TIME,TIME+5000,TIME+15000]);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'reconciling',
  'SQL replay must never grant NAS ownership or publish a release');
 assert.equal(await count(f.pool,'notification_outbox'),0,
  'old reserve operations must not send delayed notifications');
}));
sqltest('failed SQL operation rolls back receipt, history, outbox and checkpoint; retry succeeds',async()=>withIsolatedDatabase(async f=>{
 await beginSparkTypedRecovery(opts(f));
 await startSparkPostgresReplay(opts(f));
 await f.pool.query("CREATE FUNCTION spark_forced_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'spark-audit-fault'; END $$");
 await f.pool.query('CREATE TRIGGER spark_fault BEFORE INSERT ON line_audit FOR EACH ROW EXECUTE FUNCTION spark_forced_failure()');
 const before=(await f.pool.query('SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true')).rows[0].n;
 await assert.rejects(replaySparkPostgresNext(opts(f)),/spark-audit-fault/);
 assert.equal(await count(f.pool,'line_operation_receipts'),0);
 assert.equal(await count(f.pool,'line_history'),0);
 assert.equal(await count(f.pool,'line_audit'),0);
 assert.equal(await count(f.pool,'reserve_spark_log_aliases'),0);
 assert.equal((await f.pool.query('SELECT applied_count FROM reserve_spark_replay_checkpoint')).rows[0].applied_count,0);
 assert.equal((await f.pool.query('SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true')).rows[0].n,before);
 await f.pool.query('DROP TRIGGER spark_fault ON line_audit');
 await f.pool.query('DROP FUNCTION spark_forced_failure()');
 assert.equal((await replaySparkPostgresNext(opts(f))).applied,1);
}));
sqltest('PG checkpoint serializes concurrent recovery workers and rejects an unexpected NAS write',async()=>withIsolatedDatabase(async f=>{
 await beginSparkTypedRecovery(opts(f));
 await startSparkPostgresReplay(opts(f));
 const [a,b]=await Promise.all([replaySparkPostgresNext(opts(f)),replaySparkPostgresNext(opts(f))]);
 assert.deepEqual([a.operationId,b.operationId].sort(),['arrive01','ttn01']);
 assert.equal(await count(f.pool,'line_operation_receipts'),2);
 assert.equal((await f.pool.query('SELECT applied_count FROM reserve_spark_replay_checkpoint')).rows[0].applied_count,2);
 await f.pool.query("UPDATE workspaces SET cycle_minutes=61 WHERE id='main_workspace'");
 await assert.rejects(replaySparkPostgresNext(opts(f)),/spark-replay-unexpected-postgres-writes/);
 assert.equal(await count(f.pool,'line_logs'),0);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'reconciling');
}));
sqltest('recovery refuses unconfirmed baseline or missing NAS fence without any SQL writes',async()=>withIsolatedDatabase(async f=>{
 await assert.rejects(beginSparkTypedRecovery({...opts(f),fenceEnabled:false}),
  /spark-replay-nas-fence-required/);
 await f.pool.query("UPDATE reserve_replica_receipt SET hash=$1 WHERE singleton=true",['b'.repeat(64)]);
 await assert.rejects(beginSparkTypedRecovery(opts(f)),/spark-replay-nas-base-diverged/);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM reserve_spark_replay_checkpoint')).rows[0].n,0);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'firebase');
}));

sqltest('typed handback publishes fully verified raw, typed and ACL generation before claiming NAS',async()=>withIsolatedDatabase(async f=>{
 await beginSparkTypedRecovery(opts(f));
 await startSparkPostgresReplay(opts(f));
 for(let i=0;i<3;i++)await replaySparkPostgresNext(opts(f));
 const sourceGen=f.db.docs.get(REPLICA_DOC).generation;
 const stage=await stageSparkTypedHandback(opts(f));
 assert.equal(stage.staged,true);
 assert.equal(stage.events,3);
 assert.notEqual(stage.generation,sourceGen);
 const meta=f.db.docs.get(REPLICA_DOC),owner=f.db.docs.get(OWNER_DOC);
 assert.equal(meta.typedProtocol,1);
 assert.equal(meta.accessProtocol,1);
 assert.equal(meta.readyForFailover,false);
 assert.equal(meta.typedSequence,meta.lastSequence);
 assert.equal(owner.owner,'handoff');
 assert.equal(owner.recovery.status,'staged');
 assert.equal(owner.recovery.manifestHash.length,64);
 assert.deepEqual(owner.pending,{});
 const prefix=REPLICA_DOC+'/';
 const typed=f.db.docs.get(prefix+'typed_status_'+meta.generation+'/truckA');
 assert.equal(typed.cycleRevision,5);
 assert.equal(typed.ttnStatus,true);
 assert.deepEqual(typed.reserveHistory,{});
 const access=f.db.docs.get(prefix+'access_'+meta.generation+'/'+UID);
 assert.equal(access.uid,UID);
 assert.equal(access.active,true);
 assert.equal(access.lineRead,true);
 assert.ok(access.permissions.actions.includes('action_load'));
 const receiptBefore=(await f.pool.query('SELECT sequence::text AS n FROM reserve_replica_receipt WHERE singleton=true')).rows[0].n;
 assert.notEqual(Number(receiptBefore),meta.lastSequence,'remote generation not yet acknowledged locally');
 await assert.rejects(promoteTestReserve({firestore:f.db,projectId:'samosval-offline',
  expectedEpoch:owner.epoch,now:Date.now()+180000}),
  /writer-promotion-epoch-changed|writer-reserve-not-ready/);
 const done=await completeSparkTypedHandback(opts(f));
 assert.equal(done.completed,true);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'synology');
 assert.equal(f.db.docs.get(OWNER_DOC).holder,'nas_handoff_pending');
 assert.equal(f.db.docs.get(OWNER_DOC).recovery.status,'completed');
 const receipt=(await f.pool.query('SELECT sequence::text AS n,hash FROM reserve_replica_receipt WHERE singleton=true')).rows[0];
 assert.equal(Number(receipt.n),meta.lastSequence);
 assert.equal(receipt.hash,meta.hash);
 const claim=await claimNasOwnership({firestore:f.db,projectId:'samosval-offline',
  nodeId:'fresh_nas_handoff_worker',checkpoint:{
   sequence:meta.lastSequence,hash:meta.hash},now:Date.now()});
 assert.equal(claim.epoch,f.db.docs.get(OWNER_DOC).epoch);
 assert.equal((await completeSparkTypedHandback(opts(f))).resumed,true);
 // The phone may have missed the original Firebase ACK. After handback its
 // original client timestamp differs from PostgreSQL's normalized server time.
 // Exact same UID+ID+immutable original intent must ACK, never double count.
 const original=f.db.docs.get(REPLICA_DOC+'/typed_status_'+sourceGen+'/truckA')
  .reserveHistory.load01.intent;
 const aliasResult=await submitLineOperation(f.pool,UID,original);
 assert.equal(aliasResult.outcome,'confirmed');
 assert.equal(aliasResult.replayed,true);
 assert.equal(aliasResult.reserveReplayed,true);
 const sqlClient=await f.pool.connect();
 try{
  assert.equal(await exactSparkReplayAlias(sqlClient,{
   uid:UID,op:{...original,createdAt:original.createdAt-1},
   stored:aliasResult}),false,'changed replay intent is not an alias');
 }finally{sqlClient.release();}
 await assert.rejects(submitLineOperation(f.pool,UID,
  {...original,createdAt:original.createdAt-1}),error=>error.status===409);
 assert.equal(await count(f.pool,'line_operation_receipts'),3,'no replayed operations duplicated');
}));
sqltest('typed handback rejects incomplete SQL replay, then resumes after all events',async()=>withIsolatedDatabase(async f=>{
 await beginSparkTypedRecovery(opts(f));
 await startSparkPostgresReplay(opts(f));
 await replaySparkPostgresNext(opts(f));
 await assert.rejects(stageSparkTypedHandback(opts(f)),/spark-handback-replay-not-complete/);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'reconciling');
 for(let i=1;i<3;i++)await replaySparkPostgresNext(opts(f));
 assert.equal((await stageSparkTypedHandback(opts(f))).staged,true);
}));
sqltest('typed handback survives lost Firestore ACK without creating another generation',async()=>withIsolatedDatabase(async f=>{
 await beginSparkTypedRecovery(opts(f));
 await startSparkPostgresReplay(opts(f));
 for(let i=0;i<3;i++)await replaySparkPostgresNext(opts(f));
 f.db.loseAck=true;
 await assert.rejects(stageSparkTypedHandback(opts(f)),/simulated-firestore-lost-ack/);
 const generation=f.db.docs.get(REPLICA_DOC).generation;
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'handoff');
 const resumed=await stageSparkTypedHandback(opts(f));
 assert.equal(resumed.resumed,true);
 assert.equal(resumed.generation,generation);
 assert.equal((await completeSparkTypedHandback(opts(f))).completed,true);
}));
sqltest('typed handback blocks tampered Firebase projection without advancing NAS receipt',async()=>withIsolatedDatabase(async f=>{
 await beginSparkTypedRecovery(opts(f));
 await startSparkPostgresReplay(opts(f));
 for(let i=0;i<3;i++)await replaySparkPostgresNext(opts(f));
 await stageSparkTypedHandback(opts(f));
 const meta=f.db.docs.get(REPLICA_DOC);
 const path=REPLICA_DOC+'/typed_status_'+meta.generation+'/truckA';
 f.db.docs.set(path,{...f.db.docs.get(path),cycleRevision:1234});
 await assert.rejects(completeSparkTypedHandback(opts(f)),/spark-handback-document-diverged/);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'handoff');
 const receipt=(await f.pool.query('SELECT sequence::text AS n FROM reserve_replica_receipt WHERE singleton=true')).rows[0].n;
 assert.notEqual(Number(receipt),meta.lastSequence);
}));
sqltest('typed handback blocks unexpected SQL changes after staging',async()=>withIsolatedDatabase(async f=>{
 await beginSparkTypedRecovery(opts(f));
 await startSparkPostgresReplay(opts(f));
 for(let i=0;i<3;i++)await replaySparkPostgresNext(opts(f));
 await stageSparkTypedHandback(opts(f));
 await f.pool.query("UPDATE workspaces SET cycle_minutes=61 WHERE id='main_workspace'");
 await assert.rejects(completeSparkTypedHandback(opts(f)),
  /spark-handback-replay-not-complete/);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'handoff');
}));

sqltest('typed handback resumes safely after SQL receipt commits but Firebase ACK is lost',async()=>withIsolatedDatabase(async f=>{
 await beginSparkTypedRecovery(opts(f));
 await startSparkPostgresReplay(opts(f));
 for(let i=0;i<3;i++)await replaySparkPostgresNext(opts(f));
 await stageSparkTypedHandback(opts(f));
 const meta=f.db.docs.get(REPLICA_DOC);
 f.db.loseAck=true;
 await assert.rejects(completeSparkTypedHandback(opts(f)),/simulated-firestore-lost-ack/);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'synology',
  'the transaction succeeded remotely despite its lost response');
 assert.equal((await completeSparkTypedHandback(opts(f))).resumed,true);
 const receipt=(await f.pool.query('SELECT sequence::text AS n,hash FROM reserve_replica_receipt WHERE singleton=true')).rows[0];
 assert.equal(Number(receipt.n),meta.lastSequence);
 assert.equal(receipt.hash,meta.hash);
 assert.equal(await count(f.pool,'line_operation_receipts'),3);
}));
sqltest('typed handback refuses missing SQL load aliases even if all events were committed',async()=>withIsolatedDatabase(async f=>{
 await beginSparkTypedRecovery(opts(f));
 await startSparkPostgresReplay(opts(f));
 for(let i=0;i<3;i++)await replaySparkPostgresNext(opts(f));
 await f.pool.query('DELETE FROM reserve_spark_log_aliases');
 await assert.rejects(stageSparkTypedHandback(opts(f)),/spark-handback-log-aliases-diverged/);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'reconciling');
}));
sqltest('typed handback refuses a missing published SQL mirror row',async()=>withIsolatedDatabase(async f=>{
 await beginSparkTypedRecovery(opts(f));
 await startSparkPostgresReplay(opts(f));
 for(let i=0;i<3;i++)await replaySparkPostgresNext(opts(f));
 await stageSparkTypedHandback(opts(f));
 const meta=f.db.docs.get(REPLICA_DOC);
 const prefix=REPLICA_DOC+'/rows_'+meta.generation+'/';
 const key=[...f.db.docs.keys()].find(x=>x.startsWith(prefix));
 assert.ok(key);
 f.db.docs.delete(key);
 await assert.rejects(completeSparkTypedHandback(opts(f)),/spark-handback-document-count-diverged/);
 assert.equal(f.db.docs.get(OWNER_DOC).owner,'handoff');
}));

sqltest('SQL 016 arms a global fence on all business tables: only scoped, correct-epoch permits commit',async()=>withIsolatedDatabase(async f=>{
 const sql=readFileSync(new URL('../sql/016_spark_global_fence.sql',import.meta.url),'utf8');
 await f.pool.query(sql); // new isolated database only; never the installed NAS
 const fence=await f.pool.query(
  'SELECT armed,owner_epoch::int AS epoch FROM reserve_control.writer_gate WHERE singleton=true'
 );
 assert.equal(fence.rows[0].armed,false,'migration never silently arms live writing');
 const triggers=await f.pool.query(
  "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='spark_writer_gate' AND NOT tgisinternal"
 );
 assert.equal(triggers.rows[0].n,39,'every tracked business table is fenced');
 const tables=await f.pool.query(
  "SELECT c.relname AS table_name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname='spark_writer_gate'"
 );
 for(const name of ['workspaces','line_logs','line_truck_statuses','app_users',
  'server_control_state','notification_outbox']){
  assert.ok(tables.rows.some(row=>row.table_name===name),'missing fence: '+name);
 }
 await f.pool.query(
  'UPDATE reserve_control.writer_gate SET armed=true,owner_epoch=7 WHERE singleton=true'
 );
 const update=()=>f.pool.query("UPDATE workspaces SET cycle_minutes=61 WHERE id='main_workspace'");
 await assert.rejects(update(),/spark-fence-permit-required/,
  'a background writer without a live permit must never change SQL');
 const badPermit={epoch:6,permitId:'expired_permit_12345'};
 await assert.rejects(withNasWriterPermit(badPermit,async()=>{
  const c=await f.pool.connect();
  try{
   await c.query('BEGIN');
   try{await c.query("UPDATE workspaces SET cycle_minutes=62 WHERE id='main_workspace'");}
   finally{await c.query('ROLLBACK');}
  }finally{c.release();}
 }),/spark-fence-permit-required/,'stale owner epoch must fail');
 const valid={epoch:7,permitId:'leased_operation_123456'};
 await withNasWriterPermit(valid,async()=>{
  const c=await f.pool.connect();
  try{
   await c.query('BEGIN');
   await c.query("UPDATE workspaces SET cycle_minutes=61 WHERE id='main_workspace'");
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
  finally{c.release();}
 });
 assert.equal((await f.pool.query(
  "SELECT cycle_minutes FROM workspaces WHERE id='main_workspace'")).rows[0].cycle_minutes,61);
 await assert.rejects(f.pool.query(
  "UPDATE workspaces SET cycle_minutes=62 WHERE id='main_workspace'"),
  /spark-fence-permit-required/,'SET LOCAL cannot leak through a reused pg connection');
 await f.pool.query(
  'UPDATE reserve_control.writer_gate SET armed=false WHERE singleton=true'
 );
 assert.ok((await update()).rowCount===1);
}));
