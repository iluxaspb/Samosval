import test from 'node:test';
import assert from 'node:assert/strict';

import {
  requireIsolatedDatabase,
  resetIsolatedDatabase,
} from './helpers/isolated-db.mjs';

const isolatedUrl = 'postgresql://fixture-user:fixture-password@postgres:5432/samosval_parallel_shifts_test';
const harnessUrl = 'postgresql://fixture-user:fixture-password@postgres:5432/samosval_parallel_shifts_test_abcdef012345_0123456789ab';

function withIsolatedEnvironment(values, operation) {
  const previous = Object.fromEntries(
    Object.keys(values).map(key => [key, process.env[key]])
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(operation)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test('rejects_reserved_and_live_database_names', async () => {
  await withIsolatedEnvironment({ SAMOSVAL_ISOLATED_TEST: '1' }, () => {
    for (const url of [
      'postgresql://fixture@postgres:5432/samosval_test',
      'postgresql://fixture@postgres:5432/samosval_working_test_reserve',
      'postgresql://fixture@samosval-test.iluxa.pro:5432/samosval_parallel_shifts_test',
      'postgresql://fixture@postgres:5432/samosval_parallel_shifts_test_deadbeef',
      'postgresql://fixture@postgres:5432/samosval_parallel_shifts_test_abcdef012345_0123456789a',
      'postgresql://fixture@postgres:5432/samosval_parallel_shifts_test_abcdef01234_0123456789ab',
      'postgresql://fixture@postgres:5432/samosval_parallel_shifts_test_abcdef012345_0123456789ab_extra',
      'postgresql://fixture@postgres:5432/samosval_parallel_shifts_test_ABCDEF012345_0123456789ab',
      'postgresql://fixture@postgres:5432/samosval_parallel_shifts_test_abcdef012345_tpl_s24',
    ]) {
      assert.throws(() => requireIsolatedDatabase(url), /isolated database target is not approved/i);
    }
  });
});

test('accepts_generated_harness_target', async () => {
  await withIsolatedEnvironment({ SAMOSVAL_ISOLATED_TEST: '1' }, () => {
    const approved = requireIsolatedDatabase(harnessUrl);
    assert.ok(approved instanceof URL);
    assert.equal(approved.hostname, 'postgres');
    assert.equal(approved.pathname, '/samosval_parallel_shifts_test_abcdef012345_0123456789ab');
  });
});

test('rejects_connection_query_overrides', async () => {
  await withIsolatedEnvironment({ SAMOSVAL_ISOLATED_TEST: '1' }, () => {
    for (const query of [
      'host=live.example',
      'hostaddr=203.0.113.7',
      'dbname=samosval_test',
      'service=live',
      'passfile=/tmp/live.pass',
      'sslmode=require',
      'application_name=isolated-test',
      'unknown=value',
    ]) {
      assert.throws(
        () => requireIsolatedDatabase(`${isolatedUrl}?${query}`),
        /isolated database target is not approved/i
      );
      assert.throws(
        () => requireIsolatedDatabase(`${harnessUrl}?${query}`),
        /isolated database target is not approved/i
      );
    }
  });
});

test('handles URL delimiter and encoding edge cases with default deny', async () => {
  await withIsolatedEnvironment({ SAMOSVAL_ISOLATED_TEST: '1' }, () => {
    const cases = [
      [`${isolatedUrl}?host=postgres&host=live.example`, false],
      ['postgresql://fixture-user:fixture-password@postgres:5432/samosval%5Fparallel%5Fshifts%5Ftest', true],
      ['postgresql://fixture-user:fixture-password@postgres:5432/samosval%2Fparallel_shifts_test', false],
      ['postgresql://fixture-user:fixture-password@postgres:5432/samosval%ZZparallel_shifts_test', false],
      [`${isolatedUrl}#fragment`, false],
      [`${isolatedUrl}?`, true],
    ];
    for (const [url, accepted] of cases) {
      if (accepted) assert.equal(decodeURIComponent(requireIsolatedDatabase(url).pathname.slice(1)), 'samosval_parallel_shifts_test');
      else assert.throws(() => requireIsolatedDatabase(url), /isolated database target is not approved/i);
    }
  });
});

test('accepts_compose_test_database', async () => {
  await withIsolatedEnvironment({ SAMOSVAL_ISOLATED_TEST: '1' }, () => {
    const approved = requireIsolatedDatabase(isolatedUrl);
    assert.ok(approved instanceof URL);
    assert.equal(approved.hostname, 'postgres');
    assert.equal(approved.pathname, '/samosval_parallel_shifts_test');
  });

  await withIsolatedEnvironment({ SAMOSVAL_ISOLATED_TEST: undefined }, () => {
    assert.throws(() => requireIsolatedDatabase(isolatedUrl), /SAMOSVAL_ISOLATED_TEST=1 is required/);
  });
});

test('reset_never_uses_unapproved_url', async () => {
  await withIsolatedEnvironment({
    SAMOSVAL_ISOLATED_TEST: undefined,
    TEST_DATABASE_URL: 'postgresql://fixture@127.0.0.1:1/samosval_parallel_shifts_test',
  }, async () => {
    await assert.rejects(resetIsolatedDatabase(), /SAMOSVAL_ISOLATED_TEST=1 is required/);
  });

  await withIsolatedEnvironment({
    SAMOSVAL_ISOLATED_TEST: '1',
    TEST_DATABASE_URL: 'postgresql://fixture@127.0.0.1:1/samosval_test',
  }, async () => {
    await assert.rejects(resetIsolatedDatabase(), /isolated database target is not approved/i);
  });
});

// CI runs on a fresh ubuntu runner: /tmp/opencode and /home/<owner> do not
// exist there. A test that hard-codes such a path fails with ENOENT on the gate
// while passing on the owner's server, which hides a green/red difference
// between machines. Use os.tmpdir()/mkdtempSync instead.
test('no test or harness module hard_codes an owner-only absolute path', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  // Only what CI actually runs. scripts/*.mjs also holds owner-only manual
  // tools (control-check-firebase-login) whose defaults are overridable by env
  // and never executed on the gate.
  const roots = ['tests', 'scripts/isolated-db'];
  // Only quoted literals count, so the explanation comments stay allowed.
  const forbidden = [/['"`]\/tmp\/opencode\//, /['"`]\/home\/iluxa\//];
  const offenders = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await walk(path);
        continue;
      }
      if (!/\.(mjs|js|cjs|sh)$/.test(entry.name)) continue;
      const source = await readFile(path, 'utf8');
      for (const pattern of forbidden) {
        if (pattern.test(source)) offenders.push(path);
      }
    }
  };
  for (const root of roots) await walk(root);
  assert.deepEqual(offenders, []);
});
