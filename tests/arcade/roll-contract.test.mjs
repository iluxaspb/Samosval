import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Контракт ставки автомата между рабочей PWA и API рабочей версии.
//
// 28.11.2026 рабочая версия 1.7.23 перестала принимать ставку: клиент
// выбрасывал заранее зафиксированный бросок `roll`, а API рабочей версии
// требует его (иначе 400 invalid-game-roll). Проверки ниже читают именно
// СОБРАННЫЙ комплект (working-test/build/<build> из version.json), чтобы
// регрессия сборки не проходила незамеченной.

const root = fileURLToPath(new URL('../..', import.meta.url));
const version = JSON.parse(readFileSync(path.join(root, 'version.json'), 'utf8'));
const buildDir = path.join(root, 'working-test', 'build', version.build);
const coreSource = readFileSync(path.join(buildDir, 'core.js'), 'utf8');
const uiSource = readFileSync(path.join(buildDir, 'road-arcade-ui.js'), 'utf8');
const runtimeSource = readFileSync(path.join(buildDir, 'road-arcade-runtime.js'), 'utf8');

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > 0, 'не найдена функция ' + signature);
  let depth = 0, i = source.indexOf('{', start);
  const from = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(from, i + 1); }
  }
  throw new Error('не удалось выделить тело ' + signature);
}

// Клиентская функция отправки игрового действия в режиме Ubuntu.
function loadNasGameAction(capture) {
  const body = functionBody(coreSource, 'async function nasGameAction(action)');
  const factory = new Function(
    'nasRuntimeClient', 'nasRuntimeEpoch', 'nasBusinessCommand', 'acceptNasGameReceipt',
    'refreshNasGames', 'nasGameReadError',
    'return (async function nasGameAction(action)' + body + ');'
  );
  return factory(
    {}, 1,
    async (channel, target, fields) => {
      capture.push({channel, target, fields});
      return {result: {round: 7, confirmedHead: {}}};
    },
    () => true,
    async () => {},
    () => {}
  );
}

test('ставка автомата уходит на API рабочей версии вместе с зафиксированным броском', async () => {
  const captured = [];
  const action = loadNasGameAction(captured);
  await action({id: 'spin_1', kind: 'slot', roll: 1234, createdAt: 1});
  assert.equal(captured.length, 1, 'запрос ставки не отправлен');
  const {channel, target, fields} = captured[0];
  assert.equal(channel, 'game');
  assert.equal(target, 'slot:spin_1');
  assert.equal(fields.type, 'game.play');
  assert.equal(fields.action.kind, 'slot');
  assert.equal(fields.action.roll, 1234, 'клиент обязан передать бросок: без него API отвечает 400 invalid-game-roll');
});

test('бросок в запросе — то же число, по которому остановились барабаны', () => {
  const body = functionBody(uiSource, 'async function spin()');
  const previewAt = body.indexOf('C.slotOutcome(operation.roll');
  const transactAt = body.indexOf('await A.transact(operation)');
  assert.ok(previewAt > 0, 'символы барабанов должны считаться из operation.roll');
  assert.ok(transactAt > previewAt, 'ставка отправляется после фиксации броска');
  // Повтор незавершённой ставки идёт тем же объектом operation: тот же id и roll,
  // поэтому сервер узнаёт операцию и не списывает монеты дважды.
  assert.ok(body.indexOf('A.storeSpin(operation)') > 0, 'незавершённая ставка должна сохраняться для безопасного повтора');
});

test('администратору джекпот не выпадает и на клиенте', () => {
  // Сервер детерминированно уводит бросок администратора из джекпот-диапазона
  // (0 → 9999). Клиент обязан сделать то же ДО анимации, иначе покажет джекпот,
  // которого не будет в выплате.
  assert.match(runtimeSource, /function slotRoll\(\)\{[^}]*currentUserRole==='admin'[^}]*9999/,
    'нет клиентского правила «администратору джекпот не выпадает»');
  const newSpin = runtimeSource.slice(runtimeSource.indexOf('newSpin:'));
  assert.match(newSpin, /roll:slotRoll\(\)/,
    'новое вращение должно брать бросок из slotRoll()');
});

test('контракт API: сервер принимает только целый бросок 0..9999', async () => {
  const captured = [];
  const action = loadNasGameAction(captured);
  await action({id: 'spin_2', kind: 'slot', roll: 0, createdAt: 1});
  const roll = captured[0].fields.action.roll;
  assert.ok(Number.isInteger(roll) && roll >= 0 && roll < 10000,
    'API рабочей версии принимает только целое 0..9999, иначе 400 invalid-game-roll');
});
