import test from 'node:test';
import assert from 'node:assert/strict';
import { createNasClient, NasClientError } from '../../synology/session-client.mjs';

// Регресс 1.7.9: после простоя продление сеанса пересоздаёт объект-владельца.
// Клиент обязан продолжать работать, пока uid тот же, а подписка — не умирать.

const sessionBody = () => ({
  format: 'samosval-session', version: 1, source: 'ubuntu', workspaceId: 'main_workspace',
  identityReady: true, profile: null, permissions: { tabs: [], actions: [] },
  authority: { provider: 'ubuntu', generation: 1 }
});
const makeUser = (uid = 'uid-idle-recovery') => ({ uid, getIdToken: async () => 'token' });
const okFetch = (log = []) => (url, options) => {
  log.push(String(url));
  return Promise.resolve(new Response(JSON.stringify(sessionBody()), { headers: { 'Content-Type': 'application/json' } }));
};
const tickWait = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

// Ни один промис клиента не должен оставаться необработанным.
const unhandled = [];
process.on('unhandledRejection', reason => unhandled.push(reason));

test('пересоздание владельца с тем же uid не ломает клиент (readSession работает)', async () => {
  const first = makeUser(), second = makeUser();
  assert.notEqual(first, second, 'объекты должны быть разными');
  let current = first;
  const client = createNasClient({ baseUrl: 'https://idle-test.invalid', getUser: () => current, fetchImpl: okFetch() });
  await client.readSession();
  // wtStoreSession + wtAuthUser после refresh: новый объект, тот же uid.
  current = second;
  const again = await client.readSession();
  assert.equal(again.identityReady, true);
  current = makeUser(); // и ещё раз: каждое продление — новый объект
  await client.readSession();
  client.stop();
});

test('полный сценарий простоя: подписка переживает продление и продолжает тикать', async () => {
  let current = makeUser();
  const client = createNasClient({ baseUrl: 'https://idle-test.invalid', getUser: () => current, fetchImpl: okFetch() });
  let sessions = 0, errors = 0;
  const close = client.subscribeLine({
    onSession: () => sessions++,
    onSnapshot: () => {},
    onError: () => errors++,
    intervalMs: 1000
  });
  await tickWait(); assert.equal(sessions, 1);
  // «Продление» подменяет объект пользователя (тот же uid).
  current = makeUser();
  client.wake(); await tickWait();
  assert.equal(sessions, 2, 'тик после продления должен пройти');
  assert.equal(errors, 0);
  // Ещё одно продление и ещё тик — подписка жива, данные идут.
  current = makeUser();
  client.wake(); await tickWait();
  assert.equal(sessions, 3);
  assert.equal(errors, 0);
  close(); client.stop();
});

test('реальная смена uid / выход: подписка закрывается, session-changed сохранён', async () => {
  let current = makeUser();
  const client = createNasClient({ baseUrl: 'https://idle-test.invalid', getUser: () => current, fetchImpl: okFetch() });
  let sessions = 0; const seen = [];
  const close = client.subscribeLine({
    onSession: () => sessions++,
    onSnapshot: () => {},
    onError: error => seen.push(error.code),
    intervalMs: 1000
  });
  await tickWait(); assert.equal(sessions, 1);
  // Выход: getUser() === null.
  current = null;
  client.wake(); await tickWait();
  assert.ok(seen.includes('session-changed'), 'подписка обязана бросить session-changed');
  // Подписка закрыта навсегда: новые тики не приходят.
  client.wake(); await tickWait();
  assert.equal(sessions, 1);
  // Методы клиента продолжают бросать session-changed — старое поведение.
  await assert.rejects(client.readSession(), error => error instanceof NasClientError && error.code === 'session-changed');
  close(); client.stop();
  // Смена uid — то же самое: это реальная смена сессии.
  let other = makeUser('uid-other');
  const client2 = createNasClient({ baseUrl: 'https://idle-test.invalid', getUser: () => other, fetchImpl: okFetch() });
  other = makeUser('uid-new-owner');
  await assert.rejects(client2.readSession(), error => error.code === 'session-changed');
  client2.stop();
});

test('ни один промис не остался необработанным', async () => {
  await tickWait(120);
  assert.deepEqual(unhandled, []);
});
