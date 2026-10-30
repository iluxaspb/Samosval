-- TEST-only transactionally committed change journal; NOT a live failover switch.
-- A single locked cursor row serializes writers until COMMIT/ROLLBACK:
-- sequence numbers are gapless and ordered by commit, unlike BIGSERIAL/nextval().
BEGIN;
DO $guard$ BEGIN
 IF current_database()<>'samosval_test' AND current_database() !~ '^sc_verify_[0-9]+$' THEN
   RAISE EXCEPTION 'TEST database required';
 END IF;
END $guard$;

-- A legacy cleanup retained probe evidence outside the business schema.
-- Preserve it unchanged, but only accept its exact documented two-column shape.
DO $evidence_guard$
DECLARE columns text[];
BEGIN
 IF to_regclass('public.migration_probe_evidence') IS NOT NULL THEN
   SELECT array_agg(attname||':'||format_type(atttypid,atttypmod)||':'||attnotnull::text ORDER BY attnum)
   INTO columns FROM pg_attribute
   WHERE attrelid='public.migration_probe_evidence'::regclass AND attnum>0 AND NOT attisdropped;
   IF columns IS DISTINCT FROM ARRAY['recorded_at:timestamp with time zone:true','evidence:jsonb:true'] THEN
     RAISE EXCEPTION 'reserve-outbox-legacy-evidence-schema-mismatch';
   END IF;
 END IF;
END $evidence_guard$;

-- These two immutable original-import tables are created by the legacy TEST
-- import script, not migrations 001-013. Install their exact existing schema
-- on a fresh isolated CI database before checking the 39-table inventory.
CREATE TABLE IF NOT EXISTS migration_imports (
 sha256 text PRIMARY KEY, workspace_id text NOT NULL,
 source_project text NOT NULL, exported_at bigint NOT NULL,
 imported_at timestamptz NOT NULL DEFAULT now(), counts jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS migration_documents (
 import_sha256 text NOT NULL REFERENCES migration_imports(sha256),
 document_path text NOT NULL, payload jsonb NOT NULL,
 PRIMARY KEY(import_sha256,document_path)
);

CREATE TABLE IF NOT EXISTS reserve_outbox_cursor (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0)
);
INSERT INTO reserve_outbox_cursor(singleton,last_sequence) VALUES(true,0)
 ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS reserve_replica_outbox (
 sequence bigint PRIMARY KEY CHECK(sequence>0),
 table_name text NOT NULL,
 action text NOT NULL CHECK(action IN ('upsert','delete')),
 row_key jsonb NOT NULL,
 row_data jsonb,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((action='upsert' AND row_data IS NOT NULL) OR
        (action='delete' AND row_data IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_reserve_outbox_table ON reserve_replica_outbox(table_name,sequence);

-- Empty until a verified snapshot and its exact outbox high-water are bound.
-- Migration does not silently certify a Firebase copy or start uploads.
CREATE TABLE IF NOT EXISTS reserve_replica_receipt (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 sequence bigint NOT NULL CHECK(sequence>=0),
 hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reserve_outbox_append(
  affected_table text, change_action text, key_values jsonb, new_row jsonb)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE next_sequence bigint;
BEGIN
 UPDATE reserve_outbox_cursor SET last_sequence=last_sequence+1
 WHERE singleton=true RETURNING last_sequence INTO next_sequence;
 IF next_sequence IS NULL THEN RAISE EXCEPTION 'reserve-outbox-cursor-missing'; END IF;
 INSERT INTO reserve_replica_outbox(sequence,table_name,action,row_key,row_data)
 VALUES(next_sequence,affected_table,change_action,key_values,new_row);
END $fn$;

CREATE OR REPLACE FUNCTION reserve_outbox_capture_row()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE key_names text[]; key_name text; old_key jsonb:='{}'::jsonb; new_key jsonb:='{}'::jsonb;
        old_row jsonb; new_row jsonb;
BEGIN
 -- Operational heartbeat is volatile and should not produce Firebase batches.
 IF TG_TABLE_NAME='server_control_state' THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
 END IF;
 key_names:=string_to_array(TG_ARGV[0],',');
 IF coalesce(array_length(key_names,1),0)=0 THEN
   RAISE EXCEPTION 'reserve-outbox-primary-key-required: %',TG_TABLE_NAME;
 END IF;
 IF TG_OP<>'INSERT' THEN
   old_row:=to_jsonb(OLD);
   FOREACH key_name IN ARRAY key_names LOOP
     old_key:=old_key||jsonb_build_object(key_name,old_row->key_name);
   END LOOP;
 END IF;
 IF TG_OP<>'DELETE' THEN
   new_row:=to_jsonb(NEW);
   FOREACH key_name IN ARRAY key_names LOOP
     new_key:=new_key||jsonb_build_object(key_name,new_row->key_name);
   END LOOP;
 END IF;
 IF TG_OP='DELETE' THEN
   PERFORM reserve_outbox_append(TG_TABLE_NAME,'delete',old_key,NULL);
   RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
   PERFORM reserve_outbox_append(TG_TABLE_NAME,'upsert',new_key,new_row);
   RETURN NEW;
 END IF;
 IF old_row=new_row THEN RETURN NEW; END IF;
 -- Primary key moves are a delete + upsert; do not leave stale remote rows.
 IF old_key<>new_key THEN
   PERFORM reserve_outbox_append(TG_TABLE_NAME,'delete',old_key,NULL);
 END IF;
 PERFORM reserve_outbox_append(TG_TABLE_NAME,'upsert',new_key,new_row);
 RETURN NEW;
END $fn$;

-- Exact tracked inventory: fail closed on missing/new public business tables.
-- Outbox's own tables are *never* journaled (no recursion).
DO $triggers$
DECLARE tracked text[]:=ARRAY[
'app_users','archive_overrides','control_audit','control_operation_receipts',
'game_records','history_audit','history_receipts','identity_audit','identity_receipts',
'identity_state','line_audit','line_history','line_logs','line_operation_receipts',
'line_truck_statuses','line_trucks','migration_documents','migration_imports',
'notification_outbox','registration_requests','role_permission_versions',
'role_permissions','server_control_events','server_control_jobs','server_control_state',
'shift_archives','shift_operation_receipts','shifts','tabel_policy','tabel_receipts',
'tabel_records','workspace_aux_records','workspace_backups','workspace_objects',
'workspace_service_audit','workspace_service_receipts','workspace_services_state',
'workspace_settings','workspaces'];
names text[]; t text; pk text;
BEGIN
 SELECT array_agg(tablename ORDER BY tablename) INTO names
 FROM pg_tables WHERE schemaname='public' AND tablename NOT IN
 ('reserve_outbox_cursor','reserve_replica_outbox','reserve_replica_receipt',
  'migration_probe_evidence');
 IF names IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(tracked) x) THEN
   RAISE EXCEPTION 'reserve-outbox-schema-inventory-mismatch';
 END IF;
 FOREACH t IN ARRAY tracked LOOP
   SELECT string_agg(a.attname,',' ORDER BY keys.ordinality)
   INTO pk FROM pg_index i
   JOIN LATERAL unnest(i.indkey) WITH ORDINALITY keys(attnum,ordinality) ON true
   JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=keys.attnum
   WHERE i.indrelid=format('public.%I',t)::regclass AND i.indisprimary;
   IF pk IS NULL THEN RAISE EXCEPTION 'reserve-outbox-primary-key-missing: %',t; END IF;
   EXECUTE format('DROP TRIGGER IF EXISTS reserve_row_change ON public.%I',t);
   EXECUTE format(
     'CREATE TRIGGER reserve_row_change AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION reserve_outbox_capture_row(%L)',
     t,pk);
 END LOOP;
END $triggers$;
COMMIT;
