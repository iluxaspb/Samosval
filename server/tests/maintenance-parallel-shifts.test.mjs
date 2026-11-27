import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract of the maintenance rehearsal CLI, exercised as a real child process:
// the script is refused or planned before it ever opens a connection, so this
// root stays a pure-import unit test with no PostgreSQL consumer.
const script = fileURLToPath(new URL('../scripts/maintenance-parallel-shifts.mjs', import.meta.url));

// A target that cannot be reached: if a dry-run tried to connect, the child
// would fail instead of printing its plan.
const UNREACHABLE = 'postgresql://rehearsal@127.0.0.1:1/samosval_parallel_shifts_test';

async function run(args, env = {}) {
  const child = execFile(process.execPath, [script, ...args], {
    env: {
      PATH: process.env.PATH,
      // Deliberately no database configuration: the rehearsal must refuse or
      // plan without one.
      ...env,
    },
  });
  const done = new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  return done;
}

async function runDir() {
  return mkdtemp(join(tmpdir(), 'samosval-maintenance-'));
}

test('dry-run is the default and prints the plan without any database', async () => {
  const directory = await runDir();
  try {
    const result = await run(['--phase', 'backup', '--run-dir', directory]);
    assert.equal(result.code, 0);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.phase, 'backup');
    assert.equal(plan.dryRun, true);
    assert.ok(plan.plan.includes('validate target'));
    // Nothing was written and no connection was attempted: the run directory
    // stays empty and the plan came back on an unreachable target.
    assert.deepEqual(await readdir(directory), []);
    const unreachable = await run(
      ['--phase', 'backup', '--run-dir', directory],
      { TEST_DATABASE_URL: UNREACHABLE, SAMOSVAL_ISOLATED_TEST: '1' },
    );
    assert.equal(unreachable.code, 0);
    assert.equal(JSON.parse(unreachable.stdout).dryRun, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('deploy, publish and restore are refused as out of scope', async () => {
  const directory = await runDir();
  try {
    for (const phase of ['deploy', 'publish', 'restore']) {
      const result = await run(['--phase', phase, '--run-dir', directory]);
      assert.equal(result.code, 2, phase);
      assert.match(result.stderr, /^maintenance: out-of-scope /);
      // The refusal names the manual path, never a database error.
      assert.match(result.stderr, /runbook|owner approval/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('--yes and --force do not exist: only the exact report hash confirms', async () => {
  const directory = await runDir();
  try {
    for (const flag of ['--yes', '--force', '--yes=true', '--force=1']) {
      const result = await run(['--phase', 'backup', '--run-dir', directory, flag]);
      assert.equal(result.code, 2, flag);
      assert.match(result.stderr, /forbidden-flag/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('dry-run names every prerequisite and reports the missing ones without failing', async () => {
  const directory = await runDir();
  try {
    const expected = {
      preflight: /backup\/manifest\.json/,
      confirm: /backup\/manifest\.json/,
      migrate: /backup\/manifest\.json/,
      verify: /migration\.json/,
      report: /verify\.json/,
    };
    for (const [phase, pattern] of Object.entries(expected)) {
      const result = await run(['--phase', phase, '--run-dir', directory]);
      assert.equal(result.code, 0, phase);
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.dryRun, true);
      assert.ok(plan.plan.some(step => pattern.test(step)), `${phase} plan names ${pattern}`);
      assert.ok(plan.missing.some(path => pattern.test(path)), `${phase} reports ${pattern} as missing`);
    }
    // confirm additionally previews the exact report files, not just the backup.
    const confirm = JSON.parse((await run(['--phase', 'confirm', '--run-dir', directory])).stdout);
    assert.ok(confirm.missing.some(path => /report\/report\.json/.test(path)));
    assert.ok(confirm.missing.some(path => /report\/report\.sha256/.test(path)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('--apply refuses to start without the previous phase artifact', async () => {
  const directory = await runDir();
  try {
    const env = {
      SAMOSVAL_ISOLATED_TEST: '1',
      TEST_DATABASE_URL: UNREACHABLE,
    };
    const expected = {
      preflight: /backup\/manifest\.json/,
      confirm: /backup\/manifest\.json/,
      migrate: /backup\/manifest\.json/,
      verify: /migration\.json/,
      report: /verify\.json/,
    };
    for (const [phase, pattern] of Object.entries(expected)) {
      const result = await run(['--phase', phase, '--run-dir', directory, '--apply'], env);
      assert.equal(result.code, 2, phase);
      assert.match(result.stderr, /phase-order-violation/);
      assert.match(result.stderr, pattern);
    }
    // The order check runs before the connection: the target is unreachable and
    // still never contacted.
    assert.ok(!(await run(['--phase', 'verify', '--run-dir', directory, '--apply'], env)).stderr.includes('ECONNREFUSED'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('apply requires the isolated marker and an approved database name', async () => {
  const directory = await runDir();
  try {
    const noMarker = await run(
      ['--phase', 'backup', '--run-dir', directory, '--apply'],
      { TEST_DATABASE_URL: UNREACHABLE },
    );
    assert.equal(noMarker.code, 2);
    assert.match(noMarker.stderr, /isolated-test-required/);

    const shared = await run(
      ['--phase', 'backup', '--run-dir', directory, '--apply'],
      {
        SAMOSVAL_ISOLATED_TEST: '1',
        TEST_DATABASE_URL: 'postgresql://rehearsal@127.0.0.1:1/main_workspace',
      },
    );
    assert.equal(shared.code, 2);
    assert.match(shared.stderr, /isolated-database-required/);

    const remoteHost = await run(
      ['--phase', 'backup', '--run-dir', directory, '--apply'],
      {
        SAMOSVAL_ISOLATED_TEST: '1',
        TEST_DATABASE_URL: 'postgresql://rehearsal@db.example.com:5432/samosval_parallel_shifts_test',
      },
    );
    assert.equal(remoteHost.code, 2);
    assert.match(remoteHost.stderr, /isolated-database-required/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('usage errors name the phase list and never echo the target', async () => {
  const directory = await runDir();
  try {
    const missingPhase = await run(['--run-dir', directory]);
    assert.equal(missingPhase.code, 2);
    assert.match(missingPhase.stderr, /--phase is required/);
    assert.match(missingPhase.stderr, /backup, preflight, confirm, migrate, verify, report/);

    const unknown = await run(['--phase', 'backup', '--run-dir', directory, '--dsn', UNREACHABLE]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown option --dsn/);
    assert.ok(!unknown.stderr.includes('rehearsal@'), 'the target must never be printed');

    const missingValue = await run(['--phase', 'confirm', '--run-dir', directory, '--report-sha256']);
    assert.equal(missingValue.code, 2);
    assert.match(missingValue.stderr, /--report-sha256 requires a value/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
