// Протокол сообщений между страницей и service worker обязан совпадать.
// Раньше сборка переименовывала типы только в service worker (получалось
// WORKING_WORKING_TEST_PWA_*), страница их не узнавала: обновление приложения
// не применялось, состояние офлайн-копии не подтверждалось. Тест ловит это.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const swPath = path.join(root, 'sw-working-test.js');
const sw = await readFile(swPath, 'utf8');
// Страница подключает pwa.js как отдельный файл: ./working-test/src/pwa.js
const pwa = await readFile(path.join(root, 'working-test/src/pwa.js'), 'utf8');

const names = text => new Set(Array.from(text.matchAll(/WORKING_TEST_PWA_[A-Z]+/g), m => m[0]));
const swNames = names(sw);
const clientNames = names(pwa);

const failures = [];
for (const name of clientNames) if (!swNames.has(name)) failures.push('service worker не знает сообщение ' + name);
for (const name of swNames) if (!clientNames.has(name) && name !== 'WORKING_TEST_PWA_PROGRESS' && name !== 'WORKING_TEST_PWA_PRUNE') {
  failures.push('страница не отправляет сообщение ' + name);
}
if (/WORKING_WORKING/.test(sw)) failures.push('в service worker двойной префикс сообщений (WORKING_WORKING_*)');
if (!clientNames.size) failures.push('в pwa.js нет сообщений протокола');

console.log(JSON.stringify({ swNames: [...swNames], clientNames: [...clientNames] }, null, 2));
if (failures.length) { console.error('ПРОВАЛ: ' + failures.join('; ')); process.exit(1); }
console.log('OK: страница и service worker используют одни и те же сообщения');