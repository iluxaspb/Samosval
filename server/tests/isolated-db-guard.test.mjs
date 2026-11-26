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
