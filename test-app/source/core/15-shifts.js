  async function startShiftWithObject(objName, objId) {
    if (startShiftInFlight || !requireEdit('start_shift')) return;
    if(state.shift?.closing){showError('Сначала завершите закрытие предыдущей смены');return;}
    if(offlinePendingCount()){showError('Сначала синхронизируйте действия предыдущей смены');return;}
    if(state.shift?.isActive)return;
    startShiftInFlight=true;
    try {
      await cleanupOldShiftData(); await clearAllNotifications();
      let sid = 'shift_' + Date.now();
      await tfAwait(refs.shift.set({ id: sid, objectName: objName, objectId: objId||'', startDate: nowDateStr(), startedAt: Date.now(), startedBy: getUserName(), isActive: true }));
      if (appConfig.maxEnabled && appConfig.notifyStart) enqueueMax(`🚀 Смена начата\n🏢 ${objName}\n📅 ${nowDateStr()}\n👤 ${getUserName()}`);
      addAudit(`🚀 Начата смена на объекте: ${objName}`).catch(()=>{});
      closeStartShiftModal(); showToastEl('Смена начата', false);
    } catch(e){ showError(e.message); }
    finally{startShiftInFlight=false;}
  }
  async function cleanupOldShiftData(shiftId){
    const chunkSize=currentUserRole==='admin'?20:4;
    for(const collection of [refs.logs,refs.truckStatus]){
      const snap=await collection.get({source:'server'});
      const docs=snap.docs.filter(d=>!shiftId||d.data().shiftId===shiftId);
      for(let i=0;i<docs.length;i+=chunkSize){
        const batch=db.batch();docs.slice(i,i+chunkSize).forEach(d=>batch.delete(d.ref));
        await tfAwait(batch.commit());
      }
    }
  }
  function recordedTripReturn(log, logs, status, shiftId) {
    const start = Number(log.timestamp);
    const next = logs.filter(l => l.truckId === log.truckId && Number(l.timestamp) > start).sort((a,b) => Number(a.timestamp)-Number(b.timestamp))[0];
    const st = status[log.truckId];
    const end = Number(log.returnedAt) || (next ? Number(next.arrivalTimestamp) : st && (!st.shiftId || st.shiftId === shiftId) ? Number(st.arriveTimestamp) : 0);
    return start > 0 && end > start && end <= Date.now() && (!next || end <= Number(next.timestamp)) ? end : null;
  }
  let closeShiftInFlight=false;
  async function closeShift() {
    if (closeShiftInFlight || !requireEdit('close_shift')) return;
    if (!state.shift || (!state.shift.isActive && !state.shift.closing)) { appNotice('Смена не начата'); return; }
    if(offlinePendingCount()){showError('Сначала синхронизируйте действия перед закрытием смены');return;}
    const shiftId=state.shift.id;
    closeShiftInFlight=true;
    const button=document.getElementById('closeShiftBtn'),oldLabel=button?.textContent;
    let phase='подтверждение';
    try {
      if (!(await appConfirm(state.shift.closing?'Завершить закрытие смены?':'Закрыть смену?'))) return;
      if(button){button.disabled=true;button.textContent='⏳ Сохраняем и закрываем смену…';}
      phase='остановка новых отметок';
      const shift=await tfAwait(db.runTransaction(async tx=>{
        const snap=await tx.get(refs.shift);
        if(!snap.exists)return null;
        const data=snap.data();
        if(data.id!==shiftId)throw Error('Уже открыта другая смена. Обновите страницу.');
        if(data.isActive===false&&!data.closing)throw Error('Смена уже завершена. Обновите страницу.');
        const closing={isActive:false,closing:true,closeArchiveId:data.closeArchiveId||('closed_'+shiftId),closingStartedAt:data.closingStartedAt||Date.now(),closingBy:data.closingBy||getUserName()};
        if(!data.closing||data.isActive!==false)tx.update(refs.shift,closing);
        return {...data,...closing};
      }));
      if(!shift){showToastEl('Смена уже закрыта',false);return;}
      phase='сохранение архива';
      const archiveRef=refs.archive.doc(shift.closeArchiveId);
      const [existing,logSnapshot,statusSnapshot]=await Promise.all([archiveRef.get({source:'server'}),refs.logs.get({source:'server'}),refs.truckStatus.get({source:'server'})]);
      const logs=logSnapshot.docs.map(d=>({id:d.id,...d.data()})).filter(l=>l.shiftId===shiftId);
      const statuses={};statusSnapshot.docs.forEach(d=>{const data=d.data();if(data.shiftId===shiftId)statuses[d.id]=data;});
      let archived=existing.exists?existing.data():null;
      if(!archived&&logs.length){
        const ttn={},line=[];
        Object.entries(statuses).forEach(([id,st])=>{if(st.onLine)line.push(id);if(st.ttnStatus!==undefined&&st.ttnStatus!==null)ttn[id]=st.ttnStatus;});
        const candidate={sourceShiftId:shiftId,objectName:shift.objectName||'',objectId:shift.objectId||'',date:shift.startDate||'',closedAt:shift.closingStartedAt,closedBy:shift.closingBy,
          logs:logs.map(l=>({id:l.id,truckId:l.truckId,truckName:l.truckName||'',volume:l.volume??0,timeStr:l.timeStr||'',timestamp:l.timestamp,arrivalTimestamp:Number(l.arrivalTimestamp)||null,returnedAt:recordedTripReturn(l,logs,statuses,shiftId),createdBy:l.createdBy||'',createdByEmail:l.createdByEmail||'',isGAI:!!l.isGAI,comment:l.comment||''})),
          activeLineIds:line,ttnStatus:ttn,totalVolume:logs.filter(l=>!l.isGAI).reduce((total,l)=>total+Number(l.volume||0),0),totalTrips:logs.filter(l=>!l.isGAI).length};
        archived=await tfAwait(db.runTransaction(async tx=>{
          const saved=await tx.get(archiveRef);
          if(saved.exists)return saved.data();
          tx.set(archiveRef,candidate);
          return candidate;
        }));
      }
      if(archived&&archived.sourceShiftId!==shiftId)throw Error('Архив относится к другой смене. Очистка отменена.');
      if(archived&&logs.some(log=>!(archived.logs||[]).some(saved=>saved.id===log.id)))throw Error('Есть рейсы, отсутствующие в сохранённом архиве. Очистка отменена.');
      phase='перенос материала в Табель 2';
      if(archived){
        const module=await import(new URL('./test-app/tabel-v2/material-transfer.mjs',document.baseURI).href);
        await module.transferClosedLine({workspace:wsRef,transaction:fn=>db.runTransaction(fn),documentId:()=>firebase.firestore.FieldPath.documentId(),objects:state.objects,session:()=>({projectId:firebaseConfig.projectId,workspaceId:WORKSPACE_ID,uid:currentUid,name:getUserName(),active:currentUserStatus==='active',edit:hasPermission('timesheet_edit')})},shift,archived);
      }
      phase='очистка сохранённых рейсов';
      await cleanupOldShiftData(shiftId);
      phase='завершение смены';
      await tfAwait(db.runTransaction(async tx=>{
        const snap=await tx.get(refs.shift);
        if(!snap.exists)return;
        if(snap.data().id!==shiftId||!snap.data().closing)throw Error('Смена изменилась. Новая смена не затронута.');
        tx.delete(refs.shift);
      }));
      // Even a shift with zero trips has a last-closed address on this device.
      // Archived shifts remain the cross-device source when they have records.
      try {
        localStorage.setItem('tabel-v2-last-closed:' + firebaseConfig.projectId + ':' + WORKSPACE_ID,
          JSON.stringify({objectId: shift.objectId, closedAt: shift.closingStartedAt || Date.now()}));
      } catch (_) {}
      if(state.shift?.id===shiftId){state.shift=null;offlineProjectState();renderAll();}
      showToastEl('Смена закрыта',false);
      addAudit('🔄 Закрыта смена. Рейсов: '+(archived?.totalTrips||0)).catch(()=>{});
      clearAllNotifications().catch(()=>{});
    } catch(e){ console.error('[closeShift:'+phase+']',e);showError('Не удалось завершить закрытие ('+phase+'): '+(e.message||e.code||e)+'. Сохранённый архив не удалён; можно повторить закрытие.'); }
    finally {closeShiftInFlight=false;if(button){button.disabled=false;button.textContent=oldLabel||'🔄 Закрыть смену';}}
  }
  function openStartShiftModal() {
    if (!requireEdit('start_shift')) return;
    let c = document.getElementById('existingObjectsList');
    let objs = state.objects.slice().sort((a,b)=>a.name.localeCompare(b.name));
    c.innerHTML = objs.length === 0 ? '<div style="color:var(--muted);font-size:12px;">Нет объектов</div>' : objs.map(o=>`<div style="background:var(--bg);padding:10px;border-radius:8px;margin-bottom:6px;border:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;"><span>🏢 <b>${escapeHtml(o.name)}</b></span><button class="btn btn-quick btn-small" onclick="startShiftFromBase('${o.id}')">Выбрать</button></div>`).join('');
    document.getElementById('newObjectNameInput').value = ''; document.getElementById('startShiftModal').classList.add('open');
  }
  function closeStartShiftModal() { document.getElementById('startShiftModal').classList.remove('open'); }
  async function startShiftFromBase(id) { let o=state.objects.find(x=>x.id===id); if(o) await startShiftWithObject(o.name, o.id); }
  async function confirmStartShift() {
    if (!requireEdit('start_shift')) return; let n = document.getElementById('newObjectNameInput').value.trim(); if (!n) { appNotice('Введите имя'); return; }
    let ex = state.objects.find(o=>o.name.toLowerCase()===n.toLowerCase());
    if (ex) await startShiftWithObject(ex.name, ex.id);
    else { try { let r=refs.objects.doc(); await tfAwait(r.set({name:n, createdAt:Date.now(), createdBy:getUserName()})); await startShiftWithObject(n, r.id); } catch(e){ showError(e.message); } }
  }
  function openChangeObjectModal() {
    if (!requireEdit('edit_line') || !state.shift) return;
    let c = document.getElementById('changeObjList');
    c.innerHTML = state.objects.map(o=>{ let isC = state.shift.objectId === o.id || state.shift.objectName === o.name; return `<div style="background:var(--bg);padding:10px;border-radius:8px;margin-bottom:6px;border:1px solid ${isC?'var(--success)':'var(--border)'};display:flex;justify-content:space-between;align-items:center;"><span>🏢 <b>${escapeHtml(o.name)}</b> ${isC?'(текущий)':''}</span><button class="btn btn-quick btn-small" onclick="applyChangeObject('${o.id}')">Выбрать</button></div>`; }).join('');
    document.getElementById('changeObjCustomInput').value = ''; document.getElementById('changeObjectModal').classList.add('open');
  }
  function closeChangeObjectModal() { document.getElementById('changeObjectModal').classList.remove('open'); }
  async function applyChangeObject(id) { let o = state.objects.find(x=>x.id===id); if(!o || !state.shift) return; if (state.shift.objectId === id) { closeChangeObjectModal(); return; } try { await tfAwait(refs.shift.update({objectId:o.id, objectName:o.name})); addAudit(`🏢 Изменен объект: ${o.name}`).catch(()=>{}); closeChangeObjectModal(); showToastEl('Объект изменен', false); } catch(e){ showError(e.message); } }
  async function confirmChangeObject() {
    let n = document.getElementById('changeObjCustomInput').value.trim();
    if (n) { let ex = state.objects.find(o=>o.name.toLowerCase()===n.toLowerCase()); if(ex) await applyChangeObject(ex.id); else { try { let r=refs.objects.doc(); await tfAwait(r.set({name:n, createdAt:Date.now(), createdBy:getUserName()})); await applyChangeObject(r.id); } catch(e){ showError(e.message); } } } else appNotice('Выберите объект');
  }

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
  function receiveTruckStatuses(snapshot){
    markSync('status',snapshot.metadata.fromCache,snapshot.metadata.hasPendingWrites,snapshot.size);
    if(snapshot.metadata.hasPendingWrites)return;
    const next={};snapshot.forEach(doc=>{next[doc.id]={id:doc.id,...doc.data()};});
    if(snapshot.metadata.fromCache)Object.keys(next).forEach(id=>{
      const recent=offlineRemoteStatuses[id];
      if(recent&&recent.shiftId===next[id].shiftId&&Number(recent.cycleRevision||0)>Number(next[id].cycleRevision||0))next[id]=recent;
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
  // Persistent, optimistic offline actions; server remains authoritative.
  const offlineJournalKey=()=> 'samosval_offline_v1_'+firebaseConfig.projectId+'_'+WORKSPACE_ID+'_'+currentUid;
  let offlineReplayRunning=false,offlineRemoteStatuses={},offlineRemoteLogs=[];
  function offlineJournalRead(){
    if(!currentUid)return [];
    try{const a=JSON.parse(localStorage.getItem(offlineJournalKey())||'[]');return Array.isArray(a)?a.filter(x=>x&&x.id&&x.shiftId&&x.truckId):[];}catch(e){console.error(e);return [];}
  }
  function offlineJournalWrite(items){localStorage.setItem(offlineJournalKey(),JSON.stringify(items));updateSyncUI();}
  function offlinePendingOps(){return offlineJournalRead().filter(x=>x.status==='pending');}
  function offlinePendingForTruck(id){return offlinePendingOps().some(x=>x.truckId===id&&state.shift&&x.shiftId===state.shift.id);}
  function offlinePendingCount(){return offlinePendingOps().length;}
  // navigator.onLine is only a browser hint. Firestore may be unreachable even
  // while it remains true (Wi-Fi without internet, DNS failure, captive portal).
  let offlineServerRetryAt=0,offlineServerRetryDelay=0,offlineServerUnreachable=false;
