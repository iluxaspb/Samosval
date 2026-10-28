import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourcePeriod,materialRecord,applyVolume} from '../../test-app/tabel-v2/material-transfer.mjs';
import * as D from '../../test-app/tabel-v2/table-domain.mjs';
test('period uses source calendar date, day/night start metadata; invalid source is rejected',()=>{
 assert.deepEqual(sourcePeriod({startDate:'27.10.2026',startedAt:Date.parse('2026-10-27T21:00:00+03:00')}),{date:'2026-10-27',shift:'night'});
 assert.equal(sourcePeriod({startDate:'2026-10-27',workShift:'day'}).shift,'day');
 assert.throws(()=>sourcePeriod({startDate:'garbage'}));assert.throws(()=>sourcePeriod({startDate:'2026-10-27'}));
});
test('material identity includes destination; retry never doubles; independent shifts accumulate',()=>{
 const c=D.config({id:'o',name:'A'}),m=materialRecord(c,'Гранулят','Пушкин');c.materials.push(m);
 assert.equal(materialRecord(c,'Гранулят','Пушкин').id,m.id);
 assert.notEqual(materialRecord(c,'Гранулят','АБЗ').id,m.id);
 let d={values:{},lineImports:{}};d=applyVolume(d,'shift1',m,300);d=applyVolume(d,'shift1',m,300);assert.equal(d.values[m.id].quantity,300);
 d=applyVolume(d,'shift2',m,20);assert.equal(d.values[m.id].quantity,320);assert.throws(()=>applyVolume(d,'shift1',m,310));
 assert.throws(()=>applyVolume(d,'shift3',m,-1));
});
test('old closed records remain editable in the hours ledger',()=>{
 const c=D.config({id:'o',name:'A',startDate:'2026-10-01'});c.equipment=[{id:'f',name:'Фреза',ownership:'own'}];c.request.equipment=['f'];
 const d=D.createDay(c,'2026-10-27');d.closed=true;D.setValue({kind:'equipment',entity:'f',field:'hours'},d,'12');assert.equal(d.equipment[0].hours,12);
});
