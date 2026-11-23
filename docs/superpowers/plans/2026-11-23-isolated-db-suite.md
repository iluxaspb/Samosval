# Isolated PostgreSQL Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить официальный детерминированный server test suite, в котором каждый PostgreSQL test-file запускается отдельным Node process group на собственной временной БД PostgreSQL 16 с декларативным baseline/fixtures, безопасным cleanup и полным versioned inventory.

**Architecture:** Прямой shell entrypoint очищает hostile Node startup env и передаёт управление ESM orchestrator. Сначала suite строит безопасную основу `empty/S24/S25`; после отдельного product-коммита migration 026 атомарный infrastructure transition добавляет `S26` и replica fixtures/manifest entries. Orchestrator валидирует полный manifest и static discovery, через ограниченную orchestration role клонирует отдельный marked target для каждого DB file, запускает один process group на файл и агрегирует machine-readable Node events без fail-fast. Cleanup разрешён только для exact tracked name/owner/COMMENT/state текущего run; unit и harness-contract фазы получают отдельные explicit env contracts.

**Tech Stack:** Node.js 22 ESM, `node:test` и machine-readable reporter events, PostgreSQL 16 (`pg`), POSIX shell/process groups/signals, Docker Compose v2, JSON reports, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-23-isolated-db-suite-design.md`

## Global Constraints

- Реализация и все DB integration tests используют только PostgreSQL 16 из локального `server/compose.test.yaml`; live/common/reserve БД, API, контейнеры и deployment не участвуют.
- Никогда не использовать как target `samosval_test`, `samosval_working_test_reserve` или исторический `samosval_parallel_shifts_test`; production/common names входят в аддитивный reserved set.
- Официальная security boundary — прямой `cd server && ./scripts/test-isolated-db.sh`; shell первым действием удаляет `NODE_OPTIONS` и `NODE_PATH`. `npm run test:db` — только convenience alias.
- Admin URL указывает только на maintenance database `postgres` подтверждённого local compose PostgreSQL 16, не передаётся детям и запрещает query/fragment/remote DNS/unix socket вне compose contract.
- Orchestration role имеет `LOGIN CREATEDB`, не superuser, и может управлять только exact generated prefix через guarded bootstrap contract; test role имеет `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION` и не видит admin URL.
- Все admin database DDL выполняются отдельными autocommit statements вне transaction; provisioning semaphore всегда равен 1.
- Target lifecycle монотонен `creating → created → marked → running`; child разрешён только после reread exact COMMENT/owner/name и состояния `marked`.
- Cleanup fail closed: missing/changed COMMENT, owner, runid, generated name или tracked state запрещает terminate/drop, записывает safety leak и даёт exit 3.
- SQL identifiers — только ASCII lowercase `[a-z0-9_]`, максимум 63 bytes, безопасно quoted; COMMENT/query values параметризованы. Manifest/argv не поставляют SQL/name fragments.
- Имена target: `samosval_parallel_shifts_test_<runid>_<12hex-file-hash>`, `runid` — минимум 12 lowercase crypto hex; до migration 026 template names используют `tpl_empty|tpl_s24|tpl_s25`, после атомарного transition также `tpl_s26`; templates имеют отдельный cleanup predicate.
- До появления 026 template chain точен: `template0 → empty → S24 → S25`. После отдельного product-коммита 026 infrastructure transition атомарно расширяет chain до `S26`; template после проверки frozen (`datallowconn=false`, CONNECT revoked, zero sessions), custom schema/import/fixtures применяются только к target.
- Migration 025 остаётся strict canonical: `replica_placeholder`, `{}`-shift fixtures и nullable canonical exceptions запрещены. Исторические commits `9a59ce3`, `ec44885`, `7cdd9e8`, `1ae36cc` — evidence предыдущей реализации, а не отметки выполнения amendment.
- Product migration 026/staging не реализуется этим infrastructure plan: suite только потребляет S26 после reviewable product Task 3 parallel-shifts plan; до него manifest не содержит несуществующих S26 paths/fixtures.
- Legacy migration guards меняет только versioned exact registry после source SHA-256 и exact occurrence-count проверки; generic `.replaceAll()` запрещён, исходный migration checksum сохраняется.
- Manifest перечисляет ровно один раз каждый прямой `server/tests/*.test.mjs` с обязательными `kind`, `discovery`, `reason`; DB entries также имеют все DB metadata без неявных defaults. Fixtures под `server/tests/fixtures/` живут только в `harnessFixtures` registry.
- Смешанные seed unit/DB files разделяются до cutover; runtime skip не заменяет классификацию.
- Unit child env строится из explicit allowlist; никакие `PG*`, `POSTGRES_*`, DB URLs, admin/role/marker variables или DB aliases туда не попадают.
- Каждый DB file получает отдельный generated target URL и ровно один Node child process group; несколько DB files никогда не передаются одному `node --test`.
- Execution limit — `min(4, availableParallelism, connectionBudget)`; `--jobs` может только уменьшить предел. `serial` и `exclusive` jobs выполняются без пересечения с любыми другими jobs; manifest order определяет scheduling/report order.
- Обычная ошибка test-file не останавливает остальные; потеря safety invariant прекращает новое provisioning, но cleanup уже созданного продолжается.
- Skip accounting читает machine-readable Node events. В official full suite любой DB skip и любой unknown/changed conditional skip — failure; acceptance требует `unexpectedSkips=0`.
- Report не содержит credentials, full URLs, SQL payload или PII; child output redacted до console/artifact. Atomic report path обязан пройти parent-realpath/symlink/hardlink/device guards.
- Exit codes точны: `0` success; `1` test/setup/timeout/cleanup/leak failure без safety violation; `2` CLI/manifest/discovery/static-audit/report-path configuration error; `3` safety identity/endpoint invariant; `4` internal orchestrator/spawn/reporter error. После signal выполняются cleanup/report/leak check и re-emit исходного signal.
- `--list` не требует compose/admin; `--file` допускает только manifest DB/harness-contract entries, отвергает unit с exit 2 и помечает artifact `selection=filtered`; filtered run никогда не является CI evidence.
- Production files, frontend и product behavior не изменяются; единственная product correction этого плана — Task 0A strict 025. Migration 026 принадлежит parallel-shifts plan.
- Каждая задача проходит RED → GREEN → review и заканчивается отдельным atomic commit с exact path staging; запрещены `git add .`, `git add server`, broad staging и смешивание соседних задач.
- Compose teardown выполняется в `finally`/`trap` для каждого integration/acceptance запуска; никакой успешный или неуспешный прогон не оставляет compose volume/containers.
- Parallel-shifts migration 026 может начаться после GREEN Tasks 1–5 этого плана: manifest/safety/templates/per-file runner должны уметь исполнять S25 file на отдельной БД. Полный cutover Tasks 6–11 и CI evidence продолжаются после атомарного S26 transition; никакой circular dependency с будущим S26 нет.

## Review Focus

1. **Marker/owner/state изменён между pre-drop validation и destructive query:** terminate/drop не выполняются, target остаётся reported leak, suite возвращает exit 3 — owning tests `server/tests/isolated-db-lifecycle.test.mjs::cleanup_revalidates_identity_after_toctou` и `::changed_marker_fails_closed` в Task 4.
2. **Unit child запущен из hostile parent с неожиданным DB alias (`PGSERVICE`, `POSTGRES_FOO`, admin/marker alias):** child не получает переменную и не может случайно подключиться — owning test `server/tests/isolated-db-env.test.mjs::unit_env_is_positive_allowlist_without_any_database_alias` в Task 5.
3. **Первый DB file падает/timeout, пока normal job и затем exclusive HTTP job ещё ожидают:** остальные допустимые jobs продолжаются, exclusive не пересекается, итоговый порядок manifest-stable и exit 1 — owning tests `server/tests/isolated-db-runner.test.mjs::failure_continues_and_exclusive_waits_for_all_jobs` в Task 5 и `server/tests/isolated-db-http.test.mjs::http_failure_does_not_block_later_file` в Task 7.
4. **Report target является symlink/hardlink/device либо parent выходит из approved artifact directory:** runner отвергает путь до запуска с exit 2 и не перезаписывает чужой inode — owning test `server/tests/isolated-db-cli.test.mjs::report_path_rejects_aliases_and_non_regular_targets` в Task 8.
5. **Manifest entry выглядит unit, но indirect import запускает DB helper/API child либо hard-coded DB construction:** discovery/reason mismatch блокирует `--list` и CI до соединения — owning tests `server/tests/db-test-discovery.test.mjs::indirect_consumer_cannot_be_classified_as_unit` и `::hardcoded_name_count_change_fails_audit` в Task 1.

---

## Оценка объёма и фазы

План содержит **12 reviewable задач (Task 0A и Tasks 1–11)** и пять фаз:

1. **Немедленная prerequisite correction:** Task 0A.
2. **S24/S25 manifest, safety и per-file foundation:** Tasks 1–5.
3. **Внешняя product dependency:** parallel-shifts Task 3 создаёт migration 026 и targeted S25→026 tests; это не задача данного плана.
4. **S26 transition и migration suites:** Tasks 6–10 (Task 6 добавляет S26, затем выполняются consumer/HTTP/CLI/CI задачи).
5. **Полное доказательство:** Task 11.

## Обязательный порядок между двумя планами

1. Немедленно выполнить Task 0A: удалить отменённую placeholder-модель из unreleased 025 и старых fixtures/source.
2. Выполнить Tasks 1–5 этого плана до GREEN S25 per-file runner (`manifest/discovery → bootstrap/safety → empty/S24/S25 templates → lifecycle → process/scheduler`).
3. Выполнить parallel-shifts Task 3 (026 staging), Task 3A (deferred materializer) и Task 3B (full-only backup transport) только targeted через per-file S25/S26 transition contract.
4. Выполнить Task 6 этого плана: атомарно добавить S26 template/fixtures/manifest entries, затем Tasks 7–11 и два полных unfiltered runs.
5. Продолжить остальные задачи parallel-shifts. Common DB/deploy остаются только в позднем owner-approved release window.

## Карта файлов

### Manifest, discovery и contracts

- Create: `server/tests/db-test-manifest.mjs` — versioned complete inventory (`manifestVersion`, `entries`, `harnessFixtures`) и только declarative data.
- Create: `server/scripts/isolated-db/manifest.mjs` — schema validation, canonical paths, duplicate/stale/unknown-field validation.
- Create: `server/scripts/isolated-db/discovery.mjs` — full `server/` import/static consumer scan и manifest comparison.
- Create: `server/scripts/isolated-db/hardcoded-db-audit.mjs` — exact file/pattern/count/reason allowlist audit.
- Create: `server/tests/db-test-manifest.test.mjs`, `server/tests/db-test-discovery.test.mjs` — inventory/discovery contracts.
- Replace: `server/tests/seed-identity.test.mjs`, `server/tests/seed-objects.test.mjs` четырьмя unit/DB files.

### PostgreSQL bootstrap, templates и fixtures

- Modify: `server/compose.test.yaml` — PostgreSQL 16 loopback compose, bootstrap secrets from environment, roles/fingerprint marker.
- Create: `server/docker-entrypoint-initdb.d/10-isolated-test-bootstrap.sh` — role creation without repository credentials.
- Create: `server/docker-entrypoint-initdb.d/20-isolated-test-bootstrap.sql` — marker, grants и guarded `SECURITY DEFINER` cleanup function.
- Create: `server/scripts/isolated-db/safety.mjs` — URL/fingerprint/reserved/name/identifier/COMMENT predicates and redaction.
- Create: `server/scripts/isolated-db/admin.mjs` — admin preflight и autocommit DDL API.
- Create: `server/scripts/isolated-db/legacy-guards.mjs` — exact migration guard registry/checksums/counts.
- Create: `server/scripts/isolated-db/templates.mjs` — initial `empty/S24/S25` chain, freeze/postconditions; Task 6 later extends it to S26 only after 026 exists.
- Create: `server/scripts/isolated-db/fixtures.mjs` — initial closed fixture registry; Task 6 adds `replica-pending-empty`/`replica-pending-out-of-order` after 026.
- Create: `server/tests/isolated-db-bootstrap.test.mjs`, `server/tests/isolated-db-templates.test.mjs`, `server/tests/isolated-db-fixtures.test.mjs`.

### Per-file lifecycle и execution

- Create: `server/scripts/isolated-db/database.mjs` — run identity, target records, clone/setup/cleanup/leak check.
- Create: `server/scripts/isolated-db/env.mjs` — explicit unit/harness/DB child env builders.
- Create: `server/scripts/isolated-db/process.mjs` — POSIX detached groups, TERM/grace/KILL/wait and child tracking.
- Create: `server/scripts/isolated-db/scheduler.mjs` — deterministic normal/serial/exclusive scheduler and connection budget.
- Create: `server/scripts/isolated-db/reporter.mjs` — Node event parsing, skip policy, stable aggregation/redaction.
- Create: `server/scripts/isolated-db/report.mjs` — safe atomic JSON artifact writer.
- Rewrite: `server/scripts/test-isolated-db.mjs` — CLI/orchestrator composition only.
- Preserve: `server/scripts/test-isolated-db.sh` — direct hostile-env boundary.
- Create/modify: `server/tests/isolated-db-{lifecycle,env,process,runner,http,cli}.test.mjs` and allowlisted harness fixtures.

### Existing DB consumers

- Modify: all manifest-classified DB files under `server/tests/*.test.mjs` — remove shared-reset/name assumptions, use injected target and declared baseline/fixtures.
- Modify: test-facing code/helpers that hard-code database identity, including `server/tests/helpers/isolated-db.mjs`, seed/import/auth/authority/replica setup and HTTP child startup.
- Do not modify product SQL guards except existing Task 2 product fix; test-only transforms remain registry-controlled.

### Commands, CI и docs

- Modify: `server/package.json` — convenience aliases only; direct shell remains official.
- Modify: `.github/workflows/synology-server-tests.yml` — compose/direct runner/full artifact/always teardown; remove Actions PostgreSQL service/shared URL/inline migrations.
- Modify: `server/README.md`, `docs/runbook.md`, `docs/project-state.md`, `docs/opyt-oshibok.md` — actual verified command, evidence and known issue.
- Production/frontend files remain untouched.

## Общие интерфейсы

```text
loadManifest({serverDir}) -> Promise<ValidatedManifest>
discoverTests({serverDir, manifest}) -> Promise<DiscoveryReport>
auditHardcodedDatabaseNames({serverDir}) -> Promise<AuditReport>
validateAdminUrl(raw, policy) -> AdminEndpoint
adminPreflight({adminUrl, expectedRole, bootstrapMarker}) -> Promise<AdminIdentity>
makeRunIdentity() -> {runid, generatedRunPrefix}
makeTargetName(runIdentity, canonicalFile) -> string
prepareTemplates(context) -> Promise<Map<'empty'|'S24'|'S25'|'S26', TemplateRecord>> // S26 появляется только в Task 6 после 026
applyFixturePlan({targetUrl, entry}) -> Promise<FixtureReport[]>
provisionTarget({entry, template, run}) -> Promise<TargetRecord>
cleanupTarget({admin, target}) -> Promise<CleanupReport>
leakCheck({admin, run, tracked}) -> Promise<LeakReport>
buildUnitEnv(parentEnv) -> Readonly<Record<string,string>>
buildDbEnv(baseEnv, targetRecord) -> Readonly<Record<string,string>>
runProcessGroup(job, hooks) -> Promise<ProcessResult>
scheduleManifestJobs({entries, jobs, connectionBudget}, execute) -> Promise<FileResult[]>
parseNodeEvents(stream, allowedSkips) -> ReporterResult
writeAtomicReport(path, report, approvedDir) -> Promise<void>
runCli(argv, env) -> Promise<number|Signal>
```

`TargetRecord.state` — discriminated union `creating | created | marked | running`; переходы только вперёд. `TemplateRecord.kind` и COMMENT никогда не проходят target cleanup predicate. Все report/result структуры содержат redacted database name/hash, но не URL/userinfo/password.

## Фаза I — граница и декларации

### Task 0A: Prerequisite correction — вернуть strict canonical migration 025

Историческое evidence: commits `9a59ce3`, `ec44885`, `7cdd9e8`, `1ae36cc` формально завершили прежний Task 0, но amendment `53690e0` отменил последнюю placeholder-модель. Историю не переписывать и эти commits не отмечать checkbox-ами текущей задачи.

**Files:**
- Modify: `server/sql/025_parallel_shifts_core.sql`
- Modify: `server/src/replica-materialize.mjs`
- Modify: `server/tests/parallel-shifts-migration-core.test.mjs`
- Modify: `server/tests/replica-materialize-parallel-shifts.test.mjs`
- Modify: existing replica fixtures/tests that insert `{}` or omit full canonical shift fields, exact paths found by `rg 'replica_placeholder|payload.*\{\}' server/tests server/src server/sql`
- Do not modify: runner/template/manifest infrastructure in this commit

**Interfaces:**
- Consumes: unreleased 025 at HEAD `53690e0`; strict shift schema in design §4.1/§4.8.
- Produces: 025 with no `replica_placeholder`; `shifts.state/object_id/object_name_snapshot/work_date/shift_type/opened_at/opened_by_uid` all `NOT NULL`; `shifts_legacy_bridge()` validates canonical payload on every INSERT/UPDATE path; replica materializer no longer manufactures parent shifts; every old fixture inserts a full canonical snapshot or explicitly expects missing-parent failure until 026 exists.

- [ ] **Step 1: Add RED strict-schema and source-absence assertions**

In `parallel-shifts-migration-core.test.mjs`, add `migration_025_has_no_replica_placeholder_and_requires_full_canonical_shift` and `canonical_trigger_rejects_null_or_payload_mismatch_on_all_write_paths`. Assert information_schema has no placeholder column, seven canonical columns are `NO`, constraints/FKs remain strict, and INSERT/UPDATE cannot bypass payload/normalized equality. In `replica-materialize-parallel-shifts.test.mjs`, replace placeholder-success expectations with `status_or_log_before_parent_fails_atomically_until_026`; assert stream transaction leaves no `{}` shift/canonical child.

- [ ] **Step 2: Run RED targeted files on a disposable generated S24 target**

Run: `cd server && ./scripts/test-isolated-db.sh tests/parallel-shifts-migration-core.test.mjs tests/replica-materialize-parallel-shifts.test.mjs`

Expected: FAIL because HEAD still exposes `replica_placeholder` and `ensureShift()` inserts `{}`. This is targeted evidence only; the generic untracked `server/tests/fixtures/isolated-db-process.test.mjs` remains untouched/un-staged.

- [ ] **Step 3: Implement the minimal strict correction**

Remove the column, placeholder shape constraint/trigger branch and placeholder INSERT/UPDATE SQL. Restore canonical `SET NOT NULL` after validated backfill and preserve strict state/type/revision/FK/legacy-active checks plus object-lock immutability. Remove `ensureShift`; missing shift/truck remains an atomic error until migration 026 staging. Update every old replica fixture to a complete canonical snapshot (`id/shiftId`, object aliases, date aliases, type aliases, state/isActive, `startedAt`, `startedByUid`) backed by real object/user rows; do not weaken 025 tests.

- [ ] **Step 4: Run GREEN 025 and existing replica tests**

Run: `cd server && ./scripts/test-isolated-db.sh tests/parallel-shifts-migration-core.test.mjs tests/replica-materialize-parallel-shifts.test.mjs tests/replica-materialize.test.mjs tests/replica-store.test.mjs`

Expected: PASS on generated isolated targets; `rg 'replica_placeholder' server/sql/025_parallel_shifts_core.sql server/src server/tests` returns no source/test reference; no common DB/deploy access.

- [ ] **Step 5: Review and commit exact correction**

```bash
git add server/sql/025_parallel_shifts_core.sql \
  server/src/replica-materialize.mjs \
  server/tests/parallel-shifts-migration-core.test.mjs \
  server/tests/replica-materialize-parallel-shifts.test.mjs \
  <each exact legacy replica fixture/test path actually changed>
git diff --cached --check
git commit -m "fix: restore strict canonical shifts in migration 025"
```

Expected: no plan/runner/manifest/S26 file staged; this commit is the immediate prerequisite for Task 1.

### Task 1: Complete versioned inventory, discovery и seed split

**Files:**
- Create: `server/tests/db-test-manifest.mjs`
- Create: `server/scripts/isolated-db/manifest.mjs`
- Create: `server/scripts/isolated-db/discovery.mjs`
- Create: `server/scripts/isolated-db/hardcoded-db-audit.mjs`
- Create: `server/tests/db-test-manifest.test.mjs`
- Create: `server/tests/db-test-discovery.test.mjs`
- Delete after split: `server/tests/seed-identity.test.mjs`
- Create: `server/tests/seed-identity-unit.test.mjs`
- Create: `server/tests/seed-identity-db.test.mjs`
- Delete after split: `server/tests/seed-objects.test.mjs`
- Create: `server/tests/seed-objects-unit.test.mjs`
- Create: `server/tests/seed-objects-db.test.mjs`

**Interfaces:**
- Consumes: every current direct `server/tests/*.test.mjs`, import graph over all `server/`, exact initial inventory in spec §5.1.
- Produces: `loadManifest({serverDir})`, `discoverTests({serverDir,manifest})`, `auditHardcodedDatabaseNames({serverDir})`; validated entries with explicit DB fields and versioned `harnessFixtures`.

- [ ] **Step 1: Write RED manifest schema/completeness tests**

Add tests named `inventory_lists_every_root_test_exactly_once`, `missing_duplicate_stale_and_unknown_fields_fail`, `db_metadata_has_no_implicit_defaults`, `fixture_cannot_appear_as_root_entry`, `serial_and_exclusive_cannot_both_be_true`, and `exclusive_requires_reason`. Assert canonical realpath stays under `server/tests`, symlinks/traversal/options fail, and fixture registry includes every harness fixture exactly as used.

- [ ] **Step 2: Write RED discovery and hard-coded-name tests**

Add `indirect_consumer_cannot_be_classified_as_unit`, `reason_class_must_match_scan`, `new_unmanifested_root_test_fails`, `hardcoded_name_count_change_fails_audit`. Fixtures must cover direct `pg`, DB env, imported DB helper, `src/index.mjs` child, and a pure import.

- [ ] **Step 3: Run RED tests**

Run: `cd server && node --test tests/db-test-manifest.test.mjs tests/db-test-discovery.test.mjs`

Expected: FAIL because manifest/scanner do not exist.

- [ ] **Step 4: Implement manifest validator and complete inventory**

Populate every current root file from spec §5.1, replacing the two mixed seed names with four explicit entries. Every entry includes `file`, `kind`, `discovery`, concrete Russian `reason`, and all common fields; DB entries additionally declare exact `baseline`, `migrationsThrough`, `customSchema`, `importTables`, `fixtures`, `timeoutMs`, `serial`, `exclusive`, `allowedSkips`. Manifest exports data only, no callbacks.

- [ ] **Step 5: Split seed files without changing assertions**

Move preflight/no-database-access assertions to `*-unit.test.mjs`; move promotion assertions to `*-db.test.mjs`. DB entries declare `identity-empty` + `import-schema` or `import-schema`; no runtime skip remains as classification mechanism.

- [ ] **Step 6: Implement full-server discovery and exact allowlist audit**

Scanner resolves imports from each root test through all `server/`, reports evidence and ambiguity, compares exact root set and manifest set, and validates fixture/root separation. Hard-coded-name allowlist stores exact file + literal/pattern + expected count + reason; changed or vanished count fails rather than silently broadening.

- [ ] **Step 7: Run GREEN contracts and list-only dry validation**

Run: `cd server && node --test tests/db-test-manifest.test.mjs tests/db-test-discovery.test.mjs && node scripts/test-isolated-db.mjs --list`

Expected: PASS; `--list` implementation may be a minimal manifest/discovery-only adapter at this stage and must not read admin URL or connect.

- [ ] **Step 8: Review and commit exact paths**

```bash
git add server/tests/db-test-manifest.mjs \
  server/scripts/isolated-db/manifest.mjs \
  server/scripts/isolated-db/discovery.mjs \
  server/scripts/isolated-db/hardcoded-db-audit.mjs \
  server/tests/db-test-manifest.test.mjs \
  server/tests/db-test-discovery.test.mjs \
  server/tests/seed-identity.test.mjs \
  server/tests/seed-identity-unit.test.mjs \
  server/tests/seed-identity-db.test.mjs \
  server/tests/seed-objects.test.mjs \
  server/tests/seed-objects-unit.test.mjs \
  server/tests/seed-objects-db.test.mjs \
  server/scripts/test-isolated-db.mjs
git diff --cached --check
git commit -m "test: inventory every server test and split seed suites"
```

## Фаза II — PostgreSQL safety и provisioning

### Task 2: Bootstrap roles, marker, reserved guards и admin contracts

**Files:**
- Modify: `server/compose.test.yaml`
- Create: `server/docker-entrypoint-initdb.d/10-isolated-test-bootstrap.sh`
- Create: `server/docker-entrypoint-initdb.d/20-isolated-test-bootstrap.sql`
- Create: `server/scripts/isolated-db/safety.mjs`
- Create: `server/scripts/isolated-db/admin.mjs`
- Create: `server/tests/isolated-db-bootstrap.test.mjs`
- Modify: `server/tests/compose-isolated-db.test.mjs`
- Modify: `server/tests/isolated-db-guard.test.mjs`

**Interfaces:**
- Consumes: compose-only environment credentials and built-in/additive reserved names.
- Produces: `validateAdminUrl`, `validateGeneratedIdentifier`, `quoteIdentifier`, `adminPreflight`, `runAdminStatement`; exact role/fingerprint/cleanup-function bootstrap contract.

- [ ] **Step 1: Write RED pure safety tests**

Cover protocol, loopback/confirmed service host, maintenance DB `postgres`, forbidden query/fragment/percent-encoding/Unicode/truncation, 63-byte boundary, reserved/admin/template names, deterministic 12-hex file hash, runid minimum and collision retry exhaustion. Assert values never enter identifier interpolation and identifiers round-trip quoted.

- [ ] **Step 2: Write RED real PostgreSQL role/bootstrap tests**

On isolated compose assert orchestration attributes exactly `LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION`, test role exactly `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`, bootstrap marker/server fingerprint/PostgreSQL 16, and cleanup function cannot terminate/drop a reserved, foreign-prefix or mismarked DB. Test role cannot create/drop DB or read admin URL.

- [ ] **Step 3: Run RED**

Run with trap: `cd server && docker compose -f compose.test.yaml --profile test up -d --wait; status=0; node --test tests/isolated-db-bootstrap.test.mjs tests/compose-isolated-db.test.mjs tests/isolated-db-guard.test.mjs || status=$?; docker compose -f compose.test.yaml down -v; exit $status`

Expected: FAIL before implementation; teardown always runs.

- [ ] **Step 4: Implement compose bootstrap and preflight**

Credentials come only from environment. Bind PostgreSQL to loopback. Bootstrap creates roles/marker and minimal `SECURITY DEFINER` function that independently checks ASCII prefix, reserved set, exact COMMENT/owner/current run marker and exact datname sessions. `adminPreflight` checks endpoint, database, role, version, addresses and marker before any target DDL.

- [ ] **Step 5: Implement autocommit DDL API**

`runAdminStatement` rejects transaction clients and accepts only closed operation enum + validated identifiers/parameter values. Add integration assertion that `CREATE/ALTER/COMMENT/DROP DATABASE` are issued as separate statements and never inside `BEGIN`.

- [ ] **Step 6: Run GREEN and review least privilege**

Repeat Step 3 command. Expected: PASS, no non-generated DB touched. Review compose rendered config without printing secrets and verify admin URL is absent from child-facing interfaces.

- [ ] **Step 7: Commit exact paths**

```bash
git add server/compose.test.yaml \
  server/docker-entrypoint-initdb.d/10-isolated-test-bootstrap.sh \
  server/docker-entrypoint-initdb.d/20-isolated-test-bootstrap.sql \
  server/scripts/isolated-db/safety.mjs \
  server/scripts/isolated-db/admin.mjs \
  server/tests/isolated-db-bootstrap.test.mjs \
  server/tests/compose-isolated-db.test.mjs \
  server/tests/isolated-db-guard.test.mjs
git diff --cached --check
git commit -m "test: bootstrap least privilege isolated database roles"
```

### Task 3: Immutable templates, exact legacy guards и fixture registry

**Files:**
- Create: `server/scripts/isolated-db/legacy-guards.mjs`
- Create: `server/scripts/isolated-db/templates.mjs`
- Create: `server/scripts/isolated-db/fixtures.mjs`
- Create: `server/tests/isolated-db-templates.test.mjs`
- Create: `server/tests/isolated-db-fixtures.test.mjs`
- Modify: `server/tests/helpers/isolated-db.mjs`

**Interfaces:**
- Consumes: Task 2 admin API; canonical SQL migrations 001–025.
- Produces: `transformLegacyGuards({filename,source,targetName})`, initial `prepareTemplates(context)` map `empty|S24|S25`, `applyFixturePlan({targetUrl,entry})`; pre-026 registry IDs from spec §3.12 only. Task 6 extends these interfaces to S26/replica-pending IDs.

- [ ] **Step 1: Write RED guard registry tests**

For each guarded migration assert exact source SHA-256, exact source text, exact count and replacement only after generated target validation. Test zero/extra occurrence, changed whitespace, unknown guard, wrong checksum/non-generated target all fail before SQL; report contains file/count/hash but no SQL payload.

- [ ] **Step 2: Write RED real template lifecycle tests**

Assert exact chain `template0 → empty → S24 → S25`, ownership/privileges, migration registry/checksums/postconditions, freeze timing (`empty` after S24 clone, S24 after S25 clone, S25 after verify), `datallowconn=false`, CONNECT revoked and zero sessions. Assert template COMMENT kind cannot pass target cleanup.

- [ ] **Step 3: Write RED fixture registry tests**

Cover only `import-schema`, `identity-empty`, `auth-schema-018`, `authority-main-ubuntu`, `authority-main-firebase`, `replica-admin`, `replica-empty-stream-cursors`; verify registry order, exact rows/emptiness/indexes/constraints/sequences and authority conflict rule. Clone a second target and prove first target fixture never leaks into template/second target.

- [ ] **Step 4: Run RED with compose teardown**

Run: `cd server && docker compose -f compose.test.yaml --profile test up -d --wait; status=0; SAMOSVAL_ISOLATED_TEST=1 SAMOSVAL_TEST_ADMIN_URL="$ADMIN_URL" node --test tests/isolated-db-templates.test.mjs tests/isolated-db-fixtures.test.mjs || status=$?; docker compose -f compose.test.yaml down -v; exit $status`

Expected: FAIL because registries/templates are absent.

- [ ] **Step 5: Implement exact guard registry and template builder**

Remove generic `retargetLegacyGuard().replaceAll()` from helper. Keep original checksum registration, transform only approved spans, migrate as test role, freeze templates exactly once, and leave a failed clone source closed.

- [ ] **Step 6: Implement fixture registry/postconditions**

Registry entries are closed functions selected by manifest IDs, operate only on supplied target pool, cannot open another DB, and return machine-checkable postcondition reports. `migrationsThrough` runs after target clone and cannot be below baseline.

- [ ] **Step 7: Run GREEN and review immutability**

Repeat Step 4 command. Expected: PASS with no template sessions and no generated DB after test cleanup.

- [ ] **Step 8: Commit exact paths**

```bash
git add server/scripts/isolated-db/legacy-guards.mjs \
  server/scripts/isolated-db/templates.mjs \
  server/scripts/isolated-db/fixtures.mjs \
  server/tests/isolated-db-templates.test.mjs \
  server/tests/isolated-db-fixtures.test.mjs \
  server/tests/helpers/isolated-db.mjs
git diff --cached --check
git commit -m "test: build immutable migration templates and fixtures"
```

### Task 4: Per-file target provision, cleanup и leak-check

**Files:**
- Create: `server/scripts/isolated-db/database.mjs`
- Create: `server/tests/isolated-db-lifecycle.test.mjs`
- Create: `server/tests/fixtures/marker-tamper.test.mjs`

**Interfaces:**
- Consumes: Task 2 safety/admin, Task 3 templates/fixtures.
- Produces: `makeRunIdentity`, `makeTargetName`, `provisionTarget`, `markTargetRunning`, `cleanupTarget`, `cleanupTemplates`, `leakCheck`; monotonic `TargetRecord` state.

- [ ] **Step 1: Write RED lifecycle success tests**

Provision two files concurrently through provisioning semaphore and assert unique names/DBs, exact owner/comment/file hash, no cross-sentinel, clone baseline and manifest fixture order. Assert child start callback is unreachable until `marked` reread succeeds.

- [ ] **Step 2: Write RED failure and Review Focus tests**

Add setup failure cleanup, ordinary assertion cleanup, timeout cleanup, `changed_marker_fails_closed`, changed owner, non-prefix, reserved/admin/template target, foreign runid, `creating|created` receipt rule, and `cleanup_revalidates_identity_after_toctou`. Spy on guarded admin calls and assert no terminate/drop on mismatch.

- [ ] **Step 3: Write RED leak tests**

Use exact tracked set union `starts_with(datname, generatedRunPrefix)`, never LIKE/regex. Current-run valid leak causes exit-class 1; mismatched identity causes safety-class 3 and no deletion; old foreign run is reported but never automatically deleted.

- [ ] **Step 4: Run RED on compose and teardown**

Run lifecycle file via direct shell/contract harness against isolated compose. Expected: FAIL before implementation; final compose `down -v` unconditional.

- [ ] **Step 5: Implement provision/state machine**

Create exact target from frozen template, set owner/minimal privileges, COMMENT with version/runid/fileHash/owner, reread identity, then transition to `marked`; apply post-clone migrations/schema/import/fixtures without mutating template.

- [ ] **Step 6: Implement fail-closed cleanup/leak check**

Revalidate endpoint/name/prefix/runid/owner/COMMENT/state immediately before each destructive phase; revoke/disable target, exact terminate via guarded function, wait zero sessions, exact quoted drop. Templates use separate tracked predicate and are removed after targets.

- [ ] **Step 7: Run GREEN and deliberate tamper review**

Expected: all lifecycle tests pass; tampered DB remains as a named redacted leak for manual test teardown only, and test teardown removes it through its own isolated fixture mechanism—not product cleanup predicate.

- [ ] **Step 8: Commit exact paths**

```bash
git add server/scripts/isolated-db/database.mjs \
  server/tests/isolated-db-lifecycle.test.mjs \
  server/tests/fixtures/marker-tamper.test.mjs \
  server/tests/db-test-manifest.mjs
git diff --cached --check
git commit -m "test: provision and safely clean one database per file"
```

## Фаза III — execution и suite migration

### Task 5: POSIX process groups, scheduler, Node events и stable report

**Files:**
- Create: `server/scripts/isolated-db/env.mjs`
- Create: `server/scripts/isolated-db/process.mjs`
- Create: `server/scripts/isolated-db/scheduler.mjs`
- Create: `server/scripts/isolated-db/reporter.mjs`
- Create: `server/scripts/isolated-db/report.mjs`
- Rewrite: `server/scripts/test-isolated-db.mjs`
- Modify: `server/tests/isolated-db-runner.test.mjs`
- Create: `server/tests/isolated-db-env.test.mjs`
- Create: `server/tests/isolated-db-process.test.mjs`
- Keep and register: `server/tests/fixtures/isolated-db-process.test.mjs`
- Create: `server/tests/fixtures/isolated-db-env-dump.test.mjs`
- Create: `server/tests/fixtures/isolated-db-fail.test.mjs`
- Create: `server/tests/fixtures/isolated-db-skip.test.mjs`
- Create: `server/tests/fixtures/isolated-db-descendant.test.mjs`

**Interfaces:**
- Consumes: Tasks 1/4 manifest and per-file lifecycle.
- Produces: env builders, `runProcessGroup`, deterministic scheduler, Node event parser, stable redacted `SuiteReport`; interrupt controller with original signal.

- [ ] **Step 1: Write RED explicit env tests**

`unit_env_is_positive_allowlist_without_any_database_alias` seeds parent with every `PG*`, `POSTGRES_*`, target/admin URLs, credentials, marker aliases, `NODE_OPTIONS/PATH` and unrelated secret. Assert only versioned allowlist survives. DB env adds only generated target URL, `SAMOSVAL_ISOLATED_TEST=1`, run/target marker; harness env receives only per-contract keys.

- [ ] **Step 2: Write RED process/signal tests**

Assert one detached POSIX process group per file, timeout sends TERM then fixed grace then KILL, waits/reaps descendants, closes pools before cleanup, handles `SIGINT/SIGTERM/SIGHUP`, records first signal atomically, ignores repeat for control flow, writes report/leak check then re-emits original signal.

- [ ] **Step 3: Write RED scheduler/failure-continuation tests**

Cover `min(4, availableParallelism, connectionBudget)`, `--jobs` decrease-only, provisioning max concurrency 1, stable manifest order, serial/exclusive full barriers, and `failure_continues_and_exclusive_waits_for_all_jobs`. First failed file must not cancel later safe jobs; safety loss must stop new provisioning.

- [ ] **Step 4: Write RED machine event/report tests**

Feed real Node machine-readable events: pass/fail/skip/timeout/signal. Assert skip matched by name/reason/condition, unexpected DB skip fails, inactive allowed skip also fails, console completion order does not change final order, credentials/encoded credentials/full URL/PostgreSQL context are redacted.

- [ ] **Step 5: Run RED contract files without DB where possible**

Run: `cd server && node --test tests/isolated-db-env.test.mjs tests/isolated-db-process.test.mjs tests/isolated-db-runner.test.mjs`

Expected: FAIL for missing modules/contracts.

- [ ] **Step 6: Implement minimal runner composition**

Rewrite old shared phases completely: no `destructive/nondestructive/phases`, no filename predicate, no multi-file `node --test`. Each job receives exactly one manifest path and process group. Use official reporter event channel, not grep human output.

- [ ] **Step 7: Run GREEN unit contracts and real two-target integration**

Run unit files, then direct `./scripts/test-isolated-db.sh --file <two registered harness/db contract selections as supported>` against compose. Expected: distinct PIDs/DB names, sentinel isolation, deterministic report, teardown clean.

- [ ] **Step 8: Review signal order and commit exact paths**

```bash
git add server/scripts/isolated-db/env.mjs \
  server/scripts/isolated-db/process.mjs \
  server/scripts/isolated-db/scheduler.mjs \
  server/scripts/isolated-db/reporter.mjs \
  server/scripts/isolated-db/report.mjs \
  server/scripts/test-isolated-db.mjs \
  server/tests/isolated-db-runner.test.mjs \
  server/tests/isolated-db-env.test.mjs \
  server/tests/isolated-db-process.test.mjs \
  server/tests/fixtures/isolated-db-process.test.mjs \
  server/tests/fixtures/isolated-db-env-dump.test.mjs \
  server/tests/fixtures/isolated-db-fail.test.mjs \
  server/tests/fixtures/isolated-db-skip.test.mjs \
  server/tests/fixtures/isolated-db-descendant.test.mjs \
  server/tests/db-test-manifest.mjs
git diff --cached --check
git commit -m "test: run each database file in an isolated process group"
```

### Task 6: Атомарно добавить S26 template, fixtures и реальные manifest entries

**Dependency gate:** начинается только после GREEN Tasks 1–5 и после отдельного parallel-shifts product commit, который создаёт `server/sql/026_parallel_shift_dependencies.sql` и реальные root tests. До этого шага S26 в machine-readable manifest/templates отсутствует.

**Files:**
- Modify: `server/scripts/isolated-db/templates.mjs`
- Modify: `server/scripts/isolated-db/fixtures.mjs`
- Modify: `server/tests/db-test-manifest.mjs`
- Modify: `server/tests/isolated-db-templates.test.mjs`
- Modify: `server/tests/isolated-db-fixtures.test.mjs`
- Modify: `server/tests/db-test-manifest.test.mjs`

**Interfaces:**
- Consumes: `prepareTemplates(context)` for `empty|S24|S25`; canonical migration 026; actual discovered `parallel-shifts-migration-dependencies.test.mjs` and `replica-pending-materialize.test.mjs` paths if created by the product tasks.
- Produces: `prepareTemplates(context) -> Map<'empty'|'S24'|'S25'|'S26',TemplateRecord>`; fixture IDs `replica-pending-empty`, `replica-pending-out-of-order`; exact S26 entries with `baseline:'S25',migrationsThrough:26` for migration tests and `baseline:'S26'` for runtime staging tests.

- [ ] **Step 1: Add RED S26 transition tests**

Add `s26_is_absent_before_026_and_atomic_after_026`, `s26_applies_only_026_and_freezes_with_zero_sessions`, `replica_pending_fixtures_require_s26`, and `manifest_adds_only_discovered_s26_root_files`. Assert S26 checksum/postconditions include direction-aware stream PK, protocol/hash versions, immutable trigger/roles, heads/pending exact checks/deferred triggers; fixture contains no payload copy and every `shifts` row is strict canonical.

- [ ] **Step 2: Run RED through the S25 per-file foundation**

Run: `cd server && node --test tests/isolated-db-templates.test.mjs tests/isolated-db-fixtures.test.mjs tests/db-test-manifest.test.mjs`

Expected: FAIL because S26 transition is not registered; the pre-transition commit remains valid with `discovered == manifest`.

- [ ] **Step 3: Implement the atomic S26 extension**

Extend chain exactly `S25 → S26`, freeze S25 only after S26 clone, validate migration 026 checksum/schema/roles, and register only fixtures/root paths that now exist. `replica-pending-out-of-order` references immutable stream rows and heads/pending routing; it never inserts placeholder/null shifts or copies payload into staging.

- [ ] **Step 4: Run GREEN S26 contracts and targeted product files**

Run: `cd server && node --test tests/isolated-db-templates.test.mjs tests/isolated-db-fixtures.test.mjs tests/db-test-manifest.test.mjs tests/db-test-discovery.test.mjs && ./scripts/test-isolated-db.sh --file tests/parallel-shifts-migration-dependencies.test.mjs --file tests/replica-pending-materialize.test.mjs`

Expected: PASS; filtered report says `selection=filtered`, both files have separate generated DBs, cleanup/leaks zero. If only one product root file exists, list only that real path—never predeclare the future path.

- [ ] **Step 5: Commit exact transition paths**

```bash
git add server/scripts/isolated-db/templates.mjs \
  server/scripts/isolated-db/fixtures.mjs \
  server/tests/db-test-manifest.mjs \
  server/tests/isolated-db-templates.test.mjs \
  server/tests/isolated-db-fixtures.test.mjs \
  server/tests/db-test-manifest.test.mjs
git diff --cached --check
git commit -m "test: add migration 026 isolated baseline"
```

### Task 7: Migrate every DB consumer, hard-coded name и fixture dependency

**Files:**
- Modify: every `kind:'db'` path listed in `server/tests/db-test-manifest.mjs`
- Modify: `server/tests/helpers/isolated-db.mjs`
- Modify as static audit requires: test setup/import/auth/authority/replica helper paths under `server/tests/`, `server/src/` and `server/scripts/`
- Modify: `server/tests/db-test-manifest.mjs`
- Modify: `server/scripts/isolated-db/hardcoded-db-audit.mjs`

**Interfaces:**
- Consumes: generated target env and baseline/fixture contract.
- Produces: all DB tests runnable on their declared fresh target without global reset/shared seed/hard-coded name; unit tests runnable with zero DB env.

- [ ] **Step 1: Generate the migration checklist from manifest/discovery**

Run `--list` in verbose machine format and capture every DB entry’s consumer evidence, baseline, migrationsThrough and fixture IDs. Review every initial inventory row; do not batch-stage by directory.

- [ ] **Step 2: Add RED tests for representative hard-coded/setup failures**

For import, identity/auth, authority and replica groups assert current DB equals injected generated target, fixture postconditions exist, and no helper can open another DB. Add a unit-phase contract that all unit entries pass under explicit allowlist and fail rather than skip when undeclared DB dependency is introduced.

- [ ] **Step 3: Run representative RED groups through direct runner**

Use repeatable `--file` only for targeted development; expected initial failures identify missing baseline/fixture assumptions. Reports must say `selection=filtered` and are not CI evidence.

- [ ] **Step 4: Migrate DB files in reviewable sub-batches inside this task**

Adapt tests to treat baseline as prepared; remove global schema reset and shared seed. Declare exact `import-schema`, `identity-empty`, `auth-schema-018`, authority and replica fixture IDs. Preserve product SQL historical guard assertions separately from generated-DB integration behavior.

- [ ] **Step 5: Remove runtime DB env from all unit files**

No unit entry reads `TEST_DATABASE_URL`, `DATABASE_URL`, `PG*`, `POSTGRES_*` or skips because they are absent. Any static ambiguity is resolved by pure helper extraction or kind correction with reviewed manifest reason.

- [ ] **Step 6: Run every DB entry once via filtered automation, then all unit entries**

Expected: each selected DB file passes on its own generated target, cleanup/leak clean; unit phase passes under allowlist. This remains diagnostic because selection is filtered.

- [ ] **Step 7: Run manifest/discovery/static audit GREEN**

Run: `cd server && node --test tests/db-test-manifest.test.mjs tests/db-test-discovery.test.mjs && node scripts/test-isolated-db.mjs --list`

Expected: exact set equality, no stale/missing/duplicate/ambiguous entries and exact hard-coded allowlist counts.

- [ ] **Step 8: Review and stage exact enumerated paths**

Before commit produce `git diff --name-only` and compare it to manifest DB checklist. Stage each printed file explicitly (one `git add path...` command generated/reviewed from the checklist, never `git add server/tests`), then:

```bash
git diff --cached --check
git commit -m "test: migrate server database suites to generated targets"
```

### Task 8: HTTP child special case, failure isolation и continuation

**Files:**
- Modify: `server/tests/truck-phone-http.test.mjs`
- Create: `server/tests/isolated-db-http.test.mjs`
- Create: `server/tests/fixtures/isolated-db-http-followup.test.mjs`
- Modify: `server/tests/db-test-manifest.mjs`

**Interfaces:**
- Consumes: Task 5 process groups/scheduler; generated DB URL inherited by file’s API grandchild.
- Produces: reviewed `exclusive:true` HTTP entry with fixed-port reason, descendant termination/drop proof and continuation contract.

- [ ] **Step 1: Write RED HTTP process tree tests**

Assert API grandchild connects only to parent file target, fixed port requires exclusive scheduling, no normal/serial/exclusive overlap, and successful exit terminates API before target drop.

- [ ] **Step 2: Add RED Review Focus failure test**

`http_failure_does_not_block_later_file`: force assertion failure after API starts, verify process group termination, zero target sessions/drop, then followup file runs and passes; aggregate remains exit 1 in manifest order.

- [ ] **Step 3: Run RED filtered pair through direct shell**

Expected: fail until HTTP test/process tracking is adapted; report is filtered and not acceptance evidence.

- [ ] **Step 4: Adapt HTTP test and manifest metadata**

Remove any independent DB URL/name selection. Grandchild inherits generated target only; parent exposes a reliable readiness/teardown hook; exclusive reason names fixed external port ownership.

- [ ] **Step 5: Run GREEN success and forced-failure variants**

Expected: success variant exit 0; failure variant exit 1 while followup passes; both zero current-run leaks and no listening descendant.

- [ ] **Step 6: Commit exact paths**

```bash
git add server/tests/truck-phone-http.test.mjs \
  server/tests/isolated-db-http.test.mjs \
  server/tests/fixtures/isolated-db-http-followup.test.mjs \
  server/tests/db-test-manifest.mjs
git diff --cached --check
git commit -m "test: isolate the HTTP server database process tree"
```

### Task 9: CLI, safe artifact, package alias и Task 1 security boundary

**Files:**
- Modify: `server/scripts/test-isolated-db.mjs`
- Modify: `server/scripts/test-isolated-db.sh`
- Modify: `server/package.json`
- Create: `server/tests/isolated-db-cli.test.mjs`
- Modify: `server/tests/isolated-db-runner.test.mjs`
- Create: `server/tests/fixtures/isolated-db-signal-repeat.test.mjs`

**Interfaces:**
- Consumes: all runner modules Tasks 1–7.
- Produces: final `--list`, repeatable `--file`, `--jobs`, `--report`; exact exits/signals; safe atomic report; preserved direct shell boundary.

- [ ] **Step 1: Write RED CLI parsing/selection tests**

Unknown option/Node flag/traversal/symlink/non-manifest file → exit 2 before load. `--list` works without admin. `--file unit` → exit 2; DB/harness repeatable selection validates global manifest/audit, sets `selection=filtered`, skips unit phase. No `--file` sets `selection=full` and runs all phases.

- [ ] **Step 2: Write RED report-path/atomicity tests**

Add `report_path_rejects_aliases_and_non_regular_targets`: lexical normalization + existing parent realpath must stay inside approved artifacts; reject symlink/hardlink/directory/device. Assert same-directory `O_EXCL|O_NOFOLLOW` temp, fsync, atomic rename, safe regular overwrite policy, and report failure prevents success.

- [ ] **Step 3: Write RED exact exit/signal tests**

Map synthetic config/test/safety/internal cases to 2/1/3/4. For SIGINT/SIGTERM/SIGHUP assert full cleanup/report/leak check then actual original signal; repeated signal does not replace original or run cleanup twice.

- [ ] **Step 4: Re-run hostile env boundary characterization RED/GREEN**

Direct executable with malicious `NODE_OPTIONS/NODE_PATH` must prevent injection before Node. npm alias remains explicitly outside that boundary. Shell lines begin with `unset NODE_OPTIONS NODE_PATH`; credentials only in env and never argv/output.

- [ ] **Step 5: Implement final CLI/report contract**

Keep shell minimal. CLI validates config before DB work, routes full phases in order, and emits report counts/file lists/version/hash/Node/PostgreSQL/jobs/cleanup/leaks/interruption without secrets.

- [ ] **Step 6: Run GREEN contract suite**

Run: `cd server && node --test tests/isolated-db-cli.test.mjs tests/isolated-db-runner.test.mjs tests/isolated-db-process.test.mjs`

Expected: PASS including exact status/signal assertions.

- [ ] **Step 7: Commit exact paths**

```bash
git add server/scripts/test-isolated-db.mjs \
  server/scripts/test-isolated-db.sh \
  server/package.json \
  server/tests/isolated-db-cli.test.mjs \
  server/tests/isolated-db-runner.test.mjs \
  server/tests/isolated-db-process.test.mjs \
  server/tests/fixtures/isolated-db-signal-repeat.test.mjs \
  server/tests/db-test-manifest.mjs
git diff --cached --check
git commit -m "test: finalize isolated suite cli and security boundary"
```

## Фаза IV — CI cutover и доказательство

### Task 10: CI cutover to compose/direct runner и factual docs

**Files:**
- Modify: `.github/workflows/synology-server-tests.yml`
- Modify: `server/README.md`
- Modify: `docs/runbook.md`
- Modify: `docs/project-state.md`
- Modify: `docs/opyt-oshibok.md`

**Interfaces:**
- Consumes: final direct runner and approved artifact directory.
- Produces: only official CI DB path: compose up/wait → direct unfiltered shell runner → artifact upload → always compose down `-v`; documented local equivalent and known issue resolution.

- [ ] **Step 1: Write/extend workflow static contract test RED**

In an appropriate harness-contract test assert no `services.postgres`, shared `TEST_DATABASE_URL`, inline migration loop or `npm test` with DB env remains; require `docker compose -f server/compose.test.yaml --profile test up -d --wait`, direct `./scripts/test-isolated-db.sh`, full JSON artifact upload and unconditional `down -v`.

- [ ] **Step 2: Run RED workflow contract**

Expected: FAIL against current Actions service/shared DB workflow.

- [ ] **Step 3: Cut over workflow**

Generate nonsecret CI credentials at runtime, export only to compose/orchestrator step, invoke from correct `server/` working directory, upload only redacted `selection=full` artifact, and use `if: always()` teardown. Keep independent frontend/tabel baselines but never call the old shared DB path as evidence.

- [ ] **Step 4: Update factual documentation and known issue**

Document direct command, `--list/--file`, filtered-not-evidence, role separation, no live/reserve/common DB, exact teardown and Task 3 gate. In `docs/opyt-oshibok.md`, append symptom → cause → remedy for shared-DB ordering/filename hack and mark resolved only after local full proof; do not rewrite stale history.

- [ ] **Step 5: Run workflow/static docs contract GREEN**

Expected: exact commands/teardown/artifact gates pass; search confirms docs do not advertise `npm run test:db` as security boundary or shared target as official.

- [ ] **Step 6: Commit exact paths**

```bash
git add .github/workflows/synology-server-tests.yml \
  server/README.md \
  docs/runbook.md \
  docs/project-state.md \
  docs/opyt-oshibok.md \
  server/tests/db-test-manifest.test.mjs
git diff --cached --check
git commit -m "ci: run the official suite on isolated compose databases"
```

### Task 11: Full unfiltered proof twice, baselines и broad review

**Files:**
- Modify only if a newly proven infrastructure defect requires a focused fix: exact owning module/test from Tasks 1–9
- Create through runner, do not commit if ignored CI artifact: `server/test-results/isolated-db-suite.json`
- No product or production file changes

**Interfaces:**
- Consumes: complete official runner and CI path.
- Produces: two consecutive local unfiltered full artifacts plus green Actions evidence satisfying all numerical invariants; explicit Task 3 unblock decision.

- [ ] **Step 1: Establish clean-tree scope before acceptance**

Run `git status --short`, `git diff --name-only $(git merge-base HEAD 0f3fa5a)..HEAD`, and production-path integrity checks. Expected: only planned server test infrastructure/docs/workflow plus Task 2 product fix; no frontend/production/common deployment files.

- [ ] **Step 2: Run official unfiltered suite — pass 1**

From this exact worktree, start isolated compose, export admin/bootstrap env without logging secrets, then run **directly**:

```bash
cd server
./scripts/test-isolated-db.sh --report test-results/isolated-db-suite-run1.json
```

Always run `docker compose -f compose.test.yaml down -v` via trap/finally. Expected artifact: `selection=full`, `discovered == manifest`, `attempted == manifest`, `passed == attempted`, `unexpectedSkips == 0`, `cleanupFailures == 0`, `leaks == 0`, `failed == timedOut == interrupted == 0`; allowed skips separately listed and condition-valid.

- [ ] **Step 3: Run official unfiltered suite — pass 2 from fresh compose**

Destroy volumes, create a fresh compose instance and repeat with `isolated-db-suite-run2.json`. Expected: same manifest hash/counts and all green; no ordering dependence, stale DB or leaked process/port.

- [ ] **Step 4: Run non-DB server/unit/frontend baselines**

Run `cd server && npm run check`; run explicit manifest unit phase through official full suite evidence (already included), then repository baseline `node --test tests/tabel-v2/*.test.mjs` and current required browser/workflow checks per `AGENTS.md`. Compare known baseline failures honestly; do not hide or convert unexpected skip.

- [ ] **Step 5: Verify zero leaks/processes and production integrity**

After teardown confirm no current-run DB names, compose containers/volumes, descendant API process or fixed HTTP port remains. Run production source integrity workflow/test locally where available and inspect `git diff` for zero production files.

- [ ] **Step 6: Broad review against spec and Review Focus**

Fresh reviewer checks: complete manifest and reason evidence; role least privilege; exact template lifecycle; marker/owner/TOCTOU fail-closed; signal order; redaction; report atomicity; all five Review Focus owning tests; no filename classification; no generic guard replacement; filtered artifacts cannot pass CI gate.

- [ ] **Step 7: Fix only proven defects with fresh RED→GREEN atomic commits**

For each finding: add failing owning test, run RED, make minimal infrastructure fix, run targeted GREEN, commit exact paths, then restart Steps 1–6 including both full runs. Never fold product migration changes into infrastructure fixes.

- [ ] **Step 8: Verify GitHub Actions evidence**

Required `synology-server-tests`, `full-browser-integration`, `production-source-integrity`, `wincor-printer-tests` jobs are green as applicable. Download unfiltered artifact and recheck selection/counts/manifest hash/zero skips-cleanup-leaks; workflow teardown completed.

- [ ] **Step 9: Declare full-suite cutover gate**

Tasks 3/3A/3B могли выполняться targeted после foundation Tasks 1–5. Здесь разблокировать продолжение parallel-shifts Task 4+ только когда Steps 1–8 доказаны на S26 full suite; иначе сообщить точный blocker. No release, deployment or common DB action belongs to this task.

- [ ] **Step 10: Optional evidence-only commit**

Normally JSON run artifacts remain ignored and no commit is needed. If versioned acceptance metadata is required, stage only its exact approved path plus any factual known-issue update:

```bash
git add docs/opyt-oshibok.md
git diff --cached --check
git commit -m "docs: record isolated database suite acceptance"
```

## Self-review writing-plans

- **Spec coverage:** strict-025 amendment покрыт Task 0A; initial inventory/split (1), roles/bootstrap/safety (2), S24/S25 templates/guards/fixtures (3), target lifecycle/cleanup/leaks (4), per-file env/process/scheduling/events/report/signals (5), атомарный S26 transition после внешней 026 dependency (6), all consumers (7), HTTP child (8), CLI/security/atomic report (9), CI/docs (10), numerical acceptance (11). Circular dependency устранена: 026 ждёт foundation Tasks 1–5, а S26 infrastructure ждёт 026.
- **Step scan:** каждая задача имеет named RED, точную команду/ожидание, минимальную GREEN boundary, review и exact staging; Task 0A и Task 6 не смешивают product staging с infrastructure.
- **Type consistency:** `prepareTemplates` сначала возвращает `empty|S24|S25`, после Task 6 — `empty|S24|S25|S26`; `TargetRecord`, fixture IDs, full/filtered selection и exits не переименовываются.
- **Review Focus:** пять исходных safety cases закреплены Tasks 1/4/5/8/9; strict canonical placeholder regression закреплена Task 0A, S26 schema/fixture transition — Task 6.
- **Proportion:** implementation bodies опущены; план фиксирует signatures, dependencies, test assertions и commands, не транскрибирует код.
- **History/ledger:** отдельный SDD ledger-файл в worktree не найден. Фактическая история восстановлена из commits `9a59ce3`, `ec44885`, `7cdd9e8`, `1ae36cc`, amendment `53690e0` и specs; это evidence, не выполненные checkbox-ы нового amendment. Блокеров по решениям владельца нет.
