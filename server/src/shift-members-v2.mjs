import {createHash} from 'node:crypto';
import {v2Error} from './v2-errors.mjs';
import {runV2Command} from './v2-command.mjs';
import {authorizeShift, hasAnyRight, loadActor} from './shift-access-v2.mjs';

// Shift creation, object change and memberships (design §5.2, §5.3, §6, §7,
// plan Task 19).
//
// Every command goes through `runV2Command` (authorization → receipt →
// mutation → audit in one transaction), so replay, idempotency and audit are not
// re-implemented here. Authorization is `authorizeShift` for every command that
// targets an existing shift; creation has no shift yet, so it checks the same
// role/action matrix right (`start_shift`) directly.
//
// Strict v2 only: the writer builds the exact published v2 document (14 keys)
// and never writes `payload_schema_version=1`, never resolves or activates a
// legacy shift. The 025 trigger derives every canonical column from the
// document; this module supplies no contradictory column and fixes nothing up.
//
// CAS contract (§7):
//   create                 → shift rev=1, creator membership rev=1
//   change object          → expected shift rev, shift rev+1
//   add/reactivate member  → expected shift rev + membership rev/null,
//                            membership rev+1 and shift rev+1
//   remove member          → expected shift rev + membership rev,
//                            membership rev+1 and shift rev+1

const ID = /^[A-Za-z0-9_-]{1,160}$/;
const MEMBER_ROLES = Object.freeze(['senior_foreman', 'foreman']);
const SHIFT_TYPES = Object.freeze(['day', 'night']);
// shift_id is derived from the operation id so a retry is stable even before a
// receipt exists. The id stays an opaque token of the same shape as any other.
const DERIVED_ID_MAX_OPERATION = 150;

const SHIFT_FIELDS = `shift_id,state,revision,object_id,object_name_snapshot,
  to_char(work_date,'YYYY-MM-DD') AS work_date_text,shift_type,opened_at,
  object_locked_at,object_locked_by_operation_id`;
const MEMBERSHIP_FIELDS = 'uid,assigned_at,assigned_by_uid,removed_at,removed_by_uid,revision';

function requireWorkspace(value) {
  const workspaceId = value ?? process.env.WORKSPACE_ID ?? 'main_workspace';
  if (typeof workspaceId !== 'string' || !ID.test(workspaceId)) {
    throw v2Error('invalid-command', 400, {field: 'workspaceId'});
  }
  return workspaceId;
}

function requireId(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) throw v2Error('invalid-command', 400, {field});
  return value;
}

function requireOperation(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw v2Error('invalid-command', 400, {field: 'operationId'});
  return value;
}

// A missing or old declaration is a protocol answer, not a schema error.
function requireProtocol(value) {
  if (value === 2) return 2;
  const declared = Number(value);
  throw v2Error('protocol-upgrade-required', 426, {
    protocolVersion: Number.isSafeInteger(declared) && declared > 0 ? declared : 0,
  });
}

function requireRevision(value, field, {nullable = false} = {}) {
  if (value === null && nullable) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw v2Error('invalid-command', 400, {field});
  return value;
}

function requireShiftType(value) {
  if (!SHIFT_TYPES.includes(value)) throw v2Error('invalid-command', 400, {field: 'shiftType'});
  return value;
}

// `cycleMinutes` is part of the documented creation body. It is validated and
// hashed with the command, but the shifts row has no column for it, so it is
// never invented into the published v2 document (which is exactly 14 keys).
function requireCycleMinutes(value) {
  if (!Number.isSafeInteger(value) || value < 15 || value > 10080) {
    throw v2Error('invalid-command', 400, {field: 'cycleMinutes'});
  }
  return value;
}

function requireWorkDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw v2Error('invalid-command', 400, {field: 'workDate'});
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw v2Error('invalid-command', 400, {field: 'workDate'});
  }
  return value;
}

function moscowParts(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ms);
  const part = type => parts.find(item => item.type === type)?.value;
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    startDate: `${part('day')}.${part('month')}.${part('year')}`,
  };
}

function derivedShiftId(operationId) {
  if (operationId.length <= DERIVED_ID_MAX_OPERATION) return `shift_${operationId}`;
  return `shift_${createHash('sha256').update(operationId, 'utf8').digest('hex').slice(0, 32)}`;
}

// The exact published v2 start document (§4.7): 14 keys, nothing extra. The
// 025 trigger refuses any other key set on INSERT.
function buildShiftPayload({shiftId, objectId, objectName, shiftType, startedAt, actor}) {
  const {date, startDate} = moscowParts(startedAt);
  return {
    payloadSchemaVersion: 2,
    id: shiftId,
    shiftId,
    objectId,
    objectName,
    startDate,
    date,
    workShift: shiftType,
    type: shiftType,
    state: 'active',
    isActive: true,
    startedAt,
    startedByUid: actor.uid,
    startedBy: actor.displayName,
  };
}

function shiftView(row) {
  return {
    shiftId: row.shift_id,
    objectId: row.object_id,
    objectName: row.object_name_snapshot,
    workDate: row.work_date_text,
    shiftType: row.shift_type,
    state: row.state,
    openedAt: new Date(row.opened_at).toISOString(),
    shiftRevision: Number(row.revision),
  };
}

function membershipView(row) {
  return {
    uid: row.uid,
    revision: Number(row.revision),
    assignedAt: new Date(row.assigned_at).toISOString(),
    assignedByUid: row.assigned_by_uid,
    removedAt: row.removed_at ? new Date(row.removed_at).toISOString() : null,
    removedByUid: row.removed_by_uid,
  };
}

// A deleted or disabled object never starts a line (§3.1/§5.2). The display
// name is required because the payload snapshot is NOT NULL.
async function loadObject(client, workspaceId, objectId) {
  const row = (await client.query(
    'SELECT payload FROM workspace_objects WHERE workspace_id=$1 AND object_id=$2 FOR SHARE',
    [workspaceId, objectId],
  )).rows[0];
  if (!row) return null;
  const payload = row.payload ?? {};
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name || name.length > 500) return null;
  if (payload.deleted === true || payload.disabled === true) return null;
  return {objectId, name};
}

async function lockShift(client, workspaceId, shiftId) {
  return (await client.query(
    `SELECT ${SHIFT_FIELDS},payload FROM shifts
      WHERE workspace_id=$1 AND shift_id=$2 FOR UPDATE`,
    [workspaceId, shiftId],
  )).rows[0] ?? null;
}

async function requireActiveShift(client, workspaceId, shiftId, expectedShiftRevision) {
  const shift = await lockShift(client, workspaceId, shiftId);
  if (!shift) throw v2Error('shift-not-visible', 404, {shiftId});
  // `authorizeShift` already applied the lifecycle gate; the locked re-read
  // keeps a concurrent close from slipping between authorization and mutation.
  if (shift.state !== 'active') {
    throw v2Error(shift.state === 'closing' ? 'shift-closing' : 'shift-closed',
      shift.state === 'closing' ? 409 : 410, {shiftId, state: shift.state});
  }
  if (Number(shift.revision) !== expectedShiftRevision) {
    throw v2Error('shift-changed', 409, {
      expectedShiftRevision,
      actualShiftRevision: Number(shift.revision),
    });
  }
  return shift;
}

// Re-read the actor inside the command transaction (a revoked or disabled
// profile must never inherit a stored result) and apply the action ACL.
function authorizeOnShift(action, workspaceId, shiftId) {
  return async (client, context) => {
    const actor = await loadActor(client, context.uid);
    await authorizeShift(client, actor, {action, workspaceId, shiftId});
    return actor;
  };
}

function membershipConflict(expected, actual) {
  return v2Error('membership-changed', 409, {
    expectedMembershipRevision: expected,
    actualMembershipRevision: actual,
  });
}

// POST /api/v2/shifts — strict v2 creation, creator membership rev=1.
export async function createShift(pool, actor, input) {
  const options = input ?? {};
  const workspaceId = requireWorkspace(options.workspaceId);
  const operationId = requireOperation(options.operationId);
  const protocolVersion = requireProtocol(options.protocolVersion);
  const objectId = requireId(options.objectId, 'objectId');
  const shiftType = requireShiftType(options.shiftType);
  const workDate = requireWorkDate(options.workDate);
  const cycleMinutes = requireCycleMinutes(options.cycleMinutes);
  const shiftId = derivedShiftId(operationId);
  const body = {objectId, shiftType, workDate, cycleMinutes};

  const authorize = async (client, context) => {
    const profile = await loadActor(client, context.uid);
    // §6: create is admin or прораб + `start_shift`. There is no shift yet, so
    // `authorizeShift` cannot apply; the matrix right is the same one.
    if (profile.role !== 'admin' && !(await hasAnyRight(client, profile.role, ['start_shift']))) {
      throw v2Error('forbidden', 403, {reason: 'missing-right'});
    }
    return profile;
  };

  const mutate = async (client, context) => {
    const creator = context.actor;
    const startedAt = Date.now();
    const {date} = moscowParts(startedAt);
    // The published document must prove its own date, so a work date that is not
    // the creation date is a client error instead of an invented timestamp.
    if (workDate !== null && workDate !== date) {
      throw v2Error('invalid-command', 400, {field: 'workDate'});
    }
    const object = await loadObject(client, workspaceId, objectId);
    if (!object) throw v2Error('object-not-available', 409, {objectId});
    const payload = buildShiftPayload({
      shiftId, objectId, objectName: object.name, shiftType, startedAt, actor: creator,
    });
    let inserted;
    try {
      inserted = (await client.query(
        `INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3::jsonb) RETURNING ${SHIFT_FIELDS}`,
        [workspaceId, shiftId, payload],
      )).rows[0];
    } catch (error) {
      // The partial unique index decides the duplicate race; the client gets the
      // same stable answer as a sequential duplicate.
      if (error?.code === '23505') throw v2Error('shift-duplicate', 409, {objectId, workDate: date, shiftType});
      if (error?.code === '23503' && error?.constraint === 'shifts_object_fk') {
        throw v2Error('object-not-available', 409, {objectId});
      }
      throw error;
    }
    // §3.2: the creator joins in the same transaction. Admin manages without a
    // membership and is never forced into one; only foremen are members.
    let membership = null;
    if (MEMBER_ROLES.includes(creator.role)) {
      membership = membershipView((await client.query(
        `INSERT INTO shift_members(workspace_id,shift_id,uid,assigned_at,assigned_by_uid,revision)
         VALUES($1,$2,$3,now(),$4,1) RETURNING ${MEMBERSHIP_FIELDS}`,
        [workspaceId, shiftId, creator.uid, creator.uid],
      )).rows[0]);
    }
    const shift = shiftView(inserted);
    return {
      result: {shift, membership},
      after: {shiftRevision: shift.shiftRevision, membershipRevision: membership?.revision ?? null},
    };
  };

  return runV2Command({
    pool, uid: actor.uid, workspaceId, shiftId, protocolVersion,
    operation: operationId, type: 'shift.create', body, authorize, mutate,
  });
}

// PATCH /api/v2/shifts/{shiftId}/object — CAS on the shift revision and only
// before the first confirmed arrive locks the object (§3.1).
export async function changeShiftObject(pool, actor, input) {
  const options = input ?? {};
  const workspaceId = requireWorkspace(options.workspaceId);
  const shiftId = requireId(options.shiftId, 'shiftId');
  const operationId = requireOperation(options.operationId);
  const protocolVersion = requireProtocol(options.protocolVersion);
  const objectId = requireId(options.objectId, 'objectId');
  const expectedShiftRevision = requireRevision(options.expectedShiftRevision, 'expectedShiftRevision');
  const body = {objectId, expectedShiftRevision};

  const mutate = async (client, context) => {
    const shift = await requireActiveShift(client, workspaceId, shiftId, expectedShiftRevision);
    if (shift.object_locked_at !== null) throw v2Error('object-locked', 409, {shiftId});
    const before = {shiftRevision: Number(shift.revision), objectId: shift.object_id};
    if (shift.object_id === objectId) {
      // Same object: an honest no-op, the revision is not bumped for nothing.
      return {result: {shift: shiftView(shift)}, before, after: before};
    }
    const object = await loadObject(client, workspaceId, objectId);
    if (!object) throw v2Error('object-not-available', 409, {objectId});
    // Pre-check for the stable code; the partial unique index is the real guard.
    const duplicate = await client.query(
      `SELECT 1 FROM shifts
        WHERE workspace_id=$1 AND object_id=$2 AND work_date=$3 AND shift_type=$4
          AND state IN ('active','closing') AND shift_type_resolution IN ('source','manual')
          AND shift_id<>$5`,
      [workspaceId, objectId, shift.work_date_text, shift.shift_type, shiftId],
    );
    if (duplicate.rowCount) {
      throw v2Error('shift-duplicate', 409, {
        objectId, workDate: shift.work_date_text, shiftType: shift.shift_type,
      });
    }
    let updated;
    try {
      // The published document follows the object, so the trigger's canonical
      // columns stay derived from it. `revision` is the CAS counter.
      updated = (await client.query(
        `UPDATE shifts
            SET payload = payload || jsonb_build_object('objectId',$3::text,'objectName',$4::text),
                revision = revision + 1
          WHERE workspace_id=$1 AND shift_id=$2
          RETURNING ${SHIFT_FIELDS}`,
        [workspaceId, shiftId, objectId, object.name],
      )).rows[0];
    } catch (error) {
      if (error?.code === '23505') {
        throw v2Error('shift-duplicate', 409, {
          objectId, workDate: shift.work_date_text, shiftType: shift.shift_type,
        });
      }
      throw error;
    }
    const view = shiftView(updated);
    return {
      result: {shift: view},
      before,
      after: {shiftRevision: view.shiftRevision, objectId: view.objectId},
    };
  };

  return runV2Command({
    pool, uid: actor.uid, workspaceId, shiftId, protocolVersion,
    operation: operationId, type: 'shift.object.change', body,
    authorize: authorizeOnShift('shift.object.change', workspaceId, shiftId),
    mutate,
  });
}

// POST /api/v2/shifts/{shiftId}/members — add a new member or reactivate a
// removed one on the same row (§3.2).
export async function addShiftMember(pool, actor, input) {
  const options = input ?? {};
  const workspaceId = requireWorkspace(options.workspaceId);
  const shiftId = requireId(options.shiftId, 'shiftId');
  const uid = requireId(options.uid, 'uid');
  const operationId = requireOperation(options.operationId);
  const protocolVersion = requireProtocol(options.protocolVersion);
  const expectedShiftRevision = requireRevision(options.expectedShiftRevision, 'expectedShiftRevision');
  const expectedMembershipRevision = requireRevision(
    options.expectedMembershipRevision, 'expectedMembershipRevision', {nullable: true},
  );
  const body = {uid, expectedShiftRevision, expectedMembershipRevision};

  const mutate = async (client, context) => {
    const manager = context.actor;
    const shift = await requireActiveShift(client, workspaceId, shiftId, expectedShiftRevision);
    // §3.2: only an active foreman can be a member. A worker/driver/disabled or
    // unknown uid is a stable 400, never the trigger's bare 23514 and never 500.
    const target = (await client.query(
      'SELECT uid,role,status FROM app_users WHERE uid=$1',
      [uid],
    )).rows[0];
    if (!target || target.status !== 'active' || !MEMBER_ROLES.includes(target.role)) {
      throw v2Error('member-not-eligible', 400, {field: 'uid'});
    }
    const existing = (await client.query(
      `SELECT ${MEMBERSHIP_FIELDS} FROM shift_members
        WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3 FOR UPDATE`,
      [workspaceId, shiftId, uid],
    )).rows[0];
    let membership;
    if (expectedMembershipRevision === null) {
      // `null` promises that no membership row exists at all.
      if (existing) throw membershipConflict(null, Number(existing.revision));
      try {
        membership = membershipView((await client.query(
          `INSERT INTO shift_members(workspace_id,shift_id,uid,assigned_at,assigned_by_uid,revision)
           VALUES($1,$2,$3,now(),$4,1) RETURNING ${MEMBERSHIP_FIELDS}`,
          [workspaceId, shiftId, uid, manager.uid],
        )).rows[0]);
      } catch (error) {
        if (error?.code === '23503') throw v2Error('member-not-eligible', 400, {field: 'uid'});
        // A concurrent insert of the same member is a CAS loss, not a 500.
        if (error?.code === '23505') throw membershipConflict(null, null);
        if (error?.code === '23514') throw v2Error('member-not-eligible', 400, {field: 'uid'});
        throw error;
      }
    } else {
      if (!existing) throw membershipConflict(expectedMembershipRevision, null);
      if (Number(existing.revision) !== expectedMembershipRevision) {
        throw membershipConflict(expectedMembershipRevision, Number(existing.revision));
      }
      if (existing.removed_at === null) {
        // Already an active member: nothing to reactivate.
        throw membershipConflict(expectedMembershipRevision, Number(existing.revision));
      }
      // Reactivation updates the existing row and clears the soft delete.
      membership = membershipView((await client.query(
        `UPDATE shift_members
            SET removed_at=NULL, removed_by_uid=NULL, assigned_at=now(),
                assigned_by_uid=$4, revision=revision+1
          WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3
          RETURNING ${MEMBERSHIP_FIELDS}`,
        [workspaceId, shiftId, uid, manager.uid],
      )).rows[0]);
    }
    const shiftRevision = Number(shift.revision) + 1;
    await client.query(
      'UPDATE shifts SET revision=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [workspaceId, shiftId, shiftRevision],
    );
    return {
      result: {shift: {shiftId, shiftRevision}, membership},
      before: {shiftRevision: Number(shift.revision), membershipRevision: expectedMembershipRevision},
      after: {shiftRevision, membershipRevision: membership.revision, uid},
    };
  };

  return runV2Command({
    pool, uid: actor.uid, workspaceId, shiftId, protocolVersion,
    operation: operationId, type: 'shift.member.add', body,
    authorize: authorizeOnShift('shift.member.add', workspaceId, shiftId),
    mutate,
  });
}

// DELETE /api/v2/shifts/{shiftId}/members/{uid} — soft delete with CAS. The last
// active member cannot be removed by an ordinary member (§3.2); admin keeps the
// orphan repair.
export async function removeShiftMember(pool, actor, input) {
  const options = input ?? {};
  const workspaceId = requireWorkspace(options.workspaceId);
  const shiftId = requireId(options.shiftId, 'shiftId');
  const uid = requireId(options.uid, 'uid');
  const operationId = requireOperation(options.operationId);
  const protocolVersion = requireProtocol(options.protocolVersion);
  const expectedShiftRevision = requireRevision(options.expectedShiftRevision, 'expectedShiftRevision');
  const expectedMembershipRevision = requireRevision(options.expectedMembershipRevision, 'expectedMembershipRevision');
  const body = {uid, expectedShiftRevision, expectedMembershipRevision};

  const mutate = async (client, context) => {
    const manager = context.actor;
    const shift = await requireActiveShift(client, workspaceId, shiftId, expectedShiftRevision);
    const existing = (await client.query(
      `SELECT ${MEMBERSHIP_FIELDS} FROM shift_members
        WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3 FOR UPDATE`,
      [workspaceId, shiftId, uid],
    )).rows[0];
    if (!existing || existing.removed_at !== null) {
      throw membershipConflict(expectedMembershipRevision, existing ? Number(existing.revision) : null);
    }
    if (Number(existing.revision) !== expectedMembershipRevision) {
      throw membershipConflict(expectedMembershipRevision, Number(existing.revision));
    }
    if (manager.role !== 'admin') {
      const active = (await client.query(
        `SELECT count(*)::int AS total FROM shift_members
          WHERE workspace_id=$1 AND shift_id=$2 AND removed_at IS NULL`,
        [workspaceId, shiftId],
      )).rows[0].total;
      if (active <= 1) throw v2Error('last-shift-member', 409, {shiftId});
    }
    const membership = membershipView((await client.query(
      `UPDATE shift_members
          SET removed_at=now(), removed_by_uid=$4, revision=revision+1
        WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3
        RETURNING ${MEMBERSHIP_FIELDS}`,
      [workspaceId, shiftId, uid, manager.uid],
    )).rows[0]);
    const shiftRevision = Number(shift.revision) + 1;
    await client.query(
      'UPDATE shifts SET revision=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [workspaceId, shiftId, shiftRevision],
    );
    return {
      result: {shift: {shiftId, shiftRevision}, membership},
      before: {shiftRevision: Number(shift.revision), membershipRevision: Number(existing.revision)},
      after: {shiftRevision, membershipRevision: membership.revision, uid},
    };
  };

  return runV2Command({
    pool, uid: actor.uid, workspaceId, shiftId, protocolVersion,
    operation: operationId, type: 'shift.member.remove', body,
    authorize: authorizeOnShift('shift.member.remove', workspaceId, shiftId),
    mutate,
  });
}
