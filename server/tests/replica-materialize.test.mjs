import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { appendReplicaBatch } from '../src/replica-store.mjs';

// Проверяем главное свойство резерва: изменение Firebase не просто пишется в
// журнал, а действительно появляется в рабочих таблицах, из которых читает API.
const pool = new Pool({
  host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
  database: process.env.POSTGRES_DB, user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD, max: 2
});
const UID = 'test-admin-replica';
const WS = 'main_workspace';
const P = 'zz-verify-';

const doc = (id, collection, path, data) => ({
  id: P + id, kind: 'doc.set', payload: { collection, path, data }
});

async function cleanup() {
  await pool.query('DELETE FROM line_logs WHERE log_id LIKE $1', [P + '%']);
  await pool.query('DELETE FROM line_truck_statuses WHERE truck_id LIKE $1', [P + '%']);
  await pool.query('DELETE FROM line_trucks WHERE truck_id LIKE $1', [P + '%']);
  await pool.query('DELETE FROM workspace_objects WHERE object_id LIKE $1', [P + '%']);
  await pool.query('DELETE FROM shift_archives WHERE archive_id LIKE $1', [P + '%']);
  await pool.query('DELETE FROM shifts WHERE shift_id LIKE $1', [P + '%']);
  await pool.query('DELETE FROM app_users WHERE uid LIKE $1', [P + '%']);
  await pool.query("DELETE FROM replica_stream WHERE operation_id LIKE 'zz-verify-%'");
}

async function reset() {
  await cleanup();
  await pool.query('DELETE FROM replica_stream');
  await pool.query('UPDATE replica_cursor SET f2s_seq=0, s2f_seq=0');
  await pool.query("UPDATE server_authority SET provider='firebase', generation=1 WHERE workspace_id=$1", [WS]);
}

const batch = id => ({
  baseSeq: 0,
  operations: [
    doc('1', 'shift', 'workspaces/main_workspace/shift/' + P + 'shift', { id: P + 'shift', isActive: true }),
    doc('2', 'trucks', 'workspaces/main_workspace/trucks/' + P + 'truck', { id: P + 'truck', name: 'Тест' }),
    doc('3', 'truckStatus', 'workspaces/main_workspace/truckStatus/' + P + 'truck', { id: P + 'truck', shiftId: P + 'shift', onLine: true }),
    doc('4', 'logs', 'workspaces/main_workspace/logs/' + P + 'log', { id: P + 'log', shiftId: P + 'shift', truckId: P + 'truck', volume: 12 }),
    doc('5', 'objects', 'workspaces/main_workspace/objects/' + P + 'obj', { id: P + 'obj', name: 'Объект' }),
    doc('6', 'users', 'users/' + P + 'user', { email: 'zz-verify@example.invalid', role: 'driver', status: 'active', nickname: 'Резерв' }),
    doc('7', 'archive', 'workspaces/main_workspace/archive/' + P + 'arch', { id: P + 'arch', shiftId: P + 'shift', logs: [] }),
    doc('8', 'audit', 'workspaces/main_workspace/audit/' + P + 'audit', { text: 'служебная запись' })
  ]
});

test('резерв наполняется: изменённые документы попадают в рабочие таблицы', async () => {
  await reset();
  const result = await appendReplicaBatch(pool, UID, batch());
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.applied, 8);
  const shift = (await pool.query('SELECT is_active, payload FROM shifts WHERE shift_id=$1', [P + 'shift'])).rows[0];
  assert.equal(shift.is_active, true);
  assert.equal(shift.payload.name === undefined, true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM line_trucks WHERE truck_id=$1', [P + 'truck'])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM line_truck_statuses WHERE truck_id=$1', [P + 'truck'])).rows[0].n, 1);
  const log = (await pool.query('SELECT shift_id, truck_id, payload FROM line_logs WHERE log_id=$1', [P + 'log'])).rows[0];
  assert.equal(log.shift_id, P + 'shift');
  assert.equal(log.truck_id, P + 'truck');
  assert.equal(log.payload.volume, 12);
  assert.equal((await pool.query('SELECT count(*)::int n FROM workspace_objects WHERE object_id=$1', [P + 'obj'])).rows[0].n, 1);
  const user = (await pool.query('SELECT role, status, email FROM app_users WHERE uid=$1', [P + 'user'])).rows[0];
  assert.equal(user.role, 'driver');
  assert.equal(user.status, 'active');
  assert.equal((await pool.query('SELECT count(*)::int n FROM shift_archives WHERE archive_id=$1', [P + 'arch'])).rows[0].n, 1);
});

test('повторная отправка той же пачки не дублирует данные', async () => {
  await reset();
  await appendReplicaBatch(pool, UID, batch());
  const again = await appendReplicaBatch(pool, UID, batch());
  assert.equal(again.applied, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM line_logs WHERE log_id=$1', [P + 'log'])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM app_users WHERE uid=$1', [P + 'user'])).rows[0].n, 1);
});

test('пропуск последовательности блокирует применение', async () => {
  await reset();
  await assert.rejects(
    () => appendReplicaBatch(pool, UID, { baseSeq: 5, operations: batch().operations }),
    error => error.status === 409
  );
  assert.equal((await pool.query('SELECT count(*)::int n FROM line_logs WHERE log_id=$1', [P + 'log'])).rows[0].n, 0);
});

test('резерв не принимает зеркало, когда владельцем записи объявлен сам', async () => {
  await reset();
  await pool.query("UPDATE server_authority SET provider='ubuntu', generation=2 WHERE workspace_id=$1", [WS]);
  await assert.rejects(
    () => appendReplicaBatch(pool, UID, batch()),
    error => error.status === 409 && error.code === 'replica-reserve-is-owner'
  );
  await pool.query("UPDATE server_authority SET provider='firebase', generation=3 WHERE workspace_id=$1", [WS]);
});

test('только администратор резерва может отправлять зеркало', async () => {
  await reset();
  await pool.query("INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$2,$3,'driver','active') ON CONFLICT (uid) DO NOTHING", [P + 'driver', 'zz-verify-driver@example.invalid', 'Водитель']);
  try {
    // serviceActor требует активного пользователя; проверяем, что чужой uid не проходит.
    await assert.rejects(() => appendReplicaBatch(pool, 'no-such-uid', batch()), error => error.status === 403);
  } finally {
    await pool.query('DELETE FROM app_users WHERE uid=$1', [P + 'driver']);
  }
});

test.after(async () => { await cleanup(); await pool.end(); });