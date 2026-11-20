import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {installAuthFixtureTransport} from './phone-auth-fixture.mjs';
import {installDatasetGuard,datasetRequest} from '../server/src/dataset-guard.mjs';
import fs from 'node:fs';

test('diagnostics preserve known server auth codes including duplicate email and fallback',async()=>{
 const files=['index.mjs','identity-store.mjs','identity-rules.mjs','dataset-guard.mjs'];
 const server=files.map(f=>fs.readFileSync(new URL('../server/src/'+f,import.meta.url),'utf8')).join('\n');
 const known=['email-already-exists','invalid-request','identity-email-required','invalid-password','invalid-nickname','invalid-reset-token','invalid-session-id','body-too-large','database-unavailable','unauthorized','forbidden'];
 for(const code of [...known,'secret-shaped-code','token=SECRET']){
  if(known.includes(code))assert.ok(server.includes("'"+code+"'")||server.includes('"'+code+'"'),code+' must originate in server');
  const logs=[];const response=new Response(JSON.stringify({error:code,accessToken:'SECRET',detail:'SECRET'}),{status:409});
  const window={fetch:async url=>url==='/health/live'?new Response('{}',{headers:{'X-Samosval-Epoch':'7'}}):response};
  const context=vm.createContext({window,Headers,Request,URL,location:{href:'https://qa.invalid/',origin:'https://qa.invalid'},console:{info:s=>logs.push(s)}});
  vm.runInContext(`(${installAuthFixtureTransport.toString()})()`,context);
  assert.equal(await window.fetch('/api/v1/auth/register',{method:'POST'}),response);
  assert.equal(window.__qaAuthHTTP[0].code,known.includes(code)?code:'unrecognized-error');
  assert.equal(logs.join('').includes('SECRET'),false);
 }
});

test('real dataset guard rejects epoch-less auth BEGIN at fixture epoch 7',async()=>{
 let connect;const pool={on:(event,fn)=>{connect=fn;},query:async()=>({rows:[{restore_epoch:'7'}]})};installDatasetGuard(pool);
 const client={query:async sql=>sql.startsWith('SELECT restore_epoch')?{rows:[{restore_epoch:'7'}]}:{rows:[]}};connect(client);
 const res={setHeader(){},writeHead(){throw Error('unexpected error swallowing');},end(){}};
 await datasetRequest(pool,{url:'/api/v1/auth/login',method:'POST',headers:{}},res,async()=>assert.rejects(client.query('BEGIN'),{code:'dataset-restored-reload',status:409}));
 await datasetRequest(pool,{url:'/api/v1/auth/login',method:'POST',headers:{'x-samosval-epoch':'7'}},res,async()=>{await client.query('BEGIN');});
});

test('QA adapter learns epoch and preserves HTTP failure; diagnostics discard sensitive fields',async()=>{
 const calls=[],logs=[];const failure=new Response(JSON.stringify({error:'dataset-restored-reload',accessToken:'SECRET',refreshToken:'SECRET',detail:'SECRET'}),{status:409,headers:{'Content-Type':'application/json'}});
 const window={fetch:async(input,options)=>{calls.push({input,options});if(input==='/health/live')return new Response('{}',{headers:{'X-Samosval-Epoch':'7'}});return failure;}};
 const context=vm.createContext({window,Headers,Request,URL,location:{href:'https://qa.invalid/',origin:'https://qa.invalid'},console:{info:s=>logs.push(s)}});
 vm.runInContext(`(${installAuthFixtureTransport.toString()})()`,context);
 const result=await window.fetch('/api/v1/auth/login',{method:'POST',headers:{Authorization:'Bearer SECRET'},body:'SECRET'});
 assert.equal(result,failure);assert.equal(calls[1].options.headers.get('X-Samosval-Epoch'),'7');assert.equal(calls[1].options.body,'SECRET');
 assert.equal(JSON.stringify(window.__qaAuthHTTP).includes('SECRET'),false);assert.equal(logs.join('').includes('SECRET'),false);
 assert.equal(window.__qaAuthHTTP[0].code,'dataset-restored-reload');
 await window.fetch('https://elsewhere.invalid/api/v1/auth/login');assert.equal(calls.length,3);
});
