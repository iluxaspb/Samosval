import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalReason, loadManifest } from '../scripts/isolated-db/manifest.mjs';

const withReason = entry => ({ ...entry, reason: canonicalReason(entry) });
const unit = (file = 'tests/a.test.mjs') => withReason({ file, kind: 'unit', discovery: 'pure-import', consumers: [] });
const db = (file = 'tests/a.test.mjs') => {
  const entry = {
    file, kind: 'db', discovery: 'direct', consumers: [`${file}:pg`],
    baseline: 'S24', migrationsThrough: null, customSchema: [], importTables: [], fixtures: [], env: [], timeoutMs: 30_000, serial: false, exclusive: false, allowedSkips: []
  };
  return withReason(entry);
};
const valid = entries => ({ manifestVersion: 1, entries, harnessFixtures: [] });

async function tree(files = ['tests/a.test.mjs']) {
  const root = await mkdtemp(join(tmpdir(), 'samosval-manifest-'));
  for (const file of files) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '');
  }
  return root;
}

test('manifest rejects missing, duplicate and stale roots', async () => {
  const root = await tree(['tests/a.test.mjs', 'tests/b.test.mjs']);
  await assert.rejects(loadManifest(valid([unit()]), { serverDirectory: root, discovered: [{ file: 'tests/a.test.mjs', kind: 'unit', discovery: 'pure-import', consumers: [] }, { file: 'tests/b.test.mjs', kind: 'unit', discovery: 'pure-import', consumers: [] }] }), /missing.*b\.test/i);
  await assert.rejects(loadManifest(valid([unit(), unit()]), { serverDirectory: root }), /duplicate.*a\.test/i);
  await assert.rejects(loadManifest(valid([unit(), unit('tests/stale.test.mjs')]), { serverDirectory: root }), /missing file.*stale/i);
});

test('manifest accepts exactly version 1 and rejects future schema', async () => {
  const root = await tree();
  await assert.rejects(loadManifest({ ...valid([unit()]), manifestVersion: 2 }, { serverDirectory: root }), /unsupported manifestVersion/i);
});

test('manifest rejects traversal, absolute, missing and symlink paths', async () => {
  const root = await tree();
  const outside = join(await mkdtemp(join(tmpdir(), 'samosval-outside-')), 'outside.test.mjs');
  await writeFile(outside, '');
  await assert.rejects(loadManifest(valid([unit('../outside.test.mjs')]), { serverDirectory: root }), /canonical relative test path/i);
  await assert.rejects(loadManifest(valid([unit(outside)]), { serverDirectory: root }), /canonical relative test path/i);
  await assert.rejects(loadManifest(valid([unit('tests/missing.test.mjs')]), { serverDirectory: root }), /missing file/i);
  await symlink(outside, join(root, 'tests', 'link.test.mjs'));
  await assert.rejects(loadManifest(valid([unit('tests/link.test.mjs')]), { serverDirectory: root }), /symlink|canonical/i);
});

test('manifest rejects unknown closed-registry references', async () => {
  const root = await tree();
  for (const [field, value] of [['fixtures', ['future-fixture']], ['customSchema', ['future-schema']], ['importTables', ['future-import']]]) {
    await assert.rejects(loadManifest(valid([{ ...db(), [field]: value }]), { serverDirectory: root }), new RegExp(`unknown ${field}`));
  }
  await assert.rejects(loadManifest(valid([{ ...db(), allowedSkips: [{ name: 'skip', reason: '' }] }]), { serverDirectory: root }), /invalid allowedSkips/i);
});

test('manifest rejects env dependencies outside the closed harness registry', async () => {
  const root = await tree();
  await assert.rejects(loadManifest(valid([{ ...db(), env: ['raw-password'] }]), { serverDirectory: root }), /unknown env/i);
  await assert.rejects(loadManifest(valid([{ ...db(), env: ['bootstrap-url', 'bootstrap-url'] }]), { serverDirectory: root }), /duplicate env/i);
  await loadManifest(valid([{ ...db(), env: ['bootstrap-url'] }]), { serverDirectory: root });
});

test('manifest validates migration chain against baseline', async () => {
  const root = await tree();
  await assert.rejects(loadManifest(valid([{ ...db(), migrationsThrough: 23 }]), { serverDirectory: root }), /migration chain/i);
});

test('manifest keeps registered fixture paths separate and canonical', async () => {
  const root = await tree(['tests/a.test.mjs', 'tests/fixtures/worker.test.mjs']);
  await loadManifest({ ...valid([unit()]), harnessFixtures: ['tests/fixtures/worker.test.mjs'] }, { serverDirectory: root });
  await assert.rejects(loadManifest({ ...valid([unit()]), harnessFixtures: ['tests/a.test.mjs'] }, { serverDirectory: root }), /fixture.*root|fixture path/i);
});

test('manifest reason is canonical for exact classification and consumers', async () => {
  const root = await tree();
  await assert.rejects(loadManifest(valid([{ ...unit(), reason: 'Stale authored prose that is long enough' }]), { serverDirectory: root }), /reason drift/i);
});

test('manifest rejects unknown fields and incomplete DB metadata', async () => {
  const root = await tree();
  await assert.rejects(loadManifest(valid([{ ...unit(), surprise: true }]), { serverDirectory: root }), /unknown field.*surprise/i);
  const incomplete = db(); delete incomplete.timeoutMs;
  await assert.rejects(loadManifest(valid([incomplete]), { serverDirectory: root }), /timeoutMs/);
});
