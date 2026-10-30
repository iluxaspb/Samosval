(function(){
  if (window.__autoBackupV1) return;
  window.__autoBackupV1 = true;

  const BACKUPS_COLL = db.collection('backups');
  const CHUNK_SIZE = 700000; // 700 KB на чанк (безопасно < 1 MB)
  const MAX_BACKUPS = 15;
  const DEFAULT_INTERVAL_H = 6;

  let backupInProgress = false;

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
    try { return new Blob([str]).size; } catch(e) { return str.length; }
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
      { path: ['workspaces','main_workspace','audit'], name: 'audit', cat: 'audit', limit: 500 },
      { path: ['workspaces','main_workspace','plugins'], name: 'plugins', cat: 'settings' },
      { path: ['workspaces','main_workspace','patches'], name: 'patches', cat: 'settings' },
      { path: ['users'], name: 'users', cat: 'users' },
      { path: ['settings','permissions'], name: 'permissions', cat: 'settings', isDoc: true },
      { path: ['settings','appConfig'], name: 'appConfig', cat: 'settings', isDoc: true },
      { path: ['settings','appConfig_test'], name: 'appConfig_test', cat: 'settings', isDoc: true },
      { path: ['workspaces','main_workspace','shift','current'], name: 'shift', cat: 'shift', isDoc: true }
    ];
  }

  function refFromPath(path) {
    let ref = db;
    for (let i = 0; i < path.length - 1; i++) {
      ref = ref.collection(path[i]).doc(path[i + 1]);
      i++;
    }
    if (path.length % 2 === 1) {
      // последний — коллекция
      ref = ref.collection(path[path.length - 1]);
    }
    return ref;
  }

  async function readCollection(path, opts) {
    opts = opts || {};
    let ref = db;
    for (let i = 0; i < path.length - 1; i++) {
      if (i + 1 < path.length - 1 && path[i + 1]) {
        ref = ref.collection(path[i]).doc(path[i + 1]);
        i++;
      }
    }
    if (path.length % 2 === 1) {
      ref = ref.collection(path[path.length - 1]);
      let q = ref;
      if (opts.limit) {
        try {
          q = ref.orderBy('timestamp', 'desc').limit(opts.limit);
        } catch(e) {
          q = ref.limit(opts.limit);
        }
      }
      const snap = await q.get();
      return snap.docs.map(d => ({ id: d.id, data: d.data() }));
    } else {
      // последний элемент — id документа
      const docRef = ref.doc(path[path.length - 1]);
      const snap = await docRef.get();
      return snap.exists ? [{ id: snap.id, data: snap.data() }] : [];
    }
  }

  // ===== Создание бэкапа =====
  async function createBackup(type, description) {
    if(isNasRuntime()){try{const r=await nasBackupCommand('create:'+type,{type:'backup.create',backupType:type,description:description||''});if(type==='auto')localStorage.setItem('dt_backup_last_auto_test347',String(Date.now()));showToastEl('✅ Бэкап создан на Synology',false);renderBackupUI();return r.result.meta;}catch(e){showError('Ошибка бэкапа: '+e.message);return null;}}

    if (backupInProgress) {
      if (typeof showToastEl === 'function') showToastEl('⏳ Уже идёт создание бэкапа', true);
      return null;
    }
    backupInProgress = true;

    try {
      if (typeof showToastEl === 'function') showToastEl('💾 Создание бэкапа...', false);

      const cols = collectionsForBackup();
      const payload = {
        version: 1,
        createdAt: Date.now(),
        type: type,
        description: description || '',
        appVersion: '2.88',
        data: {}
      };
      const counts = {};

      for (const col of cols) {
        try {
          const docs = await readCollection(col.path, { limit: col.limit });
          payload.data[col.name] = docs;
          counts[col.name] = docs.length;
        } catch(e) {
          console.warn('[backup] read error:', col.name, e);
          payload.data[col.name] = [];
          counts[col.name] = 0;
        }
      }

      // Сериализация
      const jsonStr = JSON.stringify(payload);
      const totalBytes = byteLength(jsonStr);
      const chunkCount = Math.ceil(jsonStr.length / CHUNK_SIZE);

      // Метаданные
      const metaRef = BACKUPS_COLL.doc();
      const meta = {
        id: metaRef.id,
        createdAt: Date.now(),
        createdBy: (typeof getUserName === 'function') ? getUserName() : '—',
        createdByEmail: (typeof currentEmail !== 'undefined') ? currentEmail : '',
        type: type,
        description: description || '',
        sizeBytes: totalBytes,
        chunkCount: chunkCount,
        counts: counts,
        appVersion: '2.88'
      };

      // Чанки
      for (let i = 0; i < chunkCount; i++) {
        const chunk = jsonStr.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        await metaRef.collection('chunks').doc(String(i)).set({ idx: i, data: chunk });
      }

      // Метаданные последними (чтобы бэкап считался готовым только когда все чанки на месте)
      await metaRef.set(meta);

      console.log('[backup] Created:', meta.id, sizeLabel(totalBytes), counts);
      if (typeof showToastEl === 'function') showToastEl('✅ Бэкап создан (' + sizeLabel(totalBytes) + ')', false);

      // Обновить "last auto"
      if (type === 'auto') {
        try { localStorage.setItem('dt_backup_last_auto_test347', String(Date.now())); } catch(e) {}
      }

      // Ротация (удалить старые, кроме important)
      await rotateBackups();

      // Перерисовать UI
      renderBackupUI();

      return meta;
    } catch(e) {
      console.error('[backup] Create error:', e);
      if (typeof showError === 'function') showError('Ошибка бэкапа: ' + e.message);
      return null;
    } finally {
      backupInProgress = false;
    }
  }

  // ===== Ротация =====
  async function rotateBackups() {
    if(isNasRuntime())return;
    try {
      const snap = await BACKUPS_COLL.orderBy('createdAt', 'desc').get();
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
        const chunksSnap = await doc.ref.collection('chunks').get();
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
    if(isNasRuntime())return (await nasBackupRead()).items;
    try {
      const snap = await BACKUPS_COLL.orderBy('createdAt', 'desc').limit(50).get();
      return snap.docs.map(d => d.data());
    } catch(e) {
      console.warn('[backup] List error:', e);
      return [];
    }
  }

  // ===== Чтение бэкапа =====
  async function readBackupData(id) {
    if(isNasRuntime())return (await nasBackupRead(id)).payload;
    const metaDoc = await BACKUPS_COLL.doc(id).get();
    if (!metaDoc.exists) throw new Error('Бэкап не найден');
    const meta = metaDoc.data();
    const chunksSnap = await BACKUPS_COLL.doc(id).collection('chunks').orderBy('idx', 'asc').get();
    if (chunksSnap.size !== meta.chunkCount) {
      throw new Error('Не все чанки найдены (' + chunksSnap.size + '/' + meta.chunkCount + ')');
    }
    let json = '';
    chunksSnap.docs.forEach(d => { json += d.data().data; });
    return JSON.parse(json);
  }

  // ===== Удаление бэкапа =====
  async function deleteBackup(id) {
    if(isNasRuntime()){if(await appConfirm('Убрать точку восстановления из списка? Копия сохранится на Synology.')){try{await nasBackupCommand(id,{type:'backup.delete',backupId:id});renderBackupUI();}catch(e){showError(e.message);}}return;}
    if (!(await appConfirm('Удалить этот бэкап? Восстановить из него будет невозможно.'))) return;
    try {
      const chunksSnap = await BACKUPS_COLL.doc(id).collection('chunks').get();
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
      if (typeof showToastEl === 'function') showToastEl('⏳ Загрузка...', false);
      const data = await readBackupData(id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
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
  async function restoreBackup(id, sections) {
    if(isNasRuntime()){try{await nasBackupCommand(id,{type:'backup.restore',backupId:id,sections});showToastEl('✅ Восстановлено на Synology. Перезагрузка...',false);location.reload();}catch(e){showError(e.message);}return;}
    // sections: { base: true, archive: true, settings: true, users: true, shift: true }
    try {
      if (typeof showToastEl === 'function') showToastEl('⏳ Чтение бэкапа...', false);
      const payload = await readBackupData(id);

      // 1. Авто-бэкап текущего состояния (before_restore)
      if (typeof showToastEl === 'function') showToastEl('⏳ Бэкап текущего состояния...', false);
      await createBackup('before_restore', 'Перед восстановлением из ' + id);

      // 2. Восстановление
      if (typeof showToastEl === 'function') showToastEl('⏳ Восстановление...', false);

      const cols = collectionsForBackup();
      for (const col of cols) {
        const cat = col.cat;
        if (sections[cat] !== true) continue;

        const docs = payload.data[col.name] || [];
        const ref = refFromPath(col.path);

        // Определяем, коллекция это или документ
        const isDoc = col.isDoc === true;

        if (isDoc) {
          if (docs.length > 0) {
            await ref.set(docs[0].data, { merge: false });
          } else {
            await ref.delete().catch(() => {});
          }
          continue;
        }

        // Коллекция — удалить всё старое и добавить
        const existing = await ref.get();
        // Батчи по 400
        const existingDocs = existing.docs;
        for (let i = 0; i < existingDocs.length; i += 400) {
          const b = db.batch();
          for (let j = i; j < Math.min(i + 400, existingDocs.length); j++) {
            b.delete(existingDocs[j].ref);
          }
          await b.commit();
        }

        // Восстановление
        for (let i = 0; i < docs.length; i += 400) {
          const b = db.batch();
          for (let j = i; j < Math.min(i + 400, docs.length); j++) {
            const item = docs[j];
            b.set(ref.doc(item.id), item.data, { merge: false });
          }
          await b.commit();
        }

        console.log('[backup] Restored', col.name, ':', docs.length, 'docs');
      }

      if (typeof showToastEl === 'function') showToastEl('✅ Восстановление завершено. Перезагрузка...', false);
      setTimeout(() => location.reload(), 1500);
    } catch(e) {
      console.error('[backup] Restore error:', e);
      if (typeof showError === 'function') showError('Ошибка восстановления: ' + e.message);
    }
  }

  // ===== Модалка восстановления =====
  async function openRestoreModal(id) {
    const nasMeta=isNasRuntime()?(await nasBackupRead(id)).meta:null;
    const metaDoc = nasMeta?null:await BACKUPS_COLL.doc(id).get();
    if (!nasMeta&&!metaDoc.exists) { showError('Бэкап не найден'); return; }
    const meta = nasMeta||metaDoc.data();

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
        👤 ${escapeHtml(meta.createdBy || '—')} · ${sizeLabel(meta.sizeBytes)} · ${meta.type || 'manual'}
      </div>

      <div style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:10px; font-size:12px; color:#fca5a5; margin-bottom:14px; line-height:1.4;">
        ⚠️ <b>Внимание!</b> Текущие данные в выбранных секциях будут заменены данными из бэкапа.<br>
        Перед восстановлением автоматически создаётся резервная копия текущего состояния.
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

      ${isNasRuntime()?'<label style="display:flex;gap:8px;padding:8px"><input type="checkbox" id="rsTabel" checked>📋 Табель (формулы и оформление)</label>':''}
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
      if(isNasRuntime())sections.tabel=!!document.getElementById('rsTabel')?.checked;
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

    toggle.checked = localStorage.getItem('dt_backup_auto_test347') === '1';
    interval.value = localStorage.getItem('dt_backup_interval_test347') || '6';

    toggle.onchange = () => {
      localStorage.setItem('dt_backup_auto_test347', toggle.checked ? '1' : '0');
      if (typeof showToastEl === 'function') showToastEl(toggle.checked ? '✅ Автобэкап включён' : '⏸ Автобэкап выключен', false);
    };
    interval.onchange = () => {
      localStorage.setItem('dt_backup_interval_test347', interval.value);
    };
    createBtn.onclick = () => createBackup('manual', 'Ручной бэкап');

    updateLastBackupInfo();
    loadBackupsList();
  }

  function updateLastBackupInfo() {
    const el = document.getElementById('lastBackupInfo');
    if (!el) return;
    const lastAuto = parseInt(localStorage.getItem('dt_backup_last_auto_test347') || '0');
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
                  <span style="font-size:11px; font-weight:800; color:${t.color}; text-transform:uppercase;">${t.label}</span>
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
        btn.onclick = () => openRestoreModal(btn.dataset.restoreId);
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
            if(isNasRuntime())await nasBackupCommand(id,{type:'backup.mark',backupId:id,important:!isImportant});
            else await BACKUPS_COLL.doc(id).update({ important: !isImportant });
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
    if (localStorage.getItem('dt_backup_auto_test347') !== '1') return;
    if (backupInProgress) return;

    const intervalH = parseInt(localStorage.getItem('dt_backup_interval_test347') || '6') || 6;
    const lastAuto = parseInt(localStorage.getItem('dt_backup_last_auto_test347') || '0');
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
          await createBackup('before_close', 'Перед закрытием смены ' + (state.shift.objectName || ''));
        }
      }
      return origCloseShift.apply(this, arguments);
    };
  }

  // ===== Хук: перед импортом =====
  const origImportBackup = window.importBackupFile;
  if (origImportBackup) {
    window.importBackupFile = async function(ev) {
      if (typeof currentUserRole !== 'undefined' && currentUserRole === 'admin') {
        const file = ev.target?.files?.[0];
        if (file) {
          const ok = (await appConfirm('Перед импортом создать резервную копию текущих данных?'));
          if (ok) {
            await createBackup('before_import', 'Перед импортом бэкапа');
          }
        }
      }
      return origImportBackup.apply(this, arguments);
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
})();