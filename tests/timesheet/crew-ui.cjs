const fs=require('fs'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const dom=new JSDOM('<!doctype html><div id="tab-timesheet" class="tab-content active"></div>',{url:'https://crew-qa.example/',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window;w.indexedDB=require('./memory-idb.cjs')();w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
const wait=async test=>{for(let i=0;i<1000;i++){if(test())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out: '+test+'\n'+w.document.body.textContent.slice(-2200));};
const q=s=>w.document.querySelector(s),click=s=>{assert(q(s),s);q(s).click();},submit=()=>q('dialog form').dispatchEvent(new w.Event('submit',{cancelable:true}));
const select=(selector,value)=>{const e=q(selector);e.value=value;e.dispatchEvent(new w.Event('change',{bubbles:true}));};
w.eval(fs.readFileSync('tests/timesheet/fixture.js','utf8'));w.eval(fs.readFileSync('assets/timesheet-core.js','utf8'));const C=w.TimesheetCore;
const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date()),root='workspaces/main_workspace/';
w.state.objects.push({id:'obj2',name:'Второй объект'});
for(const [id,name,group]of [['w1','Рабочий Один','worker'],['w2','Рабочий Два','worker'],['i1','Инженер','itr'],['p4','Водитель Четвёртый','operator']])w.__rows.set(root+'timesheetPeople/'+id,{name,group,deleted:false,revision:1});
for(const [id,name,ownership]of [['water','Поливомоечная (помпа)','own'],['brush','Щётка МУП-351','own'],['front','Фронтальный погрузчик','own'],['bus','Автобус ПАЗ','own'],['xcmg','Погрузчик XCMG','own'],['rental','Каток','hired']])w.__rows.set(root+'timesheetEquipment/'+id,{name,ownership,contractor:ownership==='hired'?'Подрядчик':'',crewIds:[],deleted:false,revision:1});
const key=(id,kind='person',obj='obj',shift='day')=>root+'timesheetEntries/'+C.entryId(kind,obj,date,shift,id);
const record=(id,kind='person',obj='obj',shift='day')=>w.__rows.get(key(id,kind,obj,shift));
function seed(id,kind='person',equipmentId=''){
 const entity=w.__rows.get(root+(kind==='person'?'timesheetPeople':'timesheetEquipment')+'/'+id);
 w.__rows.set(key(id,kind),{kind,entityId:id,name:entity.name,group:entity.group||'',ownership:entity.ownership||'',contractor:entity.contractor||'',objectId:'obj',objectName:w.state.objects[0].name,date,shift:'day',scope:C.scope('obj',date),minutes:null,idleMinutes:0,status:'unfilled',equipmentId,note:'',deleted:false,revision:1});
}
for(const id of ['water','brush','w205','front','bus','xcmg','rental'])seed(id,'equipment');
for(const id of ['p1','p2','p3'])seed(id,'person','w205');seed('p4','person','water');for(const id of ['w1','w2','i1'])seed(id);
w.eval(fs.readFileSync('assets/timesheet.js','utf8'));
const crew=()=>q('[data-crew-id=w205]'),crewInput=()=>crew().querySelector('.ts-inline-hours');
const crewPulse=(value,step=false)=>crew().querySelector(step?`[data-action=hours-step][data-delta="${value}"]`:`[data-action=hours-preset][data-value="${value}"]`).click();
const typeHours=(input,value)=>{input.focus();input.value=value;input.dispatchEvent(new w.Event('input',{bubbles:true}));input.dispatchEvent(new w.Event('change',{bubbles:true}));input.blur();};
const idle=()=>w.document.body.textContent.includes('Данные подтверждены сервером')&&!q('[data-action=conflict]');
(async()=>{try{
 await wait(()=>crew());await wait(idle);
 assert.deepEqual([...w.document.querySelectorAll('[data-ownership=own] [data-machine-id]')].map(e=>e.dataset.machineId),['water','brush','w205','front','bus','xcmg']);
 for(const [id,tone]of [['water','water'],['brush','brush'],['w205','mill'],['front','loader'],['bus','bus'],['xcmg','xcmg']])assert(q(`[data-machine-id=${id}]`).classList.contains('ts-tone-'+tone));
 assert.deepEqual([...w.document.querySelectorAll('#tab-timesheet>section')].map(e=>e.dataset.group),['equipment','equipment','materials','itr','worker']);
 assert(crew().textContent.includes('Машинисты фрезы · 3'));assert(q('[data-crew-id=water]').textContent.includes('Водитель поливомойки · 1'));
 for(const name of ['Иван Петров','Сергей Иванов','Алексей Соколов'])assert(!w.document.body.textContent.includes(name));
 assert.equal(w.document.querySelectorAll('[data-action=workers-apply]').length,1);assert(q('section[data-group=worker] #ts-workers-hours'));assert(!q('[data-action=bulk]'));
 console.log('PASS spreadsheet equipment order, colors, paired anonymous crew rows, and only workers have group hours');
 crewPulse('12');await wait(()=>['p1','p2','p3'].every(id=>record(id).minutes===720));assert.equal(record('w205','equipment').minutes,null);assert.equal(record('w1').minutes,null);assert(crew().textContent.includes('36 чел.-ч'));
 crewPulse('13');crewPulse('1',true);crewPulse('1',true);await wait(()=>['p1','p2','p3'].every(id=>record(id).minutes===900));
 typeHours(crewInput(),'8,5');await wait(()=>['p1','p2','p3'].every(id=>record(id).minutes===510));
 typeHours(crewInput(),'25');await wait(()=>crewInput().getAttribute('aria-invalid')==='true');assert.equal(record('p1').minutes,510);
 crewPulse('12');await wait(()=>['p1','p2','p3'].every(id=>record(id).minutes===720));await wait(idle);
 typeHours(q('[data-machine-id=w205]>.ts-entry-row .ts-inline-hours'),'11');await wait(()=>record('w205','equipment').minutes===660);assert.equal(record('p1').minutes,720);
 console.log('PASS common crew hours apply to every operator, rapid +/- and decimals work, machine hours remain independent');
 click('[data-crew-id=w205] [data-action=crew]');assert(q('dialog').textContent.includes('Иван Петров'));q('dialog [data-close]').click();
 // A concurrent edit to one member must reject the whole three-person operation.
 const e=crewInput();e.focus();e.value='10';e.dispatchEvent(new w.Event('input',{bubbles:true}));const old=record('p2');w.__rows.set(key('p2'),{...old,minutes:660,revision:old.revision+1});w.__notify();await new Promise(r=>setTimeout(r,30));e.dispatchEvent(new w.Event('change',{bubbles:true}));e.blur();await wait(()=>q('[data-action=conflict]'));
 assert.equal(record('p1').minutes,720);assert.equal(record('p2').minutes,660);assert.equal(record('p3').minutes,720);
 click('[data-action=conflict]');click('[data-action=resolve-server]');await wait(()=>!q('dialog'));await wait(()=>crew().textContent.includes('Разные часы'));assert.equal(crewInput().getAttribute('placeholder'),'≠');
 crewPulse('1',true);await wait(()=>crewInput().getAttribute('aria-invalid')==='true');assert.equal(record('p2').minutes,660);
 crewPulse('13');await wait(()=>['p1','p2','p3'].every(id=>record(id).minutes===780));await wait(idle);
 console.log('PASS conflict is atomic for three crew members; mixed values remain visible until explicitly replaced');
 Object.defineProperty(w.navigator,'onLine',{value:false,configurable:true});crewPulse('12');await wait(()=>crewInput().value==='12');assert.equal(record('p1').minutes,780);assert(w.document.body.textContent.includes('ожидают отправки'));
 Object.defineProperty(w.navigator,'onLine',{value:true,configurable:true});w.dispatchEvent(new w.Event('online'));await wait(()=>['p1','p2','p3'].every(id=>record(id).minutes===720));await wait(idle);
 console.log('PASS crew hours use durable offline queue and synchronize all members');
 click('[data-view=catalog]');
 for(const [group,name]of [['worker','Новый рабочий'],['operator','Новый машинист'],['itr','Новый ИТР']]){
  click(`[data-action=catalog-group][data-group=${group}]`);click('[data-action=catalog]:not([data-id])');assert.equal(q('dialog [name=group]').value,group);q('dialog [name=name]').value=name;submit();await wait(()=>!q('dialog'));await wait(()=>[...w.__rows.entries()].some(([k,v])=>k.includes('/timesheetPeople/')&&v.name===name&&v.group===group));
 }
 click('[data-action=catalog-group][data-group=equipment]');click('[data-action=catalog][data-id=w205]');assert.equal(w.document.querySelectorAll('dialog input[name=hired]').length,1);assert(!q('dialog').textContent.includes('Иван Петров'));q('dialog [data-close]').click();
 console.log('PASS three separate personnel catalogs and independent equipment catalog without crew binding');
 click('[data-view=day]');select('#ts-object','obj2');await wait(idle);click('[data-action=add-equipment]');assert(!q('dialog [name=operatorIds]'));q('dialog [name=machines][value=w205]').checked=true;submit();await wait(()=>!q('dialog'));await wait(()=>record('tscrew_w205_0','person','obj2'));
 assert(crew().textContent.includes('Машинисты фрезы · 2'));crewPulse('12');await wait(()=>record('tscrew_w205_0','person','obj2').minutes===720);assert(crew().textContent.includes('24 чел.-ч'));
 click('[data-crew-id=w205] [data-action=crew]');const options=[...q('[data-slot-index="0"] select').options].map(o=>o.value);assert(options.includes('p1'));assert(!options.includes('w1'));assert(!options.includes('i1'));assert(!options.includes('p4'));q('[data-slot-index="0"] select').value='p3';submit();await wait(()=>!q('dialog'));await wait(()=>record('tscrew_w205_0','person','obj2').personId==='p3');assert.equal(record('tscrew_w205_0','person','obj2').minutes,720);assert(!record('p3','person','obj2'));
 select('#ts-shift','night');await wait(idle);click('[data-action=add-equipment]');q('dialog [name=machines][value=w205]').checked=true;submit();await wait(()=>!q('dialog'));await wait(()=>record('tscrew_w205_0','person','obj2','night'));crewPulse('13');await wait(()=>record('tscrew_w205_0','person','obj2','night').minutes===780);assert.equal(record('tscrew_w205_0','person','obj2').minutes,720);
 select('#ts-shift','day');select('#ts-object','obj');await wait(()=>crew()?.textContent.includes('Машинисты фрезы · 3'));assert.equal(record('p1').minutes,720);assert.equal(record('p2').minutes,720);assert.equal(record('w205','equipment').minutes,660);
 assert(!q('[data-crew-id=rental]'));console.log('PASS default crews, specialist-only optional naming, hired crew exclusion, and independent object/day/night hours');
 console.log('ALL CREW AND CATALOG UI TESTS PASSED');
}catch(e){console.error(e);console.error(w.__messages.slice(-6));process.exitCode=1;}finally{dom.window.close();}})();
