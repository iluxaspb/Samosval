import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {dataVersion, sharedValue, sendVersioned, snapshotCacheState} from '../src/snapshot-cache.mjs';

// Счётчик версии — единственная точка правды о том, что данные изменились.
test('dataVersion: читает счётчик изменений и не кэширует при ошибке', async () => {
  const ok = {query: async () => ({rows: [{last_sequence: '42'}]})};
  assert.equal(await dataVersion(ok), '42');
  const empty = {query: async () => ({rows: [{}]})};
  assert.equal(await dataVersion(empty), null);
  const broken = {query: async () => { throw new Error('db down'); }};
  assert.equal(await dataVersion(broken), null);
});

test('sharedValue: одна сборка на версию, параллельные запросы ждут её', async () => {
  let builds = 0;
  const build = async () => {
    builds += 1;
    await new Promise((r) => setTimeout(r, 20));
    return {value: 'снимок'};
  };
  const name = 'тест-одна-сборка-' + Math.random();
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => sharedValue(name, '7', build)));
  assert.equal(builds, 1, 'пять одновременных запросов собрали снимок один раз');
  for (const value of results) assert.equal(value.value, 'снимок');
  await sharedValue(name, '7', build);
  assert.equal(builds, 1, 'повторный запрос версии берёт готовое значение');
  await sharedValue(name, '8', build);
  assert.equal(builds, 2, 'новая версия собирается заново');
});

function request(port, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path: '/api/v1/games', headers}, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body}));
    }).on('error', reject);
  });
}

test('sendVersioned: первый ответ 200 с ETag, повтор с ETag — 304 без сборки тела', async (t) => {
  let builds = 0;
  const scope = 'тест-304-' + Math.random();
  const server = http.createServer((req, res) => {
    void sendVersioned(req, res, {
      scope,
      version: '100',
      build: async () => {
        builds += 1;
        return '{"ответ":"большой"}';
      },
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const first = await request(port);
  assert.equal(first.status, 200);
  assert.equal(first.body, '{"ответ":"большой"}');
  assert.match(first.headers.etag, /^"[a-f0-9]{64}"$/);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(builds, 1);

  const second = await request(port, {'if-none-match': first.headers.etag});
  assert.equal(second.status, 304);
  assert.equal(second.body, '');
  assert.equal(second.headers.etag, first.headers.etag);
  assert.equal(builds, 1, 'условный запрос не собирал тело заново');
});

test('sendVersioned: новая версия данных отдаёт новое тело и новый ETag', async (t) => {
  const scope = 'тест-версия-' + Math.random();
  const state = {version: '1', text: 'первый'};
  const server = http.createServer((req, res) => {
    void sendVersioned(req, res, {scope, version: state.version, build: async () => state.text});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const first = await request(port);
  assert.equal(first.body, 'первый');

  state.version = '2';
  state.text = 'второй';
  const changed = await request(port, {'if-none-match': first.headers.etag});
  assert.equal(changed.status, 200, 'изменившиеся данные не отдаются как 304');
  assert.equal(changed.body, 'второй');
  assert.notEqual(changed.headers.etag, first.headers.etag);

  const repeated = await request(port, {'if-none-match': changed.headers.etag});
  assert.equal(repeated.status, 304);
});

test('snapshotCacheState: показывает размер кэшей', () => {
  const state = snapshotCacheState();
  assert.ok(Number.isInteger(state.shared));
  assert.ok(Number.isInteger(state.etags));
  assert.ok(Number.isInteger(state.inflight));
});
