  // TEST only. Firestore remains the sole data writer until the complete NAS
  // interface is connected. A reachable health endpoint is not a data adapter.
  const TEST_BACKEND_MODE_LABELS = Object.freeze({
    firebase: 'Только Firebase', synology: 'Только Synology', auto: 'Автоматически'
  });

  function testBackendPreferenceKey() {
    return currentUid ? 'dt_backend_mode_test:' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + currentUid : null;
  }

  function getTestBackendMode() {
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
    if (status.state === 'offline') return {letter:'О', label:'Офлайн', provider:'firebase'};
    if (!currentUid || status.state === 'init') return {letter:'…', label:'Firebase — подключение ещё не подтверждено', provider:'firebase'};
    if (status.state === 'error') return {letter:'!', label:'Firebase — требуется проверка синхронизации', provider:'firebase'};
    return {letter:'F', label:'Firebase — сервер данных', provider:'firebase'};
  }

  function renderTestBackendControls(status) {
    const section = document.getElementById('admin-backend-settings');
    if (!section) return;
    const allowed = !!currentUid && permissionsLoaded && canAdmin();
    section.hidden = !allowed;
    const select = document.getElementById('testBackendMode');
    if (select) {
      select.disabled = !allowed;
      select.value = getTestBackendMode();
    }
    const actual = document.getElementById('testBackendActual');
    if (actual) actual.textContent = getTestBackendIndicator(status || getSyncStatus()).label;
    const note = document.getElementById('testBackendModeNote');
    if (note) note.textContent = getTestBackendMode() === 'auto'
      ? 'Сейчас автоматически используется Firebase. Synology станет доступен после подключения всех экранов; резервное переключение — после проверки синхронизации баз.'
      : 'Данные обслуживает Firebase. Режим Synology станет доступен после завершения подключения тестового интерфейса.';
  }
