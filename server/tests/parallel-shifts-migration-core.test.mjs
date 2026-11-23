import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';

import { applyMigrations } from '../scripts/apply-migrations.mjs';
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

const migrationUrl = new URL('../sql/025_parallel_shifts_core.sql', import.meta.url);
const poolForTest = (max = 1) => new pg.Pool({ connectionString, max });

async function prepareLegacyFixture(suffix) {
  await resetIsolatedDatabase();
  await applyMigrationsThrough(24);
  return seedParallelShiftFixture({ suffix });
}

async function columnMap(pool, table) {
  const result = await pool.query(
    `SELECT column_name,data_type,udt_name,is_nullable,column_default
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Map(result.rows.map(row => [row.column_name, row]));
}

function expectUnsafeLegacyFixtureRejected(name, mutate) {
  test(name, { skip: !approved }, async () => {
    const ids = await prepareLegacyFixture(name.replaceAll(/[^a-z0-9]/gi, '_'));
    const pool = poolForTest();
    try {
      await mutate(pool, ids);
      await assert.rejects(() => applyMigrationsThrough(25));
      assert.equal((await pool.query(
        `SELECT count(*)::int AS n FROM schema_migrations
          WHERE filename='025_parallel_shifts_core.sql'`,
      )).rows[0].n, 0);
      assert.equal((await pool.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_schema='public' AND table_name='shifts' AND column_name='state'`,
      )).rows[0].n, 0, 'failed migration must leave no partial schema');
      assert.equal((await pool.query(
        `SELECT to_regclass('public.shift_members') IS NULL AS absent`,
      )).rows[0].absent, true);
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

test('025 backfills canonical shift fields and installs the exact core schema', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('core_good');
  const pool = poolForTest(4);
  try {
    // Same object/date is intentional: day and night must not conflict.
    await pool.query(
      `UPDATE shifts
          SET payload=jsonb_set(payload,'{objectId}',to_jsonb($3::text))
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftBId, ids.objectAId],
    );
    await applyMigrationsThrough(25);

    const shiftColumns = await columnMap(pool, 'shifts');
    const expectedShiftColumns = {
      state: ['text', 'NO'],
      object_id: ['text', 'NO'],
      object_name_snapshot: ['text', 'NO'],
      work_date: ['date', 'NO'],
      shift_type: ['text', 'NO'],
      opened_at: ['timestamp with time zone', 'NO'],
      opened_by_uid: ['text', 'NO'],
      object_locked_at: ['timestamp with time zone', 'YES'],
      object_locked_by_operation_id: ['text', 'YES'],
      closing_started_at: ['timestamp with time zone', 'YES'],
      closing_by_uid: ['text', 'YES'],
      closed_at: ['timestamp with time zone', 'YES'],
      closed_by_uid: ['text', 'YES'],
      revision: ['bigint', 'NO'],
    };
    for (const [name, [type, nullable]] of Object.entries(expectedShiftColumns)) {
      assert.equal(shiftColumns.get(name)?.data_type, type, `shifts.${name} type`);
      assert.equal(shiftColumns.get(name)?.is_nullable, nullable, `shifts.${name} nullability`);
    }
    assert.match(shiftColumns.get('revision').column_default, /1/);
    assert.equal(shiftColumns.get('is_active').data_type, 'boolean');

    const shifts = await pool.query(
      `SELECT shift_id,state,object_id,object_name_snapshot,work_date::text AS work_date,
              shift_type,opened_at,opened_by_uid,revision,is_active
         FROM shifts WHERE workspace_id=$1 ORDER BY shift_id`,
      [ids.workspaceId],
    );
    assert.deepEqual(shifts.rows.map(row => ({
      shiftId: row.shift_id,
      state: row.state,
      objectId: row.object_id,
      workDate: row.work_date,
      shiftType: row.shift_type,
      actor: row.opened_by_uid,
      revision: row.revision,
      active: row.is_active,
    })), [
      { shiftId: ids.shiftAId, state: 'active', objectId: ids.objectAId, workDate: '2026-11-23', shiftType: 'day', actor: ids.adminUid, revision: '1', active: true },
      { shiftId: ids.shiftBId, state: 'active', objectId: ids.objectAId, workDate: '2026-11-23', shiftType: 'night', actor: ids.foremanUid, revision: '1', active: true },
    ]);
    assert.ok(shifts.rows.every(row => row.opened_at instanceof Date));

    const memberColumns = await columnMap(pool, 'shift_members');
    for (const [name, type, nullable] of [
      ['workspace_id', 'text', 'NO'], ['shift_id', 'text', 'NO'], ['uid', 'text', 'NO'],
      ['assigned_at', 'timestamp with time zone', 'NO'], ['assigned_by_uid', 'text', 'NO'],
      ['removed_at', 'timestamp with time zone', 'YES'], ['removed_by_uid', 'text', 'YES'],
      ['revision', 'bigint', 'NO'],
    ]) {
      assert.equal(memberColumns.get(name)?.data_type, type, `shift_members.${name} type`);
      assert.equal(memberColumns.get(name)?.is_nullable, nullable, `shift_members.${name} nullability`);
    }

    const statusColumns = await columnMap(pool, 'line_truck_statuses');
    for (const name of ['status_revision', 'cycle_revision', 'ttn_revision']) {
      assert.equal(statusColumns.get(name)?.data_type, 'bigint', `${name} must be bigint`);
      assert.equal(statusColumns.get(name)?.is_nullable, 'NO');
      assert.match(statusColumns.get(name)?.column_default, /1/);
    }

    const primaryKeys = await pool.query(
      `SELECT c.relname AS table_name,json_agg(a.attname ORDER BY k.ordinality) AS columns
         FROM pg_constraint x
         JOIN pg_class c ON c.oid=x.conrelid
         JOIN unnest(x.conkey) WITH ORDINALITY k(attnum,ordinality) ON true
         JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
        WHERE x.contype='p' AND c.relname IN ('shift_members','line_truck_statuses')
        GROUP BY c.relname ORDER BY c.relname`,
    );
    assert.deepEqual(primaryKeys.rows, [
      { table_name: 'line_truck_statuses', columns: ['workspace_id', 'truck_id'] },
      { table_name: 'shift_members', columns: ['workspace_id', 'shift_id', 'uid'] },
    ]);

    await assert.rejects(
      pool.query(`UPDATE shifts SET revision=0 WHERE workspace_id=$1 AND shift_id=$2`, [ids.workspaceId, ids.shiftAId]),
      error => error.code === '23514',
    );
    await pool.query(
      `UPDATE shifts SET is_active=false WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    );
    assert.deepEqual((await pool.query(
      `SELECT state,is_active FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    )).rows[0], { state: 'closed', is_active: false });
    await pool.query(
      `UPDATE shifts SET state='active' WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    );
    await pool.query(
      `UPDATE shifts SET state='closing' WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    );
    assert.deepEqual((await pool.query(
      `SELECT state,is_active FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    )).rows[0], { state: 'closing', is_active: true });
    await pool.query(
      `UPDATE shifts SET state='active' WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    );
    await assert.rejects(
      pool.query(`UPDATE shifts SET state='unknown' WHERE workspace_id=$1 AND shift_id=$2`, [ids.workspaceId, ids.shiftAId]),
      error => error.code === '23514',
    );

    await pool.query(
      `INSERT INTO shift_members(workspace_id,shift_id,uid,assigned_at,assigned_by_uid)
       VALUES($1,$2,$3,now(),$4)`,
      [ids.workspaceId, ids.shiftAId, ids.foremanUid, ids.adminUid],
    );
    await assert.rejects(
      pool.query(
        `UPDATE shift_members SET removed_at=now(),removed_by_uid=NULL
          WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3`,
        [ids.workspaceId, ids.shiftAId, ids.foremanUid],
      ),
      error => error.code === '23514',
    );
    await pool.query(
      `UPDATE shift_members SET removed_at=now(),removed_by_uid=$4,revision=revision+1
        WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3`,
      [ids.workspaceId, ids.shiftAId, ids.foremanUid, ids.adminUid],
    );
    await pool.query(
      `UPDATE shift_members
          SET removed_at=NULL,removed_by_uid=NULL,assigned_at=now(),assigned_by_uid=$4,revision=revision+1
        WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3`,
      [ids.workspaceId, ids.shiftAId, ids.foremanUid, ids.adminUid],
    );
    const membership = (await pool.query(
      `SELECT count(*)::int AS rows,max(revision)::text AS revision,
              bool_and(removed_at IS NULL AND removed_by_uid IS NULL) AS active
         FROM shift_members WHERE workspace_id=$1 AND shift_id=$2 AND uid=$3`,
      [ids.workspaceId, ids.shiftAId, ids.foremanUid],
    )).rows[0];
    assert.deepEqual(membership, { rows: 1, revision: '3', active: true });
    await assert.rejects(
      pool.query(
        `INSERT INTO shift_members(workspace_id,shift_id,uid,assigned_at,assigned_by_uid,revision)
         VALUES($1,$2,$3,now(),$4,0)`,
        [ids.workspaceId, ids.shiftBId, ids.foremanUid, ids.adminUid],
      ),
      error => error.code === '23514',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO shift_members(workspace_id,shift_id,uid,assigned_at,assigned_by_uid)
         VALUES($1,$2,'missing-user',now(),$3)`,
        [ids.workspaceId, ids.shiftBId, ids.adminUid],
      ),
      error => error.code === '23503',
    );
    await pool.query(
      `INSERT INTO app_users(uid,email,display_name,role,status)
       VALUES('worker_core_good','worker@example.test','worker','worker','active'),
             ('disabled_foreman_core_good','disabled@example.test','disabled','foreman','disabled')`,
    );
    for (const uid of ['worker_core_good', 'disabled_foreman_core_good']) {
      await assert.rejects(
        pool.query(
          `INSERT INTO shift_members(workspace_id,shift_id,uid,assigned_at,assigned_by_uid)
           VALUES($1,$2,$3,now(),$4)`,
          [ids.workspaceId, ids.shiftBId, uid, ids.adminUid],
        ),
        error => error.code === '23514',
      );
    }

    await pool.query(
      `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload)
       VALUES($1,$2,$3,$4)`,
      [ids.workspaceId, ids.truckId, ids.shiftAId, { id: ids.truckId, shiftId: ids.shiftAId }],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload)
         VALUES($1,$2,$3,$4)`,
        [ids.workspaceId, ids.truckId, ids.shiftBId, { id: ids.truckId, shiftId: ids.shiftBId }],
      ),
      error => error.code === '23505',
    );
    await assert.rejects(
      pool.query(
        `UPDATE line_truck_statuses SET status_revision=0
          WHERE workspace_id=$1 AND truck_id=$2`,
        [ids.workspaceId, ids.truckId],
      ),
      error => error.code === '23514',
    );

    // Two concurrent inserts for the same active canonical key: exactly one commits.
    const duplicateIdA = 'duplicate_a_core_good';
    const duplicateIdB = 'duplicate_b_core_good';
    const insertDuplicate = async (client, shiftId) => client.query(
      `INSERT INTO shifts(
         workspace_id,shift_id,is_active,payload,state,object_id,object_name_snapshot,
         work_date,shift_type,opened_at,opened_by_uid,revision
       ) VALUES($1,$2,true,$3,'active',$4,$5,'2026-11-24','day',now(),$6,1)`,
      [ids.workspaceId, shiftId, {
        id: shiftId, objectId: ids.objectBId, objectName: ids.objectBId,
        startDate: '24.11.2026', workShift: 'day', isActive: true,
      }, ids.objectBId, ids.objectBId, ids.adminUid],
    );
    const clients = [await pool.connect(), await pool.connect()];
    try {
      await Promise.all(clients.map(client => client.query('BEGIN')));
      await insertDuplicate(clients[0], duplicateIdA);
      const secondInsert = insertDuplicate(clients[1], duplicateIdB);
      await clients[0].query('COMMIT');
      await assert.rejects(secondInsert, error => error.code === '23505');
      await clients[1].query('ROLLBACK');
    } finally {
      clients.forEach(client => client.release());
    }

    const migrationSource = await readFile(migrationUrl);
    const expectedChecksum = createHash('sha256').update(migrationSource).digest('hex');
    const registry = (await pool.query(
      `SELECT checksum FROM schema_migrations WHERE filename='025_parallel_shifts_core.sql'`,
    )).rows[0];
    assert.deepEqual(registry, { checksum: expectedChecksum });
    await applyMigrationsThrough(25);
    assert.equal((await pool.query(
      `SELECT count(*)::int AS n FROM schema_migrations
        WHERE filename='025_parallel_shifts_core.sql'`,
    )).rows[0].n, 1, 'repeat runner must be a no-op');
    const registryRun = await applyMigrations(pool, {
      exclude: ['018_auth_credentials.sql'],
      through: 25,
    });
    assert.deepEqual(
      registryRun.find(result => result.filename === '025_parallel_shifts_core.sql'),
      { filename: '025_parallel_shifts_core.sql', status: 'skipped' },
    );
  } finally {
    await pool.end();
  }
});

expectUnsafeLegacyFixtureRejected('025 rejects a null canonical legacy object instead of guessing', async (pool, ids) => {
  await pool.query(
    `UPDATE shifts SET payload=payload-'objectId'
      WHERE workspace_id=$1 AND shift_id=$2`,
    [ids.workspaceId, ids.shiftAId],
  );
});

expectUnsafeLegacyFixtureRejected('025 rejects an unknown object reference instead of guessing', async (pool, ids) => {
  await pool.query(
    `UPDATE shifts SET payload=jsonb_set(payload,'{objectId}','"missing-object"'::jsonb)
      WHERE workspace_id=$1 AND shift_id=$2`,
    [ids.workspaceId, ids.shiftAId],
  );
});

expectUnsafeLegacyFixtureRejected('025 rejects an ambiguous legacy shift type instead of defaulting', async (pool, ids) => {
  await pool.query(
    `UPDATE shifts SET payload=payload-'workShift'
      WHERE workspace_id=$1 AND shift_id=$2`,
    [ids.workspaceId, ids.shiftAId],
  );
});

expectUnsafeLegacyFixtureRejected('025 rejects payload identity and active-state mismatch', async (pool, ids) => {
  await pool.query(
    `UPDATE shifts
        SET payload=jsonb_set(jsonb_set(payload,'{id}','"different-shift"'::jsonb),'{isActive}','false'::jsonb)
      WHERE workspace_id=$1 AND shift_id=$2`,
    [ids.workspaceId, ids.shiftAId],
  );
});
