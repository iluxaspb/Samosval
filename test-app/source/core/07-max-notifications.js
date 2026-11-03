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
  async function showMaxQueueStatus() { if(isNasRuntime()){try{const r=await nasRuntimeClient.readNotifications();appNotice('── ОЧЕРЕДЬ MAX · Synology ──\n'+Object.entries(r.counts).map(([k,v])=>k+': '+v).join('\n'));}catch(e){showError(e.message);}return;} let lines = ['── ОЧЕРЕДЬ MAX ──', `Отправка: ${appConfig.maxEnabled ? 'вкл' : 'выкл'}`, `В очереди: ${maxQueue.length}`]; if (maxLastError) lines.push(`Ошибка: ${maxLastError}`); appNotice(lines.join('\n')); }
  async function testMaxMessage() {
    if (!canAdmin()) return;
    if(isNasRuntime()){try{await nasBusinessCommand('notification','test',{type:'notification.test'});showToastEl('✅ Тест поставлен в очередь Synology',false);}catch(e){showError(e.message);}return;}
    if (!appConfig.maxEnabled || !appConfig.maxUrl || !appConfig.maxChatId) { showError('Заполните URL, токен и Chat ID'); return; }
    showToastEl('⏳ Отправка теста...', false);
    let res = await sendMaxOnce({ type: 'text', text: '🧪 Тест\nПриложение «Учет самосвалов» подключено к Max.' });
    if (res === 'ok') showToastEl('✅ Сообщение отправлено', false); else showError('Ошибка: ' + res);
  }

  // === ОТЧЁТЫ PNG ===
