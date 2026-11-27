// Тест отрисовки восстановленных смен и честного отказа восстановления
// (решение владельца 23.11.2026, уточнение по канонической схеме 025).
//
// Важно про границы проверки: на канонической схеме (миграция 025) старый путь
// восстановления запрещён дизайном — restored archive не становится active
// shift (design §4.7, §3.4), его место `restored_shift_contexts`, у которого
// пока нет маршрута. Поэтому восстановление через `archive.restore` обязано
// получить стабильный отказ `archive-restore-requires-v2` и не оставить строк.
// Блок `renderRestoredShifts` ниже — проверка ОТРИСОВКИ карточки на данных,
// поданных напрямую, а не доказательство работающего восстановления.
// Запуск: node --test working-test/source/core/archive-parallel-restore.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const read = p => readFileSync(join(here, p), 'utf8');
const archiveSrc = read('10-archive.js');
const reportsSrc = read('09-reports.js');
const nasSrc = read('21-nas-runtime.js');
const clientSrc = read('../../synology/session-client.mjs');

function functionBody(src, name) {
  const start = src.indexOf('function ' + name);
  assert.ok(start >= 0, 'нет функции ' + name);
  let depth = 0, i = src.indexOf('{', start), end = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  return src.slice(start, end + 1);
}

// === Часть 1: сообщения восстановления и честный отказ канонической схемы ===
test('исходник: в nas-ветке восстановления нет требования закрыть активную смену', () => {
  const body = functionBody(archiveSrc, 'restoreArchiveToShift');
  assert.ok(!body.includes('Сначала закройте текущую смену и подтвердите перенос'),
    'блокирующее сообщение удалено');
  // Подтверждение при активной смене объясняет параллельность.
  assert.match(body, /продолжит работать/, 'текст подтверждения упоминает активную смену');
  assert.match(body, /параллельно/, 'подтверждение говорит о параллельных правках');
});

test('исходник: успех восстановления объясняет параллельный режим', () => {
  const body = functionBody(archiveSrc, 'restoreArchiveToShift');
  assert.match(body, /восстановлена для правок — параллельно с активной/,
    'тост сообщает о параллельных правках');
});

test('исходник: отказ archive-restore-requires-v2 переводится в понятный русский текст', () => {
  const body = functionBody(archiveSrc, 'restoreArchiveToShift');
  assert.match(body, /serverCode\s*\|\|\s*error\.code/, 'код сервера читается из serverCode');
  assert.match(body, /archive-restore-requires-v2/, 'отказ канонической схемы распознан отдельно');
  assert.match(body, /Восстановление архивной смены в этом режиме недоступно/, 'есть понятное объяснение');
});

test('поведение: отказ восстановления показывает объяснение, а не сырой HTTP-код', async () => {
  const errors = [];
  const context = {
    console: { error() {} },
    state: { shift: null, archive: [{ id: 'archive_1', objectId: 'object_1', objectName: 'Объект', date: '27.11.2026' }] },
    viewingArchiveId: 'archive_1',
    isNasRuntime: () => true,
    requireEdit: () => true,
    objectTitle: (id, name) => name || id,
    appConfirm: async () => true,
    nasArchiveAction: async () => {
      const error = new Error('api-http-409');
      error.code = 'api-http-409';
      error.serverCode = 'archive-restore-requires-v2';
      throw error;
    },
    closeArchiveModal: () => {},
    showToastEl: () => {},
    showError: message => errors.push(message)
  };
  vm.runInNewContext('async ' + functionBody(archiveSrc, 'restoreArchiveToShift') + '\nrestoreArchiveToShift();', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1, 'показана одна ошибка');
  assert.match(errors[0], /Восстановление архивной смены в этом режиме недоступно/);
  assert.match(errors[0], /смена не создана, данные архива не изменены/);
  assert.equal(/api-http-\d+/.test(errors[0]), false, 'сырой код не доходит до пользователя');
});

test('поведение: прочие ошибки восстановления по-прежнему называют причину', async () => {
  const errors = [];
  const context = {
    console: { error() {} },
    state: { shift: null, archive: [{ id: 'archive_1', objectId: 'object_1', objectName: 'Объект', date: '27.11.2026' }] },
    viewingArchiveId: 'archive_1',
    isNasRuntime: () => true,
    requireEdit: () => true,
    objectTitle: (id, name) => name || id,
    appConfirm: async () => true,
    nasArchiveAction: async () => { throw new Error('Обновите архив'); },
    closeArchiveModal: () => {},
    showToastEl: () => {},
    showError: message => errors.push(message)
  };
  vm.runInNewContext('async ' + functionBody(archiveSrc, 'restoreArchiveToShift') + '\nrestoreArchiveToShift();', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['Ошибка восстановления: Обновите архив']);
});

// === Часть 2: снапшот линии раскладывает restored-смены и не теряет их в офлайн-проекции ===
test('исходник: acceptNasLineSnapshot сохраняет restoredShifts и кладёт их рейсы в офлайн-проекцию', () => {
  const body = functionBody(nasSrc, 'acceptNasLineSnapshot');
  assert.match(body, /state\.restoredShifts\s*=\s*snapshot\.restoredShifts/, 'restoredShifts сохраняются в state');
  assert.match(body, /offlineRemoteLogs\s*=\s*\[\.\.\.snapshot\.logs,\.\.\.restoredLogs\]/,
    'рейсы restored попадают в офлайн-проекцию (иначе offlineProjectState их затирает)');
});

test('исходник: закрытие restored-смены не запускает повторный перенос материала', () => {
  const body = functionBody(nasSrc, 'nasCloseCurrentShift');
  assert.match(body, /restoredShift/, 'закрытие распознаёт restored-смену');
  assert.match(body, /prepared\.archive\s*&&\s*!restoredShift/, 'перенос материала пропускается для restored');
});

// === Часть 3: снапшот с restored-сменами проходит валидатор транспорта ===
test('транспорт: readLine допускает поле restoredShifts и проверяет его структуру', () => {
  assert.match(clientSrc, /x\.restoredShifts===undefined\|\|Array\.isArray\(x\.restoredShifts\)/,
    'restoredShifts опционально, но проверяется как массив');
  assert.match(clientSrc, /r\.shift\.restored===true/, 'каждая restored-смена помечена флагом');
  assert.match(clientSrc, /r\.logs\.every\(l=>l\.shiftId===r\.shift\.id/, 'рейсы restored принадлежат своей смене');
});

// === Часть 4: поведенческий прогон блока восстановленных смен в отчёте ===
class FakeElement {
  constructor() { this._html = ''; this.hidden = false; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
}

function runRenderRestoredShifts(restored) {
  const box = new FakeElement();
  const context = {
    document: { getElementById: () => box },
    state: { restoredShifts: restored },
    hasPermission: () => true,
    objectTitle: (id, name) => name || id,
    escapeHtml: s => String(s),
  };
  vm.runInNewContext(functionBody(reportsSrc, 'renderRestoredShifts') + '\nrenderRestoredShifts();', context);
  return box;
}

test('поведение: карточка restored-смены рендерится со сводкой и кнопкой возврата в архив', () => {
  const box = runRenderRestoredShifts([{
    shift: { id: 'shift_restored_1', objectId: 'o1', objectName: 'Объект А', startDate: '20.11.2026' },
    logs: [
      { id: 'r1', truckId: 't1', volume: 10, isGAI: false },
      { id: 'r2', truckId: 't1', volume: 5, isGAI: false },
      { id: 'r3', truckId: 't2', volume: 0, isGAI: true },
    ],
  }]);
  assert.equal(box.hidden, false, 'блок показан');
  assert.match(box.innerHTML, /Восстановленная смена: Объект А · 20\.11\.2026/);
  assert.match(box.innerHTML, /15 м³/, 'сводка объёма только по обычным рейсам');
  assert.match(box.innerHTML, /Вернуть в архив/, 'есть кнопка возврата в архив');
  assert.match(box.innerHTML, /closeRestoredShift\('shift_restored_1'\)/, 'кнопка адресует именно эту смену');
});

test('поведение: без restored-смен блок скрыт и пуст', () => {
  const box = runRenderRestoredShifts([]);
  assert.equal(box.hidden, true);
  assert.equal(box.innerHTML, '');
});
