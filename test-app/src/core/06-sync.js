  function sessionCacheKey() { return 'dt_cache_v14:' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + location.pathname + ':' + (currentUid || 'signed-out'); }
  function saveCache() { try { localStorage.setItem(sessionCacheKey(), JSON.stringify({ trucks: state.trucks, objects: state.objects, logs: offlinePendingCount()?offlineRemoteLogs:state.logs, truckStatus: offlinePendingCount()?offlineRemoteStatuses:state.truckStatus, shift: state.shift, archive: state.archive, trash: state.trash, audit: state.audit.slice(0, 100), notifications: (state.notifications || []).slice(0, 10), savedAt: Date.now() })); } catch(e) {} }
  function loadCache() { try { if (!currentUid) return; let raw = localStorage.getItem(sessionCacheKey()); if (!raw) return; let c = JSON.parse(raw); state.trucks = c.trucks||[]; state.objects = c.objects||[]; state.logs = c.logs||[]; state.truckStatus = c.truckStatus||{}; state.shift = c.shift||null; state.archive = c.archive||[]; state.trash = c.trash||[]; state.audit = c.audit||[]; state.notifications = c.notifications||[]; } catch(e) {} }

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
    const ownership=offlineJournalOwnershipStatus();
    if(ownership)return {state:'error',text:ownership};
    if (offlineServerUnreachable || !navigator.onLine) return { state: 'offline', text: 'Работа локально' + (queued ? ` · действий к отправке: ${queued}` : '') };
    if (Object.keys(syncState.errors || {}).length) return {state:'error',text:'Ошибка загрузки: ' + Object.keys(syncState.errors).join(', ')};
    if (!currentUserRole) return {state:'init',text:'Проверка учётной записи…'};
    if (!initialized || !permissionsLoaded) return { state: 'init', text: 'Загрузка данных и прав…' };
    const required = ['profile','permissions','trucks','status','shift'];
    if (required.some(source => !syncState.everConnected[source] || syncState.fromCache[source])) return {state:'init',text:'Данные из кеша. Ожидаем подтверждения сервера…'};
    if (pendingOps > 0 || queued > 0) return { state: 'syncing', text: `Синхронизация... (${pendingOps + queued})` };
    const failures=offlineUnreviewedFailures().length;
    if(failures)return {state:'error',text:'Не подтверждено действий: '+failures+' · Нажмите индикатор для подробностей'};
    const effects=offlineUndeliveredEffects().length;
    if(effects)return {state:'syncing',text:'Действия сохранены · отправка журнала и уведомлений: '+effects};
    return { state: 'ok', text: 'Всё на сервере' };
  }
  function updateSyncUI() {
    const dot = document.getElementById('syncDot'), badge = document.getElementById('syncBadge');
    if (!dot) return;
    const st = getSyncStatus();
    let notice = document.getElementById('sessionSyncNotice');
    if (!notice) { notice = document.createElement('div'); notice.id = 'sessionSyncNotice'; notice.style.cssText = 'padding:8px 12px;font-size:12px;background:#332611;color:#fcd34d;line-height:1.4'; document.getElementById('mainHeader')?.append(notice); }
    notice.hidden = !currentUid || st.state === 'ok' || st.state === 'syncing';
    notice.textContent = st.text + (st.state === 'error' ? ' · Нажмите точку синхронизации для подробностей.' : '');
    dot.className = 'sync-dot ' + st.state;
    let tip = st.text;
    if (syncState.lastSuccessAt && (st.state === 'ok' || st.state === 'offline')) tip += ' · ' + formatTimeAgo(syncState.lastSuccessAt);
    dot.parentElement.title = tip;
    if (badge) {const count=pendingOps+offlinePendingCount();if(count>0){badge.textContent=count>99?'99+':count;badge.classList.add('show');}else badge.classList.remove('show');}
  }
  function showSyncDiagnostics() {
    const sources = ['trucks','objects','logs','status','shift','archive','trash','audit','notifications','plugins','patches','users','requests'];
    let lines = ['── ДИАГНОСТИКА ──', '', `Online: ${navigator.onLine ? 'да' : 'НЕТ'}`, `Пользователь: ${currentEmail || '—'}`, `Роль: ${ROLES[currentUserRole]?.label || currentUserRole || '—'}`, `Права загружены: ${permissionsLoaded ? 'да' : 'нет'}`, `Приехал: ${hasPermission('action_arrive') ? 'разрешено' : 'нет права'}`, `Погрузка: ${hasPermission('action_load') ? 'разрешено' : 'нет права'}`, `pendingOps: ${pendingOps}`, `Max: ${appConfig.maxEnabled ? 'вкл' : 'выкл'}`, `Патчей: ${state.patches.length}`, ''];
    lines.push('Страница: ' + location.pathname, 'База: ' + firebaseConfig.projectId, 'UID: ' + (currentUid || '—'));
    Object.entries(syncState.errors || {}).forEach(([source,error]) => lines.push('ОШИБКА ' + source + ': ' + error.code + ' · ' + error.message));
    sources.forEach(s => { lines.push(`${s.padEnd(11)} | ${syncState.pendingWrites[s]?'ДА':'—'} | ${syncState.docCount[s]||0}`); });
    const rejected=offlineUnreviewedFailures();
    if(rejected.length) {
      lines.push('','── НЕПОДТВЕРЖДЁННЫЕ ДЕЙСТВИЯ ──');
      rejected.forEach(x=>lines.push(x.truckName||truckName(x.truckId),new Date(x.createdAt).toLocaleString('ru-RU'),offlineReasonLabel(x.result,x.conflictDetails),''));
      lines.push('Карточки показывают итоговое серверное состояние.');
    }
    appNotice(lines.join('\n'));
    if(rejected.length&&offlineJournalCanWrite()) {
      const all=offlineJournalRead();
      all.forEach(x=>{if(x.status==='rejected')x.reviewed=true;});
      offlineJournalWrite(all);
    }
  }
  function stopSync() {
    unsubscribers.forEach(u => { try { u(); } catch(e){} }); unsubscribers = [];
    if (usersUnsubscriber) { try { usersUnsubscriber(); } catch(e){} usersUnsubscriber = null; }
    if (reqsUnsubscriber) { try { reqsUnsubscriber(); } catch(e){} reqsUnsubscriber = null; }
  }

  function setPermissionsNotice(message) {
    let el = document.getElementById('permissionsLoadNotice');
    if (!el) {
      const header = document.getElementById('mainHeader');
      if (!header) return;
      el = document.createElement('div');
      el.id = 'permissionsLoadNotice';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = 'display:none;background:#422006;color:#fde68a;padding:9px 12px;border-bottom:1px solid #b45309;font-size:12px;line-height:1.5';
      header.appendChild(el);
    }
    el.textContent = message || '';
    el.style.display = message && currentUid ? 'block' : 'none';
  }

  function startSync() {
    stopSync();
    unsubscribers.push(refs.trucks.onSnapshot({ includeMetadataChanges: true }, s => { state.trucks = s.docs.map(d => Object.assign({id:d.id}, d.data())); markSync('trucks', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); scheduleRenderForTab('trucks', 'renderGlobalTrucksManage'); scheduleRenderForTab('line', 'renderLine'); scheduleRender('renderHeaderStats'); }, e=>reportSyncError('trucks', e)));
    unsubscribers.push(refs.objects.onSnapshot({ includeMetadataChanges: true }, s => { state.objects = s.docs.map(d => Object.assign({id:d.id}, d.data())); markSync('objects', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); scheduleRenderForTab('trucks', 'renderGlobalObjectsManage'); }, e=>reportSyncError('objects', e)));
    unsubscribers.push(refs.logs.onSnapshot({includeMetadataChanges:true},receiveLoadLogs,e=>reportSyncError('logs',e)));
    unsubscribers.push(refs.truckStatus.onSnapshot({includeMetadataChanges:true},receiveTruckStatuses,e=>reportSyncError('status',e)));
    unsubscribers.push(refs.shift.onSnapshot({ includeMetadataChanges: true }, doc => { state.shift = doc.exists ? Object.assign({id:doc.id}, doc.data()) : null; offlineProjectState();window.dispatchEvent(new Event('road-shift-changed'));markSync('shift', doc.metadata.fromCache, doc.metadata.hasPendingWrites, doc.exists?1:0); if(!initialized) initialized=true; saveCache(); scheduleRender('renderAll'); }, e=>reportSyncError('shift', e)));
    unsubscribers.push(refs.archive.onSnapshot({ includeMetadataChanges: true }, s => { state.archive = s.docs.map(d => Object.assign({id:d.id}, d.data())); markSync('archive', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); scheduleRenderForTab('archive', 'renderArchive'); scheduleRenderForTab('analytics', 'renderAnalytics'); }, e=>reportSyncError('archive', e)));
    unsubscribers.push(refs.trash.onSnapshot({ includeMetadataChanges: true }, s => { state.trash = s.docs.map(d => Object.assign({id:d.id}, d.data())); state.trash.sort((a,b)=>(b.deletedAt||0)-(a.deletedAt||0)); markSync('trash', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); scheduleRenderForTab('archive', 'renderTrash'); }, e=>reportSyncError('trash', e)));
    unsubscribers.push(refs.audit.orderBy('timestamp','desc').limit(200).onSnapshot({includeMetadataChanges:true},s => { state.audit = s.docs.map(d => Object.assign({id:d.id}, d.data()));if(!s.metadata.hasPendingWrites)window.__historyAcceptAudit?.(state.audit); markSync('audit', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); scheduleRenderForTab('analytics', 'renderAnalytics'); }, e=>reportSyncError('audit', e)));
    unsubscribers.push(refs.notifications.orderBy('timestamp','desc').limit(50).onSnapshot({ includeMetadataChanges: true }, s => { state.notifications = s.docs.map(d => Object.assign({id:d.id}, d.data())); offlineProjectTicker(); markSync('notifications', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); renderStatusTicker(); }, e=>reportSyncError('notifications', e)));
    unsubscribers.push(refs.plugins.onSnapshot({ includeMetadataChanges: true }, s => { state.plugins = s.docs.map(d => Object.assign({id:d.id}, d.data())); markSync('plugins', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); initPlugins(); if (canAdmin() && document.getElementById('tab-admin')?.classList.contains('active')) renderPluginsList(); }, e=>reportSyncError('plugins', e)));
    if (canAdmin()) {
      unsubscribers.push(refs.patches.onSnapshot(s => {
        state.patches = s.docs.map(d => Object.assign({id:d.id}, d.data()));
        state.patches.sort((a, b) => (a.order || 0) - (b.order || 0));
        markSync('patches', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size);
        if (canAdmin() && document.getElementById('tab-admin')?.classList.contains('active')) renderPatchesList();
      }, e=>reportSyncError('audit', e)));
    }
    if (!canAdmin()) usersUnsubscriber = usersRef.onSnapshot(s => { state.users = s.docs.map(d => Object.assign({id:d.id}, d.data())); scheduleRenderForTab('report', 'renderReport'); scheduleRenderForTab('analytics', 'renderAnalytics'); scheduleRenderForTab('line', 'renderLine'); }, e=>console.warn(e));
    unsubscribers.push(appConfigRef.onSnapshot(doc => { if (doc.exists) { let d = doc.data(); if(Number.isFinite(d.cycleMinutes)){settings.cycleMinutes=Math.max(15,d.cycleMinutes);localStorage.setItem('dt_settings',JSON.stringify(settings));} appConfig = { maxEnabled: !!d.maxEnabled, maxUrl: d.maxUrl || '', maxToken: d.maxToken || '', maxChatId: d.maxChatId || '', notifyStart: d.notifyStart !== undefined ? !!d.notifyStart : true, notifyArrive: d.notifyArrive !== undefined ? !!d.notifyArrive : true, notifyLoad: d.notifyLoad !== undefined ? !!d.notifyLoad : true, notifyTtn: d.notifyTtn !== undefined ? !!d.notifyTtn : true, notifyLineStart: d.notifyLineStart !== undefined ? !!d.notifyLineStart : true, notifyLineEnd: d.notifyLineEnd !== undefined ? !!d.notifyLineEnd : true, testReviewFlags: d.testReviewFlags || {}, photoStorageLimitBytes: Number(d.photoStorageLimitBytes)||536870912 }; window.__gameConfigChanged?.(); renderConflictAuthorPatch(); renderAppSettingsIfActive(); if (appConfig.maxEnabled && appConfig.maxUrl) runMaxQueue(); } }, e => console.warn(e)));

    // === SECURITY: права и флаг готовности ===
    unsubscribers.push(permsRef.onSnapshot({ includeMetadataChanges: true }, doc => {
      markSync('permissions', doc.metadata.fromCache, doc.metadata.hasPendingWrites, doc.exists ? 1 : 0);
      // A missing cached document does not imply that the server settings are absent.
      // Never queue a default-permissions write without a server-confirmed absence.
      if (!doc.exists && doc.metadata.fromCache) {
        permissionsLoaded = false;
        permissionsConfig = {};
        document.body.removeAttribute('data-perms-ready');
        setPermissionsNotice('Права не найдены в офлайн-кэше. Вкладки временно скрыты до восстановления связи с Firebase; данные не удалены.');
        updateNavUI();
        applyRoleUI();
        return;
      }
      if (doc.exists) {
        permissionsConfig = doc.data();
      } else {
        permsRef.set(DEFAULT_PERMISSIONS).catch(e=>console.warn(e));
        permissionsConfig = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
      }
      permissionsLoaded = true;
      document.body.setAttribute('data-perms-ready', '1');
      setPermissionsNotice('');
      updateNavUI();
      applyRoleUI();
      renderAll();
    }, e => {
      reportSyncError('permissions', e);
      permissionsLoaded = false;
      permissionsConfig = {};
      setPermissionsNotice('Не удалось проверить права доступа. Разделы временно скрыты — проверьте соединение с Firebase. Данные не удалены.');
      showError('Не удалось загрузить права доступа. Обновите страницу или проверьте подключение.');
      document.body.removeAttribute('data-perms-ready');
      updateNavUI();
      applyRoleUI();
      renderAll();
    }));
  }

  function scheduleRenderLine() { if (renderLinePending) return; renderLinePending = true; setTimeout(() => { requestAnimationFrame(() => { renderLine(); renderLinePending = false; }); }, 50); }
  function scheduleRenderForTab(tabName, funcName) { let el = document.getElementById('tab-' + tabName); if (el && el.classList.contains('active') && typeof window[funcName] === 'function') { if (funcName === 'renderLine') scheduleRenderLine(); else window[funcName](); } }
  function scheduleRender(funcName) { if (typeof window[funcName] === 'function') window[funcName](); }

