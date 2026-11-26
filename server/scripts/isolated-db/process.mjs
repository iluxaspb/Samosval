// Process group supervision for the isolated database suite (I5).
//
// One test file = one process group. The child is spawned detached (its own
// process group leader) so a timeout or a forwarded signal can stop the whole
// tree, including database clients a test file may have spawned. Escalation is
// TERM -> grace -> KILL, and the child is fully reaped (its exit event is
// received) before the promise resolves or the parent re-emits a signal.

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_GRACE_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const TRUNCATION_NOTICE = '\n[output truncated]';

export function createSignalController() {
  const activeStops = new Set();
  let interrupted = null;
  let closed = false;
  let stopPromise = Promise.resolve();

  const onSignal = signal => {
    if (interrupted) return;
    interrupted = signal;
    stopPromise = Promise.allSettled([...activeStops].map(stop => stop(signal)));
  };
  const handlers = new Map([
    ['SIGINT', () => onSignal('SIGINT')],
    ['SIGTERM', () => onSignal('SIGTERM')],
    ['SIGHUP', () => onSignal('SIGHUP')],
  ]);
  for (const [signal, handler] of handlers) process.on(signal, handler);

  return {
    register(stop) {
      if (typeof stop !== 'function') refuse('signal stop handler must be a function');
      if (closed) refuse('signal controller is closed');
      if (interrupted) {
        stopPromise = Promise.allSettled([stop(interrupted), stopPromise]);
        return () => {};
      }
      activeStops.add(stop);
      return () => activeStops.delete(stop);
    },
    interrupt(signal) {
      if (!handlers.has(signal)) refuse('signal is not approved');
      if (interrupted) refuse('signal controller already interrupted');
      onSignal(signal);
    },
    async wait() {
      await stopPromise;
      return { signal: interrupted };
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      activeStops.clear();
    },
  };
}

function refuse(message) { throw new Error(`process group request is not approved: ${message}`); }

function requirePositiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) refuse(`${name} is required`);
}

class BoundedRedactingSink {
  constructor(limit, redact) {
    this.limit = limit;
    this.redact = redact;
    this.chunks = [];
    this.length = 0;
    this.truncated = false;
  }

  push(chunk) {
    if (this.truncated) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    if (this.length > this.limit) {
      const whole = this.chunks.join('');
      // Reserve room for the truncation notice so the final text stays bounded.
      this.chunks = [whole.slice(0, this.limit - TRUNCATION_NOTICE.length)];
      this.length = this.chunks[0].length;
      this.truncated = true;
    }
  }

  text() {
    let whole = this.chunks.join('');
    if (this.truncated) whole += TRUNCATION_NOTICE;
    return typeof this.redact === 'function' ? this.redact(whole) : whole;
  }
}

function signalGroup(child, signal) {
  // A negative pid addresses the whole process group led by the child.
  if (typeof child.pid !== 'number') return;
  try { process.kill(-child.pid, signal); } catch { /* the group is already gone */ }
}

function groupEmpty(pid) {
  // ESRCH means no member of the group is left. A zombie leader does not keep
  // the group alive once it has been reaped by libuv, so this also settles a
  // clean, well-behaved exit immediately.
  try { process.kill(-pid, 0); return false; } catch { return true; }
}

/**
 * Run one command as its own process group and resolve only after the group
 * leader is reaped. Options:
 *   command, args, cwd, env   - the spawn surface; env must be a pre-built
 *                               child environment (see env.mjs).
 *   timeoutMs                 - wall clock budget for the group (default 30s).
 *   graceMs                   - delay between TERM and KILL (default 2s).
 *   maxOutputBytes            - captured stdout/stderr bound per stream.
 *   redact                    - function applied to captured output.
 *   forwardSignals            - install parent SIGINT/SIGTERM handlers that
 *                               stop the group, wait for the reap, and then
 *                               re-emit the same signal to the parent.
 */
export async function runProcessGroup(request) {
  if (request === null || typeof request !== 'object') refuse('a request object is required');
  const {
    command, args, cwd, env = {},
    timeoutMs = 30_000, graceMs = DEFAULT_GRACE_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, redact,
    forwardSignals = false, signalController,
  } = request;
  if (typeof command !== 'string' || command === '') refuse('command is required');
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) refuse('args must be a string array');
  if (env === null || typeof env !== 'object' || Array.isArray(env)) refuse('env must be an object');
  requirePositiveNumber(timeoutMs, 'timeoutMs');
  requirePositiveNumber(graceMs, 'graceMs');
  requirePositiveNumber(maxOutputBytes, 'maxOutputBytes');
  if (redact !== undefined && typeof redact !== 'function') refuse('redact must be a function');

  let child;
  try {
    child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error && /ENOENT/i.test(String(error.code || error.message))) {
      throw new Error(`spawn ENOENT: ${command}`);
    }
    throw error;
  }

  const stdout = new BoundedRedactingSink(maxOutputBytes, redact);
  const stderr = new BoundedRedactingSink(maxOutputBytes, redact);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));

  const exited = new Promise(resolve => {
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  // A process that never spawned (ENOENT) never emits 'exit'; surface that as
  // a rejection instead of waiting for a reap that cannot happen.
  const failed = new Promise((_, reject) => {
    child.once('error', reject);
  });

  let timedOut = false;
  let pendingReemit = null;
  const previousHandlers = new Map();

  const stopGroup = async (reason, signal) => {
    timedOut = reason === 'timeout';
    if (reason === 'signal' && forwardSignals) pendingReemit = signal;
    signalGroup(child, 'SIGTERM');
    const outcome = await Promise.race([exited, delay(graceMs).then(() => null)]);
    if (outcome === null) signalGroup(child, 'SIGKILL');
    await exited;
    if (pendingReemit) {
      const name = pendingReemit;
      pendingReemit = null;
      process.kill(process.pid, name);
    }
  };

  const timer = setTimeout(() => { stopGroup('timeout'); }, timeoutMs);
  timer.unref?.();

  const unregister = signalController?.register(signal => stopGroup('signal', signal));

  const signalNames = forwardSignals ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : [];
  for (const name of signalNames) {
    previousHandlers.set(name, process.listeners(name).slice());
    process.removeAllListeners(name);
    process.once(name, () => {
      clearTimeout(timer);
      stopGroup('signal', name);
    });
  }

  const cleanup = () => {
    clearTimeout(timer);
    unregister?.();
    for (const [name, handlers] of previousHandlers) {
      process.removeAllListeners(name);
      for (const handler of handlers) process.on(name, handler);
    }
  };

  let outcome;
  try {
    outcome = await Promise.race([exited, failed]);
  } finally {
    cleanup();
  }

  // Descendants outlive their leader: a test file that spawns an API server can
  // die with a non-zero exit and leave that server (and its own children) in the
  // group. The leader is already reaped at this point, so a plain -pid signal
  // still reaches every surviving member. Do this before resolving: the caller
  // drops the target database right after, and a live client would either keep
  // the drop from succeeding or poison the next run.
  if (typeof child.pid === 'number' && !groupEmpty(child.pid)) {
    signalGroup(child, 'SIGTERM');
    const termDeadline = Date.now() + graceMs;
    while (!groupEmpty(child.pid) && Date.now() < termDeadline) await delay(25);
    if (!groupEmpty(child.pid)) {
      signalGroup(child, 'SIGKILL');
      const killDeadline = Date.now() + DEFAULT_GRACE_MS;
      while (!groupEmpty(child.pid) && Date.now() < killDeadline) await delay(25);
    }
  }

  return {
    pid: child.pid,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut,
    truncated: stdout.truncated || stderr.truncated,
    stdout: stdout.text(),
    stderr: stderr.text(),
  };
}
