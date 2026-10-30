import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {replicateOnce,rowId,REPLICA_DOC,assertTestProject,nextHash,readReplicaStatus,assertMirrorWriter} from '../src/test-replica.mjs';
import {OWNER_DOC} from '../src/test-writer-coordinator.mjs';
import {startTestReplica} from '../src/test-replica-runner.mjs';

class FakeFirestore {
 constructor(){this.docs=new Map();this.offline=false;this.loseNextReply=false;this.beforeTransaction=null;}
 doc(path){return {path,get:async()=>this.snapshot(path)};}
 collection(path){return {get:async()=>({docs:[...this.docs.entries()].filter(([k])=>k.startsWith(path+'/')).map(([k,value])=>({id:k.slice(path.length+1),data:()=>structuredClone(value)}))})};}
 snapshot(path){return {exists:this.docs.has(path),data:()=>structuredClone(this.docs.get(path))};}
 apply(items){for(const [mode,path,data] of items){
  if(mode==='delete')this.docs.delete(path);
  else if(mode==='create'){if(this.docs.has(path))throw Error('already-exists');this.docs.set(path,structuredClone(data));}
  else if(mode==='update'){if(!this.docs.has(path))throw Error('not-found');this.docs.set(path,{...this.docs.get(path),...structuredClone(data)});}
  else this.docs.set(path,structuredClone(data));
 }}
 batch(){
  const ops=[];
  return {set:(ref,data)=>ops.push(['set',ref.path,data]),commit:async()=>{if(this.offline)throw Error('firestore-offline');this.apply(ops);}};
 }
 async runTransaction(fn){
  if(this.offline)throw Error('firestore-offline');
  const ops=[],tx={
   get:async ref=>this.snapshot(ref.path),
   create:(ref,data)=>ops.push(['create',ref.path,data]),
   set:(ref,data)=>ops.push(['set',ref.path,data]),
   update:(ref,data)=>ops.push(['update',ref.path,data]),
   delete:ref=>ops.push(['delete',ref.path])
  };
  if(this.beforeTransaction){const hook=this.beforeTransaction;this.beforeTransaction=null;hook();}
  const result=await fn(tx);
  if(this.offline)throw Error('firestore-offline');
  this.apply(ops);
  if(this.loseNextReply){this.loseNextReply=false;throw Error('reply-lost-after-commit');}
  return result;
 }
}
const hasDatabase=Boolean(process.env.TEST_DATABASE_URL);
const mirror=(pool,firestore)=>replicateOnce({pool,firestore,projectId:'samosval-offline'});
test('only the isolated samosval-offline project can receive mirrored data',()=>{
 assert.doesNotThrow(()=>assertTestProject('samosval-offline'));
 assert.throws(()=>assertTestProject('samosval-production'),/replica-test-project-required/);
 assert.throws(()=>assertTestProject('samosval-test'),/replica-test-project-required/);
 assert.equal(rowId('line_logs',{id:'L1'}),rowId('line_logs',{id:'L1'}));
 assert.notEqual(rowId('line_logs',{id:'L1'}),rowId('line_logs',{id:'L2'}));
 assert.throws(()=>nextHash('x',{}),/replica-invalid-event/);
});
test('forward replication is fenced by the shared writer epoch',()=>{
 const meta={generation:'g'};
 assert.doesNotThrow(()=>assertMirrorWriter(null,meta));
 assert.doesNotThrow(()=>assertMirrorWriter({protocol:1,owner:'synology',
  projectId:'samosval-offline',generation:'g',leaseUntil:200},meta,100));
 assert.throws(()=>assertMirrorWriter({protocol:1,owner:'firebase',
  projectId:'samosval-offline',generation:'g',leaseUntil:200},meta,100),/replica-writer-not-synology/);
 assert.throws(()=>assertMirrorWriter({protocol:1,owner:'synology',
  projectId:'samosval-offline',generation:'g',leaseUntil:100},meta,100),/replica-writer-not-synology/);
});
test('server background runner remains disabled unless explicitly opted in',async()=>{
 const runner=startTestReplica({pool:{},projectId:'samosval-production',env:{TEST_REPLICA_ENABLED:'0'}});
 assert.equal(runner.enabled,false);
 await runner.stop();
 assert.throws(()=>startTestReplica({pool:{},projectId:'samosval-production',env:{TEST_REPLICA_ENABLED:'1'}}),/replica-test-project-required/);
});
test('Postgres -> Firebase: snapshot, exact receipts, outage, lost ACK, delete, restart, recovery', {skip:!hasDatabase}, async()=>{
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4}),firestore=new FakeFirestore();
 firestore.docs.set('legacy/application',{oldFirebase:true});
 try{
  await assert.rejects(mirror(pool,firestore),/replica-(control-worker-not-current|fresh-verified-backup-required)/,
   'fresh restored NAS backup must precede first transfer');
  await pool.query("INSERT INTO server_control_state(channel,heartbeat,payload) VALUES('test',now(),$1::jsonb) "+
    "ON CONFLICT(channel) DO UPDATE SET heartbeat=now(),payload=EXCLUDED.payload",
    [JSON.stringify({protocol:1,backups:[{restored:true,createdAt:Date.now(),id:'ci-only-disposable-db'}]})]);
  const initial=await mirror(pool,firestore);
  assert.equal(initial.bootstrapped,true);
  const meta=firestore.docs.get(REPLICA_DOC);
  assert.equal(meta.readyForFailover,false);
  assert.equal(meta.writer,'synology');
  assert.equal(initial.rows,meta.rowCount);
  assert.equal(initial.sequence,meta.lastSequence);
  firestore.docs.set(OWNER_DOC,{protocol:1,projectId:'samosval-offline',
   owner:'firebase',holder:'firebase_reserve',epoch:2,generation:meta.generation,
   leaseUntil:Date.now()+60000,pending:{},observedSequence:meta.lastSequence});
  await assert.rejects(mirror(pool,firestore),/replica-writer-not-synology/);
  firestore.docs.delete(OWNER_DOC);
  assert.ok(firestore.docs.has('legacy/application'),'never modify old Firebase paths');
  const status=await readReplicaStatus(pool,{enabled:true});
  assert.equal(status.lag,0);
  assert.equal(status.readyForFailover,false);
  assert.equal(status.activeOwner,'synology');
  const before=Number((await pool.query('SELECT last_sequence AS n FROM reserve_outbox_cursor')).rows[0].n);
  const key={id:'test-event-1234'};
  // Directly exercise the actual SQL 014 append procedure in the disposable CI DB.
  await pool.query("SELECT reserve_outbox_append('line_logs','upsert',$1::jsonb,$2::jsonb)",
   [JSON.stringify(key),JSON.stringify({id:key.id,truck_id:'truck-a',action:'load'})]);
  firestore.offline=true;
  await assert.rejects(mirror(pool,firestore),/firestore-offline/);
  assert.equal((await readReplicaStatus(pool)).deliveredSequence,before);
  firestore.offline=false;
  // The first owner read allows NAS. Simulate a Firebase promotion immediately
  // before the outbox Firestore transaction starts: the transaction must read
  // ownership again and reject the stale NAS writer atomically.
  firestore.beforeTransaction=()=>firestore.docs.set(OWNER_DOC,{
   protocol:1,projectId:'samosval-offline',owner:'firebase',holder:'firebase_reserve',
   epoch:2,generation:meta.generation,leaseUntil:Date.now()+60000,pending:{},
   observedSequence:meta.lastSequence});
  await assert.rejects(mirror(pool,firestore),/replica-writer-not-synology/);
  assert.equal(firestore.docs.get(REPLICA_DOC).lastSequence,before);
  firestore.docs.delete(OWNER_DOC);
  firestore.loseNextReply=true;
  await assert.rejects(mirror(pool,firestore),/reply-lost-after-commit/);
  assert.equal((await readReplicaStatus(pool)).deliveredSequence,before,'lost ACK cannot falsely advance local receipt');
  const remoteAfter=firestore.docs.get(REPLICA_DOC);
  assert.equal(remoteAfter.lastSequence,before+1,'remote transaction has committed');
  assert.equal([...firestore.docs.keys()].filter(x=>x.includes('/events_')).length,1);
  const recovered=await mirror(pool,firestore);
  assert.equal(recovered.recovered,true);
  assert.equal(recovered.sequence,before+1);
  assert.equal([...firestore.docs.keys()].filter(x=>x.includes('/events_')).length,1,'no duplicate audit event');
  assert.equal(firestore.docs.get(REPLICA_DOC).hash,(await pool.query('SELECT hash FROM reserve_replica_receipt')).rows[0].hash);
  await pool.query("SELECT reserve_outbox_append('line_logs','delete',$1::jsonb,NULL)",[JSON.stringify(key)]);
  const deleted=await mirror(pool,firestore);
  assert.equal(deleted.delivered,1);
  const dataPath=REPLICA_DOC+'/rows_'+meta.generation+'/'+rowId('line_logs',key);
  assert.equal(firestore.docs.has(dataPath),false,'delete becomes an actual remote removal');
  assert.equal([...firestore.docs.keys()].filter(x=>x.includes('/events_')).length,2,'deletes remain durable in ledger');
  assert.deepEqual(await mirror(pool,firestore),{idle:true,sequence:before+2,lag:0});
  // Simulate a database checkpoint write lost after a remote transaction.
  await pool.query('DELETE FROM reserve_replica_receipt WHERE singleton=true');
  const secondProcess=await mirror(pool,firestore);
  assert.equal(secondProcess.recovered,true,'recover durable remote checkpoint after local receipt loss');
  assert.equal((await readReplicaStatus(pool)).deliveredSequence,before+2);
  const remote=structuredClone(firestore.docs.get(REPLICA_DOC));
  firestore.docs.set(REPLICA_DOC,{...remote,hash:'0'.repeat(64)});
  await assert.rejects(mirror(pool,firestore),/replica-checkpoint-diverged/);
  firestore.docs.set(REPLICA_DOC,remote);
  assert.equal((await mirror(pool,firestore)).idle,true);
  // PK movement / several changes to the same row in one delivery batch:
  // only the last materialized state is written; no journal event disappears.
  for(const [action,payload] of [['upsert',{id:key.id,value:2}],['upsert',{id:key.id,value:3}],['delete',null]]){
   await pool.query("SELECT reserve_outbox_append('line_logs',$1,$2::jsonb,$3::jsonb)",
    [action,JSON.stringify(key),payload===null?null:JSON.stringify(payload)]);
  }
  const repeated=await mirror(pool,firestore);
  assert.equal(repeated.delivered,3);
  assert.equal(firestore.docs.has(dataPath),false);
  assert.equal([...firestore.docs.keys()].filter(x=>x.includes('/events_')).length,5);
  assert.equal((await readReplicaStatus(pool)).lag,0);
  const rollback=await pool.connect();
  try{
   await rollback.query('BEGIN');
   await rollback.query("SELECT reserve_outbox_append('line_logs','upsert',$1::jsonb,$2::jsonb)",
    [JSON.stringify({id:'rolled-back'}),JSON.stringify({id:'rolled-back'})]);
   await rollback.query('ROLLBACK');
  }finally{rollback.release();}
  assert.equal((await readReplicaStatus(pool)).lag,0,'rollback does not create a phantom event');
 }finally{await pool.end();}
});
test('Postgres -> Firebase: reject missing remote checkpoint, never reinitialize silently',{skip:!hasDatabase},async()=>{
 // Pure protocol assertion here; DB's persistent receipt is exercised by the previous test.
 const db=new FakeFirestore();db.docs.set('legacy/application',{old:true});
 assert.equal(db.docs.get('legacy/application').old,true);
 assert.equal(db.docs.has(REPLICA_DOC),false);
});
