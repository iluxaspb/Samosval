import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { appendReplicaBatch, readReplicaJournal } from '../src/replica-store.mjs';

// Интеграционные проверки журнала репликации на реальном PostgreSQL.
// Требуют переменных POSTGRES_* (контейнер API передаёт их сам).
const pool = new Pool({
  host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
  database: process.env.POSTGRES_DB, user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD, max: 2
});
const UID = 'test-admin-replica';
const WS = 'main_workspace';

async function reset() {
  await pool.query('DELETE FROM replica_stream');
  await pool.query('UPDATE replica_cursor SET f2s_seq=0, s2f_seq=0');
  await pool.query("UPDATE server_authority SET provider='firebase', generation=1 WHERE workspace_id=$1", [WS]);
}
const op = (id, n) => ({ id, kind: 'trip.load', payload: { n, at: 1700000000000 + n } });

test('пачка применяется и получает строгую последовательность', async () => {
  await reset();
  const result = await appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [op('replica-op-0001', 1), op('replica-op-0002', 2)] });
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.applied, 2);
  assert.equal(result.seq, 2);
  const rows = await pool.query('SELECT seq, operation_id FROM replica_stream ORDER BY seq');
  assert.deepEqual(rows.rows.map(r => Number(r.seq)), [1, 2]);
});

test('повторная отправка не создаёт дубликатов и не двигает последовательность', async () => {
  await reset();
  const batch = { baseSeq: 0, operations: [op('replica-op-0001', 1), op('replica-op-0002', 2)] };
  await appendReplicaBatch(pool, UID, batch);
  const again = await appendReplicaBatch(pool, UID, batch);
  assert.equal(again.applied, 0);
  assert.equal(again.seq, 2);
  const count = await pool.query('SELECT count(*)::int AS n FROM replica_stream');
  assert.equal(count.rows[0].n, 2);
});

test('пропуск последовательности блокирует применение', async () => {
  await reset();
  await appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [op('replica-op-0001', 1)] });
  await assert.rejects(
    () => appendReplicaBatch(pool, UID, { baseSeq: 5, operations: [op('replica-op-0009', 9)] }),
    error => error.code === 'replica-sequence-gap'
  );
});

test('тот же operation_id с другим содержимым отклоняется', async () => {
  await reset();
  await appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [op('replica-op-0001', 1)] });
  await assert.rejects(
    () => appendReplicaBatch(pool, UID, { baseSeq: 1, operations: [op('replica-op-0001', 77)] }),
    error => error.code === 'replica-operation-conflict'
  );
});

test('резерв не принимает зеркало, когда сам объявлен владельцем', async () => {
  await reset();
  await pool.query("UPDATE server_authority SET provider='ubuntu', generation=2 WHERE workspace_id=$1", [WS]);
  await assert.rejects(
    () => appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [op('replica-op-0001', 1)] }),
    error => error.code === 'replica-reserve-is-owner'
  );
  await pool.query("UPDATE server_authority SET provider='firebase', generation=3 WHERE workspace_id=$1", [WS]);
});

test('журнал обратной репликации отдаёт непрерывную последовательность', async () => {
  await reset();
  const journal = await readReplicaJournal(pool, UID, { since: 0, limit: 50 });
  assert.equal(journal.contiguous, true);
  assert.deepEqual(journal.items, []);
  assert.equal(journal.head, 0);
});

test('взаимное исключение: при владельце Firebase прикладная запись в Ubuntu отклоняется', async () => {
  await reset();
  const { assertWriteAuthority } = await import('../src/authority.mjs');
  await assert.rejects(
    () => assertWriteAuthority(pool, { headers: {} }),
    error => error.code === 'not-authoritative'
  );
  // Зеркало при этом принимается — резерв обязан получать изменения.
  const mirrored = await appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [op('replica-op-0001', 1)] });
  assert.equal(mirrored.applied, 1);
});

test('взаимное исключение: при владельце Ubuntu зеркало не принимается', async () => {
  await reset();
  await pool.query("UPDATE server_authority SET provider='ubuntu', generation=2 WHERE workspace_id=$1", [WS]);
  const { assertWriteAuthority } = await import('../src/authority.mjs');
  await assert.doesNotReject(() => assertWriteAuthority(pool, { headers: {} }));
  await assert.rejects(
    () => appendReplicaBatch(pool, UID, { baseSeq: 0, operations: [op('replica-op-0002', 2)] }),
    error => error.code === 'replica-reserve-is-owner'
  );
  await pool.query("UPDATE server_authority SET provider='firebase', generation=3 WHERE workspace_id=$1", [WS]);
});

test.after(async () => { await pool.end(); });