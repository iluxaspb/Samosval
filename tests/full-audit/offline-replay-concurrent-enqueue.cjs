'use strict';
// Execute the shipped offline replay module with deterministic Firestore doubles.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('test-app/source/core/16-offline-replay.js','utf8');
const statusRef={path:'workspaces/main_workspace/truckStatus/t'};
const shiftRef={path:'workspaces/main_workspace/shift/current'};
const logRows=new Map();let status={id:'t',shiftId:'s',onLine:true,cycleRevision:1,ttnRevision:0,arriveStatus:null,arriveTimestamp:null,lastLoadTimestamp:null,loadedAfterArrive:false};
const shift={id:'s',isActive:true,objectId:'o',objectName:'Object'};
const refs={shift,truckStatus:{doc:()=>statusRef},logs:{doc:id=>({path:'workspaces/main_workspace/logs/'+id})}};
let releaseFirst,enteredFirst;const firstEntered=new Promise(resolve=>enteredFirst=resolve);let transactions=0;
const journal=[{id:'arrive-1',type:'arrive',truckId:'t',shiftId:'s',objectId:'o',objectName:'Object',createdAt:Date.now(),actor:'Operator',email:'operator@example.test',expectedRevision:1,arrivalTimestamp:0,lastLoadTimestamp:0,wantArrived:true,collect:true,cycleMinutes:15,truckName:'Truck',volume:20,isGAI:false,status:'pending',dependencyId:null}];
const ctx={console:{warn(){},log(){},error(){}},Date,Math,Promise,setTimeout,clearTimeout,
 navigator:{onLine:true},currentUid:'operator',currentEmail:'operator@example.test',currentUserStatus:'active',currentUserRole:'lopater',permissionsLoaded:true,profileServerConfirmed:true,permissionsServerConfirmed:true,authSessionGeneration:1,
 MIN_CYCLE_MINUTES:15,settings:{cycleMinutes:15},state:{shift,truckStatus:{t:status},trucks:[{id:'t',brand:'Truck',number:'1',defaultVol:20}],logs:[],notifications:[]},refs,
 appConfigRef:{path:'settings/appConfig'},appConfig:{maxEnabled:false},syncState:{pendingWrites:{},errors:{}},offlineServerRetryAt:0,offlineServerRetryDelay:0,offlineServerUnreachable:false,offlineReplayRunning:false,
 offlineJournalRead:()=>JSON.parse(JSON.stringify(journal)),offlineJournalWrite:items=>{journal.splice(0,journal.length,...JSON.parse(JSON.stringify(items)));},offlinePendingOps:()=>journal.filter(x=>x.status==='pending').map(x=>JSON.parse(JSON.stringify(x))),
 offlinePendingCount:()=>journal.filter(x=>x.status==='pending').length,offlineUnreviewedFailures:()=>[],offlineTransportError:()=>false,
 isNasRuntime:()=>false,replayNasOfflineJournal:async()=>{},offlineTransportRecovered(){},offlineTransportFailed(){},updateSyncUI(){},offlineProjectState(){},offlineProjectTicker(){},saveCache(){},refreshLineViews(){},showToastEl(){},showError(){},escapeHtml:String,offlineReasonLabel:String,
 getUserName:()=> 'Operator',currentEmail:'operator@example.test',canAdmin:()=>false,findTruck:()=>({id:'t',brand:'Truck',number:'1',defaultVol:20,isGAI:false}),truckName:()=> 'Truck 1',getLogs:()=>ctx.state.logs,
 offlineNotifyAccepted:async()=>{},offlineAdoptResult(_op,result){status={...status,...result.status};ctx.state.truckStatus.t=status;},offlineResolve(id,outcome,reason){const o=journal.find(x=>x.id===id);o.status=outcome;o.result=reason;},
 readLineState:async(_tx,id)=>({...status,id}),enqueueMax(){},navigatorOnline:true,crypto:{randomUUID:()=>String(Math.random())},
 db:{runTransaction:async callback=>{transactions++;const writes=[];const tx={get:async ref=>ref===ctx.appConfigRef?{exists:true,data:()=>({cycleMinutes:15})}:ref===statusRef?{exists:true,data:()=>({...status})}:ref.path.includes('/logs/')?{exists:logRows.has(ref.path),data:()=>logRows.get(ref.path)}:{exists:true,data:()=>shift},update:(ref,data)=>writes.push(['update',ref,data]),set:(ref,data)=>writes.push(['set',ref,data])};
   const result=await callback(tx);if(transactions===1){enteredFirst();await new Promise(resolve=>releaseFirst=resolve);}for(const [kind,ref,data] of writes){if(kind==='update'&&ref===statusRef)status={...status,...data};if(kind==='set'&&ref.path.includes('/logs/'))logRows.set(ref.path,data);}return result;}}
};
vm.createContext(ctx);vm.runInContext('let offlineRemoteStatuses={t:state.truckStatus.t},offlineRemoteLogs=[],offlineServerRetryAt=0,offlineServerRetryDelay=0,offlineServerUnreachable=false,offlineReplayRunning=false;',ctx);vm.runInContext('function truckLabelHtml(){return \"Truck\";}function truckName(){return \"Truck\";}',ctx);vm.runInContext(source,ctx);
(async()=>{
  ctx.navigator.onLine=true;const first=ctx.offlineReplayJournal();await firstEntered;
  const arrival=journal[0];journal.push({...arrival,id:'load-1',type:'load',status:'pending',dependencyId:arrival.id,expectedRevision:2,arrivalTimestamp:arrival.createdAt,createdAt:arrival.createdAt+1,logId:'load-1',wantArrived:false});
  releaseFirst();await first;
  assert.equal(journal.filter(x=>x.status==='pending').length,0,'new queued action must be drained by the active pass');
  assert.equal(logRows.size,1,'load must commit without another external replay trigger');
  assert.equal(transactions,2,'arrival and subsequently queued load each run once');
  console.log('PASS shipped offline replay drains an action added while the prior transaction is in flight');
})().catch(error=>{console.error(error);process.exitCode=1;});
