import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { appendReplicaBatch } from '../src/replica-store.mjs';
import {
  applyMigrationsThrough,
  requireIsolatedDatabase,
  resetIsolatedDatabase,
  seedParallelShiftFixture,
} from './helpers/isolated-db.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
let approved = false;
if (connectionString && process.env.SAMOSVAL_ISOLATED_TEST === '1') {
  try {
    requireIsolatedDatabase(connectionString);
    approved = true;
  } catch {}
}

const poolForTest = () => new pg.Pool({ connectionString, max: 2 });
const operation = (id, collection, documentId, data) => ({
  id,
  kind: 'doc.set',
  payload: { collection, path: `workspaces/replica_parallel/${collection}/${documentId}`, data },
});

async function prepare() {
  await resetIsolatedDatabase();
  await applyMigrationsThrough(24);
  const ids = await seedParallelShiftFixture({ suffix: 'replica_parallel' });
  await applyMigrationsThrough(25);
  const pool = poolForTest();
  try {
    // Seed rows are migrated legacy documents; retire them from the live selector
    // through canonical columns only (a v1 payload write is refused after cutover).
    await pool.query(
      `UPDATE shifts SET state='historical',is_active=false WHERE workspace_id=$1`,
      [ids.workspaceId],
    );
    await pool.query(
      `INSERT INTO replica_cursor(workspace_id,f2s_seq,s2f_seq)
       VALUES($1,0,0) ON CONFLICT(workspace_id) DO UPDATE SET f2s_seq=0,s2f_seq=0`,
      [ids.workspaceId],
    );
    await pool.query(
      `INSERT INTO server_authority(workspace_id,provider,generation)
       VALUES($1,'firebase',1)
       ON CONFLICT(workspace_id) DO UPDATE SET provider='firebase',generation=server_authority.generation+1`,
      [ids.workspaceId],
    );
  } finally {
    await pool.end();
  }
  return ids;
}

function shiftPayload(ids, shiftId, startedAt) {
  return {
    payloadSchemaVersion: 2,
    id: shiftId,
    shiftId,
    objectId: ids.objectAId,
    objectName: 'Replica object snapshot',
    startDate: '23.11.2026',
    date: '2026-11-23',
    startedAt,
    startedBy: 'Replica Admin',
    startedByUid: ids.adminUid,
    isActive: true,
    state: 'active',
    workShift: 'day',
    type: 'day',
  };
}

for (const source of ['truckStatus', 'logs']) {
  test(`replica ${source} before its shift fails atomically until migration 026`, {
    skip: !approved,
  }, async () => {
    const ids = await prepare();
    const pool = poolForTest();
    const shiftId = `future_${source}`;
    const truckId = `replica_${source}_truck`;
    const item = source === 'truckStatus'
      ? operation(`missing-parent-${source}`, source, truckId, { id: truckId, shiftId, onLine: true })
      : operation(`missing-parent-${source}`, source, `replica_${source}_log`, {
          id: `replica_${source}_log`, shiftId, truckId, truckName: 'Replica truck',
          timestamp: 1795465000000, volume: 24,
        });
    try {
      await assert.rejects(
        appendReplicaBatch(pool, ids.adminUid, { baseSeq: 0, operations: [item] }, ids.workspaceId),
        error => error.code === '23503' || error.code === 'replica-log-shift-missing',
      );
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM shifts WHERE workspace_id=$1 AND shift_id=$2',
        [ids.workspaceId, shiftId],
      )).rows[0].n, 0);
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2',
        [ids.workspaceId, shiftId],
      )).rows[0].n, 0);
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM line_logs WHERE workspace_id=$1 AND shift_id=$2',
        [ids.workspaceId, shiftId],
      )).rows[0].n, 0);
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2',
        [ids.workspaceId, truckId],
      )).rows[0].n, 0, 'log-created truck must roll back with the failed batch');
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM replica_stream WHERE workspace_id=$1',
        [ids.workspaceId],
      )).rows[0].n, 0);
      assert.equal(Number((await pool.query(
        'SELECT f2s_seq FROM replica_cursor WHERE workspace_id=$1',
        [ids.workspaceId],
      )).rows[0].f2s_seq), 0);
    } finally {
      await pool.end();
    }
  });
}

test('replica log with an existing shift but missing truck fails atomically until migration 026', {
  skip: !approved,
}, async () => {
  const ids = await prepare();
  const pool = poolForTest();
  const truckId = 'missing_replica_truck';
  const item = operation('missing-truck-log', 'logs', 'missing_truck_log', {
    id: 'missing_truck_log', shiftId: ids.shiftAId, truckId, timestamp: 1795465000000, volume: 24,
  });
  try {
    await assert.rejects(
      appendReplicaBatch(pool, ids.adminUid, { baseSeq: 0, operations: [item] }, ids.workspaceId),
      error => error.code === 'replica-log-truck-missing',
    );
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM line_trucks WHERE workspace_id=$1 AND truck_id=$2',
      [ids.workspaceId, truckId],
    )).rows[0].n, 0);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM replica_stream WHERE workspace_id=$1',
      [ids.workspaceId],
    )).rows[0].n, 0);
    assert.equal(Number((await pool.query(
      'SELECT f2s_seq FROM replica_cursor WHERE workspace_id=$1',
      [ids.workspaceId],
    )).rows[0].f2s_seq), 0);
  } finally {
    await pool.end();
  }
});

test('replica accepts a full canonical v2 shift snapshot and rejects legacy or partial documents', {
  skip: !approved,
}, async () => {
  const ids = await prepare();
  const pool = poolForTest();
  const startedAt = 1795420800000;
  try {
    await assert.rejects(
      appendReplicaBatch(pool, ids.adminUid, {
        baseSeq: 0,
        operations: [operation('partial-shift', 'shift', 'partial_shift', { id: 'partial_shift', isActive: true })],
      }, ids.workspaceId),
      error => error.code === '23514' || error.code === '23502' || /protocol-upgrade-required/.test(error.message || ''),
    );
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM shifts WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, 'partial_shift'],
    )).rows[0].n, 0);
    await assert.rejects(
      appendReplicaBatch(pool, ids.adminUid, {
        baseSeq: 0,
        operations: [operation('legacy-shift', 'shift', 'legacy_shift', {
          id: 'legacy_shift', objectId: ids.objectBId, objectName: 'Legacy replica',
          startDate: '23.11.2026', startedAt, startedBy: 'Replica Admin',
          startedByUid: ids.adminUid, isActive: true, workShift: 'day',
        })],
      }, ids.workspaceId),
      /protocol-upgrade-required/,
      'a v1 replica shift must be refused after cutover',
    );
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM shifts WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, 'legacy_shift'],
    )).rows[0].n, 0);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM replica_stream WHERE workspace_id=$1',
      [ids.workspaceId],
    )).rows[0].n, 0);

    const shiftId = 'canonical_shift';
    const payload = shiftPayload(ids, shiftId, startedAt);
    const result = await appendReplicaBatch(pool, ids.adminUid, {
      baseSeq: 0,
      operations: [operation('canonical-shift', 'shift', shiftId, payload)],
    }, ids.workspaceId);
    assert.equal(result.outcome, 'confirmed');
    const row = (await pool.query(
      `SELECT state,object_id,object_name_snapshot,work_date::text AS work_date,
              shift_type,opened_at,opened_by_uid,payload
         FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, shiftId],
    )).rows[0];
    assert.equal(row.state, 'active');
    assert.equal(row.object_id, ids.objectAId);
    assert.equal(row.object_name_snapshot, 'Replica object snapshot');
    assert.equal(row.work_date, '2026-11-23');
    assert.equal(row.shift_type, 'day');
    assert.equal(row.opened_at.toISOString(), new Date(startedAt).toISOString());
    assert.equal(row.opened_by_uid, ids.adminUid);
    assert.deepEqual(row.payload, payload);
  } finally {
    await pool.end();
  }
});

test.after(async () => {
  if (!approved) return;
  await resetIsolatedDatabase();
  await applyMigrationsThrough(24);
});
