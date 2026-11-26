import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';

import {
  applyMigrationsThrough,
  requireIsolatedDatabase,
  resetIsolatedDatabase,
  withAdminClient,
} from './helpers/isolated-db.mjs';
import {
  CORRECTION_TYPES,
  UNRESOLVED_AUTHOR,
  UNRESOLVED_SHIFT_TYPE,
  readRestoredContext,
  submitRestoredCorrection,
} from '../src/restored-context-store.mjs';
import { submitReport } from '../src/report-store.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
let approved = false;
if (connectionString && process.env.SAMOSVAL_ISOLATED_TEST === '1') {
  try { requireIsolatedDatabase(connectionString); approved = true; } catch {}
}

const sha = value => createHash('sha256').update(value).digest('hex');
const bytesOf = value => Buffer.from(JSON.stringify(value), 'utf8');

const WS = 'workspace_restored_ctx';
const FOREIGN_WS = 'workspace_restored_ctx_foreign';
const ADMIN = 'admin_restored';
const OLD_AUTHOR = 'old_author';
const EDITOR = 'editor_restored';
const SENIOR = 'senior_restored';
const FOREMAN = 'foreman_restored';
const INACTIVE = 'inactive_restored';
const VIEWER = 'viewer_restored';
const TRUCK1 = 'truck_r1';
const TRUCK2 = 'truck_r2';
const ARCHIVE_OPEN = 'archive_restored_open';
const ARCHIVE_FINAL = 'archive_restored_finalized';
const ARCHIVE_UNRESOLVED = 'archive_restored_unresolved';
const OPEN_CTX = 'ctx_restored_open';
const FINAL_CTX = 'ctx_restored_finalized';
const UNRESOLVED_CTX = 'ctx_restored_unresolved';
const LIVE_SHIFT = 'live_shift_restored';
const STARTED_AT = Date.UTC(2026, 10, 26, 5, 0, 0);

// Всё, что лежит ВНЕ контекста и обязано остаться байт-в-байт тем же.
const OUTSIDE_TABLES = [
  'shifts', 'line_logs', 'line_truck_statuses', 'line_trucks', 'tabel_records', 'game_records',
  'shift_archives', 'archive_overrides', 'shift_archive_revisions', 'shift_archive_series',
  'workspace_service_receipts', 'workspace_service_audit',
  'line_audit', 'line_operation_receipts', 'line_history', 'history_audit', 'history_receipts',
  'shift_operation_receipts', 'restored_context_migration_evidence',
];

const liveShiftPayload = {
  payloadSchemaVersion: 2, id: LIVE_SHIFT, shiftId: LIVE_SHIFT,
  objectId: 'site', objectName: 'Объект',
  startDate: '26.11.2026', date: '2026-11-26',
  workShift: 'day', type: 'day', state: 'active', isActive: true,
  startedAt: STARTED_AT, startedBy: 'Живой прораб', startedByUid: ADMIN,
};

async function archivePayload(archiveId) {
  return {
    objectId: 'site', objectName: 'Объект', date: '23.11.2026',
    activeLineIds: [TRUCK1, TRUCK2],
    ttnStatus: { [TRUCK1]: 'pending', [TRUCK2]: 'pending' },
    logs: [
      { id: 'src_a', truckId: TRUCK1, timestamp: 20, volume: 24 },
      { id: 'src_b', truckId: TRUCK1, timestamp: 30, volume: 12 },
    ],
    totalTrips: 2, totalVolume: 36, archiveId,
  };
}

async function seedArchive(client, { archiveId, contextId, state = 'open', unresolved = false }) {
  await client.query(
    'INSERT INTO shift_archive_series(workspace_id,archive_id,source_shift_id) VALUES($1,$2,$3)',
    [WS, archiveId, `shift_${archiveId}`],
  );
  const bytes = bytesOf(await archivePayload(archiveId));
  const digest = sha(bytes);
  await client.query(
    `INSERT INTO shift_archive_revisions(
       workspace_id,archive_id,archive_revision,payload_bytes,payload_sha256,
       payload_schema_version,source_kind,source_locator,created_by_uid)
     VALUES($1,$2,1,$3,$4,2,'legacy-import',$5,$6)`,
    [WS, archiveId, bytes, digest, `legacy:${archiveId}:1`, ADMIN],
  );
  await client.query(
    'UPDATE shift_archive_series SET latest_finalized_revision=1,latest_finalized_sha256=$3 WHERE workspace_id=$1 AND archive_id=$2',
    [WS, archiveId, digest],
  );
  await client.query(
    `INSERT INTO restored_shift_contexts(
       workspace_id,restored_context_id,archive_id,source_shift_id,mode,context_state,
       original_opened_by_uid,original_opened_by_name_snapshot,original_identity_resolution,
       original_shift_type,original_shift_type_resolution,
       restored_by_uid,restored_by_name_snapshot,restored_at,
       archive_revision,context_revision,restore_operation_id,
       source_state_snapshot,source_shift_revision,opened_at_snapshot,
       object_id,object_name,work_date)
     VALUES($1,$2,$3,$4,'standalone',$5,$6,$7,$8,$9,$10,$11,'Восстановивший',now(),
            1,1,$12,'{"source":"archive"}'::jsonb,7,now(),'site','Объект',DATE '2026-11-23')`,
    [
      WS, contextId, archiveId, `shift_${archiveId}`, state,
      unresolved ? null : OLD_AUTHOR, unresolved ? null : 'Старый Автор',
      unresolved ? 'unresolved' : 'source',
      unresolved ? null : 'day', unresolved ? 'unresolved' : 'source',
      ADMIN, `op_restore_${archiveId}`,
    ],
  );
  return digest;
}

async function seedTrips(client, contextId) {
  const trips = [
    ['log_a', TRUCK1, { id: 'log_a', truckId: TRUCK1, timestamp: 20, volume: 24, timeStr: '10:00', comment: 'первый' }, 'src_a'],
    ['log_b', TRUCK1, { id: 'log_b', truckId: TRUCK1, timestamp: 30, volume: 12, timeStr: '11:00', comment: 'второй' }, 'src_b'],
    ['log_c', TRUCK2, { id: 'log_c', truckId: TRUCK2, timestamp: 40, volume: 8, timeStr: '12:00', comment: 'третий' }, null],
  ];
  for (const [logId, truckId, payload, sourceLogId] of trips) {
    await client.query(
      `INSERT INTO restored_context_logs(workspace_id,restored_context_id,log_id,truck_id,payload,log_revision,source_log_id,created_from_archive_revision)
       VALUES($1,$2,$3,$4,$5,1,$6,1)`,
      [WS, contextId, logId, truckId, payload, sourceLogId],
    );
  }
  await client.query(
    `INSERT INTO restored_context_status_snapshots(workspace_id,restored_context_id,truck_id,payload,status_revision,cycle_revision,ttn_revision)
     VALUES($1,$2,$3,$4,3,2,4),($1,$2,$5,$6,3,2,4)`,
    [WS, contextId, TRUCK1, { truckId: TRUCK1, ttnStatus: 'pending', lastLoadTimestamp: 30 },
      TRUCK2, { truckId: TRUCK2, ttnStatus: 'pending' }],
  );
}

async function outsideDigest(client) {
  const parts = [];
  for (const table of OUTSIDE_TABLES) {
    const rows = (await client.query(
      `SELECT row_to_json(t)::text AS row FROM (SELECT * FROM ${table} WHERE workspace_id=$1) t ORDER BY 1`,
      [WS],
    )).rows;
    parts.push([table, rows.map(row => row.row)]);
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function snapshotRows(client) {
  return (await client.query(
    `SELECT truck_id,payload::text AS payload,status_revision::text AS status_revision,
            cycle_revision::text AS cycle_revision,ttn_revision::text AS ttn_revision
       FROM restored_context_status_snapshots WHERE workspace_id=$1 ORDER BY truck_id`,
    [WS],
  )).rows;
}

async function contextRow(client, contextId) {
  return (await client.query(
    `SELECT context_state,context_revision::text AS context_revision,archive_revision::text AS archive_revision,
            original_opened_by_uid,original_opened_by_name_snapshot,original_identity_resolution,
            restored_by_uid
       FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2`,
    [WS, contextId],
  )).rows[0];
}

async function counts(client, contextId) {
  const row = (await client.query(
    `SELECT (SELECT count(*)::int FROM restored_context_history WHERE workspace_id=$1 AND restored_context_id=$2) history,
            (SELECT count(*)::int FROM restored_context_receipts WHERE workspace_id=$1 AND restored_context_id=$2) receipts,
            (SELECT count(*)::int FROM restored_context_audit WHERE workspace_id=$1 AND restored_context_id=$2) audit,
            (SELECT count(*)::int FROM restored_context_logs WHERE workspace_id=$1 AND restored_context_id=$2) logs`,
    [WS, contextId],
  )).rows[0];
  return row;
}

const rejected = (promise, code, status) => assert.rejects(promise, error => {
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
});

const command = (id, type, recordId, expectedContextRevision, extra = {}) => ({
  operationId: id, protocolVersion: 2, type, recordId,
  expectedContextRevision,
  expectedBaseArchiveRevision: 1,
  expectedBaseSha256: extra.baseSha ?? '0'.repeat(64),
  ...extra,
});

let pool;
let baseSha = '';
let openSha = '';
let revision = 1;

test.before(async () => {
  if (!approved) return;
  await resetIsolatedDatabase();
  await applyMigrationsThrough(25);
  pool = new pg.Pool({ connectionString, max: 6 });
  const client = await pool.connect();
  try {
    await client.query('INSERT INTO workspaces(id) VALUES($1),($2)', [WS, FOREIGN_WS]);
    for (const [uid, role, status] of [
      [ADMIN, 'admin', 'active'], [EDITOR, 'archivist', 'active'],
      [SENIOR, 'senior_foreman', 'active'], [FOREMAN, 'foreman', 'active'],
      [INACTIVE, 'archivist', 'disabled'], [VIEWER, 'viewer', 'active'],
      // Автор исходной (архивной) смены: FK restored_shift_contexts требует живого uid.
      [OLD_AUTHOR, 'foreman', 'disabled'],
    ]) {
      await client.query(
        'INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$1,$3,$4)',
        [uid, `${uid}@example.test`, role, status],
      );
    }
    // Архивный ACL: правка и удаление — отдельные права, membership не нужен.
    for (const action of ['archive_edit', 'archive_delete', 'tab_archive']) {
      await client.query("INSERT INTO role_permissions(role,action,allowed) VALUES('archivist',$1,true)", [action]);
    }
    for (const truck of [TRUCK1, TRUCK2]) {
      await client.query('INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)',
        [WS, truck, { id: truck, brand: 'Fixture', number: truck }]);
    }
    openSha = await seedArchive(client, { archiveId: ARCHIVE_OPEN, contextId: OPEN_CTX });
    await seedTrips(client, OPEN_CTX);
    await seedArchive(client, { archiveId: ARCHIVE_FINAL, contextId: FINAL_CTX, state: 'finalized' });
    await seedTrips(client, FINAL_CTX);
    await seedArchive(client, { archiveId: ARCHIVE_UNRESOLVED, contextId: UNRESOLVED_CTX, unresolved: true });
    baseSha = openSha;

    // Активная линия живёт параллельно: её данные не должны меняться ни на байт.
    await client.query('INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',
      [WS, 'site', { id: 'site', name: 'Объект' }]);
    await client.query('INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,true,$3)',
      [WS, LIVE_SHIFT, liveShiftPayload]);
    await client.query('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)',
      [WS, 'log_a', LIVE_SHIFT, TRUCK1, { id: 'log_a', shiftId: LIVE_SHIFT, truckId: TRUCK1, timestamp: 99, volume: 7, comment: 'живой рейс' }]);
    await client.query('INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)',
      [WS, 'log_live_only', LIVE_SHIFT, TRUCK2, { id: 'log_live_only', shiftId: LIVE_SHIFT, truckId: TRUCK2, timestamp: 98, volume: 5 }]);
    await client.query('INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES($1,$2,$3,$4)',
      [WS, TRUCK1, LIVE_SHIFT, { id: TRUCK1, shiftId: LIVE_SHIFT, onLine: true, ttnStatus: 'pending' }]);
    await client.query(
      "INSERT INTO tabel_records(workspace_id,record_id,object_id,record_key,payload) VALUES($1,'tabel_r','site','site/day:2026-11-26:day','{}'::jsonb)",
      [WS],
    );
    await client.query(
      "INSERT INTO game_records(workspace_id,record_id,collection,payload) VALUES($1,'game_r','audit','{}'::jsonb)",
      [WS],
    );
  } finally {
    client.release();
  }
});

test.after(async () => { if (pool) await pool.end(); });

test('restored context corrections are isolated, CAS-guarded and append-only', { skip: !approved }, async t => {
  const withClient = async fn => {
    const client = await pool.connect();
    try { return await fn(client); } finally { client.release(); }
  };

  await t.test('readRestoredContext returns the open context, trips, TTN and provenance without fallback', async () => {
    const context = await withClient(client => readRestoredContext(client, { workspaceId: WS, restoredContextId: OPEN_CTX }));
    assert.equal(context.archiveId, ARCHIVE_OPEN);
    assert.equal(context.archiveRevision, 1);
    assert.equal(context.baseArchiveRevision, 1);
    assert.equal(context.archiveSha256, openSha);
    assert.equal(context.baseArchiveSha256, openSha);
    assert.equal(context.latestFinalizedRevision, 1);
    assert.equal(context.latestFinalizedSha256, openSha);
    assert.equal(context.baseIsLatest, true);
    assert.equal(context.contextRevision, 1);
    assert.equal(context.contextState, 'open');
    assert.equal(context.mode, 'standalone');
    assert.deepEqual(context.trips.map(trip => trip.logId), ['log_a', 'log_b', 'log_c']);
    assert.equal(context.trips[0].payload.comment, 'первый');
    assert.equal(context.trips[0].sourceLogId, 'src_a');
    assert.deepEqual(context.ttn.map(row => [row.truckId, row.ttnStatus]), [[TRUCK1, 'pending'], [TRUCK2, 'pending']]);
    assert.equal(context.provenance.originalOpenedByUid, OLD_AUTHOR);
    assert.equal(context.provenance.originalOpenedByName, 'Старый Автор');
    assert.equal(context.provenance.originalIdentityResolution, 'source');
    assert.equal(context.provenance.restoredByUid, ADMIN);
    assert.equal(context.provenance.restoredByName, 'Восстановивший');
    assert.equal(context.provenance.unresolvedAuthor, false);
    assert.equal(context.provenance.authorText, 'Старый Автор');
    assert.equal(context.shiftSnapshot.objectId, 'site');
    assert.equal(context.shiftSnapshot.shiftType, 'day');

    // Explicit revision read of another revision is not this context.
    await rejected(withClient(client => readRestoredContext(client, { workspaceId: WS, restoredContextId: OPEN_CTX, archiveRevision: 2 })), 'archive-changed', 409);
    await rejected(withClient(client => readRestoredContext(client, { workspaceId: WS, restoredContextId: 'ctx_missing' })), 'archive-context-not-found', 404);
    await rejected(withClient(client => readRestoredContext(client, { workspaceId: FOREIGN_WS, restoredContextId: OPEN_CTX })), 'archive-context-not-found', 404);

    // Unresolved provenance stays unresolved: no fallback to the restoring actor.
    const unresolved = await withClient(client => readRestoredContext(client, { workspaceId: WS, restoredContextId: UNRESOLVED_CTX }));
    assert.equal(unresolved.provenance.unresolvedAuthor, true);
    assert.equal(unresolved.provenance.authorText, UNRESOLVED_AUTHOR);
    assert.equal(unresolved.provenance.originalOpenedByUid, null);
    assert.equal(unresolved.provenance.unresolvedShiftType, true);
    assert.equal(unresolved.provenance.shiftTypeText, UNRESOLVED_SHIFT_TYPE);
    assert.equal(unresolved.shiftSnapshot.shiftType, null);
    assert.equal(unresolved.provenance.restoredByName, 'Восстановивший');
  });

  await t.test('reference latest fields come from the resolver, never from a dangling pointer', async () => {
    await withClient(async client => {
      const good = await readRestoredContext(client, { workspaceId: WS, restoredContextId: OPEN_CTX });
      assert.equal(good.latestFinalizedRevision, 1);
      assert.equal(good.baseIsLatest, true);
      // Указатель серии, называющий несуществующую ревизию, возможен только без
      // FK (он и запрещает такое состояние). Убираем FK на время проверки, чтобы
      // доказать: справочные поля не показывают «latest», которого нет.
      // Снятие/возврат FK — фикстурный DDL, он идёт привилегированным
      // соединением: samosval_test_app не владеет таблицей.
      await withAdminClient(admin => admin.query('ALTER TABLE shift_archive_series DROP CONSTRAINT shift_archive_series_latest_revision_fk'));
      try {
        await client.query(
          'UPDATE shift_archive_series SET latest_finalized_revision=2,latest_finalized_sha256=$3 WHERE workspace_id=$1 AND archive_id=$2',
          [WS, ARCHIVE_OPEN, 'c'.repeat(64)],
        );
        const dangling = await readRestoredContext(client, { workspaceId: WS, restoredContextId: OPEN_CTX });
        assert.equal(dangling.latestFinalizedRevision, null);
        assert.equal(dangling.latestFinalizedSha256, null);
        assert.equal(dangling.baseIsLatest, null);
        // База контекста при этом читается как прежде: её байты immutable.
        assert.equal(dangling.archiveRevision, 1);
        assert.equal(dangling.archiveSha256, openSha);
      } finally {
        await client.query(
          'UPDATE shift_archive_series SET latest_finalized_revision=1,latest_finalized_sha256=$3 WHERE workspace_id=$1 AND archive_id=$2',
          [WS, ARCHIVE_OPEN, openSha],
        );
        await withAdminClient(admin => admin.query(
          `ALTER TABLE shift_archive_series ADD CONSTRAINT shift_archive_series_latest_revision_fk
             FOREIGN KEY (workspace_id,archive_id,latest_finalized_revision,latest_finalized_sha256)
             REFERENCES shift_archive_revisions(workspace_id,archive_id,archive_revision,payload_sha256)
             ON UPDATE RESTRICT ON DELETE RESTRICT`,
        ));
      }
      const again = await readRestoredContext(client, { workspaceId: WS, restoredContextId: OPEN_CTX });
      assert.equal(again.latestFinalizedRevision, 1);
      assert.equal(again.latestFinalizedSha256, openSha);
      assert.equal(again.baseIsLatest, true);
    });
  });

  await t.test('a moved latest pointer never rewrites the open context: read stays on its base revision', async () => {
    await withClient(async client => {
      const driftBytes = Buffer.from(JSON.stringify({ ...(await archivePayload(ARCHIVE_UNRESOLVED)), drift: true }), 'utf8');
      const driftSha = sha(driftBytes);
      const baseSha = (await client.query(
        'SELECT payload_sha256 FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=1',
        [WS, ARCHIVE_UNRESOLVED],
      )).rows[0].payload_sha256;
      await client.query(
        `INSERT INTO shift_archive_revisions(
           workspace_id,archive_id,archive_revision,previous_revision,previous_sha256,
           payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_by_uid)
         VALUES($1,$2,2,1,$3,$4,$5,2,'finalize',$6,$7)`,
        [WS, ARCHIVE_UNRESOLVED, baseSha, driftBytes, driftSha, `finalize:${ARCHIVE_UNRESOLVED}:2`, ADMIN],
      );
      await client.query(
        'UPDATE shift_archive_series SET latest_finalized_revision=2,latest_finalized_sha256=$3 WHERE workspace_id=$1 AND archive_id=$2',
        [WS, ARCHIVE_UNRESOLVED, driftSha],
      );
      try {
        const context = await withClient(client => readRestoredContext(client, { workspaceId: WS, restoredContextId: UNRESOLVED_CTX }));
        // Байты контекста — его собственные: указатель latest их не подменяет.
        assert.equal(context.archiveRevision, 1);
        assert.equal(context.archiveSha256, baseSha);
        assert.equal(context.baseArchiveRevision, 1);
        assert.equal(context.baseIsLatest, false);
        assert.equal(context.latestFinalizedRevision, 2);
        assert.equal(context.latestFinalizedSha256, driftSha);
        // Явный запрос не-базовой ревизии по-прежнему не этот контекст.
        await rejected(withClient(client => readRestoredContext(client, { workspaceId: WS, restoredContextId: UNRESOLVED_CTX, archiveRevision: 2 })), 'archive-changed', 409);
      } finally {
        await client.query(
          'UPDATE shift_archive_series SET latest_finalized_revision=1,latest_finalized_sha256=$3 WHERE workspace_id=$1 AND archive_id=$2',
          [WS, ARCHIVE_UNRESOLVED, baseSha],
        );
      }
    });
  });

  await t.test('each allowed correction bumps the context revision and writes exactly one history/receipt/audit row', async () => {
    await withClient(async client => {
      const outsideBefore = await outsideDigest(client);
      const snapshotsBefore = await snapshotRows(client);
      const contextBefore = await contextRow(client, OPEN_CTX);
      const countsBefore = await counts(client, OPEN_CTX);

      // 1. trip.update
      const update = await submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, OPEN_CTX,
        command('op_trip_update', 'trip.update', 'log_a', revision, { baseSha, data: { volume: 18, timeStr: '09:30', comment: 'правка' } }));
      assert.equal(update.outcome, 'confirmed');
      assert.equal(update.result.contextRevision, revision + 1);
      assert.equal(update.result.log.volume, 18);
      assert.equal(update.result.log.timeStr, '09:30');
      revision += 1;

      // 2. trip.delete
      const deleted = await submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, OPEN_CTX,
        command('op_trip_delete', 'trip.delete', 'log_b', revision, { baseSha }));
      assert.equal(deleted.result.contextRevision, revision + 1);
      assert.equal(deleted.result.log, null);
      revision += 1;

      // 3. ttn.update
      const ttnUpdate = await submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, OPEN_CTX,
        command('op_ttn_update', 'ttn.update', TRUCK1, revision, { baseSha, data: { ttnStatus: true } }));
      assert.equal(ttnUpdate.result.contextRevision, revision + 1);
      assert.deepEqual(ttnUpdate.result.ttn, { truckId: TRUCK1, ttnStatus: true });
      revision += 1;

      // 4. ttn.delete
      const ttnDelete = await submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, OPEN_CTX,
        command('op_ttn_delete', 'ttn.delete', TRUCK2, revision, { baseSha }));
      assert.equal(ttnDelete.result.contextRevision, revision + 1);
      assert.deepEqual(ttnDelete.result.ttn, { truckId: TRUCK2, ttnStatus: null });
      revision += 1;

      const countsAfter = await counts(client, OPEN_CTX);
      assert.deepEqual(countsAfter, {
        history: countsBefore.history + 4,
        receipts: countsBefore.receipts + 4,
        audit: countsBefore.audit + 4,
        logs: countsBefore.logs - 1,
      });

      // Точные before/after каждой записи.
      const history = (await client.query(
        `SELECT type,uid,before_log,after_log,before_status_snapshot,after_status_snapshot,revision::text AS revision,undone
           FROM restored_context_history WHERE workspace_id=$1 AND restored_context_id=$2 ORDER BY revision`,
        [WS, OPEN_CTX],
      )).rows;
      assert.deepEqual(history.map(row => [row.type, row.revision]), [
        ['trip.update', '2'], ['trip.delete', '3'], ['ttn.update', '4'], ['ttn.delete', '5'],
      ]);
      assert.equal(history[0].uid, EDITOR);
      assert.equal(history[0].before_log.volume, 24);
      assert.equal(history[0].after_log.volume, 18);
      assert.equal(history[0].before_log.comment, 'первый');
      assert.equal(history[1].before_log.logId ?? history[1].before_log.id, 'log_b');
      assert.equal(history[1].after_log, null);
      assert.deepEqual(history[2].before_status_snapshot, { truckId: TRUCK1, ttnStatus: 'pending' });
      assert.deepEqual(history[2].after_status_snapshot, { truckId: TRUCK1, ttnStatus: true });
      assert.deepEqual(history[3].before_status_snapshot, { truckId: TRUCK2, ttnStatus: 'pending' });
      assert.deepEqual(history[3].after_status_snapshot, { truckId: TRUCK2, ttnStatus: null });
      assert.equal(history.every(row => row.undone === false), true);

      const audit = (await client.query(
        'SELECT operation_id,uid,type,before_state,after_state FROM restored_context_audit WHERE workspace_id=$1 AND restored_context_id=$2 ORDER BY audit_id',
        [WS, OPEN_CTX],
      )).rows;
      assert.deepEqual(audit.map(row => [row.operation_id, row.type]), [
        ['op_trip_update', 'trip.update'], ['op_trip_delete', 'trip.delete'],
        ['op_ttn_update', 'ttn.update'], ['op_ttn_delete', 'ttn.delete'],
      ]);
      assert.equal(audit[0].before_state.log.volume, 24);
      assert.equal(audit[0].after_state.log.volume, 18);
      assert.deepEqual(audit[3].before_state.ttn, { truckId: TRUCK2, ttnStatus: 'pending' });
      assert.deepEqual(audit[3].after_state.ttn, { truckId: TRUCK2, ttnStatus: null });

      // Ровно одна строка рейса изменилась, вторая удалена; источник не тронут.
      const trips = (await client.query(
        'SELECT log_id,payload,log_revision::text AS log_revision FROM restored_context_logs WHERE workspace_id=$1 AND restored_context_id=$2 ORDER BY log_id',
        [WS, OPEN_CTX],
      )).rows;
      assert.deepEqual(trips.map(row => row.log_id), ['log_a', 'log_c']);
      assert.equal(trips[0].payload.volume, 18);
      assert.equal(trips[0].log_revision, '2');

      // Снимок источника — неизменяемый: ни байта.
      assert.deepEqual(await snapshotRows(client), snapshotsBefore);
      // Provenance/opener/restored_by не подменяются.
      const contextAfter = await contextRow(client, OPEN_CTX);
      assert.equal(contextAfter.context_state, 'open');
      assert.equal(contextAfter.context_revision, String(revision));
      for (const field of ['original_opened_by_uid', 'original_opened_by_name_snapshot', 'original_identity_resolution', 'restored_by_uid']) {
        assert.equal(contextAfter[field], contextBefore[field], `${field} must not change`);
      }
      // Ничего вне контекста не изменилось.
      assert.equal(await outsideDigest(client), outsideBefore);
    });
  });

  await t.test('forbidden operation types are refused before any write', async () => {
    await withClient(async client => {
      const outsideBefore = await outsideDigest(client);
      const countsBefore = await counts(client, OPEN_CTX);
      const contextBefore = await contextRow(client, OPEN_CTX);
      for (const type of ['shift.close', 'trip.create', 'report.update', 'report.delete', 'ttn.create', '', null, undefined, 42]) {
        await rejected(submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, OPEN_CTX,
          { ...command('op_forbidden_' + String(type), 'trip.update', 'log_a', revision, { baseSha }), type }), 'archive-operation-not-allowed', 400);
      }
      assert.deepEqual(await counts(client, OPEN_CTX), countsBefore);
      assert.deepEqual(await contextRow(client, OPEN_CTX), contextBefore);
      assert.equal(await outsideDigest(client), outsideBefore);
      assert.deepEqual([...CORRECTION_TYPES], ['trip.update', 'trip.delete', 'ttn.update', 'ttn.delete']);
    });
  });

  await t.test('a finalized context refuses every correction and keeps its bytes', async () => {
    await withClient(async client => {
      const outsideBefore = await outsideDigest(client);
      const snapshotsBefore = await snapshotRows(client);
      const countsBefore = await counts(client, FINAL_CTX);
      const contextBefore = await contextRow(client, FINAL_CTX);
      const finalSha = (await client.query(
        'SELECT payload_sha256 FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=1',
        [WS, ARCHIVE_FINAL],
      )).rows[0].payload_sha256;
      const commands = [
        { type: 'trip.update', recordId: 'log_a', data: { volume: 1, timeStr: '08:00', comment: '' } },
        { type: 'trip.delete', recordId: 'log_a' },
        { type: 'ttn.update', recordId: TRUCK1, data: { ttnStatus: true } },
        { type: 'ttn.delete', recordId: TRUCK1 },
      ];
      for (const [index, item] of commands.entries()) {
        await rejected(submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, FINAL_CTX,
          command(`op_finalized_${index}`, item.type, item.recordId, 1, { baseSha: finalSha, ...(item.data ? { data: item.data } : {}) })),
          'archive-context-finalized', 409);
      }
      assert.deepEqual(await counts(client, FINAL_CTX), countsBefore);
      assert.deepEqual(await contextRow(client, FINAL_CTX), contextBefore);
      assert.deepEqual(await snapshotRows(client), snapshotsBefore);
      assert.equal(await outsideDigest(client), outsideBefore);
      // Опубликованная ревизия архива тоже не изменилась.
      assert.equal((await client.query(
        'SELECT payload_sha256 FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=1',
        [WS, ARCHIVE_FINAL],
      )).rows[0].payload_sha256, finalSha);
    });
  });

  await t.test('CAS covers context revision, base archive revision and base sha256', async () => {
    await withClient(async client => {
      const outsideBefore = await outsideDigest(client);
      const snapshotsBefore = await snapshotRows(client);
      const countsBefore = await counts(client, OPEN_CTX);
      const contextBefore = await contextRow(client, OPEN_CTX);
      const data = { volume: 3, timeStr: '07:15', comment: 'cas' };

      await rejected(submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, OPEN_CTX,
        command('op_cas_context', 'trip.update', 'log_a', revision - 1, { baseSha, data })), 'archive-changed', 409);
      await rejected(submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, OPEN_CTX,
        { ...command('op_cas_revision', 'trip.update', 'log_a', revision, { baseSha, data }), expectedBaseArchiveRevision: 2 }), 'archive-changed', 409);
      await rejected(submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, OPEN_CTX,
        command('op_cas_sha', 'trip.update', 'log_a', revision, { baseSha: sha('другие байты'), data })), 'archive-changed', 409);

      assert.deepEqual(await counts(client, OPEN_CTX), countsBefore);
      assert.deepEqual(await contextRow(client, OPEN_CTX), contextBefore);
      assert.deepEqual(await snapshotRows(client), snapshotsBefore);
      assert.equal(await outsideDigest(client), outsideBefore);
    });
  });

  await t.test('ACL is checked against the session, never the body, and a foreign workspace is not reachable', async () => {
    await withClient(async client => {
      const outsideBefore = await outsideDigest(client);
      const countsBefore = await counts(client, OPEN_CTX);
      const contextBefore = await contextRow(client, OPEN_CTX);
      const data = { volume: 5, timeStr: '06:45', comment: 'acl' };
      for (const [uid, expected] of [[SENIOR, 'forbidden'], [FOREMAN, 'forbidden'], [INACTIVE, 'forbidden'], [VIEWER, 'forbidden'], ['ghost_user_restored', 'forbidden']]) {
        await rejected(submitRestoredCorrection(pool, { uid, workspaceId: WS }, OPEN_CTX,
          command(`op_acl_${uid}`, 'trip.update', 'log_a', revision, { baseSha, data })), expected, 403);
        await rejected(submitRestoredCorrection(pool, { uid, workspaceId: WS }, OPEN_CTX,
          command(`op_acl_del_${uid}`, 'trip.delete', 'log_a', revision, { baseSha })), expected, 403);
      }
      // Чужой workspace не видит контекст: 404, ни одной записи.
      await rejected(submitRestoredCorrection(pool, { uid: ADMIN, workspaceId: FOREIGN_WS }, OPEN_CTX,
        command('op_foreign', 'trip.update', 'log_a', revision, { baseSha, data })), 'archive-context-not-found', 404);
      assert.deepEqual(await counts(client, OPEN_CTX), countsBefore);
      assert.deepEqual(await contextRow(client, OPEN_CTX), contextBefore);
      assert.equal(await outsideDigest(client), outsideBefore);

      // Actor из body игнорируется: в истории и аудите только session uid.
      const body = { ...command('op_body_actor', 'trip.update', 'log_a', revision, { baseSha, data }), uid: FOREMAN, actor: { uid: FOREMAN, name: 'Подставной' } };
      const receipt = await submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, OPEN_CTX, body);
      assert.equal(receipt.result.contextRevision, revision + 1);
      revision += 1;
      const history = (await client.query(
        "SELECT uid FROM restored_context_history WHERE workspace_id=$1 AND restored_context_id=$2 AND type='trip.update' ORDER BY revision DESC LIMIT 1",
        [WS, OPEN_CTX],
      )).rows[0];
      assert.equal(history.uid, EDITOR);
      const audit = (await client.query(
        "SELECT uid FROM restored_context_audit WHERE workspace_id=$1 AND restored_context_id=$2 AND operation_id='op_body_actor'",
        [WS, OPEN_CTX],
      )).rows[0];
      assert.equal(audit.uid, EDITOR);
    });
  });

  await t.test('an identical replay returns the stored result; a different hash under the same operation id is reused', async () => {
    await withClient(async client => {
      const countsBefore = await counts(client, OPEN_CTX);
      const contextBefore = await contextRow(client, OPEN_CTX);
      const data = { volume: 11, timeStr: '05:30', comment: 'replay' };
      const first = await submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, OPEN_CTX,
        command('op_replay', 'trip.update', 'log_c', revision, { baseSha, data }));
      assert.equal(first.result.contextRevision, revision + 1);
      revision += 1;
      const countsAfterFirst = await counts(client, OPEN_CTX);

      const replay = await submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, OPEN_CTX,
        command('op_replay', 'trip.update', 'log_c', revision - 1, { baseSha, data }));
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, first.result);
      assert.deepEqual(await counts(client, OPEN_CTX), countsAfterFirst);
      assert.equal((await contextRow(client, OPEN_CTX)).context_revision, String(revision));

      // Тот же operationId с иным hash — отказ, ничего не записано.
      await rejected(submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, OPEN_CTX,
        command('op_replay', 'trip.update', 'log_c', revision - 1, { baseSha, data: { ...data, comment: 'другое' } })), 'operation-id-reused', 409);
      assert.deepEqual(await counts(client, OPEN_CTX), countsAfterFirst);

      // Повторная ACL-проверка: отозванное право отбивает replay.
      await client.query("UPDATE role_permissions SET allowed=false WHERE role='archivist' AND action='archive_edit'");
      try {
        await rejected(submitRestoredCorrection(pool, { uid: EDITOR, workspaceId: WS }, OPEN_CTX,
          command('op_replay', 'trip.update', 'log_c', revision - 1, { baseSha, data })), 'forbidden', 403);
      } finally {
        await client.query("UPDATE role_permissions SET allowed=true WHERE role='archivist' AND action='archive_edit'");
      }
      assert.equal((await contextRow(client, OPEN_CTX)).context_revision, String(revision));
      assert.deepEqual(await counts(client, OPEN_CTX), countsAfterFirst);
    });
  });

  await t.test('report.update/delete in archive mode address the context log and never line_logs', async () => {
    await withClient(async client => {
      const liveBefore = (await client.query(
        "SELECT payload::text AS payload FROM line_logs WHERE workspace_id=$1 AND log_id='log_a'", [WS],
      )).rows[0].payload;
      const outsideBefore = await outsideDigest(client);
      const countsBefore = await counts(client, OPEN_CTX);
      const logRevisionBefore = Number((await client.query(
        "SELECT log_revision::text AS r FROM restored_context_logs WHERE workspace_id=$1 AND restored_context_id=$2 AND log_id='log_a'",
        [WS, OPEN_CTX],
      )).rows[0].r);

      const updated = await submitReport(pool, EDITOR, {
        id: 'report_archive_update', type: 'report.update', restoredContextId: OPEN_CTX, logId: 'log_a',
        expected: { volume: 18, timestamp: 0, timeStr: '09:30', comment: 'правка', truckId: TRUCK1, shiftId: OPEN_CTX },
        data: { volume: 20, timeStr: '13:15', comment: 'правка из отчёта' },
        expectedContextRevision: revision, expectedBaseArchiveRevision: 1, expectedBaseSha256: baseSha,
      }, WS);
      assert.equal(updated.log.volume, 20);
      assert.equal(updated.log.timeStr, '13:15');
      revision += 1;

      const restored = (await client.query(
        "SELECT payload,log_revision::text AS log_revision FROM restored_context_logs WHERE workspace_id=$1 AND restored_context_id=$2 AND log_id='log_a'",
        [WS, OPEN_CTX],
      )).rows[0];
      assert.equal(restored.payload.volume, 20);
      assert.equal(Number(restored.log_revision), logRevisionBefore + 1);
      // Одноимённый рейс активной линии не тронут ни на байт.
      assert.equal((await client.query(
        "SELECT payload::text AS payload FROM line_logs WHERE workspace_id=$1 AND log_id='log_a'", [WS],
      )).rows[0].payload, liveBefore);

      const deleted = await submitReport(pool, EDITOR, {
        id: 'report_archive_delete', type: 'report.delete', restoredContextId: OPEN_CTX, logId: 'log_a',
        expected: { volume: 20, timestamp: 0, timeStr: '13:15', comment: 'правка из отчёта', truckId: TRUCK1, shiftId: OPEN_CTX },
        expectedContextRevision: revision, expectedBaseArchiveRevision: 1, expectedBaseSha256: baseSha,
      }, WS);
      assert.equal(deleted.log, null);
      revision += 1;
      assert.equal((await client.query(
        "SELECT count(*)::int n FROM restored_context_logs WHERE workspace_id=$1 AND restored_context_id=$2 AND log_id='log_a'",
        [WS, OPEN_CTX],
      )).rows[0].n, 0);
      assert.equal((await client.query(
        "SELECT payload::text AS payload FROM line_logs WHERE workspace_id=$1 AND log_id='log_a'", [WS],
      )).rows[0].payload, liveBefore);

      // Рейс, существующий только в активной линии, архивным путём не адресуется.
      await rejected(submitReport(pool, EDITOR, {
        id: 'report_archive_foreign_log', type: 'report.delete', restoredContextId: OPEN_CTX, logId: 'log_live_only',
        expected: { volume: 5, timestamp: 0, timeStr: '10:00', comment: '', truckId: TRUCK2, shiftId: LIVE_SHIFT },
        expectedContextRevision: revision, expectedBaseArchiveRevision: 1, expectedBaseSha256: baseSha,
      }, WS), 'restored-trip-not-found', 404);
      assert.equal((await client.query(
        "SELECT count(*)::int n FROM line_logs WHERE workspace_id=$1", [WS],
      )).rows[0].n, 2);

      const countsAfter = await counts(client, OPEN_CTX);
      assert.equal(countsAfter.history, countsBefore.history + 2);
      assert.equal(countsAfter.audit, countsBefore.audit + 2);
      assert.equal(countsAfter.logs, countsBefore.logs - 1);
      // Никаких game/tabel-эффектов от архивного удаления.
      assert.equal(await outsideDigest(client), outsideBefore);
    });
  });

  await t.test('no activation, material, tabel or game effects appear anywhere', async () => {
    await withClient(async client => {
      assert.equal((await client.query(
        "SELECT count(*)::int n FROM shifts WHERE workspace_id=$1 AND payload->>'restored'='true'", [WS],
      )).rows[0].n, 0);
      assert.equal((await client.query(
        "SELECT count(*)::int n FROM shifts WHERE workspace_id=$1", [WS],
      )).rows[0].n, 1, 'только живая смена, ни одной синтетической');
      assert.equal((await client.query(
        "SELECT count(*)::int n FROM line_truck_statuses WHERE workspace_id=$1", [WS],
      )).rows[0].n, 1, 'статусы активной линии не тронуты и не созданы');
      assert.equal((await client.query(
        "SELECT count(*)::int n FROM game_records WHERE workspace_id=$1", [WS],
      )).rows[0].n, 1, 'никаких reward/game-событий');
      assert.equal((await client.query(
        "SELECT count(*)::int n FROM tabel_records WHERE workspace_id=$1", [WS],
      )).rows[0].n, 1, 'табель не тронут');
      assert.equal((await client.query(
        "SELECT count(*)::int n FROM shift_archives WHERE workspace_id=$1", [WS],
      )).rows[0].n, 0, 'никакой активации/переноса в активный архив');
      assert.equal((await client.query(
        "SELECT count(*)::int n FROM archive_overrides WHERE workspace_id=$1", [WS],
      )).rows[0].n, 0);
      assert.equal((await client.query(
        "SELECT count(*)::int n FROM restored_context_migration_evidence WHERE workspace_id=$1", [WS],
      )).rows[0].n, 0);
      // Ни одна из четырёх ревизий архива не опубликована (finalize — не эта задача).
      assert.equal((await client.query(
        "SELECT count(*)::int n FROM archive_revision_publications WHERE workspace_id=$1", [WS],
      )).rows[0].n, 0);
      assert.equal((await contextRow(client, OPEN_CTX)).context_state, 'open');
      assert.equal((await contextRow(client, FINAL_CTX)).context_state, 'finalized');
      // Контекст не удалён и не активирован.
      assert.equal((await client.query(
        "SELECT count(*)::int n FROM restored_shift_contexts WHERE workspace_id=$1", [WS],
      )).rows[0].n, 3);
    });
  });
});
