const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const MANIFEST = JSON.parse(fs.readFileSync(ROOT + '/test-app/build-manifest.json', 'utf8'));
const BUILD_ASSET = MANIFEST.assets.find(asset => /^\.\/test-app\/build\/[^/]+\/core\.js$/.test(asset.url));
assert(BUILD_ASSET, 'build manifest must contain the core build asset');
const BUILD_DIR = ROOT + '/' + BUILD_ASSET.url.slice(0, BUILD_ASSET.url.lastIndexOf('/'));

function readAllBuildFiles(exclude = []) {
  const files = fs.readdirSync(BUILD_DIR).filter(f => f.endsWith('.js') && !exclude.includes(f));
  let content = '';
  for (const file of files) {
    content += fs.readFileSync(path.join(BUILD_DIR, file), 'utf8');
  }
  return content;
}

// Check all built JS except release-history.js (historical, not user-facing UI)
const ALL_BUILD_CONTENT = readAllBuildFiles(['release-history.js']);

const forbidden = [
  'на Synology',
  'на сервере Synology',
  'очередь Synology',
  'очереди Synology',
  'Служба управления Synology',
  'центр управления доступен в тестовой версии Synology',
  'TEST · Synology',
  'Бэкап создан на Synology',
  'Копия сохранится на Synology',
  'Восстановлено на Synology',
  'Изменение сохранено на Synology',
  'Нужно соединение с Synology',
  'Не удалось прочитать очередь Synology',
  'Сеанс Synology изменился',
  'Требуется администратор Synology',
  'Обновите настройки Synology',
  'Пользователь создан на Synology',
  'Смена восстановлена на Synology',
  'Для изменения доступа нужен администратор и соединение с Synology',
];

console.log('Checking built TEST modules (excl. release-history.js) for forbidden Synology labels...');
let hasFailures = false;
for (const label of forbidden) {
  if (ALL_BUILD_CONTENT.includes(label)) {
    console.error(`FAIL: Found forbidden label: "${label}"`);
    hasFailures = true;
  } else {
    console.log(`  OK: "${label}" not found`);
  }
}

const required = [
  'samosval-test.iluxa.pro',
  'UBUNTU_API_BASE',
  'ubuntu-candidate',
  'на Ubuntu',
  'очередь Ubuntu',
  'TEST · Ubuntu',
  'на сервере Ubuntu',
  'Бэкап создан на Ubuntu',
  'Копия сохранится на Ubuntu',
  'Восстановлено на Ubuntu',
  'Изменение сохранено на Ubuntu',
  'Нужно соединение с Ubuntu',
  'Не удалось прочитать очередь Ubuntu',
  'Сеанс Ubuntu изменился',
  'Требуется администратор Ubuntu',
  'Обновите настройки Ubuntu',
  'Пользователь создан на Ubuntu',
  'Смена восстановлена на Ubuntu',
  'Для изменения доступа нужен администратор и соединение с Ubuntu',
];

console.log('\nChecking for required Ubuntu labels...');
for (const label of required) {
  if (ALL_BUILD_CONTENT.includes(label)) {
    console.log(`  OK: "${label}" found`);
  } else {
    console.error(`FAIL: Missing required label: "${label}"`);
    hasFailures = true;
  }
}

console.log('\nChecking that "В очереди" (genitive) is present in Ubuntu context...');
if (ALL_BUILD_CONTENT.includes('В очереди') && ALL_BUILD_CONTENT.includes('Ubuntu')) {
  console.log('  OK: "В очереди" present with Ubuntu context');
} else {
  console.error('FAIL: "В очереди" not found in Ubuntu context');
  hasFailures = true;
}

if (hasFailures) {
  console.error('\n❌ Some checks failed');
  process.exitCode = 1;
} else {
  console.log('\n✅ All checks passed!');
}