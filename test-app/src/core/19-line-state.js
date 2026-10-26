  // === ЛИНИЯ ===
  function assertLineAccess(uid,action) {
    if(currentUid!==uid)throw {code:'cancelled',message:'Учётная запись изменилась'};
    if(!offlineJournalCanWrite())throw {code:'failed-precondition',message:offlineJournalOwnershipStatus()};
    if(currentUserStatus!=='active'||!permissionsLoaded||(action&&!hasPermission(action)))
      throw {code:'permission-denied',message:'Доступ к изменению линии ограничен'};
  }
  function editableLineShift(shift) {
    return !!shift&&shift.isActive!==false&&!shift.closing&&!shift.restoring;
  }
  async function readEditableLineShift(tx,shiftId,uid,action) {
    assertLineAccess(uid,action);
    const snap=await tx.get(refs.shift);
    assertLineAccess(uid,action);
    if(!snap.exists||snap.data().id!==shiftId||!editableLineShift(snap.data()))
      throw {code:'shift-changed',message:'Смена завершена, закрывается или восстанавливается. Обновите данные'};
    return snap.data();
  }
  async function addTruckToLine(id) {
    if (!requireEdit('edit_line') || !state.shift) return false;
    const uid=currentUid,shiftId=state.shift.id,revision=truckServerRevisions[id]||0;
    if(offlinePendingForTruck(id)){showError('Сначала синхронизируйте действия этого самосвала');return false;}
    try {
      const result=await tfAwait(db.runTransaction(async tx=>{
        await readEditableLineShift(tx,shiftId,uid,'edit_line');
        const ref=refs.truckStatus.doc(id),snap=await tx.get(ref);
        assertLineAccess(uid,'edit_line');
        if(snap.exists&&snap.data().shiftId===shiftId&&snap.data().onLine)return {changed:false,status:snap.data()};
        const status={id,shiftId,onLine:true,addedBy:getUserName(),addedAt:Date.now(),arriveStatus:null,arriveTimestamp:null,arriveBy:null,ttnStatus:null,ttnBy:null,ttnLogId:null,lastLoadTimestamp:null,lastLoadBy:null,lastLoadLogId:null,cycleRevision:0,ttnRevision:0,loadedAfterArrive:false};
        tx.set(ref,status);return {changed:true,status};
      }));
      if(currentUid!==uid)return false;
      acceptLineResult(id,result,{shiftId,revision,logRevision:logServerRevision});
      if(result.changed){
        if (appConfig.maxEnabled && appConfig.notifyLineStart) { let t = findTruck(id); if (t) enqueueMax(`🟢 На линию добавлен\n🚛 ${t.number}\n👤 ${getUserName()}`); }
        addAudit(`🚛 На линию добавлен: ${truckName(id)}`).catch(()=>{});
      }
      return true;
    } catch(e){showError(e.message||e.code);return false;}
  }
  async function removeTruckFromLine(id) {
    if (!requireEdit('edit_line')||!state.shift) return false;
    if(offlinePendingForTruck(id)){showError('Сначала синхронизируйте действия этого самосвала');return false;}
    const uid=currentUid,shiftId=state.shift.id,revision=truckServerRevisions[id]||0,tName=truckName(id);
    try{
      const changed=await tfAwait(db.runTransaction(async tx=>{
        await readEditableLineShift(tx,shiftId,uid,'edit_line');
        const ref=refs.truckStatus.doc(id),snap=await tx.get(ref);
        assertLineAccess(uid,'edit_line');
        if(!snap.exists)return false;
        if(snap.data().shiftId!==shiftId)throw {code:'shift-changed',message:'Самосвал относится к другой смене'};
        tx.delete(ref);return true;
      }));
      if(currentUid!==uid)return false;
      if(state.shift?.id===shiftId&&(truckServerRevisions[id]||0)===revision){
        delete state.truckStatus[id];delete offlineRemoteStatuses[id];refreshLineViews();
      }
      if(changed){
        if (appConfig.maxEnabled && appConfig.notifyLineEnd) enqueueMax(`🔴 С линии убран\n🚛 ${tName}\n👤 ${getUserName()}`);
        addAudit(`🚛 С линии убран: ${tName}`).catch(()=>{});
      }
      return true;
    }catch(e){showError(e.message||e.code);return false;}
  }
  const truckStatusWrites = Object.create(null);
  function robustTruckStatusUpdate(id, upd) {
    const context={uid:currentUid,shiftId:state.shift?.id};
    const previous = truckStatusWrites[id] || Promise.resolve();
    const task = previous.catch(() => {}).then(() => persistTruckStatusUpdate(id, upd, context));
    truckStatusWrites[id] = task;
    task.then(() => { if (truckStatusWrites[id] === task) delete truckStatusWrites[id]; },
      () => { if (truckStatusWrites[id] === task) delete truckStatusWrites[id]; });
    return task;
  }
  async function persistTruckStatusUpdate(id, upd, context={uid:currentUid,shiftId:state.shift?.id}) {
    pendingStart();
    try {
      return await db.runTransaction(async tx=>{
        await readEditableLineShift(tx,context.shiftId,context.uid,'edit_line');
        const ref=refs.truckStatus.doc(id),snap=await tx.get(ref);
        assertLineAccess(context.uid,'edit_line');
        if(!snap.exists||snap.data().shiftId!==context.shiftId||!snap.data().onLine)
          throw {code:'not-on-line',message:'Самосвал снят с линии. Данные не восстановлены поверх новой смены'};
        if(upd.shiftId!==undefined&&upd.shiftId!==context.shiftId)throw Error('Нельзя изменить смену самосвала');
        tx.update(ref,upd);
      });
    } finally { pendingEnd(); }
  }
  // All line actions use the server state; failed writes never restore stale local copies.
  const lineActionInFlight = Object.create(null);
  const truckServerRevisions = Object.create(null);
  let logServerRevision = 0;
  function captureLineIntent(id) {
    const status=state.truckStatus[id];
    return status&&state.shift?{shiftId:state.shift.id,status:{...status},revision:truckServerRevisions[id]||0,logRevision:logServerRevision}:null;
  }
  function signalLineTransition(id,before,after) {
    if(!before||!after||!after.onLine||!state.shift||after.shiftId!==state.shift.id)return;
    if(after.lastLoadTimestamp && after.lastLoadTimestamp!==before.lastLoadTimestamp && !after.arriveStatus){
      window.__cardJustLoaded={id,time:Date.now()};window.__cardJustArrived=null;
    }else if(after.arriveTimestamp && after.arriveTimestamp!==before.arriveTimestamp){
      window.__cardJustArrived={id,wasFaded:before.ttnStatus===true&&!before.arriveStatus,time:Date.now()};window.__cardJustLoaded=null;
    }
  }
  function refreshLineViews(){
    saveCache();renderLine();renderHeaderStats();renderStatusTicker();
    scheduleRenderForTab('report','renderReport');scheduleRenderForTab('analytics','renderAnalytics');
  }
  function acceptLineResult(id,result,intent) {
    if(!state.shift||state.shift.id!==intent.shiftId)return;
    if(result.status && (truckServerRevisions[id]||0)===intent.revision){
      signalLineTransition(id,state.truckStatus[id],result.status);
      state.truckStatus[id]={id,...result.status};offlineRemoteStatuses[id]={id,...result.status};
      truckServerRevisions[id]=(truckServerRevisions[id]||0)+1;
    }
    if(result.log && logServerRevision===intent.logRevision){
      state.logs=state.logs.filter(l=>l.id!==result.log.id);state.logs.unshift(result.log);
      state.logs.sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));confirmedLoadIds.add(result.log.id);
      offlineRemoteLogs=offlineRemoteLogs.filter(l=>l.id!==result.log.id);offlineRemoteLogs.push(result.log);
    }
    if(syncState.errors)delete syncState.errors[result.type];
    refreshLineViews();updateSyncUI();
  }
  function mergeCachedTruckStatus(remote,recent){
    if(!recent||recent.shiftId!==remote.shiftId)return remote;
    const merged=Number(recent.cycleRevision||0)>Number(remote.cycleRevision||0)?{...recent}:{...remote};
    const a=Number(recent.ttnRevision||0),b=Number(remote.ttnRevision||0),ttn=a>b?recent:a<b?remote:merged;
    for(const key of ['ttnStatus','ttnBy','ttnLogId','ttnRevision']){if(Object.hasOwn(ttn,key))merged[key]=ttn[key];else delete merged[key];}
    return merged;
  }

  function receiveTruckStatuses(snapshot){
    markSync('status',snapshot.metadata.fromCache,snapshot.metadata.hasPendingWrites,snapshot.size);
    if(snapshot.metadata.hasPendingWrites)return;
    const next={};snapshot.forEach(doc=>{next[doc.id]={id:doc.id,...doc.data()};});
    if(snapshot.metadata.fromCache)Object.keys(next).forEach(id=>{
      next[id]=mergeCachedTruckStatus(next[id],offlineRemoteStatuses[id]);
    });
    const old=state.truckStatus;offlineRemoteStatuses=next;offlineProjectState();
    Object.keys(state.truckStatus).forEach(id=>{
      if(JSON.stringify(old[id])!==JSON.stringify(state.truckStatus[id])){
        signalLineTransition(id,old[id],state.truckStatus[id]);
        truckServerRevisions[id]=(truckServerRevisions[id]||0)+1;
      }
    });
    Object.keys(old).filter(id=>!state.truckStatus[id]).forEach(id=>truckServerRevisions[id]=(truckServerRevisions[id]||0)+1);
    refreshLineViews();
  }
  function receiveLoadLogs(snapshot){
    markSync('logs',snapshot.metadata.fromCache,snapshot.metadata.hasPendingWrites,snapshot.size);
    if(snapshot.metadata.hasPendingWrites)return;
    logServerRevision++;
    const next=snapshot.docs.map(doc=>({id:doc.id,...doc.data()})).sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
    if(snapshot.metadata.fromCache){
      const included=new Set(next.map(l=>l.id));
      for(const log of offlineRemoteLogs)if(!included.has(log.id))next.push(log);
    }
    offlineRemoteLogs=next;confirmedLoadIds=new Set(offlineRemoteLogs.map(l=>l.id));
    offlineProjectState();refreshLineViews();
  }
  async function readLineState(tx,id,shiftId){
    const uid=currentUid;await readEditableLineShift(tx,shiftId,uid);
    const status=await tx.get(refs.truckStatus.doc(id));
    assertLineAccess(uid);
    if(!status.exists||status.data().shiftId!==shiftId||!status.data().onLine)throw {code:'not-on-line',message:'Самосвал уже снят с этой линии'};
    return status.data();
  }
  function previousLoadSnapshot(s){return {wasArrived:!!s.arriveStatus,prevArriveStatus:s.arriveStatus||null,prevArriveTs:s.arriveTimestamp||null,prevArriveBy:s.arriveBy||null,prevLoadTs:s.lastLoadTimestamp||null,prevLoadBy:s.lastLoadBy||null,prevLoadLogId:s.lastLoadLogId||null,prevTtn:s.ttnStatus??null,prevTtnBy:s.ttnBy||null,prevTtnLogId:s.ttnLogId||null};}
  async function findWinningLoad(tx,id,shiftId,status){
    if(!status.lastLoadTimestamp)return null;
    const candidates=[status.lastLoadLogId,...state.logs.filter(l=>l.truckId===id&&l.shiftId===shiftId&&Number(l.timestamp)===Number(status.lastLoadTimestamp)).map(l=>l.id),`load_${id}_${shiftId}_${status.lastLoadTimestamp}`].filter(Boolean);
    for(const logId of [...new Set(candidates)].slice(0,3)){
      const log=await tx.get(refs.logs.doc(logId));
      if(log.exists&&log.data().truckId===id&&log.data().shiftId===shiftId&&Number(log.data().timestamp)===Number(status.lastLoadTimestamp))return {id:log.id,...log.data()};
    }
    return null;
  }
  async function recoverLineState(id,intent){
    try{
      const snap=await refs.truckStatus.doc(id).get({source:'server'});
      if(snap.exists)acceptLineResult(id,{status:snap.data(),type:'load'},intent);
    }catch(_){}
  }
