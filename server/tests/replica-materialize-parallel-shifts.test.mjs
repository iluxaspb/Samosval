import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { applyReplicaDocument } from '../src/replica-materialize.mjs';
import { readLineSnapshot } from '../src/line-read.mjs';
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
const operation = (collection, id, data) => ({
  kind: 'doc.set',
  payload: { collection, path: `workspaces/replica_parallel/${collection}/${id}`, data },
});

async function prepare() {
  await resetIsolatedDatabase();
  await applyMigrationsThrough(24);
  const ids = await seedParallelShiftFixture({ suffix: 'replica_parallel' });
  await applyMigrationsThrough(25);
  const pool = poolForTest();
  try {
    await pool.query(
      `UPDATE shifts
          SET payload=jsonb_set(payload,'{isActive}','false'::jsonb)
        WHERE workspace_id=$1`,
      [ids.workspaceId],
    );
  } finally {
    await pool.end();
  }
  return ids;
}

async function materialize(pool, workspaceId, item) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyReplicaDocument(client, workspaceId, item);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function shiftPayload(ids, shiftId, startedAt) {
  return {
    id: shiftId,
    objectId: ids.objectAId,
    objectName: 'Replica object snapshot',
    startDate: '23.11.2026',
    startedAt,
    startedByUid: ids.adminUid,
    isActive: true,
    workShift: 'day',
  };
}

for (const source of ['truckStatus', 'logs']) {
  test(`replica ${source} before shift creates a hidden placeholder and atomically promotes it`, {
    skip: !approved,
  }, async () => {
    const ids = await prepare();
    const pool = poolForTest();
    const shiftId = `future_${source}`;
    const truckId = `replica_${source}_truck`;
    try {
      if (source === 'truckStatus') {
        await materialize(pool, ids.workspaceId, operation('trucks', truckId, { id: truckId, name: 'Replica truck' }));
        await materialize(pool, ids.workspaceId, operation(source, truckId, {
          id: truckId, shiftId, onLine: true,
        }));
      } else {
        await materialize(pool, ids.workspaceId, operation(source, `replica_${source}_log`, {
          id: `replica_${source}_log`, shiftId, truckId, truckName: 'Replica truck',
          timestamp: 1795465000000, volume: 24,
        }));
      }

      const placeholder = (await pool.query(
        `SELECT is_active,replica_placeholder,state,object_id,opened_at,payload
           FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, shiftId],
      )).rows[0];
      assert.deepEqual(placeholder, {
        is_active: false,
        replica_placeholder: true,
        state: null,
        object_id: null,
        opened_at: null,
        payload: {},
      });
      const hidden = await readLineSnapshot(pool, ids.adminUid, ids.workspaceId);
      assert.equal(hidden.shift, null);
      assert.deepEqual(hidden.statuses, []);
      assert.deepEqual(hidden.logs, []);
      if (source === 'truckStatus') {
        process.env.WORKSPACE_ID = ids.workspaceId;
        const { submitLineOperation } = await import('../src/line-store.mjs');
        const now = Date.now();
        const command = await submitLineOperation(pool, ids.adminUid, {
          id: 'placeholder_line_command', type: 'arrive', shiftId, truckId,
          createdAt: now, expectedRevision: 0, expectedTtnRevision: 0,
          arrivalTimestamp: 0, lastLoadTimestamp: 0,
          wantArrived: true, collect: false, cycleMinutes: 15,
        });
        assert.equal(command.outcome, 'rejected');
        assert.equal(command.reason, 'shift-changed');
      }

      const startedAt = 1795420800000;
      await materialize(pool, ids.workspaceId, operation('shift', shiftId, shiftPayload(ids, shiftId, startedAt)));
      const promoted = (await pool.query(
        `SELECT is_active,replica_placeholder,state,object_id,object_name_snapshot,
                work_date::text AS work_date,shift_type,opened_at,opened_by_uid,payload
           FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, shiftId],
      )).rows[0];
      assert.equal(promoted.is_active, true);
      assert.equal(promoted.replica_placeholder, false);
      assert.equal(promoted.state, 'active');
      assert.equal(promoted.object_id, ids.objectAId);
      assert.equal(promoted.object_name_snapshot, 'Replica object snapshot');
      assert.equal(promoted.work_date, '2026-11-23');
      assert.equal(promoted.shift_type, 'day');
      assert.equal(promoted.opened_at.toISOString(), new Date(startedAt).toISOString());
      assert.equal(promoted.opened_by_uid, ids.adminUid);
      assert.deepEqual(promoted.payload, shiftPayload(ids, shiftId, startedAt));
    } finally {
      await pool.end();
    }
  });
}

test.after(async () => {
  if (!approved) return;
  await resetIsolatedDatabase();
  await applyMigrationsThrough(24);
});
