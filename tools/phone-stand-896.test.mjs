import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const stand=fs.readFileSync(new URL('./phone-stand-896.mjs',import.meta.url),'utf8');

test('held POST read evaluation returns undefined before releasing its dependency',async()=>{
 const expression=stand.match(/await ev\('(window\.qaReadDone=false;void truckPhoneRequest\(\)\.then\(\(\)=>qaReadDone=true\))'\)/)?.[1];assert.ok(expression);
 let release;const pending=new Promise(r=>release=r);
 const context=vm.createContext({truckPhoneRequest:()=>pending});context.window=context;
 const result=vm.runInContext(expression,context);
 assert.equal(result,undefined);assert.equal(context.qaReadDone,false);
 // Mirrors CDP awaitPromise:true: awaiting undefined must return immediately.
 await result;assert.equal(context.qaReadDone,false);
 release();await pending;await Promise.resolve();assert.equal(context.qaReadDone,true);
});

test('fault scenarios reset server state and assert committed versus unsent outcomes',()=>{
 assert.match(stand,/DELETE FROM truck_phones WHERE truck_id='synthetic_empty'/);
 assert.match(stand,/assert\.deepEqual\(rows,mode==='badbody'\?\[\{phone:/);
 assert.match(stand,/options\.signal\.addEventListener\('abort',abort/);
 assert.match(stand,/assert\.equal\(await ev\('qaFaultAborted'\),true\)/);
 assert.match(stand,/fetchImpl:qaFaultFetch/);
});

test('restore uses observed SQL blockers and checks both real request outcomes',()=>{
 const source=fs.readFileSync(new URL('./phone-restore-overlap.mjs',import.meta.url),'utf8');
 assert.match(source,/pg_blocking_pids\(pid\)/);
 assert.match(source,/\['phone-first','restore-first'\]/);
 assert.match(source,/waitBlocked\('pg_advisory_xact_lock\(',writer.pid\)/);
 assert.match(source,/waitBlocked\('pg_advisory_xact_lock_shared\(',restorer.pid\)/);
 assert.match(source,/result.status,409/);assert.match(source,/result.status,200/);
 assert.match(stand,/void handleLogout\(\)/);assert.match(stand,/\.pcm-overlay \.pcm-btn-confirm/);
});
