  // Activated only in an isolated, explicitly tagged NAS candidate build.
  // Normal TEST and production remain unchanged; no local preference can opt in.
  function isTestAutoNasRuntime() { return document.querySelector('meta[name="test-data-provider"]')?.content === 'synology-auto-candidate'; }
  function isNasRuntime() { return isTestAutoNasRuntime() || document.querySelector('meta[name="test-data-provider"]')?.content === 'synology-candidate'; }
  function nasStorageScope() { const base='https://iluxa.synology.me:18443';let datasetEpoch=0;try{datasetEpoch=Number(localStorage.getItem('samosval_nas_dataset_epoch:'+JSON.stringify([base,WORKSPACE_ID,currentUid]))||0)||0;}catch{}return JSON.stringify(['synology',base,WORKSPACE_ID,currentUid,...(datasetEpoch?[datasetEpoch]:[])]); }
  let nasRuntimeClient = null, nasRuntimeStop = null, nasRuntimeEpoch = 0, nasResumePolling=null, nasPollHolds=0, nasReadGeneration=0;
  const nasReceiptFloors = new Map();
  const nasPresenceLeavers=new Set();
  let nasAdministration=null,nasAdminRead=null,nasCatalogRead=null,nasCatalogSnapshot=null;
  let nasSettingsSnapshot=null,nasSettingsRead=null;
  let nasArchiveRead=null;
  let nasGameRead=null,nasGameSnapshot=null,nasGameReady=false,nasGameReceiptFloor=0;
  let nasAuxSnapshot=null,nasAuxRead=null;
  const nasCommandFlights=new Map();
  function stopNasRuntime() {
    nasRuntimeEpoch++;nasReadGeneration++;nasResumePolling=null;nasPollHolds=0;
    nasRuntimeStop?.(); nasRuntimeStop = null;
    nasRuntimeClient?.stop(); nasRuntimeClient = null;
    nasReceiptFloors.clear();
    nasPresenceLeavers.clear();
    nasAdministration=null;nasAdminRead=null;nasCatalogRead=null;nasCatalogSnapshot=null;nasCommandFlights.clear();
    nasSettingsSnapshot=null;nasSettingsRead=null;
    nasArchiveRead=null;
    nasGameRead=null;nasGameSnapshot=null;nasGameReady=false;nasGameReceiptFloor=0;
    nasAuxSnapshot=null;nasAuxRead=null;
  }
  function loadNasSessionClient() { return import(new URL('./test-app/synology/session-client.mjs',document.baseURI).href); }
  function applyNasSession(session) {
    const profile=session.profile, active=session.identityReady&&profile?.status==='active'&&!profile.deleted;
    if(currentUserRole&&currentUserRole!==profile?.role){nasReadGeneration++;nasGameSnapshot=null;nasGameReady=false;nasGameReceiptFloor=0;window.__gameAccessChanged?.();}
    currentUserRole=profile?.role||null;currentUserStatus=active?'active':profile?.status==='disabled'||profile?.deleted?'disabled':'pending';
    currentUserNickname=profile?.nickname||sanitizeName(currentEmail);
    permissionsConfig=active?{...(currentUserRole==='admin'?permissionsConfig:{}),[currentUserRole]:session.permissions}:{};permissionsLoaded=!!active;
    if(active)document.body.setAttribute('data-perms-ready','1');else document.body.removeAttribute('data-perms-ready');
    document.getElementById('pendingScreen').style.display=currentUserStatus==='pending'?'flex':'none';
    document.getElementById('disabledScreen').style.display=currentUserStatus==='disabled'?'flex':'none';
    document.getElementById('mainHeader').style.display=active?'':'none';
    document.querySelector('.container').style.display=active?'':'none';document.querySelector('nav').style.display=active?'flex':'none';
    if(!active){
      nasSettingsSnapshot=null;appConfig={};nasGameSnapshot=null;nasGameReady=false;nasGameReceiptFloor=0;window.__gameAccessChanged?.();
      state.trucks=[];state.logs=[];state.truckStatus={};state.shift=null;state.archive=[];state.trash=[];state.audit=[];state.users=[];
      offlineRemoteStatuses={};offlineRemoteLogs=[];initialized=false;cancelHold();
      document.querySelectorAll('dialog[open]').forEach(d=>d.close());
      document.getElementById('registrationStatusText').textContent='Учётная запись ожидает допуска на сервере Synology.';
      document.getElementById('disabledStatusText').textContent=profile?.rejectionReason||'Доступ ограничен администратором.';
    }
    markSync('profile',false,false,profile?1:0);markSync('permissions',false,false,active?1:0);
    updateUserBadge();updateNavUI();applyRoleUI();renderAll();
  }
  // NAS versions deployed before the server ticker fix return opaque truck IDs.
  // The browser can safely render its verified catalog without changing NAS data.
  function presentNasLineNotification(item){
    if(!item||typeof item.id!=='string'||!item.id.startsWith('nas_')||!['arrive','load','ttn','reset'].includes(item.type))return item;
    const labels={arrive:'Прибытие на линию',load:'Погрузка',ttn:'Отметка ТТН',reset:'Сброс таймера'};
    const truck=state.trucks.find(row=>row.id===item.truckId);
    const visibleTruck=truck?truckLabelHtml(item.truckId):'<b>Самосвал</b>';
    const log=item.type==='load'&&!item.logId?state.logs.find(row=>row.clientOperationId===item.actionId&&row.truckId===item.truckId&&row.shiftId===item.shiftId):null;
    return {...item,html:labels[item.type]+' · '+visibleTruck,...(log?{logId:log.id}:{})};
  }
  function refreshNasLineNotificationDisplay(){
    state.notifications=(state.notifications||[]).map(presentNasLineNotification);
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
    // NAS snapshots are authoritative: ticker load events must match confirmed logs.
    confirmedLoadIds=new Set(snapshot.logs.map(log=>log.id));
    offlineProjectState();initialized=true;
    refreshNasLineNotificationDisplay();
    for(const [source,count] of [['trucks',snapshot.trucks.length],['status',snapshot.statuses.length],['logs',snapshot.logs.length],['shift',snapshot.shift?1:0]])markSync(source,false,false,count);
    markSync('nas',false,false,snapshot.logs.length);saveCache();renderAll();return true;
  }
  async function startNasRuntime(user) {
    const epoch=nasRuntimeEpoch;
    try{
      const {createNasClient}=await loadNasSessionClient();
      if(epoch!==nasRuntimeEpoch||auth.currentUser!==user||currentUid!==user.uid)return;
      let client=createNasClient({getUser:()=>auth.currentUser,workspaceId:WORKSPACE_ID});
      if(isTestAutoNasRuntime()){
        // Dedicated opt-in HTML candidate ONLY. Uses Firebase Web SDK
        // directly; no reserve HTTPS URL, Cloud Run, or auto-promotion.
        const [ownerModule,readerModule,writerModule,routerModule]=await Promise.all([
          import(new URL('./test-app/synology/spark-owner.mjs',document.baseURI).href),
          import(new URL('./test-app/synology/spark-typed-line-reader.mjs',document.baseURI).href),
          import(new URL('./test-app/synology/spark-line-writer.mjs',document.baseURI).href),
          import(new URL('./test-app/synology/spark-auto-line-client.mjs',document.baseURI).href)
        ]);
        if(epoch!==nasRuntimeEpoch||auth.currentUser!==user||currentUid!==user.uid){client.stop();return;}
        const getUser=()=>auth.currentUser;
        const authority=ownerModule.createSparkOwnerReader({firestore:db,getUser});
        const reader=readerModule.createSparkTypedLineReader({firestore:db,getUser,ownerReader:authority});
        const writer=writerModule.createSparkLineWriter({firestore:db,getUser,
          serverTimestamp:()=>firebase.firestore.FieldValue.serverTimestamp()});
        client=routerModule.createSparkAutoLineClient({
          nasClient:client,reader,writer,ownerReader:authority,firestore:db,getUser,
          onProviderChange:()=>{
            if(epoch===nasRuntimeEpoch&&nasRuntimeClient===client){updateSyncUI();renderTestBackendControls();}
          }
        });
      }
      nasRuntimeClient=client;
      for(const name of ['plugins','patches','audit','notifications'])refs[name]=nasAuxCollection(name,client,epoch);
      let registering=false;
      nasResumePolling=()=>{if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||nasPollHolds)return;nasRuntimeStop?.();nasRuntimeStop=client.subscribeLine({
        onSession:session=>{if(epoch!==nasRuntimeEpoch)return;applyNasSession(session);
          // The reserve only supports LINE. Never refresh/admin-register or
          // issue legacy NAS writes while Firebase holds the writer epoch.
          if(isTestAutoNasRuntime()&&client.activeProvider==='firebase')return;
          if(session.profile?.status==='active'&&!session.profile.deleted)void refreshNasSettings().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-settings',error);});
          if(session.profile?.status==='active'&&!session.profile.deleted)void refreshNasGames().catch(error=>{if(epoch===nasRuntimeEpoch)nasGameReadError(error);});
          if(session.profile?.status==='active'&&!session.profile.deleted)void refreshNasAuxiliary().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-auxiliary',error);});
          if(session.profile?.status==='active'&&(hasTabAccess('archive')||hasTabAccess('analytics')))void refreshNasArchive().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-archive',error);});
          if(session.identityReady&&!session.profile&&!registering){registering=true;void ensureNasPendingAccount(user).catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-registration',error);}).finally(()=>{registering=false;});}
          if(session.profile?.status==='active'&&(session.permissions.tabs.includes('line')||session.permissions.tabs.includes('trucks')||session.permissions.tabs.includes('timesheet')))void refreshNasObjects().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-objects',error);});
          if(canAdmin())void refreshNasAdministration().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-admin',error);});},
        onSnapshot:snapshot=>{if(epoch!==nasRuntimeEpoch)return;acceptNasLineSnapshot(snapshot);void replayNasOfflineJournal();},
        onError:error=>{if(epoch!==nasRuntimeEpoch)return;
          if(isTestAutoNasRuntime()&&client.activeProvider==null){
            // No verified writer: don't expose buttons from a stale session.
            permissionsLoaded=false;document.body.removeAttribute('data-perms-ready');
            cancelHold();applyRoleUI();updateNavUI();
          }
          reportSyncError('nas',error);}
      });};nasResumePolling();
    }catch(error){if(epoch===nasRuntimeEpoch)reportSyncError('nas',error);}
  }
  function loadNasTabelRemote(){return import(new URL('./test-app/synology/tabel-remote.mjs',document.baseURI).href);}
  async function refreshNasAuxiliary(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=nasReadGeneration;if(!client||currentUserStatus!=='active')return;
    if(nasAuxRead)return nasAuxRead;
    const work=(async()=>{const snapshot=await client.readAuxiliary();if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||currentUserStatus!=='active'||generation!==nasReadGeneration)return;
      const pluginsChanged=JSON.stringify(state.plugins)!==JSON.stringify(snapshot.plugins),patchesChanged=JSON.stringify(state.patches)!==JSON.stringify(snapshot.patches);
      markSync('nas-auxiliary',false,false,1);nasAuxSnapshot=snapshot;state.plugins=snapshot.plugins;state.patches=snapshot.patches;state.audit=snapshot.audit.slice(0,200);state.lineAudit=snapshot.audit;
      state.notifications=snapshot.notifications;offlineProjectTicker();refreshNasLineNotificationDisplay();
      for(const key of ['plugins','patches','audit','notifications'])markSync(key,false,false,snapshot[key].length);
      if(pluginsChanged)initPlugins();if(patchesChanged){state.patches.sort((a,b)=>(a.order||0)-(b.order||0));if(!window.__nasPatchesApplied){window.__nasPatchesApplied=true;applyAllPatches();}}
      saveCache();renderStatusTicker();renderHeaderStats();if(canAdmin()){renderPluginsList();renderPatchesList();}
    })();nasAuxRead=work;try{return await work;}finally{if(nasAuxRead===work)nasAuxRead=null;}
  }
  function nasAuxCollection(name,client,epoch,filters=[],ordering=null,maximum=null){
    const guard=()=>{if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch||currentUid!==client.uid||currentUserStatus!=='active')throw Error('Сеанс Synology изменился');};
    const document=id=>({id,ref:null,exists:true,data:()=>{const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id);if(!row)return undefined;const {id:_,revision,...data}=row;return data;}});
    const wrap=row=>{const snap=document(row.id);snap.ref=collection.doc(row.id);return snap;};
    const collection={
      doc:(id='record_'+crypto.randomUUID().replaceAll('-',''))=>({id,path:'workspaces/'+WORKSPACE_ID+'/'+name+'/'+id,
        get:async()=>{guard();await refreshNasAuxiliary();guard();const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id);return {id,exists:!!row,data:()=>{if(!row)return undefined;const {id:_,revision,...data}=row;return data;}};},
        set:async(data,options)=>{guard();if(!nasAuxSnapshot)await refreshNasAuxiliary();guard();const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id),{id:_,revision,...before}=row||{};
          await nasBusinessCommand('auxiliary',name+':'+id,{type:'auxiliary.save',collection:name,recordId:id,expectedRevision:row?.revision||0,data:options?.merge?{...before,...data}:data});guard();await refreshNasAuxiliary();},
        update:async data=>{guard();if(!nasAuxSnapshot)await refreshNasAuxiliary();guard();const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id);if(!row)throw Error('Запись уже отсутствует');return collection.doc(id).set(data,{merge:true});},
        delete:async()=>{guard();if(!nasAuxSnapshot)await refreshNasAuxiliary();guard();const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id);if(!row)return;await nasBusinessCommand('auxiliary',name+':'+id,{type:'auxiliary.delete',collection:name,recordId:id,expectedRevision:row.revision});guard();await refreshNasAuxiliary();}}),
      add:async data=>{const ref=collection.doc();await ref.set(data);return ref;},
      where:(field,operator,value)=>nasAuxCollection(name,client,epoch,[...filters,[field,operator,value]],ordering,maximum),
      orderBy:(field,direction='asc')=>nasAuxCollection(name,client,epoch,filters,[field,direction],maximum),
      limit:n=>nasAuxCollection(name,client,epoch,filters,ordering,n),
      get:async()=>{guard();await refreshNasAuxiliary();guard();let rows=(nasAuxSnapshot?.[name]||[]).filter(row=>filters.every(([k,op,v])=>{if(op==='==')return row[k]===v;if(op==='>=')return row[k]>=v;if(op==='<')return row[k]<v;throw Error('Неподдерживаемый фильтр');}));
        if(ordering){const [k,d]=ordering;rows=rows.slice().sort((a,b)=>(a[k]>b[k]?1:a[k]<b[k]?-1:0)*(d==='desc'?-1:1));}if(maximum!==null)rows=rows.slice(0,maximum);const docs=rows.map(wrap);return {docs,size:docs.length,empty:!docs.length,forEach:fn=>docs.forEach(fn),metadata:{fromCache:false,hasPendingWrites:false}};}
    };return collection;
  }
  async function nasBackupRead(id){if(!canAdmin()||!nasRuntimeClient)throw Error('Требуется администратор Synology');return nasRuntimeClient.readBackups(id);}
  async function nasBackupCommand(target,fields){return nasBusinessCommand('backup',target,fields);}
  async function nasReportAction(type,log,data){
    const expected={volume:log.volume,timestamp:log.timestamp,timeStr:log.timeStr,comment:log.comment||'',truckId:log.truckId,shiftId:log.shiftId};
    const result=await nasBusinessCommand('report',log.id,{type,logId:log.id,expected,...(data?{data}:{})});
    await nasRefreshLine();await Promise.allSettled([refreshNasGames(),refreshNasAuxiliary()]);return result;
  }
  async function nasHistoryAction(action,direction){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;if(!client)throw Error('Сеанс Synology не загружен');
    const key='samosval_nas_history_v1:'+client.scope+':'+action.id+':'+direction;
    let op=JSON.parse(localStorage.getItem(key)||'null');if(!op){op={id:'history_'+crypto.randomUUID().replaceAll('-',''),actionId:action.id,direction,expectedRevision:action.revision};localStorage.setItem(key,JSON.stringify(op));}
    let result;try{result=await client.submitHistory(op,{operationScope:client.scope});}catch(error){if([400,409].includes(error.status)&&epoch===nasRuntimeEpoch)localStorage.removeItem(key);throw error;}if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Учётная запись изменилась');
    localStorage.removeItem(key);await nasRefreshLine();await Promise.allSettled([refreshNasGames(),refreshNasAuxiliary()]);return result;
  }
  window.addEventListener('load',()=>{
    if(!isNasRuntime())return;
    const oldUndo=window.undoLastAction;
    window.undoLastAction=async()=>{
      if(offlineLocalTicker())return undoLastOfflineAction();
      try{const snapshot=await nasRuntimeClient.readHistory(),last=lastValidNotification();const action=snapshot.items.find(x=>x.id===last?.actionId);if(!action?.canUndo)throw Error('Откройте журнал: это действие уже изменено или недоступно для отмены');if(await appConfirm('Отменить действие?'))await nasHistoryAction(action,'undo');}catch(error){showError(error.message);}
    };
  });
  function acceptNasSettings(snapshot){
    markSync('nas-settings',false,false,1);nasSettingsSnapshot=snapshot;appConfig={...snapshot.data};
    settings.cycleMinutes=snapshot.data.cycleMinutes;renderAppSettingsIfActive();window.__gameConfigChanged?.();
    window.dispatchEvent(new Event('review-flags-changed'));
  }
  async function refreshNasSettings(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=nasReadGeneration;if(!client||currentUserStatus!=='active')return;
    if(nasSettingsRead)return nasSettingsRead;
    const work=(async()=>{const snapshot=await client.readSettings();if(epoch===nasRuntimeEpoch&&client===nasRuntimeClient&&currentUserStatus==='active'&&generation===nasReadGeneration&&(!nasSettingsSnapshot||snapshot.revision>=nasSettingsSnapshot.revision))acceptNasSettings(snapshot);})();
    nasSettingsRead=work;try{return await work;}finally{if(nasSettingsRead===work)nasSettingsRead=null;}
  }
  async function nasSaveSettings(patch,values){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;if(!canAdmin())throw Error('Требуется администратор');
    if(!nasSettingsSnapshot)await refreshNasSettings();
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||!nasSettingsSnapshot)throw Error('Обновите настройки Synology');
    const result=await nasBusinessCommand('settings','config',{type:values?'settings.rewards':'settings.patch',expectedRevision:nasSettingsSnapshot.revision,...(values?{values}:{patch})});
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||!canAdmin())throw Error('Сеанс администратора изменился');
    acceptNasSettings({revision:result.result.revision,data:result.result.data});return result.result.data;
  }
  async function refreshNasArchive(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=nasReadGeneration;if(!client||currentUserStatus!=='active')return;
    if(nasArchiveRead)return nasArchiveRead;
    const work=(async()=>{const snapshot=await client.readArchive();if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||currentUserStatus!=='active'||generation!==nasReadGeneration||!hasTabAccess('archive')&&!hasTabAccess('analytics'))return;
      markSync('nas-archive',false,false,snapshot.archives.length);state.archive=snapshot.archives;state.trash=snapshot.trash;markSync('archive',false,false,state.archive.length);markSync('trash',false,false,state.trash.length);saveCache();renderAll();})();
    nasArchiveRead=work;try{return await work;}finally{if(nasArchiveRead===work)nasArchiveRead=null;}
  }
  async function nasArchiveAction(type,id){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    const row=(type==='trash.purge'?state.trash:state.archive).find(x=>x.id===id);if(!row)throw Error('Обновите архив');
    const result=await nasBusinessCommand('archive',id,{type,recordId:id,expectedRevision:row.revision});
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Учётная запись изменилась');
    await refreshNasArchive();if(type==='archive.restore')await nasRefreshLine();return result;
  }
  async function refreshNasGames(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=nasReadGeneration;if(!client||currentUserStatus!=='active')return;
    if(nasGameRead)return nasGameRead;
    const work=(async()=>{const snapshot=await client.readGames();if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||currentUserStatus!=='active'||generation!==nasReadGeneration)return;
      if(snapshot.head.gameRound<nasGameReceiptFloor)return;
      markSync('nas-games',false,false,snapshot.records.length);nasGameSnapshot=snapshot;nasGameReady=true;window.__gameAccessChanged?.();window.RoadArcade?.sync();})();
    nasGameRead=work;try{return await work;}finally{if(nasGameRead===work)nasGameRead=null;}
  }
  function nasGameReadError(error){
    if([401,403].includes(error.status)){nasGameReady=false;nasGameSnapshot=null;nasGameReceiptFloor=0;}
    // A failed background read cannot revoke a previously confirmed wallet.
    // Every play still needs an authenticated server transaction and receipt.
    window.__gameAccessChanged?.();window.RoadArcade?.sync();reportSyncError('nas-games',error);
  }
  function acceptNasGameReceipt(result){
    const h=result?.confirmedHead;
    if(!nasGameSnapshot||!h||!Number.isSafeInteger(h.gameRound)||h.gameRound<1||!Number.isSafeInteger(h.bank)||h.bank<0||h.userUid!==currentUid||h.player?.uid!==currentUid||typeof h.id!=='string')return false;
    nasGameReceiptFloor=Math.max(nasGameReceiptFloor,h.gameRound);
    const records=nasGameSnapshot.records.filter(r=>r.id!==h.id).concat(h);
    const newer=h.gameRound>=nasGameSnapshot.head.gameRound;
    nasGameSnapshot={...nasGameSnapshot,records,...(newer?{head:h}:{}),players:{...nasGameSnapshot.players,...(h.gameRound>=(nasGameSnapshot.players[currentUid]?._round||0)?{[currentUid]:{...h.player,_round:h.gameRound}}:{})}};
    nasGameReady=true;window.__gameAccessChanged?.();window.RoadArcade?.sync();return true;
  }
  async function nasGameAction(action){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    const {id,roll,...gameAction}=action;
    const target=gameAction.kind==='slot'?'slot:'+id:gameAction.kind==='purchase'?'theme:'+gameAction.itemId:gameAction.kind+':'+gameAction.level+':'+(gameAction.coin??'');
    const receipt=await nasBusinessCommand('game',target,{type:'game.play',action:gameAction});
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Учётная запись изменилась');
    if(gameAction.kind!=='purchase'&&acceptNasGameReceipt(receipt.result)){
      void refreshNasGames().catch(error=>{if(epoch===nasRuntimeEpoch&&client===nasRuntimeClient)nasGameReadError(error);});
      return receipt.result;
    }
    await refreshNasGames();return receipt.result;
  }
  async function nasGrantCoins(targetUid,amount,reason){
    const receipt=await nasBusinessCommand('game','grant:'+targetUid,{type:'game.grant',targetUid,amount,reason});
    await refreshNasGames();return receipt.result;
  }
  async function refreshNasObjects(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;if(!client||currentUserStatus!=='active')return;
    if(nasCatalogRead)return nasCatalogRead;
    const work=(async()=>{const catalog=await client.readCatalog();if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||currentUserStatus!=='active'||!hasTabAccess('line')&&!hasTabAccess('trucks')&&!hasTabAccess('timesheet'))return;
      markSync('nas-objects',false,false,catalog.objects.length);nasCatalogSnapshot=catalog;state.trucks=catalog.trucks.map(row=>({...row.data,id:row.id,revision:row.revision}));state.objects=catalog.objects.map(row=>({...row.data,id:row.id,revision:row.revision}));if(state.shift?.objectId)state.shift.objectName=objectTitle(state.shift.objectId,state.shift.objectName);
      markSync('objects',false,false,state.objects.length);saveCache();window.dispatchEvent(new Event('samosval-objects-changed'));
    })();nasCatalogRead=work;try{return await work;}finally{if(nasCatalogRead===work)nasCatalogRead=null;}
  }
  function nasTabelHost(){
    const client=nasRuntimeClient,user=auth.currentUser,epoch=nasRuntimeEpoch;
    if(!client||!user)throw Error('Сеанс Synology не загружен');
    const guard=()=>{if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||auth.currentUser!==user||currentUid!==client.uid||currentUserStatus!=='active'||!permissionsLoaded||!hasTabAccess('timesheet'))throw Error('Доступ к табелю изменился');};
    const remoteFactory=async jobGuard=>{
      guard();const {createTabelRemote}=await loadNasTabelRemote();guard();
      return createTabelRemote({datasetEpoch:client.datasetEpoch,baseUrl:'https://iluxa.synology.me:18443',
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
      markSync('nas-admin',false,false,snapshot.users.length);nasAdministration=snapshot;state.users=snapshot.users.map(u=>({...u,id:u.uid}));state.requests=snapshot.requests.map(r=>({...r,id:r.uid}));
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
          let verifiedReserveSnapshot=null;
          if(isTestAutoNasRuntime()&&client.activeProvider==='firebase'&&result.outcome==='confirmed'){
            // Firestore's transaction ACK alone does not give the full NAS-
            // shaped state/log. Keep the local outbox until the typed server
            // snapshot proves the immutable operation ID is visible.
            verifiedReserveSnapshot=await client.readLine();
            if(!live())return;
            if(!verifiedReserveSnapshot.reserveOperations?.includes(op.id)){
              const e=new Error('Резервная операция ещё не видна в проверенном снимке');
              e.retryable=true;e.uncertain=true;throw e;
            }
          }
          if(result.status)nasReceiptFloors.set(op.truckId,{truckId:op.truckId,shiftId:op.shiftId,cycle:Number(result.status.cycleRevision||0),ttn:Number(result.status.ttnRevision||0)});
          // Each provider owns its own audit/history. No legacy Firebase effects.
          const all=offlineJournalRead(),saved=all.find(x=>x.id===op.id&&x.status==='pending');
          if(!saved)continue;
          Object.assign(saved,{status:result.outcome,result:result.reason||result.outcome,resolvedAt:Date.now(),effectsDelivered:true,savedResult:{status:result.status||null,log:result.log||null}});
          offlineJournalWrite(all);
          if(verifiedReserveSnapshot)acceptNasLineSnapshot(verifiedReserveSnapshot);
          else offlineAdoptResult(op,result);
          offlineTransportRecovered();
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
    const captured=JSON.parse(JSON.stringify(fields));
    const key='samosval_nas_commands_v1:'+client.scope,slot=channel+':'+target;
    const {expectedRevision,expectedTtnRevision,expectedObjectId,expected,...desired}=captured,intent=JSON.stringify(desired);
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
        const id=(channel==='report'?'report_':'cmd_')+crypto.randomUUID().replaceAll('-',''),operation={id,...captured};
        if(channel==='control'&&operation.type.endsWith('.create'))operation.recordId='record_'+id;
        if(channel==='start')operation.createdAt=Date.now();
        pending={slot,intent,operation,scope:client.scope};queue.push(pending);localStorage.setItem(key,JSON.stringify(queue));
      }
      const remove=()=>{if(!live())return;const latest=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify(latest.filter(x=>x.operation.id!==pending.operation.id)));};
      nasReadGeneration++;nasPollHolds++;nasRuntimeStop?.();nasRuntimeStop=null;
      try{
        const method={control:'submitControl',start:'startShift',close:'closeShift',settings:'submitSettings',archive:'submitArchive',game:'submitGame',auxiliary:'submitAuxiliary',report:'submitReport',backup:'submitBackup',notification:'submitNotificationTest'}[channel];
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
