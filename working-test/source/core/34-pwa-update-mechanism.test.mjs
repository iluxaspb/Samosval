// Регрессия механизма обновления 1.7.16 (утверждено владельцем 17.11.2026).
// Проверяет по исходникам, без DOM и сети:
//  (а) network-first/no-cache для навигации и файла версии в service worker;
//  (б) принудительное обновление чистит кэши и перерегистрирует SW;
//  (в) версия видна на экране входа (до логина) и в настройках;
//  (г) честная ошибка при недоступности скачивания/файла версии.
// Обязан падать на коде 1.7.15 и проходить после правок 1.7.16.
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
const shell = read('working-test/source/shell.html');
const buildTool = read('tools/build-working-test.py');

test('(а) SW: файл номера версии version.json объявлен и не перехватывается из кэша', () => {
  assert.match(sw, /const VERSION_FILE = new URL\('version\.json', BASE\)\.href/,
    'нужен const VERSION_FILE = new URL(\'version.json\', BASE).href');
  assert.match(sw, /if \(url\.href === VERSION_FILE\) return;/,
    'fetch-обработчик обязан пропускать version.json мимо кэша (ранний return без respondWith)');
});

test('(а) SW: version.json не входит в RECORDS — никогда не кэшируется', () => {
  const records = sw.match(/const RECORDS = (\[[^\n]*\]);/);
  assert.ok(records, 'RECORDS не найдены');
  const urls = JSON.parse(records[1]).map(r => r.url);
  assert.ok(!urls.some(u => u.includes('version.json')),
    'version.json не должен кэшироваться: ' + urls.filter(u => u.includes('version.json')));
});

test('(а) SW: навигация обрабатывается network-first, кэш — только запасной вариант', () => {
  assert.match(sw, /event\.request\.mode === 'navigate'/,
    'fetch-обработчик обязан различать навигационные запросы (request.mode === \'navigate\')');
  assert.match(sw, /event\.respondWith\(respondNetworkFirst\(event\.request\)\)/,
    'навигация должна идти через respondNetworkFirst');
  const body = sw.slice(sw.indexOf('const respondNetworkFirst'), sw.indexOf('let completedFiles'));
  assert.match(body, /fetch\(new Request\(request,\{cache:'reload'/,
    'network-first обязан сначала идти в сеть (cache:reload)');
  assert.match(body, /cache\.match\(PAGE\)/,
    'при отсутствии сети обязан отдавать сохранённую копию страницы');
  // Порядок: сеть ПЕРВЫМ делом, кэш — только в catch.
  assert.ok(body.indexOf('fetch(new Request(request') < body.indexOf('cache.match(PAGE)'),
    'обращение к сети должно стоять раньше обращения к кэшу');
});

test('(а) страница: номер версии читается по сети из version.json в обход кэша (обе копии)', () => {
  for (const [name, pwa] of [['source', sourcePwa], ['published', buildPwa]]) {
    const body = pwa.slice(pwa.indexOf('async function publishedVersion'), pwa.indexOf('async function publishedManifest'));
    assert.ok(body.length > 100, name + ': не найдена функция publishedVersion');
    assert.match(body, /'\.\/version\.json\?cb=' \+ Date\.now\(\)/, name + ': нужен запрос version.json с cache-buster');
    assert.match(body, /cache:'no-store'/, name + ': файл версии обязан запрашиваться в обход кэша (no-store)');
    assert.match(body, /AbortSignal\.timeout\(15000\)/, name + ': у запроса версии должен быть таймаут 15 с');
  }
});

test('(б) принудительное обновление: кнопка есть в настройках (обе копии)', () => {
  for (const [name, pwa] of [['source', sourcePwa], ['published', buildPwa]]) {
    assert.match(pwa, /id="test-pwa-force"/, name + ': нужна кнопка #test-pwa-force');
    assert.match(pwa, /♻️ Принудительное обновление/, name + ': подпись кнопки «Принудительное обновление»');
    assert.match(pwa, /force\.onclick = async/, name + ': нужен обработчик кнопки');
  }
});

test('(б) принудительное обновление: сносит кэши SW и снимает регистрации (обе копии)', () => {
  for (const [name, pwa] of [['source', sourcePwa], ['published', buildPwa]]) {
    const body = pwa.slice(pwa.indexOf('force.onclick = async'), pwa.indexOf('setInterval(discoverPublishedUpdate'));
    assert.ok(body.length > 200, name + ': не найден обработчик принудительного обновления');
    assert.match(body, /caches\.keys\(\)/, name + ': нужен список кэшей');
    assert.match(body, /samosval-working-test-shell-/, name + ': чистятся только кэши своего префикса');
    assert.match(body, /caches\.delete\(key\)/, name + ': кэши обязаны удаляться');
    assert.match(body, /getRegistrations\(\)/, name + ': нужны все регистрации service worker');
    assert.match(body, /reg\.unregister\(\)/, name + ': старые SW обязаны сниматься');
    assert.match(body, /registration = null/, name + ': страница обязана забыть старую регистрацию');
    assert.match(body, /await register\(\)/, name + ': после очистки — повторная регистрация SW');
    // Данные пользователя не трогаются: ни localStorage.clear, ни indexedDB.
    assert.doesNotMatch(body, /localStorage\.clear\(/, name + ': нельзя чистить настройки пользователя');
    assert.doesNotMatch(body, /indexedDB/, name + ': нельзя трогать базы данных');
  }
});

test('(в) версия видна на экране входа — до входа, когда шапка скрыта', () => {
  const login = shell.slice(shell.indexOf('id="authOverlay"'), shell.indexOf('id="pendingScreen"'));
  assert.ok(login.length > 100, 'не найден экран входа в shell.html');
  assert.match(login, /class="version-text auth-version"/, 'на экране входа нужен видимый элемент версии (class version-text)');
  assert.match(login, /Версия: 1\.7\.22-test\.3/, 'на экране входа должен стоять номер текущей версии');
});

test('(в) версия в настройках видна всегда, а не только администратору (обе копии)', () => {
  for (const [name, pwa] of [['source', sourcePwa], ['published', buildPwa]]) {
    assert.match(pwa, /version\.hidden = false/, name + ': строка версии в настройках не должна скрываться');
    assert.doesNotMatch(pwa, /version\.hidden = !releaseAdmin/, name + ': скрытие версии по правам администратора удалено');
  }
});

test('(г) честная ошибка при сбое принудительного обновления, без вечного «обновляется»', () => {
  for (const [name, pwa] of [['source', sourcePwa], ['published', buildPwa]]) {
    const body = pwa.slice(pwa.indexOf('force.onclick = async'), pwa.indexOf('setInterval(discoverPublishedUpdate'));
    assert.match(body, /catch \(error\)/, name + ': ошибки обязаны перехватываться');
    assert.match(body, /не удалось: /, name + ': сообщение обязано называть причину');
    assert.match(body, /Попробуйте позже/, name + ': честная рекомендация «попробуйте позже»');
    assert.match(body, /finally/, name + ': блокировка кнопки обязана сниматься в finally');
  }
});

test('(г) сбой скачивания сборки заканчивается ошибкой с таймаутом, а не зависанием', () => {
  assert.match(sourcePwa, /90000/, 'дедлайн ожидания сборки 90 с');
  assert.match(sourcePwa, /120000/, 'общий предел скачивания 120 с');
  assert.match(sourcePwa, /Обновление не установлено: /, 'честное сообщение о неудаче установки');
  assert.match(sw, /240000/, 'дедлайн установки SW 240 с');
});

test('сборщик: лёгкий файл номера версии version.json генерируется с полями version и build', () => {
  assert.match(buildTool, /'version\.json'/, 'сборщик обязан писать version.json в корень');
  const line = buildTool.slice(buildTool.indexOf('version.json')).slice(0, 400);
  assert.match(line, /'version':\s*release/, 'в version.json должно попасть поле version (версия приложения)');
  assert.match(line, /'build':\s*build_id/, 'в version.json должно попасть поле build (16 hex)');
});

console.log('OK: механизм обновления 1.7.16 (network-first, version.json, принудительное обновление, версия на входе) проверен');
