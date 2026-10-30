  // Activated only in an isolated NAS candidate build, never by a stored preference.
  // The normal TEST build remains Firebase until every feature has a NAS adapter.
  function isNasRuntime() { return document.querySelector('meta[name="test-data-provider"]')?.content === 'synology-candidate'; }
  function nasStorageScope() { return JSON.stringify(['synology','https://iluxa.synology.me:18443',WORKSPACE_ID,currentUid]); }
  let nasRuntimeClient = null, nasRuntimeStop = null, nasRuntimeEpoch = 0, nasResumePolling=null, nasPollHolds=0, nasReadGeneration=0;
  const nasReceiptFloors = new Map();
  const nasPresenceLeavers=new Set();
  let nasAdministration=null,nasAdminRead=null,nasCatalogRead=null,nasCatalogSnapshot=null;
  const nasCommandFlights=new Map();
  function stopNasRuntime() {
    nasRuntimeEpoch++;nasReadGeneration++;nasResumePolling=null;nasPollHolds=0;
    nasRuntimeStop?.(); nasRuntimeStop = null;
    nasRuntimeClient?.stop(); nasRuntimeClient = null;
    nasReceiptFloors.clear();
    nasPresenceLeavers.clear();
    nasAdministration=null;nasAdminRead=null;nasCatalogRead=null;nasCatalogSnapshot=null;nasCommandFlights.clear();
  }
  function loadNasSessionClient() { return import(new URL('./test-app/synology/session-client.mjs',document.baseURI).href); }
  function applyNasSession(session) {
    const profile=session.profile, active=session.identityReady&&profile?.status==='active'&&!profile.deleted;
    currentUserRole=profile?.role||null;currentUserStatus=active?'active':profile?.status==='disabled'||profile?.deleted?'disabled':'pending';
    currentUserNickname=profile?.nickname||sanitizeName(currentEmail);
    permissionsConfig=active?{...(currentUserRole==='admin'?permissionsConfig:{}),[currentUserRole]:session.permissions}:{};permissionsLoaded=!!active;
    if(active)document.body.setAttribute('data-perms-ready','1');else document.body.removeAttribute('data-perms-ready');
    document.getElementById('pendingScreen').style.display=currentUserStatus==='pending'?'flex':'none';
    document.getElementById('disabledScreen').style.display=currentUserStatus==='disabled'?'flex':'none';
    document.getElementById('mainHeader').style.display=active?'':'none';
    document.querySelector('.container').style.display=active?'':'none';document.querySelector('nav').style.display=active?'flex':'none';
    if(!active){
      state.trucks=[];state.logs=[];state.truckStatus={};state.shift=null;state.archive=[];state.trash=[];state.audit=[];state.users=[];
      offlineRemoteStatuses={};offlineRemoteLogs=[];initialized=false;cancelHold();
      document.querySelectorAll('dialog[open]').forEach(d=>d.close());
      document.getElementById('registrationStatusText').textContent='Учётная запись ожидает допуска на сервере Synology.';
      document.getElementById('disabledStatusText').textContent=profile?.rejectionReason||'Доступ ограничен администратором.';
    }
    markSync('profile',false,false,profile?1:0);markSync('permissions',false,false,active?1:0);
    updateUserBadge();updateNavUI();applyRoleUI();renderAll();
  }
  function acceptNasLineSnapshot(snapshot) {
    // A snapshot read before a committed receipt must not roll the UI backwards.
    for(const floor of nasReceiptFloors.values()){
      if(floor.shiftId!==snapshot.shift?.id)continue;
      const status=snapshot.statuses.find(s=>s.id===floor.truckId);
      if(!status||Number(status.cycleRevision||0)<floor.cycle||Number(status.ttnRevision||0)<floor.ttn)return false;
    }
    nasReceiptFloors.clear();
    state.shift=snapshot.shift;state.trucks=snapshot.trucks;
    settings.cycleMinutes=snapshot.cycleMinutes;
    offlineRemoteStatuses=Object.fromEntries(snapshot.statuses.map(s=>[s.id,s]));offlineRemoteLogs=snapshot.logs.slice();
    offlineProjectState();initialized=true;
    for(const [source,count] of [['trucks',snapshot.trucks.length],['status',snapshot.statuses.length],['logs',snapshot.logs.length],['shift',snapshot.shift?1:0]])markSync(source,false,false,count);
    saveCache();renderAll();return true;
  }
  async function startNasRuntime(user) {
    const epoch=nasRuntimeEpoch;
    try{
      const {createNasClient}=await loadNasSessionClient();
      if(epoch!==nasRuntimeEpoch||auth.currentUser!==user||currentUid!==user.uid)return;
      const client=createNasClient({getUser:()=>auth.currentUser,workspaceId:WORKSPACE_ID});nasRuntimeClient=client;
      let registering=false;
      nasResumePolling=()=>{if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||nasPollHolds)return;nasRuntimeStop?.();nasRuntimeStop=client.subscribeLine({
        onSession:session=>{if(epoch!==nasRuntimeEpoch)return;applyNasSession(session);
          if(session.identityReady&&!session.profile&&!registering){registering=true;void ensureNasPendingAccount(user).catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-registration',error);}).finally(()=>{registering=false;});}
          if(session.profile?.status==='active'&&(session.permissions.tabs.includes('line')||session.permissions.tabs.includes('trucks')||session.permissions.tabs.includes('timesheet')))void refreshNasObjects().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-objects',error);});
          if(canAdmin())void refreshNasAdministration().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-admin',error);});},
        onSnapshot:snapshot=>{if(epoch!==nasRuntimeEpoch)return;acceptNasLineSnapshot(snapshot);void replayNasOfflineJournal();},
        onError:error=>{if(epoch!==nasRuntimeEpoch)return;reportSyncError('nas',error);}
      });};nasResumePolling();
    }catch(error){if(epoch===nasRuntimeEpoch)reportSyncError('nas',error);}
  }
  function loadNasTabelRemote(){return import(new URL('./test-app/synology/tabel-remote.mjs',document.baseURI).href);}
  async function refreshNasObjects(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;if(!client||currentUserStatus!=='active')return;
    if(nasCatalogRead)return nasCatalogRead;
    const work=(async()=>{const catalog=await client.readCatalog();if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||currentUserStatus!=='active'||!hasTabAccess('line')&&!hasTabAccess('trucks')&&!hasTabAccess('timesheet'))return;
      nasCatalogSnapshot=catalog;state.trucks=catalog.trucks.map(row=>({...row.data,id:row.id,revision:row.revision}));state.objects=catalog.objects.map(row=>({...row.data,id:row.id,revision:row.revision}));if(state.shift?.objectId)state.shift.objectName=objectTitle(state.shift.objectId,state.shift.objectName);
      markSync('objects',false,false,state.objects.length);saveCache();window.dispatchEvent(new Event('samosval-objects-changed'));
    })();nasCatalogRead=work;try{return await work;}finally{if(nasCatalogRead===work)nasCatalogRead=null;}
  }
  function nasTabelHost(){
    const client=nasRuntimeClient,user=auth.currentUser,epoch=nasRuntimeEpoch;
    if(!client||!user)throw Error('Сеанс Synology не загружен');
    const guard=()=>{if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||auth.currentUser!==user||currentUid!==client.uid||currentUserStatus!=='active'||!permissionsLoaded||!hasTabAccess('timesheet'))throw Error('Доступ к табелю изменился');};
    const remoteFactory=async jobGuard=>{
      guard();const {createTabelRemote}=await loadNasTabelRemote();guard();
      return createTabelRemote({baseUrl:'https://iluxa.synology.me:18443',
        getIdToken:async force=>{guard();const token=await user.getIdToken(force);guard();return token;},
        guard:job=>{guard();jobGuard?.(job);}});
    };
    return {session:()=>({projectId:firebaseConfig.projectId,workspaceId:WORKSPACE_ID,uid:currentUid,name:getUserName(),role:currentUserRole,
      active:epoch===nasRuntimeEpoch&&client===nasRuntimeClient&&currentUserStatus==='active',view:epoch===nasRuntimeEpoch&&permissionsLoaded&&hasTabAccess('timesheet'),edit:hasPermission('timesheet_edit'),objectId:state.shift?.objectId,runtimeId:epoch,
      provider:'synology',providerScope:client.scope}),remoteFactory,
      presenceRemote:{list:target=>{guard();return client.readPresence(target);},write:payload=>{guard();return client.writePresence(payload);},remove:payload=>client.removePresence(payload)},
      registerPresenceLeave:callback=>{nasPresenceLeavers.add(callback);return ()=>nasPresenceLeavers.delete(callback);},
      get shift(){return state.shift;},get objects(){return state.objects;},
      users:async()=>{guard();const result=await client.readMembers();guard();return result.members.map(m=>({...m,id:m.uid}));},
      readCatalog:async()=>{const remote=await remoteFactory();const row=await remote.read('_catalog/config');guard();const data=row.data||{};
        if(data.equipment!==undefined&&!Array.isArray(data.equipment)||data.people!==undefined&&!Array.isArray(data.people))throw Error('Не подтверждён формат справочника табеля');
        return {equipment:data.equipment||[],people:data.people||[]};},
      snapshot:()=>({shift:state.shift,trucks:state.trucks,statuses:state.truckStatus,logs:state.logs,audit:state.audit,lineAudit:state.lineAudit,archive:state.archive}),
      createObject:async(name,startDate)=>{guard();const result=await nasSaveRecord('object','',{name,...(startDate?{startDate}:{})},0);guard();return {...result.result.data,id:result.result.id};}
    };
  }
  async function leaveNasPresence(){
    let timer;try{await Promise.race([Promise.allSettled([...nasPresenceLeavers].map(fn=>Promise.resolve().then(fn))),new Promise(resolve=>{timer=setTimeout(resolve,1500);})]);}finally{clearTimeout(timer);}
  }
  async function ensureNasPendingAccount(user,getUser=()=>auth.currentUser) {
    if(getUser()!==user)throw Error('Сеанс регистрации изменился');
    const {createNasClient}=await loadNasSessionClient();
    if(getUser()!==user)throw Error('Сеанс регистрации изменился');
    const client=createNasClient({getUser,workspaceId:WORKSPACE_ID});
    try{return await client.registerPending({nickname:sanitizeName(user.email||'')});}finally{client.stop();}
  }
  async function refreshNasAdministration() {
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||!canAdmin())throw Error('Требуется активный администратор Synology');
    if(nasAdminRead)return nasAdminRead;
    const work=(async()=>{
      const snapshot=await client.readAdministration();
      if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||!canAdmin())throw Error('Сеанс администратора изменился');
      nasAdministration=snapshot;state.users=snapshot.users.map(u=>({...u,id:u.uid}));state.requests=snapshot.requests.map(r=>({...r,id:r.uid}));
      permissionsConfig={...snapshot.permissions,admin:permissionsConfig.admin};
      requestSyncStatus.requests=true;requestSyncStatus.users=true;requestSyncStatus.errors={};renderAdminPanel();return snapshot;
    })();nasAdminRead=work;
    try{return await work;}finally{if(nasAdminRead===work)nasAdminRead=null;}
  }
  function nasIdentityJournalKey(){return 'samosval_nas_identity_v1:'+nasStorageScope();}
  async function nasAdminAction(type,payload) {
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||!canAdmin()||!navigator.onLine)throw Error('Для изменения доступа нужен администратор и соединение с Synology');
    if(!nasAdministration)await refreshNasAdministration();
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||!canAdmin())throw Error('Сеанс администратора изменился');
    const key=nasIdentityJournalKey(),intent=JSON.stringify({type,...payload});
    const stored=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(stored))throw Error('Не удалось прочитать очередь изменения доступа');
    const target=payload.uid||payload.role,existing=stored.find(x=>x.type===type&&x.target===target);
    if(existing&&existing.intent!==intent)throw Error('Предыдущее изменение ещё ожидает подтверждения. Повторите его перед новым изменением');
    let queued=existing;
    if(!queued){
      const operation={id:'identity_'+crypto.randomUUID().replaceAll('-',''),type,...payload};
      if(type==='permissions.replace'){
        const config=nasAdministration.permissions[payload.role];if(!config)throw Error('Обновите матрицу прав');operation.expectedRevision=config.revision;
      }else{
        const profile=[...nasAdministration.users,...nasAdministration.deletedUsers].find(u=>u.uid===payload.uid);if(!profile)throw Error('Обновите список пользователей');
        if(type.startsWith('registration.')){
          const request=nasAdministration.requests.find(r=>r.uid===payload.uid);if(!request)throw Error('Заявка уже рассмотрена. Обновите список');
          operation.expectedRevision=request.revision;operation.expectedProfileRevision=profile.revision;
        }else operation.expectedRevision=profile.revision;
      }
      queued={type,target,intent,operation,scope:client.scope};stored.push(queued);localStorage.setItem(key,JSON.stringify(stored));
    }
    try{
      const result=await client.submitAdministration(queued.operation,{operationScope:queued.scope});
      if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Сеанс администратора изменился');
      const latest=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify(latest.filter(x=>x.operation.id!==queued.operation.id)));
      await refreshNasAdministration().catch(error=>reportSyncError('nas-admin',error));return result;
    }catch(error){
      // A conflict is authoritative; a transport/auth failure retains the same ID.
      if([400,409].includes(error.status)&&epoch===nasRuntimeEpoch){const latest=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify(latest.filter(x=>x.operation.id!==queued.operation.id)));await refreshNasAdministration().catch(()=>{});}
      throw error;
    }
  }
  async function runNasAdminAction(type,payload) {
    try{await nasAdminAction(type,payload);showToastEl('Изменение сохранено на Synology',false);return true;}
    catch(error){if(canAdmin())renderAdminPanel();showError(error.message||'Изменение не подтверждено');return false;}
  }
  async function replayNasOfflineJournal() {
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||offlineReplayRunning||!navigator.onLine||!permissionsLoaded||currentUserStatus!=='active'||Date.now()<offlineServerRetryAt)return;
    const live=()=>epoch===nasRuntimeEpoch&&nasRuntimeClient===client&&client.uid===currentUid;
    offlineReplayRunning=true;
    try{
      for(const op of offlinePendingOps()){
        if(!live()||!navigator.onLine||currentUserStatus!=='active')break;
        if(op.dependencyId){const previous=offlineJournalRead().find(x=>x.id===op.dependencyId);if(previous?.status==='pending')break;if(previous?.status==='rejected'){offlineResolve(op.id,'rejected','previous-action-rejected');offlineProjectState();refreshLineViews();continue;}}
        try{
          const result=await client.submitLine(op,{operationScope:op.operationScope});
          if(!live())return;
          if(result.status)nasReceiptFloors.set(op.truckId,{truckId:op.truckId,shiftId:op.shiftId,cycle:Number(result.status.cycleRevision||0),ttn:Number(result.status.ttnRevision||0)});
          // The NAS transaction owns audit/history. Never deliver Firebase effects.
          const all=offlineJournalRead(),saved=all.find(x=>x.id===op.id&&x.status==='pending');
          if(!saved)continue;
          Object.assign(saved,{status:result.outcome,result:result.reason||result.outcome,resolvedAt:Date.now(),effectsDelivered:true,savedResult:{status:result.status||null,log:result.log||null}});
          offlineJournalWrite(all);offlineAdoptResult(op,result);offlineTransportRecovered();
          if(result.outcome==='rejected')showToastEl('⚠️ '+escapeHtml(offlineReasonLabel(result.reason)),true);
        }catch(error){
          if(!live())return;
          // HTTP/auth/transport failures have no business receipt. Keep the intent.
          reportSyncError('nas',error);
          if(error.retryable||error.uncertain)offlineTransportFailed(error);
          break;
        }
      }
    }finally{offlineReplayRunning=false;if(live())updateSyncUI();}
  }

  // Persist the complete immutable intent before sending. Lost replies reuse IDs.
  async function nasBusinessCommand(channel,target,fields) {
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||currentUserStatus!=='active'||!navigator.onLine)throw Error('Нужно соединение с Synology');
    const key='samosval_nas_commands_v1:'+client.scope,slot=channel+':'+target;
    const {expectedRevision,expectedTtnRevision,expectedObjectId,...desired}=fields,intent=JSON.stringify(desired);
    const flightKey=key+':'+slot;
    const inflight=nasCommandFlights.get(flightKey);
    if(inflight){if(inflight.intent!==intent)throw Error('Предыдущее изменение ещё отправляется');return inflight.work;}
    const live=()=>epoch===nasRuntimeEpoch&&client===nasRuntimeClient&&client.uid===currentUid;
    const run=async()=>{
      if(!live())throw Error('Учётная запись изменилась');
      const queue=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(queue))throw Error('Не удалось прочитать очередь Synology');
      let pending=queue.find(x=>x.slot===slot);
      if(pending&&pending.intent!==intent)throw Error('Сначала повторите предыдущее неподтверждённое изменение');
      if(!pending){
        const id='cmd_'+crypto.randomUUID().replaceAll('-',''),operation={id,...fields};
        if(channel==='control'&&operation.type.endsWith('.create'))operation.recordId='record_'+id;
        if(channel==='start')operation.createdAt=Date.now();
        pending={slot,intent,operation,scope:client.scope};queue.push(pending);localStorage.setItem(key,JSON.stringify(queue));
      }
      const remove=()=>{if(!live())return;const latest=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify(latest.filter(x=>x.operation.id!==pending.operation.id)));};
      nasReadGeneration++;nasPollHolds++;nasRuntimeStop?.();nasRuntimeStop=null;
      try{
        const method={control:'submitControl',start:'startShift',close:'closeShift'}[channel];
        const result=await client[method](pending.operation,{operationScope:pending.scope});
        if(!live())throw Error('Учётная запись изменилась');
        remove();return result;
      }catch(error){if([400,409].includes(error.status))remove();throw error;}
      finally{if(live()){nasPollHolds--;if(!nasPollHolds)nasResumePolling?.();}}
    };
    const work=navigator.locks?navigator.locks.request(key,run):Promise.resolve().then(run);nasCommandFlights.set(flightKey,{work,intent});
    try{return await work;}finally{if(nasCommandFlights.get(flightKey)?.work===work)nasCommandFlights.delete(flightKey);}
  }
  function nasRecordRevision(kind,id){
    const rows=kind==='truck'?nasCatalogSnapshot?.trucks:nasCatalogSnapshot?.objects;
    return rows?.find(row=>row.id===id)?.revision;
  }
  async function nasRefreshLine(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=++nasReadGeneration;if(!client)return;
    const snapshot=await client.readLine();if(client===nasRuntimeClient&&epoch===nasRuntimeEpoch&&generation===nasReadGeneration)acceptNasLineSnapshot(snapshot);
  }
  async function nasSaveRecord(kind,id,data,revision){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    const result=await nasBusinessCommand('control',kind+':'+(id||'new'),{type:kind+(id?'.update':'.create'),...(id?{recordId:id}:{}),expectedRevision:id?revision:0,data});
    await Promise.allSettled([refreshNasObjects(),nasRefreshLine()]);if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch)throw Error('Учётная запись изменилась');renderAll();return result;
  }
  async function nasDeleteRecord(kind,id,revision){
    await nasBusinessCommand('control',kind+':'+id,{type:kind+'.delete',recordId:id,expectedRevision:revision});
    await Promise.allSettled([refreshNasObjects(),nasRefreshLine()]);renderAll();
  }
  async function nasChangeMembership(id,adding){
    if(offlinePendingForTruck(id))throw Error('Сначала синхронизируйте действия этого самосвала');
    const status=state.truckStatus[id],shiftId=state.shift?.id;if(!shiftId)throw Error('Смена не открыта');
    const result=await nasBusinessCommand('control','membership:'+id,{type:adding?'line.add':'line.remove',truckId:id,shiftId,expectedRevision:Number(status?.cycleRevision||0),expectedTtnRevision:Number(status?.ttnRevision||0)});
    const row=result.result;nasReceiptFloors.set(id,{truckId:id,shiftId,cycle:Number(row.cycleRevision||0),ttn:Number(row.ttnRevision||0)});
    offlineRemoteStatuses[id]=row;offlineProjectState();saveCache();renderAll();await nasRefreshLine();
  }

  function loadNasMaterialTransfer(){return import(new URL('./test-app/tabel-v2/material-transfer.mjs',document.baseURI).href);}
  async function nasCloseCurrentShift(shiftId){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;if(!client)throw Error('Сеанс Synology не загружен');
    const guard=()=>{if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||currentUid!==client.uid)throw Error('Учётная запись изменилась');};
    const key='samosval_nas_close_v1:'+client.scope+':'+shiftId;
    let prepared=JSON.parse(localStorage.getItem(key)||'null');
    if(!prepared){prepared=await nasBusinessCommand('close',shiftId+':prepare',{type:'prepare',shiftId});guard();localStorage.setItem(key,JSON.stringify(prepared));}
    if(prepared.shift?.id!==shiftId||prepared.archive&&prepared.archive.sourceShiftId!==shiftId)throw Error('Сохранённое закрытие относится к другой смене');
    await nasRefreshLine();guard();
    if(prepared.archive){const module=await loadNasMaterialTransfer();guard();await module.transferClosedLine(nasTabelHost(),prepared.shift,prepared.archive);guard();}
    await nasBusinessCommand('close',shiftId+':finish',{type:'finish',shiftId});guard();
    localStorage.removeItem(key);
    await nasRefreshLine().catch(error=>reportSyncError('nas',error));guard();
  }
