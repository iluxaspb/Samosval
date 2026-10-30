# Synology candidate: catalogs and shifts

The existing catalog and shift modules/screens stay separate. This change connects their handlers to the NAS client only when the isolated `synology-candidate` build marker is present. Production and the published TEST provider are unchanged. Photos remain excluded.

Catalog create/update/delete, new-truck selection, line membership, shift start/object change and two-phase shift close now use NAS endpoints. Catalog DTOs are unwrapped for existing renderers, with observed record revisions retained for editing. Timesheet-only readers receive object records without the truck directory. Deleted trucks are hidden from current line snapshots; a closing shift remains visible for resuming its material transfer.

Commands are persisted before transmission under origin/workspace/UID scope. Retrying an unknown result reuses the complete original operation, generated record ID, timestamps and expected revisions. Different pending edits are blocked, duplicate clicks share their request, and Web Locks serialize commands across supported browser tabs. Polling is suspended during commands, old subscriptions are closed, and stale direct reads are discarded. A changed login cannot acknowledge another account's command.

Shift closing retains the prepared archive locally until material import and final cleanup are confirmed. Material-transfer failure never sends `finish`. An uncertain finish retries the same operation ID, including after another attempt at closing. Server cleanup remains conditional on the confirmed material marker. No Firebase writes or notification/audit effects are delivered from these NAS branches.

Validation: focused transport/runtime/control checks and the deterministic modular audit are run locally; the PostgreSQL workflow is required before deployment. Full release also requires remaining settings/game/archive UI integration and an authenticated browser cycle with multiple operators. This change does not publish the NAS frontend or claim that full release is ready.
