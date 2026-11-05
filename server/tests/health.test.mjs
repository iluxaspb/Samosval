import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {handleHealthRequest} from '../src/health.mjs';

test('GET /health returns status and current timestamp', async (t) => {
  const server = http.createServer((req, res) => {
    if (handleHealthRequest(req, res)) return;
    res.statusCode = 404;
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const before = Date.now();
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  const body = await response.json();
  const after = Date.now();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(Object.keys(body).sort(), ['status', 'timestamp']);
  assert.equal(body.status, 'ok');
  assert.ok(Number.isFinite(Date.parse(body.timestamp)));
  assert.ok(Date.parse(body.timestamp) >= before && Date.parse(body.timestamp) <= after);
});
