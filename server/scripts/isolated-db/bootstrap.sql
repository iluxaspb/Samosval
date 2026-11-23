\set ON_ERROR_STOP on

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_test_orchestrator') THEN CREATE ROLE samosval_test_orchestrator; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_test_app') THEN CREATE ROLE samosval_test_app; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_test_runtime') THEN CREATE ROLE samosval_test_runtime; END IF;
END $$;
ALTER ROLE samosval_test_orchestrator LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'orchestrator_password';
ALTER ROLE samosval_test_app LOGIN NOCREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'test_app_password';
ALTER ROLE samosval_test_runtime LOGIN NOCREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'runtime_password';

REVOKE CONNECT ON DATABASE postgres FROM PUBLIC, samosval_test_app, samosval_test_runtime;
GRANT CONNECT ON DATABASE postgres TO samosval_test_orchestrator;
ALTER ROLE samosval_test_orchestrator IN DATABASE postgres SET samosval.isolated_db_bootstrap = 'samosval-isolated-db-bootstrap:v1';

CREATE SCHEMA IF NOT EXISTS samosval_isolated_admin AUTHORIZATION CURRENT_USER;
ALTER SCHEMA samosval_isolated_admin OWNER TO CURRENT_USER;
REVOKE ALL ON SCHEMA samosval_isolated_admin FROM PUBLIC, samosval_test_app, samosval_test_runtime;

CREATE TABLE IF NOT EXISTS samosval_isolated_admin.target_receipts (
  target_name name PRIMARY KEY,
  runid text NOT NULL CHECK (runid ~ '^[a-f0-9]{12,24}$'),
  target_hash text NOT NULL CHECK (target_hash ~ '^[a-f0-9]{12}$'),
  expected_owner name NOT NULL,
  kind text NOT NULL CHECK (kind = 'target'),
  marker_version integer NOT NULL CHECK (marker_version = 1),
  expected_comment text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'marked')),
  CHECK (target_name::text = 'samosval_parallel_shifts_test_' || runid || '_' || target_hash),
  CHECK (expected_comment = 'samosval-isolated-db:v1;kind=' || kind || ';runid=' || runid || ';hash=' || target_hash || ';owner=' || expected_owner::text)
);
ALTER TABLE samosval_isolated_admin.target_receipts OWNER TO CURRENT_USER;
REVOKE ALL ON TABLE samosval_isolated_admin.target_receipts FROM PUBLIC, samosval_test_orchestrator, samosval_test_app, samosval_test_runtime;

CREATE OR REPLACE FUNCTION samosval_isolated_admin.reserve_target(target_name text, runid text, expected_owner text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE target_hash text := right(target_name, 12);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(target_name, 0));
  IF target_name !~ ('^samosval_parallel_shifts_test_' || runid || '_[a-f0-9]{12}$')
     OR runid !~ '^[a-f0-9]{12,24}$' OR expected_owner <> 'samosval_test_app'
     OR EXISTS (SELECT 1 FROM pg_database WHERE datname = target_name)
     OR EXISTS (SELECT 1 FROM samosval_isolated_admin.target_receipts r WHERE r.target_name = reserve_target.target_name::name)
  THEN RAISE EXCEPTION 'isolated target reservation rejected'; END IF;
  INSERT INTO samosval_isolated_admin.target_receipts
    VALUES (target_name, runid, target_hash, expected_owner, 'target', 1,
      'samosval-isolated-db:v1;kind=target;runid=' || runid || ';hash=' || target_hash || ';owner=' || expected_owner, 'reserved');
END $$;

CREATE OR REPLACE FUNCTION samosval_isolated_admin.mark_reserved_target(target_name text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE receipt samosval_isolated_admin.target_receipts%ROWTYPE; actual_owner text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(target_name, 0));
  SELECT * INTO STRICT receipt FROM samosval_isolated_admin.target_receipts r WHERE r.target_name = mark_reserved_target.target_name::name FOR UPDATE;
  IF receipt.state <> 'reserved' THEN RAISE EXCEPTION 'isolated target state mismatch'; END IF;
  SELECT role.rolname INTO actual_owner FROM pg_database d JOIN pg_roles role ON role.oid=d.datdba WHERE d.datname=target_name;
  IF actual_owner IS DISTINCT FROM receipt.expected_owner::text THEN RAISE EXCEPTION 'isolated target owner mismatch'; END IF;
  EXECUTE format('COMMENT ON DATABASE %I IS %L', target_name, receipt.expected_comment);
  UPDATE samosval_isolated_admin.target_receipts SET state='marked' WHERE target_receipts.target_name=mark_reserved_target.target_name::name;
  RETURN receipt.expected_comment;
END $$;

CREATE OR REPLACE FUNCTION samosval_isolated_admin.terminate_exact_target(target_name text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE receipt samosval_isolated_admin.target_receipts%ROWTYPE; terminated integer; identity_ok boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(target_name, 0));
  SELECT * INTO STRICT receipt FROM samosval_isolated_admin.target_receipts r WHERE r.target_name = terminate_exact_target.target_name::name FOR UPDATE;
  IF receipt.state <> 'marked' OR receipt.kind <> 'target' THEN RAISE EXCEPTION 'isolated target state mismatch'; END IF;
  SELECT r.rolname=receipt.expected_owner::text AND s.description=receipt.expected_comment
    INTO identity_ok FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
    LEFT JOIN pg_shdescription s ON s.objoid=d.oid AND s.classoid='pg_database'::regclass WHERE d.datname=target_name;
  IF identity_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'isolated target identity mismatch'; END IF;
  SELECT count(*) INTO terminated FROM pg_stat_activity a
    WHERE a.datname=target_name AND a.pid<>pg_backend_pid() AND a.usename <> current_user
      AND EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba LEFT JOIN pg_shdescription s ON s.objoid=d.oid AND s.classoid='pg_database'::regclass
        WHERE d.datname=target_name AND r.rolname=receipt.expected_owner::text AND s.description=receipt.expected_comment)
      AND pg_terminate_backend(a.pid);
  RETURN terminated;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA samosval_isolated_admin FROM PUBLIC, samosval_test_app, samosval_test_runtime;
GRANT USAGE ON SCHEMA samosval_isolated_admin TO samosval_test_orchestrator;
GRANT EXECUTE ON FUNCTION samosval_isolated_admin.reserve_target(text,text,text), samosval_isolated_admin.mark_reserved_target(text), samosval_isolated_admin.terminate_exact_target(text) TO samosval_test_orchestrator;
