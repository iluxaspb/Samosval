// Current reward scheduling must survive receipts, retries and causal undo.
// Real current history recorder and coin calculator, mocked transactions only.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {integrated}=require('./receipt-history-integration.cjs');
const {clone}=require('./shift-harness.cjs');
const originalTime=2000000,replayTime=4000000;
const oldRate={effectiveAt:1000000,load:5,arrive:7,ttn:3};
const newRate={effectiveAt:3000000,load:9,arrive:11,ttn:4};
const policy={cycleMinutes:15,gameRewardSchedule:[oldRate,newRate]};
function status(x,changes){x.e.seed('truckStatus','t1',{...x.e.read('truckStatus','t1'),...changes});x.e.sync();vm.runInContext('offlineRemoteStatuses={...state.truckStatus};offlineRemoteLogs=state.logs.slice();',x.c);}
function rewards(x){return x.records().filter(row=>row.eventType==='history').map(row=>row.history.gameRewards);}
(async()=>{
 for(const [type,expected] of [['load',5],['arrive',7],['ttn',3],['reset',0]]){
  const x=integrated({now:originalTime});x.e.seed('objects','policy',policy);
  if(type==='arrive')status(x,{arriveStatus:null,arriveTimestamp:null,lastLoadTimestamp:originalTime-900001,loadedAfterArrive:true,lastLoadLogId:'previous'});
  if(type==='reset'){x.c.canAdmin=()=>true;status(x,{lastLoadTimestamp:originalTime-1000});}
  const op=x.queue(type);x.c.Date=class extends Date{static now(){return replayTime;}};await x.replay();
  assert.deepEqual(x.e.errors,[]);assert.equal(op.createdAt,originalTime);
  assert.equal(x.e.commits.length,1);assert.equal(x.records().filter(row=>row.offlineReceipt).length,1);
  assert.deepEqual(rewards(x),[{version:1,actionAt:originalTime,actionId:op.id,kind:type,load:5,arrive:7,ttn:3}],type+' freezes queued time, not replay time');
  const total=()=>x.totals()[0]?.coins||0;assert.equal(total(),expected);
  const before=clone(x.records());x.e.seed('objects','policy',{...policy,gameRewardSchedule:[{effectiveAt:1,load:100,arrive:200,ttn:300}]});
  await x.retry(op);assert.equal(x.e.commits.length,1);assert.deepEqual(x.records(),before);assert.equal(total(),expected,'Receipt retry never reprices or creates reward history');
  if(type==='load'){
   x.c.state.notifications=x.e.selected('notifications');await x.c.undoLastAction();
   assert.deepEqual(x.e.errors,[]);assert.equal(total(),-3,'Undo removes five original coins and charges one penalty, not the new tariff');
   await x.retry(op);assert.equal(total(),-3);assert.equal(x.e.selected('logs','s1').length,0);
  }
  console.log('PASS '+type+': original queued timestamp, configured frozen reward, atomic receipt, retry under changed tariff'+(type==='load'?', causal undo and no resurrection':''));
 }
 // The sync callback retains policy updates without restoring removed Storage settings.
 let configCallback;const ref={onSnapshot:()=>()=>{},orderBy(){return this;},limit(){return this;}};
 const c={unsubscribers:[],stopSync(){},refs:Object.fromEntries(['trucks','objects','logs','truckStatus','shift','archive','trash','audit','notifications','plugins','patches'].map(name=>[name,ref])),usersRef:ref,usersUnsubscriber:null,receiveLoadLogs(){},receiveTruckStatuses(){},canAdmin:()=>false,
  appConfigRef:{onSnapshot:callback=>{configCallback=callback;return()=>{};}},permsRef:ref,settings:{cycleMinutes:15},localStorage:{setItem(){}},window:{__gameConfigChanged(){}},renderConflictAuthorPatch(){},renderAppSettingsIfActive(){},console};
 const sync=fs.readFileSync('test-app/src/core/06-sync.js','utf8');
 vm.runInNewContext(sync.slice(sync.indexOf('  function startSync()'),sync.indexOf('  function scheduleRenderLine()')),c);c.startSync();
 configCallback({exists:true,data:()=>policy});assert.deepEqual(c.appConfig.gameRewardSchedule,policy.gameRewardSchedule);assert(!Object.hasOwn(c.appConfig,'photoStorageLimitBytes'));
 configCallback({exists:true,data:()=>({})});assert.deepEqual(Array.from(c.appConfig.gameRewardSchedule),[]);
 console.log('PASS sync preserves configured reward schedule, safely defaults missing schedule, and never revives photo Storage configuration');
})().catch(error=>{console.error(error);process.exitCode=1;});
