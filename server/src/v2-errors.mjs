// Stable v2 error contract (design §5, §14).
//
// One command failure has exactly one machine-readable code. The wire body is
// `{protocolVersion:2, error:code, details}`; the JavaScript error additionally
// exposes `{code, status, details}` (also mirrored as `error.error`) so a router
// can pick the HTTP status without parsing the code again.
//
// `details` is a closed, flat whitelist: no DSN, SQL, stack, message, e-mail or
// nested payload can ever reach the client, even if a caller passes one by
// mistake. Unknown codes and statuses fail closed (TypeError) — a typo must not
// silently become a client-visible contract.

const CODES = Object.freeze({
  // schema/validation
  'invalid-command': 400,
  'invalid-shift-v2-provenance': 400,
  'archive-operation-not-allowed': 400,
  // §3.2/§6: only an active senior_foreman/foreman is a member. A worker,
  // driver, disabled or unknown uid is a schema refusal, never a 500.
  'member-not-eligible': 400,
  // auth
  'unauthenticated': 401,
  'forbidden': 403,
  'not-shift-member': 403,
  // routing (Task 18): an unknown `/api/v2` path or a wrong method is a stable
  // refusal, never a fall-through to the v1 tree and never a crash.
  'not-found': 404,
  'method-not-allowed': 405,
  // visibility
  'shift-not-visible': 404,
  'detached-trip-not-found': 404,
  // domain/CAS/idempotency
  'parent-in-use': 409,
  'replica-operation-conflict': 409,
  'replica-stream-immutable': 409,
  'shift-changed': 409,
  'shift-closing': 409,
  'shift-duplicate': 409,
  'object-not-available': 409,
  'object-locked': 409,
  'membership-changed': 409,
  'last-shift-member': 409,
  'truck-assigned-to-other-shift': 409,
  'truck-not-on-shift': 409,
  'truck-cycle-incomplete': 409,
  'truck-detached-trip-open': 409,
  'detached-trip-completed': 409,
  'detached-trip-open': 409,
  'transfer-context-changed': 409,
  'force-transfer-confirmation-required': 409,
  'online-required': 409,
  'revision-conflict': 409,
  'pending-operations': 409,
  'operation-id-reused': 409,
  'archive-changed': 409,
  'archive-context-required': 409,
  // Restored archive v2 routes (design §5.6): a context that is already
  // published is immutable, and an archive whose bytes cannot describe a
  // restorable shift is a stable refusal, never an internal error.
  'archive-not-found': 404,
  'archive-context-not-found': 404,
  'archive-context-finalized': 409,
  'archive-not-restorable': 409,
  'archive-truck-not-available': 409,
  'archive-not-ready': 409,
  'invalid-archive-id': 400,
  'invalid-archive-revision': 400,
  'invalid-archive-data': 409,
  'invalid-archive-operation': 400,
  'invalid-restored-context': 400,
  'invalid-restored-trip': 409,
  'restored-trip-not-found': 404,
  // lifecycle
  'shift-closed': 410,
  'protocol-upgrade-required': 426,
  'maintenance': 503,
  'internal': 500
});

// Flat, non-personal detail keys only. Anything else is dropped on purpose.
const DETAIL_KEYS = Object.freeze(new Set([
  'field', 'reason', 'state', 'limit', 'cursor',
  'operationId', 'protocolVersion',
  'shiftId', 'objectId', 'workDate', 'shiftType', 'truckId',
  'sourceShiftId', 'destinationShiftId', 'cycleId', 'stage',
  'expectedRevision', 'actualRevision',
  'expectedShiftRevision', 'actualShiftRevision',
  'expectedMembershipRevision', 'actualMembershipRevision',
  'expectedStatusRevision', 'actualStatusRevision',
  'expectedCycleRevision', 'actualCycleRevision',
  'expectedTtnRevision', 'actualTtnRevision',
  'expectedDetachedCycleRevision', 'actualDetachedCycleRevision',
  // Two-phase close (Task 22): the exact archive/marker counter that disagreed.
  'expectedArchiveRevision', 'actualArchiveRevision',
  'expectedMaterialMarkerRevision', 'actualMaterialMarkerRevision',
  // Restored archive (§5.6): the addressed archive/context/revision and the
  // corrected record. Already on the client's safe list, so a refusal keeps its
  // numbers instead of arriving empty.
  'archiveId', 'archiveRevision', 'restoredContextId', 'contextRevision', 'recordId', 'revision',
  'retryAfterSeconds', 'replayed'
]));

const STATUSES = Object.freeze(new Set([400, 401, 403, 404, 405, 409, 410, 426, 500, 503]));
const MAX_DETAIL_STRING = 200;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const V2_ERROR_CODES = CODES;
export const V2_SAFE_DETAIL_KEYS = DETAIL_KEYS;

function safeDetails(details) {
  const output = {};
  if (details === null || details === undefined) return output;
  if (typeof details !== 'object' || Array.isArray(details)) return output;
  // Sorted keys keep the serialized error body byte-stable.
  for (const key of Object.keys(details).sort()) {
    if (!DETAIL_KEYS.has(key)) continue;
    const value = details[key];
    if (value === null) output[key] = null;
    else if (typeof value === 'boolean') output[key] = value;
    else if (typeof value === 'number') {
      if (Number.isFinite(value)) output[key] = Object.is(value, -0) ? 0 : value;
    } else if (typeof value === 'string') {
      if (value.length <= MAX_DETAIL_STRING && !CONTROL.test(value)) output[key] = value;
    }
  }
  return output;
}

export function v2Error(code, status, details) {
  if (typeof code !== 'string' || !Object.hasOwn(CODES, code)) throw new TypeError(`unknown v2 error code: ${String(code)}`);
  const resolved = status === undefined ? CODES[code] : status;
  if (!STATUSES.has(resolved)) throw new TypeError(`invalid v2 error status: ${String(resolved)}`);
  const error = new Error(code);
  error.name = 'V2Error';
  error.code = code;
  error.status = resolved;
  error.details = safeDetails(details);
  // Internal stable shape and the exact wire body from design §5.
  error.error = Object.freeze({code, status: resolved, details: error.details});
  error.body = Object.freeze({protocolVersion: 2, error: code, details: error.details});
  return error;
}

// Never echo an unexpected error: unknown failures become a bare `internal`.
export function v2ErrorBody(error) {
  if (error && error.name === 'V2Error' && error.body && typeof error.body === 'object') return error.body;
  return {protocolVersion: 2, error: 'internal', details: {}};
}
