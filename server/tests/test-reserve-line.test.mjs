import test from 'node:test';
import assert from 'node:assert/strict';
import {reserveLineOperation} from '../src/test-reserve-line.mjs';
import {REPLICA_DOC,rowId,canonical,sha256} from '../src/test-replica.mjs';
import {OWNER_DOC} from '../src/test-writer-coordinator.mjs';

class SerialFirestore {
 constructor(){this.docs=new Map();this.tail=Promise.resolve();this.loseReply=false;this.offline=false;}
 doc(path){return {path,get:async()=>this.snapshot(path)};}
 snapshot(path){return {exists:this.docs.has(path),data:()=>structuredClone(this.docs.get(path))};}
 async runTransaction(callback){
  const earlier=this.tail;
  let release;this.tail=new Promise(resolve=>release=resolve);
  await earlier;
  try{
   if(this.offline)throw Error('firestore-offline');
   const staged=[],tx={
    get:async ref=>this.snapshot(ref.path),
    create:(ref,data)=>staged.push(['create',ref.path,data]),
    set:(ref,data)=>staged.push(['set',ref.path,data]),
    update:(ref,data)=>staged.push(['update',ref.path,data])
   };
   const out=await callback(tx);
   if(this.offline)throw Error('firestore-offline');
   for(const [type,path] of staged)if(type==='create'&&this.docs.has(path))throw Error('already-exists');
   for(const [type,path,value] of staged){
    if(type==='update')this.docs.set(path,{...this.docs.get(path),...structuredClone(value)});
    else this.docs.set(path,structuredClone(value));
   }
   if(this.loseReply){this.loseReply=false;throw Error('lost-success-response');}
   return out;
  }finally{release();}
 }
}
const ws='main_workspace',truck='truck_a',shift='shift_test',now=1900000005000,uid='operator_one';
const generation='0123456789abcdef01234567';
const rowRef=(table,key)=>REPLICA_DOC+'/rows_'+generation+'/'+rowId(table,key);
const add=(db,table,key,row)=>db.docs.set(rowRef(table,key),
 {table,keyJson:canonical(key),rowJson:canonical(row),appliedSequence:100});
function setup(){
 const db=new SerialFirestore(),epoch=7;
 db.docs.set(REPLICA_DOC,{protocol:1,channel:'test',writer:'synology',projectId:'samosval-offline',
  generation,hash:'a'.repeat(64),lastSequence:100,readyForFailover:true});
 db.docs.set(OWNER_DOC,{protocol:1,projectId:'samosval-offline',
  owner:'firebase',holder:'firebase_reserve',epoch,generation,
  observedSequence:100,leaseUntil:now+60000,reserveSequence:0,pending:{}});
 add(db,'app_users',{uid},{uid,email:'operator@example.org',display_name:'Тестовый оператор',
  role:'lopater',status:'active',profile:{deleted:false}});
 for(const type of ['load','arrive','ttn'])add(db,'role_permissions',{role:'lopater',action:'action_'+type},
  {role:'lopater',action:'action_'+type,allowed:true});
 add(db,'workspaces',{id:ws},{id:ws,cycle_minutes:15});
 add(db,'shifts',{workspace_id:ws,shift_id:shift},
  {workspace_id:ws,shift_id:shift,is_active:true,payload:{id:shift,closing:false,objectId:'o1',objectName:'Тест'}});
 add(db,'line_trucks',{workspace_id:ws,truck_id:truck},
  {workspace_id:ws,truck_id:truck,payload:{id:truck,brand:'КАМАЗ',number:'101',defaultVol:24,isGAI:false}});
 add(db,'line_truck_statuses',{workspace_id:ws,truck_id:truck},
  {workspace_id:ws,truck_id:truck,shift_id:shift,payload:{
   id:truck,shiftId:shift,onLine:true,arriveStatus:'12:00',arriveTimestamp:now-1000,
   lastLoadTimestamp:null,cycleRevision:7,ttnRevision:0,loadedAfterArrive:false}});
 add(db,'workspace_settings',{workspace_id:ws},{workspace_id:ws,payload:{}});
 db.docs.set('legacy/old-test-record',{mustNotTouch:true});
 const op={id:'operation_line_111',type:'load',truckId:truck,shiftId:shift,
  createdAt:now,expectedRevision:7,expectedTtnRevision:0,
  arrivalTimestamp:now-1000,lastLoadTimestamp:0,
  wantArrived:false,collect:false,cycleMinutes:15};
 const write=(input=op,options={})=>reserveLineOperation({
  firestore:db,projectId:'samosval-offline',uid,workspaceId:ws,
  input,expectedEpoch:epoch,now,...options
 });
 return {db,op,write};
}
const read=(db,table,key)=>JSON.parse(db.docs.get(rowRef(table,key))?.rowJson||'null');
test('reserve load uses the exact NAS rule, persists receipt/history and survives lost ACK',async()=>{
 const {db,op,write}=setup();
 db.loseReply=true;
 await assert.rejects(write(),/lost-success-response/);
 const first=await write();
 assert.equal(first.outcome,'confirmed');
 assert.equal(first.replayed,true);
 assert.equal(first.log.volume,24);
 const status=read(db,'line_truck_statuses',{workspace_id:ws,truck_id:truck});
 assert.equal(status.payload.cycleRevision,8);
 assert.equal(status.payload.arriveStatus,null);
 assert.equal(read(db,'line_logs',{workspace_id:ws,log_id:first.log.id}).payload.clientOperationId,op.id);
 const hist=read(db,'line_history',{workspace_id:ws,action_id:op.id});
 assert.equal(hist.game_rewards.load,1);
 assert.equal(hist.before_status.cycleRevision,7);
 assert.equal(db.docs.get(OWNER_DOC).reserveSequence,1);
 assert.equal([...db.docs.keys()].filter(x=>x.includes('/reserve_ops_')).length,1);
 assert.deepEqual(db.docs.get('legacy/old-test-record'),{mustNotTouch:true});
});
test('two operators loading the same truck cannot count twice',async()=>{
 const {db,op,write}=setup();
 const other={...op,id:'operation_line_222'};
 const [a,b]=await Promise.all([write(op),write(other)]);
 assert.equal(a.outcome,'confirmed');
 assert.equal(b.outcome,'rejected');
 assert.equal(b.reason,'duplicate-or-arrival-changed');
 assert.equal([...db.docs.keys()].filter(x=>x.includes('/reserve_ops_')).length,2);
 assert.equal([...db.docs.values()].filter(x=>x?.table==='line_logs').length,1);
 assert.equal(db.docs.get(OWNER_DOC).reserveSequence,2);
});
test('reused operation ID with different payload is rejected',async()=>{
 const {write,op}=setup();
 await write();
 await assert.rejects(write({...op,createdAt:now-1}),/operation-id-reused/);
});
test('stale epoch and missing Firebase coordinator never authorize writes',async()=>{
 const {db,write}=setup();
 await assert.rejects(write(undefined,{expectedEpoch:6}),/reserve-not-write-owner/);
 db.offline=true;
 await assert.rejects(write(),/firestore-offline/);
 db.offline=false;
 db.docs.get(OWNER_DOC).owner='synology';
 await assert.rejects(write(),/reserve-not-write-owner/);
});
test('non-admin without action rights cannot replay or create receipts',async()=>{
 const {db,write}=setup();
 db.docs.delete(rowRef('role_permissions',{role:'lopater',action:'action_load'}));
 await assert.rejects(write(),/forbidden/);
 assert.equal(db.docs.get(OWNER_DOC).reserveSequence,0);
});
test('reserve cannot write unless the mirrored generation is explicitly ready',async()=>{
 const {db,write}=setup();
 db.docs.get(REPLICA_DOC).readyForFailover=false;
 await assert.rejects(write(),/reserve-generation-not-ready/);
});
test('invalid operations cannot mutate the Firestore mirror',async()=>{
 const {db,write,op}=setup();
 await assert.rejects(write({...op,cycleMinutes:-1}),/invalid-cycleMinutes/);
 assert.equal(db.docs.get(OWNER_DOC).reserveSequence,0);
});
