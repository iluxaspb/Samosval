  // === ВХОД ЧЕРЕЗ UBUNTU API ===
  // Пароль, сессии и заявки проверяет сервер Ubuntu. Firebase SDK остаётся
  // подключённым для данных, но не используется для входа, ролей и заявок.
  const WT_AUTH_ACCESS_KEY = 'wt_access_token';
  const WT_AUTH_REFRESH_KEY = 'wt_refresh_token';
  const WT_AUTH_PROFILE_KEY = 'wt_user_profile';
  const WT_AUTH_EMAIL_KEY = 'working-test-saved-email';
  const WT_AUTH_REFRESH_MARGIN_MS = 120000;
  const WT_AUTH_ERRORS = {
    'invalid-credentials': 'Неверная почта или пароль.',
    'identity-email-required': 'Проверьте адрес почты.',
    'invalid-email': 'Проверьте адрес почты.',
    'invalid-password': 'Пароль должен быть от 8 до 512 символов, без пробелов по краям.',
    'email-already-exists': 'Этот e-mail уже зарегистрирован. Нажмите «Войти».',
    'invalid-nickname': 'Проверьте имя пользователя.',
    'account-disabled': 'Доступ ограничен администратором. Обратитесь к администратору.',
    'account-deleted': 'Учётная запись удалена. Обратитесь к администратору.',
    'pending-approval': 'Заявка ожидает подтверждения администратора.',
    'invalid-session': 'Сеанс истёк. Войдите снова.',
    'invalid-reset-token': 'Код восстановления недействителен или устарел. Запросите новый.',
    'identity-not-ready': 'Сервер ещё не готов принимать вход. Попробуйте позже.',
    'server-error': 'Сервер временно недоступен. Попробуйте позже.',
    'origin-not-allowed': 'Этот адрес сайта не разрешён сервером.',
    'unsupported-media-type': 'Сервер не принял формат запроса.',
    'invalid-json': 'Сервер не разобрал запрос.',
    'body-too-large': 'Слишком большой запрос.'
  };
  let wtSession = null, wtSessionUser = null, wtRefreshTimer = null, wtRefreshFlight = null;
  let wtSessionHandler = null, wtAuthBusy = false, wtResumeStarted = false;
  let registrationInFlight = false;
  function wtAuthBase() {
    try {
      if (typeof nasApiBase === 'function') {
        const base = nasApiBase();
        if (typeof base === 'string' && base) return base.replace(/\/+$/, '');
      }
    } catch (_) {}
    try {
      const fallback = WORKING_TEST_UBUNTU_API_BASE;
      if (typeof fallback === 'string' && fallback) return fallback.replace(/\/+$/, '');
    } catch (_) {}
    return '';
  }
  function wtAuthMessage(code) {
    return WT_AUTH_ERRORS[code] || 'Не удалось выполнить действие. Проверьте соединение и повторите.';
  }
  // В журнал устройств уходят только признаки устройства: без адресов и токенов.
  function wtDeviceInfo() {
    const info = {};
    try { if (navigator.userAgent) info.userAgent = String(navigator.userAgent).slice(0, 200); } catch (_) {}
    try { if (navigator.platform) info.platform = String(navigator.platform).slice(0, 200); } catch (_) {}
    return info;
  }
  async function wtAuthRequest(path, body, options) {
    const base = wtAuthBase();
    if (!base) throw Object.assign(Error('Не настроен адрес сервера Ubuntu.'), { code: 'no-api-base' });
    const headers = {};
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const token = options && options.accessToken;
    if (token) headers.Authorization = 'Bearer ' + token;
    let response;
    try {
      response = await fetch(base + path, Object.assign({ method: 'POST', headers, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' }, payload !== undefined ? { body: payload } : {}));
    } catch (_) {
      throw Object.assign(Error('Нет связи с сервером Ubuntu. Проверьте интернет и повторите.'), { code: 'network' });
    }
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      const code = data && typeof data.error === 'string' ? data.error : 'http-' + response.status;
      throw Object.assign(Error(wtAuthMessage(code)), { code, status: response.status });
    }
    if (!data || typeof data !== 'object') throw Object.assign(Error('Сервер ответил неожиданно. Повторите действие.'), { code: 'invalid-response' });
    return data;
  }
  function wtValidProfile(profile) {
    return !!profile && typeof profile === 'object' && typeof profile.uid === 'string' && profile.uid.length > 0 && profile.uid.length <= 128;
  }
  function wtCacheProfile(profile) {
    if (!wtValidProfile(profile)) return null;
    try { localStorage.setItem(WT_AUTH_PROFILE_KEY, JSON.stringify(profile)); } catch (_) {}
    return profile;
  }
  function wtStoredProfile() {
    try {
      const raw = localStorage.getItem(WT_AUTH_PROFILE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return wtValidProfile(parsed) ? parsed : null;
    } catch (_) { return null; }
  }
  function wtStoredRefreshToken() {
    try { const value = localStorage.getItem(WT_AUTH_REFRESH_KEY); return typeof value === 'string' ? value : ''; } catch (_) { return ''; }
  }
  function wtAccessToken() { return wtSession ? wtSession.accessToken : ''; }
  // Тот же объект-владелец нужен клиенту данных Ubuntu: подпись сессии одна.
  function wtAuthUser() {
    if (!wtSession || !wtValidProfile(wtSession.profile)) return null;
    const profile = wtSession.profile;
    if (wtSessionUser && wtSessionUser.uid === profile.uid) return wtSessionUser;
    wtSessionUser = {
      uid: profile.uid,
      email: profile.email || '',
      displayName: profile.nickname || '',
      localSession: true,
      getIdToken: async force => {
        if (!wtSession || wtSession.profile.uid !== profile.uid) return '';
        if (force === true || wtTokenExpiring()) { try { await wtRefreshSession(); } catch (_) {} }
        return wtSession && wtSession.profile.uid === profile.uid ? wtSession.accessToken : '';
      }
    };
    return wtSessionUser;
  }
  function wtTokenExpiring() {
    const expiresAt = wtSession ? Number(wtSession.expiresAt) || 0 : 0;
    return !expiresAt || expiresAt - Date.now() <= WT_AUTH_REFRESH_MARGIN_MS;
  }
  function wtStoreSession(data) {
    const profile = wtValidProfile(data && data.profile) ? data.profile : null;
    if (!profile) throw Object.assign(Error('Сервер не вернул профиль пользователя.'), { code: 'invalid-profile' });
    const accessToken = data && typeof data.accessToken === 'string' ? data.accessToken : '';
    const refreshToken = data && typeof data.refreshToken === 'string' ? data.refreshToken : '';
    if (!accessToken || !refreshToken) throw Object.assign(Error('Сервер не выдал токены сеанса.'), { code: 'invalid-session' });
    wtSession = { profile, accessToken, refreshToken, expiresAt: Number(data.expiresAt) || 0 };
    wtSessionUser = null;
    try {
      localStorage.setItem(WT_AUTH_ACCESS_KEY, accessToken);
      localStorage.setItem(WT_AUTH_REFRESH_KEY, refreshToken);
      localStorage.setItem(WT_AUTH_PROFILE_KEY, JSON.stringify(profile));
    } catch (_) {}
    wtScheduleRefresh();
    return wtSession;
  }
  function wtClearSession() {
    wtSession = null; wtSessionUser = null;
    if (wtRefreshTimer) { try { clearTimeout(wtRefreshTimer); } catch (_) {} wtRefreshTimer = null; }
    try {
      localStorage.removeItem(WT_AUTH_ACCESS_KEY);
      localStorage.removeItem(WT_AUTH_REFRESH_KEY);
      localStorage.removeItem(WT_AUTH_PROFILE_KEY);
    } catch (_) {}
  }
  function wtScheduleRefresh() {
    if (wtRefreshTimer) { try { clearTimeout(wtRefreshTimer); } catch (_) {} wtRefreshTimer = null; }
    const expiresAt = wtSession ? Number(wtSession.expiresAt) || 0 : 0;
    if (!expiresAt || typeof setTimeout !== 'function') return;
    const delay = Math.max(5000, expiresAt - Date.now() - WT_AUTH_REFRESH_MARGIN_MS);
    wtRefreshTimer = setTimeout(() => { wtRefreshSession().catch(() => {}); }, delay);
  }
  // Продление сеанса. Ошибка означает конец сеанса: токены очищаются, экран
  // входа показывается заново. Молча продолжать работу нельзя.
  async function wtRefreshSession() {
    if (wtRefreshFlight) return wtRefreshFlight;
    const refreshToken = wtSession ? wtSession.refreshToken : wtStoredRefreshToken();
    if (!refreshToken) throw Object.assign(Error(wtAuthMessage('invalid-session')), { code: 'invalid-session' });
    const work = (async () => {
      const data = await wtAuthRequest('/api/v1/auth/refresh', { refreshToken, device: wtDeviceInfo() });
      if (!data || data.pending === true || !data.accessToken) throw Object.assign(Error(wtAuthMessage('invalid-session')), { code: 'invalid-session' });
      const session = wtStoreSession(data);
      return session;
    })();
    wtRefreshFlight = work;
    try { return await work; } finally { if (wtRefreshFlight === work) wtRefreshFlight = null; }
  }
  function wtProfileStatus(profile) {
    if (!wtValidProfile(profile)) return 'signed-out';
    if (profile.deleted === true) return 'deleted';
    if (profile.status === 'pending') return 'pending';
    if (profile.status === 'active') return 'active';
    return 'disabled';
  }
  // Статус берётся только из профиля сервера: pending — ожидание, disabled и
  // deleted — блокировка, active — рабочий интерфейс.
  function wtShowAuthScreens(status, profile) {
    const overlay = document.getElementById('authOverlay');
    const pending = document.getElementById('pendingScreen');
    const disabled = document.getElementById('disabledScreen');
    const header = document.getElementById('mainHeader');
    const container = document.querySelector('.container');
    const nav = document.querySelector('nav');
    const isActive = status === 'active';
    if (overlay) overlay.style.display = status === 'signed-out' ? 'flex' : 'none';
    if (pending) pending.style.display = status === 'pending' ? 'flex' : 'none';
    if (disabled) disabled.style.display = status === 'disabled' || status === 'deleted' ? 'flex' : 'none';
    if (header) header.style.display = isActive ? '' : 'none';
    if (container) container.style.display = isActive ? '' : 'none';
    if (nav) nav.style.display = isActive ? 'flex' : 'none';
    if (status === 'pending') {
      const text = document.getElementById('registrationStatusText');
      if (text) text.textContent = 'Учётная запись ожидает подтверждения администратора.';
    }
    if (status === 'disabled' || status === 'deleted') {
      const title = document.getElementById('disabledStatusTitle');
      const text = document.getElementById('disabledStatusText');
      const reason = profile && typeof profile.rejectionReason === 'string' && profile.rejectionReason ? profile.rejectionReason : '';
      if (title) title.textContent = status === 'deleted' ? 'Учётная запись удалена' : 'Доступ временно ограничен';
      if (text) text.textContent = reason || (status === 'deleted'
        ? 'Учётная запись удалена администратором. Обратитесь к администратору.'
        : 'Доступ ограничен администратором. Обратитесь к администратору, чтобы восстановить доступ.');
    }
    if (status === 'signed-out') {
      wtEnsureRecoveryUI();
      try {
        const saved = localStorage.getItem(WT_AUTH_EMAIL_KEY);
        const field = document.getElementById('authEmail');
        if (saved && field && !field.value) field.value = saved;
      } catch (_) {}
    }
  }
  function wtNotifySession(user) {
    // Событие для модулей, которые раньше реагировали на вход Firebase
    // (например, сброс стека отмены/восстановления).
    try { window.dispatchEvent(new CustomEvent('wt-auth-session-changed', { detail: { uid: user && user.uid ? user.uid : null } })); } catch (_) {}
    if (typeof wtSessionHandler !== 'function') return;
    try { wtSessionHandler(user); } catch (error) { if (typeof reportSyncError === 'function') reportSyncError('auth', error); }
  }
  function wtApplyLocalSession(profile) {
    const status = wtProfileStatus(profile);
    if (status === 'active') {
      wtShowAuthScreens('active', profile);
      wtNotifySession(wtAuthUser());
      return;
    }
    // Сначала сбрасываем состояние прошлого пользователя, затем показываем экран
    // ожидания или блокировки: рабочие данные остаются недоступны.
    wtNotifySession(null);
    wtShowAuthScreens(status, profile);
  }
  function wtSetSessionHandler(handler) {
    wtSessionHandler = typeof handler === 'function' ? handler : null;
    wtResumeStoredSession();
  }
  // Автовход: продлеваем сохранённый сеанс. Любая ошибка очищает токены и
  // возвращает экран входа — приложение не остаётся в подвешенном состоянии.
  function wtResumeStoredSession() {
    if (wtResumeStarted) return; wtResumeStarted = true;
    const refreshToken = wtStoredRefreshToken();
    const stored = wtStoredProfile();
    if (!refreshToken) { wtShowAuthScreens('signed-out'); wtNotifySession(null); return; }
    if (stored) wtShowAuthScreens(wtProfileStatus(stored), stored);
    wtRefreshSession().then(session => {
      wtApplyLocalSession(session.profile);
    }).catch(() => {
      wtClearSession();
      wtShowAuthScreens('signed-out');
      wtNotifySession(null);
    });
  }
  function wtAuthError(element, text, isError) {
    if (!element) return;
    element.style.color = isError ? 'var(--danger)' : 'var(--text)';
    element.textContent = text || '';
  }
  async function handleLogin() {
    if (wtAuthBusy) return;
    const emailField = document.getElementById('authEmail');
    const passwordField = document.getElementById('authPassword');
    const error = document.getElementById('authError');
    const email = emailField ? emailField.value.trim() : '';
    const password = passwordField ? passwordField.value : '';
    if (!email || !password) { wtAuthError(error, 'Укажите почту и пароль.', true); return; }
    wtAuthBusy = true;
    wtAuthError(error, '⏳ Вход...', false);
    try {
      const data = await wtAuthRequest('/api/v1/auth/login', { email, password, device: wtDeviceInfo() });
      if (passwordField) passwordField.value = '';
      try { localStorage.setItem(WT_AUTH_EMAIL_KEY, email); } catch (_) {}
      if (data && data.pending === true) {
        const profile = wtCacheProfile(data.profile);
        wtAuthError(error, '', false);
        wtApplyLocalSession(profile);
        return;
      }
      const session = wtStoreSession(data);
      wtAuthError(error, '', false);
      wtApplyLocalSession(session.profile);
    } catch (failure) {
      wtAuthError(error, failure.message || wtAuthMessage(failure.code), true);
    } finally { wtAuthBusy = false; }
  }
  // Заявку создаёт сервер при регистрации: повторная запись в Firebase не нужна.
  async function ensurePendingAccount() { return null; }
  async function handleRegister() {
    if (registrationInFlight) return;
    const emailField = document.getElementById('authEmail');
    const passwordField = document.getElementById('authPassword');
    const error = document.getElementById('authError');
    const email = emailField ? emailField.value.trim() : '';
    const password = passwordField ? passwordField.value : '';
    if (!email || !password) { wtAuthError(error, 'Введите e-mail и пароль.', true); return; }
    if (password.length < 8) { wtAuthError(error, 'Пароль должен быть не короче 8 символов.', true); return; }
    registrationInFlight = true;
    const button = document.getElementById('registerBtn');
    if (button) button.disabled = true;
    wtAuthError(error, 'Создаём заявку…', false);
    try {
      const data = await wtAuthRequest('/api/v1/auth/register', { email, password, device: wtDeviceInfo() });
      if (passwordField) passwordField.value = '';
      if (data && (data.pending === true || !data.accessToken)) {
        const text = 'Заявка отправлена. Ожидайте подтверждения администратора.';
        wtAuthError(error, text, false);
        const status = document.getElementById('registrationStatusText');
        if (status) status.textContent = text;
        wtApplyLocalSession(wtCacheProfile(data.profile));
        return;
      }
      const session = wtStoreSession(data);
      wtAuthError(error, '', false);
      wtApplyLocalSession(session.profile);
    } catch (failure) {
      wtAuthError(error, failure.message || wtAuthMessage(failure.code), true);
    } finally {
      if (passwordField) passwordField.value = '';
      registrationInFlight = false;
      if (button) button.disabled = false;
    }
  }
  async function handleLogout() {
    if (!(await appConfirm('Выйти?'))) return;
    const refreshToken = wtSession ? wtSession.refreshToken : wtStoredRefreshToken();
    try { if (typeof isNasRuntime === 'function' && isNasRuntime()) await leaveNasPresence(); } catch (_) {}
    // Сессию на сервере отзываем, но локальный выход выполняем в любом случае.
    if (refreshToken) { try { await wtAuthRequest('/api/v1/auth/logout', { refreshToken }); } catch (_) {} }
    wtClearSession();
    try { localStorage.removeItem(WT_AUTH_EMAIL_KEY); } catch (_) {}
    wtNotifySession(null);
    wtShowAuthScreens('signed-out');
    // Перезагрузка только после очистки токенов и экранов: если она не
    // выполнится, приложение всё равно останется на экране входа, а не
    // вернётся в прежнюю сессию.
    location.reload();
  }
  // === ВОССТАНОВЛЕНИЕ ПАРОЛЯ ===
  // Экран входа не переписывается: блок восстановления создаётся рядом с полями
  // и показывается только по кнопке «Забыли пароль?».
  function wtEnsureRecoveryUI() {
    const card = document.querySelector('#authOverlay .auth-card');
    if (!card || document.getElementById('wtRecoveryBlock')) return;
    const block = document.createElement('div');
    block.id = 'wtRecoveryBlock';
    block.style.display = 'none';
    block.innerHTML = '<div id="wtRecoveryStep1"><button type="button" class="btn btn-secondary" style="width:100%;margin-top:10px;" onclick="handleForgotPassword()">Забыли пароль?</button></div>'
      + '<div id="wtRecoveryStep2" style="display:none;margin-top:10px;">'
      + '<div class="form-group"><label>Код восстановления</label><input type="text" id="wtResetToken" class="form-control" autocomplete="one-time-code" placeholder="Код от администратора"></div>'
      + '<div class="form-group"><label>Новый пароль</label><input type="password" id="wtResetPassword" class="form-control" autocomplete="new-password" placeholder="Не короче 8 символов"></div>'
      + '<div style="display:flex;gap:8px;"><button type="button" class="btn btn-quick" style="flex:1;" onclick="handleResetPassword()">Сменить пароль</button>'
      + '<button type="button" class="btn btn-secondary" style="flex:1;" onclick="wtHidePasswordRecovery()">Отмена</button></div></div>';
    card.append(block);
  }
  function wtShowPasswordRecovery() {
    wtEnsureRecoveryUI();
    const block = document.getElementById('wtRecoveryBlock');
    const step2 = document.getElementById('wtRecoveryStep2');
    if (block) block.style.display = '';
    if (step2) step2.style.display = '';
  }
  function wtHidePasswordRecovery() {
    const block = document.getElementById('wtRecoveryBlock');
    const step2 = document.getElementById('wtRecoveryStep2');
    const token = document.getElementById('wtResetToken');
    const password = document.getElementById('wtResetPassword');
    if (step2) step2.style.display = 'none';
    if (token) token.value = '';
    if (password) password.value = '';
    wtAuthError(document.getElementById('authError'), '', false);
    if (block) block.style.display = 'none';
  }
  async function handleForgotPassword() {
    const emailField = document.getElementById('authEmail');
    const error = document.getElementById('authError');
    const email = emailField ? emailField.value.trim() : '';
    if (!email) { wtAuthError(error, 'Сначала укажите почту в поле Email.', true); return; }
    try {
      const data = await wtAuthRequest('/api/v1/auth/forgot', { email });
      wtAuthError(error, (data && typeof data.message === 'string' && data.message) ? data.message : 'Если учётная запись с такой почтой существует, восстановление подготовлено.', false);
      wtShowPasswordRecovery();
    } catch (failure) {
      wtAuthError(error, failure.message || wtAuthMessage(failure.code), true);
    }
  }
  async function handleResetPassword() {
    const tokenField = document.getElementById('wtResetToken');
    const passwordField = document.getElementById('wtResetPassword');
    const error = document.getElementById('authError');
    const token = tokenField ? tokenField.value.trim() : '';
    const newPassword = passwordField ? passwordField.value : '';
    if (!token) { wtAuthError(error, 'Введите код восстановления.', true); return; }
    if (!newPassword || newPassword.length < 8) { wtAuthError(error, 'Новый пароль должен быть не короче 8 символов.', true); return; }
    try {
      await wtAuthRequest('/api/v1/auth/reset', { token, newPassword });
      wtAuthError(error, 'Пароль изменён. Войдите с новым паролем.', false);
      wtHidePasswordRecovery();
      const loginPassword = document.getElementById('authPassword');
      if (loginPassword) loginPassword.value = '';
    } catch (failure) {
      wtAuthError(error, failure.message || wtAuthMessage(failure.code), true);
    }
  }

  // === АДМИН ===
  function switchAdminTab(tab, btn) {
    document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    if(btn) btn.classList.add('active');
    document.getElementById('admin-sub-' + tab).classList.add('active');
    if (tab === 'server') openServerControl();
    if (tab === 'permissions') renderPermissionsMatrix();
    if (tab === 'requests' || tab === 'users') renderAdminPanel();
    if (tab === 'requests') refreshRegistrationRequests();
    if (tab === 'plugins') renderPluginsList();
    if (tab === 'patches') renderPatchesList();
    if (tab === 'console') renderConsole();
    if (tab === 'appsettings') renderAppSettingsIfActive();
  }

  // Регистрация обработчика откладывается до конца загрузки документа:
  // переменные последующих модулей (например, core/15) к этому моменту
  // инициализированы, и восстановление сеанса не попадает в их TDZ.
  function wtRegisterSessionHandler() { wtSetSessionHandler(wtApplyAuthUser); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wtRegisterSessionHandler, { once: true });
  } else {
    setTimeout(wtRegisterSessionHandler, 0);
  }
