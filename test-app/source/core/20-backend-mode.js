  // TEST only. Firestore remains the sole data writer until the complete NAS
  // interface is connected. A reachable health endpoint is not a data adapter.
  const TEST_BACKEND_MODE_LABELS = Object.freeze({
    firebase: 'Только Firebase', ubuntu: 'Только Ubuntu', auto: 'Автоматически'
  });

  function testBackendPreferenceKey() {
    return currentUid ? 'dt_backend_mode_test:' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + currentUid : null;
  }

  function getTestBackendMode() {
    if(isNasRuntime())return 'ubuntu';
    const key = testBackendPreferenceKey();
    if (!key) return 'firebase';
    try {
      const mode = localStorage.getItem(key);
      // Never activate an unsupported provider from an old or edited preference.
      return mode === 'auto' || mode === 'ubuntu' ? mode : 'firebase';
    } catch (_) { return 'firebase'; }
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
    if (typeof location !== 'undefined' && typeof location.reload === 'function') location.reload();
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
      select.disabled = !allowed || isNasRuntime();
      select.value = getTestBackendMode();
    }
    const actual = document.getElementById('testBackendActual');
    if (actual) actual.textContent = getTestBackendIndicator(status || getSyncStatus()).label;
    const note = document.getElementById('testBackendModeNote');
    if (note) note.textContent = isNasRuntime() ? 'Данные линии обслуживает Ubuntu.' : getTestBackendMode() === 'auto'
      ? 'Сейчас автоматически используется Firebase. Ubuntu доступен для ручного выбора.'
      : 'Данные обслуживает Firebase. Ubuntu доступен для ручного выбора.';
  }

