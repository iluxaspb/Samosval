BEGIN;
DO $guard$ BEGIN IF current_database()<>'samosval_test' THEN RAISE EXCEPTION 'TEST database required'; END IF; END $guard$;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS restore_epoch bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS workspace_backups (
 workspace_id text NOT NULL REFERENCES workspaces(id),backup_id text NOT NULL,
 meta jsonb NOT NULL,payload jsonb NOT NULL,deleted boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,backup_id)
);
ALTER TABLE line_history ADD COLUMN IF NOT EXISTS dataset_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE workspace_service_audit ADD COLUMN IF NOT EXISTS dataset_epoch bigint NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION set_history_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 NEW.dataset_epoch=(SELECT restore_epoch FROM workspaces WHERE id=NEW.workspace_id);RETURN NEW;END $$;
DROP TRIGGER IF EXISTS line_history_epoch ON line_history;
CREATE TRIGGER line_history_epoch BEFORE INSERT ON line_history FOR EACH ROW EXECUTE FUNCTION set_history_epoch();
DROP TRIGGER IF EXISTS service_history_epoch ON workspace_service_audit;
CREATE TRIGGER service_history_epoch BEFORE INSERT ON workspace_service_audit FOR EACH ROW EXECUTE FUNCTION set_history_epoch();
COMMIT;
