-- Manual TEST-only cleanup. Preserve every fixture row as evidence before removal.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE probe_cleanup_guard (valid boolean NOT NULL CHECK(valid));
INSERT INTO probe_cleanup_guard SELECT current_database()='samosval_test' AND EXISTS (
  SELECT 1 FROM line_trucks WHERE workspace_id='main_workspace'
    AND truck_id='synology_probe_20261030' AND payload->>'brand'='NAS PROBE'
    AND payload->>'number'='TEST' AND (payload->>'isGAI')::boolean=true
);
CREATE TABLE IF NOT EXISTS migration_probe_evidence (
  recorded_at timestamptz NOT NULL DEFAULT now(), evidence jsonb NOT NULL
);
INSERT INTO migration_probe_evidence(evidence) SELECT jsonb_build_object(
  'trucks',(SELECT jsonb_agg(to_jsonb(t)) FROM line_trucks t WHERE workspace_id='main_workspace' AND truck_id='synology_probe_20261030'),
  'statuses',(SELECT jsonb_agg(to_jsonb(t)) FROM line_truck_statuses t WHERE workspace_id='main_workspace' AND truck_id='synology_probe_20261030'),
  'logs',(SELECT jsonb_agg(to_jsonb(t)) FROM line_logs t WHERE workspace_id='main_workspace' AND truck_id='synology_probe_20261030'),
  'receipts',(SELECT jsonb_agg(to_jsonb(t)) FROM line_operation_receipts t WHERE workspace_id='main_workspace' AND operation_id LIKE 'nas_probe_20261030_%'),
  'audit',(SELECT jsonb_agg(to_jsonb(t)) FROM line_audit t WHERE workspace_id='main_workspace' AND operation_id LIKE 'nas_probe_20261030_%')
);
DELETE FROM line_audit WHERE workspace_id='main_workspace' AND operation_id LIKE 'nas_probe_20261030_%';
DELETE FROM line_operation_receipts WHERE workspace_id='main_workspace' AND operation_id LIKE 'nas_probe_20261030_%';
DELETE FROM line_logs WHERE workspace_id='main_workspace' AND truck_id='synology_probe_20261030';
DELETE FROM line_truck_statuses WHERE workspace_id='main_workspace' AND truck_id='synology_probe_20261030';
DELETE FROM line_trucks WHERE workspace_id='main_workspace' AND truck_id='synology_probe_20261030';
COMMIT;
SELECT 'trucks' AS section,count(*) FROM line_trucks
UNION ALL SELECT 'statuses',count(*) FROM line_truck_statuses
UNION ALL SELECT 'logs',count(*) FROM line_logs;
