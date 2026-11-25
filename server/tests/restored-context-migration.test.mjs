import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

import {
  applyMigrationsThrough,
  requireIsolatedDatabase,
  resetIsolatedDatabase,
} from './helpers/isolated-db.mjs';
import {
  MAINTENANCE_ROLE,
  MIGRATION_FUNCTION,
  RUNTIME_ROLE,
  manifestSha256,
  migrateLegacyRestoredContextExact,
  migrationAuthorityReport,
  migrationLocator,
  readMigrationManifest,
  withMigrationMaintenanceWindow,
} from '../src/restored-context-migration.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
let approved = false;
if (connectionString && process.env.SAMOSVAL_ISOLATED_TEST === '1') {
  try { requireIsolatedDatabase(connectionString); approved = true; } catch {}
}

const sha = value => createHash('sha256').update(value).digest('hex');
const hex = () => randomBytes(32).toString('hex');
const code = expected => error => {
  assert.equal(error.code, expected, `expected SQLSTATE ${expected}, got ${error.code}: ${error.message}`);
  return true;
};

const OPENED_AT = Date.parse('2026-11-25T09:00:00Z');
const TRIP_AT = Date.parse('2026-11-20T10:00:00Z');
const fixtures = [];
let pool;

function archiveDocument(suffix, { objectId, truckId, openerUid, sourceShiftId, withTrucks = [truckId] }) {
  return {
    id: `archive_record_${suffix}`,
    objectId,
    objectName: `Site ${suffix}`,
    date: '20.11.2026',
    shiftType: 'day',
    openedByUid: openerUid,
    openedByName: `Opener ${suffix}`,
    sourceShiftId,
    activeLineIds: withTrucks,
    ttnStatus: Object.fromEntries(withTrucks.map(id => [id, true])),
    logs: [{ id: `trip_${suffix}_1`, truckId, truckName: 'Truck', timestamp: TRIP_AT, volume: 24, timeStr: '10:00' }],
    totalVolume: 24,
    totalTrips: 1,
  };
}

// Every fixture row that must exist before 025 is applied: the legacy restored
// `shifts` row is created on the raw legacy schema, exactly like production data.
function legacyFixture(suffix, { parallel = false, orphanTruck = null, extraTruck = null } = {}) {
  const ws = `ws_${suffix}`;
  const openerUid = `opener_${suffix}`;
  const restorerUid = `restorer_${suffix}`;
  const objectId = `object_${suffix}`;
  const truckId = `truck_${suffix}`;
  const shiftId = `shift_restored_${suffix}`;
  const recordId = `record_${suffix}`;
  const sourceShiftId = `shift_source_${suffix}`;
  const actionId = `action_${suffix}`;
  const historyOp = `history_op_${suffix}`;
  const reportOp = `report_op_${suffix}`;
  const shiftOp = `shift_op_${suffix}`;
  const doc = archiveDocument(suffix, { objectId, truckId, openerUid, sourceShiftId, withTrucks: extraTruck ? [truckId, extraTruck] : [truckId] });
  const restoredPayload = {
    id: shiftId,
    objectId,
    objectName: '',
    startDate: '20.11.2026',
    startedAt: OPENED_AT,
    startedBy: `Restorer ${suffix}`,
    startedByUid: restorerUid,
    isActive: true,
    restoredFrom: recordId,
    ...(parallel ? { restored: true, originalSourceShiftId: sourceShiftId } : {}),
  };
  const ids = {
    suffix, ws, openerUid, restorerUid, objectId, truckId, shiftId, recordId, sourceShiftId,
    actionId, historyOp, reportOp, shiftOp, doc, restoredPayload,
    archiveId: `archive_${suffix}`,
    migrationOperationId: `migrate_${suffix}`,
  };
  fixtures.push(ids);
  return ids;
}

async function insertLegacyFixture(client, ids, { orphanTruck = null, extraTruck = null } = {}) {
  const { ws, openerUid, restorerUid, objectId, truckId, shiftId, recordId, doc, restoredPayload } = ids;
  await client.query('INSERT INTO workspaces(id) VALUES($1)', [ws]);
  for (const [uid, role] of [[openerUid, 'admin'], [restorerUid, 'foreman']]) {
    await client.query(
      `INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$3,$4,'active')`,
      [uid, `${uid}@example.test`, uid, role],
    );
  }
  await client.query(
    'INSERT INTO workspace_objects(workspace_id,object_id,payload) VALUES($1,$2,$3)',
    [ws, objectId, { id: objectId, name: `Site ${ids.suffix}` }],
  );
  for (const id of [truckId, extraTruck].filter(Boolean)) {
    await client.query(
      'INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3)',
      [ws, id, { id, brand: 'Fixture', number: 'A111AA77', defaultVol: 24 }],
    );
  }
  await client.query(
    'INSERT INTO archive_overrides(workspace_id,record_id,location,payload,revision) VALUES($1,$2,$3,$4,$5)',
    [ws, recordId, 'restored', doc, 2],
  );
  await client.query(
    'INSERT INTO shifts(workspace_id,shift_id,is_active,payload) VALUES($1,$2,$3,$4)',
    [ws, shiftId, true, restoredPayload],
  );
  await client.query(
    'INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)',
    [ws, `log_${ids.suffix}_1`, shiftId, orphanTruck ?? truckId,
      { id: `log_${ids.suffix}_1`, shiftId, truckId: orphanTruck ?? truckId, volume: 24, timestamp: TRIP_AT, timeStr: '10:00' }],
  );
  if (!ids.restoredPayload.restored) {
    await client.query(
      'INSERT INTO line_truck_statuses(workspace_id,truck_id,shift_id,payload) VALUES($1,$2,$3,$4)',
      [ws, truckId, shiftId, { id: truckId, shiftId, onLine: true, cycleRevision: 1, ttnRevision: 1 }],
    );
  }
  await client.query(
    `INSERT INTO line_history(workspace_id,action_id,uid,shift_id,truck_id,type,before_status,after_status,log_data,revision)
     VALUES($1,$2,$3,$4,$5,'addTrip','{}'::jsonb,'{"onLine":true}'::jsonb,$6,1)`,
    [ws, ids.actionId, restorerUid, shiftId, truckId, { id: `log_${ids.suffix}_1`, volume: 24 }],
  );
  await client.query(
    `INSERT INTO line_audit(workspace_id,operation_id,uid,type,status) VALUES($1,$2,$3,'addTrip','ok')`,
    [ws, ids.actionId, restorerUid],
  );
  await client.query(
    `INSERT INTO line_operation_receipts(workspace_id,operation_id,uid,request_hash,result) VALUES($1,$2,$3,$4,$5)`,
    [ws, ids.actionId, restorerUid, sha(`line-receipt-${ids.suffix}`), { ok: true }],
  );
  await client.query(
    `INSERT INTO history_audit(workspace_id,operation_id,uid,action_id,direction) VALUES($1,$2,$3,$4,'undo')`,
    [ws, ids.historyOp, restorerUid, ids.actionId],
  );
  await client.query(
    `INSERT INTO history_receipts(workspace_id,operation_id,uid,request_hash,result) VALUES($1,$2,$3,$4,$5)`,
    [ws, ids.historyOp, restorerUid, sha(`history-receipt-${ids.suffix}`), { ok: true }],
  );
  await client.query(
    `INSERT INTO workspace_service_audit(workspace_id,operation_id,uid,type,before_data,after_data,revision)
     VALUES($1,$2,$3,'report.update',$4,$5,2)`,
    [ws, ids.reportOp, restorerUid, { shiftId, log: { volume: 20 } }, { shiftId, log: { volume: 24 } }],
  );
  await client.query(
    `INSERT INTO workspace_service_receipts(workspace_id,operation_id,uid,request_hash,result) VALUES($1,$2,$3,$4,$5)`,
    [ws, ids.reportOp, restorerUid, sha(`report-receipt-${ids.suffix}`), { ok: true }],
  );
  await client.query(
    `INSERT INTO shift_operation_receipts(workspace_id,operation_id,uid,request_hash,result) VALUES($1,$2,$3,$4,$5)`,
    [ws, ids.shiftOp, restorerUid, sha(`shift-receipt-${ids.suffix}`), { shift: { id: shiftId } }],
  );
}

async function insertArchiveSeries(client, ids) {
  const bytes = Buffer.from(JSON.stringify(ids.doc), 'utf8');
  await client.query(
    `INSERT INTO shift_archive_series(workspace_id,archive_id,source_shift_id) VALUES($1,$2,$3)`,
    [ids.ws, ids.archiveId, ids.sourceShiftId],
  );
  await client.query(
    `INSERT INTO shift_archive_revisions(
       workspace_id,archive_id,archive_revision,previous_revision,previous_sha256,
       payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_by_uid)
     VALUES($1,$2,1,NULL,NULL,$3,$4,1,'legacy-import',$5,$6)`,
    [ids.ws, ids.archiveId, bytes, sha(bytes), `migration-documents/${ids.ws}/${ids.recordId}`, ids.openerUid],
  );
}

function locatorOf(ids) {
  return migrationLocator({
    workspaceId: ids.ws,
    legacyShiftId: ids.shiftId,
    archiveId: ids.archiveId,
    baseArchiveRevision: 1,
    migrationOperationId: ids.migrationOperationId,
  });
}

async function manifestOf(ids) {
  return JSON.parse(await readMigrationManifest(pool, locatorOf(ids)));
}

function tamper(manifest, mutate) {
  const copy = JSON.parse(JSON.stringify(manifest));
  mutate(copy);
  return copy;
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

test('restored-context migration', { skip: !approved }, async t => {
  await resetIsolatedDatabase();
  await applyMigrationsThrough(24);
  const orphanFixture = legacyFixture('orphan', { orphanTruck: 'truck_missing_orphan' });
  const extraFixture = legacyFixture('extra', { extraTruck: 'truck_extra_extra' });
  const parallelFixture = legacyFixture('parallel', { parallel: true, extraTruck: 'truck_active_parallel' });
  legacyFixture('standalone');
  legacyFixture('locator');
  legacyFixture('second');
  legacyFixture('replay');
  legacyFixture('rollback');
  {
    const seed = new pg.Pool({ connectionString, max: 1 });
    const client = await seed.connect();
    try {
      for (const ids of fixtures) {
        await insertLegacyFixture(client, ids, {
          orphanTruck: ids === orphanFixture ? 'truck_missing_orphan' : null,
          extraTruck: ids === extraFixture ? 'truck_extra_extra'
            : ids === parallelFixture ? 'truck_active_parallel' : null,
        });
      }
    } finally {
      client.release();
      await seed.end();
    }
  }
  await applyMigrationsThrough(25);
  {
    const seed = new pg.Pool({ connectionString, max: 1 });
    const client = await seed.connect();
    try {
      for (const ids of fixtures) await insertArchiveSeries(client, ids);
    } finally {
      client.release();
      await seed.end();
    }
  }
  pool = new pg.Pool({ connectionString, max: 4 });

  try {
    await runCases(t);
  } finally {
    await pool.end();
  }
});

async function runCases(t) {
  const bySuffix = suffix => fixtures.find(ids => ids.suffix === suffix);

  await t.test('a standalone restored row migrates with its own statuses and an unbroken opener', async () => {
    const ids = bySuffix('standalone');
    const manifest = await manifestOf(ids);
    assert.equal(manifest.schema, 'samosval.restored-context-migration/v1');
    assert.equal(manifest.mode, 'standalone');
    assert.equal(manifestSha256(manifest), manifestSha256(manifest));
    const result = await migrateLegacyRestoredContextExact(pool, ids.ws, manifest);
    assert.equal(result.outcome, 'migrated');
    assert.equal(result.restoredContextId, manifest.contextId);
    const context = (await pool.query(
      `SELECT mode,context_state,original_opened_by_uid,original_opened_by_name_snapshot,
              original_identity_resolution,original_shift_type,original_shift_type_resolution,
              restored_by_uid,restored_by_name_snapshot,restored_at,archive_revision::int AS archive_revision,
              source_shift_revision::int AS source_shift_revision,opened_at_snapshot,object_id,object_name,work_date::text AS work_date
         FROM restored_shift_contexts WHERE workspace_id=$1 AND restored_context_id=$2`,
      [ids.ws, manifest.contextId],
    )).rows[0];
    assert.deepEqual(context, {
      mode: 'standalone', context_state: 'open',
      original_opened_by_uid: ids.openerUid,
      original_opened_by_name_snapshot: `Opener ${ids.suffix}`,
      original_identity_resolution: 'source',
      original_shift_type: 'day', original_shift_type_resolution: 'source',
      restored_by_uid: ids.restorerUid,
      restored_by_name_snapshot: `Restorer ${ids.suffix}`,
      restored_at: new Date(OPENED_AT),
      archive_revision: 1, source_shift_revision: 1,
      opened_at_snapshot: new Date(OPENED_AT),
      object_id: ids.objectId, object_name: `Site ${ids.suffix}`, work_date: '2026-11-20',
    });
    assert.notEqual(context.restored_by_uid, context.original_opened_by_uid);
    const logs = (await pool.query(
      `SELECT log_id,source_log_id,created_from_archive_revision::int AS created_from_archive_revision,payload
         FROM restored_context_logs
        WHERE workspace_id=$1 AND restored_context_id=$2`,
      [ids.ws, manifest.contextId],
    )).rows;
    assert.equal(logs.length, 1);
    assert.equal(logs[0].source_log_id, `log_${ids.suffix}_1`);
    assert.equal(logs[0].created_from_archive_revision, 1);
    const statuses = (await pool.query(
      `SELECT truck_id,payload FROM restored_context_status_snapshots
        WHERE workspace_id=$1 AND restored_context_id=$2`,
      [ids.ws, manifest.contextId],
    )).rows;
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].truck_id, ids.truckId);
    assert.equal(statuses[0].payload.snapshotSource, undefined, 'a standalone status is copied verbatim');
    assert.equal((await pool.query(
      `SELECT count(*)::int AS n FROM restored_context_history WHERE workspace_id=$1 AND restored_context_id=$2`,
      [ids.ws, manifest.contextId],
    )).rows[0].n, 2, 'one line action and one report correction');
    assert.equal((await pool.query(
      `SELECT count(*)::int AS n FROM restored_context_receipts WHERE workspace_id=$1 AND restored_context_id=$2`,
      [ids.ws, manifest.contextId],
    )).rows[0].n, 4);
    const evidence = (await pool.query(
      `SELECT legacy_shift_id,archive_id,base_archive_revision::int AS base_archive_revision,source_locator,
              closure_hash,migrated_context_id
         FROM restored_context_migration_evidence WHERE workspace_id=$1 AND evidence_id=$2`,
      [ids.ws, manifest.evidenceId],
    )).rows[0];
    assert.equal(evidence.legacy_shift_id, ids.shiftId);
    assert.equal(evidence.archive_id, ids.archiveId);
    assert.equal(evidence.base_archive_revision, 1);
    assert.equal(evidence.source_locator, manifest.archive.sourceLocator);
    assert.equal(evidence.closure_hash, manifest.closureHash);
    assert.equal(evidence.migrated_context_id, manifest.contextId);
    const childCount = (await pool.query(
      `SELECT count(*)::int AS n FROM restored_context_migration_evidence_rows
        WHERE workspace_id=$1 AND evidence_id=$2`,
      [ids.ws, manifest.evidenceId],
    )).rows[0].n;
    assert.equal(childCount, manifest.evidenceRows.length);
    for (const [table, expected] of [
      ['shifts', 0], ['line_logs', 0], ['line_truck_statuses', 0], ['line_history', 0],
      ['line_audit', 0], ['line_operation_receipts', 0], ['history_audit', 0],
      ['history_receipts', 0], ['workspace_service_audit', 0], ['workspace_service_receipts', 0],
      ['shift_operation_receipts', 0],
    ]) {
      const column = table === 'shifts' ? 'shift_id' : table === 'line_logs' ? 'shift_id'
        : table === 'line_truck_statuses' ? 'shift_id' : table === 'line_history' ? 'shift_id'
        : table === 'shift_operation_receipts' ? "result->'shift'->>'id'" : 'operation_id';
      const value = ['line_audit', 'line_operation_receipts', 'workspace_service_audit',
        'workspace_service_receipts', 'history_audit', 'history_receipts'].includes(table)
        ? null : ids.shiftId;
      const { rows } = value
        ? await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1 AND ${column}=$2`, [ids.ws, value])
        : await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`, [ids.ws]);
      assert.equal(rows[0].n, expected, `${table} must be empty for the migrated workspace`);
    }
    const receipt = (await pool.query(
      'SELECT location,revision::int AS revision FROM archive_overrides WHERE workspace_id=$1 AND record_id=$2',
      [ids.ws, ids.recordId],
    )).rows[0];
    assert.deepEqual(receipt, { location: 'archive', revision: 3 });
    const guard = (await pool.query(
      `SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.archive_overrides'::regclass
        AND tgname='archive_overrides_restored_receipt_immutable'`,
    )).rows[0];
    assert.equal(guard.tgenabled, 'O', 'the named receipt guard is enabled again');
  });

  await t.test('a parallel restored row is rebuilt as an explicit archive snapshot', async () => {
    const ids = bySuffix('parallel');
    const manifest = await manifestOf(ids);
    assert.equal(manifest.mode, 'parallel');
    const result = await migrateLegacyRestoredContextExact(pool, ids.ws, manifest);
    assert.equal(result.outcome, 'migrated');
    const context = (await pool.query(
      `SELECT mode,original_opened_by_uid,restored_by_uid FROM restored_shift_contexts
        WHERE workspace_id=$1 AND restored_context_id=$2`,
      [ids.ws, manifest.contextId],
    )).rows[0];
    assert.equal(context.mode, 'parallel');
    assert.equal(context.original_opened_by_uid, ids.openerUid);
    assert.equal(context.restored_by_uid, ids.restorerUid);
    const statuses = (await pool.query(
      `SELECT truck_id,payload FROM restored_context_status_snapshots
        WHERE workspace_id=$1 AND restored_context_id=$2`,
      [ids.ws, manifest.contextId],
    )).rows;
    assert.equal(statuses.length, 2, 'the archive snapshot names every active truck and every trip truck');
    for (const row of statuses) {
      assert.equal(row.payload.snapshotSource, 'archive');
      assert.equal(row.payload.shiftId, ids.shiftId);
      assert.equal(row.payload.onLine, true);
    }
  });

  await t.test('an orphan child, a foreign workspace, a wrong locator, an omission and a mutation are refused', async () => {
    const orphan = bySuffix('orphan');
    await assert.rejects(
      readMigrationManifest(pool, locatorOf(orphan)),
      error => code('23514')(error) && /migration-truck-orphan/.test(error.message),
    );
    const ids = bySuffix('standalone');
    await assert.rejects(
      migrateLegacyRestoredContextExact(pool, 'some_other_workspace', await manifestOf(bySuffix('replay'))),
      error => code('23514')(error) && /migration-workspace-mismatch/.test(error.message),
    );
    void ids;
    const replayManifest = await manifestOf(bySuffix('replay'));
    await assert.rejects(
      migrateLegacyRestoredContextExact(pool, bySuffix('replay').ws,
        tamper(replayManifest, m => { m.archive.sourceLocator = 'migration-documents/forged'; })),
      error => code('23514')(error) && /migration-manifest-mismatch/.test(error.message),
    );
    await assert.rejects(
      migrateLegacyRestoredContextExact(pool, bySuffix('replay').ws,
        tamper(replayManifest, m => { m.evidenceRows.pop(); })),
      error => code('23514')(error) && /migration-manifest-mismatch/.test(error.message),
    );
    await assert.rejects(
      migrateLegacyRestoredContextExact(pool, bySuffix('replay').ws,
        tamper(replayManifest, m => { m.evidenceRows[0].sourceRowSha256 = 'f'.repeat(64); })),
      error => code('23514')(error) && /migration-manifest-mismatch/.test(error.message),
    );
    void ids;
  });

  await t.test('an arbitrary source table and a forged capability are refused with a stable code', async () => {
    const ids = bySuffix('extra');
    const manifest = await manifestOf(ids);
    await assert.rejects(
      migrateLegacyRestoredContextExact(pool, ids.ws,
        tamper(manifest, m => { m.evidenceRows[0].sourceTable = 'shifts'; })),
      error => code('23514')(error) && /migration-source-table-not-allowed/.test(error.message),
    );
    const report = await migrationAuthorityReport(pool);
    assert.equal(report.owner, 'samosval_migration_evidence_owner');
    assert.equal(report.securityDefiner, true);
    assert.match(report.searchPath, /pg_catalog/);
    assert.equal(report.publicExecute, false);
    assert.equal(report.runtimeExecute, false);
    assert.equal(report.maintenanceExecute, false);
    assert.equal(report.maintenanceManifestExecute, true);

    // Real probes, not catalog promises. `SET SESSION AUTHORIZATION` makes the
    // probe a genuine runtime session, so both the ACL check and the SET ROLE
    // membership check are answered against the runtime role itself.
    await withClient(async client => {
      await client.query(`SET SESSION AUTHORIZATION ${RUNTIME_ROLE}`);
      try {
        await assert.rejects(
          client.query('SELECT public.migrate_legacy_restored_context_exact($1,$2::jsonb)', [ids.ws, manifest]),
          /permission denied|does not exist/i,
        );
        await assert.rejects(
          client.query('SELECT public.restored_context_migration_plan($1,$2,$3,$4,$5)',
            [ids.ws, ids.shiftId, ids.archiveId, 1, ids.migrationOperationId]),
          /permission denied|does not exist/i,
        );
        await assert.rejects(
          client.query('SELECT public.restored_context_source_manifest($1,$2,$3,$4,$5)',
            [ids.ws, ids.shiftId, ids.archiveId, 1, ids.migrationOperationId]),
          /permission denied|does not exist/i,
        );
        await assert.rejects(
          client.query('SET ROLE samosval_migration_evidence_owner'),
          /permission denied|must be member|not permitted/i,
        );
        await assert.rejects(
          client.query('DELETE FROM public.line_history WHERE workspace_id=$1', [ids.ws]),
          /permission denied/i,
        );
        await assert.rejects(
          client.query('ALTER TABLE public.line_history DISABLE TRIGGER ALL'),
          /must be owner of table|permission denied/i,
        );
      } finally {
        await client.query('RESET SESSION AUTHORIZATION');
      }
    });

    // The maintenance executor may read the manifest but may not mutate outside
    // the explicit maintenance window.
    await withClient(async client => {
      await client.query(`SET SESSION AUTHORIZATION ${MAINTENANCE_ROLE}`);
      try {
        await assert.rejects(
          client.query('SELECT public.migrate_legacy_restored_context_exact($1,$2::jsonb)', [ids.ws, manifest]),
          /permission denied|does not exist/i,
        );
        // The read-only plan and the hash-only manifest are exactly what the
        // executor is allowed to read before the window.
        const plan = (await client.query(
          'SELECT public.restored_context_migration_plan($1,$2,$3,$4,$5) AS plan',
          [ids.ws, ids.shiftId, ids.archiveId, 1, ids.migrationOperationId],
        )).rows[0].plan;
        assert.equal(plan.manifest.schema, 'samosval.restored-context-migration/v1');
        const manifestText = (await client.query(
          'SELECT public.restored_context_source_manifest($1,$2,$3,$4,$5) AS manifest',
          [ids.ws, ids.shiftId, ids.archiveId, 1, ids.migrationOperationId],
        )).rows[0].manifest;
        assert.equal(typeof manifestText, 'string');
        assert.deepEqual(JSON.parse(manifestText), plan.manifest);
      } finally {
        await client.query('RESET SESSION AUTHORIZATION');
      }
    });

    await withClient(async client => {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL samosval.migration_bypass = '1'");
        await assert.rejects(
          client.query('SELECT public.migrate_legacy_restored_context_exact($1,$2::jsonb)',
            [ids.ws, tamper(manifest, m => { m.closureHash = 'f'.repeat(64); })]),
          error => code('23514')(error),
        );
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await withClient(async client => {
      await client.query('BEGIN');
      try {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('samosval.restored-context-migration/v1|' || $1 || '|' || $2, 0))`,
          [ids.ws, ids.shiftId],
        );
        await assert.rejects(
          client.query('SELECT public.migrate_legacy_restored_context_exact($1,$2::jsonb)',
            [ids.ws, tamper(manifest, m => { m.counts.line_logs = 99; })]),
          error => code('23514')(error),
        );
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  await t.test('a second evidence on the same source locator is refused', async () => {
    const ids = bySuffix('locator');
    const manifest = await manifestOf(ids);
    // A manual context + evidence claims the exact locator of this fixture.
    await pool.query(
      `INSERT INTO restored_shift_contexts(
         workspace_id,restored_context_id,archive_id,source_shift_id,mode,context_state,
         original_identity_resolution,original_shift_type_resolution,
         restored_by_uid,restored_by_name_snapshot,restored_at,archive_revision,context_revision,
         restore_operation_id,source_state_snapshot,source_shift_revision,opened_at_snapshot,
         object_id,object_name,work_date)
       VALUES($1,'rctx_manual_locator',$2,$3,'standalone','open','unresolved','unresolved',$4,'Manual',now(),1,1,
              'manual_restore','{}'::jsonb,1,now(),$5,'Manual site','2026-11-20')`,
      [ids.ws, ids.archiveId, ids.sourceShiftId, ids.restorerUid, ids.objectId],
    );
    await pool.query(
      `INSERT INTO restored_context_migration_evidence(
         workspace_id,evidence_id,legacy_shift_id,archive_id,base_archive_revision,source_locator,
         source_bytes_sha256,source_counts,source_table_roots,closure_hash,migrated_context_id,migration_operation_id)
       VALUES($1,'11111111-1111-5111-a111-111111111111','manual_shift',$2,1,$3,$4,'{}'::jsonb,'{}'::jsonb,$5,
              'rctx_manual_locator','manual_migration')`,
      [ids.ws, ids.archiveId, manifest.archive.sourceLocator, manifest.archive.sourceBytesSha256, hex()],
    );
    await assert.rejects(
      migrateLegacyRestoredContextExact(pool, ids.ws, manifest),
      error => code('23514')(error) && /migration-locator-claimed/.test(error.message),
    );
  });

  await t.test('a second parent evidence on the same legacy shift is impossible', async () => {
    const ids = bySuffix('second');
    // The schema itself carries the guarantee: one evidence per legacy shift, per
    // migrated context and per source locator, so a second authority cannot even
    // be inserted beside the first.
    await pool.query(
      `INSERT INTO restored_shift_contexts(
         workspace_id,restored_context_id,archive_id,source_shift_id,mode,context_state,
         original_identity_resolution,original_shift_type_resolution,
         restored_by_uid,restored_by_name_snapshot,restored_at,archive_revision,context_revision,
         restore_operation_id,source_state_snapshot,source_shift_revision,opened_at_snapshot,
         object_id,object_name,work_date)
       VALUES($1,'rctx_manual_second',$2,$3,'standalone','open','unresolved','unresolved',$4,'Manual',now(),1,1,
              'manual_restore','{}'::jsonb,1,now(),$5,'Manual site','2026-11-20')`,
      [ids.ws, ids.archiveId, ids.sourceShiftId, ids.restorerUid, ids.objectId],
    );
    await pool.query(
      `INSERT INTO restored_context_migration_evidence(
         workspace_id,evidence_id,legacy_shift_id,archive_id,base_archive_revision,source_locator,
         source_bytes_sha256,source_counts,source_table_roots,closure_hash,migrated_context_id,migration_operation_id)
       VALUES($1,'22222222-2222-5222-a222-222222222222',$2,$3,1,$4,$5,'{}'::jsonb,'{}'::jsonb,$6,
              'rctx_manual_second','manual_migration')`,
      [ids.ws, ids.shiftId, ids.archiveId, 'migration-documents/manual/second',
        'e'.repeat(64), hex()],
    );
    // Same legacy shift, another evidence identity: refused by the unique authority.
    await assert.rejects(
      pool.query(
        `INSERT INTO restored_context_migration_evidence(
           workspace_id,evidence_id,legacy_shift_id,archive_id,base_archive_revision,source_locator,
           source_bytes_sha256,source_counts,source_table_roots,closure_hash,migrated_context_id,migration_operation_id)
         VALUES($1,'33333333-3333-5333-a333-333333333333',$2,$3,1,$4,$5,'{}'::jsonb,'{}'::jsonb,$6,
                'rctx_manual_second','manual_migration')`,
        [ids.ws, ids.shiftId, ids.archiveId, 'migration-documents/manual/third',
          'd'.repeat(64), hex()],
      ),
      error => code('23505')(error),
    );
    // And the migration itself refuses while the source still has an evidence.
    await assert.rejects(
      migrateLegacyRestoredContextExact(pool, ids.ws, await manifestOf(ids)),
      error => code('23514')(error) && /migration-double-authority/.test(error.message),
    );
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM restored_shift_contexts WHERE workspace_id=$1', [ids.ws],
    )).rows[0].n, 1, 'the refused migration wrote no second context');
    assert.equal((await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema='public' AND table_name='restored_context_migration_evidence_rows'
          AND column_name='restored_context_id'`,
    )).rows[0].n, 0, 'the evidence child table never carries a context identity');
  });

  await t.test('a failure after the named trigger disable rolls the source and the trigger back', async () => {
    const ids = bySuffix('rollback');
    const manifest = await manifestOf(ids);
    await pool.query(
      `CREATE OR REPLACE FUNCTION public.p7_fail_shift_delete() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'p7 injected failure'; END $$`,
    );
    await pool.query('CREATE TRIGGER p7_fail_shift_delete BEFORE DELETE ON public.shifts FOR EACH ROW EXECUTE FUNCTION public.p7_fail_shift_delete()');
    try {
      await assert.rejects(
        migrateLegacyRestoredContextExact(pool, ids.ws, manifest),
        /p7 injected failure/,
      );
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS p7_fail_shift_delete ON public.shifts');
      await pool.query('DROP FUNCTION IF EXISTS public.p7_fail_shift_delete()');
    }
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM shifts WHERE workspace_id=$1 AND shift_id=$2', [ids.ws, ids.shiftId],
    )).rows[0].n, 1, 'the source shift anchor is still present');
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM line_logs WHERE workspace_id=$1 AND shift_id=$2', [ids.ws, ids.shiftId],
    )).rows[0].n, 1, 'the source trips are still present');
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM restored_shift_contexts WHERE workspace_id=$1', [ids.ws],
    )).rows[0].n, 0, 'no context was committed');
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM restored_context_migration_evidence WHERE workspace_id=$1', [ids.ws],
    )).rows[0].n, 0, 'no evidence was committed');
    assert.equal((await pool.query(
      'SELECT location FROM archive_overrides WHERE workspace_id=$1 AND record_id=$2', [ids.ws, ids.recordId],
    )).rows[0].location, 'restored', 'the receipt placement rolled back');
    assert.equal((await pool.query(
      `SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.archive_overrides'::regclass
        AND tgname='archive_overrides_restored_receipt_immutable'`,
    )).rows[0].tgenabled, 'O', 'the named trigger is enabled after rollback');
  });

  await t.test('a repeated call with the same manifest is an exact replay', async () => {
    const ids = bySuffix('replay');
    const manifest = await manifestOf(ids);
    const first = await migrateLegacyRestoredContextExact(pool, ids.ws, manifest);
    assert.equal(first.outcome, 'migrated');
    const second = await migrateLegacyRestoredContextExact(pool, ids.ws, manifest);
    assert.equal(second.outcome, 'replayed');
    assert.equal(second.evidenceId, first.evidenceId);
    assert.equal(second.restoredContextId, first.restoredContextId);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM restored_context_migration_evidence WHERE workspace_id=$1', [ids.ws],
    )).rows[0].n, 1);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM restored_shift_contexts WHERE workspace_id=$1', [ids.ws],
    )).rows[0].n, 1);
    // Double authority: the source identity reappears beside its evidence.
    await pool.query(
      'INSERT INTO line_logs(workspace_id,log_id,shift_id,truck_id,payload) VALUES($1,$2,$3,$4,$5)',
      [ids.ws, `log_${ids.suffix}_1`, ids.shiftId, ids.truckId,
        { id: `log_${ids.suffix}_1`, shiftId: ids.shiftId, truckId: ids.truckId, volume: 24 }],
    );
    await assert.rejects(
      migrateLegacyRestoredContextExact(pool, ids.ws, manifest),
      error => code('23514')(error) && /migration-double-authority/.test(error.message),
    );
  });

  await t.test('the maintenance window grants and revokes only the exact signature', async () => {
    const ids = bySuffix('extra');
    const manifest = await manifestOf(ids);
    assert.equal((await migrationAuthorityReport(pool)).maintenanceExecute, false);
    const inside = await withMigrationMaintenanceWindow(pool, async () => {
      assert.equal((await migrationAuthorityReport(pool)).maintenanceExecute, true);
      // The window is proven by a real call from a real maintenance session.
      return withClient(async client => {
        await client.query(`SET SESSION AUTHORIZATION ${MAINTENANCE_ROLE}`);
        try {
          const { rows } = await client.query(
            'SELECT public.migrate_legacy_restored_context_exact($1,$2::jsonb) AS result',
            [ids.ws, JSON.stringify(manifest)],
          );
          return rows[0].result;
        } finally {
          await client.query('RESET SESSION AUTHORIZATION');
        }
      });
    });
    assert.equal(inside.outcome, 'migrated');
    assert.equal(inside.restoredContextId, manifest.contextId);
    assert.equal((await migrationAuthorityReport(pool)).maintenanceExecute, false);
    assert.equal((await migrationAuthorityReport(pool)).runtimeExecute, false);
    await withClient(async client => {
      await client.query(`SET SESSION AUTHORIZATION ${MAINTENANCE_ROLE}`);
      try {
        await assert.rejects(
          client.query('SELECT public.migrate_legacy_restored_context_exact($1,$2::jsonb)', [ids.ws, manifest]),
          /permission denied|does not exist/i,
        );
      } finally {
        await client.query('RESET SESSION AUTHORIZATION');
      }
    });
    assert.equal(MIGRATION_FUNCTION, 'public.migrate_legacy_restored_context_exact(text,jsonb)');
    assert.equal(MAINTENANCE_ROLE, 'samosval_maintenance');
  });

  await t.test('the restore receipt cannot leave location=restored outside the exact migration', async () => {
    const ids = bySuffix('second');
    // A plain UPDATE is refused: only the exact migration closes the receipt.
    await assert.rejects(
      pool.query(
        `UPDATE archive_overrides SET location='archive', revision=revision+1
          WHERE workspace_id=$1 AND record_id=$2`,
        [ids.ws, ids.recordId],
      ),
      error => code('23514')(error) && /legacy restore receipt is immutable/.test(error.message),
    );
    assert.equal((await pool.query(
      'SELECT location FROM archive_overrides WHERE workspace_id=$1 AND record_id=$2',
      [ids.ws, ids.recordId],
    )).rows[0].location, 'restored');
    // A workspace teardown must still be able to delete its own catalog rows.
    await withClient(async client => {
      await client.query('BEGIN');
      try {
        await client.query(
          'DELETE FROM archive_overrides WHERE workspace_id=$1 AND record_id=$2', [ids.ws, ids.recordId],
        );
      } finally {
        await client.query('ROLLBACK');
      }
    });
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM archive_overrides WHERE workspace_id=$1 AND record_id=$2',
      [ids.ws, ids.recordId],
    )).rows[0].n, 1, 'the rolled back delete left the receipt in place');
  });
}

