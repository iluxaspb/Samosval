# Реестр выполнения плана «параллельные смены» (этап 4)

Живой файл. Обновляется тем же коммитом, что и закрытие задачи. Источник требований — `2026-11-23-parallel-shifts.md` **в этой ветке** (31 задача). В корневой копии `/home/iluxa/Samosval-repo-main` лежит УСТАРЕВШАЯ версия того же плана на 27 задач с другой нумерацией — см. `docs/opyt-oshibok.md`, п.37.

Статусы: **ГОТОВО** (есть код + тесты + зелёный прогон), **ЧАСТИЧНО**, **НЕ НАЧАТО**, **ОТЛОЖЕНО** (решение владельца).

Актуализация: 26.11.2026, ветка `feature/wtest-parallel-shifts-20261123`.

## Сводка

| Фаза | Задачи | Состояние |
|---|---|---|
| I — legacy provenance и redesigned 025 | 1–5 | 1–4 ГОТОВО, 5 ЧАСТИЧНО (домен есть, HTTP-маршрут не подключён; отложено решением владельца 26.11.2026) |
| II — archive/restored S25 | 6–10 | ГОТОВО |
| III — 026, replica generations, exact restore | 11–15 | 11–13, 15 ГОТОВО (15 — с открытым блокером схемы), 14 НЕ НАЧАТО (идёт параллельно в отдельной ветке) |
| IV — v2 API и core domains | 16–22 | 16–18 ГОТОВО, 19–22 НЕ НАЧАТО |
| V — client contexts и UX | 23–26 | 23 ГОТОВО, 24 ЧАСТИЧНО (транспорт готов, офлайн-журнал нет), 25–26 НЕ НАЧАТО |
| VI — cross-domain и acceptance | 27–29 | НЕ НАЧАТО |
| VII — rehearsal и release gates | 30–31 | НЕ НАЧАТО |

## По задачам

| # | Задача | Статус | Доказательство |
|---|---|---|---|
| 1 | Exact client/source shift payload v2 | ГОТОВО | `working-test/source/core/15-shifts.js:6`, `shift-payload-v2.test.mjs` |
| 2 | Migration/runtime/maintenance role boundary | ГОТОВО | `parallel-shifts-runtime-roles.test.mjs`, `scripts/parallel-shifts-role-bootstrap.mjs` |
| 3 | Migration 025 provenance schema/classifier/backfill | ГОТОВО | `server/sql/025_parallel_shifts_core.sql`, `parallel-shifts-migration-core.test.mjs` |
| 4 | Historicalization preflight/confirmation/audit | ГОТОВО | `server/src/legacy-historicalization.mjs`, `parallel-shifts-historicalization.test.mjs` |
| 5 | Admin-only manual legacy resolution | ЧАСТИЧНО | домен `legacy-shift-resolution.mjs` + `legacy-shift-resolution-route.mjs` есть; в `server/src/index.mjs` маршрут НЕ подключён. Владелец 26.11.2026: legacy-смену просто закрываем без вопросов (`materialImport:'skipped-unresolved-type'`), поэтому UI/маршрут не блокирует |
| 6 | Immutable archive schema + restored contexts | ГОТОВО | `archive-schema-025.test.mjs`, `restored-context-store.mjs` |
| 7 | Static legacy restored copy-verify-delete | ГОТОВО | `restored-context-migration.mjs`, `restored-context-migration.test.mjs` |
| 8 | Restored context correction domain | ГОТОВО | `restored-context-store.test.mjs` |
| 9 | Archive revision finalize + one-winner CAS | ГОТОВО | `archive-revisions.mjs`, `archive-revisions.test.mjs` |
| 10 | Latest-finalized consumers | ГОТОВО | `archive-latest.mjs`, `archive-consumers-latest.test.mjs` |
| 11 | Migration 026 stream/heads/pending | ГОТОВО | `server/sql/026_parallel_shift_dependencies.sql`, `replica-stream-026.test.mjs` |
| 12 | Replica v2 normalization/hash, parents | ГОТОВО | Код: `server/src/replica-heads.mjs` (`normalizeReplicaOperation`, `hashReplicaOperationV2`, строгая `protocolVersion !== 2 → protocol-upgrade-required`, `parentState` object/user/shift/truck) + реэкспорт из `replica-materialize.mjs`; в `replica-store.mjs` добавлен deterministic topological batch order §4.10. Доказательства в `server/tests/replica-store.test.mjs` (19/19): golden-вектор v2 `37bfd01e…017d` и независимость от порядка ключей; v1 byte stability `a1c1c014…f671` (protocol/hash version 1, повтор не переписывает); точный Firebase v1 shift `{id,objectName,objectId,startDate,startedAt,startedBy,isActive}` → `protocol-upgrade-required` без записей; sender≠creator (`opened_by_uid` = creator из документа, не uid пачки); delete `data:null` ≡ отсутствие `data` (один hash, в stream нет `data`), иное `data` → `invalid-replica-delete-payload`; `data.id` ≠ path → `replica-document-id-mismatch`; heads для objects/users с routing-колонками; missing object/user → полный откат пачки вместе с уже материализованным родителем; same-batch order «shift раньше object, status раньше truck» проходит, head сохраняет arrival-seq |
| 13 | Head/pending/delete materializer | ГОТОВО | коммит `2b8a8b6`: `server/src/replica-heads.mjs` (CAS/stale/replay, pending staging+promotion с перечитыванием immutable stream, `verifyReplicaHeads`), `replica-pending-materialize.test.mjs` 10/10, `replica-store.test.mjs` 10/10; соседние корни `replica-materialize` 5/5, `replica-materialize-parallel-shifts` 4/4, `replica-stream-026` 20/20 |
| 14 | Objects/users tombstones + collection verifier | НЕ НАЧАТО | зависит от 13 |
| 15 | Full exact provenance backup/restore | ГОТОВО (кроме ролевой границы БД) | ветка `feat/t15-exact-restore2`: `server/src/restore-bootstrap.mjs` (`BOOTSTRAP_VERSION=1`, digest по roles/relations/functions/extensions/grants/registry, `verifyRestoreBootstrap`, `restore-bootstrap-required`), `server/src/backup-store.mjs` (`bundleFacts`, `captureProvenanceBundle`, `checkpointReplicaBundle`, `normalizeBackupSelection`, `resealBundle`, `verifyBundleManifest`, `restoreReplicaExact`), `server/tests/replica-exact-backup.test.mjs` (7 подтестов, db-корень `replica-exact-backup`, baseline S24 + сам применяет 025/026, `bootstrapEnvByFile:['bootstrap-url']`, `migrationsThrough:26`), `server/tests/backup-store.test.mjs` (+1 регрессия: легаси-выбор остаётся выборочным). Прогоны: 7/7, `backup-store` 4/4, `replica-store`/`replica-stream-026`/`archive-parallel-restore`/`archive-schema-025`/`archive-revisions`/`restored-context-store`/`restored-context-migration`/`replica-materialize` — все зелёные; `npm run check` + `node --check` новых файлов; `--list` 88 корней, `discovered == manifest`. Покрыто: нормализация отклоняет любой provenance/archive/restored/historical-член и неполный closure до checkpoint; bootstrap-required до мутации; data path без DDL/CREATE ROLE/регистрации (Proxy-guard); publication-before-receipt падает на `SET CONSTRAINTS ALL IMMEDIATE` (`fk_archive_publication_(restore|finalize)_receipt`); отсутствующие/чужие receipts откатывают транзакцию до verifier и `restore_epoch`; точный перенос pending/tombstone с однократным promotion; расширенный lifecycle-payload смены round-trip. **Открыто:** `SECURITY DEFINER restore_replica_exact(...)` + временный `EXECUTE`/`REVOKE` + пробы effective privilege — нет DDL в 025/026, кандидат в 028 (см. ниже) |
| I7 | Immutable S26 template + fixtures | НЕ НАЧАТО | гейт после 15 |
| 16 | V2 errors, JCS hash, receipts | ГОТОВО | `server/src/v2-errors.mjs`, `server/src/v2-command.mjs`, `server/tests/v2-command.test.mjs` (16 тестов, db-корень `v2-command`, вектор `1179ba8a…6a64`); конверт `{protocolVersion:2,operationId,replayed,result}`, авторизация до replay, откат receipt/audit/mutation |
| 17 | Permissions и shift ACL | ГОТОВО | коммит `feat: add parallel shift permissions and acl` (ветка `feat/t17-shift-acl`): `sql/027_parallel_shift_permissions.sql`, `src/shift-access-v2.mjs` (`loadActor`/`authorizeShift`/`visibleShiftPredicate`), `identity-rules.mjs` (+2 action). Тест `tests/v2-shift-access.test.mjs` — 13 подтестов, db-корень `v2-shift-access` (первый на baseline S25, применяет 026/027 сам), `--list`: `discovered=84 manifest=84`. Покрыто: дефолты матрицы (manage_shift_members — foreman+senior, force_transfer_truck — только senior), admin без membership, hidden=404 / команда=403, closing=409 и closed=410, detached source∨destination, отзыв membership между вызовами не выдаёт receipt |
| 18 | Visible list/snapshot + router | ГОТОВО | коммит `feat: add visible shift list and scoped snapshots` (ветка `feat/t18-v2-router`): `src/shift-read-v2.mjs` (`listVisibleShifts`, `readShiftSnapshot`, `encode/decodeShiftCursor`), `src/v2-router.mjs` (`matchV2Route`/`handleV2Request`), `src/index.mjs` — `/api/v2/*` отвечает роутер, `/api/v1` и health не тронуты; `v2-errors.mjs` +2 кода (`not-found` 404, `method-not-allowed` 405, статус 405 в списке). Тесты: db-корень `v2-shift-read-db` (baseline S24 → сам применяет 025/026/027, 9 подтестов: только active/closing, `historical`/`restored`/`unresolved` не листятся, keyset `opened_at DESC, shift_id ASC` с непрозрачным курсором `v2.1.<base64url>`, limit 1..100 default 50, admin — все смены workspace, прочие — membership; snapshot с `shiftId` у каждой status/log, `detachedOpenTrips` с обеими метками, 404 `shift-not-visible`, `closed` читается участником; trap B — отпечаток B (count/revision/checksum) до и после чтений A) + unit-корень `v2-router` (10 тестов: 404/405/426/401 до ридеров, парсинг query, стабильное тело ошибки, отказ вне `/api/v2`); `--list`: `discovered=86 manifest=86`. Живая проверка реального `src/index.mjs` на одноразовой БД: 8/8 (v2 404/405/426/401 + `/api/v1/authority` 401 и `/api/v1/nope` 404 без изменений). Осталось задачам 19–22: подключить command-маршруты через `matchV2Route` и `runV2Command` |
| 19 | Shift create/object/members | НЕ НАЧАТО | — |
| 20 | Truck assignment/force transfer/detached | НЕ НАЧАТО | — |
| 21 | Scoped line operations, object lock | НЕ НАЧАТО | — |
| 22 | Two-phase close + material marker | НЕ НАЧАТО | — |
| 23 | Shift contexts и generation guards | ГОТОВО | коммит `38c89eb`, `40-shift-contexts.js` + 19 тестов |
| 24 | V2 transport и offline journal | ЧАСТИЧНО | транспорт — коммит `11c76a0`, `41-v2-transport.js` + 26 тестов; офлайн-журнал `42-offline-v2.js` не начат |
| 25 | Selector и management UI | НЕ НАЧАТО | — |
| 26 | Restored mode/archive history/unresolved wording | НЕ НАЧАТО | — |
| 27–29 | Cross-domain, inventory, protocol gate + acceptance | НЕ НАЧАТО | — |
| 30–31 | Rehearsal/runbook, release gate | НЕ НАЧАТО | — |

## Долги вне плана (закрыты 26.11.2026)

| Долг | Статус | Коммит |
|---|---|---|
| Упавший тест-файл оставлял живыми потомков (вешал следующий прогон) | ГОТОВО | `abd66b2` |
| Клиент выводил день/ночь из часа, сервер — нет | ГОТОВО | `195be0c` |
| `pool.on('error')` отсутствовал — terminate сессии ронял API | ГОТОВО | `79223b1` |
| Legacy-смену без типа нельзя было закрыть | ГОТОВО | `ad85594` |
| Сборка `working-test` не воспроизводится байт-в-байт | расследование закрыто: артефакты устарели на 2 коммита, сборка детерминирована | `f6f757d`, §38 |
| Task 12: golden-вектор v2, sender≠creator, delete null, id/path mismatch, missing parent rollback, same-batch order, v1 byte stability | ГОТОВО | этот коммит `test: prove replica v2 provenance and parent order` — 9 кейсов в `replica-store.test.mjs`, плюс исправлен порядок материализации пачки (`replica-store.mjs`); см. `docs/opyt-oshibok.md` п.41 |

## Долги по схеме, открытые задачей 16 (для 027)

Схема 025/026 не содержит generic-таблицы аудита v2 и не расширяет
`shift_operation_receipts`. Задача 16 (только модули и тесты) закрыта на
существующих таблицах. **027 (задача 17) эти долги НЕ закрывает** — она
добавляет только права ACL. Перенос остаётся открытым (кандидат — миграция 028
вместе с задачей 20/22, где появляются force transfer и двухфазное закрытие):

| Долг | Сейчас | Нужно в 027 |
|---|---|---|
| `shift_operation_receipts` без `protocol_version`/`command_hash`/`shift_id` (§4.5) | `request_hash` = `commandHash` (SHA-256 JCS), протокол связан хешем | добавить `protocol_version smallint NOT NULL`, `command_hash text NOT NULL`, `shift_id text` + FK `(workspace_id,shift_id)` |
| Нет shift-scoped audit для v2-команд | `workspace_service_audit` (operation_id/uid/type/before/after), `shiftId` внутри before/after | `shift_command_audit(workspace_id,shift_id,operation_id,uid,type,before_state,after_state,recorded_at)` + append-only guard; перевести `V2_AUDIT_TABLE` |
| `workspace_service_audit` не имеет `shift_id` | фильтрация только по `before_data->>'shiftId'` | при появлении таблицы из строки выше — миграция существующих строк |

Следствие для чтения (задача 18): пока у `shift_operation_receipts` нет
`shift_id`, `pendingServerReceipts` в видимом списке честно равен `0` —
привязать незавершённый receipt к смене нельзя. `listVisibleShifts` уже
проверяет наличие колонки и без неё не считает; как только `shift_id`
появится, тот же запрос начнёт отдавать реальные числа без правки чтения.

## Долги по схеме, открытые задачей 15 (кандидат — 028)

Спецификация §4.10 требует для exact restore отдельный NOLOGIN restore owner и
узкий `SECURITY DEFINER restore_replica_exact(...)` (фиксированный `search_path`,
owner-qualified объекты, входные temp-таблицы, без динамического SQL), причём
`PUBLIC`/runtime не имеют `EXECUTE`, а отдельный maintenance executor получает
временный `EXECUTE` только после destructive approval и проверки
owner/signature/body-checksum, после чего grant отзывается и effective privilege
проверяется. Ни 025, ни 026, ни 027 такого объекта не создают.

Задача 15 реализовала нормализацию, bootstrap-fingerprint, checkpoint и сам
restore как серверный модуль (`server/src/backup-store.mjs`) на клиенте БД: все
вставки идут в одной транзакции в нормативном порядке, data path не содержит
DDL/`CREATE ROLE`/регистрации, а тест 3 это доказывает Proxy-guard'ом. Чего
нельзя доказать без DDL:

| Долг | Нужно в 028 |
|---|---|
| Нет `restore_replica_exact(...)` и restore owner | создать NOLOGIN owner, `SECURITY DEFINER` функцию с фиксированным `search_path`, `REVOKE EXECUTE FROM PUBLIC`, ownership таблиц/триггеров |
| Нет временного `EXECUTE`/`REVOKE` для maintenance executor | отдельная не-runtime login-роль, grant после preflight, revoke после транзакции, пробы effective privilege до/после |
| Не проверяются `proowner`/`prosecdef`/body checksum | preflight по `pg_proc`/`pg_roles`/`pg_auth_members` + checksum тела функции |
| Legacy v1-смена (`payload_schema_version <> 2`) не восстанавливается | точный путь вставки v1-строки под owner-функцией; сейчас restore честно возвращает `restore-legacy-shift-blocked` |

До появления 028 задача 15 закрыта как «домен и тесты ГОТОВО, ролевая граница
БД ОТКРЫТА»: приложение не должно выпускать restore в рабочую БД, пока
`EXECUTE` не ограничен владельцем функции.

## Открытые наблюдения (причина не доказана, следить)

| Наблюдение | Факт | Что проверить |
|---|---|---|
| Один прогон `--file tests/v2-shift-access.test.mjs` завершился `exit=1` с **нулевым** выводом (0 байт, ни TAP, ни stderr), сразу повторный — 14/14 зелёный, код между прогонами не менялся | задача 17, 26.11.2026; в тот момент на том же кластере шёл DB-прогон другого агента | если повторится — снять `--report` и проверить, не теряется ли вывод при одновременных прогонах на общем кластере. Контрольный прогон главного после слияния: `exit=0`, stdout 3148 байт, 14/14 — не воспроизвелось |
| **Повторилось** (задача 18): два подряд прогона `--file tests/v2-shift-read-db.test.mjs` дали `exit=1` и ровно 0 байт вывода, при этом следующие запуски **той же команды** дали полный TAP (сначала 3 падения по существу, потом 9/9 `exit=0`, 2000 байт) | 26.11.2026 ~21:51 MSK, тот же изолированный кластер на 55432; между «пустыми» и рабочими прогонами код не менялся, менялось только перенаправление вывода (`> файл`, `\| tee`, `\| head`) — и последний прогон с `> файл` прошёл | похоже на потерю вывода раннера, а не на падение теста: сам тест-процесс при повторном прогоне отдаёт полный TAP. Проверять при следующем случае: `--report <файл>` и наличие отчёта при пустом stdout; не считать «0 байт + exit=1» доказательством падения теста — обязателен повторный прогон |

## Правило порядка (нарушено один раз, не повторять)

План требует: фазы I–III → гейт I7 → фазы IV (16–22) → V (23–26). Задачи 23–24 были выполнены ДО фазы IV из-за устаревшей копии плана в корневом checkout (нумерация «Task 13/14» вместо «Task 23/24»). Клиентские модули самостоятельные и в UI не подключены, но транспорт писался по спецификации, а не по живым ответам сервера — контракт перепроверяется в задаче 29 (acceptance) после появления v2 API. Дальше строго по порядку плана этой ветки.
