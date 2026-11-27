  // UI задачи 25 создаётся только при наличии включённого v2-моста. Если
  // флаг канала выключен, не подменяем операции v2 командами старого клиента.
  let shiftSelector = null;
  let shiftManagement = null;
  let shiftUiBridge = null;
  function shiftRights() {
    return {
      start_shift: typeof hasPermission === 'function' && hasPermission('start_shift'),
      close_shift: typeof hasPermission === 'function' && hasPermission('close_shift'),
      manage_shift_members: typeof hasPermission === 'function' && hasPermission('manage_shift_members'),
      force_transfer_truck: typeof hasPermission === 'function' && hasPermission('force_transfer_truck'),
      edit_line: typeof hasPermission === 'function' && hasPermission('edit_line')
    };
  }
  function shiftBridge() {
    try { return typeof nasV2Shifts === 'function' ? nasV2Shifts() : null; } catch (_) { return null; }
  }
  function ensureShiftUi() {
    const bridge = shiftBridge();
    const mount = document.getElementById('shiftStrip');
    if (!bridge || !bridge.store || !bridge.transport || typeof WorkingTestShiftSelector === 'undefined') {
      if (mount) { mount.textContent = ''; mount.hidden = true; }
      if (shiftSelector) shiftSelector.destroy();
      shiftSelector = null;
      shiftManagement = null;
      shiftUiBridge = null;
      window.__wtRenderShiftStrip = function () { if (mount) mount.hidden = true; };
      const button = document.getElementById('shiftManagementBtn');
      if (button) button.hidden = false;
      return null;
    }
    if (shiftUiBridge !== bridge) {
      if (shiftSelector) shiftSelector.destroy();
      shiftSelector = null;
      shiftManagement = null;
      shiftUiBridge = bridge;
    }
    if (!shiftSelector) {
      shiftSelector = WorkingTestShiftSelector.createShiftSelector({
        store: bridge.store, doc: document, mount, legacyState: state,
        onSwitch: function () { renderAll(); },
        select: function (id) { return window.shiftStripSelect(id); },
        offline: function () { return typeof navigator !== 'undefined' && navigator.onLine === false; }
      });
      shiftManagement = WorkingTestShiftManagement.createShiftManagement({
        transport: bridge.transport, store: bridge.store, rights: shiftRights()
      });
      window.__wtRenderShiftStrip = function () { shiftSelector?.render(); };
      // Кнопка листа управления имеет смысл только когда v2-мост поднят.
      const button = document.getElementById('shiftManagementBtn');
      if (button) button.hidden = false;
    }
    return { bridge, selector: shiftSelector, management: shiftManagement };
  }
  window.__wtRenderShiftStrip = function () {
    const ui = ensureShiftUi();
    if (ui) ui.selector.render();
  };
  window.shiftStripSelect = function (shiftId) {
    const ui = ensureShiftUi();
    if (!ui || !ui.selector.switchTo(shiftId)) return false;
    return true;
  };
  // Лист управления сменой: только реальные операции v2. Пока мост выключен,
  // лист честно говорит причину и не подменяет v2 командами старого клиента.
  window.openShiftManagement = function () {
    const modal = document.getElementById('shiftManagementModal');
    const body = document.getElementById('shiftManagementBody');
    const button = document.getElementById('shiftManagementBtn');
    const ui = ensureShiftUi();
    if (!modal || !body) return;
    modal.classList.add('open');
    if (button) button.hidden = false;
    body.textContent = '';
    if (!ui) {
      const note = document.createElement('p');
      note.className = 'shift-management-note';
      note.textContent = 'Управление сменами доступно после включения канала v2.';
      body.appendChild(note);
      return;
    }
    // Права могли измениться после загрузки UI: пересчитываем их на каждый вход.
    shiftManagement = WorkingTestShiftManagement.createShiftManagement({
      transport: ui.bridge.transport, store: ui.bridge.store, rights: shiftRights()
    });
    const management = shiftManagement;
    const store = ui.bridge.store;
    const status = document.createElement('p');
    status.className = 'shift-management-status';
    status.hidden = true;
    body.appendChild(status);
    const report = (result, successText) => {
      status.hidden = false;
      status.className = 'shift-management-status ' + (result && result.ok ? 'is-ok' : 'is-error');
      status.textContent = result && result.ok ? successText : management.describe(result);
    };
    const section = title => {
      const box = document.createElement('div');
      box.className = 'shift-management-section';
      const head = document.createElement('h4');
      head.textContent = title;
      box.appendChild(head);
      body.appendChild(box);
      return box;
    };
    const activeShiftId = store.activeShiftId ? store.activeShiftId() : null;
    const activeRow = (store.visibleShifts ? store.visibleShifts() : []).find(row => row.shiftId === activeShiftId) || null;

    // Создать смену: объект, дата и тип уходят в createShift без локальных подмен.
    const createBox = section('Создать смену');
    const objectSelect = document.createElement('select');
    objectSelect.className = 'form-control';
    for (const object of (state.objects || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      const option = document.createElement('option');
      option.value = object.id;
      option.textContent = object.name;
      objectSelect.appendChild(option);
    }
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'form-control';
    const today = new Date();
    dateInput.value = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const typeSelect = document.createElement('select');
    typeSelect.className = 'form-control';
    for (const [value, label] of [['day', 'День'], ['night', 'Ночь']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      typeSelect.appendChild(option);
    }
    const createButton = document.createElement('button');
    createButton.className = 'btn btn-quick';
    createButton.textContent = 'Создать смену';
    createButton.disabled = !management.canCreate();
    createButton.addEventListener('click', async () => {
      createButton.disabled = true;
      try {
        const result = await management.createShift({
          objectId: objectSelect.value, workDate: dateInput.value, shiftType: typeSelect.value
        });
        report(result, 'Смена создана');
        if (result.ok) renderAll();
      } finally {
        createButton.disabled = !management.canCreate();
      }
    });
    createBox.appendChild(objectSelect);
    createBox.appendChild(dateInput);
    createBox.appendChild(typeSelect);
    createBox.appendChild(createButton);

    // Участники выбранной смены: список и точные add/remove с CAS из контекста.
    const membersBox = section('Участники' + (activeRow && activeRow.objectName ? ' · ' + activeRow.objectName : ''));
    const context = activeShiftId && store.context ? store.context(activeShiftId) : null;
    const members = context && context.snapshot && Array.isArray(context.snapshot.members) ? context.snapshot.members : [];
    if (!activeShiftId) {
      const empty = document.createElement('p');
      empty.className = 'shift-management-note';
      empty.textContent = 'Смена не выбрана.';
      membersBox.appendChild(empty);
    } else if (!members.length) {
      const empty = document.createElement('p');
      empty.className = 'shift-management-note';
      empty.textContent = 'Участники ещё не загружены или смена без участников.';
      membersBox.appendChild(empty);
    }
    const userName = uid => {
      const user = (state.users || []).find(item => item.id === uid);
      return user ? (user.nickname || sanitizeName(user.email) || uid) : uid;
    };
    for (const member of members) {
      const row = document.createElement('div');
      row.className = 'shift-management-member';
      const label = document.createElement('span');
      label.textContent = userName(member.uid);
      const remove = document.createElement('button');
      remove.className = 'btn btn-small btn-danger';
      remove.textContent = 'Убрать';
      remove.disabled = !management.canManageMembers();
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          const result = await management.removeMember({ shiftId: activeShiftId, uid: member.uid });
          report(result, 'Участник убран');
          if (result.ok) openShiftManagement();
        } finally {
          remove.disabled = !management.canManageMembers();
        }
      });
      row.appendChild(label);
      row.appendChild(remove);
      membersBox.appendChild(row);
    }
    if (activeShiftId) {
      const candidates = (state.users || [])
        .filter(user => user.status !== 'pending' && !members.some(member => member.uid === user.id))
        .sort((a, b) => userName(a.id).localeCompare(userName(b.id)));
      const addSelect = document.createElement('select');
      addSelect.className = 'form-control';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Добавить участника…';
      addSelect.appendChild(placeholder);
      for (const user of candidates) {
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = userName(user.id);
        addSelect.appendChild(option);
      }
      const addButton = document.createElement('button');
      addButton.className = 'btn btn-secondary';
      addButton.textContent = 'Добавить';
      addButton.disabled = !management.canManageMembers();
      addButton.addEventListener('click', async () => {
        if (!addSelect.value) { report({ code: 'invalid-uid' }, ''); return; }
        addButton.disabled = true;
        try {
          const result = await management.addMember({ shiftId: activeShiftId, uid: addSelect.value });
          report(result, 'Участник добавлен');
          if (result.ok) openShiftManagement();
        } finally {
          addButton.disabled = !management.canManageMembers();
        }
      });
      membersBox.appendChild(addSelect);
      membersBox.appendChild(addButton);
    }

    // Закрыть смену: материал и объём заполняются, только если в смене есть рейсы.
    const closeBox = section('Закрыть смену');
    const materialInput = document.createElement('input');
    materialInput.type = 'text';
    materialInput.className = 'form-control';
    materialInput.placeholder = 'Материал (если в смене есть рейсы)';
    const volumeInput = document.createElement('input');
    volumeInput.type = 'number';
    volumeInput.min = '0';
    volumeInput.step = '0.1';
    volumeInput.className = 'form-control';
    volumeInput.placeholder = 'Объём материала, м³';
    const closeButton = document.createElement('button');
    closeButton.className = 'btn btn-danger';
    closeButton.textContent = 'Закрыть смену';
    closeButton.disabled = !activeShiftId || !management.canClose();
    closeButton.addEventListener('click', async () => {
      if (!activeShiftId) return;
      const question = 'Закрыть смену' + (activeRow && activeRow.objectName ? ' «' + activeRow.objectName + '»' : '') + '?';
      if (typeof appConfirm === 'function' && !(await appConfirm(question))) return;
      closeButton.disabled = true;
      try {
        const result = await management.closeShift({
          shiftId: activeShiftId,
          materialId: materialInput.value.trim() || undefined,
          volume: volumeInput.value === '' ? undefined : Number(volumeInput.value)
        });
        report(result, 'Смена закрыта');
        if (result.ok) { renderAll(); closeShiftManagement(); }
      } finally {
        closeButton.disabled = !activeShiftId || !management.canClose();
      }
    });
    closeBox.appendChild(materialInput);
    closeBox.appendChild(volumeInput);
    closeBox.appendChild(closeButton);
  };
  window.closeShiftManagement = function () {
    const modal = document.getElementById('shiftManagementModal');
    if (modal) modal.classList.remove('open');
  };
  window.addEventListener('samosval-working-test-shifts', function () {
    const ui = ensureShiftUi();
    if (ui) ui.selector.render();
  });
  window.addEventListener('samosval-working-test-shift-snapshot', function () {
    const ui = ensureShiftUi();
    if (ui) ui.selector.refreshBadges();
  });

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
