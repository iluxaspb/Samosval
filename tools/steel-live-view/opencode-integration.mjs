// Opt-in integration test. Creates and removes only its own temporary PTY.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { start } from './server.mjs';

if (!process.env.OPENCODE_UPSTREAM) throw Error('Set the actual Basic-authenticated OpenCode HTTP upstream');
Object.assign(process.env, { PORT: '0', BIND_HOST: '127.0.0.1',
  VIEW_ORIGIN: 'http://integration.test', STEEL_TARGET_ID: 'A'.repeat(32) });
if (!process.env.OPENCODE_PASSWORD) throw Error('Existing server password required');
const server = start();
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const headers = { Authorization: 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString('base64'),
  'Content-Type': 'application/json', Origin: process.env.VIEW_ORIGIN, 'x-opencode-ticket': '1' };
const location = '?location[directory]=' + encodeURIComponent(process.cwd());
let id, ws;
async function api(path, method = 'GET', body) {
  const r = await fetch(origin + path + location, { method, headers,
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    throw Error(`${method} ${path}: HTTP ${r.status}; ${error.message || error._tag || 'request rejected'}`);
  }
  return r.status === 204 ? null : r.json();
}
try {
  const result = await api('/api/info');
  assert.equal(typeof result.version, 'string');
  console.log('PASS actual OpenCode info through sidecar');
  const created = await api('/api/pty', 'POST', { command: '/bin/cat', args: [], cwd: '/tmp/opencode', title: 'steel-view-integration-temporary' });
  id = created.data.id;
  const token = await api(`/api/pty/${id}/connect-token`, 'POST');
  // OpenCode itself requires a short-lived single-use PTY ticket, never a permanent secret.
  const url = new URL(`/api/pty/${id}/connect` + location, origin);
  url.protocol = 'ws:'; url.searchParams.set('ticket', token.data.ticket);
  ws = new WebSocket(url, { headers });
  let received = '';
  const output = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('PTY roundtrip timed out')), 10000);
    ws.on('message', data => {
      received += data.toString();
      if (received.includes('steel-view-roundtrip-ok')) { clearTimeout(timer); resolve(); }
    });
    ws.once('error', error => { clearTimeout(timer); reject(Error('PTY socket error: ' + error.code)); });
  });
  await once(ws, 'open');
  ws.send('steel-view-roundtrip-ok\n');
  await output;
  console.log('PASS actual OpenCode PTY WebSocket input/output through authenticated sidecar');
} finally {
  ws?.terminate();
  if (id) {
    await api(`/api/pty/${id}`, 'DELETE');
    const list = await api('/api/pty');
    assert.ok(!list.data.some(p => p.id === id));
    console.log('PASS only the temporary test PTY removed');
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
