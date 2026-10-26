  function showError(msg) { console.error(msg); if (!navigator.onLine) { showToastEl(`📴 Нет сети`, true); return; } showToastEl(`⚠️ ${escapeHtml(msg)}`, true); }
  function resetToast(t) { t.className = 'toast'; t.replaceChildren(); }
  function showToastEl(html, isError, isUndo) {
    if(window.__gameDeferToast?.(html,isError,isUndo))return;
    let t = document.getElementById('toast'); if (!t) return;
    clearTimeout(toastTimer1); clearTimeout(toastTimer2);
    t.className = 'toast' + (isError ? ' error' : '') + (isUndo ? ' slide-right-to-left' : '');
    renderNotificationContent(t, html); void t.offsetWidth; t.classList.add('show');
    toastTimer1 = setTimeout(() => { t.classList.remove('show'); t.classList.add('hide'); toastTimer2 = setTimeout(() => resetToast(t), 700); }, 2500);
  }
  function showToast(msgHtml, tickerHtml, actionObj) { if (actionObj) pushNotification(actionObj, tickerHtml || msgHtml); else showToastEl(msgHtml, false); }
  async function pushNotification(actionObj, htmlText) {
    pendingStart();
    try { await refs.notifications.add(Object.assign({}, actionObj, { html: htmlText, timestamp: Date.now(), createdBy: getUserName(), createdByEmail: currentEmail || '' })); cleanupNotifications().catch(()=>{}); }
    catch(e) { console.warn(e); } finally { pendingEnd(); }
  }
  let notifCleanupPending = false;
  async function cleanupNotifications() {
    if (notifCleanupPending) return; notifCleanupPending = true;
    try { let snap = await refs.notifications.orderBy('timestamp', 'desc').limit(100).get(); if (snap.size < 100) return; let oldTs = snap.docs[snap.docs.length - 1].data().timestamp; let oldSnap = await refs.notifications.where('timestamp', '<', oldTs).get(); let batch = db.batch(); let cnt=0; oldSnap.forEach(d=>{batch.delete(d.ref);cnt++;}); if(cnt>0) await tfAwait(batch.commit()); }
    catch(e) {} finally { notifCleanupPending = false; }
  }
  async function clearAllNotifications() { try { let snap = await refs.notifications.get(); if(!snap.size) return; let b=db.batch(); snap.forEach(d=>b.delete(d.ref)); await tfAwait(b.commit()); } catch(e){} }
  function canUndoCurrent(last) { if (!hasPermission('undo_action') && !hasPermission('undo_any')) return false; if (hasPermission('undo_any')) return true; return last.createdByEmail === currentEmail; }

  // Static ticker structure is built separately from stored event content.
  function createStatusTickerFrame(t) {
    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }
    const top = element('div', 'ticker-row-top');
    const name = element('span', 'ticker-name-line');
    name.append(element('span', '', 'ПОСЛЕДНЕЕ ДЕЙСТВИЕ'), element('span', 'ticker-user'));
    const time = element('span', 'ticker-time'); time.id = 'tickerTimeAgo';
    top.append(name, time);
    const bottom = element('div', 'ticker-row-bottom');
    const wrapper = element('div', 'ticker-text-wrapper');
    wrapper.appendChild(element('div', 'ticker-left active'));
    bottom.appendChild(wrapper);
    t.replaceChildren(top, bottom);
    t.style.display = 'flex';
    return wrapper.firstElementChild;
  }
  function updateStatusTickerMeta(t, last, userName) {
    const user = t.querySelector('.ticker-user');
    const label = userName ? '· 👤 ' + userName : '';
    if (user && user.textContent !== label) user.textContent = label;
    const timestamp = notificationTimestamp(last.timestamp);
    const time = t.querySelector('.ticker-time');
    if (time) {
      const label = formatTimeAgo(timestamp);
      if (time.textContent !== label) time.textContent = label;
      time.setAttribute('data-timestamp', String(timestamp));
    }
    let undo = t.querySelector('.btn-undo');
    if (canUndoCurrent(last)) {
      if (!undo) {
        undo = document.createElement('button'); undo.type = 'button';
        undo.className = 'btn-undo'; undo.textContent = '↩'; undo.title = 'Отменить';
        t.querySelector('.ticker-row-bottom').appendChild(undo);
      }
      // Resolve at click time so later offline/undo adapters remain effective.
      undo.onclick = () => last.offlinePending ? window.undoLastOfflineAction() : window.undoLastAction();
    } else if (undo) undo.remove();
  }
  let lastTickerContent = null;
  function renderStatusTicker() {
    const t = document.getElementById('statusTicker'); if (!t) return;
    const last = offlineLocalTicker() || lastValidNotification();
    if (!last) { t.style.display = 'none'; t.replaceChildren(); lastTickerTs = 0; lastTickerId = null; lastTickerContent = null; return; }
    const timestamp = notificationTimestamp(last.timestamp);
    const author = notificationAuthorName(last), markup = notificationMarkup(last.html);
    const content = JSON.stringify([markup, author]);
    let fresh = false;
    if (t.style.display === 'none' || !t.querySelector('.ticker-text-wrapper')) {
      renderNotificationContent(createStatusTickerFrame(t), markup, author);
      fresh = true;
    } else if (last.id !== lastTickerId || !t.querySelector('.ticker-left.active')) {
      const wrapper = t.querySelector('.ticker-text-wrapper'), oldText = wrapper.querySelector('.ticker-left.active');
      wrapper.querySelectorAll('.ticker-left').forEach(node => { if (node !== oldText) node.remove(); });
      const next = document.createElement('div'); next.className = 'ticker-left enter';
      renderNotificationContent(next, markup, author); wrapper.appendChild(next); void next.offsetWidth;
      if (oldText) { oldText.classList.remove('active'); oldText.classList.add('leave'); }
      next.classList.remove('enter'); next.classList.add('active');
      setTimeout(() => { if (oldText && oldText.parentNode) oldText.remove(); }, 800);
      fresh = true;
    } else if (content !== lastTickerContent) {
      renderNotificationContent(t.querySelector('.ticker-left.active'), markup, author);
    }
    updateStatusTickerMeta(t, last, author);
    if (fresh) { t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); }
    lastTickerTs = timestamp; lastTickerId = last.id; lastTickerContent = content;
  }
