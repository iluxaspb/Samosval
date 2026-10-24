/* Добавляемый патч: Админ → Патчи → тип «Заменить функцию». Вставить весь файл.
 * PNG не отправляется как PDF/документ: сервер явно подтверждает поддержку image.
 * Не отправляет пробных сообщений, не меняет триггеры и не читает токен бота.
 */
(function () {
  'use strict';
  const KEY = 'MaxPlateNotifications', CONTRACT = 'samosval-max-plate-v1';
  if (window[KEY]) { window[KEY].install(); return; }
  const capabilityCache = new Map(), pngCache = new Map(), inflight = new Map();
  const cfg = () => typeof appConfig === 'object' && appConfig ? appConfig : {};
  const account = () => typeof currentUid === 'string' ? currentUid : '';
  const admin = () => typeof canAdmin === 'function' && canAdmin();
  let status = 'PNG госномера готов. Проверка сервера выполняется перед отправкой.';
  function setStatus(text) { status = text; const el = document.getElementById('maxPlateStatus'); if (el) el.textContent = text; }
  function parsePlate(value) {
    const clean = String(value || '').replace(/[\s\u00a0-]/g, '');
    const m = clean.match(/^([а-яёa-z])(\d{3})([а-яёa-z]{2})(\d{2,3})$/i);
    return m ? { number: clean.toUpperCase(), first: m[1].toLowerCase(), digits: m[2], last: m[3].toLowerCase(), region: m[4] } : null;
  }
  function fromText(text) {
    const found = new Map();
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!/^\s*(?:🚛|🚚|Госномер\s*:)/iu.test(line)) continue;
      const re = /(?:^|[^а-яёa-z0-9])([а-яёa-z]\s*\d{3}\s*[а-яёa-z]{2}\s*\d{2,3})(?=$|[^а-яёa-z0-9])/giu;
      let match; while ((match = re.exec(line))) { const p = parsePlate(match[1]); if (p) found.set(p.number, p); }
    }
    return found.size === 1 ? [...found.values()][0] : null;
  }
  function resolvePlate(item) {
    if (!item || item.type !== 'text') return null;
    // The queued text is authoritative if a truck is renamed before synchronization.
    const snapshot = parsePlate(item.meta?.maxPlateNumber), text = fromText(item.text);
    if (text) return text; if (snapshot) return snapshot;
    if (item.meta?.truckId && typeof findTruck === 'function') return parsePlate(findTruck(item.meta.truckId)?.number);
    return null;
  }
  function rounded(ctx, x, y, width, height, radius) {
    ctx.beginPath(); ctx.moveTo(x + radius, y); ctx.lineTo(x + width - radius, y); ctx.quadraticCurveTo(x + width, y, x + width, y + radius); ctx.lineTo(x + width, y + height - radius); ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height); ctx.lineTo(x + radius, y + height); ctx.quadraticCurveTo(x, y + height, x, y + height - radius); ctx.lineTo(x, y + radius); ctx.quadraticCurveTo(x, y, x + radius, y); ctx.closePath();
  }
  function renderPng(number) {
    const p = parsePlate(number); if (!p) throw Error('Введите госномер, например А123ВС178');
    if (pngCache.has(p.number)) return pngCache.get(p.number);
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 144;
    const ctx = canvas.getContext('2d'); if (!ctx) throw Error('PNG недоступен в этом браузере');
    ctx.fillStyle = '#fff'; rounded(ctx, 4, 4, 592, 136, 16); ctx.fill(); ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 6; ctx.stroke();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1; rounded(ctx, 8, 8, 584, 128, 12); ctx.stroke();
    ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(457, 5); ctx.lineTo(457, 139); ctx.stroke();
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    // Same letter/digit hierarchy, white field, dark frame and region block as ru-plate.
    const parts = [[p.first, 70], [p.digits, 82], [p.last, 70]], gap = 7;
    const widths = parts.map(([text, size]) => { ctx.font = '900 ' + size + 'px Arial, sans-serif'; return ctx.measureText(text).width; });
    const total = widths.reduce((a, b) => a + b, 0) + gap * 2; let x = 231 - total / 2;
    parts.forEach(([text, size], i) => { ctx.font = '900 ' + size + 'px Arial, sans-serif'; ctx.fillText(text, x + widths[i] / 2, 103); x += widths[i] + gap; });
    ctx.font = '900 54px Arial, sans-serif'; ctx.fillText(p.region, 526, 64);
    ctx.font = '700 23px Arial, sans-serif'; ctx.fillText('RUS', 526, 93);
    ctx.fillStyle = '#fff'; ctx.fillRect(502, 102, 48, 9); ctx.fillStyle = '#0039a6'; ctx.fillRect(502, 111, 48, 9); ctx.fillStyle = '#d52b1e'; ctx.fillRect(502, 120, 48, 9); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(502, 102, 48, 27);
    const dataUrl = canvas.toDataURL('image/png'); if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 90000) throw Error('Не удалось подготовить компактный PNG');
    const result = { number: p.number, filename: 'gosnomer-' + p.digits + '-' + p.region + '.png', mime_type: 'image/png', content_base64: dataUrl.split(',')[1], dataUrl };
    pngCache.set(p.number, result); if (pngCache.size > 100) pngCache.delete(pngCache.keys().next().value); return result;
  }
  function authHeaders(config) { const headers = { 'Content-Type': 'application/json' }, token = String(config.maxToken || '').trim(); if (token) headers.Authorization = token.startsWith('Bearer ') ? token : 'Bearer ' + token; return headers; }
  function validEndpoint(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch (_) { return false; } }
  async function capabilities(config, force = false) {
    if (!validEndpoint(config.maxUrl)) { setStatus('Для PNG нужен корректный HTTPS-адрес сервера MAX.'); return false; }
    const key = config.maxUrl, now = Date.now(), cached = capabilityCache.get(key);
    if (!force && cached && now - cached.at < (cached.supported ? 600000 : 60000)) return cached.supported;
    if (inflight.has(key)) return inflight.get(key);
    const pending = (async () => {
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15000); let supported = false;
      try {
        const response = await fetch(key, { method: 'GET', headers: authHeaders(config), signal: ctrl.signal, cache: 'no-store', redirect: 'error' });
        if (response.ok && (response.headers.get('content-type') || '').includes('application/json')) {
          const body = await response.json(); supported = body?.contract === CONTRACT && body?.capabilities?.image_png === true;
        }
      } catch (_) { /* No image POST without an explicit capability acknowledgement. */ }
      finally { clearTimeout(timer); }
      capabilityCache.set(key, { at: Date.now(), supported });
      setStatus(supported ? 'Сервер поддерживает PNG: госномер будет картинкой в уведомлении.' : 'Сервер пока не подтвердил поддержку PNG. Уведомления отправляются прежним текстом.');
      return supported;
    })(); inflight.set(key, pending); try { return await pending; } finally { inflight.delete(key); }
  }
  async function sendImage(item, plate, config) {
    let image;
    try { image = renderPng(plate.number); } catch (_) { return { beforeSend: true }; }
    const requestId = item.id || item.maxPlateRequestId || (item.maxPlateRequestId = 'preview_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '_' + Math.random().toString(36).slice(2)));
    const body = { contract: CONTRACT, request_id: requestId, chat_id: config.maxChatId || '', text: item.text, image: { filename: image.filename, mime_type: image.mime_type, content_base64: image.content_base64 } };
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const response = await fetch(config.maxUrl, { method: 'POST', headers: authHeaders(config), body: JSON.stringify(body), signal: ctrl.signal, redirect: 'error' });
      if (response.ok) { const ack = await response.json(); if (ack?.contract === CONTRACT && ack.success === true && typeof ack.message_id === 'string' && ack.message_id) { try { localStorage.setItem('dt_max_last_success', String(Date.now())); } catch (_) {} return 'ok'; } return 'retry'; }
      if (response.status === 401 || response.status === 403) return 'auth'; if (response.status === 413) return 'too_large'; if (response.status === 429 || response.status >= 500) return 'retry'; return 'http_' + response.status;
    } catch (_) { return 'retry'; }
    finally { clearTimeout(timer); }
    // Never send a second text message after an image POST: its outcome may be uncertain.
  }
  function install() {
    if (typeof window.enqueueMax === 'function' && !window.enqueueMax.__maxPlate) {
      const previous = window.enqueueMax;
      const wrapped = function(text, meta, notBefore) { const plate = resolvePlate({ type: 'text', text, meta }); return previous.call(this, text, plate ? { ...(meta || {}), maxPlateNumber: plate.number } : meta, notBefore); };
      wrapped.__maxPlate = true; window.enqueueMax = wrapped;
    }
    if (typeof window.sendMaxOnce === 'function' && !window.sendMaxOnce.__maxPlate) {
      const previous = window.sendMaxOnce;
      const wrapped = async function(item) {
        const plate = resolvePlate(item), config = { ...cfg() }, uid = account();
        if (!plate || !config.maxEnabled || config.maxPlateEnabled === false || !config.maxUrl) return previous.call(this, item);
        const supported = await capabilities(config);
        // Settings/account may change while a server is waking up.
        const latest = cfg(); if (account() !== uid || latest.maxUrl !== config.maxUrl || latest.maxChatId !== config.maxChatId || latest.maxToken !== config.maxToken || !latest.maxEnabled || latest.maxPlateEnabled === false) return 'retry';
        if (!supported) return previous.call(this, item);
        const result = await sendImage(item, plate, config); return result?.beforeSend ? previous.call(this, item) : result;
      }; wrapped.__maxPlate = true; window.sendMaxOnce = wrapped;
    }
    if (typeof window.applyAllPatches === 'function' && !window.applyAllPatches.__maxPlate) {
      const previous = window.applyAllPatches, wrapped = function() { try { return previous.apply(this, arguments); } finally { install(); } }; wrapped.__maxPlate = true; window.applyAllPatches = wrapped;
    }
    addPanel();
  }
  function preview() {
    if (!admin()) return;
    document.getElementById('maxPlatePreview')?.remove(); const dialog = document.createElement('dialog'); dialog.id = 'maxPlatePreview'; dialog.style.cssText = 'width:min(460px,calc(100vw - 24px));padding:18px;border:1px solid #475569;border-radius:14px;background:#1e293b;color:#f8fafc;max-height:90vh;';
    const title = document.createElement('h3'); title.textContent = 'Госномер в уведомлении MAX'; title.style.cssText = 'font-size:17px;margin-bottom:12px';
    const input = document.createElement('input'); input.value = 'А123ВС178'; input.setAttribute('aria-label', 'Госномер для примера'); input.className = 'form-control'; input.maxLength = 18;
    const card = document.createElement('div'); card.style.cssText = 'margin:14px 0;padding:14px;background:#fff;color:#111827;border-radius:12px';
    const caption = document.createElement('p'); caption.textContent = '⚡ Погрузка'; caption.style.cssText = 'font-size:17px;font-weight:600;margin:0 0 12px';
    const image = document.createElement('img'); image.alt = 'Российский госномер'; image.style.cssText = 'display:block;width:100%;height:auto';
    const hint = document.createElement('p'); hint.textContent = 'Предпросмотр PNG. Сообщение в чат не отправляется.'; hint.style.cssText = 'font-size:12px;color:#94a3b8;margin:10px 0';
    const error = document.createElement('p'); error.setAttribute('role', 'status'); error.style.cssText = 'color:#fca5a5;font-size:12px';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn btn-secondary'; close.textContent = 'Закрыть'; close.onclick = () => dialog.close();
    const update = () => { try { const png = renderPng(input.value); image.src = png.dataUrl; image.alt = 'Госномер ' + png.number; image.hidden = false; error.textContent = ''; } catch (e) { image.hidden = true; error.textContent = e.message; } };
    input.addEventListener('input', update); card.append(caption, image); dialog.append(title, input, card, error, hint, close); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove(), { once: true }); update(); dialog.showModal(); close.focus();
  }
  function addPanel() {
    const parent = document.querySelector('#admin-sub-appsettings .form-card'); if (!parent || document.getElementById('maxPlatePanel')) return;
    const panel = document.createElement('div'); panel.id = 'maxPlatePanel'; panel.style.cssText = 'margin-top:16px;padding-top:12px;border-top:1px solid #334155';
    const title = document.createElement('b'); title.textContent = 'Госномер картинкой'; const message = document.createElement('p'); message.id = 'maxPlateStatus'; message.textContent = status; message.style.cssText = 'color:#94a3b8;font-size:12px;line-height:1.4;margin:7px 0';
    const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
    const view = document.createElement('button'); view.type = 'button'; view.className = 'btn btn-secondary btn-small'; view.textContent = 'Посмотреть пример'; view.onclick = preview;
    const check = document.createElement('button'); check.type = 'button'; check.className = 'btn btn-secondary btn-small'; check.textContent = 'Проверить поддержку'; check.onclick = async () => { if (!admin()) return; check.disabled = true; setStatus('Проверяем сервер…'); try { if (!cfg().maxUrl) setStatus('Сначала укажите URL в настройках MAX.'); else await capabilities({ ...cfg() }, true); } finally { check.disabled = false; } };
    actions.append(view, check); panel.append(title, message, actions); parent.append(panel);
  }
  window[KEY] = { version: '1.0.0', contract: CONTRACT, parsePlate, fromText, resolvePlate, renderPng, preview, install, checkServer: () => admin() ? capabilities({ ...cfg() }, true) : Promise.resolve(false) };
  install(); if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
})();
