-- Additive closing state and immutable server archive. Never clear source trips in this migration.
BEGIN;
DO $guard$ BEGIN IF current_database() <> 'samosval_test' THEN RAISE EXCEPTION 'TEST database required'; END IF; END $guard$;
CREATE TABLE IF NOT EXISTS shift_archives (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  archive_id text NOT NULL,
  shift_id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(workspace_id,archive_id),
  UNIQUE(workspace_id,shift_id)
);
CREATE TABLE IF NOT EXISTS shift_operation_receipts (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  operation_id text NOT NULL,
  uid text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,operation_id)
);
COMMIT;
