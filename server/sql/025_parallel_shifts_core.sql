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
      OR (s.payload->>'workShift') NOT IN ('day','night')
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

UPDATE shifts s
   SET state = CASE WHEN s.payload->>'closing'='true' THEN 'closing'
                    WHEN s.is_active THEN 'active' ELSE 'closed' END,
       object_id = s.payload->>'objectId',
       object_name_snapshot = s.payload->>'objectName',
       work_date = to_date(s.payload->>'startDate','DD.MM.YYYY'),
       shift_type = s.payload->>'workShift',
       opened_at = to_timestamp((s.payload->>'startedAt')::double precision / 1000.0),
       opened_by_uid = s.payload->>'startedByUid',
       object_locked_at = CASE
         WHEN EXISTS (SELECT 1 FROM line_logs l
                       WHERE l.workspace_id=s.workspace_id AND l.shift_id=s.shift_id)
           OR EXISTS (SELECT 1 FROM line_truck_statuses t
                       WHERE t.workspace_id=s.workspace_id AND t.shift_id=s.shift_id
                         AND (t.payload ? 'arriveTimestamp'
                              OR t.payload ? 'lastLoadTimestamp'
                              OR NULLIF(t.payload->>'arriveStatus','') IS NOT NULL))
         THEN to_timestamp((s.payload->>'startedAt')::double precision / 1000.0)
         ELSE NULL
       END,
       closing_started_at = CASE WHEN s.payload->>'closing'='true'
         THEN COALESCE(
           CASE WHEN jsonb_typeof(s.payload->'closingStartedAt')='number'
             THEN to_timestamp((s.payload->>'closingStartedAt')::double precision / 1000.0) END,
           to_timestamp((s.payload->>'startedAt')::double precision / 1000.0))
         END,
       closing_by_uid = CASE WHEN s.payload->>'closing'='true'
         THEN COALESCE(NULLIF(s.payload->>'closingByUid',''),s.payload->>'startedByUid') END,
       closed_at = CASE WHEN NOT s.is_active AND s.payload->>'closing' IS DISTINCT FROM 'true'
         THEN COALESCE(
           CASE WHEN jsonb_typeof(s.payload->'closedAt')='number'
             THEN to_timestamp((s.payload->>'closedAt')::double precision / 1000.0) END,
           to_timestamp((s.payload->>'startedAt')::double precision / 1000.0))
         END,
       closed_by_uid = CASE WHEN NOT s.is_active AND s.payload->>'closing' IS DISTINCT FROM 'true'
         THEN COALESCE(NULLIF(s.payload->>'closedByUid',''),s.payload->>'startedByUid') END,
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
  ADD CONSTRAINT shifts_legacy_active_check CHECK (is_active = (state IN ('active','closing'))),
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
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.state := COALESCE(NEW.state,
      CASE WHEN NEW.payload->>'closing'='true' THEN 'closing'
           WHEN NEW.is_active THEN 'active' ELSE 'closed' END);
    NEW.object_id := COALESCE(NEW.object_id,NEW.payload->>'objectId');
    NEW.object_name_snapshot := COALESCE(NEW.object_name_snapshot,NEW.payload->>'objectName');
    NEW.work_date := COALESCE(NEW.work_date,to_date(NEW.payload->>'startDate','DD.MM.YYYY'));
    NEW.shift_type := COALESCE(NEW.shift_type,NEW.payload->>'workShift');
    NEW.opened_at := COALESCE(NEW.opened_at,
      to_timestamp((NEW.payload->>'startedAt')::double precision / 1000.0));
    NEW.opened_by_uid := COALESCE(NEW.opened_by_uid,NEW.payload->>'startedByUid');
    NEW.revision := COALESCE(NEW.revision,1);
    NEW.is_active := NEW.state IN ('active','closing');
  ELSE
    IF NEW.state IS NOT DISTINCT FROM OLD.state
       AND (NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.payload IS DISTINCT FROM OLD.payload) THEN
      NEW.state := CASE WHEN NEW.payload->>'closing'='true' THEN 'closing'
                        WHEN NEW.is_active THEN 'active' ELSE 'closed' END;
    ELSE
      NEW.is_active := NEW.state IN ('active','closing');
    END IF;
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
