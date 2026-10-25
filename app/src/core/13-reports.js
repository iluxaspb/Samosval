  // === ОТЧЕТ HTML ===
  function buildReportHTML({ objectName, date, logs, activeLineIds, type, checkTTN, isClosed = false, reportTtnStatus = null }) {
    const filteredLogs = type === 'gai' ? logs.filter(l => l.isGAI) : logs.filter(l => !l.isGAI);
    const activeIds = (activeLineIds || []).filter(id => { const t = findTruck(id); if (!t) return false; return type === 'gai' ? !!t.isGAI : !t.isGAI; });
    const truckIds = new Set(activeIds); filteredLogs.forEach(l => truckIds.add(l.truckId));
    const trucks = Array.from(truckIds).map(id => { const t = findTruck(id); if (t) return t; const ref = filteredLogs.find(l => l.truckId === id); return { id, brand: (ref && ref.truckName) || 'Машина', number: '', defaultVol: 0 }; });
    const firstTime = {}; filteredLogs.forEach(l => { if (firstTime[l.truckId] === undefined || l.timestamp < firstTime[l.truckId]) firstTime[l.truckId] = l.timestamp; });
    trucks.sort((a, b) => (firstTime[a.id] || 0) - (firstTime[b.id] || 0));
    let maxTrips = 8; trucks.forEach(t => { const c = filteredLogs.filter(l => l.truckId === t.id).length; if (c > maxTrips) maxTrips = c; });
    const totalVol = filteredLogs.reduce((s, l) => s + l.volume, 0);
    let html = `<div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(objectName || '—')}${type === 'gai' ? ' (ГАИ)' : ''}</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(date || '')}</div><div class="paper-total-info">${type === 'gai' ? `Всего рейсов ГАИ: <b>${filteredLogs.length}</b>` : `Общий объем: <b>${totalVol} м³</b>`}</div></div></div><table class="paper-table"><thead><tr><th>№</th><th style="text-align:left;">Самосвал</th>`;
    for (let i = 1; i <= maxTrips; i++) html += `<th>Рейс ${i}</th>`;
    html += `</tr></thead><tbody>`;
    trucks.forEach((t, idx) => {
      const tLogs = filteredLogs.filter(l => l.truckId === t.id).slice().reverse();
      const sum = tLogs.reduce((s, l) => s + l.volume, 0);
      let st = state.truckStatus[t.id] || {};
      let savedTtn = reportTtnStatus ? reportTtnStatus[t.id] : st.ttnStatus;
      let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (isClosed && tLogs.length > 0 && savedTtn !== true && savedTtn !== 'pending') : (tLogs.length > 0 && st.ttnStatus !== true);
      let dupHtml = isDup ? ' <span style="color:red; font-size:10px; font-weight:bold;">ДУБЛИКАТ</span>' : '';
      const brandCell = type === 'gai' ? `${escapeHtml(t.brand)} <span class="paper-truck-volume">Рейсов: ${tLogs.length}</span>${dupHtml}` : `${escapeHtml(t.brand)} <span class="paper-truck-volume">${sum} м³</span>${dupHtml}`;
      html += `<tr><td style="font-weight:bold;">${idx + 1}</td><td class="truck-cell"><div class="paper-truck-brand">${brandCell}</div>${t.number ? renderRussianPlate(t.number) : ''}</td>`;
      for (let i = 0; i < maxTrips; i++) {
        const l = tLogs[i];
        if (l) {
          const isLast = (i === tLogs.length - 1);
          const cH = (checkTTN && checkTTN(t.id, l.id, isLast)) ? '<div class="hand-drawn-circle"></div>' : '';
          let commHtml = l.comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l.comment)}</div>` : '';
          html += `<td><div class="cell-content">${cH}<div class="paper-time">${escapeHtml(l.timeStr)}</div><div class="paper-trip-num">${i + 1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l.createdByEmail, l.createdBy))}</div>${commHtml}</div></td>`;
        } else if (type !== 'gai' && i === tLogs.length && st.ttnStatus === 'pending') {
          let dotHtml = st.arriveStatus ? `<div class="paper-time">${escapeHtml(st.arriveStatus)}</div><div class="paper-dot">•</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(null, st.arriveBy))}</div>` : '';
          html += `<td><div class="cell-content"><div class="hand-drawn-circle"></div>${dotHtml}</div></td>`;
        } else if (type !== 'gai' && i === tLogs.length && st.arriveStatus) {
          html += `<td><div class="cell-content"><div class="paper-time">${escapeHtml(st.arriveStatus)}</div><div class="paper-dot">•</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(null, st.arriveBy))}</div></div></td>`;
        } else html += '<td></td>';
      }
      html += '</tr>';
    });
    html += `</tbody></table>`;
    return html;
  }

  async function sendShiftReportToMax(shift, logs) {
    const activeLineIds = getActiveLineIds(); const stdLogs = logs.filter(l => !l.isGAI); const gaiLogs = logs.filter(l => l.isGAI);
    const safeDate = String(shift.startDate || '').replace(/[^\w]/g, '_');
    if (stdLogs.length > 0 && appConfig.notifyPdfMain) {
      try {
        const html = buildReportHTML({ objectName: shift.objectName, date: shift.startDate, isClosed: true, logs: stdLogs, activeLineIds, type: 'regular', checkTTN: (id, logId) => state.truckStatus[id] && state.truckStatus[id].ttnStatus === true && state.truckStatus[id].ttnLogId === logId });
        const canvas = document.getElementById('draw-canvas-main'); let finalHtml = html;
        if (canvas) finalHtml = `<div style="position:relative;"><img src="${canvas.toDataURL()}" style="position:absolute; top:0; left:0; width:100%; height:100%; z-index:100; pointer-events:none;"><div style="position:relative; z-index:1;">${html}</div></div>`;
        const blob = await generatePDFFromHTML(finalHtml, 'report_regular.pdf'); const b64 = await blobToBase64(blob);
        enqueueMaxDocument(`report_regular_${safeDate}.pdf`, b64, `📊 Отчет (ОСНОВНЫЕ): ${shift.objectName} / ${shift.startDate}`, null, 0);
      } catch(e) { console.warn('PDF regular fail:', e); }
    }
    if (gaiLogs.length > 0 && appConfig.notifyPdfGai) {
      try {
        const html = buildReportHTML({ objectName: shift.objectName, date: shift.startDate, isClosed: true, logs: gaiLogs, activeLineIds, type: 'gai', checkTTN: null });
        const canvas = document.getElementById('draw-canvas-gai'); let finalHtml = html;
        if (canvas) finalHtml = `<div style="position:relative;"><img src="${canvas.toDataURL()}" style="position:absolute; top:0; left:0; width:100%; height:100%; z-index:100; pointer-events:none;"><div style="position:relative; z-index:1;">${html}</div></div>`;
        const blob = await generatePDFFromHTML(finalHtml, 'report_gai.pdf'); const b64 = await blobToBase64(blob);
        enqueueMaxDocument(`report_gai_${safeDate}.pdf`, b64, `📊 Отчет (ГАИ): ${shift.objectName} / ${shift.startDate}`, null, Date.now() + GAI_PDF_DELAY_MS);
      } catch(e) { console.warn('PDF gai fail:', e); }
    }
  }

  async function exportCurrentReportPDF(type) {
    if (!state.shift) { showError('Смена не начата'); return; }
    if (type === 'gai' && !hasPermission('view_gai_report')) { showError('Нет прав'); return; }
    const logs = getLogs().filter(l => type === 'gai' ? l.isGAI : !l.isGAI);
    if (!logs.length) { showError('Нет данных'); return; }
    try {
      showToastEl('⏳ Генерация PDF...', false);
      const html = buildReportHTML({ objectName: state.shift.objectName, date: state.shift.startDate, logs, activeLineIds: getActiveLineIds(), type, checkTTN: type === 'regular' ? (id, logId) => state.truckStatus[id] && state.truckStatus[id].ttnStatus === true && state.truckStatus[id].ttnLogId === logId : null });
      const canvas = document.getElementById(type === 'gai' ? 'draw-canvas-gai' : 'draw-canvas-main'); let finalHtml = html;
      if (canvas) finalHtml = `<div style="position:relative;"><img src="${canvas.toDataURL()}" style="position:absolute; top:0; left:0; width:100%; height:100%; z-index:100; pointer-events:none;"><div style="position:relative; z-index:1;">${html}</div></div>`;
      const blob = await generatePDFFromHTML(finalHtml, `report_${type}.pdf`); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `report_${type}_${Date.now()}.pdf`; a.click(); URL.revokeObjectURL(url); showToastEl('✅ PDF готов', false);
    } catch(e) { showError('Ошибка PDF: ' + e.message); }
  }
  async function sendActiveReportToMax() {
    if (!state.shift) { showError('Смена не начата'); return; }
    if (!appConfig.maxEnabled || !appConfig.maxUrl) { showError('Max не настроен'); return; }
    const type = showGAITable ? 'gai' : 'regular';
    const logs = getLogs().filter(l => type === 'gai' ? l.isGAI : !l.isGAI);
    if (!logs.length) { showError('Нет данных для отчета'); return; }
    showToastEl('⏳ Генерация PDF для Max...', false);
    try {
      const html = buildReportHTML({ objectName: state.shift.objectName, date: state.shift.startDate, logs, activeLineIds: getActiveLineIds(), type, checkTTN: type === 'regular' ? (id, logId) => state.truckStatus[id] && state.truckStatus[id].ttnStatus === true && state.truckStatus[id].ttnLogId === logId : null });
      const canvas = document.getElementById(type === 'gai' ? 'draw-canvas-gai' : 'draw-canvas-main'); let finalHtml = html;
      if (canvas) finalHtml = `<div style="position:relative;"><img src="${canvas.toDataURL()}" style="position:absolute; top:0; left:0; width:100%; height:100%; z-index:100; pointer-events:none;"><div style="position:relative; z-index:1;">${html}</div></div>`;
      const blob = await generatePDFFromHTML(finalHtml, `report_${type}.pdf`); const b64 = await blobToBase64(blob);
      const safeDate = String(state.shift.startDate || '').replace(/[^\w]/g, '_');
      enqueueMaxDocument(`report_${type}_${safeDate}.pdf`, b64, `📊 Отчет (${type === 'gai' ? 'ГАИ' : 'ОСНОВНЫЕ'}): ${state.shift.objectName} / ${state.shift.startDate}`, null, 0);
      showToastEl('✅ PDF в очереди Max', false);
    } catch(e) { showError('Ошибка: ' + e.message); }
  }
  async function exportArchivePDF() {
    const s = state.archive.find(x => x.id === viewingArchiveId); if (!s) return;
    const type = viewingArchiveGAITable ? 'gai' : 'regular';
    const logs = (s.logs || []).filter(l => type === 'gai' ? l.isGAI : !l.isGAI); if (!logs.length) { showError('Нет данных'); return; }
    try {
      showToastEl('⏳ Генерация PDF...', false);
      const html = buildReportHTML({ objectName: s.objectName, date: s.date, logs, activeLineIds: s.activeLineIds || [], type, isClosed: true, reportTtnStatus: s.ttnStatus || {}, checkTTN: type === 'regular' ? (id, logId, isLast) => s.ttnStatus && s.ttnStatus[id] && isLast : null });
      const canvas = document.getElementById('draw-canvas-archive'); let finalHtml = html;
      if (canvas) finalHtml = `<div style="position:relative;"><img src="${canvas.toDataURL()}" style="position:absolute; top:0; left:0; width:100%; height:100%; z-index:100; pointer-events:none;"><div style="position:relative; z-index:1;">${html}</div></div>`;
      const blob = await generatePDFFromHTML(finalHtml, `archive_${type}.pdf`); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `archive_${type}.pdf`; a.click(); URL.revokeObjectURL(url); showToastEl('✅ PDF готов', false);
    } catch(e) { showError('Ошибка PDF: ' + e.message); }
  }

  // === ОТЧЕТЫ РЕНДЕР ===
  function renderReport() {
    if (!hasTabAccess('report')) return; // === SECURITY ===
    if (!hasPermission('view_gai_report')) showGAITable = false;
    let pO = document.getElementById('paperObjectName'), pD = document.getElementById('paperDateTitle'), pV = document.getElementById('paperTotalVolume');
    let mB = document.getElementById('matrixTableBody'), mH = document.getElementById('matrixTableHeadRow'), lC = document.getElementById('logsContainer');
    let gaiO = document.getElementById('gaiObjectName'), gaiD = document.getElementById('gaiDateTitle'), gaiV = document.getElementById('gaiTotalTrips');
    let gaiB = document.getElementById('gaiTableBody'), gaiH = document.getElementById('gaiTableHeadRow');
    document.getElementById('paperReportWrapper').style.display = showGAITable ? 'none' : 'block';
    document.getElementById('gaiReportWrapper').style.display = showGAITable ? 'block' : 'none';
    document.getElementById('toggleReportBtn').textContent = '📄';
    pO.textContent = 'Объект: ' + (state.shift ? state.shift.objectName : '—'); pD.textContent = state.shift ? state.shift.startDate : '';
    gaiO.textContent = 'Объект: ' + (state.shift ? state.shift.objectName : '—'); gaiD.textContent = state.shift ? state.shift.startDate : '';
    if (!state.shift) { mB.innerHTML = '<tr><td colspan="11" style="text-align:center;">Нет смены</td></tr>'; gaiB.innerHTML = '<tr><td colspan="11" style="text-align:center;">Нет смены</td></tr>'; lC.innerHTML = '<div class="empty-state">Нет рейсов</div>'; pV.textContent='0 м³'; gaiV.textContent='0'; return; }
    let logs = getLogs(); let stdLogs = logs.filter(l=>!l.isGAI); let gaiLogs = logs.filter(l=>l.isGAI);
    let totV = stdLogs.reduce((s,l)=>s+l.volume,0); pV.textContent = totV + ' м³';
    let aIds = getActiveLineIds().filter(id => { let t = findTruck(id); return t && !t.isGAI; });
    let tIds = new Set(aIds); stdLogs.forEach(l=>tIds.add(l.truckId));
    let rTrucks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?f:{id, brand:'Машина', number:'', defaultVol:0}; });
    let fTime = {}; stdLogs.forEach(l=>{ if(fTime[l.truckId]===undefined || l.timestamp<fTime[l.truckId]) fTime[l.truckId]=l.timestamp; });
    rTrucks.sort((a,b)=> (fTime[a.id]||0) - (fTime[b.id]||0));
    let maxT = 8; rTrucks.forEach(t=>{ let c=stdLogs.filter(l=>l.truckId===t.id).length; if(c>maxT) maxT=c; });
    let hHtml = '<th>№</th><th style="text-align:left;">Самосвал</th>'; for(let i=1; i<=maxT; i++) hHtml += `<th>Рейс ${i}</th>`; mH.innerHTML = hHtml;
    mB.innerHTML = rTrucks.map((t, idx)=>{
      let tL = stdLogs.filter(l=>l.truckId===t.id).slice().reverse(), st = state.truckStatus[t.id]||{}, sum = tL.reduce((s,l)=>s+l.volume,0);
      let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? false : (tL.length > 0 && st.ttnStatus !== true);
      let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;">ДУБЛИКАТ</span>' : '';
      let cells = '';
      for(let i=0; i<maxT; i++) {
        if(tL[i]) {
          let cH = (st.ttnStatus === true && st.ttnLogId === tL[i].id) ? '<div class="hand-drawn-circle"></div>' : '';
          let commHtml = tL[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(tL[i].comment)}</div>` : '';
          cells += `<td><div class="cell-content">${cH}<div class="paper-time">${escapeHtml(tL[i].timeStr)}${tL[i].offlinePending?` <span title="Рейс сохранён на устройстве" style="color:#d97706;font-size:10px">☁</span>`:''} </div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(tL[i].createdByEmail, tL[i].createdBy))}</div>${commHtml}</div></td>`;
        }
        else if(i===tL.length && st.ttnStatus === 'pending') {
          let dotHtml = st.arriveStatus ? `<div class="paper-time">${escapeHtml(st.arriveStatus)}</div><div class="paper-dot">•</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(null, st.arriveBy))}</div>` : '';
          cells += `<td><div class="cell-content"><div class="hand-drawn-circle"></div>${dotHtml}</div></td>`;
        }
        else if(i===tL.length && st.arriveStatus) cells += `<td><div class="cell-content"><div class="paper-time">${escapeHtml(st.arriveStatus)}</div><div class="paper-dot">•</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(null, st.arriveBy))}</div></div></td>`;
        else cells += '<td></td>';
      }
      return `<tr><td style="font-weight:bold;">${idx+1}</td><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.brand)} <span class="paper-truck-volume">${sum} м³</span>${dupHtml}</div>${t.number?renderRussianPlate(t.number):''}</td>${cells}</tr>`;
    }).join('');
    gaiV.textContent = gaiLogs.length;
    let gaiLineIds = getActiveLineIds().filter(id => { let t = findTruck(id); return t && t.isGAI; });
    let gaiTIds = new Set(gaiLineIds); gaiLogs.forEach(l=>gaiTIds.add(l.truckId));
    let gaiTrucks = Array.from(gaiTIds).map(id=>{ let f=findTruck(id); return f?f:{id, brand:'Машина', number:'', defaultVol:0}; });
    let gaiFirstTime = {}; gaiLogs.forEach(l=>{ if(gaiFirstTime[l.truckId]===undefined || l.timestamp<gaiFirstTime[l.truckId]) gaiFirstTime[l.truckId]=l.timestamp; });
    gaiTrucks.sort((a,b)=> (gaiFirstTime[a.id]||0) - (gaiFirstTime[b.id]||0));
    let gaiMaxT = 8; gaiTrucks.forEach(t=>{ let c=gaiLogs.filter(l=>l.truckId===t.id).length; if(c>gaiMaxT) gaiMaxT=c; });
    let gaiHHtml = '<th>№</th><th style="text-align:left;">Самосвал</th>'; for(let i=1; i<=gaiMaxT; i++) gaiHHtml += `<th>Рейс ${i}</th>`; gaiH.innerHTML = gaiHHtml;
    gaiB.innerHTML = gaiTrucks.map((t, idx)=>{
      let tL = gaiLogs.filter(l=>l.truckId===t.id).slice().reverse();
      let st = state.truckStatus[t.id] || {};
      let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? false : (tL.length > 0 && st.ttnStatus !== true);
      let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;">ДУБЛИКАТ</span>' : '';
      let cells = '';
      for(let i=0; i<gaiMaxT; i++) {
        if(tL[i]) {
          let commHtml = tL[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(tL[i].comment)}</div>` : '';
          cells += `<td><div class="cell-content"><div class="paper-time">${escapeHtml(tL[i].timeStr)}${tL[i].offlinePending?` <span title="Рейс сохранён на устройстве" style="color:#d97706;font-size:10px">☁</span>`:''} </div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(tL[i].createdByEmail, tL[i].createdBy))}</div>${commHtml}</div></td>`;
        }
        else cells += '<td></td>';
      }
      return `<tr><td style="font-weight:bold;">${idx+1}</td><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.brand)} <span class="paper-truck-volume">Рейсов: ${tL.length}</span>${dupHtml}</div>${t.number?renderRussianPlate(t.number):''}</td>${cells}</tr>`;
    }).join('');
    let canEditL = hasPermission('edit_logs');
    lC.innerHTML = logs.length === 0 ? '<div class="empty-state">Нет рейсов</div>' : logs.map(l=>{
      let a = resolveUserDisplayName(l.createdByEmail, l.createdBy); let au = a ? ` · 👤 ${escapeHtml(a)}` : '';
      let volHtml = l.isGAI ? '<span style="color:#94a3b8;">(Рейс)</span>' : `<span style="color:var(--success);">+${l.volume} м³</span>`;
      let commHtml = l.comment ? `<div class="log-comment">💬 ${escapeHtml(l.comment)}</div>` : '';
      return `<div class="log-item"><div><div class="log-info">${truckLabelHtml(l.truckId, l.truckName)} — ${volHtml}</div><div class="log-meta">${escapeHtml(l.timeStr)}${au}${l.offlinePending?' · ☁️ офлайн':''}</div>${commHtml}</div>${canEditL&&!l.offlinePending?`<div style="display:flex;gap:6px;"><button class="btn-edit" onclick="openEditLog('${l.id}')">✏️</button><button class="btn-del" onclick="deleteLog('${l.id}')">X</button></div>`:''}</div>`;
    }).join('');
    setTimeout(() => { setupStylus('draw-canvas-main', 'paperReportContainer'); setupStylus('draw-canvas-gai', 'gaiPaperContainer'); }, 50);
  }
  function toggleReportType() { if (!hasPermission('view_gai_report')) { showError('Нет прав'); return; } showGAITable = !showGAITable; renderReport(); }
  function openEditLog(id) { if(!requireEdit('edit_logs')) return; let l=state.logs.find(x=>x.id===id); if(!l) return; editingLogId=id; document.getElementById('editLogTruckInfo').innerHTML=`<b>${escapeHtml(l.truckName)}</b>`; document.getElementById('editLogVolume').value=l.volume; document.getElementById('editLogTime').value=l.timeStr; document.getElementById('editLogComment').value=l.comment || ''; document.getElementById('editLogModal').classList.add('open'); }
  function closeEditLogModal() { document.getElementById('editLogModal').classList.remove('open'); editingLogId=null; }
  async function saveLogEdit() {
    if(!requireEdit('edit_logs') || !editingLogId) return;
    let l=state.logs.find(x=>x.id===editingLogId); if(!l) return closeEditLogModal();
    let v=parseFloat(document.getElementById('editLogVolume').value); let t=document.getElementById('editLogTime').value; let comm=document.getElementById('editLogComment').value.trim();
    if(isNaN(v)||v<0 || !/^\d{2}:\d{2}$/.test(t)) { appNotice('Проверьте правильность ввода объема и времени (ЧЧ:ММ)'); return; }
    let ts=l.timestamp; if(ts){ let d=new Date(ts), p=t.split(':'); d.setHours(p[0],p[1],0,0); ts=d.getTime(); }
    const logIdToSave = editingLogId;
    Object.assign(l, {volume:v, timeStr:t, timestamp:ts, comment:comm}); saveCache(); renderReport(); closeEditLogModal();
    tf((async()=>{ await refs.logs.doc(logIdToSave).update({volume:v, timeStr:t, timestamp:ts, comment:comm}); await addAudit('✏️ Изменён рейс: ' + l.truckName + ' · ' + v + ' м³ · ' + t, {eventType:'log_edit',logId:logIdToSave,truckId:l.truckId}); })());
    showToastEl('✅ Рейс обновлен', false);
  }
  async function deleteLog(id) { if(!requireEdit('edit_logs') || !(await appConfirm('Удалить?'))) return; state.logs=state.logs.filter(x=>x.id!==id); saveCache(); renderReport(); tf(refs.logs.doc(id).delete()); }

  function exportCSV() {
    if (!state.shift) return;
    let logs = getLogs(); if(!logs.length) return;
    let targetLogs = showGAITable ? logs.filter(l=>l.isGAI) : logs.filter(l=>!l.isGAI);
    let a = getActiveLineIds().filter(id => { let t = findTruck(id); return t && (showGAITable ? t.isGAI : !t.isGAI); });
    let rT = a.map(id=>findTruck(id)).filter(Boolean);
    let fT = {}; targetLogs.forEach(l=>{ if(fT[l.truckId]===undefined || l.timestamp<fT[l.truckId]) fT[l.truckId]=l.timestamp; });
    rT.sort((a,b)=>(fT[a.id]||0)-(fT[b.id]||0));
    let mT = 8; rT.forEach(t=>{ let c=targetLogs.filter(l=>l.truckId===t.id).length; if(c>mT) mT=c; });
    let csv = '\uFEFFsep=;\n';
    if (showGAITable) {
      csv += '№;Самосвал;Всего рейсов;'; for(let i=1; i<=mT; i++) csv+=`Рейс ${i};`; csv+='\n';
      rT.forEach((t, i)=>{ let tL = targetLogs.filter(l=>l.truckId===t.id).slice().reverse(); csv += `${i+1};"${t.brand} ${t.number}";${tL.length};`; for(let j=0; j<mT; j++) csv += tL[j] ? `${tL[j].timeStr}/${j+1}${tL[j].comment?'('+tL[j].comment+')':''};` : '-;'; csv += '\n'; });
    } else {
      csv += '№;Самосвал;Всего рейсов;Всего м3;'; for(let i=1; i<=mT; i++) csv+=`Рейс ${i};`; csv+='\n';
      rT.forEach((t, i)=>{ let tL = targetLogs.filter(l=>l.truckId===t.id).slice().reverse(), s = tL.reduce((x,l)=>x+l.volume,0); csv += `${i+1};"${t.brand} ${t.number}";${tL.length};${s};`; for(let j=0; j<mT; j++) csv += tL[j] ? `${tL[j].timeStr}/${j+1}${tL[j].comment?'('+tL[j].comment+')':''};` : '-;'; csv += '\n'; });
    }
    let b = new Blob([csv], {type:'text/csv;charset=utf-8;'}), u=URL.createObjectURL(b), aE=document.createElement('a');
    aE.href=u; aE.download= showGAITable ? 'report_gai.csv' : 'report.csv'; aE.click(); URL.revokeObjectURL(u);
    showToastEl('Скачан Excel', false);
  }

