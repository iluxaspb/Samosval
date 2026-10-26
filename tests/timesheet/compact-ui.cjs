const fs=require('fs'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const dom=new JSDOM('<!doctype html><div id="tab-timesheet" class="tab-content active"></div>',{url:'https://compact-qa.example/',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window;w.indexedDB=require('./memory-idb.cjs')();w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
const wait=async test=>{for(let i=0;i<300;i++){if(test())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out: '+test.toString()+'\n'+w.document.body.textContent.slice(-1800));};
const q=s=>w.document.querySelector(s),click=s=>{assert(q(s),s);q(s).click();},submit=()=>q('dialog form').dispatchEvent(new w.Event('submit',{cancelable:true}));
const key=id=>[...w.__rows.keys()].find(k=>k.includes('/timesheetEntries/')&&k.endsWith('~'+id)),record=id=>w.__rows.get(key(id));
const input=id=>[...w.document.querySelectorAll('.ts-inline-hours')].find(e=>e.dataset.id.endsWith('~'+id));
const row=id=>input(id)?.closest('.ts-entry-row');
const change=(id,value)=>{const e=input(id);e.focus();e.value=value;e.dispatchEvent(new w.Event('input',{bubbles:true}));e.dispatchEvent(new w.Event('change',{bubbles:true}));e.blur();};
const pulse=(id,action,value)=>{const selector=action==='hours-step'?`[data-action="${action}"][data-delta="${value}"]`:`[data-action="${action}"][data-value="${value}"]`;const b=row(id).querySelector(selector);assert(b,selector);b.click();};
w.eval(fs.readFileSync('tests/timesheet/fixture.js','utf8'));
for(const [id,name,group]of [['w1','Рабочий Один','worker'],['w2','Рабочий Два','worker'],['i1','Инженер','itr']])w.__rows.set('workspaces/main_workspace/timesheetPeople/'+id,{name,group,deleted:false,revision:1});
w.__rows.get('workspaces/main_workspace/timesheetEquipment/w205').crewIds.push('w1','i1');
w.eval(fs.readFileSync('test-app/src/features/timesheet-core.js','utf8'));w.eval(fs.readFileSync('test-app/src/features/timesheet-app.js','utf8'));
(async()=>{try{
 await wait(()=>q('[data-action="add-equipment"]'));await wait(()=>w.document.body.textContent.includes('Данные подтверждены'));
 click('[data-view=catalog]');click('[data-action="catalog-group"][data-group=equipment]');click('[data-action=catalog][data-id=w205]');assert.equal(w.document.querySelectorAll('dialog input[name=crew]').length,0);q('dialog [data-close]').click();console.log('PASS equipment catalog has no permanent crew assignments');
 click('[data-view=day]');click('[data-action="add-equipment"]');assert.deepEqual([...w.document.querySelectorAll('dialog input[name=operatorIds]')].map(e=>e.value).sort(),['p1','p2','p3']);assert([...w.document.querySelectorAll('dialog input[name=operatorIds]')].every(e=>!e.checked));for(const box of w.document.querySelectorAll('dialog input[name=operatorIds]'))box.checked=true;submit();await wait(()=>!q('dialog'));await wait(()=>record('p3'));assert(!record('w1'));assert(!record('i1'));console.log('PASS only operators selected in the shift are attached; legacy catalog crews are ignored');
 for(const group of ['worker','itr']){click('[data-action="add-person"][data-group="'+group+'"]');for(const box of w.document.querySelectorAll('dialog input[name=ids]'))box.checked=true;submit();await wait(()=>!q('dialog'));}await wait(()=>record('i1'));
 for(const [g,n]of [['worker','2'],['itr','1'],['operator','3'],['equipment','1']])assert.equal(q(`[data-summary=${g}] strong`).textContent,n);
 assert.equal(q('section[data-group=worker]').querySelectorAll('.ts-entry-row').length,2);console.log('PASS separate worker, ITR, operator and equipment counts/sections');
 pulse('w1','hours-preset','12');await wait(()=>record('w1').minutes===720);assert(!q('dialog'));
 pulse('w1','hours-preset','13');pulse('w1','hours-step','1');pulse('w1','hours-step','1');await wait(()=>record('w1').minutes===900);
 pulse('w1','hours-step','-1');await wait(()=>record('w1').minutes===840);console.log('PASS presets and rapid plus/minus clicks preserve every step without opening a modal');
 change('w1','8,5');await wait(()=>record('w1').minutes===510);assert(!q('dialog'));console.log('PASS arbitrary decimal hours saved from native numeric input');
 change('w1','25');await wait(()=>input('w1').getAttribute('aria-invalid')==='true');assert.equal(record('w1').minutes,510);w.renderAll();assert.equal(input('w1').value,'25');console.log('PASS invalid hours are not saved and draft/error survive rerender');
 pulse('w1','hours-preset','13');await wait(()=>record('w1').minutes===780);await wait(()=>input('w1').value==='13');await wait(()=>w.document.body.textContent.includes('Данные подтверждены'));assert(!q('[data-action=conflict]'));
 pulse('w1','hours-step','1');await wait(()=>record('w1').minutes===840);pulse('w1','hours-step','-1');await wait(()=>record('w1').minutes===780);assert(!q('[data-action=conflict]'));
 // Clicking an unchanged preset also replaces any unsaved typed draft.
 input('w1').focus();input('w1').value='8';input('w1').dispatchEvent(new w.Event('input',{bubbles:true}));pulse('w1','hours-preset','13');await wait(()=>input('w1').value==='13');input('w1').blur();assert.equal(record('w1').minutes,780);
 assert(q('section[data-group=worker] #ts-workers-hours'));assert(!q('[data-action=bulk]'));assert(!q('dialog'));click('[data-action=workers-value][data-value="13"]');click('[data-action=workers-apply]');await wait(()=>record('w1').minutes===780&&record('w2').minutes===780);assert.equal(record('i1').minutes,null);assert.equal(record('p2').minutes,null);assert.equal(record('w205').minutes,null);assert.equal(q('[data-summary=worker] small').textContent,'26 чел.-ч');console.log('PASS bulk worker hours exclude ITR, operators and equipment');
 global.__failIdbWrites=true;change('i1','10');await wait(()=>input('i1').getAttribute('aria-invalid')==='true');w.renderAll();assert.equal(input('i1').value,'10');assert.equal(record('i1').minutes,null);global.__failIdbWrites=false;change('i1','10');await wait(()=>record('i1').minutes===600);console.log('PASS failed local inline write retains draft and supports retry');
 await wait(()=>w.document.body.textContent.includes('Данные подтверждены'));assert(!q('[data-action=conflict]'));
 // The record observed when typing began must win over a later local snapshot.
 const e=input('w1');e.focus();e.value='10';e.dispatchEvent(new w.Event('input',{bubbles:true}));const old=record('w1');w.__rows.set(key('w1'),{...old,minutes:660,revision:old.revision+1});w.__notify();await new Promise(r=>setTimeout(r,20));e.dispatchEvent(new w.Event('change',{bubbles:true}));e.blur();await wait(()=>q('[data-action=conflict]'));assert.equal(record('w1').minutes,660);console.log('PASS inline edit uses focus-time revision and cannot overwrite a concurrent edit');
 click('[data-action=conflict]');click('[data-action=resolve-server]');await wait(()=>!q('dialog'));
 w.currentUserRole='viewer';w.renderAll();assert.equal(w.document.querySelectorAll('.ts-inline-hours').length,0);assert(!q('[data-action=workers-apply]'));console.log('PASS read-only role gets no inline write controls');
 console.log('ALL COMPACT TIMESHEET UI TESTS PASSED');
}catch(e){console.error(e);console.error(w.__messages);process.exitCode=1;}finally{await w.Timesheet.dispose();dom.window.close();}})();
