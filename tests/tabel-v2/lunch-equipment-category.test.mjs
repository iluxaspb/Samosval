import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../../test-app/tabel-v2/table-domain.mjs';
import * as R from '../../test-app/tabel-v2/request-domain.mjs';

const config=(equipment,selected)=>({
  ...D.config({id:'obj',name:'Учебный объект'}),
  equipment,
  people:[],
  request:{...D.config({id:'obj',name:'Учебный объект'}).request,equipment:selected,people:[],shift:'day'}
});
const mill={id:'mill',name:'Wirtgen W205',kind:'mill',ownership:'own'};
const brush={id:'brush',name:'МТЗ Щётка',kind:'brush',ownership:'own'};
const water={id:'water',name:'Поливомойка',kind:'water',ownership:'own'};
const other={id:'other',name:'Экскаватор',kind:'other',ownership:'own'};

test('mill category always counts two lunches; other categories count one',()=>{
 const c=config([mill,brush,water,other],['mill','brush','water','other']);
 const lunch=R.lunch(c,{id:'obj',name:'Учебный объект'});
 assert.deepEqual(lunch.rows.map(r=>r.count),[2,1,1,1]);
 assert.equal(lunch.total,5);
 assert.match(R.lunchText(c,{name:'Учебный объект'},'29.10.2026',{}),/Количество обедов: 5/);
});
test('explicit category always overrides misleading machine name',()=>{
 const unusual=[{...mill,name:'Roadtec RX-700'},
   {...mill,id:'other',kind:'other',name:'Фреза универсальная'}];
 assert.deepEqual(unusual.map(R.crewCount),[2,1]);
 assert.equal(D.equipmentCategory(unusual[0]),'mill');
 assert.equal(D.equipmentCategory(unusual[1]),'other');
 assert.equal(D.isMill(unusual[1]),false);
 assert.equal(D.isWater({...water,kind:'other',name:'Поливомойка'}),false);
});
test('old records with no category infer the machine type from names',()=>{
 assert.equal(R.crewCount({id:'legacy-mill',name:'Фреза старая'}),2);
 assert.equal(D.equipmentCategory({name:'Поливомоечная'}),'water');
 assert.equal(D.equipmentCategory({name:'МТЗ-щётка'}),'brush');
 assert.equal(D.equipmentCategory({name:'Грузовик'}),'other');
});
test('changing the catalog category corrects lunch totals without renaming machine',()=>{
 const c=config([{...mill,kind:'other'}],['mill']);
 assert.equal(R.lunch(c,{name:'Адрес'}).total,1);
 c.equipment[0].kind='mill';
 assert.equal(R.lunch(c,{name:'Адрес'}).total,2);
 assert.equal(R.lunch(c,{name:'Адрес'}, {workers:3}).total,5);
});
test('explicit user colors are retained irrespective of category defaults',()=>{
 assert.equal(D.equipmentColor({...mill,color:'#12aBcD'}),'#12aBcD');
 assert.equal(D.equipmentColor({...brush,color:'#000000'}),'#000000');
 assert.notEqual(D.equipmentColor({...mill,color:'invalid'}),'invalid');
});
