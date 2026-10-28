// Actual plugin service + Firebase SDK + isolated Firestore rules, synthetic data only.
const assert=require('node:assert/strict'),fs=require('node:fs'),{spawn}=require('node:child_process');
const {JSDOM}=require('../timesheet/node_modules/jsdom');
const firebase=require('../timesheet/node_modules/firebase/compat/app');require('../timesheet/node_modules/firebase/compat/firestore');
const {initializeTestEnvironment}=require('../timesheet/node_modules/@firebase/rules-unit-testing');
const memoryIdb=require('../timesheet/memory-idb.cjs');
const project='demo-tabel-service-release',port=8093,apps=[],services=[];
const dom=new JSDOM('<body></body>',{url:'https://isolated-tabel.invalid'});
global.window=dom.window;Object.defineProperty(global,'navigator',{value:dom.window.navigator,configurable:true});
const online=value=>Object.defineProperty(navigator,'onLine',{value,configurable:true});
let env,log='';const child=spawn('java',['-jar',process.env.FIRESTORE_EMULATOR_JAR||'../firestore-emulator.jar','--host','127.0.0.1','--port',String(port),'--project_id',project]);
child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
const wait=async condition=>{for(let i=0;i<300;i++){if(await condition())return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out waiting for server/service acknowledgement');};
function client(uid,name){const app=firebase.initializeApp({projectId:project,apiKey:'isolated-demo'},name);apps.push(app);const db=app.firestore();db.useEmulator('127.0.0.1',port,{mockUserToken:{sub:uid,email:uid+'@example.test'}});return{db,ws:db.collection('workspaces').doc('main_workspace')};}
function context(client,uid,role){return{db:client.db,refs:{audit:client.ws.collection('audit')},showToast:()=>{},ledgerHost:{
 session:()=>({projectId:'samosval-offline',workspaceId:'main_workspace',uid,name:uid,role,status:'active',tabAccess:true,manage:role==='admin',permissions:{view:true,edit:true}}),
 data:()=>({objects:[{id:'qa-obj',name:'Изолированный QA объект'}],shift:null}),workspace:client.ws,
 transaction:fn=>client.db.runTransaction(fn),serverTimestamp:()=>firebase.firestore.FieldValue.serverTimestamp(),leave:()=>{}
}};}
const change=(collection,id,data,row)=>({collection,id,data,baseRevision:row?.revision||0,before:row||null});
(async()=>{try{
 online(true);await wait(()=>log.includes('Dev App Server is now running'));
 env=await initializeTestEnvironment({projectId:project,firestore:{host:'127.0.0.1',port,rules:fs.readFileSync('firestore-timesheet-test.rules','utf8')}});
 await env.withSecurityRulesDisabled(async c=>{const db=c.firestore();await db.doc('users/admin').set({role:'admin',status:'active'});await db.doc('users/editor').set({role:'editor',status:'active'});await db.doc('settings/permissions').set({editor:{tabs:['timesheet'],actions:['timesheet_edit']}});await db.doc('workspaces/main_workspace/trucks/sentinel').set({number:'KEEP'});await db.doc('workspaces/main_workspace/shift/sentinel').set({active:true});});
 const D=await import('../../test-app/tabel/domain.mjs'),{createService}=await import('../../test-app/tabel/service.mjs');
 const admin=client('admin','service-admin'),a=client('editor','service-device-a'),b=client('editor','service-device-b');
 global.indexedDB=memoryIdb();const sa=await createService(context(admin,'admin','admin'));services.push(sa);
 const config=D.defaults('qa-obj',D.isoToday());config.acl.roles.editor={'table.view':true,'table.edit':true,'shift.view':true,'shift.edit':true,'people.edit':true,'equipment.edit':true,'materials.view':true,'materials.edit':true,'plans.view':true,'plans.edit':true};
 await sa.save([change('timesheetObjects','qa-obj',config)],'QA settings');await sa.idle();assert.equal(sa.queue().length,0);assert((await admin.ws.collection('timesheetObjects').doc('qa-obj').get({source:'server'})).exists);
 const storageA=memoryIdb();global.indexedDB=storageA;let serviceA=await createService(context(a,'editor','editor'));services.push(serviceA);
 await serviceA.read('timesheetObjects','qa-obj');await serviceA.read('timesheetSheets','qa-obj');
 const sheet={objectId:'qa-obj',schemaVersion:1,deleted:false,name:'QA сохранение',type:'blank',rowCount:20,colCount:10,cells:{A1:{raw:'Из первого клиента'},B1:{raw:'=2+3'}},columnWidths:{},rowHeights:{}};
 await serviceA.save([change('timesheetSheets','qa-sheet',sheet)],'QA sheet');await serviceA.idle();assert.equal(serviceA.queue().length,0);
 const direct=(await b.ws.collection('timesheetSheets').doc('qa-sheet').get({source:'server'})).data();assert.equal(direct.cells.A1.raw,'Из первого клиента');assert.equal(direct.cells.B1.raw,'=2+3');assert.equal(direct.revision,1);
 global.indexedDB=memoryIdb();const serviceB=await createService(context(b,'editor','editor'));services.push(serviceB);await serviceB.read('timesheetObjects','qa-obj');const second=await serviceB.read('timesheetSheets','qa-obj');assert(second.complete&&!second.error);assert.equal(second.rows[0].cells.A1.raw,'Из первого клиента');
 const row=second.rows[0],clean=serviceB.clean(row);await serviceB.save([change('timesheetSheets','qa-sheet',{...clean,cells:{...clean.cells,A1:{raw:'Из второго клиента'}}},row)],'QA second device');await serviceB.idle();assert.equal(serviceB.queue().length,0);
 await wait(()=>serviceA.peek('timesheetSheets','qa-obj').find(x=>x.id==='qa-sheet')?.revision===2);
 console.log('PASS actual service/Firebase SDK saves settings and sheet, fresh device reads server data, second device change arrives through subscription');
 const current=serviceA.peek('timesheetSheets','qa-obj').find(x=>x.id==='qa-sheet');
 online(false);await a.db.disableNetwork();await serviceA.save([change('timesheetSheets','qa-sheet',{...serviceA.clean(current),cells:{A1:{raw:'Сохранено офлайн'}}},current)],'QA offline');await serviceA.idle();assert.equal(serviceA.queue().length,1);await serviceA.dispose();
 global.indexedDB=storageA;serviceA=await createService(context(a,'editor','editor'));services.push(serviceA);assert.equal(serviceA.queue().length,1);assert.equal(serviceA.queue()[0].changes[0].data.cells.A1.raw,'Сохранено офлайн');
 online(true);await a.db.enableNetwork();await serviceA.replay();await serviceA.idle();assert.equal(serviceA.queue().length,0);
 const synced=(await b.ws.collection('timesheetSheets').doc('qa-sheet').get({source:'server'})).data();assert.equal(synced.cells.A1.raw,'Сохранено офлайн');assert.equal(synced.revision,3);
 const receiptCount=(await admin.ws.collection('timesheetChanges').get({source:'server'})).size;await serviceA.replay();await serviceA.idle();assert.equal((await admin.ws.collection('timesheetChanges').get({source:'server'})).size,receiptCount);
 console.log('PASS real service offline queue survives service restart, reconnect reaches Firestore, receipt replay creates no duplicate');
 await assert.rejects(()=>serviceA.save([change('logs','forbidden',{objectId:'qa-obj'})],'Forbidden'),/вне табеля/);
 await env.withSecurityRulesDisabled(async c=>{const db=c.firestore();assert.deepEqual((await db.doc('workspaces/main_workspace/trucks/sentinel').get()).data(),{number:'KEEP'});assert.deepEqual((await db.doc('workspaces/main_workspace/shift/sentinel').get()).data(),{active:true});assert.equal((await db.collection('workspaces/main_workspace/logs').get()).size,0);});
 console.log('PASS host Line/shift/trip sentinels remain unchanged; service refuses host writes');
}catch(e){console.error(e);console.error(log.slice(-2000));process.exitCode=1;}finally{for(const s of services)await s.dispose();for(const app of apps)await app.delete();await env?.cleanup();child.kill();dom.window.close();}})();
