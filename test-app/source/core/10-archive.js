  const archiveExpandedObjects = new Set();
  function renderArchive() {
    if (!hasTabAccess('archive')) return;
    const container=document.getElementById('archiveContainer');
    if (!container.__archiveToggleBound) {
      container.addEventListener('click',event=>{
        const toggle=event.target.closest?.('.archive-group-toggle');
        if (!toggle || !container.contains(toggle)) return;
        const key=toggle.getAttribute('data-archive-key');
        const expanded=toggle.getAttribute('aria-expanded')!=='true';
        if (expanded) archiveExpandedObjects.add(key);
        else archiveExpandedObjects.delete(key);
        toggle.setAttribute('aria-expanded',String(expanded));
        const arrow=toggle.querySelector('.archive-group-arrow');
        if (arrow) arrow.textContent=expanded?'▾':'▸';
        const list=toggle.nextElementSibling;
        if (list?.classList.contains('archive-shifts-list')) list.hidden=!expanded;
      });
      container.__archiveToggleBound=true;
    }
    const q=(document.getElementById('archiveSearchInput').value||'').toLowerCase();
    const filtered=state.archive.filter(s=>s.date?.toLowerCase().includes(q)||objectTitle(s.objectId,s.objectName).toLowerCase().includes(q));
    if (!filtered.length){container.innerHTML='<div class="empty-state">Пусто</div>';renderTrash();return;}
    const groups=Object.create(null);
    filtered.forEach(shift=>{
      const name=objectTitle(shift.objectId,shift.objectName);
      if (!groups[name]) groups[name]=[];
      groups[name].push(shift);
    });
    container.innerHTML=Object.keys(groups).map((name,index)=>{
      const shifts=groups[name].sort((a,b)=>(b.closedAt||0)-(a.closedAt||0));
      const expanded=archiveExpandedObjects.has(name)||!!q;
      return `<div class="archive-group"><button type="button" class="archive-group-header archive-group-toggle" data-archive-key="${escapeHtml(name)}" aria-expanded="${expanded}" aria-controls="archive-shifts-${index}" style="width:100%;border:0;text-align:left;font-family:inherit;gap:10px;"><span class="archive-group-arrow" aria-hidden="true" style="min-width:14px;">${expanded?'▾':'▸'}</span><span style="min-width:0;flex:1;overflow-wrap:anywhere;">${escapeHtml(name)}</span></button><div class="archive-shifts-list" id="archive-shifts-${index}" ${expanded?'':'hidden'}>${shifts.map(s=>{
        const stdLogs=(s.logs||[]).filter(log=>!log.isGAI);
        return `<div class="archive-shift-item" onclick="openArchiveModal('${s.id}')"><div>${escapeHtml(s.date)}</div><div>${stdLogs.length} рейсов | <b>${stdLogs.reduce((sum,log)=>sum+log.volume,0)} м³</b></div></div>`;
      }).join('')}</div></div>`;
    }).join('');
    renderTrash();
    if (viewingArchiveId){
      const shift=state.archive.find(item=>item.id===viewingArchiveId);
      if (shift) openArchiveModal(viewingArchiveId); else closeArchiveModal();
    }
  }
  function renderTrash() { let c = document.getElementById('trashContainer'); if(!state.trash.length) { c.innerHTML=''; return; } let e = hasPermission('archive_edit'); c.innerHTML = `<div class="trash-group"><div class="trash-header">Корзина</div><div class="trash-list">${state.trash.map(i=>`<div class="trash-item"><div class="info"><b>${escapeHtml(objectTitle(i.shift.objectId,i.shift.objectName))}</b> · ${escapeHtml(i.shift.date)}</div>${e?`<button class="btn-del" onclick="purgeFromTrash('${i.id}')">X</button>`:''}</div>`).join('')}</div></div>`; }
  async function purgeFromTrash(id) { if(!requireEdit('archive_delete') || !(await appConfirm('Удалить навсегда?'))) return; try{if(isNasRuntime()){await nasArchiveAction('trash.purge',id);return;}await tfAwait(refs.trash.doc(id).delete());}catch(e){showError(e.message);} }
  function openArchiveModal(id) { let s = state.archive.find(x=>x.id===id); if(!s) return; viewingArchiveId=id; viewingArchiveGAITable = false; renderArchiveModalContent(s); document.getElementById('archiveModal').classList.add('open'); }
  function toggleArchiveReportType() { viewingArchiveGAITable = !viewingArchiveGAITable; let s = state.archive.find(x=>x.id===viewingArchiveId); if (s) renderArchiveModalContent(s); }
  function renderArchiveModalContent(s) {
    if (!hasTabAccess('archive')) return; // === SECURITY ===
    let logs = s.logs || []; let stdLogs = logs.filter(l=>!l.isGAI); let gaiLogs = logs.filter(l=>l.isGAI);
    let tV = stdLogs.reduce((x,y)=>x+y.volume,0);
    document.getElementById('modalArchiveTitle').textContent = s.date;
    let e = hasPermission('archive_edit');
    document.getElementById('archiveRestoreBtn').style.display = e?'':'none';
    document.getElementById('archiveDeleteBtn').style.display = hasPermission('archive_delete')?'':'none';
    let toggleBtnHtml = `<div class="archive-view-switch"><button type="button" class="archive-toggle-icon" aria-label="${viewingArchiveGAITable ? 'Обычный лист' : 'Лист ГАИ'}" title="${viewingArchiveGAITable ? 'Обычный лист' : 'Лист ГАИ'}" onclick="toggleArchiveReportType()">📄</button></div>`;
    let activeLineIds = s.activeLineIds || []; let ttnStatus = s.ttnStatus || {}; let html = '';
    if (!viewingArchiveGAITable) {
      let aIds = activeLineIds.filter(id => { let t = findTruck(id); return t && !t.isGAI; });
      let tIds = new Set(aIds); stdLogs.forEach(l=>tIds.add(l.truckId));
      let tks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?{id, name:f.brand+' '+f.number}:{id, name:(stdLogs.find(l=>l.truckId===id)?.truckName||'—')}; });
      let mT=8; tks.forEach(t=>{ let c=stdLogs.filter(l=>l.truckId===t.id).length; if(c>mT) mT=c; });
      let hC = ''; for(let i=1; i<=mT; i++) hC+=`<th>Рейс ${i}</th>`;
      let mH = tks.map(t=>{ let l = stdLogs.filter(x=>x.truckId===t.id).slice().reverse(), sm = l.reduce((x,y)=>x+y.volume,0), cells=''; let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (l.length > 0 && ttnStatus[t.id] !== true && ttnStatus[t.id] !== 'pending') : (l.length > 0 && !ttnStatus[t.id]); let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;" title="Дубликат" aria-label="Дубликат">D</span>' : '';
        for(let i=0; i<mT; i++) { if(l[i]) { let isL=(i===l.length-1), cH = ttnStatus[t.id] && isL ? '<div class="hand-drawn-circle"></div>':''; let commHtml = l[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l[i].comment)}</div>` : ''; cells += `<td><div class="cell-content">${cH}<div class="paper-time">${escapeHtml(l[i].timeStr)}</div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l[i].createdByEmail, l[i].createdBy))}</div>${commHtml}</div></td>`; }
          else if (i === l.length && ttnStatus[t.id] === 'pending') { cells += `<td><div class="cell-content"><div class="hand-drawn-circle"></div></div></td>`; }
          else cells += '<td></td>';
        } return `<tr><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.name)} <span class="paper-truck-volume">${sm} м³</span>${dupHtml}</div></td>${cells}</tr>`; }).join('');
      html = `<div style="position:relative;" id="archive-paper-wrapper"><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(objectTitle(s.objectId,s.objectName))}</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div><div class="paper-total-info">Объем: <b>${tV} м³</b></div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th>${hC}</tr></thead><tbody>${mH}</tbody></table></div></div></div>`;
    } else {
      let aIds = activeLineIds.filter(id => { let t = findTruck(id); return t && t.isGAI; });
      let tIds = new Set(aIds); gaiLogs.forEach(l=>tIds.add(l.truckId));
      let tks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?{id, name:f.brand+' '+f.number}:{id, name:(gaiLogs.find(l=>l.truckId===id)?.truckName||'—')}; });
      let mT=8; tks.forEach(t=>{ let c=gaiLogs.filter(l=>l.truckId===t.id).length; if(c>mT) mT=c; });
      let hC = ''; for(let i=1; i<=mT; i++) hC+=`<th>Рейс ${i}</th>`;
      let mH = tks.map(t=>{ let l = gaiLogs.filter(x=>x.truckId===t.id).slice().reverse(), cells=''; let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (l.length > 0 && ttnStatus[t.id] !== true && ttnStatus[t.id] !== 'pending') : (l.length > 0 && !ttnStatus[t.id]); let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;" title="Дубликат" aria-label="Дубликат">D</span>' : '';
        for(let i=0; i<mT; i++) { if(l[i]) { let commHtml = l[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l[i].comment)}</div>` : ''; cells += `<td><div class="cell-content"><div class="paper-time">${escapeHtml(l[i].timeStr)}</div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l[i].createdByEmail, l[i].createdBy))}</div>${commHtml}</div></td>`; }
          else cells += '<td></td>';
        } return `<tr><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.name)} <span class="paper-truck-volume">Рейсов: ${l.length}</span>${dupHtml}</div></td>${cells}</tr>`; }).join('');
      html = `<div style="position:relative;" id="archive-paper-wrapper"><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(objectTitle(s.objectId,s.objectName))} (ГАИ)</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div><div class="paper-total-info">Рейсов ГАИ: <b>${gaiLogs.length}</b></div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th>${hC}</tr></thead><tbody>${mH}</tbody></table></div></div></div>`;
    }
    document.getElementById('modalArchiveBody').innerHTML = toggleBtnHtml + html;
  }
  function closeArchiveModal() { document.getElementById('archiveModal').classList.remove('open'); viewingArchiveId=null; }
  async function restoreArchiveToShift() {
    if(state.shift?.closing){showError('Сначала завершите закрытие текущей смены');return;}
    if (!requireEdit('archive_edit') || !viewingArchiveId) return;
    const s = state.archive.find(x => x.id === viewingArchiveId); if (!s) return;
    if(isNasRuntime()){
      if(state.shift?.isActive){showError('Сначала закройте текущую смену и подтвердите перенос в табель. После этого можно восстановить архив.');return;}
      if(!(await appConfirm(`Восстановить смену «${objectTitle(s.objectId,s.objectName)}» от ${s.date}?`)))return;
      try{await nasArchiveAction('archive.restore',viewingArchiveId);closeArchiveModal();showToastEl('Смена восстановлена на Synology',false);}catch(error){showError('Ошибка восстановления: '+error.message);}return;
    }
    const hasActive = state.shift && state.shift.isActive;
    const msg = hasActive ? `Активная смена "${objectTitle(state.shift.objectId,state.shift.objectName)}" будет заменена.\n\nВосстановить "${objectTitle(s.objectId,s.objectName)}" от ${s.date}?` : `Восстановить смену "${objectTitle(s.objectId,s.objectName)}" от ${s.date}?`;
    if (!(await appConfirm(msg))) return;
    try {
      showToastEl('⏳ Восстановление...', false);
      await cleanupOldShiftData(); await clearAllNotifications();
      const newSid = 'shift_' + Date.now();
      await tfAwait(refs.shift.set({ id: newSid, objectName: objectTitle(s.objectId,s.objectName), objectId: s.objectId || '', startDate: s.date, startedAt: Date.now(), startedBy: getUserName(), isActive: true, restoredFrom: viewingArchiveId }));
      const batch = db.batch(); const logsByTruck = {};
      (s.logs || []).forEach((l, idx) => { const lid = `load_${l.truckId}_${newSid}_${l.timestamp || Date.now()}_${idx}`; batch.set(refs.logs.doc(lid), { shiftId: newSid, truckId: l.truckId, truckName: l.truckName, volume: l.volume, timeStr: l.timeStr, timestamp: l.timestamp, createdBy: l.createdBy, createdByEmail: l.createdByEmail || '', isGAI: !!l.isGAI, comment: l.comment || '' }); if (!logsByTruck[l.truckId]) logsByTruck[l.truckId] = []; logsByTruck[l.truckId].push({ id: lid, ts: l.timestamp || 0 }); });
      const allIds = new Set(); (s.activeLineIds || []).forEach(id => allIds.add(id)); (s.logs || []).forEach(l => allIds.add(l.truckId));
      allIds.forEach(id => { const truckLogs = (logsByTruck[id] || []).slice().sort((a, b) => a.ts - b.ts); const lastLog = truckLogs[truckLogs.length - 1]; let ttnStatus = null, ttnLogId = null; if (s.ttnStatus && s.ttnStatus[id]) { ttnStatus = true; ttnLogId = lastLog ? lastLog.id : null; } batch.set(refs.truckStatus.doc(id), { id, shiftId: newSid, onLine: true, addedBy: getUserName(), addedAt: Date.now(), arriveStatus: null, arriveTimestamp: null, arriveBy: null, ttnStatus, ttnBy: null, ttnLogId, lastLoadTimestamp: lastLog ? lastLog.ts : null, lastLoadBy: null, lastLoadLogId:lastLog?lastLog.id:null, cycleRevision:0, loadedAfterArrive: false }); });
      await tfAwait(batch.commit()); await tfAwait(refs.archive.doc(viewingArchiveId).delete());
      addAudit(`♻️ Смена восстановлена из архива: ${objectTitle(s.objectId,s.objectName)} (${s.date})`).catch(()=>{});
      closeArchiveModal(); showToastEl('✅ Смена восстановлена', false);
    } catch(e) { showError('Ошибка восстановления: ' + e.message); }
  }
  async function deleteArchiveShift() { if(!requireEdit('archive_delete') || !viewingArchiveId || !(await appConfirm('В корзину?'))) return; let s = state.archive.find(x=>x.id===viewingArchiveId); try { if(isNasRuntime()){await nasArchiveAction('archive.trash',viewingArchiveId);closeArchiveModal();return;}await tfAwait(refs.trash.doc().set({ shift: s, deletedAt: Date.now(), deletedBy: getUserName() })); await tfAwait(refs.archive.doc(viewingArchiveId).delete()); closeArchiveModal(); } catch(e){ showError(e.message); } }

  // === СЕЛЕКТОР ===
