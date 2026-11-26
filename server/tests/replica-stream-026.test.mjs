import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

import { applyMigrations } from '../scripts/apply-migrations.mjs';
import {
  applyMigrationsThrough,
  requireIsolatedDatabase,
  resetIsolatedDatabase,
  withAdminClient,
} from './helpers/isolated-db.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
let approved = false;
if (connectionString && process.env.SAMOSVAL_ISOLATED_TEST === '1') {
  try {
    requireIsolatedDatabase(connectionString);
    approved = true;
  } catch {}
}

const WS = 'ws_p11_stream';
const MIGRATION = '026_parallel_shift_dependencies.sql';
const migrationPath = new URL('../sql/026_parallel_shift_dependencies.sql', import.meta.url);
const sqlDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');
const sha = seed => createHash('sha256').update(`p11-fixture-${seed}`).digest('hex');

// A pool of two keeps a single checked-out client from deadlocking the test itself
// (lesson 19); every query below runs through the checked-out client only.
async function withClient(fn) {
  const pool = new pg.Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

// DDL и role-пробы этого файла (создание marker-таблицы, снятие constraint,
// прямой прогон 026, SET LOCAL ROLE) требуют привилегированного соединения:
// db-ребёнок работает как samosval_test_app. Данные и утверждения остаются на
// TEST_DATABASE_URL; после DDL привилегированное соединение обновляет гранты.
const withAdmin = fn => withAdminClient(fn, { grant: true });

async function prepareThrough25() {
  await resetIsolatedDatabase();
  await applyMigrationsThrough(25);
}

async function setCursor(client, f2s, s2f) {
  await client.query(
    `INSERT INTO replica_cursor(workspace_id,f2s_seq,s2f_seq) VALUES($1,$2,$3)
     ON CONFLICT (workspace_id) DO UPDATE SET f2s_seq=EXCLUDED.f2s_seq, s2f_seq=EXCLUDED.s2f_seq`,
    [WS, f2s, s2f],
  );
}

async function insertStream(client, rows) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        WS,
        row.seq,
        row.direction ?? 'f2s',
        row.operationId ?? `op-${row.direction ?? 'f2s'}-${String(row.seq).padStart(8, '0')}`,
        row.kind ?? 'trip.load',
        JSON.stringify(row.payload ?? { n: row.seq }),
        row.sha256 ?? sha(`${row.direction ?? 'f2s'}-${row.seq}`),
      ],
    );
  }
}

async function primaryKey(client, table = 'replica_stream') {
  const { rows } = await client.query(
    `SELECT a.attname
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE n.nspname='public' AND t.relname=$1 AND c.contype='p'
      ORDER BY k.ord`,
    [table],
  );
  return rows.map(row => row.attname);
}

// Catalog-level fingerprint: tables, columns, defaults, constraints, indexes, triggers,
// functions, owners, ACLs and the migration registry. Equal fingerprints mean the abort
// left the schema byte-identical (no PK change, no new table, no new column, no trigger).
async function schemaFingerprint(client) {
  const { rows } = await client.query(`
    WITH facts AS (
      SELECT 'table' AS kind, c.relname AS name, c.relkind::text AS detail
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      UNION ALL
      SELECT 'column', c.relname||'.'||a.attname,
             format('%s|%s|%s', format_type(a.atttypid,a.atttypmod), a.attnotnull,
                    COALESCE(pg_get_expr(d.adbin,d.adrelid),''))
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'constraint', c.relname||'.'||co.conname,
             format('%s|%s|%s|%s', co.contype, co.condeferrable, co.condeferred, pg_get_constraintdef(co.oid))
        FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      UNION ALL
      SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname='public'
      UNION ALL
      SELECT 'trigger', c.relname||'.'||g.tgname,
             format('%s|%s|%s|%s', g.tgtype, g.tgdeferrable, g.tginitdeferred, pg_get_triggerdef(g.oid))
        FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND NOT g.tgisinternal
      UNION ALL
      SELECT 'function', p.proname,
             format('%s|%s|%s|%s', pg_get_function_identity_arguments(p.oid), p.prosecdef,
                    COALESCE(p.proconfig::text,''), md5(p.prosrc))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      UNION ALL
      SELECT 'owner', c.relname, r.rolname
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public'
      UNION ALL
      -- ACL сравниваем как множество, а не как массив: порядок элементов в
      -- relacl зависит от истории REVOKE/GRANT и не является частью контракта.
      SELECT 'acl', c.relname,
             COALESCE((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(c.relacl) a), '')
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      UNION ALL
      SELECT 'migration', filename, COALESCE(checksum,'') FROM schema_migrations
    )
    SELECT md5(string_agg(kind||'|'||name||'|'||detail, E'\n' ORDER BY kind,name,detail)) AS hash,
           count(*)::int AS facts
      FROM facts
  `);
  return `${rows[0].facts}:${rows[0].hash}`;
}

async function expectUnchangedAfterAbort(client, { legacyKey = true } = {}) {
  assert.deepEqual(
    await primaryKey(client),
    legacyKey ? ['workspace_id', 'seq'] : [],
    'the aborted migration must not touch the primary key',
  );
  assert.equal(
    (await client.query(`SELECT to_regclass('public.replica_document_heads') IS NULL AS absent`)).rows[0].absent,
    true,
    'replica_document_heads must not exist after an abort',
  );
  assert.equal(
    (await client.query(`SELECT to_regclass('public.replica_pending_documents') IS NULL AS absent`)).rows[0].absent,
    true,
    'replica_pending_documents must not exist after an abort',
  );
  assert.equal(
    (await client.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema='public' AND table_name='replica_stream'
          AND column_name IN ('protocol_version','hash_version')`,
    )).rows[0].n,
    0,
    'stream version columns must not exist after an abort',
  );
  assert.equal(
    (await client.query(
      `SELECT count(*)::int AS n FROM schema_migrations WHERE filename=$1`,
      [MIGRATION],
    )).rows[0].n,
    0,
    'an aborted migration must not be registered',
  );
}

function preflightAbort(name, { fixture, code, legacyKey = true }) {
  test(name, { skip: !approved }, async () => {
    await prepareThrough25();
    const before = await withClient(async client => {
      await fixture(client);
      return schemaFingerprint(client);
    });
    await assert.rejects(
      () => applyMigrationsThrough(26),
      error => error.code === '23514' && new RegExp(code).test(error.message),
      `the preflight must abort with ${code}, not with a side error`,
    );
    const after = await withClient(async client => {
      const fingerprint = await schemaFingerprint(client);
      await expectUnchangedAfterAbort(client, { legacyKey });
      return fingerprint;
    });
    assert.equal(after, before, 'the aborted preflight must leave the schema byte-identical');
  });
}

async function createMarkerTable() {
  await withAdmin(client => client.query(`
    CREATE TABLE public.replica_stream_markers (
      workspace_id   text NOT NULL,
      direction      text NOT NULL,
      marker_version smallint NOT NULL,
      marker_kind    text NOT NULL,
      from_seq       bigint NOT NULL,
      to_seq         bigint NOT NULL,
      recorded_at    timestamptz NOT NULL DEFAULT now()
    )`));
}

async function insertMarker(client, { direction = 'f2s', from, to, version = 1, kind = 'legacy-import' }) {
  await client.query(
    `INSERT INTO replica_stream_markers(workspace_id,direction,marker_version,marker_kind,from_seq,to_seq)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [WS, direction, version, kind, from, to],
  );
}

async function insertV2Stream(client, { seq, documentId, collection = 'logs', kind = 'doc.set', direction = 'f2s' }) {
  await client.query(
    `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256,protocol_version,hash_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,2,2)`,
    [
      WS,
      seq,
      direction,
      `op-v2-${direction}-${String(seq).padStart(8, '0')}`,
      kind,
      JSON.stringify({ collection, path: `workspaces/${WS}/${collection}/${documentId}`, data: { id: documentId } }),
      sha(`v2-${direction}-${seq}`),
    ],
  );
}

// ---------------------------------------------------------------------------
// RED 1 — a clean historical stream migrates without rewriting history.
// ---------------------------------------------------------------------------
test('026 migrates a clean historical stream: versions stay 1, PK is split, legacy hashes untouched', {
  skip: !approved,
}, async () => {
  await prepareThrough25();
  const original = await withClient(async client => {
    // The legacy PK is global, so a historical database cannot hold both directions at
    // once. The real v1 writer only produced f2s, and s2f_seq is a read head only.
    await setCursor(client, 3, 0);
    await insertStream(client, [
      { seq: 1, kind: 'trip.load' },
      { seq: 2, kind: 'doc.set', payload: { collection: 'logs', path: 'workspaces/ws/logs/log-1', data: { id: 'log-1' } } },
      { seq: 3, kind: 'doc.delete', payload: { collection: 'logs', path: 'workspaces/ws/logs/log-1' } },
    ]);
    // A second workspace proves the contiguous s2f path without markers.
    await client.query(
      `INSERT INTO replica_cursor(workspace_id,f2s_seq,s2f_seq) VALUES('ws_p11_s2f',0,2)`,
    );
    for (const seq of [1, 2]) {
      await client.query(
        `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256)
         VALUES('ws_p11_s2f',$1,'s2f',$2,'trip.load','{}',$3)`,
        [seq, `op-s2f-${String(seq).padStart(8, '0')}`, sha(`s2f-${seq}`)],
      );
    }
    const { rows } = await client.query(
      `SELECT workspace_id,direction,seq,operation_id,kind,payload,sha256
         FROM replica_stream ORDER BY workspace_id,direction,seq`,
    );
    return rows;
  });

  await applyMigrationsThrough(26);

  await withClient(async client => {
    assert.deepEqual(await primaryKey(client), ['workspace_id', 'direction', 'seq']);
    const { rows } = await client.query(
      `SELECT workspace_id,direction,seq,operation_id,kind,payload,sha256,protocol_version,hash_version
         FROM replica_stream ORDER BY workspace_id,direction,seq`,
    );
    assert.equal(rows.length, original.length);
    for (const [index, row] of rows.entries()) {
      assert.equal(row.workspace_id, original[index].workspace_id);
      assert.equal(row.direction, original[index].direction);
      assert.equal(Number(row.seq), Number(original[index].seq));
      assert.equal(row.operation_id, original[index].operation_id);
      assert.equal(row.kind, original[index].kind);
      assert.deepEqual(row.payload, original[index].payload);
      assert.equal(row.sha256, original[index].sha256, 'legacy payload-only sha256 must never be rewritten');
      assert.equal(Number(row.protocol_version), 1);
      assert.equal(Number(row.hash_version), 1);
    }

    // Independent direction sequences may now reuse the same number.
    await client.query(
      `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256)
       VALUES($1,4,'f2s','op-f2s-00000004','trip.load','{}',$2),
             ($1,1,'s2f','op-s2f-cross-0001','trip.load','{}',$3)`,
      [WS, sha('new-f2s-4'), sha('new-s2f-1')],
    );
    // Operation identity stays unique per direction.
    await assert.rejects(
      () => client.query(
        `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256)
         VALUES($1,5,'f2s','op-f2s-00000004','trip.load','{}',$2)`,
        [WS, sha('dup-op')],
      ),
      error => error.code === '23505',
    );
    // And it is only unique per direction: the same id in the other direction is legal.
    await client.query(
      `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256)
       VALUES($1,3,'s2f','op-f2s-00000004','trip.load','{}',$2)`,
      [WS, sha('s2f-same-id')],
    );
  });
});

// ---------------------------------------------------------------------------
// RED 2 — f2s gap without a marker.
// ---------------------------------------------------------------------------
preflightAbort('026 aborts on an f2s gap without a marker and leaves the schema unchanged', {
  code: 'replica-preflight-f2s-gap',
  fixture: async client => {
    await setCursor(client, 4, 0);
    await insertStream(client, [{ seq: 1 }, { seq: 2 }, { seq: 4 }]);
  },
});

// ---------------------------------------------------------------------------
// RED 3 — head/cursor mismatch and rows beyond the cursor.
// ---------------------------------------------------------------------------
preflightAbort('026 aborts when max(f2s.seq) does not match f2s_seq', {
  code: 'replica-preflight-f2s-head-mismatch',
  fixture: async client => {
    await setCursor(client, 5, 0);
    await insertStream(client, [{ seq: 1 }, { seq: 2 }]);
  },
});

preflightAbort('026 aborts when a row lies beyond its direction cursor', {
  code: 'replica-preflight-f2s-row-beyond-cursor',
  fixture: async client => {
    await setCursor(client, 2, 0);
    await insertStream(client, [{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
  },
});

// ---------------------------------------------------------------------------
// RED 4 — duplicate legacy key and ambiguous operation identity.
// ---------------------------------------------------------------------------
preflightAbort('026 aborts on a duplicated legacy (workspace_id,seq) key', {
  code: 'replica-preflight-seq-duplicate',
  legacyKey: false,
  fixture: async client => {
    await withAdmin(admin => admin.query('ALTER TABLE replica_stream DROP CONSTRAINT replica_stream_pkey'));
    await setCursor(client, 1, 0);
    await insertStream(client, [
      { seq: 1, operationId: 'op-duplicate-key-1' },
      { seq: 1, operationId: 'op-duplicate-key-2' },
    ]);
  },
});

preflightAbort('026 aborts on an ambiguous operation identity', {
  code: 'replica-preflight-operation-duplicate',
  fixture: async client => {
    await withAdmin(admin => admin.query('ALTER TABLE replica_stream DROP CONSTRAINT replica_stream_workspace_id_direction_operation_id_key'));
    await setCursor(client, 2, 0);
    await insertStream(client, [{ seq: 1, operationId: 'op-ambiguous-1' }, { seq: 2, operationId: 'op-ambiguous-1' }]);
  },
});

// ---------------------------------------------------------------------------
// RED 5 — the same seq in both directions is corruption before the PK change.
// ---------------------------------------------------------------------------
preflightAbort('026 aborts on a cross-direction seq collision before the PK change', {
  code: 'replica-preflight-direction-collision',
  legacyKey: false,
  fixture: async client => {
    await withAdmin(admin => admin.query('ALTER TABLE replica_stream DROP CONSTRAINT replica_stream_pkey'));
    await setCursor(client, 1, 1);
    await insertStream(client, [{ seq: 1 }, { seq: 1, direction: 's2f' }]);
  },
});

// ---------------------------------------------------------------------------
// RED 6 — s2f rules.
// ---------------------------------------------------------------------------
preflightAbort('026 aborts when an s2f row lies beyond the s2f cursor', {
  code: 'replica-preflight-s2f-row-beyond-cursor',
  fixture: async client => {
    await setCursor(client, 0, 2);
    await insertStream(client, [{ seq: 1, direction: 's2f' }, { seq: 2, direction: 's2f' }, { seq: 3, direction: 's2f' }]);
  },
});

preflightAbort('026 aborts on an s2f gap without a marker', {
  code: 'replica-preflight-s2f-gap',
  fixture: async client => {
    await setCursor(client, 0, 3);
    await insertStream(client, [{ seq: 1, direction: 's2f' }, { seq: 3, direction: 's2f' }]);
  },
});

test('026 accepts a marker-covered s2f subsequence', { skip: !approved }, async () => {
  await prepareThrough25();
  await withClient(async client => {
    await createMarkerTable();
    await setCursor(client, 0, 4);
    await insertStream(client, [
      { seq: 1, direction: 's2f' },
      { seq: 4, direction: 's2f' },
    ]);
    await insertMarker(client, { direction: 's2f', from: 2, to: 4, kind: 'legacy-import' });
  });
  await applyMigrationsThrough(26);
  await withClient(async client => {
    assert.deepEqual(await primaryKey(client), ['workspace_id', 'direction', 'seq']);
    const { rows } = await client.query(
      `SELECT seq FROM replica_stream WHERE workspace_id=$1 AND direction='s2f' ORDER BY seq`,
      [WS],
    );
    assert.deepEqual(rows.map(row => Number(row.seq)), [1, 4], 'history is never renumbered');
  });
});

test('026 accepts a marker-covered f2s legacy import and still rejects a row outside it', { skip: !approved }, async () => {
  // Marker covers 3..4: rows 1,2,4 are the exact native prefix plus one retained row.
  await prepareThrough25();
  await withClient(async client => {
    await createMarkerTable();
    await setCursor(client, 4, 0);
    await insertStream(client, [{ seq: 1 }, { seq: 2 }, { seq: 4 }]);
    await insertMarker(client, { direction: 'f2s', from: 3, to: 4, kind: 'legacy-import' });
  });
  await applyMigrationsThrough(26);
  await withClient(async client => {
    assert.deepEqual(await primaryKey(client), ['workspace_id', 'direction', 'seq']);
  });
});

preflightAbort('026 aborts when a row falls outside every declared marker range', {
  code: 'replica-preflight-f2s-row-outside-marker',
  fixture: async client => {
    await createMarkerTable();
    await setCursor(client, 4, 0);
    await insertStream(client, [{ seq: 1 }, { seq: 2 }, { seq: 4 }]);
    await insertMarker(client, { direction: 'f2s', from: 3, to: 3 });
  },
});

preflightAbort('026 aborts when a marker claims a range beyond the cursor', {
  code: 'replica-preflight-f2s-marker-invalid',
  fixture: async client => {
    await createMarkerTable();
    await setCursor(client, 4, 0);
    await insertStream(client, [{ seq: 1 }, { seq: 2 }, { seq: 4 }]);
    await insertMarker(client, { direction: 'f2s', from: 3, to: 5 });
  },
});

// ---------------------------------------------------------------------------
// RED 7 — cursor without a head row.
// ---------------------------------------------------------------------------
preflightAbort('026 aborts when a cursor has no stream row at its head', {
  code: 'replica-preflight-f2s-head-missing',
  fixture: async client => {
    await setCursor(client, 3, 0);
  },
});

// ---------------------------------------------------------------------------
// RED 8 — a second run is idempotent.
// ---------------------------------------------------------------------------
test('026 is idempotent: a second run keeps data, versions and the new PK', { skip: !approved }, async () => {
  await prepareThrough25();
  await withClient(async client => {
    await setCursor(client, 2, 0);
    await insertStream(client, [{ seq: 1 }, { seq: 2 }]);
  });
  await applyMigrationsThrough(26);
  const first = await withClient(async client => {
    const { rows } = await client.query(
      `SELECT direction,seq,operation_id,kind,payload,sha256,protocol_version,hash_version
         FROM replica_stream WHERE direction='f2s' ORDER BY seq`,
    );
    return { rows, pk: await primaryKey(client), fingerprint: await schemaFingerprint(client) };
  });

  // A post-026 writer may already reuse numbers across directions; the re-run must not
  // mistake that legal state for pre-PK corruption.
  await withClient(async client => {
    await client.query(
      `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256)
       VALUES($1,1,'s2f','op-post-026-0001','trip.load','{}',$2)`,
      [WS, sha('post-026-s2f-1')],
    );
    await client.query(
      'UPDATE replica_cursor SET s2f_seq=1 WHERE workspace_id=$1',
      [WS],
    );
  });
  const source = readFileSync(fileURLToPath(migrationPath), 'utf8');
  await withAdmin(admin => admin.query(source));

  const second = await withClient(async client => {
    const { rows } = await client.query(
      `SELECT direction,seq,operation_id,kind,payload,sha256,protocol_version,hash_version
         FROM replica_stream WHERE direction='f2s' ORDER BY seq`,
    );
    return { rows, pk: await primaryKey(client) };
  });
  assert.deepEqual(second.pk, ['workspace_id', 'direction', 'seq']);
  assert.deepEqual(second.rows, first.rows, 'a re-run must not change historical rows');

  // The registry path stays a no-op as well.
  const results = await withAdmin(admin => applyMigrations(admin, { through: 26 }));
  assert.equal(results.every(result => result.status === 'skipped'), true);
  const afterRegistry = await withClient(client => schemaFingerprint(client));
  assert.equal(afterRegistry, first.fingerprint);
});

// ---------------------------------------------------------------------------
// RED 9 — replica_placeholder is forbidden.
// ---------------------------------------------------------------------------
test('026 leaves no replica_placeholder table, column or branch', { skip: !approved }, async () => {
  await prepareThrough25();
  await applyMigrationsThrough(26);
  await withClient(async client => {
    const relations = await client.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname LIKE '%placeholder%'`,
    );
    assert.deepEqual(relations.rows, []);
    const columns = await client.query(
      `SELECT table_name||'.'||column_name AS name FROM information_schema.columns
        WHERE table_schema='public' AND column_name LIKE '%placeholder%'`,
    );
    assert.deepEqual(columns.rows, []);
  });
  const core = readFileSync(join(sqlDirectory, '025_parallel_shifts_core.sql'), 'utf8');
  assert.equal(/replica_placeholder/.test(core), false, '025 must not contain a placeholder branch');
  const migration = readFileSync(fileURLToPath(migrationPath), 'utf8');
  assert.equal(/replica_placeholder/.test(migration), false, '026 must not introduce a placeholder');
});

// ---------------------------------------------------------------------------
// RED 10 — version checks and the immutable stream.
// ---------------------------------------------------------------------------
test('026 rejects unknown versions and makes the stream append-only for every role', { skip: !approved }, async () => {
  await prepareThrough25();
  await withClient(async client => {
    await setCursor(client, 1, 0);
    await insertStream(client, [{ seq: 1 }]);
  });
  await applyMigrationsThrough(26);
  // SET LOCAL ROLE для NOLOGIN-владельца и проверка «триггер держит и владельца»
  // возможны только на привилегированном соединении.
  await withAdmin(async client => {
    for (const [column, value] of [['protocol_version', 3], ['hash_version', 0], ['protocol_version', 0]]) {
      await assert.rejects(
        () => client.query(
          `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256,${column})
           VALUES($1,10,'f2s','op-bad-version-01','trip.load','{}',$2,$3)`,
          [WS, sha(`bad-${column}-${value}`), value],
        ),
        error => error.code === '23514',
        `${column}=${value} must be refused`,
      );
    }
    for (const [statement, values, code, pattern] of [
      [`UPDATE replica_stream SET kind='rewritten' WHERE workspace_id=$1`, [WS], '23514', /replica-stream-immutable/],
      [`DELETE FROM replica_stream WHERE workspace_id=$1`, [WS], '23514', /replica-stream-immutable/],
      // TRUNCATE is refused earlier by the FK that heads/pending hold on the stream; the
      // statement-level guard is the second line of defence if that FK ever disappears.
      [`TRUNCATE replica_stream`, [], '0A000', /foreign key/],
    ]) {
      await assert.rejects(
        () => client.query(statement, values),
        error => error.code === code && pattern.test(error.message),
        `${statement} must be refused`,
      );
    }
    const truncateGuard = await client.query(
      `SELECT count(*)::int AS n FROM pg_trigger
        WHERE tgrelid='public.replica_stream'::regclass AND tgname='replica_stream_no_truncate'
          AND (tgtype & 2) = 2 AND (tgtype & 32) = 32 AND (tgtype & 1) = 0`,
    );
    assert.equal(truncateGuard.rows[0].n, 1, 'a statement-level BEFORE TRUNCATE guard must exist');
    // The guard also fires for the table owner: a superuser bypasses ACLs, not triggers.
    const owner = (await client.query(
      `SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
        WHERE c.oid='public.replica_stream'::regclass`,
    )).rows[0].rolname;
    assert.equal(owner, 'samosval_migration_evidence_owner');
    await client.query('SET LOCAL ROLE samosval_migration_evidence_owner');
    await assert.rejects(
      () => client.query(`UPDATE replica_stream SET kind='owner-rewrite' WHERE workspace_id=$1`, [WS]),
      error => error.code === '23514' && /replica-stream-immutable/.test(error.message),
    );
    await client.query('RESET ROLE');
    const rows = await client.query(`SELECT kind FROM replica_stream WHERE workspace_id=$1`, [WS]);
    assert.deepEqual(rows.rows, [{ kind: 'trip.load' }]);
  });
});

// ---------------------------------------------------------------------------
// RED 11 — the deferred head/pending invariant.
// ---------------------------------------------------------------------------
const pendingHead = {
  collection: 'logs',
  documentId: 'log-pending-1',
  shiftId: 'shift-pending-1',
  truckId: 'truck-pending-1',
};

async function insertHead(client, {
  seq, kind = 'doc.set', canonicalPresent = false, appliedSeq = null,
  collection = pendingHead.collection, documentId = pendingHead.documentId,
  shiftId = pendingHead.shiftId, truckId = pendingHead.truckId,
}) {
  await client.query(
    `INSERT INTO replica_document_heads(workspace_id,collection,document_id,head_seq,head_kind,
       shift_id,truck_id,applied_seq,canonical_present)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [WS, collection, documentId, seq, kind, shiftId, truckId, appliedSeq, canonicalPresent],
  );
}

async function insertPending(client, {
  seq, collection = pendingHead.collection, documentId = pendingHead.documentId,
  shiftId = pendingHead.shiftId, truckId = pendingHead.truckId,
  missingShift = true, missingTruck = false,
}) {
  await client.query(
    `INSERT INTO replica_pending_documents(workspace_id,collection,document_id,stream_seq,
       shift_id,truck_id,log_id,missing_shift,missing_truck)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [WS, collection, documentId, seq, shiftId, truckId,
      collection === 'logs' ? documentId : null, missingShift, missingTruck],
  );
}

async function attemptCommit(client, work) {
  await client.query('BEGIN');
  try {
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

test('026 keeps the head/pending invariant at commit and refuses every violation', { skip: !approved }, async () => {
  await prepareThrough25();
  await withClient(async client => {
    await setCursor(client, 0, 0);
  });
  await applyMigrationsThrough(26);
  await withClient(async client => {
    for (const seq of [100, 101, 102, 103, 104]) await insertV2Stream(client, { seq, documentId: `log-${seq}` });
    // One v1 doc.set row for the provenance rule.
    await insertStream(client, [{
      seq: 105, kind: 'doc.set',
      payload: { collection: 'logs', path: `workspaces/${WS}/logs/log-105`, data: { id: 'log-105' } },
    }]);
  });

  await withClient(async client => {
    // Positive: a pending set head with exactly one matching pending row commits.
    await attemptCommit(client, async () => {
      await insertHead(client, { seq: 100, documentId: 'log-100', truckId: 'truck-100' });
      await insertPending(client, { seq: 100, documentId: 'log-100', truckId: 'truck-100' });
    });
    assert.equal(
      (await client.query(`SELECT count(*)::int AS n FROM replica_pending_documents`)).rows[0].n, 1,
      'the positive pending pair must survive the deferred check',
    );

    const cases = [
      {
        name: 'pending head without a pending row', seq: 101,
        code: 'replica-pending-head-without-row',
        work: async () => {
          await insertHead(client, { seq: 101, documentId: 'log-101', truckId: 'truck-101' });
        },
      },
      {
        name: 'a pending row without a head row', seq: 102, code: '23503',
        work: async () => {
          await insertPending(client, { seq: 102, documentId: 'log-102', truckId: 'truck-102' });
        },
      },
      {
        name: 'a pending row whose seq does not match its head', seq: 103, code: '23503',
        work: async () => {
          await insertHead(client, { seq: 103, documentId: 'log-103', truckId: 'truck-103' });
          await insertPending(client, { seq: 104, documentId: 'log-103', truckId: 'truck-103' });
        },
      },
      {
        name: 'a pending row on a materialized head', seq: 103,
        code: 'replica-pending-on-settled-head',
        work: async () => {
          await insertHead(client, {
            seq: 103, documentId: 'log-103', truckId: 'truck-103',
            canonicalPresent: true, appliedSeq: 103,
          });
          await insertPending(client, { seq: 103, documentId: 'log-103', truckId: 'truck-103' });
        },
      },
      {
        name: 'a pending row on a settled delete', seq: 104,
        code: 'replica-pending-on-settled-head',
        work: async () => {
          await insertHead(client, {
            seq: 104, kind: 'doc.delete', documentId: 'log-104', truckId: 'truck-104',
            canonicalPresent: false, appliedSeq: 104,
          });
          await insertPending(client, { seq: 104, documentId: 'log-104', truckId: 'truck-104' });
        },
      },
      {
        name: 'a pending row pointing at a v1 stream row', seq: 105,
        code: 'replica-pending-stream-invalid',
        work: async () => {
          await insertHead(client, { seq: 105, documentId: 'log-105', truckId: 'truck-105' });
          await insertPending(client, { seq: 105, documentId: 'log-105', truckId: 'truck-105' });
        },
      },
    ];
    for (const item of cases) {
      // The composite FK is the immediate half of the proof and reports 23503; the
      // deferred triggers are the other half and report 23514.
      const expected = /^\d+$/.test(item.code) ? Number(item.code) : null;
      await assert.rejects(
        () => attemptCommit(client, item.work),
        error => (expected ? error.code === String(expected)
          : error.code === '23514' && new RegExp(item.code).test(error.message)),
        `${item.name} must be rolled back`,
      );
      assert.equal(
        (await client.query(
          `SELECT count(*)::int AS n FROM replica_document_heads WHERE workspace_id=$1 AND head_seq=$2`,
          [WS, item.seq],
        )).rows[0].n,
        0,
        `${item.name} must not leave a partial row`,
      );
    }

    // Two logical pending rows for one document are refused by the primary key.
    await assert.rejects(
      () => attemptCommit(client, async () => {
        await insertHead(client, { seq: 101, documentId: 'log-101', truckId: 'truck-101' });
        await insertPending(client, { seq: 101, documentId: 'log-101', truckId: 'truck-101' });
        await insertPending(client, { seq: 102, documentId: 'log-101', truckId: 'truck-101' });
      }),
      error => error.code === '23505',
    );

    // The row-state contract refuses applied_seq IS NULL on a settled head.
    for (const state of [
      { kind: 'doc.set', canonicalPresent: true, appliedSeq: null },
      { kind: 'doc.delete', canonicalPresent: false, appliedSeq: null },
    ]) {
      await assert.rejects(
        () => attemptCommit(client, () => insertHead(client, {
          seq: 102, documentId: 'log-102', truckId: 'truck-102', ...state,
        })),
        error => error.code === '23514',
      );
    }

    // A pending row cannot be copied without its head: the composite FK is the immediate
    // half of the same proof, the deferred trigger is the other half.
    await assert.rejects(
      () => attemptCommit(client, async () => {
        await insertPending(client, { seq: 102, documentId: 'log-102', truckId: 'truck-102' });
      }),
      error => error.code === '23503',
    );

    // Pending payload is never copied: the table has no payload column at all.
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='replica_pending_documents'`,
    );
    assert.equal(columns.rows.some(row => /payload/i.test(row.column_name)), false);
  });
});

// ---------------------------------------------------------------------------
// RED 12 — registry checksum and order.
// ---------------------------------------------------------------------------
test('026 registers its own sha256 in migration order', { skip: !approved }, async () => {
  await prepareThrough25();
  await applyMigrationsThrough(26);
  const source = readFileSync(fileURLToPath(migrationPath));
  const checksum = createHash('sha256').update(source).digest('hex');
  await withClient(async client => {
    const row = (await client.query('SELECT checksum FROM schema_migrations WHERE filename=$1', [MIGRATION])).rows[0];
    assert.equal(row.checksum, checksum);
    const registry = (await client.query(
      `SELECT filename FROM schema_migrations WHERE filename ~ '^[0-9]{3}_' ORDER BY filename`,
    )).rows.map(entry => entry.filename);
    const files = readdirSync(sqlDirectory)
      .filter(name => /^[0-9]{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 26)
      .sort();
    assert.deepEqual(registry, files);
    assert.equal(registry.at(-1), MIGRATION);
  });
});

// ---------------------------------------------------------------------------
// Role boundary (design §4.10 "Immutable stream and role boundary").
// ---------------------------------------------------------------------------
test('026 extends the role boundary: NOLOGIN owner, no runtime mutation path', { skip: !approved }, async () => {
  await prepareThrough25();
  await withClient(async client => {
    await setCursor(client, 1, 0);
    await insertStream(client, [{ seq: 1 }]);
  });
  await applyMigrationsThrough(26);
  // GRANT/REVOKE и SET LOCAL ROLE выполняет только привилегированное соединение.
  await withAdmin(async client => {
    const roles = await client.query(
      `SELECT rolname FROM pg_roles WHERE rolname IN
        ('samosval_migration_evidence_owner','samosval_runtime','samosval_maintenance')`,
    );
    assert.equal(roles.rowCount, 3, 'the boundary is extended, never created here');

    const owners = await client.query(
      `SELECT c.relname, r.rolname, r.rolcanlogin
         FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
        WHERE c.relnamespace='public'::regnamespace
          AND c.relname IN ('replica_stream','replica_document_heads','replica_pending_documents')
        ORDER BY c.relname`,
    );
    assert.deepEqual(owners.rows.map(row => [row.relname, row.rolname, row.rolcanlogin]), [
      ['replica_document_heads', 'samosval_migration_evidence_owner', false],
      ['replica_pending_documents', 'samosval_migration_evidence_owner', false],
      ['replica_stream', 'samosval_migration_evidence_owner', false],
    ]);

    const privileges = async (role, table) => (await client.query(
      `SELECT has_table_privilege($1,$2,'INSERT') AS i, has_table_privilege($1,$2,'SELECT') AS s,
              has_table_privilege($1,$2,'UPDATE') AS u, has_table_privilege($1,$2,'DELETE') AS d,
              has_table_privilege($1,$2,'TRIGGER') AS t, has_table_privilege($1,$2,'TRUNCATE') AS x`,
      [role, table],
    )).rows[0];
    const stream = await privileges('samosval_runtime', 'public.replica_stream');
    assert.deepEqual(stream, { i: true, s: true, u: false, d: false, t: false, x: false });
    for (const table of ['public.replica_document_heads', 'public.replica_pending_documents']) {
      assert.deepEqual(await privileges('samosval_runtime', table),
        { i: false, s: true, u: false, d: false, t: false, x: false });
    }

    // The runtime cannot mutate the stream even with drifted grants: the trigger holds.
    // Each probe is its own transaction, because a failed statement aborts a transaction.
    const asRuntime = async (statement, values = []) => {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE samosval_runtime');
        return await client.query(statement, values);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
      }
    };
    await client.query('GRANT UPDATE, DELETE ON TABLE public.replica_stream TO samosval_runtime');
    try {
      await assert.rejects(
        () => asRuntime(`UPDATE replica_stream SET kind='drift' WHERE workspace_id=$1`, [WS]),
        error => error.code === '23514' && /replica-stream-immutable/.test(error.message),
      );
      await assert.rejects(
        () => asRuntime(`DELETE FROM replica_stream WHERE workspace_id=$1`, [WS]),
        error => error.code === '23514' && /replica-stream-immutable/.test(error.message),
      );
    } finally {
      await client.query('REVOKE UPDATE, DELETE ON TABLE public.replica_stream FROM samosval_runtime');
    }
    await assert.rejects(
      () => asRuntime('ALTER TABLE public.replica_stream DISABLE TRIGGER replica_stream_immutable'),
      error => error.code === '42501',
      'the runtime must not be able to disable the trigger',
    );
    await assert.rejects(
      () => asRuntime('ALTER TABLE public.replica_stream ALTER COLUMN kind SET DEFAULT 0'),
      error => error.code === '42501',
    );
    // A direct head/staging write is not a runtime path at all.
    await assert.rejects(
      () => asRuntime(
        `INSERT INTO replica_document_heads(workspace_id,collection,document_id,head_seq,head_kind,canonical_present)
         VALUES($1,'logs','log-runtime',1,'doc.set',false)`,
        [WS],
      ),
      error => error.code === '42501',
    );
    // And the transport path still works for the runtime role.
    await asRuntime(
      `INSERT INTO replica_stream(workspace_id,seq,direction,operation_id,kind,payload,sha256)
       VALUES($1,2,'f2s','op-runtime-insert-1','trip.load','{}',$2)`,
      [WS, sha('runtime-insert')],
    );
    await asRuntime('SELECT f2s_seq FROM replica_cursor WHERE workspace_id=$1 FOR UPDATE', [WS]);
  });
});

test.after(async () => {
  if (!approved) return;
  await resetIsolatedDatabase();
  await applyMigrationsThrough(24);
});
