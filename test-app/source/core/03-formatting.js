  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function nowTimeStr() { return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
  function nowDateStr() { return new Date().toLocaleDateString('ru-RU'); }
  function formatIdleDuration(ms) { if (ms < 0) ms = 0; let s = Math.floor(ms/1000), h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60; return h > 0 ? h + ':' + pad2(m) + ':' + pad2(sec) : pad2(m) + ':' + pad2(sec); }
  function formatLoadAge(timestamp) {
    const seconds=Math.max(0,Math.floor((Date.now()-Number(timestamp))/1000));
    if(!Number(timestamp)||!Number.isFinite(seconds))return 'ещё не было';
    if(seconds<60)return 'только что';
    const minutes=Math.floor(seconds/60);
    if(minutes<60)return minutes+' мин назад';
    const hours=Math.floor(minutes/60),rest=minutes%60;
    if(hours<24)return hours+' ч'+(rest?' '+rest+' мин':'')+' назад';
    const days=Math.floor(hours/24),remaining=hours%24;
    return days+' д'+(remaining?' '+remaining+' ч':'')+' назад';
  }
  function formatTimeAgo(ts) { if (!ts) return '—'; let diff = Date.now() - ts; if (diff < 0) diff = 0; let s = Math.floor(diff/1000); if (s < 10) return 'только что'; if (s < 60) return s + ' сек. назад'; let m = Math.floor(s/60); if (m < 60) return m + ' мин. назад'; let h = Math.floor(m/60), mm = m%60; if (h < 24) return mm === 0 ? (h + ' ч. назад') : (h + ' ч. ' + mm + ' мин. назад'); return Math.floor(h/24) + ' дн. назад'; }
  function daysLeft(deletedAt) { let remain = (TRASH_DAYS * MS_PER_DAY) - (Date.now() - (deletedAt || 0)); return Math.max(0, Math.ceil(remain / MS_PER_DAY)); }
  function vibrate(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch(e){} }
  function vibArrive() { if (settings.hapticArrive) vibrate(12); }
  function vibLoad() { if (settings.hapticLoad) vibrate([15,30,15]); }
  function vibTtn() { if (settings.hapticTtn) vibrate(25); }

  function renderRussianPlate(numberStr) {
    let clean = String(numberStr == null ? '' : numberStr).replace(/\s+/g, '').trim();
    let m = clean.match(/^([а-яёa-z]{1})(\d{3})([а-яёa-z]{2})(\d{2,3})$/i);
    if (m) return `<div class="ru-plate"><div class="ru-plate-main"><span>${escapeHtml(m[1].toLowerCase())}</span><span class="plate-digit">${escapeHtml(m[2])}</span><span>${escapeHtml(m[3].toLowerCase())}</span></div><div class="ru-plate-region"><span class="region-code">${escapeHtml(m[4])}</span><span class="region-rus">RUS</span><div class="ru-plate-flag"><span></span><span></span><span></span></div></div></div>`;
    let formatted = escapeHtml(clean).replace(/\d+/g, d => `<span class="plate-digit">${d}</span>`);
    return `<div class="ru-plate"><div class="ru-plate-main">${formatted}</div></div>`;
  }
  function findTruck(id) { return state.trucks.find(t => t.id === id); }
  function truckLabelHtml(id, fallbackName) {
    let t = findTruck(id);
    if (!t) return fallbackName ? `<b>${escapeHtml(String(fallbackName).split(' ')[0])}</b> ${renderRussianPlate(String(fallbackName).split(' ').slice(1).join(' '))}` : '<b>Машина</b>';
    return `<b>${escapeHtml(t.brand)}</b> ${renderRussianPlate(t.number)}`;
  }
  function truckName(id) { let t = findTruck(id); return t ? `${t.brand} ${t.number}` : 'Машина'; }
  function getActiveLineIds() { return Object.keys(state.truckStatus).filter(id => state.truckStatus[id] && state.truckStatus[id].onLine === true); }
  // Reports, paper sheets, header totals and PDF must all see the same LOCAL
  // pending trips, even if an older Firestore cache snapshot arrives meanwhile.
  function getLogs() {
    const shiftId=state.shift?.id;
    if(!shiftId)return [];
    const logs=state.logs.filter(l=>l.shiftId===shiftId);
    const ids=new Set(logs.map(l=>l.id));
    for(const op of offlinePendingOps()){
      if(op.type!=='load'||op.shiftId!==shiftId)continue;
      if(ids.has('pending_'+op.id)||ids.has(op.logId))continue;
      const ts=Math.max(Number(op.createdAt)||0,Number(op.arrivalTimestamp||0)+1,Number(op.lastLoadTimestamp||0)+1);
      const log={id:'pending_'+op.id,offlinePending:true,offlineOperationId:op.id,
        shiftId,truckId:op.truckId,truckName:op.truckName||truckName(op.truckId),
        volume:Number(op.volume)||0,isGAI:!!op.isGAI,
        timeStr:new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),
        timestamp:ts,arrivalTimestamp:op.arrivalTimestamp||null,createdBy:op.actor,
        createdByEmail:op.email||'',comment:''};
      logs.push(log);ids.add(log.id);
    }
    return logs.sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
  }

  function sessionCacheKey() { return 'dt_cache_v14:' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + location.pathname + ':' + (currentUid || 'signed-out'); }
  function saveCache() { try { localStorage.setItem(sessionCacheKey(), JSON.stringify({ trucks: state.trucks, objects: state.objects, logs: offlinePendingCount()?offlineRemoteLogs:state.logs, truckStatus: offlinePendingCount()?offlineRemoteStatuses:state.truckStatus, shift: state.shift, archive: state.archive, trash: state.trash, audit: state.audit.slice(0, 100), lineAudit: state.lineAudit || [], notifications: (state.notifications || []).slice(0, 10), savedAt: Date.now() })); } catch(e) {} }
  function loadCache() { try { if (!currentUid) return; let raw = localStorage.getItem(sessionCacheKey()); if (!raw) return; let c = JSON.parse(raw); state.trucks = c.trucks||[]; state.objects = c.objects||[]; state.logs = c.logs||[]; state.truckStatus = c.truckStatus||{}; state.shift = c.shift||null; state.archive = c.archive||[]; state.trash = c.trash||[]; state.audit = c.audit||[]; state.lineAudit = c.lineAudit||[]; state.notifications = c.notifications||[]; } catch(e) {} }

  function markSync(source, fromCache, hasPendingWrites, docCount) {
    if (syncState.errors) delete syncState.errors[source];
    syncState.fromCache[source] = !!fromCache; syncState.docCount[source] = docCount || 0;
    if (!fromCache) { syncState.everConnected[source] = true; syncState.lastSuccessAt = Date.now(); if(source==='status'||source==='shift')offlineTransportRecovered(); }
    syncState.pendingWrites[source] = !!hasPendingWrites;
    if (!hasPendingWrites) delete syncState.pendingWrites[source];
    updateSyncUI();
  }
  function reportSyncError(source, error) {
    syncState.errors = syncState.errors || {};
    syncState.errors[source] = { code: error?.code || 'unknown', message: error?.message || String(error), at: Date.now() }; if(offlineTransportError(error))offlineTransportFailed(error);
    console.error('[sync:' + source + ']', error);
    updateSyncUI();
  }
  function getSyncStatus() {
    const queued=offlinePendingCount();
    if (offlineServerUnreachable || !navigator.onLine) return { state: 'offline', text: 'Работа локально' + (queued ? ` · действий к отправке: ${queued}` : '') };
    if (Object.keys(syncState.errors || {}).length) return {state:'error',text:'Ошибка загрузки: ' + Object.keys(syncState.errors).join(', ')};
    if (!currentUserRole) return {state:'init',text:'Проверка учётной записи…'};
    if (!initialized || !permissionsLoaded) return { state: 'init', text: 'Загрузка данных и прав…' };
    const required = ['profile','permissions','trucks','status','shift'];
    if (required.some(source => !syncState.everConnected[source] || syncState.fromCache[source])) return {state:'init',text:'Данные из кеша. Ожидаем подтверждения сервера…'};
    if (pendingOps > 0 || queued > 0) return { state: 'syncing', text: `Синхронизация... (${pendingOps + queued})` };
    const failures=offlineUnreviewedFailures().length;
    if(failures)return {state:'error',text:'Не подтверждено действий: '+failures+' · Нажмите индикатор для подробностей'};
    return { state: 'ok', text: 'Всё на сервере' };
  }
  function updateSyncUI() {
    const dot = document.getElementById('syncDot'), badge = document.getElementById('syncBadge');
    if (!dot) return;
    const st = getSyncStatus();
    const backend = getTestBackendIndicator(st);
    renderTestBackendControls(st);
    let notice = document.getElementById('sessionSyncNotice');
    if (!notice) { notice = document.createElement('div'); notice.id = 'sessionSyncNotice'; notice.style.cssText = 'padding:8px 12px;font-size:12px;background:#332611;color:#fcd34d;line-height:1.4'; document.getElementById('mainHeader')?.append(notice); }
    notice.hidden = !currentUid || st.state === 'ok' || st.state === 'syncing';
    notice.textContent = st.text + (st.state === 'error' ? ' · Нажмите точку синхронизации для подробностей.' : '');
    dot.className = 'sync-dot ' + st.state;
    dot.textContent = backend.letter;
    dot.dataset.provider = backend.provider;
    let tip = backend.label + ' · ' + TEST_BACKEND_MODE_LABELS[getTestBackendMode()] + ' · ' + st.text;
    if (syncState.lastSuccessAt && (st.state === 'ok' || st.state === 'offline')) tip += ' · ' + formatTimeAgo(syncState.lastSuccessAt);
    dot.parentElement.title = tip;
    dot.parentElement.setAttribute('aria-label', tip);
    if (badge) {const count=pendingOps+offlinePendingCount();if(count>0){badge.textContent=count>99?'99+':count;badge.classList.add('show');}else badge.classList.remove('show');}
  }
  function showSyncDiagnostics() {
    const sources = ['trucks','objects','logs','status','shift','archive','trash','audit','notifications','plugins','patches','users','requests'];
    let lines = ['── ДИАГНОСТИКА ──', '', `Online: ${navigator.onLine ? 'да' : 'НЕТ'}`, `Пользователь: ${currentEmail || '—'}`, `Роль: ${ROLES[currentUserRole]?.label || currentUserRole || '—'}`, `Права загружены: ${permissionsLoaded ? 'да' : 'нет'}`, `Приехал: ${hasPermission('action_arrive') ? 'разрешено' : 'нет права'}`, `Погрузка: ${hasPermission('action_load') ? 'разрешено' : 'нет права'}`, `pendingOps: ${pendingOps}`, `Max: ${appConfig.maxEnabled ? 'вкл' : 'выкл'}`, `Патчей: ${state.patches.length}`, ''];
    lines.push('Режим сервера: ' + TEST_BACKEND_MODE_LABELS[getTestBackendMode()], getTestBackendIndicator(getSyncStatus()).label);
    lines.push('Страница: ' + location.pathname, 'База: ' + firebaseConfig.projectId, 'UID: ' + (currentUid || '—'));
    Object.entries(syncState.errors || {}).forEach(([source,error]) => lines.push('ОШИБКА ' + source + ': ' + error.code + ' · ' + error.message));
    sources.forEach(s => { lines.push(`${s.padEnd(11)} | ${syncState.pendingWrites[s]?'ДА':'—'} | ${syncState.docCount[s]||0}`); });
    const rejected=offlineUnreviewedFailures();
    if(rejected.length) {
      lines.push('','── НЕПОДТВЕРЖДЁННЫЕ ДЕЙСТВИЯ ──');
      rejected.forEach(x=>lines.push(x.truckName||truckName(x.truckId),new Date(x.createdAt).toLocaleString('ru-RU'),offlineReasonLabel(x.result),''));
      lines.push('Карточки показывают итоговое серверное состояние.');
    }
    appNotice(lines.join('\n'));
    if(rejected.length) {
      const all=offlineJournalRead();
      all.forEach(x=>{if(x.status==='rejected')x.reviewed=true;});
      offlineJournalWrite(all);
    }
  }
  function stopSync() {
    lineCountAuditStop?.(); lineCountAuditStop = null; lineCountAuditKey = ''; state.lineAudit = [];
    unsubscribers.forEach(u => { try { u(); } catch(e){} }); unsubscribers = [];
    if (usersUnsubscriber) { try { usersUnsubscriber(); } catch(e){} usersUnsubscriber = null; }
    if (reqsUnsubscriber) { try { reqsUnsubscriber(); } catch(e){} reqsUnsubscriber = null; }
  }

