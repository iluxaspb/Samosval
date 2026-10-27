/* Local-only Firebase operation diagnostics for the TEST app.
   Records app-initiated SDK calls and subscription outcomes without writing to Firestore.
   This is diagnostic telemetry, not an exact billing counter. */
(function () {
  'use strict';

  const PROJECT = (() => {
    try { return firebase.app().options.projectId || 'unknown'; } catch (_) { return 'unknown'; }
  })();
  const KEY = 'samosval.firebase-auditor.v1.' + PROJECT;
  const MAX = 1200;
  let enabled = false;
  let entries = [];
  let installed = false;

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
      entries = Array.isArray(saved.entries) ? saved.entries.slice(-MAX) : [];
      enabled = saved.enabled === true;
    } catch (_) { entries = []; enabled = false; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ enabled, entries: entries.slice(-MAX) })); } catch (_) {}
  }
  function collection(path) {
    if (typeof path !== 'string') return '';
    return path.split('/').filter((part, i) => i % 2 === 0).join('/');
  }
  function add(type, ref, result, extra) {
    if (!enabled) return;
    entries.push({
      at: new Date().toISOString(),
      type,
      collection: collection(ref && (ref.path || (ref._query && ref._query.path && ref._query.path.canonicalString()))),
      result: result || '',
      online: navigator.onLine !== false,
      ...(extra || {})
    });
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    save();
    render();
  }
  function wrapPromise(proto, method, event, getRef) {
    if (!proto || typeof proto[method] !== 'function' || proto[method].__firebaseAuditor) return;
    const original = proto[method];
    function wrapped(...args) {
      const ref = getRef ? getRef(this, args) : this;
      if (enabled) add(event, ref, 'started');
      let value;
      try { value = original.apply(this, args); }
      catch (error) { add(event, ref, 'error:' + (error && error.code || 'exception')); throw error; }
      if (!value || typeof value.then !== 'function') return value;
      return value.then(
        result => { add(event, ref, 'ok'); return result; },
        error => { add(event, ref, 'error:' + (error && error.code || 'rejected')); throw error; }
      );
    }
    wrapped.__firebaseAuditor = true;
    proto[method] = wrapped;
  }
  function wrapSubscription(proto) {
    if (!proto || typeof proto.onSnapshot !== 'function' || proto.onSnapshot.__firebaseAuditor) return;
    const original = proto.onSnapshot;
    function wrapped(...args) {
      const ref = this;
      const callbacks = args.slice();
      let cbIndex = callbacks.findIndex(v => typeof v === 'function');
      if (cbIndex >= 0) {
        const next = callbacks[cbIndex];
        callbacks[cbIndex] = function (snapshot) {
          add('subscription-update', ref, 'ok', { fromCache: !!(snapshot && snapshot.metadata && snapshot.metadata.fromCache) });
          return next.apply(this, arguments);
        };
      } else if (callbacks[0] && typeof callbacks[0] === 'object') {
        const observer = callbacks[0];
        callbacks[0] = Object.assign({}, observer);
        if (typeof observer.next === 'function') callbacks[0].next = function (snapshot) {
          add('subscription-update', ref, 'ok', { fromCache: !!(snapshot && snapshot.metadata && snapshot.metadata.fromCache) });
          return observer.next.apply(this, arguments);
        };
        if (typeof observer.error === 'function') callbacks[0].error = function (error) {
          add('subscription-update', ref, 'error:' + (error && error.code || 'rejected'));
          return observer.error.apply(this, arguments);
        };
      }
      add('subscription-start', ref, 'started');
      try {
        const unsubscribe = original.apply(this, callbacks);
        return function () { add('subscription-stop', ref, 'stopped'); return unsubscribe.apply(this, arguments); };
      } catch (error) {
        add('subscription-start', ref, 'error:' + (error && error.code || 'exception'));
        throw error;
      }
    }
    wrapped.__firebaseAuditor = true;
    proto.onSnapshot = wrapped;
  }
  function installHooks() {
    if (installed || !window.firebase || !firebase.firestore) return;
    const api = firebase.firestore;
    const doc = api.DocumentReference && api.DocumentReference.prototype;
    const query = api.Query && api.Query.prototype;
    const batch = api.WriteBatch && api.WriteBatch.prototype;
    const tx = api.Transaction && api.Transaction.prototype;
    wrapPromise(doc, 'get', 'document-read');
    wrapPromise(query, 'get', 'query-read');
    for (const method of ['set', 'update', 'delete']) wrapPromise(doc, method, 'document-' + method);
    wrapPromise(batch, 'commit', 'batch-commit');
    wrapPromise(tx, 'get', 'transaction-read');
    for (const method of ['set', 'update', 'delete']) {
      if (!tx || typeof tx[method] !== 'function' || tx[method].__firebaseAuditor) continue;
      const original = tx[method];
      const wrapped = function (...args) {
        const result = original.apply(this, args);
        add('transaction-' + method, args[0], 'queued');
        return result;
      };
      wrapped.__firebaseAuditor = true;
      tx[method] = wrapped;
    }
    wrapSubscription(doc);
    wrapSubscription(query);
    if (api.Firestore && api.Firestore.prototype) {
      wrapPromise(api.Firestore.prototype, 'runTransaction', 'transaction');
    }
    installed = true;
    add('auditor', null, 'hooks-ready');
  }
  function download(kind) {
    const rows = entries.slice();
    let text, mime, name;
    if (kind === 'csv') {
      const fields = ['at', 'type', 'collection', 'result', 'online', 'fromCache'];
      const q = value => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
      text = [fields.join(','), ...rows.map(row => fields.map(field => q(row[field])).join(','))].join('\r\n');
      mime = 'text/csv;charset=utf-8'; name = 'firebase-auditor-' + PROJECT + '.csv';
    } else {
      text = JSON.stringify({ projectId: PROJECT, diagnosticOnly: true, exactBillingCounter: false, entries: rows }, null, 2);
      mime = 'application/json;charset=utf-8'; name = 'firebase-auditor-' + PROJECT + '.json';
    }
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function render() {
    const panel = document.getElementById('firebase-auditor-panel');
    if (!panel) return;
    const toggle = panel.querySelector('[data-auditor-enabled]');
    const count = panel.querySelector('[data-auditor-count]');
    if (toggle) toggle.checked = enabled;
    if (count) count.textContent = entries.length + ' записей · локально · Firestore не вызывается';
  }
  function mount() {
    const admin = document.getElementById('admin-sub-console');
    if (!admin || document.getElementById('firebase-auditor-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'firebase-auditor-panel';
    panel.style.cssText = 'margin:12px 0;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--card);color:var(--text);';
    panel.innerHTML = '<div style="font-weight:800;margin-bottom:8px">🧭 Аудитор Firebase · тест</div>' +
      '<label style="display:flex;gap:8px;align-items:center;margin:8px 0"><input type="checkbox" data-auditor-enabled> Собирать локальные диагностические события</label>' +
      '<div data-auditor-count style="font-size:11px;color:var(--muted);margin:6px 0"></div>' +
      '<div style="font-size:11px;color:var(--muted);line-height:1.4;margin:6px 0">Фиксируются вызовы приложения, результаты чтения/записи, подписки и переподключения. Содержимое документов и идентификаторы не сохраняются. Это не счётчик биллинга.</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" data-auditor-json>Экспорт JSON</button><button type="button" data-auditor-csv>Экспорт CSV</button><button type="button" data-auditor-clear>Очистить локальный журнал</button></div>';
    admin.insertBefore(panel, admin.firstChild);
    panel.addEventListener('change', event => {
      if (event.target.matches('[data-auditor-enabled]')) { enabled = event.target.checked; save(); render(); }
    });
    panel.addEventListener('click', event => {
      if (event.target.closest('[data-auditor-json]')) download('json');
      if (event.target.closest('[data-auditor-csv]')) download('csv');
      if (event.target.closest('[data-auditor-clear]') && window.confirm('Очистить локальный журнал диагностики?')) { entries = []; save(); render(); }
    });
    render();
  }

  load();
  if (navigator.onLine === false) add('connection', null, 'offline');
  window.addEventListener('online', () => add('connection', null, 'online'));
  window.addEventListener('offline', () => add('connection', null, 'offline'));
  installHooks();
  if (!installed) {
    let attempts = 0;
    const timer = setInterval(() => { installHooks(); if (installed || ++attempts > 20) clearInterval(timer); }, 100);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();