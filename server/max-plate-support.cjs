/* Optional adapter for the EXISTING authenticated MAX relay, Node 20+.
 * No HTTP listener, credentials or deployment are added by this module.
 * Call send() only behind the relay's existing authentication / chat authorization.
 */
'use strict';
const { createHash } = require('node:crypto');
const CONTRACT = 'samosval-max-plate-v1';
function fault(message, status = 400) { return Object.assign(new Error(message), { status }); }
function memoryReceipts() {
  const map = new Map();
  return { async get(key) { const x = map.get(key); if (x && x.expires > Date.now()) return x.value; map.delete(key); return null; }, async set(key, value) { map.set(key, { value, expires: Date.now() + 86400000 }); if (map.size > 1000) map.delete(map.keys().next().value); } };
}
function validate(body) {
  if (!body || body.contract !== CONTRACT || !/^[A-Za-z0-9_-]{1,120}$/.test(body.request_id || '')) throw fault('Invalid image request');
  const chatId = String(body.chat_id ?? '').trim(); if (!/^-?\d{1,20}$/.test(chatId)) throw fault('Invalid chat ID');
  if (typeof body.text !== 'string' || body.text.length > 4000) throw fault('Invalid caption');
  const image = body.image;
  if (!image || image.mime_type !== 'image/png' || typeof image.content_base64 !== 'string' || image.content_base64.length > 90000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.content_base64)) throw fault('Invalid PNG');
  const png = Buffer.from(image.content_base64, 'base64');
  if (png.length < 33 || png.length > 67500 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png.toString('ascii', 12, 16) !== 'IHDR') throw fault('Invalid PNG header');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (width < 1 || width > 1200 || height < 1 || height > 400) throw fault('PNG dimensions too large', 413);
  return { chatId, text: body.text, requestId: body.request_id, png, imageHash: createHash('sha256').update(png).digest('hex') };
}
function createMaxPlateSupport({ botToken, fetchImpl = fetch, receiptStore = memoryReceipts(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof botToken !== 'string' || !botToken.trim()) throw Error('Server-side MAX bot token is required');
  const base = 'https://platform-api2.max.ru', tokens = new Map(), inFlight = new Map();
  async function request(url, options) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const response = await fetchImpl(url, { ...options, signal: ctrl.signal, redirect: 'error' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.code || data.success === false) {
        const error = fault('MAX request failed', response.status === 429 ? 429 : response.status >= 500 ? 503 : 502);
        error.maxCode = typeof data.code === 'string' ? data.code : ''; throw error;
      }
      return data;
    } catch (error) { if (error.status) throw error; throw fault('MAX transport unavailable', 503); }
    finally { clearTimeout(timer); }
  }
  async function imageToken(input) {
    if (tokens.has(input.imageHash)) return tokens.get(input.imageHash);
    const upload = await request(base + '/uploads?type=image', { method: 'POST', headers: { Authorization: botToken } });
    let url; try { url = new URL(upload.url); } catch (_) { throw fault('Invalid MAX upload URL', 502); }
    // The official image upload response uses iu.oneme.ru. Never forward a bot token to an arbitrary URL.
    if (url.protocol !== 'https:' || url.hostname !== 'iu.oneme.ru' || url.username || url.password || url.port) throw fault('Unexpected MAX upload host', 502);
    const form = new FormData(); form.append('data', new Blob([input.png], { type: 'image/png' }), 'gosnomer.png');
    const uploaded = await request(url.href, { method: 'POST', headers: { Authorization: botToken }, body: form });
    const values = uploaded.photos && typeof uploaded.photos === 'object' ? Object.values(uploaded.photos) : [];
    const token = values.length === 1 ? values[0]?.token : null;
    if (typeof token !== 'string' || !token || token.length > 8192) throw fault('MAX did not return an image token', 502);
    tokens.set(input.imageHash, token); if (tokens.size > 256) tokens.delete(tokens.keys().next().value); return token;
  }
  async function send(body) {
    const input = validate(body), key = input.chatId + ':' + input.requestId;
    const digest = createHash('sha256').update(JSON.stringify([input.chatId, input.text, input.imageHash])).digest('hex');
    const active = inFlight.get(key); if (active) { if (active.digest !== digest) throw fault('Request ID reused with different content', 409); return active.promise; }
    const promise = (async () => {
      const previous = await receiptStore.get(key); if (previous) { if (previous.digest !== digest) throw fault('Request ID reused with different content', 409); return previous.ack; }
      const token = await imageToken(input); let sent;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          sent = await request(base + '/messages?chat_id=' + encodeURIComponent(input.chatId), { method: 'POST', headers: { Authorization: botToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: input.text, attachments: [{ type: 'image', payload: { token } }] }) }); break;
        } catch (error) {
          if (error.maxCode !== 'attachment.not.ready' || attempt === 3) throw error;
          await pause(1000 * Math.pow(2, attempt));
        }
      }
      const mid = sent?.message?.body?.mid; if (typeof mid !== 'string' || !mid) throw fault('MAX did not confirm message creation', 502);
      const ack = { contract: CONTRACT, success: true, message_id: mid };
      await receiptStore.set(key, { digest, ack }); return ack;
    })();
    inFlight.set(key, { digest, promise }); try { return await promise; } finally { inFlight.delete(key); }
  }
  return { capabilities: { contract: CONTRACT, capabilities: { image_png: true } }, send };
}
module.exports = { CONTRACT, createMaxPlateSupport, validate };
