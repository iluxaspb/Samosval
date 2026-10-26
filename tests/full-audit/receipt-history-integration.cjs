// Real history recorder + offline actions + quick/history undo + coin calculator.
// All storage is local in-memory; this does not claim Firebase Rules coverage.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {fixture,clone}=require('./shift-harness.cjs');
const {createLockManager}=require('./offline-harness.cjs');
const source=name=>fs.readFileSync('test-app/src/'+name,'utf8');
function integrated(options={}){
 const e=fixture({count:0,role:'lopater',...options}),c=e.ctx,store=new Map();
 const now=options.now??Date.now();
 if(options.now!==undefined)c.Date=class extends Date{static now(){return options.now;}};
 e.seed('truckStatus','t1',{id:'t1',onLine:true,shiftId:'s1',cycleRevision:1,ttnRevision:0,arriveStatus:'10:00',arriveTimestamp:now-1000,arriveBy:'Operator',lastLoadTimestamp:null,ttnStatus:null,loadedAfterArrive:false});e.sync();
 Object.assign(c,{firebaseConfig:{projectId:'demo-local-history'},navigator:{onLine:false,locks:createLockManager()},AbortController,
  localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)},permissionsLoaded:true,MIN_CYCLE_MINUTES:15,settings:{cycleMinutes:15},
  findTruck:()=>({id:'t1',brand:'Truck',number:'1',defaultVol:20,isGAI:false}),truckName:()=> 'Truck 1',truckLabelHtml:()=> 'Truck 1',escapeHtml:String,
  loadInFlight:{},confirmedLoadIds:new Set(),syncState:{pendingWrites:{},errors:{}},canAdmin:()=>false,
  pendingStart(){},pendingEnd(){},updateSyncUI(){},saveCache(){},renderLine(){},renderHeaderStats(){},renderStatusTicker(){},scheduleRenderForTab(){},markSync(){},reportSyncError(){},
  lastValidNotification:()=>c.state.notifications[0],getLogs:()=>c.state.logs.filter(l=>l.shiftId==='s1')});
 c.appConfig.maxEnabled=false;c.appConfigRef=e.refs.objects.doc('policy');e.seed('objects','policy',{cycleMinutes:15});c.state.notifications=[];
 for(const file of ['core/19-line-state.js','core/20-offline-journal.js'])vm.runInContext(source(file),c);
 vm.runInContext('offlineRemoteStatuses={...state.truckStatus};offlineRemoteLogs=state.logs.slice();',c);
 c.offlineEnsureJournalOwnership();
 const coins=source('features/game-coins-v2.js');
 const functions=coins.slice(coins.indexOf('  const levels='),coins.indexOf('  let records='));
 const penalty=coins.slice(coins.indexOf('  window.__gamePenaltyKey='),coins.indexOf('  let penaltyNotice='));
 vm.runInContext('(function(){'+functions+'let records=[];window.__setGameTestRecords=x=>records=x;'+penalty+'})();',c);
 const undo=source('core/25-undo-audit.js');vm.runInContext(undo.slice(0,undo.indexOf('  async function addAudit')),c);
 const history=source('features/undo-redo.js');vm.runInContext(history.slice(history.indexOf('  function allowedHistory'),history.indexOf('  function updateLocalState')),c);
 const records=()=>e.selected('audit');
 const totals=()=>c.window.__gameCoinsCore.calculate(records());
 const queue=type=>{assert(c.offlineQueueAction(type,'t1',c.captureLineIntent('t1')));return clone(c.offlineJournalRead().at(-1));};
 const replay=async()=>{c.navigator.onLine=true;await c.offlineReplayJournal();await c.offlineReplayEffects();c.window.__setGameTestRecords(records());};
 const retry=async op=>{const rows=c.offlineJournalRead();rows.find(x=>x.id===op.id).status='pending';c.offlineJournalWrite(rows);await replay();};
 return {e,c,records,totals,queue,replay,retry};
}
module.exports={integrated};
if(require.main===module)(async()=>{
 let x=integrated(),op=x.queue('load');await x.replay();
 assert.deepEqual(x.e.errors,[]);assert.equal(x.e.selected('logs','s1').length,1);
 assert.equal(x.records().filter(r=>r.eventType==='history').length,1);assert.equal(x.records().filter(r=>r.offlineReceipt).length,1);
 assert.equal(x.e.commits.length,1);assert.equal(x.e.commits[0].history.length,2,'Receipt and canonical history share business commit');
 assert.equal(x.totals()[0].coins,1);assert.equal(x.totals()[0].loads,1);
 await x.retry(op);assert.equal(x.e.commits.length,1);assert.equal(x.totals()[0].coins,1);assert.equal(x.records().length,2);
 console.log('PASS receipt + actual history wrapper create one business commit, one undo history and one coin; replay adds nothing');
 const canonical=x.records().find(r=>r.eventType==='history').history;
 x.c.state.notifications=x.e.selected('notifications');await x.c.undoLastAction();
 assert.deepEqual(x.e.errors,[]);assert.equal(x.e.selected('logs','s1').length,0);assert.equal(x.records().filter(r=>r.eventType==='game_penalty').length,1);
 assert.equal(x.totals()[0].coins,-3);assert.equal(x.totals()[0].loads,0);
 await assert.rejects(()=>x.c.applyHistoryOperations(canonical.operations,'before',canonical),/измен|удал/);
 assert.equal(x.records().filter(r=>r.eventType==='game_penalty').length,1);
 await x.retry(op);assert.equal(x.e.selected('logs','s1').length,0);assert.equal(x.totals()[0].coins,-3);
 console.log('PASS quick undo removes reward, charges one real penalty; history cannot undo again and receipt replay cannot recreate load');
 let lose=true;x=integrated({afterCommit:async commit=>{if(lose&&commit.business.some(w=>w.path.includes('/logs/'))){lose=false;throw {code:'unavailable',message:'lost reply'};}}});
 op=x.queue('load');await x.replay();assert.equal(x.c.offlinePendingCount(),1);assert.equal(x.totals()[0].coins,1);
 const loaded=x.e.read('truckStatus','t1'),later={...loaded,arriveStatus:'11:00',arriveTimestamp:Date.now()+1000,arriveBy:'Colleague',cycleRevision:loaded.cycleRevision+1,loadedAfterArrive:false};x.e.seed('truckStatus','t1',later);x.e.sync();
 vm.runInContext('offlineRemoteStatuses={...state.truckStatus};offlineRemoteLogs=state.logs.slice();',x.c);
 x.c.offlineTransportRecovered();await x.replay();assert.equal(x.c.offlinePendingCount(),0);assert.equal(x.e.read('truckStatus','t1').arriveBy,'Colleague');assert.equal(x.totals()[0].coins,1);
 x.c.state.notifications=x.e.selected('notifications');await x.c.undoLastAction();assert.equal(x.e.read('truckStatus','t1').arriveBy,'Colleague');assert.equal(x.records().filter(r=>r.eventType==='game_penalty').length,0);
 console.log('PASS lost reply with history and later arrival preserves arrival, avoids duplicate rewards and rejects unsafe quick undo without penalty');
})().catch(e=>{console.error(e);process.exitCode=1;});
