const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// Always exercise the TEST release's actual modular shift code, not the
// obsolete inline HTML from before the module split.
const moduleSource = fs.readFileSync('test-app/source/core/15-shifts.js', 'utf8');
const first = moduleSource.indexOf('  async function cleanupOldShiftData(');
const last = moduleSource.indexOf('  function openStartShiftModal(', first);
assert(first >= 0 && last > first, 'Shift lifecycle module boundaries missing');
let source = moduleSource.slice(first, last);
assert(source.includes('async function closeShift()'));
// Only the separately tested material transfer service is substituted: the
// shift transaction, archive and destructive cleanup remain the real code.
const transfer = /const module=await import\(new URL\('\.\/test-app\/tabel-v2\/material-transfer\.mjs',document\.baseURI\)\.href\);\s*await module\.transferClosedLine\([^;]+\);/;
assert(transfer.test(source), 'Expected material transfer invocation missing');
source = source.replace(transfer, 'await testTransferClosedLine(shift, archived);');
const copy = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));

function fixture({count = 3, role = 'admin', failBatch = 0, failArchive = false, pending = 0, addDuringConfirm = false, concurrentArchive = false} = {}) {
  const rows = new Map(), archives = new Map(), errors = [], events = [], commits = [];
  const shiftPath = 'shift/current';
  rows.set(shiftPath, {id:'s1',isActive:true,objectName:'Object',objectId:'o1',startDate:'2026-10-25'});
  const log = id => ({shiftId:'s1',truckId:'t1',truckName:'Truck',volume:12,timestamp:1000+id,arrivalTimestamp:900+id,timeStr:'12:00',createdBy:'Operator'});
  for(let i=0;i<count;i++)rows.set('logs/l'+i,log(i));
  rows.set('truckStatus/t1',{shiftId:'s1',onLine:true,ttnStatus:true,arriveTimestamp:2000});
  rows.set('logs/foreign',{shiftId:'s2',truckId:'foreign',volume:99,timestamp:3000});
  rows.set('truckStatus/foreign',{shiftId:'s2',onLine:true});
  let batchNumber=0, archiveSets=0, maxCalls=0, confirms=0, transfers=0;
  const storage = new Map();
  const button={textContent:'Close shift',disabled:false};
  let ctx;
  const snap = path => {const data=copy(rows.get(path));return {id:path.split('/').at(-1),ref:ref(path),exists:rows.has(path),data:()=>copy(data)};};
  const updateState = () => { ctx.state.shift = copy(rows.get(shiftPath)) || null; };
  const ref = path => ({path,id:path.split('/').at(-1),get:async()=>{
    const snapshot=snap(path);
    if(concurrentArchive&&path==='archive/closed_s1'){
      concurrentArchive=false;
      // Another device saves all trips after this missing snapshot, then starts cleanup.
      const full={sourceShiftId:'s1',logs:[...rows.entries()].filter(([p,d])=>p.startsWith('logs/')&&d.shiftId==='s1').map(([p,d])=>({id:p.split('/').at(-1),...copy(d)})),totalTrips:count,totalVolume:count*12};
      rows.set(path,copy(full));archives.set(path,copy(full));events.push('competing-archive');
      rows.delete('logs/l0');rows.delete('logs/l1');
    }
    return snapshot;
  },set:async data=>{
    if(path.startsWith('archive/')){
      if(failArchive){failArchive=false;throw Error('Archive unavailable');}
      archiveSets++;archives.set(path,copy(data));events.push('archive');
    }
    rows.set(path,copy(data));
  }});
  const collection = name => ({doc:id=>ref(name+'/'+(id||'random-'+Math.random())),get:async()=>{
    const docs=[...rows.keys()].filter(p=>p.startsWith(name+'/')).map(snap);
    return {docs,size:docs.length,forEach:f=>docs.forEach(f)};
  }});
  const db = {
    runTransaction:async callback=>{
      const writes=[];
      const result=await callback({get:async r=>snap(r.path),set:(r,d)=>writes.push(['set',r.path,d]),update:(r,d)=>writes.push(['update',r.path,d]),delete:r=>writes.push(['delete',r.path])});
      if(failArchive&&writes.some(([kind,path])=>kind==='set'&&path.startsWith('archive/'))){failArchive=false;throw Error('Archive unavailable');}
      for(const [kind,path,data] of writes){
        if(kind==='delete'){rows.delete(path);events.push('delete-shift');}
        else if(kind==='set'){
          rows.set(path,copy(data));
          if(path.startsWith('archive/')){archiveSets++;archives.set(path,copy(data));events.push('archive');}
        }else{rows.set(path,{...rows.get(path),...copy(data)});events.push('freeze');}
      }
      updateState();return result;
    },
    batch:()=>{
      const deletes=[];
      const batch={delete:r=>{deletes.push(r.path);return batch;},commit:async()=>{
        commits.push(deletes.length);batchNumber++;
        assert(deletes.length<=500,'Firestore write limit exceeded');
        if(batchNumber===failBatch)throw Error('Cleanup interrupted');
        for(const path of deletes){rows.delete(path);events.push('delete-record');}
      }};return batch;
    }
  };
  ctx={isNasRuntime:()=>false,db,refs:{logs:collection('logs'),truckStatus:collection('truckStatus'),archive:collection('archive'),shift:ref(shiftPath)},currentUserRole:role,
    state:{shift:copy(rows.get(shiftPath)),logs:[],truckStatus:{}},requireEdit:()=>true,offlinePendingCount:()=>pending,
    document:{getElementById:()=>button},appConfirm:async()=>{confirms++;if(addDuringConfirm){rows.set('logs/during-confirm',log(5000));addDuringConfirm=false;}return true;},
    tfAwait:p=>p,getUserName:()=> 'Operator',showError:s=>errors.push(s),appNotice:s=>errors.push(s),showToastEl:s=>events.push(s),
    addAudit:async()=>{},clearAllNotifications:async()=>{},offlineProjectState(){},renderAll(){},
    testTransferClosedLine:async(shift, archived)=>{assert.equal(shift.id,'s1');assert.equal(archived.sourceShiftId,'s1');transfers++;events.push('material-transfer');},
    localStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)||null},
    firebaseConfig:{projectId:'samosval-offline'},WORKSPACE_ID:'fixture',
    sendShiftReportToMax:()=>{maxCalls++;return new Promise(()=>{});},appConfig:{maxEnabled:true,maxUrl:'https://unused.invalid',notifyPdfMain:true},
    console:{error(){}},Date,Math,Map,Set};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const close=async()=>{
    let timer;
    try {await Promise.race([ctx.closeShift(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Closing blocked on report or another pending task')),1000))]);}
    finally{clearTimeout(timer);}
  };
  return {ctx,rows,archives,errors,events,commits,button,storage,close,stats:()=>({archiveSets,maxCalls,confirms,transfers}),liveLogs:()=>[...rows.keys()].filter(p=>p.startsWith('logs/')&&rows.get(p).shiftId==='s1')};
}

(async()=>{
  const large=fixture({count:521,addDuringConfirm:true});await large.close();
  assert.equal(large.errors.length,0);assert.equal(large.ctx.state.shift,null);assert.equal(large.rows.has('shift/current'),false);
  assert.equal(large.archives.size,1);const archived=[...large.archives.values()][0];
  assert.equal(archived.logs.length,522);assert(archived.logs.some(l=>l.id==='during-confirm'));
  assert.equal(archived.sourceShiftId,'s1');assert.equal(archived.totalVolume,522*12);
  assert.equal(large.liveLogs().length,0);assert(large.rows.has('logs/foreign'));assert(large.rows.has('truckStatus/foreign'));
  assert(large.commits.every(n=>n<=20));assert.equal(large.stats().maxCalls,0);assert(!large.button.disabled);
  assert(large.events.indexOf('freeze')<large.events.indexOf('archive'));
  assert(large.events.indexOf('archive')<large.events.indexOf('material-transfer'));
  assert(large.events.indexOf('material-transfer')<large.events.indexOf('delete-record'));
  assert.equal(large.stats().transfers,1);
  assert.deepEqual(JSON.parse(large.storage.get('tabel-v2-last-closed:samosval-offline:fixture')), {objectId:'o1',closedAt:large.ctx.state.shift?.closingStartedAt || JSON.parse(large.storage.get('tabel-v2-last-closed:samosval-offline:fixture')).closedAt});
  console.log('PASS close: freezes shift, archives server-confirmed records including confirmation-window trip, cleans 522 trips in bounded chunks, preserves other shifts, no MAX report wait');

  const retry=fixture({count:55,failBatch:2});await retry.close();
  assert.equal(retry.errors.length,1);assert.equal(retry.archives.size,1);assert.equal([...retry.archives.values()][0].logs.length,55);
  assert.equal(retry.liveLogs().length,35);assert.equal(retry.ctx.state.shift.closing,true);assert.equal(retry.ctx.state.shift.isActive,false);
  await retry.close();assert.equal(retry.ctx.state.shift,null);assert.equal(retry.liveLogs().length,0);
  assert.equal(retry.archives.size,1);assert.equal(retry.stats().archiveSets,1);assert.equal([...retry.archives.values()][0].logs.length,55);
  console.log('PASS retry: interrupted partial cleanup retains complete archive and closing marker; retry completes without duplicate or truncated archive');

  const racing=fixture({count:7,concurrentArchive:true});await racing.close();
  assert.equal(racing.errors.length,0);assert.equal(racing.ctx.state.shift,null);
  assert.equal(racing.archives.size,1);assert.equal(racing.stats().archiveSets,0);
  assert.equal([...racing.archives.values()][0].logs.length,7);assert.equal([...racing.archives.values()][0].totalTrips,7);
  assert.equal(racing.liveLogs().length,0);
  console.log('PASS concurrent closer: archive appearing after initial read is reused transactionally; full seven-trip archive is not overwritten by five remaining live trips');

  const denied=fixture({count:6,failArchive:true,role:'foreman'});await denied.close();
  assert.equal(denied.liveLogs().length,6);assert.equal(denied.archives.size,0);assert.equal(denied.commits.length,0);assert(denied.ctx.state.shift.closing);
  await denied.close();assert.equal(denied.ctx.state.shift,null);assert(denied.commits.every(n=>n<=4));
  console.log('PASS archive failure preserves live trips; retry works with four-record non-admin batches');

  const guarded=fixture({pending:1});await guarded.close();assert.equal(guarded.archives.size,0);assert.equal(guarded.stats().confirms,0);assert(guarded.ctx.state.shift.isActive);
  const conflict=fixture({count:2});const expected='archive/closed_s1';conflict.rows.set(expected,{sourceShiftId:'other',logs:[]});await conflict.close();assert.equal(conflict.liveLogs().length,2);assert.equal(conflict.commits.length,0);assert(conflict.errors.length);
  assert.equal(guarded.storage.size,0, 'No successful close must not save a last address');
  const empty=fixture({count:0});await empty.close();
  assert.equal(empty.errors.length,0);
  const lastClosed=JSON.parse(empty.storage.get('tabel-v2-last-closed:samosval-offline:fixture'));
  assert.equal(lastClosed.objectId,'o1', 'Even a zero-trip shift records its last address');
  assert.equal(empty.archives.size,0, 'Zero-trip closure does not invent an archive');
  console.log('PASS pending queue and unrelated pre-existing archive block destructive cleanup; zero-trip address retained');
})().catch(error=>{console.error(error);process.exitCode=1;});
