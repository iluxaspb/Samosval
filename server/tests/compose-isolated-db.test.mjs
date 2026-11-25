import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function resolveCompose() {
  for (const candidate of [
    { command: 'docker', prefix: ['compose'], filtersProfilesInConfig: true },
    { command: 'docker-compose', prefix: [], filtersProfilesInConfig: false },
  ]) {
    const result = spawnSync(candidate.command, [...candidate.prefix, 'version'], { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }
  return null;
}

const composeEnvironment = {
  ...process.env,
  POSTGRES_PASSWORD: 'compose-config-only',
  SAMOSVAL_ORCHESTRATOR_PASSWORD: 'compose-config-orchestrator',
  SAMOSVAL_TEST_APP_PASSWORD: 'compose-config-app',
  SAMOSVAL_TEST_RUNTIME_PASSWORD: 'compose-config-runtime',
  SAMOSVAL_TEST_MAINTENANCE_PASSWORD: 'compose-config-maintenance',
};

function renderCompose() {
  for (const command of [
    ['docker', ['compose', '-f', 'compose.test.yaml', 'config']],
    ['docker-compose', ['-f', 'compose.test.yaml', 'config']],
  ]) {
    const result = spawnSync(command[0], command[1], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: composeEnvironment,
    });
    if (result.status === 0) return result.stdout;
  }
  return null;
}

function legacyEffectiveServices(config, profile) {
  const services = new Map();
  let current = null;
  let section = null;
  for (const line of config.split(/\r?\n/)) {
    const service = /^  ([a-zA-Z0-9_-]+):$/.exec(line);
    if (service) {
      current = service[1];
      services.set(current, { profiles: [], dependencies: [] });
      section = null;
      continue;
    }
    if (!current) continue;
    const heading = /^    (profiles|depends_on):$/.exec(line);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (section === 'profiles') {
      const value = /^    - (.+)$/.exec(line);
      if (value) {
        services.get(current).profiles.push(value[1]);
        continue;
      }
    }
    if (section === 'depends_on') {
      const value = /^      ([a-zA-Z0-9_-]+):$/.exec(line);
      if (value) {
        services.get(current).dependencies.push(value[1]);
        continue;
      }
    }
    if (!line.startsWith('      ')) section = null;
  }
  const active = new Set([...services].filter(([, value]) => (
    profile ? value.profiles.includes(profile) : value.profiles.length === 0
  )).map(([name]) => name));
  for (const name of active) {
    for (const dependency of services.get(name).dependencies) active.add(dependency);
  }
  return [...active].sort();
}

test('available compose resolver enforces exact default, test and api service sets', t => {
  const compose = resolveCompose();
  if (!compose) return t.skip('docker compose and docker-compose are unavailable');
  const invoke = profile => spawnSync(compose.command, [
    ...compose.prefix, '-f', 'compose.test.yaml', ...(profile ? ['--profile', profile] : []),
    'config', ...(compose.filtersProfilesInConfig ? ['--services'] : []),
  ], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: composeEnvironment,
  });
  const effective = profile => {
    const result = invoke(profile);
    assert.equal(result.status, 0, result.stderr);
    return compose.filtersProfilesInConfig
      ? result.stdout.trim().split(/\s+/).filter(Boolean).sort()
      : legacyEffectiveServices(result.stdout, profile);
  };
  assert.deepEqual(effective(null), []);
  assert.deepEqual(effective('test'), ['postgres']);
  assert.deepEqual(effective('api'), []);
});

test('compose exposes only the ephemeral bootstrap database on loopback', t => {
  const config = renderCompose();
  if (!config) return t.skip('docker compose is unavailable');
  assert.match(config, /POSTGRES_DB: postgres/);
  assert.match(config, /log_parameter_max_length=0/);
  assert.match(config, /log_parameter_max_length_on_error=0/);
  assert.match(config, /bootstrap\.sh/);
  assert.match(config, /bootstrap\.sql/);
  assert.match(config, /127\.0\.0\.1/);
  assert.match(config, /55432/);
  assert.match(config, /tmpfs:[\s\S]*\/var\/lib\/postgresql\/data/);
  assert.doesNotMatch(config, /0\.0\.0\.0/);
  assert.doesNotMatch(config, /samosval_parallel_shifts_test\s*$/m);
});

test('compose defers API profile until capability preflight has an owning task', t => {
  const config = renderCompose();
  if (!config) return t.skip('docker compose is unavailable');
  assert.doesNotMatch(config, /^  api:$/m);
  assert.doesNotMatch(config, /SAMOSVAL_API_TARGET_DATABASE|SAMOSVAL_CLEANUP_CAPABILITY|18080/);
});
