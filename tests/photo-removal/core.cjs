const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// Exercise the real TEST queue, shift, archive and atomic history code.
// No Firebase connection, IndexedDB deletion or production-file change is used.
const {fixture: shiftFixture}=require('../full-audit/shift-harness.cjs');
const {createLockManager}=require('../full-audit/offline-harness.cjs');
const scripts=['05-formatting','06-sync','13-reports','19-line-state','20-offline-journal']
  .map(name=>fs.readFileSync('test-app/src/core/'+name+'.js','utf8'));
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture({pending=[],logs=[]}={}){
  const env=shiftFixture({active:false}),context=env.ctx;
  const journalKey='samosval_offline_v1_test_test_operator';
  const storage=new Map([
    [journalKey,JSON.stringify(pending)],
    ['dt_settings',JSON.stringify({cycleMinutes:60})],
    ['dt_max_queue',JSON.stringify([{id:'notification-1',type:'text',text:'Arrival'}])],
    ['timesheet-sentinel',JSON.stringify({hours:8,material:12})],
    ['photos-sentinel',JSON.stringify({legacyPhotoIds:['retained-photo']})]
  ]);
  const elements=new Map(),element=id=>{
    if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',textContent:'',style:{},classList:{add(){},remove(){}}});
    return elements.get(id);
  };
  env.seed('shift','current',{id:'shift',isActive:true,objectName:'Object',objectId:'object',startDate:'2026-10-26'});
  env.seed('truckStatus','truck',{onLine:true,shiftId:'shift',ttnStatus:true});
  logs.forEach((row,i)=>env.seed('logs','log-'+i,{...clone(row),shiftId:'shift'}));env.sync();
  Object.assign(context,{
    firebaseConfig:{projectId:'test'},currentUserNickname:'Operator',initialized:true,permissionsLoaded:true,pendingOps:0,
    navigator:{onLine:false,locks:createLockManager()},AbortController,settings:{cycleMinutes:60},MIN_CYCLE_MINUTES:15,
    syncState:{errors:{},fromCache:{},pendingWrites:{},everConnected:Object.fromEntries(['profile','permissions','trucks','status','shift'].map(key=>[key,true]))},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value))},
    appConfig:{maxEnabled:false},confirmedLoadIds:new Set(),loadInFlight:{},
    document:{getElementById:id=>id==='syncDot'?null:element(id)},viewingArchiveGAITable:false,
    getLogs:()=>context.state.logs.filter(row=>row.shiftId==='shift'),canAdmin:()=>true,
    renderLine(){},renderHeaderStats(){},renderStatusTicker(){},scheduleRenderForTab(){},
    escapeHtml:String,resolveUserDisplayName:(email,name)=>name||email,
    findTruck:id=>({id,brand:'Truck',number:'1',isGAI:false}),setTimeout(){},clearTimeout(){}
  });
  context.state.trash=[];context.state.notifications=[];context.state.users=[];context.state.trucks=[{id:'truck',brand:'Truck',number:'1',isGAI:false}];
  Object.defineProperty(context,'indexedDB',{get(){throw Error('Existing photos/timesheets must not be opened or deleted');}});
  for(const script of scripts)vm.runInContext(script,context);
  vm.runInContext('offlineRemoteStatuses={...state.truckStatus};offlineRemoteLogs=state.logs.slice();',context);
  context.offlineEnsureJournalOwnership();context.navigator.onLine=true;
  return {context,env,storage,journalKey,get archives(){return env.selected('archive');},errors:env.errors,events:env.events,elements,element};
}

(async () => {
  const queued = Array.from({length: 24}, (_, i) => ({id: 'operation-' + i, shiftId: 'shift', truckId: 'truck', type: ['arrive', 'load', 'ttn', 'reset'][i % 4], status: 'pending', createdAt: i + 1}));
  let f = fixture({pending: queued});
  const before = [...f.storage.entries()];
  assert.equal(f.context.offlinePendingCount(), 24);
  assert.equal(f.context.getSyncStatus().text, 'Синхронизация... (24)');
  f.context.pendingOps = 3;
  assert.equal(f.context.getSyncStatus().text, 'Синхронизация... (27)');
  await f.context.closeShift();
  assert.deepEqual(f.errors, ['Сначала синхронизируйте действия перед закрытием смены']);
  assert.deepEqual(f.events, []);
  assert.deepEqual([...f.storage.entries()], before, 'Removing photos must not erase a pending trip, arrival, TTN, timer reset, notification or timesheet');
  assert.deepEqual(JSON.parse(f.storage.get(f.journalKey)), queued);

  f = fixture();
  await f.context.closeShift();
  assert.deepEqual(f.errors, []);
  assert.equal(f.archives.length, 1, 'Resumable close records even an empty shift before final deletion');
  assert.equal(f.archives[0].logs.length, 0);
  assert.equal(f.archives[0].photoShiftIds, undefined);
  assert.equal(f.env.read('shift','current'), undefined, 'An empty shift can close without waiting for any photo service');

  const logs = [
    {truckId: 'truck', truckName: 'Truck 1', volume: 12, timestamp: 1000, timeStr: '10:00', createdBy: 'Operator', createdByEmail: 'operator@example.test', isGAI: false},
    {truckId: 'truck', truckName: 'Truck 1', volume: 18, timestamp: 2000, timeStr: '11:00', createdBy: 'Operator', createdByEmail: 'operator@example.test', isGAI: false}
  ];
  f = fixture({logs});
  const retainedStorage=[...f.storage.entries()];
  await f.context.closeShift();
  assert.deepEqual([...f.storage.entries()],retainedStorage,'Closing a shift must not touch stored notifications, timesheets or legacy photos');
  assert(f.env.read('logs','foreign'));assert(f.env.read('truckStatus','foreign'));
  assert.deepEqual(f.errors, []);
  assert.equal(f.archives.length, 1);
  assert.equal(f.archives[0].sourceShiftId, 'shift');
  assert.equal(f.archives[0].objectId, 'object');
  assert.equal(f.archives[0].totalTrips, 2);
  assert.equal(f.archives[0].totalVolume, 30);
  assert.deepEqual(f.archives[0].ttnStatus, {truck: true});
  assert.deepEqual(f.archives[0].logs.map(row => row.volume), [12, 18]);
  assert(f.events.indexOf('archive') < f.events.indexOf('cleanup'), 'Trip archive must be saved before cleanup');

  f.context.state.archive = [{id: 'archive', date: '2026-10-26', objectName: 'Object', objectId: 'object', logs, totalVolume: 30, activeLineIds: ['truck'], ttnStatus: {truck: true}}];
  f.context.renderArchive();
  assert(f.element('archiveContainer').innerHTML.includes('30'));
  assert(!f.element('archiveContainer').innerHTML.includes('data-photo-object'));
  f.context.openArchiveModal('archive');
  assert(f.element('modalArchiveBody').innerHTML.includes('paper-table'), 'Archive report remains available with no photo hook');
  assert(f.element('modalArchiveBody').innerHTML.includes('30'));

  console.log('PASS photo removal: 24 mixed business operations preserved; sync counts stay honest; empty/nonempty shifts close without photo service; trips, TTN and archive report retained');
})().catch(error => {console.error(error); process.exitCode = 1;});
