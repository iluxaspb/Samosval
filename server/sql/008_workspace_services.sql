-- Additive TEST services. Source import remains immutable; seeding is explicit.
BEGIN;
DO $guard$ BEGIN IF current_database()<>'samosval_test' THEN RAISE EXCEPTION 'TEST database required'; END IF; END $guard$;
CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id),
  payload jsonb NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE IF NOT EXISTS workspace_service_receipts (
  workspace_id text NOT NULL REFERENCES workspaces(id), operation_id text NOT NULL,
  uid text NOT NULL, request_hash text NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS workspace_service_audit (
  workspace_id text NOT NULL REFERENCES workspaces(id), operation_id text NOT NULL,
  uid text NOT NULL, type text NOT NULL, before_data jsonb, after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS archive_overrides (
  workspace_id text NOT NULL REFERENCES workspaces(id), record_id text NOT NULL,
  location text NOT NULL CHECK(location IN ('archive','trash','restored','purged')),
  payload jsonb NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  PRIMARY KEY(workspace_id,record_id)
);
CREATE TABLE IF NOT EXISTS game_records (
  workspace_id text NOT NULL REFERENCES workspaces(id), record_id text NOT NULL,
  collection text NOT NULL CHECK(collection IN ('audit','coinTransactions')),
  payload jsonb NOT NULL, PRIMARY KEY(workspace_id,collection,record_id)
);
CREATE TABLE IF NOT EXISTS workspace_services_state (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id), import_sha256 text NOT NULL
);
ALTER TABLE line_history ADD COLUMN IF NOT EXISTS game_rewards jsonb;
ALTER TABLE line_history ADD COLUMN IF NOT EXISTS game_actor jsonb;
COMMIT;
