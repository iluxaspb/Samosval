import { v2Error, v2ErrorBody } from './v2-errors.mjs';
import { loadActor } from './shift-access-v2.mjs';
import { listVisibleShifts, readShiftSnapshot } from './shift-read-v2.mjs';
import {
  addShiftMember,
  changeShiftObject,
  createShift,
  removeShiftMember,
} from './shift-members-v2.mjs';
import { assignTruck, removeTruck } from './shift-trucks-v2.mjs';
import { completeDetachedTrip, forceTransferTruck } from './shift-transfer-v2.mjs';
import { submitLineOperationV2 } from './line-store-v2.mjs';
import { finishShiftClose, confirmShiftMaterial, prepareShiftClose } from './shift-close-v2.mjs';

// `/api/v2` router (design §5, §14, plan Tasks 18–19).
//
// Task 18 exposed the two reads (visible list and one scoped snapshot); Task 19
// adds the shift metadata/membership commands. Every other `/api/v2` path
// answers a stable `404 not-found` instead of falling through to the v1 tree, a
// known path with a wrong method answers `405`, and the command routes plug into
// the same `runV2Command` runner (receipt, audit, idempotency, CAS) — this module
// never invents a second dispatch or a second authorization path.
//
// Error bodies are always the stable v2 shape `{protocolVersion:2,error,details}`
// (`v2-errors.mjs`), including unexpected failures, so a client never sees a
// stack, SQL or a DSN. A request that declares an older protocol gets `426`
// before authentication.

const SHIFT_TOKEN = /^[A-Za-z0-9_-]{1,160}$/;
const SNAPSHOT_ROUTE = /^\/api\/v2\/shifts\/([^/]+)\/snapshot$/;
const SHIFT_SUBROUTE = /^\/api\/v2\/shifts\/([^/]+)\/(object|members)(?:\/([^/]+))?$/;
const TRUCKS_ROUTE = /^\/api\/v2\/shifts\/([^/]+)\/trucks$/;
const TRUCK_ROUTE = /^\/api\/v2\/shifts\/([^/]+)\/trucks\/([^/]+)$/;
const FORCE_TRANSFER_ROUTE = /^\/api\/v2\/shifts\/([^/]+)\/trucks\/([^/]+)\/force-transfer$/;
const DETACHED_COMPLETE_ROUTE = /^\/api\/v2\/shifts\/([^/]+)\/detached-trips\/([^/]+)\/complete$/;
const LINE_OPERATIONS_ROUTE = /^\/api\/v2\/shifts\/([^/]+)\/line-operations$/;
const CLOSE_PREPARE_ROUTE = /^\/api\/v2\/shifts\/([^/]+)\/close\/prepare$/;
const CLOSE_MATERIAL_ROUTE = /^\/api\/v2\/shifts\/([^/]+)\/close\/material$/;
const CLOSE_FINISH_ROUTE = /^\/api\/v2\/shifts\/([^/]+)\/close\/finish$/;

// Only the plain token form is an id; `%61`/`a%20b` are not silently normalised
// into another shift or user.
function decodeToken(raw) {
  let value;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (value !== raw || !SHIFT_TOKEN.test(value)) return null;
  return value;
}

function resolveV2Path(pathname) {
  if (pathname === '/api/v2/shifts') return { kind: 'shifts' };
  const snapshot = SNAPSHOT_ROUTE.exec(pathname);
  if (snapshot) {
    const shiftId = decodeToken(snapshot[1]);
    return shiftId ? { kind: 'snapshot', shiftId } : null;
  }
  const sub = SHIFT_SUBROUTE.exec(pathname);
  if (!sub) {
    const force = FORCE_TRANSFER_ROUTE.exec(pathname);
    if (force) {
      const shiftId = decodeToken(force[1]);
      const truckId = decodeToken(force[2]);
      return shiftId && truckId ? { kind: 'truck-force-transfer', shiftId, truckId } : null;
    }
    const detached = DETACHED_COMPLETE_ROUTE.exec(pathname);
    if (detached) {
      const shiftId = decodeToken(detached[1]);
      const cycleId = decodeToken(detached[2]);
      return shiftId && cycleId ? { kind: 'detached-complete', shiftId, cycleId } : null;
    }
    const lineOperations = LINE_OPERATIONS_ROUTE.exec(pathname);
    if (lineOperations) {
      const shiftId = decodeToken(lineOperations[1]);
      return shiftId ? { kind: 'line-operations', shiftId } : null;
    }
    const closePrepare = CLOSE_PREPARE_ROUTE.exec(pathname);
    if (closePrepare) {
      const shiftId = decodeToken(closePrepare[1]);
      return shiftId ? { kind: 'close-prepare', shiftId } : null;
    }
    const closeMaterial = CLOSE_MATERIAL_ROUTE.exec(pathname);
    if (closeMaterial) {
      const shiftId = decodeToken(closeMaterial[1]);
      return shiftId ? { kind: 'close-material', shiftId } : null;
    }
    const closeFinish = CLOSE_FINISH_ROUTE.exec(pathname);
    if (closeFinish) {
      const shiftId = decodeToken(closeFinish[1]);
      return shiftId ? { kind: 'close-finish', shiftId } : null;
    }
    const truck = TRUCK_ROUTE.exec(pathname);
    if (truck) {
      const shiftId = decodeToken(truck[1]);
      const truckId = decodeToken(truck[2]);
      return shiftId && truckId ? { kind: 'truck', shiftId, truckId } : null;
    }
    const trucks = TRUCKS_ROUTE.exec(pathname);
    if (trucks) {
      const shiftId = decodeToken(trucks[1]);
      return shiftId ? { kind: 'trucks', shiftId } : null;
    }
    return null;
  }
  const shiftId = decodeToken(sub[1]);
  if (!shiftId) return null;
  if (sub[2] === 'object' && sub[3] === undefined) return { kind: 'object', shiftId };
  if (sub[2] === 'members' && sub[3] === undefined) return { kind: 'members', shiftId };
  if (sub[2] === 'members' && sub[3] !== undefined) {
    const uid = decodeToken(sub[3]);
    return uid ? { kind: 'member', shiftId, uid } : null;
  }
  return null;
}

export function matchV2Route(pathname, method = 'GET') {
  const path = resolveV2Path(pathname);
  if (!path) return null;
  switch (path.kind) {
    case 'shifts':
      if (method === 'GET') return { kind: 'list' };
      if (method === 'POST') return { kind: 'create' };
      return null;
    case 'snapshot':
      return method === 'GET' ? path : null;
    case 'object':
      return method === 'PATCH' ? { kind: 'shift-object', shiftId: path.shiftId } : null;
    case 'members':
      return method === 'POST' ? { kind: 'member-add', shiftId: path.shiftId } : null;
    case 'member':
      return method === 'DELETE' ? { kind: 'member-remove', shiftId: path.shiftId, uid: path.uid } : null;
    case 'trucks':
      return method === 'POST' ? { kind: 'truck-add', shiftId: path.shiftId } : null;
    case 'truck':
      return method === 'DELETE' ? { kind: 'truck-remove', shiftId: path.shiftId, truckId: path.truckId } : null;
    case 'truck-force-transfer':
      return method === 'POST'
        ? { kind: 'truck-force-transfer', shiftId: path.shiftId, truckId: path.truckId }
        : null;
    case 'detached-complete':
      return method === 'POST'
        ? { kind: 'detached-complete', shiftId: path.shiftId, cycleId: path.cycleId }
        : null;
    case 'line-operations':
      return method === 'POST' ? { kind: 'line-operations', shiftId: path.shiftId } : null;
    case 'close-prepare':
      return method === 'POST' ? { kind: 'close-prepare', shiftId: path.shiftId } : null;
    case 'close-material':
      return method === 'POST' ? { kind: 'close-material', shiftId: path.shiftId } : null;
    case 'close-finish':
      return method === 'POST' ? { kind: 'close-finish', shiftId: path.shiftId } : null;
    default:
      return null;
  }
}

// A command body is a JSON object. The reader is injected by the API process
// (`readJson` in index.mjs) so the HTTP limit and the JSON error stay in one
// place; a unit test passes `body` directly.
function requirePlainBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw v2Error('invalid-command', 400, { field: 'body' });
  }
  return value;
}

async function readCommandBody(input, req) {
  if (Object.hasOwn(input, 'body') && input.body !== undefined) return requirePlainBody(input.body);
  if (typeof input.readBody !== 'function') throw v2Error('invalid-command', 400, { field: 'body' });
  let parsed;
  try {
    parsed = await input.readBody(req);
  } catch {
    // A malformed or oversized body is a schema error, never an internal one.
    throw v2Error('invalid-command', 400, { field: 'body' });
  }
  return requirePlainBody(parsed);
}

function protocolUpgrade(declared) {
  const version = Number(String(declared).trim());
  return v2Error('protocol-upgrade-required', 426, {
    protocolVersion: Number.isSafeInteger(version) && version > 0 ? version : 0,
  });
}

// Force transfer and detached completion are online-only (§9): they must never
// be replayed from an offline queue. An offline envelope is refused before any
// mutation (right after the caller is identified), so a queued command can never
// become a second transfer of the same truck.
function refuseOfflineRequest(req) {
  const declared = req?.headers?.['x-samosval-offline'];
  if (declared === undefined) return;
  const value = String(declared).trim().toLowerCase();
  if (value === '' || value === '0' || value === 'false') return;
  throw v2Error('online-required', 409);
}

// `handleV2Request` returns true when it answered the request and false when the
// path is not a v2 path (the caller keeps routing). `services` exists so the
// HTTP contract is unit-testable without a database; production leaves it empty
// and uses the real readers/commands.
export async function handleV2Request(options) {
  const input = options ?? {};
  const { pool, req, res, send, authenticate } = input;
  const url = input.url instanceof URL
    ? input.url
    : new URL(String(input.url ?? req?.url ?? '/'), 'http://localhost');
  const method = input.method ?? req?.method ?? 'GET';
  if (!url.pathname.startsWith('/api/v2')) return false;

  // An unknown path is 404; a known path with a wrong method is 405.
  if (!resolveV2Path(url.pathname)) {
    send(res, 404, { protocolVersion: 2, error: 'not-found', details: {} });
    return true;
  }
  const route = matchV2Route(url.pathname, method);
  if (!route) {
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
  const createShiftCommand = services.createShift ?? createShift;
  const changeObjectCommand = services.changeShiftObject ?? changeShiftObject;
  const addMemberCommand = services.addShiftMember ?? addShiftMember;
  const removeMemberCommand = services.removeShiftMember ?? removeShiftMember;
  const assignTruckCommand = services.assignTruck ?? assignTruck;
  const removeTruckCommand = services.removeTruck ?? removeTruck;
  const forceTransferCommand = services.forceTransferTruck ?? forceTransferTruck;
  const completeDetachedCommand = services.completeDetachedTrip ?? completeDetachedTrip;
  const lineOperationCommand = services.submitLineOperationV2 ?? submitLineOperationV2;
  const prepareCloseCommand = services.prepareShiftClose ?? prepareShiftClose;
  const confirmMaterialCommand = services.confirmShiftMaterial ?? confirmShiftMaterial;
  const finishCloseCommand = services.finishShiftClose ?? finishShiftClose;
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
    if (route.kind === 'snapshot') {
      send(res, 200, await readSnapshot(pool, actor, { workspaceId, shiftId: route.shiftId }));
      return true;
    }
    // Commands: the body never supplies the workspace or the addressed shift —
    // both come from the server configuration and the matched path.
    const body = await readCommandBody(input, req);
    const command = { ...body, workspaceId };
    if (route.kind === 'create') {
      const result = await createShiftCommand(pool, actor, command);
      send(res, result.replayed ? 200 : 201, result);
      return true;
    }
    if (route.kind === 'shift-object') {
      send(res, 200, await changeObjectCommand(pool, actor, { ...command, shiftId: route.shiftId }));
      return true;
    }
    if (route.kind === 'member-add') {
      send(res, 200, await addMemberCommand(pool, actor, { ...command, shiftId: route.shiftId }));
      return true;
    }
    if (route.kind === 'member-remove') {
      send(res, 200, await removeMemberCommand(pool, actor, {
        ...command, shiftId: route.shiftId, uid: route.uid,
      }));
      return true;
    }
    if (route.kind === 'truck-add') {
      send(res, 200, await assignTruckCommand(pool, actor, { ...command, shiftId: route.shiftId }));
      return true;
    }
    if (route.kind === 'truck-remove') {
      send(res, 200, await removeTruckCommand(pool, actor, {
        ...command, shiftId: route.shiftId, truckId: route.truckId,
      }));
      return true;
    }
    if (route.kind === 'truck-force-transfer') {
      refuseOfflineRequest(req);
      send(res, 200, await forceTransferCommand(pool, actor, {
        ...command, shiftId: route.shiftId, truckId: route.truckId,
      }));
      return true;
    }
    if (route.kind === 'line-operations') {
      // The path shift is the only addressed shift. The raw body value is passed
      // separately so a disagreement is refused instead of silently ignored.
      send(res, 200, await lineOperationCommand(pool, actor, {
        ...command, shiftId: route.shiftId, bodyShiftId: body.shiftId,
      }));
      return true;
    }
    if (route.kind === 'close-prepare') {
      send(res, 200, await prepareCloseCommand(pool, actor, { ...command, shiftId: route.shiftId }));
      return true;
    }
    if (route.kind === 'close-material') {
      send(res, 200, await confirmMaterialCommand(pool, actor, { ...command, shiftId: route.shiftId }));
      return true;
    }
    if (route.kind === 'close-finish') {
      send(res, 200, await finishCloseCommand(pool, actor, { ...command, shiftId: route.shiftId }));
      return true;
    }
    refuseOfflineRequest(req);
    send(res, 200, await completeDetachedCommand(pool, actor, {
      ...command, shiftId: route.shiftId, cycleId: route.cycleId,
    }));
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
