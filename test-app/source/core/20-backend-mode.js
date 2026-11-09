  // TEST only. Firestore remains the sole data writer until the complete NAS
  // interface is connected. A reachable health endpoint is not a data adapter.
  const TEST_BACKEND_MODE_LABELS = Object.freeze({
    firebase: 'Только Firebase', ubuntu: 'Только Ubuntu', auto: 'Автоматически'
  });

  function testBackendPreferenceKey() {
    return currentUid ? 'dt_backend_mode_test:' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + currentUid : null;
  }

  function getTestBackendMode() {
    const key = testBackendPreferenceKey();
    if (!key) return 'ubuntu';
    try {
      const mode = localStorage.getItem(key);
      // Never activate an unsupported provider from an old or edited preference.
      return mode === 'auto' || mode === 'ubuntu' || mode === 'firebase' ? mode : 'ubuntu';
    } catch (_) { return 'ubuntu'; }
  }

  // The device preference is only a request. The server decides who may write,
  // and the decision is recorded once for the whole system.
  async function pushAuthorityToServer(mode) {
    if (mode === 'auto') return null;
    const client = typeof nasRuntimeClient === 'undefined' ? null : nasRuntimeClient;
    if (!client || typeof client.readAuthority !== 'function') return null;
    try {
      const state = await client.readAuthority();
      const current = state.authority;
      if (current.provider === mode) return current;
      const result = await client.submitAuthority({
        id: 'authority_' + crypto.randomUUID().replaceAll('-', ''),
        provider: mode,
        expectedGeneration: current.generation,
        reason: 'Ручное переключение администратором'
      });
      showToastEl('Сервер данных: ' + TEST_BACKEND_MODE_LABELS[mode], false);
      return result.authority;
    } catch (error) {
      showError(error.code === 'authority-generation-conflict'
        ? 'Режим уже изменил другой администратор. Откройте админку заново.'
        : 'Сервер не подтвердил переключение: ' + (error.message || error.code || 'ошибка'));
      return null;
    }
  }

  function setTestBackendMode(mode) {
    const key = testBackendPreferenceKey();
    if (!key || !permissionsLoaded || !canAdmin()) {
      renderTestBackendControls();
      showError('Режим сервера может менять только активный администратор.');
      return false;
    }
    if (!Object.hasOwn(TEST_BACKEND_MODE_LABELS, mode)) {
      renderTestBackendControls();
      showError('Неизвестный режим сервера.');
      return false;
    }
    // The Firebase reserve has no working data plane yet. Declaring it
    // authoritative would make every Ubuntu write fail and leave the phones
    // with empty data, so the reserve stays closed until it is built and
    // verified end to end. Nothing is written to the server in that case.
    if (mode === 'firebase') {
      renderTestBackendControls();
      showError('Резерв Firebase пока не готов принимать данные. Работаем на Ubuntu.');
      return false;
    }
    try { localStorage.setItem(key, mode); }
    catch (_) {
      renderTestBackendControls();
      showError('Не удалось сохранить режим сервера на этом устройстве.');
      return false;
    }
    // The provider is selected before the next authenticated runtime starts.
    // Reloading is deliberate: it closes Firebase listeners before Ubuntu data
    // listeners are created and preserves the durable offline journal.
    updateSyncUI();
    showToastEl('Режим: ' + TEST_BACKEND_MODE_LABELS[mode], false);
    // Ask the server to move the single-writer authority, then reload so the
    // runtime restarts against the confirmed provider.
    const switching = pushAuthorityToServer(mode);
    if (typeof location !== 'undefined' && typeof location.reload === 'function') {
      Promise.resolve(switching).catch(() => {}).then(() => setTimeout(() => location.reload(), 300));
    }
    return true;
  }

  function getTestBackendIndicator(status) {
    if(isNasRuntime())return {letter:status.state==='offline'?'О':'U',label:status.state==='offline'?'Ubuntu — локальная очередь':status.state==='ok'?'Ubuntu — сервер данных':'Ubuntu — '+status.text,provider:'ubuntu'};
    if (status.state === 'offline') return {letter:'О', label:'Офлайн', provider:'firebase'};
    if (!currentUid || status.state === 'init') return {letter:'…', label:'Firebase — подключение ещё не подтверждено', provider:'firebase'};
    if (status.state === 'error') return {letter:'!', label:'Firebase — требуется проверка синхронизации', provider:'firebase'};
    return {letter:'F', label:'Firebase — сервер данных', provider:'firebase'};
  }

  let testUbuntuCheckPending = false;
  let testUbuntuCheckSession = null;
  let testUbuntuCheckEpoch = 0;

  function loadTestUbuntuChecker() {
    return import(new URL('./test-app/synology/connection-check.mjs', document.baseURI).href);
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
      select.value = getTestBackendMode();
    }
    const actual = document.getElementById('testBackendActual');
    if (actual) actual.textContent = getTestBackendIndicator(status || getSyncStatus()).label;
    const note = document.getElementById('testBackendModeNote');
    const mode = getTestBackendMode();
    const authority = typeof nasAuthority === 'undefined' ? null : nasAuthority;
    const where = authority && authority.generation
      ? ' Сервер объявил режим: ' + (authority.provider === 'ubuntu' ? 'Ubuntu' : 'резерв Firebase') + ' (поколение ' + authority.generation + ').'
      : '';
    if (note) note.textContent = (mode === 'ubuntu'
      ? 'Данные обслуживает Ubuntu.'
      : mode === 'auto'
        ? 'Автоматически: основной сервер — Ubuntu, при недоступности действия сохраняются на телефоне и уходят на сервер, когда связь вернётся.'
        : 'Выбран резерв Firebase. Запись принимает только тот сервер, который объявлен главным.') + where;
  }

