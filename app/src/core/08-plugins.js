  // === ПЛАГИНЫ ===
  function initPlugins() {
    document.getElementById('plugin-tabs-container').innerHTML = '';
    document.querySelectorAll('.dynamic-nav-btn').forEach(el => el.remove());
    pluginTabs = {}; pluginPdfButtons = [];
    const enabled = state.plugins.filter(p => { if (!p.enabled) return false; if (!p.allowedRoles || p.allowedRoles.length === 0) return true; return p.allowedRoles.includes(currentUserRole); });
    enabled.forEach(p => {
      try {
        const ctx = {
          db: db, refs: refs, state: state, user: { email: currentEmail, role: currentUserRole, name: getUserName() },
          showToast: showToastEl, addAudit: addAudit, escapeHtml: escapeHtml, renderRussianPlate: renderRussianPlate,
          registerTab: (id, name, icon, renderFn) => {
            const tabId = 'plugin-' + id;
            const btn = document.createElement('button');
            btn.className = 'nav-btn dynamic-nav-btn'; btn.id = 'nav-' + tabId;
            btn.innerHTML = `<span class="nav-icon">${icon}</span><span class="nav-text">${name}</span>`;
            btn.onclick = () => switchTab(tabId, btn);
            const nav = document.getElementById('bottomNav'); const archiveBtn = document.getElementById('nav-archive');
            nav.insertBefore(btn, archiveBtn);
            const tabDiv = document.createElement('div'); tabDiv.className = 'tab-content'; tabDiv.id = 'tab-' + tabId;
            document.getElementById('plugin-tabs-container').appendChild(tabDiv);
            pluginTabs[tabId] = { render: renderFn, container: tabDiv };
          },
          registerPdfButton: (label, generateHtmlFn) => { pluginPdfButtons.push({ label, generateHtmlFn }); }
        };
        const run = new Function('ctx', p.code); run(ctx);
      } catch (e) { console.error(`Ошибка в плагине "${p.name}":`, e); showToastEl(`⚠️ Ошибка в "${p.name}": ${e.message}`, true); }
    });
    renderPluginPdfButtons();
  }
  function renderPluginPdfButtons() {
    const c = document.getElementById('pluginPdfButtonsContainer'); if (!c) return;
    c.innerHTML = '';
    pluginPdfButtons.forEach((p, idx) => {
      const btn = document.createElement('button'); btn.className = 'btn btn-secondary btn-small'; btn.style.flex = '1';
      btn.innerHTML = `📄 ${p.label}`;
      btn.onclick = async () => {
        try { showToastEl('⏳ Генерация PDF...', false); const html = p.generateHtmlFn(); const blob = await generatePDFFromHTML(html, `plugin_${idx}.pdf`); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `plugin_${idx}_${Date.now()}.pdf`; a.click(); URL.revokeObjectURL(url); showToastEl('✅ PDF готов', false); }
        catch(e) { showError('Ошибка PDF: ' + e.message); }
      };
      c.appendChild(btn);
    });
  }
  function renderPluginsList() {
    const c = document.getElementById('pluginsListContainer'); if (!c) return;
    if (!state.plugins.length) { c.innerHTML = '<div class="empty-state">Нет добавленных расширений</div>'; return; }
    c.innerHTML = state.plugins.map(p => {
      let rolesText = (p.allowedRoles || []).map(r => ROLES[r]?.label || r).join(', ') || 'Все роли';
      return `<div class="user-row" style="border-color: ${p.enabled ? 'var(--success)' : 'var(--border)'};"><div class="user-row-top"><div style="font-size: 16px; font-weight: bold;">${escapeHtml(p.icon || '🧩')} ${escapeHtml(p.name)}</div><label class="toggle-switch" style="transform: scale(0.8); margin: 0;"><input type="checkbox" ${p.enabled ? 'checked' : ''} onchange="togglePluginStatus('${p.id}', this.checked)"><span class="toggle-slider"></span></label></div><div style="font-size: 11px; color: var(--muted); margin-bottom: 8px;">Доступ: ${rolesText}</div><div class="user-row-bottom" style="justify-content: flex-end;"><button class="btn-edit" onclick="openPluginModal('${p.id}')">✏️ Код</button><button class="btn-del" onclick="deletePlugin('${p.id}')">Удалить</button></div></div>`;
    }).join('');
  }
  function openPluginModal(id) {
    if (!canAdmin()) return;
    const p = id ? state.plugins.find(x => x.id === id) : null;
    document.getElementById('editPluginId').value = id || '';
    document.getElementById('pluginName').value = p ? p.name : '';
    document.getElementById('pluginIcon').value = p ? p.icon : '🧩';
    document.getElementById('pluginCode').value = p ? p.code : `// Пример кода плагина\nctx.registerTab('my-tab', 'Моя вкладка', '📌', (container) => {\n  container.innerHTML = '<h2>Привет!</h2>';\n});`;
    document.getElementById('pluginModalTitle').textContent = p ? 'Редактировать расширение' : 'Новое расширение';
    const roleCheckboxes = document.querySelectorAll('#pluginRolesContainer input[type="checkbox"]');
    roleCheckboxes.forEach(chk => { if (p) chk.checked = (p.allowedRoles || []).includes(chk.value); else chk.checked = true; });
    document.getElementById('pluginEditModal').classList.add('open');
  }
  function closePluginModal() { document.getElementById('pluginEditModal').classList.remove('open'); }
  async function clearPluginCode() { const textarea = document.getElementById('pluginCode'); if (textarea && (await appConfirm('Очистить окно с кодом?'))) textarea.value = ''; }
  async function pastePluginCode() {
    const textarea = document.getElementById('pluginCode'); if (!textarea) return;
    try { const text = await navigator.clipboard.readText(); textarea.value = text; showToastEl('📋 Код вставлен', false); }
    catch (err) { showToastEl('⚠️ Браузер заблокировал вставку', true); }
  }
  async function savePlugin() {
    if (!canAdmin()) return;
    const id = document.getElementById('editPluginId').value;
    const name = document.getElementById('pluginName').value.trim();
    const icon = document.getElementById('pluginIcon').value.trim() || '🧩';
    const code = document.getElementById('pluginCode').value;
    const allowedRoles = Array.from(document.querySelectorAll('#pluginRolesContainer input:checked')).map(chk => chk.value);
    if (!name) { showError('Введите название'); return; }
    try { if (id) await tfAwait(refs.plugins.doc(id).update({ name, icon, code, allowedRoles })); else await tfAwait(refs.plugins.add({ name, icon, code, allowedRoles, enabled: true, createdAt: Date.now() })); closePluginModal(); showToastEl('✅ Расширение сохранено', false); }
    catch(e) { showError(e.message); }
  }
  async function togglePluginStatus(id, enabled) { if (!canAdmin()) return; try { await tfAwait(refs.plugins.doc(id).update({ enabled })); } catch(e) { showError(e.message); } }
  async function deletePlugin(id) { if (!canAdmin() || !(await appConfirm('Удалить расширение?'))) return; try { await tfAwait(refs.plugins.doc(id).delete()); } catch(e) { showError(e.message); } }

