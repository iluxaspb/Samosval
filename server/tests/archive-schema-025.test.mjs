import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';

import {
  applyMigrationsThrough,
  requireIsolatedDatabase,
  resetIsolatedDatabase,
} from './helpers/isolated-db.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
let approved = false;
if (connectionString && process.env.SAMOSVAL_ISOLATED_TEST === '1') {
  try { requireIsolatedDatabase(connectionString); approved = true; } catch {}
}

const sha = value => createHash('sha256').update(value).digest('hex');
const bytesOf = value => Buffer.from(JSON.stringify(value), 'utf8');

const WS = 'workspace_archive_025';
const FOREIGN_WS = 'workspace_archive_025_foreign';
const TRUCK = 'truck_archive_025';
const ADMIN = 'admin_archive_025';
const OTHER = 'user_archive_025';

// The exact append-only set of the archive block (design §4.6).
const APPEND_ONLY_TABLES = [
  'shift_archive_revisions',
  'archive_operation_receipts',
  'archive_revision_publications',
  'restored_context_status_snapshots',
  'restored_context_history',
  'restored_context_receipts',
  'restored_context_audit',
  'restored_context_migration_evidence',
  'restored_context_migration_evidence_rows',
  'archive_audit',
];

const SOURCE_ALLOW_LIST = [
  'workspace_service_audit', 'workspace_service_receipts',
  'line_audit', 'line_operation_receipts',
  'line_history', 'history_audit', 'history_receipts',
  'shift_operation_receipts',
];

const ARCHIVE_TABLES = [
  'shift_archive_series',
  'shift_archive_revisions',
  'archive_operation_receipts',
  'archive_revision_publications',
  'restored_shift_contexts',
  'restored_context_logs',
  'restored_context_status_snapshots',
  'restored_context_history',
  'restored_context_receipts',
  'restored_context_audit',
  'restored_context_migration_evidence',
  'restored_context_migration_evidence_rows',
  'archive_audit',
];

const migrationUrl = new URL('../sql/025_parallel_shifts_core.sql', import.meta.url);
const BLOCK_MARKER = '-- Immutable archive chain and dedicated restored contexts (Task 6, design §4.6).';

async function archiveBlock() {
  const source = await readFile(migrationUrl, 'utf8');
  const start = source.indexOf(BLOCK_MARKER);
  assert.notEqual(start, -1, 'the archive block must exist in 025');
  return source.slice(start);
}

// ---------- source contract (no database needed) ----------

test('archive block declares exactly two deferrable publication receipt FKs', async () => {
  const block = await archiveBlock();
  assert.equal(
    block.split('DEFERRABLE INITIALLY DEFERRED').length - 1,
    2,
    'exactly the two publication receipt FKs are deferred',
  );
  for (const name of ['fk_archive_publication_restore_receipt', 'fk_archive_publication_finalize_receipt']) {
    const at = block.indexOf(name);
    assert.notEqual(at, -1, `${name} must be named in the block`);
    const constraint = block.slice(at, at + 400);
    assert.match(constraint, /REFERENCES archive_operation_receipts\(workspace_id, operation_id\)/);
    assert.match(constraint, /ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED/);
  }
});

test('archive block creates no synthetic current state and guards evidence ownership', async () => {
  const block = await archiveBlock();
  assert.match(block, /ALTER TABLE public\.%I OWNER TO samosval_migration_evidence_owner/);
  assert.match(block, /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'samosval_migration_evidence_owner'\)/);
  for (const forbidden of ['replica_placeholder', 'extract(hour)', 'inferred', 'INSERT INTO shifts', 'INSERT INTO line_logs']) {
    assert.equal(block.includes(forbidden), false, `the archive block must not contain ${forbidden}`);
  }
  // Every append-only table gets the named guard pair, never a bare table.
  for (const table of APPEND_ONLY_TABLES) {
    assert.match(block, new RegExp(`CREATE TRIGGER ${table}_append_only\\b`), `${table} row guard`);
    assert.match(block, new RegExp(`CREATE TRIGGER ${table}_no_truncate\\b`), `${table} truncate guard`);
  }
});

// ---------- database helpers ----------

async function withClient(fn) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function inTransaction(client, fn) {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

const code = expected => error => {
  assert.equal(error.code, expected, `expected SQLSTATE ${expected}, got ${error.code}: ${error.message}`);
  return true;
};

async function createSeries(client, archiveId, { shiftId = `shift_${archiveId}`, workspaceId = WS } = {}) {
  await client.query(
    `INSERT INTO shift_archive_series(workspace_id,archive_id,source_shift_id) VALUES($1,$2,$3)`,
    [workspaceId, archiveId, shiftId],
  );
  return { workspaceId, archiveId, shiftId };
}

async function addRevision(client, series, {
  revision,
  previous = null,
  payload = { archiveId: series.archiveId, archiveRevision: revision },
  locator = `legacy:${series.archiveId}:${revision}`,
  sha256 = null,
  schemaVersion = 2,
  sourceKind = 'legacy-import',
  actor = ADMIN,
} = {}) {
  const bytes = bytesOf(payload);
  const digest = sha256 ?? sha(bytes);
  await client.query(
    `INSERT INTO shift_archive_revisions(
       workspace_id,archive_id,archive_revision,previous_revision,previous_sha256,
       payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_by_uid)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      series.workspaceId, series.archiveId, revision,
      previous?.revision ?? null, previous?.sha256 ?? null,
      bytes, digest, schemaVersion, sourceKind, locator, actor,
    ],
  );
  return { revision, sha256: digest, bytes };
}

async function createContext(client, series, revision, {
  contextId = `ctx_${series.archiveId}`,
  state = 'finalized',
  mode = 'standalone',
  actor = ADMIN,
  openedBy = ADMIN,
  operationId = `op_restore_${series.archiveId}`,
} = {}) {
  await client.query(
    `INSERT INTO restored_shift_contexts(
       workspace_id,restored_context_id,archive_id,source_shift_id,mode,context_state,
       original_opened_by_uid,original_opened_by_name_snapshot,original_identity_resolution,
       original_shift_type,original_shift_type_resolution,
       restored_by_uid,restored_by_name_snapshot,restored_at,
       archive_revision,context_revision,restore_operation_id,
       source_state_snapshot,source_shift_revision,opened_at_snapshot,
       object_id,object_name,work_date)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'source','day','source',$9,$10,now(),
            $11,1,$12,'{}'::jsonb,1,now(),'object_archive_025','Объект',DATE '2026-11-23')`,
    [
      series.workspaceId, contextId, series.archiveId, series.shiftId, mode, state,
      openedBy, openedBy, actor, actor, revision.revision, operationId,
    ],
  );
  return { workspaceId: series.workspaceId, contextId };
}

async function addReceipt(client, archiveId, operationId, actor = ADMIN) {
  await client.query(
    `INSERT INTO archive_operation_receipts(workspace_id,operation_id,archive_id,uid,command_hash,result)
     VALUES($1,$2,$3,$4,$5,'{}'::jsonb)`,
    [WS, operationId, archiveId, actor, sha(operationId)],
  );
}

async function publish(client, series, context, {
  archiveRevision,
  baseRevision,
  baseSha256,
  restoreOperationId = `op_restore_${series.archiveId}`,
  finalizeOperationId = `op_finalize_${series.archiveId}`,
  actor = ADMIN,
} = {}) {
  await client.query(
    `INSERT INTO archive_revision_publications(
       workspace_id,archive_id,archive_revision,restored_context_id,
       restore_operation_id,finalize_operation_id,base_revision,base_sha256,
       command_hash,published_by_uid)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      series.workspaceId, series.archiveId, archiveRevision, context.contextId,
      restoreOperationId, finalizeOperationId, baseRevision, baseSha256,
      sha(`${series.archiveId}:${archiveRevision}`), actor,
    ],
  );
}

test.before(async () => {
  if (!approved) return;
  await resetIsolatedDatabase();
  await applyMigrationsThrough(25);
  await withClient(async client => {
    await client.query('INSERT INTO workspaces(id) VALUES($1) ON CONFLICT(id) DO NOTHING', [WS]);
    await client.query('INSERT INTO workspaces(id) VALUES($1) ON CONFLICT(id) DO NOTHING', [FOREIGN_WS]);
    for (const uid of [ADMIN, OTHER]) {
      await client.query(
        `INSERT INTO app_users(uid,email,display_name,role,status)
         VALUES($1,$2,$3,'admin','active') ON CONFLICT(uid) DO NOTHING`,
        [uid, `${uid}@example.test`, uid],
      );
    }
    await client.query(
      `INSERT INTO line_trucks(workspace_id,truck_id,payload)
       VALUES($1,$2,$3) ON CONFLICT(workspace_id,truck_id) DO NOTHING`,
      [WS, TRUCK, { id: TRUCK }],
    );
  });
});

// ---------- 1. immutable revision chain ----------

test('revision chain requires the exact previous revision and hash', { skip: !approved }, async () => {
  await withClient(async client => {
    const series = await createSeries(client, 'archive_chain');

    // Revision 1 can never carry a predecessor pointer.
    await assert.rejects(
      client.query(
        `INSERT INTO shift_archive_revisions(
           workspace_id,archive_id,archive_revision,previous_revision,previous_sha256,
           payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_by_uid)
         VALUES($1,'archive_chain',1,0,$2,$3,$4,2,'legacy-import','legacy:chain:1',$5)`,
        [WS, sha('previous'), bytesOf({ r: 1 }), sha(bytesOf({ r: 1 })), ADMIN],
      ),
      code('23514'),
    );
    // Revision zero does not exist.
    await assert.rejects(
      client.query(
        `INSERT INTO shift_archive_revisions(
           workspace_id,archive_id,archive_revision,payload_bytes,payload_sha256,
           payload_schema_version,source_kind,source_locator,created_by_uid)
         VALUES($1,'archive_chain',0,$2,$3,2,'legacy-import','legacy:chain:0',$4)`,
        [WS, bytesOf({ r: 0 }), sha(bytesOf({ r: 0 })), ADMIN],
      ),
      code('23514'),
    );

    const first = await addRevision(client, series, { revision: 1 });

    // Wrong previous revision number breaks the chain step.
    await assert.rejects(
      addRevision(client, series, { revision: 2, previous: { revision: 0, sha256: first.sha256 }, payload: { r: 'wrong-step' } }),
      code('23514'),
    );
    // Right number, wrong hash is a dangling predecessor (FK).
    await assert.rejects(
      addRevision(client, series, { revision: 2, previous: { revision: 1, sha256: sha('not-the-bytes') }, payload: { r: 'wrong-hash' } }),
      code('23503'),
    );

    const second = await addRevision(client, series, { revision: 2, previous: first });
    assert.equal(second.revision, 2);

    // Skipping a step is impossible.
    await assert.rejects(
      addRevision(client, series, { revision: 4, previous: second, payload: { r: 'skip' } }),
      code('23514'),
    );
  });
});

// ---------- 2. byte authority ----------

test('payload_sha256 is computed from the authoritative payload bytes', { skip: !approved }, async () => {
  await withClient(async client => {
    const series = await createSeries(client, 'archive_bytes');
    const bytes = bytesOf({ authoritative: true });
    await assert.rejects(
      addRevision(client, series, { revision: 1, payload: { authoritative: true }, sha256: sha('other bytes') }),
      code('23514'),
    );
    const stored = await addRevision(client, series, { revision: 1, payload: { authoritative: true } });
    const row = (await client.query(
      'SELECT payload_bytes,payload_sha256 FROM shift_archive_revisions WHERE workspace_id=$1 AND archive_id=$2 AND archive_revision=1',
      [WS, series.archiveId],
    )).rows[0];
    assert.equal(Buffer.compare(row.payload_bytes, bytes), 0, 'exact bytes are stored, not a reserialization');
    assert.equal(row.payload_sha256, stored.sha256);
    assert.equal(row.payload_sha256, sha(row.payload_bytes));
  });
});

// ---------- 3. uniqueness ----------

test('canonical archive bytes and source locators are unique', { skip: !approved }, async () => {
  await withClient(async client => {
    const series = await createSeries(client, 'archive_unique');
    const first = await addRevision(client, series, { revision: 1 });
    // Identical bytes may not become a second revision of the same archive.
    await assert.rejects(
      addRevision(client, series, { revision: 2, previous: first, payload: { archiveId: 'archive_unique', archiveRevision: 1 } }),
      code('23505'),
    );
    // One source document may not be claimed by two archives.
    const other = await createSeries(client, 'archive_unique_other');
    await assert.rejects(
      addRevision(client, other, { revision: 1, locator: `legacy:${series.archiveId}:1` }),
      code('23505'),
    );
  });
});

// ---------- 4. the single default pointer ----------

test('latest_finalized_* must name an existing revision and its exact hash', { skip: !approved }, async () => {
  await withClient(async client => {
    const series = await createSeries(client, 'archive_pointer');
    const first = await addRevision(client, series, { revision: 1 });
    const second = await addRevision(client, series, { revision: 2, previous: first });

    await assert.rejects(
      client.query(
        'UPDATE shift_archive_series SET latest_finalized_revision=9,latest_finalized_sha256=$3 WHERE workspace_id=$1 AND archive_id=$2',
        [WS, series.archiveId, sha('ghost')],
      ),
      code('23503'),
    );
    await assert.rejects(
      client.query(
        'UPDATE shift_archive_series SET latest_finalized_revision=1,latest_finalized_sha256=$3 WHERE workspace_id=$1 AND archive_id=$2',
        [WS, series.archiveId, sha('mismatch')],
      ),
      code('23503'),
    );
    // Half a pointer is not a pointer.
    await assert.rejects(
      client.query(
        'UPDATE shift_archive_series SET latest_finalized_revision=1 WHERE workspace_id=$1 AND archive_id=$2',
        [WS, series.archiveId],
      ),
      code('23514'),
    );
    await client.query(
      'UPDATE shift_archive_series SET latest_finalized_revision=2,latest_finalized_sha256=$3 WHERE workspace_id=$1 AND archive_id=$2',
      [WS, series.archiveId, second.sha256],
    );
    const pointer = (await client.query(
      'SELECT latest_finalized_revision::text AS revision,latest_finalized_sha256 FROM shift_archive_series WHERE workspace_id=$1 AND archive_id=$2',
      [WS, series.archiveId],
    )).rows[0];
    assert.deepEqual(pointer, { revision: '2', latest_finalized_sha256: second.sha256 });
  });
});

// ---------- 5. deferred publication receipts ----------

test('publication may precede its receipts in one transaction but not commit without them', { skip: !approved }, async () => {
  await withClient(async client => {
    // Positive: publication first, receipts later, one transaction.
    const series = await createSeries(client, 'archive_publication_ok');
    const base = await addRevision(client, series, { revision: 1 });
    const next = await addRevision(client, series, { revision: 2, previous: base });
    const context = await createContext(client, series, next);
    await inTransaction(client, async () => {
      await publish(client, series, context, {
        archiveRevision: next.revision, baseRevision: base.revision, baseSha256: base.sha256,
      });
      // The receipt links are deferred: they do not exist yet at this point.
      const pending = (await client.query(
        'SELECT count(*)::int AS n FROM archive_operation_receipts WHERE workspace_id=$1 AND operation_id = ANY($2)',
        [WS, [`op_restore_${series.archiveId}`, `op_finalize_${series.archiveId}`]],
      )).rows[0].n;
      assert.equal(pending, 0);
      await addReceipt(client, series.archiveId, `op_restore_${series.archiveId}`);
      await addReceipt(client, series.archiveId, `op_finalize_${series.archiveId}`);
    });
    assert.equal((await client.query(
      'SELECT count(*)::int AS n FROM archive_revision_publications WHERE workspace_id=$1 AND archive_id=$2',
      [WS, series.archiveId],
    )).rows[0].n, 1);

    // Negative: a dangling publication must fail at commit, not at insert.
    const dangling = await createSeries(client, 'archive_publication_dangling');
    const danglingBase = await addRevision(client, dangling, { revision: 1 });
    const danglingNext = await addRevision(client, dangling, { revision: 2, previous: danglingBase });
    const danglingContext = await createContext(client, dangling, danglingNext);
    await client.query('BEGIN');
    await publish(client, dangling, danglingContext, {
      archiveRevision: danglingNext.revision, baseRevision: danglingBase.revision, baseSha256: danglingBase.sha256,
    });
    await assert.rejects(client.query('COMMIT'), code('23503'));
    await client.query('ROLLBACK').catch(() => {});
    assert.equal((await client.query(
      'SELECT count(*)::int AS n FROM archive_revision_publications WHERE workspace_id=$1 AND archive_id=$2',
      [WS, dangling.archiveId],
    )).rows[0].n, 0);

    // One publication per context and per finalize operation.
    const second = await createSeries(client, 'archive_publication_unique');
    const secondBase = await addRevision(client, second, { revision: 1 });
    const secondNext = await addRevision(client, second, { revision: 2, previous: secondBase });
    const secondContext = await createContext(client, second, secondNext);
    await addReceipt(client, second.archiveId, `op_restore_${second.archiveId}`);
    await addReceipt(client, second.archiveId, `op_finalize_${second.archiveId}`);
    await publish(client, second, secondContext, {
      archiveRevision: secondNext.revision, baseRevision: secondBase.revision, baseSha256: secondBase.sha256,
    });
    const third = await createSeries(client, 'archive_publication_unique_3');
    const thirdBase = await addRevision(client, third, { revision: 1 });
    const thirdNext = await addRevision(client, third, { revision: 2, previous: thirdBase });
    const thirdContext = await createContext(client, third, thirdNext);
    await addReceipt(client, third.archiveId, `op_restore_${third.archiveId}`);
    await addReceipt(client, third.archiveId, `op_finalize_${third.archiveId}`);
    // Same context again -> unique context.
    await assert.rejects(
      publish(client, third, secondContext, {
        archiveRevision: thirdNext.revision, baseRevision: thirdBase.revision, baseSha256: thirdBase.sha256,
      }),
      code('23505'),
    );
    // Same finalize operation for another context -> unique finalize operation.
    await assert.rejects(
      publish(client, third, thirdContext, {
        archiveRevision: thirdNext.revision, baseRevision: thirdBase.revision, baseSha256: thirdBase.sha256,
        finalizeOperationId: `op_finalize_${second.archiveId}`,
      }),
      code('23505'),
    );
  });
});

// ---------- 6. context enums and actor FK ----------

test('restored context enforces its lifecycle enums and actor FK', { skip: !approved }, async () => {
  await withClient(async client => {
    const series = await createSeries(client, 'archive_context');
    const revision = await addRevision(client, series, { revision: 1 });

    await assert.rejects(
      createContext(client, series, revision, { contextId: 'ctx_bad_mode', mode: 'live' }),
      code('23514'),
    );
    await assert.rejects(
      createContext(client, series, revision, { contextId: 'ctx_bad_state', state: 'closed' }),
      code('23514'),
    );

    const ghost = 'ghost_archive_025';
    await client.query(
      `INSERT INTO app_users(uid,email,display_name,role,status) VALUES($1,$2,$1,'admin','active')`,
      [ghost, `${ghost}@example.test`],
    );
    await client.query('DELETE FROM app_users WHERE uid=$1', [ghost]);
    await assert.rejects(
      createContext(client, series, revision, { contextId: 'ctx_ghost_actor', actor: ghost }),
      code('23503'),
    );

    // Only one open context may exist per archive series.
    const openSeries = await createSeries(client, 'archive_context_open');
    const openRevision = await addRevision(client, openSeries, { revision: 1 });
    await createContext(client, openSeries, openRevision, { contextId: 'ctx_open_1', state: 'open' });
    await assert.rejects(
      createContext(client, openSeries, openRevision, { contextId: 'ctx_open_2', state: 'open', operationId: 'op_restore_open_2' }),
      code('23505'),
    );
  });
});

// ---------- 7. dedicated children ----------

test('children use dedicated context FKs and the evidence child has no context column', { skip: !approved }, async () => {
  await withClient(async client => {
    const series = await createSeries(client, 'archive_children');
    const revision = await addRevision(client, series, { revision: 1 });
    const context = await createContext(client, series, revision);

    await assert.rejects(
      client.query(
        `INSERT INTO restored_context_logs(workspace_id,restored_context_id,log_id,truck_id,payload,log_revision,source_log_id,created_from_archive_revision)
         VALUES($1,'ctx_missing','log_1',$2,'{}'::jsonb,1,'log_src',1)`,
        [WS, TRUCK],
      ),
      code('23503'),
    );
    await assert.rejects(
      client.query(
        `INSERT INTO restored_context_status_snapshots(workspace_id,restored_context_id,truck_id,payload,status_revision,cycle_revision,ttn_revision)
         VALUES($1,'ctx_missing',$2,'{}'::jsonb,1,1,1)`,
        [WS, TRUCK],
      ),
      code('23503'),
    );
    await assert.rejects(
      client.query(
        `INSERT INTO restored_context_history(workspace_id,action_id,restored_context_id,uid,type,revision)
         VALUES($1,'action_missing','ctx_missing',$2,'trip',1)`,
        [WS, ADMIN],
      ),
      code('23503'),
    );
    await assert.rejects(
      client.query(
        `INSERT INTO restored_context_receipts(workspace_id,operation_id,restored_context_id,uid,protocol_version,command_hash,result)
         VALUES($1,'op_missing','ctx_missing',$2,1,$3,'{}'::jsonb)`,
        [WS, ADMIN, sha('op_missing')],
      ),
      code('23503'),
    );
    await assert.rejects(
      client.query(
        `INSERT INTO restored_context_audit(workspace_id,restored_context_id,operation_id,uid,type)
         VALUES($1,'ctx_missing','op_missing',$2,'trip')`,
        [WS, ADMIN],
      ),
      code('23503'),
    );
    // A context of another workspace is not reachable from this one.
    await assert.rejects(
      client.query(
        `INSERT INTO restored_context_logs(workspace_id,restored_context_id,log_id,truck_id,payload,log_revision,created_from_archive_revision)
         VALUES($1,$2,'log_foreign',$3,'{}'::jsonb,1,1)`,
        [FOREIGN_WS, context.contextId, TRUCK],
      ),
      code('23503'),
    );

    // The evidence child derives its context only through the parent.
    const childColumns = (await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='restored_context_migration_evidence_rows'
        ORDER BY column_name`,
    )).rows.map(row => row.column_name);
    assert.equal(childColumns.includes('restored_context_id'), false);
    assert.ok(childColumns.includes('evidence_id'));

    // `source_table` is a closed, versioned allow-list.
    const evidenceId = '00000000-0000-4000-8000-000000000001';
    await client.query(
      `INSERT INTO restored_context_migration_evidence(
         workspace_id,evidence_id,legacy_shift_id,archive_id,base_archive_revision,source_locator,
         source_bytes_sha256,source_counts,source_table_roots,closure_hash,migrated_context_id,migration_operation_id)
       VALUES($1,$2,'shift_legacy_allow',$3,1,'legacy:allow:1',$4,'{}'::jsonb,'{}'::jsonb,$5,$6,'op_migrate_allow')`,
      [WS, evidenceId, series.archiveId, sha('source'), sha('closure'), context.contextId],
    );
    const pk = '{"id":"row-1"}';
    await assert.rejects(
      client.query(
        `INSERT INTO restored_context_migration_evidence_rows(
           workspace_id,evidence_id,source_table,source_pk_canonical_jcs,source_pk_hash,source_row_sha256,
           representation_kind,target_table,target_pk_canonical_jcs)
         VALUES($1,$2,'shifts',$3,$4,$5,'exact-bytes','restored_context_history',$3)`,
        [WS, evidenceId, pk, sha(pk), sha('row-bytes')],
      ),
      code('23514'),
    );
    // A child of another workspace cannot hang under this parent.
    await assert.rejects(
      client.query(
        `INSERT INTO restored_context_migration_evidence_rows(
           workspace_id,evidence_id,source_table,source_pk_canonical_jcs,source_pk_hash,source_row_sha256,
           representation_kind,target_table,target_pk_canonical_jcs)
         VALUES($1,$2,'line_audit',$3,$4,$5,'exact-bytes','restored_context_audit',$3)`,
        [FOREIGN_WS, evidenceId, pk, sha(pk), sha('row-bytes')],
      ),
      code('23503'),
    );
  });
});

// ---------- 8. evidence uniqueness ----------

test('migration evidence is one manifest per context, legacy shift and locator', { skip: !approved }, async () => {
  await withClient(async client => {
    const first = await createSeries(client, 'archive_evidence_1');
    const firstRevision = await addRevision(client, first, { revision: 1 });
    const firstContext = await createContext(client, first, firstRevision);
    const second = await createSeries(client, 'archive_evidence_2');
    const secondRevision = await addRevision(client, second, { revision: 1 });
    const secondContext = await createContext(client, second, secondRevision);

    const evidence = (evidenceId, overrides = {}) => client.query(
      `INSERT INTO restored_context_migration_evidence(
         workspace_id,evidence_id,legacy_shift_id,archive_id,base_archive_revision,source_locator,
         source_bytes_sha256,source_counts,source_table_roots,closure_hash,migrated_context_id,migration_operation_id)
       VALUES($1,$2,$3,$4,1,$5,$6,'{}'::jsonb,'{}'::jsonb,$7,$8,'op_migrate')`,
      [
        WS, evidenceId,
        overrides.legacyShiftId ?? `legacy_${evidenceId}`,
        overrides.archiveId ?? first.archiveId,
        overrides.sourceLocator ?? `legacy:evidence:${evidenceId}`,
        sha('source'), sha('closure'),
        overrides.contextId ?? firstContext.contextId,
      ],
    );

    await evidence('00000000-0000-4000-8000-0000000000a1');
    await assert.rejects(
      evidence('00000000-0000-4000-8000-0000000000a2'),
      code('23505'),
    );
    await assert.rejects(
      evidence('00000000-0000-4000-8000-0000000000a3', {
        contextId: secondContext.contextId, legacyShiftId: 'legacy_00000000-0000-4000-8000-0000000000a1',
      }),
      code('23505'),
    );
    await assert.rejects(
      evidence('00000000-0000-4000-8000-0000000000a4', {
        contextId: secondContext.contextId,
        sourceLocator: 'legacy:evidence:00000000-0000-4000-8000-0000000000a1',
      }),
      code('23505'),
    );
  });
});

// ---------- 9. append-only tables ----------

test('every append-only archive table rejects UPDATE, DELETE and TRUNCATE', { skip: !approved }, async () => {
  await withClient(async client => {
    const series = await createSeries(client, 'archive_append');
    const base = await addRevision(client, series, { revision: 1 });
    const next = await addRevision(client, series, { revision: 2, previous: base });
    await addReceipt(client, series.archiveId, `op_restore_${series.archiveId}`);
    await addReceipt(client, series.archiveId, `op_finalize_${series.archiveId}`);
    const context = await createContext(client, series, next);
    await publish(client, series, context, {
      archiveRevision: next.revision, baseRevision: base.revision, baseSha256: base.sha256,
    });
    await client.query(
      `INSERT INTO restored_context_logs(workspace_id,restored_context_id,log_id,truck_id,payload,log_revision,source_log_id,created_from_archive_revision)
       VALUES($1,$2,'log_append',$3,'{}'::jsonb,1,'log_src',1)`,
      [WS, context.contextId, TRUCK],
    );
    await client.query(
      `INSERT INTO restored_context_status_snapshots(workspace_id,restored_context_id,truck_id,payload,status_revision,cycle_revision,ttn_revision)
       VALUES($1,$2,$3,'{}'::jsonb,1,1,1)`,
      [WS, context.contextId, TRUCK],
    );
    await client.query(
      `INSERT INTO restored_context_history(workspace_id,action_id,restored_context_id,uid,type,revision)
       VALUES($1,'action_append',$2,$3,'trip',1)`,
      [WS, context.contextId, ADMIN],
    );
    await client.query(
      `INSERT INTO restored_context_receipts(workspace_id,operation_id,restored_context_id,uid,protocol_version,command_hash,result)
       VALUES($1,'op_append',$2,$3,1,$4,'{}'::jsonb)`,
      [WS, context.contextId, ADMIN, sha('op_append')],
    );
    await client.query(
      `INSERT INTO restored_context_audit(workspace_id,restored_context_id,action_id,operation_id,uid,type)
       VALUES($1,$2,'action_append','op_append',$3,'trip')`,
      [WS, context.contextId, ADMIN],
    );
    const evidenceId = '00000000-0000-4000-8000-0000000000b1';
    await client.query(
      `INSERT INTO restored_context_migration_evidence(
         workspace_id,evidence_id,legacy_shift_id,archive_id,base_archive_revision,source_locator,
         source_bytes_sha256,source_counts,source_table_roots,closure_hash,migrated_context_id,migration_operation_id)
       VALUES($1,$2,'shift_legacy_append',$3,1,'legacy:append:1',$4,'{}'::jsonb,'{}'::jsonb,$5,$6,'op_migrate_append')`,
      [WS, evidenceId, series.archiveId, sha('source'), sha('closure'), context.contextId],
    );
    const pk = '{"id":"row-append"}';
    await client.query(
      `INSERT INTO restored_context_migration_evidence_rows(
         workspace_id,evidence_id,source_table,source_pk_canonical_jcs,source_pk_hash,source_row_sha256,
         representation_kind,target_table,target_pk_canonical_jcs)
       VALUES($1,$2,'line_audit',$3,$4,$5,'exact-bytes','restored_context_audit',$3)`,
      [WS, evidenceId, pk, sha(pk), sha('row-append')],
    );
    await client.query(
      `INSERT INTO archive_audit(workspace_id,archive_id,source_shift_id,before_state,after_state,actor_uid)
       VALUES($1,$2,$3,'{}'::jsonb,'{}'::jsonb,$4)`,
      [WS, series.archiveId, series.shiftId, ADMIN],
    );

    for (const table of APPEND_ONLY_TABLES) {
      const rows = (await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
      assert.ok(rows > 0, `${table} needs a seeded row so the row guard really fires`);
      await assert.rejects(
        client.query(`UPDATE ${table} SET workspace_id = workspace_id`),
        code('23514'),
        `${table} must reject UPDATE`,
      );
      await assert.rejects(
        client.query(`DELETE FROM ${table}`),
        code('23514'),
        `${table} must reject DELETE`,
      );
      await assert.rejects(
        client.query(`TRUNCATE TABLE ${table} CASCADE`),
        code('23514'),
        `${table} must reject TRUNCATE`,
      );
    }
  });
});

// ---------- 10. runtime / PUBLIC authority boundary ----------

test('runtime and PUBLIC hold no mutation right on evidence or source tables', { skip: !approved }, async () => {
  await withClient(async client => {
    const roles = (await client.query(
      `SELECT rolname,rolcanlogin,rolsuper,rolbypassrls FROM pg_roles
        WHERE rolname='samosval_migration_evidence_owner'`,
    )).rows;
    assert.equal(roles.length, 1, 'the evidence owner role must be bootstrapped');
    assert.deepEqual(
      { login: roles[0].rolcanlogin, super: roles[0].rolsuper, bypassrls: roles[0].rolbypassrls },
      { login: false, super: false, bypassrls: false },
    );
    assert.equal((await client.query(
      `SELECT count(*)::int AS n FROM pg_auth_members m
        JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='samosval_migration_evidence_owner'`,
    )).rows[0].n, 0);

    const subject = (await client.query('SELECT current_user AS name')).rows[0].name;
    const privileged = (await client.query(
      `SELECT r.rolsuper OR pg_has_role($1,'samosval_migration_evidence_owner','MEMBER') AS can_assume
         FROM pg_roles r WHERE r.rolname=$1`,
      [subject],
    )).rows[0].can_assume;

    for (const table of [...APPEND_ONLY_TABLES, ...SOURCE_ALLOW_LIST]) {
      for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
        for (const role of ['samosval_runtime', 'samosval_maintenance']) {
          const exists = (await client.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1', [role])).rows[0].n;
          if (!exists) continue;
          assert.equal(
            (await client.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [role, `public.${table}`, privilege])).rows[0].allowed,
            false,
            `${role} must not hold ${privilege} on ${table}`,
          );
        }
      }
      const publicGrants = (await client.query(
        `SELECT count(*)::int AS n FROM pg_class c, aclexplode(c.relacl) acl
          WHERE c.oid=to_regclass($1) AND acl.grantee=0
            AND acl.privilege_type IN ('UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES')`,
        [`public.${table}`],
      )).rows[0].n;
      assert.equal(publicGrants, 0, `PUBLIC must not hold a mutation right on ${table}`);
    }

    // Ownership: never runtime/maintenance; the evidence owner when it can be assumed.
    const owners = (await client.query(
      `SELECT c.relname,o.rolname AS owner FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
         JOIN pg_roles o ON o.oid=c.relowner
        WHERE n.nspname='public' AND c.relname = ANY($1)`,
      [['restored_context_migration_evidence', 'restored_context_migration_evidence_rows']],
    )).rows;
    assert.equal(owners.length, 2);
    for (const row of owners) {
      assert.equal(['samosval_runtime', 'samosval_maintenance'].includes(row.owner), false, `${row.relname} must not be owned by a runtime role`);
      if (privileged) assert.equal(row.owner, 'samosval_migration_evidence_owner', `${row.relname} ownership`);
    }
    const guardOwner = (await client.query(
      `SELECT t.tgname,o.rolname AS owner FROM pg_trigger t
         JOIN pg_class c ON c.oid=t.tgrelid
         JOIN pg_roles o ON o.oid=c.relowner
        WHERE c.relname='restored_context_migration_evidence' AND t.tgname='restored_context_migration_evidence_append_only'`,
    )).rows[0];
    assert.equal(guardOwner.owner, owners.find(row => row.relname === 'restored_context_migration_evidence').owner,
      'the named immutable trigger belongs to the evidence table owner');

    // Real attempts, not only catalog promises.
    if (privileged) {
      // The owner role is not login and has no memberships, so the runtime role can
      // never be reached from it (SET ROLE is checked against the session user).
      await client.query('SET SESSION AUTHORIZATION samosval_migration_evidence_owner');
      try {
        assert.equal((await client.query('SELECT current_user AS name')).rows[0].name, 'samosval_migration_evidence_owner');
        await assert.rejects(
          client.query('SET ROLE samosval_runtime'),
          /permission denied|must be member|not permitted/i,
        );
      } finally {
        await client.query('RESET SESSION AUTHORIZATION');
      }
      // Every runtime mutation is refused by ACL before any trigger could run.
      await client.query('SET SESSION AUTHORIZATION samosval_runtime');
      try {
        for (const sql of [
          'UPDATE public.restored_context_migration_evidence SET closure_hash=closure_hash',
          'DELETE FROM public.restored_context_migration_evidence',
          'TRUNCATE TABLE public.restored_context_migration_evidence',
          'ALTER TABLE public.restored_context_migration_evidence DISABLE TRIGGER ALL',
          'UPDATE public.line_audit SET operation_id=operation_id',
          'DELETE FROM public.workspace_service_audit',
          'SET ROLE samosval_migration_evidence_owner',
        ]) {
          await assert.rejects(
            client.query(sql),
            /permission denied|must be owner|must be member|not permitted/i,
            `runtime must be refused: ${sql}`,
          );
        }
      } finally {
        await client.query('RESET SESSION AUTHORIZATION');
      }
    } else {
      await assert.rejects(
        client.query('SET ROLE samosval_migration_evidence_owner'),
        /permission denied|must be member|not permitted/i,
      );
      const ownerOf = async table => (await client.query(
        'SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid=to_regclass($1)',
        [`public.${table}`],
      )).rows[0].owner;
      for (const table of ['restored_context_migration_evidence', 'line_audit']) {
        // When the applying role happens to own the table it may administer it; the
        // harness path (tables from the sealed template) never does.
        if (await ownerOf(table) === subject) continue;
        await assert.rejects(
          client.query(`ALTER TABLE public.${table} DISABLE TRIGGER ALL`),
          /must be owner of table|permission denied/i,
          `a non-owner must not disable triggers on ${table}`,
        );
      }
      await assert.rejects(
        client.query('UPDATE public.restored_context_migration_evidence SET closure_hash=closure_hash'),
        code('23514'),
      );
    }
    // Task 7 replaced the schema-only guarantee: exactly one migration entrypoint
    // may exist, and it must be the exact signature owned by the evidence owner.
    const migrationFunctions = (await client.query(
      `SELECT p.proname,
              (SELECT string_agg(format_type(t, NULL), ',' ORDER BY ord)
                 FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)) AS args,
              pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
              coalesce(array_to_string(p.proconfig, ','), '') AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'migrate_legacy_restored_context%'`,
    )).rows;
    assert.deepEqual(
      migrationFunctions.map(row => `${row.proname}(${row.args})`),
      ['migrate_legacy_restored_context_exact(text,jsonb)'],
      'exactly one migration entrypoint with the exact signature exists',
    );
    assert.equal(migrationFunctions[0].owner, 'samosval_migration_evidence_owner');
    assert.equal(migrationFunctions[0].security_definer, true);
    assert.match(migrationFunctions[0].config, /search_path=pg_catalog, pg_temp/);
  });
});

// ---------- 11. one pointer, no second current state ----------

test('latest_finalized_* stays the only default pointer and no synthetic current state exists', { skip: !approved }, async () => {
  await withClient(async client => {
    const tables = (await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name`,
      [ARCHIVE_TABLES],
    )).rows.map(row => row.table_name);
    assert.deepEqual(tables, [...ARCHIVE_TABLES].sort(), 'every archive table exists');

    const columns = (await client.query(
      `SELECT table_name,column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name = ANY($1)`,
      [ARCHIVE_TABLES],
    )).rows;
    const pointerColumns = columns.filter(row => row.column_name.startsWith('latest_finalized_'));
    assert.deepEqual(
      pointerColumns.map(row => `${row.table_name}.${row.column_name}`).sort(),
      [
        'shift_archive_series.latest_finalized_revision',
        'shift_archive_series.latest_finalized_sha256',
      ],
    );
    const forbidden = columns.filter(row => /^(is_current|current_revision|current_sha256|current_archive|active_shift|active_status)/.test(row.column_name));
    assert.deepEqual(forbidden, [], 'no second current pointer column may exist');

    // No second "current" table (a synthetic current status/shift anchor).
    const currentTables = (await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public'
          AND (table_name ~ '^(current_|archive_current|shift_current|restored_context_current)'
               OR table_name IN ('restored_current_statuses','restored_current_shifts'))`,
    )).rows.map(row => row.table_name);
    assert.deepEqual(currentTables, []);

    // Restored contexts never live inside `shifts` and never reference it.
    const shiftColumns = (await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='shifts'`,
    )).rows.map(row => row.column_name);
    for (const name of ['restored_context_id', 'archive_revision', 'archive_id']) {
      assert.equal(shiftColumns.includes(name), false, `shifts must not grow ${name}`);
    }
    const shiftReferences = (await client.query(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE contype='f' AND confrelid='public.shifts'::regclass
          AND conrelid IN (SELECT oid FROM pg_class WHERE relname = ANY($1))`,
      [ARCHIVE_TABLES],
    )).rows[0].n;
    assert.equal(shiftReferences, 0, 'restored/archive tables never depend on a shifts row');

    // The only context lifecycle state is the enum on the context itself.
    const stateColumns = (await client.query(
      `SELECT table_name,column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name = ANY($1)
          AND column_name LIKE '%\\_state' AND data_type='text'`,
      [ARCHIVE_TABLES],
    )).rows;
    assert.deepEqual(stateColumns.map(row => `${row.table_name}.${row.column_name}`), ['restored_shift_contexts.context_state']);
  });
});
