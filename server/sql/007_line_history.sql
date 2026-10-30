-- Additive TEST journal. Original import and existing receipts remain untouched.
BEGIN;
DO $guard$ BEGIN IF current_database()<>'samosval_test' THEN RAISE EXCEPTION 'TEST database required'; END IF; END $guard$;
CREATE TABLE IF NOT EXISTS line_history (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  action_id text NOT NULL,
  uid text NOT NULL,
  shift_id text NOT NULL,
  truck_id text NOT NULL,
  type text NOT NULL,
  before_status jsonb NOT NULL,
  after_status jsonb NOT NULL,
  log_data jsonb,
  undone boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,action_id)
);
CREATE INDEX IF NOT EXISTS idx_line_history_page ON line_history(workspace_id,created_at DESC,action_id DESC);
CREATE TABLE IF NOT EXISTS history_receipts (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  operation_id text NOT NULL,
  uid text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS history_audit (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  operation_id text NOT NULL,
  uid text NOT NULL,
  action_id text NOT NULL,
  direction text NOT NULL CHECK(direction IN ('undo','redo')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,operation_id)
);
COMMIT;
