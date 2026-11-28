// Кнопка «Самосвал больше не приедет» — отметка «больше не приедет» (решения
// владельца 28.11.2026: сначала сама отметка, затем значки вместо слов).
//
// Требования, которые держит этот файл:
// 1) право action_no_return есть в матрице и включено мастеру, прорабу и
//    старшему прорабу; у лопатёра и наблюдателя его нет;
// 2) кнопка нарисована в ОБОИХ рендерерах линии (ядро и анимационный
//    anim-speeds), с удержанием 0,5 с по умолчанию; на кнопках только значки
//    (📄 у ТТН и 🚫 у «больше не приедет»), слова не помещаются в ряд;
// 3) статус noReturn затемняет карточку и уводит её в самый конец списка;
// 4) «Приехал» снимает статус и не запирается кулдауном ходки;
// 5) в листках Д — русская, красная, крупная после последнего рейса и
//    маленькая рядом с номером машины; латинской D больше нет;
// 6) клиент не отправляет неизвестный серверу тип: белый список расширен.
//
// Запуск: node --test working-test/source/core/no-return-duplicate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(path.join(here, name), 'utf8');
const configSrc = read('00-config-state.js');
const offlineSrc = read('16-offline-replay.js');
const actionsSrc = read('17-trip-actions.js');
const lineUiSrc = read('18-line-ui.js');
const animSrc = readFileSync(path.join(here, '..', 'features', 'anim-speeds.js'), 'utf8');
const reportsSrc = read('09-reports.js');
const pngSrc = read('08-png-export.js');
const archiveSrc = read('10-archive.js');
const paperViewerSrc = readFileSync(path.join(here, '..', 'features', 'paper-viewer.js'), 'utf8');
const sessionClientSrc = readFileSync(path.join(here, '..', '..', 'synology', 'session-client.mjs'), 'utf8');

test('право action_no_return включено мастеру, прорабу и старшему прорабу', () => {
  assert.match(configSrc, /'action_no_return'/, 'право должно быть в ALL_ACTIONS');
  assert.match(configSrc, /action_no_return: 'Кнопка «Самосвал больше не приедет»'/);
  const block = /const DEFAULT_PERMISSIONS = \{([\s\S]*?)\n  \};/.exec(configSrc);
  assert.ok(block, 'DEFAULT_PERMISSIONS должен быть в 00-config-state.js');
  const roles = {};
  for (const role of ['senior_foreman', 'foreman', 'master', 'lopater', 'viewer']) {
    const row = new RegExp(role + ": \\{ tabs: \\[[^\\]]*\\], actions: \\[([^\\]]*)\\] \\}").exec(block[1]);
    assert.ok(row, `роль ${role} должна быть в DEFAULT_PERMISSIONS`);
    roles[role] = row[1].includes("'action_no_return'");
  }
  assert.deepEqual(roles, {
    senior_foreman: true, foreman: true, master: true, lopater: false, viewer: false,
  });
});

test('кнопка «больше не приедет» нарисована в обоих рендерерах линии', () => {
  for (const [name, src] of [['18-line-ui.js', lineUiSrc], ['anim-speeds.js', animSrc]]) {
    assert.match(src, /btn-no-return/, `${name}: кнопка отметки`);
    assert.match(src, /startNoReturnHold\(event/, `${name}: удержание кнопки`);
    assert.match(src, /canEditNoReturn/, `${name}: право на кнопку`);
    assert.match(src, /absent-mark[\s\S]{0,60}Больше не приедет/, `${name}: видимая метка «Больше не приедет»`);
  }
  assert.match(actionsSrc, /function startNoReturnHold/);
  assert.match(actionsSrc, /settings\.holdNoReturn\?\?0\.5/, 'по умолчанию удержание 0,5 с');
  assert.match(actionsSrc, /function toggleNoReturn/, 'действие уходит через очередь линии');
});

test('на кнопках только значки, слова не занимают место в ряду', () => {
  for (const [name, src] of [['18-line-ui.js', lineUiSrc], ['anim-speeds.js', animSrc]]) {
    assert.doesNotMatch(src, />Дубликат</, `${name}: слово «Дубликат» с кнопки убрано`);
    assert.doesNotMatch(src, /Забрать ТТН<\/button>|📄 ТТН/, `${name}: подпись ТТН с кнопки убрана`);
    assert.match(src, /btn-no-return"[^>]*aria-label="Самосвал больше не приедет"/, `${name}: знак назван для диктора`);
    assert.match(src, /btn-ttn[^>]*aria-label="\$\{ttnAria\}"/, `${name}: ТТН названа для диктора`);
    assert.match(src, /aria-hidden="true">🚫</, `${name}: знак «не приедет» — пиктограмма`);
    assert.match(src, /aria-hidden="true">📄</, `${name}: знак ТТН — пиктограмма`);
  }
});

test('статус noReturn затемняет карточку и уводит её в конец списка', () => {
  for (const [name, src] of [['18-line-ui.js', lineUiSrc], ['anim-speeds.js', animSrc]]) {
    assert.match(src, /noReturn\s*===\s*true/, `${name}: статус читается`);
    // Первый ключ сортировки — «не приехал»: такие машины уходят в самый конец.
    const sortBlock = /trucks\.sort\(([\s\S]*?)\);\n/.exec(src);
    assert.ok(sortBlock, `${name}: сортировка карточек найдена`);
    const noReturnIndex = sortBlock[1].indexOf('noReturn');
    const arriveIndex = sortBlock[1].indexOf('arriveStatus');
    assert.ok(noReturnIndex >= 0 && noReturnIndex < arriveIndex, `${name}: noReturn — первый ключ сортировки`);
    assert.match(src, /faded\s*=\s*[^;\n]*absent/, `${name}: затемнение учитывает «не приехал»`);
  }
});

test('«Приехал» снимает статус и не запирается кулдауном ходки', () => {
  const context = { console, Date, Math, JSON, Object, Array, String, Number, Set, Map, state: {}, window: {}, document: {}, navigator: { onLine: true } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(offlineSrc, context);
  const before = { onLine: true, shiftId: 's1', cycleRevision: 3, ttnRevision: 1,
    arriveStatus: '10:00', arriveTimestamp: 1000, lastLoadTimestamp: 500, loadedAfterArrive: true };
  const absent = context.offlineProjection(before,
    { type: 'no-return', shiftId: 's1', truckId: 't', createdAt: 9000, actor: 'Иван' });
  assert.equal(absent.status.noReturn, true);
  assert.equal(absent.status.arriveStatus, null, 'прибытие снимается: машина не на линии');
  assert.equal(absent.status.lastLoadTimestamp, 500, 'кулдаун ходки остаётся честным');
  assert.equal(absent.status.cycleRevision, 4);
  const back = context.offlineProjection(absent.status,
    { type: 'arrive', shiftId: 's1', truckId: 't', createdAt: 9500, actor: 'Иван', wantArrived: true });
  assert.equal(back.status.noReturn, false);
  assert.equal(back.status.noReturnAt, null);
  assert.equal(back.status.noReturnBy, null);
  assert.ok(back.status.arriveStatus, 'после «Приехал» машина снова на линии');
  // Кулдаун не должен запирать возврат «не приехавшей» машины.
  assert.doesNotMatch(actionsSrc, /if\(type==='arrive' && lastL && \(Date\.now\(\)-lastL\)<gap\)/);
  assert.match(actionsSrc, /type==='arrive' && st\.noReturn!==true && lastL/);
  assert.match(offlineSrc, /type==='arrive'&&!before\.arriveStatus&&before\.noReturn!==true/);
  for (const [name, src] of [['18-line-ui.js', lineUiSrc], ['anim-speeds.js', animSrc]]) {
    assert.match(src, /if \(inC && !absent\)|if \(inC && !absent\)/, `${name}: кулдаун не заменяет «Приехал» у «не приехал»`);
  }
});

test('в листках Д русская и красная, латинской D больше нет', () => {
  for (const [name, src] of [['09-reports.js', reportsSrc], ['08-png-export.js', pngSrc],
    ['10-archive.js', archiveSrc], ['paper-viewer.js', paperViewerSrc]]) {
    assert.doesNotMatch(src, />D<\/span>/, `${name}: латинская D удалена`);
    assert.match(src, /paper-absent-(mark|badge)/, `${name}: метки Д есть`);
  }
  assert.match(reportsSrc, /paper-absent-mark[\s\S]{0,200}>Д</, 'крупная Д — русская буква');
  assert.match(reportsSrc, /paper-absent-badge[\s\S]{0,200}>Д</, 'маленькая Д — русская буква');
  // Лишняя колонка не появляется: размер таблицы не меняется из-за буквы.
  assert.doesNotMatch(reportsSrc, /maxT = absentTrips \+ 1/);
  assert.doesNotMatch(reportsSrc, /gaiMaxT = gaiAbsentTrips \+ 1/);
  assert.doesNotMatch(pngSrc, /maxTrips = absentTrips \+ 1/);
});

test('клиент не отправляет серверу неизвестный тип операции', () => {
  assert.match(sessionClientSrc, /\['arrive','load','ttn','reset','no-return'\]/);
});
