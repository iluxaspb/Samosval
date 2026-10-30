import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMinuteReserveBatch} from '../src/reserve-minute-replication.mjs';
import {createMinuteFirestoreStore} from '../src/reserve-minute-firestore.mjs';
const prior={sequence:0,hash:'a'.repeat(64)};
const row={sequence:1,operationId:'load1',rowId:'lineLog1',table:'line_logs',
  action:'upsert',row:{id:'lineLog1'},projectId:'samosval-offline',workspaceId:'main_workspace'};
test('Firestore writes exactly one immutable document and retries without doubling it',async()=>{
  const saved=new Map(),writes=[];
  const db={projectId:'samosval-offline',doc:path=>({
    create:async value=>{writes.push(path);if(saved.has(path))throw Object.assign(Error('exists'),{code:6});saved.set(path,structuredClone(value));},
    get:async()=>({exists:saved.has(path),data:()=>saved.get(path)})
  })};
  const store=createMinuteFirestoreStore({firestore:db});
  const batch=buildMinuteReserveBatch({previous:prior,events:[row]});
  await store.putImmutable(batch);
  assert.deepEqual(await store.readBack(batch.batchId),batch.document);
  await store.putImmutable(batch);
  assert.equal(saved.size,1);
  assert.equal(writes.length,2,'second create-only attempt safely detects existing content');
});
test('adapter refuses foreign Firebase project and invalid packet',async()=>{
  assert.throws(()=>createMinuteFirestoreStore({firestore:{projectId:'production',doc(){}}}),/test-firestore/);
  const db={projectId:'samosval-offline',doc(){throw Error('must-not-run');}};
  await assert.rejects(createMinuteFirestoreStore({firestore:db}).putImmutable({batchId:'bad'}),/invalid-minute-batch/);
});
