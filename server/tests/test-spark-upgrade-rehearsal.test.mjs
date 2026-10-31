// Isolated PostgreSQL 16 rehearsal: clone a TEST SQL001-013 dataset, then
// install SQL014-016 on the CLONE only. No live NAS, production, or Firebase.
// This simulates database-copy recovery, NOT a Synology physical backup restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import pg from 'pg';

const enabled=Boolean(process.env.TEST_DATABASE_URL);
const sqltest=(name,fn)=>test(name,{skip:!enabled},fn);
const businessTables=['workspaces','app_users','role_permissions','shifts',
 'line_trucks','line_truck_statuses'];
const sqlFiles=new Map();
function migration(n){
 if(!sqlFiles.has(n)){
  const file=readdirSync(new URL('../sql/',import.meta.url))
   .find(f=>f.startsWith(String(n).padStart(3,'0')+'_')&&f.endsWith('.sql'));
  assert.ok(file,'SQL migration is missing: '+n);
  sqlFiles.set(n,readFileSync(new URL('../sql/'+file,import.meta.url),'utf8'));
 }
 return sqlFiles.get(n);
}
function forIsolatedDatabase(n,name){
 let sql=migration(n);
 // Older migrations only allow samosval_test; this is a disposable
 // clone with a uniquely named sc_verify_* database, never a live DB.
 if(n>=2&&n<=13)sql=sql.replace(
  /current_database\(\)\s*<>\s*'samosval_test'/g,
  "current_database() NOT IN ('samosval_test','"+name+"')");
 return sql;
}
async function snapshot(pool){
 const rows={};
 for(const table of businessTables){
  const result=await pool.query('SELECT to_jsonb(t) AS v FROM public.'+table+' t');
  rows[table]=result.rows.map(r=>r.v).sort((a,b)=>
   JSON.stringify(a).localeCompare(JSON.stringify(b)));
 }
 return rows;
}
async function seedBaseline(pool){
 await pool.query("UPDATE workspaces SET cycle_minutes=60 WHERE id='main_workspace'");
 await pool.query("INSERT INTO shifts(workspace_id,shift_id,is_active,payload) "+
  "VALUES('main_workspace','rehearsal_shift',true,$1::jsonb)",
  [JSON.stringify({id:'rehearsal_shift',objectId:'isolated',objectName:'Тест копии'})]);
 for(const [uid,number] of [['rehearsal_user_one','101'],['rehearsal_user_two','202']]){
  await pool.query(
   "INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$2,$3,'lopater','active')",
   [uid,uid+'@example.invalid','Тест оператор '+number]);
  await pool.query("INSERT INTO line_trucks(workspace_id,truck_id,payload) "+
   "VALUES('main_workspace',$1,$2::jsonb)",
   [uid,JSON.stringify({id:uid,brand:'КАМАЗ',number,defaultVol:24,isGAI:false})]);
  await pool.query("INSERT INTO line_truck_statuses "+
   "(workspace_id,truck_id,shift_id,payload) "+
   "VALUES('main_workspace',$1,'rehearsal_shift',$2::jsonb)",
   [uid,JSON.stringify({id:uid,shiftId:'rehearsal_shift',cycleRevision:1,
    ttnRevision:0,onLine:true,loadedAfterArrive:false})]);
 }
 for(const action of ['tab_line','action_arrive','action_load','action_ttn'])
  await pool.query(
   "INSERT INTO role_permissions(role,action,allowed) VALUES('lopater',$1,true) "+
   "ON CONFLICT(role,action) DO UPDATE SET allowed=true",[action]);
}
sqltest('SQL001-013 database copy upgrades to SQL014-016 without losing truck/operator data or enabling live failover',
 async()=>{
 const tag=String(Date.now())+String(Math.floor(Math.random()*1000000)).padStart(6,'0');
 const base='sc_verify_'+tag,clone='sc_verify_'+tag+'1';
 const source=new URL(process.env.TEST_DATABASE_URL),adminUrl=new URL(source);
 adminUrl.pathname='/postgres';
 const admin=new pg.Client({connectionString:adminUrl.toString()});
 let original=null,copy=null,baseCreated=false,cloneCreated=false;
 await admin.connect();
 try{
  await admin.query('CREATE DATABASE '+base);
  baseCreated=true;
  source.pathname='/'+base;
  original=new pg.Pool({connectionString:source.toString(),max:3});
  for(let n=1;n<=13;n++)await original.query(forIsolatedDatabase(n,base));
  await seedBaseline(original);
  const expected=await snapshot(original);
  assert.equal(expected.app_users.filter(u=>u.uid.startsWith('rehearsal_user_')).length,2);
  assert.equal(expected.line_truck_statuses.filter(u=>
   u.truck_id.startsWith('rehearsal_user_')).length,2);
  await original.end();original=null;
  // PostgreSQL TEMPLATE produces a consistent DB copy only after all
  // source connections close; the original is then never mutated.
  await admin.query('CREATE DATABASE '+clone+' TEMPLATE '+base);
  cloneCreated=true;
  source.pathname='/'+clone;
  copy=new pg.Pool({connectionString:source.toString(),max:3});
  assert.deepEqual(await snapshot(copy),expected);

  // Deliberate stale/unknown table simulates drift of a restored schema.
  // SQL014 must abort atomically, without quietly publishing partial outbox.
  await copy.query('CREATE TABLE public.rehearsal_unknown_table (id text PRIMARY KEY)');
  await assert.rejects(copy.query(migration(14)),/reserve-outbox-schema-inventory-mismatch/);
  assert.equal((await copy.query(
   "SELECT to_regclass('public.reserve_outbox_cursor') AS r")).rows[0].r,null);
  await copy.query('DROP TABLE public.rehearsal_unknown_table');

  for(let n=14;n<=16;n++)await copy.query(migration(n));
  assert.deepEqual(await snapshot(copy),expected,
   'upgrading the restored clone must not rewrite historical trucks or operators');
  const gate=(await copy.query(
   'SELECT armed,coverage_certified,owner_epoch::int AS epoch FROM reserve_control.writer_gate'
  )).rows[0];
  assert.deepEqual(gate,{armed:false,coverage_certified:false,epoch:0},
   'a migration alone must never enable automatic owner promotion');
  const counters=(await copy.query(
   "SELECT count(*) FILTER (WHERE tgname='reserve_row_change')::int AS outbox,"+
   " count(*) FILTER (WHERE tgname='spark_writer_gate')::int AS row_gate,"+
   " count(*) FILTER (WHERE tgname='spark_writer_gate_truncate')::int AS truncate_gate"+
   " FROM pg_trigger WHERE NOT tgisinternal")).rows[0];
  assert.deepEqual(counters,{outbox:39,row_gate:39,truncate_gate:39});
  assert.equal((await copy.query(
   'SELECT count(*)::int AS n FROM reserve_spark_replay_checkpoint')).rows[0].n,0,
   'the upgrade must not invent applied Firebase events');
  assert.equal((await copy.query(
   'SELECT count(*)::int AS n FROM reserve_replica_receipt')).rows[0].n,0,
   'an upgrade cannot certify its own unverified Firebase mirror');

  // Idempotent retry after an uncertain SQL ACK.
  for(let n=14;n<=16;n++)await copy.query(migration(n));
  assert.deepEqual(await snapshot(copy),expected);
  const after=(await copy.query(
   "SELECT count(*) FILTER (WHERE tgname='reserve_row_change')::int AS outbox,"+
   " count(*) FILTER (WHERE tgname='spark_writer_gate')::int AS row_gate,"+
   " count(*) FILTER (WHERE tgname='spark_writer_gate_truncate')::int AS truncate_gate"+
   " FROM pg_trigger WHERE NOT tgisinternal")).rows[0];
  assert.deepEqual(after,counters,'replaying migrations must not multiply triggers');
  await copy.query(
   "UPDATE reserve_control.writer_gate SET armed=true,coverage_certified=true,owner_epoch=7");
  await assert.rejects(copy.query(
   "UPDATE workspaces SET cycle_minutes=61 WHERE id='main_workspace'"),
   /spark-fence-permit-required/);
  assert.equal((await copy.query(
   "SELECT cycle_minutes FROM workspaces WHERE id='main_workspace'")).rows[0].cycle_minutes,60,
   'unauthorized post-upgrade writes must roll back');
  await copy.end();copy=null;
  // Check source again: upgrading the restored copy must not touch it.
  source.pathname='/'+base;
  original=new pg.Pool({connectionString:source.toString(),max:2});
  assert.deepEqual(await snapshot(original),expected);
 }finally{
  if(copy)await copy.end().catch(()=>{});
  if(original)await original.end().catch(()=>{});
  if(cloneCreated)await admin.query('DROP DATABASE '+clone);
  if(baseCreated)await admin.query('DROP DATABASE '+base);
  await admin.end();
 }
});
