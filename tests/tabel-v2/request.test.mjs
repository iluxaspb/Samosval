import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../../test-app/tabel-v2/request-domain.mjs';
const config={name:'Объект',equipment:[{id:'f1',name:'Фреза 1'},{id:'f2',name:'Фреза 2'},{id:'water',name:'Поливомойка'},{id:'unused',name:'Каток'}],people:[{id:'itr',name:'Иван',group:'itr',phone:'+79991234567'},{id:'worker',name:'Рабочий',group:'worker'}],request:{equipment:['f1','f2','water'],people:['itr','worker'],responsibleId:'itr',shift:'night'}};
test('two mills count four people, unselected equipment and workers excluded; extras add once',()=>{
 const x=R.lunch(config,{address:'Невский, 1'},{mechanic:true,spare:true});
 assert.equal(x.total,8); assert.equal(x.rows[0].count,2);assert.equal(x.rows[1].count,2);
 assert(!x.rows.some(r=>r.name==='Каток' || r.name==='Рабочий'));
 assert.equal(x.phone,'+79991234567');assert.equal(x.address,'Невский, 1');
});
test('lunch text includes shift, responsible and phone, no delivery time',()=>{
 const t=R.lunchText(config,{address:'Адрес'},'30.10',{});
 for(const value of ['ночная','Иван','+79991234567','Адрес','Количество обедов: 6']) assert(t.includes(value));
 assert(!t.includes('12:00') && !t.includes('23:00'));
});
test('responsible changes phone, missing phone is explicit and multiple ITR need a choice',()=>{
 const c=structuredClone(config);c.people.push({id:'itr2',name:'Пётр',group:'itr',phone:'123'});c.request.people.push('itr2');c.request.responsibleId='itr2';
 assert.equal(R.lunch(c,{}).phone,'123');c.people[2].phone='';assert.equal(R.lunch(c,{}).phone,'');
 c.request.responsibleId='';assert.equal(R.responsible(c),null);
});
test('metro offline search ignores case and ё, includes new open stations',()=>{
 assert(R.searchStations('ЧЕРНАЯ').includes('Чёрная речка'));
 for(const x of ['Горный институт','Путиловская','Юго-Западная'])assert(R.stations.includes(x));
 assert.equal(R.stations.length,73); assert.equal(new Set(R.stations).size,73);
});
