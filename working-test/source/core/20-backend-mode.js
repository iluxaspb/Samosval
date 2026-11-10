  // TEST only. Firestore remains the sole data writer until the complete NAS
  // interface is connected. A reachable health endpoint is not a data adapter.
  const TEST_BACKEND_MODE_LABELS = Object.freeze({ firebase: 'Firebase — сервер данных', ubuntu: 'Ubuntu — сервер данных' });
  const WORKING_AUTHORITY_PATH = 'workspaces/main_workspace/settings/backendAuthority';
  window.WorkingTestAuthority = window.WorkingTestAuthority || { runtimeProvider: 'firebase', generation: null, stop: null };

  // Единственный владелец записи объявлен сервером Ubuntu (таблица
  // server_authority). Firebase-документ — только зеркало для тех клиентов,
  // которые не могут прочитать сервер. Поэтому переключение всегда идёт
  // через серверную процедуру, а не через локальную настройку браузера.
  const WORKING_AUTHORITY_API = WORKING_TEST_UBUNTU_API_BASE + '/api/v1/authority';

  async function workingAuthorityRequest(method, body) {
    if (!auth.currentUser) throw Error('Нужен вход в приложение');
    const token = await auth.currentUser.getIdToken();
    const headers = { Authorization: 'Bearer ' + token };
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(WORKING_AUTHORITY_API, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = Error((payload && (payload.error || payload.message)) || ('HTTP ' + response.status));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function mirrorAuthorityToFirestore(authority) {
    try {
      await db.doc(WORKING_AUTHORITY_PATH).set({
        provider: authority.provider,
        generation: authority.generation,
        updatedAt: Date.now(),
        updatedBy: currentUid || null
      });
    } catch (_) { /* зеркало необязательно: истина на сервере */ }
  }

  async function readWorkingAuthority() {
    if (auth.currentUser) {
      try {
        const state = await workingAuthorityRequest('GET');
        const a = state && state.authority;
        if (a && ['firebase', 'ubuntu'].includes(a.provider) && Number.isInteger(a.generation) && a.generation > 0) {
          void mirrorAuthorityToFirestore(a);
          return { provider: a.provider, generation: a.generation };
        }
      } catch (_) { /* сервер недоступен — читаем зеркало */ }
    }
    const ref = db.doc(WORKING_AUTHORITY_PATH);
    try {
      const snap = await ref.get({ source: 'server' });
      if (!snap.exists) return { provider: 'firebase', generation: 0 };
      const data = snap.data() || {};
      if (!['firebase', 'ubuntu'].includes(data.provider) || !Number.isInteger(data.generation) || data.generation < 0) throw Error('Режим сервера повреждён');
      return { provider: data.provider, generation: data.generation };
    } catch (error) {
      if (error.code === 'permission-denied') throw error;
      throw Error('Не удалось подтвердить общий режим данных');
    }
  }
  function watchWorkingAuthority() {
    if (window.WorkingTestAuthority.stop) window.WorkingTestAuthority.stop();
    // До входа общий документ недоступен по правилам: не подписываемся и не
    // пугаем пользователя отказом доступа на экране входа.
    if (!auth.currentUser) return;
    window.WorkingTestAuthority.stop = db.doc(WORKING_AUTHORITY_PATH).onSnapshot({includeMetadataChanges:false}, snap => {
      const data=snap.exists?snap.data():{};
      if (!snap.exists) { window.WorkingTestAuthority.runtimeProvider='firebase'; window.WorkingTestAuthority.generation=0; return; }
      if (!['firebase','ubuntu'].includes(data.provider) || !Number.isInteger(data.generation)) return;
      const changed=window.WorkingTestAuthority.generation!==null && window.WorkingTestAuthority.generation!==data.generation;
      window.WorkingTestAuthority.runtimeProvider=data.provider; window.WorkingTestAuthority.generation=data.generation; renderTestBackendControls();
      if (changed && location.reload) location.reload();
    }, error => { if (error.code==='permission-denied' && currentUid) showError('Нет доступа к общему режиму сервера. Переключение остановлено.'); });
  }
  window.addEventListener('online', () => { readWorkingAuthority().then(a => { window.WorkingTestAuthority.runtimeProvider=a.provider; window.WorkingTestAuthority.generation=a.generation; }).catch(()=>{}); });

  function testBackendPreferenceKey() {
    return currentUid ? 'wt_backend_mode:' + firebaseConfig.projectId + ':' + location.pathname + ':' + WORKSPACE_ID + ':' + currentUid : null;
  }

  function getTestBackendMode() {
    const key = testBackendPreferenceKey();
    if (!key) return 'firebase';
    try {
      const mode = localStorage.getItem(key);
      // Never activate an unsupported provider from an old or edited preference.
      return mode === 'ubuntu' || mode === 'firebase' ? mode : 'firebase';
    } catch (_) { return 'firebase'; }
  }

  // The device preference is only a request. The single shared decision lives in
  // one Firestore document and is written transactionally by an administrator —
  // for BOTH directions. Existing rules already allow an active user to read and
  // an admin to write workspaces/main_workspace/settings/*, so no rule or schema
  // change to the working database is required.
  async function writeAuthority(mode, expectedGeneration) {
    // Одна транзакция на сервере: проверка поколения + смена владельца записи.
    // Локальная настройка браузера владельцем не является.
    const result = await workingAuthorityRequest('POST', {
      provider: mode,
      expectedGeneration,
      reason: 'Ручное переключение администратором'
    });
    const authority = result && result.authority;
    if (!authority) throw Error('Сервер не подтвердил переключение');
    await mirrorAuthorityToFirestore(authority);
    return authority;
  }

  // Перед передачей права записи резерву проверяем, что резерв действительно
  // готов: в нём есть наша учётная запись и рабочие данные. Иначе телефон
  // переключился бы в пустую базу и потерял доступ.
  async function checkReserveReadiness() {
    const token = await auth.currentUser.getIdToken();
    const session = await fetch(WORKING_TEST_UBUNTU_API_BASE + '/api/v1/session', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!session.ok) {
      if (session.status === 403) throw Error('Резерв пока не содержит вашу учётную запись. Дождитесь репликации или проверьте права.');
      throw Error('Резерв не ответил на проверку сеанса: HTTP ' + session.status);
    }
    const line = await fetch(WORKING_TEST_UBUNTU_API_BASE + '/api/v1/line/snapshot', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!line.ok) throw Error('Резерв не отдал данные линии: HTTP ' + line.status);
    const snapshot = await line.json().catch(() => null);
    const trucks = Array.isArray(snapshot?.trucks) ? snapshot.trucks.length : 0;
    if (!trucks) throw Error('В резерве ещё нет данных линии. Дождитесь репликации, затем повторите.');
    return trucks;
  }

  async function pushAuthorityToServer(mode) {
    if (mode !== 'ubuntu' && mode !== 'firebase') return null;
    try {
      const current = await readWorkingAuthority();
      if (current.provider === mode) return current;
      if (mode === 'ubuntu') await checkReserveReadiness();
      const next = await writeAuthority(mode, current.generation);
      window.WorkingTestAuthority.runtimeProvider = next.provider;
      window.WorkingTestAuthority.generation = next.generation;
      showToastEl('Сервер данных: ' + TEST_BACKEND_MODE_LABELS[mode], false);
      return next;
    } catch (error) {
      showError(error.code === 'authority-generation-conflict'
        ? error.message
        : 'Сервер не подтвердил переключение: ' + (error.message || error.code || 'ошибка'));
      return null;
    }
  }

  // The provider has to be known BEFORE the authenticated runtime starts,
  // otherwise the app boots into Firebase and the switch looks like it "jumps
  // back". Called from the auth flow before isNasRuntime() is evaluated.
  let workingAuthorityReady = null;
  function ensureWorkingAuthority() {
    if (window.WorkingTestAuthority.ready) return Promise.resolve(window.WorkingTestAuthority);
    if (!workingAuthorityReady) {
      workingAuthorityReady = readWorkingAuthority().then(a => {
        window.WorkingTestAuthority.runtimeProvider = a.provider;
        window.WorkingTestAuthority.generation = a.generation;
        window.WorkingTestAuthority.ready = true;
        return window.WorkingTestAuthority;
      }).catch(error => {
        workingAuthorityReady = null; // retry on the next login/reconnect
        if (error && error.code === 'permission-denied') {
          showError('Нет доступа к общему режиму сервера. Работаем на Firebase.');
        }
        return window.WorkingTestAuthority;
      });
    }
    return workingAuthorityReady;
  }

  function setTestBackendMode(mode) {
    const key = testBackendPreferenceKey();
    const policy = window.WorkingTestSwitchPolicy;
    const pending = typeof offlinePendingOps === 'function' ? offlinePendingOps().length : 0;
    const plan = policy.decideSwitchPlan({
      target: mode,
      authenticated: !!currentUid,
      isAdmin: canAdmin(),
      permissionsLoaded: permissionsLoaded,
      pending: pending,
      currentProvider: window.WorkingTestAuthority.runtimeProvider,
      generation: window.WorkingTestAuthority.generation
    });
    if (!plan.ok) {
      renderTestBackendControls();
      showError(plan.error);
      return false;
    }
    if (plan.noop) {
      renderTestBackendControls();
      showToastEl('Сервер данных уже ' + TEST_BACKEND_MODE_LABELS[mode], false);
      return true;
    }
    if (!key) {
      renderTestBackendControls();
      showError('Не удалось определить устройство для сохранения режима.');
      return false;
    }
    // Локальная отметка — только для показа на этом устройстве. Владельца
    // записи меняет сервер, поэтому перезагрузка идёт лишь после подтверждения.
    try { localStorage.setItem(key, mode); } catch (_) {}
    updateSyncUI();
    showToastEl('Переключаем сервер данных…', false);
    const switching = pushAuthorityToServer(mode);
    if (typeof location !== 'undefined' && typeof location.reload === 'function') {
      Promise.resolve(switching).then(next => {
        if (!next) { renderTestBackendControls(); return; }
        setTimeout(() => location.reload(), 500);
      });
    }
    return true;
  }
  watchWorkingAuthority();

  function getTestBackendIndicator(status) {
    if(isNasRuntime())return {letter:status.state==='offline'?'О':'S',label:status.state==='offline'?'Ubuntu — локальная очередь':status.state==='ok'?'Ubuntu — сервер данных':'Ubuntu — '+status.text,provider:'ubuntu'};
    if (status.state === 'offline') return {letter:'О', label:'Офлайн', provider:'firebase'};
    if (!currentUid || status.state === 'init') return {letter:'…', label:'Firebase — подключение ещё не подтверждено', provider:'firebase'};
    if (status.state === 'error') return {letter:'!', label:'Firebase — требуется проверка синхронизации', provider:'firebase'};
    return {letter:'F', label:'Firebase — сервер данных', provider:'firebase'};
  }

  let testUbuntuCheckPending = false;
  let testUbuntuCheckSession = null;
  let testUbuntuCheckEpoch = 0;

  function loadTestUbuntuChecker() {
    return import(new URL('./working-test/synology/connection-check.mjs', document.baseURI).href);
  }

  async function checkTestUbuntuConnection() {
    const allowed = !!currentUid && permissionsLoaded && canAdmin();
    if (!allowed || testUbuntuCheckPending || !navigator.onLine) return;
    const result = document.getElementById('testUbuntuCheckResult');
    if (!result) return;
    renderTestBackendControls();
    const uid = currentUid, epoch = testUbuntuCheckEpoch;
    const guard = () => {
      if (uid !== currentUid || epoch !== testUbuntuCheckEpoch || !permissionsLoaded || !canAdmin()) throw Error('Сеанс изменился');
    };
    testUbuntuCheckPending = true;
    result.textContent = 'Проверка линии и табеля Ubuntu…';
    renderTestBackendControls();
    try {
      const {checkSynology} = await loadTestUbuntuChecker();
      guard();
      const counts = await checkSynology({getIdToken: force => auth.currentUser?.getIdToken(force), guard});
      guard();
      result.textContent = `Линия и табель доступны. Машин: ${counts.trucks}; обычных рейсов: ${counts.normal}; объём: ${counts.volume} м³. Это проверка Ubuntu API; данные программы остаются в Ubuntu.`;    } catch (error) {
      if (uid === currentUid && epoch === testUbuntuCheckEpoch && permissionsLoaded && canAdmin()) {
        result.textContent = error.status === 404
          ? 'По внешнему адресу Ubuntu API недоступен. Нужно проверить HTTPS-маршрут на Ubuntu.'
          : error.name === 'AbortError' ? 'Ubuntu не ответил вовремя.' : error.message;
      }
    } finally {
      testUbuntuCheckPending = false;
      renderTestBackendControls();
    }
  }

  function renderTestBackendControls(status) {
    const section = document.getElementById('admin-backend-settings');
    if (!section) return;
    const allowed = !!currentUid && permissionsLoaded && canAdmin();
    section.hidden = !allowed;
    const session = allowed ? currentUid : null;
    const probeResult = document.getElementById('testUbuntuCheckResult');
    if (session !== testUbuntuCheckSession) {
      testUbuntuCheckSession = session;
      testUbuntuCheckEpoch++;
      if (probeResult) probeResult.textContent = '';
    }
    const probeButton = document.getElementById('testUbuntuCheck');
    if (probeButton) probeButton.disabled = !allowed || !navigator.onLine || testUbuntuCheckPending;
    const select = document.getElementById('testBackendMode');
    if (select) {
      select.disabled = !allowed;
      // Показываем фактический владелец записи, а не локальную настройку:
      // иначе список говорит «Ubuntu», а приложение работает на Firebase.
      select.value = window.WorkingTestAuthority.runtimeProvider === 'ubuntu' ? 'ubuntu' : 'firebase';
    }
    const actual = document.getElementById('testBackendActual');
    if (actual) actual.textContent = getTestBackendIndicator(status || getSyncStatus()).label;
    const note = document.getElementById('testBackendModeNote');
    const shared = window.WorkingTestAuthority;
    const sharedText = shared.generation
      ? ' Общий владелец записи: ' + (shared.runtimeProvider === 'ubuntu' ? 'Ubuntu' : 'Firebase')
        + ' (поколение ' + shared.generation + ') — действует для всех устройств.'
      : ' Общий владелец записи ещё не подтверждён сервером.';
    if (note) note.textContent = (shared.runtimeProvider === 'ubuntu'
      ? 'Данные обслуживает Ubuntu. Firebase остаётся только для входа пользователей.'
      : 'Данные обслуживает Firebase. Ubuntu получает изменённые записи как резерв раз в минуту.') + sharedText;
  }
