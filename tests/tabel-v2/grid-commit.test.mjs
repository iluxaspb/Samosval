import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Exercise the actual queueCommit closure with an in-memory store: a blur and
// the apply button can request the same commit before the first save finishes.
const source = readFileSync(new URL('../../test-app/tabel-v2/grid.mjs', import.meta.url), 'utf8');
const commitSource = source.slice(source.indexOf('  function queueCommit() {'), source.indexOf('  edit.oninput ='));
function fixture(dirtyInitially) {
  return new Function('dirtyInitially', `
    let dirty = dirtyInitially, chain = Promise.resolve();
    const selected = 'A1', edit = {value: '5'}, sheetId = 'free';
    let referencePick = 'B1';
    const suggestions = {hidden: false}, writes = [];
    const table = {querySelectorAll: () => []};
    const s = {key: x => x, store: {
      state: {records: {'draft:grid:free': {data: {cell: 'A1', raw: '5'}}}},
      serialize: fn => fn(), persist: async () => {},
    }};
    const queue = fn => chain = chain.then(fn);
    const apply = async (cell, value) => {writes.push([cell, value]);};
    ${commitSource}
    return {commit: queueCommit, writes, suggestions, s,
      get chain() {return chain;}, get dirty() {return dirty;},
      get referencePick() {return referencePick;}};
  `)(dirtyInitially);
}

test('grid commit without new input preserves the chain and does not save', async () => {
  const f = fixture(false), chain = f.chain;
  assert.equal(f.commit(), chain);
  await chain;
  assert.deepEqual(f.writes, []);
  assert.equal(f.suggestions.hidden, false);
  assert.equal(f.referencePick, 'B1');
});

test('blur followed by apply queues one write and clears the matching draft', async () => {
  const f = fixture(true), saved = f.commit();
  assert.equal(f.dirty, false);
  assert.equal(f.commit(), saved);
  await saved;
  assert.deepEqual(f.writes, [['A1', '5']]);
  assert.equal(f.suggestions.hidden, true);
  assert.equal(f.referencePick, null);
  assert.equal(f.s.store.state.records['draft:grid:free'], undefined);
});
