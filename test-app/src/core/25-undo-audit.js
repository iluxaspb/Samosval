  let undoActionInFlight = false;
  async function undoLastAction() {
    if (undoActionInFlight) return;
    if (!hasPermission('undo_action') && !hasPermission('undo_any')) { showError('Нет права отменять действия'); return; }
    const last = lastValidNotification(); if (!last) return;
    if (!hasPermission('undo_any') && last.createdByEmail !== currentEmail) { showError('Можно отменить только своё действие'); return; }
    if (!['arrive','load','ttn'].includes(last.type)) { showError('Это действие отменяется через историю администратора'); return; }
    if (!(await appConfirm('Отменить действие?'))) return;
    undoActionInFlight = true; pendingStart();
    try {
      if (truckStatusWrites[last.truckId]) await truckStatusWrites[last.truckId];
      const localStatus = state.truckStatus[last.truckId];
      if (!localStatus) throw {code:'status-missing',message:'Статус машины не загружен. Обновите страницу'};
      const before = {...localStatus};
      const observedRevision=truckServerRevisions[last.truckId]||0;
      const notificationRef = refs.notifications.doc(last.id), statusRef = refs.truckStatus.doc(last.truckId);
      let update = null;
      await db.runTransaction(async tx => {
        const notification = await tx.get(notificationRef);
        const status = await tx.get(statusRef);
        const logRef = last.type === 'load' && last.logId ? refs.logs.doc(last.logId) : null;
        const log = logRef ? await tx.get(logRef) : null;
        if (!notification.exists) throw {code:'already-undone',message:'Действие уже отменено'};
        if (!hasPermission('undo_any') && notification.data().createdByEmail !== currentEmail) throw {code:'not-owner',message:'Можно отменить только своё действие'};
        if (!status.exists) throw {code:'status-missing',message:'Самосвал отсутствует на линии'};
        const current = status.data();
        const keys=['shiftId','onLine','arriveStatus','arriveTimestamp','arriveBy','lastLoadTimestamp','lastLoadBy','loadedAfterArrive','ttnStatus','ttnBy','ttnLogId','cycleRevision','lastLoadLogId','ttnRevision'];
        if (keys.some(key => JSON.stringify(current[key] ?? null) !== JSON.stringify(before[key] ?? null))) throw {code:'action-conflict',message:'Данные машины изменились. Обновите страницу перед отменой'};
        if (last.type === 'arrive') {
          update = last.wasArrived ? {arriveStatus:last.prevTime||null,arriveTimestamp:last.prevTs||null,arriveBy:last.prevArriveBy||null} : {arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false};
        } else if (last.type === 'load') {
          if (!log || !log.exists) throw {code:'log-missing',message:'Рейс уже удалён или не был сохранён'};
          if (!hasPermission('undo_any') && log.data().createdByEmail !== currentEmail) throw {code:'not-owner',message:'Нельзя отменить чужую погрузку'};
          if (Number(current.lastLoadTimestamp) !== Number(log.data().timestamp)) throw {code:'action-conflict',message:'У самосвала уже есть более новая погрузка'};
          update={loadedAfterArrive:false,lastLoadTimestamp:last.prevLoadTs??null,lastLoadBy:last.prevLoadBy??null};
          if (last.wasArrived) Object.assign(update,{arriveStatus:last.prevArriveStatus||null,arriveTimestamp:last.prevArriveTs||null,arriveBy:last.prevArriveBy||null});
          update.lastLoadLogId=last.prevLoadLogId||null;
          if (last.prevTtn !== undefined) update.ttnStatus=last.prevTtn;
          if (last.prevTtnBy !== undefined) update.ttnBy=last.prevTtnBy||null;
          if (last.prevTtnLogId !== undefined) update.ttnLogId=last.prevTtnLogId;
        } else {
          update={ttnStatus:last.prevTtn??null,ttnBy:last.prevTtnBy??null,ttnLogId:last.prevTtnLogId??null};
        }
        if(last.type==='arrive'||last.type==='load')update.cycleRevision=Number(current.cycleRevision||0)+1;
        if(last.type==='ttn'||last.type==='load')update.ttnRevision=Number(current.ttnRevision||0)+1;
        const original=notification.data();
        const penaltyKey=original.gamePenaltyKey||window.__gamePenaltyKey(last.type,last.truckId,current,last.logId,last.id);
        const savePenalty=await window.__gameStagePenalty(tx,penaltyKey,{user:original.createdByEmail,name:original.createdBy,description:({load:'Погрузка',arrive:'Прибытие',ttn:'Отметка ТТН'}[last.type])+' · '+truckName(last.truckId),...window.__gamePenaltyScope(penaltyKey,original,current)});
        tx.update(statusRef,update);
        if (logRef) tx.delete(logRef);
        savePenalty();
        tx.delete(notificationRef);
      });
      if (state.truckStatus[last.truckId] && (truckServerRevisions[last.truckId]||0)===observedRevision) {const next={...state.truckStatus[last.truckId],...update};signalLineTransition(last.truckId,state.truckStatus[last.truckId],next);state.truckStatus[last.truckId]=next;truckServerRevisions[last.truckId]=observedRevision+1;}
      if (last.type === 'load') { state.logs=state.logs.filter(l=>l.id!==last.logId); confirmedLoadIds.delete(last.logId); }
      state.notifications=state.notifications.filter(n=>n.id!==last.id);
      if (syncState.errors) delete syncState.errors.undo;
      saveCache(); renderAll();
      await addAudit('↶ Отмена: ' + ({load:'погрузка самосвала',arrive:last.wasArrived?'снятие прибытия':'прибытие на линию',ttn:'отметка ТТН'}[last.type]) + ': ' + truckName(last.truckId),{eventType:'undo',originalType:last.type,truckId:last.truckId,originalUserEmail:last.createdByEmail||''});
      showToastEl('↩️ Отменено',false,true);
    } catch(e) {
      reportSyncError('undo',e);
      showError('Действие не отменено: ' + escapeHtml(e.message || 'Ошибка Firebase') + ' [' + escapeHtml(e.code || 'unknown') + ']');
    } finally { pendingEnd(); undoActionInFlight=false; }
  }
  async function addAudit(text, details = {}) {
    const timestamp = Date.now();
    const entry = { text, timeStr: new Date(timestamp).toLocaleString('ru-RU'), objectName: state.shift?.objectName || '—', objectId: state.shift?.objectId || '', shiftId: state.shift?.id || '', userEmail: currentEmail || '', userName: getUserName(), createdByEmail: currentEmail || '', timestamp, ...details };
    pendingStart();
    try { await refs.audit.add(entry); }
    catch(e) { console.warn('Audit error:', e); showError('Не удалось записать событие в аудит: ' + e.message); }
    finally { pendingEnd(); }
  }
  function auditTruckAction(type, id, extra = {}) {
    const labels = { arrive: '🚛 Прибытие на линию', arrive_cancel: '↩️ Снято прибытие на линию', load: '⚡ Погрузка самосвала', ttn: '📄 Забрана ТТН', ttn_cancel: '↩️ Снята отметка ТТН' };
    const name = truckName(id);
    return addAudit((labels[type] || type) + ': ' + name + (type === 'load' ? ' · ' + (extra.volume || 0) + ' м³' : ''), {eventType:type,truckId:id,truckName:name,...extra});
  }
  function renderAuditEntries() {
    return '<div style="font-size:11px;color:var(--muted);margin:8px 0">Последние ' + state.audit.length + ' событий всех пользователей (до 200). Новые события сверху.</div>' + state.audit.map(a => {
      const name = resolveUserDisplayName(a.userEmail || a.createdByEmail, a.userName);
      return `<div class="audit-item"><div class="audit-time">${escapeHtml(a.timeStr)} · ${escapeHtml(name)}</div><div>${escapeHtml(a.text)}</div><div class="audit-time" style="margin-top:5px">${escapeHtml(a.objectName || '—')}</div></div>`;
    }).join('');
  }

