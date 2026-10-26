

/* Добавляемый патч: Админ → Патчи → тип «Заменить функцию». Вставить весь файл.
 * Только текстовая табличка через существующую отправку MAX.
 * Изображения, документы и проверка возможностей сервера не отправляются.
 * Не отправляет пробных сообщений, не меняет триггеры и не читает токен бота.
 */
(function () {
  'use strict';
  const KEY = 'MaxPlateNotifications';
  if (window[KEY]) { window[KEY].install(); return; }
  const admin = () => typeof canAdmin === 'function' && canAdmin();
  const status = 'Госномер оформляется текстовой табличкой с регионом и флагом. MAX получает только текстовые уведомления.';
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
  function formatPlateText(value) {
    const p = parsePlate(value); if (!p) return String(value || '');
    // Non-breaking spaces keep the compact plate together in a narrow message bubble.
    return '【\u00a0' + p.first.toUpperCase() + p.digits + p.last.toUpperCase() + '\u00a0│\u00a0' + p.region + '\u00a0RUS\u00a0】 🇷🇺';
  }
  function formatText(text) {
    if (typeof text !== 'string') return text;
    // Only explicit truck/plate lines. Keep names, sites, totals and other content intact.
    const decorated = text.split(/(\r?\n)/).map(line => {
      if (!/^\s*(?:🚛|🚚|Госномер\s*:)/iu.test(line)) return line;
      return line.replace(/(^|[^а-яёa-z0-9])([а-яёa-z][ \t\u00a0-]*\d{3}[ \t\u00a0-]*[а-яёa-z]{2}[ \t\u00a0-]*\d{2,3})(?=$|[^а-яёa-z0-9])/giu,
        (_, prefix, number) => prefix + formatPlateText(number));
    }).join('');
    // Decoration must never turn a valid message into one over MAX's text limit.
    return decorated.length <= 4000 ? decorated : text;
  }
  function textItem(item) {
    if (!item || item.type !== 'text') return item;
    const text = formatText(item.text);
    return text === item.text ? item : { ...item, text };
  }
  function install() {
    if (typeof window.enqueueMax === 'function' && !window.enqueueMax.__maxPlate) {
      const previous = window.enqueueMax;
      const wrapped = function(text, meta, notBefore) { const plate = resolvePlate({ type: 'text', text, meta }); return previous.call(this, text, plate ? { ...(meta || {}), maxPlateNumber: plate.number } : meta, notBefore); };
      wrapped.__maxPlate = true; window.enqueueMax = wrapped;
    }
    if (typeof window.sendMaxOnce === 'function' && !window.sendMaxOnce.__maxPlate) {
      const previous=window.sendMaxOnce;
      const wrapped=async function(item){
        if(!item||item.type!=='text')return 'drop';
        return previous.call(this,textItem(item));
      };
      wrapped.__maxPlate=true;window.sendMaxOnce=wrapped;
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
    const sample = document.createElement('div'); sample.id = 'maxPlateTextSample'; sample.style.cssText = 'font-size:16px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere';
    const hint = document.createElement('p'); hint.textContent = 'Пример текста уведомления. Шрифт и цвет сообщения определяет MAX. В чат ничего не отправляется.'; hint.style.cssText = 'font-size:12px;color:#94a3b8;margin:10px 0';
    const error = document.createElement('p'); error.setAttribute('role', 'status'); error.style.cssText = 'color:#fca5a5;font-size:12px';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn btn-secondary'; close.textContent = 'Закрыть'; close.onclick = () => dialog.close();
    const update = () => { const p = parsePlate(input.value); sample.textContent = p ? formatText('🚛 ' + p.number) : ''; error.textContent = p ? '' : 'Введите госномер, например А123ВС178'; };
    input.addEventListener('input', update); card.append(caption, sample); dialog.append(title, input, card, error, hint, close); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove(), { once: true }); update(); dialog.showModal(); close.focus();
  }
  function addPanel() {
    const parent = document.querySelector('#admin-max-settings .form-card'); if (!parent || document.getElementById('maxPlatePanel')) return;
    const panel = document.createElement('div'); panel.id = 'maxPlatePanel'; panel.style.cssText = 'margin-top:16px;padding-top:12px;border-top:1px solid #334155';
    const title = document.createElement('b'); title.textContent = 'Госномер в уведомлениях MAX'; const message = document.createElement('p'); message.id = 'maxPlateStatus'; message.textContent = status; message.style.cssText = 'color:#94a3b8;font-size:12px;line-height:1.4;margin:7px 0';
    const actions = document.createElement('div'); actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
    const view = document.createElement('button'); view.type = 'button'; view.className = 'btn btn-secondary btn-small'; view.textContent = 'Посмотреть пример'; view.onclick = preview;
    actions.append(view); panel.append(title, message, actions); parent.append(panel);
  }
  window[KEY] = { version: '1.2.0', parsePlate, fromText, resolvePlate, formatPlateText, formatText, preview, install };
  install(); if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
})();

