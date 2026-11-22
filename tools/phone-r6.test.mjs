import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as cdp from './phone-cdp.mjs';

function harness(){
 const collector=cdp.cdpErrorCollector();
 const event=(method,params={})=>collector.event(method,params);
 const request=(id,loaderId)=>event('Network.requestWillBeSent',{requestId:id,loaderId,request:{url:'https://qa.invalid/api/v1/auth/login?secret=PRIVATE',method:'POST',headers:{Authorization:'PRIVATE'},postData:'PRIVATE'}});
 const response=(id,status)=>event('Network.responseReceived',{requestId:id,response:{status,url:'PRIVATE',headers:{Authorization:'PRIVATE'}}});
 return {collector,event,request,response};
}

test('auth error in old document survives reload before next poll and new document success',()=>{
 const {collector,event,request,response}=harness();
 request('before','doc0');response('before',200);
 const start=collector.authMark();assert.equal(start,1);
 request('failed','doc1');response('failed',503);
 event('Runtime.executionContextsCleared');event('Page.frameNavigated');
 request('success','doc2');response('success',200);
 assert.equal(collector.authFailuresSince(start).length,1);
 assert.equal(collector.authFailuresSince(start)[0].status,503);
 assert.throws(()=>collector.assertAuthSince(start),/QA auth failure/);
 assert.equal(collector.snapshot().auth.length,3);
 assert.doesNotMatch(JSON.stringify(collector.snapshot()),/PRIVATE|secret|Authorization|postData/);
});

test('request begun before reload but completed afterwards remains in the login interval',()=>{
 const {collector,event,request,response}=harness();
 const start=collector.authMark();request('in-flight','old');
 event('Runtime.executionContextsCleared');request('new','new');response('new',200);response('in-flight',401);
 assert.throws(()=>collector.assertAuthSince(start),/QA auth failure/);
});

test('native CDP unhandled rejection survives destruction of its VM document without reading globals',()=>{
 const {collector,event}=harness();
 let document=vm.createContext({emit:params=>event('Runtime.exceptionThrown',params)});
 vm.runInContext(`emit({exceptionDetails:{text:'Uncaught (in promise)',executionContextId:17,exception:{description:'PRIVATE reason',value:'PRIVATE token'}}})`,document);
 document=null;event('Runtime.executionContextDestroyed',{executionContextId:17});event('Runtime.executionContextsCleared');
 vm.runInNewContext('var __qaRejections=[]');
 assert.equal(collector.errors.length,1);assert.equal(collector.rejections.length,1);
 assert.doesNotMatch(JSON.stringify(collector.snapshot()),/PRIVATE|reason|token/);
 assert.throws(()=>collector.assertNoExceptions(),/QA browser exception/);
});

test('auth transport failure is retained without raw error text, and snapshots cannot erase evidence',()=>{
 const {collector,event,request}=harness();
 request('failed','old');event('Network.loadingFailed',{requestId:'failed',errorText:'PRIVATE'});
 collector.snapshot().auth.length=0;
 assert.equal(collector.authFailuresSince(0)[0].transportFailure,true);
 assert.throws(()=>collector.assertAuthSince(0),/QA auth failure/);
 assert.doesNotMatch(JSON.stringify(collector.snapshot()),/PRIVATE/);
});

test('stand gates login and all-document exceptions without document-local diagnostic cursors',()=>{
 const source=readFileSync(new URL('./phone-stand-896.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/__qaAuthHTTP|__qaRejections/);
 assert.match(source,/diagnosticStart=browser\.collector\.authMark\(\)/);
 assert.match(source,/browser\.collector\.assertAuthSince\(diagnosticStart\)/);
 assert.match(source,/browser\.collector\.assertNoExceptions\(\)/);
});

test('auth redirect failure and errors from many destroyed documents are never trimmed or revoked',()=>{
 const {collector,event,request}=harness();
 request('redirect','old');
 event('Network.requestWillBeSent',{requestId:'redirect',loaderId:'new',redirectResponse:{status:503},request:{url:'https://qa.invalid/home?PRIVATE'}});
 for(let i=0;i<200;i++){
  event('Runtime.exceptionThrown',{exceptionDetails:{text:'PRIVATE'}});
  event('Runtime.exceptionRevoked',{exceptionId:i,reason:'PRIVATE'});
  event('Runtime.executionContextsCleared');
 }
 assert.equal(collector.errors.length,200);
 assert.throws(()=>collector.assertNoExceptions(),/QA browser exception/);
 assert.equal(collector.authFailuresSince(0)[0].status,503);
 assert.doesNotMatch(JSON.stringify(collector.snapshot()),/PRIVATE/);
});
