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
test('reset requires admin or the line_timer_reset permission',()=>{
  assert.equal(applyLineOperation({op:op('reset'),before:idle,truck,actor,now}).outcome,'rejected');
  assert.equal(applyLineOperation({op:op('reset'),before:idle,truck,actor:{...actor,isAdmin:true},now}).outcome,'confirmed');
  assert.equal(applyLineOperation({op:op('reset'),before:idle,truck,actor:{...actor,canResetTimer:true},now}).outcome,'confirmed');
});
test('reject malformed, future and untrusted inputs',()=>{
  assert.equal(validateLineOperation(op('load')),null);
  assert.equal(validateLineOperation(op('load',{createdAt:now+600000}),now),'invalid-createdAt');
  assert.equal(validateLineOperation(op('load',{id:'../x'}),now),'invalid-id');
  assert.equal(validateLineOperation(op('load',{expectedRevision:-1}),now),'invalid-expectedRevision');
});
test('no-return marks the truck absent and clears the arrival',()=>{
  const arrival=applyLineOperation({op:op('arrive'),before:idle,truck,actor,now});
  const absent=applyLineOperation({op:op('no-return',{id:'op_126',expectedRevision:1,createdAt:now-5000}),
    before:arrival.status,truck,actor,now});
  assert.equal(absent.outcome,'confirmed');
  assert.equal(absent.status.noReturn,true);
  assert.equal(absent.status.noReturnBy,actor.name);
  assert.equal(absent.status.noReturnOperationId,'op_126');
  assert.equal(absent.status.arriveStatus,null);
  assert.equal(absent.status.arriveTimestamp,null);
  assert.equal(absent.status.arriveBy,null);
  assert.equal(absent.status.cycleRevision,2);
  assert.equal(absent.status.lastLoadTimestamp,arrival.status.lastLoadTimestamp);
  assert.equal(validateLineOperation(op('no-return'),now),null);
});
test('second no-return on the same truck is already-absent',()=>{
  const absent=applyLineOperation({op:op('no-return',{expectedRevision:0}),before:idle,truck,actor,now});
  assert.equal(absent.outcome,'confirmed');
  const again=applyLineOperation({op:op('no-return',{id:'op_127',expectedRevision:1}),before:absent.status,truck,actor,now});
  assert.equal(again.outcome,'rejected');
  assert.equal(again.reason,'already-absent');
});
test('load and ttn are refused while the truck is absent',()=>{
  const arrival=applyLineOperation({op:op('arrive'),before:idle,truck,actor,now});
  const absent=applyLineOperation({op:op('no-return',{id:'op_128',expectedRevision:1}),before:arrival.status,truck,actor,now});
  assert.equal(absent.outcome,'confirmed');
  const load=applyLineOperation({op:op('load',{id:'op_129',expectedRevision:2,arrivalTimestamp:arrival.status.arriveTimestamp}),
    before:absent.status,truck,actor,now});
  assert.equal(load.reason,'truck-absent');
  const ttn=applyLineOperation({op:op('ttn',{id:'op_130',expectedRevision:2}),before:absent.status,truck,actor,now});
  assert.equal(ttn.reason,'truck-absent');
});
test('arrive returns an absent truck to the line',()=>{
  const absent=applyLineOperation({op:op('no-return',{expectedRevision:0}),before:idle,truck,actor,now});
  assert.equal(absent.outcome,'confirmed');
  const back=applyLineOperation({op:op('arrive',{id:'op_131',expectedRevision:1,createdAt:now-4000}),
    before:absent.status,truck,actor,now});
  assert.equal(back.outcome,'confirmed');
  assert.equal(back.status.noReturn,false);
  assert.equal(back.status.noReturnAt,null);
  assert.equal(back.status.noReturnBy,null);
  assert.match(back.status.arriveStatus,/^\d{2}:\d{2}$/);
  assert.equal(back.status.cycleRevision,2);
});
test('arrive of an absent truck ignores the cycle cooldown',()=>{
  const loaded={...idle,cycleRevision:1,lastLoadTimestamp:now-60000,loadedAfterArrive:true};
  const absent=applyLineOperation({op:op('no-return',{expectedRevision:1}),before:loaded,truck,actor,now});
  assert.equal(absent.outcome,'confirmed');
  const back=applyLineOperation({op:op('arrive',{id:'op_132',expectedRevision:2,createdAt:now-4000}),
    before:absent.status,truck,actor,now});
  assert.equal(back.outcome,'confirmed','cooldown must not block the return of an absent truck');
  assert.equal(back.status.noReturn,false);
  // Обычное прибытие (машина не «не приехал») кулдаун по-прежнему соблюдает.
  const busy=applyLineOperation({op:op('arrive',{id:'op_133',expectedRevision:1}),before:loaded,truck,actor,now});
  assert.equal(busy.reason,'cycle-time');
});
