-- Additive core schema for parallel shifts. Normalized columns become canonical;
-- legacy is_active remains as a consistency bridge during the v1/v2 cutover.
BEGIN;

ALTER TABLE shifts
  ADD COLUMN state text,
  ADD COLUMN object_id text,
  ADD COLUMN object_name_snapshot text,
  ADD COLUMN work_date date,
  ADD COLUMN shift_type text,
  ADD COLUMN opened_at timestamptz,
  ADD COLUMN opened_by_uid text,
  ADD COLUMN object_locked_at timestamptz,
  ADD COLUMN object_locked_by_operation_id text,
  ADD COLUMN closing_started_at timestamptz,
  ADD COLUMN closing_by_uid text,
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_by_uid text,
  ADD COLUMN revision bigint DEFAULT 1;

DO $validate_legacy_shifts$
DECLARE
  bad record;
BEGIN
  SELECT workspace_id,shift_id INTO bad
    FROM shifts s
   WHERE s.payload->>'id' IS DISTINCT FROM s.shift_id
      OR jsonb_typeof(s.payload->'isActive') IS DISTINCT FROM 'boolean'
      OR (s.payload->>'isActive')::boolean IS DISTINCT FROM s.is_active
      OR NULLIF(btrim(s.payload->>'objectId'),'') IS NULL
      OR NOT EXISTS (
           SELECT 1 FROM workspace_objects o
            WHERE o.workspace_id=s.workspace_id
              AND o.object_id=s.payload->>'objectId'
         )
      OR NULLIF(btrim(s.payload->>'objectName'),'') IS NULL
      OR NULLIF(btrim(s.payload->>'startedByUid'),'') IS NULL
      OR NOT EXISTS (
           SELECT 1 FROM app_users u WHERE u.uid=s.payload->>'startedByUid'
         )
      OR jsonb_typeof(s.payload->'startedAt') IS DISTINCT FROM 'number'
      OR (s.payload->>'startedAt') !~ '^[0-9]+$'
      OR (s.payload ? 'workShift' AND s.payload->>'workShift' NOT IN ('day','night'))
      OR (s.payload ? 'type' AND s.payload->>'type' NOT IN ('day','night'))
      OR (s.payload ? 'workShift' AND s.payload ? 'type'
          AND s.payload->>'workShift' IS DISTINCT FROM s.payload->>'type')
      OR (s.payload->>'startDate') !~ '^([0-2][0-9]|3[01])\.(0[1-9]|1[0-2])\.[0-9]{4}$'
      OR to_char(to_timestamp((s.payload->>'startedAt')::double precision / 1000.0)
                 AT TIME ZONE 'Europe/Moscow','DD.MM.YYYY') <> s.payload->>'startDate'
      OR (s.payload ? 'shiftId' AND s.payload->>'shiftId' IS DISTINCT FROM s.shift_id)
      OR (s.payload ? 'state' AND s.payload->>'state' IS DISTINCT FROM
            CASE WHEN s.payload->>'closing'='true' THEN 'closing'
                 WHEN s.is_active THEN 'active' ELSE 'closed' END)
      OR (s.payload ? 'date' AND s.payload->>'date' IS DISTINCT FROM
            to_char(to_date(s.payload->>'startDate','DD.MM.YYYY'),'YYYY-MM-DD'))
      OR (s.payload ? 'type' AND s.payload->>'type' IS DISTINCT FROM s.payload->>'workShift')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'unsafe legacy shift payload for workspace %, shift %', bad.workspace_id, bad.shift_id
      USING ERRCODE='check_violation';
  END IF;
END
$validate_legacy_shifts$;

DO $validate_confirmed_activity_timestamps$
DECLARE
  bad record;
BEGIN
  SELECT workspace_id,shift_id,source INTO bad
    FROM (
      SELECT l.workspace_id,l.shift_id,'line_log'::text AS source,l.payload->'timestamp' AS event_time
        FROM line_logs l
      UNION ALL
      SELECT t.workspace_id,t.shift_id,'arrival'::text,t.payload->'arriveTimestamp'
        FROM line_truck_statuses t
       WHERE NULLIF(btrim(t.payload->>'arriveStatus'),'') IS NOT NULL
      UNION ALL
      SELECT t.workspace_id,t.shift_id,'load'::text,t.payload->'lastLoadTimestamp'
        FROM line_truck_statuses t
       WHERE NULLIF(btrim(t.payload->>'lastLoadLogId'),'') IS NOT NULL
    ) confirmed
   WHERE CASE
     WHEN jsonb_typeof(event_time)='number' AND event_time #>> '{}' ~ '^[0-9]+$'
       THEN (event_time #>> '{}')::numeric < 946684800000
         OR (event_time #>> '{}')::numeric >= 4102444800000
     ELSE true
   END
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'unsafe confirmed activity timestamp for workspace %, shift %, source %',
      bad.workspace_id,bad.shift_id,bad.source
      USING ERRCODE='check_violation';
  END IF;
END
$validate_confirmed_activity_timestamps$;

UPDATE shifts s
   SET state = CASE WHEN s.payload->>'closing'='true' THEN 'closing'
                    WHEN s.is_active THEN 'active' ELSE 'closed' END,
       object_id = s.payload->>'objectId',
       object_name_snapshot = s.payload->>'objectName',
       work_date = to_date(s.payload->>'startDate','DD.MM.YYYY'),
       shift_type = COALESCE(NULLIF(s.payload->>'workShift',''),
         CASE WHEN extract(hour FROM to_timestamp((s.payload->>'startedAt')::double precision / 1000.0)
                    AT TIME ZONE 'Europe/Moscow') BETWEEN 8 AND 19
              THEN 'day' ELSE 'night' END),
       opened_at = to_timestamp((s.payload->>'startedAt')::double precision / 1000.0),
       opened_by_uid = s.payload->>'startedByUid',
       object_locked_at = (
         SELECT to_timestamp(min(event_ms)::double precision / 1000.0)
           FROM (
             SELECT (l.payload->>'timestamp')::numeric AS event_ms
               FROM line_logs l
              WHERE l.workspace_id=s.workspace_id AND l.shift_id=s.shift_id
             UNION ALL
             SELECT (t.payload->>'arriveTimestamp')::numeric
               FROM line_truck_statuses t
              WHERE t.workspace_id=s.workspace_id AND t.shift_id=s.shift_id
                AND NULLIF(btrim(t.payload->>'arriveStatus'),'') IS NOT NULL
             UNION ALL
             SELECT (t.payload->>'lastLoadTimestamp')::numeric
               FROM line_truck_statuses t
              WHERE t.workspace_id=s.workspace_id AND t.shift_id=s.shift_id
                AND NULLIF(btrim(t.payload->>'lastLoadLogId'),'') IS NOT NULL
           ) confirmed_events
          WHERE event_ms > 0
       ),
       closing_started_at = CASE
         WHEN s.payload->>'closing'='true' AND jsonb_typeof(s.payload->'closingStartedAt')='number'
         THEN to_timestamp((s.payload->>'closingStartedAt')::double precision / 1000.0)
       END,
       closing_by_uid = CASE WHEN s.payload->>'closing'='true'
         THEN NULLIF(s.payload->>'closingByUid','') END,
       closed_at = CASE
         WHEN NOT s.is_active AND s.payload->>'closing' IS DISTINCT FROM 'true'
              AND jsonb_typeof(s.payload->'closedAt')='number'
         THEN to_timestamp((s.payload->>'closedAt')::double precision / 1000.0)
       END,
       closed_by_uid = CASE WHEN NOT s.is_active AND s.payload->>'closing' IS DISTINCT FROM 'true'
         THEN NULLIF(s.payload->>'closedByUid','') END,
       revision = 1;

ALTER TABLE shifts
  ALTER COLUMN state SET NOT NULL,
  ALTER COLUMN object_id SET NOT NULL,
  ALTER COLUMN object_name_snapshot SET NOT NULL,
  ALTER COLUMN work_date SET NOT NULL,
  ALTER COLUMN shift_type SET NOT NULL,
  ALTER COLUMN opened_at SET NOT NULL,
  ALTER COLUMN opened_by_uid SET NOT NULL,
  ALTER COLUMN revision SET NOT NULL,
  ADD CONSTRAINT shifts_state_check CHECK (state IN ('active','closing','closed')),
  ADD CONSTRAINT shifts_shift_type_check CHECK (shift_type IN ('day','night')),
  ADD CONSTRAINT shifts_revision_check CHECK (revision > 0),
  ADD CONSTRAINT shifts_legacy_active_check CHECK (is_active = (state = 'active')),
  ADD CONSTRAINT shifts_object_fk FOREIGN KEY (workspace_id,object_id)
    REFERENCES workspace_objects(workspace_id,object_id),
  ADD CONSTRAINT shifts_opened_by_fk FOREIGN KEY (opened_by_uid) REFERENCES app_users(uid),
  ADD CONSTRAINT shifts_closing_by_fk FOREIGN KEY (closing_by_uid) REFERENCES app_users(uid),
  ADD CONSTRAINT shifts_closed_by_fk FOREIGN KEY (closed_by_uid) REFERENCES app_users(uid);

CREATE UNIQUE INDEX shifts_one_open_canonical_key
  ON shifts(workspace_id,object_id,work_date,shift_type)
  WHERE state IN ('active','closing');
CREATE INDEX shifts_state_opened_idx ON shifts(workspace_id,state,opened_at);
CREATE INDEX shifts_object_date_idx ON shifts(workspace_id,object_id,work_date);

CREATE OR REPLACE FUNCTION shifts_legacy_bridge() RETURNS trigger
LANGUAGE plpgsql AS $bridge$
DECLARE
  legacy_write boolean;
  payload_state text;
  payload_date date;
  payload_type text;
BEGIN
  IF TG_OP='UPDATE' AND NEW.is_active IS DISTINCT FROM OLD.is_active
     AND NEW.payload IS NOT DISTINCT FROM OLD.payload
     AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'ambiguous legacy active update' USING ERRCODE='check_violation';
  END IF;

  legacy_write := TG_OP='INSERT' AND NEW.state IS NULL
    OR TG_OP='UPDATE' AND NEW.payload IS DISTINCT FROM OLD.payload
       AND NEW.state IS NOT DISTINCT FROM OLD.state
       AND NEW.object_id IS NOT DISTINCT FROM OLD.object_id
       AND NEW.object_name_snapshot IS NOT DISTINCT FROM OLD.object_name_snapshot
       AND NEW.work_date IS NOT DISTINCT FROM OLD.work_date
       AND NEW.shift_type IS NOT DISTINCT FROM OLD.shift_type
       AND NEW.opened_at IS NOT DISTINCT FROM OLD.opened_at
       AND NEW.opened_by_uid IS NOT DISTINCT FROM OLD.opened_by_uid;

  IF legacy_write THEN
    IF NEW.payload->>'id' IS DISTINCT FROM NEW.shift_id
       OR (NEW.payload ? 'shiftId' AND NEW.payload->>'shiftId' IS DISTINCT FROM NEW.shift_id)
       OR NULLIF(btrim(NEW.payload->>'objectId'),'') IS NULL
       OR NULLIF(btrim(NEW.payload->>'objectName'),'') IS NULL
       OR NULLIF(btrim(NEW.payload->>'startedByUid'),'') IS NULL
       OR jsonb_typeof(NEW.payload->'startedAt') IS DISTINCT FROM 'number'
       OR (NEW.payload->>'startedAt') !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.payload->'isActive') IS DISTINCT FROM 'boolean'
    THEN
      RAISE EXCEPTION 'unsafe legacy shift payload' USING ERRCODE='check_violation';
    END IF;
    payload_date := CASE
      WHEN NEW.payload->>'startDate' ~ '^([0-2][0-9]|3[01])\.(0[1-9]|1[0-2])\.[0-9]{4}$'
        THEN to_date(NEW.payload->>'startDate','DD.MM.YYYY')
      WHEN NEW.payload->>'date' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$'
        THEN (NEW.payload->>'date')::date
    END;
    IF payload_date IS NULL THEN
      RAISE EXCEPTION 'unsafe legacy shift date' USING ERRCODE='check_violation';
    END IF;
    payload_type := COALESCE(NULLIF(NEW.payload->>'workShift',''),NULLIF(NEW.payload->>'type',''));
    IF payload_type IS NULL THEN
      payload_type := CASE WHEN extract(hour FROM to_timestamp((NEW.payload->>'startedAt')::double precision / 1000.0) AT TIME ZONE 'Europe/Moscow') BETWEEN 8 AND 19 THEN 'day' ELSE 'night' END;
    END IF;
    IF payload_type NOT IN ('day','night')
       OR (NEW.payload ? 'workShift' AND NEW.payload ? 'type'
           AND NEW.payload->>'workShift' IS DISTINCT FROM NEW.payload->>'type')
    THEN
      RAISE EXCEPTION 'unsafe legacy shift type' USING ERRCODE='check_violation';
    END IF;
    payload_state := CASE WHEN NEW.payload->>'closing'='true' THEN 'closing'
                          WHEN (NEW.payload->>'isActive')::boolean THEN 'active' ELSE 'closed' END;
    IF NEW.payload ? 'state' AND NEW.payload->>'state' IS DISTINCT FROM payload_state THEN
      RAISE EXCEPTION 'unsafe legacy shift state' USING ERRCODE='check_violation';
    END IF;
    NEW.state := payload_state;
    NEW.object_id := NEW.payload->>'objectId';
    NEW.object_name_snapshot := NEW.payload->>'objectName';
    NEW.work_date := payload_date;
    NEW.shift_type := payload_type;
    NEW.opened_at := to_timestamp((NEW.payload->>'startedAt')::double precision / 1000.0);
    NEW.opened_by_uid := NEW.payload->>'startedByUid';
    NEW.closing_started_at := CASE WHEN payload_state='closing' AND jsonb_typeof(NEW.payload->'closingStartedAt')='number'
      THEN to_timestamp((NEW.payload->>'closingStartedAt')::double precision / 1000.0) END;
    NEW.closing_by_uid := CASE WHEN payload_state='closing' THEN NULLIF(NEW.payload->>'closingByUid','') END;
    NEW.closed_at := CASE WHEN payload_state='closed' AND jsonb_typeof(NEW.payload->'closedAt')='number'
      THEN to_timestamp((NEW.payload->>'closedAt')::double precision / 1000.0) END;
    NEW.closed_by_uid := CASE WHEN payload_state='closed' THEN NULLIF(NEW.payload->>'closedByUid','') END;
    NEW.revision := COALESCE(NEW.revision,1);
  END IF;

  IF NEW.state='active' THEN NEW.is_active := true;
  ELSIF NEW.state='closed' THEN NEW.is_active := false;
  END IF;

  IF TG_OP='UPDATE' AND OLD.object_locked_at IS NOT NULL
     AND NEW.object_id IS DISTINCT FROM OLD.object_id THEN
    RAISE EXCEPTION 'shift object is locked' USING ERRCODE='check_violation';
  END IF;

  IF NEW.payload->>'id' IS DISTINCT FROM NEW.shift_id
     OR NULLIF(btrim(NEW.payload->>'objectId'),'') IS NULL
     OR NEW.payload->>'objectId' IS DISTINCT FROM NEW.object_id
     OR NULLIF(btrim(NEW.payload->>'objectName'),'') IS NULL
     OR NEW.payload->>'objectName' IS DISTINCT FROM NEW.object_name_snapshot
     OR jsonb_typeof(NEW.payload->'startedAt') IS DISTINCT FROM 'number'
     OR (NEW.payload->>'startedAt') !~ '^[0-9]+$'
     OR to_timestamp((NEW.payload->>'startedAt')::double precision / 1000.0) IS DISTINCT FROM NEW.opened_at
     OR NULLIF(btrim(NEW.payload->>'startedByUid'),'') IS NULL
     OR NEW.payload->>'startedByUid' IS DISTINCT FROM NEW.opened_by_uid
     OR jsonb_typeof(NEW.payload->'isActive') IS DISTINCT FROM 'boolean'
     OR (NEW.payload->>'isActive')::boolean IS DISTINCT FROM NEW.is_active
     OR (NOT (NEW.payload ? 'startDate') AND NOT (NEW.payload ? 'date'))
     OR (NEW.payload ? 'shiftId' AND NEW.payload->>'shiftId' IS DISTINCT FROM NEW.shift_id)
     OR (NEW.payload ? 'date' AND NEW.payload->>'date' IS DISTINCT FROM to_char(NEW.work_date,'YYYY-MM-DD'))
     OR (NEW.payload ? 'startDate' AND NEW.payload->>'startDate' IS DISTINCT FROM to_char(NEW.work_date,'DD.MM.YYYY'))
     OR (NEW.payload ? 'type' AND NEW.payload->>'type' IS DISTINCT FROM NEW.shift_type)
     OR (NEW.payload ? 'workShift' AND NEW.payload->>'workShift' IS DISTINCT FROM NEW.shift_type)
     OR (NEW.payload ? 'state' AND NEW.payload->>'state' IS DISTINCT FROM NEW.state)
     OR (NEW.payload ? 'closing' AND (NEW.payload->>'closing')::boolean IS DISTINCT FROM (NEW.state='closing'))
  THEN
    RAISE EXCEPTION 'shift canonical payload mismatch' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END
$bridge$;
CREATE TRIGGER shifts_legacy_bridge_trigger
  BEFORE INSERT OR UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION shifts_legacy_bridge();

CREATE TABLE shift_members (
  workspace_id text NOT NULL,
  shift_id text NOT NULL,
  uid text NOT NULL REFERENCES app_users(uid),
  assigned_at timestamptz NOT NULL,
  assigned_by_uid text NOT NULL REFERENCES app_users(uid),
  removed_at timestamptz,
  removed_by_uid text REFERENCES app_users(uid),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY(workspace_id,shift_id,uid),
  FOREIGN KEY(workspace_id,shift_id) REFERENCES shifts(workspace_id,shift_id),
  CHECK ((removed_at IS NULL) = (removed_by_uid IS NULL))
);

CREATE OR REPLACE FUNCTION enforce_shift_member_role() RETURNS trigger
LANGUAGE plpgsql AS $member_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_users u WHERE u.uid=NEW.uid) THEN
    RETURN NEW; -- let the declared FK report an unknown user
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_users u
     WHERE u.uid=NEW.uid AND u.status='active'
       AND u.role IN ('senior_foreman','foreman')
  ) THEN
    RAISE EXCEPTION 'shift member must be an active foreman'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END
$member_role$;
CREATE TRIGGER shift_members_role_trigger
  BEFORE INSERT OR UPDATE OF uid ON shift_members
  FOR EACH ROW EXECUTE FUNCTION enforce_shift_member_role();

CREATE INDEX shift_members_active_user_idx
  ON shift_members(workspace_id,uid,shift_id) WHERE removed_at IS NULL;
CREATE INDEX shift_members_active_shift_idx
  ON shift_members(workspace_id,shift_id,uid) WHERE removed_at IS NULL;

ALTER TABLE line_truck_statuses
  ADD COLUMN status_revision bigint NOT NULL DEFAULT 1 CHECK (status_revision > 0),
  ADD COLUMN cycle_revision bigint,
  ADD COLUMN ttn_revision bigint;

DO $validate_status_revisions$
DECLARE bad record;
BEGIN
  SELECT workspace_id,truck_id INTO bad
    FROM line_truck_statuses
   WHERE (payload ? 'shiftId' AND payload->>'shiftId' IS DISTINCT FROM shift_id)
      OR (payload ? 'cycleRevision' AND
          (jsonb_typeof(payload->'cycleRevision') IS DISTINCT FROM 'number'
           OR (payload->>'cycleRevision') !~ '^[1-9][0-9]*$'))
      OR (payload ? 'ttnRevision' AND
          (jsonb_typeof(payload->'ttnRevision') IS DISTINCT FROM 'number'
           OR (payload->>'ttnRevision') !~ '^[1-9][0-9]*$'))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'unsafe legacy truck status payload for workspace %, truck %', bad.workspace_id,bad.truck_id
      USING ERRCODE='check_violation';
  END IF;
END
$validate_status_revisions$;

UPDATE line_truck_statuses
   SET cycle_revision=COALESCE((payload->>'cycleRevision')::bigint,1),
       ttn_revision=COALESCE((payload->>'ttnRevision')::bigint,1);
ALTER TABLE line_truck_statuses
  ALTER COLUMN cycle_revision SET DEFAULT 1,
  ALTER COLUMN cycle_revision SET NOT NULL,
  ALTER COLUMN ttn_revision SET DEFAULT 1,
  ALTER COLUMN ttn_revision SET NOT NULL,
  ADD CONSTRAINT line_truck_statuses_cycle_revision_check CHECK (cycle_revision > 0),
  ADD CONSTRAINT line_truck_statuses_ttn_revision_check CHECK (ttn_revision > 0),
  ADD CONSTRAINT line_truck_statuses_truck_fk FOREIGN KEY (workspace_id,truck_id)
    REFERENCES line_trucks(workspace_id,truck_id);
CREATE INDEX line_truck_statuses_shift_idx
  ON line_truck_statuses(workspace_id,shift_id,truck_id);

COMMIT;
