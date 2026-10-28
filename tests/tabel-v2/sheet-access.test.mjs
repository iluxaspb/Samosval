import test from 'node:test';import assert from 'node:assert/strict';
import {sheetVisible,sheetManager} from '../../test-app/tabel-v2/sheet-access.mjs';
import {historyRows} from '../../test-app/tabel-v2/history-view.mjs';
const actor=role=>({uid:'ivan',role,status:'active',tabAccess:true});
test('sheet visibility defaults deny master/lopater; admin and foreman see every sheet',()=>{
 for(const role of ['master','lopater','viewer'])assert.equal(sheetVisible(actor(role),{},'linked'),false);
 for(const role of ['admin','foreman'])assert.equal(sheetVisible(actor(role),{},'arbitrary'),true);
 assert.equal(sheetVisible(actor('master'),{sheetAccess:{one:{roles:{master:true}}}},'one'),true);
 assert.equal(sheetVisible(actor('lopater'),{sheetAccess:{one:{users:{ivan:true}}}},'one'),true);
 assert.equal(sheetVisible(actor('master'),{sheetAccess:{one:{roles:{master:true}}}},'two'),false);
 assert.equal(sheetVisible({...actor('admin'),status:'disabled'},{},'one'),false);
 assert.equal(sheetManager(actor('master')),false);
});
test('operator history renders zero to twelve and author inline without JSON',()=>{
 const row=historyRows({key:'site/day:2026-10-15:day',author:{name:'Иван'},time:1,before:{data:{equipment:[{id:'mill',name:'Фреза W205',hours:0}]}},data:{equipment:[{id:'mill',name:'Фреза W205',hours:12}]}},{});
 assert.match(row,/Иван/);assert.match(row,/Фреза W205/);assert.match(row,/было <b>0<\/b>, стало <b>12/);assert.doesNotMatch(row,/<pre>|<details>/);
});
