# Окно обслуживания параллельных смен: репетиция и выпуск

Документ описывает два разных действия и не смешивает их:

- **репетиция** — прогон скрипта `server/scripts/maintenance-parallel-shifts.mjs` на **изолированной** тестовой БД; так проверяется сам порядок окна;
- **выпуск** — реальное окно на общей базе; его выполняет человек, скрипт в нём только готовит и проверяет артефакты, но ничего не деплоит и не восстанавливает.

Основание: `docs/superpowers/specs/2026-11-23-parallel-shifts-design.md`, §13 (порядок окна и rollback), §4.8–§4.10 (historicalization и transport), §15 (критерии приёмки).

## 1. Что делает скрипт и чего он не делает

Скрипт работает **только с той базой, к которой подключился**, и только если это изолированная тестовая БД:

- требуется `SAMOSVAL_ISOLATED_TEST=1`;
- имя базы — `samosval_parallel_shifts_test` либо harness-форма `samosval_parallel_shifts_test_<runid>_<hash>`;
- хост — `postgres`, `localhost`, `127.0.0.1` или `[::1]`, без query-параметров;
- при наличии `SAMOSVAL_TEST_BOOTSTRAP_URL` он обязан указывать на **ту же** базу.

На любой другой базе скрипт отказывается работать (`isolated-test-required` / `isolated-database-required`).

Фазы и предусловия (по умолчанию — dry-run, мутация только с `--apply`):

| Фаза | Что делает | Требует |
|---|---|---|
| `backup` | снимок всех таблиц `public` по workspace, SHA-256 и пробное чтение файла; при готовой схеме 026 — ещё и exact provenance bundle | ничего |
| `preflight` | read-only отчёт по unresolved legacy-строкам (в `BEGIN READ ONLY`) | `backup/manifest.json` |
| `confirm` | запись подтверждения владельца **по точным байтам** отчёта | `backup/manifest.json`, `report/report.json`, `report/report.sha256` |
| `migrate` | стадия `schema` (role split + 025) или стадия `data` (historicalization ровно по подтверждённому отчёту, затем 026 и 027) | `backup/manifest.json`; для стадии `data` — ещё `confirmation.json` |
| `verify` | факты из живых строк: счётчики, audit, constraints, role boundary, bootstrap | `migration.json` стадии `data` |
| `report` | сводка прогона без DSN, uid и персональных данных | `verify.json` |

Отказы с кодом `out-of-scope` (до чтения базы): `deploy`, `publish`, `restore`. Это ручные операции; `restore` общей базы — разрушительная операция и требует отдельного явного согласия владельца.

Подтверждения вида `--yes` и `--force` **не существуют**: единственное подтверждение — `--report-sha256` с 64 hex-символами, совпадающими и с байтами `report.json`, и с файлом `report.sha256`.

## 2. Отличие фактического порядка от §13

В §13 preflight идёт до 025. В скрипте 025 применяется **до** preflight, и это осознанно:

1. `buildHistoricalizationReport` читает колонки, которые появляются только в 025 (`state`, `identity_resolution`, `shift_type_resolution`, `historicalized_at`), — без 025 отчёт построить нельзя;
2. в байты отчёта входит `backupManifestSha256`, а `historicalizeConfirmedLegacy` сверяет его с живым значением, поэтому проверенный backup обязан существовать **до** отчёта;
3. destructive historicalization по-прежнему закрыта точным подтверждением и проверенным backup; сама 025 additive и данные не переписывает.

Итоговый порядок репетиции: `backup` → `migrate` (стадия `schema`) → `preflight` → `confirm` → `migrate` (стадия `data`) → `verify` → `report`.

Этот порядок согласован с владельцем и не является ошибкой перестановки: **не «исправлять» его обратно по букве §13**. §13 остаётся верным по смыслу (preflight без mutation, отдельное подтверждение exact report, destructive historicalization только после подтверждения), а расхождение — следствие трёх фактов из списка выше.

## 3. Репетиция на изолированной БД

```sh
export PATH=/tmp/opencode/node-v22.11.0-linux-x64/bin:$PATH
export SAMOSVAL_ISOLATED_TEST=1
# TEST_DATABASE_URL — изолированная база; SAMOSVAL_TEST_BOOTSTRAP_URL — привилегированное
# соединение на ту же базу; SAMOSVAL_TEST_RUNTIME_PASSWORD / SAMOSVAL_TEST_MAINTENANCE_PASSWORD —
# пароли ролей для role split (значения не печатать).

RUN=/tmp/opencode/maintenance-run

node server/scripts/maintenance-parallel-shifts.mjs --phase backup    --run-dir "$RUN" --workspace <id> --apply
node server/scripts/maintenance-parallel-shifts.mjs --phase migrate   --run-dir "$RUN" --workspace <id> --apply
node server/scripts/maintenance-parallel-shifts.mjs --phase preflight --run-dir "$RUN" --workspace <id> --expires-at 2026-12-01T00:00:00.000Z --apply
node server/scripts/maintenance-parallel-shifts.mjs --phase confirm   --run-dir "$RUN" --workspace <id> \
  --report-sha256 <sha из report/report.sha256> --owner-uid <uid владельца> --confirmation-id <id> --apply
node server/scripts/maintenance-parallel-shifts.mjs --phase migrate   --run-dir "$RUN" --workspace <id> --maintenance-uid <uid> --apply
node server/scripts/maintenance-parallel-shifts.mjs --phase verify    --run-dir "$RUN" --workspace <id> --apply
node server/scripts/maintenance-parallel-shifts.mjs --phase report    --run-dir "$RUN" --workspace <id> --apply
```

Каждый шаг можно сначала прогнать без `--apply`: dry-run печатает план, перечисляет предусловия фазы и список отсутствующих артефактов (`missing: [...]`), соединение с базой не открывается. Dry-run ничего не блокирует — строгость порядка фаз включается только с `--apply`: там отсутствие предыдущего артефакта даёт `phase-order-violation` до подключения к базе.

Артефакты прогона (`--run-dir`):

- `backup/snapshot.json`, `backup/snapshot.sha256`, `backup/manifest.json` — снимок, его хеш, отпечаток БД;
- `backup/exact-bundle.json`, `backup/exact-bundle.sha256`, `backup/exact-bundle.verified.json` — exact provenance bundle (только после 026);
- `report/report.json`, `report/report.sha256`, `report/report.txt` — отчёт и его человеческая сводка (без uid и workspace id);
- `confirmation.json`, `migration.json`, `verify.json`, `summary.json` — подтверждение, стадии миграции, факты проверки, итог.

Хеш первого снимка не переписывается: повторный `backup` возвращает `reused: true` и добавляет только exact bundle.

## 4. Как проверять результат

`verify` падает (и это правильно) при любом из условий:

- остались unresolved legacy-строки;
- число audit-записей historicalization не равно подтверждённому;
- есть невалидированные constraints;
- есть pending head без pending-строки;
- нарушена граница ролей;
- не хватает обязательных relations/functions bootstrap.

Отдельно проверяется, что preflight ничего не изменил: тест сравнивает хеши `shifts` и `line_truck_statuses` до и после, а также отсутствие строк подтверждений после preflight.

## 5. Реальное окно: порядок 1–11

1. Получить явное «да» владельца на время окна, деплой сервера и миграцию общей БД.
2. Включить maintenance mode: все v1/v2 mutations → `503 maintenance`; старые клиенты не пишут.
3. Дождаться завершения inflight; зафиксировать health, версию схемы, counts.
4. Сделать проверенный full provenance backup **фактической общей БД**, сверить SHA-256 и пробное чтение. В окне `/api/v1/backups` закрыт `503`, поэтому backup делается напрямую в БД (этап `backup` этого скрипта по runbook либо `pg_dump`).
5. Запустить read-only preflight. Если есть active/closing unresolved-type, показать владельцу exact rows и hash и получить отдельное подтверждение именно этого списка. Отказ — abort, БД untouched, maintenance как v2 не открывать.
6. После подтверждения применить role split + historicalization + 025, затем 026; прогнать constraints/backfill/audit и smoke при закрытом трафике.
7. Развернуть сервер v2. Восемь legacy-маршрутов отвечают `426 protocol-upgrade-required` (см. §6).
8. Опубликовать новую тестовую PWA внутри согласованной последовательности окна.
9. Проверить live manifest/HTML/SW/RECORDS, auth, list/snapshot, две изолированные смены, close, отсутствие ошибок в консоли.
10. Открыть mutations v2 и снять maintenance. Старый клиент остаётся заблокирован `426` во время и после окна.
11. Наблюдать readiness/error rate и выполнить post-deploy counts.

## 6. Что именно отвечает 426, а что продолжает работать

`426 protocol-upgrade-required` в v2-режиме получают ровно эти маршруты (сверено с `server/src/index.mjs`):

| Маршрут | Метод |
|---|---|
| `/api/v1/shifts/start` | POST |
| `/api/v1/shifts/close` | POST |
| `/api/v1/line/snapshot` | GET |
| `/api/v1/line/operations` | POST |
| `/api/v1/report/operations` | POST |
| `/api/v1/history` | GET и POST |
| `/api/v1/archive/operations` | POST |
| `/api/v1/controls` | POST |

Намеренно **не** получают 426:

- `/api/v1/archive/snapshot` и `/api/v1/catalog` — справочник и архив workspace-wide, v2-замены у них нет;
- `/api/v1/tabel/records` и `/api/v1/tabel/presence` — у табеля нет v2-замены, а presence уже scoped по `shiftId`;
- `/api/v1/backups` — вне протокольного гейта.

Во время maintenance (`SAMOSVAL_MAINTENANCE=1`) закрыты **все** API-маршруты, включая `/api/v1/backups`; проходят только `/health/live`, `/health/ready` и `/api/v1/auth/*`. Поэтому проверенный backup в окне берётся напрямую в базе, а не через API.

## 7. Rollback

- **До commit 025**: транзакция откатывается, данные/роли/схема не тронуты; отказ владельца от exact report — это именно этот путь.
- **После commit 025/026, но до первой v2 mutation**: оставить maintenance. Допустим только проверенный reverse migration по historicalization audit либо full backup restore с отдельным явным согласием владельца. Просто вернуть legacy server нельзя: runtime больше не owner, v1 writes закрыты.
- **После v2 mutations / двух смен**: singleton rollback запрещён. Вернуть новый server build либо оставить maintenance и исправлять вперёд.
- **Restore общей БД из backup** — разрушительная операция, только с отдельным явным согласием владельца.
- Production PWA этим rollout без отдельного поручения и согласия не публикуется.

## 8. Границы и типовые коды отказа

| Код | Причина | Что делать |
|---|---|---|
| `isolated-test-required` | нет `SAMOSVAL_ISOLATED_TEST=1` | выставить маркер; на общей базе не запускать |
| `isolated-database-required` | база/хост не изолированные или bootstrap смотрит в другую базу | проверить `TEST_DATABASE_URL` и `SAMOSVAL_TEST_BOOTSTRAP_URL` |
| `out-of-scope` | запрошены `deploy`/`publish`/`restore` | выполнять вручную по этому runbook |
| `forbidden-flag` | передан `--yes`/`--force` | подтверждение только через `--report-sha256` |
| `phase-order-violation` | нет артефакта предыдущей фазы | пройти фазы по порядку |
| `schema-not-ready` | preflight до 025 | сначала `--phase migrate` (стадия `schema`) |
| `report-hash-mismatch` | байты отчёта не совпали с хешем | не подтверждать; пересобрать отчёт и сверить список |
| `confirmation-environment-changed` | БД изменилась после backup/отчёта | остановиться, заново backup и отчёт |
| `report-bytes-changed` | живая БД не воспроизводит подтверждённые байты | остановиться; список строк изменился |
| `role-passwords-required` | нет паролей runtime/maintenance | передать `SAMOSVAL_TEST_RUNTIME_PASSWORD` и `SAMOSVAL_TEST_MAINTENANCE_PASSWORD` |

## 9. Чек-лист репетиции

- [ ] цель — изолированная БД, маркер `SAMOSVAL_ISOLATED_TEST=1`;
- [ ] `backup` прошёл, `manifest.json` и `snapshot.sha256` совпадают;
- [ ] `preflight` показал ожидаемый список строк, хеш отчёта записан;
- [ ] подтверждение принято только по точному хешу, отчёт не пересчитывался;
- [ ] `migrate` стадии `data` historicalized ровно подтверждённые строки;
- [ ] `verify` без нарушений, `report` без DSN/uid;
- [ ] в окне backup взят напрямую в БД (`/api/v1/backups` закрыт `503`);
- [ ] после окна восемь legacy-маршрутов отдают `426`, а `archive/snapshot`, `catalog` и `tabel/*` продолжают работать.

## 10. Реальное окно на канале: фактическая последовательность

Раздел фиксирует окно 27.11.2026, 20:13–20:35 МСК, на общей базе канала `samosval_working_test_reserve` — так, как оно реально выполнялось, а не как задумано в §5. Порядок важен: каждый следующий шаг опирается на артефакт предыдущего. Пароли и uid в документ не пишутся.

### 10.1. До окна: смены закрыты, сторож погашен

```bash
# 1. Все смены закрыты В ПРИЛОЖЕНИИ. Проверка фактом в БД, а не по словам.
psql "$DSN_LIVE" -c "select count(*) from shifts where is_active"
# ожидается 0. Активная смена на момент 025 теряет управление навсегда (урок 70).

# 2. Сторож API погашен на всё окно: иначе он поднимает остановленный контейнер,
#    перезапускает неготовый и возвращает политику --restart unless-stopped.
sudo systemctl stop samosval-api-watchdog.timer
systemctl is-active samosval-api-watchdog.timer   # inactive

# 3. Свежий дамп ПОСЛЕ закрытия смен.
pg_dump "$DSN_LIVE" -Fc -f samosval-db-backups/window-20261127-2010.dump
sha256sum samosval-db-backups/window-20261127-2010.dump
stat -c%s samosval-db-backups/window-20261127-2010.dump
# факт окна: 25 444 287 байт,
# sha256 60fdc18ee26226702b74bbf6b7bbb6770646dd724a3684c144362bce48d62d99
```

### 10.2. Миграция копии, а не живой базы

```bash
# 4. Копия живой базы под именем, которое проходит гард скрипта окна.
createdb -T template0 samosval_parallel_shifts_test_ddb1be960db2048e_fab27d899488
pg_restore -d samosval_parallel_shifts_test_ddb1be960db2048e_fab27d899488 \
  samosval-db-backups/window-20261127-2010.dump
# факт окна: 16 с; счётчики совпали — 25 смен, 19 пользователей,
# 519 записей истории, 16 архивов.

# 5. Догон реестра миграций до факта: 001–017 применены, а в schema_migrations
#    были только 019–024. 018 исключается, как в самом скрипте окна.
#    Строки вставляются с sha256 фактических файлов.
psql "$DSN_COPY" -f samosval-db-backups/migration-registry-catchup-20261127.sql
psql "$DSN_COPY" -c "select count(*) from schema_migrations"   # 21
```

### 10.3. Фазы скрипта окна

Все фазы идут против копии (`DSN_COPY`), не против живой базы. `--derive` не нужен: всё выполняется через `--apply`.

```bash
node server/scripts/maintenance-parallel-shifts.mjs --phase backup
# факт окна: 53 таблицы, 28 965 строк, 6 мин 10 с,
# sha f4534f5dd83dd6feac541538b5eb02e7f81217be492899dba29b56144622a4e0

node server/scripts/maintenance-parallel-shifts.mjs --phase migrate --stage schema
# 025

node server/scripts/maintenance-parallel-shifts.mjs --phase preflight
# факт окна: 18 строк, все historical,
# sha отчёта b2dcf37f4d9e48f312fa024324a90292989a1266ee1a617fed283f2ad92f88f6

node server/scripts/maintenance-parallel-shifts.mjs --phase confirm \
  --report-sha256 b2dcf37f4d9e48f312fa024324a90292989a1266ee1a617fed283f2ad92f88f6 \
  --owner-uid <uid владельца> --confirmation-id window-20261127-2018
# факт окна: подтверждение window-20261127-2018 (uid в документ не пишется)

node server/scripts/maintenance-parallel-shifts.mjs --phase migrate --stage data
# факт окна: historicalized: 18; применены 026 и 027

node server/scripts/maintenance-parallel-shifts.mjs --phase apply-migrations
# факт окна: 028 и 029, «применено 2, пропущено 24»

node server/scripts/maintenance-parallel-shifts.mjs --phase verify
# факт окна: migrationVersion 029_shift_close_v2.sql, unresolvedRemaining 0,
# historical 18, historicalizationAudit 18, confirmations 1,
# invalidConstraints [], orphanPendingHeads 0, roleViolations [],
# bootstrap.missing пуст

node server/scripts/maintenance-parallel-shifts.mjs --phase report
```

### 10.4. Подмена базы (точка отката)

```bash
# 6. Прежняя база сохраняется под явным именем, копия встаёт на её место.
psql "$DSN_ADMIN" -c "ALTER DATABASE samosval_working_test_reserve RENAME TO samosval_working_test_pre_v2_20261127"
createdb -T samosval_parallel_shifts_test_ddb1be960db2048e_fab27d899488 samosval_working_test_reserve
```

### 10.5. Новый API

```bash
# 7. Контейнер создаётся заново с теми же параметрами и перенесённым env.
#    AUTH_SESSION_SECRET обязан остаться прямым значением в env: код читает
#    только его и не разбирает AUTH_SESSION_SECRET_FILE, иначе после каждого
#    рестарта все пользователи входят заново.
docker rm -f samosval-api-working-test
docker run -d --name samosval-api-working-test \
  --network samosval-network --restart unless-stopped \
  -p 127.0.0.1:18091:8080 \
  -v /home/iluxa/samosval-secrets:/secrets \
  --env-file <env-файл старого контейнера> \
  -e SAMOSVAL_V2_SHIFTS=1 \
  samosval-working-test:v2-1.8.8-20261127
```

### 10.6. Проверки после окна

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18091/health/ready          # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18091/api/v2/shifts         # 401 без токена

# восемь legacy-маршрутов → 426
for p in shifts/start shifts/close; do
  curl -s -o /dev/null -w "%{http_code} $p\n" -X POST "http://127.0.0.1:18091/api/v1/$p"
done
for p in line/snapshot history; do
  curl -s -o /dev/null -w "%{http_code} $p\n" "http://127.0.0.1:18091/api/v1/$p"
done
for p in line/operations report/operations archive/operations controls; do
  curl -s -o /dev/null -w "%{http_code} $p\n" -X POST "http://127.0.0.1:18091/api/v1/$p"
done

# живы, но требуют токен → 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18091/api/v1/catalog
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18091/api/v1/archive/snapshot
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18091/api/v1/tabel/records

# auth жив: неверный пароль → 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:18091/api/v1/auth/login \
  -H 'content-type: application/json' -d '{"login":"...","password":"..."}'

docker logs --tail 200 samosval-api-working-test   # без ошибок
```

Те же проверки (200/401/426) повторяются через домен `https://samosval-test.iluxa.pro`.

### 10.7. Публикация канала в том же окне

Старый клиент после окна получает `426` на запись, поэтому сборка публикуется здесь же, а не «потом».

- сборка 1.8.8, build `0ca837f5a799f14c`, 143 ресурса;
- сайт канала — коммит `cdf1e6e`;
- live: 4 основных файла совпали байт-в-байт, 143/143 ресурса по SHA-256;
- страница в Chromium 393×852: версия 1.8.8, `WORKING_TEST_V2_SHIFTS === true`, ошибок страницы и консоли нет, неудачных загрузок нет;
- `core.js` собранной телефонной приёмки байт-в-байт равен `core.js` опубликованной сборки — приёмка относится к тому же коду.

### 10.8. Откат

Откат возможен, пока в v2 не появились реальные записи: подмена имён возвращает состояние на момент дампа. После первых v2-записей это потеря данных, и работает только путь «вперёд» (§7).

```bash
# 1. Вернуть прежнюю базу: сначала увести мигрированную, потом вернуть исходную.
psql "$DSN_ADMIN" -c "ALTER DATABASE samosval_working_test_reserve RENAME TO samosval_working_test_v2_20261127"
psql "$DSN_ADMIN" -c "ALTER DATABASE samosval_working_test_pre_v2_20261127 RENAME TO samosval_working_test_reserve"

# 2. Вернуть прежний образ API.
docker rm -f samosval-api-working-test
docker run -d --name samosval-api-working-test \
  --network samosval-network --restart unless-stopped \
  -p 127.0.0.1:18091:8080 \
  -v /home/iluxa/samosval-secrets:/secrets \
  --env-file <env-файл старого контейнера> \
  samosval-working-test:stage3b-20261123

# 3. Включить сторож обратно.
sudo systemctl start samosval-api-watchdog.timer
systemctl is-active samosval-api-watchdog.timer   # active
```

После отката сервера сборка 1.8.8 остаётся с включённым флагом v2 и живёт на прежнем v1-пути (урок 67) — это деградация, а не штатный режим, поэтому публикацию канала в таком случае тоже откатывают. Порядок отката: сначала сервер и база, затем клиент; иначе пользователи пишут в базу, которой уже нет.
