import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { appendReplicaBatch, readReplicaJournal } from '../src/replica-store.mjs';
import {
  applyReplicaHeadTransition,
  hashReplicaOperationV2,
  normalizeReplicaOperation,
  verifyReplicaHeads,
} from '../src/replica-heads.mjs';
import { applyMigrationsThrough } from './helpers/isolated-db.mjs';

// Интеграционные проверки журнала репликации на реальном PostgreSQL.
// Требуют TEST_DATABASE_URL (контейнер CI передаёт её сам); без неё — скип.
//
// Файл работает на схеме через migration 026: replica_stream append-only на
// уровне БД, поэтому каждый тест получает собственный workspace вместо
// DELETE FROM replica_stream (этот путь запрещён и не должен «протекать» в тест).
const connectionString = process.env.TEST_DATABASE_URL;
const pool = connectionString
  ? new Pool({ connectionString, max: 4 })
  : null;
const UID = 'test-admin-replica';
let counter = 0;

// Раннер поднимает шаблон только до 025: 026 применяет сам файл (как
// replica-stream-026). Без этого колонок protocol_version/hash_version и
// таблиц head/pending просто нет.
test.before(async () => {
  if (!connectionString) return;
  await applyMigrationsThrough(26);
});

async function reset() {
  const ws = `ws_replica_store_${++counter}`;
  // Сервисному администратору резерва нужны запись в app_users и роль admin.
  await pool.query(`INSERT INTO app_users(uid,email,display_name,role,status) VALUES ('${UID}','replica@example.invalid','Replica Admin','admin','active')
    ON CONFLICT (uid) DO UPDATE SET role='admin',status='active'`);
  await pool.query('INSERT INTO workspaces(id) VALUES($1) ON CONFLICT(id) DO NOTHING', [ws]);
  await pool.query('INSERT INTO replica_cursor(workspace_id,f2s_seq,s2f_seq) VALUES($1,0,0)', [ws]);
  await pool.query(
    "INSERT INTO server_authority(workspace_id,provider,generation) VALUES($1,'firebase',1)",
    [ws],
  );
  return ws;
}
const op = (id, n) => ({ id, kind: 'trip.load', payload: { n, at: 1700000000000 + n } });

const pathFor = (ws, collection, documentId) => `workspaces/${ws}/${collection}/${documentId}`;
const v2set = (ws, id, collection, documentId, data) => ({
  id,
  protocolVersion: 2,
  kind: 'doc.set',
  payload: {
    collection,
    path: pathFor(ws, collection, documentId),
    data: { ...data, id: documentId },
  },
});
const v2delete = (ws, id, collection, documentId, data) => ({
  id,
  protocolVersion: 2,
  kind: 'doc.delete',
  payload: data === undefined
    ? { collection, path: pathFor(ws, collection, documentId) }
    : { collection, path: pathFor(ws, collection, documentId), data },
});

// Design §4.7: the published start document carries exactly these 14 keys.
function shiftV2(ws, shiftId, objectId, { creatorUid, startedAt = 1795420800000 } = {}) {
  return {
    id: `replica-shift-${shiftId}`,
    protocolVersion: 2,
    kind: 'doc.set',
    payload: {
      collection: 'shift',
      path: pathFor(ws, 'shift', shiftId),
      data: {
        payloadSchemaVersion: 2,
        id: shiftId,
        shiftId,
        objectId,
        objectName: 'Topology object',
        startDate: '23.11.2026',
        date: '2026-11-23',
        workShift: 'day',
        type: 'day',
        state: 'active',
        isActive: true,
        startedAt,
        startedBy: 'Создатель Смены',
        startedByUid: creatorUid,
      },
    },
  };
}

async function seedUser(uid, displayName, role = 'foreman') {
  await pool.query(
    `INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$2,$3,$4,'active')
     ON CONFLICT (uid) DO UPDATE SET display_name=EXCLUDED.display_name,role=EXCLUDED.role,status='active'`,
    [uid, `${uid}@example.invalid`, displayName, role],
  );
}

async function head(ws, collection, documentId) {
  return (await pool.query(
    `SELECT head_seq,head_kind,canonical_present,applied_seq
       FROM replica_document_heads
      WHERE workspace_id=$1 AND collection=$2 AND document_id=$3`,
    [ws, collection, documentId],
  )).rows[0];
}

test('пачка применяется и получает строгую последовательность', {skip: !connectionString}, async () => {
  const ws = await reset();
  const result = await appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [op('replica-op-0001', 1), op('replica-op-0002', 2)] }, ws);
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.applied, 2);
  assert.equal(result.seq, 2);
  const rows = await pool.query('SELECT seq, operation_id FROM replica_stream WHERE workspace_id=$1 ORDER BY seq', [ws]);
  assert.deepEqual(rows.rows.map(r => Number(r.seq)), [1, 2]);
});

test('повторная отправка не создаёт дубликатов и не двигает последовательность', {skip: !connectionString}, async () => {
  const ws = await reset();
  const batch = { baseSeq: 0, operations: [op('replica-op-0001', 1), op('replica-op-0002', 2)] };
  await appendReplicaBatch(pool, UID, batch, ws);
  const again = await appendReplicaBatch(pool, UID, batch, ws);
  assert.equal(again.applied, 0);
  assert.equal(again.seq, 2);
  const count = await pool.query('SELECT count(*)::int AS n FROM replica_stream WHERE workspace_id=$1', [ws]);
  assert.equal(count.rows[0].n, 2);
});

test('пропуск последовательности блокирует применение', {skip: !connectionString}, async () => {
  const ws = await reset();
  await appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [op('replica-op-0001', 1)] }, ws);
  await assert.rejects(
    () => appendReplicaBatch(pool, UID, { baseSeq: 5, operations: [op('replica-op-0009', 9)] }, ws),
    error => error.code === 'replica-sequence-gap'
  );
});

test('тот же operation_id с другим содержимым отклоняется', {skip: !connectionString}, async () => {
  const ws = await reset();
  await appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [op('replica-op-0001', 1)] }, ws);
  await assert.rejects(
    () => appendReplicaBatch(pool, UID, { baseSeq: 1, operations: [op('replica-op-0001', 77)] }, ws),
    error => error.code === 'replica-operation-conflict'
  );
});

test('резерв не принимает зеркало, когда сам объявлен владельцем', {skip: !connectionString}, async () => {
  const ws = await reset();
  await pool.query("UPDATE server_authority SET provider='ubuntu', generation=2 WHERE workspace_id=$1", [ws]);
  await assert.rejects(
    () => appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [op('replica-op-0001', 1)] }, ws),
    error => error.code === 'replica-reserve-is-owner'
  );
  await pool.query("UPDATE server_authority SET provider='firebase', generation=3 WHERE workspace_id=$1", [ws]);
});

test('журнал обратной репликации отдаёт непрерывную последовательность', {skip: !connectionString}, async () => {
  const ws = await reset();
  const journal = await readReplicaJournal(pool, UID, { since: 0, limit: 50 }, ws);
  assert.equal(journal.contiguous, true);
  assert.deepEqual(journal.items, []);
  assert.equal(journal.head, 0);
});

test('взаимное исключение: при владельце Firebase прикладная запись в Ubuntu отклоняется', {skip: !connectionString}, async () => {
  const ws = await reset();
  await pool.query("UPDATE server_authority SET provider='firebase', generation=1 WHERE workspace_id='main_workspace'");
  const { assertWriteAuthority } = await import('../src/authority.mjs');
  await assert.rejects(
    () => assertWriteAuthority(pool, { headers: {} }),
    error => error.code === 'not-authoritative'
  );
  // Зеркало при этом принимается — резерв обязан получать изменения.
  const mirrored = await appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [op('replica-op-0001', 1)] }, ws);
  assert.equal(mirrored.applied, 1);
});

test('взаимное исключение: при владельце Ubuntu зеркало не принимается', {skip: !connectionString}, async () => {
  const ws = await reset();
  await pool.query("UPDATE server_authority SET provider='ubuntu', generation=2 WHERE workspace_id='main_workspace'");
  const { assertWriteAuthority } = await import('../src/authority.mjs');
  await assert.doesNotReject(() => assertWriteAuthority(pool, { headers: {} }));
  await pool.query("UPDATE server_authority SET provider='ubuntu', generation=2 WHERE workspace_id=$1", [ws]);
  await assert.rejects(
    () => appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [op('replica-op-0002', 2)] }, ws),
    error => error.code === 'replica-reserve-is-owner'
  );
  await pool.query("UPDATE server_authority SET provider='firebase', generation=3 WHERE workspace_id=$1", [ws]);
});

// ---------------------------------------------------------------------------
// Task 13: generation CAS is decided by the persistent head, not by arrival.
// ---------------------------------------------------------------------------
test('lower generation is stale, equal hash is a replay and a newer set advances the head', {skip: !connectionString}, async () => {
  const ws = await reset();
  const truckId = 'truck_generation';
  const first = v2set(ws, 'replica-gen-0001', 'trucks', truckId, { name: 'first' });
  const second = v2set(ws, 'replica-gen-0002', 'trucks', truckId, { name: 'second' });
  await appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [first, second] }, ws);
  let h = await head(ws, 'trucks', truckId);
  assert.equal(Number(h.head_seq), 2);
  assert.equal(h.canonical_present, true);
  const revision = (await pool.query(
    'SELECT revision FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [ws, truckId],
  )).rows[0].revision;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stale = await applyReplicaHeadTransition(client, ws, first, {
      seq: 1,
      normalized: normalizeReplicaOperation(first),
    });
    assert.equal(stale.status, 'stale');
    const replay = await applyReplicaHeadTransition(client, ws, second, {
      seq: 2,
      normalized: normalizeReplicaOperation(second),
    });
    assert.equal(replay.status, 'replay');
    const forged = v2set(ws, 'replica-gen-0002', 'trucks', truckId, { name: 'forged' });
    await assert.rejects(
      () => applyReplicaHeadTransition(client, ws, forged, {
        seq: 2,
        normalized: normalizeReplicaOperation(forged),
      }),
      error => error.code === 'replica-head-generation-conflict',
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  h = await head(ws, 'trucks', truckId);
  assert.equal(Number(h.head_seq), 2);
  assert.equal(Number((await pool.query(
    'SELECT revision FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [ws, truckId],
  )).rows[0].revision), Number(revision));

  const third = v2set(ws, 'replica-gen-0003', 'trucks', truckId, { name: 'third' });
  await appendReplicaBatch(pool, UID, { baseSeq: 2, operations: [third] }, ws);
  h = await head(ws, 'trucks', truckId);
  assert.equal(Number(h.head_seq), 3);
  assert.equal(Number(h.applied_seq), 3);
  assert.equal((await pool.query(
    'SELECT payload FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [ws, truckId],
  )).rows[0].payload.name, 'third');
});

// ---------------------------------------------------------------------------
// Task 13: the head↔pending invariant is checked by deferred triggers at COMMIT.
// ---------------------------------------------------------------------------
test('a pending head without its pending row is refused at COMMIT', {skip: !connectionString}, async () => {
  const ws = await reset();
  const operation = v2set(ws, 'replica-deferred-0001', 'truckStatus', 'truck_deferred', {
    shiftId: 'shift_deferred', onLine: true,
  });
  const normalized = normalizeReplicaOperation(operation);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256,protocol_version,hash_version)
       VALUES($1,1,'f2s',$2,$3,$4,$5,2,2)`,
      [ws, operation.id, operation.kind, JSON.stringify(normalized.payload), normalized.hash],
    );
    await client.query(
      `INSERT INTO replica_document_heads(
         workspace_id,collection,document_id,head_seq,stream_direction,head_kind,
         shift_id,truck_id,applied_seq,canonical_present)
       VALUES($1,'truckStatus','truck_deferred',1,'f2s','doc.set','shift_deferred','truck_deferred',NULL,false)`,
      [ws],
    );
    await assert.rejects(
      () => client.query('COMMIT'),
      error => error.code === '23514' && /replica-pending-head-without-row/.test(error.message),
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  assert.equal((await pool.query(
    'SELECT count(*)::int AS n FROM replica_stream WHERE workspace_id=$1', [ws],
  )).rows[0].n, 0);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS n FROM replica_document_heads WHERE workspace_id=$1', [ws],
  )).rows[0].n, 0);
});

// ---------------------------------------------------------------------------
// Task 12: replica v2 provenance. These are the RED cases the plan lists
// verbatim: exact golden v2, exact Firebase v1 rejection after cutover,
// sender≠creator, delete null normalization, id/path mismatch, objects/users
// head creation, missing object/user rollback, same-batch parent order and v1
// byte stability. Generation CAS/pending are Task 13 and are proved in
// replica-pending-materialize.test.mjs.
// ---------------------------------------------------------------------------
// Independent golden vectors (RFC 8785/JCS, computed outside this codebase).
const GOLDEN_V2_HASH = '37bfd01e78a030c044589afd3cf19e73f3322cc39c2024a59b14c4300ec6017d';
const GOLDEN_V1_HASH = 'a1c1c0140412e345c6df2a46a1b9080ea6ee7cf03b8656b55d243d1b72d7f671';

const goldenOperation = () => ({
  id: 'replica-golden-0001',
  protocolVersion: 2,
  kind: 'doc.set',
  payload: {
    collection: 'trucks',
    // The fixed path is part of the vector; only its last segment is identity.
    path: 'workspaces/ws_replica_golden/trucks/truck_golden',
    data: { id: 'truck_golden', name: 'Golden', plateNumber: 'A123BC78', capacity: 20 },
  },
});

async function streamRows(ws) {
  return (await pool.query(
    'SELECT seq,sha256,protocol_version,hash_version,payload FROM replica_stream WHERE workspace_id=$1 ORDER BY seq',
    [ws],
  )).rows;
}

async function headCount(ws) {
  return (await pool.query(
    'SELECT count(*)::int AS n FROM replica_document_heads WHERE workspace_id=$1', [ws],
  )).rows[0].n;
}

async function cursorOf(ws) {
  return Number((await pool.query(
    'SELECT f2s_seq FROM replica_cursor WHERE workspace_id=$1', [ws],
  )).rows[0].f2s_seq);
}

test('the exact v2 envelope hashes to the published golden vector and ignores key order', {skip: !connectionString}, async () => {
  const ws = await reset();
  const operation = goldenOperation();
  const normalized = normalizeReplicaOperation(operation);
  assert.equal(normalized.hash, GOLDEN_V2_HASH);
  assert.equal(hashReplicaOperationV2(operation.kind, normalized.payload), GOLDEN_V2_HASH);
  // JCS sorts object keys, so a re-serialized document with another insertion
  // order must produce the same hash instead of a duplicate/conflict.
  const reordered = {
    id: operation.id,
    protocolVersion: 2,
    kind: 'doc.set',
    payload: {
      data: { capacity: 20, plateNumber: 'A123BC78', name: 'Golden', id: 'truck_golden' },
      path: operation.payload.path,
      collection: 'trucks',
    },
  };
  assert.equal(normalizeReplicaOperation(reordered).hash, GOLDEN_V2_HASH);

  const result = await appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [operation] }, ws);
  assert.equal(result.applied, 1);
  const rows = await streamRows(ws);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sha256, GOLDEN_V2_HASH);
  assert.equal(Number(rows[0].protocol_version), 2);
  assert.equal(Number(rows[0].hash_version), 2);
  assert.deepEqual(rows[0].payload, normalized.payload);
});

test('legacy v1 stream rows keep their byte-stable payload hash and are never re-hashed', {skip: !connectionString}, async () => {
  const ws = await reset();
  const payload = { n: 1, at: 1700000000001 };
  const operation = { id: 'replica-legacy-0001', kind: 'trip.load', payload };
  const normalized = normalizeReplicaOperation(operation);
  assert.equal(normalized.protocolVersion, 1);
  assert.equal(normalized.hashVersion, 1);
  assert.equal(normalized.hash, GOLDEN_V1_HASH);
  // The legacy hash is sha256 of the payload bytes only, never the v2 envelope.
  assert.notEqual(hashReplicaOperationV2(operation.kind, payload), GOLDEN_V1_HASH);

  assert.equal((await appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [operation] }, ws)).applied, 1);
  // A replay is confirmed without consuming a sequence or rewriting the row.
  assert.equal((await appendReplicaBatch(pool, UID, { baseSeq: 1, operations: [operation] }, ws)).applied, 0);

  const rows = await streamRows(ws);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sha256, GOLDEN_V1_HASH);
  assert.equal(Number(rows[0].protocol_version), 1);
  assert.equal(Number(rows[0].hash_version), 1);
  assert.deepEqual(rows[0].payload, payload);
  assert.equal(await cursorOf(ws), 1);
});

test('the exact Firebase v1 shift document is refused after cutover and writes nothing', {skip: !connectionString}, async () => {
  const ws = await reset();
  // Design §4.7: the real legacy document has no UID and no type; it is not
  // "upgraded" or guessed, it is refused as an unsupported protocol version.
  const legacyShift = {
    id: 'replica-legacy-shift-0001',
    kind: 'doc.set',
    payload: {
      collection: 'shift',
      path: pathFor(ws, 'shift', 'legacy_shift'),
      data: {
        id: 'legacy_shift',
        objectName: 'Legacy object',
        objectId: 'legacy_object',
        startDate: '23.11.2026',
        startedAt: 1795420800000,
        startedBy: 'Legacy Author',
        isActive: true,
      },
    },
  };
  await assert.rejects(
    () => appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [legacyShift] }, ws),
    error => error.code === 'protocol-upgrade-required',
  );
  assert.equal((await streamRows(ws)).length, 0);
  assert.equal(await cursorOf(ws), 0);
  assert.equal(await headCount(ws), 0);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS n FROM shifts WHERE workspace_id=$1', [ws],
  )).rows[0].n, 0);
});

test('the replica transport sender is never recorded as the shift creator', {skip: !connectionString}, async () => {
  const ws = await reset();
  const creatorUid = 'creator-replica-shift';
  await seedUser(creatorUid, 'Создатель Смены');
  const objectId = 'object_sender';
  const shiftId = 'shift_sender';
  await appendReplicaBatch(pool, UID, {
    baseSeq: 0,
    operations: [
      v2set(ws, 'replica-sender-obj', 'objects', objectId, { name: 'Object' }),
      shiftV2(ws, shiftId, objectId, { creatorUid }),
    ],
  }, ws);

  const row = (await pool.query(
    `SELECT opened_by_uid,opened_by_name_snapshot,identity_resolution,payload_schema_version,payload
       FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
    [ws, shiftId],
  )).rows[0];
  assert.equal(row.opened_by_uid, creatorUid);
  assert.notEqual(row.opened_by_uid, UID, 'the batch sender must not become the opener');
  assert.equal(row.opened_by_name_snapshot, 'Создатель Смены');
  assert.equal(row.identity_resolution, 'source');
  assert.equal(Number(row.payload_schema_version), 2);
  assert.equal(row.payload.startedByUid, creatorUid);
});

test('doc.delete normalizes data:null into one canonical envelope before hashing', {skip: !connectionString}, async () => {
  const ws = await reset();
  const withNull = v2delete(ws, 'replica-delete-0001', 'logs', 'log_delete', null);
  const withoutData = v2delete(ws, 'replica-delete-0002', 'logs', 'log_delete');
  const a = normalizeReplicaOperation(withNull);
  const b = normalizeReplicaOperation(withoutData);
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.payload, { collection: 'logs', path: pathFor(ws, 'logs', 'log_delete') });
  assert.equal('data' in a.payload, false);

  await appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [withNull, withoutData] }, ws);
  const rows = await streamRows(ws);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.sha256, a.hash, 'both transport spellings share one canonical hash');
    assert.equal('data' in row.payload, false, 'the stream keeps the canonical delete envelope');
  }

  // Any other data value is not a transport alias and is refused before writes.
  await assert.rejects(
    () => appendReplicaBatch(pool, UID, {
      baseSeq: 2,
      operations: [v2delete(ws, 'replica-delete-0003', 'logs', 'log_other', { stale: true })],
    }, ws),
    error => error.code === 'invalid-replica-delete-payload',
  );
  assert.equal((await streamRows(ws)).length, 2);
  assert.equal(await cursorOf(ws), 2);
});

test('a v2 document whose data.id disagrees with its path is refused', {skip: !connectionString}, async () => {
  const ws = await reset();
  const mismatched = {
    id: 'replica-mismatch-0001',
    protocolVersion: 2,
    kind: 'doc.set',
    payload: {
      collection: 'trucks',
      path: pathFor(ws, 'trucks', 'truck_path'),
      data: { id: 'truck_payload', name: 'Mismatch' },
    },
  };
  assert.throws(
    () => normalizeReplicaOperation(mismatched),
    error => error.code === 'replica-document-id-mismatch',
  );
  await assert.rejects(
    () => appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [mismatched] }, ws),
    error => error.code === 'replica-document-id-mismatch',
  );
  assert.equal((await streamRows(ws)).length, 0);
  assert.equal(await cursorOf(ws), 0);
  assert.equal(await headCount(ws), 0);
});

test('objects and users operations create versioned heads with their routing columns', {skip: !connectionString}, async () => {
  const ws = await reset();
  const objectId = 'object_head';
  const userUid = 'user-head-replica';
  const result = await appendReplicaBatch(pool, UID, {
    baseSeq: 0,
    operations: [
      v2set(ws, 'replica-head-obj', 'objects', objectId, { name: 'Object' }),
      v2set(ws, 'replica-head-user', 'users', userUid, {
        email: 'head@example.invalid', role: 'driver', status: 'active', nickname: 'Head',
      }),
    ],
  }, ws);
  assert.equal(result.applied, 2);

  const objectHead = (await pool.query(
    `SELECT head_seq,head_kind,canonical_present,applied_seq,object_id,user_uid,shift_id,truck_id
       FROM replica_document_heads
      WHERE workspace_id=$1 AND collection='objects' AND document_id=$2`,
    [ws, objectId],
  )).rows[0];
  assert.equal(Number(objectHead.head_seq), 1);
  assert.equal(objectHead.head_kind, 'doc.set');
  assert.equal(objectHead.canonical_present, true);
  assert.equal(Number(objectHead.applied_seq), 1);
  assert.equal(objectHead.object_id, objectId);
  assert.equal(objectHead.user_uid, null);
  assert.equal(objectHead.shift_id, null);
  assert.equal(objectHead.truck_id, null);

  const userHead = (await pool.query(
    `SELECT head_seq,canonical_present,applied_seq,object_id,user_uid
       FROM replica_document_heads
      WHERE workspace_id=$1 AND collection='users' AND document_id=$2`,
    [ws, userUid],
  )).rows[0];
  assert.equal(Number(userHead.head_seq), 2);
  assert.equal(userHead.canonical_present, true);
  assert.equal(Number(userHead.applied_seq), 2);
  assert.equal(userHead.user_uid, userUid);
  assert.equal(userHead.object_id, null);

  assert.equal((await pool.query(
    'SELECT count(*)::int AS n FROM workspace_objects WHERE workspace_id=$1 AND object_id=$2',
    [ws, objectId],
  )).rows[0].n, 1);
  const user = (await pool.query('SELECT email,role,status FROM app_users WHERE uid=$1', [userUid])).rows[0];
  assert.equal(user.email, 'head@example.invalid');
  assert.equal(user.role, 'driver');
  assert.equal(user.status, 'active');

  const report = await verifyReplicaHeads(pool, ws);
  assert.equal(report.ok, true, JSON.stringify(report.violations));
});

test('a shift with a missing object or user rolls the whole batch back', {skip: !connectionString}, async () => {
  for (const missing of ['object', 'user']) {
    const ws = await reset();
    const creatorUid = 'creator-replica-parent';
    await seedUser(creatorUid, 'Родитель Смены');
    const objectId = 'object_present';
    const shiftId = `shift_missing_${missing}`;
    const operations = [
      v2set(ws, `replica-parent-obj-${missing}`, 'objects', objectId, { name: 'Object' }),
      shiftV2(ws, shiftId, missing === 'object' ? 'object_absent' : objectId, {
        creatorUid: missing === 'user' ? 'user_absent' : creatorUid,
      }),
    ];
    await assert.rejects(
      () => appendReplicaBatch(pool, UID, { baseSeq: 0, operations }, ws),
      error => error.code === (missing === 'object'
        ? 'replica-shift-object-missing'
        : 'replica-shift-user-missing'),
      `missing ${missing} must reject the batch`,
    );
    // The parent object the batch already materialized is rolled back too.
    assert.equal((await streamRows(ws)).length, 0, `${missing}: stream must roll back`);
    assert.equal(await cursorOf(ws), 0, `${missing}: cursor must not advance`);
    assert.equal(await headCount(ws), 0, `${missing}: no head may survive`);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM workspace_objects WHERE workspace_id=$1', [ws],
    )).rows[0].n, 0, `${missing}: the batch parent object must roll back`);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM shifts WHERE workspace_id=$1', [ws],
    )).rows[0].n, 0, `${missing}: no shift row may survive`);
  }
});

test('a batch materializes parents before children regardless of arrival order', {skip: !connectionString}, async () => {
  const ws = await reset();
  const creatorUid = 'creator-replica-topology';
  await seedUser(creatorUid, 'Топология Смены');
  const objectId = 'object_topology';
  const shiftId = 'shift_topology';
  const truckId = 'truck_topology';
  // Deliberately child-first: shift before its object, status before its truck.
  const operations = [
    shiftV2(ws, shiftId, objectId, { creatorUid }),
    v2set(ws, 'replica-topo-obj', 'objects', objectId, { name: 'Object' }),
    v2set(ws, 'replica-topo-status', 'truckStatus', truckId, { shiftId, onLine: true }),
    v2set(ws, 'replica-topo-truck', 'trucks', truckId, { name: 'Truck' }),
  ];
  const result = await appendReplicaBatch(pool, UID, { baseSeq: 0, operations }, ws);
  assert.equal(result.applied, 4);

  assert.equal((await pool.query(
    'SELECT count(*)::int AS n FROM shifts WHERE workspace_id=$1 AND shift_id=$2', [ws, shiftId],
  )).rows[0].n, 1);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS n FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2', [ws, truckId],
  )).rows[0].n, 1);
  const status = (await pool.query(
    'SELECT shift_id FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2', [ws, truckId],
  )).rows[0];
  assert.equal(status.shift_id, shiftId);

  // The head keeps the arrival generation: materialization order is topological,
  // the immutable stream sequence is not renumbered.
  assert.equal(Number((await head(ws, 'objects', objectId)).head_seq), 2);
  const shiftHead = await head(ws, 'shift', shiftId);
  assert.equal(Number(shiftHead.head_seq), 1);
  assert.equal(Number(shiftHead.applied_seq), 1);
  const statusHead = await head(ws, 'truckStatus', truckId);
  assert.equal(Number(statusHead.head_seq), 3);
  assert.equal(statusHead.canonical_present, true);
  assert.equal(Number(statusHead.applied_seq), 3);
  assert.equal(Number((await head(ws, 'trucks', truckId)).head_seq), 4);

  const report = await verifyReplicaHeads(pool, ws);
  assert.equal(report.ok, true, JSON.stringify(report.violations));
});

test.after(async () => { if (pool) await pool.end(); });
