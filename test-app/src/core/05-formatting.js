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
  function getActiveLineIds() { const shiftId=state.shift?.id; return shiftId ? Object.keys(state.truckStatus).filter(id => state.truckStatus[id]?.onLine === true && state.truckStatus[id].shiftId === shiftId) : []; }
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

  // Stored notifications are data, not HTML. Recognize only our legacy plate
  // vocabulary and rebuild it with DOM APIs. Never parse untrusted markup in a
  // browser document (including an inert document/template): even rejected tags
  // must not create resource requests, event handlers or custom elements.
  function notificationMarkup(value) { return typeof value === 'string' ? value : ''; }
  function notificationTimestamp(value) {
    const n = (typeof value === 'number' || typeof value === 'string') ? Number(value) : 0;
    return Number.isFinite(n) && n > 0 && n <= 8640000000000000 ? n : 0;
  }
  function decodeNotificationText(value) {
    const entities = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:'\u00a0', middot:'·'};
    return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|middot);/gi, (whole, entity) => {
      if (entity[0] !== '#') return entities[entity.toLowerCase()];
      const hex = entity[1].toLowerCase() === 'x';
      const n = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
    });
  }
  function stripNotificationAuthor(root, name) {
    const author = typeof name === 'string' ? name.trim() : '';
    if (!author || author === '—') return;
    const leaves = [];
    function visit(node) {
      if (node.nodeType === 3) leaves.push(node);
      else Array.from(node.childNodes).forEach(visit);
    }
    visit(root);
    const text = leaves.map(node => node.data).join('');
    const escaped = author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = text.match(new RegExp('^\\s*' + escaped + '\\s*·\\s*', 'i'));
    const suffix = text.match(new RegExp('(?:\\s*·\\s*|\\s{2,})' + escaped + '\\s*$', 'i'));
    const start = prefix ? prefix[0].length : 0;
    const end = suffix ? suffix.index : text.length;
    let offset = 0;
    for (const leaf of leaves) {
      const length = leaf.data.length;
      leaf.data = leaf.data.slice(Math.max(0, start - offset), Math.max(0, Math.min(length, end - offset)));
      offset += length;
    }
  }
  function renderNotificationContent(target, value, author) {
    const doc = target.ownerDocument || document;
    const root = doc.createDocumentFragment(), stack = [{tag:'', node:root}];
    const text = notificationMarkup(value);
    // This is deliberately a tiny legacy-format reader, not an HTML sanitizer.
    // Everything outside exact allowlisted tokens remains literal visible text.
    const tokens = text.match(/<[^<>]*>|[^<]+|</g) || [];
    function appendText(value) { stack[stack.length - 1].node.appendChild(doc.createTextNode(decodeNotificationText(value))); }
    for (const token of tokens) {
      const close = token.match(/^<\/(b|strong|i|em|span|div)\s*>$/i);
      if (close && stack.length > 1 && stack[stack.length - 1].tag === close[1].toLowerCase()) { stack.pop(); continue; }
      const simple = token.match(/^<(b|strong|i|em|span|br)\s*\/?\s*>$/i);
      const plate = token.match(/^<(div|span)\s+class\s*=\s*(["'])([a-z-]+)\2\s*>$/i);
      const badge = /^<span\s+style\s*=\s*(["'])color:#f59e0b;font-size:10px;?\1\s*>$/i.test(token);
      let tag = simple ? simple[1].toLowerCase() : badge ? 'span' : '';
      let className = '';
      if (plate) {
        const allowed = plate[1].toLowerCase() === 'div'
          ? ['ru-plate','ru-plate-main','ru-plate-region','ru-plate-flag']
          : ['plate-digit','region-code','region-rus'];
        if (allowed.includes(plate[3])) { tag = plate[1].toLowerCase(); className = plate[3]; }
      }
      if (!tag || stack.length >= 64) { appendText(token); continue; }
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (badge) { node.style.color = '#f59e0b'; node.style.fontSize = '10px'; }
      stack[stack.length - 1].node.appendChild(node);
      if (tag !== 'br') stack.push({tag, node});
    }
    stripNotificationAuthor(root, author);
    target.replaceChildren(root);
  }
  function notificationAuthorName(last) {
    if (!last) return '';
    const candidates = [last.userName, last.createdBy];
    // Unknown historical authors must never be attributed to the current viewer.
    if (typeof last.createdByEmail === 'string' && last.createdByEmail.trim()) {
      candidates.push(resolveUserDisplayName(last.createdByEmail));
    }
    return candidates.find(value => typeof value === 'string' && value.trim()
      && !['—','undefined','null'].includes(value.trim()))?.trim() || '';
  }
