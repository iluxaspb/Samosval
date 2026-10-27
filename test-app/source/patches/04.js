(function(){
  if (window.__patchesUIv1) return;
  window.__patchesUIv1 = true;

  // ===== CSS =====
  const oldCss = document.getElementById('patches-ui-css');
  if (oldCss) oldCss.remove();

  const css = document.createElement('style');
  css.id = 'patches-ui-css';
  css.textContent = `
    /* Компактный вид */
    #patchesListContainer .patch-row {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 10px; margin-bottom: 6px;
      background: var(--card); border: 1px solid var(--border); border-radius: 8px;
      transition: all 0.15s; cursor: pointer;
    }
    #patchesListContainer .patch-row.selected {
      background: rgba(59, 130, 246, 0.1); border-color: var(--primary);
    }
    #patchesListContainer .patch-row.disabled { opacity: 0.55; }
    #patchesListContainer .patch-check {
      width: 18px; height: 18px; accent-color: var(--primary);
      flex-shrink: 0; cursor: pointer;
    }
    #patchesListContainer .patch-info { flex: 1 1 auto; min-width: 0; overflow: hidden; }
    #patchesListContainer .patch-name {
      font-size: 13px; font-weight: 700;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #patchesListContainer .patch-type {
      font-size: 10px; margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #patchesListContainer .patch-type.fn { color: var(--success); }
    #patchesListContainer .patch-type.rep { color: var(--warning); }
    #patchesListContainer .patch-toggle-wrap {
      flex-shrink: 0; transform: scale(0.75); transform-origin: center;
    }
    #patchesListContainer .patch-actions { display: flex; gap: 3px; flex-shrink: 0; }
    #patchesListContainer .patch-action-btn {
      width: 30px; height: 30px; padding: 0; border-radius: 6px;
      border: 1px solid var(--border); background: transparent; color: var(--text);
      font-size: 14px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      -webkit-tap-highlight-color: transparent;
    }
    #patchesListContainer .patch-action-btn:active {
      transform: scale(0.92); background: rgba(255,255,255,0.1);
    }
    #patchesListContainer .patch-action-btn.del { color: var(--danger); border-color: rgba(239, 68, 68, 0.4); }
    #patchesListContainer .patch-action-btn.history { color: var(--warning); border-color: rgba(245, 158, 11, 0.4); }

    /* Bulk панель */
    #bulkPatchesBar {
      display: none; gap: 8px; align-items: center;
      padding: 10px; margin-bottom: 10px;
      background: rgba(59, 130, 246, 0.1);
      border: 1px solid rgba(59, 130, 246, 0.35); border-radius: 8px;
    }
    #bulkPatchesBar.visible { display: flex; }
    #bulkPatchesBar .bulk-count { flex: 1; font-size: 12px; font-weight: 700; color: #93c5fd; }

    /* Sticky кнопки Вставить/Очистить */
    .patch-code-actions {
      position: sticky !important;
      bottom: 0 !important;
      background: var(--card) !important;
      padding: 8px 0 !important;
      display: flex !important;
      gap: 8px !important;
      z-index: 10 !important;
      border-top: 1px solid var(--border) !important;
    }
    .patch-code-actions > button { flex: 1; }

    /* История */
    .history-item {
      padding: 10px; margin-bottom: 8px;
      background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    }
    .history-item-header {
      display: flex; justify-content: space-between; align-items: center;
      gap: 8px; margin-bottom: 6px; flex-wrap: wrap;
    }
    .history-item-meta { font-size: 11px; color: var(--muted); }
    .history-item-preview {
      font-family: monospace; font-size: 10px;
      background: var(--card); padding: 6px; border-radius: 4px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      color: var(--muted);
    }
  `;
  document.head.appendChild(css);

  let selectedPatchIds = new Set();

  // ===== renderPatchesList =====
  window.renderPatchesList = function() {
    const c = document.getElementById('patchesListContainer');
    if (!c) return;

    let bulkBar = document.getElementById('bulkPatchesBar');
    if (!bulkBar) {
      bulkBar = document.createElement('div');
      bulkBar.id = 'bulkPatchesBar';
      bulkBar.innerHTML = `
        <span class="bulk-count" id="bulkCount">Выбрано: 0</span>
        <button class="btn btn-secondary btn-small" id="bulkSelectAllBtn" style="font-size: 11px;">Все</button>
        <button class="btn btn-danger btn-small" id="bulkDeleteBtn" style="font-size: 11px;">🗑 Удалить</button>
      `;
      if (c.parentNode) c.parentNode.insertBefore(bulkBar, c);

      document.getElementById('bulkSelectAllBtn').onclick = () => {
        if (!state.patches) return;
        if (selectedPatchIds.size === state.patches.length) selectedPatchIds.clear();
        else selectedPatchIds = new Set(state.patches.map(p => p.id));
        window.renderPatchesList();
      };

      document.getElementById('bulkDeleteBtn').onclick = async () => {
        if (selectedPatchIds.size === 0) return;
        if (!(await appConfirm(`Удалить ${selectedPatchIds.size} патч(ей)?`))) return;
        const ids = Array.from(selectedPatchIds);
        try {
          for (const id of ids) {
            await refs.patches.doc(id).delete();
          }
          selectedPatchIds.clear();
          if (typeof showToastEl === 'function') showToastEl(`✅ Удалено: ${ids.length}. Перезагрузка...`, false);
          setTimeout(() => location.reload(), 800);
        } catch(e) {
          if (typeof showError === 'function') showError(e.message);
        }
      };
    }

    if (!state.patches || !state.patches.length) {
      c.innerHTML = '<div class="empty-state">Нет добавленных патчей</div>';
      bulkBar.classList.remove('visible');
      return;
    }

    const realIds = new Set(state.patches.map(p => p.id));
    for (const id of Array.from(selectedPatchIds)) {
      if (!realIds.has(id)) selectedPatchIds.delete(id);
    }

    if (selectedPatchIds.size > 0) {
      bulkBar.classList.add('visible');
      const cnt = document.getElementById('bulkCount');
      if (cnt) cnt.textContent = `Выбрано: ${selectedPatchIds.size}`;
    } else {
      bulkBar.classList.remove('visible');
    }

    c.innerHTML = state.patches.map(p => {
      const isSel = selectedPatchIds.has(p.id);
      const typeLabel = p.type === 'function' ? '🔁 Замена функции' : '🔍 Найти/Заменить';
      const typeCls = p.type === 'function' ? 'fn' : 'rep';
      const histCount = Array.isArray(p.history) ? p.history.length : 0;
      return `
        <div class="patch-row ${isSel ? 'selected' : ''} ${!p.enabled ? 'disabled' : ''}" data-patch-id="${p.id}">
          <input type="checkbox" class="patch-check" data-check-id="${p.id}" ${isSel ? 'checked' : ''}>
          <div class="patch-info">
            <div class="patch-name">${escapeHtml(p.name)}</div>
            <div class="patch-type ${typeCls}">${typeLabel}${histCount > 0 ? ` · 📜 ${histCount}` : ''}</div>
          </div>
          <label class="patch-toggle-wrap toggle-switch" onclick="event.stopPropagation()">
            <input type="checkbox" ${p.enabled ? 'checked' : ''} data-toggle-id="${p.id}">
            <span class="toggle-slider"></span>
          </label>
          <div class="patch-actions">
            <button class="patch-action-btn" data-edit-id="${p.id}" title="Редактировать">✏️</button>
            <button class="patch-action-btn history" data-history-id="${p.id}" title="История">🕒</button>
            <button class="patch-action-btn del" data-del-id="${p.id}" title="Удалить">🗑</button>
          </div>
        </div>
      `;
    }).join('');

    c.querySelectorAll('.patch-check').forEach(chk => {
      chk.onclick = (e) => e.stopPropagation();
      chk.onchange = () => {
        const id = chk.dataset.checkId;
        if (chk.checked) selectedPatchIds.add(id);
        else selectedPatchIds.delete(id);
        window.renderPatchesList();
      };
    });

    c.querySelectorAll('[data-toggle-id]').forEach(inp => {
      inp.onclick = (e) => e.stopPropagation();
      inp.onchange = () => {
        if (typeof togglePatchStatus === 'function') togglePatchStatus(inp.dataset.toggleId, inp.checked);
      };
    });

    c.querySelectorAll('[data-edit-id]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        window.openPatchModalWithHistory(btn.dataset.editId);
      };
    });

    c.querySelectorAll('[data-history-id]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        openHistoryModal(btn.dataset.historyId);
      };
    });

    c.querySelectorAll('[data-del-id]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const p = state.patches.find(x => x.id === btn.dataset.delId);
        if (!p) return;
        if (!(await appConfirm(`Удалить патч "${p.name}"?`))) return;
        try {
          await refs.patches.doc(p.id).delete();
          selectedPatchIds.delete(p.id);
          if (typeof showToastEl === 'function') showToastEl('🗑 Удалён. Перезагрузка...', false);
          setTimeout(() => location.reload(), 800);
        } catch(e) {
          if (typeof showError === 'function') showError(e.message);
        }
      };
    });

    c.querySelectorAll('.patch-row').forEach(row => {
      row.onclick = (e) => {
        if (e.target.closest('button, input, label')) return;
        window.openPatchModalWithHistory(row.dataset.patchId);
      };
    });
  };

  // ===== openPatchModalWithHistory =====
  window.openPatchModalWithHistory = function(id) {
    if (typeof canAdmin === 'function' && !canAdmin()) return;
    const p = id ? state.patches.find(x => x.id === id) : null;
    document.getElementById('editPatchId').value = id || '';
    document.getElementById('patchName').value = p ? p.name : '';
    document.getElementById('patchType').value = p ? (p.type || 'function') : 'function';
    document.getElementById('patchCodeFunction').value = '';
    document.getElementById('patchFnName').value = '';
    document.getElementById('patchFind').value = '';
    document.getElementById('patchReplace').value = '';
    if (p) {
      if (p.type === 'function') document.getElementById('patchCodeFunction').value = p.code || '';
      else {
        document.getElementById('patchFnName').value = p.fnName || '';
        document.getElementById('patchFind').value = p.findText || '';
        document.getElementById('patchReplace').value = p.replaceText || '';
      }
    }
    document.getElementById('patchModalTitle').textContent = p ? 'Редактировать патч' : 'Новый патч';
    if (typeof togglePatchType === 'function') togglePatchType();
    applySticky();
    document.getElementById('patchEditModal').classList.add('open');
  };

  // Переопределяем openPatchModal — чтобы тоже через историю
  const origOpenPatchModal = window.openPatchModal;
  window.openPatchModal = function(id) {
    window.openPatchModalWithHistory(id);
  };

  // ===== Sticky кнопки =====
  function applySticky() {
    ['patchCodeFunction', 'patchFind', 'patchReplace'].forEach(taId => {
      const ta = document.getElementById(taId);
      if (!ta) return;
      const group = ta.closest('.form-group');
      if (!group) return;
      group.querySelectorAll('div').forEach(div => {
        if (div.style && (div.style.display === 'flex' || div.style.display.includes('flex'))) {
          if (div.querySelectorAll('button').length >= 1 && !div.classList.contains('patch-code-actions')) {
            div.classList.add('patch-code-actions');
          }
        }
      });
    });
  }

  const origTogglePatchType = window.togglePatchType;
  window.togglePatchType = function() {
    if (origTogglePatchType) origTogglePatchType.apply(this, arguments);
    setTimeout(applySticky, 50);
  };

  // ===== savePatch — обёртка для истории =====
  const origSavePatch = window.savePatch;
  window.savePatch = async function() {
    const id = document.getElementById('editPatchId').value;
    if (!id) return origSavePatch.apply(this, arguments);

    const p = state.patches.find(x => x.id === id);
    if (!p) return origSavePatch.apply(this, arguments);

    const entry = {
      savedAt: Date.now(),
      savedBy: (typeof getUserName === 'function') ? getUserName() : '—',
      name: p.name || '',
      type: p.type || 'function',
      code: p.code || '',
      fnName: p.fnName || '',
      findText: p.findText || '',
      replaceText: p.replaceText || ''
    };
    const existing = Array.isArray(p.history) ? p.history : [];
    const newHistory = [entry, ...existing].slice(0, 5);

    try {
      await refs.patches.doc(id).update({ history: newHistory });
      p.history = newHistory;
    } catch(e) {
      console.warn('[patches-ui] history save error:', e);
    }

    return origSavePatch.apply(this, arguments);
  };

  // ===== Модалка истории =====
  function openHistoryModal(id) {
    const p = state.patches.find(x => x.id === id);
    if (!p) return;

    const history = Array.isArray(p.history) ? p.history : [];

    const old = document.getElementById('patchHistoryModal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'patchHistoryModal';
    overlay.className = 'modal open';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '700px';
    content.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="font-size:16px;">📜 История: ${escapeHtml(p.name)}</h3>
        <button class="btn-del" onclick="document.getElementById('patchHistoryModal').remove()">✕</button>
      </div>
      <div class="modal-body" style="max-height:60vh;">
        ${history.length === 0
          ? '<div class="empty-state">История пуста. Появится после первого сохранения изменений.</div>'
          : history.map((h, idx) => {
              const date = new Date(h.savedAt || 0).toLocaleString('ru-RU');
              const typeLabel = h.type === 'function' ? '🔁' : '🔍';
              const preview = h.type === 'function'
                ? (h.code || '').substring(0, 100).replace(/\n/g, ' ')
                : `${h.fnName}: ${(h.findText||'').substring(0, 40)} → ${(h.replaceText||'').substring(0, 40)}`;
              return `
                <div class="history-item">
                  <div class="history-item-header">
                    <span class="history-item-meta">📅 ${date} · 👤 ${escapeHtml(h.savedBy || '—')} · ${typeLabel}</span>
                    <button class="btn btn-quick btn-small" data-restore="${idx}" style="font-size:11px; padding:4px 10px; min-height:28px;">↩ Восстановить</button>
                  </div>
                  <div class="history-item-preview">${escapeHtml(preview)}...</div>
                </div>
              `;
            }).join('')
        }
      </div>
    `;
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    content.querySelectorAll('[data-restore]').forEach(btn => {
      btn.onclick = async () => {
        const idx = parseInt(btn.dataset.restore);
        const h = history[idx];
        if (!h) return;
        if (!(await appConfirm(`Восстановить версию от ${new Date(h.savedAt).toLocaleString('ru-RU')}?`))) return;

        const currentEntry = {
          savedAt: Date.now(),
          savedBy: (typeof getUserName === 'function') ? getUserName() : '—',
          name: p.name || '',
          type: p.type || 'function',
          code: p.code || '',
          fnName: p.fnName || '',
          findText: p.findText || '',
          replaceText: p.replaceText || ''
        };
        const newHistory = [currentEntry, ...history.filter((_, i) => i !== idx)].slice(0, 5);

        try {
          await refs.patches.doc(id).update({
            name: h.name || p.name,
            type: h.type || p.type,
            code: h.code || '',
            fnName: h.fnName || '',
            findText: h.findText || '',
            replaceText: h.replaceText || '',
            history: newHistory,
            updatedAt: Date.now(),
            updatedBy: (typeof getUserName === 'function') ? getUserName() : '—'
          });
          if (typeof showToastEl === 'function') showToastEl('↩ Версия восстановлена. Перезагрузка...', false);
          setTimeout(() => location.reload(), 800);
        } catch(e) {
          if (typeof showError === 'function') showError(e.message);
        }
      };
    });
  }

  // ===== Работающая вставка =====
  async function pasteToField(fieldId) {
    const el = document.getElementById(fieldId);
    if (!el) return;

    // 1. readText
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          el.value = (el.value || '') + text;
          if (typeof showToastEl === 'function') showToastEl('📋 Вставлено', false);
          return;
        }
      }
    } catch(e) {}

    // 2. read
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type === 'text/plain' || type === 'text/html') {
              const blob = await item.getType(type);
              const text = await blob.text();
              if (text && text.trim()) {
                el.value = (el.value || '') + text;
                if (typeof showToastEl === 'function') showToastEl('📋 Вставлено', false);
                return;
              }
            }
          }
        }
      }
    } catch(e) {}

    // 3. Fallback
    showManualPaste(fieldId);
  }

  function showManualPaste(fieldId) {
    const old = document.getElementById('manualPasteModal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'manualPasteModal';
    overlay.className = 'modal open';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '500px';
    content.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="font-size:16px;">📋 Вставка кода</h3>
        <button class="btn-del" onclick="document.getElementById('manualPasteModal').remove()">✕</button>
      </div>
      <div style="font-size:12px; color:var(--muted); margin-bottom:10px; line-height:1.4;">
        Браузер не дал прямой доступ к буферу. Вставьте код вручную: нажмите на поле → удерживайте палец → «Вставить». Или используйте <b>Ctrl+V</b> на компьютере.
      </div>
      <textarea id="manualPasteTextarea" class="form-control" placeholder="Вставьте код сюда..." style="min-height:200px; font-family:monospace; font-size:12px;"></textarea>
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="btn btn-secondary" id="manualPasteCancel" style="flex:1;">Отмена</button>
        <button class="btn btn-quick" id="manualPasteConfirm" style="flex:1;">✅ Вставить в поле</button>
      </div>
    `;
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    setTimeout(() => {
      const ta = document.getElementById('manualPasteTextarea');
      if (ta) ta.focus();
    }, 100);

    document.getElementById('manualPasteCancel').onclick = () => overlay.remove();
    document.getElementById('manualPasteConfirm').onclick = () => {
      const text = document.getElementById('manualPasteTextarea').value;
      if (!text) { overlay.remove(); return; }
      const el = document.getElementById(fieldId);
      if (el) {
        el.value = (el.value || '') + text;
        if (typeof showToastEl === 'function') showToastEl('📋 Вставлено', false);
      }
      overlay.remove();
    };
  }

  // Переопределяем pastePatchField и pastePluginCode
  window.pastePatchField = function(fieldId) { pasteToField(fieldId); };
  window.pastePluginCode = async function() { pasteToField('pluginCode'); };

  // ===== switchAdminTab — перерисовать при переходе =====
  const origSwitchAdminTab = window.switchAdminTab;
  window.switchAdminTab = function(tab, btn) {
    if (origSwitchAdminTab) origSwitchAdminTab.apply(this, arguments);
    if (tab === 'patches') {
      setTimeout(() => {
        if (state.patches && state.patches.length > 0) window.renderPatchesList();
        applySticky();
      }, 100);
    }
  };

  // ===== Периодические проверки =====
  setInterval(() => {
    const modal = document.getElementById('patchEditModal');
    if (modal && modal.classList.contains('open')) applySticky();

    const activeTab = document.getElementById('admin-sub-patches');
    if (activeTab && activeTab.classList.contains('active')) {
      const c = document.getElementById('patchesListContainer');
      if (c && !c.querySelector('.patch-row') && state.patches && state.patches.length > 0) {
        window.renderPatchesList();
      }
    }
  }, 1500);

  setTimeout(() => {
    if (document.getElementById('admin-sub-patches')?.classList.contains('active')) {
      window.renderPatchesList();
    }
  }, 500);

  console.log('[patches-ui] ✅ Активен. Компакт + чекбоксы + история (5 версий) + работающая вставка.');
})();