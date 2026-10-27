(function(){
  if (window.__resetHoldV5) return;
  window.__resetHoldV5 = true;

  // ===== Значение по умолчанию для holdResetCycle =====
  (function initDefault() {
    try {
      const stored = JSON.parse(localStorage.getItem('dt_settings') || '{}');
      if (typeof stored.holdResetCycle === 'undefined') {
        stored.holdResetCycle = 0.5;
        localStorage.setItem('dt_settings', JSON.stringify(stored));
      }
    } catch(e) {}
  })();

  function getHoldResetCycle() {
    try {
      const stored = JSON.parse(localStorage.getItem('dt_settings') || '{}');
      const v = parseFloat(stored.holdResetCycle);
      return (!isNaN(v) && v >= 0.1) ? v : 0.5;
    } catch(e) { return 0.5; }
  }

  // ===== CSS =====
  ['reset-via-cooldown-css', 'reset-hold-css', 'reset-hold-v4-css', 'reset-hold-v5-css'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });

  const css = document.createElement('style');
  css.id = 'reset-hold-v5-css';
  css.textContent = `
    /* Кнопка Ходка в кулдауне для админа — выглядит как у лопатёров */
    .btn-arrive.admin-can-hold {
      background: #475569 !important;
      color: #94a3b8 !important;
      opacity: 0.6 !important;
      cursor: pointer !important;
      pointer-events: auto !important;
      touch-action: none !important;
      position: relative !important;
      overflow: hidden !important;
      user-select: none !important;
      -webkit-user-select: none !important;
    }
    /* Прогресс-бар удержания — фиолетовый */
    .btn-arrive.admin-can-hold::after {
      content: "" !important;
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      bottom: 0 !important;
      background: rgba(139, 92, 246, 0.6) !important;
      width: 0% !important;
      z-index: 0 !important;
      pointer-events: none !important;
    }
    .btn-arrive.admin-can-hold.admin-holding::after {
      width: 100% !important;
      transition: width var(--hold-duration, 0.5s) linear !important;
    }
    .btn-arrive.admin-can-hold > span {
      position: relative !important;
      z-index: 1 !important;
    }
    /* Лёгкое сжатие при нажатии, без изменения цвета */
    .btn-arrive.admin-can-hold:active {
      transform: scale(0.98) !important;
    }
  `;
  document.head.appendChild(css);

  // ===== Функция сброса =====
  window.resetCycleViaCooldown = async function(truckId) {
    if (!canAdmin()) { showError('Только для администратора'); return; }
    const st = state.truckStatus[truckId];
    if (!st) return;
    const t = findTruck(truckId);
    const tName = t ? `${t.brand} ${t.number}` : 'Машина';

    let ok;
    if (typeof window.showConfirmModal === 'function') {
      ok = await window.showConfirmModal(
        'Сбросить таймер ходки?',
        `Машина <b>${tName}</b> недавно грузилась. Сброс обнулит таймер, и кнопка «Приехал» станет доступна сразу.`,
        { confirmLabel: '🔄 Да, сбросить', cancelLabel: 'Отмена', danger: true, icon: '⏱' }
      );
    } else {
      ok = (await appConfirm(`Сбросить таймер ходки для ${tName}?`));
    }
    if (!ok) return;

    offlineQueueAction('reset',truckId,captureLineIntent(truckId));
  };

  // ===== Удержание =====
  const holdState = { truckId: null, btn: null, timer: null, vibInt: null, pointerId: null };

  function startHold(truckId, btn, pointerId) {
    cancelHold(true);
    holdState.truckId = truckId;
    holdState.btn = btn;
    holdState.pointerId = pointerId;

    const hs = getHoldResetCycle();

    if (navigator.vibrate) {
      try { navigator.vibrate(20); } catch(e) {}
      holdState.vibInt = setInterval(() => { try { navigator.vibrate(25); } catch(e) {} }, 120);
    }

    btn.style.setProperty('--hold-duration', hs + 's');
    btn.classList.add('admin-holding');

    holdState.timer = setTimeout(() => {
      const tid = holdState.truckId;
      finishHold();
      if (tid) window.resetCycleViaCooldown(tid);
    }, hs * 1000);
  }

  function cancelHold(removeClass) {
    if (holdState.timer) { clearTimeout(holdState.timer); holdState.timer = null; }
    if (holdState.vibInt) { clearInterval(holdState.vibInt); holdState.vibInt = null; }
    if (removeClass !== false && holdState.btn) {
      try { holdState.btn.classList.remove('admin-holding'); } catch(e) {}
    }
    holdState.truckId = null;
    holdState.btn = null;
    holdState.pointerId = null;
  }

  function finishHold() {
    if (holdState.timer) { clearTimeout(holdState.timer); holdState.timer = null; }
    if (holdState.vibInt) { clearInterval(holdState.vibInt); holdState.vibInt = null; }
    if (holdState.btn) { try { holdState.btn.classList.remove('admin-holding'); } catch(e) {} }
    holdState.truckId = null;
    holdState.btn = null;
    holdState.pointerId = null;
  }

  function isCooldownArrive(btn) {
    if (!btn) return false;
    if (btn.querySelector('[data-load-ts]')) return true;
    if (btn.querySelector('.cooldown-timer')) return true;
    if ((btn.textContent || '').includes('Ходка')) return true;
    return false;
  }

  document.addEventListener('pointerdown', (e) => {
    if (!canAdmin()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const btn = e.target.closest('.btn-arrive');
    if (!btn) return;
    if (!isCooldownArrive(btn)) return;
    const card = btn.closest('.truck-card[data-truck-id]');
    if (!card) return;
    const truckId = card.dataset.truckId;
    if (!truckId) return;
    e.preventDefault();
    e.stopPropagation();
    startHold(truckId, btn, e.pointerId);
  }, { capture: true, passive: false });

  document.addEventListener('pointerup', (e) => {
    if (holdState.pointerId === e.pointerId) cancelHold();
  }, { capture: true });

  document.addEventListener('pointercancel', (e) => {
    if (holdState.pointerId === e.pointerId) cancelHold();
  }, { capture: true });

  // ===== Отметка кнопок =====
  function markCooldownButtons() {
    const list = document.getElementById('trucksLineList');
    if (!list) return;
    list.querySelectorAll('.truck-card[data-truck-id] .btn-arrive').forEach(btn => {
      if (isCooldownArrive(btn)) {
        if (canAdmin()) btn.classList.add('admin-can-hold');
        else btn.classList.remove('admin-can-hold');
      } else {
        btn.classList.remove('admin-can-hold');
      }
    });
  }

  let listObs = null;
  function attachObs() {
    const list = document.getElementById('trucksLineList');
    if (!list || list.dataset.resetObsV5 === '1') return;
    list.dataset.resetObsV5 = '1';
    if (listObs) listObs.disconnect();
    listObs = new MutationObserver(() => markCooldownButtons());
    listObs.observe(list, { childList: true, subtree: true });
  }

  const origRenderLine = window.renderLine;
  if (origRenderLine) {
    window.renderLine = function() {
      origRenderLine.apply(this, arguments);
      setTimeout(markCooldownButtons, 20);
      setTimeout(markCooldownButtons, 100);
      setTimeout(markCooldownButtons, 300);
    };
  }

  setInterval(() => { attachObs(); markCooldownButtons(); }, 500);
  setTimeout(attachObs, 100);
  setTimeout(markCooldownButtons, 500);
  setTimeout(markCooldownButtons, 1500);

  // ===== Настройка в шестерёнке (только админ) =====
  function addSettingToModal() {
    if (!canAdmin()) return;
    const modalBody = document.querySelector('#settingsModal .modal-body');
    if (!modalBody) return;
    if (document.getElementById('setting-hold-reset-group')) return;

    const group = document.createElement('div');
    group.className = 'form-group';
    group.id = 'setting-hold-reset-group';
    group.innerHTML = `
      <label>🔄 Удержание «Сброс таймера» (сек)</label>
      <input type="number" step="0.1" min="0.1" max="5" id="settingHoldResetCycle" class="form-control">
      <div style="font-size:10px;color:var(--muted);margin-top:4px;">Только для админа. Кнопка «Ходка» при активном таймере.</div>
    `;

    const cycleGroup = document.getElementById('settingCycleMinutes')?.closest('.form-group');
    if (cycleGroup && cycleGroup.parentNode === modalBody) {
      cycleGroup.parentNode.insertBefore(group, cycleGroup.nextSibling);
    } else {
      modalBody.appendChild(group);
    }

    const inp = group.querySelector('#settingHoldResetCycle');
    inp.value = getHoldResetCycle();

    inp.addEventListener('change', () => {
      let v = parseFloat(inp.value);
      if (isNaN(v)) v = 0.5;
      v = Math.max(0.1, Math.min(5, v));
      v = Math.round(v * 10) / 10;

      const stored = JSON.parse(localStorage.getItem('dt_settings') || '{}');
      stored.holdResetCycle = v;
      localStorage.setItem('dt_settings', JSON.stringify(stored));
      settings.holdResetCycle = v;
      inp.value = v;

      if (window.showToastEl) window.showToastEl('⏱ Удержание сброса: ' + v + 'с', false);
    });
  }

  const origOpenSettings = window.openSettingsModal;
  window.openSettingsModal = function() {
    if (origOpenSettings) origOpenSettings.apply(this, arguments);
    setTimeout(addSettingToModal, 30);
    setTimeout(addSettingToModal, 150);
  };

  console.log('[reset-hold-v5] ✅ Активен. Настройка удержания (админ).');
})();