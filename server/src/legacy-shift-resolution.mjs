import { createHash } from 'node:crypto';

import { fail, map } from './tabel-access.mjs';
import { canonicalJson } from './legacy-historicalization.mjs';

// Manual legacy provenance resolution (design §4.9, Task 5).
//
// This command only ever writes the two provenance dimensions of an existing
// row: it never activates a shift, never touches object/date, and never rewrites
// the stored document. Everything else about the row stays exactly as the
// historicalization cutover left it.
export const RESOLVE_ACTION = 'resolve_legacy_shift';
export const PROTOCOL_VERSION = 2;
export const EVIDENCE_NOTE_MAX = 1000;
export const GUARD_KEY_SCHEMA = 'samosval.legacy-resolution-guard/v1';
export const REQUEST_SCHEMA = 'samosval.legacy-resolution-request/v1';

const SET_KEYS = Object.freeze(['openedByUid', 'shiftType']);
const OPERATION_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SHIFT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const WORK_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const sha256Hex = value => createHash('sha256').update(value, 'utf8').digest('hex');

// D11: the gate is the exact action, and only an admin may hold it. A row in the
// matrix is authoritative when it exists (so an operator can revoke the action
// from admin too); without a row the documented default applies, which is "admin
// only" exactly like `roleView`.
export function resolveActionAllowed(role, rows) {
  if (role !== 'admin') return false;
  const row = (rows ?? []).find(item => item.action === RESOLVE_ACTION);
  return row ? row.allowed === true : true;
}

// D13: the guard key is the exact canonical tuple, never a hash. The two 64-bit
// advisory hashes below only serialize; a hash collision merely serializes two
// unrelated commands, while correctness comes from the unique exact key.
export function canonicalLegacyGuardKey({ workspaceId, objectId, workDate, shiftType }) {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) throw fail('invalid-resolution-command', 400);
  if (typeof objectId !== 'string' || objectId.length === 0) throw fail('invalid-resolution-command', 400);
  if (typeof workDate !== 'string' || !WORK_DATE.test(workDate)) throw fail('invalid-resolution-command', 400);
  if (shiftType !== null && shiftType !== undefined && !['day', 'night'].includes(shiftType)) {
    throw fail('invalid-resolution-command', 400);
  }
  return canonicalJson({
    schema: GUARD_KEY_SCHEMA,
    workspaceId,
    objectId,
    workDate,
    // An unresolved type is its own key: resolving identity on a row whose type
    // is still unknown must not pretend to know which line it belongs to.
    shiftType: shiftType ?? null,
  });
}

// Advisory-lock namespaces. `hashtext()` in the rest of the codebase lands in
// i32 sign-extended to i64, so a full 64-bit hash could in principle collide with
// it and create an A(advisory)→B(row) / B(row)→A(advisory) cycle against
// `shift-close`. Pinning the high i32 to a fixed, non-{0,-1} namespace keeps our
// keys in a disjoint band: two different keys still never share an id (they
// differ in the low 32 bits) and no `hashtext` id can ever land here.
export const GUARD_LOCK_NAMESPACES = Object.freeze([0x534d0001, 0x534d0002]);

const namespacedLockId = (namespace, hex) => {
  const low = BigInt(`0x${hex.slice(0, 8)}`);
  const value = (BigInt(namespace) << 32n) | low;
  return (value >= 1n << 63n ? value - (1n << 64n) : value).toString();
};

export function legacyGuardLockIds(canonicalKey) {
  const digest = sha256Hex(canonicalKey);
  return [
    namespacedLockId(GUARD_LOCK_NAMESPACES[0], digest.slice(0, 8)),
    namespacedLockId(GUARD_LOCK_NAMESPACES[1], digest.slice(8, 16)),
  ];
}

// Acquire both advisory locks in a fixed numeric order: two sessions that
// serialize the same key must never wait on each other in opposite order.
export async function lockLegacyGuardKey(client, canonicalKey) {
  const ids = legacyGuardLockIds(canonicalKey)
    .sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0));
  for (const id of ids) await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [id]);
}

function normalizeEvidenceNote(value) {
  // D17: the server validates shape only. Detecting phones/tokens heuristically
  // produces false positives, so the personal-data warning is a UI concern.
  if (typeof value !== 'string') throw fail('evidence-note-required', 400);
  const note = value.trim();
  if (note.length === 0) throw fail('evidence-note-required', 400);
  if (Array.from(note).length > EVIDENCE_NOTE_MAX) throw fail('invalid-resolution-command', 400);
  if (CONTROL_CHARS.test(note)) throw fail('invalid-resolution-command', 400);
  return note;
}

// D12/D17/D19: structural validation only. A `null` value is kept as "the
// caller tried to clear this dimension" and is refused later with the
// field-state error, not with a malformed-command error.
export function normalizeResolutionCommand(input) {
  if (!map(input)) throw fail('invalid-resolution-command', 400);
  const { operationId, protocolVersion, expectedShiftRevision } = input;
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) throw fail('invalid-resolution-command', 400);
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1) throw fail('invalid-resolution-command', 400);
  if (!Number.isSafeInteger(expectedShiftRevision) || expectedShiftRevision < 1) throw fail('invalid-resolution-command', 400);
  if (!map(input.set)) throw fail('invalid-resolution-command', 400);
  const keys = Object.keys(input.set);
  if (keys.length === 0 || keys.some(key => !SET_KEYS.includes(key))) throw fail('invalid-resolution-command', 400);
  const set = {};
  if (Object.hasOwn(input.set, 'openedByUid')) {
    const value = input.set.openedByUid;
    if (value !== null && (typeof value !== 'string' || value.length === 0 || value.length > 128 || value !== value.trim())) {
      throw fail('invalid-resolution-command', 400);
    }
    set.openedByUid = value;
  }
  if (Object.hasOwn(input.set, 'shiftType')) {
    const value = input.set.shiftType;
    if (value !== null && !['day', 'night'].includes(value)) throw fail('invalid-resolution-command', 400);
    set.shiftType = value;
  }
  return { operationId, protocolVersion, expectedShiftRevision, set, evidenceNote: normalizeEvidenceNote(input.evidenceNote) };
}

export function canonicalResolutionRequest(command, { workspaceId, shiftId }) {
  const canonical = canonicalJson({
    schema: REQUEST_SCHEMA,
    workspaceId,
    shiftId,
    operationId: command.operationId,
    protocolVersion: command.protocolVersion,
    expectedShiftRevision: command.expectedShiftRevision,
    set: command.set,
    evidenceNote: command.evidenceNote,
  });
  return { canonical, hash: sha256Hex(canonical) };
}

async function assertResolutionActor(client, uid) {
  if (typeof uid !== 'string' || uid.length === 0) throw fail('owner-acl-denied', 403);
  // FOR SHARE like every other permission gate in this project (shift-close,
  // control-store, line-store, truck-phone): a revoke or a disable that lands
  // between this check and COMMIT must not slip under an operation already
  // in flight.
  const actor = (await client.query('SELECT role, status FROM app_users WHERE uid=$1 FOR SHARE', [uid])).rows[0];
  if (!actor || actor.status !== 'active') throw fail('owner-acl-denied', 403);
  const rows = (await client.query(
    'SELECT action, allowed FROM role_permissions WHERE role=$1 AND action=$2 FOR SHARE',
    [actor.role, RESOLVE_ACTION],
  )).rows;
  if (!resolveActionAllowed(actor.role, rows)) throw fail('owner-acl-denied', 403);
}

const shiftKeySql = `
  SELECT object_id, to_char(work_date,'YYYY-MM-DD') AS work_date, shift_type
    FROM shifts WHERE workspace_id=$1 AND shift_id=$2`;

const shiftRowSql = `
  SELECT object_id, to_char(work_date,'YYYY-MM-DD') AS work_date, state, is_active, revision,
         opened_by_uid, identity_resolution, shift_type, shift_type_resolution
    FROM shifts WHERE workspace_id=$1 AND shift_id=$2 FOR UPDATE`;

const requestedType = (command, row) => (
  Object.hasOwn(command.set, 'shiftType') && command.set.shiftType !== null ? command.set.shiftType : row.shift_type
);

export async function resolveLegacyShift(pool, { uid, workspaceId, shiftId, body }) {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) throw fail('invalid-resolution-command', 400);
  if (typeof shiftId !== 'string' || !SHIFT_ID.test(shiftId)) throw fail('legacy-shift-not-found', 404);
  const command = normalizeResolutionCommand(body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // D14: the ACL is re-checked on every request, including an identical replay,
    // so a revoked or disabled admin never receives the stored result.
    await assertResolutionActor(client, uid);
    const { hash } = canonicalResolutionRequest(command, { workspaceId, shiftId });

    const receipt = (await client.query(
      `SELECT shift_id, protocol_version, actor_uid, command_hash, result
         FROM shift_legacy_resolution_receipts WHERE workspace_id=$1 AND operation_id=$2`,
      [workspaceId, command.operationId],
    )).rows[0];
    if (receipt) {
      const sameRequest = receipt.command_hash === hash
        && receipt.actor_uid === uid
        && receipt.shift_id === shiftId
        && Number(receipt.protocol_version) === command.protocolVersion;
      if (!sameRequest) throw fail('operation-id-reused', 409);
      await client.query('COMMIT');
      return { ...receipt.result, replayed: true };
    }

    // A fresh command must speak the current protocol. It is checked before the
    // guard lock so a rejected request takes no lock and writes no guard row; a
    // different version under an already used operation id was answered above as
    // a reuse, never as an upgrade. §5.0 maps this stable code to 426 (the brief's
    // D19 said 409; the design is normative, and the only caller today is the
    // not-yet-wired v2 route).
    if (command.protocolVersion !== PROTOCOL_VERSION) throw fail('protocol-upgrade-required', 426);

    // The guard key needs the row's own type when the command does not choose one,
    // so it is peeked without a lock first and re-verified under FOR UPDATE.
    const peek = (await client.query(shiftKeySql, [workspaceId, shiftId])).rows[0];
    if (!peek) throw fail('legacy-shift-not-found', 404);
    const guardKey = canonicalLegacyGuardKey({
      workspaceId,
      objectId: peek.object_id,
      workDate: peek.work_date,
      shiftType: requestedType(command, peek),
    });
    await lockLegacyGuardKey(client, guardKey);
    await client.query(
      'INSERT INTO shift_legacy_resolution_guard(workspace_id,guard_key) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [workspaceId, guardKey],
    );

    // D14: the receipt is read a second time now that the guard lock is held. Two
    // identical concurrent requests both miss the first read, serialize on the
    // guard, and the loser must replay the winner's result rather than fail with
    // `shift-changed` on a revision it never saw.
    const settled = (await client.query(
      `SELECT shift_id, protocol_version, actor_uid, command_hash, result
         FROM shift_legacy_resolution_receipts WHERE workspace_id=$1 AND operation_id=$2`,
      [workspaceId, command.operationId],
    )).rows[0];
    if (settled) {
      const sameRequest = settled.command_hash === hash
        && settled.actor_uid === uid
        && settled.shift_id === shiftId
        && Number(settled.protocol_version) === command.protocolVersion;
      if (!sameRequest) throw fail('operation-id-reused', 409);
      await client.query('COMMIT');
      return { ...settled.result, replayed: true };
    }

    const row = (await client.query(shiftRowSql, [workspaceId, shiftId])).rows[0];
    if (!row) throw fail('legacy-shift-not-found', 404);
    if (canonicalLegacyGuardKey({
      workspaceId, objectId: row.object_id, workDate: row.work_date, shiftType: requestedType(command, row),
    }) !== guardKey) {
      throw fail('shift-changed', 409);
    }
    if (Number(row.revision) !== command.expectedShiftRevision) throw fail('shift-changed', 409);

    // D12: only an unresolved dimension may become manual; clearing a value or
    // rewriting a source/manual one is refused and writes nothing.
    const openedByUid = Object.hasOwn(command.set, 'openedByUid') ? command.set.openedByUid : undefined;
    const shiftType = Object.hasOwn(command.set, 'shiftType') ? command.set.shiftType : undefined;
    if (openedByUid !== undefined
        && (openedByUid === null || row.identity_resolution !== 'unresolved')) {
      throw fail('legacy-field-not-unresolved', 409);
    }
    if (shiftType !== undefined
        && (shiftType === null || row.shift_type_resolution !== 'unresolved')) {
      throw fail('legacy-field-not-unresolved', 409);
    }
    if (openedByUid === undefined && shiftType === undefined) throw fail('legacy-field-not-unresolved', 409);
    if (openedByUid !== undefined) {
      // D16: a soft-disabled historical account is a legal provenance target; a
      // hard-deleted or never-existing uid is not.
      const opener = (await client.query('SELECT 1 FROM app_users WHERE uid=$1', [openedByUid])).rows[0];
      if (!opener) throw fail('legacy-opener-unknown', 422);
    }

    const assignments = ['revision = revision + 1'];
    const values = [workspaceId, shiftId, command.expectedShiftRevision];
    if (openedByUid !== undefined) {
      values.push(openedByUid);
      assignments.push(`opened_by_uid=$${values.length}`, "identity_resolution='manual'");
    }
    if (shiftType !== undefined) {
      values.push(shiftType);
      assignments.push(`shift_type=$${values.length}`, "shift_type_resolution='manual'");
    }
    let updated;
    try {
      updated = await client.query(
        `UPDATE shifts SET ${assignments.join(', ')}
          WHERE workspace_id=$1 AND shift_id=$2 AND revision=$3
         RETURNING revision`,
        values,
      );
    } catch (error) {
      if (error.code === '23503') throw fail('legacy-opener-unknown', 422);
      // The row-level D12 trigger refuses the same transitions the JS gate does;
      // surface it as the same stable code instead of a raw 23514.
      if (error.code === '23514' && /legacy-field-not-unresolved/.test(error.message ?? '')) {
        throw fail('legacy-field-not-unresolved', 409);
      }
      throw error;
    }
    if (updated.rowCount !== 1) throw fail('shift-changed', 409);

    const result = {
      outcome: 'resolved',
      operationId: command.operationId,
      shiftId,
      revision: Number(updated.rows[0].revision),
      openedByUid: openedByUid !== undefined ? openedByUid : row.opened_by_uid,
      identityResolution: openedByUid !== undefined ? 'manual' : row.identity_resolution,
      shiftType: shiftType !== undefined ? shiftType : row.shift_type,
      shiftTypeResolution: shiftType !== undefined ? 'manual' : row.shift_type_resolution,
    };
    try {
      await client.query(
        `INSERT INTO shift_legacy_resolution_receipts
           (workspace_id, operation_id, shift_id, protocol_version, actor_uid, command_hash, result)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [workspaceId, command.operationId, shiftId, command.protocolVersion, uid, hash, result],
      );
      await client.query(
        `INSERT INTO shift_legacy_resolution_audit
           (workspace_id, operation_id, shift_id,
            old_opened_by_uid, new_opened_by_uid, old_identity_resolution, new_identity_resolution,
            old_shift_type, new_shift_type, old_shift_type_resolution, new_shift_type_resolution,
            evidence_note, actor_uid, expected_revision, result_revision, command_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [workspaceId, command.operationId, shiftId,
          row.opened_by_uid, result.openedByUid, row.identity_resolution, result.identityResolution,
          row.shift_type, result.shiftType, row.shift_type_resolution, result.shiftTypeResolution,
          command.evidenceNote, uid, command.expectedShiftRevision, result.revision, hash],
      );
    } catch (error) {
      // A concurrent command that used the same operation id for a different shift
      // serializes on a different guard key, so it can only be caught here. It is
      // a reused operation id, never a server fault.
      if (error.code === '23505' && /shift_legacy_resolution_receipts/.test(error.message ?? '')) {
        throw fail('operation-id-reused', 409);
      }
      // A hard delete of the actor that raced this transaction must read as a
      // permission failure, not as an internal error.
      if (error.code === '23503') throw fail('owner-acl-denied', 403);
      throw error;
    }
    await client.query('COMMIT');
    // The replay path answers `replayed: true`, so the executed path answers
    // `false` instead of omitting the field: one stable shape for every caller,
    // and the caller can tell a fresh execution from a replayed one.
    return { ...result, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
