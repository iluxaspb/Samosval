  function handleLogin() {
    let email = document.getElementById('authEmail').value.trim(), pass = document.getElementById('authPassword').value, err = document.getElementById('authError');
    if (!email || !pass) { err.textContent = 'Укажите Email и пароль'; return; }
    err.style.color = '#f8fafc'; err.textContent = '⏳ Вход...';
    auth.signInWithEmailAndPassword(email, pass).then(() => {
      localStorage.setItem('dt_saved_email_test347', email);
      document.getElementById('authPassword').value = '';
      err.textContent = '';
    })
    .catch(e => { if (e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential') { err.style.color = 'var(--danger)'; err.textContent = 'Пользователь не найден.'; } else { err.style.color = 'var(--danger)'; err.textContent = e.message; } });
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
    if (registrationInFlight) return;
    const email = document.getElementById('authEmail').value.trim();
    const passwordInput = document.getElementById('authPassword');
    const password = passwordInput.value;
    const error = document.getElementById('authError');
    if (!email || !password) { error.textContent='Введите e-mail и пароль'; return; }
    registrationInFlight=true;
    const button=document.getElementById('registerBtn');button.disabled=true;
    error.style.color='var(--text)';error.textContent='Создаём заявку…';
    let created=false;
    try {
      const credential=await auth.createUserWithEmailAndPassword(email,password);
      created=true;passwordInput.value='';
      await ensurePendingAccount(credential.user);
      error.textContent='Заявка отправлена. Ожидайте подтверждения администратора.';
      document.getElementById('registrationStatusText').textContent=error.textContent;
    } catch(e) {
      error.style.color='var(--danger)';
      const messages={'auth/email-already-in-use':'Этот e-mail уже зарегистрирован. Нажмите «Войти».','auth/invalid-email':'Проверьте e-mail.','auth/weak-password':'Firebase отклонил пароль: используйте более сложный пароль.','auth/operation-not-allowed':'В Firebase необходимо включить вход по e-mail и паролю.'};
      const text=created?'Учётка создана, но заявку отправить не удалось. Обновите страницу после проверки Rules.':messages[e.code]||e.message||'Ошибка регистрации';
      error.textContent=text;
      if(created)document.getElementById('registrationStatusText').textContent=text;
    } finally {passwordInput.value='';registrationInFlight=false;button.disabled=false;}
  }
  async function handleLogout() { if (!(await appConfirm('Выйти?'))) return; localStorage.removeItem('dt_saved_email_test347'); localStorage.removeItem('dt_saved_pass'); auth.signOut(); }

  // === АДМИН ===
  function switchAdminTab(tab, btn) {
    document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    if(btn) btn.classList.add('active');
    document.getElementById('admin-sub-' + tab).classList.add('active');
    if (tab === 'permissions') renderPermissionsMatrix();
    if (tab === 'requests' || tab === 'users') renderAdminPanel();
    if (tab === 'requests') refreshRegistrationRequests();
    if (tab === 'plugins') renderPluginsList();
    if (tab === 'patches') renderPatchesList();
    if (tab === 'console') renderConsole();
    if (tab === 'appsettings') renderAppSettingsIfActive();
  }
