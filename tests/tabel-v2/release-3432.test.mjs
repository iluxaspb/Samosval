import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../../test-app/tabel-v2/table-domain.mjs';
import * as R from '../../test-app/tabel-v2/request-domain.mjs';
test('truck groups have distinct plans, 40 tonne trips and inflected share text',()=>{
 const groups=[{count:4,mode:'central',trips:4},{count:2,mode:'central',trips:3},{count:4,mode:'local'}];
 assert.deepEqual(R.truckGroups(groups).map(g=>g.tonnes),[640,240,0]);
 assert.equal(R.trucksText(groups),'4 самосвала, централизация, 640 тонн\n2 самосвала, централизация, 240 тонн\n4 самосвала по месту');
 for(const bad of [{count:0,mode:'local'},{count:1,mode:'central',trips:0},{count:1.2,mode:'local'}])assert.throws(()=>R.truckGroups([bad]));
 assert.equal(R.initials('Иванов Иван Иванович'),'Иванов И.И.');
});
test('shift start carries worker roster without hours, ITR hours default/copy, never overwrites source',()=>{
 const c=D.config({id:'a',name:'a',startDate:'2026-01-01'});c.people=[{id:'w',name:'Рабочий',group:'worker'},{id:'i',name:'ИТР',group:'itr'}];c.request.people=['w','i'];
 const first=D.createDay(c,'2026-10-20');assert.equal(first.people[0].hours,null);assert.equal(first.people[1].hours,12);
 first.people[0].hours=10;first.people[1].hours=11;
 const next=D.createDay(c,'2026-10-21','day',first);assert.equal(next.people[0].hours,null);assert.equal(next.people[1].hours,11);assert.equal(first.people[0].hours,10);
 assert.equal(D.previousDay([next,first],'2026-10-22','day'),next);
 assert(D.createDay(c,D.add(D.today(),1),'day',first).people.every(p=>p.hours===null));
});
test('fixed own-equipment order and pump restricted to water, quantities aggregated by definition',()=>{
 const c=D.config({id:'a',name:'a',startDate:'2026-01-01'});c.equipment=[{id:'m1',name:'Фреза 1',ownership:'own'},{id:'x',name:'Каток',ownership:'own',pump:true},{id:'w',name:'Поливомоечная',ownership:'own',pump:true},{id:'m2',name:'Фреза 2',ownership:'own'},{id:'b',name:'МТЗ-щётка',ownership:'own'}];c.request.equipment=c.equipment.map(e=>e.id);
 assert.deepEqual(D.rows(c,[]).filter(r=>r.field==='hours').map(r=>r.entity),['w','b','m1','m2','x']);assert.deepEqual(D.rows(c,[]).filter(r=>r.field==='pumpHours').map(r=>r.entity),['w']);
 c.works=[{id:'work',name:'Работа',unit:'м²'}];c.materials=[{id:'mat',name:'Материал',unit:'т'}];
 assert.deepEqual(D.totals(c,[{values:{work:{quantity:50},mat:{quantity:40}}},{values:{work:{quantity:20},mat:{quantity:10}}}]).map(x=>[x.unit,x.quantity]),[['м²',70],['т',50]]);
});
