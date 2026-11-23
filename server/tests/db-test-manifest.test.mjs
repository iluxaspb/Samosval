import test from 'node:test';
import assert from 'node:assert/strict';
import { loadManifest } from '../scripts/isolated-db/manifest.mjs';

const unit = file => ({
  file,
  kind: 'unit',
  discovery: 'pure-import',
  reason: 'Pure contract without PostgreSQL access'
});

const db = file => ({
  file,
  kind: 'db',
  discovery: 'direct',
  reason: 'Reads TEST_DATABASE_URL and imports pg directly',
  baseline: 'S24',
  migrationsThrough: null,
  customSchema: [],
  importTables: [],
  fixtures: [],
  timeoutMs: 30_000,
  serial: false,
  exclusive: false,
  allowedSkips: []
});

const valid = entries => ({ manifestVersion: 1, entries, harnessFixtures: [] });

test('manifest rejects missing, duplicate and stale root entries', () => {
  const discovered = ['tests/a.test.mjs', 'tests/b.test.mjs'];
  assert.throws(() => loadManifest(valid([unit(discovered[0])]), { discovered }), /missing.*b\.test\.mjs/i);
  assert.throws(() => loadManifest(valid([unit(discovered[0]), unit(discovered[0])]), { discovered: [discovered[0]] }), /duplicate.*a\.test\.mjs/i);
  assert.throws(() => loadManifest(valid([unit(discovered[0]), unit('tests/stale.test.mjs')]), { discovered: [discovered[0]] }), /stale.*stale\.test\.mjs/i);
});

test('manifest rejects unknown fields and incomplete DB metadata', () => {
  assert.throws(() => loadManifest(valid([{ ...unit('tests/a.test.mjs'), surprise: true }]), { discovered: ['tests/a.test.mjs'] }), /unknown field.*surprise/i);
  const incomplete = db('tests/a.test.mjs');
  delete incomplete.timeoutMs;
  assert.throws(() => loadManifest(valid([incomplete]), { discovered: ['tests/a.test.mjs'] }), /timeoutMs/);
});

test('manifest keeps root entries separate from harness fixtures', () => {
  assert.throws(() => loadManifest({ ...valid([unit('tests/a.test.mjs')]), harnessFixtures: ['tests/a.test.mjs'] }, { discovered: ['tests/a.test.mjs'] }), /fixture.*root|root.*fixture|fixture path/i);
  assert.throws(() => loadManifest({ ...valid([]), harnessFixtures: ['tests/fixtures/worker.test.mjs'] }, { discovered: ['tests/fixtures/worker.test.mjs'] }), /root.*fixtures|fixture.*root/i);
});

test('manifest accepts explicit direct and indirect DB consumers', () => {
  const indirect = { ...db('tests/http.test.mjs'), discovery: 'indirect-http', exclusive: true };
  const result = loadManifest(valid([db('tests/direct.test.mjs'), indirect]), {
    discovered: ['tests/direct.test.mjs', 'tests/http.test.mjs']
  });
  assert.equal(result.entries.length, 2);
});
