-- Two-phase close and material marker (design §3.1, §4.6, §5.5, §7, §11,
-- plan Task 22).
--
-- This migration adds only what the close domain needs to be provable:
--
--   * `shifts.close_token` / `close_token_operation_id` — the token returned by
--     `close/prepare` and required by `close/finish`. It is bound to
--     (shiftId, shiftRevision, archive candidate hash) by the writer, and it is a
--     column rather than a payload key so that a payload edit can never forge or
--     silently drop it.
--   * `shift_material_markers` — the confirmed material of one closed shift
--     (design §4.6). One row per shift: a second finish can never create a second
--     transfer. A later archive correction updates the same row with CAS.
--   * `shift_operation_receipts.shift_id` — design §4.5 makes the receipt
--     shift-scoped. Without it a pending server receipt cannot be attributed to a
--     shift at all, so the `409 pending-operations` gate could not exist. The
--     column is nullable: every receipt written before this migration is legacy
--     evidence, and `v2-command.mjs` fills it only when the column is present.
BEGIN;

ALTER TABLE shifts
  ADD COLUMN close_token text,
  ADD COLUMN close_token_operation_id text;

ALTER TABLE shifts
  ADD CONSTRAINT shifts_close_token_pair_check
    CHECK ((close_token IS NULL) = (close_token_operation_id IS NULL)),
  ADD CONSTRAINT shifts_close_token_format_check
    CHECK (close_token IS NULL OR close_token ~ '^[A-Za-z0-9_-]{16,160}$');

CREATE TABLE shift_material_markers (
  workspace_id text NOT NULL,
  shift_id text NOT NULL,
  material_id text NOT NULL CHECK (length(material_id) BETWEEN 1 AND 160),
  -- The exact archive revision the material was confirmed against, so a later
  -- revision can never inherit a stale confirmation.
  source_archive_revision bigint NOT NULL CHECK (source_archive_revision > 0),
  volume numeric NOT NULL CHECK (volume >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by_uid text NOT NULL REFERENCES app_users(uid) ON DELETE RESTRICT,
  PRIMARY KEY (workspace_id, shift_id),
  FOREIGN KEY (workspace_id, shift_id) REFERENCES shifts(workspace_id, shift_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX shift_material_markers_material_idx
  ON shift_material_markers(workspace_id, material_id);

ALTER TABLE shift_operation_receipts
  ADD COLUMN shift_id text;

CREATE INDEX shift_operation_receipts_shift_idx
  ON shift_operation_receipts(workspace_id, shift_id)
  WHERE shift_id IS NOT NULL;

-- Граница ролей §4.4/§4.6: это операционная таблица, а не evidence. У
-- samosval_runtime/samosval_maintenance нет DML на shifts, line_logs,
-- line_truck_statuses, detached_open_trips, поэтому здесь им тоже ничего не
-- выдаётся. Права приложения выдаются отдельно (в изолированной матрице —
-- штатным grantTargetAccess после клонирования), как и для 028.
REVOKE ALL ON TABLE public.shift_material_markers FROM PUBLIC;

COMMIT;
