import { createHash } from 'node:crypto';

import { fail } from './tabel-access.mjs';

// Head/pending/delete materializer state machine (design §4.10).
//
// replica_stream is the immutable transport log, replica_document_heads is the
// persistent generation ledger and replica_pending_documents holds only the
// current unmaterialized status/log set. This module owns the three transitions
// that make those three facts agree at COMMIT:
//
//   * applyReplicaHeadTransition — one materializable operation, head CAS first;
//   * promoteReplicaPending     — materialize staged status/log rows whose
//                                 canonical parents have arrived;
//   * verifyReplicaHeads        — collection-specific postcondition check.
//
// Payload is never copied into pending: promotion re-reads the immutable stream
// row, revalidates the exact envelope and the v2 hash, and only then writes the
// canonical row. Every call runs inside the caller's transaction, so a failure
// at any boundary rolls stream, head, canonical, pending and cursor back
// together.

const MATERIALIZABLE = new Set(['objects', 'users', 'shift', 'trucks', 'truckStatus', 'logs']);
const PENDING_COLLECTIONS = new Set(['truckStatus', 'logs']);
const COLLECTION_VALUES = new Set(['objects', 'users', 'shift', 'trucks', 'truckStatus', 'logs']);
const DELETABLE_PHYSICAL = new Set(['shift', 'trucks', 'truckStatus', 'logs']);

const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const lastSegment = path => String(path || '').split('/').filter(Boolean).pop() || '';
const number = value => (value === null || value === undefined ? null : Number(value));
const nonEmpty = value => typeof value === 'string' && value.trim() !== '';

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('replica-json-nonfinite');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isMap(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw fail('replica-json-unsupported');
}

export function hashReplicaOperationV2(kind, payload) {
  return createHash('sha256')
    .update(canonicalJson({ protocolVersion: 2, kind, payload }))
    .digest('hex');
}

function legacyHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
}

function routingFor(collection, documentId, data = {}) {
  switch (collection) {
    case 'objects': return { objectId: documentId };
    case 'users': return { userUid: documentId };
    case 'shift': {
      if (!nonEmpty(data.objectId)) throw fail('invalid-shift-v2-provenance');
      if (!nonEmpty(data.startedByUid)) throw fail('invalid-shift-v2-provenance');
      return { shiftId: documentId, objectId: data.objectId, userUid: data.startedByUid };
    }
    case 'trucks': return { truckId: documentId };
    case 'truckStatus': {
      if (!nonEmpty(data.shiftId)) throw fail('replica-status-without-shift');
      return { truckId: documentId, shiftId: data.shiftId };
    }
    case 'logs': {
      if (!nonEmpty(data.shiftId) || !nonEmpty(data.truckId)) throw fail('replica-log-without-shift');
      return { truckId: data.truckId, shiftId: data.shiftId };
    }
    default: return {};
  }
}

/**
 * Canonicalizes one replica operation before hash/duplicate comparison and
 * before any write. v2 is exact: one document per operation, `doc.set` carries
 * `{collection,path,data}`, `doc.delete` carries only `{collection,path}` and
 * accepts `data:null` solely as a transport alias.
 */
export function normalizeReplicaOperation(operation) {
  if (!isMap(operation)) throw fail('invalid-replica-operation');
  const version = operation.protocolVersion === undefined ? 1 : operation.protocolVersion;
  if (version !== 1 && version !== 2) throw fail('invalid-replica-protocol');
  const kind = operation.kind;
  if (typeof kind !== 'string' || !kind || kind.length > 120) throw fail('invalid-replica-kind');
  const raw = operation.payload === undefined ? null : operation.payload;

  if (version === 1) {
    const payload = isMap(raw) ? raw : {};
    const collection = nonEmpty(payload.collection) ? payload.collection : '';
    const documentId = lastSegment(payload.path);
    const materializable = (kind === 'doc.set' || kind === 'doc.delete')
      && MATERIALIZABLE.has(collection) && nonEmpty(documentId);
    return {
      protocolVersion: 1,
      hashVersion: 1,
      kind,
      payload: raw,
      hash: legacyHash(raw),
      materializable,
      collection: materializable ? collection : null,
      documentId: materializable ? documentId : null,
      data: materializable && kind === 'doc.set' && isMap(payload.data) ? payload.data : null,
      // v1 не проходит через head ledger: до cutover его форму проверяют
      // старый материализатор и триггеры 025, поэтому routing здесь пустой.
      routing: {},
    };
  }

  if (kind !== 'doc.set' && kind !== 'doc.delete') {
    // Journal-only v2 events are hashed exactly but never materialized.
    if (raw !== null && !isMap(raw)) throw fail('invalid-replica-payload');
    return {
      protocolVersion: 2,
      hashVersion: 2,
      kind,
      payload: raw,
      hash: hashReplicaOperationV2(kind, raw),
      materializable: false,
      collection: null,
      documentId: null,
      data: null,
      routing: {},
    };
  }

  if (!isMap(raw)) throw fail('invalid-replica-payload');
  const collection = raw.collection;
  if (!nonEmpty(collection)) throw fail('invalid-replica-collection');
  const documentId = lastSegment(raw.path);
  if (!nonEmpty(documentId)) throw fail('invalid-replica-document-id');

  if (!MATERIALIZABLE.has(collection)) {
    // Design §4.10: the six-collection allow-list is closed. A v2 doc.set/
    // doc.delete outside it is an unknown collection, not a journal-only event.
    throw fail('invalid-replica-collection');
  }

  if (kind === 'doc.delete') {
    if (raw.data !== undefined && raw.data !== null) throw fail('invalid-replica-delete-payload');
    const payload = { collection, path: String(raw.path) };
    return {
      protocolVersion: 2,
      hashVersion: 2,
      kind,
      payload,
      hash: hashReplicaOperationV2(kind, payload),
      materializable: true,
      collection,
      documentId,
      data: null,
      routing: {},
    };
  }

  if (!isMap(raw.data)) throw fail('invalid-replica-set-payload');
  const data = raw.data;
  if (data.id !== undefined && String(data.id) !== documentId) {
    throw fail('replica-document-id-mismatch');
  }
  const payload = { collection, path: String(raw.path), data };
  return {
    protocolVersion: 2,
    hashVersion: 2,
    kind,
    payload,
    hash: hashReplicaOperationV2(kind, payload),
    materializable: true,
    collection,
    documentId,
    data,
    routing: routingFor(collection, documentId, data),
  };
}

async function lockHead(client, ws, collection, documentId) {
  return (await client.query(
    `SELECT head_seq,head_kind,canonical_present,applied_seq,shift_id,truck_id,object_id,user_uid
       FROM replica_document_heads
      WHERE workspace_id=$1 AND collection=$2 AND document_id=$3
      FOR UPDATE`,
    [ws, collection, documentId],
  )).rows[0];
}

async function readStream(client, ws, seq) {
  return (await client.query(
    `SELECT seq,kind,payload,sha256,protocol_version,hash_version
       FROM replica_stream
      WHERE workspace_id=$1 AND direction='f2s' AND seq=$2`,
    [ws, seq],
  )).rows[0];
}

async function upsertHead(client, ws, {
  collection, documentId, seq, kind, routing, appliedSeq, canonicalPresent,
}) {
  await client.query(
    `INSERT INTO replica_document_heads(
       workspace_id,collection,document_id,head_seq,stream_direction,head_kind,
       shift_id,truck_id,object_id,user_uid,applied_seq,canonical_present)
     VALUES($1,$2,$3,$4,'f2s',$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (workspace_id,collection,document_id) DO UPDATE SET
       head_seq=EXCLUDED.head_seq,
       head_kind=EXCLUDED.head_kind,
       shift_id=EXCLUDED.shift_id,
       truck_id=EXCLUDED.truck_id,
       object_id=EXCLUDED.object_id,
       user_uid=EXCLUDED.user_uid,
       applied_seq=EXCLUDED.applied_seq,
       canonical_present=EXCLUDED.canonical_present,
       updated_at=now()`,
    [
      ws, collection, documentId, seq, kind,
      routing.shiftId ?? null, routing.truckId ?? null, routing.objectId ?? null,
      routing.userUid ?? null, appliedSeq, canonicalPresent,
    ],
  );
}

async function deletePending(client, ws, collection, documentId) {
  await client.query(
    `DELETE FROM replica_pending_documents
      WHERE workspace_id=$1 AND collection=$2 AND document_id=$3`,
    [ws, collection, documentId],
  );
}

async function parentState(client, ws, collection, routing) {
  if (collection === 'shift') {
    const row = (await client.query(
      `SELECT EXISTS(SELECT 1 FROM workspace_objects WHERE workspace_id=$1 AND object_id=$2) AS object_exists,
              EXISTS(SELECT 1 FROM app_users WHERE uid=$3) AS user_exists`,
      [ws, routing.objectId, routing.userUid],
    )).rows[0];
    return {
      object: row.object_exists,
      user: row.user_exists,
      shift: true,
      truck: true,
      allPresent: row.object_exists && row.user_exists,
    };
  }
  if (PENDING_COLLECTIONS.has(collection)) {
    const row = (await client.query(
      `SELECT EXISTS(SELECT 1 FROM shifts WHERE workspace_id=$1 AND shift_id=$2) AS shift_exists,
              EXISTS(SELECT 1 FROM line_trucks WHERE workspace_id=$1 AND truck_id=$3) AS truck_exists`,
      [ws, routing.shiftId, routing.truckId],
    )).rows[0];
    return {
      object: true,
      user: true,
      shift: row.shift_exists,
      truck: row.truck_exists,
      allPresent: row.shift_exists && row.truck_exists,
    };
  }
  return { object: true, user: true, shift: true, truck: true, allPresent: true };
}

async function materializeCanonical(client, ws, normalized) {
  const { collection, documentId, data } = normalized;
  switch (collection) {
    case 'objects':
      await client.query(
        `INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3::jsonb)
         ON CONFLICT (workspace_id,object_id)
         DO UPDATE SET payload=EXCLUDED.payload, revision=workspace_objects.revision+1`,
        [ws, documentId, JSON.stringify(data)],
      );
      return;
    case 'users': {
      const email = String(data.email || '');
      if (!email) throw fail('replica-user-without-email');
      const role = String(data.role || 'driver');
      const status = ['active', 'pending', 'disabled'].includes(data.status) ? data.status : 'pending';
      await client.query(
        `INSERT INTO app_users(uid,email,display_name,role,status,profile) VALUES($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (uid) DO UPDATE SET email=EXCLUDED.email, display_name=EXCLUDED.display_name,
           role=EXCLUDED.role, status=EXCLUDED.status, profile=EXCLUDED.profile,
           revision=app_users.revision+1`,
        [documentId, email, String(data.nickname || data.displayName || email), role, status, JSON.stringify(data)],
      );
      return;
    }
    case 'shift':
      await client.query(
        `INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,$3,$4::jsonb)
         ON CONFLICT (workspace_id,shift_id)
         DO UPDATE SET is_active=EXCLUDED.is_active, payload=EXCLUDED.payload`,
        [ws, documentId, data.isActive === true, JSON.stringify(data)],
      );
      return;
    case 'trucks':
      await client.query(
        `INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3::jsonb)
         ON CONFLICT (workspace_id,truck_id)
         DO UPDATE SET payload=EXCLUDED.payload, revision=line_trucks.revision+1`,
        [ws, documentId, JSON.stringify(data)],
      );
      return;
    case 'truckStatus':
      await client.query(
        `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES($1,$2,$3,$4::jsonb)
         ON CONFLICT (workspace_id,truck_id)
         DO UPDATE SET shift_id=EXCLUDED.shift_id, payload=EXCLUDED.payload`,
        [ws, documentId, String(data.shiftId), JSON.stringify(data)],
      );
      return;
    case 'logs':
      await client.query(
        `INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (workspace_id,log_id)
         DO UPDATE SET shift_id=EXCLUDED.shift_id, truck_id=EXCLUDED.truck_id, payload=EXCLUDED.payload`,
        [ws, documentId, String(data.shiftId), String(data.truckId), JSON.stringify(data)],
      );
      return;
    default:
      throw fail('invalid-replica-collection');
  }
}

async function deleteCanonical(client, ws, collection, documentId) {
  switch (collection) {
    case 'objects':
      // Task 14 replaces this physical delete with the documented soft tombstone.
      await client.query(
        'DELETE FROM workspace_objects WHERE workspace_id=$1 AND object_id=$2', [ws, documentId],
      );
      return;
    case 'users':
      // Task 14 replaces this physical delete with soft-disable/tombstone.
      await client.query('DELETE FROM app_users WHERE uid=$1', [documentId]);
      return;
    case 'shift':
      await client.query('DELETE FROM shifts WHERE workspace_id=$1 AND shift_id=$2', [ws, documentId]);
      return;
    case 'trucks':
      await client.query('DELETE FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [ws, documentId]);
      return;
    case 'truckStatus':
      await client.query(
        'DELETE FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2', [ws, documentId],
      );
      return;
    case 'logs':
      await client.query('DELETE FROM line_logs WHERE workspace_id=$1 AND log_id=$2', [ws, documentId]);
      return;
    default:
      throw fail('invalid-replica-collection');
  }
}

function routingColumns(collection, documentId, routing, existing) {
  switch (collection) {
    case 'objects': return { objectId: documentId };
    case 'users': return { userUid: documentId };
    case 'shift': return { shiftId: documentId, objectId: routing.objectId ?? existing?.object_id ?? null };
    case 'trucks': return { truckId: documentId };
    case 'truckStatus':
      return { truckId: documentId, shiftId: routing.shiftId ?? existing?.shift_id ?? null };
    case 'logs':
      return {
        truckId: routing.truckId ?? existing?.truck_id ?? null,
        shiftId: routing.shiftId ?? existing?.shift_id ?? null,
      };
    default: return {};
  }
}

/**
 * Applies one materializable operation inside the caller's transaction.
 * Returns `{applied, status}`; stale/replay are successful no-ops.
 */
export async function applyReplicaHeadTransition(client, ws, operation, options = {}) {
  const normalized = options.normalized ?? normalizeReplicaOperation(operation);
  if (!normalized.materializable) return { applied: false, status: 'journal-only' };
  if (normalized.protocolVersion !== 2) throw fail('protocol-upgrade-required', 426);
  const seq = Number(options.seq);
  if (!Number.isSafeInteger(seq) || seq <= 0) throw fail('invalid-replica-head-seq');

  const { collection, documentId } = normalized;
  const existing = await lockHead(client, ws, collection, documentId);
  if (existing) {
    const headSeq = number(existing.head_seq);
    if (headSeq > seq) return { applied: false, status: 'stale', collection, documentId };
    if (headSeq === seq) {
      const stream = await readStream(client, ws, seq);
      if (stream && stream.sha256 === normalized.hash && stream.kind === normalized.kind) {
        return { applied: true, status: 'replay', collection, documentId };
      }
      throw fail('replica-head-generation-conflict', 409);
    }
  }

  const routing = routingColumns(collection, documentId, normalized.routing, existing);

  if (normalized.kind === 'doc.delete') {
    await deleteCanonical(client, ws, collection, documentId);
    await deletePending(client, ws, collection, documentId);
    await upsertHead(client, ws, {
      collection, documentId, seq, kind: 'doc.delete', routing,
      appliedSeq: seq, canonicalPresent: false,
    });
    return { applied: true, status: 'deleted', collection, documentId };
  }

  const parents = await parentState(client, ws, collection, normalized.routing);
  if (collection === 'shift' && !parents.object) throw fail('replica-shift-object-missing');
  if (collection === 'shift' && !parents.user) throw fail('replica-shift-user-missing');

  if (PENDING_COLLECTIONS.has(collection) && !parents.allPresent) {
    // Transport state only: the canonical row for this key is removed before the
    // pending generation commits, so the old status cannot stay visible.
    await deleteCanonical(client, ws, collection, documentId);
    await deletePending(client, ws, collection, documentId);
    await upsertHead(client, ws, {
      collection, documentId, seq, kind: 'doc.set', routing,
      appliedSeq: null, canonicalPresent: false,
    });
    await client.query(
      `INSERT INTO replica_pending_documents(
         workspace_id,collection,document_id,stream_seq,stream_direction,
         shift_id,truck_id,log_id,missing_shift,missing_truck)
       VALUES($1,$2,$3,$4,'f2s',$5,$6,$7,$8,$9)`,
      [
        ws, collection, documentId, seq, routing.shiftId, routing.truckId,
        collection === 'logs' ? documentId : null,
        !parents.shift, !parents.truck,
      ],
    );
    return { applied: true, status: 'pending', collection, documentId };
  }

  await deletePending(client, ws, collection, documentId);
  await upsertHead(client, ws, {
    collection, documentId, seq, kind: 'doc.set', routing,
    appliedSeq: seq, canonicalPresent: true,
  });
  await materializeCanonical(client, ws, normalized);

  if (options.promote !== false && (collection === 'shift' || collection === 'trucks')) {
    // Only the two parent collections can unblock a staged status/log row.
    await promoteReplicaPending(client, ws, collection === 'shift'
      ? { shiftId: documentId }
      : { truckId: documentId });
  }
  return { applied: true, status: 'materialized', collection, documentId };
}

async function revalidatePendingStream(client, ws, row) {
  const stream = await readStream(client, ws, Number(row.stream_seq));
  if (!stream) throw fail('replica-pending-stream-missing');
  if (stream.kind !== 'doc.set' || Number(stream.protocol_version) !== 2) {
    throw fail('replica-pending-stream-invalid');
  }
  const normalized = normalizeReplicaOperation({
    protocolVersion: 2,
    kind: stream.kind,
    payload: stream.payload,
  });
  if (!normalized.materializable || normalized.collection !== row.collection
      || normalized.documentId !== row.document_id) {
    throw fail('replica-pending-identity-mismatch');
  }
  if (normalized.hash !== stream.sha256) throw fail('replica-pending-hash-mismatch');
  if ((normalized.routing.shiftId ?? null) !== (row.shift_id ?? null)
      || (normalized.routing.truckId ?? null) !== (row.truck_id ?? null)) {
    throw fail('replica-pending-routing-mismatch');
  }
  return normalized;
}

/**
 * Materializes staged status/log rows whose canonical parents are now present.
 * The immutable stream payload is re-read and revalidated before promotion.
 */
export async function promoteReplicaPending(client, ws, filter = {}) {
  const clauses = ['workspace_id=$1'];
  const values = [ws];
  if (nonEmpty(filter.shiftId)) {
    values.push(filter.shiftId);
    clauses.push(`shift_id=$${values.length}`);
  } else if (nonEmpty(filter.truckId)) {
    values.push(filter.truckId);
    clauses.push(`truck_id=$${values.length}`);
  }
  const rows = (await client.query(
    `SELECT workspace_id,collection,document_id,stream_seq,shift_id,truck_id
       FROM replica_pending_documents
      WHERE ${clauses.join(' AND ')}
      ORDER BY collection, document_id
      FOR UPDATE`,
    values,
  )).rows;

  let promoted = 0;
  for (const row of rows) {
    const head = await lockHead(client, ws, row.collection, row.document_id);
    if (!head) throw fail('replica-pending-head-missing');
    if (number(head.head_seq) !== number(row.stream_seq)
        || head.head_kind !== 'doc.set' || head.canonical_present
        || head.applied_seq !== null) {
      throw fail('replica-pending-head-mismatch');
    }
    const normalized = await revalidatePendingStream(client, ws, row);
    const parents = await parentState(client, ws, row.collection, normalized.routing);
    if (!parents.allPresent) {
      await client.query(
        `UPDATE replica_pending_documents
            SET missing_shift=$4, missing_truck=$5
          WHERE workspace_id=$1 AND collection=$2 AND document_id=$3`,
        [ws, row.collection, row.document_id, !parents.shift, !parents.truck],
      );
      continue;
    }
    await deletePending(client, ws, row.collection, row.document_id);
    await materializeCanonical(client, ws, normalized);
    await upsertHead(client, ws, {
      collection: row.collection,
      documentId: row.document_id,
      seq: number(row.stream_seq),
      kind: 'doc.set',
      routing: routingColumns(row.collection, row.document_id, normalized.routing, head),
      appliedSeq: number(row.stream_seq),
      canonicalPresent: true,
    });
    promoted += 1;
  }
  return promoted;
}

async function canonicalExists(client, ws, head) {
  const { collection, document_id: documentId } = head;
  switch (collection) {
    case 'objects':
      return (await client.query(
        `SELECT 1 FROM workspace_objects
          WHERE workspace_id=$1 AND object_id=$2 AND payload->>'deleted' IS DISTINCT FROM 'true'`,
        [ws, documentId],
      )).rowCount > 0;
    case 'users':
      return (await client.query(
        `SELECT 1 FROM app_users
          WHERE uid=$1 AND status <> 'disabled' AND profile->>'deleted' IS DISTINCT FROM 'true'`,
        [documentId],
      )).rowCount > 0;
    case 'shift':
      return (await client.query(
        'SELECT 1 FROM shifts WHERE workspace_id=$1 AND shift_id=$2', [ws, documentId],
      )).rowCount > 0;
    case 'trucks':
      return (await client.query(
        'SELECT 1 FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [ws, documentId],
      )).rowCount > 0;
    case 'truckStatus':
      return (await client.query(
        'SELECT 1 FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2', [ws, documentId],
      )).rowCount > 0;
    case 'logs':
      return (await client.query(
        'SELECT 1 FROM line_logs WHERE workspace_id=$1 AND log_id=$2', [ws, documentId],
      )).rowCount > 0;
    default:
      return false;
  }
}

/**
 * Proves the head ledger against the immutable stream and the canonical rows.
 * objects/users tombstones are deferred to Task 14: the report marks them
 * explicitly instead of applying the forbidden generic physical-presence rule.
 */
export async function verifyReplicaHeads(client, ws, options = {}) {
  const heads = (await client.query(
    `SELECT h.collection,h.document_id,h.head_seq,h.head_kind,h.canonical_present,h.applied_seq,
            h.shift_id,h.truck_id,h.object_id,h.user_uid,
            s.kind AS stream_kind,s.protocol_version,s.sha256,s.payload
       FROM replica_document_heads h
       LEFT JOIN replica_stream s
         ON s.workspace_id=h.workspace_id AND s.direction=h.stream_direction AND s.seq=h.head_seq
      WHERE h.workspace_id=$1
      ORDER BY h.collection,h.document_id`,
    [ws],
  )).rows;
  const pendingRows = (await client.query(
    `SELECT collection,document_id,stream_seq,shift_id,truck_id FROM replica_pending_documents
      WHERE workspace_id=$1 ORDER BY collection,document_id`,
    [ws],
  )).rows;
  const pendingByKey = new Map(pendingRows.map(row => [`${row.collection}\u0000${row.document_id}`, row]));
  const violations = [];
  const deferred = [];
  let pendingCount = 0;

  const push = (code, head, detail = {}) => violations.push({
    code, collection: head.collection, documentId: head.document_id, ...detail,
  });

  for (const head of heads) {
    if (!head.stream_kind) {
      push('stream-missing', head);
      continue;
    }
    if (head.stream_kind !== head.head_kind) push('stream-kind-mismatch', head);
    if (Number(head.protocol_version) !== 2) push('stream-version-mismatch', head);
    const key = `${head.collection}\u0000${head.document_id}`;
    const pending = pendingByKey.get(key);

    if (head.head_kind === 'doc.set' && head.canonical_present === false && head.applied_seq === null) {
      pendingCount += 1;
      if (!pending) {
        push('pending-row-missing', head);
        continue;
      }
      if (number(pending.stream_seq) !== number(head.head_seq)) {
        push('pending-seq-mismatch', head);
        continue;
      }
      try {
        const normalized = await revalidatePendingStream(client, ws, pending);
        const parents = await parentState(client, ws, head.collection, normalized.routing);
        if (parents.allPresent) push('pending-parents-satisfied', head);
      } catch (error) {
        push('pending-payload-invalid', head, { reason: error.code || error.message });
      }
      continue;
    }

    if (pending) push('pending-on-settled-head', head);
    if (head.head_kind === 'doc.set' && head.canonical_present === true) {
      if (number(head.applied_seq) !== number(head.head_seq)) push('applied-seq-mismatch', head);
      if (!(await canonicalExists(client, ws, head))) push('canonical-missing', head);
      continue;
    }
    if (head.head_kind === 'doc.delete') {
      if (!COLLECTION_VALUES.has(head.collection)) {
        push('unknown-collection', head);
        continue;
      }
      if (!DELETABLE_PHYSICAL.has(head.collection)) {
        // objects/users keep a physical soft tombstone; Task 14 owns its verifier.
        deferred.push({ collection: head.collection, documentId: head.document_id });
        continue;
      }
      if (await canonicalExists(client, ws, head)) push('canonical-present-after-delete', head);
    }
  }

  for (const row of pendingRows) {
    if (!heads.some(head => head.collection === row.collection && head.document_id === row.document_id)) {
      violations.push({
        code: 'pending-without-head', collection: row.collection, documentId: row.document_id,
      });
    }
  }

  const report = {
    workspaceId: ws,
    ok: violations.length === 0,
    checked: heads.length,
    pending: pendingCount,
    deferred,
    violations,
  };
  if (!report.ok && options.throw) throw fail('replica-head-verify-failed', 409);
  return report;
}
