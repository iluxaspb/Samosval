// Клиентский store контекстов параллельных смен.
//
// Каждая открытая смена живёт в собственном контексте: снимок, ревизии,
// формы, прокрутка, фокус, inflight-запросы и офлайн-очередь. Смена A никогда
// не читает и не меняет данные смены B. Выбранная смена — единственный
// источник для видимого экрана; `state.shift/logs/status` — только проекция.
//
// Ответ применяется лишь по полному generation-ключу
// uid/workspace/shift/requestKind. Поздний ответ отклоняется.
(function (root) {
  'use strict';

  const SELECTION_PREFIX = 'samosval:shift-contexts:selection:';
  const VISIBLE_STATES = { active: true, closing: true };

  function scopeStorageKey(uid, workspaceId) {
    return SELECTION_PREFIX + uid + '/' + workspaceId;
  }

  // Копия без общих ссылок: проекция и чтение не должны давать доступ к
  // внутреннему состоянию store.
  function copy(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    try {
      if (typeof structuredClone === 'function') return structuredClone(value);
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  // '2026-11-28' → '28.11.2026' — формат, который старый код показывает в
  // отчётах и печатных формах (`state.shift.startDate`).
  function moscowDateText(value) {
    if (typeof value !== 'string') return undefined;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? `${match[3]}.${match[2]}.${match[1]}` : undefined;
  }

  function normalizeShift(row) {
    if (!row || typeof row !== 'object') return null;
    const shiftId = typeof row.shiftId === 'string' && row.shiftId
      ? row.shiftId
      : (typeof row.id === 'string' ? row.id : '');
    if (!shiftId) return null;
    let state = typeof row.state === 'string' ? row.state : '';
    if (!state) state = row.closing ? 'closing' : (row.isActive === false ? 'closed' : 'active');
    return Object.assign({}, row, { shiftId, state });
  }

  function visibleShift(row) {
    const shift = normalizeShift(row);
    return shift && VISIBLE_STATES[shift.state] ? shift : null;
  }

  function emptyContext(shift) {
    return {
      shiftId: shift.shiftId,
      shift: copy(shift),
      loaded: false,
      stale: false,
      snapshot: null,
      revisions: {},
      serverGeneration: null,
      ui: { forms: {}, scroll: null, focus: null },
      inflight: {},
      pending: [],
      badge: { pending: 0, closing: shift.state === 'closing', conflict: false, updatedAt: 0 }
    };
  }

  function pendingServerReceiptCount(snapshot) {
    const receipts = snapshot && snapshot.pendingServerReceipts;
    if (Array.isArray(receipts)) return receipts.length;
    return Math.max(0, numberOrZero(receipts));
  }

  function snapshotRevision(snapshot) {
    if (!snapshot) return 0;
    if (snapshot.shiftRevision !== undefined) return numberOrZero(snapshot.shiftRevision);
    return numberOrZero(snapshot.revisions && snapshot.revisions.shift);
  }

  function createShiftContextStore(options) {
    const config = options || {};
    const uid = config.uid;
    const workspaceId = config.workspaceId;
    if (typeof uid !== 'string' || !uid) throw new TypeError('shift-contexts-require-uid');
    if (typeof workspaceId !== 'string' || !workspaceId) throw new TypeError('shift-contexts-require-workspace');
    const storage = config.storage || null;
    const storageKey = scopeStorageKey(uid, workspaceId);

    let visible = [];
    let visibleById = Object.create(null);
    let contexts = Object.create(null);
    let activeShiftId = null;
    let restoredContext = null;
    let detachedTrips = Object.create(null);
    const generations = Object.create(null);

    function readSelection() {
      if (!storage) return null;
      try {
        const raw = storage.getItem(storageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.uid !== uid || parsed.workspaceId !== workspaceId) return null;
        return typeof parsed.shiftId === 'string' && parsed.shiftId ? parsed.shiftId : null;
      } catch (_) {
        return null;
      }
    }

    function writeSelection(shiftId) {
      if (!storage) return;
      try {
        if (shiftId) storage.setItem(storageKey, JSON.stringify({ uid, workspaceId, shiftId }));
        else storage.removeItem(storageKey);
      } catch (_) { /* переполненное хранилище не должно ломать выбор смены */ }
    }

    // Сохранённый выбор применяется только после того, как сервер подтвердил
    // видимость смены. Архивная смена сюда попасть не может.
    let pendingSelection = readSelection();

    function visibleShifts() {
      return copy(visible);
    }

    function context(shiftId) {
      const found = contexts[shiftId];
      return found ? copy(found) : null;
    }

    function visibleContext() {
      return activeShiftId ? context(activeShiftId) : null;
    }

    function activeId() {
      return activeShiftId;
    }

    function restored() {
      return restoredContext ? copy(restoredContext) : null;
    }

    function replaceVisibleShifts(rows) {
      const list = Array.isArray(rows) ? rows : [];
      const next = [];
      const nextById = Object.create(null);
      for (const row of list) {
        const shift = visibleShift(row);
        if (!shift || nextById[shift.shiftId]) continue;
        next.push(shift);
        nextById[shift.shiftId] = shift;
      }
      visible = next;
      visibleById = nextById;

      // Контекст скрытой или архивной смены не должен оставаться доступным.
      Object.keys(contexts).forEach(shiftId => {
        if (!nextById[shiftId]) delete contexts[shiftId];
      });
      for (const shift of next) {
        const existing = contexts[shift.shiftId];
        if (existing) {
          existing.shift = copy(shift);
          existing.badge.closing = shift.state === 'closing';
        } else {
          contexts[shift.shiftId] = emptyContext(shift);
        }
      }

      let candidate = activeShiftId && nextById[activeShiftId] ? activeShiftId : null;
      if (!candidate && pendingSelection && nextById[pendingSelection]) candidate = pendingSelection;
      if (!candidate && next.length) candidate = next[0].shiftId;
      pendingSelection = null;
      activeShiftId = candidate;

      // Устаревший сохранённый выбор убираем, чтобы он не ждал смену вечно.
      const stored = readSelection();
      if (stored && !nextById[stored]) writeSelection(null);
      return visibleShifts();
    }

    function selectShift(shiftId) {
      if (typeof shiftId !== 'string' || !visibleById[shiftId]) return false;
      activeShiftId = shiftId;
      writeSelection(shiftId);
      return true;
    }

    function beginRequest(input, maybeKind) {
      const shiftId = typeof input === 'string' ? input : (input && input.shiftId);
      const requestKind = typeof input === 'string' ? maybeKind : (input && input.requestKind);
      if (typeof shiftId !== 'string' || !shiftId || typeof requestKind !== 'string' || !requestKind) {
        throw new TypeError('shift-context-request-requires-shift-and-kind');
      }
      const target = contexts[shiftId];
      if (!target) return null;
      const key = shiftId + '|' + requestKind;
      generations[key] = (generations[key] || 0) + 1;
      const token = { uid, workspaceId, shiftId, requestKind, generation: generations[key] };
      target.inflight[requestKind] = token;
      return copy(token);
    }

    function validateGeneration(generation, shiftId, requestKind) {
      if (!generation || typeof generation !== 'object') return 'invalid-generation';
      if (generation.uid !== uid || generation.workspaceId !== workspaceId) return 'foreign-generation-scope';
      if (generation.shiftId !== shiftId) return 'generation-shift-mismatch';
      if (generation.requestKind !== requestKind) return 'generation-kind-mismatch';
      const target = contexts[shiftId];
      const current = target && target.inflight[requestKind];
      if (!current || current.generation !== generation.generation) return 'stale-generation';
      return null;
    }

    function indexDetachedTrips(shiftId, rows) {
      Object.keys(detachedTrips).forEach(key => {
        const trip = detachedTrips[key];
        if (!trip) return;
        if (trip.sourceShiftId === shiftId || trip.destinationShiftId === shiftId) delete detachedTrips[key];
      });
      (Array.isArray(rows) ? rows : []).forEach(row => {
        if (!row || typeof row !== 'object') return;
        if (typeof row.sourceShiftId !== 'string' || !row.sourceShiftId) return;
        if (typeof row.cycleId !== 'string' || !row.cycleId) return;
        detachedTrips[row.sourceShiftId + ':' + row.cycleId] = copy(row);
      });
    }

    function applySnapshotData(target, snapshot, incomingRevision) {
      target.snapshot = copy(snapshot);
      if (snapshot.shift) target.shift = copy(snapshot.shift);
      target.revisions = copy(snapshot.revisions || {});
      target.revisions.shift = incomingRevision;
      target.serverGeneration = snapshot.serverGeneration === undefined ? null : snapshot.serverGeneration;
      target.loaded = true;
      target.stale = false;
      target.badge.conflict = false;
      target.badge.closing = target.shift && target.shift.state === 'closing';
      target.badge.pending = target.pending.length + pendingServerReceiptCount(snapshot);
      target.badge.updatedAt = Date.now();
      indexDetachedTrips(target.shiftId, snapshot.detachedOpenTrips);
    }

    function applySnapshot(input) {
      const request = input || {};
      const generation = request.generation;
      const shiftId = generation && generation.shiftId;
      if (typeof shiftId !== 'string' || !contexts[shiftId]) {
        return { applied: false, reason: 'shift-not-visible', shiftId: shiftId || null };
      }
      const requestKind = generation.requestKind;
      const invalid = validateGeneration(generation, shiftId, requestKind);
      if (invalid) return { applied: false, reason: invalid, shiftId };

      const snapshot = request.snapshot;
      if (!snapshot || typeof snapshot !== 'object') return { applied: false, reason: 'invalid-snapshot', shiftId };
      if (snapshot.shiftId !== shiftId) return { applied: false, reason: 'snapshot-shift-mismatch', shiftId };
      if (snapshot.workspaceId && snapshot.workspaceId !== workspaceId) {
        return { applied: false, reason: 'snapshot-workspace-mismatch', shiftId };
      }

      const target = contexts[shiftId];
      const incomingRevision = snapshotRevision(snapshot);
      const currentRevision = numberOrZero(target.revisions.shift);
      if (target.loaded && incomingRevision < currentRevision) {
        delete target.inflight[requestKind];
        target.stale = true;
        target.badge.conflict = true;
        return { applied: false, reason: 'stale-shift-revision', shiftId, currentRevision, incomingRevision };
      }

      applySnapshotData(target, snapshot, incomingRevision);
      delete target.inflight[requestKind];
      return { applied: true, shiftId, revision: incomingRevision, visible: shiftId === activeShiftId };
    }

    function applyCrossShiftResult(input) {
      const request = input || {};
      const sourceShiftId = request.sourceShiftId;
      const destinationShiftId = request.destinationShiftId;
      const requestKind = request.requestKind;
      const refresh = [sourceShiftId, destinationShiftId].filter(Boolean);
      const fail = reason => {
        refresh.forEach(shiftId => {
          const target = contexts[shiftId];
          if (!target) return;
          target.stale = true;
          target.badge.conflict = true;
          if (requestKind && target.inflight[requestKind]) delete target.inflight[requestKind];
        });
        return { applied: false, reason, refresh: copy(refresh) };
      };
      if (typeof sourceShiftId !== 'string' || typeof destinationShiftId !== 'string'
        || !sourceShiftId || !destinationShiftId || sourceShiftId === destinationShiftId
        || typeof requestKind !== 'string' || !requestKind) {
        return fail('invalid-cross-shift-key');
      }
      if (!contexts[sourceShiftId] || !contexts[destinationShiftId]) return fail('shift-not-visible');

      const sourceInvalid = validateGeneration(request.sourceGeneration, sourceShiftId, requestKind);
      if (sourceInvalid) return fail(sourceInvalid);
      const destinationInvalid = validateGeneration(request.destinationGeneration, destinationShiftId, requestKind);
      if (destinationInvalid) return fail(destinationInvalid);

      const source = contexts[sourceShiftId];
      const destination = contexts[destinationShiftId];
      const expectedSource = request.sourceRevision === undefined ? numberOrZero(source.revisions.shift) : numberOrZero(request.sourceRevision);
      const expectedDestination = request.destinationRevision === undefined ? numberOrZero(destination.revisions.shift) : numberOrZero(request.destinationRevision);
      if (expectedSource !== numberOrZero(source.revisions.shift)
        || expectedDestination !== numberOrZero(destination.revisions.shift)) {
        return fail('stale-cross-shift-result');
      }

      // Оба снимка проверяются до применения: частичный результат запрещён.
      const sourceSnapshot = request.sourceSnapshot;
      const destinationSnapshot = request.destinationSnapshot;
      if (sourceSnapshot) {
        if (sourceSnapshot.shiftId !== sourceShiftId) return fail('snapshot-shift-mismatch');
        if (sourceSnapshot.workspaceId && sourceSnapshot.workspaceId !== workspaceId) return fail('snapshot-workspace-mismatch');
      }
      if (destinationSnapshot) {
        if (destinationSnapshot.shiftId !== destinationShiftId) return fail('snapshot-shift-mismatch');
        if (destinationSnapshot.workspaceId && destinationSnapshot.workspaceId !== workspaceId) return fail('snapshot-workspace-mismatch');
      }

      if (sourceSnapshot) applySnapshotData(source, sourceSnapshot, snapshotRevision(sourceSnapshot));
      if (destinationSnapshot) applySnapshotData(destination, destinationSnapshot, snapshotRevision(destinationSnapshot));
      delete source.inflight[requestKind];
      delete destination.inflight[requestKind];
      return { applied: true, sourceShiftId, destinationShiftId };
    }

    function withContext(shiftId, mutate) {
      const target = contexts[shiftId];
      if (!target) return false;
      mutate(target);
      return true;
    }

    function setForm(shiftId, formKey, value) {
      if (typeof formKey !== 'string' || !formKey) return false;
      return withContext(shiftId, target => {
        if (value === undefined) delete target.ui.forms[formKey];
        else target.ui.forms[formKey] = copy(value);
      });
    }

    function setScroll(shiftId, position) {
      return withContext(shiftId, target => {
        target.ui.scroll = position === undefined ? null : copy(position);
      });
    }

    function setFocus(shiftId, focus) {
      return withContext(shiftId, target => {
        target.ui.focus = focus === undefined ? null : copy(focus);
      });
    }

    function updateUi(shiftId, patch) {
      if (!patch || typeof patch !== 'object') return false;
      return withContext(shiftId, target => {
        if (patch.forms && typeof patch.forms === 'object') target.ui.forms = copy(patch.forms);
        if ('scroll' in patch) target.ui.scroll = patch.scroll === undefined ? null : copy(patch.scroll);
        if ('focus' in patch) target.ui.focus = patch.focus === undefined ? null : copy(patch.focus);
      });
    }

    function setPending(shiftId, rows) {
      const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
      return withContext(shiftId, target => {
        target.pending = copy(list);
        target.badge.pending = target.pending.length + pendingServerReceiptCount(target.snapshot);
      });
    }

    function setRestoredContext(value) {
      if (!value || typeof value !== 'object' || typeof value.archiveId !== 'string' || !value.archiveId) {
        throw new TypeError('restored-context-requires-archive-id');
      }
      restoredContext = copy(value);
      return restored();
    }

    function detachedTrip(sourceShiftId, cycleId) {
      if (typeof sourceShiftId !== 'string' || typeof cycleId !== 'string') return null;
      const trip = detachedTrips[sourceShiftId + ':' + cycleId];
      return trip ? copy(trip) : null;
    }

    function detachedTripsFor(shiftId) {
      return copy(Object.keys(detachedTrips)
        .map(key => detachedTrips[key])
        .filter(trip => trip && (trip.sourceShiftId === shiftId || trip.destinationShiftId === shiftId)));
    }

    function clearSession() {
      visible = [];
      visibleById = Object.create(null);
      contexts = Object.create(null);
      activeShiftId = null;
      restoredContext = null;
      detachedTrips = Object.create(null);
      pendingSelection = null;
      Object.keys(generations).forEach(key => delete generations[key]);
      writeSelection(null);
    }

    // Старый код читает смену плоскими полями (`isActive`, `startDate`,
    // `workShift`, `startedAt`), а v2-снимок отдаёт `state` и вложенный
    // `payload`. Без совместимых полей экран игр считает смену закрытой,
    // отчёты печатают пустую дату, авто-бэкап не видит активную смену.
    // Дополняются только отсутствующие поля: значения v2 не перезаписываются.
    function legacyShiftView(shift, shiftId) {
      const view = copy(shift);
      const payload = view.payload && typeof view.payload === 'object' ? view.payload : {};
      const fill = (key, value) => {
        if (view[key] === undefined || view[key] === null) view[key] = value;
      };
      view.id = shiftId;
      const shiftState = typeof view.state === 'string' ? view.state : (payload.state || '');
      fill('isActive', shiftState === 'active' || shiftState === 'closing');
      fill('closing', shiftState === 'closing' || payload.closing === true);
      fill('startDate', payload.startDate || moscowDateText(view.workDate || payload.workDate));
      fill('date', payload.date || view.workDate);
      fill('workShift', view.shiftType || payload.workShift || payload.type);
      fill('type', view.shiftType || payload.type || payload.workShift);
      // analytics-v2 считает длительность как `Date.now() - startedAt`, то есть
      // ждёт миллисекунды, а не ISO-строку `openedAt`.
      if (typeof view.startedAt !== 'number') {
        const started = Number(payload.startedAt);
        const opened = Date.parse(view.openedAt || '');
        view.startedAt = Number.isFinite(started) && started > 0
          ? started
          : (Number.isFinite(opened) ? opened : null);
      }
      return view;
    }

    // Единственная совместимая проекция для старого кода. Пишет копии, а не
    // ссылки: изменить store через legacy-объект нельзя. Источник истины —
    // контекст выбранной смены, а не state.
    function projectActiveContextToLegacyState(legacyState) {
      if (!legacyState || typeof legacyState !== 'object') throw new TypeError('legacy-state-required');
      const target = activeShiftId ? contexts[activeShiftId] : null;
      const snapshot = target && target.snapshot;
      // Старый код адресует смену полем `id` (getLogs, captureLineIntent,
      // офлайн-очередь). v2-документ несёт `shiftId`, поэтому проекция обязана
      // дать оба поля: иначе выбранная смена выглядит «без id» и действия
      // уходят без shiftId.
      legacyState.shift = target ? legacyShiftView(target.shift, target.shiftId) : null;
      legacyState.logs = snapshot && Array.isArray(snapshot.logs) ? copy(snapshot.logs) : [];
      const truckStatus = {};
      const statuses = snapshot && Array.isArray(snapshot.statuses) ? snapshot.statuses : [];
      statuses.forEach(row => {
        if (!row || typeof row !== 'object') return;
        const id = row.id || row.truckId;
        if (!id) return;
        truckStatus[id] = copy(Object.assign({}, row, { id }));
      });
      legacyState.truckStatus = truckStatus;
      // Совместимость: в описании задачи поле называется status, фактический
      // legacy-код читает truckStatus. Оба поля — копии одного снимка.
      legacyState.status = copy(truckStatus);
      return legacyState;
    }

    return {
      replaceVisibleShifts,
      selectShift,
      beginRequest,
      applySnapshot,
      applyCrossShiftResult,
      visibleShifts,
      visibleContext,
      activeShiftId: activeId,
      context,
      setForm,
      setScroll,
      setFocus,
      updateUi,
      setPending,
      setRestoredContext,
      restoredContext: restored,
      detachedTrip,
      detachedTripsFor,
      clearSession,
      projectActiveContextToLegacyState
    };
  }

  const api = { createShiftContextStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestShiftContexts = api;
})(typeof window !== 'undefined' ? window : globalThis);
