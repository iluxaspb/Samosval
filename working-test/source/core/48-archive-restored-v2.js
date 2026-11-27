// Восстановленная архивная смена через v2 (design §5.6, §8, §10.1).
//
// Сервер держит восстановленную смену отдельным контекстом
// (`restored_shift_contexts`), а не строкой в `shifts`: карточка «Восстановленная
// смена» и её рейсы приходят из `GET /api/v2/archives/{id}/restored`, правки
// рейсов/ТТН — из `POST /api/v2/archives/{id}/operations`. Здесь только перевод
// серверных форм в форму клиента и сборка команд: ни DOM, ни сети, ни
// localStorage — транспорт и генератор operationId приходят снаружи.
//
// Почему отдельный файл: 45-restored-archive.js описывает provenance и ревизии
// архива, но ничего не знает о контексте правок. Смешивать эти два контракта в
// одном модуле значит снова получить «тест договорился сам с собой» (урок 61).
(function (root) {
  'use strict';

  const SHA_RE = /^[0-9a-f]{64}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const CORRECTION_TYPES = ['trip.update', 'trip.delete', 'ttn.update', 'ttn.delete'];

  // Прежний честный отказ (1.8.7): старый сервер, отсутствующий маршрут или
  // неподдерживаемый протокол не должны выглядеть как «смена восстановлена».
  const COMPAT_REFUSAL = 'Восстановление архивной смены в этом режиме недоступно: смена не создана, данные архива не изменены. Обратитесь к администратору.';
  // Маршрута публикации restored-контекста в сервере канала нет
  // (`finalizeRestoredContext` есть в домене, но не в `v2-router.mjs`).
  // «Вернуть в архив» обязан сказать это прямо, а не закрыть смену окольным путём.
  const FINALIZE_UNAVAILABLE = 'Вернуть восстановленную смену в архив сейчас нельзя: сервер ещё не публикует восстановленный контекст как ревизию архива. Правки сохранены в восстановленной смене, в архив она не вернулась.';
  const FINALIZED_NOTICE = 'Восстановленная смена уже опубликована в архив: правки и возврат недоступны.';

  const DOMAIN_REFUSALS = {
    'archive-not-found': 'Архивная смена не найдена на сервере: обновите архив и повторите. Данные не изменены.',
    'archive-not-restorable': 'Эту архивную смену нельзя восстановить для правок: в архиве нет даты или объекта. Данные не изменены.',
    'archive-truck-not-available': 'В архиве есть самосвал, которого больше нет в справочнике техники. Восстановление невозможно, данные не изменены.',
    'invalid-archive-data': 'Данные архивной смены повреждены: восстановление невозможно, данные не изменены.',
    'invalid-archive-id': 'Архивная смена указана неверно: обновите архив и повторите. Данные не изменены.',
    'archive-changed': 'Архивная смена изменилась в другом окне: обновите архив и повторите. Данные не изменены.',
    'archive-context-finalized': FINALIZED_NOTICE,
    'forbidden': 'Недостаточно прав для восстановления архивной смены: смена не создана, данные архива не изменены.',
    'unauthenticated': 'Сеанс истёк: войдите заново. Данные не изменены.'
  };

  const CORRECTION_REFUSALS = {
    'archive-changed': 'Смена изменилась в другом окне. Обновите страницу и повторите правку — ваша правка не применена.',
    'archive-context-finalized': FINALIZED_NOTICE,
    'archive-context-not-found': 'Восстановленная смена больше не открыта. Обновите страницу.',
    'restored-trip-not-found': 'Этот рейс уже удалён в другом окне. Обновите страницу.',
    'archive-operation-not-allowed': 'Это действие недоступно для восстановленной архивной смены.',
    'operation-id-reused': 'Операция уже выполнена с другими данными. Обновите страницу и повторите.',
    'forbidden': 'Недостаточно прав для правки восстановленной смены.',
    'invalid-command': 'Проверьте поля правки и повторите: данные не изменены.',
    'invalid-restored-trip': 'Рейс архивной смены повреждён: правка невозможна.',
    'invalid-api-response': 'Сервер вернул неожиданный ответ. Правка не применена, обновите страницу.',
    'v2-transport-failure': 'Нет связи с сервером. Правка не применена, повторите.'
  };

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function revision(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1 ? number : null;
  }

  // `work_date` сервер отдаёт из pg как `date`: JSON приходит ISO-мгновением
  // (`2026-11-27T00:00:00.000Z`), а не строкой `YYYY-MM-DD`. Клиент обязан
  // принять обе формы, иначе карточка показывает пустую дату (урок 69).
  function isoDate(value) {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return null;
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(text);
    if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
    const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
    if (ru) return ru[3] + '-' + ru[2].padStart(2, '0') + '-' + ru[1].padStart(2, '0');
    return null;
  }

  function ruDate(value) {
    const iso = isoDate(value);
    if (!iso) return '';
    return iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);
  }

  // Рейс архивной смены: серверная строка `{logId,truckId,payload,logRevision}`.
  // `payload` — точные байты рейса из архива, поэтому поля читаются из него, а
  // адрес — из строки контекста.
  function tripOf(row, shiftId) {
    if (!isRecord(row)) return null;
    const payload = isRecord(row.payload) ? row.payload : {};
    const id = isNonEmptyString(row.logId) ? row.logId : payload.id;
    const truckId = isNonEmptyString(row.truckId) ? row.truckId : payload.truckId;
    if (!isNonEmptyString(id) || !isNonEmptyString(truckId)) return null;
    const volume = Number(payload.volume);
    const timestamp = Number(payload.timestamp);
    return Object.assign({}, payload, {
      id,
      truckId,
      shiftId,
      restoredContextId: shiftId,
      volume: Number.isFinite(volume) ? volume : 0,
      timeStr: typeof payload.timeStr === 'string' ? payload.timeStr : '',
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      comment: typeof payload.comment === 'string' ? payload.comment : '',
      isGAI: payload.isGAI === true,
      logRevision: revision(row.logRevision) || 0
    });
  }

  function ttnOf(row) {
    if (!isRecord(row) || !isNonEmptyString(row.truckId)) return null;
    return {
      truckId: row.truckId,
      ttnStatus: row.ttnStatus === true ? true : (row.ttnStatus === 'pending' ? 'pending' : null),
      ttnRevision: revision(row.ttnRevision) || 0
    };
  }

  function contextOf(view) {
    return {
      restoredContextId: view.restoredContextId,
      archiveId: view.archiveId,
      sourceShiftId: isNonEmptyString(view.sourceShiftId) ? view.sourceShiftId : null,
      contextRevision: revision(view.contextRevision),
      baseArchiveRevision: revision(view.baseArchiveRevision),
      baseArchiveSha256: view.baseArchiveSha256,
      archiveRevision: revision(view.archiveRevision),
      archiveSha256: isNonEmptyString(view.archiveSha256) ? view.archiveSha256 : view.baseArchiveSha256,
      contextState: isNonEmptyString(view.contextState) ? view.contextState : 'open',
      mode: isNonEmptyString(view.mode) ? view.mode : null,
      baseIsLatest: view.baseIsLatest === true ? true : (view.baseIsLatest === false ? false : null),
      latestFinalizedRevision: revision(view.latestFinalizedRevision),
      tripsPage: isRecord(view.tripsPage) ? {
        limit: revision(view.tripsPage.limit) || 0,
        hasMore: view.tripsPage.hasMore === true,
        nextCursor: isNonEmptyString(view.tripsPage.nextCursor) ? view.tripsPage.nextCursor : null
      } : { limit: 0, hasMore: false, nextCursor: null }
    };
  }

  // Проверка серверного контекста до публикации в state: чужая/битая форма не
  // должна попасть в журнал как «нормальная» карточка.
  function normalizeContext(view) {
    if (!isRecord(view)) return { ok: false, code: 'invalid-api-response', status: 0 };
    if (!isNonEmptyString(view.restoredContextId)) return { ok: false, code: 'invalid-api-response', status: 0 };
    if (!isNonEmptyString(view.archiveId)) return { ok: false, code: 'invalid-api-response', status: 0 };
    if (!revision(view.contextRevision) || !revision(view.baseArchiveRevision)) {
      return { ok: false, code: 'invalid-api-response', status: 0 };
    }
    if (typeof view.baseArchiveSha256 !== 'string' || !SHA_RE.test(view.baseArchiveSha256)) {
      return { ok: false, code: 'invalid-api-response', status: 0 };
    }
    if (!isRecord(view.shiftSnapshot) || !isNonEmptyString(view.shiftSnapshot.objectId)) {
      return { ok: false, code: 'invalid-api-response', status: 0 };
    }
    if (!Array.isArray(view.trips)) return { ok: false, code: 'invalid-api-response', status: 0 };
    if (view.ttn !== undefined && !Array.isArray(view.ttn)) return { ok: false, code: 'invalid-api-response', status: 0 };
    const normalized = Object.assign({}, view, {
      trips: view.trips.slice(),
      ttn: Array.isArray(view.ttn) ? view.ttn.slice() : []
    });
    return { ok: true, view: normalized };
  }

  function cardOf(view) {
    const context = contextOf(view);
    const snapshot = isRecord(view.shiftSnapshot) ? view.shiftSnapshot : {};
    const shiftId = context.restoredContextId;
    const logs = [];
    for (const row of view.trips || []) {
      const trip = tripOf(row, shiftId);
      if (trip) logs.push(trip);
    }
    const ttn = [];
    for (const row of view.ttn || []) {
      const entry = ttnOf(row);
      if (entry) ttn.push(entry);
    }
    const startDate = ruDate(snapshot.workDate);
    return {
      shift: {
        id: shiftId,
        restored: true,
        restoredContextId: shiftId,
        archiveId: context.archiveId,
        sourceShiftId: context.sourceShiftId,
        objectId: snapshot.objectId,
        objectName: isNonEmptyString(snapshot.objectName) ? snapshot.objectName : snapshot.objectId,
        startDate,
        date: startDate,
        openedAt: snapshot.openedAt === undefined ? null : snapshot.openedAt,
        openedByUid: snapshot.openedByUid === undefined ? null : snapshot.openedByUid,
        openedByName: snapshot.openedByName === undefined ? null : snapshot.openedByName,
        shiftType: snapshot.shiftType === undefined ? null : snapshot.shiftType,
        isActive: false
      },
      logs,
      ttn,
      provenance: isRecord(view.provenance) ? view.provenance : null,
      readOnly: context.contextState !== 'open',
      context
    };
  }

  // Команда правки: CAS берётся ТОЛЬКО из фактически прочитанного контекста.
  // Поля правки уходят на верхнем уровне тела (`fields`), как ждёт сервер
  // (`archive-restored-v2.mjs`, урок 68).
  function commandFor(card, input) {
    const command = input || {};
    const context = card && card.context;
    if (!isRecord(context)) return { ok: false, code: 'invalid-restored-context' };
    const type = command.type;
    if (!CORRECTION_TYPES.includes(type)) return { ok: false, code: 'archive-operation-not-allowed' };
    if (!isNonEmptyString(command.operationId)) return { ok: false, code: 'operation-id-required' };
    if (!isNonEmptyString(command.recordId)) return { ok: false, code: 'invalid-command' };
    const payload = {
      operationId: command.operationId,
      archiveId: context.archiveId,
      restoredContextId: context.restoredContextId,
      type,
      recordId: command.recordId,
      expectedContextRevision: context.contextRevision,
      expectedBaseArchiveRevision: context.baseArchiveRevision,
      expectedBaseSha256: context.baseArchiveSha256
    };
    if (type === 'trip.update') {
      const fields = isRecord(command.fields) ? command.fields : {};
      const volume = Number(fields.volume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 1000) return { ok: false, code: 'invalid-volume' };
      if (typeof fields.timeStr !== 'string' || !TIME_RE.test(fields.timeStr)) return { ok: false, code: 'invalid-time' };
      const comment = typeof fields.comment === 'string' ? fields.comment : '';
      if (comment.length > 2000) return { ok: false, code: 'invalid-comment' };
      payload.fields = { volume, timeStr: fields.timeStr, comment };
    } else if (type === 'ttn.update') {
      const status = isRecord(command.fields) ? command.fields.ttnStatus : undefined;
      if (status !== 'pending' && status !== true) return { ok: false, code: 'invalid-ttn' };
      payload.fields = { ttnStatus: status };
    }
    return { ok: true, input: payload };
  }

  function replaceTrip(logs, result) {
    const id = result.recordId;
    if (!isNonEmptyString(id)) return logs;
    if (result.type === 'trip.delete') return logs.filter(log => log.id !== id);
    if (result.type !== 'trip.update' || !isRecord(result.log)) return logs;
    const next = tripOf({ logId: id, truckId: result.log.truckId, payload: result.log }, result.log.shiftId || '');
    return logs.map(log => {
      if (log.id !== id) return log;
      const merged = Object.assign({}, log, result.log);
      return Object.assign(merged, {
        id,
        truckId: isNonEmptyString(result.log.truckId) ? result.log.truckId : log.truckId,
        shiftId: log.shiftId,
        restoredContextId: log.restoredContextId,
        volume: next ? next.volume : log.volume,
        timeStr: next ? next.timeStr : log.timeStr,
        timestamp: next ? next.timestamp : log.timestamp,
        comment: next ? next.comment : log.comment,
        logRevision: log.logRevision + 1
      });
    });
  }

  function replaceTtn(rows, result) {
    if (!isRecord(result.ttn) || !isNonEmptyString(result.ttn.truckId)) return rows;
    const truckId = result.ttn.truckId;
    const status = result.ttn.ttnStatus === true ? true : (result.ttn.ttnStatus === 'pending' ? 'pending' : null);
    let found = false;
    const next = rows.map(row => {
      if (row.truckId !== truckId) return row;
      found = true;
      return Object.assign({}, row, { ttnStatus: status });
    });
    if (!found) next.push({ truckId, ttnStatus: status, ttnRevision: 0 });
    return next;
  }

  // Ответ операции: контекст получил новую ревизию, рейс/ТТН — новое значение.
  // Карточка обновляется локально, поэтому следующий CAS идёт уже по новой
  // ревизии без повторного чтения.
  function applyResult(card, result) {
    if (!isRecord(card) || !isRecord(result)) return card;
    const contextRevision = revision(result.contextRevision);
    const logs = Array.isArray(card.logs) ? replaceTrip(card.logs, result) : [];
    const ttn = Array.isArray(card.ttn) ? replaceTtn(card.ttn, result) : [];
    return Object.assign({}, card, {
      logs,
      ttn,
      context: Object.assign({}, card.context, contextRevision ? { contextRevision } : {})
    });
  }

  function isCompatRefusal(code, status) {
    const numeric = Number(status) || 0;
    if (numeric === 404 || numeric === 405 || numeric === 426 || numeric === 501) return true;
    if (typeof code !== 'string' || !code) return true;
    if (code.startsWith('api-http-')) return true;
    return ['not-found', 'route-not-found', 'method-not-allowed', 'protocol-upgrade-required',
      'protocol-upgrade', 'invalid-api-response', 'v2-transport-failure', 'request-failed',
      'archive-restore-requires-v2', 'shift-not-visible'].includes(code);
  }

  // Текст отказа восстановления. Пользователь не должен видеть `api-http-409`:
  // либо конкретная причина, либо прежний честный отказ.
  function refusalFor(code, status) {
    if (Object.prototype.hasOwnProperty.call(DOMAIN_REFUSALS, code)) {
      return { text: DOMAIN_REFUSALS[code], compat: false };
    }
    if (isCompatRefusal(code, status)) return { text: COMPAT_REFUSAL, compat: true };
    return { text: 'Не удалось восстановить архивную смену: смена не создана, данные архива не изменены. Повторите позже.', compat: false };
  }

  function correctionText(code, status) {
    if (Object.prototype.hasOwnProperty.call(CORRECTION_REFUSALS, code)) return CORRECTION_REFUSALS[code];
    if (isCompatRefusal(code, status)) {
      return 'Сервер не поддерживает правку восстановленной смены. Обновите приложение или обратитесь к администратору: данные не изменены.';
    }
    return 'Не удалось сохранить правку восстановленной смены: данные не изменены. Повторите позже.';
  }

  function finalizeText(card) {
    if (card && card.context && card.context.contextState !== 'open') return FINALIZED_NOTICE;
    return FINALIZE_UNAVAILABLE;
  }

  const api = {
    COMPAT_REFUSAL,
    FINALIZE_UNAVAILABLE,
    FINALIZED_NOTICE,
    CORRECTION_TYPES,
    isoDate,
    ruDate,
    normalizeContext,
    cardOf,
    commandFor,
    applyResult,
    isCompatRefusal,
    refusalFor,
    correctionText,
    finalizeText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestArchiveRestoredV2 = api;
})(typeof window !== 'undefined' ? window : globalThis);
