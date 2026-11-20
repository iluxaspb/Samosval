import test from 'node:test';
import assert from 'node:assert/strict';
import {createNasClient} from '../../synology/session-client.mjs';
const user={uid:'phone',getIdToken:async()=> 'synthetic'};
test('phone transport uses dataset/generation and validates envelope',async()=>{
 const calls=[];globalThis.localStorage={getItem:()=> '7'};
 const c=createNasClient({getUser:()=>user,fetchImpl:async(url,options)=>{calls.push(options);return {ok:true,status:200,headers:{get:()=>null},json:async()=>({source:'ubuntu',phones:[]})};}});
 assert.equal(typeof c.readTruckPhones,'function');await c.readTruckPhones();await c.submitTruckPhone({truckId:'t',phone:'+123456789'});
 assert.equal(calls[0].headers['X-Samosval-Epoch'],'7');assert.equal(calls[1].headers['X-Samosval-Generation'],'0');assert.ok(calls[0].signal);c.stop();delete globalThis.localStorage;
});
test('phone transport learns generation, handles dataset response and rejects malformed payload',async()=>{
 const calls=[];let mode='session';const c=createNasClient({getUser:()=>user,fetchImpl:async(url,options)=>{calls.push(options);return {ok:true,status:200,headers:{get:k=>mode==='epoch'&&k==='X-Samosval-Epoch'?'9':null},json:async()=>mode==='session'?{format:'samosval-session',version:1,source:'ubuntu',workspaceId:'main_workspace',identityReady:true,profile:null,permissions:{tabs:[],actions:[]},authority:{provider:'ubuntu',generation:6}}:mode==='invalid'?{source:'other',phones:[]}:{source:'ubuntu',phones:[]}};}});
 await c.readSession();mode='valid';await c.submitTruckPhone({truckId:'t',phone:'+123456789'});assert.equal(calls[1].headers['X-Samosval-Generation'],'6');mode='invalid';await assert.rejects(c.readTruckPhones(),{code:'invalid-api-response'});mode='epoch';await assert.rejects(c.readTruckPhones());c.stop();
});
test('phone transport bounds hung fetch and stop aborts',async()=>{
 for(const stop of [false,true]){const c=createNasClient({getUser:()=>user,timeoutMs:15,fetchImpl:()=>new Promise(()=>{})});assert.equal(typeof c.readTruckPhones,'function');const p=c.readTruckPhones();if(stop)c.stop();await assert.rejects(p);}
});
