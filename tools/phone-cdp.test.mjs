import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateCdp} from './phone-cdp.mjs';

test('REPL Promise is awaited by handle before serialization (anonymous HTTP status)',async()=>{
 const calls=[];
 const send=async(method,params)=>{calls.push({method,params});if(method==='Runtime.evaluate')return {result:{type:'object',subtype:'promise',objectId:'promise-1'}};if(method==='Runtime.awaitPromise')return {result:{type:'number',value:401}};return {};};
 assert.equal(await evaluateCdp(send,"fetch('/api/v1/truck-phones').then(r=>r.status)"),401);
 assert.equal(calls[0].params.returnByValue,false);
 assert.deepEqual(calls[1],{method:'Runtime.awaitPromise',params:{promiseObjectId:'promise-1',returnByValue:true}});
 assert.equal(calls[2].method,'Runtime.releaseObject');
});

test('JSON objects/arrays are serialized and synchronous primitives remain unchanged',async()=>{
 for(const value of [{status:403},[{status:409}],401,false,null,undefined]){
  const object=value!==null&&typeof value==='object';const methods=[];
  const send=async method=>{methods.push(method);if(method==='Runtime.evaluate')return {result:object?{type:'object',objectId:'obj'}:{value}};if(method==='Runtime.callFunctionOn')return {result:{value}};return {};};
  assert.deepEqual(await evaluateCdp(send,'expression'),value);
  assert.deepEqual(methods,object?['Runtime.evaluate','Runtime.callFunctionOn','Runtime.releaseObject']:['Runtime.evaluate']);
 }
});

test('void fire-and-forget does not await held POST and promise rejection is propagated',async()=>{
 const methods=[];assert.equal(await evaluateCdp(async method=>{methods.push(method);return {result:{type:'undefined'}};},'void truckPhoneRequest()'),undefined);
 assert.deepEqual(methods,['Runtime.evaluate']);
 const send=async method=>method==='Runtime.evaluate'?{result:{subtype:'promise',objectId:'p'}}:method==='Runtime.awaitPromise'?{exceptionDetails:{text:'rejected'}}:{};
 await assert.rejects(evaluateCdp(send,'Promise.reject()'),/rejected/);
});
