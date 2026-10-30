BEGIN;
DO $guard$ BEGIN IF current_database()<>'samosval_test' THEN RAISE EXCEPTION 'TEST database required'; END IF; END $guard$;
CREATE TABLE IF NOT EXISTS notification_outbox (
 workspace_id text NOT NULL REFERENCES workspaces(id),event_id text NOT NULL,
 payload jsonb NOT NULL,attempts integer NOT NULL DEFAULT 0,state text NOT NULL DEFAULT 'pending',
 next_attempt timestamptz NOT NULL DEFAULT now(),last_error text,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,event_id)
);
COMMIT;
