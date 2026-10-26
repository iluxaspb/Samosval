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
    let g = Object.create(null); f.forEach(s=>{ let k=s.objectName||'—'; if(!g[k]) g[k]=[]; g[k].push(s); });
    if(!archiveExpandedInitialized){Object.keys(g).forEach(k=>archiveExpandedObjects.add(k));archiveExpandedInitialized=true;}
    c.innerHTML = Object.keys(g).map(k=>{ let l = g[k].sort((a,b)=>(b.closedAt||0)-(a.closedAt||0)); const expanded=archiveExpandedObjects.has(k)||!!q; return `<div class="archive-group"><button type="button" class="archive-group-header" style="width:100%;text-align:left;cursor:pointer;border:0;color:inherit" aria-expanded="${expanded}" onclick="toggleArchiveObject('${reportActionId(k)}')">${expanded?'▾':'▸'} ${escapeHtml(k)} (${l.length})</button><div class="archive-shifts-list" style="display:${expanded?'':'none'}">${l.map(s=>{ let stdL = (s.logs||[]).filter(x=>!x.isGAI); let gaiL = (s.logs||[]).filter(x=>x.isGAI); let gaiHtml = gaiL.length > 0 ? ` | <span style="color:#cbd5e1;">ГАИ: ${gaiL.length} рейс.</span>` : ''; return `<div class="archive-shift-item" onclick="openArchiveModal(decodeURIComponent('${reportActionId(s.id)}'))"><div>${escapeHtml(s.date)}</div><div>${stdL.length} рейсов | <b>${reportVolumeLabel(reportVolumeTotal(stdL))} м³</b>${gaiHtml}</div></div>`; }).join('')}</div></div>`; }).join('');
    renderTrash();
    if(viewingArchiveId) { let s=state.archive.find(x=>x.id===viewingArchiveId); if(s) openArchiveModal(viewingArchiveId); else closeArchiveModal(); }
  }
  function renderTrash() { let c = document.getElementById('trashContainer'); if(!state.trash.length) { c.innerHTML=''; return; } let e = hasPermission('archive_edit'); c.innerHTML = `<div class="trash-group"><div class="trash-header">Корзина</div><div class="trash-list">${state.trash.map(i=>`<div class="trash-item"><div class="info"><b>${escapeHtml(i.shift.objectName)}</b> · ${escapeHtml(i.shift.date)}</div>${e?`<button class="btn-del" onclick="purgeFromTrash(decodeURIComponent('${reportActionId(i.id)}'))">X</button>`:''}</div>`).join('')}</div></div>`; }
  async function purgeFromTrash(id) { if(!requireEdit('archive_delete') || !(await appConfirm('Удалить навсегда?'))) return; await tfAwait(refs.trash.doc(id).delete()); }
  function openArchiveModal(id) { if (!hasTabAccess('archive')) return; let s = state.archive.find(x=>x.id===id); if(!s) return; viewingArchiveId=id; viewingArchiveGAITable = false; renderArchiveModalContent(s); document.getElementById('archiveModal').classList.add('open'); }
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
  function toggleArchiveReportType() { if (!hasPermission('view_gai_report')) { showError('Нет прав'); return; } viewingArchiveGAITable = !viewingArchiveGAITable; let s = state.archive.find(x=>x.id===viewingArchiveId); if (s) renderArchiveModalContent(s); }
  function renderArchiveModalContent(s) {
    if (!hasTabAccess('archive')) return; // === SECURITY ===
    let logs = s.logs || []; let stdLogs = logs.filter(l=>!l.isGAI); let gaiLogs = logs.filter(l=>l.isGAI);
    if (!hasPermission('view_gai_report')) viewingArchiveGAITable = false;
    const stdGrouped = reportLogsByTruck(stdLogs), gaiGrouped = reportLogsByTruck(gaiLogs);
    let tV = reportVolumeLabel(reportVolumeTotal(stdLogs));
    document.getElementById('modalArchiveTitle').textContent = s.date;
    let e = hasPermission('archive_edit');
    const restoreButton=document.getElementById('archiveRestoreBtn');
    restoreButton.style.display=e?'':'none';
    restoreButton.textContent=state.shift?.restoring&&state.shift.restoredFrom===s.id?'♻️ Продолжить восстановление':'♻️ Восстановить смену';
    restoreButton.disabled=archiveRestoreInFlight;
    document.getElementById('archiveDeleteBtn').style.display = hasPermission('archive_delete')?'':'none';
    let toggleBtnHtml = `<div class="archive-view-switch"><button type="button" class="archive-toggle-icon" aria-label="${viewingArchiveGAITable ? 'Обычный лист' : 'Лист ГАИ'}" title="${viewingArchiveGAITable ? 'Обычный лист' : 'Лист ГАИ'}" onclick="toggleArchiveReportType()">📄</button></div>`;
    let activeLineIds = s.activeLineIds || []; let ttnStatus = s.ttnStatus || {}; let html = '';
    if (!viewingArchiveGAITable) {
      let aIds = activeLineIds.filter(id => { let t = findTruck(id); return t && !t.isGAI; });
      let tIds = new Set(aIds); stdLogs.forEach(l=>tIds.add(l.truckId));
      let tks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?{id, name:f.brand+' '+f.number}:{id, name:(stdGrouped.get(id)?.[0]?.truckName||'—')}; });
      let mT=8; tks.forEach(t=>{ let c=(stdGrouped.get(t.id)||[]).length; if(c>mT) mT=c; });
      let hC = ''; for(let i=1; i<=mT; i++) hC+=`<th>Рейс ${i}</th>`;
      let mH = tks.map(t=>{ let l = (stdGrouped.get(t.id)||[]).slice().reverse(), sm = reportVolumeLabel(reportVolumeTotal(l)), cells=''; let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (l.length > 0 && ttnStatus[t.id] !== true && ttnStatus[t.id] !== 'pending') : (l.length > 0 && !ttnStatus[t.id]); let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;" title="Дубликат" aria-label="Дубликат">D</span>' : '';
        for(let i=0; i<mT; i++) { if(l[i]) { let isL=(i===l.length-1), cH = ttnStatus[t.id] === true && isL ? '<div class="hand-drawn-circle"></div>':''; let commHtml = l[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l[i].comment)}</div>` : ''; cells += `<td><div class="cell-content">${cH}<div class="paper-time">${escapeHtml(l[i].timeStr)}</div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l[i].createdByEmail, l[i].createdBy))}</div>${commHtml}</div></td>`; }
          else if (i === l.length && ttnStatus[t.id] === 'pending') { cells += `<td><div class="cell-content"><div class="hand-drawn-circle"></div></div></td>`; }
          else cells += '<td></td>';
        } return `<tr><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.name)} <span class="paper-truck-volume">${sm} м³</span>${dupHtml}</div></td>${cells}</tr>`; }).join('');
      html = `<div style="position:relative;" id="archive-paper-wrapper"><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(s.objectName)}</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div><div class="paper-total-info">Объем: <b>${tV} м³</b></div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th>${hC}</tr></thead><tbody>${mH}</tbody></table></div></div></div>`;
    } else {
      let aIds = activeLineIds.filter(id => { let t = findTruck(id); return t && t.isGAI; });
      let tIds = new Set(aIds); gaiLogs.forEach(l=>tIds.add(l.truckId));
      let tks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?{id, name:f.brand+' '+f.number}:{id, name:(gaiGrouped.get(id)?.[0]?.truckName||'—')}; });
      let mT=8; tks.forEach(t=>{ let c=(gaiGrouped.get(t.id)||[]).length; if(c>mT) mT=c; });
      let hC = ''; for(let i=1; i<=mT; i++) hC+=`<th>Рейс ${i}</th>`;
      let mH = tks.map(t=>{ let l = (gaiGrouped.get(t.id)||[]).slice().reverse(), cells=''; let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (l.length > 0 && ttnStatus[t.id] !== true && ttnStatus[t.id] !== 'pending') : (l.length > 0 && !ttnStatus[t.id]); let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;" title="Дубликат" aria-label="Дубликат">D</span>' : '';
        for(let i=0; i<mT; i++) { if(l[i]) { let commHtml = l[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l[i].comment)}</div>` : ''; cells += `<td><div class="cell-content"><div class="paper-time">${escapeHtml(l[i].timeStr)}</div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l[i].createdByEmail, l[i].createdBy))}</div>${commHtml}</div></td>`; }
          else cells += '<td></td>';
        } return `<tr><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.name)} <span class="paper-truck-volume">Рейсов: ${l.length}</span>${dupHtml}</div></td>${cells}</tr>`; }).join('');
      html = `<div style="position:relative;" id="archive-paper-wrapper"><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(s.objectName)} (ГАИ)</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div><div class="paper-total-info">Рейсов ГАИ: <b>${gaiLogs.length}</b></div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th>${hC}</tr></thead><tbody>${mH}</tbody></table></div></div></div>`;
    }
    document.getElementById('modalArchiveBody').innerHTML = toggleBtnHtml + html;
  }
  async function saveArchivePNG() {
    // Export the archive sheet that is currently displayed, not a re-sorted/rebuilt report.
    if (!hasTabAccess('archive') || !viewingArchiveId) return;
    const archiveId = viewingArchiveId;
    const isGAI = viewingArchiveGAITable;
    if (isGAI && !hasPermission('view_gai_report')) { showError('Нет прав'); return; }
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
      if (document.fonts?.ready) { try { await reportPNGDeadline(document.fonts.ready, 2500, 'Шрифт недоступен'); } catch (_) {} }
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
          scrollX: 0, scrollY: 0, useCORS: true, logging: false, backgroundColor: '#fdfdfd', imageTimeout: 10000
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
      const canvas = await reportPNGDeadline(worker.toCanvas().get('canvas'), 45000, 'Не удалось подготовить PNG. Повторите выгрузку отчёта.');
      if (!canvas || canvas.width < width * scale * 0.97 ||
          canvas.height < height * scale * 0.97) {
        throw new Error('PNG получился обрезанным');
      }
      const blob = await reportPNGDeadline(new Promise((resolve, reject) =>
        canvas.toBlob(result => result ? resolve(result) : reject(new Error('Браузер не смог создать PNG')), 'image/png')
      ), 15000, 'Сохранение PNG заняло слишком много времени');
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
  function archiveRestoreJSON(value) {
    return JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)
      ?Object.keys(item).sort().reduce((out,key)=>(out[key]=item[key],out),Object.create(null)):item);
  }
  async function archiveRestoreFingerprint(archive) {
    if(!crypto.subtle)throw Error('Для восстановления откройте приложение по HTTPS');
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(archiveRestoreJSON(archive)));
    return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
  }
  function archiveRestorePlan(archive,shift) {
    if(!Array.isArray(archive.logs))throw Error('Архив повреждён: отсутствует список рейсов');
    const writes=[],logsByTruck=Object.create(null),mappedLogIds=Object.create(null),savedStatuses=archive.truckStatuses||{};
    const validTruck=id=>typeof id==='string'&&id.length>0&&!id.includes('/');
    archive.logs.forEach((log,index)=>{
      if(!validTruck(log.truckId)||!Number.isFinite(Number(log.timestamp))||!Number.isFinite(Number(log.volume||0)))
        throw Error('Архив повреждён: некорректный рейс '+(index+1));
      const id='restored_'+shift.restoredFrom+'_'+index;
      const data={shiftId:shift.id,gameRewardLogId:log.gameRewardLogId||log.id||id,truckId:log.truckId,truckName:log.truckName||'',volume:Number(log.volume||0),
        timeStr:log.timeStr||'',timestamp:Number(log.timestamp),arrivalTimestamp:Number(log.arrivalTimestamp)||null,
        returnedAt:Number(log.returnedAt)||null,createdBy:log.createdBy||'',createdByEmail:log.createdByEmail||'',
        isGAI:!!log.isGAI,comment:log.comment||''};
      writes.push({ref:refs.logs.doc(id),data});
      if(log.id)mappedLogIds[log.id]=id;
      (logsByTruck[log.truckId]||(logsByTruck[log.truckId]=[])).push({id,...data});
    });
    const ids=new Set([...(archive.activeLineIds||[]),...Object.keys(logsByTruck),...Object.keys(savedStatuses)]);
    ids.forEach(id=>{
      if(!validTruck(id))throw Error('Архив повреждён: некорректный самосвал');
      const last=(logsByTruck[id]||[]).slice().sort((a,b)=>a.timestamp-b.timestamp).at(-1);
      const original=Object.prototype.hasOwnProperty.call(savedStatuses,id)?savedStatuses[id]:null;
      const returnedAt=last&&last.returnedAt>last.timestamp?last.returnedAt:null;
      const ttn=archive.ttnStatus?.[id];
      const data={id,shiftId:shift.id,onLine:Array.isArray(archive.activeLineIds)?archive.activeLineIds.includes(id):true,
        addedBy:shift.startedBy,addedAt:shift.startedAt,
        arriveStatus:returnedAt?new Date(returnedAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):null,
        arriveTimestamp:returnedAt,arriveBy:null,ttnStatus:ttn===true?true:ttn==='pending'?'pending':null,ttnBy:null,
        ttnLogId:ttn===true&&last?last.id:null,lastLoadTimestamp:last?.timestamp||null,lastLoadBy:last?.createdBy||null,
        lastLoadLogId:last?.id||null,cycleRevision:0,ttnRevision:0,loadedAfterArrive:!!last&&!returnedAt};
      if(original){
        for(const key of ['onLine','arriveStatus','arriveTimestamp','arriveBy','ttnStatus','ttnBy','lastLoadTimestamp','lastLoadBy','cycleRevision','ttnRevision','loadedAfterArrive'])
          if(original[key]!==undefined)data[key]=original[key];
        data.lastLoadLogId=original.lastLoadLogId?mappedLogIds[original.lastLoadLogId]||null:data.lastLoadLogId;
        data.ttnLogId=original.ttnLogId?mappedLogIds[original.ttnLogId]||null:null;
      }
      writes.push({ref:refs.truckStatus.doc(id),data});
    });
    return writes;
  }
  let archiveRestoreInFlight=false;
  async function restoreArchiveToShift() {
    if(archiveRestoreInFlight||!requireEdit('archive_edit')||!viewingArchiveId)return;
    if(offlinePendingCount()){showError('Сначала синхронизируйте действия перед восстановлением смены');return;}
    const archiveId=viewingArchiveId,sessionUid=currentUid,archiveRef=refs.archive.doc(archiveId);
    const local=state.archive.find(item=>item.id===archiveId);if(!local)return;
    if(state.shift&&(!state.shift.restoring||state.shift.restoredFrom!==archiveId)){
      showError('Сначала закройте текущую смену или завершите восстановление другого архива');return;
    }
    archiveRestoreInFlight=true;
    const button=document.getElementById('archiveRestoreBtn'),label=button?.textContent;
    let phase='подтверждение';
    try{
      if(!await appConfirm(state.shift?.restoring?'Продолжить восстановление этой смены?':`Восстановить смену "${local.objectName}" от ${local.date}?`))return;
      if(button){button.disabled=true;button.textContent='⏳ Восстанавливаем смену…';}
      phase='проверка исходного архива';
      const snapshot=await archiveRef.get({source:'server'});
      if(!snapshot.exists)throw Error('Исходный архив отсутствует. Обновите страницу.');
      const archive=snapshot.data(),fingerprint=await archiveRestoreFingerprint(archive),shiftId='restored_'+archiveId;
      const candidate={id:shiftId,objectName:archive.objectName||'',objectId:archive.objectId||'',startDate:archive.date||'',
        startedAt:Date.now(),startedBy:getUserName(),isActive:false,restoring:true,restoredFrom:archiveId,
        restoreArchiveFingerprint:fingerprint,photoShiftIds:[...new Set([...(archive.photoShiftIds||[]),archive.sourceShiftId].filter(Boolean))]};
      archiveRestorePlan(archive,candidate); // Validate before reserving the workspace.
      const shift=await tfAwait(db.runTransaction(async tx=>{
        requireShiftSession(sessionUid);
        const [current,source]=await Promise.all([tx.get(refs.shift),tx.get(archiveRef)]);
        if(!source.exists||await archiveRestoreFingerprint(source.data())!==fingerprint)throw Error('Архив изменился. Повторите восстановление.');
        if(current.exists){
          const data=current.data();
          if(data.id!==shiftId||!data.restoring||data.restoredFrom!==archiveId)
            throw Error('Другая смена уже существует. Сначала завершите её.');
          if(data.restoreArchiveFingerprint!==fingerprint)throw Error('Архив изменён после начала восстановления. Исходные данные сохранены; требуется проверка архива.');
          return data;
        }
        tx.set(refs.shift,candidate);return candidate;
      }));
      const writes=archiveRestorePlan(archive,shift),chunkSize=currentUserRole==='admin'?20:4;
      phase='восстановление рейсов и линии';
      for(let i=0;i<writes.length;i+=chunkSize){
        const chunk=writes.slice(i,i+chunkSize);
        const continuing=await tfAwait(db.runTransaction(async tx=>{
          requireShiftSession(sessionUid);
          const current=await tx.get(refs.shift),data=current.exists?current.data():null;
          if(data?.id===shiftId&&data.isActive&&!data.restoring)return false; // Another device completed the same restore.
          if(data?.id!==shiftId||!data.restoring||data.restoreArchiveFingerprint!==fingerprint)
            throw Error('Восстанавливаемая смена изменилась. Другая смена не затронута.');
          const saved=await Promise.all(chunk.map(item=>tx.get(item.ref)));
          saved.forEach((doc,index)=>{
            if(doc.exists&&archiveRestoreJSON(doc.data())!==archiveRestoreJSON(chunk[index].data))
              throw Error('Запись '+doc.id+' уже содержит другие данные. Перезапись отменена.');
          });
          saved.forEach((doc,index)=>{if(!doc.exists)tx.set(chunk[index].ref,chunk[index].data);});
          return true;
        }));
        if(!continuing)break;
      }
      phase='завершение восстановления';
      const activated=await tfAwait(db.runTransaction(async tx=>{
        requireShiftSession(sessionUid);
        const [current,source]=await Promise.all([tx.get(refs.shift),tx.get(archiveRef)]);
        const data=current.exists?current.data():null;
        if(data?.id===shiftId&&data.isActive&&!data.restoring&&!source.exists)return data;
        if(data?.id!==shiftId||!data.restoring||data.restoreArchiveFingerprint!==fingerprint)
          throw Error('Смена изменилась. Исходный архив сохранён.');
        if(!source.exists||await archiveRestoreFingerprint(source.data())!==fingerprint)
          throw Error('Исходный архив изменился. Удаление отменено.');
        // Include every restored record in the final transaction's read set. A concurrent
        // deletion/edit must retry and fail validation before the only source is removed.
        for(let i=0;i<writes.length;i+=20){
          const chunk=writes.slice(i,i+20),saved=await Promise.all(chunk.map(item=>tx.get(item.ref)));
          saved.forEach((doc,index)=>{
            if(!doc.exists||archiveRestoreJSON(doc.data())!==archiveRestoreJSON(chunk[index].data))
              throw Error('Восстановленные записи изменены или отсутствуют. Исходный архив сохранён; повторите восстановление.');
          });
        }
        const ready={isActive:true,restoring:false,restoredAt:Date.now()};
        tx.update(refs.shift,ready);tx.delete(archiveRef);return {...data,...ready};
      }));
      if(currentUid!==sessionUid)return;
      state.shift=activated;offlineProjectState();renderAll();
      addAudit(`♻️ Смена восстановлена из архива: ${archive.objectName} (${archive.date})`).catch(()=>{});
      closeArchiveModal();showToastEl('✅ Смена восстановлена',false);
    }catch(e){console.error('[restoreArchive:'+phase+']',e);showError('Не удалось восстановить смену ('+phase+'): '+(e.message||e)+'. Исходный архив сохранён. Откройте его и повторите восстановление.');}
    finally{archiveRestoreInFlight=false;if(button){button.disabled=false;button.textContent=label||'♻️ Восстановить смену';}if(typeof renderShiftLifecycle==='function')renderShiftLifecycle();}
  }
  async function deleteArchiveShift() {
    if(!requireEdit('archive_delete')||!viewingArchiveId)return;
    const archiveId=viewingArchiveId,sessionUid=currentUid;
    if(!await appConfirm('В корзину?'))return;
    const archiveRef=refs.archive.doc(archiveId),trashRef=refs.trash.doc();
    try{
      await tfAwait(db.runTransaction(async tx=>{
        requireShiftSession(sessionUid);
        const [archive,current]=await Promise.all([tx.get(archiveRef),tx.get(refs.shift)]);
        if(!archive.exists)return;
        const shift=current.exists?current.data():null;
        if(shift?.closing&&(shift.closeArchiveId||('closed_'+shift.id))===archiveId||shift?.restoring&&shift.restoredFrom===archiveId)
          throw Error('Этот архив нужен для незавершённого закрытия или восстановления смены. Сначала завершите операцию.');
        tx.set(trashRef,{shift:{...archive.data(),id:archiveId},deletedAt:Date.now(),deletedBy:getUserName()});
        tx.delete(archiveRef);
      }));
      closeArchiveModal();
    }catch(e){showError(e.message);}
  }
