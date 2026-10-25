  // ==========================================
  // ВСТРОЕННАЯ КОНСОЛЬ ОТЛАДКИ
  // ==========================================
  const appConsoleLogs = [];
  const APP_CONSOLE_MAX = 500;
  let consoleFilterMode = 'all';
  const _origConsoleLog = console.log.bind(console);
  const _origConsoleWarn = console.warn.bind(console);
  const _origConsoleError = console.error.bind(console);
  const _origConsoleInfo = console.info.bind(console);

  function _addConsoleEntry(type, args) {
    try {
      const text = args.map(a => {
        if (a instanceof Error) return a.message + (a.stack ? '\n' + a.stack.split('\n').slice(1,3).join(' ') : '');
        if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch(e) { return String(a); } }
        return String(a);
      }).join(' ');
      appConsoleLogs.push({ type, text, ts: Date.now() });
      while (appConsoleLogs.length > APP_CONSOLE_MAX) appConsoleLogs.shift();
      renderConsoleIfActive();
    } catch(e) {}
  }

  console.log = function(...args) { _addConsoleEntry('log', args); _origConsoleLog.apply(console, args); };
  console.warn = function(...args) { _addConsoleEntry('warn', args); _origConsoleWarn.apply(console, args); };
  console.error = function(...args) { _addConsoleEntry('error', args); _origConsoleError.apply(console, args); };
  console.info = function(...args) { _addConsoleEntry('info', args); _origConsoleInfo.apply(console, args); };

  window.addEventListener('error', (e) => { _addConsoleEntry('error', ['[Uncaught] ' + (e.message||'') + ' — ' + (e.filename||'').split('/').pop() + ':' + (e.lineno||'')]); });
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; _addConsoleEntry('error', ['[Promise rejection] ' + (r?.message || r || 'unknown')]); });

  function renderConsoleIfActive() {
    const tabAdmin = document.getElementById('tab-admin');
    if (!tabAdmin || !tabAdmin.classList.contains('active')) return;
    const sec = document.getElementById('admin-sub-console');
    if (!sec || !sec.classList.contains('active')) return;
    renderConsole();
  }

  function renderConsole() {
    const view = document.getElementById('consoleView');
    if (!view) return;
    const filtered = consoleFilterMode === 'all' ? appConsoleLogs : appConsoleLogs.filter(l => l.type === consoleFilterMode);
    if (!filtered.length) { view.innerHTML = '<div style="color:#475569; text-align:center; padding:20px; font-family:sans-serif;">Пусто</div>'; return; }
    view.innerHTML = filtered.slice(-500).map(l => {
      const color = l.type === 'error' ? '#f87171' : l.type === 'warn' ? '#fbbf24' : l.type === 'info' ? '#60a5fa' : '#94a3b8';
      const icon = l.type === 'error' ? '❌' : l.type === 'warn' ? '⚠️' : l.type === 'info' ? 'ℹ️' : '›';
      const time = new Date(l.ts).toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const safeText = String(l.text).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
      return `<div style="color:${color}; border-bottom:1px solid #1e293b; padding:5px 0; word-break:break-all; user-select:text; font-family:'Courier New',monospace;"><span style="color:#475569; font-size:9px;">${time}</span> ${icon} ${safeText}</div>`;
    }).join('');
    requestAnimationFrame(() => { view.scrollTop = view.scrollHeight; });
  }

  function consoleClear() { appConsoleLogs.length = 0; renderConsole(); if (typeof showToastEl === 'function') showToastEl('🗑 Консоль очищена', false); }
  async function consoleCopy() {
    const filtered = consoleFilterMode === 'all' ? appConsoleLogs : appConsoleLogs.filter(l => l.type === consoleFilterMode);
    if (!filtered.length) { if (typeof showToastEl === 'function') showToastEl('Нечего копировать', true); return; }
    const text = filtered.map(l => { const time = new Date(l.ts).toLocaleTimeString('ru-RU'); return `[${time}] [${l.type.toUpperCase()}] ${l.text}`; }).join('\n');
    try { await navigator.clipboard.writeText(text); if (typeof showToastEl === 'function') showToastEl('📋 Скопировано в буфер', false); }
    catch(e) { if (typeof showToastEl === 'function') showToastEl('⚠️ Браузер заблокировал копирование', true); }
  }
  function consoleFilter(mode) {
    consoleFilterMode = mode;
    document.querySelectorAll('[data-console-filter]').forEach(b => {
      if (b.dataset.consoleFilter === mode) { b.classList.add('btn-quick'); b.classList.remove('btn-secondary'); }
      else { b.classList.remove('btn-quick'); b.classList.add('btn-secondary'); }
    });
    renderConsole();
  }

