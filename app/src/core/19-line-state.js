  // === ЛИНИЯ ===
  async function addTruckToLine(id) {
    if (!requireEdit('edit_line') || !state.shift) return;
    let ex = state.truckStatus[id];
    let d = { id, shiftId: state.shift.id, onLine: true, addedBy: getUserName(), addedAt: Date.now(), arriveStatus: null, arriveTimestamp: null, arriveBy: null, ttnStatus: null, ttnBy: null, ttnLogId: null, lastLoadTimestamp: null, lastLoadBy: null, lastLoadLogId:null, cycleRevision:0, loadedAfterArrive: false };
    state.truckStatus[id] = d; offlineRemoteStatuses[id]={...d};saveCache(); renderLine(); renderHeaderStats();
    tf((async ()=>{ if(ex) await refs.truckStatus.doc(id).update(d); else await refs.truckStatus.doc(id).set(d); })());
    if (appConfig.maxEnabled && appConfig.notifyLineStart) { let t = findTruck(id); if (t) enqueueMax(`🟢 На линию добавлен\n🚛 ${t.number}\n👤 ${getUserName()}`); }
    addAudit(`🚛 На линию добавлен: ${truckName(id)}`).catch(()=>{});
  }
  async function removeTruckFromLine(id) {
    if (!requireEdit('edit_line')) return;
    if(offlinePendingForTruck(id)){showError('Сначала синхронизируйте действия этого самосвала');return;}
    let tName = truckName(id);
    delete state.truckStatus[id];delete offlineRemoteStatuses[id];saveCache(); renderLine(); renderHeaderStats(); tf(refs.truckStatus.doc(id).delete());
    if (appConfig.maxEnabled && appConfig.notifyLineEnd) enqueueMax(`🔴 С линии убран\n🚛 ${tName}\n👤 ${getUserName()}`);
    addAudit(`🚛 С линии убран: ${tName}`).catch(()=>{});
  }
  const truckStatusWrites = Object.create(null);
  function robustTruckStatusUpdate(id, upd) {
    const previous = truckStatusWrites[id] || Promise.resolve();
    const task = previous.catch(() => {}).then(() => persistTruckStatusUpdate(id, upd));
    truckStatusWrites[id] = task;
    task.then(() => { if (truckStatusWrites[id] === task) delete truckStatusWrites[id]; },
      () => { if (truckStatusWrites[id] === task) delete truckStatusWrites[id]; });
    return task;
  }
  async function persistTruckStatusUpdate(id, upd) {
    pendingStart();
    try { if (!navigator.onLine) { try { await refs.truckStatus.doc(id).update(upd); } catch(e){ if(e.code!=='not-found') throw e; let st=state.truckStatus[id]||{}; await refs.truckStatus.doc(id).set(Object.assign({id, onLine:true, shiftId:state.shift?.id}, st, upd)); } return; }
      let lastE; for(let i=0; i<3; i++) { try { await refs.truckStatus.doc(id).update(upd); return; } catch(e){ lastE=e; if(e.code==='not-found'){ let st=state.truckStatus[id]||{}; try{ await refs.truckStatus.doc(id).set(Object.assign({id, onLine:true, shiftId:state.shift?.id}, st, upd)); return; }catch(e2){lastE=e2;} } if(i<2) await new Promise(r=>setTimeout(r,400)); } }
      throw lastE;
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
    const shift=await tx.get(refs.shift),status=await tx.get(refs.truckStatus.doc(id));
    if(!shift.exists||shift.data().id!==shiftId||shift.data().isActive===false)throw {code:'shift-changed',message:'Смена изменилась. Данные обновляются; повторите действие в текущей смене'};
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
