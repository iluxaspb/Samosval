import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Проверяем тот самый файл, который уходит в сборку, а не его копию.
const file = fileURLToPath(new URL('./24-switch-policy.js', import.meta.url));
const context = vm.createContext({});
vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
const policy = context.WorkingTestSwitchPolicy;

const base = {
  target: 'ubuntu',
  authenticated: true,
  isAdmin: true,
  permissionsLoaded: true,
  pending: 0,
  currentProvider: 'firebase',
  generation: 7
};

test('не администратор не может переключать сервер', () => {
  const plan = policy.decideSwitchPlan({ ...base, isAdmin: false });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /администратор/);
});

test('без загруженных прав переключение запрещено', () => {
  const plan = policy.decideSwitchPlan({ ...base, permissionsLoaded: false });
  assert.equal(plan.ok, false);
});

test('неотправленные действия блокируют переключение', () => {
  const plan = policy.decideSwitchPlan({ ...base, pending: 3 });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /неотправленные/);
});

test('неизвестный режим отклоняется', () => {
  const plan = policy.decideSwitchPlan({ ...base, target: 'auto' });
  assert.equal(plan.ok, false);
});

test('повтор того же режима не трогает владельца записи', () => {
  const plan = policy.decideSwitchPlan({ ...base, currentProvider: 'ubuntu' });
  assert.equal(plan.ok, true);
  assert.equal(plan.noop, true);
});

test('без подтверждённого поколения переключение не начинается', () => {
  const plan = policy.decideSwitchPlan({ ...base, generation: 0 });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /не подтверждён/);
});

test('корректный план отдаёт поколение для серверной команды', () => {
  const plan = policy.decideSwitchPlan(base);
  assert.equal(plan.ok, true);
  assert.equal(plan.noop, false);
  assert.equal(plan.expectedGeneration, 7);
});

test('конфликт поколений объясняется администратору', () => {
  assert.match(policy.describeSwitchFailure(409, 'authority-generation-conflict'), /другой администратор/);
  assert.match(policy.describeSwitchFailure(409, 'authority-generation-mismatch'), /Обновите/);
});

test('отказ доступа к резерву объясняется отдельно', () => {
  assert.match(policy.describeSwitchFailure(403, 'forbidden'), /учётную запись/);
});

test('зеркало разрешено только при владельце Firebase', () => {
  assert.equal(policy.isMirrorAllowed('firebase'), true);
  assert.equal(policy.isMirrorAllowed('ubuntu'), false);
});