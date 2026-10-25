'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const source=fs.readFileSync(process.env.TIMESHEET_AUDIT_SOURCE||'test-app/src/features/timesheet-app.js','utf8');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture({failOpen=false}={}){
 const dom=new JSDOM('<!doctype html><div id="tab-timesheet" class="active"></div>',{url:'https://ledger-audit.example/',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,errors=[];w.addEventListener('error',e=>errors.push(e.error));
 const memory=require('../timesheet/memory-idb.cjs')();let first=failOpen;
 w.indexedDB={open(...args){if(first){first=false;const req={error:Error('Temporary IndexedDB failure')};queueMicrotask(()=>req.onerror?.());return req;}return memory.open(...args);}};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 w.eval(fs.readFileSync('tests/timesheet/fixture.js','utf8'));
 w.eval("var ALL_TABS=['line','timesheet','admin'],FORCED_ADMIN_EMAIL='owner@example.com';var permissionsConfig={viewer:{tabs:['timesheet'],actions:[]},master:{tabs:['timesheet'],actions:['timesheet_edit','timesheet_manage']}};");
 w.eval(fs.readFileSync('test-app/src/core/04-permissions.js','utf8'));
 w.state.objects[0].name='<img src=x onerror="window.pwned=true">';
 w.__rows.get('workspaces/main_workspace/timesheetEquipment/w205').name='Фреза <svg onload="window.pwned=true">';
 w.eval(fs.readFileSync('test-app/src/features/timesheet-core.js','utf8'));w.eval(source);
 const q=s=>w.document.querySelector(s),click=s=>{assert(q(s),s);q(s).click();},submit=()=>q('dialog form').dispatchEvent(new w.Event('submit',{cancelable:true}));
 const wait=async fn=>{for(let i=0;i<300;i++){if(errors.length)throw errors[0];if(fn())return;await pause(10);}throw Error('Timed out '+fn+'\n'+w.document.body.textContent.slice(-1000));};
 return {dom,w,q,click,submit,wait,errors};
}
(async()=>{
 let a;
 try{
  a=await fixture({failOpen:true});
  await a.wait(()=>a.w.document.body.textContent.includes('Temporary IndexedDB failure'));
  await a.w.Timesheet.session();await a.wait(()=>a.q('[data-action=add-equipment]'));
  console.log('PASS transient IndexedDB open failure recovers in the same session without logout or clearing stored jobs');
 }finally{a?.dom.window.close();}
 try{
  a=await fixture();const {w,q,click,submit,wait}=a;
  await wait(()=>q('[data-action=add-equipment]'));
  assert.equal(q('img,svg'),null);assert.equal(w.pwned,undefined);
  click('[data-action=add-equipment]');assert.equal(q('dialog img,dialog svg'),null);
  for(const input of w.document.querySelectorAll('dialog input[name=operatorIds]'))input.checked=true;
  submit();submit();await wait(()=>!q('dialog'));await wait(()=>[...w.__rows.keys()].filter(k=>k.includes('/timesheetEntries/')).length===4);
  assert.equal([...w.__rows.keys()].filter(k=>k.includes('/timesheetEntries/')).length,4);
  console.log('PASS escaped object/equipment names and repeated modal submit creates one machine plus three personal rows');
  click('[data-view=catalog]');click('[data-action=catalog-group][data-group=worker]');click('[data-action=catalog]:not([data-id])');
  q('[name=name]').value='Cancel this draft';q('dialog [data-close]').click();await pause(20);
  assert(![...w.__rows.values()].some(row=>row.name==='Cancel this draft'));
  console.log('PASS cancelling a catalog form creates no person or history record');
  click('[data-view=day]');w.currentUserRole='viewer';w.Timesheet.render();
  assert.equal(q('[data-action=add-equipment]'),null);assert.equal(q('.ts-inline-hours'),null);
  click('[data-action=entry]');assert.equal(q('dialog [type=submit]'),null);assert([...w.document.querySelectorAll('dialog input,dialog select,dialog textarea')].every(x=>x.disabled));q('dialog [data-close]').click();
  click('[data-view=month]');assert.equal(q('[data-action=export]'),null);
  console.log('PASS viewer sees ledger but cannot edit fields, submit forms, add records or export without the grant');
  w.currentUserRole='admin';w.Timesheet.render();click('[data-view=day]');
  const hours=q('.ts-inline-hours');assert(hours);hours.focus();assert.equal(w.document.activeElement,hours);
  w.currentUserRole='viewer';w.permissionsConfig.viewer.tabs=[];w.Timesheet.render();
  assert(q('#tab-timesheet').textContent.includes('Нет доступа'));assert.equal(q('.ts-inline-hours'),null);assert.equal(q('dialog'),null);
  console.log('PASS revoking tab access clears personal rows immediately even with a focused hours input');
  await w.Timesheet.session();assert.equal(w.__subscriptions.length,0);
  console.log('PASS revoked tab access unsubscribes from ledger data and closes the account local session');
 }finally{a?.dom.window.close();}
 console.log('ALL PERMISSIONS/TIMESHEET UI AUDIT TESTS PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});
