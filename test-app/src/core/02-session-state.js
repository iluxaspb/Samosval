  const FORCED_ADMIN_EMAIL = 'iluxaspb@gmail.com';

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

