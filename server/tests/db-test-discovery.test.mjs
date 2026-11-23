import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import manifest from './db-test-manifest.mjs';
import { discoverTests } from '../scripts/isolated-db/discovery.mjs';
import { loadManifest } from '../scripts/isolated-db/manifest.mjs';
import { auditHardcodedDatabaseNames } from '../scripts/isolated-db/hardcoded-db-audit.mjs';

const serverDirectory = new URL('..', import.meta.url);

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'samosval-discovery-'));
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, source);
  }
  return root;
}

test('discovered_equals_manifest_including_existing_replica_root', async () => {
  const discovery = await discoverTests(serverDirectory, { harnessFixtures: manifest.harnessFixtures });
  await loadManifest(manifest, { serverDirectory, discovered: discovery.roots });
  assert.equal(discovery.roots.length, 63);
  assert.ok(discovery.roots.some(item => item.file === 'tests/replica-materialize-parallel-shifts.test.mjs'));
});

test('recursive discovery reports an unexpected nested root but excludes only a registered fixture', async () => {
  const root = await fixture({
    'tests/root.test.mjs': "import test from 'node:test';\n",
    'tests/generated/new.test.mjs': "import test from 'node:test';\n",
    'tests/fixtures/registered.test.mjs': "import test from 'node:test';\n"
  });
  const discovery = await discoverTests(root, { harnessFixtures: ['tests/fixtures/registered.test.mjs'] });
  assert.deepEqual(discovery.roots.map(item => item.file), ['tests/generated/new.test.mjs', 'tests/root.test.mjs']);
  await assert.rejects(loadManifest({ manifestVersion: 1, entries: [], harnessFixtures: ['tests/fixtures/registered.test.mjs'] }, { serverDirectory: root, discovered: discovery.roots }), /missing root entry.*generated\/new/i);
});

test('typed import graph propagates multiline execFile HTTP child from an imported helper', async () => {
  const root = await fixture({
    'tests/http.test.mjs': "import '../src/start-api.mjs';\n",
    'src/start-api.mjs': "import { execFile } from 'node:child_process';\n" + "exec" + "File(\n process.execPath,\n ['src/index.mjs']\n);\n"
  });
  const [entry] = (await discoverTests(root)).roots;
  assert.equal(entry.kind, 'db');
  assert.equal(entry.discovery, 'indirect-http');
  assert.deepEqual(entry.consumers, ['src/start-api.mjs:http-child']);
});

test('audited classification cannot erase a newly injected DB signal', async () => {
  const root = await fixture({ 'tests/a.test.mjs': "import test from 'node:test';\nconst url = process.env." + "TEST_DATABASE_URL;\n" });
  const [scanned] = (await discoverTests(root)).roots;
  const entry = { file: 'tests/a.test.mjs', kind: 'unit', discovery: 'pure-import', reason: 'Pure synthetic test with no database access', consumers: [] };
  await assert.rejects(loadManifest({ manifestVersion: 1, entries: [entry], harnessFixtures: [] }, { serverDirectory: root, discovered: [scanned] }), /classification drift.*db\/direct|consumer drift.*db-env/i);
});

test('consumer signature drift blocks manifest preflight independently of kind equality', async () => {
  const root = await fixture({ 'tests/a.test.mjs': "import pg from 'pg';\n" });
  const [scanned] = (await discoverTests(root)).roots;
  const entry = {
    file: 'tests/a.test.mjs', kind: 'db', discovery: 'direct', reason: 'Imports pg directly for a synthetic PostgreSQL contract', consumers: ['tests/a.test.mjs:db-env'],
    baseline: 'S24', migrationsThrough: null, customSchema: [], importTables: [], fixtures: [], timeoutMs: 30_000, serial: false, exclusive: false, allowedSkips: []
  };
  await assert.rejects(loadManifest({ manifestVersion: 1, entries: [entry], harnessFixtures: [] }, { serverDirectory: root, discovered: [scanned] }), /consumer drift.*pg/i);
});

test('unregistered nested future root is never silently excluded', async () => {
  const root = await fixture({ 'tests/future/s26.test.mjs': "import test from 'node:test';\n" });
  const discovery = await discoverTests(root);
  assert.deepEqual(discovery.roots.map(item => item.file), ['tests/future/s26.test.mjs']);
});

test('hardcoded database audit rejects count drift', async () => {
  const root = await fixture({ 'src/guard.mjs': "export const name = 'samosval_test';\n" });
  const allowlist = [{ file: 'src/guard.mjs', pattern: 'samosval_test', expectedCount: 1, reason: 'reserved-name guard' }];
  assert.equal((await auditHardcodedDatabaseNames(root, allowlist)).matches.length, 1);
  await writeFile(join(root, 'src', 'guard.mjs'), "export const names = ['samosval_test', 'samosval_test'];\n");
  await assert.rejects(auditHardcodedDatabaseNames(root, allowlist), /count drift.*src\/guard\.mjs/i);
});
