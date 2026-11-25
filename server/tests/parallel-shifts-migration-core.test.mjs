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

test('published_v2_night_golden_is_exact', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('legacy_writer');
  await applyMigrationsThrough(25);
  const pool = poolForTest();
  try {
    // Exact golden from the design: 1795453200000 is 2026-11-23T20:00:00+03:00.
    const startedAt = 1795453200000;
    const golden = shiftStartPayload(
      { id: 'golden_night', objectId: ids.objectAId, createdAt: startedAt, workShift: 'night' },
      { name: 'Golden object' },
      { uid: ids.foremanUid, display_name: 'Foreman Night' },
      startedAt,
    );
    assert.deepEqual(Object.keys(golden).sort(), [
      'date', 'id', 'isActive', 'objectId', 'objectName', 'payloadSchemaVersion',
      'shiftId', 'startDate', 'startedAt', 'startedBy', 'startedByUid', 'state',
      'type', 'workShift',
    ]);
    await pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',
      [ids.workspaceId, golden.id, golden],
    );
    let row = (await pool.query(
      `SELECT state,is_active,object_id,object_name_snapshot,work_date::text AS work_date,
              shift_type,opened_at,opened_by_uid,opened_by_name_snapshot,
              payload_schema_version::int AS payload_schema_version,
              identity_resolution,shift_type_resolution,payload
         FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, golden.id],
    )).rows[0];
    assert.deepEqual(row, {
      state: 'active', is_active: true, object_id: ids.objectAId,
      object_name_snapshot: 'Golden object', work_date: '2026-11-23', shift_type: 'night',
      opened_at: new Date(startedAt), opened_by_uid: ids.foremanUid,
      opened_by_name_snapshot: 'Foreman Night', payload_schema_version: 2,
      identity_resolution: 'source', shift_type_resolution: 'source', payload: golden,
    });

    const rejectsV2 = (label, payload, pattern = /invalid-shift-v2-provenance/) => assert.rejects(
      pool.query(
        'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',
        [ids.workspaceId, payload.id, payload],
      ),
      error => error.code === '23514' && pattern.test(error.message),
      label,
    );
    const rejectsDrift = (label, sql, params) => assert.rejects(
      pool.query(sql, params),
      error => error.code === '23514' && /shift canonical payload mismatch/.test(error.message),
      label,
    );
    // An INSERT that also supplies contradictory canonical columns is drift: the
    // document is the only source of truth (review Major 1/3, design §4.1).
    await rejectsDrift('insert state drift',
      'INSERT INTO shifts(workspace_id,shift_id,state,is_active,payload) VALUES($1,$2,$3,$4,$5)',
      [ids.workspaceId, 'golden_insert_state', 'closed', true,
        { ...golden, id: 'golden_insert_state', shiftId: 'golden_insert_state' }]);
    await rejectsDrift('insert object drift',
      'INSERT INTO shifts(workspace_id,shift_id,object_id,is_active,payload) VALUES($1,$2,$3,true,$4)',
      [ids.workspaceId, 'golden_insert_object', ids.objectBId,
        { ...golden, id: 'golden_insert_object', shiftId: 'golden_insert_object' }]);
    await rejectsDrift('insert work date drift',
      'INSERT INTO shifts(workspace_id,shift_id,work_date,is_active,payload) VALUES($1,$2,$3,true,$4)',
      [ids.workspaceId, 'golden_insert_date', '2026-11-24',
        { ...golden, id: 'golden_insert_date', shiftId: 'golden_insert_date' }]);
    await rejectsDrift('insert opened_by_uid drift',
      'INSERT INTO shifts(workspace_id,shift_id,opened_by_uid,identity_resolution,is_active,payload) VALUES($1,$2,$3,$4,true,$5)',
      [ids.workspaceId, 'golden_insert_uid', ids.adminUid, 'source',
        { ...golden, id: 'golden_insert_uid', shiftId: 'golden_insert_uid' }]);
    await rejectsDrift('insert is_active drift (document active, column false)',
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,false,$3)',
      [ids.workspaceId, 'golden_insert_active', { ...golden, id: 'golden_insert_active', shiftId: 'golden_insert_active' }]);
    const { state, ...missingState } = golden;
    await rejectsV2('missing key', { ...missingState, id: 'golden_missing_state', shiftId: 'golden_missing_state' });
    await rejectsV2('restore alias', { ...golden, id: 'golden_restored', shiftId: 'golden_restored', restored: true });
    await rejectsV2('forged type alias', { ...golden, id: 'golden_forged', shiftId: 'golden_forged', type: 'day' });
    await rejectsV2('date drift', { ...golden, id: 'golden_date', shiftId: 'golden_date', startedAt: startedAt + 86400000 });
    await rejectsV2('malformed state alias', { ...golden, id: 'golden_state', shiftId: 'golden_state', state: 'soaking' });
    // The exact legacy v1 document and the old restored writer are not writable.
    await rejectsV2('legacy v1 document', {
      id: 'legacy_v1_doc', objectId: ids.objectBId, objectName: 'Legacy object',
      startDate: '19.11.2026', startedAt: Date.parse('2026-11-19T06:00:00Z'),
      startedBy: 'Foreman', isActive: true,
    }, /protocol-upgrade-required/);
    const restored = restoredLine({
      objectId: ids.objectAId, objectName: 'Restored object', date: '24.11.2026',
      logs: [], activeLineIds: [], ttnStatus: {},
    }, { id: 'legacy_restore' }, { uid: ids.adminUid, display_name: 'Admin' }, startedAt).shift;
    await assert.rejects(
      pool.query(
        'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',
        [ids.workspaceId, restored.id, restored],
      ),
      error => error.code === '23514' && /protocol-upgrade-required/.test(error.message),
    );

    // A canonical object change still comes from the payload document.
    const dayStartedAt = Date.parse('2026-11-24T06:00:00Z');
    const displayShift = shiftStartPayload(
      { id: 'display_close', objectId: ids.objectBId, createdAt: dayStartedAt, workShift: 'day' },
      { name: 'Display object' },
      { uid: ids.adminUid, display_name: 'Admin' },
      dayStartedAt,
    );
    await pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',
      [ids.workspaceId, displayShift.id, displayShift],
    );
    await pool.query(
      'UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, displayShift.id, { ...displayShift, objectId: ids.objectAId, objectName: 'Moved object' }],
    );
    row = (await pool.query(
      `SELECT object_id,object_name_snapshot FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, displayShift.id],
    )).rows[0];
    assert.deepEqual(row, { object_id: ids.objectAId, object_name_snapshot: 'Moved object' });

    // D2: a close proven only by a display name is historical, never a normal close.
    const displayClosed = {
      ...displayShift, objectId: ids.objectAId, objectName: 'Moved object',
      isActive: false, closedAt: dayStartedAt + 3600000, closedBy: 'Admin',
    };
    await pool.query(
      'UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, displayShift.id, displayClosed],
    );
    row = (await pool.query(
      `SELECT state,is_active,closed_at,closed_by_uid,closing_started_at,closing_by_uid
         FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, displayShift.id],
    )).rows[0];
    assert.deepEqual(row, {
      state: 'historical', is_active: false, closed_at: null, closed_by_uid: null,
      closing_started_at: null, closing_by_uid: null,
    });

    // D1: closing occupies a line; D2: a proved closer keeps a normal close.
    const closingStartedAt = startedAt + 3600000;
    const closing = {
      ...golden, isActive: false, closing: true, state: 'closing',
      closingStartedAt, closingBy: 'Foreman Night',
    };
    await pool.query(
      'UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, golden.id, closing],
    );
    row = (await pool.query(
      `SELECT state,is_active,closing_started_at,closing_by_uid FROM shifts
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, golden.id],
    )).rows[0];
    assert.equal(row.state, 'closing');
    assert.equal(row.is_active, true, 'design §4.1: closing still occupies a line');
    assert.equal(row.closing_started_at.toISOString(), new Date(closingStartedAt).toISOString());
    assert.equal(row.closing_by_uid, null, 'display name is not an actor uid and must not be guessed');

    const closedAt = closingStartedAt + 3600000;
    const closed = {
      ...closing, closing: false, state: 'closed',
      closedAt, closedBy: 'Foreman Night', closedByUid: ids.foremanUid,
    };
    await pool.query(
      'UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, golden.id, closed],
    );
    row = (await pool.query(
      `SELECT state,is_active,closed_at,closed_by_uid FROM shifts
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, golden.id],
    )).rows[0];
    assert.equal(row.state, 'closed');
    assert.equal(row.is_active, false);
    assert.equal(row.closed_at.toISOString(), new Date(closedAt).toISOString());
    assert.equal(row.closed_by_uid, ids.foremanUid);

    // A strict v2 row cannot be demoted to unresolved provenance by a bare update.
    await assert.rejects(
      pool.query(
        `UPDATE shifts SET identity_resolution='unresolved'
          WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, golden.id],
      ),
      error => error.code === '23514',
    );
  } finally {
    await pool.end();
  }
});

test('legacy_resolution_dimensions_are_independent', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('resolution_dims');
  const pool = poolForTest();
  try {
    const startedAt = Date.parse('2026-11-19T06:00:00Z'); // 09:00 Europe/Moscow
    const legacyRows = [
      ['resolution_identity_only', { startedBy: 'Only Identity', startedByUid: ids.foremanUid, isActive: true }],
      ['resolution_type_only', { startedBy: 'Only Type', isActive: true, workShift: 'night' }],
      ['resolution_neither', { isActive: true }],
      ['resolution_unknown_uid', { startedBy: 'Ghost User', startedByUid: 'ghost_user', isActive: true, workShift: 'day' }],
      ['resolution_closed_unresolved', {
        startedBy: 'Closed Legacy', startedByUid: ids.adminUid, isActive: false,
        closedAt: 1795334400000, closedByUid: ids.adminUid,
      }],
    ];
    for (const [shiftId, extra] of legacyRows) {
      await pool.query(
        `INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,$3,$4)`,
        [ids.workspaceId, shiftId, extra.isActive, {
          id: shiftId, objectId: ids.objectAId, objectName: 'Dimensions',
          startDate: '19.11.2026', startedAt, ...extra,
        }],
      );
    }
    await applyMigrationsThrough(25);
    const rows = (await pool.query(
      `SELECT shift_id,state,is_active,shift_type,shift_type_resolution,
              opened_by_uid,identity_resolution,opened_by_name_snapshot
         FROM shifts WHERE workspace_id=$1 AND shift_id LIKE 'resolution_%'
        ORDER BY shift_id`,
      [ids.workspaceId],
    )).rows;
    assert.deepEqual(rows, [
      {
        shift_id: 'resolution_closed_unresolved', state: 'closed', is_active: false,
        shift_type: null, shift_type_resolution: 'unresolved',
        opened_by_uid: ids.adminUid, identity_resolution: 'source',
        opened_by_name_snapshot: 'Closed Legacy',
      },
      {
        shift_id: 'resolution_identity_only', state: 'historical', is_active: false,
        shift_type: null, shift_type_resolution: 'unresolved',
        opened_by_uid: ids.foremanUid, identity_resolution: 'source',
        opened_by_name_snapshot: 'Only Identity',
      },
      {
        shift_id: 'resolution_neither', state: 'historical', is_active: false,
        shift_type: null, shift_type_resolution: 'unresolved',
        opened_by_uid: null, identity_resolution: 'unresolved',
        opened_by_name_snapshot: '<unresolved>',
      },
      {
        shift_id: 'resolution_type_only', state: 'active', is_active: true,
        shift_type: 'night', shift_type_resolution: 'source',
        opened_by_uid: null, identity_resolution: 'unresolved',
        opened_by_name_snapshot: 'Only Type',
      },
      {
        shift_id: 'resolution_unknown_uid', state: 'active', is_active: true,
        shift_type: 'day', shift_type_resolution: 'source',
        opened_by_uid: null, identity_resolution: 'unresolved',
        opened_by_name_snapshot: 'Ghost User',
      },
    ]);
    assert.equal((await pool.query(
      `SELECT count(*)::int AS n FROM shifts
        WHERE identity_resolution='inferred' OR shift_type_resolution='inferred'`,
    )).rows[0].n, 0, 'no automatic heuristic may be recorded as resolution');
    const closed = (await pool.query(
      `SELECT closed_at,closed_by_uid FROM shifts
        WHERE workspace_id=$1 AND shift_id='resolution_closed_unresolved'`,
      [ids.workspaceId],
    )).rows[0];
    assert.equal(closed.closed_at.toISOString(), new Date(1795334400000).toISOString());
    assert.equal(closed.closed_by_uid, ids.adminUid);
  } finally {
    await pool.end();
  }
});

// A legacy row keeps its own provenance: a v2 document must never promote it
// (design §4.1). The v2 documents below come from shiftStartPayload, so the
// date/startDate/type alignment is the production one, not hand-written.
function promoDocument(opId, objectId, adminUid) {
  const startedAt = Date.parse('2026-11-25T06:00:00Z'); // 09:00 Europe/Moscow
  return shiftStartPayload(
    { id: opId, objectId, createdAt: startedAt, workShift: 'day' },
    { name: 'Promo object' },
    { uid: adminUid, display_name: 'Admin' },
    startedAt,
  );
}

test('025 legacy historical row with unresolved provenance is not promoted by a v2 payload', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('promo_hist');
  const pool = poolForTest();
  try {
    await pool.query(
      `INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,false,$3)`,
      [ids.workspaceId, 'shift_promo_hist', {
        id: 'shift_promo_hist', objectId: ids.objectAId, objectName: 'Promo legacy',
        startDate: '18.11.2026', startedAt: Date.parse('2026-11-18T06:00:00Z'),
        startedBy: 'Legacy Person', isActive: false,
      }],
    );
    await applyMigrationsThrough(25);
    const before = (await pool.query(
      `SELECT state,payload_schema_version::int AS psv,identity_resolution,shift_type_resolution,opened_by_uid,shift_type
         FROM shifts WHERE workspace_id=$1 AND shift_id='shift_promo_hist'`,
      [ids.workspaceId],
    )).rows[0];
    assert.deepEqual(before, {
      state: 'historical', psv: 1, identity_resolution: 'unresolved',
      shift_type_resolution: 'unresolved', opened_by_uid: null, shift_type: null,
    });

    const doc = promoDocument('promo_hist', ids.objectBId, ids.adminUid);
    await assert.rejects(
      pool.query(
        `UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, 'shift_promo_hist', doc],
      ),
      error => error.code === '23514'
        && /invalid-shift-v2-provenance: a legacy row is never promoted to strict v2/.test(error.message),
    );
    assert.deepEqual((await pool.query(
      `SELECT state,payload_schema_version::int AS psv,identity_resolution,shift_type_resolution,opened_by_uid,shift_type
         FROM shifts WHERE workspace_id=$1 AND shift_id='shift_promo_hist'`,
      [ids.workspaceId],
    )).rows[0], before, 'a rejected promotion must leave the row untouched');
  } finally {
    await pool.end();
  }
});

test('025 live legacy row is not promoted to strict v2 by a v2 payload', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('promo_live');
  await applyMigrationsThrough(25);
  const pool = poolForTest();
  try {
    const doc = promoDocument('a_promo_live', ids.objectBId, ids.adminUid);
    assert.equal(doc.id, ids.shiftAId, 'the document must address the legacy live row');
    await assert.rejects(
      pool.query(
        `UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, ids.shiftAId, doc],
      ),
      error => error.code === '23514'
        && /invalid-shift-v2-provenance: a legacy row is never promoted to strict v2/.test(error.message),
    );
    assert.deepEqual((await pool.query(
      `SELECT state,is_active,payload_schema_version::int AS psv,identity_resolution FROM shifts
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    )).rows[0], { state: 'active', is_active: true, psv: 1, identity_resolution: 'source' });
  } finally {
    await pool.end();
  }
});

test('025 manual column resolution of a legacy row stays legal without a v2 payload', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('promo_manual');
  const pool = poolForTest();
  try {
    await pool.query(
      `INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,false,$3)`,
      [ids.workspaceId, 'shift_promo_manual', {
        id: 'shift_promo_manual', objectId: ids.objectAId, objectName: 'Manual legacy',
        startDate: '18.11.2026', startedAt: Date.parse('2026-11-18T06:00:00Z'),
        startedBy: 'Legacy Person', isActive: false,
      }],
    );
    await applyMigrationsThrough(25);
    const payloadBefore = (await pool.query(
      `SELECT payload FROM shifts WHERE workspace_id=$1 AND shift_id='shift_promo_manual'`,
      [ids.workspaceId],
    )).rows[0].payload;
    await pool.query(
      `UPDATE shifts SET opened_by_uid=$3,identity_resolution='manual',
              shift_type='day',shift_type_resolution='manual'
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, 'shift_promo_manual', ids.adminUid],
    );
    const row = (await pool.query(
      `SELECT state,is_active,payload_schema_version::int AS psv,identity_resolution,
              shift_type_resolution,opened_by_uid,shift_type,payload
         FROM shifts WHERE workspace_id=$1 AND shift_id='shift_promo_manual'`,
      [ids.workspaceId],
    )).rows[0];
    assert.equal(row.psv, 1);
    assert.equal(row.state, 'historical');
    assert.equal(row.is_active, false);
    assert.equal(row.identity_resolution, 'manual');
    assert.equal(row.opened_by_uid, ids.adminUid);
    assert.equal(row.shift_type_resolution, 'manual');
    assert.equal(row.shift_type, 'day');
    assert.deepEqual(row.payload, payloadBefore, 'manual resolution must not touch the payload');
  } finally {
    await pool.end();
  }
});

test('025 strict v2 row still follows its own v2 document after the promotion guard', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('promo_regress');
  await applyMigrationsThrough(25);
  const pool = poolForTest();
  try {
    const live = promoDocument('regress_v2', ids.objectAId, ids.adminUid);
    await pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)',
      [ids.workspaceId, live.id, live],
    );
    const closing = {
      ...live, isActive: false, closing: true, state: 'closing',
      closingStartedAt: live.startedAt + 3600000, closingBy: 'Admin',
    };
    await pool.query(
      'UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, live.id, closing],
    );
    assert.deepEqual((await pool.query(
      `SELECT state,is_active,payload_schema_version::int AS psv FROM shifts
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, live.id],
    )).rows[0], { state: 'closing', is_active: true, psv: 2 });
  } finally {
    await pool.end();
  }
});

test('025 accepts the real v1 close writer payloads with their stale state alias', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('real_writer');
  const pool = poolForTest();
  try {
    const startedAt = Date.parse('2026-11-18T06:00:00Z');
    const base = {
      objectId: ids.objectAId, objectName: 'Real writer object', startDate: '18.11.2026',
      startedAt, startedBy: 'Legacy Person', startedByUid: ids.adminUid, workShift: 'day',
      state: 'active', isActive: true,
    };
    // shift-close.mjs prepare: closing:true, isActive:false, state stays 'active'.
    const prepare = { ...base, id: 'real_prepare', isActive: false, closing: true,
      closingStartedAt: startedAt + 60000, closingBy: 'Admin', closeArchiveId: 'closed_real_prepare' };
    // shift-close.mjs final: closing:false, closedAt, closedBy, no closedByUid, stale state.
    const closed = { ...base, id: 'real_closed', isActive: false, closing: false,
      closedAt: startedAt + 120000, closedBy: 'Admin' };
    for (const [shiftId, doc] of [['real_prepare', prepare], ['real_closed', closed]]) {
      await pool.query(
        'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,$3,$4)',
        [ids.workspaceId, shiftId, doc.isActive, doc],
      );
    }
    await applyMigrationsThrough(25);
    const rows = (await pool.query(
      `SELECT shift_id,state,is_active,closing_started_at,closing_by_uid,closed_at,closed_by_uid
         FROM shifts WHERE workspace_id=$1 AND shift_id IN ('real_prepare','real_closed')
        ORDER BY shift_id`,
      [ids.workspaceId],
    )).rows;
    assert.deepEqual(rows, [
      { shift_id: 'real_closed', state: 'historical', is_active: false,
        closing_started_at: null, closing_by_uid: null, closed_at: null, closed_by_uid: null },
      { shift_id: 'real_prepare', state: 'closing', is_active: true,
        closing_started_at: new Date(startedAt + 60000), closing_by_uid: null,
        closed_at: null, closed_by_uid: null },
    ]);
  } finally {
    await pool.end();
  }
});

expectUnsafeLegacyFixtureRejected('025 rejects a row that carries both closing and closedAt markers', async (pool, ids) => {
  const startedAt = Date.parse('2026-11-18T06:00:00Z');
  await pool.query(
    'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,false,$3)',
    [ids.workspaceId, 'both_markers', {
      id: 'both_markers', objectId: ids.objectAId, objectName: 'Both markers',
      startDate: '18.11.2026', startedAt, startedBy: 'Legacy Person', isActive: false,
      closing: true, closingStartedAt: startedAt + 60000, closingBy: 'Admin',
      closedAt: startedAt + 120000, closedBy: 'Admin',
    }],
  );
});

expectUnsafeLegacyFixtureRejected('025 rejects a closing marker without a numeric closingStartedAt', async (pool, ids) => {
  const startedAt = Date.parse('2026-11-18T06:00:00Z');
  await pool.query(
    'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,false,$3)',
    [ids.workspaceId, 'closing_no_start', {
      id: 'closing_no_start', objectId: ids.objectAId, objectName: 'No start',
      startDate: '18.11.2026', startedAt, startedBy: 'Legacy Person', isActive: false,
      closing: true, closingBy: 'Admin',
    }],
  );
});

expectUnsafeLegacyFixtureRejected('025 rejects a stringly typed closing marker', async (pool, ids) => {
  const startedAt = Date.parse('2026-11-18T06:00:00Z');
  await pool.query(
    'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,false,$3)',
    [ids.workspaceId, 'closing_string', {
      id: 'closing_string', objectId: ids.objectAId, objectName: 'String marker',
      startDate: '18.11.2026', startedAt, startedBy: 'Legacy Person', isActive: false,
      closing: 'true', closingStartedAt: startedAt + 60000, closingBy: 'Admin',
    }],
  );
});

expectUnsafeLegacyFixtureRejected('025 rejects a string payloadSchemaVersion "2" as strict v2', async (pool, ids) => {
  const startedAt = Date.parse('2026-11-25T06:00:00Z');
  const document = shiftStartPayload(
    { id: 'string_psv', objectId: ids.objectAId, createdAt: startedAt, workShift: 'day' },
    { name: 'String psv object' },
    { uid: ids.adminUid, display_name: 'Admin' },
    startedAt,
  );
  await pool.query(
    'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)',
    [ids.workspaceId, document.id, { ...document, payloadSchemaVersion: '2' }],
  );
});

test('025 rejects a string payloadSchemaVersion "2" written over a live legacy row', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('string_psv_update');
  await applyMigrationsThrough(25);
  const pool = poolForTest();
  try {
    const startedAt = Date.parse('2026-11-25T06:00:00Z');
    const document = shiftStartPayload(
      { id: 'string_psv_upd', objectId: ids.objectBId, createdAt: startedAt, workShift: 'day' },
      { name: 'String psv update' },
      { uid: ids.adminUid, display_name: 'Admin' },
      startedAt,
    );
    await assert.rejects(
      pool.query(
        'UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
        [ids.workspaceId, ids.shiftAId, { ...document, payloadSchemaVersion: '2' }],
      ),
      error => error.code === '23514',
    );
  } finally {
    await pool.end();
  }
});

test('025 rejects a payloadSchemaVersion change without a payload on a live legacy row', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('psv_live_legacy');
  await applyMigrationsThrough(25);
  const pool = poolForTest();
  try {
    await assert.rejects(
      pool.query(
        `UPDATE shifts SET payload_schema_version=2 WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, ids.shiftAId],
      ),
      error => error.code === '23514'
        && /payload_schema_version cannot change/.test(error.message),
    );
    assert.deepEqual((await pool.query(
      `SELECT state,payload_schema_version::int AS psv FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    )).rows[0], { state: 'active', psv: 1 });
  } finally {
    await pool.end();
  }
});

test('strict v2 update drift is rejected per canonical field and per close/closing field', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('update_drift_matrix');
  await applyMigrationsThrough(25);
  const pool = poolForTest();
  try {
    const startedAt = Date.parse('2026-11-26T06:00:00Z'); // 09:00 Europe/Moscow
    const live = shiftStartPayload(
      { id: 'matrix_live', objectId: ids.objectAId, createdAt: startedAt, workShift: 'day' },
      { name: 'Matrix object' },
      { uid: ids.adminUid, display_name: 'Admin' },
      startedAt,
    );
    await pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)',
      [ids.workspaceId, live.id, live],
    );
    const drift = (label, column, value) => assert.rejects(
      pool.query(
        `UPDATE shifts SET ${column}=$3 WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, live.id, value],
      ),
      error => error.code === '23514' && /shift canonical payload mismatch/.test(error.message),
      label,
    );
    // Each canonical column on its own: the document still says the old value.
    await drift('shift_type drift', 'shift_type', 'night');
    await drift('opened_by_uid drift', 'opened_by_uid', ids.foremanUid);
    await drift('opened_at drift', 'opened_at', new Date(startedAt + 60000));
    await drift('identity_resolution drift', 'identity_resolution', 'unresolved');
    await drift('shift_type_resolution drift', 'shift_type_resolution', 'unresolved');
    // is_active has its own earlier guard: a bare is_active write with the
    // document and state unchanged is rejected as an ambiguous legacy update.
    await assert.rejects(
      pool.query(
        'UPDATE shifts SET is_active=false WHERE workspace_id=$1 AND shift_id=$2',
        [ids.workspaceId, live.id],
      ),
      error => error.code === '23514' && /ambiguous legacy active update/.test(error.message),
      'bare is_active write on a v2 row is rejected',
    );
    // Close/closing fields are provenance too: a bare write without a document is drift.
    await drift('closed_by_uid drift', 'closed_by_uid', ids.adminUid);
    await drift('closed_at drift', 'closed_at', new Date(startedAt + 120000));
    await drift('closing_by_uid drift', 'closing_by_uid', ids.adminUid);
    await drift('closing_started_at drift', 'closing_started_at', new Date(startedAt + 60000));
    // A drift attempt must leave the stored row exactly as it was.
    assert.deepEqual((await pool.query(
      `SELECT state,is_active,shift_type,opened_by_uid,identity_resolution,shift_type_resolution,
              closed_at,closed_by_uid,closing_started_at,closing_by_uid
         FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, live.id],
    )).rows[0], {
      state: 'active', is_active: true, shift_type: 'day', opened_by_uid: ids.adminUid,
      identity_resolution: 'source', shift_type_resolution: 'source',
      closed_at: null, closed_by_uid: null, closing_started_at: null, closing_by_uid: null,
    });
  } finally {
    await pool.end();
  }
});

test('strict v2 canonical columns cannot drift from the document on update', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('canonical_drift');
  await applyMigrationsThrough(25);
  const pool = poolForTest();
  try {
    const startedAt = Date.parse('2026-11-26T06:00:00Z'); // 09:00 Europe/Moscow
    const live = shiftStartPayload(
      { id: 'drift_live', objectId: ids.objectAId, createdAt: startedAt, workShift: 'day' },
      { name: 'Drift object' },
      { uid: ids.adminUid, display_name: 'Admin' },
      startedAt,
    );
    await pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)',
      [ids.workspaceId, live.id, live],
    );
    const expectMismatch = (label, sql, params) => assert.rejects(
      pool.query(sql, params),
      error => error.code === '23514' && /shift canonical payload mismatch/.test(error.message),
      label,
    );
    // A bare close on a live v2 row: the untouched document still says active.
    await expectMismatch('bare close',
      `UPDATE shifts SET state='closed',closed_at=now(),closed_by_uid=$3
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, live.id, ids.adminUid]);
    await expectMismatch('bare object change',
      `UPDATE shifts SET object_id=$3,object_name_snapshot='Other object'
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, live.id, ids.objectBId]);
    await expectMismatch('bare work date',
      `UPDATE shifts SET work_date='2026-11-27' WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, live.id]);
    // A valid v2 document plus a contradictory explicit column: reject, never fix up.
    const closing = {
      ...live, isActive: false, closing: true, state: 'closing',
      closingStartedAt: startedAt + 3600000, closingBy: 'Admin',
    };
    await expectMismatch('payload with contradictory state column',
      `UPDATE shifts SET state='historical',payload=$3
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, live.id, closing]);
    // The same document alone still moves the row, and the columns follow it.
    await pool.query(
      'UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, live.id, closing],
    );
    assert.deepEqual((await pool.query(
      `SELECT state,is_active,closing_started_at,closing_by_uid FROM shifts
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, live.id],
    )).rows[0], {
      state: 'closing', is_active: true,
      closing_started_at: new Date(startedAt + 3600000), closing_by_uid: null,
    });
    // §4.1: a legacy row is never promoted to strict v2 without a v2 document.
    await pool.query(
      `UPDATE shifts SET state='historical',is_active=false
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    );
    await assert.rejects(
      pool.query(
        `UPDATE shifts SET payload_schema_version=2
          WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, ids.shiftAId],
      ),
      error => error.code === '23514'
        && /payload_schema_version cannot change/.test(error.message),
    );
    assert.deepEqual((await pool.query(
      `SELECT state,payload_schema_version::int AS payload_schema_version FROM shifts
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    )).rows[0], { state: 'historical', payload_schema_version: 1 });
  } finally {
    await pool.end();
  }
});

test('real close payload keeps its stale active alias without faking a close', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('stale_close_alias');
  await applyMigrationsThrough(25);
  const pool = poolForTest();
  try {
    const startedAt = Date.parse('2026-11-26T18:00:00Z'); // 21:00 Europe/Moscow
    const live = shiftStartPayload(
      { id: 'stale_close', objectId: ids.objectAId, createdAt: startedAt, workShift: 'night' },
      { name: 'Stale object' },
      { uid: ids.adminUid, display_name: 'Admin' },
      startedAt,
    );
    await pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)',
      [ids.workspaceId, live.id, live],
    );
    // shift-close.mjs keeps state:'active'/isActive:false while closing:true; that
    // stale alias must never be read as a close.
    const prepared = {
      ...live, isActive: false, closing: true, closeArchiveId: 'closed_' + live.id,
      closingStartedAt: startedAt + 60000, closingBy: 'Admin',
    };
    await pool.query(
      'UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, live.id, prepared],
    );
    assert.deepEqual((await pool.query(
      `SELECT state,is_active,closed_at,closed_by_uid,closing_started_at,closing_by_uid
         FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, live.id],
    )).rows[0], {
      state: 'closing', is_active: true, closed_at: null, closed_by_uid: null,
      closing_started_at: new Date(startedAt + 60000), closing_by_uid: null,
    });
    // The finish document carries only a display name for the closer: D2 keeps it
    // historical, with no invented close time or actor.
    const finished = { ...prepared, closing: false, closedAt: startedAt + 120000, closedBy: 'Admin' };
    await pool.query(
      'UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, live.id, finished],
    );
    assert.deepEqual((await pool.query(
      `SELECT state,is_active,closed_at,closed_by_uid,closing_started_at,closing_by_uid
         FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, live.id],
    )).rows[0], {
      state: 'historical', is_active: false, closed_at: null, closed_by_uid: null,
      closing_started_at: null, closing_by_uid: null,
    });
  } finally {
    await pool.end();
  }
});

test('025 historicalizes a legacy close whose closer uid is not a known user', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('ghost_closer');
  const pool = poolForTest();
  try {
    const startedAt = Date.parse('2026-11-19T06:00:00Z'); // 09:00 Europe/Moscow
    const rows = [
      ['ghost_closed', {
        startedBy: 'Ghost Closer', isActive: false, workShift: 'day',
        closedAt: 1795334400000, closedBy: 'Ghost Closer', closedByUid: 'ghost_closed_uid',
      }],
      ['ghost_closing', {
        startedBy: 'Ghost Closer', isActive: true, workShift: 'night',
        closing: true, closingStartedAt: 1795338000000, closingBy: 'Ghost Closer',
        closingByUid: 'ghost_closing_uid',
      }],
      ['ghost_opener', {
        startedBy: 'Ghost Opener', startedByUid: 'ghost_opener_uid',
        isActive: true, workShift: 'day',
      }],
    ];
    for (const [shiftId, extra] of rows) {
      await pool.query(
        `INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,$3,$4)`,
        [ids.workspaceId, shiftId, extra.isActive, {
          id: shiftId, objectId: ids.objectBId, objectName: 'Ghost object',
          startDate: '19.11.2026', startedAt, ...extra,
        }],
      );
    }
    // An unproven closer must be classified, not abort the whole migration with
    // a bare 23503 from shifts_closed_by_fk / shifts_closing_by_fk.
    await applyMigrationsThrough(25);
    assert.deepEqual((await pool.query(
      `SELECT shift_id,state,is_active,shift_type,identity_resolution,opened_by_uid,
              closed_at,closed_by_uid,closing_started_at,closing_by_uid
         FROM shifts WHERE workspace_id=$1 AND shift_id LIKE 'ghost_%'
        ORDER BY shift_id`,
      [ids.workspaceId],
    )).rows, [
      {
        shift_id: 'ghost_closed', state: 'historical', is_active: false,
        shift_type: 'day', identity_resolution: 'unresolved', opened_by_uid: null,
        closed_at: null, closed_by_uid: null,
        closing_started_at: null, closing_by_uid: null,
      },
      {
        shift_id: 'ghost_closing', state: 'closing', is_active: true,
        shift_type: 'night', identity_resolution: 'unresolved', opened_by_uid: null,
        closed_at: null, closed_by_uid: null,
        closing_started_at: new Date(1795338000000), closing_by_uid: null,
      },
      {
        shift_id: 'ghost_opener', state: 'active', is_active: true,
        shift_type: 'day', identity_resolution: 'unresolved', opened_by_uid: null,
        closed_at: null, closed_by_uid: null,
        closing_started_at: null, closing_by_uid: null,
      },
    ]);
    assert.equal((await pool.query(
      `SELECT count(*)::int AS n FROM schema_migrations
        WHERE filename='025_parallel_shifts_core.sql'`,
    )).rows[0].n, 1, 'the migration must commit, not fail closed');
    assert.equal((await pool.query(
      `SELECT count(*)::int AS n FROM app_users WHERE uid LIKE 'ghost_%'`,
    )).rows[0].n, 0, 'no user may be invented to satisfy the FK');
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
        `UPDATE shifts SET object_id=$3,object_name_snapshot='Bypassed object'
          WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, ids.shiftAId, ids.objectBId],
      ),
      error => error.code === '23514' && /locked/.test(error.message),
    );
    await pool.query(
      `UPDATE shifts SET object_id=object_id,object_name_snapshot=object_name_snapshot
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, ids.shiftAId],
    );
  } finally {
    await pool.end();
  }
});

test('sql_null_cannot_bypass_provenance_checks', {
  skip: !approved,
}, async () => {
  const ids = await prepareLegacyFixture('provenance_null');
  const pool = poolForTest();
  try {
    const legacyStartedAt = Date.parse('2026-11-18T06:00:00Z');
    await pool.query(
      `INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,false,$3)`,
      [ids.workspaceId, 'legacy_unresolved_null', {
        id: 'legacy_unresolved_null', objectId: ids.objectAId, objectName: 'Null legacy',
        startDate: '18.11.2026', startedAt: legacyStartedAt, startedBy: 'Legacy Person',
        isActive: false,
      }],
    );
    await applyMigrationsThrough(25);

    const startedAt = Date.parse('2026-11-26T06:00:00Z');
    const live = shiftStartPayload(
      { id: 'null_live', objectId: ids.objectBId, createdAt: startedAt, workShift: 'day' },
      { name: 'Null object' },
      { uid: ids.adminUid, display_name: 'Admin' },
      startedAt,
    );
    await pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES ($1,$2,true,$3)',
      [ids.workspaceId, live.id, live],
    );

    const expectCheck = (label, sql, params) => assert.rejects(
      pool.query(sql, params), error => error.code === '23514', label,
    );
    const onLive = suffix => [`UPDATE shifts SET ${suffix} WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, live.id]];
    const onLegacy = suffix => [`UPDATE shifts SET ${suffix} WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, 'legacy_unresolved_null']];

    await expectCheck('source identity keeps its uid', ...onLive(`identity_resolution='unresolved'`));
    await expectCheck('an equal-null source identity is impossible', ...onLive('opened_by_uid=NULL'));
    await expectCheck('source type keeps its value', ...onLive('shift_type=NULL'));
    await expectCheck('an unresolved type cannot back a live row', ...onLive(`shift_type_resolution='unresolved'`));
    await expectCheck('manual identity is not a strict v2 value', ...onLive(`identity_resolution='manual'`));
    await expectCheck('unknown identity enum', ...onLive(`identity_resolution='inferred'`));
    await expectCheck('unknown type enum', ...onLive(`shift_type_resolution='guess'`));
    await expectCheck('unknown payload schema version', ...onLive('payload_schema_version=3'));
    await expectCheck('NULL provenance enum cannot satisfy equivalence',
      ...onLive(`identity_resolution='manual',opened_by_uid=NULL`));
    await expectCheck('an unresolved row cannot be promoted to strict v2', ...onLegacy('payload_schema_version=2'));

    const before = (await pool.query(
      `SELECT state,is_active,shift_type,shift_type_resolution,identity_resolution,opened_by_uid
         FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, live.id],
    )).rows[0];
    assert.deepEqual(before, {
      state: 'active', is_active: true, shift_type: 'day', shift_type_resolution: 'source',
      identity_resolution: 'source', opened_by_uid: ids.adminUid,
    });

    // Manual resolution (Task 5 path) is legal on a historical row and never activates it.
    await pool.query(
      `UPDATE shifts SET shift_type='day',shift_type_resolution='manual'
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, 'legacy_unresolved_null'],
    );
    let legacy = (await pool.query(
      `SELECT state,is_active,shift_type,shift_type_resolution,identity_resolution
         FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, 'legacy_unresolved_null'],
    )).rows[0];
    assert.deepEqual(legacy, {
      state: 'historical', is_active: false, shift_type: 'day',
      shift_type_resolution: 'manual', identity_resolution: 'unresolved',
    });
    await expectCheck('manual type cannot lose its value', ...onLegacy('shift_type=NULL'));
    await expectCheck('unresolved type cannot keep a value',
      ...onLegacy(`shift_type='day',shift_type_resolution='unresolved'`));
    await pool.query(
      `UPDATE shifts SET shift_type=NULL,shift_type_resolution='unresolved'
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, 'legacy_unresolved_null'],
    );
    legacy = (await pool.query(
      `SELECT shift_type,shift_type_resolution FROM shifts
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, 'legacy_unresolved_null'],
    )).rows[0];
    assert.deepEqual(legacy, { shift_type: null, shift_type_resolution: 'unresolved' });
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
      `UPDATE shifts SET payload=payload || '{"closing":true,"isActive":false,"closingStartedAt":1795420800000}'::jsonb,is_active=false
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
      state: ['text', 'NO'],
      object_id: ['text', 'NO'],
      object_name_snapshot: ['text', 'NO'],
      work_date: ['date', 'NO'],
      shift_type: ['text', 'YES'],
      shift_type_resolution: ['text', 'NO'],
      opened_at: ['timestamp with time zone', 'NO'],
      opened_by_uid: ['text', 'YES'],
      opened_by_name_snapshot: ['text', 'NO'],
      identity_resolution: ['text', 'NO'],
      payload_schema_version: ['smallint', 'NO'],
      object_locked_at: ['timestamp with time zone', 'YES'],
      object_locked_by_operation_id: ['text', 'YES'],
      closing_started_at: ['timestamp with time zone', 'YES'],
      closing_by_uid: ['text', 'YES'],
      closed_at: ['timestamp with time zone', 'YES'],
      closed_by_uid: ['text', 'YES'],
      revision: ['bigint', 'NO'],
    };
    assert.equal(shiftColumns.has(['replica', 'placeholder'].join('_')), false, '025 must not expose replica placeholders');
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
      { shiftId: ids.shiftBId, state: 'closing', objectId: ids.objectAId, workDate: '2026-11-23', shiftType: 'night', actor: ids.foremanUid, revision: '1', active: true },
    ]);
    assert.ok(shifts.rows.every(row => row.opened_at instanceof Date));
    assert.equal(shifts.rows[0].object_locked_at, null, 'null status markers do not lock object');
    assert.ok(shifts.rows[1].object_locked_at instanceof Date, 'non-null confirmed status marker locks object');
    assert.equal(
      shifts.rows[1].object_locked_at.toISOString(),
      new Date(1795465000000).toISOString(),
      'lock time comes from the earliest confirmed line event, never shift start',
    );
    assert.equal(
      shifts.rows[1].closing_started_at.toISOString(),
      new Date(1795420800000).toISOString(),
      'closing time comes from the document closingStartedAt; a missing one is rejected, not NULL',
    );
    assert.equal(shifts.rows.find(row => row.shift_id === ids.shiftBId).closing_by_uid, null, 'missing closing actor stays unknown');
    const closedBackfill = shifts.rows.find(row => row.shift_id === closedShiftId);
    assert.equal(closedBackfill.state, 'closed');
    assert.equal(closedBackfill.closed_at.toISOString(), new Date(1795341600000).toISOString());
    assert.equal(closedBackfill.closed_by_uid, ids.adminUid);
    const restoredBackfill = shifts.rows.find(row => row.shift_id === restoredShiftId);
    assert.equal(restoredBackfill.state, 'historical', 'D5: a restored row without a proved type is not a live line');
    assert.equal(restoredBackfill.shift_type, null, 'D4: no hour inference fills a missing legacy type');
    assert.equal(restoredBackfill.is_active, false);
    const restoredProvenance = (await pool.query(
      `SELECT shift_type_resolution,identity_resolution FROM shifts
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, restoredShiftId],
    )).rows[0];
    assert.deepEqual(restoredProvenance, {
      shift_type_resolution: 'unresolved', identity_resolution: 'source',
    });

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
    // Lifecycle transitions belong to a strict v2 line; a migrated legacy row is
    // readable/writable only in its already classified shape.
    const lifecycleStartedAt = Date.parse('2026-11-26T18:00:00Z'); // 21:00 Europe/Moscow
    const lifecycle = shiftStartPayload(
      { id: 'lifecycle_core_good', objectId: ids.objectBId, createdAt: lifecycleStartedAt, workShift: 'night' },
      { name: 'Lifecycle object' },
      { uid: ids.adminUid, display_name: 'Admin' },
      lifecycleStartedAt,
    );
    await pool.query(
      'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)',
      [ids.workspaceId, lifecycle.id, lifecycle],
    );
    // The lifecycle of a strict v2 row comes from its document. A bare column
    // transition carries no evidence, so it is canonical drift and is rejected
    // (review Major 1); the closing document below is the supported path.
    await assert.rejects(
      pool.query(
        `UPDATE shifts SET state='closing' WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, lifecycle.id],
      ),
      error => error.code === '23514' && /shift canonical payload mismatch/.test(error.message),
    );
    const lifecycleClosing = {
      ...lifecycle, isActive: false, closing: true, state: 'closing',
      closingStartedAt: lifecycleStartedAt + 3600000, closingBy: 'Admin',
    };
    await pool.query(
      'UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, lifecycle.id, lifecycleClosing],
    );
    assert.deepEqual((await pool.query(
      `SELECT state,is_active FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, lifecycle.id],
    )).rows[0], { state: 'closing', is_active: true });
    await pool.query(
      'UPDATE shifts SET payload=$3 WHERE workspace_id=$1 AND shift_id=$2',
      [ids.workspaceId, lifecycle.id, lifecycle],
    );
    assert.deepEqual((await pool.query(
      `SELECT state,is_active FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
      [ids.workspaceId, lifecycle.id],
    )).rows[0], { state: 'active', is_active: true });
    await assert.rejects(
      pool.query(`UPDATE shifts SET state='unknown' WHERE workspace_id=$1 AND shift_id=$2`, [ids.workspaceId, lifecycle.id]),
      error => error.code === '23514',
    );
    await assert.rejects(
      pool.query(
        `UPDATE shifts SET object_id=$3 WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, ids.shiftBId, ids.objectBId],
      ),
      error => error.code === '23514' && /locked/.test(error.message),
    );
    await assert.rejects(
      pool.query(
        `UPDATE shifts SET payload=jsonb_set(payload,'{date}','"2099-01-01"'::jsonb)
          WHERE workspace_id=$1 AND shift_id=$2`,
        [ids.workspaceId, ids.shiftAId],
      ),
      error => error.code === '23514' && /protocol-upgrade-required/.test(error.message),
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
    const duplicateStartedAt = Date.parse('2026-11-24T06:00:00.000Z'); // 09:00 Europe/Moscow
    const duplicatePayload = operationId => shiftStartPayload(
      { id: operationId, objectId: ids.objectBId, createdAt: duplicateStartedAt, workShift: 'day' },
      { name: 'Duplicate object' },
      { uid: ids.adminUid, display_name: 'Admin' },
      duplicateStartedAt,
    );
    const insertDuplicate = async (client, operationId) => {
      const payload = duplicatePayload(operationId);
      return client.query(
        'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)',
        [ids.workspaceId, payload.id, payload],
      );
    };
    const clients = [await pool.connect(), await pool.connect()];
    try {
      await Promise.all(clients.map(client => client.query('BEGIN')));
      await insertDuplicate(clients[0], 'duplicate_a_core_good');
      const secondInsert = insertDuplicate(clients[1], 'duplicate_b_core_good');
      await clients[0].query('COMMIT');
      await assert.rejects(secondInsert, error => error.code === '23505');
      await clients[1].query('ROLLBACK');
    } finally {
      clients.forEach(client => client.release());
    }

    // Historical duplicates are not live lines, so they do not conflict.
    const inactivePayload = operationId => shiftStartPayload(
      { id: operationId, objectId: ids.objectBId, createdAt: Date.parse('2026-11-27T06:00:00.000Z'), workShift: 'day' },
      { name: 'Inactive object' },
      { uid: ids.adminUid, display_name: 'Admin' },
      Date.parse('2026-11-27T06:00:00.000Z'),
    );
    for (const operationId of ['inactive_duplicate_a', 'inactive_duplicate_b']) {
      const payload = inactivePayload(operationId);
      await pool.query(
        `INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,false,$3)`,
        [ids.workspaceId, payload.id, { ...payload, isActive: false }],
      );
    }
    assert.deepEqual((await pool.query(
      `SELECT shift_id,state,is_active FROM shifts
        WHERE workspace_id=$1 AND shift_id LIKE 'shift_inactive_duplicate_%'
        ORDER BY shift_id`,
      [ids.workspaceId],
    )).rows, [
      { shift_id: 'shift_inactive_duplicate_a', state: 'historical', is_active: false },
      { shift_id: 'shift_inactive_duplicate_b', state: 'historical', is_active: false },
    ]);

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

expectUnsafeLegacyFixtureRejected('025 rejects a stored v2 payload without the published key set', async (pool, ids) => {
  // Marking a legacy document as v2 without the full published document must
  // block the migration instead of masking the row as an always-complete v2.
  await pool.query(
    `UPDATE shifts SET payload=payload || '{"payloadSchemaVersion":2}'::jsonb
      WHERE workspace_id=$1 AND shift_id=$2`,
    [ids.workspaceId, ids.shiftAId],
  );
});

expectUnsafeLegacyFixtureRejected('025 rejects a stored v2 document carrying a restore-only alias', async (pool, ids) => {
  const startedAt = Date.parse('2026-11-25T06:00:00Z'); // 09:00 Europe/Moscow
  const document = shiftStartPayload(
    { id: 'stored_v2_alias', objectId: ids.objectAId, createdAt: startedAt, workShift: 'day' },
    { name: 'Stored v2 object' },
    { uid: ids.adminUid, display_name: 'Admin' },
    startedAt,
  );
  await pool.query(
    `INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)`,
    [ids.workspaceId, document.id, { ...document, restored: true }],
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
