-- Реестр применённых миграций: утилита apply-migrations.mjs записывает сюда
-- каждый выполненный файл с sha256-чексуммой и повторно его не применяет.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum   TEXT
);
