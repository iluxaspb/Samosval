import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Store} from '../../test-app/tabel-v2/store.mjs';
const require=createRequire(import.meta.url);
let indexed;
try{indexed=require('fake-indexeddb');}catch{indexed=createRequire(process.env.TABEL_QUEUE_QA+'/package.json')('fake-indexeddb');}
globalThis.indexedDB=indexed.indexedDB;
test('failed record retains its queue and error while unrelated hours upload',async()=>{
 const sent=[];const remote={read:async()=>({revision:0,data:null}),commit:async j=>{if(j.key==='site/config')throw Object.assign(Error('Denied'),{code:'permission-denied'});sent.push(j.key);return {revision:1,data:j.data};}};
 const s=await new Store('queue-failure-'+Date.now(),remote,()=>({uid:'qa',name:'QA'})).open();
 try{await s.save('site/config',{name:'A'},s.get('site/config'),'config');await s.save('site/day:2026-10-15:day',{hours:12},s.get('site/day:2026-10-15:day'),'hours');await s.flush();assert.deepEqual(sent,['site/day:2026-10-15:day']);assert.equal(s.state.jobs.length,1);assert.match(s.uploadError,/site\/config.*permission-denied/);await s.pull('other/config');assert.match(s.uploadError,/permission-denied/);}finally{await s.close();}
});
