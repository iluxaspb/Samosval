// Полоса открытых смен вкладки «Линия» (design §10.1).
//
// Полоса — только переключатель: она показывает видимые пользователю смены в
// состояниях `active`/`closing` и атомарно меняет выбранный контекст. Ни одной
// команды транспорта и ни одной записи в офлайн-очередь вкладка не запускает —
// действия живут в карточках самосвалов выбранной смены.
//
// Переключение выполняется одной клиентской транзакцией: сначала store меняет
// `activeShiftId`, затем старая проекция полностью стирается и только после
// этого пишется проекция новой смены. Кадра со старыми данными под новой
// шапкой не существует, потому что очистка и проекция идут подряд, без
// промежуточной отрисовки.
//
// Файл — classic script (IIFE → globalThis), без сети. DOM инжектируется:
// модуль пользуется только createElement/appendChild/textContent/dataset/
// setAttribute/addEventListener/remove/scrollIntoView и mount.hidden.
(function (root) {
  'use strict';

  // В полосу попадают только открытые смены. `closed` и `historical` — история,
  // а восстановленный архив открывается отдельным режимом из «Архива».
  const VISIBLE_STATES = { active: true, closing: true };
  const DEFAULT_MIN_SHIFTS = 2;
  const SHIFT_TYPE_LABELS = { day: 'День', night: 'Ночь' };

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function shiftIdOf(row) {
    if (!isRecord(row)) return '';
    if (isNonEmptyString(row.shiftId)) return row.shiftId;
    return isNonEmptyString(row.id) ? row.id : '';
  }

  // Store нормализует состояние, но полоса не доверяет источнику: строка без
  // явного состояния выводится по тем же правилам, что в 40-shift-contexts.
  function stateOf(row) {
    if (isNonEmptyString(row.state)) return row.state;
    if (row.closing === true) return 'closing';
    if (row.isActive === false) return 'closed';
    return 'active';
  }

  function isRestoredArchive(row) {
    return (isRecord(row.restoredContext) && isNonEmptyString(row.restoredContext.archiveId))
      || row.restored === true;
  }

  function shiftTypeOf(row) {
    const type = row.shiftType || row.type || row.workShift;
    return isNonEmptyString(type) ? type : '';
  }

  function labelOf(row) {
    const name = isNonEmptyString(row.objectName) && row.objectName.trim()
      ? row.objectName.trim()
      : (isNonEmptyString(row.objectId) ? row.objectId : 'Смена');
    const typeLabel = SHIFT_TYPE_LABELS[shiftTypeOf(row)] || shiftTypeOf(row);
    return typeLabel ? name + ' · ' + typeLabel : name;
  }

  function createShiftSelector(options) {
    const config = options || {};
    const store = config.store;
    const doc = config.doc || config.document || root.document;
    const mount = config.mount;
    const legacyState = config.legacyState;
    const onSwitch = typeof config.onSwitch === 'function' ? config.onSwitch : function () {};
    const minShifts = Number.isSafeInteger(config.minShifts) && config.minShifts >= 0
      ? config.minShifts
      : DEFAULT_MIN_SHIFTS;
    if (!store || typeof store.visibleShifts !== 'function') throw new TypeError('shift-selector-requires-store');
    if (!doc || typeof doc.createElement !== 'function') throw new TypeError('shift-selector-requires-document');
    if (!mount) throw new TypeError('shift-selector-requires-mount');
    if (!isRecord(legacyState)) throw new TypeError('legacy-state-required');

    let entries = [];
    let selectedId = null;

    function offlineNow() {
      if (typeof config.offline === 'function') return config.offline() === true;
      return config.offline === true;
    }

    // Только видимые открытые смены: полоса фильтрует сама и не доверяет
    // источнику, даже если тот отдал закрытую, историческую или архивную строку.
    function visibleRows() {
      let raw = [];
      try {
        raw = store.visibleShifts();
      } catch (_) {
        raw = [];
      }
      const list = Array.isArray(raw) ? raw : [];
      const out = [];
      const seen = Object.create(null);
      for (const row of list) {
        if (!isRecord(row)) continue;
        const shiftId = shiftIdOf(row);
        if (!shiftId || seen[shiftId]) continue;
        if (!VISIBLE_STATES[stateOf(row)]) continue;
        if (isRestoredArchive(row)) continue;
        seen[shiftId] = true;
        out.push(Object.assign({}, row, { shiftId }));
      }
      return out;
    }

    function chooseSelection(rows) {
      const active = typeof store.activeShiftId === 'function' ? store.activeShiftId() : null;
      if (isNonEmptyString(active) && rows.some(row => row.shiftId === active)) return active;
      return rows.length ? rows[0].shiftId : null;
    }

    function badgeState(row) {
      let context = null;
      try {
        context = typeof store.context === 'function' ? store.context(row.shiftId) : null;
      } catch (_) {
        context = null;
      }
      const badge = context && isRecord(context.badge) ? context.badge : {};
      const pending = Number(badge.pending);
      // Непросмотренное действие другой смены: точка на вкладке. Время
      // действия и время просмотра приходят снаружи (store уведомлений и
      // локальная отметка устройства), полоса сама ничего не хранит.
      const actionAt = typeof config.lastActionAt === 'function' ? Number(config.lastActionAt(row.shiftId)) || 0 : 0;
      const seenAt = typeof config.seenAt === 'function' ? Number(config.seenAt(row.shiftId)) || 0 : 0;
      return {
        closing: stateOf(row) === 'closing' || badge.closing === true,
        conflict: badge.conflict === true,
        offline: badge.offline === true || offlineNow(),
        pending: Number.isFinite(pending) && pending > 0 ? Math.floor(pending) : 0,
        fresh: row.shiftId !== selectedId && actionAt > seenAt
      };
    }

    function badgeList(state) {
      const list = [];
      if (state.closing) list.push(['closing', 'закрывается']);
      if (state.conflict) list.push(['conflict', 'конфликт']);
      if (state.offline) list.push(['offline', 'офлайн']);
      if (state.fresh) list.push(['action', '•']);
      if (state.pending > 0) list.push(['pending', String(state.pending)]);
      return list;
    }

    function syncBadges(entry) {
      const state = badgeState(entry.row);
      entry.badgesEl.textContent = '';
      for (const [kind, text] of badgeList(state)) {
        const badge = doc.createElement('span');
        badge.className = 'shift-tab-badge shift-tab-' + kind;
        badge.textContent = text;
        if (kind === 'action') {
          badge.setAttribute('title', 'новое действие в этой смене');
          badge.setAttribute('aria-label', 'новое действие в этой смене');
        }
        entry.badgesEl.appendChild(badge);
      }
      entry.tab.className = 'shift-tab'
        + (entry.shiftId === selectedId ? ' is-active' : '')
        + (state.closing ? ' is-closing' : '')
        + (state.conflict ? ' is-conflict' : '');
    }

    function syncLabel(entry) {
      entry.labelEl.textContent = (entry.shiftId === selectedId ? '✓ ' : '') + labelOf(entry.row);
    }

    function syncVisuals() {
      for (const entry of entries) {
        entry.tab.setAttribute('aria-selected', entry.shiftId === selectedId ? 'true' : 'false');
        syncLabel(entry);
        syncBadges(entry);
      }
      // Выбранная смена считается просмотренной: её полоса уже показана,
      // поэтому точка непросмотренного действия на ней не нужна.
      if (selectedId && typeof config.markSeen === 'function') {
        try { config.markSeen(selectedId); } catch (_) { /* отметка просмотра не критична */ }
      }
    }

    // Выбранная вкладка доводится в видимую область. Вертикальная прокрутка
    // центра не трогается: block:'nearest' не прокручивает предков, а
    // window.scrollTo и mount.scrollTop здесь не используются вообще.
    function revealSelected() {
      const entry = entries.find(item => item.shiftId === selectedId);
      if (!entry || typeof entry.tab.scrollIntoView !== 'function') return;
      entry.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function render() {
      const rows = visibleRows();
      selectedId = chooseSelection(rows);
      mount.textContent = '';
      entries = [];
      if (rows.length < minShifts) {
        mount.hidden = true;
        return;
      }
      mount.hidden = false;
      for (const row of rows) {
        const tab = doc.createElement('button');
        tab.className = 'shift-tab';
        tab.setAttribute('type', 'button');
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', 'false');
        tab.dataset.shiftId = row.shiftId;
        const labelEl = doc.createElement('span');
        labelEl.className = 'shift-tab-label';
        const badgesEl = doc.createElement('span');
        badgesEl.className = 'shift-tab-badges';
        tab.appendChild(labelEl);
        tab.appendChild(badgesEl);
        tab.addEventListener('click', function () {
          if (typeof config.select === 'function') config.select(row.shiftId);
          else switchTo(row.shiftId);
        });
        mount.appendChild(tab);
        entries.push({ shiftId: row.shiftId, row, tab, labelEl, badgesEl });
      }
      syncVisuals();
      revealSelected();
    }

    // Проекция старого кода стирается целиком: под новой шапкой не может
    // остаться ни одного рейса и ни одного статуса прежней смены.
    function clearProjection() {
      legacyState.shift = null;
      legacyState.logs = [];
      legacyState.truckStatus = {};
      legacyState.status = {};
    }

    function switchTo(shiftId) {
      if (!isNonEmptyString(shiftId)) return false;
      const rows = visibleRows();
      if (!rows.some(row => row.shiftId === shiftId)) return false;
      if (store.selectShift(shiftId) === false) return false;
      clearProjection();
      store.projectActiveContextToLegacyState(legacyState);
      selectedId = shiftId;
      render();
      onSwitch(shiftId);
      return true;
    }

    function refreshBadges() {
      for (const entry of entries) syncBadges(entry);
    }

    function activeShiftId() {
      const rows = visibleRows();
      if (isNonEmptyString(selectedId) && rows.some(row => row.shiftId === selectedId)) return selectedId;
      return chooseSelection(rows);
    }

    function destroy() {
      if (mount) mount.textContent = '';
      entries = [];
      selectedId = null;
      mount.hidden = true;
    }

    return { render, switchTo, refreshBadges, activeShiftId, destroy };
  }

  const api = { createShiftSelector };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestShiftSelector = api;
})(typeof window !== 'undefined' ? window : globalThis);
