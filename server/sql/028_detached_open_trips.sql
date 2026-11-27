-- Параллельные смены, задача 20: detached open trips (design §3.3, §4.4, §7).
--
-- Force transfer оставляет незавершённый цикл в исходной смене. Этот цикл — не
-- второй truck status, а отдельная сущность: она адресуется навсегда
-- (workspace_id, source_shift_id, cycle_id) и завершается только online-командой
-- из source shift. Таблица создаётся здесь, потому что план Task 20 не включал
-- миграцию, а read-контракт §5.1 (`readDetachedOpenTrips`) уже написан под неё.
--
-- Инварианты, которые держит сама БД, а не только сервер:
--   * не больше одного open цикла на (workspace, truck) — частичный unique;
--   * open цикл существует только тогда, когда текущий status этого truck уже
--     стоит в destination shift (триггер), иначе право «участник новой линии»
--     было бы неоднозначным;
--   * пока цикл open, обычный remove/transfer этого truck невозможен: смена
--     shift_id или DELETE строки status отклоняются триггером;
--   * завершённая строка не удаляется и не переоткрывается, ссылки на обе
--     операции сохраняются (receipt provenance).
--
-- `source_cycle_revision` — нормализованная ревизия исходного цикла на момент
-- отделения. Она нужна, чтобы вывести канонический id рейса
-- (`load_<truck>_<shift>_cycle_<revision>_<arrival>`) по колонке, а не по
-- снапшоту payload: payload — доказательство того, что именно отделили, и
-- единственным источником нормализованных полей он не является (§4.4).
BEGIN;

CREATE TABLE IF NOT EXISTS detached_open_trips (
  workspace_id text NOT NULL,
  source_shift_id text NOT NULL,
  cycle_id text NOT NULL,
  truck_id text NOT NULL,
  destination_shift_id text NOT NULL,
  state text NOT NULL,
  stage text NOT NULL,
  cycle_revision bigint NOT NULL DEFAULT 1,
  source_status_revision bigint NOT NULL,
  source_cycle_revision bigint NOT NULL,
  source_ttn_revision bigint NOT NULL,
  payload jsonb NOT NULL,
  detached_at timestamptz NOT NULL DEFAULT now(),
  detached_by_uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  completed_at timestamptz,
  completed_by_uid text REFERENCES app_users(uid) ON DELETE RESTRICT,
  transfer_operation_id text NOT NULL,
  completion_operation_id text,
  CONSTRAINT detached_open_trips_pkey PRIMARY KEY (workspace_id, source_shift_id, cycle_id),
  CONSTRAINT detached_open_trips_state_check CHECK (state IN ('open', 'completed')),
  CONSTRAINT detached_open_trips_stage_check CHECK (stage IN ('load', 'ttn')),
  CONSTRAINT detached_open_trips_cycle_id_check CHECK (cycle_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  CONSTRAINT detached_open_trips_cycle_revision_check CHECK (cycle_revision > 0),
  CONSTRAINT detached_open_trips_source_revision_check CHECK (source_status_revision > 0 AND source_cycle_revision > 0 AND source_ttn_revision > 0),
  CONSTRAINT detached_open_trips_distinct_shifts_check CHECK (source_shift_id <> destination_shift_id),
  -- Состояние и его audit-поля двигаются вместе: open без завершивших полей,
  -- completed — только с ними.
  CONSTRAINT detached_open_trips_state_fields_check CHECK (
    (state = 'open' AND completed_at IS NULL AND completed_by_uid IS NULL AND completion_operation_id IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL AND completed_by_uid IS NOT NULL AND completion_operation_id IS NOT NULL)
  ),
  CONSTRAINT detached_open_trips_source_shift_fk FOREIGN KEY (workspace_id, source_shift_id)
    REFERENCES shifts(workspace_id, shift_id) ON DELETE RESTRICT,
  CONSTRAINT detached_open_trips_destination_shift_fk FOREIGN KEY (workspace_id, destination_shift_id)
    REFERENCES shifts(workspace_id, shift_id) ON DELETE RESTRICT,
  CONSTRAINT detached_open_trips_truck_fk FOREIGN KEY (workspace_id, truck_id)
    REFERENCES line_trucks(workspace_id, truck_id) ON DELETE RESTRICT
);

-- Цепочка незавершённых циклов одного truck не накапливается (§3.3).
CREATE UNIQUE INDEX IF NOT EXISTS detached_open_trips_open_truck_uidx
  ON detached_open_trips(workspace_id, truck_id) WHERE state = 'open';
-- Обе линии показывают свои open циклы; завершённые читаются по source.
CREATE INDEX IF NOT EXISTS detached_open_trips_source_idx
  ON detached_open_trips(workspace_id, source_shift_id, state);
CREATE INDEX IF NOT EXISTS detached_open_trips_destination_idx
  ON detached_open_trips(workspace_id, destination_shift_id, state);

CREATE OR REPLACE FUNCTION detached_open_trip_guard() RETURNS trigger
LANGUAGE plpgsql AS $detached_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Открытый цикл нельзя потерять: пока он не завершён, строка — единственное
    -- место, где живёт сохранённая стадия. Завершённую строку разрешено удалить
    -- только обслуживанию (restore/maintenance), обычный путь её не трогает.
    IF OLD.state = 'open' THEN
      RAISE EXCEPTION 'truck-detached-trip-open: an open detached trip cannot be deleted'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.state = 'completed' THEN
      RAISE EXCEPTION 'detached-trip-completed: a completed detached trip is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'open' THEN
      RAISE EXCEPTION 'detached-trip-open: a detached trip can only move to completed'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.workspace_id <> OLD.workspace_id
       OR NEW.source_shift_id <> OLD.source_shift_id
       OR NEW.cycle_id <> OLD.cycle_id
       OR NEW.truck_id <> OLD.truck_id
       OR NEW.destination_shift_id <> OLD.destination_shift_id
       OR NEW.stage <> OLD.stage
       OR NEW.source_status_revision <> OLD.source_status_revision
       OR NEW.source_cycle_revision <> OLD.source_cycle_revision
       OR NEW.source_ttn_revision <> OLD.source_ttn_revision
       OR NEW.payload <> OLD.payload
       OR NEW.detached_at <> OLD.detached_at
       OR NEW.detached_by_uid <> OLD.detached_by_uid
       OR NEW.transfer_operation_id <> OLD.transfer_operation_id THEN
      RAISE EXCEPTION 'detached-trip-context-immutable: only the completion fields may change'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT: open цикл живёт только рядом с текущим назначением в destination.
  IF NOT EXISTS (
    SELECT 1 FROM line_truck_statuses st
     WHERE st.workspace_id = NEW.workspace_id
       AND st.truck_id = NEW.truck_id
       AND st.shift_id = NEW.destination_shift_id
  ) THEN
    RAISE EXCEPTION 'detached-trip-destination-mismatch: the current status must already be in %',
      NEW.destination_shift_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$detached_guard$;

CREATE TRIGGER detached_open_trips_guard
  BEFORE INSERT OR UPDATE OR DELETE ON detached_open_trips
  FOR EACH ROW EXECUTE FUNCTION detached_open_trip_guard();

-- Пока цикл open, truck нельзя убрать из destination или перевести ещё раз:
-- право «участник новой линии» должно оставаться однозначным (§4.4).
CREATE OR REPLACE FUNCTION line_truck_status_detached_guard() RETURNS trigger
LANGUAGE plpgsql AS $status_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM detached_open_trips d
       WHERE d.workspace_id = OLD.workspace_id AND d.truck_id = OLD.truck_id AND d.state = 'open'
    ) THEN
      RAISE EXCEPTION 'truck-detached-trip-open: the truck still has an open detached trip'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.shift_id IS DISTINCT FROM OLD.shift_id
     AND EXISTS (
       SELECT 1 FROM detached_open_trips d
        WHERE d.workspace_id = OLD.workspace_id AND d.truck_id = OLD.truck_id AND d.state = 'open'
     ) THEN
    RAISE EXCEPTION 'truck-detached-trip-open: the truck still has an open detached trip'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$status_guard$;

CREATE TRIGGER line_truck_statuses_detached_guard
  BEFORE UPDATE OR DELETE ON line_truck_statuses
  FOR EACH ROW EXECUTE FUNCTION line_truck_status_detached_guard();

-- Граница ролей §4.4/§4.6: это операционная таблица, а не evidence. У
-- samosval_runtime/samosval_maintenance нет DML и на shifts, line_logs,
-- line_truck_statuses, поэтому здесь им тоже ничего не выдаётся — иначе
-- «runtime read-only» перестало бы быть правдой. Права приложения выдаются
-- отдельно (в изолированном прогоне — grantTargetAccess после клонирования).
REVOKE ALL ON TABLE public.detached_open_trips FROM PUBLIC;
REVOKE ALL ON FUNCTION public.detached_open_trip_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.line_truck_status_detached_guard() FROM PUBLIC;

COMMIT;
