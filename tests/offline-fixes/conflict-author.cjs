// Exercise the real offline replay using the existing server/storage harness.
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const original=fs.readFileSync(path.join(__dirname,'verify-offline-fixes.cjs'),'utf8');
const harness={require,console,__dirname,process};vm.createContext(harness);
vm.runInContext(original.slice(0,original.indexOf('(async()=>{'))+'\nglobalThis.makeFixture=make;',harness);
const make=harness.makeFixture;
function prepare(type){
  const f=make(),c=f.c;f.messages=[];
  c.escapeHtml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  c.showToastEl=(s)=>f.messages.push(s);
  if(type==='arrive'){f.server.status.arriveStatus=null;f.server.status.arriveTimestamp=null;c.state.truckStatus.t={...f.server.status};vm.runInContext('offlineRemoteStatuses={t:{...state.truckStatus.t}}',c);}
  assert(c.offlineQueueAction(type,'t',{shiftId:'s',status:{...c.state.truckStatus.t}}));
  f.op=c.offlineJournalRead()[0];return f;
}
async function replay(f){f.c.navigator.onLine=true;await f.c.offlineReplayJournal();return f.c.offlineJournalRead()[0];}
(async()=>{
  let f=prepare('load');
  // The current status may already belong to a later cycle: the original log wins.
  f.server.logs.set(f.op.logId,{truckId:'t',shiftId:'s',arrivalTimestamp:f.op.arrivalTimestamp,createdBy:'Иван Петров',timestamp:f.op.createdAt,clientOperationId:'other'});
  Object.assign(f.server.status,{cycleRevision:9,lastLoadBy:'Другой водитель',lastLoadTimestamp:f.op.createdAt+100000,arriveStatus:null,loadedAfterArrive:true});
  let saved=await replay(f);
  assert.equal(saved.status,'rejected');assert.equal(f.server.logs.size,1);
  assert.match(saved.conflictDetails,/Иван Петров/);assert(!saved.conflictDetails.includes('Другой водитель'));
  assert.match(f.messages.at(-1),/Погрузка/);assert.match(f.messages.at(-1),/Повторный рейс не добавлен/);
  // Persisted details remain available after reopening diagnostics, with the switch respected.
  const persisted=JSON.parse([...f.storage.values()][0])[0];assert.equal(persisted.conflictDetails,saved.conflictDetails);
  f.c.appConfig.testReviewFlags={conflict_author:false};
  assert.equal(f.c.offlineReasonLabel(saved.result,saved.conflictDetails),'Повторный рейс не добавлен');

  f=prepare('arrive');Object.assign(f.server.status,{cycleRevision:2,arriveStatus:'12:00',arriveTimestamp:f.op.createdAt,arriveBy:'Мария Соколова'});
  saved=await replay(f);assert.equal(saved.status,'rejected');assert.match(saved.conflictDetails,/Приехал/);assert.match(saved.conflictDetails,/Мария Соколова/);assert.equal(f.server.status.cycleRevision,2);

  f=prepare('ttn');Object.assign(f.server.status,{ttnRevision:1,ttnStatus:true,ttnBy:'Пётр <img src=x onerror=alert(1)>'});
  saved=await replay(f);assert.equal(saved.status,'rejected');assert.match(saved.conflictDetails,/Забрал ТТН/);assert(f.messages.at(-1).includes('&lt;img'));assert(!f.messages.at(-1).includes('<img'));

  f=prepare('load');f.server.logs.set(f.op.logId,{truckId:'t',shiftId:'s',arrivalTimestamp:f.op.arrivalTimestamp,clientOperationId:'other'});
  saved=await replay(f);assert.match(saved.conflictDetails,/Автор отметки не сохранён/);
  // A mismatched legacy record must not identify an unrelated user.
  f=prepare('load');f.server.logs.set(f.op.logId,{truckId:'other',shiftId:'other',createdBy:'Чужой автор',clientOperationId:'other'});
  saved=await replay(f);assert(!saved.conflictDetails.includes('Чужой автор'));

  f=prepare('arrive');Object.assign(f.server.status,{cycleRevision:3,arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false});
  saved=await replay(f);assert.match(saved.conflictDetails,/Прибытие уже изменено/);assert.match(saved.conflictDetails,/Автор изменения не сохранён/);

  f=prepare('arrive');f.c.appConfig.testReviewFlags={conflict_author:false};Object.assign(f.server.status,{cycleRevision:2,arriveStatus:'12:00',arriveTimestamp:f.op.createdAt,arriveBy:'Мария Соколова'});
  await replay(f);assert(!f.messages.at(-1).includes('Мария'));assert.equal(f.server.status.cycleRevision,2);
  console.log('PASS named arrival/load/TTN conflicts, original-cycle author, escaping, missing legacy author, persistence and reversible switch');
})().catch(e=>{console.error(e);process.exitCode=1;});
