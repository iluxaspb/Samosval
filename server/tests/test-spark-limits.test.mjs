import test from 'node:test';
import assert from 'node:assert/strict';
import {SPARK_STANDARD_FREE_LIMITS,SPARK_MAX_BOOTSTRAP_ROWS,
 assertSparkBootstrapBudget,estimateSparkSnapshot,
 estimateSparkForwardBatch} from '../src/test-spark-limits.mjs';

test('Spark budget is conservative and allows existing app quota headroom',()=>{
 assert.equal(SPARK_STANDARD_FREE_LIMITS.readsPerDay,50000);
 assert.equal(SPARK_STANDARD_FREE_LIMITS.writesPerDay,20000);
 assert.equal(SPARK_STANDARD_FREE_LIMITS.storageBytes,1073741824);
 assert.ok(SPARK_MAX_BOOTSTRAP_ROWS<SPARK_STANDARD_FREE_LIMITS.writesPerDay/2);
 assert.deepEqual(estimateSparkSnapshot(100),{
  documentWrites:101,documentReadsAtLeast:102
 });
 assert.deepEqual(assertSparkBootstrapBudget(SPARK_MAX_BOOTSTRAP_ROWS),
  estimateSparkSnapshot(SPARK_MAX_BOOTSTRAP_ROWS));
 assert.throws(()=>assertSparkBootstrapBudget(SPARK_MAX_BOOTSTRAP_ROWS+1),
  /replica-spark-bootstrap-budget-exceeded/);
});

test('a per-day quota is shared with all clients; reject a large single snapshot',()=>{
 assert.throws(()=>assertSparkBootstrapBudget(10000,{maxRows:10000}),
  /spark-invalid-bootstrap-limit/);
 for(const v of [-1,1.5,NaN,Infinity,'500'])
  assert.throws(()=>assertSparkBootstrapBudget(v));
});

test('incremental event delivery counts both immutable ledger and final rows',()=>{
 assert.deepEqual(estimateSparkForwardBatch({events:20,materializedUpserts:12,deletes:2}),
  {documentWrites:33,documentDeletes:2,documentReadsAtLeast:2});
 assert.throws(()=>estimateSparkForwardBatch({events:1,materializedUpserts:2}));
 assert.throws(()=>estimateSparkForwardBatch({events:-1,materializedUpserts:0}));
});
