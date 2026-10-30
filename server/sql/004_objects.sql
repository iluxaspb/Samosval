-- Additive TEST dictionary foundation. Import source documents explicitly.
BEGIN;
DO $guard$ BEGIN IF current_database() <> 'samosval_test' THEN RAISE EXCEPTION 'TEST database required'; END IF; END $guard$;
CREATE TABLE IF NOT EXISTS workspace_objects (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  object_id text NOT NULL,
  payload jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY(workspace_id,object_id)
);
COMMIT;
