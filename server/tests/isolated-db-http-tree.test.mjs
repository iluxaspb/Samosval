import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Task 9 contract: the HTTP root spawns a real API server as a grandchild of the
// runner. When that test process dies hard, the runner must reap the whole
// process group (the server included), drop the generated target database, and
// leave the suite able to run the same root again.
//
// The forced failure also leaves a plain sleeper descendant and records its pid:
// the real API server additionally dies from the backend termination during
// cleanup (its pool has no 'error' handler), so the sleeper is what proves the
// group reap itself, not the cleanup side effect.
//
// This root drives the real runner as a nested child, so the assertion is about
// the shipped mechanism, not about a mock.

const serverDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(serverDirectory, 'scripts/test-isolated-db.mjs');
const httpRoot = 'tests/truck-phone-http.test.mjs';
const origin = 'http://127.0.0.1:18099';

async function apiAnswers() {
  try {
    const response = await fetch(`${origin}/health/live`);
    await response.text().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return predicate();
}

async function generatedTargets() {
  const client = new pg.Client({ connectionString: process.env.SAMOSVAL_TEST_ADMIN_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'samosval_parallel_shifts_test_%' ORDER BY 1",
    );
    return rows.map(row => row.datname);
  } finally {
    await client.end();
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function orphanPids(report) {
  try {
    return readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function runHttpRoot({ directory, name, forced }) {
  const report = join(directory, `${name}.json`);
  const result = spawnSync(process.execPath, [runner, '--file', httpRoot, '--report', report], {
    cwd: serverDirectory,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      SAMOSVAL_ISOLATED_TEST: '1',
      SAMOSVAL_TEST_ADMIN_URL: process.env.SAMOSVAL_TEST_ADMIN_URL,
      SAMOSVAL_TEST_BOOTSTRAP_URL: process.env.SAMOSVAL_TEST_BOOTSTRAP_URL,
      SAMOSVAL_TEST_APP_PASSWORD: process.env.SAMOSVAL_TEST_APP_PASSWORD,
      ISOLATED_DB_HTTP_FORCED_FAILURE: forced ? '1' : undefined,
      // The forced failure leaves one extra descendant (a plain sleeper, no
      // database) and records its pid here: the API itself also dies from the
      // backend termination during cleanup, so only this descendant can prove
      // the process group was reaped.
      ISOLATED_DB_PROCESS_LOG: join(directory, `${name}.orphans.log`),
    },
  });
  return { result, report };
}

test('a forced HTTP child failure reaps the API grandchild, drops its target and the next run passes', async () => {
  assert.equal(process.env.SAMOSVAL_ISOLATED_TEST, '1', 'this root runs inside the harness');
  const before = await generatedTargets();
  assert.equal(await apiAnswers(), false, 'port 18099 must be free before the run');
  const directory = mkdtempSync(join(tmpdir(), 'samosval-http-tree-'));
  const orphans = join(directory, 'forced.orphans.log');
  let [orphan] = orphanPids(orphans);
  try {
    const forced = runHttpRoot({ directory, name: 'forced', forced: true });
    assert.equal(forced.result.status, 1, `${forced.result.stdout}${forced.result.stderr}`);
    const forcedReport = JSON.parse(readFileSync(forced.report, 'utf8'));
    assert.equal(forcedReport.selection, 'filtered');
    assert.equal(forcedReport.attempted, 1);
    assert.equal(forcedReport.failed, 1);
    assert.equal(forcedReport.files[0].status, 'failed');
    assert.equal(forcedReport.cleanup, 'complete');
    assert.deepEqual(forcedReport.leaks, []);

    // 1. The descendants of the failed file must be gone with its process
    //    group. The sleeper is the discriminating witness: the real API server
    //    also dies on its own when cleanup terminates its backends, so without
    //    the group reap only this descendant would survive.
    const recorded = orphanPids(orphans);
    assert.equal(recorded.length, 1, 'the forced failure must record exactly one orphan pid');
    [orphan] = recorded;
    await waitUntil(async () => !alive(orphan));
    assert.equal(alive(orphan), false, 'the orphaned descendant survived the group kill');
    // 2. The API server itself must be gone as well.
    assert.equal(await waitUntil(async () => (await apiAnswers()) === false), true, 'the API server survived the group kill');
    // 3. The generated target must be dropped, not leaked.
    assert.deepEqual(await generatedTargets(), before, 'the failed run leaked its generated target');

    // 4. The follow-up run of the same root must pass, proving the previous
    //    forced failure left nothing behind that poisons the suite.
    const followup = runHttpRoot({ directory, name: 'followup', forced: false });
    assert.equal(followup.result.status, 0, `${followup.result.stdout}${followup.result.stderr}`);
    const followupReport = JSON.parse(readFileSync(followup.report, 'utf8'));
    assert.equal(followupReport.passed, 1);
    assert.equal(followupReport.cleanup, 'complete');
    assert.deepEqual(followupReport.leaks, []);
    assert.deepEqual(await generatedTargets(), before, 'the follow-up run leaked its generated target');
  } finally {
    // A failed assertion above must not leave the sleeper running on the host.
    if (orphan && alive(orphan)) { try { process.kill(orphan, 'SIGKILL'); } catch {} }
    rmSync(directory, { recursive: true, force: true });
  }
});
