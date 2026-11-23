# Изолированный PostgreSQL-набор: одна временная БД на test-file

Дата: 23.11.2026  
Статус: решение владельца зафиксировано; готово для implementation plan  
Область: только тестовая инфраструктура `server/`; production/live API и БД не используются и не изменяются.

## 1. Замысел и причины

Текущий launcher запускает несовместимые PostgreSQL-тесты на одной БД. Файлы ожидают разные baseline (`empty`, миграции по 024/025, import/auth/authority/replica fixtures), а некоторые глобально меняют схему или данные. Поэтому порядок и параллельность создают ложные падения, утечки состояния и не позволяют считать официальный DB suite доказательством корректности Task 2.

**Решение владельца:** каждый PostgreSQL test-file получает отдельную временную database, созданную для одного запуска и удалённую после него. Один test-file выполняется одним дочерним Node-процессом; HTTP-тест также остаётся отдельным процессом внутри своего файла.

### Цели

- Детерминированный полный DB suite без межфайлового состояния.
- Явный baseline и fixtures для каждого DB test-file.
- Быстрое создание БД клонированием неизменяемых templates.
- Безопасное удаление только БД, созданных данным runner.
- Полное покрытие manifest: новый DB consumer нельзя незаметно запустить без декларации.
- Продолжать запуск остальных файлов после ошибки и вернуть единый воспроизводимый отчёт.

### Не входит

- Изоляция отдельных `test()` внутри одного файла; их координация остаётся ответственностью файла.
- Изменение продуктовых миграций ради runner, бизнес-логики, production compose/deploy или общей БД.
- Контейнер на каждый файл, schema-per-file либо совместное использование live/test серверной БД.
- Хранение credentials в manifest, выводе или документации.

### Антицели

Нельзя: разрешать тесту выбирать произвольную БД/URL; считать общий `samosval_test` тестовой целью; удалять БД по имени без ownership/session-проверки; передавать DB env unit-фазе; скрывать skipped/missing manifest entries; останавливать suite после первого падения; сохранять временную filename-based классификацию destructive tests.

### Ограничения

PostgreSQL 16 берётся только из локального `server/compose.test.yaml`. Официальный hostile-environment security boundary остаётся прямой executable `server/scripts/test-isolated-db.sh`: до Node он удаляет `NODE_OPTIONS` и `NODE_PATH`. `npm run test:db` — только convenience alias. Исторические migration guards трансформируются исключительно существующим test helper после marker/target validation; исходный checksum миграции не меняется.

## 2. Рассмотренные подходы

| Подход | Плюсы | Минусы | Решение |
|---|---|---|---|
| **A. Unique database/file** | Настоящая изоляция globals/schema; естественный `current_database()`; понятный cleanup; безопасная параллельность | Нужны admin connection, templates и manifest | **Выбран владельцем** |
| B. БД по группам baseline | Меньше БД/клонов | Ошибка manifest или destructive test снова загрязняет соседей; группы превращаются в скрытый порядок | Отклонён |
| C. Одна общая БД, строго последовательно | Простая первоначальная реализация | Медленно; reset не гарантирует очистку глобальных объектов/connections; HTTP child и разные baselines конфликтуют | Отклонён |
| D. Schema на файл | Быстро и одна database | Миграции, extensions, `public`, database-level объекты и hard-coded schema не изолированы; guards видят общее имя | Отклонён |

## 3. Точная архитектура

### 3.1. Фазы runner

1. **Чистая unit-фаза:** runner обнаруживает файлы без DB dependency и запускает их без `TEST_DATABASE_URL`, `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` и без isolated marker. Попытка unit-теста зависеть от внешнего DB env должна проявиться как ошибка/skip policy, а не случайное подключение.
2. **Admin preflight:** через отдельный admin URL проверяются protocol, host, port, marker, server identity, допустимый container/local endpoint, текущая admin database и роль. Query/search-параметры и fragment запрещены.
3. **Template preparation:** один раз на run создаются/проверяются immutable templates `empty`, `S24`, `S25`, `S26`; S26 обязателен для replica staging/dependent tests после появления миграции 026.
4. **Per-file execution:** для каждой manifest entry клонируется новая target database, применяются custom schema/fixtures, затем запускается ровно один `node --test ... <file>` child с URL только этой БД.
5. **Aggregation:** результаты собираются в стабильном manifest-порядке; ошибка файла не отменяет ещё не начавшиеся файлы.
6. **Cleanup:** после каждого child и в общем `finally` завершаются только sessions target DB, БД удаляется; в конце выполняется leak check по run marker/prefix.

### 3.2. Декларативный manifest

Единственный versioned manifest (рекомендуемый путь `server/tests/db-test-manifest.mjs`) перечисляет **каждый** PostgreSQL test-file ровно один раз. Manifest — данные, не исполняемые callbacks; fixture names разрешаются через закрытый registry runner.

Обязательная форма entry:

```js
{
  file: 'tests/parallel-shifts-migration-core.test.mjs',
  baseline: 'S24',                 // empty | S24 | S25 | S26
  migrationsThrough: 25,           // null либо целое >= baseline version
  customSchema: [],                // allowlisted registry IDs
  importTables: [],                // явные import fixture IDs
  fixtures: ['parallel-shifts'],   // allowlisted registry IDs
  timeoutMs: 120_000,
  serial: false,
  exclusive: false
}
```

- `file` — canonical realpath внутри `server/tests`, без symlink/traversal/options.
- `baseline` обязателен. `empty` содержит только пустую canonical database; `S24`/`S25`/`S26` — миграции до указанной версии и registry/checksum.
- `migrationsThrough` задаёт миграции, применяемые **после клона**; для тестов самой миграции допустимо `S24 + through 25`. Нельзя заявить версию ниже baseline.
- `customSchema`, `importTables`, `fixtures` — массивы имен из закрытых registries. Import, authority, auth и replica данные всегда названы явно, а не выводятся из filename.
- `timeoutMs` имеет общий допустимый диапазон и не отключает cleanup.
- `serial: true` запускает файл эксклюзивно, без одновременно работающих normal/serial/exclusive children, из-за подтверждённого глобального состояния; общую БД это не даёт.
- `exclusive: true` имеет ту же scheduling-эксклюзивность и дополнительно фиксирует владение внешним ресурсом (например, HTTP port); его БД всё равно уникальна. Причина обязательна в metadata и проверяется review.

Неявных defaults для baseline/fixtures нет. Неизвестные поля, fixture ID, дубли `file`, одновременно `serial:true` и `exclusive:true`, отсутствующий файл и недопустимая migration chain блокируют запуск до соединения с target DB.

### 3.3. Admin connection и templates

Admin connection используется только orchestration-кодом и указывает на maintenance database `postgres` локального compose PostgreSQL, не на target/template. Он не передаётся test child. Допускаются только host `127.0.0.1`, `localhost`, `::1` для host-runner либо точное compose service name `postgres` внутри подтверждённой compose network; любой внешний IP/DNS запрещён.

Runner создаёт run-scoped templates из canonical empty database:

- `empty` — чистая `public` с требуемым owner/privileges;
- `S24` — миграции 001–024 с контролируемой test-only заменой известных legacy guards;
- `S25` — S24 + redesigned миграция 025: strict v2 плюс conditional legacy unresolved provenance; postconditions проверяют nullable только для provenance fields `opened_by_uid/shift_type` при independently marked unresolved (прочие nullable state/object-lock columns имеют собственные constraints), `closed|historical`-only unresolved type, distinct normal-close vs historicalization constraints, immutable archive series/revision chain+latest pointer/publication, dedicated restored-context parent/children и migration-evidence FK, canonical historicalization report bytes/confirmation binding, отсутствие hour/display/sender inference, role split уже в/до 025 и закрытый runtime legacy writer;
- `S26` — S25 + миграция 026; используется тестами staging/dependent attribution/full exact restore и не включает fixture rows. Postconditions включают heads/routing для `objects/users/shift/trucks/truckStatus/logs`, collection-specific soft-tombstone/physical-delete policy и единый bootstrap-before-data full-restore verifier. Это целевой template после атомарного S26 cutover commit; до него chain заканчивается S25 согласно transition rule раздела 3.11.

Фактические имена templates также имеют строгий generated prefix и run marker. После подготовки template переводится в `datallowconn=false`; к нему нет test URL, custom fixtures в него не применяются. Проверяется migration registry и checksum. Клон создаётся `CREATE DATABASE <target> TEMPLATE <template>` только после отсутствия sessions template. Custom schema/import/fixtures применяются к клону в manifest-порядке и никогда не меняют template. Templates удаляются при завершении run после targets.

### 3.4. Имена, длина и collision

Target name имеет форму:

`Samosval_parallel_shifts_test_<runid>_<hash>`

После нормализации PostgreSQL используется lowercase:

`samosval_parallel_shifts_test_<runid>_<hash>`

- prefix фиксирован байт-в-байт;
- `runid` — криптографически случайный lowercase hex для запуска, минимум 12 символов;
- `hash` — первые 12 lowercase hex SHA-256 от canonical relative file path; template использует отдельную форму имени с тем же run prefix и явным ASCII kind suffix (`tpl_empty|tpl_s24|tpl_s25|tpl_s26`), поэтому target cleanup никогда не принимает template;
- итог не длиннее PostgreSQL `NAMEDATALEN-1` (63 bytes). Сначала резервируются prefix, separators, полный runid и hash; человекочитаемая часть не добавляется. Молчаливое PostgreSQL truncation запрещено;
- перед `CREATE DATABASE` проверяется точное отсутствие имени. Collision не переиспользуется: генерируется новый runid (ограниченное число попыток), иначе runner падает до тестов;
- имя `samosval_parallel_shifts_test` без runid/hash — историческое и **никогда** не является target нового suite.

### 3.5. Процессы и окружение

Каждый manifest file получает один отдельный Node child. Runner не запускает несколько DB-файлов одним `node --test`; следовательно, module globals, hooks, pools и child process файла не пересекаются с другим файлом. Child получает новый `TEST_DATABASE_URL` только к своей БД, `SAMOSVAL_ISOLATED_TEST=1`, run/target ownership marker и очищенные Node startup env. Общего `TEST_DATABASE_URL` на уровне всего suite нет.

Unit child env строится не копированием parent env с удалением пары ключей, а из explicit allowlist (`PATH`, `HOME`, `TMPDIR`, locale/timezone и versioned test-only nonsecret variables). Безусловно удаляются все имена, начинающиеся `PG` или `POSTGRES_`, а также `TEST_DATABASE_URL`, `DATABASE_URL`, admin URL, role credentials, isolated marker, run/database marker и любые DB aliases. DB child получает поверх того же allowlist только минимальные generated target variables; orchestration/admin URL никогда не наследуется.

HTTP integration file объявляется `exclusive` при фиксированном порте. Он может стартовать API как grandchild, но наследует URL своей target DB; runner отслеживает process group, timeout и завершение descendants до drop.

### 3.6. Concurrency и результаты

Execution limit равен `min(4, availableParallelism, connectionBudget)`, где `connectionBudget` вычисляется из подтверждённого `max_connections` минус admin/provisioning reserve и максимума pool на один file; user `--jobs N` может только уменьшить этот предел. Provisioning всегда semaphore=1. По архитектурному решению и `serial`, и `exclusive` jobs выполняются **эксклюзивно**: ждут всех normal jobs, блокируют старт новых и не пересекаются друг с другом. `exclusive` дополнительно резервируется для внешнего фиксированного ресурса/порта. Планирование детерминировано по canonical manifest order.

Для каждого файла фиксируются: path, baseline, redacted generated database suffix/hash, start/end, duration, exit/signal/timeout, setup/cleanup status. Console может идти с префиксом файла; итог всегда сортируется по manifest, не по времени окончания. Failures не fail-fast: новые файлы продолжаются, если сам orchestrator/admin safety не потерян. Потеря safety invariant прекращает создание новых БД, но cleanup уже созданных продолжается.

Skip policy читает machine-readable события штатного Node test reporter, а не grep human output. Каждый skip сопоставляется с versioned `allowedSkips` entry (`test name/id`, reason, optional platform/Node condition). В official full suite любой DB-test skip, неизвестный skip, changed condition либо разрешённый skip вне условия — failure. Допустимы только явно versioned ожидаемые skips; unfiltered CI acceptance требует `unexpectedSkips=0` и отдельно показывает `allowedSkips`.

### 3.7. Cleanup и leak check

Cleanup выполняется на pass, assertion failure, setup failure, timeout, `SIGINT`, `SIGTERM`, `SIGHUP` и обычный exception. Каждый child стартует POSIX `spawn` в отдельной process group. Точный interrupt algorithm:

1. первый signal атомарно записывает original signal/interrupted=true и прекращает scheduling/provisioning;
2. всем активным process groups посылается `SIGTERM`;
3. runner ждёт фиксированный versioned grace interval;
4. живым groups посылается `SIGKILL`, затем выполняется обязательный `wait`/reap каждого child;
5. закрываются child-owned и runner target pools;
6. повторно валидируются admin endpoint, exact target name, prefix, runid, owner, COMMENT и tracked state;
7. только target получает `REVOKE CONNECT`/`ALLOW_CONNECTIONS false`; `pg_terminate_backend(pid)` вызывается только для exact `pg_stat_activity.datname`, исключая текущую admin session;
8. после zero sessions выполняется safely quoted `DROP DATABASE` exact target; затем отдельным predicate удаляются templates;
9. записываются atomic report и leak check; только после них runner re-emits original signal самому себе с восстановленным default handler.

Второй/последующие signals не запускают cleanup повторно, не меняют original signal и лишь отмечаются в report; алгоритм идемпотентен. Финальный leak check использует exact tracked set + `starts_with` generatedRunPrefix по правилу раздела 4. Любая утечка — suite failure с именами без URL/credentials. Старые leak-и другого runid не удаляются автоматически: выводится безопасный отчёт для ручного разбора.

### 3.8. Redaction

Ни stdout/stderr, ни JSON/JUnit artifact не содержат credentials или полный URL. Redactor обрабатывает userinfo, password env, URI-encoded variants и PostgreSQL error context. В отчёте допустимы protocol, allowlisted host class, port, generated db name и file hash. Child output проходит redaction до печати/сохранения.

### 3.9. Полный versioned inventory

Manifest является не только перечнем DB-тестов, а **полным versioned inventory всех прямых файлов `server/tests/*.test.mjs`**. Fixture-файлы под `server/tests/fixtures/` в основной inventory не входят: они перечисляются отдельным `harnessFixtures` registry и могут запускаться только harness-contract тестами. Формат верхнего уровня содержит `manifestVersion`, `entries` и `harnessFixtures`; изменение состава или классификации требует diff и review.

Каждая entry имеет обязательные поля:

```js
{
  file: 'tests/example.test.mjs',
  kind: 'unit', // unit | db | harness-contract
  discovery: 'pure-import', // direct | indirect-http | pure-import | harness-contract
  reason: 'Проверяет чистое доменное правило; соединений с PostgreSQL нет',
  // DB-поля обязательны только при kind: 'db'
  baseline: null,
  migrationsThrough: null,
  customSchema: [],
  importTables: [],
  fixtures: [],
  timeoutMs: 30_000,
  serial: false,
  exclusive: false,
  allowedSkips: []
}
```

- `kind: unit` — процесс не получает DB env; `discovery: pure-import` означает подтверждённый статическим аудитом чистый импорт без DB consumer.
- `kind: db` — ровно одна generated DB; `discovery: direct` означает прямое чтение DB env/`pg`, `indirect-http` — API/HTTP child либо импорт DB-зависимого store/helper. `reason` называет конкретный consumer.
- `kind: harness-contract` — проверка самого launcher/guard/process/signal/compose contract; `discovery: harness-contract`. Она запускается в отдельной harness-фазе с только тем окружением, которое явно задаёт её contract, и не считается обычным DB test-file.
- Смешанный файл, где pure unit assertions соседствуют с DB seed/integration assertions (прежде всего исторические `seed-*`), **обязательно разделяется на отдельные unit и DB files до CI cutover**. Классифицировать смешанный файл как unit или полагаться на runtime skip запрещено.

Discovery сканирует весь `server/`, а не только tests: строит import graph от каждого test-file, ищет `pg`, DB helpers, DB env, запуск `src/index.mjs`/HTTP child и hard-coded database names. Manifest completeness требует: `set(discovered server/tests/*.test.mjs) == set(entries.file)`, каждое имя встречается один раз, canonical realpath совпадает, kind/discovery согласованы со scan. Missing, duplicate, stale entry или расходящийся reason-class блокируют запуск. Harness fixture не может появиться в `entries`, а root test-file — только в `entries`.

### 3.10. PostgreSQL roles, bootstrap и ownership

Compose bootstrap создаёт две login roles без встроенных credentials в репозитории:

- **orchestration role** — `LOGIN CREATEDB`, не superuser; подключается только к local compose maintenance DB. Она создаёт/comment/alter/drop только generated databases после runner guards, не владеет admin/template databases и не передаётся детям. Широкий `pg_signal_backend` ей не выдаётся: bootstrap даёт `EXECUTE` только на минимальную `SECURITY DEFINER` cleanup-функцию, которая внутри повторно проверяет ASCII generated prefix, reserved set, exact database COMMENT/owner/current run marker и завершает sessions только exact target; управлять non-generated DB через неё невозможно;
- **test role** — `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`; получает `CONNECT` только к своему target, до S24 владеет test schema/objects, не знает admin URL и не может управлять другими БД. Для S25 orchestration bootstrap заранее создаёт уникальные run-scoped `NOLOGIN schema_owner`, более узкий `NOLOGIN migration_evidence_owner`, `LOGIN runtime` и отдельный non-runtime maintenance executor без credentials в manifest/logs. Bootstrap/deployment authority назначает ownership напрямую; test/runtime/maintenance роли не получают membership или `SET ROLE` в owners. После preflight/confirmation maintenance executor получает временный `EXECUTE` только на exact checksummed migration function, затем grant отзывается и effective privilege проверяется. Runtime не member owner/test/orchestration/maintenance. Эти роли имеют generated run marker и удаляются bootstrap cleanup только после удаления всех run DB; test child не получает owner/maintenance credentials. Поэтому S25 role-boundary проверяется реалистично без выдачи test role `CREATEROLE`, superuser или owner membership.

Orchestrator хранит in-memory запись target с монотонными состояниями `creating → created → marked → running`. Сразу после `CREATE DATABASE` он выполняет `COMMENT ON DATABASE <exact> IS '<versioned marker: runid, fileHash, owner>'`, перечитывает `pg_database`/`shobj_description` и только затем переводит target в `marked`. Test child стартует лишь из `marked`, после чего состояние `running`.

Cleanup target допустим только при одновременном совпадении exact ASCII-lowercase name, runid, ожидаемого owner, exact versioned COMMENT и tracked state `marked|running`. Если COMMENT отсутствует/изменён, owner иной или state не достиг `marked`, runner fail closed: terminate/drop не выполняются, запись попадает в leaks/safety report. Объект, застрявший в `creating|created`, удаляется автоматически только если в той же admin session доказаны exact generated name, owner и current-run creation receipt; иначе также только reported leak.

### 3.11. Точный lifecycle templates и provisioning

Все admin DDL (`CREATE/ALTER/DROP DATABASE`, `COMMENT`) выполняются вне transaction, отдельными autocommit statements. Для provisioning действует глобальный semaphore **1** независимо от execution concurrency.

1. `empty` создаётся `CREATE DATABASE ... TEMPLATE template0 OWNER <testRole>` с ожидаемыми encoding/locale; test role получает ownership database/public schema и необходимые `CONNECT/CREATE`, `PUBLIC` и лишние роли получают `CONNECT` revoke.
2. `S24` клонируется из доступного `empty`, мигрируется 001–024 test role, сверяются registry/checksums/postconditions; затем S24 остаётся доступен ровно до создания S25.
3. `S25` клонируется из доступного `S24`, применяется только 025, сверяются registry/checksum/postconditions.
4. `S26` клонируется из доступного `S25`, применяется только 026 (`replica_pending_documents`, `replica_document_heads`, stream protocol/hash/immutability и dependent attribution), сверяются registry/checksum/postconditions. Существование S26 отражает dependency replica staging/dependent-attribution тестов от миграции 026 (amendment parallel shifts design от 23.11.2026). **Transition rule:** в каждом commit scanner сохраняет `discovered == manifest`: commit до появления 026 не содержит S26 template/fixtures/future entries; commit, добавляющий 026 или первый root test, зависимый от неё, атомарно добавляет S26 template contract, fixture registry и все реально существующие root entries. Несуществующие будущие test paths нельзя заранее держать в machine-readable manifest.
5. `empty` закрывается после клона S24, S24 — после клона S25, S25 — после клона S26, S26 — после собственной проверки. Для каждого закрываемого final template: запрет новых соединений (`ALLOW_CONNECTIONS false`/`datallowconn=false`), `REVOKE CONNECT FROM PUBLIC` и test role, exact zero sessions. Только после zero sessions template считается immutable/clone-ready. Для `CREATE DATABASE ... TEMPLATE` соединения к source не требуются, поэтому после freeze доступ не включается обратно; при ошибке clone template остаётся закрытым.
6. Target clone получает owner test role и минимальные privileges; затем COMMENT marker и custom fixtures. Template COMMENT имеет отдельный kind marker и никогда не удовлетворяет target cleanup predicate.

### 3.12. Fixture registry и baseline contract

Versioned fixture registry содержит только следующие начальные IDs и проверяемые postconditions:

| ID | Назначение и обязательный postcondition |
|---|---|
| `import-schema` | Созданы ожидаемые import/source tables и indexes; таблицы пусты, registry checksum совпадает |
| `identity-empty` | Identity schema доступна, но users/credentials/decisions/revocations пусты; owner/admin не seeded |
| `auth-schema-018` | Применена test-only 018, существует `user_credentials` с ожидаемыми constraints/indexes, строк нет |
| `authority-main-ubuntu` | Authority row/config для main Ubuntu source существует ровно один раз, active/default значения проверены |
| `authority-main-firebase` | Альтернативная Firebase authority fixture существует ровно один раз и не сосуществует как active с Ubuntu, если test явно не заявляет обе для conflict-case |
| `replica-admin` | Создан только versioned replica admin test user/grants, без live UID/email/secret |
| `replica-empty-stream-cursors` | Replica stream/cursor schema присутствует, cursor/stream/event tables пусты и начальные sequence/postconditions проверены |
| `replica-pending-empty` | Только на baseline S26: pending+document-head schema, protocol/hash columns, immutable trigger/grants и exact PK/FK/index/check contract существуют; stream/cursor/heads/staging пусты; payload в staging отсутствует |
| `parallel-shift-legacy-unresolved` | Только S25+: matrix без combinatorial excess: historical/closed v1 `(identity,type)` source/unresolved, unresolved/source, unresolved/unresolved и post-resolution manual/unresolved, unresolved/manual, manual/manual; nullable только provenance opener/type по equivalence checks. `closed` fixtures имеют normal `closed_at/by`, `historical` — только historicalization metadata; смешение отвергается |
| `parallel-shift-v2-night` | Только S25+: exact published strict v2 night JSON с MSK-consistent timestamp, source/source UID/type и display snapshot; transport sender UID намеренно иной. Negative variants: extra restore aliases, manual/unresolved/NULL v2, alias mismatch, SQL NULL/unknown enum |
| `parallel-shift-cutover-report` | Только S25 migration integration: active+closing unresolved-type canonical JCS report exact bytes/hash/schema/redaction policy, backup/fingerprint/expiry и owner-visible per-shift summary: assignment count, exact status-field counts (`onLine`, arrival/load timestamps, loaded-after-arrive, pending/collected TTN), unfinished-cycle count, snapshots-to-create, policy-gated opaque truck IDs и fixed release/preserve-not-complete consequences. Mutation каждой категории/текста/redaction policy инвалидирует одноразовую confirmation; reason `legacy-type-unresolved-at-cutover`, old→`historical` audit, immutable status snapshots, current assignment release, no synthetic close actor/time/effects, untouched logs/history/receipts/archive/material/tabel и all-or-nothing rollback |
| `parallel-shift-restored-contexts` | Только S25+: standalone/parallel legacy restored rows. Evidence parent имеет UUID `evidence_id`, PK workspace+evidence, unique workspace+context и exact context FK; child имеет только workspace+evidence parent FK и unique evidence+table+PK hash, без duplicated context. Проверяются orphan/wrong-workspace/second-parent/wrong-context child. Каждая source row имеет allowlisted locator/exact-lossless bytes/per-row+table roots. Static migration-only SECURITY DEFINER выполняет lock→manifest→context→parent→children/copies→verify→named trigger disable→exact delete→enable→source absence/evidence completeness→synthetic-anchor removal; mutation/omission/duplicate/wrong locator/arbitrary table/authority attempt abort, rollback возвращает originals+enabled triggers и удаляет copies, commit не оставляет double authority |
| `archive-immutable-revisions` | Только S25+: original/import revision byte-exact, hash-linked chain и publication provenance; exact `DEFERRABLE INITIALLY DEFERRED` publication→restore/finalize receipt FK. Concurrent finalize даёт одну next revision, replay идемпотентен, stale base abort untouched. Restore выполняет publication-before-receipt и затем `SET CONSTRAINTS ALL IMMEDIATE`; missing/dangling/wrong-workspace receipt откатывает до verifier/epoch/commit. List/default read/open/PNG-compatible export/material/report/analytics/backup projection используют latest finalized; explicit history/revision export возвращают original+все revisions exact bytes/hash |
| `restore-bootstrap-boundary` | S25/S26 restore integration: privileged bootstrap до data transaction создаёт only exact roles/schema/functions/grants/registry fingerprint; data restore без bootstrap отвергается до checkpoint, не имеет DDL/CREATE ROLE и не создаёт owner/admin/registration code; app users приходят только из bundle |
| `parallel-shift-runtime-role` | Только S25+: dedicated migration-evidence NOLOGIN owner владеет source/evidence tables, named triggers и exact checksummed SECURITY DEFINER; separate maintenance executor получает temporary explicit EXECUTE после confirmation и revoke+probe после. Runtime `NOSUPERUSER NOBYPASSRLS`, non-owner/non-member, no SET ROLE/direct DELETE/ALTER/TRIGGER/function invoke; PUBLIC revoked. Forged GUC/advisory lock/current-user claims не capability; session_replication_role запрещён; arbitrary table/static-dispatch probes и enabled-trigger postconditions обязательны |
| `replica-pending-out-of-order` | Только для staging integration tests на fresh S26 target: immutable v2 stream содержит versioned object/user/shift/truck/status/log set/delete generations; exact heads/routing ссылаются на stream FK; object/user soft tombstones сохраняют provenance, status/log pending ждут shift+truck. Canonical `shifts` содержит только strict v2 либо exact marked historical legacy snapshot, никогда placeholder; same-batch parent topological order и missing-parent rollback обязательны |
| `full-exact-provenance-restore` | Только S26 integration: полный manifest bundle со strict+historical shifts, complete archive revision bytes/hash chains/latest pointers/publications, standalone/parallel restored contexts+children+migration evidence, canonical historicalization reports/confirmations, all audits/receipts/domain effects, objects/users/trucks и stream/heads/pending/cursors/markers. Проверяет единственный bootstrap→data order из parallel design, deferred FK/CHECK/count/hash/provenance equality и collection-specific head verifier; каждый selective omission отклоняется до checkpoint/restore_epoch/mutation |

Baseline `S24` означает только canonical migrations 001–024 с их schema/default data; он **не включает** import rows, identity users, auth credentials, authority selection, replica admin или cursor rows сверх того, что неизбежно создаёт сама миграция. Любое требуемое отличие объявляется fixture ID. Fixtures идемпотентны только внутри fresh target, применяются в registry-defined порядке и после выполнения возвращают machine-checkable postcondition report.

### 3.13. Legacy guard registry

Generic `.replaceAll()` запрещён. Versioned guard registry для каждой исторической миграции задаёт: `migrationFile`, exact source string (включая пробелы), exact expected occurrence count, replacement template с generated target name и ожидаемый source SHA-256. Loader сначала сверяет checksum и число exact occurrences; `0`, лишнее совпадение, изменение текста или неизвестный guard — safety failure до SQL execution. Замена выполняется только перечисленных spans, а registry report хранит file/count/source hash без SQL payload. Добавление guard требует отдельной registry entry и красного integration contract test.

## 4. Непереступаемые safety invariants

1. `SAMOSVAL_ISOLATED_TEST=1` обязателен; официальный shell entrypoint первым действием удаляет `NODE_OPTIONS`/`NODE_PATH`.
2. Admin и target hosts принадлежат allowlist loopback/подтверждённого compose service. DNS, unix socket вне compose contract, cloud/live host запрещены.
3. Admin URL указывает только на maintenance DB `postgres`; target URL генерирует runner, пользователь не передаёт его.
4. В admin/target URL запрещены query overrides и fragment, включая `options`, `service`, `ssl*`, `target_session_attrs`, `host`, `hostaddr`; protocol только `postgres:`/`postgresql:`.
5. Server fingerprint/session checks подтверждают ожидаемый PostgreSQL 16 compose instance: allowlisted address/port, marker установлен runner bootstrap, current database/role ожидаемы. Одного совпадения имени недостаточно.
6. Immutable reserved/live set включает `postgres`, `template0`, `template1`, `samosval_test`, `samosval_working_test_reserve`, `samosval_parallel_shifts_test`, все admin/template generated names и **аддитивный** список configured production/common names. Конфигурация может только добавлять запреты, но не удалять встроенные. Перед каждым create/alter/terminate/drop выполняется ASCII case-fold и exact equality check; Unicode/non-ASCII identifier отвергается. Target cleanup ни при каких marker/owner данных не принимает admin либо template name.
7. Create/terminate/drop разрешены только exact generated names с prefix, текущим runid, tracked ownership COMMENT и ожидаемым owner/state. Non-prefix, foreign run, untracked, admin и template DB (кроме отдельного tracked template-cleanup predicate) не удаляются.
8. Перед terminate/drop повторяются все проверки; TOCTOU или изменение owner/COMMENT/state блокирует destructive действие и делает suite красным.
9. SQL identifiers состоят только из ASCII lowercase `[a-z0-9_]`, укладываются в 63 bytes и проходят PostgreSQL identifier escaping (`quote_ident`-эквивалент/двойное экранирование `"`); значения COMMENT/queries передаются параметрами. Имена/SQL не принимаются из test argv/manifest fixtures.
10. Test role владеет target objects, но не имеет `CREATEDB`, superuser или права на другие databases. Admin credentials существуют только в orchestrator env и не наследуются children.
11. Active sessions проверяются по exact `datname`; runner не завершает backend других БД или другого runid.
12. Leak check составляет объединение exact tracked names и результатов чтения `pg_database`, для которых приложение проверило JS/PostgreSQL `starts_with(datname, generatedRunPrefix)`; SQL `LIKE`, wildcard и regex запрещены. Каждый найденный объект затем проходит exact owner/COMMENT/type validation; mismatch только сообщается и не удаляется.
13. Любое сомнение трактуется как отказ без destructive query. Production/live DB не является допустимым fallback.

## 5. Полнота manifest

До запуска scanner статически и структурно обнаруживает DB consumers в `server/tests/**/*.test.mjs`:

- чтение `TEST_DATABASE_URL`, `DATABASE_URL` или `PG*`;
- создание `pg.Pool`/`pg.Client`/импорт DB integration helpers;
- импорт store/helper, помеченного DB-dependent registry;
- запуск API/HTTP child, которому требуется БД.

Список сравнивается с manifest: missing entry, duplicate entry, manifest file без DB dependency (кроме явного audited `dbConsumer: 'indirect-http'`) или неоднозначный consumer — preflight failure. Отдельный contract-test хранит expected discovery и доказывает, что добавленный DB-файл без manifest ломает CI.

Import/identity/auth/authority/replica не получают «магический общий seed». Manifest использует только IDs раздела 3.12 (`import-schema`, `identity-empty`, `auth-schema-018`, один/оба explicit authority fixture, `replica-admin`, `replica-empty-stream-cursors`, S25 parallel-shift fixtures, а после S26 cutover — `replica-pending-empty`/`replica-pending-out-of-order`). Registry описывает порядок и postcondition каждой fixture. Fixture не может подключаться к другой БД или менять template.

Отдельный static audit проходит **весь `server/`** (исходники, scripts, SQL, tests, compose/workflow references) и находит hard-coded `samosval_test`, `samosval_working_test_reserve`, `samosval_parallel_shifts_test` и database-name constructions. Versioned allowlist разрешает только точные `file + line/pattern + reason + expected count` для migration guard registry, reserved-name negative tests и compose bootstrap. Новое/исчезнувшее совпадение либо changed count блокирует cutover; runtime-код/tests setup должны использовать injected generated target, а не allowlist как обход.

### 5.1. Начальный inventory для cutover

Ниже обязательная исходная классификация текущих root files. Builder переносит её в machine-readable manifest; scanner обязан подтвердить её либо потребовать осознанный versioned diff. `reason` в реальном manifest должен называть точный import/env/process consumer; таблица фиксирует минимальный смысл. Строки, помеченные **future**, являются design reservation, а не manifest entry: они становятся root entry ровно в commit создания файла. На каждом промежуточном commit должно оставаться точное `set(discovered root tests) == set(manifest entries)`.

| File (`server/tests/`) | Kind | Discovery | Reason/baseline contract |
|---|---|---|---|
| `archive-parallel-restore.test.mjs` | db | direct | `pg`/archive restore; текущий baseline S24; в commit redesigned 025 атомарно переводится на S25 + `parallel-shift-restored-contexts`,`archive-immutable-revisions`, доказывает parallel dedicated context, exact migration evidence и atomic finalize publication без active line/status mutation |
| `archive-read.test.mjs` | db | direct | `pg`/archive read; текущий S24; при принятии provenance schema переводится на S25 + `archive-immutable-revisions` и проверяет unresolved literal/original-vs-restoring actor, latest-by-default list/read и explicit exact revision history/export |
| `archive-store.test.mjs` | db | direct | `pg`/archive mutations; текущий S24; в commit redesigned 025 переводится на S25 + `parallel-shift-restored-contexts`,`archive-immutable-revisions`, доказывает standalone context, stale/concurrent/replay finalize и immutable original chain |
| `auth-local.test.mjs` | unit | pure-import | auth rules без PostgreSQL |
| `auxiliary-store.test.mjs` | db | direct | `pg`/auxiliary store; S24 |
| `backup-store.test.mjs` | db | direct | `pg`/backup store; текущий S24; в commit 026/full restore переводится на S26 + `full-exact-provenance-restore`,`restore-bootstrap-boundary`, проверяет bootstrap до data restore, запрет создания roles/code data-путём, rejection до checkpoint/mutation и единственный нормативный full order |
| `compose-isolated-db.test.mjs` | harness-contract | harness-contract | compose profile/loopback contract; versioned skip только вне official CI |
| `connection-check.test.mjs` | unit | pure-import | connection helper без реального DB consumer |
| `control-rules.test.mjs` | unit | pure-import | чистые control rules |
| `control-store.test.mjs` | db | direct | `pg`/control store; S24 |
| `firebase-scrypt.test.mjs` | unit | pure-import | crypto fixture |
| `game-store.test.mjs` | db | direct | `pg`/game store; S24 |
| `game-transfer.test.mjs` | unit | pure-import | pure transfer rules |
| `health.test.mjs` | unit | pure-import | HTTP health handler без DB process |
| `history-store.test.mjs` | db | direct | `pg`/history store; S24 |
| `identity-rules.test.mjs` | unit | pure-import | pure identity rules |
| `identity-store.test.mjs` | db | direct | `pg`/identity lifecycle; S24 + explicit identity fixture contract |
| `isolated-db-guard.test.mjs` | harness-contract | harness-contract | URL/marker safety contract, synthetic URLs only |
| `isolated-db-integration.test.mjs` | harness-contract | harness-contract | harness reset/migrate/seed на generated DB |
| `isolated-db-runner.test.mjs` | harness-contract | harness-contract | argv/process/signal/security-boundary fixtures |
| `json-response.test.mjs` | unit | pure-import | response/client serialization |
| `line-read.test.mjs` | db | direct | `pg`/line snapshot; S24 |
| `line-rules.test.mjs` | unit | pure-import | pure line domain rules |
| `line-store.test.mjs` | db | direct | `pg`/line store; S24 |
| `line-transport.test.mjs` | unit | pure-import | transport adapter fixtures без DB |
| `migration-import.test.mjs` | unit | pure-import | source SQL/import contract; integration counterpart получает `import-schema` |
| `migration-registry.test.mjs` | db | direct | registry/checksum на generated DB; manifest задаёт требуемый baseline |
| `migration-snapshot.test.mjs` | unit | pure-import | SQL snapshot text contract |
| `nas-runtime.test.mjs` | unit | pure-import | client runtime |
| `notification-store.test.mjs` | db | direct | `pg`/notification store; S24 |
| `opencode-smoke.test.mjs` | unit | pure-import | smoke без DB |
| `parallel-shifts-migration-core.test.mjs` | db | direct | destructive migration; S24 + migrationsThrough 25; S25 provenance matrix, cutover report/confirmation/rollback и role boundary; без placeholder/guessing |
| `replica-materialize-parallel-shifts.test.mjs` | db | direct | **существующий committed root baseline**; сейчас S24→025 проверяет atomic replica behavior. В amendment commit атомарно переводится на strict v2 shift, objects/users parent ordering и runtime v1 reject; если S26-only staging assertions переносятся в новый файл, old entry/path меняется/удаляется только в том же commit с scanner-confirmed manifest replacement, без периода missing/duplicate inventory |
| **future** `parallel-shifts-migration-dependencies.test.mjs` | db | direct | S25 + migrationsThrough 26; pre-PK historical f2s/s2f cursor/gap/marker preflight, exact heads CHECK включая objects/users routing, deferred head↔pending invariant, hash-version/immutability/dependent-attribution/full-restore boundary; entry added only with file |
| **future** `replica-pending-materialize.test.mjs` | db | direct | S26 + `replica-admin`, `replica-empty-stream-cursors`, `replica-pending-empty`,`replica-pending-out-of-order`; object/user parent heads+soft tombstones, status/log parent permutations, generations, promotion, concurrency/crash contract; entry added only with file |
| `presence-ui.test.mjs` | unit | pure-import | UI/presence pure contract |
| `refresh-source.test.mjs` | db | direct | `pg`/source refresh; S24 + `import-schema` |
| `replica-materialize.test.mjs` | db | direct | `pg`; S24 + replica fixtures |
| `replica-store.test.mjs` | db | direct | `pg`; S24 + `replica-admin`, `replica-empty-stream-cursors` |
| `report-store.test.mjs` | db | direct | `pg`/report store; S24 |
| `seed-identity.test.mjs` | **split before cutover** | direct | pure preflight test → unit file; promotion → DB file с `identity-empty`,`import-schema` |
| `seed-objects.test.mjs` | **split before cutover** | direct | pure preflight test → unit file; promotion → DB file с `import-schema` |
| `senior-foreman.test.mjs` | db | direct | `pg`; S24 + authority fixture, если требует selected source |
| `server-control.test.mjs` | db | direct | `pg`/server control; S24 + explicit authority fixture |
| `service-rules.test.mjs` | unit | pure-import | pure service rules |
| `session-client-background.test.mjs` | unit | pure-import | mocked fetch/client |
| `session-client.test.mjs` | unit | pure-import | mocked fetch/client |
| `settings.test.mjs` | db | direct | `pg`/settings store; S24 |
| `shift-archive.test.mjs` | unit | pure-import | pure archive projection |
| `shift-close.test.mjs` | db | direct | `pg`/shift close; S24 |
| `shift-start-rules.test.mjs` | unit | pure-import | pure shift-start rules |
| `shift-start.test.mjs` | db | direct | `pg`/shift start; S24 |
| `tabel-access.test.mjs` | unit | pure-import | pure tabel ACL |
| `tabel-backend.test.mjs` | unit | pure-import | backend adapter with fakes |
| `tabel-presence.test.mjs` | db | direct | `pg`/presence store; S24 |
| `tabel-remote.test.mjs` | unit | pure-import | remote adapter with fakes |
| `tabel-store.test.mjs` | db | direct | `pg`/tabel store; S24 |
| `truck-phone-http.test.mjs` | db | indirect-http | real API child + `pg`; S24, exclusive |
| `truck-phone-store.test.mjs` | db | direct | `pg`/phone store; S24 |
| `truck-phone.test.mjs` | unit | pure-import | pure phone rules |
| `updater.test.mjs` | unit | pure-import | updater fixtures без DB |

После split старые смешанные `seed-identity.test.mjs`/`seed-objects.test.mjs` заменяются четырьмя явно названными entries; старые пути не остаются stale entries. Любой новый root test-file обязан появиться в inventory в том же commit.

## 6. Совместимость с текущими тестами и migration guards

Существующие тесты могут продолжать читать `process.env.TEST_DATABASE_URL`; меняется только источник — per-file child env. Setup/hook должен считать БД уже подготовленной согласно manifest и не выполнять глобальный reset чужого baseline. Если файл требует reset внутри себя, helper проверяет generated prefix + current run ownership перед `DROP SCHEMA public`.

Исторические проверки имени `samosval_test`/`samosval_working_test_reserve` не ослабляются в SQL-файлах. Test-only migration loader после marker, host, generated target и ownership validation заменяет только известные точные guard expressions; registry checksum считается по исходному SQL. Новый вариант guard требует нового failing integration test и явного allowlisted transform.

Hard-coded `samosval_test` в test setup адаптируется к injected URL/current database assertion. Само имя никогда не разрешается как target, даже локально или в CI. Тест, который утверждает исторический текст guard, проверяет исходный SQL отдельно; integration behavior проверяется на generated DB.

## 7. CLI и контракты

Официальная локальная/CI команда:

```bash
cd server
SAMOSVAL_ISOLATED_TEST=1 \
SAMOSVAL_TEST_ADMIN_URL='<локальный compose postgres; значение из окружения>' \
./scripts/test-isolated-db.sh
```

Credentials не передаются аргументами и не печатаются. Опции wrapper/runner: `--jobs N`, `--file tests/x.test.mjs` (повторяемая, только manifest path), `--report <path>`, `--list`; неизвестные опции и произвольные Node flags запрещены.

- `--list` валидирует CLI, manifest schema/completeness/duplicates, filesystem и static classifications, печатает inventory и **не требует admin URL/compose/DB connection**.
- `--file` всё равно валидирует глобальный manifest и static audit. По архитектурному решению filtered mode запускает только выбранные `db`/`harness-contract` entries; unit phase не запускается. Выбор unit file через `--file` отвергается с exit 2. Filtered artifact маркируется `selection=filtered` и никогда не является full CI evidence.
- Без `--file` запускаются все manifest unit, harness-contract и DB entries; только этот `selection=full` artifact может закрыть gate.
- `--report` обязан после lexical normalization и `realpath` существующего parent находиться внутри approved artifact directory, не быть symlink/hardlink к чужому inode и не существовать как directory/device. Запись идёт в созданный с `O_EXCL|O_NOFOLLOW` temp того же каталога, `fsync`, затем atomic rename; overwrite разрешён только явно безопасного regular report path. При ошибке report suite не заявляет успех.

Точный контракт exit:

- `0` — полный/filtered выбранный запуск успешен, cleanup/leak check чисты;
- `1` — test assertion, unexpected/DB skip, setup fixture, timeout либо cleanup/leak failure без нарушения safety predicate;
- `2` — manifest/discovery/static-audit/CLI/report-path configuration error до выполнения;
- `3` — safety invariant/target identity/owner/COMMENT/endpoint violation;
- `4` — внутренняя ошибка orchestrator/spawn/reporter/aggregation;
- при signal после полного cleanup/report/leak-check процесс завершается фактическим original signal, а не числовым exit code.

Machine-readable report (JSON, при необходимости JUnit) содержит runid, manifest version/hash, Node/PostgreSQL versions, jobs, `selection: full|filtered`, selected/discovered/manifest/attempted/passed/failed/skipped counts и file lists, file/baseline/fixture IDs, duration/status/exit, `cleanup`, `leaks`, `interrupted` и original signal. Secrets, SQL payload/PII и полные URLs исключены.

## 8. TDD и acceptance

Реализация начинается с красных contract/integration tests, затем минимальный runner:

1. manifest schema/unknown fixture/missing/duplicate DB consumer блокируют запуск;
2. unit child не получает ни одной DB переменной;
3. два DB-files одновременно получают разные имена/БД и не видят sentinel друг друга;
4. deterministic hash/name укладывается в 63 bytes, collision не переиспользуется;
5. S24, S25 и S26 имеют точный migration registry/checksums; redesigned S25 postconditions принимают strict v2 и conditional `closed|historical` legacy provenance matrix, но отвергают v2 manual/unresolved/NULL, SQL NULL/check обход, смешение normal-close/historicalization fields и forged runtime legacy; active/closing unresolved preflight без exact одноразового owner-confirmation canonical report bytes/hash оставляет БД untouched. Report summary проверяет assignment/status-field/unfinished/snapshot categories и fixed consequences; mutation каждой категории инвалидирует confirmation. Confirmed historicalization переводит в `historical`, сохраняет children/effects, snapshot-ит и освобождает только current assignments и полностью аудируется. Legacy restored evidence проверяет parent UUID PK+unique context+context FK, child parent FK+unique locator и orphan/wrong-workspace/wrong-context negatives; migration function exact order, static allow-list trigger DDL/delete, rollback/enabled-trigger/double-authority postconditions. Authority probes доказывают dedicated NOLOGIN ownership, runtime NOSUPERUSER/NOBYPASSRLS/non-owner/non-member, отсутствие DELETE/ALTER/TRIGGER/SET ROLE/function EXECUTE, неэффективность forged GUC/advisory lock/другой owner function/arbitrary table и verified temporary maintenance EXECUTE→REVOKE. Archive revisions immutable/hash-linked, latest pointer publication atomic и deferred publication→receipt FK принудительно проверяется; `empty` действительно пуст; custom fixture не попадает в следующий clone/template;
6. destructive reset/drop в одном файле не влияет на другой;
7. падение первого файла не отменяет последующие, итоговый exit остаётся nonzero;
8. timeout и self-`SIGTERM` завершают descendants, удаляют target и сохраняют корректную signal semantics;
9. cleanup при внешнем `SIGINT`/`SIGTERM` оставляет zero current-run databases;
10. подмена owner/marker/non-prefix/reserved/admin/template name блокирует terminate/drop;
11. malicious URL query, remote host, symlink/traversal/Node option и credential leak отвергаются до test load;
12. HTTP test поднимает отдельный API child на своей DB, корректно завершается и не блокирует drop;
13. import/auth/authority/replica fixtures дают заявленные postconditions и не зависят от порядка;
14. historical guard transform разрешён только для generated DB и сохраняет source checksum;
15. полный точный официальный набор `server/tests/*.test.mjs`: unit phase без DB env, harness contracts, затем все manifest DB entries; нет неожиданных skip, все зелёные, leak check чист;
16. static audit всего `server/` имеет ровно allowlisted hard-coded database-name matches;
17. orchestration/test roles имеют точные атрибуты и test child не может create/drop database либо прочитать admin URL;
18. COMMENT marker/owner/state tampering приводит к exit 3, reported leak и отсутствию terminate/drop;
19. template chain `template0 → empty → S24 → S25 → S26` имеет exact ownership/privileges/freeze/zero sessions; provisioning никогда не параллелен; S26 checksum/postcondition фиксируют migration 026 и пустую staging;
20. S26 replica fixture не создаёт placeholder shift: object/user/shift/truck имеют exact settled heads; collection-specific verifier требует physical soft tombstone для user/object delete при отсутствии live projection, а shift/truck/status/log следуют declared physical delete/pending policy; object reference даёт `parent-in-use`; deferred status/log живут только в immutable stream+heads+staging, delete — в settled head tombstone; promotion ждёт shift+truck; shift fixture — либо strict v2, либо exact independently marked historical legacy unresolved, без guessed значений;
21. migration 026 до смены stream PK проверяет current native f2s exact range и marker-covered directional subsequences; gap/duplicate/ambiguity/row beyond cursor abort без renumber/rewrite; deferred constraint triggers доказывают one pending row only for pending-set head;
22. runtime role не может UPDATE/DELETE stream и не может подделать restore mode; privileged bootstrap выполняется до data restore и создаёт только exact roles/schema/functions/grants/registry fingerprint. Restore owner — NOLOGIN, runtime не superuser/BYPASSRLS/owner/member и не имеет EXECUTE; separate maintenance executor получает exact temporary EXECUTE только после approval, затем revoke+effective-privilege verification. GUC/advisory/current_user/session marker не authority. Data restore без bootstrap отвергается до checkpoint, не имеет DDL/CREATE ROLE и не создаёт owner/admin/registration code; controlled exact-restore API выполняет единственный нормативный graph §4.10 parallel design. Omission любого archive revision/publication/evidence/report-confirmation/provenance/child/transport member отклоняется до checkpoint/restore_epoch/mutation; publication-before-receipt допустим только deferred FK, затем обязательный `SET CONSTRAINTS ALL IMMEDIATE`; missing/dangling/wrong-workspace receipt откатывает до verifier/epoch/commit;
23. standalone и parallel restored fixtures дают одинаковую dedicated schema/FK/CAS семантику, сохраняют latest edits/history/receipts/audit и active line/status revisions неизменными; finalize атомарно создаёт next immutable archive revision и latest pointer, не вызывает normal close, stale/concurrent/replay semantics проверены, ambiguous migration rollback оставляет synthetic legacy rows untouched;
24. все actual archive consumers — list/default read, report sheet, PNG/export, material, analytics/monthly, tabel projection и backup compatibility projection — видят latest finalized revision; explicit history/read/export видят original и все revisions exact bytes/hash. Ни open context, ни historical shift, ни trash placement не подменяют default pointer;
25. каждый transition commit сохраняет `discovered == manifest`: future reservation не является entry до создания root test, а новый root test и entry появляются атомарно; существующие archive/backup root entries меняют baseline/fixtures в том же commit, где появляется требуемая schema;
26. unfiltered CI artifact удовлетворяет числовым инвариантам: `discovered == manifest`, `attempted == manifest` (по всем entries соответствующих фаз), `passed == attempted`, `unexpectedSkips == 0`, `cleanupFailures == 0`, `leaks == 0`; `failed == timedOut == interrupted == 0`. Versioned allowed skips перечислены отдельно и не скрывают DB skip.

Acceptance Task 2: targeted migration test остаётся зелёным на `S24 → 025`, но Task 3 не начинается, пока **official unfiltered full DB suite** из нового runner не зелёный целиком и CI artifact не подтверждает указанные counts/coverage/cleanup.

## 9. Rollout и CI

1. **Contracts:** manifest schema, scanner, safety/name/redaction tests; текущий launcher ещё остаётся, но не считается official.
2. **Provisioning:** admin preflight, generated targets, immutable templates и fixture registry.
3. **Execution:** one-file/one-process, concurrency, timeout, process groups, aggregation.
4. **Cleanup hardening:** signals, ownership/session revalidation, terminate/drop, leak tests.
5. **Manifest migration:** классифицировать каждый текущий DB consumer и явно описать import/auth/authority/replica/HTTP требования.
6. **CI cutover:** workflow из корня выполняет `docker compose -f server/compose.test.yaml --profile test up -d --wait`, bootstrap создаёт обе роли/marker contract, затем CI вызывает напрямую `server/scripts/test-isolated-db.sh` (не npm). Удаляются старые GitHub Actions `services.postgres`, общий `TEST_DATABASE_URL`, inline применение миграций и отдельный `npm test` path с DB env. После run всегда `docker compose ... down -v`; JSON/JUnit unfiltered artifact загружается без secrets. Любой другой CI путь официальным DB suite не считается.
7. **Документация:** обновить `server/README.md`, `docs/runbook.md`, состояние проекта и `docs/opyt-oshibok.md` фактическими командами/ловушками после реализации.

Ни один этап не деплоит server, не применяет миграции к общей/production БД и не меняет production workflow/data. Compose публикует PostgreSQL только на loopback.

## 10. Граница Task 2 и Task 3

Незакоммиченный продуктовый fix Task 2 (migration 025 и её targeted test) остаётся отдельным продуктовым изменением и отдельным commit. Новый infrastructure commit не переписывает его смысл и не смешивает с ним миграцию.

Точный шаг удаления временного hack Task 2 выполняется в infrastructure cutover commit: из `server/scripts/test-isolated-db.mjs` удаляются массивы/фильтры `destructive`, `nondestructive`, `phases` и filename predicate `startsWith('parallel-shifts-migration-core')`; удаляется contract-test «destructive migration test separately», вместо него добавляется manifest scheduling/per-file DB contract. Ни один файл больше не объединяется в shared nondestructive phase. Классификация определяется только inventory `kind/discovery`, manifest baseline/fixtures/serial/exclusive, не именем файла.

Локальный targeted green Task 2 недостаточен: **никакая работа Task 3 не начинается**, пока unfiltered official full suite не зелёный с per-file databases, `discovered=manifest`, `attempted=manifest`, `passed=attempted`, zero unexpected skips/cleanup failures/leaks и сохранённым CI artifact.

## 11. Переход со старого launcher и rollback

### Переход

- Зафиксировать текущий список unit/DB files и baseline ожидания.
- Добавить manifest/scanner и добиться coverage, пока старый command ещё доступен только для сравнения.
- Перенести fixtures из неявного CI setup в registry.
- На одном CI cycle выполнить новый suite как required evidence; старый shared-DB результат не является gate.
- После зелёного полного прогона заменить package/workflow official command и удалить filename destructive grouping/shared DB env.

### Rollback инфраструктуры

Если новый runner дефектен, откатывается только его commit/workflow и Task 3 остаётся заблокированным. Возврат к старому shared launcher допустим лишь как диагностический baseline, не как официальный зелёный gate и не как разрешение продолжить продуктовые задачи. Созданные current-run БД сначала безопасно убираются штатным cleanup; foreign/неподтверждённые БД автоматически не удаляются. Product migration Task 2 не откатывается вместе с test infrastructure без отдельного доказанного дефекта.

## 12. Решения владельца и архитектурные решения

### Решение владельца

- Изоляция: **отдельная временная PostgreSQL database для каждого DB test-file** (подход A).

### Архитектурные решения в рамках выбранного варианта

- Versioned complete inventory всех root test-files с `kind`, `discovery`, reason и обязательным разделением смешанных seed files.
- Declarative DB contract и полный fixture registry; completeness/duplicates/static hard-coded-name audit являются preflight gate.
- Run-scoped templates `empty/S24/S25/S26`: `template0 → empty → S24 → S25 → S26`, provisioning semaphore=1, immutable freeze и zero sessions. S26 — точная dependency migration 026 для staging/dependent attribution, без неявных данных.
- Две роли: orchestration `CREATEDB` только для local generated lifecycle; test role без admin/CREATEDB/superuser, владеет target objects.
- Один Node process group на файл; execution `min(4, availableParallelism, connectionBudget)`. `serial` и `exclusive` оба выполняются эксклюзивно; это осознанный architect call.
- Unit env строится explicit allowlist без всех DB/PG/admin/marker variables; DB URL создаётся runner отдельно для каждого DB child.
- Exact COMMENT/owner/name/runid/tracked-state predicates; missing marker означает fail closed + reported leak, а не unsafe drop.
- POSIX TERM/grace/KILL/wait/pools/drop/report/leak/re-emit algorithm и идемпотентный второй signal.
- Продолжение после обычного test failure, machine-readable skip accounting, детерминированная агрегация и atomic safe artifact.
- `--list` не требует admin; filtered `--file` запускает только выбранные DB/harness entries и не является CI evidence — architect call.
- Старые hard-coded DB names запрещены как targets; legacy SQL guards меняются только exact count/checksum registry, без generic replace.
- Exit codes 0/1/2/3/4 разделяют success/test/config/safety/orchestrator; signal re-emitted после cleanup.

Открытых владельческих вопросов нет. Builder может измерением выбрать фиксированные timeout/grace и connection reserve в пределах этих контрактов, но не менять role/safety predicates, exclusive serial semantics или acceptance counts.
