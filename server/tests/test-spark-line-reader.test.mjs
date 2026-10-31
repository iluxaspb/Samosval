import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {createSparkLineReader} from '../../test-app/synology/spark-line-reader.mjs';

const G='0123456789abcdef01234567',WS='main_workspace';
const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):
 Array.isArray(x)?'['+x.map(canonical).join(',')+']':
 '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
const ID=(t,k)=>t+'_'+createHash('sha256').update(t+'\n'+canonical(k)).digest('hex');
const head=(diff={})=>({owner:'firebase',readyForFailover:true,generation:G,
 confirmedSequence:42,reserveSequence:0,epoch:2,...diff});
function mock({owner=head(),accessDiff={},alterRow,extraTrucks=0,ownerAfter}={}){
 let current={uid:'user-a'},reads=0,writes=0,ownerReads=0;
 const access={protocol:1,source:'nas-spark-mirror',projectId:'samosval-offline',
  workspaceId:WS,generation:G,uid:'user-a',sourceSequence:42,active:true,lineRead:true,
  profile:{uid:'user-a',status:'active',role:'lopater',deleted:false,revision:1},
  permissions:{tabs:['line'],actions:['action_load']},...accessDiff};
 const tables=new Map();
 const row=(kind,key,r)=>{
  const doc={id:ID(kind,key),value:{table:kind,keyJson:canonical(key),
   rowJson:canonical(r),appliedSequence:42}};
  if(!tables.has(kind))tables.set(kind,[]);
  tables.get(kind).push(doc);
 };
 row('workspaces',{id:WS},{id:WS,cycle_minutes:60});
 row('shifts',{workspace_id:WS,shift_id:'shift-a'},{
  workspace_id:WS,shift_id:'shift-a',is_active:true,
  payload:{objectId:'obj',objectName:'Объект 1'}});
 row('line_trucks',{workspace_id:WS,truck_id:'truck-a'},{
  workspace_id:WS,truck_id:'truck-a',
  payload:{brand:'КамАЗ',number:'А101АА',defaultVol:24}});
 row('line_truck_statuses',{workspace_id:WS,truck_id:'truck-a'},{
  workspace_id:WS,truck_id:'truck-a',shift_id:'shift-a',
  payload:{onLine:true,cycleRevision:3,shiftId:'shift-a'}});
 row('line_logs',{workspace_id:WS,log_id:'load-one'},{
  workspace_id:WS,log_id:'load-one',truck_id:'truck-a',
  shift_id:'shift-a',payload:{timestamp:1999999,volume:24}});
 for(let i=0;i<extraTrucks;i++)row('line_trucks',{
  workspace_id:WS,truck_id:'truck-extra-'+i}, {workspace_id:WS,
  truck_id:'truck-extra-'+i,payload:{brand:'Тест',number:'0'+i}});
 if(alterRow)alterRow(tables);
 const firestore={app:{options:{projectId:'samosval-offline'}},
  doc:path=>({path,get:async()=>{reads++;
   if(path==='samosval_test_replica/v1/access_'+G+'/user-a')
    return {exists:true,data:()=>structuredClone(access)};
   return {exists:false};}}),
  collection:path=>({where:(field,operator,kind)=>({
   limit:limit=>({get:async()=>{reads++;
    assert.equal(field,'table');assert.equal(operator,'==');
    assert.ok(limit>=1&&limit<=301);
    assert.equal(path,'samosval_test_replica/v1/rows_'+G);
    return {docs:(tables.get(kind)||[]).slice(0,limit).map(
     doc=>({id:doc.id,data:()=>structuredClone(doc.value)}))};
   }})
  })})
 };
 const authority={readOwner:async()=>{ownerReads++;
  return ownerAfter&&ownerReads>1?ownerAfter:owner;},stop(){}};
 const create=(opts={})=>createSparkLineReader({firestore,getUser:()=>current,
  ownerReader:authority,cryptoImpl:webcrypto,...opts});
 return {create,access,tables,firestore,authority,get readings(){return reads;},
  get authorityReads(){return ownerReads;},get writes(){return writes;},
  swap:()=>{current={uid:'other'};}};
}
test('Spark LINE read reconstructs only active shift from mirrored private rows',async()=>{
 const t=mock(),reader=t.create();
 const snapshot=await reader.readLine();
 assert.equal(snapshot.source,'firebase');
 assert.equal(snapshot.workspaceId,WS);
 assert.equal(snapshot.cycleMinutes,60);
 assert.equal(snapshot.shift.id,'shift-a');
 assert.equal(snapshot.trucks.length,1);
 assert.equal(snapshot.trucks[0].id,'truck-a');
 assert.equal(snapshot.statuses[0].id,'truck-a');
 assert.equal(snapshot.logs[0].id,'load-one');
 assert.equal(snapshot.logs[0].volume,24);
 assert.equal(t.readings,6,'one private per-user grant + five bounded table reads');
 assert.equal(t.authorityReads,2);
 assert.equal(t.writes,0);
 reader.stop();
});
test('Spark reserve session uses only server materialized Firebase Auth UID grant',async()=>{
 const t=mock(),session=await t.create().readSession();
 assert.equal(session.profile.uid,'user-a');
 assert.deepEqual(session.permissions.tabs,['line']);
 assert.equal(t.readings,1);
 assert.equal(t.authorityReads,2);
});
test('No authority or uncertified owner: never read a private mirrored row',async()=>{
 for(const owner of [head({owner:'synology',readyForFailover:false}),
  head({owner:'reconciling',readyForFailover:false}),
  head({owner:'firebase',readyForFailover:false})]){
  const t=mock({owner});
  await assert.rejects(t.create().readLine(),{code:'spark-line-not-active'});
  assert.equal(t.readings,0);
 }
});
test('Access revocation and forged generation are rejected before line table scans',async()=>{
 for(const accessDiff of [{active:false},{lineRead:false},
  {sourceSequence:44},{uid:'attacker'},{profile:{uid:'user-a',status:'disabled',deleted:false}},
  {generation:'different'},{permissions:{tabs:[],actions:[]}}]){
  const t=mock({accessDiff});
  await assert.rejects(t.create().readLine(),e=>e.code==='spark-line-forbidden'||e.code==='spark-access-invalid');
  assert.equal(t.readings,1);
 }
});
test('A coordinator change mid-read discards the whole snapshot',async()=>{
 const t=mock({ownerAfter:head({epoch:3})});
 await assert.rejects(t.create().readLine(),{code:'spark-owner-changed-during-read'});
 assert.equal(t.writes,0);
});
test('Mirror row IDs and canonical payloads cannot be silently tampered',async()=>{
 const t=mock({alterRow:tables=>tables.get('line_logs')[0].id='wrong-id'});
 await assert.rejects(t.create().readLine(),{code:'spark-line-row-id-invalid'});
 const u=mock({alterRow:tables=>tables.get('line_logs')[0].value.rowJson='{"a":3,"b":2}'});
 await assert.rejects(u.create().readLine(),{code:'spark-line-row-invalid'});
});
test('An oversized mirror table is rejected, never rendered as incomplete data',async()=>{
 const t=mock({extraTrucks:4});
 await assert.rejects(t.create({maxRowsPerTable:3}).readLine(),
  {code:'spark-line-table-too-large'});
});
test('A different authenticated user invalidates the Firestore session',async()=>{
 const t=mock(),reader=t.create();
 t.swap();
 await assert.rejects(reader.readLine(),{code:'spark-session-changed'});
 assert.equal(t.readings,0);
 reader.stop();
});
