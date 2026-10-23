const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert'),{spawn}=require('child_process');
const firebase=require('firebase/compat/app');require('firebase/compat/firestore');
const {initializeTestEnvironment}=require('@firebase/rules-unit-testing');
const root=path.resolve(__dirname,'../..'),project='demo-samosval',port=8088;
const rules=fs.readFileSync(path.join(root,'firestore-multiplayer.rules'),'utf8');
const html=fs.readFileSync(path.join(root,'index-test.html'),'utf8');
const core=html.slice(html.indexOf('  // All line actions use the server state;'),html.indexOf('  // === УДЕРЖАНИЕ ===',html.indexOf('  // All line actions use the server state;')));
const server=spawn('java',['-jar',process.env.FIRESTORE_EMULATOR_JAR || path.join(__dirname,'.cache','firestore-emulator.jar'),'--host','127.0.0.1','--port',String(port),'--project_id',project],{stdio:['ignore','pipe','pipe']});
let emulatorLog='';server.stdout.on('data',d=>emulatorLog+=d);server.stderr.on('data',d=>emulatorLog+=d);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,timeout=15000){const until=Date.now()+timeout;while(!fn()){if(Date.now()>until)throw Error('Timed out waiting for synchronized clients');await delay(25);}}
const clients=[];let logicalNow=Date.now();
async function client(uid,role){
 const app=firebase.initializeApp({projectId:project,apiKey:'test'},'client-'+uid+'-'+clients.length);const db=app.firestore();db.useEmulator('127.0.0.1',port,{mockUserToken:{sub:uid,email:uid+'@example.com'}});
 const ws=db.collection('workspaces').doc('main_workspace'),refs={};for(const c of ['logs','truckStatus','audit','notifications','trucks','archive'])refs[c]=ws.collection(c);refs.shift=ws.collection('shift').doc('current');
 const appDb={runTransaction:fn=>db.runTransaction(tx=>fn({get:ref=>tx.get(ref),set:(ref,data)=>tx.set(ref,JSON.parse(JSON.stringify(data))),update:(ref,data)=>tx.update(ref,JSON.parse(JSON.stringify(data))),delete:ref=>tx.delete(ref)}))};
 const c={app,db,refs,uid,role,notifications:[],errors:[],messages:[],audit:[],txCount:0};
 const ctx={window:{},navigator:{onLine:true},Date:class extends Date{static now(){return logicalNow;}},state:{shift:{id:'s',isActive:true},truckStatus:{},logs:[],notifications:[]},loadInFlight:{},truckStatusWrites:{},confirmedLoadIds:new Set(),syncState:{errors:{}},currentEmail:uid+'@example.com',currentUid:uid,settings:{cycleMinutes:15},appConfig:{maxEnabled:false},getUserName:()=>uid,findTruck:()=>({id:'t',brand:'МАЗ',number:'А111АА178',defaultVol:20}),hasPermission:a=>role!=='viewer',requireEdit:a=>role!=='viewer',pendingStart:()=>{},pendingEnd:()=>{},saveCache:()=>{},renderLine:()=>{},renderHeaderStats:()=>{},renderStatusTicker:()=>{},scheduleRenderForTab:()=>{},updateSyncUI:()=>{},markSync:()=>{},escapeHtml:s=>String(s),truckName:()=> 'МАЗ А111АА178',truckLabelHtml:()=> 'МАЗ А111АА178',showError:s=>c.errors.push(s),showToastEl:s=>c.messages.push(s),enqueueMax:()=>{},confirm:()=>true,refs,db:appDb,getLogs:()=>ctx.state.logs.filter(l=>l.shiftId===ctx.state.shift?.id),reportSyncError:(source,e)=>ctx.syncState.errors[source]={code:e.code,message:e.message}};
 ctx.addAudit=async(text,details={})=>{c.audit.push({text,...details});await refs.audit.add({text,timeStr:'now',timestamp:logicalNow,userName:uid,userEmail:ctx.currentEmail,createdByEmail:ctx.currentEmail,objectName:'Тест',...details});};
 ctx.auditTruckAction=async(type,id,extra)=>ctx.addAudit(type,{eventType:type,truckId:id,...extra});
 ctx.showToast=(popup,bar,action)=>{c.notifications.push(action);const p=refs.notifications.add({...action,html:bar,timestamp:logicalNow,createdBy:uid,createdByEmail:ctx.currentEmail});c.pendingNotifications.push(p);};
 ctx.showToastEl=(message)=>c.messages.push(message);ctx.lastValidNotification=()=>ctx.state.notifications.find(n=>n.type!=='load'||ctx.state.logs.some(l=>l.id===n.logId))||null;
 c.pendingNotifications=[];vm.createContext(ctx);vm.runInContext(core,ctx);const start=html.indexOf('  let undoActionInFlight');vm.runInContext(html.slice(start,html.indexOf('  async function addAudit(',start)),ctx);c.ctx=ctx;
 const ready={status:false,logs:false};c.unsub=[refs.truckStatus.onSnapshot({includeMetadataChanges:true},s=>{ctx.receiveTruckStatuses(s);if(!s.metadata.fromCache&&!s.metadata.hasPendingWrites)ready.status=true;},e=>c.errors.push(e)),refs.logs.onSnapshot({includeMetadataChanges:true},s=>{ctx.receiveLoadLogs(s);if(!s.metadata.fromCache&&!s.metadata.hasPendingWrites)ready.logs=true;},e=>c.errors.push(e)),refs.notifications.orderBy('timestamp','desc').onSnapshot(s=>{ctx.state.notifications=s.docs.map(d=>({id:d.id,...d.data()}));})];clients.push(c);await waitFor(()=>ready.status&&ready.logs);return c;
}
(async()=>{let env;
 try{
  await waitFor(()=>emulatorLog.includes('Dev App Server is now running'),20000);
  env=await initializeTestEnvironment({projectId:project,firestore:{host:'127.0.0.1',port,rules}});
  console.log('PASS: Firebase compiled the full multiplayer rules');
  const owner=await client('8NMAKIjVmmaaj7A1zfqAv2bRUZN2','admin');
  const ownerDb=owner.db,profiles=ownerDb.collection('users');
  await Promise.all([profiles.doc('a').set({email:'a@example.com',role:'lopater',status:'active'}),profiles.doc('b').set({email:'b@example.com',role:'master',status:'active'}),profiles.doc('c').set({email:'c@example.com',role:'viewer',status:'active'}),ownerDb.doc('settings/permissions').set({lopater:{tabs:['line'],actions:['action_load','action_arrive','action_ttn','undo_action']},master:{tabs:['line'],actions:['action_load','action_arrive','action_ttn','undo_action']},viewer:{tabs:['line'],actions:[]}})]);
  await owner.refs.shift.set({id:'s',isActive:true,objectName:'Тест'});
  await owner.refs.truckStatus.doc('t').set({id:'t',shiftId:'s',onLine:true,cycleRevision:7,arriveStatus:'12:00',arriveTimestamp:logicalNow-600000,arriveBy:'a',loadedAfterArrive:false,lastLoadTimestamp:null,lastLoadBy:null,lastLoadLogId:null,ttnStatus:null,ttnBy:null,ttnLogId:null});
  const a=await client('a','lopater'),b=await client('b','master'),c=await client('c','viewer');
  const intentA=a.ctx.captureLineIntent('t'),intentB=b.ctx.captureLineIntent('t');
  const results=await Promise.all([a.ctx.performLoad('t',intentA),b.ctx.performLoad('t',intentB)]);
  console.log('Concurrent load results:',results.map(r=>r.outcome),a.errors,b.errors);
  assert.equal(results.filter(r=>r.outcome==='committed').length,1);assert.equal(results.filter(r=>r.outcome==='already-applied').length,1);
  await Promise.all([...a.pendingNotifications,...b.pendingNotifications]);
  await waitFor(()=>[a,b,c].every(x=>x.ctx.state.truckStatus.t?.cycleRevision===8&&!x.ctx.state.truckStatus.t.arriveStatus&&x.ctx.state.logs.length===1));
  let snap=await owner.refs.logs.get();assert.equal(snap.size,1);assert([a,b,c].every(x=>x.ctx.window.__cardJustLoaded?.id==='t'));assert.equal(a.notifications.length+b.notifications.length,1);assert(!a.errors.length&&!b.errors.length);
  console.log('PASS: two simultaneous loads create one trip; winner owns it; both clicking clients and passive viewer receive loaded status and animation');
  logicalNow+=16*60000;const ar=await Promise.all([a.ctx.toggleArrive('t',a.ctx.captureLineIntent('t')),b.ctx.toggleArrive('t',b.ctx.captureLineIntent('t'))]);assert.equal(ar.filter(r=>r.outcome==='committed').length,1);await waitFor(()=>[a,b,c].every(x=>x.ctx.state.truckStatus.t.cycleRevision===9&&x.ctx.state.truckStatus.t.arriveStatus));
  console.log('PASS: simultaneous arrivals do not toggle each other off');
  const stale=a.ctx.captureLineIntent('t');
  const pair=await Promise.all([a.ctx.performLoad('t',stale),b.ctx.toggleTtn('t',b.ctx.captureLineIntent('t'))]);assert.equal(pair[0].outcome,'committed');assert.equal(pair[1].outcome,'committed');await Promise.all([...a.pendingNotifications,...b.pendingNotifications]);
  await waitFor(()=>[a,b,c].every(x=>x.ctx.state.logs.length===2&&x.ctx.state.truckStatus.t.ttnStatus===true));
  const status=(await owner.refs.truckStatus.doc('t').get()).data();assert.equal(status.ttnLogId,status.lastLoadLogId);assert.equal((await owner.refs.logs.get()).size,2);
  console.log('PASS: concurrent TTN and loading keep the collected TTN linked to the actual winning trip');
  // Remove TTN through the same server action so the latest load can be undone in isolation.
  await b.ctx.toggleTtn('t',b.ctx.captureLineIntent('t'));await Promise.all(b.pendingNotifications);
  // Use the actual successful load notification to exercise atomic own-action undo.
  const own=(await a.refs.notifications.where('logId','==',status.lastLoadLogId).get()).docs[0];assert(own);
  a.ctx.lastValidNotification=()=>({id:own.id,...own.data()});
  await waitFor(()=>a.ctx.state.truckStatus.t.ttnStatus===null);
  await a.ctx.undoLastAction();
  await waitFor(()=>[a,b,c].every(x=>x.ctx.state.logs.length===1&&x.ctx.state.truckStatus.t.arriveStatus));
  assert.equal((await owner.refs.logs.get()).size,1);assert.equal((await owner.refs.truckStatus.doc('t').get()).data().cycleRevision,11);
  const delayed=await a.ctx.performLoad('t',stale);assert.equal(delayed.outcome,'changed');assert.equal((await owner.refs.logs.get()).size,1);
  console.log('PASS: own undo is atomic; version increases; a delayed pre-undo load cannot recreate the cancelled trip');
  // Offline and unavailable paths never use an unsafe batch fallback.
  a.ctx.navigator.onLine=false;const off=await a.ctx.performLoad('t',a.ctx.captureLineIntent('t'));assert.equal(off.outcome,'failed');a.ctx.navigator.onLine=true;assert.equal((await owner.refs.logs.get()).size,1);
  const originalDb=a.ctx.db;a.ctx.db={runTransaction:async()=>{throw {code:'unavailable',message:'test unavailable'};},batch:()=>{throw Error('UNSAFE BATCH FALLBACK');}};
  const unavailable=await a.ctx.performLoad('t',a.ctx.captureLineIntent('t'));assert.equal(unavailable.outcome,'failed');a.ctx.db=originalDb;assert.equal((await owner.refs.logs.get()).size,1);
  console.log('PASS: offline and unavailable failures never enqueue blind loading writes');
  // Denied load must not reset any client to stale status or create a success notification.
  await ownerDb.doc('settings/permissions').update({'lopater.actions':['action_arrive','action_ttn','undo_action']});const notices=a.notifications.length;
  const denied=await a.ctx.performLoad('t',a.ctx.captureLineIntent('t'));assert.equal(denied.outcome,'failed');assert.equal(a.notifications.length,notices);assert.equal((await owner.refs.logs.get()).size,1);
  assert(a.ctx.state.truckStatus.t.arriveStatus);console.log('PASS: server permission denial leaves authoritative state intact and emits no success notification');
  // A stale result received after a newer snapshot must not overwrite it.
  const before=a.ctx.state.truckStatus.t;const prior={...before,arriveStatus:null,cycleRevision:1};a.ctx.acceptLineResult('t',{type:'load',status:prior},{shiftId:'s',revision:0,logRevision:0});assert.equal(a.ctx.state.truckStatus.t.cycleRevision,before.cycleRevision);
  console.log('PASS: late operation responses do not overwrite newer snapshots');
  await ownerDb.doc('settings/permissions').update({'lopater.actions':['action_load','action_arrive','action_ttn','undo_action']});
  const more=[];for(const uid of ['d','e','f']){await profiles.doc(uid).set({email:uid+'@example.com',role:'master',status:'active'});more.push(await client(uid,'master'));}
  const operators=[a,b,...more];const watchers=[...operators,c];
  let total=(await owner.refs.logs.get()).size;
  for(let round=0;round<5;round++){
    logicalNow+=16*60000;
    if(!operators[0].ctx.state.truckStatus.t.arriveStatus){
      const arrivals=await Promise.all(operators.map(x=>x.ctx.toggleArrive('t',x.ctx.captureLineIntent('t'))));
      assert.equal(arrivals.filter(r=>r.outcome==='committed').length,1);
      assert(arrivals.every(r=>['committed','already-applied'].includes(r.outcome)));
      await waitFor(()=>watchers.every(x=>x.ctx.state.truckStatus.t.arriveStatus));
    }
    const notices=operators.reduce((n,x)=>n+x.notifications.length,0);
    const intents=operators.map(x=>x.ctx.captureLineIntent('t'));
    const outcomes=await Promise.all(operators.map((x,i)=>x.ctx.performLoad('t',intents[i])));
    assert.equal(outcomes.filter(r=>r.outcome==='committed').length,1);assert(outcomes.every(r=>['committed','already-applied'].includes(r.outcome)));
    await Promise.all(operators.flatMap(x=>x.pendingNotifications));total++;
    await waitFor(()=>watchers.every(x=>!x.ctx.state.truckStatus.t.arriveStatus&&x.ctx.state.logs.length===total));
    assert.equal((await owner.refs.logs.get()).size,total);
    assert.equal(operators.reduce((n,x)=>n+x.notifications.length,0),notices+1);
  }
  console.log('PASS: five operators over five contested cycles produce exactly five trips and identical states on six clients');
  const wantCollected=!operators[0].ctx.state.truckStatus.t.ttnStatus;
  const ttn=await Promise.all(operators.map(x=>x.ctx.toggleTtn('t',x.ctx.captureLineIntent('t'))));assert.equal(ttn.filter(r=>r.outcome==='committed').length,1);assert(ttn.every(r=>['committed','already-applied'].includes(r.outcome)));
  await waitFor(()=>watchers.every(x=>!!x.ctx.state.truckStatus.t.ttnStatus===wantCollected));
  console.log('PASS: five simultaneous TTN presses apply one intended change instead of toggling back');
  const registrationApp=firebase.initializeApp({projectId:project,apiKey:'test'},'new-registration');const registrationDb=registrationApp.firestore();registrationDb.useEmulator('127.0.0.1',port,{mockUserToken:{sub:'new-user',email:'new@example.com'}});
  await registrationDb.runTransaction(async tx=>{const u=registrationDb.doc('users/new-user'),r=registrationDb.doc('registration_requests/new-user');await tx.get(u);await tx.get(r);tx.set(u,{email:'new@example.com',nickname:'Новый',role:'viewer',status:'pending',createdAt:Date.now()});tx.set(r,{uid:'new-user',email:'new@example.com',nickname:'Новый',status:'pending',createdAt:Date.now()});});
  await assert.rejects(registrationDb.doc('users/new-user').update({role:'admin',status:'active'}));await assert.rejects(registrationDb.collection('registration_requests').get());
  await ownerDb.runTransaction(async tx=>{const u=ownerDb.doc('users/new-user'),r=ownerDb.doc('registration_requests/new-user');await tx.get(u);await tx.get(r);tx.update(u,{role:'lopater',status:'active'});tx.delete(r);});assert.equal((await registrationDb.doc('users/new-user').get()).data().status,'active');await registrationApp.delete();
  console.log('PASS: registration and admin approval still work; self-approval and reading other requests are denied');
  const legacyId='restored_legacy_trip';logicalNow+=20*60000;
  await owner.refs.logs.doc(legacyId).set({truckId:'t',shiftId:'s',timestamp:logicalNow-16*60000,createdByEmail:'a@example.com',volume:20,isGAI:false});
  await owner.refs.truckStatus.doc('t').set({id:'t',shiftId:'s',onLine:true,cycleRevision:0,arriveStatus:null,arriveTimestamp:null,arriveBy:null,lastLoadTimestamp:logicalNow-16*60000,lastLoadBy:'a',loadedAfterArrive:true,ttnStatus:null,ttnBy:null,ttnLogId:null});
  await waitFor(()=>b.ctx.state.logs.some(l=>l.id===legacyId)&&b.ctx.state.truckStatus.t.cycleRevision===0);
  const legacyTtn=await b.ctx.toggleTtn('t',b.ctx.captureLineIntent('t'));assert.equal(legacyTtn.outcome,'committed');assert.equal((await owner.refs.truckStatus.doc('t').get()).data().ttnLogId,legacyId);
  console.log('PASS: restored legacy trips without a lastLoadLogId still support TTN collection');
  console.log('ALL REAL FIRESTORE MULTI-CLIENT TESTS PASSED');
 }catch(e){console.error('TEST FAILURE:',e);console.error(emulatorLog.slice(-7000));process.exitCode=1;}
 finally{for(const c of clients){c.unsub?.forEach(fn=>fn());await c.app.delete().catch(()=>{});}if(env)await env.cleanup().catch(()=>{});server.kill('SIGTERM');}
})();
