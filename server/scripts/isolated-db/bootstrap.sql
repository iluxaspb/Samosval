\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_test_orchestrator') THEN CREATE ROLE samosval_test_orchestrator; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_test_app') THEN CREATE ROLE samosval_test_app; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_test_runtime') THEN CREATE ROLE samosval_test_runtime; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_test_prepared_owner') THEN CREATE ROLE samosval_test_prepared_owner; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_schema_owner') THEN CREATE ROLE samosval_schema_owner; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_migration_evidence_owner') THEN CREATE ROLE samosval_migration_evidence_owner; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_runtime') THEN CREATE ROLE samosval_runtime; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'samosval_maintenance') THEN CREATE ROLE samosval_maintenance; END IF;
END $$;
ALTER ROLE samosval_test_orchestrator LOGIN NOCREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'orchestrator_password';
ALTER ROLE samosval_test_app LOGIN NOCREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'test_app_password';
ALTER ROLE samosval_test_runtime LOGIN NOCREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'runtime_password';
ALTER ROLE samosval_test_prepared_owner NOLOGIN NOCREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE samosval_schema_owner NOLOGIN NOCREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE samosval_migration_evidence_owner NOLOGIN NOCREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE samosval_runtime LOGIN NOCREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'runtime_password';
ALTER ROLE samosval_maintenance LOGIN NOCREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'maintenance_password';

DO $$ DECLARE membership record; BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
    FROM pg_auth_members m JOIN pg_roles granted ON granted.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
    WHERE member.rolname IN ('samosval_test_orchestrator','samosval_test_app','samosval_test_runtime','samosval_test_prepared_owner')
       OR granted.rolname IN ('samosval_test_orchestrator','samosval_test_app','samosval_test_runtime','samosval_test_prepared_owner')
  LOOP EXECUTE format('REVOKE %I FROM %I', membership.granted_role, membership.member_role); END LOOP;
END $$;

REVOKE CONNECT ON DATABASE postgres FROM PUBLIC, samosval_test_app, samosval_test_runtime, samosval_test_prepared_owner, samosval_runtime, samosval_maintenance, samosval_schema_owner, samosval_migration_evidence_owner;
GRANT CONNECT ON DATABASE postgres TO samosval_test_orchestrator;
ALTER ROLE samosval_test_orchestrator IN DATABASE postgres SET samosval.isolated_db_bootstrap = 'samosval-isolated-db-bootstrap:v1';

CREATE SCHEMA IF NOT EXISTS samosval_isolated_admin AUTHORIZATION CURRENT_USER;
ALTER SCHEMA samosval_isolated_admin OWNER TO CURRENT_USER;
REVOKE ALL ON SCHEMA samosval_isolated_admin FROM PUBLIC, samosval_test_orchestrator, samosval_test_app, samosval_test_runtime, samosval_test_prepared_owner;

CREATE TABLE IF NOT EXISTS samosval_isolated_admin.target_receipts (
  target_name name PRIMARY KEY,
  runid text NOT NULL,
  target_hash text NOT NULL,
  expected_owner name NOT NULL,
  kind text NOT NULL,
  marker_version integer NOT NULL,
  expected_comment text NOT NULL,
  capability_hash bytea NOT NULL,
  receipt_generation bigint NOT NULL DEFAULT 1,
  state text NOT NULL
);
ALTER TABLE samosval_isolated_admin.target_receipts ADD COLUMN IF NOT EXISTS capability_hash bytea;
ALTER TABLE samosval_isolated_admin.target_receipts ADD COLUMN IF NOT EXISTS receipt_generation bigint NOT NULL DEFAULT 1;
DELETE FROM samosval_isolated_admin.target_receipts WHERE capability_hash IS NULL;
ALTER TABLE samosval_isolated_admin.target_receipts ALTER COLUMN capability_hash SET NOT NULL;
ALTER TABLE samosval_isolated_admin.target_receipts OWNER TO CURRENT_USER;
REVOKE ALL ON TABLE samosval_isolated_admin.target_receipts FROM PUBLIC, samosval_test_orchestrator, samosval_test_app, samosval_test_runtime, samosval_test_prepared_owner;

DROP FUNCTION IF EXISTS samosval_isolated_admin.reserve_target(text,text,text);
DROP FUNCTION IF EXISTS samosval_isolated_admin.mark_reserved_target(text);
DROP FUNCTION IF EXISTS samosval_isolated_admin.terminate_exact_target(text);
DROP FUNCTION IF EXISTS samosval_isolated_admin.terminate_exact_target(text,text,text,text);
DROP FUNCTION IF EXISTS samosval_isolated_admin.authorize_drop_target(text,text);
DROP FUNCTION IF EXISTS samosval_isolated_admin.authorize_partial_drop(text,text);

CREATE OR REPLACE FUNCTION samosval_isolated_admin.reserve_target(target_name text, runid text, capability text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE target_hash text := right(target_name, 12); expected_comment text;
BEGIN
  IF capability !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'isolated capability rejected'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(target_name, 0));
  IF target_name !~ ('^samosval_parallel_shifts_test_' || runid || '_[a-f0-9]{12}$')
     OR runid !~ '^[a-f0-9]{12,20}$' OR octet_length(target_name) > 63
     OR EXISTS (SELECT 1 FROM pg_database WHERE datname = target_name)
     OR EXISTS (SELECT 1 FROM samosval_isolated_admin.target_receipts r WHERE r.target_name = reserve_target.target_name::name)
  THEN RAISE EXCEPTION 'isolated target reservation rejected'; END IF;
  expected_comment := 'samosval-isolated-db:v1;kind=target;runid=' || runid || ';hash=' || target_hash || ';owner=samosval_test_prepared_owner';
  INSERT INTO samosval_isolated_admin.target_receipts
    (target_name, runid, target_hash, expected_owner, kind, marker_version, expected_comment, capability_hash, receipt_generation, state)
    VALUES (target_name, runid, target_hash, 'samosval_test_prepared_owner', 'target', 1, expected_comment, public.digest(capability, 'sha256'), 1, 'reserved');
END $$;

CREATE OR REPLACE FUNCTION samosval_isolated_admin.mark_reserved_target(target_name text, capability text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE receipt samosval_isolated_admin.target_receipts%ROWTYPE; actual_owner text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(target_name, 0));
  SELECT * INTO STRICT receipt FROM samosval_isolated_admin.target_receipts r WHERE r.target_name = mark_reserved_target.target_name::name FOR UPDATE;
  IF receipt.capability_hash <> public.digest(capability, 'sha256') OR receipt.state <> 'reserved' THEN RAISE EXCEPTION 'isolated authority rejected'; END IF;
  SELECT role.rolname INTO actual_owner FROM pg_database d JOIN pg_roles role ON role.oid=d.datdba WHERE d.datname=target_name;
  IF actual_owner IS DISTINCT FROM receipt.expected_owner::text THEN RAISE EXCEPTION 'isolated target identity mismatch'; END IF;
  EXECUTE format('COMMENT ON DATABASE %I IS %L', target_name, receipt.expected_comment);
  UPDATE samosval_isolated_admin.target_receipts SET state='marked' WHERE target_receipts.target_name=mark_reserved_target.target_name::name;
  RETURN receipt.expected_comment;
END $$;

CREATE OR REPLACE FUNCTION samosval_isolated_admin.terminate_exact_target(target_name text, capability text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE receipt samosval_isolated_admin.target_receipts%ROWTYPE; terminated integer := 0; identity_ok boolean; backend record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(target_name, 0));
  SELECT * INTO STRICT receipt FROM samosval_isolated_admin.target_receipts r WHERE r.target_name = terminate_exact_target.target_name::name FOR UPDATE;
  IF receipt.capability_hash <> public.digest(capability, 'sha256') OR receipt.state <> 'marked' OR receipt.kind <> 'target' THEN RAISE EXCEPTION 'isolated authority rejected'; END IF;
  SELECT r.rolname=receipt.expected_owner::text AND s.description=receipt.expected_comment INTO identity_ok
    FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba LEFT JOIN pg_shdescription s ON s.objoid=d.oid AND s.classoid='pg_database'::regclass
    WHERE d.datname=target_name;
  IF identity_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'isolated target identity mismatch'; END IF;
  FOR backend IN SELECT pid FROM pg_stat_activity WHERE datname=target_name AND pid<>pg_backend_pid() LOOP
    SELECT r.rolname=receipt.expected_owner::text AND s.description=receipt.expected_comment INTO identity_ok
      FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba LEFT JOIN pg_shdescription s ON s.objoid=d.oid AND s.classoid='pg_database'::regclass
      WHERE d.datname=target_name;
    IF identity_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'isolated target identity mismatch'; END IF;
    IF pg_terminate_backend(backend.pid) THEN terminated := terminated + 1; END IF;
  END LOOP;
  RETURN terminated;
END $$;

CREATE OR REPLACE FUNCTION samosval_isolated_admin.authorize_drop_target(target_name text, capability text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE receipt samosval_isolated_admin.target_receipts%ROWTYPE; fingerprint jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(target_name, 0));
  SELECT * INTO STRICT receipt FROM samosval_isolated_admin.target_receipts r WHERE r.target_name=authorize_drop_target.target_name::name FOR UPDATE;
  IF receipt.capability_hash <> public.digest(capability, 'sha256') OR receipt.state <> 'marked' OR receipt.kind <> 'target' THEN RAISE EXCEPTION 'isolated authority rejected'; END IF;
  SELECT jsonb_build_object(
      'databaseOid', d.oid::text,
      'ownerOid', owner.oid::text,
      'ownerName', owner.rolname,
      'commentText', description.description,
      'commentHash', encode(public.digest(description.description, 'sha256'), 'hex'),
      'receiptGeneration', receipt.receipt_generation::text,
      'receiptState', receipt.state,
      'capabilityBinding', encode(receipt.capability_hash, 'hex')
    ) INTO fingerprint
    FROM pg_database d
    JOIN pg_roles owner ON owner.oid=d.datdba
    JOIN pg_shdescription description ON description.objoid=d.oid AND description.classoid='pg_database'::regclass
    WHERE d.datname=target_name
      AND owner.rolname=receipt.expected_owner::text
      AND description.description=receipt.expected_comment;
  IF fingerprint IS NULL THEN RAISE EXCEPTION 'isolated target identity mismatch'; END IF;
  RETURN fingerprint;
END $$;

CREATE OR REPLACE FUNCTION samosval_isolated_admin.authorize_partial_drop(target_name text, capability text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE receipt samosval_isolated_admin.target_receipts%ROWTYPE; fingerprint jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(target_name, 0));
  SELECT * INTO STRICT receipt FROM samosval_isolated_admin.target_receipts r WHERE r.target_name=authorize_partial_drop.target_name::name FOR UPDATE;
  IF receipt.capability_hash <> public.digest(capability, 'sha256') OR receipt.state <> 'reserved' OR receipt.kind <> 'target' THEN RAISE EXCEPTION 'isolated authority rejected'; END IF;
  SELECT jsonb_build_object(
      'databaseOid', d.oid::text,
      'ownerOid', owner.oid::text,
      'ownerName', owner.rolname,
      'commentText', COALESCE(description.description, '<absent>'),
      'commentHash', encode(public.digest(COALESCE(description.description, ''), 'sha256'), 'hex'),
      'receiptGeneration', receipt.receipt_generation::text,
      'receiptState', receipt.state,
      'capabilityBinding', encode(receipt.capability_hash, 'hex')
    ) INTO fingerprint
    FROM pg_database d
    JOIN pg_roles owner ON owner.oid=d.datdba
    LEFT JOIN pg_shdescription description ON description.objoid=d.oid AND description.classoid='pg_database'::regclass
    WHERE d.datname=target_name
      AND owner.rolname=receipt.expected_owner::text
      AND description.description IS NULL;
  IF fingerprint IS NULL THEN RAISE EXCEPTION 'isolated partial target identity mismatch'; END IF;
  RETURN fingerprint;
END $$;

ALTER FUNCTION samosval_isolated_admin.reserve_target(text,text,text) OWNER TO CURRENT_USER;
ALTER FUNCTION samosval_isolated_admin.mark_reserved_target(text,text) OWNER TO CURRENT_USER;
ALTER FUNCTION samosval_isolated_admin.terminate_exact_target(text,text) OWNER TO CURRENT_USER;
ALTER FUNCTION samosval_isolated_admin.authorize_drop_target(text,text) OWNER TO CURRENT_USER;
ALTER FUNCTION samosval_isolated_admin.authorize_partial_drop(text,text) OWNER TO CURRENT_USER;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA samosval_isolated_admin FROM PUBLIC, samosval_test_app, samosval_test_runtime, samosval_test_prepared_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA samosval_isolated_admin FROM samosval_test_orchestrator;
GRANT USAGE ON SCHEMA samosval_isolated_admin TO samosval_test_orchestrator;
GRANT EXECUTE ON FUNCTION samosval_isolated_admin.reserve_target(text,text,text), samosval_isolated_admin.mark_reserved_target(text,text), samosval_isolated_admin.terminate_exact_target(text,text), samosval_isolated_admin.authorize_drop_target(text,text), samosval_isolated_admin.authorize_partial_drop(text,text) TO samosval_test_orchestrator;
