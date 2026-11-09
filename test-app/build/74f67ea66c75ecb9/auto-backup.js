try { (function(){
  if (window.__autoBackupV1) return;
  window.__autoBackupV1 = true;

  const BACKUPS_COLL = db.collection('backups');
  const CHUNK_SIZE = 700000; // UTF-8 bytes, not JavaScript characters
  const FORMAT = 'samosval-backup';
  const VERSION = 2;
  const MAX_RESTORE_WRITES = 400;
  const EXCLUSIONS = ['photo-jpeg-binaries', 'photo-metadata-and-counters', 'local-offline-queues', 'firebase-auth-credentials'];
  const MAX_BACKUPS = 15;

  let backupInProgress = false;
  let restoreInProgress = false;

  // ===== Утилиты =====
  function tsLabel(ts) {
    return ts ? new Date(ts).toLocaleString('ru-RU') : '—';
  }
  function sizeLabel(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
    return (bytes / (1024 * 1024)).toFixed(2) + ' МБ';
  }
  function byteLength(str) {
    return new TextEncoder().encode(str).length;
  }

  // ===== Список коллекций для бэкапа =====
  function collectionsForBackup() {
    return [
      { path: ['workspaces','main_workspace','trucks'], name: 'trucks', cat: 'base' },
      { path: ['workspaces','main_workspace','objects'], name: 'objects', cat: 'base' },
      { path: ['workspaces','main_workspace','archive'], name: 'archive', cat: 'archive' },
      { path: ['workspaces','main_workspace','trash'], name: 'trash', cat: 'archive' },
      { path: ['workspaces','main_workspace','logs'], name: 'logs', cat: 'shift' },
      { path: ['workspaces','main_workspace','truckStatus'], name: 'truckStatus', cat: 'shift' },
      { path: ['workspaces','main_workspace','notifications'], name: 'notifications', cat: 'shift' },
      { path: ['workspaces','main_workspace','audit'], name: 'audit', cat: 'audit', protected: true },
      ...['timesheetPeople','timesheetEquipment','timesheetEntries','timesheetMaterials','timesheetChanges'].map(name => ({ path: ['workspaces','main_workspace',name], name, cat: 'timesheet', protected: true })),
      { path: ['workspaces','main_workspace','plugins'], name: 'plugins', cat: 'settings' },
      { path: ['workspaces','main_workspace','patches'], name: 'patches', cat: 'settings' },
      { path: ['users'], name: 'users', cat: 'users' },
      { path: ['settings','permissions'], name: 'permissions', cat: 'settings', isDoc: true },
      { path: ['settings','appConfig'], name: 'appConfig', cat: 'settings', isDoc: true },
      { path: ['settings','appConfig_test'], name: 'appConfig_test', cat: 'settings', isDoc: true },
      { path: ['workspaces','main_workspace','shift','current'], name: 'shift', cat: 'shift', isDoc: true }
    ];
  }

  function assertAdmin() {
    if (typeof currentUserRole === 'undefined' || currentUserRole !== 'admin' ||
        (typeof currentUserStatus !== 'undefined' && currentUserStatus !== 'active')) {
      throw new Error('Полная резервная копия и восстановление доступны активному администратору');
    }
  }
  function actor() {
    return (typeof currentUid === 'undefined' ? '' : currentUid) + ':' +
      (typeof currentEmail === 'undefined' ? '' : currentEmail);
  }
  function assertActor(owner) {
    assertAdmin();
    if (owner !== actor()) throw new Error('Учётная запись изменилась. Операция отменена');
  }
  function refFromPath(path) {
    let ref = db;
    for (let i = 0; i < path.length; i++) ref = i % 2 ? ref.doc(path[i]) : ref.collection(path[i]);
    return ref;
  }
  function serverSnapshot(snap) {
    if (snap.metadata && (snap.metadata.fromCache || snap.metadata.hasPendingWrites)) {
      throw new Error('Нужны подтверждённые сервером данные, не локальный кэш');
    }
    return snap;
  }
  async function readCollection(path) {
    const snap = serverSnapshot(await refFromPath(path).get({ source: 'server' }));
    return path.length % 2 ? snap.docs.map(d => ({ id: d.id, data: d.data() })) :
      (snap.exists ? [{ id: snap.id, data: snap.data() }] : []);
  }
  function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function validId(id) {
    return typeof id === 'string' && id.length > 0 && byteLength(id) <= 1500 &&
      id !== '.' && id !== '..' && !id.includes('/') && !/^__.*__$/.test(id);
  }
  // Firestore timestamps occur in timesheet receipts. Never silently flatten types.
  function encodeValue(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(encodeValue);
    if (value && typeof value.toDate === 'function' && Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds)) {
      return { __backupType: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
    }
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return { __backupType: 'date', value: value.toISOString() };
    }
    if (!record(value) || Object.prototype.toString.call(value) !== '[object Object]' ||
        (Object.getPrototypeOf(value) && Object.getPrototypeOf(value).constructor.name !== 'Object')) {
      throw new Error('Неподдерживаемый тип поля: копия не создана');
    }
    const result = {};
    for (const key of Object.keys(value)) {
      if (['__backupType','__proto__','constructor','prototype'].includes(key)) throw new Error('Зарезервированное имя поля: ' + key);
      result[key] = encodeValue(value[key]);
    }
    return result;
  }
  function decodeValue(value, hydrate) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(v => decodeValue(v, hydrate));
    if (!record(value)) throw new Error('Недопустимое значение поля');
    if (Object.prototype.hasOwnProperty.call(value, '__backupType')) {
      if (value.__backupType === 'timestamp' && Object.keys(value).length === 3 && Number.isInteger(value.seconds) &&
          value.seconds >= -62135596800 && value.seconds <= 253402300799 &&
          Number.isInteger(value.nanoseconds) && value.nanoseconds >= 0 && value.nanoseconds < 1000000000) {
        return hydrate ? new firebase.firestore.Timestamp(value.seconds, value.nanoseconds) : value;
      }
      if (value.__backupType === 'date' && Object.keys(value).length === 2 && typeof value.value === 'string' &&
          new Date(value.value).toISOString() === value.value) return hydrate ? new Date(value.value) : value;
      throw new Error('Некорректный тип поля резервной копии');
    }
    const out = {};
    for (const key of Object.keys(value)) {
      if (['__proto__','constructor','prototype'].includes(key)) throw new Error('Недопустимое имя поля');
      out[key] = decodeValue(value[key], hydrate);
    }
    return out;
  }
  function fieldCount(value) {
    if (!value || typeof value !== 'object' || value.__backupType) return 0;
    return Object.keys(value).reduce((n, k) => n + (Array.isArray(value) ? 0 : 1) + fieldCount(value[k]), 0);
  }
  function validateRows(rows, col) {
    if (!Array.isArray(rows) || (col.isDoc && rows.length > 1)) throw new Error('Некорректный раздел: ' + col.name);
    const ids = new Set();
    for (const row of rows) {
      if (!record(row) || !validId(row.id) || ids.has(row.id) || !record(row.data) || row.data.__backupType ||
          (col.isDoc && row.id !== col.path[col.path.length - 1])) throw new Error('Некорректная запись: ' + col.name);
      ids.add(row.id);
      decodeValue(row.data, false);
    }
  }
  function validatePayload(payload, allowLegacy) {
    if (!record(payload) || !record(payload.data)) throw new Error('Файл не похож на резервную копию');
    if (payload.version === 1 && allowLegacy) {
      for (const col of collectionsForBackup()) if (Object.prototype.hasOwnProperty.call(payload.data, col.name)) validateRows(payload.data[col.name], col);
      return payload;
    }
    if (payload.format !== FORMAT || payload.version !== VERSION || payload.complete !== true ||
        !record(payload.manifest) || !Array.isArray(payload.exclusions) ||
        EXCLUSIONS.some(name => !payload.exclusions.includes(name))) throw new Error('Неполная или неподдерживаемая резервная копия');
    const cols = collectionsForBackup();
    if (Object.keys(payload.data).length !== cols.length || Object.keys(payload.manifest).length !== cols.length) throw new Error('Неверный набор разделов');
    for (const col of cols) {
      const rows = payload.data[col.name], entry = payload.manifest[col.name];
      validateRows(rows, col);
      if (!record(entry) || entry.path !== col.path.join('/') || entry.count !== rows.length ||
          entry.fields !== rows.reduce((n, r) => n + fieldCount(r.data), 0) ||
          entry.status !== (col.isDoc && !rows.length ? 'missing' : 'complete')) throw new Error('Нарушена полнота раздела: ' + col.name);
    }
    return payload;
  }
  async function collectPayload(type, description) {
    assertAdmin();
    const owner = actor();
    const payload = { format: FORMAT, version: VERSION, complete: true, createdAt: Date.now(), type,
      description: description || '', consistency: 'sequential-server-reads', exclusions: EXCLUSIONS.slice(), data: {}, manifest: {} };
    for (const col of collectionsForBackup()) {
      // A denied/failed read is never equivalent to an empty collection or missing document.
      const docs = await readCollection(col.path);
      assertActor(owner);
      payload.data[col.name] = docs.map(r => ({ id: r.id, data: encodeValue(r.data) }));
      payload.manifest[col.name] = { path: col.path.join('/'), count: docs.length,
        fields: payload.data[col.name].reduce((n, r) => n + fieldCount(r.data), 0),
        status: col.isDoc && !docs.length ? 'missing' : 'complete' };
    }
    return validatePayload(payload);
  }
  function splitChunks(text) {
    const chunks = []; let chunk = '', bytes = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0), size = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
      if (bytes + size > CHUNK_SIZE) { chunks.push(chunk); chunk = ''; bytes = 0; }
      chunk += ch; bytes += size;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  }
  async function digest(text) {
    if (!window.crypto || !window.crypto.subtle) throw new Error('Для проверки копии нужен защищённый браузер (HTTPS)');
    const bytes = new TextEncoder().encode(text);
    return Array.from(new Uint8Array(await window.crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function createBackup(type, description) {
    if (backupInProgress || (restoreInProgress && type !== 'before_restore')) {
      if (typeof showError === 'function') showError('Другая операция резервного копирования уже выполняется');
      return null;
    }
    backupInProgress = true;
    let metaRef, published = false;
    try {
      assertAdmin();
      const owner = actor(), payload = await collectPayload(type, description);
      const json = JSON.stringify(payload), chunks = splitChunks(json), counts = {};
      for (const [name, entry] of Object.entries(payload.manifest)) counts[name] = entry.count;
      metaRef = BACKUPS_COLL.doc();
      const meta = { id: metaRef.id, format: FORMAT, version: VERSION, complete: true, createdAt: payload.createdAt,
        createdBy: typeof getUserName === 'function' ? getUserName() : '—',
        createdByEmail: typeof currentEmail === 'undefined' ? '' : currentEmail,
        type, description: description || '', sizeBytes: byteLength(json), chunkCount: chunks.length, counts,
        sha256: await digest(json), important: type === 'before_restore' || type === 'before_import' };
      for (let i = 0; i < chunks.length; i++) {
        assertActor(owner);
        await metaRef.collection('chunks').doc(String(i)).set({ idx: i, data: chunks[i] });
      }
      assertActor(owner);
      await metaRef.set(meta);
      await readBackupData(meta.id); // Read back, verify chunk indexes, bytes, digest, manifest and counts.
      assertActor(owner);
      published = true;
      if (type === 'auto') try { localStorage.setItem('dt_backup_last_auto', String(Date.now())); } catch(e) {}
      if (typeof showToastEl === 'function') showToastEl('✅ Бэкап проверен (' + sizeLabel(meta.sizeBytes) + '). Фотографии не включены.', false);
      await rotateBackups();
      try { renderBackupUI(); } catch(e) { console.warn('[backup] UI:', e); }
      return meta;
    } catch(e) {
      if (metaRef && !published) {
        // Failed publication must not leave a selectable incomplete recovery point.
        try {
          await metaRef.delete();
          const chunks = await metaRef.collection('chunks').get({ source: 'server' });
          for (const chunk of chunks.docs) await chunk.ref.delete();
        } catch(cleanup) { console.warn('[backup] Incomplete copy cleanup failed:', metaRef.id, cleanup); }
      }
      console.error('[backup] Create error:', e);
      if (typeof showError === 'function') showError('Бэкап НЕ создан / не проверен: ' + e.message);
      return null;
    } finally { backupInProgress = false; }
  }

  // ===== Ротация =====
  async function rotateBackups() {
    try {
      const snap = await BACKUPS_COLL.orderBy('createdAt', 'desc').get({ source: 'server' });
      const docs = snap.docs;
      if (docs.length <= MAX_BACKUPS) return;

      // Удалить те, что сверх лимита, кроме important
      const toDelete = [];
      for (let i = MAX_BACKUPS; i < docs.length; i++) {
        const d = docs[i].data();
        if (d.important) continue;
        toDelete.push(docs[i]);
      }

      for (const doc of toDelete) {
        // Удалить чанки
        const chunksSnap = await doc.ref.collection('chunks').get({ source: 'server' });
        for (const ch of chunksSnap.docs) {
          await ch.ref.delete();
        }
        await doc.ref.delete();
      }

      if (toDelete.length > 0) {
        console.log('[backup] Rotated:', toDelete.length, 'old backups removed');
      }
    } catch(e) {
      console.warn('[backup] Rotate error:', e);
    }
  }

  // ===== Список бэкапов =====
  async function listBackups() {
    try {
      const snap = await BACKUPS_COLL.orderBy('createdAt', 'desc').limit(50).get({ source: 'server' });
      return snap.docs.map(d => d.data());
    } catch(e) {
      console.warn('[backup] List error:', e);
      throw e;
    }
  }

  // ===== Чтение бэкапа =====
  async function readBackupData(id, allowLegacy) {
    if (!validId(id)) throw new Error('Неверный ID копии');
    const metaDoc = serverSnapshot(await BACKUPS_COLL.doc(id).get({ source: 'server' }));
    if (!metaDoc.exists) throw new Error('Бэкап не найден');
    const meta = metaDoc.data();
    if (!Number.isSafeInteger(meta.chunkCount) || meta.chunkCount < 1 || !Number.isSafeInteger(meta.sizeBytes) || meta.sizeBytes <= 0) throw new Error('Некорректные метаданные копии');
    const snap = serverSnapshot(await BACKUPS_COLL.doc(id).collection('chunks').get({ source: 'server' }));
    if (snap.docs.length !== meta.chunkCount) throw new Error('Не все чанки найдены');
    const rows = snap.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => a.idx - b.idx);
    rows.forEach((row, i) => {
      if (row.id !== String(i) || row.idx !== i || typeof row.data !== 'string') throw new Error('Неверный порядок / дубликат чанка');
    });
    const json = rows.map(r => r.data).join('');
    if (byteLength(json) !== meta.sizeBytes) throw new Error('Размер копии не совпадает');
    const payload = JSON.parse(json);
    if (payload.version !== 1 || !allowLegacy) {
      if (meta.version !== VERSION || meta.complete !== true || meta.sha256 !== await digest(json)) throw new Error('Контрольная сумма / версия копии не совпадает');
    }
    validatePayload(payload, allowLegacy);
    if (payload.version === VERSION) {
      if (!record(meta.counts) || Object.keys(meta.counts).length !== Object.keys(payload.manifest).length ||
          Object.entries(payload.manifest).some(([name, entry]) => meta.counts[name] !== entry.count)) throw new Error('Число записей копии не совпадает');
    }
    return payload;
  }

  // ===== Удаление бэкапа =====
  async function deleteBackup(id) {
    if (!(await appConfirm('Удалить этот бэкап? Восстановить из него будет невозможно.'))) return;
    try {
      const chunksSnap = await BACKUPS_COLL.doc(id).collection('chunks').get({ source: 'server' });
      for (const ch of chunksSnap.docs) await ch.ref.delete();
      await BACKUPS_COLL.doc(id).delete();
      if (typeof showToastEl === 'function') showToastEl('🗑 Бэкап удалён', false);
      renderBackupUI();
    } catch(e) {
      if (typeof showError === 'function') showError(e.message);
    }
  }

  // ===== Скачать бэкап как файл =====
  async function downloadBackupFile(id) {
    try {
      assertAdmin(); const owner = actor();
      if (typeof showToastEl === 'function') showToastEl('⏳ Загрузка...', false);
      const data = await readBackupData(id, true);
      if (data.version === 1 && !(await appConfirm('Старая копия не подтверждает полноту: настройки могли быть пропущены, аудит ограничен, табель и фото отсутствуют. Скачать только для проверки?'))) return;
      const file = await fileEnvelope(data);
      assertActor(owner);
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'backup_' + id + '.json';
      a.click();
      URL.revokeObjectURL(url);
      if (typeof showToastEl === 'function') showToastEl('📥 Скачано', false);
    } catch(e) {
      if (typeof showError === 'function') showError(e.message);
    }
  }

  // ===== Восстановление =====
  function assertRestoreReady() {
    assertAdmin();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Восстановление/импорт требуют связи с сервером');
    if (typeof offlinePendingCount !== 'function') throw new Error('Не удалось проверить локальную очередь. Восстановление/импорт заблокированы');
    const pending = offlinePendingCount();
    if (!Number.isSafeInteger(pending) || pending !== 0 ||
        (typeof offlineJournalReadError !== 'undefined' && offlineJournalReadError) ||
        (typeof offlineUndeliveredEffects === 'function' && offlineUndeliveredEffects().length)) {
      throw new Error('Сначала синхронизируйте локальные действия/эффекты и устраните ошибки очереди. Восстановление/импорт заблокированы');
    }
    if (typeof offlineJournalCanWrite === 'function' && !offlineJournalCanWrite()) throw new Error('Очередь открыта в другой вкладке. Восстановление/импорт заблокированы');
  }
  function requireSettledShift(snap) {
    // closing/restoring deliberately set isActive:false, but their archive and
    // partly-cleaned live rows remain recovery sources until the lifecycle ends.
    const local = typeof state === 'undefined' ? null : state.shift;
    const remote = snap.exists ? snap.data() : null;
    if ([local, remote].some(shift => shift && (shift.closing || shift.restoring))) {
      throw new Error('Восстановление/импорт заблокированы: закрытие или восстановление смены ещё не завершено. Сначала завершите и синхронизируйте эту операцию');
    }
  }
  function requireClosedShift(snap) {
    requireSettledShift(snap);
    if ((typeof state !== 'undefined' && state.shift && state.shift.isActive) || (snap.exists && snap.data().isActive)) {
      throw new Error('Замена разделов заблокирована во время активной смены. Завершите и синхронизируйте её; остановите работу других устройств');
    }
  }
  async function makePlan(payload, sections, merge) {
    validatePayload(payload);
    const selected = collectionsForBackup().filter(col => sections[col.cat] === true);
    if (!selected.length) throw new Error('Не выбран раздел');
    if (selected.some(col => col.protected)) throw new Error('Табель и аудит/игровая экономика защищены от клиентской перезаписи. Нужна отдельная контролируемая миграция');
    const plan = [];
    for (const col of selected) {
      const existing = await readCollection(col.path), rows = payload.data[col.name];
      const old = new Map(existing.map(r => [r.id, r.data])), wanted = new Set(rows.map(r => r.id));
      for (const row of rows) plan.push({ ref: col.isDoc ? refFromPath(col.path) : refFromPath(col.path).doc(row.id),
        data: decodeValue(row.data, true), before: old.has(row.id) ? encodeValue(old.get(row.id)) : null, merge: !!merge });
      if (!merge) for (const row of existing) if (!wanted.has(row.id)) plan.push({
        ref: col.isDoc ? refFromPath(col.path) : refFromPath(col.path).doc(row.id), remove: true, before: encodeValue(row.data) });
    }
    if (plan.length > MAX_RESTORE_WRITES) throw new Error('Выбрано ' + plan.length + ' операций; предел безопасного атомарного восстановления — ' + MAX_RESTORE_WRITES + '. Выберите меньше разделов или используйте контролируемую миграцию');
    return plan;
  }
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (record(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  async function commitPlan(plan, owner, destructive) {
    assertActor(owner);
    assertRestoreReady();
    // One transaction: a permission error cannot leave half-restored collections.
    // Compare against preflight on every retry so concurrent edits are never overwritten.
    await db.runTransaction(async tx => {
      assertRestoreReady();
      // Merge imports can overwrite a reserved archive too. Always read the
      // lifecycle document so a concurrent freeze forces a transaction retry.
      const shift = await tx.get(refFromPath(['workspaces','main_workspace','shift','current']));
      const checkShift = destructive ? requireClosedShift : requireSettledShift;
      checkShift(shift);
      for (const op of plan) {
        const snap = await tx.get(op.ref), current = snap.exists ? encodeValue(snap.data()) : null;
        if (canonical(current) !== canonical(op.before)) throw new Error('Данные изменились на другом устройстве. Восстановление отменено');
      }
      assertActor(owner);
      assertRestoreReady();
      checkShift(shift); // Local state may have changed while awaiting plan reads.
      for (const op of plan) {
        if (op.remove) tx.delete(op.ref);
        else tx.set(op.ref, op.data, { merge: op.merge });
      }
    });
  }
  async function restoreBackup(id, sections) {
    if (restoreInProgress || backupInProgress) { showError('Другая операция уже выполняется'); return false; }
    restoreInProgress = true;
    let safety, commitAttempted = false;
    try {
      assertRestoreReady(); const owner = actor();
      requireClosedShift(serverSnapshot(await refFromPath(['workspaces','main_workspace','shift','current']).get({ source: 'server' })));
      const payload = await readBackupData(id);
      const plan = await makePlan(payload, sections, false);
      assertRestoreReady();
      safety = await createBackup('before_restore', 'Перед восстановлением из ' + id);
      if (!safety) throw new Error('Защитная копия не создана / не проверена. Текущие данные не изменены');
      assertActor(owner);
      commitAttempted = true;
      await commitPlan(plan, owner, true);
      if (typeof showToastEl === 'function') showToastEl('✅ Восстановлено атомарно. Аудит, табель и фото не изменены. Защитная копия: ' + safety.id, false);
      setTimeout(() => location.reload(), 1500);
      return true;
    } catch(e) {
      console.error('[backup] Restore error:', e);
      if (typeof showError === 'function') showError((commitAttempted ? 'Результат атомарной записи не подтверждён; проверьте данные перед повтором: ' : 'Восстановление не выполнено: ') + e.message + (safety ? '. Защитная копия: ' + safety.id : ''));
      return false;
    } finally { restoreInProgress = false; }
  }
  async function fileEnvelope(payload) {
    validatePayload(payload, true);
    return { format: FORMAT + '-file', version: VERSION, payload, sha256: await digest(canonical(payload)) };
  }
  async function exportFileData() {
    if (backupInProgress || restoreInProgress) throw new Error('Другая операция уже выполняется');
    backupInProgress = true;
    try {
      assertAdmin(); const owner = actor();
      const file = await fileEnvelope(await collectPayload('file', 'Экспорт файла'));
      assertActor(owner);
      return file;
    } finally { backupInProgress = false; }
  }
  async function importRows(data) {
    if (restoreInProgress || backupInProgress) throw new Error('Другая операция уже выполняется');
    assertRestoreReady();
    const owner = actor(), names = ['trucks','objects','archive'];
    restoreInProgress = true;
    let safety, commitAttempted = false;
    try {
      if (data && data.format === FORMAT + '-file') {
        if (data.version !== VERSION || !record(data.payload) || data.sha256 !== await digest(canonical(data.payload))) throw new Error('Контрольная сумма файла не совпадает');
        data = data.payload;
      }
      if (data && data.format && data.format !== FORMAT) throw new Error('Неподдерживаемый формат файла');
      if (data && data.format === FORMAT && data.version !== VERSION && data.version !== 1) throw new Error('Неподдерживаемая версия файла');
      let source;
      if (data && data.format === FORMAT && data.version === VERSION) {
        validatePayload(data); source = data.data;
      } else if (data && data.version === 1 && record(data.data)) {
        validatePayload(data, true); source = data.data;
      } else {
        if (!record(data) || !names.some(n => Array.isArray(data[n]))) throw new Error('Файл не похож на резервную копию программы');
        source = {};
        for (const name of names) {
          if (data[name] !== undefined && !Array.isArray(data[name])) throw new Error('Неверный раздел: ' + name);
          source[name] = (data[name] || []).map(item => {
            if (!record(item) || !validId(item.id)) throw new Error('Запись без допустимого ID: ' + name);
            const value = { ...item }; delete value.id;
            return { id: item.id, data: value };
          });
        }
      }
      const rows = {};
      for (const name of names) {
        rows[name] = source[name] || [];
        validateRows(rows[name], collectionsForBackup().find(col => col.name === name));
      }
      // File import remains a merge, never a destructive replacement of legacy copies.
      const counts = names.map(n => n + ': ' + rows[n].length).join('\n');
      if (!(await appConfirm('Импорт только базы и архива: добавит/обновит по ID, ничего не удалит.\n' + counts +
        '\nТабель, аудит/игровая экономика, настройки и фото НЕ восстанавливаются этим импортом. Старые копии могли быть неполными. Перед записью обязательна проверенная защитная копия. Продолжить?'))) return null;
      assertRestoreReady();
      requireSettledShift(serverSnapshot(await refFromPath(['workspaces','main_workspace','shift','current']).get({ source: 'server' })));
      const plan = [];
      for (const name of names) for (const row of rows[name]) {
        const col = collectionsForBackup().find(c => c.name === name), ref = refFromPath(col.path).doc(row.id);
        const snap = serverSnapshot(await ref.get({ source: 'server' }));
        plan.push({ ref, data: decodeValue(row.data, true), merge: true, before: snap.exists ? encodeValue(snap.data()) : null });
      }
      if (plan.length > MAX_RESTORE_WRITES) throw new Error('Импорт больше 400 записей требует контролируемой миграции: частичная запись запрещена');
      assertRestoreReady();
      safety = await createBackup('before_restore', 'Перед импортом файла');
      if (!safety) throw new Error('Защитная копия не создана / не проверена. Импорт отменён');
      commitAttempted = true;
      await commitPlan(plan, owner);
      return { written: plan.length, safetyId: safety.id };
    } catch(e) {
      if (commitAttempted) e.message = 'Результат атомарной записи не подтверждён. Проверьте данные перед повтором. ' + e.message;
      if (safety) e.message += '. Защитная копия: ' + safety.id;
      throw e;
    } finally { restoreInProgress = false; }
  }
  window.SamosvalBackup = Object.freeze({ collectPayload, validatePayload, createBackup, readBackupData, restoreBackup, importRows, fileEnvelope, exportFileData });

  // ===== Модалка восстановления =====
  async function openRestoreModal(id) {
    assertAdmin(); const owner = actor();
    const metaDoc = serverSnapshot(await BACKUPS_COLL.doc(id).get({ source: 'server' }));
    if (!metaDoc.exists) { showError('Бэкап не найден'); return; }
    assertActor(owner);
    const meta = metaDoc.data();
    if (meta.version !== VERSION || meta.complete !== true) { showError('Старая или неполная копия: восстановление заблокировано. Скачайте файл для проверки; допустим только явный импорт базы/архива без удаления.'); return; }

    const old = document.getElementById('restoreBackupModal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'restoreBackupModal';
    overlay.className = 'modal open';
    overlay.style.zIndex = '10020';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '500px';
    content.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="font-size:16px;">♻️ Восстановление бэкапа</h3>
        <button class="btn-del" onclick="document.getElementById('restoreBackupModal').remove()">✕</button>
      </div>
      <div style="font-size:12px; color:var(--muted); margin-bottom:12px; line-height:1.5;">
        📅 <b>${tsLabel(meta.createdAt)}</b><br>
        👤 ${escapeHtml(meta.createdBy || '—')} · ${sizeLabel(meta.sizeBytes)} · ${escapeHtml(meta.type || 'manual')}
      </div>

      <div style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:10px; font-size:12px; color:#fca5a5; margin-bottom:14px; line-height:1.4;">
        ⚠️ <b>Внимание!</b> Записи выбранных разделов будут заменены данными из бэкапа. Новые записи других устройств, отсутствовавшие при проверке, не удаляются; единого снимка всех устройств нет.<br>
        Перед восстановлением обязательно создаётся и проверяется защитная копия. Активная смена, незавершённое закрытие/восстановление смены и несинхронизированная/повреждённая локальная очередь блокируют замену. Остановите работу на других устройствах. Не более 400 операций за одну атомарную запись. Табель и полный аудит (включая игровую экономику) сохраняются в файле, но защищены от клиентской перезаписи. JPEG, метаданные/счётчики фото и локальные очереди не включены.
      </div>

      <div style="font-size:13px; font-weight:700; margin-bottom:8px;">Что восстановить:</div>
      <label style="display:flex; align-items:center; gap:8px; padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; margin-bottom:6px; cursor:pointer;">
        <input type="checkbox" id="rsBase" checked style="width:18px; height:18px; accent-color:var(--primary);">
        <span>🏢 База (самосвалы, объекты) — <b>${(meta.counts?.trucks || 0) + (meta.counts?.objects || 0)}</b> записей</span>
      </label>
      <label style="display:flex; align-items:center; gap:8px; padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; margin-bottom:6px; cursor:pointer;">
        <input type="checkbox" id="rsArchive" checked style="width:18px; height:18px; accent-color:var(--primary);">
        <span>🗄 Архив (закрытые смены) — <b>${(meta.counts?.archive || 0) + (meta.counts?.trash || 0)}</b> смен</span>
      </label>
      <label style="display:flex; align-items:center; gap:8px; padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; margin-bottom:6px; cursor:pointer;">
        <input type="checkbox" id="rsSettings" checked style="width:18px; height:18px; accent-color:var(--primary);">
        <span>⚙️ Настройки (права, MAX, патчи, расширения)</span>
      </label>
      <label style="display:flex; align-items:center; gap:8px; padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; margin-bottom:6px; cursor:pointer;">
        <input type="checkbox" id="rsUsers" checked style="width:18px; height:18px; accent-color:var(--primary);">
        <span>👥 Пользователи — <b>${meta.counts?.users || 0}</b> (метаданные, не пароли)</span>
      </label>
      <label style="display:flex; align-items:center; gap:8px; padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; margin-bottom:12px; cursor:pointer;">
        <input type="checkbox" id="rsShift" checked style="width:18px; height:18px; accent-color:var(--primary);">
        <span>🚛 Текущая смена + рейсы + статусы</span>
      </label>

      <div style="display:flex; gap:8px;">
        <button class="btn btn-secondary" onclick="document.getElementById('restoreBackupModal').remove()" style="flex:1;">Отмена</button>
        <button class="btn btn-danger" id="rsConfirmBtn" style="flex:1;">♻️ Восстановить</button>
      </div>
    `;
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    content.querySelector('#rsConfirmBtn').onclick = async () => {
      const sections = {
        base: content.querySelector('#rsBase').checked,
        archive: content.querySelector('#rsArchive').checked,
        settings: content.querySelector('#rsSettings').checked,
        users: content.querySelector('#rsUsers').checked,
        shift: content.querySelector('#rsShift').checked
      };
      if (!sections.base && !sections.archive && !sections.settings && !sections.users && !sections.shift) {
        appNotice('Выберите хотя бы одну секцию');
        return;
      }

      // Двойное подтверждение
      const ok = (await appConfirm(`Восстановить из бэкапа?\n\n${tsLabel(meta.createdAt)}\n\nТекущие данные в выбранных секциях будут перезаписаны.`));
      if (!ok) return;

      overlay.remove();
      await restoreBackup(id, sections);
    };
  }

  // ===== UI =====
  function renderBackupUI() {
    const tab = document.getElementById('tab-backup');
    if (!tab) return;

    // Удалить старый блок
    const old = document.getElementById('backupAutoBlock');
    if (old) old.remove();

    const block = document.createElement('div');
    block.id = 'backupAutoBlock';
    block.innerHTML = `
      <div class="section-title" style="margin-top:0;">💾 Автоматические бэкапы на сервере</div>
      <p style="font-size:12px; color:var(--muted);">Включены табель и полный аудит/игровая экономика. Фото (JPEG, метаданные, счётчики), локальные очереди и пароли не включены. Снимок читается по разделам, не является единой транзакцией; на время копирования остановите работу других устройств.</p>
      <div class="form-card">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; gap:8px; flex-wrap:wrap;">
          <div style="flex:1; min-width:150px;">
            <div style="font-size:13px; font-weight:700;">Автобэкап</div>
            <div style="font-size:11px; color:var(--muted); margin-top:2px;">При загрузке приложения</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="autoBackupToggle">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div style="display:flex; gap:6px; align-items:center; margin-bottom:12px;">
          <label style="font-size:12px; color:var(--muted);">Интервал:</label>
          <select id="autoBackupInterval" class="form-control" style="flex:1; font-size:12px; padding:6px;">
            <option value="1">Каждый час</option>
            <option value="3">Каждые 3 часа</option>
            <option value="6" selected>Каждые 6 часов</option>
            <option value="12">Каждые 12 часов</option>
            <option value="24">Раз в день</option>
          </select>
        </div>
        <button class="btn btn-quick" id="createBackupBtn" style="width:100%;">💾 Создать бэкап сейчас</button>
        <div style="font-size:11px; color:var(--muted); margin-top:8px; text-align:center;" id="lastBackupInfo">—</div>
      </div>

      <div class="section-title">📋 Точки восстановления</div>
      <div id="backupsListContainer">
        <div class="empty-state">Загрузка...</div>
      </div>
    `;
    tab.insertBefore(block, tab.firstChild);

    // Wire
    const toggle = block.querySelector('#autoBackupToggle');
    const interval = block.querySelector('#autoBackupInterval');
    const createBtn = block.querySelector('#createBackupBtn');

    toggle.checked = localStorage.getItem('dt_backup_auto') === '1';
    interval.value = localStorage.getItem('dt_backup_interval') || '6';

    toggle.onchange = () => {
      localStorage.setItem('dt_backup_auto', toggle.checked ? '1' : '0');
      if (typeof showToastEl === 'function') showToastEl(toggle.checked ? '✅ Автобэкап включён' : '⏸ Автобэкап выключен', false);
    };
    interval.onchange = () => {
      localStorage.setItem('dt_backup_interval', interval.value);
    };
    createBtn.onclick = () => createBackup('manual', 'Ручной бэкап');

    updateLastBackupInfo();
    loadBackupsList();
  }

  function updateLastBackupInfo() {
    const el = document.getElementById('lastBackupInfo');
    if (!el) return;
    const lastAuto = parseInt(localStorage.getItem('dt_backup_last_auto') || '0');
    if (lastAuto) {
      const ago = Math.floor((Date.now() - lastAuto) / 60000);
      let agoStr;
      if (ago < 60) agoStr = ago + ' мин назад';
      else if (ago < 1440) agoStr = Math.floor(ago / 60) + ' ч назад';
      else agoStr = Math.floor(ago / 1440) + ' дн назад';
      el.textContent = 'Последний автобэкап: ' + tsLabel(lastAuto) + ' (' + agoStr + ')';
    } else {
      el.textContent = 'Автобэкапов ещё не было';
    }
  }

  async function loadBackupsList() {
    const c = document.getElementById('backupsListContainer');
    if (!c) return;

    try {
      const backups = await listBackups();

      if (!backups.length) {
        c.innerHTML = '<div class="empty-state">Пока нет бэкапов</div>';
        return;
      }

      const typeLabels = {
        auto: { label: 'Авто', color: '#3b82f6' },
        manual: { label: 'Ручной', color: '#22c55e' },
        before_restore: { label: 'Перед восст.', color: '#f59e0b' },
        before_close: { label: 'Перед закрытием', color: '#f59e0b' },
        before_import: { label: 'Перед импортом', color: '#f59e0b' }
      };

      c.innerHTML = backups.map(b => {
        const t = typeLabels[b.type] || { label: b.type || '—', color: '#94a3b8' };
        const counts = b.counts || {};
        return `
          <div class="log-item" style="display:flex; flex-direction:column; align-items:stretch; gap:8px; padding:10px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap;">
              <div style="flex:1; min-width:0;">
                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                  <span style="font-size:11px; font-weight:800; color:${t.color}; text-transform:uppercase;">${escapeHtml(t.label)}</span>
                  ${b.important ? '<span style="font-size:10px; background:rgba(139,92,246,0.2); color:#c4b5fd; padding:1px 6px; border-radius:4px; font-weight:700;">⭐ ВАЖНЫЙ</span>' : ''}
                </div>
                <div style="font-size:12px; font-weight:600; margin-top:3px;">${tsLabel(b.createdAt)}</div>
                <div style="font-size:10px; color:var(--muted); margin-top:2px;">
                  👤 ${escapeHtml(b.createdBy || '—')} · ${sizeLabel(b.sizeBytes)} · 
                  🚛${counts.trucks || 0} 🏢${counts.objects || 0} 🗄${counts.archive || 0} 👥${counts.users || 0}
                </div>
              </div>
            </div>
            <div style="display:flex; gap:4px; flex-wrap:wrap;">
              <button class="btn btn-quick btn-small" data-restore-id="${b.id}" style="flex:1; font-size:11px; padding:6px;">♻️ Восстановить</button>
              <button class="btn btn-secondary btn-small" data-download-id="${b.id}" style="flex:1; font-size:11px; padding:6px;">📥 Скачать</button>
              <button class="btn btn-secondary btn-small" data-important-id="${b.id}" data-important="${b.important ? '1' : '0'}" style="font-size:11px; padding:6px;">${b.important ? '⭐' : '☆'}</button>
              <button class="btn btn-danger btn-small" data-delete-id="${b.id}" style="font-size:11px; padding:6px;">🗑</button>
            </div>
          </div>
        `;
      }).join('');

      c.querySelectorAll('[data-restore-id]').forEach(btn => {
        btn.onclick = async () => {
          try { await openRestoreModal(btn.dataset.restoreId); }
          catch(e) { showError('Не удалось открыть восстановление: ' + e.message); }
        };
      });
      c.querySelectorAll('[data-download-id]').forEach(btn => {
        btn.onclick = () => downloadBackupFile(btn.dataset.downloadId);
      });
      c.querySelectorAll('[data-delete-id]').forEach(btn => {
        btn.onclick = () => deleteBackup(btn.dataset.deleteId);
      });
      c.querySelectorAll('[data-important-id]').forEach(btn => {
        btn.onclick = async () => {
          const id = btn.dataset.importantId;
          const isImportant = btn.dataset.important === '1';
          try {
            await BACKUPS_COLL.doc(id).update({ important: !isImportant });
            loadBackupsList();
          } catch(e) {
            if (typeof showError === 'function') showError(e.message);
          }
        };
      });
    } catch(e) {
      c.innerHTML = '<div class="empty-state" style="color:var(--danger);">Ошибка: ' + escapeHtml(e.message) + '</div>';
    }
  }

  // ===== Автобэкап при загрузке =====
  async function checkAutoBackup() {
    if (typeof currentUserRole === 'undefined' || currentUserRole !== 'admin') return;
    if (localStorage.getItem('dt_backup_auto') !== '1') return;
    if (backupInProgress) return;

    const intervalH = parseInt(localStorage.getItem('dt_backup_interval') || '6') || 6;
    const lastAuto = parseInt(localStorage.getItem('dt_backup_last_auto') || '0');
    const elapsed = Date.now() - lastAuto;

    if (elapsed < intervalH * 3600000) {
      console.log('[backup] Auto skip: только', Math.floor(elapsed / 60000), 'мин назад было');
      return;
    }

    console.log('[backup] Auto backup: срабатывает');
    await createBackup('auto', 'Автобэкап каждые ' + intervalH + 'ч');
  }

  // ===== Хук: перед закрытием смены =====
  const origCloseShift = window.closeShift;
  if (origCloseShift) {
    window.closeShift = async function() {
      // Проверяем — смена активна и админ
      if (state.shift && state.shift.isActive && typeof currentUserRole !== 'undefined' && currentUserRole === 'admin') {
        const ok = (await appConfirm('Перед закрытием смены создать резервную копию?'));
        if (ok) {
          const saved = await createBackup('before_close', 'Перед закрытием смены ' + (state.shift.objectName || ''));
          if (!saved) { showError('Закрытие отменено: запрошенная защитная копия не создана'); return; }
        }
      }
      return origCloseShift.apply(this, arguments);
    };
  }

  // ===== Перехват switchTab для рендера UI =====
  const origSwitchTab = window.switchTab;
  if (origSwitchTab) {
    window.switchTab = function(name, btn) {
      const result = origSwitchTab.apply(this, arguments);
      if (name === 'backup') {
        setTimeout(renderBackupUI, 100);
        setTimeout(() => {
          updateLastBackupInfo();
          loadBackupsList();
        }, 200);
      }
      return result;
    };
  }

  // ===== Первый запуск =====
  setTimeout(() => {
    if (document.getElementById('tab-backup')?.classList.contains('active')) {
      renderBackupUI();
    }
  }, 800);

  // Автобэкап через 5 секунд после загрузки (дать время всем патчам)
  setTimeout(checkAutoBackup, 5000);

  // Периодическая проверка (каждые 30 минут)
  setInterval(() => {
    if (typeof currentUserRole !== 'undefined' && currentUserRole === 'admin') {
      checkAutoBackup();
    }
  }, 30 * 60000);

  console.log('[backup-v1] ✅ Активен. Автобэкап + ручное + восстановление.');
})();; }
catch (e) { console.error('[baked patch: Резервное копирование]', e); }
