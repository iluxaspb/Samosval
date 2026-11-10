  async function loadAndApplyPatches() {
    if(isNasRuntime())return refreshNasAuxiliary();
    try {
      const snap = await refs.patches.where('enabled', '==', true).get();
      state.patches = snap.docs.map(d => Object.assign({id: d.id}, d.data()));
      state.patches.sort((a, b) => (a.order || 0) - (b.order || 0));
      applyAllPatches();
      console.log(`[Патчи] Загружено и применено: ${state.patches.length}`);
    } catch(e) { console.warn('[Патчи] Ошибка загрузки:', e); }
  }

  function applyAllPatches() {
    if (!state.patches || !state.patches.length) return;
    let appliedCount = 0, errorCount = 0;
    state.patches.filter(patch=>patch.enabled).forEach(patch => {
      try {
        if (patch.type === 'function') {
          (0, eval)(patch.code);
          appliedCount++;
          console.log(`[Патч ✅] ${patch.name}`);
        } else if (patch.type === 'replace') {
          const fnName = patch.fnName;
          const originalFn = window[fnName];
          if (typeof originalFn !== 'function') { console.warn(`[Патч ⚠️] Функция "${fnName}" не найдена в window`); errorCount++; return; }
          let src = originalFn.toString();
          if (!src.includes(patch.findText)) { console.warn(`[Патч ⚠️] Текст для поиска в "${fnName}" не найден`); errorCount++; return; }
          src = src.replace(patch.findText, patch.replaceText);
          const newFn = (0, eval)('(' + src + ')');
          window[fnName] = newFn;
          appliedCount++;
          console.log(`[Патч ✅] ${patch.name} (замена в ${fnName})`);
        }
      } catch(e) { errorCount++; console.error(`[Патч ❌] Ошибка в "${patch.name}":`, e); showToastEl(`⚠️ Ошибка в патче "${patch.name}": ${e.message}`, true); }
    });
    if (appliedCount > 0) console.log(`[Патчи] Применено ${appliedCount} шт. Ошибок: ${errorCount}`);
  }

  function renderPatchesList() {
    const c = document.getElementById('patchesListContainer');
    if (!c) return;
    if (!state.patches || !state.patches.length) { c.innerHTML = '<div class="empty-state">Нет добавленных патчей</div>'; return; }
    c.innerHTML = state.patches.map(p => {
      const typeLabel = p.type === 'function' ? '🔁 Замена функции' : '🔍 Найти/Заменить';
      const typeColor = p.type === 'function' ? 'var(--success)' : 'var(--warning)';
      const codePreview = p.type === 'function' ? (p.code || '').substring(0, 80).replace(/\n/g, ' ') : `${p.fnName}: "${(p.findText||'').substring(0,30)}..." → "${(p.replaceText||'').substring(0,30)}..."`;
      return `<div class="user-row" style="border-color: ${p.enabled ? 'var(--success)' : 'var(--border)'};"><div class="user-row-top"><div style="font-size: 14px; font-weight: 700;">🔧 ${escapeHtml(p.name)}</div><label class="toggle-switch" style="transform: scale(0.8); margin: 0;"><input type="checkbox" ${p.enabled ? 'checked' : ''} onchange="togglePatchStatus('${p.id}', this.checked)"><span class="toggle-slider"></span></label></div><div style="font-size: 11px; color: ${typeColor}; margin-bottom: 6px;">${typeLabel}</div><div style="font-size: 11px; color: var(--muted); font-family: monospace; background: var(--bg); padding: 6px; border-radius: 4px; margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(codePreview)}</div><div class="user-row-bottom" style="justify-content: flex-end;"><button class="btn-edit" onclick="openPatchModal('${p.id}')">✏️ Редактировать</button><button class="btn-del" onclick="deletePatch('${p.id}')">Удалить</button></div></div>`;
    }).join('');
  }

  function openPatchModal(id) {
    if (!canAdmin()) return;
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
      else { document.getElementById('patchFnName').value = p.fnName || ''; document.getElementById('patchFind').value = p.findText || ''; document.getElementById('patchReplace').value = p.replaceText || ''; }
    }
    document.getElementById('patchModalTitle').textContent = p ? 'Редактировать патч' : 'Новый патч';
    togglePatchType();
    document.getElementById('patchEditModal').classList.add('open');
  }
  function closePatchModal() { document.getElementById('patchEditModal').classList.remove('open'); }
  function togglePatchType() {
    const type = document.getElementById('patchType').value;
    document.getElementById('patchFunctionMode').style.display = type === 'function' ? 'block' : 'none';
    document.getElementById('patchReplaceMode').style.display = type === 'replace' ? 'block' : 'none';
  }
  async function clearPatchField(fieldId) { const el = document.getElementById(fieldId); if (el && (await appConfirm('Очистить поле?'))) el.value = ''; }
  async function pastePatchField(fieldId) {
    const el = document.getElementById(fieldId); if (!el) return;
    try { const text = await navigator.clipboard.readText(); el.value = text; showToastEl('📋 Вставлено', false); }
    catch (err) { showToastEl('⚠️ Браузер заблокировал вставку', true); }
  }
  async function savePatch() {
    if (!canAdmin()) return;
    const id = document.getElementById('editPatchId').value;
    const name = document.getElementById('patchName').value.trim();
    const type = document.getElementById('patchType').value;
    if (!name) { showError('Введите название'); return; }
    let data = { name, type, enabled: true, updatedAt: Date.now(), updatedBy: getUserName() };
    if (type === 'function') {
      const code = document.getElementById('patchCodeFunction').value.trim();
      if (!code) { showError('Введите код функции'); return; }
      data.code = code;
    } else {
      const fnName = document.getElementById('patchFnName').value.trim();
      const findText = document.getElementById('patchFind').value;
      const replaceText = document.getElementById('patchReplace').value;
      if (!fnName) { showError('Введите имя функции'); return; }
      if (!findText) { showError('Введите текст для поиска'); return; }
      data.fnName = fnName; data.findText = findText; data.replaceText = replaceText;
    }
    try {
      if (id) await tfAwait(refs.patches.doc(id).update(data));
      else { data.createdAt = Date.now(); data.createdBy = getUserName(); await tfAwait(refs.patches.add(data)); }
      closePatchModal(); showToastEl('✅ Патч сохранён. Перезагрузка...', false);
      setTimeout(() => location.reload(), 1000);
    } catch(e) { showError(e.message); }
  }
  async function togglePatchStatus(id, enabled) {
    if (!canAdmin()) return;
    try { await tfAwait(refs.patches.doc(id).update({ enabled, updatedAt: Date.now() })); showToastEl('🔄 Перезагрузка...', false); setTimeout(() => location.reload(), 800); }
    catch(e) { showError(e.message); }
  }
  async function deletePatch(id) {
    if (!canAdmin()) return;
    const p = state.patches.find(x => x.id === id);
    if (!p || !(await appConfirm(`Удалить патч "${p.name}"?`))) return;
    try { await tfAwait(refs.patches.doc(id).delete()); showToastEl('🗑 Удалён. Перезагрузка...', false); setTimeout(() => location.reload(), 800); }
    catch(e) { showError(e.message); }
  }

  // === ПРАВА ===
