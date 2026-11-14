// Регрессионный тест (1.7.10): Firebase SDK не загружается в рабочей версии.
// Раньше shell.html грузил vendor/firebase-*-compat-10.8.0.js, а
// 00-config-state.js безусловно вызывал firebase.initializeApp(...) и
// db.enablePersistence(...) — в логе владельца это давало
// «Firestore 10.8.0 multi-tab persistence» на телефоне.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(here, '..');
const root = path.resolve(sourceDir, '../..');

test('shell.html не грузит Firebase SDK', () => {
  const shell = readFileSync(path.join(sourceDir, 'shell.html'), 'utf8');
  const scriptMatches = shell.match(/<script[^>]+src="[^"]*firebase[^"]*"/gi) || [];
  assert.deepEqual(scriptMatches, [], 'в shell.html не должно быть firebase-скриптов: ' + scriptMatches.join(', '));
  assert.ok(!shell.includes('firebase-app-compat'), 'vendor/firebase-app-compat не должен подключаться');
  assert.ok(!shell.includes('firebase-auth-compat'), 'vendor/firebase-auth-compat не должен подключаться');
  assert.ok(!shell.includes('firebase-firestore-compat'), 'vendor/firebase-firestore-compat не должен подключаться');
});

test('собранный вход (если есть) не грузит Firebase SDK', () => {
  const built = path.join(root, 'index-working-test.html');
  if (!existsSync(built)) return; // сборки ещё нет — проверяем только исходник
  const html = readFileSync(built, 'utf8');
  // Модули телеметрии трафика firebase-traffic-*.js не являются SDK:
  // они не ждут объект firebase (B3), поэтому исключаем их из проверки.
  const scriptMatches = (html.match(/<script[^>]+src="[^"]*firebase[^"]*"/gi) || [])
    .filter(tag => !/firebase-traffic-(hook|inference|dashboard)/.test(tag));
  assert.deepEqual(scriptMatches, [], 'в собранном index-working-test.html не должно быть firebase-скриптов');
});

test('00-config-state.js не инициализирует Firebase безусловно', () => {
  const config = readFileSync(path.join(sourceDir, 'core/00-config-state.js'), 'utf8');
  const initPattern = /firebase\s*\.\s*initializeApp\s*\(/;
  assert.ok(!initPattern.test(config), 'безусловный firebase.initializeApp(...) удалён');
  assert.ok(!/enablePersistence\s*\(/.test(config), 'db.enablePersistence(...) удалён');
  assert.ok(!/workingFirebaseApp\.auth\s*\(/.test(config), 'auth больше не берётся из Firebase-приложения');
});

test('обращения firebase.* в активном коде — только за флагом SDK', () => {
  const files = [
    'core/04-subscriptions.js',
    'core/19-navigation.js',
    'core/15-shifts.js',
    'features/auto-backup.js'
  ];
  for (const rel of files) {
    const text = readFileSync(path.join(sourceDir, rel), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!/firebase\.firestore\.|firebase\.app\s*\(/.test(line)) return;
      // Упоминание допустимо только под защитой флага FIREBASE_SDK_PRESENT.
      assert.ok(
        line.includes('FIREBASE_SDK_PRESENT') || text.includes('FIREBASE_SDK_PRESENT && typeof firebase'),
        `${rel}:${i + 1} обращение к firebase.* без защиты FIREBASE_SDK_PRESENT: ${line.trim().slice(0, 100)}`
      );
    });
  }
});

test('firebaseConfig остаётся для localStorage-ключей (projectId)', () => {
  const config = readFileSync(path.join(sourceDir, 'core/00-config-state.js'), 'utf8');
  assert.ok(/const firebaseConfig/.test(config), 'firebaseConfig объявлен');
  assert.ok(/projectId:\s*"samosval-test"/.test(config), 'projectId сохранён для ключей хранилища');
});

test('modules.json не содержит встроенных патчей', () => {
  const modules = JSON.parse(readFileSync(path.join(sourceDir, '..', 'modules.json'), 'utf8'));
  const names = modules.modules.map(m => m.name);
  assert.ok(!names.includes('built-in-patches'), 'модуль built-in-patches удалён');
});
