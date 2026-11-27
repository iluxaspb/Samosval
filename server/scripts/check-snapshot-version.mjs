#!/usr/bin/env node
// Операционная проверка механизма версии данных, на котором держится кэш
// снимков игр и журнала (server/src/snapshot-cache.mjs).
//
// Кэш считает, что «версия данных не изменилась» = «данные те же». Версию
// поднимает триггер reserve_outbox_capture_row, который в рабочих базах создан
// вне этого репозитория (механизм резервной репликации). Поэтому проверять
// покрытие надо на настоящей базе: если таблица, из которой снимок читает
// данные, останется без триггера, её изменения не поднимут версию и телефон
// будет получать 304 на устаревшие данные.
//
// Запуск: node scripts/check-snapshot-version.mjs
// Строка подключения: TEST_DATABASE_URL или POSTGRES_* (как у API).
// Коды выхода: 0 — покрытие полное (или механизма нет вовсе, кэш выключен),
//              1 — есть таблицы без триггера.
import pg from 'pg';

// Таблицы, которые читают loadGamesSnapshot/loadAuxiliarySnapshot и их части.
const READ_TABLES = [
  'game_records',             // записи раундов и поправки монет
  'line_history',             // события линии, из которых строится журнал
  'shifts',                   // объект смены в записях журнала
  'app_users',                // имена авторов и роли
  'line_trucks',              // подпись техники в журнале
  'workspace_settings',       // настройки игр
  'workspace_services_state', // готовность игровой книги
  'workspace_aux_records',    // плагины, патчи, журнал
  'migration_documents',      // импортированные записи журнала
  'migration_imports',        // источник импорта
  'identity_state',           // готовность и хеш импорта
  'workspace_service_audit',  // журнал сервисных операций
  'control_audit',            // журнал управления
  'identity_audit',           // журнал входа
];

const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL || undefined,
  host: process.env.PGHOST || 'postgres',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  max: 1,
});

try {
  const cursor = await pool.query("SELECT to_regclass('public.reserve_outbox_cursor') AS present");
  if (!cursor.rows[0]?.present) {
    console.log('механизма версии данных нет: кэш снимков выключен, проверка не требуется');
    process.exitCode = 0;
  } else {
    const rows = (await pool.query(`SELECT c.relname AS table_name
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND pg_get_triggerdef(t.oid) LIKE '%reserve_outbox_capture_row%'`)).rows;
    const covered = new Set(rows.map(row => row.table_name));
    const missing = READ_TABLES.filter(name => !covered.has(name));
    const sequence = (await pool.query('SELECT last_sequence FROM reserve_outbox_cursor WHERE singleton=true')).rows[0];
    console.log('версия данных:', sequence?.last_sequence, '| таблиц с триггером:', covered.size);
    if (missing.length) {
      console.error('без триггера версии данных: ' + missing.join(', '));
      process.exitCode = 1;
    } else {
      console.log('покрытие полное: все таблицы снимков поднимают версию данных');
      process.exitCode = 0;
    }
  }
} catch (error) {
  console.error('проверка не выполнена:', error.message);
  process.exitCode = 2;
} finally {
  await pool.end();
}
