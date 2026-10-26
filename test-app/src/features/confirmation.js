try { (function(){
  if (window.__prettyConfirmV1) return;
  window.__prettyConfirmV1 = true;

  // ===== CSS =====
  const oldCss = document.getElementById('pretty-confirm-css');
  if (oldCss) oldCss.remove();

  const css = document.createElement('style');
  css.id = 'pretty-confirm-css';
  css.textContent = `
    /* Фон-затемнение с блюром */
    .pcm-overlay {
      position: fixed !important;
      inset: 0 !important;
      /* Account-disabled gate stays blocking underneath; logout confirmation must remain reachable. */
      z-index: 2147483647 !important;
      background: transparent !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      padding: 20px !important;
      opacity: 0 !important;
      transition: opacity 0.22s cubic-bezier(0.4, 0, 0.2, 1) !important;
      -webkit-backdrop-filter: none !important;
      backdrop-filter: none !important;
    }
    .pcm-overlay.pcm-open {
      opacity: 1 !important;
    }

    /* Карточка */
    .pcm-card {
      background: var(--card) !important;
      border: 1px solid var(--border) !important;
      border-radius: 18px !important;
      padding: 22px 20px 18px 20px !important;
      width: 100% !important;
      max-width: 380px !important;
      box-shadow:
        0 25px 60px rgba(0, 0, 0, 0.8),
        0 0 0 1px rgba(255, 255, 255, 0.04) inset !important;
      transform: scale(0.88) translateY(24px) !important;
      opacity: 0 !important;
      transition:
        transform 0.38s cubic-bezier(0.34, 1.56, 0.64, 1),
        opacity 0.22s cubic-bezier(0.4, 0, 0.2, 1) !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 16px !important;
    }
    .pcm-overlay.pcm-open .pcm-card {
      transform: scale(1) translateY(0) !important;
      opacity: 1 !important;
    }

    /* Иконка */
    .pcm-icon-wrap {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 56px !important;
      height: 56px !important;
      border-radius: 50% !important;
      margin: 0 auto 4px auto !important;
      font-size: 28px !important;
      line-height: 1 !important;
      background: rgba(59, 130, 246, 0.15) !important;
      border: 2px solid rgba(59, 130, 246, 0.35) !important;
      box-shadow: 0 0 20px rgba(59, 130, 246, 0.15) !important;
    }
    .pcm-icon-wrap.pcm-danger {
      background: rgba(239, 68, 68, 0.15) !important;
      border-color: rgba(239, 68, 68, 0.4) !important;
      box-shadow: 0 0 20px rgba(239, 68, 68, 0.2) !important;
    }
    .pcm-icon-wrap.pcm-warning {
      background: rgba(245, 158, 11, 0.15) !important;
      border-color: rgba(245, 158, 11, 0.4) !important;
      box-shadow: 0 0 20px rgba(245, 158, 11, 0.2) !important;
    }
    .pcm-icon-wrap.pcm-success {
      background: rgba(34, 197, 94, 0.15) !important;
      border-color: rgba(34, 197, 94, 0.4) !important;
      box-shadow: 0 0 20px rgba(34, 197, 94, 0.2) !important;
    }

    /* Заголовок */
    .pcm-title {
      font-size: 18px !important;
      font-weight: 800 !important;
      color: var(--text) !important;
      text-align: center !important;
      line-height: 1.3 !important;
      letter-spacing: -0.2px !important;
    }

    /* Текст */
    .pcm-message {
      font-size: 13.5px !important;
      line-height: 1.5 !important;
      color: var(--muted) !important;
      text-align: center !important;
      word-wrap: break-word !important;
    }
    .pcm-message b, .pcm-message strong {
      color: var(--text) !important;
      font-weight: 700 !important;
    }
    .pcm-message code {
      background: var(--bg) !important;
      padding: 1px 5px !important;
      border-radius: 4px !important;
      font-family: monospace !important;
      font-size: 12px !important;
      color: #93c5fd !important;
    }

    /* Кнопки */
    .pcm-actions {
      display: flex !important;
      gap: 8px !important;
      margin-top: 4px !important;
    }
    .pcm-btn {
      flex: 1 !important;
      min-height: 46px !important;
      padding: 10px 12px !important;
      border: none !important;
      border-radius: 12px !important;
      font-size: 14px !important;
      font-weight: 700 !important;
      cursor: pointer !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 6px !important;
      transition: transform 0.12s ease, opacity 0.12s ease, box-shadow 0.15s ease !important;
      -webkit-tap-highlight-color: transparent !important;
    }
    .pcm-btn:active {
      transform: scale(0.96) !important;
      opacity: 0.9 !important;
    }
    .pcm-btn-cancel {
      background: var(--border) !important;
      color: var(--text) !important;
    }
    .pcm-btn-cancel:active {
      background: #475569 !important;
    }
    .pcm-btn-confirm {
      background: var(--primary) !important;
      color: #fff !important;
      box-shadow: 0 4px 14px rgba(59, 130, 246, 0.35) !important;
    }
    .pcm-btn-confirm.pcm-danger {
      background: var(--danger) !important;
      box-shadow: 0 4px 14px rgba(239, 68, 68, 0.4) !important;
    }
    .pcm-btn-confirm.pcm-success {
      background: var(--success) !important;
      box-shadow: 0 4px 14px rgba(34, 197, 94, 0.4) !important;
    }
    .pcm-btn-confirm.pcm-warning {
      background: var(--warning) !important;
      color: #000 !important;
      box-shadow: 0 4px 14px rgba(245, 158, 11, 0.4) !important;
    }

    /* Адаптив под очень маленькие экраны */
    @media (max-width: 340px) {
      .pcm-card { padding: 18px 14px 14px 14px !important; border-radius: 14px !important; }
      .pcm-icon-wrap { width: 48px !important; height: 48px !important; font-size: 24px !important; }
      .pcm-title { font-size: 16px !important; }
      .pcm-message { font-size: 12.5px !important; }
      .pcm-btn { min-height: 42px !important; font-size: 13px !important; }
    }
  `;
  document.head.appendChild(css);

  // ===== showConfirmModal =====
  // opts: {
  //   confirmLabel: 'Да',
  //   cancelLabel: 'Отмена',
  //   danger: false,       // → красная кнопка + красная иконка
  //   variant: 'primary' | 'danger' | 'success' | 'warning',  // альтернатива
  //   icon: '❓' | '⚠️' | ...,
  //   hideCancel: false     // если нужен только «ОК»
  // }
  window.showConfirmModal = function(title, message, opts) {
    opts = opts || {};
    const confirmLabel = opts.confirmLabel || 'Подтвердить';
    const cancelLabel = opts.cancelLabel || 'Отмена';
    const hideCancel = !!opts.hideCancel;
    const icon = opts.icon || '❓';

    // Определяем вариант
    let variant = opts.variant || (opts.danger ? 'danger' : 'primary');
    // Legacy: danger → красная кнопка
    if (opts.danger === true && !opts.variant) variant = 'danger';

    return new Promise(resolve => {
      // Уже есть открытый — принудительно закрываем
      if(window.__closeActiveConfirmation)window.__closeActiveConfirmation(false);

      const overlay = document.createElement('div');
      overlay.className = 'pcm-overlay';

      const card = document.createElement('div');
      card.className = 'pcm-card';

      const iconCls = variant === 'danger' ? 'pcm-danger'
                     : variant === 'warning' ? 'pcm-warning'
                     : variant === 'success' ? 'pcm-success' : '';

      const btnConfirmCls = 'pcm-btn-confirm ' + (
        variant === 'danger' ? 'pcm-danger'
        : variant === 'success' ? 'pcm-success'
        : variant === 'warning' ? 'pcm-warning' : ''
      );

      card.innerHTML = `
        <div class="pcm-icon-wrap ${iconCls}">${icon}</div>
        <div class="pcm-title"></div>
        <div class="pcm-message"></div>
        <div class="pcm-actions">
          ${hideCancel ? '' : `<button class="pcm-btn pcm-btn-cancel"></button>`}
          <button class="pcm-btn ${btnConfirmCls}"></button>
        </div>
      `;

      card.querySelector('.pcm-title').textContent = title || '';
      // message разрешаем с HTML
      card.querySelector('.pcm-message').innerHTML = message || '';
      if (!hideCancel) card.querySelector('.pcm-btn-cancel').textContent = cancelLabel;
      card.querySelector('.pcm-btn-confirm').textContent = confirmLabel;

      overlay.appendChild(card);
      document.body.appendChild(overlay);

      // Хелпер закрытия
      let closed = false;
      let openFrame = null, focusTimer = null;
      function isActive() {
        return !closed && window.__closeActiveConfirmation === close && overlay.isConnected;
      }
      function close(result) {
        if (closed) return;
        closed = true;
        if (openFrame !== null) { cancelAnimationFrame(openFrame); openFrame = null; }
        if (focusTimer !== null) { clearTimeout(focusTimer); focusTimer = null; }
        document.removeEventListener('keydown',onKey);
        if(window.__closeActiveConfirmation===close)window.__closeActiveConfirmation=null;
        overlay.classList.remove('pcm-open');
        setTimeout(() => {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          resolve(result);
        }, 280);
      }

      // Кнопки
      if (!hideCancel) {
        card.querySelector('.pcm-btn-cancel').addEventListener('click', () => close(false));
      }
      card.querySelector('.pcm-btn-confirm').addEventListener('click', () => close(true));

      window.__closeActiveConfirmation=close;
      // A backdrop click or replacement can close this instance before its frame.
      openFrame = requestAnimationFrame(() => {
        openFrame = null;
        if (isActive()) overlay.classList.add('pcm-open');
      });
      // Клик по фону — отмена
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });

      // Escape — отмена, Enter — подтверждение
      function onKey(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(false); }
        else if (e.key === 'Enter') { document.removeEventListener('keydown', onKey); close(true); }
      }
      document.addEventListener('keydown', onKey);

      // Фокус на подтверждение для accessibility
      focusTimer = setTimeout(() => {
        focusTimer = null;
        if (!isActive()) return;
        try { card.querySelector('.pcm-btn-confirm').focus({ preventScroll: true }); } catch(e) {}
      }, 100);
    });
  };

  // ===== Алиас на всякий случай =====
  window.confirmModal = window.showConfirmModal;

  console.log('[pretty-confirm] ✅ Красивое окно подтверждения готово.');
})();; }
catch (e) { console.error('[baked patch: Красивое окно подтверждениия]', e); }
