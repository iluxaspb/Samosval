// Рейсы, оставшиеся в прежней смене (46-detached-trips.js).
//
// Контракт design §10.2 (крупная подпись исходной смены и предупреждение
// «Действие будет записано в исходную смену»), §3.3/§7 (detached-завершение —
// online-only cross-shift команда, без офлайн-очереди).
//
// Проверяем фактический classic script: файл грузится в vm без DOM и сети,
// транспорт — шпион, который считает вызовы.
//
// Запуск: node --test working-test/source/core/46-detached-trips.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('./', import.meta.url));
const file = here + '46-detached-trips.js';
const source = readFileSync(file, 'utf8');
const sandbox = { console, structuredClone };
const context = vm.createContext(sandbox);
vm.runInContext(source, context, { filename: file });
const api = sandbox.WorkingTestDetachedTrips || {};

function openTrip(overrides = {}) {
  return {
    sourceShiftId: 'shift_a',
    destinationShiftId: 'shift_b',
    cycleId: 'cycle_1',
    truckId: 'truck_1',
    type: 'load',
    stage: 'load',
    sourceObjectName: 'Невский проспект',
    sourceWorkDate: '23.11.2026',
    sourceShiftType: 'night',
    expectedSourceShiftRevision: 7,
    expectedDestinationShiftRevision: 9,
    expectedDetachedCycleRevision: 4,
    status: 'open',
    ...overrides
  };
}

function spyTransport(result = { ok: true, operationId: 'op_1' }) {
  const calls = [];
  return {
    calls,
    completeDetachedTrip: async input => {
      calls.push({ method: 'completeDetachedTrip', input });
      return result;
    }
  };
}

function spyQueue() {
  const calls = [];
  return {
    calls,
    enqueue: (...args) => calls.push({ method: 'enqueue', args }),
    push: (...args) => calls.push({ method: 'push', args })
  };
}

test('модуль публикует createDetachedTrips и не требует DOM', () => {
  assert.equal(typeof api.createDetachedTrips, 'function', 'глобальный контракт WorkingTestDetachedTrips');
  const instance = api.createDetachedTrips({ online: true });
  for (const name of ['list', 'describe', 'complete']) {
    assert.equal(typeof instance[name], 'function', name);
  }
  assert.doesNotMatch(source, /\bdocument\./, 'в модуле нет DOM');
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest/, 'в модуле нет сети');
});

test('в список попадают только свои открытые рейсы — source или destination', () => {
  const store = {
    detachedTripsFor: () => [
      openTrip({ sourceShiftId: 'shift_a', destinationShiftId: 'shift_b', cycleId: 'own_source' }),
      openTrip({ sourceShiftId: 'shift_x', destinationShiftId: 'shift_a', cycleId: 'own_destination' }),
      openTrip({ sourceShiftId: 'shift_x', destinationShiftId: 'shift_y', cycleId: 'foreign' })
    ]
  };
  const rows = api.createDetachedTrips({ online: true }).list(store, 'shift_a');
  assert.deepEqual(rows.map(row => row.cycleId).sort(), ['own_destination', 'own_source'], 'чужая запись не отдана');
});

test('завершённые рейсы в список не попадают', () => {
  const store = {
    detachedTripsFor: () => [
      openTrip({ cycleId: 'open_one' }),
      openTrip({ cycleId: 'completed_flag', completed: true }),
      openTrip({ cycleId: 'completed_status', status: 'completed' }),
      openTrip({ cycleId: 'completed_state', state: 'completed' })
    ]
  };
  const rows = api.createDetachedTrips({ online: true }).list(store, 'shift_a');
  assert.deepEqual(rows.map(row => row.cycleId), ['open_one']);
});

test('подпись крупно и точно повторяет исходную смену, дату, день/ночь и стадию', () => {
  const described = api.createDetachedTrips({ online: true }).describe(openTrip());
  assert.match(described.sourceLabel, /Невский проспект/, 'объект исходной смены');
  assert.match(described.sourceLabel, /23\.11\.2026/, 'дата исходной смены');
  assert.match(described.sourceLabel, /Ночь/, 'день/ночь исходной смены');
  assert.match(described.sourceLabel, /Погрузка/, 'стадия незавершённого цикла');
  assert.ok(described.warning.includes('Действие будет записано в исходную смену'), 'точное предупреждение');
  assert.equal(described.onlineOnly, true, 'завершение только online');
  assert.equal(described.canComplete, true, 'online и ревизия известны');
});

test('вложенная запись снимка тоже даёт полную подпись исходной смены', () => {
  // Сервер отдаёт смену объектом `sourceShift`, а не плоскими полями. Без
  // чтения вложенной формы подпись всегда была «Объект не указан».
  const nested = openTrip({
    sourceObjectName: undefined, sourceWorkDate: undefined, sourceShiftType: undefined,
    sourceShift: {
      shiftId: 'shift_a', objectId: 'object_1', objectName: 'Невский проспект',
      workDate: '2026-11-23', shiftType: 'day'
    },
    destinationShift: { shiftId: 'shift_b', shiftType: 'night' }
  });
  const described = api.createDetachedTrips({ online: true }).describe(nested);
  assert.equal(described.sourceLabel, 'Невский проспект · 2026-11-23 · День · Погрузка');
});

test('офлайн — read-only с причиной и без вызова транспорта', async () => {
  const transport = spyTransport();
  const queue = spyQueue();
  const instance = api.createDetachedTrips({ online: false, transport, queue });
  const described = instance.describe(openTrip());
  assert.equal(described.canComplete, false, 'офлайн-завершение запрещено');
  const result = await instance.complete({ operationId: 'op_1', trip: openTrip() });
  assert.equal(result.ok, false, 'офлайн-завершение запрещено');
  assert.equal(result.code, 'online-required', 'причина — online-required');
  assert.equal(transport.calls.length, 0, 'транспорт не вызван');
  assert.equal(queue.calls.length, 0, 'в очередь ничего не записано');
});

test('online-команда уходит ровно в транспорт с ревизиями записи и без очереди', async () => {
  const transport = spyTransport();
  const queue = spyQueue();
  const instance = api.createDetachedTrips({ online: true, transport, queue });
  const trip = openTrip();
  const result = await instance.complete({ operationId: 'op_1', trip });
  assert.equal(result.ok, true);
  assert.equal(transport.calls.length, 1, 'ровно один вызов транспорта');
  const call = transport.calls[0];
  assert.equal(call.method, 'completeDetachedTrip', 'вызван именно completeDetachedTrip');
  assert.equal(call.input.operationId, 'op_1');
  assert.equal(call.input.truckId, 'truck_1');
  assert.equal(call.input.destinationShiftId, 'shift_b');
  assert.equal(call.input.expectedSourceShiftRevision, 7);
  assert.equal(call.input.expectedDestinationShiftRevision, 9);
  assert.equal(call.input.expectedDetachedCycleRevision, 4);
  assert.equal(queue.calls.length, 0, 'офлайн-очередь не тронута');
  // v2-команда завершения требует createdAt: без него сервер отвечает
  // invalid-command/createdAt и рейс не закрывается никогда.
  assert.ok(Number.isSafeInteger(call.input.fields.createdAt), 'createdAt уходит в команду');
});

test('экран может передать свой момент подтверждения', async () => {
  const transport = spyTransport();
  const instance = api.createDetachedTrips({ online: true, transport });
  await instance.complete({ operationId: 'op_1', trip: openTrip(), createdAt: 1764000000000 });
  assert.equal(transport.calls[0].input.fields.createdAt, 1764000000000, 'переданное время не подменяется');
});

test('без ревизии detached-цикла команда не отправляется', async () => {
  const transport = spyTransport();
  const queue = spyQueue();
  const instance = api.createDetachedTrips({ online: true, transport, queue });
  const trip = openTrip({ expectedDetachedCycleRevision: undefined });
  const described = instance.describe(trip);
  assert.equal(described.canComplete, false, 'без ревизии цикла завершение недоступно');
  const result = await instance.complete({ operationId: 'op_1', trip });
  assert.equal(result.ok, false, 'команда не отправлена');
  assert.equal(result.code, 'revision-unknown', 'причина — неизвестная ревизия цикла');
  assert.equal(transport.calls.length, 0, 'запрос не ушёл');
  assert.equal(queue.calls.length, 0, 'в очередь ничего не записано');
});

test('без ревизии одной из смен команда не отправляется и null в тело не уходит', async () => {
  for (const field of ['expectedSourceShiftRevision', 'expectedDestinationShiftRevision']) {
    const transport = spyTransport();
    const instance = api.createDetachedTrips({ online: true, transport });
    const trip = openTrip({ [field]: undefined });
    assert.equal(instance.describe(trip).canComplete, false, 'без ревизии смены завершение недоступно');
    const result = await instance.complete({ operationId: 'op_1', trip });
    assert.equal(result.ok, false, 'команда не отправлена');
    assert.equal(result.code, 'revision-unknown');
    assert.equal(result.details.field, field === 'expectedSourceShiftRevision' ? 'source' : 'destination');
    assert.equal(transport.calls.length, 0, 'тело с null вместо ревизии не отправлено');
  }
});

test('завершённый рейс повторно не командуется', async () => {
  const transport = spyTransport();
  const instance = api.createDetachedTrips({ online: true, transport });
  const result = await instance.complete({ operationId: 'op_1', trip: openTrip({ status: 'completed' }) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'trip-completed');
  assert.equal(transport.calls.length, 0);
});

test('online-состояние пересчитывается на каждый вызов, а не фиксируется при создании', async () => {
  const transport = spyTransport();
  let online = false;
  const instance = api.createDetachedTrips({ online: () => online, transport });
  assert.equal(instance.describe(openTrip()).canComplete, false);
  online = true;
  assert.equal(instance.describe(openTrip()).canComplete, true);
  const result = await instance.complete({ operationId: 'op_1', trip: openTrip() });
  assert.equal(result.ok, true);
  assert.equal(transport.calls.length, 1);
});
