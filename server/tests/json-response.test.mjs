import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {sendJson} from '../src/json-response.mjs';
import {createNasClient} from '../../test-app/synology/session-client.mjs';
const hash='"'+'a'.repeat(64)+'"';
const snapshot={format:'samosval-session',version:1,source:'synology',workspaceId:'main_workspace',identityReady:true,profile:{uid:'one',role:'admin',status:'active',deleted:false},permissions:{tabs:[],actions:[]}};
async function endpoint(t){
  let data={value:1},authorized=true,checks=0;
  const server=http.createServer((req,res)=>{checks++;if(!authorized)return sendJson(res,403,{error:'forbidden'});sendJson(res,200,data);});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {url:'http://127.0.0.1:'+server.address().port+'/api/v1/test',change:x=>{data=x;},revoke:()=>{authorized=false;},checks:()=>checks};
}
test('unchanged authorized GET returns an empty 304; changed bytes always get a new tag and body',async t=>{
  const h=await endpoint(t);let response=await fetch(h.url);const tag=response.headers.get('etag');assert.match(tag,/^"[a-f0-9]{64}"$/);assert.deepEqual(await response.json(),{value:1});
  response=await fetch(h.url,{headers:{'If-None-Match':tag}});assert.equal(response.status,304);assert.equal(await response.text(),'');assert.equal(response.headers.get('cache-control'),'no-store');
  h.change({value:2});response=await fetch(h.url,{headers:{'If-None-Match':tag}});assert.equal(response.status,200);assert.notEqual(response.headers.get('etag'),tag);assert.deepEqual(await response.json(),{value:2});
  assert.equal(h.checks(),3);
});
test('revoked permissions are checked before a conditional response and mutations never get 304',async t=>{
  const h=await endpoint(t);const first=await fetch(h.url),tag=first.headers.get('etag');await first.text();
  const post=await fetch(h.url,{method:'POST',headers:{'If-None-Match':tag}});assert.equal(post.status,200);assert.equal(post.headers.get('etag'),null);await post.text();
  h.revoke();const denied=await fetch(h.url,{headers:{'If-None-Match':tag}});assert.equal(denied.status,403);assert.equal(denied.headers.get('etag'),null);assert.deepEqual(await denied.json(),{error:'forbidden'});
});
test('client uses only validated, private session memory for 304 and caller mutation cannot corrupt it',async()=>{
  const seen=[];let calls=0;
  const owner={uid:'one',getIdToken:async()=> 'private-token'},client=createNasClient({getUser:()=>owner,fetchImpl:async(_url,options)=>{
    seen.push(options.headers);if(calls++)return {status:304,ok:false,headers:{get:()=>null},json:async()=>{throw Error('304 has no body');}};
    return {status:200,ok:true,headers:{get:name=>name==='ETag'?hash:'application/json'},json:async()=>structuredClone(snapshot)};
  }});
  const first=await client.readSession();first.permissions.tabs.push('fake');const second=await client.readSession();
  assert.equal(seen[0]['If-None-Match'],undefined);assert.equal(seen[1]['If-None-Match'],hash);assert.deepEqual(second.permissions.tabs,[]);assert.notEqual(first,second);client.stop();
});
test('304 without a validated snapshot fails closed; another signed-in session never inherits a validator',async()=>{
  const owner={uid:'one',getIdToken:async()=> 'token'},seen=[];
  const client=createNasClient({getUser:()=>owner,fetchImpl:async(_url,options)=>{seen.push(options.headers);return {status:304,ok:false,headers:{get:()=>null}};}});
  await assert.rejects(client.readSession(),e=>e.code==='invalid-api-response'&&e.problem==='unexpected-not-modified');assert.equal(seen[0]['If-None-Match'],undefined);client.stop();
});
