'use strict';
// Regression: photokontrol (AiPhotoProtocol) and CAD elevation disclaimer.
// Reads the SOURCE file directly (build is intentionally not required), so it
// verifies the exact edited code under test, not a stale build.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../../');
const SRC = path.join(ROOT, 'test-app/source/features/ai-copilot.js');
const source = fs.readFileSync(SRC, 'utf8');

const REL_HIST = path.join(ROOT, 'test-app/source/features/release-history.js');
const history = fs.readFileSync(REL_HIST, 'utf8');

// ---------------------------------------------------------------------------
// Extract the AiPhotoProtocol object as-is and run it in an isolated sandbox.
// ---------------------------------------------------------------------------
function extractAiPhotoProtocol() {
  const startMarker = 'const AiPhotoProtocol = {';
  const endMarker = '// 11. DWG / DXF';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start !== -1 && end !== -1, 'AiPhotoProtocol block must be found in source');
  const block = source.slice(start, end).replace(/\n\s*\/\/ ===+[\s\S]*$/, '');
  return block;
}

function makeSandbox() {
  const calls = { toasts: [], opens: 0, renders: 0, saved: 0, inputClicked: 0, inputValueSets: 0 };
  const store = {};
  const hiddenInput = { id: 'aiHiddenCameraInput', value: '', click: () => { calls.inputClicked += 1; } };
  const getEl = (id) => (id === 'aiHiddenCameraInput' ? hiddenInput : null);
  const sandbox = {
    AiCopilotUI: { renderShiftBanner: () => { calls.renders += 1; } }, // bare name, as referenced in source
    window: {
      open: () => { calls.opens += 1; },
      AiCopilotUI: { renderShiftBanner: () => { calls.renders += 1; } },
      addEventListener: () => {}
    },
    document: {
      readyState: 'loading', // do not auto-mount
      getElementById: getEl,
      addEventListener: () => {},
      createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {} }),
      body: { appendChild: () => {}, },
      querySelectorAll: () => []
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; calls.saved += 1; },
      removeItem: (k) => { delete store[k]; }
    },
    navigator: { onLine: true },
    FileReader: function () { this.readAsText = () => {}; },
    showToastEl: (msg) => calls.toasts.push(msg),
    setInterval: () => 0,
    clearInterval: () => {},
    Date,
    JSON,
    Math,
    Number,
    RegExp,
    calls,
    __hiddenInput: hiddenInput
  };
  sandbox.globalThis = sandbox;
  return { sandbox, calls, store, hiddenInput };
}

function loadAiPhotoProtocol() {
  const { sandbox, calls, store, hiddenInput } = makeSandbox();
  const block = extractAiPhotoProtocol();
  const code = block + '\n;protocolResult = AiPhotoProtocol;';
  sandbox.protocolResult = null;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'ai-copilot.js[photo]' });
  assert.ok(sandbox.protocolResult, 'AiPhotoProtocol must be evaluable');
  return { proto: sandbox.protocolResult, calls, store, hiddenInput };
}

// helper: real file-like object
const makeFile = (size) => ({ size, type: 'image/jpeg', name: 'photo.jpg' });
const cancelEvent = () => ({ target: { files: [] } });
const fileEvent = (size = 4096) => ({ target: { files: [makeFile(size)] } });

function fresh() {
  const t = loadAiPhotoProtocol();
  t.proto.completedSteps = {};
  t.proto.appType = 'camera_native';
  t.proto.customAppUrl = '';
  t.proto.pendingPhotoId = null;
  return t;
}
(async () => {
  // 1) Cancel: no file -> step NOT counted, nothing persisted.
  {
    const { proto, calls } = fresh();
    proto.triggerTakePhoto('1');
    proto.onFileCaptured(cancelEvent());
    assert.equal(proto.completedSteps['1'], undefined, 'Cancel must NOT count a step');
    assert.deepEqual(Object.keys(proto.completedSteps), [], 'No completed steps after cancel');
    assert.ok(calls.toasts.some(t => /отмен|засчитывается|выбора фото/.test(t.toLowerCase()) || /Откройте камеру/.test(t)),
      'Cancel path keeps honest guidance toast');
    console.log('PASS: cancel does not count step');
  }

  // 2) Successful native capture counts exactly the awaited step.
  {
    const { proto, calls, store } = fresh();
    proto.triggerTakePhoto('2');
    assert.equal(proto.pendingPhotoId, '2', 'Native capture awaits step 2');
    proto.onFileCaptured(fileEvent());
    assert.equal(proto.completedSteps['2'] && proto.completedSteps['2'].ts > 0, true, 'Step 2 counted after real file');
    assert.equal(proto.pendingPhotoId, null, 'pending cleared after capture');
    assert.ok(calls.renders > 0, 'Shift banner re-rendered after completion');
    assert.ok(calls.saved > 0 || store['samosval_ai_photo_v1'], 'Progress persisted');
    assert.equal(calls.toasts.some(t => /Шаг #2/.test(t)), true, 'Honest progress toast');
    assert.ok(calls.toasts.every(t => !/успешно сохранено/.test(t)), 'No false "file saved" promise');
    console.log('PASS: successful native capture counts step and persists');
  }

  // 3) No hidden input present -> does not throw, pending cleared, no click.
  {
    const { sandbox } = makeSandbox();
    sandbox.document.getElementById = () => null;
    const block = extractAiPhotoProtocol();
    sandbox.protocolResult = null;
    vm.createContext(sandbox);
    vm.runInContext(block + '\n;protocolResult = AiPhotoProtocol;', sandbox);
    const p = sandbox.protocolResult;
    p.completedSteps = {}; p.appType = 'camera_native'; p.customAppUrl = ''; p.pendingPhotoId = null;
    assert.doesNotThrow(() => p.triggerTakePhoto('3'), 'No input must not throw');
    assert.equal(p.pendingPhotoId, null, 'pending cleared when no input present');
    assert.equal(sandbox.calls.inputClicked, 0, 'no input -> camera not triggered');
    console.log('PASS: no hidden input -> pending cleared, no throw');
  }

  // 3b) Input present clears value before click (repeat-select same file re-fires change)
  {
    const { proto, calls, hiddenInput } = fresh();
    hiddenInput.value = 'old.jpg';
    proto.triggerTakePhoto('2');
    assert.equal(hiddenInput.value, '', 'input.value reset before capture dialog');
    assert.equal(calls.inputClicked, 1, 'camera input clicked exactly once');
    // After processing file, target value cleared again.
    const evt = { target: { files: [{ size: 1, name: 'x.jpg' }], value: 'old.jpg' } };
    proto.onFileCaptured(evt);
    assert.equal(evt.target.value, '', 'input.value cleared after file processed');
    console.log('PASS: input.value reset before/after, repeat select works');
  }

  // 3c) onFileCaptured without a valid pending id must NOT count an arbitrary step
  {
    const { proto, calls } = fresh();
    proto.onFileCaptured(fileEvent()); // no pendingPhotoId set
    assert.deepEqual(Object.keys(proto.completedSteps), [], 'no pending -> no arbitrary step counted');
    // descending completion must not be fabricating next step
    proto.onFileCaptured(fileEvent());
    assert.deepEqual(Object.keys(proto.completedSteps), [], 'still no step counted without valid pending');
    assert.ok(calls.toasts.every(t => !/Шаг #/.test(t)), 'no completion toast without valid pending');
    console.log('PASS: onFileCaptured without pending does not invent a step');
  }

  // 3d) cancel clears the pending id
  {
    const { proto } = fresh();
    proto.triggerTakePhoto('3');
    assert.equal(proto.pendingPhotoId, '3', 'pending set before cancel');
    proto.onFileCaptured(cancelEvent());
    assert.equal(proto.pendingPhotoId, null, 'cancel clears pending id');
    assert.deepEqual(Object.keys(proto.completedSteps), [], 'cancel counts nothing');
    console.log('PASS: cancel clears pending id');
  }

  // 4) External custom app: not counted automatically, opens app, honest toast.
  {
    const { proto, calls } = fresh();
    proto.appType = 'app_custom';
    proto.customAppUrl = 'https://example.com/cam';
    proto.triggerTakePhoto('4');
    assert.deepEqual(Object.keys(proto.completedSteps), [], 'External app must NOT auto-count');
    assert.equal(calls.opens, 1, 'External app opened');
    assert.equal(proto.pendingPhotoId, null, 'external app clears pending id');
    const externalToast = calls.toasts.join(' ');
    assert.ok(!/зарегистрирует факт|повторное нажатие.*зарегистрирует/.test(externalToast),
      'external toast must NOT promise a non-existent registration on repeat click');
    assert.ok(/не засчитывается|не передаёт подтверждение/.test(externalToast),
      'Honest toast states no confirmation -> not counted');
    // Simulate returning without any confirmation mechanism: still not counted.
    proto.onFileCaptured(cancelEvent());
    assert.deepEqual(Object.keys(proto.completedSteps), [], 'Cancel after external app still not counted');
    console.log('PASS: external custom app honest, pending cleared, no false promise');
  }

  // 5) Repeated click: awaiting step overwritten, only last counts after one file.
  {
    const { proto } = fresh();
    proto.triggerTakePhoto('2');
    proto.triggerTakePhoto('3');
    assert.equal(proto.pendingPhotoId, '3', 'Last awaited step wins on repeated click');
    proto.onFileCaptured(fileEvent());
    assert.equal(proto.completedSteps['2'], undefined, 'Earlier awaited step not counted');
    assert.equal(proto.completedSteps['3'] && proto.completedSteps['3'].ts > 0, true, 'Last step counted');
    console.log('PASS: repeated click counts only the final awaited step');
  }

  // 6) preserve prior progress (already completed steps remain) on new captures
  {
    const { proto } = fresh();
    proto.completedSteps['1'] = { ts: 111, timeStr: 'x' };
    proto.triggerTakePhoto('2');
    proto.onFileCaptured(fileEvent());
    assert.ok(proto.completedSteps['1'], 'Previously completed step preserved');
    assert.ok(proto.completedSteps['2'], 'New step added');
    console.log('PASS: prior progress preserved');
  }

  // 7) getProgress reflects honest state after cancel
  {
    const { proto } = fresh();
    proto.triggerTakePhoto('1');
    proto.onFileCaptured(cancelEvent());
    const p = proto.getProgress();
    assert.equal(p.count, 0, 'Progress count stays 0 after cancel');
    assert.equal(p.isCompleted, false);
    console.log('PASS: getProgress honest after cancel');
  }

  // -------------------------------------------------------------------------
  // CAD elevation disclaimer regression (source text level)
  // -------------------------------------------------------------------------
  {
    assert.ok(/Высотный профиль расчётный/.test(source), 'CAD disclaimer heading present');
    // The disclaimer must apply to ANY imported format, not nested in isBinaryDwg only...
    const disclaimStart = source.indexOf('Высотный профиль расчётный');
    const dwgBlockStart = source.indexOf("data.cadFileData?.isBinaryDwg ?");
    // The disclaimer must appear BEFORE the isBinaryDwg-only block references.
    const renderStart = source.indexOf('    renderCadUI(locRes) {');
    const afterRender = source.slice(renderStart);
    const disclaimInRender = afterRender.indexOf('Высотный профиль расчётный');
    const dwgInRender = afterRender.indexOf('isBinaryDwg ?');
    assert.ok(disclaimInRender !== -1, 'disclaimer inside renderCadUI');
    // To prove it is NOT gated to DWG: it should sit before the DWG-only ternary and
    // be guarded by generic "cadFileData" (any format).
    assert.ok(disclaimInRender < dwgInRender || dwgInRender === -1,
      'profile disclaimer is generic, not DWG-only');
    assert.ok(/data\.cadFileData \? `/.test(afterRender.slice(0, dwgInRender === -1 ? afterRender.length : dwgInRender)),
      'disclaimer shown for any cadFileData');
    console.log('PASS: CAD elevation disclaimer shown for any format');
  }

  // -------------------------------------------------------------------------
  // release-history 4.2.0 honesty regression
  // -------------------------------------------------------------------------
  {
    assert.ok(/version[ \t]*:[ \t]*'4\.2\.0'/.test(history), 'First release still 4.2.0');
    const first = history.slice(history.indexOf("version: '4.2.0'"), history.indexOf('{version', history.indexOf("version: '4.2.0'") + 1));
    assert.ok(/отмена камеры/.test(first), 'release-history mentions camera cancel fix');
    assert.ok(/на сервер не производится/.test(first), 'release-history honest: no server upload');
    console.log('PASS: release-history 4.2.0 honest description');
  }

  console.log('\nALL PHOTO/CAD REGRESSION ASSERTIONS PASSED 🎉');
})().catch(err => {
  console.error('[Test Failed]', err);
  process.exit(1);
});
