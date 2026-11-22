CREATE TABLE IF NOT EXISTS truck_phones (
 workspace_id text NOT NULL REFERENCES workspaces(id),
 truck_id text NOT NULL,
 phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
 PRIMARY KEY(workspace_id,truck_id),
 FOREIGN KEY(workspace_id,truck_id) REFERENCES line_trucks(workspace_id,truck_id)
);
