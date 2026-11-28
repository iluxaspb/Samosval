// В режиме параллельных смен линию ведёт v2-мост: v1-снимок описывает ровно
// одну смену и при двух открытых законно отвечает 409 multiple-active-shifts.
// Клиент не должен каждые 4 секунды спрашивать endpoint, который не может
// ответить: это лишние отказы в консоли и лишняя нагрузка на сервер.
//
// Тест держит правило подписки: сеанс читается всегда (по нему живут профиль,
// права и признаки связи), а снимок линии — только когда вызывающий слой
// подтверждает, что линия ещё не перешла к v2.
//
// Запуск: node --test working-test/source/core/session-client-line-policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNasClient } from '../../synology/session-client.mjs';

const workspaceId = 'main_workspace';

function response(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() { return this; },
  };
}

function sessionBody(uid) {
  return {
    format: 'samosval-session', version: 1, source: 'ubuntu', workspaceId,
    identityReady: true,
    profile: { uid, status: 'active', role: 'admin', deleted: false },
    permissions: { tabs: ['line'], actions: [] },
  };
}

function lineBody() {
  return {
    format: 'samosval-line-snapshot', version: 1, source: 'ubuntu', workspaceId,
    trucks: [], statuses: [], logs: [], cycleMinutes: 60, shift: null,
  };
}

function clientWith(handler) {
  const calls = [];
  const nas = createNasClient({
    baseUrl: 'https://samosval-test.iluxa.pro',
    workspaceId,
    getUser: () => ({ uid: 'one', getIdToken: async () => 'token' }),
    fetchImpl: async (url, options) => {
      const path = String(url).replace('https://samosval-test.iluxa.pro', '').split('?')[0];
      calls.push(path);
      return handler(path, options);
    },
  });
  return { nas, calls };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('линия выключена политикой: сеанс читается, снимок линии — нет', async () => {
  const { nas, calls } = clientWith(path => response(path === '/api/v1/session' ? sessionBody('one') : lineBody()));
  const sessions = [];
  const snapshots = [];
  const close = nas.subscribeLine({
    intervalMs: 60000,
    lineEnabled: () => false,
    onSession: session => sessions.push(session),
    onSnapshot: snapshot => snapshots.push(snapshot),
    onError: error => { throw error; },
  });
  await wait(120);
  close();
  nas.stop();
  assert.deepEqual(calls, ['/api/v1/session'], 'спрашиваем только сеанс');
  assert.equal(sessions.length, 1, 'сеанс дошёл до приложения');
  assert.equal(snapshots.length, 0, 'снимок линии не читался и не публиковался');
});

test('линия разрешена политикой: читаются и сеанс, и снимок', async () => {
  const { nas, calls } = clientWith(path => response(path === '/api/v1/session' ? sessionBody('one') : lineBody()));
  const sessions = [];
  const snapshots = [];
  const close = nas.subscribeLine({
    intervalMs: 60000,
    lineEnabled: () => true,
    onSession: session => sessions.push(session),
    onSnapshot: snapshot => snapshots.push(snapshot),
    onError: error => { throw error; },
  });
  await wait(120);
  close();
  nas.stop();
  assert.deepEqual(calls, ['/api/v1/session', '/api/v1/line/snapshot']);
  assert.equal(sessions.length, 1);
  assert.equal(snapshots.length, 1, 'снимок линии доходит до приложения');
});

test('без явной политики линия читается как раньше', async () => {
  const { nas, calls } = clientWith(path => response(path === '/api/v1/session' ? sessionBody('one') : lineBody()));
  const close = nas.subscribeLine({
    intervalMs: 60000,
    onSession: () => {},
    onSnapshot: () => {},
    onError: error => { throw error; },
  });
  await wait(120);
  close();
  nas.stop();
  assert.deepEqual(calls, ['/api/v1/session', '/api/v1/line/snapshot'], 'прежнее поведение не меняется');
});
