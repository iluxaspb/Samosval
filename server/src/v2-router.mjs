import { v2Error, v2ErrorBody } from './v2-errors.mjs';
import { loadActor } from './shift-access-v2.mjs';
import { listVisibleShifts, readShiftSnapshot } from './shift-read-v2.mjs';

// `/api/v2` router foundation (design §5, §14, plan Task 18).
//
// Task 18 exposes exactly the two reads — the visible shift list and one scoped
// snapshot. Every other `/api/v2` path answers a stable `404 not-found` instead
// of falling through to the v1 tree, and a wrong method answers `405`. Command
// routes of Tasks 19–22 plug into `matchV2Route` and reuse `runV2Command`; this
// module deliberately does not invent a second dispatch mechanism.
//
// Error bodies are always the stable v2 shape `{protocolVersion:2,error,details}`
// (`v2-errors.mjs`), including unexpected failures, so a client never sees a
// stack, SQL or a DSN. A request that declares an older protocol gets `426`
// before authentication.

const SHIFT_TOKEN = /^[A-Za-z0-9_-]{1,160}$/;
const SNAPSHOT_ROUTE = /^\/api\/v2\/shifts\/([^/]+)\/snapshot$/;

export function matchV2Route(pathname) {
  if (pathname === '/api/v2/shifts') return { kind: 'list' };
  const match = SNAPSHOT_ROUTE.exec(pathname);
  if (!match) return null;
  let shiftId;
  try {
    shiftId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  // Only the plain token form is a route; `%61`/`a%20b` are not silently
  // normalised into another shift id.
  if (shiftId !== match[1] || !SHIFT_TOKEN.test(shiftId)) return null;
  return { kind: 'snapshot', shiftId };
}

function protocolUpgrade(declared) {
  const version = Number(String(declared).trim());
  return v2Error('protocol-upgrade-required', 426, {
    protocolVersion: Number.isSafeInteger(version) && version > 0 ? version : 0,
  });
}

// `handleV2Request` returns true when it answered the request and false when the
// path is not a v2 path (the caller keeps routing). `services` exists so the
// HTTP contract is unit-testable without a database; production leaves it empty
// and uses the real readers.
export async function handleV2Request(options) {
  const input = options ?? {};
  const { pool, req, res, send, authenticate } = input;
  const url = input.url instanceof URL
    ? input.url
    : new URL(String(input.url ?? req?.url ?? '/'), 'http://localhost');
  const method = input.method ?? req?.method ?? 'GET';
  if (!url.pathname.startsWith('/api/v2')) return false;

  const route = matchV2Route(url.pathname);
  if (!route) {
    send(res, 404, { protocolVersion: 2, error: 'not-found', details: {} });
    return true;
  }
  if (method !== 'GET') {
    send(res, 405, { protocolVersion: 2, error: 'method-not-allowed', details: {} });
    return true;
  }
  const declared = req?.headers?.['x-samosval-protocol'];
  if (declared !== undefined && String(declared).trim() !== '2') {
    const body = protocolUpgrade(declared);
    send(res, body.status, body.body);
    return true;
  }

  const services = input.services ?? {};
  const resolveActor = services.loadActor ?? loadActor;
  const listShifts = services.listVisibleShifts ?? listVisibleShifts;
  const readSnapshot = services.readShiftSnapshot ?? readShiftSnapshot;
  const workspaceId = input.workspaceId ?? process.env.WORKSPACE_ID ?? 'main_workspace';

  try {
    if (typeof authenticate !== 'function') throw v2Error('unauthenticated', 401);
    const uid = await authenticate(req);
    if (typeof uid !== 'string' || uid.length === 0) throw v2Error('unauthenticated', 401);
    const actor = await resolveActor(pool, uid);
    if (route.kind === 'list') {
      send(res, 200, await listShifts(pool, actor, {
        workspaceId,
        state: url.searchParams.get('state') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
        cursor: url.searchParams.get('cursor') ?? undefined,
      }));
      return true;
    }
    send(res, 200, await readSnapshot(pool, actor, { workspaceId, shiftId: route.shiftId }));
    return true;
  } catch (error) {
    if (error?.name === 'V2Error') {
      send(res, error.status, v2ErrorBody(error));
      return true;
    }
    console.error('[v2-api] request failed', error?.code || error?.name || 'unknown');
    send(res, 500, v2ErrorBody(error));
    return true;
  }
}
