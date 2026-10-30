import test from 'node:test';
import assert from 'node:assert/strict';
import {checkReserveEndpoint} from '../scripts/smoke-test-reserve.mjs';

const BASE='https://samosval-test-reserve-xyz-ef.a.run.app';
function fixture({projectId='samosval-offline',mode='line-test-only',
  invalidTokenStatus=401,corsStatus=204,originStatus=403}={}){
 const calls=[];
 const response=(status,body={})=>({status,
  headers:{get:name=>name==='Access-Control-Allow-Origin'&&status===204?
   'https://iluxaspb.github.io':null},
  json:async()=>body});
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  const p=new URL(url).pathname;
  if(p==='/health/live')return response(200,{status:'ok',source:'firebase',projectId,mode});
  if(options.method==='OPTIONS')return response(corsStatus);
  if(options.headers?.Origin==='https://wrong-origin.example')return response(originStatus);
  if(options.headers?.Authorization)return response(invalidTokenStatus);
  if(p==='/api/v1/session')return response(401);
  throw Error('unexpected-smoke-path');
 };
 return {fetchImpl,calls};
}
test('public deployment checks project, unavailable unauth write, and strict CORS',async()=>{
 const h=fixture();
 const result=await checkReserveEndpoint(BASE,{fetchImpl:h.fetchImpl});
 assert.deepEqual(result,{projectId:'samosval-offline',mode:'line-test-only',
  health:200,noToken:401,invalidToken:401,unauthorizedWrite:401,cors:204,forbiddenOrigin:403});
 assert.equal(h.calls.length,6);
 assert.equal(h.calls[3].options.method,'POST');
 assert.equal(h.calls[3].options.credentials,'omit');
 assert.equal(h.calls[3].options.headers.Authorization.includes('definitely-not-a-firebase'),true);
});
test('deployment check rejects wrong project or disabled business handler',async()=>{
 for(const h of [fixture({projectId:'other-project'}),fixture({mode:'disabled'})]){
  await assert.rejects(checkReserveEndpoint(BASE,{fetchImpl:h.fetchImpl}),
   {message:'smoke-wrong-project-or-serve-mode'});
  assert.equal(h.calls.length,1);
 }
});
test('deployment check rejects unexpected authenticated access or CORS leakage',async()=>{
 for(const h of [fixture({invalidTokenStatus:200}),fixture({corsStatus:200}),
  fixture({originStatus:200})])
  await assert.rejects(checkReserveEndpoint(BASE,{fetchImpl:h.fetchImpl}),
   /smoke-/);
});
test('public probe accepts only Cloud Run HTTPS URLs without credentials or paths',async()=>{
 for(const bad of ['http://samosval-test.run.app/',
  'https://admin:password@samosval-test.run.app/',
  'https://samosval-test.run.app/api/v1/session',
  'https://samosval-test.run.app/?auth=token',
  'https://test.othercloud.net/',
  'https://evil.run.app.attacker.example/',
  'file:///tmp/local']){
  await assert.rejects(checkReserveEndpoint(bad,{fetchImpl:async()=>{throw Error('network-should-not-run');}}),
   {message:'smoke-invalid-reserve-url'});
 }
});
