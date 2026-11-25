-- Additive core schema for parallel shifts. Normalized columns become canonical;
-- legacy is_active remains as a consistency bridge during the v1/v2 cutover:
--   * one-time legacy classification (v1 -> source/unresolved, no inference) runs
--     in this transaction over the rows that already exist;
--   * afterwards the runtime trigger is a strict v2 normalizer only, so a legacy
--     writer cannot create new unresolved rows (protocol-upgrade-required).
BEGIN;

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
      SELECT t.workspace_id,t.shift_id,'load'::text,
             CASE
               WHEN jsonb_typeof(t.payload->'lastLoadTimestamp')='number' THEN t.payload->'lastLoadTimestamp'
               WHEN jsonb_typeof(t.payload->'lastLoadTimestamp')='null'
                    AND NULLIF(btrim(t.payload->>'lastResetOperationId'),'') IS NOT NULL THEN (
                 SELECT l.payload->'timestamp'
                   FROM line_logs l
                  WHERE l.workspace_id=t.workspace_id
                    AND l.shift_id=t.shift_id
                    AND l.truck_id=t.truck_id
                    AND l.log_id=t.payload->>'lastLoadLogId'
               )
             END
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

ALTER TABLE shifts
  ADD COLUMN state text,
  ADD COLUMN object_id text,
  ADD COLUMN object_name_snapshot text,
  ADD COLUMN work_date date,
  ADD COLUMN shift_type text,
  ADD COLUMN shift_type_resolution text,
  ADD COLUMN opened_at timestamptz,
  ADD COLUMN opened_by_uid text,
  ADD COLUMN opened_by_name_snapshot text,
  ADD COLUMN identity_resolution text,
  ADD COLUMN payload_schema_version smallint,
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
      OR (NULLIF(btrim(s.payload->>'objectName'),'') IS NULL
          -- D7: a restored archive row may carry an empty objectName snapshot;
          -- the backfill fills it deterministically from workspace_objects.
          AND NOT (s.payload ? 'restoredFrom' OR COALESCE(s.payload->>'restored','')='true'))
      OR jsonb_typeof(s.payload->'startedAt') IS DISTINCT FROM 'number'
      OR (s.payload->>'startedAt') !~ '^[0-9]+$'
      OR (s.payload ? 'workShift' AND s.payload->>'workShift' NOT IN ('day','night'))
      OR (s.payload ? 'type' AND s.payload->>'type' NOT IN ('day','night'))
      OR (s.payload ? 'workShift' AND s.payload ? 'type'
          AND s.payload->>'workShift' IS DISTINCT FROM s.payload->>'type')
      OR (s.payload->>'startDate') !~ '^([0-2][0-9]|3[01])\.(0[1-9]|1[0-2])\.[0-9]{4}$'
      -- D7: a restored archive row keeps startDate of the original shift while
      -- startedAt is the restoration moment, so the Moscow-date equality is not
      -- required for it (work_date still comes from startDate, format still checked).
      OR (NOT (s.payload ? 'restoredFrom' OR COALESCE(s.payload->>'restored','')='true')
          AND to_char(to_timestamp((s.payload->>'startedAt')::double precision / 1000.0)
                     AT TIME ZONE 'Europe/Moscow','DD.MM.YYYY') <> s.payload->>'startDate')
      OR (s.payload ? 'shiftId' AND s.payload->>'shiftId' IS DISTINCT FROM s.shift_id)
      -- D6: real writers (shift-close.mjs) keep a stale state/isActive alias while
      -- closing/closed. Markers decide the lifecycle; the alias is checked only
      -- when no marker exists. Both markers at once is a contradiction.
      OR (s.payload->>'closing'='true' AND jsonb_typeof(s.payload->'closedAt')='number')
      OR (s.payload ? 'closing' AND jsonb_typeof(s.payload->'closing') IS DISTINCT FROM 'boolean')
      OR (s.payload->>'closing'='true' AND jsonb_typeof(s.payload->'closingStartedAt') IS DISTINCT FROM 'number')
      OR (NOT (s.payload ? 'closing') AND NOT (s.payload ? 'closedAt') AND s.payload ? 'state'
          AND s.payload->>'state' IS DISTINCT FROM CASE WHEN s.is_active THEN 'active' ELSE 'historical' END)
      OR (jsonb_typeof(s.payload->'closedAt')='number' AND NOT (s.payload->>'closing' IS NOT DISTINCT FROM 'true')
          AND s.is_active)
      OR (s.payload ? 'date' AND s.payload->>'date' IS DISTINCT FROM
            to_char(to_date(s.payload->>'startDate','DD.MM.YYYY'),'YYYY-MM-DD'))
      OR (s.payload ? 'type' AND s.payload ? 'workShift'
          AND s.payload->>'type' IS DISTINCT FROM s.payload->>'workShift')
      -- An unknown schema version is neither v2 nor a trustworthy legacy v1 row.
      OR (s.payload ? 'payloadSchemaVersion'
          AND (jsonb_typeof(s.payload->'payloadSchemaVersion') IS DISTINCT FROM 'number'
               OR s.payload->>'payloadSchemaVersion' NOT IN ('1','2')))
      -- Strict v2 rows must carry the full published document and no restore-only
      -- alias; a malformed v2 blocks the migration instead of being silently
      -- downgraded to legacy v1 (design §4.8.1). Only the JSON number 2 is v2.
      OR (jsonb_typeof(s.payload->'payloadSchemaVersion')='number'
          AND s.payload->>'payloadSchemaVersion'='2' AND (
            NOT (s.payload ?& ARRAY['payloadSchemaVersion','id','shiftId','objectId',
                                    'objectName','startDate','date','workShift','type',
                                    'state','isActive','startedAt','startedBy','startedByUid'])
            OR EXISTS (SELECT 1 FROM jsonb_object_keys(s.payload) AS k
                        WHERE k LIKE 'restored%' OR k='originalSourceShiftId')
            OR NULLIF(btrim(s.payload->>'startedByUid'),'') IS NULL
            OR NOT EXISTS (
                 SELECT 1 FROM app_users u WHERE u.uid=s.payload->>'startedByUid'
               )
            OR NULLIF(btrim(s.payload->>'startedBy'),'') IS NULL
            OR COALESCE(NULLIF(s.payload->>'workShift',''),NULLIF(s.payload->>'type','')) IS NULL))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'unsafe legacy shift payload for workspace %, shift %', bad.workspace_id, bad.shift_id
      USING ERRCODE='check_violation';
  END IF;
END
$validate_legacy_shifts$;

UPDATE shifts s
   SET state = CASE WHEN s.payload->>'closing'='true' THEN 'closing'
                    WHEN s.is_active THEN 'active'
                    WHEN jsonb_typeof(s.payload->'closedAt')='number'
                         AND NULLIF(btrim(s.payload->>'closedByUid'),'') IS NOT NULL THEN 'closed'
                    ELSE 'historical' END,
       -- D7: a restored archive row is never a live line regardless of its
       -- payload aliases; the original stays archived, the copy is a snapshot.
       is_active = CASE WHEN NOT (s.payload ? 'restoredFrom' OR COALESCE(s.payload->>'restored','')='true')
                         AND (s.payload->>'closing'='true' OR s.is_active)
                        THEN true ELSE false END,
       object_id = s.payload->>'objectId',
       object_name_snapshot = CASE
         WHEN NULLIF(btrim(s.payload->>'objectName'),'') IS NOT NULL
           THEN s.payload->>'objectName'
         WHEN s.payload ? 'restoredFrom' OR COALESCE(s.payload->>'restored','')='true' THEN (
           SELECT COALESCE(NULLIF(btrim(o.payload->>'name'),''),'')
             FROM workspace_objects o
            WHERE o.workspace_id=s.workspace_id AND o.object_id=s.payload->>'objectId')
         ELSE s.payload->>'objectName' END,
       work_date = to_date(s.payload->>'startDate','DD.MM.YYYY'),
       payload_schema_version = CASE WHEN s.payload->>'payloadSchemaVersion'='2' THEN 2::smallint ELSE 1::smallint END,
       identity_resolution = CASE
         WHEN s.payload->>'payloadSchemaVersion'='2' THEN 'source'
         WHEN NULLIF(btrim(s.payload->>'startedByUid'),'') IS NOT NULL
              AND EXISTS (SELECT 1 FROM app_users u WHERE u.uid=s.payload->>'startedByUid')
           THEN 'source'
         ELSE 'unresolved' END,
       opened_by_uid = CASE
         WHEN s.payload->>'payloadSchemaVersion'='2' THEN s.payload->>'startedByUid'
         WHEN NULLIF(btrim(s.payload->>'startedByUid'),'') IS NOT NULL
              AND EXISTS (SELECT 1 FROM app_users u WHERE u.uid=s.payload->>'startedByUid')
           THEN s.payload->>'startedByUid'
         ELSE NULL END,
       opened_by_name_snapshot = COALESCE(NULLIF(btrim(s.payload->>'startedBy'),''),'<unresolved>'),
       shift_type_resolution = CASE
         WHEN s.payload->>'payloadSchemaVersion'='2' THEN 'source'
         WHEN COALESCE(NULLIF(s.payload->>'workShift',''),NULLIF(s.payload->>'type','')) IN ('day','night')
           THEN 'source'
         ELSE 'unresolved' END,
       -- No hour inference: an unproven day/night becomes NULL/unresolved.
       shift_type = CASE
         WHEN s.payload->>'payloadSchemaVersion'='2'
           THEN COALESCE(NULLIF(s.payload->>'workShift',''),NULLIF(s.payload->>'type',''))
         WHEN COALESCE(NULLIF(s.payload->>'workShift',''),NULLIF(s.payload->>'type','')) IN ('day','night')
           THEN COALESCE(NULLIF(s.payload->>'workShift',''),NULLIF(s.payload->>'type',''))
         ELSE NULL END,
       opened_at = to_timestamp((s.payload->>'startedAt')::double precision / 1000.0),
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
             SELECT CASE
                      WHEN jsonb_typeof(t.payload->'lastLoadTimestamp')='number'
                        THEN (t.payload->>'lastLoadTimestamp')::numeric
                      WHEN jsonb_typeof(t.payload->'lastLoadTimestamp')='null'
                           AND NULLIF(btrim(t.payload->>'lastResetOperationId'),'') IS NOT NULL THEN (
                        SELECT (l.payload->>'timestamp')::numeric
                          FROM line_logs l
                         WHERE l.workspace_id=t.workspace_id
                           AND l.shift_id=t.shift_id
                           AND l.truck_id=t.truck_id
                           AND l.log_id=t.payload->>'lastLoadLogId'
                      )
                    END
               FROM line_truck_statuses t
              WHERE t.workspace_id=s.workspace_id AND t.shift_id=s.shift_id
                AND NULLIF(btrim(t.payload->>'lastLoadLogId'),'') IS NOT NULL
                AND (t.payload->'lastLoadTimestamp' IS NOT NULL
                     OR NULLIF(btrim(t.payload->>'lastResetOperationId'),'') IS NOT NULL)
           ) confirmed_events
          WHERE event_ms > 0
       ),
       closing_started_at = CASE
         WHEN s.payload->>'closing'='true' AND jsonb_typeof(s.payload->'closingStartedAt')='number'
         THEN to_timestamp((s.payload->>'closingStartedAt')::double precision / 1000.0)
       END,
       closing_by_uid = CASE WHEN s.payload->>'closing'='true'
              AND EXISTS (SELECT 1 FROM app_users u
                           WHERE u.uid=btrim(s.payload->>'closingByUid'))
         THEN NULLIF(btrim(s.payload->>'closingByUid'),'') END,
       -- A legacy 'closed' row needs both close-flavoured fields AND a closer UID
       -- that really exists in app_users. An unproved closer stays NULL; the row
       -- is historicalized below, never a normal close and never an FK abort.
       closed_at = CASE
         WHEN NOT s.is_active AND s.payload->>'closing' IS DISTINCT FROM 'true'
              AND jsonb_typeof(s.payload->'closedAt')='number'
              AND NULLIF(btrim(s.payload->>'closedByUid'),'') IS NOT NULL
              AND EXISTS (SELECT 1 FROM app_users u
                           WHERE u.uid=btrim(s.payload->>'closedByUid'))
         THEN to_timestamp((s.payload->>'closedAt')::double precision / 1000.0)
       END,
       closed_by_uid = CASE
         WHEN NOT s.is_active AND s.payload->>'closing' IS DISTINCT FROM 'true'
              AND jsonb_typeof(s.payload->'closedAt')='number'
              AND NULLIF(btrim(s.payload->>'closedByUid'),'') IS NOT NULL
              AND EXISTS (SELECT 1 FROM app_users u
                           WHERE u.uid=btrim(s.payload->>'closedByUid'))
         THEN NULLIF(btrim(s.payload->>'closedByUid'),'')
       END,
       revision = 1;

-- D2: a legacy row classified as 'closed' whose closer UID cannot be proved is
-- not a close. Adding shifts_closed_by_fk below would otherwise abort this whole
-- migration with a bare 23503 instead of classifying the row, so it is
-- historicalized here in the same one-time block (like the D5 rows below) with
-- every close/closing field cleared. No UID and no time is invented.
UPDATE shifts
   SET state = 'historical',
       is_active = false,
       closing_started_at = NULL,
       closing_by_uid = NULL,
       closed_at = NULL,
       closed_by_uid = NULL
 WHERE state = 'closed'
   AND (closed_at IS NULL OR closed_by_uid IS NULL);

-- D7: a restored archive copy is a snapshot of the original, never a live line
-- and never a lifecycle of its own. Whatever its payload aliases say, the row
-- is historical and occupies no line (the unique one-open index ignores it).
UPDATE shifts
   SET state = 'historical',
       is_active = false,
       closing_started_at = NULL,
       closing_by_uid = NULL,
       closed_at = NULL,
       closed_by_uid = NULL
 WHERE payload ? 'restoredFrom' OR COALESCE(payload->>'restored','')='true';

-- D5: an unproven day/night may never back a live line. A row that would
-- otherwise stay active/closing is historicalized instead of guessed, so the
-- migration is not blocked by data that is legitimately unprovable.
UPDATE shifts
   SET state = 'historical',
       is_active = false,
       closing_started_at = NULL,
       closing_by_uid = NULL,
       closed_at = NULL,
       closed_by_uid = NULL
 WHERE shift_type_resolution = 'unresolved'
   AND state IN ('active','closing');

ALTER TABLE shifts
  ALTER COLUMN state SET NOT NULL,
  ALTER COLUMN object_id SET NOT NULL,
  ALTER COLUMN object_name_snapshot SET NOT NULL,
  ALTER COLUMN work_date SET NOT NULL,
  ALTER COLUMN opened_at SET NOT NULL,
  ALTER COLUMN opened_by_name_snapshot SET NOT NULL,
  ALTER COLUMN payload_schema_version SET NOT NULL,
  ALTER COLUMN identity_resolution SET NOT NULL,
  ALTER COLUMN shift_type_resolution SET NOT NULL,
  ALTER COLUMN revision SET NOT NULL,
  ADD CONSTRAINT shifts_state_check CHECK (state IN ('active','closing','closed','historical')),
  ADD CONSTRAINT shifts_shift_type_check CHECK (shift_type IS NULL OR shift_type IN ('day','night')),
  ADD CONSTRAINT shifts_payload_schema_version_check CHECK (payload_schema_version IN (1,2)),
  ADD CONSTRAINT shifts_identity_resolution_check
    CHECK (identity_resolution IN ('source','manual','unresolved')),
  ADD CONSTRAINT shifts_shift_type_resolution_check
    CHECK (shift_type_resolution IN ('source','manual','unresolved')),
  -- SQL three-valued NULL: NULL IN (...) is NULL, so equivalence checks are
  -- written explicitly. A NULL identity/type must pair with 'unresolved'.
  ADD CONSTRAINT shifts_identity_provenance_check
    CHECK ((opened_by_uid IS NOT NULL) = (identity_resolution IN ('source','manual'))),
  ADD CONSTRAINT shifts_type_provenance_check
    CHECK ((shift_type IS NOT NULL) = (shift_type_resolution IN ('source','manual'))),
  ADD CONSTRAINT shifts_v2_provenance_check
    CHECK (payload_schema_version = 1 OR (payload_schema_version = 2
           AND identity_resolution = 'source' AND shift_type_resolution = 'source'
           AND opened_by_uid IS NOT NULL AND shift_type IS NOT NULL)),
  ADD CONSTRAINT shifts_revision_check CHECK (revision > 0),
  -- is_active means "occupies a line": active or closing.
  ADD CONSTRAINT shifts_legacy_active_check CHECK (is_active = (state IN ('active','closing'))),
  -- An unresolved type may never back a live tab; only closed/historical rows
  -- may stay unproven.
  ADD CONSTRAINT shifts_unresolved_type_not_live_check
    CHECK (shift_type_resolution <> 'unresolved' OR state IN ('closed','historical')),
  ADD CONSTRAINT shifts_closed_lifecycle_check
    CHECK ((state = 'closed') = (closed_at IS NOT NULL AND closed_by_uid IS NOT NULL)),
  ADD CONSTRAINT shifts_historical_lifecycle_check
    CHECK (state <> 'historical' OR (closed_at IS NULL AND closed_by_uid IS NULL
           AND closing_started_at IS NULL AND closing_by_uid IS NULL
           AND is_active = false)),
  ADD CONSTRAINT shifts_object_fk FOREIGN KEY (workspace_id,object_id)
    REFERENCES workspace_objects(workspace_id,object_id),
  ADD CONSTRAINT shifts_opened_by_fk FOREIGN KEY (opened_by_uid) REFERENCES app_users(uid),
  ADD CONSTRAINT shifts_closing_by_fk FOREIGN KEY (closing_by_uid) REFERENCES app_users(uid),
  ADD CONSTRAINT shifts_closed_by_fk FOREIGN KEY (closed_by_uid) REFERENCES app_users(uid);

CREATE UNIQUE INDEX shifts_one_open_canonical_key
  ON shifts(workspace_id,object_id,work_date,shift_type)
  WHERE state IN ('active','closing') AND shift_type_resolution IN ('source','manual');
CREATE INDEX shifts_state_opened_idx ON shifts(workspace_id,state,opened_at);
CREATE INDEX shifts_object_date_idx ON shifts(workspace_id,object_id,work_date);

CREATE OR REPLACE FUNCTION shifts_legacy_bridge() RETURNS trigger
LANGUAGE plpgsql AS $bridge$
DECLARE
  payload_write boolean;
  payload_version text;
  payload_state text;
  payload_date date;
  document_bound boolean;
BEGIN
  -- The historical name is kept because the P2 runtime role boundary allowlists
  -- shifts_legacy_bridge() explicitly. The body is a strict v2 normalizer: the
  -- one-time v1 classification above is the only legacy write in the system.
  IF TG_OP='UPDATE' THEN
    IF NEW.payload IS NOT DISTINCT FROM OLD.payload
       AND NEW.state IS NOT DISTINCT FROM OLD.state
       AND NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'ambiguous legacy active update' USING ERRCODE='check_violation';
    END IF;
    payload_write := NEW.payload IS DISTINCT FROM OLD.payload;
    -- §4.1: a legacy/manual row is never promoted to strict v2 and never masked
    -- as "always complete". The version column may only follow a v2 document.
    IF NOT payload_write
       AND NEW.payload_schema_version IS DISTINCT FROM OLD.payload_schema_version THEN
      RAISE EXCEPTION 'invalid-shift-v2-provenance: payload_schema_version cannot change without a v2 payload'
        USING ERRCODE='check_violation';
    END IF;
    -- §4.1: a legacy/manual row is never promoted to strict v2 by a v2 document,
    -- and never masked as "always complete". A v1 write to such a row keeps its
    -- protocol-upgrade-required answer below; a manual column edit with an
    -- unchanged payload (§4.9) does not touch this rule.
    IF payload_write
       AND OLD.payload_schema_version IS DISTINCT FROM 2
       AND jsonb_typeof(NEW.payload->'payloadSchemaVersion')='number'
       AND NEW.payload->>'payloadSchemaVersion'='2' THEN
      RAISE EXCEPTION 'invalid-shift-v2-provenance: a legacy row is never promoted to strict v2'
        USING ERRCODE='check_violation';
    END IF;
  ELSE
    payload_write := true;
  END IF;

  -- A row is bound to its document when this write carries a strict v2 payload or
  -- when the stored row is already strict v2. Only such rows get payload-derived
  -- canonical columns; legacy v1 rows stay writable for manual resolution (§4.9)
  -- but can never become a live line or a v2 row without a v2 document.
  document_bound := payload_write OR NEW.payload_schema_version = 2;

  IF document_bound THEN
    payload_version := NEW.payload->>'payloadSchemaVersion';
    IF jsonb_typeof(NEW.payload->'payloadSchemaVersion') IS DISTINCT FROM 'number'
       OR payload_version IS DISTINCT FROM '2' THEN
      RAISE EXCEPTION 'protocol-upgrade-required: shift payload schema version % is not writable',
        COALESCE(payload_version,'missing') USING ERRCODE='check_violation';
    END IF;

    -- "Published v2" is exact: the documented key set and nothing extra, so a
    -- forgotten key, a restore-only alias or a forged field is malformed v2 and
    -- is never silently downgraded to legacy.
    IF TG_OP='INSERT' AND (
         NOT (NEW.payload ?& ARRAY['payloadSchemaVersion','id','shiftId','objectId',
                                   'objectName','startDate','date','workShift','type',
                                   'state','isActive','startedAt','startedBy','startedByUid'])
         OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload)) <> 14) THEN
      RAISE EXCEPTION 'invalid-shift-v2-provenance: start payload is not the exact published v2 document'
        USING ERRCODE='check_violation';
    END IF;
    -- UPDATE documents (prepare/close/archive snapshots) legitimately add
    -- lifecycle keys, but the published v2 keys stay mandatory and restore-only
    -- aliases are never part of a normal v2 payload (§4.7).
    IF TG_OP='UPDATE' AND (
         NOT (NEW.payload ?& ARRAY['payloadSchemaVersion','id','shiftId','objectId',
                                   'objectName','startDate','date','workShift','type',
                                   'state','isActive','startedAt','startedBy','startedByUid'])
         OR EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.payload) AS k
                     WHERE k LIKE 'restored%' OR k='originalSourceShiftId')) THEN
      RAISE EXCEPTION 'invalid-shift-v2-provenance: update payload is not a published v2 document'
        USING ERRCODE='check_violation';
    END IF;

    IF NEW.payload->>'id' IS DISTINCT FROM NEW.shift_id
       OR (NEW.payload ? 'shiftId' AND NEW.payload->>'shiftId' IS DISTINCT FROM NEW.shift_id)
       OR NULLIF(btrim(NEW.payload->>'objectId'),'') IS NULL
       OR NULLIF(btrim(NEW.payload->>'objectName'),'') IS NULL
       OR jsonb_typeof(NEW.payload->'startedAt') IS DISTINCT FROM 'number'
       OR (NEW.payload->>'startedAt') !~ '^[0-9]+$'
       OR jsonb_typeof(NEW.payload->'isActive') IS DISTINCT FROM 'boolean'
       OR NEW.payload->>'state' IS NULL
       OR NEW.payload->>'state' NOT IN ('active','closing','closed','historical')
       OR NULLIF(btrim(NEW.payload->>'startedByUid'),'') IS NULL
       OR NOT EXISTS (SELECT 1 FROM app_users u WHERE u.uid=NEW.payload->>'startedByUid')
       OR NULLIF(btrim(NEW.payload->>'startedBy'),'') IS NULL
       OR NEW.payload->>'workShift' IS NULL
       OR NEW.payload->>'workShift' NOT IN ('day','night')
       OR NEW.payload->>'type' IS DISTINCT FROM NEW.payload->>'workShift'
    THEN
      RAISE EXCEPTION 'invalid-shift-v2-provenance: identity, type or lifecycle alias is not provable'
        USING ERRCODE='check_violation';
    END IF;

    payload_date := CASE
      WHEN NEW.payload->>'startDate' ~ '^([0-2][0-9]|3[01])\.(0[1-9]|1[0-2])\.[0-9]{4}$'
        THEN to_date(NEW.payload->>'startDate','DD.MM.YYYY')
    END;
    IF payload_date IS NULL
       OR to_char(payload_date,'DD.MM.YYYY') IS DISTINCT FROM NEW.payload->>'startDate'
       OR NEW.payload->>'date' IS DISTINCT FROM to_char(payload_date,'YYYY-MM-DD')
       OR to_char(to_timestamp((NEW.payload->>'startedAt')::double precision / 1000.0)
                  AT TIME ZONE 'Europe/Moscow','DD.MM.YYYY') IS DISTINCT FROM NEW.payload->>'startDate'
    THEN
      RAISE EXCEPTION 'invalid-shift-v2-provenance: shift date is not provable'
        USING ERRCODE='check_violation';
    END IF;

    -- Lifecycle comes from evidence, never from a stale display alias (D2/D6):
    -- the markers decide, the state alias is only an assertion to be checked
    -- afterwards. Mirrors the preflight rules for legacy rows.
    IF NEW.payload ? 'closing'
       AND jsonb_typeof(NEW.payload->'closing') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'invalid-shift-v2-provenance: closing must be a JSON boolean'
        USING ERRCODE='check_violation';
    END IF;
    IF NEW.payload->>'closing'='true'
       AND jsonb_typeof(NEW.payload->'closedAt')='number' THEN
      RAISE EXCEPTION 'invalid-shift-v2-provenance: closing and closedAt cannot coexist'
        USING ERRCODE='check_violation';
    END IF;
    IF NEW.payload->>'closing'='true'
       AND jsonb_typeof(NEW.payload->'closingStartedAt') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'invalid-shift-v2-provenance: closing requires a numeric closingStartedAt'
        USING ERRCODE='check_violation';
    END IF;
    payload_state := CASE
      WHEN NEW.payload->>'closing'='true' THEN 'closing'
      WHEN jsonb_typeof(NEW.payload->'closedAt')='number'
           AND NULLIF(btrim(NEW.payload->>'closedByUid'),'') IS NOT NULL THEN 'closed'
      WHEN (NEW.payload->>'isActive')::boolean THEN 'active'
      ELSE 'historical' END;

    -- A terminal alias is an assertion and must be proved. A leftover 'active'
    -- alias is only the pre-transition snapshot the close writer keeps.
    IF NEW.payload->>'state'='closed' AND payload_state IS DISTINCT FROM 'closed' THEN
      RAISE EXCEPTION 'invalid-shift-v2-provenance: closed requires closed_at and proved closed_by_uid'
        USING ERRCODE='check_violation';
    END IF;
    IF NEW.payload->>'state'='closing' AND payload_state IS DISTINCT FROM 'closing' THEN
      RAISE EXCEPTION 'invalid-shift-v2-provenance: closing requires the closing marker'
        USING ERRCODE='check_violation';
    END IF;
    IF NEW.payload->>'state'='historical' AND payload_state IS DISTINCT FROM 'historical' THEN
      RAISE EXCEPTION 'invalid-shift-v2-provenance: historical row keeps no close proof'
        USING ERRCODE='check_violation';
    END IF;
    IF (payload_state='active' AND NOT (NEW.payload->>'isActive')::boolean)
       OR (payload_state IN ('closed','historical') AND (NEW.payload->>'isActive')::boolean)
    THEN
      RAISE EXCEPTION 'invalid-shift-v2-provenance: isActive contradicts the lifecycle'
        USING ERRCODE='check_violation';
    END IF;

    -- Canonical columns are derived from the document. An INSERT that also
    -- supplies contradictory columns is canonical drift: reject, never fix up.
    IF TG_OP='INSERT' AND (
         (NEW.state IS NOT NULL AND NEW.state IS DISTINCT FROM payload_state)
      OR (NEW.object_id IS NOT NULL AND NEW.object_id IS DISTINCT FROM NEW.payload->>'objectId')
      OR (NEW.object_name_snapshot IS NOT NULL
          AND NEW.object_name_snapshot IS DISTINCT FROM NEW.payload->>'objectName')
      OR (NEW.work_date IS NOT NULL AND NEW.work_date IS DISTINCT FROM payload_date)
      OR (NEW.shift_type IS NOT NULL AND NEW.shift_type IS DISTINCT FROM NEW.payload->>'workShift')
      OR (NEW.opened_at IS NOT NULL AND NEW.opened_at IS DISTINCT FROM
            to_timestamp((NEW.payload->>'startedAt')::double precision / 1000.0))
      OR (NEW.opened_by_uid IS NOT NULL AND NEW.opened_by_uid IS DISTINCT FROM NEW.payload->>'startedByUid')
      OR (NEW.payload_schema_version IS NOT NULL AND NEW.payload_schema_version <> 2)
      OR (NEW.identity_resolution IS NOT NULL AND NEW.identity_resolution <> 'source')
      OR (NEW.shift_type_resolution IS NOT NULL AND NEW.shift_type_resolution <> 'source')
      OR (NEW.is_active IS NOT NULL
          AND NEW.is_active IS DISTINCT FROM (payload_state IN ('active','closing')))
    ) THEN
      RAISE EXCEPTION 'shift canonical payload mismatch' USING ERRCODE='check_violation';
    END IF;

    -- On UPDATE the untouched columns still equal OLD, so only a value the writer
    -- actually changed can be an assertion. Such an assertion must equal what the
    -- document proves; otherwise it is drift and is rejected, never fixed up.
    IF TG_OP='UPDATE' AND (
         (NEW.state IS DISTINCT FROM OLD.state
          AND NEW.state IS DISTINCT FROM payload_state)
      OR (NEW.object_id IS DISTINCT FROM OLD.object_id
          AND NEW.object_id IS DISTINCT FROM NEW.payload->>'objectId')
      OR (NEW.object_name_snapshot IS DISTINCT FROM OLD.object_name_snapshot
          AND NEW.object_name_snapshot IS DISTINCT FROM NEW.payload->>'objectName')
      OR (NEW.work_date IS DISTINCT FROM OLD.work_date
          AND NEW.work_date IS DISTINCT FROM payload_date)
      OR (NEW.shift_type IS DISTINCT FROM OLD.shift_type
          AND NEW.shift_type IS DISTINCT FROM NEW.payload->>'workShift')
      OR (NEW.opened_at IS DISTINCT FROM OLD.opened_at
          AND NEW.opened_at IS DISTINCT FROM
            to_timestamp((NEW.payload->>'startedAt')::double precision / 1000.0))
      OR (NEW.opened_by_uid IS DISTINCT FROM OLD.opened_by_uid
          AND NEW.opened_by_uid IS DISTINCT FROM NEW.payload->>'startedByUid')
      OR (NEW.payload_schema_version IS DISTINCT FROM OLD.payload_schema_version
          AND NEW.payload_schema_version <> 2)
      OR (NEW.identity_resolution IS DISTINCT FROM OLD.identity_resolution
          AND NEW.identity_resolution <> 'source')
      OR (NEW.shift_type_resolution IS DISTINCT FROM OLD.shift_type_resolution
          AND NEW.shift_type_resolution <> 'source')
      OR (NEW.is_active IS DISTINCT FROM OLD.is_active
          AND NEW.is_active IS DISTINCT FROM (payload_state IN ('active','closing')))
      -- Close/closing fields are provenance too: a bare write must equal what the
      -- document proves, and a key the document does not carry is drift.
      OR (NEW.closing_started_at IS DISTINCT FROM OLD.closing_started_at
          AND NEW.closing_started_at IS DISTINCT FROM (CASE WHEN payload_state='closing'
            AND jsonb_typeof(NEW.payload->'closingStartedAt')='number'
            THEN to_timestamp((NEW.payload->>'closingStartedAt')::double precision / 1000.0) END))
      OR (NEW.closing_by_uid IS DISTINCT FROM OLD.closing_by_uid
          AND NEW.closing_by_uid IS DISTINCT FROM (CASE WHEN payload_state='closing'
            THEN NULLIF(NEW.payload->>'closingByUid','') END))
      OR (NEW.closed_at IS DISTINCT FROM OLD.closed_at
          AND NEW.closed_at IS DISTINCT FROM (CASE WHEN payload_state='closed'
            THEN to_timestamp((NEW.payload->>'closedAt')::double precision / 1000.0) END))
      OR (NEW.closed_by_uid IS DISTINCT FROM OLD.closed_by_uid
          AND NEW.closed_by_uid IS DISTINCT FROM (CASE WHEN payload_state='closed'
            THEN NEW.payload->>'closedByUid' END))
    ) THEN
      RAISE EXCEPTION 'shift canonical payload mismatch' USING ERRCODE='check_violation';
    END IF;

    IF payload_write THEN
      NEW.state := payload_state;
      NEW.object_id := NEW.payload->>'objectId';
      NEW.object_name_snapshot := NEW.payload->>'objectName';
      NEW.work_date := payload_date;
      NEW.shift_type := NEW.payload->>'workShift';
      NEW.shift_type_resolution := 'source';
      NEW.opened_at := to_timestamp((NEW.payload->>'startedAt')::double precision / 1000.0);
      NEW.opened_by_uid := NEW.payload->>'startedByUid';
      NEW.opened_by_name_snapshot := NEW.payload->>'startedBy';
      NEW.identity_resolution := 'source';
      NEW.payload_schema_version := 2;
      NEW.closing_started_at := CASE WHEN payload_state='closing'
        AND jsonb_typeof(NEW.payload->'closingStartedAt')='number'
        THEN to_timestamp((NEW.payload->>'closingStartedAt')::double precision / 1000.0) END;
      NEW.closing_by_uid := CASE WHEN payload_state='closing'
        THEN NULLIF(NEW.payload->>'closingByUid','') END;
      NEW.closed_at := CASE WHEN payload_state='closed'
        THEN to_timestamp((NEW.payload->>'closedAt')::double precision / 1000.0) END;
      NEW.closed_by_uid := CASE WHEN payload_state='closed'
        THEN NEW.payload->>'closedByUid' END;
      NEW.revision := COALESCE(NEW.revision,1);
    END IF;
  END IF;

  -- Design §4.1 / D1: is_active means "occupies a line" (active or closing).
  IF NEW.state IN ('active','closing') THEN NEW.is_active := true;
  ELSE NEW.is_active := false; END IF;

  -- A migrated legacy row may be closed, historical or manually resolved, and its
  -- non-provenance columns stay writable (object lock, revisions). It can never
  -- become (or return to) a live line without a strict v2 document.
  IF NEW.state IN ('active','closing') AND NEW.payload_schema_version IS DISTINCT FROM 2 THEN
    IF TG_OP='INSERT' THEN
      RAISE EXCEPTION 'protocol-upgrade-required: a legacy shift cannot become a live line'
        USING ERRCODE='check_violation';
    ELSIF OLD.state IS DISTINCT FROM NEW.state THEN
      RAISE EXCEPTION 'protocol-upgrade-required: a legacy shift cannot become a live line'
        USING ERRCODE='check_violation';
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND OLD.object_locked_at IS NOT NULL
     AND NEW.object_id IS DISTINCT FROM OLD.object_id THEN
    RAISE EXCEPTION 'shift object is locked' USING ERRCODE='check_violation';
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

-- Historicalization (Task 4, D8-D10). 025 only classifies legacy rows; the
-- destructive cutover is gated by an exact-report confirmation. This block is
-- DDL only: no existing data is rewritten here.
ALTER TABLE shifts
  ADD COLUMN historicalized_at timestamptz,
  ADD COLUMN historicalized_by_uid text REFERENCES app_users(uid) ON DELETE RESTRICT,
  ADD COLUMN historicalization_reason text,
  ADD COLUMN historicalization_report_hash text,
  ADD CONSTRAINT shifts_historicalization_marker_check CHECK (
    (historicalized_at IS NULL) = (historicalized_by_uid IS NULL)
    AND (historicalized_at IS NULL) = (historicalization_reason IS NULL)
    AND (historicalized_at IS NULL) = (historicalization_report_hash IS NULL)
    AND (historicalization_reason IS NULL OR state = 'historical')
    AND (historicalization_reason IS NULL OR historicalization_reason = 'legacy-type-unresolved-at-cutover')
    AND (historicalization_report_hash IS NULL OR historicalization_report_hash ~ '^[0-9a-f]{64}$')
  );

CREATE TABLE legacy_historicalization_confirmations (
  confirmation_id text PRIMARY KEY CHECK (confirmation_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  report_schema text NOT NULL CHECK (report_schema = 'samosval.legacy-historicalization/v1'),
  report_sha256 text NOT NULL CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  report_bytes bytea NOT NULL,
  row_count integer NOT NULL CHECK (row_count >= 0),
  owner_actor_uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  backup_manifest_sha256 text NOT NULL CHECK (backup_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  database_fingerprint text NOT NULL CHECK (length(database_fingerprint) BETWEEN 1 AND 256),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','consumed')),
  consumed_at timestamptz,
  consumed_by_uid text REFERENCES app_users(uid) ON DELETE RESTRICT,
  CHECK (expires_at > confirmed_at),
  -- The stored bytes are the only source of truth: the hash must match them in the DB.
  CHECK (report_sha256 = encode(sha256(report_bytes), 'hex')),
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL AND consumed_by_uid IS NOT NULL))
);

CREATE TABLE legacy_line_status_snapshots (
  snapshot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL,
  confirmation_id text NOT NULL REFERENCES legacy_historicalization_confirmations(confirmation_id),
  shift_id text NOT NULL,
  truck_id text NOT NULL,
  payload jsonb NOT NULL,
  -- The exact RFC 8785 bytes the hash was computed from. PostgreSQL cannot rebuild
  -- JCS from jsonb, so the canonical text is stored and the hash is bound to it here:
  -- this is a real DB-side check, not a JS-only promise.
  payload_canonical text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status_revision bigint NOT NULL CHECK (status_revision > 0),
  cycle_revision bigint NOT NULL CHECK (cycle_revision > 0),
  ttn_revision bigint NOT NULL CHECK (ttn_revision > 0),
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (confirmation_id, shift_id, truck_id),
  CHECK (payload_canonical::jsonb = payload),
  CHECK (payload_sha256 = encode(sha256(convert_to(payload_canonical, 'UTF8')), 'hex')),
  FOREIGN KEY (workspace_id, shift_id) REFERENCES shifts(workspace_id, shift_id)
);
CREATE INDEX legacy_line_status_snapshots_shift_idx
  ON legacy_line_status_snapshots(workspace_id, shift_id, truck_id);

CREATE TABLE legacy_cutover_historicalization_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  confirmation_id text NOT NULL REFERENCES legacy_historicalization_confirmations(confirmation_id),
  report_schema text NOT NULL CHECK (report_schema = 'samosval.legacy-historicalization/v1'),
  report_sha256 text NOT NULL CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  shift_id text NOT NULL,
  source_payload_sha256 text NOT NULL CHECK (source_payload_sha256 ~ '^[0-9a-f]{64}$'),
  children_sha256 text NOT NULL CHECK (children_sha256 ~ '^[0-9a-f]{64}$'),
  -- Known limitation from review 4 (Minor 3): a restored archive row is never proof
  -- of the original opener. The flag is recorded so the limitation is auditable
  -- without rehashing the report.
  restored_snapshot boolean NOT NULL,
  old_state text NOT NULL CHECK (old_state IN ('historical')),
  new_state text NOT NULL CHECK (new_state IN ('historical')),
  reason text NOT NULL CHECK (reason = 'legacy-type-unresolved-at-cutover'),
  original_close_fields jsonb NOT NULL,
  maintenance_actor_uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  maintenance_at timestamptz NOT NULL DEFAULT now(),
  result_revision bigint NOT NULL CHECK (result_revision > 0),
  UNIQUE (confirmation_id, shift_id),
  FOREIGN KEY (workspace_id, shift_id) REFERENCES shifts(workspace_id, shift_id)
);

-- Append-only guard: snapshots and audit can be inserted, never changed or removed.
CREATE OR REPLACE FUNCTION legacy_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $append_only$
BEGIN
  RAISE EXCEPTION 'append-only historicalization record: % is forbidden on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$append_only$;
CREATE TRIGGER legacy_line_status_snapshots_append_only
  BEFORE UPDATE OR DELETE ON legacy_line_status_snapshots
  FOR EACH ROW EXECUTE FUNCTION legacy_append_only_guard();
CREATE TRIGGER legacy_cutover_audit_append_only
  BEFORE UPDATE OR DELETE ON legacy_cutover_historicalization_audit
  FOR EACH ROW EXECUTE FUNCTION legacy_append_only_guard();
-- TRUNCATE bypasses row triggers, so the immutable tables need statement-level guards.
CREATE TRIGGER legacy_line_status_snapshots_no_truncate
  BEFORE TRUNCATE ON legacy_line_status_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION legacy_append_only_guard();
CREATE TRIGGER legacy_cutover_audit_no_truncate
  BEFORE TRUNCATE ON legacy_cutover_historicalization_audit
  FOR EACH STATEMENT EXECUTE FUNCTION legacy_append_only_guard();

-- Manual legacy provenance resolution (Task 5, design §4.9). Additive only: new
-- objects appended here, no P3/P4 table, column, constraint, trigger, order or
-- row is touched. The command writes two provenance dimensions of an existing
-- row and never activates it.
--
-- Guard row: the exact canonical key (workspace + object + work date + requested
-- type) is unique. The two 64-bit advisory hashes taken by the writer only
-- serialize; a collision merely serializes unrelated commands, correctness comes
-- from this exact key.
CREATE TABLE shift_legacy_resolution_guard (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  guard_key text NOT NULL CHECK (length(guard_key) BETWEEN 1 AND 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, guard_key)
);

-- Receipt: one row per (workspace, operation id). It stores the exact result an
-- identical replay must return without a second audit.
CREATE TABLE shift_legacy_resolution_receipts (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  shift_id text NOT NULL,
  protocol_version smallint NOT NULL CHECK (protocol_version > 0),
  actor_uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, operation_id),
  FOREIGN KEY (workspace_id, shift_id) REFERENCES shifts(workspace_id, shift_id)
);

-- Immutable evidence of one manual resolution. `actor_uid` is RESTRICT so a hard
-- delete can never erase who resolved a provenance field; accounts are disabled
-- softly instead.
CREATE TABLE shift_legacy_resolution_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  shift_id text NOT NULL,
  old_opened_by_uid text REFERENCES app_users(uid) ON DELETE RESTRICT,
  new_opened_by_uid text REFERENCES app_users(uid) ON DELETE RESTRICT,
  old_identity_resolution text NOT NULL
    CHECK (old_identity_resolution IN ('source','manual','unresolved')),
  new_identity_resolution text NOT NULL
    CHECK (new_identity_resolution IN ('source','manual','unresolved')),
  old_shift_type text CHECK (old_shift_type IS NULL OR old_shift_type IN ('day','night')),
  new_shift_type text CHECK (new_shift_type IS NULL OR new_shift_type IN ('day','night')),
  old_shift_type_resolution text NOT NULL
    CHECK (old_shift_type_resolution IN ('source','manual','unresolved')),
  new_shift_type_resolution text NOT NULL
    CHECK (new_shift_type_resolution IN ('source','manual','unresolved')),
  evidence_note text NOT NULL
    CHECK (char_length(evidence_note) BETWEEN 1 AND 1000)
    -- D17 "и в JS, и в БД": the stored note is already trimmed and control-free,
    -- so a direct INSERT cannot smuggle either in behind the writer.
    CHECK (evidence_note = btrim(evidence_note) AND evidence_note !~ '[[:cntrl:]]'),
  actor_uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  result_revision bigint NOT NULL CHECK (result_revision > 0),
  command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (workspace_id, operation_id),
  FOREIGN KEY (workspace_id, shift_id) REFERENCES shifts(workspace_id, shift_id),
  -- One command is one revision step, and it must change at least one dimension.
  CHECK (result_revision = expected_revision + 1),
  CHECK (old_identity_resolution IS DISTINCT FROM new_identity_resolution
         OR old_shift_type_resolution IS DISTINCT FROM new_shift_type_resolution)
);
CREATE INDEX shift_legacy_resolution_audit_shift_idx
  ON shift_legacy_resolution_audit(workspace_id, shift_id, audit_id);

CREATE TRIGGER shift_legacy_resolution_audit_append_only
  BEFORE UPDATE OR DELETE ON shift_legacy_resolution_audit
  FOR EACH ROW EXECUTE FUNCTION legacy_append_only_guard();
CREATE TRIGGER shift_legacy_resolution_audit_no_truncate
  BEFORE TRUNCATE ON shift_legacy_resolution_audit
  FOR EACH STATEMENT EXECUTE FUNCTION legacy_append_only_guard();
-- A receipt that could be rewritten would silently break idempotency, so it is
-- as immutable as the audit it belongs to.
CREATE TRIGGER shift_legacy_resolution_receipts_append_only
  BEFORE UPDATE OR DELETE ON shift_legacy_resolution_receipts
  FOR EACH ROW EXECUTE FUNCTION legacy_append_only_guard();
CREATE TRIGGER shift_legacy_resolution_receipts_no_truncate
  BEFORE TRUNCATE ON shift_legacy_resolution_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION legacy_append_only_guard();

-- D12 at the row level (Task 5, §4.9). The writer already refuses a rewrite, but
-- an invariant this important must not depend on one caller: the schema itself
-- allows exactly one provenance transition, `unresolved -> manual`. Clearing a
-- proven value, rewriting a `source`/`manual` value, and downgrading `manual`
-- back to `unresolved` are all refused here, whatever writes the row.
--
-- The trigger is additive and fires after `shifts_legacy_bridge_trigger`
-- (alphabetical order), so it judges the final NEW row the v2 normalizer
-- produced; a v2 document write that keeps `source` is unaffected.
CREATE OR REPLACE FUNCTION shifts_manual_provenance_guard() RETURNS trigger
LANGUAGE plpgsql AS $manual_provenance$
BEGIN
  -- Identity dimension.
  IF NEW.identity_resolution IS DISTINCT FROM OLD.identity_resolution
     AND NOT (OLD.identity_resolution = 'unresolved' AND NEW.identity_resolution = 'manual') THEN
    RAISE EXCEPTION 'legacy-field-not-unresolved: identity provenance % cannot become %',
      OLD.identity_resolution, NEW.identity_resolution USING ERRCODE='check_violation';
  END IF;
  -- A value may not be swapped while its resolution stays put: that is a silent
  -- rewrite of proven provenance, not a resolution.
  IF OLD.identity_resolution IN ('source','manual')
     AND NEW.opened_by_uid IS DISTINCT FROM OLD.opened_by_uid THEN
    RAISE EXCEPTION 'legacy-field-not-unresolved: a % identity is never rewritten',
      OLD.identity_resolution USING ERRCODE='check_violation';
  END IF;

  -- Type dimension: same rules, independent of the identity dimension.
  IF NEW.shift_type_resolution IS DISTINCT FROM OLD.shift_type_resolution
     AND NOT (OLD.shift_type_resolution = 'unresolved' AND NEW.shift_type_resolution = 'manual') THEN
    RAISE EXCEPTION 'legacy-field-not-unresolved: type provenance % cannot become %',
      OLD.shift_type_resolution, NEW.shift_type_resolution USING ERRCODE='check_violation';
  END IF;
  IF OLD.shift_type_resolution IN ('source','manual')
     AND NEW.shift_type IS DISTINCT FROM OLD.shift_type THEN
    RAISE EXCEPTION 'legacy-field-not-unresolved: a % shift type is never rewritten',
      OLD.shift_type_resolution USING ERRCODE='check_violation';
  END IF;

  RETURN NEW;
END
$manual_provenance$;
CREATE TRIGGER shifts_manual_provenance_guard_trigger
  BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION shifts_manual_provenance_guard();

-- Immutable archive chain and dedicated restored contexts (Task 6, design §4.6).
-- Additive only: new tables, constraints, indexes, triggers and grants. No P3/P4/P5
-- table, column, constraint, trigger, order or row is touched. This block is schema
-- only: it migrates no restored data and creates no synthetic shift, line row or
-- current status. Restored contexts live beside `shifts`, never inside it.
--
-- A logical archive series is separated from its immutable content. The single
-- authoritative default pointer is `latest_finalized_*`; `current_location` is a
-- mutable catalog placement with its own CAS and never rewrites revision bytes.
CREATE TABLE shift_archive_series (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  archive_id text NOT NULL CHECK (length(archive_id) BETWEEN 1 AND 160),
  source_shift_id text NOT NULL CHECK (length(source_shift_id) BETWEEN 1 AND 160),
  current_location text NOT NULL DEFAULT 'archive'
    CHECK (current_location IN ('archive','trash')),
  latest_finalized_revision bigint CHECK (latest_finalized_revision > 0),
  latest_finalized_sha256 text CHECK (latest_finalized_sha256 ~ '^[0-9a-f]{64}$'),
  series_revision bigint NOT NULL DEFAULT 1 CHECK (series_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, archive_id),
  -- One canonical archive per business shift.
  UNIQUE (workspace_id, source_shift_id),
  UNIQUE (workspace_id, archive_id, source_shift_id),
  CHECK ((latest_finalized_revision IS NULL) = (latest_finalized_sha256 IS NULL))
);

CREATE TABLE shift_archive_revisions (
  workspace_id text NOT NULL,
  archive_id text NOT NULL,
  archive_revision bigint NOT NULL CHECK (archive_revision > 0),
  previous_revision bigint,
  previous_sha256 text CHECK (previous_sha256 ~ '^[0-9a-f]{64}$'),
  -- Authoritative UTF-8 JSON bytes. Parsed JSON/normalized columns may only ever be
  -- a projection; the hash is computed from these bytes, not from a re-serialization.
  payload_bytes bytea NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_schema_version smallint NOT NULL CHECK (payload_schema_version > 0),
  source_kind text NOT NULL CHECK (length(source_kind) BETWEEN 1 AND 64),
  source_locator text NOT NULL CHECK (length(source_locator) BETWEEN 1 AND 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  PRIMARY KEY (workspace_id, archive_id, archive_revision),
  UNIQUE (workspace_id, archive_id, payload_sha256),
  UNIQUE (workspace_id, archive_id, archive_revision, payload_sha256),
  -- The exact immutable source document of a legacy import is addressed once.
  UNIQUE (workspace_id, source_locator),
  FOREIGN KEY (workspace_id, archive_id)
    REFERENCES shift_archive_series(workspace_id, archive_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Revision 1 has no predecessor; every later revision names the exact previous
  -- revision number and its exact payload hash (the FK below proves the hash).
  CHECK ((archive_revision = 1) = (previous_revision IS NULL)),
  CHECK (previous_revision IS NULL OR previous_revision = archive_revision - 1),
  CHECK ((previous_revision IS NULL) = (previous_sha256 IS NULL)),
  FOREIGN KEY (workspace_id, archive_id, previous_revision, previous_sha256)
    REFERENCES shift_archive_revisions(workspace_id, archive_id, archive_revision, payload_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (payload_sha256 = encode(sha256(payload_bytes), 'hex'))
);

-- The default pointer must name an existing revision of the same archive and its
-- exact hash: a dangling or mismatched pointer is impossible at the DB level.
ALTER TABLE shift_archive_series
  ADD CONSTRAINT shift_archive_series_latest_revision_fk
  FOREIGN KEY (workspace_id, archive_id, latest_finalized_revision, latest_finalized_sha256)
  REFERENCES shift_archive_revisions(workspace_id, archive_id, archive_revision, payload_sha256)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

-- One row per (workspace, operation id): the exact result an identical replay
-- returns. Immutable, so idempotency can never be rewritten.
CREATE TABLE archive_operation_receipts (
  workspace_id text NOT NULL,
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  archive_id text NOT NULL,
  uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, operation_id),
  FOREIGN KEY (workspace_id, archive_id)
    REFERENCES shift_archive_series(workspace_id, archive_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Canonical restore never creates a legacy row in `shifts`. A dedicated context
-- carries the archive provenance and the exact original opener/type snapshot.
CREATE TABLE restored_shift_contexts (
  workspace_id text NOT NULL,
  restored_context_id text NOT NULL CHECK (restored_context_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  archive_id text NOT NULL,
  source_shift_id text NOT NULL,
  -- Display/edit mode of the restored context, not the active state of a shift.
  mode text NOT NULL CHECK (mode IN ('standalone','parallel')),
  -- Editing lifecycle of the context, not `active|closing|closed|historical`.
  context_state text NOT NULL CHECK (context_state IN ('open','finalized')),
  original_opened_by_uid text REFERENCES app_users(uid) ON DELETE RESTRICT,
  original_opened_by_name_snapshot text,
  original_identity_resolution text NOT NULL
    CHECK (original_identity_resolution IN ('source','manual','unresolved')),
  original_shift_type text
    CHECK (original_shift_type IS NULL OR original_shift_type IN ('day','night')),
  original_shift_type_resolution text NOT NULL
    CHECK (original_shift_type_resolution IN ('source','manual','unresolved')),
  restored_by_uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  restored_by_name_snapshot text NOT NULL,
  restored_at timestamptz NOT NULL,
  archive_revision bigint NOT NULL CHECK (archive_revision > 0),
  context_revision bigint NOT NULL CHECK (context_revision > 0),
  restore_operation_id text NOT NULL CHECK (restore_operation_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  source_state_snapshot jsonb NOT NULL,
  source_shift_revision bigint NOT NULL CHECK (source_shift_revision > 0),
  opened_at_snapshot timestamptz NOT NULL,
  object_id text NOT NULL CHECK (length(object_id) BETWEEN 1 AND 160),
  object_name text NOT NULL CHECK (length(object_name) BETWEEN 1 AND 512),
  work_date date NOT NULL,
  PRIMARY KEY (workspace_id, restored_context_id),
  -- Exact-FK target for `archive_revision_publications`: a publication can only
  -- name a context of the same archive, never one of another archive.
  UNIQUE (workspace_id, archive_id, restored_context_id),
  -- Source identity comes from the canonical series of that business shift; the
  -- context does not depend on a `shifts` row and cannot pick another archive.
  FOREIGN KEY (workspace_id, archive_id, source_shift_id)
    REFERENCES shift_archive_series(workspace_id, archive_id, source_shift_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, archive_id, archive_revision)
    REFERENCES shift_archive_revisions(workspace_id, archive_id, archive_revision)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
-- At most one open context per archive series (design §4.6 restore contract).
CREATE UNIQUE INDEX restored_shift_contexts_single_open_idx
  ON restored_shift_contexts(workspace_id, archive_id)
  WHERE context_state = 'open';

-- Append-only provenance of a published revision. Receipt links are deferred so a
-- finalize transaction may write the publication before its receipts, while a
-- dangling publication still fails at the constraint checkpoint / commit.
CREATE TABLE archive_revision_publications (
  workspace_id text NOT NULL,
  archive_id text NOT NULL,
  archive_revision bigint NOT NULL CHECK (archive_revision > 0),
  restored_context_id text NOT NULL,
  restore_operation_id text NOT NULL CHECK (restore_operation_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  finalize_operation_id text NOT NULL CHECK (finalize_operation_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  base_revision bigint NOT NULL CHECK (base_revision > 0),
  base_sha256 text NOT NULL CHECK (base_sha256 ~ '^[0-9a-f]{64}$'),
  command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  published_by_uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, archive_id, archive_revision),
  UNIQUE (workspace_id, restored_context_id),
  UNIQUE (workspace_id, finalize_operation_id),
  CHECK (archive_revision > base_revision),
  -- Exact FK on revision *and* context (design §4.6): the published revision and
  -- the restored context must both exist and belong to this same archive, so a
  -- dangling or cross-archive publication can never be committed. Without it an
  -- append-only row could name a ghost/foreign context forever: the row could not
  -- be deleted or updated, and the unique context would burn that id for good.
  FOREIGN KEY (workspace_id, archive_id, restored_context_id)
    REFERENCES restored_shift_contexts(workspace_id, archive_id, restored_context_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, archive_id, archive_revision)
    REFERENCES shift_archive_revisions(workspace_id, archive_id, archive_revision)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, archive_id, base_revision, base_sha256)
    REFERENCES shift_archive_revisions(workspace_id, archive_id, archive_revision, payload_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_archive_publication_restore_receipt
    FOREIGN KEY (workspace_id, restore_operation_id)
    REFERENCES archive_operation_receipts(workspace_id, operation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_archive_publication_finalize_receipt
    FOREIGN KEY (workspace_id, finalize_operation_id)
    REFERENCES archive_operation_receipts(workspace_id, operation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

-- Restored children use dedicated FKs on the exact context, never a polymorphic
-- nullable pair. `restored_context_logs` is the latest editable trip state.
CREATE TABLE restored_context_logs (
  workspace_id text NOT NULL,
  restored_context_id text NOT NULL,
  log_id text NOT NULL CHECK (length(log_id) BETWEEN 1 AND 160),
  truck_id text NOT NULL,
  payload jsonb NOT NULL,
  log_revision bigint NOT NULL CHECK (log_revision > 0),
  -- NULL only for a trip created inside the restored context; a migrated trip keeps
  -- the exact original log identity.
  source_log_id text CHECK (source_log_id IS NULL OR length(source_log_id) BETWEEN 1 AND 160),
  created_from_archive_revision bigint NOT NULL CHECK (created_from_archive_revision > 0),
  PRIMARY KEY (workspace_id, restored_context_id, log_id),
  FOREIGN KEY (workspace_id, restored_context_id)
    REFERENCES restored_shift_contexts(workspace_id, restored_context_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, truck_id)
    REFERENCES line_trucks(workspace_id, truck_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Immutable base snapshot for standalone and parallel alike. It keeps the archive
-- activeLineIds/ttnStatus and is not a current assignment and never blocks a truck.
CREATE TABLE restored_context_status_snapshots (
  workspace_id text NOT NULL,
  restored_context_id text NOT NULL,
  truck_id text NOT NULL,
  payload jsonb NOT NULL,
  status_revision bigint NOT NULL CHECK (status_revision > 0),
  cycle_revision bigint NOT NULL CHECK (cycle_revision > 0),
  ttn_revision bigint NOT NULL CHECK (ttn_revision > 0),
  PRIMARY KEY (workspace_id, restored_context_id, truck_id),
  FOREIGN KEY (workspace_id, restored_context_id)
    REFERENCES restored_shift_contexts(workspace_id, restored_context_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, truck_id)
    REFERENCES line_trucks(workspace_id, truck_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE restored_context_history (
  workspace_id text NOT NULL,
  action_id text NOT NULL CHECK (length(action_id) BETWEEN 1 AND 160),
  restored_context_id text NOT NULL,
  uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  type text NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
  before_log jsonb,
  after_log jsonb,
  before_status_snapshot jsonb,
  after_status_snapshot jsonb,
  revision bigint NOT NULL CHECK (revision > 0),
  undone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, action_id),
  FOREIGN KEY (workspace_id, restored_context_id)
    REFERENCES restored_shift_contexts(workspace_id, restored_context_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX restored_context_history_context_idx
  ON restored_context_history(workspace_id, restored_context_id, created_at DESC, action_id);

CREATE TABLE restored_context_receipts (
  workspace_id text NOT NULL,
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  restored_context_id text NOT NULL,
  uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  protocol_version smallint NOT NULL CHECK (protocol_version > 0),
  command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, operation_id),
  FOREIGN KEY (workspace_id, restored_context_id)
    REFERENCES restored_shift_contexts(workspace_id, restored_context_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE restored_context_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL,
  restored_context_id text NOT NULL,
  action_id text,
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  type text NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
  before_state jsonb,
  after_state jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, restored_context_id)
    REFERENCES restored_shift_contexts(workspace_id, restored_context_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, action_id)
    REFERENCES restored_context_history(workspace_id, action_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX restored_context_audit_context_idx
  ON restored_context_audit(workspace_id, restored_context_id, audit_id);

-- Immutable evidence of a legacy restored migration. One context has exactly one
-- manifest; the locator names the single legacy archive document/revision.
CREATE TABLE restored_context_migration_evidence (
  workspace_id text NOT NULL,
  evidence_id uuid NOT NULL,
  legacy_shift_id text NOT NULL CHECK (length(legacy_shift_id) BETWEEN 1 AND 160),
  archive_id text NOT NULL,
  base_archive_revision bigint NOT NULL CHECK (base_archive_revision > 0),
  source_locator text NOT NULL CHECK (length(source_locator) BETWEEN 1 AND 1024),
  source_bytes_sha256 text NOT NULL CHECK (source_bytes_sha256 ~ '^[0-9a-f]{64}$'),
  source_counts jsonb NOT NULL,
  source_table_roots jsonb NOT NULL,
  closure_hash text NOT NULL CHECK (closure_hash ~ '^[0-9a-f]{64}$'),
  migrated_context_id text NOT NULL,
  migration_operation_id text NOT NULL CHECK (migration_operation_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, evidence_id),
  UNIQUE (workspace_id, migrated_context_id),
  UNIQUE (workspace_id, legacy_shift_id),
  UNIQUE (workspace_id, source_locator),
  FOREIGN KEY (workspace_id, migrated_context_id)
    REFERENCES restored_shift_contexts(workspace_id, restored_context_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, archive_id)
    REFERENCES shift_archive_series(workspace_id, archive_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, archive_id, base_archive_revision)
    REFERENCES shift_archive_revisions(workspace_id, archive_id, archive_revision)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- One row per migrated append-only audit/receipt row. There is deliberately no
-- `restored_context_id` here: the context is derived only through the parent FK,
-- so a duplicated unchecked context identity is impossible. `source_table` is a
-- versioned allow-list; adding a table requires a schema version/review.
CREATE TABLE restored_context_migration_evidence_rows (
  workspace_id text NOT NULL,
  evidence_id uuid NOT NULL,
  source_table text NOT NULL CHECK (source_table IN (
    'workspace_service_audit', 'workspace_service_receipts',
    'line_audit', 'line_operation_receipts',
    'line_history', 'history_audit', 'history_receipts',
    'shift_operation_receipts'
  )),
  source_pk_canonical_jcs text NOT NULL CHECK (length(source_pk_canonical_jcs) BETWEEN 2 AND 4096),
  source_pk_hash text NOT NULL CHECK (source_pk_hash ~ '^[0-9a-f]{64}$'),
  source_row_sha256 text NOT NULL CHECK (source_row_sha256 ~ '^[0-9a-f]{64}$'),
  source_bytes bytea,
  representation_kind text NOT NULL CHECK (length(representation_kind) BETWEEN 1 AND 64),
  target_table text NOT NULL CHECK (length(target_table) BETWEEN 1 AND 160),
  target_pk_canonical_jcs text NOT NULL CHECK (length(target_pk_canonical_jcs) BETWEEN 2 AND 4096),
  copied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, evidence_id, source_table, source_pk_hash),
  CHECK (source_pk_hash = encode(sha256(convert_to(source_pk_canonical_jcs, 'UTF8')), 'hex')),
  CONSTRAINT fk_restored_evidence_rows_parent
    FOREIGN KEY (workspace_id, evidence_id)
    REFERENCES restored_context_migration_evidence(workspace_id, evidence_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Append-only archive audit with archive/source identity, before/after, actor/time.
CREATE TABLE archive_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL,
  archive_id text NOT NULL,
  source_shift_id text NOT NULL CHECK (length(source_shift_id) BETWEEN 1 AND 160),
  before_state jsonb,
  after_state jsonb,
  actor_uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, archive_id)
    REFERENCES shift_archive_series(workspace_id, archive_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX archive_audit_series_idx
  ON archive_audit(workspace_id, archive_id, audit_id);

-- Immutability guard for the archive chain. Same shape as the accepted P4 guard:
-- row triggers for UPDATE/DELETE, statement triggers for TRUNCATE (which bypasses
-- row triggers), all failing closed with check_violation.
CREATE OR REPLACE FUNCTION archive_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $archive_immutable$
BEGIN
  RAISE EXCEPTION 'append-only archive record: % is forbidden on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$archive_immutable$;

CREATE TRIGGER shift_archive_revisions_append_only
  BEFORE UPDATE OR DELETE ON shift_archive_revisions
  FOR EACH ROW EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER shift_archive_revisions_no_truncate
  BEFORE TRUNCATE ON shift_archive_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER archive_operation_receipts_append_only
  BEFORE UPDATE OR DELETE ON archive_operation_receipts
  FOR EACH ROW EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER archive_operation_receipts_no_truncate
  BEFORE TRUNCATE ON archive_operation_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER archive_revision_publications_append_only
  BEFORE UPDATE OR DELETE ON archive_revision_publications
  FOR EACH ROW EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER archive_revision_publications_no_truncate
  BEFORE TRUNCATE ON archive_revision_publications
  FOR EACH STATEMENT EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER restored_context_status_snapshots_append_only
  BEFORE UPDATE OR DELETE ON restored_context_status_snapshots
  FOR EACH ROW EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER restored_context_status_snapshots_no_truncate
  BEFORE TRUNCATE ON restored_context_status_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER restored_context_history_append_only
  BEFORE UPDATE OR DELETE ON restored_context_history
  FOR EACH ROW EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER restored_context_history_no_truncate
  BEFORE TRUNCATE ON restored_context_history
  FOR EACH STATEMENT EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER restored_context_receipts_append_only
  BEFORE UPDATE OR DELETE ON restored_context_receipts
  FOR EACH ROW EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER restored_context_receipts_no_truncate
  BEFORE TRUNCATE ON restored_context_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER restored_context_audit_append_only
  BEFORE UPDATE OR DELETE ON restored_context_audit
  FOR EACH ROW EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER restored_context_audit_no_truncate
  BEFORE TRUNCATE ON restored_context_audit
  FOR EACH STATEMENT EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER restored_context_migration_evidence_append_only
  BEFORE UPDATE OR DELETE ON restored_context_migration_evidence
  FOR EACH ROW EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER restored_context_migration_evidence_no_truncate
  BEFORE TRUNCATE ON restored_context_migration_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER restored_context_migration_evidence_rows_append_only
  BEFORE UPDATE OR DELETE ON restored_context_migration_evidence_rows
  FOR EACH ROW EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER restored_context_migration_evidence_rows_no_truncate
  BEFORE TRUNCATE ON restored_context_migration_evidence_rows
  FOR EACH STATEMENT EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER archive_audit_append_only
  BEFORE UPDATE OR DELETE ON archive_audit
  FOR EACH ROW EXECUTE FUNCTION archive_immutable_guard();
CREATE TRIGGER archive_audit_no_truncate
  BEFORE TRUNCATE ON archive_audit
  FOR EACH STATEMENT EXECUTE FUNCTION archive_immutable_guard();

-- PostgreSQL authority boundary is ownership/grants only, never a GUC or an
-- advisory lock. The evidence owner is bootstrapped outside SQL; here it only
-- receives ownership of the evidence manifest and its immutable triggers when the
-- applying role is allowed to assume it (schema owner / superuser). The runtime
-- and PUBLIC lose every mutation right on evidence and on the allow-listed source
-- append-only tables. Identifiers below are a fixed literal allow-list: no dynamic
-- identifier ever comes from a parameter.
DO $archive_evidence_authority$
DECLARE
  target text;
  source_table text;
  applying_role_is_super boolean;
  can_assume_owner boolean;
  can_administer boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_migration_evidence_owner') THEN
    RAISE EXCEPTION 'samosval_migration_evidence_owner must be bootstrapped before 025'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT rolsuper INTO applying_role_is_super FROM pg_roles WHERE rolname = current_user;
  SELECT COALESCE(applying_role_is_super, false)
      OR pg_has_role(current_user, 'samosval_migration_evidence_owner', 'MEMBER')
    INTO can_assume_owner;

  IF can_assume_owner THEN
    FOR target IN
      SELECT unnest(ARRAY[
        'restored_context_migration_evidence',
        'restored_context_migration_evidence_rows'
      ])
    LOOP
      EXECUTE format('ALTER TABLE public.%I OWNER TO samosval_migration_evidence_owner', target);
    END LOOP;
    -- The owner resolves its tables (and its FK checks) through schema public.
    GRANT USAGE ON SCHEMA public TO samosval_migration_evidence_owner;
  ELSE
    RAISE NOTICE 'archive evidence ownership stays with % : role cannot assume samosval_migration_evidence_owner', current_user;
  END IF;

  FOR target IN
    SELECT unnest(ARRAY[
      'shift_archive_revisions',
      'archive_operation_receipts',
      'archive_revision_publications',
      'restored_context_status_snapshots',
      'restored_context_history',
      'restored_context_receipts',
      'restored_context_audit',
      'restored_context_migration_evidence',
      'restored_context_migration_evidence_rows',
      'archive_audit'
    ])
  LOOP
    SELECT (COALESCE(applying_role_is_super, false)
            OR pg_has_role(current_user, c.relowner, 'MEMBER')) INTO can_administer
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = target;
    IF can_administer THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_runtime') THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM samosval_runtime', target);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_maintenance') THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM samosval_maintenance', target);
      END IF;
    ELSE
      RAISE NOTICE 'archive ACL for % stays with the table owner: % cannot administer it', target, current_user;
    END IF;
  END LOOP;

  -- Allow-listed source append-only tables: no mutation right for runtime/PUBLIC.
  -- A role that does not own a pre-existing source table cannot change its ACL; the
  -- owner/schema-owner path does, and the runtime never holds such a right anyway.
  FOR source_table IN
    SELECT unnest(ARRAY[
      'workspace_service_audit', 'workspace_service_receipts',
      'line_audit', 'line_operation_receipts',
      'line_history', 'history_audit', 'history_receipts',
      'shift_operation_receipts'
    ])
  LOOP
    IF to_regclass('public.' || source_table) IS NOT NULL THEN
      SELECT (COALESCE(applying_role_is_super, false)
              OR pg_has_role(current_user, c.relowner, 'MEMBER')) INTO can_administer
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = source_table;
      IF can_administer THEN
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM PUBLIC', source_table);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_runtime') THEN
          EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM samosval_runtime', source_table);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_maintenance') THEN
          EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM samosval_maintenance', source_table);
        END IF;
      ELSE
        RAISE NOTICE 'source ACL for % stays with the table owner: % cannot administer it', source_table, current_user;
      END IF;
    END IF;
  END LOOP;
END
$archive_evidence_authority$;


-- ============================================================================
-- Legacy restored migration (Task 7, design §4.6).
-- Additive only: one named immutable receipt guard, the plan/manifest readers,
-- one exact SECURITY DEFINER copy-verify-delete function, their ownership and
-- grants, and the lookup indexes the migration uses. Nothing from P3/P4/P5/P6 is
-- rewritten and no restored row is migrated by this block.
--
-- Authority model: the only bypass is a transactional
-- `ALTER TABLE public.archive_overrides DISABLE TRIGGER <fixed name>` executed by
-- the owner of that table inside the static SECURITY DEFINER function. No GUC,
-- `current_user` check, advisory lock or function identity is a capability, and
-- `session_replication_role` is never touched.
-- ============================================================================

-- The legacy restore receipt (`archive_overrides` row with location='restored')
-- is the immutable proof that a `shifts` row with restored provenance came from a
-- named archive document. Its placement can only be closed by the exact migration
-- below: a plain UPDATE cannot return it to the archive catalog. DELETE stays
-- legal so a workspace reset/teardown still removes its own catalog rows.
CREATE OR REPLACE FUNCTION public.archive_overrides_restored_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $restored_receipt_guard$
BEGIN
  IF OLD.location = 'restored' AND NEW.location IS DISTINCT FROM OLD.location THEN
    RAISE EXCEPTION 'legacy restore receipt is immutable: % cannot leave location=restored', OLD.record_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$restored_receipt_guard$;

DROP TRIGGER IF EXISTS archive_overrides_restored_receipt_immutable ON public.archive_overrides;
CREATE TRIGGER archive_overrides_restored_receipt_immutable
  BEFORE UPDATE ON public.archive_overrides
  FOR EACH ROW EXECUTE FUNCTION public.archive_overrides_restored_receipt_guard();

-- Exact source lookups the migration performs.
CREATE INDEX IF NOT EXISTS line_history_shift_action_idx
  ON public.line_history(workspace_id, shift_id, action_id);
CREATE INDEX IF NOT EXISTS history_audit_action_idx
  ON public.history_audit(workspace_id, action_id, operation_id);
CREATE INDEX IF NOT EXISTS restored_context_logs_source_idx
  ON public.restored_context_logs(workspace_id, source_log_id);
CREATE INDEX IF NOT EXISTS restored_context_migration_evidence_locator_idx
  ON public.restored_context_migration_evidence(workspace_id, source_locator);

-- ----------------------------------------------------------------------------
-- Plan builder. Pure read: no lock, no write, no dynamic identifier. Every
-- branch is a static allow-listed table; the returned plan is the exact manifest
-- the mutation function re-verifies against the locked rows.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restored_context_migration_plan(
  p_workspace_id text,
  p_legacy_shift_id text,
  p_archive_id text,
  p_base_archive_revision bigint,
  p_migration_operation_id text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $restored_plan$
DECLARE
  shift_row record;
  series_row record;
  revision_row record;
  receipt_row record;
  archive_doc jsonb;
  v_mode text;
  v_restored_from text;
  v_restored_uid text;
  v_restored_name text;
  v_restored_at timestamptz;
  v_opened_uid text;
  v_opened_name text;
  v_identity_resolution text;
  v_shift_type text;
  v_type_resolution text;
  v_actions text[];
  v_report_actions text[];
  v_history_actions text[];
  v_logs jsonb;
  v_statuses jsonb;
  v_history jsonb;
  v_receipts jsonb;
  v_audits jsonb;
  v_evidence_rows jsonb;
  v_counts jsonb;
  v_roots jsonb;
  v_target_counts jsonb;
  v_context jsonb;
  v_archive jsonb;
  v_receipt jsonb;
  v_manifest jsonb;
  v_closure jsonb;
  v_closure_hash text;
  v_context_id text;
  v_evidence_id uuid;
  v_seed text;
  v_bad int;
BEGIN
  IF p_workspace_id IS NULL OR p_legacy_shift_id IS NULL OR p_archive_id IS NULL
     OR p_base_archive_revision IS NULL OR p_migration_operation_id IS NULL THEN
    RAISE EXCEPTION 'migration-manifest-invalid: every locator argument is required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF length(p_workspace_id) NOT BETWEEN 1 AND 160
     OR length(p_legacy_shift_id) NOT BETWEEN 1 AND 160
     OR length(p_archive_id) NOT BETWEEN 1 AND 160
     OR p_base_archive_revision < 1
     OR p_migration_operation_id !~ '^[A-Za-z0-9_-]{1,160}$' THEN
    RAISE EXCEPTION 'migration-manifest-invalid: locator argument is not well formed'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 1. Source row exists and carries restored provenance.
  SELECT * INTO shift_row FROM public.shifts s
   WHERE s.workspace_id = p_workspace_id AND s.shift_id = p_legacy_shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'migration-source-missing: no shift % in workspace %', p_legacy_shift_id, p_workspace_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (shift_row.payload ? 'restoredFrom' OR COALESCE(shift_row.payload->>'restored','') = 'true') THEN
    RAISE EXCEPTION 'migration-not-restored: shift % carries no restored provenance', p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  v_restored_from := NULLIF(btrim(shift_row.payload->>'restoredFrom'),'');
  IF v_restored_from IS NULL THEN
    RAISE EXCEPTION 'migration-restore-receipt-missing: shift % names no restored archive record', p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  v_mode := CASE WHEN shift_row.payload->>'restored' = 'true' THEN 'parallel' ELSE 'standalone' END;

  -- 2. The legacy restore receipt must still point at the archive.
  SELECT * INTO receipt_row FROM public.archive_overrides o
   WHERE o.workspace_id = p_workspace_id AND o.record_id = v_restored_from;
  IF NOT FOUND OR receipt_row.location <> 'restored' THEN
    RAISE EXCEPTION 'migration-restore-receipt-missing: archive record % is not a live restored receipt', v_restored_from
      USING ERRCODE = 'check_violation';
  END IF;

  -- 3. Named archive series/revision must exist and match the receipt bytes.
  SELECT * INTO series_row FROM public.shift_archive_series ss
   WHERE ss.workspace_id = p_workspace_id AND ss.archive_id = p_archive_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'migration-archive-missing: no archive series % in workspace %', p_archive_id, p_workspace_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO revision_row FROM public.shift_archive_revisions rr
   WHERE rr.workspace_id = p_workspace_id AND rr.archive_id = p_archive_id
     AND rr.archive_revision = p_base_archive_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'migration-archive-missing: archive % has no revision %', p_archive_id, p_base_archive_revision
      USING ERRCODE = 'check_violation';
  END IF;
  archive_doc := convert_from(revision_row.payload_bytes,'UTF8')::jsonb;
  IF series_row.source_shift_id IS DISTINCT FROM NULLIF(receipt_row.payload->>'sourceShiftId','') THEN
    RAISE EXCEPTION 'migration-archive-mismatch: receipt % names source shift %, series % names %',
      v_restored_from, COALESCE(receipt_row.payload->>'sourceShiftId',''), p_archive_id, series_row.source_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NULLIF(btrim(shift_row.payload->>'originalSourceShiftId'),'') IS NOT NULL
     AND shift_row.payload->>'originalSourceShiftId' IS DISTINCT FROM series_row.source_shift_id THEN
    RAISE EXCEPTION 'migration-archive-mismatch: restored shift % names source shift %',
      p_legacy_shift_id, shift_row.payload->>'originalSourceShiftId'
      USING ERRCODE = 'check_violation';
  END IF;
  IF receipt_row.payload IS DISTINCT FROM archive_doc THEN
    RAISE EXCEPTION 'migration-archive-receipt-mismatch: receipt % bytes differ from revision % of archive %',
      v_restored_from, p_base_archive_revision, p_archive_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 4. Restore actor comes from the proven legacy restore fields; the original
  -- opener/type come only from the archive document and are never replaced.
  v_restored_uid := NULLIF(btrim(shift_row.payload->>'startedByUid'),'');
  v_restored_name := NULLIF(btrim(shift_row.payload->>'startedBy'),'');
  IF v_restored_uid IS NULL OR v_restored_name IS NULL
     OR jsonb_typeof(shift_row.payload->'startedAt') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'migration-restore-actor-unproven: shift % carries no restore actor/time', p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_users u WHERE u.uid = v_restored_uid) THEN
    RAISE EXCEPTION 'migration-restore-actor-unproven: restore actor % is not a known user', v_restored_uid
      USING ERRCODE = 'check_violation';
  END IF;
  v_restored_at := to_timestamp((shift_row.payload->>'startedAt')::double precision / 1000.0);

  v_opened_uid := NULLIF(btrim(archive_doc->>'openedByUid'),'');
  IF v_opened_uid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.app_users u WHERE u.uid = v_opened_uid) THEN
    RAISE EXCEPTION 'migration-original-opener-unknown: archive names opener %', v_opened_uid
      USING ERRCODE = 'check_violation';
  END IF;
  v_opened_name := COALESCE(NULLIF(archive_doc->>'openedByName',''), NULLIF(archive_doc->>'openedByNameSnapshot',''));
  v_identity_resolution := CASE WHEN v_opened_uid IS NULL THEN 'unresolved' ELSE 'source' END;
  v_shift_type := CASE WHEN archive_doc->>'shiftType' IN ('day','night') THEN archive_doc->>'shiftType' END;
  v_type_resolution := CASE WHEN v_shift_type IS NULL THEN 'unresolved' ELSE 'source' END;

  -- 5. No child may belong to another shift/workspace and no child may name a
  -- truck that does not exist (the target FK must be provable).
  SELECT count(*)::int INTO v_bad FROM public.line_logs l
   WHERE l.workspace_id = p_workspace_id AND l.shift_id = p_legacy_shift_id
     AND (l.payload ? 'shiftId' AND l.payload->>'shiftId' IS DISTINCT FROM p_legacy_shift_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'migration-foreign-child: a line log of shift % names another shift', p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::int INTO v_bad FROM public.line_truck_statuses st
   WHERE st.workspace_id = p_workspace_id AND st.shift_id = p_legacy_shift_id
     AND (st.payload ? 'shiftId' AND st.payload->>'shiftId' IS DISTINCT FROM p_legacy_shift_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'migration-foreign-child: a truck status of shift % names another shift', p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::int INTO v_bad FROM public.line_logs l
   WHERE l.workspace_id = p_workspace_id AND l.shift_id = p_legacy_shift_id
     AND NOT EXISTS (SELECT 1 FROM public.line_trucks t
                      WHERE t.workspace_id = p_workspace_id AND t.truck_id = l.truck_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'migration-truck-orphan: % line log(s) of shift % name an unknown truck', v_bad, p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::int INTO v_bad FROM public.line_truck_statuses st
   WHERE st.workspace_id = p_workspace_id AND st.shift_id = p_legacy_shift_id
     AND NOT EXISTS (SELECT 1 FROM public.line_trucks t
                      WHERE t.workspace_id = p_workspace_id AND t.truck_id = st.truck_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'migration-truck-orphan: % truck status(es) of shift % name an unknown truck', v_bad, p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 6. A parallel restored row never carried statuses: it is rebuilt as an
  -- explicit archive snapshot, never as a business event.
  IF v_mode = 'parallel' AND EXISTS (
       SELECT 1 FROM public.line_truck_statuses st
        WHERE st.workspace_id = p_workspace_id AND st.shift_id = p_legacy_shift_id) THEN
    RAISE EXCEPTION 'migration-parallel-with-statuses: parallel shift % carries truck statuses', p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 7. No side effect that the migration would have to invent.
  SELECT count(*)::int INTO v_bad FROM public.shift_members m
   WHERE m.workspace_id = p_workspace_id AND m.shift_id = p_legacy_shift_id;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'migration-foreign-reference: shift % still has shift members', p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::int INTO v_bad FROM public.legacy_line_status_snapshots sn
   WHERE sn.workspace_id = p_workspace_id AND sn.shift_id = p_legacy_shift_id;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'migration-foreign-reference: shift % already has legacy status snapshots', p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::int INTO v_bad FROM public.legacy_cutover_historicalization_audit cu
   WHERE cu.workspace_id = p_workspace_id AND cu.shift_id = p_legacy_shift_id;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'migration-foreign-reference: shift % is part of a historicalization cutover', p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*)::int INTO v_bad FROM public.shift_archives ar
   WHERE ar.workspace_id = p_workspace_id AND ar.shift_id = p_legacy_shift_id;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'migration-foreign-reference: shift % already owns a legacy archive row', p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 8. Exact action identity of the restored line.
  SELECT COALESCE(array_agg(lh.action_id ORDER BY lh.action_id COLLATE "C"), ARRAY[]::text[])
    INTO v_actions
    FROM public.line_history lh
   WHERE lh.workspace_id = p_workspace_id AND lh.shift_id = p_legacy_shift_id;
  SELECT COALESCE(array_agg(a.operation_id ORDER BY a.operation_id COLLATE "C"), ARRAY[]::text[])
    INTO v_report_actions
    FROM public.workspace_service_audit a
   WHERE a.workspace_id = p_workspace_id
     AND a.type IN ('report.update','report.delete')
     AND (a.before_data->>'shiftId' = p_legacy_shift_id OR a.after_data->>'shiftId' = p_legacy_shift_id);
  SELECT COALESCE(array_agg(DISTINCT ha.operation_id), ARRAY[]::text[])
    INTO v_history_actions
    FROM public.history_audit ha
   WHERE ha.workspace_id = p_workspace_id AND ha.action_id = ANY(v_actions);

  -- 9. Target rows. Every payload is copied verbatim.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'log_id', l.log_id,
           'truck_id', l.truck_id,
           'payload', l.payload,
           'log_revision', 1,
           'source_log_id', l.log_id,
           'created_from_archive_revision', p_base_archive_revision
         ) ORDER BY l.log_id COLLATE "C"), '[]'::jsonb)
    INTO v_logs
    FROM public.line_logs l
   WHERE l.workspace_id = p_workspace_id AND l.shift_id = p_legacy_shift_id;

  IF v_mode = 'standalone' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'truck_id', st.truck_id,
             'payload', st.payload,
             'status_revision', 1,
             'cycle_revision', 1,
             'ttn_revision', 1
           ) ORDER BY st.truck_id COLLATE "C"), '[]'::jsonb)
      INTO v_statuses
      FROM public.line_truck_statuses st
     WHERE st.workspace_id = p_workspace_id AND st.shift_id = p_legacy_shift_id;
  ELSE
    SELECT COALESCE(jsonb_agg(snap.row ORDER BY snap.truck_id COLLATE "C"), '[]'::jsonb)
      INTO v_statuses
      FROM (
        SELECT trucks.truck_id,
               jsonb_build_object(
                 'truck_id', trucks.truck_id,
                 'payload', jsonb_build_object(
                   'id', trucks.truck_id,
                   'shiftId', p_legacy_shift_id,
                   'onLine', EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                                       COALESCE(archive_doc->'activeLineIds','[]'::jsonb)) a(id)
                                      WHERE a.id = trucks.truck_id),
                   'arriveStatus', NULL,
                   'arriveTimestamp', NULL,
                   'arriveBy', NULL,
                   'ttnStatus', archive_doc->'ttnStatus'->trucks.truck_id,
                   'ttnBy', NULL,
                   'ttnLogId', last_log.log_id,
                   'lastLoadTimestamp', (last_log.payload->>'timestamp')::bigint,
                   'lastLoadBy', last_log.payload->>'createdBy',
                   'lastLoadLogId', last_log.log_id,
                   'cycleRevision', 1,
                   'ttnRevision', 1,
                   'loadedAfterArrive', false,
                   'snapshotSource', 'archive'
                 ),
                 'status_revision', 1,
                 'cycle_revision', 1,
                 'ttn_revision', 1
               ) AS row
          FROM (
            SELECT l.truck_id FROM public.line_logs l
             WHERE l.workspace_id = p_workspace_id AND l.shift_id = p_legacy_shift_id
            UNION
            SELECT a.id FROM jsonb_array_elements_text(
                            COALESCE(archive_doc->'activeLineIds','[]'::jsonb)) a(id)
          ) trucks
          LEFT JOIN LATERAL (
            SELECT l.log_id, l.payload FROM public.line_logs l
             WHERE l.workspace_id = p_workspace_id AND l.shift_id = p_legacy_shift_id
               AND l.truck_id = trucks.truck_id
             ORDER BY (l.payload->>'timestamp')::bigint DESC, l.log_id COLLATE "C" DESC
             LIMIT 1
          ) last_log ON true
      ) snap;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_statuses) e
       WHERE NOT EXISTS (SELECT 1 FROM public.line_trucks t
                          WHERE t.workspace_id = p_workspace_id AND t.truck_id = e->>'truck_id')) THEN
      RAISE EXCEPTION 'migration-truck-orphan: archive snapshot of shift % names an unknown truck', p_legacy_shift_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Restored history: line actions of the shift and report corrections addressing it.
  SELECT COALESCE(jsonb_agg(rows.row ORDER BY rows.action_id COLLATE "C"), '[]'::jsonb)
    INTO v_history
    FROM (
      SELECT lh.action_id,
             jsonb_build_object(
               'action_id', lh.action_id,
               'uid', lh.uid,
               'type', lh.type,
               'before_log', lh.log_data,
               'after_log', NULL,
               'before_status_snapshot', lh.before_status,
               'after_status_snapshot', lh.after_status,
               'revision', lh.revision,
               'undone', lh.undone,
               'created_at', to_char(lh.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) AS row
        FROM public.line_history lh
       WHERE lh.workspace_id = p_workspace_id AND lh.shift_id = p_legacy_shift_id
      UNION ALL
      SELECT a.operation_id,
             jsonb_build_object(
               'action_id', a.operation_id,
               'uid', a.uid,
               'type', a.type,
               'before_log', a.before_data->'log',
               'after_log', a.after_data->'log',
               'before_status_snapshot', a.before_data->'status',
               'after_status_snapshot', a.after_data->'status',
               'revision', a.revision,
               'undone', a.undone,
               'created_at', to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) AS row
        FROM public.workspace_service_audit a
       WHERE a.workspace_id = p_workspace_id AND a.operation_id = ANY(v_report_actions)
    ) rows;
  IF (SELECT count(*) FROM jsonb_array_elements(v_history)) <>
     (SELECT count(DISTINCT e->>'action_id') FROM jsonb_array_elements(v_history) e) THEN
    RAISE EXCEPTION 'migration-ambiguous-history: shift % has two actions with one identity', p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Restored receipts: every receipt attributable by exact operation identity.
  SELECT COALESCE(jsonb_agg(rows.row ORDER BY rows.operation_id COLLATE "C"), '[]'::jsonb)
    INTO v_receipts
    FROM (
      SELECT r.operation_id,
             jsonb_build_object(
               'operation_id', r.operation_id,
               'uid', r.uid,
               'protocol_version', 1,
               'command_hash', r.request_hash,
               'result', r.result,
               'recorded_at', to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) AS row
        FROM public.line_operation_receipts r
       WHERE r.workspace_id = p_workspace_id AND r.operation_id = ANY(v_actions)
      UNION ALL
      SELECT r.operation_id,
             jsonb_build_object(
               'operation_id', r.operation_id,
               'uid', r.uid,
               'protocol_version', 1,
               'command_hash', r.request_hash,
               'result', r.result,
               'recorded_at', COALESCE(
                 to_char((SELECT min(ha.created_at) FROM public.history_audit ha
                           WHERE ha.workspace_id = p_workspace_id AND ha.operation_id = r.operation_id)
                         AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                 to_char(v_restored_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
             ) AS row
        FROM public.history_receipts r
       WHERE r.workspace_id = p_workspace_id AND r.operation_id = ANY(v_history_actions)
      UNION ALL
      SELECT r.operation_id,
             jsonb_build_object(
               'operation_id', r.operation_id,
               'uid', r.uid,
               'protocol_version', 1,
               'command_hash', r.request_hash,
               'result', r.result,
               'recorded_at', COALESCE(
                 to_char((SELECT min(a.created_at) FROM public.workspace_service_audit a
                           WHERE a.workspace_id = p_workspace_id AND a.operation_id = r.operation_id)
                         AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                 to_char(v_restored_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
             ) AS row
        FROM public.workspace_service_receipts r
       WHERE r.workspace_id = p_workspace_id AND r.operation_id = ANY(v_report_actions)
      UNION ALL
      SELECT r.operation_id,
             jsonb_build_object(
               'operation_id', r.operation_id,
               'uid', r.uid,
               'protocol_version', 1,
               'command_hash', r.request_hash,
               'result', r.result,
               'recorded_at', to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) AS row
        FROM public.shift_operation_receipts r
       WHERE r.workspace_id = p_workspace_id AND r.result->'shift'->>'id' = p_legacy_shift_id
    ) rows;
  IF (SELECT count(*) FROM jsonb_array_elements(v_receipts)) <>
     (SELECT count(DISTINCT e->>'operation_id') FROM jsonb_array_elements(v_receipts) e) THEN
    RAISE EXCEPTION 'migration-duplicate-receipt: shift % has two receipts with one operation id', p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_receipts) e
              WHERE e->>'command_hash' !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'migration-receipt-hash-invalid: a receipt of shift % carries no exact command hash', p_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Restored audit: line audit rows, their undo/redo audit rows and report
  -- correction audit rows, with exact actor/type/state/time.
  SELECT COALESCE(jsonb_agg(rows.row ORDER BY rows.operation_id COLLATE "C", rows.type COLLATE "C"), '[]'::jsonb)
    INTO v_audits
    FROM (
      SELECT a.operation_id,
             a.type,
             jsonb_build_object(
               'action_id', (SELECT h->>'action_id' FROM jsonb_array_elements(v_history) h
                              WHERE h->>'action_id' = a.operation_id LIMIT 1),
               'operation_id', a.operation_id,
               'uid', a.uid,
               'type', a.type,
               'before_state', NULL,
               'after_state', jsonb_build_object('status', a.status),
               'recorded_at', to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) AS row
        FROM public.line_audit a
       WHERE a.workspace_id = p_workspace_id AND a.operation_id = ANY(v_actions)
      UNION ALL
      SELECT ha.operation_id,
             'history_' || ha.direction,
             jsonb_build_object(
               'action_id', ha.action_id,
               'operation_id', ha.operation_id,
               'uid', ha.uid,
               'type', 'history_' || ha.direction,
               'before_state', NULL,
               'after_state', NULL,
               'recorded_at', to_char(ha.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) AS row
        FROM public.history_audit ha
       WHERE ha.workspace_id = p_workspace_id AND ha.action_id = ANY(v_actions)
      UNION ALL
      SELECT a.operation_id,
             a.type,
             jsonb_build_object(
               'action_id', a.operation_id,
               'operation_id', a.operation_id,
               'uid', a.uid,
               'type', a.type,
               'before_state', a.before_data,
               'after_state', a.after_data,
               'recorded_at', to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) AS row
        FROM public.workspace_service_audit a
       WHERE a.workspace_id = p_workspace_id AND a.operation_id = ANY(v_report_actions)
    ) rows;

  -- 10. Evidence child rows: one exact locator per migrated append-only row.
  SELECT COALESCE(jsonb_agg(ev.row ORDER BY ev.source_table COLLATE "C", ev.source_pk_hash COLLATE "C"), '[]'::jsonb)
    INTO v_evidence_rows
    FROM (
      SELECT 'line_history'::text AS source_table,
             encode(sha256(convert_to(t.pk,'UTF8')),'hex') AS source_pk_hash,
             jsonb_build_object(
               'source_table','line_history',
               'source_pk_canonical_jcs', t.pk,
               'source_pk_hash', encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
               'source_row_sha256', encode(sha256(convert_to(t.canonical,'UTF8')),'hex'),
               'source_bytes_hex', encode(convert_to(t.canonical,'UTF8'),'hex'),
               'representation_kind','jsonb-canonical-v1',
               'target_table','restored_context_history',
               'target_pk_canonical_jcs', jsonb_build_object('action_id',t.action_id,'workspace_id',p_workspace_id)::text
             ) AS row
        FROM (
          SELECT jsonb_build_object('action_id',lh.action_id,'workspace_id',lh.workspace_id)::text AS pk,
                 lh.action_id,
                 jsonb_build_object(
                   'workspace_id',lh.workspace_id,'action_id',lh.action_id,'uid',lh.uid,'shift_id',lh.shift_id,
                   'truck_id',lh.truck_id,'type',lh.type,'before_status',lh.before_status,'after_status',lh.after_status,
                   'log_data',lh.log_data,'undone',lh.undone,'revision',lh.revision,
                   'created_at',to_char(lh.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                   'game_rewards',lh.game_rewards,'game_actor',lh.game_actor
                 )::text AS canonical
            FROM public.line_history lh
           WHERE lh.workspace_id = p_workspace_id AND lh.shift_id = p_legacy_shift_id
        ) t
      UNION ALL
      SELECT 'line_audit', encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
             jsonb_build_object(
               'source_table','line_audit','source_pk_canonical_jcs',t.pk,
               'source_pk_hash',encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
               'source_row_sha256',encode(sha256(convert_to(t.canonical,'UTF8')),'hex'),
               'source_bytes_hex',encode(convert_to(t.canonical,'UTF8'),'hex'),
               'representation_kind','jsonb-canonical-v1',
               'target_table','restored_context_audit',
               'target_pk_canonical_jcs', jsonb_build_object('action_id',t.operation_id,'operation_id',t.operation_id,'workspace_id',p_workspace_id)::text
             )
        FROM (
          SELECT jsonb_build_object('operation_id',a.operation_id,'workspace_id',a.workspace_id)::text AS pk,
                 a.operation_id,
                 jsonb_build_object(
                   'workspace_id',a.workspace_id,'operation_id',a.operation_id,'uid',a.uid,'type',a.type,
                   'status',a.status,'created_at',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 )::text AS canonical
            FROM public.line_audit a
           WHERE a.workspace_id = p_workspace_id AND a.operation_id = ANY(v_actions)
        ) t
      UNION ALL
      SELECT 'line_operation_receipts', encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
             jsonb_build_object(
               'source_table','line_operation_receipts','source_pk_canonical_jcs',t.pk,
               'source_pk_hash',encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
               'source_row_sha256',encode(sha256(convert_to(t.canonical,'UTF8')),'hex'),
               'source_bytes_hex',encode(convert_to(t.canonical,'UTF8'),'hex'),
               'representation_kind','jsonb-canonical-v1',
               'target_table','restored_context_receipts',
               'target_pk_canonical_jcs', jsonb_build_object('operation_id',t.operation_id,'workspace_id',p_workspace_id)::text
             )
        FROM (
          SELECT jsonb_build_object('operation_id',r.operation_id,'workspace_id',r.workspace_id)::text AS pk,
                 r.operation_id,
                 jsonb_build_object(
                   'workspace_id',r.workspace_id,'operation_id',r.operation_id,'uid',r.uid,'request_hash',r.request_hash,
                   'result',r.result,'recorded_at',to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 )::text AS canonical
            FROM public.line_operation_receipts r
           WHERE r.workspace_id = p_workspace_id AND r.operation_id = ANY(v_actions)
        ) t
      UNION ALL
      SELECT 'history_audit', encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
             jsonb_build_object(
               'source_table','history_audit','source_pk_canonical_jcs',t.pk,
               'source_pk_hash',encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
               'source_row_sha256',encode(sha256(convert_to(t.canonical,'UTF8')),'hex'),
               'source_bytes_hex',encode(convert_to(t.canonical,'UTF8'),'hex'),
               'representation_kind','jsonb-canonical-v1',
               'target_table','restored_context_audit',
               'target_pk_canonical_jcs', jsonb_build_object('action_id',t.action_id,'operation_id',t.operation_id,'workspace_id',p_workspace_id)::text
             )
        FROM (
          SELECT jsonb_build_object('operation_id',ha.operation_id,'workspace_id',ha.workspace_id)::text AS pk,
                 ha.operation_id, ha.action_id,
                 jsonb_build_object(
                   'workspace_id',ha.workspace_id,'operation_id',ha.operation_id,'uid',ha.uid,'action_id',ha.action_id,
                   'direction',ha.direction,'created_at',to_char(ha.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 )::text AS canonical
            FROM public.history_audit ha
           WHERE ha.workspace_id = p_workspace_id AND ha.action_id = ANY(v_actions)
        ) t
      UNION ALL
      SELECT 'history_receipts', encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
             jsonb_build_object(
               'source_table','history_receipts','source_pk_canonical_jcs',t.pk,
               'source_pk_hash',encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
               'source_row_sha256',encode(sha256(convert_to(t.canonical,'UTF8')),'hex'),
               'source_bytes_hex',encode(convert_to(t.canonical,'UTF8'),'hex'),
               'representation_kind','jsonb-canonical-v1',
               'target_table','restored_context_receipts',
               'target_pk_canonical_jcs', jsonb_build_object('operation_id',t.operation_id,'workspace_id',p_workspace_id)::text
             )
        FROM (
          SELECT jsonb_build_object('operation_id',r.operation_id,'workspace_id',r.workspace_id)::text AS pk,
                 r.operation_id,
                 jsonb_build_object(
                   'workspace_id',r.workspace_id,'operation_id',r.operation_id,'uid',r.uid,
                   'request_hash',r.request_hash,'result',r.result
                 )::text AS canonical
            FROM public.history_receipts r
           WHERE r.workspace_id = p_workspace_id AND r.operation_id = ANY(v_history_actions)
        ) t
      UNION ALL
      SELECT 'workspace_service_audit', encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
             jsonb_build_object(
               'source_table','workspace_service_audit','source_pk_canonical_jcs',t.pk,
               'source_pk_hash',encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
               'source_row_sha256',encode(sha256(convert_to(t.canonical,'UTF8')),'hex'),
               'source_bytes_hex',encode(convert_to(t.canonical,'UTF8'),'hex'),
               'representation_kind','jsonb-canonical-v1',
               'target_table','restored_context_audit',
               'target_pk_canonical_jcs', jsonb_build_object('action_id',t.operation_id,'operation_id',t.operation_id,'workspace_id',p_workspace_id)::text
             )
        FROM (
          SELECT jsonb_build_object('operation_id',a.operation_id,'workspace_id',a.workspace_id)::text AS pk,
                 a.operation_id,
                 jsonb_build_object(
                   'workspace_id',a.workspace_id,'operation_id',a.operation_id,'uid',a.uid,'type',a.type,
                   'before_data',a.before_data,'after_data',a.after_data,'revision',a.revision,'undone',a.undone,
                   'dataset_epoch',a.dataset_epoch,
                   'created_at',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 )::text AS canonical
            FROM public.workspace_service_audit a
           WHERE a.workspace_id = p_workspace_id AND a.operation_id = ANY(v_report_actions)
        ) t
      UNION ALL
      SELECT 'workspace_service_receipts', encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
             jsonb_build_object(
               'source_table','workspace_service_receipts','source_pk_canonical_jcs',t.pk,
               'source_pk_hash',encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
               'source_row_sha256',encode(sha256(convert_to(t.canonical,'UTF8')),'hex'),
               'source_bytes_hex',encode(convert_to(t.canonical,'UTF8'),'hex'),
               'representation_kind','jsonb-canonical-v1',
               'target_table','restored_context_receipts',
               'target_pk_canonical_jcs', jsonb_build_object('operation_id',t.operation_id,'workspace_id',p_workspace_id)::text
             )
        FROM (
          SELECT jsonb_build_object('operation_id',r.operation_id,'workspace_id',r.workspace_id)::text AS pk,
                 r.operation_id,
                 jsonb_build_object(
                   'workspace_id',r.workspace_id,'operation_id',r.operation_id,'uid',r.uid,
                   'request_hash',r.request_hash,'result',r.result
                 )::text AS canonical
            FROM public.workspace_service_receipts r
           WHERE r.workspace_id = p_workspace_id AND r.operation_id = ANY(v_report_actions)
        ) t
      UNION ALL
      SELECT 'shift_operation_receipts', encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
             jsonb_build_object(
               'source_table','shift_operation_receipts','source_pk_canonical_jcs',t.pk,
               'source_pk_hash',encode(sha256(convert_to(t.pk,'UTF8')),'hex'),
               'source_row_sha256',encode(sha256(convert_to(t.canonical,'UTF8')),'hex'),
               'source_bytes_hex',encode(convert_to(t.canonical,'UTF8'),'hex'),
               'representation_kind','jsonb-canonical-v1',
               'target_table','restored_context_receipts',
               'target_pk_canonical_jcs', jsonb_build_object('operation_id',t.operation_id,'workspace_id',p_workspace_id)::text
             )
        FROM (
          SELECT jsonb_build_object('operation_id',r.operation_id,'workspace_id',r.workspace_id)::text AS pk,
                 r.operation_id,
                 jsonb_build_object(
                   'workspace_id',r.workspace_id,'operation_id',r.operation_id,'uid',r.uid,
                   'request_hash',r.request_hash,'result',r.result,
                   'recorded_at',to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 )::text AS canonical
            FROM public.shift_operation_receipts r
           WHERE r.workspace_id = p_workspace_id AND r.result->'shift'->>'id' = p_legacy_shift_id
        ) t
    ) ev;

  -- 11. Counts and aggregate roots: per source table and per target table.
  v_counts := jsonb_build_object(
    'shifts', 1,
    'line_logs', jsonb_array_length(v_logs),
    'line_truck_statuses', (SELECT count(*) FROM public.line_truck_statuses st
                             WHERE st.workspace_id = p_workspace_id AND st.shift_id = p_legacy_shift_id),
    'line_history', (SELECT count(*) FROM jsonb_array_elements(v_evidence_rows) e WHERE e->>'source_table'='line_history'),
    'line_audit', (SELECT count(*) FROM jsonb_array_elements(v_evidence_rows) e WHERE e->>'source_table'='line_audit'),
    'line_operation_receipts', (SELECT count(*) FROM jsonb_array_elements(v_evidence_rows) e WHERE e->>'source_table'='line_operation_receipts'),
    'history_audit', (SELECT count(*) FROM jsonb_array_elements(v_evidence_rows) e WHERE e->>'source_table'='history_audit'),
    'history_receipts', (SELECT count(*) FROM jsonb_array_elements(v_evidence_rows) e WHERE e->>'source_table'='history_receipts'),
    'workspace_service_audit', (SELECT count(*) FROM jsonb_array_elements(v_evidence_rows) e WHERE e->>'source_table'='workspace_service_audit'),
    'workspace_service_receipts', (SELECT count(*) FROM jsonb_array_elements(v_evidence_rows) e WHERE e->>'source_table'='workspace_service_receipts'),
    'shift_operation_receipts', (SELECT count(*) FROM jsonb_array_elements(v_evidence_rows) e WHERE e->>'source_table'='shift_operation_receipts')
  );
  v_target_counts := jsonb_build_object(
    'restored_context_logs', jsonb_array_length(v_logs),
    'restored_context_status_snapshots', jsonb_array_length(v_statuses),
    'restored_context_history', jsonb_array_length(v_history),
    'restored_context_receipts', jsonb_array_length(v_receipts),
    'restored_context_audit', jsonb_array_length(v_audits)
  );

  v_roots := jsonb_build_object(
    'shifts', encode(sha256(convert_to(COALESCE((
      SELECT string_agg(t.row_sha, ',' ORDER BY t.sort_key COLLATE "C")
        FROM (
          SELECT s.shift_id AS sort_key,
                 encode(sha256(convert_to(jsonb_build_object(
                   'shift_id',s.shift_id,'workspace_id',s.workspace_id,'state',s.state,
                   'is_active',s.is_active,'payload_schema_version',s.payload_schema_version,
                   'revision',s.revision,'payload',s.payload,
                   'identity_resolution',s.identity_resolution,'shift_type',s.shift_type,
                   'shift_type_resolution',s.shift_type_resolution,
                   'object_id',s.object_id,'object_name_snapshot',s.object_name_snapshot,
                   'work_date',to_char(s.work_date,'YYYY-MM-DD'),
                   'opened_at',to_char(s.opened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                   'opened_by_uid',s.opened_by_uid,'opened_by_name_snapshot',s.opened_by_name_snapshot
                 )::text,'UTF8')),'hex') AS row_sha
            FROM public.shifts s
           WHERE s.workspace_id = p_workspace_id AND s.shift_id = p_legacy_shift_id
        ) t),''),'UTF8')),'hex'),
    'line_logs', encode(sha256(convert_to(COALESCE((
      SELECT string_agg(t.row_sha, ',' ORDER BY t.sort_key COLLATE "C")
        FROM (
          SELECT l.log_id AS sort_key,
                 encode(sha256(convert_to(jsonb_build_object(
                   'log_id',l.log_id,'truck_id',l.truck_id,'payload',l.payload,
                   'log_revision',1,'source_log_id',l.log_id,
                   'created_from_archive_revision',p_base_archive_revision
                 )::text,'UTF8')),'hex') AS row_sha
            FROM public.line_logs l
           WHERE l.workspace_id = p_workspace_id AND l.shift_id = p_legacy_shift_id
        ) t),''),'UTF8')),'hex'),
    'line_truck_statuses', encode(sha256(convert_to(COALESCE((
      SELECT string_agg(t.row_sha, ',' ORDER BY t.sort_key COLLATE "C")
        FROM (
          SELECT st.truck_id AS sort_key,
                 encode(sha256(convert_to(jsonb_build_object(
                   'truck_id',st.truck_id,'payload',st.payload,
                   'status_revision',1,'cycle_revision',1,'ttn_revision',1
                 )::text,'UTF8')),'hex') AS row_sha
            FROM public.line_truck_statuses st
           WHERE st.workspace_id = p_workspace_id AND st.shift_id = p_legacy_shift_id
        ) t),''),'UTF8')),'hex'),
    'restored_context_logs', encode(sha256(convert_to(COALESCE((
      SELECT string_agg(t.row_sha, ',' ORDER BY t.sort_key COLLATE "C")
        FROM (
          SELECT e->>'log_id' AS sort_key,
                 encode(sha256(convert_to(jsonb_build_object(
                   'log_id',e->>'log_id','truck_id',e->>'truck_id','payload',e->'payload',
                   'log_revision',(e->>'log_revision')::bigint,'source_log_id',e->>'source_log_id',
                   'created_from_archive_revision',(e->>'created_from_archive_revision')::bigint
                 )::text,'UTF8')),'hex') AS row_sha
            FROM jsonb_array_elements(v_logs) e
        ) t),''),'UTF8')),'hex'),
    'restored_context_status_snapshots', encode(sha256(convert_to(COALESCE((
      SELECT string_agg(t.row_sha, ',' ORDER BY t.sort_key COLLATE "C")
        FROM (
          SELECT e->>'truck_id' AS sort_key,
                 encode(sha256(convert_to(jsonb_build_object(
                   'truck_id',e->>'truck_id','payload',e->'payload',
                   'status_revision',(e->>'status_revision')::bigint,
                   'cycle_revision',(e->>'cycle_revision')::bigint,
                   'ttn_revision',(e->>'ttn_revision')::bigint
                 )::text,'UTF8')),'hex') AS row_sha
            FROM jsonb_array_elements(v_statuses) e
        ) t),''),'UTF8')),'hex'),
    'restored_context_history', encode(sha256(convert_to(COALESCE((
      SELECT string_agg(t.row_sha, ',' ORDER BY t.sort_key COLLATE "C")
        FROM (
          SELECT e->>'action_id' AS sort_key,
                 encode(sha256(convert_to(jsonb_build_object(
                   'action_id',e->>'action_id','uid',e->>'uid','type',e->>'type',
                   'before_log',e->'before_log','after_log',e->'after_log',
                   'before_status_snapshot',e->'before_status_snapshot',
                   'after_status_snapshot',e->'after_status_snapshot',
                   'revision',(e->>'revision')::bigint,'undone',(e->>'undone')::boolean,
                   'created_at',e->>'created_at'
                 )::text,'UTF8')),'hex') AS row_sha
            FROM jsonb_array_elements(v_history) e
        ) t),''),'UTF8')),'hex'),
    'restored_context_receipts', encode(sha256(convert_to(COALESCE((
      SELECT string_agg(t.row_sha, ',' ORDER BY t.sort_key COLLATE "C")
        FROM (
          SELECT e->>'operation_id' AS sort_key,
                 encode(sha256(convert_to(jsonb_build_object(
                   'operation_id',e->>'operation_id','uid',e->>'uid',
                   'protocol_version',(e->>'protocol_version')::bigint,
                   'command_hash',e->>'command_hash','result',e->'result',
                   'recorded_at',e->>'recorded_at'
                 )::text,'UTF8')),'hex') AS row_sha
            FROM jsonb_array_elements(v_receipts) e
        ) t),''),'UTF8')),'hex'),
    'restored_context_audit', encode(sha256(convert_to(COALESCE((
      SELECT string_agg(t.row_sha, ',' ORDER BY t.sort_key COLLATE "C")
        FROM (
          SELECT (e->>'operation_id')||'/'||(e->>'type') AS sort_key,
                 encode(sha256(convert_to(jsonb_build_object(
                   'action_id',e->'action_id','operation_id',e->>'operation_id','uid',e->>'uid',
                   'type',e->>'type','before_state',e->'before_state','after_state',e->'after_state',
                   'recorded_at',e->>'recorded_at'
                 )::text,'UTF8')),'hex') AS row_sha
            FROM jsonb_array_elements(v_audits) e
        ) t),''),'UTF8')),'hex')
  );

  -- 12. Deterministic target identity: replay names the same context/evidence.
  v_seed := 'samosval.restored-context/v1|' || p_workspace_id || '|' || p_legacy_shift_id;
  v_context_id := 'rctx_' || substr(encode(sha256(convert_to(v_seed,'UTF8')),'hex'),1,40);
  v_seed := 'samosval.restored-context-evidence/v1|' || p_workspace_id || '|' || p_legacy_shift_id;
  v_seed := encode(sha256(convert_to(v_seed,'UTF8')),'hex');
  v_evidence_id := (substr(v_seed,1,8) || '-' || substr(v_seed,9,4) || '-5' || substr(v_seed,14,3)
                    || '-a' || substr(v_seed,18,3) || '-' || substr(v_seed,21,12))::uuid;

  v_archive := jsonb_build_object(
    'archiveId', p_archive_id,
    'baseArchiveRevision', p_base_archive_revision,
    'sourceShiftId', series_row.source_shift_id,
    'sourceLocator', revision_row.source_locator,
    'sourceBytesSha256', revision_row.payload_sha256
  );
  v_receipt := jsonb_build_object(
    'recordId', receipt_row.record_id,
    'location', receipt_row.location,
    'revision', receipt_row.revision
  );
  v_context := jsonb_build_object(
    'restored_context_id', v_context_id,
    'archive_id', p_archive_id,
    'source_shift_id', series_row.source_shift_id,
    'mode', v_mode,
    'context_state', 'open',
    'original_opened_by_uid', v_opened_uid,
    'original_opened_by_name_snapshot', v_opened_name,
    'original_identity_resolution', v_identity_resolution,
    'original_shift_type', v_shift_type,
    'original_shift_type_resolution', v_type_resolution,
    'restored_by_uid', v_restored_uid,
    'restored_by_name_snapshot', v_restored_name,
    'restored_at', to_char(v_restored_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'archive_revision', p_base_archive_revision,
    'context_revision', 1,
    'restore_operation_id', p_migration_operation_id,
    'source_state_snapshot', archive_doc,
    'source_shift_revision', shift_row.revision,
    'opened_at_snapshot', to_char(shift_row.opened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'object_id', shift_row.object_id,
    'object_name', shift_row.object_name_snapshot,
    'work_date', to_char(shift_row.work_date,'YYYY-MM-DD')
  );

  -- 13. Exact closure hash: archive identity, receipt, context identity, counts,
  -- roots and every evidence locator/hash. Any byte changes it.
  v_closure := jsonb_build_object(
    'schema','samosval.restored-context-migration-closure/v1',
    'workspaceId', p_workspace_id,
    'legacyShiftId', p_legacy_shift_id,
    'contextId', v_context_id,
    'mode', v_mode,
    'archive', v_archive,
    'receipt', v_receipt,
    'original', jsonb_build_object(
      'openedByUid', v_opened_uid,
      'openedByNameSnapshot', v_opened_name,
      'identityResolution', v_identity_resolution,
      'shiftType', v_shift_type,
      'shiftTypeResolution', v_type_resolution
    ),
    'restored', jsonb_build_object(
      'uid', v_restored_uid,
      'name', v_restored_name,
      'at', to_char(v_restored_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ),
    'counts', v_counts,
    'roots', v_roots,
    'targetCounts', v_target_counts,
    'evidenceRows', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'sourceTable', e->>'source_table',
        'sourcePkHash', e->>'source_pk_hash',
        'sourceRowSha256', e->>'source_row_sha256',
        'targetTable', e->>'target_table',
        'targetPkHash', encode(sha256(convert_to(e->>'target_pk_canonical_jcs','UTF8')),'hex')
      ) ORDER BY (e->>'source_table') COLLATE "C", (e->>'source_pk_hash') COLLATE "C"), '[]'::jsonb)
      FROM jsonb_array_elements(v_evidence_rows) e)
  );
  v_closure_hash := encode(sha256(convert_to(v_closure::text,'UTF8')),'hex');

  v_manifest := jsonb_build_object(
    'schema','samosval.restored-context-migration/v1',
    'workspaceId', p_workspace_id,
    'migrationOperationId', p_migration_operation_id,
    'legacyShiftId', p_legacy_shift_id,
    'mode', v_mode,
    'contextId', v_context_id,
    'evidenceId', v_evidence_id::text,
    'archive', v_archive,
    'receipt', v_receipt,
    'original', v_closure->'original',
    'restored', v_closure->'restored',
    'counts', v_counts,
    'roots', v_roots,
    'targetCounts', v_target_counts,
    'evidenceRows', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'sourceTable', e->>'source_table',
        'sourcePkHash', e->>'source_pk_hash',
        'sourceRowSha256', e->>'source_row_sha256',
        'targetTable', e->>'target_table',
        'targetPkHash', encode(sha256(convert_to(e->>'target_pk_canonical_jcs','UTF8')),'hex')
      ) ORDER BY (e->>'source_table') COLLATE "C", (e->>'source_pk_hash') COLLATE "C"), '[]'::jsonb)
      FROM jsonb_array_elements(v_evidence_rows) e),
    'closureHash', v_closure_hash
  );

  RETURN jsonb_build_object(
    'manifest', v_manifest,
    'closureHash', v_closure_hash,
    'contextId', v_context_id,
    'evidenceId', v_evidence_id::text,
    'context', v_context,
    'logs', v_logs,
    'statuses', v_statuses,
    'history', v_history,
    'receipts', v_receipts,
    'audits', v_audits,
    'evidenceRows', v_evidence_rows,
    'counts', v_counts,
    'targetCounts', v_target_counts,
    'roots', v_roots,
    'receiptTarget', v_receipt,
    'delete', jsonb_build_object(
      'line_logs', (SELECT COALESCE(jsonb_agg(l.log_id ORDER BY l.log_id COLLATE "C"),'[]'::jsonb)
                      FROM public.line_logs l
                     WHERE l.workspace_id = p_workspace_id AND l.shift_id = p_legacy_shift_id),
      'line_truck_statuses', (SELECT COALESCE(jsonb_agg(st.truck_id ORDER BY st.truck_id COLLATE "C"),'[]'::jsonb)
                      FROM public.line_truck_statuses st
                     WHERE st.workspace_id = p_workspace_id AND st.shift_id = p_legacy_shift_id),
      'line_history', (SELECT COALESCE(jsonb_agg(lh.action_id ORDER BY lh.action_id COLLATE "C"),'[]'::jsonb)
                      FROM public.line_history lh
                     WHERE lh.workspace_id = p_workspace_id AND lh.shift_id = p_legacy_shift_id),
      'line_audit', (SELECT COALESCE(jsonb_agg(a.operation_id ORDER BY a.operation_id COLLATE "C"),'[]'::jsonb)
                      FROM public.line_audit a
                     WHERE a.workspace_id = p_workspace_id AND a.operation_id = ANY(v_actions)),
      'line_operation_receipts', (SELECT COALESCE(jsonb_agg(r.operation_id ORDER BY r.operation_id COLLATE "C"),'[]'::jsonb)
                      FROM public.line_operation_receipts r
                     WHERE r.workspace_id = p_workspace_id AND r.operation_id = ANY(v_actions)),
      'history_audit', (SELECT COALESCE(jsonb_agg(ha.operation_id ORDER BY ha.operation_id COLLATE "C"),'[]'::jsonb)
                      FROM public.history_audit ha
                     WHERE ha.workspace_id = p_workspace_id AND ha.action_id = ANY(v_actions)),
      'history_receipts', (SELECT COALESCE(jsonb_agg(r.operation_id ORDER BY r.operation_id COLLATE "C"),'[]'::jsonb)
                      FROM public.history_receipts r
                     WHERE r.workspace_id = p_workspace_id AND r.operation_id = ANY(v_history_actions)),
      'workspace_service_audit', (SELECT COALESCE(jsonb_agg(a.operation_id ORDER BY a.operation_id COLLATE "C"),'[]'::jsonb)
                      FROM public.workspace_service_audit a
                     WHERE a.workspace_id = p_workspace_id AND a.operation_id = ANY(v_report_actions)),
      'workspace_service_receipts', (SELECT COALESCE(jsonb_agg(r.operation_id ORDER BY r.operation_id COLLATE "C"),'[]'::jsonb)
                      FROM public.workspace_service_receipts r
                     WHERE r.workspace_id = p_workspace_id AND r.operation_id = ANY(v_report_actions)),
      'shift_operation_receipts', (SELECT COALESCE(jsonb_agg(r.operation_id ORDER BY r.operation_id COLLATE "C"),'[]'::jsonb)
                      FROM public.shift_operation_receipts r
                     WHERE r.workspace_id = p_workspace_id AND r.result->'shift'->>'id' = p_legacy_shift_id)
    )
  );
END
$restored_plan$;

-- Public manifest entrypoint: exactly the hash-only manifest of the plan above.
CREATE OR REPLACE FUNCTION public.restored_context_source_manifest(
  p_workspace_id text,
  p_legacy_shift_id text,
  p_archive_id text,
  p_base_archive_revision bigint,
  p_migration_operation_id text
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $restored_manifest$
  SELECT public.restored_context_migration_plan(
    p_workspace_id, p_legacy_shift_id, p_archive_id, p_base_archive_revision, p_migration_operation_id
  )->'manifest'::text
$restored_manifest$;

-- ----------------------------------------------------------------------------
-- The single exact mutation entrypoint. It accepts only a manifest built by the
-- function above for the same locator; every identifier is a literal in the body
-- and the only trigger it disables is named below.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.migrate_legacy_restored_context_exact(
  p_workspace_id text,
  p_manifest jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $restored_migrate$
DECLARE
  v_legacy_shift_id text;
  v_archive_id text;
  v_base_revision bigint;
  v_operation_id text;
  v_plan jsonb;
  v_context jsonb;
  v_context_id text;
  v_evidence_id uuid;
  v_closure_hash text;
  v_existing record;
  v_count int;
  v_expected int;
  v_root text;
  v_trigger_state "char";
  v_seed text;
BEGIN
  -- 0. Envelope. No identifier, table or trigger name is ever taken from here.
  IF p_manifest IS NULL OR jsonb_typeof(p_manifest) <> 'object' THEN
    RAISE EXCEPTION 'migration-manifest-invalid: a manifest object is required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_manifest->>'schema' IS DISTINCT FROM 'samosval.restored-context-migration/v1' THEN
    RAISE EXCEPTION 'migration-manifest-invalid: unsupported manifest schema %', COALESCE(p_manifest->>'schema','missing')
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_manifest->>'workspaceId' IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'migration-workspace-mismatch: manifest names workspace %, caller names %',
      COALESCE(p_manifest->>'workspaceId','missing'), COALESCE(p_workspace_id,'missing')
      USING ERRCODE = 'check_violation';
  END IF;
  v_legacy_shift_id := p_manifest->>'legacyShiftId';
  v_archive_id := p_manifest->'archive'->>'archiveId';
  v_operation_id := p_manifest->>'migrationOperationId';
  IF v_legacy_shift_id IS NULL OR v_archive_id IS NULL OR v_operation_id IS NULL
     OR jsonb_typeof(p_manifest->'archive'->'baseArchiveRevision') IS DISTINCT FROM 'number'
     OR p_manifest->>'evidenceId' IS NULL OR p_manifest->>'closureHash' IS NULL THEN
    RAISE EXCEPTION 'migration-manifest-invalid: manifest is missing its exact locator'
      USING ERRCODE = 'check_violation';
  END IF;
  v_base_revision := (p_manifest->'archive'->>'baseArchiveRevision')::bigint;
  IF v_operation_id !~ '^[A-Za-z0-9_-]{1,160}$'
     OR p_manifest->>'evidenceId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p_manifest->>'closureHash' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'migration-manifest-invalid: migration identity is not well formed'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The evidence allow-list is closed: an arbitrary source/target table is refused
  -- before anything is read, and every row entry must be exactly this shape.
  IF jsonb_typeof(COALESCE(p_manifest->'evidenceRows','[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'migration-manifest-invalid: evidenceRows must be an array'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(p_manifest->'evidenceRows','[]'::jsonb)) e
     WHERE jsonb_typeof(e) <> 'object'
        OR e->>'sourceTable' IS NULL OR e->>'sourceTable' NOT IN (
             'workspace_service_audit','workspace_service_receipts','line_audit','line_operation_receipts',
             'line_history','history_audit','history_receipts','shift_operation_receipts')
        OR e->>'targetTable' IS NULL OR e->>'targetTable' NOT IN (
             'restored_context_audit','restored_context_receipts','restored_context_history')
        OR e->>'sourcePkHash' IS NULL OR e->>'sourcePkHash' !~ '^[0-9a-f]{64}$'
        OR e->>'sourceRowSha256' IS NULL OR e->>'sourceRowSha256' !~ '^[0-9a-f]{64}$'
        OR e->>'targetPkHash' IS NULL OR e->>'targetPkHash' !~ '^[0-9a-f]{64}$'
        OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 5
  ) THEN
    RAISE EXCEPTION 'migration-source-table-not-allowed: the manifest names a table or row outside the versioned allow-list'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 1. Advisory lock: serialization only, never authorization.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'samosval.restored-context-migration/v1|' || p_workspace_id || '|' || v_legacy_shift_id, 0));

  -- 2. Replay or refuse. The target identity is deterministic, so a second call
  -- with the same manifest is an exact replay only after the source is gone.
  v_evidence_id := (p_manifest->>'evidenceId')::uuid;
  SELECT * INTO v_existing FROM public.restored_context_migration_evidence e
   WHERE e.workspace_id = p_workspace_id AND e.evidence_id = v_evidence_id;
  IF FOUND THEN
    IF v_existing.closure_hash IS DISTINCT FROM p_manifest->>'closureHash' THEN
      RAISE EXCEPTION 'migration-already-applied-different-manifest: evidence % has another closure', v_evidence_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.shifts s
                WHERE s.workspace_id = p_workspace_id AND s.shift_id = v_legacy_shift_id)
       OR EXISTS (SELECT 1 FROM public.line_logs l
                   WHERE l.workspace_id = p_workspace_id AND l.shift_id = v_legacy_shift_id)
       OR EXISTS (SELECT 1 FROM public.line_truck_statuses st
                   WHERE st.workspace_id = p_workspace_id AND st.shift_id = v_legacy_shift_id) THEN
      RAISE EXCEPTION 'migration-double-authority: source of % is still present beside its context', v_legacy_shift_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN jsonb_build_object(
      'outcome','replayed',
      'evidenceId', v_evidence_id::text,
      'restoredContextId', v_existing.migrated_context_id,
      'archiveId', v_existing.archive_id,
      'baseArchiveRevision', v_existing.base_archive_revision,
      'closureHash', v_existing.closure_hash,
      'migrationOperationId', v_existing.migration_operation_id
    );
  END IF;

  -- 3. Lock source rows in table allow-list order, then canonical PK order.
  PERFORM 1 FROM public.shifts s
   WHERE s.workspace_id = p_workspace_id AND s.shift_id = v_legacy_shift_id
   FOR UPDATE;
  PERFORM 1 FROM public.line_logs l
   WHERE l.workspace_id = p_workspace_id AND l.shift_id = v_legacy_shift_id
   ORDER BY l.log_id COLLATE "C" FOR UPDATE;
  PERFORM 1 FROM public.line_truck_statuses st
   WHERE st.workspace_id = p_workspace_id AND st.shift_id = v_legacy_shift_id
   ORDER BY st.truck_id COLLATE "C" FOR UPDATE;
  PERFORM 1 FROM public.line_history lh
   WHERE lh.workspace_id = p_workspace_id AND lh.shift_id = v_legacy_shift_id
   ORDER BY lh.action_id COLLATE "C" FOR UPDATE;
  PERFORM 1 FROM public.line_audit a
   WHERE a.workspace_id = p_workspace_id
     AND a.operation_id = ANY(ARRAY(SELECT lh.action_id FROM public.line_history lh
                                     WHERE lh.workspace_id = p_workspace_id AND lh.shift_id = v_legacy_shift_id))
   ORDER BY a.operation_id COLLATE "C" FOR UPDATE;
  PERFORM 1 FROM public.line_operation_receipts r
   WHERE r.workspace_id = p_workspace_id
     AND r.operation_id = ANY(ARRAY(SELECT lh.action_id FROM public.line_history lh
                                     WHERE lh.workspace_id = p_workspace_id AND lh.shift_id = v_legacy_shift_id))
   ORDER BY r.operation_id COLLATE "C" FOR UPDATE;
  PERFORM 1 FROM public.history_audit ha
   WHERE ha.workspace_id = p_workspace_id
     AND ha.action_id = ANY(ARRAY(SELECT lh.action_id FROM public.line_history lh
                                   WHERE lh.workspace_id = p_workspace_id AND lh.shift_id = v_legacy_shift_id))
   ORDER BY ha.operation_id COLLATE "C" FOR UPDATE;
  PERFORM 1 FROM public.history_receipts r
   WHERE r.workspace_id = p_workspace_id
     AND r.operation_id = ANY(ARRAY(SELECT ha.operation_id FROM public.history_audit ha
                                     WHERE ha.workspace_id = p_workspace_id
                                       AND ha.action_id = ANY(ARRAY(SELECT lh.action_id FROM public.line_history lh
                                                                     WHERE lh.workspace_id = p_workspace_id
                                                                       AND lh.shift_id = v_legacy_shift_id))))
   ORDER BY r.operation_id COLLATE "C" FOR UPDATE;
  PERFORM 1 FROM public.workspace_service_audit a
   WHERE a.workspace_id = p_workspace_id
     AND a.type IN ('report.update','report.delete')
     AND (a.before_data->>'shiftId' = v_legacy_shift_id OR a.after_data->>'shiftId' = v_legacy_shift_id)
   ORDER BY a.operation_id COLLATE "C" FOR UPDATE;
  PERFORM 1 FROM public.workspace_service_receipts r
   WHERE r.workspace_id = p_workspace_id
     AND r.operation_id = ANY(ARRAY(SELECT a.operation_id FROM public.workspace_service_audit a
                                     WHERE a.workspace_id = p_workspace_id
                                       AND a.type IN ('report.update','report.delete')
                                       AND (a.before_data->>'shiftId' = v_legacy_shift_id
                                            OR a.after_data->>'shiftId' = v_legacy_shift_id)))
   ORDER BY r.operation_id COLLATE "C" FOR UPDATE;
  PERFORM 1 FROM public.shift_operation_receipts r
   WHERE r.workspace_id = p_workspace_id AND r.result->'shift'->>'id' = v_legacy_shift_id
   ORDER BY r.operation_id COLLATE "C" FOR UPDATE;
  PERFORM 1 FROM public.archive_overrides o
   WHERE o.workspace_id = p_workspace_id
     AND o.record_id = COALESCE(p_manifest->'receipt'->>'recordId','')
   FOR UPDATE;

  -- 4. Rebuild the plan from the locked rows and require the exact manifest.
  v_plan := public.restored_context_migration_plan(
    p_workspace_id, v_legacy_shift_id, v_archive_id, v_base_revision, v_operation_id);
  IF v_plan->'manifest' IS DISTINCT FROM p_manifest THEN
    RAISE EXCEPTION 'migration-manifest-mismatch: the locked source rows no longer match the manifest'
      USING ERRCODE = 'check_violation';
  END IF;
  v_context_id := v_plan->>'contextId';
  v_closure_hash := v_plan->>'closureHash';
  v_context := v_plan->'context';

  -- 5. Double authority is refused before any write.
  IF EXISTS (SELECT 1 FROM public.restored_context_migration_evidence e
              WHERE e.workspace_id = p_workspace_id AND e.legacy_shift_id = v_legacy_shift_id) THEN
    RAISE EXCEPTION 'migration-double-authority: legacy shift % already has a migration evidence', v_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.restored_context_migration_evidence e
              WHERE e.workspace_id = p_workspace_id
                AND e.source_locator = v_plan->'manifest'->'archive'->>'sourceLocator') THEN
    RAISE EXCEPTION 'migration-locator-claimed: source locator % already backs another evidence',
      v_plan->'manifest'->'archive'->>'sourceLocator'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.restored_shift_contexts c
              WHERE c.workspace_id = p_workspace_id AND c.restored_context_id = v_context_id) THEN
    RAISE EXCEPTION 'migration-double-authority: context % already exists', v_context_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.restored_shift_contexts c
              WHERE c.workspace_id = p_workspace_id AND c.archive_id = v_archive_id
                AND c.context_state = 'open') THEN
    RAISE EXCEPTION 'migration-double-authority: archive % already has an open restored context', v_archive_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.restored_context_logs rl
      JOIN jsonb_array_elements(v_plan->'logs') x ON x->>'log_id' = rl.source_log_id
     WHERE rl.workspace_id = p_workspace_id) THEN
    RAISE EXCEPTION 'migration-double-authority: a source trip of % already lives in a restored context', v_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 6. Copy: context, then its dedicated children. Every value comes from the
  -- verified plan, never from the manifest itself.
  INSERT INTO public.restored_shift_contexts(
    workspace_id, restored_context_id, archive_id, source_shift_id, mode, context_state,
    original_opened_by_uid, original_opened_by_name_snapshot, original_identity_resolution,
    original_shift_type, original_shift_type_resolution,
    restored_by_uid, restored_by_name_snapshot, restored_at,
    archive_revision, context_revision, restore_operation_id,
    source_state_snapshot, source_shift_revision, opened_at_snapshot,
    object_id, object_name, work_date)
  VALUES (
    p_workspace_id, v_context_id, v_archive_id, v_context->>'source_shift_id',
    v_context->>'mode', 'open',
    v_context->>'original_opened_by_uid', v_context->>'original_opened_by_name_snapshot',
    v_context->>'original_identity_resolution',
    v_context->>'original_shift_type', v_context->>'original_shift_type_resolution',
    v_context->>'restored_by_uid', v_context->>'restored_by_name_snapshot',
    (v_context->>'restored_at')::timestamptz,
    v_base_revision, 1, v_operation_id,
    v_context->'source_state_snapshot', (v_context->>'source_shift_revision')::bigint,
    (v_context->>'opened_at_snapshot')::timestamptz,
    v_context->>'object_id', v_context->>'object_name', (v_context->>'work_date')::date);

  INSERT INTO public.restored_context_logs(
    workspace_id, restored_context_id, log_id, truck_id, payload, log_revision,
    source_log_id, created_from_archive_revision)
  SELECT p_workspace_id, v_context_id, x.log_id, x.truck_id, x.payload, x.log_revision,
         x.source_log_id, x.created_from_archive_revision
    FROM jsonb_to_recordset(v_plan->'logs') AS x(
      log_id text, truck_id text, payload jsonb, log_revision bigint,
      source_log_id text, created_from_archive_revision bigint);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_expected := (v_plan->'targetCounts'->>'restored_context_logs')::int;
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'migration-copy-count-mismatch: copied % trips of %, expected %', v_count, v_legacy_shift_id, v_expected
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.restored_context_status_snapshots(
    workspace_id, restored_context_id, truck_id, payload,
    status_revision, cycle_revision, ttn_revision)
  SELECT p_workspace_id, v_context_id, x.truck_id, x.payload,
         x.status_revision, x.cycle_revision, x.ttn_revision
    FROM jsonb_to_recordset(v_plan->'statuses') AS x(
      truck_id text, payload jsonb, status_revision bigint, cycle_revision bigint, ttn_revision bigint);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_expected := (v_plan->'targetCounts'->>'restored_context_status_snapshots')::int;
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'migration-copy-count-mismatch: copied % status snapshots of %, expected %',
      v_count, v_legacy_shift_id, v_expected
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.restored_context_history(
    workspace_id, action_id, restored_context_id, uid, type,
    before_log, after_log, before_status_snapshot, after_status_snapshot,
    revision, undone, created_at)
  SELECT p_workspace_id, x.action_id, v_context_id, x.uid, x.type,
         x.before_log, x.after_log, x.before_status_snapshot, x.after_status_snapshot,
         x.revision, x.undone, (x.created_at)::timestamptz
    FROM jsonb_to_recordset(v_plan->'history') AS x(
      action_id text, uid text, type text, before_log jsonb, after_log jsonb,
      before_status_snapshot jsonb, after_status_snapshot jsonb,
      revision bigint, undone boolean, created_at text);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_expected := (v_plan->'targetCounts'->>'restored_context_history')::int;
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'migration-copy-count-mismatch: copied % history rows of %, expected %',
      v_count, v_legacy_shift_id, v_expected
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.restored_context_receipts(
    workspace_id, operation_id, restored_context_id, uid,
    protocol_version, command_hash, result, recorded_at)
  SELECT p_workspace_id, x.operation_id, v_context_id, x.uid,
         x.protocol_version, x.command_hash, x.result, (x.recorded_at)::timestamptz
    FROM jsonb_to_recordset(v_plan->'receipts') AS x(
      operation_id text, uid text, protocol_version smallint, command_hash text,
      result jsonb, recorded_at text);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_expected := (v_plan->'targetCounts'->>'restored_context_receipts')::int;
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'migration-copy-count-mismatch: copied % receipts of %, expected %',
      v_count, v_legacy_shift_id, v_expected
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.restored_context_audit(
    workspace_id, restored_context_id, action_id, operation_id, uid, type,
    before_state, after_state, recorded_at)
  SELECT p_workspace_id, v_context_id, x.action_id, x.operation_id, x.uid, x.type,
         x.before_state, x.after_state, (x.recorded_at)::timestamptz
    FROM jsonb_to_recordset(v_plan->'audits') AS x(
      action_id text, operation_id text, uid text, type text,
      before_state jsonb, after_state jsonb, recorded_at text);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_expected := (v_plan->'targetCounts'->>'restored_context_audit')::int;
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'migration-copy-count-mismatch: copied % audit rows of %, expected %',
      v_count, v_legacy_shift_id, v_expected
      USING ERRCODE = 'check_violation';
  END IF;

  -- 7. Evidence: parent first, then one child row per migrated append-only row
  -- through the exact parent FK. `restored_context_id` is deliberately absent.
  INSERT INTO public.restored_context_migration_evidence(
    workspace_id, evidence_id, legacy_shift_id, archive_id, base_archive_revision,
    source_locator, source_bytes_sha256, source_counts, source_table_roots,
    closure_hash, migrated_context_id, migration_operation_id)
  VALUES (
    p_workspace_id, v_evidence_id, v_legacy_shift_id, v_archive_id, v_base_revision,
    v_plan->'manifest'->'archive'->>'sourceLocator', v_plan->'manifest'->'archive'->>'sourceBytesSha256',
    v_plan->'counts', v_plan->'roots', v_closure_hash, v_context_id, v_operation_id);

  INSERT INTO public.restored_context_migration_evidence_rows(
    workspace_id, evidence_id, source_table, source_pk_canonical_jcs, source_pk_hash,
    source_row_sha256, source_bytes, representation_kind, target_table, target_pk_canonical_jcs)
  SELECT p_workspace_id, v_evidence_id, x.source_table, x.source_pk_canonical_jcs,
         x.source_pk_hash, x.source_row_sha256, decode(x.source_bytes_hex,'hex'),
         x.representation_kind, x.target_table, x.target_pk_canonical_jcs
    FROM jsonb_to_recordset(v_plan->'evidenceRows') AS x(
      source_table text, source_pk_canonical_jcs text, source_pk_hash text,
      source_row_sha256 text, source_bytes_hex text, representation_kind text,
      target_table text, target_pk_canonical_jcs text);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_expected := jsonb_array_length(v_plan->'evidenceRows');
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'migration-evidence-count-mismatch: wrote % evidence rows, expected %', v_count, v_expected
      USING ERRCODE = 'check_violation';
  END IF;

  -- 8. Verify every copied set against the plan: count and aggregate root.
  SELECT count(*)::int INTO v_count FROM public.restored_context_logs rl
   WHERE rl.workspace_id = p_workspace_id AND rl.restored_context_id = v_context_id;
  IF v_count <> (v_plan->'targetCounts'->>'restored_context_logs')::int THEN
    RAISE EXCEPTION 'migration-copy-count-mismatch: stored trips of % are %', v_context_id, v_count
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT encode(sha256(convert_to(COALESCE(string_agg(t.row_sha, ',' ORDER BY t.sort_key COLLATE "C"),''),'UTF8')),'hex')
    INTO v_root
    FROM (SELECT rl.log_id AS sort_key,
                 encode(sha256(convert_to(jsonb_build_object(
                   'log_id',rl.log_id,'truck_id',rl.truck_id,'payload',rl.payload,
                   'log_revision',rl.log_revision,'source_log_id',rl.source_log_id,
                   'created_from_archive_revision',rl.created_from_archive_revision
                 )::text,'UTF8')),'hex') AS row_sha
            FROM public.restored_context_logs rl
           WHERE rl.workspace_id = p_workspace_id AND rl.restored_context_id = v_context_id) t;
  IF v_root IS DISTINCT FROM v_plan->'roots'->>'restored_context_logs' THEN
    RAISE EXCEPTION 'migration-copy-root-mismatch: restored trips of % differ from the plan', v_context_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT encode(sha256(convert_to(COALESCE(string_agg(t.row_sha, ',' ORDER BY t.sort_key COLLATE "C"),''),'UTF8')),'hex')
    INTO v_root
    FROM (SELECT st.truck_id AS sort_key,
                 encode(sha256(convert_to(jsonb_build_object(
                   'truck_id',st.truck_id,'payload',st.payload,
                   'status_revision',st.status_revision,'cycle_revision',st.cycle_revision,
                   'ttn_revision',st.ttn_revision
                 )::text,'UTF8')),'hex') AS row_sha
            FROM public.restored_context_status_snapshots st
           WHERE st.workspace_id = p_workspace_id AND st.restored_context_id = v_context_id) t;
  IF v_root IS DISTINCT FROM v_plan->'roots'->>'restored_context_status_snapshots' THEN
    RAISE EXCEPTION 'migration-copy-root-mismatch: status snapshots of % differ from the plan', v_context_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT encode(sha256(convert_to(COALESCE(string_agg(t.row_sha, ',' ORDER BY t.sort_key COLLATE "C"),''),'UTF8')),'hex')
    INTO v_root
    FROM (SELECT h.action_id AS sort_key,
                 encode(sha256(convert_to(jsonb_build_object(
                   'action_id',h.action_id,'uid',h.uid,'type',h.type,
                   'before_log',h.before_log,'after_log',h.after_log,
                   'before_status_snapshot',h.before_status_snapshot,
                   'after_status_snapshot',h.after_status_snapshot,
                   'revision',h.revision,'undone',h.undone,
                   'created_at',to_char(h.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 )::text,'UTF8')),'hex') AS row_sha
            FROM public.restored_context_history h
           WHERE h.workspace_id = p_workspace_id AND h.restored_context_id = v_context_id) t;
  IF v_root IS DISTINCT FROM v_plan->'roots'->>'restored_context_history' THEN
    RAISE EXCEPTION 'migration-copy-root-mismatch: restored history of % differs from the plan', v_context_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT encode(sha256(convert_to(COALESCE(string_agg(t.row_sha, ',' ORDER BY t.sort_key COLLATE "C"),''),'UTF8')),'hex')
    INTO v_root
    FROM (SELECT r.operation_id AS sort_key,
                 encode(sha256(convert_to(jsonb_build_object(
                   'operation_id',r.operation_id,'uid',r.uid,'protocol_version',r.protocol_version,
                   'command_hash',r.command_hash,'result',r.result,
                   'recorded_at',to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 )::text,'UTF8')),'hex') AS row_sha
            FROM public.restored_context_receipts r
           WHERE r.workspace_id = p_workspace_id AND r.restored_context_id = v_context_id) t;
  IF v_root IS DISTINCT FROM v_plan->'roots'->>'restored_context_receipts' THEN
    RAISE EXCEPTION 'migration-copy-root-mismatch: restored receipts of % differ from the plan', v_context_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT encode(sha256(convert_to(COALESCE(string_agg(t.row_sha, ',' ORDER BY t.sort_key COLLATE "C"),''),'UTF8')),'hex')
    INTO v_root
    FROM (SELECT (a.operation_id)||'/'||(a.type) AS sort_key,
                 encode(sha256(convert_to(jsonb_build_object(
                   'action_id',a.action_id,'operation_id',a.operation_id,'uid',a.uid,
                   'type',a.type,'before_state',a.before_state,'after_state',a.after_state,
                   'recorded_at',to_char(a.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 )::text,'UTF8')),'hex') AS row_sha
            FROM public.restored_context_audit a
           WHERE a.workspace_id = p_workspace_id AND a.restored_context_id = v_context_id) t;
  IF v_root IS DISTINCT FROM v_plan->'roots'->>'restored_context_audit' THEN
    RAISE EXCEPTION 'migration-copy-root-mismatch: restored audit of % differs from the plan', v_context_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Parent -> context consistency and evidence completeness.
  IF NOT EXISTS (SELECT 1 FROM public.restored_context_migration_evidence e
                  WHERE e.workspace_id = p_workspace_id AND e.evidence_id = v_evidence_id
                    AND e.migrated_context_id = v_context_id AND e.closure_hash = v_closure_hash) THEN
    RAISE EXCEPTION 'migration-evidence-gap: evidence % does not close context %', v_evidence_id, v_context_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 9. Close the legacy restore receipt under the named guard. The guard is
  -- disabled for exactly this statement and re-enabled in the same transaction,
  -- so any failure below rolls both the placement and the trigger state back.
  ALTER TABLE public.archive_overrides DISABLE TRIGGER archive_overrides_restored_receipt_immutable;
  UPDATE public.archive_overrides o
     SET location = 'archive', revision = o.revision + 1
   WHERE o.workspace_id = p_workspace_id
     AND o.record_id = v_plan->'receiptTarget'->>'recordId'
     AND o.location = 'restored'
     AND o.revision = (v_plan->'receiptTarget'->>'revision')::bigint;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'migration-receipt-changed: the legacy restore receipt of % changed during the migration', v_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  ALTER TABLE public.archive_overrides ENABLE TRIGGER archive_overrides_restored_receipt_immutable;

  -- 10. Exact source delete, children first, synthetic shift anchor last.
  DELETE FROM public.line_audit a
   USING jsonb_array_elements_text(v_plan->'delete'->'line_audit') k(operation_id)
   WHERE a.workspace_id = p_workspace_id AND a.operation_id = k.operation_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (v_plan->'counts'->>'line_audit')::int THEN
    RAISE EXCEPTION 'migration-delete-count-mismatch: deleted % line_audit rows, expected %',
      v_count, v_plan->'counts'->>'line_audit'
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM public.line_operation_receipts r
   USING jsonb_array_elements_text(v_plan->'delete'->'line_operation_receipts') k(operation_id)
   WHERE r.workspace_id = p_workspace_id AND r.operation_id = k.operation_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (v_plan->'counts'->>'line_operation_receipts')::int THEN
    RAISE EXCEPTION 'migration-delete-count-mismatch: deleted % line receipts, expected %',
      v_count, v_plan->'counts'->>'line_operation_receipts'
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM public.history_audit ha
   USING jsonb_array_elements_text(v_plan->'delete'->'history_audit') k(operation_id)
   WHERE ha.workspace_id = p_workspace_id AND ha.operation_id = k.operation_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (v_plan->'counts'->>'history_audit')::int THEN
    RAISE EXCEPTION 'migration-delete-count-mismatch: deleted % history audit rows, expected %',
      v_count, v_plan->'counts'->>'history_audit'
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM public.history_receipts r
   USING jsonb_array_elements_text(v_plan->'delete'->'history_receipts') k(operation_id)
   WHERE r.workspace_id = p_workspace_id AND r.operation_id = k.operation_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (v_plan->'counts'->>'history_receipts')::int THEN
    RAISE EXCEPTION 'migration-delete-count-mismatch: deleted % history receipts, expected %',
      v_count, v_plan->'counts'->>'history_receipts'
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM public.workspace_service_audit a
   USING jsonb_array_elements_text(v_plan->'delete'->'workspace_service_audit') k(operation_id)
   WHERE a.workspace_id = p_workspace_id AND a.operation_id = k.operation_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (v_plan->'counts'->>'workspace_service_audit')::int THEN
    RAISE EXCEPTION 'migration-delete-count-mismatch: deleted % report audit rows, expected %',
      v_count, v_plan->'counts'->>'workspace_service_audit'
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM public.workspace_service_receipts r
   USING jsonb_array_elements_text(v_plan->'delete'->'workspace_service_receipts') k(operation_id)
   WHERE r.workspace_id = p_workspace_id AND r.operation_id = k.operation_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (v_plan->'counts'->>'workspace_service_receipts')::int THEN
    RAISE EXCEPTION 'migration-delete-count-mismatch: deleted % report receipts, expected %',
      v_count, v_plan->'counts'->>'workspace_service_receipts'
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM public.shift_operation_receipts r
   USING jsonb_array_elements_text(v_plan->'delete'->'shift_operation_receipts') k(operation_id)
   WHERE r.workspace_id = p_workspace_id AND r.operation_id = k.operation_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (v_plan->'counts'->>'shift_operation_receipts')::int THEN
    RAISE EXCEPTION 'migration-delete-count-mismatch: deleted % shift receipts, expected %',
      v_count, v_plan->'counts'->>'shift_operation_receipts'
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM public.line_history lh
   USING jsonb_array_elements_text(v_plan->'delete'->'line_history') k(action_id)
   WHERE lh.workspace_id = p_workspace_id AND lh.action_id = k.action_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (v_plan->'counts'->>'line_history')::int THEN
    RAISE EXCEPTION 'migration-delete-count-mismatch: deleted % history rows, expected %',
      v_count, v_plan->'counts'->>'line_history'
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM public.line_truck_statuses st
   USING jsonb_array_elements_text(v_plan->'delete'->'line_truck_statuses') k(truck_id)
   WHERE st.workspace_id = p_workspace_id AND st.truck_id = k.truck_id
     AND st.shift_id = v_legacy_shift_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (v_plan->'counts'->>'line_truck_statuses')::int THEN
    RAISE EXCEPTION 'migration-delete-count-mismatch: deleted % truck statuses, expected %',
      v_count, v_plan->'counts'->>'line_truck_statuses'
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM public.line_logs l
   USING jsonb_array_elements_text(v_plan->'delete'->'line_logs') k(log_id)
   WHERE l.workspace_id = p_workspace_id AND l.log_id = k.log_id
     AND l.shift_id = v_legacy_shift_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> (v_plan->'counts'->>'line_logs')::int THEN
    RAISE EXCEPTION 'migration-delete-count-mismatch: deleted % trips, expected %',
      v_count, v_plan->'counts'->>'line_logs'
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM public.shifts s
   WHERE s.workspace_id = p_workspace_id AND s.shift_id = v_legacy_shift_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'migration-delete-count-mismatch: deleted % shift anchors, expected 1', v_count
      USING ERRCODE = 'check_violation';
  END IF;

  -- 11. Postconditions: nothing of the source survives, the named trigger is
  -- enabled again, the receipt is closed and no double authority was produced.
  IF EXISTS (SELECT 1 FROM public.line_logs l
              WHERE l.workspace_id = p_workspace_id AND l.shift_id = v_legacy_shift_id)
     OR EXISTS (SELECT 1 FROM public.line_truck_statuses st
                 WHERE st.workspace_id = p_workspace_id AND st.shift_id = v_legacy_shift_id)
     OR EXISTS (SELECT 1 FROM public.line_history lh
                 WHERE lh.workspace_id = p_workspace_id AND lh.shift_id = v_legacy_shift_id)
     OR EXISTS (SELECT 1 FROM public.shifts s
                 WHERE s.workspace_id = p_workspace_id AND s.shift_id = v_legacy_shift_id) THEN
    RAISE EXCEPTION 'migration-source-remains: source rows of % survived the delete', v_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT t.tgenabled INTO v_trigger_state FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid = 'public.archive_overrides'::regclass
     AND t.tgname = 'archive_overrides_restored_receipt_immutable';
  IF v_trigger_state IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'migration-trigger-not-restored: the named receipt guard is not enabled after the migration'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.archive_overrides o
                  WHERE o.workspace_id = p_workspace_id
                    AND o.record_id = v_plan->'receiptTarget'->>'recordId'
                    AND o.location = 'archive') THEN
    RAISE EXCEPTION 'migration-receipt-changed: the legacy restore receipt of % is not closed', v_legacy_shift_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.restored_context_logs rl
              WHERE rl.workspace_id = p_workspace_id AND rl.restored_context_id <> v_context_id
                AND rl.source_log_id IN (SELECT x->>'log_id' FROM jsonb_array_elements(v_plan->'logs') x)) THEN
    RAISE EXCEPTION 'migration-double-authority: a migrated trip is also held by another context'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN jsonb_build_object(
    'outcome','migrated',
    'evidenceId', v_evidence_id::text,
    'restoredContextId', v_context_id,
    'archiveId', v_archive_id,
    'baseArchiveRevision', v_base_revision,
    'mode', v_plan->>'mode',
    'closureHash', v_closure_hash,
    'migrationOperationId', v_operation_id,
    'counts', v_plan->'counts',
    'targetCounts', v_plan->'targetCounts',
    'sourceLocator', v_plan->'manifest'->'archive'->>'sourceLocator'
  );
END
$restored_migrate$;

-- ----------------------------------------------------------------------------
-- Authority: the evidence owner owns the legacy receipt catalog (so the single
-- named trigger can be disabled inside the exact function) and both entrypoints.
-- The runtime never gains EXECUTE on the mutation function; the maintenance
-- executor gets the read-only entrypoints and receives the mutation grant only
-- for the explicit maintenance window handled by src/restored-context-migration.mjs.
-- ----------------------------------------------------------------------------
DO $restored_migration_authority$
DECLARE
  can_assume_owner boolean;
  can_administer boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_migration_evidence_owner') THEN
    RAISE EXCEPTION 'samosval_migration_evidence_owner must be bootstrapped before 025'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT (r.rolsuper OR pg_has_role(current_user, 'samosval_migration_evidence_owner', 'MEMBER'))
    INTO can_assume_owner
    FROM pg_roles r WHERE r.rolname = current_user;
  -- Fail closed: an entrypoint owned by the applying (privileged) role would be an
  -- escalation path for the maintenance executor, so the migration refuses it.
  IF COALESCE(can_assume_owner, false) = false THEN
    RAISE EXCEPTION 'restored migration entrypoints require the samosval_migration_evidence_owner role'
      USING ERRCODE = 'check_violation';
  END IF;

  GRANT USAGE ON SCHEMA public TO samosval_migration_evidence_owner;
  -- The runtime and the maintenance executor must be able to resolve names in
  -- public before any ACL can be evaluated. This is schema visibility only: no
  -- table or function privilege is implied or granted here.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_runtime') THEN
    GRANT USAGE ON SCHEMA public TO samosval_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_maintenance') THEN
    GRANT USAGE ON SCHEMA public TO samosval_maintenance;
  END IF;

  -- The receipt catalog is owned by the evidence owner so the exact function can
  -- disable its own named guard. The app keeps its catalog rights explicitly.
  SELECT (r.rolsuper OR pg_has_role(current_user, c.relowner, 'MEMBER')) INTO can_administer
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, pg_roles r
   WHERE n.nspname = 'public' AND c.relname = 'archive_overrides' AND r.rolname = current_user;
  IF COALESCE(can_administer, false) THEN
    ALTER TABLE public.archive_overrides OWNER TO samosval_migration_evidence_owner;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_runtime') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.archive_overrides TO samosval_runtime;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_schema_owner') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.archive_overrides TO samosval_schema_owner;
    END IF;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.archive_overrides TO CURRENT_USER;
  END IF;

  -- Exact read/delete rights the migration needs. UPDATE is only the row-lock
  -- privilege `SELECT ... FOR UPDATE` requires, never a data mutation path.
  GRANT SELECT ON TABLE public.app_users, public.workspaces, public.line_trucks TO samosval_migration_evidence_owner;
  GRANT SELECT ON TABLE public.shift_archive_series, public.shift_archive_revisions TO samosval_migration_evidence_owner;
  GRANT SELECT, UPDATE, DELETE ON TABLE public.shifts, public.line_logs, public.line_truck_statuses TO samosval_migration_evidence_owner;
  GRANT SELECT ON TABLE public.shift_members, public.legacy_line_status_snapshots,
                        public.legacy_cutover_historicalization_audit, public.shift_archives TO samosval_migration_evidence_owner;
  GRANT SELECT, UPDATE, DELETE ON TABLE public.workspace_service_audit, public.workspace_service_receipts,
                           public.line_audit, public.line_operation_receipts, public.line_history,
                           public.history_audit, public.history_receipts, public.shift_operation_receipts
    TO samosval_migration_evidence_owner;
  GRANT SELECT, INSERT ON TABLE public.restored_shift_contexts, public.restored_context_logs,
                           public.restored_context_status_snapshots, public.restored_context_history,
                           public.restored_context_receipts, public.restored_context_audit
    TO samosval_migration_evidence_owner;
  GRANT SELECT, INSERT ON TABLE public.restored_context_migration_evidence,
                           public.restored_context_migration_evidence_rows
    TO samosval_migration_evidence_owner;

  ALTER FUNCTION public.archive_overrides_restored_receipt_guard() OWNER TO samosval_migration_evidence_owner;
  ALTER FUNCTION public.restored_context_migration_plan(text,text,text,bigint,text)
    OWNER TO samosval_migration_evidence_owner;
  ALTER FUNCTION public.restored_context_source_manifest(text,text,text,bigint,text)
    OWNER TO samosval_migration_evidence_owner;
  ALTER FUNCTION public.migrate_legacy_restored_context_exact(text,jsonb)
    OWNER TO samosval_migration_evidence_owner;

  REVOKE ALL ON FUNCTION public.restored_context_migration_plan(text,text,text,bigint,text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.restored_context_source_manifest(text,text,text,bigint,text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.migrate_legacy_restored_context_exact(text,jsonb) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_runtime') THEN
    REVOKE ALL ON FUNCTION public.restored_context_migration_plan(text,text,text,bigint,text) FROM samosval_runtime;
    REVOKE ALL ON FUNCTION public.restored_context_source_manifest(text,text,text,bigint,text) FROM samosval_runtime;
    REVOKE ALL ON FUNCTION public.migrate_legacy_restored_context_exact(text,jsonb) FROM samosval_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_maintenance') THEN
    -- The preflight/manifest build is read-only and belongs to the maintenance
    -- executor. The mutation entrypoint stays revoked until the maintenance window.
    GRANT EXECUTE ON FUNCTION public.restored_context_migration_plan(text,text,text,bigint,text) TO samosval_maintenance;
    GRANT EXECUTE ON FUNCTION public.restored_context_source_manifest(text,text,text,bigint,text) TO samosval_maintenance;
    REVOKE ALL ON FUNCTION public.migrate_legacy_restored_context_exact(text,jsonb) FROM samosval_maintenance;
  END IF;
END
$restored_migration_authority$;

COMMIT;
