# Parallel Shifts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать несколько одновременно активных смен-линий с честной legacy provenance, immutable archive revisions, серверной ACL/CAS-изоляцией, exact backup/restore и отдельным restored mode без изменения общей БД до отдельного окна обслуживания.

**Architecture:** Unreleased migration 025 заменяет промежуточную strict-all-fields модель на conditional legacy provenance при сохранении strict v2, role boundary и immutable archive/restored evidence; migration 026 добавляет direction-aware replica stream, heads, pending state machine и parent generations. Runtime принимает только v2, все line/archive команды адресуют явный context, а historicalization, legacy migration и exact restore доступны лишь maintenance entrypoints после проверяемого preflight/confirmation.

**Tech Stack:** Node.js 22 ESM, `node:test`, PostgreSQL 16 (`pg`), SQL migrations 025–027, RFC 8785/JCS + SHA-256, browser JavaScript/CSS/HTML, Chromium/Playwright 393×852, Python 3 build verification, GitHub Actions/Pages.

**Spec:** `docs/superpowers/specs/2026-11-23-parallel-shifts-design.md`

## Global Constraints

- Только локальный PostgreSQL 16 из `server/compose.test.yaml`; live/common/reserve DB, live API и server deploy не используются.
- Фактическая historicalization, migration общей БД и server deploy требуют будущего maintenance window, exact preflight bytes/list/hash и отдельного явного «да» владельца; никакая задача разработки не выполняет их сейчас.
- Working-test/production release в это обновление плана не входит; последующие release tasks сохраняют правила `AGENTS.md`, production всегда требует отдельного согласия.
- `03d497d` — историческое промежуточное evidence, не final implementation; `5b06a05` — approved design authority. История не переписывается: никаких amend/rebase/force-push, только новые reviewable commits.
- 025 остаётся unreleased и может менять checksum; strict v2 всегда требует exact UID/workShift/state/schemaVersion, а v1 допускает `NULL` только для independently marked `opened_by_uid`/`shift_type` provenance.
- Никакого угадывания opener/type по display name, replica sender, restore actor или часу; sender не creator, restored actor не opener.
- Ordinary runtime не может создавать v1/unresolved rows, вызывать historicalization/evidence/migration/exact-restore paths, владеть schema/tables/functions или обходить grants/trigger ownership.
- Replica-owned selective restore отклоняется до checkpoint/DELETE/INSERT/restore_epoch; поддерживается только полный exact provenance bundle и единый bootstrap-before-data order.
- Shift является линией; один truck имеет один current status, максимум один detached open trip; restored context никогда не active shift.
- Все line reads/writes используют `workspace_id AND shift_id`; receipts/audit/mutation атомарны; persisted replay не меняет uid/workspace/shift/protocol/hash.
- Все DB-тесты выполняются через isolated suite на generated per-file DB; до готовности соответствующего S25/S26 template допустим только явно описанный targeted disposable compose rehearsal, никогда shared/common DB.
- Каждый product task проходит RED → GREEN → review и заканчивается отдельным commit с exact paths; `git add .`, directory-wide add и смешение соседних задач запрещены.
- Новая подтверждённая ловушка добавляется в `docs/opyt-oshibok.md` в том же implementation commit; release history меняется только в поздней release task.

## Review Focus

1. **Published golden v2 и identity separation:** exact JSON/timestamp/date classifier принимает только полный v2; replica sender, отличный от creator, и restored actor, отличный от original opener, не подменяют provenance — owning tests `server/tests/parallel-shifts-migration-core.test.mjs::published_v2_night_golden_is_exact` (Task 3), `::replica_sender_is_not_shift_creator` (Task 11), `server/tests/archive-parallel-restore.test.mjs::restored_actor_is_not_original_opener` (Task 7).
2. **Independent resolution + SQL NULL semantics:** identity/type разрешаются независимо; `NULL IN (...)`/unknown enum/equivalence CHECK не обходят contract — owning tests `server/tests/parallel-shifts-migration-core.test.mjs::legacy_resolution_dimensions_are_independent` и `::sql_null_cannot_bypass_provenance_checks` (Task 3).
3. **Historicalization report freshness:** active/closing unresolved не получает synthetic close; mutation assignment/status/unfinished/snapshot/text/redaction invalidates exact report confirmation and leaves source untouched — owning tests `server/tests/parallel-shifts-historicalization.test.mjs::report_mutation_invalidates_confirmation` и `::historicalization_has_no_synthetic_close` (Task 4).
4. **Evidence/revision authority:** orphan/wrong-workspace/double-authority rows, forged authority and trigger rollback fail atomically; concurrent finalize has one winner and every default consumer reads latest finalized while explicit history/export preserves exact bytes — owning tests `server/tests/restored-context-migration.test.mjs::evidence_fk_authority_and_trigger_rollback` (Task 7), `server/tests/archive-store.test.mjs::concurrent_finalize_has_one_latest_winner` (Task 9), `server/tests/archive-read.test.mjs::default_consumers_use_latest_and_history_is_explicit` (Task 10).
5. **Replica/restore generations:** objects/users tombstones pass collection-specific verifier, missing publication receipts/full-only selections fail pre-mutation, and stale parent/concurrent promotion cannot resurrect deleted/newer canonical rows — owning tests `server/tests/replica-pending-materialize.test.mjs::object_user_tombstones_use_collection_verifier` (Task 14), `server/tests/replica-exact-backup.test.mjs::bootstrap_deferred_receipts_and_full_only_rejection` (Task 15), `server/tests/replica-pending-materialize.test.mjs::stale_parent_or_concurrent_promotion_cannot_resurrect` (Task 14).

---

## Плановый статус и граница истории

- Commits `9a59ce3`, `ec44885`, `7cdd9e8`, `1ae36cc`, `03d497d` — evidence предыдущих итераций, но не выполненные checkbox текущего плана.
- `03d497d` сохраняется в истории как полезная строгая остановка placeholder-модели. Следующие commits **переписывают результат вперёд**, не amend/rebase.
- Approved design commit `5b06a0591dfdcc9cc67d16715442ff2f8ad53866` задаёт final provenance/archive authority.
- Ledger-файл в worktree не найден; до появления отдельного ledger источники статуса — этот раздел, git history и approved specs.
- Ничего не считается выполненным только потому, что похожий prior commit существует; каждый checkbox закрывается свежим RED/GREEN/review evidence.

### Impact table для изменений после `03d497d`

| Область | Сохранить | Удалить | Переписать/расширить новым commit |
|---|---|---|---|
| `server/sql/025_parallel_shifts_core.sql` | отсутствие `replica_placeholder`; strict state/object/date/opened_at; object-lock invariants | unconditional `opened_by_uid/shift_type NOT NULL`; hour inference; runtime legacy bridge | conditional provenance, payload version/name snapshot, historical state/report/audit, role split, archive/restored schema |
| `server/src/replica-materialize.mjs` | no `ensureShift()`/no `{}` parent; missing-parent atomicity concept | acceptance/runtime write v1; sender→opener implications; synthetic truck parent | exact v2 classifier, objects/users parents, stable v1 cutover error; staging only after 026 |
| `server/src/replica-store.mjs` | transactional stream/cursor baseline | v1 runtime shift acceptance after cutover | protocol/hash v2, topological validation, immutable generation heads |
| `server/src/shift-archive.mjs` | source shift identity/material calculations that remain valid | hour-derived type | original provenance copy without inference |
| archive stores/read/report consumers | existing user flows as migration source | mutable overrides/synthetic active restored rows as authority | immutable series/revisions/publications, dedicated restored children, latest resolver |
| backup store | pre-restore checkpoint intent | selective replica/provenance restore and replay rebuild | privileged bootstrap + full exact bundle/order/verifier |
| existing tests | object-lock, no-placeholder, transaction rollback assertions | seven unconditional NOT NULL/hour expectations and legacy-success runtime expectations | S25 matrix, report/authority/revision tests; existing root paths retained until same-commit manifest replacement |

## Карта файлов и интерфейсов

### Client/source protocol

- Modify `working-test/source/core/15-shifts.js`; create `working-test/source/core/shift-payload-v2.test.mjs` — `buildShiftPayloadV2({shiftId,object,currentUid,currentDisplayName,workShift,startedAt})` exact published payload.
- Modify `server/src/shift-start.mjs`, `server/tests/shift-start-rules.test.mjs`, `server/tests/shift-start.test.mjs` — NAS v2 requires workShift; no hour fallback.
- Preserve sender envelope in `server/src/replica-store.mjs`; creator comes only from document v2.

### S25 provenance/security/archive

- Rewrite `server/sql/025_parallel_shifts_core.sql`.
- Create `server/scripts/parallel-shifts-role-bootstrap.mjs`, `server/scripts/preflight-parallel-shifts.mjs`.
- Create `server/src/legacy-shift-resolution.mjs`, `server/src/archive-revisions.mjs`, `server/src/restored-context-store.mjs`, `server/src/archive-latest.mjs`.
- Modify `server/src/{identity-rules,shift-archive,archive-store,archive-read,report-store,backup-store}.mjs`.
- Create `server/tests/{parallel-shifts-runtime-roles,parallel-shifts-historicalization,legacy-shift-resolution,restored-context-migration,archive-consumers-latest}.test.mjs`; modify existing migration/archive/backup roots.
- Key interfaces: `classifyShiftPayload(payload,{lookupUser,lookupObject}): ClassifiedShift`; `buildHistoricalizationReport(client,context): Promise<{bytes,sha256,rows}>`; `historicalizeConfirmedLegacy(client,confirmation): Promise<Result>`; `resolveLegacyShift(pool,session,shiftId,command)`; `migrateLegacyRestoredContextExact(...)`; `finalizeRestoredContext(...)`; `readLatestFinalizedArchive(...)`.

### S26 replica/full restore

- Create `server/sql/026_parallel_shift_dependencies.sql`.
- Modify `server/src/{replica-store,replica-materialize,backup-store}.mjs`; create `server/src/replica-heads.mjs` if needed to keep transition/verifier isolated.
- Create `server/tests/{parallel-shifts-migration-dependencies,replica-pending-materialize,replica-exact-backup}.test.mjs`; preserve and rewrite `server/tests/replica-materialize-parallel-shifts.test.mjs` in same manifest-aware commit.
- Key interfaces: `normalizeReplicaOperation`, `hashReplicaOperationV2`, `applyReplicaDocument`, `promoteReplicaPending`, `verifyReplicaHeads`, `normalizeBackupSelection`, `checkpointReplicaBundle`, `restoreReplicaExact`.

### API/domain/client

- Create `server/src/{v2-errors,v2-command,shift-access-v2,shift-read-v2,shift-members-v2,shift-trucks-v2,shift-transfer-v2,line-store-v2,shift-close-v2,v2-router,protocol-gate}.mjs` and focused tests.
- Create `working-test/source/core/{40-shift-contexts,41-v2-transport,42-offline-v2,43-shift-selector,44-shift-management,45-restored-archive,46-detached-trips}.js`, focused tests and `working-test/source/styles/parallel-shifts.css`.
- Existing domain files change only in their owning task; no broad refactor.

## Межплановый dependency graph и execution order

```text
P1 characterization/source payload
  → I1–I5 inventory + roles/templates through immutable S24 + per-file runner
  → P2 role boundary + P3–P10 redesigned 025/S25 product commits
  → I6 immutable S25 template + exact provenance/archive fixtures
  → P11–P15 migration 026/materializer/full restore
  → I7 immutable S26 template + S26 fixtures/manifest entries
  → I8–I12 all-consumer cutover, CI, two full runs
  → P16+ API/client/domain/browser/rehearsal/release gates
```

- `I#` means task in `2026-11-23-isolated-db-suite.md`; infrastructure never invents S25/S26 before product migration exists.
- P1 and characterization tests may use one explicitly generated disposable compose DB. P2+ DB work uses official per-file S24 foundation when available.
- New root test and manifest entry are atomic in the owning product/infrastructure transition commit; `discovered == manifest` after every commit.
- Existing `server/tests/replica-materialize-parallel-shifts.test.mjs` remains in inventory throughout.

## Оценка объёма и фазы

План содержит **31 numbered product tasks и 34 reviewable commit units** в семи фазах: provenance/source (1–5), archive/restored S25 (6–10), replica/restore S26 (11–15), API/domain (16–22), client/UX (23–26), cross-domain acceptance (27–29, где 29A–29C — три commits), rehearsal/release gates (30–31, где 31A и future 31C — отдельные commits). External infrastructure gates не считаются product tasks.

## Фаза I — legacy provenance и redesigned 025

### Task 1: Exact client/source shift payload v2

**Files:**
- Modify: `working-test/source/core/15-shifts.js`
- Create: `working-test/source/core/shift-payload-v2.test.mjs`
- Modify: `server/src/shift-start.mjs`
- Modify: `server/tests/shift-start-rules.test.mjs`
- Modify: `server/tests/shift-start.test.mjs`

**Interfaces:**
- Consumes: current Firebase session UID/display name and selected `workShift`.
- Produces: `buildShiftPayloadV2({shiftId,object,currentUid,currentDisplayName,workShift,startedAt})`; NAS `normalizeShiftStart` requiring `workShift`; sender remains unchanged transport metadata.

- [ ] **RED:** add exact golden JSON test with timestamp `1795453200000`, date `2026-11-23`, `startDate='23.11.2026'`, night, exact key set, `startedByUid=currentUid`; add Firebase sender≠creator passthrough and NAS missing-workShift rejection tests. Run `node --test working-test/source/core/shift-payload-v2.test.mjs server/tests/shift-start-rules.test.mjs`; expect missing schemaVersion/state/UID/workShift behavior.
- [ ] **GREEN:** implement one payload builder used by Firebase writer; make NAS require workShift and remove hour fallback without changing replica envelope data. Repeat command; expect all named tests PASS.
- [ ] **Review:** verify no restore-only aliases, no sender mutation, no release metadata/build output.
- [ ] **Commit:** `git add working-test/source/core/15-shifts.js working-test/source/core/shift-payload-v2.test.mjs server/src/shift-start.mjs server/tests/shift-start-rules.test.mjs server/tests/shift-start.test.mjs && git diff --cached --check && git commit -m "feat: publish exact shift provenance v2"`.

### Task 2: Migration/runtime/maintenance role boundary before 025

**Dependency:** isolated plan Tasks I1–I5 provide S24 per-file target.

**Files:**
- Create: `server/scripts/parallel-shifts-role-bootstrap.mjs`
- Create: `server/tests/parallel-shifts-runtime-roles.test.mjs`
- Modify: `server/compose.test.yaml`
- Modify: `server/scripts/apply-migrations.mjs`

**Interfaces:**
- Consumes: deployment/bootstrap authority, S24 target.
- Produces: schema owner NOLOGIN, narrower evidence owner NOLOGIN, runtime and maintenance executor with exact non-superuser/non-BYPASSRLS/non-membership contracts; `verifyParallelShiftRoleBoundary(client,expected): Promise<RoleProbeReport>`.

- [ ] **RED:** prove runtime is not owner/superuser/BYPASSRLS/member, cannot SET ROLE/direct DML/ALTER/TRIGGER/create-replace/invoke migration path; maintenance has no owner membership and no EXECUTE before grant. Run official `--file tests/parallel-shifts-runtime-roles.test.mjs`; expect role/bootstrap absence.
- [ ] **GREEN:** add idempotent privileged bootstrap separate from data migration and probes; no credentials in repo/log. Repeat; expect exact attributes/ownership/effective privileges PASS.
- [ ] **Review:** verify role split occurs before/atomically with 025, not first in 026; ordinary runtime pool receives only runtime credentials.
- [ ] **Commit:** exact add of four paths, diff-check, commit `feat: establish parallel shift role boundary`.

### Task 3: Migration 025 provenance schema, classifier and backfill

**Files:**
- Rewrite: `server/sql/025_parallel_shifts_core.sql`
- Modify: `server/tests/parallel-shifts-migration-core.test.mjs`
- Modify: `server/src/shift-archive.mjs`
- Modify: `server/tests/shift-archive.test.mjs`

**Interfaces:**
- Consumes: Task 2 roles, Task 1 exact v2, S24 source rows.
- Produces: conditional provenance columns/constraints; `historical` state; strict v2 classifier; exact Firebase v1 unresolved classifier; no runtime legacy bridge.

- [ ] **RED:** replace seven unconditional-NOT-NULL/hour assertions with named tests from Review Focus plus v1 matrix `source/unresolved`, `unresolved/source`, `unresolved/unresolved`; reject v2 manual/unresolved/NULL, unknown enum, malformed timestamp/date/object/state, alias mismatch and SQL three-valued bypass. Run isolated S24→025 file; expect current `03d497d` failures.
- [ ] **GREEN:** add `opened_by_name_snapshot`, `payload_schema_version`, independent resolution columns/checks; keep state/object/name/date/opened_at strict, opener/type conditionally nullable; preserve no-placeholder/object-lock constraints; remove hour/name/sender inference and ordinary legacy bridge. Repeat; expect migration atomic and matrix PASS.
- [ ] **Review:** compare every `03d497d` impact-table row; confirm exact v2 golden and exact Firebase v1 payload, no guessed fields.
- [ ] **Commit:** `git add server/sql/025_parallel_shifts_core.sql server/tests/parallel-shifts-migration-core.test.mjs server/src/shift-archive.mjs server/tests/shift-archive.test.mjs && git diff --cached --check && git commit -m "fix: model legacy shift provenance in migration 025"`.

### Task 4: Versioned historicalization preflight, confirmation and audit

**Files:**
- Create: `server/scripts/preflight-parallel-shifts.mjs`
- Create: `server/src/legacy-historicalization.mjs`
- Create: `server/tests/parallel-shifts-historicalization.test.mjs`
- Modify: `server/sql/025_parallel_shifts_core.sql`

**Interfaces:**
- Produces: `buildHistoricalizationReport(client,context)` exact JCS `samosval.legacy-historicalization/v1`; `recordHistoricalizationConfirmation`; maintenance-only `historicalizeConfirmedLegacy`.

- [ ] **RED:** assert exact operational fields/counts/hashes/text/redaction/expiry/backup fingerprint; mutate every assignment/status-field/unfinished/snapshot/text category and expect hash mismatch + zero mutation; assert historical state, immutable status snapshots, assignment release, untouched children/effects, no `closed_at/by` synthesis and full rollback fault points.
- [ ] **GREEN:** implement read-only report and one-use confirmation binding; controlled transaction locks/rebuilds bytes, snapshots statuses, releases current assignments and writes audit. Tests may generate/confirm fixture reports only on disposable DB; scripts default read-only and never target common DB.
- [ ] **Review:** owner confirmation is exact bytes/hash, not env/GUC/flag; command has no automatic mutation mode.
- [ ] **Commit:** exact four paths, diff-check, commit `feat: gate legacy historicalization by exact report`.

### Task 5: Admin-only manual legacy resolution API/domain

**Files:**
- Create: `server/src/legacy-shift-resolution.mjs`
- Create: `server/tests/legacy-shift-resolution.test.mjs`
- Modify: `server/src/identity-rules.mjs`
- Modify: `server/src/v2-router.mjs` only if router foundation exists; otherwise create focused route adapter `server/src/legacy-shift-resolution-route.mjs`.

**Interfaces:**
- Produces: ACTION `resolve_legacy_shift` admin=true/senior=false; `resolveLegacyShift(pool,session,shiftId,command)` with CAS, canonical advisory lock, receipt and immutable audit.

- [ ] **RED:** active admin success, senior deny, revoked-admin replay deny, evidenceNote validation, one-dimension/manual transitions, concurrent stale loser no receipt/audit, identical replay one receipt/audit, changed hash conflict; closed resolution does not check active uniqueness, separate activation simulation does.
- [ ] **GREEN:** implement route/domain transaction and exact canonical guard key; never clear/replace source/manual; no activation.
- [ ] **Review:** advisory hash only serializes, exact key/constraint decides correctness; audit old/new/evidence/actor/time is append-only.
- [ ] **Commit:** stage exact existing/new route choice plus identity/test, commit `feat: resolve legacy provenance with admin audit`.

## Фаза II — archive/restored S25 amendment

### Task 6: Immutable archive schema and dedicated restored contexts

**Files:**
- Modify: `server/sql/025_parallel_shifts_core.sql`
- Create: `server/tests/archive-schema-025.test.mjs`

**Interfaces:**
- Produces: archive series/revisions/publications; dedicated restored contexts/logs/status snapshots/history/receipts/audit; migration evidence parent/child exact FKs; NOLOGIN evidence ownership.

- [ ] **RED:** schema tests for byte authority, hash links, latest pointer, deferred publication receipt FKs, context/child FKs, evidence UUID parent unique context/source locator, child without duplicated context.
- [ ] **GREEN:** add minimal schema/grants/named immutable triggers and state checks.
- [ ] **Review:** no polymorphic nullable child ownership, no synthetic current status/shift authority.
- [ ] **Commit:** exact SQL/test, commit `feat: add immutable archive and restored context schema`.

### Task 7: Static legacy restored copy-verify-delete migration

**Files:**
- Create: `server/src/restored-context-migration.mjs`
- Create: `server/tests/restored-context-migration.test.mjs`
- Modify: `server/sql/025_parallel_shifts_core.sql`
- Modify: `server/tests/archive-parallel-restore.test.mjs`

**Interfaces:**
- Produces: exact checksummed `migrate_legacy_restored_context_exact(...)` owned by evidence owner; static allow-list, evidence bytes/roots, copy-verify-delete.

- [ ] **RED:** standalone/parallel closure, restored actor≠opener, orphan/wrong workspace/second parent/wrong locator/omission/mutation/double authority; runtime/PUBLIC/GUC/advisory/SET ROLE/arbitrary table denial; injected failure after trigger disable proves source+trigger rollback.
- [ ] **GREEN:** implement lock→manifest→copy/context/evidence→verify→static named trigger disable→exact delete→enable→postconditions; synthetic shift anchor last and never copied.
- [ ] **Review:** no dynamic identifiers/session_replication_role; temporary maintenance EXECUTE then revoke/effective probe.
- [ ] **Commit:** exact three/four paths, commit `feat: migrate restored rows with immutable evidence`.

### Task 8: Restored context correction domain

**Files:**
- Create: `server/src/restored-context-store.mjs`
- Modify: `server/tests/archive-store.test.mjs`
- Modify: `server/src/report-store.mjs`

**Interfaces:**
- Produces: `readRestoredContext`, `submitRestoredCorrection`; only trip/TTN update/delete with context CAS/receipt/audit.

- [ ] **RED:** four allowed operations, active endpoints impossible, source status immutable snapshot, current active status/shift/material untouched, replay/CAS/ACL.
- [ ] **GREEN:** route report operations to dedicated children only.
- [ ] **Review:** restored actor/session separate from original provenance and no activation.
- [ ] **Commit:** exact paths, commit `feat: isolate restored context corrections`.

### Task 9: Archive revision finalize and one-winner CAS

**Files:**
- Create: `server/src/archive-revisions.mjs`
- Modify: `server/src/archive-store.mjs`
- Modify: `server/tests/archive-store.test.mjs`

**Interfaces:**
- Produces: `finalizeRestoredContext(pool,session,contextId,command)`; immutable next bytes/hash/publication, latest pointer CAS.

- [ ] **RED:** hash-linked revisions, one winner under separate connections, stale base untouched, identical replay, changed operation conflict, deferred finalize receipt FK and context finalized once.
- [ ] **GREEN:** lock series/context, validate base/context revisions, build ordered bytes, insert revision/publication/receipt/audit, update pointer/context atomically.
- [ ] **Review:** no normal close/material/tabel/reward effects and original bytes unchanged.
- [ ] **Commit:** exact paths, commit `feat: finalize restored contexts as archive revisions`.

### Task 10: Latest-finalized consumers and explicit history/export

**Files:**
- Create: `server/src/archive-latest.mjs`
- Create: `server/tests/archive-consumers-latest.test.mjs`
- Modify: `server/src/{archive-read,report-store,shift-archive,backup-store,tabel-store,game-store}.mjs` as individually enumerated after `git diff --name-only`.

**Interfaces:**
- Produces: `readLatestFinalizedArchive(client,workspaceId,archiveId)` and explicit `readArchiveRevision/history`.

- [ ] **RED:** list/default open/report/PNG-compatible export/material/analytics/tabel/backup projection all see latest `(archiveId,revision,sha256)`; explicit history/export returns original+all exact bytes/hash; open context/trash does not move pointer.
- [ ] **GREEN:** route consumers through one resolver, preserve explicit revision read-only APIs.
- [ ] **Review:** stage every modified store explicitly; no broad add or unrelated query cleanup.
- [ ] **Commit:** generated exact path list from reviewed diff, diff-check, commit `refactor: read latest finalized archive revision`.

**Gate after Task 10:** isolated plan I6 creates immutable S25 template and fixtures for exact v1/v2/mixed resolution/report/evidence/archive roles. Product Task 11 cannot begin until I6 GREEN.

## Фаза III — migration 026, replica generations and exact restore

### Task 11: Migration 026 stream, heads, pending and dependent attribution

**Files:**
- Create: `server/sql/026_parallel_shift_dependencies.sql`
- Create: `server/tests/parallel-shifts-migration-dependencies.test.mjs`
- Modify: `server/scripts/apply-migrations.mjs`

**Interfaces:**
- Produces: direction PK, protocol/hash versions, immutable stream, heads/pending/deferred invariant, objects/users routing, dependent shift attribution.

- [ ] **RED:** native/marker cursor preflight, no rewrite legacy hashes, exact three head states, NULL semantics, all six collections, collection-specific policy, dependent FKs; migration failure leaves pre-026 schema bytes unchanged.
- [ ] **GREEN:** implement 026 with pre-DDL locked validation, fixed-search-path functions/grants/triggers; no payload in pending.
- [ ] **Review:** 026 extends Task 2 role boundary, never creates it; sender remains transport only; runtime v1 shift stable `protocol-upgrade-required`.
- [ ] **Commit:** exact SQL/test/registry, commit `feat: add replica provenance migration 026`.

### Task 12: Replica v2 normalization/hash and topological parents

**Files:**
- Modify: `server/src/replica-store.mjs`
- Modify: `server/src/replica-materialize.mjs`
- Modify: `server/tests/replica-store.test.mjs`
- Modify: `server/tests/replica-materialize.test.mjs`
- Modify: `server/tests/replica-materialize-parallel-shifts.test.mjs`

**Interfaces:**
- Produces: `normalizeReplicaOperation`, `hashReplicaOperationV2`, topological `objects/users → shift/trucks → status/log`; strict v2 runtime.

- [ ] **RED:** exact golden v2, exact Firebase v1 rejection after cutover, sender≠creator, delete null normalization, id/path mismatch, objects/users head creation, missing object/user rollback, same-batch parent order, v1 byte stability.
- [ ] **GREEN:** prevalidate batch/JCS/hash, preserve document data, classify strict shift v2, materialize parents before children; status/log may defer only after Task 13.
- [ ] **Review:** existing root test stays present and manifest equality is preserved in same commit.
- [ ] **Commit:** exact five paths plus exact manifest path only if already created by I1, commit `feat: enforce replica v2 provenance and parent order`.

### Task 13: Head/pending/delete materializer state machine

**Files:**
- Create: `server/src/replica-heads.mjs`
- Modify: `server/src/replica-materialize.mjs`
- Create: `server/tests/replica-pending-materialize.test.mjs`
- Modify: `server/tests/replica-store.test.mjs`

**Interfaces:**
- Produces: `applyReplicaHeadTransition`, `promoteReplicaPending`, `verifyReplicaHeads`.

- [ ] **RED:** pending permutations, set→set/delete/recreate, status A→pending B, delete-before-parent, stale prevention, real concurrent promotion and fault at each transaction boundary.
- [ ] **GREEN:** common lock order, head CAS, immutable stream reread/revalidate, pending routing only, cursor last.
- [ ] **Review:** lower/equal/newer generation behavior and deferred triggers verified at COMMIT.
- [ ] **Commit:** exact paths, commit `feat: materialize replica documents by generation head`.

### Task 14: Objects/users tombstones and collection verifier

**Files:**
- Modify: `server/src/replica-heads.mjs`
- Modify: `server/src/replica-materialize.mjs`
- Modify: `server/tests/replica-pending-materialize.test.mjs`

**Interfaces:**
- Produces: collection-specific set/delete verifier and soft-tombstone provenance for objects/users.

- [ ] **RED:** object/user replay timestamps stable, recreate/delete generations, referenced object `parent-in-use`, user soft-disable preserving FK, physical delete rejected, stale parent/concurrent promotion cannot resurrect.
- [ ] **GREEN:** implement policy dispatch; generic `physical exists iff canonical_present` forbidden.
- [ ] **Review:** shift/truck/status/log retain their declared physical policies.
- [ ] **Commit:** exact paths, commit `feat: verify replica parent tombstones by collection`.

### Task 15: Full exact provenance backup/bootstrap/restore

**Files:**
- Modify: `server/src/backup-store.mjs`
- Create: `server/src/restore-bootstrap.mjs`
- Create: `server/tests/replica-exact-backup.test.mjs`
- Modify: `server/tests/backup-store.test.mjs`

**Interfaces:**
- Produces: `normalizeBackupSelection`, `verifyRestoreBootstrap`, `checkpointReplicaBundle`, `restoreReplicaExact` using sole spec §4.10 order.

- [ ] **RED:** omission of every provenance/archive/replica/parent member rejected before checkpoint/mutation; missing bootstrap; data path cannot DDL/create roles/admin/code; publication-before-receipt then `SET CONSTRAINTS ALL IMMEDIATE`; missing/dangling/wrong-workspace receipts rollback before verifier/epoch; exact pending/tombstone restore/promote once.
- [ ] **GREEN:** bootstrap fingerprint before transaction; insert exact bundle in normative order; verifier then restore_epoch last; no replay/reclassification/history UPDATE.
- [ ] **Review:** selective replica restore unrepresentable after normalization; temporary maintenance EXECUTE/revoke probes.
- [ ] **Commit:** exact four paths, commit `feat: restore full provenance bundle exactly`.

**Gate after Task 15:** isolated I7 adds immutable S26 template/fixtures and actual root entries; I8–I12 complete cutover and two full runs before Task 16.

## Фаза IV — v2 API и core domains

### Task 16: V2 errors, JCS command hash and receipts

**Files:** create `server/src/v2-errors.mjs`, `server/src/v2-command.mjs`, `server/tests/v2-command.test.mjs`.

**Interfaces:** `v2Error`, `canonicalJson`, `commandHash`, `runV2Command`.

- [ ] RED exact uid/workspace/shift/protocol/operation/type/body hash and replay/rollback tests; run targeted Node test, expect missing exports.
- [ ] GREEN implement finite-JSON JCS and auth-before-replay transaction; repeat PASS.
- [ ] Review receipt/audit/mutation atomicity; commit exact paths as `feat: add v2 command receipt protocol`.

### Task 17: Permissions and shift ACL

**Files:** create `server/sql/027_parallel_shift_permissions.sql`, `server/src/shift-access-v2.mjs`, `server/tests/v2-shift-access.test.mjs`; modify `server/src/identity-rules.mjs`.

**Interfaces:** `loadActor`, `authorizeShift`, `visibleShiftPredicate`; actions member/force-transfer.

- [ ] RED admin/senior/foreman defaults, membership removal, hidden=404, replay ACL tests.
- [ ] GREEN default-deny ACL and active membership; run isolated test PASS.
- [ ] Review resolution action remains admin-only from Task 5; exact commit `feat: add parallel shift permissions and acl`.

### Task 18: Visible list/snapshot and router foundation

**Files:** create `server/src/shift-read-v2.mjs`, `server/src/v2-router.mjs`, `server/tests/v2-shift-read-db.test.mjs`, `server/tests/v2-router.test.mjs`; modify `server/src/index.mjs`.

**Interfaces:** `listVisibleShifts`, `readShiftSnapshot`, `handleV2Request`.

- [ ] RED pagination/order/hidden/trap B/restored excluded/unresolved historical excluded; run isolated files FAIL.
- [ ] GREEN scoped list/snapshot/router; repeat PASS.
- [ ] Review every entity carries workspace/shift; exact commit `feat: add visible shift list and scoped snapshots`.

### Task 19: Shift create/object/members

**Files:** create `server/src/shift-members-v2.mjs`, `server/tests/v2-shift-members-db.test.mjs`; modify router.

**Interfaces:** create/change/add/reactivate/remove methods.

- [ ] RED creator membership, day/night coexist, duplicate race, object lock, membership CAS/last member tests.
- [ ] GREEN strict-v2 creation only; run PASS.
- [ ] Review no legacy resolution/activation shortcut; exact commit `feat: add shift metadata and memberships`.

### Task 20: Truck assignment, force transfer and detached completion

**Files:** create `server/src/shift-trucks-v2.mjs`, `server/src/shift-transfer-v2.mjs`, `server/tests/v2-truck-transfer-db.test.mjs`, `server/tests/v2-detached-completion-db.test.mjs`; modify router.

**Interfaces:** add/remove/force/complete methods.

- [ ] RED one assignment, unfinished/open-detached gates, two-shift CAS/concurrency, source-only completion/replay tests.
- [ ] GREEN common lock order and detached snapshot; run both files PASS including repeated race.
- [ ] Review online-only and no synthetic completion; exact commit `feat: transfer trucks with detached source trips`.

### Task 21: Scoped line operations and object lock

**Files:** create `server/src/line-store-v2.mjs`, `server/tests/v2-line-operations-db.test.mjs`; modify router.

**Interfaces:** `submitLineOperationV2`.

- [ ] RED path/body/hash mismatch, first arrive lock, fallback load, A/B trap, CAS/receipt tests.
- [ ] GREEN scoped updates/audit; PASS.
- [ ] Review no detached ordinary path; exact commit `feat: scope line operations by shift`.

### Task 22: Two-phase close and material marker

**Files:** create `server/src/shift-close-v2.mjs`, `server/tests/v2-shift-close-db.test.mjs`; modify router.

**Interfaces:** prepare/material/finish.

- [ ] RED token/revisions/pending/detached/member removal/A≠B/idempotency tests.
- [ ] GREEN active→closing→closed normal lifecycle only; PASS.
- [ ] Review historical state never enters close; exact commit `feat: close one shift atomically`.

## Фаза V — client contexts and UX

### Task 23: Shift contexts and generation guards

**Files:** create `working-test/source/core/40-shift-contexts.js`, `shift-contexts.test.mjs`; modify `00-config-state.js`.

- [ ] RED independent form/scroll/focus/pending and late full-generation key tests.
- [ ] GREEN context store and read-only legacy projection; PASS.
- [ ] Review restored context separate; exact commit `feat: add isolated client shift contexts`.

### Task 24: V2 transport and offline journal

**Files:** create `41-v2-transport.js`, `42-offline-v2.js` and focused tests; modify session client, NAS runtime, offline replay/trip actions.

- [ ] RED validation, timeout same operation, persisted full scope/hash, account/shift switching, v1 sealed, online-only transfer tests.
- [ ] GREEN transport/polling/journal; PASS with shared hash vector.
- [ ] Review sender/body identity separation and no v1 fallback; exact enumerated commit `feat: add scoped v2 transport and offline journal`.

### Task 25: Selector and management UI

**Files:** create `43-shift-selector.js`, `44-shift-management.js`, tests, CSS; modify shell/line/navigation/shifts/permissions.

- [ ] RED atomic clear/switch, mobile scroll, day/night create, membership/close CAS tests.
- [ ] GREEN UI; Node DOM tests PASS.
- [ ] Review no unresolved historical selector; exact enumerated commit `feat: add parallel shift selector and management`.

### Task 26: Restored mode, archive history and unresolved wording

**Files:** create `45-restored-archive.js`, `46-detached-trips.js`, tests; modify archive/report/shell/management.

**Interfaces:** separate restored context, explicit revision history/export, unresolved labels.

- [ ] RED literal texts `Автор не установлен`, `Тип смены не подтверждён`, restore actor separate, latest/default vs explicit history, detached source labels, forbidden active controls.
- [ ] GREEN separate modes and admin-only resolution form warning; PASS.
- [ ] Review release-history remains untouched until Task 31; exact commit `feat: show provenance and restored archive revisions`.

## Фаза VI — cross-domain and acceptance

### Task 27: Derived effects/source attribution

**Files:** modify exact tabel/material/presence/game/report/history files; create `tests/tabel-v2/parallel-shifts.test.mjs`, `server/tests/v2-derived-effects-db.test.mjs`.

- [ ] RED day/night sheets, dedupe, detached A-only, archive latest material/report, presence A≠B.
- [ ] GREEN explicit shift/source IDs; PASS.
- [ ] Review exact path staging; commit `feat: attribute derived data to source shift`.

### Task 28: Workspace query inventory and trap isolation

**Files:** create `docs/parallel-shifts-query-inventory.md`, `server/tests/v2-query-isolation-db.test.mjs`; modify only named offending stores.

- [ ] RED trap B fingerprint around every A operation.
- [ ] GREEN classify/fix each query; PASS no unclassified.
- [ ] Review no broad refactor; exact commit `fix: enforce shift isolation across queries`.

### Task 29: Protocol gate, server and mobile acceptance

**Files:** create protocol gate/test, server acceptance, browser fixture/test; modify index/control and two workflows only as needed.

- [ ] RED maintenance 503, v1 426, full two-user/two-shift/restored/history flow, no pageerror.
- [ ] GREEN gate/integration gaps; official isolated full suite and Chromium 393×852 PASS.
- [ ] Review Actions required and no production diff; exact separate commits: server gate, server acceptance, browser acceptance (three reviewable commits; if kept as one numbered task, each commit is an explicit subtask 29A/29B/29C and must not be squashed).

## Фаза VII — rehearsal and release gates

### Task 30: Maintenance rehearsal/runbook only

**Files:** create maintenance/verify scripts/test/runbook; modify factual runbook/state/known-issues only if verified.

- [ ] RED dry-run, exact report owner gate, backup hash/fingerprint, ordered phases, no implicit restore/deploy.
- [ ] GREEN rehearse entirely on disposable full copy; PASS.
- [ ] Review common DB/server untouched; exact commit `docs: add parallel shifts maintenance rehearsal`.

### Task 31: Future release and owner-gated maintenance execution

**Files:** release metadata/build artifacts only in release subtask; `docs/releases/parallel-shifts-maintenance-evidence.md` only in future execution subtask.

- [ ] **31A release preparation:** only after all tests/Actions/browser/build checks green, update working-test version/history and exact generated assets per current `AGENTS.md`; no production files. This is not authorized or executed by this plan update.
- [ ] **31B maintenance owner gate:** obtain explicit owner yes for exact window/server/common DB and separately show/confirm exact historicalization report bytes/hash/list after verified full backup. Decline/change aborts untouched.
- [ ] **31C execution:** role bootstrap→maintenance preflight/confirmation→025→026→027→server v2→PWA→smoke/open; record hashes/counts without secrets. Production release remains separate explicit yes.
- [ ] **Commits:** 31A exact release artifact commit; 31C separate evidence-only commit. Never combine release preparation with DB/server execution.

## Финальные verification gates

```bash
# official isolated DB evidence (after isolated plan cutover)
cd server
./scripts/test-isolated-db.sh --report test-results/parallel-shifts-full-1.json
./scripts/test-isolated-db.sh --report test-results/parallel-shifts-full-2.json

# frontend/domain/browser
cd ..
PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/tabel-v2/*.test.mjs working-test/source/core/*.test.mjs working-test/source/features/*.test.mjs
PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node tests/tabel-v2/parallel-shifts-browser.cjs
/home/iluxa/hermes-advisor-test/.venv/bin/python tests/tabel-v2/active-address-browser.py

# source integrity; build only in Task 31A
python3 tools/verify-working-test.py
git diff --exit-code -- index.html manifest.json manifest-production.webmanifest sw.js app/
```

Expected: two unfiltered artifacts with `discovered==manifest`, all attempted/passed, zero unexpected skips/cleanup/leaks; browser console has no pageerror/module errors; required Actions green; common/live DB/server and production files untouched before explicit future gates.

## Self-review writing-plans

- **Spec coverage:** Tasks 1–5 cover client v2, role boundary, redesigned 025 classifier/report/manual resolution; 6–10 cover dedicated restored evidence, archive revisions/finalize/latest consumers; 11–15 cover 026, parents/heads/tombstones/stale state and full exact restore; 16–31 retain full API/client/domain/rollout scope.
- **Step scan:** each task defines exact files/interfaces, named RED behavior, GREEN command/boundary, review and exact or explicitly enumerated staging. Task 29 is explicitly split into three non-squashed review commits; no broad add.
- **Type consistency:** `payloadSchemaVersion/payload_schema_version`, independent resolutions, archive `(archiveId,archiveRevision,archiveSha256)`, evidence parent `evidence_id`, replica `(direction,seq)`, head/pending and restore bootstrap names match approved specs.
- **Review Focus:** all requested golden/sender/restored actor, independent SQL NULL, report invalidation/no synthetic close, evidence/FK/authority/trigger rollback, finalize/latest consumers, tombstones/verifier, restore deferred/full-only and stale/concurrent promotion have owning tests/tasks.
- **Proportion:** plan records decisions/interfaces/tests rather than SQL/function bodies; repeated ordinary TDD detail is compressed only where signatures are already fixed.
- **Dependency check:** `P1 → I1–I5(S24) → P2–P10(S25) → I6 → P11–P15(S26) → I7–I12 → P16+` has no circular S25/S26 dependency.
- **Safety check:** no live/reserve/common DB, deployment or release is performed; future historicalization requires exact report confirmation and separate owner yes; selective replica restore and runtime legacy/evidence access remain forbidden.
