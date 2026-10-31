-- EXPERIMENTAL TEST ONLY. SQL-level fail-closed write barrier.
-- Not installed by the current NAS updater; never arm on a live NAS before
-- every request/worker has an actual Firestore write permit.
BEGIN;
DO $guard$ BEGIN
 IF current_database()<>'samosval_test' AND
    current_database() !~ '^sc_verify_[0-9]+$' THEN
   RAISE EXCEPTION 'spark-fence-test-database-required';
 END IF;
END $guard$;

-- A separate schema keeps control records out of the 39-table data mirror.
CREATE SCHEMA IF NOT EXISTS reserve_control;
CREATE TABLE IF NOT EXISTS reserve_control.writer_gate (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 armed boolean NOT NULL DEFAULT false,
 -- Set true only after every mutating TEST route and non-HTTP worker has
 -- passed a fence-coverage acceptance test on the restored test NAS.
 coverage_certified boolean NOT NULL DEFAULT false,
 owner_epoch bigint NOT NULL DEFAULT 0 CHECK(owner_epoch >= 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT armed OR owner_epoch > 0),
 CHECK(NOT coverage_certified OR armed)
);
INSERT INTO reserve_control.writer_gate(singleton,armed,owner_epoch)
 VALUES(true,false,0) ON CONFLICT(singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION reserve_control.check_write_permit()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE gate record;
BEGIN
 SELECT armed,owner_epoch INTO gate
 FROM reserve_control.writer_gate WHERE singleton=true FOR SHARE;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'spark-fence-gate-missing' USING ERRCODE='55000';
 END IF;
 IF gate.armed AND
    (coalesce(current_setting('samosval.writer_permit_id',true),'') !~ '^[A-Za-z0-9_-]{8,160}$'
     OR coalesce(current_setting('samosval.writer_epoch',true),'') <> gate.owner_epoch::text)
 THEN
   RAISE EXCEPTION 'spark-fence-permit-required' USING ERRCODE='55000';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $fn$;

DO $triggers$
DECLARE t record; installed int:=0;
BEGIN
 -- The SQL 014 capture trigger is the checked list of all mutable business
 -- tables; install the BEFORE barrier on every one, including the heartbeat
 -- table (which intentionally does not produce SQL 014 outbox events).
 FOR t IN SELECT n.nspname AS schema_name,c.relname AS table_name
   FROM pg_trigger trg JOIN pg_class c ON c.oid=trg.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND NOT trg.tgisinternal
     AND trg.tgname='reserve_row_change'
   ORDER BY c.relname
 LOOP
   EXECUTE format('DROP TRIGGER IF EXISTS spark_writer_gate ON %I.%I',
    t.schema_name,t.table_name);
   EXECUTE format(
    'CREATE TRIGGER spark_writer_gate BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION reserve_control.check_write_permit()',
    t.schema_name,t.table_name);
   installed:=installed+1;
 END LOOP;
 IF installed<>39 THEN RAISE EXCEPTION 'spark-fence-unexpected-trigger-inventory: %',installed; END IF;
END $triggers$;
COMMIT;
