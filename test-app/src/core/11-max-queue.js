  // === MAX QUEUE (text notifications only) ===
  const MAX_QUEUE_KEY = 'dt_max_queue:' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + location.pathname + ':';
  const MAX_QUEUE_MAX = 100; const MAX_TRIES = 5;
  let maxQueue = []; let maxQueueScope = ''; let maxSenderRunning = false; let maxSeq = 0; let maxLastError = '';
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function maxQueueSessionKey() { return currentUid ? MAX_QUEUE_KEY + currentUid : ''; }
  function loadMaxQueue() {
    maxQueueScope = maxQueueSessionKey(); maxLastError = '';
    // The old unscoped key can belong to production or another account. Never import it.
    try { maxQueue = maxQueueScope ? JSON.parse(localStorage.getItem(maxQueueScope) || '[]') : []; } catch(e) { maxQueue = []; }
    maxQueue = (Array.isArray(maxQueue) ? maxQueue : []).filter(item => item && item.type === 'text' && typeof item.text === 'string').slice(-MAX_QUEUE_MAX);
    maxQueue.forEach(item => { item.tries = Number.isFinite(item.tries) && item.tries >= 0 ? item.tries : 0; item.notBefore = Number.isFinite(item.notBefore) ? item.notBefore : 0; });
    saveMaxQueue();
  }
  function ensureMaxQueueSession() { if (maxQueueScope !== maxQueueSessionKey()) loadMaxQueue(); }
  function saveMaxQueue(queue = maxQueue, key = maxQueueScope) {
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(queue)); }
    catch(e) { if (e.name === 'QuotaExceededError' || e.code === 22) { while (queue.length) { queue.shift(); try { localStorage.setItem(key, JSON.stringify(queue)); return; } catch(e2) {} } } }
  }
  function enqueueMax(text, meta, notBefore) {
    if (currentUserStatus !== 'active' || !currentUid || !appConfig.maxEnabled || !appConfig.maxUrl || typeof text !== 'string') return;
    ensureMaxQueueSession();
    maxQueue.push({ id: 'q_' + Date.now() + '_' + (++maxSeq), type: 'text', text, tries: 0, createdAt: Date.now(), notBefore: Number.isFinite(notBefore) ? notBefore : 0, meta: meta || null });
    while (maxQueue.length > MAX_QUEUE_MAX) maxQueue.shift(); saveMaxQueue(); runMaxQueue();
  }
  async function sendMaxOnce(item) {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') return 'drop';
    if (currentUserStatus !== 'active' || !currentUid || !appConfig.maxEnabled || !appConfig.maxUrl) return 'drop';
    const headers = { 'Content-Type': 'application/json' };
    if (appConfig.maxToken) { const tk = String(appConfig.maxToken).trim(); headers.Authorization = tk.startsWith('Bearer ') ? tk : 'Bearer ' + tk; }
    const body = { chat_id: appConfig.maxChatId || '', text: item.text };
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const resp = await fetch(appConfig.maxUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal, keepalive: true });
      if (resp.ok) return 'ok'; if (resp.status === 413) return 'too_large'; if (resp.status === 429 || resp.status >= 500) return 'retry'; if (resp.status === 401 || resp.status === 403) return 'auth'; return 'http_' + resp.status;
    } catch(e) { return 'retry'; }
    finally { clearTimeout(timer); }
  }
  async function runMaxQueue() {
    ensureMaxQueueSession();
    if (currentUserStatus !== 'active' || !currentUid || maxSenderRunning || !appConfig.maxEnabled || !appConfig.maxUrl) return;
    const queue = maxQueue, scope = maxQueueScope;
    maxSenderRunning = true;
    try {
      while (queue.length && currentUserStatus === 'active' && maxQueueSessionKey() === scope && appConfig.maxEnabled && appConfig.maxUrl) {
        const idx = queue.findIndex(q => !q.notBefore || q.notBefore <= Date.now());
        if (idx === -1) break;
        const item = queue[idx];
        if (!item || item.type !== 'text' || typeof item.text !== 'string') { queue.splice(idx, 1); saveMaxQueue(queue, scope); continue; }
        const res = await sendMaxOnce(item);
        // A successful request still belongs to the original account if auth changed in flight.
        if (res === 'ok') { const sentIndex = queue.indexOf(item); if (sentIndex >= 0) queue.splice(sentIndex, 1); saveMaxQueue(queue, scope); await sleep(1200 + Math.floor(Math.random() * 600)); continue; }
        if (maxQueueSessionKey() !== scope || currentUserStatus !== 'active') break;
        if (res === 'retry' && item.tries < MAX_TRIES) { item.tries++; saveMaxQueue(queue, scope); await sleep(Math.min(30000, 2000 * Math.pow(2, item.tries))); continue; }
        const failedIndex = queue.indexOf(item); if (failedIndex >= 0) queue.splice(failedIndex, 1); saveMaxQueue(queue, scope);
        if (res === 'drop') continue;
        const reason = res === 'auth' ? 'токен (401)' : res === 'too_large' ? 'размер (413)' : res === 'retry' ? 'сервер недоступен после повторов' : 'код ' + res;
        maxLastError = reason; showToastEl('⚠️ MAX: не отправлено — ' + reason, true);
      }
    } finally {
      maxSenderRunning = false;
      if (maxQueueSessionKey() !== scope) { ensureMaxQueueSession(); if (currentUserStatus === 'active') setTimeout(runMaxQueue, 0); }
      else if (maxQueue.length) { const pending = maxQueue.filter(q => q.notBefore && q.notBefore > Date.now()); if (pending.length) setTimeout(runMaxQueue, Math.max(5000, Math.min(...pending.map(q => q.notBefore)) - Date.now())); }
    }
  }
  function showMaxQueueStatus() { ensureMaxQueueSession(); const lines = ['── ОЧЕРЕДЬ MAX ──', `Отправка: ${appConfig.maxEnabled ? 'вкл' : 'выкл'}`, `В очереди: ${maxQueue.length}`]; if (maxLastError) lines.push(`Ошибка: ${maxLastError}`); appNotice(lines.join('\n')); }
  async function testMaxMessage() {
    if (!canAdmin()) return;
    if (!appConfig.maxEnabled || !appConfig.maxUrl || !appConfig.maxChatId) { showError('Заполните URL, токен и Chat ID'); return; }
    showToastEl('⏳ Отправка теста...', false);
    const res = await sendMaxOnce({ type: 'text', text: '🧪 Тест\nПриложение «Учет самосвалов» подключено к Max.' });
    if (res === 'ok') showToastEl('✅ Сообщение отправлено', false); else showError('Ошибка: ' + res);
  }
