-- Driver name travels with the phone, so it lives in the same private table.
-- Additive and safe to re-run: no constraint or data rewrite is involved.
ALTER TABLE truck_phones ADD COLUMN IF NOT EXISTS driver_name text;
