import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { shiftStartPayload } from '../src/shift-start.mjs';
import { restoredLine } from '../src/archive-store.mjs';
import { applyLineOperation } from '../src/line-rules.mjs';
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

test('025 validates confirmed timestamps before its first schema ALTER', async () => {
  const source = await readFile(migrationUrl, 'utf8');
  assert.ok(
    source.indexOf('DO $validate_confirmed_activity_timestamps$') < source.indexOf('ALTER TABLE shifts'),
    'timestamp preflight must precede schema mutation',
  );
});

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

test('migration runner rolls schema back when registry insert fails and validates checksums fail closed', {
  skip: !approved,
}, async () => {
  await resetIsolatedDatabase();
  const pool = poolForTest();
  const directory = await mkdtemp(join(tmpdir(), 'samosval-migration-atomicity-'));
  try {
    await writeFile(join(directory, '001_atomic.sql'), 'BEGIN;\nCREATE TABLE atomic_probe(id integer);\nCOMMIT;\n');
    await pool.query(`CREATE TABLE schema_migrations(
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum text,
      CONSTRAINT reject_atomic_registry CHECK(filename <> '001_atomic.sql')
    )`);
    await assert.rejects(() => applyMigrations(pool, { dir: directory }));
    assert.equal((await pool.query(`SELECT to_regclass('public.atomic_probe') IS NULL AS absent`)).rows[0].absent, true);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n, 0);

    await pool.query('ALTER TABLE schema_migrations DROP CONSTRAINT reject_atomic_registry');
    const source = await readFile(join(directory, '001_atomic.sql'));
    const checksum = createHash('sha256').update(source).digest('hex');
    await pool.query('INSERT INTO schema_migrations(filename,checksum) VALUES($1,NULL)', ['001_atomic.sql']);
    await assert.rejects(() => applyMigrations(pool, { dir: directory }), /checksum/i);
    await pool.query('UPDATE schema_migrations SET checksum=$2 WHERE filename=$1', ['001_atomic.sql', '0'.repeat(64)]);
    await assert.rejects(() => applyMigrations(pool, { dir: directory }), /checksum/i);
    await pool.query('UPDATE schema_migrations SET checksum=$2 WHERE filename=$1', ['001_atomic.sql', checksum]);
    assert.deepEqual(await applyMigrations(pool, { dir: directory }), [
      { filename: '001_atomic.sql', status: 'skipped' },
    ]);
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

test('025 bridge accepts real v1 start, object, prepare, finish and restored SQL without canonical drift', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('legacy_writer');
  await applyMigrationsThrough(25);
  const pool = poolForTest();
  try {
    const startedAt = Date.parse('2026-11-25T06:00:00.000Z');
    const shift = shiftStartPayload(
      { id: 'legacy_start', objectId: ids.objectAId, createdAt: startedAt, workShift: 'day' },
      { name: 'Legacy object' },
      { uid: ids.foremanUid, display_name: 'Foreman' },
      startedAt,
    );
    await pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',
      [ids.workspaceId, shift.id, shift],
    );
    let row = (await pool.query(
      `SELECT state,is_active,object_id,object_name_snapshot,work_date::text,shift_type,
              closing_started_at,closing_by_uid,closed_at,closed_by_uid
         FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, shift.id],
    )).rows[0];
    assert.deepEqual(row, {
      state: 'active', is_active: true, object_id: ids.objectAId,
      object_name_snapshot: 'Legacy object', work_date: '2026-11-25', shift_type: 'day',
      closing_started_at: null, closing_by_uid: null, closed_at: null, closed_by_uid: null,
    });

    const changed = { ...shift, objectId: ids.objectBId, objectName: 'Changed object' };
    await pool.query(
      'UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, shift.id, changed],
    );
    row = (await pool.query(
      `SELECT object_id,object_name_snapshot FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, shift.id],
    )).rows[0];
    assert.deepEqual(row, { object_id: ids.objectBId, object_name_snapshot: 'Changed object' });

    const closingStartedAt = startedAt + 3600000;
    const closing = { ...changed, isActive: false, closing: true, closingStartedAt, closingBy: 'Foreman' };
    await pool.query(
      'UPDATE shifts SET is_active=false,payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, shift.id, closing],
    );
    row = (await pool.query(
      `SELECT state,is_active,closing_started_at,closing_by_uid FROM shifts
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, shift.id],
    )).rows[0];
    assert.equal(row.state, 'closing');
    assert.equal(row.is_active, false);
    assert.equal(row.closing_started_at.toISOString(), new Date(closingStartedAt).toISOString());
    assert.equal(row.closing_by_uid, null, 'display name is not an actor uid and must not be guessed');

    const closedAt = closingStartedAt + 3600000;
    const closed = { ...closing, closing: false, closedAt, closedBy: 'Foreman' };
    await pool.query(
      'UPDATE shifts SET is_active=false,payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, shift.id, closed],
    );
    row = (await pool.query(
      `SELECT state,is_active,closed_at,closed_by_uid FROM shifts
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, shift.id],
    )).rows[0];
    assert.equal(row.state, 'closed');
    assert.equal(row.is_active, false);
    assert.equal(row.closed_at.toISOString(), new Date(closedAt).toISOString());
    assert.equal(row.closed_by_uid, null);

    const restored = restoredLine({
      objectId: ids.objectAId, objectName: 'Restored object', date: '24.11.2026',
      logs: [], activeLineIds: [], ttnStatus: {},
    }, { id: 'legacy_restore' }, { uid: ids.adminUid, display_name: 'Admin' }, startedAt).shift;
    await pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',
      [ids.workspaceId, restored.id, restored],
    );
    row = (await pool.query(
      `SELECT state,is_active,object_id,work_date::text,shift_type FROM shifts
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, restored.id],
    )).rows[0];
    assert.deepEqual(row, {
      state: 'active', is_active: true, object_id: ids.objectAId,
      work_date: '2026-11-24', shift_type: 'day',
    });
  } finally {
    await pool.end();
  }
});

test('025 rejects a normalized object change after the first confirmed line event', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('normalized_lock');
  const pool = poolForTest();
  try {
    await pool.query(
      `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload)
       VALUES($1,$2,$3,$4)`,
      [ids.workspaceId, ids.truckId, ids.shiftAId, {
        id: ids.truckId, shiftId: ids.shiftAId, arriveStatus: '09:16', arriveTimestamp: 1795465000000,
      }],
    );
    await applyMigrationsThrough(25);
    await assert.rejects(
      pool.query(
        `UPDATE shifts
            SET object_id=$3,object_name_snapshot='Bypassed object',
                payload=jsonb_set(jsonb_set(payload,'{objectId}',to_jsonb($3::text)),
                                  '{objectName}',to_jsonb('Bypassed object'::text))
          WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, ids.shiftAId, ids.objectBId],
      ),
      error => error.code === '23514',
    );
    await pool.query(
      `UPDATE shifts SET object_id=object_id,object_name_snapshot=object_name_snapshot,payload=payload
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    );
  } finally {
    await pool.end();
  }
});

test('025 requires universal v1 start aliases to match normalized columns', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('complete_payload');
  await applyMigrationsThrough(25);
  const pool = poolForTest();
  try {
    const openedAt = 1795680000000;
    const basePayload = {
      objectId: ids.objectBId, objectName: 'Snapshot required', startDate: '26.11.2026',
      startedAt: openedAt, startedByUid: ids.adminUid, isActive: true, workShift: 'day',
    };
    const cases = [
      ['missing_started_at', ({ startedAt, ...payload }) => payload],
      ['wrong_started_at', payload => ({ ...payload, startedAt: openedAt + 1 })],
      ['missing_started_by_uid', ({ startedByUid, ...payload }) => payload],
      ['wrong_started_by_uid', payload => ({ ...payload, startedByUid: ids.foremanUid })],
    ];
    for (const [suffix, mutate] of cases) {
      const shiftId = `normalized_${suffix}`;
      const payload = mutate({ ...basePayload, id: shiftId });
      await assert.rejects(
        pool.query(
          `INSERT INTO shifts(
             workspace_id,shift_id,is_active,payload,state,object_id,object_name_snapshot,
             work_date,shift_type,opened_at,opened_by_uid,revision
           ) VALUES($1,$2,true,$3,'active',$4,'Snapshot required','2026-11-26','day',
                    to_timestamp($5 / 1000.0),$6,1)`,
          [ids.workspaceId, shiftId, payload, ids.objectBId, openedAt, ids.adminUid],
        ),
        error => error.code === '23514',
        suffix,
      );
    }
  } finally {
    await pool.end();
  }
});

test('025 backfills the exact earliest confirmed event within workspace and shift', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('event_scope');
  const other = await seedParallelShiftFixture({
    suffix: 'event_scope_other',
    shiftAId: ids.shiftAId,
  });
  const pool = poolForTest();
  try {
    const earliest = 1795464100000;
    const later = earliest + 1000;
    const otherShiftEarlier = earliest - 1000;
    const otherWorkspaceEarlier = earliest - 2000;
    const trucks = ['event_scope_arrive', 'event_scope_load', 'event_scope_other_shift'];
    for (const truckId of trucks) {
      await pool.query(
        `INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)`,
        [ids.workspaceId, truckId, { id: truckId }],
      );
    }
    await pool.query(
      `INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES
       ($1,$2,$3,$4,$5),($1,$6,$3,$7,$8),($1,$9,$10,$11,$12),($13,$14,$3,$15,$16)`,
      [ids.workspaceId, 'event_scope_log_later', ids.shiftAId, trucks[0],
        { id: 'event_scope_log_later', shiftId: ids.shiftAId, truckId: trucks[0], timestamp: later },
        'event_scope_log_earliest', trucks[1],
        { id: 'event_scope_log_earliest', shiftId: ids.shiftAId, truckId: trucks[1], timestamp: earliest },
        'event_scope_log_other_shift', ids.shiftBId, trucks[2],
        { id: 'event_scope_log_other_shift', shiftId: ids.shiftBId, truckId: trucks[2], timestamp: otherShiftEarlier },
        other.workspaceId, 'event_scope_log_other_workspace', other.truckId,
        { id: 'event_scope_log_other_workspace', shiftId: ids.shiftAId, truckId: other.truckId, timestamp: otherWorkspaceEarlier }],
    );
    await pool.query(
      `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES
       ($1,$2,$5,$6),($1,$3,$5,$7),($1,$4,$8,$9)`,
      [ids.workspaceId, ...trucks, ids.shiftAId,
        { id: trucks[0], shiftId: ids.shiftAId, arriveStatus: '09:00', arriveTimestamp: later + 1000 },
        { id: trucks[1], shiftId: ids.shiftAId, lastLoadLogId: 'event_scope_log_earliest', lastLoadTimestamp: later + 2000 },
        ids.shiftBId,
        { id: trucks[2], shiftId: ids.shiftBId, arriveStatus: '08:00', arriveTimestamp: otherShiftEarlier }],
    );
    await applyMigrationsThrough(25);
    const locks = await pool.query(
      `SELECT workspace_id,shift_id,object_locked_at FROM shifts
        WHERE (workspace_id=$1 AND shift_id IN ($2,$3)) OR (workspace_id=$4 AND shift_id=$2)
        ORDER BY workspace_id,shift_id`,
      [ids.workspaceId, ids.shiftAId, ids.shiftBId, other.workspaceId],
    );
    const target = locks.rows.find(row => row.workspace_id === ids.workspaceId && row.shift_id === ids.shiftAId);
    assert.equal(target.object_locked_at.toISOString(), new Date(earliest).toISOString());
    assert.equal(
      locks.rows.find(row => row.workspace_id === ids.workspaceId && row.shift_id === ids.shiftBId).object_locked_at.toISOString(),
      new Date(otherShiftEarlier).toISOString(),
    );
    assert.equal(
      locks.rows.find(row => row.workspace_id === other.workspaceId && row.shift_id === ids.shiftAId).object_locked_at.toISOString(),
      new Date(otherWorkspaceEarlier).toISOString(),
    );
  } finally {
    await pool.end();
  }
});

test('025 backfills canonical shift fields and installs the exact core schema', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('core_good');
  const pool = poolForTest(4);
  try {
    await pool.query(
      `UPDATE shifts SET payload=payload || '{"closing":true,"isActive":false}'::jsonb,is_active=false
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftBId],
    );
    const closedShiftId = 'shift_closed_core_good';
    const restoredShiftId = 'shift_restored_core_good';
    await pool.query(
      `INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES
       ($1,$2,false,$3),($1,$4,true,$5)`,
      [ids.workspaceId, closedShiftId, {
        id: closedShiftId, objectId: ids.objectBId, objectName: 'Closed snapshot',
        startDate: '22.11.2026', startedAt: 1795334400000, startedByUid: ids.adminUid,
        isActive: false, workShift: 'day', closedAt: 1795341600000, closedByUid: ids.adminUid,
      }, restoredShiftId, {
        id: restoredShiftId, objectId: ids.objectBId, objectName: 'Restored snapshot',
        startDate: '21.11.2026', startedAt: 1795240800000, startedByUid: ids.foremanUid,
        isActive: true, restored: true, restoredFrom: 'archive_core_good',
      }],
    );
    await pool.query(
      `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload)
       VALUES($1,$2,$3,$4)`,
      [ids.workspaceId, ids.truckId, ids.shiftAId, {
        id: ids.truckId, shiftId: ids.shiftAId,
        arriveTimestamp: 1795464000000, arriveStatus: null,
        lastLoadTimestamp: 1795464001000, lastLoadLogId: null,
      }],
    );
    const lockedTruckId = 'locked_truck_core_good';
    await pool.query(
      `INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)`,
      [ids.workspaceId, lockedTruckId, { id: lockedTruckId }],
    );
    await pool.query(
      `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload)
       VALUES($1,$2,$3,$4)`,
      [ids.workspaceId, lockedTruckId, ids.shiftBId, {
        id: lockedTruckId, shiftId: ids.shiftBId, arriveStatus: '09:16', arriveTimestamp: 1795465000000,
      }],
    );
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
      state: ['text', 'YES'],
      object_id: ['text', 'YES'],
      object_name_snapshot: ['text', 'YES'],
      work_date: ['date', 'YES'],
      shift_type: ['text', 'YES'],
      opened_at: ['timestamp with time zone', 'YES'],
      opened_by_uid: ['text', 'YES'],
      object_locked_at: ['timestamp with time zone', 'YES'],
      object_locked_by_operation_id: ['text', 'YES'],
      closing_started_at: ['timestamp with time zone', 'YES'],
      closing_by_uid: ['text', 'YES'],
      closed_at: ['timestamp with time zone', 'YES'],
      closed_by_uid: ['text', 'YES'],
      revision: ['bigint', 'NO'],
      replica_placeholder: ['boolean', 'NO'],
    };
    for (const [name, [type, nullable]] of Object.entries(expectedShiftColumns)) {
      assert.equal(shiftColumns.get(name)?.data_type, type, `shifts.${name} type`);
      assert.equal(shiftColumns.get(name)?.is_nullable, nullable, `shifts.${name} nullability`);
    }
    assert.match(shiftColumns.get('revision').column_default, /1/);
    assert.equal(shiftColumns.get('is_active').data_type, 'boolean');

    const shifts = await pool.query(
      `SELECT shift_id,state,object_id,object_name_snapshot,work_date::text AS work_date,
              shift_type,opened_at,opened_by_uid,object_locked_at,closing_started_at,
              closing_by_uid,closed_at,closed_by_uid,revision,is_active
         FROM shifts WHERE workspace_id=$1 ORDER BY shift_id`,
      [ids.workspaceId],
    );
    assert.deepEqual(shifts.rows.filter(row => [ids.shiftAId, ids.shiftBId].includes(row.shift_id)).map(row => ({
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
      { shiftId: ids.shiftBId, state: 'closing', objectId: ids.objectAId, workDate: '2026-11-23', shiftType: 'night', actor: ids.foremanUid, revision: '1', active: false },
    ]);
    assert.ok(shifts.rows.every(row => row.opened_at instanceof Date));
    assert.equal(shifts.rows[0].object_locked_at, null, 'null status markers do not lock object');
    assert.ok(shifts.rows[1].object_locked_at instanceof Date, 'non-null confirmed status marker locks object');
    assert.equal(
      shifts.rows[1].object_locked_at.toISOString(),
      new Date(1795465000000).toISOString(),
      'lock time comes from the earliest confirmed line event, never shift start',
    );
    assert.equal(shifts.rows[1].closing_started_at, null, 'missing closing time stays unknown');
    assert.equal(shifts.rows.find(row => row.shift_id === ids.shiftBId).closing_by_uid, null, 'missing closing actor stays unknown');
    const closedBackfill = shifts.rows.find(row => row.shift_id === closedShiftId);
    assert.equal(closedBackfill.state, 'closed');
    assert.equal(closedBackfill.closed_at.toISOString(), new Date(1795341600000).toISOString());
    assert.equal(closedBackfill.closed_by_uid, ids.adminUid);
    const restoredBackfill = shifts.rows.find(row => row.shift_id === restoredShiftId);
    assert.equal(restoredBackfill.state, 'active');
    assert.equal(restoredBackfill.shift_type, 'day', 'missing legacy type uses unambiguous Moscow hour fallback');

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
    await assert.rejects(
      pool.query(
        `UPDATE shifts SET is_active=false WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, ids.shiftAId],
      ),
      error => error.code === '23514',
    );
    await pool.query(
      `UPDATE shifts SET state='closing',is_active=false,
              payload=jsonb_set(jsonb_set(payload,'{closing}','true'::jsonb),'{isActive}','false'::jsonb)
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    );
    assert.deepEqual((await pool.query(
      `SELECT state,is_active FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    )).rows[0], { state: 'closing', is_active: false });
    await pool.query(
      `UPDATE shifts SET state='active',is_active=true,
              payload=jsonb_set(jsonb_set(payload,'{closing}','false'::jsonb),'{isActive}','true'::jsonb)
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    );
    await assert.rejects(
      pool.query(`UPDATE shifts SET state='unknown' WHERE workspace_id=$1 AND shift_id=$2`, [ids.workspaceId, ids.shiftAId]),
      error => error.code === '23514',
    );
    await assert.rejects(
      pool.query(
        `UPDATE shifts SET payload=jsonb_set(payload,'{objectId}',to_jsonb($3::text))
          WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, ids.shiftBId, ids.objectBId],
      ),
      error => error.code === '23514',
    );
    await assert.rejects(
      pool.query(
        `UPDATE shifts SET payload=jsonb_set(payload,'{date}','"2099-01-01"'::jsonb)
          WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, ids.shiftAId],
      ),
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
      pool.query(`DELETE FROM shifts WHERE workspace_id=$1 AND shift_id=$2`, [ids.workspaceId, ids.shiftAId]),
      error => error.code === '23503',
    );
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

    const duplicateTruckId = 'duplicate_truck_core_good';
    await pool.query(
      `INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)`,
      [ids.workspaceId, duplicateTruckId, { id: duplicateTruckId }],
    );
    await pool.query(
      `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload)
       VALUES($1,$2,$3,$4)`,
      [ids.workspaceId, duplicateTruckId, ids.shiftAId, { id: duplicateTruckId, shiftId: ids.shiftAId }],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload)
         VALUES($1,$2,$3,$4)`,
        [ids.workspaceId, duplicateTruckId, ids.shiftBId, { id: duplicateTruckId, shiftId: ids.shiftBId }],
      ),
      error => error.code === '23505',
    );
    await assert.rejects(
      pool.query(
        `UPDATE line_truck_statuses SET status_revision=0
          WHERE workspace_id=$1 AND truck_id=$2`,
        [ids.workspaceId, duplicateTruckId],
      ),
      error => error.code === '23514',
    );

    // Two concurrent inserts for the same active canonical key: exactly one commits.
    const duplicateIdA = 'duplicate_a_core_good';
    const duplicateIdB = 'duplicate_b_core_good';
    const duplicateStartedAt = Date.parse('2026-11-24T09:00:00.000Z');
    const insertDuplicate = async (client, shiftId) => client.query(
      `INSERT INTO shifts(
         workspace_id,shift_id,is_active,payload,state,object_id,object_name_snapshot,
         work_date,shift_type,opened_at,opened_by_uid,revision
       ) VALUES($1,$2,true,$3,'active',$4,$5,'2026-11-24','day',to_timestamp($6 / 1000.0),$7,1)`,
      [ids.workspaceId, shiftId, {
        id: shiftId, objectId: ids.objectBId, objectName: ids.objectBId,
        startDate: '24.11.2026', startedAt: duplicateStartedAt, startedByUid: ids.adminUid,
        workShift: 'day', isActive: true,
      }, ids.objectBId, ids.objectBId, duplicateStartedAt, ids.adminUid],
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

    const inactivePayload = {
      id: 'inactive_duplicate_core_good', objectId: ids.objectBId, objectName: ids.objectBId,
      startDate: '24.11.2026', startedAt: 1795507200000, startedByUid: ids.adminUid,
      isActive: false, workShift: 'day', closing: false,
    };
    for (const shiftId of ['inactive_duplicate_a', 'inactive_duplicate_b']) {
      await pool.query(
        `INSERT INTO shifts(workspace_id,shift_id,is_active,payload)
         VALUES($1,$2,false,$3 || jsonb_build_object('id',$2::text))`,
        [ids.workspaceId, shiftId, inactivePayload],
      );
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

test('025 preserves a real load then reset by resolving lastLoadLogId to its same-shift log', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('load_reset');
  const pool = poolForTest();
  try {
    const arrived = {
      id: ids.truckId, shiftId: ids.shiftAId, onLine: true, cycleRevision: 1, ttnRevision: 1,
      arriveStatus: '09:00', arriveTimestamp: 1795464000000, lastLoadTimestamp: null,
    };
    const actor = { name: 'Admin', email: 'admin@example.test', isAdmin: true, canResetTimer: true };
    const load = applyLineOperation({
      op: { id: 'load_reset_load', type: 'load', shiftId: ids.shiftAId, truckId: ids.truckId,
        createdAt: 1795465000000, expectedRevision: 1, expectedTtnRevision: 1,
        arrivalTimestamp: 1795464000000, lastLoadTimestamp: 0, wantArrived: false, collect: false, cycleMinutes: 15 },
      before: arrived, truck: { brand: 'Test', number: '1', defaultVol: 24 }, actor, now: 1795465000000,
    });
    const reset = applyLineOperation({
      op: { id: 'load_reset_reset', type: 'reset', shiftId: ids.shiftAId, truckId: ids.truckId,
        createdAt: 1795466000000, expectedRevision: 2, expectedTtnRevision: 1,
        arrivalTimestamp: 0, lastLoadTimestamp: load.status.lastLoadTimestamp,
        wantArrived: false, collect: false, cycleMinutes: 15 },
      before: load.status, truck: {}, actor, now: 1795466000000,
    });
    assert.equal(reset.status.lastLoadTimestamp, null);
    assert.equal(reset.status.lastLoadLogId, load.log.id);
    assert.equal(reset.status.lastResetOperationId, 'load_reset_reset');
    await pool.query(
      `INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)`,
      [ids.workspaceId, load.log.id, ids.shiftAId, ids.truckId, load.log],
    );
    await pool.query(
      `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES($1,$2,$3,$4)`,
      [ids.workspaceId, ids.truckId, ids.shiftAId, reset.status],
    );
    await applyMigrationsThrough(25);
    const lockedAt = (await pool.query(
      `SELECT object_locked_at FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    )).rows[0].object_locked_at;
    assert.equal(lockedAt.toISOString(), new Date(load.log.timestamp).toISOString());
  } finally {
    await pool.end();
  }
});

expectUnsafeLegacyFixtureRejected('025 rejects a reset load marker without a matching same-shift log', async (pool, ids) => {
  await pool.query(
    `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES($1,$2,$3,$4)`,
    [ids.workspaceId, ids.truckId, ids.shiftAId, {
      id: ids.truckId, shiftId: ids.shiftAId, lastLoadTimestamp: null,
      lastLoadLogId: 'missing_load', lastResetOperationId: 'reset_missing_load',
    }],
  );
});

for (const [label, timestamp, rejected] of [
  ['lower bound', 946684800000, false],
  ['upper bound minus one', 4102444799999, false],
  ['below lower bound', 946684799999, true],
  ['upper bound', 4102444800000, true],
  ['decimal', 1795465000000.5, true],
  ['huge integer', 999999999999999999999, true],
]) {
  const name = `025 ${rejected ? 'rejects' : 'accepts'} confirmed log timestamp at ${label}`;
  if (rejected) {
    expectUnsafeLegacyFixtureRejected(name, async (pool, ids) => {
      await pool.query(
        `INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)`,
        [ids.workspaceId, `bound_${label.replaceAll(' ', '_')}`, ids.shiftAId, ids.truckId, { timestamp }],
      );
    });
  } else {
    test(name, { skip: !approved }, async () => {
      const ids = await prepareLegacyFixture(`bound_${label.replaceAll(' ', '_')}`);
      const pool = poolForTest();
      try {
        await pool.query(
          `INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)`,
          [ids.workspaceId, `bound_${label.replaceAll(' ', '_')}`, ids.shiftAId, ids.truckId, { timestamp }],
        );
        await applyMigrationsThrough(25);
        assert.equal((await pool.query(
          `SELECT object_locked_at FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
          [ids.workspaceId, ids.shiftAId],
        )).rows[0].object_locked_at.toISOString(), new Date(timestamp).toISOString());
      } finally { await pool.end(); }
    });
  }
}

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

expectUnsafeLegacyFixtureRejected('025 rejects conflicting legacy shift type aliases', async (pool, ids) => {
  await pool.query(
    `UPDATE shifts SET payload=jsonb_set(payload,'{type}','"night"'::jsonb)
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

expectUnsafeLegacyFixtureRejected('025 rejects confirmed line activity with a missing timestamp', async (pool, ids) => {
  await pool.query(
    `INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload)
     VALUES($1,'missing_timestamp',$2,$3,$4)`,
    [ids.workspaceId, ids.shiftAId, ids.truckId, {
      id: 'missing_timestamp', shiftId: ids.shiftAId, truckId: ids.truckId, volume: 24,
    }],
  );
});

expectUnsafeLegacyFixtureRejected('025 rejects confirmed arrival activity with a missing timestamp', async (pool, ids) => {
  await pool.query(
    `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload)
     VALUES($1,$2,$3,$4)`,
    [ids.workspaceId, ids.truckId, ids.shiftAId, {
      id: ids.truckId, shiftId: ids.shiftAId, arriveStatus: '09:00',
    }],
  );
});

expectUnsafeLegacyFixtureRejected('025 rejects confirmed load activity with a missing timestamp', async (pool, ids) => {
  await pool.query(
    `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload)
     VALUES($1,$2,$3,$4)`,
    [ids.workspaceId, ids.truckId, ids.shiftAId, {
      id: ids.truckId, shiftId: ids.shiftAId, lastLoadLogId: 'missing_timestamp_load',
    }],
  );
});

expectUnsafeLegacyFixtureRejected('025 rejects a wrong-type reset load timestamp instead of masking it with the referenced log', async (pool, ids) => {
  const logId = 'wrong_type_reset_load';
  await pool.query(
    `INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)`,
    [ids.workspaceId, logId, ids.shiftAId, ids.truckId, { timestamp: 1795465000000 }],
  );
  await pool.query(
    `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES($1,$2,$3,$4)`,
    [ids.workspaceId, ids.truckId, ids.shiftAId, {
      id: ids.truckId, shiftId: ids.shiftAId, lastLoadTimestamp: 'bad',
      lastLoadLogId: logId, lastResetOperationId: 'reset_wrong_type_load',
    }],
  );
});

expectUnsafeLegacyFixtureRejected('025 rejects confirmed arrival activity with a wrong-type timestamp', async (pool, ids) => {
  await pool.query(
    `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload)
     VALUES($1,$2,$3,$4)`,
    [ids.workspaceId, ids.truckId, ids.shiftAId, {
      id: ids.truckId, shiftId: ids.shiftAId, arriveStatus: '09:00', arriveTimestamp: '1795465000000',
    }],
  );
});

expectUnsafeLegacyFixtureRejected('025 rejects confirmed load activity with an out-of-range timestamp', async (pool, ids) => {
  await pool.query(
    `INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload)
     VALUES($1,$2,$3,$4)`,
    [ids.workspaceId, ids.truckId, ids.shiftAId, {
      id: ids.truckId, shiftId: ids.shiftAId, lastLoadLogId: 'future_load', lastLoadTimestamp: 4102444800000,
    }],
  );
});
