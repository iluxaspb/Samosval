import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLineOperation, validateLineOperation } from '../src/line-rules.mjs';

const now = Date.now();
const actor = {name:'Operator',email:'operator@example.test',isAdmin:false};
const truck = {brand:'КамАЗ',number:'А001АА',defaultVol:12,isGAI:false};
const op = (type, values={})=>({
  id:'op_123', type, shiftId:'shift_ci',truckId:'truck_ci',createdAt:now-10000,
  expectedRevision:0,expectedTtnRevision:0,arrivalTimestamp:0,
  lastLoadTimestamp:0,wantArrived:true,collect:true,cycleMinutes:15,...values
});
const idle={onLine:true,shiftId:'shift_ci',cycleRevision:0,ttnRevision:0,
  arriveStatus:null,arriveTimestamp:null,lastLoadTimestamp:null,loadedAfterArrive:false};

test('arrive then load advances revision and yields deterministic log ID',()=>{
  const arrival=applyLineOperation({op:op('arrive'),before:idle,truck,actor,now});
  assert.equal(arrival.outcome,'confirmed');
  assert.equal(arrival.status.cycleRevision,1);
  const load=applyLineOperation({op:op('load',{
    id:'op_124',expectedRevision:1,arrivalTimestamp:arrival.status.arriveTimestamp,
    createdAt:now-9000
  }),before:arrival.status,truck,actor,now});
  assert.equal(load.outcome,'confirmed');
  assert.equal(load.log.id,`load_truck_ci_shift_ci_cycle_1_${arrival.status.arriveTimestamp}`);
  assert.equal(load.log.createdBy,actor.name);
  assert.equal(load.status.cycleRevision,2);
  assert.equal(load.status.arriveStatus,null);
  const concurrent=applyLineOperation({op:op('load',{
    id:'op_125',expectedRevision:1,arrivalTimestamp:arrival.status.arriveTimestamp
  }),before:load.status,truck,actor,now});
  assert.equal(concurrent.outcome,'rejected');
});
test('load before arrival is rejected',()=>{
  assert.equal(applyLineOperation({op:op('load'),before:idle,truck,actor,now}).outcome,'rejected');
});
test('minimum cycle interval is checked on the server',()=>{
  const afterLoad={...idle,lastLoadTimestamp:now-60000,cycleRevision:2};
  const result=applyLineOperation({op:op('arrive',{expectedRevision:2}),before:afterLoad,truck,actor,now});
  assert.equal(result.reason,'cycle-time');
});
test('TTN revision and identity are derived from server state',()=>{
  const ok=applyLineOperation({op:op('ttn'),before:idle,truck,actor,now});
  assert.equal(ok.outcome,'confirmed');
  assert.equal(ok.status.ttnStatus,'pending');
  assert.equal(ok.status.ttnRevision,1);
  assert.equal(applyLineOperation({op:op('ttn'),before:ok.status,truck,actor,now}).reason,'ttn-changed');
});
test('reset is administrator-only',()=>{
  assert.equal(applyLineOperation({op:op('reset'),before:idle,truck,actor,now}).outcome,'rejected');
  assert.equal(applyLineOperation({op:op('reset'),before:idle,truck,actor:{...actor,isAdmin:true},now}).outcome,'confirmed');
});
test('reject malformed, future and untrusted inputs',()=>{
  assert.equal(validateLineOperation(op('load')),null);
  assert.equal(validateLineOperation(op('load',{createdAt:now+600000}),now),'invalid-createdAt');
  assert.equal(validateLineOperation(op('load',{id:'../x'}),now),'invalid-id');
  assert.equal(validateLineOperation(op('load',{expectedRevision:-1}),now),'invalid-expectedRevision');
});
