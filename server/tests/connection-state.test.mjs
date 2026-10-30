import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectionView,modeAvailability,checkSynology} from '../../test-app/synology/connection-state.mjs';

test('the badge reports the business backend, with no S from a health check or authentication',()=>{
  const s={backend:'firebase',online:true,syncState:'ok',signedIn:true};
  assert.equal(connectionView(s).letter,'F');
  assert.equal(connectionView({...s,backend:'synology'}).letter,'S');
  assert.equal(connectionView({...s,syncState:'syncing'}).letter,'F');
  assert.equal(connectionView({...s,syncState:'init'}).letter,'…');
  assert.equal(connectionView({...s,online:false}).letter,'О');
  assert.equal(connectionView({...s,syncState:'offline'}).letter,'О');
  assert.equal(connectionView({...s,signedIn:false}).letter,'О');
  assert.equal(connectionView({...s,backend:'unexpected'}).source,'checking');
});
test('incomplete adapters and unverified replication cannot be selected',()=>{
  assert.equal(modeAvailability('firebase'),null);
  assert.match(modeAvailability('synology'),/всех экранов/);
  assert.match(modeAvailability('auto',{clientReady:true}),/резерва/);
  assert.equal(modeAvailability('auto',{clientReady:true,replicaReady:true}),null);
  assert.match(modeAvailability('synology',{clientReady:true,pending:1}),/локальных/);
  assert.match(modeAvailability('invalid'),/Неизвестный/);
});
const line={format:'samosval-line-snapshot',version:1,source:'synology',workspaceId:'main_workspace',trucks:[{}],statuses:[],logs:[{volume:24},{volume:25},{volume:99,isGAI:true}]};
const tabel={record:{revision:0,data:null}};
const response=(body,status=200)=>({ok:status===200,status,json:async()=>body});
test('probe checks both protected endpoints and excludes GAI from normal totals',async()=>{
  const calls=[];
  const result=await checkSynology({getIdToken:async()=> 'test-token',fetchImpl:async(url,options)=>{calls.push({url,options});return response(calls.length===1?line:tabel);}});
  assert.deepEqual(result,{trucks:1,logs:3,normal:2,volume:49});
  assert.equal(calls.length,2);
  assert.match(calls[1].url,/tabel\/records\?key=/);
  for(const {url,options} of calls){assert.match(url,/^https:\/\/iluxa\.synology\.me:18443\//);assert.equal(options.method,undefined);assert.equal(options.body,undefined);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer test-token');}
});
test('old line-only API cannot pass a complete connection check',async()=>{
  let count=0;
  await assert.rejects(checkSynology({getIdToken:async()=> 'test',fetchImpl:async()=>++count===1?response(line):response({},404)}),e=>e.status===404);
});
test('one expired token refresh; no credential leak to error message',async()=>{
  const refresh=[];let count=0;
  await checkSynology({getIdToken:async force=>{refresh.push(force);return 'private-test-value';},fetchImpl:async()=>++count===1?response({},401):response(count===2?line:tabel)});
  assert.deepEqual(refresh,[false,true,false]);
  await assert.rejects(checkSynology({getIdToken:async()=> 'private-test-value',fetchImpl:async()=>response({},403)}),e=>e.status===403&&!e.message.includes('private-test-value'));
});
test('repeated authentication failure is bounded',async()=>{
  let count=0;
  await assert.rejects(checkSynology({getIdToken:async()=> 'test',fetchImpl:async()=>{count++;return response({},401);}}),e=>e.status===401);
  assert.equal(count,2);
});
test('malformed or wrong-workspace response is rejected before checking tabel',async()=>{
  for(const body of [{...line,workspaceId:'production'},{...line,source:'firebase'},{...line,logs:null},{...line,version:2}]){
    let count=0;
    await assert.rejects(checkSynology({getIdToken:async()=> 'test',fetchImpl:async()=>{count++;return response(body);}}),/формат/);
    assert.equal(count,1);
  }
});
test('missing or malformed tabel revision is not a ready response',async()=>{
  for(const record of [undefined,{revision:-1,data:null},{revision:1.5,data:{}},{revision:0,data:[]}]){
    let count=0;
    await assert.rejects(checkSynology({getIdToken:async()=> 'test',fetchImpl:async()=>response(++count===1?line:{record})}),/формат/);
  }
});
test('session change prevents requests with the previous account',async()=>{
  let valid=true,count=0;
  await assert.rejects(checkSynology({guard:()=>{if(!valid)throw Error('changed');},getIdToken:async()=>{valid=false;return 'test';},fetchImpl:async()=>{count++;return response(line);}}),/changed/);
  assert.equal(count,0);
});
test('timeout aborts the check without submitting business operations',async()=>{
  await assert.rejects(checkSynology({timeoutMs:5,getIdToken:async()=> 'test',fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Object.assign(Error('timeout'),{name:'AbortError'})),{once:true});})}),e=>e.name==='AbortError');
});
