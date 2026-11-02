import test from 'node:test';
import assert from 'node:assert/strict';
// Регрессия экстракции версии release из test-app/source/features/*.
// Повторяет VERSION_FIELD из tools/verify-test-modules.py: до выпуска audit
// находил первую версию записью version:'X' (без пробела). Первая запись в
// release-history.js пишется как version: '4.2.0' (с пробелом), поэтому прежний
// regex пропускал её и возвращал следующую version:'4.1.6'. Тест закрепляет,
// что первая запись (и её версия) никогда не маскируется следующей.
const VERSION_FIELD = /version[ \t]*:[ \t]*'([^']+)'/g;
const firstVersion = text => {
  VERSION_FIELD.lastIndex = 0;
  const found = VERSION_FIELD.exec(text);
  return found ? found[1] : null;
};
const spacedFirst = `const releases=[
  { version: '4.2.0', title:'X', items:[1] },
  {version:'4.1.6',title:'Y',items:[2]},
  {version:'4.1.5',title:'Z',items:[3]}
];`;
const compactAll = `const releases=[
  {version:'4.2.0',title:'X',items:[1]},
  {version:'4.1.6',title:'Y',items:[2]}
];`;
const wrongFirst = `const releases=[
  { version: '4.1.9', title:'старая, отстающая', items:[0] },
  {version:'4.1.6',title:'следующая',items:[2]}
];`;

test('spaced first record must win over compact older records', () => {
  assert.equal(firstVersion(spacedFirst), '4.2.0');
});
test('compact first record still wins', () => {
  assert.equal(firstVersion(compactAll), '4.2.0');
});
test('a wrong leading version is never hidden by the next record', () => {
  // Если первая запись не равна релизу — экстракция обязана вернуть именно её,
  // а не молча перепрыгнуть на более новую следующую запись (как делал прежний regex).
  assert.equal(firstVersion(wrongFirst), '4.1.9');
});
