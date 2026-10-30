BEGIN;
DO $guard$ BEGIN IF current_database() <> 'samosval_test' THEN RAISE EXCEPTION 'TEST database required'; END IF; END $guard$;
ALTER TABLE line_trucks ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1 CHECK (revision>0);
CREATE TABLE IF NOT EXISTS control_operation_receipts (
  workspace_id text NOT NULL REFERENCES workspaces(id), operation_id text NOT NULL,
  uid text NOT NULL, request_hash text NOT NULL, result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS control_audit (
  workspace_id text NOT NULL REFERENCES workspaces(id), operation_id text NOT NULL,
  uid text NOT NULL, type text NOT NULL, before_data jsonb, after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,operation_id)
);
COMMIT;
