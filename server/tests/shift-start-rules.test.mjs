import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeShiftStart,shiftStartPayload} from '../src/shift-start.mjs';
test('start accepts a stable operation and ignores client actor, name and timestamps',()=>{
  const op=normalizeShiftStart({id:'a',objectId:'site',createdAt:1,workShift:'night',startedBy:'spoof',objectName:'spoof',startedAt:1});
  assert.deepEqual(op,{id:'a',objectId:'site',createdAt:1,type:'start',workShift:'night'});
  const now=Date.parse('2026-10-30T21:15:00Z');
  assert.deepEqual(shiftStartPayload(op,{name:' Server site '},{uid:'u',display_name:'Server actor'},now),{payloadSchemaVersion:2,id:'shift_a',shiftId:'shift_a',objectId:'site',objectName:'Server site',startDate:'31.10.2026',date:'2026-10-31',workShift:'night',type:'night',state:'active',isActive:true,startedAt:now,startedByUid:'u',startedBy:'Server actor'});
});
test('workShift is mandatory and invalid values are rejected before database access',()=>{
  const base={id:'operation',objectId:'site',createdAt:1};
  for(const workShift of [undefined,'','morning'])assert.throws(()=>normalizeShiftStart({...base,...(workShift===undefined?{}:{workShift})}),{code:'invalid-start-operation'});
});
test('invalid IDs and timestamps are rejected before database access',()=>{
  const base={id:'operation',objectId:'site',createdAt:1,workShift:'day'};
  assert.deepEqual(normalizeShiftStart(base),{type:'start',...base});
  for(const patch of [{id:''},{id:'a/b'},{id:'a'.repeat(101)},{objectId:'../site'},{createdAt:NaN},{createdAt:0},{createdAt:1.5}])assert.throws(()=>normalizeShiftStart({...base,...patch}),error=>error.code==='invalid-start-operation'&&error.message==='invalid-start-operation');
});
test('absent, disabled or malformed server object cannot start a shift',()=>{
  for(const object of [undefined,{}, {name:''},{name:' '},{name:'a'.repeat(501)},{name:'Site',deleted:true},{name:'Site',disabled:true}])assert.throws(()=>shiftStartPayload({id:'o',objectId:'site'},object,{uid:'u',display_name:'Actor'}),{code:'object-not-available'});
});
