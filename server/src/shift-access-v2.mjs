import { v2Error } from './v2-errors.mjs';
import { ROLES } from './identity-rules.mjs';

// Parallel shift authorization (design §6, plan Task 17).
//
// Four checks are independent and all must pass:
//   1. an active `app_users` profile (`loadActor`);
//   2. the global role/action matrix in `role_permissions`;
//   3. an active membership (`shift_members.removed_at IS NULL`) — never for admin;
//   4. the resource really belongs to the requested workspace+shift.
//
// Default deny: an action that is not in SHIFT_ACTIONS is refused, a missing
// matrix row is refused, and a missing membership is refused. Admin is the only
// role that skips the matrix and membership, but never the resource existence
// check — a shift from another workspace is still `404 shift-not-visible`.
//
// Error contract is the stable v2 one (`v2-errors.mjs`): a member who lost the
// membership gets `404 shift-not-visible` on read (existence is not disclosed)
// and `403 not-shift-member` on a known command. Authorization is re-evaluated on
// every call, including an identical replay (`v2-command.mjs`), so a revoked
// member never receives a stored receipt.

const ID = /^[A-Za-z0-9_-]{1,160}$/;
const ALIAS = /^[a-z_][a-z0-9_]{0,62}$/;

// One action = one right set plus its lifecycle rule. `closing: 'blocked'` means
// a closing shift accepts no new line/member/truck/object command; snapshot and
// the close commands stay available. `shift.close.prepare` stays allowed while
// closing because an identical prepare replay must still reach its receipt —
// the close domain (Task 22) owns the token/phase rules, not the ACL.
export const SHIFT_ACTIONS = Object.freeze({
  'shift.read': Object.freeze({ rights: Object.freeze(['tab_line']), closing: 'allowed' }),
  'shift.object.change': Object.freeze({ rights: Object.freeze(['edit_line']), closing: 'blocked' }),
  'shift.member.add': Object.freeze({ rights: Object.freeze(['manage_shift_members']), closing: 'blocked' }),
  'shift.member.remove': Object.freeze({ rights: Object.freeze(['manage_shift_members']), closing: 'blocked' }),
  'shift.truck.add': Object.freeze({ rights: Object.freeze(['manage_trucks', 'edit_line']), closing: 'blocked' }),
  'shift.truck.remove': Object.freeze({ rights: Object.freeze(['manage_trucks', 'edit_line']), closing: 'blocked' }),
  'shift.truck.force-transfer': Object.freeze({ rights: Object.freeze(['force_transfer_truck']), closing: 'blocked' }),
  'shift.line.arrive': Object.freeze({ rights: Object.freeze(['action_arrive']), closing: 'blocked' }),
  'shift.line.load': Object.freeze({ rights: Object.freeze(['action_load']), closing: 'blocked' }),
  'shift.line.ttn': Object.freeze({ rights: Object.freeze(['action_ttn']), closing: 'blocked' }),
  'shift.line.reset': Object.freeze({ rights: Object.freeze(['line_timer_reset']), closing: 'blocked' }),
  // The completing right depends on the saved stage (`lineAction`), so it is
  // resolved per call instead of being fixed here.
  'shift.detached.complete': Object.freeze({ rights: Object.freeze([]), closing: 'blocked' }),
  // `terminal: 'domain'` means the close domain owns the terminal-state answer
  // (§5.5/§11): a closed/historical row must answer its stable `409 shift-closed`
  // instead of the generic `410`, and an identical replay must still reach its
  // receipt. The ACL still re-checks the actor, membership and right on every call.
  'shift.close.prepare': Object.freeze({ rights: Object.freeze(['close_shift']), closing: 'allowed', terminal: 'domain' }),
  'shift.close.material': Object.freeze({ rights: Object.freeze(['close_shift']), closing: 'allowed', terminal: 'domain' }),
  'shift.close.finish': Object.freeze({ rights: Object.freeze(['close_shift']), closing: 'allowed', terminal: 'domain' }),
});

// A detached trip can only be completed by the action that saved its stage.
const DETACHED_LINE_ACTIONS = Object.freeze({
  arrive: 'action_arrive',
  load: 'action_load',
  ttn: 'action_ttn',
});

// Roles that may force-transfer: §6 names admin and senior_foreman only, so the
// matrix right alone is not enough for a foreman.
const FORCE_TRANSFER_ROLES = Object.freeze(['admin', 'senior_foreman']);

function requireActor(actor) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)
      || typeof actor.uid !== 'string' || actor.uid.length === 0 || actor.uid.length > 128
      || !ROLES.includes(actor.role)) {
    throw v2Error('invalid-command', 400, { field: 'actor' });
  }
  return { uid: actor.uid, role: actor.role };
}

function requireId(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) throw v2Error('invalid-command', 400, { field });
  return value;
}

async function loadShift(client, workspaceId, shiftId) {
  const row = (await client.query(
    `SELECT workspace_id,shift_id,state,revision,object_id,shift_type
       FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
    [workspaceId, shiftId],
  )).rows[0];
  if (!row) return null;
  return Object.freeze({
    workspaceId: row.workspace_id,
    shiftId: row.shift_id,
    state: row.state,
    revision: Number(row.revision),
    objectId: row.object_id,
    shiftType: row.shift_type,
  });
}

async function loadMembership(client, workspaceId, shiftId, uid) {
  const row = (await client.query(
    `SELECT uid,assigned_at,assigned_by_uid,removed_at,removed_by_uid,revision
       FROM shift_members
      WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3 AND removed_at IS NULL`,
    [workspaceId, shiftId, uid],
  )).rows[0];
  if (!row) return null;
  return Object.freeze({
    uid: row.uid,
    assignedAt: row.assigned_at,
    assignedByUid: row.assigned_by_uid,
    removedAt: row.removed_at,
    removedByUid: row.removed_by_uid,
    revision: Number(row.revision),
  });
}

// Any of the listed rights is enough (the matrix offers alternatives such as
// manage_trucks OR edit_line). FOR SHARE keeps a concurrent permissions.replace
// from changing the answer in the middle of the command transaction.
//
// Exported because a command that creates a shift has no shift row to authorize
// yet (§6 create row: admin or прораб + `start_shift`) and must use this exact
// matrix lookup instead of a second copy of it.
export async function hasAnyRight(client, role, rights) {
  if (rights.length === 0) return true;
  const rows = (await client.query(
    `SELECT allowed FROM role_permissions
      WHERE role=$1 AND action = ANY($2::text[]) FOR SHARE`,
    [role, rights],
  )).rows;
  return rows.some(row => row.allowed === true);
}

// Lifecycle gate: active accepts everything, closing accepts only the actions
// marked allowed, and a closed/historical shift answers 410 for every command
// except the close actions, whose domain owns the terminal answer.
function requireOpenLifecycle(shift, action, closing, terminal) {
  if (shift.state === 'active') return;
  if (shift.state === 'closing') {
    if (closing === 'allowed') return;
    throw v2Error('shift-closing', 409, { shiftId: shift.shiftId, state: shift.state });
  }
  if (action === 'shift.read' || terminal === 'domain') return;
  throw v2Error('shift-closed', 410, { shiftId: shift.shiftId, state: shift.state });
}

// Active profile or a stable refusal. A missing user is `401 unauthenticated`;
// a disabled/pending profile is `403 forbidden` — never a 500.
export async function loadActor(client, uid) {
  if (!client || typeof client.query !== 'function') throw new TypeError('loadActor requires a database client');
  if (typeof uid !== 'string' || uid.length === 0 || uid.length > 128) throw v2Error('unauthenticated', 401);
  const row = (await client.query(
    'SELECT uid,display_name,role,status FROM app_users WHERE uid=$1',
    [uid],
  )).rows[0];
  if (!row) throw v2Error('unauthenticated', 401, { reason: 'unknown-actor' });
  if (row.status !== 'active') throw v2Error('forbidden', 403, { reason: 'inactive-actor' });
  return Object.freeze({ uid: row.uid, displayName: row.display_name, role: row.role, status: row.status });
}

// Authorize one action on one shift and return `{shift, membership, via}`.
//
// `shiftId` is the shift the command targets (for force transfer that is the
// destination). Extra options:
//   sourceShiftId       — force transfer only; the source shift whose truck moves;
//   destinationShiftId  — detached completion only; the other shift of the pair;
//   lineAction          — detached completion only; arrive|load|ttn.
//
// `membership` is the row that granted access (null for admin), `via` says which
// route was used: `admin`, `shift`, `source` or `destination`.
export async function authorizeShift(client, actor, options) {
  if (!client || typeof client.query !== 'function') throw new TypeError('authorizeShift requires a database client');
  const input = options ?? {};
  const spec = Object.hasOwn(SHIFT_ACTIONS, input.action) ? SHIFT_ACTIONS[input.action] : null;
  if (!spec) throw v2Error('invalid-command', 400, { field: 'action' });
  const who = requireActor(actor);
  const workspaceId = requireId(input.workspaceId, 'workspaceId');
  const shiftId = requireId(input.shiftId, 'shiftId');
  const shift = await loadShift(client, workspaceId, shiftId);
  if (!shift) throw v2Error('shift-not-visible', 404, { shiftId });
  const admin = who.role === 'admin';

  if (input.action === 'shift.truck.force-transfer') {
    const sourceShiftId = requireId(input.sourceShiftId, 'sourceShiftId');
    // Role gate first: the right cannot promote a foreman (§6).
    if (!admin && !FORCE_TRANSFER_ROLES.includes(who.role)) {
      throw v2Error('forbidden', 403, { reason: 'force-transfer-role' });
    }
    if (!admin && !(await hasAnyRight(client, who.role, spec.rights))) {
      throw v2Error('forbidden', 403, { reason: 'missing-right' });
    }
    // Senior needs the destination membership; the source is reachable through
    // this cross-shift right alone.
    const membership = admin ? null : await loadMembership(client, workspaceId, shiftId, who.uid);
    if (!admin && !membership) throw v2Error('not-shift-member', 403, { shiftId });
    const sourceShift = await loadShift(client, workspaceId, sourceShiftId);
    if (!sourceShift) throw v2Error('shift-not-visible', 404, { shiftId: sourceShiftId });
    requireOpenLifecycle(shift, input.action, spec.closing, spec.terminal);
    requireOpenLifecycle(sourceShift, input.action, spec.closing, spec.terminal);
    return { shift, membership, sourceShift, via: admin ? 'admin' : 'destination' };
  }

  if (input.action === 'shift.detached.complete') {
    const destinationShiftId = requireId(input.destinationShiftId, 'destinationShiftId');
    const right = Object.hasOwn(DETACHED_LINE_ACTIONS, input.lineAction)
      ? DETACHED_LINE_ACTIONS[input.lineAction]
      : null;
    if (!right) throw v2Error('invalid-command', 400, { field: 'lineAction' });
    const destinationShift = await loadShift(client, workspaceId, destinationShiftId);
    if (!destinationShift) throw v2Error('shift-not-visible', 404, { shiftId: destinationShiftId });
    let membership = null;
    let via = 'admin';
    if (!admin) {
      // Access is recomputed per request: a current membership in the source OR
      // the current destination is enough, and losing one keeps the other route.
      const sourceMembership = await loadMembership(client, workspaceId, shift.shiftId, who.uid);
      membership = sourceMembership ?? await loadMembership(client, workspaceId, destinationShift.shiftId, who.uid);
      if (!membership) throw v2Error('not-shift-member', 403, { shiftId });
      via = sourceMembership ? 'source' : 'destination';
      if (!(await hasAnyRight(client, who.role, [right]))) {
        throw v2Error('forbidden', 403, { reason: 'missing-right' });
      }
    }
    requireOpenLifecycle(shift, input.action, spec.closing, spec.terminal);
    requireOpenLifecycle(destinationShift, input.action, spec.closing, spec.terminal);
    return { shift, membership, destinationShift, via };
  }

  let membership = null;
  if (!admin) {
    membership = await loadMembership(client, workspaceId, shiftId, who.uid);
    if (!membership) {
      // A read never discloses that the shift exists; a known command names the
      // missing membership instead.
      if (input.action === 'shift.read') throw v2Error('shift-not-visible', 404, { shiftId });
      throw v2Error('not-shift-member', 403, { shiftId });
    }
    if (!(await hasAnyRight(client, who.role, spec.rights))) {
      throw v2Error('forbidden', 403, { reason: 'missing-right' });
    }
  }
  requireOpenLifecycle(shift, input.action, spec.closing, spec.terminal);
  return { shift, membership, via: admin ? 'admin' : 'shift' };
}

// SQL fragment for a visible-shift filter (design §5.1: admin sees everything,
// everyone else only active memberships). The caller adds the workspace scope.
//
//   const { sql, params } = visibleShiftPredicate(actor, 's', 1);
//   client.query(`... WHERE s.workspace_id=$1 AND ${sql}`, [workspaceId, ...params]);
//
// The fragment is parameterized: the uid is always a bound value, and only the
// caller-supplied alias (validated as a plain identifier) is interpolated.
export function visibleShiftPredicate(actor, alias, startIndex = 1) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)
      || typeof actor.uid !== 'string' || actor.uid.length === 0 || actor.uid.length > 128
      || !ROLES.includes(actor.role)) {
    throw new TypeError('visibleShiftPredicate requires an actor with a known role');
  }
  if (typeof alias !== 'string' || !ALIAS.test(alias)) {
    throw new TypeError('visibleShiftPredicate requires a plain SQL alias');
  }
  if (!Number.isSafeInteger(startIndex) || startIndex < 1 || startIndex > 60_000) {
    throw new TypeError('visibleShiftPredicate requires a positive parameter index');
  }
  if (actor.role === 'admin') return { sql: 'TRUE', params: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM shift_members sm WHERE sm.workspace_id = ${alias}.workspace_id`
      + ` AND sm.shift_id = ${alias}.shift_id AND sm.uid = $${startIndex} AND sm.removed_at IS NULL)`,
    params: [actor.uid],
  };
}
