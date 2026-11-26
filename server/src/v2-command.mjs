import {createHash} from 'node:crypto';
import {v2Error} from './v2-errors.mjs';

// V2 command protocol foundation (design §4.5, §4.7, §5).
//
// Every mutating v2 command is identified by the exact tuple
// `uid + workspaceId + shiftId + protocolVersion + operation + type + body`.
// The tuple is serialized as RFC 8785/JCS canonical JSON and hashed with
// SHA-256; the hash is the receipt's request hash. A replay is therefore only a
// replay when all seven values match, and any change is `operation-id-reused`.
export const COMMAND_HASH_FIELDS = Object.freeze([
  'uid', 'workspaceId', 'shiftId', 'protocolVersion', 'operation', 'type', 'body'
]);

// The shift-scoped receipt table that already exists (sql/003_shift_close.sql).
// §4.5 adds `protocol_version`/`command_hash`/`shift_id` columns to it in a later
// migration; until then `request_hash` carries the command hash and the protocol
// version is bound by that hash.
export const V2_RECEIPT_TABLE = 'shift_operation_receipts';
// Generic command audit (sql/008_workspace_services.sql) — the same table the v1
// `serviceCommand` runner uses: one row per operation with actor, type and
// before/after JSON. It has no shift_id column, so the shift is stored inside the
// before/after payload; a dedicated shift-scoped v2 audit table belongs to 027.
export const V2_AUDIT_TABLE = 'workspace_service_audit';

const OPERATION_ID = /^[A-Za-z0-9_-]{1,160}$/;
// RFC 8785 requires valid Unicode: a lone surrogate cannot be serialized.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serialize(value, stack, path) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonical JSON rejects a non-finite number at ${path}`);
      // JSON has one zero: -0 is normalized explicitly, never rounded from another value.
      if (Object.is(value, -0)) return '0';
      return JSON.stringify(value);
    case 'string':
      if (LONE_SURROGATE.test(value)) throw new TypeError(`canonical JSON rejects a lone surrogate at ${path}`);
      return JSON.stringify(value);
    case 'object': break;
    default: throw new TypeError(`canonical JSON rejects ${typeof value} at ${path}`);
  }
  if (stack.has(value)) throw new TypeError(`canonical JSON rejects a cyclic reference at ${path}`);
  if (Array.isArray(value)) {
    stack.add(value);
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError(`canonical JSON rejects a sparse array at ${path}[${index}]`);
      items.push(serialize(value[index], stack, `${path}[${index}]`));
    }
    stack.delete(value);
    return `[${items.join(',')}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`canonical JSON rejects a non-plain object at ${path}`);
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`canonical JSON rejects symbol keys at ${path}`);
  stack.add(value);
  // Default sort() compares UTF-16 code units, which is exactly JCS order.
  const keys = Object.keys(value).sort();
  const members = keys.map(key => {
    if (LONE_SURROGATE.test(key)) throw new TypeError(`canonical JSON rejects a lone surrogate in a key at ${path}`);
    return `${JSON.stringify(key)}:${serialize(value[key], stack, `${path}.${key}`)}`;
  });
  stack.delete(value);
  return `{${members.join(',')}}`;
}

// Deterministic, whitespace-free, finite-only JSON (RFC 8785 compatible).
// Rejects anything that is not exact JSON instead of "helpfully" converting it:
// undefined, functions, symbols, bigint, NaN/Infinity, Date, Map, Set, RegExp,
// typed arrays, class instances, symbol keys, sparse arrays and cycles.
export function canonicalJson(value) {
  return serialize(value, new Set(), '$');
}

export function commandHash(parts) {
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) throw new TypeError('commandHash requires a plain parts object');
  const unexpected = Object.keys(parts).filter(key => !COMMAND_HASH_FIELDS.includes(key)).sort();
  if (unexpected.length) throw new TypeError(`commandHash rejects unexpected fields: ${unexpected.join(', ')}`);
  const missing = COMMAND_HASH_FIELDS.filter(field => !Object.hasOwn(parts, field));
  if (missing.length) throw new TypeError(`commandHash requires fields: ${missing.join(', ')}`);
  const canonical = canonicalJson(Object.fromEntries(COMMAND_HASH_FIELDS.map(field => [field, parts[field]])));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value || value.length > 160) throw v2Error('invalid-command', 400, {field});
  return value;
}

function requireAuditPayload(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw v2Error('invalid-command', 400, {field});
  return value;
}

// One command = one transaction: pending receipt, mutation, audit, result, COMMIT.
//
//   authorize(client, context) -> actor        re-checked on EVERY call, including
//                                              an identical replay, so a revoked
//                                              actor never receives a stored result
//   mutate(client, context) -> {result, before?, after?}
//
// Returns the receipt envelope `{protocolVersion:2, operationId, replayed, result}`.
// Throws a `V2Error` (`code`/`status`/`details`/`body`) for every refusal.
export async function runV2Command(options) {
  const {pool, uid, workspaceId, shiftId, protocolVersion, operation, type, body, authorize, mutate} = options ?? {};
  if (protocolVersion !== 2) throw v2Error('protocol-upgrade-required', 426, {protocolVersion});
  requireText(uid, 'uid');
  requireText(workspaceId, 'workspaceId');
  requireText(shiftId, 'shiftId');
  requireText(type, 'type');
  if (typeof operation !== 'string' || !OPERATION_ID.test(operation)) throw v2Error('invalid-command', 400, {field: 'operationId'});
  if (typeof authorize !== 'function') throw v2Error('invalid-command', 400, {field: 'authorize'});
  if (typeof mutate !== 'function') throw v2Error('invalid-command', 400, {field: 'mutate'});
  if (!pool || typeof pool.connect !== 'function') throw v2Error('invalid-command', 400, {field: 'pool'});
  let hash;
  try {
    hash = commandHash({uid, workspaceId, shiftId, protocolVersion, operation, type, body});
  } catch {
    // The canonical-JSON reason may name a path; only the field is client-visible.
    throw v2Error('invalid-command', 400, {field: 'body'});
  }
  const context = Object.freeze({uid, workspaceId, shiftId, protocolVersion, operation, type, body, commandHash: hash});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Authorization first: an operation id alone must never disclose a result.
    const actor = await authorize(client, context);
    const created = await client.query(
      `INSERT INTO ${V2_RECEIPT_TABLE}(workspace_id,operation_id,uid,request_hash,result) VALUES ($1,$2,$3,$4,'{}') ON CONFLICT DO NOTHING RETURNING operation_id`,
      [workspaceId, operation, uid, hash]
    );
    if (!created.rowCount) {
      const stored = (await client.query(
        `SELECT uid,request_hash,result FROM ${V2_RECEIPT_TABLE} WHERE workspace_id=$1 AND operation_id=$2`,
        [workspaceId, operation]
      )).rows[0];
      // uid/shift/protocol are part of the hash, so one exact comparison covers them.
      if (!stored || stored.uid !== uid || stored.request_hash !== hash) throw v2Error('operation-id-reused', 409, {operationId: operation});
      await client.query('COMMIT');
      return {protocolVersion: 2, operationId: operation, replayed: true, result: stored.result};
    }
    const mutation = await mutate(client, {...context, actor});
    if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation) || !Object.hasOwn(mutation, 'result')) {
      throw v2Error('invalid-command', 400, {field: 'result'});
    }
    let resultJson;
    try {
      resultJson = canonicalJson(mutation.result);
    } catch {
      throw v2Error('invalid-command', 400, {field: 'result'});
    }
    const before = requireAuditPayload(mutation.before, 'before');
    const after = requireAuditPayload(mutation.after, 'after');
    let beforeJson = null;
    let afterJson = null;
    try {
      if (before) beforeJson = canonicalJson({shiftId, ...before});
      if (after) afterJson = canonicalJson({shiftId, ...after});
    } catch {
      throw v2Error('invalid-command', 400, {field: 'audit'});
    }
    await client.query(
      `INSERT INTO ${V2_AUDIT_TABLE}(workspace_id,operation_id,uid,type,before_data,after_data) VALUES ($1,$2,$3,$4,$5,$6)`,
      [workspaceId, operation, uid, type, beforeJson, afterJson]
    );
    await client.query(`UPDATE ${V2_RECEIPT_TABLE} SET result=$3 WHERE workspace_id=$1 AND operation_id=$2`, [workspaceId, operation, resultJson]);
    await client.query('COMMIT');
    return {protocolVersion: 2, operationId: operation, replayed: false, result: JSON.parse(resultJson)};
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
