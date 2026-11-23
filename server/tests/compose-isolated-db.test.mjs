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

function renderCompose() {
  for (const command of [
    ['docker', ['compose', '-f', 'compose.test.yaml', 'config']],
    ['docker-compose', ['-f', 'compose.test.yaml', 'config']],
  ]) {
    const result = spawnSync(command[0], command[1], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: { ...process.env, POSTGRES_PASSWORD: 'compose-config-only' },
    });
    if (result.status === 0) return result.stdout;
  }
  return null;
}

test('available compose resolver reports exact service sets for both profiles', t => {
  const compose = resolveCompose();
  if (!compose) return t.skip('docker compose and docker-compose are unavailable');
  const services = profile => spawnSync(compose.command, [
    ...compose.prefix, '-f', 'compose.test.yaml', '--profile', profile, 'config', '--services',
  ], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, POSTGRES_PASSWORD: 'compose-config-only' },
  });
  const testProfile = services('test');
  const apiProfile = services('api');
  assert.equal(testProfile.status, 0, testProfile.stderr);
  assert.equal(apiProfile.status, 0, apiProfile.stderr);
  const expectedTest = compose.filtersProfilesInConfig ? ['postgres'] : ['api', 'postgres'];
  assert.deepEqual(testProfile.stdout.trim().split(/\s+/).sort(), expectedTest);
  assert.deepEqual(apiProfile.stdout.trim().split(/\s+/).sort(), ['api', 'postgres']);
});

test('compose exposes only the ephemeral isolated database on loopback', t => {
  const config = renderCompose();
  if (!config) return t.skip('docker compose is unavailable');
  assert.match(config, /samosval_parallel_shifts_test/);
  assert.match(config, /127\.0\.0\.1/);
  assert.match(config, /55432/);
  assert.match(config, /tmpfs:[\s\S]*\/var\/lib\/postgresql\/data/);
  assert.doesNotMatch(config, /0\.0\.0\.0/);
});

test('compose preserves the documented API flow behind an explicit profile', t => {
  const config = renderCompose();
  if (!config) return t.skip('docker compose is unavailable');
  assert.match(config, /api:/);
  assert.match(config, /profiles:[\s\S]*api/);
  assert.match(config, /127\.0\.0\.1/);
  assert.match(config, /18080/);
});
