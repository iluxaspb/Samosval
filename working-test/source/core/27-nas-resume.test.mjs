import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Проверяем тот самый файл, который уходит в сборку, а не его копию.
const file = fileURLToPath(new URL('./26-nas-resume.js', import.meta.url));
const context = vm.createContext({});
vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
const resume = context.WorkingTestNasResume;

test('модуль выставляет полный набор источников', () => {
  assert.deepEqual(Array.from(resume.SOURCES), ['nas', 'nas-objects', 'nas-games', 'nas-auxiliary', 'nas-archive', 'nas-settings', 'nas-admin', 'nas-catalog']);
});

test('повторная загрузка файла не ломает существующий объект', () => {
  const before = context.WorkingTestNasResume;
  vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
  assert.equal(context.WorkingTestNasResume, before);
});

test('последовательность паузы повтора: 1, 2, 4, 8, 16, 30 секунд', () => {
  assert.equal(resume.backoffDelay(1), 1000);
  assert.equal(resume.backoffDelay(2), 2000);
  assert.equal(resume.backoffDelay(3), 4000);
  assert.equal(resume.backoffDelay(4), 8000);
  assert.equal(resume.backoffDelay(5), 16000);
  assert.equal(resume.backoffDelay(6), 30000);
  assert.equal(resume.backoffDelay(60), 30000);
});

test('нечисловая или нулевая попытка даёт базовую паузу', () => {
  assert.equal(resume.backoffDelay(0), 1000);
  assert.equal(resume.backoffDelay('x'), 1000);
  assert.equal(resume.backoffDelay(undefined), 1000);
  assert.equal(resume.backoffDelay(-3), 1000);
  assert.equal(resume.backoffDelay(3, { base: 500, max: 1200 }), 1200);
});

test('неудача считает попытки и назначает время следующего повтора', () => {
  const state = resume.createState();
  const first = resume.recordFailure(state, 'nas', 10000);
  assert.equal(first.attempt, 1);
  assert.equal(first.nextAt, 11000);
  const second = resume.recordFailure(state, 'nas', 20000);
  assert.equal(second.attempt, 2);
  assert.equal(second.nextAt, 22000);
});

test('повтор разрешён только после назначенного времени', () => {
  const state = resume.createState();
  assert.equal(resume.due(state, 'nas', 0), true);
  resume.recordFailure(state, 'nas', 10000);
  assert.equal(resume.due(state, 'nas', 10999), false);
  assert.equal(resume.due(state, 'nas', 11000), true);
});

test('успех и полный сброс очищают счётчики источников', () => {
  const state = resume.createState();
  resume.recordFailure(state, 'nas', 0);
  resume.recordFailure(state, 'nas-settings', 0);
  resume.recordSuccess(state, 'nas');
  assert.equal(resume.due(state, 'nas', 1), true);
  assert.equal(resume.due(state, 'nas-settings', 1), false);
  resume.reset(state);
  assert.equal(resume.due(state, 'nas-settings', 1), true);
});

// Текстовые якоря: правку автовосстановления нельзя удалить молча.
const runtimeText = readFileSync(fileURLToPath(new URL('./21-nas-runtime.js', import.meta.url), 'utf8'), 'utf8');
const clientText = readFileSync(fileURLToPath(new URL('../../synology/session-client.mjs', import.meta.url), 'utf8'), 'utf8');

test('обработка возврата из сворачивания остаётся в рантайме', () => {
  assert.match(runtimeText, /pageshow/);
  assert.match(runtimeText, /nasDropHungReads/);
  assert.match(runtimeText, /nasSyncSupervisorTick/);
});

test('клиент умеет прерывать зависшие запросы и держит сторож тика', () => {
  assert.match(clientText, /abortInflight/);
  assert.match(clientText, /api-timeout/);
  assert.match(clientText, /watchdog/);
});
