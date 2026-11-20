-- Physical replica deletion removes the private child with its base truck.
-- Backup restore captures this table first and restores parent before child.
ALTER TABLE truck_phones DROP CONSTRAINT truck_phones_workspace_id_truck_id_fkey;
ALTER TABLE truck_phones ADD CONSTRAINT truck_phones_workspace_id_truck_id_fkey
 FOREIGN KEY(workspace_id,truck_id) REFERENCES line_trucks(workspace_id,truck_id) ON DELETE CASCADE;
