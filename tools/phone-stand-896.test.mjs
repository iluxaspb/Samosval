import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {installPhoneEvidence} from './phone-form-qa.mjs';
const stand=fs.readFileSync(new URL('./phone-stand-896.mjs',import.meta.url),'utf8');

test('forms are pinned to one open dialog and cancel/removal precedes reopening',()=>{
 assert.doesNotMatch(stand,/document\.querySelector\('dialog (input|form|\[)/);
 assert.match(stand,/!qaPhoneDialog\.isConnected/);
 assert.match(stand,/qaPhoneDialog!==document\.querySelector\('dialog\[open\]'\)/);
 assert.match(stand,/await waitFormRemoved\(\);[\s\S]*await openPhoneForm\('synthetic_truck'\)/);
 assert.match(stand,/getAttribute\('onclick'\)===\\"addTruckPhone\('synthetic_truck'\)/);
 assert.match(stand,/evidence\.sqlAfterPOST=await readPhoneSQL\(\)/);
 assert.match(stand,/evidence\.independentGET=await independentPhoneRead\(\)/);
 assert.match(stand,/Page.reload[\s\S]*evidence\.reloadGET=await independentPhoneRead\(\)/);
 assert.match(stand,/finally\{[\s\S]*phone-form-evidence\.json/);
});

test('observer correlates actual POST response without changing it or leaking raw data',async()=>{
 const response=new Response(JSON.stringify({source:'ubuntu',phones:[{truckId:'synthetic_truck',phone:'+12025550100'}],secret:'private-response'}));
 let called;
 const context=vm.createContext({URL,Request,location:{href:'https://example.test/app',origin:'https://example.test'},fetch:async(...args)=>{called=args;return response;}});context.window=context;
 vm.runInContext(`(${installPhoneEvidence.toString()})()`,context);
 const options={method:'POST',headers:{Authorization:'private-token'},body:JSON.stringify({truckId:'synthetic_truck',phone:'+1 (202) 555-0100'})};
 assert.equal(await context.fetch('/api/v1/truck-phones',options),response);
 assert.equal(called[1],options);
 await new Promise(resolve=>setImmediate(resolve));
 const records=JSON.parse(JSON.stringify(context.__qaPhoneHTTP));
 assert.deepEqual(records,[{sequence:1,method:'POST',status:200,truckId:'synthetic_truck',expectedPhone:true,ubuntu:true,validPhones:true,expectedRows:1}]);
 assert.doesNotMatch(JSON.stringify(records),/private|Authorization|202555/);
 assert.equal((await response.json()).secret,'private-response');
});

test('observer preserves malformed/error responses and transport failures',async()=>{
 for(const kind of ['malformed','error','transport']){
  const response=new Response(kind==='malformed'?'not-json':'{}',{status:kind==='error'?403:200});
  const failure=Error('private-failure');
  const context=vm.createContext({URL,Request,location:{href:'https://example.test/',origin:'https://example.test'},fetch:async()=>{if(kind==='transport')throw failure;return response;}});context.window=context;
  vm.runInContext(`(${installPhoneEvidence.toString()})()`,context);
  if(kind==='transport')await assert.rejects(context.fetch('/api/v1/truck-phones'),e=>e===failure);
  else assert.equal(await context.fetch('/api/v1/truck-phones'),response);
  await new Promise(resolve=>setImmediate(resolve));
  const record=JSON.parse(JSON.stringify(context.__qaPhoneHTTP[0]));
  assert.equal(record.status,kind==='transport'?null:response.status);
  if(kind==='malformed')assert.equal(record.invalidJSON,true);
  if(kind==='transport')assert.equal(record.transportFailure,true);
  assert.doesNotMatch(JSON.stringify(record),/private-failure/);
 }
});

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
