import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { transformLegacyMigrationGuard } from '../scripts/isolated-db/legacy-guards.mjs';

// Интеграционный тест утилиты apply-migrations на реальном PostgreSQL.
// Тест идёт так, как утилиту использует production: на СВЕЖЕЙ ПУСТОЙ базе.
// Схема-притворщик (SET search_path на отдельную схему) недопустима: 025/026
// намеренно полностью квалифицированы (public.), и в чужой схеме CREATE INDEX
// ON public.<table> падает 42P01. Квалификация — защита от подмены search_path,
// поэтому тест подстраивается под миграции, а не наоборот.
//
// Нужен admin-URL: db-корень получает только app-роль (DML), а здесь нужно
// CREATE DATABASE. Поэтому корень зарегистрирован как harness-contract с
// env ['bootstrap-url'] (docs/opyt-oshibok.md, урок про isolated-db-fixtures).
const bootstrapUrl = process.env.SAMOSVAL_TEST_BOOTSTRAP_URL || process.env.TEST_DATABASE_URL;
const sqlDirectory = fileURLToPath(new URL('../sql', import.meta.url));

// 025 применяется только с bootstrap-нутыми ролями (scripts/parallel-shifts-role-bootstrap.mjs
// в production, шаг создания ролей в .github/workflows/synology-server-tests.yml в CI).
const REQUIRED_ROLES = [
  'samosval_schema_owner',
  'samosval_migration_evidence_owner',
  'samosval_runtime',
  'samosval_maintenance',
];

function scratchDatabaseName() {
  // имя валидно для transformLegacyMigrationGuard: ^[a-z][a-z0-9_]*$, <= 63 байт
  return `samosval_migration_registry_${process.pid}_${randomBytes(6).toString('hex')}`;
}

function urlFor(base, database) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.href;
}

async function requireRoleBoundary(admin) {
  const { rows } = await admin.query(
    'SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY($1)',
    [REQUIRED_ROLES],
  );
  const present = new Set(rows.map(row => row.rolname));
  const missing = REQUIRED_ROLES.filter(role => !present.has(role));
  if (missing.length) {
    throw new Error(`migration 025 requires bootstrapped roles, missing: ${missing.join(', ')}`);
  }
  for (const role of rows) {
    const mustLogin = role.rolname === 'samosval_runtime' || role.rolname === 'samosval_maintenance';
    if (role.rolsuper || role.rolbypassrls) {
      throw new Error(`role ${role.rolname} must be NOSUPERUSER NOBYPASSRLS before migration 025`);
    }
    if (role.rolcanlogin !== mustLogin) {
      throw new Error(`role ${role.rolname} has wrong login attribute before migration 025`);
    }
  }
}

// Одна свежая база на прогон: создаётся из template0, удаляется в finally даже
// при падении. Незакрытый пул/неудалённая база вешают следующий прогон.
async function withScratchDatabase(run) {
  const admin = new pg.Client({ connectionString: bootstrapUrl });
  await admin.connect();
  const name = scratchDatabaseName();
  let pool;
  let created = false;
  try {
    await requireRoleBoundary(admin);
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    pool = new pg.Pool({ connectionString: urlFor(bootstrapUrl, name), max: 1 });
    // Idle clients can be terminated by DROP DATABASE ... WITH (FORCE) in the
    // teardown below; an unhandled 'error' event would fail the test run.
    pool.on('error', () => {});
    await run({ name, pool });
  } finally {
    if (pool) await pool.end().catch(() => {});
    if (created) {
      // Wait until the pool's backend is really gone: FORCE-terminating it while
      // the socket is half-closed surfaces as an uncaught 57P01.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [name]);
        if (rows[0].n === 0) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
      const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname = $1', [name]);
      if (rows[0].n !== 0) throw new Error(`scratch database ${name} leaked after the run`);
    }
    await admin.end().catch(() => {});
  }
}

const optionsFor = name => ({
  exclude: ['018_auth_credentials.sql'],
  transformSource: (sql, filename) => transformLegacyMigrationGuard(sql, filename, name),
  requireRoleBoundary: true,
});

const registry = pool => pool
  .query('SELECT filename, checksum FROM schema_migrations ORDER BY filename')
  .then(result => result.rows);

test('apply-migrations: применяет все файлы sql/ на пустой базе, пишет sha256 и повторяется как no-op', { skip: bootstrapUrl ? false : 'SAMOSVAL_TEST_BOOTSTRAP_URL (или TEST_DATABASE_URL) не задан' }, async () => {
  await withScratchDatabase(async ({ name, pool }) => {
    // 018 применим только в базе резерва samosval_working_test_reserve (guard имени БД).
    // 29 файлов в sql/ минус 018 = 28 применяемых миграций (последняя — 031).
    const options = optionsFor(name);
    const first = await applyMigrations(pool, options);
    assert.equal(first.length, 28, `ожидали 28 миграций (29 файлов минус 018), применено ${first.length}`);
    assert.ok(first.every(r => r.status === 'applied'));

    // Реестр заполнен целиком, чексуммы — sha256 реальных файлов.
    const afterFirst = await registry(pool);
    assert.equal(afterFirst.length, first.length);
    for (const row of afterFirst) assert.match(row.checksum, /^[0-9a-f]{64}$/);
    assert.ok(afterFirst.some(row => row.filename === '021_migration_registry.sql'), 'реестр содержит 021_migration_registry.sql');
    assert.ok(afterFirst.some(row => row.filename === '025_parallel_shifts_core.sql'), 'реестр содержит 025_parallel_shifts_core.sql');
    assert.ok(afterFirst.some(row => row.filename === '026_parallel_shift_dependencies.sql'), 'реестр содержит 026_parallel_shift_dependencies.sql');
    assert.ok(afterFirst.some(row => row.filename === '029_shift_close_v2.sql'), 'реестр содержит 029_shift_close_v2.sql');
    assert.ok(afterFirst.some(row => row.filename === '030_line_status_payload_mirror.sql'), 'реестр содержит 030_line_status_payload_mirror.sql');
    assert.ok(afterFirst.some(row => row.filename === '031_no_return_permission.sql'), 'реестр содержит 031_no_return_permission.sql');

    // 025 действительно создал в public то, что индексирует 026: прежний
    // search_path-притворщик ломался именно здесь (42P01).
    for (const object of [
      'public.restored_shift_contexts',
      'public.shift_archive_series',
      'public.restored_context_migration_evidence',
    ]) {
      const { rows } = await pool.query('SELECT to_regclass($1) AS object', [object]);
      assert.notEqual(rows[0].object, null, `${object} должен существовать после 025`);
    }

    // Повторный запуск — чистый no-op: ни одной новой записи, ни одной новой миграции.
    const second = await applyMigrations(pool, options);
    assert.equal(second.length, first.length);
    assert.ok(second.every(r => r.status === 'skipped'), 'повтор должен полностью скипаться');
    assert.deepEqual(await registry(pool), afterFirst, 'повтор не меняет реестр');

    // Дрейф чексуммы уже применённого файла ловится: копия sql/ с изменённым
    // файлом не должна ни примениться, ни изменить реестр.
    const copyDirectory = await mkdtemp(join(tmpdir(), 'samosval-migrations-'));
    try {
      await cp(sqlDirectory, copyDirectory, { recursive: true });
      await appendFile(join(copyDirectory, '021_migration_registry.sql'), '\n-- checksum drift probe\n');
      await assert.rejects(
        () => applyMigrations(pool, { ...options, dir: copyDirectory }),
        /migration checksum mismatch: 021_migration_registry\.sql/,
      );
      assert.deepEqual(await registry(pool), afterFirst, 'дрейф чексуммы не меняет реестр');
    } finally {
      await rm(copyDirectory, { recursive: true, force: true });
    }
  });
});
