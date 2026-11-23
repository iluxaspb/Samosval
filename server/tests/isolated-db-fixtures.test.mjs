import test from 'node:test';
import assert from 'node:assert/strict';

import { applyFixtures, FIXTURE_IDS } from '../scripts/isolated-db/fixtures.mjs';

const allowed = [
  'import-schema',
  'identity-empty',
  'auth-schema-018',
  'authority-main-ubuntu',
  'authority-main-firebase',
  'replica-admin',
  'replica-empty-stream-cursors',
];

test('fixture registry is closed to the exact pre-S25 IDs', async () => {
  assert.deepEqual(FIXTURE_IDS, allowed);
  const fixtureClient = { async apply() {}, async verify() { return { ok: true }; } };
  for (const id of ['parallel-shift-legacy-unresolved', 'replica-pending-empty', 'unknown']) {
    await assert.rejects(applyFixtures({ fixtureClient }, [id]), /fixture is unavailable/i);
  }
});

test('fixtures execute once in registry order and verify postconditions after each apply', async () => {
  const calls = [];
  const fixtureClient = {
    async apply(id) { calls.push(`apply:${id}`); },
    async verify(id) { calls.push(`verify:${id}`); return { ok: true, rows: 0 }; },
  };
  const reports = await applyFixtures({ fixtureClient }, ['replica-admin', 'import-schema', 'identity-empty']);
  assert.deepEqual(calls, [
    'apply:import-schema', 'verify:import-schema',
    'apply:identity-empty', 'verify:identity-empty',
    'apply:replica-admin', 'verify:replica-admin',
  ]);
  assert.deepEqual(reports.map(report => report.id), ['import-schema', 'identity-empty', 'replica-admin']);
  assert.ok(reports.every(Object.isFrozen));
});

test('fixtures reject duplicates, external connection authority and failed postconditions', async () => {
  await assert.rejects(applyFixtures({ fixtureClient: { apply() {}, verify() { return { ok: true }; } } }, ['import-schema', 'import-schema']), /duplicate fixture/i);
  await assert.rejects(applyFixtures({ adminUrl: 'forbidden', fixtureClient: { apply() {}, verify() { return { ok: true }; } } }, ['import-schema']), /fixture context is not approved/i);
  await assert.rejects(applyFixtures({ fixtureClient: { apply() {}, verify() { return { ok: false }; } } }, ['identity-empty']), /fixture postcondition failed/i);
});
