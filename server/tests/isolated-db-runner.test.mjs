import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const runner = new URL('../scripts/test-isolated-db.mjs', import.meta.url);
const shellLauncher = new URL('../scripts/test-isolated-db.sh', import.meta.url);
const sentinelTest = new URL('./fixtures/isolated-db-sentinel.test.mjs', import.meta.url);
const signalTest = new URL('./fixtures/sigterm-self.test.mjs', import.meta.url);
const injectionFixture = new URL('./fixtures/node-options-injection.mjs', import.meta.url);
const approvedUrl = 'postgresql://fixture-user:fixture-password@127.0.0.1:55432/samosval_parallel_shifts_test';

function run(env, args = [sentinelTest.pathname]) {
  const directory = mkdtempSync(join(tmpdir(), 'samosval-isolated-runner-'));
  const sentinel = join(directory, 'loaded');
  const result = spawnSync(process.execPath, [runner.pathname, ...args], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      SAMOSVAL_ISOLATED_TEST: undefined,
      TEST_DATABASE_URL: undefined,
      ...env,
      ISOLATED_DB_SENTINEL: sentinel,
    },
  });
  const loaded = existsSync(sentinel);
  rmSync(directory, { recursive: true, force: true });
  return { ...result, loaded };
}

test('isolated runner rejects unsafe target before loading tests and redacts credentials', () => {
  const secret = 'do-not-print-this';
  const result = run({
    SAMOSVAL_ISOLATED_TEST: '1',
    TEST_DATABASE_URL: `postgresql://fixture:${secret}@127.0.0.1:1/samosval_test`,
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.loaded, false);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});

test('isolated runner requires marker before loading tests', () => {
  const result = run({ TEST_DATABASE_URL: approvedUrl });
  assert.notEqual(result.status, 0);
  assert.equal(result.loaded, false);
  assert.match(result.stderr, /SAMOSVAL_ISOLATED_TEST=1 is required/);
});

test('isolated runner loads tests only after approved preflight', () => {
  const result = run({ SAMOSVAL_ISOLATED_TEST: '1', TEST_DATABASE_URL: approvedUrl });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.loaded, true, `${result.stdout}${result.stderr}`);
});

test('official direct shell entrypoint is executable and blocks hostile Node startup env', () => {
  const directory = mkdtempSync(join(tmpdir(), 'samosval-isolated-direct-'));
  const sentinel = join(directory, 'loaded');
  const mode = statSync(shellLauncher).mode & 0o777;
  const shellLines = readFileSync(shellLauncher, 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#!'));
  const result = spawnSync(shellLauncher.pathname, [sentinelTest.pathname], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      NODE_OPTIONS: `--import=${injectionFixture.href}`,
      NODE_PATH: join(directory, 'malicious-node-path'),
      SAMOSVAL_ISOLATED_TEST: undefined,
      TEST_DATABASE_URL: undefined,
      ISOLATED_DB_SENTINEL: sentinel,
    },
  });
  assert.notEqual(mode & 0o111, 0, 'official shell entrypoint must be executable');
  assert.equal(shellLines[0], 'unset NODE_OPTIONS NODE_PATH');
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(sentinel), false, `${result.stdout}${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /SAMOSVAL_ISOLATED_TEST=1 is required/);
  rmSync(directory, { recursive: true, force: true });
});

test('npm convenience alias is characterised as outside the hostile-env security boundary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'samosval-isolated-npm-characterisation-'));
  const sentinel = join(directory, 'loaded');
  const result = spawnSync('npm', ['run', 'test:db', '--', sentinelTest.pathname], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      NODE_OPTIONS: `--import=${injectionFixture.href}`,
      SAMOSVAL_ISOLATED_TEST: undefined,
      TEST_DATABASE_URL: undefined,
      ISOLATED_DB_SENTINEL: sentinel,
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(sentinel), true, 'parent npm executes NODE_OPTIONS before lifecycle shell');
  rmSync(directory, { recursive: true, force: true });
});

test('official documentation names only the direct shell command as hostile-env boundary', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /official security boundary[^\n]*\.\/scripts\/test-isolated-db\.sh/i);
  assert.match(readme, /npm run test:db[^\n]*convenience[^\n]*not[^\n]*security boundary/i);
});

test('direct launcher preserves SIGTERM from the nested Node test process', () => {
  const result = spawnSync(shellLauncher.pathname, [signalTest.pathname], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      NODE_OPTIONS: undefined,
      NODE_PATH: undefined,
      SAMOSVAL_ISOLATED_TEST: '1',
      TEST_DATABASE_URL: approvedUrl,
      ISOLATED_DB_SIGNAL_FIXTURE: '1',
    },
  });
  assert.equal(result.signal, 'SIGTERM', `${result.stdout}${result.stderr}`);
  assert.equal(result.status, null);
});

test('runner rejects options, traversal and symlink escape before child tests load', () => {
  const directory = mkdtempSync(join(tmpdir(), 'samosval-isolated-argv-'));
  const outside = join(directory, 'outside.test.mjs');
  const symlink = new URL('./fixtures/outside-link.test.mjs', import.meta.url);
  writeFileSync(outside, `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.ISOLATED_DB_SENTINEL, 'escaped');`);
  symlinkSync(outside, symlink.pathname);
  try {
    for (const arg of [
      `--import=${injectionFixture.href}`,
      '--require=./tests/fixtures/node-options-injection.mjs',
      '--test-reporter=spec',
      '../outside.test.mjs',
      symlink.pathname,
    ]) {
      const result = run({ SAMOSVAL_ISOLATED_TEST: '1', TEST_DATABASE_URL: approvedUrl }, [arg]);
      assert.notEqual(result.status, 0, arg);
      assert.equal(result.loaded, false, arg);
      assert.match(`${result.stdout}${result.stderr}`, /test path is not approved/i, arg);
    }
  } finally {
    rmSync(symlink, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('package test:db rejects unsafe URL before loading tests', () => {
  const directory = mkdtempSync(join(tmpdir(), 'samosval-isolated-package-'));
  const sentinel = join(directory, 'loaded');
  const secret = 'package-secret-must-stay-redacted';
  const result = spawnSync('npm', ['run', 'test:db', '--', sentinelTest.pathname], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      SAMOSVAL_ISOLATED_TEST: '1',
      TEST_DATABASE_URL: `postgresql://fixture:${secret}@127.0.0.1:1/samosval_test`,
      ISOLATED_DB_SENTINEL: sentinel,
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(sentinel), false);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
  rmSync(directory, { recursive: true, force: true });
});
