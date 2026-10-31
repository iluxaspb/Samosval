import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { start } from './server.mjs';

test('authenticated OpenCode upgrade relays text and binary to fixed upstream', async () => {
  const original = { ...process.env };
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ origin: req.headers.origin }));
  });
  const wss = new WebSocketServer({ server: upstream });
  let path, auth;
  wss.on('connection', (ws, req) => {
    path = req.url; auth = req.headers.authorization;
    ws.on('message', (data, binary) => ws.send(data, { binary }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  Object.assign(process.env, { OPENCODE_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
    OPENCODE_PASSWORD: 'test-only', STEEL_TARGET_ID: 'A'.repeat(32), VIEW_ORIGIN: 'http://test.local',
    PORT: '0', BIND_HOST: '127.0.0.1' });
  const proxy = start(); await once(proxy, 'listening');
  let client;
  try {
    const base = `http://127.0.0.1:${proxy.address().port}`;
    const authorization = 'Basic ' + Buffer.from('opencode:test-only').toString('base64');
    const same = await fetch(base + '/api/test', { headers: { Authorization: authorization, Origin: 'http://test.local' } });
    assert.equal((await same.json()).origin, process.env.OPENCODE_UPSTREAM);
    const foreign = await fetch(base + '/api/test', { headers: { Authorization: authorization, Origin: 'https://foreign.example' } });
    assert.equal(foreign.status, 403);
    client = new WebSocket(`ws://127.0.0.1:${proxy.address().port}/api/test?cursor=1`, {
      headers: { Origin: 'http://test.local', Authorization: 'Basic ' + Buffer.from('opencode:test-only').toString('base64') },
    });
    await once(client, 'open');
    const text = once(client, 'message'); client.send('hello');
    const [a, binaryA] = await text; assert.equal(a.toString(), 'hello'); assert.equal(binaryA, false);
    const binary = once(client, 'message'); client.send(Buffer.from([1, 2, 3]));
    const [b, binaryB] = await binary; assert.deepEqual([...b], [1, 2, 3]); assert.equal(binaryB, true);
    assert.equal(path, '/api/test?cursor=1');
    assert.equal(auth, 'Basic ' + Buffer.from('opencode:test-only').toString('base64'));
  } finally {
    client?.terminate();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});
