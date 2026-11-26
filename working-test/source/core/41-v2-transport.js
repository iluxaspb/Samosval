// Клиентский транспорт v2 параллельных смен.
//
// Один ответ — один проверенный пакет. До публикации в store контекстов
// сверяются protocolVersion, workspaceId, shiftId и ревизии сущностей: ответ с
// чужим workspace или чужой сменой не публикуется никогда. Непрозрачные
// курсоры передаются как есть и не пересобираются. Стабильные коды ошибок v2
// сохраняются вместе с безопасными деталями. Повтор после таймаута идёт с ТЕМ
// ЖЕ operationId и ровно один раз: идемпотентность обеспечивает сервер.
//
// Файл — classic script (IIFE → globalThis), чтобы работать в собранном шелле
// без ESM. Общий запрос приходит снаружи (session-client), поэтому транспорт
// проверяется без сети.
(function (root) {
  'use strict';

  const PROTOCOL_VERSION = 2;
  const VISIBLE_STATES = ['active', 'closing'];
  const DEFAULT_INTERVAL_MS = 4000;
  const MAX_DETAIL_LENGTH = 200;
  // Только эти поля серверных details безопасно показывать: никаких телефонов,
  // почты, uid и вложенных объектов.
  const SAFE_DETAIL_KEYS = [
    'reason', 'field', 'phase', 'stage', 'type', 'conflict',
    'sourceShiftId', 'destinationShiftId', 'objectId', 'objectName',
    'workDate', 'shiftType', 'truckId', 'archiveId', 'archiveRevision',
    'recordId', 'restoredContextId', 'contextRevision',
    'expectedRevision', 'currentRevision', 'expectedShiftRevision',
    'expectedStatusRevision', 'expectedCycleRevision', 'expectedTtnRevision',
    'shiftRevision', 'retryAfterMs'
  ];

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function isRevision(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function segment(value) {
    return encodeURIComponent(String(value));
  }

  // Тело команды без undefined: JSON.stringify выбросил бы их, но тогда
  // сравнение отправленного тела в тестах и логах расходилось бы с фактом.
  function compact(input) {
    const out = {};
    if (!isRecord(input)) return out;
    Object.keys(input).forEach(key => {
      if (input[key] !== undefined) out[key] = input[key];
    });
    return out;
  }

  function safeDetails(input) {
    const out = {};
    if (!isRecord(input)) return out;
    for (const key of SAFE_DETAIL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      const value = input[key];
      if (typeof value === 'string') out[key] = value.slice(0, MAX_DETAIL_LENGTH);
      else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
      else if (typeof value === 'boolean' || value === null) out[key] = value;
    }
    return out;
  }

  function failure(code, details, extra) {
    return Object.assign({
      ok: false,
      error: { code, status: 0, retryable: false, uncertain: false, details: details || {} }
    }, extra || {});
  }

  function shiftRowId(row) {
    if (!isRecord(row)) return '';
    if (isNonEmptyString(row.shiftId)) return row.shiftId;
    return isNonEmptyString(row.id) ? row.id : '';
  }

  function createV2Transport(options) {
    const config = options || {};
    const request = config.request;
    const uid = config.uid;
    const workspaceId = config.workspaceId;
    const store = config.store || null;
    if (typeof request !== 'function') throw new TypeError('v2-transport-requires-request');
    if (!isNonEmptyString(uid)) throw new TypeError('v2-transport-requires-uid');
    if (!isNonEmptyString(workspaceId)) throw new TypeError('v2-transport-requires-workspace');

    let listGeneration = 0;
    let publishedListGeneration = 0;

    function normalizeError(error) {
      if (error && isNonEmptyString(error.serverCode)) {
        return {
          code: error.serverCode,
          status: numberOrZero(error.status),
          retryable: error.retryable === true,
          uncertain: error.uncertain === true,
          details: safeDetails(error.serverDetails)
        };
      }
      if (error && isNonEmptyString(error.code)) {
        return {
          code: error.code,
          status: numberOrZero(error.status),
          retryable: error.retryable === true,
          uncertain: error.uncertain === true,
          details: {}
        };
      }
      return { code: 'v2-transport-failure', status: 0, retryable: true, uncertain: true, details: {} };
    }

    // Один запрос = один ответ. Повтор разрешён только для транспортных
    // ошибок (таймаут/обрыв) и только один: тело уже зафиксировано, поэтому
    // operationId на сервере остаётся тем же.
    async function call(path, settings) {
      const options = settings || {};
      const method = options.method || 'GET';
      const body = options.body;
      const send = () => request(path, { method, operation: body, validate: isRecord });
      try {
        return { ok: true, data: await send(), retried: false };
      } catch (error) {
        if (!(error && error.retryable === true)) return { ok: false, error: normalizeError(error) };
        try {
          return { ok: true, data: await send(), retried: true };
        } catch (again) {
          return { ok: false, error: normalizeError(again) };
        }
      }
    }

    function validateShiftList(data) {
      if (!isRecord(data)) return 'invalid-list';
      if (data.protocolVersion !== undefined && data.protocolVersion !== PROTOCOL_VERSION) return 'protocol-version-mismatch';
      if (data.workspaceId !== undefined && data.workspaceId !== workspaceId) return 'workspace-mismatch';
      if (!Array.isArray(data.items)) return 'invalid-list';
      if (data.nextCursor !== undefined && data.nextCursor !== null && typeof data.nextCursor !== 'string') return 'invalid-cursor';
      const seen = Object.create(null);
      for (const row of data.items) {
        if (!isRecord(row)) return 'invalid-list';
        const shiftId = shiftRowId(row);
        if (!shiftId) return 'invalid-shift-id';
        if (seen[shiftId]) return 'duplicate-shift';
        seen[shiftId] = true;
        if (row.workspaceId !== undefined && row.workspaceId !== workspaceId) return 'workspace-mismatch';
        if (row.shiftRevision !== undefined && !isRevision(row.shiftRevision)) return 'invalid-shift-revision';
        if (row.state !== undefined && typeof row.state !== 'string') return 'invalid-shift-state';
      }
      return null;
    }

    // Снимок проверяется до публикации: protocolVersion, workspace, shift,
    // ревизии и принадлежность каждой строки статуса/рейса своей смене.
    function validateSnapshot(snapshot, shiftId) {
      if (!isRecord(snapshot)) return 'invalid-snapshot';
      if (snapshot.protocolVersion !== PROTOCOL_VERSION) return 'protocol-version-mismatch';
      if (snapshot.workspaceId !== workspaceId) return 'workspace-mismatch';
      if (snapshot.shiftId !== shiftId) return 'shift-mismatch';
      const revision = snapshot.shiftRevision !== undefined
        ? snapshot.shiftRevision
        : (isRecord(snapshot.revisions) ? snapshot.revisions.shift : undefined);
      if (!isRevision(revision)) return 'invalid-shift-revision';
      if (!isRecord(snapshot.shift)) return 'invalid-shift';
      if (shiftRowId(snapshot.shift) !== shiftId) return 'shift-mismatch';
      for (const key of ['members', 'statuses', 'logs', 'detachedOpenTrips']) {
        if (snapshot[key] !== undefined && !Array.isArray(snapshot[key])) return 'invalid-' + key;
      }
      for (const key of ['statuses', 'logs']) {
        for (const row of snapshot[key] || []) {
          if (!isRecord(row)) return 'invalid-' + key;
          if (row.shiftId !== shiftId) return 'entity-shift-mismatch';
        }
      }
      for (const row of snapshot.statuses || []) {
        if (row.cycleRevision !== undefined && !isRevision(row.cycleRevision)) return 'invalid-entity-revision';
        if (row.ttnRevision !== undefined && !isRevision(row.ttnRevision)) return 'invalid-entity-revision';
      }
      for (const row of snapshot.detachedOpenTrips || []) {
        if (!isRecord(row)) return 'invalid-detached-open-trips';
        const source = row.sourceShiftId;
        const destination = row.destinationShiftId;
        if (source === undefined && destination === undefined) continue;
        if (source !== shiftId && destination !== shiftId) return 'entity-shift-mismatch';
      }
      if (isRecord(snapshot.revisions)) {
        for (const key of Object.keys(snapshot.revisions)) {
          if (!isRevision(snapshot.revisions[key])) return 'invalid-revision';
        }
      }
      return null;
    }

    function validateReceipt(data, operationId, shiftId) {
      if (!isRecord(data)) return 'invalid-receipt';
      if (data.protocolVersion !== PROTOCOL_VERSION) return 'protocol-version-mismatch';
      if (data.operationId !== operationId) return 'operation-id-mismatch';
      if (typeof data.replayed !== 'boolean') return 'invalid-receipt';
      if (!isRecord(data.result)) return 'invalid-receipt';
      if (data.workspaceId !== undefined && data.workspaceId !== workspaceId) return 'workspace-mismatch';
      if (shiftId && data.shiftId !== undefined && data.shiftId !== shiftId) return 'shift-mismatch';
      const resultShiftId = shiftRowId(data.result.shift);
      if (shiftId && resultShiftId && resultShiftId !== shiftId) return 'shift-mismatch';
      return null;
    }

    async function listShifts(input) {
      const settings = input || {};
      const states = Array.isArray(settings.states) && settings.states.length ? settings.states : VISIBLE_STATES;
      const limit = Number.isSafeInteger(settings.limit) && settings.limit >= 1 && settings.limit <= 100 ? settings.limit : 50;
      const params = new URLSearchParams();
      params.set('state', states.join(','));
      params.set('limit', String(limit));
      // Курсор непрозрачен: только пробрасываем, ничего не разбираем.
      if (isNonEmptyString(settings.cursor)) params.set('cursor', settings.cursor);
      const generation = ++listGeneration;
      const response = await call('/api/v2/shifts?' + params.toString(), { method: 'GET' });
      if (!response.ok) return Object.assign({ listGeneration: generation }, response);
      const problem = validateShiftList(response.data);
      if (problem) return failure('invalid-api-response', { reason: problem }, { listGeneration: generation, retried: !!response.retried });
      // Ответ, не совпавший с поколением запроса, не публикуется.
      if (generation < publishedListGeneration) {
        return failure('stale-list-generation', {}, { listGeneration: generation });
      }
      publishedListGeneration = generation;
      const items = response.data.items.slice();
      const nextCursor = typeof response.data.nextCursor === 'string' ? response.data.nextCursor : null;
      if (store) store.replaceVisibleShifts(items);
      return { ok: true, items, nextCursor, listGeneration: generation, retried: !!response.retried };
    }

    async function readShiftSnapshot(input) {
      const settings = input || {};
      const shiftId = settings.shiftId;
      const requestKind = isNonEmptyString(settings.requestKind) ? settings.requestKind : 'snapshot';
      if (!isNonEmptyString(shiftId)) return failure('invalid-shift-id');
      let generation = null;
      if (store) {
        generation = store.beginRequest({ shiftId, requestKind });
        if (!generation) return failure('shift-not-visible', {}, { shiftId, generation: null, applied: false });
      }
      const response = await call('/api/v2/shifts/' + segment(shiftId) + '/snapshot', { method: 'GET' });
      if (!response.ok) return Object.assign({ shiftId, generation, applied: false }, response);
      const problem = validateSnapshot(response.data, shiftId);
      if (problem) {
        return failure('invalid-api-response', { reason: problem }, { shiftId, generation, applied: false, retried: !!response.retried });
      }
      if (!store) {
        return { ok: true, shiftId, generation: null, snapshot: response.data, applied: false, retried: !!response.retried };
      }
      const applied = store.applySnapshot({ generation, snapshot: response.data });
      if (!applied.applied) {
        return Object.assign(
          failure('snapshot-not-applied', { reason: applied.reason }, { shiftId, generation, applied: false }),
          applied.currentRevision === undefined ? {} : { currentRevision: applied.currentRevision, incomingRevision: applied.incomingRevision }
        );
      }
      return { ok: true, shiftId, generation, revision: applied.revision, applied: true, visible: applied.visible };
    }

    async function command(settings) {
      const operationId = settings.operationId;
      if (!isNonEmptyString(operationId)) return failure('operation-id-required');
      const body = Object.assign({ operationId, protocolVersion: PROTOCOL_VERSION }, compact(settings.body));
      const response = await call(settings.path, { method: settings.method, body });
      if (!response.ok) return response;
      const problem = validateReceipt(response.data, operationId, settings.shiftId);
      if (problem) {
        return failure('invalid-api-response', { reason: problem }, { operationId, retried: !!response.retried });
      }
      return {
        ok: true,
        operationId,
        replayed: response.data.replayed,
        retried: !!response.retried,
        result: response.data.result
      };
    }

    function requireFields(input, keys) {
      for (const key of keys) {
        if (!isNonEmptyString(input[key])) return key;
      }
      return null;
    }

    function createShift(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'objectId', 'workDate', 'shiftType']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/shifts',
        operationId: settings.operationId,
        body: {
          objectId: settings.objectId,
          workDate: settings.workDate,
          shiftType: settings.shiftType,
          cycleMinutes: settings.cycleMinutes
        }
      });
    }

    function changeShiftObject(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'objectId']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'PATCH',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/object',
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: {
          objectId: settings.objectId,
          expectedShiftRevision: settings.expectedShiftRevision
        }
      });
    }

    function addMember(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'uid']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/members',
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: {
          uid: settings.uid,
          expectedShiftRevision: settings.expectedShiftRevision,
          expectedMembershipRevision: settings.expectedMembershipRevision
        }
      });
    }

    function removeMember(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'uid']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'DELETE',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/members/' + segment(settings.uid),
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: {
          expectedShiftRevision: settings.expectedShiftRevision,
          expectedMembershipRevision: settings.expectedMembershipRevision
        }
      });
    }

    function addTruck(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'truckId']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/trucks',
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: {
          truckId: settings.truckId,
          expectedShiftRevision: settings.expectedShiftRevision
        }
      });
    }

    function removeTruck(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'truckId']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'DELETE',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/trucks/' + segment(settings.truckId),
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: {
          expectedShiftRevision: settings.expectedShiftRevision,
          expectedStatusRevision: settings.expectedStatusRevision,
          expectedCycleRevision: settings.expectedCycleRevision,
          expectedTtnRevision: settings.expectedTtnRevision
        }
      });
    }

    function currentRevision(shiftId) {
      const context = store ? store.context(shiftId) : null;
      return context && context.revisions ? context.revisions.shift : undefined;
    }

    // Обе смены читаются и публикуются одной операцией store: частичный
    // результат запрещён, иначе экран одной смены показывал бы перевод.
    async function refreshCrossShift(input) {
      const settings = input || {};
      const sourceShiftId = settings.sourceShiftId;
      const destinationShiftId = settings.destinationShiftId;
      const requestKind = isNonEmptyString(settings.requestKind) ? settings.requestKind : 'cross-shift';
      if (!store) return { applied: false, reason: 'shift-contexts-unavailable' };
      if (!isNonEmptyString(sourceShiftId) || !isNonEmptyString(destinationShiftId) || sourceShiftId === destinationShiftId) {
        return { applied: false, reason: 'invalid-cross-shift-key' };
      }
      const sourceGeneration = store.beginRequest({ shiftId: sourceShiftId, requestKind });
      const destinationGeneration = store.beginRequest({ shiftId: destinationShiftId, requestKind });
      if (!sourceGeneration || !destinationGeneration) return { applied: false, reason: 'shift-not-visible' };
      const [source, destination] = await Promise.all([
        call('/api/v2/shifts/' + segment(sourceShiftId) + '/snapshot', { method: 'GET' }),
        call('/api/v2/shifts/' + segment(destinationShiftId) + '/snapshot', { method: 'GET' })
      ]);
      if (!source.ok || !destination.ok) {
        return { applied: false, reason: 'read-failed', error: !source.ok ? source.error : destination.error };
      }
      const sourceProblem = source.data && source.data.shiftId === sourceShiftId
        ? validateSnapshot(source.data, sourceShiftId)
        : null;
      const destinationProblem = destination.data && destination.data.shiftId === destinationShiftId
        ? validateSnapshot(destination.data, destinationShiftId)
        : null;
      if (sourceProblem || destinationProblem) {
        return { applied: false, reason: sourceProblem || destinationProblem };
      }
      // Идентичность смен проверяет store: при несовпадении ни одна смена не
      // публикуется, а обе помечаются на перечитывание.
      return store.applyCrossShiftResult({
        sourceShiftId,
        destinationShiftId,
        requestKind,
        sourceGeneration,
        destinationGeneration,
        sourceRevision: settings.sourceRevision,
        destinationRevision: settings.destinationRevision,
        sourceSnapshot: source.data,
        destinationSnapshot: destination.data
      });
    }

    async function forceTransferTruck(input) {
      const settings = input || {};
      if (settings.confirmTransfer !== true) return failure('transfer-confirmation-required');
      const missing = requireFields(settings, ['operationId', 'sourceShiftId', 'destinationShiftId', 'truckId']);
      if (missing) return failure('invalid-argument', { field: missing });
      const sourceRevision = currentRevision(settings.sourceShiftId);
      const destinationRevision = currentRevision(settings.destinationShiftId);
      const response = await command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.destinationShiftId) + '/trucks/' + segment(settings.truckId) + '/force-transfer',
        operationId: settings.operationId,
        shiftId: settings.destinationShiftId,
        body: {
          sourceShiftId: settings.sourceShiftId,
          expectedSourceShiftRevision: settings.expectedSourceShiftRevision,
          expectedDestinationShiftRevision: settings.expectedDestinationShiftRevision,
          expectedStatusRevision: settings.expectedStatusRevision,
          expectedCycleRevision: settings.expectedCycleRevision,
          expectedTtnRevision: settings.expectedTtnRevision,
          confirmTransfer: true
        }
      });
      if (!response.ok) return response;
      response.crossShift = await refreshCrossShift({
        sourceShiftId: settings.sourceShiftId,
        destinationShiftId: settings.destinationShiftId,
        requestKind: 'cross-shift',
        sourceRevision,
        destinationRevision
      });
      return response;
    }

    async function completeDetachedTrip(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'sourceShiftId', 'destinationShiftId', 'cycleId', 'truckId', 'type']);
      if (missing) return failure('invalid-argument', { field: missing });
      const sourceRevision = currentRevision(settings.sourceShiftId);
      const destinationRevision = currentRevision(settings.destinationShiftId);
      const response = await command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.sourceShiftId) + '/detached-trips/' + segment(settings.cycleId) + '/complete',
        operationId: settings.operationId,
        shiftId: settings.sourceShiftId,
        body: Object.assign({}, isRecord(settings.fields) ? settings.fields : {}, compact({
          truckId: settings.truckId,
          destinationShiftId: settings.destinationShiftId,
          type: settings.type,
          expectedSourceShiftRevision: settings.expectedSourceShiftRevision,
          expectedDestinationShiftRevision: settings.expectedDestinationShiftRevision,
          expectedDetachedCycleRevision: settings.expectedDetachedCycleRevision
        }))
      });
      if (!response.ok) return response;
      response.crossShift = await refreshCrossShift({
        sourceShiftId: settings.sourceShiftId,
        destinationShiftId: settings.destinationShiftId,
        requestKind: 'cross-shift',
        sourceRevision,
        destinationRevision
      });
      return response;
    }

    function submitLineV2(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'type', 'truckId']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/line-operations',
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: Object.assign({}, isRecord(settings.fields) ? settings.fields : {}, compact({
          type: settings.type,
          truckId: settings.truckId,
          expectedShiftRevision: settings.expectedShiftRevision,
          expectedStatusRevision: settings.expectedStatusRevision,
          expectedCycleRevision: settings.expectedCycleRevision,
          expectedTtnRevision: settings.expectedTtnRevision
        }))
      });
    }

    function prepareClose(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/close/prepare',
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: { expectedShiftRevision: settings.expectedShiftRevision }
      });
    }

    function finishClose(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'shiftId', 'closeToken']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/shifts/' + segment(settings.shiftId) + '/close/finish',
        operationId: settings.operationId,
        shiftId: settings.shiftId,
        body: {
          closeToken: settings.closeToken,
          expectedShiftRevision: settings.expectedShiftRevision,
          expectedArchiveRevision: settings.expectedArchiveRevision,
          expectedMaterialMarkerRevision: settings.expectedMaterialMarkerRevision
        }
      });
    }

    async function readRestoredArchive(input) {
      const settings = input || {};
      if (!isNonEmptyString(settings.archiveId)) return failure('invalid-argument', { field: 'archiveId' });
      const params = new URLSearchParams();
      if (Number.isSafeInteger(settings.revision) && settings.revision >= 1) params.set('revision', String(settings.revision));
      if (Number.isSafeInteger(settings.limit) && settings.limit >= 1) params.set('limit', String(settings.limit));
      if (isNonEmptyString(settings.cursor)) params.set('cursor', settings.cursor);
      const query = params.toString();
      const path = '/api/v2/archives/' + segment(settings.archiveId) + '/restored' + (query ? '?' + query : '');
      const response = await call(path, { method: 'GET' });
      if (!response.ok) return response;
      const data = response.data;
      if (!isRecord(data)) return failure('invalid-api-response', { reason: 'invalid-restored-archive' });
      if (data.protocolVersion !== undefined && data.protocolVersion !== PROTOCOL_VERSION) {
        return failure('invalid-api-response', { reason: 'protocol-version-mismatch' });
      }
      if (data.workspaceId !== undefined && data.workspaceId !== workspaceId) {
        return failure('invalid-api-response', { reason: 'workspace-mismatch' });
      }
      if (data.archiveId !== undefined && data.archiveId !== settings.archiveId) {
        return failure('invalid-api-response', { reason: 'archive-mismatch' });
      }
      return { ok: true, data, retried: !!response.retried };
    }

    function submitArchiveV2(input) {
      const settings = input || {};
      const missing = requireFields(settings, ['operationId', 'archiveId', 'restoredContextId', 'type']);
      if (missing) return Promise.resolve(failure('invalid-argument', { field: missing }));
      return command({
        method: 'POST',
        path: '/api/v2/archives/' + segment(settings.archiveId) + '/operations',
        operationId: settings.operationId,
        body: Object.assign({}, isRecord(settings.fields) ? settings.fields : {}, compact({
          restoredContextId: settings.restoredContextId,
          type: settings.type,
          recordId: settings.recordId,
          expectedContextRevision: settings.expectedContextRevision,
          expectedBaseArchiveRevision: settings.expectedBaseArchiveRevision,
          expectedBaseSha256: settings.expectedBaseSha256
        }))
      });
    }

    // Поллинг списка смен и снимков выбранной/фоновых смен с незавершёнными
    // операциями. Каждый снимок идёт через beginRequest/applySnapshot, поэтому
    // ответ, не совпавший с поколением, не публикуется.
    function subscribeShifts(input) {
      const settings = input || {};
      const onList = settings.onList;
      const onSnapshot = settings.onSnapshot;
      const onError = settings.onError;
      if (!store) throw new TypeError('v2-subscription-requires-store');
      if (![onList, onSnapshot, onError].every(handler => typeof handler === 'function')) throw new TypeError('invalid-subscription-options');
      const intervalMs = Number.isSafeInteger(settings.intervalMs) && settings.intervalMs >= 1000 && settings.intervalMs <= 60000
        ? settings.intervalMs
        : DEFAULT_INTERVAL_MS;
      const timers = settings.timers && typeof settings.timers.setTimeout === 'function' ? settings.timers : null;
      const schedule = (callback, delay) => {
        if (timers) return timers.setTimeout(callback, delay);
        if (typeof setTimeout === 'function') return setTimeout(callback, delay);
        return root.setTimeout(callback, delay);
      };
      const cancel = handle => {
        if (timers) timers.clearTimeout(handle);
        else if (typeof clearTimeout === 'function') clearTimeout(handle);
        else root.clearTimeout(handle);
      };

      let closed = false;
      let inFlight = false;
      let timer = null;
      let wakeRequested = false;

      function pollTargets(items) {
        const targets = [];
        const active = store.activeShiftId();
        if (isNonEmptyString(active)) targets.push(active);
        for (const item of items) {
          const shiftId = shiftRowId(item);
          if (!shiftId || targets.indexOf(shiftId) >= 0) continue;
          if (numberOrZero(item.pendingServerReceipts) > 0) targets.push(shiftId);
        }
        return targets;
      }

      async function tick() {
        if (closed || inFlight) return false;
        inFlight = true;
        try {
          const list = await listShifts({});
          if (closed) return false;
          if (!list.ok) {
            onError(list.error);
            return false;
          }
          onList(list);
          for (const shiftId of pollTargets(list.items)) {
            if (closed) return false;
            const result = await readShiftSnapshot({ shiftId, requestKind: 'poll' });
            if (closed) return false;
            if (result.ok) onSnapshot(result);
            else onError(result.error);
          }
          return true;
        } catch (error) {
          if (!closed) onError(normalizeError(error));
          return false;
        } finally {
          inFlight = false;
        }
      }

      function scheduleNext(delay) {
        if (closed) return;
        if (timer !== null) cancel(timer);
        timer = schedule(() => { timer = null; void run(); }, delay);
      }

      async function run() {
        await tick();
        if (closed) return;
        const delay = wakeRequested ? 0 : intervalMs;
        wakeRequested = false;
        scheduleNext(delay);
      }

      function wake() {
        if (closed) return;
        if (inFlight) {
          wakeRequested = true;
          return;
        }
        scheduleNext(0);
      }

      function close() {
        closed = true;
        if (timer !== null) cancel(timer);
        timer = null;
      }

      scheduleNext(0);
      return { close, tick, wake };
    }

    return Object.freeze({
      listShifts,
      readShiftSnapshot,
      createShift,
      changeShiftObject,
      addMember,
      removeMember,
      addTruck,
      removeTruck,
      forceTransferTruck,
      completeDetachedTrip,
      submitLineV2,
      prepareClose,
      finishClose,
      readRestoredArchive,
      submitArchiveV2,
      subscribeShifts,
      refreshCrossShift
    });
  }

  const api = { createV2Transport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestV2Transport = api;
})(typeof window !== 'undefined' ? window : globalThis);
