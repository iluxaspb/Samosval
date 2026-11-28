// Отладочная смена аккаунта (только тестовая линия, только администратор).
//
// Администратор нажимает на бейдж в шапке и получает окно аккаунта: обычный
// выход и «Сменить аккаунт» — вход под тестовой учёткой выбранной роли. Вход
// идёт штатным /api/v1/auth/login с реальным паролем: сервер не подменяет
// личность и не выдаёт сессию «от имени другого», поэтому права, аудит и
// сессии работают как всегда.
//
// Пароль тестовых учёток совпадает с админским (так задумано владельцем),
// поэтому в окне есть «Сохранить на этом устройстве» и «Забыть пароль».
// Хранится он только в localStorage этого браузера, ключ ограничен каналом
// через префикс хранилища рабочей тестовой версии.
(function (root) {
  'use strict';

  const PASSWORD_KEY = 'debug_account_password';

  // Один тестовый аккаунт на роль. Адрес обязан совпадать с
  // server/scripts/seed-debug-accounts.mjs — это проверяет тест
  // features/debug-accounts.test.mjs.
  const ACCOUNTS = Object.freeze([
    Object.freeze({ role: 'senior_foreman', label: 'Старший прораб', icon: '👑', email: 'debug-senior@debug.samosval.test' }),
    Object.freeze({ role: 'foreman', label: 'Прораб', icon: '🔧', email: 'debug-foreman@debug.samosval.test' }),
    Object.freeze({ role: 'master', label: 'Мастер', icon: '🛠', email: 'debug-master@debug.samosval.test' }),
    Object.freeze({ role: 'lopater', label: 'Лопатер', icon: '🪏', email: 'debug-lopater@debug.samosval.test' }),
    Object.freeze({ role: 'viewer', label: 'Наблюдатель', icon: '👁', email: 'debug-viewer@debug.samosval.test' })
  ]);

  function accountFor(role) {
    return ACCOUNTS.find(item => item.role === role) || null;
  }

  function createDebugAccounts(deps) {
    const { storage, isAdmin, currentProfile, previousRefreshToken, snapshotSession, restoreSession, applySession, login, revokeRefreshToken, leavePresence, reload, notify, doc } = deps;
    let switching = false;

    function savedPassword() {
      try { return String(storage.getItem(PASSWORD_KEY) || ''); } catch (_) { return ''; }
    }
    function savePassword(value) {
      const text = String(value == null ? '' : value);
      if (!text) { forgetPassword(); return false; }
      try { storage.setItem(PASSWORD_KEY, text); return true; } catch (_) { return false; }
    }
    function forgetPassword() {
      try { storage.removeItem(PASSWORD_KEY); } catch (_) {}
    }

    // Смена аккаунта: сначала входим под тестовой учёткой, и только после
    // успешного входа гасим прежнюю сессию. Неверный пароль не выкидывает
    // администратора из приложения.
    async function switchTo(role, password) {
      if (!isAdmin()) throw new Error('Смена аккаунта доступна только администратору');
      const account = accountFor(role);
      if (!account) throw new Error('Неизвестная роль для отладки');
      if (switching) throw new Error('Смена аккаунта уже выполняется');
      const secret = String(password == null ? savedPassword() : password).trim();
      if (!secret) throw new Error('Введите пароль тестовых учёток');
      const previous = typeof previousRefreshToken === 'function' ? previousRefreshToken() : '';
      const previousSession = typeof snapshotSession === 'function' ? snapshotSession() : null;
      switching = true;
      try {
        try { if (typeof leavePresence === 'function') await leavePresence(); } catch (_) {}
        // Серверный вход не трогает текущую локальную сессию. Только после
        // успешной проверки данных заменяем её тестовой, иначе сохраняем админа.
        const nextSession = await login(account.email, secret);
        await applySession(nextSession);
        if (previous && typeof revokeRefreshToken === 'function') {
          try { await revokeRefreshToken(previous); } catch (_) {}
        }
        reload();
        return { role: account.role, email: account.email };
      } catch (error) {
        if (previousSession && typeof restoreSession === 'function') await restoreSession(previousSession);
        throw error;
      } finally { switching = false; }
    }

    function roleButtons() {
      return ACCOUNTS.map(account => ({
        role: account.role,
        label: account.label,
        icon: account.icon,
        email: account.email
      }));
    }

    // Отрисовка окна: список ролей, поле пароля и подпись текущего аккаунта.
    function render() {
      const el = id => (doc ? doc.getElementById(id) : null);
      const current = typeof currentProfile === 'function' ? currentProfile() : null;
      const caption = el('accountCurrent');
      if (caption) {
        caption.textContent = current && current.name
          ? 'Вы вошли как ' + current.name + (current.roleLabel ? ' · ' + current.roleLabel : '')
          : '';
      }
      const block = el('debugAccountsBlock');
      if (block) block.style.display = isAdmin() ? '' : 'none';
      const list = el('debugAccountsList');
      if (list) {
        list.textContent = '';
        roleButtons().forEach(account => {
          const button = doc.createElement('button');
          button.type = 'button';
          button.className = 'btn btn-secondary btn-small';
          button.dataset.debugRole = account.role;
          button.textContent = account.icon + ' ' + account.label;
          button.onclick = () => runSwitch(account.role);
          list.appendChild(button);
        });
      }
      const field = el('debugAccountPassword');
      if (field) field.value = savedPassword();
      const box = el('debugAccountSavePassword');
      if (box) box.checked = !!savedPassword();
      const forget = el('debugAccountForget');
      if (forget) forget.style.display = savedPassword() ? '' : 'none';
    }

    async function runSwitch(role) {
      const el = id => (doc ? doc.getElementById(id) : null);
      const field = el('debugAccountPassword');
      const box = el('debugAccountSavePassword');
      const password = field ? field.value : '';
      if (box && box.checked) savePassword(password);
      try {
        await switchTo(role, password);
      } catch (error) {
        if (typeof notify === 'function') notify(error.message || 'Не удалось сменить аккаунт', true);
        render();
      }
    }

    function open() {
      render();
      const modal = doc ? doc.getElementById('accountModal') : null;
      if (modal) modal.classList.add('open');
      return !!modal;
    }
    function close() {
      const modal = doc ? doc.getElementById('accountModal') : null;
      if (modal) modal.classList.remove('open');
    }

    return Object.freeze({
      accounts: ACCOUNTS,
      roleButtons,
      savedPassword,
      savePassword,
      forgetPassword,
      switchTo,
      render,
      open,
      close
    });
  }

  const api = { PASSWORD_KEY, ACCOUNTS, accountFor, createDebugAccounts };
  if (root) root.WorkingTestDebugAccounts = api;

  // Браузерная обвязка: реальные сессия, хранилище и перезагрузка страницы.
  if (root && typeof document !== 'undefined' && typeof window !== 'undefined' && root === window) {
    const instance = createDebugAccounts({
      doc: document,
      storage: window.localStorage,
      isAdmin: () => typeof canAdmin === 'function' && canAdmin(),
      currentProfile: () => ({
        name: typeof getUserName === 'function' ? getUserName() : '',
        roleLabel: typeof ROLES !== 'undefined' && ROLES[currentUserRole] ? ROLES[currentUserRole].label : ''
      }),
      previousRefreshToken: () => {
        try { return wtSession ? wtSession.refreshToken : wtStoredRefreshToken(); } catch (_) { return ''; }
      },
      leavePresence: () => {
        try { if (typeof isNasRuntime === 'function' && isNasRuntime()) return leaveNasPresence(); } catch (_) {}
        return Promise.resolve();
      },
      snapshotSession: () => ({
        session: wtSession,
        user: wtSessionUser,
        access: localStorage.getItem(WT_AUTH_ACCESS_KEY),
        refresh: localStorage.getItem(WT_AUTH_REFRESH_KEY),
        profile: localStorage.getItem(WT_AUTH_PROFILE_KEY)
      }),
      restoreSession: snapshot => {
        wtSession = snapshot.session;
        wtSessionUser = snapshot.user;
        if (wtSession) wtScheduleRefresh();
        try {
          if (snapshot.access == null) localStorage.removeItem(WT_AUTH_ACCESS_KEY); else localStorage.setItem(WT_AUTH_ACCESS_KEY, snapshot.access);
          if (snapshot.refresh == null) localStorage.removeItem(WT_AUTH_REFRESH_KEY); else localStorage.setItem(WT_AUTH_REFRESH_KEY, snapshot.refresh);
          if (snapshot.profile == null) localStorage.removeItem(WT_AUTH_PROFILE_KEY); else localStorage.setItem(WT_AUTH_PROFILE_KEY, snapshot.profile);
        } catch (_) {}
      },
      applySession: data => wtStoreSession(data),
      login: async (email, password) => {
        const data = await wtAuthRequest('/api/v1/auth/login', { email, password, device: wtDeviceInfo() });
        if (!data || data.pending === true) throw new Error('Тестовая учётка не активна');
        return data;
      },
      revokeRefreshToken: async token => {
        await wtAuthRequest('/api/v1/auth/logout', { refreshToken: token });
      },
      reload: () => location.reload(),
      notify: (message, isError) => {
        if (isError) showError(message); else showToastEl(message, false);
      }
    });

    window.openDebugAccounts = () => instance.open();
    window.closeDebugAccounts = () => instance.close();
    window.debugSwitchAccount = role => instance.switchTo(role);
    window.forgetDebugAccountPassword = () => {
      instance.forgetPassword();
      instance.render();
      showToastEl('Сохранённый пароль тестовых учёток удалён', false);
    };
    window.WorkingTestDebugAccounts.instance = instance;
    Object.freeze(window.WorkingTestDebugAccounts);
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
