// Контракт починки «зависшего» обновления working-test (1.6.3).
// Проверяется по файлам исходников без DOM и сети: таймауты и дедлайн в
// service worker, приём полного воркера по фактической версии в обеих копиях
// pwa.js, синхронность двух копий pwa.js и рабочая страница восстановления.
// Обязан падать на старых файлах и проходить после правок.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const read = rel => readFileSync(path.join(root, rel), 'utf8');

const sw = read('working-test/source/service-worker.js');
const sourcePwa = read('working-test/source/src/pwa.js');
const buildPwa = read('working-test/src/pwa.js');
const recovery = read('update-working-test.html');

// Тело waitForVerifiedBuild берём отдельно: в файле есть и другие функции,
// где сверка version === expected (например, waitForActivation) — они остаются.
const waitBody = text => {
  const match = text.match(/function\s+waitForVerifiedBuild\s*\([^)]*\)\s*\{([\s\S]*?)\n {2}\}/);
  assert.ok(match, 'не найдена функция waitForVerifiedBuild');
  return match[1];
};

test('service worker: запрос на скачивание с таймаутом и повторами', () => {
  assert.match(sw, /AbortController/, 'нужен AbortController для отмены запроса');
  assert.match(sw, /fetchWithTimeout/, 'нужна функция fetchWithTimeout');
  assert.match(sw, /30000/, 'нужен таймаут запроса 30 с');
  assert.match(sw, /400\s*\*\s*\(?attempt/, 'нужна пауза 400*attempt между попытками');
});

test('service worker: общий дедлайн установки заканчивается ошибкой, а не зависанием', () => {
  assert.match(sw, /240000/, 'нужен общий дедлайн установки 240 с');
  assert.match(sw, /Promise\.race/, 'нужен Promise.race между работой установки и таймером');
  assert.match(sw, /caches\.delete\(CACHE\)/, 'при сбое установки неполный кэш обязан удаляться');
});

test('waitForVerifiedBuild принимает полный воркер по фактической версии (обе копии)', () => {
  for (const pwa of [sourcePwa, buildPwa]) {
    const body = waitBody(pwa);
    assert.match(body, /complete\s*===\s*true/, 'воркер признаётся готовым по complete');
    assert.match(body, /return\s*\{worker:\s*ready,\s*version:\s*result\.version\}/,
      'нужно возвращать {worker, version} с фактической версией воркера');
    assert.match(body, /return\s*\{worker:\s*null,\s*version:\s*result\.version\}/,
      'активный полный воркер возвращается как worker:null с фактической версией');
    assert.doesNotMatch(body, /result\?\.version\s*===\s*expected/,
      'нельзя ждать версию из устаревшего манифеста (expected)');
  }
});

test('обе копии pwa.js совпадают после замены префикса WORKING_TEST_PWA_ на TEST_PWA_', () => {
  const normalized = buildPwa.replaceAll('WORKING_TEST_PWA_', 'TEST_PWA_');
  assert.equal(normalized, sourcePwa,
    'файлы различаются не только префиксом сообщений: ' +
    'working-test/src/pwa.js против working-test/source/src/pwa.js');
});

test('страница восстановления: свой манифест, свои сообщения, без чужого манифеста', () => {
  assert.ok(recovery.includes('./working-test/build-manifest.json'),
    'нужен ./working-test/build-manifest.json');
  assert.ok(recovery.includes('WORKING_TEST_PWA_STATUS'),
    'нужно сообщение WORKING_TEST_PWA_STATUS');
  assert.ok(recovery.includes('WORKING_TEST_PWA_APPLY'),
    'нужно сообщение WORKING_TEST_PWA_APPLY');
  const staleManifestRef = ['test-app', 'build-manifest.json'].join('/');
  assert.ok(!recovery.includes(staleManifestRef),
    'страница восстановления не должна ссылаться на устаревший служебный манифест');
});

console.log('OK: контракт обновления working-test 1.6.3 соблюдён');