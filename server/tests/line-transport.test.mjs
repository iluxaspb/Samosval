import test from 'node:test';
import assert from 'node:assert/strict';
import {createLineTransport} from '../../test-app/synology/line-transport.mjs';

const op = () => ({id:'offline-123', type:'load', truckId:'t1', shiftId:'s1', createdAt:123});
const confirmed = {outcome:'confirmed', status:{cycleRevision:2}, log:{id:'load1'}};
const response = (status=200, value=confirmed) => ({status, ok:status>=200&&status<300, json:async()=>value});
const config = {baseUrl:'https://nas.example.test', getIdToken:async()=> 'test-token'};

test('POST sends exact queue record to HTTPS API with Firebase token', async()=> {
  let request;
  const transport = createLineTransport({...config, fetchImpl:async(url,options)=> {
    request={url,options}; return response();
  }});
  const operation=op();
  assert.deepEqual(await transport.submit(operation), confirmed);
  assert.equal(request.url, 'https://nas.example.test/api/v1/line/operations');
  assert.equal(request.options.headers.Authorization,'Bearer test-token');
  assert.equal(request.options.body, JSON.stringify(operation));
  assert.equal(request.options.redirect,'error');
  assert.equal(request.options.credentials,'omit');
});

test('401 refreshes token once without changing operation ID, time or serialized body', async()=> {
  const bodies=[], refresh=[];
  const operation=op();
  const transport=createLineTransport({...config,
    getIdToken:async(force)=>{refresh.push(force); operation.createdAt=999; return 'token';},
    fetchImpl:async(url,options)=>{bodies.push(options.body); return response(bodies.length===1?401:200);}
  });
  await transport.submit(operation);
  assert.deepEqual(refresh,[false,true]);
  assert.equal(bodies[0],bodies[1]);
  assert.equal(JSON.parse(bodies[0]).createdAt,123);
});

test('second 401 stops after two requests', async()=> {
  let count=0;
  const transport=createLineTransport({...config,fetchImpl:async()=>{count++;return response(401);}});
  await assert.rejects(transport.submit(op()),{code:'api-http-401',retryable:false});
  assert.equal(count,2);
});

test('timeout is uncertain: queue must retain original operation', async()=> {
  const operation=op(), before=JSON.stringify(operation);
  const transport=createLineTransport({...config,timeoutMs:10,fetchImpl:(url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true});
  })});
  await assert.rejects(transport.submit(operation),{code:'api-timeout',retryable:true,uncertain:true});
  assert.equal(JSON.stringify(operation),before);
});

test('network failure is returned to queue with no alternate database write', async()=> {
  let count=0;
  const transport=createLineTransport({...config,fetchImpl:async()=>{count++;throw new Error('network');}});
  await assert.rejects(transport.submit(op()),{code:'api-unreachable',retryable:true,uncertain:true});
  assert.equal(count,1);
});

test('server rejection is a receipt, not a transport failure', async()=> {
  const receipt={outcome:'rejected',reason:'duplicate-or-arrival-changed',status:{}};
  const transport=createLineTransport({...config,fetchImpl:async()=>response(200,receipt)});
  assert.deepEqual(await transport.submit(op()),receipt);
});

test('retryable gateway errors leave receipt outcome unknown', async()=> {
  for (const status of [408,425,429,500,502,503]) {
    const transport=createLineTransport({...config,fetchImpl:async()=>response(status)});
    await assert.rejects(transport.submit(op()),{status,retryable:true,uncertain:true});
  }
});

test('permission and ID conflict errors stop automatic retry', async()=> {
  for (const status of [400,403,409,413,415]) {
    const transport=createLineTransport({...config,fetchImpl:async()=>response(status)});
    await assert.rejects(transport.submit(op()),{status,retryable:false,uncertain:false});
  }
});

test('malformed successful response cannot acknowledge a queued operation', async()=> {
  for (const value of [null,{}, {outcome:'confirmed'}, {outcome:'confirmed',status:[]}, {outcome:'rejected'}]) {
    const transport=createLineTransport({...config,fetchImpl:async()=>response(200,value)});
    await assert.rejects(transport.submit(op()),{code:'invalid-api-response',uncertain:true});
  }
  const transport=createLineTransport({...config,fetchImpl:async()=>({ok:true,status:200,json:async()=>{throw new Error('HTML');}})});
  await assert.rejects(transport.submit(op()),{code:'invalid-api-response',uncertain:true});
});

test('unavailable authentication sends no operation', async()=> {
  let count=0;
  const transport=createLineTransport({...config,getIdToken:async()=>{throw new Error('signed out');},fetchImpl:async()=>{count++;}});
  await assert.rejects(transport.submit(op()),{code:'authentication-unavailable',uncertain:false});
  assert.equal(count,0);
});

test('insecure or credential-bearing endpoints are rejected before use',()=> {
  for (const baseUrl of ['http://nas.example.test','https://user:pass@nas.example.test','https://nas.example.test/?key=x','https://nas.example.test/#token','bad'])
    assert.throws(()=>createLineTransport({...config,baseUrl}),TypeError);
});

test('operation without durable ID is rejected before authentication or network', async()=> {
  let count=0;
  const transport=createLineTransport({...config,getIdToken:async()=>{count++;return 'token';}});
  await assert.rejects(transport.submit({type:'load'}),{code:'operation-id-required'});
  assert.equal(count,0);
});
