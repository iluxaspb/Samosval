const fs = require('fs'), assert = require('node:assert/strict'), { JSDOM } = require('jsdom');
const patch = fs.readFileSync('patches/max-plate-notifications-v1.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const sender = html.match(/  async function sendMaxOnce\(item\) \{[\s\S]*?(?=  async function runMaxQueue)/)[0];
const dom = new JSDOM('<div id="admin-sub-appsettings"><div class="form-card"></div></div>', { runScripts: 'outside-only', url: 'https://app.example/' });
const w = dom.window, calls = [], queued = [];
w.AbortController = AbortController;
w.appConfig = { maxEnabled: true, maxUrl: 'https://relay.example/send', maxToken: 'fixture', maxChatId: 'fixture-chat' };
w.canAdmin = () => true;
w.enqueueMax = (text, meta, notBefore) => queued.push({ type: 'text', text, meta, notBefore });
w.applyAllPatches = () => {};
let response = { ok: true, status: 200 };
w.fetch = async (url, options) => { calls.push({ url, ...options, body: JSON.parse(options.body) }); return response; };
w.eval(sender); w.eval(patch);
(async () => {
  const api = w.MaxPlateNotifications;
  for (const title of ['⚡ Погрузка', '🚛 Приехал на объект', '📄 Забрал ТТН', '🟢 На линию добавлен', '🔴 С линии убран']) {
    const text = title + '\n🚛 КАМАЗ А123ВС178\n👤 Мастер\n🏢 Объект № 1';
    w.enqueueMax(text, { truckId: 'truck', logId: 'log', reis: 7 }, 123);
    const item = queued.at(-1), before = JSON.stringify(item), count = calls.length;
    assert.equal(await w.sendMaxOnce(item), 'ok');
    assert.equal(calls.length, count + 1); // No capability request or extra message.
    const call = calls.at(-1);
    assert.equal(call.method, 'POST');
    assert.equal(call.url, w.appConfig.maxUrl);
    assert.equal(call.headers.Authorization, 'Bearer fixture');
    assert.deepEqual(Object.keys(call.body).sort(), ['chat_id', 'text']);
    assert.equal(call.body.chat_id, 'fixture-chat');
    assert.equal(call.body.text, title + '\n🚛 КАМАЗ ' + api.formatPlateText('А123ВС178') + '\n👤 Мастер\n🏢 Объект № 1');
    assert.equal(JSON.stringify(item), before); // Original queue and retry data stay unchanged.
    assert.equal(item.meta.reis, 7); assert.equal(item.notBefore, 123);
    assert.equal(api.formatText(call.body.text), call.body.text); // Re-applying cannot duplicate the plate.
  }
  for (const number of ['А123ВС78', 'А123ВС178', 'a 123 bc 78', 'А-123-ВС-178']) {
    const formatted = api.formatText('Госномер: ' + number);
    assert(formatted.includes('【')); assert(formatted.includes('🇷🇺'));
  }
  const untouched = ['👤 А123ВС178\n🏢 Р555СТ98', '🚛 А123ВС1789', '🚛 А12ВС178', 'Смена закрыта'];
  for (const text of untouched) assert.equal(api.formatText(text), text);
  const prefix = '🚛 А123ВС178\n', long = prefix + 'x'.repeat(4000 - prefix.length);
  assert.equal(long.length, 4000); assert.equal(api.formatText(long), long);
  const crlf = '⚡ Погрузка\r\n🚛 А123ВС78\r\n👤 Мастер';
  assert.equal(api.formatText(crlf).split('\r\n').length, 3);
  await w.sendMaxOnce({ type: 'document', filename: 'report.pdf', base64: 'pdf', caption: '🚛 А123ВС178' });
  assert.deepEqual(calls.at(-1).body, { chat_id: 'fixture-chat', text: '🚛 А123ВС178', document: { filename: 'report.pdf', content_base64: 'pdf' } });
  const wrapped = w.sendMaxOnce; w.eval(patch); assert.strictEqual(w.sendMaxOnce, wrapped);
  assert.equal(w.document.querySelectorAll('#maxPlatePanel').length, 1);
  assert.equal(w.document.querySelectorAll('#maxPlatePanel button').length, 1);
  for (const [status, expected] of [[401, 'auth'], [429, 'retry'], [503, 'retry']]) {
    response = { ok: false, status }; const count = calls.length;
    assert.equal(await w.sendMaxOnce(queued[0]), expected); assert.equal(calls.length, count + 1);
  }
  response = { ok: true, status: 200 }; w.appConfig.maxPlateEnabled = false;
  await w.sendMaxOnce(queued[0]); assert.equal(calls.at(-1).body.text, queued[0].text);
  w.appConfig.maxEnabled = false; const count = calls.length;
  assert.equal(await w.sendMaxOnce(queued[0]), 'drop'); assert.equal(calls.length, count);
  console.log('PASS text mode: actual legacy sender, one POST/no PNG lookup, unchanged body schema, queue/retries/PDF, events, 2/3-digit regions, idempotence, text limit and opt-out');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => w.close());
