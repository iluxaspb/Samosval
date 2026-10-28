import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {fixture}=createRequire(import.meta.url)('../full-audit/shift-harness.cjs');
test('actual close archives first, imports before cleanup; failed import keeps trips and retry completes once',async()=>{
 let calls=0,env;
 env=fixture({count:5,shiftSource:'test-app/source/core/15-shifts.js',materialLoader:async()=>({transferClosedLine:async(host,shift,archive)=>{
   calls++;assert.equal(archive.totalVolume,60);assert(env.read('archive','closed_s1'));assert.equal(env.selected('logs','s1').length,5);
   if(calls===1)throw Error('cancel material dialog');
 }})});
 await env.close();assert(env.read('shift','current').closing);assert.equal(env.selected('logs','s1').length,5);assert.equal(env.stats().cleanupCount,0);
 await env.close();assert.equal(env.read('shift','current'),undefined);assert.equal(env.selected('logs','s1').length,0);assert.equal(env.stats().archiveSets,1);assert.equal(calls,2);
});
