import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildPool, applyMigrations } from '../scripts/apply-migrations.mjs';
import { retargetLegacyGuard } from './helpers/isolated-db.mjs';

// Интеграционный тест утилиты apply-migrations на реальном PostgreSQL.
// Без TEST_DATABASE_URL пропускается (как остальные PG-тесты).
const connectionString = process.env.TEST_DATABASE_URL;

test('apply-migrations: применяет все файлы sql/ и регистрирует их; повтор — no-op', { skip: !connectionString }, async () => {
  const pool = buildPool();
  const schema = 'mig_registry_test';
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);

    // Гоняем утилиту в изолированной схеме: таблицы создаются в search_path схемы.
    // 018 применим только в базе резерва samosval_working_test_reserve (guard имени БД).
    const options = { exclude: ['018_auth_credentials.sql'], transformSource: retargetLegacyGuard };
    const first = await applyMigrations(pool, options);
    assert.ok(first.length >= 21, `ожидали минимум 21 миграцию, применено ${first.length}`);
    assert.ok(first.every(r => r.status === 'applied'));

    // Реестр заполнен, чексуммы sha256 присутствуют.
    const rows = (await pool.query('SELECT filename, checksum FROM schema_migrations ORDER BY filename')).rows;
    assert.equal(rows.length, first.length);
    for (const r of rows) assert.match(r.checksum, /^[0-9a-f]{64}$/);
    assert.ok(rows.some(r => r.filename === '021_migration_registry.sql'), 'реестр содержит 021_migration_registry.sql');

    // Повторный запуск — чистый no-op.
    const second = await applyMigrations(pool, options);
    assert.ok(second.length >= 1);
    assert.ok(second.every(r => r.status === 'skipped'), 'повтор должен полностью скипаться');
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});
