// Execute the real PWA bridge with isolated DOM/SW/message-channel doubles. No network or live data.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync('test-app/src/pwa.js','utf8');
function harness({registerError=null, registration=null, supported=true, secure=true, build='0123456789abcdef'}={}) {
  const nodes=Object.fromEntries(['state','install','check','version'].map(id=>['#test-pwa-'+id,{textContent:'',hidden:false,disabled:false}]));
  const group={style:{},querySelector:id=>nodes[id]},events={},timers=new Map();let nextTimer=0,attempts=0,error=registerError,reg=registration;
  const mutations=[];
  const storage={getItem(){return null;},setItem(){mutations.push('set');},removeItem(){mutations.push('remove');},clear(){mutations.push('clear');}};
  const context={
    window:{isSecureContext:secure,TEST_APP_RELEASE:{version:'3.1.22 · тест',label:'Тест 3.1.22'},TestStorageState:{persistent:true},__testGetShift:()=>({id:'s'}),addEventListener:(name,fn)=>events[name]=fn,dispatchEvent(){}},
    document:{hidden:false,currentScript:{src:'https://example.test/Samosval/test-app/build/'+build+'/pwa.js'},createElement:()=>group,querySelector:selector=>selector.startsWith('meta')?{content:build}:{append(){}},addEventListener:(name,fn)=>events[name]=fn},
    navigator:{onLine:true,...(supported?{serviceWorker:{addEventListener:(name,fn)=>events[name]=fn,register:async()=>{attempts++;if(error)throw Error(error);return reg;}}}:{})},
    location:{protocol:'https:',pathname:'/Samosval/index-test.html',href:'https://example.test/Samosval/index-test.html',reload(){mutations.push('reload');}},
    matchMedia:()=>({matches:false}),currentUid:'qa',permissionsLoaded:true,currentUserStatus:'active',currentUserRole:'admin',
    canAdmin:()=>context.currentUserStatus==='active'&&context.currentUserRole==='admin',
    CustomEvent:class{},setInterval(){},setTimeout:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),console,localStorage:storage,
    MessageChannel:class{constructor(){const port1={close(){},onmessage:null};this.port1=port1;this.port2={close(){},postMessage:data=>queueMicrotask(()=>port1.onmessage?.({data}))};}},
    offlineTransportRecovered(){},offlineReplayJournal(){},appNotice(){}
  };
  context.window.localStorage=storage;vm.runInNewContext(source,context);
  return {nodes,context,events,timers,mutations,setError:value=>error=value,setRegistration:value=>reg=value,get attempts(){return attempts;},snapshot:()=>context.window.TestPWA.snapshot(),check:()=>nodes['#test-pwa-check'].onclick()};
}
function worker(version,{complete=true,deferred=false}={}) {
  const listeners={},pending=[];
  return {state:'activated',listeners,pending,postMessage(message,[port]){assert.equal(message.type,'TEST_PWA_STATUS');if(deferred)pending.push(port);else port.postMessage({type:'TEST_PWA_STATUS',version,complete});},addEventListener:(name,fn)=>listeners[name]=fn};
}
function registration(active=null,waiting=null) {
  const events={};return {active,waiting,installing:null,events,updates:0,updateError:null,addEventListener:(name,fn)=>events[name]=fn,async update(){this.updates++;if(this.updateError)throw Error(this.updateError);}};
}
const flush=()=>new Promise(setImmediate);
(async()=>{
  const failed=harness({registerError:'network unavailable'});await flush();
  assert.equal(failed.attempts,1);assert.match(failed.nodes['#test-pwa-state'].textContent,/network unavailable/);
  await failed.check();assert.equal(failed.attempts,2);
  assert.match(failed.nodes['#test-pwa-state'].textContent,/network unavailable/,'Failed retry must retain the actual error');
  assert.equal(failed.snapshot().error,'network unavailable');assert.equal(failed.nodes['#test-pwa-check'].disabled,false);
  failed.setError(null);failed.setRegistration(registration(worker('0123456789abcdef')));await failed.check();
  assert.equal(failed.snapshot().error,'');assert.equal(failed.snapshot().shellReady,true);
  console.log('PASS registration rejection remains visible after retry; successful retry clears it');

  const reg=registration(worker('old-build')),h=harness({registration:reg});await flush();
  assert.equal(h.snapshot().buildVersion,'0123456789abcdef');assert.equal(h.snapshot().releaseVersion,'3.1.22 · тест');
  assert.equal(h.snapshot().activeVersion,'old-build');assert.match(h.nodes['#test-pwa-version'].textContent,/0123456789abcdef/);assert.match(h.nodes['#test-pwa-version'].textContent,/old-build/);
  assert.equal(h.nodes['#test-pwa-version'].hidden,false);
  for(const change of [{currentUserRole:'viewer'},{currentUserRole:'admin',currentUserStatus:'pending'},{currentUserStatus:'active',permissionsLoaded:false}]){
    Object.assign(h.context,change);h.events.offline();
    assert.equal(h.nodes['#test-pwa-version'].hidden,true,'Version diagnostics are admin-only');
    assert.equal(h.nodes['#test-pwa-version'].textContent,'');
    assert(h.nodes['#test-pwa-state'].textContent,'Operational status remains available');
  }
  h.context.permissionsLoaded=true;h.events.offline();
  assert.equal(h.nodes['#test-pwa-version'].hidden,false);
  assert.match(source,/id="test-pwa-version" class="version-text" hidden/,'Shared CSS must hide diagnostics immediately on role revocation');
  console.log('PASS PWA build/release diagnostics are visible only to an active admin; readiness remains available to all roles');
  assert.equal(h.snapshot().shellReady,false,'A different cached build must not claim the open code is offline-ready');
  reg.active=worker('0123456789abcdef');await h.check();assert.equal(h.snapshot().shellReady,true);
  reg.updateError='update rejected';await h.check();assert.equal(h.snapshot().error,'update rejected');assert.equal(h.snapshot().shellReady,true);
  reg.updateError=null;reg.waiting=worker('next-build');await h.check();
  assert.equal(h.snapshot().error,'');assert.equal(h.snapshot().waitingVersion,'next-build');assert.equal(h.snapshot().updateReady,true);
  assert.match(h.nodes['#test-pwa-state'].textContent,/закройте все окна/);assert.match(h.nodes['#test-pwa-state'].textContent,/Очередь действий сохранится/);
  h.context.window.TestStorageState.persistent=false;h.events.offline();assert.doesNotMatch(h.nodes['#test-pwa-state'].textContent,/закройте все окна/,'Do not advise closing before durable storage is confirmed');
  h.context.window.TestStorageState.persistent=true;h.events.offline();
  reg.waiting=null;assert.equal(h.snapshot().updateReady,false,'Disappeared waiting worker is no longer ready');
  assert.deepEqual(h.mutations,[],'Checking or preparing an update must not clear storage, write data, or reload');
  console.log('PASS loaded/active/waiting build IDs remain distinct; ready update never forces reload or deletes data');

  let finishUpdate;const originalUpdate=reg.update;reg.update=()=>{reg.updates++;return new Promise(resolve=>finishUpdate=resolve);};
  const updatesBefore=reg.updates,firstCheck=h.check(),secondCheck=h.check();assert.equal(firstCheck,secondCheck);assert.equal(reg.updates,updatesBefore+1);
  assert.equal(h.nodes['#test-pwa-check'].disabled,true);finishUpdate();await firstCheck;assert.equal(h.nodes['#test-pwa-check'].disabled,false);reg.update=originalUpdate;
  console.log('PASS repeated checks share one request; update never recommends closing before durable storage is confirmed');

  reg.waiting=worker('incomplete',{complete:false});await h.check();assert.equal(h.snapshot().updateReady,false);
  assert.doesNotMatch(h.nodes['#test-pwa-state'].textContent,/Обновление загружено/);
  const stale=worker('stale',{deferred:true});reg.active=stale;const oldCheck=h.check();await flush();
  reg.active=worker('fresh');const newStatus=h.events.controllerchange();await flush();
  for(const port of stale.pending)port.postMessage({type:'TEST_PWA_STATUS',version:'stale',complete:true});
  await oldCheck;await newStatus;assert.equal(h.snapshot().activeVersion,'fresh');
  console.log('PASS incomplete waiting bundle is not ready; delayed old worker response cannot replace newer status');

  const timeoutReg=registration(worker('silent',{deferred:true})),timed=harness({registration:timeoutReg});await flush();
  for(const fn of [...timed.timers.values()])fn();await flush();
  assert.equal(timed.snapshot().shellReady,false);assert.match(timed.nodes['#test-pwa-state'].textContent,/не ответил|не подтвержд/);
  assert.equal(timed.nodes['#test-pwa-check'].disabled,false);
  const unsupported=harness({supported:false});await flush();await unsupported.check();
  assert.match(unsupported.snapshot().error,/не поддерживает/);assert.equal(unsupported.nodes['#test-pwa-check'].disabled,true);
  const insecure=harness({secure:false});await flush();await insecure.check();assert.match(insecure.snapshot().error,/не поддерживает/);
  console.log('PASS missing status, unsupported browser, and insecure context keep an honest actionable state');
})().catch(e=>{console.error(e);process.exitCode=1;});
