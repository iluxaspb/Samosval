import test from 'node:test';
import assert from 'node:assert/strict';
import {presentGames, gamesText} from '../src/game-store.mjs';
import {presentAuxiliary, auxiliaryText} from '../src/auxiliary-store.mjs';

const ws = 'main_workspace';
const records = [
  {id: 'r1', eventType: 'game_arcade', gameRound: 2, bank: 980, userUid: 'u1', player: {net: 10}, actors: {}},
  {id: 'r2', eventType: 'history', timestamp: 1, history: {operations: []}},
];
const adjustments = [
  {id: 'a1', eventType: 'game_coin_adjustment', targetUid: 'u1', amount: 100},
  {id: 'a2', eventType: 'game_coin_adjustment', targetUid: 'u2', amount: 50},
];
const head = {gameRound: 2, bank: 980};
const players = {u1: {net: 10, _round: 2}};

const snapshot = () => ({recordsText: JSON.stringify(records), adjustments, head, players});

test('gamesText: байт-в-байт совпадает со прежним ответом readGames', () => {
  for (const actor of [{uid: 'u1', role: 'admin'}, {uid: 'u1', role: 'lopater'}, {uid: 'u2', role: 'viewer'}]) {
    const before = JSON.stringify(presentGames({records, adjustments, head, players}, actor, actor.uid, ws));
    const after = gamesText(snapshot(), actor, actor.uid, ws);
    assert.equal(after, before, 'ответ не изменился для роли ' + actor.role);
  }
});

test('gamesText: поправки монет каждый видит только свои', () => {
  const user = gamesText(snapshot(), {uid: 'u1', role: 'lopater'}, 'u1', ws);
  assert.deepEqual(JSON.parse(user).adjustments.map((r) => r.id), ['a1']);
  const admin = gamesText(snapshot(), {uid: 'admin', role: 'admin'}, 'admin', ws);
  assert.deepEqual(JSON.parse(admin).adjustments.map((r) => r.id), ['a1', 'a2']);
});

const plugins = [
  {id: 'p1', enabled: true, removed: false, allowedRoles: [], maxUrl: 'http://x', maxChatId: '1'},
  {id: 'p2', enabled: true, removed: false, allowedRoles: ['admin']},
  {id: 'p3', enabled: false, removed: false, allowedRoles: []},
];
const patches = [{id: 'x1', enabled: true}, {id: 'x2', enabled: false}];
const audit = [{id: 'e1', timestamp: 2, text: 'Прибытие'}, {id: 'e2', timestamp: 1, text: 'Погрузка'}];
const notifications = [{id: 'n1', timestamp: 2, html: 'Прибытие · Самосвал'}];

function auxSnapshot(source, extra = {}) {
  return {
    plugins: source.plugins,
    patches: source.patches,
    auditText: JSON.stringify(source.audit),
    notificationsText: JSON.stringify(source.notifications),
    needsFilter: false,
    ...extra,
  };
}

test('auxiliaryText: байт-в-байт совпадает с прежним ответом readAuxiliary для всех ролей', () => {
  const source = {plugins, patches, audit, notifications};
  for (const role of ['admin', 'foreman', 'master', 'lopater', 'viewer']) {
    const before = JSON.stringify(presentAuxiliary(source, {uid: 'u', role}, ws));
    const after = auxiliaryText(auxSnapshot(source), {uid: 'u', role}, ws);
    assert.equal(after, before, 'журнал не изменился для роли ' + role);
  }
});

test('auxiliaryText: служебные поля плагинов не уходят непривилегированным ролям', () => {
  const source = {plugins, patches, audit, notifications};
  const viewer = JSON.parse(auxiliaryText(auxSnapshot(source), {uid: 'u', role: 'viewer'}, ws));
  assert.equal(viewer.plugins.length, 1, 'видны только включённые плагины без ограничения ролей');
  assert.equal(viewer.plugins[0].maxUrl, undefined);
  assert.equal(viewer.plugins[0].maxChatId, undefined);
  assert.equal(viewer.patches.length, 1);
});

test('auxiliaryText: если в журнале появится служебное поле, ответ всё равно чистится', () => {
  const dirty = {plugins, patches, audit: [{id: 'e9', timestamp: 3, token: 'секрет'}], notifications};
  const viewer = JSON.parse(auxiliaryText(auxSnapshot(dirty, {needsFilter: true}), {uid: 'u', role: 'viewer'}, ws));
  assert.equal(viewer.audit[0].token, undefined, 'служебное поле вычищено');
  assert.equal(viewer.audit[0].id, 'e9', 'сама запись журнала осталась');
});
