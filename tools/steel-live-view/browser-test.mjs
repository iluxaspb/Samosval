import { chromium } from 'playwright-core';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const origin = process.env.TEST_VIEW_ORIGIN;
if (!origin || !process.env.OPENCODE_PASSWORD || !process.env.STEEL_TARGET_ID) throw Error('Missing test environment');
const browser = await chromium.connectOverCDP('ws://steel-opencode2:3000/', { headers: { Host: 'localhost:3000' } });
let target, viewerContext, probe;
const report = { checks: [], limitations: ['Not a physical Android device', 'No external Synology WebSocket test', 'No real website login'] };
const pass = text => { report.checks.push(text); console.log('PASS', text); };
try {
  assert.equal((await fetch(origin + '/__browser/status')).status, 401);
  assert.equal((await fetch(origin + '/')).status, 401);
  pass('Unauthenticated OpenCode and browser status requests return 401');
  const authorization = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64');
  for (const headers of [{ Origin: origin }, { Authorization: authorization, Origin: 'https://invalid.example' }]) {
    const status = await new Promise((resolve, reject) => {
      const ws = new WebSocket(origin.replace('http', 'ws') + '/__browser/stream', { headers });
      ws.on('unexpected-response', (_, response) => { resolve(response.statusCode); response.destroy(); });
      ws.on('open', () => { ws.close(); reject(Error('Unauthorized WebSocket accepted')); });
      ws.on('error', () => {});
    });
    assert.equal(status, 403);
  }
  pass('WebSocket rejects missing credentials and foreign Origin with 403');
  for (const context of browser.contexts()) for (const page of context.pages()) {
    const cdp = await context.newCDPSession(page);
    const result = await cdp.send('Target.getTargetInfo'); await cdp.detach();
    if (result.targetInfo.targetId === process.env.STEEL_TARGET_ID) target = page;
  }
  assert.ok(target, 'Pinned MCP target exists');
  assert.equal(target.url(), 'about:blank', 'Do not replace a user page');
  await target.route('**/*', async route => {
    const url = new URL(route.request().url());
    const files = {
      '/': new URL('../../tests/paper-viewer/benchmark.html', import.meta.url),
      '/test-app/vendor/html2pdf-0.10.1.bundle.min.js': new URL('../../test-app/vendor/html2pdf-0.10.1.bundle.min.js', import.meta.url),
    };
    if (url.hostname !== 'steel-fixture.test' || !files[url.pathname]) return route.abort();
    await route.fulfill({ contentType: url.pathname === '/' ? 'text/html' : 'text/javascript', body: await readFile(files[url.pathname]) });
  });
  await target.goto('http://steel-fixture.test/');
  assert.ok(await target.locator('#paperReportContainer').isVisible());
  await target.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'live-control-fixture';
    box.style.cssText = 'position:fixed;left:20px;top:20px;z-index:99999;background:white;color:black;padding:16px';
    box.innerHTML = '<button id="control-test" style="width:160px;height:60px">Проверка управления</button><input id="control-input" style="display:block;width:160px;height:40px"><output id="control-result">0</output>';
    document.body.append(box);
    window.controlClicks = 0;
    box.querySelector('button').onclick = () => box.querySelector('output').textContent = String(++window.controlClicks);
  });
  pass('Real existing Samosval isolated benchmark loaded in pinned MCP target; all external requests blocked');
  probe = new WebSocket(origin.replace('http', 'ws') + '/__browser/stream', {
    headers: { Authorization: authorization, Origin: origin },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Viewer not ready')), 10000);
    probe.on('message', (data, binary) => {
      if (!binary && JSON.parse(data).type === 'viewerState') { clearTimeout(timer); resolve(); }
    });
    probe.once('error', reject);
  });
  const center = await target.locator('#control-test').boundingBox();
  for (const type of ['mousePressed', 'mouseReleased']) probe.send(JSON.stringify({ type: 'mouseEvent',
    event: { type, x: center.x + center.width / 2, y: center.y + center.height / 2, button: 'left' } }));
  // A mode acknowledgement is a barrier after the forged messages on the same socket.
  const barrier = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('No authorization barrier')), 10000);
    probe.on('message', (data, binary) => {
      if (!binary && JSON.parse(data).type === 'viewerState') { clearTimeout(timer); resolve(); }
    });
  });
  probe.send(JSON.stringify({ type: 'mode', value: 'view' }));
  await barrier;
  assert.equal(await target.evaluate(() => window.controlClicks), 0);
  probe.close();
  await new Promise(resolve => probe.once('close', resolve));
  pass('Forged raw WebSocket control messages blocked server-side in default view mode');
  viewerContext = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true,
    httpCredentials: { username: 'opencode', password: process.env.OPENCODE_PASSWORD } });
  const viewer = await viewerContext.newPage();
  await viewer.goto(origin);
  await viewer.getByRole('button', { name: 'Браузер', exact: true }).click();
  await viewer.waitForFunction(() => Number(document.querySelector('#steel-canvas')?.dataset.frames) > 0);
  pass('Original OpenCode UI with injected Browser button and genuine screencast frame at 360x780');
  await viewer.locator('#steel-full').click();
  assert.equal(await viewer.locator('#steel-panel').evaluate(el => el.classList.contains('full')), true);
  assert.ok(await viewer.locator('#steel-panel').evaluate(el => el.getBoundingClientRect().width <= innerWidth));
  pass('Mobile full-screen panel fits portrait viewport');
  const fitWidth = await viewer.locator('#steel-canvas').evaluate(el => el.getBoundingClientRect().width);
  await viewer.getByLabel('Масштаб живого экрана').selectOption('4');
  assert.ok(await viewer.locator('#steel-canvas').evaluate((el, width) => el.getBoundingClientRect().width > width * 3.8, fitWidth));
  const stage = await viewer.locator('#steel-stage').boundingBox();
  const touch = await viewerContext.newCDPSession(viewer);
  const point = { x: Math.round(stage.x + stage.width * 0.8), y: Math.round(stage.y + stage.height / 2) };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  for (let i = 1; i <= 5; i++) await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x: point.x - i * 30, y: point.y }],
  });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await viewer.waitForFunction(() => document.querySelector('#steel-stage').scrollLeft > 0);
  await touch.detach();
  await viewer.getByLabel('Масштаб живого экрана').selectOption('1');
  await viewer.locator('#steel-stage').evaluate(el => { el.scrollLeft = 0; el.scrollTop = 0; });
  pass('Viewer-only zoom and touch-pan work without resizing MCP viewport');
  async function clickRemote(selector) {
    const box = await target.locator(selector).boundingBox();
    const canvas = await viewer.locator('#steel-canvas').boundingBox();
    const viewport = await target.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await viewer.touchscreen.tap(canvas.x + (box.x + box.width / 2) * canvas.width / viewport.w,
      canvas.y + (box.y + box.height / 2) * canvas.height / viewport.h);
  }
  await clickRemote('#control-test');
  assert.equal(await target.evaluate(() => window.controlClicks), 0);
  pass('View-only touch does not control remote page');
  await viewer.locator('#steel-mode').selectOption('manual');
  await viewer.waitForFunction(() => !document.querySelector('#steel-input').disabled);
  await clickRemote('#control-test');
  await target.waitForFunction(() => window.controlClicks === 1);
  pass('Manual touch controls the exact MCP target');
  await clickRemote('#control-input');
  await viewer.locator('#steel-input').fill('Тест Android');
  await viewer.locator('#steel-input').press('Enter');
  await target.waitForFunction(() => document.querySelector('#control-input').value === 'Тест Android');
  pass('Unicode mobile text entry delivered to remote Chromium');
  const before = Number(await viewer.locator('#steel-canvas').getAttribute('data-frames'));
  // Return control to automation explicitly; manual interaction and MCP must not race.
  await viewer.locator('#steel-mode').selectOption('view');
  await viewer.waitForFunction(() => document.querySelector('#steel-input').disabled);
  if (process.env.MCP_DRIVEN === '1') {
    await target.evaluate(() => { window.awaitingMcpLiveCheck = true; });
    console.log('READY for MCP click on #control-test');
    await target.waitForFunction(() => window.controlClicks === 2, undefined, { timeout: 60000 });
  } else await target.locator('#control-test').click();
  await viewer.waitForFunction(n => Number(document.querySelector('#steel-canvas').dataset.frames) > n, before);
  pass(process.env.MCP_DRIVEN === '1' ? 'Live stream updates during real Playwright MCP click' : 'Live stream updates during automation actions');
  assert.deepEqual(await target.evaluate(() => window.fixtureWrites), []);
  pass('No Samosval fixture data writes');
  await mkdir(new URL('./test-results/', import.meta.url), { recursive: true });
  await viewer.screenshot({ path: new URL('./test-results/mobile.png', import.meta.url).pathname });
  await viewer.locator('#steel-full').click();
  assert.equal(await viewer.locator('#steel-panel').evaluate(el => el.classList.contains('full')), false);
  await viewer.locator('#steel-close').click();
  assert.equal(await viewer.locator('#steel-panel').isVisible(), false);
  pass('Return from full screen and collapse');
  const chat = '/server/local/session/ses_viewerFixture';
  const transition = async action => {
    const r = await fetch(origin + '/__browser/handoff', { method: 'POST', headers: {
      Authorization: authorization, Origin: origin, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ action, chat }) });
    assert.equal(r.status, 200);
  };
  // Synthetic URL only: do not create a paid model turn or alter an existing chat.
  await viewer.evaluate(path => history.replaceState(null, '', path), chat);
  await transition('show');
  await viewer.waitForFunction(() => !document.querySelector('#steel-panel').hidden && document.querySelector('#steel-mode').disabled);
  pass('Agent show opens live preview automatically in the bound chat');
  await transition('login');
  await viewer.locator('#steel-resume').waitFor({ state: 'visible' });
  await viewer.locator('#steel-mode').selectOption('manual');
  await viewer.waitForFunction(() => !document.querySelector('#steel-input').disabled);
  await viewer.locator('#steel-resume').click();
  await viewer.waitForFunction(() => document.querySelector('#steel-input').disabled);
  const state = await (await fetch(origin + '/__browser/handoff', { headers: { Authorization: authorization } })).json();
  assert.equal(state.phase, 'working');
  assert.equal(await viewer.locator('#steel-input').inputValue(), '');
  pass('Login handoff and explicit Continue revoke manual mode and clear local input');
  await viewer.evaluate(() => history.replaceState(null, '', '/server/local/session/ses_otherFixture'));
  await viewer.waitForFunction(() => document.querySelector('#steel-panel').hidden && document.querySelector('#steel-launch').hidden);
  pass('Preview is hidden when switching to another chat');
  await transition('finish');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; console.error(error.stack); process.exitCode = 1; }
finally {
  probe?.terminate();
  await viewerContext?.close();
  if (target) { await target.goto('about:blank'); await target.unroute('**/*'); }
  await browser.close();
  await mkdir(new URL('./test-results/', import.meta.url), { recursive: true });
  await writeFile(new URL('./test-results/report.json', import.meta.url), JSON.stringify(report, null, 2));
}
