import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createReserveHttp} from '../src/test-reserve-http.mjs';
import {REPLICA_DOC,rowId,canonical} from '../src/test-replica.mjs';
import {OWNER_DOC} from '../src/test-writer-coordinator.mjs';

class FakeFirestore{
 constructor(){this.docs=new Map();this.tail=Promise.resolve();}
 doc(path){return {path,get:async()=>this.snapshot(path)};}
 snapshot(path){return {exists:this.docs.has(path),data:()=>structuredClone(this.docs.get(path))};}
 collection(path){
  return {where:(field,operator,value)=>({
   get:async()=>({docs:[...this.docs.entries()].filter(([key,row])=>
    key.startsWith(path+'/')&&row[field]===value).map(([key,row])=>
     ({id:key.split('/').at(-1),data:()=>structuredClone(row)}))})
  })};
 }
 async runTransaction(fn){
  const earlier=this.tail;let resume;this.tail=new Promise(resolve=>resume=resolve);await earlier;
  try{
   const ops=[],tx={
    get:async ref=>this.snapshot(ref.path),
    create:(ref,value)=>ops.push(['create',ref.path,value]),
    set:(ref,value)=>ops.push(['set',ref.path,value]),
    update:(ref,value)=>ops.push(['update',ref.path,value])
   };
   const result=await fn(tx);
   for(const [method,path] of ops)if(method==='create'&&this.docs.has(path))throw Error('already-exists');
   for(const [method,path,value] of ops){
    if(method==='update')this.docs.set(path,{...this.docs.get(path),...structuredClone(value)});
    else this.docs.set(path,structuredClone(value));
   }
   return result;
  }finally{resume();}
 }
}
const gen='0123456789abcdef01234567',ws='main_workspace',
 now=1900000005000,truck='truck_foo',shift='shift_foo';
function seed(){
 const db=new FakeFirestore();
 db.docs.set(REPLICA_DOC,{protocol:1,channel:'test',projectId:'samosval-offline',
  generation:gen,hash:'a'.repeat(64),lastSequence:17,readyForFailover:true});
 db.docs.set(OWNER_DOC,{protocol:1,projectId:'samosval-offline',owner:'firebase',
  epoch:4,holder:'firebase_reserve',generation:gen,observedSequence:17,
  leaseUntil:now+60000,reserveSequence:0,pending:{}});
 const put=(table,key,row)=>db.docs.set(REPLICA_DOC+'/rows_'+gen+'/'+rowId(table,key),
  {table,keyJson:canonical(key),rowJson:canonical(row),appliedSequence:17});
 for(const uid of ['tester1','tester2'])put('app_users',{uid},
  {uid,email:uid+'@example.org',display_name:uid,role:'lopater',
   status:'active',revision:1,profile:{deleted:false}});
 for(const action of ['tab_line','action_load']){
  const key={role:'lopater',action};put('role_permissions',key,{...key,allowed:true});
 }
 put('identity_state',{id:1},{id:1,initialized:true});
 put('workspaces',{id:ws},{id:ws,cycle_minutes:15});
 put('shifts',{workspace_id:ws,shift_id:shift},{workspace_id:ws,shift_id:shift,
  is_active:true,payload:{id:shift,objectName:'Тест',objectId:'object1'}});
 put('line_trucks',{workspace_id:ws,truck_id:truck},
  {workspace_id:ws,truck_id:truck,payload:{brand:'КАМАЗ',number:'101',defaultVol:24}});
 put('line_truck_statuses',{workspace_id:ws,truck_id:truck},
  {workspace_id:ws,truck_id:truck,shift_id:shift,payload:{
   id:truck,shiftId:shift,onLine:true,arriveStatus:'12:00',arriveTimestamp:now-1000,
   lastLoadTimestamp:null,cycleRevision:2,ttnRevision:0}});
 put('workspace_settings',{workspace_id:ws},{workspace_id:ws,payload:{}});
 return db;
}
const op=(id)=>({id,type:'load',truckId:truck,shiftId:shift,createdAt:now,
 expectedRevision:2,expectedTtnRevision:0,arrivalTimestamp:now-1000,lastLoadTimestamp:0,
 wantArrived:false,collect:false,cycleMinutes:15});
async function live(db,enabled=true){
 const handler=createReserveHttp({firestore:db,projectId:'samosval-offline',enabled,
  clock:()=>now,verifyToken:token=>({uid:token==='token2'?'tester2':'tester1'})});
 const server=http.createServer(handler);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 return {server,url,stop:()=>new Promise(resolve=>server.close(resolve))};
}
const headers=(token='token1')=>({authorization:'Bearer '+token,
 origin:'https://iluxaspb.github.io'});
test('Cloud Run reserve adapter never serves authenticated data while disabled',async()=>{
 const db=seed(),s=await live(db,false);
 try{
  const h=await fetch(s.url+'/health/live');
  assert.equal(h.status,200);
  const req=await fetch(s.url+'/api/v1/session',{headers:headers()});
  assert.equal(req.status,503);
 }finally{await s.stop();}
});
test('reserve HTTP validates origin and Firebase identity before replica reads',async()=>{
 const s=await live(seed());
 try{
  assert.equal((await fetch(s.url+'/api/v1/session')).status,401);
  assert.equal((await fetch(s.url+'/api/v1/session',
   {headers:{...headers(),origin:'https://attacker.invalid'}})).status,403);
 }finally{await s.stop();}
});
test('two distinct Auth users share one source and one load',async()=>{
 const db=seed(),s=await live(db);
 try{
  const st=await fetch(s.url+'/api/v1/reserve/status',{headers:headers()});
  assert.equal((await st.json()).epoch,4);
  for(const token of ['token1','token2']){
   const session=await (await fetch(s.url+'/api/v1/session',{headers:headers(token)})).json();
   assert.equal(session.source,'firebase');
   assert.equal(session.permissions.actions.includes('action_load'),true);
   const line=await (await fetch(s.url+'/api/v1/line/snapshot',{headers:headers(token)})).json();
   assert.equal(line.statuses.length,1);
   assert.equal(line.shift.id,shift);
  }
  const dispatch=(id,token)=>fetch(s.url+'/api/v1/line/operations',{
   method:'POST',headers:{...headers(token),'content-type':'application/json',
    'x-samosval-writer-epoch':'4'},body:JSON.stringify(op(id))
  }).then(x=>x.json());
  const [a,b]=await Promise.all([dispatch('op_first','token1'),dispatch('op_second','token2')]);
  assert.equal(a.outcome,'confirmed');
  assert.equal(b.outcome,'rejected');
  assert.equal(b.reason,'duplicate-or-arrival-changed');
  assert.equal((await dispatch('op_first','token1')).replayed,true);
  assert.equal([...db.docs.values()].filter(x=>x.table==='line_logs').length,1);
  assert.equal(db.docs.get(OWNER_DOC).reserveSequence,2);
 }finally{await s.stop();}
});
test('reserve endpoint rejects old writer epochs, never writes with stale metadata',async()=>{
 const db=seed(),s=await live(db);
 try{
  const req=await fetch(s.url+'/api/v1/line/operations',{method:'POST',
   headers:{...headers(),'content-type':'application/json',
    'x-samosval-writer-epoch':'3'},body:JSON.stringify(op('stale_op'))});
  assert.equal(req.status,503);
  db.docs.get(REPLICA_DOC).readyForFailover=false;
  assert.equal((await fetch(s.url+'/api/v1/reserve/status',{headers:headers()})).status,503);
  assert.equal(db.docs.get(OWNER_DOC).reserveSequence,0);
 }finally{await s.stop();}
});
