-- Single-writer authority plane.
-- Exactly one provider may accept application writes at any moment.
-- The generation number is monotonic: every switch increments it, so a stale
-- client (or a stale server) can never write after a switch.
BEGIN;

CREATE TABLE IF NOT EXISTS server_authority (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id),
  provider text NOT NULL CHECK (provider IN ('ubuntu','firebase')),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  reason text NOT NULL DEFAULT '',
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO server_authority(workspace_id,provider,generation,reason,updated_by)
VALUES ('main_workspace','ubuntu',1,'initial','system')
ON CONFLICT (workspace_id) DO NOTHING;

-- Append-only switch log. Every accepted switch is recorded before it applies.
CREATE TABLE IF NOT EXISTS server_authority_events (
  event_id bigserial PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  generation bigint NOT NULL,
  provider text NOT NULL,
  previous_provider text,
  reason text NOT NULL DEFAULT '',
  uid text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS server_authority_events_generation
  ON server_authority_events(workspace_id, generation);

-- Presence pulse: which phones and which servers were seen recently.
-- A failover is only declared when many independent phones agree that the
-- primary went silent; one phone losing coverage is not evidence.
CREATE TABLE IF NOT EXISTS server_presence (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  actor_type text NOT NULL CHECK (actor_type IN ('phone','server')),
  actor_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ubuntu','firebase')),
  generation bigint NOT NULL DEFAULT 0,
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, actor_type, actor_id)
);
CREATE INDEX IF NOT EXISTS server_presence_seen ON server_presence(workspace_id, last_seen DESC);

COMMIT;
