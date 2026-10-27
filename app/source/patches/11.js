(function(){
  if (window.__maxRetryV1) return;
  window.__maxRetryV1 = true;

  const REQUEST_TIMEOUT_MS = 60000;
  const WARMUP_TIMEOUT_MS = 90000;
  const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
  const LAST_SUCCESS_KEY = 'dt_max_last_success';
  const LAST_WARMUP_KEY = 'dt_max_last_warmup';
  const CONFIG_CACHE_MS = 30000;

  let cachedConfig = null;
  let cachedConfigAt = 0;
  let warmupInFlight = null;

  function getTs(key) {
    try { return parseInt(localStorage.getItem(key) || '0') || 0; } catch(e) { return 0; }
  }
  function setTs(key, v) {
    try { localStorage.setItem(key, String(v || Date.now())); } catch(e) {}
  }

  async function getConfig() {
    const now = Date.now();
    if (cachedConfig && (now - cachedConfigAt) < CONFIG_CACHE_MS) {
      return cachedConfig;
    }
    try {
      const doc = await firebase.firestore().collection('settings').doc('appConfig').get();
      if (doc.exists) {
        cachedConfig = doc.data();
        cachedConfigAt = now;
        return cachedConfig;
      }
    } catch(e) {
      console.warn('[MAX] Config read failed:', e.message);
    }
    return cachedConfig || {};
  }

  async function warmUpServer(url) {
    if (warmupInFlight) return warmupInFlight;
    if (!url) return false;

    warmupInFlight = (async () => {
      console.log('[MAX] 🔥 Warm-up: бужу сервер...');
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), WARMUP_TIMEOUT_MS);
        await fetch(url, {
          method: 'GET',
          signal: ctrl.signal,
          cache: 'no-store',
          keepalive: true
        });
        clearTimeout(timer);
        console.log('[MAX] ✅ Warm-up: сервер проснулся');
        setTs(LAST_WARMUP_KEY, Date.now());
        return true;
      } catch(e) {
        console.warn('[MAX] ❌ Warm-up failed:', e.name || e.message);
        return false;
      } finally {
        warmupInFlight = null;
      }
    })();

    return warmupInFlight;
  }

  window.sendMaxOnce = async function(item) {
    if (!item || item.type !== 'text') return 'drop';
    const cfg = await getConfig();
    if (!cfg.maxEnabled || !cfg.maxUrl) return 'drop';

    const url = cfg.maxUrl;
    const token = cfg.maxToken || '';
    const chatId = cfg.maxChatId || '';

    const lastSuccess = getTs(LAST_SUCCESS_KEY);
    const lastWarmup = getTs(LAST_WARMUP_KEY);
    const idle = Date.now() - lastSuccess;
    const sinceWarmup = Date.now() - lastWarmup;

    if (idle > IDLE_THRESHOLD_MS && sinceWarmup > 60000) {
      console.log(`[MAX] ⏰ Idle ${Math.round(idle/1000)}s — warm-up перед отправкой`);
      const ok = await warmUpServer(url);
      if (!ok) {
        console.warn('[MAX] Warm-up неудачен — retry');
        return 'retry';
      }
      await new Promise(r => setTimeout(r, 1000));
    }

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
        setTs(LAST_SUCCESS_KEY, Date.now());
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
})();