'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const gate=()=>{let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};};
function fixture({memory=require('./memory-idb.cjs')(),holdOpen=false,rows}={}){
 const dom=new JSDOM('<!doctype html><div id="tab-timesheet" class="active"></div>',{url:'https://lifecycle-qa.example/',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,errors=[],opens=[],intervals=new Set();let closes=0;
 w.addEventListener('error',event=>errors.push(event.error));
 const nativeSetInterval=w.setInterval.bind(w),nativeClearInterval=w.clearInterval.bind(w);
 w.setInterval=(...args)=>{const id=nativeSetInterval(...args);intervals.add(id);return id;};
 w.clearInterval=id=>{intervals.delete(id);nativeClearInterval(id);};
 w.indexedDB={open(name){const req={};const start=()=>{const underlying=memory.open(name);underlying.onupgradeneeded=()=>{req.result=underlying.result;req.onupgradeneeded?.();};underlying.onsuccess=()=>{req.result=underlying.result;const close=req.result.close;req.result.close=()=>{closes++;close();};req.onsuccess?.();};underlying.onerror=()=>{req.error=underlying.error;req.onerror?.();};};opens.push({name,start});if(!holdOpen)start();return req;}};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 w.eval(fs.readFileSync('tests/timesheet/fixture.js','utf8'));
 if(rows)w.__rows=new Map(rows);
 w.eval(fs.readFileSync('test-app/src/features/timesheet-core.js','utf8'));
 const originalRender=w.renderAll,originalStop=w.stopSync;
 w.eval(fs.readFileSync('test-app/src/features/timesheet-app.js','utf8'));
 const q=selector=>w.document.querySelector(selector);
 const wait=async predicate=>{for(let i=0;i<400;i++){assert.equal(errors.length,0,errors[0]?.stack);if(predicate())return;await pause(5);}throw Error('Timed out: '+predicate);};
 const ready=async()=>{await wait(()=>q('[data-action=add-equipment]'));await w.Timesheet.whenIdle();};
 const addEquipment=()=>{q('[data-action=add-equipment]').click();for(const box of w.document.querySelectorAll('dialog input[name=operatorIds]'))box.checked=true;q('dialog form').dispatchEvent(new w.Event('submit',{cancelable:true}));};
 const cleanup=async()=>{await w.Timesheet.dispose();assert.equal(errors.length,0,errors[0]?.stack);dom.window.close();};
 return {dom,w,memory,errors,opens,intervals,get closes(){return closes;},q,wait,ready,addEquipment,cleanup,originalRender,originalStop};
}
async function storedJobs(memory,user='qa-admin'){
 const req=memory.open('dt_timesheet_v1_samosval-offline_main_workspace_'+user);
 const database=await new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
 try{return await new Promise((resolve,reject)=>{const tx=database.transaction('jobs','readonly'),request=tx.objectStore('jobs').getAll();tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);});}finally{database.close();}
}
(async()=>{
 let a=fixture({holdOpen:true});
 try{
  await pause(0);assert.equal(a.opens.length,1);
  let disposed=false;const closing=a.w.Timesheet.dispose().then(()=>disposed=true);await pause(0);
  assert.equal(disposed,false,'disposal awaits the real open request');
  a.opens[0].start();await closing;
  assert.equal(a.closes,1);assert.equal(a.w.__subscriptions.length,0);assert.equal(a.w.__authListeners.length,0);assert.equal(a.intervals.size,0);
  assert.equal(a.w.renderAll,a.originalRender);assert.equal(a.w.stopSync,a.originalStop);
  a.w.dispatchEvent(new a.w.Event('online'));a.w.dispatchEvent(new a.w.Event('pageshow'));await a.w.Timesheet.session();await a.w.Timesheet.dispose();
  assert.equal(a.opens.length,1);assert.equal(a.q('#tab-timesheet').innerHTML,'');
  console.log('PASS lifecycle: disposal during IndexedDB open closes the late connection, removes hooks, and cannot restart');
 }finally{await a.cleanup();}

 a=fixture();let savedRows,savedMemory;
 try{
  await a.ready();const delayed=gate(),base=a.w.db.runTransaction;let started=false;
  a.w.db.runTransaction=async callback=>{started=true;await delayed.promise;return base(callback);};
  a.addEquipment();await a.wait(()=>started);
  let disposed=false;const closing=a.w.Timesheet.dispose().then(()=>disposed=true);await pause(0);
  assert.equal(disposed,false,'disposal waits for an already accepted transaction');
  delayed.release();await closing;
  assert.equal(a.w.__subscriptions.length,0);assert.equal(a.w.__authListeners.length,0);assert.equal(a.intervals.size,0);
  assert.equal(a.q('#tab-timesheet').innerHTML,'');assert(!a.w.__messages.some(x=>x.startsWith('ERROR:')));
  assert.equal((await storedJobs(a.memory)).length,1,'lost acknowledgement remains durably queued for its original account');
  savedRows=[...a.w.__rows];savedMemory=a.memory;
  assert.equal(savedRows.filter(([key])=>key.includes('/timesheetChanges/')).length,1);
  console.log('PASS lifecycle: accepted commit can settle after disposal without rendering or deleting its unacknowledged durable job');
 }finally{await a.cleanup();}
 a=fixture({memory:savedMemory,rows:savedRows});
 try{
  await a.ready();assert.equal((await storedJobs(a.memory)).length,0);
  assert.equal([...a.w.__rows.keys()].filter(key=>key.includes('/timesheetChanges/')).length,1);
  assert.equal([...a.w.__rows.keys()].filter(key=>key.includes('/timesheetEntries/')).length,4);
  console.log('PASS lifecycle: reopening replays the retained receipt idempotently, with no duplicate people, machine or history');
 }finally{await a.cleanup();}

 a=fixture();
 try{
  await a.ready();const delayed=gate();let started=false;
  a.w.db.runTransaction=async()=>{started=true;await delayed.promise;const error=Error('Previous account was denied');error.code='permission-denied';throw error;};
  a.addEquipment();await a.wait(()=>started);
  a.w.currentUid='qa-other';for(const listener of [...a.w.__authListeners])listener({uid:'qa-other'});
  await a.wait(()=>a.q('[data-action=add-equipment]')&&a.w.document.body.textContent.includes('Данные подтверждены сервером'));
  const messages=a.w.__messages.length;delayed.release();await a.w.Timesheet.whenIdle();
  assert.equal(a.w.currentUid,'qa-other');assert(!a.w.document.body.textContent.includes('ожидают отправки'));assert.equal(a.w.__messages.length,messages);
  assert.equal((await storedJobs(a.memory,'qa-other')).length,0);
  const oldJobs=await storedJobs(a.memory);assert.equal(oldJobs.length,1);assert.equal(oldJobs[0].status,'queued');
  console.log('PASS lifecycle: old-account commit failure cannot alter the active account UI, messages, or isolated durable queue');
 }finally{await a.cleanup();}

 a=fixture();
 try{
  await a.ready();a.addEquipment();await a.w.Timesheet.whenIdle();
  const input=a.q('.ts-inline-hours');input.focus();input.value='8,5';input.dispatchEvent(new a.w.Event('input',{bubbles:true}));
  const hidden=new a.w.Event('pagehide');Object.defineProperty(hidden,'persisted',{value:true});a.w.dispatchEvent(hidden);
  assert.equal(a.intervals.size,0);assert.equal(a.q('.ts-inline-hours'),input);assert.equal(input.value,'8,5');
  a.w.dispatchEvent(new a.w.Event('pageshow'));await a.w.Timesheet.whenIdle();
  assert.equal(a.intervals.size,1);assert.equal(a.q('.ts-inline-hours'),input);assert.equal(input.value,'8,5');
  input.dispatchEvent(new a.w.Event('change',{bubbles:true}));input.blur();await a.w.Timesheet.whenIdle();
  assert.equal(a.w.__rows.get('workspaces/main_workspace/timesheetEntries/'+input.dataset.id).minutes,510);
  a.w.dispatchEvent(new a.w.Event('pagehide'));await a.w.Timesheet.whenIdle();
  assert.equal(a.w.__subscriptions.length,0);assert.equal(a.w.__authListeners.length,0);assert.equal(a.intervals.size,0);
  console.log('PASS lifecycle: cached Back/Forward navigation preserves an unsaved hours draft; final navigation disposes all resources');
 }finally{await a.cleanup();}
 console.log('ALL TIMESHEET LIFECYCLE TESTS PASSED');
})().catch(error=>{console.error(error);process.exitCode=1;});
