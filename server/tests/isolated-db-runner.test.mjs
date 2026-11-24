import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { scheduleManifestJobs } from '../scripts/isolated-db/scheduler.mjs';
import { parseNodeEvents } from '../scripts/isolated-db/reporter.mjs';
import { writeAtomicReport } from '../scripts/isolated-db/report.mjs';

const runner = new URL('../scripts/test-isolated-db.mjs', import.meta.url);
const shellLauncher = new URL('../scripts/test-isolated-db.sh', import.meta.url);
const sentinelTest = new URL('./fixtures/isolated-db-sentinel.test.mjs', import.meta.url);
const signalTest = new URL('./fixtures/sigterm-self.test.mjs', import.meta.url);
const injectionFixture = new URL('./fixtures/node-options-injection.mjs', import.meta.url);
const approvedUrl = 'postgresql://fixture-user:fixture-password@127.0.0.1:55432/samosval_parallel_shifts_test';

function run(env, args = [sentinelTest.pathname]) {
  const directory = mkdtempSync(join(tmpdir(), 'samosval-isolated-runner-'));
  const sentinel = env.ISOLATED_DB_SENTINEL ?? join(directory, 'loaded');
  const result = spawnSync(process.execPath, [runner.pathname, ...args], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
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

test('isolated runner loads a unit selection without a database URL', () => {
  const result = run({ SAMOSVAL_ISOLATED_TEST: '1' });
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
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
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
   assert.equal(existsSync(sentinel), false, 'the new runner rejects before loading the test child');
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
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      NODE_TEST_CONTEXT: undefined,
      NODE_OPTIONS: undefined,
      NODE_PATH: undefined,
      SAMOSVAL_ISOLATED_TEST: '1',
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
       const result = run({ SAMOSVAL_ISOLATED_TEST: '1' }, [arg]);
      assert.notEqual(result.status, 0, arg);
      assert.equal(result.loaded, false, arg);
       assert.match(`${result.stdout}${result.stderr}`, /test path is not approved|canonical.*symlink/i, arg);
    }
  } finally {
    rmSync(symlink, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy selection starts every approved file in a distinct process group', () => {
  const directory = mkdtempSync(join(tmpdir(), 'samosval-isolated-groups-'));
  const log = join(directory, 'pids');
  try {
    const fixture = new URL('./fixtures/isolated-db-process.test.mjs', import.meta.url);
    const result = run({
      SAMOSVAL_ISOLATED_TEST: '1',
      ISOLATED_DB_PROCESS_LOG: log,
    }, [fixture.pathname, fixture.pathname]);
    assert.equal(result.status, 0, result.stderr);
    const pids = readFileSync(log, 'utf8').trim().split(/\r?\n/);
    assert.equal(pids.length, 2);
    assert.notEqual(pids[0], pids[1]);
    assert.notEqual(Number(pids[0]), process.pid);
    assert.notEqual(Number(pids[1]), process.pid);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('selection runs an unclassified file with a unit child environment and no database variables', () => {
  const directory = mkdtempSync(join(tmpdir(), 'samosval-isolated-envprobe-'));
  const envLog = join(directory, 'env');
  try {
    const result = run({
      SAMOSVAL_ISOLATED_TEST: '1',
      SAMOSVAL_TEST_ADMIN_URL: 'postgresql://admin:admin-secret@127.0.0.1:55432/postgres',
      SAMOSVAL_TEST_APP_PASSWORD: 'app-secret',
      SAMOSVAL_TEST_RUNTIME_PASSWORD: 'runtime-secret',
      SAMOSVAL_TEST_BOOTSTRAP_URL: 'postgresql://bootstrap:bootstrap-secret@127.0.0.1:55432/postgres',
      DATABASE_URL: 'postgresql://alias:alias-secret@127.0.0.1:55432/alias',
      PGHOST: '127.0.0.1',
      POSTGRES_PASSWORD: 'postgres-secret',
      ISOLATED_DB_SENTINEL: envLog,
    }, [sentinelTest.pathname]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const names = readFileSync(envLog, 'utf8').split('\n');
    assert.ok(names.includes('PATH'), 'tooling variables survive');
    for (const forbidden of [
      'TEST_DATABASE_URL', 'SAMOSVAL_ISOLATED_TEST', 'DATABASE_URL', 'PGHOST', 'POSTGRES_PASSWORD',
      'SAMOSVAL_TEST_ADMIN_URL', 'SAMOSVAL_TEST_APP_PASSWORD', 'SAMOSVAL_TEST_RUNTIME_PASSWORD', 'SAMOSVAL_TEST_BOOTSTRAP_URL',
      'NODE_OPTIONS', 'NODE_PATH',
    ]) {
      assert.equal(names.includes(forbidden), false, `${forbidden} must not reach a unit child`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('selection rejects a harness entry without privileged URL before loading tests', () => {
  const result = run({
    SAMOSVAL_ISOLATED_TEST: '1',
  }, [new URL('./isolated-db-bootstrap.test.mjs', import.meta.url).pathname]);
  assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.loaded, false);
  assert.match(result.stderr, /privileged isolated database URL is required/i);
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

test('failure_continues_and_exclusive_waits_for_all_jobs', async () => {
  const entries = [
    { file: 'tests/a.test.mjs' },
    { file: 'tests/b.test.mjs' },
    { file: 'tests/c.test.mjs', exclusive: true },
    { file: 'tests/d.test.mjs' },
  ];
  const events = [];
  const gates = new Map();
  for (const entry of entries) gates.set(entry.file, {});
  const gate = file => new Promise(resolve => { gates.get(file).resolve = resolve; });
  const scheduled = scheduleManifestJobs({
    entries,
    jobs: 2,
    runJob: async entry => {
      events.push(`start:${entry.file}`);
      await gate(entry.file);
      events.push(`end:${entry.file}`);
      if (entry.file === 'tests/b.test.mjs') throw new Error('fixture assertion failure');
      return { status: 'passed' };
    },
  });

  // The first normal pair starts concurrently and the next exclusive entry
  // cannot start until both have settled (including the failed job).
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['start:tests/a.test.mjs', 'start:tests/b.test.mjs']);
  gates.get('tests/b.test.mjs').resolve();
  gates.get('tests/a.test.mjs').resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.slice(-3), ['end:tests/b.test.mjs', 'end:tests/a.test.mjs', 'start:tests/c.test.mjs']);

  // The exclusive job blocks later normal work until its own completion.
  assert.equal(events.includes('start:tests/d.test.mjs'), false);
  gates.get('tests/c.test.mjs').resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1), 'start:tests/d.test.mjs');
  gates.get('tests/d.test.mjs').resolve();

  const results = await scheduled;
  assert.deepEqual(results.map(result => result.file), entries.map(entry => entry.file));
  assert.equal(results[1].status, 'failed');
  assert.match(results[1].error, /fixture assertion failure/);
  assert.equal(results[3].status, 'passed', 'a failure does not stop later files');
});

test('reporter parses machine events and makes unexpected skips failures', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: example.test.mjs',
    '    ok 1 - ordinary test',
    '    ok 2 - documented platform skip # SKIP unsupported on this platform',
    '    ok 3 - unexpected skip # SKIP missing environment',
    '    not ok 4 - failed assertion',
    '    1..4',
    'not ok 1 - example.test.mjs',
    '1..1',
    '# tests 4',
    '# pass 1',
    '# fail 1',
    '# skipped 2',
  ].join('\n');
  const parsed = parseNodeEvents(tap, {
    allowedSkips: [{ name: 'documented platform skip', reason: 'unsupported on this platform' }],
  });
  assert.deepEqual(parsed.counts, { tests: 4, passed: 1, failed: 1, skipped: 2, todo: 0 });
  assert.equal(parsed.events.find(event => event.name === 'documented platform skip').allowedSkip, true);
  assert.deepEqual(parsed.unexpectedSkips.map(event => event.name), ['unexpected skip']);
  assert.equal(parsed.ok, false);
});

test('reporter redacts capability and database URL from emitted events', () => {
  const secret = 'a'.repeat(64);
  const tap = `TAP version 13\nnot ok 1 - failure at postgresql://user:pw@127.0.0.1:55432/db # ${secret}\n# tests 1\n# pass 0\n# fail 1\n# skipped 0`;
  const parsed = parseNodeEvents(tap, { secrets: [secret, 'pw'] });
  const encoded = JSON.stringify(parsed);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes('user:pw@'), false);
});

test('atomic report is stable, redacted, and replaces only a regular report file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'samosval-report-'));
  const reportPath = join(directory, 'report.json');
  try {
    const secret = 'database-password-do-not-print';
    await writeAtomicReport(reportPath, {
      selection: 'filtered',
      files: [
        { file: 'tests/z.test.mjs', status: 'passed' },
        { file: 'tests/a.test.mjs', status: 'failed', detail: `postgresql://user:${secret}@127.0.0.1:55432/db` },
      ],
    });
    const saved = readFileSync(reportPath, 'utf8');
    const parsed = JSON.parse(saved);
    assert.deepEqual(parsed.files.map(file => file.file), ['tests/a.test.mjs', 'tests/z.test.mjs']);
    assert.equal(saved.includes(secret), false);
    assert.match(saved, /postgresql:\/\/127\.0\.0\.1:55432\/db/);
    assert.equal(lstatSync(reportPath).isFile(), true);
    await writeAtomicReport(reportPath, { selection: 'full', files: [] });
    assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).selection, 'full');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
