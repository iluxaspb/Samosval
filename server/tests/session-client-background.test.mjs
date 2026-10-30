import test from 'node:test';
import assert from 'node:assert/strict';
import {createNasClient} from '../../test-app/synology/session-client.mjs';
const envelope=format=>({format,version:1,source:'synology',workspaceId:'main_workspace'});
const bodies={
  '/api/v1/games':{...envelope('samosval-games'),records:[],adjustments:[],head:{gameRound:0,bank:1000},players:{}},
  '/api/v1/auxiliary':{...envelope('samosval-auxiliary'),plugins:[],patches:[],audit:[],notifications:[]},
  '/api/v1/archive/snapshot':{...envelope('samosval-archive-snapshot'),importedAt:1000,archives:[],trash:[]},
  '/api/v1/session':{...envelope('samosval-session'),identityReady:true,profile:{uid:'one',role:'admin',status:'active',deleted:false},permissions:{tabs:['line'],actions:[]}},
};
const reply=body=>({ok:true,status:200,headers:{get:name=>name==='Content-Type'?'application/json; charset=utf-8':null},json:async()=>body});
const user={uid:'one',getIdToken:async()=> 'private-token'};
const drain=()=>new Promise(resolve=>setImmediate(resolve));
test('heavy startup reads are serialized and coalesced while session and mutations can still complete',async()=>{
  const calls=[],pending=new Map();let busy=0,peak=0;
  const client=createNasClient({getUser:()=>user,fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname;calls.push(path);
    if(path==='/api/v1/session')return reply(bodies[path]);
    if(options.method==='POST')return reply({outcome:'confirmed',status:{onLine:true}});
    busy++;peak=Math.max(peak,busy);
    await new Promise(resolve=>pending.set(path,resolve));busy--;return reply(bodies[path]);
  }});
  const game=client.readGames(),aux=client.readAuxiliary(),archive=client.readArchive(),same=client.readGames();
  assert.equal(game,same);await drain();assert.deepEqual(calls,['/api/v1/games']);
  await client.readSession();
  await client.submitLine({id:'stable',type:'load'},{operationScope:client.scope});
  assert.deepEqual(calls,['/api/v1/games','/api/v1/session','/api/v1/line/operations']);
  pending.get('/api/v1/games')();await game;await drain();assert.ok(pending.has('/api/v1/auxiliary'));
  pending.get('/api/v1/auxiliary')();await aux;await drain();pending.get('/api/v1/archive/snapshot')();await archive;
  assert.equal(peak,1);assert.equal(calls.filter(x=>x==='/api/v1/games').length,1);client.stop();
});
test('queue wait does not consume the next historical read network deadline',async()=>{
  const client=createNasClient({getUser:()=>user,timeoutMs:35,fetchImpl:async url=>{
    await new Promise(resolve=>setTimeout(resolve,20));return reply(bodies[new URL(url).pathname]);
  }});
  const results=await Promise.all([client.readGames(),client.readAuxiliary(),client.readArchive()]);
  assert.equal(results.length,3);client.stop();
});
test('stopping or changing account cancels queued reads before credentials or HTTP transmission',async()=>{
  for(const stop of [true,false]){
    let current=user,calls=0,release;const client=createNasClient({getUser:()=>current,fetchImpl:()=>{calls++;return new Promise(resolve=>{release=resolve;});}});
    const games=client.readGames(),aux=client.readAuxiliary(),archive=client.readArchive();
    const checked=Promise.all([games,aux,archive].map(p=>assert.rejects(p,{code:'session-changed'})));
    await drain();if(stop)client.stop();else current={...user};release(reply(bodies['/api/v1/games']));
    await checked;assert.equal(calls,1);client.stop();
  }
});
test('a failed historical section releases the lane and a later refresh can retry',async()=>{
  let games=0;const calls=[],client=createNasClient({getUser:()=>user,fetchImpl:async url=>{
    const path=new URL(url).pathname;calls.push(path);if(path==='/api/v1/games'&&!games++)throw TypeError('Failed to fetch');return reply(bodies[path]);
  }});
  const failed=assert.rejects(client.readGames(),{code:'api-unreachable'}),aux=client.readAuxiliary();await failed;await aux;await client.readGames();
  assert.deepEqual(calls,['/api/v1/games','/api/v1/auxiliary','/api/v1/games']);client.stop();
});
test('HTML gateway, broken JSON and foreign schemas have safe distinct diagnostics without leaking bodies',async()=>{
  for(const [problem,response] of [
    ['unexpected-content-type',{...reply({}),headers:{get:name=>name==='Content-Type'?'text/html; charset=utf-8':null},json:async()=>{throw Error('must not read private body');}}],
    ['invalid-json',{...reply({}),json:async()=>{throw Error('private backend token');}}],
    ['invalid-envelope',reply({...bodies['/api/v1/session'],workspaceId:'production'})],
  ]){
    const client=createNasClient({getUser:()=>user,fetchImpl:async()=>response});
    await assert.rejects(client.readSession(),e=>e.code==='invalid-api-response'&&e.problem===problem&&e.status===200&&e.retryable&&!e.uncertain&&
      !/private|production|token|Bearer/.test(e.message));client.stop();
  }
});
test('timeout diagnostic distinguishes stalled credentials from response body; write remains uncertain',async()=>{
  for(const [phase,owner,fetchImpl] of [
    ['credentials',{uid:'one',getIdToken:()=>new Promise(()=>{})},()=>{throw Error('must not send');}],
    ['response-body',user,async()=>({...reply({}),json:()=>new Promise(()=>{})})],
  ]){
    const client=createNasClient({getUser:()=>owner,fetchImpl,timeoutMs:5});
    await assert.rejects(client.submitLine({id:'same',type:'load'},{operationScope:client.scope}),e=>e.code==='api-timeout'&&e.phase===phase&&e.uncertain);
    client.stop();
  }
});
