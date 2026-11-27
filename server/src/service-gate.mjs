// Coordinated rollout gate (design §9, §13) — the single place that answers
// "this server is closed" and "this client speaks the old protocol".
//
// Two independent switches, both read from the environment on every request so
// the maintenance window and the v1 → v2 switch need no restart:
//
// - `SAMOSVAL_MAINTENANCE === '1'` closes the API: every `/api/v1/**` and
//   `/api/v2/**` read and write answers `503 {error:'maintenance'}` (§13 п.2:
//   reads show maintenance, old clients cannot write). Health probes and the
//   local sign-in routes stay open, otherwise the application could not be
//   entered at all during the window.
// - `SAMOSVAL_V2_SHIFTS === '1'` retires the legacy singleton shift routes: the
//   v1 shift/line/report/history/archive/control routes answer
//   `426 {error:'protocol-upgrade-required', protocolVersion:2}` instead of
//   singleton data (§13 п.7, §9). The body is never parsed for such a request —
//   a stale client must not learn `invalid-command` instead of `426`.
//
// `/api/v1/authority` is never touched by the protocol gate: it is the switch
// that moves the write authority, so blocking it would leave the window stuck.
// The maintenance gate does cover it (requirement: only health and auth pass),
// which is why an authority switch belongs before the window opens.
//
// Bodies are frozen literals: no DSN, SQL, stack, e-mail or uid can reach a
// client from here, whatever the request contains.

const AUTH_PREFIX = '/api/v1/auth/';
const HEALTH_PATHS = new Set(['/health/live', '/health/ready']);

export const MAINTENANCE_BODY = Object.freeze({error: 'maintenance'});
export const PROTOCOL_UPGRADE_BODY = Object.freeze({
  error: 'protocol-upgrade-required',
  protocolVersion: 2,
});

// v1 routes that read or write the singleton line/shift state. In v2 mode the
// same data is only reachable per shift (`/api/v2/shifts/:id`), so the exact
// method that the v1 route served is refused; other methods keep their current
// `404 not-found` and never expose data.
const LEGACY_V1_ROUTES = new Map([
  ['/api/v1/shifts/start', ['POST']],
  ['/api/v1/shifts/close', ['POST']],
  ['/api/v1/line/snapshot', ['GET']],
  ['/api/v1/line/operations', ['POST']],
  ['/api/v1/report/operations', ['POST']],
  ['/api/v1/history', ['GET', 'POST']],
  ['/api/v1/archive/operations', ['POST']],
  ['/api/v1/controls', ['POST']],
]);

// Only the exact value `'1'` enables a switch: `'0'`, `'true'`, `'1 '`, an
// empty string and a missing variable all mean "off".
export function maintenanceMode(env = process.env) {
  return env != null && env.SAMOSVAL_MAINTENANCE === '1';
}

export function v2ShiftsEnabled(env = process.env) {
  return env != null && env.SAMOSVAL_V2_SHIFTS === '1';
}

function underApi(path) {
  return path.startsWith('/api/v1/') || path.startsWith('/api/v2/');
}

// Health probes are not under `/api`, but they are named here as well so the
// exemption stays visible next to the gate instead of depending on routing.
export function maintenanceExempt(path) {
  return HEALTH_PATHS.has(path) || path.startsWith(AUTH_PREFIX);
}

export function legacyV1Route(path, method) {
  const methods = LEGACY_V1_ROUTES.get(path);
  return methods !== undefined && methods.includes(method);
}

export function maintenanceDecision({path, method, env} = {}) {
  if (typeof path !== 'string' || typeof method !== 'string') return null;
  // A preflight must keep working: it carries no credentials and no body, and
  // blocking it would turn the window into an opaque CORS failure.
  if (method === 'OPTIONS') return null;
  if (!underApi(path) || maintenanceExempt(path)) return null;
  if (!maintenanceMode(env)) return null;
  return {status: 503, body: MAINTENANCE_BODY};
}

export function protocolDecision({path, method, env} = {}) {
  if (typeof path !== 'string' || typeof method !== 'string') return null;
  if (method === 'OPTIONS') return null;
  if (!legacyV1Route(path, method)) return null;
  if (!v2ShiftsEnabled(env)) return null;
  return {status: 426, body: PROTOCOL_UPGRADE_BODY};
}

// Maintenance wins when both switches are on: a closed server answers "closed",
// not "upgrade", and never touches the domain.
export function serviceGate(request) {
  return maintenanceDecision(request) ?? protocolDecision(request);
}

// The one call site in `index.mjs`, right after origin/CORS and the health
// probes and before any body read or domain call. Returns true when the request
// was answered.
export function applyServiceGate({path, method, res, send, env} = {}) {
  const decision = serviceGate({path, method, env});
  if (!decision) return false;
  send(res, decision.status, {...decision.body});
  return true;
}
