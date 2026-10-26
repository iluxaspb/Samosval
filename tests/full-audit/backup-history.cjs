'use strict';
const assert=require('node:assert/strict');
const {harness,W}=require('./backup-harness.cjs');
(async()=>{
  // Install the real application history-recorder, not a stub of its amplification.
  const h=harness();h.installHistory();
  const m=await h.api.createBackup('manual','history integration');assert(m,h.errors.join('\n'));
  h.values.set(W+'trucks/one',{changed:true});h.values.set(W+'objects/one',{changed:true});
  assert(await h.api.restoreBackup(m.id,{base:true}),h.errors.join('\n'));
  const histories=[...h.values].filter(([p,v])=>p.startsWith(W+'audit/')&&v.eventType==='history');
  assert.equal(histories.length,1);assert.equal(histories[0][1].history.operations.length,2);
  assert.equal(h.calls.find(c=>c[0]==='transaction-size')[1],3,'two data writes + ONE atomic undo/audit write');
  assert.equal([...h.values].filter(([p,v])=>p.startsWith(W+'audit/')&&v.eventType!=='history').length,701,'economy untouched');
  // Current wrapper emits one receipt per transaction, not one per restored document.
  const big=harness();big.installHistory();
  for(const [path]of big.values)if(path.startsWith(W+'trucks/')||path.startsWith(W+'objects/'))big.values.delete(path);
  for(let i=0;i<400;i++)big.values.set(W+'trucks/'+i,{name:'truck-'+i});
  const bm=await big.api.createBackup('manual','400 records');assert(bm);
  for(let i=0;i<400;i++)big.values.set(W+'trucks/'+i,{name:'changed-'+i});
  assert(await big.api.restoreBackup(bm.id,{base:true}),big.errors.join('\n'));
  assert.equal(big.calls.find(c=>c[0]==='transaction-size')[1],401,'safe under 500 with real history wrapper');
  // Wrapper's 900KB history guard rejects before any write, preserving current state.
  const huge=harness();huge.installHistory();const hm=await huge.api.createBackup('manual','history-size');
  huge.values.set(W+'trucks/one',{large:'я'.repeat(460000)});const before=huge.live();
  assert.equal(await huge.api.restoreBackup(hm.id,{base:true}),false);assert.deepEqual(huge.live(),before);
  assert.equal(huge.liveWrites().length,0);assert(huge.errors.at(-1).includes('слишком большое'));
  console.log('PASS backup real history-recorder integration: audit preserved, one atomic history receipt, 400 restored docs = 401 writes, oversized history rejected without partial changes');
})().catch(e=>{console.error(e);process.exitCode=1;});
