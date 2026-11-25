import { fail } from './tabel-access.mjs';
import { resolveLegacyShift } from './legacy-shift-resolution.mjs';

// Versioned admin route from design §4.9:
//   POST /api/v2/admin/legacy-shifts/{shiftId}/resolve
//
// There is no v2 router in this repository yet (the API is a flat chain of
// /api/v1 handlers in `src/index.mjs`), so this module is the exact adapter that
// a future router must call. It deliberately owns no framework and no bootstrap
// wiring: adding a v2 endpoint to the v1 server would create a second routing
// layer that the parallel-shifts plan does not have yet.
export const LEGACY_SHIFT_RESOLVE_PATTERN = /^\/api\/v2\/admin\/legacy-shifts\/([A-Za-z0-9_-]{1,160})\/resolve$/;

export function matchLegacyShiftResolutionPath(pathname) {
  if (typeof pathname !== 'string') return null;
  const match = LEGACY_SHIFT_RESOLVE_PATTERN.exec(pathname);
  return match ? match[1] : null;
}

// `session` is the already authenticated server session: the route never trusts
// a uid from the body. The workspace is the session's workspace, never the
// client's choice.
export async function resolveLegacyShiftRoute(pool, session, shiftId, body) {
  if (!session || typeof session.uid !== 'string' || session.uid.length === 0) throw fail('owner-acl-denied', 403);
  if (typeof session.workspaceId !== 'string' || session.workspaceId.length === 0) {
    throw fail('invalid-resolution-command', 400);
  }
  return resolveLegacyShift(pool, {
    uid: session.uid,
    workspaceId: session.workspaceId,
    shiftId,
    body,
  });
}
