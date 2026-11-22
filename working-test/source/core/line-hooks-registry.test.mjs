// Регрессионный тест реестра хуков Линии (registerLineHook).
// Фичи больше не подменяют window.renderLine напрямую: они регистрируют
// before/after-хуки, а реестр сам строит цепочку обёрток в порядке
// регистрации. before и after одной регистрации делят общий ctx.
// Запуск: node --test working-test/source/core/line-hooks-registry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = p => readFileSync(join(root, p), 'utf8');

test('фичи не подменяют window.renderLine напрямую', () => {
  for (const p of ['features/offline-feedback.js', 'features/line-motion-test.js', 'features/reset-hold.js']) {
    const text = read(p);
    assert.doesNotMatch(text, /window\.renderLine\s*=/, p + ' не должен присваивать window.renderLine');
    assert.match(text, /registerLineHook\(/, p + ' использует реестр хуков');
  }
});

test('анимационный модуль anim-speeds остаётся базовой заменой рендера', () => {
  // anim-speeds — не обёртка, а полная замена renderLine (свои тайминги и
  // сортировка); по заданию он не переводится на хуки, реестр оборачивает
  // уже его версию при последующих регистрациях.
  const text = read('features/anim-speeds.js');
  assert.match(text, /window\.renderLine\s*=\s*function/, 'anim-speeds по-прежнему заменяет renderLine');
});

test('реестр строит цепочку в порядке регистрации и делит ctx пары before/after', () => {
  const calls = [];
  let baseCalls = 0;
  function base() { baseCalls++; return 'result'; }
  const sandbox = {
    window: { renderLine: base },
    calls,
    console: { error() {} },
  };
  vm.createContext(sandbox);
  // Реестр объявлен внутри 18-line-ui.js как function declaration в общем
  // скоупе модулей; для теста выполняем его объявление в песочнице и
  // возвращаем ссылку на функцию напрямую (её замыкание держит массив).
  const lineUi = read('core/18-line-ui.js');
  const start = lineUi.indexOf('function registerLineHook(');
  const end = lineUi.indexOf('\n  function ', start + 1);
  const registered = 'const registeredLineHooks = [];\n' + lineUi.slice(start, end) + '\nregisterLineHook';
  sandbox.registerLineHook = vm.runInContext(registered, sandbox);
  const code = `
    const unreg1 = registerLineHook({
      before(ctx) { calls.push('b1'); ctx.shared = 'x'; },
      after(ctx) { calls.push('a1:' + ctx.shared + ':' + ctx.result + ':' + (ctx.error ? ctx.error.message : 'ok')); },
    });
    const unreg2 = registerLineHook({
      before() { calls.push('b2'); },
      after() { calls.push('a2'); },
    });
    window.renderLine();
    unreg2();
    window.renderLine();
  `;
  vm.runInContext(code, sandbox, { filename: 'line-hooks-sandbox.js' });
  // Порядок: последний зарегистрированный — самый внешний (unreg2): b2 → b1 → base → a1 → a2.
  assert.deepEqual(calls, ['b2', 'b1', 'a1:x:result:ok', 'a2', 'b1', 'a1:x:result:ok']);
  assert.equal(baseCalls, 2, 'после unreg2 вызовы идут только через хук 1');
});

test('ошибка базового рендера доходит до after-хука и пробрасывается дальше', () => {
  const seen = [];
  const sandbox = {
    window: { renderLine() { throw Error('boom'); } },
    seen,
    console: { error() {} },
  };
  vm.createContext(sandbox);
  const lineUi = read('core/18-line-ui.js');
  const start = lineUi.indexOf('function registerLineHook(');
  const end = lineUi.indexOf('\n  function ', start + 1);
  const registered = 'const registeredLineHooks = [];\n' + lineUi.slice(start, end) + '\nregisterLineHook';
  sandbox.registerLineHook = vm.runInContext(registered, sandbox);
  vm.runInContext(`
    registerLineHook({ after(ctx) { seen.push(ctx.error ? ctx.error.message : null); } });
    try { window.renderLine(); } catch (e) { seen.push('caught:' + e.message); }
  `, sandbox);
  assert.deepEqual(seen, ['boom', 'caught:boom'], 'after-хук видит ctx.error, ошибка пробрасывается');
});
