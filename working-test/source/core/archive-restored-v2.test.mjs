// Восстановленная архивная смена через v2 (design §5.6, §10.1).
//
// Что здесь доказывается:
// 1) серверное представление контекста переводится в карточку и рейсы, а
//    битая/чужая форма не публикуется как «нормальная» смена;
// 2) правка/удаление рейса и ТТН собираются с CAS из ФАКТИЧЕСКИ прочитанного
//    контекста и с одним operationId на повтор (идемпотентность);
// 3) «Вернуть в архив» для v2 честно отказывает: маршрута финализации в
//    сервере канала нет, и клиент не закрывает смену окольным путём;
// 4) старый сервер/404/501/отсутствие моста дают прежний честный отказ и не
//    оставляют карточек и записей.
//
// Запуск: node --test working-test/source/core/archive-restored-v2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const read = p => readFileSync(join(here, p), 'utf8');
const moduleSrc = read('48-archive-restored-v2.js');
const nasSrc = read('21-nas-runtime.js');
const archiveSrc = read('10-archive.js');
const reportsSrc = read('09-reports.js');

// Модуль 48 — чистый контракт без DOM/сети: грузим как есть.
function loadModule() {
  const sandbox = { module: { exports: {} }, console };
  vm.runInNewContext(moduleSrc, sandbox, { filename: '48-archive-restored-v2.js' });
  return sandbox.module.exports;
}
const api = loadModule();

function extract(src, name) {
  // Точное имя до «(»: иначе nasV2Shifts совпадёт с nasV2ShiftsEnabled.
  const header = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const match = header.exec(src);
  assert.ok(match, 'нет функции ' + name);
  const start = match.index;
  let depth = 0, i = src.indexOf('{', start), end = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  return src.slice(start, end + 1);
}

const RUNTIME_FUNCTIONS = [
  'nasV2Shifts', 'nasStopV2Shifts', 'nasRestoredArchiveApi', 'nasRestoredArchiveTransport',
  'nasRestoredV2Ready', 'nasRestoredCards', 'nasRestoredShiftsCombined', 'nasRestoredContextForShift',
  'nasRestoredContextForLog', 'nasApplyRestoredShifts', 'nasSeedRestoredContexts',
  'nasReadRestoredContext', 'nasRefreshRestoredContexts', 'nasRestoredOperationId',
  'nasRestoredFieldText', 'nasRestoredCorrect', 'nasRestoredTripUpdate', 'nasRestoredTripDelete',
  'nasRestoredTtnChange', 'markRestoredTtn', 'nasRestoreArchivedShift', 'nasRestoredRefusalText',
  'nasRestoredFinalizeText'
];

// Мини-рантайм: те же функции, что в 21-nas-runtime.js, но мост подменён.
function runRuntime({ bridge, apiOverride } = {}) {
  const errors = [], toasts = [];
  let uuidCounter = 0;
  const sandbox = {
    console,
    crypto: { randomUUID: () => 'uuid-0000-1111-2222-' + String(++uuidCounter).padStart(4, '0') },
    state: { restoredShifts: [] },
    offlineRemoteLogs: [],
    offlineProjectState: () => {},
    saveCache: () => {},
    renderAll: () => {},
    showToastEl: (text) => toasts.push(text),
    showError: (text) => errors.push(text),
    WorkingTestArchiveRestoredV2: apiOverride === undefined ? api : apiOverride,
  };
  const script = [
    'let nasV2Bridge = __bridge;',
    'let nasRestoredV1 = [];',
    'let nasRestoredContexts = [];',
    'let nasRestoredRead = null;',
    'let nasRestoredReadAt = 0;',
    ...RUNTIME_FUNCTIONS.map(name => extract(nasSrc, name)),
    '({nasRestoredV2Ready,nasStopV2Shifts,nasRestoreArchivedShift,nasRestoredTripUpdate,',
    '  nasRestoredTripDelete,nasRestoredTtnChange,markRestoredTtn,nasRestoredFinalizeText,',
    '  nasRestoredRefusalText,nasRestoredShiftsCombined,nasRestoredContextForLog,nasApplyRestoredShifts,',
    '  nasReadRestoredContext})'
  ].join('\n');
  sandbox.__bridge = bridge || null;
  const runtime = vm.runInNewContext(script, sandbox, { filename: '21-nas-runtime.restored.js' });
  return { runtime, sandbox, errors, toasts };
}

const SHA = 'a'.repeat(64);

function makeView(overrides = {}) {
  return Object.assign({
    protocolVersion: 2,
    workspaceId: 'main_workspace',
    restoredContextId: 'ctx_1',
    archiveId: 'archive_1',
    sourceShiftId: 'shift_src',
    archiveRevision: 5,
    archiveSha256: SHA,
    baseArchiveRevision: 5,
    baseArchiveSha256: SHA,
    latestFinalizedRevision: 5,
    baseIsLatest: true,
    contextRevision: 3,
    contextState: 'open',
    mode: 'correction',
    shiftSnapshot: {
      objectId: 'object_1', objectName: 'Невский проспект',
      workDate: '2026-11-27T00:00:00.000Z',
      openedAt: 1700000000000, openedByUid: 'uid_a', openedByName: 'Иванов',
      shiftType: 'day'
    },
    trips: [{
      logId: 'log_1', truckId: 'truck_1', logRevision: 2,
      payload: { id: 'log_1', truckId: 'truck_1', volume: 12, timestamp: 1700000000000, timeStr: '10:00', comment: '', isGAI: false }
    }],
    ttn: [{ truckId: 'truck_1', ttnStatus: null, ttnRevision: 1 }],
    tripsPage: { limit: 200, nextCursor: null, hasMore: false },
    provenance: {
      originalOpenedByUid: 'uid_a', originalOpenedByName: 'Иванов',
      originalIdentityResolution: 'resolved', originalShiftType: 'day',
      originalShiftTypeResolution: 'resolved',
      restoredByUid: 'uid_b', restoredByName: 'Петров'
    }
  }, overrides);
}

// Фейковый сервер: держит контекст, проверяет CAS и повторяет форму ответа
// `applyRestoredCorrection` (result без второго уровня вложенности).
function fakeServer(view = makeView()) {
  const calls = [];
  let failNext = null;
  const transport = {
    async readRestoredArchive() {
      return { ok: true, data: JSON.parse(JSON.stringify(view)) };
    },
    async submitArchiveV2(input) {
      calls.push(JSON.parse(JSON.stringify(input)));
      if (failNext) {
        const error = failNext;
        failNext = null;
        if (error.bumpRevision) view.contextRevision = error.bumpRevision;
        return { ok: false, error: { code: error.code, status: error.status } };
      }
      if (input.expectedContextRevision !== view.contextRevision) {
        return { ok: false, error: { code: 'archive-changed', status: 409 } };
      }
      const result = {
        restoredContextId: view.restoredContextId,
        archiveId: view.archiveId,
        contextRevision: view.contextRevision + 1,
        type: input.type,
        recordId: input.recordId
      };
      if (input.type === 'trip.update') {
        const row = view.trips.find(t => t.logId === input.recordId);
        if (!row) return { ok: false, error: { code: 'restored-trip-not-found', status: 404 } };
        Object.assign(row.payload, {
          volume: input.fields.volume, timeStr: input.fields.timeStr, comment: input.fields.comment
        });
        row.logRevision += 1;
        result.log = JSON.parse(JSON.stringify(row.payload));
      } else if (input.type === 'trip.delete') {
        view.trips = view.trips.filter(t => t.logId !== input.recordId);
      } else if (input.type === 'ttn.update') {
        const row = view.ttn.find(t => t.truckId === input.recordId);
        if (row) row.ttnStatus = input.fields.ttnStatus;
        result.ttn = { truckId: input.recordId, ttnStatus: input.fields.ttnStatus };
      } else if (input.type === 'ttn.delete') {
        const row = view.ttn.find(t => t.truckId === input.recordId);
        if (row) row.ttnStatus = null;
        result.ttn = { truckId: input.recordId, ttnStatus: null };
      }
      view.contextRevision += 1;
      return { ok: true, data: { result } };
    }
  };
  return {
    view, calls, transport,
    failOnce(error) { failNext = error; }
  };
}

// ===== Часть 1: чистая форма контекста → карточка =====

test('карточка: серверный контекст превращается в восстановленную смену с рейсами', () => {
  const normalized = api.normalizeContext(makeView());
  assert.equal(normalized.ok, true);
  const card = api.cardOf(normalized.view);
  assert.equal(card.shift.id, 'ctx_1', 'id карточки — restoredContextId');
  assert.equal(card.shift.restored, true);
  assert.equal(card.shift.objectId, 'object_1');
  assert.equal(card.shift.startDate, '27.11.2026', 'дата из pg-date приходит ISO-мгновением');
  assert.equal(card.logs.length, 1);
  assert.equal(card.logs[0].id, 'log_1');
  assert.equal(card.logs[0].restoredContextId, 'ctx_1');
  assert.equal(card.logs[0].volume, 12);
  assert.equal(card.context.contextRevision, 3);
  assert.equal(card.context.baseArchiveRevision, 5);
  assert.equal(card.readOnly, false);
});

test('карточка: дата принимает ISO, ISO-мгновение и русский формат', () => {
  assert.equal(api.ruDate('2026-11-27'), '27.11.2026');
  assert.equal(api.ruDate('2026-11-27T00:00:00.000Z'), '27.11.2026');
  assert.equal(api.ruDate('27.11.2026'), '27.11.2026');
  assert.equal(api.ruDate(''), '');
  assert.equal(api.ruDate('не дата'), '');
});

// Регрессия стенда 393×852 (шаг 17): карточка показывала 26.11 вместо 27.11.
// Серверная дата смены — календарная, а не UTC-дата мгновения: полночь 27.11
// по Москве в UTC выглядит как 26.11T21:00Z.
test('дата: мгновение переводится в московскую дату смены, а не в UTC-дату', () => {
  assert.equal(api.isoDate('2026-11-26T21:00:00.000Z'), '2026-11-27', 'полночь по Москве — это 27.11, а не 26.11');
  assert.equal(api.ruDate('2026-11-26T21:00:00.000Z'), '27.11.2026');
  assert.equal(api.isoDate(new Date('2026-11-26T21:00:00.000Z')), '2026-11-27', 'Date-объект считается так же');
  assert.equal(api.isoDate('2026-11-27T00:00:00.000Z'), '2026-11-27', 'ровно полночь UTC — уже дата смены');
  assert.equal(api.isoDate(new Date('2026-11-27T00:00:00.000Z')), '2026-11-27');
  // Реальный момент (не полночь): дата берётся по Москве.
  assert.equal(api.isoDate('2026-11-26T22:30:00.000Z'), '2026-11-27');
  assert.equal(api.isoDate('2026-11-27T20:59:00.000Z'), '2026-11-27');
  assert.equal(api.isoDate('2026-11-27T21:00:00.000Z'), '2026-11-28', 'после 21:00 UTC в Москве уже следующий день');
  // ISO со смещением и без зоны.
  assert.equal(api.isoDate('2026-11-27T00:00:00+03:00'), '2026-11-27');
  assert.equal(api.isoDate('2026-11-27T00:00'), '2026-11-27', 'ISO без зоны — календарная дата уже дана');
  assert.equal(api.isoDate('2026-11-27 00:00:00'), '2026-11-27');
});

test('карточка: дата смены из серверного мгновения показывает верный день', () => {
  const card = api.cardOf(api.normalizeContext(makeView({ shiftSnapshot: Object.assign({}, makeView().shiftSnapshot, { workDate: '2026-11-26T21:00:00.000Z' }) })).view);
  assert.equal(card.shift.startDate, '27.11.2026', 'карточка не сдвигается на день назад');
  assert.equal(card.shift.date, '27.11.2026');
});

// Часовой пояс машины не должен влиять: разбор идёт через явную зону
// Europe/Moscow, а не через локальную. Проверяем в отдельных процессах.
test('дата: результат не зависит от часового пояса машины', () => {
  const script = 'const api=require(' + JSON.stringify(join(here, '48-archive-restored-v2.js')) + ');'
    + 'process.stdout.write([api.ruDate("2026-11-26T21:00:00.000Z"),api.ruDate("2026-11-27T00:00:00.000Z"),api.ruDate(new Date("2026-11-26T21:00:00.000Z"))].join("|"));';
  const outputs = ['UTC', 'America/New_York', 'Asia/Tokyo', 'Europe/Moscow'].map(TZ =>
    execFileSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { TZ }), encoding: 'utf8' }));
  for (const output of outputs) {
    assert.equal(output, '27.11.2026|27.11.2026|27.11.2026', 'часовой пояс машины не меняет дату смены');
  }
});

test('карточка: опубликованный контекст помечается readOnly', () => {
  const card = api.cardOf(api.normalizeContext(makeView({ contextState: 'finalized' })).view);
  assert.equal(card.readOnly, true);
});

test('форма: битый/чужой контекст не публикуется', () => {
  const broken = [
    null,
    {},
    makeView({ restoredContextId: '' }),
    makeView({ contextRevision: 0 }),
    makeView({ baseArchiveSha256: 'not-a-sha' }),
    makeView({ shiftSnapshot: {} }),
    makeView({ trips: 'nope' }),
    makeView({ ttn: 'nope' })
  ];
  for (const view of broken) {
    const result = api.normalizeContext(view);
    assert.equal(result.ok, false, 'битая форма отклонена: ' + JSON.stringify(view));
    assert.equal(result.code, 'invalid-api-response');
  }
});

// ===== Часть 2: команды правки с CAS из фактического контекста =====

test('команда: CAS берётся из контекста, поля правки — на верхнем уровне', () => {
  const card = api.cardOf(api.normalizeContext(makeView()).view);
  const built = api.commandFor(card, {
    type: 'trip.update', operationId: 'op_1', recordId: 'log_1',
    fields: { volume: 20, timeStr: '12:30', comment: 'перегруз' }
  });
  assert.equal(built.ok, true);
  const input = built.input;
  assert.equal(input.archiveId, 'archive_1');
  assert.equal(input.restoredContextId, 'ctx_1');
  assert.equal(input.expectedContextRevision, 3);
  assert.equal(input.expectedBaseArchiveRevision, 5);
  assert.equal(input.expectedBaseSha256, SHA);
  assert.deepEqual(JSON.parse(JSON.stringify(input.fields)), { volume: 20, timeStr: '12:30', comment: 'перегруз' });
});

test('команда: некорректные поля отклоняются до сети', () => {
  const card = api.cardOf(api.normalizeContext(makeView()).view);
  const cases = [
    [{ type: 'trip.update', operationId: 'op', recordId: 'log_1', fields: { volume: -1, timeStr: '10:00' } }, 'invalid-volume'],
    [{ type: 'trip.update', operationId: 'op', recordId: 'log_1', fields: { volume: 10, timeStr: '25:99' } }, 'invalid-time'],
    [{ type: 'ttn.update', operationId: 'op', recordId: 'truck_1', fields: { ttnStatus: 'нет' } }, 'invalid-ttn'],
    [{ type: 'shift.close', operationId: 'op', recordId: 'log_1' }, 'archive-operation-not-allowed'],
    [{ type: 'trip.delete', operationId: '', recordId: 'log_1' }, 'operation-id-required']
  ];
  for (const [command, code] of cases) {
    const built = api.commandFor(card, command);
    assert.equal(built.ok, false, 'отклонено: ' + JSON.stringify(command));
    assert.equal(built.code, code);
  }
});

test('команда: удаление рейса и ТТН не принимают полей правки', () => {
  const card = api.cardOf(api.normalizeContext(makeView()).view);
  const del = api.commandFor(card, { type: 'trip.delete', operationId: 'op', recordId: 'log_1' });
  assert.equal(del.ok, true);
  assert.equal(del.input.fields, undefined, 'у удаления нет fields');
});

// ===== Часть 3: применение ответа операции =====

test('результат: правка рейса обновляет поля и ревизию контекста', () => {
  const card = api.cardOf(api.normalizeContext(makeView()).view);
  const next = api.applyResult(card, {
    type: 'trip.update', recordId: 'log_1', contextRevision: 4,
    log: { id: 'log_1', truckId: 'truck_1', volume: 30, timeStr: '15:00', timestamp: 1700003600000, comment: 'ok', isGAI: false }
  });
  assert.equal(next.context.contextRevision, 4);
  assert.equal(next.logs[0].volume, 30);
  assert.equal(next.logs[0].timeStr, '15:00');
  assert.equal(next.logs[0].logRevision, 3, 'локальная ревизия рейса выросла');
});

test('результат: удаление рейса убирает его из карточки', () => {
  const card = api.cardOf(api.normalizeContext(makeView()).view);
  const next = api.applyResult(card, { type: 'trip.delete', recordId: 'log_1', contextRevision: 4 });
  assert.equal(next.logs.length, 0);
});

test('результат: отметка ТТН обновляется, снятие — в null', () => {
  const card = api.cardOf(api.normalizeContext(makeView()).view);
  const marked = api.applyResult(card, { type: 'ttn.update', recordId: 'truck_1', contextRevision: 4, ttn: { truckId: 'truck_1', ttnStatus: true } });
  assert.equal(marked.ttn[0].ttnStatus, true);
  const cleared = api.applyResult(marked, { type: 'ttn.delete', recordId: 'truck_1', contextRevision: 5, ttn: { truckId: 'truck_1', ttnStatus: null } });
  assert.equal(cleared.ttn[0].ttnStatus, null);
});

// ===== Часть 4: тексты отказов =====

test('отказы: старый сервер/404/501 дают прежний честный отказ', () => {
  for (const [code, status] of [['api-http-404', 404], ['api-http-501', 501], ['route-not-found', 404], ['v2-transport-failure', 0], ['archive-restore-requires-v2', 409]]) {
    const refusal = api.refusalFor(code, status);
    assert.equal(refusal.compat, true, 'совместимость: ' + code);
    assert.equal(refusal.text, api.COMPAT_REFUSAL);
    assert.match(refusal.text, /смена не создана, данные архива не изменены/);
  }
});

test('отказы: доменная причина восстановления показывается как есть', () => {
  const refusal = api.refusalFor('archive-truck-not-available', 409);
  assert.equal(refusal.compat, false);
  assert.match(refusal.text, /нет в справочнике техники/);
});

test('отказы: правка на старом сервере объясняет недоступность', () => {
  assert.match(api.correctionText('api-http-404', 404), /Сервер не поддерживает правку восстановленной смены/);
  assert.match(api.correctionText('archive-changed', 409), /изменилась в другом окне/);
});

test('финализация: v2 честно отказывает, опубликованная смена — отдельный текст', () => {
  const card = api.cardOf(api.normalizeContext(makeView()).view);
  assert.equal(api.finalizeText(card), api.FINALIZE_UNAVAILABLE);
  assert.match(api.finalizeText(card), /в архив она не вернулась/);
  const finalized = api.cardOf(api.normalizeContext(makeView({ contextState: 'finalized' })).view);
  assert.equal(api.finalizeText(finalized), api.FINALIZED_NOTICE);
});

// ===== Часть 5: интеграция с рантаймом (мост подменён) =====

test('рантайм: без моста v2-путь выключен (прежний честный отказ)', () => {
  const { runtime } = runRuntime({ bridge: null });
  assert.equal(runtime.nasRestoredV2Ready(), false, 'нет моста — нет v2');
});

test('рантайм: восстановление открывает контекст и публикует карточку', async () => {
  const server = fakeServer();
  const { runtime, sandbox } = runRuntime({ bridge: { transport: server.transport } });
  assert.equal(runtime.nasRestoredV2Ready(), true);
  const result = await runtime.nasRestoreArchivedShift('archive_1');
  assert.equal(result.ok, true);
  assert.equal(result.card.shift.id, 'ctx_1');
  assert.equal(sandbox.state.restoredShifts.length, 1, 'карточка попала в state');
  assert.equal(sandbox.state.restoredShifts[0].logs[0].id, 'log_1');
  assert.ok(sandbox.offlineRemoteLogs.some(l => l.id === 'log_1'), 'рейсы попали в офлайн-проекцию');
});

test('рантайм: восстановление старого сервера даёт честный отказ без карточки', async () => {
  const transport = {
    async readRestoredArchive() { return { ok: false, error: { code: 'api-http-404', status: 404 } }; },
    async submitArchiveV2() { throw new Error('не должно вызываться'); }
  };
  const { runtime, sandbox, errors } = runRuntime({ bridge: { transport } });
  await assert.rejects(() => runtime.nasRestoreArchivedShift('archive_1'), /Восстановление архивной смены в этом режиме недоступно/);
  assert.equal(sandbox.state.restoredShifts.length, 0, 'карточка не создана');
  assert.equal(errors.length, 0);
});

test('рантайм: правка рейса идёт через submitArchiveV2 с CAS контекста', async () => {
  const server = fakeServer();
  const { runtime, sandbox } = runRuntime({ bridge: { transport: server.transport } });
  await runtime.nasRestoreArchivedShift('archive_1');
  const found = runtime.nasRestoredContextForLog('log_1');
  assert.ok(found, 'рейс найден в контексте');
  const result = await runtime.nasRestoredTripUpdate(found, { volume: 25, timeStr: '14:15', comment: 'правка' });
  assert.equal(result.type, 'trip.update');
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].type, 'trip.update');
  assert.equal(server.calls[0].expectedContextRevision, 3, 'CAS из прочитанного контекста');
  assert.equal(sandbox.state.restoredShifts[0].logs[0].volume, 25, 'карточка обновлена');
  assert.equal(sandbox.state.restoredShifts[0].context.contextRevision, 4, 'ревизия контекста выросла');
});

test('рантайм: CAS-конфликт перечитывает контекст и повторяет с тем же operationId', async () => {
  const server = fakeServer();
  server.failOnce({ code: 'archive-changed', status: 409, bumpRevision: 4 });
  const { runtime, sandbox } = runRuntime({ bridge: { transport: server.transport } });
  await runtime.nasRestoreArchivedShift('archive_1');
  const found = runtime.nasRestoredContextForLog('log_1');
  const result = await runtime.nasRestoredTripUpdate(found, { volume: 18, timeStr: '09:45', comment: '' });
  assert.equal(result.type, 'trip.update');
  assert.equal(server.calls.length, 2, 'был повтор после перечитывания');
  assert.equal(server.calls[0].operationId, server.calls[1].operationId, 'operationId не меняется при повторе');
  assert.equal(server.calls[1].expectedContextRevision, 4, 'повтор идёт по свежей ревизии');
  assert.equal(sandbox.state.restoredShifts[0].logs[0].volume, 18);
});

test('рантайм: удаление рейса убирает его из карточки', async () => {
  const server = fakeServer();
  const { runtime, sandbox } = runRuntime({ bridge: { transport: server.transport } });
  await runtime.nasRestoreArchivedShift('archive_1');
  const found = runtime.nasRestoredContextForLog('log_1');
  await runtime.nasRestoredTripDelete(found);
  assert.equal(server.calls[0].type, 'trip.delete');
  assert.equal(sandbox.state.restoredShifts[0].logs.length, 0);
});

test('рантайм: отметка ТТН архивного рейса идёт v2-операцией', async () => {
  const server = fakeServer();
  const { runtime, sandbox } = runRuntime({ bridge: { transport: server.transport } });
  await runtime.nasRestoreArchivedShift('archive_1');
  await runtime.nasRestoredTtnChange('ctx_1', 'truck_1', true);
  assert.equal(server.calls[0].type, 'ttn.update');
  assert.deepEqual(server.calls[0].fields, { ttnStatus: true });
  assert.equal(sandbox.state.restoredShifts[0].ttn[0].ttnStatus, true);
});

test('рантайм: «Вернуть в архив» для v2 отказывает и не зовёт закрытие', () => {
  const { runtime } = runRuntime({ bridge: { transport: fakeServer().transport } });
  assert.equal(runtime.nasRestoredFinalizeText('ctx_1'), null, 'неизвестный контекст — не v2-путь');
});

test('рантайм: после открытия контекста финализация объясняет недоступность', async () => {
  const server = fakeServer();
  const { runtime } = runRuntime({ bridge: { transport: server.transport } });
  await runtime.nasRestoreArchivedShift('archive_1');
  assert.equal(runtime.nasRestoredFinalizeText('ctx_1'), api.FINALIZE_UNAVAILABLE);
});

test('рантайм: сбой правки переводится в понятный текст, а не в сырой код', async () => {
  const server = fakeServer();
  const { runtime } = runRuntime({ bridge: { transport: server.transport } });
  await runtime.nasRestoreArchivedShift('archive_1');
  const found = runtime.nasRestoredContextForLog('log_1');
  server.failOnce({ code: 'forbidden', status: 403 });
  // forbidden не перечитывается: повтор не делается, ошибка показывается как есть.
  await assert.rejects(() => runtime.nasRestoredTripUpdate(found, { volume: 5, timeStr: '08:00', comment: '' }),
    /Недостаточно прав для правки восстановленной смены/);
});

test('рантайм: повтор операции идемпотентен — второй клик не создаёт второй operationId', async () => {
  const server = fakeServer();
  const { runtime } = runRuntime({ bridge: { transport: server.transport } });
  await runtime.nasRestoreArchivedShift('archive_1');
  const found = runtime.nasRestoredContextForLog('log_1');
  await runtime.nasRestoredTripUpdate(found, { volume: 11, timeStr: '07:30', comment: '' });
  const found2 = runtime.nasRestoredContextForLog('log_1');
  await runtime.nasRestoredTripUpdate(found2, { volume: 12, timeStr: '07:45', comment: '' });
  assert.equal(server.calls.length, 2);
  assert.notEqual(server.calls[0].operationId, server.calls[1].operationId, 'разные действия — разные operationId');
});

// ===== Часть 6: проводка в UI и отсутствие записи в активные таблицы =====

test('исходник: кнопка «Восстановить» выбирает v2-путь при живом мосте', () => {
  const body = extract(archiveSrc, 'restoreArchiveToShift');
  assert.match(body, /nasRestoredV2Ready\(\)/, 'ветка зависит от живого моста');
  assert.match(body, /nasRestoreArchivedShift\(viewingArchiveId\)/, 'вызывает v2-восстановление');
  assert.match(body, /archive-restore-requires-v2/, 'прежний честный отказ сохранён для старого сервера');
});

test('исходник: «Вернуть в архив» сначала спрашивает v2-текст', () => {
  const body = extract(reportsSrc, 'closeRestoredShift');
  const finalizeAt = body.indexOf('nasRestoredFinalizeText');
  const closeAt = body.indexOf('nasCloseCurrentShift');
  assert.ok(finalizeAt >= 0, 'проверяется v2-отказ');
  assert.ok(closeAt > finalizeAt, 'закрытие v1 вызывается только после проверки v2');
  assert.match(body, /showError\(text\);return;/, 'отказ показывается и завершает обработчик');
});

test('исходник: правка/удаление restored-рейса идут v2-путём, а не report.*', () => {
  const body = extract(nasSrc, 'nasReportAction');
  assert.match(body, /nasRestoredContextForLog\(log\?\.id\)/, 'restored-рейс распознаётся по id');
  assert.match(body, /nasRestoredTripUpdate\(restored,data\)/, 'правка уходит в v2');
  assert.match(body, /nasRestoredTripDelete\(restored\)/, 'удаление уходит в v2');
});

test('исходник: v2-путь не пишет в активные смены (нет nasBusinessCommand/archive.restore)', () => {
  const module = moduleSrc;
  assert.doesNotMatch(module, /nasBusinessCommand|nasArchiveAction|line_logs|line_truck_statuses/,
    'модуль контракта не знает про активную линию');
  const restore = extract(nasSrc, 'nasRestoreArchivedShift');
  assert.doesNotMatch(restore, /nasBusinessCommand|nasArchiveAction/, 'восстановление не идёт через legacy-команды');
  const correct = extract(nasSrc, 'nasRestoredCorrect');
  assert.doesNotMatch(correct, /nasBusinessCommand|nasArchiveAction/, 'правка не идёт через legacy-команды');
  assert.match(correct, /transport\.submitArchiveV2/, 'правка идёт v2-транспортом');
});
