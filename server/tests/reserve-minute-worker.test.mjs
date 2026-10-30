import test from 'node:test';
import assert from 'node:assert/strict';
import {createReserveMinuteWorker} from '../src/reserve-minute-worker.mjs';
const digest='a'.repeat(64);
function fixture({bootstrapped=true}={}){
  let receipt=bootstrapped?{sequence:0,hash:digest}:null,attempts=0;
  const rows=[{sequence:'1',table_name:'line_logs',action:'upsert',
    row_key_json:JSON.stringify({workspace_id:'main_workspace',log_id:'1'}),
    row_data_json:JSON.stringify({workspace_id:'main_workspace',log_id:'1',payload:{trips:1}})},
    {sequence:'2',table_name:'tabel_records',action:'upsert',
    row_key_json:JSON.stringify({workspace_id:'main_workspace',record_id:'x'}),
    row_data_json:JSON.stringify({payload:{hours:12,precise:'9223372036854775807'}})},
    {sequence:'3',table_name:'line_logs',action:'delete',
    row_key_json:JSON.stringify({workspace_id:'main_workspace',log_id:'removed'}),
    row_data_json:null}
  ];
  const sql=async(query,args=[])=>{
    if(query.includes('current_database()'))return {rows:[{name:'samosval_test'}]};
    if(query.includes('SELECT sequence::text AS sequence,hash FROM reserve_replica_receipt'))
      return {rows:receipt?[{...receipt,sequence:String(receipt.sequence)}]:[],rowCount:receipt?1:0};
    if(query.includes('FROM reserve_replica_outbox'))return {
      rows:rows.filter(x=>Number(x.sequence)>args[0]).slice(0,args[1])};
    if(query.includes('UPDATE reserve_replica_receipt')){
      attempts++;
      if(!receipt||receipt.sequence!==args[2]||receipt.hash!==args[3])
        return {rowCount:0,rows:[]};
      receipt={sequence:args[0],hash:args[1]};
      return {rowCount:1,rows:[{...receipt,sequence:String(receipt.sequence)}]};
    }
    throw Error('unexpected SQL: '+query);
  };
  const pool={query:sql,connect:async()=>({query:sql,release(){}})};
  const docs=new Map();
  const firestore={projectId:'samosval-offline',doc:path=>({
    create:async data=>{if(docs.has(path))throw Object.assign(Error('exists'),{code:6});
      docs.set(path,structuredClone(data));},
    get:async()=>({exists:docs.has(path),data:()=>structuredClone(docs.get(path))})
  })};
  const worker=createReserveMinuteWorker({pool,firestore,verifyCheckpoint:async()=>true,
    now:()=>100000});
  return {worker,docs,attempts:()=>attempts,receipt:()=>receipt,rows};
}
test('real composition writes one immutable Firestore document for line + tabel + delete and persists NAS CAS',async()=>{
  const f=fixture(),result=await f.worker.poll();
  assert.equal(result.status,'replicated');
  assert.equal(result.writes,1);
  assert.equal(result.events,3);
  assert.equal(result.receipt.sequence,3);
  assert.equal(f.docs.size,1);
  assert.equal(f.attempts(),1);
  const doc=[...f.docs.values()][0];
  assert.equal(doc.events[1].table,'tabel_records');
  assert.match(doc.events[1].row.postgresJson,/9223372036854775807/);
  assert.equal(doc.events[2].action,'delete');
  assert.equal(doc.events[2].row,null);
  assert.equal((await f.worker.poll({force:true})).status,'unchanged');
  assert.equal(f.docs.size,1,'quiet minute must not add a Firestore document');
});
test('missing verified initial receipt blocks upload and never creates Firestore documents',async()=>{
 const f=fixture({bootstrapped:false});
 await assert.rejects(f.worker.poll(),/invalid-durable-replica-receipt/);
 assert.equal(f.docs.size,0);
 assert.equal(f.attempts(),0);
});
