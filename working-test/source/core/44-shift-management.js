// Управление сменой: создание, участники, закрытие (design §5.2, §5.3, §5.5,
// §6, §7).
//
// Модуль без DOM и без сети: транспорт и store инжектируются, поэтому решение
// «команда уходит или нет» проверяется без браузера. Права здесь — UI-гейт
// поверх серверного ACL, а не замена ему: сервер повторно проверяет всё сам.
//
// CAS берётся только из фактического состояния контекста смены. Если ревизия
// неизвестна, команда не уходит вовсе: тело с `undefined` вместо ревизии
// превратилось бы в «без CAS» и позволило бы затереть чужое изменение.
//
// Закрытие — три фазы строго по факту receipt: prepare → material (только если
// в смене есть рейсы) → finish. Значения ожиданий не выдумываются, ошибка
// любой фазы останавливает цепочку, а конфликт не переигрывается молча:
// повтор с новой ревизией сделал бы вид, что чужого изменения не было.
(function (root) {
  'use strict';

  const WORK_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const OPERATION_MAX = 160;
  const VISIBLE_STATES = { active: true, closing: true };
  const SHIFT_TYPES = { day: true, night: true };
  const RIGHTS = {
    create: 'start_shift',
    members: 'manage_shift_members',
    close: 'close_shift',
    forceTransfer: 'force_transfer_truck'
  };
  // Стабильные коды v2 → человеческий текст. Неизвестный код не роняет
  // describe: пользователь получает общий текст, а не пустой экран.
  const MESSAGES = {
    'shift-closed': 'Смена уже закрыта. Откройте актуальную смену — действие в закрытую не записывается.',
    'not-shift-member': 'Вы больше не участник этой смены. Попросите старшего прораба назначить вас заново.',
    'revision-conflict': 'Данные смены изменил другой пользователь. Обновите экран и повторите действие.',
    'shift-changed': 'Смена изменилась, пока шло действие. Обновите экран и повторите действие.',
    'truck-not-on-shift': 'Самосвал уже не на этой смене. Обновите экран и повторите действие.',
    'pending-operations': 'По смене ещё ожидают подтверждения сервера незавершённые операции. Дождитесь их и повторите закрытие.',
    'detached-trip-open': 'В смене есть незавершённый рейс, переведённый в другую смену. Сначала завершите его, потом закрывайте смену.',
    'duplicate-shift': 'Такая смена уже открыта: этот объект, дата и день/ночь уже есть в полосе смен.',
    'online-required': 'Для этой команды нужна сеть: перевод самосвала и завершение переведённого рейса офлайн не выполняются.',
    'protocol-upgrade-required': 'Сервер требует новую версию приложения. Обновите страницу и повторите действие.',
    'forbidden': 'Недостаточно прав для этого действия. Обратитесь к администратору.',
    'invalid-command': 'Команда заполнена некорректно и не отправлена. Проверьте значения полей.',
    'invalid-shift-type': 'Тип смены должен быть «День» или «Ночь».',
    'invalid-work-date': 'Дата смены должна быть в формате ГГГГ-ММ-ДД и существовать в календаре.',
    'invalid-object-id': 'Выберите объект смены.',
    'invalid-shift-id': 'Не выбрана смена.',
    'invalid-uid': 'Не выбран участник смены.',
    'invalid-operation-id': 'Не удалось подготовить операцию. Повторите действие.',
    'revision-unknown': 'Данные смены ещё не загружены с сервера. Обновите экран и повторите действие.',
    'material-required': 'В смене есть рейсы: укажите материал и объём, чтобы подтвердить материал при закрытии.',
    'invalid-api-response': 'Сервер ответил неожиданно. Обновите экран; если повторится — сообщите администратору.',
    'transport-failed': 'Не удалось связаться с сервером. Проверьте связь и повторите действие.'
  };
  const UNKNOWN_MESSAGE = 'Не удалось выполнить действие. Обновите экран и повторите; если ошибка повторяется — сообщите администратору.';

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function revisionValue(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }

  function validWorkDate(value) {
    if (typeof value !== 'string' || !WORK_DATE.test(value)) return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    if (month < 1 || month > 12 || day < 1) return false;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day <= lastDay;
  }

  function shiftTypeOf(row) {
    const type = row && (row.shiftType || row.type || row.workShift);
    return isNonEmptyString(type) ? type : '';
  }

  function stateOf(row) {
    if (isNonEmptyString(row.state)) return row.state;
    if (row.closing === true) return 'closing';
    if (row.isActive === false) return 'closed';
    return 'active';
  }

  function fail(code, details) {
    return { ok: false, code, details: details || {} };
  }

  function createShiftManagement(options) {
    const config = options || {};
    const transport = config.transport;
    const store = config.store;
    const rights = isRecord(config.rights) ? config.rights : {};
    const now = typeof config.now === 'function' ? config.now : function () { return Date.now(); };
    if (!transport) throw new TypeError('shift-management-requires-transport');
    if (!store || typeof store.visibleShifts !== 'function') throw new TypeError('shift-management-requires-store');

    let sequence = 0;
    function generatedOperationId() {
      sequence += 1;
      return 'op_' + Number(now()).toString(36) + '_' + sequence.toString(36)
        + '_' + Math.random().toString(36).slice(2, 8);
    }

    function newOperationId() {
      const generated = typeof config.newOperationId === 'function' ? config.newOperationId() : generatedOperationId();
      return isNonEmptyString(generated) ? generated : '';
    }

    function operationFor(value) {
      if (value === undefined || value === null) return newOperationId();
      return isNonEmptyString(value) ? value : '';
    }

    // Производный id фазы: сервер принимает только [A-Za-z0-9_-]{1,160}.
    function phaseId(base, phase) {
      const suffix = '-' + phase;
      const room = OPERATION_MAX - suffix.length;
      return (base.length > room ? base.slice(0, room) : base) + suffix;
    }

    function hasRight(name) {
      return rights[name] === true;
    }

    function readContext(shiftId) {
      try {
        return typeof store.context === 'function' ? store.context(shiftId) : null;
      } catch (_) {
        return null;
      }
    }

    function shiftRevisionOf(context) {
      if (!isRecord(context) || !isRecord(context.revisions)) return null;
      return revisionValue(context.revisions.shift);
    }

    function membersOf(context) {
      const members = context && context.snapshot && context.snapshot.members;
      return Array.isArray(members) ? members : [];
    }

    function memberOf(context, uid) {
      return membersOf(context).find(member => isRecord(member) && member.uid === uid) || null;
    }

    function visibleRows() {
      let raw = [];
      try {
        raw = store.visibleShifts();
      } catch (_) {
        raw = [];
      }
      return (Array.isArray(raw) ? raw : []).filter(row => isRecord(row) && VISIBLE_STATES[stateOf(row)]);
    }

    // Точный дубликат активной/закрывающейся смены запрещён (§3.1). Закрытая
    // смена того же ключа в visibleShifts не попадает и дубликатом не является.
    function isDuplicate(objectId, workDate, shiftType) {
      return visibleRows().some(row => row.objectId === objectId
        && row.workDate === workDate
        && shiftTypeOf(row) === shiftType);
    }

    function settle(response, extra) {
      if (response && response.ok === true) {
        return Object.assign({
          ok: true,
          code: 'ok',
          operationId: isNonEmptyString(response.operationId) ? response.operationId : (extra && extra.operationId) || null,
          replayed: response.replayed === true,
          result: response.result
        }, extra || {});
      }
      const error = response && isRecord(response.error) ? response.error : {};
      return Object.assign(
        fail(isNonEmptyString(error.code) ? error.code : 'transport-failed', isRecord(error.details) ? error.details : {}),
        extra || {}
      );
    }

    function canCreate() { return hasRight(RIGHTS.create); }
    function canManageMembers() { return hasRight(RIGHTS.members); }
    function canClose() { return hasRight(RIGHTS.close); }
    function canForceTransfer() { return hasRight(RIGHTS.forceTransfer); }

    async function createShift(input) {
      const settings = input || {};
      if (!canCreate()) return fail('forbidden', { right: RIGHTS.create });
      const shiftType = settings.shiftType;
      if (!SHIFT_TYPES[shiftType]) return fail('invalid-shift-type', { field: 'shiftType' });
      if (!validWorkDate(settings.workDate)) return fail('invalid-work-date', { field: 'workDate' });
      const objectId = text(settings.objectId);
      if (!objectId) return fail('invalid-object-id', { field: 'objectId' });
      if (isDuplicate(objectId, settings.workDate, shiftType)) {
        return fail('duplicate-shift', { objectId, workDate: settings.workDate, shiftType });
      }
      const operationId = operationFor(settings.operationId);
      if (!operationId) return fail('invalid-operation-id', { field: 'operationId' });
      const payload = { operationId, objectId, workDate: settings.workDate, shiftType };
      const cycleMinutes = Number(settings.cycleMinutes);
      if (Number.isFinite(cycleMinutes) && cycleMinutes > 0) payload.cycleMinutes = cycleMinutes;
      return settle(await transport.createShift(payload), { operationId });
    }

    async function addMember(input) {
      const settings = input || {};
      if (!canManageMembers()) return fail('forbidden', { right: RIGHTS.members });
      const shiftId = text(settings.shiftId);
      if (!shiftId) return fail('invalid-shift-id', { field: 'shiftId' });
      const uid = text(settings.uid);
      if (!uid) return fail('invalid-uid', { field: 'uid' });
      const context = readContext(shiftId);
      const shiftRevision = shiftRevisionOf(context);
      if (shiftRevision === null) return fail('revision-unknown', { shiftId, field: 'shift' });
      const member = memberOf(context, uid);
      let membershipRevision = null;
      if (member) {
        membershipRevision = revisionValue(member.revision);
        // Строка участника есть, но её ревизия неизвестна: CAS без числа
        // означал бы «перезаписать что угодно».
        if (membershipRevision === null) return fail('revision-unknown', { shiftId, uid, field: 'membership' });
      }
      const operationId = operationFor(settings.operationId);
      if (!operationId) return fail('invalid-operation-id', { field: 'operationId' });
      return settle(await transport.addMember({
        operationId,
        shiftId,
        uid,
        expectedShiftRevision: shiftRevision,
        expectedMembershipRevision: membershipRevision
      }), { operationId, shiftId });
    }

    async function removeMember(input) {
      const settings = input || {};
      if (!canManageMembers()) return fail('forbidden', { right: RIGHTS.members });
      const shiftId = text(settings.shiftId);
      if (!shiftId) return fail('invalid-shift-id', { field: 'shiftId' });
      const uid = text(settings.uid);
      if (!uid) return fail('invalid-uid', { field: 'uid' });
      const context = readContext(shiftId);
      const shiftRevision = shiftRevisionOf(context);
      if (shiftRevision === null) return fail('revision-unknown', { shiftId, field: 'shift' });
      const member = memberOf(context, uid);
      const membershipRevision = member ? revisionValue(member.revision) : null;
      if (membershipRevision === null) return fail('revision-unknown', { shiftId, uid, field: 'membership' });
      const operationId = operationFor(settings.operationId);
      if (!operationId) return fail('invalid-operation-id', { field: 'operationId' });
      return settle(await transport.removeMember({
        operationId,
        shiftId,
        uid,
        expectedShiftRevision: shiftRevision,
        expectedMembershipRevision: membershipRevision
      }), { operationId, shiftId });
    }

    // Итоги берутся из receipt prepare; если сервер их там не прислал (§5.5
    // перечисляет только токен и ревизии), единственный честный источник —
    // снимок контекста этой смены, а не локальные счётчики экрана.
    function closeTotals(receipt, context) {
      const receiptTrips = Number(receipt && receipt.totalTrips);
      if (Number.isFinite(receiptTrips) && receiptTrips >= 0) {
        const receiptVolume = Number(receipt.totalVolume);
        return { totalTrips: receiptTrips, totalVolume: Number.isFinite(receiptVolume) ? receiptVolume : 0, source: 'receipt' };
      }
      const logs = context && context.snapshot && Array.isArray(context.snapshot.logs) ? context.snapshot.logs : [];
      const volume = logs.reduce((sum, log) => {
        const value = Number(log && log.volume);
        return Number.isFinite(value) ? sum + value : sum;
      }, 0);
      return { totalTrips: logs.length, totalVolume: volume, source: 'snapshot' };
    }

    async function closeShift(input) {
      const settings = input || {};
      if (!canClose()) return fail('forbidden', { right: RIGHTS.close });
      const shiftId = text(settings.shiftId);
      if (!shiftId) return fail('invalid-shift-id', { field: 'shiftId' });
      const context = readContext(shiftId);
      const expectedShiftRevision = shiftRevisionOf(context);
      if (expectedShiftRevision === null) return fail('revision-unknown', { shiftId, field: 'shift' });
      const base = operationFor(settings.operationId);
      if (!base) return fail('invalid-operation-id', { field: 'operationId' });

      const phases = [];
      const prepared = await transport.prepareClose({
        operationId: phaseId(base, 'prepare'),
        shiftId,
        expectedShiftRevision
      });
      phases.push('prepare');
      if (!prepared || prepared.ok !== true) return settle(prepared, { operationId: base, phases });
      const receipt = isRecord(prepared.result) ? prepared.result : {};
      const closeToken = receipt.closeToken;
      if (!isNonEmptyString(closeToken)) {
        return fail('invalid-api-response', { reason: 'close-token-missing', phase: 'prepare' });
      }
      const archiveRevision = revisionValue(receipt.archiveRevision);
      if (archiveRevision === null || archiveRevision < 1) {
        return fail('invalid-api-response', { reason: 'archive-revision-missing', phase: 'prepare' });
      }
      let shiftRevision = revisionValue(receipt.shiftRevision);
      if (shiftRevision === null) {
        return fail('invalid-api-response', { reason: 'shift-revision-missing', phase: 'prepare' });
      }

      const totals = closeTotals(receipt, context);
      let markerRevision = null;
      if (totals.totalTrips > 0) {
        const materialId = text(settings.materialId);
        const volume = Number(settings.volume);
        if (!materialId || !Number.isFinite(volume) || volume < 0) {
          return Object.assign(
            fail('material-required', {
              totalTrips: totals.totalTrips,
              totalVolume: totals.totalVolume,
              archiveRevision,
              closeToken,
              shiftRevision
            }),
            { operationId: base, phases }
          );
        }
        const material = await transport.confirmMaterial({
          operationId: phaseId(base, 'material'),
          shiftId,
          closeToken,
          materialId,
          volume,
          expectedShiftRevision: shiftRevision,
          expectedArchiveRevision: archiveRevision,
          // null — значение CAS «маркера ещё нет», а не отсутствие поля.
          expectedMaterialMarkerRevision: null
        });
        phases.push('material');
        if (!material || material.ok !== true) return settle(material, { operationId: base, phases });
        const materialReceipt = isRecord(material.result) ? material.result : {};
        markerRevision = revisionValue(materialReceipt.materialMarkerRevision);
        if (markerRevision === null || markerRevision < 1) {
          return fail('invalid-api-response', { reason: 'material-marker-revision-missing', phase: 'material' });
        }
        const materialShiftRevision = revisionValue(materialReceipt.shiftRevision);
        if (materialShiftRevision !== null) shiftRevision = materialShiftRevision;
      }

      const finished = await transport.finishClose({
        operationId: phaseId(base, 'finish'),
        shiftId,
        closeToken,
        expectedShiftRevision: shiftRevision,
        expectedArchiveRevision: archiveRevision,
        expectedMaterialMarkerRevision: markerRevision
      });
      phases.push('finish');
      if (!finished || finished.ok !== true) return settle(finished, { operationId: base, phases });
      return {
        ok: true,
        code: 'closed',
        operationId: base,
        phases,
        result: finished.result,
        totals,
        closeToken
      };
    }

    function describe(input) {
      const code = isNonEmptyString(input)
        ? input
        : (isRecord(input) && isNonEmptyString(input.code) ? input.code : '');
      return MESSAGES[code] || UNKNOWN_MESSAGE;
    }

    return {
      canCreate,
      canManageMembers,
      canClose,
      canForceTransfer,
      createShift,
      addMember,
      removeMember,
      closeShift,
      describe
    };
  }

  const api = { createShiftManagement };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestShiftManagement = api;
})(typeof window !== 'undefined' ? window : globalThis);
