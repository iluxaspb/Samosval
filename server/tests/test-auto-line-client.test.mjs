import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestAutoLineClient,AutoLineError} from '../../test-app/synology/auto-line-client.mjs';

const NOW=1900000005000;
const base='https://reserve.samosval-offline.run.app';
const head=(owner='synology',patch={})=>({
  format:'samosval-owner-status',version:1,projectId:'samosval-offline',
  owner,epoch:owner==='firebase'?12:11,generation:'0123456789abcdef01234567',
  confirmedSequence:19,reserveSequence:owner==='firebase'?2:0,
  readyForFailover:owner==='firebase',checkedAt:NOW,...patch
});
const session=(source='synology')=>({format:'samosval-session',version:1,
  source,workspaceId:'main_workspace',identityReady:true,
  profile:{uid:'user1',status:'active',deleted:false,role:'lopater'},
  permissions:{tabs:['line'],actions:['action_load']}});
const line=(source='synology')=>({format:'samosval-line-snapshot',version:1,
  source,workspaceId:'main_workspace',cycleMinutes:15,
  shift:{id:'shift1',isActive:true},trucks:[{id:'truck1'}],
  statuses:[{id:'truck1',shiftId:'shift1'}],logs:[]});
const op={id:'stable_1',type:'load',truckId:'truck1',shiftId:'shift1',
  createdAt:NOW,expectedRevision:1,arrivalTimestamp:NOW-10000};
const receipt={outcome:'confirmed',status:{id:'truck1',cycleRevision:2}};
const reply=(value,status=200)=>({status,ok:status>=200&&status<300,
  headers:{get:()=> 'application/json; charset=utf-8'},
  json:async()=>structuredClone(value)});
function setup({owner='synology',ownerStatuses,routeFail,authFail=false}={}){
 const calls=[],nasCalls=[],tokens=[];
 const nas={
  uid:'user1',scope:'nas-scope',workspaceId:'main_workspace',
  readSession:async()=>{nasCalls.push('readSession');return session();},
  readLine:async()=>{nasCalls.push('readLine');return line();},
  submitLine:async(v,o)=>{nasCalls.push({method:'submitLine',v,o});return routeFail?
    Promise.reject(Object.assign(Error('nas-offline'),{retryable:true,uncertain:true})):receipt;},
  readSettings:async()=>{nasCalls.push('readSettings');return {ok:true};},
  submitSettings:async()=>{nasCalls.push('submitSettings');return {ok:true};},
  stop:()=>{nasCalls.push('stop');}
 };
 const user={uid:'user1',getIdToken:async(force)=>{tokens.push(force);if(authFail)throw Error('auth');return 'private-token';}};
 let active=user,idx=0;
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  const path=new URL(url).pathname;
  if(path==='/api/v1/owner/status'){
    const item=ownerStatuses?.[Math.min(idx++,ownerStatuses.length-1)]??head(owner);
    return item instanceof Error?Promise.reject(item):reply(item);
  }
  if(path==='/api/v1/session')return reply(session('firebase'));
  if(path==='/api/v1/line/snapshot')return reply(line('firebase'));
  if(path==='/api/v1/line/operations')return reply(receipt);
  throw Error('unexpected-path:'+path);
 };
 const create=()=>createTestAutoLineClient({nasClient:nas,reserveBaseUrl:base,
  getUser:()=>active,fetchImpl,clock:()=>NOW});
 return {create,calls,nasCalls,tokens,changeUser:()=>{active={...user};},nas};
}
test('NAS remains owner until authority says otherwise; timeout alone never promotes',async()=>{
 const h=setup({routeFail:true}),client=h.create();
 await assert.rejects(client.submitLine(op,{operationScope:client.scope}),e=>e.uncertain===true);
 assert.equal(h.nasCalls.filter(x=>x.method==='submitLine').length,1);
 assert.deepEqual(h.calls.map(x=>new URL(x.url).pathname),['/api/v1/owner/status']);
 assert.equal(client.activeProvider,null);
 client.stop();
});
test('verified Firebase owner redirects line reads and signed writes, preserving operation ID',async()=>{
 const h=setup({owner:'firebase'}),client=h.create();
 assert.deepEqual(await client.readSession(),session('firebase'));
 assert.deepEqual(await client.readLine(),line('firebase'));
 assert.deepEqual(await client.submitLine(op,{operationScope:client.scope}),receipt);
 assert.equal(client.activeProvider,'firebase');
 const write=h.calls.find(x=>x.options.method==='POST');
 assert.equal(write.url,base+'/api/v1/line/operations');
 assert.equal(write.options.headers['X-Samosval-Writer-Epoch'],'12');
 assert.equal(write.options.headers.Authorization,'Bearer private-token');
 assert.equal(write.options.credentials,'omit');
 assert.equal(write.options.referrerPolicy,'no-referrer');
 assert.deepEqual(JSON.parse(write.options.body),op);
 assert.equal(h.nasCalls.length,0);
 client.stop();
});
test('handoff and reconciling never write to either provider',async()=>{
 for(const owner of ['handoff','reconciling']){
  const h=setup({owner}),client=h.create();
  await assert.rejects(client.submitLine(op,{operationScope:client.scope}),e=>
    e.code==='writer-handoff-in-progress'&&e.retryable);
  assert.equal(h.nasCalls.length,0);
  client.stop();
 }
});
test('stale, malformed, or incomplete owner status fails closed',async()=>{
 for(const status of [
  head('firebase',{checkedAt:NOW-90000}),
  head('firebase',{projectId:'production'}),
  head('firebase',{generation:'wrong'}),
  head('firebase',{readyForFailover:false}),
  head('synology',{readyForFailover:true})
 ]){
  const h=setup({ownerStatuses:[status]}),client=h.create();
  await assert.rejects(client.submitLine(op,{operationScope:client.scope}),
    e=>e instanceof AutoLineError&&e.retryable);
  assert.equal(h.nasCalls.length,0);
  client.stop();
 }
});
test('reserve control unavailable keeps intent pending; does not fall back to NAS',async()=>{
 const h=setup({ownerStatuses:[new Error('network-down')]}),client=h.create();
 await assert.rejects(client.submitLine(op,{operationScope:client.scope}),
  e=>e.code==='reserve-unreachable'&&e.retryable&&!e.uncertain);
 assert.equal(h.nasCalls.length,0);
 client.stop();
});
test('wrong outbox scope and changed user reject before network I/O',async()=>{
 const h=setup({owner:'firebase'}),client=h.create();
 await assert.rejects(client.submitLine(op,{operationScope:'another'}),{code:'outbox-scope-mismatch'});
 h.changeUser();
 await assert.rejects(client.readLine(),{code:'session-changed'});
 assert.equal(h.calls.length,0);
 client.stop();
});
test('when reserve owns writes, unrelated tab and admin APIs cannot write stale NAS',async()=>{
 const h=setup({owner:'firebase'}),client=h.create();
 await assert.rejects(client.readSettings(),{code:'reserve-unsupported-operation'});
 await assert.rejects(client.submitSettings({id:'x'}),{code:'reserve-unsupported-operation'});
 assert.equal(h.nasCalls.length,0);
 client.stop();
});
test('owner change between session and line read discards mixed-source snapshot',async()=>{
 const h=setup({ownerStatuses:[head('synology'),head('firebase')]}),client=h.create();
 let sessionCount=0,snapshotCount=0;
 const outcome=await new Promise(resolve=>{
  const close=client.subscribeLine({intervalMs:1000,
   onSession:()=>sessionCount++,onSnapshot:()=>snapshotCount++,
   onError:e=>{close();resolve(e);}});
 });
 assert.equal(outcome.code,'writer-changed-during-read');
 assert.equal(sessionCount,0);
 assert.equal(snapshotCount,0);
 client.stop();
});
test('invalid reserve HTTP payload after write is uncertain, so queue retries same ID',async()=>{
 const h=setup({owner:'firebase'}),client=h.create(),original=h.nas;
 // Inject a different server response without mutating the persistent operation.
 const unsupported={id:'new_',type:'load',truckId:'truck1'};
 await assert.rejects(client.submitLine(unsupported,{operationScope:'wrong'}),{code:'outbox-scope-mismatch'});
 await assert.rejects(client.submitLine({id:'new_',type:'close'},{operationScope:client.scope}),{code:'invalid-line-operation'});
 assert.equal(h.calls.length,0);
 client.stop();assert.equal(h.nasCalls.at(-1),'stop');
});
test('rejects credentialed and non-HTTPS reserve endpoints',()=>{
 const h=setup();
 for(const reserveBaseUrl of ['http://reserve.invalid','https://user:pw@reserve.invalid/',
  'https://reserve.invalid/path','https://reserve.invalid/?key=secret','not-url']){
  assert.throws(()=>createTestAutoLineClient({nasClient:h.nas,reserveBaseUrl,getUser:()=>({uid:'user1',getIdToken:async()=>''})}),TypeError);
 }
});
