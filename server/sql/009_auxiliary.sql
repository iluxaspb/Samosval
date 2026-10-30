BEGIN;
DO $guard$ BEGIN IF current_database()<>'samosval_test' THEN RAISE EXCEPTION 'TEST database required'; END IF; END $guard$;
CREATE TABLE IF NOT EXISTS workspace_aux_records (
 workspace_id text NOT NULL REFERENCES workspaces(id),
 collection text NOT NULL CHECK(collection IN ('plugins','patches','audit')),
 record_id text NOT NULL, payload jsonb, revision bigint NOT NULL CHECK(revision>0),
 PRIMARY KEY(workspace_id,collection,record_id)
);
COMMIT;
