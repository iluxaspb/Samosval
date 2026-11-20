import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {cdpErrorCollector} from './phone-cdp.mjs';

function harness(){
 const collector=cdpErrorCollector();
 const event=(method,params)=>collector.event(method,params);
 const request=id=>event('Network.requestWillBeSent',{requestId:id,loaderId:'old',request:{url:'https://qa.invalid/api/v1/auth/login'}});
 const response=(id,status)=>event('Network.responseReceived',{requestId:id,response:{status}});
 const finish=id=>event('Network.loadingFinished',{requestId:id});
 return {collector,event,request,response,finish};
}

test('late 503 after leaving login still blocks final gate despite a fresh login mark',async()=>{
 const {collector,request,response,finish}=harness();
 const loginMark=collector.authMark();request('late');
 collector.assertAuthSince(loginMark); // The old login returned here with no response.
 const nextLoginMark=collector.authMark();
 response('late',503);finish('late');
 assert.equal(collector.authFailuresSince(nextLoginMark).length,0);
 await assert.rejects(()=>collector.assertClean(),/QA auth failure/);
});

test('login interval waits for terminal network event, including newly begun auth requests',async()=>{
 const {collector,request,response,finish}=harness();
 const mark=collector.authMark();request('first');response('first',200);
 let settled=false;
 const waiting=collector.waitAuthSince(mark,1000).then(()=>{settled=true;});
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(settled,false);
 request('second');finish('first');response('second',200);
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(settled,false);
 finish('second');await waiting;assert.equal(settled,true);
 await collector.assertClean();
});

test('uncompleted auth fails by bounded deadline, not a false final PASS',async()=>{
 const {collector,request,response}=harness();request('stuck');response('stuck',200);
 await assert.rejects(()=>collector.assertClean(20),/auth requests incomplete/);
});

test('login wait rejects a 503 arriving after its last synchronous check',async()=>{
 const {collector,request,response,finish}=harness();
 const mark=collector.authMark();request('late');collector.assertAuthSince(mark);
 const waiting=collector.waitAuthSince(mark,1000);
 setTimeout(()=>{response('late',503);finish('late');},10);
 await assert.rejects(()=>waiting,/QA auth failure/);
});

test('redirect terminates its preceding auth request but retains its failure at final gate',async()=>{
 const {collector,event,request}=harness();request('redirect');
 event('Network.requestWillBeSent',{requestId:'redirect',loaderId:'new',redirectResponse:{status:503},request:{url:'https://qa.invalid/home'}});
 await collector.waitAuthSettled(0,20);
 assert.equal(collector.snapshot().auth[0].complete,true);
 await assert.rejects(()=>collector.assertClean(),/QA auth failure/);
});

test('late transport failure from old document blocks final gate',async()=>{
 const {collector,event,request}=harness();request('old');
 event('Runtime.executionContextsCleared',{});
 event('Network.loadingFailed',{requestId:'old',errorText:'PRIVATE'});
 await assert.rejects(()=>collector.assertClean(),/QA auth failure/);
 assert.doesNotMatch(JSON.stringify(collector.snapshot()),/PRIVATE/);
});

test('only a completed exact negative response may be allowed; evidence remains',async()=>{
 const {collector,request,response,finish}=harness();
 request('disabled');response('disabled',403);
 assert.throws(()=>collector.allowAuthFailure(1,{route:'/api/v1/auth/login',status:403}),/expected auth response/);
 finish('disabled');collector.allowAuthFailure(1,{route:'/api/v1/auth/login',status:403});
 await collector.assertClean();
 assert.equal(collector.snapshot().auth[0].expectedFailure,true);
 request('unexpected');response('unexpected',503);finish('unexpected');
 assert.throws(()=>collector.allowAuthFailure(2,{route:'/api/v1/auth/login',status:403}),/expected auth response/);
 await assert.rejects(()=>collector.assertClean(),/QA auth failure/);
});

test('expected negative cannot silence another 403, transport failure or exception',async()=>{
 for(const kind of ['403','transport','exception']){
  const {collector,event,request,response,finish}=harness();
  request('allowed');response('allowed',403);finish('allowed');
  collector.allowAuthFailure(1,{route:'/api/v1/auth/login',status:403});
  if(kind==='exception')event('Runtime.exceptionThrown',{exceptionDetails:{text:'Uncaught (in promise)'}});
  else {request('other');if(kind==='403'){response('other',403);finish('other');}else event('Network.loadingFailed',{requestId:'other'});}
  await assert.rejects(()=>collector.assertClean(),/QA (auth failure|browser exception)/);
 }
});

test('stand awaits login interval and global gate, allows only exact disabled response',()=>{
 const source=readFileSync(new URL('./phone-stand-896.mjs',import.meta.url),'utf8');
 assert.match(source,/await browser\.collector\.waitAuthSince\(diagnosticStart\)/);
 assert.match(source,/await browser\.collector\.assertClean\(\)/);
 assert.match(source,/allowAuthFailure\([^\n]+status:403/);
});
