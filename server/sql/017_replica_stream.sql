-- Журнал репликации Firebase <-> Ubuntu (рабочая тестовая версия).
-- Назначение: минутная передача только изменённых операций, идемпотентно,
-- со строгой последовательностью без «дыр» от повторных отправок.
-- Полные копии базы не делаются.
BEGIN;

CREATE TABLE IF NOT EXISTS replica_stream (
  workspace_id text NOT NULL,
  -- seq назначается из replica_cursor под блокировкой: только по факту
  -- применения, поэтому повтор (тот же operation_id) номер не расходует.
  seq          bigint NOT NULL CHECK (seq > 0),
  direction    text NOT NULL CHECK (direction IN ('f2s','s2f')),
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_.:-]{8,160}$'),
  kind         text NOT NULL,
  payload      jsonb,
  sha256       text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, seq),
  -- Повторная отправка того же operation_id не создаёт дубликат.
  UNIQUE (workspace_id, direction, operation_id)
);

CREATE TABLE IF NOT EXISTS replica_cursor (
  workspace_id text PRIMARY KEY,
  f2s_seq      bigint NOT NULL DEFAULT 0 CHECK (f2s_seq >= 0),
  s2f_seq      bigint NOT NULL DEFAULT 0 CHECK (s2f_seq >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO replica_cursor(workspace_id) VALUES ('main_workspace')
  ON CONFLICT (workspace_id) DO NOTHING;

COMMIT;