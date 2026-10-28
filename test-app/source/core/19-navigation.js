  function switchTab(name, btn) {
    if (name === 'admin' && !canAdmin()) { showError('Только админ'); return; }
    if (!name.startsWith('plugin-') && name !== 'admin' && !hasTabAccess(name)) { showError('Нет доступа'); return; }
    // === SECURITY: до загрузки прав разрешена только вкладка line ===
    if (!permissionsLoaded && name !== 'line' && name !== 'admin') {
      showError('Подождите, идёт загрузка прав...'); return;
    }
    document.querySelectorAll('.tab-content').forEach(e=>e.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(e=>e.classList.remove('active'));
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
    let e = localStorage.getItem('dt_saved_email_test347'); if(e) document.getElementById('userBadgeLabel').textContent = '👤 ' + sanitizeName(e);
    document.getElementById('newTruckType').addEventListener('change', toggleVolInput);
    setTimeout(runMaxQueue, 2000);
  });
  setInterval(updateSyncUI, 3000);
  setInterval(offlineReplayJournal, 8000);
  setInterval(() => { if (maxQueue.length && !maxSenderRunning) runMaxQueue(); }, 20000);

  // Built-in test module. No plugin installation or production writes.
  let tabelV2Opening = false;
  async function openTabelV2(settingsOnly, requestFirst = false) {
    if (tabelV2Opening) return;
    tabelV2Opening = true;
    try {
      const module = await import(new URL('./test-app/tabel-v2/entry.mjs', document.baseURI).href);
      await module.open(tabelV2Host(), settingsOnly, {requestFirst});
    } catch (error) { showError(error.message); } finally { tabelV2Opening = false; }
  }


  function tabelV2Host(){
      const session = () => ({projectId: firebaseConfig.projectId, workspaceId: WORKSPACE_ID,
        uid: currentUid, name: getUserName(), role: currentUserRole, active: currentUserStatus === 'active',
        view: permissionsLoaded && hasTabAccess('timesheet'), edit: hasPermission('timesheet_edit'),
        objectId: state.shift && state.shift.objectId});
      return {session, workspace: wsRef, refs,
        users:async()=>state.users.length?state.users:(await usersRef.get()).docs.map(d=>({...d.data(),id:d.id})),
        transaction:fn=>db.runTransaction(fn),
        documentId:()=>firebase.firestore.FieldPath.documentId(),
        get shift(){return state.shift;}, get objects(){return state.objects;},
        snapshot:()=>({shift:state.shift,trucks:state.trucks,statuses:state.truckStatus,logs:state.logs,audit:state.audit,archive:state.archive}),
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
    import(new URL('./test-app/tabel-v2/entry.mjs',document.baseURI).href).then(m=>m.background(tabelV2Host())).catch(e=>console.warn('Табель: фоновая очередь',e.message)).finally(()=>{tabelBackgroundStarting=false;});
  }
