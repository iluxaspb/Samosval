// Интерфейс параллельных смен, которого не хватало клиенту (design §10.2):
//   1) принудительный перевод самосвала в другую смену с крупным подтверждением;
//   2) блок «Рейсы, оставшиеся в прежней смене» с действием «завершить в
//      прежней смене».
//
// Модуль не рисует сам себя на старте и ничего не делает без моста v2: экран
// «Линия» без флага WORKING_TEST_V2_SHIFTS остаётся ровно таким, как в 1.8.7.
// Команды уходят только через транспорт v2 и только online: обе операции
// меняют сразу две смены, поэтому офлайн-очередь для них запрещена (§9).
//
// CAS берётся из фактических контекстов смен, а не из догадок. Если ревизия
// второй смены неизвестна (она не загружена в этом окне), действие честно
// недоступно с причиной: тело с выдуманной ревизией сервер отверг бы, и
// пользователь получил бы ложную ошибку вместо правды.
//
// Файл — classic script (IIFE → globalThis). DOM инжектируется (doc/mount),
// поэтому блок проверяется фейковым DOM без браузера.
(function (root) {
  'use strict';

  const STAGE_LABELS = {
    arrive: 'Прибытие',
    arrived: 'Прибытие',
    load: 'Погрузка',
    loaded: 'Погрузка',
    ttn: 'ТТН',
    'ttn-pending': 'Ожидает ТТН'
  };
  const SHIFT_TYPE_LABELS = { day: 'День', night: 'Ночь' };
  const BLOCK_TITLE = 'Рейсы, оставшиеся в прежней смене';
  const OFFLINE_NOTE = 'Нет сети: завершение рейса в прежней смене доступно только при связи.';
  const OTHER_SHIFT_NOTE = 'Данные второй смены не загружены: обновите экран или попросите администратора завершить рейс.';
  const UNKNOWN_TRUCK = 'Самосвал не указан';
  const UNKNOWN_SHIFT = 'Смена не указана';
  const UNKNOWN_OBJECT = 'Объект не указан';
  const UNKNOWN_DATE = 'Дата не указана';
  const UNKNOWN_TYPE = 'Тип смены не подтверждён';
  const UNKNOWN_STAGE = 'Стадия не подтверждена';
  const COMPLETE_LABEL = 'Завершить в прежней смене';

  // Стабильные коды v2 → человеческий текст. Это только те коды, которые
  // встречаются в этих операциях; остальное отдаёт describeError моста.
  const MESSAGES = {
    forbidden: 'Недостаточно прав для перевода самосвала. Обратитесь к администратору.',
    'online-required': 'Для перевода самосвала и завершения переведённого рейса нужна связь: офлайн эти действия не выполняются.',
    'revision-unknown': 'Данные смены ещё не загружены с сервера. Обновите экран и повторите действие.',
    'source-shift-unavailable': 'Прежняя смена не загружена в этом окне. Обновите экран; если не поможет — переведите самосвал из окна администратора.',
    'destination-shift-unavailable': 'Вторая смена не загружена в этом окне. Обновите экран; если не поможет — попросите администратора завершить рейс.',
    'revision-conflict': 'Данные изменил другой пользователь. Диалог закрыт: обновите экран и повторите действие.',
    'shift-changed': 'Смена изменилась, пока шло действие. Обновите экран и повторите действие.',
    'transfer-context-changed': 'Смена самосвала уже изменилась. Обновите экран и повторите действие.',
    'truck-not-on-shift': 'Самосвал уже не в этой смене. Обновите экран и повторите действие.',
    'truck-detached-trip-open': 'У самосвала есть незавершённый рейс в прежней смене. Сначала завершите его, потом переводите самосвал.',
    'truck-assigned-to-other-shift': 'Самосвал работает в другой активной смене.',
    'detached-trip-not-found': 'Рейс уже не найден в прежней смене. Обновите экран.',
    'detached-trip-completed': 'Этот рейс уже завершён в прежней смене. Обновите экран.',
    'trip-completed': 'Этот рейс уже завершён в прежней смене. Обновите экран.',
    'shift-closed': 'Смена уже закрыта. Действие в закрытую смену не записывается.',
    'shift-closing': 'Смена закрывается: новые действия в неё не записываются.',
    'shift-not-visible': 'Смена недоступна в этом окне. Обновите экран и повторите действие.',
    'not-shift-member': 'Вы больше не участник этой смены. Попросите старшего прораба назначить вас заново.',
    'protocol-upgrade-required': 'Сервер требует новую версию приложения. Обновите страницу и повторите действие.',
    'invalid-context': 'Не выбрана смена: откройте нужную смену и повторите действие.',
    'transport-unavailable': 'Связь с сервером смен не готова. Обновите экран и повторите действие.',
    'confirmation-unavailable': 'Не удалось показать подтверждение перевода. Обновите экран и повторите действие.',
    'invalid-trip': 'Рейс не найден в списке. Обновите экран.',
    'transport-failed': 'Не удалось связаться с сервером. Проверьте связь и повторите действие.'
  };
  const UNKNOWN_MESSAGE = 'Не удалось выполнить действие. Обновите экран и повторите; если ошибка повторяется — сообщите администратору.';

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function firstText() {
    for (let index = 0; index < arguments.length; index += 1) {
      const value = arguments[index];
      if (isNonEmptyString(value)) return value.trim();
    }
    return '';
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

  // Ревизия смены/статуса всегда ≥ 1 (сервер отвергает 0 как invalid-command).
  // Всё остальное — «неизвестна»: отправлять такую команду нельзя.
  function revisionValue(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1 ? number : null;
  }

  // Сервер отдаёт дату как ГГГГ-ММ-ДД; экран показывает ДД.ММ.ГГГГ. Любой
  // другой вид значения выводится как есть — догадываться о формате нельзя.
  function dateText(value) {
    const raw = text(value);
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    return iso ? iso[3] + '.' + iso[2] + '.' + iso[1] : raw;
  }

  function shiftTypeText(value) {
    const raw = text(value);
    if (!raw) return '';
    return SHIFT_TYPE_LABELS[raw] || raw;
  }

  function stageText(value) {
    const raw = text(value);
    if (!raw) return '';
    return STAGE_LABELS[raw] || raw;
  }

  // Подпись смены: объект · дата · день/ночь. Каждая часть либо пришла от
  // сервера, либо помечена честной подписью — выводить id вместо имени
  // объекта нельзя (design §10.2, уроки 60/61).
  function shiftLabel(row) {
    const source = isRecord(row) ? row : {};
    const object = firstText(source.objectName);
    const date = dateText(firstText(source.workDate, source.date));
    const type = shiftTypeText(firstText(source.shiftType, source.workShift, source.type));
    return [
      object || UNKNOWN_OBJECT,
      date || UNKNOWN_DATE,
      type || UNKNOWN_TYPE
    ].join(' · ');
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createShiftTransferUi(options) {
    const config = options || {};
    const store = config.store || null;
    const transport = config.transport || null;
    const doc = config.doc || null;
    const mount = config.mount || null;
    const confirmDialog = typeof config.confirm === 'function' ? config.confirm : null;
    const notify = typeof config.notify === 'function' ? config.notify : function () {};
    const truckLabelOf = typeof config.truckLabel === 'function' ? config.truckLabel : function () { return ''; };
    const objectLabelOf = typeof config.objectLabel === 'function' ? config.objectLabel : function () { return ''; };
    const describeError = typeof config.describeError === 'function' ? config.describeError : null;
    const onChange = typeof config.onChange === 'function' ? config.onChange : function () {};
    const now = typeof config.now === 'function' ? config.now : function () { return Date.now(); };
    let sequence = 0;
    let lastRenderKey = null;

    function onlineNow() {
      if (typeof config.online === 'function') return config.online() === true;
      return config.online !== false;
    }

    function rightsNow() {
      const source = config.rights;
      const value = typeof source === 'function' ? source() : source;
      return isRecord(value) ? value : {};
    }

    function hasRight(name) {
      return rightsNow()[name] === true;
    }

    // Право перевода — не только матрица прав: §6 разрешает перевод админу и
    // старшему прорабу, сервер проверяет роль отдельно. UI повторяет ту же
    // границу, чтобы прораб не получал крупный confirm, который сервер потом
    // отклонит.
    function mayForceTransfer() {
      if (!hasRight('force_transfer_truck')) return false;
      if (typeof config.forceTransferAllowed === 'function') return config.forceTransferAllowed() === true;
      return true;
    }

    function newOperationId() {
      if (typeof config.newOperationId === 'function') {
        const supplied = config.newOperationId();
        if (isNonEmptyString(supplied)) return supplied.trim();
      }
      sequence += 1;
      return 'op_' + Number(now()).toString(36) + '_' + sequence.toString(36)
        + '_' + Math.random().toString(36).slice(2, 10);
    }

    function contextOf(shiftId) {
      if (!isNonEmptyString(shiftId) || !store || typeof store.context !== 'function') return null;
      try {
        return store.context(shiftId);
      } catch (_) {
        return null;
      }
    }

    function shiftRowOf(shiftId) {
      const context = contextOf(shiftId);
      if (!context) return null;
      if (isRecord(context.shift)) return context.shift;
      if (context.snapshot && isRecord(context.snapshot.shift)) return context.snapshot.shift;
      return null;
    }

    function shiftRevisionOf(shiftId) {
      const context = contextOf(shiftId);
      if (!context) return null;
      const direct = revisionValue(context.revisions && context.revisions.shift);
      if (direct !== null) return direct;
      const snapshot = context.snapshot;
      if (isRecord(snapshot)) {
        const fromSnapshot = revisionValue(snapshot.shiftRevision);
        if (fromSnapshot !== null) return fromSnapshot;
        return revisionValue(snapshot.revisions && snapshot.revisions.shift);
      }
      return null;
    }

    function statusRowOf(shiftId, truckId) {
      const context = contextOf(shiftId);
      const statuses = context && context.snapshot && Array.isArray(context.snapshot.statuses)
        ? context.snapshot.statuses
        : [];
      return statuses.find(row => isRecord(row) && (row.id === truckId || row.truckId === truckId)) || null;
    }

    function truckLabel(truckId) {
      if (!isNonEmptyString(truckId)) return '';
      let label = '';
      try {
        label = truckLabelOf(truckId);
      } catch (_) {
        label = '';
      }
      return text(label);
    }

    // Объект исходной смены сервер в details называет только id, поэтому имя
    // берётся из общего справочника объектов — это реальный справочник, а не
    // догадка. Нет объекта в справочнике — честная подпись.
    function objectLabel(objectId) {
      if (!isNonEmptyString(objectId)) return '';
      let label = '';
      try {
        label = objectLabelOf(objectId);
      } catch (_) {
        label = '';
      }
      return text(label);
    }

    function messageFor(code) {
      if (isNonEmptyString(code) && MESSAGES[code]) return MESSAGES[code];
      if (describeError) {
        const described = describeError(code);
        if (isNonEmptyString(described)) return described;
      }
      return UNKNOWN_MESSAGE;
    }

    function failure(code, extra) {
      return Object.assign({ ok: false, code: code, message: messageFor(code) }, extra || {});
    }

    // Подпись исходной смены для перевода: сервер присылает objectId, workDate,
    // shiftType и stage; имя объекта берётся из справочника. Если исходная смена
    // загружена в store, её подпись точнее — она и используется.
    function sourceShiftLabel(details, sourceShiftId) {
      const stored = shiftRowOf(sourceShiftId);
      if (stored) return shiftLabel(stored);
      const object = objectLabel(details.objectId);
      const date = dateText(firstText(details.workDate));
      const type = shiftTypeText(firstText(details.shiftType));
      return [
        object || UNKNOWN_OBJECT,
        date || UNKNOWN_DATE,
        type || UNKNOWN_TYPE
      ].join(' · ');
    }

    function activeShiftId() {
      return store && typeof store.activeShiftId === 'function' ? store.activeShiftId() : null;
    }

    function destinationShiftId(input) {
      return firstText(input && input.destinationShiftId, activeShiftId());
    }

    // Модель крупного подтверждения. Одна и та же для диалога и для теста:
    // экран не собирает текст сам, поэтому состав подтверждения проверяем.
    function describeForceTransfer(input) {
      const settings = input || {};
      const details = isRecord(settings.details) ? settings.details : {};
      const truckId = firstText(settings.truckId, details.truckId);
      const sourceShiftId = firstText(settings.sourceShiftId, details.sourceShiftId);
      const targetShiftId = destinationShiftId(settings);
      const allowed = mayForceTransfer();
      const online = onlineNow();
      const truck = truckLabel(truckId);
      const sourceLabel = sourceShiftLabel(details, sourceShiftId);
      const destinationLabel = targetShiftId ? shiftLabel(shiftRowOf(targetShiftId)) : UNKNOWN_SHIFT;
      const stage = stageText(firstText(details.stage, settings.stage));
      const sourceRevision = shiftRevisionOf(sourceShiftId);
      const destinationRevision = shiftRevisionOf(targetShiftId);
      const status = statusRowOf(sourceShiftId, truckId);
      const statusRevision = revisionValue(status && status.statusRevision);
      const cycleRevision = revisionValue(status && status.cycleRevision);
      const ttnRevision = revisionValue(status && status.ttnRevision);
      const revisionsKnown = sourceRevision !== null && destinationRevision !== null
        && statusRevision !== null && cycleRevision !== null && ttnRevision !== null;

      let blockedReason = '';
      if (!allowed) blockedReason = 'forbidden';
      else if (!online) blockedReason = 'online-required';
      else if (!isNonEmptyString(truckId) || !isNonEmptyString(sourceShiftId) || !isNonEmptyString(targetShiftId)) blockedReason = 'invalid-context';
      else if (!revisionsKnown) blockedReason = 'revision-unknown';

      const lines = [
        'Самосвал: ' + (truck || UNKNOWN_TRUCK),
        'Из смены: ' + sourceLabel,
        'В смену: ' + (destinationLabel || UNKNOWN_SHIFT),
        'Незавершённый рейс: ' + (stage || UNKNOWN_STAGE)
      ];
      const consequences = [
        'Незавершённый рейс останется в прежней смене: ' + sourceLabel + '.',
        'Новые рейсы этого самосвала будут записаны в новую смену: ' + (destinationLabel || UNKNOWN_SHIFT) + '.',
        'Завершение старого рейса будет записано в прежнюю смену: ' + sourceLabel + '.'
      ];
      const irreversible = 'Отменить перевод будет нельзя.';
      const html = lines.map(line => '<b>' + escapeHtml(line.split(': ')[0]) + ':</b> '
        + escapeHtml(line.slice(line.indexOf(': ') + 2))).join('<br>')
        + '<br><br>' + consequences.map(item => '• ' + escapeHtml(item)).join('<br>')
        + '<br><br><b>' + escapeHtml(irreversible) + '</b>';

      return {
        allowed,
        online,
        canConfirm: blockedReason === '',
        blockedReason,
        blockedMessage: blockedReason ? messageFor(blockedReason) : '',
        truckId,
        truckLabel: truck || UNKNOWN_TRUCK,
        sourceShiftId,
        destinationShiftId: targetShiftId,
        sourceLabel,
        destinationLabel: destinationLabel || UNKNOWN_SHIFT,
        stageLabel: stage || UNKNOWN_STAGE,
        lines,
        consequences,
        irreversible,
        title: 'Перевести самосвал в другую смену?',
        message: html,
        confirmLabel: 'Перевести самосвал',
        cancelLabel: 'Оставить как есть',
        revisions: {
          source: sourceRevision,
          destination: destinationRevision,
          status: statusRevision,
          cycle: cycleRevision,
          ttn: ttnRevision
        }
      };
    }

    // Предупреждение без кнопки обхода: у прораба без права перевода остаётся
    // только сообщение с исходной сменой (design §10.2).
    function warnOccupiedTruck(input) {
      const model = describeForceTransfer(input);
      const message = 'Самосвал работает в другой активной смене: ' + model.sourceLabel
        + '. Перевод может выполнить старший прораб или администратор.';
      notify(message, true);
      return { ok: false, code: 'truck-assigned-to-other-shift', message: message, model: model };
    }

    async function refreshShift(shiftId) {
      if (!isNonEmptyString(shiftId) || !transport || typeof transport.readShiftSnapshot !== 'function') return null;
      try {
        return await transport.readShiftSnapshot({ shiftId: shiftId, requestKind: 'ui' });
      } catch (_) {
        return null;
      }
    }

    // Контекст второй смены нужен для CAS. Он читается только когда действие
    // уже начато (нажатие/ответ «занят»), а не на каждой перерисовке.
    async function ensureContext(shiftId) {
      if (!isNonEmptyString(shiftId)) return false;
      const context = contextOf(shiftId);
      if (!context) return false;
      if (shiftRevisionOf(shiftId) !== null) return true;
      await refreshShift(shiftId);
      return shiftRevisionOf(shiftId) !== null;
    }

    // Для перевода нужна ещё и ревизия статуса самосвала в прежней смене.
    // Если снимок прежней смены не загружен, он читается один раз по нажатию.
    async function ensureSourceStatus(sourceShiftId, truckId) {
      if (statusRowOf(sourceShiftId, truckId)) return true;
      await refreshShift(sourceShiftId);
      return !!statusRowOf(sourceShiftId, truckId);
    }

    async function forceTransfer(input) {
      const settings = input || {};
      const model = describeForceTransfer(settings);
      if (!model.canConfirm) return failure(model.blockedReason || 'forbidden', { model: model });
      if (!transport || typeof transport.forceTransferTruck !== 'function') {
        return failure('transport-unavailable', { model: model });
      }
      if (!confirmDialog) return failure('confirmation-unavailable', { model: model });
      let confirmed = false;
      try {
        confirmed = (await confirmDialog(model.title, model.message, {
          confirmLabel: model.confirmLabel,
          cancelLabel: model.cancelLabel,
          variant: 'danger',
          icon: '🚚',
          // Безопасный default: фокус на «Оставить как есть», Enter не
          // подтверждает перевод.
          focus: 'cancel',
          enterConfirms: false
        })) === true;
      } catch (_) {
        confirmed = false;
      }
      if (!confirmed) return { ok: false, code: 'cancelled', cancelled: true, message: 'Перевод отменён.', model: model };
      const response = await transport.forceTransferTruck({
        operationId: newOperationId(),
        sourceShiftId: model.sourceShiftId,
        destinationShiftId: model.destinationShiftId,
        truckId: model.truckId,
        confirmTransfer: true,
        expectedSourceShiftRevision: model.revisions.source,
        expectedDestinationShiftRevision: model.revisions.destination,
        expectedStatusRevision: model.revisions.status,
        expectedCycleRevision: model.revisions.cycle,
        expectedTtnRevision: model.revisions.ttn
      });
      if (!response || response.ok !== true) {
        const error = response && isRecord(response.error) ? response.error : {};
        const code = isNonEmptyString(error.code) ? error.code : 'transport-failed';
        // Конфликт CAS: диалог уже закрыт, повтор молча запрещён. Обе смены
        // перечитываются, чтобы экран показывал фактическое состояние.
        if (code === 'revision-conflict' || code === 'shift-changed' || code === 'transfer-context-changed') {
          await Promise.all([refreshShift(model.sourceShiftId), refreshShift(model.destinationShiftId)]);
          onChange();
        }
        return failure(code, { model: model, details: error.details || {} });
      }
      // Транспорт уже перечитал обе смены (refreshCrossShift); экран получает
      // согласованную проекцию, без повторного чтения по одной смене.
      onChange();
      return { ok: true, code: 'transferred', model: model, result: response.result, crossShift: response.crossShift };
    }

    // Экран самосвала «Добавить»: сначала обычное назначение в выбранную смену.
    // Сервер отвечает truck-assigned-to-other-shift, и только тогда показывается
    // либо предупреждение, либо крупное подтверждение перевода (§10.2).
    async function addTruckToShift(input) {
      const settings = input || {};
      const truckId = firstText(settings.truckId);
      const shiftId = destinationShiftId(settings);
      if (!hasRight('edit_line') || !hasRight('manage_trucks')) {
        return failure('forbidden');
      }
      if (!onlineNow()) return failure('online-required');
      if (!isNonEmptyString(truckId) || !isNonEmptyString(shiftId)) return failure('invalid-context');
      if (!transport || typeof transport.addTruck !== 'function') return failure('transport-unavailable');
      if (!(await ensureContext(shiftId))) return failure('revision-unknown');
      const shiftRevision = shiftRevisionOf(shiftId);
      if (shiftRevision === null) return failure('revision-unknown');
      const response = await transport.addTruck({
        operationId: newOperationId(),
        shiftId: shiftId,
        truckId: truckId,
        expectedShiftRevision: shiftRevision
      });
      if (response && response.ok === true) {
        await refreshShift(shiftId);
        onChange();
        return { ok: true, code: 'assigned', result: response.result };
      }
      const error = response && isRecord(response.error) ? response.error : {};
      const code = isNonEmptyString(error.code) ? error.code : 'transport-failed';
      const details = isRecord(error.details) ? error.details : {};
      if (code === 'truck-assigned-to-other-shift') {
        const occupied = {
          truckId: truckId,
          sourceShiftId: firstText(details.sourceShiftId),
          destinationShiftId: shiftId,
          details: details
        };
        if (!mayForceTransfer()) return warnOccupiedTruck(occupied);
        // Для CAS нужна и прежняя смена. Если её контекста нет в этом окне,
        // честно говорим об этом, а не отправляем команду без ревизии.
        if (!(await ensureContext(occupied.sourceShiftId))) {
          const message = messageFor('source-shift-unavailable');
          notify(message, true);
          return { ok: false, code: 'source-shift-unavailable', message: message, model: describeForceTransfer(occupied) };
        }
        if (!(await ensureSourceStatus(occupied.sourceShiftId, truckId))) {
          const message = messageFor('truck-not-on-shift');
          notify(message, true);
          return { ok: false, code: 'truck-not-on-shift', message: message, model: describeForceTransfer(occupied) };
        }
        return forceTransfer(occupied);
      }
      return failure(code, { details: details });
    }

    function detachedModule() {
      const api = root.WorkingTestDetachedTrips;
      if (!api || typeof api.createDetachedTrips !== 'function') return null;
      try {
        return api.createDetachedTrips({ transport: transport, online: onlineNow });
      } catch (_) {
        return null;
      }
    }

    // Право завершения зависит от сохранённой стадии — ровно как на сервере
    // (`DETACHED_LINE_ACTIONS`).
    function completionRight(stage) {
      if (stage === 'arrive' || stage === 'arrived') return hasRight('action_arrive');
      if (stage === 'ttn') return hasRight('action_ttn');
      if (stage === 'load' || stage === 'loaded') return hasRight('action_load');
      return false;
    }

    function tripRows(shiftId) {
      const detached = detachedModule();
      if (!detached || !isNonEmptyString(shiftId)) return [];
      try {
        return detached.list(store, shiftId);
      } catch (_) {
        return [];
      }
    }

    // Рейс, оставшийся в прежней смене: подпись источника и стадии берётся из
    // detached-записи, ревизии двух смен — из их контекстов. Без второй смены
    // действие недоступно: cross-shift CAS нельзя подтвердить.
    function describeDetached(shiftId) {
      const detached = detachedModule();
      if (!detached) return [];
      const online = onlineNow();
      return tripRows(shiftId).map(trip => {
        const sourceRevision = shiftRevisionOf(trip.sourceShiftId);
        const destinationRevision = shiftRevisionOf(trip.destinationShiftId);
        const augmented = Object.assign(copy(trip) || {}, {
          expectedSourceShiftRevision: sourceRevision,
          expectedDestinationShiftRevision: destinationRevision
        });
        let base = null;
        try {
          base = detached.describe(augmented);
        } catch (_) {
          base = null;
        }
        const stage = firstText(trip.stage, trip.cycleStage);
        const right = completionRight(stage);
        const revisionsKnown = sourceRevision !== null && destinationRevision !== null;
        let reason = '';
        if (!online) reason = 'offline';
        else if (!revisionsKnown) reason = 'other-shift-unavailable';
        else if (!right) reason = 'forbidden';
        const canComplete = !!base && base.canComplete === true && revisionsKnown && online && right;
        return {
          trip: copy(trip),
          sourceShiftId: trip.sourceShiftId,
          destinationShiftId: trip.destinationShiftId,
          cycleId: firstText(trip.cycleId, trip.detachedCycleId),
          truckId: firstText(trip.truckId),
          truckLabel: truckLabel(trip.truckId) || UNKNOWN_TRUCK,
          stage: stage,
          sourceLabel: base ? base.sourceLabel : UNKNOWN_OBJECT,
          stageLabel: base ? base.stageLabel : (stageText(stage) || UNKNOWN_STAGE),
          warning: base ? base.warning : ('Действие будет записано в исходную смену: ' + UNKNOWN_OBJECT),
          canComplete: canComplete,
          reason: canComplete ? '' : reason,
          reasonText: !online ? OFFLINE_NOTE : (!revisionsKnown ? OTHER_SHIFT_NOTE : (!right ? MESSAGES.forbidden : '')),
          actionLabel: COMPLETE_LABEL
        };
      });
    }

    async function completeDetached(input) {
      const settings = input || {};
      const trip = settings.trip;
      if (!isRecord(trip)) return failure('invalid-trip');
      if (!onlineNow()) return failure('online-required');
      const sourceShiftId = firstText(trip.sourceShiftId);
      const destinationShiftIdValue = firstText(trip.destinationShiftId);
      const stage = firstText(trip.stage, trip.cycleStage);
      if (!completionRight(stage)) return failure('forbidden');
      const detached = detachedModule();
      if (!detached) return failure('transport-unavailable');
      // Обе смены нужны для CAS: читаем недостающую, прежде чем отказывать.
      const [sourceReady, destinationReady] = await Promise.all([
        ensureContext(sourceShiftId),
        ensureContext(destinationShiftIdValue)
      ]);
      if (!sourceReady) return failure('source-shift-unavailable');
      if (!destinationReady) return failure('destination-shift-unavailable');
      const sourceRevision = shiftRevisionOf(sourceShiftId);
      const destinationRevision = shiftRevisionOf(destinationShiftIdValue);
      if (sourceRevision === null || destinationRevision === null) return failure('revision-unknown');
      const augmented = Object.assign(copy(trip) || {}, {
        expectedSourceShiftRevision: sourceRevision,
        expectedDestinationShiftRevision: destinationRevision
      });
      const response = await detached.complete({
        trip: augmented,
        operationId: newOperationId(),
        type: stage,
        truckId: firstText(trip.truckId),
        createdAt: now()
      });
      if (!response || response.ok !== true) {
        const error = response && isRecord(response.error) ? response.error : {};
        const code = isNonEmptyString(error.code)
          ? error.code
          : (isNonEmptyString(response && response.code) ? response.code : 'transport-failed');
        if (code === 'revision-conflict' || code === 'shift-changed' || code === 'transfer-context-changed') {
          await Promise.all([refreshShift(sourceShiftId), refreshShift(destinationShiftIdValue)]);
          onChange();
        }
        return failure(code, { details: (error && error.details) || {} });
      }
      await Promise.all([refreshShift(sourceShiftId), refreshShift(destinationShiftIdValue)]);
      onChange();
      return { ok: true, code: 'completed', result: response.result, crossShift: response.crossShift };
    }

    function element(tag, className, textContent) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (textContent !== undefined) node.textContent = String(textContent);
      return node;
    }

    // Блок на экране «Линия». Пустой список — блок скрыт целиком: без данных
    // он не занимает место и не мешает прежнему экрану (design §10.1).
    function render() {
      if (!doc || !mount) return 0;
      const shiftId = activeShiftId();
      const rows = describeDetached(shiftId);
      const key = JSON.stringify({
        shiftId: shiftId,
        online: onlineNow(),
        rows: rows.map(row => [row.cycleId, row.sourceShiftId, row.truckId, row.stage, row.sourceLabel, row.canComplete, row.reasonText])
      });
      if (key === lastRenderKey) return rows.length;
      lastRenderKey = key;
      mount.textContent = '';
      if (!rows.length) {
        mount.hidden = true;
        return 0;
      }
      mount.hidden = false;
      mount.appendChild(element('div', 'detached-trips-title', BLOCK_TITLE));
      if (!onlineNow()) mount.appendChild(element('p', 'detached-trips-note', OFFLINE_NOTE));
      for (const row of rows) {
        const card = element('div', 'detached-trip-card');
        card.dataset.cycleId = row.cycleId;
        card.dataset.sourceShiftId = row.sourceShiftId;
        card.appendChild(element('div', 'detached-trip-source', row.sourceLabel));
        card.appendChild(element('div', 'detached-trip-truck', 'Самосвал: ' + row.truckLabel));
        card.appendChild(element('p', 'detached-trip-warning', row.warning));
        if (!row.canComplete && row.reasonText) card.appendChild(element('p', 'detached-trip-reason', row.reasonText));
        const button = element('button', 'btn btn-secondary btn-small detached-trip-action', row.actionLabel);
        button.setAttribute('type', 'button');
        button.disabled = row.canComplete !== true;
        button.addEventListener('click', async () => {
          button.disabled = true;
          const result = await completeDetached({ trip: row.trip });
          if (!result.ok) {
            button.disabled = row.canComplete !== true;
            notify(result.message, true);
            return;
          }
          notify('Рейс завершён в прежней смене', false);
        });
        card.appendChild(button);
        mount.appendChild(card);
      }
      return rows.length;
    }

    return Object.freeze({
      describeForceTransfer,
      forceTransfer,
      addTruckToShift,
      describeDetached,
      completeDetached,
      render
    });
  }

  const api = { createShiftTransferUi };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestShiftTransferUi = api;
})(typeof window !== 'undefined' ? window : globalThis);
