import test from 'node:test';
import assert from 'node:assert/strict';
import {createNasClient} from '../../test-app/synology/session-client.mjs';
const reply=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(body)});
const profile={uid:'one',status:'active',role:'admin',deleted:false};
const session=()=>({format:'samosval-session',version:1,source:'synology',workspaceId:'main_workspace',identityReady:true,profile:{...profile},permissions:{tabs:['line'],actions:[]}});
const line=()=>({format:'samosval-line-snapshot',version:1,source:'synology',workspaceId:'main_workspace',cycleMinutes:15,shift:{id:'shift',isActive:true},trucks:[{id:'truck'}],statuses:[{id:'truck',shiftId:'shift',onLine:true}],logs:[{id:'log',truckId:'truck',shiftId:'shift',timestamp:2},{id:'earlier',truckId:'truck',shiftId:'shift',timestamp:1}]});
const op=()=>({id:'stable',type:'load',truckId:'truck',shiftId:'shift',createdAt:1000});
function fixture(fetchImpl,options={}){
  let user={uid:'one',getIdToken:async()=> 'private-token'};
  const getUser=()=>user,client=createNasClient({getUser,fetchImpl,...options});
  return {client,setUser:value=>{user=value;},getUser};
}

test('NAS snapshots retain server ordering; GET transport sends no cookies or referrer',async()=>{
  const seen=[];const {client}=fixture(async(url,options)=>{seen.push({url,options});return reply(line());});
  assert.deepEqual(await client.readLine(),line());
  const {url,options}=seen[0];assert.equal(url,'https://iluxa.synology.me:18443/api/v1/line/snapshot');
  assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.method,'GET');assert.equal('body' in options,false);
});
test('NAS configuration rejects insecure endpoints, credentials, path and query injection',()=>{
  for(const baseUrl of ['http://nas.test','https://user:secret@nas.test','https://nas.test/path','https://nas.test/?token=secret','https://nas.test/#fragment','bad'])assert.throws(()=>createNasClient({baseUrl,getUser:()=>({uid:'one',getIdToken(){}})}),/invalid-api-url/);
});
test('NAS scopes distinguish UID, workspace and endpoint, and reject old Firebase outboxes before any I/O',async()=>{
  let calls=0;const {client}=fixture(async()=>{calls++;return reply({outcome:'confirmed',status:{}});});
  for(const operationScope of [undefined,'firebase','',JSON.stringify(['synology','https://other.test','main_workspace','one']),JSON.stringify(['synology','https://iluxa.synology.me:18443','main_workspace','other'])])await assert.rejects(client.submitLine(op(),{operationScope}),{code:'outbox-scope-mismatch'});
  assert.equal(calls,0);
  await client.submitLine(op(),{operationScope:client.scope});assert.equal(calls,1);
});
test('NAS 401 refreshes token once and preserves captured write bytes despite caller mutation',async()=>{
  const tokens=[],bodies=[];const operation=op();let n=0;
  const owner={uid:'one',getIdToken:async force=>{tokens.push(force);operation.id='changed';return 'token-'+force;}};
  const client=createNasClient({getUser:()=>owner,fetchImpl:async(_url,options)=>{bodies.push(options.body);return ++n===1?reply({},401):reply({outcome:'confirmed',status:{onLine:true}});}});
  await client.submitLine(operation,{operationScope:client.scope});
  assert.deepEqual(tokens,[false,true]);assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.equal(JSON.parse(bodies[0]).id,'stable');
});
test('NAS repeated 401 is bounded; HTTP errors expose no server body or token',async()=>{
  let calls=0;const {client}=fixture(async()=>{calls++;return reply({error:'private-token'},401);});
  await assert.rejects(client.readSession(),e=>e.code==='api-http-401'&&!e.message.includes('private-token')&&!e.retryable);assert.equal(calls,2);
});
test('NAS account replacement during token refresh prevents transmission',async()=>{
  let calls=0,user;
  const old={uid:'one',getIdToken:async()=>{user={uid:'two',getIdToken:async()=> 'new'};return 'old';}};user=old;
  const client=createNasClient({getUser:()=>user,fetchImpl:async()=>{calls++;return reply(line());}});
  await assert.rejects(client.readLine(),{code:'session-changed'});assert.equal(calls,0);
});
test('NAS same-UID re-login invalidates a previous session and discards delayed JSON',async()=>{
  let release;
  const f=fixture(async()=>({ok:true,status:200,json:()=>new Promise(resolve=>{release=resolve;})}));
  const pending=f.client.readLine();while(!release)await new Promise(resolve=>setImmediate(resolve));
  f.setUser({uid:'one',getIdToken:async()=> 'replacement'});release(line());
  await assert.rejects(pending,{code:'session-changed'});
});
test('NAS stop cancels in-flight reads even when fetch ignores AbortSignal',async()=>{
  const {client}=fixture(()=>new Promise(()=>{}),{timeoutMs:1000});
  const pending=client.readLine();client.stop();await assert.rejects(pending,{code:'session-changed'});
});
test('NAS timeout also covers a stalled token provider',async()=>{
  const user={uid:'one',getIdToken:()=>new Promise(()=>{})};
  const client=createNasClient({getUser:()=>user,timeoutMs:5,fetchImpl:()=>{throw Error('must not send');}});
  await assert.rejects(client.readSession(),{code:'api-timeout',retryable:true,uncertain:false});
});
test('NAS writes retain unknown outcomes on dropped reply, malformed receipt and gateway errors',async()=>{
  for(const fetchImpl of [async()=>{throw Error('private-token');},async()=>reply({outcome:'maybe'}),async()=>reply({},503)]){
    const {client}=fixture(fetchImpl);await assert.rejects(client.submitLine(op(),{operationScope:client.scope}),e=>e.retryable&&e.uncertain&&!e.message.includes('private-token'));
  }
});
test('NAS confirmed business rejection is a receipt rather than a network retry',async()=>{
  const {client}=fixture(async()=>reply({outcome:'rejected',reason:'cycle-time'}));
  assert.deepEqual(await client.submitLine(op(),{operationScope:client.scope}),{outcome:'rejected',reason:'cycle-time'});
});
test('NAS session validates account and source; pending profiles remain observable',async()=>{
  for(const change of [x=>x.profile.uid='other',x=>x.source='firebase',x=>x.workspaceId='other',x=>x.permissions.tabs=null]){
    const value=session();change(value);const {client}=fixture(async()=>reply(value));await assert.rejects(client.readSession(),{code:'invalid-api-response'});
  }
  const value=session();value.profile.status='pending';const {client}=fixture(async()=>reply(value));assert.equal((await client.readSession()).profile.status,'pending');
});
test('NAS line rejects foreign source, duplicate rows, cross-shift records and impossible empty shifts',async()=>{
  for(const change of [x=>x.source='firebase',x=>x.workspaceId='other',x=>x.trucks.push(x.trucks[0]),x=>x.logs[0].shiftId='foreign',x=>x.statuses[0].shiftId='foreign',x=>x.cycleMinutes=0,x=>x.shift=null]){
    const value=line();change(value);const {client}=fixture(async()=>reply(value));await assert.rejects(client.readLine(),{code:'invalid-api-response'});
  }
});
test('NAS archive preserves saved layout and log order without rebuilding it',async()=>{
  const saved={format:'samosval-archive-snapshot',version:1,source:'synology',workspaceId:'main_workspace',importedAt:1000,archives:[{id:'archive',paper:{heights:[20,31]},logs:[{timestamp:2},{timestamp:1}]}],trash:[]};
  const {client}=fixture(async()=>reply(saved));assert.deepEqual(await client.readArchive(),saved);
});
test('NAS history writes bind confirmation to requested action and direction',async()=>{
  const operation={id:'undo',actionId:'load',direction:'undo',expectedRevision:1};
  for(const change of [x=>x.actionId='other',x=>x.direction='redo',x=>x.revision=1]){
    const value={outcome:'confirmed',actionId:'load',direction:'undo',revision:2,status:{}};change(value);
    const {client}=fixture(async()=>reply(value));await assert.rejects(client.submitHistory(operation,{operationScope:client.scope}),{code:'invalid-api-response',uncertain:true});
  }
});
test('NAS polling checks session first and publishes revoked access without requesting line',async()=>{
  const calls=[];let close;
  const value=session();value.profile.status='disabled';
  const {client}=fixture(async url=>{calls.push(url);return reply(value);});
  await new Promise((resolve,reject)=>{close=client.subscribeLine({onSession:s=>{assert.equal(s.profile.status,'disabled');queueMicrotask(()=>{close();resolve();});},onSnapshot:()=>reject(Error('disabled account read line')),onError:reject});});
  assert.deepEqual(calls,['https://iluxa.synology.me:18443/api/v1/session']);client.stop();
});
test('NAS unsubscribe suppresses callbacks from an already in-flight response',async()=>{
  let release,calls=0;
  const {client}=fixture(()=>new Promise(resolve=>{release=resolve;}));
  const close=client.subscribeLine({onSession:()=>calls++,onSnapshot:()=>calls++,onError:()=>calls++});
  while(!release)await new Promise(resolve=>setImmediate(resolve));close();release(reply(session()));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);client.stop();
});
test('NAS registration sends nickname only and rejects another UID in the result',async()=>{
  let body;const {client}=fixture(async(_url,options)=>{body=JSON.parse(options.body);return reply({created:true,profile:{uid:'one',status:'pending'}});});
  await client.registerPending({nickname:'Operator',role:'admin',uid:'foreign'});assert.deepEqual(body,{nickname:'Operator'});
  const other=fixture(async()=>reply({created:true,profile:{uid:'foreign',status:'pending'}}));await assert.rejects(other.client.registerPending(),{code:'invalid-api-response',uncertain:true});
});
test('NAS admin confirmation is bound to operation and target user',async()=>{
  for(const value of [{outcome:'confirmed',operationId:'different',result:{uid:'target'}},{outcome:'confirmed',operationId:'same',result:{uid:'foreign'}}]){
    const {client}=fixture(async()=>reply(value));await assert.rejects(client.submitAdministration({id:'same',type:'user.role',uid:'target',role:'viewer',expectedRevision:1},{operationScope:client.scope}),{code:'invalid-api-response',uncertain:true});
  }
});
test('NAS admin snapshot validates profile revisions and preserves pending request identity',async()=>{
  const snapshot={format:'samosval-admin-access',version:1,source:'synology',users:[{uid:'one',revision:1}],deletedUsers:[],requests:[{uid:'one',revision:0}],permissions:{viewer:{tabs:['line'],actions:[],revision:1}}};
  const {client}=fixture(async()=>reply(snapshot));assert.deepEqual(await client.readAdministration(),snapshot);
  snapshot.users[0].revision=-1;await assert.rejects(client.readAdministration(),{code:'invalid-api-response'});
});
