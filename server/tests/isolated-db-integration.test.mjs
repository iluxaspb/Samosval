import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

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

test('isolated harness resets, applies migrations through 24 and seeds existing legacy shifts', {
  skip: !approved,
}, async () => {
  await resetIsolatedDatabase();
  await applyMigrationsThrough(24);
  const ids = await seedParallelShiftFixture({ suffix: 'integration' });
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const migrations = await pool.query(
      `SELECT filename,checksum FROM schema_migrations
       WHERE filename ~ '^[0-9]{3}_' ORDER BY filename`
    );
    assert.equal(migrations.rowCount, 22);
    assert.equal(migrations.rows.at(-1).filename, '024_truck_phone_driver.sql');
    assert.ok(migrations.rows.every(row => /^[0-9a-f]{64}$/.test(row.checksum)));

    const shifts = await pool.query(
      `SELECT shift_id,is_active,payload FROM shifts
       WHERE workspace_id=$1 ORDER BY shift_id`,
      [ids.workspaceId]
    );
    assert.deepEqual(shifts.rows.map(row => row.shift_id), [ids.shiftAId, ids.shiftBId]);
    assert.deepEqual(shifts.rows.map(row => row.is_active), [true, true]);
    assert.deepEqual(shifts.rows.map(row => row.payload.objectId), [ids.objectAId, ids.objectBId]);
  } finally {
    await pool.end();
  }
});
