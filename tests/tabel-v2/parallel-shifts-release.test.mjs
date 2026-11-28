import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// Выпуск 1.10.0: канал включает параллельные смены (v2). Проверка держит
// вместе четыре вещи, которые раньше расходились по отдельности:
//   1. один номер версии в шапке (meta + два видимых места), в модуле релиза
//      и первой записи истории;
//   2. флаг v2 включён по умолчанию и по-прежнему не перезаписывает заранее
//      заданное значение (стенд может выключить его через window);
//   3. клиент говорит с сервером по protocolVersion 2;
//   4. собранная страница ссылается на существующую сборку, а её manifest
//      описывает ровно эту версию.
// Сам выпуск дополнительно проверяет tools/verify-working-test.py (SHA-256
// каждого ресурса, service worker, отсутствие production-файлов в diff).

const here = new URL('../..', import.meta.url);
const source = path => readFileSync(new URL('working-test/source/' + path, here), 'utf8');

const shell = source('shell.html');
const release = source('features/working-test-release.js');
const history = source('features/release-history.js');

function versionOf(text, pattern) {
  const found = pattern.exec(text);
  return found ? found[1] : null;
}

const metaVersion = versionOf(shell, /<meta name="working-test-version" content="([^"]+)"/);
const authVersion = versionOf(shell, /id="authVersionText">Версия: ([0-9.]+)</);
const headerVersion = versionOf(shell, /<span class="version-text" title="История изменений">Версия: ([0-9.]+)</);
const moduleVersion = versionOf(release, /version:'([^']+)'/);
const firstHistoryVersion = versionOf(history, /\{version:'([^']+)'/);

test('номер версии канала совпадает во всех источниках', () => {
  assert.ok(metaVersion, 'в shell.html есть meta working-test-version');
  assert.equal(authVersion, metaVersion, 'видимый номер на экране входа');
  assert.equal(headerVersion, metaVersion, 'видимый номер в шапке приложения');
  assert.equal(moduleVersion, metaVersion, 'модуль релиза канала');
  assert.equal(firstHistoryVersion, metaVersion, 'первая запись истории изменений');
  const releasesText = history.slice(history.indexOf('const releases=['));
  const entries = releasesText.match(new RegExp(`\\{version:'${metaVersion.replaceAll('.', '\\.')}'`, 'g')) || [];
  assert.equal(entries.length, 1, 'запись текущей версии в истории ровно одна');
});

test('первая запись истории объясняет включение параллельных смен простым языком', () => {
  const first = history.slice(history.indexOf("{version:'" + metaVersion + "'"));
  assert.match(first.slice(0, 2000), /параллельн/i, 'в записи сказано про параллельные смены');
  assert.match(first.slice(0, 2000), /перевод/i, 'и про перевод самосвала между сменами');
  assert.doesNotMatch(first.slice(0, 2000), /\b(409|CAS|payload|ревизи)/i, 'без технического жаргона в тексте для администратора');
});

test('канал включает v2 по умолчанию и не перезаписывает заданное значение', () => {
  assert.match(shell, /if \(typeof window\.WORKING_TEST_V2_SHIFTS === 'undefined'\) window\.WORKING_TEST_V2_SHIFTS = true;/);
  assert.doesNotMatch(shell, /WORKING_TEST_V2_SHIFTS[^\n]*(localStorage|URLSearchParams)/,
    'переключателя через адрес страницы или localStorage нет');
});

test('клиент и сервер говорят по protocolVersion 2', () => {
  assert.match(source('core/41-v2-transport.js'), /const PROTOCOL_VERSION = 2;/);
  assert.match(source('core/42-offline-v2.js'), /protocolVersion:2|protocolVersion: 2/);
});

test('собранная страница ссылается на существующую сборку этой версии', () => {
  const page = readFileSync(new URL('index-working-test.html', here), 'utf8');
  assert.match(page, new RegExp(`<meta name="working-test-version" content="${metaVersion.replaceAll('.', '\\.')}">`));
  const build = versionOf(page, /working-test\/build\/([a-z0-9]+)/);
  assert.ok(build, 'страница ссылается на каталог сборки');
  const directory = new URL('working-test/build/' + build + '/', here);
  assert.ok(existsSync(directory), 'каталог сборки существует: ' + build);
  const manifest = JSON.parse(readFileSync(new URL('working-test/build-manifest.json', here), 'utf8'));
  assert.match(manifest.channel, /^working-/, 'manifest собран для канала working-test');
  assert.ok(Array.isArray(manifest.assets) && manifest.assets.length > 0, 'manifest перечисляет ресурсы сборки');
});
