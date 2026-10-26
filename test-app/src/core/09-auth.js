  // === АВТОРИЗАЦИЯ ===
  let authSessionSequence = 0;
  function showAccountGate(message) {
    document.getElementById('registrationStatusText').textContent = message;
    document.getElementById('authOverlay').style.display = 'none';
    document.getElementById('pendingScreen').style.display = 'flex';
    document.getElementById('disabledScreen').style.display = 'none';
    document.getElementById('mainHeader').style.display = 'none';
    document.querySelector('.container').style.display = 'none';
    document.querySelector('nav').style.display = 'none';
  }
  async function handleAuthStateChange(user) {
    if(typeof offlineReleaseJournalOwnership==='function')offlineReleaseJournalOwnership();
    const session = ++authSessionSequence;
    let profileSnapshotSequence = 0;
    const currentSession = () => session === authSessionSequence && currentUid === user?.uid;
    if (user) {
      stopSync();
      permissionsLoaded = false;
      permissionsConfig = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
      document.body.removeAttribute('data-perms-ready');
      currentEmail = user.email || ''; currentUid = user.uid || '';
      if(typeof offlineEnsureJournalOwnership==='function')offlineEnsureJournalOwnership();
      setPermissionsNotice('Проверяем права доступа к разделам…');
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
        const snapshotSequence = ++profileSnapshotSequence;
        const currentProfile = () => currentSession() && snapshotSequence === profileSnapshotSequence;
        try {
        if (!currentProfile()) return;
        markSync('profile', snap.metadata.fromCache, snap.metadata.hasPendingWrites, snap.exists ? 1 : 0);
        if (!snap.exists && snap.metadata.fromCache) {
          setPermissionsNotice('Профиль пользователя не сохранён в офлайн-кэше. Подключитесь к Firebase для проверки доступа.');
          showAccountGate('Профиль не найден в офлайн-кэше. Подключитесь к сети и повторите проверку.');
          updateSyncUI(); return;
        }
        if (!snap.exists) {
          if (forced) await usersRef.doc(currentUid).set({ email: currentEmail, nickname: defaultNick, role: 'admin', status: 'active', createdAt: Date.now(), bootstrap: true });
          else {
            showAccountGate('Проверяем отправку заявки…');
            try {
              await ensurePendingAccount(user);
              if(currentProfile())showAccountGate('Ваша заявка отправлена. Ожидайте решения администратора.');
            } catch(e) {
              if(currentProfile())showAccountGate('Учётная запись создана, но заявку отправить не удалось: '+(e.message||e.code)+'. Подключитесь к сети и повторите проверку.');
              throw e;
            }
            return;
          }
          if(!currentProfile())return;
        }
        const data = snap.exists ? snap.data() : {};
        currentUserRole = data.role || (forced ? 'admin' : 'viewer');
        currentUserStatus = data.status || (forced ? 'active' : 'pending');
        currentUserNickname = data.nickname || defaultNick;
        if (snap.exists && !data.nickname && defaultNick && !forced) { usersRef.doc(currentUid).set({ nickname: defaultNick }, { merge: true }).catch(()=>{}); currentUserNickname = defaultNick; }
        if (forced && (currentUserRole !== 'admin' || currentUserStatus !== 'active')) { await usersRef.doc(currentUid).set({ role: 'admin', status: 'active', nickname: currentUserNickname || defaultNick }, { merge: true }); if(!currentProfile())return; currentUserRole = 'admin'; currentUserStatus = 'active'; }
        if (currentUserStatus === 'pending') {
          activeProfileKey = ''; stopSync();
          showAccountGate('Проверяем отправку заявки…');
          try { await ensurePendingAccount(user); if(currentProfile())showAccountGate('Ваша заявка отправлена. Ожидайте решения администратора.'); }
          catch(e) { if(currentProfile())showAccountGate('Заявка не отправлена: ' + (e.message || e.code) + '. Подключитесь к сети и повторите проверку.'); }
          return; }
        if (currentUserStatus === 'disabled') {
          permissionsLoaded=false;document.body.removeAttribute('data-perms-ready');
          cancelHold();document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelectorAll('.modal.open').forEach(d=>d.classList.remove('open'));
          window.__gameAccessChanged?.();
          document.getElementById('disabledStatusTitle').textContent=data.rejectionReason?'Заявка отклонена':'Доступ временно ограничен';
          document.getElementById('disabledStatusText').textContent=data.rejectionReason||'Доступ ограничен администратором. Обратитесь к администратору, чтобы восстановить доступ, или попробуйте войти позже.';
          activeProfileKey='';stopSync();document.getElementById('pendingScreen').style.display='none';document.getElementById('disabledScreen').style.display='flex';document.getElementById('mainHeader').style.display='none';document.querySelector('.container').style.display='none';document.querySelector('nav').style.display='none';return;
        }
        if(currentUserStatus!=='active')throw Error('Неизвестный статус учётной записи. Обратитесь к администратору');
        document.getElementById('pendingScreen').style.display = 'none'; document.getElementById('disabledScreen').style.display = 'none'; document.getElementById('mainHeader').style.display = ''; document.querySelector('.container').style.display = ''; document.querySelector('nav').style.display = 'flex';
        updateUserBadge(); updateNavUI(); applyRoleUI(); updateSyncUI();
        const profileKey = currentUid + ':' + currentUserRole + ':' + currentUserStatus;
        if (activeProfileKey === profileKey) return;
        activeProfileKey = profileKey;
        startSync(); startAdminSync(); setTimeout(()=>{if(currentSession()&&activeProfileKey===profileKey&&currentUserStatus==='active')runMaxQueue();},1200);
        loadAndApplyPatches().catch(e => {if(currentSession())reportSyncError('patches', e);});
        } catch(e) {
          if(!currentProfile())return;
          permissionsLoaded=false;currentUserRole=null;activeProfileKey='';stopSync();
          document.body.removeAttribute('data-perms-ready');
          showAccountGate('Не удалось проверить учётную запись: '+(e.message||e.code)+'. Повторите проверку после восстановления соединения.');
          reportSyncError('profile', e);
        }
      }, e => {
        if(!currentSession())return;
        profileSnapshotSequence++; // Invalidate an earlier profile callback still awaiting a write.
        stopSync(); permissionsLoaded = false; currentUserRole = null; activeProfileKey = '';
        document.body.removeAttribute('data-perms-ready');
        setPermissionsNotice('Не удалось проверить учётную запись. Остальные разделы скрыты до восстановления соединения.');
        document.getElementById('userBadgeLabel').textContent = '👤 Учётная запись не загружена';
        showAccountGate('Не удалось проверить учётную запись: '+(e.message||e.code)+'. Повторите проверку после восстановления соединения.');
        reportSyncError('profile', e);
        renderAll();
      });
    } else {
      currentEmail = ''; currentUid = ''; currentUserRole = null; currentUserStatus = null; currentUserNickname = '';
      setPermissionsNotice('');
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
      let savedEmail='';try { savedEmail=localStorage.getItem('dt_saved_email')||''; } catch(e) {}
      if (savedEmail) document.getElementById('authEmail').value = savedEmail;
      document.getElementById('authPassword').value = '';
    }
  }
  auth.onAuthStateChanged(handleAuthStateChange);
  function retryAccountCheck() {
    if(!auth.currentUser)return handleAuthStateChange(null);
    return handleAuthStateChange(auth.currentUser);
  }

  function updateUserBadge() { const badge = document.getElementById('userBadgeLabel'); if (!badge) return; const roleInfo = ROLES[currentUserRole] || ROLES.viewer; const chip = `<span class="role-chip ${roleInfo.color}">${roleInfo.icon} ${roleInfo.label}</span>`; badge.innerHTML = `👤 ${escapeHtml(getUserName())} ${chip}`; }
  function applyRoleUI() {
    const versionAllowed = permissionsLoaded && canAdmin();
    if (versionAllowed) document.body.setAttribute('data-release-admin', '1');
    else document.body.removeAttribute('data-release-admin');
    if (!versionAllowed) document.getElementById('releaseHistoryDialog')?.close();
    const viewBanner = document.getElementById('viewOnlyBanner'); const canDoAnything = hasPermission('start_shift') || hasPermission('edit_line') || hasPermission('action_load');
    if (viewBanner) viewBanner.style.display = (!canDoAnything && state.shift) ? 'block' : 'none';
    const startBtn = document.getElementById('startShiftBtn'); if (startBtn) startBtn.style.display = hasPermission('start_shift') ? '' : 'none';
    const truckForm = document.getElementById('truckFormCard'); if (truckForm) truckForm.style.display = hasPermission('manage_trucks') ? '' : 'none';
    const objectForm = document.getElementById('objectFormCard'); if (objectForm) objectForm.style.display = hasPermission('manage_objects') ? '' : 'none';
    const changeObjBtn = document.getElementById('changeObjBtn'); if (changeObjBtn) changeObjBtn.style.display = hasPermission('edit_line') ? 'inline-block' : 'none';
    const headerExtra = document.getElementById('headerExtraContent'); if (headerExtra) headerExtra.style.display = hasPermission('view_header') ? '' : 'none';
    const gaiToggleContainer = document.getElementById('gaiReportToggleContainer');
    if (gaiToggleContainer) { const canGai = hasPermission('view_gai_report'); gaiToggleContainer.style.display = canGai ? 'flex' : 'none'; if (!canGai) showGAITable = false; }
  }
  let loginInFlight = false;
  async function handleLogin() {
    if(loginInFlight||registrationInFlight)return;
    const email=document.getElementById('authEmail').value.trim(),passwordInput=document.getElementById('authPassword'),password=passwordInput.value,error=document.getElementById('authError');
    if(!email||!password){error.textContent='Укажите Email и пароль';return;}
    loginInFlight=true;error.style.color='var(--text)';error.textContent='⏳ Вход…';
    try {
      await auth.signInWithEmailAndPassword(email,password);
      try { localStorage.setItem('dt_saved_email',email); } catch(e) {}
      passwordInput.value='';error.textContent='';
    } catch(e) {
      error.style.color='var(--danger)';
      const messages={'auth/user-not-found':'Неверный e-mail или пароль.','auth/wrong-password':'Неверный e-mail или пароль.','auth/invalid-credential':'Неверный e-mail или пароль.','auth/network-request-failed':'Нет связи с сервером входа. Проверьте подключение.','auth/too-many-requests':'Слишком много попыток входа. Попробуйте позже.'};
      error.textContent=messages[e.code]||e.message||'Не удалось войти';
    } finally {loginInFlight=false;}
  }
  let registrationInFlight = false;
  async function ensurePendingAccount(user) {
    const profileRef = usersRef.doc(user.uid), requestRef = requestsRef.doc(user.uid);
    await db.runTransaction(async tx => {
      const profile = await tx.get(profileRef);
      const request = await tx.get(requestRef);
      if (profile.exists && profile.data().status !== 'pending') return;
      const email = user.email || '';
      const nickname = profile.exists ? profile.data().nickname || sanitizeName(email) : sanitizeName(email);
      if (!profile.exists) tx.set(profileRef,{email,nickname,role:'viewer',status:'pending',createdAt:Date.now()});
      if (!request.exists) tx.set(requestRef,{uid:user.uid,email,nickname,status:'pending',createdAt:Date.now()});
    });
  }
  async function handleRegister() {
    if (registrationInFlight || loginInFlight) return;
    const email = document.getElementById('authEmail').value.trim();
    const passwordInput = document.getElementById('authPassword');
    const password = passwordInput.value;
    const error = document.getElementById('authError');
    if (!email || !password) { error.textContent='Введите e-mail и пароль'; return; }
    registrationInFlight=true;
    const button=document.getElementById('registerBtn');button.disabled=true;
    error.style.color='var(--text)';error.textContent='Создаём заявку…';
    let created=false,createdUser=null;
    try {
      const credential=await auth.createUserWithEmailAndPassword(email,password);
      created=true;createdUser=credential.user;passwordInput.value='';
      try { localStorage.setItem('dt_saved_email',email); } catch(e) {}
      await ensurePendingAccount(credential.user);
      if(auth.currentUser?.uid!==credential.user.uid)return;
      error.textContent='Заявка отправлена. Ожидайте подтверждения администратора.';
      document.getElementById('registrationStatusText').textContent=error.textContent;
    } catch(e) {
      error.style.color='var(--danger)';
      const messages={'auth/email-already-in-use':'Этот e-mail уже зарегистрирован. Нажмите «Войти».','auth/invalid-email':'Проверьте e-mail.','auth/weak-password':'Firebase отклонил пароль: используйте более сложный пароль.','auth/operation-not-allowed':'В Firebase необходимо включить вход по e-mail и паролю.'};
      if(created&&(auth.currentUser?.uid!==createdUser.uid||currentUserStatus==='active'))return;
      const text=created?'Учётная запись создана, но заявку отправить не удалось. Повторите проверку после восстановления соединения.':messages[e.code]||e.message||'Ошибка регистрации';
      error.textContent=text;
      if(created)showAccountGate(text);
    } finally {passwordInput.value='';registrationInFlight=false;button.disabled=false;}
  }
  async function handleLogout() {
    if (!(await appConfirm('Выйти?'))) return;
    try {
      await auth.signOut();
      try {localStorage.removeItem('dt_saved_email');localStorage.removeItem('dt_saved_pass');}catch(e){}
    } catch(e) {showError('Не удалось выйти: '+(e.message||e.code));}
  }

