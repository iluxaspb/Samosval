  // === АРХИВ ===
  const archiveExpandedObjects = new Set();
  let archiveExpandedInitialized = false;
  function toggleArchiveSearch() {
    const input=document.getElementById('archiveSearchInput'), button=document.getElementById('archiveSearchToggle');
    if(!input||!button)return;
    const opening=input.style.display==='none';
    input.style.display=opening?'block':'none';
    button.setAttribute('aria-expanded',String(opening));
    if(opening)input.focus();
    else {input.value='';renderArchive();}
  }
  function toggleArchiveObject(encodedName) {
    const name=decodeURIComponent(encodedName);
    if(archiveExpandedObjects.has(name))archiveExpandedObjects.delete(name);
    else archiveExpandedObjects.add(name);
    renderArchive();
  }
  function renderArchive() {
    if (!hasTabAccess('archive')) return; // === SECURITY ===
    let c = document.getElementById('archiveContainer'); let q = (document.getElementById('archiveSearchInput').value||'').toLowerCase();
    let f = state.archive.filter(s=>s.date?.toLowerCase().includes(q) || s.objectName?.toLowerCase().includes(q));
    if(!f.length) { c.innerHTML = '<div class="empty-state">Пусто</div>'; renderTrash(); return; }
    let g = {}; f.forEach(s=>{ let k=s.objectName||'—'; if(!g[k]) g[k]=[]; g[k].push(s); });
    if(!archiveExpandedInitialized){Object.keys(g).forEach(k=>archiveExpandedObjects.add(k));archiveExpandedInitialized=true;}
    c.innerHTML = Object.keys(g).map(k=>{ let l = g[k].sort((a,b)=>(b.closedAt||0)-(a.closedAt||0)); const expanded=archiveExpandedObjects.has(k)||!!q; return `<div class="archive-group"><button type="button" class="archive-group-header" style="width:100%;text-align:left;cursor:pointer;border:0;color:inherit" aria-expanded="${expanded}" onclick="toggleArchiveObject('${encodeURIComponent(k)}')">${expanded?'▾':'▸'} ${escapeHtml(k)} (${l.length})</button><div class="archive-shifts-list" style="display:${expanded?'':'none'}">${l.map(s=>{ let stdL = (s.logs||[]).filter(x=>!x.isGAI); let gaiL = (s.logs||[]).filter(x=>x.isGAI); let gaiHtml = gaiL.length > 0 ? ` | <span style="color:#cbd5e1;">ГАИ: ${gaiL.length} рейс.</span>` : ''; return `<div class="archive-shift-item" onclick="openArchiveModal('${s.id}')"><div>${escapeHtml(s.date)}</div><div>${stdL.length} рейсов | <b>${stdL.reduce((x,y)=>x+y.volume,0)} м³</b>${gaiHtml}</div></div>`; }).join('')}</div></div>`; }).join('');
    renderTrash();
    if(viewingArchiveId) { let s=state.archive.find(x=>x.id===viewingArchiveId); if(s) openArchiveModal(viewingArchiveId); else closeArchiveModal(); }
  }
  function renderTrash() { let c = document.getElementById('trashContainer'); if(!state.trash.length) { c.innerHTML=''; return; } let e = hasPermission('archive_edit'); c.innerHTML = `<div class="trash-group"><div class="trash-header">Корзина</div><div class="trash-list">${state.trash.map(i=>`<div class="trash-item"><div class="info"><b>${escapeHtml(i.shift.objectName)}</b> · ${escapeHtml(i.shift.date)}</div>${e?`<button class="btn-del" onclick="purgeFromTrash('${i.id}')">X</button>`:''}</div>`).join('')}</div></div>`; }
  async function purgeFromTrash(id) { if(!requireEdit('archive_delete') || !(await appConfirm('Удалить навсегда?'))) return; await tfAwait(refs.trash.doc(id).delete()); }
  function openArchiveModal(id) { let s = state.archive.find(x=>x.id===id); if(!s) return; viewingArchiveId=id; viewingArchiveGAITable = false; renderArchiveModalContent(s); document.getElementById('archiveModal').classList.add('open'); }
  let archiveHoldTimer=null;
  function cancelArchiveHold(){if(archiveHoldTimer!==null){clearTimeout(archiveHoldTimer);archiveHoldTimer=null;}}
  function startArchiveHold(event){
    if(event.type==='pointerdown' && event.button!==0)return;
    cancelArchiveHold();
    const button=event.currentTarget;
    archiveHoldTimer=setTimeout(()=>{
      archiveHoldTimer=null;
      if(button.isConnected && viewingArchiveId && hasTabAccess('archive'))toggleArchiveReportType();
    },800);
  }
  function archiveHoldKey(event){
    if(event.repeat || (event.key!==' ' && event.key!=='Enter'))return;
    event.preventDefault();startArchiveHold(event);
  }
  function toggleArchiveReportType() { viewingArchiveGAITable = !viewingArchiveGAITable; let s = state.archive.find(x=>x.id===viewingArchiveId); if (s) renderArchiveModalContent(s); }
  function renderArchiveModalContent(s) {
    if (!hasTabAccess('archive')) return; // === SECURITY ===
    let logs = s.logs || []; let stdLogs = logs.filter(l=>!l.isGAI); let gaiLogs = logs.filter(l=>l.isGAI);
    let tV = stdLogs.reduce((x,y)=>x+y.volume,0);
    document.getElementById('modalArchiveTitle').textContent = s.date;
    let e = hasPermission('archive_edit');
    document.getElementById('archiveRestoreBtn').style.display = e?'':'none';
    document.getElementById('archiveDeleteBtn').style.display = hasPermission('archive_delete')?'':'none';
    let toggleBtnHtml = `<div style="text-align:center; margin-bottom: 12px;"><button class="btn btn-secondary btn-small" style="min-width:135px;font-size:12px;touch-action:none;user-select:none" aria-label="Удерживайте 0,8 секунды для переключения листа" onpointerdown="startArchiveHold(event)" onpointerup="cancelArchiveHold()" onpointercancel="cancelArchiveHold()" onpointerleave="cancelArchiveHold()" oncontextmenu="event.preventDefault()" onkeydown="archiveHoldKey(event)" onkeyup="cancelArchiveHold()" onblur="cancelArchiveHold()">${viewingArchiveGAITable ? '📄 Обычный' : '📄 ГАИ'} · удерживать 0,8 с</button></div>`;
    let activeLineIds = s.activeLineIds || []; let ttnStatus = s.ttnStatus || {}; let html = '';
    if (!viewingArchiveGAITable) {
      let aIds = activeLineIds.filter(id => { let t = findTruck(id); return t && !t.isGAI; });
      let tIds = new Set(aIds); stdLogs.forEach(l=>tIds.add(l.truckId));
      let tks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?{id, name:f.brand+' '+f.number}:{id, name:(stdLogs.find(l=>l.truckId===id)?.truckName||'—')}; });
      let mT=8; tks.forEach(t=>{ let c=stdLogs.filter(l=>l.truckId===t.id).length; if(c>mT) mT=c; });
      let hC = ''; for(let i=1; i<=mT; i++) hC+=`<th>Рейс ${i}</th>`;
      let mH = tks.map(t=>{ let l = stdLogs.filter(x=>x.truckId===t.id).slice().reverse(), sm = l.reduce((x,y)=>x+y.volume,0), cells=''; let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (l.length > 0 && ttnStatus[t.id] !== true && ttnStatus[t.id] !== 'pending') : (l.length > 0 && !ttnStatus[t.id]); let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;">ДУБЛИКАТ</span>' : '';
        for(let i=0; i<mT; i++) { if(l[i]) { let isL=(i===l.length-1), cH = ttnStatus[t.id] && isL ? '<div class="hand-drawn-circle"></div>':''; let commHtml = l[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l[i].comment)}</div>` : ''; cells += `<td><div class="cell-content">${cH}<div class="paper-time">${escapeHtml(l[i].timeStr)}</div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l[i].createdByEmail, l[i].createdBy))}</div>${commHtml}</div></td>`; }
          else if (i === l.length && ttnStatus[t.id] === 'pending') { cells += `<td><div class="cell-content"><div class="hand-drawn-circle"></div></div></td>`; }
          else cells += '<td></td>';
        } return `<tr><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.name)} <span class="paper-truck-volume">${sm} м³</span>${dupHtml}</div></td>${cells}</tr>`; }).join('');
      html = `<div style="position:relative;" id="archive-paper-wrapper"><canvas id="draw-canvas-archive" class="stylus-canvas"></canvas><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(s.objectName)}</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div><div class="paper-total-info">Объем: <b>${tV} м³</b></div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th>${hC}</tr></thead><tbody>${mH}</tbody></table></div></div></div>`;
    } else {
      let aIds = activeLineIds.filter(id => { let t = findTruck(id); return t && t.isGAI; });
      let tIds = new Set(aIds); gaiLogs.forEach(l=>tIds.add(l.truckId));
      let tks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?{id, name:f.brand+' '+f.number}:{id, name:(gaiLogs.find(l=>l.truckId===id)?.truckName||'—')}; });
      let mT=8; tks.forEach(t=>{ let c=gaiLogs.filter(l=>l.truckId===t.id).length; if(c>mT) mT=c; });
      let hC = ''; for(let i=1; i<=mT; i++) hC+=`<th>Рейс ${i}</th>`;
      let mH = tks.map(t=>{ let l = gaiLogs.filter(x=>x.truckId===t.id).slice().reverse(), cells=''; let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (l.length > 0 && ttnStatus[t.id] !== true && ttnStatus[t.id] !== 'pending') : (l.length > 0 && !ttnStatus[t.id]); let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;">ДУБЛИКАТ</span>' : '';
        for(let i=0; i<mT; i++) { if(l[i]) { let commHtml = l[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l[i].comment)}</div>` : ''; cells += `<td><div class="cell-content"><div class="paper-time">${escapeHtml(l[i].timeStr)}</div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l[i].createdByEmail, l[i].createdBy))}</div>${commHtml}</div></td>`; }
          else cells += '<td></td>';
        } return `<tr><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.name)} <span class="paper-truck-volume">Рейсов: ${l.length}</span>${dupHtml}</div></td>${cells}</tr>`; }).join('');
      html = `<div style="position:relative;" id="archive-paper-wrapper"><canvas id="draw-canvas-archive" class="stylus-canvas"></canvas><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(s.objectName)} (ГАИ)</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div><div class="paper-total-info">Рейсов ГАИ: <b>${gaiLogs.length}</b></div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th>${hC}</tr></thead><tbody>${mH}</tbody></table></div></div></div>`;
    }
    document.getElementById('modalArchiveBody').innerHTML = toggleBtnHtml + html;
    setTimeout(() => { setupStylus('draw-canvas-archive', 'archive-paper-wrapper'); }, 100);
  }
  async function saveArchivePNG() {
    // Export the archive sheet that is currently displayed, not a re-sorted/rebuilt report.
    if (!hasTabAccess('archive') || !viewingArchiveId) return;
    const archiveId = viewingArchiveId;
    const isGAI = viewingArchiveGAITable;
    const archive = state.archive.find(s => s.id === archiveId);
    const modal = document.getElementById('archiveModal');
    const liveWrapper = modal?.querySelector('#modalArchiveBody #archive-paper-wrapper');
    const livePaper = liveWrapper?.querySelector('.paper-report-container');
    const button = modal?.querySelector('#archiveSavePngBtn, button[onclick="exportArchivePNG()"]');
    if (!archive || !livePaper || typeof window.html2pdf !== 'function') {
      showError('Экспорт изображения недоступен');
      return;
    }

    // Snapshot before any await: the user may switch dates or report types while PNG renders.
    const snapshot = liveWrapper.cloneNode(true);
    const sheet = snapshot.querySelector('.paper-report-container');
    const scroller = snapshot.querySelector('.paper-scroll-wrapper');
    const sourceCanvas = liveWrapper.querySelector('#draw-canvas-archive');
    const clonedCanvas = snapshot.querySelector('#draw-canvas-archive');
    const screenZoom = parseFloat(getComputedStyle(livePaper).zoom) || 1;
    // Preserve any handwritten marks; a cloned <canvas> does not copy its bitmap.
    if (sourceCanvas && clonedCanvas) {
      try {
        const drawing = document.createElement('img');
        const rect = sourceCanvas.getBoundingClientRect();
        drawing.src = sourceCanvas.toDataURL('image/png');
        drawing.style.cssText = 'position:absolute;left:0;top:0;z-index:100;pointer-events:none;width:' +
          (rect.width / screenZoom) + 'px;height:' + (rect.height / screenZoom) + 'px';
        clonedCanvas.replaceWith(drawing);
      } catch (e) { clonedCanvas.remove(); }
    }
    snapshot.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    snapshot.style.width = 'max-content';
    snapshot.style.maxWidth = 'none';
    snapshot.style.height = 'auto';
    if (scroller) {
      scroller.style.width = 'max-content';
      scroller.style.maxWidth = 'none';
      scroller.style.overflow = 'visible';
      scroller.style.height = 'auto';
      scroller.style.margin = '0';
    }
    sheet.style.zoom = '1';
    sheet.style.transform = 'none';
    sheet.style.transition = 'none';
    sheet.style.width = 'max-content';
    sheet.style.maxWidth = 'none';

    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:max-content;background:#fdfdfd;pointer-events:none;z-index:-1';
    holder.appendChild(snapshot);
    document.body.appendChild(holder);
    if (button) button.disabled = true;
    let worker;
    try {
      if (document.fonts?.ready) await Promise.race([
        document.fonts.ready, new Promise(resolve => setTimeout(resolve, 2500))
      ]);
      const table = snapshot.querySelector('.paper-table');
      const rootBounds = snapshot.getBoundingClientRect();
      const width = Math.ceil(Math.max(
        1, snapshot.scrollWidth, rootBounds.width, sheet.scrollWidth,
        table ? table.getBoundingClientRect().right - rootBounds.left + 12 : 0
      ));
      const height = Math.ceil(Math.max(1, snapshot.scrollHeight, rootBounds.height));
      // Fit very wide/long reports inside browser canvas limits without dropping trips.
      const scale = Math.min(2, Math.sqrt(16000000 / (width * height)), 8192 / width, 8192 / height);
      worker = window.html2pdf().set({
        margin: 0,
        pagebreak: { mode: [], before: [], after: [], avoid: [] },
        html2canvas: {
          scale, width, height, windowWidth: Math.max(window.innerWidth, width),
          windowHeight: Math.max(window.innerHeight, height),
          scrollX: 0, scrollY: 0, useCORS: true, logging: false, backgroundColor: '#fdfdfd'
        },
        jsPDF: { unit: 'px', format: 'a4' }
      }).from(snapshot).toContainer().then(function () {
        // html2pdf normally constrains its intermediate container to A4 width.
        // The PNG must instead cover the full rendered archive table.
        this.prop.container.style.width = width + 'px';
        this.prop.container.style.maxWidth = 'none';
        this.prop.container.style.height = 'auto';
        this.prop.container.style.overflow = 'visible';
      });
      const canvas = await worker.toCanvas().get('canvas');
      if (!canvas || canvas.width < width * scale * 0.97 ||
          canvas.height < height * scale * 0.97) {
        throw new Error('PNG получился обрезанным');
      }
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(result => result ? resolve(result) : reject(new Error('Браузер не смог создать PNG')), 'image/png')
      );
      const safeName = String(archive.objectName || 'Объект').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 70);
      const safeDate = String(archive.date || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url;
      link.download = safeName + '_' + safeDate + (isGAI ? '_ГАИ' : '') + '.png';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      showToastEl('Отчёт PNG сохранён', false);
    } catch (e) {
      console.warn('Archive PNG', e);
      showError('Не удалось сохранить PNG: ' + e.message);
    } finally {
      if (worker?.prop?.overlay?.parentNode) worker.prop.overlay.remove();
      holder.remove();
      if (button) button.disabled = false;
    }
  }
  function closeArchiveModal() {
    cancelArchiveHold();
    document.getElementById('archiveModal').classList.remove('open');
    viewingArchiveId=null;
  }
  async function restoreArchiveToShift() {
    if (!requireEdit('archive_edit') || !viewingArchiveId) return;
    const s = state.archive.find(x => x.id === viewingArchiveId); if (!s) return;
    const hasActive = state.shift && state.shift.isActive;
    const msg = hasActive ? `Активная смена "${state.shift.objectName}" будет заменена.\n\nВосстановить "${s.objectName}" от ${s.date}?` : `Восстановить смену "${s.objectName}" от ${s.date}?`;
    if (!(await appConfirm(msg))) return;
    try {
      showToastEl('⏳ Восстановление...', false);
      await cleanupOldShiftData(); await clearAllNotifications();
      const newSid = 'shift_' + Date.now();
      await tfAwait(refs.shift.set({ id: newSid, objectName: s.objectName, objectId: s.objectId || '', startDate: s.date, startedAt: Date.now(), startedBy: getUserName(), isActive: true, restoredFrom: viewingArchiveId }));
      const batch = db.batch(); const logsByTruck = {};
      (s.logs || []).forEach((l, idx) => { const lid = `load_${l.truckId}_${newSid}_${l.timestamp || Date.now()}_${idx}`; batch.set(refs.logs.doc(lid), { shiftId: newSid, truckId: l.truckId, truckName: l.truckName, volume: l.volume, timeStr: l.timeStr, timestamp: l.timestamp, createdBy: l.createdBy, createdByEmail: l.createdByEmail || '', isGAI: !!l.isGAI, comment: l.comment || '' }); if (!logsByTruck[l.truckId]) logsByTruck[l.truckId] = []; logsByTruck[l.truckId].push({ id: lid, ts: l.timestamp || 0 }); });
      const allIds = new Set(); (s.activeLineIds || []).forEach(id => allIds.add(id)); (s.logs || []).forEach(l => allIds.add(l.truckId));
      allIds.forEach(id => { const truckLogs = (logsByTruck[id] || []).slice().sort((a, b) => a.ts - b.ts); const lastLog = truckLogs[truckLogs.length - 1]; let ttnStatus = null, ttnLogId = null; if (s.ttnStatus && s.ttnStatus[id]) { ttnStatus = true; ttnLogId = lastLog ? lastLog.id : null; } batch.set(refs.truckStatus.doc(id), { id, shiftId: newSid, onLine: true, addedBy: getUserName(), addedAt: Date.now(), arriveStatus: null, arriveTimestamp: null, arriveBy: null, ttnStatus, ttnBy: null, ttnLogId, lastLoadTimestamp: lastLog ? lastLog.ts : null, lastLoadBy: null, lastLoadLogId:lastLog?lastLog.id:null, cycleRevision:0, loadedAfterArrive: false }); });
      await tfAwait(batch.commit()); await tfAwait(refs.archive.doc(viewingArchiveId).delete());
      addAudit(`♻️ Смена восстановлена из архива: ${s.objectName} (${s.date})`).catch(()=>{});
      closeArchiveModal(); showToastEl('✅ Смена восстановлена', false);
    } catch(e) { showError('Ошибка восстановления: ' + e.message); }
  }
  async function deleteArchiveShift() { if(!requireEdit('archive_delete') || !viewingArchiveId || !(await appConfirm('В корзину?'))) return; let s = state.archive.find(x=>x.id===viewingArchiveId); try { await tfAwait(refs.trash.doc().set({ shift: s, deletedAt: Date.now(), deletedBy: getUserName() })); await tfAwait(refs.archive.doc(viewingArchiveId).delete()); closeArchiveModal(); } catch(e){ showError(e.message); } }

