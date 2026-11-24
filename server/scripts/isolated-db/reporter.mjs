// TAP machine event parser. Each file child runs one node --test file, so
// indented TAP events are its individual tests; the unindented wrapper event
// is the file-level aggregate and is not counted a second time.

function refuse(message) { throw new Error(`reporter request is not approved: ${message}`); }

const EVENT_RE = /^(\s*)(ok|not ok) (\d+) - (.*)$/;

function sanitize(value, secrets) {
  let output = String(value ?? '');
  for (const secret of secrets) if (typeof secret === 'string' && secret) output = output.replaceAll(secret, '[redacted]');
  // Remove URI userinfo without retaining username/password or credentials.
  output = output.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/gi, '$1');
  // Capabilities are 256-bit lowercase hex and are never reportable.
  output = output.replace(/\b[a-f0-9]{64}\b/g, '[redacted]');
  return output;
}

export function parseNodeEvents(tap, { allowedSkips = [], secrets = [] } = {}) {
  if (typeof tap !== 'string') refuse('TAP output is required');
  if (!Array.isArray(allowedSkips) || !Array.isArray(secrets)) refuse('skip and secret registries must be arrays');

  const matches = tap.split(/\r?\n/).map(line => EVENT_RE.exec(line)).filter(Boolean);
  const hasIndented = matches.some(match => match[1].length > 0);
  const events = [];
  const counts = { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
  for (const match of matches) {
    if (hasIndented && match[1].length === 0) continue;
    const [, , result, number, description] = match;
    const skipMatch = /\s+# SKIP(?:\s+(.*))?$/.exec(description);
    const todoMatch = /\s+# TODO(?:\s+(.*))?$/.exec(description);
    const name = (skipMatch ? description.slice(0, skipMatch.index) : todoMatch ? description.slice(0, todoMatch.index) : description).trim();
    const reason = skipMatch?.[1]?.trim() ?? todoMatch?.[1]?.trim();
    const skipped = Boolean(skipMatch);
    const todo = Boolean(todoMatch);
    const allowedSkip = skipped && allowedSkips.some(entry => entry?.name === name && entry?.reason === reason);
    const event = {
      number: Number(number),
      name: sanitize(name, secrets),
      status: skipped ? 'skipped' : result === 'ok' ? 'passed' : 'failed',
    };
    if (reason !== undefined) event.reason = sanitize(reason, secrets);
    if (skipped) event.allowedSkip = allowedSkip;
    if (todo) event.todo = true;
    events.push(event);

    counts.tests += 1;
    if (skipped) counts.skipped += 1;
    else if (todo) counts.todo += 1;
    else if (result === 'ok') counts.passed += 1;
    else counts.failed += 1;
  }
  const unexpectedSkips = events.filter(event => event.status === 'skipped' && !event.allowedSkip);
  return {
    events: Object.freeze(events),
    counts: Object.freeze(counts),
    unexpectedSkips: Object.freeze(unexpectedSkips),
    ok: counts.tests > 0 && counts.failed === 0 && unexpectedSkips.length === 0,
  };
}
