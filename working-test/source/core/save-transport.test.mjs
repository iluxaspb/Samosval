// Регрессионный тест единого транспорта сохранения (18-line-ui.js).
// Шаблон «if(isNasRuntime()){...}else{firebase-ветка}» в функциях сохранения
// заменён одной точкой ветвления saveLineEvent(...); мёртвые firebase-ветки
// удалены. Запуск: node --test working-test/source/core/save-transport.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const lineUi = readFileSync(join(here, '18-line-ui.js'), 'utf8');

function functionBody(name) {
  const start = lineUi.indexOf('function ' + name);
  assert.ok(start >= 0, 'нет функции ' + name);
  let depth = 0, i = lineUi.indexOf('{', start), end = i;
  for (; i < lineUi.length; i++) {
    if (lineUi[i] === '{') depth++;
    else if (lineUi[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  return lineUi.slice(start, end);
}

test('есть единая точка ветвления saveLineEvent', () => {
  const body = functionBody('saveLineEvent');
  assert.match(body, /isNasRuntime\(\)/, 'ветвление по транспорту живёт в одном месте');
  assert.match(body, /nasWork\(\)/, 'работа выполняется через переданную функцию');
});

test('функции сохранения базы идут через saveLineEvent и не содержат firebase-веток', () => {
  for (const name of ['saveTruckToGlobalBase', 'deleteGlobalTruck', 'saveObjectToBase', 'deleteGlobalObject']) {
    const body = functionBody(name);
    assert.match(body, /saveLineEvent/, name + ' использует saveLineEvent');
    assert.doesNotMatch(body, /tfAwait|db\.batch|refs\.(trucks|objects)\./, name + ' не содержит firebase-веток');
  }
});

test('админ-действия идут через saveLineEvent и не содержат firebase-веток', () => {
  for (const name of ['setUserAccess', 'updateUserNickname', 'changeUserRole', 'deleteUser', 'decideRegistration', 'savePermissions']) {
    const body = functionBody(name);
    assert.match(body, /saveLineEvent/, name + ' использует saveLineEvent');
    assert.doesNotMatch(body, /tfAwait|usersRef\.|requestsRef\.|permsRef\.|appConfigRef\./, name + ' не содержит firebase-веток');
  }
});

test('addNewUser регистрирует только через сервер Ubuntu, без firebase-ветки', () => {
  const body = functionBody('addNewUser');
  assert.match(body, /\/api\/v1\/auth\/register/, 'регистрация через Ubuntu API');
  assert.doesNotMatch(body, /tfAwait|usersRef\.|createUserWithEmailAndPassword/, 'нет firebase-ветки создания пользователя');
});

test('в файле не осталось firebase-веток в функциях сохранения', () => {
  // Допустимые оставшиеся использования isNasRuntime: выборка табеля,
  // защита телефона и определение защищённого пользователя в рендере.
  const occurrences = lineUi.split('isNasRuntime()').length - 1;
  assert.ok(occurrences <= 5, 'isNasRuntime в 18-line-ui.js встречается не больше 5 раз, фактически: ' + occurrences);
  assert.doesNotMatch(lineUi, /isNasRuntime\(\)[^;]*\{[^}]*tfAwait/, 'нет шаблона if(isNasRuntime()){...firebase...} с tfAwait');
});
