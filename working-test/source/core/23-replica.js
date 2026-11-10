// ==== Минутная репликация изменений Firebase -> Ubuntu (резерв) ====
  // Передаются только изменённые документы, пачкой не чаще раза в минуту.
  // Работает лишь пока владелец записи — Firebase: в режиме Ubuntu очередь
  // не отправляется, иначе резерв стал бы вторым независимым автором.
  // Сервер проверяет последовательность, идемпотентность и владельца записи.
  const REPLICA_INTERVAL_MS = 60000;
  const REPLICA_MAX_BATCH = 200;
  const REPLICA_COLLECTIONS = ['trucks','objects','logs','truckStatus','archive','trash','audit','notifications'];
  // Порог локального хранения очереди: полный первый снимок рабочей базы не
  // должен вытеснять историю и настройки из localStorage.
  const REPLICA_MAX_PERSISTED = 400;
  const replicaQueueKey = () => 'samosval-wt-replica-queue:' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + (currentUid || 'anon');
  const replicaCursorKey = () => 'samosval-wt-replica-cursor:' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + (currentUid || 'anon');
  let replicaQueue = [];
  let replicaTimer = null, replicaBusy = false, replicaUnsubs = [], replicaStarted = false;
  window.WorkingTestReplica = window.WorkingTestReplica || {status: 'idle', pending: 0};

  function replicaLoadQueue() {
    try { replicaQueue = JSON.parse(localStorage.getItem(replicaQueueKey()) || '[]') || []; } catch (_) { replicaQueue = []; }
  }
  function replicaPersist() {
    try {
      // В памяти держим всю очередь, на диск — только хвост: иначе полный
      // первый снимок базы переполняет localStorage и ломает историю.
      localStorage.setItem(replicaQueueKey(), JSON.stringify(replicaQueue.slice(-REPLICA_MAX_PERSISTED)));
    } catch (_) {}
    window.WorkingTestReplica.pending = replicaQueue.length;
  }
  function replicaCursor() {
    try { return Number(localStorage.getItem(replicaCursorKey()) || 0) || 0; } catch (_) { return 0; }
  }
  function replicaSetCursor(value) {
    try { localStorage.setItem(replicaCursorKey(), String(value)); } catch (_) {}
  }
  function replicaIsReserveMode() {
    return typeof isNasRuntime === 'function' && isNasRuntime();
  }
  function replicaEnqueue(kind, payload) {
    if (!currentUid || replicaIsReserveMode()) return;
    // Один очень большой документ (обычно запись журнала) не должен навсегда
    // блокировать передачу остальных: сервер отклонил бы всю пачку.
    let size = 0;
    try { size = JSON.stringify(payload).length; } catch (_) { size = 0; }
    if (size > 200000) { window.WorkingTestReplica.skipped = (window.WorkingTestReplica.skipped || 0) + 1; return; }
    replicaQueue.push({ id: 'rep_' + crypto.randomUUID().replaceAll('-', ''), kind, payload, at: Date.now() });
    replicaPersist();
    renderReplicaStatus();
  }

  // Изменённые документы берём из уже существующих подписок Firestore:
  // первый снапшот — однократная исходная загрузка резерва, далее только дельты.
  function replicaWatch() {
    if (replicaStarted || !currentUid) return;
    replicaStarted = true;
    // Смена — коллекция, остальные — refs; пользователи и права тоже обязаны
    // доехать до резерва, иначе вход в режиме Ubuntu невозможен.
    const collections = {
      ...refs,
      shift: wsRef.collection('shift'),
      users: db.collection('users'),
      registration_requests: db.collection('registration_requests'),
      settings: db.collection('settings')
    };
    for (const [name, ref] of Object.entries(collections)) {
      if (!ref || typeof ref.onSnapshot !== 'function') continue;
      const unsub = ref.onSnapshot({ includeMetadataChanges: false }, snap => {
        if (!snap || typeof snap.docChanges !== 'function') return;
        for (const change of snap.docChanges()) {
          if (change.type === 'removed') {
            replicaEnqueue('doc.delete', { collection: name, path: change.doc.ref.path });
          } else {
            replicaEnqueue('doc.set', { collection: name, path: change.doc.ref.path, data: change.doc.data() });
          }
        }
      }, () => {});
      replicaUnsubs.push(unsub);
    }
  }

  async function replicaFlush() {
    if (replicaBusy || !currentUid || !navigator.onLine || !replicaQueue.length) return;
    if (replicaIsReserveMode()) return;
    replicaBusy = true;
    window.WorkingTestReplica.status = 'syncing';
    renderReplicaStatus();
    // Пачку ограничиваем и по числу, и по объёму: резерв отвечает быстро и
    // не упирается в предел размера запроса.
    const batch = [];
    let bytes = 0;
    for (const operation of replicaQueue) {
      if (batch.length >= REPLICA_MAX_BATCH) break;
      const size = JSON.stringify(operation).length;
      if (bytes + size > 2000000) break;
      bytes += size;
      batch.push(operation);
    }
    if (!batch.length) return;
    try {
      const token = await auth.currentUser.getIdToken();
      const response = await fetch(WORKING_TEST_UBUNTU_API_BASE + '/api/v1/replica/apply', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: 'f2s', baseSeq: replicaCursor(), operations: batch })
      });
      if (response.status === 409) {
        // Пропуск/конфликт последовательности: не глотаем, а останавливаем
        // репликацию и требуем сверки — иначе резерв разойдётся с основной.
        window.WorkingTestReplica.status = 'gap';
        return;
      }
      if (!response.ok) throw Error('HTTP ' + response.status);
      const result = await response.json();
      replicaSetCursor(Number.isSafeInteger(result.seq) ? result.seq : replicaCursor());
      const done = new Set(batch.map(op => op.id));
      replicaQueue = replicaQueue.filter(op => !done.has(op.id));
      replicaPersist();
      window.WorkingTestReplica.status = replicaQueue.length ? 'pending' : 'ok';
    } catch (error) {
      window.WorkingTestReplica.status = 'error';
      console.warn('[replica]', error.message);
    } finally {
      replicaBusy = false;
      renderReplicaStatus();
    }
  }

  function renderReplicaStatus() {
    let badge = document.getElementById('replicaStatus');
    if (!badge) {
      const host = document.querySelector('#mainHeader .header-inner') || document.querySelector('#mainHeader');
      if (!host) return;
      badge = document.createElement('span');
      badge.id = 'replicaStatus';
      badge.className = 'replica-status';
      badge.style.cssText = 'margin-left:8px;font-size:11px;opacity:.75;white-space:nowrap;';
      host.append(badge);
    }
    const status = window.WorkingTestReplica.status;
    const pending = replicaQueue.length;
    badge.textContent = status === 'idle' && !pending ? 'Резерв: ожидание'
      : status === 'syncing' ? '⟳ Синхронизация'
      : status === 'gap' ? '! Требуется сверка'
      : status === 'error' ? '! Резерв недоступен'
      : pending ? '→ ' + pending + ' к передаче'
      : 'Резерв синхронизирован';
    badge.dataset.state = status;
  }

  // Очереди другого проекта занимают место на устройстве и не должны
  // смешиваться с текущей: ключ содержит имя проекта, поэтому чужие удаляем.
  function pruneForeignReplicaKeys() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (!key.startsWith('samosval-wt-replica-queue:') && !key.startsWith('samosval-wt-replica-cursor:')) continue;
        const parts = key.split(':');
        if (parts.length > 1 && parts[1] !== firebaseConfig.projectId) localStorage.removeItem(key);
      }
    } catch (_) {}
  }

  function startReplica() {
    pruneForeignReplicaKeys();
    replicaLoadQueue();
    if (!currentUid || replicaStarted) { renderReplicaStatus(); return; }
    replicaWatch();
    if (!replicaTimer) replicaTimer = setInterval(() => { void replicaFlush(); }, REPLICA_INTERVAL_MS);
    renderReplicaStatus();
    void replicaFlush();
  }
  function stopReplica() {
    replicaUnsubs.forEach(unsub => { try { unsub(); } catch (_) {} });
    replicaUnsubs = [];
    replicaStarted = false;
    if (replicaTimer) { clearInterval(replicaTimer); replicaTimer = null; }
  }
  window.addEventListener('online', () => { void replicaFlush(); });