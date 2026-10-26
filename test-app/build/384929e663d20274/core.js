
  const firebaseConfig = {
    apiKey: "AIzaSyDRy40gguXaHudGI_6Mn55tb7nxtuOGLTI",
    authDomain: "samosval-offline.firebaseapp.com",
    projectId: "samosval-offline",
    messagingSenderId: "211416746528",
    appId: "1:211416746528:web:e6f0519bd8ad779895ca45"
  };

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

  const FORCED_ADMIN_EMAIL = 'iluxaspb@gmail.com';
  const GAI_PDF_DELAY_MS = 60000;

  const ROLES = {
    admin: { label: 'Администратор', icon: '👑', color: 'admin' },
    foreman: { label: 'Прораб', icon: '🔧', color: 'foreman' },
    master: { label: 'Мастер', icon: '🛠', color: 'master' },
    lopater: { label: 'Лопатер', icon: '🪏', color: 'lopater' },
    viewer: { label: 'Наблюдатель', icon: '👁', color: 'viewer' }
  };

  const ALL_TABS = ['timesheet', 'line', 'report', 'archive', 'trucks', 'analytics', 'backup', 'admin'];
  const TAB_LABELS = { timesheet: 'Табель', line: 'Линия', report: 'Сводка', archive: 'Архив', trucks: 'База', analytics: 'Аналитика', backup: 'Резерв', admin: 'Админ' };

  const ALL_ACTIONS = [
    'timesheet_edit', 'timesheet_manage', 'timesheet_export',
    'start_shift', 'close_shift', 'edit_line', 'action_arrive', 'action_load', 'action_ttn', 'undo_action',
    'edit_logs', 'manage_trucks', 'manage_objects', 'archive_edit', 'archive_delete', 'import_backup',
    'view_card_stats', 'view_header', 'undo_any', 'view_gai_report', 'view_reis_in_ticker'
  ];
  const ACTION_LABELS = {
    timesheet_edit: 'Табель: часы и материалы', timesheet_manage: 'Табель: справочники и экипажи', timesheet_export: 'Табель: выгрузка CSV',
    start_shift: 'Начать смену', close_shift: 'Закрыть смену', edit_line: 'Изменять линию',
    action_arrive: 'Кнопка «Приехал»', action_load: 'Кнопка «Погрузка»', action_ttn: 'Кнопка «ТТН»',
    undo_action: 'Отменять СВОИ действия', undo_any: 'Отменять действия ЛЮБОГО пользователя',
    edit_logs: 'Редактировать рейсы', manage_trucks: 'Управлять базой самосвалов', manage_objects: 'Управлять базой объектов',
    archive_edit: 'Редактировать архив', archive_delete: 'Удалять из архива', import_backup: 'Импорт бэкапа',
    view_card_stats: 'Показывать рейсы/объем на карточках', view_header: 'Показывать верхнюю панель (шапку)',
    view_gai_report: 'Показывать отчет ГАИ', view_reis_in_ticker: 'Показывать № рейса в статус-баре'
  };

  ALL_ACTIONS.push('history_view','history_undo_own','history_undo_any','history_redo_own','history_redo_any');
  Object.assign(ACTION_LABELS,{"history_view": "Открывать журнал отмены и восстановления", "history_undo_own": "Отменять свои действия в журнале", "history_undo_any": "Отменять любые действия в журнале", "history_redo_own": "Восстанавливать свои действия в журнале", "history_redo_any": "Восстанавливать любые действия в журнале"});
  const DEFAULT_PERMISSIONS = {
    foreman: { tabs: ['line', 'report', 'archive', 'trucks', 'analytics', 'backup'], actions: ['start_shift', 'close_shift', 'edit_line', 'action_arrive', 'action_load', 'action_ttn', 'undo_action', 'undo_any', 'edit_logs', 'manage_trucks', 'manage_objects', 'archive_edit', 'archive_delete', 'view_card_stats', 'view_header', 'view_gai_report', 'view_reis_in_ticker'] },
    master: { tabs: ['line', 'report', 'archive', 'analytics'], actions: ['start_shift', 'edit_line', 'action_arrive', 'action_load', 'action_ttn', 'undo_action', 'view_card_stats', 'view_header', 'view_gai_report', 'view_reis_in_ticker'] },
    lopater: { tabs: ['line', 'report'], actions: ['action_arrive', 'action_load', 'undo_action', 'view_card_stats', 'view_header'] },
    viewer: { tabs: ['line', 'report', 'archive', 'analytics'], actions: ['view_card_stats', 'view_header', 'view_gai_report', 'view_reis_in_ticker'] }
  };

  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  // Legacy versions stored passwords in localStorage. Remove these credentials.
  try { localStorage.removeItem('dt_saved_pass'); } catch (e) { console.warn('Не удалось очистить старый пароль', e); }
  const db = firebase.firestore();
  let secondaryApp;
  try { secondaryApp = firebase.initializeApp(firebaseConfig, 'Secondary'); } catch (e) { secondaryApp = firebase.app('Secondary'); }
  try { db.settings({ experimentalForceLongPolling: true }); } catch (e) {}
  window.TestStorageState = {persistent:false,error:null};
  try { db.enablePersistence({ synchronizeTabs: true }).then(() => { window.TestStorageState.persistent=true; }).catch(error => { window.TestStorageState.error=error.code||error.message; console.warn('[offline storage]',error); }); } catch (error) { window.TestStorageState.error=error.message; }

  // Тестовый стенд: отдельный Firebase-проект, не производственная база.
  const TEST_FIREBASE_PROJECT_ID = 'samosval-offline';
  if (firebase.app().options.projectId !== TEST_FIREBASE_PROJECT_ID) {
    throw new Error('Защита тестового стенда: подключён неверный Firebase-проект');
  }
  const WORKSPACE_ID = 'main_workspace';
  const wsRef = db.collection('workspaces').doc(WORKSPACE_ID);
  const refs = {
    trucks: wsRef.collection('trucks'), objects: wsRef.collection('objects'), logs: wsRef.collection('logs'),
    truckStatus: wsRef.collection('truckStatus'), shift: wsRef.collection('shift').doc('current'),
    archive: wsRef.collection('archive'), trash: wsRef.collection('trash'), audit: wsRef.collection('audit'),
    notifications: wsRef.collection('notifications'), plugins: wsRef.collection('plugins'),
    patches: wsRef.collection('patches')
  };
  const usersRef = db.collection('users');
  const permsRef = db.collection('settings').doc('permissions');
  const requestsRef = db.collection('registration_requests');
  const appConfigRef = db.collection('settings').doc('appConfig');

  const TRASH_DAYS = 30;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const MIN_CYCLE_MINUTES = 15;

  let settings = Object.assign({ hapticArrive: true, hapticLoad: true, hapticTtn: true, cycleMinutes: MIN_CYCLE_MINUTES, holdLoad: 0.5, holdArrive: 0.5, holdTtn: 0.5 }, JSON.parse(localStorage.getItem('dt_settings') || '{}'));

  let state = { trucks: [], objects: [], logs: [], truckStatus: {}, shift: null, archive: [], trash: [], audit: [], notifications: [], users: [], requests: [], plugins: [], patches: [] };
  let permissionsConfig = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
  let appConfig = { maxEnabled: false, maxUrl: '', maxToken: '', maxChatId: '', notifyStart: true, notifyArrive: true, notifyLoad: true, notifyTtn: true, notifyLineStart: true, notifyLineEnd: true, notifyPdfMain: true, notifyPdfGai: true };

  let unsubscribers = [];
  let currentEmail = '';
  let currentUid = '';
  let currentUserRole = null;
  let currentUserStatus = null;
  let activeProfileKey = '';
  let permissionsLoaded = false; // === SECURITY: флаг готовности прав ===
  let currentUserNickname = '';
  let initialized = false;
  let viewingArchiveId = null;
  let viewingArchiveGAITable = false;
  let editingLogId = null;
  let toastTimer1 = null, toastTimer2 = null;
  let touchStartY = 0, touchStartX = 0, isScrolling = false;
  let pendingOps = 0;
  let loadInFlight = {};
  let renderLinePending = false;
  let usersUnsubscriber = null;
  let reqsUnsubscriber = null;
  let userDocUnsubscriber = null;
  let showGAITable = false;
  let confirmedLoadIds = new Set();
  function validTickerNotification(item) {
    if (!item) return false;
    if (item.type !== 'load') return true;
    return !!item.logId && confirmedLoadIds.has(item.logId)
      && state.logs.some(log => log.id === item.logId
        && (!state.shift || log.shiftId === state.shift.id));
  }
  function lastValidNotification() {
    return (state.notifications || []).find(validTickerNotification) || null;
  }
  let lastTickerId = null;
  let lastTickerTs = 0;
  let pluginTabs = {};
  let pluginPdfButtons = [];
  let drawMode = false;

  function pendingStart() { pendingOps++; updateSyncUI(); }
  function pendingEnd() { pendingOps = Math.max(0, pendingOps - 1); updateSyncUI(); }
  function tf(p) { pendingStart(); p.then(() => pendingEnd()).catch(e => { console.warn(e); pendingEnd(); }); }
  async function tfAwait(p) { pendingStart(); try { return await p; } finally { pendingEnd(); } }
  let syncState = { fromCache: {}, everConnected: {}, docCount: {}, pendingWrites: {}, lastSuccessAt: 0 };

  // === СИСТЕМА ПАТЧЕЙ ===
  function renderConflictAuthorPatch(){
    const input=document.getElementById('conflictAuthorPatch');
    if(input)input.checked=appConfig.testReviewFlags?.conflict_author!==false;
  }
  async function setConflictAuthorPatch(enabled){
    if(!canAdmin()){renderConflictAuthorPatch();return;}
    const input=document.getElementById('conflictAuthorPatch');
    if(input)input.disabled=true;
    try{
      await appConfigRef.set({testReviewFlags:{conflict_author:!!enabled}},{merge:true});
      appConfig.testReviewFlags={...appConfig.testReviewFlags,conflict_author:!!enabled};
      showToastEl(enabled?'Уведомления с автором включены':'Вернулись общие уведомления',false);
    }catch(e){showError('Настройка не сохранена: '+(e.message||e));}
    finally{if(input)input.disabled=false;renderConflictAuthorPatch();}
  }
  async function loadAndApplyPatches() {
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
    state.patches.forEach(patch => {
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
  function isForcedAdminEmail(email) { return String(email || '').toLowerCase() === FORCED_ADMIN_EMAIL; }
  function canAdmin() { return currentUserStatus === 'active' && currentUserRole === 'admin'; }

  // === SECURITY: пока permissionsLoaded === false, разрешаем только 'line' (и админа) ===
  function hasTabAccess(tabName) {
    if(currentUserStatus!=='active')return false;
    if (currentUserRole === 'admin') return true;
    if (!permissionsLoaded) return tabName === 'line';
    if (!permissionsConfig[currentUserRole]) return false;
    return Array.isArray(permissionsConfig[currentUserRole].tabs) && permissionsConfig[currentUserRole].tabs.includes(tabName);
  }

  function hasPermission(action) { if(currentUserStatus!=='active')return false; if (currentUserRole === 'admin') return true; if (!permissionsLoaded) return false; const actions = permissionsConfig[currentUserRole]?.actions; return Array.isArray(actions) && actions.includes(action); }
  function requireEdit(action, actionName) { if (hasPermission(action)) return true; showError('👁 Нет прав на ' + (actionName || 'это действие')); return false; }

  // === SECURITY: обновляем классы perm-blocked для кнопок ===
  function updateNavUI() {
    ALL_TABS.forEach(tab => {
      const btn = document.getElementById('nav-' + tab);
      if (btn) {
        const allowed = tab === 'admin' ? canAdmin() : hasTabAccess(tab);
        btn.style.display = allowed ? '' : 'none';
        if (allowed) btn.classList.remove('perm-blocked');
        else btn.classList.add('perm-blocked');
      }
    });
  }

  // === УТИЛИТЫ ===
  function sanitizeName(name) { if (!name) return ''; let s = String(name).trim(); let at = s.indexOf('@'); if (at > 0) s = s.substring(0, at); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
  function getUserName() { return currentUserNickname || sanitizeName(currentEmail) || '—'; }
  function resolveUserDisplayName(email, fallbackNick) {
    const clean=value=>String(value||'').trim(),normal=value=>clean(value).toLowerCase();
    const identity=normal(email);
    if(identity&&identity===normal(currentEmail)&&clean(currentUserNickname))return clean(currentUserNickname);
    const user=identity?(state.users||[]).find(u=>normal(u.email)===identity):null;
    if(clean(user?.nickname))return clean(user.nickname);
    const fallback=clean(fallbackNick);
    if(fallback&&fallback!=='—'&&(!identity||normal(fallback)!==identity))return fallback;
    return sanitizeName(email||fallback)||'—';
  }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function nowTimeStr() { return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
  function nowDateStr() { return new Date().toLocaleDateString('ru-RU'); }
  function formatIdleDuration(ms) { if (ms < 0) ms = 0; let s = Math.floor(ms/1000), h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60; return h > 0 ? h + ':' + pad2(m) + ':' + pad2(sec) : pad2(m) + ':' + pad2(sec); }
  function formatLoadAge(timestamp) {
    const seconds=Math.max(0,Math.floor((Date.now()-Number(timestamp))/1000));
    if(!Number(timestamp)||!Number.isFinite(seconds))return 'ещё не было';
    if(seconds<60)return 'только что';
    const minutes=Math.floor(seconds/60);
    if(minutes<60)return minutes+' мин назад';
    const hours=Math.floor(minutes/60),rest=minutes%60;
    if(hours<24)return hours+' ч'+(rest?' '+rest+' мин':'')+' назад';
    const days=Math.floor(hours/24),remaining=hours%24;
    return days+' д'+(remaining?' '+remaining+' ч':'')+' назад';
  }
  function formatTimeAgo(ts) { if (!ts) return '—'; let diff = Date.now() - ts; if (diff < 0) diff = 0; let s = Math.floor(diff/1000); if (s < 10) return 'только что'; if (s < 60) return s + ' сек. назад'; let m = Math.floor(s/60); if (m < 60) return m + ' мин. назад'; let h = Math.floor(m/60), mm = m%60; if (h < 24) return mm === 0 ? (h + ' ч. назад') : (h + ' ч. ' + mm + ' мин. назад'); return Math.floor(h/24) + ' дн. назад'; }
  function daysLeft(deletedAt) { let remain = (TRASH_DAYS * MS_PER_DAY) - (Date.now() - (deletedAt || 0)); return Math.max(0, Math.ceil(remain / MS_PER_DAY)); }
  function vibrate(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch(e){} }
  function vibArrive() { if (settings.hapticArrive) vibrate(12); }
  function vibLoad() { if (settings.hapticLoad) vibrate([15,30,15]); }
  function vibTtn() { if (settings.hapticTtn) vibrate(25); }

  function renderRussianPlate(numberStr) {
    let clean = String(numberStr == null ? '' : numberStr).replace(/\s+/g, '').trim();
    let m = clean.match(/^([а-яёa-z]{1})(\d{3})([а-яёa-z]{2})(\d{2,3})$/i);
    if (m) return `<div class="ru-plate"><div class="ru-plate-main"><span>${escapeHtml(m[1].toLowerCase())}</span><span class="plate-digit">${escapeHtml(m[2])}</span><span>${escapeHtml(m[3].toLowerCase())}</span></div><div class="ru-plate-region"><span class="region-code">${escapeHtml(m[4])}</span><span class="region-rus">RUS</span><div class="ru-plate-flag"><span></span><span></span><span></span></div></div></div>`;
    let formatted = escapeHtml(clean).replace(/\d+/g, d => `<span class="plate-digit">${d}</span>`);
    return `<div class="ru-plate"><div class="ru-plate-main">${formatted}</div></div>`;
  }
  function findTruck(id) { return state.trucks.find(t => t.id === id); }
  function truckLabelHtml(id, fallbackName) {
    let t = findTruck(id);
    if (!t) return fallbackName ? `<b>${escapeHtml(String(fallbackName).split(' ')[0])}</b> ${renderRussianPlate(String(fallbackName).split(' ').slice(1).join(' '))}` : '<b>Машина</b>';
    return `<b>${escapeHtml(t.brand)}</b> ${renderRussianPlate(t.number)}`;
  }
  function truckName(id) { let t = findTruck(id); return t ? `${t.brand} ${t.number}` : 'Машина'; }
  function getActiveLineIds() { return Object.keys(state.truckStatus).filter(id => state.truckStatus[id] && state.truckStatus[id].onLine === true); }
  // Reports, paper sheets, header totals and PDF must all see the same LOCAL
  // pending trips, even if an older Firestore cache snapshot arrives meanwhile.
  function getLogs() {
    const shiftId=state.shift?.id;
    if(!shiftId)return [];
    const logs=state.logs.filter(l=>l.shiftId===shiftId);
    const ids=new Set(logs.map(l=>l.id));
    for(const op of offlinePendingOps()){
      if(op.type!=='load'||op.shiftId!==shiftId)continue;
      if(ids.has('pending_'+op.id)||ids.has(op.logId))continue;
      const ts=Math.max(Number(op.createdAt)||0,Number(op.arrivalTimestamp||0)+1,Number(op.lastLoadTimestamp||0)+1);
      const log={id:'pending_'+op.id,offlinePending:true,offlineOperationId:op.id,
        shiftId,truckId:op.truckId,truckName:op.truckName||truckName(op.truckId),
        volume:Number(op.volume)||0,isGAI:!!op.isGAI,
        timeStr:new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),
        timestamp:ts,arrivalTimestamp:op.arrivalTimestamp||null,createdBy:op.actor,
        createdByEmail:op.email||'',comment:''};
      logs.push(log);ids.add(log.id);
    }
    return logs.sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
  }

  function sessionCacheKey() { return 'dt_cache_v14:' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + location.pathname + ':' + (currentUid || 'signed-out'); }
  function saveCache() { try { localStorage.setItem(sessionCacheKey(), JSON.stringify({ trucks: state.trucks, objects: state.objects, logs: offlinePendingCount()?offlineRemoteLogs:state.logs, truckStatus: offlinePendingCount()?offlineRemoteStatuses:state.truckStatus, shift: state.shift, archive: state.archive, trash: state.trash, audit: state.audit.slice(0, 100), notifications: (state.notifications || []).slice(0, 10), savedAt: Date.now() })); } catch(e) {} }
  function loadCache() { try { if (!currentUid) return; let raw = localStorage.getItem(sessionCacheKey()); if (!raw) return; let c = JSON.parse(raw); state.trucks = c.trucks||[]; state.objects = c.objects||[]; state.logs = c.logs||[]; state.truckStatus = c.truckStatus||{}; state.shift = c.shift||null; state.archive = c.archive||[]; state.trash = c.trash||[]; state.audit = c.audit||[]; state.notifications = c.notifications||[]; } catch(e) {} }

  function markSync(source, fromCache, hasPendingWrites, docCount) {
    if (syncState.errors) delete syncState.errors[source];
    syncState.fromCache[source] = !!fromCache; syncState.docCount[source] = docCount || 0;
    if (!fromCache) { syncState.everConnected[source] = true; syncState.lastSuccessAt = Date.now(); if(source==='status'||source==='shift')offlineTransportRecovered(); }
    syncState.pendingWrites[source] = !!hasPendingWrites;
    if (!hasPendingWrites) delete syncState.pendingWrites[source];
    updateSyncUI();
  }
  function reportSyncError(source, error) {
    syncState.errors = syncState.errors || {};
    syncState.errors[source] = { code: error?.code || 'unknown', message: error?.message || String(error), at: Date.now() }; if(offlineTransportError(error))offlineTransportFailed(error);
    console.error('[sync:' + source + ']', error);
    updateSyncUI();
  }
  function getSyncStatus() {
    const queued=offlinePendingCount();
    if (offlineServerUnreachable || !navigator.onLine) return { state: 'offline', text: 'Работа локально' + (queued ? ` · действий к отправке: ${queued}` : '') };
    if (Object.keys(syncState.errors || {}).length) return {state:'error',text:'Ошибка загрузки: ' + Object.keys(syncState.errors).join(', ')};
    if (!currentUserRole) return {state:'init',text:'Проверка учётной записи…'};
    if (!initialized || !permissionsLoaded) return { state: 'init', text: 'Загрузка данных и прав…' };
    const required = ['profile','permissions','trucks','status','shift'];
    if (required.some(source => !syncState.everConnected[source] || syncState.fromCache[source])) return {state:'init',text:'Данные из кеша. Ожидаем подтверждения сервера…'};
    if (pendingOps > 0 || queued > 0) return { state: 'syncing', text: `Синхронизация... (${pendingOps + queued})` };
    const failures=offlineUnreviewedFailures().length;
    if(failures)return {state:'error',text:'Не подтверждено действий: '+failures+' · Нажмите индикатор для подробностей'};
    return { state: 'ok', text: 'Всё на сервере' };
  }
  function updateSyncUI() {
    const dot = document.getElementById('syncDot'), badge = document.getElementById('syncBadge');
    if (!dot) return;
    const st = getSyncStatus();
    let notice = document.getElementById('sessionSyncNotice');
    if (!notice) { notice = document.createElement('div'); notice.id = 'sessionSyncNotice'; notice.style.cssText = 'padding:8px 12px;font-size:12px;background:#332611;color:#fcd34d;line-height:1.4'; document.getElementById('mainHeader')?.append(notice); }
    notice.hidden = !currentUid || st.state === 'ok' || st.state === 'syncing';
    notice.textContent = st.text + (st.state === 'error' ? ' · Нажмите точку синхронизации для подробностей.' : '');
    dot.className = 'sync-dot ' + st.state;
    let tip = st.text;
    if (syncState.lastSuccessAt && (st.state === 'ok' || st.state === 'offline')) tip += ' · ' + formatTimeAgo(syncState.lastSuccessAt);
    dot.parentElement.title = tip;
    if (badge) {const count=pendingOps+offlinePendingCount();if(count>0){badge.textContent=count>99?'99+':count;badge.classList.add('show');}else badge.classList.remove('show');}
  }
  function showSyncDiagnostics() {
    const sources = ['trucks','objects','logs','status','shift','archive','trash','audit','notifications','plugins','patches','users','requests'];
    let lines = ['── ДИАГНОСТИКА ──', '', `Online: ${navigator.onLine ? 'да' : 'НЕТ'}`, `Пользователь: ${currentEmail || '—'}`, `Роль: ${ROLES[currentUserRole]?.label || currentUserRole || '—'}`, `Права загружены: ${permissionsLoaded ? 'да' : 'нет'}`, `Приехал: ${hasPermission('action_arrive') ? 'разрешено' : 'нет права'}`, `Погрузка: ${hasPermission('action_load') ? 'разрешено' : 'нет права'}`, `pendingOps: ${pendingOps}`, `Max: ${appConfig.maxEnabled ? 'вкл' : 'выкл'}`, `Патчей: ${state.patches.length}`, ''];
    lines.push('Страница: ' + location.pathname, 'База: ' + firebaseConfig.projectId, 'UID: ' + (currentUid || '—'));
    Object.entries(syncState.errors || {}).forEach(([source,error]) => lines.push('ОШИБКА ' + source + ': ' + error.code + ' · ' + error.message));
    sources.forEach(s => { lines.push(`${s.padEnd(11)} | ${syncState.pendingWrites[s]?'ДА':'—'} | ${syncState.docCount[s]||0}`); });
    const rejected=offlineUnreviewedFailures();
    if(rejected.length) {
      lines.push('','── НЕПОДТВЕРЖДЁННЫЕ ДЕЙСТВИЯ ──');
      rejected.forEach(x=>lines.push(x.truckName||truckName(x.truckId),new Date(x.createdAt).toLocaleString('ru-RU'),offlineReasonLabel(x.result,x.conflictDetails),''));
      lines.push('Карточки показывают итоговое серверное состояние.');
    }
    appNotice(lines.join('\n'));
    if(rejected.length) {
      const all=offlineJournalRead();
      all.forEach(x=>{if(x.status==='rejected')x.reviewed=true;});
      offlineJournalWrite(all);
    }
  }
  function stopSync() {
    unsubscribers.forEach(u => { try { u(); } catch(e){} }); unsubscribers = [];
    if (usersUnsubscriber) { try { usersUnsubscriber(); } catch(e){} usersUnsubscriber = null; }
    if (reqsUnsubscriber) { try { reqsUnsubscriber(); } catch(e){} reqsUnsubscriber = null; }
  }

  function setPermissionsNotice(message) {
    let el = document.getElementById('permissionsLoadNotice');
    if (!el) {
      const header = document.getElementById('mainHeader');
      if (!header) return;
      el = document.createElement('div');
      el.id = 'permissionsLoadNotice';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = 'display:none;background:#422006;color:#fde68a;padding:9px 12px;border-bottom:1px solid #b45309;font-size:12px;line-height:1.5';
      header.appendChild(el);
    }
    el.textContent = message || '';
    el.style.display = message && currentUid ? 'block' : 'none';
  }

  function startSync() {
    stopSync();
    unsubscribers.push(refs.trucks.onSnapshot({ includeMetadataChanges: true }, s => { state.trucks = s.docs.map(d => Object.assign({id:d.id}, d.data())); markSync('trucks', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); scheduleRenderForTab('trucks', 'renderGlobalTrucksManage'); scheduleRenderForTab('line', 'renderLine'); scheduleRender('renderHeaderStats'); }, e=>reportSyncError('trucks', e)));
    unsubscribers.push(refs.objects.onSnapshot({ includeMetadataChanges: true }, s => { state.objects = s.docs.map(d => Object.assign({id:d.id}, d.data())); markSync('objects', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); scheduleRenderForTab('trucks', 'renderGlobalObjectsManage'); }, e=>reportSyncError('objects', e)));
    unsubscribers.push(refs.logs.onSnapshot({includeMetadataChanges:true},receiveLoadLogs,e=>reportSyncError('logs',e)));
    unsubscribers.push(refs.truckStatus.onSnapshot({includeMetadataChanges:true},receiveTruckStatuses,e=>reportSyncError('status',e)));
    unsubscribers.push(refs.shift.onSnapshot({ includeMetadataChanges: true }, doc => { state.shift = doc.exists ? Object.assign({id:doc.id}, doc.data()) : null; offlineProjectState();window.dispatchEvent(new Event('road-shift-changed'));markSync('shift', doc.metadata.fromCache, doc.metadata.hasPendingWrites, doc.exists?1:0); if(!initialized) initialized=true; saveCache(); scheduleRender('renderAll'); }, e=>reportSyncError('shift', e)));
    unsubscribers.push(refs.archive.onSnapshot({ includeMetadataChanges: true }, s => { state.archive = s.docs.map(d => Object.assign({id:d.id}, d.data())); markSync('archive', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); scheduleRenderForTab('archive', 'renderArchive'); scheduleRenderForTab('analytics', 'renderAnalytics'); }, e=>reportSyncError('archive', e)));
    unsubscribers.push(refs.trash.onSnapshot({ includeMetadataChanges: true }, s => { state.trash = s.docs.map(d => Object.assign({id:d.id}, d.data())); state.trash.sort((a,b)=>(b.deletedAt||0)-(a.deletedAt||0)); markSync('trash', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); scheduleRenderForTab('archive', 'renderTrash'); }, e=>reportSyncError('trash', e)));
    unsubscribers.push(refs.audit.orderBy('timestamp','desc').limit(200).onSnapshot({includeMetadataChanges:true},s => { state.audit = s.docs.map(d => Object.assign({id:d.id}, d.data()));if(!s.metadata.hasPendingWrites)window.__historyAcceptAudit?.(state.audit); markSync('audit', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); scheduleRenderForTab('analytics', 'renderAnalytics'); }, e=>reportSyncError('audit', e)));
    unsubscribers.push(refs.notifications.orderBy('timestamp','desc').limit(50).onSnapshot({ includeMetadataChanges: true }, s => { state.notifications = s.docs.map(d => Object.assign({id:d.id}, d.data())); offlineProjectTicker(); markSync('notifications', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); renderStatusTicker(); }, e=>reportSyncError('notifications', e)));
    unsubscribers.push(refs.plugins.onSnapshot({ includeMetadataChanges: true }, s => { state.plugins = s.docs.map(d => Object.assign({id:d.id}, d.data())); markSync('plugins', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); initPlugins(); if (canAdmin() && document.getElementById('tab-admin')?.classList.contains('active')) renderPluginsList(); }, e=>reportSyncError('plugins', e)));
    if (canAdmin()) {
      unsubscribers.push(refs.patches.onSnapshot(s => {
        state.patches = s.docs.map(d => Object.assign({id:d.id}, d.data()));
        state.patches.sort((a, b) => (a.order || 0) - (b.order || 0));
        markSync('patches', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size);
        if (canAdmin() && document.getElementById('tab-admin')?.classList.contains('active')) renderPatchesList();
      }, e=>reportSyncError('audit', e)));
    }
    if (!canAdmin()) usersUnsubscriber = usersRef.onSnapshot(s => { state.users = s.docs.map(d => Object.assign({id:d.id}, d.data())); scheduleRenderForTab('report', 'renderReport'); scheduleRenderForTab('analytics', 'renderAnalytics'); scheduleRenderForTab('line', 'renderLine'); }, e=>console.warn(e));
    unsubscribers.push(appConfigRef.onSnapshot(doc => { if (doc.exists) { let d = doc.data(); if(Number.isFinite(d.cycleMinutes)){settings.cycleMinutes=Math.max(15,d.cycleMinutes);localStorage.setItem('dt_settings',JSON.stringify(settings));} appConfig = { maxEnabled: !!d.maxEnabled, maxUrl: d.maxUrl || '', maxToken: d.maxToken || '', maxChatId: d.maxChatId || '', notifyStart: d.notifyStart !== undefined ? !!d.notifyStart : true, notifyArrive: d.notifyArrive !== undefined ? !!d.notifyArrive : true, notifyLoad: d.notifyLoad !== undefined ? !!d.notifyLoad : true, notifyTtn: d.notifyTtn !== undefined ? !!d.notifyTtn : true, notifyLineStart: d.notifyLineStart !== undefined ? !!d.notifyLineStart : true, notifyLineEnd: d.notifyLineEnd !== undefined ? !!d.notifyLineEnd : true, notifyPdfMain: d.notifyPdfMain !== undefined ? !!d.notifyPdfMain : true, notifyPdfGai: d.notifyPdfGai !== undefined ? !!d.notifyPdfGai : true, testReviewFlags: d.testReviewFlags || {}, gameRewardSchedule: Array.isArray(d.gameRewardSchedule) ? d.gameRewardSchedule : [] }; window.__gameConfigChanged?.(); renderConflictAuthorPatch(); renderAppSettingsIfActive(); if (appConfig.maxEnabled && appConfig.maxUrl) runMaxQueue(); } }, e => console.warn(e)));

    // === SECURITY: права и флаг готовности ===
    unsubscribers.push(permsRef.onSnapshot({ includeMetadataChanges: true }, doc => {
      markSync('permissions', doc.metadata.fromCache, doc.metadata.hasPendingWrites, doc.exists ? 1 : 0);
      // A missing cached document does not imply that the server settings are absent.
      // Never queue a default-permissions write without a server-confirmed absence.
      if (!doc.exists && doc.metadata.fromCache) {
        permissionsLoaded = false;
        permissionsConfig = {};
        document.body.removeAttribute('data-perms-ready');
        setPermissionsNotice('Права не найдены в офлайн-кэше. Вкладки временно скрыты до восстановления связи с Firebase; данные не удалены.');
        updateNavUI();
        applyRoleUI();
        return;
      }
      if (doc.exists) {
        permissionsConfig = doc.data();
      } else {
        permsRef.set(DEFAULT_PERMISSIONS).catch(e=>console.warn(e));
        permissionsConfig = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
      }
      permissionsLoaded = true;
      document.body.setAttribute('data-perms-ready', '1');
      setPermissionsNotice('');
      updateNavUI();
      applyRoleUI();
      renderAll();
    }, e => {
      reportSyncError('permissions', e);
      permissionsLoaded = false;
      permissionsConfig = {};
      setPermissionsNotice('Не удалось проверить права доступа. Разделы временно скрыты — проверьте соединение с Firebase. Данные не удалены.');
      showError('Не удалось загрузить права доступа. Обновите страницу или проверьте подключение.');
      document.body.removeAttribute('data-perms-ready');
      updateNavUI();
      applyRoleUI();
      renderAll();
    }));
  }

  function scheduleRenderLine() { if (renderLinePending) return; renderLinePending = true; setTimeout(() => { requestAnimationFrame(() => { renderLine(); renderLinePending = false; }); }, 50); }
  function scheduleRenderForTab(tabName, funcName) { let el = document.getElementById('tab-' + tabName); if (el && el.classList.contains('active') && typeof window[funcName] === 'function') { if (funcName === 'renderLine') scheduleRenderLine(); else window[funcName](); } }
  function scheduleRender(funcName) { if (typeof window[funcName] === 'function') window[funcName](); }

  const requestSyncStatus = {requests:false,users:false,errors:{}};
  function pendingRegistrationRequests() {
    const result=[];
    (state.requests||[]).forEach(r=>{
      if(r.status && r.status!=='pending') return;
      const user=(state.users||[]).find(u=>u.id===r.uid || (u.email&&u.email===r.email));
      if(user && user.status!=='pending') return;
      result.push({...r,uid:r.uid||user?.id||null});
    });
    (state.users||[]).filter(u=>u.status==='pending').forEach(u=>{
      if(!result.some(r=>r.uid===u.id || (r.email&&r.email===u.email))) result.push({id:u.id,uid:u.id,email:u.email,nickname:u.nickname,createdAt:u.createdAt||0});
    });
    return result.sort((a,b)=>(Number(b.createdAt)||0)-(Number(a.createdAt)||0));
  }
  function renderRegistrationRequests() {
    if(!canAdmin())return;
    const container=document.getElementById('requestsListContainer');if(!container)return;
    const list=pendingRegistrationRequests();
    const count=document.getElementById('pendingCount');if(count)count.textContent=list.length;
    const messages=Object.entries(requestSyncStatus.errors).map(([source,error])=>source+': '+error);
    container.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px"><strong>Заявки на регистрацию · '+list.length+'</strong><button class="btn btn-secondary btn-small" id="refreshRegistrationRequestsBtn">Обновить заявки</button></div>'
      +(messages.length?'<div style="padding:10px;margin-bottom:12px;color:var(--warning);font-size:12px">Не удалось полностью загрузить заявки: '+escapeHtml(messages.join('; '))+'</div>':'')
      +(list.length?list.map(r=>`<div class="user-row"><div class="user-row-top"><div><strong>${escapeHtml(r.email)}</strong><div style="font-size:12px;color:var(--muted)">${escapeHtml(r.nickname||'')}</div></div><div class="pending-badge">Ожидает</div></div><div class="user-row-bottom"><select id="req_role_${escapeHtml(r.id)}" class="form-control" style="padding:6px;font-size:12px">${Object.keys(ROLES).map(role=>`<option value="${role}" ${role==='viewer'?'selected':''}>${escapeHtml(ROLES[role].label)}</option>`).join('')}</select><button class="btn btn-quick btn-small" data-approve-request="${escapeHtml(r.id)}">Подтвердить</button><button class="btn btn-secondary btn-small" data-reject-request="${escapeHtml(r.id)}">Отклонить</button></div></div>`).join(''):'<div class="empty-state">'+(requestSyncStatus.requests&&requestSyncStatus.users&&!messages.length?'Нет заявок':messages.length?'Проверьте доступ к базе и нажмите «Обновить заявки»':'Загружаем заявки и ожидающие учётки…')+'</div>');
    container.querySelector('#refreshRegistrationRequestsBtn').onclick=()=>refreshRegistrationRequests();
    container.querySelectorAll('[data-approve-request]').forEach(b=>b.onclick=()=>approveRequest(b.dataset.approveRequest));
    container.querySelectorAll('[data-reject-request]').forEach(b=>b.onclick=()=>rejectRequest(b.dataset.rejectRequest));
    updateAdminBadge();
  }
  function acceptRegistrationSnapshot(source,snapshot) {
    if(!canAdmin())return;
    const records=snapshot.docs.map(d=>({...d.data(),id:d.id}));
    if(source==='users')state.users=records;else state.requests=records;
    markSync(source,!!snapshot.metadata?.fromCache,!!snapshot.metadata?.hasPendingWrites,records.length);
    if(!snapshot.metadata?.fromCache)requestSyncStatus[source]=true;
    delete requestSyncStatus.errors[source];
    renderRegistrationRequests();
    if(document.getElementById('tab-admin')?.classList.contains('active'))renderAdminPanel();
  }
  function registrationSyncError(source,error) {
    requestSyncStatus.errors[source]=(error.code||'unknown')+' · '+(error.message||String(error));
    reportSyncError(source,error);renderRegistrationRequests();
  }
  let refreshingRegistrationRequests=false;
  async function refreshRegistrationRequests() {
    if(!canAdmin()||refreshingRegistrationRequests)return;
    refreshingRegistrationRequests=true;
    try {
      const sources=['requests','users'];
      const results=await Promise.allSettled([requestsRef.get({source:'server'}),usersRef.get({source:'server'})]);
      results.forEach((result,index)=>{if(result.status==='fulfilled')acceptRegistrationSnapshot(sources[index],result.value);else registrationSyncError(sources[index],result.reason);});
    }finally{refreshingRegistrationRequests=false;}
  }
  function startAdminSync() {
    if(!canAdmin())return;
    if(reqsUnsubscriber)reqsUnsubscriber();
    if(usersUnsubscriber)usersUnsubscriber();
    requestSyncStatus.requests=false;requestSyncStatus.users=false;requestSyncStatus.errors={};
    // Sort on the client so legacy records without createdAt are also included.
    reqsUnsubscriber=requestsRef.onSnapshot({includeMetadataChanges:true},snapshot=>acceptRegistrationSnapshot('requests',snapshot),error=>registrationSyncError('requests',error));
    usersUnsubscriber=usersRef.onSnapshot({includeMetadataChanges:true},snapshot=>acceptRegistrationSnapshot('users',snapshot),error=>registrationSyncError('users',error));
    renderRegistrationRequests();
  }
  function updateAdminBadge() {
    const badge=document.getElementById('navAdminBadge');if(!badge)return;
    const count=pendingRegistrationRequests().length;
    badge.style.display=count?'block':'none';badge.textContent=count;
  }

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

  // === АВТОРИЗАЦИЯ ===
  auth.onAuthStateChanged(async user => {
    if (user) {
      stopSync();
      permissionsLoaded = false;
      permissionsConfig = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
      document.body.removeAttribute('data-perms-ready');
      currentEmail = user.email || ''; currentUid = user.uid || '';
      setPermissionsNotice('Проверяем права доступа к разделам…');
      currentUserRole = null; currentUserStatus = null; currentUserNickname = ''; activeProfileKey = '';
      initialized = false; confirmedLoadIds.clear();
      syncState = { fromCache:{}, everConnected:{}, docCount:{}, pendingWrites:{}, lastSuccessAt:0, errors:{} };
      state = { trucks:[], objects:[], logs:[], truckStatus:{}, shift:null, archive:[], trash:[], audit:[], notifications:[], users:[], requests:[], plugins:[], patches:[] };
      loadCache(); offlineRemoteStatuses={...state.truckStatus};offlineRemoteLogs=state.logs.slice();offlineProjectState(); renderAll();
      document.getElementById('userBadgeLabel').textContent = '👤 Проверка учётной записи…';
      updateSyncUI();
      document.getElementById('authOverlay').style.display = 'none';
      const forced = isForcedAdminEmail(currentEmail); const defaultNick = sanitizeName(currentEmail);
      if (userDocUnsubscriber) userDocUnsubscriber();
      userDocUnsubscriber = usersRef.doc(currentUid).onSnapshot({ includeMetadataChanges:true }, async snap => {
        try {
        if (currentUid !== user.uid) return;
        markSync('profile', snap.metadata.fromCache, snap.metadata.hasPendingWrites, snap.exists ? 1 : 0);
        if (!snap.exists && snap.metadata.fromCache) {
          setPermissionsNotice('Профиль пользователя не сохранён в офлайн-кэше. Подключитесь к Firebase для проверки доступа.');
          updateSyncUI(); return;
        }
        if (!snap.exists) {
          if (forced) await usersRef.doc(currentUid).set({ email: currentEmail, nickname: defaultNick, role: 'admin', status: 'active', createdAt: Date.now(), bootstrap: true });
          else { await ensurePendingAccount(user); return; }
        }
        const data = snap.exists ? snap.data() : {};
        currentUserRole = data.role || (forced ? 'admin' : 'viewer');
        currentUserStatus = data.status || (forced ? 'active' : 'pending');
        currentUserNickname = data.nickname || defaultNick;
        if (snap.exists && !data.nickname && defaultNick && !forced) { usersRef.doc(currentUid).set({ nickname: defaultNick }, { merge: true }).catch(()=>{}); currentUserNickname = defaultNick; }
        if (forced && (currentUserRole !== 'admin' || currentUserStatus !== 'active')) { await usersRef.doc(currentUid).set({ role: 'admin', status: 'active', nickname: currentUserNickname || defaultNick }, { merge: true }); currentUserRole = 'admin'; currentUserStatus = 'active'; }
        if (currentUserStatus === 'pending') {
          try { await ensurePendingAccount(user); document.getElementById('registrationStatusText').textContent='Ваша заявка отправлена. Ожидайте решения администратора.'; }
          catch(e) { document.getElementById('registrationStatusText').textContent='Заявка не отправлена: ' + (e.message || e.code) + '. Обратитесь к администратору.'; }
          activeProfileKey = ''; stopSync(); document.getElementById('pendingScreen').style.display = 'flex'; document.getElementById('disabledScreen').style.display = 'none'; document.getElementById('mainHeader').style.display = 'none'; document.querySelector('.container').style.display = 'none'; document.querySelector('nav').style.display = 'none'; return; }
        if (currentUserStatus === 'disabled') {
          permissionsLoaded=false;document.body.removeAttribute('data-perms-ready');
          cancelHold();document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelectorAll('.modal.open').forEach(d=>d.classList.remove('open'));
          window.__gameAccessChanged?.();
          document.getElementById('disabledStatusTitle').textContent=data.rejectionReason?'Заявка отклонена':'Доступ временно ограничен';
          document.getElementById('disabledStatusText').textContent=data.rejectionReason||'Доступ ограничен администратором. Обратитесь к администратору, чтобы восстановить доступ, или попробуйте войти позже.';
          activeProfileKey='';stopSync();document.getElementById('pendingScreen').style.display='none';document.getElementById('disabledScreen').style.display='flex';document.getElementById('mainHeader').style.display='none';document.querySelector('.container').style.display='none';document.querySelector('nav').style.display='none';return;
        }
        document.getElementById('pendingScreen').style.display = 'none'; document.getElementById('disabledScreen').style.display = 'none'; document.getElementById('mainHeader').style.display = ''; document.querySelector('.container').style.display = ''; document.querySelector('nav').style.display = 'flex';
        updateUserBadge(); updateNavUI(); applyRoleUI(); updateSyncUI();
        const profileKey = currentUid + ':' + currentUserRole + ':' + currentUserStatus;
        if (activeProfileKey === profileKey) return;
        activeProfileKey = profileKey;
        startSync(); startAdminSync(); setTimeout(runMaxQueue, 1200);
        loadAndApplyPatches().catch(e => reportSyncError('patches', e));
        } catch(e) { reportSyncError('profile', e); }
      }, e => {
        stopSync(); permissionsLoaded = false; currentUserRole = null; activeProfileKey = '';
        document.body.removeAttribute('data-perms-ready');
        setPermissionsNotice('Не удалось проверить учётную запись. Остальные разделы скрыты до восстановления соединения.');
        document.getElementById('userBadgeLabel').textContent = '👤 Учётная запись не загружена';
        reportSyncError('profile', e);
        renderAll();
      });
    } else {
      currentEmail = ''; currentUid = ''; currentUserRole = null; currentUserStatus = null; currentUserNickname = '';
      setPermissionsNotice('');
      permissionsLoaded = false;
      document.body.removeAttribute('data-perms-ready');
      if (userDocUnsubscriber) { userDocUnsubscriber(); userDocUnsubscriber = null; }
      stopSync(); initialized = false; pendingOps = 0; confirmedLoadIds.clear();
      syncState = { fromCache: {}, everConnected: {}, docCount: {}, pendingWrites: {}, lastSuccessAt: 0 };
      state = { trucks:[], objects:[], logs:[], truckStatus:{}, shift:null, archive:[], trash:[], audit:[], notifications:[], users:[], requests:[], plugins:[], patches:[] };
      document.getElementById('authOverlay').style.display = 'flex'; document.getElementById('pendingScreen').style.display = 'none'; document.getElementById('disabledScreen').style.display = 'none';
      document.getElementById('mainHeader').style.display = ''; document.querySelector('.container').style.display = ''; document.querySelector('nav').style.display = 'flex';
      document.getElementById('userBadgeLabel').textContent = '👤 Войти'; updateSyncUI();
      // Firebase Auth сам восстанавливает сессию; пароль в браузере не храним.
      const savedEmail = localStorage.getItem('dt_saved_email');
      if (savedEmail) document.getElementById('authEmail').value = savedEmail;
      document.getElementById('authPassword').value = '';
    }
  });

  function updateUserBadge() { const badge = document.getElementById('userBadgeLabel'); if (!badge) return; const roleInfo = ROLES[currentUserRole] || ROLES.viewer; const chip = `<span class="role-chip ${roleInfo.color}">${roleInfo.icon} ${roleInfo.label}</span>`; badge.innerHTML = `👤 ${escapeHtml(getUserName())} ${chip}`; }
  function applyRoleUI() {
    const versionAllowed = permissionsLoaded && canAdmin();
    document.body.toggleAttribute('data-release-admin', versionAllowed);
    if (!versionAllowed) document.getElementById('releaseHistoryDialog')?.close();
    const viewBanner = document.getElementById('viewOnlyBanner'); const canDoAnything = hasPermission('start_shift') || hasPermission('edit_line') || hasPermission('action_load');
    if (viewBanner) viewBanner.style.display = (!canDoAnything && state.shift) ? 'block' : 'none';
    const startBtn = document.getElementById('startShiftBtn'); if (startBtn) startBtn.style.display = hasPermission('start_shift') ? '' : 'none';
    const truckForm = document.getElementById('truckFormCard'); if (truckForm) truckForm.style.display = hasPermission('manage_trucks') ? '' : 'none';
    const objectForm = document.getElementById('objectFormCard'); if (objectForm) objectForm.style.display = hasPermission('manage_objects') ? '' : 'none';
    const changeObjBtn = document.getElementById('changeObjBtn'); if (changeObjBtn) changeObjBtn.style.display = hasPermission('edit_line') ? 'inline-block' : 'none';
    const headerExtra = document.getElementById('headerExtraContent'); if (headerExtra) headerExtra.style.display = hasPermission('view_header') ? '' : 'none';
    const gaiToggleContainer = document.getElementById('gaiReportToggleContainer');
    if (gaiToggleContainer) { const canGai = hasPermission('view_gai_report'); gaiToggleContainer.style.display = canGai ? 'flex' : 'none'; if (!canGai) showGAITable = false; }
  }
  function handleLogin() {
    let email = document.getElementById('authEmail').value.trim(), pass = document.getElementById('authPassword').value, err = document.getElementById('authError');
    if (!email || !pass) { err.textContent = 'Укажите Email и пароль'; return; }
    err.style.color = '#f8fafc'; err.textContent = '⏳ Вход...';
    auth.signInWithEmailAndPassword(email, pass).then(() => {
      localStorage.setItem('dt_saved_email', email);
      document.getElementById('authPassword').value = '';
      err.textContent = '';
    })
    .catch(e => { if (e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential') { err.style.color = 'var(--danger)'; err.textContent = 'Пользователь не найден.'; } else { err.style.color = 'var(--danger)'; err.textContent = e.message; } });
  }
  let registrationInFlight = false;
  async function ensurePendingAccount(user) {
    const profileRef = usersRef.doc(user.uid), requestRef = requestsRef.doc(user.uid);
    await db.runTransaction(async tx => {
      const profile = await tx.get(profileRef);
      const request = await tx.get(requestRef);
      if (profile.exists && profile.data().status !== 'pending') return;
      const email = user.email || '';
      const nickname = profile.exists ? profile.data().nickname || sanitizeName(email) : sanitizeName(email);
      if (!profile.exists) tx.set(profileRef,{email,nickname,role:'viewer',status:'pending',createdAt:Date.now()});
      if (!request.exists) tx.set(requestRef,{uid:user.uid,email,nickname,status:'pending',createdAt:Date.now()});
    });
  }
  async function handleRegister() {
    if (registrationInFlight) return;
    const email = document.getElementById('authEmail').value.trim();
    const passwordInput = document.getElementById('authPassword');
    const password = passwordInput.value;
    const error = document.getElementById('authError');
    if (!email || !password) { error.textContent='Введите e-mail и пароль'; return; }
    registrationInFlight=true;
    const button=document.getElementById('registerBtn');button.disabled=true;
    error.style.color='var(--text)';error.textContent='Создаём заявку…';
    let created=false;
    try {
      const credential=await auth.createUserWithEmailAndPassword(email,password);
      created=true;passwordInput.value='';
      await ensurePendingAccount(credential.user);
      error.textContent='Заявка отправлена. Ожидайте подтверждения администратора.';
      document.getElementById('registrationStatusText').textContent=error.textContent;
    } catch(e) {
      error.style.color='var(--danger)';
      const messages={'auth/email-already-in-use':'Этот e-mail уже зарегистрирован. Нажмите «Войти».','auth/invalid-email':'Проверьте e-mail.','auth/weak-password':'Firebase отклонил пароль: используйте более сложный пароль.','auth/operation-not-allowed':'В Firebase необходимо включить вход по e-mail и паролю.'};
      const text=created?'Учётка создана, но заявку отправить не удалось. Обновите страницу после проверки Rules.':messages[e.code]||e.message||'Ошибка регистрации';
      error.textContent=text;
      if(created)document.getElementById('registrationStatusText').textContent=text;
    } finally {passwordInput.value='';registrationInFlight=false;button.disabled=false;}
  }
  async function handleLogout() { if (!(await appConfirm('Выйти?'))) return; localStorage.removeItem('dt_saved_email'); localStorage.removeItem('dt_saved_pass'); auth.signOut(); }

  // === АДМИН ===
  function switchAdminTab(tab, btn) {
    document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    if(btn) btn.classList.add('active');
    document.getElementById('admin-sub-' + tab).classList.add('active');
    if (tab === 'permissions') renderPermissionsMatrix();
    if (tab === 'requests' || tab === 'users') renderAdminPanel();
    if (tab === 'requests') refreshRegistrationRequests();
    if (tab === 'plugins') renderPluginsList();
    if (tab === 'patches') {renderPatchesList();renderConflictAuthorPatch();}
    if (tab === 'console') renderConsole();
    if (tab === 'appsettings') renderAppSettingsIfActive();
  }
  function renderAppSettingsIfActive() {
    if (!document.getElementById('tab-admin')?.classList.contains('active')) return;
    if (!document.getElementById('admin-sub-appsettings')?.classList.contains('active')) return;
    const cycle=document.getElementById('adminCycleMinutes');if(cycle&&!cycle.disabled&&document.activeElement!==cycle)cycle.value=Math.max(MIN_CYCLE_MINUTES,settings.cycleMinutes||MIN_CYCLE_MINUTES);
    ['MaxEnabled','NotifyStart','NotifyArrive','NotifyLoad','NotifyTtn','NotifyLineStart','NotifyLineEnd','NotifyPdfMain','NotifyPdfGai'].forEach(k => { let el = document.getElementById('appConfig' + k); if (el) { let configKey = k.charAt(0).toLowerCase() + k.slice(1); el.checked = !!appConfig[configKey]; } });
    if (document.getElementById('appConfigMaxUrl')) document.getElementById('appConfigMaxUrl').value = appConfig.maxUrl;
    if (document.getElementById('appConfigMaxToken')) document.getElementById('appConfigMaxToken').value = appConfig.maxToken;
    if (document.getElementById('appConfigMaxChatId')) document.getElementById('appConfigMaxChatId').value = appConfig.maxChatId;
  }
  async function saveAdminCycleMinutes(input) {
    if(!canAdmin())return;
    input.disabled=true;
    try{await updateCycleMinutes(input.value);}finally{input.disabled=false;input.value=Math.max(MIN_CYCLE_MINUTES,settings.cycleMinutes||MIN_CYCLE_MINUTES);}
  }
  async function saveAppConfig() {
    if (!canAdmin()) return;
    let data = {
      maxEnabled: !!document.getElementById('appConfigMaxEnabled')?.checked,
      maxUrl: (document.getElementById('appConfigMaxUrl')?.value || '').trim(),
      maxToken: (document.getElementById('appConfigMaxToken')?.value || '').trim(),
      maxChatId: (document.getElementById('appConfigMaxChatId')?.value || '').trim(),
      notifyStart: !!document.getElementById('appConfigNotifyStart')?.checked,
      notifyArrive: !!document.getElementById('appConfigNotifyArrive')?.checked,
      notifyLoad: !!document.getElementById('appConfigNotifyLoad')?.checked,
      notifyTtn: !!document.getElementById('appConfigNotifyTtn')?.checked,
      notifyLineStart: !!document.getElementById('appConfigNotifyLineStart')?.checked,
      notifyLineEnd: !!document.getElementById('appConfigNotifyLineEnd')?.checked,
      notifyPdfMain: !!document.getElementById('appConfigNotifyPdfMain')?.checked,
      notifyPdfGai: !!document.getElementById('appConfigNotifyPdfGai')?.checked
    };
    try { await tfAwait(appConfigRef.set(data, { merge: true })); appConfig = Object.assign({}, appConfig, data); showToastEl('Настройки сохранены', false); if (appConfig.maxEnabled && appConfig.maxUrl) runMaxQueue(); } catch(e) { showError(e.message); }
  }

  // === MAX QUEUE ===
  const MAX_QUEUE_KEY = 'dt_max_queue'; const MAX_QUEUE_MAX = 100; const MAX_TRIES = 5;
  let maxQueue = []; let maxSenderRunning = false; let maxSeq = 0; let maxLastError = '';
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function loadMaxQueue() { try { maxQueue = JSON.parse(localStorage.getItem(MAX_QUEUE_KEY) || '[]'); } catch(e) { maxQueue = []; } if (!Array.isArray(maxQueue)) maxQueue = []; }
  function saveMaxQueue() { try { localStorage.setItem(MAX_QUEUE_KEY, JSON.stringify(maxQueue)); } catch(e) { if (e.name === 'QuotaExceededError' || e.code === 22) { while (maxQueue.length > 0) { const idx = maxQueue.findIndex(q => q.type === 'document'); if (idx === -1) maxQueue.shift(); else maxQueue.splice(idx, 1); try { localStorage.setItem(MAX_QUEUE_KEY, JSON.stringify(maxQueue)); return; } catch(e2) {} } } } }
  function enqueueMax(text, meta, notBefore) { if (!appConfig.maxEnabled || !appConfig.maxUrl) return; maxQueue.push({ id: 'q_' + Date.now() + '_' + (++maxSeq), type: 'text', text, tries: 0, createdAt: Date.now(), notBefore: notBefore || 0, meta: meta || null }); while (maxQueue.length > MAX_QUEUE_MAX) maxQueue.shift(); saveMaxQueue(); runMaxQueue(); }
  function enqueueMaxDocument(filename, base64Content, caption, meta, notBefore) { if (!appConfig.maxEnabled || !appConfig.maxUrl) return; maxQueue.push({ id: 'q_' + Date.now() + '_' + (++maxSeq), type: 'document', filename, base64: base64Content, caption: caption || '', tries: 0, createdAt: Date.now(), notBefore: notBefore || 0, meta: meta || null }); while (maxQueue.length > MAX_QUEUE_MAX) maxQueue.shift(); saveMaxQueue(); runMaxQueue(); }
  async function sendMaxOnce(item) {
    if (!appConfig.maxEnabled || !appConfig.maxUrl) return 'drop';
    let headers = { 'Content-Type': 'application/json' };
    if (appConfig.maxToken) { let tk = String(appConfig.maxToken).trim(); headers['Authorization'] = tk.startsWith('Bearer ') ? tk : 'Bearer ' + tk; }
    let body = item.type === 'document' ? { chat_id: appConfig.maxChatId || '', text: item.caption || '', document: { filename: item.filename, content_base64: item.base64 } } : { chat_id: appConfig.maxChatId || '', text: item.text };
    let ctrl = new AbortController(); let timer = setTimeout(() => ctrl.abort(), 30000);
    try { let resp = await fetch(appConfig.maxUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal, keepalive: true }); clearTimeout(timer); if (resp.ok) return 'ok'; if (resp.status === 413) return 'too_large'; if (resp.status === 429) return 'retry'; if (resp.status >= 500) return 'retry'; if (resp.status === 401 || resp.status === 403) return 'auth'; return 'http_' + resp.status; }
    catch (e) { clearTimeout(timer); return 'network'; }
  }
  async function runMaxQueue() {
    if (currentUserStatus!=='active'||maxSenderRunning || !appConfig.maxEnabled || !appConfig.maxUrl) return;
    maxSenderRunning = true;
    try {
      while (maxQueue.length&&currentUserStatus==='active') {
        const idx = maxQueue.findIndex(q => !q.notBefore || q.notBefore <= Date.now());
        if (idx === -1) break;
        const item = maxQueue[idx]; const res = await sendMaxOnce(item);
        if (res === 'ok') { maxQueue.splice(idx, 1); saveMaxQueue(); await sleep(1200 + Math.floor(Math.random() * 600)); continue; }
        if (res === 'retry' && item.tries < MAX_TRIES) { item.tries++; saveMaxQueue(); await sleep(Math.min(30000, 2000 * Math.pow(2, item.tries))); continue; }
        maxQueue.splice(idx, 1); saveMaxQueue();
        let reason = res === 'auth' ? 'токен (401)' : res === 'too_large' ? 'размер (413)' : res === 'network' ? 'нет связи' : res === 'retry' ? 'лимит (429)' : 'код ' + res;
        maxLastError = reason; showToastEl('⚠️ MAX: не отправлено — ' + reason, true);
      }
    } finally { maxSenderRunning = false; if (maxQueue.length) { const pending = maxQueue.filter(q => q.notBefore && q.notBefore > Date.now()); if (pending.length > 0) setTimeout(runMaxQueue, Math.max(5000, Math.min(...pending.map(q => q.notBefore)) - Date.now())); } }
  }
  function showMaxQueueStatus() { let lines = ['── ОЧЕРЕДЬ MAX ──', `Отправка: ${appConfig.maxEnabled ? 'вкл' : 'выкл'}`, `В очереди: ${maxQueue.length}`]; if (maxLastError) lines.push(`Ошибка: ${maxLastError}`); appNotice(lines.join('\n')); }
  async function testMaxMessage() {
    if (!canAdmin()) return;
    if (!appConfig.maxEnabled || !appConfig.maxUrl || !appConfig.maxChatId) { showError('Заполните URL, токен и Chat ID'); return; }
    showToastEl('⏳ Отправка теста...', false);
    let res = await sendMaxOnce({ type: 'text', text: '🧪 Тест\nПриложение «Учет самосвалов» подключено к Max.' });
    if (res === 'ok') showToastEl('✅ Сообщение отправлено', false); else showError('Ошибка: ' + res);
  }

  // === PDF ===
  function blobToBase64(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); }); }
  async function generatePDFFromHTML(innerHtml, filename) {
    try { if (document.fonts && document.fonts.load) { await document.fonts.load('700 18px Caveat'); await document.fonts.load('400 18px Caveat'); await document.fonts.ready; } } catch(e) {}
    const wrapper = document.createElement('div'); wrapper.style.cssText = 'position:fixed;left:-99999px;top:0;width:1400px;background:#fdfdfd;padding:10px;z-index:-1;';
    const inner = document.createElement('div'); inner.className = 'paper-report-container'; inner.style.cssText = 'zoom:1;background:#fdfdfd;'; inner.innerHTML = innerHtml;
    wrapper.appendChild(inner); document.body.appendChild(wrapper);
    try { const opt = { margin: 5, filename, image: { type: 'jpeg', quality: 0.96 }, html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#fdfdfd' }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' } }; return await html2pdf().set(opt).from(inner).outputPdf('blob'); }
    finally { document.body.removeChild(wrapper); }
  }

  // === STYLUS ===
  function setupStylus(canvasId, containerId) {
    const canvas = document.getElementById(canvasId); const container = document.getElementById(containerId);
    if (!canvas || !container) return;
    canvas.width = container.scrollWidth; canvas.height = container.scrollHeight;
    const ctx = canvas.getContext('2d'); ctx.strokeStyle = '#0000FF'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    let isDrawing = false;
    canvas.addEventListener('pointerdown', (e) => { if (!drawMode) return; e.preventDefault(); isDrawing = true; const rect = canvas.getBoundingClientRect(); ctx.beginPath(); ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top); });
    canvas.addEventListener('pointermove', (e) => { if (!isDrawing) return; e.preventDefault(); const rect = canvas.getBoundingClientRect(); ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top); ctx.stroke(); });
    canvas.addEventListener('pointerup', () => { isDrawing = false; });
    canvas.addEventListener('pointerleave', () => { isDrawing = false; });
  }
  function toggleDrawMode() {
    drawMode = !drawMode;
    const c1 = document.getElementById('draw-canvas-main'); const c2 = document.getElementById('draw-canvas-gai'); const btn = document.getElementById('btnDrawToggle');
    if (drawMode) { if (c1) c1.classList.add('active'); if (c2) c2.classList.add('active'); btn.innerHTML = '🖐 Отключить'; btn.classList.replace('btn-secondary', 'btn-quick'); showToastEl('✏️ Рисование ВКЛ', false); }
    else { if (c1) c1.classList.remove('active'); if (c2) c2.classList.remove('active'); btn.innerHTML = '✏️ Рисовать'; btn.classList.replace('btn-quick', 'btn-secondary'); showToastEl('🖐 Рисование ВЫКЛ', false); }
  }
  function clearDrawings() { ['draw-canvas-main', 'draw-canvas-gai'].forEach(id => { const c = document.getElementById(id); if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height); }); showToastEl('🗑 Очищено', false); }
  function toggleDrawModeArchive() {
    const c = document.getElementById('draw-canvas-archive'); const btn = document.getElementById('btnDrawToggleArchive'); if (!c) return;
    const isActive = c.classList.contains('active');
    if (isActive) { c.classList.remove('active'); btn.innerHTML = '✏️ Рисовать'; btn.classList.replace('btn-quick', 'btn-secondary'); drawMode = false; }
    else { c.classList.add('active'); btn.innerHTML = '🖐 Отключить'; btn.classList.replace('btn-secondary', 'btn-quick'); drawMode = true; }
  }
  function clearDrawingsArchive() { const c = document.getElementById('draw-canvas-archive'); if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height); showToastEl('🗑 Очищено', false); }

  // === ОТЧЕТ HTML ===
  function buildReportHTML({ objectName, date, logs, activeLineIds, type, checkTTN, isClosed = false, reportTtnStatus = null }) {
    const filteredLogs = type === 'gai' ? logs.filter(l => l.isGAI) : logs.filter(l => !l.isGAI);
    const activeIds = (activeLineIds || []).filter(id => { const t = findTruck(id); if (!t) return false; return type === 'gai' ? !!t.isGAI : !t.isGAI; });
    const truckIds = new Set(activeIds); filteredLogs.forEach(l => truckIds.add(l.truckId));
    const trucks = Array.from(truckIds).map(id => { const t = findTruck(id); if (t) return t; const ref = filteredLogs.find(l => l.truckId === id); return { id, brand: (ref && ref.truckName) || 'Машина', number: '', defaultVol: 0 }; });
    const firstTime = {}; filteredLogs.forEach(l => { if (firstTime[l.truckId] === undefined || l.timestamp < firstTime[l.truckId]) firstTime[l.truckId] = l.timestamp; });
    trucks.sort((a, b) => (firstTime[a.id] || 0) - (firstTime[b.id] || 0));
    let maxTrips = 8; trucks.forEach(t => { const c = filteredLogs.filter(l => l.truckId === t.id).length; if (c > maxTrips) maxTrips = c; });
    const totalVol = filteredLogs.reduce((s, l) => s + l.volume, 0);
    let html = `<div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(objectName || '—')}${type === 'gai' ? ' (ГАИ)' : ''}</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(date || '')}</div><div class="paper-total-info">${type === 'gai' ? `Всего рейсов ГАИ: <b>${filteredLogs.length}</b>` : `Общий объем: <b>${totalVol} м³</b>`}</div></div></div><table class="paper-table"><thead><tr><th>№</th><th style="text-align:left;">Самосвал</th>`;
    for (let i = 1; i <= maxTrips; i++) html += `<th>Рейс ${i}</th>`;
    html += `</tr></thead><tbody>`;
    trucks.forEach((t, idx) => {
      const tLogs = filteredLogs.filter(l => l.truckId === t.id).slice().reverse();
      const sum = tLogs.reduce((s, l) => s + l.volume, 0);
      let st = state.truckStatus[t.id] || {};
      let savedTtn = reportTtnStatus ? reportTtnStatus[t.id] : st.ttnStatus;
      let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (isClosed && tLogs.length > 0 && savedTtn !== true && savedTtn !== 'pending') : (tLogs.length > 0 && st.ttnStatus !== true);
      let dupHtml = isDup ? ' <span style="color:red; font-size:10px; font-weight:bold;">ДУБЛИКАТ</span>' : '';
      const brandCell = type === 'gai' ? `${escapeHtml(t.brand)} <span class="paper-truck-volume">Рейсов: ${tLogs.length}</span>${dupHtml}` : `${escapeHtml(t.brand)} <span class="paper-truck-volume">${sum} м³</span>${dupHtml}`;
      html += `<tr><td style="font-weight:bold;">${idx + 1}</td><td class="truck-cell"><div class="paper-truck-brand">${brandCell}</div>${t.number ? renderRussianPlate(t.number) : ''}</td>`;
      for (let i = 0; i < maxTrips; i++) {
        const l = tLogs[i];
        if (l) {
          const isLast = (i === tLogs.length - 1);
          const cH = (checkTTN && checkTTN(t.id, l.id, isLast)) ? '<div class="hand-drawn-circle"></div>' : '';
          let commHtml = l.comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l.comment)}</div>` : '';
          html += `<td><div class="cell-content">${cH}<div class="paper-time">${escapeHtml(l.timeStr)}</div><div class="paper-trip-num">${i + 1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l.createdByEmail, l.createdBy))}</div>${commHtml}</div></td>`;
        } else if (type !== 'gai' && i === tLogs.length && st.ttnStatus === 'pending') {
          let dotHtml = st.arriveStatus ? `<div class="paper-time">${escapeHtml(st.arriveStatus)}</div><div class="paper-dot">•</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(null, st.arriveBy))}</div>` : '';
          html += `<td><div class="cell-content"><div class="hand-drawn-circle"></div>${dotHtml}</div></td>`;
        } else if (type !== 'gai' && i === tLogs.length && st.arriveStatus) {
          html += `<td><div class="cell-content"><div class="paper-time">${escapeHtml(st.arriveStatus)}</div><div class="paper-dot">•</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(null, st.arriveBy))}</div></div></td>`;
        } else html += '<td></td>';
      }
      html += '</tr>';
    });
    html += `</tbody></table>`;
    return html;
  }

  async function sendShiftReportToMax(shift, logs) {
    const activeLineIds = getActiveLineIds(); const stdLogs = logs.filter(l => !l.isGAI); const gaiLogs = logs.filter(l => l.isGAI);
    const safeDate = String(shift.startDate || '').replace(/[^\w]/g, '_');
    if (stdLogs.length > 0 && appConfig.notifyPdfMain) {
      try {
        const html = buildReportHTML({ objectName: shift.objectName, date: shift.startDate, isClosed: true, logs: stdLogs, activeLineIds, type: 'regular', checkTTN: (id, logId) => state.truckStatus[id] && state.truckStatus[id].ttnStatus === true && state.truckStatus[id].ttnLogId === logId });
        const canvas = document.getElementById('draw-canvas-main'); let finalHtml = html;
        if (canvas) finalHtml = `<div style="position:relative;"><img src="${canvas.toDataURL()}" style="position:absolute; top:0; left:0; width:100%; height:100%; z-index:100; pointer-events:none;"><div style="position:relative; z-index:1;">${html}</div></div>`;
        const blob = await generatePDFFromHTML(finalHtml, 'report_regular.pdf'); const b64 = await blobToBase64(blob);
        enqueueMaxDocument(`report_regular_${safeDate}.pdf`, b64, `📊 Отчет (ОСНОВНЫЕ): ${shift.objectName} / ${shift.startDate}`, null, 0);
      } catch(e) { console.warn('PDF regular fail:', e); }
    }
    if (gaiLogs.length > 0 && appConfig.notifyPdfGai) {
      try {
        const html = buildReportHTML({ objectName: shift.objectName, date: shift.startDate, isClosed: true, logs: gaiLogs, activeLineIds, type: 'gai', checkTTN: null });
        const canvas = document.getElementById('draw-canvas-gai'); let finalHtml = html;
        if (canvas) finalHtml = `<div style="position:relative;"><img src="${canvas.toDataURL()}" style="position:absolute; top:0; left:0; width:100%; height:100%; z-index:100; pointer-events:none;"><div style="position:relative; z-index:1;">${html}</div></div>`;
        const blob = await generatePDFFromHTML(finalHtml, 'report_gai.pdf'); const b64 = await blobToBase64(blob);
        enqueueMaxDocument(`report_gai_${safeDate}.pdf`, b64, `📊 Отчет (ГАИ): ${shift.objectName} / ${shift.startDate}`, null, Date.now() + GAI_PDF_DELAY_MS);
      } catch(e) { console.warn('PDF gai fail:', e); }
    }
  }

  async function exportCurrentReportPDF(type) {
    if (!state.shift) { showError('Смена не начата'); return; }
    if (type === 'gai' && !hasPermission('view_gai_report')) { showError('Нет прав'); return; }
    const logs = getLogs().filter(l => type === 'gai' ? l.isGAI : !l.isGAI);
    if (!logs.length) { showError('Нет данных'); return; }
    try {
      showToastEl('⏳ Генерация PDF...', false);
      const html = buildReportHTML({ objectName: state.shift.objectName, date: state.shift.startDate, logs, activeLineIds: getActiveLineIds(), type, checkTTN: type === 'regular' ? (id, logId) => state.truckStatus[id] && state.truckStatus[id].ttnStatus === true && state.truckStatus[id].ttnLogId === logId : null });
      const canvas = document.getElementById(type === 'gai' ? 'draw-canvas-gai' : 'draw-canvas-main'); let finalHtml = html;
      if (canvas) finalHtml = `<div style="position:relative;"><img src="${canvas.toDataURL()}" style="position:absolute; top:0; left:0; width:100%; height:100%; z-index:100; pointer-events:none;"><div style="position:relative; z-index:1;">${html}</div></div>`;
      const blob = await generatePDFFromHTML(finalHtml, `report_${type}.pdf`); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `report_${type}_${Date.now()}.pdf`; a.click(); URL.revokeObjectURL(url); showToastEl('✅ PDF готов', false);
    } catch(e) { showError('Ошибка PDF: ' + e.message); }
  }
  async function sendActiveReportToMax() {
    if (!state.shift) { showError('Смена не начата'); return; }
    if (!appConfig.maxEnabled || !appConfig.maxUrl) { showError('Max не настроен'); return; }
    const type = showGAITable ? 'gai' : 'regular';
    const logs = getLogs().filter(l => type === 'gai' ? l.isGAI : !l.isGAI);
    if (!logs.length) { showError('Нет данных для отчета'); return; }
    showToastEl('⏳ Генерация PDF для Max...', false);
    try {
      const html = buildReportHTML({ objectName: state.shift.objectName, date: state.shift.startDate, logs, activeLineIds: getActiveLineIds(), type, checkTTN: type === 'regular' ? (id, logId) => state.truckStatus[id] && state.truckStatus[id].ttnStatus === true && state.truckStatus[id].ttnLogId === logId : null });
      const canvas = document.getElementById(type === 'gai' ? 'draw-canvas-gai' : 'draw-canvas-main'); let finalHtml = html;
      if (canvas) finalHtml = `<div style="position:relative;"><img src="${canvas.toDataURL()}" style="position:absolute; top:0; left:0; width:100%; height:100%; z-index:100; pointer-events:none;"><div style="position:relative; z-index:1;">${html}</div></div>`;
      const blob = await generatePDFFromHTML(finalHtml, `report_${type}.pdf`); const b64 = await blobToBase64(blob);
      const safeDate = String(state.shift.startDate || '').replace(/[^\w]/g, '_');
      enqueueMaxDocument(`report_${type}_${safeDate}.pdf`, b64, `📊 Отчет (${type === 'gai' ? 'ГАИ' : 'ОСНОВНЫЕ'}): ${state.shift.objectName} / ${state.shift.startDate}`, null, 0);
      showToastEl('✅ PDF в очереди Max', false);
    } catch(e) { showError('Ошибка: ' + e.message); }
  }
  async function exportArchivePDF() {
    const s = state.archive.find(x => x.id === viewingArchiveId); if (!s) return;
    const type = viewingArchiveGAITable ? 'gai' : 'regular';
    const logs = (s.logs || []).filter(l => type === 'gai' ? l.isGAI : !l.isGAI); if (!logs.length) { showError('Нет данных'); return; }
    try {
      showToastEl('⏳ Генерация PDF...', false);
      const html = buildReportHTML({ objectName: s.objectName, date: s.date, logs, activeLineIds: s.activeLineIds || [], type, isClosed: true, reportTtnStatus: s.ttnStatus || {}, checkTTN: type === 'regular' ? (id, logId, isLast) => s.ttnStatus && s.ttnStatus[id] && isLast : null });
      const canvas = document.getElementById('draw-canvas-archive'); let finalHtml = html;
      if (canvas) finalHtml = `<div style="position:relative;"><img src="${canvas.toDataURL()}" style="position:absolute; top:0; left:0; width:100%; height:100%; z-index:100; pointer-events:none;"><div style="position:relative; z-index:1;">${html}</div></div>`;
      const blob = await generatePDFFromHTML(finalHtml, `archive_${type}.pdf`); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `archive_${type}.pdf`; a.click(); URL.revokeObjectURL(url); showToastEl('✅ PDF готов', false);
    } catch(e) { showError('Ошибка PDF: ' + e.message); }
  }

  // === ОТЧЕТЫ РЕНДЕР ===
  function renderReport() {
    if (!hasTabAccess('report')) return; // === SECURITY ===
    if (!hasPermission('view_gai_report')) showGAITable = false;
    let pO = document.getElementById('paperObjectName'), pD = document.getElementById('paperDateTitle'), pV = document.getElementById('paperTotalVolume');
    let mB = document.getElementById('matrixTableBody'), mH = document.getElementById('matrixTableHeadRow'), lC = document.getElementById('logsContainer');
    let gaiO = document.getElementById('gaiObjectName'), gaiD = document.getElementById('gaiDateTitle'), gaiV = document.getElementById('gaiTotalTrips');
    let gaiB = document.getElementById('gaiTableBody'), gaiH = document.getElementById('gaiTableHeadRow');
    document.getElementById('paperReportWrapper').style.display = showGAITable ? 'none' : 'block';
    document.getElementById('gaiReportWrapper').style.display = showGAITable ? 'block' : 'none';
    document.getElementById('toggleReportBtn').textContent = '📄';
    pO.textContent = 'Объект: ' + (state.shift ? state.shift.objectName : '—'); pD.textContent = state.shift ? state.shift.startDate : '';
    gaiO.textContent = 'Объект: ' + (state.shift ? state.shift.objectName : '—'); gaiD.textContent = state.shift ? state.shift.startDate : '';
    if (!state.shift) { mB.innerHTML = '<tr><td colspan="11" style="text-align:center;">Нет смены</td></tr>'; gaiB.innerHTML = '<tr><td colspan="11" style="text-align:center;">Нет смены</td></tr>'; lC.innerHTML = '<div class="empty-state">Нет рейсов</div>'; pV.textContent='0 м³'; gaiV.textContent='0'; return; }
    let logs = getLogs(); let stdLogs = logs.filter(l=>!l.isGAI); let gaiLogs = logs.filter(l=>l.isGAI);
    let totV = stdLogs.reduce((s,l)=>s+l.volume,0); pV.textContent = totV + ' м³';
    let aIds = getActiveLineIds().filter(id => { let t = findTruck(id); return t && !t.isGAI; });
    let tIds = new Set(aIds); stdLogs.forEach(l=>tIds.add(l.truckId));
    let rTrucks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?f:{id, brand:'Машина', number:'', defaultVol:0}; });
    let fTime = {}; stdLogs.forEach(l=>{ if(fTime[l.truckId]===undefined || l.timestamp<fTime[l.truckId]) fTime[l.truckId]=l.timestamp; });
    rTrucks.sort((a,b)=> (fTime[a.id]||0) - (fTime[b.id]||0));
    let maxT = 8; rTrucks.forEach(t=>{ let c=stdLogs.filter(l=>l.truckId===t.id).length; if(c>maxT) maxT=c; });
    let hHtml = '<th>№</th><th style="text-align:left;">Самосвал</th>'; for(let i=1; i<=maxT; i++) hHtml += `<th>Рейс ${i}</th>`; mH.innerHTML = hHtml;
    mB.innerHTML = rTrucks.map((t, idx)=>{
      let tL = stdLogs.filter(l=>l.truckId===t.id).slice().reverse(), st = state.truckStatus[t.id]||{}, sum = tL.reduce((s,l)=>s+l.volume,0);
      let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? false : (tL.length > 0 && st.ttnStatus !== true);
      let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;">ДУБЛИКАТ</span>' : '';
      let cells = '';
      for(let i=0; i<maxT; i++) {
        if(tL[i]) {
          let cH = (st.ttnStatus === true && st.ttnLogId === tL[i].id) ? '<div class="hand-drawn-circle"></div>' : '';
          let commHtml = tL[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(tL[i].comment)}</div>` : '';
          cells += `<td><div class="cell-content">${cH}<div class="paper-time">${escapeHtml(tL[i].timeStr)}${tL[i].offlinePending?` <span title="Рейс сохранён на устройстве" style="color:#d97706;font-size:10px">☁</span>`:''} </div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(tL[i].createdByEmail, tL[i].createdBy))}</div>${commHtml}</div></td>`;
        }
        else if(i===tL.length && st.ttnStatus === 'pending') {
          let dotHtml = st.arriveStatus ? `<div class="paper-time">${escapeHtml(st.arriveStatus)}</div><div class="paper-dot">•</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(null, st.arriveBy))}</div>` : '';
          cells += `<td><div class="cell-content"><div class="hand-drawn-circle"></div>${dotHtml}</div></td>`;
        }
        else if(i===tL.length && st.arriveStatus) cells += `<td><div class="cell-content"><div class="paper-time">${escapeHtml(st.arriveStatus)}</div><div class="paper-dot">•</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(null, st.arriveBy))}</div></div></td>`;
        else cells += '<td></td>';
      }
      return `<tr><td style="font-weight:bold;">${idx+1}</td><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.brand)} <span class="paper-truck-volume">${sum} м³</span>${dupHtml}</div>${t.number?renderRussianPlate(t.number):''}</td>${cells}</tr>`;
    }).join('');
    gaiV.textContent = gaiLogs.length;
    let gaiLineIds = getActiveLineIds().filter(id => { let t = findTruck(id); return t && t.isGAI; });
    let gaiTIds = new Set(gaiLineIds); gaiLogs.forEach(l=>gaiTIds.add(l.truckId));
    let gaiTrucks = Array.from(gaiTIds).map(id=>{ let f=findTruck(id); return f?f:{id, brand:'Машина', number:'', defaultVol:0}; });
    let gaiFirstTime = {}; gaiLogs.forEach(l=>{ if(gaiFirstTime[l.truckId]===undefined || l.timestamp<gaiFirstTime[l.truckId]) gaiFirstTime[l.truckId]=l.timestamp; });
    gaiTrucks.sort((a,b)=> (gaiFirstTime[a.id]||0) - (gaiFirstTime[b.id]||0));
    let gaiMaxT = 8; gaiTrucks.forEach(t=>{ let c=gaiLogs.filter(l=>l.truckId===t.id).length; if(c>gaiMaxT) gaiMaxT=c; });
    let gaiHHtml = '<th>№</th><th style="text-align:left;">Самосвал</th>'; for(let i=1; i<=gaiMaxT; i++) gaiHHtml += `<th>Рейс ${i}</th>`; gaiH.innerHTML = gaiHHtml;
    gaiB.innerHTML = gaiTrucks.map((t, idx)=>{
      let tL = gaiLogs.filter(l=>l.truckId===t.id).slice().reverse();
      let st = state.truckStatus[t.id] || {};
      let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? false : (tL.length > 0 && st.ttnStatus !== true);
      let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;">ДУБЛИКАТ</span>' : '';
      let cells = '';
      for(let i=0; i<gaiMaxT; i++) {
        if(tL[i]) {
          let commHtml = tL[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(tL[i].comment)}</div>` : '';
          cells += `<td><div class="cell-content"><div class="paper-time">${escapeHtml(tL[i].timeStr)}${tL[i].offlinePending?` <span title="Рейс сохранён на устройстве" style="color:#d97706;font-size:10px">☁</span>`:''} </div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(tL[i].createdByEmail, tL[i].createdBy))}</div>${commHtml}</div></td>`;
        }
        else cells += '<td></td>';
      }
      return `<tr><td style="font-weight:bold;">${idx+1}</td><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.brand)} <span class="paper-truck-volume">Рейсов: ${tL.length}</span>${dupHtml}</div>${t.number?renderRussianPlate(t.number):''}</td>${cells}</tr>`;
    }).join('');
    let canEditL = hasPermission('edit_logs');
    lC.innerHTML = logs.length === 0 ? '<div class="empty-state">Нет рейсов</div>' : logs.map(l=>{
      let a = resolveUserDisplayName(l.createdByEmail, l.createdBy); let au = a ? ` · 👤 ${escapeHtml(a)}` : '';
      let volHtml = l.isGAI ? '<span style="color:#94a3b8;">(Рейс)</span>' : `<span style="color:var(--success);">+${l.volume} м³</span>`;
      let commHtml = l.comment ? `<div class="log-comment">💬 ${escapeHtml(l.comment)}</div>` : '';
      return `<div class="log-item"><div><div class="log-info">${truckLabelHtml(l.truckId, l.truckName)} — ${volHtml}</div><div class="log-meta">${escapeHtml(l.timeStr)}${au}${l.offlinePending?' · ☁️ офлайн':''}</div>${commHtml}</div>${canEditL&&!l.offlinePending?`<div style="display:flex;gap:6px;"><button class="btn-edit" onclick="openEditLog('${l.id}')">✏️</button><button class="btn-del" onclick="deleteLog('${l.id}')">X</button></div>`:''}</div>`;
    }).join('');
    setTimeout(() => { setupStylus('draw-canvas-main', 'paperReportContainer'); setupStylus('draw-canvas-gai', 'gaiPaperContainer'); }, 50);
  }
  function toggleReportType() { if (!hasPermission('view_gai_report')) { showError('Нет прав'); return; } showGAITable = !showGAITable; renderReport(); }
  function openEditLog(id) { if(!requireEdit('edit_logs')) return; let l=state.logs.find(x=>x.id===id); if(!l) return; editingLogId=id; document.getElementById('editLogTruckInfo').innerHTML=`<b>${escapeHtml(l.truckName)}</b>`; document.getElementById('editLogVolume').value=l.volume; document.getElementById('editLogTime').value=l.timeStr; document.getElementById('editLogComment').value=l.comment || ''; document.getElementById('editLogModal').classList.add('open'); }
  function closeEditLogModal() { document.getElementById('editLogModal').classList.remove('open'); editingLogId=null; }
  async function saveLogEdit() {
    if(!requireEdit('edit_logs') || !editingLogId) return;
    let l=state.logs.find(x=>x.id===editingLogId); if(!l) return closeEditLogModal();
    let v=parseFloat(document.getElementById('editLogVolume').value); let t=document.getElementById('editLogTime').value; let comm=document.getElementById('editLogComment').value.trim();
    if(isNaN(v)||v<0 || !/^\d{2}:\d{2}$/.test(t)) { appNotice('Проверьте правильность ввода объема и времени (ЧЧ:ММ)'); return; }
    let ts=l.timestamp; if(ts){ let d=new Date(ts), p=t.split(':'); d.setHours(p[0],p[1],0,0); ts=d.getTime(); }
    const logIdToSave = editingLogId;
    Object.assign(l, {volume:v, timeStr:t, timestamp:ts, comment:comm}); saveCache(); renderReport(); closeEditLogModal();
    tf((async()=>{ await refs.logs.doc(logIdToSave).update({volume:v, timeStr:t, timestamp:ts, comment:comm}); await addAudit('✏️ Изменён рейс: ' + l.truckName + ' · ' + v + ' м³ · ' + t, {eventType:'log_edit',logId:logIdToSave,truckId:l.truckId}); })());
    showToastEl('✅ Рейс обновлен', false);
  }
  async function deleteLog(id) { if(!requireEdit('edit_logs') || !(await appConfirm('Удалить?'))) return; state.logs=state.logs.filter(x=>x.id!==id); saveCache(); renderReport(); tf(refs.logs.doc(id).delete()); }

  function exportCSV() {
    if (!state.shift) return;
    let logs = getLogs(); if(!logs.length) return;
    let targetLogs = showGAITable ? logs.filter(l=>l.isGAI) : logs.filter(l=>!l.isGAI);
    let a = getActiveLineIds().filter(id => { let t = findTruck(id); return t && (showGAITable ? t.isGAI : !t.isGAI); });
    let rT = a.map(id=>findTruck(id)).filter(Boolean);
    let fT = {}; targetLogs.forEach(l=>{ if(fT[l.truckId]===undefined || l.timestamp<fT[l.truckId]) fT[l.truckId]=l.timestamp; });
    rT.sort((a,b)=>(fT[a.id]||0)-(fT[b.id]||0));
    let mT = 8; rT.forEach(t=>{ let c=targetLogs.filter(l=>l.truckId===t.id).length; if(c>mT) mT=c; });
    let csv = '\uFEFFsep=;\n';
    if (showGAITable) {
      csv += '№;Самосвал;Всего рейсов;'; for(let i=1; i<=mT; i++) csv+=`Рейс ${i};`; csv+='\n';
      rT.forEach((t, i)=>{ let tL = targetLogs.filter(l=>l.truckId===t.id).slice().reverse(); csv += `${i+1};"${t.brand} ${t.number}";${tL.length};`; for(let j=0; j<mT; j++) csv += tL[j] ? `${tL[j].timeStr}/${j+1}${tL[j].comment?'('+tL[j].comment+')':''};` : '-;'; csv += '\n'; });
    } else {
      csv += '№;Самосвал;Всего рейсов;Всего м3;'; for(let i=1; i<=mT; i++) csv+=`Рейс ${i};`; csv+='\n';
      rT.forEach((t, i)=>{ let tL = targetLogs.filter(l=>l.truckId===t.id).slice().reverse(), s = tL.reduce((x,l)=>x+l.volume,0); csv += `${i+1};"${t.brand} ${t.number}";${tL.length};${s};`; for(let j=0; j<mT; j++) csv += tL[j] ? `${tL[j].timeStr}/${j+1}${tL[j].comment?'('+tL[j].comment+')':''};` : '-;'; csv += '\n'; });
    }
    let b = new Blob([csv], {type:'text/csv;charset=utf-8;'}), u=URL.createObjectURL(b), aE=document.createElement('a');
    aE.href=u; aE.download= showGAITable ? 'report_gai.csv' : 'report.csv'; aE.click(); URL.revokeObjectURL(u);
    showToastEl('Скачан Excel', false);
  }

  // === АРХИВ ===
  const archiveExpandedObjects = new Set();
  let archiveExpandedInitialized = false;
  function toggleArchiveSearch() {
    const input=document.getElementById('archiveSearchInput'), button=document.getElementById('archiveSearchToggle');
    if(!input||!button)return;
    const opening=input.style.display==='none';
    input.style.display=opening?'block':'none';
    button.setAttribute('aria-expanded',String(opening));
    if(opening)input.focus();
    else {input.value='';renderArchive();}
  }
  function toggleArchiveObject(encodedName) {
    const name=decodeURIComponent(encodedName);
    if(archiveExpandedObjects.has(name))archiveExpandedObjects.delete(name);
    else archiveExpandedObjects.add(name);
    renderArchive();
  }
  function renderArchive() {
    if (!hasTabAccess('archive')) return; // === SECURITY ===
    let c = document.getElementById('archiveContainer'); let q = (document.getElementById('archiveSearchInput').value||'').toLowerCase();
    let f = state.archive.filter(s=>s.date?.toLowerCase().includes(q) || s.objectName?.toLowerCase().includes(q));
    if(!f.length) { c.innerHTML = '<div class="empty-state">Пусто</div>'; renderTrash(); return; }
    let g = {}; f.forEach(s=>{ let k=s.objectName||'—'; if(!g[k]) g[k]=[]; g[k].push(s); });
    if(!archiveExpandedInitialized){Object.keys(g).forEach(k=>archiveExpandedObjects.add(k));archiveExpandedInitialized=true;}
    c.innerHTML = Object.keys(g).map(k=>{ let l = g[k].sort((a,b)=>(b.closedAt||0)-(a.closedAt||0)); const expanded=archiveExpandedObjects.has(k)||!!q; return `<div class="archive-group"><button type="button" class="archive-group-header" style="width:100%;text-align:left;cursor:pointer;border:0;color:inherit" aria-expanded="${expanded}" onclick="toggleArchiveObject('${encodeURIComponent(k)}')">${expanded?'▾':'▸'} ${escapeHtml(k)} (${l.length})</button><div class="archive-shifts-list" style="display:${expanded?'':'none'}">${l.map(s=>{ let stdL = (s.logs||[]).filter(x=>!x.isGAI); let gaiL = (s.logs||[]).filter(x=>x.isGAI); let gaiHtml = gaiL.length > 0 ? ` | <span style="color:#cbd5e1;">ГАИ: ${gaiL.length} рейс.</span>` : ''; return `<div class="archive-shift-item" onclick="openArchiveModal('${s.id}')"><div>${escapeHtml(s.date)}</div><div>${stdL.length} рейсов | <b>${stdL.reduce((x,y)=>x+y.volume,0)} м³</b>${gaiHtml}</div></div>`; }).join('')}</div></div>`; }).join('');
    renderTrash();
    if(viewingArchiveId) { let s=state.archive.find(x=>x.id===viewingArchiveId); if(s) openArchiveModal(viewingArchiveId); else closeArchiveModal(); }
  }
  function renderTrash() { let c = document.getElementById('trashContainer'); if(!state.trash.length) { c.innerHTML=''; return; } let e = hasPermission('archive_edit'); c.innerHTML = `<div class="trash-group"><div class="trash-header">Корзина</div><div class="trash-list">${state.trash.map(i=>`<div class="trash-item"><div class="info"><b>${escapeHtml(i.shift.objectName)}</b> · ${escapeHtml(i.shift.date)}</div>${e?`<button class="btn-del" onclick="purgeFromTrash('${i.id}')">X</button>`:''}</div>`).join('')}</div></div>`; }
  async function purgeFromTrash(id) { if(!requireEdit('archive_delete') || !(await appConfirm('Удалить навсегда?'))) return; await tfAwait(refs.trash.doc(id).delete()); }
  function openArchiveModal(id) { let s = state.archive.find(x=>x.id===id); if(!s) return; viewingArchiveId=id; viewingArchiveGAITable = false; renderArchiveModalContent(s); document.getElementById('archiveModal').classList.add('open'); }
  let archiveHoldTimer=null;
  function cancelArchiveHold(){if(archiveHoldTimer!==null){clearTimeout(archiveHoldTimer);archiveHoldTimer=null;}}
  function startArchiveHold(event){
    if(event.type==='pointerdown' && event.button!==0)return;
    cancelArchiveHold();
    const button=event.currentTarget;
    archiveHoldTimer=setTimeout(()=>{
      archiveHoldTimer=null;
      if(button.isConnected && viewingArchiveId && hasTabAccess('archive'))toggleArchiveReportType();
    },800);
  }
  function archiveHoldKey(event){
    if(event.repeat || (event.key!==' ' && event.key!=='Enter'))return;
    event.preventDefault();startArchiveHold(event);
  }
  function toggleArchiveReportType() { viewingArchiveGAITable = !viewingArchiveGAITable; let s = state.archive.find(x=>x.id===viewingArchiveId); if (s) renderArchiveModalContent(s); }
  function renderArchiveModalContent(s) {
    if (!hasTabAccess('archive')) return; // === SECURITY ===
    let logs = s.logs || []; let stdLogs = logs.filter(l=>!l.isGAI); let gaiLogs = logs.filter(l=>l.isGAI);
    let tV = stdLogs.reduce((x,y)=>x+y.volume,0);
    document.getElementById('modalArchiveTitle').textContent = s.date;
    let e = hasPermission('archive_edit');
    document.getElementById('archiveRestoreBtn').style.display = e?'':'none';
    document.getElementById('archiveDeleteBtn').style.display = hasPermission('archive_delete')?'':'none';
    let toggleBtnHtml = `<div style="text-align:center; margin-bottom: 12px;"><button class="btn btn-secondary btn-small" style="min-width:135px;font-size:12px;touch-action:none;user-select:none" aria-label="Удерживайте 0,8 секунды для переключения листа" onpointerdown="startArchiveHold(event)" onpointerup="cancelArchiveHold()" onpointercancel="cancelArchiveHold()" onpointerleave="cancelArchiveHold()" oncontextmenu="event.preventDefault()" onkeydown="archiveHoldKey(event)" onkeyup="cancelArchiveHold()" onblur="cancelArchiveHold()">${viewingArchiveGAITable ? '📄 Обычный' : '📄 ГАИ'} · удерживать 0,8 с</button></div>`;
    let activeLineIds = s.activeLineIds || []; let ttnStatus = s.ttnStatus || {}; let html = '';
    if (!viewingArchiveGAITable) {
      let aIds = activeLineIds.filter(id => { let t = findTruck(id); return t && !t.isGAI; });
      let tIds = new Set(aIds); stdLogs.forEach(l=>tIds.add(l.truckId));
      let tks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?{id, name:f.brand+' '+f.number}:{id, name:(stdLogs.find(l=>l.truckId===id)?.truckName||'—')}; });
      let mT=8; tks.forEach(t=>{ let c=stdLogs.filter(l=>l.truckId===t.id).length; if(c>mT) mT=c; });
      let hC = ''; for(let i=1; i<=mT; i++) hC+=`<th>Рейс ${i}</th>`;
      let mH = tks.map(t=>{ let l = stdLogs.filter(x=>x.truckId===t.id).slice().reverse(), sm = l.reduce((x,y)=>x+y.volume,0), cells=''; let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (l.length > 0 && ttnStatus[t.id] !== true && ttnStatus[t.id] !== 'pending') : (l.length > 0 && !ttnStatus[t.id]); let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;">ДУБЛИКАТ</span>' : '';
        for(let i=0; i<mT; i++) { if(l[i]) { let isL=(i===l.length-1), cH = ttnStatus[t.id] && isL ? '<div class="hand-drawn-circle"></div>':''; let commHtml = l[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l[i].comment)}</div>` : ''; cells += `<td><div class="cell-content">${cH}<div class="paper-time">${escapeHtml(l[i].timeStr)}</div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l[i].createdByEmail, l[i].createdBy))}</div>${commHtml}</div></td>`; }
          else if (i === l.length && ttnStatus[t.id] === 'pending') { cells += `<td><div class="cell-content"><div class="hand-drawn-circle"></div></div></td>`; }
          else cells += '<td></td>';
        } return `<tr><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.name)} <span class="paper-truck-volume">${sm} м³</span>${dupHtml}</div></td>${cells}</tr>`; }).join('');
      html = `<div style="position:relative;" id="archive-paper-wrapper"><canvas id="draw-canvas-archive" class="stylus-canvas"></canvas><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(s.objectName)}</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div><div class="paper-total-info">Объем: <b>${tV} м³</b></div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th>${hC}</tr></thead><tbody>${mH}</tbody></table></div></div></div>`;
    } else {
      let aIds = activeLineIds.filter(id => { let t = findTruck(id); return t && t.isGAI; });
      let tIds = new Set(aIds); gaiLogs.forEach(l=>tIds.add(l.truckId));
      let tks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?{id, name:f.brand+' '+f.number}:{id, name:(gaiLogs.find(l=>l.truckId===id)?.truckName||'—')}; });
      let mT=8; tks.forEach(t=>{ let c=gaiLogs.filter(l=>l.truckId===t.id).length; if(c>mT) mT=c; });
      let hC = ''; for(let i=1; i<=mT; i++) hC+=`<th>Рейс ${i}</th>`;
      let mH = tks.map(t=>{ let l = gaiLogs.filter(x=>x.truckId===t.id).slice().reverse(), cells=''; let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (l.length > 0 && ttnStatus[t.id] !== true && ttnStatus[t.id] !== 'pending') : (l.length > 0 && !ttnStatus[t.id]); let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;">ДУБЛИКАТ</span>' : '';
        for(let i=0; i<mT; i++) { if(l[i]) { let commHtml = l[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l[i].comment)}</div>` : ''; cells += `<td><div class="cell-content"><div class="paper-time">${escapeHtml(l[i].timeStr)}</div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l[i].createdByEmail, l[i].createdBy))}</div>${commHtml}</div></td>`; }
          else cells += '<td></td>';
        } return `<tr><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.name)} <span class="paper-truck-volume">Рейсов: ${l.length}</span>${dupHtml}</div></td>${cells}</tr>`; }).join('');
      html = `<div style="position:relative;" id="archive-paper-wrapper"><canvas id="draw-canvas-archive" class="stylus-canvas"></canvas><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(s.objectName)} (ГАИ)</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div><div class="paper-total-info">Рейсов ГАИ: <b>${gaiLogs.length}</b></div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th>${hC}</tr></thead><tbody>${mH}</tbody></table></div></div></div>`;
    }
    document.getElementById('modalArchiveBody').innerHTML = toggleBtnHtml + html;
    setTimeout(() => { setupStylus('draw-canvas-archive', 'archive-paper-wrapper'); }, 100);
  }
  async function saveArchivePNG() {
    // Export the archive sheet that is currently displayed, not a re-sorted/rebuilt report.
    if (!hasTabAccess('archive') || !viewingArchiveId) return;
    const archiveId = viewingArchiveId;
    const isGAI = viewingArchiveGAITable;
    const archive = state.archive.find(s => s.id === archiveId);
    const modal = document.getElementById('archiveModal');
    const liveWrapper = modal?.querySelector('#modalArchiveBody #archive-paper-wrapper');
    const livePaper = liveWrapper?.querySelector('.paper-report-container');
    const button = modal?.querySelector('#archiveSavePngBtn, button[onclick="exportArchivePNG()"]');
    if (!archive || !livePaper || typeof window.html2pdf !== 'function') {
      showError('Экспорт изображения недоступен');
      return;
    }

    // Snapshot before any await: the user may switch dates or report types while PNG renders.
    const snapshot = liveWrapper.cloneNode(true);
    const sheet = snapshot.querySelector('.paper-report-container');
    const scroller = snapshot.querySelector('.paper-scroll-wrapper');
    const sourceCanvas = liveWrapper.querySelector('#draw-canvas-archive');
    const clonedCanvas = snapshot.querySelector('#draw-canvas-archive');
    const screenZoom = parseFloat(getComputedStyle(livePaper).zoom) || 1;
    // Preserve any handwritten marks; a cloned <canvas> does not copy its bitmap.
    if (sourceCanvas && clonedCanvas) {
      try {
        const drawing = document.createElement('img');
        const rect = sourceCanvas.getBoundingClientRect();
        drawing.src = sourceCanvas.toDataURL('image/png');
        drawing.style.cssText = 'position:absolute;left:0;top:0;z-index:100;pointer-events:none;width:' +
          (rect.width / screenZoom) + 'px;height:' + (rect.height / screenZoom) + 'px';
        clonedCanvas.replaceWith(drawing);
      } catch (e) { clonedCanvas.remove(); }
    }
    snapshot.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    snapshot.style.width = 'max-content';
    snapshot.style.maxWidth = 'none';
    snapshot.style.height = 'auto';
    if (scroller) {
      scroller.style.width = 'max-content';
      scroller.style.maxWidth = 'none';
      scroller.style.overflow = 'visible';
      scroller.style.height = 'auto';
      scroller.style.margin = '0';
    }
    sheet.style.zoom = '1';
    sheet.style.transform = 'none';
    sheet.style.transition = 'none';
    sheet.style.width = 'max-content';
    sheet.style.maxWidth = 'none';

    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:max-content;background:#fdfdfd;pointer-events:none;z-index:-1';
    holder.appendChild(snapshot);
    document.body.appendChild(holder);
    if (button) button.disabled = true;
    let worker;
    try {
      if (document.fonts?.ready) await Promise.race([
        document.fonts.ready, new Promise(resolve => setTimeout(resolve, 2500))
      ]);
      const table = snapshot.querySelector('.paper-table');
      const rootBounds = snapshot.getBoundingClientRect();
      const width = Math.ceil(Math.max(
        1, snapshot.scrollWidth, rootBounds.width, sheet.scrollWidth,
        table ? table.getBoundingClientRect().right - rootBounds.left + 12 : 0
      ));
      const height = Math.ceil(Math.max(1, snapshot.scrollHeight, rootBounds.height));
      // Fit very wide/long reports inside browser canvas limits without dropping trips.
      const scale = Math.min(2, Math.sqrt(16000000 / (width * height)), 8192 / width, 8192 / height);
      worker = window.html2pdf().set({
        margin: 0,
        pagebreak: { mode: [], before: [], after: [], avoid: [] },
        html2canvas: {
          scale, width, height, windowWidth: Math.max(window.innerWidth, width),
          windowHeight: Math.max(window.innerHeight, height),
          scrollX: 0, scrollY: 0, useCORS: true, logging: false, backgroundColor: '#fdfdfd'
        },
        jsPDF: { unit: 'px', format: 'a4' }
      }).from(snapshot).toContainer().then(function () {
        // html2pdf normally constrains its intermediate container to A4 width.
        // The PNG must instead cover the full rendered archive table.
        this.prop.container.style.width = width + 'px';
        this.prop.container.style.maxWidth = 'none';
        this.prop.container.style.height = 'auto';
        this.prop.container.style.overflow = 'visible';
      });
      const canvas = await worker.toCanvas().get('canvas');
      if (!canvas || canvas.width < width * scale * 0.97 ||
          canvas.height < height * scale * 0.97) {
        throw new Error('PNG получился обрезанным');
      }
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(result => result ? resolve(result) : reject(new Error('Браузер не смог создать PNG')), 'image/png')
      );
      const safeName = String(archive.objectName || 'Объект').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 70);
      const safeDate = String(archive.date || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url;
      link.download = safeName + '_' + safeDate + (isGAI ? '_ГАИ' : '') + '.png';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      showToastEl('Отчёт PNG сохранён', false);
    } catch (e) {
      console.warn('Archive PNG', e);
      showError('Не удалось сохранить PNG: ' + e.message);
    } finally {
      if (worker?.prop?.overlay?.parentNode) worker.prop.overlay.remove();
      holder.remove();
      if (button) button.disabled = false;
    }
  }
  function closeArchiveModal() {
    cancelArchiveHold();
    document.getElementById('archiveModal').classList.remove('open');
    viewingArchiveId=null;
  }
  async function restoreArchiveToShift() {
    if (!requireEdit('archive_edit') || !viewingArchiveId) return;
    const s = state.archive.find(x => x.id === viewingArchiveId); if (!s) return;
    const hasActive = state.shift && state.shift.isActive;
    const msg = hasActive ? `Активная смена "${state.shift.objectName}" будет заменена.\n\nВосстановить "${s.objectName}" от ${s.date}?` : `Восстановить смену "${s.objectName}" от ${s.date}?`;
    if (!(await appConfirm(msg))) return;
    try {
      showToastEl('⏳ Восстановление...', false);
      await cleanupOldShiftData(); await clearAllNotifications();
      const newSid = 'shift_' + Date.now();
      await tfAwait(refs.shift.set({ id: newSid, objectName: s.objectName, objectId: s.objectId || '', startDate: s.date, startedAt: Date.now(), startedBy: getUserName(), isActive: true, restoredFrom: viewingArchiveId }));
      const batch = db.batch(); const logsByTruck = {};
      (s.logs || []).forEach((l, idx) => { const lid = `load_${l.truckId}_${newSid}_${l.timestamp || Date.now()}_${idx}`; batch.set(refs.logs.doc(lid), { shiftId: newSid, truckId: l.truckId, truckName: l.truckName, volume: l.volume, timeStr: l.timeStr, timestamp: l.timestamp, createdBy: l.createdBy, createdByEmail: l.createdByEmail || '', isGAI: !!l.isGAI, comment: l.comment || '' }); if (!logsByTruck[l.truckId]) logsByTruck[l.truckId] = []; logsByTruck[l.truckId].push({ id: lid, ts: l.timestamp || 0 }); });
      const allIds = new Set(); (s.activeLineIds || []).forEach(id => allIds.add(id)); (s.logs || []).forEach(l => allIds.add(l.truckId));
      allIds.forEach(id => { const truckLogs = (logsByTruck[id] || []).slice().sort((a, b) => a.ts - b.ts); const lastLog = truckLogs[truckLogs.length - 1]; let ttnStatus = null, ttnLogId = null; if (s.ttnStatus && s.ttnStatus[id]) { ttnStatus = true; ttnLogId = lastLog ? lastLog.id : null; } batch.set(refs.truckStatus.doc(id), { id, shiftId: newSid, onLine: true, addedBy: getUserName(), addedAt: Date.now(), arriveStatus: null, arriveTimestamp: null, arriveBy: null, ttnStatus, ttnBy: null, ttnLogId, lastLoadTimestamp: lastLog ? lastLog.ts : null, lastLoadBy: null, lastLoadLogId:lastLog?lastLog.id:null, cycleRevision:0, loadedAfterArrive: false }); });
      await tfAwait(batch.commit()); await tfAwait(refs.archive.doc(viewingArchiveId).delete());
      addAudit(`♻️ Смена восстановлена из архива: ${s.objectName} (${s.date})`).catch(()=>{});
      closeArchiveModal(); showToastEl('✅ Смена восстановлена', false);
    } catch(e) { showError('Ошибка восстановления: ' + e.message); }
  }
  async function deleteArchiveShift() { if(!requireEdit('archive_delete') || !viewingArchiveId || !(await appConfirm('В корзину?'))) return; let s = state.archive.find(x=>x.id===viewingArchiveId); try { await tfAwait(refs.trash.doc().set({ shift: s, deletedAt: Date.now(), deletedBy: getUserName() })); await tfAwait(refs.archive.doc(viewingArchiveId).delete()); closeArchiveModal(); } catch(e){ showError(e.message); } }

  // === СЕЛЕКТОР ===
  function renderSelectorList() {
    let q = (document.getElementById('truckSearchInput').value||'').toLowerCase();
    let c = document.getElementById('selectorListContainer');
    let f = state.trucks.filter(t=>(t.brand+' '+t.number).toLowerCase().includes(q));
    let on = new Set(getActiveLineIds());
    let html = '';
    if(!f.length) {
      html += `<div class="empty-state">Ничего не найдено</div>`;
      if(q.length > 1) { html += `<div class="form-card" style="margin-top: 10px; border-color: var(--primary);"><div style="font-size: 14px; font-weight: 700; margin-bottom: 10px; color: var(--primary);">Добавить в базу и на линию:</div><div class="form-group"><input type="text" id="quickAddBrand" class="form-control" placeholder="Марка авто (напр. КАМАЗ)"></div><div class="form-group"><input type="text" id="quickAddNumber" class="form-control" placeholder="Госномер" value="${escapeHtml(q)}"></div><div class="form-group"><select id="quickAddType" class="form-control"><option value="regular">🚛 Обычный</option><option value="gai">🛣 ГАИ</option></select></div><div class="form-group" id="quickAddVolGroup"><input type="number" step="0.5" id="quickAddVol" class="form-control" placeholder="Объем кузова" value="20"></div><button class="btn btn-quick" style="width: 100%;" onclick="quickAddTruckToLine()">➕ Создать и выбрать</button></div>`; }
    } else {
      html += f.map(t=>{ let isO = on.has(t.id); let gaiTag = t.isGAI ? '<span style="font-size:10px;background:rgba(148,163,184,0.2);color:#cbd5e1;padding:1px 4px;border-radius:4px;margin-left:4px;">ГАИ</span>' : ''; let btn = hasPermission('edit_line') ? `<button class="btn btn-small ${isO?'btn-danger':'btn-quick'}" onclick="toggleLineTruck('${t.id}')">${isO?'Убрать':'Добавить'}</button>` : (isO?'✓':''); return `<div class="selector-item"><div><b>${escapeHtml(t.brand)}</b> ${renderRussianPlate(t.number)} ${gaiTag}</div>${btn}</div>`; }).join('');
    }
    c.innerHTML = html;
    let typeSelect = document.getElementById('quickAddType'); if(typeSelect) { typeSelect.addEventListener('change', (e) => { document.getElementById('quickAddVolGroup').style.display = e.target.value === 'gai' ? 'none' : 'block'; }); }
  }
  async function quickAddTruckToLine() {
    if(!requireEdit('manage_trucks') || !requireEdit('edit_line')) return;
    let brand = document.getElementById('quickAddBrand').value.trim();
    let num = document.getElementById('quickAddNumber').value.trim();
    let type = document.getElementById('quickAddType').value;
    let vol = parseFloat(document.getElementById('quickAddVol').value) || 0;
    let isGAI = type === 'gai';
    if(!brand || !num) { showError('Заполните марку и номер'); return; }
    try { let r = refs.trucks.doc(); await tfAwait(r.set({ brand, number: num, defaultVol: isGAI ? 0 : vol, isGAI, createdAt: Date.now(), createdBy: getUserName() })); await addTruckToLine(r.id); document.getElementById('truckSearchInput').value = ''; renderSelectorList(); }
    catch(e) { showError(e.message); }
  }
  function openSelectorModal() { if(!requireEdit('edit_line') || !state.shift) return; if(appConfig?.testReviewFlags?.selector_reset!==false){const search=document.getElementById('truckSearchInput');if(search)search.value='';} document.getElementById('selectorModal').classList.add('open'); renderSelectorList(); }
  function closeSelectorModal() { document.getElementById('selectorModal').classList.remove('open'); }
  async function toggleLineTruck(id) { if(!requireEdit('edit_line')) return; if(getActiveLineIds().includes(id)) await removeTruckFromLine(id); else await addTruckToLine(id); renderSelectorList(); }

  function renderGlobalTrucksManage() {
    if (!hasTabAccess('trucks')) return; // === SECURITY ===
    let c = document.getElementById('globalTrucksManageList'); if(!c) return; let e = hasPermission('manage_trucks');
    c.innerHTML = state.trucks.map(t=>{ let gaiTag = t.isGAI ? '<span style="font-size:10px;background:rgba(148,163,184,0.2);color:#cbd5e1;padding:2px 4px;border-radius:4px;margin-left:8px;">ГАИ</span>' : ''; let volText = t.isGAI ? '' : `(${t.defaultVol}м³)`; return `<div class="log-item"><div><b>${escapeHtml(t.brand)}</b> ${renderRussianPlate(t.number)} ${volText} ${gaiTag}</div>${e?`<div style="display:flex;gap:6px;"><button class="btn-edit" onclick="editGlobalTruck('${t.id}')">✏️</button><button class="btn-del" onclick="deleteGlobalTruck('${t.id}')">X</button></div>`:''}</div>`; }).join('');
  }
  function renderGlobalObjectsManage() {
    if (!hasTabAccess('trucks')) return; // === SECURITY ===
    let c = document.getElementById('globalObjectsManageList'); if(!c) return; let e = hasPermission('manage_objects');
    c.innerHTML = state.objects.map(o=>`<div class="log-item"><div>${escapeHtml(o.name)}</div>${e?`<div style="display:flex;gap:6px;"><button class="btn-edit" onclick="editGlobalObject('${o.id}')">✏️</button><button class="btn-del" onclick="deleteGlobalObject('${o.id}')">X</button></div>`:''}</div>`).join('');
  }
  function switchBaseSubTab(n) {
    document.getElementById('subBtnTrucks').style.background = n==='trucks'?'var(--primary)':'var(--border)';
    document.getElementById('subBtnObjects').style.background = n==='objects'?'var(--primary)':'var(--border)';
    document.getElementById('subtab-trucks').style.display = n==='trucks'?'block':'none';
    document.getElementById('subtab-objects').style.display = n==='objects'?'block':'none';
  }

  const TEST_GAME_MODE_KEY='samosval_test_game_mode_visible_v1';
  function testGameModeVisible(){
    try{return localStorage.getItem(TEST_GAME_MODE_KEY)==='1';}catch(e){return false;}
  }
  function toggleTestGameMode(visible){
    if(!canAdmin())return;
    try{localStorage.setItem(TEST_GAME_MODE_KEY,visible?'1':'0');}
    catch(e){showError('Не удалось сохранить настройку на этом устройстве');return;}
    renderAnalytics();
  }
  function renderAnalytics() {
    if (!hasTabAccess('analytics')) return; // === SECURITY ===
    let c = document.getElementById('auditLogContainer'); if(!c) return;
    c.innerHTML = renderAuditEntries();
    const controls=document.getElementById('testGameModeControls');
    const details=document.getElementById('testActivityCoinsDetails');
    const visible=testGameModeVisible();
    if(controls)controls.style.display='none';
    const checkbox=document.getElementById('testGameModeEnabled');
    if(checkbox)checkbox.checked=visible;
    if(details)details.hidden=true;
    const host=document.getElementById('userActivityRanking');
    if(host) {
      const records=Array.isArray(state.audit)?state.audit:[];
      const unique=new Set(),users=new Map(),gameEvents=[];
      for(const event of records){
        if(!event || !event.id || unique.has(event.id))continue;
        unique.add(event.id);
        const type=String(event.eventType||event.type||'').toLowerCase();
        const arrive=/^(arrive|arrival|truck_arrive)$/.test(type);
        const load=/^(load|loading|truck_load)$/.test(type);
        if(!arrive && !load)continue;
        gameEvents.push({type,arrive,load,at:Number(event.timestamp||0),shiftId:String(event.shiftId||''),truckId:String(event.truckId||''),user:String(event.userEmail||event.createdByEmail||event.uid||'').trim(),id:event.id});
        const key=String(event.userEmail||event.createdByEmail||event.uid||'').trim();
        if(!key)continue;
        const row=users.get(key)||{name:resolveUserDisplayName(key,event.userName)||key,arrivals:0,loads:0};
        if(arrive)row.arrivals++;else row.loads++;
        users.set(key,row);
      }
      const sorted=[...users.values()].sort((a,b)=>(b.arrivals+b.loads)-(a.arrivals+a.loads)||a.name.localeCompare(b.name,'ru'));
      const gameHost=document.getElementById('testActivityCoins');
      if(gameHost){
        const loaded=new Set(),points=new Map();
        for(const event of gameEvents.sort((a,b)=>a.at-b.at||String(a.id).localeCompare(String(b.id)))){
          if(!event.shiftId||!event.truckId||!event.user)continue;
          const key=event.shiftId+'|'+event.truckId;
          const value=event.load?1:(loaded.has(key)?2:0);
          if(value)points.set(event.user,(points.get(event.user)||0)+value);
          if(event.load)loaded.add(key);
        }
        const board=[...points.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ru'));
        gameHost.innerHTML='<p style="font-size:12px;color:var(--muted)">Пробный расчёт по последним '+records.length+' загруженным записям: погрузка — 1, возвращение после погрузки — 2, первый приезд — 0. История может быть неполной, отмены и штрафы пока не учтены. Очки не сохраняются в базу.</p>'
        +(board.length?'<ol style="padding-left:24px;margin-top:8px">'+board.map(([email,coins])=>'<li>'+escapeHtml(resolveUserDisplayName(email,email))+' — <b>'+coins+'</b> 🪙</li>').join('')+'</ol>':'<p>Нет подходящих событий для расчёта.</p>');
      }
      host.innerHTML='<p style="font-size:12px;color:var(--muted);margin-bottom:8px">На основе последних '+records.length+' событий аудита; не полный рейтинг за всё время.</p>'
        +(sorted.length?'<div style="overflow-x:auto"><table class="paper-table" style="width:100%"><thead><tr><th>Пользователь</th><th>Приезды</th><th>Погрузки</th><th>Всего</th></tr></thead><tbody>'+sorted.map(row=>'<tr><td>'+escapeHtml(row.name)+'</td><td>'+row.arrivals+'</td><td>'+row.loads+'</td><td><b>'+(row.arrivals+row.loads)+'</b></td></tr>').join('')+'</tbody></table></div>':'<div class="empty-state">Нет распознанных событий приезда или погрузки в загруженном аудите</div>');
    }
  }
  function exportBackupFile() {
    if (!hasPermission('import_backup') && !canAdmin()) return;
    try { let data = { exportedAt: Date.now(), version: 2.88, trucks: state.trucks, objects: state.objects, archive: state.archive }; let blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); let url = URL.createObjectURL(blob); let a = document.createElement('a'); a.href = url; a.download = 'trucks_backup_' + new Date().toISOString().slice(0,10) + '.json'; a.click(); URL.revokeObjectURL(url); showToastEl('Бэкап скачан', false); }
    catch(e) { showError(e.message); }
  }
  async function importBackupFile(ev) {
    if (!hasPermission('import_backup') && !canAdmin()) return;
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const sections = [['trucks', refs.trucks], ['objects', refs.objects], ['archive', refs.archive]];
      if (!data || typeof data !== 'object' || !sections.some(([name]) => Array.isArray(data[name]))) {
        throw new Error('Файл не похож на резервную копию программы');
      }
      for (const [name] of sections) {
        if (data[name] !== undefined && !Array.isArray(data[name])) throw new Error('Неверный раздел: ' + name);
      }
      const counts = sections.map(([name]) => name + ': ' + (data[name] || []).length).join('\\n');
      if (!(await appConfirm('Импорт добавит или обновит записи по ID, но не удалит существующие.\\n' + counts + '\\nПродолжить?'))) return;
      let batch = db.batch(), pending = 0, written = 0;
      for (const [name, ref] of sections) {
        for (const item of (data[name] || [])) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Некорректная запись: ' + name);
          const id = item.id ? String(item.id) : ref.doc().id;
          const copy = Object.assign({}, item);
          delete copy.id;
          batch.set(ref.doc(id), copy, { merge: true });
          pending++;
          if (pending >= 400) { await tfAwait(batch.commit()); written += pending; batch = db.batch(); pending = 0; }
        }
      }
      if (pending) { await tfAwait(batch.commit()); written += pending; }
      showToastEl('Импорт завершён. Записей обработано: ' + written, false);
    } catch(e) { showError('Ошибка импорта: ' + e.message); }
    finally { ev.target.value = ''; }
  }

  // === СМЕНЫ ===
  async function startShiftWithObject(objName, objId) {
    if (!requireEdit('start_shift')) return;
    if(offlinePendingCount()){showError('Сначала синхронизируйте действия предыдущей смены');return;}
    try {
      await cleanupOldShiftData(); await clearAllNotifications();
      let sid = 'shift_' + Date.now();
      await tfAwait(refs.shift.set({ id: sid, objectName: objName, objectId: objId||'', startDate: nowDateStr(), startedAt: Date.now(), startedBy: getUserName(), isActive: true }));
      if (appConfig.maxEnabled && appConfig.notifyStart) enqueueMax(`🚀 Смена начата\n🏢 ${objName}\n📅 ${nowDateStr()}\n👤 ${getUserName()}`);
      addAudit(`🚀 Начата смена на объекте: ${objName}`).catch(()=>{});
      closeStartShiftModal(); showToastEl('Смена начата', false);
    } catch(e){ showError(e.message); }
  }
  async function cleanupOldShiftData(){
    for(const collection of [refs.logs,refs.truckStatus]){
      const snap=await collection.get({source:'server'});
      if(snap.size){const batch=db.batch();snap.forEach(d=>batch.delete(d.ref));await tfAwait(batch.commit());}
    }
  }
  function recordedTripReturn(log, logs, status, shiftId) {
    const start = Number(log.timestamp);
    const next = logs.filter(l => l.truckId === log.truckId && Number(l.timestamp) > start).sort((a,b) => Number(a.timestamp)-Number(b.timestamp))[0];
    const st = status[log.truckId];
    const end = Number(log.returnedAt) || (next ? Number(next.arrivalTimestamp) : st && (!st.shiftId || st.shiftId === shiftId) ? Number(st.arriveTimestamp) : 0);
    return start > 0 && end > start && end <= Date.now() && (!next || end <= Number(next.timestamp)) ? end : null;
  }
  async function closeShift() {
    if (!requireEdit('close_shift')) return;
    if (!state.shift || !state.shift.isActive) { appNotice('Смена не начата'); return; }
    if(offlinePendingCount()){showError('Сначала синхронизируйте действия перед закрытием смены');return;}
    let logs = getLogs(); if (!(await appConfirm('Закрыть смену?'))) return;
    try {
      if (logs.length > 0) {
        let ttn={}, line=[];
        Object.keys(state.truckStatus).forEach(id=>{ let st=state.truckStatus[id]; if(st.onLine) line.push(id); if(st.ttnStatus!==undefined && st.ttnStatus!==null) ttn[id]=st.ttnStatus; });
        let totVol = logs.filter(l=>!l.isGAI).reduce((s,l)=>s+l.volume,0);
        await tfAwait(refs.archive.doc().set({ sourceShiftId: state.shift.id, objectName: state.shift.objectName, objectId: state.shift.objectId || '', date: state.shift.startDate, closedAt: Date.now(), closedBy: getUserName(), logs: logs.map(l=>({truckId:l.truckId, truckName:l.truckName, volume:l.volume, timeStr:l.timeStr, timestamp:l.timestamp, arrivalTimestamp:Number(l.arrivalTimestamp)||null, returnedAt:recordedTripReturn(l, logs, state.truckStatus, state.shift.id), createdBy:l.createdBy, createdByEmail:l.createdByEmail||'', isGAI:l.isGAI, comment:l.comment||''})), activeLineIds: line, ttnStatus: ttn, totalVolume: totVol, totalTrips: logs.filter(l=>!l.isGAI).length }));
        addAudit(`🔄 Закрыта смена. Рейсов: ${logs.filter(l=>!l.isGAI).length}`).catch(()=>{});
      }
      if (appConfig.maxEnabled && appConfig.maxUrl && logs.length > 0) await sendShiftReportToMax(state.shift, logs);
      await cleanupOldShiftData(); await clearAllNotifications(); await tfAwait(refs.shift.delete()); showToastEl('Смена закрыта', false);
    } catch(e){ showError(e.message); }
  }
  function openStartShiftModal() {
    if (!requireEdit('start_shift')) return;
    let c = document.getElementById('existingObjectsList');
    let objs = state.objects.slice().sort((a,b)=>a.name.localeCompare(b.name));
    c.innerHTML = objs.length === 0 ? '<div style="color:var(--muted);font-size:12px;">Нет объектов</div>' : objs.map(o=>`<div style="background:var(--bg);padding:10px;border-radius:8px;margin-bottom:6px;border:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;"><span>🏢 <b>${escapeHtml(o.name)}</b></span><button class="btn btn-quick btn-small" onclick="startShiftFromBase('${o.id}')">Выбрать</button></div>`).join('');
    document.getElementById('newObjectNameInput').value = ''; document.getElementById('startShiftModal').classList.add('open');
  }
  function closeStartShiftModal() { document.getElementById('startShiftModal').classList.remove('open'); }
  async function startShiftFromBase(id) { let o=state.objects.find(x=>x.id===id); if(o) await startShiftWithObject(o.name, o.id); }
  async function confirmStartShift() {
    if (!requireEdit('start_shift')) return; let n = document.getElementById('newObjectNameInput').value.trim(); if (!n) { appNotice('Введите имя'); return; }
    let ex = state.objects.find(o=>o.name.toLowerCase()===n.toLowerCase());
    if (ex) await startShiftWithObject(ex.name, ex.id);
    else { try { let r=refs.objects.doc(); await tfAwait(r.set({name:n, createdAt:Date.now(), createdBy:getUserName()})); await startShiftWithObject(n, r.id); } catch(e){ showError(e.message); } }
  }
  function openChangeObjectModal() {
    if (!requireEdit('edit_line') || !state.shift) return;
    let c = document.getElementById('changeObjList');
    c.innerHTML = state.objects.map(o=>{ let isC = state.shift.objectId === o.id || state.shift.objectName === o.name; return `<div style="background:var(--bg);padding:10px;border-radius:8px;margin-bottom:6px;border:1px solid ${isC?'var(--success)':'var(--border)'};display:flex;justify-content:space-between;align-items:center;"><span>🏢 <b>${escapeHtml(o.name)}</b> ${isC?'(текущий)':''}</span><button class="btn btn-quick btn-small" onclick="applyChangeObject('${o.id}')">Выбрать</button></div>`; }).join('');
    document.getElementById('changeObjCustomInput').value = ''; document.getElementById('changeObjectModal').classList.add('open');
  }
  function closeChangeObjectModal() { document.getElementById('changeObjectModal').classList.remove('open'); }
  async function applyChangeObject(id) { let o = state.objects.find(x=>x.id===id); if(!o || !state.shift) return; if (state.shift.objectId === id) { closeChangeObjectModal(); return; } try { await tfAwait(refs.shift.update({objectId:o.id, objectName:o.name})); addAudit(`🏢 Изменен объект: ${o.name}`).catch(()=>{}); closeChangeObjectModal(); showToastEl('Объект изменен', false); } catch(e){ showError(e.message); } }
  async function confirmChangeObject() {
    let n = document.getElementById('changeObjCustomInput').value.trim();
    if (n) { let ex = state.objects.find(o=>o.name.toLowerCase()===n.toLowerCase()); if(ex) await applyChangeObject(ex.id); else { try { let r=refs.objects.doc(); await tfAwait(r.set({name:n, createdAt:Date.now(), createdBy:getUserName()})); await applyChangeObject(r.id); } catch(e){ showError(e.message); } } } else appNotice('Выберите объект');
  }

  // === ЛИНИЯ ===
  async function addTruckToLine(id) {
    if (!requireEdit('edit_line') || !state.shift) return;
    let ex = state.truckStatus[id];
    let d = { id, shiftId: state.shift.id, onLine: true, addedBy: getUserName(), addedAt: Date.now(), arriveStatus: null, arriveTimestamp: null, arriveBy: null, ttnStatus: null, ttnBy: null, ttnLogId: null, lastLoadTimestamp: null, lastLoadBy: null, lastLoadLogId:null, cycleRevision:0, loadedAfterArrive: false };
    state.truckStatus[id] = d; offlineRemoteStatuses[id]={...d};saveCache(); renderLine(); renderHeaderStats();
    tf((async ()=>{ if(ex) await refs.truckStatus.doc(id).update(d); else await refs.truckStatus.doc(id).set(d); })());
    if (appConfig.maxEnabled && appConfig.notifyLineStart) { let t = findTruck(id); if (t) enqueueMax(`🟢 На линию добавлен\n🚛 ${t.number}\n👤 ${getUserName()}`); }
    addAudit(`🚛 На линию добавлен: ${truckName(id)}`).catch(()=>{});
  }
  async function removeTruckFromLine(id) {
    if (!requireEdit('edit_line')) return;
    if(offlinePendingForTruck(id)){showError('Сначала синхронизируйте действия этого самосвала');return;}
    let tName = truckName(id);
    delete state.truckStatus[id];delete offlineRemoteStatuses[id];saveCache(); renderLine(); renderHeaderStats(); tf(refs.truckStatus.doc(id).delete());
    if (appConfig.maxEnabled && appConfig.notifyLineEnd) enqueueMax(`🔴 С линии убран\n🚛 ${tName}\n👤 ${getUserName()}`);
    addAudit(`🚛 С линии убран: ${tName}`).catch(()=>{});
  }
  const truckStatusWrites = Object.create(null);
  function robustTruckStatusUpdate(id, upd) {
    const previous = truckStatusWrites[id] || Promise.resolve();
    const task = previous.catch(() => {}).then(() => persistTruckStatusUpdate(id, upd));
    truckStatusWrites[id] = task;
    task.then(() => { if (truckStatusWrites[id] === task) delete truckStatusWrites[id]; },
      () => { if (truckStatusWrites[id] === task) delete truckStatusWrites[id]; });
    return task;
  }
  async function persistTruckStatusUpdate(id, upd) {
    pendingStart();
    try { if (!navigator.onLine) { try { await refs.truckStatus.doc(id).update(upd); } catch(e){ if(e.code!=='not-found') throw e; let st=state.truckStatus[id]||{}; await refs.truckStatus.doc(id).set(Object.assign({id, onLine:true, shiftId:state.shift?.id}, st, upd)); } return; }
      let lastE; for(let i=0; i<3; i++) { try { await refs.truckStatus.doc(id).update(upd); return; } catch(e){ lastE=e; if(e.code==='not-found'){ let st=state.truckStatus[id]||{}; try{ await refs.truckStatus.doc(id).set(Object.assign({id, onLine:true, shiftId:state.shift?.id}, st, upd)); return; }catch(e2){lastE=e2;} } if(i<2) await new Promise(r=>setTimeout(r,400)); } }
      throw lastE;
    } finally { pendingEnd(); }
  }
  // All line actions use the server state; failed writes never restore stale local copies.
  const lineActionInFlight = Object.create(null);
  const truckServerRevisions = Object.create(null);
  let logServerRevision = 0;
  function captureLineIntent(id) {
    const status=state.truckStatus[id];
    return status&&state.shift?{shiftId:state.shift.id,status:{...status},revision:truckServerRevisions[id]||0,logRevision:logServerRevision}:null;
  }
  function signalLineTransition(id,before,after) {
    if(!before||!after||!after.onLine||!state.shift||after.shiftId!==state.shift.id)return;
    if(after.lastLoadTimestamp && after.lastLoadTimestamp!==before.lastLoadTimestamp && !after.arriveStatus){
      window.__cardJustLoaded={id,time:Date.now()};window.__cardJustArrived=null;
    }else if(after.arriveTimestamp && after.arriveTimestamp!==before.arriveTimestamp){
      window.__cardJustArrived={id,wasFaded:before.ttnStatus===true&&!before.arriveStatus,time:Date.now()};window.__cardJustLoaded=null;
    }
  }
  function refreshLineViews(){
    saveCache();renderLine();renderHeaderStats();renderStatusTicker();
    scheduleRenderForTab('report','renderReport');scheduleRenderForTab('analytics','renderAnalytics');
  }
  function acceptLineResult(id,result,intent) {
    if(!state.shift||state.shift.id!==intent.shiftId)return;
    if(result.status && (truckServerRevisions[id]||0)===intent.revision){
      signalLineTransition(id,state.truckStatus[id],result.status);
      state.truckStatus[id]={id,...result.status};offlineRemoteStatuses[id]={id,...result.status};
      truckServerRevisions[id]=(truckServerRevisions[id]||0)+1;
    }
    if(result.log && logServerRevision===intent.logRevision){
      state.logs=state.logs.filter(l=>l.id!==result.log.id);state.logs.unshift(result.log);
      state.logs.sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));confirmedLoadIds.add(result.log.id);
      offlineRemoteLogs=offlineRemoteLogs.filter(l=>l.id!==result.log.id);offlineRemoteLogs.push(result.log);
    }
    if(syncState.errors)delete syncState.errors[result.type];
    refreshLineViews();updateSyncUI();
  }
  function mergeCachedTruckStatus(remote,recent){
    if(!recent||recent.shiftId!==remote.shiftId)return remote;
    const merged=Number(recent.cycleRevision||0)>Number(remote.cycleRevision||0)?{...recent}:{...remote};
    const a=Number(recent.ttnRevision||0),b=Number(remote.ttnRevision||0),ttn=a>b?recent:a<b?remote:merged;
    for(const key of ['ttnStatus','ttnBy','ttnLogId','ttnRevision']){if(Object.hasOwn(ttn,key))merged[key]=ttn[key];else delete merged[key];}
    return merged;
  }

  function receiveTruckStatuses(snapshot){
    markSync('status',snapshot.metadata.fromCache,snapshot.metadata.hasPendingWrites,snapshot.size);
    if(snapshot.metadata.hasPendingWrites)return;
    const next={};snapshot.forEach(doc=>{next[doc.id]={id:doc.id,...doc.data()};});
    if(snapshot.metadata.fromCache)Object.keys(next).forEach(id=>{
      next[id]=mergeCachedTruckStatus(next[id],offlineRemoteStatuses[id]);
    });
    const old=state.truckStatus;offlineRemoteStatuses=next;offlineProjectState();
    Object.keys(state.truckStatus).forEach(id=>{
      if(JSON.stringify(old[id])!==JSON.stringify(state.truckStatus[id])){
        signalLineTransition(id,old[id],state.truckStatus[id]);
        truckServerRevisions[id]=(truckServerRevisions[id]||0)+1;
      }
    });
    Object.keys(old).filter(id=>!state.truckStatus[id]).forEach(id=>truckServerRevisions[id]=(truckServerRevisions[id]||0)+1);
    refreshLineViews();
  }
  function receiveLoadLogs(snapshot){
    markSync('logs',snapshot.metadata.fromCache,snapshot.metadata.hasPendingWrites,snapshot.size);
    if(snapshot.metadata.hasPendingWrites)return;
    logServerRevision++;
    const next=snapshot.docs.map(doc=>({id:doc.id,...doc.data()})).sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
    if(snapshot.metadata.fromCache){
      const included=new Set(next.map(l=>l.id));
      for(const log of offlineRemoteLogs)if(!included.has(log.id))next.push(log);
    }
    offlineRemoteLogs=next;confirmedLoadIds=new Set(offlineRemoteLogs.map(l=>l.id));
    offlineProjectState();refreshLineViews();
  }
  async function readLineState(tx,id,shiftId){
    const shift=await tx.get(refs.shift),status=await tx.get(refs.truckStatus.doc(id));
    if(!shift.exists||shift.data().id!==shiftId||shift.data().isActive===false)throw {code:'shift-changed',message:'Смена изменилась. Данные обновляются; повторите действие в текущей смене'};
    if(!status.exists||status.data().shiftId!==shiftId||!status.data().onLine)throw {code:'not-on-line',message:'Самосвал уже снят с этой линии'};
    return status.data();
  }
  function previousLoadSnapshot(s){return {wasArrived:!!s.arriveStatus,prevArriveStatus:s.arriveStatus||null,prevArriveTs:s.arriveTimestamp||null,prevArriveBy:s.arriveBy||null,prevLoadTs:s.lastLoadTimestamp||null,prevLoadBy:s.lastLoadBy||null,prevLoadLogId:s.lastLoadLogId||null,prevTtn:s.ttnStatus??null,prevTtnBy:s.ttnBy||null,prevTtnLogId:s.ttnLogId||null};}
  async function findWinningLoad(tx,id,shiftId,status){
    if(!status.lastLoadTimestamp)return null;
    const candidates=[status.lastLoadLogId,...state.logs.filter(l=>l.truckId===id&&l.shiftId===shiftId&&Number(l.timestamp)===Number(status.lastLoadTimestamp)).map(l=>l.id),`load_${id}_${shiftId}_${status.lastLoadTimestamp}`].filter(Boolean);
    for(const logId of [...new Set(candidates)].slice(0,3)){
      const log=await tx.get(refs.logs.doc(logId));
      if(log.exists&&log.data().truckId===id&&log.data().shiftId===shiftId&&Number(log.data().timestamp)===Number(status.lastLoadTimestamp))return {id:log.id,...log.data()};
    }
    return null;
  }
  async function recoverLineState(id,intent){
    try{
      const snap=await refs.truckStatus.doc(id).get({source:'server'});
      if(snap.exists)acceptLineResult(id,{status:snap.data(),type:'load'},intent);
    }catch(_){}
  }
  // TEST ONLY. Persistent, optimistic offline actions; server remains authoritative.
  const offlineJournalKey=()=> 'samosval_offline_v1_'+firebaseConfig.projectId+'_'+WORKSPACE_ID+'_'+currentUid;
  let offlineReplayRunning=false,offlineRemoteStatuses={},offlineRemoteLogs=[];
  function offlineJournalRead(){
    if(!currentUid)return [];
    try{const a=JSON.parse(localStorage.getItem(offlineJournalKey())||'[]');return Array.isArray(a)?a.filter(x=>x&&x.id&&x.shiftId&&x.truckId):[];}catch(e){console.error(e);return [];}
  }
  function offlineJournalWrite(items){localStorage.setItem(offlineJournalKey(),JSON.stringify(items));updateSyncUI();}
  function offlinePendingOps(){return offlineJournalRead().filter(x=>x.status==='pending');}
  function offlinePendingForTruck(id){return offlinePendingOps().some(x=>x.truckId===id&&state.shift&&x.shiftId===state.shift.id);}
  function offlinePendingCount(){return offlinePendingOps().length;}
  // navigator.onLine is only a browser hint. Firestore may be unreachable even
  // while it remains true (Wi-Fi without internet, DNS failure, captive portal).
  let offlineServerRetryAt=0,offlineServerRetryDelay=0,offlineServerUnreachable=false;
  function offlineTransportError(e){
    const code=String(e?.code||'').toLowerCase(),message=String(e?.message||'').toLowerCase();
    return ['unavailable','deadline-exceeded','network-request-failed','resource-exhausted'].includes(code)
      || /connection failed|failed to fetch|network error|network request failed/.test(message);
  }
  function offlineTransportFailed(error){
    offlineServerUnreachable=true;
    offlineServerRetryDelay=Math.min(60000,offlineServerRetryDelay?offlineServerRetryDelay*2:4000);
    offlineServerRetryAt=Date.now()+offlineServerRetryDelay;
    console.warn('[offline] Сервер недоступен, локальная очередь сохранена:',error?.code||error?.message||error);
    updateSyncUI();
  }
  function offlineTransportRecovered(){
    if(!offlineServerUnreachable&&!offlineServerRetryAt)return;
    offlineServerUnreachable=false;offlineServerRetryAt=0;offlineServerRetryDelay=0;
    updateSyncUI();
  }
  function offlineUnreviewedFailures(){return offlineJournalRead().filter(x=>x.status==='rejected'&&!x.reviewed);}
  function offlineReasonLabel(reason,details){
    if(appConfig.testReviewFlags?.conflict_author!==false&&details)return details;
    const reasons={
      'arrival-changed':'Прибытие уже изменено другим оператором',
      'duplicate-or-arrival-changed':'Погрузка уже учтена или прибытие изменилось. Лишний рейс не добавлен',
      'previous-action-rejected':'Предыдущее действие не подтверждено сервером',
      'cycle-time':'Не истекло установленное время ходки',
      'ttn-changed':'Статус ТТН изменён другим оператором',
      'duplicate':'Повторный рейс не добавлен',
      'already-exists':'Рейс с таким номером уже существует',
      'shift-changed':'Смена завершена или изменена',
      'not-on-line':'Самосвал снят с линии'
    };
    return reasons[reason]||('Ошибка: '+String(reason||'неизвестная'));
  }
  // Explain only the authoritative transaction result. No extra network read,
  // and no attribution to the current user or to a newer, unrelated load.
  function offlineConflictDetails(op,result){
    const s=result.status||{},record=result.winningLog;
    let action='',actor='',at=0;
    if(result.reason==='duplicate'&&record&&record.truckId===op.truckId&&record.shiftId===op.shiftId&&Number(record.arrivalTimestamp||0)===Number(op.arrivalTimestamp||0)){
      action='Погрузка';actor=record.createdBy;at=record.timestamp;
    }else if(['arrival-changed','duplicate-or-arrival-changed'].includes(result.reason)){
      if(s.arriveStatus&&Number(s.arriveTimestamp||0)!==Number(op.arrivalTimestamp||0)){
        action='Приехал';actor=s.arriveBy;at=s.arriveTimestamp;
      }else if(s.loadedAfterArrive&&Number(s.lastLoadTimestamp||0)!==Number(op.lastLoadTimestamp||0)){
        action='Погрузка';actor=s.lastLoadBy;at=s.lastLoadTimestamp;
      }
    }else if(result.reason==='ttn-changed'&&s.ttnStatus){
      action='Забрал ТТН';actor=s.ttnBy;
    }
    if(!['duplicate','arrival-changed','duplicate-or-arrival-changed','ttn-changed'].includes(result.reason))return '';
    const truck=String(op.truckName||'Самосвал'),name=typeof actor==='string'?actor.trim():'';
    if(!action)return truck+': '+offlineReasonLabel(result.reason)+'. Автор изменения не сохранён.';
    const date=new Date(Number(at)),time=Number(at)>0&&Number.isFinite(date.getTime())?' · '+date.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'';
    return truck+': «'+action+'» уже отмечено. '+(name?'Пользователь: '+name+time:'Автор отметки не сохранён')+'.'+(op.type==='load'?' Повторный рейс не добавлен.':'');
  }
  function offlineLocalTicker(){
    if(!state.shift)return null;
    const op=offlinePendingOps().filter(x=>x.shiftId===state.shift.id).slice(-1)[0];if(!op)return null;
    const label=op.type==='reset'?'🔄 Сброс таймера':op.type==='load'?'⚡ Погрузка':op.type==='ttn'?(op.collect?'📄 Забрал ТТН':'↩️ Снял ТТН'):(op.wantArrived===false?'↩️ Снял прибытие':'🚛 Приехал');
    return {id:op.id,type:'offline',offlinePending:true,createdByEmail:op.email,timestamp:op.createdAt,
      html:label+' · '+truckLabelHtml(op.truckId)+' <span style="color:#f59e0b;font-size:10px">☁️ ОФЛАЙН</span>'};
  }
  function offlineProjectTicker(){
    // ticker-v9 reads state.notifications: present a temporary local entry.
    state.notifications=(state.notifications||[]).filter(x=>!x.offlinePending);
    const local=offlineLocalTicker();
    if(local)state.notifications.unshift({...local,userName:getUserName(),createdBy:getUserName()});
  }
  function offlineProjection(before,op){
    if(!before||!before.onLine||before.shiftId!==op.shiftId)return {status:before};
    const st={...before},t=Number(op.createdAt);
    if(op.type==='reset'){Object.assign(st,{lastLoadTimestamp:null,lastLoadBy:null,arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false,cycleRevision:Number(st.cycleRevision||0)+1});
    }else if(op.type==='arrive'){
      if(op.wantArrived!==false){
        const ts=Math.max(t,Number(st.lastLoadTimestamp||0)+1);
        st.arriveStatus=new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
        st.arriveTimestamp=ts;st.arriveBy=op.actor;st.loadedAfterArrive=false;
      }else{st.arriveStatus=null;st.arriveTimestamp=null;st.arriveBy=null;st.loadedAfterArrive=false;}
      st.cycleRevision=Number(st.cycleRevision||0)+1;
    }else if(op.type==='load'){
      const timestamp=Math.max(t,Number(st.arriveTimestamp||0)+1,Number(st.lastLoadTimestamp||0)+1);
      const logId=op.logId||('load_'+op.truckId+'_'+op.shiftId+'_cycle_'+op.expectedRevision+'_'+op.arrivalTimestamp);
      const log={id:'pending_'+op.id,offlinePending:true,shiftId:op.shiftId,truckId:op.truckId,
        truckName:op.truckName||truckName(op.truckId),volume:op.volume||0,isGAI:!!op.isGAI,
        timeStr:new Date(timestamp).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),
        timestamp,arrivalTimestamp:Number(st.arriveTimestamp)||null,createdBy:op.actor,createdByEmail:op.email,comment:''};
      st.lastLoadTimestamp=timestamp;st.lastLoadBy=op.actor;st.lastLoadLogId=logId;
      st.cycleRevision=Number(st.cycleRevision||0)+1;st.arriveStatus=null;st.arriveTimestamp=null;st.arriveBy=null;st.loadedAfterArrive=true;
      if(st.ttnStatus==='pending'){st.ttnStatus=true;st.ttnLogId=logId;}
      return {status:st,log};
    }else if(op.type==='ttn'){
      st.ttnStatus=op.collect?(st.loadedAfterArrive&&st.lastLoadLogId?true:'pending'):null;
      st.ttnBy=op.collect?op.actor:null;st.ttnLogId=op.collect&&st.loadedAfterArrive?st.lastLoadLogId:null;
      st.ttnRevision=Number(st.ttnRevision||0)+1;
    }
    return {status:st};
  }
  // Start from the remote snapshot every time: never apply the same pending load twice.
  function offlineProjectState(){
    const statuses={...offlineRemoteStatuses},logs=offlineRemoteLogs.slice();
    for(const op of offlinePendingOps()){
      if(!state.shift||op.shiftId!==state.shift.id||!statuses[op.truckId])continue;
      if(op.type==='reset'&&statuses[op.truckId].lastResetOperationId===op.id)continue;
      if(op.type==='load'&&(statuses[op.truckId].lastLoadLogId===op.logId||logs.some(l=>l.id===op.logId)))continue;
      if(op.type==='arrive'&&op.wantArrived!==false&&Number(statuses[op.truckId].arriveTimestamp||0)===Math.max(Number(op.createdAt),Number(op.lastLoadTimestamp||0)+1)&&statuses[op.truckId].arriveBy===op.actor)continue;
      const p=offlineProjection(statuses[op.truckId],op);statuses[op.truckId]=p.status;
      if(p.log&&!logs.some(l=>l.id===op.logId))logs.push(p.log);
    }
    state.truckStatus=statuses;state.logs=logs.sort((x,y)=>(y.timestamp||0)-(x.timestamp||0));offlineProjectTicker();
  }
  function offlineQueueAction(type,id,intent){
    if(!currentUid||!intent||!intent.status||!state.shift||state.shift.id!==intent.shiftId)return false;
    if(type==='reset'&&!canAdmin()){showError('Только для администратора');return false;}
    const before=intent.status,now=Date.now(),gap=Math.max(MIN_CYCLE_MINUTES,settings.cycleMinutes||MIN_CYCLE_MINUTES)*60000;
    if(type==='load'&&!before.arriveStatus){showError('Сначала отметьте прибытие');return false;}
    if((type==='load'||(type==='arrive'&&!before.arriveStatus))&&before.lastLoadTimestamp&&now-before.lastLoadTimestamp<gap){
      showError('Ещё не истекло время ходки');return false;
    }
    const truck=findTruck(id);if(!truck){showError('Самосвал не найден');return false;}
    try{
      const items=offlineJournalRead(),previous=items.filter(x=>x.truckId===id&&x.shiftId===intent.shiftId&&x.status==='pending').slice(-1)[0];
      const op={id:'op_'+now+'_'+Math.random().toString(36).slice(2),type,truckId:id,shiftId:intent.shiftId,objectId:state.shift?.objectId||'',objectName:state.shift?.objectName||'',
        beforeStatus:{...before},createdAt:now,actor:getUserName(),email:currentEmail,expectedRevision:Number(before.cycleRevision||0),
        expectedTtnRevision:Number(before.ttnRevision||0),arrivalTimestamp:Number(before.arriveTimestamp||0),
        lastLoadTimestamp:Number(before.lastLoadTimestamp||0),wantArrived:!before.arriveStatus,collect:!before.ttnStatus,
        dependencyId:previous?.id||null,cycleMinutes:Math.max(MIN_CYCLE_MINUTES,settings.cycleMinutes||MIN_CYCLE_MINUTES),
        truckName:truck.brand+' '+truck.number,volume:truck.isGAI?0:truck.defaultVol,isGAI:!!truck.isGAI,status:'pending'};
      if(type==='load')op.logId='load_'+id+'_'+op.shiftId+'_cycle_'+op.expectedRevision+'_'+op.arrivalTimestamp;
      items.push(op);offlineJournalWrite(items); // Commit locally first; never silently lose an action.
      try{window.__gameCoinQueued?.(op);}catch(e){console.warn('[game animation]',e);}
      const old=state.truckStatus[id];offlineProjectState();signalLineTransition(id,old,state.truckStatus[id]);refreshLineViews();
      const label=type==='reset'?'🔄 Сброс таймера':type==='load'?'⚡ Погрузка':type==='ttn'?(op.collect?'📄 Забрал ТТН':'↩️ Снял ТТН'):(op.wantArrived?'🚛 Приехал':'↩️ Снял прибытие');
      showToastEl(label+' · '+truckLabelHtml(id),false);
      if(navigator.onLine)offlineReplayJournal();
      return true;
    }catch(e){showError('Действие не сохранено на устройстве: '+(e.message||e));return false;}
  }
  function offlineResolve(id,status,reason){
    const all=offlineJournalRead(),op=all.find(x=>x.id===id);
    if(op&&op.status==='pending'){op.status=status;op.result=reason;op.resolvedAt=Date.now();offlineJournalWrite(all);}
  }
  function offlineAdoptResult(op,result){
    if(result.status){
      const old=offlineRemoteStatuses[op.truckId];
      if(!old||old.shiftId!==op.shiftId||Number(old.cycleRevision||0)<=Number(result.status.cycleRevision||0))
        offlineRemoteStatuses[op.truckId]={id:op.truckId,...result.status};
    }
    if(result.log&&!offlineRemoteLogs.some(l=>l.id===result.log.id)){
      offlineRemoteLogs.push(result.log);confirmedLoadIds.add(result.log.id);
    }
    offlineProjectState();refreshLineViews();
  }
  function undoLastOfflineAction(){
    if(!hasPermission('undo_action')&&!hasPermission('undo_any')){showError('Нет права отменять действия');return;}
    if(offlineReplayRunning){showToastEl('Действие отправляется на сервер',false);return;}
    const all=offlineJournalRead();let i=-1;
    for(let n=all.length-1;n>=0;n--)if(all[n].status==='pending'&&state.shift&&all[n].shiftId===state.shift.id){i=n;break;}
    if(i<0)return;all[i].status='cancelled';all[i].cancelledAt=Date.now();offlineJournalWrite(all);offlineProjectState();refreshLineViews();showToastEl('↩️ Ошибочное действие отменено. Штраф −3 🪙 будет учтён после связи с сервером.',true);window.__gameFlushPenalties?.();
  }
  async function offlineNotifyAccepted(op,result){
    let delivered=true;
    try{
      const ref=refs.notifications.doc('offline_'+op.id),snap=await ref.get({source:'server'});
      if(!snap.exists){
        const label=op.type==='reset'?'🔄 Сброс таймера':op.type==='load'?'⚡ Погрузка':op.type==='ttn'?(op.collect?'📄 Забрал ТТН':'↩️ Снял ТТН'):(op.wantArrived?'🚛 Приехал':'↩️ Снял прибытие');
        await ref.set({...offlineUndoFields(op,result.beforeStatus||op.beforeStatus),gamePenaltyKey:window.__gamePenaltyKey(op.type,op.truckId,result.status||{},result.log?.id,op.id),type:op.type,truckId:op.truckId,logId:result.log?.id||null,
          createdBy:op.actor,createdByEmail:op.email||'',timestamp:op.createdAt,shiftId:op.shiftId,objectId:op.objectId||'',objectName:op.objectName||'',
          html:label+' · '+truckLabelHtml(op.truckId)});
      }
    }catch(e){delivered=false;console.warn('Не удалось отправить уведомление офлайн-действия',e);}
    try{
      const ref=refs.audit.doc('offline_'+op.id),snap=await ref.get({source:'server'});
      if(!snap.exists){
        const names={reset:'🔄 Сброс таймера',arrive:op.wantArrived?'🚛 Прибытие на линию':'↩️ Снято прибытие на линию',
          load:'⚡ Погрузка самосвала',ttn:op.collect?'📄 Забрана ТТН':'↩️ Снята отметка ТТН'};
        await ref.set({text:(names[op.type]||op.type)+': '+op.truckName,
          timeStr:new Date(op.createdAt).toLocaleString('ru-RU'),
          objectName:state.shift?.objectName||'—',objectId:state.shift?.objectId||'',
          shiftId:op.shiftId,truckId:op.truckId,truckName:op.truckName,
          userEmail:op.email||'',userName:op.actor,createdByEmail:op.email||'',
          timestamp:op.createdAt,eventType:op.type,offlineOperationId:op.id});
      }
    }catch(e){delivered=false;console.warn('Не удалось отправить аудит офлайн-действия',e);}
      if(delivered){const all=offlineJournalRead(),saved=all.find(x=>x.id===op.id);if(saved){saved.effectsDelivered=true;offlineJournalWrite(all);}}
  }
  function offlineUndoFields(op,b){
    if(!b)return {};
    if(op.type==='load')return previousLoadSnapshot(b);
    if(op.type==='arrive')return {wasArrived:!!b.arriveStatus,prevTime:b.arriveStatus||null,prevTs:b.arriveTimestamp||null,prevArriveBy:b.arriveBy||null};
    return {prevTtn:b.ttnStatus??null,prevTtnBy:b.ttnBy||null,prevTtnLogId:b.ttnLogId||null};
  }
  async function offlineReplayJournal(){
    if(offlineReplayRunning||!navigator.onLine||!currentUid||!permissionsLoaded||currentUserStatus!=='active'||Date.now()<offlineServerRetryAt||syncState.pendingWrites.status||syncState.pendingWrites.shift)return;
    offlineReplayRunning=true;
    try{
      for(const op of offlineJournalRead().filter(x=>x.status==='confirmed'&&!x.effectsDelivered))await offlineNotifyAccepted(op,op.savedResult||{});
      for(const op of offlinePendingOps()){
        if(!navigator.onLine||currentUserStatus!=='active')break;
        if(!offlineJournalRead().some(x=>x.id===op.id&&x.status==='pending'))continue;
        if(op.dependencyId){
          const previous=offlineJournalRead().find(x=>x.id===op.dependencyId);
          if(previous?.status==='pending')break;
          if(previous?.status==='rejected'){
            offlineResolve(op.id,'rejected','previous-action-rejected');offlineProjectState();refreshLineViews();continue;
          }
        }
        try{
          const result=await db.runTransaction(async tx=>{
            const policy=await tx.get(appConfigRef);
            const sharedCycle=policy.exists?Number(policy.data().cycleMinutes)||15:15;
            const before=await readLineState(tx,op.truckId,op.shiftId);
            const truck=findTruck(op.truckId);if(!truck)throw {code:'truck-missing',message:'Самосвал не найден'};
            const revision=Number(before.cycleRevision||0),gap=Math.max(MIN_CYCLE_MINUTES,sharedCycle,op.cycleMinutes||MIN_CYCLE_MINUTES)*60000;
            if(op.type==='reset'){
              if(!canAdmin())throw {code:'permission-denied',message:'Сброс доступен администратору'};
              if(before.lastResetOperationId===op.id)return {outcome:'confirmed',status:before};
              if(revision!==op.expectedRevision||Number(before.lastLoadTimestamp||0)!==Number(op.lastLoadTimestamp||0))return {outcome:'rejected',reason:'arrival-changed',status:before};
              const update={lastLoadTimestamp:null,lastLoadBy:null,arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false,cycleRevision:revision+1,lastResetOperationId:op.id};
              tx.update(refs.truckStatus.doc(op.truckId),update);
              return {outcome:'confirmed',status:{...before,...update},beforeStatus:before,didCommit:true,gameRewardAction:{id:op.id,type:op.type,at:Number(op.createdAt)}};
            }
            if(op.type==='arrive'){
              const want=op.wantArrived!==false;
              if(want&&before.arriveStatus&&Number(before.arriveTimestamp||0)===Math.max(Number(op.createdAt),Number(op.lastLoadTimestamp||0)+1)&&before.arriveBy===op.actor)
                return {outcome:'confirmed',status:before};
              if(!want&&revision===Number(op.expectedRevision||0)+1&&!before.arriveStatus&&!before.arriveTimestamp&&before.loadedAfterArrive===false&&Number(before.lastLoadTimestamp||0)===Number(op.lastLoadTimestamp||0))return {outcome:'confirmed',status:before};
              if(revision!==Number(op.expectedRevision||0)||Number(before.arriveTimestamp||0)!==Number(op.arrivalTimestamp||0)||!!before.arriveStatus===want)
                return {outcome:'rejected',reason:'arrival-changed',status:before};
              if(want&&before.lastLoadTimestamp&&op.createdAt-before.lastLoadTimestamp<gap)
                return {outcome:'rejected',reason:'cycle-time',status:before};
              const ts=Math.max(Number(op.createdAt),Number(before.lastLoadTimestamp||0)+1);
              const update=want?{arriveStatus:new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),arriveTimestamp:ts,arriveBy:op.actor,loadedAfterArrive:false,cycleRevision:revision+1}:
                {arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false,cycleRevision:revision+1};
              tx.update(refs.truckStatus.doc(op.truckId),update);
              return {outcome:'confirmed',status:{...before,...update},beforeStatus:before,didCommit:true,gameRewardAction:{id:op.id,type:op.type,at:Number(op.createdAt)}};
            }
            if(op.type==='load'){
              const logId=op.logId||('load_'+op.truckId+'_'+op.shiftId+'_cycle_'+op.expectedRevision+'_'+op.arrivalTimestamp);
              // The deterministic log ID is an idempotency key. Check it
              // *before* rejecting a changed status: the first commit may
              // have succeeded while its acknowledgement was lost.
              const ref=refs.logs.doc(logId),existing=await tx.get(ref);
              if(existing.exists){
                const record=existing.data();
                if(record.clientOperationId===op.id)return {outcome:'confirmed',status:before,log:{id:logId,...record}};
                return {outcome:'rejected',reason:'duplicate',status:before,winningLog:{id:logId,...record}};
              }
              if(!before.arriveStatus||revision!==Number(op.expectedRevision||0)||Number(before.arriveTimestamp||0)!==Number(op.arrivalTimestamp||0))
                return {outcome:'rejected',reason:'duplicate-or-arrival-changed',status:before};
              if(before.lastLoadTimestamp&&op.createdAt-before.lastLoadTimestamp<gap)
                return {outcome:'rejected',reason:'cycle-time',status:before};
              const ts=Math.max(Number(op.createdAt),Number(before.arriveTimestamp||0)+1,Number(before.lastLoadTimestamp||0)+1);
              const log={shiftId:op.shiftId,truckId:op.truckId,truckName:truck.brand+' '+truck.number,
                volume:truck.isGAI?0:truck.defaultVol,timeStr:new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),
                timestamp:ts,arrivalTimestamp:Number(before.arriveTimestamp)||null,createdBy:op.actor,createdByEmail:op.email||'',
                isGAI:!!truck.isGAI,comment:'',clientOperationId:op.id};
              const update={lastLoadTimestamp:ts,lastLoadBy:op.actor,lastLoadLogId:logId,cycleRevision:revision+1,
                arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:true};
              if(before.ttnStatus==='pending'){update.ttnStatus=true;update.ttnLogId=logId;}
              tx.set(ref,log);tx.update(refs.truckStatus.doc(op.truckId),update);
              return {outcome:'confirmed',status:{...before,...update},log:{id:logId,...log},beforeStatus:before,didCommit:true,gameRewardAction:{id:op.id,type:op.type,at:Number(op.createdAt)}};
            }
            if(op.type==='ttn'){
              if(Number(before.ttnRevision||0)===Number(op.expectedTtnRevision||0)+1&&before.ttnBy=== (op.collect?op.actor:null)&&
                 (!!before.ttnStatus===!!op.collect))return {outcome:'confirmed',status:before};
              if(Number(before.ttnRevision||0)!==Number(op.expectedTtnRevision||0)||!!before.ttnStatus===!!op.collect)
                return {outcome:'rejected',reason:'ttn-changed',status:before};
              const logId=before.lastLoadLogId||null;
              const update=op.collect?{ttnStatus:before.loadedAfterArrive&&logId?true:'pending',ttnBy:op.actor,
                ttnLogId:before.loadedAfterArrive?logId:null,ttnRevision:Number(before.ttnRevision||0)+1}:
                {ttnStatus:null,ttnBy:null,ttnLogId:null,ttnRevision:Number(before.ttnRevision||0)+1};
              tx.update(refs.truckStatus.doc(op.truckId),update);
              return {outcome:'confirmed',status:{...before,...update},beforeStatus:before,didCommit:true,gameRewardAction:{id:op.id,type:op.type,at:Number(op.createdAt)}};
            }
            return {outcome:'rejected',reason:'unsupported'};
          });
          offlineTransportRecovered();offlineAdoptResult(op,result);
          {const all=offlineJournalRead(),saved=all.find(x=>x.id===op.id);if(saved){saved.savedResult={status:result.status||null,beforeStatus:result.beforeStatus||op.beforeStatus,log:result.log||null};if(result.outcome==='rejected')saved.conflictDetails=offlineConflictDetails(op,result);offlineJournalWrite(all);}}
          offlineResolve(op.id,result.outcome,result.reason||result.outcome);
          offlineProjectState();refreshLineViews();
          if(result.outcome==='confirmed'){
            if(result.didCommit){
              try{/* History is saved with the durable audit entry. */}catch(e){console.warn('[offline history]',e);}
              if(appConfig.maxEnabled){
                const actor=op.actor,name=op.truckName||truckName(op.truckId);
                if(op.type==='load'&&appConfig.notifyLoad)enqueueMax('⚡ Погрузка\n🚛 '+name+'\n👤 '+actor,{truckId:op.truckId,logId:result.log?.id||'',reis:getLogs().filter(l=>l.truckId===op.truckId).length});
                if(op.type==='arrive'&&op.wantArrived&&appConfig.notifyArrive)enqueueMax('🚛 Приехал на объект\n🚛 '+name+'\n👤 '+actor);
                if(op.type==='ttn'&&op.collect&&appConfig.notifyTtn)enqueueMax('📄 Забрал ТТН\n🚛 '+name+'\n👤 '+actor);
              }
            }
            await offlineNotifyAccepted(op,result);
          }else showToastEl('⚠️ '+escapeHtml(offlineReasonLabel(result.reason,offlineConflictDetails(op,result))),true);
        }catch(e){
          if(offlineTransportError(e)){offlineTransportFailed(e);break;}
          if(!navigator.onLine||['aborted','cancelled'].includes(e.code)){offlineServerRetryAt=Date.now()+1500;break;}
          offlineResolve(op.id,'rejected',e.code||e.message||'error');offlineProjectState();refreshLineViews();
          showToastEl('⚠️ Офлайн-действие отклонено: '+escapeHtml(e.message||e.code||'ошибка'),true);
        }
      }
    }finally{offlineReplayRunning=false;updateSyncUI();}
  }
  // Offline-first operations. The UI moves immediately; the journal replays
  // through server transactions even when navigator.onLine incorrectly says true.
  async function performLoad(id,capturedIntent){
    if(!requireEdit('action_load')||loadInFlight[id]||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=capturedIntent||captureLineIntent(id);
    if(!intent)return {outcome:'ignored'};
    return {outcome:offlineQueueAction('load',id,intent)?'queued':'failed'};
  }
  async function toggleArrive(id,capturedIntent){
    if(!requireEdit('action_arrive')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=capturedIntent||captureLineIntent(id);
    if(!intent)return {outcome:'ignored'};
    return {outcome:offlineQueueAction('arrive',id,intent)?'queued':'failed'};
  }
  async function toggleTtn(id,capturedIntent){
    if(!requireEdit('action_ttn')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=capturedIntent||captureLineIntent(id);
    if(!intent)return {outcome:'ignored'};
    return {outcome:offlineQueueAction('ttn',id,intent)?'queued':'failed'};
  }

  // === УДЕРЖАНИЕ ===
  let holdTimer = null, vibInt = null;
  document.addEventListener('touchstart', e=>{ if(e.touches?.length) { touchStartY = e.touches[0].clientY; touchStartX = e.touches[0].clientX; isScrolling = false; } }, {passive:true});
  document.addEventListener('touchmove', e=>{ if(e.touches?.length) { if(Math.abs(e.touches[0].clientY - touchStartY) > 10 || Math.abs(e.touches[0].clientX - touchStartX) > 10) { isScrolling = true; let b=document.querySelector('.holding'); if(b) cancelHold(b); } } }, {passive:true});
  function cancelHold(b) { if(holdTimer) clearTimeout(holdTimer); if(vibInt) clearInterval(vibInt); if(b) b.classList.remove('holding'); }
  function startHold(e, type, id) {
    let action = type === 'load' ? 'action_load' : (type === 'arrive' ? 'action_arrive' : 'action_ttn');
    if (!requireEdit(action) || !state.shift || isScrolling) return;
    let b = e.currentTarget, hs = 0.5; if(type==='load') hs = settings.holdLoad??0.5; else if(type==='arrive') hs = settings.holdArrive??0.5; else hs = settings.holdTtn??0.5;
    let st = state.truckStatus[id]; if(!st) return;
    let lastL = st.lastLoadTimestamp||0, gap = (settings.cycleMinutes||15)*60000;
    if(type==='load' && st.loadedAfterArrive && !st.arriveStatus) { showToastEl('Погрузка уже отмечена: '+escapeHtml(st.lastLoadBy||'другой пользователь'),false); return; }
    if(type==='load' && lastL && (Date.now()-lastL)<gap) { appNotice('Не истекло время'); return; }
    if(type==='load' && !st.arriveStatus) { appNotice('Сначала Приехал'); return; }
    if(type==='arrive' && lastL && (Date.now()-lastL)<gap) { appNotice('Не истекло время'); return; }
    if(hs<=0) { executeAction(type, id); return; }
    b.style.setProperty('--hold-duration', hs+'s'); b.classList.add('holding');
    let haptic = type==='load'?settings.hapticLoad:(type==='arrive'?settings.hapticArrive:settings.hapticTtn);
    if(haptic) { vibrate(20); vibInt = setInterval(()=>vibrate(25), 120); }
    holdTimer = setTimeout(()=>{ if(!isScrolling) { cancelHold(b); executeAction(type, id); } else cancelHold(b); }, hs*1000);
  }
  function executeAction(type, id) { if(type==='arrive') { vibArrive(); toggleArrive(id); } else if(type==='load') { vibLoad(); performLoad(id); } else { vibTtn(); toggleTtn(id); } }
  function startArriveHold(e, id) { startHold(e, 'arrive', id); }
  function startQuickLoadHold(e, id) { startHold(e, 'load', id); }
  function startTtnHold(e, id) { startHold(e, 'ttn', id); }

  function renderLine() {
    let sc = document.getElementById('startShiftContainer'), ac = document.getElementById('activeShiftContainer'), cb = document.getElementById('changeObjBtn');
    if (!state.shift) { sc.style.display = hasPermission('start_shift') ? 'block' : 'none'; ac.style.display = 'none'; cb.style.display = 'none'; return; }
    sc.style.display = 'none'; ac.style.display = 'block'; cb.style.display = hasPermission('edit_line') ? 'inline-block' : 'none';
    let c = document.getElementById('trucksLineList'), oldP = {};
    c.querySelectorAll('.truck-card[data-truck-id]').forEach(x => oldP[x.dataset.truckId] = x.getBoundingClientRect().top);
    let ids = getActiveLineIds(); if (!ids.length) { c.innerHTML = '<div class="form-card" style="text-align:center;color:var(--muted);">Нет машин</div>'; return; }
    let logs = getLogs(), lastTs = {}; logs.forEach(l => { if (lastTs[l.truckId] === undefined) lastTs[l.truckId] = l.timestamp||0; });
    let trucks = ids.map(id => findTruck(id)).filter(Boolean);
    trucks.sort((a,b)=>{ let sA=state.truckStatus[a.id], sB=state.truckStatus[b.id]; let tA=sA.ttnStatus===true?1:0, tB=sB.ttnStatus===true?1:0; if(tA!==tB) return tA-tB; let aA=sA.arriveStatus?1:0, aB=sB.arriveStatus?1:0; if(aA!==aB) return aB-aA; let lA=lastTs[a.id]||0, lB=lastTs[b.id]||0; if(lA===0&&lB===0) return 0; if(lA===0) return -1; if(lB===0) return 1; return lA-lB; });
    let now = Date.now(), cyc = (settings.cycleMinutes||15)*60000;
    let canEditArrive = hasPermission('action_arrive'), canEditLoad = hasPermission('action_load'), canEditTtn = hasPermission('action_ttn'); let showStats = hasPermission('view_card_stats');
    c.innerHTML = trucks.map(t => {
      let st = state.truckStatus[t.id]||{}; let offlineFlag=offlinePendingForTruck(t.id); let tLogs = logs.filter(l=>l.truckId===t.id), sum = tLogs.reduce((s,l)=>s+l.volume,0);
      let isA = !!st.arriveStatus, lastL = st.lastLoadTimestamp||0, inC = lastL > 0 && (now-lastL)<cyc; let ttn = st.ttnStatus, faded = ttn===true; let lTs = tLogs.length ? tLogs[0].timestamp||0 : 0; let isGAI = !!t.isGAI;
      let arrBtn;
      if (inC) arrBtn = `<button class="btn btn-arrive" disabled><span style="display:flex;flex-direction:column;align-items:center;line-height:1.1;"><span class="idle-label">Ходка</span><span class="cooldown-timer" style="font-size:15px;" data-load-ts="${lastL}">${formatIdleDuration(cyc-(now-lastL))}</span></span></button>`;
      else if (isA) arrBtn = `<button class="btn btn-arrive active-arrive" ${canEditArrive?`onpointerdown="startArriveHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''} ${!canEditArrive?'disabled':''}><span style="display:flex;flex-direction:column;align-items:center;line-height:1.1;"><span class="idle-label">Простой</span><span class="idle-timer" data-since="${st.arriveTimestamp||now}">${formatIdleDuration(now-(st.arriveTimestamp||now))}</span></span></button>`;
      else arrBtn = `<button class="btn btn-arrive" ${canEditArrive?`onpointerdown="startArriveHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''} ${!canEditArrive?'disabled':''}>🚛 Приехал</button>`;
      let ttnTxt = ttn ? '📄 Забрал ТТН ✓' : '📄 Забрать ТТН';
      let statsHtml = showStats ? (isGAI ? `<div class="truck-summary">Рейсов: <b>${tLogs.length}</b></div>` : `<div class="truck-summary">Рейсов: <b>${tLogs.length}</b> | <b>${sum} м³</b></div>`) : '';
      let loadBtnTxt = isGAI ? '⚡ Погрузка' : '⚡ Погрузка (+' + t.defaultVol + 'м³)';
      return `<div class="truck-card ${isA?'arrived':''} ${faded?'faded':''}" data-truck-id="${t.id}"><div class="truck-header"><div class="truck-name" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><b>${escapeHtml(t.brand)}</b>${renderRussianPlate(t.number)}<span style="font-size:13px;color:var(--muted);">${isGAI?'': '('+t.defaultVol+' м³)'}</span>${isA?`<span style="color:#f59e0b;font-size:12px;">(${escapeHtml(st.arriveBy||'')})</span>`:''}${offlineFlag?`<span style="font-size:10px;font-weight:700;color:#f59e0b;">☁️ ОФЛАЙН</span>`:''}</div>${statsHtml}</div><div class="last-load-info">⏱ Последняя: <b class="time-ago-card" data-timestamp="${lTs}">${lTs>0?formatTimeAgo(lTs):'—'}</b></div><div class="action-row">${arrBtn}<button class="btn btn-quick" ${!canEditLoad||!isA?'disabled':''} ${canEditLoad&&isA?`onpointerdown="startQuickLoadHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''}>${loadBtnTxt}</button><button class="btn btn-ttn ${ttn?'active-ttn':''}" ${!canEditTtn?'disabled':''} ${canEditTtn?`onpointerdown="startTtnHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''}>${ttnTxt}</button></div></div>`;
    }).join('');
    if (Object.keys(oldP).length) {
      c.querySelectorAll('.truck-card').forEach(card => { let old = oldP[card.dataset.truckId]; if(old === undefined) return; let delta = old - card.getBoundingClientRect().top;
        if(Math.abs(delta) > 2) { card.style.transform=`translateY(${delta}px)`; card.style.transition='none'; void card.offsetWidth; setTimeout(()=>{ requestAnimationFrame(()=>{ card.style.transition='transform 2.4s cubic-bezier(0.4,0,0.2,1)'; card.style.transform=''; setTimeout(()=>card.style.transition='', 2450); }); }, 1000); }
      });
    }
  }

  function renderHeaderStats() {
    let d = state.shift ? `Смена от ${state.shift.startDate}` : 'Смена не начата'; let o = state.shift ? state.shift.objectName : 'Не выбран';
    let act = state.shift ? getActiveLineIds().filter(id => { let t = findTruck(id); if (!t || t.isGAI) return false; return !state.truckStatus[id] || state.truckStatus[id].ttnStatus !== true; }).length : 0;
    let logs = getLogs(); let stdLogs = logs.filter(l => !l.isGAI); let v = stdLogs.reduce((s,l)=>s+l.volume,0);
    document.getElementById('shiftDate').textContent = d; document.getElementById('headerObject').textContent = 'Объект: ' + o;
    document.getElementById('activeLineCount').textContent = act + ' маш.'; document.getElementById('totalTrips').textContent = stdLogs.length; document.getElementById('totalVolume').textContent = v + ' м³';
  }

  function tickTimers() {
    let now = Date.now(), cyc = (settings.cycleMinutes||15)*60000;
    document.querySelectorAll('.idle-timer').forEach(e=>{ let s=parseInt(e.getAttribute('data-since')); if(s) e.textContent=formatIdleDuration(now-s); });
    document.querySelectorAll('.load-age-card').forEach(el=>{el.textContent=formatLoadAge(el.dataset.timestamp);});
    document.querySelectorAll('.time-ago-card').forEach(e=>{ let t=parseInt(e.getAttribute('data-timestamp')); if(t) e.textContent=formatTimeAgo(t); });
    document.querySelectorAll('.cooldown-timer').forEach(e=>{ let l=parseInt(e.getAttribute('data-load-ts')); if(l) { let r=cyc-(now-l); if(r<=0) scheduleRenderLine(); else e.textContent=formatIdleDuration(r); } });
    let ticker = document.getElementById('tickerTimeAgo'); if(ticker) { let t=parseInt(ticker.getAttribute('data-timestamp')); if(t) ticker.textContent=formatTimeAgo(t); }
  }
  setInterval(tickTimers, 1000);

  // === БАЗА САМОСВАЛОВ И ОБЪЕКТОВ ===
  async function saveTruckToGlobalBase() {
    if (!requireEdit('manage_trucks')) return;
    let id = document.getElementById('editTruckId').value;
    let brand = document.getElementById('newTruckBrand').value.trim();
    let num = document.getElementById('newTruckNumber').value.trim();
    let vol = parseFloat(document.getElementById('newTruckVol').value);
    let type = document.getElementById('newTruckType').value;
    let isGAI = type === 'gai';
    if (!brand || !num) { appNotice('Заполните марку и госномер'); return; }
    if (!isGAI && (isNaN(vol) || vol <= 0)) { appNotice('Укажите объем'); return; }
    try {
      if (id) { await tfAwait(refs.trucks.doc(id).update({ brand, number: num, defaultVol: isGAI ? 0 : vol, isGAI, updatedAt: Date.now() })); addAudit(`Обновлен самосвал: ${brand} ${num}`).catch(()=>{}); showToastEl('✏️ Обновлено', false); }
      else { let r = refs.trucks.doc(); await tfAwait(r.set({ brand, number: num, defaultVol: isGAI ? 0 : vol, isGAI, createdAt: Date.now(), createdBy: getUserName() })); addAudit(`Добавлен самосвал: ${brand} ${num}`).catch(()=>{}); showToastEl('➕ Добавлено', false); }
      cancelEditTruck();
    } catch(e) { showError(e.message); }
  }
  function editGlobalTruck(id) {
    if(!requireEdit('manage_trucks')) return; let t=findTruck(id); if(!t) return;
    document.getElementById('editTruckId').value=t.id; document.getElementById('newTruckType').value=t.isGAI?'gai':'regular';
    document.getElementById('newTruckBrand').value=t.brand; document.getElementById('newTruckNumber').value=t.number; document.getElementById('newTruckVol').value=t.defaultVol||'';
    document.getElementById('formCardTitle').textContent='Редактировать'; document.getElementById('saveTruckBtn').textContent='💾 Сохранить'; document.getElementById('cancelEditBtn').style.display='block'; window.scrollTo(0,0); toggleVolInput();
  }
  function cancelEditTruck() {
    document.getElementById('editTruckId').value=''; document.getElementById('newTruckType').value='regular'; document.getElementById('newTruckBrand').value=''; document.getElementById('newTruckNumber').value=''; document.getElementById('newTruckVol').value='';
    document.getElementById('formCardTitle').textContent='Добавить самосвал'; document.getElementById('saveTruckBtn').textContent='➕ Добавить'; document.getElementById('cancelEditBtn').style.display='none'; toggleVolInput();
  }
  function toggleVolInput() { document.getElementById('volumeGroup').style.display = document.getElementById('newTruckType').value === 'gai' ? 'none' : 'block'; }
  async function deleteGlobalTruck(id) {
    if(!requireEdit('manage_trucks')) return; let t=findTruck(id); if(!t || !(await appConfirm('Удалить?'))) return;
    try { let b=db.batch(); b.delete(refs.trucks.doc(id)); b.delete(refs.truckStatus.doc(id)); await tfAwait(b.commit()); await addAudit('🗑 Удалён самосвал: ' + t.brand + ' ' + t.number, {eventType:'truck_delete',truckId:id}); } catch(e){ showError(e.message); }
  }
  async function saveObjectToBase() {
    if (!requireEdit('manage_objects')) return;
    let id = document.getElementById('editObjectId').value, name = document.getElementById('newObjectNameBase').value.trim();
    if (!name) { appNotice('Введите имя'); return; }
    try { if (id) await tfAwait(refs.objects.doc(id).update({ name, updatedAt: Date.now() })); else await tfAwait(refs.objects.doc().set({ name, createdAt: Date.now(), createdBy: getUserName() })); await addAudit((id ? '✏️ Изменён объект: ' : '➕ Создан объект: ') + name, {eventType:id ? 'object_edit' : 'object_create'}); cancelEditObject(); showToastEl('Сохранено', false); }
    catch(e){ showError(e.message); }
  }
  function editGlobalObject(id) { if(!requireEdit('manage_objects')) return; let o=state.objects.find(x=>x.id===id); if(!o) return; document.getElementById('editObjectId').value=o.id; document.getElementById('newObjectNameBase').value=o.name; document.getElementById('formObjectCardTitle').textContent='Редактировать'; document.getElementById('saveObjectBtn').textContent='💾 Сохранить'; document.getElementById('cancelEditObjectBtn').style.display='block'; window.scrollTo(0,0); }
  function cancelEditObject() { document.getElementById('editObjectId').value=''; document.getElementById('newObjectNameBase').value=''; document.getElementById('formObjectCardTitle').textContent='Добавить объект'; document.getElementById('saveObjectBtn').textContent='➕ Добавить'; document.getElementById('cancelEditObjectBtn').style.display='none'; }
  async function deleteGlobalObject(id) {
    if(!requireEdit('manage_objects')) return; let o=state.objects.find(x=>x.id===id); if(!o || !(await appConfirm('Удалить?'))) return;
    try { await tfAwait(refs.objects.doc(id).delete()); await addAudit('🗑 Удалён объект: ' + o.name, {eventType:'object_delete',targetObjectId:id}); } catch(e){ showError(e.message); }
  }

  // === АДМИН ПАНЕЛЬ ===
  const userAccessWrites=new Set();
  function renderAdminPanel() {
    if (!canAdmin()) return;
    renderRegistrationRequests();
    const active = state.users.filter(u => u.status !== 'pending');
    document.getElementById('usersListContainer').innerHTML = active.map(u => { const isMe = u.id === currentUid; const isLocked = isForcedAdminEmail(u.email); const accessible=u.status!=='disabled'; return `<div class="user-row ${accessible?'':'user-access-limited'}"> <div class="user-row-top"><div class="user-email">${escapeHtml(u.email)}</div><input type="text" class="form-control" style="width:100px; padding:4px; font-size:12px;" value="${escapeHtml(u.nickname||'')}" onchange="updateUserNickname('${u.id}', this.value)"></div><div class="user-row-bottom"><select class="form-control" onchange="changeUserRole('${u.id}', this.value)">${Object.keys(ROLES).map(r=>`<option value="${r}" ${r===u.role?'selected':''}>${ROLES[r].label}</option>`).join('')}</select>${!isMe&&!isLocked?`<button class="btn-del" onclick="deleteUser('${u.id}')">Удалить</button>`:''}</div><div class="user-access-row"><span>${accessible?'Доступ разрешён':'Доступ ограничен'}${isMe?'<small>Ваша учётная запись</small>':isLocked?'<small>Владелец приложения</small>':''}</span><label class="toggle-switch" title="${isMe?'Нельзя ограничить собственный доступ':isLocked?'Доступ владельца защищён':'Временно разрешить или ограничить доступ'}"><input type="checkbox" role="switch" data-user-access="${escapeHtml(u.id)}" aria-label="Доступ: ${escapeHtml(u.nickname||u.email)}" ${accessible?'checked':''} ${isMe||isLocked||userAccessWrites.has(u.id)?'disabled':''}><span class="toggle-slider"></span></label></div></div>`; }).join('');
    document.querySelectorAll('[data-user-access]').forEach(input=>input.onchange=()=>setUserAccess(input.dataset.userAccess,input.checked));
  }
  async function setUserAccess(uid, enabled) {
    if(!canAdmin()||userAccessWrites.has(uid))return;
    if(uid===currentUid){showError('Нельзя ограничить собственный доступ');renderAdminPanel();return;}
    if(!navigator.onLine){showError('Для изменения доступа требуется подключение к сети');renderAdminPanel();return;}
    userAccessWrites.add(uid);renderAdminPanel();
    try{
      const targetStatus=enabled?'active':'disabled';let targetName='';
      await db.runTransaction(async tx=>{
        if(!canAdmin())throw new Error('Нет прав администратора');
        const ref=usersRef.doc(uid),snap=await tx.get(ref);
        if(!snap.exists)throw new Error('Пользователь не найден. Обновите список');
        const data=snap.data();
        if(isForcedAdminEmail(data.email))throw new Error('Доступ владельца приложения защищён');
        if(data.status==='pending')throw new Error('Сначала рассмотрите заявку пользователя');
        targetName=data.nickname||data.email||uid;
        if(data.status!==targetStatus)tx.update(ref,{status:targetStatus,accessChangedAt:Date.now(),accessChangedBy:currentEmail});
      });
      const user=state.users.find(u=>u.id===uid);if(user)user.status=targetStatus;
      showToastEl(enabled?'Доступ пользователя восстановлен':'Доступ пользователя временно ограничен',false);
      await addAudit((enabled?'🔓 Восстановлен доступ: ':'🔒 Ограничен доступ: ')+targetName,{eventType:'user_access',targetUid:uid,status:targetStatus});
    }catch(e){showError('Не удалось изменить доступ: '+e.message);}
    finally{userAccessWrites.delete(uid);renderAdminPanel();}
  }
  async function updateUserNickname(uid, nickname) { if (!canAdmin()) return; try { await tfAwait(usersRef.doc(uid).update({ nickname: nickname.trim() || null })); await addAudit('✏️ Изменено имя пользователя: ' + uid + ' → ' + nickname.trim(), {eventType:'user_nickname',targetUid:uid}); } catch(e) { showError(e.message); } }
  async function changeUserRole(uid, newRole) { if (!canAdmin()) return; try { await tfAwait(usersRef.doc(uid).update({ role: newRole })); await addAudit('🔐 Изменена роль пользователя: ' + uid + ' → ' + newRole, {eventType:'user_role',targetUid:uid}); } catch(e) { showError(e.message); } }
  async function deleteUser(uid) { if (!canAdmin() || !(await appConfirm('Удалить доступ?'))) return; try { await tfAwait(usersRef.doc(uid).delete()); await addAudit('🗑 Удалён доступ пользователя: ' + uid, {eventType:'user_delete',targetUid:uid}); } catch(e) { showError(e.message); } }
  const registrationDecisions = new Set();
  async function decideRegistration(reqId, approve) {
    if (!canAdmin() || registrationDecisions.has(reqId)) return;
    const role=document.getElementById('req_role_'+reqId)?.value || 'viewer';
    if (approve && !Object.prototype.hasOwnProperty.call(ROLES,role)) {showError('Выберите роль');return;}
    if (!approve && !(await appConfirm('Отклонить заявку и закрыть доступ пользователю?'))) return;
    registrationDecisions.add(reqId);pendingStart();
    try {
      const cached=state.requests.find(r=>r.id===reqId) || state.users.find(u=>u.id===reqId&&u.status==='pending');
      if (!cached) throw Error('Заявка не найдена. Обновите список');
      let accountEmail='';
      await db.runTransaction(async tx=>{
        const requestRef=requestsRef.doc(reqId),request=await tx.get(requestRef);
        const data=request.exists?request.data():cached;
        const matches=state.users.filter(u=>u.status==='pending'&&u.email===data.email);
        const uid=data.uid || (matches.length===1?matches[0].id:null);
        if (!uid) throw Error('Это старая заявка без учётки Firebase. Пользователю нужно зарегистрироваться заново');
        const profileRef=usersRef.doc(uid),profile=await tx.get(profileRef);
        if (!profile.exists || profile.data().email!==data.email) throw Error('Учётка не соответствует заявке');
        if (profile.data().status!=='pending') throw Error('Заявка уже рассмотрена');
        accountEmail=profile.data().email;
        tx.update(profileRef,approve?{role,status:'active',approvedAt:Date.now(),approvedBy:currentEmail,rejectionReason:null}:{status:'disabled',rejectedAt:Date.now(),rejectedBy:currentEmail,rejectionReason:'Заявка отклонена администратором.'});
        if(request.exists)tx.delete(requestRef);
      });
      await addAudit((approve?'✅ Подтверждена регистрация: ':'⛔ Отклонена регистрация: ')+accountEmail+(approve?' · роль '+ROLES[role].label:''),{eventType:approve?'registration_approved':'registration_rejected'});
      showToastEl(approve?'Доступ открыт':'Заявка отклонена',false);
    }catch(e){showError(escapeHtml(e.message||'Не удалось обработать заявку'));}
    finally{registrationDecisions.delete(reqId);pendingEnd();}
  }
  async function approveRequest(reqId) { return decideRegistration(reqId,true); }
  async function rejectRequest(reqId) { return decideRegistration(reqId,false); }
  async function addNewUser() {
    if (!canAdmin()) return;
    const email = document.getElementById('newUserEmail').value.trim(); const pass = document.getElementById('newUserPassword').value; const role = document.getElementById('newUserRole').value;
    if (!email || !pass) { showError('Заполните поля'); return; }
    try { const secAuth = secondaryApp.auth(); const cred = await secAuth.createUserWithEmailAndPassword(email, pass); await secAuth.signOut(); await tfAwait(usersRef.doc(cred.user.uid).set({ email, role, status: 'active', nickname: sanitizeName(email) })); showToastEl('✅ Создан', false); }
    catch(e) { showError(e.message); }
  }
  function renderPermissionsMatrix(){
    const role=document.getElementById('permRoleSelect').value,config=permissionsConfig[role]||{tabs:[],actions:[]},cont=document.getElementById('permissionsMatrixContainer');
    const groups=[['Смена и линия',['start_shift','close_shift','edit_line']],['Работа самосвалов',['action_arrive','action_load','action_ttn']],['Последнее действие в статусе',['undo_action','undo_any']],['Журнал отмены и восстановления',['history_view','history_undo_own','history_undo_any','history_redo_own','history_redo_any']],['Данные и архив',['edit_logs','manage_trucks','manage_objects','archive_edit','archive_delete','import_backup']],['Отображение',['view_card_stats','view_header','view_gai_report','view_reis_in_ticker']]];
    const known=new Set(groups.flatMap(g=>g[1])),extra=[...new Set([...ALL_ACTIONS,...(config.actions||[])])].filter(x=>!known.has(x));if(extra.length)groups.push(['Другие возможности',extra]);
    cont.innerHTML='<input id="permissionSearch" class="form-control" type="search" placeholder="Найти право…" aria-label="Поиск прав" style="margin-bottom:12px"><p style="color:var(--muted);font-size:12px">Администратор имеет полный доступ. Новые права журнала у остальных ролей выключены, пока вы их не включите. Изменения применяются кнопкой сохранения.</p>';
    function section(title,ids,type,labels,selected){const block=document.createElement('section');block.className='perm-group';const h=document.createElement('div');h.className='perm-group-header';h.textContent=title;block.append(h);const list=document.createElement('div');list.className='perm-list';for(const id of ids){const label=document.createElement('label');label.className='perm-item';label.dataset.search=(title+' '+(labels[id]||id)).toLowerCase();const input=document.createElement('input');input.type='checkbox';input.dataset.type=type;input.value=id;input.checked=selected.includes(id);label.append(input,document.createTextNode(' '+(labels[id]||id)));list.append(label);}block.append(list);cont.append(block);}
    section('Доступные вкладки',ALL_TABS.filter(t=>t!=='admin'),'tab',TAB_LABELS,config.tabs||[]);for(const [title,ids] of groups)section(title,ids,'action',ACTION_LABELS,config.actions||[]);
    document.getElementById('permissionSearch').oninput=e=>{const q=e.target.value.trim().toLowerCase();cont.querySelectorAll('.perm-item').forEach(x=>x.hidden=!x.dataset.search.includes(q));cont.querySelectorAll('.perm-group').forEach(x=>x.hidden=![...x.querySelectorAll('.perm-item')].some(l=>!l.hidden));};
  }

  async function savePermissions() {
    if (!canAdmin()) return;
    const role = document.getElementById('permRoleSelect').value;
    const cont = document.getElementById('permissionsMatrixContainer');
    const tabs = Array.from(cont.querySelectorAll('input[data-type="tab"]:checked')).map(i => i.value);
    const actions = Array.from(cont.querySelectorAll('input[data-type="action"]:checked')).map(i => i.value);
    try { const update = {}; update[role] = { tabs, actions }; await tfAwait(permsRef.set(update, { merge: true })); addAudit(`Изменены права для роли: ${ROLES[role].label}`).catch(()=>{}); showToastEl('💾 Права сохранены', false); }
    catch(e) { showError(e.message); }
  }

  function showError(msg) { console.error(msg); if (!navigator.onLine) { showToastEl(`📴 Нет сети`, true); return; } showToastEl(`⚠️ ${escapeHtml(msg)}`, true); }
  function resetToast(t) { t.className = 'toast'; t.innerHTML = ''; }
  function showToastEl(html, isError, isUndo) {
    if(window.__gameDeferToast?.(html,isError,isUndo))return;
    let t = document.getElementById('toast'); if (!t) return;
    clearTimeout(toastTimer1); clearTimeout(toastTimer2);
    t.className = 'toast' + (isError ? ' error' : '') + (isUndo ? ' slide-right-to-left' : '');
    t.innerHTML = html; void t.offsetWidth; t.classList.add('show');
    toastTimer1 = setTimeout(() => { t.classList.remove('show'); t.classList.add('hide'); toastTimer2 = setTimeout(() => resetToast(t), 700); }, 2500);
  }
  function showToast(msgHtml, tickerHtml, actionObj) { if (actionObj) pushNotification(actionObj, tickerHtml || msgHtml); else showToastEl(msgHtml, false); }
  async function pushNotification(actionObj, htmlText) {
    pendingStart();
    try { await refs.notifications.add(Object.assign({}, actionObj, { html: htmlText, timestamp: Date.now(), createdBy: getUserName(), createdByEmail: currentEmail || '' })); cleanupNotifications().catch(()=>{}); }
    catch(e) { console.warn(e); } finally { pendingEnd(); }
  }
  let notifCleanupPending = false;
  async function cleanupNotifications() {
    if (notifCleanupPending) return; notifCleanupPending = true;
    try { let snap = await refs.notifications.orderBy('timestamp', 'desc').limit(100).get(); if (snap.size < 100) return; let oldTs = snap.docs[snap.docs.length - 1].data().timestamp; let oldSnap = await refs.notifications.where('timestamp', '<', oldTs).get(); let batch = db.batch(); let cnt=0; oldSnap.forEach(d=>{batch.delete(d.ref);cnt++;}); if(cnt>0) await tfAwait(batch.commit()); }
    catch(e) {} finally { notifCleanupPending = false; }
  }
  async function clearAllNotifications() { try { let snap = await refs.notifications.get(); if(!snap.size) return; let b=db.batch(); snap.forEach(d=>b.delete(d.ref)); await tfAwait(b.commit()); } catch(e){} }
  function canUndoCurrent(last) { if (!hasPermission('undo_action') && !hasPermission('undo_any')) return false; if (hasPermission('undo_any')) return true; return last.createdByEmail === currentEmail; }

  function renderStatusTicker() {
    let t = document.getElementById('statusTicker'); if (!t) return;
    let last = offlineLocalTicker() || lastValidNotification();
    if (!last) { t.style.display = 'none'; t.innerHTML = ''; lastTickerTs = 0; lastTickerId = null; return; }
    let isNew = (last.timestamp || 0) !== lastTickerTs; let isNewId = last.id !== lastTickerId;
    if (t.style.display === 'none' || !t.querySelector('.ticker-text-wrapper')) {
      t.style.display = 'flex';
      t.innerHTML = `<div class="ticker-row-top"><span>ПОСЛЕДНЕЕ ДЕЙСТВИЕ</span><span id="tickerTimeAgo" class="ticker-time" data-timestamp="${last.timestamp||Date.now()}">${formatTimeAgo(last.timestamp)}</span></div><div class="ticker-row-bottom"><div class="ticker-text-wrapper"><div class="ticker-left active">${last.html||''}</div></div>${canUndoCurrent(last) ? `<button class="btn-undo" onclick="${last.offlinePending?'undoLastOfflineAction()':'undoLastAction()'}" title="Отменить">↩</button>` : ''}</div>`;
      lastTickerTs = last.timestamp || 0; lastTickerId = last.id; t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); return;
    }
    if (isNew && isNewId) {
      let wrapper = t.querySelector('.ticker-text-wrapper'); let oldText = wrapper.querySelector('.ticker-left.active');
      if (oldText) { let newText = document.createElement('div'); newText.className = 'ticker-left enter'; newText.innerHTML = last.html || ''; wrapper.appendChild(newText); void newText.offsetWidth; oldText.classList.remove('active'); oldText.classList.add('leave'); newText.classList.remove('enter'); newText.classList.add('active'); setTimeout(() => { if (oldText.parentNode) oldText.remove(); }, 800); }
      let undoBtn = t.querySelector('.btn-undo'); let canUndo = canUndoCurrent(last);
      if (canUndo && !undoBtn) { let btn = document.createElement('button'); btn.className = 'btn-undo'; btn.innerHTML = '↩'; btn.onclick = last.offlinePending?undoLastOfflineAction:undoLastAction; t.querySelector('.ticker-row-bottom').appendChild(btn); } else if (!canUndo && undoBtn) { undoBtn.remove(); }
      if(undoBtn&&canUndo)undoBtn.onclick=last.offlinePending?undoLastOfflineAction:undoLastAction;
      let timeEl = document.getElementById('tickerTimeAgo'); if(timeEl) { timeEl.textContent = formatTimeAgo(last.timestamp); timeEl.setAttribute('data-timestamp', last.timestamp); }
      t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); lastTickerTs = last.timestamp || 0; lastTickerId = last.id;
    }
  }
  let undoActionInFlight = false;
  async function undoLastAction() {
    if (undoActionInFlight) return;
    if (!hasPermission('undo_action') && !hasPermission('undo_any')) { showError('Нет права отменять действия'); return; }
    const last = lastValidNotification(); if (!last) return;
    if (!hasPermission('undo_any') && last.createdByEmail !== currentEmail) { showError('Можно отменить только своё действие'); return; }
    if (!['arrive','load','ttn'].includes(last.type)) { showError('Это действие отменяется через историю администратора'); return; }
    if (!(await appConfirm('Отменить действие?'))) return;
    undoActionInFlight = true; pendingStart();
    try {
      if (truckStatusWrites[last.truckId]) await truckStatusWrites[last.truckId];
      const localStatus = state.truckStatus[last.truckId];
      if (!localStatus) throw {code:'status-missing',message:'Статус машины не загружен. Обновите страницу'};
      const before = {...localStatus};
      const observedRevision=truckServerRevisions[last.truckId]||0;
      const notificationRef = refs.notifications.doc(last.id), statusRef = refs.truckStatus.doc(last.truckId);
      let update = null;
      await db.runTransaction(async tx => {
        const notification = await tx.get(notificationRef);
        const status = await tx.get(statusRef);
        const logRef = last.type === 'load' && last.logId ? refs.logs.doc(last.logId) : null;
        const log = logRef ? await tx.get(logRef) : null;
        if (!notification.exists) throw {code:'already-undone',message:'Действие уже отменено'};
        if (!hasPermission('undo_any') && notification.data().createdByEmail !== currentEmail) throw {code:'not-owner',message:'Можно отменить только своё действие'};
        if (!status.exists) throw {code:'status-missing',message:'Самосвал отсутствует на линии'};
        const current = status.data();
        const keys=['shiftId','onLine','arriveStatus','arriveTimestamp','arriveBy','lastLoadTimestamp','lastLoadBy','loadedAfterArrive','ttnStatus','ttnBy','ttnLogId','cycleRevision','lastLoadLogId','ttnRevision'];
        if (keys.some(key => JSON.stringify(current[key] ?? null) !== JSON.stringify(before[key] ?? null))) throw {code:'action-conflict',message:'Данные машины изменились. Обновите страницу перед отменой'};
        if (last.type === 'arrive') {
          update = last.wasArrived ? {arriveStatus:last.prevTime||null,arriveTimestamp:last.prevTs||null,arriveBy:last.prevArriveBy||null} : {arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false};
        } else if (last.type === 'load') {
          if (!log || !log.exists) throw {code:'log-missing',message:'Рейс уже удалён или не был сохранён'};
          if (!hasPermission('undo_any') && log.data().createdByEmail !== currentEmail) throw {code:'not-owner',message:'Нельзя отменить чужую погрузку'};
          if (Number(current.lastLoadTimestamp) !== Number(log.data().timestamp)) throw {code:'action-conflict',message:'У самосвала уже есть более новая погрузка'};
          update={loadedAfterArrive:false,lastLoadTimestamp:last.prevLoadTs??null,lastLoadBy:last.prevLoadBy??null};
          if (last.wasArrived) Object.assign(update,{arriveStatus:last.prevArriveStatus||null,arriveTimestamp:last.prevArriveTs||null,arriveBy:last.prevArriveBy||null});
          update.lastLoadLogId=last.prevLoadLogId||null;
          if (last.prevTtn !== undefined) update.ttnStatus=last.prevTtn;
          if (last.prevTtnBy !== undefined) update.ttnBy=last.prevTtnBy||null;
          if (last.prevTtnLogId !== undefined) update.ttnLogId=last.prevTtnLogId;
        } else {
          update={ttnStatus:last.prevTtn??null,ttnBy:last.prevTtnBy??null,ttnLogId:last.prevTtnLogId??null};
        }
        if(last.type==='arrive'||last.type==='load')update.cycleRevision=Number(current.cycleRevision||0)+1;
        if(last.type==='ttn'||last.type==='load')update.ttnRevision=Number(current.ttnRevision||0)+1;
        const original=notification.data();
        const penaltyKey=original.gamePenaltyKey||window.__gamePenaltyKey(last.type,last.truckId,current,last.logId,last.id);
        const savePenalty=await window.__gameStagePenalty(tx,penaltyKey,{user:original.createdByEmail,name:original.createdBy,description:({load:'Погрузка',arrive:'Прибытие',ttn:'Отметка ТТН'}[last.type])+' · '+truckName(last.truckId),...window.__gamePenaltyScope(penaltyKey,original,current)});
        tx.update(statusRef,update);
        if (logRef) tx.delete(logRef);
        savePenalty();
        tx.delete(notificationRef);
      });
      if (state.truckStatus[last.truckId] && (truckServerRevisions[last.truckId]||0)===observedRevision) {const next={...state.truckStatus[last.truckId],...update};signalLineTransition(last.truckId,state.truckStatus[last.truckId],next);state.truckStatus[last.truckId]=next;truckServerRevisions[last.truckId]=observedRevision+1;}
      if (last.type === 'load') { state.logs=state.logs.filter(l=>l.id!==last.logId); confirmedLoadIds.delete(last.logId); }
      state.notifications=state.notifications.filter(n=>n.id!==last.id);
      if (syncState.errors) delete syncState.errors.undo;
      saveCache(); renderAll();
      await addAudit('↶ Отмена: ' + ({load:'погрузка самосвала',arrive:last.wasArrived?'снятие прибытия':'прибытие на линию',ttn:'отметка ТТН'}[last.type]) + ': ' + truckName(last.truckId),{eventType:'undo',originalType:last.type,truckId:last.truckId,originalUserEmail:last.createdByEmail||''});
      showToastEl('↩️ Отменено',false,true);
    } catch(e) {
      reportSyncError('undo',e);
      showError('Действие не отменено: ' + escapeHtml(e.message || 'Ошибка Firebase') + ' [' + escapeHtml(e.code || 'unknown') + ']');
    } finally { pendingEnd(); undoActionInFlight=false; }
  }
  async function addAudit(text, details = {}) {
    const timestamp = Date.now();
    const entry = { text, timeStr: new Date(timestamp).toLocaleString('ru-RU'), objectName: state.shift?.objectName || '—', objectId: state.shift?.objectId || '', shiftId: state.shift?.id || '', userEmail: currentEmail || '', userName: getUserName(), createdByEmail: currentEmail || '', timestamp, ...details };
    pendingStart();
    try { await refs.audit.add(entry); }
    catch(e) { console.warn('Audit error:', e); showError('Не удалось записать событие в аудит: ' + e.message); }
    finally { pendingEnd(); }
  }
  function auditTruckAction(type, id, extra = {}) {
    const labels = { arrive: '🚛 Прибытие на линию', arrive_cancel: '↩️ Снято прибытие на линию', load: '⚡ Погрузка самосвала', ttn: '📄 Забрана ТТН', ttn_cancel: '↩️ Снята отметка ТТН' };
    const name = truckName(id);
    return addAudit((labels[type] || type) + ': ' + name + (type === 'load' ? ' · ' + (extra.volume || 0) + ' м³' : ''), {eventType:type,truckId:id,truckName:name,...extra});
  }
  function renderAuditEntries() {
    return '<div style="font-size:11px;color:var(--muted);margin:8px 0">Последние ' + state.audit.length + ' событий всех пользователей (до 200). Новые события сверху.</div>' + state.audit.map(a => {
      const name = resolveUserDisplayName(a.userEmail || a.createdByEmail, a.userName);
      return `<div class="audit-item"><div class="audit-time">${escapeHtml(a.timeStr)} · ${escapeHtml(name)}</div><div>${escapeHtml(a.text)}</div><div class="audit-time" style="margin-top:5px">${escapeHtml(a.objectName || '—')}</div></div>`;
    }).join('');
  }

  // === НАСТРОЙКИ ===
  function openSettingsModal() {
    document.getElementById('settingHoldLoad').value = settings.holdLoad;
    document.getElementById('settingHoldArrive').value = settings.holdArrive;
    document.getElementById('settingHoldTtn').value = settings.holdTtn;
    document.getElementById('settingCycleMinutes').disabled=!canAdmin();
    document.getElementById('settingCycleMinutes').value = Math.max(MIN_CYCLE_MINUTES, settings.cycleMinutes || MIN_CYCLE_MINUTES);
    for(const name of ['hapticArrive','hapticLoad','hapticTtn'])document.getElementById(name).checked=!!settings[name];
    document.getElementById('settingsModal').classList.add('open');
  }
  function closeSettingsModal() { document.getElementById('settingsModal').classList.remove('open'); }
  function updateHoldSetting(t,v) { let f=parseFloat(v); f = isNaN(f)?0.5:Math.max(0,Math.min(5,f)); if(t==='load') settings.holdLoad=f; else if(t==='arrive') settings.holdArrive=f; else settings.holdTtn=f; localStorage.setItem('dt_settings', JSON.stringify(settings)); }
  async function updateCycleMinutes(v) {
    if(!canAdmin()){showError('Время ходки задаёт администратор');return;}
    if(!navigator.onLine){showError('Для изменения общего времени ходки требуется связь');return;}
    const n=Math.max(15,parseInt(v)||15);
    try{await appConfigRef.set({cycleMinutes:n},{merge:true});settings.cycleMinutes=n;localStorage.setItem('dt_settings',JSON.stringify(settings));renderAll();}
    catch(e){showError('Время ходки не сохранено: '+e.message);}
  }
  function toggleSetting(k,v) { settings[k]=v; localStorage.setItem('dt_settings', JSON.stringify(settings)); }

  function renderAll() {
    renderHeaderStats();
    if (hasTabAccess('line')) renderLine();
    if (hasTabAccess('report')) renderReport();
    if (hasTabAccess('archive')) renderArchive();
    if (hasTabAccess('trucks')) { renderGlobalTrucksManage(); renderGlobalObjectsManage(); }
    if (hasTabAccess('analytics')) renderAnalytics();
    if (canAdmin()) renderAdminPanel();
    renderStatusTicker();
    updateSyncUI();
  }

  // === SWITCH TAB (с жёсткой проверкой безопасности) ===
  function switchTab(name, btn) {
    if (name === 'admin' && !canAdmin()) { showError('Только админ'); return; }
    if (!name.startsWith('plugin-') && name !== 'admin' && !hasTabAccess(name)) { showError('Нет доступа'); return; }
    // === SECURITY: до загрузки прав разрешена только вкладка line ===
    if (!permissionsLoaded && name !== 'line' && name !== 'admin') {
      showError('Подождите, идёт загрузка прав...'); return;
    }
    document.querySelectorAll('.tab-content').forEach(e=>e.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(e=>e.classList.remove('active'));
    let t = document.getElementById('tab-'+name); if(t) t.classList.add('active');
    if(btn) btn.classList.add('active');
    window.scrollTo(0,0);
    if (pluginTabs[name]) pluginTabs[name].render(pluginTabs[name].container); else renderAll();
  }

  window.addEventListener('DOMContentLoaded', () => {
    loadMaxQueue(); renderAll(); updateSyncUI();
    window.addEventListener('online', () => { offlineTransportRecovered(); updateSyncUI(); runMaxQueue(); offlineReplayJournal(); });
    window.addEventListener('offline', updateSyncUI);
    let e = localStorage.getItem('dt_saved_email'); if(e) document.getElementById('userBadgeLabel').textContent = '👤 ' + sanitizeName(e);
    document.getElementById('newTruckType').addEventListener('change', toggleVolInput);
    setTimeout(runMaxQueue, 2000);
  });
  setInterval(updateSyncUI, 3000);
  setInterval(offlineReplayJournal, 8000);
  setInterval(() => { if (maxQueue.length && !maxSenderRunning) runMaxQueue(); }, 20000);

  window.__testGetShift = () => state.shift;
