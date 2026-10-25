try { (function(){
  if (window.__navSortV2) return;
  window.__navSortV2 = true;

  const ORDER_KEY = 'dt_nav_order_v2';
  const DEFAULT_ORDER = ['nav-line', 'nav-report', 'nav-archive', 'nav-trucks', 'nav-analytics', 'nav-admin', 'nav-backup'];

  function getNav() { return document.getElementById('bottomNav'); }
  function getAllBtns() {
    const nav = getNav();
    if (!nav) return [];
    return Array.from(nav.querySelectorAll('.nav-btn'));
  }
  function readOrder() {
    try {
      const raw = localStorage.getItem(ORDER_KEY);
      if (!raw) return null;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      return arr;
    } catch(e) { return null; }
  }
  function saveOrder(arr) {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(arr)); } catch(e) {}
  }

  function applyOrder() {
    const nav = getNav();
    if (!nav) return;
    const order = readOrder();
    if (!order || !order.length) return; // не настроено — не трогаем

    const btns = getAllBtns();
    const map = {};
    btns.forEach(b => map[b.id] = b);

    const result = [];
    // Сначала по сохранённому порядку
    order.forEach(id => {
      if (map[id]) { result.push(map[id]); delete map[id]; }
    });
    // Оставшиеся (новые кнопки/плагины) — в конец
    Object.values(map).forEach(b => result.push(b));

    // Проверяем, нужна ли перестановка
    const currentIds = btns.map(b => b.id).join(',');
    const targetIds = result.map(b => b.id).join(',');
    if (currentIds === targetIds) return;

    // Переставляем
    result.forEach(b => nav.appendChild(b));
  }

  function buildOrderList() {
    const btns = getAllBtns();
    const stored = readOrder();
    const storedIds = stored ? stored.filter(id => btns.some(b => b.id === id)) : [];
    const remainingIds = btns.map(b => b.id).filter(id => !storedIds.includes(id));
    // Если stored нет — начинаем с текущего DOM-порядка
    if (!stored || !stored.length) {
      return btns.map(b => b.id);
    }
    return [...storedIds, ...remainingIds];
  }

  function renderSortUI() {
    const modalBody = document.querySelector('#settingsModal .modal-body');
    if (!modalBody) return;

    const existing = document.getElementById('nav-sort-block');
    if (existing) existing.remove();

    const block = document.createElement('div');
    block.id = 'nav-sort-block';
    block.style.cssText = 'margin-top: 20px; border-top: 2px solid var(--border); padding-top: 16px;';

    block.innerHTML = `
      <div class="settings-label" style="margin-bottom: 10px;">📱 Порядок вкладок</div>
      <div style="font-size: 11px; color: var(--muted); margin-bottom: 10px; line-height: 1.4;">Стрелками меняйте порядок. Применяется сразу. <b>Применяется только к этому устройству.</b></div>
      <div id="nav-sort-list"></div>
      <button class="btn btn-secondary btn-small" style="width: 100%; margin-top: 10px;" id="nav-sort-reset">↺ Сбросить (вернуть по умолчанию)</button>
    `;
    modalBody.appendChild(block);

    const list = block.querySelector('#nav-sort-list');

    function render() {
      const ids = buildOrderList();
      const btns = getAllBtns();
      const map = {};
      btns.forEach(b => map[b.id] = b);

      list.innerHTML = ids.map((id, idx) => {
        const btn = map[id];
        if (!btn) return '';
        const text = btn.querySelector('.nav-text')?.textContent || id.replace('nav-', '');
        const icon = btn.querySelector('.nav-icon')?.textContent || '';
        const isHidden = btn.classList.contains('perm-blocked') || btn.style.display === 'none';
        return `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 4px; ${isHidden ? 'opacity: 0.55;' : ''}">
            <span style="font-size: 13px;">${icon} ${text}${isHidden ? ' <span style="font-size: 10px; color: var(--muted);">(скрыта)</span>' : ''}</span>
            <div style="display: flex; gap: 4px;">
              <button class="btn btn-secondary btn-small" data-act="up" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''} style="padding: 4px 8px; min-height: 28px; min-width: 32px;">⬆️</button>
              <button class="btn btn-secondary btn-small" data-act="down" data-idx="${idx}" ${idx === ids.length - 1 ? 'disabled' : ''} style="padding: 4px 8px; min-height: 28px; min-width: 32px;">⬇️</button>
            </div>
          </div>
        `;
      }).join('');

      list.querySelectorAll('button[data-act]').forEach(b => {
        b.addEventListener('click', () => {
          const idx = parseInt(b.dataset.idx);
          const act = b.dataset.act;
          const target = act === 'up' ? idx - 1 : idx + 1;
          if (target < 0 || target >= ids.length) return;
          const tmp = ids[idx];
          ids[idx] = ids[target];
          ids[target] = tmp;
          saveOrder(ids);
          applyOrder();
          render();
        });
      });
    }
    render();

    block.querySelector('#nav-sort-reset').addEventListener('click', () => {
      localStorage.removeItem(ORDER_KEY);
      // Возвращаем дефолтный порядок
      const nav = getNav();
      if (nav) {
        const btns = getAllBtns();
        const map = {};
        btns.forEach(b => map[b.id] = b);
        DEFAULT_ORDER.forEach(id => {
          if (map[id]) { nav.appendChild(map[id]); delete map[id]; }
        });
        Object.values(map).forEach(b => nav.appendChild(b));
      }
      render();
      if (window.showToastEl) window.showToastEl('↺ Порядок сброшен по умолчанию', false);
    });
  }

  // Перехват открытия настроек
  const origOpen = window.openSettingsModal;
  window.openSettingsModal = function() {
    if (origOpen) origOpen.apply(this, arguments);
    setTimeout(renderSortUI, 80);
  };

  // Применение порядка при загрузке и периодически (для новых кнопок от плагинов)
  let applying = false;
  function safeApply() {
    if (applying) return;
    applying = true;
    try { applyOrder(); } finally { applying = false; }
  }

  setInterval(safeApply, 700);
  setTimeout(safeApply, 200);
  setTimeout(safeApply, 1000);
  setTimeout(safeApply, 2500);

  // При появлении новых кнопок в nav — пересортировать
  const navEl = document.getElementById('bottomNav');
  if (navEl && typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver(() => {
      if (applying) return;
      setTimeout(safeApply, 50);
    });
    obs.observe(navEl, { childList: true });
  }

  console.log('[nav-sort-v2] ✅ Сортировка вкладок активна. Ключ: ' + ORDER_KEY);
})();; }
catch (e) { console.error('[baked patch: Порядок кнопки]', e); }
