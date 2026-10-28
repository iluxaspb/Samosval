import test from 'node:test';import assert from 'node:assert/strict';
import {conflictRows} from '../../test-app/tabel-v2/conflict-view.mjs';
test('operator comparison names machine and hours, shows previous and both changed values',()=>{
 const day=hours=>({equipment:[{id:'mill',name:'Фреза W205',hours,crewHours:26}]});
 const rows=conflictRows(day(8),day(12),day(14));assert.equal(rows.length,1);assert.match(rows[0].label,/Фреза W205.*Часы/);assert.equal(rows[0].before,8);assert.equal(rows[0].current,12);assert.equal(rows[0].mine,14);assert.equal(rows[0].bothChanged,true);
});
test('material IDs resolved to names; empty/zero preserved; unrelated server edits shown',()=>{
 const rows=conflictRows({values:{sand:{quantity:null}},note:'a'},{values:{sand:{quantity:0}},note:'b'},{values:{sand:{quantity:12}},note:'a'},{materials:[{id:'sand',name:'Песок'}]});assert.equal(rows.length,2);assert.match(rows[0].label,/Песок.*Объём/);assert.equal(rows[0].current,0);assert.equal(rows[1].bothChanged,false);
});
