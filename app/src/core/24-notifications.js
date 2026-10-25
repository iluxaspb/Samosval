  function showError(msg) { console.error(msg); if (!navigator.onLine) { showToastEl(`📴 Нет сети`, true); return; } showToastEl(`⚠️ ${escapeHtml(msg)}`, true); }
  function resetToast(t) { t.className = 'toast'; t.innerHTML = ''; }
  function showToastEl(html, isError, isUndo) {
    if(window.__gameDeferToast?.(html,isError,isUndo))return;
    let t = document.getElementById('toast'); if (!t) return;
    clearTimeout(toastTimer1); clearTimeout(toastTimer2);
    t.className = 'toast' + (isError ? ' error' : '') + (isUndo ? ' slide-right-to-left' : '');
    t.innerHTML = html; void t.offsetWidth; t.classList.add('show');
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

  function renderStatusTicker() {
    let t = document.getElementById('statusTicker'); if (!t) return;
    let last = offlineLocalTicker() || lastValidNotification();
    if (!last) { t.style.display = 'none'; t.innerHTML = ''; lastTickerTs = 0; lastTickerId = null; return; }
    let isNew = (last.timestamp || 0) !== lastTickerTs; let isNewId = last.id !== lastTickerId;
    if (t.style.display === 'none' || !t.querySelector('.ticker-text-wrapper')) {
      t.style.display = 'flex';
      t.innerHTML = `<div class="ticker-row-top"><span>ПОСЛЕДНЕЕ ДЕЙСТВИЕ</span><span id="tickerTimeAgo" class="ticker-time" data-timestamp="${last.timestamp||Date.now()}">${formatTimeAgo(last.timestamp)}</span></div><div class="ticker-row-bottom"><div class="ticker-text-wrapper"><div class="ticker-left active">${last.html||''}</div></div>${canUndoCurrent(last) ? `<button class="btn-undo" onclick="${last.offlinePending?'undoLastOfflineAction()':'undoLastAction()'}" title="Отменить">↩</button>` : ''}</div>`;
      lastTickerTs = last.timestamp || 0; lastTickerId = last.id; t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); return;
    }
    if (isNew && isNewId) {
      let wrapper = t.querySelector('.ticker-text-wrapper'); let oldText = wrapper.querySelector('.ticker-left.active');
      if (oldText) { let newText = document.createElement('div'); newText.className = 'ticker-left enter'; newText.innerHTML = last.html || ''; wrapper.appendChild(newText); void newText.offsetWidth; oldText.classList.remove('active'); oldText.classList.add('leave'); newText.classList.remove('enter'); newText.classList.add('active'); setTimeout(() => { if (oldText.parentNode) oldText.remove(); }, 800); }
      let undoBtn = t.querySelector('.btn-undo'); let canUndo = canUndoCurrent(last);
      if (canUndo && !undoBtn) { let btn = document.createElement('button'); btn.className = 'btn-undo'; btn.innerHTML = '↩'; btn.onclick = last.offlinePending?undoLastOfflineAction:undoLastAction; t.querySelector('.ticker-row-bottom').appendChild(btn); } else if (!canUndo && undoBtn) { undoBtn.remove(); }
      if(undoBtn&&canUndo)undoBtn.onclick=last.offlinePending?undoLastOfflineAction:undoLastAction;
      let timeEl = document.getElementById('tickerTimeAgo'); if(timeEl) { timeEl.textContent = formatTimeAgo(last.timestamp); timeEl.setAttribute('data-timestamp', last.timestamp); }
      t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); lastTickerTs = last.timestamp || 0; lastTickerId = last.id;
    }
  }
