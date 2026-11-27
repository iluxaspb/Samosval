import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import manifest from './db-test-manifest.mjs';
import { discoverTests } from '../scripts/isolated-db/discovery.mjs';
import { canonicalReason, loadManifest } from '../scripts/isolated-db/manifest.mjs';
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
  // 90 roots: the inventory count is part of the contract, so adding a root
  // means updating it in the same commit as the manifest entry. 90 = 89 + the
  // S26 replica/restore fixture root added by Task 7 of the isolated-db suite.
  // 92 = 90 + the two Task 20 truck/transfer roots.
  // 93 = 92 + the Task 21 scoped line-operation root.
  // 94 = 93 + the Task 22 two-phase close root.
  // 95 = 94 + the Task 27 derived-effects root.
  assert.equal(discovery.roots.length, 95);
  assert.ok(discovery.roots.some(item => item.file === 'tests/isolated-db-s26-fixtures.test.mjs'));
  assert.ok(discovery.roots.some(item => item.file === 'tests/v2-truck-transfer-db.test.mjs'));
  assert.ok(discovery.roots.some(item => item.file === 'tests/v2-detached-completion-db.test.mjs'));
  assert.ok(discovery.roots.some(item => item.file === 'tests/v2-line-operations-db.test.mjs'));
  assert.ok(discovery.roots.some(item => item.file === 'tests/v2-shift-close-db.test.mjs'));
  assert.ok(discovery.roots.some(item => item.file === 'tests/replica-materialize-parallel-shifts.test.mjs'));
  assert.ok(manifest.harnessFixtures.includes('tests/fixtures/marker-tamper.test.mjs'));
  assert.ok(manifest.harnessFixtures.includes('tests/fixtures/isolated-db-process.test.mjs'));
  assert.ok(discovery.roots.some(item => item.file === 'tests/isolated-db-env.test.mjs' && item.kind === 'harness-contract'));
  assert.ok(discovery.roots.some(item => item.file === 'tests/isolated-db-process.test.mjs' && item.kind === 'harness-contract'));
  assert.ok(discovery.roots.some(item => item.file === 'tests/isolated-db-http-tree.test.mjs' && item.kind === 'harness-contract' && item.discovery === 'harness-contract'));
  assert.ok(discovery.roots.some(item => item.file === 'tests/isolated-db-lifecycle.test.mjs' && item.kind === 'harness-contract' && item.discovery === 'harness-contract'));
  // migration-registry needs CREATE DATABASE/TEMPLATE and the 025 role boundary,
  // which a db child (samosval_test_app, DML only) never receives: it is a
  // harness contract, not a db root. The root count itself is unchanged.
  assert.ok(discovery.roots.some(item => item.file === 'tests/migration-registry.test.mjs' && item.kind === 'harness-contract' && item.discovery === 'harness-contract'));
  assert.deepEqual(manifest.entries.find(item => item.file === 'tests/migration-registry.test.mjs').env, ['bootstrap-url']);
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
  const entry = { file: 'tests/a.test.mjs', kind: 'unit', discovery: 'pure-import', consumers: [] };
  entry.reason = canonicalReason(entry);
  await assert.rejects(loadManifest({ manifestVersion: 1, entries: [entry], harnessFixtures: [] }, { serverDirectory: root, discovered: [scanned] }), /classification drift.*db\/direct|consumer drift.*db-env/i);
});

test('consumer signature drift blocks manifest preflight independently of kind equality', async () => {
  const root = await fixture({ 'tests/a.test.mjs': "import " + "pg from 'pg';\n" });
  const [scanned] = (await discoverTests(root)).roots;
  const entry = {
    file: 'tests/a.test.mjs', kind: 'db', discovery: 'direct', consumers: ['tests/a.test.mjs:db-env'],
    baseline: 'S24', migrationsThrough: null, customSchema: [], importTables: [], fixtures: [], env: [], timeoutMs: 30_000, serial: false, exclusive: false, allowedSkips: []
  };
  entry.reason = canonicalReason(entry);
  await assert.rejects(loadManifest({ manifestVersion: 1, entries: [entry], harnessFixtures: [] }, { serverDirectory: root, discovered: [scanned] }), /consumer drift.*pg/i);
});

test('unregistered nested future root is never silently excluded', async () => {
  const root = await fixture({ 'tests/future/s26.test.mjs': "import test from 'node:test';\n" });
  const discovery = await discoverTests(root);
  assert.deepEqual(discovery.roots.map(item => item.file), ['tests/future/s26.test.mjs']);
});

test('filesystem discovery sees an untracked nested root inside a git repository', async () => {
  const root = await fixture({ 'tests/tracked.test.mjs': "import test from 'node:test';\n" });
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await run('git', ['init'], { cwd: root });
  await run('git', ['add', 'tests/tracked.test.mjs'], { cwd: root });
  await mkdir(join(root, 'tests', 'generated'), { recursive: true });
  await writeFile(join(root, 'tests', 'generated', 'untracked.test.mjs'), "import test from 'node:test';\n");
  const discovery = await discoverTests(root);
  assert.deepEqual(discovery.roots.map(item => item.file), ['tests/generated/untracked.test.mjs', 'tests/tracked.test.mjs']);
});

test('audited dependency is scanned and fails when its typed signature drifts', async () => {
  const root = await fixture({
    'tests/updater.test.mjs': "import test from 'node:test'; im" + "port '../updater/agent.mjs';\n",
    'updater/agent.mjs': "import " + "pg from 'pg';\nconst db = process.env." + "POSTGRES_DB;\n"
  });
  const audit = { 'tests/updater.test.mjs': { dependency: '../updater/agent.mjs', expectedConsumers: ['updater/agent.mjs:db-env', 'updater/agent.mjs:pg'], id: 'updater-release-only' } };
  const [entry] = (await discoverTests(root, { auditedDependencies: audit })).roots;
  assert.deepEqual(entry.consumers, ['audit:updater-release-only']);
  await writeFile(join(root, 'updater', 'agent.mjs'), "import " + "pg from 'pg';\nimport { execFile } from 'node:child_process';\nconst db = process.env." + "POSTGRES_DB;\n" + "exec" + "File(process.execPath, ['src/index.mjs']);\n");
  await assert.rejects(discoverTests(root, { auditedDependencies: audit }), /audited dependency drift.*updater-release-only.*http-child/i);
});

test('literal dynamic pg and local helper imports propagate typed consumers', async () => {
  const dynamicKeyword = ['im', 'port'].join('');
  const root = await fixture({
    'tests/dynamic.test.mjs': `await ${dynamicKeyword}('pg');\nawait ${dynamicKeyword}('../src/helper.mjs');\n`,
    'src/helper.mjs': "const db = process.env." + "TEST_DATABASE_URL;\n"
  });
  const [entry] = (await discoverTests(root)).roots;
  assert.deepEqual(entry.consumers, ['src/helper.mjs:db-env', 'tests/dynamic.test.mjs:pg']);
  await writeFile(join(root, 'tests', 'dynamic.test.mjs'), `const helperName = '../src/helper.mjs'; await ${dynamicKeyword}(helperName);\n`);
  await assert.rejects(discoverTests(root), /nonliteral dynamic import/i);
});

test('hardcoded database audit rejects count drift', async () => {
  const root = await fixture({ 'src/guard.mjs': "export const name = 'samosval_test';\n" });
  const allowlist = [{ file: 'src/guard.mjs', pattern: 'samosval_test', expectedCount: 1, reason: 'reserved-name guard' }];
  assert.equal((await auditHardcodedDatabaseNames(root, allowlist)).matches.length, 1);
  await writeFile(join(root, 'src', 'guard.mjs'), "export const names = ['samosval_test', 'samosval_test'];\n");
  await assert.rejects(auditHardcodedDatabaseNames(root, allowlist), /count drift.*src\/guard\.mjs/i);
});
