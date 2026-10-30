import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {RESERVE_TABLES,canonicalReserve,captureReserveSnapshot,encodeReserveCheckpoint,decodeReserveCheckpoint} from '../src/reserve-checkpoint.mjs';
import {createReserveCheckpointStore} from '../src/reserve-firestore.mjs';
export function fixture(){
  const tables=Object.fromEntries(RESERVE_TABLES.map(t=>[t,[]])),schema=Object.fromEntries(RESERVE_TABLES.map(t=>[t,[{column_name:'id',data_type:'text'},{column_name:'payload',data_type:'jsonb'}]]));
  tables.workspaces=[{id:'main_workspace',payload:{}}];
  tables.line_operation_receipts=[{id:'lost-reply',payload:{outcome:'confirmed',log:{id:'trip-stable'}}}];
  tables.line_logs=[{id:'trip-stable',payload:{volume:24,comment:'',ttn:false}}];
  tables.tabel_records=[{id:'table',payload:{hours:0,formula:'=ROUND(10/3,2)',deleted:false}}];
  tables.game_records=[{id:'wallet',payload:{balance:-3}}];
  tables.app_users=[{id:'owner',payload:{role:'admin',status:'active',nickname:'Test',deleted:false}}];
  tables.archive_overrides=[{id:'deleted',payload:{location:'trash',logs:[]}}];
  return {format:'samosval-native-reserve',version:1,projectId:'samosval-offline',workspaceId:'main_workspace',schema,tables};
}
function memoryStore(){
  const docs=new Map(),writes=[];let failAt=-1;
  const firestore={projectId:'samosval-offline',doc:path=>({
    create:async value=>{writes.push(path);if(writes.length===failAt)throw Error('network-disconnected');if(docs.has(path))throw Object.assign(Error('exists'),{code:6});docs.set(path,structuredClone(value));if(value.data)docs.get(path).data=Buffer.from(value.data);},
    get:async()=>({exists:docs.has(path),data:()=>{const value=structuredClone(docs.get(path));if(value?.data)value.data=Buffer.from(value.data);return value;}}),
  })};
  return {store:createReserveCheckpointStore({firestore}),docs,writes,failAt:n=>{failAt=n;}};
}
test('canonical checkpoint retains receipts, decimals, zero, empty text, negative wallets, formulas and tombstones',()=>{
  const snapshot=fixture(),encoded=encodeReserveCheckpoint(snapshot),restored=decodeReserveCheckpoint(encoded.manifest,encoded.chunks);
  assert.deepEqual(restored,snapshot);assert.equal(encoded.manifest.counts.line_operation_receipts,1);
  assert.equal(canonicalReserve({b:2,a:1}),canonicalReserve({a:1,b:2}));
  assert.throws(()=>canonicalReserve({value:NaN}),/unsupported/);
});
test('foreign project, omitted domain, unknown schema and foreign workspace are rejected before upload',()=>{
  for(const mutate of [s=>s.projectId='production',s=>delete s.tables.history_receipts,s=>s.schema.unknown=[],s=>s.tables.workspaces[0].id='production',s=>s.tables.line_logs[0].workspace_id='other']){
    const s=fixture();mutate(s);assert.throws(()=>encodeReserveCheckpoint(s));
  }
  assert.throws(()=>createReserveCheckpointStore({firestore:{projectId:'production',doc(){}}}),/test-firestore/);
});
test('corrupt bytes, incomplete snapshots, wrong chunks, counts and hashes never verify',()=>{
  const {manifest,chunks}=encodeReserveCheckpoint(fixture());
  for(const mutate of [m=>m.hash='b'.repeat(64),m=>m.schemaHash='c'.repeat(64),m=>m.counts.line_logs++,m=>m.packedBytes++,m=>m.chunks[0].index=4]){
    const m=structuredClone(manifest);mutate(m);assert.throws(()=>decodeReserveCheckpoint(m,chunks));
  }
  assert.throws(()=>decodeReserveCheckpoint(manifest,[]));
  const corrupted=chunks.map(x=>({...x,data:Buffer.from(x.data)}));corrupted[0].data[0]^=1;
  assert.throws(()=>decodeReserveCheckpoint(manifest,corrupted),/chunk-mismatch/);
  assert.throws(()=>decodeReserveCheckpoint(manifest,chunks,{maxBytes:100}),/invalid-checkpoint/);
});
test('multi-document upload publishes manifest last and retry reuses immutable chunks after a disconnect',async()=>{
  const h=memoryStore(),snapshot=fixture();snapshot.tables.workspace_backups=[{id:'backup',payload:{bytes:randomBytes(800000).toString('base64')}}];
  h.failAt(2);await assert.rejects(h.store.put(snapshot),/network-disconnected/);
  assert.equal([...h.docs.keys()].some(p=>!p.includes('/chunks/')),false);
  h.failAt(-1);const checkpoint=await h.store.put(snapshot);assert.ok(checkpoint.chunks>1);
  assert.equal(h.writes.at(-1),'test_failover/main_workspace/checkpoints/'+checkpoint.hash);
  assert.equal(await h.store.verify(checkpoint),true);assert.deepEqual(await h.store.read(checkpoint.hash),snapshot);
  const count=h.docs.size;await h.store.put(snapshot);assert.equal(h.docs.size,count);
  assert.equal(await h.store.verify({hash:'unknown'}),false);
});
test('existing content-addressed data cannot be overwritten or mistaken for a verified copy',async()=>{
  const h=memoryStore(),s=fixture(),cp=await h.store.put(s),path=[...h.docs.keys()].find(p=>p.includes('/chunks/'));
  h.docs.get(path).data[0]^=1;assert.equal(await h.store.verify(cp),false);
  await assert.rejects(h.store.put(s),/immutable-checkpoint-conflict/);
});
test('snapshot capture uses one repeatable-read transaction, deterministic rows and always releases on failure',async()=>{
  const s=fixture(),queries=[];let released=false;
  const c={query:async sql=>{queries.push(sql);
    if(sql.includes('current_database'))return {rows:[{name:'samosval_test'}]};
    if(sql.includes('information_schema.columns'))return {rows:RESERVE_TABLES.flatMap(table_name=>s.schema[table_name].map(c=>({table_name,...c})))};
    if(sql.startsWith('SELECT * FROM '))return {rows:s.tables[sql.slice(14)]};return {rows:[]};
  },release:()=>{released=true;}};
  assert.deepEqual(await captureReserveSnapshot({connect:async()=>c}),s);assert.equal(queries[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal(queries.at(-1),'COMMIT');assert.equal(released,true);
  c.query=async sql=>{queries.push(sql);return {rows:[{name:'production'}]};};released=false;
  await assert.rejects(captureReserveSnapshot({connect:async()=>c}),/test-database-required/);assert.equal(queries.at(-1),'ROLLBACK');assert.equal(released,true);
});
test('table inventory covers every checked-in migration and import table',()=>{
  const names=new Set();for(let n=1;n<=12;n++){
    const files=['001_init','002_tabel','003_shift_close','004_objects','005_controls','006_identity','007_line_history','008_workspace_services','009_auxiliary','010_reports','011_backups','012_notifications'];
    const sql=readFileSync(new URL('../sql/'+files[n-1]+'.sql',import.meta.url),'utf8');for(const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g))names.add(m[1]);
  }
  names.add('migration_documents');names.add('migration_imports');assert.deepEqual([...names].sort(),RESERVE_TABLES);
});
test('actual PostgreSQL checkpoint round-trip retains schema and all native rows', {skip:!process.env.TEST_DATABASE_URL},async()=>{
  const {default:pg}=await import('pg'),pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  try{const snapshot=await captureReserveSnapshot(pool),encoded=encodeReserveCheckpoint(snapshot);assert.deepEqual(canonicalReserve(decodeReserveCheckpoint(encoded.manifest,encoded.chunks)),canonicalReserve(snapshot));}finally{await pool.end();}
});
