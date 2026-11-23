# Parallel Shifts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать в тестовой линии несколько одновременно активных смен-линий с серверной ACL/CAS-изоляцией, безопасным переводом самосвала, отдельным архивным режимом и scoped offline/client state.

**Architecture:** PostgreSQL становится каноническим источником normalized shift/member/status/detached-trip данных; новый `/api/v2` требует явный `shiftId`, immutable command hash и серверную авторизацию каждого ресурса. Клиент хранит независимые contexts по `uid/workspaceId/shiftId`, переключает их атомарно через `activeShiftId`, а restored archive держит в отдельном context. Включение всей вертикали выполняется только целиком через отдельно согласованное окно обслуживания.

**Tech Stack:** Node.js 22 ESM, `node:test`, PostgreSQL 16 (`pg`), SQL migrations 025+, browser JavaScript/CSS/HTML, Chromium/Playwright 393×852, Python 3 build/verification scripts, GitHub Actions/Pages.

**Spec:** `docs/superpowers/specs/2026-11-23-parallel-shifts-design.md`

## Global Constraints

- Production/common DB/server во время реализации не трогать: миграции и серверные тесты — только в отдельном контейнере PostgreSQL из `server/compose.test.yaml`; запрещено подставлять URL `samosval_working_test_reserve`, `samosval_test` или live API.
- Фактические server deploy и миграция общей БД требуют отдельно согласованного maintenance window и явного «да» владельца.
- Тестовый frontend working-test при полностью зелёных проверках публикуется без дополнительного «да», но этап 4 нельзя функционально включать до согласованного server window.
- Production-файлы (`index.html`, production manifests/icons/SW) и отозванная линия `app/` не изменяются.
- Shift является линией; постоянная сущность `line` не вводится.
- Один truck имеет ровно одно current assignment/status; исключение не создаёт второй status, а сохраняет максимум один audited `open` detached trip исходной смены.
- Hidden shifts защищаются на сервере: admin видит все, `senior_foreman`/`foreman` — только active membership; removed member теряет доступ немедленно.
- Любой line/shift read и write использует `workspace_id AND shift_id`; workspace-wide запрос не может смешивать A/B и обязан быть каталогом/агрегацией с pagination.
- CAS mismatch не делает частичного update; receipt, mutation и append-only audit фиксируются одной транзакцией.
- `force-transfer` и detached completion — online-only; persisted queue никогда не меняет uid/workspace/shift/protocol/hash при replay.
- После maintenance v1 list/snapshot/mutations отвечают `426 protocol-upgrade-required`; долгой совместимости v1/v2 нет.
- Restored archive не становится active shift и допускает только trip/TTN update/delete с отдельными revision/receipt/audit.
- Все времена БД — `timestamptz`, work date вычисляется в `Europe/Moscow`, revisions — `bigint > 0`, JSON является snapshot, normalized columns — канон.
- Коммуникация и пользовательские тексты — по-русски; код и имена следуют существующему стилю.
- Каждая задача использует TDD, заканчивается отдельным коммитом; новая обнаруженная ловушка добавляется в `docs/opyt-oshibok.md` в том же коммите.

## Review Focus

1. **Повтор operationId с тем же телом, но другим uid/shift/protocol или изменённым semantic field** должен вернуть `409 operation-id-reused`, ничего не раскрыть и не изменить — закрепляет `server/tests/v2-command.test.mjs::receipt_hash_binds_full_context` в Task 4.
2. **Два конкурентных add/force-transfer одного truck** не должны создать два current status или два open detached trip — закрепляет `server/tests/v2-truck-transfer-db.test.mjs::concurrent_transfer_keeps_single_assignment` в Task 8.
3. **Late response A после выбора B или смены аккаунта** не должен менять B/видимый DOM — закрепляют `working-test/source/core/shift-contexts.test.mjs::late_response_is_rejected_by_full_generation_key` в Task 13 и browser-test в Task 24.
4. **Removed member между close prepare и finish** не должен получить receipt replay или закрыть смену — закрепляет `server/tests/v2-shift-close-db.test.mjs::removed_member_cannot_finish_or_replay` в Task 11.
5. **Backup/report/material/archive operation A при наличии trap rows B** не должна читать, считать или менять B — закрепляет `server/tests/v2-query-isolation-db.test.mjs::all_scoped_stores_leave_trap_shift_unchanged` в Task 21.

---

## Карта файлов

### Новые серверные файлы

- `server/sql/025_parallel_shifts_core.sql` — normalized `shifts`, `shift_members`, единственный current status, object lock, базовые индексы/constraints и безопасный backfill.
- `server/sql/026_parallel_shift_dependencies.sql` — detached trips, scoped receipts/audit/history/logs/archive/tabel/material marker и protocol/hash columns.
- `server/sql/027_parallel_shift_permissions.sql` — `manage_shift_members`, `force_transfer_truck`, default-deny и defaults admin/senior.
- `server/scripts/preflight-parallel-shifts.mjs` — read-only JSON-отчёт неоднозначных/null/payload mismatch данных; ненулевой exit при небезопасном backfill.
- `server/src/v2-errors.mjs` — stable error envelope/status mapping.
- `server/src/v2-command.mjs` — canonical JSON/SHA-256, protocol gate, transactional receipt helper.
- `server/src/shift-access-v2.mjs` — active user, action matrix, membership/resource ACL.
- `server/src/shift-read-v2.mjs` — paginated visible list и one-shift snapshot.
- `server/src/shift-members-v2.mjs` — create shift, object change, member add/reactivate/remove.
- `server/src/shift-trucks-v2.mjs` — add/remove current assignment.
- `server/src/shift-transfer-v2.mjs` — atomic force-transfer и detached completion.
- `server/src/line-store-v2.mjs` — scoped arrive/load/TTN/reset, revisions и first-arrive object lock.
- `server/src/shift-close-v2.mjs` — prepare/finish token workflow и material marker.
- `server/src/archive-store-v2.mjs` — restored archive read/allowed mutations.
- `server/src/v2-router.mjs` — `/api/v2` route matching, auth, schemas и HTTP envelopes.
- `server/src/protocol-gate.mjs` — maintenance и v1 `426` gate.
- `server/tests/helpers/isolated-db.mjs` — только test-container URL, migrations 001–027, reset/seed/SQL snapshot helpers.
- `server/tests/v2-*.test.mjs` — unit/DB/API/query isolation suites по доменам.

### Изменяемые серверные файлы

- `server/src/index.mjs` — подключение v2 router и protocol gate без изменения auth endpoints/health.
- `server/src/identity-rules.mjs` — новые actions.
- `server/src/{control-store,report-store,history-store,archive-read,archive-store,tabel-store,backup-store,game-store,game-transfer,shift-archive}.mjs` — явная shift attribution и удаление singleton/workspace-wide допущений.
- `server/compose.test.yaml`, `server/package.json`, `server/scripts/apply-migrations.mjs` — безопасный isolated profile и команды preflight/test.
- `.github/workflows/synology-server-tests.yml` — миграции 001–027 и полный server suite на PostgreSQL 16.

### Новые клиентские файлы

- `working-test/source/core/40-shift-contexts.js` — `shiftsById`, `contextsByShiftId`, `activeShiftId`, generation/apply guards, persisted selection.
- `working-test/source/core/41-v2-transport.js` — typed v2 list/snapshot/command client and polling subscriptions.
- `working-test/source/core/42-offline-v2.js` — canonical command hash, scoped journal/projection/dead-letter/replay.
- `working-test/source/core/43-shift-selector.js` — атомарный selector и scoped loading.
- `working-test/source/core/44-shift-management.js` — create/object/member/close/truck/force-transfer UI.
- `working-test/source/core/45-restored-archive.js` — отдельный archive context/banner/allowed operations.
- `working-test/source/core/46-detached-trips.js` — read-only offline block и online completion.
- `working-test/source/styles/parallel-shifts.css` — mobile selector, safe-area/keyboard layout, dialogs/banner.
- `working-test/source/core/*parallel*.test.mjs`, `tests/tabel-v2/parallel-shifts*.test.mjs`, `tests/tabel-v2/parallel-shifts-browser.cjs` — client/domain/browser acceptance.

### Изменяемые клиентские файлы

- `working-test/source/shell.html` — containers/templates и module/style order.
- `working-test/source/core/00-config-state.js` — v2 permissions и state bridge; singleton state остаётся только compatibility view выбранного context.
- `working-test/source/core/{03-formatting,04-subscriptions,09-reports,10-archive,15-shifts,16-offline-replay,17-trip-actions,18-line-ui,19-navigation,21-nas-runtime}.js` — делегирование v2 слоям и только scoped данные.
- `working-test/synology/session-client.mjs` — `/api/v2` envelopes/methods/polling; v1 line methods не используются после cutover.
- `working-test/tabel-v2/{domain,store,backend,summary,material-transfer,presence-nas}.mjs` — stable `shiftId`, source attribution и shift presence namespace.
- `working-test/source/features/{game-coins-v2,release-history,working-test-release}.js` — source shift game scope и запись релиза (версия меняется только в release task).
- `tools/build-working-test.py`, `tools/verify-working-test.py` — protocol marker, version/build/RECORDS verification.

### Rollout/документы

- `server/scripts/parallel-shifts-maintenance.mjs` — explicit dry-run/phase runner без встроенных секретов и без автоматического restore.
- `server/scripts/verify-parallel-shifts-rollout.mjs` — schema/count/v1-426/v2 smoke verifier.
- `docs/runbooks/parallel-shifts-rollout.md` — backup, migration, deploy, smoke, forward-fix/rollback gates.
- `docs/parallel-shifts-query-inventory.md` — классификация каждого shift-related query и owning test.
- `docs/opyt-oshibok.md`, `docs/project-state.md`, `docs/runbook.md` — только фактически подтверждённые изменения/ловушки.

## Фаза I — схема и общие протоколы

### Task 1: Изолированный DB harness и migration guard

**Files:**
- Create: `server/tests/helpers/isolated-db.mjs`
- Create: `server/tests/isolated-db-guard.test.mjs`
- Modify: `server/compose.test.yaml`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: `TEST_DATABASE_URL`, PostgreSQL 16 container из `server/compose.test.yaml`.
- Produces: `requireIsolatedDatabase(url: string): URL`, `resetIsolatedDatabase(): Promise<void>`, `applyMigrationsThrough(number: number): Promise<void>`, `seedParallelShiftFixture(options): Promise<FixtureIds>`.

- [ ] **Step 1: Write the failing test** — добавить `rejects_reserved_and_live_database_names`, `accepts_compose_test_database`, `reset_never_uses_unapproved_url`; проверить запрет host live API и DB names `samosval_test`/`samosval_working_test_reserve`, а также обязательный marker `SAMOSVAL_ISOLATED_TEST=1`.
- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/isolated-db-guard.test.mjs`
Expected: FAIL — helper отсутствует.

- [ ] **Step 3: Implement minimal harness** — harness до `pool.connect()` валидирует URL/marker; compose получает отдельное имя БД `samosval_parallel_shifts_test`, healthcheck и ephemeral profile; добавить script `test:db` без hard-coded credentials.
- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/isolated-db-guard.test.mjs`
Expected: PASS; ни одного соединения с reserved/live target.

- [ ] **Step 5: Commit**

```bash
git add server/tests/helpers/isolated-db.mjs server/tests/isolated-db-guard.test.mjs server/compose.test.yaml server/package.json
git commit -m "test: add isolated database guard for parallel shifts"
```

### Task 2: Core schema shifts, memberships и current status

**Files:**
- Create: `server/sql/025_parallel_shifts_core.sql`
- Create: `server/tests/parallel-shifts-migration-core.test.mjs`
- Modify: `server/scripts/apply-migrations.mjs`

**Interfaces:**
- Consumes: Task 1 DB harness; migrations 001–024.
- Produces: normalized `shifts`, `shift_members`, status revisions/FKs/indexes; legacy `is_active` consistency bridge.

- [ ] **Step 1: Write the failing test** — на базе после 001–024 проверить отсутствие schema, затем assertions: day/night одного object/date разрешены; concurrent exact active duplicate даёт unique violation; status PK остаётся `(workspace_id,truck_id)`; membership soft-remove pair constraint; revisions `>0`; normalized/payload mismatch fixture блокирует migration.
- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/parallel-shifts-migration-core.test.mjs`
Expected: FAIL — migration 025 отсутствует.

- [ ] **Step 3: Implement migration** — additive ALTER/backfill normalized columns (`state`, object snapshot/date/type/open/lock/close/revision), memberships и status revisions; derive Moscow work date; keep `is_active` with consistency constraint/trigger; abort on null/unknown/ambiguous JSON instead of guessing.
- [ ] **Step 4: Run test to verify it passes** — той же командой; Expected: PASS, migration registry содержит checksum `025_parallel_shifts_core.sql`.
- [ ] **Step 5: Commit**

```bash
git add server/sql/025_parallel_shifts_core.sql server/tests/parallel-shifts-migration-core.test.mjs server/scripts/apply-migrations.mjs
git commit -m "feat: add normalized parallel shift core schema"
```

### Task 3: Detached trips, dependent attribution и migration preflight

**Files:**
- Create: `server/sql/026_parallel_shift_dependencies.sql`
- Create: `server/scripts/preflight-parallel-shifts.mjs`
- Create: `server/tests/parallel-shifts-migration-dependencies.test.mjs`
- Create: `server/tests/parallel-shifts-preflight.test.mjs`

**Interfaces:**
- Consumes: normalized schema Task 2.
- Produces: `detached_open_trips`, scoped receipts/audits/archive/tabel/material marker; `runParallelShiftPreflight(pool): Promise<PreflightReport>`.

- [ ] **Step 1: Write the failing tests** — проверить one-open-detached unique, destination current-status consistency, `protocol_version/command_hash/shift_id`, archive `source_shift_id`, tabel `record_kind/shift_id`, marker unique per shift; preflight reports exact categories `nullShift`, `unknownShift`, `payloadMismatch`, `ambiguousObjectLock` and exits nonzero.
- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/parallel-shifts-migration-dependencies.test.mjs tests/parallel-shifts-preflight.test.mjs`
Expected: FAIL — 026 и preflight отсутствуют.

- [ ] **Step 3: Implement minimal migration/preflight** — добавить FK/indexes для перечисленных в spec dependent entities; generic receipt nullable shift только для workspace-wide type; current destination trigger; marker/archive receipts/audit; preflight read-only и без вывода payload/PII.
- [ ] **Step 4: Run tests to verify they pass** — той же командой; Expected: PASS и zero-issue fixture возвращает `{safe:true}`.
- [ ] **Step 5: Commit**

```bash
git add server/sql/026_parallel_shift_dependencies.sql server/scripts/preflight-parallel-shifts.mjs server/tests/parallel-shifts-migration-dependencies.test.mjs server/tests/parallel-shifts-preflight.test.mjs
git commit -m "feat: scope dependent data to shifts"
```

### Task 4: V2 errors, canonical hash и transactional receipts

**Files:**
- Create: `server/src/v2-errors.mjs`
- Create: `server/src/v2-command.mjs`
- Create: `server/tests/v2-command.test.mjs`

**Interfaces:**
- Consumes: receipt columns Task 3.
- Produces: `v2Error(code: StableCode, details?: object): Error`; `canonicalJson(value): string`; `commandHash(context): string`; `runV2Command(pool, context, authorize, mutate): Promise<ReceiptEnvelope>`.

- [ ] **Step 1: Write the failing test** — `receipt_hash_binds_full_context` меняет по одному uid/workspace/shift/protocol/operation/type/body field и ждёт разные SHA-256; same hash replay возвращает saved result; mismatch возвращает `operation-id-reused`; mutation throw не оставляет receipt/audit.
- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/v2-command.test.mjs`
Expected: FAIL — exports отсутствуют.

- [ ] **Step 3: Implement protocol primitives** — RFC-like deterministic object-key sorting, arrays ordered, reject non-JSON/undefined/NaN; envelope `{protocolVersion:2,operationId,replayed,result}`; auth выполняется до выдачи existing receipt.
- [ ] **Step 4: Run test to verify it passes** — Expected: PASS, known hash fixture стабилен.
- [ ] **Step 5: Commit**

```bash
git add server/src/v2-errors.mjs server/src/v2-command.mjs server/tests/v2-command.test.mjs
git commit -m "feat: add v2 command and receipt protocol"
```

### Task 5: Permissions migration и shift ACL

**Files:**
- Create: `server/sql/027_parallel_shift_permissions.sql`
- Create: `server/src/shift-access-v2.mjs`
- Create: `server/tests/v2-shift-access.test.mjs`
- Modify: `server/src/identity-rules.mjs`

**Interfaces:**
- Consumes: `runV2Command`; `app_users`, `role_permissions`, `shift_members`.
- Produces: `loadActor(client, uid, {lock?})`; `authorizeShift(client, actor, shiftId, action, {membershipMode})`; `visibleShiftPredicate(actor)`; actions `manage_shift_members`, `force_transfer_truck`.

- [ ] **Step 1: Write the failing test** — defaults admin/senior force transfer true, foreman false; worker/driver membership assignment rejected; admin bypass; removed membership read→404 and known command→403; ACL checked before receipt replay.
- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/v2-shift-access.test.mjs`
Expected: FAIL — migration/action/helper отсутствуют.

- [ ] **Step 3: Implement minimal ACL** — role alone never grants action; membership active iff `removed_at IS NULL`; detached completion supports source OR current destination membership; closing permits snapshot/finish only.
- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add server/sql/027_parallel_shift_permissions.sql server/src/shift-access-v2.mjs server/tests/v2-shift-access.test.mjs server/src/identity-rules.mjs
git commit -m "feat: add parallel shift permissions and acl"
```

## Фаза II — API v2 и серверные домены

### Task 6: Visible list, scoped snapshot и v2 router foundation

**Files:**
- Create: `server/src/shift-read-v2.mjs`
- Create: `server/src/v2-router.mjs`
- Create: `server/tests/v2-shift-read-db.test.mjs`
- Create: `server/tests/v2-router.test.mjs`
- Modify: `server/src/index.mjs`

**Interfaces:**
- Consumes: Task 5 ACL.
- Produces: `listVisibleShifts(pool, uid, {states,limit,cursor})`; `readShiftSnapshot(pool,uid,shiftId)`; `handleV2Request({pool,req,res,url,uid}): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests** — opaque cursor, limit 1..100, order `opened_at DESC, shift_id`; admin sees A/B, foreman only membership A; hidden and absent both 404; snapshot and every status/log carry matching workspace/shift; detached safe fields only; trap B excluded.
- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/v2-shift-read-db.test.mjs tests/v2-router.test.mjs`
Expected: FAIL — routes/exports отсутствуют.

- [ ] **Step 3: Implement list/snapshot/router** — `GET /api/v2/shifts` и `/api/v2/shifts/{id}/snapshot`; server workspace only; stable v2 errors; router вызывается до v1 routes, но после health/auth setup.
- [ ] **Step 4: Run tests to verify they pass** — Expected: PASS; hidden details не отличаются от missing.
- [ ] **Step 5: Commit**

```bash
git add server/src/shift-read-v2.mjs server/src/v2-router.mjs server/src/index.mjs server/tests/v2-shift-read-db.test.mjs server/tests/v2-router.test.mjs
git commit -m "feat: add visible shift list and scoped snapshots"
```

### Task 7: Create shift, object change и memberships

**Files:**
- Create: `server/src/shift-members-v2.mjs`
- Create: `server/tests/v2-shift-members-db.test.mjs`
- Modify: `server/src/v2-router.mjs`

**Interfaces:**
- Consumes: `runV2Command`, ACL, core schema.
- Produces: `createShiftV2(pool,uid,command)`; `changeShiftObjectV2(...)`; `addShiftMemberV2(...)`; `removeShiftMemberV2(...)`.

- [ ] **Step 1: Write the failing test** — creator membership rev=1 in same transaction; concurrent exact duplicate loses with `shift-duplicate`; day/night coexist; object change before lock increments shift rev; reactivation updates same row/revision; last member removable only admin; stale shift/member revisions do nothing.
- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/v2-shift-members-db.test.mjs`
Expected: FAIL — service отсутствует.

- [ ] **Step 3: Implement service/routes** — POST shift, PATCH object, POST/DELETE member signatures exactly per spec; work date validated `YYYY-MM-DD`; only active senior/foreman assignable; close state rejects mutations.
- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add server/src/shift-members-v2.mjs server/src/v2-router.mjs server/tests/v2-shift-members-db.test.mjs
git commit -m "feat: add shift creation metadata and memberships"
```

### Task 8: Truck add/remove и atomic force transfer

**Files:**
- Create: `server/src/shift-trucks-v2.mjs`
- Create: `server/src/shift-transfer-v2.mjs`
- Create: `server/tests/v2-truck-transfer-db.test.mjs`
- Modify: `server/src/v2-router.mjs`

**Interfaces:**
- Consumes: normalized status/detached schema, ACL, receipts.
- Produces: `addTruckToShiftV2`, `removeTruckFromShiftV2`, `forceTransferTruckV2`; result revisions for both shifts/current status/detached trip.

- [ ] **Step 1: Write the failing test** — ordinary add conflict returns safe source details; incomplete cycle blocks remove; completed allows remove→add; no `confirmTransfer:true` gives `force-transfer-confirmation-required`; `concurrent_transfer_keeps_single_assignment`; stable lock order; open detached blocks remove/retransfer; stale CAS leaves all counts/revisions/checksums unchanged.
- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/v2-truck-transfer-db.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement truck services/routes** — lock shifts sorted by id, then truck/status; canonical incomplete stage from locked status; create one detached snapshot in source and clean status in destination; increment both shift revisions; append transfer audit fields actor/from/to/cycle/stage/consequences.
- [ ] **Step 4: Run test to verify it passes** — Expected: PASS under repeated race loop (at least 20 iterations).
- [ ] **Step 5: Commit**

```bash
git add server/src/shift-trucks-v2.mjs server/src/shift-transfer-v2.mjs server/src/v2-router.mjs server/tests/v2-truck-transfer-db.test.mjs
git commit -m "feat: add scoped truck assignment and force transfer"
```

### Task 9: Detached trip completion and source effects

**Files:**
- Modify: `server/src/shift-transfer-v2.mjs`
- Create: `server/tests/v2-detached-completion-db.test.mjs`
- Modify: `server/src/v2-router.mjs`

**Interfaces:**
- Consumes: force-transfer detached snapshot Task 8; line domain rules.
- Produces: `completeDetachedTripV2(pool,uid,sourceShiftId,cycleId,command)`; source-only log/history/reward/material/report attribution.

- [ ] **Step 1: Write the failing test** — member A or current B may complete; removed from one but member of other still can; wrong stage/type rejected; destination mismatch/CAS rejected; completion writes exactly one source log/effect/audit, leaves B status revisions/stage unchanged; replay no duplicate; second distinct completion gives `detached-trip-completed`.
- [ ] **Step 2: Run test to verify it fails** — run targeted file; Expected: FAIL — export/route absent.
- [ ] **Step 3: Implement completion** — online request marker required by router/client contract; lock detached/current status/both shifts; reuse line completion rule for saved stage only; set completed fields/revision and separate completer audit.
- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/v2-detached-completion-db.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/shift-transfer-v2.mjs server/src/v2-router.mjs server/tests/v2-detached-completion-db.test.mjs
git commit -m "feat: complete detached trips in source shift"
```

### Task 10: Scoped line operations и object lock

**Files:**
- Create: `server/src/line-store-v2.mjs`
- Create: `server/tests/v2-line-operations-db.test.mjs`
- Modify: `server/src/v2-router.mjs`

**Interfaces:**
- Consumes: existing pure `applyLineOperation`; Task 4 receipt; Task 5 ACL.
- Produces: `submitLineOperationV2(pool,uid,shiftId,command)` returning shift/status/cycle/ttn revisions.

- [ ] **Step 1: Write the failing test** — path/body/hash shift mismatch rejected; current assignment must match; first confirmed arrive atomically sets lock operation id and increments shift rev; duplicate/rejected arrive does not; fallback confirmed load locks legacy unlocked shift; deleting/undoing first trip does not unlock; A operation leaves B trap rows/revisions unchanged.
- [ ] **Step 2: Run test to verify it fails** — targeted DB test; Expected: FAIL.
- [ ] **Step 3: Implement scoped line store/route** — every status update includes workspace+shift+truck; normalized revisions are CAS source; ordinary endpoint never reads detached table except invariant guard; append receipt/history/audit in transaction.
- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/v2-line-operations-db.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/line-store-v2.mjs server/src/v2-router.mjs server/tests/v2-line-operations-db.test.mjs
git commit -m "feat: scope line operations and lock shift object"
```

### Task 11: Close prepare/finish и material marker

**Files:**
- Create: `server/src/shift-close-v2.mjs`
- Create: `server/tests/v2-shift-close-db.test.mjs`
- Modify: `server/src/v2-router.mjs`

**Interfaces:**
- Consumes: archive builder, scoped statuses/logs, marker schema.
- Produces: `prepareShiftCloseV2`; `confirmShiftMaterialV2`; `finishShiftCloseV2`; opaque single-shift `closeToken` bound to revisions/archive/marker; route `POST /api/v2/shifts/{shiftId}/close/material` with `{operationId,protocolVersion:2,closeToken,materialId,volume,expectedShiftRevision,expectedArchiveRevision,expectedMaterialMarkerRevision}`.

- [ ] **Step 1: Write the failing test** — empty close works without marker; nonempty `confirmShiftMaterialV2` creates/updates exactly one marker and replay does not duplicate it; wrong token/archive/marker revision changes nothing; pending registered receipt and detached source/destination block both phases; prepare freezes only A; finish deletes only A statuses and preserves logs/history/members/receipts/audit/archive; idempotent replay; `removed_member_cannot_finish_or_replay`; stale token/revisions no partial update.
- [ ] **Step 2: Run test to verify it fails** — targeted test; Expected: FAIL.
- [ ] **Step 3: Implement close workflow/routes** — state active→closing→closed; immutable candidate/source validation; membership rechecked before replay; no workspace-wide DELETE; unrelated B remains writable.
- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/v2-shift-close-db.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/shift-close-v2.mjs server/src/v2-router.mjs server/tests/v2-shift-close-db.test.mjs
git commit -m "feat: add scoped two-phase shift close"
```

### Task 12: Restored archive API and isolation

**Files:**
- Create: `server/src/archive-store-v2.mjs`
- Create: `server/tests/v2-restored-archive-db.test.mjs`
- Modify: `server/src/v2-router.mjs`
- Modify: `server/src/archive-read.mjs`

**Interfaces:**
- Consumes: archive ACL (not membership), archive revisions/receipts/audit.
- Produces: `readRestoredArchiveV2(pool,uid,archiveId,{limit,cursor})`; `submitArchiveOperationV2(...)`.

- [ ] **Step 1: Write the failing test** — response includes archive/source/revision and paginates >100; only four allowed types; active commands/object/member/truck/close impossible; archive CAS/audit separate; correction updates existing source marker atomically; active shift revisions unchanged; sourceShiftId added to archive list.
- [ ] **Step 2: Run test to verify it fails** — targeted test; Expected: FAIL.
- [ ] **Step 3: Implement restored API/routes** — archive lookup by workspace+archive id; no creation of active shift/status; safe `archive-operation-not-allowed`; receipt replay still rechecks archive ACL.
- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/v2-restored-archive-db.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/archive-store-v2.mjs server/src/archive-read.mjs server/src/v2-router.mjs server/tests/v2-restored-archive-db.test.mjs
git commit -m "feat: isolate restored archive operations"
```

## Фаза III — клиентские contexts, transport и offline

### Task 13: Client shift context state и generation guards

**Files:**
- Create: `working-test/source/core/40-shift-contexts.js`
- Create: `working-test/source/core/shift-contexts.test.mjs`
- Modify: `working-test/source/core/00-config-state.js`

**Interfaces:**
- Consumes: v2 list/snapshot shapes.
- Produces: `createShiftContextStore({storage,uid,workspaceId})`; methods `replaceVisibleShifts`, `selectShift`, `beginRequest`, `applySnapshot`, `applyCrossShiftResult`, `visibleContext`, `setRestoredContext`, `clearSession`; compatibility projection `projectActiveContextToLegacyState()`.

- [ ] **Step 1: Write the failing test** — independent forms/scroll/focus/inflight/pending; selection key uid/workspace and restore only visible active/closing; archive never changes active id; `late_response_is_rejected_by_full_generation_key`; background A changes only A badge; cross-shift stale result requests refresh of both.
- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test working-test/source/core/shift-contexts.test.mjs`
Expected: FAIL — module absent.

- [ ] **Step 3: Implement store** — `contextsByShiftId` owns snapshot/revisions/UI state; detached map keyed `sourceShiftId:cycleId`; generation key includes uid/workspace/shift/requestKind; legacy `state.shift/logs/status` is read-only projection of selected context.
- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add working-test/source/core/40-shift-contexts.js working-test/source/core/shift-contexts.test.mjs working-test/source/core/00-config-state.js
git commit -m "feat: add isolated client shift contexts"
```

### Task 14: V2 transport, validation и per-shift polling

**Files:**
- Create: `working-test/source/core/41-v2-transport.js`
- Create: `working-test/source/core/v2-transport.test.mjs`
- Modify: `working-test/synology/session-client.mjs`
- Modify: `working-test/source/core/21-nas-runtime.js`

**Interfaces:**
- Consumes: Task 13 request generations; `/api/v2` API.
- Produces: client methods `listShifts`, `readShiftSnapshot`, `createShift`, `changeShiftObject`, `add/removeMember`, `add/removeTruck`, `forceTransferTruck`, `completeDetachedTrip`, `submitLineV2`, `prepare/finishClose`, `readRestoredArchive`, `submitArchiveV2`, `subscribeShifts`.

- [ ] **Step 1: Write the failing test** — validates protocol/workspace/shift/revisions on every entity; opaque cursors preserved; stable error details parsed; timeout uncertainty retries same operationId only; subscriptions poll list plus selected/background pending shifts without publishing mismatched response.
- [ ] **Step 2: Run test to verify it fails** — targeted test; Expected: FAIL.
- [ ] **Step 3: Implement transport/runtime bridge** — generic request supports GET/POST/PATCH/DELETE bodies; remove v1 singleton read from active runtime; list/snapshot callbacks carry generation token.
- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test working-test/source/core/v2-transport.test.mjs server/tests/session-client.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add working-test/source/core/41-v2-transport.js working-test/source/core/v2-transport.test.mjs working-test/synology/session-client.mjs working-test/source/core/21-nas-runtime.js
git commit -m "feat: add v2 shift transport and subscriptions"
```

### Task 15: Offline v2 canonical journal and replay scopes

**Files:**
- Create: `working-test/source/core/42-offline-v2.js`
- Create: `working-test/source/core/offline-v2.test.mjs`
- Modify: `working-test/source/core/16-offline-replay.js`
- Modify: `working-test/source/core/17-trip-actions.js`

**Interfaces:**
- Consumes: v2 transport line command, context store.
- Produces: `createOfflineJournalV2({storage,crypto,uid,workspaceId,protocolVersion:2})`; `enqueue`, `pendingForShift`, `replayShift`, `deadLettersForShift`, `sealAccount`; `canonicalCommandHash` compatible with server.

- [ ] **Step 1: Write the failing test** — persisted fields exact; physical key includes uid/workspace/shift/protocol; JS hash matches server known fixture; account/shift switch never rewrites/replays; closed/member/moved conflicts dead-letter scoped; logout/update preserve data; force transfer/detached type rejected at enqueue; badge total vs per-shift.
- [ ] **Step 2: Run test to verify it fails** — targeted test; Expected: FAIL.
- [ ] **Step 3: Implement journal/replay** — immutable deep clone; server response applied only to originating context; old v1 entries remain sealed and are never auto-converted; explicit local deletion API only for same uid.
- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test working-test/source/core/offline-v2.test.mjs`
Expected: PASS including server/client known SHA-256 vector.

- [ ] **Step 5: Commit**

```bash
git add working-test/source/core/42-offline-v2.js working-test/source/core/offline-v2.test.mjs working-test/source/core/16-offline-replay.js working-test/source/core/17-trip-actions.js
git commit -m "feat: scope offline v2 journal by account and shift"
```

## Фаза IV — UX и отдельный архивный режим

### Task 16: Shift selector и атомарная отрисовка выбранного context

**Files:**
- Create: `working-test/source/core/43-shift-selector.js`
- Create: `working-test/source/core/shift-selector.test.mjs`
- Create: `working-test/source/styles/parallel-shifts.css`
- Modify: `working-test/source/shell.html`
- Modify: `working-test/source/core/18-line-ui.js`
- Modify: `working-test/source/core/19-navigation.js`

**Interfaces:**
- Consumes: Task 13 store.
- Produces: `renderShiftSelector(store,root)`, `switchActiveShiftAtomically(shiftId)`, `renderActiveShiftFrame(context)`; DOM ids `activeShiftHeader`, `activeShiftViewport`, `openShiftStrip`.

- [ ] **Step 1: Write the failing test** — labels `Объект · День/Ночь`, selected non-color marker, only active/closing, scoped pending/state; switch clears old content before loading; header/cards/trips/report/actions/presence all read same context; scroll/focus restored; horizontal ensure-visible does not reset vertical scroll.
- [ ] **Step 2: Run test to verify it fails** — targeted Node DOM fixture; Expected: FAIL.
- [ ] **Step 3: Implement selector/layout** — strip immediately above global nav; central area accounts `100dvh`, both bars, safe-area and visual viewport/keyboard; no active action on tab click.
- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test working-test/source/core/shift-selector.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add working-test/source/core/43-shift-selector.js working-test/source/core/shift-selector.test.mjs working-test/source/styles/parallel-shifts.css working-test/source/shell.html working-test/source/core/18-line-ui.js working-test/source/core/19-navigation.js
git commit -m "feat: add atomic mobile shift selector"
```

### Task 17: Create/member/close management UI

**Files:**
- Create: `working-test/source/core/44-shift-management.js`
- Create: `working-test/source/core/shift-management.test.mjs`
- Modify: `working-test/source/core/15-shifts.js`
- Modify: `working-test/source/core/02-permissions.js`
- Modify: `working-test/source/shell.html`

**Interfaces:**
- Consumes: Task 14 transport, Task 13 revisions, permission actions.
- Produces: create dialog, object editor, member manager, two-phase close controller; `refreshOriginContextOnConflict(error)`.

- [ ] **Step 1: Write the failing test** — day/night create payload; only senior/foreman candidates; reactivation expected revision; last-member/server errors shown; removed self loses UI immediately; close stores token per shift and never reuses across A/B; 409 refreshes origin only.
- [ ] **Step 2: Run test to verify it fails** — targeted test; Expected: FAIL.
- [ ] **Step 3: Implement management UI** — no browser-native confirm; disable mutations in closing; forms retained per context; object lock error permanently disables change for refreshed shift.
- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test working-test/source/core/shift-management.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add working-test/source/core/44-shift-management.js working-test/source/core/shift-management.test.mjs working-test/source/core/15-shifts.js working-test/source/core/02-permissions.js working-test/source/shell.html
git commit -m "feat: add shift and member management ui"
```

### Task 18: Truck conflict, force-transfer confirm и detached block UI

**Files:**
- Create: `working-test/source/core/46-detached-trips.js`
- Create: `working-test/source/core/detached-trips.test.mjs`
- Modify: `working-test/source/core/44-shift-management.js`
- Modify: `working-test/source/core/18-line-ui.js`
- Modify: `working-test/source/shell.html`

**Interfaces:**
- Consumes: transfer/completion transport and shared detached map.
- Produces: `openForceTransferDialog(conflict,destination)`, `renderDetachedTripsForShift`, `completeDetachedTripOnline`.

- [ ] **Step 1: Write the failing test** — foreman conflict has warning and no bypass; authorized dialog lists from→to, both object/date/type, truck/stage/consequences; cancel default no request; explicit button sends `confirmTransfer:true`; stale CAS closes dialog/refreshes both; detached block in source and destination labels source, is separate from current cards and offline read-only.
- [ ] **Step 2: Run test to verify it fails** — targeted test; Expected: FAIL.
- [ ] **Step 3: Implement transfer/detached UI** — online gate checks confirmed transport state, never queue; completion warning says exact source shift; optimistic mutation forbidden.
- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test working-test/source/core/detached-trips.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add working-test/source/core/46-detached-trips.js working-test/source/core/detached-trips.test.mjs working-test/source/core/44-shift-management.js working-test/source/core/18-line-ui.js working-test/source/shell.html
git commit -m "feat: add audited truck transfer ui"
```

### Task 19: Restored archive client mode

**Files:**
- Create: `working-test/source/core/45-restored-archive.js`
- Create: `working-test/source/core/restored-archive.test.mjs`
- Modify: `working-test/source/core/10-archive.js`
- Modify: `working-test/source/core/09-reports.js`
- Modify: `working-test/source/shell.html`

**Interfaces:**
- Consumes: restored archive API Task 12.
- Produces: `openRestoredArchive(archiveId)`, `closeRestoredArchive()`, `submitRestoredOperation(type,recordId,data)`, separate `restoredContext`.

- [ ] **Step 1: Write the failing test** — archive banner and allowed four operations; selector unchanged/has no archive; active endpoints never called; archive pagination/revision preserved; stale correction refreshes archive only; report receives archiveId, not active shiftId.
- [ ] **Step 2: Run test to verify it fails** — targeted test; Expected: FAIL.
- [ ] **Step 3: Implement separate mode** — explicit exit restores untouched active context/forms/scroll; prohibit object/date/type/member/truck/close controls by construction, not CSS hiding alone.
- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test working-test/source/core/restored-archive.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add working-test/source/core/45-restored-archive.js working-test/source/core/restored-archive.test.mjs working-test/source/core/10-archive.js working-test/source/core/09-reports.js working-test/source/shell.html
git commit -m "feat: separate restored archive client mode"
```

## Фаза V — связанные домены и полный isolation audit

### Task 20: Tabel/material/presence/game/report source attribution

**Files:**
- Modify: `working-test/tabel-v2/domain.mjs`
- Modify: `working-test/tabel-v2/store.mjs`
- Modify: `working-test/tabel-v2/backend.mjs`
- Modify: `working-test/tabel-v2/summary.mjs`
- Modify: `working-test/tabel-v2/material-transfer.mjs`
- Modify: `working-test/tabel-v2/presence-nas.mjs`
- Modify: `working-test/source/features/game-coins-v2.js`
- Create: `tests/tabel-v2/parallel-shifts.test.mjs`
- Modify: `server/src/{tabel-store,report-store,history-store,game-store,game-transfer,shift-archive}.mjs`
- Create: `server/tests/v2-derived-effects-db.test.mjs`

**Interfaces:**
- Consumes: source shift IDs from normal/detached operations.
- Produces: shift sheet identity `(workspaceId,shiftId)`, monthly dedupe `(workspaceId,shiftId,sourceRecordId)`, presence target `workspaceId:shiftId`, source-scoped game/material/report effects.

- [ ] **Step 1: Write the failing tests** — separate day/night sheets; same record not double-counted; detached completion contributes once to A and zero to B; marker correction updates A only; force transfer itself creates no hours/reward/material; presence A invisible B; report takes shiftId/archiveId explicitly.
- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/tabel-v2/parallel-shifts.test.mjs && cd server && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/v2-derived-effects-db.test.mjs`
Expected: FAIL — old object/day/type or workspace scope mixes records.

- [ ] **Step 3: Implement source attribution** — preserve display key but use shiftId as identity; all joins include shiftId/sourceShiftId; presence archive namespace separate if used; add source event identity to rewards/penalties.
- [ ] **Step 4: Run tests to verify they pass** — same commands; Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add working-test/tabel-v2 working-test/source/features/game-coins-v2.js tests/tabel-v2/parallel-shifts.test.mjs server/src server/tests/v2-derived-effects-db.test.mjs
git commit -m "feat: attribute derived data to source shift"
```

### Task 21: Workspace-wide query inventory and trap-row isolation

**Files:**
- Create: `docs/parallel-shifts-query-inventory.md`
- Create: `server/tests/v2-query-isolation-db.test.mjs`
- Modify: `server/src/{control-store,report-store,history-store,archive-store,archive-read,backup-store,tabel-store,game-store,replica-materialize}.mjs`

**Interfaces:**
- Consumes: all server stores Tasks 6–12/20.
- Produces: classified inventory (`catalog/aggregate`, `workspace+shift`, `admin paginated`) and executable invariant helper `snapshotShiftFingerprint(pool,workspaceId,shiftId)`.

- [ ] **Step 1: Write the failing test** — seed A plus sentinel/trap B across shifts/status/logs/history/receipts/audit/archive/tabel/material/game/backup-import views; run every A read/mutation/close/archive correction/backup section; `all_scoped_stores_leave_trap_shift_unchanged` compares B revisions/count/checksums and rejects singleton `LIMIT 1`/workspace-wide delete patterns.
- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/v2-query-isolation-db.test.mjs`
Expected: FAIL with named offending stores/queries.

- [ ] **Step 3: Complete inventory and fix minimal queries** — enumerate file/function/SQL/classification/test; require explicit pagination for admin lists; backup shift section carries all shift IDs without singleton assumptions; no unrelated refactor.
- [ ] **Step 4: Run test to verify it passes** — Expected: PASS and inventory has no `unclassified` row.
- [ ] **Step 5: Commit**

```bash
git add docs/parallel-shifts-query-inventory.md server/tests/v2-query-isolation-db.test.mjs server/src
git commit -m "fix: enforce shift isolation across server queries"
```

### Task 22: Protocol maintenance gate and v1 cutover

**Files:**
- Create: `server/src/protocol-gate.mjs`
- Create: `server/tests/protocol-gate.test.mjs`
- Modify: `server/src/index.mjs`
- Modify: `server/src/server-control.mjs`

**Interfaces:**
- Consumes: environment/config state `SAMOSVAL_MAINTENANCE`, `SAMOSVAL_REQUIRED_PROTOCOL`.
- Produces: `protocolDecision({path,method,maintenance,requiredProtocol})`; v1 line/list/mutation 426 after cutover, all mutations 503 in maintenance, health/admin maintenance diagnostics.

- [ ] **Step 1: Write the failing test** — maintenance blocks v1/v2 mutations 503 while health remains; reads return maintenance envelope where specified; required protocol 2 makes v1 shift/line snapshot+mutations return 426 and never singleton data; v2 works after maintenance; auth refresh/logout policy remains available.
- [ ] **Step 2: Run test to verify it fails** — targeted test; Expected: FAIL.
- [ ] **Step 3: Implement gate** — place before write authority/business routes; no client-controlled bypass; expose only nonsecret mode/protocol in readiness/admin status.
- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/protocol-gate.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/protocol-gate.mjs server/tests/protocol-gate.test.mjs server/src/index.mjs server/src/server-control.mjs
git commit -m "feat: gate maintenance and require protocol v2"
```

## Фаза VI — end-to-end, rollout и release gates

### Task 23: Comprehensive server A/B acceptance suite and CI

**Files:**
- Create: `server/tests/v2-parallel-shifts-acceptance.test.mjs`
- Modify: `.github/workflows/synology-server-tests.yml`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: complete server vertical.
- Produces: repeatable isolated DB acceptance command and CI evidence.

- [ ] **Step 1: Write the failing acceptance test** — two objects plus overlapping day/night; admin/two foremen visibility; member removal; duplicate/races; object lock; add/remove/force/detached lifecycle; source-only effects; close A leaves B; archive correction; all stable codes/CAS/replays; v1=426 mode.
- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && docker compose -f compose.test.yaml up -d postgres && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test --test-concurrency=1 tests/*.test.mjs`
Expected: initially FAIL on uncovered integration gaps; no live DB access.

- [ ] **Step 3: Fix only integration gaps and update CI** — workflow starts PostgreSQL 16, applies 001–027 via registry/checksum, exports isolation marker, runs all `server/tests/*.test.mjs`; remove obsolete 001–013 migration list.
- [ ] **Step 4: Run full server suite** — same command; Expected: all tests PASS, zero skipped parallel-shift acceptance tests.
- [ ] **Step 5: Commit**

```bash
git add server/tests/v2-parallel-shifts-acceptance.test.mjs server/package.json .github/workflows/synology-server-tests.yml
git commit -m "test: cover parallel shifts server acceptance"
```

### Task 24: Two users/two shifts mobile browser acceptance

**Files:**
- Create: `tests/tabel-v2/parallel-shifts-browser.cjs`
- Create: `tests/tabel-v2/parallel-shifts-browser-fixture.mjs`
- Modify: `.github/workflows/full-browser-integration.yml`

**Interfaces:**
- Consumes: built working-test source against isolated API/fixture; Chromium.
- Produces: mobile 393×852 acceptance evidence with admin + two user contexts.

- [ ] **Step 1: Write the failing browser test** — exact spec flow: create overlapping shifts/memberships; visibility; selector overflow/selected state/scoped badges; delayed A response after B selection shows no A node under B; forms/focus/vertical scroll preserved; safe-area/keyboard/last action reachable; presence/pending isolated; force confirm cancel/stale/success; detached completion from B writes A; close A leaves unrelated B; archive banner/allowed edits; two sheets/month sum; capture `pageerror`, console module/network errors.
- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node tests/tabel-v2/parallel-shifts-browser.cjs`
Expected: FAIL before fixture/UI integration is complete, with named assertion rather than timeout.

- [ ] **Step 3: Implement deterministic fixture hooks/minimal UI fixes** — fixture only in test server/build flag; no production bypass; assert viewport exactly 393×852 and two isolated authenticated sessions.
- [ ] **Step 4: Run browser and frontend suites**

Run: `PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node tests/tabel-v2/parallel-shifts-browser.cjs && PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/tabel-v2/*.test.mjs working-test/source/core/*.test.mjs working-test/source/features/*.test.mjs`
Expected: PASS; zero `pageerror`/module errors; known unrelated browser debt is compared to baseline and not hidden.

- [ ] **Step 5: Commit**

```bash
git add tests/tabel-v2/parallel-shifts-browser.cjs tests/tabel-v2/parallel-shifts-browser-fixture.mjs .github/workflows/full-browser-integration.yml
git commit -m "test: verify two-user parallel shifts in mobile browser"
```

### Task 25: Maintenance rehearsal, backup/rollback scripts and runbook

**Files:**
- Create: `server/scripts/parallel-shifts-maintenance.mjs`
- Create: `server/scripts/verify-parallel-shifts-rollout.mjs`
- Create: `server/tests/parallel-shifts-maintenance.test.mjs`
- Create: `docs/runbooks/parallel-shifts-rollout.md`
- Modify: `docs/runbook.md`
- Modify: `docs/project-state.md`

**Interfaces:**
- Consumes: preflight, migration runner, protocol gate, v2 smoke.
- Produces: explicit commands `plan`, `preflight`, `verify-backup`, `migrate`, `smoke`, `post-counts`; no implicit deploy/restore.

- [ ] **Step 1: Write the failing test** — dry-run default; requires isolation marker outside approved explicit window token; backup verification checks SHA-256 plus restore/read counts; ordered phase state prevents publish/open before smoke; rollback before first v2 mutation vs forward-fix after it; restore requires separate destructive-confirm token and never runs automatically.
- [ ] **Step 2: Run test to verify it fails** — targeted test; Expected: FAIL.
- [ ] **Step 3: Implement scripts/runbook** — rehearse maintenance→backup→migration→server→PWA placeholder→smoke→open entirely on isolated copy; runbook leaves target DB/path/time as “сверить в окно”, documents real reserve-DB guard and explicit owner «да» gate.
- [ ] **Step 4: Run isolated rehearsal**

Run: `cd server && SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/parallel-shifts-maintenance.test.mjs && PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node scripts/parallel-shifts-maintenance.mjs plan --isolated`
Expected: PASS; plan prints phases only, makes no live/deploy changes.

- [ ] **Step 5: Commit**

```bash
git add server/scripts/parallel-shifts-maintenance.mjs server/scripts/verify-parallel-shifts-rollout.mjs server/tests/parallel-shifts-maintenance.test.mjs docs/runbooks/parallel-shifts-rollout.md docs/runbook.md docs/project-state.md
git commit -m "docs: add parallel shifts maintenance runbook"
```

### Task 26: Working-test build integration and release verification (без server deploy)

**Files:**
- Modify: `working-test/source/features/release-history.js`
- Modify: `working-test/source/features/working-test-release.js`
- Modify: `working-test/source/shell.html`
- Modify: `tools/build-working-test.py`
- Modify: `tools/verify-working-test.py`
- Modify: `docs/opyt-oshibok.md` only if a new release/process trap was found
- Generated: `index-working-test.html`, `sw-working-test.js`, `working-test/build/*`, `working-test/build-manifest.json`

**Interfaces:**
- Consumes: all green test evidence; agreed next working-test version at execution time.
- Produces: disabled-until-v2/maintenance-aware working-test artifact, internally consistent version/build hash/RECORDS; no production artifacts.

- [ ] **Step 1: Write/extend failing release checks** — добавить `tests/tabel-v2/parallel-shifts-release.test.mjs`; assert one version/description in shell meta+visible “Линия”, release constant, first history entry, built HTML/build files/manifest; protocol marker 2; every SW RECORD URL exists and SHA-256 matches; `git diff` contains no production files.
- [ ] **Step 2: Run checks to verify they fail before version/build update**

Run: `PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/tabel-v2/parallel-shifts-release.test.mjs tests/tabel-v2/release-version-extract.test.mjs working-test/source/core/34-pwa-update-mechanism.test.mjs && python3 tools/verify-working-test.py`
Expected: FAIL with stale version/build/protocol record, not a generic parser error.

- [ ] **Step 3: Update release metadata and build** — choose version only at release execution; plain-language history; frontend must show maintenance/protocol-required state and cannot silently fall back to v1; run `python3 tools/build-working-test.py`; preserve all old build dirs; do not touch production files.
- [ ] **Step 4: Run mandatory pre-publication verification**

Run:
```bash
cd /home/iluxa/samosval-stage1-wt
PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test server/tests/*.test.mjs
PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/tabel-v2/*.test.mjs working-test/source/core/*.test.mjs working-test/source/features/*.test.mjs
PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node tests/tabel-v2/parallel-shifts-browser.cjs
python3 tools/verify-working-test.py
git diff --exit-code -- index.html manifest.json manifest-production.webmanifest sw.js app/
```
Expected: all PASS; Actions `synology-server-tests`, `full-browser-integration`, `production-source-integrity`, `wincor-printer-tests` green; built page opens with zero console errors. Publication may occur without extra owner «да» only according to AGENTS.md, but functional activation remains blocked until the separately approved server window.

- [ ] **Step 5: Commit release artifact only after all checks pass**

```bash
git add working-test/source working-test/build working-test/build-manifest.json index-working-test.html sw-working-test.js tests/tabel-v2/parallel-shifts-release.test.mjs tools/build-working-test.py tools/verify-working-test.py docs/opyt-oshibok.md
git commit -m "release: prepare working-test parallel shifts client"
```

### Task 27: Separately approved maintenance-window execution

**Files:**
- Create: `docs/releases/parallel-shifts-maintenance-evidence.md`

**Interfaces:**
- Consumes: explicit owner «да», confirmed window/target DB/backup path/server image SHA, Tasks 23–26 evidence.
- Produces: deployed v2 server/schema and activated test PWA, or maintenance-safe forward-fix state; production PWA remains untouched.

- [ ] **Step 1: Confirm hard gate** — получить в чате явное «да» владельца на конкретное время, server deploy и migration общей БД; без него STOP. Сверить фактическую DB (не верить старому имени), image SHA, backup destination и rollback operator.
- [ ] **Step 2: Enter maintenance and capture baseline** — mutations v1/v2→503; дождаться inflight; сохранить health/schema migration registry/counts/checksums без секретов.
- [ ] **Step 3: Backup and migrate** — выполнить pg_dump фактической общей БД, SHA-256, пробное чтение/restore verification; запустить preflight; применить 025–027; при любой ошибке оставить maintenance и STOP.
- [ ] **Step 4: Deploy/smoke/open** — server v2; проверить v1=426, v2 auth/list/snapshot/two shifts/object lock/transfer/detached/close A≠B; опубликовать уже проверенный working-test artifact; live HTML/manifest/SW/все RECORDS; открыть v2 mutations; monitor readiness/error rate/post-counts.
- [ ] **Step 5: Record outcome and commit evidence** — записать в `docs/releases/parallel-shifts-maintenance-evidence.md` московское время, commit/image SHA, migration checksums, backup SHA-256 и проверку restore/counts, pre/post counts, smoke/RECORDS/Actions results и решение rollback/forward-fix без секретов. До первой v2 mutation допустим возврат предыдущего server/client; после первой v2 mutation singleton rollback запрещён, только новый server/maintenance forward-fix; restore DB только по отдельному явному согласию. Production публикация не входит в задачу.

```bash
git add docs/releases/parallel-shifts-maintenance-evidence.md
git commit -m "docs: record parallel shifts maintenance evidence"
```

## Финальная матрица обязательных команд

```bash
# Только isolated PostgreSQL
cd server
docker compose -f compose.test.yaml up -d postgres
SAMOSVAL_ISOLATED_TEST=1 TEST_DATABASE_URL="$TEST_DATABASE_URL" PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test --test-concurrency=1 tests/*.test.mjs

# Frontend/domain
cd ..
PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node --test tests/tabel-v2/*.test.mjs working-test/source/core/*.test.mjs working-test/source/features/*.test.mjs

# Chromium 393×852
PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH node tests/tabel-v2/parallel-shifts-browser.cjs
/home/iluxa/hermes-advisor-test/.venv/bin/python tests/tabel-v2/active-address-browser.py

# Build and source integrity
python3 tools/build-working-test.py
python3 tools/verify-working-test.py
git diff --exit-code -- index.html manifest.json manifest-production.webmanifest sw.js app/
```

Ожидаемый общий результат: все suites зелёные, browser console без `pageerror`/module errors, Actions зелёные, production diff пуст, common server/DB не затронуты до Task 27.
