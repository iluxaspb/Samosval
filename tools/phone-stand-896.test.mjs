import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {installPhoneEvidence,installPhoneFormQA,capturePhoneLineFacts} from './phone-form-qa.mjs';
const stand=fs.readFileSync(new URL('./phone-stand-896.mjs',import.meta.url),'utf8');

test('synthetic seed statuses satisfy the real Line membership predicate',()=>{
 const seed=fs.readFileSync(new URL('./phone-browser-seed.mjs',import.meta.url),'utf8');
 const formatting=fs.readFileSync(new URL('../working-test/source/core/03-formatting.js',import.meta.url),'utf8');
 const predicate=formatting.match(/function getActiveLineIds\(\) \{[^\n]+/)[0];
 const payload=seed.match(/INSERT INTO line_truck_statuses[^\n]+\[id,(\{[^\n]+?\})\]\);/)[1];
 const status=vm.runInNewContext(`(${payload})`);
 const context=vm.createContext({state:{truckStatus:{synthetic_truck:status,synthetic_empty:status}}});
 assert.deepEqual(Array.from(vm.runInContext(`${predicate};getActiveLineIds()`,context)),['synthetic_truck','synthetic_empty']);
 // The old fixture proves why an active shift/catalog entry is insufficient.
 context.state.truckStatus={synthetic_truck:{arrived:false,ttnStatus:'pending'}};
 assert.deepEqual(Array.from(vm.runInContext('getActiveLineIds()',context)),[]);
});

test('Line diagnostics distinguish absent membership, absent card and absent tel without mutation or raw data',()=>{
 const state={shift:{id:'synthetic_shift',secret:'private'},trucks:[{id:'synthetic_truck',number:'private'}],truckStatus:{synthetic_truck:{onLine:false}}};
 let card=null;
 const container={querySelector:()=>card,querySelectorAll:()=>card?[card]:[]};
 const context=vm.createContext({state,document:{getElementById:()=>container},getActiveLineIds:()=>state.truckStatus.synthetic_truck.onLine?['synthetic_truck']:[],truckPhoneRows:new Map([['synthetic_truck','+12025550100']]),hasPermission:()=>true});
 const facts=()=>JSON.parse(JSON.stringify(vm.runInContext(`(${capturePhoneLineFacts.toString()})()`,context)));
 const before=JSON.stringify(state);
 assert.equal(facts().activeTarget,false);assert.equal(facts().cardPresent,false);
 assert.equal(JSON.stringify(state),before);
 state.truckStatus.synthetic_truck.onLine=true;
 assert.equal(facts().activeTarget,true);assert.equal(facts().cardPresent,false);
 card={querySelector:()=>null};assert.equal(facts().cardPresent,true);assert.equal(facts().expectedTel,false);
 card.querySelector=selector=>selector==='a.truck-phone'||selector==='a[href="tel:+12025550100"]'?{}:null;
 assert.equal(facts().expectedTel,true);assert.equal(facts().expectedMap,true);
 assert.ok(Object.values(facts()).every(v=>typeof v==='boolean'||typeof v==='number'));
 assert.doesNotMatch(JSON.stringify(facts()),/private|synthetic_shift|12025550100/);
 assert.match(stand,/evidence\.lineBeforeReload=[\s\S]*Page.reload[\s\S]*evidence\.lineAfterReload=/);
 assert.match(stand,/finally\{[\s\S]*evidence\.finalLine=/);
});

test('forms are pinned to one open dialog and cancel/removal precedes reopening',()=>{
 assert.doesNotMatch(stand,/document\.querySelector\('dialog (input|form|\[)/);
 assert.doesNotMatch(stand,/querySelectorAll\('dialog'\)\.length"\),0/);
 assert.doesNotMatch(stand,/document\.querySelector\('dialog\[open\]'\)/);
 assert.match(stand,/!qaClosingPhoneDialog\.isConnected/);
 assert.match(stand,/qaPhoneForm\.current\(\)\.querySelector\('form'\)\.requestSubmit/);
 assert.match(stand,/qaPhoneForm\.begin\('synthetic_truck'\);qaDirectoryButton\.click\(\);qaPhoneForm\.pin\('synthetic_truck'\)/);
 assert.match(stand,/await waitFormRemoved\(\);[\s\S]*await openPhoneForm\('synthetic_truck'\)/);
 assert.match(stand,/getAttribute\('onclick'\)===\\"addTruckPhone\('synthetic_truck'\)/);
 assert.match(stand,/evidence\.sqlAfterPOST=await readPhoneSQL\(\)/);
 assert.match(stand,/evidence\.independentGET=await independentPhoneRead\(\)/);
 assert.match(stand,/Page.reload[\s\S]*evidence\.reloadGET=await independentPhoneRead\(\)/);
 assert.match(stand,/finally\{[\s\S]*phone-form-evidence\.json/);
});

function formHarness(){
 const dialogs=[];
 const dialog=(phone=false,open=false)=>{
  const d={isConnected:true,open,querySelector:selector=>phone&&selector==='form input[name=phone]'?{}:null};
  dialogs.push(d);return d;
 };
 // The three persistent non-phone dialogs from the failed run, plus an open
 // unrelated dialog to catch accidental first-open-dialog selection.
 for(let i=0;i<3;i++)dialog();dialog(false,true);
 const context=vm.createContext({document:{querySelectorAll:()=>dialogs.filter(d=>d.isConnected)}});context.window=context;
 vm.runInContext(`(${installPhoneFormQA.toString()})()`,context);
 return {context,dialog,qa:context.qaPhoneForm};
}

test('phone lifecycle ignores shell dialogs but requires removal of the specific old node',async()=>{
 const {context,dialog,qa}=formHarness();
 qa.begin('synthetic_truck');const first=dialog(true,true);qa.pin('synthetic_truck');
 assert.equal(qa.current(),first);
 first.open=false;
 assert.throws(()=>qa.current(),/stale/);
 assert.throws(()=>qa.begin('synthetic_empty'),/previous phone form not removed/);
 // Exercise the actual wait helper with a unit-only polling stub (no CDP).
 const waitSource=stand.match(/const waitFormRemoved=(async\(\)=>\{[\s\S]*?\n \});/)[1];
 let polls=0;
 context.ev=source=>vm.runInContext(source,context);
 context.until=async predicate=>{assert.equal(await predicate(),false);polls++;first.isConnected=false;assert.equal(await predicate(),true);};
 await vm.runInContext(`(${waitSource})()`,context);
 assert.equal(polls,1);assert.equal(context.qaClosingPhoneDialog,first);
 qa.begin('synthetic_empty');const second=dialog(true,true);qa.pin('synthetic_empty');
 assert.equal(qa.current(),second);assert.notEqual(second,first);
 assert.equal(context.qaPhoneTruckId,'synthetic_empty');
});

test('phone identity rejects missing, closed, ambiguous, replaced and wrong-context forms',()=>{
 const {context,dialog,qa}=formHarness();
 qa.begin('synthetic_truck');assert.throws(()=>qa.pin('synthetic_truck'),/ambiguous/);
 const first=dialog(true,false);assert.throws(()=>qa.pin('synthetic_truck'),/ambiguous/);
 first.open=true;assert.throws(()=>qa.pin('synthetic_empty'),/ambiguous/);
 const extra=dialog(true,true);assert.throws(()=>qa.pin('synthetic_truck'),/ambiguous/);
 extra.isConnected=false;qa.pin('synthetic_truck');assert.equal(qa.current(),first);
 context.qaPhoneTruckId='synthetic_empty';assert.throws(()=>qa.current(),/stale/);
 context.qaPhoneTruckId='synthetic_truck';context.qaPhoneDialog=extra;assert.throws(()=>qa.current(),/stale/);
 context.qaPhoneDialog=first;first.isConnected=false;dialog(true,true);assert.throws(()=>qa.current(),/stale/);
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
