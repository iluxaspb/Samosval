  // === СМЕНЫ ===
  async function startShiftWithObject(objName, objId) {
    if (!requireEdit('start_shift')) return;
    if(offlinePendingCount()){showError('Сначала синхронизируйте действия предыдущей смены');return;}
    try {
      await cleanupOldShiftData(); await clearAllNotifications();
      let sid = 'shift_' + Date.now();
      await tfAwait(refs.shift.set({ id: sid, objectName: objName, objectId: objId||'', startDate: nowDateStr(), startedAt: Date.now(), startedBy: getUserName(), isActive: true }));
      if (appConfig.maxEnabled && appConfig.notifyStart) enqueueMax(`🚀 Смена начата\n🏢 ${objName}\n📅 ${nowDateStr()}\n👤 ${getUserName()}`);
      addAudit(`🚀 Начата смена на объекте: ${objName}`).catch(()=>{});
      closeStartShiftModal(); showToastEl('Смена начата', false);
    } catch(e){ showError(e.message); }
  }
  async function cleanupOldShiftData(){
    for(const collection of [refs.logs,refs.truckStatus]){
      const snap=await collection.get({source:'server'});
      if(snap.size){const batch=db.batch();snap.forEach(d=>batch.delete(d.ref));await tfAwait(batch.commit());}
    }
  }
  function recordedTripReturn(log, logs, status, shiftId) {
    const start = Number(log.timestamp);
    const next = logs.filter(l => l.truckId === log.truckId && Number(l.timestamp) > start).sort((a,b) => Number(a.timestamp)-Number(b.timestamp))[0];
    const st = status[log.truckId];
    const end = Number(log.returnedAt) || (next ? Number(next.arrivalTimestamp) : st && (!st.shiftId || st.shiftId === shiftId) ? Number(st.arriveTimestamp) : 0);
    return start > 0 && end > start && end <= Date.now() && (!next || end <= Number(next.timestamp)) ? end : null;
  }
  async function closeShift() {
    if (!requireEdit('close_shift')) return;
    if (!state.shift || !state.shift.isActive) { appNotice('Смена не начата'); return; }
    if(offlinePendingCount()){showError('Сначала синхронизируйте действия перед закрытием смены');return;}
    let logs = getLogs(); if (!(await appConfirm('Закрыть смену?'))) return;
    try {
      if (logs.length > 0) {
        let ttn={}, line=[];
        Object.keys(state.truckStatus).forEach(id=>{ let st=state.truckStatus[id]; if(st.onLine) line.push(id); if(st.ttnStatus!==undefined && st.ttnStatus!==null) ttn[id]=st.ttnStatus; });
        let totVol = logs.filter(l=>!l.isGAI).reduce((s,l)=>s+l.volume,0);
        await tfAwait(refs.archive.doc().set({ sourceShiftId: state.shift.id, objectName: state.shift.objectName, objectId: state.shift.objectId || '', date: state.shift.startDate, closedAt: Date.now(), closedBy: getUserName(), logs: logs.map(l=>({truckId:l.truckId, truckName:l.truckName, volume:l.volume, timeStr:l.timeStr, timestamp:l.timestamp, arrivalTimestamp:Number(l.arrivalTimestamp)||null, returnedAt:recordedTripReturn(l, logs, state.truckStatus, state.shift.id), createdBy:l.createdBy, createdByEmail:l.createdByEmail||'', isGAI:l.isGAI, comment:l.comment||''})), activeLineIds: line, ttnStatus: ttn, totalVolume: totVol, totalTrips: logs.filter(l=>!l.isGAI).length }));
        addAudit(`🔄 Закрыта смена. Рейсов: ${logs.filter(l=>!l.isGAI).length}`).catch(()=>{});
      }
      if (appConfig.maxEnabled && appConfig.maxUrl && logs.length > 0) await sendShiftReportToMax(state.shift, logs);
      await cleanupOldShiftData(); await clearAllNotifications(); await tfAwait(refs.shift.delete()); showToastEl('Смена закрыта', false);
    } catch(e){ showError(e.message); }
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

