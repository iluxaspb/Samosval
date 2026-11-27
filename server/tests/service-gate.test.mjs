import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  MAINTENANCE_BODY,
  PROTOCOL_UPGRADE_BODY,
  applyServiceGate,
  maintenanceDecision,
  maintenanceExempt,
  maintenanceMode,
  protocolDecision,
  serviceGate,
  v2ShiftsEnabled,
} from '../src/service-gate.mjs';

// Server gate for the coordinated rollout window (design §9, §13, plan Task 29A).
//
// `service-gate.mjs` is pure and `index.mjs` calls it exactly once, after
// origin/CORS and the health probes and before any body read or domain call.
// These roots prove the contract of that one call — statuses, exact bodies,
// exemptions and the "maintenance wins over upgrade" order — without a
// database, a port or a child process.

const ON = {SAMOSVAL_MAINTENANCE: '1'};
const V2 = {SAMOSVAL_V2_SHIFTS: '1'};

function probe({path, method = 'GET', env = {}}) {
  const sent = [];
  const res = {tag: 'response'};
  const handled = applyServiceGate({
    path,
    method,
    res,
    env,
    send: (target, status, body) => { sent.push({target, status, body}); },
  });
  return {handled, sent, res, status: sent[0]?.status, body: sent[0]?.body};
}

const LEGACY_V1_ROUTES = [
  ['POST', '/api/v1/shifts/start'],
  ['POST', '/api/v1/shifts/close'],
  ['GET', '/api/v1/line/snapshot'],
  ['POST', '/api/v1/line/operations'],
  ['POST', '/api/v1/report/operations'],
  ['GET', '/api/v1/history'],
  ['POST', '/api/v1/history'],
  ['POST', '/api/v1/archive/operations'],
  ['POST', '/api/v1/controls'],
];

// --- switches ---------------------------------------------------------------

test('maintenanceMode is true only for the exact value 1', () => {
  assert.equal(maintenanceMode({SAMOSVAL_MAINTENANCE: '1'}), true);
  for (const value of ['0', 'true', '1 ', ' 1', '01', '', 'yes', 'on']) {
    assert.equal(maintenanceMode({SAMOSVAL_MAINTENANCE: value}), false, `value ${JSON.stringify(value)}`);
  }
  assert.equal(maintenanceMode({}), false);
  assert.equal(maintenanceMode({SAMOSVAL_MAINTENANCE: undefined}), false);
  assert.equal(maintenanceMode(undefined), false);
  assert.equal(maintenanceMode(null), false);
});

test('v2ShiftsEnabled is true only for the exact value 1', () => {
  assert.equal(v2ShiftsEnabled({SAMOSVAL_V2_SHIFTS: '1'}), true);
  for (const value of ['0', 'true', '1 ', '', 'yes']) {
    assert.equal(v2ShiftsEnabled({SAMOSVAL_V2_SHIFTS: value}), false, `value ${JSON.stringify(value)}`);
  }
  assert.equal(v2ShiftsEnabled({}), false);
  assert.equal(v2ShiftsEnabled(undefined), false);
});

test('the switches are read per call, so the window needs no restart', () => {
  const env = {};
  assert.equal(probe({path: '/api/v1/session', env}).status, undefined);
  env.SAMOSVAL_MAINTENANCE = '1';
  assert.equal(probe({path: '/api/v1/session', env}).status, 503);
  delete env.SAMOSVAL_MAINTENANCE;
  assert.equal(probe({path: '/api/v1/session', env}).status, undefined);
  env.SAMOSVAL_V2_SHIFTS = '1';
  assert.equal(probe({path: '/api/v1/line/snapshot', env}).status, 426);
});

// --- maintenance ------------------------------------------------------------

test('maintenance closes every api read and write with 503 maintenance', () => {
  const requests = [
    ['GET', '/api/v1/session'],
    ['GET', '/api/v1/members'],
    ['GET', '/api/v1/tabel/records'],
    ['GET', '/api/v1/line/snapshot'],
    ['GET', '/api/v1/history'],
    ['GET', '/api/v1/archive/snapshot'],
    ['POST', '/api/v1/line/operations'],
    ['POST', '/api/v1/shifts/start'],
    ['POST', '/api/v1/shifts/close'],
    ['POST', '/api/v1/report/operations'],
    ['POST', '/api/v1/archive/operations'],
    ['POST', '/api/v1/controls'],
    ['POST', '/api/v1/settings'],
    ['POST', '/api/v1/tabel/records'],
    ['GET', '/api/v1/authority'],
    ['POST', '/api/v1/authority'],
    ['POST', '/api/v1/presence'],
    ['POST', '/api/v1/registration'],
    ['POST', '/api/v1/replica/apply'],
    ['GET', '/api/v2/shifts'],
    ['GET', '/api/v2/shifts/shift_a/snapshot'],
    ['POST', '/api/v2/shifts'],
    ['POST', '/api/v2/shifts/shift_a/line-operations'],
    ['POST', '/api/v2/shifts/shift_a/close/finish'],
  ];
  for (const [method, path] of requests) {
    const result = probe({path, method, env: ON});
    assert.equal(result.handled, true, `${method} ${path} must be answered by the gate`);
    assert.equal(result.status, 503, `${method} ${path}`);
    assert.deepEqual(result.body, {error: 'maintenance'}, `${method} ${path}`);
    assert.equal(result.sent.length, 1);
    assert.equal(result.sent[0].target, result.res);
  }
});

test('maintenance keeps health probes, local sign-in and preflight open', () => {
  const open = [
    ['GET', '/health/live'],
    ['GET', '/health/ready'],
    ['GET', '/health'],
    ['POST', '/api/v1/auth/register'],
    ['POST', '/api/v1/auth/login'],
    ['POST', '/api/v1/auth/refresh'],
    ['POST', '/api/v1/auth/logout'],
    ['POST', '/api/v1/auth/forgot'],
    ['POST', '/api/v1/auth/reset'],
    ['GET', '/api/v1/auth/sessions'],
    ['DELETE', '/api/v1/auth/sessions'],
    ['DELETE', '/api/v1/auth/sessions/ses_1'],
    ['OPTIONS', '/api/v1/line/operations'],
    ['OPTIONS', '/api/v2/shifts'],
    ['GET', '/index-working-test.html'],
    ['GET', '/'],
  ];
  for (const [method, path] of open) {
    const result = probe({path, method, env: ON});
    assert.equal(result.handled, false, `${method} ${path} must stay open`);
    assert.equal(result.sent.length, 0, `${method} ${path} must not be answered`);
  }
  assert.equal(maintenanceExempt('/api/v1/auth/login'), true);
  assert.equal(maintenanceExempt('/health/live'), true);
  // Only the `/api/v1/auth/` tree is exempt: a lookalike path is not.
  assert.equal(maintenanceExempt('/api/v1/authx'), false);
  assert.equal(probe({path: '/api/v1/authx', method: 'POST', env: ON}).status, 503);
});

test('maintenance answers 503, not 401, to an anonymous protected request', () => {
  // Decision (Task 29A п.2 has priority over the "identity first" note): a
  // closed server says it is closed. The gate runs before any authentication,
  // so no request can reach a domain reader or writer during the window.
  const decision = maintenanceDecision({path: '/api/v1/session', method: 'GET', env: ON});
  assert.deepEqual(decision, {status: 503, body: {error: 'maintenance'}});
  const anonymous = probe({path: '/api/v1/session', method: 'GET', env: ON});
  assert.equal(anonymous.status, 503);
});

test('the maintenance body carries nothing but the stable code', () => {
  const {body} = probe({path: '/api/v1/session', method: 'GET', env: ON});
  assert.deepEqual(Object.keys(body), ['error']);
  assert.equal(JSON.stringify(body), '{"error":"maintenance"}');
  assert.equal(Object.isFrozen(MAINTENANCE_BODY), true);
  // The gate builds the body from a frozen literal: whatever the request or the
  // environment holds, nothing else can reach the client.
  const sent = [];
  applyServiceGate({
    path: '/api/v1/backups',
    method: 'GET',
    res: {},
    env: ON,
    send: (target, status, payload) => sent.push({status, payload}),
  });
  assert.deepEqual(sent, [{status: 503, payload: {error: 'maintenance'}}]);
});

// --- protocol gate ----------------------------------------------------------

test('protocol gate refuses every legacy singleton route with 426', () => {
  for (const [method, path] of LEGACY_V1_ROUTES) {
    const result = probe({path, method, env: V2});
    assert.equal(result.handled, true, `${method} ${path} must be answered by the gate`);
    assert.equal(result.status, 426, `${method} ${path}`);
    assert.deepEqual(result.body, {error: 'protocol-upgrade-required', protocolVersion: 2}, `${method} ${path}`);
    assert.equal(result.sent.length, 1);
  }
});

test('protocol gate refuses the snapshot read instead of returning singleton data', () => {
  const {status, body} = probe({path: '/api/v1/line/snapshot', method: 'GET', env: V2});
  assert.equal(status, 426);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'protocolVersion']);
  assert.equal(body.protocolVersion, 2);
  assert.equal(Object.isFrozen(PROTOCOL_UPGRADE_BODY), true);
  assert.equal(JSON.stringify(body), '{"error":"protocol-upgrade-required","protocolVersion":2}');
});

test('protocol gate leaves authority, auth and the other v1 routes alone', () => {
  const open = [
    ['GET', '/api/v1/authority'],
    ['POST', '/api/v1/authority'],
    ['POST', '/api/v1/presence'],
    ['POST', '/api/v1/auth/login'],
    ['GET', '/api/v1/auth/sessions'],
    ['GET', '/api/v1/session'],
    ['GET', '/api/v1/members'],
    ['POST', '/api/v1/tabel/records'],
    ['POST', '/api/v1/replica/apply'],
    ['GET', '/api/v2/shifts'],
    ['POST', '/api/v2/shifts'],
    ['OPTIONS', '/api/v1/line/snapshot'],
  ];
  for (const [method, path] of open) {
    const result = probe({path, method, env: V2});
    assert.equal(result.handled, false, `${method} ${path} must not be gated`);
    assert.equal(result.sent.length, 0);
  }
});

test('a wrong method on a legacy path keeps the existing 404 fall-through', () => {
  // The gate is method-specific on purpose: only the request the v1 route used
  // to serve is refused, so a stray method cannot turn a 404 into a 426.
  for (const [method, path] of [
    ['DELETE', '/api/v1/shifts/start'],
    ['GET', '/api/v1/line/operations'],
    ['PUT', '/api/v1/history'],
    ['POST', '/api/v1/line/snapshot'],
    ['GET', '/api/v1/controls'],
  ]) {
    const result = probe({path, method, env: V2});
    assert.equal(result.handled, false, `${method} ${path}`);
  }
});

test('without SAMOSVAL_V2_SHIFTS the v1 routes are byte-for-byte untouched', () => {
  for (const env of [{}, {SAMOSVAL_V2_SHIFTS: '0'}, {SAMOSVAL_V2_SHIFTS: 'true'}, {SAMOSVAL_V2_SHIFTS: ''}]) {
    for (const [method, path] of LEGACY_V1_ROUTES) {
      const result = probe({path, method, env});
      assert.equal(result.handled, false, `${method} ${path} with ${JSON.stringify(env)}`);
      assert.equal(result.sent.length, 0);
    }
    assert.equal(protocolDecision({path: '/api/v1/line/snapshot', method: 'GET', env}), null);
  }
});

test('maintenance wins when both switches are on', () => {
  const both = {...ON, ...V2};
  for (const [method, path] of LEGACY_V1_ROUTES) {
    const result = probe({path, method, env: both});
    assert.equal(result.status, 503, `${method} ${path}`);
    assert.deepEqual(result.body, {error: 'maintenance'});
  }
  assert.deepEqual(
    serviceGate({path: '/api/v1/line/snapshot', method: 'GET', env: both}),
    {status: 503, body: {error: 'maintenance'}},
  );
  // And with neither switch the gate is a no-op.
  assert.equal(serviceGate({path: '/api/v1/line/snapshot', method: 'GET', env: {}}), null);
  // Malformed input never throws and never answers.
  assert.equal(serviceGate({}), null);
  assert.equal(serviceGate({path: 42, method: 'GET', env: ON}), null);
  assert.equal(serviceGate({path: '/api/v1/session', method: undefined, env: ON}), null);
});

// --- wiring ----------------------------------------------------------------

test('index.mjs calls the gate once, after health probes and before any body read', async () => {
  // The gate is only useful if it runs before the router reads a body or calls
  // a domain service. `index.mjs` cannot be imported here (it requires a
  // database and binds a port), so the call site itself is asserted: exactly one
  // call, after origin/CORS and the health probes, before the v2 tree and
  // before the first `await readJson(...)`.
  const source = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const callSites = source.split('applyServiceGate({').length - 1;
  assert.equal(callSites, 1, 'exactly one applyServiceGate call site');
  const gateAt = source.indexOf('applyServiceGate({');
  const originAt = source.indexOf("const origin=req.headers.origin");
  const readyAt = source.indexOf("path==='/health/ready'");
  const v2At = source.indexOf("if(path.startsWith('/api/v2'))");
  const firstBodyReadAt = source.indexOf('await readJson(');
  assert.ok(originAt > 0 && originAt < gateAt, 'origin/CORS check must run before the gate');
  assert.ok(readyAt > 0 && readyAt < gateAt, 'health probes must run before the gate');
  assert.ok(v2At > gateAt, 'the gate must run before the v2 tree');
  assert.ok(firstBodyReadAt > gateAt, 'the gate must run before the first body read');
  assert.ok(source.indexOf("'/api/v1/auth/login'") > gateAt, 'auth routes must stay behind the gate (they are exempt by path)');
});
