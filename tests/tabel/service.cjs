const assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('../timesheet/node_modules/jsdom');
const C=require('../../test-app/tabel/storage-core.mjs').default;
const dom=new JSDOM('<body></body>',{url:'https://qa.invalid',runScripts:'outside-only'}),w=dom.window;
w.eval(fs.readFileSync('tests/timesheet/fixture.js','utf8'));
global.window=w;global.indexedDB=require('../timesheet/memory-idb.cjs')();Object.defineProperty(global,'navigator',{value:w.navigator,configurable:true});
const online=value=>Object.defineProperty(navigator,'onLine',{value,configurable:true});
const actor={projectId:'samosval-offline',workspaceId:'main_workspace',uid:'qa-admin',name:'QA',role:'admin',status:'active',tabAccess:true,manage:true,permissions:{view:true,edit:true}};
const ctx={db:w.db,refs:{audit:w.wsRef.collection('audit')},showToast:()=>{},ledgerHost:{session:()=>({...actor}),data:()=>({objects:[{id:'obj',name:'Объект'}],shift:null}),workspace:w.wsRef,transaction:fn=>w.db.runTransaction(fn),serverTimestamp:()=>Date.now(),leave:()=>{}}};
const name='dt_timesheet_v1_samosval-offline_main_workspace_qa-admin';
const entry={kind:'person',entityId:'p1',name:'Иван',group:'operator',ownership:'',contractor:'',objectId:'obj',objectName:'Объект',date:'2026-10-27',shift:'day',scope:'obj|2026-10',minutes:720,idleMinutes:0,status:'work',equipmentId:'',note:'',deleted:false};
const id=C.entryId('person','obj',entry.date,'day','p1'),key='workspaces/main_workspace/timesheetEntries/'+id;
async function seed(){return new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>{r.result.createObjectStore('jobs',{keyPath:'id'});r.result.createObjectStore('cache',{keyPath:'key'});};r.onsuccess=()=>{const db=r.result,tx=db.transaction('jobs','readwrite');tx.objectStore('jobs').put({id:'legacy-pending',uid:'qa-admin',scope:'obj|2026-10',createdAt:1,label:'Старая очередь',status:'queued',changes:[{collection:'timesheetEntries',id,baseRevision:0,before:null,data:entry}]});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});}
let service;
(async()=>{try{
 const {createService}=await import('../../test-app/tabel/service.mjs');online(false);await seed();service=await createService(ctx);await service.read('timesheetEntries','obj','obj|2026-10');assert.equal(service.peek('timesheetEntries','obj')[0].minutes,720);assert.equal(service.queue().length,1);await service.dispose();
 actor.uid='qa-other';service=await createService(ctx);assert.equal(service.queue().length,0);await service.dispose();actor.uid='qa-admin';service=await createService(ctx);assert.equal(service.queue().length,1);online(true);await service.replay();await service.idle();assert.equal(w.__rows.get(key).minutes,720);assert.equal(service.queue().length,0);await service.replay();assert.equal([...w.__rows.keys()].filter(x=>x.includes('/timesheetChanges/')).length,1);
 console.log('PASS plugin reuses old IndexedDB queue, disabled/reopened service preserves it, accounts isolate it, reconnect receipt is idempotent');
 await service.read('timesheetEntries','obj','obj|2026-10');const row=service.peek('timesheetEntries','obj')[0];online(false);await service.save([{collection:'timesheetEntries',id,baseRevision:row.revision,before:service.clean(row),data:{...service.clean(row),minutes:600}}],'Офлайн');w.__rows.set(key,{...w.__rows.get(key),minutes:660,revision:2,updatedName:'Коллега'});online(true);await service.replay();assert.equal(w.__rows.get(key).minutes,660);assert.equal(service.queue()[0].status,'conflict');assert.equal(service.queue()[0].conflicts[0].proposed.minutes,600);await service.resolveOperation(service.queue()[0].id,'server');assert.equal(service.queue().length,0);
 console.log('PASS plugin service preserves both conflicting values and explicit server resolution');
 actor.status='disabled';await assert.rejects(()=>service.save([{collection:'timesheetEntries',id,baseRevision:2,before:entry,data:entry}],'Запрещено'),/Доступ/);actor.status='active';await service.dispose();
 console.log('PASS plugin handlers reject a revoked account without changing data');
}catch(e){console.error(e);process.exitCode=1;}finally{await service?.dispose();dom.window.close();}})();
