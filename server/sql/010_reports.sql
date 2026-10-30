BEGIN;
DO $g$ BEGIN IF current_database()<>'samosval_test' THEN RAISE EXCEPTION 'TEST database required'; END IF; END $g$;
ALTER TABLE workspace_service_audit ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
ALTER TABLE workspace_service_audit ADD COLUMN IF NOT EXISTS undone boolean NOT NULL DEFAULT false;
COMMIT;
