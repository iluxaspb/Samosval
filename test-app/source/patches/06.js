(function(){
  if (window.__tickerV9) return;
  window.__tickerV9 = true;

  try {
    ['ticker-fix-css', 'ticker-compact-css', 'ticker-v3-css', 'ticker-v4-css', 'ticker-v5-css', 'ticker-v6-css', 'ticker-v7-css', 'ticker-v8-css', 'ticker-v9-css'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });

    const css = document.createElement('style');
    css.id = 'ticker-v9-css';
    css.textContent = `
      #statusTicker { padding: 4px 10px !important; gap: 1px !important; }

      #statusTicker .ticker-row-top {
        display: flex !important;
        flex-wrap: nowrap !important;
        justify-content: space-between !important;
        align-items: center !important;
        gap: 8px !important;
        padding-bottom: 2px !important;
        font-size: 10px !important;
        line-height: 1.2 !important;
        border-bottom: 1px solid rgba(255,255,255,0.2) !important;
        overflow: hidden !important;
        white-space: nowrap !important;
      }
      #statusTicker .ticker-name-line {
        display: inline-flex !important;
        flex-direction: row !important;
        flex-wrap: nowrap !important;
        align-items: center !important;
        gap: 6px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        min-width: 0 !important;
        flex: 1 1 auto !important;
      }
      #statusTicker .ticker-name-line > span { white-space: nowrap !important; }
      #statusTicker .ticker-name-line > span:first-child { flex-shrink: 0 !important; }
      #statusTicker .ticker-user {
        opacity: 0.95 !important;
        color: #fef3c7 !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        max-width: 200px !important;
        white-space: nowrap !important;
        font-size: 10px !important;
        font-weight: 700 !important;
        display: inline-block !important;
        flex-shrink: 1 !important;
        min-width: 0 !important;
        line-height: 1.2 !important;
      }
      #statusTicker .ticker-time {
        flex-shrink: 0 !important;
        font-size: 9px !important;
        padding: 0 4px !important;
        margin-left: auto !important;
      }

      #statusTicker .ticker-row-bottom {
        display: flex !important;
        justify-content: space-between !important;
        align-items: center !important;
        gap: 6px !important;
        position: relative !important;
        overflow: hidden !important;
        height: 40px !important;
        margin-top: 0 !important;
      }

      /* === ОРИГИНАЛЬНАЯ АНИМАЦИЯ === */
      #statusTicker .ticker-text-wrapper {
        flex: 1 1 auto !important;
        position: relative !important;
        overflow: hidden !important;
        height: 100% !important;
        display: flex !important;
        align-items: center !important;
        min-width: 0 !important;
      }
      #statusTicker .ticker-left {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: 100% !important;
        height: 100% !important;
        display: flex !important;
        align-items: center !important;
        gap: 4px !important;
        font-size: 11.5px !important;
        font-weight: 700 !important;
        white-space: nowrap !important;
        transition: transform 0.8s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.8s ease-out !important;
      }
      #statusTicker .ticker-left.enter { transform: translateX(-100%) !important; opacity: 0 !important; }
      #statusTicker .ticker-left.active { transform: translateX(0) !important; opacity: 1 !important; }
      #statusTicker .ticker-left.enter-reverse { transform: translateX(100%) !important; opacity: 0 !important; }
      #statusTicker .ticker-left.leave-reverse { transform: translateX(-100%) !important; opacity: 0 !important; }
      #statusTicker .ticker-left.leave { transform: translateX(100%) !important; opacity: 0 !important; }
      #statusTicker .ticker-left.enter-reverse { transform: translateX(100%) !important; opacity: 0 !important; }
      #statusTicker .ticker-left.leave-reverse { transform: translateX(-100%) !important; opacity: 0 !important; }

      #statusTicker .ru-plate {
        transform: none !important; flex-shrink: 0 !important;
        height: 30px !important; margin: 0 3px !important;
        border-width: 2px !important; border-radius: 4px !important;
      }
      #statusTicker .ru-plate-main { font-size: 16px !important; padding: 0 5px !important; gap: 1px !important; letter-spacing: 1px !important; }
      #statusTicker .ru-plate-main .plate-digit { font-size: 17px !important; letter-spacing: 1.5px !important; }
      #statusTicker .ru-plate-region { width: 28px !important; min-width: 28px !important; max-width: 28px !important; padding: 1px 0 !important; border-left-width: 2px !important; }
      #statusTicker .ru-plate-region .region-code { font-size: 11px !important; line-height: 1 !important; }
      #statusTicker .ru-plate-region .region-rus { font-size: 5px !important; line-height: 1 !important; margin-top: 0.5px !important; }
      .ru-plate-flag {
        display: block !important;
        width: 10px !important; height: 5px !important;
        margin-top: 1px !important;
        border: 0.5px solid #000 !important;
        background: linear-gradient(to bottom, #ffffff 0%, #ffffff 33.33%, #0039a6 33.33%, #0039a6 66.66%, #d52b1e 66.66%, #d52b1e 100%) !important;
        flex-shrink: 0 !important; box-sizing: border-box !important;
        min-width: 10px !important; min-height: 5px !important;
      }
      .ru-plate-flag span { display: none !important; }
      #statusTicker .ru-plate-flag { width: 13px !important; height: 7.5px !important; min-width: 13px !important; min-height: 7.5px !important; }
      #statusTicker .btn-undo { width: 24px !important; height: 22px !important; font-size: 12px !important; }
    `;
    document.head.appendChild(css);

    // ===== Утилиты =====
    function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    function stripUserName(html, name) {
      if (!html) return '';
      let s = String(html);
      if (name) {
        const n = String(name).trim();
        if (n && n !== '—') {
          const esc = escapeRegExp(n);
          s = s.replace(new RegExp('\\s*·\\s*' + esc + '\\s*$', 'i'), '');
          s = s.replace(new RegExp('^\\s*' + esc + '\\s*·\\s*', 'i'), '');
          s = s.replace(new RegExp('\\s{2,}' + esc + '\\s*$', 'i'), '');
        }
      }
      s = s.replace(/\s{2,}/g, ' ');
      s = s.replace(/\s*·\s*$/, '');
      s = s.replace(/^\s*·\s*/, '');
      return s;
    }

    const undoneTickerIds = new Set();
    window.addEventListener('samosval:action-undone', event => {
      const action = event.detail;
      const truckOp = (action.operations || []).find(op => op.collection === 'truckStatus');
      const logOp = (action.operations || []).find(op => op.collection === 'logs' && op.before === null);
      if (!truckOp && !logOp) return;
      const notification = (state.notifications || []).find(item =>
        !undoneTickerIds.has(item.id) && item.type === action.type &&
        (logOp ? item.logId === logOp.id : item.truckId === truckOp.id)
      );
      if (!notification) return;
      undoneTickerIds.add(notification.id);
      window.renderStatusTicker();
    });

    function getLastNotification() {
      try {
        if (typeof state !== 'undefined' && state && state.notifications && state.notifications.length > 0) {
          return state.notifications.find(item => !undoneTickerIds.has(item.id) && validTickerNotification(item)) || null;
        }
      } catch(e) {}
      return null;
    }

    function getUserNameForTicker(last) {
      if (!last) return '';
      const candidates = [last.userName, last.createdBy];
      try {
        if (typeof state !== 'undefined' && state && state.users && last.createdByEmail) {
          const u = state.users.find(x => x.email && x.email.toLowerCase() === String(last.createdByEmail).toLowerCase());
          if (u) {
            if (u.nickname) candidates.push(u.nickname);
            if (u.email) candidates.push(sanitizeName(u.email));
          }
        }
      } catch(e) {}
      if (last.createdByEmail) {
        try { candidates.push(sanitizeName(last.createdByEmail)); } catch(e) {}
      }
      if (last.timestamp && (Date.now() - last.timestamp) < 600000) {
        try { candidates.push(getUserName()); } catch(e) {}
        try { candidates.push(sanitizeName(currentEmail)); } catch(e) {}
      }
      try { candidates.push(getUserName()); } catch(e) {}

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!c) continue;
        const v = String(c).trim();
        if (v && v !== '—' && v !== 'undefined' && v !== 'null') return v;
      }
      return '';
    }

    // ===== Инъекция имени в верхнюю строку =====
    let _injecting = false;

    function injectUserName() {
      if (_injecting) return;
      _injecting = true;
      try {
        const t = document.getElementById('statusTicker');
        if (!t || t.style.display === 'none') return;

        const last = getLastNotification();
        if (!last) return;

        const userName = getUserNameForTicker(last);
        if (!userName) return;

        const userLabel = '· 👤 ' + userName;
        const topRow = t.querySelector('.ticker-row-top');
        if (!topRow) return;

        let nameLine = topRow.querySelector('.ticker-name-line');

        if (!nameLine) {
          const children = Array.from(topRow.children);
          let firstTextEl = null;
          for (const ch of children) {
            if (ch.classList && ch.classList.contains('ticker-time')) continue;
            if (ch.id === 'tickerTimeAgo') continue;
            if (ch.tagName === 'SPAN' && !ch.classList.contains('ticker-user')) {
              firstTextEl = ch;
              break;
            }
          }

          if (firstTextEl) {
            nameLine = document.createElement('span');
            nameLine.className = 'ticker-name-line';
            firstTextEl.parentNode.insertBefore(nameLine, firstTextEl);
            nameLine.appendChild(firstTextEl);
          } else {
            nameLine = document.createElement('span');
            nameLine.className = 'ticker-name-line';
            nameLine.innerHTML = '<span>ПОСЛЕДНЕЕ ДЕЙСТВИЕ</span>';
            const timeEl = topRow.querySelector('.ticker-time') || topRow.querySelector('#tickerTimeAgo');
            if (timeEl) topRow.insertBefore(nameLine, timeEl);
            else topRow.appendChild(nameLine);
          }
        }

        let userSpan = nameLine.querySelector('.ticker-user');
        if (!userSpan) {
          userSpan = document.createElement('span');
          userSpan.className = 'ticker-user';
          nameLine.appendChild(userSpan);
        }
        if (userSpan.textContent !== userLabel) {
          userSpan.textContent = userLabel;
        }
      } catch(e) {
        console.warn('[ticker-v9] inject error:', e.message);
      } finally {
        _injecting = false;
      }
    }

    // ===== Оригинальные трекеры =====
    let lastTickerTs = 0;
    let lastTickerId = null;

    // ===== renderStatusTicker — оригинальная логика анимации =====
    window.renderStatusTicker = function() {
      const t = document.getElementById('statusTicker');
      if (!t) return;

      const last = getLastNotification();
      if (!last) {
        const reverseEnabled = true;
        const outgoing = t.querySelector('.ticker-left.active');
        if (reverseEnabled && outgoing) {
          outgoing.classList.remove('active');
          outgoing.classList.add('leave-reverse');
          setTimeout(() => {
            if (!getLastNotification()) {
              t.style.display = 'none';
              t.innerHTML = '';
              lastTickerTs = 0;
              lastTickerId = null;
            }
          }, 800);
          return;
        }
        if (reverseEnabled && t.querySelector('.leave-reverse')) return;
        t.style.display = 'none';
        t.innerHTML = '';
        lastTickerTs = 0;
        lastTickerId = null;
        t.removeAttribute('data-ticker-v9');
        return;
      }

      const isNew = (last.timestamp || 0) !== lastTickerTs;
      const isNewId = last.id !== lastTickerId;
      const userName = getUserNameForTicker(last);
      const cleanHtml = stripUserName(last.html || '', userName);
      const userLabel = userName ? '· 👤 ' + userName : '';
      const showUndo = (typeof canUndoCurrent === 'function') ? canUndoCurrent(last) : false;

      // Первый рендер / после скрытия — полная перестройка без слайда
      if (t.style.display === 'none' || !t.querySelector('.ticker-text-wrapper')) {
        t.style.display = 'flex';
        t.innerHTML = `
          <div class="ticker-row-top">
            <span class="ticker-name-line">
              <span>ПОСЛЕДНЕЕ ДЕЙСТВИЕ</span>
              <span class="ticker-user">${userLabel ? escapeHtml(userLabel) : ''}</span>
            </span>
            <span id="tickerTimeAgo" class="ticker-time" data-timestamp="${last.timestamp||Date.now()}">${formatTimeAgo(last.timestamp)}</span>
          </div>
          <div class="ticker-row-bottom">
            <div class="ticker-text-wrapper">
              <div class="ticker-left active">${cleanHtml}</div>
            </div>
            ${showUndo ? '<button class="btn-undo" onclick="undoLastAction()" title="Отменить">↩</button>' : ''}
          </div>
        `;
        lastTickerTs = last.timestamp || 0;
        lastTickerId = last.id;
        t.classList.remove('flash');
        void t.offsetWidth;
        t.classList.add('flash');
        return;
      }

      // === Анимация слайда при новом уведомлении (как в оригинале) ===
      if (isNewId || !t.querySelector('.ticker-left.active')) {
        const reverse = isNewId && (last.timestamp || 0) <= lastTickerTs;
        const wrapper = t.querySelector('.ticker-text-wrapper');
        const oldText = wrapper.querySelector('.ticker-left.active');

        // Remove obsolete outgoing cards during rapid successive updates.
        wrapper.querySelectorAll('.ticker-left').forEach(node => {
          if (node !== oldText) node.remove();
        });
        {
          const newText = document.createElement('div');
          newText.className = reverse ? 'ticker-left enter-reverse' : 'ticker-left enter';
          newText.innerHTML = cleanHtml;
          wrapper.appendChild(newText);
          void newText.offsetWidth;
          if (oldText) {
            oldText.classList.remove('active');
            oldText.classList.add(reverse ? 'leave-reverse' : 'leave');
          }
          newText.classList.remove('enter', 'enter-reverse');
          newText.classList.add('active');
          setTimeout(() => { if (oldText && oldText.parentNode) oldText.remove(); }, 800);
        }

        // Кнопка отмены
        let undoBtn = t.querySelector('.btn-undo');
        if (showUndo && !undoBtn) {
          const btn = document.createElement('button');
          btn.className = 'btn-undo';
          btn.innerHTML = '↩';
          btn.onclick = window.undoLastAction;
          t.querySelector('.ticker-row-bottom').appendChild(btn);
        } else if (!showUndo && undoBtn) {
          undoBtn.remove();
        }

        // Время
        const timeEl = document.getElementById('tickerTimeAgo');
        if (timeEl) {
          timeEl.textContent = formatTimeAgo(last.timestamp);
          timeEl.setAttribute('data-timestamp', last.timestamp);
        }

        // Flash
        t.classList.remove('flash');
        void t.offsetWidth;
        t.classList.add('flash');

        lastTickerTs = last.timestamp || 0;
        lastTickerId = last.id;
      }

      // Имя всегда обновляем (не зависит от анимации нижней строки)
      injectUserName();
    };

    // ===== pushNotification — сохраняем имя =====
    window.pushNotification = async function(actionObj, htmlText) {
      if (typeof pendingStart === 'function') pendingStart();
      try {
        let userName = '';
        try {
          if (typeof getUserName === 'function') {
            const n = getUserName();
            if (n && n !== '—') userName = n;
          }
        } catch(e) {}
        if (!userName) {
          try {
            if (typeof currentEmail !== 'undefined' && currentEmail) userName = sanitizeName(currentEmail) || '';
          } catch(e) {}
        }
        if (!userName) userName = '—';

        const userEmail = (typeof currentEmail !== 'undefined') ? (currentEmail || '') : '';
        const cleanHtml = stripUserName(htmlText || '', userName);

        await refs.notifications.add(Object.assign({}, actionObj, {
          html: cleanHtml,
          userName: userName,
          timestamp: Date.now(),
          createdBy: userName,
          createdByEmail: userEmail
        }));

        if (typeof cleanupNotifications === 'function') cleanupNotifications().catch(()=>{});
      } catch (e) {
        console.warn('[ticker-v9] push error:', e);
      } finally {
        if (typeof pendingEnd === 'function') pendingEnd();
      }
    };

    // ===== Диагностика =====
    window.__tickerDebug = function() {
      const t = document.getElementById('statusTicker');
      console.log('=== TICKER V9 DEBUG ===');
      console.log('Патч:', !!window.__tickerV9);
      try {
        const last = getLastNotification();
        if (!last) { console.log('Нет уведомлений'); return; }
        console.log('Уведомление:', {
          id: last.id, userName: last.userName, createdBy: last.createdBy,
          createdByEmail: last.createdByEmail,
          timestamp: new Date(last.timestamp || 0).toLocaleString()
        });
        console.log('getUserNameForTicker:', getUserNameForTicker(last));
      } catch(e) { console.log('err:', e.message); }
      if (t) {
        console.log('display:', getComputedStyle(t).display);
        console.log('ticker-user:', JSON.stringify(t.querySelector('.ticker-user')?.textContent));
        console.log('ticker-left active:', !!t.querySelector('.ticker-left.active'));
      }
      console.log('=== /DEBUG ===');
    };

    window.__forceTickerName = function() {
      injectUserName();
      console.log('[ticker-v9] Инъекция выполнена');
    };

    // ===== MutationObserver + интервал =====
    function attachObserver() {
      const t = document.getElementById('statusTicker');
      if (!t || t.dataset.v9Obs) return;
      t.dataset.v9Obs = '1';
      const obs = new MutationObserver(() => injectUserName());
      obs.observe(t, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });
    }

    setInterval(() => {
      attachObserver();
      injectUserName();
    }, 300);

    // ===== Авто-миграция =====
    async function autoMigrate() {
      try {
        const snap = await refs.notifications.orderBy('timestamp', 'desc').limit(50).get();
        if (snap.empty) return;
        const batch = db.batch();
        let fixed = 0;
        snap.forEach(doc => {
          const d = doc.data();
          if (d.userName && String(d.userName).trim() && String(d.userName).trim() !== '—') return;
          let name = '';
          if (d.createdBy && String(d.createdBy).trim() && String(d.createdBy).trim() !== '—') {
            name = String(d.createdBy).trim();
          } else if (d.createdByEmail) {
            let found = '';
            try {
              if (state && state.users && state.users.length) {
                const u = state.users.find(x => x.email && x.email.toLowerCase() === String(d.createdByEmail).toLowerCase());
                if (u && u.nickname && String(u.nickname).trim() && String(u.nickname).trim() !== '—') found = String(u.nickname).trim();
              }
            } catch(e) {}
            if (!found) {
              const fromEmail = sanitizeName(d.createdByEmail);
              if (fromEmail && fromEmail !== '—') found = fromEmail;
            }
            name = found;
          }
          if (name) {
            batch.update(doc.ref, { userName: name });
            fixed++;
          }
        });
        if (fixed > 0) {
          await batch.commit();
          console.log('[ticker-v9] Мигрировано:', fixed);
          window.renderStatusTicker();
        }
      } catch(e) {
        console.warn('[ticker-v9] migrate:', e.message);
      }
    }

    setTimeout(() => { try { window.renderStatusTicker(); } catch(e) {} }, 300);
    setTimeout(() => { try { window.renderStatusTicker(); } catch(e) {} }, 1000);
    setTimeout(attachObserver, 500);
    setTimeout(() => { try { autoMigrate(); } catch(e) {} }, 2500);
    setTimeout(() => { try { window.renderStatusTicker(); } catch(e) {} }, 3500);

    console.log('[ticker-v9] ✅ Активен. Оригинальная анимация + имя.');
  } catch (err) {
    console.error('[ticker-v9] ОШИБКА:', err);
  }
})();