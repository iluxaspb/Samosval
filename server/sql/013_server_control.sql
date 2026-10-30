-- Isolated TEST control plane; application records and restore epochs are unchanged.
BEGIN;
DO $guard$ BEGIN IF current_database()<>'samosval_test' THEN RAISE EXCEPTION 'TEST database required'; END IF; END $guard$;
CREATE TABLE IF NOT EXISTS server_control_state (
  channel text PRIMARY KEY CHECK(channel='test'),
  heartbeat timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS server_control_jobs (
  job_id text PRIMARY KEY,
  channel text NOT NULL CHECK(channel='test'),
  uid text NOT NULL,
  type text NOT NULL CHECK(type IN ('check','backup','update','restart','rollback')),
  request_hash text NOT NULL,
  request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed')),
  stage text NOT NULL DEFAULT 'queued',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS server_control_one_job ON server_control_jobs(channel) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS server_control_events (
  event_id bigserial PRIMARY KEY,
  job_id text NOT NULL REFERENCES server_control_jobs(job_id),
  stage text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
