
const firebaseConfig = {
    apiKey: "AIzaSyB42a5kp__3i9rD2BocdnOuKKoSlvEFLI4",
    authDomain: "samosval-test.firebaseapp.com",
    projectId: "samosval-test",
    storageBucket: "samosval-test.firebasestorage.app",
    messagingSenderId: "537285153088",
    appId: "1:537285153088:web:cc40d712f36581784a2aa5"
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

  const ALL_TABS = ['line', 'timesheet', 'report', 'archive', 'trucks', 'analytics', 'backup', 'admin'];
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
  window.TestStorageState={persistent:false,error:null};
  try { db.enablePersistence({ synchronizeTabs: true }).then(()=>{window.TestStorageState.persistent=true;}).catch(e=>{window.TestStorageState.error=e?.code||e?.message;}); } catch (e) {window.TestStorageState.error=e?.message;}

  // Isolated test connection: production project must never be used here.
  const PRODUCTION_FIREBASE_PROJECT_ID = 'samosval-test';
  if (firebase.app().options.projectId !== PRODUCTION_FIREBASE_PROJECT_ID) {
    throw new Error('Защита рабочей версии: подключён неверный Firebase-проект');
  }
  const WORKSPACE_ID = 'main_workspace';
  const wsRef = db.collection('workspaces').doc(WORKSPACE_ID);
  const refs = {
    trucks: wsRef.collection('trucks'), objects: wsRef.collection('objects'), logs: wsRef.collection('logs'),
    truckStatus: wsRef.collection('truckStatus'), shift: wsRef.collection('shift').doc('current'),
    archive: wsRef.collection('archive'), trash: wsRef.collection('trash'), audit: wsRef.collection('audit'),
    coinTransactions: wsRef.collection('coinTransactions'),
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

  let settings = Object.assign({ hapticArrive: true, hapticLoad: true, hapticTtn: true, cycleMinutes: MIN_CYCLE_MINUTES, holdLoad: 0.5, holdArrive: 0.5, holdTtn: 0.5 }, JSON.parse(localStorage.getItem('dt_settings_test347') || '{}'));

  let state = { trucks: [], objects: [], logs: [], truckStatus: {}, shift: null, archive: [], trash: [], audit: [], notifications: [], users: [], requests: [], plugins: [], patches: [] };
  let permissionsConfig = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
  let appConfig = { maxEnabled: false, maxUrl: '', maxToken: '', maxChatId: '', notifyStart: true, notifyArrive: true, notifyLoad: true, notifyTtn: true, notifyLineStart: true, notifyLineEnd: true };

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

  function pendingStart() { pendingOps++; updateSyncUI(); }
  function pendingEnd() { pendingOps = Math.max(0, pendingOps - 1); updateSyncUI(); }
  function tf(p) { pendingStart(); p.then(() => pendingEnd()).catch(e => { console.warn(e); pendingEnd(); }); }
  async function tfAwait(p) { pendingStart(); try { return await p; } finally { pendingEnd(); } }
  let syncState = { fromCache: {}, everConnected: {}, docCount: {}, pendingWrites: {}, lastSuccessAt: 0 };

  // === СИСТЕМА ПАТЧЕЙ ===
