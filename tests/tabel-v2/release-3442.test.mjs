import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../../test-app/tabel-v2/table-domain.mjs';
import {crewCount} from '../../test-app/tabel-v2/request-domain.mjs';
test('mill type enables double crew hours independently of its display name',()=>{
 const mill={id:'m',name:'W205',kind:'mill'};
 assert.equal(crewCount(mill),2);
 assert.equal(D.fiveDayHours(mill,'crewHours',13,true),26);
 assert.equal(D.fiveDayHours(mill,'crewHours',14,true),28);
 assert.equal(D.fiveDayHours(mill,'crewHours',13,false),13);
 assert.equal(D.fiveDayHours(mill,'hours',13,true),13);
 assert.equal(D.fiveDayHours({kind:'brush'},'crewHours',13,true),13);
 assert.equal(D.isMill({kind:'other',name:'Прицеп фрезы'}),false);
 assert.equal(D.isMill({name:'Фреза W200'}),true);
});
test('equipment shades stay stable through sorting, additions, rename, reload and ownership changes',()=>{
 const machines=[{id:'w',kind:'water'},{id:'b',kind:'brush'},{id:'m',kind:'mill'},{id:'crane',kind:'other'},{id:'roller',kind:'other'}];
 const original=new Map(machines.map(e=>[e.id,D.equipmentColor(e)]));
 assert.equal(new Set(original.values()).size,machines.length);
 for(const e of [...machines].reverse()){
  assert.equal(D.equipmentColor({...e,name:'Новое имя',ownership:'hired'}),original.get(e.id));
  assert.equal(D.equipmentColor(JSON.parse(JSON.stringify(e))),original.get(e.id));
 }
 const persisted={...machines[3],color:original.get('crane')};
 assert.equal(D.equipmentColor({...persisted,kind:'brush'}),original.get('crane'));
 const c=D.config({id:'a',name:'A',startDate:'2026-10-01'});c.equipment=machines;c.request.equipment=machines.map(e=>e.id);
 for(const row of D.rows(c,[]).filter(r=>r.kind==='equipment'))assert.equal(row.color,original.get(row.entity));
});

test('simple arithmetic, single and multiple SUM arguments, Russian SUM aliases and live references',()=>{
 const cells={A1:{raw:'5'},A2:{raw:'7'},B1:{raw:'=СУММ(A1:A2)'},B2:{raw:'=СУММА(A1;A2;3)'},C1:{raw:'=A1+A2'},C2:{raw:'=24*34'},D1:{raw:'=SUM(A1)'}};
 for(const [k,value]of Object.entries({B1:12,B2:15,C1:12,C2:816,D1:5}))assert.equal(D.formula(cells,k),value);
 cells.A1.raw='10';assert.equal(D.formula(cells,'B1'),17);
});
test('linked formulas also recalculate for shift/report readers without mutating stored facts',()=>{
 const c=D.config({id:'a',name:'A',startDate:'2026-10-01'});c.equipment=[{id:'mill',name:'W205',kind:'mill',ownership:'own'}];c.request.equipment=['mill'];
 const day=D.createDay(c,'2026-10-01');day.equipment[0].hours=12;
 const sheet={cells:{['mill:crewHours|'+D.dayKey(day.date,'day')]:{raw:'=B4*2'}}};
 assert.equal(D.linkedFormulaDays(c,[day],sheet)[0].equipment[0].crewHours,24);
 assert.equal(day.equipment[0].crewHours,null);
 day.equipment[0].hours=10;assert.equal(D.linkedFormulaDays(c,[day],sheet)[0].equipment[0].crewHours,20);
});
