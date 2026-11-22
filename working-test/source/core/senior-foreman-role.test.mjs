// Регрессионный тест роли senior_foreman («Старший прораб», значок 👑).
// Роль наследует все права/настройки foreman и дополнительно получает
// line_timer_reset. Существующие пользователи не перекрашиваются: роль
// добавляется в справочник и селекты, назначается только администратором.
// Запуск: node --test working-test/source/core/senior-foreman-role.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = p => readFileSync(join(root, p), 'utf8');
const config = read('core/00-config-state.js');
const shell = read('shell.html');
const css = read('styles/style-04.css');

test('справочник ROLES: роль senior_foreman «Старший прораб» со значком короны', () => {
  assert.match(config, /senior_foreman:\s*\{\s*label:\s*'Старший прораб',\s*icon:\s*'👑'/, 'роль в ROLES с подписью и значком');
});

test('дефолтные права senior_foreman = права foreman + line_timer_reset', () => {
  const defaults = config.slice(config.indexOf('DEFAULT_PERMISSIONS'), config.indexOf('// Если приложение открыто'));
  const senior = defaults.match(/senior_foreman:\s*\{[\s\S]*?\}\s*,\n/)[0];
  const foreman = defaults.match(/(?<![a-z_])foreman:\s*\{[\s\S]*?\}\s*,\n/)[0];
  assert.match(senior, /line_timer_reset/, 'старшему прорабу доступен сброс таймера ходки');
  assert.doesNotMatch(foreman, /line_timer_reset/, 'обычному прорабу сброс не положен');
  const seniorTabs = senior.match(/tabs:\s*\[([^\]]*)\]/)[1];
  const foremanTabs = foreman.match(/tabs:\s*\[([^\]]*)\]/)[1];
  assert.equal(seniorTabs, foremanTabs, 'набор вкладок совпадает с прорабом');
  const seniorActions = senior.match(/actions:\s*\[([^\]]*)\]/)[1].split(',').map(s=>s.trim().replace(/'/g,'')).filter(a=>a!=='line_timer_reset');
  const foremanActions = foreman.match(/actions:\s*\[([^\]]*)\]/)[1].split(',').map(s=>s.trim().replace(/'/g,''));
  assert.deepEqual(seniorActions, foremanActions, 'остальные права наследуются от foreman без изменений');
});

test('матрица прав и назначение роли: роль доступна администратору', () => {
  assert.match(shell, /permRoleSelect[^>]*>[\s\S]*?value="senior_foreman">👑 Старший прораб/, 'роль в селекте матрицы прав');
  assert.match(shell, /newUserRole[^>]*>[\s\S]*?value="senior_foreman">👑 Старший прораб/, 'роль в селекте создания пользователя');
});

test('бейдж роли: отдельный цвет чипа для старшего прораба', () => {
  assert.match(css, /\.role-chip\.senior_foreman\s*\{/, 'стиль чипа роли в style-04.css');
});

test('наследуемые настройки foreman распространены на senior_foreman', () => {
  const perms = read('core/02-permissions.js');
  assert.match(perms, /canViewReleaseHistory[\s\S]*?'admin','foreman','senior_foreman'/, 'история релизов видна старшему прорабу');
  assert.match(perms, /tabName==='timesheet'&&\(currentUserRole==='foreman'\|\|currentUserRole==='senior_foreman'\)/, 'доступ к табелю как у прораба');
});

test('существующие роли не перекрашены', () => {
  for (const role of ['foreman: { label: \'Прораб\', icon: \'🔧\'', 'master: { label: \'Мастер\'', 'lopater: { label: \'Лопатер\'', 'viewer: { label: \'Наблюдатель\', icon: \'👁\'']) {
    assert.ok(config.includes(role), 'роль без изменений: ' + role);
  }
});
