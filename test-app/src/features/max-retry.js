try { (function(){
  if (window.__maxRetryV1) return;
  window.__maxRetryV1 = true;

  const REQUEST_TIMEOUT_MS = 60000;
  const WARMUP_TIMEOUT_MS = 90000;
  const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
  const LAST_SUCCESS_KEY = 'dt_max_last_success';
  const LAST_WARMUP_KEY = 'dt_max_last_warmup';
  let warmupInFlight = null;
  function timestampKey(key, url) { return key + ':' + firebaseConfig.projectId + ':' + WORKSPACE_ID + ':' + location.pathname + ':' + currentUid + ':' + url; }
  function getTs(key) { try { return parseInt(localStorage.getItem(key) || '0') || 0; } catch(e) { return 0; } }
  function setTs(key, value) { try { localStorage.setItem(key, String(value || Date.now())); } catch(e) {} }

  async function warmUpServer(url, stampKey) {
    if (warmupInFlight) return warmupInFlight;
    if (!url) return false;

    warmupInFlight = (async () => {
      console.log('[MAX] 🔥 Warm-up: бужу сервер...');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), WARMUP_TIMEOUT_MS);
      try {
        await fetch(url, {
          method: 'GET',
          signal: ctrl.signal,
          cache: 'no-store',
          keepalive: true
        });
        console.log('[MAX] ✅ Warm-up: сервер проснулся');
        setTs(stampKey, Date.now());
        return true;
      } catch(e) {
        console.warn('[MAX] ❌ Warm-up failed:', e.name || e.message);
        return false;
      } finally {
        clearTimeout(timer);
        warmupInFlight = null;
      }
    })();

    return warmupInFlight;
  }

  window.sendMaxOnce = async function(item) {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') return 'drop';
    if (!currentUid || currentUserStatus !== 'active') return 'drop';
    const cfg = { ...appConfig }, uid = currentUid;
    if (!cfg.maxEnabled || !cfg.maxUrl) return 'drop';
    const sameSession = () => currentUid === uid && currentUserStatus === 'active' && appConfig.maxEnabled && appConfig.maxUrl === cfg.maxUrl && appConfig.maxChatId === cfg.maxChatId && appConfig.maxToken === cfg.maxToken;

    const url = cfg.maxUrl;
    const token = cfg.maxToken || '';
    const chatId = cfg.maxChatId || '';

    const successKey = timestampKey(LAST_SUCCESS_KEY, url), warmupKey = timestampKey(LAST_WARMUP_KEY, url);
    const lastSuccess = getTs(successKey);
    const lastWarmup = getTs(warmupKey);
    const idle = Date.now() - lastSuccess;
    const sinceWarmup = Date.now() - lastWarmup;

    if (idle > IDLE_THRESHOLD_MS && sinceWarmup > 60000) {
      console.log(`[MAX] ⏰ Idle ${Math.round(idle/1000)}s — warm-up перед отправкой`);
      const ok = await warmUpServer(url, warmupKey);
      if (!ok) {
        console.warn('[MAX] Warm-up неудачен — retry');
        return 'retry';
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!sameSession()) return 'retry';
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      const tk = String(token).trim();
      headers['Authorization'] = tk.startsWith('Bearer ') ? tk : 'Bearer ' + tk;
    }

    const body = { chat_id: chatId, text: item.text };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    try {
      console.log(`[MAX] 📤 Отправка (попытка ${(item.tries || 0) + 1})...`);
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
        keepalive: true
      });
      clearTimeout(timer);

      if (resp.ok) {
        setTs(successKey, Date.now());
        console.log('[MAX] ✅ Отправлено');
        return 'ok';
      }
      if (resp.status === 413) return 'too_large';
      if (resp.status === 429) return 'retry';
      if (resp.status >= 500) {
        console.warn(`[MAX] ⚠️ Server ${resp.status} — retry`);
        return 'retry';
      }
      if (resp.status === 401 || resp.status === 403) return 'auth';
      return 'http_' + resp.status;
    } catch(e) {
      clearTimeout(timer);
      console.warn(`[MAX] ⚠️ ${e.name || e.message} — retry`);
      return 'retry';
    }
  };

  console.log('[MAX] 🔄 Патч ретраев активен. POST: ' + (REQUEST_TIMEOUT_MS/1000) + 's, warm-up: ' + (WARMUP_TIMEOUT_MS/1000) + 's, idle порог: ' + (IDLE_THRESHOLD_MS/60000) + ' мин');
})();; }
catch (e) { console.error('[baked patch: Макс отправка]', e); }
