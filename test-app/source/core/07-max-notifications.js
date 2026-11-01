  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  // Этот модуль принадлежит test-app: load никогда не отправляется во внешний Max.
  function isMaxTestLoad(item) {
    return item?.meta?.eventType === 'load' || item?.meta?.type === 'load'
      || /Погрузка/i.test(String(item?.text || '')) || !!item?.meta?.logId;
  }
  function captureMaxTestLoad(item) {
    if (!isMaxTestLoad(item)) return false;
    const key = 'dt_max_local_loads_test_v1';
    const source = item.meta || {};
    let loc = null;
    if (source.location && typeof source.location === 'object') {
      try { loc = JSON.parse(JSON.stringify(source.location)); } catch(_) { loc = Object.assign({}, source.location); }
      const coords = loc.rawCoords || loc.coordinates || null;
      if (coords && !loc.rawCoords) loc.rawCoords = coords;
      if (coords && !loc.coordinates) loc.coordinates = coords;
      if (loc.calibrated === undefined) {
        loc.calibrated = !!(loc.stationFormatted || Number.isFinite(loc.currentStation));
      }
      if (loc.stationFormatted === undefined) {
        loc.stationFormatted = typeof source.station === 'string' && source.station.startsWith('ПК') ? source.station : null;
      }
      if (loc.currentStation === undefined) {
        loc.currentStation = Number.isFinite(source.station) ? source.station : null;
      }
    }
    const stationVal = source.station !== undefined && source.station !== null
      ? source.station
      : (loc?.stationFormatted ?? (Number.isFinite(loc?.currentStation) ? loc.currentStation : (loc?.station ?? null)));
    const meta = {
      eventType: 'load',
      operationId: source.operationId || '',
      logId: source.logId || '',
      truckId: source.truckId || '',
      station: stationVal,
      location: loc
    };
    const id = meta.operationId || meta.logId || item.id || ('local_' + Date.now() + '_' + Math.random().toString(36).slice(2));
    const history = window.getMaxLocalLoadHistory();
    const isDup = history.some(entry => {
      if (entry.id === id) return true;
      if (meta.operationId && (entry.id === meta.operationId || entry.meta?.operationId === meta.operationId)) return true;
      if (meta.logId && (entry.id === meta.logId || entry.meta?.logId === meta.logId)) return true;
      return false;
    });
    if (isDup) return true;
    const stationText = meta.station !== null && meta.station !== undefined ? String(meta.station) : (meta.location?.stationFormatted || null);
    const details = stationText ? '\nПК: ' + stationText : '';
    const coords = meta.location?.rawCoords || meta.location?.coordinates || meta.location;
    const gps = coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon) ? '\nGPS: ' + coords.lat.toFixed(6) + ', ' + coords.lon.toFixed(6) : '';
    const calibInfo = meta.location?.calibrated === false
      ? '\n(непривязанный GPS)'
      : (meta.location?.stationFormatted && !details.includes(meta.location.stationFormatted) ? '\n' + meta.location.stationFormatted : '');
    history.push({ id, timestamp: Date.now(), status: 'local_only', text: String(item.text || '') + details + gps + calibInfo, meta });
    try { localStorage.setItem(key, JSON.stringify(history.slice(-500))); } catch(e) { console.warn('[Max test load history]', e); }
    return true;
  }
  window.getMaxLocalLoadHistory = function() {
    try { const data = JSON.parse(localStorage.getItem('dt_max_local_loads_test_v1') || '[]'); return Array.isArray(data) ? data : []; } catch(e) { return []; }
  };
  window.captureMaxTestLoad = captureMaxTestLoad;
  function loadMaxQueue() {
    try { maxQueue=JSON.parse(localStorage.getItem(MAX_QUEUE_KEY)||'[]'); } catch(e) { maxQueue=[]; }
    maxQueue=(Array.isArray(maxQueue)?maxQueue:[]).filter(item=>item&&item.type==='text'&&typeof item.text==='string');
    saveMaxQueue();
  }
  function saveMaxQueue() { try { localStorage.setItem(MAX_QUEUE_KEY, JSON.stringify(maxQueue)); } catch(e) { if (e.name === 'QuotaExceededError' || e.code === 22) { while (maxQueue.length > 0) { const idx = maxQueue.findIndex(q => q.type === 'document'); if (idx === -1) maxQueue.shift(); else maxQueue.splice(idx, 1); try { localStorage.setItem(MAX_QUEUE_KEY, JSON.stringify(maxQueue)); return; } catch(e2) {} } } } }
  function enqueueMax(text, meta, notBefore) { if(captureMaxTestLoad({text,meta}))return; if(isNasRuntime())return; if (!appConfig.maxEnabled || !appConfig.maxUrl) return; maxQueue.push({ id: 'q_' + Date.now() + '_' + (++maxSeq), type: 'text', text, tries: 0, createdAt: Date.now(), notBefore: notBefore || 0, meta: meta || null }); while (maxQueue.length > MAX_QUEUE_MAX) maxQueue.shift(); saveMaxQueue(); runMaxQueue(); }
  async function sendMaxOnce(item) {
    if (captureMaxTestLoad(item)) return 'ok';
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
  const MAX_TEST_HISTORY_KEY = 'dt_max_test_history_v1';
  function getMaxTestHistory() {
    try {
      const raw = localStorage.getItem(MAX_TEST_HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch(e) { return []; }
  }
  function recordMaxTestResult(result, text) {
    try {
      const hist = getMaxTestHistory();
      hist.unshift({
        id: 'mth_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        timestamp: Date.now(),
        timeStr: new Date().toLocaleString('ru-RU'),
        result: String(result || 'unknown'),
        text: String(text || '').slice(0, 100),
        user: typeof getUserName === 'function' ? getUserName() : (window.currentEmail || 'admin')
      });
      while (hist.length > 20) hist.pop();
      localStorage.setItem(MAX_TEST_HISTORY_KEY, JSON.stringify(hist));
    } catch(e) {}
  }
  function clearMaxTestHistory() {
    try { localStorage.removeItem(MAX_TEST_HISTORY_KEY); } catch(e) {}
  }
  window.getMaxTestHistory = getMaxTestHistory;
  window.clearMaxTestHistory = clearMaxTestHistory;

  async function showMaxQueueStatus() {
    if(isNasRuntime()){try{const r=await nasRuntimeClient.readNotifications();appNotice('── ОЧЕРЕДЬ MAX · Synology ──\n'+Object.entries(r.counts).map(([k,v])=>k+': '+v).join('\n'));}catch(e){showError(e.message);}return;}
    let lines = ['── ОЧЕРЕДЬ MAX ──', `Отправка: ${appConfig.maxEnabled ? 'вкл' : 'выкл'}`, `В очереди: ${maxQueue.length}`];
    if (maxLastError) lines.push(`Ошибка: ${maxLastError}`);
    const hist = getMaxTestHistory();
    if (hist.length > 0) {
      lines.push('── ИСТОРИЯ ТЕСТОВ (безопасный буфер) ──');
      hist.slice(0, 3).forEach(h => lines.push(`• ${h.timeStr}: [${h.result}] ${h.user}`));
    }
    appNotice(lines.join('\n'));
  }
  async function testMaxMessage() {
    if (!canAdmin()) return;
    if(isNasRuntime()){
      try{
        await nasBusinessCommand('notification','test',{type:'notification.test'});
        recordMaxTestResult('queued_synology', 'Тест в очередь Synology');
        showToastEl('✅ Тест поставлен в очередь Synology',false);
      }catch(e){
        recordMaxTestResult('error_synology: ' + (e.message || e), 'Ошибка Synology');
        showError(e.message);
      }
      return;
    }
    if (!appConfig.maxEnabled || !appConfig.maxUrl || !appConfig.maxChatId) {
      recordMaxTestResult('unconfigured', 'Max не настроен (URL/ChatId)');
      showError('Заполните URL, токен и Chat ID');
      return;
    }
    showToastEl('⏳ Отправка теста...', false);
    const testText = '🧪 Тест\nПриложение «Учет самосвалов» подключено к Max.';
    let res = await sendMaxOnce({ type: 'text', text: testText });
    recordMaxTestResult(res, testText);
    if (res === 'ok') showToastEl('✅ Сообщение отправлено', false); else showError('Ошибка: ' + res);
  }

  // === ОТЧЁТЫ PNG ===
