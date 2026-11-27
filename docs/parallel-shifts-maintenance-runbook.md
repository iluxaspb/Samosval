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
