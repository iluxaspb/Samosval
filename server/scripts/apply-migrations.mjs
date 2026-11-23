#!/usr/bin/env node
// Применяет миграции из ../sql по порядку имени файла через реестр schema_migrations.
// Уже записанные файлы пропускаются; новые применяются в транзакции и
// регистрируются с sha256-чексуммой. Повторный запуск на актуальной базе — no-op.
// Строка подключения: TEST_DATABASE_URL или POSTGRES_* (как у API).
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, '..', 'sql');

export function buildPool(env = process.env) {
  if (env.TEST_DATABASE_URL) return new pg.Pool({ connectionString: env.TEST_DATABASE_URL, max: 1 });
  return new pg.Pool({
    host: env.PGHOST || 'postgres',
    port: Number(env.PGPORT || 5432),
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    max: 1,
  });
}

function migrationNumber(filename) {
  const match = /^(\d+)_.*\.sql$/.exec(filename);
  return match ? Number(match[1]) : null;
}

function migrationBody(source, filename) {
  const lines = source.split(/(?<=\n)/);
  const significant = lines
    .map((line, index) => ({ index, text: line.trim() }))
    .filter(line => line.text && !line.text.startsWith('--'));
  const begins = significant.filter(line => /^BEGIN\s*;$/i.test(line.text));
  const commits = significant.filter(line => /^COMMIT\s*;$/i.test(line.text));
  if (!begins.length && !commits.length) return source;
  const valid = begins.length === 1 && commits.length === 1
    && begins[0] === significant[0] && commits[0] === significant.at(-1);
  if (!valid) throw new Error(`migration ${filename} has an unsafe transaction wrapper`);
  return lines.filter((_, index) => index !== begins[0].index && index !== commits[0].index).join('');
}

export async function applyMigrations(pool, {
  dir = sqlDir,
  exclude = [],
  through = Infinity,
  transformSource = source => source,
} = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum   TEXT
    )`);
  const applied = new Map(
    (await pool.query('SELECT filename,checksum FROM schema_migrations')).rows
      .map(row => [row.filename, row.checksum])
  );
  // Часть миграций защищена guard-ами имени базы (018 только для базы резерва),
  // поэтому каталог целиком применим не в любую БД; исключения задаются явно.
  const excluded = new Set(exclude);
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.sql') && !excluded.has(f))
    .filter(f => migrationNumber(f) === null || migrationNumber(f) <= through)
    .sort();
  const results = [];
  for (const filename of files) {
    const sql = readFileSync(join(dir, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(filename)) {
      if (applied.get(filename) !== checksum) {
        throw new Error(`migration checksum mismatch: ${filename}`);
      }
      results.push({ filename, status: 'skipped' });
      continue;
    }
    const body = migrationBody(transformSource(sql, filename), filename);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(body);
      await client.query(
        'INSERT INTO schema_migrations(filename, checksum) VALUES ($1, $2)',
        [filename, checksum]
      );
      await client.query('COMMIT');
      results.push({ filename, status: 'applied' });
    } catch (error) {
      await client.query('ROLLBACK');
      results.push({ filename, status: 'failed', error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }
  return results;
}

// Прямой запуск (не импорт): применяем и печатаем отчёт.
if (process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].split('/').pop()) && process.argv[1].includes('apply-migrations')) {
  const pool = buildPool();
  // 018 применим только в базе резерва — по умолчанию исключаем.
  const exclude = process.env.MIGRATIONS_EXCLUDE ? process.env.MIGRATIONS_EXCLUDE.split(',').map(s => s.trim()).filter(Boolean) : ['018_auth_credentials.sql'];
  try {
    const results = await applyMigrations(pool, { exclude });
    for (const r of results) {
      if (r.status === 'applied') console.log(`applied  ${r.filename}`);
      else console.log(`skip     ${r.filename}`);
    }
    console.log(`итог: применено ${results.filter(r => r.status === 'applied').length}, пропущено ${results.filter(r => r.status === 'skipped').length}`);
  } catch (error) {
    console.error('миграции не применены:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
