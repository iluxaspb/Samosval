try { (function(){
  if (window.__patchExportV2) return;
  window.__patchExportV2 = true;

  // === CSS ===
  const oldCss = document.getElementById('patch-export-css');
  if (oldCss) oldCss.remove();

  const css = document.createElement('style');
  css.id = 'patch-export-css';
  css.textContent = `
    #patchExportBtn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      font-size: 11px;
      font-weight: 700;
      background: rgba(59, 130, 246, 0.15);
      border: 1px solid rgba(59, 130, 246, 0.4);
      color: #93c5fd;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 10px;
      -webkit-tap-highlight-color: transparent;
      min-height: 30px;
    }
    #patchExportBtn:active {
      background: rgba(59, 130, 246, 0.3);
      transform: scale(0.97);
    }
    .pe-modal-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    .pe-modal-actions button {
      flex: 1;
      min-height: 44px;
      font-size: 13px;
    }
  `;
  document.head.appendChild(css);

  // === Получить активные патчи ===
  async function getEnabledPatches() {
    try {
      const snap = await refs.patches.where('enabled', '==', true).get();
      const arr = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      arr.sort((a, b) => (a.order || 0) - (b.order || 0));
      return arr;
    } catch (e) {
      console.warn('[patch-export] Firestore read failed', e);
      return (state.patches || []).filter(p => p && p.enabled)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
    }
  }

  function escapeScriptTag(code) {
    return String(code == null ? '' : code).replace(/<\/script/gi, '<\\/script');
  }
  function safeName(s) {
    return String(s == null ? '' : s).replace(/\*\//g, '* /');
  }

  function resetDomClone(clone) {
    const ao = clone.querySelector('#authOverlay');
    if (ao) ao.style.display = 'flex';

    ['#pendingScreen', '#disabledScreen'].forEach(sel => {
      const el = clone.querySelector(sel);
      if (el) el.style.display = 'none';
    });

    ['#mainHeader', '.container', 'nav'].forEach(sel => {
      const el = clone.querySelector(sel);
      if (el) el.style.display = '';
    });

    [
      '#tab-timesheet', '#trucksLineList', '#logsContainer', '#archiveContainer', '#trashContainer',
      '#plugin-tabs-container', '#matrixTableBody', '#matrixTableHeadRow',
      '#gaiTableBody', '#gaiTableHeadRow', '#usersListContainer',
      '#requestsListContainer', '#globalTrucksManageList', '#globalObjectsManageList',
      '#auditLogContainer', '#patchesListContainer', '#pluginsListContainer',
      '#consoleView', '#selectorListContainer', '#existingObjectsList',
      '#changeObjList', '#statusTicker'
    ].forEach(sel => {
      const el = clone.querySelector(sel);
      if (el) el.innerHTML = '';
    });

    const ticker = clone.querySelector('#statusTicker');
    if (ticker) ticker.style.display = 'none';

    clone.querySelectorAll('.dynamic-nav-btn').forEach(el => el.remove());
    clone.querySelectorAll('.tab-content[id^="tab-plugin-"]').forEach(el => el.remove());

    clone.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    clone.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

    const lineTab = clone.querySelector('#tab-line');
    if (lineTab) lineTab.classList.add('active');
    const lineNav = clone.querySelector('#nav-line');
    if (lineNav) lineNav.classList.add('active');

    const userBadge = clone.querySelector('#userBadgeLabel');
    if (userBadge) userBadge.textContent = '👤 Не в сети';
    const syncDot = clone.querySelector('#syncDot');
    if (syncDot) syncDot.className = 'sync-dot init';
    const syncBadge = clone.querySelector('#syncBadge');
    if (syncBadge) syncBadge.classList.remove('show');

    const shiftDate = clone.querySelector('#shiftDate');
    if (shiftDate) shiftDate.textContent = 'Смена не начата';
    const headerObject = clone.querySelector('#headerObject');
    if (headerObject) headerObject.textContent = 'Объект: Не выбран';

    ['#activeLineCount', '#totalTrips', '#totalVolume'].forEach((sel, idx) => {
      const el = clone.querySelector(sel);
      if (el) el.textContent = idx === 0 ? '0 маш.' : (idx === 1 ? '0' : '0 м³');
    });

    clone.querySelectorAll('#patchExportBtn').forEach(el => el.remove());
    clone.querySelectorAll('#patchExportModal').forEach(el => el.remove());
  }

  async function buildBakedHtml() {
    let html;
    let fromFetch = false;

    try {
      const resp = await fetch(location.href, { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      html = await resp.text();
      fromFetch = true;
    } catch (e) {
      console.warn('[patch-export] fetch failed:', e);
      const clone = document.documentElement.cloneNode(true);
      resetDomClone(clone);
      html = '<!DOCTYPE html>\n' + clone.outerHTML;
    }

    if (window.TestPWA) html = await window.TestPWA.inlineHtml(html);

    const patches = await getEnabledPatches();
    let replaceOk = 0, replaceFail = 0;
    const fnPatches = [];

    for (const p of patches) {
      try {
        if (p.type === 'replace') {
          if (!p.findText) { replaceFail++; continue; }
          if (html.indexOf(p.findText) === -1) {
            replaceFail++;
            console.warn('[patch-export] not found:', p.name);
            continue;
          }
          html = html.replace(p.findText, p.replaceText || '');
          replaceOk++;
        } else if (p.type === 'function') {
          if (!p.code) continue;
          fnPatches.push({ name: p.name || 'без имени', code: p.code });
        }
      } catch (e) {
        console.warn('[patch-export] patch error:', p.name, e);
      }
    }

    if (fnPatches.length) {
      const bakedCode = fnPatches.map(fp => {
        const n = safeName(fp.name);
        const safeCode = escapeScriptTag(fp.code);
        return `/* ===== PATCH: ${n} ===== */\n` +
               `try { (0, eval)(${JSON.stringify(safeCode)}); }\n` +
               `catch (e) { console.error('[baked patch: ${n}]', e); }`;
      }).join('\n\n');

      const bakedBlock =
        '\n<!-- === BAKED PATCHES START === -->\n' +
        '<script>\n' + bakedCode + '\n<\/script>\n' +
        '<!-- === BAKED PATCHES END === -->\n';

      html = html.replace(
        /<!-- === BAKED PATCHES START === -->[\s\S]*?<!-- === BAKED PATCHES END === -->/g,
        ''
      );

      const idx = html.lastIndexOf('</body>');
      if (idx === -1) html += bakedBlock;
      else html = html.slice(0, idx) + bakedBlock + html.slice(idx);
    }

    return { html, replaceOk, replaceFail, fnCount: fnPatches.length, fromFetch };
  }

  function downloadHtml(html, filename) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  }

  function timestamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' + pad(d.getHours()) + '-' + pad(d.getMinutes());
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      console.warn('[patch-export] clipboard failed:', e);
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) return true;
    } catch (e) {
      console.warn('[patch-export] execCommand failed:', e);
    }
    showCopyFallback(text);
    return false;
  }

  function showCopyFallback(text) {
    const old = document.getElementById('copyFallbackModal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'copyFallbackModal';
    overlay.className = 'modal open';
    overlay.style.zIndex = '10025';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '720px';
    content.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="font-size:16px;">📋 Скопируйте вручную</h3>
        <button class="btn-del" onclick="document.getElementById('copyFallbackModal').remove()">✕</button>
      </div>
      <div style="font-size:12px; color:var(--muted); margin-bottom:8px; line-height:1.4;">
        Браузер не дал доступ к буферу обмена. Выделите весь код ниже и скопируйте
        (Ctrl+A → Ctrl+C на компьютере, или долгое нажатие → «Выделить всё» → «Копировать»).
      </div>
      <textarea id="copyFallbackTextarea" class="form-control" style="min-height:300px; font-family:monospace; font-size:11px;"></textarea>
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="btn btn-secondary" style="flex:1;" onclick="document.getElementById('copyFallbackModal').remove()">Закрыть</button>
        <button class="btn btn-quick" style="flex:1;" id="copyFallbackSelectBtn">📋 Выделить всё</button>
      </div>
    `;
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const ta = content.querySelector('#copyFallbackTextarea');
    ta.value = text;
    setTimeout(() => { ta.focus(); ta.select(); }, 100);

    content.querySelector('#copyFallbackSelectBtn').onclick = () => {
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); } catch(e) {}
    };
  }

  // === Модалка ===
  function openExportModal() {
    const old = document.getElementById('patchExportModal');
    if (old) old.remove();

    const all = state.patches || [];
    const enabled = all.filter(p => p && p.enabled);
    const r = enabled.filter(p => p.type === 'replace').length;
    const f = enabled.filter(p => p.type === 'function').length;

    const overlay = document.createElement('div');
    overlay.id = 'patchExportModal';
    overlay.className = 'modal open';
    overlay.style.zIndex = '10020';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '480px';
    content.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="font-size:16px;">💾 Экспорт index.html</h3>
        <button class="btn-del" onclick="document.getElementById('patchExportModal').remove()">✕</button>
      </div>

      <div style="font-size:12px; color:var(--muted); line-height:1.5; margin-bottom:12px;">
        Соберёт HTML-файл, в котором <b style="color:var(--text);">уже применены все активные патчи</b>.
        Загрузите его на сервер — после этого патчи можно удалить из базы.
      </div>

      <div style="background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 12px; margin-bottom: 12px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
          <span style="color:var(--muted);">Активных патчей:</span>
          <b>${enabled.length}</b>
        </div>
        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
          <span style="color:var(--muted);">Replace (найти/заменить):</span>
          <b style="color:var(--warning);">${r}</b>
        </div>
        <div style="display:flex; justify-content:space-between;">
          <span style="color:var(--muted);">Function (вшить в код):</span>
          <b style="color:var(--success);">${f}</b>
        </div>
      </div>

      <div class="pe-modal-actions">
        <button class="btn btn-secondary" id="peDownloadBtn">⬇️ Скачать</button>
        <button class="btn btn-quick" id="peCopyBtn">📋 Копировать</button>
      </div>

      <div style="font-size:10px; color:var(--muted); text-align:center; margin-top:10px; line-height:1.4;">
        ⚠️ После загрузки на сервер удалите или отключите все патчи в админке — они уже вшиты в файл.
      </div>
    `;
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    content.querySelector('#peDownloadBtn').onclick = async () => {
      const btn = content.querySelector('#peDownloadBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Сборка...';
      try {
        const res = await buildBakedHtml();
        const filename = 'index_baked_' + timestamp() + '.html';
        downloadHtml(res.html, filename);
        overlay.remove();
        if (typeof showToastEl === 'function') {
          showToastEl(
            '✅ ' + filename + '<br>' +
            'replace: ' + res.replaceOk + (res.replaceFail ? ' · не найдено: ' + res.replaceFail : '') + '<br>' +
            'функций вшито: ' + res.fnCount,
            false
          );
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '⬇️ Скачать';
        if (typeof showError === 'function') showError('Ошибка сборки: ' + e.message);
      }
    };

    content.querySelector('#peCopyBtn').onclick = async () => {
      const btn = content.querySelector('#peCopyBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Сборка...';
      try {
        const res = await buildBakedHtml();
        const ok = await copyToClipboard(res.html);
        if (ok) {
          overlay.remove();
          if (typeof showToastEl === 'function') {
            showToastEl(
              '📋 Скопировано в буфер<br>' +
              'replace: ' + res.replaceOk + (res.replaceFail ? ' · не найдено: ' + res.replaceFail : '') + '<br>' +
              'функций вшито: ' + res.fnCount,
              false
            );
          }
        } else {
          btn.disabled = false;
          btn.textContent = '📋 Копировать';
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '📋 Копировать';
        if (typeof showError === 'function') showError('Ошибка сборки: ' + e.message);
      }
    };
  }

  // === Маленькая кнопка ===
  function addExportButton() {
    const section = document.getElementById('admin-sub-patches');
    if (!section) return;
    if (document.getElementById('patchExportBtn')) return;

    const list = document.getElementById('patchesListContainer');
    if (!list || !list.parentNode) return;

    const btn = document.createElement('button');
    btn.id = 'patchExportBtn';
    btn.innerHTML = '💾 Экспорт HTML';
    btn.onclick = openExportModal;

    list.parentNode.insertBefore(btn, list);
  }

  // === Перехват switchAdminTab ===
  const origSwitch = window.switchAdminTab;
  window.switchAdminTab = function(tab, btn) {
    if (origSwitch) origSwitch.apply(this, arguments);
    if (tab === 'patches') {
      setTimeout(addExportButton, 50);
    }
  };

  // === MutationObserver ===
  const obs = new MutationObserver(() => {
    if (document.getElementById('admin-sub-patches')?.classList.contains('active')) {
      if (!document.getElementById('patchExportBtn')) addExportButton();
    }
  });
  setTimeout(() => {
    const list = document.getElementById('patchesListContainer');
    if (list) obs.observe(list, { childList: true, subtree: true });
  }, 500);

  // === Интервал-страховка ===
  setInterval(() => {
    if (document.getElementById('admin-sub-patches')?.classList.contains('active')) {
      if (!document.getElementById('patchExportBtn')) addExportButton();
    }
  }, 1500);

  // === Первый запуск ===
  setTimeout(() => {
    if (document.getElementById('admin-sub-patches')?.classList.contains('active')) addExportButton();
  }, 800);

  console.log('[patch-export-v2] ✅ Активен. Компактная кнопка → модалка.');
})();; }
catch (e) { console.error('[baked patch: Скачать нтмл]', e); }
