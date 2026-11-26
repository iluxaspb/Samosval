import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Обслуживание БД (рестарт, kill сессии, terminate при очистке) не должно
// выключать API. Раньше одиночный обрыв простаивающего соединения пула ронял
// процесс через unhandled 'error'. Здесь это проверяется на живом API:
// прибиваем все сессии целевой БД привилегированным соединением и требуем,
// чтобы процесс остался жив, /health/live отвечал, а пул переподключился.

const port = 18098;
const origin = `http://127.0.0.1:${port}`;
const serverDirectory = fileURLToPath(new URL('..', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function portFree() {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(false));
    socket.once('timeout', () => finish(true));
    socket.once('error', () => finish(true));
  });
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await pause(100);
  }
  return predicate();
}

test('the API survives termination of its database sessions and reconnects', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  assert.ok(process.env.SAMOSVAL_TEST_BOOTSTRAP_URL, 'the manifest must provide bootstrap-url to this root');
  assert.equal(await portFree(), true, `port ${port} must be free before the test`);
  const dbUrl = new URL(process.env.TEST_DATABASE_URL);
  const dbEnv = {
    POSTGRES_DB: decodeURIComponent(dbUrl.pathname.slice(1)),
    POSTGRES_USER: decodeURIComponent(dbUrl.username),
    POSTGRES_PASSWORD: decodeURIComponent(dbUrl.password),
    PGHOST: dbUrl.hostname,
    PGPORT: dbUrl.port || '5432',
  };
  let child;
  let exited = false;
  let exitPromise = Promise.resolve();
  let stderr = '';
  let admin;
  try {
    child = spawn(process.execPath, ['src/index.mjs'], {
      cwd: serverDirectory,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...dbEnv,
        AUTH_SESSION_SECRET: '5c'.repeat(32),
        FIREBASE_PROJECT_ID: 'synthetic-pool-qa',
        WORKSPACE_ID: 'main_workspace',
        PORT: String(port),
        ALLOWED_ORIGINS: origin,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    exitPromise = once(child, 'exit').catch(() => {});
    child.once('exit', () => { exited = true; });
    child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr = (stderr + chunk).slice(0, 4000); });

    const live = await waitUntil(async () => {
      if (exited) return false;
      const response = await fetch(`${origin}/health/live`).catch(() => null);
      return response?.status === 200;
    });
    assert.equal(live, true, `the API did not start: ${stderr}`);

    const ready = await fetch(`${origin}/health/ready`);
    await ready.text();
    assert.equal(ready.status, 200, `the API is not database-ready before termination: ${stderr}`);

    // Привилегированное соединение прибивает все прочие сессии этой целевой
    // БД — ровно то, что делает обслуживание базы или kill сессии.
    admin = new pg.Client({
      connectionString: process.env.SAMOSVAL_TEST_BOOTSTRAP_URL,
      application_name: 'samosval_pool_resilience',
    });
    await admin.connect();
    const terminated = await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
    );
    assert.ok(terminated.rowCount > 0, 'no database session was terminated, the scenario was not exercised');

    await pause(500);
    assert.equal(exited, false, `the API process died after its database session was terminated: ${stderr}`);

    const healthy = await waitUntil(async () => {
      if (exited) return false;
      const response = await fetch(`${origin}/health/live`).catch(() => null);
      return response?.status === 200;
    });
    assert.equal(healthy, true, `the API stopped answering /health/live after termination: ${stderr}`);

    const recovered = await waitUntil(async () => {
      const response = await fetch(`${origin}/health/ready`).catch(() => null);
      return response?.status === 200;
    });
    assert.equal(recovered, true, `the API pool did not reconnect to the database: ${stderr}`);
    const payload = await (await fetch(`${origin}/health/ready`)).json();
    assert.deepEqual(payload, { status: 'ready', database: 'connected' });
  } finally {
    if (admin) await admin.end().catch(() => {});
    if (child && !exited) {
      child.kill('SIGTERM');
      await Promise.race([exitPromise, pause(3000)]);
    }
    if (child && !exited) {
      child.kill('SIGKILL');
      await Promise.race([exitPromise, pause(3000)]);
    }
  }
  assert.equal(await portFree(), true, `port ${port} is still busy after teardown`);
});
