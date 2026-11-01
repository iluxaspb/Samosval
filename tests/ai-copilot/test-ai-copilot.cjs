'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../../');
const pw = require(path.join(ROOT, 'tools/steel-live-view/node_modules/playwright-core'));

// Static file server for testing index-test.html
const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index-test.html';
  const filePath = path.join(ROOT, reqPath.slice(1));
  try {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    const ext = path.extname(filePath);
    const mimeMap = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.webmanifest': 'application/manifest+json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end(e.message);
  }
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`[Test Server] listening on http://127.0.0.1:${port}`);

  const browserPath = '/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
  const browser = await pw.chromium.launch({
    headless: true,
    executablePath: browserPath,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage({ viewport: { width: 412, height: 915 } }); // Standard Android viewport
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    console.log('[Test] Navigating to index-test.html...');
    await page.goto(`http://127.0.0.1:${port}/index-test.html`, { waitUntil: 'domcontentloaded' });

    // Verify AI Copilot components are present in DOM
    console.log('[Test] Checking AI Floating Button...');
    const floatBtn = page.locator('#aiFloatingBtn');
    await floatBtn.waitFor({ state: 'attached', timeout: 5000 });
    assert.equal(await floatBtn.isVisible(), true, 'AI Floating button must be visible');

    // Click floating button to open modal
    console.log('[Test] Clicking AI Floating Button...');
    await floatBtn.click();
    const modal = page.locator('#aiCopilotModal');
    await modal.waitFor({ state: 'visible', timeout: 3000 });
    assert.equal(await modal.isVisible(), true, 'AI Modal must open on click');

    // Check tabs
    const tabs = page.locator('.ai-tab-btn');
    assert.equal(await tabs.count(), 4, 'Must have 4 tabs: Simulator, Model, Voice, Feedback');

    // Test Tab 2: Model
    console.log('[Test] Switching to Model tab...');
    await page.locator('.ai-tab-btn[data-ai-tab="model"]').click();
    assert.equal(await page.locator('#aiTabModel').isVisible(), true);
    const modelStatsText = await page.locator('#aiModelStats').innerText();
    console.log('[Test] Model Stats output:\n', modelStatsText.trim());

    // Test Tab 4: Feedback & Prompt Generator
    console.log('[Test] Switching to Feedback tab...');
    await page.locator('.ai-tab-btn[data-ai-tab="feedback"]').click();
    assert.equal(await page.locator('#aiTabFeedback').isVisible(), true);

    const feedbackInput = page.locator('#aiFeedbackTextInput');
    await feedbackInput.fill('Кнопка погрузки слишком чувствительная при тряске на морозе');
    await page.locator('button:has-text("Добавить")').click();

    const userFeedbackText = await page.locator('#aiUserFeedbackList').innerText();
    assert.match(userFeedbackText, /слишком чувствительная/, 'Feedback must appear in list');
    console.log('[Test] Recorded user feedback successfully!');

    // Test Prompt Generation
    const prompt = await page.evaluate(() => window.AiFeedbackCollector.generatePromptForAiDeveloper());
    assert.match(prompt, /Техническое задание для ИИ-разработчика/, 'Generated prompt header match');
    assert.match(prompt, /слишком чувствительная/, 'Generated prompt contains user note');
    console.log('[Test] Generated AI Developer Prompt snippet:\n', prompt.slice(0, 320) + '...\n');

    // Test Tab 1: Simulator
    console.log('[Test] Switching back to Simulator tab...');
    await page.locator('.ai-tab-btn[data-ai-tab="simulator"]').click();
    assert.equal(await page.locator('#aiTabSimulator').isVisible(), true);

    // Test simulation speed setting
    await page.locator('.ai-speed-btn[data-speed="60"]').click();
    const simSpeedActive = await page.locator('.ai-speed-btn[data-speed="60"]').getAttribute('class');
    assert.match(simSpeedActive, /active/, 'Speed 60x should be active');

    // Test AI local mathematical learner directly in page evaluate
    console.log('[Test] Testing AiLocalLearner on-device training & prediction...');
    const predictionTest = await page.evaluate(() => {
      // Simulate recording loads for a truck
      window.AiLocalLearner.recordLoad('truck_test_1', 22, 'Гранулят', 30 * 60000);
      window.AiLocalLearner.recordLoad('truck_test_1', 22, 'Гранулят', 32 * 60000);
      window.AiLocalLearner.recordLoad('truck_test_1', 20, 'Щебень', 28 * 60000);
      return window.AiLocalLearner.predict('truck_test_1');
    });

    console.log('[Test] Learner Prediction for truck_test_1:', predictionTest);
    assert.equal(predictionTest.predictedVol, 22, 'Expected most frequent volume 22');
    assert.equal(predictionTest.predictedMaterial, 'Гранулят', 'Expected most frequent material Гранулят');
    assert.equal(predictionTest.predictedMins, 30, 'Expected average trip duration 30 mins');
    assert.equal(predictionTest.confidence >= 66, true, 'Confidence should reflect frequency');

    console.log('[Test] ALL ASSERTIONS PASSED! 🎉');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(err => {
  console.error('[Test Failed]', err);
  process.exit(1);
});
