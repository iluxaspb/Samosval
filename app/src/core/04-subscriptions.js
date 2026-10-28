  function startSync() {
    stopSync();
    unsubscribers.push(refs.trucks.onSnapshot({ includeMetadataChanges: true }, s => { state.trucks = s.docs.map(d => Object.assign({id:d.id}, d.data())); markSync('trucks', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); scheduleRenderForTab('trucks', 'renderGlobalTrucksManage'); scheduleRenderForTab('line', 'renderLine'); scheduleRender('renderHeaderStats'); }, e=>reportSyncError('trucks', e)));
    unsubscribers.push(refs.objects.onSnapshot({ includeMetadataChanges: true }, s => { state.objects = s.docs.map(d => Object.assign({id:d.id}, d.data())); markSync('objects', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); scheduleRenderForTab('trucks', 'renderGlobalObjectsManage'); }, e=>reportSyncError('objects', e)));
    unsubscribers.push(refs.logs.onSnapshot({includeMetadataChanges:true},receiveLoadLogs,e=>reportSyncError('logs',e)));
    unsubscribers.push(refs.truckStatus.onSnapshot({includeMetadataChanges:true},receiveTruckStatuses,e=>reportSyncError('status',e)));
    unsubscribers.push(refs.shift.onSnapshot({ includeMetadataChanges: true }, doc => { state.shift = doc.exists ? Object.assign({id:doc.id}, doc.data()) : null; offlineProjectState();markSync('shift', doc.metadata.fromCache, doc.metadata.hasPendingWrites, doc.exists?1:0); if(!initialized) initialized=true; saveCache(); scheduleRender('renderAll'); }, e=>reportSyncError('shift', e)));
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
    unsubscribers.push(appConfigRef.onSnapshot(doc => { if (doc.exists) { let d = doc.data(); if(Number.isFinite(d.cycleMinutes)){settings.cycleMinutes=Math.max(15,d.cycleMinutes);localStorage.setItem('dt_settings_test347',JSON.stringify(settings));} appConfig = { maxEnabled: !!d.maxEnabled, maxUrl: d.maxUrl || '', maxToken: d.maxToken || '', maxChatId: d.maxChatId || '', notifyStart: d.notifyStart !== undefined ? !!d.notifyStart : true, notifyArrive: d.notifyArrive !== undefined ? !!d.notifyArrive : true, notifyLoad: d.notifyLoad !== undefined ? !!d.notifyLoad : true, notifyTtn: d.notifyTtn !== undefined ? !!d.notifyTtn : true, notifyLineStart: d.notifyLineStart !== undefined ? !!d.notifyLineStart : true, notifyLineEnd: d.notifyLineEnd !== undefined ? !!d.notifyLineEnd : true, testReviewFlags: d.testReviewFlags || {}, gameRewardSchedule: Array.isArray(d.gameRewardSchedule) ? d.gameRewardSchedule : [] }; renderAppSettingsIfActive(); if (appConfig.maxEnabled && appConfig.maxUrl) runMaxQueue(); } window.__gameConfigChanged?.(); }, e => console.warn(e)));

    // === SECURITY: права и флаг готовности ===
    unsubscribers.push(permsRef.onSnapshot({ includeMetadataChanges: true }, doc => {
      markSync('permissions', doc.metadata.fromCache, doc.metadata.hasPendingWrites, doc.exists ? 1 : 0);
      if (doc.exists) {
        permissionsConfig = doc.data();
      } else {
        permsRef.set(DEFAULT_PERMISSIONS).catch(e=>console.warn(e));
        permissionsConfig = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
      }
      permissionsLoaded = true;
      document.body.setAttribute('data-perms-ready', '1');
      updateNavUI();
      applyRoleUI();
      renderAll();
    }, e => {
      reportSyncError('permissions', e);
      permissionsLoaded = false;
      permissionsConfig = {};
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

  const requestSyncStatus = {requests:false,users:false,errors:{}};
  function pendingRegistrationRequests() {
    const result=[];
    (state.requests||[]).forEach(r=>{
      if(r.status && r.status!=='pending') return;
      const user=(state.users||[]).find(u=>u.id===r.uid || (u.email&&u.email===r.email));
      if(user && user.status!=='pending') return;
      result.push({...r,uid:r.uid||user?.id||null});
    });
    (state.users||[]).filter(u=>u.status==='pending').forEach(u=>{
      if(!result.some(r=>r.uid===u.id || (r.email&&r.email===u.email))) result.push({id:u.id,uid:u.id,email:u.email,nickname:u.nickname,createdAt:u.createdAt||0});
    });
    return result.sort((a,b)=>(Number(b.createdAt)||0)-(Number(a.createdAt)||0));
  }
  function renderRegistrationRequests() {
    if(!canAdmin())return;
    const container=document.getElementById('requestsListContainer');if(!container)return;
    const list=pendingRegistrationRequests();
    const count=document.getElementById('pendingCount');if(count)count.textContent=list.length;
    const messages=Object.entries(requestSyncStatus.errors).map(([source,error])=>source+': '+error);
    container.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px"><strong>Заявки на регистрацию · '+list.length+'</strong><button class="btn btn-secondary btn-small" id="refreshRegistrationRequestsBtn">Обновить заявки</button></div>'
      +(messages.length?'<div style="padding:10px;margin-bottom:12px;color:var(--warning);font-size:12px">Не удалось полностью загрузить заявки: '+escapeHtml(messages.join('; '))+'</div>':'')
      +(list.length?list.map(r=>`<div class="user-row"><div class="user-row-top"><div><strong>${escapeHtml(r.email)}</strong><div style="font-size:12px;color:var(--muted)">${escapeHtml(r.nickname||'')}</div></div><div class="pending-badge">Ожидает</div></div><div class="user-row-bottom"><select id="req_role_${escapeHtml(r.id)}" class="form-control" style="padding:6px;font-size:12px">${Object.keys(ROLES).map(role=>`<option value="${role}" ${role==='viewer'?'selected':''}>${escapeHtml(ROLES[role].label)}</option>`).join('')}</select><button class="btn btn-quick btn-small" data-approve-request="${escapeHtml(r.id)}">Подтвердить</button><button class="btn btn-secondary btn-small" data-reject-request="${escapeHtml(r.id)}">Отклонить</button></div></div>`).join(''):'<div class="empty-state">'+(requestSyncStatus.requests&&requestSyncStatus.users&&!messages.length?'Нет заявок':messages.length?'Проверьте доступ к базе и нажмите «Обновить заявки»':'Загружаем заявки и ожидающие учётки…')+'</div>');
    container.querySelector('#refreshRegistrationRequestsBtn').onclick=()=>refreshRegistrationRequests();
    container.querySelectorAll('[data-approve-request]').forEach(b=>b.onclick=()=>approveRequest(b.dataset.approveRequest));
    container.querySelectorAll('[data-reject-request]').forEach(b=>b.onclick=()=>rejectRequest(b.dataset.rejectRequest));
    updateAdminBadge();
  }
  function acceptRegistrationSnapshot(source,snapshot) {
    if(!canAdmin())return;
    const records=snapshot.docs.map(d=>({...d.data(),id:d.id}));
    if(source==='users')state.users=records;else state.requests=records;
    markSync(source,!!snapshot.metadata?.fromCache,!!snapshot.metadata?.hasPendingWrites,records.length);
    if(!snapshot.metadata?.fromCache)requestSyncStatus[source]=true;
    delete requestSyncStatus.errors[source];
    renderRegistrationRequests();
    if(document.getElementById('tab-admin')?.classList.contains('active'))renderAdminPanel();
  }
  function registrationSyncError(source,error) {
    requestSyncStatus.errors[source]=(error.code||'unknown')+' · '+(error.message||String(error));
    reportSyncError(source,error);renderRegistrationRequests();
  }
  let refreshingRegistrationRequests=false;
  async function refreshRegistrationRequests() {
    if(!canAdmin()||refreshingRegistrationRequests)return;
    refreshingRegistrationRequests=true;
    try {
      const sources=['requests','users'];
      const results=await Promise.allSettled([requestsRef.get({source:'server'}),usersRef.get({source:'server'})]);
      results.forEach((result,index)=>{if(result.status==='fulfilled')acceptRegistrationSnapshot(sources[index],result.value);else registrationSyncError(sources[index],result.reason);});
    }finally{refreshingRegistrationRequests=false;}
  }
  function startAdminSync() {
    if(!canAdmin())return;
    if(reqsUnsubscriber)reqsUnsubscriber();
    if(usersUnsubscriber)usersUnsubscriber();
    requestSyncStatus.requests=false;requestSyncStatus.users=false;requestSyncStatus.errors={};
    // Sort on the client so legacy records without createdAt are also included.
    reqsUnsubscriber=requestsRef.onSnapshot({includeMetadataChanges:true},snapshot=>acceptRegistrationSnapshot('requests',snapshot),error=>registrationSyncError('requests',error));
    usersUnsubscriber=usersRef.onSnapshot({includeMetadataChanges:true},snapshot=>acceptRegistrationSnapshot('users',snapshot),error=>registrationSyncError('users',error));
    renderRegistrationRequests();
  }
  function updateAdminBadge() {
    const badge=document.getElementById('navAdminBadge');if(!badge)return;
    const count=pendingRegistrationRequests().length;
    badge.style.display=count?'block':'none';badge.textContent=count;
  }

  // === ПЛАГИНЫ ===
  let pluginDisposers = [];
  function retiredTabelPlugin(p){return p.id==='builtin-tabel'||(/табель/i.test(p.name||'')&&/1\.1\.0-test\.3/.test((p.version||'')+' '+(p.code||'')));}
  function getPluginRecords() {
    const bundled = firebaseConfig.projectId === 'samosval-test' ? (window.SamosvalBundledPlugins || []) : [];
    const ids = new Set(bundled.map(p => p.id));
    return [...bundled.map(p => ({...p, ...(state.plugins.find(x => x.id === p.id) || {}), bundled: true})),
      ...state.plugins.filter(p => !ids.has(p.id))].filter(p=>!retiredTabelPlugin(p));
  }
  function initPlugins() {
    const activePlugin = Object.keys(pluginTabs).find(id => pluginTabs[id].container.classList.contains('active'));
    pluginDisposers.splice(0).forEach(dispose => { try { Promise.resolve(dispose()).catch(console.error); } catch(e) { console.error(e); } });
    document.getElementById('plugin-tabs-container').innerHTML = '';
    document.querySelectorAll('.dynamic-nav-btn').forEach(el => el.remove());
    pluginTabs = {}; pluginPdfButtons = [];
    const enabled = getPluginRecords().filter(p => { if (p.removed || !p.enabled) return false; if (!p.allowedRoles || p.allowedRoles.length === 0) return true; return p.allowedRoles.includes(currentUserRole); });
    enabled.forEach(p => {
      try {
        const ctx = {
          onDispose: fn => { if (typeof fn === 'function') pluginDisposers.push(fn); },
          ledgerHost: {
            workspace: wsRef,
            session: () => ({projectId: firebaseConfig.projectId, workspaceId: WORKSPACE_ID,
              uid: currentUid, name: getUserName(), role: currentUserRole, status: currentUserStatus,
              tabAccess: permissionsLoaded && currentUserStatus === 'active' && hasTabAccess('timesheet')
                && (!p.allowedRoles || !p.allowedRoles.length || p.allowedRoles.includes(currentUserRole)),
              manage: hasPermission('timesheet_manage'),
              permissions: {view: hasTabAccess('timesheet'), edit: hasPermission('timesheet_edit')}}),
            data: () => ({objects: state.objects, shift: state.shift, trucks: state.trucks,
              statuses: state.truckStatus, logs: state.logs, audit: state.audit, archive: state.archive}),
            transaction: fn => (window.__historyRawTransaction || db.runTransaction.bind(db))(fn),
            serverTimestamp: () => firebase.firestore.FieldValue.serverTimestamp(),
            leave: () => switchTab('line', document.getElementById('nav-line'))
          },
          db: db, refs: refs, state: state, user: { email: currentEmail, role: currentUserRole, name: getUserName() },
          showToast: showToastEl, addAudit: addAudit, escapeHtml: escapeHtml, renderRussianPlate: renderRussianPlate,
          registerTab: (id, name, icon, renderFn) => {
            const tabId = 'plugin-' + id;
            const btn = document.createElement('button');
            btn.className = 'nav-btn dynamic-nav-btn'; btn.id = 'nav-' + tabId;
            btn.innerHTML = `<span class="nav-icon">${icon}</span><span class="nav-text">${name}</span>`;
            btn.onclick = () => switchTab(tabId, btn);
            const nav = document.getElementById('bottomNav'); const archiveBtn = document.getElementById('nav-archive');
            nav.insertBefore(btn, archiveBtn);
            const tabDiv = document.createElement('div'); tabDiv.className = 'tab-content'; tabDiv.id = 'tab-' + tabId;
            document.getElementById('plugin-tabs-container').appendChild(tabDiv);
            pluginTabs[tabId] = { render: renderFn, container: tabDiv };
          },
          registerPdfButton: (label, generateHtmlFn) => { pluginPdfButtons.push({ label, generateHtmlFn }); }
        };
        const run = new Function('ctx', p.code); run(ctx);
      } catch (e) { console.error(`Ошибка в плагине "${p.name}":`, e); showToastEl(`⚠️ Ошибка в "${p.name}": ${e.message}`, true); }
    });
    renderPluginPdfButtons();
    if (activePlugin) {
      const next = pluginTabs[activePlugin] ? activePlugin : 'line';
      switchTab(next, document.getElementById('nav-' + next));
    }
  }
  function renderPluginPdfButtons() {
    const c = document.getElementById('pluginPdfButtonsContainer'); if (!c) return;
    c.innerHTML = '';
    pluginPdfButtons.forEach((p, idx) => {
      const btn = document.createElement('button'); btn.className = 'btn btn-secondary btn-small'; btn.style.flex = '1';
      btn.textContent = `🖼 ${String(p.label).replace(/\bPDF\b/gi, 'PNG')}`;
      btn.onclick = async () => {
        try { showToastEl('⏳ Подготовка PNG...', false); const html = p.generateHtmlFn(); const blob = await generatePNGFromHTML(html); downloadReportPNG(blob, `plugin_${idx}_${Date.now()}.png`); showToastEl('✅ PNG готов', false); }
        catch(e) { showError('Ошибка PNG: ' + e.message); }
      };
      c.appendChild(btn);
    });
  }
  function renderPluginsList() {
    const c = document.getElementById('pluginsListContainer'); if (!c) return;
    const records = getPluginRecords().filter(p => !p.removed);
    const restore = getPluginRecords().filter(p => p.bundled && p.removed).map(p => `<button class="btn btn-secondary" onclick="togglePluginStatus('${p.id}',true)">Восстановить ${escapeHtml(p.name)}</button>`).join('');
    if (!records.length) { c.innerHTML = '<div class="empty-state">Нет добавленных расширений</div>'+restore; return; }
    c.innerHTML = records.map(p => {
      let rolesText = (p.allowedRoles || []).map(r => ROLES[r]?.label || r).join(', ') || 'Все роли';
      return `<div class="user-row" style="border-color: ${p.enabled ? 'var(--success)' : 'var(--border)'};"><div class="user-row-top"><div style="font-size: 16px; font-weight: bold;">${escapeHtml(p.icon || '🧩')} ${escapeHtml(p.name)}${p.bundled ? ' · '+escapeHtml(p.version || '') : ''}</div><label class="toggle-switch" style="transform: scale(0.8); margin: 0;"><input type="checkbox" ${p.enabled ? 'checked' : ''} onchange="togglePluginStatus('${p.id}', this.checked)"><span class="toggle-slider"></span></label></div><div style="font-size: 11px; color: var(--muted); margin-bottom: 8px;">Доступ: ${rolesText}</div><div class="user-row-bottom" style="justify-content: flex-end;"><button class="btn-edit" onclick="openPluginModal('${p.id}')">✏️ Код</button><button class="btn-del" onclick="deletePlugin('${p.id}')">Удалить</button></div></div>`;
    }).join('')+restore;
  }
  function openPluginModal(id) {
    if (!canAdmin()) return;
    const p = id ? getPluginRecords().find(x => x.id === id) : null;
    document.getElementById('editPluginId').value = id || '';
    document.getElementById('pluginName').value = p ? p.name : '';
    document.getElementById('pluginIcon').value = p ? p.icon : '🧩';
    document.getElementById('pluginCode').value = p ? p.code : `// Пример кода плагина\nctx.registerTab('my-tab', 'Моя вкладка', '📌', (container) => {\n  container.innerHTML = '<h2>Привет!</h2>';\n});`;
    document.getElementById('pluginModalTitle').textContent = p ? 'Редактировать расширение' : 'Новое расширение';
    const roleCheckboxes = document.querySelectorAll('#pluginRolesContainer input[type="checkbox"]');
    roleCheckboxes.forEach(chk => { if (p) chk.checked = (p.allowedRoles || []).includes(chk.value); else chk.checked = true; });
    document.getElementById('pluginEditModal').classList.add('open');
  }
  function closePluginModal() { document.getElementById('pluginEditModal').classList.remove('open'); }
  async function clearPluginCode() { const textarea = document.getElementById('pluginCode'); if (textarea && (await appConfirm('Очистить окно с кодом?'))) textarea.value = ''; }
  async function pastePluginCode() {
    const textarea = document.getElementById('pluginCode'); if (!textarea) return;
    try { const text = await navigator.clipboard.readText(); textarea.value = text; showToastEl('📋 Код вставлен', false); }
    catch (err) { showToastEl('⚠️ Браузер заблокировал вставку', true); }
  }
  async function savePlugin() {
    if (!canAdmin()) return;
    const id = document.getElementById('editPluginId').value;
    const name = document.getElementById('pluginName').value.trim();
    const icon = document.getElementById('pluginIcon').value.trim() || '🧩';
    const code = document.getElementById('pluginCode').value;
    const allowedRoles = Array.from(document.querySelectorAll('#pluginRolesContainer input:checked')).map(chk => chk.value);
    if (!name) { showError('Введите название'); return; }
    try { if (id) await tfAwait(refs.plugins.doc(id).set({ name, icon, code, allowedRoles }, {merge:true})); else await tfAwait(refs.plugins.add({ name, icon, code, allowedRoles, enabled: true, createdAt: Date.now() })); closePluginModal(); showToastEl('✅ Расширение сохранено', false); }
    catch(e) { showError(e.message); }
  }
  async function togglePluginStatus(id, enabled) { if (!canAdmin()) return; try { await tfAwait(refs.plugins.doc(id).set({ enabled, removed:false }, {merge:true})); } catch(e) { showError(e.message); } }
  async function deletePlugin(id) { if (!canAdmin() || !(await appConfirm('Удалить расширение?'))) return; try { if (getPluginRecords().find(p => p.id === id)?.bundled) await tfAwait(refs.plugins.doc(id).set({ enabled:false, removed:true }, {merge:true})); else await tfAwait(refs.plugins.doc(id).delete()); } catch(e) { showError(e.message); } }

  // === АВТОРИЗАЦИЯ ===
  auth.onAuthStateChanged(async user => {
    if (user) {
      stopSync();
      permissionsLoaded = false;
      permissionsConfig = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
      document.body.removeAttribute('data-perms-ready');
      currentEmail = user.email || ''; currentUid = user.uid || '';
      currentUserRole = null; currentUserStatus = null; currentUserNickname = ''; activeProfileKey = '';
      initialized = false; confirmedLoadIds.clear();
      syncState = { fromCache:{}, everConnected:{}, docCount:{}, pendingWrites:{}, lastSuccessAt:0, errors:{} };
      state = { trucks:[], objects:[], logs:[], truckStatus:{}, shift:null, archive:[], trash:[], audit:[], notifications:[], users:[], requests:[], plugins:[], patches:[] };
      loadCache(); offlineRemoteStatuses={...state.truckStatus};offlineRemoteLogs=state.logs.slice();offlineProjectState(); renderAll();
      document.getElementById('userBadgeLabel').textContent = '👤 Проверка учётной записи…';
      updateSyncUI();
      document.getElementById('authOverlay').style.display = 'none';
      const forced = isForcedAdminEmail(currentEmail); const defaultNick = sanitizeName(currentEmail);
      if (userDocUnsubscriber) userDocUnsubscriber();
      userDocUnsubscriber = usersRef.doc(currentUid).onSnapshot({ includeMetadataChanges:true }, async snap => {
        try {
        if (currentUid !== user.uid) return;
        markSync('profile', snap.metadata.fromCache, snap.metadata.hasPendingWrites, snap.exists ? 1 : 0);
        if (!snap.exists && snap.metadata.fromCache) { updateSyncUI(); return; }
        if (!snap.exists) {
          if (forced) await usersRef.doc(currentUid).set({ email: currentEmail, nickname: defaultNick, role: 'admin', status: 'active', createdAt: Date.now(), bootstrap: true });
          else { await ensurePendingAccount(user); return; }
        }
        const data = snap.exists ? snap.data() : {};
        currentUserRole = data.role || (forced ? 'admin' : 'viewer');
        currentUserStatus = data.status || (forced ? 'active' : 'pending');
        currentUserNickname = data.nickname || defaultNick;
        if (snap.exists && !data.nickname && defaultNick && !forced) { usersRef.doc(currentUid).set({ nickname: defaultNick }, { merge: true }).catch(()=>{}); currentUserNickname = defaultNick; }
        if (forced && (currentUserRole !== 'admin' || currentUserStatus !== 'active')) { await usersRef.doc(currentUid).set({ role: 'admin', status: 'active', nickname: currentUserNickname || defaultNick }, { merge: true }); currentUserRole = 'admin'; currentUserStatus = 'active'; }
        if (currentUserStatus === 'pending') {
          try { await ensurePendingAccount(user); document.getElementById('registrationStatusText').textContent='Ваша заявка отправлена. Ожидайте решения администратора.'; }
          catch(e) { document.getElementById('registrationStatusText').textContent='Заявка не отправлена: ' + (e.message || e.code) + '. Обратитесь к администратору.'; }
          activeProfileKey = ''; stopSync(); document.getElementById('pendingScreen').style.display = 'flex'; document.getElementById('disabledScreen').style.display = 'none'; document.getElementById('mainHeader').style.display = 'none'; document.querySelector('.container').style.display = 'none'; document.querySelector('nav').style.display = 'none'; return; }
        if (currentUserStatus === 'disabled') {
          permissionsLoaded=false;document.body.removeAttribute('data-perms-ready');
          cancelHold();document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelectorAll('.modal.open').forEach(d=>d.classList.remove('open'));
          window.__gameAccessChanged?.();
          document.getElementById('disabledStatusTitle').textContent=data.rejectionReason?'Заявка отклонена':'Доступ временно ограничен';
          document.getElementById('disabledStatusText').textContent=data.rejectionReason||'Доступ ограничен администратором. Обратитесь к администратору, чтобы восстановить доступ, или попробуйте войти позже.';
          activeProfileKey='';stopSync();document.getElementById('pendingScreen').style.display='none';document.getElementById('disabledScreen').style.display='flex';document.getElementById('mainHeader').style.display='none';document.querySelector('.container').style.display='none';document.querySelector('nav').style.display='none';return;
        }
        document.getElementById('pendingScreen').style.display = 'none'; document.getElementById('disabledScreen').style.display = 'none'; document.getElementById('mainHeader').style.display = ''; document.querySelector('.container').style.display = ''; document.querySelector('nav').style.display = 'flex';
        updateUserBadge(); updateNavUI(); applyRoleUI(); updateSyncUI();
        const profileKey = currentUid + ':' + currentUserRole + ':' + currentUserStatus;
        if (activeProfileKey === profileKey) return;
        activeProfileKey = profileKey;
        startSync(); startAdminSync(); setTimeout(runMaxQueue, 1200);
        loadAndApplyPatches().catch(e => reportSyncError('patches', e));
        } catch(e) { reportSyncError('profile', e); }
      }, e => {
        stopSync(); permissionsLoaded = false; currentUserRole = null; activeProfileKey = '';
        document.body.removeAttribute('data-perms-ready');
        document.getElementById('userBadgeLabel').textContent = '👤 Учётная запись не загружена';
        reportSyncError('profile', e);
        renderAll();
      });
    } else {
      currentEmail = ''; currentUid = ''; currentUserRole = null; currentUserStatus = null; currentUserNickname = '';
      permissionsLoaded = false;
      document.body.removeAttribute('data-perms-ready');
      if (userDocUnsubscriber) { userDocUnsubscriber(); userDocUnsubscriber = null; }
      stopSync(); initialized = false; pendingOps = 0; confirmedLoadIds.clear();
      syncState = { fromCache: {}, everConnected: {}, docCount: {}, pendingWrites: {}, lastSuccessAt: 0 };
      state = { trucks:[], objects:[], logs:[], truckStatus:{}, shift:null, archive:[], trash:[], audit:[], notifications:[], users:[], requests:[], plugins:[], patches:[] };
      document.getElementById('authOverlay').style.display = 'flex'; document.getElementById('pendingScreen').style.display = 'none'; document.getElementById('disabledScreen').style.display = 'none';
      document.getElementById('mainHeader').style.display = ''; document.querySelector('.container').style.display = ''; document.querySelector('nav').style.display = 'flex';
      document.getElementById('userBadgeLabel').textContent = '👤 Войти'; updateSyncUI();
      // Firebase Auth сам восстанавливает сессию; пароль в браузере не храним.
      const savedEmail = localStorage.getItem('dt_saved_email_test347');
      if (savedEmail) document.getElementById('authEmail').value = savedEmail;
      document.getElementById('authPassword').value = '';
    }
  });

  function updateUserBadge() { const badge = document.getElementById('userBadgeLabel'); if (!badge) return; const roleInfo = ROLES[currentUserRole] || ROLES.viewer; const chip = `<span class="role-chip ${roleInfo.color}">${roleInfo.icon} ${roleInfo.label}</span>`; badge.innerHTML = `👤 ${escapeHtml(getUserName())} ${chip}`; }
  function applyRoleUI() {
    startTabelBackground();
    const versionAllowed = permissionsLoaded && canAdmin();
    if (versionAllowed) document.body.setAttribute('data-release-admin', '1'); else document.body.removeAttribute('data-release-admin');
    if (!versionAllowed) document.getElementById('releaseHistoryDialog')?.close();
    const viewBanner = document.getElementById('viewOnlyBanner'); const canDoAnything = hasPermission('start_shift') || hasPermission('edit_line') || hasPermission('action_load');
    if (viewBanner) viewBanner.style.display = (!canDoAnything && state.shift) ? 'block' : 'none';
    const requestBtn=document.getElementById('tabelCreateRequestBtn');if(requestBtn)requestBtn.style.display=hasTabAccess('timesheet')?'':'none';
    const startBtn = document.getElementById('startShiftBtn'); if (startBtn) startBtn.style.display = hasPermission('start_shift') ? '' : 'none';
    const truckForm = document.getElementById('truckFormCard'); if (truckForm) truckForm.style.display = hasPermission('manage_trucks') ? '' : 'none';
    const objectForm = document.getElementById('objectFormCard'); if (objectForm) objectForm.style.display = hasPermission('manage_objects') ? '' : 'none';
    const changeObjBtn = document.getElementById('changeObjBtn'); if (changeObjBtn) changeObjBtn.style.display = hasPermission('edit_line') ? 'inline-block' : 'none';
    const headerExtra = document.getElementById('headerExtraContent'); if (headerExtra) headerExtra.style.display = hasPermission('view_header') ? '' : 'none';
    const gaiToggleContainer = document.getElementById('gaiReportToggleContainer');
    if (gaiToggleContainer) { const canGai = hasPermission('view_gai_report'); gaiToggleContainer.style.display = canGai ? 'flex' : 'none'; if (!canGai) showGAITable = false; }
  }
