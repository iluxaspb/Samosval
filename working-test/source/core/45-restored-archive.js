// Восстановленный архив: provenance, история ревизий и права (design §5.6, §10.1, §10.2).
//
// Архив — immutable revision chain. По умолчанию читается последняя
// опубликованная (latest finalized) ревизия; явный выбор ревизии — отдельный
// read-only просмотр, который никогда не меняет default pointer. Provenance
// показывает исходного автора/тип смены и отдельного восстановившего актора.
// Неразрешённые данные выводятся буквальными текстами «Автор не установлен» и
// «Тип смены не подтверждён»; fallback на sender/displayName/email/hour/createdBy
// запрещён.
//
// Файл — classic script (IIFE → globalThis), без сети и DOM: провайдер ревизий и
// права инжектируются снаружи, поэтому модуль проверяется без сервера.
(function (root) {
  'use strict';

  const MISSING_AUTHOR = 'Автор не установлен';
  const MISSING_TYPE = 'Тип смены не подтверждён';
  const SHIFT_TYPE_LABELS = { day: 'День', night: 'Ночь' };

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

  function revisionNumber(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1 ? number : null;
  }

  function actorLabel(actor, nameSnapshot) {
    if (isRecord(actor)) {
      if (isNonEmptyString(actor.name)) return actor.name.trim();
      if (isNonEmptyString(actor.uid)) return actor.uid;
    }
    if (isNonEmptyString(nameSnapshot)) return nameSnapshot.trim();
    return MISSING_AUTHOR;
  }

  // Серверный литерал неразрешённого значения приходит в нижнем регистре
  // («автор не установлен»), а UI обязан показывать текст design §10.2.
  function sameText(value, literal) {
    return typeof value === 'string' && value.trim().toLowerCase() === literal.toLowerCase();
  }

  // Provenance приходит в двух формах:
  //  - вложенная (инжектируемый провайдер и старые тесты):
  //    {opener, openerResolution, shiftType, shiftTypeResolution,
  //     restoringActor, restoredByNameSnapshot};
  //  - плоская серверная (server/src/restored-context-store.mjs):
  //    {originalOpenedByUid, originalOpenedByName, originalShiftType,
  //     originalShiftTypeResolution, restoredByName, unresolvedAuthor,
  //     unresolvedShiftType, authorText, shiftTypeText}.
  // Читаются обе; серверные флаг и литерал в приоритете, потому что сервер уже
  // доказал (или не доказал) автора и тип смены.
  function flatAuthorLabel(provenance) {
    if (isNonEmptyString(provenance.authorText)) return provenance.authorText.trim();
    if (isNonEmptyString(provenance.originalOpenedByName)) return provenance.originalOpenedByName.trim();
    if (isNonEmptyString(provenance.originalOpenedByUid)) return provenance.originalOpenedByUid;
    return null;
  }

  // Original opener берётся только из archive provenance. Поля sender,
  // displayName, email, createdBy и hour — не доказательство авторства.
  function openerInfo(provenance) {
    if (!isRecord(provenance)) return { label: MISSING_AUTHOR, unresolved: true };
    if (provenance.unresolvedAuthor === true) return { label: MISSING_AUTHOR, unresolved: true };
    const flat = flatAuthorLabel(provenance);
    if (flat !== null) {
      return sameText(flat, MISSING_AUTHOR)
        ? { label: MISSING_AUTHOR, unresolved: true }
        : { label: flat, unresolved: false };
    }
    if (provenance.openerResolution === 'unresolved') return { label: MISSING_AUTHOR, unresolved: true };
    if (!isRecord(provenance.opener)) return { label: MISSING_AUTHOR, unresolved: true };
    const label = actorLabel(provenance.opener, null);
    return label === MISSING_AUTHOR
      ? { label: MISSING_AUTHOR, unresolved: true }
      : { label, unresolved: false };
  }

  // Восстановивший — отдельный актор текущей restore-команды, он не заменяет
  // автора смены и не выводится из его полей. Вложенная форма — restoringActor,
  // плоская серверная — restoredByName.
  function restoringInfo(provenance) {
    if (!isRecord(provenance)) return { label: MISSING_AUTHOR, unresolved: true };
    const nameSnapshot = isNonEmptyString(provenance.restoredByName)
      ? provenance.restoredByName
      : provenance.restoredByNameSnapshot;
    const label = actorLabel(provenance.restoringActor, nameSnapshot);
    return label === MISSING_AUTHOR
      ? { label: MISSING_AUTHOR, unresolved: true }
      : { label, unresolved: false };
  }

  // Тип смены берётся только из archive (shift_type + resolution). Час и
  // workShift/type-алиасы не являются доказательством и не используются.
  function shiftTypeLabel(value) {
    if (!isNonEmptyString(value)) return null;
    const key = value.trim();
    if (SHIFT_TYPE_LABELS[key]) return SHIFT_TYPE_LABELS[key];
    const known = Object.keys(SHIFT_TYPE_LABELS).some(code => SHIFT_TYPE_LABELS[code] === key);
    return known ? key : null;
  }

  function shiftTypeInfo(provenance) {
    if (!isRecord(provenance)) return { label: MISSING_TYPE, unresolved: true };
    if (provenance.unresolvedShiftType === true) return { label: MISSING_TYPE, unresolved: true };
    // Плоская серверная форма: shiftTypeText — готовый текст (сырой тип или
    // серверный литерал), originalShiftType — исходный shift_type.
    const text = isNonEmptyString(provenance.shiftTypeText)
      ? provenance.shiftTypeText.trim()
      : (isNonEmptyString(provenance.originalShiftType) ? provenance.originalShiftType.trim() : '');
    if (text) {
      if (sameText(text, MISSING_TYPE)) return { label: MISSING_TYPE, unresolved: true };
      const flatLabel = shiftTypeLabel(text);
      return flatLabel
        ? { label: flatLabel, unresolved: false }
        : { label: MISSING_TYPE, unresolved: true };
    }
    if (provenance.shiftTypeResolution === 'unresolved') return { label: MISSING_TYPE, unresolved: true };
    const label = shiftTypeLabel(provenance.shiftType);
    return label
      ? { label, unresolved: false }
      : { label: MISSING_TYPE, unresolved: true };
  }

  function createRestoredArchive(options) {
    const config = options || {};
    const restoredContextId = isNonEmptyString(config.restoredContextId) ? config.restoredContextId : '';

    function latestRevisionNumber() {
      const source = config.latestRevision;
      const value = typeof source === 'function' ? source() : source;
      return revisionNumber(value);
    }

    // Provenance для UI: {opener, shiftType, restoringActor, lines[], unresolved[]}.
    // lines — готовые строки карточки, чтобы UI не собирал буквальные тексты сам.
    function describeProvenance(provenance) {
      const opener = openerInfo(provenance);
      const shiftType = shiftTypeInfo(provenance);
      const restoringActor = restoringInfo(provenance);
      const unresolved = [];
      if (opener.unresolved) unresolved.push('opener');
      if (shiftType.unresolved) unresolved.push('shiftType');
      if (restoringActor.unresolved) unresolved.push('restoringActor');
      return {
        opener: opener.label,
        shiftType: shiftType.label,
        restoringActor: restoringActor.label,
        lines: [
          'Автор: ' + opener.label,
          'Тип смены: ' + shiftType.label,
          'Восстановил: ' + restoringActor.label
        ],
        unresolved
      };
    }

    // Ревизия приходит в двух формах: вложенная/инжектируемая
    // {archiveRevision, archiveSha256, publishedAt, finalized} и серверная
    // {revision, sha256, createdAt} (server/src/archive-latest.mjs, toRevision).
    // Серверная строка всегда финализирована: в серии других ревизий не бывает.
    function revisionInfo(revision) {
      if (!isRecord(revision)) return null;
      const legacyNumber = revisionNumber(revision.archiveRevision);
      const serverNumber = revisionNumber(revision.revision);
      const number = legacyNumber !== null ? legacyNumber : serverNumber;
      if (number === null) return null;
      const finalized = revision.finalized === true
        ? true
        : (revision.finalized === false ? false : serverNumber !== null);
      return {
        number,
        finalized,
        sha256: isNonEmptyString(revision.archiveSha256)
          ? revision.archiveSha256
          : (isNonEmptyString(revision.sha256) ? revision.sha256 : ''),
        publishedAt: isNonEmptyString(revision.publishedAt)
          ? revision.publishedAt
          : (isNonEmptyString(revision.createdAt) ? revision.createdAt : '')
      };
    }

    // Копия выбранной ревизии с явным флагом. Для серверной формы добавляются
    // привычные UI поля (archiveRevision/archiveSha256/publishedAt/finalized),
    // чтобы модалка читала их без правок.
    function withExplicit(revision, info, explicit) {
      const result = Object.assign(copy(revision), { explicit });
      if (result.archiveRevision === undefined) result.archiveRevision = info.number;
      if (result.archiveSha256 === undefined) result.archiveSha256 = info.sha256;
      if (result.publishedAt === undefined) result.publishedAt = info.publishedAt;
      if (result.finalized === undefined) result.finalized = info.finalized;
      return result;
    }

    // Default pointer — единственная authoritative latest finalized revision.
    // Пустой/битый список не превращается в выдуманную ревизию 1.
    function resolveDefault(revisions) {
      if (!Array.isArray(revisions)) return null;
      let latest = null;
      let latestInfo = null;
      let latestNumber = 0;
      for (const revision of revisions) {
        const info = revisionInfo(revision);
        if (!info || info.finalized !== true) continue;
        if (info.number <= latestNumber) continue;
        latest = revision;
        latestInfo = info;
        latestNumber = info.number;
      }
      if (!latest) return null;
      return withExplicit(latest, latestInfo, false);
    }

    // Explicit revision — отдельный read-only выбор. Он возвращает копию с
    // explicit:true и не участвует в вычислении default pointer.
    function selectRevision(revisions, revisionNumberInput) {
      if (!Array.isArray(revisions)) return null;
      const wanted = revisionNumber(revisionNumberInput);
      if (wanted === null) return null;
      for (const revision of revisions) {
        const info = revisionInfo(revision);
        if (!info || info.finalized !== true) continue;
        if (info.number !== wanted) continue;
        return withExplicit(revision, info, true);
      }
      return null;
    }

    // Описание ревизии не содержит редактируемых полей: explicit или не-latest
    // помечается readOnly, правки идут только через latest finalized context.
    function describeRevision(revision) {
      const info = revisionInfo(revision);
      if (!info) return null;
      const latest = latestRevisionNumber();
      const readOnly = revision.explicit === true || (latest !== null && info.number !== latest);
      return {
        revision: info.number,
        sha256: info.sha256,
        publishedAt: info.publishedAt,
        label: 'Ревизия ' + info.number + (info.finalized === true ? ' · опубликована' : ' · не опубликована'),
        readOnly
      };
    }

    // Archive ACL: правка рейсов/ТТН и публикация ревизии. Обе не дают
    // активных line-команд (arrive/load/reset, состав, close).
    function canCorrect(rights) {
      return isRecord(rights) && rights.archive_edit === true;
    }

    function canFinalize(rights, contextId) {
      if (!canCorrect(rights)) return false;
      const target = contextId === undefined ? restoredContextId : contextId;
      return isNonEmptyString(target);
    }

    // Ручное уточнение авторства — только admin или отдельное legacy-право.
    function canResolveManually(rights) {
      if (!isRecord(rights)) return false;
      return rights.admin === true || rights.legacy_resolve === true || rights.role === 'admin';
    }

    // Восстановленный архив никогда не является активной сменой: ни в полосе
    // открытых линий, ни в active line-командах.
    function isRestoredRow(row) {
      if (!isRecord(row)) return false;
      if (row.restored === true) return true;
      if (isNonEmptyString(row.restoredFrom) || (isRecord(row.restoredFrom) && Object.keys(row.restoredFrom).length > 0)) return true;
      if (isNonEmptyString(row.restoredContextId)) return true;
      if (isRecord(row.restoredContext) && Object.keys(row.restoredContext).length > 0) return true;
      return row.state === 'historical';
    }

    return Object.freeze({
      describeProvenance,
      resolveDefault,
      selectRevision,
      describeRevision,
      canCorrect,
      canFinalize,
      canResolveManually,
      isRestoredRow
    });
  }

  const api = { createRestoredArchive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestRestoredArchive = api;
})(typeof window !== 'undefined' ? window : globalThis);
