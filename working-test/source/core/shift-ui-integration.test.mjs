import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('./', import.meta.url));
const navigation = readFileSync(here + '19-navigation.js', 'utf8');
const shell = readFileSync(new URL('../shell.html', import.meta.url), 'utf8');
const lineUi = readFileSync(here + '18-line-ui.js', 'utf8');
const style = readFileSync(new URL('../styles/style-05.css', import.meta.url), 'utf8');

test('интеграция: кнопка открывает лист, полоса стоит перед нижней навигацией', () => {
  assert.match(shell, /id="shiftManagementBtn"[^>]*onclick="openShiftManagement\(\)"/);
  assert.match(shell, /id="shiftManagementModal"/);
  assert.match(shell, /id="shiftManagementBody"/);
  assert.ok(shell.indexOf('id="shiftStrip"') < shell.indexOf('id="bottomNav"'));
  assert.match(navigation, /window\.openShiftManagement\s*=/);
  assert.match(navigation, /window\.closeShiftManagement\s*=/);
  assert.match(navigation, /Управление сменами доступно после включения канала v2/);
});

test('интеграция: без моста скрывает полосу, без v1-fallback; события v2 обновляют UI', () => {
  assert.match(navigation, /if \(!bridge \|\| !bridge\.store \|\| !bridge\.transport/);
  assert.match(navigation, /mount\.hidden = true/);
  assert.match(navigation, /samosval-working-test-shifts/);
  assert.match(navigation, /samosval-working-test-shift-snapshot/);
  assert.match(navigation, /window\.shiftStripSelect\s*=/);
  assert.match(navigation, /__wtRenderShiftStrip/);
  assert.match(lineUi, /window\.__wtRenderShiftStrip\?\.\(\)/);
  assert.doesNotMatch(navigation, /nasSaveRecord\(|startShiftWithObject\(|nasCloseCurrentShift\(/);
});

test('интеграция: горизонтальная полоса участвует в раскладке и не перекрывает карточки', () => {
  assert.match(style, /\.shift-strip\s*\{[^}]*position:\s*sticky/s);
  assert.match(style, /overflow-x:\s*auto/);
  assert.match(style, /scroll-snap-type:\s*x\s+proximity/);
  assert.match(style, /\.shift-tab\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
  assert.match(style, /scroll-snap-align:\s*start/);
});
