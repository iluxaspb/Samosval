import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSparkTypedLineSnapshot,sparkTypedPaths} from '../src/test-spark-typed.mjs';

const G='0123456789abcdef01234567';
const row=(table,x)=>({table,envelope:{rowJson:JSON.stringify(x)}});
const snapshot={
 sequence:44,rows:[
 row('workspaces',{id:'main_workspace',cycle_minutes:60}),
 row('shifts',{workspace_id:'main_workspace',shift_id:'shiftA',
  is_active:true,payload:{objectName:'Тестовый объект'}}),
 row('line_trucks',{workspace_id:'main_workspace',truck_id:'truckA',
  payload:{brand:'КАМАЗ',number:'А123АА',defaultVol:24,isGAI:false}}),
 row('line_trucks',{workspace_id:'main_workspace',truck_id:'gaiA',
  payload:{brand:'Проверка',number:'ГАИ',defaultVol:24,isGAI:true}}),
 row('line_truck_statuses',{workspace_id:'main_workspace',truck_id:'truckA',
  shift_id:'shiftA',payload:{onLine:true,cycleRevision:5,ttnRevision:3,
   arriveTimestamp:1800000000000,lastLoadTimestamp:1799990000000,
   lastLoadLogId:'logOld',loadedAfterArrive:false}}),
 row('line_logs',{workspace_id:'main_workspace',log_id:'logOld',
  shift_id:'shiftA',truck_id:'truckA',payload:{timestamp:1799990000000}})
 ]
};
const build=given=>buildSparkTypedLineSnapshot({snapshot:given||snapshot,
 generation:G,fromMillis:ms=>({toMillis:()=>ms,marker:'admin-timestamp'})});
test('typed Spark snapshot is server-owned, same generation and original source cursor',()=>{
 const p=build();
 assert.equal(p.config.active,true);
 assert.equal(p.config.shiftId,'shiftA');
 assert.equal(p.config.cycleMinutes,60);
 assert.equal(p.config.sourceSequence,44);
 assert.equal(p.trucks.get('truckA').volume,24);
 assert.equal(p.trucks.get('gaiA').volume,0);
 assert.equal(p.statuses.get('truckA').cycleRevision,5);
 assert.equal(p.statuses.get('truckA').arrivedAt.toMillis(),1800000000000);
 assert.equal(p.statuses.get('truckA').lastLoadAt.toMillis(),1799990000000);
 assert.equal(p.statuses.get('truckA').lastLogId,'logOld');
 assert.equal(p.statuses.get('truckA').ttnRevision,3);
 assert.equal(p.statuses.get('truckA').generation,G);
 assert.deepEqual(Object.keys(p).sort(),['config','statuses','trucks']);
});
test('typed path generation never permits path traversal',()=>{
 const path=sparkTypedPaths(G);
 assert.equal(path.status('truckA'),
  'samosval_test_replica/v1/typed_status_'+G+'/truckA');
 assert.equal(path.operation('opA'),
  'samosval_test_replica/v1/typed_ops_'+G+'/opA');
 assert.equal(path.log('load_opA'),
  'samosval_test_replica/v1/typed_logs_'+G+'/load_opA');
 assert.throws(()=>path.status('../evil'),/spark-typed-truck-id-invalid/);
 assert.throws(()=>sparkTypedPaths('wrong'),/spark-typed-generation-invalid/);
});
test('typed model fails closed on multiple shifts, bad volume and corrupt timestamps',()=>{
 const clone=()=>structuredClone(snapshot);
 const dual=clone();dual.rows.push(row('shifts',{workspace_id:'main_workspace',
  shift_id:'shiftB',is_active:true,payload:{}}));
 assert.throws(()=>build(dual),/spark-typed-multiple-shifts/);
 const bad=clone();bad.rows.find(x=>x.table==='line_trucks').envelope.rowJson=
  JSON.stringify({workspace_id:'main_workspace',truck_id:'truckA',
   payload:{defaultVol:Infinity,number:'truckA',brand:'test'}});
 // JSON stringification coerces Infinity to null: test strict over-limit.
 bad.rows.find(x=>x.table==='line_trucks').envelope.rowJson=
  JSON.stringify({workspace_id:'main_workspace',truck_id:'truckA',
   payload:{defaultVol:999999}});
 assert.throws(()=>build(bad),/spark-typed-truck-volume-invalid/);
 const t=clone();t.rows.find(x=>x.table==='line_truck_statuses').envelope.rowJson=
  JSON.stringify({workspace_id:'main_workspace',truck_id:'truckA',
   shift_id:'shiftA',payload:{onLine:true,arriveTimestamp:-1}});
 assert.throws(()=>build(t),/spark-typed-invalid-timestamp/);
});
