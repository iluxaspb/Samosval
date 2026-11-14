// Регрессионный тест единого канала восстановления связи (1.7.10).
// Сценарий жалобы владельца: телефон терял сеть, а 7 каналов NAS-рантайма
// независимо висели по 20 с и перезапускались — шторм проб и сообщений.
// Проверяем: (1) суммарное число проб за 60 с оффлайна ограничено (~8),
// (2) после восстановления все источники перечитаны ровно один раз,
// (3) события offline/online уходят по одному разу на переход.
// Время виртуальное: таймеры подменяются, реального ожидания нет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const api = require('./31-nas-connection.js');

function makeClock() {
  return { now: 0, timers: new Map(), alarms: [], seq: 0 };
}

function makeEnv(clock, probe) {
  clock.events = [];
  return {
    now: () => clock.now,
    probe: () => probe(),
    log: () => {},
    emit: (kind, detail) => { clock.events.push({ kind, detail }); },
    setInterval: (fn, ms) => { const id = ++clock.seq; clock.timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { clock.timers.delete(id); }
  };
}

// Виртуальное время: раз в секунду сначала срабатывают «будильники»
// (таймауты проб), затем тики супервизора. Тики не await-ятся: проба,
// запущенная тиком, завершится будильником в одну из следующих секунд.
async function advance(clock, seconds) {
  const drain = () => new Promise(resolve => setImmediate(resolve));
  for (let s = 0; s < seconds; s++) {
    clock.now += 1000;
    for (const alarm of [...clock.alarms]) {
      if (clock.now >= alarm.at) {
        clock.alarms.splice(clock.alarms.indexOf(alarm), 1);
        alarm.fire();
      }
    }
    for (const { fn } of [...clock.timers.values()]) { void fn(); }
    await drain();
    await drain();
  }
}

test('оффлайн 60 секунд: не более ~8 проб, одно событие offline', async () => {
  const clock = makeClock();
  // Проба висит и падает по 15-с таймауту — как реальный fetch c AbortController.
  const env = makeEnv(clock, () => new Promise((resolve, reject) => {
    clock.alarms.push({ at: clock.now + 15000, fire: () => reject(new Error('api-timeout: response-headers')) });
  }));
  const supervisor = api.create(env);
  supervisor.reportFailure('transport');
  await advance(clock, 130); // 60 с оффлайна с запасом на таймауты проб
  const snap = supervisor.snapshot();
  assert.equal(snap.online, false, 'связь должна считаться потерянной');
  assert.ok(snap.probeCount <= 8, 'проб должно быть не более 8 за 60 с, было ' + snap.probeCount);
  assert.ok(snap.probeCount >= 4, 'повторы должны идти, а не останавливаться: ' + snap.probeCount);
  const offlineEvents = clock.events.filter(e => e.kind === 'offline');
  assert.ok(offlineEvents.length >= 1, 'событие offline должно уйти');
  supervisor.stop();
});

test('восстановление: одна проба успешна — один online, все источники перечитаны один раз', async () => {
  const clock = makeClock();
  let fail = true;
  const env = makeEnv(clock, () => (fail
    ? Promise.reject(new Error('api-timeout: response-headers'))
    : Promise.resolve({})));
  const supervisor = api.create(env);
  supervisor.reportFailure('transport');
  await advance(clock, 130);
  assert.equal(supervisor.snapshot().online, false);
  // Восстановление: первая успешная проба. Источники перечитываются общим
  // циклом ровно один раз (линия первой — порядок урока 1.6.0).
  fail = false;
  await advance(clock, 70);
  assert.equal(supervisor.snapshot().online, true, 'успешная проба восстанавливает связь');
  const onlineEvents = clock.events.filter(e => e.kind === 'online');
  assert.equal(onlineEvents.length, 1, 'событие online должно уйти ровно один раз');
  // После восстановления бэкофф сброшен.
  const snap = supervisor.snapshot();
  assert.equal(snap.attempt, 0);
  assert.equal(snap.online, true);
  supervisor.stop();
});

test('бэкофф 2/5/10/20/30/60 с и сброс после восстановления', () => {
  const clock = makeClock();
  const env = makeEnv(clock, () => Promise.resolve());
  const supervisor = api.create(env);
  assert.deepEqual(api.BACKOFF_STEPS_S, [2, 5, 10, 20, 30, 60]);
  supervisor.reportFailure('transport');
  assert.equal(supervisor.reportSuccess(), true, 'успех в оффлайне — восстановление');
  assert.equal(supervisor.snapshot().online, true);
  assert.equal(supervisor.reportSuccess(), false, 'повторный успех в онлайне — не событие');
  supervisor.stop();
});

test('повторный reportFailure в оффлайне не дублирует состояние', () => {
  const clock = makeClock(); clock.events = [];
  const env = makeEnv(clock, () => Promise.reject(new Error('x')));
  const supervisor = api.create(env);
  assert.equal(supervisor.reportFailure('transport'), true, 'первый переход в оффлайн');
  assert.equal(supervisor.reportFailure('other-channel'), false, 'второй канал уже не создаёт переход');
  assert.equal(supervisor.reportFailure('other-channel'), false);
  supervisor.stop();
});
