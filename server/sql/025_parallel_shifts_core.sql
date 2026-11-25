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

COMMIT;
