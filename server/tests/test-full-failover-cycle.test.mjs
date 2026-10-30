import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createHash} from 'node:crypto';
import {REPLICA_DOC,canonical,sha256} from '../src/test-replica.mjs';
import {OWNER_DOC,claimNasOwnership} from '../src/test-writer-coordinator.mjs';
import {applyLineOperation} from '../src/line-rules.mjs';

// Real PostgreSQL 16 with SQL 014; Firestore transactions are simulated.
// This is NOT a physical NAS / live Firestore / two-device acceptance test.
class Firestore{
 constructor(){this.docs=new Map();}
 doc(path){return {path,get:async()=>({exists:this.docs.has(path),
  data:()=>structuredClone(this.docs.get(path))})};}
 collection(path){return {get:async()=>({docs:[...this.docs.entries()]
  .filter(([k])=>k.startsWith(path+'/')).map(([key,row])=>({
   id:key.slice(path.length+1),data:()=>structuredClone(row)}))})};}
 batch(){const staged=[];return{set:(ref,val)=>staged.push([ref.path,val]),
  commit:async()=>{for(const [path,val] of staged)this.docs.set(path,structuredClone(val));}};}
 async runTransaction(fn){
  const changes=[],tx={
   get:async ref=>this.doc(ref.path).get(),
   create:(ref,data)=>changes.push(['create',ref.path,data]),
   set:(ref,data)=>changes.push(['set',ref.path,data]),
   update:(ref,data)=>changes.push(['update',ref.path,data])
  };
  const value=await fn(tx);
  for(const [action,path] of changes)if(action==='create'&&this.docs.has(path))throw Error('already-exists');
  for(const [action,path,data] of changes){
   if(action==='update')this.docs.set(path,{...this.docs.get(path),...structuredClone(data)});
   else this.docs.set(path,structuredClone(data));
  }
  return value;
 }
}
const supported=!!process.env.TEST_DATABASE_URL;
test('real SQL 014 NAS -> simulated Firestore writer -> PostgreSQL handback and two users',
 {skip:!supported},async()=>{
 const ws='qa_reconcile_isolated',uid1='qa_reconcile_user1',uid2='qa_reconcile_user2',
  truckId='qa_reconcile_truck',shiftId='qa_reconcile_shift';
 process.env.WORKSPACE_ID=ws;
 // Import AFTER selecting the isolated workspace. The business service reads
 // the workspace at module-load time, not from untrusted operation input.
 const {beginReserveReplay,replayReserveNext}=await import('../src/test-reconcile-line.mjs');
 const {stageRecoveredGeneration,completeNasHandback}=
  await import('../src/test-reconcile-finalize.mjs');
 const {submitLineOperation}=await import('../src/line-store.mjs');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});
 const db=new Firestore(),now=Date.now(),arrival=now-1000;
 const before={id:truckId,shiftId,onLine:true,arriveStatus:'12:00',
  arriveTimestamp:arrival,lastLoadTimestamp:null,cycleRevision:2,
  ttnRevision:0,loadedAfterArrive:false};
 const truck={brand:'КАМАЗ',number:'101',defaultVol:24,isGAI:false};
 try{
  await pool.query('INSERT INTO workspaces(id,cycle_minutes) VALUES ($1,15)',[ws]);
  for(const [uid,name] of [[uid1,'Первый'],[uid2,'Второй']]){
   await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$2,$3,'admin','active')",
    [uid,uid+'@example.invalid',name]);
  }
  await pool.query('INSERT INTO workspace_settings(workspace_id,payload) VALUES ($1,$2)',[ws,{}]);
  await pool.query('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)',
   [ws,shiftId,{id:shiftId,objectId:'qa_obj',objectName:'Тест',closing:false}]);
  await pool.query('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)',
   [ws,truckId,truck]);
  await pool.query('INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES($1,$2,$3,$4)',
   [ws,truckId,shiftId,before]);
  const op=id=>({id,type:'load',truckId,shiftId,createdAt:now,
   expectedRevision:2,expectedTtnRevision:0,arrivalTimestamp:arrival,
   lastLoadTimestamp:0,wantArrived:false,collect:false,cycleMinutes:15});
  const first=op('qa_load_A'),second=op('qa_load_B');
  const r1=applyLineOperation({op:first,before,truck,actor:{
   name:'Первый',email:uid1+'@example.invalid',isAdmin:true},cycleMinutes:15,now});
  const r2=applyLineOperation({op:second,before:r1.status,truck,actor:{
   name:'Второй',email:uid2+'@example.invalid',isAdmin:true},cycleMinutes:15,now});
  assert.equal(r1.outcome,'confirmed');assert.equal(r2.outcome,'rejected');
  const saved=result=>({outcome:result.outcome,reason:result.reason||null,
   status:result.status||null,log:result.log||null});
  const cursor=Number((await pool.query('SELECT last_sequence::text AS s FROM reserve_outbox_cursor')).rows[0].s);
  const baseHash='a'.repeat(64),generation='abcdef0123456789abcdef01',epoch=3;
  await pool.query("INSERT INTO reserve_replica_receipt(singleton,sequence,hash) VALUES(true,$1,$2) ON CONFLICT(singleton) DO UPDATE SET sequence=$1,hash=$2",
   [cursor,baseHash]);
  db.docs.set(REPLICA_DOC,{protocol:1,projectId:'samosval-offline',channel:'test',
   writer:'synology',readyForFailover:true,generation,lastSequence:cursor,hash:baseHash});
  let previousHash=sha256('reserve:'+baseHash+':'+epoch);
  for(const [sequence,uid,operation,result] of [[1,uid1,first,saved(r1)],[2,uid2,second,saved(r2)]]){
   const requestHash=createHash('sha256').update(JSON.stringify(operation)).digest('hex');
   const ledger={sequence,epoch,uid,workspaceId:ws,op:operation,
    requestHash,result,at:now,previousHash};
   const entry={...ledger,hash:sha256(previousHash+'\n'+canonical(ledger))};
   db.docs.set(REPLICA_DOC+'/reserve_ops_'+generation+'/'+String(sequence).padStart(20,'0'),entry);
   previousHash=entry.hash;
  }
  db.docs.set(OWNER_DOC,{protocol:1,projectId:'samosval-offline',
   owner:'firebase',holder:'firebase_reserve',generation,epoch,
   leaseUntil:now+60000,observedSequence:cursor,
   reserveSequence:2,reserveHash:previousHash,pending:{}});
  const start=await beginReserveReplay({firestore:db,projectId:'samosval-offline',
   pool,fenceEnabled:true});
  assert.equal(start.targetSequence,2);
  assert.equal((await replayReserveNext({firestore:db,projectId:'samosval-offline',
   pool,fenceEnabled:true})).applied,1);
  assert.equal((await replayReserveNext({firestore:db,projectId:'samosval-offline',
   pool,fenceEnabled:true})).applied,2);
  assert.equal((await replayReserveNext({firestore:db,projectId:'samosval-offline',
   pool,fenceEnabled:true})).complete,true);
  const count=await pool.query('SELECT count(*)::int AS n FROM line_logs WHERE workspace_id=$1',[ws]);
  assert.equal(count.rows[0].n,1);
  const retry=await submitLineOperation(pool,uid1,first);
  assert.equal(retry.replayed,true);
  const staged=await stageRecoveredGeneration({firestore:db,projectId:'samosval-offline',
   pool,fenceEnabled:true});
  assert.equal(staged.staged,true);
  const completed=await completeNasHandback({firestore:db,
   projectId:'samosval-offline',pool,fenceEnabled:true});
  assert.equal(completed.completed,true);
  assert.equal(db.docs.get(OWNER_DOC).owner,'synology');
  const meta=db.docs.get(REPLICA_DOC);
  assert.equal(meta.readyForFailover,false);
  const leased=await claimNasOwnership({firestore:db,
   projectId:'samosval-offline',nodeId:'qa_new_nas',now:Date.now(),
   checkpoint:{sequence:meta.lastSequence,hash:meta.hash}});
  assert.ok(leased.epoch>epoch);
  const final=await pool.query('SELECT count(*)::int AS n FROM line_logs WHERE workspace_id=$1',[ws]);
  assert.equal(final.rows[0].n,1);
 }finally{
  // The CI database is disposable and discarded after the suite.
  await pool.end();
 }
});
