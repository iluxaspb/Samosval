
const firebaseConfig = {
    apiKey: "AIzaSyB42a5kp__3i9rD2BocdnOuKKoSlvEFLI4",
    authDomain: "samosval-test.firebaseapp.com",
    projectId: "samosval-test",
    messagingSenderId: "537285153088",
    storageBucket: "samosval-test.firebasestorage.app",
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
    senior_foreman: { label: 'Старший прораб', icon: '👑', color: 'senior_foreman' },
    foreman: { label: 'Прораб', icon: '🔧', color: 'foreman' },
    master: { label: 'Мастер', icon: '🛠', color: 'master' },
    lopater: { label: 'Лопатер', icon: '🪏', color: 'lopater' },
    viewer: { label: 'Наблюдатель', icon: '👁', color: 'viewer' }
  };

  const ALL_TABS = ['line', 'timesheet', 'report', 'archive', 'trucks', 'analytics', 'backup', 'admin'];
  const TAB_LABELS = { timesheet: 'Табель', line: 'Линия', report: 'Сводка', archive: 'Архив', trucks: 'База', analytics: 'Аналитика', backup: 'Резерв', admin: 'Админ' };

  const ALL_ACTIONS = [
    'timesheet_edit', 'timesheet_manage', 'timesheet_export',
    'start_shift', 'close_shift', 'edit_line', 'action_arrive', 'action_load', 'action_ttn', 'line_timer_reset', 'undo_action',
    'view_truck_phone', 'call_truck_phone', 'add_truck_phone',
    'edit_logs', 'manage_trucks', 'manage_objects', 'archive_edit', 'archive_delete', 'import_backup',
    'view_card_stats', 'view_header', 'undo_any', 'view_gai_report', 'view_reis_in_ticker'
  ];
  const ACTION_LABELS = {
    timesheet_edit: 'Табель: часы и материалы', timesheet_manage: 'Табель: справочники и экипажи', timesheet_export: 'Табель: выгрузка CSV',
    start_shift: 'Начать смену', close_shift: 'Закрыть смену', edit_line: 'Изменять линию',
    action_arrive: 'Кнопка «Приехал»', action_load: 'Кнопка «Погрузка»', action_ttn: 'Кнопка «ТТН»', line_timer_reset: 'Сброс таймера ходки',
    undo_action: 'Отменять СВОИ действия', undo_any: 'Отменять действия ЛЮБОГО пользователя',
    view_truck_phone: 'Читать телефон самосвала', call_truck_phone: 'Кнопка Позвонить', add_truck_phone: 'Добавлять отсутствующий телефон',
    edit_logs: 'Редактировать рейсы', manage_trucks: 'Управлять базой самосвалов', manage_objects: 'Управлять базой объектов',
    archive_edit: 'Редактировать архив', archive_delete: 'Удалять из архива', import_backup: 'Импорт бэкапа',
    view_card_stats: 'Показывать рейсы/объем на карточках', view_header: 'Показывать верхнюю панель (шапку)',
    view_gai_report: 'Показывать отчет ГАИ', view_reis_in_ticker: 'Показывать № рейса в статус-баре'
  };

  ALL_ACTIONS.push('history_view','history_undo_own','history_undo_any','history_redo_own','history_redo_any');
  Object.assign(ACTION_LABELS,{"history_view": "Открывать журнал отмены и восстановления", "history_undo_own": "Отменять свои действия в журнале", "history_undo_any": "Отменять любые действия в журнале", "history_redo_own": "Восстанавливать свои действия в журнале", "history_redo_any": "Восстанавливать любые действия в журнале"});
  // Гранулярные права на вкладки табеля. Если роли ни одно из них не выдано,
  // табель показывает все вкладки как раньше (обратная совместимость).
  ALL_ACTIONS.push('tabel_tab_shift','tabel_tab_table','tabel_tab_request','tabel_tab_catalog','tabel_tab_history');
  Object.assign(ACTION_LABELS,{"tabel_tab_shift": "Табель: Смена", "tabel_tab_table": "Табель: Таблица", "tabel_tab_request": "Табель: Заявки", "tabel_tab_catalog": "Табель: Справочник", "tabel_tab_history": "Табель: История"});
  const DEFAULT_PERMISSIONS = {
    // Старший прораб: все права прораба плюс сброс таймера ходки.
    senior_foreman: { tabs: ['line', 'report', 'archive', 'trucks', 'analytics', 'backup'], actions: ['start_shift', 'close_shift', 'edit_line', 'action_arrive', 'action_load', 'action_ttn', 'line_timer_reset', 'undo_action', 'undo_any', 'edit_logs', 'manage_trucks', 'manage_objects', 'archive_edit', 'archive_delete', 'view_card_stats', 'view_header', 'view_gai_report', 'view_reis_in_ticker'] },
    foreman: { tabs: ['line', 'report', 'archive', 'trucks', 'analytics', 'backup'], actions: ['start_shift', 'close_shift', 'edit_line', 'action_arrive', 'action_load', 'action_ttn', 'undo_action', 'undo_any', 'edit_logs', 'manage_trucks', 'manage_objects', 'archive_edit', 'archive_delete', 'view_card_stats', 'view_header', 'view_gai_report', 'view_reis_in_ticker'] },
    master: { tabs: ['line', 'report', 'archive', 'analytics'], actions: ['start_shift', 'edit_line', 'action_arrive', 'action_load', 'action_ttn', 'undo_action', 'view_card_stats', 'view_header', 'view_gai_report', 'view_reis_in_ticker'] },
    lopater: { tabs: ['line', 'report'], actions: ['action_arrive', 'action_load', 'undo_action', 'view_card_stats', 'view_header'] },
    viewer: { tabs: ['line', 'report', 'archive', 'analytics'], actions: ['view_card_stats', 'view_header', 'view_gai_report', 'view_reis_in_ticker'] }
  };

  // Если приложение открыто с домена Ubuntu — API по тому же origin:
  // это убирает CORS, порты и внешние блокировки.
  const WORKING_TEST_UBUNTU_API_BASE = (typeof location !== 'undefined' && location.hostname === 'samosval-test.iluxa.pro')
    ? location.origin
    : 'https://samosval-test.iluxa.pro';
  // Рабочая версия всегда работает через Ubuntu API (NAS-рантайм). Firebase
  // SDK не загружается (см. shell.html): все обращения firebase.* в активном
  // коде — за флагом FIREBASE_SDK_PRESENT, который здесь всегда false.
  // firebaseConfig остаётся: projectId используется в ключах localStorage.
  const FIREBASE_SDK_PRESENT = typeof firebase !== 'undefined';
  const workingFirebaseApp = null;
  const auth = null;
  // Заглушка db/refs для мёртвых Firebase-веток: построение цепочки
  // (.collection().doc()) ничего не бросает, но любой await такого объекта
  // отклоняется понятной ошибкой — мёртвые ветки падают громко, а загрузка
  // приложения не ломается.
  function makeFirebaseStub() {
    const unavailable = new Error('Firebase SDK не загружен: рабочая версия использует Ubuntu API');
    const stub = new Proxy(function () {}, {
      get(target, key) {
        if (key === 'then') return (resolve, reject) => Promise.reject(unavailable).then(resolve, reject);
        if (key === 'catch' || key === 'finally') return (fn) => Promise.reject(unavailable)[key](fn);
        if (key === Symbol.toPrimitive || key === 'toString') return () => 'firebase-unavailable';
        return stub;
      },
      apply() { return stub; }
    });
    return stub;
  }
  let secondaryApp;
  if (FIREBASE_SDK_PRESENT) {
    // Инвариант NAS-сборки: SDK не загружается. Если скрипты вернули в shell,
    // падаем громко на старте, а не по загадочным ошибкам в рантайме.
    throw new Error('Firebase SDK загружен, но рабочая версия работает только через Ubuntu API');
  }
  const db = makeFirebaseStub();
  // Legacy versions stored passwords in localStorage. Remove these credentials.
  try { localStorage.removeItem('working-test-saved-pass'); } catch (e) { console.warn('Не удалось очистить старый пароль', e); }
  window.TestStorageState = FIREBASE_SDK_PRESENT ? window.TestStorageState : { persistent: false, error: 'firebase-sdk-not-loaded' };
  const WT_STORAGE_PREFIX = 'working-test:';
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

  let settings = Object.assign({ hapticArrive: true, hapticLoad: true, hapticTtn: true, cycleMinutes: MIN_CYCLE_MINUTES, holdLoad: 0.5, holdArrive: 0.5, holdTtn: 0.5 }, JSON.parse(localStorage.getItem('working-test-settings') || '{}'));

  let state = { trucks: [], objects: [], logs: [], truckStatus: {}, shift: null, restoredShifts: [], archive: [], trash: [], audit: [], notifications: [], users: [], requests: [], plugins: [], patches: [] };
  // Object IDs are stable across rename; snapshot names are only fallback.
  function objectTitle(id, fallback = '—') {
    return (state.objects || []).find(o => o.id === id)?.name || fallback || '—';
  }
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
  let profileServerConfirmed = false;
  let permissionsServerConfirmed = false;
  // Monotonically changes for every Firebase Auth callback, including logout.
  // Async profile/permission work must never cross this boundary.
  let authSessionGeneration = 0;
  function isAuthSessionReady(generation = authSessionGeneration) {
    return generation === authSessionGeneration
      && !!currentUid
      && currentUserStatus === 'active'
      && profileServerConfirmed
      && permissionsServerConfirmed;
  }
  let appConfigSyncUid = '';
  let appConfigSyncGeneration = 0;
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
  // === ПАТЧИ (слой удалён в 1.7.10) ===
  // Живой функционал встроенных патчей перенесён в features/ (undo-redo,
  // analytics-v2, reset-hold, pretty-confirm, ticker-name, nav-sort,
  // fix-log-delete, anim-speeds, admin-compact). Пользовательские патчи из
  // коллекции auxiliary больше не исполняются: eval-патчи были механизмом
  // доставки правок до появления модульной сборки. Функции остаются
  // совместимыми заглушками — их вызывают 21-nas-runtime и reset-settings.
  async function loadAndApplyPatches() {
    if(isNasRuntime())return refreshNasAuxiliary();
    return;
  }

  function applyAllPatches() {
    // Патчи не применяются: функциональность вшита в модули features/.
    return;
  }

  function renderPatchesList() {
    // Вкладка «🔧 Патчи» удалена из админки вместе со слоем патчей.
    return;
  }
  function isForcedAdminEmail(email) { return String(email || '').toLowerCase() === FORCED_ADMIN_EMAIL; }
  function canViewReleaseHistory() { return permissionsLoaded && currentUserStatus === 'active' && ['admin','foreman','senior_foreman'].includes(currentUserRole); }
  function canAdmin() { return currentUserStatus === 'active' && currentUserRole === 'admin'; }

  // === SECURITY: пока permissionsLoaded === false, разрешаем только 'line' (и админа) ===
  function hasTabAccess(tabName) {
    if(currentUserStatus!=='active')return false;
    if (currentUserRole === 'admin') return true;
    if (!permissionsLoaded) return tabName === 'line';
    if(tabName==='timesheet'&&(currentUserRole==='foreman'||currentUserRole==='senior_foreman'))return true;
    if (!permissionsConfig[currentUserRole]) return false;
    return Array.isArray(permissionsConfig[currentUserRole].tabs) && permissionsConfig[currentUserRole].tabs.includes(tabName);
  }

  function hasPermission(action) { if(currentUserStatus!=='active')return false; if (currentUserRole === 'admin') return true; if (!permissionsLoaded) return false; const actions = permissionsConfig[currentUserRole]?.actions; return Array.isArray(actions) && actions.includes(action); }

  // Вкладки табеля, доступные текущему пользователю. Пока роли не выдано ни одного
  // granular-права tabel_tab_*, возвращаем null: табель показывает все вкладки как
  // раньше, чтобы существующие права пользователей не менялись автоматически.
  function tabelTabViews(){
    if(currentUserRole === 'admin') return null;
    const granted = ['shift','table','request','catalog','history'].filter(tab => hasPermission('tabel_tab_' + tab));
    return granted.length ? granted : null;
  }
  function requireEdit(action, actionName) { if (hasPermission(action)) return true; showError('👁 Нет прав на ' + (actionName || 'это действие')); return false; }

  // === SECURITY: обновляем классы perm-blocked для кнопок ===
  function updateNavUI() {
    renderTestBackendControls();
    ALL_TABS.forEach(tab => {
      const btn = document.getElementById(tab==='timesheet'?'nav-tabel-v2':'nav-' + tab);
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

  function sessionCacheKey() { if(isNasRuntime())return 'samosval-working-test-cache-nas-v1:'+nasStorageScope(); return 'samosval-working-test-cache-v1:' + firebaseConfig.projectId + ':' + location.pathname + ':' + WORKSPACE_ID + ':' + (currentUid || 'signed-out'); }
  function saveCache() { try { localStorage.setItem(sessionCacheKey(), JSON.stringify({ trucks: state.trucks, objects: state.objects, logs: offlinePendingCount()?offlineRemoteLogs:state.logs, truckStatus: offlinePendingCount()?offlineRemoteStatuses:state.truckStatus, shift: state.shift, restoredShifts: state.restoredShifts||[], archive: state.archive, trash: state.trash, audit: state.audit.slice(0, 200), lineAudit: (state.lineAudit || []).slice(0, 200), notifications: (state.notifications || []).slice(0, 10), savedAt: Date.now() })); } catch(e) {} }
  function loadCache() { try { if (!currentUid) return; let raw = localStorage.getItem(sessionCacheKey()); if (!raw) return; let c = JSON.parse(raw); state.trucks = c.trucks||[]; state.objects = c.objects||[]; state.logs = c.logs||[]; state.truckStatus = c.truckStatus||{}; state.shift = c.shift||null; state.restoredShifts = c.restoredShifts||[]; state.archive = c.archive||[]; state.trash = c.trash||[]; state.audit = c.audit||[]; state.lineAudit = c.lineAudit||[]; state.notifications = c.notifications||[]; } catch(e) {} }

  function markSync(source, fromCache, hasPendingWrites, docCount) {
    if (syncState.errors) delete syncState.errors[source];
    syncState.fromCache[source] = !!fromCache; syncState.docCount[source] = docCount || 0;
    if (!fromCache) { syncState.everConnected[source] = true; syncState.lastSuccessAt = Date.now(); if(source==='status'||source==='shift')offlineTransportRecovered();try{if(typeof nasConnectionHeart==='function')nasConnectionHeart(true);}catch(_){} }
    syncState.pendingWrites[source] = !!hasPendingWrites;
    if (!hasPendingWrites) delete syncState.pendingWrites[source];
    updateSyncUI();
    // A replay may have been blocked by a just-completed status/shift write.
    // The queue must be retried when the authoritative snapshot confirms that
    // write; otherwise a load enqueued during arrival remains pending forever.
    if ((source === 'status' || source === 'shift') && !hasPendingWrites && typeof offlineReplayJournal === 'function' && offlinePendingCount() > 0) {
      queueMicrotask(() => offlineReplayJournal());
    }
  }
  function reportSyncError(source, error) {
    syncState.errors = syncState.errors || {};
    syncState.errors[source] = { code: error?.code || 'unknown', message: error?.message || String(error), at: Date.now() }; if(offlineTransportError(error))offlineTransportFailed(error);try{if(offlineTransportError(error))nasConnectionHeart(false,error);}catch(_){}
    console.error('[sync:' + source + ']', error);
    updateSyncUI();
  }
  function getSyncStatus() {
    const queued=offlinePendingCount();
    let showOffline=offlineServerUnreachable||!navigator.onLine;
    if(showOffline&&offlineStatusSince&&Date.now()-offlineStatusSince<OFFLINE_UI_GRACE_MS)showOffline=false;
    if(showOffline)return{ state: 'offline', text: 'Работа локально' + (queued ? ` · действий к отправке: ${queued}` : '') };
    if (Object.keys(syncState.errors || {}).length) {
      // Жёлтый баннер на весь экран оправдан только когда данных ещё нет:
      // первичная загрузка не удалась. Фоновый сбой источника, который уже
      // хотя бы раз успешно читался, не мельтешит баннером: ошибка видна
      // цветом точки синхронизации, её подсказкой и в диагностике по нажатию.
      const failed = Object.keys(syncState.errors);
      // Поле называется `everConnected` (его пишет markSync выше и читает
      // проверка `required` ниже). Обращение к несуществующему
      // `ever_connected` бросало TypeError прямо в renderAll, поэтому любой
      // фоновый сбой одного источника (например, nas-settings) ломал
      // отрисовку всего экрана вместо жёлтой точки синхронизации.
      if (failed.every(source => syncState.everConnected[source])) return { state: 'degraded', text: 'Перечитываем: ' + failed.join(', ') };
      return {state:'error',text:'Ошибка загрузки: ' + failed.join(', ')};
    }
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
    const backend = getTestBackendIndicator(st);
    renderTestBackendControls(st);
    let notice = document.getElementById('sessionSyncNotice');
    if (!notice) { notice = document.createElement('div'); notice.id = 'sessionSyncNotice'; notice.style.cssText = 'padding:8px 12px;font-size:12px;background:#332611;color:#fcd34d;line-height:1.4'; document.getElementById('mainHeader')?.append(notice); }
    // degraded — фоновая ошибка источника при уже загруженных данных: баннер
    // на весь экран не показываем, сбой виден только цветом точки и подсказкой.
    notice.hidden = !currentUid || st.state === 'ok' || st.state === 'syncing' || st.state === 'degraded';
    notice.textContent = st.text + (st.state === 'error' ? ' · Нажмите точку синхронизации для подробностей.' : '');
    dot.className = 'sync-dot ' + st.state;
    dot.textContent = backend.letter;
    dot.dataset.provider = backend.provider;
    const runtimeLabel = TEST_BACKEND_MODE_LABELS[window.WorkingTestAuthority?.runtimeProvider === 'ubuntu' ? 'ubuntu' : 'firebase'];
    let tip = backend.label + ' · ' + runtimeLabel + ' · ' + st.text;
    if (syncState.lastSuccessAt && (st.state === 'ok' || st.state === 'offline')) tip += ' · ' + formatTimeAgo(syncState.lastSuccessAt);
    dot.parentElement.title = tip;
    dot.parentElement.setAttribute('aria-label', tip);
    if (badge) {const count=pendingOps+offlinePendingCount();if(count>0){badge.textContent=count>99?'99+':count;badge.classList.add('show');}else badge.classList.remove('show');}
  }
  function showSyncDiagnostics() {
    const sources = ['trucks','objects','logs','status','shift','archive','trash','audit','notifications','plugins','patches','users','requests'];
    let lines = ['── ДИАГНОСТИКА ──', '', `Online: ${navigator.onLine ? 'да' : 'НЕТ'}`, `Пользователь: ${currentEmail || '—'}`, `Роль: ${ROLES[currentUserRole]?.label || currentUserRole || '—'}`, `Права загружены: ${permissionsLoaded ? 'да' : 'нет'}`, `Приехал: ${hasPermission('action_arrive') ? 'разрешено' : 'нет права'}`, `Погрузка: ${hasPermission('action_load') ? 'разрешено' : 'нет права'}`, `pendingOps: ${pendingOps}`, `Max: ${appConfig.maxEnabled ? 'вкл' : 'выкл'}`, `Патчей: ${state.patches.length}`, ''];
    lines.push('Режим сервера: ' + TEST_BACKEND_MODE_LABELS[window.WorkingTestAuthority?.runtimeProvider === 'ubuntu' ? 'ubuntu' : 'firebase'] + (window.WorkingTestAuthority?.generation ? ' (поколение ' + window.WorkingTestAuthority.generation + ')' : ''), getTestBackendIndicator(getSyncStatus()).label);
    // Вход выполняет локальный сервер Ubuntu, поэтому сессии Firebase нет и
    // синхронизация Firestore недоступна. Данные идут через Ubuntu API.
    lines.push('Вход: Ubuntu API · Firebase-синхронизация недоступна (нет сессии Firebase)');
    lines.push('Страница: ' + location.pathname, 'База: ' + firebaseConfig.projectId, 'UID: ' + (currentUid || '—'));
    Object.entries(syncState.errors || {}).forEach(([source,error]) => lines.push('ОШИБКА ' + source + ': ' + error.code + ' · ' + error.message));
    sources.forEach(s => { lines.push(`${s.padEnd(11)} | ${syncState.pendingWrites[s]?'ДА':'—'} | ${syncState.docCount[s]||0}`); });
    const rejected=offlineUnreviewedFailures();
    if(rejected.length) {
      lines.push('','── НЕПОДТВЕРЖДЁННЫЕ ДЕЙСТВИЯ ──');
      rejected.forEach(x=>lines.push(x.truckName||truckName(x.truckId),new Date(x.createdAt).toLocaleString('ru-RU'),offlineReasonLabel(x.result),''));
      lines.push('Карточки показывают итоговое серверное состояние.');
    }
    appNotice(lines.join('\n'));
    if(rejected.length) {
      const all=offlineJournalRead();
      all.forEach(x=>{if(x.status==='rejected')x.reviewed=true;});
      offlineJournalWrite(all);
    }
    // Инструмент разбора неподтверждённых изменений (панель с кнопками
    // «Повторить/Отбросить») открывается и отсюда, а не только из баннера
    // обновления.
    if(typeof window!=='undefined'&&typeof window.__wtShowUnsyncedPanel==='function'){try{window.__wtShowUnsyncedPanel();}catch(_){}}
  }
  function stopSync() {
    stopNasRuntime();
    lineCountAuditStop?.(); lineCountAuditStop = null; lineCountAuditKey = ''; state.lineAudit = [];
    unsubscribers.forEach(u => { try { u(); } catch(e){} }); unsubscribers = [];
    if (usersUnsubscriber) { try { usersUnsubscriber(); } catch(e){} usersUnsubscriber = null; }
    if (reqsUnsubscriber) { try { reqsUnsubscriber(); } catch(e){} reqsUnsubscriber = null; }
  }
  // TEST runtime is hosted on Ubuntu. Firebase is used only for authentication
  // tokens; application data and writes go through the Ubuntu API.
  const UBUNTU_API_BASE = WORKING_TEST_UBUNTU_API_BASE;
  function nasProvider() {
    // Единственный сервер данных — Ubuntu. Firebase используется только для
    // входа пользователей, переключения режимов больше нет.
    return 'ubuntu';
  }
  function isNasRuntime() { return nasProvider() !== 'firebase'; }
  function nasApiBase() { return UBUNTU_API_BASE; }
  function nasStorageScope() { const base=nasApiBase();let datasetEpoch=0;try{datasetEpoch=Number(localStorage.getItem('samosval-working-test-nas-epoch:'+JSON.stringify([base,WORKSPACE_ID,currentUid]))||0)||0;}catch{}return JSON.stringify([nasProvider(),base,WORKSPACE_ID,currentUid,...(datasetEpoch?[datasetEpoch]:[])]); }
  let nasRuntimeClient = null, nasRuntimeStop = null, nasRuntimeEpoch = 0, nasResumePolling=null, nasPollHolds=0, nasReadGeneration=0, nasPresenceTimer=null, nasGamesTimer=null;
  // Мост параллельных смен v2 (40-shift-contexts.js + 41-v2-transport.js).
  let nasV2Bridge = null;
  // Сбой моста до первого успешного ответа пишется в консоль один раз.
  let nasV2BridgeErrorLogged = false;
  // Пробуждение после смены сети: обработчики событий и защита от наложения.
  let nasWakeStop=null, nasWakeInFlight=false, nasWakeAt=0;
  // Активное обновление: пока приложение на экране, данные читаются сами.
  let nasActivityTimer=null, nasActivityInFlight=false, nasActivityPending=false, nasActivityGate=null;
  // Single-writer authority as announced by the server. The phone never decides
  // this on its own: it mirrors the server and stops writing when it is not the
  // declared authority.
  let nasAuthority = { provider: 'ubuntu', generation: 0 };
  const nasReceiptFloors = new Map();
  const nasPresenceLeavers=new Set();
  let nasAdministration=null,nasAdminRead=null,nasCatalogRead=null,nasCatalogSnapshot=null;
  let nasSettingsSnapshot=null,nasSettingsRead=null;
  let nasArchiveRead=null;
  let nasGameRead=null,nasGameSnapshot=null,nasGameReady=false,nasGameReceiptFloor=0;
  let nasAuxSnapshot=null,nasAuxRead=null;
  // Хэши значимых данных линии и сеанса: неизменный снапшот не должен
  // гонать полную перерисовку (карточки «Линии» дёргались на каждом цикле).
  function nasStableHash(value){try{return JSON.stringify(value);}catch(_){return null;}}
  let nasLineHash=null,nasSessionHash=null;
  // После сворачивания приложения сокет и таймеры могут «умереть». Пока
  // «сторож» промиса не пуст, повторный вызов возвращает тот же мёртвый
  // промис, и ошибка источника никогда не снимается. При возврате в
  // приложение сторожа сбрасываются, и чтение начинается заново.
  // Флаги серии и пробуждения сбрасываются тоже: на замороженной вкладке их
  // «finally» может не выполниться никогда, и тогда каждый новый возврат из
  // фона уходил в «pending», а реальный запрос с прерыванием мёртвого сокета
  // (nasNetworkWake → abortInflight) не запускался — оставался «не в сети».
  function nasDropHungReads(){nasSettingsRead=null;nasArchiveRead=null;nasGameRead=null;nasAuxRead=null;nasCatalogRead=null;nasAdminRead=null;nasActivityInFlight=false;nasActivityPending=false;nasActivityGate=null;}
  // Правила повторов живут в отдельном файле 26-nas-resume.js. До его
  // загрузки (и в тестах) пользуемся безопасной копией того же состояния.
  function nasSyncNewState(){return typeof WorkingTestNasResume!=='undefined'?WorkingTestNasResume.createState():{items:{}};}
  function nasSyncApi(){return typeof WorkingTestNasResume!=='undefined'?WorkingTestNasResume:null;}
  let nasSyncRetry=nasSyncNewState(), nasSyncTimer=null, nasLastSessionAt=0, nasHiddenAt=0;
  const nasCommandFlights=new Map();
  function stopNasRuntime() {
    if(typeof resetTruckPhones==='function')resetTruckPhones();
    nasStopV2Shifts();
    nasRuntimeEpoch++;nasReadGeneration++;nasResumePolling=null;nasPollHolds=0;
    nasConnectionStop();
    nasWakeStop?.();nasWakeStop=null;nasWakeInFlight=false;nasWakeAt=0;
    if(nasActivityTimer&&typeof clearInterval==='function'){clearInterval(nasActivityTimer);nasActivityTimer=null;}
    nasActivityTimer=null;nasActivityInFlight=false;nasActivityPending=false;nasActivityGate=null;
    if(nasSyncTimer&&typeof clearInterval==='function'){clearInterval(nasSyncTimer);nasSyncTimer=null;}
    nasSyncTimer=null;nasSyncRetry=nasSyncNewState();nasLastSessionAt=0;nasHiddenAt=0;
    if(nasPresenceTimer&&typeof clearInterval==='function'){clearInterval(nasPresenceTimer);nasPresenceTimer=null;}
    if(nasGamesTimer&&typeof clearInterval==='function'){clearInterval(nasGamesTimer);nasGamesTimer=null;}
    nasRuntimeStop?.(); nasRuntimeStop = null;
    nasRuntimeClient?.stop(); nasRuntimeClient = null;
    nasReceiptFloors.clear();
    nasPresenceLeavers.clear();
    nasAdministration=null;nasAdminRead=null;nasCatalogRead=null;nasCatalogSnapshot=null;nasCommandFlights.clear();
    nasSettingsSnapshot=null;nasSettingsRead=null;
    nasArchiveRead=null;
    nasGameRead=null;nasGameSnapshot=null;nasGameReady=false;nasGameReceiptFloor=0;
    nasAuxSnapshot=null;nasAuxRead=null;
    nasLineHash=null;nasSessionHash=null;
  }
  // Резерв может быть ещё не наполнен: администратору нужен выход обратно на
  // Firebase прямо с экрана ожидания, иначе режим не вернуть из интерфейса.
  function installNasReturnToFirebase(){
    const card=document.querySelector('#pendingScreen .pending-card');
    if(!card||document.getElementById('nasReturnFirebaseBtn'))return;
    const btn=document.createElement('button');
    btn.id='nasReturnFirebaseBtn';btn.className='btn btn-secondary';
    btn.style.width='100%';btn.style.marginTop='10px';
    btn.textContent='Вернуться на Firebase (администратор)';
    btn.addEventListener('click',async()=>{
      btn.disabled=true;
      try{
        const snap=await db.collection('users').doc(currentUid).get();
        if(!snap.exists||snap.data().role!=='admin')throw Error('Вернуть режим может только администратор');
        const current=await readWorkingAuthority();
        await writeAuthority('firebase',current.generation);
        showToastEl('Сервер данных: Firebase',false);
        location.reload();
      }catch(error){
        btn.disabled=false;
        showError(error.message||'Не удалось вернуть режим');
      }
    });
    card.append(btn);
  }
  function loadNasSessionClient() { return import(new URL('./working-test/synology/session-client.mjs',document.baseURI).href); }
  function applyNasSession(session) {
    const profile=session.profile, active=session.identityReady&&profile?.status==='active'&&!profile.deleted;
    // Значимая часть сеанса — права и профиль. Пока она не изменилась, полная
    // перерисовка не нужна: снапшоты линии приходят своим путём.
    const sessionChanged=nasStableHash([session.permissions,profile?.role,profile?.status,profile?.deleted,profile?.nickname])!==nasSessionHash;
    if(sessionChanged)nasSessionHash=nasStableHash([session.permissions,profile?.role,profile?.status,profile?.deleted,profile?.nickname]);
    if(session.authority&&Number.isSafeInteger(session.authority.generation)&&session.authority.generation>0){
      const next={provider:session.authority.provider==='firebase'?'firebase':'ubuntu',generation:session.authority.generation};
      if(next.provider!==nasAuthority.provider||next.generation!==nasAuthority.generation){
        const previous=nasAuthority;nasAuthority=next;
        try{if(typeof CustomEvent==='function')window.dispatchEvent(new CustomEvent('samosval-working-test-authority-changed',{detail:{previous,current:next}}));}catch(_){}
      }
    }
    if(currentUserRole&&currentUserRole!==profile?.role){nasReadGeneration++;nasGameSnapshot=null;nasGameReady=false;nasGameReceiptFloor=0;window.__gameAccessChanged?.();}
    currentUserRole=profile?.role||null;currentUserStatus=active?'active':profile?.status==='disabled'||profile?.deleted?'disabled':'pending';
    currentUserNickname=profile?.nickname||sanitizeName(currentEmail);
    permissionsConfig=active?{...(currentUserRole==='admin'?permissionsConfig:{}),[currentUserRole]:session.permissions}:{};permissionsLoaded=!!active;
    if((!active||!hasPermission('view_truck_phone'))&&typeof resetTruckPhones==='function')resetTruckPhones();
    // The NAS session arrives over authenticated HTTPS from the server, so it
    // is the server confirmation for profile and permissions. Without this the
    // game wallet reported "ready" while every action was refused as unsynced.
    profileServerConfirmed=!!active;permissionsServerConfirmed=!!active;
    if(active)document.body.setAttribute('data-perms-ready','1');else document.body.removeAttribute('data-perms-ready');
    document.getElementById('pendingScreen').style.display=currentUserStatus==='pending'?'flex':'none';
    document.getElementById('disabledScreen').style.display=currentUserStatus==='disabled'?'flex':'none';
    document.getElementById('mainHeader').style.display=active?'':'none';
    document.querySelector('.container').style.display=active?'':'none';document.querySelector('nav').style.display=active?'flex':'none';
    if(!active){
      nasSettingsSnapshot=null;appConfig={};nasGameSnapshot=null;nasGameReady=false;nasGameReceiptFloor=0;window.__gameAccessChanged?.();
      state.trucks=[];state.logs=[];state.truckStatus={};state.shift=null;state.restoredShifts=[];state.archive=[];state.trash=[];state.audit=[];state.users=[];
      offlineRemoteStatuses={};offlineRemoteLogs=[];initialized=false;cancelHold();
      document.querySelectorAll('dialog[open]').forEach(d=>d.close());
      document.getElementById('registrationStatusText').textContent = session.identityReady
        ? 'Учётная запись ожидает допуска на сервере Ubuntu.'
        : 'В Ubuntu-резерве нет вашей учётной записи: резерв ещё не наполнен рабочими данными. Вернитесь на Firebase, если вы администратор.';
      document.getElementById('disabledStatusText').textContent=profile?.rejectionReason||'Доступ ограничен администратором.';
      installNasReturnToFirebase();
    }
    markSync('profile',false,false,profile?1:0);markSync('permissions',false,false,active?1:0);
    if(!sessionChanged)return;
    updateUserBadge();updateNavUI();applyRoleUI();renderAll();
  }
  // NAS versions deployed before the server ticker fix return opaque truck IDs.
  // The browser can safely render its verified catalog without changing NAS data.
  function presentNasLineNotification(item){
    if(!item||typeof item.id!=='string'||!item.id.startsWith('nas_')||!['arrive','load','ttn','reset'].includes(item.type))return item;
    const labels={arrive:'Прибытие на линию',load:'Погрузка',ttn:'Отметка ТТН',reset:'Сброс таймера'};
    const truck=state.trucks.find(row=>row.id===item.truckId);
    const visibleTruck=truck?truckLabelHtml(item.truckId):'<b>Самосвал</b>';
    const log=item.type==='load'&&!item.logId?state.logs.find(row=>row.clientOperationId===item.actionId&&row.truckId===item.truckId&&row.shiftId===item.shiftId):null;
    return {...item,html:labels[item.type]+' · '+visibleTruck,...(log?{logId:log.id}:{})};
  }
  function refreshNasLineNotificationDisplay(){
    state.notifications=(state.notifications||[]).map(presentNasLineNotification);
  }
  function acceptNasLineSnapshot(snapshot) {
    // A snapshot read before a committed receipt must not roll the UI backwards.
    for(const floor of nasReceiptFloors.values()){
      if(floor.shiftId!==snapshot.shift?.id)continue;
      const status=snapshot.statuses.find(s=>s.id===floor.truckId);
      if(!status||Number(status.cycleRevision||0)<floor.cycle||Number(status.ttnRevision||0)<floor.ttn)return false;
    }
    nasReceiptFloors.clear();
    // Неизменный снапшот не перерисовывает интерфейс: полная перерисовка
    // гоняет все вкладки, а таймеры ходки пересортировывают карточки каждый
    // цикл. Хэш покрывает всё значимое: смены, машины, статусы и рейсы.
    const significant=[snapshot.shift,snapshot.trucks,snapshot.statuses,snapshot.logs,snapshot.restoredShifts||[],snapshot.cycleMinutes];
    const nextHash=nasStableHash(significant);
    const lineChanged=nextHash!==null&&nextHash!==nasLineHash;
    if(lineChanged)nasLineHash=nextHash;
    state.shift=snapshot.shift;state.trucks=snapshot.trucks;
    // Восстановленные для правок архивные смены живут параллельно активной
    // линии: пользователь редактирует их через отчёт, не закрывая текущую.
    // v1-снапшот отдаёт их только на старом сервере; на канонической схеме
    // карточки приходят из v2-контекстов (nasRestoredShiftsCombined).
    nasRestoredV1=snapshot.restoredShifts||[];
    state.restoredShifts=nasRestoredShiftsCombined();
    // Рейсы восстановленных смен попадают в общий список: правки (✏️/X) ищут
    // лог по id, а сводки активной смены фильтруются по shiftId и их не видят.
    // offlineRemoteLogs — источник офлайн-проекции: кладём их туда, иначе
    // offlineProjectState затрёт список своим срезом.
    const restoredLogs=state.restoredShifts.flatMap(r=>r.logs);
    offlineRemoteLogs=[...snapshot.logs,...restoredLogs];
    settings.cycleMinutes=snapshot.cycleMinutes;
    offlineRemoteStatuses=Object.fromEntries(snapshot.statuses.map(s=>[s.id,s]));
    // NAS snapshots are authoritative: ticker load events must match confirmed logs.
    confirmedLoadIds=new Set(snapshot.logs.map(log=>log.id));
    offlineProjectState();initialized=true;
    refreshNasLineNotificationDisplay();
    for(const [source,count] of [['trucks',snapshot.trucks.length],['status',snapshot.statuses.length],['logs',snapshot.logs.length],['shift',snapshot.shift?1:0]])markSync(source,false,false,count);
    markSync('nas',false,false,snapshot.logs.length);
    // Кеш и перерисовку обновляем только при реальных изменениях линии.
    if(!lineChanged)return true;
    saveCache();renderAll();return true;
  }
  // Разовое пробуждение после смены сети (VPN, Wi-Fi <-> мобильная) или
  // возврата во вкладку. Один короткий запрос probe(); при успехе сбрасываем
  // флаг «Работа локально», сразу читаем линию и отправляем накопленную
  // очередь. Отдельного цикла нет — только существующая подписка.
  async function nasNetworkWake(epoch,client,{force=false}={}){
    if(!client||epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||nasWakeInFlight)return;
    if(typeof navigator!=='undefined'&&!navigator.onLine)return;
    const now=Date.now();
    if(!force&&now-nasWakeAt<2500)return;
    nasWakeAt=now;nasWakeInFlight=true;
    const live=()=>epoch===nasRuntimeEpoch&&client===nasRuntimeClient;
    try{
      // Зависшие чтения прошлого соединения не должны перекрывать проверку.
      nasDropHungReads();
      try{nasRuntimeClient?.abortInflight?.();}catch(_){}
      // Probe идёт отдельным запросом: зависшие фоновые чтения его не держат.
      let probeOk=false;
      try{if(typeof client.probe==='function')await client.probe(15000);else await client.readSession();probeOk=true;}catch(_){probeOk=false;}
      // Результат пробы питает единый супервизор связи: восстановление
      // подтверждается сразу, а не по 15-с таймауту его цикла.
      if(probeOk)nasConnection?.reportSuccess?.();else nasConnection?.reportFailure?.('transport');
      if(!probeOk)return;
      if(!live())return;
      offlineTransportRecovered();
      // Связь подтверждена: ошибки источников читаем заново без задержки.
      nasSyncApi()?.reset?.(nasSyncRetry);
      nasResumePolling?.();
      await nasRefreshLine().catch(()=>{});
      if(live())void replayNasOfflineJournal().catch(()=>{});
    }catch(_){
      // Краткий обрыв связи: подписка повторит попытку сама. Без уведомлений.
    }finally{nasWakeInFlight=false;}
  }
  function nasActivityApi(){return typeof WorkingTestNasActivity!=='undefined'?WorkingTestNasActivity:null;}
  // Единый канал восстановления связи (1.7.10): состояние одно на всё
  // приложение, повторы — только здесь. Пока супервизор считает связь
  // потерянной, каналы не шлют собственных повторов.
  let nasConnection=null;
  function nasConnectionOnline(){return !nasConnection||nasConnection.snapshot().online;}
  function nasConnectionStop(){try{nasConnection?.stop?.();}catch(_){}nasConnection=null;}
  // «Сердце» связи: любой успешный ответ канала подтверждает связь, любая
  // транспортная ошибка любого канала — единственный сигнал потери.
  // Вызывается из markSync/reportSyncError (03-formatting.js).
  function nasConnectionHeart(ok,error){
    if(!nasConnection)return;
    try{
      if(ok)nasConnection.reportSuccess();
      else nasConnection.reportFailure(error?.name==='TypeError'||!navigator?.onLine?'browser-offline':'transport');
    }catch(_){}
  }
  function nasStartConnection(client,epoch){
    const api=typeof WorkingTestNasConnection!=='undefined'?WorkingTestNasConnection:null;
    if(!api)return;
    nasConnectionStop();
    nasConnection=api.create({
      probe:async()=>{
        if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Сеанс изменился');
        // Проба — лёгкий GET /api/v1/session с 15-с таймаутом.
        if(typeof client.probe==='function')return await client.probe(15000);
        return await client.readSession();
      },
      log:text=>{console.log(text);},
      emit:(kind,detail)=>{
        try{window.dispatchEvent(new CustomEvent('samosval-working-test-connection',{detail:{kind,...detail}}));}catch(_){}
        if(kind==='offline'){
          // Одно сообщение на переход, а не по одному на каждый канал.
          showToastEl('📴 Нет связи с сервером, переподключаюсь…',true);
        }else if(kind==='online'){
          showToastEl('✅ Связь восстановлена',false);
          // Один общий цикл перечитывания: линия первой (урок 1.6.0).
          nasDropHungReads();
          nasSyncApi()?.reset?.(nasSyncRetry);
          nasResumePolling?.();
          void nasRefreshLine().catch(()=>{}).then(()=>{
            if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)return;
            const reads=[refreshNasObjects,refreshNasSettings,refreshNasAuxiliary,refreshNasGames];
            if(hasTabAccess('archive')||hasTabAccess('analytics'))reads.push(refreshNasArchive);
            if(canAdmin())reads.push(refreshNasAdministration);
            return Promise.allSettled(reads.map(read=>{try{return Promise.resolve(read());}catch(_){return Promise.resolve();}}));
          }).then(()=>{if(epoch===nasRuntimeEpoch&&client===nasRuntimeClient)void replayNasOfflineJournal().catch(()=>{});});
        }
        try{updateSyncUI();}catch(_){}
      }
    });
  }
  // Быстрая проверка связи при возврате из фона: лёгкий probe() прерывает
  // мёртвые сокеты (abortInflight) и снимает «Работа локально» за секунды,
  // не дожидаясь полной серии nasActiveRefresh и её reads.
  function nasFastLinkCheck(epoch,client){
    if(!client||epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)return;
    if(typeof navigator!=='undefined'&&navigator.onLine===false)return;
    if(typeof document!=='undefined'&&document.hidden)return;
    try{client.abortInflight?.();}catch(_){}
    Promise.resolve(client.probe()).then(()=>{if(epoch===nasRuntimeEpoch&&client===nasRuntimeClient){offlineTransportRecovered();nasConnection?.reportSuccess?.();}},()=>{if(epoch===nasRuntimeEpoch&&client===nasRuntimeClient)nasConnection?.reportFailure?.('transport');});
  }
  function nasActivityGateState(){if(!nasActivityGate){const api=nasActivityApi();nasActivityGate=api?api.createGate({minGap:4000}):{lastAt:0,minGap:4000,pending:false};}return nasActivityGate;}
  // Приложение активно на экране: вкладка видима и сеть есть.
  function nasScreenActive(){if(typeof document!=='undefined'&&document.hidden)return false;if(typeof navigator!=='undefined'&&navigator.onLine===false)return false;return true;}
  // Полное обновление всех данных, пока приложение активно. Ничего не экономим:
  // линия, справочники, игры, настройки, архив и админка перечитываются при
  // каждом возврате на экран и по таймеру. Порядок важен: линия первой, потому
  // что она поднимает поколение чтений и отменяет устаревшие ответы.
  async function nasActiveRefresh(reason,{force=true}={}){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||epoch!==nasRuntimeEpoch||currentUserStatus!=='active')return false;
    if(!nasScreenActive())return false;
    // Периодический опрос не идёт, пока супервизор считает связь потерянной:
    // он сам перечитает все источники после первой успешной пробы.
    if(reason==='poll'&&!nasConnectionOnline())return false;
    // Оффлайн по решению супервизора: не шлём новые запросы каналов до
    // восстановления пробы. Исключение — браузер сообщил «сеть вернулась»:
    // это и есть сигнал для пробуждения.
    if(reason!=='online'&&!nasConnectionOnline())return false;
    const api=nasActivityApi(),gate=nasActivityGateState();
    const allowed=api?api.allow(gate,Date.now(),force):true;
    if(!allowed){nasActivityPending=true;return false;}
    if(nasActivityInFlight){nasActivityPending=true;return false;}
    nasActivityInFlight=true;
    const live=()=>epoch===nasRuntimeEpoch&&client===nasRuntimeClient&&currentUserStatus==='active'&&nasScreenActive();
    try{
      if(reason==='poll'){
        // Периодический опрос не рвёт текущие запросы пользователя и не
        // перезапускает подписку: перечитываем линию и остальные источники.
        await nasRefreshLine().catch(()=>{});
      }else{
        // Возврат на экран: полный путь пробуждения — проверка связи,
        // подписка и линия.
        await nasNetworkWake(epoch,client,{force:true});
      }
      if(!live())return false;
      // Бэкофф надзирателя (26-nas-resume) уважается и здесь: источник, чья
      // последняя ошибка моложе текущей паузы повтора, не перечитывается
      // этим циклом — его повторит надзиратель по расписанию. Раньше 15-с
      // цикл и надзиратель конкурировали, и ретраи шли в 2–3 раза чаще
      // номинала.
      const resume=nasSyncApi(),syncErrors=(typeof syncState!=='undefined'&&syncState.errors)||{};
      const reads=[['nas-objects',refreshNasObjects],['nas-settings',refreshNasSettings],['nas-auxiliary',refreshNasAuxiliary],['nas-games',refreshNasGames]];
      if(hasTabAccess('archive')||hasTabAccess('analytics'))reads.push(['nas-archive',refreshNasArchive]);
      if(canAdmin())reads.push(['nas-admin',refreshNasAdministration]);
      await Promise.allSettled(reads.map(([source,read])=>{
        if(resume&&syncErrors[source]&&!resume.due(nasSyncRetry,source,Date.now()))return Promise.resolve();
        try{return Promise.resolve(read());}catch(error){return Promise.reject(error);}
      }));
      if(live())void replayNasOfflineJournal().catch(()=>{});
      return true;
    }catch(_){return false;}
    finally{nasActivityInFlight=false;
      if(nasActivityPending){nasActivityPending=false;setTimeout(()=>{void nasActiveRefresh('pending',{force:false});},0);}}
  }
  // Ключ ошибки источника → повторное чтение. Успешное чтение само снимает
  // ошибку через markSync, поэтому отдельной очистки здесь не нужно.
  function nasSyncSources(){
    return {'nas':nasRefreshLine,'nas-objects':refreshNasObjects,'nas-games':refreshNasGames,
      'nas-auxiliary':refreshNasAuxiliary,'nas-archive':refreshNasArchive,
      'nas-settings':refreshNasSettings,'nas-admin':refreshNasAdministration};
  }
  // Надзиратель: повторяет чтение только упавших источников с нарастающей
  // паузой. Ничего не делает, когда приложение свёрнуто, сети нет или связь
  // потеряна по решению единого супервизора (повторы делает только он).
  function nasSyncSupervisorTick(){
    if(typeof document!=='undefined'&&document.hidden)return;
    if(typeof navigator!=='undefined'&&!navigator.onLine)return;
    if(!nasConnectionOnline())return;
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||epoch!==nasRuntimeEpoch||currentUserStatus!=='active')return;
    const resume=nasSyncApi();if(!resume)return;
    const errors=(typeof syncState!=='undefined'&&syncState.errors)||{},sources=nasSyncSources(),now=Date.now();
    for(const source of Object.keys(errors)){
      const read=sources[source];if(typeof read!=='function')continue;
      if(!resume.due(nasSyncRetry,source,now))continue;
      let pending;
      try{pending=read();}catch(_){resume.recordFailure(nasSyncRetry,source,now);continue;}
      Promise.resolve(pending).then(()=>{resume.recordSuccess(nasSyncRetry,source);},
        ()=>{resume.recordFailure(nasSyncRetry,source,Date.now());});
    }
    // Долгая тишина в подписке: поднимаем её и проверяем связь принудительно.
    if(now-nasLastSessionAt>20000&&!nasWakeInFlight){nasLastSessionAt=now;nasResumePolling?.();void nasNetworkWake(epoch,client,{force:true});}
  }
  // Мост параллельных смен v2: сервер v2 ↔ store контекстов (задача 13).
  // Каждый ответ несёт generation-токен, поэтому поздний ответ не публикуется и
  // не меняет выбранную смену. Мост работает только при включённом флаге
  // WORKING_TEST_V2_SHIFTS (в канале он ВЫКЛЮЧЕН по умолчанию в shell.html:
  // решение владельца 28.11.2026 — логика линии как в рабочей 1.7.23);
  // без флага v1-рантайм работает как раньше.
  function nasV2ShiftsEnabled(){
    return typeof WORKING_TEST_V2_SHIFTS!=='undefined'&&WORKING_TEST_V2_SHIFTS===true;
  }
  function nasV2Shifts(){return nasV2Bridge;}
  function nasStopV2Shifts(){
    try{nasV2Bridge?.handle?.close?.();}catch(_){}
    nasV2Bridge=null;nasV2BridgeErrorLogged=false;
    nasRestoredV1=[];nasRestoredContexts=[];nasRestoredRead=null;nasRestoredReadAt=0;
  }

  // === Восстановленные архивные смены (v2, design §5.6, §10.1) ===
  // Старый сервер отдаёт restored-смены в v1-снапшоте (`shifts` +
  // `payload.restored`). На канонической схеме их место — restored_shift_contexts:
  // клиент читает их через GET /api/v2/archives/{id}/restored и правит через
  // POST /api/v2/archives/{id}/operations. Карточка и рейсы выглядят как в
  // 1.8.3, но в active-таблицы (shifts, line_logs, line_truck_statuses) этот
  // путь не пишет ничего.
  let nasRestoredV1 = [];          // restored-смены из v1-снапшота (старый сервер)
  let nasRestoredContexts = [];    // [{card}] открытые v2-контексты
  let nasRestoredRead = null;
  let nasRestoredReadAt = 0;

  function nasRestoredArchiveApi(){
    return typeof WorkingTestArchiveRestoredV2!=='undefined'?WorkingTestArchiveRestoredV2:null;
  }
  function nasRestoredArchiveTransport(){
    const transport=nasV2Shifts()?.transport;
    if(!transport||typeof transport.readRestoredArchive!=='function'||typeof transport.submitArchiveV2!=='function')return null;
    return transport;
  }
  // v2-путь восстановления доступен только при живом мосте. Без него остаётся
  // прежний честный отказ, а не «похожий» локальный контекст (урок 63).
  function nasRestoredV2Ready(){return !!(nasRestoredArchiveApi()&&nasRestoredArchiveTransport());}

  function nasRestoredCards(){
    return nasRestoredContexts.map(entry=>{
      const card=entry.card;
      // Опубликованный (finalized) контекст неприкосновенен: карточка остаётся,
      // но правки и возврат в архив недоступны.
      const readOnly=card.context.contextState!=='open';
      const logs=(card.logs||[]).map(log=>log.restoredReadOnly===readOnly?log:{...log,restoredReadOnly:readOnly});
      return {...card,readOnly,logs};
    });
  }
  function nasRestoredShiftsCombined(){
    const v2=nasRestoredCards();
    const ids=new Set(v2.map(card=>card.shift.id));
    return [...nasRestoredV1.filter(row=>row?.shift&&!ids.has(row.shift.id)),...v2];
  }
  function nasRestoredContextForShift(shiftId){
    return nasRestoredContexts.find(entry=>entry.card.shift.id===shiftId)||null;
  }
  function nasRestoredContextForLog(logId){
    if(!logId)return null;
    for(const entry of nasRestoredContexts){
      const log=(entry.card.logs||[]).find(row=>row.id===logId);
      if(log)return {context:entry,log};
    }
    return null;
  }
  // Единая публикация восстановленных смен: карточка в отчёте и рейсы в журнале.
  // Рейсы кладутся в offlineRemoteLogs, иначе offlineProjectState затрёт их
  // своим срезом (как и для v1-снапшота).
  function nasApplyRestoredShifts(){
    state.restoredShifts=nasRestoredShiftsCombined();
    const restoredIds=new Set(state.restoredShifts.map(row=>row?.shift?.id).filter(Boolean));
    const baseLogs=(Array.isArray(offlineRemoteLogs)?offlineRemoteLogs:[]).filter(log=>!restoredIds.has(log.shiftId));
    offlineRemoteLogs=[...baseLogs,...state.restoredShifts.flatMap(row=>row.logs||[])];
    offlineProjectState();saveCache();renderAll();
  }
  // Карточки переживают перезагрузку: они лежат в кэше сессии (saveCache), а
  // сервер перечитывается, как только мост готов.
  function nasSeedRestoredContexts(){
    // Без живого v2-моста кэш не поднимаем: карточка без маршрута правок
    // выглядела бы рабочей, а любая правка упиралась бы в отказ (урок 69).
    if(!nasRestoredV2Ready())return;
    const cached=(state.restoredShifts||[]).filter(row=>row&&row.context&&row.shift&&row.shift.restoredContextId);
    if(!cached.length)return;
    const known=new Set(nasRestoredContexts.map(entry=>entry.card.shift.id));
    for(const card of cached){
      if(known.has(card.shift.id))continue;
      nasRestoredContexts.push({card:{...card,readOnly:card.context.contextState!=='open'}});
      known.add(card.shift.id);
    }
  }

  // GET /api/v2/archives/{id}/restored идемпотентен: повторное открытие
  // возвращает уже открытый контекст с его собственной базовой ревизией.
  // Большие архивы листаются курсором, чтобы карточка не потеряла рейсы.
  async function nasReadRestoredContext(archiveId){
    const api=nasRestoredArchiveApi(),transport=nasRestoredArchiveTransport();
    if(!api||!transport)return {ok:false,error:{code:'v2-unavailable',status:0}};
    const pages=[];let cursor=null;
    for(let page=0;page<20;page++){
      const response=await transport.readRestoredArchive({archiveId,limit:200,...(cursor?{cursor}:{})});
      if(!response||response.ok!==true)return {ok:false,error:response?.error||{code:'invalid-api-response',status:0}};
      const normalized=api.normalizeContext(response.data);
      if(!normalized.ok)return {ok:false,error:{code:'invalid-api-response',status:0}};
      pages.push(normalized.view);
      const next=normalized.view.tripsPage?.nextCursor;
      if(normalized.view.tripsPage?.hasMore!==true||!next)break;
      cursor=next;
    }
    if(!pages.length)return {ok:false,error:{code:'invalid-api-response',status:0}};
    const merged=pages.length===1?pages[0]:{...pages[0],trips:pages.flatMap(view=>view.trips),
      tripsPage:{...pages[0].tripsPage,hasMore:false,nextCursor:null}};
    const card=api.cardOf(merged);
    const index=nasRestoredContexts.findIndex(entry=>entry.card.shift.id===card.shift.id);
    const entry={card};
    if(index>=0)nasRestoredContexts[index]=entry;else nasRestoredContexts.push(entry);
    return {ok:true,context:entry,card};
  }
  // Фоновое перечитывание открытых контекстов: ошибка не стирает карточку, а
  // правка сама перечитает контекст при CAS-конфликте.
  async function nasRefreshRestoredContexts(options){
    const force=options?.force===true;
    if(!nasRestoredV2Ready()||!nasRestoredContexts.length)return {ok:false,count:0};
    const now=Date.now();
    if(!force&&now-nasRestoredReadAt<30000)return {ok:true,count:nasRestoredContexts.length};
    if(nasRestoredRead)return nasRestoredRead;
    nasRestoredReadAt=now;
    const work=(async()=>{
      let ok=0;
      for(const entry of nasRestoredContexts.slice()){
        const result=await nasReadRestoredContext(entry.card.context.archiveId);
        if(result.ok)ok+=1;
      }
      if(ok)nasApplyRestoredShifts();
      return {ok:ok>0,count:ok};
    })();
    nasRestoredRead=work;
    try{return await work;}finally{if(nasRestoredRead===work)nasRestoredRead=null;}
  }
  function nasRestoredOperationId(){
    if(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function')return 'restored_'+crypto.randomUUID().replaceAll('-','');
    return 'restored_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,12);
  }
  function nasRestoredFieldText(code){
    if(code==='invalid-volume')return 'Проверьте объём: от 0 до 1000 м³';
    if(code==='invalid-time')return 'Проверьте время: формат ЧЧ:ММ';
    if(code==='invalid-ttn')return 'Проверьте отметку ТТН';
    if(code==='invalid-comment')return 'Комментарий слишком длинный';
    return 'Проверьте поля правки восстановленной смены';
  }
  // Правка рейса/ТТН архивной смены. CAS берётся из фактически прочитанного
  // контекста; operationId фиксируется ДО первого запроса, поэтому повтор после
  // конфликта не создаёт вторую операцию на сервере.
  async function nasRestoredCorrect(entry,command){
    const api=nasRestoredArchiveApi(),transport=nasRestoredArchiveTransport();
    if(!api||!transport)throw Error('Сервер не поддерживает правку восстановленной смены: обновите приложение.');
    if(entry.card.context.contextState!=='open')throw Error(api.FINALIZED_NOTICE);
    const operationId=nasRestoredOperationId();
    const build=()=>api.commandFor(entry.card,{...command,operationId});
    let prepared=build();
    if(!prepared.ok)throw Error(nasRestoredFieldText(prepared.code));
    let response=await transport.submitArchiveV2(prepared.input);
    if(response?.ok!==true&&response?.error?.code==='archive-changed'){
      const fresh=await nasReadRestoredContext(entry.card.context.archiveId);
      if(fresh.ok){
        entry=fresh.context;
        prepared=build();
        if(prepared.ok)response=await transport.submitArchiveV2(prepared.input);
      }
    }
    if(response?.ok!==true){
      const code=response?.error?.code,status=response?.error?.status;
      const error=Error(api.correctionText(code,status));
      error.serverCode=code;error.status=status;throw error;
    }
    // Конверт команды (`41-v2-transport.js` → `command`) плоский:
    // `{ok,operationId,replayed,retried,result}`. Чтение `response.data.result`
    // давало undefined, и правка молча «применялась» к пустому объекту: HTTP 200,
    // ноль изменений на экране (нашёл стенд 393×852). Отсутствие результата —
    // ошибка, а не повод сделать вид, что всё сохранилось.
    const result=response.result;
    if(!result||typeof result!=='object'||Array.isArray(result)){
      const error=Error(api.correctionText('invalid-api-response',0));
      error.serverCode='invalid-api-response';
      throw error;
    }
    entry.card=api.applyResult(entry.card,result);
    nasApplyRestoredShifts();
    return result;
  }
  async function nasRestoredTripUpdate(found,data){
    const fields=data||{};
    return nasRestoredCorrect(found.context,{type:'trip.update',recordId:found.log.id,
      fields:{volume:Number(fields.volume),timeStr:String(fields.timeStr||''),
        comment:typeof fields.comment==='string'?fields.comment:''}});
  }
  async function nasRestoredTripDelete(found){
    return nasRestoredCorrect(found.context,{type:'trip.delete',recordId:found.log.id});
  }
  async function nasRestoredTtnChange(shiftId,truckId,status){
    const entry=nasRestoredContextForShift(shiftId);
    if(!entry)throw Error('Восстановленная смена не найдена: обновите страницу.');
    return nasRestoredCorrect(entry,status===null
      ?{type:'ttn.delete',recordId:truckId}
      :{type:'ttn.update',recordId:truckId,fields:{ttnStatus:status}});
  }
  // Кнопка в карточке восстановленной смены: отметка ТТН архивного рейса.
  async function markRestoredTtn(shiftId,truckId,status){
    try{await nasRestoredTtnChange(shiftId,truckId,status);showToastEl(status===null?'↩️ Отметка ТТН снята':'📄 ТТН отмечена',false);}
    catch(error){showError(error.message);}
  }
  // Восстановление архивной смены через v2. Возвращает карточку и ничего не
  // пишет в active-таблицы: контекст правок — отдельное хранилище.
  async function nasRestoreArchivedShift(archiveId){
    const api=nasRestoredArchiveApi();
    const result=await nasReadRestoredContext(archiveId);
    if(!result.ok){
      const code=result.error?.code,status=result.error?.status;
      const error=Error(api?api.refusalFor(code,status).text:'Не удалось восстановить архивную смену');
      error.serverCode=code;error.status=status;throw error;
    }
    nasApplyRestoredShifts();
    return result;
  }
  function nasRestoredRefusalText(code,status){
    const api=nasRestoredArchiveApi();
    return api?api.refusalFor(code,status).text:null;
  }
  // Текст для «Вернуть в архив»: null значит «это не v2-контекст», и работает
  // прежний путь закрытия восстановленной смены (старый сервер).
  function nasRestoredFinalizeText(shiftId){
    const api=nasRestoredArchiveApi();
    const entry=nasRestoredContextForShift(shiftId);
    if(!entry)return null;
    return api?api.finalizeText(entry.card):null;
  }
  // Флаг включён в канале по умолчанию (shell.html), поэтому мост поднимается
  // и там, где сервер v2 ещё не отвечает (старый сервер, нет маршрутов, связь
  // пропала). Сбой дополнительной подсистемы не должен красить общий индикатор
  // «Ошибка загрузки: nas-shifts»: пока мост ни разу не отдал данные, экран
  // живёт на v1 и работает как раньше, а причина остаётся в консоли.
  function nasV2BridgeError(store,error){
    let rows=null;
    try{rows=store?.visibleShifts?.();}catch(_){rows=null;}
    if(!Array.isArray(rows)||rows.length===0){
      if(!nasV2BridgeErrorLogged){nasV2BridgeErrorLogged=true;console.warn('[sync:nas-shifts]',error);}
      return;
    }
    reportSyncError('nas-shifts',error);
  }
  // Успешный ответ моста снимает накопленную ошибку: иначе один сбой связи
  // оставлял «Перечитываем: nas-shifts» навсегда, потому что v1-источники
  // снимают только свои записи в syncState.errors.
  function nasV2BridgeSynced(store){
    nasV2BridgeErrorLogged=false;
    try{
      if(typeof syncState==='undefined'||!syncState||!syncState.errors||!syncState.errors['nas-shifts'])return;
      if(typeof markSync!=='function')return;
      const rows=store?.visibleShifts?.();
      markSync('nas-shifts',false,false,Array.isArray(rows)?rows.length:0);
    }catch(_){}
  }
  function nasStartV2Shifts(epoch,client){
    nasStopV2Shifts();
    if(!nasV2ShiftsEnabled())return null;
    if(typeof WorkingTestV2Transport==='undefined'||typeof WorkingTestShiftContexts==='undefined')return null;
    if(typeof client?.requestV2!=='function')return null;
    let storage=null;try{storage=localStorage;}catch(_){}
    const store=WorkingTestShiftContexts.createShiftContextStore({uid:client.uid,workspaceId:client.workspaceId,storage});
    const transport=WorkingTestV2Transport.createV2Transport({
      request:(path,options)=>client.requestV2({method:options?.method,path,body:options?.operation,validate:options?.validate}),
      uid:client.uid,workspaceId:client.workspaceId,store
    });
    const live=()=>epoch===nasRuntimeEpoch&&client===nasRuntimeClient;
    const handle=transport.subscribeShifts({
      intervalMs:4000,
      onList:list=>{if(!live())return;
        nasV2BridgeSynced(store);
        try{window.dispatchEvent(new CustomEvent('samosval-working-test-shifts',{detail:{generation:list.listGeneration,items:list.items,nextCursor:list.nextCursor}}));}catch(_){}
      },
      onSnapshot:result=>{if(!live())return;
        nasV2BridgeSynced(store);
        try{window.dispatchEvent(new CustomEvent('samosval-working-test-shift-snapshot',{detail:{generation:result.generation,shiftId:result.shiftId,revision:result.revision,applied:result.applied,visible:result.visible}}));}catch(_){}
      },
      onError:error=>{if(!live())return;nasV2BridgeError(store,error);}
    });
    nasV2Bridge={store,transport,handle,epoch};
    return nasV2Bridge;
  }
  async function startNasRuntime(user) {
    const epoch=nasRuntimeEpoch;
    // Nothing is server-confirmed until the first NAS session arrives.
    profileServerConfirmed=false;permissionsServerConfirmed=false;
    try{
      const {createNasClient}=await loadNasSessionClient();
      if(epoch!==nasRuntimeEpoch||wtAuthUser()!==user||currentUid!==user.uid)return;
      const client=createNasClient({baseUrl: nasApiBase(), getUser:()=>wtAuthUser(),workspaceId:WORKSPACE_ID,timeoutMs:15000});nasRuntimeClient=client;
      nasStartConnection(client,epoch);
      nasStartV2Shifts(epoch,client);
      // Карточки восстановленных смен переживают перезагрузку: они лежат в
      // кэше сессии, а сервер перечитывается, как только мост готов.
      nasSeedRestoredContexts();
      // Pulse: proves this phone is alive and tells the servers how many phones
      // still see the primary. Failover needs many phones, not one.
      const pulse=()=>{if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||!navigator.onLine)return;if(typeof client.writeAuthorityPresence!=='function')return;try{client.writeAuthorityPresence({}).catch(()=>{});}catch(_){}};
      if(nasPresenceTimer&&typeof clearInterval==='function')clearInterval(nasPresenceTimer);
      nasPresenceTimer=typeof setInterval==='function'?setInterval(pulse,30000):null;pulse();
      for(const name of ['plugins','patches','audit','notifications'])refs[name]=nasAuxCollection(name,client,epoch);
      let registering=false;
      nasResumePolling=()=>{if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||nasPollHolds)return;nasRuntimeStop?.();nasRuntimeStop=client.subscribeLine({
        onSession:session=>{if(epoch!==nasRuntimeEpoch)return;
          // Отмечаем живой ответ сервера: по этой метке надзиратель понимает,
          // что подписка молчит слишком долго.
          nasLastSessionAt=Date.now();
          // Любой успешный ответ сервера доказывает, что связь есть: снимаем
          // «Работа локально» и накопленный бэкофф повтора очереди.
          offlineTransportRecovered();applyNasSession(session);
          if(session.profile?.status==='active'&&!session.profile.deleted)void refreshNasSettings().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-settings',error);});
          if(session.profile?.status==='active'&&!session.profile.deleted)void refreshNasGames().catch(error=>{if(epoch===nasRuntimeEpoch)nasGameReadError(error);});
          if(session.profile?.status==='active'&&!session.profile.deleted)void refreshNasAuxiliary().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-auxiliary',error);});
          if(session.profile?.status==='active'&&(hasTabAccess('archive')||hasTabAccess('analytics')))void refreshNasArchive().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-archive',error);});
          if(session.identityReady&&!session.profile&&!registering){registering=true;void ensureNasPendingAccount(user).catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-registration',error);}).finally(()=>{registering=false;});}
          if(session.profile?.status==='active'&&(session.permissions.tabs.includes('line')||session.permissions.tabs.includes('trucks')||session.permissions.tabs.includes('timesheet')))void refreshNasObjects().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-objects',error);});
          if(canAdmin())void refreshNasAdministration().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-admin',error);});},
        onSnapshot:snapshot=>{if(epoch!==nasRuntimeEpoch)return;acceptNasLineSnapshot(snapshot);void replayNasOfflineJournal().catch(()=>{});},
        onError:error=>{if(epoch!==nasRuntimeEpoch)return;
          // Пока открыты две смены, legacy-чтение линии отвечает 409
          // `multiple-active-shifts`: линия одна по контракту v1, и выбрать
          // владельца сервер не имеет права. Линию в этом режиме ведёт v2-мост,
          // поэтому постоянная плашка «Перечитываем: nas» была бы ложью о сбое.
          // Без моста (старый клиент) отказ остаётся видимым: там он настоящий.
          if(nasV2Shifts()&&(error?.serverCode||error?.code)==='multiple-active-shifts')return;
          reportSyncError('nas',error);}
      });};nasResumePolling();
      // Отсчёт тишины подписки начинается сразу: иначе до первого сеанса
      // надзиратель каждые 2,5 секунды заново перезапускал бы подписку.
      nasLastSessionAt=Date.now();
      // Открытые контексты восстановленных смен перечитываются один раз при
      // старте: GET идемпотентен и отдаёт уже открытый контекст.
      if(nasRestoredContexts.length)void nasRefreshRestoredContexts({force:true}).catch(()=>{});
      // Надзиратель повторов: раз в 2,5 секунды проверяет, не застряла ли
      // подписка и не остались ли ошибки источников без повторного чтения.
      if(nasSyncTimer&&typeof clearInterval==='function')clearInterval(nasSyncTimer);
      nasSyncTimer=typeof setInterval==='function'?setInterval(nasSyncSupervisorTick,2500):null;
      // После смены сети браузер часто НЕ присылает 'online', а старые сокеты
      // висят до собственного таймаута. Любой возврат на экран — это полное
      // обновление данных: видимость, фокус, сеть, pageshow, разблокировка.
      nasWakeStop?.();
      const wakeOnline=()=>{if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||!navigator.onLine)return;
        nasResumePolling?.();void nasActiveRefresh('online',{force:true});};
      const wakeVisible=()=>{if(typeof document!=='undefined'&&document.visibilityState==='hidden'){nasHiddenAt=Date.now();return;}
        nasDropHungReads();nasFastLinkCheck(epoch,client);void nasActiveRefresh('visibilitychange',{force:true});};
      const wakeFocus=()=>{nasDropHungReads();void nasActiveRefresh('focus',{force:true});};
      // Возврат из кэша браузера (bfcache): страница «оживает» без перезагрузки.
      const wakePageShow=event=>{const persisted=!!(event&&event.persisted);if(!persisted&&!nasHiddenAt)return;
        nasDropHungReads();nasFastLinkCheck(epoch,client);void nasActiveRefresh('pageshow',{force:true});};
      // Разблокировка экрана телефона и выход из фона в мобильной оболочке.
      // Page Lifecycle API отправляет freeze/resume на document, а НЕ на window:
      // без document-слушателя разблокировка экрана в PWA не будила приложение,
      // и данные после пробуждения не обновлялись.
      const wakeResume=()=>{nasDropHungReads();nasFastLinkCheck(epoch,client);void nasActiveRefresh('resume',{force:true});};
      const wakeFreeze=()=>{nasHiddenAt=Date.now();};
      if(typeof window!=='undefined'&&typeof window.addEventListener==='function'){
        window.addEventListener('online',wakeOnline);window.addEventListener('focus',wakeFocus);
        window.addEventListener('pageshow',wakePageShow);window.addEventListener('resume',wakeResume);
        if(typeof document!=='undefined'&&typeof document.addEventListener==='function'){
          document.addEventListener('visibilitychange',wakeVisible);
          document.addEventListener('resume',wakeResume);
          document.addEventListener('freeze',wakeFreeze);
        }
        nasWakeStop=()=>{window.removeEventListener('online',wakeOnline);window.removeEventListener('focus',wakeFocus);
          window.removeEventListener('pageshow',wakePageShow);window.removeEventListener('resume',wakeResume);
          if(typeof document!=='undefined'&&typeof document.removeEventListener==='function'){
            document.removeEventListener('visibilitychange',wakeVisible);
            document.removeEventListener('resume',wakeResume);
            document.removeEventListener('freeze',wakeFreeze);
          }nasWakeStop=null;};
      }
      // Пока приложение активно на экране — обновляем всё каждые 15 секунд.
      if(nasActivityTimer&&typeof clearInterval==='function')clearInterval(nasActivityTimer);
      // Страховка: в фоне/на заблокированном экране таймеры замирают, а события
      // пробуждения могут не прийти. Разрыв между тиками больше двух интервалов
      // (30 с) означает, что приложение спало — обновляем всё принудительно.
      let nasActivityTickAt=Date.now();
      nasActivityTimer=typeof setInterval==='function'?setInterval(()=>{const now=Date.now(),gap=now-nasActivityTickAt;nasActivityTickAt=now;if(!nasScreenActive())return;void nasActiveRefresh(gap>45000?'resume':'poll',{force:gap>45000});},15000):null;
      // Если игровая книга не загрузилась при входе (сбой сети), без повтора
      // кнопки игр оставались вечно неактивными. Пробуем снова каждые 30 секунд.
      if(nasGamesTimer&&typeof clearInterval==='function')clearInterval(nasGamesTimer);
      nasGamesTimer=typeof setInterval==='function'?setInterval(()=>{if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||currentUserStatus!=='active'||nasGameReady)return;void refreshNasGames().catch(error=>{if(epoch===nasRuntimeEpoch)nasGameReadError(error);});},30000):null;
    }catch(error){if(epoch===nasRuntimeEpoch)reportSyncError('nas',error);}
  }
  function loadNasTabelRemote(){return import(new URL('./working-test/synology/tabel-remote.mjs',document.baseURI).href);}
  async function refreshNasAuxiliary(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=nasReadGeneration;if(!client||currentUserStatus!=='active')return;
    if(nasAuxRead)return nasAuxRead;
    const work=(async()=>{const snapshot=await client.readAuxiliary();if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||currentUserStatus!=='active'||generation!==nasReadGeneration)return;
      const pluginsChanged=JSON.stringify(state.plugins)!==JSON.stringify(snapshot.plugins),patchesChanged=JSON.stringify(state.patches)!==JSON.stringify(snapshot.patches);
      markSync('nas-auxiliary',false,false,1);nasAuxSnapshot=snapshot;state.plugins=snapshot.plugins;state.patches=snapshot.patches;state.audit=snapshot.audit.slice(0,200);state.lineAudit=snapshot.audit;
      state.notifications=snapshot.notifications;offlineProjectTicker();refreshNasLineNotificationDisplay();
      for(const key of ['plugins','patches','audit','notifications'])markSync(key,false,false,snapshot[key].length);
      if(pluginsChanged)initPlugins();if(patchesChanged){state.patches.sort((a,b)=>(a.order||0)-(b.order||0));if(!window.__nasPatchesApplied){window.__nasPatchesApplied=true;applyAllPatches();}}
      saveCache();renderStatusTicker();renderHeaderStats();if(canAdmin()){renderPluginsList();renderPatchesList();}
    })();nasAuxRead=work;try{return await work;}finally{if(nasAuxRead===work)nasAuxRead=null;}
  }
  function nasAuxCollection(name,client,epoch,filters=[],ordering=null,maximum=null){
    const guard=()=>{if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch||currentUid!==client.uid||currentUserStatus!=='active')throw Error('Сеанс Ubuntu изменился');};
    const document=id=>({id,ref:null,exists:true,data:()=>{const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id);if(!row)return undefined;const {id:_,revision,...data}=row;return data;}});
    const wrap=row=>{const snap=document(row.id);snap.ref=collection.doc(row.id);return snap;};
    const collection={
      doc:(id='record_'+crypto.randomUUID().replaceAll('-',''))=>({id,path:'workspaces/'+WORKSPACE_ID+'/'+name+'/'+id,
        get:async()=>{guard();await refreshNasAuxiliary();guard();const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id);return {id,exists:!!row,data:()=>{if(!row)return undefined;const {id:_,revision,...data}=row;return data;}};},
        set:async(data,options)=>{guard();if(!nasAuxSnapshot)await refreshNasAuxiliary();guard();const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id),{id:_,revision,...before}=row||{};
          await nasBusinessCommand('auxiliary',name+':'+id,{type:'auxiliary.save',collection:name,recordId:id,expectedRevision:row?.revision||0,data:options?.merge?{...before,...data}:data});guard();await refreshNasAuxiliary();},
        update:async data=>{guard();if(!nasAuxSnapshot)await refreshNasAuxiliary();guard();const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id);if(!row)throw Error('Запись уже отсутствует');return collection.doc(id).set(data,{merge:true});},
        delete:async()=>{guard();if(!nasAuxSnapshot)await refreshNasAuxiliary();guard();const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id);if(!row)return;await nasBusinessCommand('auxiliary',name+':'+id,{type:'auxiliary.delete',collection:name,recordId:id,expectedRevision:row.revision});guard();await refreshNasAuxiliary();}}),
      add:async data=>{const ref=collection.doc();await ref.set(data);return ref;},
      where:(field,operator,value)=>nasAuxCollection(name,client,epoch,[...filters,[field,operator,value]],ordering,maximum),
      orderBy:(field,direction='asc')=>nasAuxCollection(name,client,epoch,filters,[field,direction],maximum),
      limit:n=>nasAuxCollection(name,client,epoch,filters,ordering,n),
      get:async()=>{guard();await refreshNasAuxiliary();guard();let rows=(nasAuxSnapshot?.[name]||[]).filter(row=>filters.every(([k,op,v])=>{if(op==='==')return row[k]===v;if(op==='>=')return row[k]>=v;if(op==='<')return row[k]<v;throw Error('Неподдерживаемый фильтр');}));
        if(ordering){const [k,d]=ordering;rows=rows.slice().sort((a,b)=>(a[k]>b[k]?1:a[k]<b[k]?-1:0)*(d==='desc'?-1:1));}if(maximum!==null)rows=rows.slice(0,maximum);const docs=rows.map(wrap);return {docs,size:docs.length,empty:!docs.length,forEach:fn=>docs.forEach(fn),metadata:{fromCache:false,hasPendingWrites:false}};}
    };return collection;
  }
  async function nasBackupRead(id){if(!canAdmin()||!nasRuntimeClient)throw Error('Требуется администратор Ubuntu');return nasRuntimeClient.readBackups(id);}
  async function nasBackupCommand(target,fields){return nasBusinessCommand('backup',target,fields);}
  async function nasReportAction(type,log,data){
    // Рейс восстановленной архивной смены живёт в restored_context_logs, а не в
    // line_logs активной линии: v1-команда report.* его не найдёт, а при
    // совпадении id адресовала бы чужую смену. Правка и удаление идут
    // v2-маршрутом архивного контекста с CAS из прочитанного контекста.
    const restored=nasRestoredContextForLog(log?.id);
    if(restored){
      if(type==='report.update')return nasRestoredTripUpdate(restored,data);
      if(type==='report.delete')return nasRestoredTripDelete(restored);
      throw Error('Для восстановленной архивной смены доступны правка и удаление рейса');
    }
    const expected={volume:log.volume,timestamp:log.timestamp,timeStr:log.timeStr,comment:log.comment||'',truckId:log.truckId,shiftId:log.shiftId};
    const result=await nasBusinessCommand('report',log.id,{type,logId:log.id,expected,...(data?{data}:{})});
    await nasRefreshLine();await Promise.allSettled([refreshNasGames(),refreshNasAuxiliary()]);return result;
  }
  async function nasHistoryAction(action,direction){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;if(!client)throw Error('Сеанс Ubuntu не загружен');
    const key='samosval_working_test_nas_history_v1:'+client.scope+':'+action.id+':'+direction;
    let op=JSON.parse(localStorage.getItem(key)||'null');if(!op){op={id:'history_'+crypto.randomUUID().replaceAll('-',''),actionId:action.id,direction,expectedRevision:action.revision};localStorage.setItem(key,JSON.stringify(op));}
    let result;try{result=await client.submitHistory(op,{operationScope:client.scope});}catch(error){if([400,409].includes(error.status)&&epoch===nasRuntimeEpoch)localStorage.removeItem(key);throw error;}if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Учётная запись изменилась');
    localStorage.removeItem(key);await nasRefreshLine();await Promise.allSettled([refreshNasGames(),refreshNasAuxiliary()]);return result;
  }
  window.addEventListener('load',()=>{
    if(!isNasRuntime())return;
    const oldUndo=window.undoLastAction;
    window.undoLastAction=async()=>{
      if(offlineLocalTicker())return undoLastOfflineAction();
      try{const snapshot=await nasRuntimeClient.readHistory(),last=lastValidNotification();const action=snapshot.items.find(x=>x.id===last?.actionId);if(!action?.canUndo)throw Error('Откройте журнал: это действие уже изменено или недоступно для отмены');if(await appConfirm('Отменить действие?'))await nasHistoryAction(action,'undo');}catch(error){showError(error.message);}
    };
  });
  function acceptNasSettings(snapshot){
    markSync('nas-settings',false,false,1);nasSettingsSnapshot=snapshot;appConfig={...snapshot.data};
    settings.cycleMinutes=snapshot.data.cycleMinutes;renderAppSettingsIfActive();window.__gameConfigChanged?.();
    window.dispatchEvent(new Event('review-flags-changed'));
  }
  async function refreshNasSettings(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=nasReadGeneration;if(!client||currentUserStatus!=='active')return;
    if(nasSettingsRead)return nasSettingsRead;
    const work=(async()=>{const snapshot=await client.readSettings();if(epoch===nasRuntimeEpoch&&client===nasRuntimeClient&&currentUserStatus==='active'&&generation===nasReadGeneration&&(!nasSettingsSnapshot||snapshot.revision>=nasSettingsSnapshot.revision))acceptNasSettings(snapshot);})();
    nasSettingsRead=work;try{return await work;}finally{if(nasSettingsRead===work)nasSettingsRead=null;}
  }
  async function nasSaveSettings(patch,values){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;if(!canAdmin())throw Error('Требуется администратор');
    if(!nasSettingsSnapshot)await refreshNasSettings();
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||!nasSettingsSnapshot)throw Error('Обновите настройки Ubuntu');
    const result=await nasBusinessCommand('settings','config',{type:values?'settings.rewards':'settings.patch',expectedRevision:nasSettingsSnapshot.revision,...(values?{values}:{patch})});
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||!canAdmin())throw Error('Сеанс администратора изменился');
    acceptNasSettings({revision:result.result.revision,data:result.result.data});return result.result.data;
  }
  async function refreshNasArchive(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=nasReadGeneration;if(!client||currentUserStatus!=='active')return;
    if(nasArchiveRead)return nasArchiveRead;
    const work=(async()=>{const snapshot=await client.readArchive();if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||currentUserStatus!=='active'||generation!==nasReadGeneration||!hasTabAccess('archive')&&!hasTabAccess('analytics'))return;
      markSync('nas-archive',false,false,snapshot.archives.length);state.archive=snapshot.archives;state.trash=snapshot.trash;markSync('archive',false,false,state.archive.length);markSync('trash',false,false,state.trash.length);saveCache();renderAll();})();
    nasArchiveRead=work;try{return await work;}finally{if(nasArchiveRead===work)nasArchiveRead=null;}
  }
  async function nasArchiveAction(type,id){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    const row=(type==='trash.purge'?state.trash:state.archive).find(x=>x.id===id);if(!row)throw Error('Обновите архив');
    const result=await nasBusinessCommand('archive',id,{type,recordId:id,expectedRevision:row.revision});
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Учётная запись изменилась');
    await refreshNasArchive();if(type==='archive.restore')await nasRefreshLine();return result;
  }
  async function refreshNasGames(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=nasReadGeneration;if(!client||currentUserStatus!=='active')return;
    if(nasGameRead)return nasGameRead;
    const work=(async()=>{const snapshot=await client.readGames();if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||currentUserStatus!=='active'||generation!==nasReadGeneration)return;
      if(snapshot.head.gameRound<nasGameReceiptFloor)return;
      markSync('nas-games',false,false,snapshot.records.length);nasGameSnapshot=snapshot;nasGameReady=true;window.__gameAccessChanged?.();window.RoadArcade?.sync();})();
    nasGameRead=work;try{return await work;}finally{if(nasGameRead===work)nasGameRead=null;}
  }
  function nasGameReadError(error){
    if([401,403].includes(error.status)){nasGameReady=false;nasGameSnapshot=null;nasGameReceiptFloor=0;}
    // A failed background read cannot revoke a previously confirmed wallet.
    // Every play still needs an authenticated server transaction and receipt.
    // Кошелёк уже подтверждён → этот сбой чисто фоновый: жёлтый баннер
    // «Ошибка загрузки» не поднимается (getSyncStatus показывает такое как
    // degraded), ошибка остаётся на точке синхронизации и в диагностике.
    window.__gameAccessChanged?.();window.RoadArcade?.sync();reportSyncError('nas-games',error);
  }
  function acceptNasGameReceipt(result){
    const h=result?.confirmedHead;
    if(!nasGameSnapshot||!h||!Number.isSafeInteger(h.gameRound)||h.gameRound<1||!Number.isSafeInteger(h.bank)||h.bank<0||h.userUid!==currentUid||h.player?.uid!==currentUid||typeof h.id!=='string')return false;
    nasGameReceiptFloor=Math.max(nasGameReceiptFloor,h.gameRound);
    const records=nasGameSnapshot.records.filter(r=>r.id!==h.id).concat(h);
    const newer=h.gameRound>=nasGameSnapshot.head.gameRound;
    nasGameSnapshot={...nasGameSnapshot,records,...(newer?{head:h}:{}),players:{...nasGameSnapshot.players,...(h.gameRound>=(nasGameSnapshot.players[currentUid]?._round||0)?{[currentUid]:{...h.player,_round:h.gameRound}}:{})}};
    nasGameReady=true;window.__gameAccessChanged?.();window.RoadArcade?.sync();return true;
  }
  async function nasGameAction(action){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    // Roll фиксируется на клиенте до анимации остановки, и сервер обязан
    // засчитать именно его: иначе барабаны останавливаются на одной
    // комбинации, а серверная выплата считается по другой — подмена.
    const {id,...gameAction}=action;
    const target=gameAction.kind==='slot'||gameAction.kind==='dino'?(gameAction.kind+':'+id):gameAction.kind==='purchase'?'theme:'+gameAction.itemId:gameAction.kind+':'+gameAction.level+':'+(gameAction.coin??'');
    const receipt=await nasBusinessCommand('game',target,{type:'game.play',action:gameAction});
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Учётная запись изменилась');
    if(gameAction.kind!=='purchase'&&acceptNasGameReceipt(receipt.result)){
      void refreshNasGames().catch(error=>{if(epoch===nasRuntimeEpoch&&client===nasRuntimeClient)nasGameReadError(error);});
      return receipt.result;
    }
    await refreshNasGames();return receipt.result;
  }
  async function nasGrantCoins(targetUid,amount,reason){
    const receipt=await nasBusinessCommand('game','grant:'+targetUid,{type:'game.grant',targetUid,amount,reason});
    await refreshNasGames();return receipt.result;
  }
  async function refreshNasObjects(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;if(!client||currentUserStatus!=='active')return;
    if(nasCatalogRead)return nasCatalogRead;
    const work=(async()=>{const catalog=await client.readCatalog();if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||currentUserStatus!=='active'||!hasTabAccess('line')&&!hasTabAccess('trucks')&&!hasTabAccess('timesheet'))return;
      markSync('nas-objects',false,false,catalog.objects.length);nasCatalogSnapshot=catalog;state.trucks=catalog.trucks.map(row=>({...row.data,id:row.id,revision:row.revision}));state.objects=catalog.objects.map(row=>({...row.data,id:row.id,revision:row.revision}));if(state.shift?.objectId)state.shift.objectName=objectTitle(state.shift.objectId,state.shift.objectName);
      void refreshTruckPhones();
      markSync('objects',false,false,state.objects.length);saveCache();window.dispatchEvent(new Event('samosval-working-test-objects-changed'));
    })();nasCatalogRead=work;try{return await work;}finally{if(nasCatalogRead===work)nasCatalogRead=null;}
  }
  function nasTabelHost(){
    const client=nasRuntimeClient,user=wtAuthUser(),epoch=nasRuntimeEpoch;
    if(!client||!user)throw Error('Сеанс Ubuntu не загружен');
    const guard=()=>{if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||wtAuthUser()!==user||currentUid!==client.uid||currentUserStatus!=='active'||!permissionsLoaded||!hasTabAccess('timesheet'))throw Error('Доступ к табелю изменился');};
    const remoteFactory=async jobGuard=>{
      guard();const {createTabelRemote}=await loadNasTabelRemote();guard();
      return createTabelRemote({datasetEpoch:client.datasetEpoch,baseUrl:nasApiBase(),
        getIdToken:async force=>{guard();const token=await user.getIdToken(force);guard();return token;},
        guard:job=>{guard();jobGuard?.(job);}});
    };
    return {session:()=>({projectId:firebaseConfig.projectId,workspaceId:WORKSPACE_ID,uid:currentUid,name:getUserName(),role:currentUserRole,
      active:epoch===nasRuntimeEpoch&&client===nasRuntimeClient&&currentUserStatus==='active',view:epoch===nasRuntimeEpoch&&permissionsLoaded&&hasTabAccess('timesheet'),edit:hasPermission('timesheet_edit'),tabelTabs:tabelTabViews(),objectId:state.shift?.objectId,runtimeId:epoch,
      provider:nasProvider(),providerScope:client.scope}),remoteFactory,
      presenceRemote:{list:target=>{guard();return client.readPresence(target);},write:payload=>{guard();return client.writePresence(payload);},remove:payload=>client.removePresence(payload)},
      registerPresenceLeave:callback=>{nasPresenceLeavers.add(callback);return ()=>nasPresenceLeavers.delete(callback);},
      get shift(){return state.shift;},get objects(){return state.objects;},
      users:async()=>{guard();const result=await client.readMembers();guard();return result.members.map(m=>({...m,id:m.uid}));},
      readCatalog:async()=>{const remote=await remoteFactory();const row=await remote.read('_catalog/config');guard();const data=row.data||{};
        if(data.equipment!==undefined&&!Array.isArray(data.equipment)||data.people!==undefined&&!Array.isArray(data.people))throw Error('Не подтверждён формат справочника табеля');
        return {equipment:data.equipment||[],people:data.people||[]};},
      snapshot:()=>({shift:state.shift,trucks:state.trucks,statuses:state.truckStatus,logs:state.logs,audit:state.audit,lineAudit:state.lineAudit,archive:state.archive}),
      createObject:async(name,startDate)=>{guard();const result=await nasSaveRecord('object','',{name,...(startDate?{startDate}:{})},0);guard();return {...result.result.data,id:result.result.id};}
    };
  }
  async function leaveNasPresence(){
    let timer;try{await Promise.race([Promise.allSettled([...nasPresenceLeavers].map(fn=>Promise.resolve().then(fn))),new Promise(resolve=>{timer=setTimeout(resolve,1500);})]);}finally{clearTimeout(timer);}
  }
  async function ensureNasPendingAccount(user,getUser=()=>wtAuthUser()) {
    if(getUser()!==user)throw Error('Сеанс регистрации изменился');
    const {createNasClient}=await loadNasSessionClient();
    if(getUser()!==user)throw Error('Сеанс регистрации изменился');
    const client=createNasClient({baseUrl: nasApiBase(), getUser,workspaceId:WORKSPACE_ID,timeoutMs:15000});
    try{return await client.registerPending({nickname:sanitizeName(user.email||'')});}finally{client.stop();}
  }
  async function refreshNasAdministration() {
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||!canAdmin())throw Error('Требуется активный администратор Ubuntu');
    if(nasAdminRead)return nasAdminRead;
    const work=(async()=>{
      const snapshot=await client.readAdministration();
      if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||!canAdmin())throw Error('Сеанс администратора изменился');
      markSync('nas-admin',false,false,snapshot.users.length);nasAdministration=snapshot;state.users=snapshot.users.map(u=>({...u,id:u.uid}));state.requests=snapshot.requests.map(r=>({...r,id:r.uid}));
      permissionsConfig={...snapshot.permissions,admin:permissionsConfig.admin};
      requestSyncStatus.requests=true;requestSyncStatus.users=true;requestSyncStatus.errors={};renderAdminPanel();return snapshot;
    })();nasAdminRead=work;
    try{return await work;}finally{if(nasAdminRead===work)nasAdminRead=null;}
  }
  function nasIdentityJournalKey(){return 'samosval_working_test_nas_identity_v1:'+nasStorageScope();}
  async function nasAdminAction(type,payload) {
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||!canAdmin()||!navigator.onLine)throw Error('Для изменения доступа нужен администратор и соединение с Ubuntu');
    if(!nasAdministration)await refreshNasAdministration();
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||!canAdmin())throw Error('Сеанс администратора изменился');
    const key=nasIdentityJournalKey(),intent=JSON.stringify({type,...payload});
    const stored=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(stored))throw Error('Не удалось прочитать очередь изменения доступа');
    const target=payload.uid||payload.role,existing=stored.find(x=>x.type===type&&x.target===target);
    if(existing&&existing.intent!==intent)throw Error('Предыдущее изменение ещё ожидает подтверждения. Повторите его перед новым изменением');
    let queued=existing;
    if(!queued){
      const operation={id:'identity_'+crypto.randomUUID().replaceAll('-',''),type,...payload};
      if(type==='permissions.replace'){
        const config=nasAdministration.permissions[payload.role];if(!config)throw Error('Обновите матрицу прав');operation.expectedRevision=config.revision;
      }else{
        const profile=[...nasAdministration.users,...nasAdministration.deletedUsers].find(u=>u.uid===payload.uid);if(!profile)throw Error('Обновите список пользователей');
        if(type.startsWith('registration.')){
          const request=nasAdministration.requests.find(r=>r.uid===payload.uid);if(!request)throw Error('Заявка уже рассмотрена. Обновите список');
          operation.expectedRevision=request.revision;operation.expectedProfileRevision=profile.revision;
        }else operation.expectedRevision=profile.revision;
      }
      queued={type,target,intent,operation,scope:client.scope};stored.push(queued);localStorage.setItem(key,JSON.stringify(stored));
    }
    try{
      const result=await client.submitAdministration(queued.operation,{operationScope:queued.scope});
      if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Сеанс администратора изменился');
      const latest=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify(latest.filter(x=>x.operation.id!==queued.operation.id)));
      await refreshNasAdministration().catch(error=>reportSyncError('nas-admin',error));return result;
    }catch(error){
      // A conflict is authoritative; a transport/auth failure retains the same ID.
      if([400,409].includes(error.status)&&epoch===nasRuntimeEpoch){const latest=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify(latest.filter(x=>x.operation.id!==queued.operation.id)));await refreshNasAdministration().catch(()=>{});}
      // Ошибки, кроме 400/409, остаются в очереди: панель «Неподтверждённые
      // изменения» покажет причину застревания (markNasCommandFailed).
      else if(typeof markIdentityCommandFailed==='function'&&epoch===nasRuntimeEpoch){try{markIdentityCommandFailed(key,queued.operation.id,error);}catch(_){}}
      throw error;
    }
  }
  async function runNasAdminAction(type,payload) {
    try{await nasAdminAction(type,payload);showToastEl('Изменение сохранено на Ubuntu',false);return true;}
    catch(error){if(canAdmin())renderAdminPanel();showError(error.message||'Изменение не подтверждено');return false;}
  }
  async function replayNasOfflineJournal() {
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||offlineReplayRunning||!navigator.onLine||!permissionsLoaded||currentUserStatus!=='active'||Date.now()<offlineServerRetryAt)return;
    // Never replay into a server that is not the declared authority.
    if(!nasCanWrite())return;
    const live=()=>epoch===nasRuntimeEpoch&&nasRuntimeClient===client&&client.uid===currentUid;
    offlineReplayRunning=true;
    try{
      for(const op of offlinePendingOps()){
        if(!live()||!navigator.onLine||currentUserStatus!=='active')break;
        if(op.dependencyId){const previous=offlineJournalRead().find(x=>x.id===op.dependencyId);if(previous?.status==='pending')break;if(previous?.status==='rejected'){offlineResolve(op.id,'rejected','previous-action-rejected');offlineProjectState();refreshLineViews();continue;}}
        try{
          const result=await client.submitLine(op,{operationScope:op.operationScope});
          if(!live())return;
          if(result.status)nasReceiptFloors.set(op.truckId,{truckId:op.truckId,shiftId:op.shiftId,cycle:Number(result.status.cycleRevision||0),ttn:Number(result.status.ttnRevision||0)});
          // The NAS transaction owns audit/history. Never deliver Firebase effects.
          const all=offlineJournalRead(),saved=all.find(x=>x.id===op.id&&x.status==='pending');
          if(!saved)continue;
          Object.assign(saved,{status:result.outcome,result:result.reason||result.outcome,resolvedAt:Date.now(),effectsDelivered:true,savedResult:{status:result.status||null,log:result.log||null}});
          offlineJournalWrite(all);offlineAdoptResult(op,result);offlineTransportRecovered();
          if(result.outcome==='rejected')showErrorPanel('⚠️ '+escapeHtml(offlineReasonLabel(result.reason)));
        }catch(error){
          if(!live())return;
          // HTTP/auth/transport failures have no business receipt. Keep the intent.
          reportSyncError('nas',error);
          if(error.retryable||error.uncertain)offlineTransportFailed(error);
          break;
        }
      }
    }finally{offlineReplayRunning=false;if(live())updateSyncUI();}
  }

  function nasCanWrite(){return nasAuthority.provider==='ubuntu';}
  function nasAuthorityError(){return Error('Сейчас данные принимает резервный сервер. Запись на этом сервере закрыта — действия сохраняются на телефоне.');}
  // Persist the complete immutable intent before sending. Lost replies reuse IDs.
  async function nasBusinessCommand(channel,target,fields) {
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||currentUserStatus!=='active'||!navigator.onLine)throw Error('Нужно соединение с Ubuntu');
    if(!nasCanWrite())throw nasAuthorityError();
    const captured=JSON.parse(JSON.stringify(fields));
    const key='samosval_working_test_nas_commands_v1:'+client.scope,slot=channel+':'+target;
    const {expectedRevision,expectedTtnRevision,expectedObjectId,expected,...desired}=captured,intent=JSON.stringify(desired);
    const flightKey=key+':'+slot;
    const inflight=nasCommandFlights.get(flightKey);
    if(inflight){if(inflight.intent!==intent)throw Error('Предыдущее изменение ещё отправляется');return inflight.work;}
    const live=()=>epoch===nasRuntimeEpoch&&client===nasRuntimeClient&&client.uid===currentUid;
    const run=async()=>{
      if(!live())throw Error('Учётная запись изменилась');
      const queue=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(queue))throw Error('Не удалось прочитать очередь Ubuntu');
      let pending=queue.find(x=>x.slot===slot);
      if(pending&&pending.intent!==intent)throw Error('Сначала повторите предыдущее неподтверждённое изменение');
      if(!pending){
        const id=(channel==='report'?'report_':'cmd_')+crypto.randomUUID().replaceAll('-',''),operation={id,...captured};
        if(channel==='control'&&operation.type.endsWith('.create'))operation.recordId='record_'+id;
        if(channel==='start')operation.createdAt=Date.now();
        pending={slot,intent,operation,scope:client.scope};queue.push(pending);localStorage.setItem(key,JSON.stringify(queue));
      }
      const remove=()=>{if(!live())return;const latest=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify(latest.filter(x=>x.operation.id!==pending.operation.id)));};
      nasReadGeneration++;nasPollHolds++;nasRuntimeStop?.();nasRuntimeStop=null;
      try{
        const method={control:'submitControl',start:'startShift',close:'closeShift',settings:'submitSettings',archive:'submitArchive',game:'submitGame',auxiliary:'submitAuxiliary',report:'submitReport',backup:'submitBackup',notification:'submitNotificationTest'}[channel];
        const result=await client[method](pending.operation,{operationScope:pending.scope});
        if(!live())throw Error('Учётная запись изменилась');
        remove();return result;
      }catch(error){
        // 400/409 — сервер сам отказал: команды гарантированно нет на сервере.
        // Остальные ошибки сохраняются в самой команде (markNasCommandFailed):
        // панель «Неподтверждённые изменения» покажет причину застревания,
        // окончательный отказ (4xx кроме 408/429) помечается failed и
        // удаляется только явным решением пользователя в панели, не молча.
        if([400,409].includes(error.status))remove();
        else if(typeof markNasCommandFailed==='function'&&live()){try{markNasCommandFailed(key,pending.operation.id,error);}catch(_){}}
        throw error;
      }
      finally{if(live()){nasPollHolds--;if(!nasPollHolds)nasResumePolling?.();}}
    };
    const work=navigator.locks?navigator.locks.request(key,run):Promise.resolve().then(run);nasCommandFlights.set(flightKey,{work,intent});
    try{return await work;}finally{if(nasCommandFlights.get(flightKey)?.work===work)nasCommandFlights.delete(flightKey);}
  }
  function nasRecordRevision(kind,id){
    const rows=kind==='truck'?nasCatalogSnapshot?.trucks:nasCatalogSnapshot?.objects;
    return rows?.find(row=>row.id===id)?.revision;
  }
  async function nasRefreshLine(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=++nasReadGeneration;if(!client)return;
    const snapshot=await client.readLine();if(client===nasRuntimeClient&&epoch===nasRuntimeEpoch&&generation===nasReadGeneration)acceptNasLineSnapshot(snapshot);
  }
  async function nasSaveRecord(kind,id,data,revision){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    const result=await nasBusinessCommand('control',kind+':'+(id||'new'),{type:kind+(id?'.update':'.create'),...(id?{recordId:id}:{}),expectedRevision:id?revision:0,data});
    await Promise.allSettled([refreshNasObjects(),nasRefreshLine()]);if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch)throw Error('Учётная запись изменилась');renderAll();return result;
  }
  async function nasDeleteRecord(kind,id,revision){
    await nasBusinessCommand('control',kind+':'+id,{type:kind+'.delete',recordId:id,expectedRevision:revision});
    await Promise.allSettled([refreshNasObjects(),nasRefreshLine()]);renderAll();
  }
  async function nasChangeMembership(id,adding){
    if(offlinePendingForTruck(id))throw Error('Сначала синхронизируйте действия этого самосвала');
    const status=state.truckStatus[id],shiftId=state.shift?.id;if(!shiftId)throw Error('Смена не открыта');
    const result=await nasBusinessCommand('control','membership:'+id,{type:adding?'line.add':'line.remove',truckId:id,shiftId,expectedRevision:Number(status?.cycleRevision||0),expectedTtnRevision:Number(status?.ttnRevision||0)});
    const row=result.result;nasReceiptFloors.set(id,{truckId:id,shiftId,cycle:Number(row.cycleRevision||0),ttn:Number(row.ttnRevision||0)});
    offlineRemoteStatuses[id]=row;offlineProjectState();saveCache();renderAll();await nasRefreshLine();
  }

  function loadNasMaterialTransfer(){return import(new URL('./working-test/tabel-v2/material-transfer.mjs',document.baseURI).href);}
  const unresolvedShiftTypeNotice='Смена открыта без выбранного типа (дневная/ночная). Закрыто без переноса в табель — объёмы остались в архиве.';
  async function nasCloseCurrentShift(shiftId){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;if(!client)throw Error('Сеанс Ubuntu не загружен');
    const guard=()=>{if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||currentUid!==client.uid)throw Error('Учётная запись изменилась');};
    const key='samosval_working_test_nas_close_v1:'+client.scope+':'+shiftId;
    let prepared=JSON.parse(localStorage.getItem(key)||'null');
    if(!prepared){prepared=await nasBusinessCommand('close',shiftId+':prepare',{type:'prepare',shiftId});guard();localStorage.setItem(key,JSON.stringify(prepared));}
    if(prepared.shift?.id!==shiftId||prepared.archive&&prepared.archive.sourceShiftId!==shiftId)throw Error('Сохранённое закрытие относится к другой смене');
    await nasRefreshLine();guard();
    // Восстановленная архивная смена уже переносила материал при исходном
    // закрытии: повторного переноса в табель не делаем, только архивация.
    const restoredShift=(state.restoredShifts||[]).some(r=>r.shift.id===shiftId);
    let skippedUnresolvedType=false;
    if(prepared.archive&&!restoredShift){
      const module=await loadNasMaterialTransfer();guard();
      // Legacy-смена, открытая до обязательного выбора типа: день/ночь не
      // доказан, класть объём некуда. Закрываем штатно, материал не переносим
      // и предупреждаем (решение владельца 26.11.2026).
      if(module.shiftHasProvenKind(prepared.shift))await module.transferClosedLine(nasTabelHost(),prepared.shift,prepared.archive);
      else skippedUnresolvedType=true;
      guard();
    }
    await nasBusinessCommand('close',shiftId+':finish',{type:'finish',shiftId});guard();
    localStorage.removeItem(key);
    await nasRefreshLine().catch(error=>reportSyncError('nas',error));guard();
    if(skippedUnresolvedType)appNotice(unresolvedShiftTypeNotice);
  }
// Надзиратель за повторными чтениями сервера после сворачивания приложения.
// Чистые правила без браузера и без сети: их можно проверить отдельно.
// Файл идемпотентен: повторная загрузка не ломает уже созданный объект.
(function (root) {
  'use strict';

  if (root.WorkingTestNasResume) return;

  // Источники, ошибки которых снимаются только успешным повторным чтением.
  const SOURCES = ['nas', 'nas-objects', 'nas-games', 'nas-auxiliary', 'nas-archive', 'nas-settings', 'nas-admin', 'nas-catalog'];

  // Состояние повторов: сколько раз подряд упал источник и когда пробовать снова.
  function createState() {
    return { items: {} };
  }

  function bucket(state) {
    if (!state || typeof state !== 'object') return {};
    if (!state.items || typeof state.items !== 'object') state.items = {};
    return state.items;
  }

  // Задержка перед повтором: 1, 2, 4, 8, 16 секунд, дальше не чаще 30 секунд.
  function backoffDelay(attempt, opts) {
    const options = opts || {};
    const base = Number(options.base) > 0 && Number.isFinite(Number(options.base)) ? Number(options.base) : 1000;
    const max = Number(options.max) > 0 && Number.isFinite(Number(options.max)) ? Number(options.max) : 30000;
    const number = Number(attempt);
    if (!Number.isFinite(number) || number < 1) return base;
    const steps = Math.min(Math.floor(number) - 1, 30);
    return Math.min(base * Math.pow(2, steps), max);
  }

  // Очередная неудача: считаем попытки и назначаем время следующей.
  function recordFailure(state, source, now) {
    const items = bucket(state);
    const previous = items[source] && typeof items[source].attempt === 'number' ? items[source].attempt : 0;
    const attempt = previous + 1;
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    items[source] = { attempt: attempt, nextAt: at + backoffDelay(attempt) };
    return items[source];
  }

  // Успех полностью сбрасывает счётчик источника.
  function recordSuccess(state, source) {
    const items = bucket(state);
    delete items[source];
    return true;
  }

  // Пора ли пробовать снова: без записи — сразу, иначе не раньше nextAt.
  function due(state, source, now) {
    const items = bucket(state);
    const item = items[source];
    if (!item || typeof item.nextAt !== 'number' || !Number.isFinite(item.nextAt)) return true;
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return at >= item.nextAt;
  }

  // Полный сброс: используется после подтверждённого восстановления связи.
  function reset(state) {
    if (state && typeof state === 'object') state.items = {};
    return true;
  }

  const api = {
    SOURCES: SOURCES,
    createState: createState,
    backoffDelay: backoffDelay,
    recordFailure: recordFailure,
    recordSuccess: recordSuccess,
    due: due,
    reset: reset
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  Object.freeze(api);
  root.WorkingTestNasResume = api;
})(typeof window !== 'undefined' ? window : globalThis);
// Правила «активного обновления»: пока приложение на экране, данные читаются
// сами — при возврате видимости, фокуса, сети и разблокировке экрана, а также
// периодически. Здесь только чистые правила: их можно проверить без браузера.
// Файл идемпотентен: повторная загрузка не ломает уже созданный объект.
(function (root) {
  'use strict';

  if (root.WorkingTestNasActivity) return;

  // Поводы разбудить приложение. 'resume' — возобновление после разблокировки
  // экрана или выхода из фона (Page Lifecycle API и мобильные оболочки).
  const REASONS = ['visibilitychange', 'focus', 'pageshow', 'online', 'resume', 'poll'];

  // Приложение активно на экране: вкладка видима и сеть есть.
  function isActive(env) {
    const e = env || {};
    if (e.hidden === true) return false;
    if (e.visible === false) return false;
    if (e.onLine === false) return false;
    return true;
  }

  // Ограничитель частоты: не чаще одной серии обновлений за minGap.
  function createGate(options) {
    const opts = options || {};
    const minGap = Number(opts.minGap) > 0 && Number.isFinite(Number(opts.minGap)) ? Number(opts.minGap) : 4000;
    return { lastAt: 0, minGap: minGap, pending: false };
  }

  // Можно ли обновляться сейчас. force — возврат на экран, его не сдерживаем.
  function allow(gate, now, force) {
    if (!gate || typeof gate !== 'object') return true;
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (force) { gate.lastAt = at; return true; }
    const gap = Number(gate.minGap) > 0 ? Number(gate.minGap) : 4000;
    if (gate.lastAt && at - gate.lastAt < gap) return false;
    gate.lastAt = at;
    return true;
  }

  function reset(gate) {
    if (gate && typeof gate === 'object') { gate.lastAt = 0; gate.pending = false; }
    return true;
  }

  const api = { REASONS: REASONS, isActive: isActive, createGate: createGate, allow: allow, reset: reset };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  Object.freeze(api);
  root.WorkingTestNasActivity = api;
})(typeof window !== 'undefined' ? window : globalThis);// Единый канал восстановления связи (1.7.10). Раньше каждый из 7 источников
// NAS-рантайма независимо ждал свой таймаут и независимо повторял чтение:
// при потере сети телефоном это давало шторм по 20-секундных таймаутов и
// семь сообщений «Сервер недоступен». Теперь состояние связи одно на всё
// приложение, повторы делает только этот супервизор с бэкоффом
// 2/5/10/20/30/60 с, а после первой же успешной пробы все источники
// перечитываются ровно один раз (линия первой — урок 1.6.0).
// Здесь только чистые правила состояния: их можно проверить без браузера.
// Файл идемпотентен: повторная загрузка не ломает уже созданный объект.
(function (root) {
  'use strict';

  if (root.WorkingTestNasConnection) return root.WorkingTestNasConnection;

  // Пауза между пробами после N-й неудачи, секунды. Максимум 60; после
  // восстановления счётчик сбрасывается и первая проба идёт без задержки.
  const BACKOFF_STEPS_S = [2, 5, 10, 20, 30, 60];
  const PROBE_TIMEOUT_S = 15;

  function delayFor(state, now) {
    const attempt = Number(state.attempt) || 0;
    const index = Math.min(attempt, BACKOFF_STEPS_S.length) - 1;
    const seconds = attempt > 0 ? BACKOFF_STEPS_S[Math.max(0, index)] : 0;
    // Отсчёт — от последней неудачи (для первой пробы задержки нет).
    const base = attempt > 0 ? Number(state.lastFailAt) || Number(state.downSince) || now : now;
    const nextAt = base + seconds * 1000;
    return { seconds: seconds, nextAt: nextAt };
  }

  // Создать супервизора. env подставляют браузер или тест:
  //   now() -> мс, probe() -> Promise (GET /api/v1/session с таймаутом 15 c),
  //   emit(kind, detail) -> событие UI 'offline'/'online', log(...) -> консоль.
  function create(env) {
    const e = env || {};
    const now = typeof e.now === 'function' ? e.now : () => Date.now();
    const probe = typeof e.probe === 'function' ? e.probe : async () => {};
    const emit = typeof e.emit === 'function' ? e.emit : () => {};
    const log = typeof e.log === 'function' ? e.log : () => {};

    const state = {
      online: true,        // связь с сервером подтверждена последней пробой
      attempt: 0,          // число неудачных проб с момента потери связи
      downSince: 0,        // когда связь потеряна (для «восстановлено за Xс»)
      probeCount: 0,       // всего проб (для диагностики и тестов)
      probing: false,
      timer: null
    };

    function message(kind, extra) {
      if (kind === 'connecting') return '[связь] подключение…';
      if (kind === 'timeout') return '[связь] таймаут (' + PROBE_TIMEOUT_S + 'с, ответных заголовков нет), повтор через ' + extra + 'с';
      if (kind === 'retry') return '[связь] повтор №' + extra.attempt + ' через ' + extra.seconds + 'с';
      if (kind === 'recovered') return '[связь] восстановлено за ' + extra + 'с, перечитываю данные';
      if (kind === 'offline') return '[связь] оффлайн (браузер)';
      return '[связь] ' + kind;
    }

    // Запустить пробу немедленно. true/false — успех/неудача, null — проба
    // уже идёт (не считать повтором и не двигать бэкофф).
    async function runProbe() {
      if (state.probing) return null;
      state.probing = true;
      state.probeCount++;
      let ok = false;
      try { await probe(); ok = true; } catch (_) { ok = false; }
      state.probing = false;
      return ok;
    }

    // Центральный цикл: пока связи нет, раз в секунду смотрим, не пора ли
    // пробовать. Одна неудача — один переход и одна запись в журнале.
    function loop() {
      if (state.online || state.timer) return;
      const step = async () => {
        if (state.online) return;
        const t = now();
        const wait = delayFor(state, t);
        if (state.attempt > 0 && t < wait.nextAt) return;
        if (state.attempt > 0) log(message('retry', { attempt: state.attempt + 1, seconds: wait.seconds }));
        else if (state.probeCount === 0) log(message('connecting'));
        const ok = await runProbe();
        if (ok === null || state.online) return;
        if (ok) {
          recover();
        } else {
          state.attempt++;
          state.lastFailAt = now();
          log(message('timeout', BACKOFF_STEPS_S[Math.min(state.attempt, BACKOFF_STEPS_S.length) - 1]));
          emit('offline', { attempt: state.attempt, downSince: state.downSince });
        }
      };
      const interval = typeof e.setInterval === 'function'
        ? e.setInterval
        : (root.setInterval ? root.setInterval.bind(root) : null);
      const clear = typeof e.clearInterval === 'function'
        ? e.clearInterval
        : (root.clearInterval ? root.clearInterval.bind(root) : null);
      if (!interval || !clear) return;
      state.timer = interval(() => { void step(); }, 1000);
    }

    function stopLoop() {
      if (state.timer && typeof e.clearInterval === 'function') e.clearInterval(state.timer);
      else if (state.timer && root.clearInterval) root.clearInterval(state.timer);
      state.timer = null;
    }

    // Сообщить о неудаче любого канала. Первый переход в оффлайн — событие и
    // сообщение; повторные неудачи других каналов уже ничего не добавляют.
    function reportFailure(reason) {
      if (!state.online) return false;
      state.online = false;
      state.attempt = 0;
      state.downSince = now();
      if (reason === 'browser-offline') log(message('offline'));
      else log(message('connecting'));
      emit('offline', { attempt: 0, downSince: state.downSince });
      loop();
      return true;
    }

    // Сообщить об успехе любого запроса («сердце» связи): если считались
    // оффлайн — восстановление, одно событие и один общий перечитка.
    function reportSuccess() {
      if (state.online) return false;
      const elapsedS = Math.round((now() - state.downSince) / 1000);
      state.online = true;
      state.attempt = 0;
      state.downSince = 0;
      stopLoop();
      log(message('recovered', elapsedS));
      emit('online', { elapsedS: elapsedS });
      return true;
    }

    function recover() {
      if (state.online) return false;
      return reportSuccess();
    }

    function snapshot() {
      const wait = delayFor(state, now());
      return {
        online: state.online,
        attempt: state.attempt,
        downSince: state.downSince,
        probeCount: state.probeCount,
        nextRetryInS: state.online ? 0 : Math.max(0, Math.ceil((wait.nextAt - now()) / 1000))
      };
    }

    return Object.freeze({
      reportFailure: reportFailure,
      reportSuccess: reportSuccess,
      runProbe: runProbe,
      snapshot: snapshot,
      stop: stopLoop,
      BACKOFF_STEPS_S: BACKOFF_STEPS_S,
      PROBE_TIMEOUT_S: PROBE_TIMEOUT_S
    });
  }

  const api = { create: create, BACKOFF_STEPS_S: BACKOFF_STEPS_S, PROBE_TIMEOUT_S: PROBE_TIMEOUT_S };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  Object.freeze(api);
  root.WorkingTestNasConnection = api;
  return api;
})(typeof window !== 'undefined' ? window : globalThis);
/* Phone data is deliberately separate from cached line/catalog payloads. */
let truckPhoneRows=new Map(),truckPhoneSequence=0,truckPhoneWrite=null,truckPhoneModalNode=null;
function resetTruckPhones(){truckPhoneSequence++;truckPhoneRows.clear();truckPhoneWrite=null;}
function truckPhoneEntry(id){const row=truckPhoneRows.get(id);return row?{phone:row.phone||'',driverName:row.driverName==null?null:row.driverName}:null;}
function truckPhoneValidNumber(phone){return typeof phone==='string'&&/^\+[1-9][0-9]{7,14}$/.test(phone);}
// Same input rules as the server: plus, digits, space, brackets and hyphen only.
function truckPhoneNormalizeInput(value){
 const raw=String(value==null?'':value).trim();
 if(!/^[+0-9 ()-]{1,40}$/.test(raw))return '';
 const phone=raw.replace(/[ ()-]/g,'');
 return truckPhoneValidNumber(phone)?phone:'';
}
// null = no name, undefined = rejected name, string = cleaned name (same charset as the server).
function truckPhoneCleanName(value){
 const raw=String(value==null?'':value).trim().replace(/\s+/g,' ');
 if(!raw)return null;
 if(raw.length>80||/[\u0000-\u001F\u007F]/.test(raw)||!/^[\p{L}\p{N} .'-]+$/u.test(raw))return undefined;
 return raw;
}
async function truckPhoneRequest(body){
 const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
 if(!client||!hasPermission('view_truck_phone'))throw Error('Требуется вход и право просмотра');
 // Reads wait for the current write; an older read may never erase its result.
 if(!body&&truckPhoneWrite){await truckPhoneWrite;return;}
 if(body&&truckPhoneWrite)throw Error('Сохранение уже выполняется');
 const sequence=++truckPhoneSequence;
 const patch=body?{truckId:body.truckId,phone:body.phone,driverName:body.driverName==null?null:body.driverName}:null;
 const work=patch?client.submitTruckPhone(patch):client.readTruckPhones();
 if(patch)truckPhoneWrite=work;
 try{
  const result=await work;
  if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch||sequence!==truckPhoneSequence||!hasPermission('view_truck_phone'))throw Error('Сессия или права изменились');
  truckPhoneRows=new Map(result.phones.map(row=>[row.truckId,{phone:row.phone,driverName:row.driverName==null?null:row.driverName}]));
 }catch(error){if(client===nasRuntimeClient&&epoch===nasRuntimeEpoch&&sequence===truckPhoneSequence&&(error.code==='dataset-restored-reload'||error.code==='session-changed'||error.status===403))resetTruckPhones();throw error;}
 finally{if(truckPhoneWrite===work)truckPhoneWrite=null;}
}
async function refreshTruckPhones(){
 if(!hasPermission('view_truck_phone')){resetTruckPhones();return;}
 try{await truckPhoneRequest();renderLine();renderGlobalTrucksManage();}catch(e){console.warn('Телефоны недоступны');}
}
// The line card only carries a small icon: the number lives in the dialog, never in a tel link.
function truckPhoneIcon(t){
 if(!hasPermission('view_truck_phone')||!t)return '';
 const id=escapeHtml(String(t.id==null?'':t.id));
 // tp-has-phone помечает карточки с сохранённым номером — иконка подсвечивается зелёным (style-04.css).
 const entry=truckPhoneEntry(t.id);
 const cls=entry&&entry.phone?'truck-phone-btn tp-has-phone':'truck-phone-btn';
 return `<button class="${cls}" type="button" onclick="openTruckPhoneModal('${id}')" aria-label="Телефон самосвала" title="Телефон водителя"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7A2 2 0 0 1 22 16.9z"/></svg></button>`;
}
function truckPhoneModalMarkup(view){
 const truck=view.truck||{},entry=truckPhoneEntry(truck.id),phone=entry?entry.phone:'',name=entry&&entry.driverName?entry.driverName:'';
 const head=`<div class="tp-head"><div><div class="tp-title">Телефон водителя</div><div class="tp-sub">${escapeHtml(String(truck.brand||''))} ${escapeHtml(String(truck.number||''))}</div></div><button type="button" class="tp-close" data-tp="close" aria-label="Закрыть">×</button></div>`;
 if(view.editing)return head+`<form class="tp-form" novalidate><label class="tp-label">Телефон<input class="form-control" data-tp="phone" type="tel" inputmode="tel" maxlength="40" placeholder="+7 999 123-45-67" value="${escapeHtml(phone)}"></label><label class="tp-label">Имя водителя<input class="form-control" data-tp="driver" type="text" maxlength="80" placeholder="Имя водителя" value="${escapeHtml(name)}"></label><p class="tp-error" data-tp="error" role="alert"></p><div class="tp-actions"><button type="submit" class="btn btn-quick" data-tp="save">Сохранить</button><button type="button" class="btn btn-secondary" data-tp="cancel">Отмена</button></div></form>`;
 const rows=`<div class="tp-rows"><div class="tp-row"><span class="tp-row-label">Водитель</span><span class="tp-row-value" data-tp="name">${escapeHtml(name||'Имя не указано')}</span></div><div class="tp-row"><span class="tp-row-label">Телефон</span><span class="tp-row-value" data-tp="phone-value">${escapeHtml(phone||'Телефон не добавлен')}</span></div></div>`;
 const call=hasPermission('call_truck_phone')&&truckPhoneValidNumber(phone)?`<a class="btn btn-quick tp-call" data-tp="call" href="tel:${escapeHtml(phone)}">📞 Позвонить</a>`:'';
 const edit=hasPermission('add_truck_phone')?'<button type="button" class="btn btn-secondary" data-tp="edit">Изменить/добавить</button>':'';
 return head+rows+`<div class="tp-actions">${call}${edit}</div>`;
}
function closeTruckPhoneModal(){
 const node=truckPhoneModalNode;truckPhoneModalNode=null;
 if(node&&node.remove)node.remove();
}
function openTruckPhoneModal(id,options){
 if(!hasPermission('view_truck_phone'))return;
 const truck=typeof findTruck==='function'?findTruck(id):null;
 if(!truck)return;
 closeTruckPhoneModal();
 const overlay=document.createElement('div');
 overlay.className='tp-overlay';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');
 const card=document.createElement('div');card.className='tp-card';
 overlay.appendChild(card);
 const view={truck,editing:!!(options&&options.edit)&&hasPermission('add_truck_phone')};
 const draw=focus=>{
  card.innerHTML=truckPhoneModalMarkup(view);
  const pick=selector=>card.querySelector(selector);
  const close=pick('[data-tp=close]');if(close)close.onclick=closeTruckPhoneModal;
  const cancel=pick('[data-tp=cancel]');if(cancel)cancel.onclick=closeTruckPhoneModal;
  const edit=pick('[data-tp=edit]');
  if(edit)edit.onclick=()=>{view.editing=true;draw(true);};
  const form=pick('form');
  if(form)form.onsubmit=async event=>{
   event.preventDefault();
   const phoneField=pick('[data-tp=phone]'),nameField=pick('[data-tp=driver]'),errorNode=pick('[data-tp=error]'),saveBtn=pick('[data-tp=save]');
   const phone=truckPhoneNormalizeInput(phoneField?phoneField.value:'');
   if(!phone){if(errorNode)errorNode.textContent='Введите номер: плюс и 8–15 цифр';return;}
   const driverName=truckPhoneCleanName(nameField?nameField.value:'');
   if(driverName===undefined){if(errorNode)errorNode.textContent='Имя: буквы, цифры, пробел, точка, дефис, апостроф — до 80 символов';return;}
   if(saveBtn)saveBtn.disabled=true;
   try{
    await truckPhoneRequest({truckId:view.truck.id,phone,driverName});
    view.editing=false;draw(false);
    if(typeof renderLine==='function')renderLine();
    if(typeof renderGlobalTrucksManage==='function')renderGlobalTrucksManage();
   }catch(error){if(errorNode)errorNode.textContent=error&&error.message?error.message:'Не удалось сохранить номер';}
   finally{if(saveBtn)saveBtn.disabled=false;}
  };
  if(focus){const first=pick('[data-tp=phone]');if(first&&first.focus)first.focus();}
 };
 overlay.addEventListener('click',event=>{if(event.target===overlay)closeTruckPhoneModal();});
 document.body.appendChild(overlay);
 truckPhoneModalNode=overlay;
 draw(view.editing);
}
// Kept as the entry point for the "add a number" buttons of earlier releases.
function addTruckPhone(id){
 if(!hasPermission('view_truck_phone')||!hasPermission('add_truck_phone'))return;
 openTruckPhoneModal(id,{edit:true});
}
  // Панель «Неподтверждённые изменения» (инструмент обновления, 2026-11).
  // Владелец видел: «Установить» → «Обновление отложено: есть неподтверждённые
  // изменения на сервере: 1», но инструмента разобраться не было. Панель
  // собирает ВСЕ неподтверждённые операции по категориям (рейсы, команды
  // сервера, табель), объясняет причину простым языком и позволяет повторить
  // отправку или осознанно отбросить застрявшую команду. Ничего не удаляется
  // без явного подтверждения пользователя.
  function nasCommandsQueueKey(scope){return 'samosval_nas_commands_v1:'+scope;}
  function nasToolReadQueue(key){try{const queue=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(queue)?queue:[];}catch(_){return [];}}
  function nasToolWriteQueue(key,queue){localStorage.setItem(key,JSON.stringify(queue));}
  function nasToolRemoveFromQueue(key,operationId){nasToolWriteQueue(key,nasToolReadQueue(key).filter(x=>!(x.operation&&x.operation.id===operationId)));}
  // Сервер окончательно отказал (4xx, кроме «повторите позже» 408/429):
  // команда никогда не пройдёт — её можно только осознанно отбросить в панели.
  function nasToolPermanentReject(status){const code=Number(status)||0;return code>=400&&code<500&&![408,429].includes(code);}
  // Ошибка отправки записывается в саму команду очереди: панель показывает
  // оператору причину застревания, а не безликое «изменений: 1».
  function markNasCommandFailed(key,operationId,error){
    const queue=nasToolReadQueue(key),entry=queue.find(x=>x.operation&&x.operation.id===operationId);if(!entry)return;
    entry.lastError={status:Number(error&&error.status)||0,message:String(error&&error.message||error||'').slice(0,200),at:Date.now()};
    entry.failed=nasToolPermanentReject(entry.lastError.status);
    nasToolWriteQueue(key,queue);
  }
  function markIdentityCommandFailed(key,operationId,error){markNasCommandFailed(key,operationId,error);}
  const NAS_OPERATION_TITLES={
    'shift.object':'Смена объекта','line.add':'Добавление самосвала на линию','line.remove':'Снятие самосвала с линии',
    'truck.create':'Создание самосвала','truck.update':'Изменение самосвала','truck.delete':'Удаление самосвала',
    'object.create':'Создание объекта','object.update':'Изменение объекта','object.delete':'Удаление объекта',
    'report.update':'Изменение рейса','report.delete':'Удаление рейса',
    'settings.patch':'Изменение настроек','settings.rewards':'Изменение наград',
    'game.play':'Действие в мини-игре','game.grant':'Начисление монет',
    'prepare':'Подготовка закрытия смены','finish':'Закрытие смены',
    'auxiliary.save':'Изменение записи','auxiliary.delete':'Удаление записи'
  };
  const NAS_IDENTITY_TITLES={
    'user.access':'Изменение доступа пользователя','user.nickname':'Изменение имени пользователя','user.role':'Смена роли пользователя',
    'user.delete':'Удаление пользователя','permissions.replace':'Изменение прав роли',
    'registration.approve':'Одобрение заявки','registration.reject':'Отклонение заявки'
  };
  function nasToolObjectLabel(id){
    const row=(typeof state!=='undefined'&&Array.isArray(state.objects)?state.objects:[]).find(x=>x.id===id);
    return row?(row.name||row.title||String(id)):'';
  }
  function nasToolTruckLabel(id,fallback){if(fallback)return fallback;if(typeof truckName==='function'&&id){try{return truckName(id);}catch(_){}}return '';}
  function nasOperationTitle(operation){
    const type=operation&&operation.type;
    let title=NAS_OPERATION_TITLES[type]||'';
    if(!title&&operation&&('objectId' in operation)&&!type)title='Открытие смены';
    if(!title)title='Команда сервера';
    const extras=[];
    if(operation.objectId)extras.push(nasToolObjectLabel(operation.objectId)||'объект');
    if(operation.truckId)extras.push(nasToolTruckLabel(operation.truckId));
    if(operation.uid)extras.push('пользователь');
    return extras.length?title+' · '+extras.join(', '):title;
  }
  function nasQueueStuckReason(entry){
    const error=entry&&entry.lastError;
    if(!error)return {text:entry&&entry.failed?'Команда не отправлена — повторите или отбросьте':'Ожидает отправки на сервер',stuck:!!(entry&&entry.failed)};
    const status=Number(error.status)||0,short=String(error.message||'').slice(0,140);
    if([400,409].includes(status))return {text:'Сервер отклонил навсегда (конфликт или неверные данные'+(short?': '+short:'')+'). Команда не будет применена — можно отбросить',stuck:true};
    if(status===401||status===403)return {text:'Сервер отказал в доступе (нет прав или сеанс истёк'+(short?': '+short:'')+'), команда не будет применена',stuck:true};
    if(status===408||status===429)return {text:'Сервер перегружен — повторите отправку позже',stuck:false};
    if(status>=500)return {text:'Ошибка сервера (код '+status+') — повторите отправку позже',stuck:false};
    if(!status)return {text:'Нет связи с сервером — отправится автоматически после восстановления связи',stuck:false};
    return {text:'Сервер вернул ошибку (код '+status+(short?': '+short:'')+'). Команда, вероятно, не будет применена',stuck:true};
  }
  // Единый снимок всех неподтверждённых операций по категориям.
  async function collectUnsyncedUpdates(){
    const categories=[];
    const noLink=(typeof offlineServerUnreachable!=='undefined'&&offlineServerUnreachable)||(typeof navigator!=='undefined'&&!navigator.onLine);
    const ops=(typeof offlinePendingOps==='function'?offlinePendingOps():[]).filter(op=>op&&op.status!=='resolved');
    if(ops.length){
      categories.push({id:'trips',title:'Рейсы',count:ops.length,items:ops.map(op=>({
        id:op.id,
        title:({arrive:'Прибытие',load:'Погрузка',ttn:'Отметка ТТН',reset:'Сброс таймера'})[op.type]+' · '+nasToolTruckLabel(op.truckId,op.truckName||''),
        detail:(op.createdAt?new Date(op.createdAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})+' — ':'')+'не отправлено: '+(noLink?'нет связи':'ожидает отправки')
      }))});
    }
    const commands=[];
    const client=(typeof nasRuntimeClient!=='undefined')?nasRuntimeClient:null;
    if(client&&client.scope){
      const key=nasCommandsQueueKey(client.scope);
      for(const entry of nasToolReadQueue(key))commands.push(nasCommandView(entry,key,false));
    }
    if(typeof nasIdentityJournalKey==='function'){
      const key=nasIdentityJournalKey();
      for(const entry of nasToolReadQueue(key))commands.push(nasCommandView(entry,key,true));
    }
    if(commands.length)categories.push({id:'server',title:'Команды сервера',count:commands.length,items:commands});
    let tabel={pending:0,uploading:false};
    if(typeof window!=='undefined'&&typeof window.__tabelPrepareUpdate==='function'){
      try{const result=await window.__tabelPrepareUpdate();tabel={pending:Number(result&&result.pending)||0,uploading:!!(result&&result.uploading)};}catch(_){}
    }
    if(tabel.pending||tabel.uploading){
      categories.push({id:'tabel',title:'Табель',count:tabel.pending,items:[{id:'tabel-main',
        title:'Табель: '+tabel.pending+' неподтверждённ'+(tabel.pending%10===1&&tabel.pending%100!==11?'ая запись':'ых записей')+(tabel.uploading?' — идёт отправка':''),
        detail:'Откройте табель и дождитесь сохранения или разрешения конфликта'}]});
    }
    return {categories};
  }
  function nasCommandView(entry,key,identity){
    const operation=entry.operation||{};
    const reason=nasQueueStuckReason(entry);
    return {
      key,identity,operationId:operation.id,
      title:(identity?NAS_IDENTITY_TITLES[operation.type]||'Изменение доступа':nasOperationTitle(operation)),
      createdAt:entry.createdAt||operation.createdAt||null,
      detail:reason.text+(entry.createdAt?' · с '+new Date(entry.createdAt).toLocaleString('ru-RU'):''),
      stuck:reason.stuck,canRetry:!identity||true
    };
  }
  const NAS_SUBMIT_METHODS={control:'submitControl',start:'startShift',close:'closeShift',settings:'submitSettings',archive:'submitArchive',game:'submitGame',auxiliary:'submitAuxiliary',report:'submitReport',backup:'submitBackup',notification:'submitNotificationTest'};
  // Повтор отправки одной команды из панели: тот же метод клиента, тот же ID.
  async function retryNasQueueEntry(key,operationId){
    const entry=nasToolReadQueue(key).find(x=>x.operation&&x.operation.id===operationId);
    if(!entry)throw Error('Команда уже отсутствует в очереди');
    const client=(typeof nasRuntimeClient!=='undefined')?nasRuntimeClient:null;
    if(!client)throw Error('Сеанс сервера не загружен — повторите после входа');
    if(typeof navigator!=='undefined'&&!navigator.onLine)throw Error('Нет соединения с сервером');
    const identity=typeof entry.slot!=='string';
    if(identity){
      if(typeof client.submitAdministration!=='function')throw Error('Клиент не поддерживает повтор этой команды');
    }else{
      const channel=String(entry.slot||'').split(':')[0];
      const method=NAS_SUBMIT_METHODS[channel];
      if(!method||typeof client[method]!=='function')throw Error('Неизвестный тип команды: '+channel);
    }
    entry.failed=false;delete entry.lastError;entry.identity=identity;
    nasToolWriteQueue(key,nasToolReadQueue(key).map(x=>x.operation&&x.operation.id===operationId?entry:x));
    try{
      const result=identity
        ?await client.submitAdministration(entry.operation,{operationScope:entry.scope})
        :await client[NAS_SUBMIT_METHODS[String(entry.slot||'').split(':')[0]]](entry.operation,{operationScope:entry.scope});
      nasToolRemoveFromQueue(key,operationId);
      return result;
    }catch(error){
      if([400,409].includes(error&&error.status))nasToolRemoveFromQueue(key,operationId);
      else markNasCommandFailed(key,operationId,error);
      throw error;
    }
  }
  // Удаление ТОЛЬКО с явного подтверждения пользователя; текст объясняет,
  // что именно будет отброшено. confirm — async (вопрос) => boolean.
  async function discardNasQueueEntry(key,operationId,confirm){
    const entry=nasToolReadQueue(key).find(x=>x.operation&&x.operation.id===operationId);
    if(!entry)return false;
    const view=nasCommandView(entry,key,!!entry.identity);
    const question='Отбросить «'+view.title+'»?\n\n'+view.detail+'.\n\nИзменение НЕ применено на сервере и будет отброшено (на сервере ничего не изменится). Продолжить?';
    const agreed=typeof confirm==='function'?await confirm(question):false;
    if(!agreed)return false;
    nasToolRemoveFromQueue(key,operationId);
    return true;
  }
  function showUnsyncedChangesPanel(){
    const overlay=document.createElement('div');
    overlay.id='wt-unsynced-panel';
    overlay.style.cssText='position:fixed;inset:0;z-index:12000;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.75);padding:14px;';
    const card=document.createElement('div');
    card.style.cssText='width:min(560px,100%);max-height:86dvh;overflow:auto;background:var(--card,#122135);color:var(--text,#f1f5f9);border:1px solid var(--border,#334155);border-radius:18px;padding:18px 18px 14px;font-size:15px;line-height:1.5;box-shadow:0 24px 80px #0008;';
    overlay.append(card);
    const close=()=>overlay.remove();
    overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
    const toast=(text,bad)=>{if(typeof showToastEl==='function')showToastEl(text,!!bad);};
    async function runAction(button,work){button.disabled=true;try{await work();}catch(error){toast(error&&error.message||'Не удалось',true);if(typeof showError==='function')showError(error&&error.message||'Не удалось');}finally{render();}}
    async function render(){
      const report=await collectUnsyncedUpdates();
      card.textContent='';
      const title=document.createElement('h2');
      title.style.cssText='margin:0 0 6px;font-size:19px;';
      title.textContent='Неподтверждённые изменения';
      card.append(title);
      const intro=document.createElement('p');
      intro.style.cssText='margin:0 0 12px;font-size:13px;color:var(--muted,#94a3b8);';
      intro.textContent='Пока есть неподтверждённые изменения, обновление отложено. Разберитесь с ними — затем кнопка «Установить» сработает.';
      card.append(intro);
      if(!report.categories.length){
        const ok=document.createElement('p');
        ok.style.cssText='font-weight:700;color:#4ade80;margin:12px 0;';
        ok.textContent='✅ Все изменения подтверждены сервером. Можно устанавливать обновление.';
        card.append(ok);
      }
      for(const category of report.categories){
        const head=document.createElement('h3');
        head.style.cssText='margin:14px 0 6px;font-size:15px;';
        head.textContent=category.title+(category.count?': '+category.count:'');
        card.append(head);
        for(const item of category.items){
          const row=document.createElement('div');
          row.style.cssText='border:1px solid var(--border,#334155);border-radius:12px;padding:10px;margin:8px 0;';
          const name=document.createElement('div');
          name.style.cssText='font-weight:700;';
          name.textContent=item.title;
          const detail=document.createElement('div');
          detail.style.cssText='font-size:13px;color:var(--muted,#94a3b8);margin:4px 0 8px;';
          detail.textContent=item.detail;
          row.append(name,detail);
          if(category.id==='server'){
            const retry=document.createElement('button');
            retry.type='button';retry.className='btn btn-quick btn-small';
            retry.style.marginRight='6px';retry.textContent='Повторить отправку сейчас';
            retry.onclick=()=>runAction(retry,async()=>{await retryNasQueueEntry(item.key,item.operationId);toast('Команда отправлена');});
            const discard=document.createElement('button');
            discard.type='button';discard.className='btn btn-secondary btn-small';
            discard.textContent=item.stuck?'Удалить эту команду':'Отбросить';
            discard.onclick=()=>runAction(discard,async()=>{
              const removed=await discardNasQueueEntry(item.key,item.operationId,async question=>typeof appConfirm==='function'?appConfirm(question):window.confirm(question));
              if(removed)toast('Команда отброшена — на сервере ничего не изменилось');
            });
            row.append(retry,discard);
          }
          card.append(row);
        }
        if(category.id==='trips'){
          const retry=document.createElement('button');
          retry.type='button';retry.className='btn btn-quick btn-small';
          retry.textContent='Повторить отправку рейсов сейчас';
          retry.onclick=()=>runAction(retry,async()=>{if(typeof offlineReplayJournal==='function'){void offlineReplayJournal();toast('Отправка рейсов запущена');}});
          card.append(retry);
        }
        if(category.id==='tabel'){
          const open=document.createElement('button');
          open.type='button';open.className='btn btn-quick btn-small';
          open.textContent='Открыть табель';
          open.onclick=()=>{close();if(typeof openTabelV2==='function')void openTabelV2();else document.getElementById('nav-tabel-v2')?.click();};
          card.append(open);
        }
      }
      const done=document.createElement('button');
      done.type='button';done.className='btn btn-primary';done.style.cssText='width:100%;margin-top:14px;padding:12px;font-size:16px;';
      done.textContent='Закрыть';
      done.onclick=close;
      card.append(done);
      document.body.append(overlay);
    }
    if(document.getElementById('wt-unsynced-panel'))document.getElementById('wt-unsynced-panel').remove();
    void render();
  }
  if(typeof window!=='undefined')window.__wtShowUnsyncedPanel=showUnsyncedChangesPanel;
  let lineCountAuditStop = null, lineCountAuditKey = '';
  // 1.7.11: страховка проверки учётной записи (см. wtApplyAuthUser) и
  // последняя ошибка обработчика сессии (кладётся в 05-authentication.js).
  let wtAuthCheckTimer = null, wtAuthCheckLastError = null;
  function syncLineCountAudit() {
    if(isNasRuntime()){lineCountAuditStop?.();lineCountAuditStop=null;return;}
    const shift = state.shift;
    const key = shift ? currentUid + ':' + shift.startDate : '';
    if (key === lineCountAuditKey) return;
    lineCountAuditStop?.(); lineCountAuditStop = null; lineCountAuditKey = key;
    state.lineAudit = [];
    if (!shift) return;
    const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(shift.startDate || '');
    const day = match ? `${match[3]}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}` : shift.startDate;
    const start = Date.parse(day + 'T00:00:00+03:00');
    if (!Number.isFinite(start)) return;
    lineCountAuditStop = refs.audit.where('timestamp','>=',start).where('timestamp','<',start+86400000)
      .orderBy('timestamp').onSnapshot(snapshot => {
        if (lineCountAuditKey !== key) return;
        state.lineAudit = snapshot.docs.map(d => ({id:d.id,...d.data()}));
        saveCache(); scheduleRender('renderHeaderStats');
      }, error => console.warn('Техника: история дня', error));
  }
  function startSync(sessionGeneration = authSessionGeneration) {
    stopSync();
    if(isNasRuntime())return;
    const currentSession = () => sessionGeneration === authSessionGeneration && currentUid;
    unsubscribers.push(refs.trucks.onSnapshot({ includeMetadataChanges: true }, s => { if (!currentSession()) return; state.trucks = s.docs.map(d => Object.assign({id:d.id}, d.data())); markSync('trucks', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); scheduleRenderForTab('trucks', 'renderGlobalTrucksManage'); scheduleRenderForTab('line', 'renderLine'); scheduleRender('renderHeaderStats'); }, e=>{if(currentSession())reportSyncError('trucks', e)}));
    unsubscribers.push(refs.objects.onSnapshot({ includeMetadataChanges: true }, s => { state.objects = s.docs.map(d => Object.assign({id:d.id}, d.data())); if(state.shift?.objectId)state.shift.objectName=objectTitle(state.shift.objectId,state.shift.objectName); for(const a of state.archive||[])if(a.objectId)a.objectName=objectTitle(a.objectId,a.objectName); markSync('objects', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); scheduleRenderForTab('trucks', 'renderGlobalObjectsManage'); scheduleRender('renderHeaderStats'); scheduleRenderForTab('report', 'renderReport'); scheduleRenderForTab('archive', 'renderArchive'); scheduleRenderForTab('analytics', 'renderAnalytics'); window.dispatchEvent(new Event('samosval-working-test-objects-changed')); }, e=>reportSyncError('objects', e)));
    unsubscribers.push(refs.logs.onSnapshot({includeMetadataChanges:true},receiveLoadLogs,e=>reportSyncError('logs',e)));
    unsubscribers.push(refs.truckStatus.onSnapshot({includeMetadataChanges:true},receiveTruckStatuses,e=>reportSyncError('status',e)));
    unsubscribers.push(refs.shift.onSnapshot({ includeMetadataChanges: true }, doc => { state.shift = doc.exists ? Object.assign({id:doc.id}, doc.data()) : null; if(state.shift?.objectId)state.shift.objectName=objectTitle(state.shift.objectId,state.shift.objectName); offlineProjectState();syncLineCountAudit();markSync('shift', doc.metadata.fromCache, doc.metadata.hasPendingWrites, doc.exists?1:0); if(!initialized) initialized=true; saveCache(); scheduleRender('renderAll'); }, e=>reportSyncError('shift', e)));
    unsubscribers.push(refs.archive.onSnapshot({ includeMetadataChanges: true }, s => { state.archive = s.docs.map(d => Object.assign({id:d.id}, d.data())); markSync('archive', s.metadata.fromCache, s.metadata.hasPendingWrites, s.size); saveCache(); scheduleRenderForTab('archive', 'renderArchive'); scheduleRenderForTab('analytics', 'renderAnalytics'); scheduleRender('renderHeaderStats'); }, e=>reportSyncError('archive', e)));
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
    // === SECURITY: права и флаг готовности ===
    unsubscribers.push(permsRef.onSnapshot({ includeMetadataChanges: true }, doc => {
      if (!currentSession()) return;
      markSync('permissions', doc.metadata.fromCache, doc.metadata.hasPendingWrites, doc.exists ? 1 : 0);
      permissionsServerConfirmed = !doc.metadata.fromCache;
      if (doc.exists) {
        permissionsConfig = doc.data();
      } else {
        permsRef.set(DEFAULT_PERMISSIONS).catch(e=>console.warn(e));
        permissionsConfig = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
      }
      permissionsLoaded = true;
      document.body.setAttribute('data-perms-ready', '1');
      // Do not read appConfig from a restored IndexedDB session.  The profile
      // and permissions snapshots must first be confirmed by the server;
      // otherwise a transient permission error is misclassified as offline.
      if (!doc.metadata.fromCache && profileServerConfirmed) startAppConfigSync();
      updateNavUI();
      applyRoleUI();
      renderAll();
    }, e => {
      reportSyncError('permissions', e);
      permissionsLoaded = false;
      permissionsConfig = {};
      showError('Не удалось загрузить права доступа. Обновите страницу или проверьте подключение.');
      document.body.removeAttribute('data-perms-ready');
      updateNavUI();
      applyRoleUI();
      renderAll();
    }));
  }

  function startAppConfigSync(sessionGeneration = authSessionGeneration) {
    const sessionUid = currentUid;
    if (isNasRuntime() || !sessionUid || currentUserStatus !== 'active' || !profileServerConfirmed || !permissionsServerConfirmed || appConfigSyncUid === sessionUid && appConfigSyncGeneration === sessionGeneration) return;
    appConfigSyncUid = sessionUid;
    appConfigSyncGeneration = sessionGeneration;
    unsubscribers.push(appConfigRef.onSnapshot({includeMetadataChanges:true}, doc => {
      if (sessionUid !== currentUid || sessionGeneration !== authSessionGeneration || currentUserStatus !== 'active') return;
      if (doc.exists) {
        const d = doc.data();
        if(Number.isFinite(d.cycleMinutes)){
          settings.cycleMinutes=Math.max(15,d.cycleMinutes);
          localStorage.setItem('working-test-settings',JSON.stringify(settings));
        }
        appConfig = {
          maxEnabled: !!d.maxEnabled, maxUrl: d.maxUrl || '', maxToken: d.maxToken || '', maxChatId: d.maxChatId || '',
          notifyStart: d.notifyStart !== undefined ? !!d.notifyStart : true,
          notifyArrive: d.notifyArrive !== undefined ? !!d.notifyArrive : true,
          notifyLoad: d.notifyLoad !== undefined ? !!d.notifyLoad : true,
          notifyTtn: d.notifyTtn !== undefined ? !!d.notifyTtn : true,
          notifyLineStart: d.notifyLineStart !== undefined ? !!d.notifyLineStart : true,
          notifyLineEnd: d.notifyLineEnd !== undefined ? !!d.notifyLineEnd : true,
          testReviewFlags: d.testReviewFlags || {},
          gameRewardSchedule: Array.isArray(d.gameRewardSchedule) ? d.gameRewardSchedule : []
        };
        renderAppSettingsIfActive();
        if (appConfig.maxEnabled && appConfig.maxUrl) runMaxQueue();
      }
      markSync('appConfig', doc.metadata.fromCache, doc.metadata.hasPendingWrites, doc.exists ? 1 : 0);
      window.__gameConfigChanged?.();
    }, e => {
      if (sessionUid !== currentUid || sessionGeneration !== authSessionGeneration) return;
      reportSyncError('appConfig', e);
    }));
  }

  // П4: перерисовка линии откладывается при активном удержании/касании карточек
  // (window.__lineHoldActive из core/18). Отложенный долг выполняется после
  // снятия флага через __lineFlushDeferred — действия другого оператора не
  // теряются. Повторная проверка в rAF закрывает случай, когда удержание
  // началось уже после того, как 50-мс таймер был запущен.
  let renderLineDeferredByHold = false;
  function scheduleRenderLine() {
    if (typeof window.__lineHoldActive === 'function' && window.__lineHoldActive()) { renderLineDeferredByHold = true; return; }
    if (renderLinePending) return; renderLinePending = true;
    setTimeout(() => { requestAnimationFrame(() => {
      if (typeof window.__lineHoldActive === 'function' && window.__lineHoldActive()) { renderLineDeferredByHold = true; renderLinePending = false; return; }
      renderLine(); renderLinePending = false;
    }); }, 50);
  }
  window.__lineFlushDeferred = function() {
    if (!renderLineDeferredByHold) return;
    renderLineDeferredByHold = false;
    scheduleRenderLine();
  }
  function scheduleRenderForTab(tabName, funcName) { let el = document.getElementById('tab-' + tabName); if (el && el.classList.contains('active') && typeof window[funcName] === 'function') { if (funcName === 'renderLine') scheduleRenderLine(); else window[funcName](); } }
  function scheduleRender(funcName) { if (typeof window[funcName] === 'function') window[funcName](); }

  const requestSyncStatus = {requests:false,users:false,errors:{}};
  // Выбранная админом роль заявки не должна сбрасываться фоновым снапшотом
  // users/requests (acceptRegistrationSnapshot перестраивает блок через
  // innerHTML, и select#req_role_* сбрасывался до viewer). Пока админ
  // взаимодействует с блоком заявок (фокус/открытый select), перерисовка
  // откладывается; при перестроении значения select переживают innerHTML —
  // сохраняются и восстанавливаются по id заявки.
  let registrationRoleHoldTimer=null;
  function registrationRoleHoldActive() {
    const container=document.getElementById('requestsListContainer');
    const active=document.activeElement;
    return !!(active && typeof active.matches==='function' && active.matches('select')
      && container && typeof container.contains==='function' && container.contains(active));
  }
  function scheduleRenderRegistrationRequests() {
    clearTimeout(registrationRoleHoldTimer);
    registrationRoleHoldTimer=setTimeout(()=>{registrationRoleHoldTimer=null;renderRegistrationRequests();},1000);
  }
  function saveRoleSelections(list) {
    const roles={};
    list.forEach(r=>{const sel=document.getElementById('req_role_'+r.id);if(sel&&sel.value)roles[r.id]=sel.value;});
    return roles;
  }
  function restoreRoleSelections(list,roles) {
    list.forEach(r=>{const v=roles[r.id];if(!v||!Object.prototype.hasOwnProperty.call(ROLES,v))return;const sel=document.getElementById('req_role_'+r.id);if(sel)sel.value=v;});
  }
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
    // Пока админ взаимодействует с блоком заявок, фоновая перерисовка
    // откладывается (паттерн refreshIncoming из tabel-v2/workspace.mjs):
    // открытый select не захлопывается, выбор не сбрасывается.
    if(registrationRoleHoldActive()){scheduleRenderRegistrationRequests();return;}
    const savedRoles=saveRoleSelections(list);
    const count=document.getElementById('pendingCount');if(count)count.textContent=list.length;
    const messages=Object.entries(requestSyncStatus.errors).map(([source,error])=>source+': '+error);
    container.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px"><strong>Заявки на регистрацию · '+list.length+'</strong><button class="btn btn-secondary btn-small" id="refreshRegistrationRequestsBtn">Обновить заявки</button></div>'
      +(messages.length?'<div style="padding:10px;margin-bottom:12px;color:var(--warning);font-size:12px">Не удалось полностью загрузить заявки: '+escapeHtml(messages.join('; '))+'</div>':'')
      +(list.length?list.map(r=>`<div class="user-row"><div class="user-row-top"><div><strong>${escapeHtml(r.email)}</strong><div style="font-size:12px;color:var(--muted)">${escapeHtml(r.nickname||'')}</div></div><div class="pending-badge">Ожидает</div></div><div class="user-row-bottom"><select id="req_role_${escapeHtml(r.id)}" class="form-control" style="padding:6px;font-size:12px">${Object.keys(ROLES).map(role=>`<option value="${role}" ${role==='viewer'?'selected':''}>${escapeHtml(ROLES[role].label)}</option>`).join('')}</select><button class="btn btn-quick btn-small" data-approve-request="${escapeHtml(r.id)}">Подтвердить</button><button class="btn btn-secondary btn-small" data-reject-request="${escapeHtml(r.id)}">Отклонить</button></div></div>`).join(''):'<div class="empty-state">'+(requestSyncStatus.requests&&requestSyncStatus.users&&!messages.length?'Нет заявок':messages.length?'Проверьте доступ к базе и нажмите «Обновить заявки»':'Загружаем заявки и ожидающие учётки…')+'</div>');
    restoreRoleSelections(list,savedRoles);
    container.querySelector('#refreshRegistrationRequestsBtn').onclick=()=>refreshRegistrationRequests();
    container.querySelectorAll('[data-approve-request]').forEach(b=>b.onclick=()=>approveRequest(b.dataset.approveRequest));
    container.querySelectorAll('[data-reject-request]').forEach(b=>b.onclick=()=>rejectRequest(b.dataset.rejectRequest));
    updateAdminBadge();
  }
  function acceptRegistrationSnapshot(source,snapshot) {
    if(!canAdmin())return;
    const records=snapshot.docs.map(d=>({...d.data(),id:d.id}));
    if(source==='users'){state.users=records;}else state.requests=records;
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
    if(isNasRuntime()){try{return await refreshNasAdministration();}catch(error){registrationSyncError('nas-admin',error);return;}}
    if(!canAdmin()||refreshingRegistrationRequests)return;
    refreshingRegistrationRequests=true;
    try {
      const sources=['requests','users'];
      const results=await Promise.allSettled([requestsRef.get({source:'server'}),usersRef.get({source:'server'})]);
      results.forEach((result,index)=>{if(result.status==='fulfilled')acceptRegistrationSnapshot(sources[index],result.value);else registrationSyncError(sources[index],result.reason);});
    }finally{refreshingRegistrationRequests=false;}
  }
  function startAdminSync() {
    if(isNasRuntime()){if(canAdmin())void refreshNasAdministration().catch(error=>reportSyncError('nas-admin',error));return;}
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
  let pluginDisposers = [];
  function retiredTabelPlugin(p){return p.id==='builtin-tabel'||(/табель/i.test(p.name||'')&&/1\.1\.0-test\.3/.test((p.version||'')+' '+(p.code||'')));}
  function getPluginRecords() {
    const bundled = firebaseConfig.projectId === 'samosval-working-test-offline' ? (window.SamosvalBundledPlugins || []) : [];
    const ids = new Set(bundled.map(p => p.id));
    return [...bundled.map(p => ({...p, ...(state.plugins.find(x => x.id === p.id) || {}), bundled: true})),
      ...state.plugins.filter(p => !ids.has(p.id))].filter(p=>!retiredTabelPlugin(p));
  }
  function initPlugins() {
    const activePlugin = Object.keys(pluginTabs).find(id => pluginTabs[id].container.classList.contains('active'));
    pluginDisposers.splice(0).forEach(dispose => { try { Promise.resolve(dispose()).catch(console.error); } catch(e) { console.error(e); } });
    document.getElementById('plugin-tabs-container').innerHTML = '';
    document.querySelectorAll('.dynamic-nav-btn').forEach(el => el.remove());
    pluginTabs = {}; pluginPdfButtons = [];
    const enabled = getPluginRecords().filter(p => { if (p.removed || !p.enabled) return false; if (!p.allowedRoles || p.allowedRoles.length === 0) return true; return p.allowedRoles.includes(currentUserRole); });
    enabled.forEach(p => {
      try {
        const ctx = {
          onDispose: fn => { if (typeof fn === 'function') pluginDisposers.push(fn); },
          ledgerHost: {
            workspace: wsRef,
            session: () => ({projectId: firebaseConfig.projectId, workspaceId: WORKSPACE_ID,
              uid: currentUid, name: getUserName(), role: currentUserRole, status: currentUserStatus,
              tabAccess: permissionsLoaded && currentUserStatus === 'active' && hasTabAccess('timesheet')
                && (!p.allowedRoles || !p.allowedRoles.length || p.allowedRoles.includes(currentUserRole)),
              manage: hasPermission('timesheet_manage'),
              permissions: {view: hasTabAccess('timesheet'), edit: hasPermission('timesheet_edit')}}),
            data: () => ({objects: state.objects, shift: state.shift, trucks: state.trucks,
              statuses: state.truckStatus, logs: state.logs, audit: state.audit, archive: state.archive}),
            transaction: fn => (window.__historyRawTransaction || (typeof db!=='undefined'&&db.runTransaction?db.runTransaction.bind(db):fn=>Promise.reject(new Error('Firebase SDK не загружен'))))(fn),
            serverTimestamp: () => (FIREBASE_SDK_PRESENT && typeof firebase!=='undefined' ? firebase.firestore.FieldValue.serverTimestamp() : {__stubServerTimestamp:true}),
            leave: () => switchTab('line', document.getElementById('nav-line'))
          },
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
    if (activePlugin) {
      const next = pluginTabs[activePlugin] ? activePlugin : 'line';
      switchTab(next, document.getElementById('nav-' + next));
    }
  }
  function renderPluginPdfButtons() {
    const c = document.getElementById('pluginPdfButtonsContainer'); if (!c) return;
    c.innerHTML = '';
    pluginPdfButtons.forEach((p, idx) => {
      const btn = document.createElement('button'); btn.className = 'btn btn-secondary btn-small'; btn.style.flex = '1';
      btn.textContent = `🖼 ${String(p.label).replace(/\bPDF\b/gi, 'PNG')}`;
      btn.onclick = async () => {
        try { showToastEl('⏳ Подготовка PNG...', false); const html = p.generateHtmlFn(); const blob = await generatePNGFromHTML(html); downloadReportPNG(blob, `plugin_${idx}_${Date.now()}.png`); showToastEl('✅ PNG готов', false); }
        catch(e) { showError('Ошибка PNG: ' + e.message); }
      };
      c.appendChild(btn);
    });
  }
  function renderPluginsList() {
    const c = document.getElementById('pluginsListContainer'); if (!c) return;
    const records = getPluginRecords().filter(p => !p.removed);
    const restore = getPluginRecords().filter(p => p.bundled && p.removed).map(p => `<button class="btn btn-secondary" onclick="togglePluginStatus('${p.id}',true)">Восстановить ${escapeHtml(p.name)}</button>`).join('');
    if (!records.length) { c.innerHTML = '<div class="empty-state">Нет добавленных расширений</div>'+restore; return; }
    c.innerHTML = records.map(p => {
      let rolesText = (p.allowedRoles || []).map(r => ROLES[r]?.label || r).join(', ') || 'Все роли';
      return `<div class="user-row" style="border-color: ${p.enabled ? 'var(--success)' : 'var(--border)'};"><div class="user-row-top"><div style="font-size: 16px; font-weight: bold;">${escapeHtml(p.icon || '🧩')} ${escapeHtml(p.name)}${p.bundled ? ' · '+escapeHtml(p.version || '') : ''}</div><label class="toggle-switch" style="transform: scale(0.8); margin: 0;"><input type="checkbox" ${p.enabled ? 'checked' : ''} onchange="togglePluginStatus('${p.id}', this.checked)"><span class="toggle-slider"></span></label></div><div style="font-size: 11px; color: var(--muted); margin-bottom: 8px;">Доступ: ${rolesText}</div><div class="user-row-bottom" style="justify-content: flex-end;"><button class="btn-edit" onclick="openPluginModal('${p.id}')">✏️ Код</button><button class="btn-del" onclick="deletePlugin('${p.id}')">Удалить</button></div></div>`;
    }).join('')+restore;
  }
  function openPluginModal(id) {
    if (!canAdmin()) return;
    const p = id ? getPluginRecords().find(x => x.id === id) : null;
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
    try { if (id) await tfAwait(refs.plugins.doc(id).set({ name, icon, code, allowedRoles }, {merge:true})); else await tfAwait(refs.plugins.add({ name, icon, code, allowedRoles, enabled: true, createdAt: Date.now() })); closePluginModal(); showToastEl('✅ Расширение сохранено', false); }
    catch(e) { showError(e.message); }
  }
  async function togglePluginStatus(id, enabled) { if (!canAdmin()) return; try { await tfAwait(refs.plugins.doc(id).set({ enabled, removed:false }, {merge:true})); } catch(e) { showError(e.message); } }
  async function deletePlugin(id) { if (!canAdmin() || !(await appConfirm('Удалить расширение?'))) return; try { if (getPluginRecords().find(p => p.id === id)?.bundled) await tfAwait(refs.plugins.doc(id).set({ enabled:false, removed:true }, {merge:true})); else await tfAwait(refs.plugins.doc(id).delete()); } catch(e) { showError(e.message); } }

  // === АВТОРИЗАЦИЯ ===
  // Сессией управляет локальный вход Ubuntu (core/05). Firebase Auth больше не
  // решает, кто вошёл: обработчик вызывается с профилем сервера.
  async function wtApplyAuthUser(user) {
    const sessionGeneration = ++authSessionGeneration;
    if (user) {
      const sessionIsCurrent = () => sessionGeneration === authSessionGeneration && currentUid === user.uid;
      stopSync();
      profileServerConfirmed = false;
      permissionsServerConfirmed = false;
      appConfigSyncUid = '';
      permissionsLoaded = false;
      permissionsConfig = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
      document.body.removeAttribute('data-perms-ready');
      currentEmail = user.email || ''; currentUid = user.uid || '';
      currentUserRole = null; currentUserStatus = null; currentUserNickname = ''; activeProfileKey = '';
      initialized = false; confirmedLoadIds.clear();
      syncState = { fromCache:{}, everConnected:{}, docCount:{}, pendingWrites:{}, lastSuccessAt:0, errors:{} };
      state = { trucks:[], objects:[], logs:[], truckStatus:{}, shift:null, archive:[], trash:[], audit:[], notifications:[], users:[], requests:[], plugins:[], patches:[] };
      loadCache(); offlineRemoteStatuses={...state.truckStatus};offlineRemoteLogs=state.logs.slice();offlineProjectState(); renderAll();
      document.getElementById('userBadgeLabel').textContent = '👤 Проверка учётной записи…';
      // 1.7.11: страховка от вечного «Проверка учётной записи…». Если за 45
      // секунд проверка не завершилась (роль не установлена и NAS-клиент не
      // создан), показываем понятную ошибку вместо молчаливого спиннера.
      if (wtAuthCheckTimer) { clearTimeout(wtAuthCheckTimer); }
      wtAuthCheckTimer = setTimeout(() => {
        wtAuthCheckTimer = null;
        if (sessionGeneration !== authSessionGeneration) return; // сессия уже сменилась
        if (currentUserRole || currentUserStatus || nasRuntimeClient) return; // проверка завершилась
        const badge = document.getElementById('userBadgeLabel');
        if (badge) badge.textContent = '👤 Не удалось проверить учётную запись';
        const detail = wtAuthCheckLastError ? (wtAuthCheckLastError.message || String(wtAuthCheckLastError)) : 'нет данных';
        console.error('working-test: проверка учётной записи не завершилась за 45 с; последняя ошибка:', wtAuthCheckLastError || detail);
        try { showToastEl('👤 Не удалось проверить учётную запись. Обновите страницу или войдите заново', true); } catch (_) {}
      }, 45000);
      updateSyncUI();
      document.getElementById('authOverlay').style.display = 'none';
      // Общий режим данных хранится в документе Firebase. После перехода на
      // локальный вход Firebase-сессии нет, поэтому документ не читаем: иначе
      // пользователь увидел бы ложную ошибку доступа.
      if (auth && auth.currentUser) {
        await ensureWorkingAuthority();
        try { watchWorkingAuthority(); } catch (_) {}
      }
      if(isNasRuntime()){if(userDocUnsubscriber){userDocUnsubscriber();userDocUnsubscriber=null;}await startNasRuntime(user);return;}
      const forced = isForcedAdminEmail(currentEmail); const defaultNick = sanitizeName(currentEmail);
      if (userDocUnsubscriber) userDocUnsubscriber();
      userDocUnsubscriber = usersRef.doc(currentUid).onSnapshot({ includeMetadataChanges:true }, async snap => {
        try {
        if (!sessionIsCurrent()) return;
        if (currentUid !== user.uid) return;
        markSync('profile', snap.metadata.fromCache, snap.metadata.hasPendingWrites, snap.exists ? 1 : 0);
        if (!snap.exists && snap.metadata.fromCache) { updateSyncUI(); return; }
        if (!snap.exists) {
          if (forced) { await usersRef.doc(currentUid).set({ email: currentEmail, nickname: defaultNick, role: 'admin', status: 'active', createdAt: Date.now(), bootstrap: true }); if (!sessionIsCurrent()) return; }
          else { await ensurePendingAccount(user); if (!sessionIsCurrent()) return; return; }
        }
        const data = snap.exists ? snap.data() : {};
        currentUserRole = data.role || (forced ? 'admin' : 'viewer');
        currentUserStatus = data.status || (forced ? 'active' : 'pending');
        currentUserNickname = data.nickname || defaultNick;
        if (snap.exists && !data.nickname && defaultNick && !forced) { usersRef.doc(currentUid).set({ nickname: defaultNick }, { merge: true }).catch(()=>{}); currentUserNickname = defaultNick; }
        if (forced && (currentUserRole !== 'admin' || currentUserStatus !== 'active')) { await usersRef.doc(currentUid).set({ role: 'admin', status: 'active', nickname: currentUserNickname || defaultNick }, { merge: true }); currentUserRole = 'admin'; currentUserStatus = 'active'; }
        if (currentUserStatus === 'pending') {
          try { await ensurePendingAccount(user); if (!sessionIsCurrent()) return; document.getElementById('registrationStatusText').textContent='Ваша заявка отправлена. Ожидайте решения администратора.'; }
          catch(e) { if (!sessionIsCurrent()) return; document.getElementById('registrationStatusText').textContent='Заявка не отправлена: ' + (e.message || e.code) + '. Обратитесь к администратору.'; }
          if (!sessionIsCurrent()) return;
          activeProfileKey = ''; profileServerConfirmed = false; permissionsServerConfirmed = false; appConfigSyncUid = ''; stopSync(); document.getElementById('pendingScreen').style.display = 'flex'; document.getElementById('disabledScreen').style.display = 'none'; document.getElementById('mainHeader').style.display = 'none'; document.querySelector('.container').style.display = 'none'; document.querySelector('nav').style.display = 'none'; return; }
        if (currentUserStatus === 'disabled') {
          permissionsLoaded=false; profileServerConfirmed = false; permissionsServerConfirmed = false; appConfigSyncUid = ''; document.body.removeAttribute('data-perms-ready');
          cancelHold();document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelectorAll('.modal.open').forEach(d=>d.classList.remove('open'));
          window.__gameAccessChanged?.();
          document.getElementById('disabledStatusTitle').textContent=data.rejectionReason?'Заявка отклонена':'Доступ временно ограничен';
          document.getElementById('disabledStatusText').textContent=data.rejectionReason||'Доступ ограничен администратором. Обратитесь к администратору, чтобы восстановить доступ, или попробуйте войти позже.';
          activeProfileKey='';stopSync();document.getElementById('pendingScreen').style.display='none';document.getElementById('disabledScreen').style.display='flex';document.getElementById('mainHeader').style.display='none';document.querySelector('.container').style.display='none';document.querySelector('nav').style.display='none';return;
        }
        document.getElementById('pendingScreen').style.display = 'none'; document.getElementById('disabledScreen').style.display = 'none'; document.getElementById('mainHeader').style.display = ''; document.querySelector('.container').style.display = ''; document.querySelector('nav').style.display = 'flex';
        updateUserBadge(); updateNavUI(); applyRoleUI(); updateSyncUI();
        // A cached profile is useful for painting the shell, but it is not proof
        // that the restored Firebase session may read appConfig or the workspace.
        // Starting listeners here used to turn the cache-only permission error
        // into a false offline state and left the queue pending.
        if (!snap.metadata.fromCache && snap.exists && currentUserStatus === 'active') profileServerConfirmed = true;
        if (snap.metadata.fromCache) {
          updateSyncUI();
          return;
        }
        const profileKey = currentUid + ':' + currentUserRole + ':' + currentUserStatus;
        if (activeProfileKey === profileKey) return;
        activeProfileKey = profileKey;
        startSync(sessionGeneration); startAdminSync(); startAppConfigSync(sessionGeneration); setTimeout(() => { if (sessionIsCurrent()) runMaxQueue(); }, 1200);
        loadAndApplyPatches().catch(e => { if (sessionIsCurrent()) reportSyncError('patches', e); });
        } catch(e) { reportSyncError('profile', e); }
      }, e => {
        if (!sessionIsCurrent()) return;
        stopSync(); permissionsLoaded = false; currentUserRole = null; activeProfileKey = '';
        document.body.removeAttribute('data-perms-ready');
        document.getElementById('userBadgeLabel').textContent = '👤 Учётная запись не загружена';
        reportSyncError('profile', e);
        renderAll();
      });
    } else {
      currentEmail = ''; currentUid = ''; currentUserRole = null; currentUserStatus = null; currentUserNickname = '';
      profileServerConfirmed = false; permissionsServerConfirmed = false; appConfigSyncUid = ''; appConfigSyncGeneration = 0;
      permissionsLoaded = false;
      document.body.removeAttribute('data-perms-ready');
      if (userDocUnsubscriber) { userDocUnsubscriber(); userDocUnsubscriber = null; }
      stopSync(); initialized = false; pendingOps = 0; confirmedLoadIds.clear();
      syncState = { fromCache: {}, everConnected: {}, docCount: {}, pendingWrites: {}, lastSuccessAt: 0 };
      state = { trucks:[], objects:[], logs:[], truckStatus:{}, shift:null, archive:[], trash:[], audit:[], notifications:[], users:[], requests:[], plugins:[], patches:[] };
      // Единая точка показа экранов входа/ожидания/блокировки (core/05):
      // порядок вызовов больше не может оставить рабочую шапку видимой.
      wtShowAuthScreens('signed-out');
      document.getElementById('userBadgeLabel').textContent = '👤 Войти'; updateSyncUI();
      // Firebase Auth сам восстанавливает сессию; пароль в браузере не храним.
      const savedEmail = localStorage.getItem('working-test-saved-email');
      if (savedEmail) document.getElementById('authEmail').value = savedEmail;
      document.getElementById('authPassword').value = '';
    }
  }

  function updateUserBadge() { const badge = document.getElementById('userBadgeLabel'); if (!badge) return; const roleInfo = ROLES[currentUserRole] || ROLES.viewer; const chip = `<span class="role-chip ${roleInfo.color}">${roleInfo.icon} ${roleInfo.label}</span>`; badge.innerHTML = `👤 ${escapeHtml(getUserName())} ${chip}`; }
  function applyRoleUI() {
    startTabelBackground();
    const versionAllowed = permissionsLoaded && canAdmin();
    if (versionAllowed) document.body.setAttribute('data-release-admin', '1'); else document.body.removeAttribute('data-release-admin');
    const historyAllowed=canViewReleaseHistory();document.body.toggleAttribute('data-release-history',historyAllowed);
    const releaseButton=document.querySelector('#mainHeader .version-text');if(releaseButton){releaseButton.disabled=!historyAllowed;releaseButton.title=historyAllowed?'История изменений':'Номер сборки';}
    if (!historyAllowed) document.getElementById('releaseHistoryDialog')?.close();
    const viewBanner = document.getElementById('viewOnlyBanner'); const canDoAnything = hasPermission('start_shift') || hasPermission('edit_line') || hasPermission('action_load');
    if (viewBanner) viewBanner.style.display = (!canDoAnything && state.shift) ? 'block' : 'none';
    const requestBtn=document.getElementById('tabelCreateRequestBtn');if(requestBtn)requestBtn.style.display=hasTabAccess('timesheet')?'':'none';
    const startBtn = document.getElementById('startShiftBtn'); if (startBtn) startBtn.style.display = hasPermission('start_shift') ? '' : 'none';
    const truckForm = document.getElementById('truckFormCard'); if (truckForm) truckForm.style.display = hasPermission('manage_trucks') ? '' : 'none';
    const objectForm = document.getElementById('objectFormCard'); if (objectForm) objectForm.style.display = hasPermission('manage_objects') ? '' : 'none';
    const changeObjBtn = document.getElementById('changeObjBtn'); if (changeObjBtn) changeObjBtn.style.display = hasPermission('edit_line') ? 'inline-block' : 'none';
    const headerExtra = document.getElementById('headerExtraContent'); if (headerExtra) headerExtra.style.display = hasPermission('view_header') ? '' : 'none';
    const gaiToggleContainer = document.getElementById('gaiReportToggleContainer');
    if (gaiToggleContainer) { const canGai = hasPermission('view_gai_report'); gaiToggleContainer.style.display = canGai ? 'flex' : 'none'; if (!canGai) showGAITable = false; }
  }
  // === ВХОД ЧЕРЕЗ UBUNTU API ===
  // Пароль, сессии и заявки проверяет сервер Ubuntu. Firebase SDK остаётся
  // подключённым для данных, но не используется для входа, ролей и заявок.
  const WT_AUTH_ACCESS_KEY = 'wt_access_token';
  const WT_AUTH_REFRESH_KEY = 'wt_refresh_token';
  const WT_AUTH_PROFILE_KEY = 'wt_user_profile';
  const WT_AUTH_EMAIL_KEY = 'working-test-saved-email';
  const WT_AUTH_REFRESH_MARGIN_MS = 120000;
  const WT_AUTH_ERRORS = {
    'invalid-credentials': 'Неверная почта или пароль.',
    'identity-email-required': 'Проверьте адрес почты.',
    'invalid-email': 'Проверьте адрес почты.',
    'invalid-password': 'Пароль должен быть от 8 до 512 символов, без пробелов по краям.',
    'email-already-exists': 'Этот e-mail уже зарегистрирован. Нажмите «Войти».',
    'invalid-nickname': 'Проверьте имя пользователя.',
    'account-disabled': 'Доступ ограничен администратором. Обратитесь к администратору.',
    'account-deleted': 'Учётная запись удалена. Обратитесь к администратору.',
    'pending-approval': 'Заявка ожидает подтверждения администратора.',
    'invalid-session': 'Сеанс истёк. Войдите снова.',
    'invalid-reset-token': 'Код восстановления недействителен или устарел. Запросите новый.',
    'identity-not-ready': 'Сервер ещё не готов принимать вход. Попробуйте позже.',
    'server-error': 'Сервер временно недоступен. Попробуйте позже.',
    'origin-not-allowed': 'Этот адрес сайта не разрешён сервером.',
    'unsupported-media-type': 'Сервер не принял формат запроса.',
    'invalid-json': 'Сервер не разобрал запрос.',
    'body-too-large': 'Слишком большой запрос.'
  };
  let wtSession = null, wtSessionUser = null, wtRefreshTimer = null, wtRefreshFlight = null;
  let wtSessionHandler = null, wtAuthBusy = false, wtResumeStarted = false;
  let registrationInFlight = false;
  function wtAuthBase() {
    try {
      if (typeof nasApiBase === 'function') {
        const base = nasApiBase();
        if (typeof base === 'string' && base) return base.replace(/\/+$/, '');
      }
    } catch (_) {}
    try {
      const fallback = WORKING_TEST_UBUNTU_API_BASE;
      if (typeof fallback === 'string' && fallback) return fallback.replace(/\/+$/, '');
    } catch (_) {}
    return '';
  }
  function wtAuthMessage(code) {
    return WT_AUTH_ERRORS[code] || 'Не удалось выполнить действие. Проверьте соединение и повторите.';
  }
  // В журнал устройств уходят только признаки устройства: без адресов и токенов.
  function wtDeviceInfo() {
    const info = {};
    try { if (navigator.userAgent) info.userAgent = String(navigator.userAgent).slice(0, 200); } catch (_) {}
    try { if (navigator.platform) info.platform = String(navigator.platform).slice(0, 200); } catch (_) {}
    return info;
  }
  async function wtAuthRequest(path, body, options) {
    const base = wtAuthBase();
    if (!base) throw Object.assign(Error('Не настроен адрес сервера Ubuntu.'), { code: 'no-api-base' });
    const headers = {};
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const token = options && options.accessToken;
    if (token) headers.Authorization = 'Bearer ' + token;
    let response;
    try {
      response = await fetch(base + path, Object.assign({ method: 'POST', headers, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' }, payload !== undefined ? { body: payload } : {}));
    } catch (_) {
      throw Object.assign(Error('Нет связи с сервером Ubuntu. Проверьте интернет и повторите.'), { code: 'network' });
    }
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      const code = data && typeof data.error === 'string' ? data.error : 'http-' + response.status;
      throw Object.assign(Error(wtAuthMessage(code)), { code, status: response.status });
    }
    if (!data || typeof data !== 'object') throw Object.assign(Error('Сервер ответил неожиданно. Повторите действие.'), { code: 'invalid-response' });
    return data;
  }
  function wtValidProfile(profile) {
    return !!profile && typeof profile === 'object' && typeof profile.uid === 'string' && profile.uid.length > 0 && profile.uid.length <= 128;
  }
  function wtCacheProfile(profile) {
    if (!wtValidProfile(profile)) return null;
    try { localStorage.setItem(WT_AUTH_PROFILE_KEY, JSON.stringify(profile)); } catch (_) {}
    return profile;
  }
  function wtStoredProfile() {
    try {
      const raw = localStorage.getItem(WT_AUTH_PROFILE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return wtValidProfile(parsed) ? parsed : null;
    } catch (_) { return null; }
  }
  function wtStoredRefreshToken() {
    try { const value = localStorage.getItem(WT_AUTH_REFRESH_KEY); return typeof value === 'string' ? value : ''; } catch (_) { return ''; }
  }
  function wtAccessToken() { return wtSession ? wtSession.accessToken : ''; }
  // Тот же объект-владелец нужен клиенту данных Ubuntu: подпись сессии одна.
  function wtAuthUser() {
    if (!wtSession || !wtValidProfile(wtSession.profile)) return null;
    const profile = wtSession.profile;
    if (wtSessionUser && wtSessionUser.uid === profile.uid) return wtSessionUser;
    wtSessionUser = {
      uid: profile.uid,
      email: profile.email || '',
      displayName: profile.nickname || '',
      localSession: true,
      getIdToken: async force => {
        if (!wtSession || wtSession.profile.uid !== profile.uid) return '';
        if (force === true || wtTokenExpiring()) { try { await wtRefreshSession(); } catch (_) {} }
        return wtSession && wtSession.profile.uid === profile.uid ? wtSession.accessToken : '';
      }
    };
    return wtSessionUser;
  }
  function wtTokenExpiring() {
    const expiresAt = wtSession ? Number(wtSession.expiresAt) || 0 : 0;
    return !expiresAt || expiresAt - Date.now() <= WT_AUTH_REFRESH_MARGIN_MS;
  }
  function wtStoreSession(data) {
    const profile = wtValidProfile(data && data.profile) ? data.profile : null;
    if (!profile) throw Object.assign(Error('Сервер не вернул профиль пользователя.'), { code: 'invalid-profile' });
    const accessToken = data && typeof data.accessToken === 'string' ? data.accessToken : '';
    const refreshToken = data && typeof data.refreshToken === 'string' ? data.refreshToken : '';
    if (!accessToken || !refreshToken) throw Object.assign(Error('Сервер не выдал токены сеанса.'), { code: 'invalid-session' });
    const session = { profile, accessToken, refreshToken, expiresAt: Number(data.expiresAt) || 0 };
    // Объект-владелец живёт, пока жив uid: продление сеанса (refresh) не должно
    // пересоздавать его, иначе клиент данных увидит «смену сессии» после простоя.
    if (!wtSessionUser || wtSessionUser.uid !== profile.uid) wtSessionUser = null;
    wtSession = session;
    try {
      localStorage.setItem(WT_AUTH_ACCESS_KEY, accessToken);
      localStorage.setItem(WT_AUTH_REFRESH_KEY, refreshToken);
      localStorage.setItem(WT_AUTH_PROFILE_KEY, JSON.stringify(profile));
    } catch (_) {}
    wtScheduleRefresh();
    return wtSession;
  }
  function wtClearSession() {
    wtSession = null; wtSessionUser = null;
    if (wtRefreshTimer) { try { clearTimeout(wtRefreshTimer); } catch (_) {} wtRefreshTimer = null; }
    try {
      localStorage.removeItem(WT_AUTH_ACCESS_KEY);
      localStorage.removeItem(WT_AUTH_REFRESH_KEY);
      localStorage.removeItem(WT_AUTH_PROFILE_KEY);
    } catch (_) {}
  }
  function wtScheduleRefresh() {
    if (wtRefreshTimer) { try { clearTimeout(wtRefreshTimer); } catch (_) {} wtRefreshTimer = null; }
    const expiresAt = wtSession ? Number(wtSession.expiresAt) || 0 : 0;
    if (!expiresAt || typeof setTimeout !== 'function') return;
    const delay = Math.max(5000, expiresAt - Date.now() - WT_AUTH_REFRESH_MARGIN_MS);
    wtRefreshTimer = setTimeout(() => { wtRefreshSession().catch(() => {}); }, delay);
  }
  // Продление сеанса. Ошибка означает конец сеанса: токены очищаются, экран
  // входа показывается заново. Молча продолжать работу нельзя.
  async function wtRefreshSession() {
    if (wtRefreshFlight) return wtRefreshFlight;
    const refreshToken = wtSession ? wtSession.refreshToken : wtStoredRefreshToken();
    if (!refreshToken) throw Object.assign(Error(wtAuthMessage('invalid-session')), { code: 'invalid-session' });
    const work = (async () => {
      const data = await wtAuthRequest('/api/v1/auth/refresh', { refreshToken, device: wtDeviceInfo() });
      if (!data || data.pending === true || !data.accessToken) throw Object.assign(Error(wtAuthMessage('invalid-session')), { code: 'invalid-session' });
      const session = wtStoreSession(data);
      return session;
    })();
    wtRefreshFlight = work;
    try { return await work; } finally { if (wtRefreshFlight === work) wtRefreshFlight = null; }
  }
  function wtProfileStatus(profile) {
    if (!wtValidProfile(profile)) return 'signed-out';
    if (profile.deleted === true) return 'deleted';
    if (profile.status === 'pending') return 'pending';
    if (profile.status === 'active') return 'active';
    return 'disabled';
  }
  // Статус берётся только из профиля сервера: pending — ожидание, disabled и
  // deleted — блокировка, active — рабочий интерфейс.
  function wtShowAuthScreens(status, profile) {
    const overlay = document.getElementById('authOverlay');
    const pending = document.getElementById('pendingScreen');
    const disabled = document.getElementById('disabledScreen');
    const header = document.getElementById('mainHeader');
    const container = document.querySelector('.container');
    const nav = document.querySelector('nav');
    const isActive = status === 'active';
    if (overlay) overlay.style.display = status === 'signed-out' ? 'flex' : 'none';
    if (pending) pending.style.display = status === 'pending' ? 'flex' : 'none';
    if (disabled) disabled.style.display = status === 'disabled' || status === 'deleted' ? 'flex' : 'none';
    if (header) header.style.display = isActive ? '' : 'none';
    if (container) container.style.display = isActive ? '' : 'none';
    if (nav) nav.style.display = isActive ? 'flex' : 'none';
    if (status === 'pending') {
      const text = document.getElementById('registrationStatusText');
      if (text) text.textContent = 'Учётная запись ожидает подтверждения администратора.';
    }
    if (status === 'disabled' || status === 'deleted') {
      const title = document.getElementById('disabledStatusTitle');
      const text = document.getElementById('disabledStatusText');
      const reason = profile && typeof profile.rejectionReason === 'string' && profile.rejectionReason ? profile.rejectionReason : '';
      if (title) title.textContent = status === 'deleted' ? 'Учётная запись удалена' : 'Доступ временно ограничен';
      if (text) text.textContent = reason || (status === 'deleted'
        ? 'Учётная запись удалена администратором. Обратитесь к администратору.'
        : 'Доступ ограничен администратором. Обратитесь к администратору, чтобы восстановить доступ.');
    }
    if (status === 'signed-out') {
      wtEnsureRecoveryUI();
      try {
        const saved = localStorage.getItem(WT_AUTH_EMAIL_KEY);
        const field = document.getElementById('authEmail');
        if (saved && field && !field.value) field.value = saved;
      } catch (_) {}
    }
  }
  function wtNotifySession(user) {
    // Событие для модулей, которые раньше реагировали на вход Firebase
    // (например, сброс стека отмены/восстановления).
    try { window.dispatchEvent(new CustomEvent('wt-auth-session-changed', { detail: { uid: user && user.uid ? user.uid : null } })); } catch (_) {}
    if (typeof wtSessionHandler !== 'function') return;
    try { wtSessionHandler(user); } catch (error) {
      // 1.7.11: ошибка обработчика сессии роняла wtApplyAuthUser до запуска
      // NAS-рантайма — UI навсегда оставался на «Проверка учётной записи…».
      // Выводим её в консоль и сохраняем для страховочного таймера (04-subscriptions).
      console.error('working-test: ошибка обработчика сессии (wtSessionHandler):', error);
      if (typeof wtAuthCheckLastError !== 'undefined') { try { wtAuthCheckLastError = error; } catch (_) {} }
      if (typeof reportSyncError === 'function') reportSyncError('auth', error);
    }
  }
  function wtApplyLocalSession(profile) {
    const status = wtProfileStatus(profile);
    if (status === 'active') {
      wtShowAuthScreens('active', profile);
      wtNotifySession(wtAuthUser());
      return;
    }
    // Сначала сбрасываем состояние прошлого пользователя, затем показываем экран
    // ожидания или блокировки: рабочие данные остаются недоступны.
    wtNotifySession(null);
    wtShowAuthScreens(status, profile);
  }
  function wtSetSessionHandler(handler) {
    wtSessionHandler = typeof handler === 'function' ? handler : null;
    wtResumeStoredSession();
  }
  // Автовход: продлеваем сохранённый сеанс. Любая ошибка очищает токены и
  // возвращает экран входа — приложение не остаётся в подвешенном состоянии.
  function wtResumeStoredSession() {
    if (wtResumeStarted) return; wtResumeStarted = true;
    const refreshToken = wtStoredRefreshToken();
    const stored = wtStoredProfile();
    if (!refreshToken) { wtShowAuthScreens('signed-out'); wtNotifySession(null); return; }
    if (stored) wtShowAuthScreens(wtProfileStatus(stored), stored);
    wtRefreshSession().then(session => {
      wtApplyLocalSession(session.profile);
    }).catch(() => {
      wtClearSession();
      wtShowAuthScreens('signed-out');
      wtNotifySession(null);
    });
  }
  function wtAuthError(element, text, isError) {
    if (!element) return;
    element.style.color = isError ? 'var(--danger)' : 'var(--text)';
    element.textContent = text || '';
  }
  async function handleLogin() {
    if (wtAuthBusy) return;
    const emailField = document.getElementById('authEmail');
    const passwordField = document.getElementById('authPassword');
    const error = document.getElementById('authError');
    const email = emailField ? emailField.value.trim() : '';
    const password = passwordField ? passwordField.value : '';
    if (!email || !password) { wtAuthError(error, 'Укажите почту и пароль.', true); return; }
    wtAuthBusy = true;
    wtAuthError(error, '⏳ Вход...', false);
    try {
      const data = await wtAuthRequest('/api/v1/auth/login', { email, password, device: wtDeviceInfo() });
      if (passwordField) passwordField.value = '';
      try { localStorage.setItem(WT_AUTH_EMAIL_KEY, email); } catch (_) {}
      if (data && data.pending === true) {
        const profile = wtCacheProfile(data.profile);
        wtAuthError(error, '', false);
        wtApplyLocalSession(profile);
        return;
      }
      const session = wtStoreSession(data);
      wtAuthError(error, '', false);
      wtApplyLocalSession(session.profile);
    } catch (failure) {
      wtAuthError(error, failure.message || wtAuthMessage(failure.code), true);
    } finally { wtAuthBusy = false; }
  }
  // Заявку создаёт сервер при регистрации: повторная запись в Firebase не нужна.
  async function ensurePendingAccount() { return null; }
  async function handleRegister() {
    if (registrationInFlight) return;
    const emailField = document.getElementById('authEmail');
    const passwordField = document.getElementById('authPassword');
    const error = document.getElementById('authError');
    const email = emailField ? emailField.value.trim() : '';
    const password = passwordField ? passwordField.value : '';
    if (!email || !password) { wtAuthError(error, 'Введите e-mail и пароль.', true); return; }
    if (password.length < 8) { wtAuthError(error, 'Пароль должен быть не короче 8 символов.', true); return; }
    registrationInFlight = true;
    const button = document.getElementById('registerBtn');
    if (button) button.disabled = true;
    wtAuthError(error, 'Создаём заявку…', false);
    try {
      const data = await wtAuthRequest('/api/v1/auth/register', { email, password, device: wtDeviceInfo() });
      if (passwordField) passwordField.value = '';
      if (data && (data.pending === true || !data.accessToken)) {
        const text = 'Заявка отправлена. Ожидайте подтверждения администратора.';
        wtAuthError(error, text, false);
        const status = document.getElementById('registrationStatusText');
        if (status) status.textContent = text;
        wtApplyLocalSession(wtCacheProfile(data.profile));
        return;
      }
      const session = wtStoreSession(data);
      wtAuthError(error, '', false);
      wtApplyLocalSession(session.profile);
    } catch (failure) {
      wtAuthError(error, failure.message || wtAuthMessage(failure.code), true);
    } finally {
      if (passwordField) passwordField.value = '';
      registrationInFlight = false;
      if (button) button.disabled = false;
    }
  }
  async function handleLogout() {
    if (!(await appConfirm('Выйти?'))) return;
    const refreshToken = wtSession ? wtSession.refreshToken : wtStoredRefreshToken();
    try { if (typeof isNasRuntime === 'function' && isNasRuntime()) await leaveNasPresence(); } catch (_) {}
    // Сессию на сервере отзываем, но локальный выход выполняем в любом случае.
    if (refreshToken) { try { await wtAuthRequest('/api/v1/auth/logout', { refreshToken }); } catch (_) {} }
    wtClearSession();
    try { localStorage.removeItem(WT_AUTH_EMAIL_KEY); } catch (_) {}
    wtNotifySession(null);
    wtShowAuthScreens('signed-out');
    // Перезагрузка только после очистки токенов и экранов: если она не
    // выполнится, приложение всё равно останется на экране входа, а не
    // вернётся в прежнюю сессию.
    location.reload();
  }
  // === ВОССТАНОВЛЕНИЕ ПАРОЛЯ ===
  // Экран входа не переписывается: блок восстановления создаётся рядом с полями
  // и показывается только по кнопке «Забыли пароль?».
  function wtEnsureRecoveryUI() {
    const card = document.querySelector('#authOverlay .auth-card');
    if (!card || document.getElementById('wtRecoveryBlock')) return;
    const block = document.createElement('div');
    block.id = 'wtRecoveryBlock';
    block.style.display = 'none';
    block.innerHTML = '<div id="wtRecoveryStep1"><button type="button" class="btn btn-secondary" style="width:100%;margin-top:10px;" onclick="handleForgotPassword()">Забыли пароль?</button></div>'
      + '<div id="wtRecoveryStep2" style="display:none;margin-top:10px;">'
      + '<div class="form-group"><label>Код восстановления</label><input type="text" id="wtResetToken" class="form-control" autocomplete="one-time-code" placeholder="Код от администратора"></div>'
      + '<div class="form-group"><label>Новый пароль</label><input type="password" id="wtResetPassword" class="form-control" autocomplete="new-password" placeholder="Не короче 8 символов"></div>'
      + '<div style="display:flex;gap:8px;"><button type="button" class="btn btn-quick" style="flex:1;" onclick="handleResetPassword()">Сменить пароль</button>'
      + '<button type="button" class="btn btn-secondary" style="flex:1;" onclick="wtHidePasswordRecovery()">Отмена</button></div></div>';
    card.append(block);
  }
  function wtShowPasswordRecovery() {
    wtEnsureRecoveryUI();
    const block = document.getElementById('wtRecoveryBlock');
    const step2 = document.getElementById('wtRecoveryStep2');
    if (block) block.style.display = '';
    if (step2) step2.style.display = '';
  }
  function wtHidePasswordRecovery() {
    const block = document.getElementById('wtRecoveryBlock');
    const step2 = document.getElementById('wtRecoveryStep2');
    const token = document.getElementById('wtResetToken');
    const password = document.getElementById('wtResetPassword');
    if (step2) step2.style.display = 'none';
    if (token) token.value = '';
    if (password) password.value = '';
    wtAuthError(document.getElementById('authError'), '', false);
    if (block) block.style.display = 'none';
  }
  async function handleForgotPassword() {
    const emailField = document.getElementById('authEmail');
    const error = document.getElementById('authError');
    const email = emailField ? emailField.value.trim() : '';
    if (!email) { wtAuthError(error, 'Сначала укажите почту в поле Email.', true); return; }
    try {
      const data = await wtAuthRequest('/api/v1/auth/forgot', { email });
      wtAuthError(error, (data && typeof data.message === 'string' && data.message) ? data.message : 'Если учётная запись с такой почтой существует, восстановление подготовлено.', false);
      wtShowPasswordRecovery();
    } catch (failure) {
      wtAuthError(error, failure.message || wtAuthMessage(failure.code), true);
    }
  }
  async function handleResetPassword() {
    const tokenField = document.getElementById('wtResetToken');
    const passwordField = document.getElementById('wtResetPassword');
    const error = document.getElementById('authError');
    const token = tokenField ? tokenField.value.trim() : '';
    const newPassword = passwordField ? passwordField.value : '';
    if (!token) { wtAuthError(error, 'Введите код восстановления.', true); return; }
    if (!newPassword || newPassword.length < 8) { wtAuthError(error, 'Новый пароль должен быть не короче 8 символов.', true); return; }
    try {
      await wtAuthRequest('/api/v1/auth/reset', { token, newPassword });
      wtAuthError(error, 'Пароль изменён. Войдите с новым паролем.', false);
      wtHidePasswordRecovery();
      const loginPassword = document.getElementById('authPassword');
      if (loginPassword) loginPassword.value = '';
    } catch (failure) {
      wtAuthError(error, failure.message || wtAuthMessage(failure.code), true);
    }
  }

  // === АДМИН ===
  function switchAdminTab(tab, btn) {
    document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    if(btn) btn.classList.add('active');
    document.getElementById('admin-sub-' + tab).classList.add('active');
    if (tab === 'server') openServerControl();
    if (tab === 'permissions') renderPermissionsMatrix();
    if (tab === 'requests' || tab === 'users') renderAdminPanel();
    if (tab === 'requests') refreshRegistrationRequests();
    if (tab === 'plugins') renderPluginsList();
    if (tab === 'console') renderConsole();
    if (tab === 'appsettings') renderAppSettingsIfActive();
  }

  // Регистрация обработчика откладывается до конца загрузки документа:
  // переменные последующих модулей (например, core/15) к этому моменту
  // инициализированы, и восстановление сеанса не попадает в их TDZ.
  function wtRegisterSessionHandler() { wtSetSessionHandler(wtApplyAuthUser); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wtRegisterSessionHandler, { once: true });
  } else {
    setTimeout(wtRegisterSessionHandler, 0);
  }
  function renderAppSettingsIfActive() {
    renderTestBackendControls();
    if (!document.getElementById('tab-admin')?.classList.contains('active')) return;
    if (!document.getElementById('admin-sub-appsettings')?.classList.contains('active')) return;
    const cycle=document.getElementById('adminCycleMinutes');if(cycle&&!cycle.disabled&&document.activeElement!==cycle)cycle.value=Math.max(MIN_CYCLE_MINUTES,settings.cycleMinutes||MIN_CYCLE_MINUTES);
    ['MaxEnabled','NotifyStart','NotifyArrive','NotifyLoad','NotifyTtn','NotifyLineStart','NotifyLineEnd'].forEach(k => { let el = document.getElementById('appConfig' + k); if (el) { let configKey = k.charAt(0).toLowerCase() + k.slice(1); el.checked = !!appConfig[configKey]; } });
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
      notifyLineEnd: !!document.getElementById('appConfigNotifyLineEnd')?.checked
    };
    try { await saveLineEvent(()=>nasSaveSettings(data)); showToastEl('Настройки сохранены на Ubuntu',false); } catch(e) { showError(e.message); }
  }

  // === MAX QUEUE ===
  const MAX_QUEUE_KEY = 'wt_max_queue_test347'; const MAX_QUEUE_MAX = 100; const MAX_TRIES = 5;
  let maxQueue = []; let maxSenderRunning = false; let maxSeq = 0; let maxLastError = '';
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function loadMaxQueue() {
    try { maxQueue=JSON.parse(localStorage.getItem(MAX_QUEUE_KEY)||'[]'); } catch(e) { maxQueue=[]; }
    maxQueue=(Array.isArray(maxQueue)?maxQueue:[]).filter(item=>item&&item.type==='text'&&typeof item.text==='string');
    saveMaxQueue();
  }
  function saveMaxQueue() { try { localStorage.setItem(MAX_QUEUE_KEY, JSON.stringify(maxQueue)); } catch(e) { if (e.name === 'QuotaExceededError' || e.code === 22) { while (maxQueue.length > 0) { const idx = maxQueue.findIndex(q => q.type === 'document'); if (idx === -1) maxQueue.shift(); else maxQueue.splice(idx, 1); try { localStorage.setItem(MAX_QUEUE_KEY, JSON.stringify(maxQueue)); return; } catch(e2) {} } } } }
  function enqueueMax(text, meta, notBefore) { if(isNasRuntime())return; if (!appConfig.maxEnabled || !appConfig.maxUrl) return; maxQueue.push({ id: 'q_' + Date.now() + '_' + (++maxSeq), type: 'text', text, tries: 0, createdAt: Date.now(), notBefore: notBefore || 0, meta: meta || null }); while (maxQueue.length > MAX_QUEUE_MAX) maxQueue.shift(); saveMaxQueue(); runMaxQueue(); }
  async function sendMaxOnce(item) {
    if (!item || item.type !== 'text') return 'drop';
    if (!appConfig.maxEnabled || !appConfig.maxUrl) return 'drop';
    let headers = { 'Content-Type': 'application/json' };
    if (appConfig.maxToken) { let tk = String(appConfig.maxToken).trim(); headers['Authorization'] = tk.startsWith('Bearer ') ? tk : 'Bearer ' + tk; }
    let body = { chat_id: appConfig.maxChatId || '', text: item.text };
    let ctrl = new AbortController(); let timer = setTimeout(() => ctrl.abort(), 30000);
    try { let resp = await fetch(appConfig.maxUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal, keepalive: true }); clearTimeout(timer); if (resp.ok) return 'ok'; if (resp.status === 413) return 'too_large'; if (resp.status === 429) return 'retry'; if (resp.status >= 500) return 'retry'; if (resp.status === 401 || resp.status === 403) return 'auth'; return 'http_' + resp.status; }
    catch (e) { clearTimeout(timer); return 'network'; }
  }
  async function runMaxQueue() {
    if(isNasRuntime())return;
    if (currentUserStatus!=='active'||maxSenderRunning || !appConfig.maxEnabled || !appConfig.maxUrl) return;
    maxSenderRunning = true;
    try {
      while (maxQueue.length&&currentUserStatus==='active') {
        const idx = maxQueue.findIndex(q => !q.notBefore || q.notBefore <= Date.now());
        if (idx === -1) break;
        const item = maxQueue[idx];
        if(!item||item.type!=='text'){maxQueue.splice(idx,1);saveMaxQueue();continue;}
        const res = await sendMaxOnce(item);
        if (res === 'ok') { maxQueue.splice(idx, 1); saveMaxQueue(); await sleep(1200 + Math.floor(Math.random() * 600)); continue; }
        if (res === 'retry' && item.tries < MAX_TRIES) { item.tries++; saveMaxQueue(); await sleep(Math.min(30000, 2000 * Math.pow(2, item.tries))); continue; }
        maxQueue.splice(idx, 1); saveMaxQueue();
        let reason = res === 'auth' ? 'токен (401)' : res === 'too_large' ? 'размер (413)' : res === 'network' ? 'нет связи' : res === 'retry' ? 'лимит (429)' : 'код ' + res;
        maxLastError = reason; showToastEl('⚠️ MAX: не отправлено — ' + reason, true);
      }
    } finally { maxSenderRunning = false; if (maxQueue.length) { const pending = maxQueue.filter(q => q.notBefore && q.notBefore > Date.now()); if (pending.length > 0) setTimeout(runMaxQueue, Math.max(5000, Math.min(...pending.map(q => q.notBefore)) - Date.now())); } }
  }
  async function showMaxQueueStatus() { if(isNasRuntime()){try{const r=await nasRuntimeClient.readNotifications();appNotice('── ОЧЕРЕДЬ MAX · Ubuntu ──\n'+Object.entries(r.counts).map(([k,v])=>k+': '+v).join('\n'));}catch(e){showError(e.message);}return;} let lines = ['── ОЧЕРЕДЬ MAX ──', `Отправка: ${appConfig.maxEnabled ? 'вкл' : 'выкл'}`, `В очереди: ${maxQueue.length}`]; if (maxLastError) lines.push(`Ошибка: ${maxLastError}`); appNotice(lines.join('\n')); }
  async function testMaxMessage() {
    if (!canAdmin()) return;
    if(isNasRuntime()){try{await nasBusinessCommand('notification','test',{type:'notification.test'});showToastEl('✅ Тест поставлен в очередь Ubuntu',false);}catch(e){showError(e.message);}return;}
    if (!appConfig.maxEnabled || !appConfig.maxUrl || !appConfig.maxChatId) { showError('Заполните URL, токен и Chat ID'); return; }
    showToastEl('⏳ Отправка теста...', false);
    let res = await sendMaxOnce({ type: 'text', text: '🧪 Тест\nПриложение «Учет самосвалов» подключено к Max.' });
    if (res === 'ok') showToastEl('✅ Сообщение отправлено', false); else showError('Ошибка: ' + res);
  }

  // === ОТЧЁТЫ PNG ===
  function blobToBase64(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); }); }
  async function generatePNGFromHTML(innerHtml) {
    const deadline = (task, ms, message) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      Promise.resolve(task).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    try { if (document.fonts && document.fonts.load) await deadline(Promise.all([document.fonts.load('700 18px Caveat'), document.fonts.load('400 18px Caveat'), document.fonts.ready]), 2000, 'Шрифт недоступен'); } catch(e) {}
    const wrapper = document.createElement('div'); wrapper.style.cssText = 'position:fixed;left:-99999px;top:0;width:1400px;background:#fdfdfd;padding:10px;z-index:-1;';
    const inner = document.createElement('div'); inner.className = 'paper-report-container'; inner.style.cssText = 'zoom:1;background:#fdfdfd;width:1400px;'; inner.innerHTML = innerHtml;
    wrapper.appendChild(inner); document.body.appendChild(wrapper);
    let worker;
    try {
      const width = Math.max(1400, inner.scrollWidth), height = Math.max(1, inner.scrollHeight);
      const scale = Math.min(2, Math.sqrt(16000000 / (width * height)), 16384 / Math.max(width, height));
      // Reuse the bundled rasterizer only: no PDF pages, A4 clipping or JPEG conversion.
      worker = html2pdf().set({ margin: 0, pagebreak: { mode: [], before: [], after: [], avoid: [] }, html2canvas: { scale, useCORS: true, logging: false, backgroundColor: '#fdfdfd', imageTimeout: 10000 } }).from(inner).toContainer().then(function () {
        this.prop.container.style.width = width + 'px';
        this.prop.container.style.height = 'auto';
        this.prop.container.style.margin = '0';
      });
      const canvas = await deadline(worker.toCanvas().get('canvas'), 45000, 'Не удалось подготовить PNG. Повторите выгрузку отчёта.');
      if (!canvas || !canvas.width || !canvas.height) throw new Error('Получено пустое изображение отчёта');
      return await deadline(new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось сохранить изображение отчёта')), 'image/png')), 15000, 'Сохранение PNG заняло слишком много времени');
    } finally {
      if (worker?.prop?.overlay?.parentNode) worker.prop.overlay.parentNode.removeChild(worker.prop.overlay);
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    }
  }
  function downloadReportPNG(blob, filename) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // === STYLUS ===
  // Ручное рисование отключено; маркер раздела сохранён для проверки PNG.
  // === ОТЧЕТ HTML ===
  function buildReportHTML({ objectName, date, logs, activeLineIds, type, checkTTN, isClosed = false, reportTtnStatus = null }) {
    const filteredLogs = type === 'gai' ? logs.filter(l => l.isGAI) : logs.filter(l => !l.isGAI);
    const activeIds = (activeLineIds || []).filter(id => { const t = findTruck(id); if (!t) return false; return type === 'gai' ? !!t.isGAI : !t.isGAI; });
    const truckIds = new Set(activeIds); filteredLogs.forEach(l => truckIds.add(l.truckId));
    const trucks = Array.from(truckIds).map(id => { const t = findTruck(id); if (t) return t; const ref = filteredLogs.find(l => l.truckId === id); return { id, brand: (ref && ref.truckName) || 'Машина', number: '', defaultVol: 0 }; });
    const firstTime = {}; filteredLogs.forEach(l => { if (firstTime[l.truckId] === undefined || l.timestamp < firstTime[l.truckId]) firstTime[l.truckId] = l.timestamp; });
    trucks.sort((a, b) => ((firstTime[a.id] === undefined) - (firstTime[b.id] === undefined)) || ((firstTime[a.id] || 0) - (firstTime[b.id] || 0)) || String(a.id).localeCompare(String(b.id)));
    let maxTrips = 8; trucks.forEach(t => { const c = filteredLogs.filter(l => l.truckId === t.id).length; if (c > maxTrips) maxTrips = c; });
    const totalVol = filteredLogs.reduce((s, l) => s + l.volume, 0);
    let html = `<div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(objectName || '—')}${type === 'gai' ? ' (ГАИ)' : ''}</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(date || '')}</div><div class="paper-total-info">${type === 'gai' ? `Всего рейсов ГАИ: <b>${filteredLogs.length}</b>` : `Общий объем: <b>${totalVol} м³</b>`}</div></div></div><table class="paper-table"><thead><tr><th>№</th><th style="text-align:left;">Самосвал</th>`;
    for (let i = 1; i <= maxTrips; i++) html += `<th>Рейс ${i}</th>`;
    html += `</tr></thead><tbody>`;
    trucks.forEach((t, idx) => {
      const tLogs = filteredLogs.filter(l => l.truckId === t.id).slice().sort((a,b)=>(Number(a.timestamp)||0)-(Number(b.timestamp)||0) || String(a.id||'').localeCompare(String(b.id||'')));
      const sum = tLogs.reduce((s, l) => s + l.volume, 0);
      let st = state.truckStatus[t.id] || {};
      let savedTtn = reportTtnStatus ? reportTtnStatus[t.id] : st.ttnStatus;
      let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (isClosed && tLogs.length > 0 && savedTtn !== true && savedTtn !== 'pending') : (tLogs.length > 0 && st.ttnStatus !== true);
      let dupHtml = isDup ? ' <span style="color:red; font-size:10px; font-weight:bold;" title="Дубликат" aria-label="Дубликат">D</span>' : '';
      const brandCell = type === 'gai' ? `${escapeHtml(t.brand)} <span class="paper-truck-volume">Рейсов: ${tLogs.length}</span>${dupHtml}` : `${escapeHtml(t.brand)} <span class="paper-truck-volume">${sum} м³ / ${tLogs.length} р</span>${dupHtml}`;
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

  async function exportCurrentReportPNG(type) {
    if (!state.shift) { showError('Смена не начата'); return; }
    if (type === 'gai' && !hasPermission('view_gai_report')) { showError('Нет прав'); return; }
    const logs = getLogs().filter(l => type === 'gai' ? l.isGAI : !l.isGAI);
    if (!logs.length) { showError('Нет данных'); return; }
    try {
      showToastEl('⏳ Подготовка PNG...', false);
      const html = buildReportHTML({ objectName: objectTitle(state.shift.objectId,state.shift.objectName), date: state.shift.startDate, logs, activeLineIds: getActiveLineIds(), type, checkTTN: type === 'regular' ? (id, logId) => state.truckStatus[id] && state.truckStatus[id].ttnStatus === true && state.truckStatus[id].ttnLogId === logId : null });
      const blob = await generatePNGFromHTML(html); downloadReportPNG(blob, `report_${type}_${Date.now()}.png`); showToastEl('✅ PNG готов', false);
    } catch(e) { showError('Ошибка PNG: ' + e.message); }
  }
  async function exportArchivePNG() {
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
    pO.textContent = 'Объект: ' + (state.shift ? objectTitle(state.shift.objectId,state.shift.objectName) : '—'); pD.textContent = state.shift ? state.shift.startDate : '';
    gaiO.textContent = 'Объект: ' + (state.shift ? objectTitle(state.shift.objectId,state.shift.objectName) : '—'); gaiD.textContent = state.shift ? state.shift.startDate : '';
    if (!state.shift) { mB.innerHTML = '<tr><td colspan="11" style="text-align:center;">Нет смены</td></tr>'; gaiB.innerHTML = '<tr><td colspan="11" style="text-align:center;">Нет смены</td></tr>';
      // Линия закрыта, но восстановленная смена остаётся: её рейсы редактируются.
      const restOnly=(state.restoredShifts||[]).flatMap(r=>r.logs||[]);let canEditR=hasPermission('edit_logs');
      lC.innerHTML = restOnly.length ? restOnly.map(l=>{
        let a = resolveUserDisplayName(l.createdByEmail, l.createdBy); let au = a ? ` · 👤 ${escapeHtml(a)}` : '';
        let volHtml = l.isGAI ? '<span style="color:#94a3b8;">(Рейс)</span>' : `<span style="color:var(--success);">+${l.volume} м³</span>`;
        let commHtml = l.comment ? `<div class="log-comment">💬 ${escapeHtml(l.comment)}</div>` : '';
        return `<div class="log-item"><div><div class="log-info">${truckLabelHtml(l.truckId, l.truckName)} — ${volHtml}</div><div class="log-meta">${escapeHtml(l.timeStr)}${au}</div>${commHtml}</div>${canEditR?`<div style="display:flex;gap:6px;"><button class="btn-edit" onclick="openEditLog('${l.id}')">✏️</button><button class="btn-del" onclick="deleteLog('${l.id}')">X</button></div>`:''}</div>`;
      }).join('') : '<div class="empty-state">Нет рейсов</div>';
      pV.textContent='0 м³'; gaiV.textContent='0'; renderRestoredShifts(); return; }
    let logs = getLogs(); let stdLogs = logs.filter(l=>!l.isGAI); let gaiLogs = logs.filter(l=>l.isGAI);
    let totV = stdLogs.reduce((s,l)=>s+l.volume,0); pV.textContent = totV + ' м³';
    let aIds = getActiveLineIds().filter(id => { let t = findTruck(id); return t && !t.isGAI; });
    let tIds = new Set(aIds); stdLogs.forEach(l=>tIds.add(l.truckId));
    let rTrucks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?f:{id, brand:'Машина', number:'', defaultVol:0}; });
    let fTime = {}; stdLogs.forEach(l=>{ if(fTime[l.truckId]===undefined || l.timestamp<fTime[l.truckId]) fTime[l.truckId]=l.timestamp; });
    // Эталон «Сводка»: первым идёт самосвал с самой ранней погрузкой; машины без рейсов — внизу.
    rTrucks.sort((a,b)=> ((fTime[a.id] === undefined) - (fTime[b.id] === undefined)) || ((fTime[a.id]||0) - (fTime[b.id]||0)) || String(a.id).localeCompare(String(b.id)));
    let maxT = 8; rTrucks.forEach(t=>{ let c=stdLogs.filter(l=>l.truckId===t.id).length; if(c>maxT) maxT=c; });
    let hHtml = '<th>№</th><th style="text-align:left;">Самосвал</th>'; for(let i=1; i<=maxT; i++) hHtml += `<th>Рейс ${i}</th>`; mH.innerHTML = hHtml;
    mB.innerHTML = rTrucks.map((t, idx)=>{
      let tL = stdLogs.filter(l=>l.truckId===t.id).slice().sort((a,b)=>(Number(a.timestamp)||0)-(Number(b.timestamp)||0) || String(a.id||'').localeCompare(String(b.id||''))), st = state.truckStatus[t.id]||{}, sum = tL.reduce((s,l)=>s+l.volume,0);
      let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? false : (tL.length > 0 && st.ttnStatus !== true);
      let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;" title="Дубликат" aria-label="Дубликат">D</span>' : '';
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
      return `<tr><td style="font-weight:bold;">${idx+1}</td><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.brand)} <span class="paper-truck-volume">${sum} м³ / ${tL.length} р</span>${dupHtml}</div>${t.number?renderRussianPlate(t.number):''}</td>${cells}</tr>`;
    }).join('');
    gaiV.textContent = gaiLogs.length;
    let gaiLineIds = getActiveLineIds().filter(id => { let t = findTruck(id); return t && t.isGAI; });
    let gaiTIds = new Set(gaiLineIds); gaiLogs.forEach(l=>gaiTIds.add(l.truckId));
    let gaiTrucks = Array.from(gaiTIds).map(id=>{ let f=findTruck(id); return f?f:{id, brand:'Машина', number:'', defaultVol:0}; });
    let gaiFirstTime = {}; gaiLogs.forEach(l=>{ if(gaiFirstTime[l.truckId]===undefined || l.timestamp<gaiFirstTime[l.truckId]) gaiFirstTime[l.truckId]=l.timestamp; });
    gaiTrucks.sort((a,b)=> ((gaiFirstTime[a.id] === undefined) - (gaiFirstTime[b.id] === undefined)) || ((gaiFirstTime[a.id]||0) - (gaiFirstTime[b.id]||0)) || String(a.id).localeCompare(String(b.id)));
    let gaiMaxT = 8; gaiTrucks.forEach(t=>{ let c=gaiLogs.filter(l=>l.truckId===t.id).length; if(c>gaiMaxT) gaiMaxT=c; });
    let gaiHHtml = '<th>№</th><th style="text-align:left;">Самосвал</th>'; for(let i=1; i<=gaiMaxT; i++) gaiHHtml += `<th>Рейс ${i}</th>`; gaiH.innerHTML = gaiHHtml;
    gaiB.innerHTML = gaiTrucks.map((t, idx)=>{
      let tL = gaiLogs.filter(l=>l.truckId===t.id).slice().sort((a,b)=>(Number(a.timestamp)||0)-(Number(b.timestamp)||0) || String(a.id||'').localeCompare(String(b.id||'')));
      let st = state.truckStatus[t.id] || {};
      let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? false : (tL.length > 0 && st.ttnStatus !== true);
      let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;" title="Дубликат" aria-label="Дубликат">D</span>' : '';
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
    // Журнал показывает и рейсы восстановленных архивных смен: они редактируются
    // здесь же (report.*), при этом сводки активной смены их не учитывают.
    const restoredLogs=(state.restoredShifts||[]).flatMap(r=>r.logs||[]);
    const allLogs=[...logs,...restoredLogs.filter(l=>!logs.some(x=>x.id===l.id))];
    lC.innerHTML = allLogs.length === 0 ? '<div class="empty-state">Нет рейсов</div>' : allLogs.map(l=>{
      let a = resolveUserDisplayName(l.createdByEmail, l.createdBy); let au = a ? ` · 👤 ${escapeHtml(a)}` : '';
      let volHtml = l.isGAI ? '<span style="color:#94a3b8;">(Рейс)</span>' : `<span style="color:var(--success);">+${l.volume} м³</span>`;
      let commHtml = l.comment ? `<div class="log-comment">💬 ${escapeHtml(l.comment)}</div>` : '';
      return `<div class="log-item"><div><div class="log-info">${truckLabelHtml(l.truckId, l.truckName)} — ${volHtml}</div><div class="log-meta">${escapeHtml(l.timeStr)}${au}${l.offlinePending?' · ☁️ офлайн':''}</div>${commHtml}</div>${canEditL&&!l.offlinePending?`<div style="display:flex;gap:6px;"><button class="btn-edit" onclick="openEditLog('${l.id}')">✏️</button><button class="btn-del" onclick="deleteLog('${l.id}')">X</button></div>`:''}</div>`;
    }).join('');
    renderRestoredShifts();
  }
  function toggleReportType() { if (!hasPermission('view_gai_report')) { showError('Нет прав'); return; } showGAITable = !showGAITable; renderReport(); }
  function openEditLog(id) { if(!requireEdit('edit_logs')) return; let l=state.logs.find(x=>x.id===id); if(!l) return; editingLogId=id; document.getElementById('editLogTruckInfo').innerHTML=`<b>${escapeHtml(l.truckName)}</b>`; document.getElementById('editLogVolume').value=l.volume; document.getElementById('editLogTime').value=l.timeStr; document.getElementById('editLogComment').value=l.comment || ''; document.getElementById('editLogModal').classList.add('open'); }
  function closeEditLogModal() { document.getElementById('editLogModal').classList.remove('open'); editingLogId=null; }
  async function saveLogEdit() {
    if(!requireEdit('edit_logs') || !editingLogId) return;
    let l=state.logs.find(x=>x.id===editingLogId); if(!l) return closeEditLogModal();
    let v=parseFloat(document.getElementById('editLogVolume').value); let t=document.getElementById('editLogTime').value; let comm=document.getElementById('editLogComment').value.trim();
    if(isNaN(v)||v<0 || !/^\d{2}:\d{2}$/.test(t)) { appNotice('Проверьте правильность ввода объема и времени (ЧЧ:ММ)'); return; }
    if(isNasRuntime()){try{await nasReportAction('report.update',l,{volume:v,timeStr:t,comment:comm});closeEditLogModal();renderReport();showToastEl('✅ Рейс обновлен',false);}catch(e){showError(e.message);}return;}
    let ts=l.timestamp; if(ts){ let d=new Date(ts), p=t.split(':'); d.setHours(p[0],p[1],0,0); ts=d.getTime(); }
    const logIdToSave = editingLogId;
    Object.assign(l, {volume:v, timeStr:t, timestamp:ts, comment:comm}); saveCache(); renderReport(); closeEditLogModal();
    tf((async()=>{ await refs.logs.doc(logIdToSave).update({volume:v, timeStr:t, timestamp:ts, comment:comm}); await addAudit('✏️ Изменён рейс: ' + l.truckName + ' · ' + v + ' м³ · ' + t, {eventType:'log_edit',logId:logIdToSave,truckId:l.truckId}); })());
    showToastEl('✅ Рейс обновлен', false);
  }
  async function deleteLog(id) { if(!requireEdit('edit_logs') || !(await appConfirm('Удалить?'))) return; if(isNasRuntime()){try{const log=state.logs.find(x=>x.id===id);if(log)await nasReportAction('report.delete',log);renderReport();}catch(e){showError(e.message);}return;} state.logs=state.logs.filter(x=>x.id!==id); saveCache(); renderReport(); tf(refs.logs.doc(id).delete()); }

  // === ВОССТАНОВЛЕННЫЕ АРХИВНЫЕ СМЕНЫ (правки параллельно с активной линией) ===
  // Решение владельца 23.11.2026: восстановленная из архива смена редактируется
  // параллельно с активной. Рейсы правятся обычным журналом (report.*); блок
  // ниже показывает сводку и возвращает смену в архив закрытием. Активная
  // смена линии при этом не затрагивается (сервер разделяет их по shiftId).
  function renderRestoredShifts() {
    const box = document.getElementById('restoredShiftsContainer'); if (!box) return;
    const restored = state.restoredShifts || [];
    if (!restored.length) { box.hidden = true; box.innerHTML = ''; return; }
    const canEdit = hasPermission('close_shift');
    box.hidden = false;
    box.innerHTML = restored.map(r => {
      const s = r.shift, stdLogs = (r.logs||[]).filter(l=>!l.isGAI), gaiLogs=(r.logs||[]).filter(l=>l.isGAI);
      const volume = stdLogs.reduce((sum,l)=>sum+Number(l.volume||0),0);
      const title = escapeHtml(objectTitle(s.objectId, s.objectName)) + ' · ' + escapeHtml(s.startDate||'');
      // Provenance исходного архива: автор/тип и отдельный восстановивший.
      // Без данных блок выглядит как раньше — строки не добавляются.
      let provenanceHtml = '';
      if (typeof WorkingTestRestoredArchive !== 'undefined' && r.provenance && typeof r.provenance === 'object') {
        const info = WorkingTestRestoredArchive.createRestoredArchive({}).describeProvenance(r.provenance);
        provenanceHtml = `<div class="restored-shift-provenance" data-restored-provenance="${escapeHtml(s.id)}"><div class="restored-archive-badge">Архивная смена · только правки рейсов/ТТН</div>${info.lines.map(line=>`<div class="restored-provenance-line">${escapeHtml(line)}</div>`).join('')}</div>`;
      }
      return `<div class="restored-shift-card" data-restored-shift="${escapeHtml(s.id)}">
        <div class="restored-shift-head">
          <div><b>♻️ Восстановленная смена: ${title}</b><div class="restored-shift-note">Редактируется параллельно с активной сменой. Правки рейсов — в журнале ниже.</div></div>
          ${canEdit?`<button class="btn btn-secondary btn-small" onclick="closeRestoredShift('${escapeHtml(s.id)}')">📥 Вернуть в архив</button>`:''}
        </div>
        ${provenanceHtml}
        <div class="restored-shift-stats">Объём: <b>${volume} м³</b> · Рейсов: <b>${stdLogs.length}</b>${gaiLogs.length?` · ГАИ: <b>${gaiLogs.length}</b>`:''}</div>
      </div>`;
    }).join('');
  }
  async function closeRestoredShift(shiftId) {
    if(!requireEdit('close_shift')) return;
    const r=(state.restoredShifts||[]).find(x=>x.shift.id===shiftId); if(!r){showError('Смена уже изменена. Обновите страницу.');return;}
    // v2-контекст (design §5.6): маршрута публикации ревизии архива в сервере
    // канала нет. Честно объясняем это и НЕ закрываем смену окольным путём —
    // иначе пользователь решит, что правки вернулись в архив.
    if(typeof nasRestoredFinalizeText==='function'){
      const text=nasRestoredFinalizeText(shiftId);
      if(text){showError(text);return;}
    }
    if(!(await appConfirm(`Вернуть восстановленную смену «${objectTitle(r.shift.objectId,r.shift.objectName)}» от ${r.shift.startDate} в архив?\n\nАктивная смена линии продолжит работать без изменений.`)))return;
    if(!isNasRuntime()){showError('Возврат в архив доступен в режиме сервера Ubuntu');return;}
    try{
      // Материал уже переносился при исходном закрытии: повторного переноса нет,
      // сервер не требует подтверждения табеля для restored-смены.
      await nasCloseCurrentShift(shiftId);
      showToastEl('✅ Восстановленная смена возвращена в архив. Активная смена не менялась.', false);
    }catch(e){showError('Ошибка возврата в архив: '+e.message);}
  }

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
  function renderArchive() {
    if (!hasTabAccess('archive')) return;
    const container=document.getElementById('archiveContainer');
    if (!container.__archiveToggleBound) {
      container.addEventListener('click',event=>{
        const toggle=event.target.closest?.('.archive-group-toggle');
        if (!toggle || !container.contains(toggle)) return;
        const key=toggle.getAttribute('data-archive-key');
        const expanded=toggle.getAttribute('aria-expanded')!=='true';
        if (expanded) archiveExpandedObjects.add(key);
        else archiveExpandedObjects.delete(key);
        toggle.setAttribute('aria-expanded',String(expanded));
        const arrow=toggle.querySelector('.archive-group-arrow');
        if (arrow) arrow.textContent=expanded?'▾':'▸';
        const list=toggle.nextElementSibling;
        if (list?.classList.contains('archive-shifts-list')) list.hidden=!expanded;
      });
      container.__archiveToggleBound=true;
    }
    const q=(document.getElementById('archiveSearchInput').value||'').toLowerCase();
    // Фоновые снапшоты пересобирают список через innerHTML — без сохранения
    // прокрутки список «подпрыгивает» к началу при каждом обновлении.
    const keepScrollY=window.scrollY||document.documentElement.scrollTop||document.body?.scrollTop||0;
    const keepContainerTop=container.scrollTop||0;
    const filtered=state.archive.filter(s=>s.date?.toLowerCase().includes(q)||objectTitle(s.objectId,s.objectName).toLowerCase().includes(q));
    if (!filtered.length){
      container.innerHTML='<div class="empty-state">Пусто</div>';
      container.scrollTop=keepContainerTop;
      if (keepScrollY&&typeof window.scrollTo==='function') window.scrollTo(0,keepScrollY);
      renderTrash();return;
    }
    const groups=Object.create(null);
    filtered.forEach(shift=>{
      const name=objectTitle(shift.objectId,shift.objectName);
      if (!groups[name]) groups[name]=[];
      groups[name].push(shift);
    });
    container.innerHTML=Object.keys(groups).map((name,index)=>{
      const shifts=groups[name].sort((a,b)=>(b.closedAt||0)-(a.closedAt||0));
      const expanded=archiveExpandedObjects.has(name)||!!q;
      return `<div class="archive-group"><button type="button" class="archive-group-header archive-group-toggle" data-archive-key="${escapeHtml(name)}" aria-expanded="${expanded}" aria-controls="archive-shifts-${index}" style="width:100%;border:0;text-align:left;font-family:inherit;gap:10px;"><span class="archive-group-arrow" aria-hidden="true" style="min-width:14px;">${expanded?'▾':'▸'}</span><span style="min-width:0;flex:1;overflow-wrap:anywhere;">${escapeHtml(name)}</span></button><div class="archive-shifts-list" id="archive-shifts-${index}" ${expanded?'':'hidden'}>${shifts.map(s=>{
        const stdLogs=(s.logs||[]).filter(log=>!log.isGAI);
        return `<div class="archive-shift-item" onclick="openArchiveModal('${s.id}')"><div>${escapeHtml(s.date)}</div><div>${stdLogs.length} рейсов | <b>${stdLogs.reduce((sum,log)=>sum+log.volume,0)} м³</b></div></div>`;
      }).join('')}</div></div>`;
    }).join('');
    container.scrollTop=keepContainerTop;
    if (keepScrollY&&typeof window.scrollTo==='function') window.scrollTo(0,keepScrollY);
    renderTrash();
    if (viewingArchiveId){
      const shift=state.archive.find(item=>item.id===viewingArchiveId);
      if (shift) openArchiveModal(viewingArchiveId); else closeArchiveModal();
    }
  }
  function renderTrash() { let c = document.getElementById('trashContainer'); if(!state.trash.length) { c.innerHTML=''; return; } let e = hasPermission('archive_edit'); c.innerHTML = `<div class="trash-group"><div class="trash-header">Корзина</div><div class="trash-list">${state.trash.map(i=>`<div class="trash-item"><div class="info"><b>${escapeHtml(objectTitle(i.shift.objectId,i.shift.objectName))}</b> · ${escapeHtml(i.shift.date)}</div>${e?`<button class="btn-del" onclick="purgeFromTrash('${i.id}')">X</button>`:''}</div>`).join('')}</div></div>`; }
  async function purgeFromTrash(id) { if(!requireEdit('archive_delete') || !(await appConfirm('Удалить навсегда?'))) return; try{if(isNasRuntime()){await nasArchiveAction('trash.purge',id);return;}await tfAwait(refs.trash.doc(id).delete());}catch(e){showError(e.message);} }
  function openArchiveModal(id) { let s = state.archive.find(x=>x.id===id); if(!s) return; if (viewingArchiveId !== id) { viewingArchiveId=id; if (typeof window !== 'undefined') window.__wtArchiveRevisionView = null; } viewingArchiveGAITable = false; renderArchiveModalContent(s); document.getElementById('archiveModal').classList.add('open'); }
  function toggleArchiveReportType() { viewingArchiveGAITable = !viewingArchiveGAITable; let s = state.archive.find(x=>x.id===viewingArchiveId); if (s) renderArchiveModalContent(s); }
  // История ревизий и provenance приходят только инжектированным провайдером:
  // серверных маршрутов /api/v2/archives/... в этом канале нет, поэтому без
  // данных UI честно говорит «недоступна», а не выдумывает ревизию 1.
  function archiveRevisionProvider() {
    const provider = typeof window !== 'undefined' ? window.__wtArchiveRevisionProvider : null;
    if (!provider) return null;
    try {
      const value = typeof provider === 'function' ? provider() : provider;
      return value && typeof value === 'object' ? value : null;
    } catch (_) {
      return null;
    }
  }
  function archiveRestoredApi() {
    return typeof WorkingTestRestoredArchive !== 'undefined'
      ? WorkingTestRestoredArchive.createRestoredArchive({})
      : null;
  }
  function archiveExplicitView() {
    const view = typeof window !== 'undefined' ? window.__wtArchiveRevisionView : null;
    return view && typeof view === 'object' ? view : null;
  }
  function archiveProvenanceHtml(provenance) {
    const api = archiveRestoredApi();
    if (!api || !provenance || typeof provenance !== 'object') return '';
    const info = api.describeProvenance(provenance);
    return '<div class="archive-archive-badge">Архивная смена · только правки рейсов/ТТН</div>'
      + info.lines.map(line => '<div class="archive-provenance-line">' + escapeHtml(line) + '</div>').join('');
  }
  function archiveRevisionSectionHtml() {
    const unavailable = '<div class="archive-revision-empty">История ревизий недоступна в этом канале</div>';
    const provider = archiveRevisionProvider();
    const api = archiveRestoredApi();
    // Без провайдера ревизий секции нет вовсе. Это не то же самое, что
    // «ревизий нет»: в канале без маршрута истории пользователю нечего
    // показывать, а заголовок с честной оговоркой выглядел бы как реклама
    // недоступной функции. Пустая секция ничего не обещает.
    if (!provider || !api) return '';
    if (!Array.isArray(provider.revisions) || !provider.revisions.length) {
      return '<div class="archive-revision-title">История ревизий</div>' + unavailable;
    }
    const latest = api.resolveDefault(provider.revisions);
    if (!latest) {
      return '<div class="archive-revision-title">История ревизий</div>' + unavailable;
    }
    const view = archiveExplicitView();
    const selected = view && Number.isSafeInteger(Number(view.revision))
      ? api.selectRevision(provider.revisions, Number(view.revision))
      : null;
    const described = api.describeRevision(selected || latest);
    // Сортировка идёт по нормализованному номеру: серверная форма ревизии
    // (`revision`, `server/src/archive-latest.mjs`) не несёт `archiveRevision`,
    // и прежнее `Number(b.archiveRevision) - Number(a.archiveRevision)` давало
    // NaN, то есть список оставался в исходном порядке. Битые строки, которые
    // describeRevision не может описать, в список не попадают.
    const sorted = provider.revisions
      .map(revision => api.describeRevision(revision))
      .filter(item => item && Number.isSafeInteger(item.revision))
      .sort((a, b) => b.revision - a.revision);
    const options = sorted.map(item => {
      const label = 'Ревизия ' + item.revision + ' · ' + (item.publishedAt || 'дата неизвестна')
        + ' · ' + (item.sha256 ? item.sha256.slice(0, 12) : 'SHA-256 неизвестен');
      return '<option value="' + item.revision + '"' + (item.revision === described.revision ? ' selected' : '') + '>'
        + escapeHtml(label) + '</option>';
    }).join('');
    return '<div class="archive-revision-title">История ревизий</div>'
      + '<div class="archive-revision-current">' + (selected ? 'Выбрана ревизия ' : 'По умолчанию: ревизия ')
      + described.revision + ' · SHA-256 ' + escapeHtml(described.sha256 || '—')
      + ' · ' + escapeHtml(described.publishedAt || '—') + '</div>'
      + '<select class="form-control archive-revision-select" onchange="openArchiveRevision(this.value)">' + options + '</select>'
      + (described.readOnly ? '<div class="archive-revision-readonly">Просмотр ревизии только для чтения. Правки доступны в последней опубликованной ревизии.</div>' : '');
  }
  function renderArchiveMetaSections(s) {
    const provider = archiveRevisionProvider();
    const provenance = (s && s.provenance) || (provider && provider.provenance) || null;
    const provenanceHtml = archiveProvenanceHtml(provenance);
    const historyHtml = archiveRevisionSectionHtml();
    const provenanceEl = document.getElementById('archiveProvenanceSection');
    const historyEl = document.getElementById('archiveRevisionHistory');
    if (provenanceEl || historyEl) {
      if (provenanceEl) provenanceEl.innerHTML = provenanceHtml;
      if (historyEl) historyEl.innerHTML = historyHtml;
      return '';
    }
    return '<div class="archive-provenance">' + provenanceHtml + '</div><div class="archive-revision-history">' + historyHtml + '</div>';
  }
  // Полноэкранный просмотр архива (features/paper-viewer.js) подменяет
  // window.openArchiveModal/renderArchiveModalContent и рисует только бумажный
  // лист. Плашка архива и история ревизий живут отдельными секциями модалки,
  // поэтому их рендерер публикуется наружу: без этого они оставались пустыми
  // в собранном канале, хотя разметка и данные на месте.
  if (typeof window !== 'undefined') window.__wtRenderArchiveMeta = renderArchiveMetaSections;
  // Explicit-просмотр ревизии: только выбор в модалке, default pointer не
  // меняется, правок не предлагается, сеть не вызывается.
  function openArchiveRevisionView(revision) {
    const provider = archiveRevisionProvider();
    const api = archiveRestoredApi();
    if (!provider || !api || !Array.isArray(provider.revisions)) return false;
    const selected = api.selectRevision(provider.revisions, revision);
    if (!selected) return false;
    if (typeof window !== 'undefined') {
      window.__wtArchiveRevisionView = {
        archiveId: provider.archiveId || viewingArchiveId,
        revision: selected.archiveRevision,
        sha256: selected.archiveSha256 || '',
        explicit: true,
        readOnly: true
      };
    }
    const shift = (state.archive || []).find(item => item.id === viewingArchiveId);
    if (shift) renderArchiveModalContent(shift);
    return true;
  }
  function closeArchiveRevisionView() {
    if (typeof window !== 'undefined') window.__wtArchiveRevisionView = null;
    const shift = (state.archive || []).find(item => item.id === viewingArchiveId);
    if (shift) renderArchiveModalContent(shift);
    return true;
  }
  function renderArchiveModalContent(s) {
    if (!hasTabAccess('archive')) return; // === SECURITY ===
    // Ф3: фоновые снапшоты вызывают renderArchive → openArchiveModal →
    // этот рендер, и innerHTML сбрасывает горизонтальную прокрутку отчёта
    // («схлопывался к самосвалам»). scrollLeft читается до перестроения
    // и восстанавливается после — как вертикаль списка в renderArchive.
    const bodyEl=document.getElementById('modalArchiveBody');
    const keepScrollLeft=bodyEl?.querySelector('.paper-scroll-wrapper')?.scrollLeft||0;
    let logs = s.logs || []; let stdLogs = logs.filter(l=>!l.isGAI); let gaiLogs = logs.filter(l=>l.isGAI);
    let tV = stdLogs.reduce((x,y)=>x+y.volume,0);
    document.getElementById('modalArchiveTitle').textContent = s.date;
    let e = hasPermission('archive_edit');
    document.getElementById('archiveRestoreBtn').style.display = e?'':'none';
    // На пустом (уже удалённом) листе ГАИ удалять нечего — кнопка скрыта.
    const canDeleteArchive = hasPermission('archive_delete') && !(viewingArchiveGAITable && !gaiLogs.length);
    document.getElementById('archiveDeleteBtn').style.display = canDeleteArchive?'':'none';
    // Подпись кнопки объясняет, что именно удалится: весь архив или только лист ГАИ.
    const delBtn = document.getElementById('archiveDeleteBtn');
    if (delBtn) delBtn.textContent = viewingArchiveGAITable ? '🗑 Удалить лист ГАИ' : '🗑 Удалить архив';
    let toggleBtnHtml = `<div class="archive-view-switch"><button type="button" class="archive-toggle-icon" aria-label="${viewingArchiveGAITable ? 'Обычный лист' : 'Лист ГАИ'}" title="${viewingArchiveGAITable ? 'Обычный лист' : 'Лист ГАИ'}" onclick="toggleArchiveReportType()">📄</button></div>`;
    let activeLineIds = s.activeLineIds || []; let ttnStatus = s.ttnStatus || {}; let html = '';
    if (!viewingArchiveGAITable) {
      let aIds = activeLineIds.filter(id => { let t = findTruck(id); return t && !t.isGAI; });
      let tIds = new Set(aIds); stdLogs.forEach(l=>tIds.add(l.truckId));
      let tks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?{id, name:f.brand+' '+f.number}:{id, name:(stdLogs.find(l=>l.truckId===id)?.truckName||'—')}; });
      let mT=8; tks.forEach(t=>{ let c=stdLogs.filter(l=>l.truckId===t.id).length; if(c>mT) mT=c; });
      let hC = ''; for(let i=1; i<=mT; i++) hC+=`<th>Рейс ${i}</th>`;
      let mH = tks.map(t=>{ let l = stdLogs.filter(x=>x.truckId===t.id).slice().reverse(), sm = l.reduce((x,y)=>x+y.volume,0), cells=''; let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (l.length > 0 && ttnStatus[t.id] !== true && ttnStatus[t.id] !== 'pending') : (l.length > 0 && !ttnStatus[t.id]); let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;" title="Дубликат" aria-label="Дубликат">D</span>' : '';
        for(let i=0; i<mT; i++) { if(l[i]) { let isL=(i===l.length-1), cH = ttnStatus[t.id] && isL ? '<div class="hand-drawn-circle"></div>':''; let commHtml = l[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l[i].comment)}</div>` : ''; cells += `<td><div class="cell-content">${cH}<div class="paper-time">${escapeHtml(l[i].timeStr)}</div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l[i].createdByEmail, l[i].createdBy))}</div>${commHtml}</div></td>`; }
          else if (i === l.length && ttnStatus[t.id] === 'pending') { cells += `<td><div class="cell-content"><div class="hand-drawn-circle"></div></div></td>`; }
          else cells += '<td></td>';
        } return `<tr><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.name)} <span class="paper-truck-volume">${sm} м³</span>${dupHtml}</div></td>${cells}</tr>`; }).join('');
      html = `<div style="position:relative;" id="archive-paper-wrapper"><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(objectTitle(s.objectId,s.objectName))}</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div><div class="paper-total-info">Объем: <b>${tV} м³</b></div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th>${hC}</tr></thead><tbody>${mH}</tbody></table></div></div></div>`;
    } else if (!gaiLogs.length) {
      // Лист ГАИ удалён: остаётся пустой листик — без пометки «ГАИ» и без
      // списка самосвалов, которые были только на этом листе.
      html = `<div style="position:relative;" id="archive-paper-wrapper"><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(objectTitle(s.objectId,s.objectName))}</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th></tr></thead><tbody></tbody></table></div></div></div>`;
    } else {
      let aIds = activeLineIds.filter(id => { let t = findTruck(id); return t && t.isGAI; });
      let tIds = new Set(aIds); gaiLogs.forEach(l=>tIds.add(l.truckId));
      let tks = Array.from(tIds).map(id=>{ let f=findTruck(id); return f?{id, name:f.brand+' '+f.number}:{id, name:(gaiLogs.find(l=>l.truckId===id)?.truckName||'—')}; });
      let mT=8; tks.forEach(t=>{ let c=gaiLogs.filter(l=>l.truckId===t.id).length; if(c>mT) mT=c; });
      let hC = ''; for(let i=1; i<=mT; i++) hC+=`<th>Рейс ${i}</th>`;
      let mH = tks.map(t=>{ let l = gaiLogs.filter(x=>x.truckId===t.id).slice().reverse(), cells=''; let isDup = (typeof window.__closedShiftDupEnabled === 'function' && window.__closedShiftDupEnabled()) ? (l.length > 0 && ttnStatus[t.id] !== true && ttnStatus[t.id] !== 'pending') : (l.length > 0 && !ttnStatus[t.id]); let dupHtml = isDup ? ' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;" title="Дубликат" aria-label="Дубликат">D</span>' : '';
        for(let i=0; i<mT; i++) { if(l[i]) { let commHtml = l[i].comment ? `<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${escapeHtml(l[i].comment)}</div>` : ''; cells += `<td><div class="cell-content"><div class="paper-time">${escapeHtml(l[i].timeStr)}</div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${escapeHtml(resolveUserDisplayName(l[i].createdByEmail, l[i].createdBy))}</div>${commHtml}</div></td>`; }
          else cells += '<td></td>';
        } return `<tr><td class="truck-cell"><div class="paper-truck-brand">${escapeHtml(t.name)} <span class="paper-truck-volume">Рейсов: ${l.length}</span>${dupHtml}</div></td>${cells}</tr>`; }).join('');
      html = `<div style="position:relative;" id="archive-paper-wrapper"><div class="paper-scroll-wrapper" style="margin:0;"><div class="paper-report-container compact" style="zoom:0.75;"><div class="paper-header"><div class="paper-object-name">Объект: ${escapeHtml(objectTitle(s.objectId,s.objectName))} (ГАИ)</div><div class="paper-date-vol-row"><div class="paper-report-title">${escapeHtml(s.date)}</div><div class="paper-total-info">Рейсов ГАИ: <b>${gaiLogs.length}</b></div></div></div><table class="paper-table"><thead><tr><th>Самосвал</th>${hC}</tr></thead><tbody>${mH}</tbody></table></div></div></div>`;
    }
    // Секции provenance/истории ревизий необязательны: без модуля 45 или без
    // провайдера данных отчёт архива выглядит и работает как раньше.
    const metaHtml = typeof renderArchiveMetaSections === 'function' ? renderArchiveMetaSections(s) : '';
    document.getElementById('modalArchiveBody').innerHTML = toggleBtnHtml + html + metaHtml;
    const keepWrapper=document.getElementById('modalArchiveBody').querySelector('.paper-scroll-wrapper');
    if (keepWrapper && keepScrollLeft) keepWrapper.scrollLeft = keepScrollLeft;
  }
  function closeArchiveModal() { document.getElementById('archiveModal').classList.remove('open'); viewingArchiveId=null; if (typeof window !== 'undefined') window.__wtArchiveRevisionView = null; }
  async function restoreArchiveToShift() {
    if(state.shift?.closing){showError('Сначала завершите закрытие текущей смены');return;}
    if (!requireEdit('archive_edit') || !viewingArchiveId) return;
    const s = state.archive.find(x => x.id === viewingArchiveId); if (!s) return;
    if(isNasRuntime()){
      // Решение владельца 23.11.2026: архивная смена восстанавливается для
      // правок параллельно с активной сменой линии — закрывать её не нужно.
      const hasActive = state.shift && state.shift.isActive;
      const msg = hasActive
        ? `Восстановить смену «${objectTitle(s.objectId,s.objectName)}» от ${s.date} для правок?\n\nАктивная смена «${objectTitle(state.shift.objectId,state.shift.objectName)}» продолжит работать — восстановленная смена редактируется параллельно.`
        : `Восстановить смену «${objectTitle(s.objectId,s.objectName)}» от ${s.date}?`;
      if(!(await appConfirm(msg)))return;
      // v2-путь (design §5.6): сервер открывает restored-контекст, клиент
      // показывает карточку «Восстановленная смена» и правит рейсы через
      // POST /api/v2/archives/{id}/operations. Активная смена и active-таблицы
      // не затрагиваются. Без живого моста остаётся прежний честный отказ.
      if(typeof nasRestoredV2Ready==='function'&&nasRestoredV2Ready()){
        try{
          await nasRestoreArchivedShift(viewingArchiveId);
          closeArchiveModal();
          showToastEl(hasActive?'✅ Архивная смена восстановлена для правок — параллельно с активной':'✅ Архивная смена восстановлена для правок',false);
        }catch(error){
          showError(error&&error.message?error.message:'Не удалось восстановить архивную смену: данные не изменены.');
        }
        return;
      }
      try{await nasArchiveAction('archive.restore',viewingArchiveId);closeArchiveModal();showToastEl(hasActive?'✅ Архивная смена восстановлена для правок — параллельно с активной':'Смена восстановлена на Ubuntu',false);}
      catch(error){
        // На канонической схеме (миграция 025) старый путь восстановления
        // запрещён: restored archive не становится активной сменой (design
        // §4.7, §3.4), его место — restored_shift_contexts, у которого пока нет
        // маршрута. Сервер отвечает стабильным кодом, и пользователь должен
        // увидеть причину, а не «api-http-409».
        const code = error && (error.serverCode || error.code);
        if (code === 'archive-restore-requires-v2') showError('Восстановление архивной смены в этом режиме недоступно: смена не создана, данные архива не изменены. Обратитесь к администратору.');
        else showError('Ошибка восстановления: ' + error.message);
      }return;
    }
    // Firebase-путь восстановления архива удалён (очистка 2026-11-23):
    // Ubuntu — единственный сервер данных, Firebase-режим недостижим.
    showError('Восстановление недоступно: нет связи с сервером Ubuntu.');
  }
  // «Удалить» зависит от открытого листочка: обычный лист — весь архив в корзину,
  // лист ГАИ — только рейсы ГАИ этого архива, остальные данные не меняются.
  async function deleteArchiveShift() {
    if(!requireEdit('archive_delete') || !viewingArchiveId) return;
    const s = state.archive.find(x=>x.id===viewingArchiveId); if(!s) return;
    const gaiMode = viewingArchiveGAITable === true;
    const dateText = s.date || '';
    const gaiTrips = (s.logs||[]).filter(l=>l.isGAI).length;
    try {
      if (gaiMode) {
        if (!gaiTrips) { showError('В этом архиве нет рейсов ГАИ.'); return; }
        if (!(await appConfirm(`Вы действительно хотите удалить листочек ГАИ за ${dateText}? Обычный лист и остальные данные архива останутся без изменений.`))) return;
        if (isNasRuntime()) {
          await nasArchiveAction('archive.gai.delete', viewingArchiveId);
        } else {
          const logs = (s.logs||[]).filter(l=>!l.isGAI);
          await tfAwait(refs.archive.doc(viewingArchiveId).update({
            logs,
            totalVolume: logs.reduce((total,l)=>total+Number(l.volume||0),0),
            totalTrips: logs.length,
            gaiDeletedAt: Date.now(),
            gaiDeletedBy: getUserName(),
          }));
        }
        addAudit(`🗑 Удалён листочек ГАИ за ${dateText}`).catch(()=>{});
        showToastEl('Листочек ГАИ удалён. Остальной архив сохранён.', false);
        viewingArchiveGAITable = false;
        const fresh = state.archive.find(x=>x.id===viewingArchiveId);
        if (fresh) renderArchiveModalContent(fresh); else closeArchiveModal();
        return;
      }
      if (!(await appConfirm(`Удалить весь архив за ${dateText}? Смена уйдёт в корзину, обычный лист и лист ГАИ.`))) return;
      if (isNasRuntime()) { await nasArchiveAction('archive.trash', viewingArchiveId); closeArchiveModal(); return; }
      await tfAwait(refs.trash.doc().set({ shift: s, deletedAt: Date.now(), deletedBy: getUserName() }));
      await tfAwait(refs.archive.doc(viewingArchiveId).delete());
      closeArchiveModal();
    } catch(e){ showError(e.message); }
  }

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
    try { if(isNasRuntime()){const result=await nasSaveRecord('truck','',{brand,number:num,defaultVol:isGAI?0:vol,isGAI},0);document.getElementById('truckSearchInput').value='';await nasChangeMembership(result.result.id,true);renderSelectorList();return;}let r = refs.trucks.doc(); await tfAwait(r.set({ brand, number: num, defaultVol: isGAI ? 0 : vol, isGAI, createdAt: Date.now(), createdBy: getUserName() })); await addTruckToLine(r.id); document.getElementById('truckSearchInput').value = ''; renderSelectorList(); }
    catch(e) { showError(e.message); }
  }
  function openSelectorModal() { if(!requireEdit('edit_line') || !state.shift) return; const search=document.getElementById('truckSearchInput');if(search)search.value=''; document.getElementById('selectorModal').classList.add('open'); renderSelectorList(); }
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

  function renderAnalytics() {
    if (!hasTabAccess('analytics')) return; // === SECURITY ===
    let c = document.getElementById('auditLogContainer'); if(!c) return;
    c.innerHTML = renderAuditEntries();
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
      if(isNasRuntime()){
        await Promise.all([refreshNasObjects(),refreshNasArchive()]);const items=[];
        for(const [collection] of sections)for(const raw of data[collection]||[]){
          if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Некорректная запись: '+collection);
          const id=raw.id?String(raw.id):'import_'+crypto.randomUUID().replaceAll('-','');const {id:_,revision,...payload}=raw;
          const existing=(collection==='archive'?state.archive:collection==='trucks'?state.trucks:state.objects).find(r=>r.id===id);
          items.push({collection,recordId:id,expectedRevision:existing?.revision||0,data:payload});
        }
        if(!items.length)throw Error('Резервная копия пуста');const result=await nasBusinessCommand('auxiliary','backup',{type:'backup.import',items});await Promise.all([refreshNasObjects(),refreshNasArchive(),nasRefreshLine()]);showToastEl('Импорт завершён. Записей обработано: '+result.result.written,false);return;
      }
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
  let startShiftInFlight=false;
  async function exportBackupFile() {
    if (!hasPermission('import_backup') && !canAdmin()) return;
    try {
      if (!window.SamosvalBackup) throw new Error('Модуль полной резервной копии ещё не готов');
      const data = await window.SamosvalBackup.exportFileData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url;
      a.download = 'samosval_working_test_backup_' + new Date().toISOString().slice(0,10) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToastEl('Бэкап скачан: база, табель и полный аудит. Фото и локальные очереди НЕ включены.', false);
    } catch(e) { showError('Экспорт не выполнен: ' + e.message); }
  }
  async function importBackupFile(ev) {
    if (!hasPermission('import_backup') && !canAdmin()) return;
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      if (!window.SamosvalBackup) throw new Error('Модуль безопасного импорта ещё не готов');
      const result = await window.SamosvalBackup.importRows(JSON.parse(await file.text()));
      if (result) showToastEl('Импорт базы/архива завершён. Записей: ' + result.written + '. Защитная копия: ' + result.safetyId, false);
    } catch(e) { showError('Ошибка импорта: ' + e.message); }
    finally { ev.target.value = ''; }
  }
  function buildShiftPayloadV2({shiftId,object,currentUid,currentDisplayName,workShift,startedAt}) {
    if(workShift!=='day'&&workShift!=='night')throw new Error('invalid-shift-v2-provenance');
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(startedAt);
    const part=type=>parts.find(item=>item.type===type)?.value;
    const date=`${part('year')}-${part('month')}-${part('day')}`;
    return {payloadSchemaVersion:2,id:shiftId,shiftId,objectId:object.id,objectName:object.name,startDate:`${part('day')}.${part('month')}.${part('year')}`,date,workShift,type:workShift,state:'active',isActive:true,startedAt,startedByUid:currentUid,startedBy:currentDisplayName};
  }
  async function startShiftWithObject(objName, objId, workShift) {
    if (startShiftInFlight || !requireEdit('start_shift')) return;
    if(!workShift){appNotice('Выберите тип смены: дневная или ночная');return;}
    if(workShift!=='day'&&workShift!=='night'){appNotice('Выберите тип смены: дневная или ночная');return;}
    if(state.shift?.closing){showError('Сначала завершите закрытие предыдущей смены');return;}
    if(offlinePendingCount()){showError('Сначала синхронизируйте действия предыдущей смены');return;}
    if(state.shift?.isActive)return;
    startShiftInFlight=true;
    try {
      if(isNasRuntime()){await nasBusinessCommand('start','current',{objectId:objId,workShift});await nasRefreshLine();closeStartShiftModal();showToastEl('Смена начата',false);openTabelShiftForLine(objName,objId);return;}
      await cleanupOldShiftData(); await clearAllNotifications();
      let sid = 'shift_' + Date.now();
      const startedAt=Date.now();
      await tfAwait(refs.shift.set(buildShiftPayloadV2({shiftId:sid,object:{id:objId||'',name:objName},currentUid,currentDisplayName:getUserName(),workShift,startedAt})));
      if (appConfig.maxEnabled && appConfig.notifyStart) enqueueMax(`🚀 Смена начата\n🏢 ${objName}\n📅 ${nowDateStr()}\n👤 ${getUserName()}`);
      addAudit(`🚀 Начата смена на объекте: ${objName}`).catch(()=>{});
      closeStartShiftModal(); showToastEl('Смена начата', false);
      openTabelShiftForLine(objName, objId);
    } catch(e){ showError(e.message); }
    finally{startShiftInFlight=false;}
  }
  // Смена на линии открыта → та же смена открывается в табеле (та же дата, тот же
  // объект). Табель сам подставит технику прошлого рабочего дня и не создаст
  // дубликат, если смена за эту дату уже есть. Ошибка табеля не отменяет
  // открытие смены на линии — только сообщает о ней.
  async function openTabelShiftForLine(objName, objId){
    if(!objId||!permissionsLoaded||currentUserStatus!=='active'||!hasTabAccess('timesheet'))return;
    try{
      const module=await import(new URL('./working-test/tabel-v2/entry.mjs',document.baseURI).href);
      const result=await module.ensureDay(tabelV2Host(),{objectId:objId,date:lineDateIso(state.shift?.startDate||nowDateStr()),kind:state.shift?.workShift||'day'});
      if(result?.created)showToastEl('Смена открыта и в табеле · ' + objName,false);
    }catch(error){console.warn('[tabel] Автооткрытие смены:',error.message);}
  }
  // Линия хранит дату как ДД.ММ.ГГГГ, табель — как ГГГГ-ММ-ДД.
  function lineDateIso(value){
    const ru=/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(value||'').trim());
    return ru?`${ru[3]}-${ru[2].padStart(2,'0')}-${ru[1].padStart(2,'0')}`:String(value||'');
  }
  async function cleanupOldShiftData(shiftId){
    const chunkSize=currentUserRole==='admin'?20:4;
    for(const collection of [refs.logs,refs.truckStatus]){
      const snap=await collection.get({source:'server'});
      const docs=snap.docs.filter(d=>!shiftId||d.data().shiftId===shiftId);
      for(let i=0;i<docs.length;i+=chunkSize){
        const batch=db.batch();docs.slice(i,i+chunkSize).forEach(d=>batch.delete(d.ref));
        await tfAwait(batch.commit());
      }
    }
  }
  let closeShiftInFlight=false;
  async function closeShift() {
    if (closeShiftInFlight || !requireEdit('close_shift')) return;
    if (!state.shift || (!state.shift.isActive && !state.shift.closing)) { appNotice('Смена не начата'); return; }
    if(offlinePendingCount()){showError('Сначала синхронизируйте действия перед закрытием смены');return;}
    const shiftId=state.shift.id;
    closeShiftInFlight=true;
    const button=document.getElementById('closeShiftBtn'),oldLabel=button?.textContent;
    let phase='подтверждение';
    try {
      if (!(await appConfirm(state.shift.closing?'Завершить закрытие смены?':'Закрыть смену?'))) return;
      if(button){button.disabled=true;button.textContent='⏳ Сохраняем и закрываем смену…';}
      if(isNasRuntime()){
        await nasCloseCurrentShift(shiftId);showToastEl('Смена закрыта',false);return;
      }
      // Firebase-путь закрытия смены удалён (очистка 2026-11-23): Ubuntu —
      // единственный сервер данных, Firebase-режим недостижим.
    } catch(e){ console.error('[closeShift:'+phase+']',e);showError('Не удалось завершить закрытие ('+phase+'): '+(e.message||e.code||e)+'. Сохранённый архив не удалён; можно повторить закрытие.'); }
    finally {closeShiftInFlight=false;if(button){button.disabled=false;button.textContent=oldLabel||'🔄 Закрыть смену';}}
  }
  function openStartShiftModal() {
    if (!requireEdit('start_shift')) return;
    let c = document.getElementById('existingObjectsList');
    let objs = state.objects.slice().sort((a,b)=>a.name.localeCompare(b.name));
    c.innerHTML = objs.length === 0 ? '<div style="color:var(--muted);font-size:12px;">Нет объектов</div>' : objs.map(o=>`<div style="background:var(--bg);padding:10px;border-radius:8px;margin-bottom:6px;border:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;"><span>🏢 <b>${escapeHtml(o.name)}</b></span><button class="btn btn-quick btn-small" onclick="startShiftFromBase('${o.id}')">Выбрать</button></div>`).join('');
    document.getElementById('newObjectNameInput').value = '';
    selectWorkShift(null);
    document.getElementById('startShiftModal').classList.add('open');
  }
  function closeStartShiftModal() { document.getElementById('startShiftModal').classList.remove('open'); }
  // Тип смены выбирается явно при открытии и фиксируется вместе с датой: время
  // закрытия (01:00–03:00, через 2 дня) больше не влияет на тип и дату смены.
  function selectWorkShift(kind) {
    window.__startShiftWorkShift = kind || null;
    document.querySelectorAll('#startShiftModal [data-work-shift]').forEach(b=>{const on=b.dataset.workShift===kind;b.classList.toggle('ws-selected',on);b.classList.toggle('btn-quick',on);b.setAttribute('aria-pressed',on?'true':'false');});
  }
  function requireWorkShiftChoice() {
    if (window.__startShiftWorkShift) return window.__startShiftWorkShift;
    appNotice('Дневная смена или ночная? Выберите тип смены'); return null;
  }
  async function startShiftFromBase(id) { let o=state.objects.find(x=>x.id===id); if(o) await startShiftWithObject(o.name, o.id, requireWorkShiftChoice()); }
  async function confirmStartShift() {
    if (!requireEdit('start_shift')) return; let n = document.getElementById('newObjectNameInput').value.trim(); if (!n) { appNotice('Введите имя'); return; }
    const workShift = requireWorkShiftChoice(); if (!workShift) return;
    let ex = state.objects.find(o=>o.name.toLowerCase()===n.toLowerCase());
    if (ex) await startShiftWithObject(ex.name, ex.id, workShift);
    else { try { if(isNasRuntime()){const result=await nasSaveRecord('object','',{name:n},0);await startShiftWithObject(n,result.result.id,workShift);return;}let r=refs.objects.doc(); await tfAwait(r.set({name:n, createdAt:Date.now(), createdBy:getUserName()})); await startShiftWithObject(n, r.id, workShift); } catch(e){ showError(e.message); } }
  }
  function openChangeObjectModal() {
    if (!requireEdit('edit_line') || !state.shift) return;
    let c = document.getElementById('changeObjList');
    c.innerHTML = state.objects.map(o=>{ let isC = state.shift.objectId === o.id || state.shift.objectName === o.name; return `<div style="background:var(--bg);padding:10px;border-radius:8px;margin-bottom:6px;border:1px solid ${isC?'var(--success)':'var(--border)'};display:flex;justify-content:space-between;align-items:center;"><span>🏢 <b>${escapeHtml(o.name)}</b> ${isC?'(текущий)':''}</span><button class="btn btn-quick btn-small" onclick="applyChangeObject('${o.id}')">Выбрать</button></div>`; }).join('');
    document.getElementById('changeObjCustomInput').value = ''; document.getElementById('changeObjectModal').classList.add('open');
  }
  function closeChangeObjectModal() { document.getElementById('changeObjectModal').classList.remove('open'); }
  async function applyChangeObject(id) { let o = state.objects.find(x=>x.id===id); if(!o || !state.shift) return; if (state.shift.objectId === id) { closeChangeObjectModal(); return; } try { if(isNasRuntime()){await nasBusinessCommand('control','shift-object:'+state.shift.id,{type:'shift.object',shiftId:state.shift.id,objectId:o.id,expectedObjectId:state.shift.objectId||''});await nasRefreshLine();closeChangeObjectModal();return;}await tfAwait(refs.shift.update({objectId:o.id, objectName:o.name})); addAudit(`🏢 Изменен объект: ${o.name}`).catch(()=>{}); closeChangeObjectModal(); showToastEl('Объект изменен', false); } catch(e){ showError(e.message); } }
  async function confirmChangeObject() {
    let n = document.getElementById('changeObjCustomInput').value.trim();
    if (n) { let ex = state.objects.find(o=>o.name.toLowerCase()===n.toLowerCase()); if(ex) await applyChangeObject(ex.id); else { try { if(isNasRuntime()){const result=await nasSaveRecord('object','',{name:n},0);await applyChangeObject(result.result.id);return;}let r=refs.objects.doc(); await tfAwait(r.set({name:n, createdAt:Date.now(), createdBy:getUserName()})); await applyChangeObject(r.id); } catch(e){ showError(e.message); } } } else appNotice('Выберите объект');
  }

  // === ЛИНИЯ ===
  async function addTruckToLine(id) {
    if (!requireEdit('edit_line') || !state.shift) return;
    if(isNasRuntime()){
      // Канал v2: назначение идёт через v2-транспорт, иначе сервер отвечает
      // 426. Занятый самосвал получает предупреждение или confirm перевода.
      if(typeof window.__wtAddTruckToShift==='function'){await window.__wtAddTruckToShift(id);return;}
      if(typeof nasV2ShiftsEnabled==='function'&&nasV2ShiftsEnabled()){showError('Смены ещё загружаются. Подождите немного и повторите действие.');return;}
      try{await nasChangeMembership(id,true);}catch(error){showError(error.message);}return;
    }
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
    if(isNasRuntime()){try{await nasChangeMembership(id,false);}catch(error){showError(error.message);}return;}
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
  function receiveTruckStatuses(snapshot){
    markSync('status',snapshot.metadata.fromCache,snapshot.metadata.hasPendingWrites,snapshot.size);
    if(snapshot.metadata.hasPendingWrites)return;
    const next={};snapshot.forEach(doc=>{next[doc.id]={id:doc.id,...doc.data()};});
    if(snapshot.metadata.fromCache)Object.keys(next).forEach(id=>{
      const recent=offlineRemoteStatuses[id];
      if(recent&&recent.shiftId===next[id].shiftId&&Number(recent.cycleRevision||0)>Number(next[id].cycleRevision||0))next[id]=recent;
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
  // Persistent, optimistic offline actions; server remains authoritative.
  const offlineJournalKey=()=> isNasRuntime()?'samosval_working_test_offline_nas_v1:'+nasStorageScope():'samosval_working_test_offline_v1_'+firebaseConfig.projectId+'_'+WORKSPACE_ID+'_'+currentUid;
  let offlineReplayRunning=false,offlineRemoteStatuses={},offlineRemoteLogs=[];
  function offlineJournalRead(){
    if(!currentUid)return [];
    try{const a=JSON.parse(localStorage.getItem(offlineJournalKey())||'[]');return Array.isArray(a)?a.filter(x=>x&&x.id&&x.shiftId&&x.truckId):[];}catch(e){console.error(e);return [];}
  }
  // Журнал — транспорт догона сервера, а не история. Старые версии не удаляли
  // подтверждённые записи: за месяцы работы localStorage переполнялся (~5 МБ),
  // setItem падал и погрузка не сохранялась даже в онлайне (инцидент 23.11.2026).
  // Подтверждённое сервером удаляется после доставки уведомления/аудита;
  // отменённое — после проведения игрового штрафа; отказ сервера держим только
  // непросмотренным разбором и не старше 50 последних.
  const OFFLINE_JOURNAL_MAX_REJECTED=50;
  function offlineJournalCompact(items){
    const dependencies=new Set(items.filter(x=>x&&x.status==='pending'&&x.dependencyId).map(x=>x.dependencyId));
    let unreviewed=0;
    const keep=[];
    for(let i=items.length-1;i>=0;i--){
      const x=items[i];if(!x||!x.id)continue;
      let keepIt;
      if(x.status==='pending')keepIt=true;
      else if(x.status==='confirmed')keepIt=!x.effectsDelivered;
      else if(x.status==='cancelled')keepIt=!x.penaltyDelivered;
      else if(x.status==='rejected')keepIt=!x.reviewed&&unreviewed++<OFFLINE_JOURNAL_MAX_REJECTED;
      else keepIt=false;
      if(keepIt||dependencies.has(x.id))keep.push(x);
    }
    return keep.reverse();
  }
  function offlineQuotaError(e){return !!(e&&(e.name==='QuotaExceededError'||e.code===22||/quota/i.test(String(e.message||''))));}
  function offlineJournalWrite(items){
    const pruned=offlineJournalCompact(items),key=offlineJournalKey();
    try{localStorage.setItem(key,JSON.stringify(pruned));}
    catch(e){
      if(!offlineQuotaError(e))throw e;
      // Память телефона переполнена. Пошаговая аварийная чистка: сначала
      // старые отказы и строки без незавершённых эффектов, затем — всё, кроме
      // неотправленных действий и их зависимостей (их терять нельзя).
      const dependencies=new Set(pruned.filter(x=>x.status==='pending'&&x.dependencyId).map(x=>x.dependencyId));
      const emergency=[
        pruned.filter(x=>x.status==='pending'||dependencies.has(x.id)||(x.status==='confirmed'&&!x.effectsDelivered)||(x.status==='cancelled'&&!x.penaltyDelivered)),
        pruned.filter(x=>x.status==='pending'||dependencies.has(x.id))
      ];
      for(const level of emergency){
        try{localStorage.setItem(key,JSON.stringify(level));console.warn('[offline journal] память переполнена — выполнена аварийная чистка старых записей');updateSyncUI();return;}
        catch(_){}
      }
      const failure=Error('Память устройства переполнена старыми записями: действие не удалось сохранить даже после автоматической чистки');
      failure.storageQuota=true;throw failure;
    }
    updateSyncUI();
  }
  // Одноразовая (идемпотентная) чистка раздутых ключей при старте. Старые
  // версии не удаляли подтверждённые записи журнала и писали полный аудит
  // (тысячи записей) в кеш сессии — устройство должно разблокироваться при
  // первом же открытии новой версии.
  const OFFLINE_JOURNAL_KEY_PREFIX='samosval_working_test_offline_';
  const SESSION_CACHE_KEY_PREFIX='samosval-working-test-cache-';
  const STORAGE_AUDIT_LIMIT=200;
  function storageShrinkAudit(value){
    if(Array.isArray(value.audit))value.audit=value.audit.slice(0,STORAGE_AUDIT_LIMIT);
    if(Array.isArray(value.lineAudit))value.lineAudit=value.lineAudit.slice(0,STORAGE_AUDIT_LIMIT);
    return value;
  }
  function offlineStorageQuotaMigrate(){
    try{
      const keys=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k)keys.push(k);}
      for(const key of keys){
        if(key.startsWith(OFFLINE_JOURNAL_KEY_PREFIX)){
          try{
            const items=JSON.parse(localStorage.getItem(key)||'[]');
            if(!Array.isArray(items))continue;
            const pruned=offlineJournalCompact(items);
            if(JSON.stringify(pruned)!==JSON.stringify(items)){
              if(pruned.length)localStorage.setItem(key,JSON.stringify(pruned));
              else localStorage.removeItem(key);
            }
          }catch(_){console.warn('[storage migrate] журнал не читается',key);}
        }else if(key.startsWith(SESSION_CACHE_KEY_PREFIX)){
          try{
            const raw=localStorage.getItem(key);if(!raw)continue;
            const value=storageShrinkAudit(JSON.parse(raw));
            const packed=JSON.stringify(value);
            if(packed!==raw)localStorage.setItem(key,packed);
          }catch(_){console.warn('[storage migrate] кеш не читается',key);}
        }
      }
    }catch(e){console.warn('[storage migrate]',e);}
  }
  offlineStorageQuotaMigrate();
  function offlinePendingOps(){return offlineJournalRead().filter(x=>x.status==='pending');}
  function offlinePendingForTruck(id){return offlinePendingOps().some(x=>x.truckId===id&&state.shift&&x.shiftId===state.shift.id);}
  function offlinePendingCount(){return offlinePendingOps().length;}
  // navigator.onLine is only a browser hint. Firestore may be unreachable even
  // while it remains true (Wi-Fi without internet, DNS failure, captive portal).
  let offlineServerRetryAt=0,offlineServerRetryDelay=0,offlineServerUnreachable=false;
  // Показывать «Работа локально» только если перебой длится дольше 3 секунд.
  // После смены сети (VPN, Wi-Fi <-> мобильная) связь обычно восстанавливается
  // сама, и мигающая надпись только пугает. Флаг недоступности и бэкофф повтора
  // при этом работают сразу — отложен только показ.
  const OFFLINE_UI_GRACE_MS=3000;
  let offlineStatusSince=0;
  function offlineTransportError(e){
    const code=String(e?.code||'').toLowerCase(),message=String(e?.message||'').toLowerCase();
    return ['unavailable','deadline-exceeded','network-request-failed','resource-exhausted'].includes(code)
      || /connection failed|failed to fetch|network error|network request failed/.test(message);
  }
  function offlineTransportFailed(error){
    offlineServerUnreachable=true;
    offlineServerRetryDelay=Math.min(60000,offlineServerRetryDelay?offlineServerRetryDelay*2:4000);
    offlineServerRetryAt=Date.now()+offlineServerRetryDelay;
    offlineStatusSince=Date.now();
    console.warn('[offline] Сервер недоступен, локальная очередь сохранена:',error?.code||error?.message||error);
    updateSyncUI();
  }
  function offlineTransportRecovered(){
    if(!offlineServerUnreachable&&!offlineServerRetryAt)return;
    offlineServerUnreachable=false;offlineServerRetryAt=0;offlineServerRetryDelay=0;
    offlineStatusSince=0;
    updateSyncUI();
  }
  // Очередь офлайн-команд принадлежит конкретной смене (uid/workspace разделены
  // ключом хранения в 15-shifts.js, shiftId — записями внутри него). Карточка
  // смены показывает только её очередь, dead-letter тоже scoped, а общий бейдж
  // вкладки — сумма по всем сменам текущего uid. Ни одна функция ниже не
  // подставляет «текущую» смену в чужую запись: shiftId записи неизменяем.
  const OFFLINE_ONLINE_ONLY_TYPES=['force-transfer','force_transfer','detached-complete','detached-trip-complete','complete-detached-trip'];
  function offlineV2Api(){return typeof WorkingTestOfflineV2!=='undefined'?WorkingTestOfflineV2:null;}
  function offlineIsOnlineOnlyCommand(type){
    const api=offlineV2Api();
    if(api&&typeof api.isOnlineOnlyCommand==='function')return api.isOnlineOnlyCommand(type);
    return OFFLINE_ONLINE_ONLY_TYPES.includes(String(type||''));
  }
  function offlineShiftQueue(shiftId){
    if(!shiftId)return [];
    return offlineJournalRead().filter(x=>x&&x.shiftId===shiftId);
  }
  function offlineShiftPending(shiftId){return offlineShiftQueue(shiftId).filter(x=>x.status==='pending');}
  function offlineShiftDeadLetter(shiftId){return offlineShiftQueue(shiftId).filter(x=>x.status==='rejected'&&x.deadLetter===true);}
  // Ответ сервера на повтор: permanent-отказ уходит в dead-letter этой смены,
  // разрешимый конфликт остаётся пользователю с кодом и безопасными details.
  function offlineReplayVerdict(code,details){
    const api=offlineV2Api();
    if(api&&typeof api.classifyReplayFailure==='function')return api.classifyReplayFailure({code,details,status:details&&details.status});
    return {code:String(code||'replay-failed'),permanent:false,deadLetter:false,conflict:false,details:{}};
  }
  function offlineUnreviewedFailures(shiftId){
    return (shiftId?offlineShiftQueue(shiftId):offlineJournalRead()).filter(x=>x.status==='rejected'&&!x.reviewed);
  }
  // Конверт §9: сохранено ровно то, что отправляется. Конверт собирается один
  // раз — при постановке в очередь — и при повторе не пересобирается из
  // текущего состояния экрана: ни смена, ни аккаунт его не подменяют.
  function offlineEnvelopeScope(op){
    return {uid:(op&&op.uid)||currentUid,workspaceId:(op&&op.workspaceId)||WORKSPACE_ID};
  }
  function offlineEnvelopeOf(op){
    const api=offlineV2Api();
    if(!api||typeof api.buildCommandEnvelope!=='function')return {ok:false,code:'journal-unavailable'};
    const scope=offlineEnvelopeScope(op);
    let envelope=op&&op.commandEnvelope?op.commandEnvelope:null;
    let expectedHash=op&&op.commandHash?op.commandHash:null;
    if(!envelope){
      // Старая запись без конверта (обновление PWA поверх прежней очереди):
      // конверт собирается ровно один раз и сохраняется вместе с хешем, чтобы
      // каждый следующий повтор доказывал тот же самый конверт.
      const built=api.buildCommandEnvelope(op,scope);
      if(!built.ok)return {ok:false,code:'operation-hash-conflict'};
      envelope=built.envelope;expectedHash=built.commandHash;
      const all=offlineJournalRead(),saved=all.find(x=>x.id===op.id);
      if(saved){
        saved.commandEnvelope=envelope;saved.commandHash=expectedHash;
        // Не смогли сохранить (переполнена память) — не теряем действие:
        // конверт соберётся заново в следующий раз из тех же полей записи.
        try{offlineJournalWrite(all);}catch(_){}
      }
    }
    let hash;
    try{hash=api.commandHash(envelope,scope);}catch(_){return {ok:false,code:'operation-hash-conflict'};}
    if(expectedHash&&expectedHash!==hash)return {ok:false,code:'operation-hash-conflict'};
    return {ok:true,envelope,commandHash:hash};
  }
  // Команда на провод собирается из сохранённого конверта: тело и expected
  // revisions берутся оттуда, а служебные поля записи (актёр, beforeStatus,
  // logId) остаются из журнала. Конверт и его хеш на сервер не уходят.
  function offlineCommandWire(op,envelope){
    const wire={...op};
    delete wire.commandEnvelope;delete wire.commandHash;
    Object.assign(wire,envelope.body,{id:envelope.operationId,type:envelope.commandType,shiftId:envelope.shiftId,createdAt:envelope.createdAt});
    const revisions=envelope.expectedRevisions||{};
    if(revisions.cycle!==undefined)wire.expectedRevision=revisions.cycle;
    if(revisions.ttn!==undefined)wire.expectedTtnRevision=revisions.ttn;
    if(revisions.shift!==undefined)wire.expectedShiftRevision=revisions.shift;
    if(revisions.status!==undefined)wire.expectedStatusRevision=revisions.status;
    return wire;
  }
  // Страж повтора: пока хеш сохранённого конверта не сходится с записью,
  // запрос не уходит вообще. Повреждённое или подменённое хранилище — это
  // dead-letter этой смены с кодом operation-hash-conflict, а не «примерно
  // та же» команда.
  function offlineReplayCommand(op){
    const prepared=offlineEnvelopeOf(op);
    if(!prepared.ok){
      offlineResolve(op.id,'rejected',prepared.code,{deadLetter:true});
      offlineProjectState();refreshLineViews();
      showErrorPanel('⚠️ '+escapeHtml(offlineReasonLabel(prepared.code)));
      return null;
    }
    return offlineCommandWire(op,prepared.envelope);
  }
  function offlineReasonLabel(reason){
    const reasons={
      'arrival-changed':'Прибытие уже изменено другим оператором',
      'duplicate-or-arrival-changed':'Погрузка уже учтена или прибытие изменилось. Лишний рейс не добавлен',
      'previous-action-rejected':'Предыдущее действие не подтверждено сервером',
      'cycle-time':'Не истекло установленное время ходки',
      'ttn-changed':'Статус ТТН изменён другим оператором',
      'duplicate':'Повторный рейс не добавлен',
      'already-exists':'Рейс с таким номером уже существует',
      'shift-changed':'Смена завершена или изменена',
      'not-on-line':'Самосвал снят с линии',
      'shift-closed':'Смена уже закрыта — действие не отправлено',
      'not-shift-member':'Вы больше не участник этой смены',
      'protocol-upgrade-required':'Обновите приложение: сервер требует новый протокол',
      'revision-conflict':'Данные уже изменились другим оператором',
      'truck-not-on-shift':'Самосвал переведён в другую смену',
      'online-only-command':'Действие доступно только при связи с сервером',
      'operation-hash-conflict':'Повтор с другими данными отклонён'
    };
    return reasons[reason]||('Ошибка: '+String(reason||'неизвестная'));
  }
  function offlineLocalTicker(){
    if(!state.shift)return null;
    const op=offlineShiftPending(state.shift.id).slice(-1)[0];if(!op)return null;
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
    // Проекция читает очередь только выбранной смены: записи соседней смены
    // того же uid не попадают в её карточку.
    for(const op of offlineShiftPending(state.shift?.id||'')){
      if(!state.shift||!statuses[op.truckId])continue;
      if(op.type==='reset'&&statuses[op.truckId].lastResetOperationId===op.id)continue;
      if(op.type==='load'&&(statuses[op.truckId].lastLoadLogId===op.logId||logs.some(l=>l.id===op.logId)))continue;
      if(op.type==='arrive'&&op.wantArrived!==false&&Number(statuses[op.truckId].arriveTimestamp||0)===Math.max(Number(op.createdAt),Number(op.lastLoadTimestamp||0)+1)&&statuses[op.truckId].arriveBy===op.actor)continue;
      const p=offlineProjection(statuses[op.truckId],op);statuses[op.truckId]=p.status;
      if(p.log&&!logs.some(l=>l.id===op.logId))logs.push(p.log);
    }
    state.truckStatus=statuses;state.logs=logs.sort((x,y)=>(y.timestamp||0)-(x.timestamp||0));offlineProjectTicker();
  }
  function offlineQueueAction(type,id,intent){
    // Принудительный перевод и завершение detached trip меняют сразу две смены:
    // их cross-shift CAS нельзя подтвердить из очереди (design §9). Офлайн-
    // попытка остаётся read-only с причиной и ничего не пишет на устройство.
    if(offlineIsOnlineOnlyCommand(type)){showError(offlineReasonLabel('online-only-command'));return false;}
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
        truckName:truck.brand+' '+truck.number,volume:truck.isGAI?0:truck.defaultVol,isGAI:!!truck.isGAI,status:'pending',
        // Конверт v2: scope и тип команды фиксируются при постановке в очередь и
        // при повторе не подменяются ни аккаунтом, ни выбранной сменой.
        protocolVersion:2,uid:currentUid,workspaceId:WORKSPACE_ID,commandType:type};
      if(type==='load')op.logId='load_'+id+'_'+op.shiftId+'_cycle_'+op.expectedRevision+'_'+op.arrivalTimestamp;
      if(isNasRuntime())op.operationScope=nasStorageScope();
      // Канонический конверт §9 сохраняется вместе с записью: при повторе
      // уходит именно он, а не тело, собранное заново из текущего экрана.
      const v2api=offlineV2Api();
      if(v2api&&typeof v2api.buildCommandEnvelope==='function'){
        const built=v2api.buildCommandEnvelope(op,{uid:currentUid,workspaceId:WORKSPACE_ID});
        if(built.ok){op.commandEnvelope=built.envelope;op.commandHash=built.commandHash;}
      }
      items.push(op);offlineJournalWrite(items); // Commit locally first; never silently lose an action.
      try{window.__gameCoinQueued?.(op);}catch(e){console.warn('[game animation]',e);}
      const old=state.truckStatus[id];offlineProjectState();signalLineTransition(id,old,state.truckStatus[id]);refreshLineViews();
      const label=type==='reset'?'🔄 Сброс таймера':type==='load'?'⚡ Погрузка':type==='ttn'?(op.collect?'📄 Забрал ТТН':'↩️ Снял ТТН'):(op.wantArrived?'🚛 Приехал':'↩️ Снял прибытие');
      showToastEl(label+' · '+truckLabelHtml(id),false);
      if(navigator.onLine)offlineReplayJournal();
      return true;
    }catch(e){
      if((e&&e.storageQuota)||offlineQuotaError(e))offlineShowQuotaPanel(e);
      else showError('Действие не сохранено на устройстве: '+(e.message||e));
      return false;
    }
  }
  function offlineResolve(id,status,reason,extra){
    const all=offlineJournalRead(),op=all.find(x=>x.id===id);
    if(op&&op.status==='pending'){
      op.status=status;op.result=reason;op.resolvedAt=Date.now();
      // Permanent-отказ (закрытая смена, снятый участник, старый протокол)
      // помечается dead-letter этой смены: очередь не переигрывает его молча.
      if(extra&&extra.deadLetter)op.deadLetter=true;
      if(extra&&extra.details)op.rejectionDetails=extra.details;
      offlineJournalWrite(all);
      // Подтверждённая запись удаляется из журнала компакцией в offlineJournalWrite,
      // как только уведомление/аудит доставлены (effectsDelivered) — сервер уже
      // владеет данными, а вечный рост журнала переполнял память телефона.
    }
  }
  // Квота localStorage: панель по центру экрана с человеческим текстом;
  // техническая причина — мелким текстом внутри панели (класс error-panel-tech),
  // а не в заголовке. Флаг storageQuota ставит offlineJournalWrite после
  // неудачной аварийной чистки (её текст не содержит слова «quota»).
  function offlineShowQuotaPanel(e){
    showErrorPanel('Не удалось сохранить погрузку. Память телефона переполнена старыми записями — попробуйте ещё раз, приложение почистит их автоматически.'
      +'<div class="error-panel-tech">'+escapeHtml((e&&e.message)||String(e))+'</div>');
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
    if(isNasRuntime())return replayNasOfflineJournal();
    const sessionGeneration = authSessionGeneration;
    const sessionIsCurrent = () => sessionGeneration === authSessionGeneration;
    if(offlineReplayRunning||!navigator.onLine||!currentUid||!permissionsLoaded||currentUserStatus!=='active'||!profileServerConfirmed||!permissionsServerConfirmed||Date.now()<offlineServerRetryAt||syncState.pendingWrites.status||syncState.pendingWrites.shift)return;
    offlineReplayRunning=true;
    try{
      for(const op of offlineJournalRead().filter(x=>x.status==='confirmed'&&!x.effectsDelivered)) {
        // A confirmed operation from a closed/replaced shift must never emit
        // notifications or audit into the newly restored shift.
        if (state.shift?.id && op.shiftId !== state.shift.id) continue;
        offlineNotifyAccepted(op,op.savedResult||{}).catch(e=>console.warn('[offline effects]',e));
      }
      // Re-read the durable journal after each operation. A user can enqueue a
      // dependent action while this replay is already running; iterating a
      // one-time snapshot would leave that new action pending until another
      // online event or reload.
      while(true){
        // Сначала досылаем очередь выбранной смены, потом фоновые: карточка
        // смены и её счётчик относятся ровно к её записям.
        let op=offlineShiftPending(state.shift?.id||'')[0]||offlinePendingOps()[0];
        if(!op)break;
        if(!sessionIsCurrent()||!navigator.onLine||currentUserStatus!=='active')break;
        if(!offlineJournalRead().some(x=>x.id===op.id&&x.status==='pending'))continue;
        if(op.dependencyId){
          const previous=offlineJournalRead().find(x=>x.id===op.dependencyId);
          if(previous?.status==='pending')break;
          if(previous?.status==='rejected'){
            offlineResolve(op.id,'rejected','previous-action-rejected');offlineProjectState();refreshLineViews();continue;
          }
        }
        // Перед отправкой сверяется хеш сохранённого конверта. Расхождение —
        // dead-letter без запроса; сама отправка идёт ровно сохранённым телом.
        const command=offlineReplayCommand(op);
        if(!command)continue;
        op=command;
        try{
          if(!sessionIsCurrent())break;
          const result=await db.runTransaction(async tx=>{
          if(!sessionIsCurrent()||currentUserStatus!=='active'||!profileServerConfirmed||!permissionsServerConfirmed){
            throw {code:'auth-session-stale',message:'Сессия изменилась до чтения настроек'};
          }
          const policy=await tx.get(appConfigRef);
          if(!sessionIsCurrent()||currentUserStatus!=='active'||!profileServerConfirmed||!permissionsServerConfirmed){
            throw {code:'auth-session-stale',message:'Сессия изменилась при чтении настроек'};
          }
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
                return {outcome:'rejected',reason:'duplicate',status:before};
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
          if(!sessionIsCurrent())break;
          offlineTransportRecovered();offlineAdoptResult(op,result);
          {const all=offlineJournalRead(),saved=all.find(x=>x.id===op.id);if(saved){saved.savedResult={status:result.status||null,beforeStatus:result.beforeStatus||op.beforeStatus,log:result.log||null};offlineJournalWrite(all);}}
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
            offlineNotifyAccepted(op,result).catch(e=>console.warn('[offline effects]',e));
          }else showErrorPanel('⚠️ '+escapeHtml(offlineReasonLabel(result.reason)));
        }catch(e){
          if(e.code==='auth-session-stale')break;
          if(offlineTransportError(e)){offlineTransportFailed(e);break;}
          if(!navigator.onLine||['aborted','cancelled'].includes(e.code)){offlineServerRetryAt=Date.now()+1500;break;}
          const verdict=offlineReplayVerdict(e.code||e.message||'error',e.serverDetails||e.details||{});
          offlineResolve(op.id,'rejected',verdict.code,{deadLetter:verdict.deadLetter,details:verdict.details});offlineProjectState();refreshLineViews();
          const label=e.message||offlineReasonLabel(verdict.code);
          showToastEl('⚠️ Офлайн-действие отклонено: '+escapeHtml(label),true);
          showErrorPanel('⚠️ Офлайн-действие отклонено: '+escapeHtml(label));
        }
      }
    }finally{
      offlineReplayRunning=false;updateSyncUI();
      // A second action can be queued while this replay is in flight. The
      // enqueue call coalesces while the lock is held, so drain the durable
      // journal once the lock is released instead of waiting for reload/reconnect.
      if (navigator.onLine && offlinePendingCount() > 0) queueMicrotask(() => offlineReplayJournal());
    }
  }
  // Offline-first operations. The UI moves immediately; the journal replays
  // through server transactions even when navigator.onLine incorrectly says true.
  // Офлайн-очередь принимает только обычные line-команды выбранной смены.
  // Принудительный перевод и завершение detached trip — online-only (§9):
  // их cross-shift CAS нельзя подтвердить из очереди, поэтому офлайн-попытка
  // остаётся read-only с причиной и ничего не ставит в очередь.
  function queueLineCommand(type,id,intent){
    if(offlineIsOnlineOnlyCommand(type)){showError(offlineReasonLabel('online-only-command'));return false;}
    if(!state.shift||!intent||intent.shiftId!==state.shift.id)return false;
    return offlineQueueAction(type,id,intent);
  }
  async function performLoad(id,capturedIntent){
    if(!requireEdit('action_load')||loadInFlight[id]||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=capturedIntent||captureLineIntent(id);
    if(!intent)return {outcome:'ignored'};
    return {outcome:queueLineCommand('load',id,intent)?'queued':'failed'};
  }
  async function toggleArrive(id,capturedIntent){
    if(!requireEdit('action_arrive')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=capturedIntent||captureLineIntent(id);
    if(!intent)return {outcome:'ignored'};
    return {outcome:queueLineCommand('arrive',id,intent)?'queued':'failed'};
  }
  async function toggleTtn(id,capturedIntent){
    if(!requireEdit('action_ttn')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=capturedIntent||captureLineIntent(id);
    if(!intent)return {outcome:'ignored'};
    return {outcome:queueLineCommand('ttn',id,intent)?'queued':'failed'};
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

  // Явный реестр хуков Линии вместо подмен window.renderLine из фич.
  // Все модули канала выполняются в общем глобальном скоупе, поэтому фичи
  // вызывают registerLineHook напрямую. Хук оборачивает ТЕКУЩИЙ
  // window.renderLine (включая анимационную версию из anim-speeds), так что
  // порядок эффектов задаётся порядком регистрации и совпадает с прежними
  // вложенными обёртками: line-motion-test → offline-feedback → anim-speeds.
  // before и after одной регистрации делят общий объект ctx: before может
  // положить туда состояние, after — прочитать (в т.ч. ctx.error).
  const registeredLineHooks = [];
  function registerLineHook(phaseOrSpec, maybeFn) {
    const spec = (typeof phaseOrSpec === 'object' && phaseOrSpec !== null)
      ? phaseOrSpec
      : { [phaseOrSpec]: maybeFn };
    if (typeof spec.before !== 'function' && typeof spec.after !== 'function') return () => {};
    const original = window.renderLine;
    const entry = { spec, original, wrapped: null };
    entry.wrapped = function () {
      const ctx = {};
      if (typeof spec.before === 'function') {
        try { spec.before(ctx); } catch (e) { console.error('[line-hook:before]', e); }
      }
      let result, failed = false;
      try { result = original.apply(this, arguments); }
      catch (e) { ctx.error = e; failed = true; }
      ctx.result = result;
      if (typeof spec.after === 'function') {
        try { spec.after(ctx); } catch (e) { console.error('[line-hook:after]', e); }
      }
      if (failed) throw ctx.error;
      return result;
    };
    registeredLineHooks.push(entry);
    window.renderLine = entry.wrapped;
    return () => {
      const i = registeredLineHooks.indexOf(entry);
      if (i < 0) return;
      registeredLineHooks.splice(i, 1);
      if (window.renderLine === entry.wrapped) window.renderLine = entry.original;
    };
  }
  // === П4: заморозка пересборки линии при удержании/касании ===
  // Карточки линии пересобираются через innerHTML; событие другого оператора
  // могло уничтожить кнопку прямо во время удержания (holdTimer из core/17
  // применяется к верному id, но кнопка «уезжала» из-под пальца). Пока идёт
  // удержание (кнопка .holding) или касание контейнера линии (pointerdown до
  // pointerup/cancel + грейс ~400 мс), перерисовка откладывается: расписание
  // renderLine (scheduleRenderLine в core/04) при активном флаге только
  // запоминает долг, а после снятия флага вызывает __lineFlushDeferred —
  // ни одно чужое действие не теряется, перерисовка выполняется позже.
  const LINE_HOLD_GRACE_MS = 400;
  let linePointerDown = false, linePointerGraceTimer = null;
  function lineHoldActive() {
    const holding = (typeof document.querySelector === 'function') ? !!document.querySelector('.holding') : false;
    return holding || linePointerDown || linePointerGraceTimer !== null;
  }
  window.__lineHoldActive = lineHoldActive;
  function linePointerEnd() {
    if (!linePointerDown) return;
    linePointerDown = false;
    clearTimeout(linePointerGraceTimer);
    linePointerGraceTimer = setTimeout(() => {
      linePointerGraceTimer = null;
      if (!lineHoldActive() && typeof window.__lineFlushDeferred === 'function') window.__lineFlushDeferred();
    }, LINE_HOLD_GRACE_MS);
  }
  // Регистрация слушателей вынесена за пределы vm-моков юнит-тестов
  // (truck-phone-line.test.mjs исполняет этот файл без document.addEventListener).
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('pointerdown', e => {
      const t = e.target;
      if (t && typeof t.closest === 'function' && t.closest('#trucksLineList')) {
        linePointerDown = true;
        clearTimeout(linePointerGraceTimer);
        linePointerGraceTimer = null;
      }
    }, true);
    document.addEventListener('pointerup', linePointerEnd, true);
    document.addEventListener('pointercancel', linePointerEnd, true);
  }

  // Ключ последнего отрисованного порядка карточек: FLIP-анимация сдвига
  // нужна только когда порядок реально изменился.
  let renderLineOrderKey = null;
  // Ключ значимых данных последней отрисовки линии (страховка от лишних
  // пересборок карточек при неизменном снапшоте).
  let renderLineDataKey = null;
  function renderLine() {
    let sc = document.getElementById('startShiftContainer'), ac = document.getElementById('activeShiftContainer'), cb = document.getElementById('changeObjBtn');
    if (!state.shift) { sc.style.display = (hasPermission('start_shift') || hasTabAccess('timesheet')) ? 'block' : 'none'; ac.style.display = 'none'; cb.style.display = 'none'; return; }
    sc.style.display = 'none'; ac.style.display = 'block'; cb.style.display = hasPermission('edit_line') ? 'inline-block' : 'none';
    let c = document.getElementById('trucksLineList'), oldP = {};
    c.querySelectorAll('.truck-card[data-truck-id]').forEach(x => oldP[x.dataset.truckId] = x.getBoundingClientRect().top);
    let ids = getActiveLineIds(); if (!ids.length) { c.innerHTML = '<div class="form-card" style="text-align:center;color:var(--muted);">Нет машин</div>'; return; }
    let logs = getLogs(), lastTs = {}; logs.forEach(l => { if (lastTs[l.truckId] === undefined) lastTs[l.truckId] = l.timestamp||0; });
    let trucks = ids.map(id => findTruck(id)).filter(Boolean);
    trucks.sort((a,b)=>{ let sA=state.truckStatus[a.id], sB=state.truckStatus[b.id]; let tA=sA.ttnStatus===true?1:0, tB=sB.ttnStatus===true?1:0; if(tA!==tB) return tA-tB; let aA=sA.arriveStatus?1:0, aB=sB.arriveStatus?1:0; if(aA!==aB) return aB-aA; let lA=lastTs[a.id]||0, lB=lastTs[b.id]||0; if(lA===0&&lB===0) return 0; if(lA===0) return -1; if(lB===0) return 1; return lA-lB; });
    let now = Date.now(), cyc = (settings.cycleMinutes||15)*60000;
    let canEditArrive = hasPermission('action_arrive'), canEditLoad = hasPermission('action_load'), canEditTtn = hasPermission('action_ttn'); let showStats = hasPermission('view_card_stats');
    // Страховка: если значимые для разметки данные не изменились, карточки не
    // пересобираются вообще. Таймеры внутри карточек обновляет tickTimers.
    let stats = {}; logs.forEach(l => { stats[l.truckId] = stats[l.truckId] || { n: 0, v: 0, ts: 0 }; stats[l.truckId].n++; stats[l.truckId].v += l.volume; if ((l.timestamp||0) > stats[l.truckId].ts) stats[l.truckId].ts = l.timestamp||0; });
    let renderKey = JSON.stringify([trucks.map(t => { let st = state.truckStatus[t.id]||{}; let lastL = st.lastLoadTimestamp||0; let s = stats[t.id]||{n:0,v:0,ts:0};
      return [t.id, t.brand, t.number, t.defaultVol, !!t.isGAI, !!st.arriveStatus, st.arriveTimestamp||0, st.arriveBy||'', lastL, lastL > 0 && (now-lastL) < cyc, st.ttnStatus===true, s.n, s.v, s.ts, offlinePendingForTruck(t.id)]; }),
      canEditArrive, canEditLoad, canEditTtn, showStats, typeof truckPhoneEntry==='function' ? trucks.map(t=>truckPhoneEntry(t.id)) : null]);
    if (renderKey === renderLineDataKey) return;
    renderLineDataKey = renderKey;
    // Порядок карточек не изменился — пересортировка FLIP не нужна: таймеры
    // ходки пересортировывают список каждый рендер, и анимация сдвига
    // запускалась даже когда карточки остались на своих местах.
    const orderKey = trucks.map(t => t.id).join('|');
    const flipNeeded = renderLineOrderKey === null || renderLineOrderKey !== orderKey;
    renderLineOrderKey = orderKey;
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
      return `<div class="truck-card ${isA?'arrived':''} ${faded?'faded':''}" data-truck-id="${t.id}"><div class="truck-header"><div class="truck-name" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><b>${escapeHtml(t.brand)}</b>${renderRussianPlate(t.number)}<span style="font-size:13px;color:var(--muted);">${isGAI?'': '('+t.defaultVol+' м³)'}</span>${isA?`<span style="color:#f59e0b;font-size:12px;">(${escapeHtml(st.arriveBy||'')})</span>`:''}${offlineFlag?`<span style="font-size:10px;font-weight:700;color:#f59e0b;">☁️ ОФЛАЙН</span>`:''}</div>${truckPhoneIcon(t)}${statsHtml}</div><div class="last-load-info">⏱ Последняя: <b class="time-ago-card" data-timestamp="${lTs}">${lTs>0?formatTimeAgo(lTs):'—'}</b></div><div class="action-row">${arrBtn}<button class="btn btn-quick" ${!canEditLoad||!isA?'disabled':''} ${canEditLoad&&isA?`onpointerdown="startQuickLoadHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''}>${loadBtnTxt}</button><button class="btn btn-ttn ${ttn?'active-ttn':''}" ${!canEditTtn?'disabled':''} ${canEditTtn?`onpointerdown="startTtnHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''}>${ttnTxt}</button></div></div>`;
    }).join('');
    if (flipNeeded && Object.keys(oldP).length) {
      c.querySelectorAll('.truck-card').forEach(card => { let old = oldP[card.dataset.truckId]; if(old === undefined) return; let delta = old - card.getBoundingClientRect().top;
        if(Math.abs(delta) > 2) { card.style.transform=`translateY(${delta}px)`; card.style.transition='none'; void card.offsetWidth; setTimeout(()=>{ requestAnimationFrame(()=>{ card.style.transition='transform 2.4s cubic-bezier(0.4,0,0.2,1)'; card.style.transform=''; setTimeout(()=>card.style.transition='', 2450); }); }, 1000); }
      });
    }
  }

  window.addEventListener('working-test-tabel-v2-records-change', () => scheduleRender('renderHeaderStats'));
  // Шапка всегда показывает объект, календарную дату и тип выбранной смены
  // (design §10.1). v1 хранит дату в startDate, v2 — в workDate (ГГГГ-ММ-ДД);
  // тип приходит только от смены, а не выводится из времени.
  const SHIFT_TYPE_HEADER = { day: 'День', night: 'Ночь' };
  function shiftHeaderText() {
    if (!state.shift) return 'Смена не начата';
    const raw = String(state.shift.workDate || state.shift.startDate || '');
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const date = iso ? iso[3] + '.' + iso[2] + '.' + iso[1] : raw;
    // v1 line snapshot хранит тот же факт как workShift/type, v2-документ — как
    // shiftType. Без алиасов тип пропадал из шапки после любого v1-обновления,
    // хотя сама смена не менялась.
    const type = SHIFT_TYPE_HEADER[state.shift.shiftType || state.shift.workShift || state.shift.type] || '';
    return ['Смена от ' + (date || '—'), type].filter(Boolean).join(' · ');
  }
  function renderHeaderStats() {
    window.dispatchEvent(new Event('line-equipment-change'));
    let d = shiftHeaderText(); let o = state.shift ? objectTitle(state.shift.objectId,state.shift.objectName) : 'Не выбран';
    let act = state.shift ? getActiveLineIds().filter(id => { let t = findTruck(id); if (!t || t.isGAI) return false; return !state.truckStatus[id] || state.truckStatus[id].ttnStatus !== true; }).length : 0;
    let logs = getLogs(); let stdLogs = logs.filter(l => !l.isGAI); let v = stdLogs.reduce((s,l)=>s+l.volume,0);
    document.getElementById('shiftDate').textContent = d; document.getElementById('headerObject').textContent = 'Объект: ' + o;
    document.getElementById('activeLineCount').textContent = act + ' маш.'; document.getElementById('totalTrips').textContent = stdLogs.length; document.getElementById('totalVolume').textContent = v + ' м³';
    const tabelCounts=document.getElementById('tabelV2Counts');if(tabelCounts&&permissionsLoaded&&hasTabAccess('timesheet'))import(new URL('./working-test/tabel-v2/summary.mjs',document.baseURI).href).then(m=>m.updateHeader(isNasRuntime()?nasTabelHost():{session:()=>({projectId:firebaseConfig.projectId,workspaceId:WORKSPACE_ID,uid:currentUid,role:currentUserRole,active:currentUserStatus==='active',view:hasTabAccess('timesheet')}),snapshot:()=>({shift:state.shift,trucks:state.trucks,statuses:state.truckStatus,logs:state.logs,audit:state.audit,lineAudit:state.lineAudit,archive:state.archive})},tabelCounts)).catch(()=>{tabelCounts.hidden=true;});else if(tabelCounts)tabelCounts.hidden=true;
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
  // Единая точка ветвления транспорта сохранения: в рабочей версии все
  // записи идут через сервер Ubuntu (nasProvider всегда 'ubuntu'), поэтому
  // firebase-ветки из функций сохранения удалены — ветвление живёт здесь.
  async function saveLineEvent(nasWork) {
    if (!isNasRuntime()) throw Error('Сохранение доступно только через сервер Ubuntu');
    return nasWork();
  }
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
      const editedId = id;
      await saveLineEvent(()=>nasSaveRecord('truck',id,{brand,number:num,defaultVol:isGAI?0:vol,isGAI},Number(document.getElementById('editTruckId').dataset.nasRevision)));
      await saveTruckPhoneFromBase(editedId);
      cancelEditTruck();
    } catch(e) { showError(e.message); }
  }
  // Телефон и имя водителя сохраняются отдельной записью: сбой телефона не отменяет
  // сохранение самого самосвала. Пустое поле телефона = «телефон не менять».
  async function saveTruckPhoneFromBase(id) {
    if(!id || !hasPermission('view_truck_phone') || !hasPermission('add_truck_phone')) return;
    // Телефон живёт только на Ubuntu-бэкенде: в firebase-режиме поля не сохраняем.
    if(typeof isNasRuntime === 'function' && !isNasRuntime()) return;
    const field = document.getElementById('newTruckPhone'); if(!field) return;
    if(!String(field.value||'').trim()) return;
    const phone = truckPhoneNormalizeInput(field.value);
    if(!phone) { appNotice('Телефон не сохранён: нужен номер с плюсом и 8–15 цифрами'); return; }
    const nameField = document.getElementById('newTruckDriver');
    const driverName = truckPhoneCleanName(nameField ? nameField.value : '');
    if(driverName === undefined) { appNotice('Телефон не сохранён: в имени допустимы буквы, цифры, пробел, точка, дефис, апостроф (до 80)'); return; }
    try { await truckPhoneRequest({ truckId:id, phone, driverName }); }
    catch(e) { showError('Телефон не сохранён: ' + (e && e.message ? e.message : 'ошибка')); }
  }
  function fillTruckPhoneFields(id) {
    const phoneGroup = document.getElementById('truckPhoneGroup'), driverGroup = document.getElementById('truckDriverGroup');
    const phoneField = document.getElementById('newTruckPhone'), driverField = document.getElementById('newTruckDriver');
    if(!phoneGroup || !driverGroup || !phoneField || !driverField) return;
    const canView = hasPermission('view_truck_phone'), canEdit = canView && hasPermission('add_truck_phone');
    const entry = canView ? truckPhoneEntry(id) : null;
    phoneGroup.style.display = canView ? 'block' : 'none';
    driverGroup.style.display = canView ? 'block' : 'none';
    phoneField.value = entry && entry.phone ? entry.phone : '';
    driverField.value = entry && entry.driverName ? entry.driverName : '';
    phoneField.disabled = !canEdit; phoneField.readOnly = !canEdit;
    driverField.disabled = !canEdit; driverField.readOnly = !canEdit;
  }
  function editGlobalTruck(id) {
    if(!requireEdit('manage_trucks')) return; let t=findTruck(id); if(!t) return;
    document.getElementById('editTruckId').dataset.nasRevision=String(nasRecordRevision('truck',id)||'');document.getElementById('editTruckId').value=t.id; document.getElementById('newTruckType').value=t.isGAI?'gai':'regular';
    document.getElementById('newTruckBrand').value=t.brand; document.getElementById('newTruckNumber').value=t.number; document.getElementById('newTruckVol').value=t.defaultVol||'';
    document.getElementById('formCardTitle').textContent='Редактировать'; document.getElementById('saveTruckBtn').textContent='💾 Сохранить'; document.getElementById('cancelEditBtn').style.display='block'; window.scrollTo(0,0); toggleVolInput();
    fillTruckPhoneFields(t.id);
    if(hasPermission('view_truck_phone')&&!truckPhoneEntry(t.id))truckPhoneRequest().then(()=>{if(document.getElementById('editTruckId').value===t.id)fillTruckPhoneFields(t.id);}).catch(()=>{});
  }
  function cancelEditTruck() {
    document.getElementById('editTruckId').value=''; document.getElementById('newTruckType').value='regular'; document.getElementById('newTruckBrand').value=''; document.getElementById('newTruckNumber').value=''; document.getElementById('newTruckVol').value='';
    const phoneGroup=document.getElementById('truckPhoneGroup'),driverGroup=document.getElementById('truckDriverGroup'),phoneField=document.getElementById('newTruckPhone'),driverField=document.getElementById('newTruckDriver');
    if(phoneGroup)phoneGroup.style.display='none'; if(driverGroup)driverGroup.style.display='none';
    if(phoneField){phoneField.value='';phoneField.disabled=true;phoneField.readOnly=true;} if(driverField){driverField.value='';driverField.disabled=true;driverField.readOnly=true;}
    document.getElementById('formCardTitle').textContent='Добавить самосвал'; document.getElementById('saveTruckBtn').textContent='➕ Добавить'; document.getElementById('cancelEditBtn').style.display='none'; toggleVolInput();
  }
  function toggleVolInput() { document.getElementById('volumeGroup').style.display = document.getElementById('newTruckType').value === 'gai' ? 'none' : 'block'; }
  async function deleteGlobalTruck(id) {
    if(!requireEdit('manage_trucks')) return; let t=findTruck(id); if(!t || !(await appConfirm('Удалить?'))) return;
    try { await saveLineEvent(()=>nasDeleteRecord('truck',id,nasRecordRevision('truck',id))); } catch(e){ showError(e.message); }
  }
  async function saveObjectToBase() {
    if (!requireEdit('manage_objects')) return;
    let id = document.getElementById('editObjectId').value, name = document.getElementById('newObjectNameBase').value.trim();
    if (!name) { appNotice('Введите имя'); return; }
    try { await saveLineEvent(()=>nasSaveRecord('object',id,{name},Number(document.getElementById('editObjectId').dataset.nasRevision)));cancelEditObject(); } catch(e){ showError(e.message); }
  }
  function editGlobalObject(id) { if(!requireEdit('manage_objects')) return; let o=state.objects.find(x=>x.id===id); if(!o) return; document.getElementById('editObjectId').dataset.nasRevision=String(nasRecordRevision('object',id)||'');document.getElementById('editObjectId').value=o.id; document.getElementById('newObjectNameBase').value=o.name; document.getElementById('formObjectCardTitle').textContent='Редактировать'; document.getElementById('saveObjectBtn').textContent='💾 Сохранить'; document.getElementById('cancelEditObjectBtn').style.display='block'; window.scrollTo(0,0); }
  function cancelEditObject() { document.getElementById('editObjectId').value=''; document.getElementById('newObjectNameBase').value=''; document.getElementById('formObjectCardTitle').textContent='Добавить объект'; document.getElementById('saveObjectBtn').textContent='➕ Добавить'; document.getElementById('cancelEditObjectBtn').style.display='none'; }
  async function deleteGlobalObject(id) {
    if(!requireEdit('manage_objects')) return; let o=state.objects.find(x=>x.id===id); if(!o || !(await appConfirm('Удалить?'))) return;
    try { await saveLineEvent(()=>nasDeleteRecord('object',id,nasRecordRevision('object',id))); } catch(e){ showError(e.message); }
  }

  // === АДМИН ПАНЕЛЬ ===
  const userAccessWrites=new Set();
  // Черновик ника: ввод живёт в поле до явного «Сохранить». Фоновые
  // перестроения списка (nasActiveRefresh ~15 с, снапшоты users/requests)
  // не должны уничтожать напечатанный текст: пока поле в фокусе,
  // перерисовка откладывается (паттерн refreshIncoming из
  // tabel-v2/workspace.mjs), а при перестроении значения и фокус полей
  // переживают innerHTML (сохранение/восстановление по data-nickname-uid).
  // Ф1 (1.8.1): то же удержание действует для select роли — открытый
  // список ролей не должен закрываться фоновой перерисовкой; выбор роли
  // по-прежнему отправляется мгновенно по onchange.
  // Ф2 (1.8.1): кнопки «Сохранить/Отмена» скрыты, пока не начат ввод ника.
  const nicknameDrafts=new Set();
  let adminDraftHoldTimer=null;
  function adminDraftFieldActive() {
    const active=document.activeElement, container=document.getElementById('usersListContainer');
    if (!active || typeof active.matches!=='function' || !container || typeof container.contains!=='function' || !container.contains(active)) return false;
    return active.matches('input:not([readonly]),textarea,select[data-role-uid]');
  }
  function adminDraftHoldActive() { return adminDraftFieldActive(); }
  function scheduleRenderAdminPanel() {
    clearTimeout(adminDraftHoldTimer);
    adminDraftHoldTimer=setTimeout(()=>{adminDraftHoldTimer=null;renderAdminPanel();},1000);
  }
  function collectDraftFields(container) {
    const drafts={};
    container.querySelectorAll('[data-nickname-uid]').forEach(f=>drafts[f.dataset.nicknameUid]={value:f.value,focused:f===document.activeElement});
    return drafts;
  }
  function restoreDraftFields(container,drafts) {
    container.querySelectorAll('[data-nickname-uid]').forEach(f=>{const d=drafts[f.dataset.nicknameUid];if(!d)return;f.value=d.value;if(d.focused)f.focus();});
  }
  // Ф2: кнопки «Сохранить/Отмена» видны только у полей с несохранённым
  // вводом. Признак «идёт ввод» — nicknameDrafts (uid), переживает
  // фоновые перерисовки, очищается сохранением/отменой.
  function setNicknameActionsVisible(container) {
    container.querySelectorAll('[data-nickname-uid]').forEach(f=>{
      const actions=f.parentElement?.querySelector('[data-nickname-actions]');
      if (actions) actions.style.display=nicknameDrafts.has(f.dataset.nicknameUid)?'inline-flex':'none';
    });
  }
  function onNicknameInput() {
    const uid=this.dataset.nicknameUid;
    const original=state.users.find(u=>u.id===uid)?.nickname||'';
    if (this.value!==original) nicknameDrafts.add(uid); else nicknameDrafts.delete(uid);
    const actions=this.parentElement?.querySelector('[data-nickname-actions]');
    if (actions) actions.style.display=nicknameDrafts.has(uid)?'inline-flex':'none';
  }
  function cancelUserNicknameDraft(uid) {
    const field=document.querySelector('[data-nickname-uid="'+uid+'"]');
    const original=state.users.find(u=>u.id===uid)?.nickname||'';
    if (field) field.value=original;
    nicknameDrafts.delete(uid);
    const actions=field?.parentElement?.querySelector('[data-nickname-actions]');
    if (actions) actions.style.display='none';
  }
  function renderAdminPanel() {
    if (!canAdmin()) return;
    renderRegistrationRequests();
    if (adminDraftHoldActive()) { scheduleRenderAdminPanel(); return; }
    const active = state.users.filter(u => u.status !== 'pending');
    const container=document.getElementById('usersListContainer');
    const drafts=collectDraftFields(container);
    container.innerHTML = active.map(u => { const isMe = u.id === currentUid; const isLocked = isNasRuntime()?u.protected===true:isForcedAdminEmail(u.email); const accessible=u.status!=='disabled'; return `<div class="user-row ${accessible?'':'user-access-limited'}"> <div class="user-row-top"><div class="user-email">${escapeHtml(u.email)}</div><div style="display:flex;gap:4px;align-items:center;"><input type="text" class="form-control" style="width:100px; padding:4px; font-size:12px;" data-nickname-uid="${escapeHtml(u.id)}" value="${escapeHtml(u.nickname||'')}" aria-label="Ник: ${escapeHtml(u.email)}"><span data-nickname-actions style="display:none;gap:4px;align-items:center;"><button type="button" class="btn btn-secondary btn-small" style="padding:4px 10px; font-size:12px; min-height:0;" data-nickname-cancel="${escapeHtml(u.id)}">Отмена</button><button type="button" class="btn btn-secondary btn-small" style="padding:4px 10px; font-size:12px; min-height:0;" data-nickname-save="${escapeHtml(u.id)}">Сохранить</button></span></div></div><div class="user-row-bottom"><select class="form-control" data-role-uid="${escapeHtml(u.id)}" onchange="changeUserRole('${u.id}', this.value)">${Object.keys(ROLES).map(r=>`<option value="${r}" ${r===u.role?'selected':''}>${ROLES[r].label}</option>`).join('')}</select>${!isMe&&!isLocked?`<button class="btn-del" onclick="deleteUser('${u.id}')">Удалить</button>`:''}</div><div class="user-access-row"><span>${accessible?'Доступ разрешён':'Доступ ограничен'}${isMe?'<small>Ваша учётная запись</small>':isLocked?'<small>Владелец приложения</small>':''}</span><label class="toggle-switch" title="${isMe?'Нельзя ограничить собственный доступ':isLocked?'Доступ владельца защищён':'Временно разрешить или ограничить доступ'}"><input type="checkbox" role="switch" data-user-access="${escapeHtml(u.id)}" aria-label="Доступ: ${escapeHtml(u.nickname||u.email)}" ${accessible?'checked':''} ${isMe||isLocked||userAccessWrites.has(u.id)?'disabled':''}><span class="toggle-slider"></span></label></div></div>`; }).join('');
    restoreDraftFields(container,drafts);
    container.querySelectorAll('[data-nickname-uid]').forEach(f=>f.oninput=onNicknameInput);
    setNicknameActionsVisible(container);
    container.querySelectorAll('[data-nickname-save]').forEach(b=>b.onclick=()=>saveUserNicknameDraft(b.dataset.nicknameSave));
    container.querySelectorAll('[data-nickname-cancel]').forEach(b=>b.onclick=()=>cancelUserNicknameDraft(b.dataset.nicknameCancel));
    document.querySelectorAll('[data-user-access]').forEach(input=>input.onchange=()=>setUserAccess(input.dataset.userAccess,input.checked));
  }
  async function setUserAccess(uid, enabled) {
    return saveLineEvent(()=>runNasAdminAction('user.access',{uid,enabled}));
  }
  async function saveUserNicknameDraft(uid) {
    if (!canAdmin()) return;
    const field=document.querySelector('[data-nickname-uid="'+uid+'"]');
    if (!field) return;
    // Ошибку показывает runNasAdminAction (21-nas-runtime); поле не
    // очищается — черновик защищён восстановлением после перерисовки,
    // кнопки остаются, чтобы повторить или отменить.
    const ok=await updateUserNickname(uid, field.value);
    if (ok) cancelUserNicknameDraft(uid);
  }
  async function updateUserNickname(uid, nickname) { if (!canAdmin()) return; return saveLineEvent(()=>runNasAdminAction('user.nickname',{uid,nickname:nickname.trim()})); }
  async function changeUserRole(uid, newRole) { if (!canAdmin()) return; return saveLineEvent(()=>runNasAdminAction('user.role',{uid,role:newRole})); }
  async function deleteUser(uid) { if (!canAdmin() || !(await appConfirm('Удалить доступ?'))) return; return saveLineEvent(()=>runNasAdminAction('user.delete',{uid})); }
  const registrationDecisions = new Set();
  async function decideRegistration(reqId, approve) {
    if (!canAdmin() || registrationDecisions.has(reqId)) return;
    const role=document.getElementById('req_role_'+reqId)?.value || 'viewer';
    if (approve && !Object.prototype.hasOwnProperty.call(ROLES,role)) {showError('Выберите роль');return;}
    if (!approve && !(await appConfirm('Отклонить заявку и закрыть доступ пользователю?'))) return;
    return saveLineEvent(()=>runNasAdminAction(approve?'registration.approve':'registration.reject',approve?{uid:reqId,role}:{uid:reqId}));
  }
  async function approveRequest(reqId) { return decideRegistration(reqId,true); }
  async function rejectRequest(reqId) { return decideRegistration(reqId,false); }
  async function addNewUser() {
    if (!canAdmin()) return;
    const email = document.getElementById('newUserEmail').value.trim(); const pass = document.getElementById('newUserPassword').value; const role = document.getElementById('newUserRole').value;
    if (!email || !pass) { showError('Заполните поля'); return; }
    // Учётную запись создаёт сервер Ubuntu. Пароль уходит только в запросе
    // регистрации, в интерфейсе и журналах не сохраняется.
    try{
      const base=(typeof nasApiBase==='function'?nasApiBase():'').replace(/\/+$/,'');
      if(!base)throw Error('Не настроен адрес сервера Ubuntu');
      const response=await fetch(base+'/api/v1/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pass,device:wtDeviceInfo()}),credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
      let payload=null;try{payload=await response.json();}catch(_){}
      if(!response.ok)throw Error(wtAuthMessage(payload&&typeof payload.error==='string'?payload.error:'http-'+response.status));
      const uid=payload&&payload.profile&&typeof payload.profile.uid==='string'?payload.profile.uid:'';
      if(!uid)throw Error('Сервер не вернул учётную запись');
      await refreshNasAdministration();
      await nasAdminAction('registration.approve',{uid,role});
      showToastEl('Пользователь создан на Ubuntu',false);
    }
    catch(error){showError('Создание доступа не завершено: '+error.message);}
    finally{document.getElementById('newUserPassword').value='';}
  }
  function renderPermissionsMatrix(){
    const role=document.getElementById('permRoleSelect').value,config=permissionsConfig[role]||{tabs:[],actions:[]},cont=document.getElementById('permissionsMatrixContainer');
    const groups=[['Смена и линия',['start_shift','close_shift','edit_line']],['Работа самосвалов',['action_arrive','action_load','action_ttn','line_timer_reset']],['Последнее действие в статусе',['undo_action','undo_any']],['Журнал отмены и восстановления',['history_view','history_undo_own','history_undo_any','history_redo_own','history_redo_any']],['Данные и архив',['edit_logs','manage_trucks','manage_objects','archive_edit','archive_delete','import_backup']],['Отображение',['view_card_stats','view_header','view_gai_report','view_reis_in_ticker']]];
    const known=new Set(groups.flatMap(g=>g[1])),extra=[...new Set([...ALL_ACTIONS,...(config.actions||[])])].filter(x=>!known.has(x)&&!x.startsWith('tabel_tab_'));if(extra.length)groups.push(['Другие возможности',extra]);
    cont.innerHTML='<input id="permissionSearch" class="form-control" type="search" placeholder="Найти право…" aria-label="Поиск прав" style="margin-bottom:12px"><p style="color:var(--muted);font-size:12px">Администратор имеет полный доступ. Новые права журнала у остальных ролей выключены, пока вы их не включите. Изменения применяются кнопкой сохранения.</p>';
    function section(title,ids,type,labels,selected){const block=document.createElement('section');block.className='perm-group';const h=document.createElement('div');h.className='perm-group-header';h.textContent=title;block.append(h);const list=document.createElement('div');list.className='perm-list';for(const id of ids){const label=document.createElement('label');label.className='perm-item';label.dataset.search=(title+' '+(labels[id]||id)).toLowerCase();const input=document.createElement('input');input.type='checkbox';input.dataset.type=type;input.value=id;input.checked=selected.includes(id);label.append(input,document.createTextNode(' '+(labels[id]||id)));list.append(label);}block.append(list);cont.append(block);}
    section('Доступные вкладки',ALL_TABS.filter(t=>t!=='admin'),'tab',TAB_LABELS,config.tabs||[]);for(const [title,ids] of groups)section(title,ids,'action',ACTION_LABELS,config.actions||[]);
    // Табель: гранулярные вкладки. Пока роли не выдано ни одного права tabel_tab_*,
    // показываем состояние «по умолчанию: все вкладки» и ничего не сохраняем,
    // пока администратор не включит выборочный набор.
    if(role!=='admin'){
      const tabelIds=['tabel_tab_request','tabel_tab_shift','tabel_tab_table','tabel_tab_catalog','tabel_tab_history'];
      const configured=(config.actions||[]).filter(x=>tabelIds.includes(x));
      const customized=configured.length>0;
      const block=document.createElement('section');block.className='perm-group';
      const h=document.createElement('div');h.className='perm-group-header';h.textContent='Табель';block.append(h);
      const note=document.createElement('p');note.style='color:var(--muted);font-size:12px;margin:0 0 8px';
      note.textContent=customized?'Отмечены только вкладки табеля, доступные этой роли.':'По умолчанию: все вкладки. Снимите галочки, чтобы ограничить вкладки табеля для этой роли (полный сброс галочек вернёт все вкладки).';
      block.append(note);
      const list=document.createElement('div');list.className='perm-list';
      for(const id of tabelIds){
        const label=document.createElement('label');label.className='perm-item';label.dataset.search=('Табель '+(ACTION_LABELS[id]||id)).toLowerCase();
        const input=document.createElement('input');input.type='checkbox';input.dataset.type='action';input.value=id;
        input.checked=customized?configured.includes(id):true;
        label.append(input,document.createTextNode(' '+(ACTION_LABELS[id]||id).replace('Табель: ','')));
        list.append(label);
      }
      block.append(list);cont.append(block);
    }
    document.getElementById('permissionSearch').oninput=e=>{const q=e.target.value.trim().toLowerCase();cont.querySelectorAll('.perm-item').forEach(x=>x.hidden=!x.dataset.search.includes(q));cont.querySelectorAll('.perm-group').forEach(x=>x.hidden=![...x.querySelectorAll('.perm-item')].some(l=>!l.hidden));};
  }

  async function savePermissions() {
    if (!canAdmin()) return;
    const role = document.getElementById('permRoleSelect').value;
    const cont = document.getElementById('permissionsMatrixContainer');
    const tabs = Array.from(cont.querySelectorAll('input[data-type="tab"]:checked')).map(i => i.value);
    let actions = Array.from(cont.querySelectorAll('input[data-type="action"]:checked')).map(i => i.value);
    // Полный набор вкладок табеля == состояние по умолчанию: не записываем
    // tabel_tab_* в роль, чтобы старые конфигурации не менялись без причины.
    const tabelAll = ['tabel_tab_request','tabel_tab_shift','tabel_tab_table','tabel_tab_catalog','tabel_tab_history'];
    if (tabelAll.every(id => actions.includes(id))) actions = actions.filter(id => !tabelAll.includes(id));
    return saveLineEvent(()=>runNasAdminAction('permissions.replace',{role,permissions:{tabs,actions}}));
  }

  // Панель длинных ошибок: одна на всё приложение, по центру экрана,
  // закрывается только кнопкой «Понятно» (без таймера и закрытия по клику
  // мимо панели).
  function showErrorPanel(html) {
    let panel = document.getElementById('errorPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'errorPanel';
      panel.className = 'error-panel';
      panel.setAttribute('role', 'alert');
      panel.innerHTML = '<div class="error-panel-text"></div><button type="button" class="btn btn-secondary error-panel-close">Понятно</button>';
      panel.querySelector('.error-panel-close').addEventListener('click', () => panel.classList.remove('open'));
      document.body.appendChild(panel);
    }
    panel.querySelector('.error-panel-text').innerHTML = html;
    panel.classList.add('open');
  }
  function showError(msg) {
    console.error(msg);
    if (!navigator.onLine) { showToastEl(`📴 Нет сети`, true); return; }
    if (String(msg).length > 60) { showErrorPanel(`⚠️ ${escapeHtml(msg)}`); return; }
    showToastEl(`⚠️ ${escapeHtml(msg)}`, true);
  }
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
        // A notification is a presentation record, not the source of truth for
        // the current TTN state. It may be absent after cleanup or a delayed
        // listener update; the status transaction still proves whether this
        // exact TTN can be undone. Arrive/load keep the stricter notification
        // requirement because they also need their durable history/log.
        if (!notification.exists && last.type !== 'ttn') throw {code:'already-undone',message:'Действие уже отменено'};
        if (notification.exists && !hasPermission('undo_any') && notification.data().createdByEmail !== currentEmail) throw {code:'not-owner',message:'Можно отменить только своё действие'};
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
        // TTN can be confirmed by truckStatus even when its presentation
        // notification has not arrived (or was cleaned up). Build the penalty
        // scope from the durable action in that case instead of dereferencing
        // an absent notification snapshot.
        const original=notification.exists ? notification.data() : {
          ...last,
          createdByEmail:last.createdByEmail||last.email||currentEmail,
          createdBy:last.createdBy||last.actor||getUserName(),
          type:last.type,
          truckId:last.truckId,
          logId:last.logId||current.ttnLogId||null
        };
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
      showErrorPanel('Действие не отменено: ' + escapeHtml(e.message || 'Ошибка Firebase') + ' [' + escapeHtml(e.code || 'unknown') + ']');
    } finally { pendingEnd(); undoActionInFlight=false; }
  }
  async function addAudit(text, details = {}) {
    const timestamp = Date.now();
    const entry = { text, timeStr: new Date(timestamp).toLocaleString('ru-RU'), objectName: state.shift ? objectTitle(state.shift.objectId,state.shift.objectName) : '—', objectId: state.shift?.objectId || '', shiftId: state.shift?.id || '', userEmail: currentEmail || '', userName: getUserName(), createdByEmail: currentEmail || '', timestamp, ...details };
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
      return `<div class="audit-item"><div class="audit-time">${escapeHtml(a.timeStr)} · ${escapeHtml(name)}</div><div>${escapeHtml(a.text)}</div><div class="audit-time" style="margin-top:5px">${escapeHtml(objectTitle(a.objectId,a.objectName))}</div></div>`;
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
  function updateHoldSetting(t,v) { let f=parseFloat(v); f = isNaN(f)?0.5:Math.max(0,Math.min(5,f)); if(t==='load') settings.holdLoad=f; else if(t==='arrive') settings.holdArrive=f; else settings.holdTtn=f; localStorage.setItem('working-test-settings', JSON.stringify(settings)); }
  async function updateCycleMinutes(v) {
    if(!canAdmin()){showError('Время ходки задаёт администратор');return;}
    if(!navigator.onLine){showError('Для изменения общего времени ходки требуется связь');return;}
    const n=Math.max(15,parseInt(v)||15);
    try{await saveLineEvent(()=>nasSaveSettings({cycleMinutes:n}));settings.cycleMinutes=n;localStorage.setItem('working-test-settings',JSON.stringify(settings));renderAll();}
    catch(e){showError('Время ходки не сохранено: '+e.message);}
  }
  function toggleSetting(k,v) { settings[k]=v; localStorage.setItem('working-test-settings', JSON.stringify(settings)); }

  function renderAll() {
    renderHeaderStats();
    // П4: перерисовка линии идёт через расписание, чтобы уважать удержания.
    if (hasTabAccess('line')) scheduleRenderLine();
    // Полоса открытых смен — отдельный элемент, а не карточки линии: порядок
    // хуков и удержаний она не меняет (задача 25).
    window.__wtRenderShiftStrip?.();
    // Рейсы, оставшиеся в прежней смене: свой блок, тоже без влияния на
    // порядок карточек (design §10.2).
    window.__wtRenderDetachedTrips?.();
    if (hasTabAccess('report')) renderReport();
    if (hasTabAccess('archive')) renderArchive();
    if (hasTabAccess('trucks')) { renderGlobalTrucksManage(); renderGlobalObjectsManage(); }
    if (hasTabAccess('analytics')) renderAnalytics();
    if (canAdmin()) renderAdminPanel();
    renderStatusTicker();
    updateSyncUI();
  }

  // === SWITCH TAB (с жёсткой проверкой безопасности) ===
  // UI задачи 25 создаётся только при наличии включённого v2-моста. Если
  // флаг канала выключен, не подменяем операции v2 командами старого клиента.
  let shiftSelector = null;
  let shiftManagement = null;
  let shiftTransferUi = null;
  let shiftUiBridge = null;
  function shiftRights() {
    return {
      start_shift: typeof hasPermission === 'function' && hasPermission('start_shift'),
      close_shift: typeof hasPermission === 'function' && hasPermission('close_shift'),
      manage_shift_members: typeof hasPermission === 'function' && hasPermission('manage_shift_members'),
      manage_trucks: typeof hasPermission === 'function' && hasPermission('manage_trucks'),
      force_transfer_truck: typeof hasPermission === 'function' && hasPermission('force_transfer_truck'),
      action_arrive: typeof hasPermission === 'function' && hasPermission('action_arrive'),
      action_load: typeof hasPermission === 'function' && hasPermission('action_load'),
      action_ttn: typeof hasPermission === 'function' && hasPermission('action_ttn'),
      edit_line: typeof hasPermission === 'function' && hasPermission('edit_line')
    };
  }
  // §6: перевод разрешён админу и старшему прорабу; матрица прав одна этого
  // не доказывает, сервер проверяет роль отдельно.
  function mayForceTransfer() {
    const role = typeof currentUserRole === 'string' ? currentUserRole : '';
    return shiftRights().force_transfer_truck === true && (role === 'admin' || role === 'senior_foreman');
  }
  function hideDetachedTrips() {
    const mount = document.getElementById('detachedTripsBlock');
    if (mount) { mount.textContent = ''; mount.hidden = true; }
  }
  function shiftBridge() {
    try { return typeof nasV2Shifts === 'function' ? nasV2Shifts() : null; } catch (_) { return null; }
  }
  function ensureShiftUi() {
    const bridge = shiftBridge();
    const mount = document.getElementById('shiftStrip');
    if (!bridge || !bridge.store || !bridge.transport || typeof WorkingTestShiftSelector === 'undefined') {
      if (mount) { mount.textContent = ''; mount.hidden = true; }
      if (shiftSelector) shiftSelector.destroy();
      shiftSelector = null;
      shiftManagement = null;
      shiftTransferUi = null;
      shiftUiBridge = null;
      hideDetachedTrips();
      window.__wtRenderShiftStrip = function () { if (mount) mount.hidden = true; };
      window.__wtRenderDetachedTrips = hideDetachedTrips;
      // Без v2-моста занятый самосвал добавляется старым путём: v2-функции нет.
      delete window.__wtAddTruckToShift;
      const button = document.getElementById('shiftManagementBtn');
      if (button) button.hidden = false;
      return null;
    }
    if (shiftUiBridge !== bridge) {
      if (shiftSelector) shiftSelector.destroy();
      shiftSelector = null;
      shiftManagement = null;
      shiftTransferUi = null;
      shiftUiBridge = bridge;
    }
    if (!shiftSelector) {
      shiftSelector = WorkingTestShiftSelector.createShiftSelector({
        store: bridge.store, doc: document, mount, legacyState: state,
        onSwitch: function () { renderAll(); },
        select: function (id) { return window.shiftStripSelect(id); },
        offline: function () { return typeof navigator !== 'undefined' && navigator.onLine === false; }
      });
      shiftManagement = WorkingTestShiftManagement.createShiftManagement({
        transport: bridge.transport, store: bridge.store, rights: shiftRights()
      });
      // Крупное подтверждение перевода и блок оставшихся рейсов — только на
      // живом v2-мосте (design §10.2).
      shiftTransferUi = typeof WorkingTestShiftTransferUi !== 'undefined'
        ? WorkingTestShiftTransferUi.createShiftTransferUi({
          store: bridge.store,
          transport: bridge.transport,
          doc: document,
          mount: document.getElementById('detachedTripsBlock'),
          confirm: function (title, message, opts) {
            return typeof window.showConfirmModal === 'function'
              ? window.showConfirmModal(title, message, opts)
              : Promise.resolve(false);
          },
          notify: function (message, isError) {
            if (isError) { if (typeof showError === 'function') showError(message); }
            else if (typeof showToastEl === 'function') showToastEl(message, false);
          },
          truckLabel: function (id) { return typeof truckName === 'function' ? truckName(id) : ''; },
          objectLabel: function (id) {
            const found = (state.objects || []).find(row => row.id === id);
            return found ? found.name : '';
          },
          describeError: function (result) {
            return shiftManagement ? shiftManagement.describe(result) : '';
          },
          online: function () { return typeof navigator === 'undefined' || navigator.onLine !== false; },
          rights: shiftRights,
          forceTransferAllowed: mayForceTransfer,
          onChange: function () {
            // Команда обновила контексты store, а линия рисуется из проекции.
            // Без этого шага карточки самосвалов ждали бы следующего опроса.
            try { bridge.store.projectActiveContextToLegacyState(state); } catch (_) { /* проекция не критична для отчёта */ }
            renderAll();
          }
        })
        : null;
      window.__wtRenderShiftStrip = function () { shiftSelector?.render(); };
      window.__wtRenderDetachedTrips = function () {
        if (shiftTransferUi) shiftTransferUi.render();
        else hideDetachedTrips();
      };
      // Добавление самосвала на линию в режиме v2 идёт через v2-транспорт:
      // занятый самосвал получает предупреждение или крупный confirm перевода.
      window.__wtAddTruckToShift = function (truckId) {
        if (!shiftTransferUi) return Promise.resolve({ ok: false, code: 'transport-unavailable' });
        return shiftTransferUi.addTruckToShift({ truckId: truckId }).then(function (result) {
          if (!result.ok && result.code !== 'truck-assigned-to-other-shift' && !result.cancelled) {
            if (typeof showError === 'function') showError(result.message);
          }
          return result;
        });
      };
      // Кнопка листа управления имеет смысл только когда v2-мост поднят.
      const button = document.getElementById('shiftManagementBtn');
      if (button) button.hidden = false;
    }
    return { bridge, selector: shiftSelector, management: shiftManagement };
  }
  window.__wtRenderShiftStrip = function () {
    const ui = ensureShiftUi();
    if (ui) ui.selector.render();
  };
  window.shiftStripSelect = function (shiftId) {
    const ui = ensureShiftUi();
    if (!ui || !ui.selector.switchTo(shiftId)) return false;
    // Снимок выбранной смены читается сразу, а не через интервал опроса:
    // иначе после переключения экран ждал бы следующего тика.
    try { ui.bridge.handle?.wake?.(); } catch (_) { /* тик не критичен для выбора */ }
    return true;
  };
  // Лист управления сменой: только реальные операции v2. Пока мост выключен,
  // лист честно говорит причину и не подменяет v2 командами старого клиента.
  window.openShiftManagement = function () {
    const modal = document.getElementById('shiftManagementModal');
    const body = document.getElementById('shiftManagementBody');
    const button = document.getElementById('shiftManagementBtn');
    const ui = ensureShiftUi();
    if (!modal || !body) return;
    modal.classList.add('open');
    if (button) button.hidden = false;
    body.textContent = '';
    if (!ui) {
      const note = document.createElement('p');
      note.className = 'shift-management-note';
      note.textContent = 'Управление сменами доступно после включения канала v2.';
      body.appendChild(note);
      return;
    }
    // Права могли измениться после загрузки UI: пересчитываем их на каждый вход.
    shiftManagement = WorkingTestShiftManagement.createShiftManagement({
      transport: ui.bridge.transport, store: ui.bridge.store, rights: shiftRights()
    });
    const management = shiftManagement;
    const store = ui.bridge.store;
    const status = document.createElement('p');
    status.className = 'shift-management-status';
    status.hidden = true;
    body.appendChild(status);
    const report = (result, successText) => {
      status.hidden = false;
      status.className = 'shift-management-status ' + (result && result.ok ? 'is-ok' : 'is-error');
      status.textContent = result && result.ok ? successText : management.describe(result);
    };
    const section = title => {
      const box = document.createElement('div');
      box.className = 'shift-management-section';
      const head = document.createElement('h4');
      head.textContent = title;
      box.appendChild(head);
      body.appendChild(box);
      return box;
    };
    const activeShiftId = store.activeShiftId ? store.activeShiftId() : null;
    const activeRow = (store.visibleShifts ? store.visibleShifts() : []).find(row => row.shiftId === activeShiftId) || null;

    // Создать смену: объект, дата и тип уходят в createShift без локальных подмен.
    const createBox = section('Создать смену');
    const objectSelect = document.createElement('select');
    objectSelect.className = 'form-control';
    for (const object of (state.objects || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      const option = document.createElement('option');
      option.value = object.id;
      option.textContent = object.name;
      objectSelect.appendChild(option);
    }
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'form-control';
    const today = new Date();
    dateInput.value = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const typeSelect = document.createElement('select');
    typeSelect.className = 'form-control';
    for (const [value, label] of [['day', 'День'], ['night', 'Ночь']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      typeSelect.appendChild(option);
    }
    const createButton = document.createElement('button');
    createButton.className = 'btn btn-quick';
    createButton.textContent = 'Создать смену';
    createButton.disabled = !management.canCreate();
    createButton.addEventListener('click', async () => {
      createButton.disabled = true;
      try {
        const result = await management.createShift({
          objectId: objectSelect.value, workDate: dateInput.value, shiftType: typeSelect.value,
          // `cycleMinutes` is a required field of the documented creation body
          // (§5.2). Without it the server refuses every creation as
          // `invalid-command`, so the sheet passes the configured cycle. The
          // server accepts only a safe integer in 15…10080
          // (requireCycleMinutes), so a fractional value from old settings or a
          // hand-edited localStorage must be rounded before it reaches the body.
          cycleMinutes: Math.min(10080, Math.max(15, Math.round(Number(settings.cycleMinutes) || 15)))
        });
        report(result, 'Смена создана');
        if (result.ok) renderAll();
      } finally {
        createButton.disabled = !management.canCreate();
      }
    });
    createBox.appendChild(objectSelect);
    createBox.appendChild(dateInput);
    createBox.appendChild(typeSelect);
    createBox.appendChild(createButton);

    // Участники выбранной смены: список и точные add/remove с CAS из контекста.
    const membersBox = section('Участники' + (activeRow && activeRow.objectName ? ' · ' + activeRow.objectName : ''));
    const context = activeShiftId && store.context ? store.context(activeShiftId) : null;
    const members = context && context.snapshot && Array.isArray(context.snapshot.members) ? context.snapshot.members : [];
    if (!activeShiftId) {
      const empty = document.createElement('p');
      empty.className = 'shift-management-note';
      empty.textContent = 'Смена не выбрана.';
      membersBox.appendChild(empty);
    } else if (!members.length) {
      const empty = document.createElement('p');
      empty.className = 'shift-management-note';
      empty.textContent = 'Участники ещё не загружены или смена без участников.';
      membersBox.appendChild(empty);
    }
    const userName = uid => {
      const user = (state.users || []).find(item => item.id === uid);
      return user ? (user.nickname || sanitizeName(user.email) || uid) : uid;
    };
    for (const member of members) {
      const row = document.createElement('div');
      row.className = 'shift-management-member';
      const label = document.createElement('span');
      label.textContent = userName(member.uid);
      const remove = document.createElement('button');
      remove.className = 'btn btn-small btn-danger';
      remove.textContent = 'Убрать';
      remove.disabled = !management.canManageMembers();
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          const result = await management.removeMember({ shiftId: activeShiftId, uid: member.uid });
          report(result, 'Участник убран');
          if (result.ok) openShiftManagement();
        } finally {
          remove.disabled = !management.canManageMembers();
        }
      });
      row.appendChild(label);
      row.appendChild(remove);
      membersBox.appendChild(row);
    }
    if (activeShiftId) {
      const candidates = (state.users || [])
        .filter(user => user.status !== 'pending' && !members.some(member => member.uid === user.id))
        .sort((a, b) => userName(a.id).localeCompare(userName(b.id)));
      const addSelect = document.createElement('select');
      addSelect.className = 'form-control';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Добавить участника…';
      addSelect.appendChild(placeholder);
      for (const user of candidates) {
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = userName(user.id);
        addSelect.appendChild(option);
      }
      const addButton = document.createElement('button');
      addButton.className = 'btn btn-secondary';
      addButton.textContent = 'Добавить';
      addButton.disabled = !management.canManageMembers();
      addButton.addEventListener('click', async () => {
        if (!addSelect.value) { report({ code: 'invalid-uid' }, ''); return; }
        addButton.disabled = true;
        try {
          const result = await management.addMember({ shiftId: activeShiftId, uid: addSelect.value });
          report(result, 'Участник добавлен');
          if (result.ok) openShiftManagement();
        } finally {
          addButton.disabled = !management.canManageMembers();
        }
      });
      membersBox.appendChild(addSelect);
      membersBox.appendChild(addButton);
    }

    // Закрыть смену: материал и объём заполняются, только если в смене есть рейсы.
    const closeBox = section('Закрыть смену');
    const materialInput = document.createElement('input');
    materialInput.type = 'text';
    materialInput.className = 'form-control';
    materialInput.placeholder = 'Материал (если в смене есть рейсы)';
    const volumeInput = document.createElement('input');
    volumeInput.type = 'number';
    volumeInput.min = '0';
    volumeInput.step = '0.1';
    volumeInput.className = 'form-control';
    volumeInput.placeholder = 'Объём материала, м³';
    const closeButton = document.createElement('button');
    closeButton.className = 'btn btn-danger';
    closeButton.textContent = 'Закрыть смену';
    closeButton.disabled = !activeShiftId || !management.canClose();
    closeButton.addEventListener('click', async () => {
      if (!activeShiftId) return;
      const question = 'Закрыть смену' + (activeRow && activeRow.objectName ? ' «' + activeRow.objectName + '»' : '') + '?';
      if (typeof appConfirm === 'function' && !(await appConfirm(question))) return;
      closeButton.disabled = true;
      try {
        const result = await management.closeShift({
          shiftId: activeShiftId,
          materialId: materialInput.value.trim() || undefined,
          volume: volumeInput.value === '' ? undefined : Number(volumeInput.value)
        });
        report(result, 'Смена закрыта');
        if (result.ok) { renderAll(); closeShiftManagement(); }
      } finally {
        closeButton.disabled = !activeShiftId || !management.canClose();
      }
    });
    closeBox.appendChild(materialInput);
    closeBox.appendChild(volumeInput);
    closeBox.appendChild(closeButton);
  };
  window.closeShiftManagement = function () {
    const modal = document.getElementById('shiftManagementModal');
    if (modal) modal.classList.remove('open');
  };
  // Explicit-просмотр архивной ревизии: без сети и без v1-подмен. Меняется
  // только выбранная ревизия в модалке архива, default pointer остаётся прежним.
  window.openArchiveRevision = function (revision) {
    return typeof openArchiveRevisionView === 'function' ? openArchiveRevisionView(revision) : false;
  };
  window.closeArchiveRevision = function () {
    return typeof closeArchiveRevisionView === 'function' ? closeArchiveRevisionView() : false;
  };
  window.addEventListener('samosval-working-test-shifts', function () {
    const ui = ensureShiftUi();
    if (!ui) return;
    ui.selector.render();
    // Список смен меняется — блок оставшихся рейсов тоже пересобирается.
    window.__wtRenderDetachedTrips?.();
    // Первый список (или смена активной смены) проецируется в старую линию:
    // без этого экран остаётся «Смена не начата», хотя выбранная смена уже
    // есть в полосе, а у прораба с одной сменой полосы нет вовсе.
    const active = ui.selector.activeShiftId();
    const current = state.shift && (state.shift.shiftId || state.shift.id);
    if (active && active !== current) ui.selector.switchTo(active);
  });
  window.addEventListener('samosval-working-test-shift-snapshot', function (event) {
    const ui = ensureShiftUi();
    if (!ui) return;
    ui.selector.refreshBadges();
    // Снимок выбранной смены — это её рейсы и статусы машин. Первый снимок
    // почти всегда приходит уже ПОСЛЕ выбора смены (список виден раньше), и
    // без перерисовки линия оставалась пустой: карточки не появлялись, пока
    // пользователь не переключит смену вручную.
    const detail = event && event.detail;
    if (!detail || detail.applied !== true) return;
    if (detail.shiftId !== ui.selector.activeShiftId()) return;
    ui.bridge.store.projectActiveContextToLegacyState(state);
    // Перерисовывается только то, что зависит от проекции: карточки линии и
    // сводка шапки. Полный renderAll на каждый снимок гонял бы все вкладки
    // каждые 4 секунды, а renderLine сам пропускает неизменные данные.
    renderHeaderStats();
    scheduleRenderLine();
    // Снимок приносит и detached-рейсы выбранной смены: обновляем блок.
    window.__wtRenderDetachedTrips?.();
  });

  function switchTab(name, btn) {
    if (name === 'admin' && !canAdmin()) { showError('Только админ'); return; }
    if (!name.startsWith('plugin-') && name !== 'admin' && !hasTabAccess(name)) { showError('Нет доступа'); return; }
    // === SECURITY: до загрузки прав разрешена только вкладка line ===
    if (!permissionsLoaded && name !== 'line' && name !== 'admin') {
      showError('Подождите, идёт загрузка прав...'); return;
    }
    document.querySelectorAll('.tab-content').forEach(e=>e.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(e=>e.classList.remove('active'));
    // Табель — обычная вкладка: при уходе на другую кнопку панели он закрывается.
    if (name !== 'tabel-v2' && globalThis.__tabelV2Instance) { try { globalThis.__tabelV2Instance.hide(); } catch(e){} }
    let t = document.getElementById('tab-'+name); if(t) t.classList.add('active');
    if(btn) btn.classList.add('active');
    window.scrollTo(0,0);
    // Always open Summary on the regular truck sheet; GAI is opt-in per visit.
    if (name === 'report') showGAITable = false;
    if (pluginTabs[name]) pluginTabs[name].render(pluginTabs[name].container); else renderAll();
  }

  window.addEventListener('DOMContentLoaded', () => {
    loadMaxQueue(); renderAll(); updateSyncUI();
    window.addEventListener('online', () => { offlineTransportRecovered(); updateSyncUI(); runMaxQueue(); offlineReplayJournal(); });
    window.addEventListener('offline', updateSyncUI);
    let e = localStorage.getItem('working-test-saved-email_test347'); if(e) document.getElementById('userBadgeLabel').textContent = '👤 ' + sanitizeName(e);
    document.getElementById('newTruckType').addEventListener('change', toggleVolInput);
    setTimeout(runMaxQueue, 2000);
    preloadTabelV2Modules();
  });
  setInterval(updateSyncUI, 3000);
  setInterval(offlineReplayJournal, 8000);
  setInterval(() => { if (maxQueue.length && !maxSenderRunning) runMaxQueue(); }, 20000);

  // Built-in test module. No plugin installation or production writes.
  let tabelV2Opening = false;
  // Индикатор «Открываю табель…» — показывается в момент нажатия кнопки,
  // пока грузятся модули tabel-v2 и справочник объектов (раньше до 8+ секунд
  // кнопка молчала и экран оставался пустым).
  function showTabelOpeningIndicator() {
    let overlay = document.getElementById('tabel-v2-opening');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'tabel-v2-opening';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.6);color:#fff;font:600 16px/1.4 system-ui,sans-serif;text-align:center;';
      overlay.textContent = 'Открываю табель…';
      document.body.append(overlay);
    }
    overlay.hidden = false;
  }
  function hideTabelOpeningIndicator() {
    const overlay = document.getElementById('tabel-v2-opening');
    if (overlay) overlay.remove();
  }
  async function openTabelV2(settingsOnly, requestFirst = false) {
    if (tabelV2Opening) return;
    tabelV2Opening = true;
    showTabelOpeningIndicator();
    try {
      // В режиме Ubuntu табель строится по справочнику объектов. Если справочник
      // ещё не пришёл, таблица открывается пустой — поэтому сначала дожидаемся его.
      if (isNasRuntime() && !(state.objects && state.objects.length)) {
        try {
          await Promise.race([
            refreshNasObjects(),
            new Promise(resolve => setTimeout(resolve, 8000))
          ]);
        } catch (e) { console.warn('Табель: справочник объектов', e.message); }
      }
      if (isNasRuntime() && !(state.objects && state.objects.length)) {
        showError('Справочник объектов ещё не загружен. Проверьте связь с сервером Ubuntu и откройте табель снова.');
        return;
      }
      const module = await import(new URL('./working-test/tabel-v2/entry.mjs', document.baseURI).href);
      await module.open(tabelV2Host(), settingsOnly, {requestFirst});
      // Табель — отдельный экран поверх приложения: активные вкладки (включая
      // «Админ → Сервер» с его внутренними кнопками) должны быть погашены,
      // иначе под табелем остаются чужие навигационные панели.
      document.querySelectorAll('.tab-content').forEach(e=>e.classList.remove('active'));
      // Табель подсвечивается в нижней панели, остальные вкладки гаснут.
      document.querySelectorAll('.nav-btn').forEach(e=>e.classList.remove('active'));
      const nb = document.getElementById('nav-tabel-v2'); if (nb) nb.classList.add('active');
    } catch (error) { showError(error.message || 'Табель не открылся'); } finally { hideTabelOpeningIndicator(); tabelV2Opening = false; }
  }

  // Фоновая предзагрузка модулей табеля: после старта приложения, в свободное
  // время (requestIdleCallback / setTimeout), грузим entry.mjs и workspace.css,
  // чтобы первый клик по «Табель» не ждал сети на медленном соединении.
  let tabelModulesPreloaded = false;
  function preloadTabelV2Modules() {
    if (tabelModulesPreloaded) return;
    tabelModulesPreloaded = true;
    const preload = () => {
      import(new URL('./working-test/tabel-v2/entry.mjs', document.baseURI).href)
        .catch(e => { tabelModulesPreloaded = false; console.warn('Табель: предзагрузка', e.message); });
      if (!document.querySelector('[data-tabel-v2-css]')) {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = new URL('./working-test/tabel-v2/workspace.css', document.baseURI);
        l.dataset.tabelV2Css = '';
        document.head.append(l);
      }
    };
    const ric = globalThis.requestIdleCallback;
    if (typeof ric === 'function') ric(preload, { timeout: 4000 }); else setTimeout(preload, 3000);
  }


  function tabelV2Host(){
      if(isNasRuntime())return nasTabelHost();
      const session = () => ({projectId: firebaseConfig.projectId, workspaceId: WORKSPACE_ID,
        uid: currentUid, name: getUserName(), role: currentUserRole, active: currentUserStatus === 'active',
        view: permissionsLoaded && hasTabAccess('timesheet'), edit: hasPermission('timesheet_edit'),
        tabelTabs: tabelTabViews(),
        objectId: state.shift && state.shift.objectId});
      return {session, workspace: wsRef, refs,
        users:async()=>state.users.length?state.users:(await usersRef.get()).docs.map(d=>({...d.data(),id:d.id})),
        transaction:fn=>db.runTransaction(fn),
        documentId:()=>(FIREBASE_SDK_PRESENT && typeof firebase!=='undefined' ? firebase.firestore.FieldPath.documentId() : 'firebase-unavailable'),
        get shift(){return state.shift;}, get objects(){return state.objects;},
        snapshot:()=>({shift:state.shift,trucks:state.trucks,statuses:state.truckStatus,logs:state.logs,audit:state.audit,lineAudit:state.lineAudit,archive:state.archive}),
        createObject:async(name,startDate)=>{
          if(!hasPermission('manage_objects')||currentUserStatus!=='active')throw Error('Нет права создавать объекты');
          name=String(name||'').trim();if(!name||name.length>180)throw Error('Введите название объекта');
          const existing=state.objects.find(o=>o.name.toLowerCase()===name.toLowerCase());if(existing)return {...existing};
          const ref=refs.objects.doc(),data={name,startDate,createdAt:Date.now(),createdBy:getUserName()};
          await tfAwait(ref.set(data));return {id:ref.id,...data};
        }

      };
  }
  let tabelBackgroundStarting=false;
  function startTabelBackground(){
    if(tabelBackgroundStarting||tabelV2Opening||!permissionsLoaded||currentUserStatus!=='active'||!hasTabAccess('timesheet'))return;
    tabelBackgroundStarting=true;
    import(new URL('./working-test/tabel-v2/entry.mjs',document.baseURI).href).then(m=>m.background(tabelV2Host())).catch(e=>console.warn('Табель: фоновая очередь',e.message)).finally(()=>{tabelBackgroundStarting=false;});
  }
// Чистые правила переключения сервера данных. Вынесены отдельно, чтобы их
// можно было проверить без браузера и без обращения к базам.
(function (root) {
  'use strict';

  // Что нужно, чтобы вообще начать переключение. Возвращает либо запрет с
  // понятной причиной, либо подтверждённое поколение для серверной команды.
  function decideSwitchPlan(input) {
    const state = input || {};
    const target = state.target;
    if (target !== 'firebase' && target !== 'ubuntu') return { ok: false, error: 'Неизвестный режим сервера.' };
    if (!state.authenticated) return { ok: false, error: 'Нужен вход в приложение.' };
    if (!state.permissionsLoaded || !state.isAdmin) return { ok: false, error: 'Режим сервера может менять только активный администратор.' };
    if (Number(state.pending) > 0) return { ok: false, error: 'Переключение запрещено: есть неотправленные действия.' };
    if (state.currentProvider === target) return { ok: true, noop: true, expectedGeneration: state.generation };
    if (!Number.isInteger(state.generation) || state.generation < 0) {
      return { ok: false, error: 'Общий режим сервера ещё не подтверждён сервером.' };
    }
    return { ok: true, noop: false, expectedGeneration: state.generation };
  }

  // Отказ сервера переводим в понятный текст. Неизвестный отказ возвращаем
  // как есть, чтобы не скрывать настоящую причину.
  function describeSwitchFailure(status, code, message) {
    if (code === 'authority-generation-conflict') return 'Режим уже изменил другой администратор. Откройте админку заново.';
    if (code === 'authority-generation-mismatch') return 'Телефон отстал от общего режима. Обновите страницу и повторите.';
    if (code === 'not-authoritative') return 'Сервер ещё не объявлен владельцем записи. Переключение не выполнено.';
    if (status === 403) return 'Резерв пока не содержит вашу учётную запись. Дождитесь репликации или проверьте права.';
    if (status === 401) return 'Сеанс входа истёк. Войдите заново.';
    return message || null;
  }

  // Право записи принадлежит ровно одному серверу: резерв не принимает
  // зеркало, когда владельцем объявлен он сам, и наоборот.
  function isMirrorAllowed(authorityProvider) {
    return authorityProvider === 'firebase';
  }

  const api = { decideSwitchPlan, describeSwitchFailure, isMirrorAllowed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestSwitchPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis);  // TEST only. Firestore remains the sole data writer until the complete NAS
  // interface is connected. A reachable health endpoint is not a data adapter.
  const TEST_BACKEND_MODE_LABELS = Object.freeze({ firebase: 'Firebase — сервер данных', ubuntu: 'Ubuntu — сервер данных' });
  const WORKING_AUTHORITY_PATH = 'workspaces/main_workspace/settings/backendAuthority';
  window.WorkingTestAuthority = window.WorkingTestAuthority || { runtimeProvider: 'firebase', generation: null, stop: null };

  // Единственный владелец записи объявлен сервером Ubuntu (таблица
  // server_authority). Firebase-документ — только зеркало для тех клиентов,
  // которые не могут прочитать сервер. Поэтому переключение всегда идёт
  // через серверную процедуру, а не через локальную настройку браузера.
  const WORKING_AUTHORITY_API = WORKING_TEST_UBUNTU_API_BASE + '/api/v1/authority';

  async function workingAuthorityRequest(method, body) {
    if (!wtAuthUser()) throw Error('Нужен вход в приложение');
    const token = await wtAuthUser().getIdToken();
    const headers = { Authorization: 'Bearer ' + token };
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(WORKING_AUTHORITY_API, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = Error((payload && (payload.error || payload.message)) || ('HTTP ' + response.status));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function mirrorAuthorityToFirestore(authority) {
    try {
      await db.doc(WORKING_AUTHORITY_PATH).set({
        provider: authority.provider,
        generation: authority.generation,
        updatedAt: Date.now(),
        updatedBy: currentUid || null
      });
    } catch (_) { /* зеркало необязательно: истина на сервере */ }
  }

  async function readWorkingAuthority() {
    if (wtAuthUser()) {
      try {
        const state = await workingAuthorityRequest('GET');
        const a = state && state.authority;
        if (a && ['firebase', 'ubuntu'].includes(a.provider) && Number.isInteger(a.generation) && a.generation > 0) {
          void mirrorAuthorityToFirestore(a);
          return { provider: a.provider, generation: a.generation };
        }
      } catch (_) { /* сервер недоступен — читаем зеркало */ }
    }
    const ref = db.doc(WORKING_AUTHORITY_PATH);
    try {
      const snap = await ref.get({ source: 'server' });
      if (!snap.exists) return { provider: 'firebase', generation: 0 };
      const data = snap.data() || {};
      if (!['firebase', 'ubuntu'].includes(data.provider) || !Number.isInteger(data.generation) || data.generation < 0) throw Error('Режим сервера повреждён');
      return { provider: data.provider, generation: data.generation };
    } catch (error) {
      if (error.code === 'permission-denied') throw error;
      throw Error('Не удалось подтвердить общий режим данных');
    }
  }
  function watchWorkingAuthority() {
    if (window.WorkingTestAuthority.stop) window.WorkingTestAuthority.stop();
    // До входа общий документ недоступен по правилам: не подписываемся и не
    // пугаем пользователя отказом доступа на экране входа.
    if (!wtAuthUser()) return;
    window.WorkingTestAuthority.stop = db.doc(WORKING_AUTHORITY_PATH).onSnapshot({includeMetadataChanges:false}, snap => {
      const data=snap.exists?snap.data():{};
      if (!snap.exists) { window.WorkingTestAuthority.runtimeProvider='firebase'; window.WorkingTestAuthority.generation=0; return; }
      if (!['firebase','ubuntu'].includes(data.provider) || !Number.isInteger(data.generation)) return;
      const changed=window.WorkingTestAuthority.generation!==null && window.WorkingTestAuthority.generation!==data.generation;
      window.WorkingTestAuthority.runtimeProvider=data.provider; window.WorkingTestAuthority.generation=data.generation; renderTestBackendControls();
      if (changed && location.reload) location.reload();
    }, error => { if (error.code==='permission-denied' && currentUid) showError('Нет доступа к общему режиму сервера. Переключение остановлено.'); });
  }
  window.addEventListener('online', () => { readWorkingAuthority().then(a => { window.WorkingTestAuthority.runtimeProvider=a.provider; window.WorkingTestAuthority.generation=a.generation; }).catch(()=>{}); });

  function testBackendPreferenceKey() {
    return currentUid ? 'wt_backend_mode:' + firebaseConfig.projectId + ':' + location.pathname + ':' + WORKSPACE_ID + ':' + currentUid : null;
  }

  function getTestBackendMode() {
    const key = testBackendPreferenceKey();
    if (!key) return 'firebase';
    try {
      const mode = localStorage.getItem(key);
      // Never activate an unsupported provider from an old or edited preference.
      return mode === 'ubuntu' || mode === 'firebase' ? mode : 'firebase';
    } catch (_) { return 'firebase'; }
  }

  // The device preference is only a request. The single shared decision lives in
  // one Firestore document and is written transactionally by an administrator —
  // for BOTH directions. Existing rules already allow an active user to read and
  // an admin to write workspaces/main_workspace/settings/*, so no rule or schema
  // change to the working database is required.
  async function writeAuthority(mode, expectedGeneration) {
    // Одна транзакция на сервере: проверка поколения + смена владельца записи.
    // Локальная настройка браузера владельцем не является.
    const result = await workingAuthorityRequest('POST', {
      provider: mode,
      expectedGeneration,
      reason: 'Ручное переключение администратором'
    });
    const authority = result && result.authority;
    if (!authority) throw Error('Сервер не подтвердил переключение');
    await mirrorAuthorityToFirestore(authority);
    return authority;
  }

  // Перед передачей права записи резерву проверяем, что резерв действительно
  // готов: в нём есть наша учётная запись и рабочие данные. Иначе телефон
  // переключился бы в пустую базу и потерял доступ.
  async function checkReserveReadiness() {
    const token = await wtAuthUser().getIdToken();
    const session = await fetch(WORKING_TEST_UBUNTU_API_BASE + '/api/v1/session', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!session.ok) {
      if (session.status === 403) throw Error('Резерв пока не содержит вашу учётную запись. Дождитесь репликации или проверьте права.');
      throw Error('Резерв не ответил на проверку сеанса: HTTP ' + session.status);
    }
    const line = await fetch(WORKING_TEST_UBUNTU_API_BASE + '/api/v1/line/snapshot', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!line.ok) throw Error('Резерв не отдал данные линии: HTTP ' + line.status);
    const snapshot = await line.json().catch(() => null);
    const trucks = Array.isArray(snapshot?.trucks) ? snapshot.trucks.length : 0;
    if (!trucks) throw Error('В резерве ещё нет данных линии. Дождитесь репликации, затем повторите.');
    return trucks;
  }

  async function pushAuthorityToServer(mode) {
    if (mode !== 'ubuntu' && mode !== 'firebase') return null;
    try {
      const current = await readWorkingAuthority();
      if (current.provider === mode) return current;
      if (mode === 'ubuntu') await checkReserveReadiness();
      const next = await writeAuthority(mode, current.generation);
      window.WorkingTestAuthority.runtimeProvider = next.provider;
      window.WorkingTestAuthority.generation = next.generation;
      showToastEl('Сервер данных: ' + TEST_BACKEND_MODE_LABELS[mode], false);
      return next;
    } catch (error) {
      showError(error.code === 'authority-generation-conflict'
        ? error.message
        : 'Сервер не подтвердил переключение: ' + (error.message || error.code || 'ошибка'));
      return null;
    }
  }

  // The provider has to be known BEFORE the authenticated runtime starts,
  // otherwise the app boots into Firebase and the switch looks like it "jumps
  // back". Called from the auth flow before isNasRuntime() is evaluated.
  let workingAuthorityReady = null;
  function ensureWorkingAuthority() {
    if (window.WorkingTestAuthority.ready) return Promise.resolve(window.WorkingTestAuthority);
    if (!workingAuthorityReady) {
      workingAuthorityReady = readWorkingAuthority().then(a => {
        window.WorkingTestAuthority.runtimeProvider = a.provider;
        window.WorkingTestAuthority.generation = a.generation;
        window.WorkingTestAuthority.ready = true;
        return window.WorkingTestAuthority;
      }).catch(error => {
        workingAuthorityReady = null; // retry on the next login/reconnect
        if (error && error.code === 'permission-denied') {
          showError('Нет доступа к общему режиму сервера. Работаем на Firebase.');
        }
        return window.WorkingTestAuthority;
      });
    }
    return workingAuthorityReady;
  }

  function setTestBackendMode(mode) {
    // Единственный сервер данных — Ubuntu. Переключения отключены намеренно:
    // вторая база больше не принимает записи и не может разойтись с первой.
    renderTestBackendControls();
    showToastEl('Сервер данных один — Ubuntu. Firebase используется только для входа.', false);
    return Promise.resolve(false);
  }
  function setTestBackendModeLegacy(mode) {
    const policy = window.WorkingTestSwitchPolicy;
    return (async () => {
    // Перед решением обязательно читаем общий режим: иначе поколение ещё
    // неизвестно и переключение ошибочно объявляется неподтверждённым.
    await ensureWorkingAuthority();
    const key = testBackendPreferenceKey();
    const pending = typeof offlinePendingOps === 'function' ? offlinePendingOps().length : 0;
    const plan = policy.decideSwitchPlan({
      target: mode,
      authenticated: !!currentUid,
      isAdmin: canAdmin(),
      permissionsLoaded: permissionsLoaded,
      pending: pending,
      currentProvider: window.WorkingTestAuthority.runtimeProvider,
      generation: window.WorkingTestAuthority.generation
    });
    if (!plan.ok) {
      renderTestBackendControls();
      showError(plan.error);
      return false;
    }
    if (plan.noop) {
      renderTestBackendControls();
      showToastEl('Сервер данных уже ' + TEST_BACKEND_MODE_LABELS[mode], false);
      return true;
    }
    if (!key) {
      renderTestBackendControls();
      showError('Не удалось определить устройство для сохранения режима.');
      return false;
    }
    // Локальная отметка — только для показа на этом устройстве. Владельца
    // записи меняет сервер, поэтому перезагрузка идёт лишь после подтверждения.
    try { localStorage.setItem(key, mode); } catch (_) {}
    updateSyncUI();
    showToastEl('Переключаем сервер данных…', false);
    const switching = pushAuthorityToServer(mode);
    if (typeof location !== 'undefined' && typeof location.reload === 'function') {
      Promise.resolve(switching).then(next => {
        if (!next) { renderTestBackendControls(); return; }
        setTimeout(() => location.reload(), 500);
      });
    }
    return true;
    })();
  }
  watchWorkingAuthority();

  function getTestBackendIndicator(status) {
    if(isNasRuntime()){
      // Сервер данных всегда Ubuntu; localStorage здесь ни при чём. Раньше
      // при переполнении хранилища диагностика падала до reading() и
      // показывала «Firebase — сервер данных», вводя в заблуждение.
      if(status.state==='offline')return {letter:'О',label:'Ubuntu — локальная очередь',provider:'ubuntu'};
      if(status.state==='ok')return {letter:'S',label:'Ubuntu — сервер данных',provider:'ubuntu'};
      return {letter:'!',label:'Ubuntu — '+status.text,provider:'ubuntu'};
    }
    try{localStorage.getItem('samosval-working-test-backend-mode');}catch(e){return {letter:'!',label:'Ubuntu — память телефона переполнена',provider:'ubuntu'};}
    if (status.state === 'offline') return {letter:'О', label:'Офлайн', provider:'firebase'};
    if (!currentUid || status.state === 'init') return {letter:'…', label:'Firebase — подключение ещё не подтверждено', provider:'firebase'};
    if (status.state === 'error') return {letter:'!', label:'Firebase — требуется проверка синхронизации', provider:'firebase'};
    return {letter:'F', label:'Firebase — сервер данных', provider:'firebase'};
  }

  let testUbuntuCheckPending = false;
  let testUbuntuCheckSession = null;
  let testUbuntuCheckEpoch = 0;

  function loadTestUbuntuChecker() {
    return import(new URL('./working-test/synology/connection-check.mjs', document.baseURI).href);
  }

  async function checkTestUbuntuConnection() {
    const allowed = !!currentUid && permissionsLoaded && canAdmin();
    if (!allowed || testUbuntuCheckPending || !navigator.onLine) return;
    const result = document.getElementById('testUbuntuCheckResult');
    if (!result) return;
    renderTestBackendControls();
    const uid = currentUid, epoch = testUbuntuCheckEpoch;
    const guard = () => {
      if (uid !== currentUid || epoch !== testUbuntuCheckEpoch || !permissionsLoaded || !canAdmin()) throw Error('Сеанс изменился');
    };
    testUbuntuCheckPending = true;
    result.textContent = 'Проверка линии и табеля Ubuntu…';
    renderTestBackendControls();
    try {
      const {checkSynology} = await loadTestUbuntuChecker();
      guard();
      const counts = await checkSynology({getIdToken: force => wtAuthUser()?.getIdToken(force), guard});
      guard();
      result.textContent = `Линия и табель доступны. Машин: ${counts.trucks}; обычных рейсов: ${counts.normal}; объём: ${counts.volume} м³. Это проверка Ubuntu API; данные программы остаются в Ubuntu.`;    } catch (error) {
      if (uid === currentUid && epoch === testUbuntuCheckEpoch && permissionsLoaded && canAdmin()) {
        result.textContent = error.status === 404
          ? 'По внешнему адресу Ubuntu API недоступен. Нужно проверить HTTPS-маршрут на Ubuntu.'
          : error.name === 'AbortError' ? 'Ubuntu не ответил вовремя.' : error.message;
      }
    } finally {
      testUbuntuCheckPending = false;
      renderTestBackendControls();
    }
  }

  function renderTestBackendControls(status) {
    const section = document.getElementById('admin-backend-settings');
    if (!section) return;
    const allowed = !!currentUid && permissionsLoaded && canAdmin();
    section.hidden = !allowed;
    const session = allowed ? currentUid : null;
    const probeResult = document.getElementById('testUbuntuCheckResult');
    if (session !== testUbuntuCheckSession) {
      testUbuntuCheckSession = session;
      testUbuntuCheckEpoch++;
      if (probeResult) probeResult.textContent = '';
    }
    const probeButton = document.getElementById('testUbuntuCheck');
    if (probeButton) probeButton.disabled = !allowed || !navigator.onLine || testUbuntuCheckPending;
    const select = document.getElementById('testBackendMode');
    if (select) {
      // Данные обслуживает только Ubuntu; переключение режимов отключено.
      select.disabled = true;
      select.value = 'ubuntu';
    }
    const actual = document.getElementById('testBackendActual');
    if (actual) actual.textContent = getTestBackendIndicator(status || getSyncStatus()).label;
    const note = document.getElementById('testBackendModeNote');
    const shared = window.WorkingTestAuthority;
    const sharedText = shared.generation === 0
      ? ' Общий режим ещё не переключался: действует Firebase, его можно сменить.'
      : shared.generation
        ? ' Общий владелец записи: ' + (shared.runtimeProvider === 'ubuntu' ? 'Ubuntu' : 'Firebase')
          + ' (поколение ' + shared.generation + ') — действует для всех устройств.'
        : ' Общий владелец записи ещё не подтверждён сервером.';
    if (note) note.textContent = 'Данные обслуживает Ubuntu — единственный сервер. Firebase используется только для входа пользователей. Переключение режимов отключено.';
  }
// TEST-only control center. Server authorizes every read and mutation independently.
let serverControlSnapshot=null,serverControlSection='overview',serverControlFlight=null,serverControlBusy=false,serverControlError='',serverControlScope='';
const serverControlLabels={queued:'В очереди',running:'Выполняется',succeeded:'Завершено',failed:'Ошибка',check:'Проверка обновлений',backup:'Резервная копия БД',update:'Обновление API',restart:'Перезапуск API',rollback:'Возврат предыдущего API',downloading:'Скачивание',verifying:'Проверка',backing_up:'Копирование и проверка восстановления',switching:'Установка',validating:'Проверка запуска',rolling_back:'Возврат прежнего API',interrupted:'Прервано',ready:'Готово',unavailable:'Недоступно'};
const scText=x=>escapeHtml(String(x??'—'));
function scBytes(n){n=Number(n);if(!Number.isFinite(n)||n<0)return 'Нет данных';if(n<1024)return n+' Б';const units=['КБ','МБ','ГБ','ТБ'];let i=-1;do{n/=1024;i++;}while(n>=1024&&i<units.length-1);return n.toLocaleString('ru-RU',{maximumFractionDigits:1})+' '+units[i];}
const scDate=x=>x?new Date(x).toLocaleString('ru-RU'):'Нет данных';
function scCard(label,value,note=''){return '<article class="sc-card"><span>'+scText(label)+'</span><strong>'+scText(value)+'</strong>'+(note?'<small>'+scText(note)+'</small>':'')+'</article>';}
function scButton(action,text,disabled=false){return '<button type="button" class="btn btn-secondary btn-small" data-sc-action="'+action+'"'+(disabled?' disabled':'')+'>'+scText(text)+'</button>';}
function scAllowed(){return isNasRuntime()&&canAdmin()&&!!nasRuntimeClient;}
function scVisible(){return document.getElementById('tab-admin')?.classList.contains('active')&&document.getElementById('admin-sub-server')?.classList.contains('active')&&!document.hidden;}
function renderServerControl(){
 const root=document.getElementById('server-control-root');if(!root)return;
 if(!scAllowed()){serverControlSnapshot=null;root.textContent=isNasRuntime()?'Требуется активный администратор.':'Центр управления доступен в тестовой версии Ubuntu.';return;}
 const s=serverControlSnapshot,a=s?.agent,fresh=!!s&&!serverControlError&&Date.now()-s.readAt<30000,available=fresh&&a?.available&&!serverControlBusy,job=s?.jobs.find(j=>['queued','running'].includes(j.status)),disabled=!available||!!job;
 let html='<div class="sc-heading"><div><h3>Центр управления</h3><span class="sc-channel">TEST · Ubuntu</span></div>'+scButton('refresh','Обновить',!!serverControlFlight)+'</div>';
 html+='<p class="sc-status" role="status">'+scText(serverControlError||(!s?'Загружаю состояние…':!fresh?'Показаны последние полученные данные':a?.available?'Служба управления на связи':'Служба управления не подключена. Серверные действия недоступны.'))+'</p>';
 html+='<nav class="sc-nav" aria-label="Разделы центра управления">'+[['overview','Обзор'],['resources','Ресурсы'],['updates','Обновления'],['backups','Копии'],['objects','Объекты'],['journal','Журнал']].map(([key,label])=>'<button type="button" data-sc-section="'+key+'" aria-pressed="'+(key===serverControlSection)+'">'+label+'</button>').join('')+'</nav>';
 if(job)html+='<p class="sc-progress" role="status">'+scText(serverControlLabels[job.type])+' · '+scText(serverControlLabels[job.stage]||job.stage)+'. Задание продолжится на NAS после закрытия приложения.</p>';
 if(s){
  const host=a.host||{},disk=host.disk||{};
  if(serverControlSection==='overview'){
   html+='<div class="sc-grid">'+scCard('API',s.api.version,'Работает '+Math.floor(s.api.uptimeSeconds/60)+' мин')+scCard('База данных',s.database.status==='connected'?'Подключена':'Недоступна',scBytes(s.database.bytes))+scCard('Свободное место NAS',scBytes(disk.availableBytes),disk.totalBytes?'Всего '+scBytes(disk.totalBytes):'Появится после подключения службы')+scCard('Пользователи',s.users.registered,'Допущены: '+s.users.active+' · заявки: '+s.users.pending)+scCard('Объекты',s.objects.length,'Открытых смен: '+s.objects.reduce((n,o)=>n+o.active_shifts,0))+scCard('Последняя копия БД',a.backups?.[0]?scDate(a.backups[0].createdAt):'Нет подтверждения',a.backups?.[0]?.restored?'Проверено восстановлением':'Полная серверная копия')+'</div>';
   html+='<div class="sc-actions">'+scButton('check','Проверить обновления',disabled)+scButton('backup','Создать копию БД',disabled)+scButton('restart','Перезапустить API',disabled)+'</div>';
   html+='<p class="sc-note">Несинхронизированных рейсов на этом устройстве: '+scText(typeof offlinePendingCount==='function'?offlinePendingCount():'Нет данных')+'. Очереди остальных устройств доступны только на самих устройствах.</p>';
  }
  if(serverControlSection==='resources'){
   html+='<div class="sc-grid">'+scCard('Диск NAS',scBytes(disk.availableBytes)+' свободно',disk.totalBytes?'Использовано '+scBytes(disk.totalBytes-disk.availableBytes):'Нет измерений')+scCard('Оперативная память NAS',host.memory?scBytes(host.memory.usedBytes)+' / '+scBytes(host.memory.totalBytes):'Нет данных')+scCard('Нагрузка NAS',host.load?.join(' / ')||'Нет данных','Средняя нагрузка за 1, 5 и 15 минут')+scCard('Запросы API',s.api.requests,'С момента запуска API')+scCard('Ответ API, p95',s.api.p95Ms===null?'Нет измерений':s.api.p95Ms+' мс','Последние 500 запросов')+scCard('Ошибки API',s.api.errors,'Ответы 5xx с момента запуска')+scCard('Память процесса API',scBytes(s.api.memoryBytes))+scCard('Измерение NAS',scDate(a.heartbeat),a.available?'Свежие данные':'Данные устарели')+'</div><p class="sc-note">Показатели NAS получаем со службы управления. SMART, температура и состояние RAID пока не подключены: панель не подменяет их показателями контейнера.</p>';
  }
  if(serverControlSection==='updates'){
   html+='<div class="sc-grid">'+scCard('Приложение',window.TEST_APP_RELEASE?.version||'—','Номер виден всем ролям')+scCard('Сервер API',s.api.version)+scCard('Доступный серверный релиз',a.release?.version||'Нет проверенного релиза',a.release?.verified?'Проверки GitHub пройдены':'Проверка кнопкой ниже')+'</div>';
   if(a.release?.notes)html+='<p>'+scText(a.release.notes)+'</p>';
   html+='<div class="sc-actions">'+scButton('check','Проверить GitHub',disabled)+scButton('update','Обновить сервер',disabled||!a.release?.verified||a.release.version===s.api.version)+scButton('rollback','Вернуть предыдущий API',disabled||!a.rollbackAvailable)+scButton('app-update','Проверить приложение')+'</div><p class="sc-note">Перед обновлением API служба создаёт полную копию PostgreSQL и проверяет восстановление. При неудачном запуске возвращает прежний API. Рабочий контур отделён; эта панель управляет TEST.</p>';
  }
  if(serverControlSection==='backups'){
   html+='<div class="sc-actions">'+scButton('backup','Создать полную копию БД',disabled)+'</div><h4>Полные серверные копии</h4>';
   html+=(a.backups||[]).length?'<ul class="sc-list">'+a.backups.map(b=>'<li><b>'+scText(scDate(b.createdAt))+'</b><span>'+scText(scBytes(b.bytes))+' · '+(b.restored?'Восстановление проверено':'Требует проверки')+'</span></li>').join('')+'</ul>':'<p>Подтверждённых копий от службы ещё нет.</p>';
   html+='<h4>Копии данных приложения</h4><ul class="sc-list">'+s.backups.map(b=>'<li><b>'+scText(b.description||b.type)+'</b><span>'+scText(scDate(b.createdAt))+' · '+scText(scBytes(b.sizeBytes))+'</span></li>').join('')+'</ul><p class="sc-note">Выборочное восстановление данных доступно в существующем разделе резервных копий. Возврат API не откатывает рейсы и табель.</p>';
  }
  if(serverControlSection==='objects')html+='<div class="sc-actions">'+scButton('users','Пользователи и права')+'</div><ul class="sc-list">'+s.objects.map(o=>'<li><b>'+scText(o.name||o.id)+'</b><span>Открытых смен: '+scText(o.active_shifts)+'</span></li>').join('')+'</ul>';
  if(serverControlSection==='journal'){
   html+='<h4>Задания сервера</h4><ul class="sc-list">'+s.jobs.map(j=>'<li><b>'+scText(serverControlLabels[j.type])+' · '+scText(serverControlLabels[j.status])+'</b><span>'+scText(scDate(j.updated_at))+' · '+scText(serverControlLabels[j.stage]||j.stage)+(j.detail?.error?' · '+scText(j.detail.error):'')+'</span></li>').join('')+'</ul><h4>Этапы установки</h4><ul class="sc-list">'+s.events.map(e=>'<li>'+scText(scDate(e.created_at))+' · '+scText(serverControlLabels[e.stage]||e.stage)+'</li>').join('')+'</ul><h4>Последние ошибки API</h4><ul class="sc-list">'+s.api.recentErrors.map(e=>'<li>'+scText(scDate(e.at))+' · '+scText(e.method)+' '+scText(e.path)+' · '+scText(e.status)+'</li>').join('')+'</ul>';
  }
  html+='<p class="sc-note">Получено: '+scText(scDate(s.readAt))+'. Обновление показателей каждые 15 секунд, пока открыт этот раздел.</p>';
 }
 root.innerHTML=html;
 root.querySelectorAll('[data-sc-section]').forEach(b=>b.onclick=()=>{serverControlSection=b.dataset.scSection;renderServerControl();});
 root.querySelectorAll('[data-sc-action]').forEach(b=>b.onclick=()=>void serverControlAction(b.dataset.scAction));
}
async function openServerControl(){
 if(!scAllowed()){renderServerControl();return;}
 const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
 if(serverControlScope!==client.scope){serverControlScope=client.scope;serverControlSnapshot=null;serverControlError='';serverControlFlight=null;}
 if(serverControlFlight)return serverControlFlight;
 const work=(async()=>{try{const snapshot=await client.readServerControl();if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch||!scAllowed())return;serverControlSnapshot=snapshot;serverControlError='';}
 catch(e){if(client===nasRuntimeClient&&epoch===nasRuntimeEpoch)serverControlError=e.status===404?'Сервер ещё не обновлён для центра управления.':e.status===403?'Нет доступа к управлению сервером.':'Не удалось получить свежие данные. Серверные действия заблокированы.';}
 finally{if(client===nasRuntimeClient&&epoch===nasRuntimeEpoch){serverControlFlight=null;renderServerControl();}}})();
 serverControlFlight=work;renderServerControl();return work;
}
async function serverControlAction(type){
 if(type==='refresh')return openServerControl();
 if(type==='users'){switchAdminTab('users',document.querySelector('[onclick="switchAdminTab(\'users\', this)"]'));return;}
 if(type==='app-update'){await window.TestPWA?.checkForUpdates();return;}
 if(!scAllowed()||serverControlBusy||!serverControlSnapshot?.agent.available)return;
 const client=nasRuntimeClient,epoch=nasRuntimeEpoch,a=serverControlSnapshot.agent,key='samosval_working_test_server_command:'+client.scope;
 const questions={update:'Создать проверенную копию БД и обновить сервер TEST? Во время перезапуска устройства сохраняют действия локально. При неудаче служба вернёт прежний API.',restart:'Перезапустить API TEST? Связь с сервером кратковременно прервётся.',rollback:'Вернуть предыдущий API TEST? Рейсы и табель в базе останутся текущими.'};
 if(questions[type]&&!(await appConfirm(questions[type])))return;
 if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch||!scAllowed())return;
 serverControlBusy=true;renderServerControl();
 try{
  let op=JSON.parse(localStorage.getItem(key)||'null');
  const requested={type,channel:'test',...(['update','rollback'].includes(type)?{expectedImage:a.imageId}:{}),...(type==='update'?{releaseId:a.release.version}:{})};
  if(op&&(op.type!==type||op.channel!=='test'))throw Error('Предыдущее задание ещё не подтверждено. Повторите «'+(serverControlLabels[op.type]||op.type)+'», чтобы проверить его результат.');
  if(!op){op={id:'server_'+crypto.randomUUID().replaceAll('-',''),...requested};localStorage.setItem(key,JSON.stringify(op));}
  await client.submitServerCommand(op,{operationScope:client.scope});
  if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch)return;
  localStorage.removeItem(key);showToastEl('Задание принято службой NAS',false);
 }catch(e){if([400,403,409].includes(e.status))localStorage.removeItem(key);showError(e.message||'Результат пока не подтверждён. Повторная попытка использует тот же номер задания.');}
 finally{serverControlBusy=false;if(client===nasRuntimeClient&&epoch===nasRuntimeEpoch)await openServerControl();}
}
window.addEventListener('DOMContentLoaded',()=>{
 const style=document.createElement('style');
 // Внутренняя навигация центра управления: полоса закреплена над основной нижней
 // панелью (56px) и повторяет оформление вкладок табеля, чтобы кнопки не
 // накладывались друг на друга и на панель приложения.
 style.textContent=`.sc-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.sc-heading h3{margin:0 0 5px}.sc-channel{color:#f59e0b;font-size:11px;font-weight:800}
 .sc-nav{display:flex;gap:4px;overflow-x:auto;margin:12px 0 0;padding:4px 6px;position:fixed;left:6px;right:6px;bottom:60px;z-index:10059;background:var(--card);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 14px #0006;scrollbar-width:none;flex-shrink:0}
 .sc-nav::-webkit-scrollbar{display:none}
 .sc-nav button{font:inherit;white-space:nowrap;flex:0 0 auto;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);padding:6px 10px;font-size:11px;font-weight:600;line-height:1.2}
 .sc-nav button:active{transform:scale(.96)}
 .sc-nav [aria-pressed=true]{border-color:var(--primary);color:var(--primary);font-weight:800}
 .sc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.sc-card{display:flex;flex-direction:column;gap:7px;padding:13px;border:1px solid var(--border);background:var(--card);border-radius:12px;min-width:0}.sc-card>span,.sc-note,.sc-card small{font-size:11px;color:var(--muted);line-height:1.5}.sc-card strong{font-size:17px;overflow-wrap:anywhere}.sc-actions{display:flex;flex-wrap:wrap;gap:7px;margin:14px 0}.sc-list{list-style:none;padding:0}.sc-list li{display:flex;flex-direction:column;gap:5px;padding:11px 0;border-bottom:1px solid var(--border);font-size:12px;overflow-wrap:anywhere}.sc-list span{color:var(--muted)}.sc-status,.sc-progress{font-size:12px;line-height:1.5}.sc-progress{padding:12px;border:1px solid #f59e0b;border-radius:10px}
 #server-control-root{padding-bottom:58px}
 @media(min-width:800px){.sc-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}`;
 document.head.append(style);
 setInterval(()=>{if(!scAllowed()){serverControlSnapshot=null;serverControlFlight=null;if(scVisible())renderServerControl();}else if(scVisible())void openServerControl();},15000);
});
// Клиентский store контекстов параллельных смен.
//
// Каждая открытая смена живёт в собственном контексте: снимок, ревизии,
// формы, прокрутка, фокус, inflight-запросы и офлайн-очередь. Смена A никогда
// не читает и не меняет данные смены B. Выбранная смена — единственный
// источник для видимого экрана; `state.shift/logs/status` — только проекция.
//
// Ответ применяется лишь по полному generation-ключу
// uid/workspace/shift/requestKind. Поздний ответ отклоняется.
(function (root) {
  'use strict';

  const SELECTION_PREFIX = 'samosval:shift-contexts:selection:';
  const VISIBLE_STATES = { active: true, closing: true };

  function scopeStorageKey(uid, workspaceId) {
    return SELECTION_PREFIX + uid + '/' + workspaceId;
  }

  // Копия без общих ссылок: проекция и чтение не должны давать доступ к
  // внутреннему состоянию store.
  function copy(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    try {
      if (typeof structuredClone === 'function') return structuredClone(value);
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  // '2026-11-28' → '28.11.2026' — формат, который старый код показывает в
  // отчётах и печатных формах (`state.shift.startDate`).
  function moscowDateText(value) {
    if (typeof value !== 'string') return undefined;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? `${match[3]}.${match[2]}.${match[1]}` : undefined;
  }

  function normalizeShift(row) {
    if (!row || typeof row !== 'object') return null;
    const shiftId = typeof row.shiftId === 'string' && row.shiftId
      ? row.shiftId
      : (typeof row.id === 'string' ? row.id : '');
    if (!shiftId) return null;
    let state = typeof row.state === 'string' ? row.state : '';
    if (!state) state = row.closing ? 'closing' : (row.isActive === false ? 'closed' : 'active');
    return Object.assign({}, row, { shiftId, state });
  }

  function visibleShift(row) {
    const shift = normalizeShift(row);
    return shift && VISIBLE_STATES[shift.state] ? shift : null;
  }

  function emptyContext(shift) {
    return {
      shiftId: shift.shiftId,
      shift: copy(shift),
      loaded: false,
      stale: false,
      snapshot: null,
      revisions: {},
      serverGeneration: null,
      ui: { forms: {}, scroll: null, focus: null },
      inflight: {},
      pending: [],
      badge: { pending: 0, closing: shift.state === 'closing', conflict: false, updatedAt: 0 }
    };
  }

  function pendingServerReceiptCount(snapshot) {
    const receipts = snapshot && snapshot.pendingServerReceipts;
    if (Array.isArray(receipts)) return receipts.length;
    return Math.max(0, numberOrZero(receipts));
  }

  function snapshotRevision(snapshot) {
    if (!snapshot) return 0;
    if (snapshot.shiftRevision !== undefined) return numberOrZero(snapshot.shiftRevision);
    return numberOrZero(snapshot.revisions && snapshot.revisions.shift);
  }

  function createShiftContextStore(options) {
    const config = options || {};
    const uid = config.uid;
    const workspaceId = config.workspaceId;
    if (typeof uid !== 'string' || !uid) throw new TypeError('shift-contexts-require-uid');
    if (typeof workspaceId !== 'string' || !workspaceId) throw new TypeError('shift-contexts-require-workspace');
    const storage = config.storage || null;
    const storageKey = scopeStorageKey(uid, workspaceId);

    let visible = [];
    let visibleById = Object.create(null);
    let contexts = Object.create(null);
    let activeShiftId = null;
    let restoredContext = null;
    let detachedTrips = Object.create(null);
    const generations = Object.create(null);

    function readSelection() {
      if (!storage) return null;
      try {
        const raw = storage.getItem(storageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.uid !== uid || parsed.workspaceId !== workspaceId) return null;
        return typeof parsed.shiftId === 'string' && parsed.shiftId ? parsed.shiftId : null;
      } catch (_) {
        return null;
      }
    }

    function writeSelection(shiftId) {
      if (!storage) return;
      try {
        if (shiftId) storage.setItem(storageKey, JSON.stringify({ uid, workspaceId, shiftId }));
        else storage.removeItem(storageKey);
      } catch (_) { /* переполненное хранилище не должно ломать выбор смены */ }
    }

    // Сохранённый выбор применяется только после того, как сервер подтвердил
    // видимость смены. Архивная смена сюда попасть не может.
    let pendingSelection = readSelection();

    function visibleShifts() {
      return copy(visible);
    }

    function context(shiftId) {
      const found = contexts[shiftId];
      return found ? copy(found) : null;
    }

    function visibleContext() {
      return activeShiftId ? context(activeShiftId) : null;
    }

    function activeId() {
      return activeShiftId;
    }

    function restored() {
      return restoredContext ? copy(restoredContext) : null;
    }

    function replaceVisibleShifts(rows) {
      const list = Array.isArray(rows) ? rows : [];
      const next = [];
      const nextById = Object.create(null);
      for (const row of list) {
        const shift = visibleShift(row);
        if (!shift || nextById[shift.shiftId]) continue;
        next.push(shift);
        nextById[shift.shiftId] = shift;
      }
      visible = next;
      visibleById = nextById;

      // Контекст скрытой или архивной смены не должен оставаться доступным.
      Object.keys(contexts).forEach(shiftId => {
        if (!nextById[shiftId]) delete contexts[shiftId];
      });
      for (const shift of next) {
        const existing = contexts[shift.shiftId];
        if (existing) {
          existing.shift = copy(shift);
          existing.badge.closing = shift.state === 'closing';
        } else {
          contexts[shift.shiftId] = emptyContext(shift);
        }
      }

      let candidate = activeShiftId && nextById[activeShiftId] ? activeShiftId : null;
      if (!candidate && pendingSelection && nextById[pendingSelection]) candidate = pendingSelection;
      if (!candidate && next.length) candidate = next[0].shiftId;
      pendingSelection = null;
      activeShiftId = candidate;

      // Устаревший сохранённый выбор убираем, чтобы он не ждал смену вечно.
      const stored = readSelection();
      if (stored && !nextById[stored]) writeSelection(null);
      return visibleShifts();
    }

    function selectShift(shiftId) {
      if (typeof shiftId !== 'string' || !visibleById[shiftId]) return false;
      activeShiftId = shiftId;
      writeSelection(shiftId);
      return true;
    }

    function beginRequest(input, maybeKind) {
      const shiftId = typeof input === 'string' ? input : (input && input.shiftId);
      const requestKind = typeof input === 'string' ? maybeKind : (input && input.requestKind);
      if (typeof shiftId !== 'string' || !shiftId || typeof requestKind !== 'string' || !requestKind) {
        throw new TypeError('shift-context-request-requires-shift-and-kind');
      }
      const target = contexts[shiftId];
      if (!target) return null;
      const key = shiftId + '|' + requestKind;
      generations[key] = (generations[key] || 0) + 1;
      const token = { uid, workspaceId, shiftId, requestKind, generation: generations[key] };
      target.inflight[requestKind] = token;
      return copy(token);
    }

    function validateGeneration(generation, shiftId, requestKind) {
      if (!generation || typeof generation !== 'object') return 'invalid-generation';
      if (generation.uid !== uid || generation.workspaceId !== workspaceId) return 'foreign-generation-scope';
      if (generation.shiftId !== shiftId) return 'generation-shift-mismatch';
      if (generation.requestKind !== requestKind) return 'generation-kind-mismatch';
      const target = contexts[shiftId];
      const current = target && target.inflight[requestKind];
      if (!current || current.generation !== generation.generation) return 'stale-generation';
      return null;
    }

    function indexDetachedTrips(shiftId, rows) {
      Object.keys(detachedTrips).forEach(key => {
        const trip = detachedTrips[key];
        if (!trip) return;
        if (trip.sourceShiftId === shiftId || trip.destinationShiftId === shiftId) delete detachedTrips[key];
      });
      (Array.isArray(rows) ? rows : []).forEach(row => {
        if (!row || typeof row !== 'object') return;
        if (typeof row.sourceShiftId !== 'string' || !row.sourceShiftId) return;
        if (typeof row.cycleId !== 'string' || !row.cycleId) return;
        detachedTrips[row.sourceShiftId + ':' + row.cycleId] = copy(row);
      });
    }

    function applySnapshotData(target, snapshot, incomingRevision) {
      target.snapshot = copy(snapshot);
      if (snapshot.shift) target.shift = copy(snapshot.shift);
      target.revisions = copy(snapshot.revisions || {});
      target.revisions.shift = incomingRevision;
      target.serverGeneration = snapshot.serverGeneration === undefined ? null : snapshot.serverGeneration;
      target.loaded = true;
      target.stale = false;
      target.badge.conflict = false;
      target.badge.closing = target.shift && target.shift.state === 'closing';
      target.badge.pending = target.pending.length + pendingServerReceiptCount(snapshot);
      target.badge.updatedAt = Date.now();
      indexDetachedTrips(target.shiftId, snapshot.detachedOpenTrips);
    }

    function applySnapshot(input) {
      const request = input || {};
      const generation = request.generation;
      const shiftId = generation && generation.shiftId;
      if (typeof shiftId !== 'string' || !contexts[shiftId]) {
        return { applied: false, reason: 'shift-not-visible', shiftId: shiftId || null };
      }
      const requestKind = generation.requestKind;
      const invalid = validateGeneration(generation, shiftId, requestKind);
      if (invalid) return { applied: false, reason: invalid, shiftId };

      const snapshot = request.snapshot;
      if (!snapshot || typeof snapshot !== 'object') return { applied: false, reason: 'invalid-snapshot', shiftId };
      if (snapshot.shiftId !== shiftId) return { applied: false, reason: 'snapshot-shift-mismatch', shiftId };
      if (snapshot.workspaceId && snapshot.workspaceId !== workspaceId) {
        return { applied: false, reason: 'snapshot-workspace-mismatch', shiftId };
      }

      const target = contexts[shiftId];
      const incomingRevision = snapshotRevision(snapshot);
      const currentRevision = numberOrZero(target.revisions.shift);
      if (target.loaded && incomingRevision < currentRevision) {
        delete target.inflight[requestKind];
        target.stale = true;
        target.badge.conflict = true;
        return { applied: false, reason: 'stale-shift-revision', shiftId, currentRevision, incomingRevision };
      }

      applySnapshotData(target, snapshot, incomingRevision);
      delete target.inflight[requestKind];
      return { applied: true, shiftId, revision: incomingRevision, visible: shiftId === activeShiftId };
    }

    function applyCrossShiftResult(input) {
      const request = input || {};
      const sourceShiftId = request.sourceShiftId;
      const destinationShiftId = request.destinationShiftId;
      const requestKind = request.requestKind;
      const refresh = [sourceShiftId, destinationShiftId].filter(Boolean);
      const fail = reason => {
        refresh.forEach(shiftId => {
          const target = contexts[shiftId];
          if (!target) return;
          target.stale = true;
          target.badge.conflict = true;
          if (requestKind && target.inflight[requestKind]) delete target.inflight[requestKind];
        });
        return { applied: false, reason, refresh: copy(refresh) };
      };
      if (typeof sourceShiftId !== 'string' || typeof destinationShiftId !== 'string'
        || !sourceShiftId || !destinationShiftId || sourceShiftId === destinationShiftId
        || typeof requestKind !== 'string' || !requestKind) {
        return fail('invalid-cross-shift-key');
      }
      if (!contexts[sourceShiftId] || !contexts[destinationShiftId]) return fail('shift-not-visible');

      const sourceInvalid = validateGeneration(request.sourceGeneration, sourceShiftId, requestKind);
      if (sourceInvalid) return fail(sourceInvalid);
      const destinationInvalid = validateGeneration(request.destinationGeneration, destinationShiftId, requestKind);
      if (destinationInvalid) return fail(destinationInvalid);

      const source = contexts[sourceShiftId];
      const destination = contexts[destinationShiftId];
      const expectedSource = request.sourceRevision === undefined ? numberOrZero(source.revisions.shift) : numberOrZero(request.sourceRevision);
      const expectedDestination = request.destinationRevision === undefined ? numberOrZero(destination.revisions.shift) : numberOrZero(request.destinationRevision);
      if (expectedSource !== numberOrZero(source.revisions.shift)
        || expectedDestination !== numberOrZero(destination.revisions.shift)) {
        return fail('stale-cross-shift-result');
      }

      // Оба снимка проверяются до применения: частичный результат запрещён.
      const sourceSnapshot = request.sourceSnapshot;
      const destinationSnapshot = request.destinationSnapshot;
      if (sourceSnapshot) {
        if (sourceSnapshot.shiftId !== sourceShiftId) return fail('snapshot-shift-mismatch');
        if (sourceSnapshot.workspaceId && sourceSnapshot.workspaceId !== workspaceId) return fail('snapshot-workspace-mismatch');
      }
      if (destinationSnapshot) {
        if (destinationSnapshot.shiftId !== destinationShiftId) return fail('snapshot-shift-mismatch');
        if (destinationSnapshot.workspaceId && destinationSnapshot.workspaceId !== workspaceId) return fail('snapshot-workspace-mismatch');
      }

      if (sourceSnapshot) applySnapshotData(source, sourceSnapshot, snapshotRevision(sourceSnapshot));
      if (destinationSnapshot) applySnapshotData(destination, destinationSnapshot, snapshotRevision(destinationSnapshot));
      delete source.inflight[requestKind];
      delete destination.inflight[requestKind];
      return { applied: true, sourceShiftId, destinationShiftId };
    }

    function withContext(shiftId, mutate) {
      const target = contexts[shiftId];
      if (!target) return false;
      mutate(target);
      return true;
    }

    function setForm(shiftId, formKey, value) {
      if (typeof formKey !== 'string' || !formKey) return false;
      return withContext(shiftId, target => {
        if (value === undefined) delete target.ui.forms[formKey];
        else target.ui.forms[formKey] = copy(value);
      });
    }

    function setScroll(shiftId, position) {
      return withContext(shiftId, target => {
        target.ui.scroll = position === undefined ? null : copy(position);
      });
    }

    function setFocus(shiftId, focus) {
      return withContext(shiftId, target => {
        target.ui.focus = focus === undefined ? null : copy(focus);
      });
    }

    function updateUi(shiftId, patch) {
      if (!patch || typeof patch !== 'object') return false;
      return withContext(shiftId, target => {
        if (patch.forms && typeof patch.forms === 'object') target.ui.forms = copy(patch.forms);
        if ('scroll' in patch) target.ui.scroll = patch.scroll === undefined ? null : copy(patch.scroll);
        if ('focus' in patch) target.ui.focus = patch.focus === undefined ? null : copy(patch.focus);
      });
    }

    function setPending(shiftId, rows) {
      const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
      return withContext(shiftId, target => {
        target.pending = copy(list);
        target.badge.pending = target.pending.length + pendingServerReceiptCount(target.snapshot);
      });
    }

    function setRestoredContext(value) {
      if (!value || typeof value !== 'object' || typeof value.archiveId !== 'string' || !value.archiveId) {
        throw new TypeError('restored-context-requires-archive-id');
      }
      restoredContext = copy(value);
      return restored();
    }

    function detachedTrip(sourceShiftId, cycleId) {
      if (typeof sourceShiftId !== 'string' || typeof cycleId !== 'string') return null;
      const trip = detachedTrips[sourceShiftId + ':' + cycleId];
      return trip ? copy(trip) : null;
    }

    function detachedTripsFor(shiftId) {
      return copy(Object.keys(detachedTrips)
        .map(key => detachedTrips[key])
        .filter(trip => trip && (trip.sourceShiftId === shiftId || trip.destinationShiftId === shiftId)));
    }

    function clearSession() {
      visible = [];
      visibleById = Object.create(null);
      contexts = Object.create(null);
      activeShiftId = null;
      restoredContext = null;
      detachedTrips = Object.create(null);
      pendingSelection = null;
      Object.keys(generations).forEach(key => delete generations[key]);
      writeSelection(null);
    }

    // Старый код читает смену плоскими полями (`isActive`, `startDate`,
    // `workShift`, `startedAt`), а v2-снимок отдаёт `state` и вложенный
    // `payload`. Без совместимых полей экран игр считает смену закрытой,
    // отчёты печатают пустую дату, авто-бэкап не видит активную смену.
    // Дополняются только отсутствующие поля: значения v2 не перезаписываются.
    function legacyShiftView(shift, shiftId) {
      const view = copy(shift);
      const payload = view.payload && typeof view.payload === 'object' ? view.payload : {};
      const fill = (key, value) => {
        if (view[key] === undefined || view[key] === null) view[key] = value;
      };
      view.id = shiftId;
      const shiftState = typeof view.state === 'string' ? view.state : (payload.state || '');
      fill('isActive', shiftState === 'active' || shiftState === 'closing');
      fill('closing', shiftState === 'closing' || payload.closing === true);
      fill('startDate', payload.startDate || moscowDateText(view.workDate || payload.workDate));
      fill('date', payload.date || view.workDate);
      fill('workShift', view.shiftType || payload.workShift || payload.type);
      fill('type', view.shiftType || payload.type || payload.workShift);
      // analytics-v2 считает длительность как `Date.now() - startedAt`, то есть
      // ждёт миллисекунды, а не ISO-строку `openedAt`.
      if (typeof view.startedAt !== 'number') {
        const started = Number(payload.startedAt);
        const opened = Date.parse(view.openedAt || '');
        view.startedAt = Number.isFinite(started) && started > 0
          ? started
          : (Number.isFinite(opened) ? opened : null);
      }
      return view;
    }

    // Единственная совместимая проекция для старого кода. Пишет копии, а не
    // ссылки: изменить store через legacy-объект нельзя. Источник истины —
    // контекст выбранной смены, а не state.
    function projectActiveContextToLegacyState(legacyState) {
      if (!legacyState || typeof legacyState !== 'object') throw new TypeError('legacy-state-required');
      const target = activeShiftId ? contexts[activeShiftId] : null;
      const snapshot = target && target.snapshot;
      // Старый код адресует смену полем `id` (getLogs, captureLineIntent,
      // офлайн-очередь). v2-документ несёт `shiftId`, поэтому проекция обязана
      // дать оба поля: иначе выбранная смена выглядит «без id» и действия
      // уходят без shiftId.
      legacyState.shift = target ? legacyShiftView(target.shift, target.shiftId) : null;
      legacyState.logs = snapshot && Array.isArray(snapshot.logs) ? copy(snapshot.logs) : [];
      const truckStatus = {};
      const statuses = snapshot && Array.isArray(snapshot.statuses) ? snapshot.statuses : [];
      statuses.forEach(row => {
        if (!row || typeof row !== 'object') return;
        const id = row.id || row.truckId;
        if (!id) return;
        truckStatus[id] = copy(Object.assign({}, row, { id }));
      });
      legacyState.truckStatus = truckStatus;
      // Совместимость: в описании задачи поле называется status, фактический
      // legacy-код читает truckStatus. Оба поля — копии одного снимка.
      legacyState.status = copy(truckStatus);
      return legacyState;
    }

    return {
      replaceVisibleShifts,
      selectShift,
      beginRequest,
      applySnapshot,
      applyCrossShiftResult,
      visibleShifts,
      visibleContext,
      activeShiftId: activeId,
      context,
      setForm,
      setScroll,
      setFocus,
      updateUi,
      setPending,
      setRestoredContext,
      restoredContext: restored,
      detachedTrip,
      detachedTripsFor,
      clearSession,
      projectActiveContextToLegacyState
    };
  }

  const api = { createShiftContextStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestShiftContexts = api;
})(typeof window !== 'undefined' ? window : globalThis);
// Клиентский транспорт v2 параллельных смен.
//
// Один ответ — один проверенный пакет. До публикации в store контекстов
// сверяются protocolVersion, workspaceId, shiftId и ревизии сущностей: ответ с
// чужим workspace или чужой сменой не публикуется никогда. Непрозрачные
// курсоры передаются как есть и не пересобираются. Стабильные коды ошибок v2
// сохраняются вместе с безопасными деталями. Повтор после таймаута идёт с ТЕМ
// ЖЕ operationId и ровно один раз: идемпотентность обеспечивает сервер.
//
// Файл — classic script (IIFE → globalThis), чтобы работать в собранном шелле
// без ESM. Общий запрос приходит снаружи (session-client), поэтому транспорт
// проверяется без сети.
(function (root) {
  'use strict';

  const PROTOCOL_VERSION = 2;
  const VISIBLE_STATES = ['active', 'closing'];
  const DEFAULT_INTERVAL_MS = 4000;
  const MAX_DETAIL_LENGTH = 200;
  // Только эти поля серверных details безопасно показывать: никаких телефонов,
  // почты, uid и вложенных объектов. Список обязан совпадать с серверным
  // `DETAIL_KEYS` (server/src/v2-errors.mjs) плюс поля, которые клиент выводит
  // сам. Раньше он разошёлся с сервером и выбрасывал всю половину `actual*`,
  // поэтому конфликт ревизий приходил без фактических чисел: «было 2, стало 5»
  // сказать было нечем. Сервер уже отфильтровал PII, повторная фильтрация
  // списком не должна терять пару expected/actual.
  const SAFE_DETAIL_KEYS = [
    // серверный закрытый список (v2-errors.mjs)
    'field', 'reason', 'state', 'limit', 'cursor',
    'operationId', 'protocolVersion',
    'shiftId', 'objectId', 'workDate', 'shiftType', 'truckId',
    'sourceShiftId', 'destinationShiftId', 'cycleId', 'stage',
    'expectedRevision', 'actualRevision',
    'expectedShiftRevision', 'actualShiftRevision',
    'expectedMembershipRevision', 'actualMembershipRevision',
    'expectedStatusRevision', 'actualStatusRevision',
    'expectedCycleRevision', 'actualCycleRevision',
    'expectedTtnRevision', 'actualTtnRevision',
    'expectedDetachedCycleRevision', 'actualDetachedCycleRevision',
    'expectedArchiveRevision', 'actualArchiveRevision',
    'expectedMaterialMarkerRevision', 'actualMaterialMarkerRevision',
    'retryAfterSeconds', 'replayed',
    // поля, которые клиент формирует сам (квитанции и проверки снимков)
    'phase', 'type', 'conflict', 'objectName', 'archiveId', 'archiveRevision',
    'recordId', 'restoredContextId', 'contextRevision',
    'currentRevision', 'shiftRevision', 'retryAfterMs'
  ];

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function isRevision(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function segment(value) {
    return encodeURIComponent(String(value));
  }

  // Тело команды без undefined: JSON.stringify выбросил бы их, но тогда
  // сравнение отправленного тела в тестах и логах расходилось бы с фактом.
  function compact(input) {
    const out = {};
    if (!isRecord(input)) return out;
    Object.keys(input).forEach(key => {
      if (input[key] !== undefined) out[key] = input[key];
    });
    return out;
  }

  function safeDetails(input) {
    const out = {};
    if (!isRecord(input)) return out;
    for (const key of SAFE_DETAIL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      const value = input[key];
      if (typeof value === 'string') out[key] = value.slice(0, MAX_DETAIL_LENGTH);
      else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
      else if (typeof value === 'boolean' || value === null) out[key] = value;
    }
    return out;
  }

  function failure(code, details, extra) {
    return Object.assign({
      ok: false,
      error: { code, status: 0, retryable: false, uncertain: false, details: details || {} }
    }, extra || {});
  }

  function shiftRowId(row) {
    if (!isRecord(row)) return '';
    if (isNonEmptyString(row.shiftId)) return row.shiftId;
    return isNonEmptyString(row.id) ? row.id : '';
  }

  function createV2Transport(options) {
    const config = options || {};
    const request = config.request;
    const uid = config.uid;
    const workspaceId = config.workspaceId;
    const store = config.store || null;
    if (typeof request !== 'function') throw new TypeError('v2-transport-requires-request');
    if (!isNonEmptyString(uid)) throw new TypeError('v2-transport-requires-uid');
    if (!isNonEmptyString(workspaceId)) throw new TypeError('v2-transport-requires-workspace');

    let listGeneration = 0;
    let publishedListGeneration = 0;

    function normalizeError(error) {
      if (error && isNonEmptyString(error.serverCode)) {
        return {
          code: error.serverCode,
          status: numberOrZero(error.status),
          retryable: error.retryable === true,
          uncertain: error.uncertain === true,
          details: safeDetails(error.serverDetails)
        };
      }
      if (error && isNonEmptyString(error.code)) {
        return {
          code: error.code,
          status: numberOrZero(error.status),
          retryable: error.retryable === true,
          uncertain: error.uncertain === true,
          details: {}
        };
      }
      return { code: 'v2-transport-failure', status: 0, retryable: true, uncertain: true, details: {} };
    }

    // Один запрос = один ответ. Повтор разрешён только для транспортных
    // ошибок (таймаут/обрыв) и только один: тело уже зафиксировано, поэтому
    // operationId на сервере остаётся тем же.
    async function call(path, settings) {
      const options = settings || {};
      const method = options.method || 'GET';
      const body = options.body;
      const send = () => request(path, { method, operation: body, validate: isRecord });
      try {
        return { ok: true, data: await send(), retried: false };
      } catch (error) {
        if (!(error && error.retryable === true)) return { ok: false, error: normalizeError(error) };
        try {
          return { ok: true, data: await send(), retried: true };
        } catch (again) {
          return { ok: false, error: normalizeError(again) };
        }
      }
    }

    function validateShiftList(data) {
      if (!isRecord(data)) return 'invalid-list';
      if (data.protocolVersion !== undefined && data.protocolVersion !== PROTOCOL_VERSION) return 'protocol-version-mismatch';
      if (data.workspaceId !== undefined && data.workspaceId !== workspaceId) return 'workspace-mismatch';
      if (!Array.isArray(data.items)) return 'invalid-list';
      if (data.nextCursor !== undefined && data.nextCursor !== null && typeof data.nextCursor !== 'string') return 'invalid-cursor';
      const seen = Object.create(null);
      for (const row of data.items) {
        if (!isRecord(row)) return 'invalid-list';
        const shiftId = shiftRowId(row);
        if (!shiftId) return 'invalid-shift-id';
        if (seen[shiftId]) return 'duplicate-shift';
        seen[shiftId] = true;
        if (row.workspaceId !== undefined && row.workspaceId !== workspaceId) return 'workspace-mismatch';
        if (row.shiftRevision !== undefined && !isRevision(row.shiftRevision)) return 'invalid-shift-revision';
        if (row.state !== undefined && typeof row.state !== 'string') return 'invalid-shift-state';
      }
      return null;
    }

    // Снимок проверяется до публикации: protocolVersion, workspace, shift,
    // ревизии и принадлежность каждой строки статуса/рейса своей смене.
    function validateSnapshot(snapshot, shiftId) {
      if (!isRecord(snapshot)) return 'invalid-snapshot';
      if (snapshot.protocolVersion !== PROTOCOL_VERSION) return 'protocol-version-mismatch';
      if (snapshot.workspaceId !== workspaceId) return 'workspace-mismatch';
      if (snapshot.shiftId !== shiftId) return 'shift-mismatch';
      const revision = snapshot.shiftRevision !== undefined
        ? snapshot.shiftRevision
        : (isRecord(snapshot.revisions) ? snapshot.revisions.shift : undefined);
      if (!isRevision(revision)) return 'invalid-shift-revision';
      if (!isRecord(snapshot.shift)) return 'invalid-shift';
      if (shiftRowId(snapshot.shift) !== shiftId) return 'shift-mismatch';
      for (const key of ['members', 'statuses', 'logs', 'detachedOpenTrips']) {
        if (snapshot[key] !== undefined && !Array.isArray(snapshot[key])) return 'invalid-' + key;
      }
      for (const key of ['statuses', 'logs']) {
        for (const row of snapshot[key] || []) {
          if (!isRecord(row)) return 'invalid-' + key;
          if (row.shiftId !== shiftId) return 'entity-shift-mismatch';
        }
      }
      for (const row of snapshot.statuses || []) {
        if (row.cycleRevision !== undefined && !isRevision(row.cycleRevision)) return 'invalid-entity-revision';
        if (row.ttnRevision !== undefined && !isRevision(row.ttnRevision)) return 'invalid-entity-revision';
      }
      for (const row of snapshot.detachedOpenTrips || []) {
        if (!isRecord(row)) return 'invalid-detached-open-trips';
        const source = row.sourceShiftId;
        const destination = row.destinationShiftId;
        if (source === undefined && destination === undefined) continue;
        if (source !== shiftId && destination !== shiftId) return 'entity-shift-mismatch';
      }
      if (isRecord(snapshot.revisions)) {
        for (const key of Object.keys(snapshot.revisions)) {
          if (!isRevision(snapshot.revisions[key])) return 'invalid-revision';
        }
      }
      return null;
    }

    function validateReceipt(data, operationId, shiftId) {
      if (!isRecord(data)) return 'invalid-receipt';
      if (data.protocolVersion !== PROTOCOL_VERSION) return 'protocol-version-mismatch';
      if (data.operationId !== operationId) return 'operation-id-mismatch';
      if (typeof data.replayed !== 'boolean') return 'invalid-receipt';
      if (!isRecord(data.result)) return 'invalid-receipt';
      if (data.workspaceId !== undefined && data.workspaceId !== workspaceId) return 'workspace-mismatch';
      if (shiftId && data.shiftId !== undefined && data.shiftId !== shiftId) return 'shift-mismatch';
      const resultShiftId = shiftRowId(data.result.shift);
      if (shiftId && resultShiftId && resultShiftId !== shiftId) return 'shift-mismatch';
      return null;
    }

    async function listShifts(input) {
      const settings = input || {};
      const states = Array.isArray(settings.states) && settings.states.length ? settings.states : VISIBLE_STATES;
      const limit = Number.isSafeInteger(settings.limit) && settings.limit >= 1 && settings.limit <= 100 ? settings.limit : 50;
      const params = new URLSearchParams();
      params.set('state', states.join(','));
      params.set('limit', String(limit));
      // Курсор непрозрачен: только пробрасываем, ничего не разбираем.
      if (isNonEmptyString(settings.cursor)) params.set('cursor', settings.cursor);
      const generation = ++listGeneration;
      const response = await call('/api/v2/shifts?' + params.toString(), { method: 'GET' });
      if (!response.ok) return Object.assign({ listGeneration: generation }, response);
      const problem = validateShiftList(response.data);
      if (problem) return failure('invalid-api-response', { reason: problem }, { listGeneration: generation, retried: !!response.retried });
      // Ответ, не совпавший с поколением запроса, не публикуется.
      if (generation < publishedListGeneration) {
        return failure('stale-list-generation', {}, { listGeneration: generation });
      }
      publishedListGeneration = generation;
      const items = response.data.items.slice();
      const nextCursor = typeof response.data.nextCursor === 'string' ? response.data.nextCursor : null;
      if (store) store.replaceVisibleShifts(items);
      return { ok: true, items, nextCursor, listGeneration: generation, retried: !!response.retried };
    }

    async function readShiftSnapshot(input) {
      const settings = input || {};
      const shiftId = settings.shiftId;
      const requestKind = isNonEmptyString(settings.requestKind) ? settings.requestKind : 'snapshot';
      if (!isNonEmptyString(shiftId)) return failure('invalid-shift-id');
      let generation = null;
      if (store) {
        generation = store.beginRequest({ shiftId, requestKind });
        if (!generation) return failure('shift-not-visible', {}, { shiftId, generation: null, applied: false });
      }
      const response = await call('/api/v2/shifts/' + segment(shiftId) + '/snapshot', { method: 'GET' });
      if (!response.ok) return Object.assign({ shiftId, generation, applied: false }, response);
      const problem = validateSnapshot(response.data, shiftId);
      if (problem) {
        return failure('invalid-api-response', { reason: problem }, { shiftId, generation, applied: false, retried: !!response.retried });
      }
      if (!store) {
        return { ok: true, shiftId, generation: null, snapshot: response.data, applied: false, retried: !!response.retried };
      }
      const applied = store.applySnapshot({ generation, snapshot: response.data });
      if (!applied.applied) {
        return Object.assign(
          failure('snapshot-not-applied', { reason: applied.reason }, { shiftId, generation, applied: false }),
          applied.currentRevision === undefined ? {} : { currentRevision: applied.currentRevision, incomingRevision: applied.incomingRevision }
        );
      }
      return { ok: true, shiftId, generation, revision: applied.revision, applied: true, visible: applied.visible };
    }

    async function command(settings) {
      const operationId = settings.operationId;
      if (!isNonEmptyString(operationId)) return failure('operation-id-required');
      const body = Object.assign({ operationId, protocolVersion: PROTOCOL_VERSION }, compact(settings.body));
      const response = await call(settings.path, { method: settings.method, body });
      if (!response.ok) return response;
      const problem = validateReceipt(response.data, operationId, settings.shiftId);
      if (problem) {
        return failure('invalid-api-response', { reason: problem }, { operationId, retried: !!response.retried });
      }
      return {
        ok: true,
        operationId,
        replayed: response.data.replayed,
        retried: !!response.retried,
        result: response.data.result
      };
    }

    function requireFields(input, keys) {
      for (const key of keys) {
        if (!isNonEmptyString(input[key])) return key;
      }
      return null;
    }

    function createShift(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'objectId', 'workDate', 'shiftType']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/shifts',
        operationId: settings.operationId,
        body: {
          objectId: settings.objectId,
          workDate: settings.workDate,
          shiftType: settings.shiftType,
          cycleMinutes: settings.cycleMinutes
        }
      });
    }

    function changeShiftObject(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'objectId']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'PATCH',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/object',
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: {
          objectId: settings.objectId,
          expectedShiftRevision: settings.expectedShiftRevision
        }
      });
    }

    function addMember(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'uid']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/members',
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: {
          uid: settings.uid,
          expectedShiftRevision: settings.expectedShiftRevision,
          expectedMembershipRevision: settings.expectedMembershipRevision
        }
      });
    }

    function removeMember(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'uid']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'DELETE',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/members/' + segment(settings.uid),
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: {
          expectedShiftRevision: settings.expectedShiftRevision,
          expectedMembershipRevision: settings.expectedMembershipRevision
        }
      });
    }

    function addTruck(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'truckId']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/trucks',
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: {
          truckId: settings.truckId,
          expectedShiftRevision: settings.expectedShiftRevision
        }
      });
    }

    function removeTruck(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'truckId']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'DELETE',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/trucks/' + segment(settings.truckId),
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: {
          expectedShiftRevision: settings.expectedShiftRevision,
          expectedStatusRevision: settings.expectedStatusRevision,
          expectedCycleRevision: settings.expectedCycleRevision,
          expectedTtnRevision: settings.expectedTtnRevision
        }
      });
    }

    function currentRevision(shiftId) {
      const context = store ? store.context(shiftId) : null;
      return context && context.revisions ? context.revisions.shift : undefined;
    }

    // Обе смены читаются и публикуются одной операцией store: частичный
    // результат запрещён, иначе экран одной смены показывал бы перевод.
    async function refreshCrossShift(input) {
      const settings = input || {};
      const sourceShiftId = settings.sourceShiftId;
      const destinationShiftId = settings.destinationShiftId;
      const requestKind = isNonEmptyString(settings.requestKind) ? settings.requestKind : 'cross-shift';
      if (!store) return { applied: false, reason: 'shift-contexts-unavailable' };
      if (!isNonEmptyString(sourceShiftId) || !isNonEmptyString(destinationShiftId) || sourceShiftId === destinationShiftId) {
        return { applied: false, reason: 'invalid-cross-shift-key' };
      }
      const sourceGeneration = store.beginRequest({ shiftId: sourceShiftId, requestKind });
      const destinationGeneration = store.beginRequest({ shiftId: destinationShiftId, requestKind });
      if (!sourceGeneration || !destinationGeneration) return { applied: false, reason: 'shift-not-visible' };
      const [source, destination] = await Promise.all([
        call('/api/v2/shifts/' + segment(sourceShiftId) + '/snapshot', { method: 'GET' }),
        call('/api/v2/shifts/' + segment(destinationShiftId) + '/snapshot', { method: 'GET' })
      ]);
      if (!source.ok || !destination.ok) {
        return { applied: false, reason: 'read-failed', error: !source.ok ? source.error : destination.error };
      }
      const sourceProblem = source.data && source.data.shiftId === sourceShiftId
        ? validateSnapshot(source.data, sourceShiftId)
        : null;
      const destinationProblem = destination.data && destination.data.shiftId === destinationShiftId
        ? validateSnapshot(destination.data, destinationShiftId)
        : null;
      if (sourceProblem || destinationProblem) {
        return { applied: false, reason: sourceProblem || destinationProblem };
      }
      // Идентичность смен проверяет store: при несовпадении ни одна смена не
      // публикуется, а обе помечаются на перечитывание.
      return store.applyCrossShiftResult({
        sourceShiftId,
        destinationShiftId,
        requestKind,
        sourceGeneration,
        destinationGeneration,
        sourceRevision: settings.sourceRevision,
        destinationRevision: settings.destinationRevision,
        sourceSnapshot: source.data,
        destinationSnapshot: destination.data
      });
    }

    async function forceTransferTruck(input) {
      const settings = input || {};
      if (settings.confirmTransfer !== true) return failure('transfer-confirmation-required');
      const missing = requireFields(settings, ['operationId', 'sourceShiftId', 'destinationShiftId', 'truckId']);
      if (missing) return failure('invalid-argument', { field: missing });
      const sourceRevision = currentRevision(settings.sourceShiftId);
      const destinationRevision = currentRevision(settings.destinationShiftId);
      const response = await command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.destinationShiftId) + '/trucks/' + segment(settings.truckId) + '/force-transfer',
        operationId: settings.operationId,
        shiftId: settings.destinationShiftId,
        body: {
          sourceShiftId: settings.sourceShiftId,
          // Смена назначения обязана быть и в теле: сервер сверяет её с путём
          // и отказывает в переносе, если тело называет другую смену (§5.4).
          // Без поля команда всегда падала с invalid-command/destinationShiftId.
          destinationShiftId: settings.destinationShiftId,
          expectedSourceShiftRevision: settings.expectedSourceShiftRevision,
          expectedDestinationShiftRevision: settings.expectedDestinationShiftRevision,
          expectedStatusRevision: settings.expectedStatusRevision,
          expectedCycleRevision: settings.expectedCycleRevision,
          expectedTtnRevision: settings.expectedTtnRevision,
          confirmTransfer: true
        }
      });
      if (!response.ok) return response;
      response.crossShift = await refreshCrossShift({
        sourceShiftId: settings.sourceShiftId,
        destinationShiftId: settings.destinationShiftId,
        requestKind: 'cross-shift',
        sourceRevision,
        destinationRevision
      });
      return response;
    }

    async function completeDetachedTrip(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'sourceShiftId', 'destinationShiftId', 'cycleId', 'truckId', 'type']);
      if (missing) return failure('invalid-argument', { field: missing });
      const sourceRevision = currentRevision(settings.sourceShiftId);
      const destinationRevision = currentRevision(settings.destinationShiftId);
      const response = await command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.sourceShiftId) + '/detached-trips/' + segment(settings.cycleId) + '/complete',
        operationId: settings.operationId,
        shiftId: settings.sourceShiftId,
        body: Object.assign({}, isRecord(settings.fields) ? settings.fields : {}, compact({
          // Исходная смена едет и в пути, и в теле: сервер читает
          // `sourceShiftId` из тела и сверяет со сменой пути (§5.4). Без поля
          // команда всегда падала с invalid-command/sourceShiftId.
          sourceShiftId: settings.sourceShiftId,
          truckId: settings.truckId,
          destinationShiftId: settings.destinationShiftId,
          type: settings.type,
          expectedSourceShiftRevision: settings.expectedSourceShiftRevision,
          expectedDestinationShiftRevision: settings.expectedDestinationShiftRevision,
          expectedDetachedCycleRevision: settings.expectedDetachedCycleRevision
        }))
      });
      if (!response.ok) return response;
      response.crossShift = await refreshCrossShift({
        sourceShiftId: settings.sourceShiftId,
        destinationShiftId: settings.destinationShiftId,
        requestKind: 'cross-shift',
        sourceRevision,
        destinationRevision
      });
      return response;
    }

    function submitLineV2(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'type', 'truckId']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/line-operations',
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: Object.assign({}, isRecord(settings.fields) ? settings.fields : {}, compact({
          type: settings.type,
          truckId: settings.truckId,
          expectedShiftRevision: settings.expectedShiftRevision,
          expectedStatusRevision: settings.expectedStatusRevision,
          expectedCycleRevision: settings.expectedCycleRevision,
          expectedTtnRevision: settings.expectedTtnRevision
        }))
      });
    }

    function prepareClose(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/close/prepare',
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: { expectedShiftRevision: settings.expectedShiftRevision }
      });
    }

    // Подтверждение материала — единственный путь создать material marker и
    // закрыть смену с рейсами (§4.6, §7). Тело — ровно §5.5: смена берётся из
    // пути, в теле её нет (иначе хеш операции расходился бы у клиентов).
    // `expectedMaterialMarkerRevision:null` здесь значение CAS («marker ещё не
    // создан»), а не отсутствие поля, поэтому null обязан уйти в тело как есть:
    // иначе фаза подтверждения материала снова стала бы недостижимой из
    // клиента (урок 55).
    function confirmMaterial(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'closeToken', 'materialId']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      const volume = Number(settings.volume);
      if (!Number.isFinite(volume) || volume < 0) return Promise.resolve(failure('invalid-argument', { field: 'volume' }));
      return command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/close/material',
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: {
          closeToken: settings.closeToken,
          materialId: settings.materialId,
          volume,
          expectedShiftRevision: settings.expectedShiftRevision,
          expectedArchiveRevision: settings.expectedArchiveRevision,
          expectedMaterialMarkerRevision: settings.expectedMaterialMarkerRevision
        }
      });
    }

    function finishClose(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'closeToken']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/close/finish',
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: {
          closeToken: settings.closeToken,
          expectedShiftRevision: settings.expectedShiftRevision,
          expectedArchiveRevision: settings.expectedArchiveRevision,
          expectedMaterialMarkerRevision: settings.expectedMaterialMarkerRevision
        }
      });
    }

    async function readRestoredArchive(input) {
      const settings = input || {};
      if (!isNonEmptyString(settings.archiveId)) return failure('invalid-argument', { field: 'archiveId' });
      const params = new URLSearchParams();
      if (Number.isSafeInteger(settings.revision) && settings.revision >= 1) params.set('revision', String(settings.revision));
      if (Number.isSafeInteger(settings.limit) && settings.limit >= 1) params.set('limit', String(settings.limit));
      if (isNonEmptyString(settings.cursor)) params.set('cursor', settings.cursor);
      const query = params.toString();
      const path = '/api/v2/archives/' + segment(settings.archiveId) + '/restored' + (query ? '?' + query : '');
      const response = await call(path, { method: 'GET' });
      if (!response.ok) return response;
      const data = response.data;
      if (!isRecord(data)) return failure('invalid-api-response', { reason: 'invalid-restored-archive' });
      if (data.protocolVersion !== undefined && data.protocolVersion !== PROTOCOL_VERSION) {
        return failure('invalid-api-response', { reason: 'protocol-version-mismatch' });
      }
      if (data.workspaceId !== undefined && data.workspaceId !== workspaceId) {
        return failure('invalid-api-response', { reason: 'workspace-mismatch' });
      }
      if (data.archiveId !== undefined && data.archiveId !== settings.archiveId) {
        return failure('invalid-api-response', { reason: 'archive-mismatch' });
      }
      return { ok: true, data, retried: !!response.retried };
    }

    function submitArchiveV2(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'archiveId', 'restoredContextId', 'type']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/archives/' + segment(settings.archiveId) + '/operations',
        operationId: settings.operationId,
        body: Object.assign({}, isRecord(settings.fields) ? settings.fields : {}, compact({
          restoredContextId: settings.restoredContextId,
          type: settings.type,
          recordId: settings.recordId,
          expectedContextRevision: settings.expectedContextRevision,
          expectedBaseArchiveRevision: settings.expectedBaseArchiveRevision,
          expectedBaseSha256: settings.expectedBaseSha256
        }))
      });
    }

    // Поллинг списка смен и снимков выбранной/фоновых смен с незавершёнными
    // операциями. Каждый снимок идёт через beginRequest/applySnapshot, поэтому
    // ответ, не совпавший с поколением, не публикуется.
    function subscribeShifts(input) {
      const settings = input || {};
      const onList = settings.onList;
      const onSnapshot = settings.onSnapshot;
      const onError = settings.onError;
      if (!store) throw new TypeError('v2-subscription-requires-store');
      if (![onList, onSnapshot, onError].every(handler => typeof handler === 'function')) throw new TypeError('invalid-subscription-options');
      const intervalMs = Number.isSafeInteger(settings.intervalMs) && settings.intervalMs >= 1000 && settings.intervalMs <= 60000
        ? settings.intervalMs
        : DEFAULT_INTERVAL_MS;
      const timers = settings.timers && typeof settings.timers.setTimeout === 'function' ? settings.timers : null;
      const schedule = (callback, delay) => {
        if (timers) return timers.setTimeout(callback, delay);
        if (typeof setTimeout === 'function') return setTimeout(callback, delay);
        return root.setTimeout(callback, delay);
      };
      const cancel = handle => {
        if (timers) timers.clearTimeout(handle);
        else if (typeof clearTimeout === 'function') clearTimeout(handle);
        else root.clearTimeout(handle);
      };

      let closed = false;
      let inFlight = false;
      let timer = null;
      let wakeRequested = false;

      function pollTargets(items) {
        const targets = [];
        const active = store.activeShiftId();
        if (isNonEmptyString(active)) targets.push(active);
        for (const item of items) {
          const shiftId = shiftRowId(item);
          if (!shiftId || targets.indexOf(shiftId) >= 0) continue;
          if (numberOrZero(item.pendingServerReceipts) > 0) targets.push(shiftId);
        }
        return targets;
      }

      async function tick() {
        if (closed || inFlight) return false;
        inFlight = true;
        try {
          const list = await listShifts({});
          if (closed) return false;
          if (!list.ok) {
            onError(list.error);
            return false;
          }
          onList(list);
          for (const shiftId of pollTargets(list.items)) {
            if (closed) return false;
            const result = await readShiftSnapshot({ shiftId, requestKind: 'poll' });
            if (closed) return false;
            if (result.ok) onSnapshot(result);
            else onError(result.error);
          }
          return true;
        } catch (error) {
          if (!closed) onError(normalizeError(error));
          return false;
        } finally {
          inFlight = false;
        }
      }

      function scheduleNext(delay) {
        if (closed) return;
        if (timer !== null) cancel(timer);
        timer = schedule(() => { timer = null; void run(); }, delay);
      }

      async function run() {
        await tick();
        if (closed) return;
        const delay = wakeRequested ? 0 : intervalMs;
        wakeRequested = false;
        scheduleNext(delay);
      }

      function wake() {
        if (closed) return;
        if (inFlight) {
          wakeRequested = true;
          return;
        }
        scheduleNext(0);
      }

      function close() {
        closed = true;
        if (timer !== null) cancel(timer);
        timer = null;
      }

      scheduleNext(0);
      return { close, tick, wake };
    }

    return Object.freeze({
      listShifts,
      readShiftSnapshot,
      createShift,
      changeShiftObject,
      addMember,
      removeMember,
      addTruck,
      removeTruck,
      forceTransferTruck,
      completeDetachedTrip,
      submitLineV2,
      prepareClose,
      confirmMaterial,
      finishClose,
      readRestoredArchive,
      submitArchiveV2,
      subscribeShifts,
      refreshCrossShift
    });
  }

  const api = { createV2Transport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestV2Transport = api;
})(typeof window !== 'undefined' ? window : globalThis);
// Клиентский офлайн-журнал команд v2 (design §9).
//
// Каждая persisted-команда — неизменяемый конверт: uid, workspaceId, shiftId,
// protocolVersion:2, operationId, commandType, каноническое body, исходные
// expected revisions, createdAt и commandHash. При replay ни одно из этих
// полей не подменяется текущим аккаунтом или выбранной сменой: журнал не знает
// про «текущую» смену вообще, он читает ровно тот scope, который записан в
// ключе хранения.
//
// Storage разделён по uid/workspaceId/shiftId/protocolVersion, поэтому две
// смены одного uid — две независимые очереди, а очередь чужого uid не
// показывается и не отправляется, пока не вернётся тот же uid (seal/unseal)
// либо пользователь явно не удалит её (purge). Проекция и dead-letter тоже
// scoped: карточка смены видит только свою очередь, общий бейдж — сумму по uid.
//
// Файл — classic script (IIFE → globalThis), без DOM и сети: storage
// инжектируется (в браузере — localStorage, в тестах — Map-совместимая
// заглушка). Формат хранения — обычный JSON, поэтому обновление PWA и выход из
// аккаунта очередь не стирают.
(function (root) {
  'use strict';

  const PROTOCOL_VERSION = 2;
  const KEY_PREFIX = 'samosval:offline-v2:';
  // Эти команды меняют сразу две смены: их cross-shift CAS нельзя подтвердить
  // из очереди, поэтому сервер отвечает на них `409 online-required`, а клиент
  // обязан отказать ещё до записи (design §9, урок 55).
  const ONLINE_ONLY_COMMANDS = [
    'force-transfer', 'force_transfer',
    'detached-complete', 'detached-trip-complete', 'complete-detached-trip'
  ];
  // Отказы, которые не станут успешными от повтора: очередь не «переигрывает»
  // их молча, запись уходит в dead-letter этой смены.
  const PERMANENT_REJECTIONS = ['shift-closed', 'not-shift-member', 'protocol-upgrade-required', 'online-required'];
  // Разрешимые конфликты: код и безопасные details остаются пользователю.
  const CONFLICT_REJECTIONS = ['shift-changed', 'revision-conflict', 'truck-not-on-shift', 'archive-changed', 'operation-id-reused', 'operation-hash-conflict'];
  // Только эти поля серверных details можно хранить и показывать: никаких
  // телефонов, почты, uid и вложенных объектов. Список совпадает с серверным
  // `DETAIL_KEYS` (server/src/v2-errors.mjs) плюс поля клиента: иначе журнал
  // терял половину `actual*` и не мог объяснить конфликт ревизий.
  const SAFE_DETAIL_KEYS = [
    // серверный закрытый список (v2-errors.mjs)
    'field', 'reason', 'state', 'limit', 'cursor',
    'operationId', 'protocolVersion',
    'shiftId', 'objectId', 'workDate', 'shiftType', 'truckId',
    'sourceShiftId', 'destinationShiftId', 'cycleId', 'stage',
    'expectedRevision', 'actualRevision',
    'expectedShiftRevision', 'actualShiftRevision',
    'expectedMembershipRevision', 'actualMembershipRevision',
    'expectedStatusRevision', 'actualStatusRevision',
    'expectedCycleRevision', 'actualCycleRevision',
    'expectedTtnRevision', 'actualTtnRevision',
    'expectedDetachedCycleRevision', 'actualDetachedCycleRevision',
    'expectedArchiveRevision', 'actualArchiveRevision',
    'expectedMaterialMarkerRevision', 'actualMaterialMarkerRevision',
    'retryAfterSeconds', 'replayed',
    // поля, которые клиент формирует сам
    'phase', 'type', 'conflict', 'objectName', 'archiveId', 'archiveRevision',
    'recordId', 'restoredContextId', 'contextRevision',
    'currentRevision', 'shiftRevision', 'status'
  ];
  const MAX_DETAIL_LENGTH = 200;
  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function copy(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function fail(code, details) {
    return { ok: false, error: { code, details: details || {} } };
  }

  function safeDetails(input) {
    const out = {};
    if (!isRecord(input)) return out;
    for (const key of SAFE_DETAIL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      const value = input[key];
      if (typeof value === 'string') out[key] = value.slice(0, MAX_DETAIL_LENGTH);
      else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
      else if (typeof value === 'boolean' || value === null) out[key] = value;
    }
    return out;
  }

  function isOnlineOnlyCommand(commandType) {
    return ONLINE_ONLY_COMMANDS.indexOf(String(commandType || '')) >= 0;
  }

  // RFC 8785-совместимый канонический JSON: ключи отсортированы по UTF-16,
  // без пробелов, без undefined (в объекте такой ключ просто отсутствует).
  // Так одинаковый конверт даёт одинаковый хеш, а изменённое semantic-поле —
  // другой, независимо от порядка ключей у вызывающего.
  function canonicalJson(value) {
    return serialize(value, new Set(), '$');
  }

  function serialize(value, stack, path) {
    if (value === null) return 'null';
    switch (typeof value) {
      case 'boolean': return value ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects a non-finite number at ' + path);
        if (Object.is(value, -0)) return '0';
        return JSON.stringify(value);
      case 'string': return JSON.stringify(value);
      case 'undefined': throw new TypeError('canonical JSON rejects undefined at ' + path);
      case 'object': break;
      default: throw new TypeError('canonical JSON rejects ' + typeof value + ' at ' + path);
    }
    if (stack.has(value)) throw new TypeError('canonical JSON rejects a cyclic reference at ' + path);
    if (Array.isArray(value)) {
      stack.add(value);
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError('canonical JSON rejects a sparse array at ' + path + '[' + index + ']');
        items.push(serialize(value[index], stack, path + '[' + index + ']'));
      }
      stack.delete(value);
      return '[' + items.join(',') + ']';
    }
    stack.add(value);
    const members = [];
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      members.push(JSON.stringify(key) + ':' + serialize(value[key], stack, path + '.' + key));
    }
    stack.delete(value);
    return '{' + members.join(',') + '}';
  }

  // UTF-8 без TextEncoder: модуль не должен зависеть от окружения.
  function utf8Bytes(text) {
    const bytes = [];
    for (let index = 0; index < text.length; index += 1) {
      let code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          index += 1;
        }
      }
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    return bytes;
  }

  function rotr(value, shift) {
    return (value >>> shift) | (value << (32 - shift));
  }

  function sha256Hex(text) {
    const bytes = utf8Bytes(String(text));
    const bitLength = bytes.length * 8;
    const total = Math.ceil((bytes.length + 9) / 64) * 64;
    const buffer = new Uint8Array(total);
    buffer.set(bytes);
    buffer[bytes.length] = 0x80;
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    buffer[total - 8] = (high >>> 24) & 0xff;
    buffer[total - 7] = (high >>> 16) & 0xff;
    buffer[total - 6] = (high >>> 8) & 0xff;
    buffer[total - 5] = high & 0xff;
    buffer[total - 4] = (low >>> 24) & 0xff;
    buffer[total - 3] = (low >>> 16) & 0xff;
    buffer[total - 2] = (low >>> 8) & 0xff;
    buffer[total - 1] = low & 0xff;

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    for (let offset = 0; offset < total; offset += 64) {
      for (let index = 0; index < 16; index += 1) {
        w[index] = (buffer[offset + index * 4] << 24) | (buffer[offset + index * 4 + 1] << 16)
          | (buffer[offset + index * 4 + 2] << 8) | buffer[offset + index * 4 + 3];
      }
      for (let index = 16; index < 64; index += 1) {
        const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3);
        const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10);
        w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let index = 0; index < 64; index += 1) {
        const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const choose = (e & f) ^ (~e & g);
        const temp1 = (h + sum1 + choose + SHA256_K[index] + w[index]) >>> 0;
        const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (sum0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map(value => value.toString(16).padStart(8, '0'))
      .join('');
  }

  // Семантические поля конверта: всё, что определяет, какая именно команда
  // была сохранена. Хеш — локальная идентичность записи (сервер считает свой
  // receipt-хеш по семи полям провода), поэтому createdAt тоже входит.
  const HASH_FIELDS = [
    'uid', 'workspaceId', 'shiftId', 'protocolVersion', 'operationId',
    'commandType', 'body', 'expectedRevisions', 'createdAt'
  ];

  function commandHash(command, scope) {
    const parts = {};
    for (const field of HASH_FIELDS) {
      const value = field === 'uid' || field === 'workspaceId'
        ? (scope ? scope[field] : command[field])
        : command[field];
      if (value !== undefined) parts[field] = value;
    }
    return sha256Hex(canonicalJson(parts));
  }

  // Классификация ответа сервера на replay (§9): что делать с записью.
  // permanent → dead-letter этой смены; conflict → явный конфликт с кодом и
  // безопасными details; иначе — обычный отказ, повтор разрешён.
  function classifyReplayFailure(input) {
    const settings = input || {};
    const code = isNonEmptyString(settings.code) ? settings.code : 'replay-failed';
    const status = Number(settings.status);
    const permanent = PERMANENT_REJECTIONS.indexOf(code) >= 0 || status === 426;
    return {
      code,
      status: Number.isFinite(status) ? status : 0,
      permanent,
      deadLetter: permanent,
      conflict: CONFLICT_REJECTIONS.indexOf(code) >= 0,
      details: safeDetails(settings.details)
    };
  }

  // Тело команды: ровно те поля, которые уходят в line-операцию. Список
  // фиксирован, поэтому конверт не зависит от того, что ещё лежит в
  // runtime-записи очереди (актёр, проекция, beforeStatus).
  const BODY_FIELDS = [
    'truckId', 'type', 'wantArrived', 'collect', 'cycleMinutes',
    'arrivalTimestamp', 'lastLoadTimestamp', 'volume', 'isGAI', 'truckName'
  ];
  const BODY_NUMBERS = ['cycleMinutes', 'arrivalTimestamp', 'lastLoadTimestamp', 'volume'];
  const BODY_BOOLEANS = ['wantArrived', 'collect', 'isGAI'];

  function envelopeBody(op) {
    const body = {};
    for (const field of BODY_FIELDS) {
      const value = op[field];
      if (value === undefined || value === null) continue;
      if (BODY_NUMBERS.indexOf(field) >= 0) {
        const number = Number(value);
        if (!Number.isFinite(number)) return null;
        body[field] = number;
      } else if (BODY_BOOLEANS.indexOf(field) >= 0) {
        body[field] = value === true;
      } else if (typeof value === 'string') {
        body[field] = value;
      } else {
        return null;
      }
    }
    if (!isNonEmptyString(body.truckId) || !isNonEmptyString(body.type)) return null;
    return body;
  }

  function envelopeRevisions(op) {
    const revisions = {};
    const add = (key, value) => {
      if (value === undefined || value === null || value === '') return;
      const number = Number(value);
      if (Number.isSafeInteger(number) && number >= 0) revisions[key] = number;
    };
    add('shift', op.expectedShiftRevision);
    add('status', op.expectedStatusRevision);
    add('cycle', op.expectedRevision !== undefined ? op.expectedRevision : op.expectedCycleRevision);
    add('ttn', op.expectedTtnRevision);
    return revisions;
  }

  // Runtime-запись очереди → канонический конверт §9. Чистая функция: ничего
  // не читает и не пишет, поэтому её результат можно сохранить и позже
  // побайтово сравнить с тем, что уйдёт на сервер. scope обязателен: uid и
  // workspaceId записи не берутся из «текущего» аккаунта.
  function buildCommandEnvelope(op, scope) {
    if (!isRecord(op)) return fail('invalid-command', { field: 'command' });
    const owner = isRecord(scope) ? scope : {};
    if (!isNonEmptyString(owner.uid) || !isNonEmptyString(owner.workspaceId)) {
      return fail('invalid-command', { field: 'scope' });
    }
    if (!isNonEmptyString(op.id)) return fail('invalid-command', { field: 'operationId' });
    if (!isNonEmptyString(op.shiftId)) return fail('invalid-command', { field: 'shiftId' });
    if (!isNonEmptyString(op.type)) return fail('invalid-command', { field: 'commandType' });
    const createdAt = Number(op.createdAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0) return fail('invalid-command', { field: 'createdAt' });
    const body = envelopeBody(op);
    if (!body) return fail('invalid-command', { field: 'body' });
    const envelope = {
      uid: owner.uid,
      workspaceId: owner.workspaceId,
      shiftId: op.shiftId,
      protocolVersion: PROTOCOL_VERSION,
      operationId: op.id,
      commandType: op.type,
      body,
      expectedRevisions: envelopeRevisions(op),
      createdAt
    };
    let hash;
    try {
      hash = commandHash(envelope, owner);
    } catch (_) {
      return fail('invalid-command', { field: 'body' });
    }
    envelope.commandHash = hash;
    return { ok: true, envelope, commandHash: hash };
  }

  function validateCommand(command) {
    if (!isRecord(command)) return 'command';
    if (!isNonEmptyString(command.shiftId)) return 'shiftId';
    if (!isNonEmptyString(command.operationId)) return 'operationId';
    if (!isNonEmptyString(command.commandType)) return 'commandType';
    if (command.protocolVersion !== PROTOCOL_VERSION) return 'protocolVersion';
    if (!isRecord(command.body)) return 'body';
    if (command.expectedRevisions !== undefined && !isRecord(command.expectedRevisions)) return 'expectedRevisions';
    if (!Number.isFinite(Number(command.createdAt)) || Number(command.createdAt) <= 0) return 'createdAt';
    return null;
  }

  function createOfflineJournalV2(options) {
    const config = options || {};
    const uid = config.uid;
    const workspaceId = config.workspaceId;
    const storage = config.storage;
    if (!isNonEmptyString(uid)) throw new TypeError('offline-v2-requires-uid');
    if (!isNonEmptyString(workspaceId)) throw new TypeError('offline-v2-requires-workspace');
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      throw new TypeError('offline-v2-requires-storage');
    }

    const scope = { uid, workspaceId };
    const scopePrefix = KEY_PREFIX + 'v' + PROTOCOL_VERSION + ':' + encodeURIComponent(uid) + '/' + encodeURIComponent(workspaceId) + '/';
    const indexKey = scopePrefix + 'index';
    let sealed = false;

    function queueKey(shiftId) {
      return scopePrefix + encodeURIComponent(shiftId) + '/queue';
    }

    function readIndex() {
      try {
        const parsed = JSON.parse(storage.getItem(indexKey) || '[]');
        return Array.isArray(parsed) ? parsed.filter(isNonEmptyString) : [];
      } catch (_) {
        return [];
      }
    }

    function writeIndex(shiftIds) {
      const list = shiftIds.filter(isNonEmptyString);
      if (!list.length) {
        storage.removeItem(indexKey);
        return;
      }
      storage.setItem(indexKey, JSON.stringify(list));
    }

    function indexAdd(shiftId) {
      const list = readIndex();
      if (list.indexOf(shiftId) >= 0) return;
      list.push(shiftId);
      list.sort();
      writeIndex(list);
    }

    function indexRemove(shiftId) {
      writeIndex(readIndex().filter(item => item !== shiftId));
    }

    // Запись чужого scope не читается даже если ключ подсунули: сверяем uid и
    // workspaceId каждой строки, а не только имя ключа.
    function readRecords(shiftId) {
      if (!isNonEmptyString(shiftId)) return [];
      let parsed;
      try {
        parsed = JSON.parse(storage.getItem(queueKey(shiftId)) || '[]');
      } catch (_) {
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(row => isRecord(row)
        && row.uid === uid
        && row.workspaceId === workspaceId
        && row.shiftId === shiftId
        && row.protocolVersion === PROTOCOL_VERSION);
    }

    function writeRecords(shiftId, records) {
      if (!records.length) {
        storage.removeItem(queueKey(shiftId));
        indexRemove(shiftId);
        return;
      }
      storage.setItem(queueKey(shiftId), JSON.stringify(records));
      indexAdd(shiftId);
    }

    function shiftIds() {
      return readIndex().filter(shiftId => readRecords(shiftId).length > 0).sort();
    }

    function findRecord(operationId) {
      if (!isNonEmptyString(operationId)) return null;
      for (const shiftId of shiftIds()) {
        const records = readRecords(shiftId);
        const found = records.find(row => row.operationId === operationId);
        if (found) return { shiftId, records, record: found };
      }
      return null;
    }

    function enqueue(command) {
      if (sealed) return fail('journal-sealed');
      const problem = validateCommand(command);
      if (problem) return fail('invalid-command', { field: problem });
      if (isOnlineOnlyCommand(command.commandType)) {
        return fail('online-only-command', { commandType: command.commandType });
      }
      let hash;
      try {
        hash = commandHash(command, scope);
      } catch (_) {
        return fail('invalid-command', { field: 'body' });
      }
      const shiftId = command.shiftId;
      const records = readRecords(shiftId);
      const existing = records.find(row => row.operationId === command.operationId);
      if (existing) {
        // Тот же operationId с тем же конвертом — идемпотентный повтор;
        // с другим — конфликт, а не вторая запись в очередь.
        if (existing.commandHash === hash) return { ok: true, duplicate: true, record: copy(existing) };
        return fail('operation-hash-conflict', { operationId: command.operationId });
      }
      const record = {
        uid,
        workspaceId,
        shiftId,
        protocolVersion: PROTOCOL_VERSION,
        operationId: command.operationId,
        commandType: command.commandType,
        body: copy(command.body),
        expectedRevisions: copy(command.expectedRevisions) || {},
        createdAt: Number(command.createdAt),
        commandHash: hash,
        status: 'pending'
      };
      records.push(record);
      writeRecords(shiftId, records);
      return { ok: true, duplicate: false, record: copy(record) };
    }

    function readQueue(shiftId) {
      if (sealed) return [];
      return copy(readRecords(shiftId));
    }

    // Scoped-группы: очередь одной смены никогда не смешивается с другой и с
    // чужим uid/workspace.
    function readAll() {
      if (sealed) return [];
      return shiftIds().map(shiftId => ({ shiftId, commands: copy(readRecords(shiftId)) }));
    }

    function pendingCount(shiftId) {
      if (sealed) return 0;
      const count = records => records.filter(row => row.status === 'pending').length;
      if (isNonEmptyString(shiftId)) return count(readRecords(shiftId));
      return shiftIds().reduce((sum, id) => sum + count(readRecords(id)), 0);
    }

    function updateRecord(operationId, update) {
      // Результат уже отправленной команды записывается даже у запечатанного
      // журнала: сервер её применил, и потерять авторитетный receipt нельзя.
      // Запрет запечатывания касается отправки и показа, а не записи ответа.
      const found = findRecord(operationId);
      if (!found) return fail('operation-not-found', { operationId });
      const records = found.records.map(row => (row.operationId === operationId ? update(row) : row));
      writeRecords(found.shiftId, records);
      return { ok: true, shiftId: found.shiftId, record: copy(records.find(row => row.operationId === operationId)) };
    }

    function markSent(operationId, receipt) {
      return updateRecord(operationId, row => Object.assign({}, row, {
        status: 'sent',
        receipt: copy(receipt) || null,
        resolvedAt: Date.now()
      }));
    }

    function markRejected(operationId, code, details) {
      const verdict = classifyReplayFailure({ code, details, status: details && details.status });
      const result = updateRecord(operationId, row => Object.assign({}, row, {
        status: 'rejected',
        rejection: {
          code: verdict.code,
          permanent: verdict.permanent,
          conflict: verdict.conflict,
          details: verdict.details
        },
        deadLetter: verdict.deadLetter,
        resolvedAt: Date.now()
      }));
      if (!result.ok) return result;
      return Object.assign(result, {
        deadLetter: verdict.deadLetter,
        permanent: verdict.permanent,
        conflict: verdict.conflict,
        code: verdict.code
      });
    }

    function deadLetter(shiftId) {
      if (sealed) return [];
      const rows = isNonEmptyString(shiftId)
        ? readRecords(shiftId)
        : shiftIds().reduce((all, id) => all.concat(readRecords(id)), []);
      return copy(rows.filter(row => row.status === 'rejected' && row.deadLetter === true));
    }

    // Решение о replay: отправлять, вернуть сохранённый receipt или явно
    // отказать. Журнал ничего не подменяет и не создаёт второй запрос.
    function resolveReplay(operationId, hash) {
      if (sealed) return { action: 'sealed' };
      const found = findRecord(operationId);
      if (!found) return { action: 'not-found' };
      const row = found.record;
      if (isNonEmptyString(hash) && row.commandHash !== hash) {
        return { action: 'conflict', code: 'operation-hash-conflict', record: copy(row) };
      }
      if (row.status === 'sent') return { action: 'return-receipt', receipt: copy(row.receipt) };
      if (row.status === 'rejected') {
        return row.deadLetter === true
          ? { action: 'dead-letter', rejection: copy(row.rejection) }
          : { action: 'rejected', rejection: copy(row.rejection) };
      }
      return { action: 'send', command: copy(row) };
    }

    function seal() {
      sealed = true;
      return true;
    }

    function unseal() {
      sealed = false;
      return true;
    }

    function purge(shiftId) {
      if (!isNonEmptyString(shiftId)) return false;
      const existed = readRecords(shiftId).length > 0;
      writeRecords(shiftId, []);
      return existed;
    }

    function purgeAll() {
      const ids = shiftIds();
      ids.forEach(shiftId => writeRecords(shiftId, []));
      return ids.length;
    }

    return Object.freeze({
      enqueue,
      readQueue,
      readAll,
      pendingCount,
      markSent,
      markRejected,
      deadLetter,
      resolveReplay,
      commandHash: command => commandHash(command, scope),
      seal,
      unseal,
      sealed: () => sealed,
      purge,
      purgeAll,
      scope: () => ({ uid, workspaceId })
    });
  }

  const api = {
    PROTOCOL_VERSION,
    ONLINE_ONLY_COMMANDS,
    createOfflineJournalV2,
    buildCommandEnvelope,
    commandHash,
    canonicalJson,
    isOnlineOnlyCommand,
    classifyReplayFailure
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestOfflineV2 = api;
})(typeof window !== 'undefined' ? window : globalThis);
// Полоса открытых смен вкладки «Линия» (design §10.1).
//
// Полоса — только переключатель: она показывает видимые пользователю смены в
// состояниях `active`/`closing` и атомарно меняет выбранный контекст. Ни одной
// команды транспорта и ни одной записи в офлайн-очередь вкладка не запускает —
// действия живут в карточках самосвалов выбранной смены.
//
// Переключение выполняется одной клиентской транзакцией: сначала store меняет
// `activeShiftId`, затем старая проекция полностью стирается и только после
// этого пишется проекция новой смены. Кадра со старыми данными под новой
// шапкой не существует, потому что очистка и проекция идут подряд, без
// промежуточной отрисовки.
//
// Файл — classic script (IIFE → globalThis), без сети. DOM инжектируется:
// модуль пользуется только createElement/appendChild/textContent/dataset/
// setAttribute/addEventListener/remove/scrollIntoView и mount.hidden.
(function (root) {
  'use strict';

  // В полосу попадают только открытые смены. `closed` и `historical` — история,
  // а восстановленный архив открывается отдельным режимом из «Архива».
  const VISIBLE_STATES = { active: true, closing: true };
  const DEFAULT_MIN_SHIFTS = 2;
  const SHIFT_TYPE_LABELS = { day: 'День', night: 'Ночь' };

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function shiftIdOf(row) {
    if (!isRecord(row)) return '';
    if (isNonEmptyString(row.shiftId)) return row.shiftId;
    return isNonEmptyString(row.id) ? row.id : '';
  }

  // Store нормализует состояние, но полоса не доверяет источнику: строка без
  // явного состояния выводится по тем же правилам, что в 40-shift-contexts.
  function stateOf(row) {
    if (isNonEmptyString(row.state)) return row.state;
    if (row.closing === true) return 'closing';
    if (row.isActive === false) return 'closed';
    return 'active';
  }

  function isRestoredArchive(row) {
    return (isRecord(row.restoredContext) && isNonEmptyString(row.restoredContext.archiveId))
      || row.restored === true;
  }

  function shiftTypeOf(row) {
    const type = row.shiftType || row.type || row.workShift;
    return isNonEmptyString(type) ? type : '';
  }

  function labelOf(row) {
    const name = isNonEmptyString(row.objectName) && row.objectName.trim()
      ? row.objectName.trim()
      : (isNonEmptyString(row.objectId) ? row.objectId : 'Смена');
    const typeLabel = SHIFT_TYPE_LABELS[shiftTypeOf(row)] || shiftTypeOf(row);
    return typeLabel ? name + ' · ' + typeLabel : name;
  }

  function createShiftSelector(options) {
    const config = options || {};
    const store = config.store;
    const doc = config.doc || config.document || root.document;
    const mount = config.mount;
    const legacyState = config.legacyState;
    const onSwitch = typeof config.onSwitch === 'function' ? config.onSwitch : function () {};
    const minShifts = Number.isSafeInteger(config.minShifts) && config.minShifts >= 0
      ? config.minShifts
      : DEFAULT_MIN_SHIFTS;
    if (!store || typeof store.visibleShifts !== 'function') throw new TypeError('shift-selector-requires-store');
    if (!doc || typeof doc.createElement !== 'function') throw new TypeError('shift-selector-requires-document');
    if (!mount) throw new TypeError('shift-selector-requires-mount');
    if (!isRecord(legacyState)) throw new TypeError('legacy-state-required');

    let entries = [];
    let selectedId = null;

    function offlineNow() {
      if (typeof config.offline === 'function') return config.offline() === true;
      return config.offline === true;
    }

    // Только видимые открытые смены: полоса фильтрует сама и не доверяет
    // источнику, даже если тот отдал закрытую, историческую или архивную строку.
    function visibleRows() {
      let raw = [];
      try {
        raw = store.visibleShifts();
      } catch (_) {
        raw = [];
      }
      const list = Array.isArray(raw) ? raw : [];
      const out = [];
      const seen = Object.create(null);
      for (const row of list) {
        if (!isRecord(row)) continue;
        const shiftId = shiftIdOf(row);
        if (!shiftId || seen[shiftId]) continue;
        if (!VISIBLE_STATES[stateOf(row)]) continue;
        if (isRestoredArchive(row)) continue;
        seen[shiftId] = true;
        out.push(Object.assign({}, row, { shiftId }));
      }
      return out;
    }

    function chooseSelection(rows) {
      const active = typeof store.activeShiftId === 'function' ? store.activeShiftId() : null;
      if (isNonEmptyString(active) && rows.some(row => row.shiftId === active)) return active;
      return rows.length ? rows[0].shiftId : null;
    }

    function badgeState(row) {
      let context = null;
      try {
        context = typeof store.context === 'function' ? store.context(row.shiftId) : null;
      } catch (_) {
        context = null;
      }
      const badge = context && isRecord(context.badge) ? context.badge : {};
      const pending = Number(badge.pending);
      return {
        closing: stateOf(row) === 'closing' || badge.closing === true,
        conflict: badge.conflict === true,
        offline: badge.offline === true || offlineNow(),
        pending: Number.isFinite(pending) && pending > 0 ? Math.floor(pending) : 0
      };
    }

    function badgeList(state) {
      const list = [];
      if (state.closing) list.push(['closing', 'закрывается']);
      if (state.conflict) list.push(['conflict', 'конфликт']);
      if (state.offline) list.push(['offline', 'офлайн']);
      if (state.pending > 0) list.push(['pending', String(state.pending)]);
      return list;
    }

    function syncBadges(entry) {
      const state = badgeState(entry.row);
      entry.badgesEl.textContent = '';
      for (const [kind, text] of badgeList(state)) {
        const badge = doc.createElement('span');
        badge.className = 'shift-tab-badge shift-tab-' + kind;
        badge.textContent = text;
        entry.badgesEl.appendChild(badge);
      }
      entry.tab.className = 'shift-tab'
        + (entry.shiftId === selectedId ? ' is-active' : '')
        + (state.closing ? ' is-closing' : '')
        + (state.conflict ? ' is-conflict' : '');
    }

    function syncLabel(entry) {
      entry.labelEl.textContent = (entry.shiftId === selectedId ? '✓ ' : '') + labelOf(entry.row);
    }

    function syncVisuals() {
      for (const entry of entries) {
        entry.tab.setAttribute('aria-selected', entry.shiftId === selectedId ? 'true' : 'false');
        syncLabel(entry);
        syncBadges(entry);
      }
    }

    // Выбранная вкладка доводится в видимую область. Вертикальная прокрутка
    // центра не трогается: block:'nearest' не прокручивает предков, а
    // window.scrollTo и mount.scrollTop здесь не используются вообще.
    function revealSelected() {
      const entry = entries.find(item => item.shiftId === selectedId);
      if (!entry || typeof entry.tab.scrollIntoView !== 'function') return;
      entry.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function render() {
      const rows = visibleRows();
      selectedId = chooseSelection(rows);
      mount.textContent = '';
      entries = [];
      if (rows.length < minShifts) {
        mount.hidden = true;
        return;
      }
      mount.hidden = false;
      for (const row of rows) {
        const tab = doc.createElement('button');
        tab.className = 'shift-tab';
        tab.setAttribute('type', 'button');
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', 'false');
        tab.dataset.shiftId = row.shiftId;
        const labelEl = doc.createElement('span');
        labelEl.className = 'shift-tab-label';
        const badgesEl = doc.createElement('span');
        badgesEl.className = 'shift-tab-badges';
        tab.appendChild(labelEl);
        tab.appendChild(badgesEl);
        tab.addEventListener('click', function () {
          if (typeof config.select === 'function') config.select(row.shiftId);
          else switchTo(row.shiftId);
        });
        mount.appendChild(tab);
        entries.push({ shiftId: row.shiftId, row, tab, labelEl, badgesEl });
      }
      syncVisuals();
      revealSelected();
    }

    // Проекция старого кода стирается целиком: под новой шапкой не может
    // остаться ни одного рейса и ни одного статуса прежней смены.
    function clearProjection() {
      legacyState.shift = null;
      legacyState.logs = [];
      legacyState.truckStatus = {};
      legacyState.status = {};
    }

    function switchTo(shiftId) {
      if (!isNonEmptyString(shiftId)) return false;
      const rows = visibleRows();
      if (!rows.some(row => row.shiftId === shiftId)) return false;
      if (store.selectShift(shiftId) === false) return false;
      clearProjection();
      store.projectActiveContextToLegacyState(legacyState);
      selectedId = shiftId;
      render();
      onSwitch(shiftId);
      return true;
    }

    function refreshBadges() {
      for (const entry of entries) syncBadges(entry);
    }

    function activeShiftId() {
      const rows = visibleRows();
      if (isNonEmptyString(selectedId) && rows.some(row => row.shiftId === selectedId)) return selectedId;
      return chooseSelection(rows);
    }

    function destroy() {
      if (mount) mount.textContent = '';
      entries = [];
      selectedId = null;
      mount.hidden = true;
    }

    return { render, switchTo, refreshBadges, activeShiftId, destroy };
  }

  const api = { createShiftSelector };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestShiftSelector = api;
})(typeof window !== 'undefined' ? window : globalThis);
// Управление сменой: создание, участники, закрытие (design §5.2, §5.3, §5.5,
// §6, §7).
//
// Модуль без DOM и без сети: транспорт и store инжектируются, поэтому решение
// «команда уходит или нет» проверяется без браузера. Права здесь — UI-гейт
// поверх серверного ACL, а не замена ему: сервер повторно проверяет всё сам.
//
// CAS берётся только из фактического состояния контекста смены. Если ревизия
// неизвестна, команда не уходит вовсе: тело с `undefined` вместо ревизии
// превратилось бы в «без CAS» и позволило бы затереть чужое изменение.
//
// Закрытие — три фазы строго по факту receipt: prepare → material (только если
// в смене есть рейсы) → finish. Значения ожиданий не выдумываются, ошибка
// любой фазы останавливает цепочку, а конфликт не переигрывается молча:
// повтор с новой ревизией сделал бы вид, что чужого изменения не было.
(function (root) {
  'use strict';

  const WORK_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const OPERATION_MAX = 160;
  const VISIBLE_STATES = { active: true, closing: true };
  const SHIFT_TYPES = { day: true, night: true };
  const RIGHTS = {
    create: 'start_shift',
    members: 'manage_shift_members',
    close: 'close_shift',
    forceTransfer: 'force_transfer_truck'
  };
  // Стабильные коды v2 → человеческий текст. Неизвестный код не роняет
  // describe: пользователь получает общий текст, а не пустой экран.
  const MESSAGES = {
    'shift-closed': 'Смена уже закрыта. Откройте актуальную смену — действие в закрытую не записывается.',
    'not-shift-member': 'Вы больше не участник этой смены. Попросите старшего прораба назначить вас заново.',
    'revision-conflict': 'Данные смены изменил другой пользователь. Обновите экран и повторите действие.',
    'shift-changed': 'Смена изменилась, пока шло действие. Обновите экран и повторите действие.',
    'truck-not-on-shift': 'Самосвал уже не на этой смене. Обновите экран и повторите действие.',
    'pending-operations': 'По смене ещё ожидают подтверждения сервера незавершённые операции. Дождитесь их и повторите закрытие.',
    'detached-trip-open': 'В смене есть незавершённый рейс, переведённый в другую смену. Сначала завершите его, потом закрывайте смену.',
    'duplicate-shift': 'Такая смена уже открыта: этот объект, дата и день/ночь уже есть в полосе смен.',
    'online-required': 'Для этой команды нужна сеть: перевод самосвала и завершение переведённого рейса офлайн не выполняются.',
    'protocol-upgrade-required': 'Сервер требует новую версию приложения. Обновите страницу и повторите действие.',
    'forbidden': 'Недостаточно прав для этого действия. Обратитесь к администратору.',
    'invalid-command': 'Команда заполнена некорректно и не отправлена. Проверьте значения полей.',
    'invalid-shift-type': 'Тип смены должен быть «День» или «Ночь».',
    'invalid-work-date': 'Дата смены должна быть в формате ГГГГ-ММ-ДД и существовать в календаре.',
    'invalid-object-id': 'Выберите объект смены.',
    'invalid-shift-id': 'Не выбрана смена.',
    'invalid-uid': 'Не выбран участник смены.',
    'invalid-operation-id': 'Не удалось подготовить операцию. Повторите действие.',
    'revision-unknown': 'Данные смены ещё не загружены с сервера. Обновите экран и повторите действие.',
    'material-required': 'В смене есть рейсы: укажите материал и объём, чтобы подтвердить материал при закрытии.',
    'invalid-api-response': 'Сервер ответил неожиданно. Обновите экран; если повторится — сообщите администратору.',
    'transport-failed': 'Не удалось связаться с сервером. Проверьте связь и повторите действие.'
  };
  const UNKNOWN_MESSAGE = 'Не удалось выполнить действие. Обновите экран и повторите; если ошибка повторяется — сообщите администратору.';

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function revisionValue(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }

  function validWorkDate(value) {
    if (typeof value !== 'string' || !WORK_DATE.test(value)) return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    if (month < 1 || month > 12 || day < 1) return false;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day <= lastDay;
  }

  function shiftTypeOf(row) {
    const type = row && (row.shiftType || row.type || row.workShift);
    return isNonEmptyString(type) ? type : '';
  }

  function stateOf(row) {
    if (isNonEmptyString(row.state)) return row.state;
    if (row.closing === true) return 'closing';
    if (row.isActive === false) return 'closed';
    return 'active';
  }

  function fail(code, details) {
    return { ok: false, code, details: details || {} };
  }

  function createShiftManagement(options) {
    const config = options || {};
    const transport = config.transport;
    const store = config.store;
    const rights = isRecord(config.rights) ? config.rights : {};
    const now = typeof config.now === 'function' ? config.now : function () { return Date.now(); };
    if (!transport) throw new TypeError('shift-management-requires-transport');
    if (!store || typeof store.visibleShifts !== 'function') throw new TypeError('shift-management-requires-store');

    let sequence = 0;
    function generatedOperationId() {
      sequence += 1;
      return 'op_' + Number(now()).toString(36) + '_' + sequence.toString(36)
        + '_' + Math.random().toString(36).slice(2, 8);
    }

    function newOperationId() {
      const generated = typeof config.newOperationId === 'function' ? config.newOperationId() : generatedOperationId();
      return isNonEmptyString(generated) ? generated : '';
    }

    function operationFor(value) {
      if (value === undefined || value === null) return newOperationId();
      return isNonEmptyString(value) ? value : '';
    }

    // Производный id фазы: сервер принимает только [A-Za-z0-9_-]{1,160}.
    function phaseId(base, phase) {
      const suffix = '-' + phase;
      const room = OPERATION_MAX - suffix.length;
      return (base.length > room ? base.slice(0, room) : base) + suffix;
    }

    function hasRight(name) {
      return rights[name] === true;
    }

    function readContext(shiftId) {
      try {
        return typeof store.context === 'function' ? store.context(shiftId) : null;
      } catch (_) {
        return null;
      }
    }

    function shiftRevisionOf(context) {
      if (!isRecord(context) || !isRecord(context.revisions)) return null;
      return revisionValue(context.revisions.shift);
    }

    function membersOf(context) {
      const members = context && context.snapshot && context.snapshot.members;
      return Array.isArray(members) ? members : [];
    }

    function memberOf(context, uid) {
      return membersOf(context).find(member => isRecord(member) && member.uid === uid) || null;
    }

    function visibleRows() {
      let raw = [];
      try {
        raw = store.visibleShifts();
      } catch (_) {
        raw = [];
      }
      return (Array.isArray(raw) ? raw : []).filter(row => isRecord(row) && VISIBLE_STATES[stateOf(row)]);
    }

    // Точный дубликат активной/закрывающейся смены запрещён (§3.1). Закрытая
    // смена того же ключа в visibleShifts не попадает и дубликатом не является.
    function isDuplicate(objectId, workDate, shiftType) {
      return visibleRows().some(row => row.objectId === objectId
        && row.workDate === workDate
        && shiftTypeOf(row) === shiftType);
    }

    function settle(response, extra) {
      if (response && response.ok === true) {
        return Object.assign({
          ok: true,
          code: 'ok',
          operationId: isNonEmptyString(response.operationId) ? response.operationId : (extra && extra.operationId) || null,
          replayed: response.replayed === true,
          result: response.result
        }, extra || {});
      }
      const error = response && isRecord(response.error) ? response.error : {};
      return Object.assign(
        fail(isNonEmptyString(error.code) ? error.code : 'transport-failed', isRecord(error.details) ? error.details : {}),
        extra || {}
      );
    }

    function canCreate() { return hasRight(RIGHTS.create); }
    function canManageMembers() { return hasRight(RIGHTS.members); }
    function canClose() { return hasRight(RIGHTS.close); }
    function canForceTransfer() { return hasRight(RIGHTS.forceTransfer); }

    async function createShift(input) {
      const settings = input || {};
      if (!canCreate()) return fail('forbidden', { right: RIGHTS.create });
      const shiftType = settings.shiftType;
      if (!SHIFT_TYPES[shiftType]) return fail('invalid-shift-type', { field: 'shiftType' });
      if (!validWorkDate(settings.workDate)) return fail('invalid-work-date', { field: 'workDate' });
      const objectId = text(settings.objectId);
      if (!objectId) return fail('invalid-object-id', { field: 'objectId' });
      if (isDuplicate(objectId, settings.workDate, shiftType)) {
        return fail('duplicate-shift', { objectId, workDate: settings.workDate, shiftType });
      }
      const operationId = operationFor(settings.operationId);
      if (!operationId) return fail('invalid-operation-id', { field: 'operationId' });
      const payload = { operationId, objectId, workDate: settings.workDate, shiftType };
      const cycleMinutes = Number(settings.cycleMinutes);
      if (Number.isFinite(cycleMinutes) && cycleMinutes > 0) payload.cycleMinutes = cycleMinutes;
      return settle(await transport.createShift(payload), { operationId });
    }

    async function addMember(input) {
      const settings = input || {};
      if (!canManageMembers()) return fail('forbidden', { right: RIGHTS.members });
      const shiftId = text(settings.shiftId);
      if (!shiftId) return fail('invalid-shift-id', { field: 'shiftId' });
      const uid = text(settings.uid);
      if (!uid) return fail('invalid-uid', { field: 'uid' });
      const context = readContext(shiftId);
      const shiftRevision = shiftRevisionOf(context);
      if (shiftRevision === null) return fail('revision-unknown', { shiftId, field: 'shift' });
      const member = memberOf(context, uid);
      let membershipRevision = null;
      if (member) {
        membershipRevision = revisionValue(member.revision);
        // Строка участника есть, но её ревизия неизвестна: CAS без числа
        // означал бы «перезаписать что угодно».
        if (membershipRevision === null) return fail('revision-unknown', { shiftId, uid, field: 'membership' });
      }
      const operationId = operationFor(settings.operationId);
      if (!operationId) return fail('invalid-operation-id', { field: 'operationId' });
      return settle(await transport.addMember({
        operationId,
        shiftId,
        uid,
        expectedShiftRevision: shiftRevision,
        expectedMembershipRevision: membershipRevision
      }), { operationId, shiftId });
    }

    async function removeMember(input) {
      const settings = input || {};
      if (!canManageMembers()) return fail('forbidden', { right: RIGHTS.members });
      const shiftId = text(settings.shiftId);
      if (!shiftId) return fail('invalid-shift-id', { field: 'shiftId' });
      const uid = text(settings.uid);
      if (!uid) return fail('invalid-uid', { field: 'uid' });
      const context = readContext(shiftId);
      const shiftRevision = shiftRevisionOf(context);
      if (shiftRevision === null) return fail('revision-unknown', { shiftId, field: 'shift' });
      const member = memberOf(context, uid);
      const membershipRevision = member ? revisionValue(member.revision) : null;
      if (membershipRevision === null) return fail('revision-unknown', { shiftId, uid, field: 'membership' });
      const operationId = operationFor(settings.operationId);
      if (!operationId) return fail('invalid-operation-id', { field: 'operationId' });
      return settle(await transport.removeMember({
        operationId,
        shiftId,
        uid,
        expectedShiftRevision: shiftRevision,
        expectedMembershipRevision: membershipRevision
      }), { operationId, shiftId });
    }

    // Итоги берутся из receipt prepare; если сервер их там не прислал (§5.5
    // перечисляет только токен и ревизии), единственный честный источник —
    // снимок контекста этой смены, а не локальные счётчики экрана.
    function closeTotals(receipt, context) {
      const receiptTrips = Number(receipt && receipt.totalTrips);
      if (Number.isFinite(receiptTrips) && receiptTrips >= 0) {
        const receiptVolume = Number(receipt.totalVolume);
        return { totalTrips: receiptTrips, totalVolume: Number.isFinite(receiptVolume) ? receiptVolume : 0, source: 'receipt' };
      }
      const logs = context && context.snapshot && Array.isArray(context.snapshot.logs) ? context.snapshot.logs : [];
      const volume = logs.reduce((sum, log) => {
        const value = Number(log && log.volume);
        return Number.isFinite(value) ? sum + value : sum;
      }, 0);
      return { totalTrips: logs.length, totalVolume: volume, source: 'snapshot' };
    }

    async function closeShift(input) {
      const settings = input || {};
      if (!canClose()) return fail('forbidden', { right: RIGHTS.close });
      const shiftId = text(settings.shiftId);
      if (!shiftId) return fail('invalid-shift-id', { field: 'shiftId' });
      const context = readContext(shiftId);
      const expectedShiftRevision = shiftRevisionOf(context);
      if (expectedShiftRevision === null) return fail('revision-unknown', { shiftId, field: 'shift' });
      const base = operationFor(settings.operationId);
      if (!base) return fail('invalid-operation-id', { field: 'operationId' });

      const phases = [];
      const prepared = await transport.prepareClose({
        operationId: phaseId(base, 'prepare'),
        shiftId,
        expectedShiftRevision
      });
      phases.push('prepare');
      if (!prepared || prepared.ok !== true) return settle(prepared, { operationId: base, phases });
      const receipt = isRecord(prepared.result) ? prepared.result : {};
      const closeToken = receipt.closeToken;
      if (!isNonEmptyString(closeToken)) {
        return fail('invalid-api-response', { reason: 'close-token-missing', phase: 'prepare' });
      }
      const archiveRevision = revisionValue(receipt.archiveRevision);
      if (archiveRevision === null || archiveRevision < 1) {
        return fail('invalid-api-response', { reason: 'archive-revision-missing', phase: 'prepare' });
      }
      let shiftRevision = revisionValue(receipt.shiftRevision);
      if (shiftRevision === null) {
        return fail('invalid-api-response', { reason: 'shift-revision-missing', phase: 'prepare' });
      }

      const totals = closeTotals(receipt, context);
      let markerRevision = null;
      if (totals.totalTrips > 0) {
        const materialId = text(settings.materialId);
        const volume = Number(settings.volume);
        if (!materialId || !Number.isFinite(volume) || volume < 0) {
          return Object.assign(
            fail('material-required', {
              totalTrips: totals.totalTrips,
              totalVolume: totals.totalVolume,
              archiveRevision,
              closeToken,
              shiftRevision
            }),
            { operationId: base, phases }
          );
        }
        const material = await transport.confirmMaterial({
          operationId: phaseId(base, 'material'),
          shiftId,
          closeToken,
          materialId,
          volume,
          expectedShiftRevision: shiftRevision,
          expectedArchiveRevision: archiveRevision,
          // null — значение CAS «маркера ещё нет», а не отсутствие поля.
          expectedMaterialMarkerRevision: null
        });
        phases.push('material');
        if (!material || material.ok !== true) return settle(material, { operationId: base, phases });
        const materialReceipt = isRecord(material.result) ? material.result : {};
        markerRevision = revisionValue(materialReceipt.materialMarkerRevision);
        if (markerRevision === null || markerRevision < 1) {
          return fail('invalid-api-response', { reason: 'material-marker-revision-missing', phase: 'material' });
        }
        const materialShiftRevision = revisionValue(materialReceipt.shiftRevision);
        if (materialShiftRevision !== null) shiftRevision = materialShiftRevision;
      }

      const finished = await transport.finishClose({
        operationId: phaseId(base, 'finish'),
        shiftId,
        closeToken,
        expectedShiftRevision: shiftRevision,
        expectedArchiveRevision: archiveRevision,
        expectedMaterialMarkerRevision: markerRevision
      });
      phases.push('finish');
      if (!finished || finished.ok !== true) return settle(finished, { operationId: base, phases });
      return {
        ok: true,
        code: 'closed',
        operationId: base,
        phases,
        result: finished.result,
        totals,
        closeToken
      };
    }

    function describe(input) {
      const code = isNonEmptyString(input)
        ? input
        : (isRecord(input) && isNonEmptyString(input.code) ? input.code : '');
      return MESSAGES[code] || UNKNOWN_MESSAGE;
    }

    return {
      canCreate,
      canManageMembers,
      canClose,
      canForceTransfer,
      createShift,
      addMember,
      removeMember,
      closeShift,
      describe
    };
  }

  const api = { createShiftManagement };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestShiftManagement = api;
})(typeof window !== 'undefined' ? window : globalThis);
// Восстановленный архив: provenance, история ревизий и права (design §5.6, §10.1, §10.2).
//
// Архив — immutable revision chain. По умолчанию читается последняя
// опубликованная (latest finalized) ревизия; явный выбор ревизии — отдельный
// read-only просмотр, который никогда не меняет default pointer. Provenance
// показывает исходного автора/тип смены и отдельного восстановившего актора.
// Неразрешённые данные выводятся буквальными текстами «Автор не установлен» и
// «Тип смены не подтверждён»; fallback на sender/displayName/email/hour/createdBy
// запрещён.
//
// Файл — classic script (IIFE → globalThis), без сети и DOM: провайдер ревизий и
// права инжектируются снаружи, поэтому модуль проверяется без сервера.
(function (root) {
  'use strict';

  const MISSING_AUTHOR = 'Автор не установлен';
  const MISSING_TYPE = 'Тип смены не подтверждён';
  const SHIFT_TYPE_LABELS = { day: 'День', night: 'Ночь' };

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function copy(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function revisionNumber(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1 ? number : null;
  }

  function actorLabel(actor, nameSnapshot) {
    if (isRecord(actor)) {
      if (isNonEmptyString(actor.name)) return actor.name.trim();
      if (isNonEmptyString(actor.uid)) return actor.uid;
    }
    if (isNonEmptyString(nameSnapshot)) return nameSnapshot.trim();
    return MISSING_AUTHOR;
  }

  // Серверный литерал неразрешённого значения приходит в нижнем регистре
  // («автор не установлен»), а UI обязан показывать текст design §10.2.
  function sameText(value, literal) {
    return typeof value === 'string' && value.trim().toLowerCase() === literal.toLowerCase();
  }

  // Provenance приходит в двух формах:
  //  - вложенная (инжектируемый провайдер и старые тесты):
  //    {opener, openerResolution, shiftType, shiftTypeResolution,
  //     restoringActor, restoredByNameSnapshot};
  //  - плоская серверная (server/src/restored-context-store.mjs):
  //    {originalOpenedByUid, originalOpenedByName, originalShiftType,
  //     originalShiftTypeResolution, restoredByName, unresolvedAuthor,
  //     unresolvedShiftType, authorText, shiftTypeText}.
  // Читаются обе; серверные флаг и литерал в приоритете, потому что сервер уже
  // доказал (или не доказал) автора и тип смены.
  function flatAuthorLabel(provenance) {
    if (isNonEmptyString(provenance.authorText)) return provenance.authorText.trim();
    if (isNonEmptyString(provenance.originalOpenedByName)) return provenance.originalOpenedByName.trim();
    if (isNonEmptyString(provenance.originalOpenedByUid)) return provenance.originalOpenedByUid;
    return null;
  }

  // Original opener берётся только из archive provenance. Поля sender,
  // displayName, email, createdBy и hour — не доказательство авторства.
  function openerInfo(provenance) {
    if (!isRecord(provenance)) return { label: MISSING_AUTHOR, unresolved: true };
    if (provenance.unresolvedAuthor === true) return { label: MISSING_AUTHOR, unresolved: true };
    const flat = flatAuthorLabel(provenance);
    if (flat !== null) {
      return sameText(flat, MISSING_AUTHOR)
        ? { label: MISSING_AUTHOR, unresolved: true }
        : { label: flat, unresolved: false };
    }
    if (provenance.openerResolution === 'unresolved') return { label: MISSING_AUTHOR, unresolved: true };
    if (!isRecord(provenance.opener)) return { label: MISSING_AUTHOR, unresolved: true };
    const label = actorLabel(provenance.opener, null);
    return label === MISSING_AUTHOR
      ? { label: MISSING_AUTHOR, unresolved: true }
      : { label, unresolved: false };
  }

  // Восстановивший — отдельный актор текущей restore-команды, он не заменяет
  // автора смены и не выводится из его полей. Вложенная форма — restoringActor,
  // плоская серверная — restoredByName.
  function restoringInfo(provenance) {
    if (!isRecord(provenance)) return { label: MISSING_AUTHOR, unresolved: true };
    const nameSnapshot = isNonEmptyString(provenance.restoredByName)
      ? provenance.restoredByName
      : provenance.restoredByNameSnapshot;
    const label = actorLabel(provenance.restoringActor, nameSnapshot);
    return label === MISSING_AUTHOR
      ? { label: MISSING_AUTHOR, unresolved: true }
      : { label, unresolved: false };
  }

  // Тип смены берётся только из archive (shift_type + resolution). Час и
  // workShift/type-алиасы не являются доказательством и не используются.
  function shiftTypeLabel(value) {
    if (!isNonEmptyString(value)) return null;
    const key = value.trim();
    if (SHIFT_TYPE_LABELS[key]) return SHIFT_TYPE_LABELS[key];
    const known = Object.keys(SHIFT_TYPE_LABELS).some(code => SHIFT_TYPE_LABELS[code] === key);
    return known ? key : null;
  }

  function shiftTypeInfo(provenance) {
    if (!isRecord(provenance)) return { label: MISSING_TYPE, unresolved: true };
    if (provenance.unresolvedShiftType === true) return { label: MISSING_TYPE, unresolved: true };
    // Плоская серверная форма: shiftTypeText — готовый текст (сырой тип или
    // серверный литерал), originalShiftType — исходный shift_type.
    const text = isNonEmptyString(provenance.shiftTypeText)
      ? provenance.shiftTypeText.trim()
      : (isNonEmptyString(provenance.originalShiftType) ? provenance.originalShiftType.trim() : '');
    if (text) {
      if (sameText(text, MISSING_TYPE)) return { label: MISSING_TYPE, unresolved: true };
      const flatLabel = shiftTypeLabel(text);
      return flatLabel
        ? { label: flatLabel, unresolved: false }
        : { label: MISSING_TYPE, unresolved: true };
    }
    if (provenance.shiftTypeResolution === 'unresolved') return { label: MISSING_TYPE, unresolved: true };
    const label = shiftTypeLabel(provenance.shiftType);
    return label
      ? { label, unresolved: false }
      : { label: MISSING_TYPE, unresolved: true };
  }

  function createRestoredArchive(options) {
    const config = options || {};
    const restoredContextId = isNonEmptyString(config.restoredContextId) ? config.restoredContextId : '';

    function latestRevisionNumber() {
      const source = config.latestRevision;
      const value = typeof source === 'function' ? source() : source;
      return revisionNumber(value);
    }

    // Provenance для UI: {opener, shiftType, restoringActor, lines[], unresolved[]}.
    // lines — готовые строки карточки, чтобы UI не собирал буквальные тексты сам.
    function describeProvenance(provenance) {
      const opener = openerInfo(provenance);
      const shiftType = shiftTypeInfo(provenance);
      const restoringActor = restoringInfo(provenance);
      const unresolved = [];
      if (opener.unresolved) unresolved.push('opener');
      if (shiftType.unresolved) unresolved.push('shiftType');
      if (restoringActor.unresolved) unresolved.push('restoringActor');
      return {
        opener: opener.label,
        shiftType: shiftType.label,
        restoringActor: restoringActor.label,
        lines: [
          'Автор: ' + opener.label,
          'Тип смены: ' + shiftType.label,
          'Восстановил: ' + restoringActor.label
        ],
        unresolved
      };
    }

    // Ревизия приходит в двух формах: вложенная/инжектируемая
    // {archiveRevision, archiveSha256, publishedAt, finalized} и серверная
    // {revision, sha256, createdAt} (server/src/archive-latest.mjs, toRevision).
    // Серверная строка всегда финализирована: в серии других ревизий не бывает.
    function revisionInfo(revision) {
      if (!isRecord(revision)) return null;
      const legacyNumber = revisionNumber(revision.archiveRevision);
      const serverNumber = revisionNumber(revision.revision);
      const number = legacyNumber !== null ? legacyNumber : serverNumber;
      if (number === null) return null;
      const finalized = revision.finalized === true
        ? true
        : (revision.finalized === false ? false : serverNumber !== null);
      return {
        number,
        finalized,
        sha256: isNonEmptyString(revision.archiveSha256)
          ? revision.archiveSha256
          : (isNonEmptyString(revision.sha256) ? revision.sha256 : ''),
        publishedAt: isNonEmptyString(revision.publishedAt)
          ? revision.publishedAt
          : (isNonEmptyString(revision.createdAt) ? revision.createdAt : '')
      };
    }

    // Копия выбранной ревизии с явным флагом. Для серверной формы добавляются
    // привычные UI поля (archiveRevision/archiveSha256/publishedAt/finalized),
    // чтобы модалка читала их без правок.
    function withExplicit(revision, info, explicit) {
      const result = Object.assign(copy(revision), { explicit });
      if (result.archiveRevision === undefined) result.archiveRevision = info.number;
      if (result.archiveSha256 === undefined) result.archiveSha256 = info.sha256;
      if (result.publishedAt === undefined) result.publishedAt = info.publishedAt;
      if (result.finalized === undefined) result.finalized = info.finalized;
      return result;
    }

    // Default pointer — единственная authoritative latest finalized revision.
    // Пустой/битый список не превращается в выдуманную ревизию 1.
    function resolveDefault(revisions) {
      if (!Array.isArray(revisions)) return null;
      let latest = null;
      let latestInfo = null;
      let latestNumber = 0;
      for (const revision of revisions) {
        const info = revisionInfo(revision);
        if (!info || info.finalized !== true) continue;
        if (info.number <= latestNumber) continue;
        latest = revision;
        latestInfo = info;
        latestNumber = info.number;
      }
      if (!latest) return null;
      return withExplicit(latest, latestInfo, false);
    }

    // Explicit revision — отдельный read-only выбор. Он возвращает копию с
    // explicit:true и не участвует в вычислении default pointer.
    function selectRevision(revisions, revisionNumberInput) {
      if (!Array.isArray(revisions)) return null;
      const wanted = revisionNumber(revisionNumberInput);
      if (wanted === null) return null;
      for (const revision of revisions) {
        const info = revisionInfo(revision);
        if (!info || info.finalized !== true) continue;
        if (info.number !== wanted) continue;
        return withExplicit(revision, info, true);
      }
      return null;
    }

    // Описание ревизии не содержит редактируемых полей: explicit или не-latest
    // помечается readOnly, правки идут только через latest finalized context.
    function describeRevision(revision) {
      const info = revisionInfo(revision);
      if (!info) return null;
      const latest = latestRevisionNumber();
      const readOnly = revision.explicit === true || (latest !== null && info.number !== latest);
      return {
        revision: info.number,
        sha256: info.sha256,
        publishedAt: info.publishedAt,
        label: 'Ревизия ' + info.number + (info.finalized === true ? ' · опубликована' : ' · не опубликована'),
        readOnly
      };
    }

    // Archive ACL: правка рейсов/ТТН и публикация ревизии. Обе не дают
    // активных line-команд (arrive/load/reset, состав, close).
    function canCorrect(rights) {
      return isRecord(rights) && rights.archive_edit === true;
    }

    function canFinalize(rights, contextId) {
      if (!canCorrect(rights)) return false;
      const target = contextId === undefined ? restoredContextId : contextId;
      return isNonEmptyString(target);
    }

    // Ручное уточнение авторства — только admin или отдельное legacy-право.
    function canResolveManually(rights) {
      if (!isRecord(rights)) return false;
      return rights.admin === true || rights.legacy_resolve === true || rights.role === 'admin';
    }

    // Восстановленный архив никогда не является активной сменой: ни в полосе
    // открытых линий, ни в active line-командах.
    function isRestoredRow(row) {
      if (!isRecord(row)) return false;
      if (row.restored === true) return true;
      if (isNonEmptyString(row.restoredFrom) || (isRecord(row.restoredFrom) && Object.keys(row.restoredFrom).length > 0)) return true;
      if (isNonEmptyString(row.restoredContextId)) return true;
      if (isRecord(row.restoredContext) && Object.keys(row.restoredContext).length > 0) return true;
      return row.state === 'historical';
    }

    return Object.freeze({
      describeProvenance,
      resolveDefault,
      selectRevision,
      describeRevision,
      canCorrect,
      canFinalize,
      canResolveManually,
      isRestoredRow
    });
  }

  const api = { createRestoredArchive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestRestoredArchive = api;
})(typeof window !== 'undefined' ? window : globalThis);
// Рейсы, оставшиеся в прежней смене (design §3.3, §7, §10.2).
//
// Force transfer отделяет незавершённый цикл в detached trip, который навсегда
// принадлежит исходной смене A. Завершить его могут участники A или текущей B,
// но событие, рейс, rewards/material/report и receipt записываются только в A.
// Из-за cross-shift CAS команда online-only: офлайн UI показывает read-only и
// причину, а в очередь ничего не пишется.
//
// Файл — classic script (IIFE → globalThis), без DOM. Транспорт инжектируется,
// поэтому модуль проверяется шпионом без сети.
(function (root) {
  'use strict';

  const WARNING = 'Действие будет записано в исходную смену';
  const STAGE_LABELS = {
    arrive: 'Прибытие',
    arrived: 'Прибытие',
    load: 'Погрузка',
    loaded: 'Погрузка',
    ttn: 'ТТН',
    'ttn-pending': 'Ожидает ТТН'
  };
  const SHIFT_TYPE_LABELS = { day: 'День', night: 'Ночь' };
  const CYCLE_REVISION_KEYS = ['expectedDetachedCycleRevision', 'detachedCycleRevision', 'cycleRevision'];
  const SOURCE_REVISION_KEYS = ['expectedSourceShiftRevision', 'sourceShiftRevision'];
  const DESTINATION_REVISION_KEYS = ['expectedDestinationShiftRevision', 'destinationShiftRevision'];

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function copy(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function isOpen(trip) {
    if (!isRecord(trip)) return false;
    if (trip.completed === true) return false;
    return trip.status !== 'completed' && trip.state !== 'completed';
  }

  // Ревизия из фактической записи. Отсутствующая и испорченная одинаково
  // означают «неизвестна»: команду с выдуманным CAS отправлять нельзя.
  function revisionOf(trip, keys) {
    for (const key of keys) {
      const value = trip[key];
      if (value === undefined || value === null || value === '') continue;
      const number = Number(value);
      return Number.isSafeInteger(number) && number >= 1 ? number : null;
    }
    return null;
  }

  function firstText() {
    for (let index = 0; index < arguments.length; index += 1) {
      const value = arguments[index];
      if (isNonEmptyString(value)) return value.trim();
    }
    return '';
  }

  function stageLabel(trip) {
    const stage = firstText(trip.stage, trip.cycleStage);
    if (!stage) return 'Стадия не подтверждена';
    return STAGE_LABELS[stage] || stage;
  }

  // Подпись исходной смены: объект, дата, день/ночь и стадия незавершённого
  // цикла — ровно из полей detached-записи. Серверный снимок отдаёт смену
  // вложенным объектом `sourceShift`, поэтому сначала читаем его: без этого
  // подпись всегда была «Объект не указан · Дата не указана».
  function sourceLabel(trip) {
    const source = isRecord(trip.sourceShift) ? trip.sourceShift : {};
    const object = firstText(trip.sourceObjectName, source.objectName,
      trip.sourceObjectId, source.objectId, trip.objectName, trip.objectId);
    const date = firstText(trip.sourceWorkDate, source.workDate, source.date, trip.workDate, trip.startDate);
    const type = firstText(trip.sourceShiftType, source.shiftType, source.workShift, source.type, trip.shiftType);
    const typeLabel = SHIFT_TYPE_LABELS[type] || type;
    return [object || 'Объект не указан', date || 'Дата не указана', typeLabel || 'Тип смены не подтверждён', stageLabel(trip)]
      .join(' · ');
  }

  function createDetachedTrips(options) {
    const config = options || {};
    const transport = config.transport || null;

    function onlineNow() {
      const source = config.online;
      if (typeof source === 'function') return source() === true;
      return source === true;
    }

    // Только свои открытые рейсы: sourceShiftId === shiftId или
    // destinationShiftId === shiftId. Чужие и завершённые не отдаются.
    function list(store, shiftId) {
      if (!isNonEmptyString(shiftId)) return [];
      let rows = [];
      if (store && typeof store.detachedTripsFor === 'function') {
        try {
          rows = store.detachedTripsFor(shiftId);
        } catch (_) {
          rows = [];
        }
      } else if (Array.isArray(store)) {
        rows = store;
      } else if (isRecord(store) && Array.isArray(store.detachedOpenTrips)) {
        rows = store.detachedOpenTrips;
      }
      if (!Array.isArray(rows)) return [];
      return rows
        .filter(trip => isRecord(trip) && isOpen(trip))
        .filter(trip => trip.sourceShiftId === shiftId || trip.destinationShiftId === shiftId)
        .map(copy);
    }

    // Cross-shift CAS требует все три ревизии. Если хотя бы одна неизвестна,
    // команда не отправляется: тело с null вместо ревизии сервер отвергнет как
    // invalid-command, и пользователь получил бы ложную ошибку вместо честной
    // причины «данные ещё не загружены».
    function missingRevision(trip) {
      if (!isRecord(trip)) return 'detached';
      if (revisionOf(trip, CYCLE_REVISION_KEYS) === null) return 'detached';
      if (revisionOf(trip, SOURCE_REVISION_KEYS) === null) return 'source';
      if (revisionOf(trip, DESTINATION_REVISION_KEYS) === null) return 'destination';
      return '';
    }

    // Карточка рейса: крупная подпись источника, точное предупреждение и
    // честный canComplete (online + открыт + известны все три ревизии).
    function describe(trip) {
      const label = isRecord(trip) ? sourceLabel(trip) : 'Объект не указан';
      const revisionsKnown = isRecord(trip) && missingRevision(trip) === '';
      return {
        sourceLabel: label,
        stageLabel: isRecord(trip) ? stageLabel(trip) : 'Стадия не подтверждена',
        warning: WARNING + ': ' + label,
        canComplete: isRecord(trip) && isOpen(trip) && onlineNow() && revisionsKnown,
        onlineOnly: true
      };
    }

    // Завершение detached-рейса — только online и только через транспорт.
    // Никакой офлайн-очереди у модуля нет; queue в options существует лишь
    // затем, чтобы тест мог доказать отсутствие записи.
    async function complete(input) {
      const settings = input || {};
      const trip = settings.trip;
      if (!isRecord(trip)) return { ok: false, code: 'invalid-trip' };
      if (!isOpen(trip)) return { ok: false, code: 'trip-completed' };
      if (!onlineNow()) return { ok: false, code: 'online-required' };
      const unknown = missingRevision(trip);
      if (unknown) return { ok: false, code: 'revision-unknown', details: { field: unknown } };
      const cycleRevision = revisionOf(trip, CYCLE_REVISION_KEYS);
      if (!transport || typeof transport.completeDetachedTrip !== 'function') {
        return { ok: false, code: 'transport-unavailable' };
      }
      const operationId = settings.operationId;
      const sourceShiftId = trip.sourceShiftId;
      const destinationShiftId = trip.destinationShiftId;
      const cycleId = firstText(trip.cycleId, trip.detachedCycleId);
      const truckId = firstText(settings.truckId, trip.truckId);
      if (![operationId, sourceShiftId, destinationShiftId, cycleId, truckId].every(isNonEmptyString)) {
        return { ok: false, code: 'invalid-trip' };
      }
      return transport.completeDetachedTrip({
        operationId,
        sourceShiftId,
        destinationShiftId,
        cycleId,
        truckId,
        type: firstText(settings.type, trip.type, trip.stage),
        expectedSourceShiftRevision: revisionOf(trip, SOURCE_REVISION_KEYS),
        expectedDestinationShiftRevision: revisionOf(trip, DESTINATION_REVISION_KEYS),
        expectedDetachedCycleRevision: cycleRevision,
        // v2-команда завершения требует createdAt (§5.4). Экран передаёт момент
        // подтверждения, а без него берётся текущий — это время самой команды,
        // а не выдуманный факт о рейсе.
        fields: {
          createdAt: Number.isSafeInteger(settings.createdAt) && settings.createdAt > 0
            ? settings.createdAt
            : Date.now()
        }
      });
    }

    return Object.freeze({ list, describe, complete });
  }

  const api = { createDetachedTrips };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestDetachedTrips = api;
})(typeof window !== 'undefined' ? window : globalThis);
// Интерфейс параллельных смен, которого не хватало клиенту (design §10.2):
//   1) принудительный перевод самосвала в другую смену с крупным подтверждением;
//   2) блок «Рейсы, оставшиеся в прежней смене» с действием «завершить в
//      прежней смене».
//
// Модуль не рисует сам себя на старте и ничего не делает без моста v2: экран
// «Линия» без флага WORKING_TEST_V2_SHIFTS остаётся ровно таким, как в 1.8.7.
// Команды уходят только через транспорт v2 и только online: обе операции
// меняют сразу две смены, поэтому офлайн-очередь для них запрещена (§9).
//
// CAS берётся из фактических контекстов смен, а не из догадок. Если ревизия
// второй смены неизвестна (она не загружена в этом окне), действие честно
// недоступно с причиной: тело с выдуманной ревизией сервер отверг бы, и
// пользователь получил бы ложную ошибку вместо правды.
//
// Файл — classic script (IIFE → globalThis). DOM инжектируется (doc/mount),
// поэтому блок проверяется фейковым DOM без браузера.
(function (root) {
  'use strict';

  const STAGE_LABELS = {
    arrive: 'Прибытие',
    arrived: 'Прибытие',
    load: 'Погрузка',
    loaded: 'Погрузка',
    ttn: 'ТТН',
    'ttn-pending': 'Ожидает ТТН'
  };
  const SHIFT_TYPE_LABELS = { day: 'День', night: 'Ночь' };
  const BLOCK_TITLE = 'Рейсы, оставшиеся в прежней смене';
  const OFFLINE_NOTE = 'Нет сети: завершение рейса в прежней смене доступно только при связи.';
  const OTHER_SHIFT_NOTE = 'Данные второй смены не загружены: обновите экран или попросите администратора завершить рейс.';
  const UNKNOWN_TRUCK = 'Самосвал не указан';
  const UNKNOWN_SHIFT = 'Смена не указана';
  const UNKNOWN_OBJECT = 'Объект не указан';
  const UNKNOWN_DATE = 'Дата не указана';
  const UNKNOWN_TYPE = 'Тип смены не подтверждён';
  const UNKNOWN_STAGE = 'Стадия не подтверждена';
  const COMPLETE_LABEL = 'Завершить в прежней смене';

  // Стабильные коды v2 → человеческий текст. Это только те коды, которые
  // встречаются в этих операциях; остальное отдаёт describeError моста.
  const MESSAGES = {
    forbidden: 'Недостаточно прав для перевода самосвала. Обратитесь к администратору.',
    'online-required': 'Для перевода самосвала и завершения переведённого рейса нужна связь: офлайн эти действия не выполняются.',
    'revision-unknown': 'Данные смены ещё не загружены с сервера. Обновите экран и повторите действие.',
    'source-shift-unavailable': 'Прежняя смена не загружена в этом окне. Обновите экран; если не поможет — переведите самосвал из окна администратора.',
    'destination-shift-unavailable': 'Вторая смена не загружена в этом окне. Обновите экран; если не поможет — попросите администратора завершить рейс.',
    'revision-conflict': 'Данные изменил другой пользователь. Диалог закрыт: обновите экран и повторите действие.',
    'shift-changed': 'Смена изменилась, пока шло действие. Обновите экран и повторите действие.',
    'transfer-context-changed': 'Смена самосвала уже изменилась. Обновите экран и повторите действие.',
    'truck-not-on-shift': 'Самосвал уже не в этой смене. Обновите экран и повторите действие.',
    'truck-detached-trip-open': 'У самосвала есть незавершённый рейс в прежней смене. Сначала завершите его, потом переводите самосвал.',
    'truck-assigned-to-other-shift': 'Самосвал работает в другой активной смене.',
    'detached-trip-not-found': 'Рейс уже не найден в прежней смене. Обновите экран.',
    'detached-trip-completed': 'Этот рейс уже завершён в прежней смене. Обновите экран.',
    'trip-completed': 'Этот рейс уже завершён в прежней смене. Обновите экран.',
    'shift-closed': 'Смена уже закрыта. Действие в закрытую смену не записывается.',
    'shift-closing': 'Смена закрывается: новые действия в неё не записываются.',
    'shift-not-visible': 'Смена недоступна в этом окне. Обновите экран и повторите действие.',
    'not-shift-member': 'Вы больше не участник этой смены. Попросите старшего прораба назначить вас заново.',
    'protocol-upgrade-required': 'Сервер требует новую версию приложения. Обновите страницу и повторите действие.',
    'invalid-context': 'Не выбрана смена: откройте нужную смену и повторите действие.',
    'transport-unavailable': 'Связь с сервером смен не готова. Обновите экран и повторите действие.',
    'confirmation-unavailable': 'Не удалось показать подтверждение перевода. Обновите экран и повторите действие.',
    'invalid-trip': 'Рейс не найден в списке. Обновите экран.',
    'transport-failed': 'Не удалось связаться с сервером. Проверьте связь и повторите действие.'
  };
  const UNKNOWN_MESSAGE = 'Не удалось выполнить действие. Обновите экран и повторите; если ошибка повторяется — сообщите администратору.';

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function firstText() {
    for (let index = 0; index < arguments.length; index += 1) {
      const value = arguments[index];
      if (isNonEmptyString(value)) return value.trim();
    }
    return '';
  }

  function copy(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  // Ревизия смены/статуса всегда ≥ 1 (сервер отвергает 0 как invalid-command).
  // Всё остальное — «неизвестна»: отправлять такую команду нельзя.
  function revisionValue(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1 ? number : null;
  }

  // Сервер отдаёт дату как ГГГГ-ММ-ДД; экран показывает ДД.ММ.ГГГГ. Любой
  // другой вид значения выводится как есть — догадываться о формате нельзя.
  function dateText(value) {
    const raw = text(value);
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    return iso ? iso[3] + '.' + iso[2] + '.' + iso[1] : raw;
  }

  function shiftTypeText(value) {
    const raw = text(value);
    if (!raw) return '';
    return SHIFT_TYPE_LABELS[raw] || raw;
  }

  function stageText(value) {
    const raw = text(value);
    if (!raw) return '';
    return STAGE_LABELS[raw] || raw;
  }

  // Подпись смены: объект · дата · день/ночь. Каждая часть либо пришла от
  // сервера, либо помечена честной подписью — выводить id вместо имени
  // объекта нельзя (design §10.2, уроки 60/61).
  function shiftLabel(row) {
    const source = isRecord(row) ? row : {};
    const object = firstText(source.objectName);
    const date = dateText(firstText(source.workDate, source.date));
    const type = shiftTypeText(firstText(source.shiftType, source.workShift, source.type));
    return [
      object || UNKNOWN_OBJECT,
      date || UNKNOWN_DATE,
      type || UNKNOWN_TYPE
    ].join(' · ');
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createShiftTransferUi(options) {
    const config = options || {};
    const store = config.store || null;
    const transport = config.transport || null;
    const doc = config.doc || null;
    const mount = config.mount || null;
    const confirmDialog = typeof config.confirm === 'function' ? config.confirm : null;
    const notify = typeof config.notify === 'function' ? config.notify : function () {};
    const truckLabelOf = typeof config.truckLabel === 'function' ? config.truckLabel : function () { return ''; };
    const objectLabelOf = typeof config.objectLabel === 'function' ? config.objectLabel : function () { return ''; };
    const describeError = typeof config.describeError === 'function' ? config.describeError : null;
    const onChange = typeof config.onChange === 'function' ? config.onChange : function () {};
    const now = typeof config.now === 'function' ? config.now : function () { return Date.now(); };
    let sequence = 0;
    let lastRenderKey = null;

    function onlineNow() {
      if (typeof config.online === 'function') return config.online() === true;
      return config.online !== false;
    }

    function rightsNow() {
      const source = config.rights;
      const value = typeof source === 'function' ? source() : source;
      return isRecord(value) ? value : {};
    }

    function hasRight(name) {
      return rightsNow()[name] === true;
    }

    // Право перевода — не только матрица прав: §6 разрешает перевод админу и
    // старшему прорабу, сервер проверяет роль отдельно. UI повторяет ту же
    // границу, чтобы прораб не получал крупный confirm, который сервер потом
    // отклонит.
    function mayForceTransfer() {
      if (!hasRight('force_transfer_truck')) return false;
      if (typeof config.forceTransferAllowed === 'function') return config.forceTransferAllowed() === true;
      return true;
    }

    function newOperationId() {
      if (typeof config.newOperationId === 'function') {
        const supplied = config.newOperationId();
        if (isNonEmptyString(supplied)) return supplied.trim();
      }
      sequence += 1;
      return 'op_' + Number(now()).toString(36) + '_' + sequence.toString(36)
        + '_' + Math.random().toString(36).slice(2, 10);
    }

    function contextOf(shiftId) {
      if (!isNonEmptyString(shiftId) || !store || typeof store.context !== 'function') return null;
      try {
        return store.context(shiftId);
      } catch (_) {
        return null;
      }
    }

    function shiftRowOf(shiftId) {
      const context = contextOf(shiftId);
      if (!context) return null;
      if (isRecord(context.shift)) return context.shift;
      if (context.snapshot && isRecord(context.snapshot.shift)) return context.snapshot.shift;
      return null;
    }

    function shiftRevisionOf(shiftId) {
      const context = contextOf(shiftId);
      if (!context) return null;
      const direct = revisionValue(context.revisions && context.revisions.shift);
      if (direct !== null) return direct;
      const snapshot = context.snapshot;
      if (isRecord(snapshot)) {
        const fromSnapshot = revisionValue(snapshot.shiftRevision);
        if (fromSnapshot !== null) return fromSnapshot;
        return revisionValue(snapshot.revisions && snapshot.revisions.shift);
      }
      return null;
    }

    function statusRowOf(shiftId, truckId) {
      const context = contextOf(shiftId);
      const statuses = context && context.snapshot && Array.isArray(context.snapshot.statuses)
        ? context.snapshot.statuses
        : [];
      return statuses.find(row => isRecord(row) && (row.id === truckId || row.truckId === truckId)) || null;
    }

    function truckLabel(truckId) {
      if (!isNonEmptyString(truckId)) return '';
      let label = '';
      try {
        label = truckLabelOf(truckId);
      } catch (_) {
        label = '';
      }
      return text(label);
    }

    // Объект исходной смены сервер в details называет только id, поэтому имя
    // берётся из общего справочника объектов — это реальный справочник, а не
    // догадка. Нет объекта в справочнике — честная подпись.
    function objectLabel(objectId) {
      if (!isNonEmptyString(objectId)) return '';
      let label = '';
      try {
        label = objectLabelOf(objectId);
      } catch (_) {
        label = '';
      }
      return text(label);
    }

    function messageFor(code) {
      if (isNonEmptyString(code) && MESSAGES[code]) return MESSAGES[code];
      if (describeError) {
        const described = describeError(code);
        if (isNonEmptyString(described)) return described;
      }
      return UNKNOWN_MESSAGE;
    }

    function failure(code, extra) {
      return Object.assign({ ok: false, code: code, message: messageFor(code) }, extra || {});
    }

    // Подпись исходной смены для перевода: сервер присылает objectId, workDate,
    // shiftType и stage; имя объекта берётся из справочника. Если исходная смена
    // загружена в store, её подпись точнее — она и используется.
    function sourceShiftLabel(details, sourceShiftId) {
      const stored = shiftRowOf(sourceShiftId);
      if (stored) return shiftLabel(stored);
      const object = objectLabel(details.objectId);
      const date = dateText(firstText(details.workDate));
      const type = shiftTypeText(firstText(details.shiftType));
      return [
        object || UNKNOWN_OBJECT,
        date || UNKNOWN_DATE,
        type || UNKNOWN_TYPE
      ].join(' · ');
    }

    function activeShiftId() {
      return store && typeof store.activeShiftId === 'function' ? store.activeShiftId() : null;
    }

    function destinationShiftId(input) {
      return firstText(input && input.destinationShiftId, activeShiftId());
    }

    // Модель крупного подтверждения. Одна и та же для диалога и для теста:
    // экран не собирает текст сам, поэтому состав подтверждения проверяем.
    function describeForceTransfer(input) {
      const settings = input || {};
      const details = isRecord(settings.details) ? settings.details : {};
      const truckId = firstText(settings.truckId, details.truckId);
      const sourceShiftId = firstText(settings.sourceShiftId, details.sourceShiftId);
      const targetShiftId = destinationShiftId(settings);
      const allowed = mayForceTransfer();
      const online = onlineNow();
      const truck = truckLabel(truckId);
      const sourceLabel = sourceShiftLabel(details, sourceShiftId);
      const destinationLabel = targetShiftId ? shiftLabel(shiftRowOf(targetShiftId)) : UNKNOWN_SHIFT;
      const stage = stageText(firstText(details.stage, settings.stage));
      const sourceRevision = shiftRevisionOf(sourceShiftId);
      const destinationRevision = shiftRevisionOf(targetShiftId);
      const status = statusRowOf(sourceShiftId, truckId);
      const statusRevision = revisionValue(status && status.statusRevision);
      const cycleRevision = revisionValue(status && status.cycleRevision);
      const ttnRevision = revisionValue(status && status.ttnRevision);
      const revisionsKnown = sourceRevision !== null && destinationRevision !== null
        && statusRevision !== null && cycleRevision !== null && ttnRevision !== null;

      let blockedReason = '';
      if (!allowed) blockedReason = 'forbidden';
      else if (!online) blockedReason = 'online-required';
      else if (!isNonEmptyString(truckId) || !isNonEmptyString(sourceShiftId) || !isNonEmptyString(targetShiftId)) blockedReason = 'invalid-context';
      else if (!revisionsKnown) blockedReason = 'revision-unknown';

      const lines = [
        'Самосвал: ' + (truck || UNKNOWN_TRUCK),
        'Из смены: ' + sourceLabel,
        'В смену: ' + (destinationLabel || UNKNOWN_SHIFT),
        'Незавершённый рейс: ' + (stage || UNKNOWN_STAGE)
      ];
      const consequences = [
        'Незавершённый рейс останется в прежней смене: ' + sourceLabel + '.',
        'Новые рейсы этого самосвала будут записаны в новую смену: ' + (destinationLabel || UNKNOWN_SHIFT) + '.',
        'Завершение старого рейса будет записано в прежнюю смену: ' + sourceLabel + '.'
      ];
      const irreversible = 'Отменить перевод будет нельзя.';
      const html = lines.map(line => '<b>' + escapeHtml(line.split(': ')[0]) + ':</b> '
        + escapeHtml(line.slice(line.indexOf(': ') + 2))).join('<br>')
        + '<br><br>' + consequences.map(item => '• ' + escapeHtml(item)).join('<br>')
        + '<br><br><b>' + escapeHtml(irreversible) + '</b>';

      return {
        allowed,
        online,
        canConfirm: blockedReason === '',
        blockedReason,
        blockedMessage: blockedReason ? messageFor(blockedReason) : '',
        truckId,
        truckLabel: truck || UNKNOWN_TRUCK,
        sourceShiftId,
        destinationShiftId: targetShiftId,
        sourceLabel,
        destinationLabel: destinationLabel || UNKNOWN_SHIFT,
        stageLabel: stage || UNKNOWN_STAGE,
        lines,
        consequences,
        irreversible,
        title: 'Перевести самосвал в другую смену?',
        message: html,
        confirmLabel: 'Перевести самосвал',
        cancelLabel: 'Оставить как есть',
        revisions: {
          source: sourceRevision,
          destination: destinationRevision,
          status: statusRevision,
          cycle: cycleRevision,
          ttn: ttnRevision
        }
      };
    }

    // Предупреждение без кнопки обхода: у прораба без права перевода остаётся
    // только сообщение с исходной сменой (design §10.2).
    function warnOccupiedTruck(input) {
      const model = describeForceTransfer(input);
      const message = 'Самосвал работает в другой активной смене: ' + model.sourceLabel
        + '. Перевод может выполнить старший прораб или администратор.';
      notify(message, true);
      return { ok: false, code: 'truck-assigned-to-other-shift', message: message, model: model };
    }

    async function refreshShift(shiftId) {
      if (!isNonEmptyString(shiftId) || !transport || typeof transport.readShiftSnapshot !== 'function') return null;
      try {
        return await transport.readShiftSnapshot({ shiftId: shiftId, requestKind: 'ui' });
      } catch (_) {
        return null;
      }
    }

    // Контекст второй смены нужен для CAS. Он читается только когда действие
    // уже начато (нажатие/ответ «занят»), а не на каждой перерисовке.
    async function ensureContext(shiftId) {
      if (!isNonEmptyString(shiftId)) return false;
      const context = contextOf(shiftId);
      if (!context) return false;
      if (shiftRevisionOf(shiftId) !== null) return true;
      await refreshShift(shiftId);
      return shiftRevisionOf(shiftId) !== null;
    }

    // Для перевода нужна ещё и ревизия статуса самосвала в прежней смене.
    // Если снимок прежней смены не загружен, он читается один раз по нажатию.
    async function ensureSourceStatus(sourceShiftId, truckId) {
      if (statusRowOf(sourceShiftId, truckId)) return true;
      await refreshShift(sourceShiftId);
      return !!statusRowOf(sourceShiftId, truckId);
    }

    async function forceTransfer(input) {
      const settings = input || {};
      const model = describeForceTransfer(settings);
      if (!model.canConfirm) return failure(model.blockedReason || 'forbidden', { model: model });
      if (!transport || typeof transport.forceTransferTruck !== 'function') {
        return failure('transport-unavailable', { model: model });
      }
      if (!confirmDialog) return failure('confirmation-unavailable', { model: model });
      let confirmed = false;
      try {
        confirmed = (await confirmDialog(model.title, model.message, {
          confirmLabel: model.confirmLabel,
          cancelLabel: model.cancelLabel,
          variant: 'danger',
          icon: '🚚',
          // Безопасный default: фокус на «Оставить как есть», Enter не
          // подтверждает перевод.
          focus: 'cancel',
          enterConfirms: false
        })) === true;
      } catch (_) {
        confirmed = false;
      }
      if (!confirmed) return { ok: false, code: 'cancelled', cancelled: true, message: 'Перевод отменён.', model: model };
      const response = await transport.forceTransferTruck({
        operationId: newOperationId(),
        sourceShiftId: model.sourceShiftId,
        destinationShiftId: model.destinationShiftId,
        truckId: model.truckId,
        confirmTransfer: true,
        expectedSourceShiftRevision: model.revisions.source,
        expectedDestinationShiftRevision: model.revisions.destination,
        expectedStatusRevision: model.revisions.status,
        expectedCycleRevision: model.revisions.cycle,
        expectedTtnRevision: model.revisions.ttn
      });
      if (!response || response.ok !== true) {
        const error = response && isRecord(response.error) ? response.error : {};
        const code = isNonEmptyString(error.code) ? error.code : 'transport-failed';
        // Конфликт CAS: диалог уже закрыт, повтор молча запрещён. Обе смены
        // перечитываются, чтобы экран показывал фактическое состояние.
        if (code === 'revision-conflict' || code === 'shift-changed' || code === 'transfer-context-changed') {
          await Promise.all([refreshShift(model.sourceShiftId), refreshShift(model.destinationShiftId)]);
          onChange();
        }
        return failure(code, { model: model, details: error.details || {} });
      }
      // Транспорт уже перечитал обе смены (refreshCrossShift); экран получает
      // согласованную проекцию, без повторного чтения по одной смене.
      onChange();
      return { ok: true, code: 'transferred', model: model, result: response.result, crossShift: response.crossShift };
    }

    // Экран самосвала «Добавить»: сначала обычное назначение в выбранную смену.
    // Сервер отвечает truck-assigned-to-other-shift, и только тогда показывается
    // либо предупреждение, либо крупное подтверждение перевода (§10.2).
    async function addTruckToShift(input) {
      const settings = input || {};
      const truckId = firstText(settings.truckId);
      const shiftId = destinationShiftId(settings);
      if (!hasRight('edit_line') || !hasRight('manage_trucks')) {
        return failure('forbidden');
      }
      if (!onlineNow()) return failure('online-required');
      if (!isNonEmptyString(truckId) || !isNonEmptyString(shiftId)) return failure('invalid-context');
      if (!transport || typeof transport.addTruck !== 'function') return failure('transport-unavailable');
      if (!(await ensureContext(shiftId))) return failure('revision-unknown');
      const shiftRevision = shiftRevisionOf(shiftId);
      if (shiftRevision === null) return failure('revision-unknown');
      const response = await transport.addTruck({
        operationId: newOperationId(),
        shiftId: shiftId,
        truckId: truckId,
        expectedShiftRevision: shiftRevision
      });
      if (response && response.ok === true) {
        await refreshShift(shiftId);
        onChange();
        return { ok: true, code: 'assigned', result: response.result };
      }
      const error = response && isRecord(response.error) ? response.error : {};
      const code = isNonEmptyString(error.code) ? error.code : 'transport-failed';
      const details = isRecord(error.details) ? error.details : {};
      if (code === 'truck-assigned-to-other-shift') {
        const occupied = {
          truckId: truckId,
          sourceShiftId: firstText(details.sourceShiftId),
          destinationShiftId: shiftId,
          details: details
        };
        if (!mayForceTransfer()) return warnOccupiedTruck(occupied);
        // Для CAS нужна и прежняя смена. Если её контекста нет в этом окне,
        // честно говорим об этом, а не отправляем команду без ревизии.
        if (!(await ensureContext(occupied.sourceShiftId))) {
          const message = messageFor('source-shift-unavailable');
          notify(message, true);
          return { ok: false, code: 'source-shift-unavailable', message: message, model: describeForceTransfer(occupied) };
        }
        if (!(await ensureSourceStatus(occupied.sourceShiftId, truckId))) {
          const message = messageFor('truck-not-on-shift');
          notify(message, true);
          return { ok: false, code: 'truck-not-on-shift', message: message, model: describeForceTransfer(occupied) };
        }
        return forceTransfer(occupied);
      }
      return failure(code, { details: details });
    }

    function detachedModule() {
      const api = root.WorkingTestDetachedTrips;
      if (!api || typeof api.createDetachedTrips !== 'function') return null;
      try {
        return api.createDetachedTrips({ transport: transport, online: onlineNow });
      } catch (_) {
        return null;
      }
    }

    // Право завершения зависит от сохранённой стадии — ровно как на сервере
    // (`DETACHED_LINE_ACTIONS`).
    function completionRight(stage) {
      if (stage === 'arrive' || stage === 'arrived') return hasRight('action_arrive');
      if (stage === 'ttn') return hasRight('action_ttn');
      if (stage === 'load' || stage === 'loaded') return hasRight('action_load');
      return false;
    }

    function tripRows(shiftId) {
      const detached = detachedModule();
      if (!detached || !isNonEmptyString(shiftId)) return [];
      try {
        return detached.list(store, shiftId);
      } catch (_) {
        return [];
      }
    }

    // Рейс, оставшийся в прежней смене: подпись источника и стадии берётся из
    // detached-записи, ревизии двух смен — из их контекстов. Без второй смены
    // действие недоступно: cross-shift CAS нельзя подтвердить.
    function describeDetached(shiftId) {
      const detached = detachedModule();
      if (!detached) return [];
      const online = onlineNow();
      return tripRows(shiftId).map(trip => {
        const sourceRevision = shiftRevisionOf(trip.sourceShiftId);
        const destinationRevision = shiftRevisionOf(trip.destinationShiftId);
        const augmented = Object.assign(copy(trip) || {}, {
          expectedSourceShiftRevision: sourceRevision,
          expectedDestinationShiftRevision: destinationRevision
        });
        let base = null;
        try {
          base = detached.describe(augmented);
        } catch (_) {
          base = null;
        }
        const stage = firstText(trip.stage, trip.cycleStage);
        const right = completionRight(stage);
        const revisionsKnown = sourceRevision !== null && destinationRevision !== null;
        let reason = '';
        if (!online) reason = 'offline';
        else if (!revisionsKnown) reason = 'other-shift-unavailable';
        else if (!right) reason = 'forbidden';
        const canComplete = !!base && base.canComplete === true && revisionsKnown && online && right;
        return {
          trip: copy(trip),
          sourceShiftId: trip.sourceShiftId,
          destinationShiftId: trip.destinationShiftId,
          cycleId: firstText(trip.cycleId, trip.detachedCycleId),
          truckId: firstText(trip.truckId),
          truckLabel: truckLabel(trip.truckId) || UNKNOWN_TRUCK,
          stage: stage,
          sourceLabel: base ? base.sourceLabel : UNKNOWN_OBJECT,
          stageLabel: base ? base.stageLabel : (stageText(stage) || UNKNOWN_STAGE),
          warning: base ? base.warning : ('Действие будет записано в исходную смену: ' + UNKNOWN_OBJECT),
          canComplete: canComplete,
          reason: canComplete ? '' : reason,
          reasonText: !online ? OFFLINE_NOTE : (!revisionsKnown ? OTHER_SHIFT_NOTE : (!right ? MESSAGES.forbidden : '')),
          actionLabel: COMPLETE_LABEL
        };
      });
    }

    async function completeDetached(input) {
      const settings = input || {};
      const trip = settings.trip;
      if (!isRecord(trip)) return failure('invalid-trip');
      if (!onlineNow()) return failure('online-required');
      const sourceShiftId = firstText(trip.sourceShiftId);
      const destinationShiftIdValue = firstText(trip.destinationShiftId);
      const stage = firstText(trip.stage, trip.cycleStage);
      if (!completionRight(stage)) return failure('forbidden');
      const detached = detachedModule();
      if (!detached) return failure('transport-unavailable');
      // Обе смены нужны для CAS: читаем недостающую, прежде чем отказывать.
      const [sourceReady, destinationReady] = await Promise.all([
        ensureContext(sourceShiftId),
        ensureContext(destinationShiftIdValue)
      ]);
      if (!sourceReady) return failure('source-shift-unavailable');
      if (!destinationReady) return failure('destination-shift-unavailable');
      const sourceRevision = shiftRevisionOf(sourceShiftId);
      const destinationRevision = shiftRevisionOf(destinationShiftIdValue);
      if (sourceRevision === null || destinationRevision === null) return failure('revision-unknown');
      const augmented = Object.assign(copy(trip) || {}, {
        expectedSourceShiftRevision: sourceRevision,
        expectedDestinationShiftRevision: destinationRevision
      });
      const response = await detached.complete({
        trip: augmented,
        operationId: newOperationId(),
        type: stage,
        truckId: firstText(trip.truckId),
        createdAt: now()
      });
      if (!response || response.ok !== true) {
        const error = response && isRecord(response.error) ? response.error : {};
        const code = isNonEmptyString(error.code)
          ? error.code
          : (isNonEmptyString(response && response.code) ? response.code : 'transport-failed');
        if (code === 'revision-conflict' || code === 'shift-changed' || code === 'transfer-context-changed') {
          await Promise.all([refreshShift(sourceShiftId), refreshShift(destinationShiftIdValue)]);
          onChange();
        }
        return failure(code, { details: (error && error.details) || {} });
      }
      await Promise.all([refreshShift(sourceShiftId), refreshShift(destinationShiftIdValue)]);
      onChange();
      return { ok: true, code: 'completed', result: response.result, crossShift: response.crossShift };
    }

    function element(tag, className, textContent) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (textContent !== undefined) node.textContent = String(textContent);
      return node;
    }

    // Блок на экране «Линия». Пустой список — блок скрыт целиком: без данных
    // он не занимает место и не мешает прежнему экрану (design §10.1).
    function render() {
      if (!doc || !mount) return 0;
      const shiftId = activeShiftId();
      const rows = describeDetached(shiftId);
      const key = JSON.stringify({
        shiftId: shiftId,
        online: onlineNow(),
        rows: rows.map(row => [row.cycleId, row.sourceShiftId, row.truckId, row.stage, row.sourceLabel, row.canComplete, row.reasonText])
      });
      if (key === lastRenderKey) return rows.length;
      lastRenderKey = key;
      mount.textContent = '';
      if (!rows.length) {
        mount.hidden = true;
        return 0;
      }
      mount.hidden = false;
      mount.appendChild(element('div', 'detached-trips-title', BLOCK_TITLE));
      if (!onlineNow()) mount.appendChild(element('p', 'detached-trips-note', OFFLINE_NOTE));
      for (const row of rows) {
        const card = element('div', 'detached-trip-card');
        card.dataset.cycleId = row.cycleId;
        card.dataset.sourceShiftId = row.sourceShiftId;
        card.appendChild(element('div', 'detached-trip-source', row.sourceLabel));
        card.appendChild(element('div', 'detached-trip-truck', 'Самосвал: ' + row.truckLabel));
        card.appendChild(element('p', 'detached-trip-warning', row.warning));
        if (!row.canComplete && row.reasonText) card.appendChild(element('p', 'detached-trip-reason', row.reasonText));
        const button = element('button', 'btn btn-secondary btn-small detached-trip-action', row.actionLabel);
        button.setAttribute('type', 'button');
        button.disabled = row.canComplete !== true;
        button.addEventListener('click', async () => {
          button.disabled = true;
          const result = await completeDetached({ trip: row.trip });
          if (!result.ok) {
            button.disabled = row.canComplete !== true;
            notify(result.message, true);
            return;
          }
          notify('Рейс завершён в прежней смене', false);
        });
        card.appendChild(button);
        mount.appendChild(card);
      }
      return rows.length;
    }

    return Object.freeze({
      describeForceTransfer,
      forceTransfer,
      addTruckToShift,
      describeDetached,
      completeDetached,
      render
    });
  }

  const api = { createShiftTransferUi };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestShiftTransferUi = api;
})(typeof window !== 'undefined' ? window : globalThis);
// Восстановленная архивная смена через v2 (design §5.6, §8, §10.1).
//
// Сервер держит восстановленную смену отдельным контекстом
// (`restored_shift_contexts`), а не строкой в `shifts`: карточка «Восстановленная
// смена» и её рейсы приходят из `GET /api/v2/archives/{id}/restored`, правки
// рейсов/ТТН — из `POST /api/v2/archives/{id}/operations`. Здесь только перевод
// серверных форм в форму клиента и сборка команд: ни DOM, ни сети, ни
// localStorage — транспорт и генератор operationId приходят снаружи.
//
// Почему отдельный файл: 45-restored-archive.js описывает provenance и ревизии
// архива, но ничего не знает о контексте правок. Смешивать эти два контракта в
// одном модуле значит снова получить «тест договорился сам с собой» (урок 61).
(function (root) {
  'use strict';

  const SHA_RE = /^[0-9a-f]{64}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const CORRECTION_TYPES = ['trip.update', 'trip.delete', 'ttn.update', 'ttn.delete'];

  // Прежний честный отказ (1.8.7): старый сервер, отсутствующий маршрут или
  // неподдерживаемый протокол не должны выглядеть как «смена восстановлена».
  const COMPAT_REFUSAL = 'Восстановление архивной смены в этом режиме недоступно: смена не создана, данные архива не изменены. Обратитесь к администратору.';
  // Маршрута публикации restored-контекста в сервере канала нет
  // (`finalizeRestoredContext` есть в домене, но не в `v2-router.mjs`).
  // «Вернуть в архив» обязан сказать это прямо, а не закрыть смену окольным путём.
  const FINALIZE_UNAVAILABLE = 'Вернуть восстановленную смену в архив сейчас нельзя: сервер ещё не публикует восстановленный контекст как ревизию архива. Правки сохранены в восстановленной смене, в архив она не вернулась.';
  const FINALIZED_NOTICE = 'Восстановленная смена уже опубликована в архив: правки и возврат недоступны.';

  const DOMAIN_REFUSALS = {
    'archive-not-found': 'Архивная смена не найдена на сервере: обновите архив и повторите. Данные не изменены.',
    'archive-not-restorable': 'Эту архивную смену нельзя восстановить для правок: в архиве нет даты или объекта. Данные не изменены.',
    'archive-truck-not-available': 'В архиве есть самосвал, которого больше нет в справочнике техники. Восстановление невозможно, данные не изменены.',
    'invalid-archive-data': 'Данные архивной смены повреждены: восстановление невозможно, данные не изменены.',
    'invalid-archive-id': 'Архивная смена указана неверно: обновите архив и повторите. Данные не изменены.',
    'archive-changed': 'Архивная смена изменилась в другом окне: обновите архив и повторите. Данные не изменены.',
    'archive-context-finalized': FINALIZED_NOTICE,
    'forbidden': 'Недостаточно прав для восстановления архивной смены: смена не создана, данные архива не изменены.',
    'unauthenticated': 'Сеанс истёк: войдите заново. Данные не изменены.'
  };

  const CORRECTION_REFUSALS = {
    'archive-changed': 'Смена изменилась в другом окне. Обновите страницу и повторите правку — ваша правка не применена.',
    'archive-context-finalized': FINALIZED_NOTICE,
    'archive-context-not-found': 'Восстановленная смена больше не открыта. Обновите страницу.',
    'restored-trip-not-found': 'Этот рейс уже удалён в другом окне. Обновите страницу.',
    'archive-operation-not-allowed': 'Это действие недоступно для восстановленной архивной смены.',
    'operation-id-reused': 'Операция уже выполнена с другими данными. Обновите страницу и повторите.',
    'forbidden': 'Недостаточно прав для правки восстановленной смены.',
    'invalid-command': 'Проверьте поля правки и повторите: данные не изменены.',
    'invalid-restored-trip': 'Рейс архивной смены повреждён: правка невозможна.',
    'invalid-api-response': 'Сервер вернул неожиданный ответ. Правка не применена, обновите страницу.',
    'v2-transport-failure': 'Нет связи с сервером. Правка не применена, повторите.'
  };

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function revision(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1 ? number : null;
  }

  // `work_date` сервер отдаёт из pg как `date`. В JSON это может быть и
  // строка `YYYY-MM-DD`, и мгновение (`2026-11-27T00:00:00.000Z`, а при
  // серверной зоне UTC+3 — `2026-11-26T21:00:00.000Z`). Дату смены нельзя
  // выводить как UTC-дату мгновения: полночь 27.11 по Москве — это ещё 26.11
  // в UTC, и карточка показывала день раньше (найдено стендом 393×852).
  const DAY_MS = 86400000;

  function utcDateOf(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  // Москва — постоянный UTC+3 (перехода на летнее время нет с 2014 года).
  // Тот же Intl-вызов с явной зоной использует `15-shifts.js`, когда строит
  // `startDate` закрываемой смены: карточка и шапка считают дату одинаково.
  function moscowDateOf(ms) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date(ms));
      const pick = type => {
        const part = parts.find(item => item.type === type);
        return part ? part.value : '';
      };
      const year = pick('year'), month = pick('month'), day = pick('day');
      if (/^\d{4}$/.test(year) && /^\d{2}$/.test(month) && /^\d{2}$/.test(day)) {
        return year + '-' + month + '-' + day;
      }
    } catch (_) { /* ниже — арифметический запасной путь */ }
    return new Date(ms + 3 * 3600000).toISOString().slice(0, 10);
  }

  // Мгновение → календарная дата смены. Ровно полночь UTC — это уже дата
  // смены: так выглядит pg-`date` после JSON на сервере в UTC. Любое другое
  // мгновение — реальный момент времени, его дата считается по Москве.
  function dateOfInstant(ms) {
    if (ms % DAY_MS === 0) return utcDateOf(ms);
    return moscowDateOf(ms);
  }

  // Формы, которые обязан принять клиент: голая дата, ISO со временем без
  // зоны (дата уже дана — мгновения нет), ISO с зоной, `ДД.ММ.ГГГГ`, Date.
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$)/;

  function isoDate(value) {
    // `instanceof Date` ложно для Date из другого realm (iframe, vm): форма
    // проверяется по внутреннему тегу, иначе дата молча пропадает.
    if (value instanceof Date || Object.prototype.toString.call(value) === '[object Date]') {
      const ms = Number(value.getTime());
      return Number.isFinite(ms) ? dateOfInstant(ms) : null;
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return null;
    const iso = ISO_RE.exec(text);
    if (iso) {
      const plain = iso[1] + '-' + iso[2] + '-' + iso[3];
      if (!iso[4]) return plain;
      const ms = Date.parse(text);
      return Number.isFinite(ms) ? dateOfInstant(ms) : plain;
    }
    const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
    if (ru) return ru[3] + '-' + ru[2].padStart(2, '0') + '-' + ru[1].padStart(2, '0');
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? dateOfInstant(ms) : null;
  }

  function ruDate(value) {
    const iso = isoDate(value);
    if (!iso) return '';
    return iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);
  }

  // Рейс архивной смены: серверная строка `{logId,truckId,payload,logRevision}`.
  // `payload` — точные байты рейса из архива, поэтому поля читаются из него, а
  // адрес — из строки контекста.
  function tripOf(row, shiftId) {
    if (!isRecord(row)) return null;
    const payload = isRecord(row.payload) ? row.payload : {};
    const id = isNonEmptyString(row.logId) ? row.logId : payload.id;
    const truckId = isNonEmptyString(row.truckId) ? row.truckId : payload.truckId;
    if (!isNonEmptyString(id) || !isNonEmptyString(truckId)) return null;
    const volume = Number(payload.volume);
    const timestamp = Number(payload.timestamp);
    return Object.assign({}, payload, {
      id,
      truckId,
      shiftId,
      restoredContextId: shiftId,
      volume: Number.isFinite(volume) ? volume : 0,
      timeStr: typeof payload.timeStr === 'string' ? payload.timeStr : '',
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      comment: typeof payload.comment === 'string' ? payload.comment : '',
      isGAI: payload.isGAI === true,
      logRevision: revision(row.logRevision) || 0
    });
  }

  function ttnOf(row) {
    if (!isRecord(row) || !isNonEmptyString(row.truckId)) return null;
    return {
      truckId: row.truckId,
      ttnStatus: row.ttnStatus === true ? true : (row.ttnStatus === 'pending' ? 'pending' : null),
      ttnRevision: revision(row.ttnRevision) || 0
    };
  }

  function contextOf(view) {
    return {
      restoredContextId: view.restoredContextId,
      archiveId: view.archiveId,
      sourceShiftId: isNonEmptyString(view.sourceShiftId) ? view.sourceShiftId : null,
      contextRevision: revision(view.contextRevision),
      baseArchiveRevision: revision(view.baseArchiveRevision),
      baseArchiveSha256: view.baseArchiveSha256,
      archiveRevision: revision(view.archiveRevision),
      archiveSha256: isNonEmptyString(view.archiveSha256) ? view.archiveSha256 : view.baseArchiveSha256,
      contextState: isNonEmptyString(view.contextState) ? view.contextState : 'open',
      mode: isNonEmptyString(view.mode) ? view.mode : null,
      baseIsLatest: view.baseIsLatest === true ? true : (view.baseIsLatest === false ? false : null),
      latestFinalizedRevision: revision(view.latestFinalizedRevision),
      tripsPage: isRecord(view.tripsPage) ? {
        limit: revision(view.tripsPage.limit) || 0,
        hasMore: view.tripsPage.hasMore === true,
        nextCursor: isNonEmptyString(view.tripsPage.nextCursor) ? view.tripsPage.nextCursor : null
      } : { limit: 0, hasMore: false, nextCursor: null }
    };
  }

  // Проверка серверного контекста до публикации в state: чужая/битая форма не
  // должна попасть в журнал как «нормальная» карточка.
  function normalizeContext(view) {
    if (!isRecord(view)) return { ok: false, code: 'invalid-api-response', status: 0 };
    if (!isNonEmptyString(view.restoredContextId)) return { ok: false, code: 'invalid-api-response', status: 0 };
    if (!isNonEmptyString(view.archiveId)) return { ok: false, code: 'invalid-api-response', status: 0 };
    if (!revision(view.contextRevision) || !revision(view.baseArchiveRevision)) {
      return { ok: false, code: 'invalid-api-response', status: 0 };
    }
    if (typeof view.baseArchiveSha256 !== 'string' || !SHA_RE.test(view.baseArchiveSha256)) {
      return { ok: false, code: 'invalid-api-response', status: 0 };
    }
    if (!isRecord(view.shiftSnapshot) || !isNonEmptyString(view.shiftSnapshot.objectId)) {
      return { ok: false, code: 'invalid-api-response', status: 0 };
    }
    if (!Array.isArray(view.trips)) return { ok: false, code: 'invalid-api-response', status: 0 };
    if (view.ttn !== undefined && !Array.isArray(view.ttn)) return { ok: false, code: 'invalid-api-response', status: 0 };
    const normalized = Object.assign({}, view, {
      trips: view.trips.slice(),
      ttn: Array.isArray(view.ttn) ? view.ttn.slice() : []
    });
    return { ok: true, view: normalized };
  }

  function cardOf(view) {
    const context = contextOf(view);
    const snapshot = isRecord(view.shiftSnapshot) ? view.shiftSnapshot : {};
    const shiftId = context.restoredContextId;
    const logs = [];
    for (const row of view.trips || []) {
      const trip = tripOf(row, shiftId);
      if (trip) logs.push(trip);
    }
    const ttn = [];
    for (const row of view.ttn || []) {
      const entry = ttnOf(row);
      if (entry) ttn.push(entry);
    }
    const startDate = ruDate(snapshot.workDate);
    return {
      shift: {
        id: shiftId,
        restored: true,
        restoredContextId: shiftId,
        archiveId: context.archiveId,
        sourceShiftId: context.sourceShiftId,
        objectId: snapshot.objectId,
        objectName: isNonEmptyString(snapshot.objectName) ? snapshot.objectName : snapshot.objectId,
        startDate,
        date: startDate,
        openedAt: snapshot.openedAt === undefined ? null : snapshot.openedAt,
        openedByUid: snapshot.openedByUid === undefined ? null : snapshot.openedByUid,
        openedByName: snapshot.openedByName === undefined ? null : snapshot.openedByName,
        shiftType: snapshot.shiftType === undefined ? null : snapshot.shiftType,
        isActive: false
      },
      logs,
      ttn,
      provenance: isRecord(view.provenance) ? view.provenance : null,
      readOnly: context.contextState !== 'open',
      context
    };
  }

  // Команда правки: CAS берётся ТОЛЬКО из фактически прочитанного контекста.
  // Поля правки уходят на верхнем уровне тела (`fields`), как ждёт сервер
  // (`archive-restored-v2.mjs`, урок 68).
  function commandFor(card, input) {
    const command = input || {};
    const context = card && card.context;
    if (!isRecord(context)) return { ok: false, code: 'invalid-restored-context' };
    const type = command.type;
    if (!CORRECTION_TYPES.includes(type)) return { ok: false, code: 'archive-operation-not-allowed' };
    if (!isNonEmptyString(command.operationId)) return { ok: false, code: 'operation-id-required' };
    if (!isNonEmptyString(command.recordId)) return { ok: false, code: 'invalid-command' };
    const payload = {
      operationId: command.operationId,
      archiveId: context.archiveId,
      restoredContextId: context.restoredContextId,
      type,
      recordId: command.recordId,
      expectedContextRevision: context.contextRevision,
      expectedBaseArchiveRevision: context.baseArchiveRevision,
      expectedBaseSha256: context.baseArchiveSha256
    };
    if (type === 'trip.update') {
      const fields = isRecord(command.fields) ? command.fields : {};
      const volume = Number(fields.volume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 1000) return { ok: false, code: 'invalid-volume' };
      if (typeof fields.timeStr !== 'string' || !TIME_RE.test(fields.timeStr)) return { ok: false, code: 'invalid-time' };
      const comment = typeof fields.comment === 'string' ? fields.comment : '';
      if (comment.length > 2000) return { ok: false, code: 'invalid-comment' };
      payload.fields = { volume, timeStr: fields.timeStr, comment };
    } else if (type === 'ttn.update') {
      const status = isRecord(command.fields) ? command.fields.ttnStatus : undefined;
      if (status !== 'pending' && status !== true) return { ok: false, code: 'invalid-ttn' };
      payload.fields = { ttnStatus: status };
    }
    return { ok: true, input: payload };
  }

  function replaceTrip(logs, result) {
    const id = result.recordId;
    if (!isNonEmptyString(id)) return logs;
    if (result.type === 'trip.delete') return logs.filter(log => log.id !== id);
    if (result.type !== 'trip.update' || !isRecord(result.log)) return logs;
    const next = tripOf({ logId: id, truckId: result.log.truckId, payload: result.log }, result.log.shiftId || '');
    return logs.map(log => {
      if (log.id !== id) return log;
      const merged = Object.assign({}, log, result.log);
      return Object.assign(merged, {
        id,
        truckId: isNonEmptyString(result.log.truckId) ? result.log.truckId : log.truckId,
        shiftId: log.shiftId,
        restoredContextId: log.restoredContextId,
        volume: next ? next.volume : log.volume,
        timeStr: next ? next.timeStr : log.timeStr,
        timestamp: next ? next.timestamp : log.timestamp,
        comment: next ? next.comment : log.comment,
        logRevision: log.logRevision + 1
      });
    });
  }

  function replaceTtn(rows, result) {
    if (!isRecord(result.ttn) || !isNonEmptyString(result.ttn.truckId)) return rows;
    const truckId = result.ttn.truckId;
    const status = result.ttn.ttnStatus === true ? true : (result.ttn.ttnStatus === 'pending' ? 'pending' : null);
    let found = false;
    const next = rows.map(row => {
      if (row.truckId !== truckId) return row;
      found = true;
      return Object.assign({}, row, { ttnStatus: status });
    });
    if (!found) next.push({ truckId, ttnStatus: status, ttnRevision: 0 });
    return next;
  }

  // Ответ операции: контекст получил новую ревизию, рейс/ТТН — новое значение.
  // Карточка обновляется локально, поэтому следующий CAS идёт уже по новой
  // ревизии без повторного чтения.
  function applyResult(card, result) {
    if (!isRecord(card) || !isRecord(result)) return card;
    const contextRevision = revision(result.contextRevision);
    const logs = Array.isArray(card.logs) ? replaceTrip(card.logs, result) : [];
    const ttn = Array.isArray(card.ttn) ? replaceTtn(card.ttn, result) : [];
    return Object.assign({}, card, {
      logs,
      ttn,
      context: Object.assign({}, card.context, contextRevision ? { contextRevision } : {})
    });
  }

  function isCompatRefusal(code, status) {
    const numeric = Number(status) || 0;
    if (numeric === 404 || numeric === 405 || numeric === 426 || numeric === 501) return true;
    if (typeof code !== 'string' || !code) return true;
    if (code.startsWith('api-http-')) return true;
    return ['not-found', 'route-not-found', 'method-not-allowed', 'protocol-upgrade-required',
      'protocol-upgrade', 'invalid-api-response', 'v2-transport-failure', 'request-failed',
      'archive-restore-requires-v2', 'shift-not-visible'].includes(code);
  }

  // Текст отказа восстановления. Пользователь не должен видеть `api-http-409`:
  // либо конкретная причина, либо прежний честный отказ.
  function refusalFor(code, status) {
    if (Object.prototype.hasOwnProperty.call(DOMAIN_REFUSALS, code)) {
      return { text: DOMAIN_REFUSALS[code], compat: false };
    }
    if (isCompatRefusal(code, status)) return { text: COMPAT_REFUSAL, compat: true };
    return { text: 'Не удалось восстановить архивную смену: смена не создана, данные архива не изменены. Повторите позже.', compat: false };
  }

  function correctionText(code, status) {
    if (Object.prototype.hasOwnProperty.call(CORRECTION_REFUSALS, code)) return CORRECTION_REFUSALS[code];
    if (isCompatRefusal(code, status)) {
      return 'Сервер не поддерживает правку восстановленной смены. Обновите приложение или обратитесь к администратору: данные не изменены.';
    }
    return 'Не удалось сохранить правку восстановленной смены: данные не изменены. Повторите позже.';
  }

  function finalizeText(card) {
    if (card && card.context && card.context.contextState !== 'open') return FINALIZED_NOTICE;
    return FINALIZE_UNAVAILABLE;
  }

  const api = {
    COMPAT_REFUSAL,
    FINALIZE_UNAVAILABLE,
    FINALIZED_NOTICE,
    CORRECTION_TYPES,
    isoDate,
    ruDate,
    normalizeContext,
    cardOf,
    commandFor,
    applyResult,
    isCompatRefusal,
    refusalFor,
    correctionText,
    finalizeText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestArchiveRestoredV2 = api;
})(typeof window !== 'undefined' ? window : globalThis);
