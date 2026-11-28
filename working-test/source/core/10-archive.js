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
    // Фоновые снапшоты пересобирают список через innerHTML — без сохранения
    // прокрутки список «подпрыгивает» к началу при каждом обновлении.
    const keepScrollY=window.scrollY||document.documentElement.scrollTop||document.body?.scrollTop||0;
    const keepContainerTop=container.scrollTop||0;
    const filtered=state.archive.filter(s=>s.date?.toLowerCase().includes(q)||objectTitle(s.objectId,s.objectName).toLowerCase().includes(q));
    if (!filtered.length){
      container.innerHTML='<div class="empty-state">Пусто</div>';
      container.scrollTop=keepContainerTop;
      if (keepScrollY&&typeof window.scrollTo==='function') window.scrollTo(0,keepScrollY);
      renderTrash();return;
    }
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
    container.scrollTop=keepContainerTop;
    if (keepScrollY&&typeof window.scrollTo==='function') window.scrollTo(0,keepScrollY);
    renderTrash();
    if (viewingArchiveId){
      const shift=state.archive.find(item=>item.id===viewingArchiveId);
      if (shift) openArchiveModal(viewingArchiveId); else closeArchiveModal();
    }
  }
  function renderTrash() { let c = document.getElementById('trashContainer'); if(!state.trash.length) { c.innerHTML=''; return; } let e = hasPermission('archive_edit'); c.innerHTML = `<div class="trash-group"><div class="trash-header">Корзина</div><div class="trash-list">${state.trash.map(i=>`<div class="trash-item"><div class="info"><b>${escapeHtml(objectTitle(i.shift.objectId,i.shift.objectName))}</b> · ${escapeHtml(i.shift.date)}</div>${e?`<button class="btn-del" onclick="purgeFromTrash('${i.id}')">X</button>`:''}</div>`).join('')}</div></div>`; }
  async function purgeFromTrash(id) { if(!requireEdit('archive_delete') || !(await appConfirm('Удалить навсегда?'))) return; try{if(isNasRuntime()){await nasArchiveAction('trash.purge',id);return;}await tfAwait(refs.trash.doc(id).delete());}catch(e){showError(e.message);} }
  function openArchiveModal(id) { let s = state.archive.find(x=>x.id===id); if(!s) return; if (viewingArchiveId !== id) { viewingArchiveId=id; if (typeof window !== 'undefined') window.__wtArchiveRevisionView = null; } viewingArchiveGAITable = false; renderArchiveModalContent(s); document.getElementById('archiveModal').classList.add('open'); }
  function toggleArchiveReportType() { viewingArchiveGAITable = !viewingArchiveGAITable; let s = state.archive.find(x=>x.id===viewingArchiveId); if (s) renderArchiveModalContent(s); }
  // История ревизий и provenance приходят только инжектированным провайдером:
  // серверных маршрутов /api/v2/archives/... в этом канале нет, поэтому без
  // данных UI честно говорит «недоступна», а не выдумывает ревизию 1.
  function archiveRevisionProvider() {
    const provider = typeof window !== 'undefined' ? window.__wtArchiveRevisionProvider : null;
    if (!provider) return null;
    try {
      const value = typeof provider === 'function' ? provider() : provider;
      return value && typeof value === 'object' ? value : null;
    } catch (_) {
      return null;
    }
  }
  function archiveRestoredApi() {
    return typeof WorkingTestRestoredArchive !== 'undefined'
      ? WorkingTestRestoredArchive.createRestoredArchive({})
      : null;
  }
  function archiveExplicitView() {
    const view = typeof window !== 'undefined' ? window.__wtArchiveRevisionView : null;
    return view && typeof view === 'object' ? view : null;
  }
  function archiveProvenanceHtml(provenance) {
    const api = archiveRestoredApi();
    if (!api || !provenance || typeof provenance !== 'object') return '';
    const info = api.describeProvenance(provenance);
    return '<div class="archive-archive-badge">Архивная смена · только правки рейсов/ТТН</div>'
      + info.lines.map(line => '<div class="archive-provenance-line">' + escapeHtml(line) + '</div>').join('');
  }
  function archiveRevisionSectionHtml() {
    const unavailable = '<div class="archive-revision-empty">История ревизий недоступна в этом канале</div>';
    const provider = archiveRevisionProvider();
    const api = archiveRestoredApi();
    // Без провайдера ревизий секции нет вовсе. Это не то же самое, что
    // «ревизий нет»: в канале без маршрута истории пользователю нечего
    // показывать, а заголовок с честной оговоркой выглядел бы как реклама
    // недоступной функции. Пустая секция ничего не обещает.
    if (!provider || !api) return '';
    if (!Array.isArray(provider.revisions) || !provider.revisions.length) {
      return '<div class="archive-revision-title">История ревизий</div>' + unavailable;
    }
    const latest = api.resolveDefault(provider.revisions);
    if (!latest) {
      return '<div class="archive-revision-title">История ревизий</div>' + unavailable;
    }
    const view = archiveExplicitView();
    const selected = view && Number.isSafeInteger(Number(view.revision))
      ? api.selectRevision(provider.revisions, Number(view.revision))
      : null;
    const described = api.describeRevision(selected || latest);
    // Сортировка идёт по нормализованному номеру: серверная форма ревизии
    // (`revision`, `server/src/archive-latest.mjs`) не несёт `archiveRevision`,
    // и прежнее `Number(b.archiveRevision) - Number(a.archiveRevision)` давало
    // NaN, то есть список оставался в исходном порядке. Битые строки, которые
    // describeRevision не может описать, в список не попадают.
    const sorted = provider.revisions
      .map(revision => api.describeRevision(revision))
      .filter(item => item && Number.isSafeInteger(item.revision))
      .sort((a, b) => b.revision - a.revision);
    const options = sorted.map(item => {
      const label = 'Ревизия ' + item.revision + ' · ' + (item.publishedAt || 'дата неизвестна')
        + ' · ' + (item.sha256 ? item.sha256.slice(0, 12) : 'SHA-256 неизвестен');
      return '<option value="' + item.revision + '"' + (item.revision === described.revision ? ' selected' : '') + '>'
        + escapeHtml(label) + '</option>';
    }).join('');
    return '<div class="archive-revision-title">История ревизий</div>'
      + '<div class="archive-revision-current">' + (selected ? 'Выбрана ревизия ' : 'По умолчанию: ревизия ')
      + described.revision + ' · SHA-256 ' + escapeHtml(described.sha256 || '—')
      + ' · ' + escapeHtml(described.publishedAt || '—') + '</div>'
      + '<select class="form-control archive-revision-select" onchange="openArchiveRevision(this.value)">' + options + '</select>'
      + (described.readOnly ? '<div class="archive-revision-readonly">Просмотр ревизии только для чтения. Правки доступны в последней опубликованной ревизии.</div>' : '');
  }
  function renderArchiveMetaSections(s) {
    const provider = archiveRevisionProvider();
    const provenance = (s && s.provenance) || (provider && provider.provenance) || null;
    const provenanceHtml = archiveProvenanceHtml(provenance);
    const historyHtml = archiveRevisionSectionHtml();
    const provenanceEl = document.getElementById('archiveProvenanceSection');
    const historyEl = document.getElementById('archiveRevisionHistory');
    if (provenanceEl || historyEl) {
      if (provenanceEl) provenanceEl.innerHTML = provenanceHtml;
      if (historyEl) historyEl.innerHTML = historyHtml;
      return '';
    }
    return '<div class="archive-provenance">' + provenanceHtml + '</div><div class="archive-revision-history">' + historyHtml + '</div>';
  }
  // Полноэкранный просмотр архива (features/paper-viewer.js) подменяет
  // window.openArchiveModal/renderArchiveModalContent и рисует только бумажный
  // лист. Плашка архива и история ревизий живут отдельными секциями модалки,
  // поэтому их рендерер публикуется наружу: без этого они оставались пустыми
  // в собранном канале, хотя разметка и данные на месте.
  if (typeof window !== 'undefined') window.__wtRenderArchiveMeta = renderArchiveMetaSections;
  // Explicit-просмотр ревизии: только выбор в модалке, default pointer не
  // меняется, правок не предлагается, сеть не вызывается.
  function openArchiveRevisionView(revision) {
    const provider = archiveRevisionProvider();
    const api = archiveRestoredApi();
    if (!provider || !api || !Array.isArray(provider.revisions)) return false;
    const selected = api.selectRevision(provider.revisions, revision);
    if (!selected) return false;
    if (typeof window !== 'undefined') {
      window.__wtArchiveRevisionView = {
        archiveId: provider.archiveId || viewingArchiveId,
        revision: selected.archiveRevision,
        sha256: selected.archiveSha256 || '',
        explicit: true,
        readOnly: true
      };
    }
    const shift = (state.archive || []).find(item => item.id === viewingArchiveId);
    if (shift) renderArchiveModalContent(shift);
    return true;
  }
  function closeArchiveRevisionView() {
    if (typeof window !== 'undefined') window.__wtArchiveRevisionView = null;
    const shift = (state.archive || []).find(item => item.id === viewingArchiveId);
    if (shift) renderArchiveModalContent(shift);
    return true;
  }
  function renderArchiveModalContent(s) {
    if (!hasTabAccess('archive')) return; // === SECURITY ===
    // Ф3: фоновые снапшоты вызывают renderArchive → openArchiveModal →
    // этот рендер, и innerHTML сбрасывает горизонтальную прокрутку отчёта
    // («схлопывался к самосвалам»). scrollLeft читается до перестроения
    // и восстанавливается после — как вертикаль списка в renderArchive.
    const bodyEl=document.getElementById('modalArchiveBody');
    const keepScrollLeft=bodyEl?.querySelector('.paper-scroll-wrapper')?.scrollLeft||0;
    let logs = s.logs || []; let stdLogs = logs.filter(l=>!l.isGAI); let gaiLogs = logs.filter(l=>l.isGAI);
    let tV = stdLogs.reduce((x,y)=>x+y.volume,0);
    document.getElementById('modalArchiveTitle').textContent = s.date;
    let e = hasPermission('archive_edit');
    document.getElementById('archiveRestoreBtn').style.display = e?'':'none';
    // На пустом (уже удалённом) листе ГАИ удалять нечего — кнопка скрыта.
    const canDeleteArchive = hasPermission('archive_delete') && !(viewingArchiveGAITable && !gaiLogs.length);
    document.getElementById('archiveDeleteBtn').style.display = canDeleteArchive?'':'none';
    // Подпись кнопки объясняет, что именно удалится: весь архив или только лист ГАИ.
    const delBtn = document.getElementById('archiveDeleteBtn');
    if (delBtn) delBtn.textContent = viewingArchiveGAITable ? '🗑 Удалить лист ГАИ' : '🗑 Удалить архив';
    let toggleBtnHtml = `<div class="archive-view-switch"><button type="button" class="archive-toggle-icon" aria-label="${viewingArchiveGAITable ? 'Обычный лист' : 'Лист ГАИ'}" title="${viewingArchiveGAITable ? 'Обычный лист' : 'Лист ГАИ'}" onclick="toggleArchiveReportType()">📄</button></div>`;
    let activeLineIds = s.activeLineIds || []; let ttnStatus = s.ttnStatus || {}; let html = '';
    if (!viewingArchiveGAITable) {
      let aIds = activeLineIds.filter(id => { let t = findTruck(id); return t && !t.isGAI; });
      let tIds = new Set(aIds); stdLogs.forEach(l=>tIds.add(l.truckId));
      let tks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?{id, name:f.brand+' '+f.number}:{id, name:(stdLogs.find(l=>l.truckId===id)?.truckName||'—')}; });
      let mT=8; tks.forEach(t=>{ let c=stdLogs.filter(l=>l.truckId===t.id).length; if(c>mT) mT=c; });
      let hC = ''; for(let i=1; i<=mT; i++) hC+=`<th>Рейс ${i}</th>`;
      let mH = tks.map(t=>{ let l = stdLogs.filter(x=>x.truckId===t.id).slice().reverse(), sm = l.reduce((x,y)=>x+y.volume,0), cells=''; let absentFallback = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (l.length > 0 && ttnStatus[t.id] !== true && ttnStatus[t.id] !== 'pending') : (l.length > 0 && !ttnStatus[t.id]); let dupHtml = absentFallback ? '<span class="paper-absent-badge" title="Самосвал больше не приедет" aria-label="Самосвал больше не приедет">Д</span>' : '';
        for(let i=0; i<mT; i++) { if(l[i]) { let isL=(i===l.length-1), cH = ttnStatus[t.id] && isL ? '<div class="hand-drawn-circle"></div>':''; let commHtml = l[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l[i].comment)}</div>` : ''; cells += `<td><div class="cell-content">${cH}<div class="paper-time">${escapeHtml(l[i].timeStr)}</div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l[i].createdByEmail, l[i].createdBy))}</div>${commHtml}</div></td>`; }
          else if (i === l.length && ttnStatus[t.id] === 'pending') { cells += `<td><div class="cell-content"><div class="hand-drawn-circle"></div></div></td>`; }
          else cells += '<td></td>';
        } return `<tr><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.name)} <span class="paper-truck-volume">${sm} м³</span>${dupHtml}</div></td>${cells}</tr>`; }).join('');
      html = `<div style="position:relative;" id="archive-paper-wrapper"><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(objectTitle(s.objectId,s.objectName))}</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div><div class="paper-total-info">Объем: <b>${tV} м³</b></div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th>${hC}</tr></thead><tbody>${mH}</tbody></table></div></div></div>`;
    } else if (!gaiLogs.length) {
      // Лист ГАИ удалён: остаётся пустой листик — без пометки «ГАИ» и без
      // списка самосвалов, которые были только на этом листе.
      html = `<div style="position:relative;" id="archive-paper-wrapper"><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(objectTitle(s.objectId,s.objectName))}</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th></tr></thead><tbody></tbody></table></div></div></div>`;
    } else {
      let aIds = activeLineIds.filter(id => { let t = findTruck(id); return t && t.isGAI; });
      let tIds = new Set(aIds); gaiLogs.forEach(l=>tIds.add(l.truckId));
      let tks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?{id, name:f.brand+' '+f.number}:{id, name:(gaiLogs.find(l=>l.truckId===id)?.truckName||'—')}; });
      let mT=8; tks.forEach(t=>{ let c=gaiLogs.filter(l=>l.truckId===t.id).length; if(c>mT) mT=c; });
      let hC = ''; for(let i=1; i<=mT; i++) hC+=`<th>Рейс ${i}</th>`;
      let mH = tks.map(t=>{ let l = gaiLogs.filter(x=>x.truckId===t.id).slice().reverse(), cells=''; let absentFallback = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (l.length > 0 && ttnStatus[t.id] !== true && ttnStatus[t.id] !== 'pending') : (l.length > 0 && !ttnStatus[t.id]); let dupHtml = absentFallback ? '<span class="paper-absent-badge" title="Самосвал больше не приедет" aria-label="Самосвал больше не приедет">Д</span>' : '';
        for(let i=0; i<mT; i++) { if(l[i]) { let commHtml = l[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l[i].comment)}</div>` : ''; cells += `<td><div class="cell-content"><div class="paper-time">${escapeHtml(l[i].timeStr)}</div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l[i].createdByEmail, l[i].createdBy))}</div>${commHtml}</div></td>`; }
          else cells += '<td></td>';
        } return `<tr><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.name)} <span class="paper-truck-volume">Рейсов: ${l.length}</span>${dupHtml}</div></td>${cells}</tr>`; }).join('');
      html = `<div style="position:relative;" id="archive-paper-wrapper"><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(objectTitle(s.objectId,s.objectName))} (ГАИ)</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div><div class="paper-total-info">Рейсов ГАИ: <b>${gaiLogs.length}</b></div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th>${hC}</tr></thead><tbody>${mH}</tbody></table></div></div></div>`;
    }
    // Секции provenance/истории ревизий необязательны: без модуля 45 или без
    // провайдера данных отчёт архива выглядит и работает как раньше.
    const metaHtml = typeof renderArchiveMetaSections === 'function' ? renderArchiveMetaSections(s) : '';
    document.getElementById('modalArchiveBody').innerHTML = toggleBtnHtml + html + metaHtml;
    const keepWrapper=document.getElementById('modalArchiveBody').querySelector('.paper-scroll-wrapper');
    if (keepWrapper && keepScrollLeft) keepWrapper.scrollLeft = keepScrollLeft;
  }
  function closeArchiveModal() { document.getElementById('archiveModal').classList.remove('open'); viewingArchiveId=null; if (typeof window !== 'undefined') window.__wtArchiveRevisionView = null; }
  async function restoreArchiveToShift() {
    if(state.shift?.closing){showError('Сначала завершите закрытие текущей смены');return;}
    if (!requireEdit('archive_edit') || !viewingArchiveId) return;
    const s = state.archive.find(x => x.id === viewingArchiveId); if (!s) return;
    if(isNasRuntime()){
      // Решение владельца 23.11.2026: архивная смена восстанавливается для
      // правок параллельно с активной сменой линии — закрывать её не нужно.
      const hasActive = state.shift && state.shift.isActive;
      const msg = hasActive
        ? `Восстановить смену «${objectTitle(s.objectId,s.objectName)}» от ${s.date} для правок?\n\nАктивная смена «${objectTitle(state.shift.objectId,state.shift.objectName)}» продолжит работать — восстановленная смена редактируется параллельно.`
        : `Восстановить смену «${objectTitle(s.objectId,s.objectName)}» от ${s.date}?`;
      if(!(await appConfirm(msg)))return;
      // v2-путь (design §5.6): сервер открывает restored-контекст, клиент
      // показывает карточку «Восстановленная смена» и правит рейсы через
      // POST /api/v2/archives/{id}/operations. Активная смена и active-таблицы
      // не затрагиваются. Без живого моста остаётся прежний честный отказ.
      if(typeof nasRestoredV2Ready==='function'&&nasRestoredV2Ready()){
        try{
          await nasRestoreArchivedShift(viewingArchiveId);
          closeArchiveModal();
          showToastEl(hasActive?'✅ Архивная смена восстановлена для правок — параллельно с активной':'✅ Архивная смена восстановлена для правок',false);
        }catch(error){
          showError(error&&error.message?error.message:'Не удалось восстановить архивную смену: данные не изменены.');
        }
        return;
      }
      try{await nasArchiveAction('archive.restore',viewingArchiveId);closeArchiveModal();showToastEl(hasActive?'✅ Архивная смена восстановлена для правок — параллельно с активной':'Смена восстановлена на Ubuntu',false);}
      catch(error){
        // На канонической схеме (миграция 025) старый путь восстановления
        // запрещён: restored archive не становится активной сменой (design
        // §4.7, §3.4), его место — restored_shift_contexts, у которого пока нет
        // маршрута. Сервер отвечает стабильным кодом, и пользователь должен
        // увидеть причину, а не «api-http-409».
        const code = error && (error.serverCode || error.code);
        if (code === 'archive-restore-requires-v2') showError('Восстановление архивной смены в этом режиме недоступно: смена не создана, данные архива не изменены. Обратитесь к администратору.');
        else showError('Ошибка восстановления: ' + error.message);
      }return;
    }
    // Firebase-путь восстановления архива удалён (очистка 2026-11-23):
    // Ubuntu — единственный сервер данных, Firebase-режим недостижим.
    showError('Восстановление недоступно: нет связи с сервером Ubuntu.');
  }
  // «Удалить» зависит от открытого листочка: обычный лист — весь архив в корзину,
  // лист ГАИ — только рейсы ГАИ этого архива, остальные данные не меняются.
  async function deleteArchiveShift() {
    if(!requireEdit('archive_delete') || !viewingArchiveId) return;
    const s = state.archive.find(x=>x.id===viewingArchiveId); if(!s) return;
    const gaiMode = viewingArchiveGAITable === true;
    const dateText = s.date || '';
    const gaiTrips = (s.logs||[]).filter(l=>l.isGAI).length;
    try {
      if (gaiMode) {
        if (!gaiTrips) { showError('В этом архиве нет рейсов ГАИ.'); return; }
        if (!(await appConfirm(`Вы действительно хотите удалить листочек ГАИ за ${dateText}? Обычный лист и остальные данные архива останутся без изменений.`))) return;
        if (isNasRuntime()) {
          await nasArchiveAction('archive.gai.delete', viewingArchiveId);
        } else {
          const logs = (s.logs||[]).filter(l=>!l.isGAI);
          await tfAwait(refs.archive.doc(viewingArchiveId).update({
            logs,
            totalVolume: logs.reduce((total,l)=>total+Number(l.volume||0),0),
            totalTrips: logs.length,
            gaiDeletedAt: Date.now(),
            gaiDeletedBy: getUserName(),
          }));
        }
        addAudit(`🗑 Удалён листочек ГАИ за ${dateText}`).catch(()=>{});
        showToastEl('Листочек ГАИ удалён. Остальной архив сохранён.', false);
        viewingArchiveGAITable = false;
        const fresh = state.archive.find(x=>x.id===viewingArchiveId);
        if (fresh) renderArchiveModalContent(fresh); else closeArchiveModal();
        return;
      }
      if (!(await appConfirm(`Удалить весь архив за ${dateText}? Смена уйдёт в корзину, обычный лист и лист ГАИ.`))) return;
      if (isNasRuntime()) { await nasArchiveAction('archive.trash', viewingArchiveId); closeArchiveModal(); return; }
      await tfAwait(refs.trash.doc().set({ shift: s, deletedAt: Date.now(), deletedBy: getUserName() }));
      await tfAwait(refs.archive.doc(viewingArchiveId).delete());
      closeArchiveModal();
    } catch(e){ showError(e.message); }
  }

  // === СЕЛЕКТОР ===
