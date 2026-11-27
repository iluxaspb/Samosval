// Рейсы, оставшиеся в прежней смене (design §3.3, §7, §10.2).
//
// Force transfer отделяет незавершённый цикл в detached trip, который навсегда
// принадлежит исходной смене A. Завершить его могут участники A или текущей B,
// но событие, рейс, rewards/material/report и receipt записываются только в A.
// Из-за cross-shift CAS команда online-only: офлайн UI показывает read-only и
// причину, а в очередь ничего не пишется.
//
// Файл — classic script (IIFE → globalThis), без DOM. Транспорт инжектируется,
// поэтому модуль проверяется шпионом без сети.
(function (root) {
  'use strict';

  const WARNING = 'Действие будет записано в исходную смену';
  const STAGE_LABELS = {
    arrive: 'Прибытие',
    arrived: 'Прибытие',
    load: 'Погрузка',
    loaded: 'Погрузка',
    ttn: 'ТТН',
    'ttn-pending': 'Ожидает ТТН'
  };
  const SHIFT_TYPE_LABELS = { day: 'День', night: 'Ночь' };
  const CYCLE_REVISION_KEYS = ['expectedDetachedCycleRevision', 'detachedCycleRevision', 'cycleRevision'];
  const SOURCE_REVISION_KEYS = ['expectedSourceShiftRevision', 'sourceShiftRevision'];
  const DESTINATION_REVISION_KEYS = ['expectedDestinationShiftRevision', 'destinationShiftRevision'];

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function copy(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function isOpen(trip) {
    if (!isRecord(trip)) return false;
    if (trip.completed === true) return false;
    return trip.status !== 'completed' && trip.state !== 'completed';
  }

  // Ревизия из фактической записи. Отсутствующая и испорченная одинаково
  // означают «неизвестна»: команду с выдуманным CAS отправлять нельзя.
  function revisionOf(trip, keys) {
    for (const key of keys) {
      const value = trip[key];
      if (value === undefined || value === null || value === '') continue;
      const number = Number(value);
      return Number.isSafeInteger(number) && number >= 1 ? number : null;
    }
    return null;
  }

  function firstText() {
    for (let index = 0; index < arguments.length; index += 1) {
      const value = arguments[index];
      if (isNonEmptyString(value)) return value.trim();
    }
    return '';
  }

  function stageLabel(trip) {
    const stage = firstText(trip.stage, trip.cycleStage);
    if (!stage) return 'Стадия не подтверждена';
    return STAGE_LABELS[stage] || stage;
  }

  // Подпись исходной смены: объект, дата, день/ночь и стадия незавершённого
  // цикла — ровно из полей detached-записи. Серверный снимок отдаёт смену
  // вложенным объектом `sourceShift`, поэтому сначала читаем его: без этого
  // подпись всегда была «Объект не указан · Дата не указана».
  function sourceLabel(trip) {
    const source = isRecord(trip.sourceShift) ? trip.sourceShift : {};
    const object = firstText(trip.sourceObjectName, source.objectName,
      trip.sourceObjectId, source.objectId, trip.objectName, trip.objectId);
    const date = firstText(trip.sourceWorkDate, source.workDate, source.date, trip.workDate, trip.startDate);
    const type = firstText(trip.sourceShiftType, source.shiftType, source.workShift, source.type, trip.shiftType);
    const typeLabel = SHIFT_TYPE_LABELS[type] || type;
    return [object || 'Объект не указан', date || 'Дата не указана', typeLabel || 'Тип смены не подтверждён', stageLabel(trip)]
      .join(' · ');
  }

  function createDetachedTrips(options) {
    const config = options || {};
    const transport = config.transport || null;

    function onlineNow() {
      const source = config.online;
      if (typeof source === 'function') return source() === true;
      return source === true;
    }

    // Только свои открытые рейсы: sourceShiftId === shiftId или
    // destinationShiftId === shiftId. Чужие и завершённые не отдаются.
    function list(store, shiftId) {
      if (!isNonEmptyString(shiftId)) return [];
      let rows = [];
      if (store && typeof store.detachedTripsFor === 'function') {
        try {
          rows = store.detachedTripsFor(shiftId);
        } catch (_) {
          rows = [];
        }
      } else if (Array.isArray(store)) {
        rows = store;
      } else if (isRecord(store) && Array.isArray(store.detachedOpenTrips)) {
        rows = store.detachedOpenTrips;
      }
      if (!Array.isArray(rows)) return [];
      return rows
        .filter(trip => isRecord(trip) && isOpen(trip))
        .filter(trip => trip.sourceShiftId === shiftId || trip.destinationShiftId === shiftId)
        .map(copy);
    }

    // Cross-shift CAS требует все три ревизии. Если хотя бы одна неизвестна,
    // команда не отправляется: тело с null вместо ревизии сервер отвергнет как
    // invalid-command, и пользователь получил бы ложную ошибку вместо честной
    // причины «данные ещё не загружены».
    function missingRevision(trip) {
      if (!isRecord(trip)) return 'detached';
      if (revisionOf(trip, CYCLE_REVISION_KEYS) === null) return 'detached';
      if (revisionOf(trip, SOURCE_REVISION_KEYS) === null) return 'source';
      if (revisionOf(trip, DESTINATION_REVISION_KEYS) === null) return 'destination';
      return '';
    }

    // Карточка рейса: крупная подпись источника, точное предупреждение и
    // честный canComplete (online + открыт + известны все три ревизии).
    function describe(trip) {
      const label = isRecord(trip) ? sourceLabel(trip) : 'Объект не указан';
      const revisionsKnown = isRecord(trip) && missingRevision(trip) === '';
      return {
        sourceLabel: label,
        stageLabel: isRecord(trip) ? stageLabel(trip) : 'Стадия не подтверждена',
        warning: WARNING + ': ' + label,
        canComplete: isRecord(trip) && isOpen(trip) && onlineNow() && revisionsKnown,
        onlineOnly: true
      };
    }

    // Завершение detached-рейса — только online и только через транспорт.
    // Никакой офлайн-очереди у модуля нет; queue в options существует лишь
    // затем, чтобы тест мог доказать отсутствие записи.
    async function complete(input) {
      const settings = input || {};
      const trip = settings.trip;
      if (!isRecord(trip)) return { ok: false, code: 'invalid-trip' };
      if (!isOpen(trip)) return { ok: false, code: 'trip-completed' };
      if (!onlineNow()) return { ok: false, code: 'online-required' };
      const unknown = missingRevision(trip);
      if (unknown) return { ok: false, code: 'revision-unknown', details: { field: unknown } };
      const cycleRevision = revisionOf(trip, CYCLE_REVISION_KEYS);
      if (!transport || typeof transport.completeDetachedTrip !== 'function') {
        return { ok: false, code: 'transport-unavailable' };
      }
      const operationId = settings.operationId;
      const sourceShiftId = trip.sourceShiftId;
      const destinationShiftId = trip.destinationShiftId;
      const cycleId = firstText(trip.cycleId, trip.detachedCycleId);
      const truckId = firstText(settings.truckId, trip.truckId);
      if (![operationId, sourceShiftId, destinationShiftId, cycleId, truckId].every(isNonEmptyString)) {
        return { ok: false, code: 'invalid-trip' };
      }
      return transport.completeDetachedTrip({
        operationId,
        sourceShiftId,
        destinationShiftId,
        cycleId,
        truckId,
        type: firstText(settings.type, trip.type, trip.stage),
        expectedSourceShiftRevision: revisionOf(trip, SOURCE_REVISION_KEYS),
        expectedDestinationShiftRevision: revisionOf(trip, DESTINATION_REVISION_KEYS),
        expectedDetachedCycleRevision: cycleRevision,
        // v2-команда завершения требует createdAt (§5.4). Экран передаёт момент
        // подтверждения, а без него берётся текущий — это время самой команды,
        // а не выдуманный факт о рейсе.
        fields: {
          createdAt: Number.isSafeInteger(settings.createdAt) && settings.createdAt > 0
            ? settings.createdAt
            : Date.now()
        }
      });
    }

    return Object.freeze({ list, describe, complete });
  }

  const api = { createDetachedTrips };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestDetachedTrips = api;
})(typeof window !== 'undefined' ? window : globalThis);
