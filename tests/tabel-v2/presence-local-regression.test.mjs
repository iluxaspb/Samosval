import assert from 'node:assert/strict';
import {test} from 'node:test';
import {presence} from '../../test-app/tabel-v2/presence.mjs';

// Регрессия live-values: remote:false давал const collection=false,
// а collection?.doc(...) не защищён от false (optional chaining срабатывает
// только для null/undefined) => TypeError "collection?.doc is not a function".
// presence() нуждается в браузерных глобалах; подменяем их точечно вокруг теста.
function fakeDom() {
  const listeners = {};
  const document = {
    hidden: false,
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { const a = listeners[type]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
  };
  const root = { hidden: false, isConnected: true };
  class fakeObserver { observe() {} disconnect() {} }
  return {document, root, listeners, fakeObserver};
}

async function withDom(step) {
  const set = (name, value) => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, name);
    const had = Boolean(desc && ('value' in desc || desc.set));
    const prev = had ? (desc.value !== undefined ? desc.value : desc.get?.call(globalThis)) : globalThis[name];
    if (desc && desc.configurable === false) throw Error('Нельзя переопределить глобал: ' + name);
    Object.defineProperty(globalThis, name, {value, writable: true, configurable: true});
    return () => {
      if (had) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
    };
  };
  const restore = [];
  const dom = fakeDom();
  try {
    restore.push(set('navigator', {onLine: true}));
    restore.push(set('document', dom.document));
    restore.push(set('MutationObserver', dom.fakeObserver));
    restore.push(set('addEventListener', () => {}));
    restore.push(set('removeEventListener', () => {}));
    // ВАЖНО: await, а не return. finally здесь сработал бы сразу после return
    // (не дожидаясь promise), и фейк-глобалы пропали бы, пока fire-and-forget
    // write()/dispose() микрозадачи ещё не завершились => ReferenceError
    // "document is not defined at write (presence.mjs:41:53)".
    return await step(dom);
  } finally {
    for (const r of restore.reverse()) r();
  }
}

// Локальный режим: remote=false и/или workspace отсутствует — не бросает,
// presence создаётся, обновление уходит в сообщение об отсутствии совместного
// выделения, dispose безопасен. До фикса это падало на collection?.doc(...).
function localOnly(remote, hasWorkspace) {
  const base = {object: {id: 'site'}, remote,
    host: {session: () => ({uid: 'operator-1', name: 'Илья'})},
    sheetVisible: () => true};
  if (hasWorkspace) base.host.workspace = {collection: () => { throw Error('не должен вызываться без remote'); }};
  return withDom(dom => {
    let peers, failure;
    let live;
    assert.doesNotThrow(() => { live = presence(base, (p, f) => { peers = p; failure = f; }); }, 'presence() не должен бросать в локальном режиме');
    assert.doesNotThrow(() => live.update('linked'), 'update не должен бросать без remote-коллекции');
    assert.deepEqual(peers, [], 'в локальном режиме чужих пользователей быть не должно');
    assert.equal(failure, 'Совместное выделение доступно после подключения Firebase');
    assert.doesNotThrow(() => live.dispose(), 'dispose не должен бросать без remote-коллекции');
    return {peers, failure};
  });
}

test('presence remote:false (без workspace) работает локально и не бросает', () => {
  localOnly(false, false);
});
test('presence remote:true без workspace тоже не бросает (null-safe collection)', () => {
  localOnly(true, false);
});

// Настоящий remote: workspace.collection('tabelNextPresence') вызывает .doc,
// подписка collection.where(...).onSnapshot работает и доставляет других
// пользователей, запись .set отправляется с корректным payload.
function fakeWorkspace() {
  const calls = [];
  let snapshotCb = null;
  let ref = null;
  const collection = {
    doc(id) { calls.push(['doc', id]); ref = {id,
      set(payload) { calls.push(['set', id, payload]); return Promise.resolve(); },
      delete() { calls.push(['delete', id]); return Promise.resolve(); }};
      return ref; },
    where(field, op, value) { calls.push(['where', field, op, value]); return collection; },
    onSnapshot(cb) { calls.push(['onSnapshot']); snapshotCb = cb; return () => calls.push(['unsubscribe']); },
  };
  const workspace = {collection(name) { calls.push(['collection', name]); return collection; }};
  return {workspace, calls, push: snapshot => snapshotCb?.(snapshot), getRef: () => ref};
}

test('presence remote:true сохраняет doc и подписку на чужие выделения', async () => {
  const fake = fakeWorkspace();
  await withDom(async dom => {
    const s = {object: {id: 'site'}, remote: true, root: {hidden: false, isConnected: true},
      host: {session: () => ({uid: 'operator-2', name: 'Алексей'}), workspace: fake.workspace},
      sheetVisible: () => true};
    const seen = [];
    const live = presence(s, (p) => seen.push(p));
    try {
      live.update('linked');
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(fake.calls.some(c => c[0] === 'collection' && c[1] === 'tabelNextPresence'), 'должен запрашиваться тёплый коллекция presence');
      assert.ok(fake.calls.some(c => c[0] === 'doc' && /^operator-2_/.test(c[1])), 'ref должен создаваться через collection.doc(uid+id)');
      assert.ok(fake.calls.some(c => c[0] === 'where' && c[1] === 'objectId' && c[3] === 'site'), 'подписка фильтрует по objectId');
      assert.ok(fake.calls.some(c => c[0] === 'where' && c[1] === 'sheetId' && c[3] === 'linked'), 'подписка фильтрует по sheetId');
      const setCalls = fake.calls.filter(c => c[0] === 'set');
      assert.equal(setCalls.length, 1, 'должна быть одна запись set');
      assert.equal(setCalls[0][2].uid, 'operator-2');
      assert.equal(setCalls[0][2].sheetId, 'linked');
      assert.equal(setCalls[0][2].objectId, 'site');
      assert.equal(setCalls[0][2].name, 'Алексей');
      // Приход чужого пользователя через onSnapshot.
      fake.push({docs: [{id: 'peer-A1', data: () => ({uid: 'other', name: 'Пётр', objectId: 'site', sheetId: 'linked', selection: null})}]});
      const last = seen[seen.length - 1];
      assert.equal(last.length, 1, 'onSnapshot должен доставить чужого пользователя');
      assert.equal(last[0].name, 'Пётр');
      // Свой uid и чужие sheet/object исключаются.
      fake.push({docs: [
        {id: 'peer-A2', data: () => ({uid: 'operator-2', name: 'Я сам', objectId: 'site', sheetId: 'linked', selection: null})},
        {id: 'peer-A3', data: () => ({uid: 'other2', name: 'Мария', objectId: 'site', sheetId: 'one', selection: null})},
      ]});
      assert.deepEqual(seen[seen.length - 1].map(p => p.name), [], 'свой uid и чужие листы не показываются');
      live.dispose();
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(fake.calls.some(c => c[0] === 'unsubscribe'), 'dispose должен отписываться');
      assert.ok(fake.calls.some(c => c[0] === 'delete'), 'dispose должен удалять ref presence');
    } finally {
      try { live.dispose(); } catch { /* глобалы уже восстановлены — игнорируем */ }
      await new Promise(resolve => setImmediate(resolve));
    }
  });
});
