import assert from 'node:assert/strict';
import {readlinkSync,writeFileSync} from 'node:fs';
import pg from '../server/node_modules/pg/lib/index.js';
import {chromium,until,navigationProbe} from './phone-cdp.mjs';
import {installAuthFixtureTransport} from './phone-auth-fixture.mjs';

// Mobile acceptance of the parallel-shift flow (design §10.1, §10.2, §15).
//
// Independent Chromium profiles talk to the same isolated stand: admin, the day
// foreman and the night foreman, plus one control profile without the v2 flag.
// The flag is injected with Page.addScriptToEvaluateOnNewDocument BEFORE any
// module loads; the control profile proves that the same server data keeps the
// strip hidden and that the management sheet refuses to fake v1 commands.
//
// Where the product has a screen, the screen is the path (shift creation,
// membership, shift switch, closing, archive, restored archive). The force
// transfer confirmation and the detached-trip block are screens too: the
// scenario checks them in the real DOM (47-shift-transfer-ui.js). Only truck
// assignment and line operations themselves are still driven through the
// shipped client transport with the real token.
const base=process.env.PHONE_QA_BASE,origin='https://samosval-test.iluxa.pro:18499';
const API='http://127.0.0.1:18099';
assert.ok(base?.includes('/browser-fix.')&&process.env.PGHOST===base+'/socket');
assert.match(process.env.PHONE_HOST_NS||'',/^net:\[[0-9]+\]$/);
assert.notEqual(readlinkSync('/proc/self/ns/net'),process.env.PHONE_HOST_NS);
const pool=new pg.Pool({host:process.env.PGHOST,database:'samosval_test',user:process.env.POSTGRES_USER});

const WORK_DATE='2026-11-27';
const SITE='synthetic_site';
const SITE_NAME='Невский проспект';
const TRUCK_A='synthetic_truck_a';
const TRUCK_B='synthetic_truck_b';
const PASSWORD='Synthetic-only-889!';

const facts={};
const results=[];
const sessions=[];
const save=()=>writeFileSync(base+'/parallel-shifts.json',JSON.stringify(facts,null,2));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const J=value=>JSON.stringify(value);

async function scenario(name,fn){
 try{await fn();results.push({name,status:'PASS'});console.log('PASS',name);}
 catch(error){results.push({name,status:'FAIL',error:error.message});throw error;}
 finally{writeFileSync(base+'/results.json',JSON.stringify(results,null,2));}
}

// Independent server read: real HTTP, real token, no client cache in between.
async function apiGet(path,token){
 const response=await fetch(API+path,{headers:{
  Origin:origin,Authorization:'Bearer '+token,
  'X-Samosval-Epoch':'7','X-Samosval-Generation':'3'}});
 return {status:response.status,data:await response.json()};
}

async function openProfile(name,port,flag){
 const browser=await chromium(base,process.env.PHONE_CHROMIUM,port,name);
 const session={name,port,flag,browser,ev:browser.evaluate,read:expression=>navigationProbe(browser.evaluate,expression),closed:false};
 sessions.push(session);
 await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:`(${installAuthFixtureTransport.toString()})()`});
 // The isolated stand has no route, so Chromium reports `navigator.onLine` as
 // false even though every request reaches loopback. That hint gates real UI
 // actions ("Нет сети"), so the acceptance pins it to the online phone case and
 // flips it deliberately below to prove the offline marker still works. It is a
 // browser hint override, not a product-logic stub.
 if(flag)await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(Navigator.prototype,'onLine',{configurable:true,get(){return window.__qaOnline!==false;}});"});
 if(flag)await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:'window.WORKING_TEST_V2_SHIFTS=true;'});
 await browser.send('Page.navigate',{url:origin+'/index-working-test.html'});
 await until(()=>session.read("typeof handleLogin==='function' && !!document.getElementById('authEmail')"),'built application');
 return session;
}

async function login(session,account,role){
 const start=session.browser.collector.authMark();
 // A fresh profile starts at epoch 0; the real session answers epoch 7 and the
 // client reloads once. Do not hold the login Promise across that transition.
 await session.ev(`document.getElementById('authEmail').value=${J(account)};document.getElementById('authPassword').value=${J(PASSWORD)};void handleLogin()`);
 await until(async()=>{
  session.browser.collector.assertAuthSince(start);
  const active=await session.read(`typeof nasRuntimeClient!=='undefined' && !!nasRuntimeClient && currentUserRole===${J(role)} && currentUserStatus==='active'`);
  session.browser.collector.assertAuthSince(start);
  return active;
 },'real auth '+account,45000);
 await until(()=>session.read(`typeof state!=='undefined' && Array.isArray(state.trucks) && state.trucks.some(t=>t.id===${J(TRUCK_A)})`),'catalog trucks',45000);
 await until(()=>session.read(`typeof state!=='undefined' && Array.isArray(state.objects) && state.objects.some(o=>o.id===${J(SITE)})`),'catalog objects',45000);
 if(role==='admin')await until(()=>session.read("typeof state!=='undefined' && Array.isArray(state.users) && state.users.some(u=>u.id==='synthetic_foreman_a') && state.users.some(u=>u.id==='synthetic_foreman_b')"),'admin user directory',45000);
 await session.browser.collector.waitAuthSince(start);
 await session.ev(`window.qaOp=p=>String(p)+'_'+Math.random().toString(36).slice(2,10)+'_'+Date.now().toString(36);`);
}

async function closeSession(session){
 if(!session||session.closed)return;
 session.closed=true;
 try{session.browser.collector.assertNoExceptions();}finally{await session.browser.close();}
}

let token=null;
let shiftA=null,shiftB=null;

try{
 await until(async()=>{try{return (await fetch(API+'/health/live')).ok;}catch{return false;}},'API readiness');
 const admin=await openProfile('admin',19222,true);
 await login(admin,'admin@example.test','admin');
 token=await admin.ev('wtAccessToken()');
 assert.ok(token);
 facts.migrations=(await pool.query("SELECT to_regclass('public.detached_open_trips') AS detached,to_regclass('public.shift_archive_series') AS series")).rows[0];

 const snapshot=async shiftId=>apiGet('/api/v2/shifts/'+shiftId+'/snapshot',token);
 const listShifts=async()=>apiGet('/api/v2/shifts?state=active,closing&limit=50',token);
 // A distinct requestKind keeps these reads from racing the 4s poll's own
 // generation for the same (shift, kind) key.
 const refreshStore=async shiftId=>{
  const result=await admin.ev(`nasV2Shifts().transport.readShiftSnapshot({shiftId:${J(shiftId)},requestKind:'qa'})`);
  return result;
 };
 const projectShift=async shiftId=>{
  assert.equal(await admin.ev(`shiftStripSelect(${J(shiftId)})`),true,'select '+shiftId);
  await until(()=>admin.ev(`typeof state!=='undefined' && !!state.shift && (state.shift.shiftId||state.shift.id)===${J(shiftId)}`),'projection of '+shiftId,20000);
 };
 // Карточки линии рисуются по расписанию (50 мс + rAF, core/04), поэтому
 // сразу после переключения в DOM ещё живёт прежний набор. Ждём, пока список
 // машин совпадёт с проекцией выбранной смены.
 const lineTruckIds=()=>admin.ev("[...document.querySelectorAll('.truck-card[data-truck-id]')].map(card=>card.dataset.truckId).sort()");
 const waitLineTrucks=async ids=>{
  const expected=ids.slice().sort();
  await until(async()=>JSON.stringify(await lineTruckIds())===JSON.stringify(expected),'line trucks '+expected.join(','),20000);
  return lineTruckIds();
 };
 // Header and tab state are read in the same evaluation as the switch, so a
 // background v1 refresh cannot land between the projection and the read.
 const projectAndRead=shiftId=>admin.ev(`(()=>{
  if(!shiftStripSelect(${J(shiftId)}))throw Error('shift not selectable: ${shiftId}');
  return {shift:(state.shift&&(state.shift.shiftId||state.shift.id))||null,
   date:document.getElementById('shiftDate').textContent,
   object:document.getElementById('headerObject').textContent,
   selected:[...document.querySelectorAll('#shiftStrip .shift-tab')].filter(t=>t.getAttribute('aria-selected')==='true').map(t=>t.dataset.shiftId),
   labels:[...document.querySelectorAll('#shiftStrip .shift-tab')].map(t=>({shiftId:t.dataset.shiftId,text:(t.querySelector('.shift-tab-label')?.textContent||'')}))};})()`);

 await scenario('v2 bridge is injected before modules, the strip stays hidden until two shifts exist',async()=>{
  assert.equal(await admin.ev('typeof WORKING_TEST_V2_SHIFTS'),'boolean');
  assert.equal(await admin.ev('WORKING_TEST_V2_SHIFTS'),true);
  assert.equal(await admin.ev("typeof nasV2Shifts==='function' && !!nasV2Shifts()"),true);
  assert.equal(await admin.ev("['WorkingTestShiftSelector','WorkingTestShiftManagement','WorkingTestShiftContexts','WorkingTestV2Transport','WorkingTestDetachedTrips','WorkingTestRestoredArchive'].every(name=>typeof globalThis[name]==='object')"),true);
  assert.equal(await admin.ev("document.getElementById('shiftStrip').hidden"),true);
  assert.equal((await listShifts()).data.items.length,0);
 });

 await scenario('admin creates the day and the night shift of one object and one date through the real sheet',async()=>{
  const create=async type=>{
   await admin.ev('openShiftManagement()');
   await until(()=>admin.ev("!!document.querySelector('#shiftManagementModal.open')"),'management open');
   await admin.ev(`(()=>{const body=document.getElementById('shiftManagementBody');
    const object=body.querySelector('select');if(!object)throw Error('object select missing');
    object.value=${J(SITE)};
    const date=body.querySelector('input[type=date]');if(!date)throw Error('date input missing');
    date.value=${J(WORK_DATE)};
    const typeSelect=[...body.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='night'));
    if(!typeSelect)throw Error('type select missing');
    typeSelect.value=${J(type)};
    const button=[...body.querySelectorAll('button')].find(b=>b.textContent==='Создать смену');
    if(!button||button.disabled)throw Error('create button unavailable');
    button.click();})()`);
   await until(()=>admin.ev("(()=>{const s=document.querySelector('#shiftManagementBody .shift-management-status');return !!s&&!s.hidden;})()"),'create status');
   const status=await admin.ev("(()=>{const s=document.querySelector('#shiftManagementBody .shift-management-status');return {text:s.textContent,ok:s.className.includes('is-ok')};})()");
   assert.equal(status.ok,true,status.text);
   assert.equal(status.text,'Смена создана');
   await admin.ev('closeShiftManagement()');
  };
  await create('day');
  await create('night');
  const listed=await admin.ev('nasV2Shifts().transport.listShifts({})');
  assert.equal(listed.ok,true,JSON.stringify(listed));
  await until(()=>admin.ev('nasV2Shifts().store.visibleShifts().length===2'),'two visible shifts',20000);
  const rows=(await listShifts()).data.items;
  assert.equal(rows.length,2);
  shiftA=rows.find(row=>row.shiftType==='day').shiftId;
  shiftB=rows.find(row=>row.shiftType==='night').shiftId;
  assert.ok(shiftA&&shiftB&&shiftA!==shiftB);
  facts.created=(await pool.query(
   "SELECT shift_id,object_id,object_name_snapshot,to_char(work_date,'YYYY-MM-DD') AS work_date,shift_type,state FROM shifts WHERE shift_id=ANY($1::text[]) ORDER BY shift_type",
   [[shiftA,shiftB]])).rows;
  assert.deepEqual(facts.created.map(row=>({object:row.object_id,date:row.work_date,type:row.shift_type,state:row.state})),
   [{object:SITE,date:WORK_DATE,type:'day',state:'active'},{object:SITE,date:WORK_DATE,type:'night',state:'active'}]);
 });

 await scenario('strip and header show object, calendar date, day/night and the selected state',async()=>{
  await until(()=>admin.ev("document.getElementById('shiftStrip').hidden===false"),'strip visible',20000);
  const strip=await admin.ev(`(()=>{const mount=document.getElementById('shiftStrip');
   return {hidden:mount.hidden,count:mount.querySelectorAll('.shift-tab').length,
    tabs:[...mount.querySelectorAll('.shift-tab')].map(tab=>({shiftId:tab.dataset.shiftId,
     label:tab.querySelector('.shift-tab-label')?.textContent||'',
     badges:[...tab.querySelectorAll('.shift-tab-badge')].map(node=>node.textContent),
     selected:tab.getAttribute('aria-selected'),active:tab.classList.contains('is-active')}))};})()`);
  assert.equal(strip.hidden,false);
  assert.equal(strip.count,2);
  const dayTab=strip.tabs.find(tab=>tab.shiftId===shiftA),nightTab=strip.tabs.find(tab=>tab.shiftId===shiftB);
  assert.ok(dayTab&&nightTab);
  assert.equal(dayTab.label.replace('✓ ',''),SITE_NAME+' · День');
  assert.equal(nightTab.label.replace('✓ ',''),SITE_NAME+' · Ночь');
  assert.deepEqual(dayTab.badges,[],'an online phone shows no offline badge');
  // The check mark is the selected-state marker: exactly one tab carries it and
  // it is the tab the store reports as active.
  const activeId=await admin.ev('nasV2Shifts().store.activeShiftId()');
  assert.equal([dayTab,nightTab].filter(tab=>tab.label.startsWith('✓ ')).length,1);
  assert.equal((dayTab.shiftId===activeId?dayTab:nightTab).label.startsWith('✓ '),true);
  assert.equal((dayTab.shiftId===activeId?dayTab:nightTab).selected,'true');
  const day=await projectAndRead(shiftA);
  assert.equal(day.shift,shiftA);
  assert.equal(day.date,'Смена от 27.11.2026 · День');
  assert.equal(day.object,'Объект: '+SITE_NAME);
  assert.deepEqual(day.selected,[shiftA]);
  assert.deepEqual(day.labels.map(row=>[row.shiftId,row.text]).sort(),[[shiftA,'✓ '+SITE_NAME+' · День'],[shiftB,SITE_NAME+' · Ночь']].sort());
  const night=await projectAndRead(shiftB);
  assert.equal(night.shift,shiftB);
  assert.equal(night.date,'Смена от 27.11.2026 · Ночь');
  assert.deepEqual(night.selected,[shiftB]);
  assert.deepEqual(night.labels.map(row=>[row.shiftId,row.text]).sort(),[[shiftA,SITE_NAME+' · День'],[shiftB,'✓ '+SITE_NAME+' · Ночь']].sort());
  // DOM order is the store order (newest first), not the test's assumption.
  const storeOrder=await admin.ev('nasV2Shifts().store.visibleShifts().map(row=>row.shiftId)');
  assert.deepEqual(night.labels.map(row=>row.shiftId),storeOrder);
  facts.strip=strip;
  facts.header={day:{date:day.date,object:day.object},night:{date:night.date,object:night.object}};
 });

 await scenario('the offline marker of the strip is real: the same tabs gain and lose the badge',async()=>{
  // `navigator.onLine` is pinned to the online case above; flipping it back and
  // re-rendering shows the marker the product draws for a phone without network.
  const offline=await admin.ev(`(()=>{window.__qaOnline=false;
   document.dispatchEvent(new Event('offline'));window.dispatchEvent(new Event('offline'));
   window.__wtRenderShiftStrip();
   return {online:navigator.onLine,
    badges:[...document.querySelectorAll('#shiftStrip .shift-tab')].map(tab=>({shiftId:tab.dataset.shiftId,
     label:tab.querySelector('.shift-tab-label')?.textContent||'',
     badges:[...tab.querySelectorAll('.shift-tab-badge')].map(node=>node.textContent)}))};})()`);
  assert.equal(offline.online,false);
  assert.deepEqual(offline.badges.map(row=>row.badges),[[ 'офлайн' ],['офлайн']]);
  assert.deepEqual(offline.badges.map(row=>[row.shiftId,row.label.replace('✓ ','')]).sort(),
   [[shiftA,SITE_NAME+' · День'],[shiftB,SITE_NAME+' · Ночь']].sort(),'the label itself stays clean');
  const online=await admin.ev(`(()=>{window.__qaOnline=true;
   window.dispatchEvent(new Event('online'));window.__wtRenderShiftStrip();
   return {online:navigator.onLine,
    badges:[...document.querySelectorAll('#shiftStrip .shift-tab')].map(tab=>[...tab.querySelectorAll('.shift-tab-badge')].map(node=>node.textContent))};})()`);
  assert.equal(online.online,true);
  assert.deepEqual(online.badges,[[],[]]);
  facts.offlineBadge={offline:offline.badges,online:online.badges};
 });

 await scenario('admin adds the day foreman to A and the night foreman to B through the members sheet',async()=>{
  const addMember=async(shiftId,uid)=>{
   await projectShift(shiftId);
   assert.equal((await refreshStore(shiftId)).ok,true);
   await admin.ev('openShiftManagement()');
   await until(()=>admin.ev("!!document.querySelector('#shiftManagementModal.open')"),'management open');
   await admin.ev(`(()=>{const body=document.getElementById('shiftManagementBody');
    const select=[...body.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value===${J(uid)}));
    if(!select)throw Error('member candidate missing for ${uid}');
    select.value=${J(uid)};
    const button=[...body.querySelectorAll('button')].find(b=>b.textContent==='Добавить');
    if(!button||button.disabled)throw Error('add member button unavailable');
    button.click();})()`);
   await until(async()=>{
    const snap=(await snapshot(shiftId)).data;
    return snap.members.some(member=>member.uid===uid&&!member.removedAt);
   },'server membership '+uid,20000);
   await admin.ev('closeShiftManagement()');
  };
  await addMember(shiftA,'synthetic_foreman_a');
  await addMember(shiftB,'synthetic_foreman_b');
  const membersA=(await snapshot(shiftA)).data.members.filter(m=>!m.removedAt).map(m=>m.uid);
  const membersB=(await snapshot(shiftB)).data.members.filter(m=>!m.removedAt).map(m=>m.uid);
  assert.deepEqual(membersA,['synthetic_foreman_a']);
  assert.deepEqual(membersB,['synthetic_foreman_b']);
  facts.members={a:membersA,b:membersB};
 });

 await scenario('admin assigns two trucks to A and records one unfinished arrival through the client transport',async()=>{
  const assign=async(shiftId,truckId)=>{
   const snap=(await snapshot(shiftId)).data;
   const result=await admin.ev(`nasV2Shifts().transport.addTruck({operationId:qaOp('truck'),shiftId:${J(shiftId)},truckId:${J(truckId)},expectedShiftRevision:${snap.revisions.shift}})`);
   assert.equal(result.ok,true,JSON.stringify(result));
   return (await snapshot(shiftId)).data;
  };
  const afterBoth=await assign(shiftA,TRUCK_A).then(()=>assign(shiftA,TRUCK_B));
  assert.deepEqual(afterBoth.statuses.map(row=>row.id).sort(),[TRUCK_A,TRUCK_B]);
  const lineOp=async(shiftId,type,truckId)=>{
   const snap=(await snapshot(shiftId)).data;
   const status=snap.statuses.find(row=>row.id===truckId);
   assert.ok(status,'status row for '+truckId);
   const result=await admin.ev(`nasV2Shifts().transport.submitLineV2({operationId:qaOp(${J(type)}),shiftId:${J(shiftId)},type:${J(type)},truckId:${J(truckId)},expectedShiftRevision:${snap.revisions.shift},expectedStatusRevision:${status.statusRevision},expectedCycleRevision:${status.cycleRevision},expectedTtnRevision:${status.ttnRevision},fields:{createdAt:Date.now(),cycleMinutes:15,wantArrived:true,collect:false}})`);
   assert.equal(result.ok,true,JSON.stringify(result));
   return (await snapshot(shiftId)).data;
  };
  const arrived=await lineOp(shiftA,'arrive',TRUCK_A);
  const statusA=arrived.statuses.find(row=>row.id===TRUCK_A);
  // `arriveStatus` — это штамп времени ЧЧ:ММ (так его пишет линия), а не слово
  // «arrived»; факт прибытия доказывают штамп и arriveTimestamp.
  assert.match(String(statusA.arriveStatus||''),/^\d{1,2}:\d{2}$/,'arrival time is stamped');
  assert.ok(Number(statusA.arriveTimestamp)>0,'arrival timestamp is set');
  assert.equal(statusA.ttnStatus,null);
  assert.equal(arrived.logs.length,0,'arrival alone writes no trip');
  await refreshStore(shiftA);
  await projectShift(shiftA);
  // renderLine идёт через расписание (50 мс + rAF, core/04), поэтому карточки
  // появляются не в том же кадре, что и проекция смены.
  await waitLineTrucks([TRUCK_A,TRUCK_B]);
  assert.equal(await admin.ev(`!!document.querySelector('.truck-card[data-truck-id=${TRUCK_A}]')`),true);
  assert.equal(await admin.ev(`!!document.querySelector('.truck-card[data-truck-id=${TRUCK_B}]')`),true);
  facts.beforeTransfer={shiftRevision:arrived.revisions.shift,status:{statusRevision:statusA.statusRevision,cycleRevision:statusA.cycleRevision,ttnRevision:statusA.ttnRevision},logs:arrived.logs.length};
 });

 await scenario('force transfer: cancellation sends nothing, a stale CAS is refused, the committed move leaves an open detached trip in A',async()=>{
  const before=(await snapshot(shiftA)).data,beforeB=(await snapshot(shiftB)).data;
  const statusBefore=before.statuses.find(row=>row.id===TRUCK_A);
  const posts=()=>admin.browser.network.filter(row=>row.url.endsWith('/force-transfer')).length;
  const baseArgs=`sourceShiftId:${J(shiftA)},destinationShiftId:${J(shiftB)},truckId:${J(TRUCK_A)},expectedSourceShiftRevision:${before.revisions.shift},expectedDestinationShiftRevision:${beforeB.revisions.shift},expectedStatusRevision:${statusBefore.statusRevision},expectedCycleRevision:${statusBefore.cycleRevision},expectedTtnRevision:${statusBefore.ttnRevision}`;
  const postsBefore=posts();
  const cancelled=await admin.ev(`nasV2Shifts().transport.forceTransferTruck({operationId:qaOp('cancel'),${baseArgs}})`);
  assert.equal(cancelled.ok,false);
  assert.equal(cancelled.error.code,'transfer-confirmation-required');
  assert.equal(posts(),postsBefore,'a cancelled transfer must not reach the server');
  // The UI gate is a right, not a screen: the same transport refuses a caller
  // without `force_transfer_truck`.
  assert.equal(await admin.ev("WorkingTestShiftManagement.createShiftManagement({transport:nasV2Shifts().transport,store:nasV2Shifts().store,rights:{force_transfer_truck:false}}).canForceTransfer()"),false);
  assert.equal(await admin.ev("WorkingTestShiftManagement.createShiftManagement({transport:nasV2Shifts().transport,store:nasV2Shifts().store,rights:{force_transfer_truck:true}}).canForceTransfer()"),true);

  // Make the captured revisions stale for real: collecting the ТТН on the same
  // truck bumps its status and ttn revisions (and writes no trip), so the body
  // captured above must be refused instead of transferring on a guess.
  const bumped=await (async()=>{
   const snap=(await snapshot(shiftA)).data,status=snap.statuses.find(row=>row.id===TRUCK_A);
   return admin.ev(`nasV2Shifts().transport.submitLineV2({operationId:qaOp('ttn'),shiftId:${J(shiftA)},type:'ttn',truckId:${J(TRUCK_A)},expectedShiftRevision:${snap.revisions.shift},expectedStatusRevision:${status.statusRevision},expectedCycleRevision:${status.cycleRevision},expectedTtnRevision:${status.ttnRevision},fields:{createdAt:Date.now(),cycleMinutes:15,wantArrived:true,collect:true}})`);
  })();
  assert.equal(bumped.ok,true,JSON.stringify(bumped));
  const stale=await admin.ev(`nasV2Shifts().transport.forceTransferTruck({operationId:qaOp('stale'),confirmTransfer:true,${baseArgs}})`);
  facts.stale={stale,bumped,baseArgs};
  assert.equal(stale.ok,false);
  assert.equal(stale.error.code,'revision-conflict');
  assert.equal(stale.error.details.expectedStatusRevision,statusBefore.statusRevision);
  assert.equal(stale.error.details.actualStatusRevision,statusBefore.statusRevision+1);
  const unchanged=(await snapshot(shiftA)).data;
  assert.equal(unchanged.detachedOpenTrips.length,0,'a refused transfer leaves no detached trip');
  assert.equal(unchanged.statuses.find(row=>row.id===TRUCK_A).onLine,true);
  facts.stale={code:stale.error.code,details:stale.error.details};

  const freshA=(await snapshot(shiftA)).data,freshB=(await snapshot(shiftB)).data;
  const freshStatus=freshA.statuses.find(row=>row.id===TRUCK_A);
  const transferred=await admin.ev(`nasV2Shifts().transport.forceTransferTruck({operationId:qaOp('transfer'),confirmTransfer:true,sourceShiftId:${J(shiftA)},destinationShiftId:${J(shiftB)},truckId:${J(TRUCK_A)},expectedSourceShiftRevision:${freshA.revisions.shift},expectedDestinationShiftRevision:${freshB.revisions.shift},expectedStatusRevision:${freshStatus.statusRevision},expectedCycleRevision:${freshStatus.cycleRevision},expectedTtnRevision:${freshStatus.ttnRevision}})`);
  assert.equal(transferred.ok,true,JSON.stringify(transferred));
  const afterA=(await snapshot(shiftA)).data,afterB=(await snapshot(shiftB)).data;
  assert.equal(afterA.detachedOpenTrips.length,1);
  assert.equal(afterA.detachedOpenTrips[0].stage,'load');
  assert.equal(afterA.detachedOpenTrips[0].truckId,TRUCK_A);
  assert.equal(afterA.detachedOpenTrips[0].sourceShift.objectId,SITE);
  assert.equal(afterA.detachedOpenTrips[0].sourceShift.workDate,WORK_DATE);
  assert.equal(afterA.detachedOpenTrips[0].sourceShift.shiftType,'day');
  assert.equal(afterA.detachedOpenTrips[0].destinationShift.shiftType,'night');
  assert.equal(afterA.statuses.some(row=>row.id===TRUCK_A),false);
  assert.equal(afterB.statuses.some(row=>row.id===TRUCK_A),true);
  assert.equal(afterB.logs.length,0,'the unfinished trip is not a trip of B');
  facts.transfer={
   cancelled:cancelled.error.code,
   stale:stale.error.code,
   detachedCycleId:afterA.detachedOpenTrips[0].cycleId,
   detachedStage:afterA.detachedOpenTrips[0].stage,
   sourceShiftLabel:afterA.detachedOpenTrips[0].sourceShift,
   destinationShiftLabel:afterA.detachedOpenTrips[0].destinationShift
  };
 });

 await scenario('the force-transfer and detached-trip screens are wired into the real line UI',async()=>{
  // Экраны существуют не только как модуль: добавление самосвала уходит в
  // v2-функцию, а блок «Рейсы, оставшиеся в прежней смене» нарисован на линии.
  assert.equal(await admin.ev("typeof window.__wtAddTruckToShift"),'function');
  assert.equal(await admin.ev("!!document.getElementById('detachedTripsBlock')"),true);
  await refreshStore(shiftA);
  await refreshStore(shiftB);
  const readBlock=shiftId=>admin.ev(`(()=>{
   if(!shiftStripSelect(${J(shiftId)}))throw Error('shift not selectable: ${shiftId}');
   const block=document.getElementById('detachedTripsBlock');
   if(!block)throw Error('detached block missing');
   const card=block.querySelector('.detached-trip-card');
   return {hidden:block.hidden,count:block.querySelectorAll('.detached-trip-card').length,
    title:block.querySelector('.detached-trips-title')?.textContent||'',
    source:card?.querySelector('.detached-trip-source')?.textContent||'',
    warning:card?.querySelector('.detached-trip-warning')?.textContent||'',
    action:card?.querySelector('.detached-trip-action')?.textContent||'',
    disabled:card?.querySelector('.detached-trip-action')?.disabled};})()`);
  const waitBlock=shiftId=>until(async()=>{
   const block=await readBlock(shiftId);
   return block.hidden===false&&block.count===1;
  },'detached block on '+shiftId,20000);
  await waitBlock(shiftB);
  const onDestination=await readBlock(shiftB);
  assert.equal(onDestination.title,'Рейсы, оставшиеся в прежней смене');
  assert.ok(onDestination.source.includes(SITE_NAME),onDestination.source);
  assert.ok(onDestination.source.includes(WORK_DATE),onDestination.source);
  assert.ok(onDestination.source.includes('День'),onDestination.source);
  assert.match(onDestination.warning,/^Действие будет записано в исходную смену: /);
  assert.equal(onDestination.action,'Завершить в прежней смене');
  assert.equal(onDestination.disabled,false,'admin may complete the load stage');
  // В исходной смене тот же рейс виден так же крупно.
  await waitBlock(shiftA);
  const onSource=await readBlock(shiftA);
  assert.equal(onSource.count,1);
  assert.equal(onSource.source,onDestination.source);
  facts.detachedBlock={destination:onDestination,source:onSource};
  await projectShift(shiftB);
 });

 await scenario('the detached trip is offered to both shifts, is online-only, and completes into A only',async()=>{
  await refreshStore(shiftA);
  await refreshStore(shiftB);
  const described=await admin.ev(`(()=>{
   const store=nasV2Shifts().store;
   const online=WorkingTestDetachedTrips.createDetachedTrips({transport:nasV2Shifts().transport,online:()=>true});
   const offline=WorkingTestDetachedTrips.createDetachedTrips({transport:nasV2Shifts().transport,online:()=>false});
   const tripA=store.detachedTripsFor(${J(shiftA)}),tripB=store.detachedTripsFor(${J(shiftB)});
   return {countA:tripA.length,countB:tripB.length,
    rawDescribe:online.describe(tripA[0]),
    offline:offline.describe(tripA[0]),
    offlineQueue:typeof offlineIsOnlineOnlyCommand==='function'&&offlineIsOnlineOnlyCommand('force-transfer')&&offlineIsOnlineOnlyCommand('detached-complete'),
    rawKeys:Object.keys(tripA[0]).sort(),
    flatFields:['sourceObjectName','sourceWorkDate','sourceShiftType','expectedSourceShiftRevision','expectedDestinationShiftRevision'].filter(key=>key in tripA[0]),
    trip:{sourceShiftId:tripA[0].sourceShiftId,destinationShiftId:tripA[0].destinationShiftId,cycleId:tripA[0].cycleId,truckId:tripA[0].truckId,stage:tripA[0].stage,cycleRevision:tripA[0].cycleRevision}};})()`);
  assert.equal(described.countA,1,'the trip is visible to A');
  assert.equal(described.countB,1,'the trip is visible to B');
  // The server row nests both shifts; the shipped module reads the nested form,
  // so the label names the real source shift instead of "Объект не указан".
  assert.equal(described.rawDescribe.sourceLabel,SITE_NAME+' · '+WORK_DATE+' · День · Погрузка');
  assert.ok(described.rawDescribe.warning.includes('Действие будет записано в исходную смену'));
  assert.equal(described.rawDescribe.canComplete,false,'the row itself carries no shift revisions');
  assert.equal(described.offline.canComplete,false,'offline completion is refused');
  assert.equal(described.offline.onlineOnly,true);
  assert.equal(described.offlineQueue,true,'both commands are online-only');
  // The same refusal through the real browser hint, not an injected predicate.
  const requestsBefore=admin.browser.network.filter(row=>row.url.includes('/detached-trips/')).length;
  const realOffline=await admin.ev(`(()=>{window.__qaOnline=false;window.dispatchEvent(new Event('offline'));
   const store=nasV2Shifts().store;
   const live=WorkingTestDetachedTrips.createDetachedTrips({transport:nasV2Shifts().transport,
    online:()=>navigator.onLine===true});
   const trip=store.detachedTripsFor(${J(shiftA)})[0];
   return live.complete({trip,operationId:qaOp('offline'),type:trip.stage,truckId:trip.truckId})
    .then(result=>{const online=navigator.onLine;
     window.__qaOnline=true;window.dispatchEvent(new Event('online'));
     return {online,code:result.ok?'ok':result.code};});})()`);
  assert.equal(realOffline.online,false);
  assert.equal(realOffline.code,'online-required');
  assert.equal(admin.browser.network.filter(row=>row.url.includes('/detached-trips/')).length,requestsBefore,'an offline completion never reaches the server');
  facts.detached={
   countA:described.countA,countB:described.countB,
   rawDescribe:described.rawDescribe,
   offline:described.offline,
   realOffline,
   // The server row nests both shifts and carries no shift revisions; the
   // shipped module reads the nested labels but still needs the two revisions
   // from the screen context. Recorded here instead of being papered over.
   nestedRowKeys:described.rawKeys,
   nestedRowFlatFields:described.flatFields
  };

  const sourceRevision=(await snapshot(shiftA)).data.revisions.shift;
  const destinationRevision=(await snapshot(shiftB)).data.revisions.shift;
  const beforeA=(await snapshot(shiftA)).data,beforeB=(await snapshot(shiftB)).data;
  // A screen with both contexts (the admin case) supplies the two shift
  // revisions; the shipped module then sends the cross-shift CAS.
  const completed=await admin.ev(`(()=>{
   const store=nasV2Shifts().store;
   const detached=WorkingTestDetachedTrips.createDetachedTrips({transport:nasV2Shifts().transport,online:()=>true});
   const trip=Object.assign({},store.detachedTripsFor(${J(shiftB)})[0],{
    expectedSourceShiftRevision:${sourceRevision},expectedDestinationShiftRevision:${destinationRevision}});
   const view=detached.describe(trip);
   return detached.complete({trip,operationId:qaOp('detached'),type:trip.stage,truckId:trip.truckId,createdAt:Date.now()})
    .then(result=>({result,view}));})()`);
  facts.detached.augmentedDescribe=completed.view;
  assert.equal(completed.result.ok,true,JSON.stringify(completed.result));
  const afterA=(await snapshot(shiftA)).data,afterB=(await snapshot(shiftB)).data;
  assert.equal(afterA.detachedOpenTrips.length,0);
  assert.equal(afterB.detachedOpenTrips.length,0);
  assert.equal(afterA.logs.length,beforeA.logs.length+1,'the trip is written to A');
  assert.equal(afterB.logs.length,beforeB.logs.length,'B gets no trip');
  assert.equal(afterA.logs.filter(log=>log.truckId===TRUCK_A).length,1);
  assert.equal(afterB.statuses.find(row=>row.id===TRUCK_A).onLine,true,'the truck stays on B');
  facts.completed={sourceLogs:afterA.logs.length,destinationLogs:afterB.logs.length,sourceRevision:afterA.revisions.shift,destinationRevision:afterB.revisions.shift};
  await refreshStore(shiftA);
  await refreshStore(shiftB);
 });

 await scenario('switching is atomic: no A element under the B header and a late A response changes nothing',async()=>{
  // After the transfer A keeps only the second truck; A's own truck lives on B.
  assert.deepEqual(await (async()=>{await projectShift(shiftA);return waitLineTrucks([TRUCK_B]);})(),[TRUCK_B]);
  assert.equal(await admin.ev(`document.querySelectorAll('[data-truck-id=${TRUCK_A}]').length`),0,'no A truck under the A header');
  assert.deepEqual(await (async()=>{await projectShift(shiftB);return waitLineTrucks([TRUCK_A]);})(),[TRUCK_A]);
  assert.equal(await admin.ev(`document.querySelectorAll('[data-truck-id=${TRUCK_B}]').length`),0,'no B truck under the B header');

  // Hold the real A snapshot response, switch to B, release A afterwards.
  let held=null;
  const offPause=admin.browser.on('Fetch.requestPaused',params=>{
   if(params.request.url.includes('/api/v2/shifts/'+shiftA+'/snapshot')){held=params.requestId;return;}
   admin.browser.send('Fetch.continueRequest',{requestId:params.requestId}).catch(()=>{});
  });
  await admin.browser.send('Fetch.enable',{patterns:[{urlPattern:'*'+shiftA+'/snapshot*',requestStage:'Request'}]});
  try{
   await admin.ev(`shiftStripSelect(${J(shiftA)})`);
   await until(()=>held!==null,'A snapshot held',15000);
   const during=await projectAndRead(shiftB);
   assert.equal(during.shift,shiftB);
   assert.equal(during.date,'Смена от 27.11.2026 · Ночь');
   assert.deepEqual(during.selected,[shiftB]);
   // The line must show B's truck even though A's snapshot is still in flight.
   await waitLineTrucks([TRUCK_A]);
   assert.equal(await admin.ev(`document.querySelectorAll('[data-truck-id=${TRUCK_B}]').length`),0);
   await admin.browser.send('Fetch.continueRequest',{requestId:held});
   held=null;
   await wait(1500);
   const after=await admin.ev(`({shift:(state.shift&&(state.shift.shiftId||state.shift.id))||null,
    date:document.getElementById('shiftDate').textContent,
    selected:[...document.querySelectorAll('#shiftStrip .shift-tab')].filter(t=>t.getAttribute('aria-selected')==='true').map(t=>t.dataset.shiftId),
    trucks:[...document.querySelectorAll('.truck-card[data-truck-id]')].map(card=>card.dataset.truckId).sort()})`);
   assert.equal(after.shift,shiftB);
   assert.equal(after.date,'Смена от 27.11.2026 · Ночь');
   assert.deepEqual(after.selected,[shiftB]);
   assert.deepEqual(after.trucks,[TRUCK_A],'the late A response does not repaint the line');
   facts.lateResponse={during:{shift:during.shift,date:during.date,selected:during.selected},after};
  }finally{
   if(held)await admin.browser.send('Fetch.continueRequest',{requestId:held}).catch(()=>{});
   await admin.browser.send('Fetch.disable').catch(()=>{});
   offPause();
  }
 });

 await scenario('mobile geometry: the strip clears the last truck card and the bottom navigation',async()=>{
  assert.equal(await admin.ev('innerWidth'),393);
  assert.equal(await admin.ev('innerHeight'),852);
  await admin.ev('switchTab("line");window.scrollTo(0,document.body.scrollHeight)');
  await until(()=>admin.ev("document.querySelectorAll('.truck-card').length>0"),'line cards',20000);
  await wait(300);
  const geometry=await admin.ev(`(()=>{
   const strip=document.getElementById('shiftStrip'),nav=document.getElementById('bottomNav');
   const cards=[...document.querySelectorAll('.truck-card')],last=cards[cards.length-1];
   const s=strip.getBoundingClientRect(),n=nav.getBoundingClientRect(),l=last.getBoundingClientRect();
   return {strip:{top:s.top,bottom:s.bottom,left:s.left,right:s.right,height:s.height,clientWidth:strip.clientWidth,
     scrollWidth:strip.scrollWidth,clientHeight:strip.clientHeight,scrollHeight:strip.scrollHeight},
    nav:{top:n.top,bottom:n.bottom},lastCard:{top:l.top,bottom:l.bottom,truck:last.dataset.truckId},
    viewport:{width:innerWidth,height:innerHeight},scrollY:window.scrollY};})()`);
  assert.equal(geometry.strip.height>0,true);
  assert.equal(geometry.strip.bottom<=geometry.nav.top+0.5,true,JSON.stringify(geometry));
  assert.equal(geometry.strip.top>=geometry.lastCard.bottom-0.5,true,JSON.stringify(geometry));
  assert.equal(geometry.strip.left>=-0.5&&geometry.strip.right<=geometry.viewport.width+0.5,true,JSON.stringify(geometry));
  // Wide labels scroll inside the strip; they must never grow vertically.
  assert.equal(geometry.strip.scrollHeight<=geometry.strip.clientHeight+1,true,JSON.stringify(geometry));
  facts.geometry=geometry;
 });

 await scenario('switching keeps typed input and page scroll',async()=>{
  await admin.ev('switchTab("archive")');
  await admin.ev('document.getElementById("archiveSearchInput").value="Нев";window.scrollTo(0,180)');
  const before=await admin.ev('({value:document.getElementById("archiveSearchInput").value,scrollY:window.scrollY})');
  await projectShift(shiftA);
  await projectShift(shiftB);
  const after=await admin.ev('({value:document.getElementById("archiveSearchInput").value,scrollY:window.scrollY})');
  assert.equal(after.value,'Нев');
  assert.equal(Math.abs(after.scrollY-before.scrollY)<=2,true,JSON.stringify({before,after}));
  facts.inputAndScroll={before,after};
  await admin.ev('document.getElementById("archiveSearchInput").value="";switchTab("line")');
 });

 await scenario('without the flag the same server data keeps the strip hidden and the sheet does not fake v1 commands',async()=>{
  const control=await openProfile('control',19223,false);
  try{
   await login(control,'admin@example.test','admin');
   const controlToken=await control.ev('wtAccessToken()');
   assert.equal(await control.ev('typeof WORKING_TEST_V2_SHIFTS'),'undefined');
   assert.equal(await control.ev("typeof nasV2Shifts==='function' && nasV2Shifts()===null"),true);
   assert.equal((await apiGet('/api/v2/shifts?state=active,closing&limit=50',controlToken)).data.items.length,2);
   assert.equal(await control.ev("document.getElementById('shiftStrip').hidden"),true);
   assert.equal(await control.ev("document.querySelectorAll('#shiftStrip .shift-tab').length"),0);
   await control.ev('openShiftManagement()');
   const note=await control.ev("document.getElementById('shiftManagementBody').textContent");
   assert.ok(note.includes('Управление сменами доступно после включения канала v2.'),note);
   assert.equal(await control.ev("document.querySelectorAll('#shiftManagementBody button').length"),0);
   facts.control={note,shiftsOnServer:2,errors:control.browser.errors.length};
  }finally{
   await closeSession(control);
  }
 });

 await scenario('the day foreman sees only A, the night foreman only B, and a foreign snapshot is 404',async()=>{
  const day=await openProfile('day',19224,true);
  await login(day,'foreman-a@example.test','foreman');
  const dayToken=await day.ev('wtAccessToken()');
  await until(()=>day.ev('nasV2Shifts().store.visibleShifts().length===1'),'day visible list',20000);
  const dayVisible=await day.ev('nasV2Shifts().store.visibleShifts().map(row=>({shiftId:row.shiftId,type:row.shiftType,object:row.objectName}))');
  assert.deepEqual(dayVisible,[{shiftId:shiftA,type:'day',object:SITE_NAME}]);
  assert.equal(await day.ev("document.getElementById('shiftStrip').hidden"),true);
  assert.equal(await day.ev("document.querySelectorAll('#shiftStrip .shift-tab').length"),0);
  await until(()=>day.ev(`typeof state!=='undefined' && !!state.shift && (state.shift.shiftId||state.shift.id)===${J(shiftA)}`),'day projection',20000);
  assert.equal(await day.ev("document.getElementById('shiftDate').textContent"),'Смена от 27.11.2026 · День');
  assert.equal(await day.ev("document.getElementById('headerObject').textContent"),'Объект: '+SITE_NAME);
  // A's line is rendered from A's own snapshot, not from the shared v1 line.
  // The background poll repaints the line, so the check is taken after one
  // settle period and names the actual set in the failure message.
  await wait(2500);
  const dayLine=await day.ev("[...document.querySelectorAll('.truck-card[data-truck-id]')].map(card=>card.dataset.truckId).sort()");
  assert.deepEqual(dayLine,[TRUCK_B],'day line carries exactly the truck that stayed on A: '+JSON.stringify(dayLine));
  assert.deepEqual((await apiGet('/api/v2/shifts?state=active,closing&limit=50',dayToken)).data.items.map(row=>row.shiftId),[shiftA]);
  assert.equal((await apiGet('/api/v2/shifts/'+shiftB+'/snapshot',dayToken)).status,404);

  const night=await openProfile('night',19225,true);
  await login(night,'foreman-b@example.test','foreman');
  const nightToken=await night.ev('wtAccessToken()');
  await until(()=>night.ev('nasV2Shifts().store.visibleShifts().length===1'),'night visible list',20000);
  const nightVisible=await night.ev('nasV2Shifts().store.visibleShifts().map(row=>({shiftId:row.shiftId,type:row.shiftType,object:row.objectName}))');
  assert.deepEqual(nightVisible,[{shiftId:shiftB,type:'night',object:SITE_NAME}]);
  assert.equal(await night.ev("document.getElementById('shiftStrip').hidden"),true);
  await until(()=>night.ev(`typeof state!=='undefined' && !!state.shift && (state.shift.shiftId||state.shift.id)===${J(shiftB)}`),'night projection',20000);
  assert.equal(await night.ev("document.getElementById('shiftDate').textContent"),'Смена от 27.11.2026 · Ночь');
  await wait(2500);
  const nightLine=await night.ev("[...document.querySelectorAll('.truck-card[data-truck-id]')].map(card=>card.dataset.truckId).sort()");
  assert.deepEqual(nightLine,[TRUCK_A],'night line carries exactly the transferred truck: '+JSON.stringify(nightLine));
  assert.deepEqual((await apiGet('/api/v2/shifts?state=active,closing&limit=50',nightToken)).data.items.map(row=>row.shiftId),[shiftB]);
  assert.equal((await apiGet('/api/v2/shifts/'+shiftA+'/snapshot',nightToken)).status,404);
  facts.roles={day:dayVisible,night:nightVisible,dayLine,nightLine};
 });

 await scenario('closing A from the sheet leaves B untouched and publishes the archive of A',async()=>{
  await projectShift(shiftA);
  assert.equal((await refreshStore(shiftA)).ok,true);
  const beforeB=(await snapshot(shiftB)).data;
  const beforeA=(await snapshot(shiftA)).data;
  assert.equal(beforeA.logs.length,1);
  await admin.ev('openShiftManagement()');
  await until(()=>admin.ev("!!document.querySelector('#shiftManagementModal.open')"),'management open');
  await admin.ev(`(()=>{const body=document.getElementById('shiftManagementBody');
   const material=body.querySelector('input[placeholder^="Материал"]');if(!material)throw Error('material input missing');
   material.value='Песок';
   const volume=body.querySelector('input[type=number]');if(!volume)throw Error('volume input missing');
   volume.value='20';
   const button=[...body.querySelectorAll('button')].find(b=>b.textContent==='Закрыть смену');
   if(!button||button.disabled)throw Error('close button unavailable');
   button.click();})()`);
  await until(()=>admin.ev("!!document.querySelector('.pcm-overlay .pcm-btn-confirm')"),'close confirmation');
  await admin.ev("document.querySelector('.pcm-overlay .pcm-btn-confirm').click()");
  await until(async()=>{
   const list=await listShifts();
   return list.data.items.length===1&&list.data.items[0].shiftId===shiftB;
  },'A closed, B active',30000);
  await until(()=>admin.ev(`typeof state!=='undefined' && !!state.shift && (state.shift.shiftId||state.shift.id)===${J(shiftB)}`),'B projected after close',30000);
  await until(()=>admin.ev("document.getElementById('shiftStrip').hidden"),'strip hidden with one shift',20000);
  const afterB=(await snapshot(shiftB)).data;
  assert.equal(afterB.revisions.shift,beforeB.revisions.shift,'B is not touched by closing A');
  assert.equal(afterB.logs.length,beforeB.logs.length);
  assert.equal(afterB.statuses.find(row=>row.id===TRUCK_A).onLine,true);
  assert.equal(await admin.ev(`!!document.querySelector('.truck-card[data-truck-id=${TRUCK_A}]')`),true);
  const closedA=(await snapshot(shiftA)).data;
  assert.equal(closedA.shift.state,'closed');
  facts.closed={shiftAState:closedA.shift.state,destinationRevision:afterB.revisions.shift,destinationLogs:afterB.logs.length};
 });

 await scenario('archive of A: real latest finalized revision, badge and an explicit read-only revision view',async()=>{
  await admin.ev('await refreshNasArchive()');
  const entry=await admin.ev(`(()=>{const row=(state.archive||[]).find(item=>item.id===${J('closed_'+shiftA)});
   return row?{id:row.id,archiveId:row.archiveId,archiveSha256:row.archiveSha256,date:row.date,objectId:row.objectId,trips:row.logs.length,volume:row.totalVolume,revision:row.revision}:null;})()`);
  assert.ok(entry,'archive entry of A');
  assert.equal(entry.date,'27.11.2026');
  assert.equal(entry.objectId,SITE);
  assert.equal(entry.trips,1);
  assert.equal(entry.volume,20);
  const series=(await pool.query(
   `SELECT s.latest_finalized_revision,s.latest_finalized_sha256,r.archive_revision,r.payload_sha256,r.created_at,
           sh.opened_by_name_snapshot,sh.shift_type,sh.shift_type_resolution
      FROM shift_archive_series s
      JOIN shift_archive_revisions r ON r.workspace_id=s.workspace_id AND r.archive_id=s.archive_id
      JOIN shifts sh ON sh.workspace_id=s.workspace_id AND sh.shift_id=s.source_shift_id
     WHERE s.archive_id=$1 ORDER BY r.archive_revision`,[entry.archiveId])).rows;
  assert.ok(series.length>=1);
  const latest=series[series.length-1];
  assert.equal(Number(latest.latest_finalized_revision),Number(latest.archive_revision));
  assert.equal(latest.latest_finalized_sha256,latest.payload_sha256);
  assert.equal(entry.archiveSha256,latest.payload_sha256);

  await admin.ev('switchTab("archive");renderArchive()');
  await admin.ev(`openArchiveModal(${J(entry.id)})`);
  await until(()=>admin.ev("!!document.querySelector('#archiveModal.open')"),'archive modal',20000);
  // The frozen archive view (features/paper-viewer.js) replaces the modal
  // renderer, so the provenance badge and the revision history are filled by the
  // shared section renderer it now calls. Nothing is invoked by hand here: this
  // is the real user path, opened from the archive list.
  const withoutProvider=await admin.ev("document.getElementById('archiveRevisionHistory').textContent");
  // Канал без маршрута истории ревизий не должен показывать заголовок и
  // оговорку «недоступна»: пользователю нечего с этим делать, а выглядело бы
  // это как анонс неработающей функции. Секция остаётся пустой.
  assert.equal(withoutProvider,'',withoutProvider);
  assert.equal(await admin.ev("document.getElementById('archiveProvenanceSection').innerHTML"),'','no invented provenance');

  // This channel has no archive-revision route; the documented host hook is fed
  // with the actual rows read above, and only the UI contract is being checked.
  await admin.ev(`window.__wtArchiveRevisionProvider={archiveId:${J(entry.archiveId)},
   revisions:[{archiveRevision:${Number(latest.archive_revision)},finalized:true,archiveSha256:${J(latest.payload_sha256)},publishedAt:${J(new Date(latest.created_at).toISOString())}}],
   provenance:{opener:{name:${J(latest.opened_by_name_snapshot)}},shiftType:${J(latest.shift_type)},shiftTypeResolution:${J(latest.shift_type_resolution)},restoringActor:null,restoredByNameSnapshot:null}}`);
  await admin.ev(`openArchiveModal(${J(entry.id)})`);
  const revisionView=await admin.ev(`(()=>{const provenance=document.getElementById('archiveProvenanceSection');
   const history=document.getElementById('archiveRevisionHistory');
   return {badge:provenance.querySelector('.archive-archive-badge')?.textContent||'',
    lines:[...provenance.querySelectorAll('.archive-provenance-line')].map(node=>node.textContent),
    current:history.querySelector('.archive-revision-current')?.textContent||'',
    options:[...history.querySelectorAll('.archive-revision-select option')].map(option=>option.textContent)};})()`);
  assert.equal(revisionView.badge,'Архивная смена · только правки рейсов/ТТН');
  assert.deepEqual(revisionView.lines,['Автор: '+latest.opened_by_name_snapshot,'Тип смены: День','Восстановил: Автор не установлен']);
  assert.ok(revisionView.current.startsWith('По умолчанию: ревизия 1 · SHA-256 '+latest.payload_sha256),revisionView.current);
  assert.equal(revisionView.options.length,1);
  assert.ok(revisionView.options[0].includes(latest.payload_sha256.slice(0,12)),revisionView.options[0]);

  assert.equal(await admin.ev('openArchiveRevision("1")'),true);
  const explicit=await admin.ev(`(()=>{const history=document.getElementById('archiveRevisionHistory');
   return {current:history.querySelector('.archive-revision-current')?.textContent||'',
    readonly:history.querySelector('.archive-revision-readonly')?.textContent||''};})()`);
  assert.ok(explicit.current.startsWith('Выбрана ревизия 1'),explicit.current);
  assert.equal(explicit.readonly,'Просмотр ревизии только для чтения. Правки доступны в последней опубликованной ревизии.');
  assert.equal(await admin.ev('closeArchiveRevision()'),true);
  await admin.ev('closeArchiveModal()');
  facts.archive={entry,series:series.map(row=>({revision:Number(row.archive_revision),sha256:row.payload_sha256,latest:Number(row.latest_finalized_revision)})),revisionView,explicit};
 });

 await scenario('a restored archive is refused honestly on the canonical schema and leaves no rows behind',async()=>{
  const entryId='closed_'+shiftA;
  // На канонической схеме (миграция 025) старый путь восстановления запрещён
  // дизайном: restored archive не становится active shift (design §4.7, §3.4),
  // его место — restored_shift_contexts, у которого пока нет маршрута. Сервер
  // обязан отказать стабильным кодом до любой записи, а не упасть 500.
  const before=(await pool.query("SELECT (SELECT count(*) FROM shifts WHERE workspace_id=$1 AND payload->>'restored'='true') AS restored_shifts,(SELECT count(*) FROM line_logs WHERE workspace_id=$1) AS logs",[process.env.WORKSPACE_ID||'main_workspace'])).rows[0];
  const refused=await admin.ev(`nasArchiveAction('archive.restore',${J(entryId)}).then(()=>({ok:true}),error=>({ok:false,code:error.serverCode||error.code,status:error.status,message:String(error.message||error)}))`);
  assert.equal(refused.ok,false,'restore must be refused');
  assert.equal(refused.code,'archive-restore-requires-v2',JSON.stringify(refused));
  assert.equal(refused.status,409,JSON.stringify(refused));

  // Ничего не создано: ни строки restored в shifts, ни рейсов, ни контекста.
  const after=(await pool.query("SELECT (SELECT count(*) FROM shifts WHERE workspace_id=$1 AND payload->>'restored'='true') AS restored_shifts,(SELECT count(*) FROM line_logs WHERE workspace_id=$1) AS logs",[process.env.WORKSPACE_ID||'main_workspace'])).rows[0];
  assert.equal(Number(after.restored_shifts),Number(before.restored_shifts),'no restored shift row');
  assert.equal(Number(after.logs),Number(before.logs),'no restored trips');
  assert.equal(Number(after.restored_shifts),0,'the stand has no restored shift at all');
  const restoredState=await admin.ev(`({list:Array.isArray(state.restoredShifts)?state.restoredShifts.length:null,
   archive:(state.archive||[]).some(item=>item.id===${J(entryId)})})`);
  assert.equal(restoredState.list??0,0,'client restored list stays empty');
  assert.equal(restoredState.archive,true,'the archive entry was not moved away');
  const visible=await admin.ev('nasV2Shifts().store.visibleShifts().map(row=>row.shiftId)');
  assert.deepEqual(visible,[shiftB],'the strip still shows only B');
  assert.equal(await admin.ev("document.getElementById('shiftStrip').hidden"),true);

  // Пользователь видит причину, а не «api-http-409»: путь тот же, что у кнопки
  // «Восстановить» — модалка архива, подтверждение и панель ошибки.
  await admin.ev('switchTab("archive");renderArchive()');
  await admin.ev(`openArchiveModal(${J(entryId)})`);
  await until(()=>admin.ev("!!document.querySelector('#archiveModal.open')"),'archive modal',20000);
  assert.equal(await admin.ev("document.getElementById('archiveRestoreBtn').style.display"),'','restore button is available');
  await admin.ev("document.getElementById('archiveRestoreBtn').click()");
  await until(()=>admin.ev("!!document.querySelector('.pcm-overlay .pcm-btn-confirm')"),'restore confirmation',20000);
  await admin.ev("document.querySelector('.pcm-overlay .pcm-btn-confirm').click()");
  await until(()=>admin.ev("document.getElementById('errorPanel')?.classList.contains('open')===true"),'restore refusal panel',30000);
  const refusalText=await admin.ev("document.getElementById('errorPanel').querySelector('.error-panel-text').textContent");
  assert.ok(refusalText.includes('Восстановление архивной смены в этом режиме недоступно'),refusalText);
  assert.ok(refusalText.includes('смена не создана, данные архива не изменены'),refusalText);
  assert.equal(/api-http-\d+/.test(refusalText),false,'the user never sees a raw HTTP code');
  await admin.ev("document.querySelector('.error-panel-close').click()");
  await admin.ev('closeArchiveModal()');

  const afterUi=(await pool.query("SELECT (SELECT count(*) FROM shifts WHERE workspace_id=$1 AND payload->>'restored'='true') AS restored_shifts,(SELECT count(*) FROM line_logs WHERE workspace_id=$1) AS logs",[process.env.WORKSPACE_ID||'main_workspace'])).rows[0];
  assert.equal(Number(afterUi.restored_shifts),0,'the UI path created no restored shift');
  assert.equal(Number(afterUi.logs),Number(before.logs),'the UI path created no trips');
  facts.restored={entryId,refused,counts:{before:{restored_shifts:Number(before.restored_shifts),logs:Number(before.logs)},after:{restored_shifts:Number(afterUi.restored_shifts),logs:Number(afterUi.logs)}},visibleShifts:visible,userText:refusalText};
 });

 await scenario('no page exceptions, no module load failures, no foreign origin traffic',async()=>{
  for(const session of sessions){
   if(!session.closed)session.browser.collector.assertNoExceptions();
  }
  const modules=await admin.ev("({selector:typeof WorkingTestShiftSelector,management:typeof WorkingTestShiftManagement,contexts:typeof WorkingTestShiftContexts,transport:typeof WorkingTestV2Transport,detached:typeof WorkingTestDetachedTrips,restored:typeof WorkingTestRestoredArchive})");
  assert.deepEqual(modules,{selector:'object',management:'object',contexts:'object',transport:'object',detached:'object',restored:'object'});
  assert.ok(admin.browser.network.some(row=>row.url.startsWith(origin+'/api/v2/shifts?')),'the v2 list really left the browser');
  assert.equal(admin.browser.network.some(row=>row.url.includes(':18091')),false,'no legacy channel traffic');
  assert.ok(admin.browser.api.filter(row=>row.url.includes('/api/')).every(row=>row.url.startsWith(origin+'/api/')),'every API call uses the synthetic origin');
  // The legacy v1 line snapshot is still polled by the shipped shell and it
  // answers 409 multiple-active-shifts while two shifts are open — that refusal
  // is the documented single-shift contract, not a broken call. The v2 bridge
  // feeds the screen instead, so the only allowed failure is that exact 409 and
  // the v2 snapshot must never fail.
  const failedSnapshots=admin.browser.api.filter(row=>/\/snapshot$/.test(row.url)&&row.status>=400);
  const foreignSnapshots=failedSnapshots.filter(row=>!row.url.endsWith('/api/v1/line/snapshot')||row.status!==409);
  assert.deepEqual(foreignSnapshots,[],'only the legacy v1 snapshot may answer 409');
  const v2Snapshots=admin.browser.api.filter(row=>/\/api\/v2\/shifts\/[^/]+\/snapshot$/.test(row.url));
  assert.ok(v2Snapshots.length>0,'the v2 snapshot really left the browser');
  assert.equal(v2Snapshots.some(row=>row.status>=400),false,'no failed v2 snapshot');
  facts.apiStatuses=[...new Set(admin.browser.api.map(row=>row.method+' '+row.status))].sort();
  facts.snapshots={v2:v2Snapshots.length,legacy409:failedSnapshots.length};
  // The legacy refusal must not be dressed up as a sync failure while the v2
  // bridge owns the line: otherwise the badge says "Перечитываем: nas" forever.
  const legacyRefusalReported=await admin.ev("Object.prototype.hasOwnProperty.call(syncState.errors||{},'nas')");
  assert.equal(legacyRefusalReported,false,'the expected legacy refusal is not a sync failure');
  facts.sync={legacyRefusalReported};
  facts.errors={admin:admin.browser.errors.length};
  for(const session of sessions){
   if(!session.closed)facts.errors[session.name]=session.browser.errors.length;
  }
  assert.deepEqual(Object.values(facts.errors).filter(count=>count!==0),[],'no page exceptions in any profile');
  save();
 });
 console.log('Mobile parallel-shift scenarios complete; evidence in parallel-shifts.json. No publication.');
}catch(error){
 facts.error=error.message;
 save();
 throw error;
}finally{
 save();
 for(const session of sessions){
  try{await closeSession(session);}catch(error){if(!facts.closeError)facts.closeError=String(error.message||error);}
 }
 await pool.end();
}
