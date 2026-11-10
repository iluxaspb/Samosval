// ==== Минутная репликация изменений Firebase -> Ubuntu (резерв) ====
  // Передаются только изменённые документы, пачкой не чаще раза в минуту.
  // Работает лишь пока владелец записи — Firebase: в режиме Ubuntu очередь
  // не отправляется, иначе резерв стал бы вторым независимым автором.
  // Сервер проверяет последовательность, идемпотентность и владельца записи.
  //
  // ВАЖНО (исправление 1.2.1): раньше каждая запись коллекции (а первый снимок
  // рабочей базы — это тысячи документов) добавлялась в массив и ЦЕЛИКОМ
  // сериализовалась в localStorage. Получалось O(n²) работы в главном потоке и
  // переполнение хранилища: приложение зависало, история не сохранялась.
  // Теперь очередь — карта по пути документа (одна операция на документ),
  // запись на диск отложенная и по размеру ограничена, а уже переданные
  // документы повторно не отправляются (водяной знак по времени изменения).
  const REPLICA_INTERVAL_MS = 60000;
  const REPLICA_MAX_BATCH = 200;
  const REPLICA_MAX_QUEUE = 2000;          // операций в памяти
  const REPLICA_MAX_OP_BYTES = 100000;     // один документ
  const REPLICA_PERSIST_BYTES = 150000;    // сколько места отдаём под очередь на диске
  const REPLICA_PERSIST_DELAY_MS = 2000;
  const replicaQueueKey = () => 'samosval-wt-replica-queue:' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + (currentUid || 'anon');
  const replicaCursorKey = () => 'samosval-wt-replica-cursor:' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + (currentUid || 'anon');
  const replicaWatermarkKey = () => 'samosval-wt-replica-wm:' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + (currentUid || 'anon');
  let replicaQueue = new Map();            // key = kind|path -> операция
  let replicaTimer = null, replicaBusy = false, replicaUnsubs = [], replicaStarted = false;
  let replicaPersistTimer = null, replicaRenderTimer = null;
  let replicaWatermark = {};               // коллекция -> время последней переданной версии
  window.WorkingTestReplica = window.WorkingTestReplica || {status: 'idle', pending: 0};

  function replicaOpKey(kind, payload) {
    return (kind === 'doc.delete' ? 'del' : 'set') + '|' + (payload && payload.path || '');
  }
  function replicaOpBytes(operation) {
    try { return JSON.stringify(operation).length; } catch (_) { return REPLICA_MAX_OP_BYTES; }
  }
  function replicaLoadQueue() {
    replicaQueue = new Map();
    try {
      const raw = localStorage.getItem(replicaQueueKey()) || '[]';
      // Наследство прошлых сборок: очередь могла занимать мегабайты и уже
      // переполнила хранилище устройства. Такую не читаем — начинаем заново.
      if (raw.length > REPLICA_PERSIST_BYTES * 2) {
        localStorage.removeItem(replicaQueueKey());
      } else {
        const stored = JSON.parse(raw);
        if (Array.isArray(stored)) {
          for (const operation of stored.slice(-REPLICA_MAX_QUEUE)) {
            if (!operation || !operation.kind || !operation.payload) continue;
            replicaQueue.set(replicaOpKey(operation.kind, operation.payload), operation);
          }
        }
      }
    } catch (_) { replicaQueue = new Map(); }
    try {
      const wm = JSON.parse(localStorage.getItem(replicaWatermarkKey()) || '{}');
      replicaWatermark = wm && typeof wm === 'object' ? wm : {};
    } catch (_) { replicaWatermark = {}; }
    window.WorkingTestReplica.pending = replicaQueue.size;
  }
  // Запись на диск отложенная: во время первичной загрузки базы изменения
  // приходят сотнями, и синхронный setItem на каждое — это и был фриз.
  function replicaSchedulePersist() {
    if (replicaPersistTimer) return;
    replicaPersistTimer = setTimeout(() => { replicaPersistTimer = null; replicaPersistNow(); }, REPLICA_PERSIST_DELAY_MS);
  }
  function replicaPersistNow() {
    if (replicaPersistTimer) { clearTimeout(replicaPersistTimer); replicaPersistTimer = null; }
    window.WorkingTestReplica.pending = replicaQueue.size;
    // На диск кладём только хвост, который влезает в отведённый бюджет.
    const tail = [];
    let bytes = 0;
    const operations = Array.from(replicaQueue.values());
    for (let i = operations.length - 1; i >= 0; i -= 1) {
      const size = operations[i].size || replicaOpBytes(operations[i]);
      if (bytes + size > REPLICA_PERSIST_BYTES) break;
      bytes += size;
      tail.push(operations[i]);
    }
    tail.reverse();
    try {
      localStorage.setItem(replicaQueueKey(), JSON.stringify(tail));
    } catch (_) {
      // Место кончилось: очередь целиком живёт в памяти, диск не трогаем,
      // чтобы не вытеснять историю и настройки пользователя.
      try { localStorage.removeItem(replicaQueueKey()); } catch (_) {}
    }
    try { localStorage.setItem(replicaWatermarkKey(), JSON.stringify(replicaWatermark)); } catch (_) {}
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
    const key = replicaOpKey(kind, payload);
    // Серия изменений одного документа схлопывается в одну операцию: резерву
    // нужно последнее состояние, а не история правок.
    replicaQueue.delete(key);
    const operation = { id: 'rep_' + crypto.randomUUID().replaceAll('-', ''), kind, payload, at: Date.now() };
    const size = replicaOpBytes(operation);
    // Один очень большой документ (обычно запись журнала) не должен навсегда
    // блокировать передачу остальных: сервер отклонил бы всю пачку.
    if (size > REPLICA_MAX_OP_BYTES) {
      window.WorkingTestReplica.skipped = (window.WorkingTestReplica.skipped || 0) + 1;
      replicaScheduleRender();
      return;
    }
    operation.size = size;
    replicaQueue.set(key, operation);
    while (replicaQueue.size > REPLICA_MAX_QUEUE) {
      const oldest = replicaQueue.keys().next().value;
      if (oldest === undefined) break;
      replicaQueue.delete(oldest);
      window.WorkingTestReplica.skipped = (window.WorkingTestReplica.skipped || 0) + 1;
    }
    replicaSchedulePersist();
    replicaScheduleRender();
  }

  // Изменённые документы берём из уже существующих подписок Firestore:
  // первый снапшот — однократная исходная загрузка резерва, далее только дельты.
  // Повторно уже переданные документы не отправляем: сравниваем время
  // изменения документа с водяным знаком коллекции.
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
      let firstSnap = true;
      const unsub = ref.onSnapshot({ includeMetadataChanges: false }, snap => {
        if (!snap || typeof snap.docChanges !== 'function') return;
        const since = Number(replicaWatermark[name] || 0);
        const initial = firstSnap;
        firstSnap = false;
        for (const change of snap.docChanges()) {
          const doc = change.doc;
          const updated = doc.updateTime && typeof doc.updateTime.toMillis === 'function' ? doc.updateTime.toMillis() : 0;
          // При первом снимке передаём только то, что новее уже отправленного.
          if (initial && updated && since && updated <= since) continue;
          if (change.type === 'removed') {
            replicaEnqueue('doc.delete', { collection: name, path: doc.ref.path });
          } else {
            replicaEnqueue('doc.set', { collection: name, path: doc.ref.path, data: doc.data() });
          }
        }
      }, () => {});
      replicaUnsubs.push(unsub);
    }
  }

  async function replicaFlush() {
    if (replicaBusy || !currentUid || !navigator.onLine || !replicaQueue.size) return;
    if (replicaIsReserveMode()) return;
    replicaBusy = true;
    window.WorkingTestReplica.status = 'syncing';
    renderReplicaStatus();
    // Пачку ограничиваем и по числу, и по объёму: резерв отвечает быстро и
    // не упирается в предел размера запроса.
    const batch = [];
    let bytes = 0;
    for (const operation of replicaQueue.values()) {
      if (batch.length >= REPLICA_MAX_BATCH) break;
      const size = operation.size || replicaOpBytes(operation);
      if (bytes + size > 2000000) break;
      bytes += size;
      batch.push(operation);
    }
    if (!batch.length) { replicaBusy = false; return; }
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
      for (const operation of batch) {
        const key = replicaOpKey(operation.kind, operation.payload);
        const current = replicaQueue.get(key);
        if (current && current.id === operation.id) replicaQueue.delete(key);
      }
      // Водяной знак: документы новее переданной версии больше не отправляем.
      const serverTime = Number.isFinite(result.appliedAt) ? result.appliedAt : Date.now();
      for (const operation of batch) {
        const name = operation.payload && operation.payload.collection;
        if (!name) continue;
        replicaWatermark[name] = Math.max(Number(replicaWatermark[name] || 0), serverTime);
      }
      replicaPersistNow();
      window.WorkingTestReplica.status = replicaQueue.size ? 'pending' : 'ok';
    } catch (error) {
      window.WorkingTestReplica.status = 'error';
      console.warn('[replica]', error.message);
    } finally {
      replicaBusy = false;
      renderReplicaStatus();
    }
  }

  function replicaScheduleRender() {
    if (replicaRenderTimer) return;
    replicaRenderTimer = setTimeout(() => { replicaRenderTimer = null; renderReplicaStatus(); }, 250);
  }

  function renderReplicaStatus() {
    window.WorkingTestReplica.pending = replicaQueue.size;
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
    const pending = replicaQueue.size;
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
        if (!key.startsWith('samosval-wt-replica-queue:') && !key.startsWith('samosval-wt-replica-cursor:') && !key.startsWith('samosval-wt-replica-wm:')) continue;
        const parts = key.split(':');
        if (parts.length > 1 && parts[1] !== firebaseConfig.projectId) localStorage.removeItem(key);
      }
    } catch (_) {}
  }

  function startReplica() {
    pruneForeignReplicaKeys();
    replicaLoadQueue();
    renderReplicaStatus();
    if (!currentUid || replicaStarted) return;
    replicaWatch();
    if (!replicaTimer) replicaTimer = setInterval(() => { void replicaFlush(); }, REPLICA_INTERVAL_MS);
    void replicaFlush();
  }
  function stopReplica() {
    replicaUnsubs.forEach(unsub => { try { unsub(); } catch (_) {} });
    replicaUnsubs = [];
    replicaStarted = false;
    if (replicaTimer) { clearInterval(replicaTimer); replicaTimer = null; }
    replicaPersistNow();
  }
  window.addEventListener('online', () => { void replicaFlush(); });
  // Уходя со страницы, сохраняем очередь один раз, а не на каждое изменение.
  window.addEventListener('pagehide', () => { replicaPersistNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') replicaPersistNow(); });