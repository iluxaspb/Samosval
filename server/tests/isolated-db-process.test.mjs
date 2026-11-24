import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createSignalController, runProcessGroup } from '../scripts/isolated-db/process.mjs';

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const serverDirectory = dirname(testsDirectory);
const processModuleUrl = pathToFileURL(join(serverDirectory, 'scripts/isolated-db/process.mjs')).href;
const reservedFixture = join(testsDirectory, 'fixtures/isolated-db-process.test.mjs');

function makeWorkspace() {
  const directory = mkdtempSync('/tmp/opencode/i5-process-');
  return {
    directory,
    path(name) { return join(directory, name); },
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

function writeScript(workspace, name, body) {
  const file = workspace.path(name);
  writeFileSync(file, body);
  return file;
}

function awaitExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function waitForLines(file, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
    if (lines.length >= count) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} lines in ${file}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function waitForGone(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(alive)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for pids to exit: ${pids.filter(alive).join(',')}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('reaps the child and reports a clean process group exit', { timeout: 8000 }, async () => {
  const workspace = makeWorkspace();
  try {
    const log = workspace.path('process.log');
    const outcome = await runProcessGroup({
      command: process.execPath,
      // isolation=none keeps the fixture in the runner process, so the pid the
      // fixture records is exactly the process group leader being supervised.
      args: ['--test', '--experimental-test-isolation=none', reservedFixture],
      cwd: serverDirectory,
      env: { PATH: process.env.PATH, ISOLATED_DB_PROCESS_LOG: log },
      timeoutMs: 10_000,
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.signal, null);
    assert.equal(outcome.timedOut, false);
    assert.ok(outcome.pid > 0 && outcome.pid !== process.pid, 'the child is its own process');
    const recorded = readFileSync(log, 'utf8').trim().split('\n').map(Number);
    assert.deepEqual(recorded, [outcome.pid]);
    assert.equal(alive(outcome.pid), false, 'the child is reaped before resolution');
  } finally {
    workspace.cleanup();
  }
});

test('a child runs in its own process group and SIGTERM reaches every member before the parent re-emits', { timeout: 15000 }, async () => {
  const workspace = makeWorkspace();
  try {
    const pidsFile = workspace.path('pids');
    const readyFile = workspace.path('driver-ready');
    const target = writeScript(workspace, 'spawn-group.mjs', `
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
writeFileSync(process.env.PIDS_FILE, process.pid + '\\n' + grandchild.pid + '\\n');
setTimeout(() => {}, 5000);
`);
    const driver = writeScript(workspace, 'driver.mjs', `
import { writeFileSync } from 'node:fs';
import { runProcessGroup } from ${JSON.stringify(processModuleUrl)};
writeFileSync(process.env.READY_FILE, String(process.pid));
await runProcessGroup({
  command: process.execPath,
  args: [process.env.TARGET_SCRIPT],
  cwd: process.cwd(),
  env: process.env,
  timeoutMs: 30_000,
  graceMs: 300,
  forwardSignals: true,
});
`);
    const driverChild = spawn(process.execPath, [driver], {
      cwd: serverDirectory,
      env: {
        PATH: process.env.PATH,
        PIDS_FILE: pidsFile,
        READY_FILE: readyFile,
        TARGET_SCRIPT: target,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = awaitExit(driverChild);
    await waitForFile(pidsFile, 4000);
    const [childPid, grandchildPid] = readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number);
    assert.ok(childPid > 0 && grandchildPid > 0 && childPid !== grandchildPid);
    assert.ok(alive(childPid) && alive(grandchildPid), 'the group is running before the signal');
    assert.ok(groupAlive(childPid), 'the child leads its own process group');
    // The separation proof: the group-wide TERM below must not reach this
    // parent (or the driver). If the child shared the parent group, this test
    // process would die before its assertions complete.

    driverChild.kill('SIGTERM');
    const driverExit = await exited;
    assert.deepEqual(driverExit, { exitCode: null, signal: 'SIGTERM' }, 'the parent re-emits the received signal');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(alive(childPid), false, 'the child is reaped before the parent re-emits');
    assert.equal(alive(grandchildPid), false, 'the whole group, not only the leader, is terminated');
  } finally {
    workspace.cleanup();
  }
});

test('timeout escalates from SIGTERM to SIGKILL when TERM is ignored and the group is still reaped', { timeout: 8000 }, async () => {
  const workspace = makeWorkspace();
  try {
    const stubborn = writeScript(workspace, 'stubborn.mjs', `
process.on('SIGTERM', () => {});
setTimeout(() => {}, 3000);
`);
    const started = Date.now();
    const outcome = await runProcessGroup({
      command: process.execPath,
      args: [stubborn],
      cwd: serverDirectory,
      env: { PATH: process.env.PATH },
      timeoutMs: 300,
      graceMs: 200,
    });
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.exitCode, null);
    assert.equal(outcome.signal, 'SIGKILL');
    assert.ok(Date.now() - started < 2500, 'escalation does not wait for the stubborn child');
    assert.equal(alive(outcome.pid), false, 'an escalated child is still reaped');
  } finally {
    workspace.cleanup();
  }
});

test('a signal controller stops the active groups and re-emits only after every group is reaped', { timeout: 20000 }, async () => {
  const workspace = makeWorkspace();
  try {
    const pidsFile = workspace.path('controller-pids');
    const target = writeScript(workspace, 'controller-target.mjs', `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.CONTROLLER_PIDS, process.pid + '\\n');
setTimeout(() => {}, 8000);
`);
    const controller = createSignalController(pidsFile);
    const groups = [];
    for (let index = 0; index < 2; index += 1) {
      groups.push(runProcessGroup({
        command: process.execPath,
        args: [target],
        cwd: serverDirectory,
        env: { PATH: process.env.PATH, CONTROLLER_PIDS: pidsFile },
        timeoutMs: 60_000,
        signalController: controller,
      }));
    }
    await waitForLines(pidsFile, 2, 5000);
    const childPids = readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number);
    assert.equal(childPids.length, 2);
    assert.ok(childPids.every(pid => groupAlive(pid)));

    controller.interrupt('SIGTERM');
    const reemit = await controller.wait();
    assert.equal(reemit.signal, 'SIGTERM');
    assert.ok(childPids.every(pid => !alive(pid)), 'every active group is fully reaped before the re-emit');
    assert.throws(() => controller.interrupt('SIGTERM'), /already interrupted/i);
    await Promise.allSettled(groups);
    controller.close();
  } finally {
    workspace.cleanup();
  }
});

test('a signal controller handles SIGHUP once and remains idempotent', async () => {
  const controller = createSignalController();
  try {
    controller.interrupt('SIGHUP');
    assert.equal((await controller.wait()).signal, 'SIGHUP');
    assert.equal((await controller.wait()).signal, 'SIGHUP');
    assert.throws(() => controller.interrupt('SIGHUP'), /already interrupted/i);
  } finally {
    controller.close();
  }
});

test('captured output is redacted and bounded', { timeout: 8000 }, async () => {
  const workspace = makeWorkspace();
  try {
    const secret = 'samosval-capability-0123456789abcdef';
    const noisy = writeScript(workspace, 'noisy.mjs', `
process.stdout.write('CAPABILITY:${secret}\\n');
process.stderr.write('CAPABILITY:${secret}\\n');
for (let i = 0; i < 64; i++) process.stdout.write('x'.repeat(1000) + '\\n');
`);
    const outcome = await runProcessGroup({
      command: process.execPath,
      args: [noisy],
      cwd: serverDirectory,
      env: { PATH: process.env.PATH },
      timeoutMs: 5000,
      redact: text => text.replaceAll(secret, '[redacted]'),
      maxOutputBytes: 4096,
    });
    assert.equal(outcome.exitCode, 0);
    assert.ok(outcome.stdout.includes('CAPABILITY:[redacted]'));
    assert.ok(outcome.stderr.includes('CAPABILITY:[redacted]'));
    for (const stream of [outcome.stdout, outcome.stderr]) {
      assert.ok(!stream.includes(secret), 'the secret never reaches the captured output');
    }
    assert.equal(outcome.truncated, true);
    assert.ok(outcome.stdout.length <= 4096, 'captured stdout is bounded');
  } finally {
    workspace.cleanup();
  }
});

test('a missing command fails fast and the request surface is validated', { timeout: 3000 }, async () => {
  await assert.rejects(
    () => runProcessGroup({ command: '/nonexistent/samosval-enoent', args: [], env: {}, timeoutMs: 1000 }),
    /enoent|spawn/i,
  );
  for (const invalid of [
    { command: '', args: [] },
    { command: 'node', args: 'not-an-array' },
    { command: 'node', args: ['--test'], env: 'not-an-object' },
    { command: 'node', args: ['--test'], timeoutMs: 0 },
    { command: 'node', args: ['--test'], graceMs: -1 },
  ]) {
    await assert.rejects(() => runProcessGroup(invalid), /not approved/i, JSON.stringify(invalid));
  }
});
