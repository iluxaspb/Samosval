import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeShiftStart,shiftStartPayload} from '../src/shift-start.mjs';
test('start accepts a stable operation and ignores client actor, name and timestamps',()=>{
  const op=normalizeShiftStart({id:'a',objectId:'site',createdAt:1,startedBy:'spoof',objectName:'spoof',startedAt:1});
  assert.deepEqual(op,{id:'a',objectId:'site',createdAt:1,type:'start'});
  const now=Date.parse('2026-10-30T21:15:00Z');
  assert.deepEqual(shiftStartPayload(op,{name:' Server site '},{uid:'u',display_name:'Server actor'},now),{id:'shift_a',objectId:'site',objectName:'Server site',startDate:'31.10.2026',startedAt:now,startedBy:'Server actor',startedByUid:'u',isActive:true});
});
test('invalid IDs and timestamps are rejected before database access',()=>{
  const base={id:'operation',objectId:'site',createdAt:1};
  for(const patch of [{id:''},{id:'a/b'},{id:'a'.repeat(101)},{objectId:'../site'},{createdAt:NaN},{createdAt:0},{createdAt:1.5}])assert.throws(()=>normalizeShiftStart({...base,...patch}),{code:'invalid-start-operation'});
});
test('absent, disabled or malformed server object cannot start a shift',()=>{
  for(const object of [undefined,{}, {name:''},{name:' '},{name:'a'.repeat(501)},{name:'Site',deleted:true},{name:'Site',disabled:true}])assert.throws(()=>shiftStartPayload({id:'o',objectId:'site'},object,{uid:'u',display_name:'Actor'}),{code:'object-not-available'});
});
