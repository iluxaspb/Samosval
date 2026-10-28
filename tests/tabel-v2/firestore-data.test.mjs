import test from 'node:test';
import assert from 'node:assert/strict';
import {firestoreData,firestoreRemote} from '../../test-app/tabel-v2/store.mjs';
test('undefined optional fields omitted recursively, null/zero/false and array positions preserved',()=>{
 const source={name:'Объект',optional:undefined,equipment:[{hours:12,pump:false,plate:undefined},undefined],zero:0,empty:null};
 assert.deepEqual(firestoreData(source),{name:'Объект',equipment:[{hours:12,pump:false},null],zero:0,empty:null});assert(Object.hasOwn(source,'optional'));
});
test('existing queued config retries with sanitized data in both record and receipt, no mutation',async()=>{
 const written=[];const host={session:()=>({uid:'qa'}),workspace:{collection:name=>({doc:id=>({name,id})})},transaction:async fn=>fn({get:async()=>({exists:false}),set:(ref,data)=>{assert.equal(JSON.stringify(data).includes('undefined'),false);assert.deepEqual(firestoreData(data),data);written.push(data);}})};
 const remote=firestoreRemote(host,()=>{}),job={id:'op',key:'site/config',before:{revision:0,data:null},data:{equipment:[{name:'W205',plate:undefined}],optional:undefined}};
 const result=await remote.commit(job);assert.equal(result.authorName,'qa');assert.equal(written.length,2);assert.deepEqual(written[0].data,{equipment:[{name:'W205'}]});assert(Object.hasOwn(job.data,'optional'));assert.deepEqual(written[1].after,written[0]);
});
