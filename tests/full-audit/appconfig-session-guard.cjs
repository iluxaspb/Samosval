'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const patch = fs.readFileSync('test-app/source/patches/11.js', 'utf8');

async function run({status, generation, flipAfterGet = false}) {
  let reads = 0;
  const ctx = {
    console,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async () => ({ok:true, status:200}),
    localStorage: { getItem: () => '0', setItem() {} },
    window: {},
    currentUserStatus: status,
    currentUid: 'uid-a',
    profileServerConfirmed: status === 'active',
    permissionsServerConfirmed: status === 'active',
    authSessionGeneration: generation,
    firebase: { firestore: () => ({ collection: () => ({ doc: () => ({ get: async () => { reads++; if (flipAfterGet) ctx.authSessionGeneration++; return {exists:false}; } }) }) }) }
  };
  vm.createContext(ctx);
  vm.runInContext(patch, ctx);
  const result = await ctx.window.sendMaxOnce({type:'text', text:'test'});
  return {reads, result};
}

(async () => {
  const pending = await run({status:'pending', generation:1});
  assert.equal(pending.reads, 0, 'pending session must not read settings/appConfig');
  assert.equal(pending.result, 'drop');
  const stale = await run({status:'active', generation:1, flipAfterGet:true});
  assert.equal(stale.reads, 1, 'active session may read once after readiness');
  assert.equal(stale.result, 'drop', 'result from an old auth generation must be discarded');
  const active = await run({status:'active', generation:1});
  assert.equal(active.reads, 1);
  assert.equal(active.result, 'drop', 'missing appConfig must safely drop');
  console.log('PASS appConfig session guard: pending skips Firestore read; stale generation result is discarded; active read remains bounded');
})().catch(error => { console.error(error); process.exitCode = 1; });
