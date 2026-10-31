// Opt-in: a temporary context in existing Steel, never the MCP page.
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { start } from './server.mjs';

const browser = await chromium.connectOverCDP('ws://steel-opencode2:3000/', { headers: { Host: 'localhost:3000' } });
let context, server, ws;
try {
  context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  await cdp.detach();
  Object.assign(process.env, { STEEL_TARGET_ID: targetInfo.targetId, PORT: '0', BIND_HOST: '127.0.0.1',
    VIEW_ORIGIN: 'http://close-test.local', OPENCODE_UPSTREAM: 'http://127.0.0.1:4096' });
  server = start(); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString('base64'), Origin: process.env.VIEW_ORIGIN };
  ws = new WebSocket(base.replace('http:', 'ws:') + '/__browser/stream', { headers });
  const messages = [];
  let readyResolve, closedResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const closed = new Promise(resolve => { closedResolve = resolve; });
  ws.on('message', (data, binary) => {
    if (binary) return;
    const m = JSON.parse(data); messages.push(m.type);
    if (m.type === 'viewerState') readyResolve();
  });
  ws.on('close', closedResolve);
  ws.on('error', () => {});
  async function bounded(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Target close test timeout')), 10000); })]); }
    finally { clearTimeout(timer); }
  }
  await bounded(ready);
  await page.close();
  await bounded(closed);
  assert.ok(messages.includes('targetClosed'));
  console.log('PASS closed pinned test page emits targetClosed and closes stream');
  const response = await fetch(base + '/__browser/status', { headers });
  assert.equal(response.status, 503);
  console.log('PASS missing pinned target returns 503 instead of switching to MCP or another page');
} finally {
  ws?.terminate();
  await context?.close();
  await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
