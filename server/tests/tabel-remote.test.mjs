import test from 'node:test';
import assert from 'node:assert/strict';
import {createTabelRemote} from '../../test-app/synology/tabel-remote.mjs';
const baseUrl='https://nas.example.test:18443';
const response=(value,status=200)=>({ok:status===200,status,json:async()=>value});
const job={id:'op1',key:'site/config',data:{value:12},before:{revision:0,data:null},label:'TEST'};
const record={revision:1,data:job.data,operationId:job.id,key:job.key};
test('NAS table retries 401 once with exactly the same bytes and operation ID',async()=>{
  const calls=[],tokens=[];
  const remote=createTabelRemote({baseUrl,getIdToken:async force=>{tokens.push(force);return force?'new':'old';},fetchImpl:async(url,options)=>{calls.push(options);job.data.value=99;return calls.length===1?response({},401):response(record);}});
  const original=structuredClone(job);await remote.commit(original);
  assert.deepEqual(tokens,[false,true]);assert.equal(calls[0].body,calls[1].body);
  assert.equal(JSON.parse(calls[1].body).data.value,12);
});
test('lost reply leaves same-ID replay to the durable Store, without Firebase fallback',async()=>{
  let failed=true;const bodies=[];
  const remote=createTabelRemote({baseUrl,getIdToken:async()=> 'token',fetchImpl:async(url,options)=>{bodies.push(options.body);if(failed){failed=false;throw Error('connection lost');}return response(record);}});
  const stable={...job,data:{value:12}};await assert.rejects(remote.commit(stable));
  assert.equal((await remote.commit(stable)).operationId,stable.id);assert.equal(bodies[0],bodies[1]);
});
test('NAS table follows pages and rejects loops or unrelated object records',async()=>{
  let n=0;
  const remote=createTabelRemote({baseUrl,getIdToken:async()=> 'token',fetchImpl:async()=>response(++n===1?{rows:[['site/config',record]],cursor:'first'}:{rows:[],cursor:null})});
  assert.equal((await remote.list('site')).length,1);assert.equal(n,2);
  const loop=createTabelRemote({baseUrl,getIdToken:async()=> 'token',fetchImpl:async()=>response({rows:[],cursor:'same'})});
  await assert.rejects(loop.list('site'),/страница/);
  const wrong=createTabelRemote({baseUrl,getIdToken:async()=> 'token',fetchImpl:async()=>response({rows:[['other/config',record]],cursor:null})});
  await assert.rejects(wrong.list('site'),/список/);
});
test('expired guards, HTTP denials, malformed confirmations and insecure URLs fail closed',async()=>{
  for(const baseUrl of ['http://nas.test','https://user:secret@nas.test','https://nas.test?token=x'])assert.throws(()=>createTabelRemote({baseUrl,getIdToken:async()=> 'token'}));
  for(const result of [response({},403),response({ok:true}),response({...record,operationId:'wrong'})]) {
    const remote=createTabelRemote({baseUrl,getIdToken:async()=> 'token',fetchImpl:async()=>result});
    await assert.rejects(remote.commit({...job,data:{value:12}}));
  }
  let accessed=false;
  const remote=createTabelRemote({baseUrl,guard:()=>{throw Error('session changed');},getIdToken:async()=>{accessed=true;return 'token';}});
  await assert.rejects(remote.read('site/config'),/session changed/);assert.equal(accessed,false);
});
