import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../../test-app/tabel-v2/table-domain.mjs';
import * as R from '../../test-app/tabel-v2/request-domain.mjs';

const water={id:'water',name:'Поливомоечная',kind:'water',ownership:'own',pump:false};
const gravel={id:'gravel',name:'Гранулят',unit:'м³',section:'granulate'};
const sand={id:'sand',name:'Песок',unit:'м³',section:'receipt',assignedOnly:true};
const c={...D.config({id:'obj',name:'Старое ошибочное название'}),equipment:[water],materials:[gravel,sand]};
test('historical shifts retain their materials; new catalog additions stay shift-specific',()=>{
  assert.deepEqual(D.materialsForShift(c,{values:{gravel:{quantity:8}}}).map(m=>m.id),['gravel']);
  assert.deepEqual(D.materialsForShift(c,{materialIds:['sand'],values:{gravel:{quantity:8}}}).map(m=>m.id),['sand']);
  assert.deepEqual(D.materialsForShift(c,{materialIds:[],values:{gravel:{quantity:8}}}),[]);
  assert.deepEqual(D.materialsForShift(c,{values:{sand:{quantity:3}}}).map(m=>m.id),['gravel','sand']);
});
test('renamed directory objects replace old config snapshots in request and lunch',()=>{
  const object={id:'obj',name:'Правильный адрес',address:'Старая ошибка'};
  const live={...c,name:object.name,people:[],request:{...c.request,equipment:[],people:[]}};
  assert.equal(R.lunch(live,object).address,'Правильный адрес');
  assert.match(R.lunchText(live,object,'29.10.2026',{}),/Правильный адрес/);
  assert.equal(c.name,'Старое ошибочное название');
});
test('water pump can be turned off for one shift without erasing saved hours',()=>{
  const monday={date:'2026-10-29',shift:'day',equipment:[{...water,pump:true,pumpHours:7,crewHours:12,hours:12}],people:[],values:{}};
  const tuesday={...D.copy(monday),shift:'night',equipment:[{...water,pump:false,pumpHours:7,crewHours:12,hours:12}]};
  const pumpRow=D.rows({...c,materials:[]},[monday,tuesday]).find(r=>r.field==='pumpHours');
  assert(pumpRow,'Existing pump hours keep a table row');
  assert.equal(D.value(pumpRow,monday),7);
  assert.equal(D.value(pumpRow,tuesday),null,'Disabled pump must not count in this shift');
  assert.equal(tuesday.equipment[0].pumpHours,7,'Past numeric data is not deleted');
});
