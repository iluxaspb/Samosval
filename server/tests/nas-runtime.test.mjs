import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const root=new URL('../../',import.meta.url);
const source=name=>readFileSync(new URL('test-app/source/core/'+name,root),'utf8');
function harness(){
  const nodes=new Map(),bodyAttrs=new Map(),errors=[],writes=[],calls=[],storage=new Map();let journal=[],onSession,onSnapshot;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{style:{},textContent:'',value:'',classList:{add(){},remove(){}}});return nodes.get(id);};
  const c={console,URL,Map,Date,Promise,setTimeout,clearTimeout,WORKSPACE_ID:'main_workspace',currentUid:'one',currentEmail:'one@example.test',currentUserNickname:'',currentUserRole:'admin',currentUserStatus:'active',permissionsLoaded:true,permissionsConfig:{},initialized:false,confirmedLoadIds:new Set(),
    state:{trucks:[],logs:[],truckStatus:{},shift:null,archive:[],trash:[],audit:[],users:[]},settings:{},appConfig:{},Event,renderAppSettingsIfActive(){},hasTabAccess:tab=>c.permissionsConfig[c.currentUserRole]?.tabs?.includes(tab)||c.currentUserRole==='admin',offlineRemoteStatuses:{},offlineRemoteLogs:[],offlineReplayRunning:false,offlineServerRetryAt:0,
    auth:{currentUser:{uid:'one'}},navigator:{onLine:true},document:{baseURI:'https://app.test/index-test.html',body:{setAttribute:(k,v)=>bodyAttrs.set(k,v),removeAttribute:k=>bodyAttrs.delete(k)},getElementById:node,querySelector:s=>s.startsWith('meta[')?{content:'synology-candidate'}:node(s),querySelectorAll:()=>[]},
    crypto:{randomUUID:()=>String(calls.length)+'-uuid'},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},canAdmin:()=>c.currentUserStatus==='active'&&c.currentUserRole==='admin',renderAdminPanel(){},requestSyncStatus:{},
    sanitizeName:x=>x,markSync:(...args)=>calls.push(['sync',...args]),cancelHold(){},updateUserBadge(){},updateNavUI(){},applyRoleUI(){},renderAll:()=>calls.push(['render']),saveCache(){},refreshLineViews(){},showToastEl(){},escapeHtml:x=>x,offlineReasonLabel:x=>x,
    offlineTransportRecovered(){},offlineTransportFailed:err=>errors.push(err),reportSyncError:(_source,error)=>errors.push(error),updateSyncUI(){},
    offlinePendingOps:()=>structuredClone(journal.filter(x=>x.status==='pending')),offlineJournalRead:()=>structuredClone(journal),offlineJournalWrite:items=>{writes.push(structuredClone(items));journal=structuredClone(items);},
    offlineResolve:(id,status,reason)=>{const row=journal.find(x=>x.id===id);row.status=status;row.result=reason;},
    offlineProjectState:()=>{c.state.truckStatus=c.offlineRemoteStatuses;c.state.logs=c.offlineRemoteLogs;},
    offlineAdoptResult:(_op,result)=>{c.state.truckStatus.truck=result.status;},refs:{},window:{dispatchEvent(){},addEventListener(){}},
  };
  vm.createContext(c);vm.runInContext(source('21-nas-runtime.js'),c);
  const client={uid:'one',scope:JSON.stringify(['synology','https://iluxa.synology.me:18443','main_workspace','one']),readAdministration:async()=>({users:[{uid:'one',revision:1,role:'admin',status:'active'},{uid:'target',revision:1,role:'viewer',status:'pending'}],deletedUsers:[],requests:[{uid:'target',revision:1}],permissions:{viewer:{tabs:[],actions:[],revision:1}}}),subscribeLine:handlers=>{onSession=handlers.onSession;onSnapshot=handlers.onSnapshot;return ()=>calls.push(['unsubscribe']);},stop:()=>calls.push(['stop']),submitLine:async(op,options)=>{calls.push(['submit',op,options]);return {outcome:'confirmed',status:{shiftId:'shift',cycleRevision:2,ttnRevision:0}};}};
  c.testModule={createNasClient:()=>client};vm.runInContext('loadNasSessionClient=async()=>testModule',c);
  return {c,client,nodes,errors,writes,calls,storage,readJournal:()=>journal,setJournal:value=>{journal=structuredClone(value);},session:value=>onSession(value),snapshot:value=>onSnapshot(value)};
}
const session=()=>({identityReady:true,profile:{uid:'one',role:'admin',status:'active',nickname:'Owner',deleted:false},permissions:{tabs:['line'],actions:['action_load']}});
const snapshot=(revision=2)=>({shift:{id:'shift'},trucks:[{id:'truck'}],statuses:[{id:'truck',shiftId:'shift',cycleRevision:revision,ttnRevision:0}],logs:[],cycleMinutes:15});
const operation=()=>({id:'stable',type:'load',truckId:'truck',shiftId:'shift',status:'pending',operationScope:JSON.stringify(['synology','https://iluxa.synology.me:18443','main_workspace','one'])});

test('NAS core authentication uses NAS profile instead of forced email or Firestore profile',async()=>{
  const h=harness(),{c}=h;let callback;
  Object.assign(c,{DEFAULT_PERMISSIONS:{},syncState:{},confirmedLoadIds:new Set(),activeProfileKey:'',userDocUnsubscriber:null,loadCache(){},stopSync(){c.stopNasRuntime();},updateSyncUI(){},getSyncStatus:()=>({}),
    auth:{currentUser:{uid:'one',email:'one@example.test'},onAuthStateChanged:fn=>{callback=fn;}},
    usersRef:{doc:()=>{throw Error('Firestore profile must not be read');}},isForcedAdminEmail:()=>{throw Error('email must not grant NAS access');},
  });
  vm.runInContext(source('04-subscriptions.js'),c);
  await callback(c.auth.currentUser);
  assert.equal(c.currentUid,'one');assert.equal(h.errors.length,0);
  assert.equal(vm.runInContext('nasRuntimeClient!==null',c),true);
});
test('NAS session applies server permissions and clears revoked data without stopping profile observation',async()=>{
  const h=harness();await h.c.startNasRuntime(h.c.auth.currentUser);h.session(session());
  assert.equal(h.c.permissionsLoaded,true);assert.deepEqual(h.c.permissionsConfig.admin.actions,['action_load']);
  h.c.acceptNasLineSnapshot(snapshot());const revoked=session();revoked.profile.status='disabled';h.session(revoked);
  assert.equal(h.c.permissionsLoaded,false);assert.equal(h.c.state.shift,null);assert.equal(h.c.state.trucks.length,0);assert.equal(h.nodes.get('disabledScreen').style.display,'flex');assert.equal(h.calls.some(x=>x[0]==='stop'),false);
});
test('NAS queue replay commits receipt to current journal without delivering Firestore effects',async()=>{
  const h=harness();h.setJournal([operation()]);await h.c.startNasRuntime(h.c.auth.currentUser);await h.c.replayNasOfflineJournal();
  const saved=h.readJournal()[0];assert.equal(saved.status,'confirmed');assert.equal(saved.effectsDelivered,true);assert.equal(saved.id,'stable');
  const submit=h.calls.find(x=>x[0]==='submit');assert.equal(submit[2].operationScope,operation().operationScope);
});
test('NAS uncertain write or forbidden request remains pending for retry/review',async()=>{
  for(const error of [Object.assign(Error('timeout'),{retryable:true,uncertain:true}),Object.assign(Error('forbidden'),{status:403})]){
    const h=harness();h.setJournal([operation()]);h.client.submitLine=async()=>{throw error;};await h.c.startNasRuntime(h.c.auth.currentUser);await h.c.replayNasOfflineJournal();assert.equal(h.readJournal()[0].status,'pending');assert.equal(h.writes.length,0);
  }
});
test('NAS logout during write discards reply instead of resolving another account queue',async()=>{
  const h=harness();h.setJournal([operation()]);let release;h.client.submitLine=()=>new Promise(resolve=>{release=resolve;});await h.c.startNasRuntime(h.c.auth.currentUser);
  const pending=h.c.replayNasOfflineJournal();h.c.stopNasRuntime();h.c.currentUid='other';release({outcome:'confirmed',status:{cycleRevision:2}});await pending;
  assert.equal(h.readJournal()[0].status,'pending');assert.equal(h.writes.length,0);
});
test('NAS snapshots register server-confirmed load IDs for the ticker',async()=>{
  const h=harness();await h.c.startNasRuntime(h.c.auth.currentUser);
  h.c.acceptNasLineSnapshot({...snapshot(),logs:[{id:'load_123',shiftId:'shift',truckId:'truck'}]});
  assert.equal(h.c.confirmedLoadIds.has('load_123'),true);
  h.c.acceptNasLineSnapshot(snapshot());
  assert.equal(h.c.confirmedLoadIds.has('load_123'),false);
});
test('NAS late pre-commit snapshot cannot erase a receipt until the server snapshot catches up',async()=>{
  const h=harness();h.setJournal([operation()]);await h.c.startNasRuntime(h.c.auth.currentUser);await h.c.replayNasOfflineJournal();
  assert.equal(h.c.acceptNasLineSnapshot(snapshot(1)),false);assert.equal(h.c.state.truckStatus.truck.cycleRevision,2);
  assert.equal(h.c.acceptNasLineSnapshot(snapshot(2)),true);
});
test('NAS replay rejects dependent action locally when previous action was rejected',async()=>{
  const h=harness();h.setJournal([{...operation(),id:'old',status:'rejected'},{...operation(),dependencyId:'old'}]);await h.c.startNasRuntime(h.c.auth.currentUser);await h.c.replayNasOfflineJournal();
  assert.equal(h.readJournal()[1].result,'previous-action-rejected');assert.equal(h.calls.some(x=>x[0]==='submit'),false);
});
test('NAS journal and snapshot cache keys differ from Firebase and between users',()=>{
  const h=harness(),{c}=h;c.firebaseConfig={projectId:'samosval-offline'};c.location={pathname:'/index-test.html'};
  vm.runInContext(source('03-formatting.js'),c);vm.runInContext(source('15-shifts.js'),c);
  const nasCache=c.sessionCacheKey(),nasQueue=vm.runInContext('offlineJournalKey()',c);c.currentUid='two';assert.notEqual(c.sessionCacheKey(),nasCache);assert.notEqual(vm.runInContext('offlineJournalKey()',c),nasQueue);
  c.currentUid='one';vm.runInContext('isNasRuntime=()=>false',c);assert.notEqual(c.sessionCacheKey(),nasCache);assert.notEqual(vm.runInContext('offlineJournalKey()',c),nasQueue);
});
test('NAS admin forms use observed profile/request revisions and persist intent before sending',async()=>{
  const h=harness(),sent=[];await h.c.startNasRuntime(h.c.auth.currentUser);await h.c.refreshNasAdministration();
  h.client.submitAdministration=async(operation,options)=>{assert.equal(h.storage.size,1);sent.push({operation,options});return {outcome:'confirmed',operationId:operation.id,result:{uid:operation.uid}};};
  await h.c.nasAdminAction('registration.approve',{uid:'target',role:'viewer'});
  assert.equal(sent[0].operation.expectedRevision,1);assert.equal(sent[0].operation.expectedProfileRevision,1);assert.equal(sent[0].options.operationScope,h.client.scope);assert.equal(JSON.parse([...h.storage.values()][0]).length,0);
});
test('NAS lost admin reply preserves exact operation ID and revisions even after refreshing profile',async()=>{
  const h=harness(),sent=[];await h.c.startNasRuntime(h.c.auth.currentUser);await h.c.refreshNasAdministration();
  h.client.submitAdministration=async operation=>{sent.push(structuredClone(operation));if(sent.length===1)throw Object.assign(Error('lost reply'),{uncertain:true,retryable:true});return {outcome:'confirmed',operationId:operation.id,result:{uid:'target'}};};
  await assert.rejects(h.c.nasAdminAction('user.nickname',{uid:'target',nickname:'Name'}));
  h.client.readAdministration=async()=>({users:[{uid:'one',revision:1},{uid:'target',revision:2}],deletedUsers:[],requests:[],permissions:{}});await h.c.refreshNasAdministration();
  await h.c.nasAdminAction('user.nickname',{uid:'target',nickname:'Name'});assert.deepEqual(sent[0],sent[1]);assert.equal(sent[1].expectedRevision,1);
});
test('NAS refuses a new intent for a target with an unresolved previous change',async()=>{
  const h=harness();await h.c.startNasRuntime(h.c.auth.currentUser);await h.c.refreshNasAdministration();let calls=0;
  h.client.submitAdministration=async()=>{calls++;throw Object.assign(Error('network'),{uncertain:true});};
  await assert.rejects(h.c.nasAdminAction('user.role',{uid:'target',role:'viewer'}));
  await assert.rejects(h.c.nasAdminAction('user.role',{uid:'target',role:'master'}),/ожидает подтверждения/);assert.equal(calls,1);
});
test('NAS logout during administrative write leaves old-account intent unresolved',async()=>{
  const h=harness();await h.c.startNasRuntime(h.c.auth.currentUser);await h.c.refreshNasAdministration();let release;
  h.client.submitAdministration=()=>new Promise(resolve=>{release=resolve;});const pending=h.c.nasAdminAction('user.role',{uid:'target',role:'viewer'});
  h.c.stopNasRuntime();h.c.currentUid='two';release({outcome:'confirmed',result:{uid:'target'}});await assert.rejects(pending,/Сеанс/);
  assert.equal(JSON.parse([...h.storage.values()][0]).length,1);
});
test('NAS registration screen branches before any Firestore transaction',async()=>{
  const h=harness();h.c.db={runTransaction:()=>{throw Error('Firestore must not be called');}};h.c.usersRef={doc:()=>{throw Error('Firestore must not be called');}};
  let registered;h.client.registerPending=async data=>{registered=data;return {created:true};};
  vm.runInContext(source('05-authentication.js'),h.c);await h.c.ensurePendingAccount(h.c.auth.currentUser);assert.equal(registered.nickname,'');
});
test('NAS tabel host supplies only NAS transport and an independently scoped session',async()=>{
  const h=harness();Object.assign(h.c,{firebaseConfig:{projectId:'samosval-offline'},getUserName:()=> 'Operator',hasTabAccess:()=>true,hasPermission:()=>true});
  let options,checked=0;
  h.c.tableFactory={createTabelRemote:value=>{options=value;return {read:async()=>({revision:1,data:{equipment:[{id:'machine'}],people:[{id:'person'}]}})};}};
  vm.runInContext('loadNasTabelRemote=async()=>tableFactory',h.c);
  await h.c.startNasRuntime(h.c.auth.currentUser);const host=h.c.nasTabelHost();
  assert.equal(host.workspace,undefined);assert.equal(host.transaction,undefined);assert.equal(host.session().providerScope,h.client.scope);
  const remote=await host.remoteFactory(()=>checked++);options.guard({key:'site/day:date:day'});assert.equal(checked,1);
  assert.equal((await host.readCatalog()).equipment[0].id,'machine');assert.equal((await remote.read()).data.people[0].id,'person');
});
test('NAS tabel host invalidates reads and its active status immediately when the session stops',async()=>{
  const h=harness();Object.assign(h.c,{firebaseConfig:{projectId:'samosval-offline'},getUserName:()=> 'Operator',hasTabAccess:()=>true,hasPermission:()=>true});
  let options;h.c.tableFactory={createTabelRemote:value=>{options=value;return {};}};vm.runInContext('loadNasTabelRemote=async()=>tableFactory',h.c);
  await h.c.startNasRuntime(h.c.auth.currentUser);const host=h.c.nasTabelHost();await host.remoteFactory();h.c.stopNasRuntime();
  assert.equal(host.session().active,false);assert.throws(()=>options.guard(),/Доступ/);await assert.rejects(host.remoteFactory(),/Доступ/);
});


test('NAS catalog unwraps DTOs for existing screens and preserves observed revisions',async()=>{
  const h=harness();h.c.hasTabAccess=()=>true;h.c.objectTitle=(_id,name)=>name;h.c.window.dispatchEvent=()=>{};h.c.Event=class {};
  h.client.readCatalog=async()=>({trucks:[{id:'truck',data:{brand:'KAMAZ'},revision:7}],objects:[{id:'site',data:{name:'Site'},revision:3}]});
  await h.c.startNasRuntime(h.c.auth.currentUser);await h.c.refreshNasObjects();
  assert.equal(h.c.state.objects[0].name,'Site');assert.equal(h.c.state.trucks[0].brand,'KAMAZ');assert.equal(h.c.nasRecordRevision('object','site'),3);
});
test('NAS business retry retains complete original intent after lost reply and newer observed revision',async()=>{
  const h=harness(),sent=[];await h.c.startNasRuntime(h.c.auth.currentUser);
  h.client.submitControl=async op=>{sent.push(structuredClone(op));if(sent.length===1)throw Object.assign(Error('lost reply'),{uncertain:true});return {outcome:'confirmed',result:{id:op.recordId}};};
  const fields={type:'truck.update',recordId:'truck',expectedRevision:3,data:{brand:'New'}};
  await assert.rejects(h.c.nasBusinessCommand('control','truck',fields),/lost reply/);
  await h.c.nasBusinessCommand('control','truck',{...fields,expectedRevision:4});
  assert.deepEqual(sent[0],sent[1]);assert.equal(sent[1].expectedRevision,3);
  assert.equal([...h.storage.values()].some(x=>x.includes('expectedRevision')),false);
});
test('NAS create persists generated record ID and blocks different data until uncertain result is resolved',async()=>{
  const h=harness(),sent=[];await h.c.startNasRuntime(h.c.auth.currentUser);
  h.client.submitControl=async op=>{sent.push(structuredClone(op));throw Error('offline');};
  const fields={type:'object.create',expectedRevision:0,data:{name:'Site'}};
  await assert.rejects(h.c.nasBusinessCommand('control','object:new',fields),/offline/);
  await assert.rejects(h.c.nasBusinessCommand('control','object:new',{...fields,data:{name:'Other'}}),/повторите/);
  await assert.rejects(h.c.nasBusinessCommand('control','object:new',fields),/offline/);
  assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.ok(sent[0].recordId);
});
test('NAS double click shares the same command and a different intent cannot join its promise',async()=>{
  const h=harness();await h.c.startNasRuntime(h.c.auth.currentUser);let release,count=0;
  h.client.startShift=async()=>{count++;return new Promise(resolve=>release=resolve);};
  const first=h.c.nasBusinessCommand('start','current',{objectId:'site'});
  const second=h.c.nasBusinessCommand('start','current',{objectId:'site'});
  await assert.rejects(h.c.nasBusinessCommand('start','current',{objectId:'other'}),/отправляется/);
  release({shift:{id:'new'}});await Promise.all([first,second]);assert.equal(count,1);
});
test('NAS logout during control write keeps old-account intent and does not restart its poll',async()=>{
  const h=harness();await h.c.startNasRuntime(h.c.auth.currentUser);let release;
  h.client.submitControl=()=>new Promise(resolve=>release=resolve);
  const pending=h.c.nasBusinessCommand('control','truck',{type:'truck.delete',recordId:'truck',expectedRevision:1});
  await Promise.resolve();h.c.stopNasRuntime();h.c.currentUid='other';release({outcome:'confirmed'});
  await assert.rejects(pending,/изменилась/);assert.ok([...h.storage.values()].some(x=>x.includes('truck.delete')));
});
test('NAS closure retains prepared archive on failed material transfer and retries finish with the same ID after lost reply',async()=>{
  const h=harness(),steps=[],finish=[];await h.c.startNasRuntime(h.c.auth.currentUser);
  h.client.readLine=async()=>snapshot();let materialFails=true;
  h.c.testTransfer={transferClosedLine:async()=>{steps.push('material');if(materialFails)throw Error('material not confirmed');}};
  vm.runInContext('loadNasMaterialTransfer=async()=>testTransfer;nasTabelHost=()=>({})',h.c);
  h.client.closeShift=async op=>{steps.push(op.type);if(op.type==='prepare')return {shift:{id:'shift'},archive:{sourceShiftId:'shift',totalTrips:1}};finish.push(structuredClone(op));if(finish.length===1)throw Error('lost finish');return {shift:{id:'shift'}};};
  await assert.rejects(h.c.nasCloseCurrentShift('shift'),/material not confirmed/);assert.deepEqual(steps,['prepare','material']);
  materialFails=false;await assert.rejects(h.c.nasCloseCurrentShift('shift'),/lost finish/);
  await h.c.nasCloseCurrentShift('shift');assert.deepEqual(finish[0],finish[1]);assert.equal(steps.filter(x=>x==='prepare').length,1);
  assert.equal([...h.storage.keys()].some(x=>x.startsWith('samosval_nas_close_v1:')),false);
});
test('NAS late direct refresh cannot overwrite a snapshot after a mutation starts',async()=>{
  const h=harness();await h.c.startNasRuntime(h.c.auth.currentUser);let release;
  h.client.readLine=()=>new Promise(resolve=>release=resolve);const read=h.c.nasRefreshLine();
  h.client.submitControl=async()=>({outcome:'confirmed'});
  await h.c.nasBusinessCommand('control','truck',{type:'truck.delete',recordId:'truck',expectedRevision:1});
  release(snapshot());await read;assert.equal(h.c.state.shift,null);
});

test('NAS start screen branches before Firebase cleanup, notifications or writes',async()=>{
  const h=harness();Object.assign(h.c,{startShiftInFlight:false,requireEdit:()=>true,offlinePendingCount:()=>0,showError:message=>{throw Error(message);},showToastEl(){},closeStartShiftModal(){},refs:new Proxy({},{get(){throw Error('Firebase reference used');}})});
  vm.runInContext(source('15-shifts.js'),h.c);let sent;
  h.c.nasBusinessCommand=async(channel,target,fields)=>{sent={channel,target,fields};};h.c.nasRefreshLine=async()=>{};
  await h.c.startShiftWithObject('Site','site');assert.equal(sent.channel,'start');assert.equal(sent.fields.objectId,'site');assert.equal(h.c.startShiftInFlight,false);
});
test('NAS membership handlers preserve local trip status until server confirmation',async()=>{
  const h=harness();Object.assign(h.c,{requireEdit:()=>true,offlinePendingForTruck:()=>false,showError:message=>{throw Error(message);}});
  vm.runInContext(source('15-shifts.js'),h.c);h.c.state.shift={id:'shift'};h.c.state.truckStatus.truck={onLine:true,lastLoadTimestamp:123};
  const requests=[];h.c.nasChangeMembership=async(id,adding)=>requests.push([id,adding]);
  await h.c.addTruckToLine('truck');await h.c.removeTruckFromLine('truck');
  assert.deepEqual(requests,[['truck',true],['truck',false]]);assert.equal(h.c.state.truckStatus.truck.lastLoadTimestamp,123);
});

test('NAS command captures nested form data before waiting for a cross-tab lock',async()=>{
  const h=harness();await h.c.startNasRuntime(h.c.auth.currentUser);let unlock,sent;
  h.c.navigator.locks={request:(_key,run)=>new Promise(resolve=>{unlock=()=>resolve(run());})};
  h.client.submitControl=async op=>{sent=structuredClone(op);return {outcome:'confirmed'};};
  const fields={type:'object.create',expectedRevision:0,data:{name:'Original'}};
  const pending=h.c.nasBusinessCommand('control','object:new',fields);fields.data.name='Changed';unlock();await pending;assert.equal(sent.data.name,'Original');
});

// A failed poll must not leave an error badge after a later accepted snapshot.
test('NAS line clears a transport failure only after accepting a current server snapshot',async()=>{
 const h=harness(),{c}=h;
 vm.runInContext(source('03-formatting.js'),c);
 c.updateSyncUI=()=>{};
 c.syncState={errors:{nas:{code:'api-unreachable'}},pendingWrites:{},docCount:{},fromCache:{},everConnected:{}};
 await c.startNasRuntime(c.auth.currentUser);
 h.snapshot(snapshot());
 assert.equal(c.syncState.errors.nas,undefined);
 c.syncState.errors.nas={code:'api-unreachable'};
 vm.runInContext("nasReceiptFloors.set('truck',{truckId:'truck',shiftId:'shift',cycle:3,ttn:0})",c);
 h.snapshot(snapshot());
 assert.equal(c.syncState.errors.nas.code,'api-unreachable');
});
