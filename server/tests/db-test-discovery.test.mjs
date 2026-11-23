import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import manifest from './db-test-manifest.mjs';
import { discoverTests } from '../scripts/isolated-db/discovery.mjs';
import { auditHardcodedDatabaseNames } from '../scripts/isolated-db/hardcoded-db-audit.mjs';

const serverDirectory = new URL('..', import.meta.url);

test('discovered_equals_manifest_including_existing_replica_root', async () => {
  const discovery = await discoverTests(serverDirectory);
  assert.deepEqual(discovery.roots.map(item => item.file), manifest.entries.map(item => item.file));
  assert.deepEqual(
    discovery.roots.map(({ file, kind, discovery: classification }) => ({ file, kind, discovery: classification })),
    manifest.entries.map(({ file, kind, discovery: classification }) => ({ file, kind, discovery: classification }))
  );
  assert.ok(discovery.roots.some(item => item.file === 'tests/replica-materialize-parallel-shifts.test.mjs'));
});

test('discovery follows imports and identifies indirect DB consumers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'samosval-discovery-'));
  await mkdir(join(root, 'tests'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'tests', 'indirect.test.mjs'), "import '../src/store.mjs';\n");
  await writeFile(join(root, 'src', 'store.mjs'), "import pg from 'pg'; export const pool = new pg.Pool();\n");
  const discovery = await discoverTests(root);
  assert.deepEqual(discovery.roots, [{
    file: 'tests/indirect.test.mjs',
    kind: 'db',
    discovery: 'direct',
    consumers: ['src/store.mjs:pg']
  }]);
});

test('hardcoded database audit rejects count drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'samosval-audit-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'guard.mjs'), "export const name = 'samosval_test';\n");
  const allowlist = [{ file: 'src/guard.mjs', pattern: 'samosval_test', expectedCount: 1, reason: 'reserved-name guard' }];
  assert.equal((await auditHardcodedDatabaseNames(root, allowlist)).matches.length, 1);
  await writeFile(join(root, 'src', 'guard.mjs'), "export const names = ['samosval_test', 'samosval_test'];\n");
  await assert.rejects(auditHardcodedDatabaseNames(root, allowlist), /count drift.*src\/guard\.mjs/i);
});
