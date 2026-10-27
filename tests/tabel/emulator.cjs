const fs=require('node:fs'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const firebase=require('../timesheet/node_modules/firebase/compat/app');require('../timesheet/node_modules/firebase/compat/firestore');
const {initializeTestEnvironment,assertFails}=require('../timesheet/node_modules/@firebase/rules-unit-testing');
const C=require('../../test-app/tabel/storage-core.mjs').default;
const port=8092,project='demo-tabel-isolated',apps=[];let env,log='';
const child=spawn('java',['-jar',process.env.FIRESTORE_EMULATOR_JAR||'../firestore-emulator.jar','--host','127.0.0.1','--port',String(port),'--project_id',project]);child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
function client(uid){const app=firebase.initializeApp({projectId:project,apiKey:'demo'},uid);apps.push(app);const db=app.firestore();db.useEmulator('127.0.0.1',port,{mockUserToken:{sub:uid,email:uid+'@example.com'}});return {db,ws:db.collection('workspaces').doc('main_workspace'),actor:{uid,name:uid},run:fn=>db.runTransaction(fn)};}
let seq=0;const op=(a,changes)=>({id:'qa-'+(++seq),uid:a.actor.uid,label:'QA',scope:'obj|2026-10',createdAt:Date.now(),status:'queued',changes});
const send=(a,changes)=>{const operation=Array.isArray(changes)?op(a,changes):changes;return C.commitOperation(a.db,a.ws,operation,a.actor,a.run);};
const change=(collection,id,data,baseRevision=0)=>({collection,id,data,baseRevision,before:null});
(async()=>{try{
 for(let i=0;i<150&&!log.includes('Dev App Server is now running');i++)await new Promise(r=>setTimeout(r,100));if(!log.includes('Dev App Server is now running'))throw Error(log);
 const rules=fs.readFileSync(process.env.TABEL_RULES_PATH||'test-app/tabel/firestore.sandbox.rules','utf8'),integrated=rules.includes('function ledgerEntry(');
 env=await initializeTestEnvironment({projectId:project,firestore:{host:'127.0.0.1',port,rules}});
 const D=await import('../../test-app/tabel/domain.mjs'),config=D.defaults('obj','2026-10-11');config.acl.roles.editor={'table.view':true,'table.edit':true,'shift.view':true,'shift.edit':true,'equipment.edit':true,'people.edit':true,'materials.view':true,'materials.edit':true,'plans.view':true,'plans.edit':true,'request.view':true,'request.edit':true};config.acl.roles.viewer={'table.view':true};
 await env.withSecurityRulesDisabled(async ctx=>{const db=ctx.firestore();await db.doc('settings/permissions').set({editor:{tabs:['timesheet'],actions:['timesheet_edit']},viewer:{tabs:['timesheet'],actions:[]},outsider:{tabs:['line'],actions:['timesheet_edit']}});for(const [uid,role,status]of [['admin','admin','active'],['one','editor','active'],['two','editor','active'],['viewer','viewer','active'],['outsider','outsider','active'],['disabled','admin','disabled']])await db.doc('users/'+uid).set({role,status});});
 const admin=client('admin'),one=client('one'),two=client('two'),viewer=client('viewer'),outsider=client('outsider'),disabled=client('disabled');
 await send(admin,[change('timesheetObjects','obj',config)]);
 const sheet={objectId:'obj',schemaVersion:1,deleted:false,name:'Лист',type:'blank',rowCount:100,colCount:26,cells:{A1:{raw:'12'}},columnWidths:{},rowHeights:{}};
 const first=op(one,[change('timesheetSheets','s1',sheet)]);await send(one,first);await send(one,first);assert.equal((await one.ws.collection('timesheetChanges').get()).size,2);
 console.log('PASS sandbox rules compile, administrator config, delegated sheet creation, idempotent receipt');
 const race=await Promise.allSettled([send(one,[change('timesheetSheets','s1',{...sheet,cells:{A1:{raw:'13'}}},1)]),send(two,[change('timesheetSheets','s1',{...sheet,cells:{A1:{raw:'14'}}},1)])]);assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal(race.find(x=>x.status==='rejected').reason.code,'conflict');
 console.log('PASS two authenticated clients: exactly one accepted sheet revision, both values retained in conflict');
 await assertFails(send(viewer,[change('timesheetSheets','view-write',sheet)]));await assertFails(outsider.ws.collection('timesheetSheets').doc('s1').get());await assertFails(disabled.ws.collection('timesheetSheets').doc('s1').get());
 await assertFails(send(one,[change('timesheetSheets','objB',{...sheet,objectId:'objB'})]));
 console.log('PASS server denies viewer writes, no-tab/disabled reads and cross-object writes');
 const current=(await admin.ws.collection('timesheetObjects').doc('obj').get()).data(),clean={...current};for(const k of ['revision','lastOpId','updatedBy','updatedName','updatedAt'])delete clean[k];
 await assertFails(send(one,[change('timesheetObjects','obj',{...clean,acl:{roles:{editor:{'permissions.edit':true}},users:{}}},current.revision)]));
 await send(one,[change('timesheetObjects','obj',{...clean,request:{...clean.request,note:'Новый план'}},current.revision)]);
 console.log('PASS request edit is independent of settings; role cannot grant itself permissions');
 const value={objectId:'obj',schemaVersion:1,deleted:false,date:'2026-10-11',shift:'day',scope:'obj|2026-10',kind:'work',entityId:'work1',unit:'м²',quantity:120,direction:''};await send(one,[change('timesheetValues','work1',value)]);
 await assertFails(one.ws.collection('timesheetValues').doc('work1').update({quantity:800,revision:2}));await assertFails(admin.ws.collection('timesheetValues').doc('work1').delete());await assertFails(admin.ws.collection('timesheetChanges').doc(first.id).update({label:'Подмена'}));
 console.log('PASS actual work values, no direct write bypass, immutable audit, soft-delete boundary');
 // Match the actual plugin service queries: objectId plus monthly scope, not whole-workspace reads.
 for(const col of ['timesheetObjects','timesheetSheets']){
  assert((await one.ws.collection(col).where('objectId','==','obj').get()).size>0);
  assert((await admin.ws.collection(col).where('objectId','==','obj').get()).size>0);
 }
 assert.equal((await viewer.ws.collection('timesheetSheets').where('objectId','==','obj').get()).size,1);
 const day={objectId:'obj',schemaVersion:1,deleted:false,date:'2026-10-11',shift:'day',scope:'obj|2026-10',started:true};
 await send(one,[change('timesheetDays','day1',day)]);
 const ent=D.blankEntry('person',{id:'p1',name:'Рабочий',group:'worker'},{id:'obj',name:'Объект'},'2026-10-11','day','');
 ent.minutes=720;ent.status='work';await send(one,[change('timesheetEntries',D.entryId('person','obj','2026-10-11','day','p1'),ent)]);
 const mat={objectId:'obj',objectName:'Объект',date:'2026-10-11',shift:'day',scope:'obj|2026-10',material:'Гранулят',supplier:'Завод',quantity:12,unit:'м³',document:'',note:'',deleted:false};
 if(integrated)await send(one,[change('timesheetMaterials','mat1',mat)]);
 for(const col of ['timesheetDays','timesheetValues','timesheetEntries',...(integrated?['timesheetMaterials']:[])]){
  const query=one.ws.collection(col).where('objectId','==','obj').where('scope','==','obj|2026-10');
  assert.equal((await query.get()).size,1,col+' scoped query');
 }
 await assertFails(one.ws.collection('timesheetSheets').where('objectId','==','objB').get());
 await assertFails(viewer.ws.collection('timesheetDays').where('objectId','==','obj').where('scope','==','obj|2026-10').get());
 console.log('PASS actual plugin object/month queries for settings, sheets, days, values, entries and materials; viewer read-only sheet and cross-object denial');
 const crewRows=[['equipment',{id:'crew-machine',name:'Фреза',ownership:'own',contractor:''}],...['crew-a','crew-b','crew-c'].map(id=>['person',{id,name:id,group:'operator'}])].map(([kind,entity])=>{
  const data=D.blankEntry(kind,entity,{id:'obj',name:'Объект'},'2026-10-11','day',kind==='person'?'crew-machine':'');data.minutes=720;data.status='work';return change('timesheetEntries',D.entryId(kind,'obj','2026-10-11','day',entity.id),data);
 });
 await send(one,crewRows);
 assert.equal((await one.ws.collection('timesheetEntries').where('objectId','==','obj').where('scope','==','obj|2026-10').get()).size,5);
 console.log('PASS configured-object four-row equipment/crew transaction fits Firestore expression and access-call budgets');

 await env.withSecurityRulesDisabled(async ctx=>ctx.firestore().doc('users/one').update({status:'disabled'}));await assertFails(send(one,[change('timesheetSheets','queued-after-revoke',sheet)]));
 console.log('PASS revoked account blocks previously prepared queued operation on server');
}catch(e){console.error(e);console.error(log.slice(-3000));process.exitCode=1;}finally{for(const a of apps)await a.delete();await env?.cleanup();child.kill();}})();
