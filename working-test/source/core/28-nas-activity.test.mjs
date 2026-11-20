import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Проверяем тот самый файл, который уходит в сборку, а не его копию.
const file = fileURLToPath(new URL('./28-nas-activity.js', import.meta.url));
const context = vm.createContext({});
vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
const activity = context.WorkingTestNasActivity;

const runtimeFile = fileURLToPath(new URL('./21-nas-runtime.js', import.meta.url));
const runtime = readFileSync(runtimeFile, 'utf8');

test('перечислены все поводы обновления', () => {
  assert.deepEqual(Array.from(activity.REASONS), ['visibilitychange', 'focus', 'pageshow', 'online', 'resume', 'poll']);
});

test('модуль не пересоздаётся при повторной загрузке', () => {
  const before = context.WorkingTestNasActivity;
  vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
  assert.equal(context.WorkingTestNasActivity, before);
});

test('активность: скрытая вкладка или отсутствие сети — не активно', () => {
  assert.equal(activity.isActive({ hidden: false, onLine: true }), true);
  assert.equal(activity.isActive({}), true);
  assert.equal(activity.isActive({ hidden: true, onLine: true }), false);
  assert.equal(activity.isActive({ visible: false }), false);
  assert.equal(activity.isActive({ hidden: false, onLine: false }), false);
});

test('ограничитель частоты пропускает первую серию и держит паузу', () => {
  const gate = activity.createGate({ minGap: 10000 });
  assert.equal(activity.allow(gate, 1000, false), true);
  assert.equal(activity.allow(gate, 5000, false), false);
  assert.equal(activity.allow(gate, 11000, false), true);
});

test('возврат на экран (force) не сдерживается паузой', () => {
  const gate = activity.createGate({ minGap: 10000 });
  activity.allow(gate, 1000, false);
  assert.equal(activity.allow(gate, 2000, true), true);
  assert.equal(activity.allow(gate, 3000, false), false);
});

test('сброс ограничителя разрешает немедленное обновление', () => {
  const gate = activity.createGate({ minGap: 10000 });
  activity.allow(gate, 1000, false);
  activity.reset(gate);
  assert.equal(activity.allow(gate, 1500, false), true);
});

test('рантайм слушает возврат видимости, фокус, сеть, pageshow и resume', () => {
  assert.match(runtime, /addEventListener\('visibilitychange',wakeVisible\)/);
  assert.match(runtime, /addEventListener\('focus',wakeFocus\)/);
  assert.match(runtime, /addEventListener\('online',wakeOnline\)/);
  assert.match(runtime, /addEventListener\('pageshow',wakePageShow\)/);
  assert.match(runtime, /addEventListener\('resume',wakeResume\)/);
});

test('каждое событие и таймер запускают активное обновление', () => {
  for (const reason of ['visibilitychange', 'focus', 'pageshow', 'online', 'resume', 'poll']) {
    assert.match(runtime, new RegExp("nasActiveRefresh\\((?:gap>45000\\?'resume':)?'" + reason + "'"), 'нет обновления по поводу ' + reason);
  }
});

test('активное обновление перечитывает все основные источники', () => {
  for (const name of ['refreshNasObjects', 'refreshNasSettings', 'refreshNasAuxiliary', 'refreshNasGames', 'refreshNasArchive', 'refreshNasAdministration', 'replayNasOfflineJournal', 'nasNetworkWake']) {
    assert.ok(runtime.includes(name), 'не читается источник ' + name);
  }
});

test('разблокировка экрана слушается на document (Page Lifecycle API)', () => {
  assert.match(runtime, /document\.addEventListener\('resume',wakeResume\)/, 'нет document-слушателя resume');
  assert.match(runtime, /document\.addEventListener\('freeze',wakeFreeze\)/, 'нет document-слушателя freeze');
});

test('таймер замечает пропущенное время и обновляет всё принудительно', () => {
  assert.match(runtime, /gap>45000/, 'нет проверки разрыва между тиками');
  assert.match(runtime, /nasActiveRefresh\(gap>45000\?'resume':'poll'/, 'страховка не запускает полное обновление');
});