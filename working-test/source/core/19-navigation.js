  function switchTab(name, btn) {
    if (name === 'admin' && !canAdmin()) { showError('Только админ'); return; }
    if (!name.startsWith('plugin-') && name !== 'admin' && !hasTabAccess(name)) { showError('Нет доступа'); return; }
    // === SECURITY: до загрузки прав разрешена только вкладка line ===
    if (!permissionsLoaded && name !== 'line' && name !== 'admin') {
      showError('Подождите, идёт загрузка прав...'); return;
    }
    document.querySelectorAll('.tab-content').forEach(e=>e.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(e=>e.classList.remove('active'));
    // Табель — обычная вкладка: при уходе на другую кнопку панели он закрывается.
    if (name !== 'tabel-v2' && globalThis.__tabelV2Instance) { try { globalThis.__tabelV2Instance.hide(); } catch(e){} }
    let t = document.getElementById('tab-'+name); if(t) t.classList.add('active');
    if(btn) btn.classList.add('active');
    window.scrollTo(0,0);
    // Always open Summary on the regular truck sheet; GAI is opt-in per visit.
    if (name === 'report') showGAITable = false;
    if (pluginTabs[name]) pluginTabs[name].render(pluginTabs[name].container); else renderAll();
  }

  window.addEventListener('DOMContentLoaded', () => {
    loadMaxQueue(); renderAll(); updateSyncUI();
    window.addEventListener('online', () => { offlineTransportRecovered(); updateSyncUI(); runMaxQueue(); offlineReplayJournal(); });
    window.addEventListener('offline', updateSyncUI);
    let e = localStorage.getItem('working-test-saved-email_test347'); if(e) document.getElementById('userBadgeLabel').textContent = '👤 ' + sanitizeName(e);
    document.getElementById('newTruckType').addEventListener('change', toggleVolInput);
    setTimeout(runMaxQueue, 2000);
    preloadTabelV2Modules();
  });
  setInterval(updateSyncUI, 3000);
  setInterval(offlineReplayJournal, 8000);
  setInterval(() => { if (maxQueue.length && !maxSenderRunning) runMaxQueue(); }, 20000);

  // Built-in test module. No plugin installation or production writes.
  let tabelV2Opening = false;
  // Индикатор «Открываю табель…» — показывается в момент нажатия кнопки,
  // пока грузятся модули tabel-v2 и справочник объектов (раньше до 8+ секунд
  // кнопка молчала и экран оставался пустым).
  function showTabelOpeningIndicator() {
    let overlay = document.getElementById('tabel-v2-opening');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'tabel-v2-opening';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.6);color:#fff;font:600 16px/1.4 system-ui,sans-serif;text-align:center;';
      overlay.textContent = 'Открываю табель…';
      document.body.append(overlay);
    }
    overlay.hidden = false;
  }
  function hideTabelOpeningIndicator() {
    const overlay = document.getElementById('tabel-v2-opening');
    if (overlay) overlay.remove();
  }
  async function openTabelV2(settingsOnly, requestFirst = false) {
    if (tabelV2Opening) return;
    tabelV2Opening = true;
    showTabelOpeningIndicator();
    try {
      // В режиме Ubuntu табель строится по справочнику объектов. Если справочник
      // ещё не пришёл, таблица открывается пустой — поэтому сначала дожидаемся его.
      if (isNasRuntime() && !(state.objects && state.objects.length)) {
        try {
          await Promise.race([
            refreshNasObjects(),
            new Promise(resolve => setTimeout(resolve, 8000))
          ]);
        } catch (e) { console.warn('Табель: справочник объектов', e.message); }
      }
      if (isNasRuntime() && !(state.objects && state.objects.length)) {
        showError('Справочник объектов ещё не загружен. Проверьте связь с сервером Ubuntu и откройте табель снова.');
        return;
      }
      const module = await import(new URL('./working-test/tabel-v2/entry.mjs', document.baseURI).href);
      await module.open(tabelV2Host(), settingsOnly, {requestFirst});
      // Табель — отдельный экран поверх приложения: активные вкладки (включая
      // «Админ → Сервер» с его внутренними кнопками) должны быть погашены,
      // иначе под табелем остаются чужие навигационные панели.
      document.querySelectorAll('.tab-content').forEach(e=>e.classList.remove('active'));
      // Табель подсвечивается в нижней панели, остальные вкладки гаснут.
      document.querySelectorAll('.nav-btn').forEach(e=>e.classList.remove('active'));
      const nb = document.getElementById('nav-tabel-v2'); if (nb) nb.classList.add('active');
    } catch (error) { showError(error.message || 'Табель не открылся'); } finally { hideTabelOpeningIndicator(); tabelV2Opening = false; }
  }

  // Фоновая предзагрузка модулей табеля: после старта приложения, в свободное
  // время (requestIdleCallback / setTimeout), грузим entry.mjs и workspace.css,
  // чтобы первый клик по «Табель» не ждал сети на медленном соединении.
  let tabelModulesPreloaded = false;
  function preloadTabelV2Modules() {
    if (tabelModulesPreloaded) return;
    tabelModulesPreloaded = true;
    const preload = () => {
      import(new URL('./working-test/tabel-v2/entry.mjs', document.baseURI).href)
        .catch(e => { tabelModulesPreloaded = false; console.warn('Табель: предзагрузка', e.message); });
      if (!document.querySelector('[data-tabel-v2-css]')) {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = new URL('./working-test/tabel-v2/workspace.css', document.baseURI);
        l.dataset.tabelV2Css = '';
        document.head.append(l);
      }
    };
    const ric = globalThis.requestIdleCallback;
    if (typeof ric === 'function') ric(preload, { timeout: 4000 }); else setTimeout(preload, 3000);
  }


  function tabelV2Host(){
      if(isNasRuntime())return nasTabelHost();
      const session = () => ({projectId: firebaseConfig.projectId, workspaceId: WORKSPACE_ID,
        uid: currentUid, name: getUserName(), role: currentUserRole, active: currentUserStatus === 'active',
        view: permissionsLoaded && hasTabAccess('timesheet'), edit: hasPermission('timesheet_edit'),
        tabelTabs: tabelTabViews(),
        objectId: state.shift && state.shift.objectId});
      return {session, workspace: wsRef, refs,
        users:async()=>state.users.length?state.users:(await usersRef.get()).docs.map(d=>({...d.data(),id:d.id})),
        transaction:fn=>db.runTransaction(fn),
        documentId:()=>(FIREBASE_SDK_PRESENT && typeof firebase!=='undefined' ? firebase.firestore.FieldPath.documentId() : 'firebase-unavailable'),
        get shift(){return state.shift;}, get objects(){return state.objects;},
        snapshot:()=>({shift:state.shift,trucks:state.trucks,statuses:state.truckStatus,logs:state.logs,audit:state.audit,lineAudit:state.lineAudit,archive:state.archive}),
        createObject:async(name,startDate)=>{
          if(!hasPermission('manage_objects')||currentUserStatus!=='active')throw Error('Нет права создавать объекты');
          name=String(name||'').trim();if(!name||name.length>180)throw Error('Введите название объекта');
          const existing=state.objects.find(o=>o.name.toLowerCase()===name.toLowerCase());if(existing)return {...existing};
          const ref=refs.objects.doc(),data={name,startDate,createdAt:Date.now(),createdBy:getUserName()};
          await tfAwait(ref.set(data));return {id:ref.id,...data};
        }

      };
  }
  let tabelBackgroundStarting=false;
  function startTabelBackground(){
    if(tabelBackgroundStarting||tabelV2Opening||!permissionsLoaded||currentUserStatus!=='active'||!hasTabAccess('timesheet'))return;
    tabelBackgroundStarting=true;
    import(new URL('./working-test/tabel-v2/entry.mjs',document.baseURI).href).then(m=>m.background(tabelV2Host())).catch(e=>console.warn('Табель: фоновая очередь',e.message)).finally(()=>{tabelBackgroundStarting=false;});
  }
