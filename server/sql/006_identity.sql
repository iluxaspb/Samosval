BEGIN;
DO $guard$ BEGIN IF current_database()<>'samosval_test' THEN RAISE EXCEPTION 'TEST database required'; END IF; END $guard$;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS profile jsonb NOT NULL DEFAULT '{}';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS protected boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS registration_requests (
  uid text PRIMARY KEY REFERENCES app_users(uid), payload jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE IF NOT EXISTS role_permission_versions (
  role text PRIMARY KEY, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0)
);
INSERT INTO role_permission_versions(role) SELECT DISTINCT role FROM role_permissions ON CONFLICT DO NOTHING;
INSERT INTO role_permission_versions(role) VALUES ('viewer'),('lopater'),('master'),('foreman') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS identity_state (
  id integer PRIMARY KEY CHECK(id=1), initialized boolean NOT NULL DEFAULT false,
  owner_uid text REFERENCES app_users(uid), import_sha256 text
);
INSERT INTO identity_state(id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS identity_receipts (
  operation_id text PRIMARY KEY, uid text NOT NULL, request_hash text NOT NULL,
  result jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS identity_audit (
  operation_id text PRIMARY KEY, uid text NOT NULL, type text NOT NULL,
  target_uid text, before_data jsonb, after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
