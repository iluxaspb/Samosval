import test from 'node:test';
import assert from 'node:assert/strict';
import {failoverAdminView,createNasFailureDetector,createFailoverAdminController} from '../../test-app/synology/failover-client.mjs';
import {initialFailoverState,prepareFailover} from '../src/failover-policy.mjs';
const hash='a'.repeat(64);
const state=()=>prepareFailover(initialFailoverState(1000),{adapters:{synology:true,firebase:true},checkpoint:{sequence:0,hash}},1000);
test('admin projection hides controls from other roles and blocks unready or stale targets',()=>{
  assert.deepEqual(failoverAdminView(state()),{visible:false,disabled:true});
  assert.equal(failoverAdminView(null,{activeAdmin:true}).disabled,true);
  assert.equal(failoverAdminView(initialFailoverState(1000),{activeAdmin:true}).disabled,true);
  const s=state();s.replicas.synology=null;s.provider='firebase';
  const view=failoverAdminView(s,{activeAdmin:true});assert.equal(view.targets.synology,false);assert.equal(view.targets.firebase,true);
  assert.match(view.detail,/последние изменения/);assert.equal(failoverAdminView(s,{activeAdmin:true,online:false}).disabled,true);
});
test('three requests from the same failing poll are not three independent NAS failures',()=>{
  let time=1000;const detector=createNasFailureDetector({now:()=>time});
  for(let i=0;i<10;i++)assert.equal(detector.observe({code:'api-timeout'}).consecutiveFailures,1);
  time+=1000;assert.equal(detector.observe({code:'api-unreachable'}).eligible,false);
  time+=1000;assert.equal(detector.observe({code:'api-http-503'}).eligible,true);
  detector.reset();assert.equal(detector.observe({code:'api-timeout'}).eligible,false);
});
test('logout/auth failures, denied access, quota, epoch conflict or an offline phone do not trigger failover',()=>{
  let time=1000;const detector=createNasFailureDetector({now:()=>time});
  for(const code of ['authentication-required','authentication-unavailable','api-http-401','api-http-403','api-http-409','api-http-429','dataset-restored-reload']){
    for(let i=0;i<4;i++){time+=1000;assert.equal(detector.observe({code}).eligible,false);}
  }
  for(let i=0;i<4;i++){time+=1000;assert.equal(detector.observe({code:'api-timeout'},{online:false}).eligible,false);}
  assert.equal(detector.observe({code:'api-timeout'},{provider:'firebase'}).consecutiveFailures,0);
});
function controllerFixture(){
  let session={uid:'admin',role:'admin',status:'active',generation:1},current=state(),confirm=async()=>true;
  const calls=[],controller=createFailoverAdminController({getSession:()=>session,read:async()=>current,
    setMode:async command=>{calls.push(command);return {...current,mode:command.mode};},confirm:question=>confirm(question)});
  return {controller,calls,session:x=>{session=x;},state:x=>{current=x;},confirm:x=>{confirm=x;}};
}
test('forced admin command carries the observed shared revision, with no localStorage preference',async()=>{
  const h=controllerFixture();await h.controller.change('firebase');assert.deepEqual(h.calls,[{mode:'firebase',expectedRevision:state().revision}]);
});
test('admin cancellation, missing replica and stale login never send a switch command',async()=>{
  let h=controllerFixture();h.confirm(async()=>false);assert.equal(await h.controller.change('firebase'),null);assert.equal(h.calls.length,0);
  h=controllerFixture();const stale=state();stale.replicas.firebase=null;h.state(stale);await assert.rejects(h.controller.change('firebase'),/последние изменения/);assert.equal(h.calls.length,0);
  h=controllerFixture();h.confirm(async()=>{h.session({uid:'other',role:'admin',status:'active',generation:2});return true;});
  await assert.rejects(h.controller.change('firebase'),/Сеанс/);assert.equal(h.calls.length,0);
});
test('a second click cannot create two concurrent admin switches',async()=>{
  const h=controllerFixture();let release;h.confirm(()=>new Promise(resolve=>{release=resolve;}));
  const pending=h.controller.change('firebase');await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(h.controller.change('synology'),/уже выполняется/);release(true);await pending;
  assert.equal(h.calls.length,1);assert.equal(h.controller.busy,false);
});
