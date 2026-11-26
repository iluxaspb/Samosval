import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

import { appendReplicaBatch } from '../src/replica-store.mjs';
import {
  bundleFacts,
  captureProvenanceBundle,
  checkpointReplicaBundle,
  normalizeBackupSelection,
  resealBundle,
  restoreReplicaExact,
} from '../src/backup-store.mjs';
import { computeBootstrapFingerprint, verifyRestoreBootstrap } from '../src/restore-bootstrap.mjs';
import {
  applyMigrationsThrough,
  requireIsolatedDatabase,
} from './helpers/isolated-db.mjs';

// Task 15 — full exact provenance backup/bootstrap/restore (design §4.10).
//
// The bundle is indivisible: manifest/schema/checksums/authority and restore
// markers, app_users, objects/trucks, canonical shifts/members/statuses/logs/
// history/detached trips, the complete archive series with every immutable
// revision byte/hash/link/publication, restored contexts with dedicated children
// and migration evidence, historicalization report bytes/confirmations/audit and
// receipts, and the replica stream/heads/pending/cursors/markers.
//
// A request that selects or deselects any replica-owned member, an archive chain
// without source/publication/evidence closure, a restored context without its
// children/audit/receipts or a historical row without its exact report/
// confirmation/audit is rejected during normalization, before checkpoint
// creation, DELETE, INSERT or a restore_epoch mutation.
const connectionString = process.env.TEST_DATABASE_URL;
let approved = false;
if (connectionString && process.env.SAMOSVAL_ISOLATED_TEST === '1') {
  try {
    requireIsolatedDatabase(connectionString);
    approved = true;
  } catch {}
}

const poolForTest = (name) => new pg.Pool({ connectionString, max: 4, application_name: name });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const suffix = () => randomBytes(5).toString('hex');

let adminUid;
let secondAdminUid;
let sequence = 0;

test.before(async () => {
  if (!approved) return;
  // The bundle lives on the S24 clone and the file applies the parallel-shift
  // schema itself: 025 classifies existing rows, so every fixture row is written
  // afterwards through the v2 replica path (docs/opyt-oshibok.md, lesson 41/42).
  await applyMigrationsThrough(25);
  await applyMigrationsThrough(26);
  const pool = poolForTest('zz_exact_backup_setup');
  try {
    adminUid = `exact_admin_${suffix()}`;
    secondAdminUid = `exact_admin2_${suffix()}`;
    for (const uid of [adminUid, secondAdminUid]) {
      await pool.query(
        "INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$1,'admin','active')",
        [uid, `${uid}@example.test`],
      );
    }
  } finally {
    await pool.end();
  }
});

async function newWorkspace(pool, label) {
  const ws = `ws_exact_${label}_${++sequence}_${suffix()}`;
  await pool.query('INSERT INTO workspaces(id) VALUES($1)', [ws]);
  await pool.query('INSERT INTO replica_cursor(workspace_id,f2s_seq,s2f_seq) VALUES($1,0,0)', [ws]);
  await pool.query(
    "INSERT INTO server_authority(workspace_id,provider,generation,reason) VALUES($1,'firebase',1,'fixture')",
    [ws],
  );
  return ws;
}

const pathFor = (ws, collection, documentId) => collection === 'users'
  ? `users/${documentId}`
  : `workspaces/${ws}/${collection}/${documentId}`;

const setOp = (ws, id, collection, documentId, data) => ({
  id,
  protocolVersion: 2,
  kind: 'doc.set',
  payload: {
    collection,
    path: pathFor(ws, collection, documentId),
    data: { ...data, id: documentId },
  },
});

const deleteOp = (ws, id, collection, documentId) => ({
  id,
  protocolVersion: 2,
  kind: 'doc.delete',
  payload: { collection, path: pathFor(ws, collection, documentId) },
});

function shiftData(shiftId, objectId) {
  return {
    payloadSchemaVersion: 2,
    id: shiftId,
    shiftId,
    objectId,
    objectName: 'Exact site',
    startDate: '23.11.2026',
    date: '2026-11-23',
    startedAt: 1795420800000,
    startedBy: 'Exact admin',
    startedByUid: adminUid,
    isActive: true,
    state: 'active',
    workShift: 'day',
    type: 'day',
  };
}

async function append(pool, ws, baseSeq, operations) {
  return appendReplicaBatch(pool, adminUid, { baseSeq, operations }, ws);
}

// A minimal but complete archive closure: series → two hash-linked revisions →
// restored context with a child log/status snapshot/history row, its audit and
// receipts, then the publication that names the finalize/restore receipts.
async function seedArchiveClosure(pool, ws, uid, options = {}) {
  const {
    receipts = 'matching', publication = true, archiveId = 'arch_exact',
    contextId = 'ctx_exact', restoreOperation = 'restore_op_0001',
    finalizeOperation = 'finalize_op_0001',
  } = options;
  const bytes1 = Buffer.from(JSON.stringify({ schema: 'samosval.archive/v1', step: 1 }), 'utf8');
  const bytes2 = Buffer.from(JSON.stringify({ schema: 'samosval.archive/v1', step: 2 }), 'utf8');
  const h1 = sha256(bytes1);
  const h2 = sha256(bytes2);
  const truckId = `${archiveId}_truck`;
  await pool.query(
    'INSERT INTO line_trucks(workspace_id,truck_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [ws, truckId, { name: 'Archive truck' }],
  );
  await pool.query(
    `INSERT INTO shift_archive_series(workspace_id,archive_id,source_shift_id,current_location)
     VALUES($1,$2,$3,'archive')`,
    [ws, archiveId, `source_${archiveId}`],
  );
  for (const [revision, previousRevision, previousSha, bytes, hash] of [
    [1, null, null, bytes1, h1],
    [2, 1, h1, bytes2, h2],
  ]) {
    await pool.query(
      `INSERT INTO shift_archive_revisions(
         workspace_id,archive_id,archive_revision,previous_revision,previous_sha256,
         payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_by_uid)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ws, archiveId, revision, previousRevision, previousSha, bytes, hash,
        revision === 1 ? 1 : 2,
        revision === 1 ? 'legacy-import' : 'restored-context-finalize',
        `${archiveId}/loc/${revision}`, uid],
    );
  }
  await pool.query(
    `UPDATE shift_archive_series SET latest_finalized_revision=2,latest_finalized_sha256=$3
      WHERE workspace_id=$1 AND archive_id=$2`,
    [ws, archiveId, h2],
  );
  await pool.query(
    `INSERT INTO restored_shift_contexts(
       workspace_id,restored_context_id,archive_id,source_shift_id,mode,context_state,
       original_opened_by_uid,original_opened_by_name_snapshot,original_identity_resolution,
       original_shift_type,original_shift_type_resolution,restored_by_uid,
       restored_by_name_snapshot,restored_at,archive_revision,context_revision,
       restore_operation_id,source_state_snapshot,source_shift_revision,opened_at_snapshot,
       object_id,object_name,work_date)
     VALUES($1,$2,$3,$4,'standalone','open',NULL,'author not proven','unresolved',
            NULL,'unresolved',$5,'Exact admin',now(),1,1,$6,'{"logs":[]}'::jsonb,1,now(),
            'site_exact','Exact site','2026-11-23')`,
    [ws, contextId, archiveId, `source_${archiveId}`, uid, restoreOperation],
  );
  await pool.query(
    `INSERT INTO restored_context_logs(
       workspace_id,restored_context_id,log_id,truck_id,payload,log_revision,source_log_id,
       created_from_archive_revision)
     VALUES($1,$2,'ctx_log_1',$3,$4,1,'source_log_1',1)`,
    [ws, contextId, truckId, { id: 'ctx_log_1', truckId, volume: 24, timestamp: 10 }],
  );
  await pool.query(
    `INSERT INTO restored_context_status_snapshots(
       workspace_id,restored_context_id,truck_id,payload,status_revision,cycle_revision,ttn_revision)
     VALUES($1,$2,$3,$4,1,1,1)`,
    [ws, contextId, truckId, { truckId, ttnStatus: true }],
  );
  await pool.query(
    `INSERT INTO restored_context_history(
       workspace_id,action_id,restored_context_id,uid,type,before_log,after_log,revision)
     VALUES($1,'ctx_action_1',$2,$3,'trip.update',$4,$5,1)`,
    [ws, contextId, uid,
      { id: 'ctx_log_1', volume: 24 }, { id: 'ctx_log_1', volume: 24 }],
  );
  await pool.query(
    `INSERT INTO restored_context_audit(
       workspace_id,restored_context_id,action_id,operation_id,uid,type,before_state,after_state)
     VALUES($1,$2,'ctx_action_1','ctx_audit_op_1',$3,'trip.update','{}'::jsonb,'{}'::jsonb)`,
    [ws, contextId, uid],
  );
  const receiptsToWrite = receipts === 'matching'
    ? [restoreOperation, finalizeOperation]
    : receipts === 'other'
      ? ['unrelated_operation_1', 'unrelated_operation_2']
      : [];
  for (const operationId of receiptsToWrite) {
    await pool.query(
      `INSERT INTO archive_operation_receipts(workspace_id,operation_id,archive_id,uid,command_hash,result)
       VALUES($1,$2,$3,$4,$5,'{}'::jsonb)`,
      [ws, operationId, archiveId, uid, sha256(operationId)],
    );
  }
  await pool.query(
    `INSERT INTO restored_context_receipts(
       workspace_id,operation_id,restored_context_id,uid,protocol_version,command_hash,result)
     VALUES($1,'ctx_receipt_op_1',$2,$3,2,$4,'{}'::jsonb)`,
    [ws, contextId, uid, sha256('ctx_receipt_op_1')],
  );
  if (publication) {
    await pool.query(
      `INSERT INTO archive_revision_publications(
         workspace_id,archive_id,archive_revision,restored_context_id,restore_operation_id,
         finalize_operation_id,base_revision,base_sha256,command_hash,published_by_uid)
       VALUES($1,$2,2,$3,$4,$5,1,$6,$7,$8)`,
      [ws, archiveId, contextId, restoreOperation, finalizeOperation, h1, sha256('publish'), uid],
    );
  }
  return { archiveId, contextId, truckId };
}

// The fingerprint published by the privileged bootstrap step. A db child may not
// run the bootstrap itself (it would be DDL/role work), so the fixture captures
// the fingerprint of the already-bootstrapped schema exactly as a backup does.
async function bootstrapFingerprint(pool) {
  return computeBootstrapFingerprint(pool);
}

function factsFor(bundle) {
  return bundleFacts(bundle);
}

// ---------------------------------------------------------------------------
// 1. Normalization: a selective replica/provenance restore is unrepresentable.
// ---------------------------------------------------------------------------
test('selective provenance restore is rejected during normalization', { skip: !approved }, async () => {
  const pool = poolForTest('zz_exact_normalize');
  try {
    const ws = await newWorkspace(pool, 'normalize');
    await append(pool, ws, 0, [
      setOp(ws, 'op_obj_norm', 'objects', 'obj_norm', { name: 'Object' }),
      setOp(ws, 'op_truck_norm', 'trucks', 'truck_norm', { name: 'Truck' }),
      setOp(ws, 'op_shift_norm', 'shift', 'shift_norm', shiftData('shift_norm', 'obj_norm')),
    ]);
    await seedArchiveClosure(pool, ws, adminUid);
    const bundle = await captureProvenanceBundle(pool, ws);
    const facts = factsFor(bundle);

    // Facts themselves prove the bundle carries every indivisible group.
    assert.ok(facts.replica.heads > 0);
    assert.ok(facts.replicaOwned.parents > 0);
    assert.ok(facts.archive.series > 0);
    assert.ok(facts.restored.contexts > 0);

    // A full request is accepted and names every selectable section.
    const full = normalizeBackupSelection({ full: true }, facts);
    assert.equal(full.full, true);
    assert.deepEqual(Object.keys(full.sections).sort(), ['archive', 'base', 'settings', 'shift', 'tabel', 'users']);

    // Any provenance key is unrepresentable: there is no value that could express
    // "restore the replica stream but not its heads".
    for (const key of ['replica', 'provenance', 'restored', 'historical', 'replicaHeads', 'replicaPending']) {
      assert.throws(() => normalizeBackupSelection({ ...full.sections, [key]: true }, facts),
        error => error.code === 'backup-selection-provenance-not-selectable');
    }
    // Deselecting a replica-owned member is not a filter, it is a rejection.
    assert.throws(() => normalizeBackupSelection({ base: true }, facts),
      error => error.code === 'backup-selection-replica-required');
    assert.throws(() => normalizeBackupSelection({ base: true, tabel: true, users: true }, facts),
      error => error.code === 'backup-selection-replica-required');
    // Archive chain, restored children and historical rows are just as indivisible.
    const replicaOnly = { ...full.sections };
    assert.throws(() => normalizeBackupSelection({ ...replicaOnly, archive: false }, facts),
      error => error.code === 'backup-selection-archive-required');
    assert.throws(() => normalizeBackupSelection({ ...replicaOnly, shift: false }, facts),
      error => error.code === 'backup-selection-replica-required');
    // Unknown keys stay a plain schema error, exactly like the legacy path.
    assert.throws(() => normalizeBackupSelection({ ...full.sections, sql: true }, facts),
      error => error.code === 'invalid-backup-sections');

    // A bundle that itself lacks publication/receipt/evidence closure is rejected
    // before anything can be restored.
    const broken = structuredClone(bundle);
    broken.provenance.tables.archive_operation_receipts = [];
    assert.throws(() => normalizeBackupSelection({ full: true }, factsFor(broken)),
      error => error.code === 'backup-selection-archive-closure');
    const brokenContext = structuredClone(bundle);
    brokenContext.provenance.tables.restored_context_audit = [];
    assert.throws(() => normalizeBackupSelection({ full: true }, factsFor(brokenContext)),
      error => error.code === 'backup-selection-restored-closure');
    const brokenHistorical = structuredClone(bundle);
    brokenHistorical.provenance.tables.legacy_historicalization_confirmations = [{
      confirmation_id: 'conf_1', workspace_id: ws, report_sha256: sha256('report'),
    }];
    brokenHistorical.provenance.tables.legacy_cutover_historicalization_audit = [];
    brokenHistorical.provenance.tables.shifts = [{
      ...brokenHistorical.provenance.tables.shifts[0],
      historicalization_report_hash: sha256('report'),
    }];
    assert.throws(() => normalizeBackupSelection({ full: true }, factsFor(brokenHistorical)),
      error => error.code === 'backup-selection-historical-closure');
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// 2. Missing/different bootstrap fails closed before any mutation.
// ---------------------------------------------------------------------------
test('missing or different bootstrap is restore-bootstrap-required before mutation', { skip: !approved }, async () => {
  const pool = poolForTest('zz_exact_bootstrap');
  try {
    const ws = await newWorkspace(pool, 'bootstrap');
    await append(pool, ws, 0, [
      setOp(ws, 'op_obj_boot', 'objects', 'obj_boot', { name: 'Object' }),
    ]);
    const bundle = await captureProvenanceBundle(pool, ws);
    assert.equal(typeof bundle.bootstrap.digest, 'string');
    assert.equal(bundle.bootstrap.version, 1);

    const target = await newWorkspace(pool, 'bootstrap_target');
    const epoch = async workspaceId => Number((await pool.query(
      'SELECT restore_epoch FROM workspaces WHERE id=$1', [workspaceId],
    )).rows[0].restore_epoch);
    const streamCount = async workspaceId => Number((await pool.query(
      'SELECT count(*)::int AS n FROM replica_stream WHERE workspace_id=$1', [workspaceId],
    )).rows[0].n);
    const before = await epoch(target);

    for (const bootstrap of [undefined, null, {}, { ...bundle.bootstrap, digest: 'f'.repeat(64) },
      { ...bundle.bootstrap, version: 999 }]) {
      await assert.rejects(
        restoreReplicaExact(pool, { workspaceId: target, bundle, bootstrap }),
        error => error.code === 'restore-bootstrap-required',
      );
    }
    // Nothing was mutated and no checkpoint row was written.
    assert.equal(await epoch(target), before);
    assert.equal(await streamCount(target), 0);
    assert.equal(Number((await pool.query(
      'SELECT count(*)::int AS n FROM workspace_backups WHERE workspace_id=$1', [target],
    )).rows[0].n), 0);

    // The fingerprint itself is stable and read-only.
    const first = await bootstrapFingerprint(pool);
    const second = await bootstrapFingerprint(pool);
    assert.deepEqual(first, second);
    assert.equal((await verifyRestoreBootstrap(pool, bundle.bootstrap)).digest, bundle.bootstrap.digest);
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// 3. The data path cannot DDL, create a role, an admin or registration code.
// ---------------------------------------------------------------------------
test('the data path performs no DDL and creates no role, admin or registration code', { skip: !approved }, async () => {
  const inner = poolForTest('zz_exact_noddl');
  const ddl = /^\s*(?:CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT|TRUNCATE|SET\s+ROLE|SET\s+SESSION\s+AUTHORIZATION|COPY\b[\s\S]*FROM\s+PROGRAM)\b/i;
  const statements = [];
  const guarded = {
    connect: async () => {
      const client = await inner.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return (text, ...rest) => {
              const sql = typeof text === 'string' ? text : text?.text ?? '';
              statements.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
              if (ddl.test(sql)) {
                throw Object.assign(new Error('ddl-forbidden-in-data-path'), { code: 'ddl-forbidden' });
              }
              return target.query(text, ...rest);
            };
          }
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    end: () => inner.end(),
  };
  try {
    const ws = await newWorkspace(inner, 'noddl');
    await append(inner, ws, 0, [
      setOp(inner, 'op_obj_noddl', 'objects', 'obj_noddl', { name: 'Object' }),
    ]);
    // Bundle data that looks like an administrator: it must be restored as a row,
    // never by creating a role, a login or a registration code.
    const bundleAdminUid = `bundle_admin_${suffix()}`;
    await inner.query(
      "INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$1,'admin','active')",
      [bundleAdminUid, `${bundleAdminUid}@example.test`],
    );
    const bundle = await captureProvenanceBundle(inner, ws);
    const target = await newWorkspace(inner, 'noddl_target');
    const rolesBefore = Number((await inner.query('SELECT count(*)::int AS n FROM pg_roles')).rows[0].n);
    const registrationsBefore = Number((await inner.query(
      'SELECT count(*)::int AS n FROM registration_requests',
    )).rows[0].n);

    const result = await restoreReplicaExact(guarded, {
      workspaceId: target, bundle, bootstrap: bundle.bootstrap,
    });
    assert.equal(result.outcome, 'confirmed');
    assert.ok(statements.length > 0);
    // No statement in the data path is DDL, role or registration work.
    assert.equal(statements.some(statement => /^(CREATE|ALTER|DROP|GRANT|REVOKE)/i.test(statement)), false);
    assert.equal(statements.some(statement => /^SET ROLE/i.test(statement)), false);
    assert.equal(Number((await inner.query('SELECT count(*)::int AS n FROM pg_roles')).rows[0].n), rolesBefore);
    assert.equal(Number((await inner.query(
      'SELECT count(*)::int AS n FROM registration_requests',
    )).rows[0].n), registrationsBefore);
    // The app role really has no path to create a role, and the restored admin is
    // bundle data, not a capability.
    await assert.rejects(inner.query('CREATE ROLE forbidden_probe NOLOGIN'),
      error => error.code === '42501');
    const restoredAdmin = await inner.query(
      'SELECT role,status FROM app_users WHERE uid=$1', [bundleAdminUid],
    );
    assert.equal(restoredAdmin.rows[0].role, 'admin');
  } finally {
    await guarded.end();
  }
});

// ---------------------------------------------------------------------------
// 4. Publication before its receipts fails at the explicit constraint checkpoint.
// ---------------------------------------------------------------------------
test('archive publication before receipts fails at SET CONSTRAINTS ALL IMMEDIATE', { skip: !approved }, async () => {
  const pool = poolForTest('zz_exact_checkpoint');
  const client = await pool.connect();
  try {
    const ws = await newWorkspace(pool, 'checkpoint');
    // A dangling publication cannot be committed, so the closure is seeded
    // without it and the publication is inserted inside the checked transaction.
    const archive = await seedArchiveClosure(pool, ws, adminUid, { publication: false, receipts: 'none' });
    const baseSha = (await pool.query(
      `SELECT payload_sha256 FROM shift_archive_revisions
        WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=1`,
      [ws, archive.archiveId],
    )).rows[0].payload_sha256;
    const insertPublication = (query = client.query.bind(client)) => query(
      `INSERT INTO archive_revision_publications(
         workspace_id,archive_id,archive_revision,restored_context_id,restore_operation_id,
         finalize_operation_id,base_revision,base_sha256,command_hash,published_by_uid)
       VALUES($1,$2,2,$3,'restore_op_0001','finalize_op_0001',1,$4,$5,$6)`,
      [ws, archive.archiveId, archive.contextId, baseSha, sha256('publish'), adminUid],
    );

    // A dangling publication is accepted by its immediate FKs, so only the
    // deferred receipt FKs can stop it at the explicit checkpoint.
    await client.query('BEGIN');
    try {
      await insertPublication();
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      assert.fail('the deferred receipt FK must fail at the constraint checkpoint');
    } catch (error) {
      assert.equal(error.code, '23503');
      assert.match(String(error.constraint), /fk_archive_publication_(restore|finalize)_receipt/);
    } finally {
      await client.query('ROLLBACK');
    }
    // The checkpoint is what fails: the same publication plus both receipts passes.
    await client.query('BEGIN');
    try {
      await insertPublication();
      for (const operationId of ['restore_op_0001', 'finalize_op_0001']) {
        await client.query(
          `INSERT INTO archive_operation_receipts(workspace_id,operation_id,archive_id,uid,command_hash,result)
           VALUES($1,$2,$3,$4,$5,'{}'::jsonb)`,
          [ws, operationId, archive.archiveId, adminUid, sha256(operationId)],
        );
      }
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      const ok = (await client.query(
        'SELECT count(*)::int AS n FROM archive_revision_publications WHERE workspace_id=$1', [ws],
      )).rows[0].n;
      assert.equal(ok, 1);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// 5. Missing/dangling receipts roll back before verifier and restore epoch.
// ---------------------------------------------------------------------------
test('missing publication receipts roll back before verifier and restore epoch', { skip: !approved }, async () => {
  const pool = poolForTest('zz_exact_receipts');
  try {
    const ws = await newWorkspace(pool, 'receipts');
    await append(pool, ws, 0, [
      setOp(ws, 'op_obj_rcpt', 'objects', 'obj_rcpt', { name: 'Object' }),
    ]);
    const archive = await seedArchiveClosure(pool, ws, adminUid);
    const bundle = await captureProvenanceBundle(pool, ws);
    // Receipts exist (closure count is satisfied) but none matches the published
    // operation ids: this is a dangling publication, not a normalization failure.
    bundle.provenance.tables.archive_operation_receipts = [
      {
        workspace_id: ws, operation_id: 'unrelated_operation_1', archive_id: archive.archiveId,
        uid: adminUid, command_hash: sha256('unrelated_operation_1'), result: {},
        recorded_at: new Date().toISOString(),
      },
      {
        workspace_id: ws, operation_id: 'unrelated_operation_2', archive_id: archive.archiveId,
        uid: adminUid, command_hash: sha256('unrelated_operation_2'), result: {},
        recorded_at: new Date().toISOString(),
      },
    ];
    resealBundle(bundle);
    assert.doesNotThrow(() => normalizeBackupSelection({ full: true }, factsFor(bundle)));

    const target = await newWorkspace(pool, 'receipts_target');
    const epoch = async workspaceId => Number((await pool.query(
      'SELECT restore_epoch FROM workspaces WHERE id=$1', [workspaceId],
    )).rows[0].restore_epoch);
    const before = await epoch(target);
    await assert.rejects(
      restoreReplicaExact(pool, {
        workspaceId: target, bundle, bootstrap: bundle.bootstrap, allowWorkspaceRemap: true,
      }),
      error => error.code === 'restore-constraint-checkpoint-failed',
    );
    assert.equal(await epoch(target), before);
    // The whole data transaction rolled back: no archive row, no stream row.
    for (const table of ['shift_archive_series', 'shift_archive_revisions', 'archive_revision_publications',
      'restored_shift_contexts', 'replica_stream']) {
      assert.equal(Number((await pool.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`, [target],
      )).rows[0].n), 0, `${table} must be empty after the rollback`);
    }
    // The matching bundle restores, and only then the epoch moves.
    const good = await captureProvenanceBundle(pool, await (async () => {
      const fixed = await newWorkspace(pool, 'receipts_fixed');
      await append(pool, fixed, 0, [
        setOp(fixed, 'op_obj_fix', 'objects', 'obj_fix', { name: 'Object' }),
      ]);
      await seedArchiveClosure(pool, fixed, adminUid);
      return fixed;
    })());
    await restoreReplicaExact(pool, {
      workspaceId: target, bundle: good, bootstrap: good.bootstrap, allowWorkspaceRemap: true,
    });
    assert.equal(await epoch(target), before + 1);
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// 6. Exact pending/tombstone restore, then parent arrival promotes exactly once.
// ---------------------------------------------------------------------------
test('exact pending and tombstone restore keeps bytes and promotes once', { skip: !approved }, async () => {
  const pool = poolForTest('zz_exact_pending');
  try {
    const ws = await newWorkspace(pool, 'pending_source');
    const objectId = 'obj_exact';
    const shiftId = 'shift_exact';
    const truckId = 'truck_exact';
    const deletedTruckId = 'truck_deleted';
    await append(pool, ws, 0, [
      setOp(ws, 'op_obj_exact', 'objects', objectId, { name: 'Object' }),
      setOp(ws, 'op_shift_exact', 'shift', shiftId, shiftData(shiftId, objectId)),
      // The truck is missing: this status can only be pending.
      setOp(ws, 'op_status_exact', 'truckStatus', truckId, { shiftId, onLine: true }),
      // A settled delete with no canonical row and no parents.
      deleteOp(ws, 'op_delete_exact', 'truckStatus', deletedTruckId),
    ]);
    // A lifecycle-extended v2 payload (prepare/close snapshots add keys beyond the
    // published 14) must round-trip byte-exactly. The restore inserts the
    // published subset through the strict bridge and then rewrites the exact
    // captured row in the same transaction.
    await pool.query(
      `UPDATE shifts SET payload = payload || '{"closedAt":1795420900000}'::jsonb
        WHERE workspace_id=$1 AND shift_id=$2`,
      [ws, shiftId],
    );
    const source = await checkpointReplicaBundle(pool, ws);
    assert.equal(source.present, true);
    assert.equal(source.pending.length, 1);
    assert.equal(source.heads.filter(head => head.head_kind === 'doc.delete').length, 1);

    const bundle = await captureProvenanceBundle(pool, ws);
    assert.equal(bundle.provenance.replica.digest, source.digest);

    const target = await newWorkspace(pool, 'pending_target');
    const epochBefore = Number((await pool.query(
      'SELECT restore_epoch FROM workspaces WHERE id=$1', [target],
    )).rows[0].restore_epoch);
    const result = await restoreReplicaExact(pool, {
      workspaceId: target,
      bundle,
      bootstrap: bundle.bootstrap,
      // The bundle is restored into an empty isolated target workspace; the
      // contract requires an empty target because replica_stream is append-only.
      allowWorkspaceRemap: true,
    });
    assert.equal(result.outcome, 'confirmed');
    assert.equal(result.verifier.replicaDigest, source.digest);

    // Exact bytes: the checkpoint of the target is the source checkpoint.
    const restored = await checkpointReplicaBundle(pool, target);
    assert.equal(restored.digest, source.digest);
    assert.deepEqual(
      restored.stream.map(row => [Number(row.seq), row.operation_id, row.sha256, row.protocol_version]),
      source.stream.map(row => [Number(row.seq), row.operation_id, row.sha256, row.protocol_version]),
    );
    assert.equal(restored.cursor.f2s_seq, source.cursor.f2s_seq);
    assert.equal(restored.pending[0].missing_truck, true);
    assert.equal(Number(restored.pending[0].stream_seq), Number(source.pending[0].stream_seq));
    // The lifecycle-extended payload survives the insert-then-rewrite path exactly.
    const restoredShift = (await pool.query(
      'SELECT payload FROM shifts WHERE workspace_id=$1 AND shift_id=$2', [target, shiftId],
    )).rows[0];
    assert.equal(restoredShift.payload.closedAt, 1795420900000);
    const deletedHead = restored.heads.find(head => head.collection === 'truckStatus'
      && head.document_id === deletedTruckId);
    assert.equal(deletedHead.head_kind, 'doc.delete');
    assert.equal(Number(deletedHead.applied_seq), Number(deletedHead.head_seq));
    assert.equal(deletedHead.canonical_present, false);

    // Parent arrival promotes the staged status exactly once.
    const cursor = Number(restored.cursor.f2s_seq);
    await append(pool, target, cursor, [
      setOp(target, 'op_truck_exact', 'trucks', truckId, { name: 'Truck' }),
    ]);
    const status = (await pool.query(
      'SELECT shift_id,payload FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2',
      [target, truckId],
    )).rows[0];
    assert.equal(status.shift_id, shiftId);
    const promotedHead = (await pool.query(
      `SELECT head_seq,head_kind,canonical_present,applied_seq FROM replica_document_heads
        WHERE workspace_id=$1 AND collection='truckStatus' AND document_id=$2`, [target, truckId],
    )).rows[0];
    assert.equal(promotedHead.canonical_present, true);
    assert.equal(Number(promotedHead.applied_seq), Number(promotedHead.head_seq));
    assert.equal(Number((await pool.query(
      'SELECT count(*)::int AS n FROM replica_pending_documents WHERE workspace_id=$1', [target],
    )).rows[0].n), 0);
    // Replaying the same parent operation is a no-op: promotion happens once.
    const replay = await append(pool, target, cursor + 1, [
      setOp(target, 'op_truck_exact', 'trucks', truckId, { name: 'Truck' }),
    ]);
    assert.equal(replay.applied, 0);
    assert.equal(Number((await pool.query(
      'SELECT count(*)::int AS n FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2',
      [target, truckId],
    )).rows[0].n), 1);
    // The restored tombstone is not resurrected by any later arrival.
    await append(pool, target, cursor + 1, [
      setOp(target, 'op_shift_deleted', 'shift', shiftId, shiftData(shiftId, objectId)),
    ]);
    assert.equal(Number((await pool.query(
      'SELECT count(*)::int AS n FROM line_truck_statuses WHERE workspace_id=$1 AND truck_id=$2',
      [target, deletedTruckId],
    )).rows[0].n), 0);
    assert.equal(await epochOf(pool, target), epochBefore + 1);
  } finally {
    await pool.end();
  }
});

async function epochOf(pool, workspaceId) {
  return Number((await pool.query(
    'SELECT restore_epoch FROM workspaces WHERE id=$1', [workspaceId],
  )).rows[0].restore_epoch);
}

// ---------------------------------------------------------------------------
// 7. A selective request never reaches checkpoint, DELETE, INSERT or epoch.
// ---------------------------------------------------------------------------
test('a selective restore request is rejected before checkpoint or mutation', { skip: !approved }, async () => {
  const pool = poolForTest('zz_exact_selective');
  try {
    const ws = await newWorkspace(pool, 'selective_source');
    await append(pool, ws, 0, [
      setOp(ws, 'op_obj_sel', 'objects', 'obj_sel', { name: 'Object' }),
      setOp(ws, 'op_shift_sel', 'shift', 'shift_sel', shiftData('shift_sel', 'obj_sel')),
    ]);
    const bundle = await captureProvenanceBundle(pool, ws);
    const target = await newWorkspace(pool, 'selective_target');
    const epochBefore = await epochOf(pool, target);

    await assert.rejects(
      restoreReplicaExact(pool, {
        workspaceId: target,
        bundle,
        bootstrap: bundle.bootstrap,
        selection: { base: true },
        allowWorkspaceRemap: true,
      }),
      error => error.code === 'backup-selection-replica-required',
    );
    await assert.rejects(
      restoreReplicaExact(pool, {
        workspaceId: target,
        bundle,
        bootstrap: bundle.bootstrap,
        selection: { ...normalizeBackupSelection({ full: true }, factsFor(bundle)).sections, replica: true },
        allowWorkspaceRemap: true,
      }),
      error => error.code === 'backup-selection-provenance-not-selectable',
    );
    assert.equal(await epochOf(pool, target), epochBefore);
    assert.equal(Number((await pool.query(
      'SELECT count(*)::int AS n FROM workspace_backups WHERE workspace_id=$1', [target],
    )).rows[0].n), 0);
    assert.equal(Number((await pool.query(
      'SELECT count(*)::int AS n FROM replica_stream WHERE workspace_id=$1', [target],
    )).rows[0].n), 0);
    assert.equal(Number((await pool.query(
      'SELECT count(*)::int AS n FROM shifts WHERE workspace_id=$1', [target],
    )).rows[0].n), 0);
  } finally {
    await pool.end();
  }
});
