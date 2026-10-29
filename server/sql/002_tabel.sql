-- Additive, TEST-only schema. Does not modify the immutable migration snapshot.
BEGIN;
DO $guard$ BEGIN IF current_database() <> 'samosval_test' THEN RAISE EXCEPTION 'TEST database required'; END IF; END $guard$;
CREATE TABLE IF NOT EXISTS tabel_records (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  record_id text NOT NULL,
  object_id text NOT NULL,
  record_key text NOT NULL,
  payload jsonb NOT NULL,
  baseline_payload jsonb,
  PRIMARY KEY(workspace_id,record_id),
  UNIQUE(workspace_id,record_key)
);
CREATE INDEX IF NOT EXISTS idx_tabel_object ON tabel_records(workspace_id,object_id,record_id);
CREATE TABLE IF NOT EXISTS tabel_receipts (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  operation_id text NOT NULL,
  uid text NOT NULL,
  request_hash text NOT NULL,
  object_id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(workspace_id,operation_id)
);
CREATE INDEX IF NOT EXISTS idx_tabel_receipt_object ON tabel_receipts(workspace_id,object_id,operation_id);
CREATE TABLE IF NOT EXISTS tabel_policy (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id),
  enabled boolean NOT NULL DEFAULT false,
  import_sha256 text NOT NULL
);
COMMIT;
