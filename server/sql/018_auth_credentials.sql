-- Локальные учётные записи и сессии для рабочей тестовой базы.
-- Пароли хранятся только как scrypt-хеш с индивидуальной солью, токены — только хешем.
-- Миграция аддитивная: существующие таблицы, включая рабочие данные, не изменяются.
BEGIN;
DO $guard$ BEGIN IF current_database()<>'samosval_working_test_reserve' THEN RAISE EXCEPTION 'working TEST reserve database required'; END IF; END $guard$;

CREATE TABLE IF NOT EXISTS user_credentials (
  uid text PRIMARY KEY REFERENCES app_users(uid) ON DELETE CASCADE,
  password_hash text NOT NULL,
  algorithm text NOT NULL DEFAULT 'scrypt-sha256',
  salt text NOT NULL,
  password_reset_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id text PRIMARY KEY,
  uid text NOT NULL REFERENCES app_users(uid) ON DELETE CASCADE,
  token_hash text NOT NULL,
  device_info jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_uid ON user_sessions(uid);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash text PRIMARY KEY,
  uid text NOT NULL REFERENCES app_users(uid) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_uid ON password_reset_tokens(uid);

COMMIT;
