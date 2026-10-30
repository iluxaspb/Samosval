import test from 'node:test';
import assert from 'node:assert/strict';
import {RESERVE_TABLES,captureReserveSnapshot} from '../src/reserve-checkpoint.mjs';
import {createPostgresOutbox} from '../src/reserve-postgres-outbox.mjs';
const connection=process.env.TEST_DATABASE_URL;
const pgtest=(name,fn)=>test(name,{skip:!connection},fn);
async function setup(){
 const {default:pg}=await import('pg');
 const pool=new pg.Pool({connectionString:connection,max:5});
 return {pool,close:()=>pool.end()};
}
async function highWater(pool){
 const r=await pool.query('SELECT last_sequence::text AS n FROM reserve_outbox_cursor WHERE singleton=true');
 return Number(r.rows[0].n);
}
const record=(id,payload='{}')=>['main_workspace',id,'outbox-test',id,payload];
async function insert(c,id){
 return c.query(`INSERT INTO tabel_records(workspace_id,record_id,object_id,record_key,payload)
 VALUES ($1,$2,$3,$4,$5::jsonb)`,record(id,JSON.stringify({hours:12,formula:'=ROUND(10/3,2)',deleted:false})));
}
pgtest('all 39 TEST tables have a transaction-bound row-change trigger, no recursive outbox triggers',async()=>{
 const {pool,close}=await setup();
 try{
  const r=await pool.query(`SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace WHERE t.tgname='reserve_row_change'
   AND NOT t.tgisinternal AND n.nspname='public' ORDER BY c.relname`);
  assert.deepEqual(r.rows.map(x=>x.relname),RESERVE_TABLES);
 }finally{await close();}
});
pgtest('INSERT/UPDATE/DELETE and changed primary key all produce committed, gapless order',async()=>{
 const {pool,close}=await setup(),c=await pool.connect();
 const id='outbox-'+Date.now()+'-'+Math.random().toString(36).slice(2);
 try{
  const start=await highWater(pool);
  await c.query('BEGIN');
  await insert(c,id);
  await c.query("UPDATE tabel_records SET payload=jsonb_set(payload,'{hours}','0'::jsonb) WHERE record_id=$1",[id]);
  await c.query('UPDATE tabel_records SET record_key=$2 WHERE record_id=$1',[id,id+'-moved']);
  await c.query('DELETE FROM tabel_records WHERE record_id=$1',[id]);
  await c.query('COMMIT');
  const rows=(await pool.query(
   'SELECT sequence::text AS sequence,action,row_key::text AS key,row_data::text AS data FROM reserve_replica_outbox WHERE sequence>$1 ORDER BY sequence',[start]
  )).rows;
  assert.equal(rows.length,5); // INSERT, UPDATE, PK-change tombstone+new, DELETE.
  assert.deepEqual(rows.map(x=>Number(x.sequence)),[1,2,3,4,5].map(n=>n+start));
  assert.deepEqual(rows.map(x=>x.action),['upsert','upsert','delete','upsert','delete']);
  assert.match(rows[0].data,/"formula":/);
  assert.match(rows[1].data,/"hours": 0/);
  assert.equal(rows[2].data,null);
  assert.equal(rows[4].data,null);
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();await close();}
});
pgtest('failed business transaction leaves no outbox row and never burns a sequence',async()=>{
 const {pool,close}=await setup(),c=await pool.connect(),id='rollback-'+Date.now();
 try{
  const before=await highWater(pool);
  await c.query('BEGIN');await insert(c,id);
  await c.query('ROLLBACK');
  assert.equal(await highWater(pool),before);
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM tabel_records WHERE record_id=$1",[id])).rows[0].n,0);
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();await close();}
});
pgtest('parallel writers cannot publish events out of commit order',async()=>{
 const {pool,close}=await setup(),a=await pool.connect(),b=await pool.connect();
 const id='serial-'+Date.now()+'-'+Math.random().toString(36).slice(2);
 try{
  const before=await highWater(pool);
  await a.query('BEGIN');await insert(a,id+'-a');
  await b.query('BEGIN');
  let finished=false;
  const pending=insert(b,id+'-b').then(()=>{finished=true;});
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(finished,false,'second transaction must await first cursor lock');
  await a.query('COMMIT');await pending;await b.query('COMMIT');
  const rows=(await pool.query('SELECT sequence::text AS seq,row_data::text AS data FROM reserve_replica_outbox WHERE sequence>$1 ORDER BY sequence',[before])).rows;
  assert.equal(rows.length,2);assert.equal(Number(rows[0].seq),before+1);
  assert.equal(Number(rows[1].seq),before+2);
  assert.match(rows[0].data,new RegExp(id+'-a'));
  assert.match(rows[1].data,new RegExp(id+'-b'));
 }finally{await a.query('ROLLBACK').catch(()=>{});await b.query('ROLLBACK').catch(()=>{});a.release();b.release();await close();}
});
pgtest('snapshot and outbox sequence are from one repeatable-read view',async()=>{
 const {pool,close}=await setup();
 try{
  const at=await highWater(pool);
  const {snapshot,outboxSequence}=await captureReserveSnapshot(pool,{withOutboxHead:true});
  assert.equal(outboxSequence,at);
  assert.ok(Array.isArray(snapshot.tables.tabel_records));
  assert.equal(Object.keys(snapshot.tables).length,RESERVE_TABLES.length);
 }finally{await close();}
});
pgtest('adapter reads exact Postgres JSON text; durable cursor is bootstrapped only after verification',async()=>{
 const {pool,close}=await setup();
 try{
  const outbox=createPostgresOutbox({pool,verifyCheckpoint:async()=>true});
  const from=await highWater(pool);
  const hash='a'.repeat(64);
  await outbox.initializeReceipt({sequence:from,hash});
  const id='reader-'+Date.now();
  await pool.query(`INSERT INTO tabel_records(workspace_id,record_id,object_id,record_key,payload)
   VALUES($1,$2,$3,$4,$5::jsonb)`,record(id,JSON.stringify({precise:'9223372036854775807',formula:'=ROUND(7/3,2)'})));
  const rows=await outbox.readPending(from,10);
  assert.equal(rows.length,1);assert.equal(rows[0].sequence,from+1);
  assert.equal(rows[0].table,'tabel_records');assert.equal(rows[0].action,'upsert');
  assert.match(rows[0].row.postgresJson,/9223372036854775807/);
  assert.ok(rows[0].keyJson.includes(id));
  const receipt={sequence:from+1,hash:'b'.repeat(64)};
  await outbox.persistReceipt({previous:{sequence:from,hash},receipt,batchId:receipt.hash});
  assert.deepEqual(await outbox.readReceipt(),receipt);
  await outbox.persistReceipt({previous:{sequence:from,hash},receipt,batchId:receipt.hash});
  await assert.rejects(outbox.persistReceipt({previous:{sequence:from,hash},receipt:{sequence:from+1,hash:'c'.repeat(64)},batchId:'c'.repeat(64)}),/outbox-receipt-cas-conflict/);
  await assert.rejects(outbox.initializeReceipt({sequence:from,hash}),/outbox-bootstrap-head-changed/);
 }finally{await close();}
});
