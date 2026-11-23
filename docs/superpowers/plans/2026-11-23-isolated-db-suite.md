# Isolated PostgreSQL Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить официальный детерминированный server test suite, где каждый PostgreSQL test-file получает отдельный Node process group и собственную временную PostgreSQL 16 database с versioned manifest, immutable baseline templates, declarative provenance fixtures и fail-closed cleanup.

**Architecture:** Direct shell boundary очищает hostile Node env, ESM orchestrator валидирует полный inventory и через least-privilege orchestration role создаёт один generated target на файл. Foundation сначала строит только `empty/S24`; S25 template появляется лишь после product redesigned 025, S26 — лишь после product 026, поэтому infrastructure не объявляет несуществующую schema и сохраняет `discovered == manifest` в каждом commit. Process scheduler агрегирует machine events без fail-fast, а destructive cleanup допускается только после повторной exact name/owner/COMMENT/state проверки.

**Tech Stack:** Node.js 22 ESM, `node:test` machine-readable events, PostgreSQL 16 (`pg`), POSIX process groups/signals, Docker Compose v2, JSON reports, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-23-isolated-db-suite-design.md`

## Global Constraints

- Только PostgreSQL 16 из локального `server/compose.test.yaml`; live/common/reserve DB/API/container/deploy никогда не участвуют.
- Reserved set включает `samosval_test`, `samosval_working_test_reserve`, `samosval_parallel_shifts_test`, maintenance/templates и configured production names; target только generated current-run name.
- Official boundary: `cd server && ./scripts/test-isolated-db.sh`; shell первым действием удаляет `NODE_OPTIONS`/`NODE_PATH`. npm alias не security boundary.
- Admin URL — только local compose maintenance DB `postgres`, без query/fragment/socket/remote DNS; детям не передаётся.
- Orchestration role: `LOGIN CREATEDB`, не superuser; test/runtime/maintenance roles не superuser/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION и не members NOLOGIN owners.
- Admin database DDL — autocommit statements; provisioning semaphore=1; target lifecycle `creating→created→marked→running`.
- Cleanup требует exact generated name/runid/owner/COMMENT/tracked state и повторную TOCTOU-проверку; mismatch = no destructive query, reported leak, exit 3.
- Manifest перечисляет каждый direct `server/tests/*.test.mjs` ровно один раз и fixtures отдельно; `discovered == manifest` после каждого commit.
- Existing `server/tests/replica-materialize-parallel-shifts.test.mjs` обязателен в initial inventory и не исчезает без atomic same-commit replacement/update.
- Generic untracked `server/tests/fixtures/isolated-db-process.test.mjs` не трогать и не stage до Task 5; в Task 5 он становится зарегистрированной harness fixture.
- До product redesigned 025 machine-readable template chain только `template0→empty→S24`; S25/S26 paths, fixtures и entries не predeclare.
- После product 025 отдельный atomic infrastructure commit добавляет immutable S25 + exact legacy/v2/report/evidence/archive/role fixtures; после product 026 отдельный commit добавляет S26 + staging/objects/users/full-restore fixtures.
- Legacy guard transforms only exact checksum/count spans; source migrations не ослабляются и generic `.replaceAll()` запрещён.
- Unit env — explicit allowlist без любых DB aliases; один DB file = один generated URL + один Node process group.
- `--file` только DB/harness entries, artifact `selection=filtered` и не CI evidence; acceptance только unfiltered full suite twice.
- Каждый task: RED → GREEN → review → отдельный exact commit; никакого `git add .`, broad directory staging или смешения product migrations с infrastructure.
- Реальный historicalization/common DB migration/server deployment/release отсутствуют; fixtures имитируют confirmation только в disposable target.

## Review Focus

1. **TOCTOU marker/owner/state change перед terminate/drop** оставляет DB и exit 3 — `server/tests/isolated-db-lifecycle.test.mjs::cleanup_revalidates_identity_after_toctou` и `::changed_marker_fails_closed` (Task 4).
2. **Hostile unit env с неизвестным DB alias** не достигает child — `server/tests/isolated-db-env.test.mjs::unit_env_is_positive_allowlist_without_any_database_alias` (Task 5).
3. **Падение/timeout первого DB file и ожидающий exclusive HTTP file** не отменяет safe jobs, сохраняет manifest order и exit 1 — `server/tests/isolated-db-runner.test.mjs::failure_continues_and_exclusive_waits_for_all_jobs` (Task 5), `server/tests/isolated-db-http.test.mjs::http_failure_does_not_block_later_file` (Task 9).
4. **Report symlink/hardlink/device/outside parent** отвергается до overwrite с exit 2 — `server/tests/isolated-db-cli.test.mjs::report_path_rejects_aliases_and_non_regular_targets` (Task 10).
5. **Manifest/provenance template drift:** indirect DB consumer or missing existing replica root, S25 SQL-NULL/report/evidence authority mismatch, S26 objects/users tombstone or restore receipt mismatch blocks list/template verification — `server/tests/db-test-discovery.test.mjs::discovered_equals_manifest_including_existing_replica_root` (Task 1), `server/tests/isolated-db-s25-fixtures.test.mjs::s25_provenance_fixtures_match_authority_contract` (Task 6), `server/tests/isolated-db-s26-fixtures.test.mjs::s26_replica_restore_fixtures_match_verifiers` (Task 7).

---

## Плановый статус и история

- `03d497d` — committed historical intermediate: placeholder removal полезен, strict-all-fields/hour/legacy bridge не final. Не amend/rebase; product plan исправляет вперёд отдельными commits.
- `5b06a0591dfdcc9cc67d16715442ff2f8ad53866` — approved design authority для S25/S26 fixture/template postconditions.
- Prior commits не закрывают checkbox этого плана. Отдельный ledger-файл не найден; status фиксируется здесь, в product plan и git history.
- Known untracked `server/tests/fixtures/isolated-db-process.test.mjs` остаётся untouched/uncommitted до Task 5.

## Оценка объёма и фазы

План содержит **12 reviewable infrastructure tasks (Tasks 1–12)** и пять фаз:

1. **S24 foundation:** Tasks 1–5 — inventory, roles/bootstrap, immutable empty/S24, lifecycle, process runner.
2. **S25 transition:** Task 6 только после product parallel-shifts Tasks 2–10.
3. **S26 transition:** Task 7 только после product Tasks 11–15.
4. **Consumer/CLI/CI cutover:** Tasks 8–11.
5. **Двойное полное доказательство:** Task 12.

## Обязательный межплановый порядок

```text
P1 client/source characterization (targeted disposable DB if needed)
→ I1 inventory (includes existing replica-materialize-parallel-shifts root)
→ I2 roles/bootstrap
→ I3 immutable empty/S24
→ I4 lifecycle
→ I5 per-file process runner (generic fixture committed here)
→ P2 role boundary + P3–P10 product redesigned 025/S25
→ I6 immutable S25 + exact provenance/archive fixtures and manifest updates
→ P11–P15 product 026/materializer/full restore
→ I7 immutable S26 + objects/users/staging/full-restore fixtures
→ I8 all DB consumers
→ I9 HTTP
→ I10 CLI
→ I11 CI/docs
→ I12 two full runs
→ remaining product P16+
```

- P = `2026-11-23-parallel-shifts.md`; I = этот план.
- Product 025 creates S25 schema; infrastructure Task 6 only clones/verifies it. Product 026 creates staging; Task 7 only clones/verifies it.
- До Task 6 targeted 025 tests run from S24 with `migrationsThrough:25`; до Task 7 targeted 026 tests run from S25 with `migrationsThrough:26`.
- Каждый новый root test получает manifest entry в том же commit, поэтому нет временного missing/duplicate inventory.

## Карта файлов и общие интерфейсы

### Inventory/discovery

- Create `server/tests/db-test-manifest.mjs`, `server/scripts/isolated-db/{manifest,discovery,hardcoded-db-audit}.mjs`, contract tests.
- Split mixed seed tests into unit/DB roots.
- `loadManifest`, `discoverTests`, `auditHardcodedDatabaseNames`.

### Bootstrap/templates/fixtures

- Modify `server/compose.test.yaml`; create bootstrap shell/SQL, `safety.mjs`, `admin.mjs`.
- Create `legacy-guards.mjs`, `templates.mjs`, `fixtures.mjs`.
- Task 3 produces only `Map<'empty'|'S24',TemplateRecord>`.
- Task 6 extends to S25; Task 7 extends to S26. No interface claims future key before owning commit.

### Lifecycle/execution

- Create `database.mjs`, `env.mjs`, `process.mjs`, `scheduler.mjs`, `reporter.mjs`, `report.mjs`; rewrite orchestrator.
- Interfaces: `makeRunIdentity`, `makeTargetName`, `provisionTarget`, `cleanupTarget`, `leakCheck`, `buildUnitEnv`, `buildDbEnv`, `runProcessGroup`, `scheduleManifestJobs`, `parseNodeEvents`, `writeAtomicReport`, `runCli`.

### Consumer/CI

- Modify each manifest-classified DB root and exact helpers, HTTP root, package/workflow/docs.
- No product SQL/schema behavior is owned here; product migrations are consumed and verified.

## Фаза I — S24 per-file foundation

### Task 1: Complete inventory, discovery and seed split

**Files:**
- Create: `server/tests/db-test-manifest.mjs`
- Create: `server/scripts/isolated-db/manifest.mjs`
- Create: `server/scripts/isolated-db/discovery.mjs`
- Create: `server/scripts/isolated-db/hardcoded-db-audit.mjs`
- Create: `server/tests/db-test-manifest.test.mjs`
- Create: `server/tests/db-test-discovery.test.mjs`
- Replace: `server/tests/seed-{identity,objects}.test.mjs` with four `*-unit`/`*-db` files
- Modify minimally: `server/scripts/test-isolated-db.mjs` for `--list`

**Interfaces:**
- Produces complete versioned root inventory and separate `harnessFixtures` registry.

- [ ] **RED:** tests for missing/duplicate/stale/unknown fields, indirect DB consumer, hardcoded count drift, fixture/root separation, and `discovered_equals_manifest_including_existing_replica_root`; run `cd server && node --test tests/db-test-manifest.test.mjs tests/db-test-discovery.test.mjs`; expect modules absent.
- [ ] **GREEN:** populate every current root, explicitly including `tests/replica-materialize-parallel-shifts.test.mjs`; split seed tests without changing assertions; implement static import graph and minimal DB-free `--list`. Repeat plus `node scripts/test-isolated-db.mjs --list`; expect exact equality.
- [ ] **Review:** no S25/S26 future root/fixture/template entries; fixture under `tests/fixtures` only registry reservation if already tracked—generic untracked process fixture remains untouched.
- [ ] **Commit:** stage each named path exactly, diff-check, commit `test: inventory every server test and split seed suites`.

### Task 2: Least-privilege compose bootstrap and safety predicates

**Files:** modify compose; create bootstrap shell/SQL, `safety.mjs`, `admin.mjs`, bootstrap tests; modify existing compose/guard tests.

**Interfaces:** `validateAdminUrl`, `validateGeneratedIdentifier`, `quoteIdentifier`, `adminPreflight`, `runAdminStatement`; orchestration/test plus run-scoped future owner/runtime/maintenance role creation contract.

- [ ] **RED:** URL/reserved/name/63-byte tests and real role attributes; runtime/test cannot create/drop/read admin URL; owner/member constraints. Run isolated compose with unconditional `down -v`; expect missing bootstrap.
- [ ] **GREEN:** implement loopback compose marker, minimal guarded cleanup function and autocommit closed operation API. Repeat; PASS.
- [ ] **Review:** no credentials output and no owner membership; exact paths commit `test: bootstrap least privilege isolated database roles`.

### Task 3: Immutable empty/S24 templates, legacy guards and pre-S25 fixtures

**Files:** create `legacy-guards.mjs`, `templates.mjs`, `fixtures.mjs`, template/fixture tests; modify helper.

**Interfaces:** `prepareTemplates(context)->Map<'empty'|'S24',TemplateRecord>`; pre-S25 fixture IDs only (`import-schema`, identity/auth/authority/replica-admin/empty-stream).

- [ ] **RED:** exact guard checksum/count tests; chain `template0→empty→S24`, freeze/zero sessions, registry order/leak isolation. Run compose tests; expect absence.
- [ ] **GREEN:** exact span transforms, immutable templates and closed fixture registry; S25/S26 explicitly rejected as unavailable. Repeat; PASS.
- [ ] **Review:** no product 025 correction and no future fixtures; exact commit `test: build immutable S24 test templates`.

### Task 4: Per-file target lifecycle, cleanup and leak check

**Files:** create `database.mjs`, lifecycle test and `fixtures/marker-tamper.test.mjs`; modify manifest.

**Interfaces:** run identity/name, provision/mark/cleanup/templates/leak; monotonic TargetRecord.

- [ ] **RED:** two targets/sentinels, setup/assertion/timeout cleanup, changed marker/owner/prefix/state, TOCTOU, tracked+prefix leak semantics.
- [ ] **GREEN:** semaphore clone/setup, exact COMMENT reread, fail-closed destructive phases. Run compose contract; PASS with deliberate tamper reported.
- [ ] **Review:** templates use distinct cleanup predicate; exact commit `test: provision and safely clean one database per file`.

### Task 5: Per-file process groups, env, scheduler, reporter and runner

**Files:** create execution modules; rewrite `test-isolated-db.mjs`; create/modify runner/env/process tests and fixtures.

**Interfaces:** env builders, `runProcessGroup`, scheduler, reporter, stable report, signal controller.

- [ ] **RED:** positive env allowlist, TERM/grace/KILL/wait, barriers/failure continuation, machine events/skips/redaction, two-target integration. Run `node --test tests/isolated-db-env.test.mjs tests/isolated-db-process.test.mjs tests/isolated-db-runner.test.mjs`; expect missing contracts.
- [ ] **GREEN:** one process group per file, no multi-file Node child, deterministic result order, report/leak/re-emit signal; run targeted two-file compose integration.
- [ ] **Review:** now and only now register/stage existing untracked `server/tests/fixtures/isolated-db-process.test.mjs` with exact other fixture paths; verify contents before staging.
- [ ] **Commit:** exact execution modules/tests/fixtures/manifest, including generic fixture, commit `test: run each database file in an isolated process group`.

**Foundation gate:** Tasks 1–5 GREEN allow product 025 work from S24 per-file targets. They do not claim S25 exists.

## Фаза II — schema transitions owned after product commits

### Task 6: Atomic immutable S25 template and provenance/archive fixtures

**Dependency:** product Tasks P2–P10 committed GREEN; actual redesigned `server/sql/025_parallel_shifts_core.sql` and root tests exist.

**Files:**
- Modify: `server/scripts/isolated-db/templates.mjs`
- Modify: `server/scripts/isolated-db/fixtures.mjs`
- Modify: `server/tests/db-test-manifest.mjs`
- Modify: template/fixture/manifest/discovery tests
- Create: `server/tests/isolated-db-s25-fixtures.test.mjs`

**Interfaces:** extend templates to `empty|S24|S25`; fixtures `parallel-shift-legacy-unresolved`, `parallel-shift-v2-night`, `parallel-shift-cutover-report`, `parallel-shift-restored-contexts`, `archive-immutable-revisions`, `restore-bootstrap-boundary`, `parallel-shift-runtime-role` where schema-appropriate.

- [ ] **RED:** exact conditional provenance matrix/SQL NULL semantics, golden v2 with sender≠creator, canonical report fields/hash/mutation invalidation/no synthetic close, evidence parent-child authority/FK/orphan/double-authority/trigger rollback, archive revision/finalize/latest, runtime/maintenance probes. Run template/fixture/manifest/discovery tests; expect S25 unavailable.
- [ ] **GREEN:** clone S24→S25 applying only redesigned 025, verify checksum/schema/roles, freeze; add fixtures and update baselines/entries for existing migration/archive roots in same commit. No common DB and no actual historicalization outside disposable fixture.
- [ ] **Review:** `discovered==manifest`; exact Firebase v1/v2 and mixed resolution are minimal matrix, not guessed values; report confirmation fixture binds exact bytes/hash.
- [ ] **Commit:** exact listed infrastructure/test/manifest paths, commit `test: add migration 025 provenance baseline`.

### Task 7: Atomic immutable S26 template, replica and full-restore fixtures

**Dependency:** product P11–P15 committed GREEN; actual 026 and actual new roots exist.

**Files:** modify templates/fixtures/manifest and their tests; create `server/tests/isolated-db-s26-fixtures.test.mjs`.

**Interfaces:** extend templates to S26; fixtures `replica-pending-empty`, `replica-pending-out-of-order`, `full-exact-provenance-restore`.

- [ ] **RED:** direction stream/heads all six collections, objects/users settled heads and soft tombstones, status/log pending, parent ordering, collection verifier, strict runtime v2, full bootstrap/deferred receipt/full-only bundle. Run contracts; expect S26 unavailable.
- [ ] **GREEN:** clone S25→S26 applying only 026, freeze, add only real discovered root entries and fixture IDs; targeted product roots each get separate generated DB.
- [ ] **Review:** no placeholder/null strict-v2 shift, no payload in pending, publication receipt FK checked immediate, missing bundle rejected before mutation; `discovered==manifest`.
- [ ] **Commit:** exact paths, commit `test: add migration 026 replica provenance baseline`.

## Фаза III — complete consumer migration and CLI

### Task 8: Migrate every DB consumer to declared generated target

**Files:** every `kind:'db'` path enumerated by manifest, exact helpers/audit/manifest paths only.

**Interfaces:** all DB roots consume injected target/baseline/fixtures; units receive none.

- [ ] **RED:** generate reviewed checklist; representative import/auth/authority/replica tests assert current generated DB and fixture postconditions; filtered runs identify old assumptions.
- [ ] **GREEN:** remove shared resets/hardcoded names, declare exact fixtures; run each DB entry filtered once and all units, then manifest/discovery/list.
- [ ] **Review:** compare `git diff --name-only` to checklist and stage each path explicitly; current test counts are evidence, not fixed future totals.
- [ ] **Commit:** reviewed generated exact add command, diff-check, commit `test: migrate server database suites to generated targets`.

### Task 9: HTTP child process tree and failure continuation

**Files:** modify `truck-phone-http.test.mjs`; create HTTP harness test/followup fixture; modify manifest.

- [ ] **RED:** API grandchild only target DB, exclusive barrier, forced failure still kills descendants/drops target/runs followup.
- [ ] **GREEN:** adapt inherited URL/readiness/teardown; success exit0 and forced variant exit1 with followup PASS.
- [ ] **Review/Commit:** exact four paths, `test: isolate the HTTP server database process tree`.

### Task 10: Final CLI, safe report and hostile shell boundary

**Files:** modify orchestrator/shell/package/runner/process tests; create CLI test and signal fixture.

- [ ] **RED:** options/list/file selection, report alias/device guards, exits 0–4, repeated signals, malicious NODE_OPTIONS characterization.
- [ ] **GREEN:** final CLI and atomic report; run CLI/runner/process tests PASS.
- [ ] **Review:** shell starts with unset; filtered never CI evidence; exact commit `test: finalize isolated suite cli and security boundary`.

## Фаза IV — CI cutover and proof

### Task 11: CI direct runner and factual docs

**Files:** modify `.github/workflows/synology-server-tests.yml`, `server/README.md`, root docs and known-issues, owning static contract.

- [ ] **RED:** no services/shared URL/inline migrations/npm DB path; require compose up, direct full runner, artifact, always down-v.
- [ ] **GREEN:** runtime-generated nonsecret compose credentials, unfiltered artifact upload, factual docs for S24→S25→S26 dependencies and no live DB.
- [ ] **Review:** release/deploy absent; exact commit `ci: run the official suite on isolated compose databases`.

### Task 12: Two unfiltered runs, CI artifact and final gate

**Files:** no planned source changes; focused RED/GREEN defect commits only; generated reports ignored.

- [ ] **Run 1:** fresh compose, direct `./scripts/test-isolated-db.sh --report test-results/isolated-db-suite-run1.json`; require `selection=full`, `discovered==manifest`, `attempted==manifest`, `passed==attempted`, zero unexpected skips/cleanup/leaks/fail/timeout/interruption.
- [ ] **Run 2:** destroy volumes, fresh compose, same manifest hash/counts and all green.
- [ ] **Baselines:** non-DB/tabel/browser/current required workflows; verify no leaked DB/process/port/container/volume and no production diff.
- [ ] **Review:** all five Review Focus, role least privilege, S25 provenance/report/evidence, S26 tombstones/restore receipts, signal/redaction/TOCTOU, no filename classification.
- [ ] **Defects:** each proven defect gets its own fresh RED→GREEN exact commit, then both full runs restart; no product migration mixed in.
- [ ] **Gate:** remaining product P16+ unblocked only after local twice + green CI artifact. No release/server/common DB operation.

## Self-review writing-plans

- **Spec coverage:** Tasks 1–5 cover complete inventory, least privilege, S24 templates, lifecycle and per-file execution; Task 6 owns only post-product S25 template/fixtures; Task 7 only post-product S26; Tasks 8–12 cover every consumer, HTTP, CLI, CI and two-run proof.
- **Step scan:** every task has named RED behavior, concrete command/boundary, GREEN, review and exact staging rule. Generic untracked process fixture is untouched until its owning Task 5.
- **Type consistency:** `prepareTemplates` evolves S24→S25→S26 only in owning commits; fixture names match approved spec; selection/exits/TargetRecord remain stable.
- **Review Focus:** TOCTOU, env aliases, failure continuation, report paths and manifest/S25/S26 provenance drift each have owning tests.
- **Proportion:** no product SQL/function implementation is transcribed; infrastructure interfaces and safety predicates are exact.
- **Dependency check:** foundation stops at S24; product creates 025 before S25 template, product creates 026 before S26 template; no circular dependency.
- **Safety check:** no shared/common/reserve/live target, no actual owner confirmation/historicalization/deploy/release; full-only restore and runtime authority boundaries are test fixtures only.
