import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createHandoff } from './handoff.mjs';

export function authorized(value, password) {
  if (!password || !value?.startsWith('Basic ')) return false;
  const expected = Buffer.from(`opencode:${password}`);
  const actual = Buffer.from(value.slice(6), 'base64');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
export function allowedInput(message, mode) {
  return mode === 'manual' && ['mouseEvent', 'keyEvent'].includes(message?.type);
}
export function start() {
  const upstream = process.env.OPENCODE_UPSTREAM;
  const steel = process.env.STEEL_UPSTREAM || 'http://steel-opencode2:3000';
  const password = process.env.OPENCODE_PASSWORD;
  const target = process.env.STEEL_TARGET_ID;
  const origin = process.env.VIEW_ORIGIN;
  if (!upstream || !password || !/^[A-F0-9]{32}$/i.test(target || '') || !origin) {
    throw Error('Require OPENCODE_UPSTREAM, OPENCODE_PASSWORD, STEEL_TARGET_ID, VIEW_ORIGIN');
  }
  if (new URL(upstream).protocol !== 'http:') throw Error('Internal OpenCode upstream must use HTTP');
  const auth = value => authorized(value, password);
  const headers = { Authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') };
  const handoff = createHandoff();
  const viewers = new Set();
  async function session() {
    const r = await fetch(steel + '/v1/sessions', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw Error('Steel unavailable');
    const { sessions } = await r.json();
    if (sessions.length !== 1) throw Error('Expected one verified Steel session');
    const s = sessions[0];
    const details = await fetch(`${steel}/v1/sessions/${encodeURIComponent(s.id)}/live-details`, { signal: AbortSignal.timeout(5000) });
    const d = await details.json();
    if (!d.pages?.some(p => p.id === target)) throw Error('Pinned MCP target is no longer available');
    return { id: s.id, target, status: d.browserState.status };
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });
  const server = http.createServer(async (req, res) => {
    if (!auth(req.headers.authorization)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="OpenCode browser test", charset="UTF-8"', 'Cache-Control': 'no-store' }); res.end('Authentication required'); return;
    }
    try {
      const u = new URL(req.url, origin);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (u.pathname === '/__browser/handoff') {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') { res.end(JSON.stringify(handoff.get())); return; }
        if (req.method !== 'POST' || req.headers.origin !== origin || !String(req.headers['content-type']).startsWith('application/json')) {
          res.writeHead(403); res.end('{}'); return;
        }
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 2048) { res.writeHead(413); res.end('{}'); return; } }
        try {
          const { action, chat } = JSON.parse(body);
          const state = handoff.change(action, chat);
          // Revoke every manual connection before acknowledging resume/finish.
          for (const viewer of viewers) viewer.revoke();
          res.end(JSON.stringify(state));
        } catch { res.writeHead(409); res.end('{"error":"Invalid handoff transition"}'); }
        return;
      }
      if (u.pathname === '/__browser/panel.js') {
        res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(new URL('./panel.js', import.meta.url))); return;
      }
      if (u.pathname === '/__browser/status') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await session())); return;
      }
      if (u.pathname.startsWith('/__browser/')) { res.writeHead(404); res.end(); return; }
      // Only the existing OpenCode HTTP interface is proxied, never arbitrary URLs or Steel APIs.
      const url = new URL(upstream); url.pathname = u.pathname; url.search = u.search;
      const input = { ...req.headers, ...headers, host: url.host, 'accept-encoding': 'identity' };
      delete input.connection;
      const proxy = http.request(url, { method: req.method, headers: input }, response => {
        const out = { ...response.headers, 'cache-control': 'no-store' };
        delete out['transfer-encoding'];
        if (String(out['content-type']).includes('text/html')) {
          const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => {
            const html = Buffer.concat(chunks).toString().replace('</body>', '<script src="/__browser/panel.js"></script></body>');
            delete out['content-length']; delete out['content-encoding'];
            res.writeHead(response.statusCode, out); res.end(html);
          });
        } else { res.writeHead(response.statusCode, out); response.pipe(res); }
      });
      proxy.on('error', () => { res.writeHead(502); res.end('OpenCode unavailable'); });
      req.pipe(proxy);
    } catch { res.writeHead(503); res.end('Browser target unavailable'); }
  });
  server.on('upgrade', async (req, socket, head) => {
    // Browser WebSockets must carry same-origin credentials. No tokens in URLs.
    if (!auth(req.headers.authorization) || req.headers.origin !== origin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if (req.url !== '/__browser/stream') {
      if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.startsWith('/__browser/')) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return;
      }
      // Relay upgrades only to the fixed OpenCode upstream; never to a client-supplied host.
      const url = new URL(upstream);
      const parsed = new URL(req.url, origin);
      url.pathname = parsed.pathname; url.search = parsed.search;
      const proxy = http.request(url, { headers: { ...req.headers, ...headers, host: url.host,
        origin: new URL(upstream).origin } });
      proxy.on('upgrade', (response, remote, rest) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
          Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n') + '\r\n\r\n');
        if (rest.length) socket.write(rest);
        if (head.length) remote.write(head);
        remote.pipe(socket); socket.pipe(remote);
        remote.on('error', () => socket.destroy());
        socket.on('error', () => remote.destroy());
        socket.on('close', () => remote.destroy());
      });
      proxy.on('response', response => {
        socket.end(`HTTP/1.1 ${response.statusCode} Upgrade Rejected\r\nConnection: close\r\n\r\n`);
        response.resume();
      });
      proxy.on('error', () => socket.destroy());
      socket.on('error', () => proxy.destroy());
      proxy.end();
      return;
    }
    try {
      const s = await session();
      wss.handleUpgrade(req, socket, head, client => {
        let mode = 'view';
        const viewer = { revoke() {
          mode = 'view';
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'viewerState', mode, session: s }));
        } };
        viewers.add(viewer);
        const url = new URL('/', steel);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const remote = new WebSocket(url, { headers: { Host: 'localhost:3000' }, maxPayload: 8388608 });
        let seq = 0, attached;
        const waiting = new Map();
        function cdp(method, params = {}, sessionId = attached) {
          return new Promise((resolve, reject) => {
            const id = ++seq;
            const timer = setTimeout(() => { waiting.delete(id); reject(Error('CDP timeout')); }, 5000);
            waiting.set(id, { resolve, reject, timer });
            remote.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        }
        remote.on('message', data => {
          const m = JSON.parse(data.toString());
          if (m.id && waiting.has(m.id)) {
            const p = waiting.get(m.id); waiting.delete(m.id); clearTimeout(p.timer);
            if (m.error) p.reject(Error('CDP rejected command')); else p.resolve(m.result);
          }
          if (m.method === 'Page.screencastFrame' && m.sessionId === attached) {
            if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 8388608) {
              client.send(Buffer.from(m.params.data, 'base64'), { binary: true });
            }
            cdp('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
          }
        });
        remote.on('open', async () => {
          try {
            const result = await cdp('Target.attachToTarget', { targetId: target, flatten: true }, null);
            attached = result.sessionId;
            await cdp('Page.enable');
            await cdp('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
            const metrics = await cdp('Page.getLayoutMetrics');
            client.send(JSON.stringify({ type: 'viewport', width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight }));
            client.send(JSON.stringify({ type: 'viewerState', mode, session: s }));
          } catch { client.close(1011, 'Screencast unavailable'); }
        });
        client.on('message', (data, binary) => {
          if (binary) return;
          try {
            const m = JSON.parse(data);
            if (m.type === 'mode' && ['view', 'manual'].includes(m.value)) {
              const state = handoff.get();
              if (m.value === 'manual' && state.phase !== 'inactive' && (m.chat !== state.chat || state.phase !== 'login')) return;
              mode = m.value; client.send(JSON.stringify({ type: 'viewerState', mode, session: s })); return;
            }
            if (allowedInput(m, mode) && remote.readyState === WebSocket.OPEN) {
              if (!attached) return;
              if (m.type === 'mouseEvent') {
                const e = m.event;
                if (!['mousePressed', 'mouseReleased', 'mouseWheel'].includes(e?.type) || !Number.isFinite(e.x) || !Number.isFinite(e.y)) return;
                cdp('Input.dispatchMouseEvent', { type: e.type, x: e.x, y: e.y, button: 'left', clickCount: 1,
                  ...(e.type === 'mouseWheel' ? { deltaX: Number(e.deltaX) || 0, deltaY: Number(e.deltaY) || 0 } : {}) }).catch(() => {});
              } else {
                const e = m.event;
                if (e?.type === 'char' && typeof e.text === 'string') cdp('Input.insertText', { text: e.text.slice(0, 4096) }).catch(() => {});
                else if (['keyDown', 'keyUp'].includes(e?.type)) cdp('Input.dispatchKeyEvent', {
                  type: e.type, key: String(e.key || '').slice(0, 80), code: String(e.code || '').slice(0, 80),
                  windowsVirtualKeyCode: Number(e.keyCode) || 0, ...(e.text ? { text: String(e.text).slice(0, 10) } : {}) }).catch(() => {});
              }
            }
          } catch { client.close(1008, 'Invalid input'); }
        });
        remote.on('close', () => client.close(1000, 'Steel stream ended'));
        remote.on('error', () => client.close(1011, 'Steel stream unavailable'));
        client.on('close', () => {
          viewers.delete(viewer);
          if (remote.readyState === WebSocket.OPEN && attached) cdp('Page.stopScreencast').finally(() => remote.close()).catch(() => {});
          else remote.close();
        });
        client.on('error', () => remote.close());
      });
    } catch { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); }
  });
  server.listen(Number(process.env.PORT || 4180), process.env.BIND_HOST || '127.0.0.1');
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) start();
