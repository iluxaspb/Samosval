-- 026: зависимая атрибуция реплики по направлениям (design §4.10).
--
-- Что добавляется:
--   * replica_stream: protocol_version/hash_version и PK по (workspace_id,direction,seq),
--     чтобы независимые f2s/s2f курсоры не конфликтовали одинаковыми номерами;
--   * replica_document_heads — persistent head ledger с tombstone после удаления;
--   * replica_pending_documents — transport state для status/log без canonical parent
--     (payload НЕ копируется: читается по FK из immutable replica_stream);
--   * deferred constraint triggers, доказывающие обе стороны инварианта head↔pending;
--   * immutability stream на уровне БД и роль-граница runtime (026 только расширяет
--     границу Task 2/P6/P7, не создаёт её заново).
--
-- Fail-closed: исторический preflight выполняется под блокировкой stream/cursor и
-- ДО первого DDL. Любой abort оставляет схему побайтово прежней: транзакция
-- откатывается целиком, старый PK и отсутствие новых таблиц проверяются тестом.
-- Исторические seq, cursor, payload и sha256 не перенумеровываются и не переписываются.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Historical preflight. Runs before the first DDL statement.
-- ---------------------------------------------------------------------------
-- Old PK (workspace_id,seq) made seq globally unique, but by itself does not prove a
-- contiguous 1..N per direction under possible interleaving or a historical importer.
-- 026 therefore never renumbers: it only proves that the stored history is unambiguous.
--
-- Import/compaction markers are an input of the preflight, so they must already exist
-- before 026 runs; 026 never creates them (no compaction is part of stage 4). When the
-- relation is present its shape is a fixed contract: anything else is ambiguity.
LOCK TABLE public.replica_stream IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.replica_cursor IN ACCESS EXCLUSIVE MODE;

DO $replica_stream_preflight$
DECLARE
  v_current_pk text;
  v_legacy_pk boolean;
  v_markers boolean;
  v_direction_markers boolean;
  v_ws text;
  v_direction text;
  v_cursor bigint;
  v_count bigint;
  v_min bigint;
  v_max bigint;
  v_prefix bigint;
  v_bad bigint;
BEGIN
  -- The pre-026 primary key is what makes the cross-direction rules meaningful.
  SELECT string_agg(a.attname, ',' ORDER BY k.ord)
    INTO v_current_pk
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
   WHERE n.nspname = 'public' AND t.relname = 'replica_stream' AND c.contype = 'p';

  IF v_current_pk IS NULL OR v_current_pk = 'workspace_id,seq' THEN
    -- A missing PK is a lost guarantee, not a licence: the strict legacy rules apply and
    -- the PK block below refuses to invent one.
    v_legacy_pk := true;
  ELSIF v_current_pk = 'workspace_id,direction,seq' THEN
    v_legacy_pk := false;
  ELSE
    RAISE EXCEPTION USING MESSAGE = format('replica-preflight-primary-key-unexpected: %s', v_current_pk),
      ERRCODE = 'check_violation';
  END IF;

  -- Versioned marker contract (only read, never created here).
  v_markers := to_regclass('public.replica_stream_markers') IS NOT NULL;
  IF v_markers THEN
    SELECT count(*) INTO v_bad
      FROM (VALUES ('workspace_id','text'), ('direction','text'), ('marker_version','smallint'),
                   ('marker_kind','text'), ('from_seq','bigint'), ('to_seq','bigint'),
                   ('recorded_at','timestamp with time zone')) AS expected(column_name, data_type)
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = 'replica_stream_markers'
          AND c.column_name = expected.column_name AND c.data_type = expected.data_type
          AND c.is_nullable = 'NO');
    IF v_bad > 0 OR (SELECT count(*) FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'replica_stream_markers') <> 7 THEN
      RAISE EXCEPTION USING MESSAGE = 'replica-preflight-marker-shape: replica_stream_markers does not match the versioned marker contract',
        ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Exactly one cursor row per workspace that carries history.
  FOR v_ws IN
    SELECT DISTINCT s.workspace_id FROM public.replica_stream s
     WHERE NOT EXISTS (SELECT 1 FROM public.replica_cursor c WHERE c.workspace_id = s.workspace_id)
  LOOP
    RAISE EXCEPTION USING MESSAGE = format('replica-preflight-cursor-missing: workspace %s has stream rows without a cursor row', v_ws),
      ERRCODE = 'check_violation';
  END LOOP;
  SELECT count(*) INTO v_bad FROM (
    SELECT workspace_id FROM public.replica_cursor GROUP BY workspace_id HAVING count(*) <> 1
  ) d;
  IF v_bad > 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'replica-preflight-cursor-ambiguous: replica_cursor must hold exactly one row per workspace',
      ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO v_bad FROM public.replica_stream WHERE seq <= 0;
  IF v_bad > 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'replica-preflight-seq-nonpositive: replica_stream contains a non-positive seq',
      ERRCODE = 'check_violation';
  END IF;

  -- The old global uniqueness and cross-direction collision are corruption once the
  -- new PK allows independent sequences; they are only provable before the PK change.
  IF v_legacy_pk THEN
    SELECT count(*) INTO v_bad FROM (
      SELECT workspace_id, direction, seq FROM public.replica_stream
       GROUP BY workspace_id, direction, seq HAVING count(*) > 1
    ) d;
    IF v_bad > 0 THEN
      RAISE EXCEPTION USING MESSAGE = 'replica-preflight-seq-duplicate: the legacy (workspace_id,seq) key is not unique',
        ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO v_bad FROM (
      SELECT workspace_id, seq FROM public.replica_stream
       GROUP BY workspace_id, seq HAVING count(DISTINCT direction) > 1
    ) d;
    IF v_bad > 0 THEN
      RAISE EXCEPTION USING MESSAGE = 'replica-preflight-direction-collision: the same seq exists in both directions before the PK change',
        ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT count(*) INTO v_bad FROM (
    SELECT workspace_id, direction, operation_id FROM public.replica_stream
     GROUP BY workspace_id, direction, operation_id HAVING count(*) > 1
  ) d;
  IF v_bad > 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'replica-preflight-operation-duplicate: operation identity is not unique per direction',
      ERRCODE = 'check_violation';
  END IF;

  -- Per-direction continuity against the persisted cursor.
  FOR v_ws, v_direction, v_cursor IN
    SELECT c.workspace_id, d.direction,
           CASE WHEN d.direction = 'f2s' THEN c.f2s_seq ELSE c.s2f_seq END
      FROM public.replica_cursor c
      CROSS JOIN (VALUES ('f2s'), ('s2f')) AS d(direction)
  LOOP
    IF v_cursor < 0 THEN
      RAISE EXCEPTION USING MESSAGE = format('replica-preflight-%s-cursor-negative: cursor must not be negative', v_direction),
        ERRCODE = 'check_violation';
    END IF;

    SELECT count(*), min(seq), max(seq) INTO v_count, v_min, v_max
      FROM public.replica_stream s
     WHERE s.workspace_id = v_ws AND s.direction = v_direction;

    IF v_count = 0 THEN
      IF v_cursor <> 0 THEN
        RAISE EXCEPTION USING MESSAGE = format('replica-preflight-%s-head-missing: workspace %s cursor %s has no stream row', v_direction, v_ws, v_cursor),
          ERRCODE = 'check_violation';
      END IF;
      CONTINUE;
    END IF;

    IF v_max > v_cursor THEN
      RAISE EXCEPTION USING MESSAGE = format('replica-preflight-%s-row-beyond-cursor: workspace %s has seq %s beyond cursor %s', v_direction, v_ws, v_max, v_cursor),
        ERRCODE = 'check_violation';
    END IF;
    IF v_max <> v_cursor THEN
      RAISE EXCEPTION USING MESSAGE = format('replica-preflight-%s-head-mismatch: workspace %s max seq %s does not match cursor %s', v_direction, v_ws, v_max, v_cursor),
        ERRCODE = 'check_violation';
    END IF;

    v_direction_markers := false;
    IF v_markers THEN
      -- The marker relation may legitimately be absent; its name is only resolved when it
      -- exists, because a PL/pgSQL IF expression is planned as a whole.
      SELECT EXISTS (
        SELECT 1 FROM public.replica_stream_markers m
         WHERE m.workspace_id = v_ws AND m.direction = v_direction) INTO v_direction_markers;
    END IF;

    IF v_direction_markers THEN
      -- A marker is a versioned, checksummed retained range: version 1, known kind,
      -- positive ordered range that cannot reach beyond the persisted cursor.
      SELECT count(*) INTO v_bad FROM public.replica_stream_markers m
       WHERE m.workspace_id = v_ws AND m.direction = v_direction
         AND (m.marker_version <> 1
              OR m.marker_kind NOT IN ('legacy-import','compaction')
              OR m.from_seq < 1 OR m.to_seq < m.from_seq OR m.to_seq > v_cursor);
      IF v_bad > 0 THEN
        RAISE EXCEPTION USING MESSAGE = format('replica-preflight-%s-marker-invalid: workspace %s has a marker outside the versioned contract', v_direction, v_ws),
          ERRCODE = 'check_violation';
      END IF;

      -- Longest native prefix: rows 1..prefix are contiguous, everything after it is
      -- only legal inside a declared retained range.
      SELECT COALESCE(min(rn) - 1, v_count) INTO v_prefix FROM (
        SELECT seq, row_number() OVER (ORDER BY seq) AS rn
          FROM public.replica_stream
         WHERE workspace_id = v_ws AND direction = v_direction
      ) o WHERE o.seq <> o.rn;

      SELECT count(*) INTO v_bad
        FROM public.replica_stream s
       WHERE s.workspace_id = v_ws AND s.direction = v_direction AND s.seq > v_prefix
         AND NOT EXISTS (
           SELECT 1 FROM public.replica_stream_markers m
            WHERE m.workspace_id = v_ws AND m.direction = v_direction
              AND s.seq BETWEEN m.from_seq AND m.to_seq);
      IF v_bad > 0 THEN
        RAISE EXCEPTION USING MESSAGE = format('replica-preflight-%s-row-outside-marker: workspace %s has a seq outside every declared retained range', v_direction, v_ws),
          ERRCODE = 'check_violation';
      END IF;

      SELECT count(*) INTO v_bad FROM (
        SELECT seq, lag(seq, 1, 0) OVER (ORDER BY seq) AS prev
          FROM public.replica_stream
         WHERE workspace_id = v_ws AND direction = v_direction
      ) o
       WHERE o.seq > o.prev + 1
         AND EXISTS (
           SELECT 1 FROM generate_series(o.prev + 1, o.seq - 1) AS p
            WHERE NOT EXISTS (
              SELECT 1 FROM public.replica_stream_markers m
               WHERE m.workspace_id = v_ws AND m.direction = v_direction
                 AND p BETWEEN m.from_seq AND m.to_seq));
      IF v_bad > 0 THEN
        RAISE EXCEPTION USING MESSAGE = format('replica-preflight-%s-gap: workspace %s has a gap that no marker covers', v_direction, v_ws),
          ERRCODE = 'check_violation';
      END IF;
    ELSE
      -- Native, un-compacted history created by the ordinary writer is exactly 1..cursor.
      IF v_count <> v_cursor OR v_min <> 1 THEN
        RAISE EXCEPTION USING MESSAGE = format('replica-preflight-%s-gap: workspace %s native stream must be the exact range 1..%s', v_direction, v_ws, v_cursor),
          ERRCODE = 'check_violation';
      END IF;
    END IF;
  END LOOP;
END
$replica_stream_preflight$;

-- ---------------------------------------------------------------------------
-- 2. Stream version columns (existing rows stay protocol/hash version 1; their
--    legacy payload-only sha256 is never rewritten).
-- ---------------------------------------------------------------------------
ALTER TABLE public.replica_stream
  ADD COLUMN IF NOT EXISTS protocol_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS hash_version smallint NOT NULL DEFAULT 1;

DO $replica_stream_versions$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.replica_stream'::regclass
                    AND conname = 'replica_stream_protocol_version_check') THEN
    ALTER TABLE public.replica_stream
      ADD CONSTRAINT replica_stream_protocol_version_check CHECK (protocol_version IN (1,2));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.replica_stream'::regclass
                    AND conname = 'replica_stream_hash_version_check') THEN
    ALTER TABLE public.replica_stream
      ADD CONSTRAINT replica_stream_hash_version_check CHECK (hash_version IN (1,2));
  END IF;
END
$replica_stream_versions$;

-- ---------------------------------------------------------------------------
-- 3. PK replacement: independent f2s/s2f sequences under one unique
--    (workspace_id,direction,operation_id).
-- ---------------------------------------------------------------------------
DO $replica_stream_pk$
DECLARE
  v_current text;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO v_current
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
   WHERE n.nspname = 'public' AND t.relname = 'replica_stream' AND c.contype = 'p';

  IF v_current IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'replica-postcondition-primary-key: replica_stream has no primary key',
      ERRCODE = 'check_violation';
  END IF;

  IF v_current = 'workspace_id,seq' THEN
    ALTER TABLE public.replica_stream DROP CONSTRAINT replica_stream_pkey;
    ALTER TABLE public.replica_stream
      ADD CONSTRAINT replica_stream_pkey PRIMARY KEY (workspace_id, direction, seq);
  ELSIF v_current <> 'workspace_id,direction,seq' THEN
    RAISE EXCEPTION USING MESSAGE = format('replica-postcondition-primary-key: unexpected replica_stream primary key %s', v_current),
      ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.replica_stream'::regclass
                    AND conname = 'replica_stream_workspace_id_direction_operation_id_key') THEN
    RAISE EXCEPTION USING MESSAGE = 'replica-postcondition-operation-identity: UNIQUE(workspace_id,direction,operation_id) is missing',
      ERRCODE = 'check_violation';
  END IF;
END
$replica_stream_pk$;

-- ---------------------------------------------------------------------------
-- 4. replica_document_heads — persistent head ledger (design §4.10 verbatim).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.replica_document_heads (
  workspace_id     text NOT NULL,
  collection       text NOT NULL CHECK (collection IN ('objects','users','shift','trucks','truckStatus','logs')),
  document_id      text NOT NULL CHECK (btrim(document_id) <> '' AND document_id !~ '/'),
  head_seq         bigint NOT NULL CHECK (head_seq > 0),
  stream_direction text NOT NULL DEFAULT 'f2s' CHECK (stream_direction = 'f2s'),
  head_kind        text NOT NULL CHECK (head_kind IN ('doc.set','doc.delete')),
  shift_id         text,
  truck_id         text,
  object_id        text,
  user_uid         text,
  applied_seq      bigint CHECK (applied_seq IS NULL OR applied_seq > 0),
  canonical_present boolean NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT replica_document_heads_pkey PRIMARY KEY (workspace_id, collection, document_id),
  -- Exact three-state row contract: settled delete / materialized set / pending set.
  CONSTRAINT replica_document_heads_state_check CHECK (
    (head_kind='doc.delete' AND canonical_present=false AND applied_seq IS NOT NULL AND applied_seq=head_seq)
    OR
    (head_kind='doc.set' AND canonical_present=true AND applied_seq IS NOT NULL AND applied_seq=head_seq)
    OR
    (head_kind='doc.set' AND canonical_present=false AND applied_seq IS NULL)
  ),
  -- Collection shape: identity is the exact last path segment, routing snapshots are
  -- only the ones the collection owns.
  CONSTRAINT replica_document_heads_shape_check CHECK (
    CASE collection
      WHEN 'objects' THEN object_id IS NOT NULL AND document_id = object_id
                          AND user_uid IS NULL AND shift_id IS NULL AND truck_id IS NULL
      WHEN 'users' THEN user_uid IS NOT NULL AND document_id = user_uid
                        AND object_id IS NULL AND shift_id IS NULL AND truck_id IS NULL
      WHEN 'trucks' THEN truck_id IS NOT NULL AND document_id = truck_id
                         AND object_id IS NULL AND user_uid IS NULL AND shift_id IS NULL
      WHEN 'shift' THEN shift_id IS NOT NULL AND document_id = shift_id AND truck_id IS NULL
                        AND (head_kind <> 'doc.set' OR object_id IS NOT NULL)
      WHEN 'truckStatus' THEN truck_id IS NOT NULL AND document_id = truck_id
                              AND object_id IS NULL AND user_uid IS NULL
                              AND (head_kind <> 'doc.set' OR shift_id IS NOT NULL)
      WHEN 'logs' THEN object_id IS NULL AND user_uid IS NULL
                       AND (head_kind <> 'doc.set' OR (shift_id IS NOT NULL AND truck_id IS NOT NULL))
      ELSE false
    END
  ),
  -- A pending head is backed by exactly one pending row; the unique key below is what
  -- the composite FK of replica_pending_documents points at.
  CONSTRAINT replica_document_heads_pending_key UNIQUE (workspace_id, collection, document_id, stream_direction, head_seq),
  CONSTRAINT replica_document_heads_head_key UNIQUE (workspace_id, stream_direction, head_seq),
  CONSTRAINT replica_document_heads_stream_fk
    FOREIGN KEY (workspace_id, stream_direction, head_seq)
    REFERENCES public.replica_stream (workspace_id, direction, seq) ON DELETE RESTRICT,
  CONSTRAINT replica_document_heads_applied_fk
    FOREIGN KEY (workspace_id, stream_direction, applied_seq)
    REFERENCES public.replica_stream (workspace_id, direction, seq) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS replica_document_heads_shift_idx
  ON public.replica_document_heads (workspace_id, shift_id, head_seq);
CREATE INDEX IF NOT EXISTS replica_document_heads_truck_idx
  ON public.replica_document_heads (workspace_id, truck_id, head_seq);
CREATE INDEX IF NOT EXISTS replica_document_heads_object_idx
  ON public.replica_document_heads (workspace_id, object_id, head_seq);
CREATE INDEX IF NOT EXISTS replica_document_heads_user_idx
  ON public.replica_document_heads (workspace_id, user_uid, head_seq);

-- ---------------------------------------------------------------------------
-- 5. replica_pending_documents — transport state only. Payload is never copied:
--    it is read by exact FK from immutable replica_stream.payload.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.replica_pending_documents (
  workspace_id     text NOT NULL,
  collection       text NOT NULL CHECK (collection IN ('truckStatus','logs')),
  document_id      text NOT NULL CHECK (btrim(document_id) <> ''),
  stream_seq       bigint NOT NULL CHECK (stream_seq > 0),
  stream_direction text NOT NULL DEFAULT 'f2s' CHECK (stream_direction = 'f2s'),
  shift_id         text NOT NULL CHECK (btrim(shift_id) <> ''),
  truck_id         text NOT NULL CHECK (btrim(truck_id) <> ''),
  log_id           text,
  missing_shift    boolean NOT NULL,
  missing_truck    boolean NOT NULL,
  staged_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT replica_pending_documents_pkey PRIMARY KEY (workspace_id, collection, document_id),
  CONSTRAINT replica_pending_documents_stream_key UNIQUE (workspace_id, stream_direction, stream_seq),
  CONSTRAINT replica_pending_documents_missing_check CHECK (missing_shift OR missing_truck),
  CONSTRAINT replica_pending_documents_shape_check CHECK (
    (collection = 'truckStatus' AND truck_id IS NOT NULL AND document_id = truck_id AND log_id IS NULL)
    OR (collection = 'logs' AND log_id IS NOT NULL AND document_id = log_id)
  ),
  CONSTRAINT replica_pending_documents_stream_fk
    FOREIGN KEY (workspace_id, stream_direction, stream_seq)
    REFERENCES public.replica_stream (workspace_id, direction, seq) ON DELETE RESTRICT,
  -- Design §4.10 writes "ON DELETE CAS", which is not a referential action; the
  -- fail-closed reading is RESTRICT: compaction may remove a head only when no
  -- pending row references it.
  CONSTRAINT replica_pending_documents_head_fk
    FOREIGN KEY (workspace_id, collection, document_id, stream_direction, stream_seq)
    REFERENCES public.replica_document_heads (workspace_id, collection, document_id, stream_direction, head_seq)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS replica_pending_documents_shift_idx
  ON public.replica_pending_documents (workspace_id, shift_id, collection, document_id);
CREATE INDEX IF NOT EXISTS replica_pending_documents_truck_idx
  ON public.replica_pending_documents (workspace_id, truck_id, collection, document_id);

-- ---------------------------------------------------------------------------
-- 6. Deferred cross-table invariant. A plain CHECK cannot prove it, so both
--    tables carry DEFERRABLE INITIALLY DEFERRED constraint triggers that check
--    both sides at the end of the transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.replica_head_pending_invariant() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $replica_head_pending_invariant$
DECLARE
  v_ws text;
  v_collection text;
  v_document text;
  v_head public.replica_document_heads;
  v_pending_count int;
  v_stream public.replica_stream;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_ws := OLD.workspace_id;
    v_collection := OLD.collection;
    v_document := OLD.document_id;
  ELSE
    v_ws := NEW.workspace_id;
    v_collection := NEW.collection;
    v_document := NEW.document_id;
  END IF;

  SELECT * INTO v_head FROM public.replica_document_heads
   WHERE workspace_id = v_ws AND collection = v_collection AND document_id = v_document;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.replica_pending_documents
                WHERE workspace_id = v_ws AND collection = v_collection AND document_id = v_document) THEN
      RAISE EXCEPTION USING MESSAGE = format('replica-pending-without-head: %s/%s/%s', v_ws, v_collection, v_document),
        ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  IF v_head.head_kind = 'doc.set' AND v_head.canonical_present = false AND v_head.applied_seq IS NULL THEN
    SELECT count(*)::int INTO v_pending_count FROM public.replica_pending_documents
     WHERE workspace_id = v_ws AND collection = v_collection AND document_id = v_document;
    IF v_pending_count = 0 THEN
      RAISE EXCEPTION USING MESSAGE = format('replica-pending-head-without-row: %s/%s/%s', v_ws, v_collection, v_document),
        ERRCODE = 'check_violation';
    ELSIF v_pending_count > 1 THEN
      RAISE EXCEPTION USING MESSAGE = format('replica-pending-head-duplicate: %s/%s/%s', v_ws, v_collection, v_document),
        ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.replica_pending_documents p
       WHERE p.workspace_id = v_ws AND p.collection = v_collection AND p.document_id = v_document
         AND p.stream_direction = v_head.stream_direction AND p.stream_seq = v_head.head_seq
    ) THEN
      RAISE EXCEPTION USING MESSAGE = format('replica-pending-seq-mismatch: %s/%s/%s', v_ws, v_collection, v_document),
        ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO v_stream FROM public.replica_stream s
     WHERE s.workspace_id = v_head.workspace_id
       AND s.direction = v_head.stream_direction
       AND s.seq = v_head.head_seq;
    IF NOT FOUND OR v_stream.kind <> 'doc.set' OR v_stream.protocol_version <> 2 THEN
      RAISE EXCEPTION USING MESSAGE = format('replica-pending-stream-invalid: %s/%s/%s', v_ws, v_collection, v_document),
        ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.replica_pending_documents
                WHERE workspace_id = v_ws AND collection = v_collection AND document_id = v_document) THEN
      RAISE EXCEPTION USING MESSAGE = format('replica-pending-on-settled-head: %s/%s/%s', v_ws, v_collection, v_document),
        ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END
$replica_head_pending_invariant$;

DROP TRIGGER IF EXISTS replica_document_heads_pending_invariant ON public.replica_document_heads;
CREATE CONSTRAINT TRIGGER replica_document_heads_pending_invariant
  AFTER INSERT OR UPDATE OR DELETE ON public.replica_document_heads
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.replica_head_pending_invariant();

DROP TRIGGER IF EXISTS replica_pending_documents_head_invariant ON public.replica_pending_documents;
CREATE CONSTRAINT TRIGGER replica_pending_documents_head_invariant
  AFTER INSERT OR UPDATE OR DELETE ON public.replica_pending_documents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.replica_head_pending_invariant();

-- ---------------------------------------------------------------------------
-- 7. Immutable stream. Append-only at DB level; the trigger fires for every role,
--    including the table owner, and TRUNCATE has a statement-level guard because it
--    bypasses row triggers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.replica_stream_immutable_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $replica_stream_immutable$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'replica-stream-immutable', ERRCODE = 'check_violation';
END
$replica_stream_immutable$;

DROP TRIGGER IF EXISTS replica_stream_immutable ON public.replica_stream;
CREATE TRIGGER replica_stream_immutable
  BEFORE UPDATE OR DELETE ON public.replica_stream
  FOR EACH ROW EXECUTE FUNCTION public.replica_stream_immutable_guard();

DROP TRIGGER IF EXISTS replica_stream_no_truncate ON public.replica_stream;
CREATE TRIGGER replica_stream_no_truncate
  BEFORE TRUNCATE ON public.replica_stream
  FOR EACH STATEMENT EXECUTE FUNCTION public.replica_stream_immutable_guard();

-- ---------------------------------------------------------------------------
-- 8. Role boundary. 026 extends the Task 2/P6/P7 boundary to stream/heads/pending;
--    it never creates it. The trigger is a second line of defence, not the boundary:
--    the runtime role keeps no UPDATE/DELETE/TRIGGER/ALTER path and no head/staging DML.
-- ---------------------------------------------------------------------------
DO $replica_authority$
DECLARE
  v_applying_super boolean;
  v_can_assume boolean;
  v_can_administer boolean;
  v_target text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_migration_evidence_owner') THEN
    RAISE EXCEPTION USING MESSAGE = 'samosval_migration_evidence_owner must be bootstrapped before 026',
      ERRCODE = 'check_violation';
  END IF;

  SELECT rolsuper INTO v_applying_super FROM pg_roles WHERE rolname = current_user;
  v_can_assume := COALESCE(v_applying_super, false)
                  OR pg_has_role(current_user, 'samosval_migration_evidence_owner', 'MEMBER');

  IF v_can_assume THEN
    FOR v_target IN
      SELECT unnest(ARRAY['replica_stream','replica_document_heads','replica_pending_documents'])
    LOOP
      EXECUTE format('ALTER TABLE public.%I OWNER TO samosval_migration_evidence_owner', v_target);
    END LOOP;
    ALTER FUNCTION public.replica_head_pending_invariant() OWNER TO samosval_migration_evidence_owner;
    ALTER FUNCTION public.replica_stream_immutable_guard() OWNER TO samosval_migration_evidence_owner;
    GRANT USAGE ON SCHEMA public TO samosval_migration_evidence_owner;
  ELSE
    RAISE NOTICE 'replica ownership stays with % : role cannot assume samosval_migration_evidence_owner', current_user;
  END IF;

  REVOKE ALL ON FUNCTION public.replica_head_pending_invariant() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.replica_stream_immutable_guard() FROM PUBLIC;

  FOR v_target IN
    SELECT unnest(ARRAY['replica_stream','replica_document_heads','replica_pending_documents','replica_cursor'])
  LOOP
    SELECT (COALESCE(v_applying_super, false)
            OR pg_has_role(current_user, c.relowner, 'MEMBER')) INTO v_can_administer
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = v_target;
    IF v_can_administer THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', v_target);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_runtime') THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM samosval_runtime', v_target);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_maintenance') THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM samosval_maintenance', v_target);
      END IF;
    ELSE
      RAISE NOTICE 'replica ACL for % stays with the table owner: % cannot administer it', v_target, current_user;
    END IF;
  END LOOP;

  -- Least privilege for the transport: append/read the immutable stream, read the
  -- ledgers, advance the cursor. No head/staging DML outside reviewed functions.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_runtime') THEN
    SELECT (COALESCE(v_applying_super, false)
            OR pg_has_role(current_user, c.relowner, 'MEMBER')) INTO v_can_administer
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'replica_stream';
    IF v_can_administer THEN
      GRANT SELECT, INSERT ON TABLE public.replica_stream TO samosval_runtime;
    END IF;
    SELECT (COALESCE(v_applying_super, false)
            OR pg_has_role(current_user, c.relowner, 'MEMBER')) INTO v_can_administer
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'replica_document_heads';
    IF v_can_administer THEN
      GRANT SELECT ON TABLE public.replica_document_heads TO samosval_runtime;
    END IF;
    SELECT (COALESCE(v_applying_super, false)
            OR pg_has_role(current_user, c.relowner, 'MEMBER')) INTO v_can_administer
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'replica_pending_documents';
    IF v_can_administer THEN
      GRANT SELECT ON TABLE public.replica_pending_documents TO samosval_runtime;
    END IF;
    -- The append path locks the cursor row FOR UPDATE, and a row lock is an UPDATE
    -- privilege in PostgreSQL.
    SELECT (COALESCE(v_applying_super, false)
            OR pg_has_role(current_user, c.relowner, 'MEMBER')) INTO v_can_administer
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'replica_cursor';
    IF v_can_administer THEN
      GRANT SELECT, UPDATE ON TABLE public.replica_cursor TO samosval_runtime;
    END IF;
  END IF;
END
$replica_authority$;

-- ---------------------------------------------------------------------------
-- 9. Postconditions: the migration proves its own result instead of trusting DDL.
-- ---------------------------------------------------------------------------
DO $replica_postconditions$
DECLARE
  v_cols text;
  v_missing int;
  v_column text;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO v_cols
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
   WHERE n.nspname = 'public' AND t.relname = 'replica_stream' AND c.contype = 'p';
  IF v_cols IS DISTINCT FROM 'workspace_id,direction,seq' THEN
    RAISE EXCEPTION USING MESSAGE = format('replica-postcondition-primary-key: got %s', COALESCE(v_cols, 'none')),
      ERRCODE = 'check_violation';
  END IF;

  FOR v_column IN
    SELECT unnest(ARRAY['replica_document_heads','replica_pending_documents'])
  LOOP
    IF to_regclass('public.' || v_column) IS NULL THEN
      RAISE EXCEPTION USING MESSAGE = format('replica-postcondition-table: %s is missing', v_column),
        ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_missing
    FROM (VALUES ('replica_stream_immutable'), ('replica_stream_no_truncate'),
                 ('replica_document_heads_pending_invariant'),
                 ('replica_pending_documents_head_invariant')) AS expected(name)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = expected.name AND NOT g.tgisinternal);
  IF v_missing > 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'replica-postcondition-trigger: an immutable or deferred trigger is missing',
      ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO v_missing
    FROM (VALUES ('replica_document_heads_pending_invariant'),
                 ('replica_pending_documents_head_invariant')) AS expected(name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger g
      WHERE g.tgname = expected.name AND g.tgdeferrable AND g.tginitdeferred);
  IF v_missing > 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'replica-postcondition-trigger: the head/pending invariant must be deferred',
      ERRCODE = 'check_violation';
  END IF;
END
$replica_postconditions$;

COMMIT;
