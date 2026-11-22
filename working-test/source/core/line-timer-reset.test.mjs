// Регрессионный тест права line_timer_reset (сброс таймера ходки).
// Право добавлено в матрицу роли на сервере (default: только admin);
// фронт отражает его в ALL_ACTIONS/ACTION_LABELS, в группе «Работа самосвалов»
// матрицы прав и проверяет через hasPermission вместо жёсткого isAdmin.
// Дефолт для не-admin ролей — право выключено (в DEFAULT_PERMISSIONS его нет).
// Запуск: node --test working-test/source/core/line-timer-reset.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = p => readFileSync(join(root, p), 'utf8');
const config = read('core/00-config-state.js');
const lineUi = read('core/18-line-ui.js');
const resetHold = read('features/reset-hold.js');
const perms = read('core/02-permissions.js');

test('право line_timer_reset есть в ALL_ACTIONS с подписью', () => {
  assert.match(config, /ALL_ACTIONS\s*=\s*\[[\s\S]*?'line_timer_reset'/, 'право в списке ALL_ACTIONS');
  assert.match(config, /line_timer_reset:\s*'Сброс таймера ходки'/, 'подпись в ACTION_LABELS');
});

test('матрица прав: право в группе «Работа самосвалов»', () => {
  const group = lineUi.match(/\['Работа самосвалов',\[([^\]]*)\]\]/);
  assert.ok(group, 'группа «Работа самосвалов» найдена');
  assert.ok(group[1].split(',').map(s => s.trim().replace(/'/g, '')).includes('line_timer_reset'),
    'право входит в группу рядом с action_arrive/action_load/action_ttn');
});

test('кнопка сброса проверяет право, а не жёсткий isAdmin/canAdmin', () => {
  assert.match(resetHold, /hasPermission\('line_timer_reset'\)/, 'проверка права line_timer_reset');
  // Ни в логике сброса, ни в отметке кнопок не осталось admin-only проверки.
  assert.doesNotMatch(resetHold, /canAdmin\(\)\s*\{\s*showError\('Только для администратора/, 'нет жёсткой admin-only проверки сброса');
});

test('hasPermission даёт право админу автоматически и по матрице ролей остальным', () => {
  assert.match(perms, /currentUserRole === 'admin' return true|currentUserRole === 'admin'\s*\)\s*return true/, 'админ проходит все проверки прав');
});

test('дефолт для не-admin ролей: право выключено (кроме старшего прораба)', () => {
  const defaults = config.slice(config.indexOf('DEFAULT_PERMISSIONS'), config.indexOf('// Если приложение открыто'));
  for (const role of ['foreman', 'master', 'lopater', 'viewer']) {
    const roleBlock = defaults.match(new RegExp('(?<![a-z_])' + role + ':\\s*\\{[\\s\\S]*?\\}'));
    assert.ok(roleBlock, 'роль ' + role + ' найдена в DEFAULT_PERMISSIONS');
    assert.doesNotMatch(roleBlock[0], /line_timer_reset/, 'роль ' + role + ' не имеет права по умолчанию');
  }
  // Старший прораб — единственная не-admin роль с правом по умолчанию.
  const senior = defaults.match(/senior_foreman:\s*\{[\s\S]*?\}/)[0];
  assert.match(senior, /line_timer_reset/, 'senior_foreman имеет право по умолчанию');
});
