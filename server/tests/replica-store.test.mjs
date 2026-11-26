import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { appendReplicaBatch, readReplicaJournal } from '../src/replica-store.mjs';
import { applyReplicaHeadTransition, normalizeReplicaOperation } from '../src/replica-heads.mjs';
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

test.after(async () => { if (pool) await pool.end(); });
