// Клиентский офлайн-журнал команд v2 (design §9).
//
// Каждая persisted-команда — неизменяемый конверт: uid, workspaceId, shiftId,
// protocolVersion:2, operationId, commandType, каноническое body, исходные
// expected revisions, createdAt и commandHash. При replay ни одно из этих
// полей не подменяется текущим аккаунтом или выбранной сменой: журнал не знает
// про «текущую» смену вообще, он читает ровно тот scope, который записан в
// ключе хранения.
//
// Storage разделён по uid/workspaceId/shiftId/protocolVersion, поэтому две
// смены одного uid — две независимые очереди, а очередь чужого uid не
// показывается и не отправляется, пока не вернётся тот же uid (seal/unseal)
// либо пользователь явно не удалит её (purge). Проекция и dead-letter тоже
// scoped: карточка смены видит только свою очередь, общий бейдж — сумму по uid.
//
// Файл — classic script (IIFE → globalThis), без DOM и сети: storage
// инжектируется (в браузере — localStorage, в тестах — Map-совместимая
// заглушка). Формат хранения — обычный JSON, поэтому обновление PWA и выход из
// аккаунта очередь не стирают.
(function (root) {
  'use strict';

  const PROTOCOL_VERSION = 2;
  const KEY_PREFIX = 'samosval:offline-v2:';
  // Эти команды меняют сразу две смены: их cross-shift CAS нельзя подтвердить
  // из очереди, поэтому сервер отвечает на них `409 online-required`, а клиент
  // обязан отказать ещё до записи (design §9, урок 55).
  const ONLINE_ONLY_COMMANDS = [
    'force-transfer', 'force_transfer',
    'detached-complete', 'detached-trip-complete', 'complete-detached-trip'
  ];
  // Отказы, которые не станут успешными от повтора: очередь не «переигрывает»
  // их молча, запись уходит в dead-letter этой смены.
  const PERMANENT_REJECTIONS = ['shift-closed', 'not-shift-member', 'protocol-upgrade-required', 'online-required'];
  // Разрешимые конфликты: код и безопасные details остаются пользователю.
  const CONFLICT_REJECTIONS = ['shift-changed', 'revision-conflict', 'truck-not-on-shift', 'archive-changed', 'operation-id-reused', 'operation-hash-conflict'];
  // Только эти поля серверных details можно хранить и показывать: никаких
  // телефонов, почты, uid и вложенных объектов. Список совпадает с серверным
  // `DETAIL_KEYS` (server/src/v2-errors.mjs) плюс поля клиента: иначе журнал
  // терял половину `actual*` и не мог объяснить конфликт ревизий.
  const SAFE_DETAIL_KEYS = [
    // серверный закрытый список (v2-errors.mjs)
    'field', 'reason', 'state', 'limit', 'cursor',
    'operationId', 'protocolVersion',
    'shiftId', 'objectId', 'workDate', 'shiftType', 'truckId',
    'sourceShiftId', 'destinationShiftId', 'cycleId', 'stage',
    'expectedRevision', 'actualRevision',
    'expectedShiftRevision', 'actualShiftRevision',
    'expectedMembershipRevision', 'actualMembershipRevision',
    'expectedStatusRevision', 'actualStatusRevision',
    'expectedCycleRevision', 'actualCycleRevision',
    'expectedTtnRevision', 'actualTtnRevision',
    'expectedDetachedCycleRevision', 'actualDetachedCycleRevision',
    'expectedArchiveRevision', 'actualArchiveRevision',
    'expectedMaterialMarkerRevision', 'actualMaterialMarkerRevision',
    'retryAfterSeconds', 'replayed',
    // поля, которые клиент формирует сам
    'phase', 'type', 'conflict', 'objectName', 'archiveId', 'archiveRevision',
    'recordId', 'restoredContextId', 'contextRevision',
    'currentRevision', 'shiftRevision', 'status'
  ];
  const MAX_DETAIL_LENGTH = 200;
  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
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

  function fail(code, details) {
    return { ok: false, error: { code, details: details || {} } };
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

  function isOnlineOnlyCommand(commandType) {
    return ONLINE_ONLY_COMMANDS.indexOf(String(commandType || '')) >= 0;
  }

  // RFC 8785-совместимый канонический JSON: ключи отсортированы по UTF-16,
  // без пробелов, без undefined (в объекте такой ключ просто отсутствует).
  // Так одинаковый конверт даёт одинаковый хеш, а изменённое semantic-поле —
  // другой, независимо от порядка ключей у вызывающего.
  function canonicalJson(value) {
    return serialize(value, new Set(), '$');
  }

  function serialize(value, stack, path) {
    if (value === null) return 'null';
    switch (typeof value) {
      case 'boolean': return value ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects a non-finite number at ' + path);
        if (Object.is(value, -0)) return '0';
        return JSON.stringify(value);
      case 'string': return JSON.stringify(value);
      case 'undefined': throw new TypeError('canonical JSON rejects undefined at ' + path);
      case 'object': break;
      default: throw new TypeError('canonical JSON rejects ' + typeof value + ' at ' + path);
    }
    if (stack.has(value)) throw new TypeError('canonical JSON rejects a cyclic reference at ' + path);
    if (Array.isArray(value)) {
      stack.add(value);
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError('canonical JSON rejects a sparse array at ' + path + '[' + index + ']');
        items.push(serialize(value[index], stack, path + '[' + index + ']'));
      }
      stack.delete(value);
      return '[' + items.join(',') + ']';
    }
    stack.add(value);
    const members = [];
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      members.push(JSON.stringify(key) + ':' + serialize(value[key], stack, path + '.' + key));
    }
    stack.delete(value);
    return '{' + members.join(',') + '}';
  }

  // UTF-8 без TextEncoder: модуль не должен зависеть от окружения.
  function utf8Bytes(text) {
    const bytes = [];
    for (let index = 0; index < text.length; index += 1) {
      let code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          index += 1;
        }
      }
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    return bytes;
  }

  function rotr(value, shift) {
    return (value >>> shift) | (value << (32 - shift));
  }

  function sha256Hex(text) {
    const bytes = utf8Bytes(String(text));
    const bitLength = bytes.length * 8;
    const total = Math.ceil((bytes.length + 9) / 64) * 64;
    const buffer = new Uint8Array(total);
    buffer.set(bytes);
    buffer[bytes.length] = 0x80;
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    buffer[total - 8] = (high >>> 24) & 0xff;
    buffer[total - 7] = (high >>> 16) & 0xff;
    buffer[total - 6] = (high >>> 8) & 0xff;
    buffer[total - 5] = high & 0xff;
    buffer[total - 4] = (low >>> 24) & 0xff;
    buffer[total - 3] = (low >>> 16) & 0xff;
    buffer[total - 2] = (low >>> 8) & 0xff;
    buffer[total - 1] = low & 0xff;

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    for (let offset = 0; offset < total; offset += 64) {
      for (let index = 0; index < 16; index += 1) {
        w[index] = (buffer[offset + index * 4] << 24) | (buffer[offset + index * 4 + 1] << 16)
          | (buffer[offset + index * 4 + 2] << 8) | buffer[offset + index * 4 + 3];
      }
      for (let index = 16; index < 64; index += 1) {
        const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3);
        const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10);
        w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let index = 0; index < 64; index += 1) {
        const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const choose = (e & f) ^ (~e & g);
        const temp1 = (h + sum1 + choose + SHA256_K[index] + w[index]) >>> 0;
        const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (sum0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map(value => value.toString(16).padStart(8, '0'))
      .join('');
  }

  // Семантические поля конверта: всё, что определяет, какая именно команда
  // была сохранена. Хеш — локальная идентичность записи (сервер считает свой
  // receipt-хеш по семи полям провода), поэтому createdAt тоже входит.
  const HASH_FIELDS = [
    'uid', 'workspaceId', 'shiftId', 'protocolVersion', 'operationId',
    'commandType', 'body', 'expectedRevisions', 'createdAt'
  ];

  function commandHash(command, scope) {
    const parts = {};
    for (const field of HASH_FIELDS) {
      const value = field === 'uid' || field === 'workspaceId'
        ? (scope ? scope[field] : command[field])
        : command[field];
      if (value !== undefined) parts[field] = value;
    }
    return sha256Hex(canonicalJson(parts));
  }

  // Классификация ответа сервера на replay (§9): что делать с записью.
  // permanent → dead-letter этой смены; conflict → явный конфликт с кодом и
  // безопасными details; иначе — обычный отказ, повтор разрешён.
  function classifyReplayFailure(input) {
    const settings = input || {};
    const code = isNonEmptyString(settings.code) ? settings.code : 'replay-failed';
    const status = Number(settings.status);
    const permanent = PERMANENT_REJECTIONS.indexOf(code) >= 0 || status === 426;
    return {
      code,
      status: Number.isFinite(status) ? status : 0,
      permanent,
      deadLetter: permanent,
      conflict: CONFLICT_REJECTIONS.indexOf(code) >= 0,
      details: safeDetails(settings.details)
    };
  }

  // Тело команды: ровно те поля, которые уходят в line-операцию. Список
  // фиксирован, поэтому конверт не зависит от того, что ещё лежит в
  // runtime-записи очереди (актёр, проекция, beforeStatus).
  const BODY_FIELDS = [
    'truckId', 'type', 'wantArrived', 'collect', 'cycleMinutes',
    'arrivalTimestamp', 'lastLoadTimestamp', 'volume', 'isGAI', 'truckName'
  ];
  const BODY_NUMBERS = ['cycleMinutes', 'arrivalTimestamp', 'lastLoadTimestamp', 'volume'];
  const BODY_BOOLEANS = ['wantArrived', 'collect', 'isGAI'];

  function envelopeBody(op) {
    const body = {};
    for (const field of BODY_FIELDS) {
      const value = op[field];
      if (value === undefined || value === null) continue;
      if (BODY_NUMBERS.indexOf(field) >= 0) {
        const number = Number(value);
        if (!Number.isFinite(number)) return null;
        body[field] = number;
      } else if (BODY_BOOLEANS.indexOf(field) >= 0) {
        body[field] = value === true;
      } else if (typeof value === 'string') {
        body[field] = value;
      } else {
        return null;
      }
    }
    if (!isNonEmptyString(body.truckId) || !isNonEmptyString(body.type)) return null;
    return body;
  }

  function envelopeRevisions(op) {
    const revisions = {};
    const add = (key, value) => {
      if (value === undefined || value === null || value === '') return;
      const number = Number(value);
      if (Number.isSafeInteger(number) && number >= 0) revisions[key] = number;
    };
    add('shift', op.expectedShiftRevision);
    add('status', op.expectedStatusRevision);
    add('cycle', op.expectedRevision !== undefined ? op.expectedRevision : op.expectedCycleRevision);
    add('ttn', op.expectedTtnRevision);
    return revisions;
  }

  // Runtime-запись очереди → канонический конверт §9. Чистая функция: ничего
  // не читает и не пишет, поэтому её результат можно сохранить и позже
  // побайтово сравнить с тем, что уйдёт на сервер. scope обязателен: uid и
  // workspaceId записи не берутся из «текущего» аккаунта.
  function buildCommandEnvelope(op, scope) {
    if (!isRecord(op)) return fail('invalid-command', { field: 'command' });
    const owner = isRecord(scope) ? scope : {};
    if (!isNonEmptyString(owner.uid) || !isNonEmptyString(owner.workspaceId)) {
      return fail('invalid-command', { field: 'scope' });
    }
    if (!isNonEmptyString(op.id)) return fail('invalid-command', { field: 'operationId' });
    if (!isNonEmptyString(op.shiftId)) return fail('invalid-command', { field: 'shiftId' });
    if (!isNonEmptyString(op.type)) return fail('invalid-command', { field: 'commandType' });
    const createdAt = Number(op.createdAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0) return fail('invalid-command', { field: 'createdAt' });
    const body = envelopeBody(op);
    if (!body) return fail('invalid-command', { field: 'body' });
    const envelope = {
      uid: owner.uid,
      workspaceId: owner.workspaceId,
      shiftId: op.shiftId,
      protocolVersion: PROTOCOL_VERSION,
      operationId: op.id,
      commandType: op.type,
      body,
      expectedRevisions: envelopeRevisions(op),
      createdAt
    };
    let hash;
    try {
      hash = commandHash(envelope, owner);
    } catch (_) {
      return fail('invalid-command', { field: 'body' });
    }
    envelope.commandHash = hash;
    return { ok: true, envelope, commandHash: hash };
  }

  function validateCommand(command) {
    if (!isRecord(command)) return 'command';
    if (!isNonEmptyString(command.shiftId)) return 'shiftId';
    if (!isNonEmptyString(command.operationId)) return 'operationId';
    if (!isNonEmptyString(command.commandType)) return 'commandType';
    if (command.protocolVersion !== PROTOCOL_VERSION) return 'protocolVersion';
    if (!isRecord(command.body)) return 'body';
    if (command.expectedRevisions !== undefined && !isRecord(command.expectedRevisions)) return 'expectedRevisions';
    if (!Number.isFinite(Number(command.createdAt)) || Number(command.createdAt) <= 0) return 'createdAt';
    return null;
  }

  function createOfflineJournalV2(options) {
    const config = options || {};
    const uid = config.uid;
    const workspaceId = config.workspaceId;
    const storage = config.storage;
    if (!isNonEmptyString(uid)) throw new TypeError('offline-v2-requires-uid');
    if (!isNonEmptyString(workspaceId)) throw new TypeError('offline-v2-requires-workspace');
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      throw new TypeError('offline-v2-requires-storage');
    }

    const scope = { uid, workspaceId };
    const scopePrefix = KEY_PREFIX + 'v' + PROTOCOL_VERSION + ':' + encodeURIComponent(uid) + '/' + encodeURIComponent(workspaceId) + '/';
    const indexKey = scopePrefix + 'index';
    let sealed = false;

    function queueKey(shiftId) {
      return scopePrefix + encodeURIComponent(shiftId) + '/queue';
    }

    function readIndex() {
      try {
        const parsed = JSON.parse(storage.getItem(indexKey) || '[]');
        return Array.isArray(parsed) ? parsed.filter(isNonEmptyString) : [];
      } catch (_) {
        return [];
      }
    }

    function writeIndex(shiftIds) {
      const list = shiftIds.filter(isNonEmptyString);
      if (!list.length) {
        storage.removeItem(indexKey);
        return;
      }
      storage.setItem(indexKey, JSON.stringify(list));
    }

    function indexAdd(shiftId) {
      const list = readIndex();
      if (list.indexOf(shiftId) >= 0) return;
      list.push(shiftId);
      list.sort();
      writeIndex(list);
    }

    function indexRemove(shiftId) {
      writeIndex(readIndex().filter(item => item !== shiftId));
    }

    // Запись чужого scope не читается даже если ключ подсунули: сверяем uid и
    // workspaceId каждой строки, а не только имя ключа.
    function readRecords(shiftId) {
      if (!isNonEmptyString(shiftId)) return [];
      let parsed;
      try {
        parsed = JSON.parse(storage.getItem(queueKey(shiftId)) || '[]');
      } catch (_) {
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(row => isRecord(row)
        && row.uid === uid
        && row.workspaceId === workspaceId
        && row.shiftId === shiftId
        && row.protocolVersion === PROTOCOL_VERSION);
    }

    function writeRecords(shiftId, records) {
      if (!records.length) {
        storage.removeItem(queueKey(shiftId));
        indexRemove(shiftId);
        return;
      }
      storage.setItem(queueKey(shiftId), JSON.stringify(records));
      indexAdd(shiftId);
    }

    function shiftIds() {
      return readIndex().filter(shiftId => readRecords(shiftId).length > 0).sort();
    }

    function findRecord(operationId) {
      if (!isNonEmptyString(operationId)) return null;
      for (const shiftId of shiftIds()) {
        const records = readRecords(shiftId);
        const found = records.find(row => row.operationId === operationId);
        if (found) return { shiftId, records, record: found };
      }
      return null;
    }

    function enqueue(command) {
      if (sealed) return fail('journal-sealed');
      const problem = validateCommand(command);
      if (problem) return fail('invalid-command', { field: problem });
      if (isOnlineOnlyCommand(command.commandType)) {
        return fail('online-only-command', { commandType: command.commandType });
      }
      let hash;
      try {
        hash = commandHash(command, scope);
      } catch (_) {
        return fail('invalid-command', { field: 'body' });
      }
      const shiftId = command.shiftId;
      const records = readRecords(shiftId);
      const existing = records.find(row => row.operationId === command.operationId);
      if (existing) {
        // Тот же operationId с тем же конвертом — идемпотентный повтор;
        // с другим — конфликт, а не вторая запись в очередь.
        if (existing.commandHash === hash) return { ok: true, duplicate: true, record: copy(existing) };
        return fail('operation-hash-conflict', { operationId: command.operationId });
      }
      const record = {
        uid,
        workspaceId,
        shiftId,
        protocolVersion: PROTOCOL_VERSION,
        operationId: command.operationId,
        commandType: command.commandType,
        body: copy(command.body),
        expectedRevisions: copy(command.expectedRevisions) || {},
        createdAt: Number(command.createdAt),
        commandHash: hash,
        status: 'pending'
      };
      records.push(record);
      writeRecords(shiftId, records);
      return { ok: true, duplicate: false, record: copy(record) };
    }

    function readQueue(shiftId) {
      if (sealed) return [];
      return copy(readRecords(shiftId));
    }

    // Scoped-группы: очередь одной смены никогда не смешивается с другой и с
    // чужим uid/workspace.
    function readAll() {
      if (sealed) return [];
      return shiftIds().map(shiftId => ({ shiftId, commands: copy(readRecords(shiftId)) }));
    }

    function pendingCount(shiftId) {
      if (sealed) return 0;
      const count = records => records.filter(row => row.status === 'pending').length;
      if (isNonEmptyString(shiftId)) return count(readRecords(shiftId));
      return shiftIds().reduce((sum, id) => sum + count(readRecords(id)), 0);
    }

    function updateRecord(operationId, update) {
      // Результат уже отправленной команды записывается даже у запечатанного
      // журнала: сервер её применил, и потерять авторитетный receipt нельзя.
      // Запрет запечатывания касается отправки и показа, а не записи ответа.
      const found = findRecord(operationId);
      if (!found) return fail('operation-not-found', { operationId });
      const records = found.records.map(row => (row.operationId === operationId ? update(row) : row));
      writeRecords(found.shiftId, records);
      return { ok: true, shiftId: found.shiftId, record: copy(records.find(row => row.operationId === operationId)) };
    }

    function markSent(operationId, receipt) {
      return updateRecord(operationId, row => Object.assign({}, row, {
        status: 'sent',
        receipt: copy(receipt) || null,
        resolvedAt: Date.now()
      }));
    }

    function markRejected(operationId, code, details) {
      const verdict = classifyReplayFailure({ code, details, status: details && details.status });
      const result = updateRecord(operationId, row => Object.assign({}, row, {
        status: 'rejected',
        rejection: {
          code: verdict.code,
          permanent: verdict.permanent,
          conflict: verdict.conflict,
          details: verdict.details
        },
        deadLetter: verdict.deadLetter,
        resolvedAt: Date.now()
      }));
      if (!result.ok) return result;
      return Object.assign(result, {
        deadLetter: verdict.deadLetter,
        permanent: verdict.permanent,
        conflict: verdict.conflict,
        code: verdict.code
      });
    }

    function deadLetter(shiftId) {
      if (sealed) return [];
      const rows = isNonEmptyString(shiftId)
        ? readRecords(shiftId)
        : shiftIds().reduce((all, id) => all.concat(readRecords(id)), []);
      return copy(rows.filter(row => row.status === 'rejected' && row.deadLetter === true));
    }

    // Решение о replay: отправлять, вернуть сохранённый receipt или явно
    // отказать. Журнал ничего не подменяет и не создаёт второй запрос.
    function resolveReplay(operationId, hash) {
      if (sealed) return { action: 'sealed' };
      const found = findRecord(operationId);
      if (!found) return { action: 'not-found' };
      const row = found.record;
      if (isNonEmptyString(hash) && row.commandHash !== hash) {
        return { action: 'conflict', code: 'operation-hash-conflict', record: copy(row) };
      }
      if (row.status === 'sent') return { action: 'return-receipt', receipt: copy(row.receipt) };
      if (row.status === 'rejected') {
        return row.deadLetter === true
          ? { action: 'dead-letter', rejection: copy(row.rejection) }
          : { action: 'rejected', rejection: copy(row.rejection) };
      }
      return { action: 'send', command: copy(row) };
    }

    function seal() {
      sealed = true;
      return true;
    }

    function unseal() {
      sealed = false;
      return true;
    }

    function purge(shiftId) {
      if (!isNonEmptyString(shiftId)) return false;
      const existed = readRecords(shiftId).length > 0;
      writeRecords(shiftId, []);
      return existed;
    }

    function purgeAll() {
      const ids = shiftIds();
      ids.forEach(shiftId => writeRecords(shiftId, []));
      return ids.length;
    }

    return Object.freeze({
      enqueue,
      readQueue,
      readAll,
      pendingCount,
      markSent,
      markRejected,
      deadLetter,
      resolveReplay,
      commandHash: command => commandHash(command, scope),
      seal,
      unseal,
      sealed: () => sealed,
      purge,
      purgeAll,
      scope: () => ({ uid, workspaceId })
    });
  }

  const api = {
    PROTOCOL_VERSION,
    ONLINE_ONLY_COMMANDS,
    createOfflineJournalV2,
    buildCommandEnvelope,
    commandHash,
    canonicalJson,
    isOnlineOnlyCommand,
    classifyReplayFailure
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestOfflineV2 = api;
})(typeof window !== 'undefined' ? window : globalThis);
