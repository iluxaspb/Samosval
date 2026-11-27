// Управление сменой (44-shift-management.js) — контракт design §5.2, §5.3,
// §5.5, §6, §7.
//
// Модуль без DOM и без сети: транспорт — шпион, который записывает фактические
// аргументы каждого вызова. Каждая проверка сравнивает переданное тело команды
// и порядок фаз, а не «функция вернула ok».
//
// Запуск: node --test working-test/source/core/44-shift-management.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('./', import.meta.url));
const file = here + '44-shift-management.js';
const source = readFileSync(file, 'utf8');

const sandbox = { console, structuredClone };
const context = vm.createContext(sandbox);
vm.runInContext(source, context, { filename: file });
const managementApi = sandbox.WorkingTestShiftManagement || {};

const ALL_RIGHTS = {
  start_shift: true,
  close_shift: true,
  manage_shift_members: true,
  force_transfer_truck: true,
  edit_line: true
};

const shiftA = { shiftId: 'shift_a', state: 'active', objectId: 'object_1', objectName: 'Невский проспект', workDate: '2026-11-23', shiftType: 'day' };
const shiftB = { shiftId: 'shift_b', state: 'active', objectId: 'object_2', objectName: 'Пулково', workDate: '2026-11-23', shiftType: 'night' };

// Транспорт-шпион: любой вызванный метод попадает в calls вместе с копией
// аргументов. Прокси гарантирует, что неожиданный метод тоже будет замечен.
function spyTransport(handlers = {}) {
  const calls = [];
  const target = {};
  const transport = new Proxy(target, {
    get(object, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!(prop in object)) {
        object[prop] = async input => {
          calls.push({ name: prop, input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)) });
          const handler = handlers[prop];
          return handler ? handler(input, calls.length) : { ok: true, result: {} };
        };
      }
      return object[prop];
    }
  });
  return { calls, transport, names: () => calls.map(call => call.name) };
}

function makeStore({ rows = [shiftA, shiftB], contexts = {} } = {}) {
  return {
    visibleShifts: () => rows.map(row => ({ ...row })),
    context: shiftId => (contexts[shiftId] ? JSON.parse(JSON.stringify(contexts[shiftId])) : null)
  };
}

function setup({ rights = ALL_RIGHTS, rows, contexts, handlers, newOperationId } = {}) {
  const spy = spyTransport(handlers);
  let counter = 0;
  const management = managementApi.createShiftManagement({
    transport: spy.transport,
    store: makeStore({ rows, contexts }),
    rights,
    now: () => 1764000000000,
    newOperationId: newOperationId || (() => 'op_generated_' + (++counter))
  });
  return { ...spy, management };
}

function contextWith(shiftId, { shiftRevision = 7, members = [], logs = [] } = {}) {
  return {
    [shiftId]: {
      shiftId,
      revisions: { shift: shiftRevision },
      snapshot: { shiftId, members, logs, statuses: [] },
      badge: { pending: 0, closing: false, conflict: false }
    }
  };
}

test('модуль публикует полный контракт и не зависит от DOM', () => {
  assert.equal(typeof managementApi.createShiftManagement, 'function', 'глобальный контракт WorkingTestShiftManagement');
  const { management } = setup({});
  for (const name of ['canCreate', 'canManageMembers', 'canClose', 'canForceTransfer', 'createShift', 'addMember', 'removeMember', 'closeShift', 'describe']) {
    assert.equal(typeof management[name], 'function', name);
  }
});

test('без права команда не уходит на сервер: forbidden с именем права', async () => {
  const noStart = setup({ rights: { ...ALL_RIGHTS, start_shift: false } });
  const created = await noStart.management.createShift({ objectId: 'object_1', workDate: '2026-11-24', shiftType: 'day' });
  assert.equal(created.ok, false);
  assert.equal(created.code, 'forbidden');
  assert.equal(created.details.right, 'start_shift');
  assert.deepEqual(noStart.calls, [], 'createShift не дошёл до транспорта');

  const noMembers = setup({ rights: { ...ALL_RIGHTS, manage_shift_members: false }, contexts: contextWith('shift_a') });
  const added = await noMembers.management.addMember({ shiftId: 'shift_a', uid: 'uid_2' });
  assert.equal(added.code, 'forbidden');
  assert.equal(added.details.right, 'manage_shift_members');
  const removed = await noMembers.management.removeMember({ shiftId: 'shift_a', uid: 'uid_2' });
  assert.equal(removed.code, 'forbidden');
  assert.equal(removed.details.right, 'manage_shift_members');
  assert.deepEqual(noMembers.calls, []);

  const noClose = setup({ rights: { ...ALL_RIGHTS, close_shift: false }, contexts: contextWith('shift_a') });
  const closed = await noClose.management.closeShift({ shiftId: 'shift_a', materialId: 'sand', volume: 10 });
  assert.equal(closed.code, 'forbidden');
  assert.equal(closed.details.right, 'close_shift');
  assert.deepEqual(noClose.calls, []);

  assert.equal(setup({ rights: {} }).management.canCreate(), false);
  assert.equal(setup({ rights: { force_transfer_truck: true } }).management.canForceTransfer(), true);
});

test('создание смены: day/night, дата ГГГГ-ММ-ДД, объект и точный дубликат', async () => {
  const ok = setup({ rows: [shiftA] });
  const created = await ok.management.createShift({ operationId: 'op_create_1', objectId: 'object_2', workDate: '2026-11-24', shiftType: 'night', cycleMinutes: 30 });
  assert.equal(created.ok, true);
  assert.deepEqual(ok.calls.map(call => call.name), ['createShift']);
  assert.deepEqual(ok.calls[0].input, {
    operationId: 'op_create_1', objectId: 'object_2', workDate: '2026-11-24', shiftType: 'night', cycleMinutes: 30
  }, 'в команду ушло ровно §5.2-тело');

  const badType = setup({});
  const wrongType = await badType.management.createShift({ objectId: 'object_2', workDate: '2026-11-24', shiftType: 'morning' });
  assert.equal(wrongType.code, 'invalid-shift-type');
  assert.deepEqual(badType.calls, []);

  const badDate = setup({});
  for (const workDate of ['24.11.2026', '2026-13-01', '2026-11-31', '', '2026-1-4']) {
    const result = await badDate.management.createShift({ objectId: 'object_2', workDate, shiftType: 'day' });
    assert.equal(result.code, 'invalid-work-date', 'дата ' + JSON.stringify(workDate) + ' отклонена до запроса');
  }
  assert.deepEqual(badDate.calls, []);

  const noObject = setup({});
  const missingObject = await noObject.management.createShift({ objectId: '  ', workDate: '2026-11-24', shiftType: 'day' });
  assert.equal(missingObject.code, 'invalid-object-id');
  assert.deepEqual(noObject.calls, []);

  const duplicate = setup({ rows: [shiftA] });
  const same = await duplicate.management.createShift({ objectId: 'object_1', workDate: '2026-11-23', shiftType: 'day' });
  assert.equal(same.code, 'duplicate-shift', 'тот же объект+дата+тип среди видимых — дубликат');
  assert.deepEqual(duplicate.calls, []);

  const otherType = await duplicate.management.createShift({ objectId: 'object_1', workDate: '2026-11-23', shiftType: 'night' });
  assert.equal(otherType.ok, true, 'day и night одного объекта и даты не конфликтуют');

  const closedSameKey = setup({ rows: [{ ...shiftA, state: 'closed' }] });
  const afterClosed = await closedSameKey.management.createShift({ objectId: 'object_1', workDate: '2026-11-23', shiftType: 'day' });
  assert.equal(afterClosed.ok, true, 'закрытая смена того же ключа дубликатом не считается');
});

test('CAS берётся из фактического состояния контекста, undefined в тело не попадает', async () => {
  const contexts = contextWith('shift_a', { shiftRevision: 7, members: [{ uid: 'uid_2', revision: 3 }, { uid: 'uid_9', revision: 1 }] });
  const { management, calls } = setup({
    contexts,
    handlers: {
      prepareClose: () => ({ ok: true, replayed: false, result: { phase: 'prepared', closeToken: 'token_1', shiftRevision: 8, archiveId: 'closed_shift_a', archiveRevision: 1, materialMarkerRevision: null } }),
      finishClose: () => ({ ok: true, replayed: false, result: { phase: 'closed' } })
    }
  });
  const added = await management.addMember({ operationId: 'op_member_1', shiftId: 'shift_a', uid: 'uid_2' });
  assert.equal(added.ok, true);
  assert.deepEqual(calls[0].input, {
    operationId: 'op_member_1', shiftId: 'shift_a', uid: 'uid_2',
    expectedShiftRevision: 7, expectedMembershipRevision: 3
  }, 'ревизии взяты из снимка контекста');
  assert.equal(JSON.stringify(calls[0].input).includes('undefined'), false, 'в теле нет undefined');

  const addedNew = await management.addMember({ operationId: 'op_member_2', shiftId: 'shift_a', uid: 'uid_new' });
  assert.equal(addedNew.ok, true);
  assert.equal(calls[1].input.expectedMembershipRevision, null, 'новая строка участника — CAS «строки ещё нет»');

  const removed = await management.removeMember({ operationId: 'op_member_3', shiftId: 'shift_a', uid: 'uid_9' });
  assert.equal(removed.ok, true);
  assert.deepEqual(calls[2].input, {
    operationId: 'op_member_3', shiftId: 'shift_a', uid: 'uid_9',
    expectedShiftRevision: 7, expectedMembershipRevision: 1
  });

  const prepared = await management.closeShift({ operationId: 'op_close_1', shiftId: 'shift_a', materialId: 'sand', volume: 4 });
  assert.equal(prepared.ok, true);
  assert.equal(calls[3].name, 'prepareClose');
  assert.deepEqual(calls[3].input, { operationId: 'op_close_1-prepare', shiftId: 'shift_a', expectedShiftRevision: 7 });
});

test('без загруженного контекста ревизии неизвестны и команда не уходит', async () => {
  const { management, calls } = setup({ contexts: {} });
  for (const result of [
    await management.addMember({ shiftId: 'shift_a', uid: 'uid_2' }),
    await management.removeMember({ shiftId: 'shift_a', uid: 'uid_2' }),
    await management.closeShift({ shiftId: 'shift_a', materialId: 'sand', volume: 1 })
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'revision-unknown');
  }
  assert.deepEqual(calls, [], 'ни одна команда не ушла без ревизии');
});

test('конфликт ревизий не переигрывается молча и объясняется человеку', async () => {
  const contexts = contextWith('shift_a', { shiftRevision: 7, members: [{ uid: 'uid_2', revision: 3 }] });
  const { management, calls } = setup({
    contexts,
    handlers: {
      addMember: () => ({ ok: false, error: { code: 'revision-conflict', details: { expectedShiftRevision: 7, shiftRevision: 8 } } })
    }
  });
  const result = await management.addMember({ operationId: 'op_member_1', shiftId: 'shift_a', uid: 'uid_2' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'revision-conflict');
  assert.equal(result.details.shiftRevision, 8, 'безопасные детали сохранены');
  assert.equal(calls.length, 1, 'ровно один вызов транспорта, без автоматического повтора');
  const text = management.describe(result);
  assert.match(text, /изменил|обновите/i, 'describe объясняет причину: ' + text);
});

test('закрытие: три фазы по фактическим значениям receipt', async () => {
  const contexts = contextWith('shift_a', { shiftRevision: 7, logs: [{ id: 'log_1', shiftId: 'shift_a', volume: 99 }] });
  const { management, calls } = setup({
    contexts,
    handlers: {
      prepareClose: () => ({
        ok: true,
        replayed: false,
        result: { phase: 'prepared', closeToken: 'token_1', shiftRevision: 8, archiveId: 'closed_shift_a', archiveRevision: 1, materialMarkerRevision: null, totalTrips: 3, totalVolume: 12 }
      }),
      confirmMaterial: () => ({
        ok: true,
        replayed: false,
        result: { phase: 'material-confirmed', materialId: 'sand', volume: 12, archiveId: 'closed_shift_a', archiveRevision: 1, materialMarkerRevision: 1, shiftRevision: 8 }
      }),
      finishClose: () => ({ ok: true, replayed: false, result: { phase: 'closed' } })
    }
  });
  const result = await management.closeShift({ operationId: 'op_close_1', shiftId: 'shift_a', materialId: 'sand', volume: 12 });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => call.name), ['prepareClose', 'confirmMaterial', 'finishClose'], 'порядок фаз');
  assert.deepEqual(calls[0].input, { operationId: 'op_close_1-prepare', shiftId: 'shift_a', expectedShiftRevision: 7 });
  assert.deepEqual(calls[1].input, {
    operationId: 'op_close_1-material', shiftId: 'shift_a', closeToken: 'token_1', materialId: 'sand', volume: 12,
    expectedShiftRevision: 8, expectedArchiveRevision: 1, expectedMaterialMarkerRevision: null
  }, 'материал идёт с null-маркером и ожиданиями из receipt');
  assert.deepEqual(calls[2].input, {
    operationId: 'op_close_1-finish', shiftId: 'shift_a', closeToken: 'token_1',
    expectedShiftRevision: 8, expectedArchiveRevision: 1, expectedMaterialMarkerRevision: 1
  }, 'finish получает все три ожидания из receipt');
  assert.equal(result.phases.join(','), 'prepare,material,finish', 'все три фазы пройдены');
});

test('закрытие пустой смены пропускает материал и finish идёт с null-маркером', async () => {
  const contexts = contextWith('shift_a', { shiftRevision: 4, logs: [] });
  const { management, calls } = setup({
    contexts,
    handlers: {
      prepareClose: () => ({
        ok: true,
        replayed: false,
        result: { phase: 'prepared', closeToken: 'token_empty', shiftRevision: 5, archiveId: 'closed_shift_a', archiveRevision: 1, materialMarkerRevision: null }
      }),
      finishClose: () => ({ ok: true, replayed: false, result: { phase: 'closed' } })
    }
  });
  const result = await management.closeShift({ operationId: 'op_close_empty', shiftId: 'shift_a' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(call => call.name), ['prepareClose', 'finishClose'], 'фаза материала пропущена');
  assert.deepEqual(calls[1].input, {
    operationId: 'op_close_empty-finish', shiftId: 'shift_a', closeToken: 'token_empty',
    expectedShiftRevision: 5, expectedArchiveRevision: 1, expectedMaterialMarkerRevision: null
  });
});

test('рейсы из receipt требуют материал, иначе фаза не выдумывает значения', async () => {
  const contexts = contextWith('shift_a', { shiftRevision: 2, logs: [{ id: 'log_1', shiftId: 'shift_a', volume: 6 }] });
  const { management, calls } = setup({
    contexts,
    handlers: {
      prepareClose: () => ({
        ok: true,
        replayed: false,
        result: { phase: 'prepared', closeToken: 'token_1', shiftRevision: 3, archiveId: 'closed_shift_a', archiveRevision: 1, materialMarkerRevision: null }
      })
    }
  });
  const result = await management.closeShift({ operationId: 'op_close_1', shiftId: 'shift_a' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'material-required');
  assert.equal(result.details.totalTrips, 1, 'число рейсов из снимка сервера');
  assert.equal(result.details.totalVolume, 6);
  assert.deepEqual(calls.map(call => call.name), ['prepareClose'], 'finish без материала не вызывается');
  assert.match(management.describe(result), /материал/i);
});

test('ошибка фазы останавливает цепочку и объясняется человеку', async () => {
  for (const [code, expected] of [['pending-operations', /ожида|подтвержд/i], ['detached-trip-open', /незавершённый рейс/i]]) {
    const contexts = contextWith('shift_a', { shiftRevision: 4, logs: [{ id: 'log_1', shiftId: 'shift_a', volume: 3 }] });
    const { management, calls } = setup({
      contexts,
      handlers: { prepareClose: () => ({ ok: false, error: { code, details: {} } }) }
    });
    const result = await management.closeShift({ operationId: 'op_close_1', shiftId: 'shift_a', materialId: 'sand', volume: 3 });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.deepEqual(calls.map(call => call.name), ['prepareClose'], 'после ошибки prepare цепочка остановлена');
    const text = management.describe(result);
    assert.match(text, expected, 'describe объясняет причину: ' + text);
    if (code === 'detached-trip-open') assert.match(text, /другую смену/i, 'назван перевод рейса в другую смену');
  }
});

test('ошибка фазы материала тоже не доходит до finish', async () => {
  const contexts = contextWith('shift_a', { shiftRevision: 4, logs: [{ id: 'log_1', shiftId: 'shift_a', volume: 3 }] });
  const { management, calls } = setup({
    contexts,
    handlers: {
      prepareClose: () => ({ ok: true, replayed: false, result: { phase: 'prepared', closeToken: 'token_1', shiftRevision: 5, archiveId: 'closed_shift_a', archiveRevision: 1, materialMarkerRevision: null } }),
      confirmMaterial: () => ({ ok: false, error: { code: 'revision-conflict', details: { field: 'closeToken' } } })
    }
  });
  const result = await management.closeShift({ operationId: 'op_close_1', shiftId: 'shift_a', materialId: 'sand', volume: 3 });
  assert.equal(result.code, 'revision-conflict');
  assert.deepEqual(calls.map(call => call.name), ['prepareClose', 'confirmMaterial'], 'finish не вызван');
});

test('повтор closeShift с тем же operationId передаёт те же id операций', async () => {
  const contexts = contextWith('shift_a', { shiftRevision: 4, logs: [{ id: 'log_1', shiftId: 'shift_a', volume: 2 }] });
  const { management, calls } = setup({
    contexts,
    handlers: {
      prepareClose: () => ({ ok: true, replayed: false, result: { phase: 'prepared', closeToken: 'token_1', shiftRevision: 5, archiveId: 'closed_shift_a', archiveRevision: 1, materialMarkerRevision: null } }),
      confirmMaterial: () => ({ ok: true, replayed: false, result: { phase: 'material-confirmed', materialMarkerRevision: 1, shiftRevision: 5, archiveRevision: 1 } }),
      finishClose: () => ({ ok: true, replayed: false, result: { phase: 'closed' } })
    }
  });
  await management.closeShift({ operationId: 'op_close_same', shiftId: 'shift_a', materialId: 'sand', volume: 2 });
  const first = calls.map(call => call.input.operationId);
  await management.closeShift({ operationId: 'op_close_same', shiftId: 'shift_a', materialId: 'sand', volume: 2 });
  const second = calls.slice(3).map(call => call.input.operationId);
  assert.deepEqual(second, first, 'те же производные operationId: идемпотентность на сервере');
  assert.deepEqual(first, ['op_close_same-prepare', 'op_close_same-material', 'op_close_same-finish']);
});

test('describe покрывает стабильные коды v2 и не падает на неизвестном', () => {
  const { management } = setup({});
  const codes = ['shift-closed', 'not-shift-member', 'revision-conflict', 'pending-operations', 'detached-trip-open',
    'duplicate-shift', 'online-required', 'protocol-upgrade-required', 'forbidden', 'invalid-command'];
  for (const code of codes) {
    const text = management.describe({ code });
    assert.equal(typeof text, 'string', code);
    assert.ok(text.length > 8, 'человеческий текст для ' + code + ': ' + text);
    assert.notEqual(text, code, 'текст — не голый код: ' + code);
  }
  assert.match(management.describe('shift-closed'), /закрыт/i);
  assert.match(management.describe({ code: 'not-shift-member' }), /участник/i);
  assert.match(management.describe('online-required'), /сеть|онлайн/i);
  assert.match(management.describe('protocol-upgrade-required'), /обновите|версия/i);
  assert.match(management.describe('duplicate-shift'), /уже/i);
  assert.match(management.describe({ code: 'unknown-future-code' }), /не удалось|ошибк/i, 'неизвестный код даёт общий текст');
  assert.equal(management.describe(undefined), management.describe('unknown'), 'undefined не роняет describe');
  assert.equal(management.describe({}), management.describe('unknown'), 'пустой объект не роняет describe');
});
