import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HARNESS_ENV_REGISTRY, UNIT_ENV_ALLOWLIST, buildDbEnv, buildHarnessEnv, buildUnitEnv,
} from '../scripts/isolated-db/env.mjs';

// Every child environment is built from a positive allowlist, never by copying
// the parent environment and deleting a couple of keys (spec 3.5).
function hostileSource() {
  return {
    PATH: '/usr/bin',
    HOME: '/home/tester',
    TMPDIR: '/tmp/samosval-ok',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'Europe/Moscow',
    ISOLATED_DB_SENTINEL: '/tmp/samosval-sentinel',
    ISOLATED_DB_SIGNAL_FIXTURE: '1',
    ISOLATED_DB_HTTP_FORCED_FAILURE: '1',
    ISOLATED_DB_PROCESS_LOG: '/tmp/samosval-process-log',
    NODE_OPTIONS: '--import=hostile.mjs',
    NODE_PATH: '/hostile/node-path',
    NODE_TEST_CONTEXT: 'parent-test-context',
    DATABASE_URL: 'postgresql://legacy-user:legacy-secret@db.example.test/legacy',
    TEST_DATABASE_URL: 'postgresql://legacy-user:legacy-secret@db.example.test/legacy',
    PGHOST: 'db.example.test',
    PGPORT: '5432',
    PGDATABASE: 'legacy',
    PGUSER: 'legacy-user',
    PGPASSWORD: 'legacy-secret',
    POSTGRES_DB: 'legacy',
    POSTGRES_USER: 'legacy-user',
    POSTGRES_PASSWORD: 'legacy-secret',
    SAMOSVAL_ISOLATED_TEST: '1',
    SAMOSVAL_TEST_ADMIN_URL: 'postgresql://orchestrator:orchestrator-secret@127.0.0.1:55432/postgres',
    SAMOSVAL_TEST_BOOTSTRAP_URL: 'postgresql://bootstrap-admin:bootstrap-secret@127.0.0.1:55432/postgres',
    SAMOSVAL_TEST_APP_PASSWORD: 'app-secret',
    SAMOSVAL_TEST_RUNTIME_PASSWORD: 'runtime-secret',
    SAMOSVAL_ORCHESTRATOR_PASSWORD: 'orchestrator-secret',
    UNRELATED_VARIABLE: 'value',
  };
}

const generatedTargetUrl = 'postgresql://samosval_test_app:generated-app-password@127.0.0.1:55432/samosval_parallel_shifts_test_0123456789ab_0123456789ab';

test('unit_env_is_positive_allowlist_without_any_database_alias', () => {
  const childEnv = buildUnitEnv(hostileSource());
  assert.deepEqual(Object.keys(childEnv).sort(), [...UNIT_ENV_ALLOWLIST].sort());
  for (const name of UNIT_ENV_ALLOWLIST) assert.equal(childEnv[name], hostileSource()[name]);
  assert.doesNotMatch(JSON.stringify(childEnv), /legacy-secret|orchestrator-secret|bootstrap-secret|db\.example\.test|POSTGRES_/, 'no database alias or credential reaches a unit child');
  assert.equal(buildUnitEnv({}).PATH, undefined);
  assert.throws(() => buildUnitEnv(null), /not approved/i);
});

test('unit_env_carries_the_http_forced_failure_fixture_marker', () => {
  // tests/truck-phone-http.test.mjs dies hard on this marker while its API
  // grandchild is alive, so tests/isolated-db-http-tree.test.mjs can prove the
  // runner reaps the whole group. Like ISOLATED_DB_SIGNAL_FIXTURE it is a
  // fixture marker, not a credential, and it must reach the db child.
  assert.ok(UNIT_ENV_ALLOWLIST.includes('ISOLATED_DB_HTTP_FORCED_FAILURE'));
  assert.equal(buildUnitEnv(hostileSource()).ISOLATED_DB_HTTP_FORCED_FAILURE, '1');
  assert.equal(buildDbEnv(hostileSource(), { targetUrl: generatedTargetUrl }).ISOLATED_DB_HTTP_FORCED_FAILURE, '1');
});

test('db_env_extends_the_unit_allowlist_with_only_the_generated_target_and_marker', () => {
  const childEnv = buildDbEnv(hostileSource(), { targetUrl: generatedTargetUrl });
  assert.deepEqual(Object.keys(childEnv).sort(), [...UNIT_ENV_ALLOWLIST, 'SAMOSVAL_ISOLATED_TEST', 'TEST_DATABASE_URL'].sort());
  assert.equal(childEnv.TEST_DATABASE_URL, generatedTargetUrl);
  assert.equal(childEnv.SAMOSVAL_ISOLATED_TEST, '1');
  for (const forbidden of ['SAMOSVAL_TEST_ADMIN_URL', 'SAMOSVAL_TEST_BOOTSTRAP_URL', 'SAMOSVAL_TEST_APP_PASSWORD', 'SAMOSVAL_TEST_RUNTIME_PASSWORD', 'SAMOSVAL_ORCHESTRATOR_PASSWORD', 'DATABASE_URL', 'PGHOST', 'PGUSER', 'PGPASSWORD']) {
    assert.equal(forbidden in childEnv, false, `${forbidden} must not reach a db child`);
  }
  // The generated target URL is the only database URL a db child ever sees.
  assert.equal(JSON.stringify(childEnv).match(/postgresql:\/\//g).length, 1);
});

test('db_env_rejects_an_unapproved_target_url', () => {
  for (const targetUrl of [undefined, '', 42, 'mysql://127.0.0.1/database', 'postgresql://']) {
    assert.throws(() => buildDbEnv(hostileSource(), { targetUrl }), /target URL is not approved/i, String(targetUrl));
  }
});

test('harness_env_grants_exactly_the_declared_dependencies_from_the_closed_registry', () => {
  const values = {
    'admin-url': 'postgresql://samosval_test_orchestrator:orchestrator-secret@127.0.0.1:55432/postgres',
    'bootstrap-url': 'postgresql://samosval_test_bootstrap_admin:bootstrap-secret@127.0.0.1:55432/postgres',
    'app-password': 'generated-app-password',
    'runtime-password': 'generated-runtime-password',
  };
  const childEnv = buildHarnessEnv(hostileSource(), { env: ['bootstrap-url', 'app-password'], values });
  assert.deepEqual(Object.keys(childEnv).sort(), [...UNIT_ENV_ALLOWLIST, 'SAMOSVAL_TEST_APP_PASSWORD', 'SAMOSVAL_TEST_BOOTSTRAP_URL'].sort());
  assert.equal(childEnv.SAMOSVAL_TEST_BOOTSTRAP_URL, values['bootstrap-url']);
  assert.equal(childEnv.SAMOSVAL_TEST_APP_PASSWORD, values['app-password']);
});

test('harness_env_fails_closed_on_unknown_or_missing_dependencies', () => {
  const values = { 'bootstrap-url': generatedTargetUrl, 'app-password': 'generated-app-password' };
  assert.throws(() => buildHarnessEnv(hostileSource(), { env: ['root-credentials'], values }), /not approved: root-credentials/i);
  assert.throws(() => buildHarnessEnv(hostileSource(), { env: ['bootstrap-url'], values: {} }), /no run value: bootstrap-url/i);
  assert.throws(() => buildHarnessEnv(hostileSource(), { env: ['target-url'], values }), /no run value: target-url/i);
  assert.throws(() => buildHarnessEnv(hostileSource(), { env: 'bootstrap-url', values }), /not approved/i);
});

test('harness_env_registry_is_closed_and_versioned', () => {
  assert.deepEqual(Object.keys(HARNESS_ENV_REGISTRY).sort(), ['admin-url', 'app-password', 'bootstrap-url', 'isolated-marker', 'maintenance-password', 'runtime-password', 'target-url']);
  assert.equal(HARNESS_ENV_REGISTRY['target-url'], 'TEST_DATABASE_URL');
  assert.equal(HARNESS_ENV_REGISTRY['isolated-marker'], 'SAMOSVAL_ISOLATED_TEST');
});

test('child_envs_never_carry_node_startup_or_test_context_variables', () => {
  const source = hostileSource();
  for (const childEnv of [
    buildUnitEnv(source),
    buildDbEnv(source, { targetUrl: generatedTargetUrl }),
    buildHarnessEnv(source, { env: ['bootstrap-url'], values: { 'bootstrap-url': generatedTargetUrl } }),
  ]) {
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT', 'UNRELATED_VARIABLE']) {
      assert.equal(name in childEnv, false, `${name} must never reach a child`);
    }
  }
});
