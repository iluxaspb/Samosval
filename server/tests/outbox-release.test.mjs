import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFileSync} from 'node:fs';

const enabled=Boolean(process.env.TEST_DATABASE_URL);
const sqltest=(name,fn)=>test(name,{skip:!enabled},fn);
const open=()=>new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});
const nextId=()=>`outbox-release-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const position=async pool=>Number((await pool.query(
 'SELECT last_sequence::text AS sequence FROM reserve_outbox_cursor WHERE singleton=true'
)).rows[0].sequence);

sqltest('014 installs capture triggers on all 39 TEST tables, never its own outbox',async()=>{
 const pool=open();try{
  const tables=(await pool.query(`SELECT c.relname AS name FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid
    WHERE t.tgname='reserve_row_change' AND NOT t.tgisinternal
    ORDER BY c.relname`)).rows.map(r=>r.name);
  assert.equal(tables.length,39);
  assert.equal(new Set(tables).size,39);
  assert.equal(tables.includes('tabel_records'),true);
  assert.equal(tables.includes('line_logs'),true);
  assert.equal(tables.some(name=>name.startsWith('reserve_')),false);
 }finally{await pool.end();}
});
sqltest('one PostgreSQL transaction commits table edit and outbox together; ROLLBACK does not burn a number',async()=>{
 const pool=open(),c=await pool.connect(),id=nextId();
 try{
  const before=await position(pool);
  await c.query('BEGIN');
  await c.query(`INSERT INTO tabel_records(workspace_id,record_id,object_id,record_key,payload)
   VALUES('main_workspace',$1,'test',$1,$2::jsonb)`,[id,JSON.stringify({hours:12,formula:'=ROUND(10/3,2)'})]);
  await c.query('ROLLBACK');
  assert.equal(await position(pool),before);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tabel_records WHERE record_id=$1',[id])).rows[0].n,0);
  await c.query('BEGIN');
  await c.query(`INSERT INTO tabel_records(workspace_id,record_id,object_id,record_key,payload)
   VALUES('main_workspace',$1,'test',$1,$2::jsonb)`,[id,JSON.stringify({hours:12})]);
  await c.query('COMMIT');
  const events=(await pool.query('SELECT action,row_data FROM reserve_replica_outbox WHERE sequence=$1',[before+1])).rows;
  assert.equal(events.length,1);assert.equal(events[0].action,'upsert');
  assert.equal(events[0].row_data.payload.hours,12);
 }finally{
  await c.query('ROLLBACK').catch(()=>{});c.release();
  await pool.query('DELETE FROM tabel_records WHERE record_id=$1',[id]).catch(()=>{});
  await pool.end();
 }
});
sqltest('simultaneous TEST writers must commit in strict outbox sequence',async()=>{
 const pool=open(),a=await pool.connect(),b=await pool.connect(),id=nextId();
 try{
  const before=await position(pool);
  await a.query('BEGIN');
  await a.query(`INSERT INTO tabel_records(workspace_id,record_id,object_id,record_key,payload)
    VALUES('main_workspace',$1,'test',$1,'{}')`,[id+'-a']);
  await b.query('BEGIN');
  let ready=false;
  const p=b.query(`INSERT INTO tabel_records(workspace_id,record_id,object_id,record_key,payload)
    VALUES('main_workspace',$1,'test',$1,'{}')`,[id+'-b']).then(()=>{ready=true;});
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal(ready,false,'the second writer must wait for the first transaction');
  await a.query('COMMIT');await p;await b.query('COMMIT');
  const events=(await pool.query('SELECT sequence::text AS sequence,row_data FROM reserve_replica_outbox WHERE sequence>$1 ORDER BY sequence',[before])).rows;
  assert.equal(Number(events[0].sequence),before+1);
  assert.equal(Number(events[1].sequence),before+2);
  assert.equal(events[0].row_data.record_id,id+'-a');
  assert.equal(events[1].row_data.record_id,id+'-b');
 }finally{
  await a.query('ROLLBACK').catch(()=>{});await b.query('ROLLBACK').catch(()=>{});a.release();b.release();
  await pool.query('DELETE FROM tabel_records WHERE record_id IN ($1,$2)',[id+'-a',id+'-b']).catch(()=>{});
  await pool.end();
 }
});

sqltest('volatile NAS heartbeat never generates Firebase replication writes',async()=>{
 const pool=open();
 try{
  const before=await position(pool);
  await pool.query("INSERT INTO server_control_state(channel,heartbeat,payload) VALUES('test',now(),'{}') ON CONFLICT(channel) DO UPDATE SET heartbeat=now(),payload='{}'::jsonb");
  await pool.query("UPDATE server_control_state SET heartbeat=clock_timestamp(),payload=$1::jsonb WHERE channel='test'",[JSON.stringify({host:{memoryBytes:1234},protocol:1})]);
  assert.equal(await position(pool),before,'operational heartbeat must not create minute batches');
 }finally{await pool.end();}
});

sqltest('SQL 014 can rehearse in an isolated restored TEST clone but rejects production database',async()=>{
  const source=readFileSync(new URL('../sql/014_reserve_outbox.sql',import.meta.url),'utf8');
  const id='sc_verify_'+String(Date.now());
  // This exercise does NOT modify samosval_test. Admin connection only creates
  // a fresh scratch database with the exact same naming as NAS recovery uses.
  const url=new URL(process.env.TEST_DATABASE_URL),database=url.pathname.slice(1);
  url.pathname='/postgres';
  const admin=new pg.Client({connectionString:url.toString()});
  await admin.connect();
  let created=false;
  try{
    await admin.query('CREATE DATABASE '+id);created=true;
    const verifyUrl=new URL(process.env.TEST_DATABASE_URL);verifyUrl.pathname='/'+id;
    const verify=new pg.Client({connectionString:verifyUrl.toString()});
    await verify.connect();
    try{
      for(const file of [
        '001_init','002_tabel','003_shift_close','004_objects','005_controls',
        '006_identity','007_line_history','008_workspace_services',
        '009_auxiliary','010_reports','011_backups','012_notifications',
        '013_server_control'
      ]) await verify.query(readFileSync(new URL('../sql/'+file+'.sql',import.meta.url),'utf8'));
      await verify.query(source);
      const triggerCount=(await verify.query(
        "SELECT count(*)::integer AS n FROM pg_trigger WHERE tgname='reserve_row_change' AND NOT tgisinternal"
      )).rows[0].n;
      assert.equal(triggerCount,39);
    }finally{await verify.end();}
  }finally{
    if(created)await admin.query('DROP DATABASE '+id+' WITH (FORCE)');
    await admin.end();
  }
  assert.match(source,/current_database\(\)\s*!~\s*'\^sc_verify_\[0-9\]\+\$'/);
});
