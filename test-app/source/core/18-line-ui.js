  function renderLine() {
    let sc = document.getElementById('startShiftContainer'), ac = document.getElementById('activeShiftContainer'), cb = document.getElementById('changeObjBtn');
    if (!state.shift) { sc.style.display = (hasPermission('start_shift') || hasTabAccess('timesheet')) ? 'block' : 'none'; ac.style.display = 'none'; cb.style.display = 'none'; return; }
    sc.style.display = 'none'; ac.style.display = 'block'; cb.style.display = hasPermission('edit_line') ? 'inline-block' : 'none';
    let c = document.getElementById('trucksLineList'), oldP = {};
    c.querySelectorAll('.truck-card[data-truck-id]').forEach(x => oldP[x.dataset.truckId] = x.getBoundingClientRect().top);
    let ids = getActiveLineIds(); if (!ids.length) { c.innerHTML = '<div class="form-card" style="text-align:center;color:var(--muted);">Нет машин</div>'; return; }
    let logs = getLogs(), lastTs = {}; logs.forEach(l => { if (lastTs[l.truckId] === undefined) lastTs[l.truckId] = l.timestamp||0; });
    let trucks = ids.map(id => findTruck(id)).filter(Boolean);
    trucks.sort((a,b)=>{ let sA=state.truckStatus[a.id], sB=state.truckStatus[b.id]; let tA=sA.ttnStatus===true?1:0, tB=sB.ttnStatus===true?1:0; if(tA!==tB) return tA-tB; let aA=sA.arriveStatus?1:0, aB=sB.arriveStatus?1:0; if(aA!==aB) return aB-aA; let lA=lastTs[a.id]||0, lB=lastTs[b.id]||0; if(lA===0&&lB===0) return 0; if(lA===0) return -1; if(lB===0) return 1; return lA-lB; });
    let now = Date.now(), cyc = (settings.cycleMinutes||15)*60000;
    let canEditArrive = hasPermission('action_arrive'), canEditLoad = hasPermission('action_load'), canEditTtn = hasPermission('action_ttn'); let showStats = hasPermission('view_card_stats');
    c.innerHTML = trucks.map(t => {
      let st = state.truckStatus[t.id]||{}; let offlineFlag=offlinePendingForTruck(t.id); let tLogs = logs.filter(l=>l.truckId===t.id), sum = tLogs.reduce((s,l)=>s+l.volume,0);
      let isA = !!st.arriveStatus, lastL = st.lastLoadTimestamp||0, inC = lastL > 0 && (now-lastL)<cyc; let ttn = st.ttnStatus, faded = ttn===true; let lTs = tLogs.length ? tLogs[0].timestamp||0 : 0; let isGAI = !!t.isGAI;
      let arrBtn;
      if (inC) arrBtn = `<button class="btn btn-arrive" disabled><span style="display:flex;flex-direction:column;align-items:center;line-height:1.1;"><span class="idle-label">Ходка</span><span class="cooldown-timer" style="font-size:15px;" data-load-ts="${lastL}">${formatIdleDuration(cyc-(now-lastL))}</span></span></button>`;
      else if (isA) arrBtn = `<button class="btn btn-arrive active-arrive" ${canEditArrive?`onpointerdown="startArriveHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''} ${!canEditArrive?'disabled':''}><span style="display:flex;flex-direction:column;align-items:center;line-height:1.1;"><span class="idle-label">Простой</span><span class="idle-timer" data-since="${st.arriveTimestamp||now}">${formatIdleDuration(now-(st.arriveTimestamp||now))}</span></span></button>`;
      else arrBtn = `<button class="btn btn-arrive" ${canEditArrive?`onpointerdown="startArriveHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''} ${!canEditArrive?'disabled':''}>🚛 Приехал</button>`;
      let ttnTxt = ttn ? '📄 Забрал ТТН ✓' : '📄 Забрать ТТН';
      let statsHtml = showStats ? (isGAI ? `<div class="truck-summary">Рейсов: <b>${tLogs.length}</b></div>` : `<div class="truck-summary">Рейсов: <b>${tLogs.length}</b> | <b>${sum} м³</b></div>`) : '';
      let loadBtnTxt = isGAI ? '⚡ Погрузка' : '⚡ Погрузка (+' + t.defaultVol + 'м³)';
      return `<div class="truck-card ${isA?'arrived':''} ${faded?'faded':''}" data-truck-id="${t.id}"><div class="truck-header"><div class="truck-name" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><b>${escapeHtml(t.brand)}</b>${renderRussianPlate(t.number)}<span style="font-size:13px;color:var(--muted);">${isGAI?'': '('+t.defaultVol+' м³)'}</span>${isA?`<span style="color:#f59e0b;font-size:12px;">(${escapeHtml(st.arriveBy||'')})</span>`:''}${offlineFlag?`<span style="font-size:10px;font-weight:700;color:#f59e0b;">☁️ ОФЛАЙН</span>`:''}</div>${statsHtml}</div><div class="last-load-info">⏱ Последняя: <b class="time-ago-card" data-timestamp="${lTs}">${lTs>0?formatTimeAgo(lTs):'—'}</b></div><div class="action-row">${arrBtn}<button class="btn btn-quick" ${!canEditLoad||!isA?'disabled':''} ${canEditLoad&&isA?`onpointerdown="startQuickLoadHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''}>${loadBtnTxt}</button><button class="btn btn-ttn ${ttn?'active-ttn':''}" ${!canEditTtn?'disabled':''} ${canEditTtn?`onpointerdown="startTtnHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''}>${ttnTxt}</button></div></div>`;
    }).join('');
    if (Object.keys(oldP).length) {
      c.querySelectorAll('.truck-card').forEach(card => { let old = oldP[card.dataset.truckId]; if(old === undefined) return; let delta = old - card.getBoundingClientRect().top;
        if(Math.abs(delta) > 2) { card.style.transform=`translateY(${delta}px)`; card.style.transition='none'; void card.offsetWidth; setTimeout(()=>{ requestAnimationFrame(()=>{ card.style.transition='transform 2.4s cubic-bezier(0.4,0,0.2,1)'; card.style.transform=''; setTimeout(()=>card.style.transition='', 2450); }); }, 1000); }
      });
    }
  }

  function renderHeaderStats() {
    let d = state.shift ? `Смена от ${state.shift.startDate}` : 'Смена не начата'; let o = state.shift ? state.shift.objectName : 'Не выбран';
    let act = state.shift ? getActiveLineIds().filter(id => { let t = findTruck(id); if (!t || t.isGAI) return false; return !state.truckStatus[id] || state.truckStatus[id].ttnStatus !== true; }).length : 0;
    let logs = getLogs(); let stdLogs = logs.filter(l => !l.isGAI); let v = stdLogs.reduce((s,l)=>s+l.volume,0);
    document.getElementById('shiftDate').textContent = d; document.getElementById('headerObject').textContent = 'Объект: ' + o;
    document.getElementById('activeLineCount').textContent = act + ' маш.'; document.getElementById('totalTrips').textContent = stdLogs.length; document.getElementById('totalVolume').textContent = v + ' м³';
    const tabelCounts=document.getElementById('tabelV2Counts');if(tabelCounts&&permissionsLoaded&&hasTabAccess('timesheet'))import(new URL('./test-app/tabel-v2/summary.mjs',document.baseURI).href).then(m=>m.updateHeader({session:()=>({projectId:firebaseConfig.projectId,workspaceId:WORKSPACE_ID,uid:currentUid,role:currentUserRole,active:currentUserStatus==='active',view:hasTabAccess('timesheet')}),snapshot:()=>({shift:state.shift,trucks:state.trucks,statuses:state.truckStatus,logs:state.logs,audit:state.audit,archive:state.archive})},tabelCounts)).catch(()=>{tabelCounts.hidden=true;});else if(tabelCounts)tabelCounts.hidden=true;
  }

  function tickTimers() {
    let now = Date.now(), cyc = (settings.cycleMinutes||15)*60000;
    document.querySelectorAll('.idle-timer').forEach(e=>{ let s=parseInt(e.getAttribute('data-since')); if(s) e.textContent=formatIdleDuration(now-s); });
    document.querySelectorAll('.load-age-card').forEach(el=>{el.textContent=formatLoadAge(el.dataset.timestamp);});
    document.querySelectorAll('.time-ago-card').forEach(e=>{ let t=parseInt(e.getAttribute('data-timestamp')); if(t) e.textContent=formatTimeAgo(t); });
    document.querySelectorAll('.cooldown-timer').forEach(e=>{ let l=parseInt(e.getAttribute('data-load-ts')); if(l) { let r=cyc-(now-l); if(r<=0) scheduleRenderLine(); else e.textContent=formatIdleDuration(r); } });
    let ticker = document.getElementById('tickerTimeAgo'); if(ticker) { let t=parseInt(ticker.getAttribute('data-timestamp')); if(t) ticker.textContent=formatTimeAgo(t); }
  }
  setInterval(tickTimers, 1000);

  // === БАЗА САМОСВАЛОВ И ОБЪЕКТОВ ===
  async function saveTruckToGlobalBase() {
    if (!requireEdit('manage_trucks')) return;
    let id = document.getElementById('editTruckId').value;
    let brand = document.getElementById('newTruckBrand').value.trim();
    let num = document.getElementById('newTruckNumber').value.trim();
    let vol = parseFloat(document.getElementById('newTruckVol').value);
    let type = document.getElementById('newTruckType').value;
    let isGAI = type === 'gai';
    if (!brand || !num) { appNotice('Заполните марку и госномер'); return; }
    if (!isGAI && (isNaN(vol) || vol <= 0)) { appNotice('Укажите объем'); return; }
    try {
      if (id) { await tfAwait(refs.trucks.doc(id).update({ brand, number: num, defaultVol: isGAI ? 0 : vol, isGAI, updatedAt: Date.now() })); addAudit(`Обновлен самосвал: ${brand} ${num}`).catch(()=>{}); showToastEl('✏️ Обновлено', false); }
      else { let r = refs.trucks.doc(); await tfAwait(r.set({ brand, number: num, defaultVol: isGAI ? 0 : vol, isGAI, createdAt: Date.now(), createdBy: getUserName() })); addAudit(`Добавлен самосвал: ${brand} ${num}`).catch(()=>{}); showToastEl('➕ Добавлено', false); }
      cancelEditTruck();
    } catch(e) { showError(e.message); }
  }
  function editGlobalTruck(id) {
    if(!requireEdit('manage_trucks')) return; let t=findTruck(id); if(!t) return;
    document.getElementById('editTruckId').value=t.id; document.getElementById('newTruckType').value=t.isGAI?'gai':'regular';
    document.getElementById('newTruckBrand').value=t.brand; document.getElementById('newTruckNumber').value=t.number; document.getElementById('newTruckVol').value=t.defaultVol||'';
    document.getElementById('formCardTitle').textContent='Редактировать'; document.getElementById('saveTruckBtn').textContent='💾 Сохранить'; document.getElementById('cancelEditBtn').style.display='block'; window.scrollTo(0,0); toggleVolInput();
  }
  function cancelEditTruck() {
    document.getElementById('editTruckId').value=''; document.getElementById('newTruckType').value='regular'; document.getElementById('newTruckBrand').value=''; document.getElementById('newTruckNumber').value=''; document.getElementById('newTruckVol').value='';
    document.getElementById('formCardTitle').textContent='Добавить самосвал'; document.getElementById('saveTruckBtn').textContent='➕ Добавить'; document.getElementById('cancelEditBtn').style.display='none'; toggleVolInput();
  }
  function toggleVolInput() { document.getElementById('volumeGroup').style.display = document.getElementById('newTruckType').value === 'gai' ? 'none' : 'block'; }
  async function deleteGlobalTruck(id) {
    if(!requireEdit('manage_trucks')) return; let t=findTruck(id); if(!t || !(await appConfirm('Удалить?'))) return;
    try { let b=db.batch(); b.delete(refs.trucks.doc(id)); b.delete(refs.truckStatus.doc(id)); await tfAwait(b.commit()); await addAudit('🗑 Удалён самосвал: ' + t.brand + ' ' + t.number, {eventType:'truck_delete',truckId:id}); } catch(e){ showError(e.message); }
  }
  async function saveObjectToBase() {
    if (!requireEdit('manage_objects')) return;
    let id = document.getElementById('editObjectId').value, name = document.getElementById('newObjectNameBase').value.trim();
    if (!name) { appNotice('Введите имя'); return; }
    try { if (id) await tfAwait(refs.objects.doc(id).update({ name, updatedAt: Date.now() })); else await tfAwait(refs.objects.doc().set({ name, createdAt: Date.now(), createdBy: getUserName() })); await addAudit((id ? '✏️ Изменён объект: ' : '➕ Создан объект: ') + name, {eventType:id ? 'object_edit' : 'object_create'}); cancelEditObject(); showToastEl('Сохранено', false); }
    catch(e){ showError(e.message); }
  }
  function editGlobalObject(id) { if(!requireEdit('manage_objects')) return; let o=state.objects.find(x=>x.id===id); if(!o) return; document.getElementById('editObjectId').value=o.id; document.getElementById('newObjectNameBase').value=o.name; document.getElementById('formObjectCardTitle').textContent='Редактировать'; document.getElementById('saveObjectBtn').textContent='💾 Сохранить'; document.getElementById('cancelEditObjectBtn').style.display='block'; window.scrollTo(0,0); }
  function cancelEditObject() { document.getElementById('editObjectId').value=''; document.getElementById('newObjectNameBase').value=''; document.getElementById('formObjectCardTitle').textContent='Добавить объект'; document.getElementById('saveObjectBtn').textContent='➕ Добавить'; document.getElementById('cancelEditObjectBtn').style.display='none'; }
  async function deleteGlobalObject(id) {
    if(!requireEdit('manage_objects')) return; let o=state.objects.find(x=>x.id===id); if(!o || !(await appConfirm('Удалить?'))) return;
    try { await tfAwait(refs.objects.doc(id).delete()); await addAudit('🗑 Удалён объект: ' + o.name, {eventType:'object_delete',targetObjectId:id}); } catch(e){ showError(e.message); }
  }

  // === АДМИН ПАНЕЛЬ ===
  const userAccessWrites=new Set();
  function renderAdminPanel() {
    if (!canAdmin()) return;
    renderRegistrationRequests();
    const active = state.users.filter(u => u.status !== 'pending');
    document.getElementById('usersListContainer').innerHTML = active.map(u => { const isMe = u.id === currentUid; const isLocked = isForcedAdminEmail(u.email); const accessible=u.status!=='disabled'; return `<div class="user-row ${accessible?'':'user-access-limited'}"> <div class="user-row-top"><div class="user-email">${escapeHtml(u.email)}</div><input type="text" class="form-control" style="width:100px; padding:4px; font-size:12px;" value="${escapeHtml(u.nickname||'')}" onchange="updateUserNickname('${u.id}', this.value)"></div><div class="user-row-bottom"><select class="form-control" onchange="changeUserRole('${u.id}', this.value)">${Object.keys(ROLES).map(r=>`<option value="${r}" ${r===u.role?'selected':''}>${ROLES[r].label}</option>`).join('')}</select>${!isMe&&!isLocked?`<button class="btn-del" onclick="deleteUser('${u.id}')">Удалить</button>`:''}</div><div class="user-access-row"><span>${accessible?'Доступ разрешён':'Доступ ограничен'}${isMe?'<small>Ваша учётная запись</small>':isLocked?'<small>Владелец приложения</small>':''}</span><label class="toggle-switch" title="${isMe?'Нельзя ограничить собственный доступ':isLocked?'Доступ владельца защищён':'Временно разрешить или ограничить доступ'}"><input type="checkbox" role="switch" data-user-access="${escapeHtml(u.id)}" aria-label="Доступ: ${escapeHtml(u.nickname||u.email)}" ${accessible?'checked':''} ${isMe||isLocked||userAccessWrites.has(u.id)?'disabled':''}><span class="toggle-slider"></span></label></div></div>`; }).join('');
    document.querySelectorAll('[data-user-access]').forEach(input=>input.onchange=()=>setUserAccess(input.dataset.userAccess,input.checked));
  }
  async function setUserAccess(uid, enabled) {
    if(!canAdmin()||userAccessWrites.has(uid))return;
    if(uid===currentUid){showError('Нельзя ограничить собственный доступ');renderAdminPanel();return;}
    if(!navigator.onLine){showError('Для изменения доступа требуется подключение к сети');renderAdminPanel();return;}
    userAccessWrites.add(uid);renderAdminPanel();
    try{
      const targetStatus=enabled?'active':'disabled';let targetName='';
      await db.runTransaction(async tx=>{
        if(!canAdmin())throw new Error('Нет прав администратора');
        const ref=usersRef.doc(uid),snap=await tx.get(ref);
        if(!snap.exists)throw new Error('Пользователь не найден. Обновите список');
        const data=snap.data();
        if(isForcedAdminEmail(data.email))throw new Error('Доступ владельца приложения защищён');
        if(data.status==='pending')throw new Error('Сначала рассмотрите заявку пользователя');
        targetName=data.nickname||data.email||uid;
        if(data.status!==targetStatus)tx.update(ref,{status:targetStatus,accessChangedAt:Date.now(),accessChangedBy:currentEmail});
      });
      const user=state.users.find(u=>u.id===uid);if(user)user.status=targetStatus;
      showToastEl(enabled?'Доступ пользователя восстановлен':'Доступ пользователя временно ограничен',false);
      await addAudit((enabled?'🔓 Восстановлен доступ: ':'🔒 Ограничен доступ: ')+targetName,{eventType:'user_access',targetUid:uid,status:targetStatus});
    }catch(e){showError('Не удалось изменить доступ: '+e.message);}
    finally{userAccessWrites.delete(uid);renderAdminPanel();}
  }
  async function updateUserNickname(uid, nickname) { if (!canAdmin()) return; try { await tfAwait(usersRef.doc(uid).update({ nickname: nickname.trim() || null })); await addAudit('✏️ Изменено имя пользователя: ' + uid + ' → ' + nickname.trim(), {eventType:'user_nickname',targetUid:uid}); } catch(e) { showError(e.message); } }
  async function changeUserRole(uid, newRole) { if (!canAdmin()) return; try { await tfAwait(usersRef.doc(uid).update({ role: newRole })); await addAudit('🔐 Изменена роль пользователя: ' + uid + ' → ' + newRole, {eventType:'user_role',targetUid:uid}); } catch(e) { showError(e.message); } }
  async function deleteUser(uid) { if (!canAdmin() || !(await appConfirm('Удалить доступ?'))) return; try { await tfAwait(usersRef.doc(uid).delete()); await addAudit('🗑 Удалён доступ пользователя: ' + uid, {eventType:'user_delete',targetUid:uid}); } catch(e) { showError(e.message); } }
  const registrationDecisions = new Set();
  async function decideRegistration(reqId, approve) {
    if (!canAdmin() || registrationDecisions.has(reqId)) return;
    const role=document.getElementById('req_role_'+reqId)?.value || 'viewer';
    if (approve && !Object.prototype.hasOwnProperty.call(ROLES,role)) {showError('Выберите роль');return;}
    if (!approve && !(await appConfirm('Отклонить заявку и закрыть доступ пользователю?'))) return;
    registrationDecisions.add(reqId);pendingStart();
    try {
      const cached=state.requests.find(r=>r.id===reqId) || state.users.find(u=>u.id===reqId&&u.status==='pending');
      if (!cached) throw Error('Заявка не найдена. Обновите список');
      let accountEmail='';
      await db.runTransaction(async tx=>{
        const requestRef=requestsRef.doc(reqId),request=await tx.get(requestRef);
        const data=request.exists?request.data():cached;
        const matches=state.users.filter(u=>u.status==='pending'&&u.email===data.email);
        const uid=data.uid || (matches.length===1?matches[0].id:null);
        if (!uid) throw Error('Это старая заявка без учётки Firebase. Пользователю нужно зарегистрироваться заново');
        const profileRef=usersRef.doc(uid),profile=await tx.get(profileRef);
        if (!profile.exists || profile.data().email!==data.email) throw Error('Учётка не соответствует заявке');
        if (profile.data().status!=='pending') throw Error('Заявка уже рассмотрена');
        accountEmail=profile.data().email;
        tx.update(profileRef,approve?{role,status:'active',approvedAt:Date.now(),approvedBy:currentEmail,rejectionReason:null}:{status:'disabled',rejectedAt:Date.now(),rejectedBy:currentEmail,rejectionReason:'Заявка отклонена администратором.'});
        if(request.exists)tx.delete(requestRef);
      });
      await addAudit((approve?'✅ Подтверждена регистрация: ':'⛔ Отклонена регистрация: ')+accountEmail+(approve?' · роль '+ROLES[role].label:''),{eventType:approve?'registration_approved':'registration_rejected'});
      showToastEl(approve?'Доступ открыт':'Заявка отклонена',false);
    }catch(e){showError(escapeHtml(e.message||'Не удалось обработать заявку'));}
    finally{registrationDecisions.delete(reqId);pendingEnd();}
  }
  async function approveRequest(reqId) { return decideRegistration(reqId,true); }
  async function rejectRequest(reqId) { return decideRegistration(reqId,false); }
  async function addNewUser() {
    if (!canAdmin()) return;
    const email = document.getElementById('newUserEmail').value.trim(); const pass = document.getElementById('newUserPassword').value; const role = document.getElementById('newUserRole').value;
    if (!email || !pass) { showError('Заполните поля'); return; }
    try { const secAuth = secondaryApp.auth(); const cred = await secAuth.createUserWithEmailAndPassword(email, pass); await secAuth.signOut(); await tfAwait(usersRef.doc(cred.user.uid).set({ email, role, status: 'active', nickname: sanitizeName(email) })); showToastEl('✅ Создан', false); }
    catch(e) { showError(e.message); }
  }
  function renderPermissionsMatrix(){
    const role=document.getElementById('permRoleSelect').value,config=permissionsConfig[role]||{tabs:[],actions:[]},cont=document.getElementById('permissionsMatrixContainer');
    const groups=[['Смена и линия',['start_shift','close_shift','edit_line']],['Работа самосвалов',['action_arrive','action_load','action_ttn']],['Последнее действие в статусе',['undo_action','undo_any']],['Журнал отмены и восстановления',['history_view','history_undo_own','history_undo_any','history_redo_own','history_redo_any']],['Данные и архив',['edit_logs','manage_trucks','manage_objects','archive_edit','archive_delete','import_backup']],['Отображение',['view_card_stats','view_header','view_gai_report','view_reis_in_ticker']]];
    const known=new Set(groups.flatMap(g=>g[1])),extra=[...new Set([...ALL_ACTIONS,...(config.actions||[])])].filter(x=>!known.has(x));if(extra.length)groups.push(['Другие возможности',extra]);
    cont.innerHTML='<input id="permissionSearch" class="form-control" type="search" placeholder="Найти право…" aria-label="Поиск прав" style="margin-bottom:12px"><p style="color:var(--muted);font-size:12px">Администратор имеет полный доступ. Новые права журнала у остальных ролей выключены, пока вы их не включите. Изменения применяются кнопкой сохранения.</p>';
    function section(title,ids,type,labels,selected){const block=document.createElement('section');block.className='perm-group';const h=document.createElement('div');h.className='perm-group-header';h.textContent=title;block.append(h);const list=document.createElement('div');list.className='perm-list';for(const id of ids){const label=document.createElement('label');label.className='perm-item';label.dataset.search=(title+' '+(labels[id]||id)).toLowerCase();const input=document.createElement('input');input.type='checkbox';input.dataset.type=type;input.value=id;input.checked=selected.includes(id);label.append(input,document.createTextNode(' '+(labels[id]||id)));list.append(label);}block.append(list);cont.append(block);}
    section('Доступные вкладки',ALL_TABS.filter(t=>t!=='admin'),'tab',TAB_LABELS,config.tabs||[]);for(const [title,ids] of groups)section(title,ids,'action',ACTION_LABELS,config.actions||[]);
    document.getElementById('permissionSearch').oninput=e=>{const q=e.target.value.trim().toLowerCase();cont.querySelectorAll('.perm-item').forEach(x=>x.hidden=!x.dataset.search.includes(q));cont.querySelectorAll('.perm-group').forEach(x=>x.hidden=![...x.querySelectorAll('.perm-item')].some(l=>!l.hidden));};
  }

  async function savePermissions() {
    if (!canAdmin()) return;
    const role = document.getElementById('permRoleSelect').value;
    const cont = document.getElementById('permissionsMatrixContainer');
    const tabs = Array.from(cont.querySelectorAll('input[data-type="tab"]:checked')).map(i => i.value);
    const actions = Array.from(cont.querySelectorAll('input[data-type="action"]:checked')).map(i => i.value);
    try { const update = {}; update[role] = { tabs, actions }; await tfAwait(permsRef.set(update, { merge: true })); addAudit(`Изменены права для роли: ${ROLES[role].label}`).catch(()=>{}); showToastEl('💾 Права сохранены', false); }
    catch(e) { showError(e.message); }
  }

  function showError(msg) { console.error(msg); if (!navigator.onLine) { showToastEl(`📴 Нет сети`, true); return; } showToastEl(`⚠️ ${escapeHtml(msg)}`, true); }
  function resetToast(t) { t.className = 'toast'; t.innerHTML = ''; }
  function showToastEl(html, isError, isUndo) {
    if(window.__gameDeferToast?.(html,isError,isUndo))return;
    let t = document.getElementById('toast'); if (!t) return;
    clearTimeout(toastTimer1); clearTimeout(toastTimer2);
    t.className = 'toast' + (isError ? ' error' : '') + (isUndo ? ' slide-right-to-left' : '');
    t.innerHTML = html; void t.offsetWidth; t.classList.add('show');
    toastTimer1 = setTimeout(() => { t.classList.remove('show'); t.classList.add('hide'); toastTimer2 = setTimeout(() => resetToast(t), 700); }, 2500);
  }
  function showToast(msgHtml, tickerHtml, actionObj) { if (actionObj) pushNotification(actionObj, tickerHtml || msgHtml); else showToastEl(msgHtml, false); }
  async function pushNotification(actionObj, htmlText) {
    pendingStart();
    try { await refs.notifications.add(Object.assign({}, actionObj, { html: htmlText, timestamp: Date.now(), createdBy: getUserName(), createdByEmail: currentEmail || '' })); cleanupNotifications().catch(()=>{}); }
    catch(e) { console.warn(e); } finally { pendingEnd(); }
  }
  let notifCleanupPending = false;
  async function cleanupNotifications() {
    if (notifCleanupPending) return; notifCleanupPending = true;
    try { let snap = await refs.notifications.orderBy('timestamp', 'desc').limit(100).get(); if (snap.size < 100) return; let oldTs = snap.docs[snap.docs.length - 1].data().timestamp; let oldSnap = await refs.notifications.where('timestamp', '<', oldTs).get(); let batch = db.batch(); let cnt=0; oldSnap.forEach(d=>{batch.delete(d.ref);cnt++;}); if(cnt>0) await tfAwait(batch.commit()); }
    catch(e) {} finally { notifCleanupPending = false; }
  }
  async function clearAllNotifications() { try { let snap = await refs.notifications.get(); if(!snap.size) return; let b=db.batch(); snap.forEach(d=>b.delete(d.ref)); await tfAwait(b.commit()); } catch(e){} }
  function canUndoCurrent(last) { if (!hasPermission('undo_action') && !hasPermission('undo_any')) return false; if (hasPermission('undo_any')) return true; return last.createdByEmail === currentEmail; }

  function renderStatusTicker() {
    let t = document.getElementById('statusTicker'); if (!t) return;
    let last = offlineLocalTicker() || lastValidNotification();
    if (!last) { t.style.display = 'none'; t.innerHTML = ''; lastTickerTs = 0; lastTickerId = null; return; }
    let isNew = (last.timestamp || 0) !== lastTickerTs; let isNewId = last.id !== lastTickerId;
    if (t.style.display === 'none' || !t.querySelector('.ticker-text-wrapper')) {
      t.style.display = 'flex';
      t.innerHTML = `<div class="ticker-row-top"><span>ПОСЛЕДНЕЕ ДЕЙСТВИЕ</span><span id="tickerTimeAgo" class="ticker-time" data-timestamp="${last.timestamp||Date.now()}">${formatTimeAgo(last.timestamp)}</span></div><div class="ticker-row-bottom"><div class="ticker-text-wrapper"><div class="ticker-left active">${last.html||''}</div></div>${canUndoCurrent(last) ? `<button class="btn-undo" onclick="${last.offlinePending?'undoLastOfflineAction()':'undoLastAction()'}" title="Отменить">↩</button>` : ''}</div>`;
      lastTickerTs = last.timestamp || 0; lastTickerId = last.id; t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); return;
    }
    if (isNew && isNewId) {
      let wrapper = t.querySelector('.ticker-text-wrapper'); let oldText = wrapper.querySelector('.ticker-left.active');
      if (oldText) { let newText = document.createElement('div'); newText.className = 'ticker-left enter'; newText.innerHTML = last.html || ''; wrapper.appendChild(newText); void newText.offsetWidth; oldText.classList.remove('active'); oldText.classList.add('leave'); newText.classList.remove('enter'); newText.classList.add('active'); setTimeout(() => { if (oldText.parentNode) oldText.remove(); }, 800); }
      let undoBtn = t.querySelector('.btn-undo'); let canUndo = canUndoCurrent(last);
      if (canUndo && !undoBtn) { let btn = document.createElement('button'); btn.className = 'btn-undo'; btn.innerHTML = '↩'; btn.onclick = last.offlinePending?undoLastOfflineAction:undoLastAction; t.querySelector('.ticker-row-bottom').appendChild(btn); } else if (!canUndo && undoBtn) { undoBtn.remove(); }
      if(undoBtn&&canUndo)undoBtn.onclick=last.offlinePending?undoLastOfflineAction:undoLastAction;
      let timeEl = document.getElementById('tickerTimeAgo'); if(timeEl) { timeEl.textContent = formatTimeAgo(last.timestamp); timeEl.setAttribute('data-timestamp', last.timestamp); }
      t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); lastTickerTs = last.timestamp || 0; lastTickerId = last.id;
    }
  }
  let undoActionInFlight = false;
  async function undoLastAction() {
    if (undoActionInFlight) return;
    if (!hasPermission('undo_action') && !hasPermission('undo_any')) { showError('Нет права отменять действия'); return; }
    const last = lastValidNotification(); if (!last) return;
    if (!hasPermission('undo_any') && last.createdByEmail !== currentEmail) { showError('Можно отменить только своё действие'); return; }
    if (!['arrive','load','ttn'].includes(last.type)) { showError('Это действие отменяется через историю администратора'); return; }
    if (!(await appConfirm('Отменить действие?'))) return;
    undoActionInFlight = true; pendingStart();
    try {
      if (truckStatusWrites[last.truckId]) await truckStatusWrites[last.truckId];
      const localStatus = state.truckStatus[last.truckId];
      if (!localStatus) throw {code:'status-missing',message:'Статус машины не загружен. Обновите страницу'};
      const before = {...localStatus};
      const observedRevision=truckServerRevisions[last.truckId]||0;
      const notificationRef = refs.notifications.doc(last.id), statusRef = refs.truckStatus.doc(last.truckId);
      let update = null;
      await db.runTransaction(async tx => {
        const notification = await tx.get(notificationRef);
        const status = await tx.get(statusRef);
        const logRef = last.type === 'load' && last.logId ? refs.logs.doc(last.logId) : null;
        const log = logRef ? await tx.get(logRef) : null;
        if (!notification.exists) throw {code:'already-undone',message:'Действие уже отменено'};
        if (!hasPermission('undo_any') && notification.data().createdByEmail !== currentEmail) throw {code:'not-owner',message:'Можно отменить только своё действие'};
        if (!status.exists) throw {code:'status-missing',message:'Самосвал отсутствует на линии'};
        const current = status.data();
        const keys=['shiftId','onLine','arriveStatus','arriveTimestamp','arriveBy','lastLoadTimestamp','lastLoadBy','loadedAfterArrive','ttnStatus','ttnBy','ttnLogId','cycleRevision','lastLoadLogId','ttnRevision'];
        if (keys.some(key => JSON.stringify(current[key] ?? null) !== JSON.stringify(before[key] ?? null))) throw {code:'action-conflict',message:'Данные машины изменились. Обновите страницу перед отменой'};
        if (last.type === 'arrive') {
          update = last.wasArrived ? {arriveStatus:last.prevTime||null,arriveTimestamp:last.prevTs||null,arriveBy:last.prevArriveBy||null} : {arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false};
        } else if (last.type === 'load') {
          if (!log || !log.exists) throw {code:'log-missing',message:'Рейс уже удалён или не был сохранён'};
          if (!hasPermission('undo_any') && log.data().createdByEmail !== currentEmail) throw {code:'not-owner',message:'Нельзя отменить чужую погрузку'};
          if (Number(current.lastLoadTimestamp) !== Number(log.data().timestamp)) throw {code:'action-conflict',message:'У самосвала уже есть более новая погрузка'};
          update={loadedAfterArrive:false,lastLoadTimestamp:last.prevLoadTs??null,lastLoadBy:last.prevLoadBy??null};
          if (last.wasArrived) Object.assign(update,{arriveStatus:last.prevArriveStatus||null,arriveTimestamp:last.prevArriveTs||null,arriveBy:last.prevArriveBy||null});
          update.lastLoadLogId=last.prevLoadLogId||null;
          if (last.prevTtn !== undefined) update.ttnStatus=last.prevTtn;
          if (last.prevTtnBy !== undefined) update.ttnBy=last.prevTtnBy||null;
          if (last.prevTtnLogId !== undefined) update.ttnLogId=last.prevTtnLogId;
        } else {
          update={ttnStatus:last.prevTtn??null,ttnBy:last.prevTtnBy??null,ttnLogId:last.prevTtnLogId??null};
        }
        if(last.type==='arrive'||last.type==='load')update.cycleRevision=Number(current.cycleRevision||0)+1;
        if(last.type==='ttn'||last.type==='load')update.ttnRevision=Number(current.ttnRevision||0)+1;
        const original=notification.data();
        const penaltyKey=original.gamePenaltyKey||window.__gamePenaltyKey(last.type,last.truckId,current,last.logId,last.id);
        const savePenalty=await window.__gameStagePenalty(tx,penaltyKey,{user:original.createdByEmail,name:original.createdBy,description:({load:'Погрузка',arrive:'Прибытие',ttn:'Отметка ТТН'}[last.type])+' · '+truckName(last.truckId),...window.__gamePenaltyScope(penaltyKey,original,current)});
        tx.update(statusRef,update);
        if (logRef) tx.delete(logRef);
        savePenalty();
        tx.delete(notificationRef);
      });
      if (state.truckStatus[last.truckId] && (truckServerRevisions[last.truckId]||0)===observedRevision) {const next={...state.truckStatus[last.truckId],...update};signalLineTransition(last.truckId,state.truckStatus[last.truckId],next);state.truckStatus[last.truckId]=next;truckServerRevisions[last.truckId]=observedRevision+1;}
      if (last.type === 'load') { state.logs=state.logs.filter(l=>l.id!==last.logId); confirmedLoadIds.delete(last.logId); }
      state.notifications=state.notifications.filter(n=>n.id!==last.id);
      if (syncState.errors) delete syncState.errors.undo;
      saveCache(); renderAll();
      await addAudit('↶ Отмена: ' + ({load:'погрузка самосвала',arrive:last.wasArrived?'снятие прибытия':'прибытие на линию',ttn:'отметка ТТН'}[last.type]) + ': ' + truckName(last.truckId),{eventType:'undo',originalType:last.type,truckId:last.truckId,originalUserEmail:last.createdByEmail||''});
      showToastEl('↩️ Отменено',false,true);
    } catch(e) {
      reportSyncError('undo',e);
      showError('Действие не отменено: ' + escapeHtml(e.message || 'Ошибка Firebase') + ' [' + escapeHtml(e.code || 'unknown') + ']');
    } finally { pendingEnd(); undoActionInFlight=false; }
  }
  async function addAudit(text, details = {}) {
    const timestamp = Date.now();
    const entry = { text, timeStr: new Date(timestamp).toLocaleString('ru-RU'), objectName: state.shift?.objectName || '—', objectId: state.shift?.objectId || '', shiftId: state.shift?.id || '', userEmail: currentEmail || '', userName: getUserName(), createdByEmail: currentEmail || '', timestamp, ...details };
    pendingStart();
    try { await refs.audit.add(entry); }
    catch(e) { console.warn('Audit error:', e); showError('Не удалось записать событие в аудит: ' + e.message); }
    finally { pendingEnd(); }
  }
  function auditTruckAction(type, id, extra = {}) {
    const labels = { arrive: '🚛 Прибытие на линию', arrive_cancel: '↩️ Снято прибытие на линию', load: '⚡ Погрузка самосвала', ttn: '📄 Забрана ТТН', ttn_cancel: '↩️ Снята отметка ТТН' };
    const name = truckName(id);
    return addAudit((labels[type] || type) + ': ' + name + (type === 'load' ? ' · ' + (extra.volume || 0) + ' м³' : ''), {eventType:type,truckId:id,truckName:name,...extra});
  }
  function renderAuditEntries() {
    return '<div style="font-size:11px;color:var(--muted);margin:8px 0">Последние ' + state.audit.length + ' событий всех пользователей (до 200). Новые события сверху.</div>' + state.audit.map(a => {
      const name = resolveUserDisplayName(a.userEmail || a.createdByEmail, a.userName);
      return `<div class="audit-item"><div class="audit-time">${escapeHtml(a.timeStr)} · ${escapeHtml(name)}</div><div>${escapeHtml(a.text)}</div><div class="audit-time" style="margin-top:5px">${escapeHtml(a.objectName || '—')}</div></div>`;
    }).join('');
  }

  // === НАСТРОЙКИ ===
  function openSettingsModal() {
    document.getElementById('settingHoldLoad').value = settings.holdLoad;
    document.getElementById('settingHoldArrive').value = settings.holdArrive;
    document.getElementById('settingHoldTtn').value = settings.holdTtn;
    document.getElementById('settingCycleMinutes').disabled=!canAdmin();
    document.getElementById('settingCycleMinutes').value = Math.max(MIN_CYCLE_MINUTES, settings.cycleMinutes || MIN_CYCLE_MINUTES);
    for(const name of ['hapticArrive','hapticLoad','hapticTtn'])document.getElementById(name).checked=!!settings[name];
    document.getElementById('settingsModal').classList.add('open');
  }
  function closeSettingsModal() { document.getElementById('settingsModal').classList.remove('open'); }
  function updateHoldSetting(t,v) { let f=parseFloat(v); f = isNaN(f)?0.5:Math.max(0,Math.min(5,f)); if(t==='load') settings.holdLoad=f; else if(t==='arrive') settings.holdArrive=f; else settings.holdTtn=f; localStorage.setItem('dt_settings_test347', JSON.stringify(settings)); }
  async function updateCycleMinutes(v) {
    if(!canAdmin()){showError('Время ходки задаёт администратор');return;}
    if(!navigator.onLine){showError('Для изменения общего времени ходки требуется связь');return;}
    const n=Math.max(15,parseInt(v)||15);
    try{await appConfigRef.set({cycleMinutes:n},{merge:true});settings.cycleMinutes=n;localStorage.setItem('dt_settings_test347',JSON.stringify(settings));renderAll();}
    catch(e){showError('Время ходки не сохранено: '+e.message);}
  }
  function toggleSetting(k,v) { settings[k]=v; localStorage.setItem('dt_settings_test347', JSON.stringify(settings)); }

  function renderAll() {
    renderHeaderStats();
    if (hasTabAccess('line')) renderLine();
    if (hasTabAccess('report')) renderReport();
    if (hasTabAccess('archive')) renderArchive();
    if (hasTabAccess('trucks')) { renderGlobalTrucksManage(); renderGlobalObjectsManage(); }
    if (hasTabAccess('analytics')) renderAnalytics();
    if (canAdmin()) renderAdminPanel();
    renderStatusTicker();
    updateSyncUI();
  }

  // === SWITCH TAB (с жёсткой проверкой безопасности) ===
