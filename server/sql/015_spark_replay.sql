-- TEST ONLY. Durable Spark typed replay progress and log-ID aliases.
-- Deliberately outside the 39 business tables/mirror triggers: control
-- records must not produce forward outbox events or certify handback.
BEGIN;
DO $guard$ BEGIN
 IF current_database()<>'samosval_test' AND current_database() !~ '^sc_verify_[0-9]+$' THEN
  RAISE EXCEPTION 'TEST database required';
 END IF;
END $guard$;

CREATE TABLE IF NOT EXISTS reserve_spark_replay_checkpoint (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 workspace_id text NOT NULL CHECK(workspace_id='main_workspace'),
 generation text NOT NULL CHECK(generation ~ '^[a-f0-9]{24}$'),
 from_epoch bigint NOT NULL CHECK(from_epoch>0),
 base_sequence bigint NOT NULL CHECK(base_sequence>=0),
 base_hash text NOT NULL CHECK(base_hash ~ '^[a-f0-9]{64}$'),
 manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[a-f0-9]{64}$'),
 planned_hash text NOT NULL CHECK(planned_hash ~ '^[a-f0-9]{64}$'),
 event_count integer NOT NULL CHECK(event_count BETWEEN 0 AND 10000),
 applied_count integer NOT NULL DEFAULT 0 CHECK(applied_count>=0),
 outbox_sequence bigint NOT NULL CHECK(outbox_sequence>=0),
 state text NOT NULL DEFAULT 'replaying' CHECK(state IN ('replaying','applied')),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
 last_operation_id text,
 started_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(applied_count<=event_count),
 CHECK((state='applied')=(applied_count=event_count))
);

CREATE TABLE IF NOT EXISTS reserve_spark_log_aliases (
 workspace_id text NOT NULL CHECK(workspace_id='main_workspace'),
 generation text NOT NULL CHECK(generation ~ '^[a-f0-9]{24}$'),
 operation_id text NOT NULL CHECK(operation_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 reserve_log_id text NOT NULL,
 postgres_log_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,generation,reserve_log_id),
 UNIQUE(workspace_id,generation,operation_id),
 UNIQUE(workspace_id,generation,postgres_log_id)
);
COMMIT;
