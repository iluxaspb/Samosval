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
      addAudit((enabled?'🔓 Восстановлен доступ: ':'🔒 Ограничен доступ: ')+targetName,{eventType:'user_access',targetUid:uid,status:targetStatus}).catch(e=>reportSyncError('audit',e));
    }catch(e){showError('Не удалось изменить доступ: '+e.message);}
    finally{userAccessWrites.delete(uid);renderAdminPanel();}
  }
  async function updateUserNickname(uid, nickname) { if (!canAdmin()) return; try { await tfAwait(usersRef.doc(uid).update({ nickname: nickname.trim() || null })); addAudit('✏️ Изменено имя пользователя: ' + uid + ' → ' + nickname.trim(), {eventType:'user_nickname',targetUid:uid}).catch(e=>reportSyncError('audit',e)); } catch(e) { showError(e.message); } }
  async function changeUserRole(uid, newRole) {
    if(!canAdmin())return;
    if(!Object.prototype.hasOwnProperty.call(ROLES,newRole)){showError('Неизвестная роль');renderAdminPanel();return;}
    if(uid===currentUid&&newRole!=='admin'){showError('Нельзя снять с себя права администратора');renderAdminPanel();return;}
    try {
      await tfAwait(db.runTransaction(async tx=>{
        const ref=usersRef.doc(uid),snap=await tx.get(ref);
        if(!snap.exists)throw Error('Пользователь не найден');
        if(isForcedAdminEmail(snap.data().email)&&newRole!=='admin')throw Error('Роль владельца приложения защищена');
        if(snap.data().role!==newRole)tx.update(ref,{role:newRole});
      }));
      addAudit('🔐 Изменена роль пользователя: '+uid+' → '+newRole,{eventType:'user_role',targetUid:uid}).catch(e=>reportSyncError('audit',e));
    } catch(e){showError(e.message);renderAdminPanel();}
  }
  async function deleteUser(uid) {
    if(!canAdmin())return;
    if(uid===currentUid){showError('Нельзя удалить собственный доступ');return;}
    if(!(await appConfirm('Удалить доступ?')))return;
    try {
      await tfAwait(db.runTransaction(async tx=>{
        const ref=usersRef.doc(uid),snap=await tx.get(ref);
        if(!snap.exists)return;
        if(isForcedAdminEmail(snap.data().email))throw Error('Доступ владельца приложения защищён');
        tx.delete(ref);
      }));
      addAudit('🗑 Удалён доступ пользователя: '+uid,{eventType:'user_delete',targetUid:uid}).catch(e=>reportSyncError('audit',e));
    }catch(e){showError(e.message);}
  }
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
      addAudit((approve?'✅ Подтверждена регистрация: ':'⛔ Отклонена регистрация: ')+accountEmail+(approve?' · роль '+ROLES[role].label:''),{eventType:approve?'registration_approved':'registration_rejected'}).catch(e=>reportSyncError('audit',e));
      showToastEl(approve?'Доступ открыт':'Заявка отклонена',false);
    }catch(e){showError(escapeHtml(e.message||'Не удалось обработать заявку'));}
    finally{registrationDecisions.delete(reqId);pendingEnd();}
  }
  async function approveRequest(reqId) { return decideRegistration(reqId,true); }
  async function rejectRequest(reqId) { return decideRegistration(reqId,false); }
  let addingUser = false;
  async function addNewUser() {
    if(!canAdmin()||addingUser)return;
    const email=document.getElementById('newUserEmail').value.trim(),passwordInput=document.getElementById('newUserPassword'),password=passwordInput.value,role=document.getElementById('newUserRole').value;
    if(!email||!password){showError('Заполните поля');return;}
    if(!Object.prototype.hasOwnProperty.call(ROLES,role)){showError('Выберите роль');return;}
    addingUser=true;
    const secondaryAuth=secondaryApp.auth();let createdUser=null;
    try {
      const credential=await secondaryAuth.createUserWithEmailAndPassword(email,password);createdUser=credential.user;
      await tfAwait(usersRef.doc(createdUser.uid).set({email:createdUser.email||email,role,status:'active',nickname:sanitizeName(email)}));
      showToastEl('✅ Пользователь создан',false);
    }catch(e){
      showError(createdUser?'Учётная запись создана, но доступ не сохранён: '+(e.message||e.code)+'. Пользователь может войти и отправить заявку для подтверждения.':e.message||'Не удалось создать пользователя');
    }finally{
      passwordInput.value='';
      try {await secondaryAuth.signOut();}catch(e){reportSyncError('secondary-auth',e);}
      addingUser=false;
    }
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

