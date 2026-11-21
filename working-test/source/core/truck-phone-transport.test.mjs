import test from 'node:test';
import assert from 'node:assert/strict';
import {createNasClient} from '../../synology/session-client.mjs';
const user={uid:'phone',getIdToken:async()=> 'synthetic'};
test('phone transport uses dataset/generation and validates envelope',async()=>{
 const calls=[];globalThis.localStorage={getItem:()=> '7'};
 const c=createNasClient({getUser:()=>user,fetchImpl:async(url,options)=>{calls.push(options);return {ok:true,status:200,headers:{get:()=>null},json:async()=>({source:'ubuntu',phones:[]})};}});
 assert.equal(typeof c.readTruckPhones,'function');
 await c.readTruckPhones();
 await c.submitTruckPhone({truckId:'t',phone:'+12025556789',driverName:'Иван Петров'});
 assert.equal(calls[0].headers['X-Samosval-Epoch'],'7');
 assert.equal(calls[1].headers['X-Samosval-Generation'],'0');
 assert.ok(calls[0].signal);
 // The driver name travels in the POST body, not in the private read path.
 const body=JSON.parse(calls[1].body);
 assert.equal(body.truckId,'t');assert.equal(body.phone,'+12025556789');assert.equal(body.driverName,'Иван Петров');
 c.stop();delete globalThis.localStorage;
});
test('phone transport learns generation, handles dataset response and rejects malformed payload',async()=>{
 const calls=[];let mode='session';
 const envelopes={
  session:{format:'samosval-session',version:1,source:'ubuntu',workspaceId:'main_workspace',identityReady:true,profile:null,permissions:{tabs:[],actions:[]},authority:{provider:'ubuntu',generation:6}},
  invalid:{source:'other',phones:[]},
  valid:{source:'ubuntu',phones:[]}
 };
 const c=createNasClient({getUser:()=>user,fetchImpl:async(url,options)=>{
  calls.push(options);
  return {ok:true,status:200,headers:{get:k=>mode==='epoch'&&k==='X-Samosval-Epoch'?'9':null},json:async()=>envelopes[mode]};
 }});
 await c.readSession();
 mode='valid';await c.submitTruckPhone({truckId:'t',phone:'+12025556789'});
 assert.equal(calls[1].headers['X-Samosval-Generation'],'6');
 mode='invalid';await assert.rejects(c.readTruckPhones(),{code:'invalid-api-response'});
 mode='epoch';await assert.rejects(c.readTruckPhones());
 c.stop();
});
test('driver name may be a string, null or absent — anything else is a malformed envelope',async()=>{
 const envelopes={
  driver:{source:'ubuntu',phones:[{truckId:'t',phone:'+12025556789',driverName:'Иван Петров'}]},
  drivernull:{source:'ubuntu',phones:[{truckId:'t',phone:'+12025556789',driverName:null}]},
  driverabsent:{source:'ubuntu',phones:[{truckId:'t',phone:'+12025556789'}]},
  driverbad:{source:'ubuntu',phones:[{truckId:'t',phone:'+12025556789',driverName:42}]}
 };
 let mode='driver';
 const c=createNasClient({getUser:()=>user,fetchImpl:async()=>({ok:true,status:200,headers:{get:()=>null},json:async()=>envelopes[mode]})});
 assert.equal((await c.readTruckPhones()).phones[0].driverName,'Иван Петров');
 mode='drivernull';assert.equal((await c.readTruckPhones()).phones[0].driverName,null);
 mode='driverabsent';assert.equal((await c.readTruckPhones()).phones[0].driverName,undefined);
 mode='driverbad';await assert.rejects(c.readTruckPhones(),{code:'invalid-api-response'});
 // The same strictness applies to the POST answer.
 await assert.rejects(c.submitTruckPhone({truckId:'t',phone:'+12025556789',driverName:'Иван'}),{code:'invalid-api-response'});
 c.stop();
});
test('phone transport bounds hung fetch and stop aborts',async()=>{
 for(const stop of [false,true]){const c=createNasClient({getUser:()=>user,timeoutMs:15,fetchImpl:()=>new Promise(()=>{})});assert.equal(typeof c.readTruckPhones,'function');const p=c.readTruckPhones();if(stop)c.stop();await assert.rejects(p);}
});
