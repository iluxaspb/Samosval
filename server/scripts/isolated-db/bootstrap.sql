\set ON_ERROR_STOP on

CREATE ROLE samosval_test_orchestrator LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'orchestrator_password';
CREATE ROLE samosval_test_app LOGIN NOCREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'test_app_password';
CREATE ROLE samosval_test_runtime LOGIN NOCREATEDB NOSUPERUSER NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'runtime_password';

REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT ON DATABASE postgres TO samosval_test_orchestrator;
ALTER ROLE samosval_test_orchestrator IN DATABASE postgres SET samosval.isolated_db_bootstrap = 'samosval-isolated-db-bootstrap:v1';

CREATE SCHEMA samosval_isolated_admin AUTHORIZATION CURRENT_USER;
REVOKE ALL ON SCHEMA samosval_isolated_admin FROM PUBLIC;

CREATE FUNCTION samosval_isolated_admin.terminate_exact_target(
  target_name text,
  expected_runid text,
  expected_owner text,
  expected_comment text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  terminated integer;
BEGIN
  IF target_name !~ ('^samosval_parallel_shifts_test_' || expected_runid || '_[a-f0-9]{12}$')
     OR expected_runid !~ '^[a-f0-9]{12,24}$'
     OR target_name IN ('postgres', 'template0', 'template1', 'samosval_test', 'samosval_working_test_reserve', 'samosval_parallel_shifts_test')
     OR NOT EXISTS (
       SELECT 1
       FROM pg_database d
       JOIN pg_roles r ON r.oid = d.datdba
       LEFT JOIN pg_shdescription s ON s.objoid = d.oid AND s.classoid = 'pg_database'::regclass
       WHERE d.datname = target_name
         AND r.rolname = expected_owner
         AND s.description = expected_comment
         AND expected_comment = ('samosval-isolated-db:v1;kind=target;runid=' || expected_runid || ';hash=' || right(target_name, 12) || ';owner=' || expected_owner)
     )
  THEN
    RAISE EXCEPTION 'isolated target identity mismatch';
  END IF;

  SELECT count(*) INTO terminated
  FROM pg_stat_activity a
  WHERE a.datname = target_name
    AND a.pid <> pg_backend_pid()
    AND pg_terminate_backend(a.pid);
  RETURN terminated;
END;
$$;

REVOKE ALL ON FUNCTION samosval_isolated_admin.terminate_exact_target(text, text, text, text) FROM PUBLIC;
GRANT USAGE ON SCHEMA samosval_isolated_admin TO samosval_test_orchestrator;
GRANT EXECUTE ON FUNCTION samosval_isolated_admin.terminate_exact_target(text, text, text, text) TO samosval_test_orchestrator;
