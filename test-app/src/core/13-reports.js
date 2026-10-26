  // Report totals never concatenate untrusted numeric strings or hide corrupt values as zero.
  function reportVolumeNumber(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return NaN;
    if (typeof value === 'string' && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return NaN;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  }
  function reportVolumeTotal(logs) { return logs.reduce((sum, log) => sum + reportVolumeNumber(log.volume), 0); }
  function reportVolumeLabel(value) { return Number.isFinite(value) ? String(value) : '⚠ некорректный объём'; }
  function reportLogsByTruck(logs) {
    const groups = new Map();
    for (const log of logs) { if (!groups.has(log.truckId)) groups.set(log.truckId, []); groups.get(log.truckId).push(log); }
    return groups;
  }
  function reportActionId(value) { return encodeURIComponent(String(value)).replace(/'/g, '%27'); }
  function reportCsvCell(value) {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  // === ОТЧЕТ HTML ===
  function buildReportHTML({ objectName, date, logs, activeLineIds, type, checkTTN, isClosed = false, reportTtnStatus = null }) {
    const filteredLogs = type === 'gai' ? logs.filter(l => l.isGAI) : logs.filter(l => !l.isGAI);
    const groupedLogs = reportLogsByTruck(filteredLogs);
    const activeIds = (activeLineIds || []).filter(id => { const t = findTruck(id); if (!t) return false; return type === 'gai' ? !!t.isGAI : !t.isGAI; });
    const truckIds = new Set(activeIds); filteredLogs.forEach(l => truckIds.add(l.truckId));
    const trucks = Array.from(truckIds).map(id => { const t = findTruck(id); if (t) return t; const ref = groupedLogs.get(id)?.[0]; return { id, brand: (ref && ref.truckName) || 'Машина', number: '', defaultVol: 0 }; });
    const firstTime = Object.create(null); filteredLogs.forEach(l => { if (firstTime[l.truckId] === undefined || l.timestamp < firstTime[l.truckId]) firstTime[l.truckId] = l.timestamp; });
    trucks.sort((a, b) => (firstTime[a.id] || 0) - (firstTime[b.id] || 0));
    let maxTrips = 8; trucks.forEach(t => { const c = (groupedLogs.get(t.id) || []).length; if (c > maxTrips) maxTrips = c; });
    const totalVol = reportVolumeLabel(reportVolumeTotal(filteredLogs));
    let html = `<div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(objectName || '—')}${type === 'gai' ? ' (ГАИ)' : ''}</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(date || '')}</div><div class="paper-total-info">${type === 'gai' ? `Всего рейсов ГАИ: <b>${filteredLogs.length}</b>` : `Общий объем: <b>${totalVol} м³</b>`}</div></div></div><table class="paper-table"><thead><tr><th>№</th><th style="text-align:left;">Самосвал</th>`;
    for (let i = 1; i <= maxTrips; i++) html += `<th>Рейс ${i}</th>`;
    html += `</tr></thead><tbody>`;
    trucks.forEach((t, idx) => {
      const tLogs = (groupedLogs.get(t.id) || []).slice().reverse();
      const sum = reportVolumeLabel(reportVolumeTotal(tLogs));
      let st = isClosed ? { ttnStatus: reportTtnStatus?.[t.id] } : (state.truckStatus[t.id] || {});
      let savedTtn = reportTtnStatus ? reportTtnStatus[t.id] : st.ttnStatus;
      let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (isClosed && tLogs.length > 0 && savedTtn !== true && savedTtn !== 'pending') : (tLogs.length > 0 && st.ttnStatus !== true);
      let dupHtml = isDup ? ' <span style="color:red; font-size:10px; font-weight:bold;" title="Дубликат" aria-label="Дубликат">D</span>' : '';
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

  async function exportCurrentReportPNG(type) {
    if (!hasTabAccess('report')) { showError('Нет прав'); return; }
    if (!state.shift) { showError('Смена не начата'); return; }
    if (type === 'gai' && !hasPermission('view_gai_report')) { showError('Нет прав'); return; }
    const logs = getLogs().filter(l => type === 'gai' ? l.isGAI : !l.isGAI);
    if (!logs.length) { showError('Нет данных'); return; }
    try {
      showToastEl('⏳ Подготовка PNG...', false);
      const html = buildReportHTML({ objectName: state.shift.objectName, date: state.shift.startDate, logs, activeLineIds: getActiveLineIds(), type, checkTTN: type === 'regular' ? (id, logId) => state.truckStatus[id] && state.truckStatus[id].ttnStatus === true && state.truckStatus[id].ttnLogId === logId : null });
      const finalHtml = html;
      const blob = await generatePNGFromHTML(finalHtml); downloadReportPNG(blob, `report_${type}_${Date.now()}.png`); showToastEl('✅ PNG готов', false);
    } catch(e) { showError('Ошибка PNG: ' + e.message); }
  }
  async function exportArchivePNG() {
    // Keep the current archive snapshot/full-width export, not a differently sorted rebuild.
    return await saveArchivePNG();
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
    const stdGrouped = reportLogsByTruck(stdLogs), gaiGrouped = reportLogsByTruck(gaiLogs);
    let totV = reportVolumeLabel(reportVolumeTotal(stdLogs)); pV.textContent = totV + ' м³';
    let aIds = getActiveLineIds().filter(id => { let t = findTruck(id); return t && !t.isGAI; });
    let tIds = new Set(aIds); stdLogs.forEach(l=>tIds.add(l.truckId));
    let rTrucks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?f:{id, brand:stdGrouped.get(id)?.[0]?.truckName||'Машина', number:'', defaultVol:0}; });
    let fTime = Object.create(null); stdLogs.forEach(l=>{ if(fTime[l.truckId]===undefined || l.timestamp<fTime[l.truckId]) fTime[l.truckId]=l.timestamp; });
    rTrucks.sort((a,b)=> (fTime[a.id]||0) - (fTime[b.id]||0));
    let maxT = 8; rTrucks.forEach(t=>{ let c=(stdGrouped.get(t.id)||[]).length; if(c>maxT) maxT=c; });
    let hHtml = '<th>№</th><th style="text-align:left;">Самосвал</th>'; for(let i=1; i<=maxT; i++) hHtml += `<th>Рейс ${i}</th>`; mH.innerHTML = hHtml;
    mB.innerHTML = rTrucks.map((t, idx)=>{
      let tL = (stdGrouped.get(t.id)||[]).slice().reverse(), st = state.truckStatus[t.id]||{}, sum = reportVolumeLabel(reportVolumeTotal(tL));
      let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? false : (tL.length > 0 && st.ttnStatus !== true);
      let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;" title="Дубликат" aria-label="Дубликат">D</span>' : '';
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
    let gaiTrucks = Array.from(gaiTIds).map(id=>{ let f=findTruck(id); return f?f:{id, brand:gaiGrouped.get(id)?.[0]?.truckName||'Машина', number:'', defaultVol:0}; });
    let gaiFirstTime = Object.create(null); gaiLogs.forEach(l=>{ if(gaiFirstTime[l.truckId]===undefined || l.timestamp<gaiFirstTime[l.truckId]) gaiFirstTime[l.truckId]=l.timestamp; });
    gaiTrucks.sort((a,b)=> (gaiFirstTime[a.id]||0) - (gaiFirstTime[b.id]||0));
    let gaiMaxT = 8; gaiTrucks.forEach(t=>{ let c=(gaiGrouped.get(t.id)||[]).length; if(c>gaiMaxT) gaiMaxT=c; });
    let gaiHHtml = '<th>№</th><th style="text-align:left;">Самосвал</th>'; for(let i=1; i<=gaiMaxT; i++) gaiHHtml += `<th>Рейс ${i}</th>`; gaiH.innerHTML = gaiHHtml;
    gaiB.innerHTML = gaiTrucks.map((t, idx)=>{
      let tL = (gaiGrouped.get(t.id)||[]).slice().reverse();
      let st = state.truckStatus[t.id] || {};
      let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? false : (tL.length > 0 && st.ttnStatus !== true);
      let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;" title="Дубликат" aria-label="Дубликат">D</span>' : '';
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
      let volHtml = l.isGAI ? '<span style="color:#94a3b8;">(Рейс)</span>' : `<span style="color:var(--success);">+${reportVolumeLabel(reportVolumeNumber(l.volume))} м³</span>`;
      let commHtml = l.comment ? `<div class="log-comment">💬 ${escapeHtml(l.comment)}</div>` : '';
      return `<div class="log-item"><div><div class="log-info">${truckLabelHtml(l.truckId, l.truckName)} — ${volHtml}</div><div class="log-meta">${escapeHtml(l.timeStr)}${au}${l.offlinePending?' · ☁️ офлайн':''}</div>${commHtml}</div>${canEditL&&!l.offlinePending?`<div style="display:flex;gap:6px;"><button class="btn-edit" onclick="openEditLog(decodeURIComponent('${reportActionId(l.id)}'))">✏️</button><button class="btn-del" onclick="deleteLog(decodeURIComponent('${reportActionId(l.id)}'))">X</button></div>`:''}</div>`;
    }).join('');
  }
  function toggleReportType() { if (!hasPermission('view_gai_report')) { showError('Нет прав'); return; } showGAITable = !showGAITable; renderReport(); }
  let editingLogOriginal = null;
  let logEditInFlight = false;
  function logEditSnapshot(log) {
    return { shiftId: log.shiftId, truckId: log.truckId, volume: log.volume, timeStr: log.timeStr, timestamp: log.timestamp, comment: log.comment || '' };
  }
  function openEditLog(id) {
    if (!requireEdit('edit_logs')) return;
    const log = state.logs.find(x => x.id === id);
    if (!log || log.offlinePending) return;
    editingLogId = id; editingLogOriginal = logEditSnapshot(log);
    document.getElementById('editLogTruckInfo').innerHTML = `<b>${escapeHtml(log.truckName)}</b>`;
    document.getElementById('editLogVolume').value = log.volume;
    document.getElementById('editLogTime').value = log.timeStr;
    document.getElementById('editLogComment').value = log.comment || '';
    document.getElementById('editLogModal').classList.add('open');
  }
  function closeEditLogModal() { document.getElementById('editLogModal').classList.remove('open'); editingLogId = null; editingLogOriginal = null; }
  async function commitReportLogChange(logId, before, changes) {
    const uid = currentUid;
    if (!before?.shiftId || before.shiftId !== state.shift?.id) throw Error('Рейс относится к другой смене. Обновите страницу.');
    return await tfAwait(db.runTransaction(async tx => {
      const shift = await tx.get(refs.shift), ref = refs.logs.doc(logId), log = await tx.get(ref);
      if (currentUid !== uid || !requireEdit('edit_logs')) throw Error('Учётная запись или права изменились.');
      if (!shift.exists || shift.data().id !== before.shiftId || !shift.data().isActive || shift.data().closing || shift.data().restoring)
        throw Error('Смена закрывается, восстанавливается или уже изменилась. Рейс не изменён.');
      if (!log.exists) throw Error('Рейс уже удалён. Обновите отчёт.');
      if (JSON.stringify(logEditSnapshot(log.data())) !== JSON.stringify(before))
        throw Error('Рейс изменён другим пользователем. Откройте его заново.');
      if (changes) tx.update(ref, changes); else tx.delete(ref);
    }));
  }
  async function saveLogEdit() {
    if (!requireEdit('edit_logs') || !editingLogId || logEditInFlight) return;
    const logId = editingLogId, log = state.logs.find(x => x.id === logId);
    if (!log || log.offlinePending) return closeEditLogModal();
    const before = editingLogOriginal || logEditSnapshot(log);
    const volumeInput = document.getElementById('editLogVolume').value, volume = Number(volumeInput), timeStr = document.getElementById('editLogTime').value;
    const comment = document.getElementById('editLogComment').value.trim();
    if (!String(volumeInput).trim() || !Number.isFinite(volume) || volume < 0 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timeStr)) { appNotice('Проверьте правильность ввода объема и времени (ЧЧ:ММ)'); return; }
    let timestamp = before.timestamp;
    if (timestamp) { const date = new Date(timestamp), parts = timeStr.split(':'); date.setHours(Number(parts[0]), Number(parts[1]), 0, 0); timestamp = date.getTime(); }
    const changes = { volume, timeStr, comment }; if (timestamp !== undefined) changes.timestamp = timestamp;
    logEditInFlight = true;
    try {
      await commitReportLogChange(logId, before, changes);
      // Firestore subscriptions are the source of truth; failed writes never change the local report.
      if (editingLogId === logId) closeEditLogModal();
      showToastEl('✅ Рейс обновлен', false);
      addAudit('✏️ Изменён рейс: ' + log.truckName + ' · ' + volume + ' м³ · ' + timeStr, { eventType:'log_edit', logId, truckId:log.truckId, shiftId:before.shiftId }).catch(() => {});
    } catch(e) { showError(e.message); }
    finally { logEditInFlight = false; }
  }
  async function deleteLog(id) {
    if (!requireEdit('edit_logs')) return;
    const log = state.logs.find(x => x.id === id); if (!log || log.offlinePending) return;
    const before = logEditSnapshot(log);
    if (!(await appConfirm('Удалить?'))) return;
    try { await commitReportLogChange(id, before, null); showToastEl('Рейс удалён', false); }
    catch(e) { showError(e.message); }
  }

  function exportCSV() {
    if (!hasTabAccess('report') || !state.shift) return;
    if (showGAITable && !hasPermission('view_gai_report')) { showError('Нет прав'); return; }
    const logs = getLogs().filter(l => showGAITable ? l.isGAI : !l.isGAI);
    if (!logs.length) return;
    const grouped = reportLogsByTruck(logs);
    const active = getActiveLineIds().filter(id => { const t = findTruck(id); return t && (showGAITable ? t.isGAI : !t.isGAI); });
    const ids = Array.from(new Set([...active, ...grouped.keys()]));
    const firstTimes = new Map(); let maxTrips = 8;
    for (const [id, rows] of grouped) { let first = Infinity; for (const log of rows) first = Math.min(first, Number(log.timestamp) || 0); firstTimes.set(id, first); maxTrips = Math.max(maxTrips, rows.length); }
    ids.sort((a,b) => (firstTimes.get(a) || 0) - (firstTimes.get(b) || 0));
    const header = ['№', 'Самосвал', 'Всего рейсов', ...(showGAITable ? [] : ['Всего м3']), ...Array.from({length:maxTrips}, (_,i) => 'Рейс ' + (i+1))];
    const rows = [header];
    ids.forEach((id,index) => {
      const own = (grouped.get(id) || []).slice().reverse();
      const truck = findTruck(id), name = truck ? [truck.brand,truck.number].filter(Boolean).join(' ') : own[0]?.truckName || 'Машина';
      const row = [index+1, name, own.length, ...(showGAITable ? [] : [reportVolumeLabel(reportVolumeTotal(own))])];
      for (let i=0;i<maxTrips;i++) row.push(own[i] ? String(own[i].timeStr || '') + '/' + (i+1) + (own[i].comment ? '(' + own[i].comment + ')' : '') : '-');
      rows.push(row);
    });
    const csv = '\uFEFFsep=;\n' + rows.map(row => row.map(reportCsvCell).join(';')).join('\n') + '\n';
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'}), url = URL.createObjectURL(blob), link=document.createElement('a');
    link.href=url;link.download=showGAITable?'report_gai.csv':'report.csv';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    showToastEl('Скачан Excel',false);
  }
