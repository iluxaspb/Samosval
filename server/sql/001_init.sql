-- TEST FOUNDATION. PostgreSQL migration; execute explicitly in the isolated TEST database.
-- No production Firestore import or live traffic is performed by this migration.
BEGIN;
CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  cycle_minutes integer NOT NULL DEFAULT 15 CHECK (cycle_minutes BETWEEN 15 AND 10080)
);
CREATE TABLE IF NOT EXISTS app_users (
  uid text PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled'))
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role text NOT NULL,
  action text NOT NULL,
  allowed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (role, action)
);
CREATE TABLE IF NOT EXISTS shifts (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  shift_id text NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, shift_id)
);
CREATE TABLE IF NOT EXISTS line_trucks (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  truck_id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (workspace_id, truck_id)
);
CREATE TABLE IF NOT EXISTS line_truck_statuses (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  truck_id text NOT NULL,
  shift_id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (workspace_id, truck_id),
  FOREIGN KEY (workspace_id, shift_id) REFERENCES shifts(workspace_id, shift_id)
);
CREATE TABLE IF NOT EXISTS line_logs (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  log_id text NOT NULL,
  shift_id text NOT NULL,
  truck_id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (workspace_id, log_id)
);
CREATE TABLE IF NOT EXISTS line_operation_receipts (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  operation_id text NOT NULL,
  uid text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, operation_id)
);
CREATE TABLE IF NOT EXISTS line_audit (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  operation_id text NOT NULL,
  uid text NOT NULL,
  type text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_line_logs_shift ON line_logs(workspace_id, shift_id);
CREATE INDEX IF NOT EXISTS idx_line_receipts_time ON line_operation_receipts(recorded_at);
INSERT INTO workspaces(id) VALUES ('main_workspace') ON CONFLICT DO NOTHING;
COMMIT;
