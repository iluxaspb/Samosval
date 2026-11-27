import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrationsThrough} from './helpers/isolated-db.mjs';
import {startShiftOperation} from '../src/shift-start.mjs';
import {closeShiftOperation} from '../src/shift-close.mjs';
import {commitTabel} from '../src/tabel-store.mjs';

// Single-phase (v1) shift close on the canonical 025–029 schema.
//
// The 025 trigger derives `state` and `is_active` from the shift document and
// enforces `is_active = (state IN ('active','closing'))` (design §4.1/D1:
// "is_active means occupies a line"). The legacy writer used to clear
// `is_active` on `prepare`, which contradicts the same document's `closing:true`
// and made the trigger raise 23514 "shift canonical payload mismatch": the
// channel could not close a shift at all after the migration window.
//
// Covered here on the real schema (S25 template + 026–029 applied):
//   1. prepare keeps the line occupied (`is_active=true`, `state='closing'`,
//      `payload->>'closing'='true'`) and freezes the archive in the same
//      transaction;
//   2. a prepared (closing) shift still refuses a new shift start — the line is
//      released only by `finish`, exactly like the v2 close;
//   3. finish sets `is_active=false`, `state='closed'` with the close proof
//      (`payload.closedByUid`, `closed_at`, `closed_by_uid`) — not `historical` —
//      deletes only this shift's trips/statuses
//      and keeps the archive with the trips it froze (the frozen trip is first
//      confirmed in the tabel as the ordinary close requires);
//   4. a finished shift refuses a new prepare with a stable 409;
//   5. an empty shift closes without an archive row (`buildShiftArchive`
//      returns null when there is nothing to freeze), and a GAI-only shift keeps
//      an archive whose `totalTrips` is 0.
//
// Numbers come from the rows the test creates; nothing is hardcoded.

const WORKSPACE = 'main_workspace';

test('legacy single-phase close keeps the line until finish on the canonical schema', {skip: !process.env.TEST_DATABASE_URL}, async t => {
  const pool = new pg.Pool({connectionString: process.env.TEST_DATABASE_URL, max: 5});
  pool.on('error', () => {});
  const prefix = 'legacyclose_' + randomUUID().replaceAll('-', '');
  const admin = prefix + '_admin';
  const objectId = prefix + '_site';
  const truck = prefix + '_truck';
  const gaiTruck = prefix + '_gai_truck';
  const started = [];
  let operation = 0;
  let policyCreated = false;
  const nextOperation = label => `${prefix}_${label}_${++operation}`;
  const arrival = Date.now() - 60000;

  const shiftRow = async shiftId => (await pool.query(
    `SELECT shift_id,state,is_active,payload,closing_started_at,closing_by_uid,
            closed_at,closed_by_uid,revision
       FROM shifts WHERE workspace_id=$1 AND shift_id=$2`,
    [WORKSPACE, shiftId],
  )).rows[0];
  const archiveRow = async shiftId => (await pool.query(
    'SELECT archive_id,payload FROM shift_archives WHERE workspace_id=$1 AND shift_id=$2',
    [WORKSPACE, shiftId],
  )).rows[0];
  const rowCount = async (table, shiftId) => Number((await pool.query(
    `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1 AND shift_id=$2`,
    [WORKSPACE, shiftId],
  )).rows[0].n);
  const start = async (label, workShift = 'day') => {
    const result = await startShiftOperation(pool, admin, {
      id: nextOperation(`start_${label}`), objectId, createdAt: Date.now(), workShift,
    }, WORKSPACE);
    started.push(result.shift.id);
    return result.shift;
  };

  try {
    await applyMigrationsThrough(29);
    await pool.query('INSERT INTO workspaces(id) VALUES ($1) ON CONFLICT(id) DO NOTHING', [WORKSPACE]);
    await pool.query(
      "INSERT INTO app_users(uid,email,display_name,role,status) VALUES ($1,$2,'Legacy close admin','admin','active')",
      [admin, `${admin}@example.test`],
    );
    await pool.query(
      'INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES ($1,$2,$3)',
      [WORKSPACE, objectId, {id: objectId, name: 'Canonical site'}],
    );
    for (const [truckId, number] of [[truck, 'LEG1'], [gaiTruck, 'GAI1']]) {
      await pool.query(
        'INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES ($1,$2,$3)',
        [WORKSPACE, truckId, {id: truckId, brand: 'Камаз', number, defaultVol: 24, isGAI: truckId === gaiTruck}],
      );
    }

    // A real start through the real writer: the payload is the published v2
    // document, so the canonical trigger accepts the row as a live line.
    const shift = await start('a');
    assert.equal(shift.payloadSchemaVersion, 2);
    assert.equal(shift.state, 'active');
    assert.equal(shift.isActive, true);
    const opened = await shiftRow(shift.id);
    assert.equal(opened.state, 'active');
    assert.equal(opened.is_active, true);

    await pool.query(
      'INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES ($1,$2,$3,$4)',
      [WORKSPACE, truck, shift.id, {
        id: truck, shiftId: shift.id, onLine: true, cycleRevision: 1,
        arriveStatus: '10:00', arriveTimestamp: arrival, lastLoadTimestamp: null,
      }],
    );
    await pool.query(
      'INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES ($1,$2,$3,$4,$5)',
      [WORKSPACE, prefix + '_log_a', shift.id, truck, {
        id: prefix + '_log_a', shiftId: shift.id, truckId: truck,
        timestamp: arrival - 1000, timeStr: '09:59', volume: 24,
      }],
    );

    await t.test('prepare keeps the line occupied and freezes the archive', async () => {
      const prepared = await closeShiftOperation(pool, admin, {
        id: nextOperation('prepare_a'), type: 'prepare', shiftId: shift.id,
      });
      assert.equal(prepared.phase, 'awaiting-material');
      assert.equal(prepared.shift.closing, true);
      // The payload display alias stays the pre-transition snapshot; the
      // canonical column is what 025 derives and enforces.
      assert.equal(prepared.shift.isActive, false);
      assert.equal(prepared.archive.totalTrips, 1);

      const row = await shiftRow(shift.id);
      assert.equal(row.state, 'closing');
      assert.equal(row.is_active, true, 'a closing shift still occupies the line');
      assert.equal(row.payload.closing, true);
      assert.equal(row.payload.isActive, false);
      assert.equal(row.is_active, ['active', 'closing'].includes(row.state), '025 invariant');
      assert.ok(row.closing_started_at instanceof Date, 'closing timestamp is canonical');

      const archived = await archiveRow(shift.id);
      assert.ok(archived, 'prepare froze the archive');
      assert.equal(archived.archive_id, 'closed_' + shift.id);
      assert.equal(archived.payload.totalTrips, 1);
      assert.equal(archived.payload.totalVolume, 24);
      assert.equal(await rowCount('line_logs', shift.id), 1, 'prepare keeps the source trips');
      assert.equal(await rowCount('line_truck_statuses', shift.id), 1);
    });

    await t.test('a prepared shift still blocks a new shift start', async () => {
      // Same answer the v2 close already gives: the line is released by finish.
      await assert.rejects(start('blocked'), {code: 'shift-already-active'});
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM shifts WHERE workspace_id=$1 AND state IN (\'active\',\'closing\')',
        [WORKSPACE],
      )).rows[0].n, 1);
    });

    await t.test('finish releases the line and clears only its own trips', async () => {
      // The ordinary close refuses to clean up before the frozen volume is
      // confirmed in the tabel, so the test confirms it the way an operator does.
      policyCreated = !!(await pool.query(
        "INSERT INTO tabel_policy(workspace_id,enabled,import_sha256) VALUES ($1,true,$2) ON CONFLICT DO NOTHING RETURNING workspace_id",
        [WORKSPACE, prefix + '_policy'],
      )).rowCount;
      const [day, month, year] = shift.startDate.split('.');
      await commitTabel(pool, admin, {
        id: nextOperation('material'),
        key: `${objectId}/day:${year}-${month}-${day}:${shift.workShift}`,
        before: {revision: 0, data: null},
        data: {lineImports: {[shift.id]: {volume: 24, materialId: 'material'}}},
      });

      const finished = await closeShiftOperation(pool, admin, {
        id: nextOperation('finish_a'), type: 'finish', shiftId: shift.id,
      });
      assert.equal(finished.phase, 'closed');
      assert.equal(finished.archiveId, 'closed_' + shift.id);
      assert.equal(finished.shift.closing, false);
      assert.equal(finished.shift.isActive, false);

      const row = await shiftRow(shift.id);
      assert.equal(row.is_active, false, 'finish releases the line');
      // 025 derives `state` from the document: `closed` requires a numeric
      // closedAt *and* a non-empty closedByUid. Without the proof the row lands
      // in `historical` (migrated legacy rows), so the exact value is asserted —
      // `['active','closing'].includes(state) === false` passed on `historical`
      // and hid exactly that defect.
      assert.equal(row.state, 'closed');
      assert.equal(row.payload.state, 'closed');
      assert.equal(row.payload.closedByUid, admin, 'the close proof is the actor uid');
      assert.equal(row.payload.closedBy, 'Legacy close admin');
      assert.equal(row.closed_by_uid, admin, 'the canonical column carries the proof');
      assert.ok(row.closed_at instanceof Date, 'closed_at is derived from closedAt');
      assert.equal(row.payload.closing, false);
      assert.equal(row.payload.isActive, false);
      assert.equal(await rowCount('line_logs', shift.id), 0);
      assert.equal(await rowCount('line_truck_statuses', shift.id), 0);

      const archived = await archiveRow(shift.id);
      assert.equal(archived.payload.totalTrips, 1, 'the archive keeps the frozen trips');
      assert.equal(archived.payload.logs.length, 1);
    });

    await t.test('a finished shift refuses a new prepare', async () => {
      await assert.rejects(closeShiftOperation(pool, admin, {
        id: nextOperation('prepare_again'), type: 'prepare', shiftId: shift.id,
      }), {code: 'shift-already-closed'});
      assert.equal((await shiftRow(shift.id)).is_active, false);
    });

    await t.test('an empty shift closes without an archive row', async () => {
      const empty = await start('b');
      const prepared = await closeShiftOperation(pool, admin, {
        id: nextOperation('prepare_b'), type: 'prepare', shiftId: empty.id,
      });
      // buildShiftArchive freezes nothing when the shift has no trips at all.
      assert.equal(prepared.archive, null);
      assert.equal(prepared.archiveId, null);
      const closing = await shiftRow(empty.id);
      assert.equal(closing.state, 'closing');
      assert.equal(closing.is_active, true);
      assert.equal(await archiveRow(empty.id), undefined);

      const finished = await closeShiftOperation(pool, admin, {
        id: nextOperation('finish_b'), type: 'finish', shiftId: empty.id,
      });
      assert.equal(finished.phase, 'closed');
      assert.equal(finished.archiveId, null);
      const emptied = await shiftRow(empty.id);
      assert.equal(emptied.is_active, false);
      assert.equal(emptied.state, 'closed', 'an empty shift is closed too, not historical');
      assert.equal(emptied.payload.closedByUid, admin);
      assert.equal(await archiveRow(empty.id), undefined);
    });

    await t.test('a GAI-only shift keeps an archive with totalTrips 0', async () => {
      const gai = await start('c');
      await pool.query(
        'INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES ($1,$2,$3,$4,$5)',
        [WORKSPACE, prefix + '_log_gai', gai.id, gaiTruck, {
          id: prefix + '_log_gai', shiftId: gai.id, truckId: gaiTruck,
          timestamp: arrival - 2000, timeStr: '09:58', volume: 7, isGAI: true,
        }],
      );
      const prepared = await closeShiftOperation(pool, admin, {
        id: nextOperation('prepare_c'), type: 'prepare', shiftId: gai.id,
      });
      assert.equal(prepared.archive.totalTrips, 0, 'ГАИ sheet is not an ordinary trip');
      assert.equal(prepared.archive.totalVolume, 0);
      const finished = await closeShiftOperation(pool, admin, {
        id: nextOperation('finish_c'), type: 'finish', shiftId: gai.id,
      });
      assert.equal(finished.phase, 'closed');
      const archived = await archiveRow(gai.id);
      assert.ok(archived, 'a GAI-only shift still has a frozen archive');
      assert.equal(archived.payload.totalTrips, 0);
      assert.equal(archived.payload.logs.length, 1);
      assert.equal(await rowCount('line_logs', gai.id), 0);
      const closedGai = await shiftRow(gai.id);
      assert.equal(closedGai.state, 'closed');
      assert.equal(closedGai.payload.closedByUid, admin);
    });
  } finally {
    for (const shiftId of started) {
      await pool.query('DELETE FROM shift_archives WHERE workspace_id=$1 AND shift_id=$2', [WORKSPACE, shiftId]);
      await pool.query('DELETE FROM line_logs WHERE workspace_id=$1 AND shift_id=$2', [WORKSPACE, shiftId]);
      await pool.query('DELETE FROM line_truck_statuses WHERE workspace_id=$1 AND shift_id=$2', [WORKSPACE, shiftId]);
      await pool.query('DELETE FROM shifts WHERE workspace_id=$1 AND shift_id=$2', [WORKSPACE, shiftId]);
    }
    await pool.query('DELETE FROM shift_operation_receipts WHERE workspace_id=$1 AND uid=$2', [WORKSPACE, admin]);
    await pool.query('DELETE FROM tabel_receipts WHERE workspace_id=$1 AND object_id=$2', [WORKSPACE, objectId]);
    await pool.query('DELETE FROM tabel_records WHERE workspace_id=$1 AND object_id=$2', [WORKSPACE, objectId]);
    if (policyCreated) {
      await pool.query('DELETE FROM tabel_policy WHERE workspace_id=$1 AND import_sha256=$2', [WORKSPACE, prefix + '_policy']);
    }
    await pool.query('DELETE FROM line_audit WHERE workspace_id=$1 AND uid=$2', [WORKSPACE, admin]);
    await pool.query('DELETE FROM line_trucks WHERE workspace_id=$1 AND truck_id=ANY($2::text[])', [WORKSPACE, [truck, gaiTruck]]);
    await pool.query('DELETE FROM workspace_objects WHERE workspace_id=$1 AND object_id=$2', [WORKSPACE, objectId]);
    await pool.query('DELETE FROM app_users WHERE uid=$1', [admin]);
    await pool.end();
  }
});
