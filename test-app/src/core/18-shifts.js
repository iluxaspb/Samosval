  // === СМЕНЫ ===
  function requireShiftSession(uid){
    if(!uid||currentUid!==uid)throw Error('Учётная запись изменилась. Повторите действие в текущей сессии.');
  }
  let startShiftInFlight=false;
  async function startShiftWithObject(objName, objId) {
    if(startShiftInFlight || !requireEdit('start_shift'))return;
    if(state.shift){showError('Сначала завершите текущую смену или её восстановление');return;}
    if(offlinePendingCount()){showError('Сначала синхронизируйте действия предыдущей смены');return;}
    startShiftInFlight=true;
    const sessionUid=currentUid;
    try {
      const sid='shift_'+Date.now()+'_'+Math.random().toString(36).slice(2,10);
      const shift={id:sid,objectName:objName,objectId:objId||'',startDate:nowDateStr(),startedAt:Date.now(),startedBy:getUserName(),isActive:true};
      await tfAwait(db.runTransaction(async tx=>{
        requireShiftSession(sessionUid);
        const existing=await tx.get(refs.shift);
        if(existing.exists)throw Error('Другая смена уже существует. Обновите страницу и завершите её.');
        tx.set(refs.shift,shift);
      }));
      if(currentUid!==sessionUid)return;
      state.shift=shift;offlineProjectState();renderAll();
      if(appConfig.maxEnabled&&appConfig.notifyStart)enqueueMax(`🚀 Смена начата\n🏢 ${objName}\n📅 ${nowDateStr()}\n👤 ${getUserName()}`);
      addAudit(`🚀 Начата смена на объекте: ${objName}`).catch(()=>{});
      closeStartShiftModal();showToastEl('Смена начата',false);
    }catch(e){showError(e.message);}
    finally{startShiftInFlight=false;}
  }
  function archivedTripMatches(log,saved){
    if(!saved)return false;
    const fields=['truckId','truckName','volume','timeStr','timestamp','arrivalTimestamp','createdBy','createdByEmail','isGAI','comment'];
    return !fields.some(key=>key==='isGAI'?!!saved[key]!==!!log[key]:key==='arrivalTimestamp'?Number(saved[key]||0)!==Number(log[key]||0):String(saved[key]??'')!==String(log[key]??''))
      && (!log.returnedAt||Number(saved.returnedAt)===Number(log.returnedAt))
      && (!log.gameRewardLogId||saved.gameRewardLogId===log.gameRewardLogId);
  }
  async function cleanupOldShiftData(shiftId,sessionUid=currentUid){
    if(!shiftId)throw Error('Не указана смена для очистки');
    const chunkSize=currentUserRole==='admin'?20:4;
    for(const collection of [refs.logs,refs.truckStatus]){
      const snapshot=await collection.get({source:'server'});
      const docs=snapshot.docs.filter(doc=>doc.data().shiftId===shiftId);
      for(let i=0;i<docs.length;i+=chunkSize){
        const continuing=await tfAwait(db.runTransaction(async tx=>{
          requireShiftSession(sessionUid);
          const shift=await tx.get(refs.shift);
          if(!shift.exists||shift.data().id!==shiftId)return false;
          if(!shift.data().closing||shift.data().isActive)throw Error('Очистка разрешена только при закрытии смены');
          const archive=await tx.get(refs.archive.doc(shift.data().closeArchiveId||('closed_'+shiftId)));
          if(!archive.exists||archive.data().sourceShiftId!==shiftId)throw Error('Сохранённый архив недоступен. Очистка отменена.');
          const saved=archive.data(),savedLogs=new Map((saved.logs||[]).map(log=>[log.id,log]));
          const current=await Promise.all(docs.slice(i,i+chunkSize).map(doc=>tx.get(doc.ref)));
          for(const doc of current){
            if(!doc.exists||doc.data().shiftId!==shiftId)continue;
            const data=doc.data();
            if(collection===refs.logs&&!archivedTripMatches(data,savedLogs.get(doc.id)))
              throw Error('Рейс изменился или отсутствует в архиве. Очистка отменена.');
            if(collection===refs.truckStatus&&saved.truckStatuses){
              const original=saved.truckStatuses[doc.id];
              const keys=['onLine','arriveTimestamp','ttnStatus','lastLoadTimestamp','lastLoadLogId','cycleRevision','ttnRevision'];
              if(!original||keys.some(key=>JSON.stringify(original[key]??null)!==JSON.stringify(data[key]??null)))
                throw Error('Линия изменена после архивации. Очистка отменена.');
            }
          }
          current.forEach(doc=>{if(doc.exists&&doc.data().shiftId===shiftId)tx.delete(doc.ref);});
          // Only this validated archive cleanup may preserve rewards for deleted live rows.
          return collection===refs.logs?{archiveCleanup:{version:1,shiftId,archiveId:archive.id}}:true;
        }));
        if(!continuing)return;
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
    if(state.shift?.restoring){showError('Сначала завершите восстановление из исходного архива');return;}
    if (!state.shift || (!state.shift.isActive && !state.shift.closing)) { appNotice('Смена не начата'); return; }
    if(offlinePendingCount()){showError('Сначала синхронизируйте действия перед закрытием смены');return;}
    const shiftId=state.shift.id,sessionUid=currentUid;
    closeShiftInFlight=true;
    const button=document.getElementById('closeShiftBtn'),oldLabel=button?.textContent;
    let phase='подтверждение';
    try {
      if (!(await appConfirm(state.shift.closing?'Завершить закрытие смены?':'Закрыть смену?'))) return;
      if(button){button.disabled=true;button.textContent='⏳ Сохраняем и закрываем смену…';}
      phase='остановка новых отметок';
      const shift=await tfAwait(db.runTransaction(async tx=>{
        requireShiftSession(sessionUid);
        const snap=await tx.get(refs.shift);
        if(!snap.exists)return null;
        const data=snap.data();
        if(data.id!==shiftId)throw Error('Уже открыта другая смена. Обновите страницу.');
        if(data.restoring)throw Error('Сначала завершите восстановление из исходного архива');
        if(data.isActive===false&&!data.closing)throw Error('Смена уже завершена. Обновите страницу.');
        const closing={isActive:false,closing:true,closeArchiveId:data.closeArchiveId||('closed_'+shiftId),closingStartedAt:data.closingStartedAt||Date.now(),closingBy:data.closingBy||getUserName()};
        if(!data.closing||data.isActive!==false)tx.update(refs.shift,closing);
        return {...data,...closing};
      }));
      if(!shift){showToastEl('Смена уже закрыта',false);return;}
      phase='сохранение архива';
      const archiveRef=refs.archive.doc(shift.closeArchiveId);
      const [existing,logSnapshot,statusSnapshot]=await Promise.all([archiveRef.get({source:'server'}),refs.logs.get({source:'server'}),refs.truckStatus.get({source:'server'})]);
      const logs=logSnapshot.docs.map(d=>({...d.data(),id:d.id})).filter(l=>l.shiftId===shiftId);
      const statuses={};statusSnapshot.docs.forEach(d=>{const data=d.data();if(data.shiftId===shiftId)statuses[d.id]=data;});
      let archived=existing.exists?existing.data():null;
      if(!archived){
        const ttn={},line=[];
        Object.entries(statuses).forEach(([id,st])=>{if(st.onLine)line.push(id);if(st.ttnStatus!==undefined&&st.ttnStatus!==null)ttn[id]=st.ttnStatus;});
        const candidate={sourceShiftId:shiftId,truckStatuses:statuses,objectName:shift.objectName||'',objectId:shift.objectId||'',date:shift.startDate||'',closedAt:shift.closingStartedAt,closedBy:shift.closingBy,
          logs:logs.map(l=>({id:l.id,gameRewardLogId:l.gameRewardLogId||l.id,truckId:l.truckId,truckName:l.truckName||'',volume:l.volume??0,timeStr:l.timeStr||'',timestamp:l.timestamp,arrivalTimestamp:Number(l.arrivalTimestamp)||null,returnedAt:recordedTripReturn(l,logs,statuses,shiftId),createdBy:l.createdBy||'',createdByEmail:l.createdByEmail||'',isGAI:!!l.isGAI,comment:l.comment||''})),
          activeLineIds:line,ttnStatus:ttn,totalVolume:logs.filter(l=>!l.isGAI).reduce((total,l)=>total+Number(l.volume||0),0),totalTrips:logs.filter(l=>!l.isGAI).length};
        archived=await tfAwait(db.runTransaction(async tx=>{
          requireShiftSession(sessionUid);
          const saved=await tx.get(archiveRef);
          if(saved.exists)return saved.data();
          tx.set(archiveRef,candidate);
          return candidate;
        }));
      }
      if(archived&&archived.sourceShiftId!==shiftId)throw Error('Архив относится к другой смене. Очистка отменена.');
      const savedLogs=new Map((archived?.logs||[]).map(log=>[log.id,log]));
      for(const log of logs){
        const saved=savedLogs.get(log.id);
        if(!saved)throw Error('Есть рейсы, отсутствующие в сохранённом архиве. Очистка отменена.');
        if(!archivedTripMatches(log,saved))
          throw Error('Рейс изменён после архивации. Очистка отменена; проверьте исходные данные.');
      }
      phase='очистка сохранённых рейсов';
      await cleanupOldShiftData(shiftId,sessionUid);
      phase='завершение смены';
      await tfAwait(db.runTransaction(async tx=>{
        requireShiftSession(sessionUid);
        const snap=await tx.get(refs.shift);
        if(!snap.exists)return;
        if(snap.data().id!==shiftId||!snap.data().closing)throw Error('Смена изменилась. Новая смена не затронута.');
        const finalArchive=await tx.get(archiveRef);
        if(!finalArchive.exists||finalArchive.data().sourceShiftId!==shiftId)throw Error('Сохранённый архив недоступен. Завершение отменено.');
        tx.delete(refs.shift);
      }));
      if(currentUid!==sessionUid)return;
      if(state.shift?.id===shiftId){state.shift=null;offlineProjectState();renderAll();}
      showToastEl('Смена закрыта',false);
      addAudit('🔄 Закрыта смена. Рейсов: '+(archived?.totalTrips||0)).catch(()=>{});
      clearAllNotifications().catch(()=>{});
    } catch(e){ console.error('[closeShift:'+phase+']',e);showError('Не удалось завершить закрытие ('+phase+'): '+(e.message||e.code||e)+'. Сохранённый архив не удалён; можно повторить закрытие.'); }
    finally {closeShiftInFlight=false;if(button){button.disabled=false;button.textContent=oldLabel||'🔄 Закрыть смену';}if(typeof renderShiftLifecycle==='function')renderShiftLifecycle();}
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
  async function applyChangeObject(id) {
    if(!requireEdit('edit_line'))return;
    const object=state.objects.find(x=>x.id===id),shiftId=state.shift?.id,sessionUid=currentUid;
    if(!object||!shiftId)return;
    try{
      await tfAwait(db.runTransaction(async tx=>{
        requireShiftSession(sessionUid);
        const current=await tx.get(refs.shift);
        if(!current.exists||current.data().id!==shiftId||!current.data().isActive||current.data().closing||current.data().restoring)
          throw Error('Смена изменилась, закрывается или восстанавливается. Обновите страницу.');
        tx.update(refs.shift,{objectId:object.id,objectName:object.name});
      }));
      addAudit(`🏢 Изменен объект: ${object.name}`).catch(()=>{});
      closeChangeObjectModal();showToastEl('Объект изменен',false);
    }catch(e){showError(e.message);}
  }
  async function confirmChangeObject() {
    let n = document.getElementById('changeObjCustomInput').value.trim();
    if (n) { let ex = state.objects.find(o=>o.name.toLowerCase()===n.toLowerCase()); if(ex) await applyChangeObject(ex.id); else { try { let r=refs.objects.doc(); await tfAwait(r.set({name:n, createdAt:Date.now(), createdBy:getUserName()})); await applyChangeObject(r.id); } catch(e){ showError(e.message); } } } else appNotice('Выберите объект');
  }

