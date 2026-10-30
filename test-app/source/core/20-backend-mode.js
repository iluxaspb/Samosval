  // TEST only. Firestore remains the sole data writer until the complete NAS
  // interface is connected. A reachable health endpoint is not a data adapter.
  const TEST_BACKEND_MODE_LABELS = Object.freeze({
    firebase: 'Только Firebase', synology: 'Только Synology', auto: 'Автоматически'
  });

  function testBackendPreferenceKey() {
    return currentUid ? 'dt_backend_mode_test:' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + currentUid : null;
  }

  function getTestBackendMode() {
    if(isNasRuntime())return 'synology';
    const key = testBackendPreferenceKey();
    if (!key) return 'firebase';
    try {
      const mode = localStorage.getItem(key);
      // Never activate an unsupported provider from an old or edited preference.
      return mode === 'auto' ? 'auto' : 'firebase';
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
    if (mode === 'synology') {
      renderTestBackendControls();
      showError('Подключение интерфейса к Synology ещё не завершено. Режим не изменён.');
      return false;
    }
    try { localStorage.setItem(key, mode); }
    catch (_) {
      renderTestBackendControls();
      showError('Не удалось сохранить режим сервера на этом устройстве.');
      return false;
    }
    // Both currently available policies use the same Firebase adapter. No
    // listeners, queues, caches, or business records are moved or recreated.
    updateSyncUI();
    showToastEl('Режим: ' + TEST_BACKEND_MODE_LABELS[mode], false);
    return true;
  }

  function getTestBackendIndicator(status) {
    if(isNasRuntime())return {letter:status.state==='offline'?'О':'S',label:status.state==='offline'?'Synology — локальная очередь':status.state==='ok'?'Synology — сервер данных':'Synology — '+status.text,provider:'synology'};
    if (status.state === 'offline') return {letter:'О', label:'Офлайн', provider:'firebase'};
    if (!currentUid || status.state === 'init') return {letter:'…', label:'Firebase — подключение ещё не подтверждено', provider:'firebase'};
    if (status.state === 'error') return {letter:'!', label:'Firebase — требуется проверка синхронизации', provider:'firebase'};
    return {letter:'F', label:'Firebase — сервер данных', provider:'firebase'};
  }

  let testSynologyCheckPending = false;
  let testSynologyCheckSession = null;
  let testSynologyCheckEpoch = 0;

  function loadTestSynologyChecker() {
    return import(new URL('./test-app/synology/connection-check.mjs', document.baseURI).href);
  }

  async function checkTestSynologyConnection() {
    const allowed = !!currentUid && permissionsLoaded && canAdmin();
    if (!allowed || testSynologyCheckPending || !navigator.onLine) return;
    const result = document.getElementById('testSynologyCheckResult');
    if (!result) return;
    renderTestBackendControls();
    const uid = currentUid, epoch = testSynologyCheckEpoch;
    const guard = () => {
      if (uid !== currentUid || epoch !== testSynologyCheckEpoch || !permissionsLoaded || !canAdmin()) throw Error('Сеанс изменился');
    };
    testSynologyCheckPending = true;
    result.textContent = 'Проверка линии и табеля Synology…';
    renderTestBackendControls();
    try {
      const {checkSynology} = await loadTestSynologyChecker();
      guard();
      const counts = await checkSynology({getIdToken: force => auth.currentUser?.getIdToken(force), guard});
      guard();
      result.textContent = `Линия и табель доступны. Машин: ${counts.trucks}; обычных рейсов: ${counts.normal}; объём: ${counts.volume} м³. Это проверка NAS; данные программы пока остаются в Firebase.`;
    } catch (error) {
      if (uid === currentUid && epoch === testSynologyCheckEpoch && permissionsLoaded && canAdmin()) {
        result.textContent = error.status === 404
          ? 'По внешнему адресу новый API недоступен. Нужно проверить HTTPS-маршрут на Synology.'
          : error.name === 'AbortError' ? 'Synology не ответил вовремя. Данные программы остаются в Firebase.' : error.message;
      }
    } finally {
      testSynologyCheckPending = false;
      renderTestBackendControls();
    }
  }

  function renderTestBackendControls(status) {
    const section = document.getElementById('admin-backend-settings');
    if (!section) return;
    const allowed = !!currentUid && permissionsLoaded && canAdmin();
    section.hidden = !allowed;
    const session = allowed ? currentUid : null;
    const probeResult = document.getElementById('testSynologyCheckResult');
    if (session !== testSynologyCheckSession) {
      testSynologyCheckSession = session;
      testSynologyCheckEpoch++;
      if (probeResult) probeResult.textContent = '';
    }
    const probeButton = document.getElementById('testSynologyCheck');
    if (probeButton) probeButton.disabled = !allowed || !navigator.onLine || testSynologyCheckPending;
    const select = document.getElementById('testBackendMode');
    if (select) {
      select.disabled = !allowed || isNasRuntime();
      select.value = getTestBackendMode();
    }
    const actual = document.getElementById('testBackendActual');
    if (actual) actual.textContent = getTestBackendIndicator(status || getSyncStatus()).label;
    const note = document.getElementById('testBackendModeNote');
    if (note) note.textContent = isNasRuntime() ? 'Данные линии обслуживает Synology.' : getTestBackendMode() === 'auto'
      ? 'Сейчас автоматически используется Firebase. Synology станет доступен после подключения всех экранов; резервное переключение — после проверки синхронизации баз.'
      : 'Данные обслуживает Firebase. Режим Synology станет доступен после завершения подключения тестового интерфейса.';
  }

