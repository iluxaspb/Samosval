# Опыт ошибок и проблем репозитория (память агентов)

Владелец может называть этот файл «опыт ошибок», «память проблем», «история ошибок», «known-issues» — всё это один и тот же документ.

Живой документ. **Перед любой задачей в этом репозитории прочитай этот файл** (правило закреплено в `AGENTS.md`). Нашёл новую проблему, ловушку или неочевидное решение — дополни запись и закоммить с остальными изменениями задачи. Формат записи: симптом → причина → что делать. Не удаляй чужие записи — помечай устаревшие `~~зачёркнуто~~` с пометкой «исправлено в <версия/коммит>».

Актуализация: 22.11.2026 (после выпуска тестовой 1.8.0-test.1 на сайт samosval-working-test, коммит 109fe65).

## 10. Урок 22.11.2026 (выпуск 1.8.0-test.1): фронт с новым правом требует деплоя сервера

**Симптом:** тестовый фронт 1.8.0 отправляет право `line_timer_reset` и роль `senior_foreman` в матрицу прав, но работающий API-контейнер (`samosval-api-working-test`) ещё не знает ни право, ни роль.
**Причина:** серверная часть (миграции 019/020, identity-rules, line-store) закоммичена в `release/working-test`, но контейнер не пересобран и миграции в БД `samosval_test` не применены. Сохранение матрицы прав с новым правом/ролью на старом сервере может отвергаться валидацией ACTIONS.
**Что делать:** до ручной проверки матрицы прав владельцем деплоить серверную часть (пересборка образа + миграции 019/020 в общую БД) — только с подтверждения владельца, БД рабочая. Вердикт «выпуск завершён» — только после этого.


## 1. Топология: актуальные линии после ревизии 22.11.2026

**Симптом:** агент правит не те исходники, «перенос из теста в рабочую» делают не оттуда.
**Причина:** в репозитории исторически было три фронтенд-линии; после ревизии 22.11.2026 (ветка `cleanup/reviziya-2026-11-22`) актуальны:
- `working-test/` + `tools/build-working-test.py` — **единственная линия разработки**: тестовая PWA здесь же (отдельный Pages-сайт `https://iluxaspb.github.io/samosval-working-test/`), прод-комплект собирается из неё (синие иконки, manifest-production, `index.html` в корне ветки `root`).
- `app/src` + `tools/build-release.py` — **отозванная** модульная production-линия 4.1.11 (ломала регистрацию, см. `docs/versioning.md`). Хранится как архив, не публиковать. `working-test/tabel-v2/` использует её же структуру табеля.
- `test-app/` — **удалён 22.11.2026** (мёртвый тест-канал 4.2.x вместе с nas-preview, releases, firestore-rules, recovery-3.4.html, однофайловыми аудитами и 7 workflow). История — в git. Точки входа `index-test.html`/`wtest/`/`sw-test.js`/`update-test.html`/`manifest-test.webmanifest` оставлены как редиректы/кэш для старых установившихся клиентов — НЕ удалять и не переиздавать.
**Что делать:** выпуск рабочей версии = пересборка комплекта `working-test` с production-обвязкой одним коммитом в `root`. Пример-эталон: `7ca5007` (1.7.19) и `d01de1a` (1.7.22). Табель-тесты импортируют модули из `working-test/tabel-v2/`.

## 2. `working-test/src/pwa.js` различается между каналами

**Симптом:** после переноса сборки в прод service worker не регистрируется — нет офлайна и автообновления, телефоны не получают обновление.
**Причина:** в канале working-test `pwa.js` проверяет `location.pathname.endsWith('/index-working-test.html')`, в проде нужен `/index.html` (строка 4, `eligible`) и редирект после обновления на `./index.html` (строка ~341). При переносе файл нужно приводить к production-виду вручную.
**Что делать:** после сборки прод-комплекта сверять `git diff root -- working-test/src/pwa.js` — он должен совпадать с прод-версией байт-в-байт. Правка меняет sha256 → пересчитать RECORDS в `sw-working-test.js` и оба `build-manifest.json`. Стреляло при выпуске 1.7.22 (исправлено до публикации).

## 3. Серверные тесты ветки `release/working-test` частично красные
**Симптом:** `node --test server/tests/` на коде ветки даёт красные тесты.
**Причина:** код replica/auth-миграции ушёл вперёд тестов:
- `migration-import.test.mjs` ждёт старый guard `<> 'samosval_test'`, а код уже пишет `NOT IN ('samosval_test','samosval_working_test_reserve')`;
- тестам нужна таблица `user_credentials` из миграции `018`, но у неё guard «только резервная база»;
- `identity-store.test.mjs`: расхождение ревизий (`profile-changed`) на новом коде, на прод-коде зелёный.
**Что делать:** это долг ветки, не продакшена (в рабочей базе `samosval_test` таблиц replica/auth-миграции нет). При следующем переносе серверных изменений из этой ветки тесты привести в порядок ДО выпуска.

## 4. CI отстал от миграций

**Симптом:** локальный прогон и CI падают по-разному.
**Причина:** `.github/workflows/synology-server-tests.yml` применяет только миграции 001–013; код уже требует 014 (`server_authority`) и 017 (`replica_stream`). Рабочий обход локально: поднять `postgres:16-alpine`, применить 001–014 + 017, создать пользователя `test-admin-replica` (его ждут replica-тесты), переменные `TEST_DATABASE_URL` + `PGHOST/PGPORT/POSTGRES_*`. Тесты `identity/seed-*` требуют ПУСТУЮ базу (guard «isolated empty»).
**Что делать:** обновить workflow при ближайшей правке server/; полный рецепт прогона — здесь, выше.

## 5. Миграция 018 указывает на несуществующую базу

**Симптом:** `018_auth_credentials.sql` не применяется: «working TEST reserve database required».
**Причина:** guard требует базу `samosval_working_test_reserve`, которой на сервере нет (проверено 22.11.2026). Владелец подтвердил: тестовая и рабочая программы работают в одной базе `samosval_test`, отдельный резерв не разворачивался.
**Что делать:** не «чинить» guard без поручения; задать владельцу вопрос, нужен ли резерв вообще, либо ослабить guard осознанно.

## 6. Окружение: node не в PATH

**Симптом:** `npm`/`node` не найдены.
**Что делать:** рабочая копия node: `export PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH` (путь плавающий — при пропаже искать `find / -maxdepth 4 -name node -type f`). Зависимости сервера ставить `npm install` в `server/`. Python-playwright для браузерных проверок: `/home/iluxa/hermes-advisor-test/.venv/bin/python`, Chromium в `~/.cache/ms-playwright`.

## 7. Входы тестовых страниц — заглушки

**Симптом:** `index-test.html` и `wtest/` в ветке root выглядят как «тестовое приложение», но ведут себя странно.
**Причина:** это редирект-заглушки; реальная тестовая PWA живёт на отдельном Pages-сайте `https://iluxaspb.github.io/samosval-working-test/` (переезд из-за вложенного scope, коммиты `63fa8e0`..`693f493`).
**Что делать:** тестовое приложение проверять на его сайте, правки тестовой линии — в feature-ветках `working-test/`, не через заглушки в root.

## 8. Ревизия 22.11.2026: что удалено и что оставлено сознательно

**Симптом:** в репозитории накопились хвосты четырёх поколений приложений; агенты путали каналы, документы отставали от фактов.
**Причина:** параллельная эволюция каналов (модульный тест 4.2.x → wtest → working-test) оставляла дубли сборок, vendor-библиотек и тестов.
**Сделано (ветка `cleanup/reviziya-2026-11-22`):**
- удалены целиком: `test-app/` (169 МБ, 178 сборок мёртвого канала), `nas-preview/`, `releases/` (снапшоты 3.0–4.1.6), `recovery-3.4.html`, `firestore-*.rules` (6), `auth-check.html`, `AUDIT_REPORT_BACKEND_SWITCHING.md`, `tools/__pycache__`, `AGENTS.md.backup-*`;
- удалены инструменты мёртвого канала: `tools/build-test.py`, `verify-test-modules.py`, `prepare-standalone-test.py`, `serve-test.py`, `recolor_test_icons.py`, `read-test-html.cjs`, `read-production-html.cjs`, `apply-paper-viewer.py`, `tools/rank-celebration/`;
- удалены 7 workflow мёртвого канала (publish-test-modular, modular-audit, test-update-recovery, verify-settings-3422, standalone-coins-audit, coin-rules-audit, summary-hotfix); в оставшихся (`full-browser-integration`, `synology-server-tests`) вычищены шаги test-app;
- удалены тест-наборы мёртвого канала (tests/: modular, full-audit, pwa, backend-mode, tabel, coins, journal, max-plate, multiplayer, offline-fixes, release-v3/v4, production-promotion, review, selector-reset, shift-close, paper-viewer, png-export, timesheet, ai-copilot); остался только `tests/tabel-v2/`;
- табель-тесты перепривязаны с `test-app/tabel-v2` на `working-test/tabel-v2` (110/110 зелёные). Аудиты `equipment-total` (syncLineCountAudit) и `line-close` существовали только для test-app — удалены; якорь «Заявка» (`request-address-keep`) переписан под механизм `requestObjectId` канала working-test — правило владельца 13.11.2026 остаётся под защитой;
- workflow `test-update-recovery` ссылался на несуществующий каталог `tests/photo-removal/` — битый путь умер вместе с workflow.
**Оставлено сознательно:** `index-test.html`/`wtest/`/`sw-test.js`/`update-test.html`/`manifest-test.webmanifest` (редирект-заглушки и SW старых тест-клиентов — удалять нельзя, сломает миграцию); `app/` + `tools/build-release.py` (отозванная, но хранимая модульная линия); корневой `sw.js`/`manifest.json` (никем не регистрируется, но числится в RECORDS старого прод-SW); все 38 сборок `working-test/build/*` (п. «Опыт выпусков»); `working-test/tabel-v2/` — актуальная библиотека табеля (новее test-app-копии: вкладка «Заявка»).
**Что делать:** новые фронтенд-задачи ведутся только в `working-test/`; ссылаться в тестах на `working-test/tabel-v2/`, vendor — `working-test/vendor/`.

## 9. Урок 22.11.2026 (чистка веток): фильтр «оставить» писал по префиксу начала строки — ветки `feature/wincor-*` подпадали под удаление

**Симптом:** при массовой чистке remote-веток фильтр `grep -vE '^(root|release/working-test|…|wincor)'` не спас ветки `feature/wincor-*`: слово wincor стоит не в начале имени.
**Причина:** паттерн якорился на `^`, а ветки Винкора называются `feature/wincor-*`.
**Что делать:** в массовых операциях `git push --delete` фильтр «оставить» писать только как белый список с `grep -vE '(^|/)wincor'` либо явным перечислением полных имён; перед пушем обязательно выводить итоговый список и сверять. Сами ветки Винкора восстановлены в тот же час из merge-коммитов root (PR #77–#84); потерь нет. На GitHub оставлены только: root, release/working-test, backup/production-before-rewards-20261026 и 8 веток feature/wincor-*.

## 14. Урок 23.11.2026 (миграция параллельных смен): canonical trigger обязан проверять все пути записи

**Симптом:** после фиксации объекта legacy payload-only запись блокировалась, но согласованный `UPDATE` normalized columns вместе с JSON обходил запрет; backfill ставил время блокировки равным открытию смены.
**Причина:** immutable-check находился только внутри ветки legacy normalization, а timestamp выводился не из события линии. Проверки payload также допускали отсутствие обязательных общих v1 snapshot aliases.
**Что делать:** immutable-инварианты ставить после всех веток нормализации и сравнивать итоговые canonical columns; backfill времени брать детерминированный `MIN` только из подтверждённых event timestamps (`line_logs.timestamp`, arrival с непустым `arriveStatus`, load с непустым `lastLoadLogId`). После штатного reset `lastLoadLogId` сохраняется, `lastLoadTimestamp` очищается и появляется `lastResetOperationId`: такой marker валиден только при точном совпадении реального `line_logs` по workspace + shift + truck + logId, и время берётся из этого log. Без reset-marker или совпавшего log это повреждённая активность. Если подтверждённых событий нет — lock остаётся `NULL`; если marker подтверждения есть, но timestamp отсутствует, имеет неверный тип или лежит вне допустимого диапазона — миграция обязана прерваться целиком, а не скрыть событие из `MIN`. Полноту payload закреплять по фактическим writer aliases, не выдумывая будущие v2-поля.

**Совместимость replica:** out-of-order status/log до snapshot смены требует FK-строку, но payload `{}` нельзя пропускать как обычную canonical смену. Если текущий stream не умеет отложенное повторное проигрывание, заглушку нужно отличать структурным флагом: она строго inactive, скрыта от line/list-команд, не имеет canonical business-полей и может быть снята только атомарной promotion при полном shift snapshot. Нельзя ослаблять инварианты всех смен ради magic payload `{}`.

## 14. Урок 24.11.2026 (изолированная БД): общая orchestrator-role не является authority запуска

**Симптом:** cleanup проверял server-side receipt, но любой параллельный процесс под общей ролью orchestrator мог завершить зарегистрированную БД другого запуска; app-владелец мог напрямую менять COMMENT в обход advisory lock.
**Причина:** receipt был привязан только к имени target, а владельцем target назначалась недоверенная login-role приложения.
**Что делать:** authority запуска подтверждать высокоэнтропийной capability, хранить в registry только SHA-256; target отдавать отдельной `NOLOGIN` owner-role без membership у app/runtime/orchestrator. Все identity mutation выполнять только закрытыми `SECURITY DEFINER` функциями с capability, row lock и общим advisory lock; app/runtime должны получать только CONNECT и не владеть БД. Raw `CREATEDB` нельзя безопасно ограничить префиксом, поэтому создание/удаление БД выполняет только закрытый parent-owned broker с bootstrap connection: enum-операции, строгая проверка exact name/receipt/capability и отсутствие произвольного SQL.

**Уточнение 24.11.2026:** транзакционный advisory lock внутри `authorize_drop_target()` не ограждает следующий autocommit `DROP DATABASE`: после завершения функции lock и row lock уже сняты. Destructive lifecycle должен использовать один выделенный bootstrap-сеанс, брать session-level lock exact target до authorization и держать его через свежую сверку OID/owner/COMMENT/receipt generation+state+capability binding до следующего statement `DROP`; все доверенные create/mutation/drop пути берут тот же lock. Unlock выполняется в `finally`, а при ошибке unlock соединение закрывается. Orchestrator после появления такого broker обязан быть `NOCREATEDB`, иначе он обходит receipt/prefix checks произвольным `CREATE DATABASE`.

## Опыт выпусков (короткие уроки)

## 22. Урок 25.11.2026 (P3, Task 3): strict-v2 provenance — догадки и v1-записи запрещены

**Симптом:** миграция 025 классифицировала старые смены, но триггер `shifts_legacy_bridge` продолжал принимать v1-payload и заново выводить канонические поля из часов старта; закрытие по одному отображаемому имени давало «нормально закрытую» смену без актора.

**Причина:** провенанс подменялся эвристикой (час `startedAt` → day/night), а `payload_schema_version` не был обязательным. Плюс сама модель жизненного цикла была неполной: `closing` трактовался как «не активна», хотя занимает линию.

**Что делать (binding-решения D1–D5):**
- `is_active = state IN ('active','closing')`; триггер форсирует это значение, `closing` всегда `is_active=true`.
- `closed` требует доказанных `closed_at` + `closed_by_uid`. Закрытие только по отображаемому имени (`closedBy` без `closedByUid`) — это `historical`, `closed_at/by` остаются NULL; выдумывать актора/время нельзя. Продуктовый `shift-close.mjs` пишет только имя, поэтому такие закрытия осознанно уходят в `historical` (см. Task 7–15).
- Никакого угадывания типа: нет `workShift`/`type` → `shift_type=NULL`, `shift_type_resolution='unresolved'`, значения `inferred` не существует. Неразрешённый тип при `active/closing` запрещён CHECK-ом; такие строки (включая `restored:true`) — `historical`.
- Триггер = strict-v2 нормализатор: v1/missing `payloadSchemaVersion` → `protocol-upgrade-required` (23514); на INSERT требуется ровно 14-ключевой опубликованный v2-документ, иначе `invalid-shift-v2-provenance`.

**Ловушки:**
- `shift-close.mjs` оставляет в payload устаревшие `state:'active'`/`isActive:false` при `closing:true`, поэтому равенство alias-полей проверять нельзя — иначе реальное закрытие ломается. Жизненный цикл выводится по доказательствам, а не по stale-алиасу.
- CHECK-и проверяют эквивалентность `(opened_by_uid IS NOT NULL) = (identity_resolution IN ('source','manual'))`; `UPDATE ... SET identity_resolution='manual', opened_by_uid=NULL` проходит по отдельности, но не вместе — «NULL-обход» ловится только парным тестом (`sql_null_cannot_bypass_provenance_checks`).
- После среза v1 любые оставшиеся v1-писатели отвергаются: `archive-store.restoredLine`, `replica-materialize.mjs`, seed-хелпер `tests/helpers/isolated-db.mjs` (уже так и задумано — чинятся в Task 7 / 11–15). Тест, которому нужно «убрать» засеянную v1-строку из живого селектора, обязан писать канонические колонки (`state='historical', is_active=false`), а не payload.
- Тесты этого файла надо прогонять на свежей БД одноразового кластера и пересоздавать её между файлами: смена CHECK-ов и триггера не видна в уже накатанной БД.

## 23. Урок 25.11.2026 (P3, Task 3-FIX): «доказанный» uid и канонический дрейф на UPDATE

**Симптом 1:** миграция 025 падала целиком на `23503` без workspace/shift_id, если legacy-смена была закрыта удалённым или неизвестным `closedByUid` (или висела в `closing` с неизвестным `closingByUid`). Диагностики нет, откатывается вся миграция.
**Причина:** «доказанность» актора проверялась только на непустую строку (`NULLIF(btrim(...)) IS NOT NULL`), хотя `identity_resolution` уже требовал `EXISTS (SELECT 1 FROM app_users ...)`. Затем `ADD CONSTRAINT shifts_closed_by_fk` валидировал таблицу и падал на первой такой строке.
**Что делать:** существование uid проверять в тех же `CASE`, что выводят `opened_by_uid`/`closing_by_uid`/`closed_by_uid`; строку `closed` без доказанного закрывающего приводить к `historical` в том же одноразовом блоке (close/closing-поля в NULL), а не выдумывать uid. `closing` с неизвестным `closingByUid` остаётся живой, но `closing_by_uid = NULL` (тип у неё доказан, актор — нет).

**Симптом 2:** на strict v2-строке проходил `UPDATE shifts SET state='closed', closed_at=now(), closed_by_uid=<uid>` при payload `state:'active'`: клиент/реплика видит активную смену, БД считает её закрытой. Плюс `UPDATE ... SET payload_schema_version=2` повышал legacy-строку до v2 без v2-документа, а противоречащие явные колонки молча перезаписывались из payload.
**Причина:** контроль «payload ↔ канонические колонки» остался только на INSERT; UPDATE-ветка была ничем не связана с документом.
**Что делать:** на UPDATE сравнивать не «NEW vs payload» (там ещё и не тронутые OLD-значения), а «изменённое явно vs доказанное документом»: `NEW.col IS DISTINCT FROM OLD.col AND NEW.col IS DISTINCT FROM <значение из payload>` — по всем 11 полям, иначе `shift canonical payload mismatch`. Отдельное правило: без изменения payload `payload_schema_version` менять нельзя. Следствия, которые надо помнить: «голая» колонка больше не двигает жизненный цикл v2-строки (только документ с маркером закрытия), а писатель, который передаёт `is_active=false` вместе с closing-payload (так делает `shift-close.mjs:41`), получает отказ — по D1 при `closing` `is_active=true`, и в Task 7 писатель не должен передавать этот bridge-столбец вообще. Legacy v1-строки правило не трогает: ручное уточнение (`shift_type`/`opened_by_uid`) без изменения payload остаётся законным (§4.9).

**Ловушка тестов:** ветку `shift canonical payload mismatch` до этого не исполнял ни один прогон (все INSERT-ы передавали 4 колонки). Тест на reject обязателен на каждую новую ветку триггера: удалённый старый тест «aliases match normalized columns» унёс всё покрытие молча.

## 21. Урок (P2 fix): закрытый allowlist и REVOKE-first

**Симптом:** параметризуемый allowlist принимал произвольные имена и мог передать владельца чужих объектов, нарушая I1–I5; runtime получал DML на legacy `line_logs`, а verify не замечал EXECUTE у runtime и maintenance.

**Причина:** проверялся формат имени, а не принадлежность закрытому реестру; bootstrap только выдавал права и не снимал ранее допущенные утечки.

**Что делать:** заморозить канонический allowlist и отклонять посторонние объекты; не выдавать runtime DML на `line_logs`. Проверять EXECUTE у `public`, runtime и maintenance, возвращая нарушения и ненулевой код CLI. Bootstrap должен сначала снимать лишние права, затем выдавать runtime только SELECT на разрешённые таблицы, без EXECUTE функций.

## 20. Урок 25.11.2026 (P2): три ловушки при вводе продуктовых ролей в тестовый кластер

**Симптом 1:** продуктовый bootstrap ролей, написанный «поверх» тестовой инфраструктуры, ломает I1–I5: черновик делал `ALTER SCHEMA public OWNER TO samosval_schema_owner` и `REVOKE ALL ON ALL TABLES/FUNCTIONS IN SCHEMA public`.
**Причина:** `scripts/test-isolated-db.mjs:126-140` уже отдаёт `public` и все объекты шаблона роли `samosval_test_prepared_owner`, а `scripts/isolated-db/templates.mjs:34-47` (`verifyTargetAuthority`) требует, чтобы **все** объекты принадлежали ровно ей, иначе `target authority verification failed closed`. Привязка I1/I2/I4/I5 — владелец **базы** и receipt/COMMENT, а не объектов.
**Что делать:** продуктовый bootstrap владеет только объектами из явного allowlist (`shifts`, `shift_members`, `line_truck_statuses`, функции этих триггеров), отсутствие объекта — норма до Task 3. Владельца схемы `public` и четыре тестовые роли не трогать. Массовые `REVOKE` по схеме запрещены.

**Симптом 2:** `validateAdminUrl` (`scripts/isolated-db/safety.mjs:20`) разрешает только порт **55432**; прогон harness-тестов на любом другом порту даёт `admin URL is not approved`, а при отсутствии пароля app-роли — `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string`.
**Причина:** жёстко зашитые порт и набор кредов harness-контракта.
**Что делать:** harness-тесты (`isolated-db-bootstrap`, `isolated-db-lifecycle`, `isolated-db-templates`, `parallel-shifts-runtime-roles`) гонять только на **55432** и передавать все пять паролей (`POSTGRES_PASSWORD`, orchestrator, app, runtime, maintenance) в каждом шелле — иначе часть тестов падает на аутентификации, а не на логике.

**Симптом 3:** CLI-вход модуля зависал навсегда после ошибки, а `verifyParallelShiftRoleBoundary` падал на `function "public.shifts_legacy_bridge()" does not exist`.
**Причина:** клиент закрывался только в успешной ветке, и `has_function_privilege` вызывался для несуществующей функции.
**Что делать:** `client.end()` — всегда в `finally`; проверку `EXECUTE` делать через `to_regprocedure(...) IS NULL THEN NULL`. CLI обязан возвращать `exit=1` при отсутствии пароля и `exit=0` при успехе.

**Проверенный рецепт приёмки P2:** свежий кластер на 55432 (`down -v` → `up -d`, проект `samosval-p2-verify`), пять паролей в env, `node --test --experimental-test-isolation=none` по четырём harness-файлам + новый тест → `66/66`; повторный прогон на том же кластере краснеет законно (урок 19).

## 19. Урок 25.11.2026 (I5): одноразовый кластер и фиксированные runid

**Симптом:** второй прогон `tests/isolated-db-bootstrap.test.mjs` на том же кластере краснеет (`isolated target reservation rejected`, `admin operation failed closed`), хотя первый прогон зелёный 17/17.

**Причина:** harness-тесты используют фиксированные runid (`111111111111`, `333333333333`, `444444444444`), а `samosval_isolated_admin.target_receipts` — append-only: после `drop` запись остаётся в состоянии `marked`. Повторная резервация того же имени законно отвергается.

**Что делать:** не требовать «дважды подряд на одном кластере» — это противоречит дизайну. Приёмочная проверка I5: свежий кластер (`down -v` → `up -d`) на каждый прогон. Проверять идемпотентность самого теста нужно по его `finally`-уборке ролей, а не повторным запуском на грязном кластере. При этом `state=marked` без базы — норма, не утечка.

**Ещё:** при внешнем SIGTERM раннеру остаётся база, созданная напрямую самим тестом (его `finally` не выполнился) — это не утечка раннера; его собственные target'ы удаляются, `leaks: []`.

## 18. Урок 25.11.2026 (I5): bootstrap harness не должен интерполировать compose

**Симптом:** официальный isolated-DB runner передавал bootstrap harness в `docker-compose`, который требовал неразрешённые переменные паролей и зависел от имени compose-проекта.

**Причина:** `docker-compose exec` повторно интерполирует compose-файл, хотя harness уже работает с готовым контейнером; при этом раннер намеренно не передаёт секреты дочернему процессу.

**Что делать:** находить PostgreSQL-контейнер через `docker ps --filter publish=<порт>` и выполнять проверки через `docker exec`; тестовые роли создавать заново после идемпотентной очистки и убирать в `finally`. Для файлов без созданной БД в отчёте использовать `cleanup: 'not-required'`.

## 17. Урок 24.11.2026 (I5): runner изолированной БД — preflight и права клона

**Симптом:** локальный compose-runner останавливался на `admin preflight failed closed`, хотя URL указывал на `127.0.0.1:55432`.
**Причина:** PostgreSQL внутри compose сообщает `inet_server_addr()` как адрес контейнера (`172.x.x.x`), а не loopback-адрес опубликованного порта. Для host-runner адрес endpoint нужно один раз получить через тот же привилегированный клиент и передать в `adminPreflight` как ожидаемый адрес; порт при этом остаётся проверкой опубликованного `55432`.
**Что делать:** не ослаблять allowlist host и не печатать URL; использовать только адрес, возвращённый уже подключённым preflight-клиентом.

**Симптом:** target, корректно клонированный из запечатанного S24, падал на первом `permission denied` в product-тесте.
**Причина:** immutable template намеренно не содержит runtime ACL; права выдаются только после clone для конкретного target.
**Что делать:** после `provisionTarget` и до запуска child выдавать target-only grants app/runtime ролям. Template не изменять; cleanup target выполнять только после полного reap child.

- «Опубликовано» = GitHub Pages реально отдаёт новую версию (curl с cache-buster по `version.json`), а не «push прошёл». Развёртывание Pages занимает 1–3 минуты.
- Перед сборкой прод-комплекта сверять версию в `shell.html` (meta + шапка), `working-test-release.js`, первой записи `release-history.js` и собранных артефактах — рассинхрон блокирует выпуск.
- Файлы предыдущих сборок в `working-test/build/*` не удалять — на них могут стоять открытые окна пользователей.
- Две программы (рабочая и тестовая) работают в ОДНОЙ базе `samosval_test` через общий API `samosval-test.iluxa.pro` (подтверждение владельца 22.11.2026) — серверная часть при фронтенд-релизах не трогается.

## 11. Урок 22.11.2026 (этап 1 UI): локально красные браузерные тесты — не всегда регрессия

**Симптом:** локальный прогон `tests/tabel-v2/*browser*.cjs` даёт 9 красных (6 ждут `[data-action=exit]`, 1 — viewport 852, presence-browser — peers за 10 с).
**Причина:** кнопка выхода из табеля удалена из UI давно, а тесты не обновлены; viewport-ассерт противоречит текущему CSS (`calc(100dvh - 56px)`); presence требует emulator-таймингов. CI (`full-browser-integration.yml`) запускает только 4 актуальных задания — они зелёные.
**Что делать:** при локальной проверке сравнивать с базовым коммитом (падает и там → старый долг, не блокирует выпуск); починку этих 9 тестов — отдельной задачей (этап 3 чистки). Ловушки окружения: playwright-node должен точно соответствовать rev Chromium (иначе viewport уезжает); .py-тестам на хосте с AppArmor `apparmor_restrict_unprivileged_userns=1` нужен `chromium_sandbox=False`.

## 12. Урок 22.11.2026 (ручная проверка 1.8.1): «горизонтальная прокрутка архива» — это отчёт смены, а не список

**Симптом:** владелец: «горизонтальная прокрутка списка архива (влево — дальние рейсы) сбрасывается — схлопывается обратно к самосвалам». Поиск overflow-x в списке (#archiveContainer) ничего не даёт — контейнер списка вообще не скроллится горизонтально.
**Причина:** речь об открытом отчёте архивной смены (модальное окно #archiveModal): широкая таблица с колонками «Рейс 1..N» листается внутри .paper-scroll-wrapper (overflow-x: auto). Фоновый снапшот → renderArchive → openArchiveModal(viewingArchiveId) → renderArchiveModalContent → innerHTML — scrollLeft обнуляется. Вертикаль списка (10-archive.js) — отдельный механизм (window.scrollY + container.scrollTop), он не покрывал модальное окно.
**Что делать:** при жалобах на прокрутку уточнять, какой именно элемент скроллится (список/отчёт/лист ГАИ), и сохранять scrollLeft/scrollTop именно этого элемента вокруг innerHTML. Фикс — чтение scrollLeft до перестроения и восстановление после (та же схема, что вертикаль списка). См. feature/wtest-ui-fix-20261122, 10-archive.js renderArchiveModalContent.

## 13. Урок 23.11.2026: параллельное восстановление архива — две блокировки и PK line_truck_statuses

**Решение владельца 23.11.2026:** архивную смену можно восстановить для редактирования, НЕ закрывая активную смену линии.
**Ловушки, найденные при реализации:**
- Блокировка была ДВУСТОРОННЯЯ: клиент (10-archive.js restoreArchiveToShift) и сервер (archive-store.mjs «close-current-shift-first»). Убрать только клиентскую недостаточно.
- PK line_truck_statuses = (workspace_id, truck_id): самосвал не может быть в статусах двух смен. Решение: restored-смена хранит ТОЛЬКО рейсы (line_logs), статусы не создаёт — они принадлежат активной линии.
- line-read «multiple-active-shifts» (409): restored-смена помечается в payload флагом `restored:true` и исключается из выборки основной линии; отдаётся отдельно в `snapshot.restoredShifts`.
- report-store адресует статус по (truck, shiftId), а не по truck: иначе правка архивного рейса перезаписывает ревизии активной линии. Для restored-смены статус вообще не трогается (`status=null`).
- line-store/control-store отвергают операции линии для restored-смены (`restored-shift-readonly`) — состав линии restored не меняется.
- shift-close finish не требует повторного переноса материала для restored (объём уже учтён при исходном закрытии).
- shift-start: рейсы restored-смен в line_logs НЕ считаются «остатками линии» (иначе новая смена не стартует) — фильтр по payload->>'restored'.
- Клиент: restored-логи кладутся в `offlineRemoteLogs` (а НЕ в state.logs напрямую) — иначе offlineProjectState затирает их своим срезом. Сводные таблицы отчёта фильтруются по shiftId активной и restored-логи не видят.
- Полный прогон server/tests/*.test.mjs локально держит ~17 красных (replica/identity) — это старый долг ветки (см. п.3–4), сравнение с базовым коммитом подтвердило отсутствие новых регрессий.
См. ветка feature/wtest-archive-parallel-20261123, тесты: server/tests/archive-parallel-restore.test.mjs, working-test/source/core/archive-parallel-restore.test.mjs.

## 15. Урок 23.11.2026: «спокойная линия» — мельтешение баннера и дёргание карточек

**Жалоба владельца 23.11.2026:** на вкладке «Линия» жёлтый баннер «Ошибка загрузки … нажмите точку синхронизации» мельтешил, карточки дёргались.
**Причины (три независимые, складывались):**
- Баннер поднимался на ЛЮБУЮ ошибку источника, даже если этот источник уже успешно читался и данные на экране актуальны (фоновый ретрай монет/настроек).
- Каждый 15-с цикл `nasActiveRefresh` и подписка `subscribeLine` принимали снапшот линии и звали полный `renderAll()` даже при неизменных данных; `renderLine` пересобирал innerHTML карточек, а FLIP-анимация пересортировки запускалась от таймеров ходки, хотя позиции карточек не изменились.
- `nasActiveRefresh` перед серией чтений сбрасывал бэкофф надзирателя (`nasSyncApi().reset`): 15-с цикл и надзиратель (26-nas-resume, тик 2,5 с) конкурировали, ретраи шли в 2–3 раза чаще номинала.
**Что сделано (ветка feature/wtest-line-calm-20261123):** новое состояние точки синхронизации `degraded` (фоновый сбой при уже загруженных данных: баннер скрыт, точка жёлтая без пульсации, ошибка видна в подсказке и диагностике); баннер `error` — только если ХОТЯ БЫ ОДИН упавший источник ещё ни разу не читался (первичная загрузка не удалась). `acceptNasLineSnapshot`/`applyNasSession` сравнивают хэш значимых данных и не зовут `renderAll` при неизменном. `renderLine` имеет ранний выход по ключу данных и запуска FLIP только при смене порядка карточек. `nasActiveRefresh` больше не сбрасывает бэкофф надзирателя и пропускает источники в паузе повтора.
**Ловушка теста-харнеса:** экстрактор тела функции по балансу фигурных скобок ломается на параметрах вида `{force=true}={}` и на `async function` — тело надо искать после закрывающей скобки параметров и с модификатором `async` (39-line-calm.test.mjs, functionBody).
См. working-test/source/core/39-line-calm.test.mjs (13 проверок; 9 из них красные на чистой базе).

## 14. Урок 23.11.2026: полностью автоматическое обновление working-test (1.8.4) — что проверить перед выпуском

**Решение владельца 23.11.2026:** обновление тестовой линии ставится полностью автоматически, без кнопки «Установить» и без блокировки неподтверждёнными данными (прежняя схема давала замкнутый круг: новый код с инструментом разбора не мог доехать до застрявшего клиента).
**Схема:** SW делает skipWaiting СРАЗУ в install (после SHA-проверки всех файлов и записи COMPLETE) → activate → clients.claim() → страница по controllerchange показывает оверлей «Обновление установлено — перезагружаюсь…» → location.reload(). Страница сверяет активный SW с version.json (мимо кэша), при более новой версии вызывает registration.update(). Проверка: раз в 30 минут + visibilitychange/focus/pageshow + online + при старте.
**Ловушки, найденные при реализации:**
- Перезагрузка откладывается при активном вводе (фокус в input/textarea/select/contenteditable или открыт .pcm-overlay.pcm-open — окно подтверждения приложения), максимум 3 минуты (MAX_INPUT_DEFER=180000). Маркер confirm-диалога — классы pretty-confirm (.pcm-overlay.pcm-open), а не dialog[open].
- Первое переключение контроллера при открытии страницы НЕ должно перезагружать: pageHadController фиксируется на старте (иначе каждое открытие уже-обновлённого приложения перезагружало бы его).
- APPLY-сообщение осталось только у страницы восстановления update-working-test.html: тест 25-pwa-protocol исключил WORKING_TEST_PWA_APPLY из обязательных для pwa.js.
- Страховка от петли: 3 попытки с интервалом 15 с; если версия не применилась — строка «Обновление не применилось, откройте queue-doctor.html» и остановка (не циклить reload бесконечно).
- verify-working-test.py ПАДАЛ и ДО правок (6 ошибок: эталон REQUIRED_VERSION='1.7.22' не обновлялся с 1.8.x, ожидание ветки release/working-test вместо feature-ветки, «отсутствуют» модули firebase-traffic-* из test-app/modules.json). Новых ошибок от задачи — только правка queue-doctor.html вне заявленного списка. REQUIRED_VERSION нужно актуализировать отдельно.
- В vm-тестах pwa.js (35-й) обязательно: document.currentScript (иначе buildVersion пуст и update() дёргается всегда), честные setInterval (reloadWhenSafe работает на интервале), флаг disposed, останавливающий СОЗДАНИЕ новых таймеров (иначе бесконечная цепочка повторов autoUpdate держит процесс теста), и реальное время (микрозадачный flush не ждёт 500-мс интервалы).
См. feature/wtest-auto-update-20261123; тесты: working-test/source/core/35-auto-update-stale-worker.test.mjs (9 проверок), 29-pwa-update-recovery, 34-pwa-update-mechanism, 37-update-queue-tool.

## 16. Урок 23.11.2026: isolated DB harness не может применять старые миграции без контролируемой замены guard

**Симптом:** отдельная БД `samosval_parallel_shifts_test` безопасно проходит URL guard, но миграции 002–013 требуют имя `samosval_test`, а 018 требует `samosval_working_test_reserve`; прямое применение останавливается на SQL guard либо провоцирует опасное использование общей/резервной БД.
**Причина:** исторические migration guards кодируют имена прежних рабочих TEST-баз, а не свойство изоляции. Ослаблять сами миграции нельзя: их также применяют вне нового harness.
**Что делать:** только test helper после проверки `SAMOSVAL_ISOLATED_TEST=1`, allowlist host и точного имени отдельной БД заменяет известные выражения `current_database()` в загружаемом SQL; checksum сохраняет исходный файл. Реальный integration test обязан выполнить `reset → applyMigrationsThrough(24) → seed` в локальном compose PostgreSQL и проверить registry/fixture. Не добавлять новые варианты SQL guard без расширения этого теста.

**Уточнение 23.11.2026 (исправлено в третьем fix-цикле Task 1):** JS preflight и `npm run test:db` не защищают от malicious `NODE_OPTIONS`, уже исполненного при старте parent npm/Node. Security boundary — только прямой executable `server/scripts/test-isolated-db.sh`, запущенный clean shell/CI: первой операцией он удаляет `NODE_OPTIONS` и `NODE_PATH`, затем запускает Node guard/runner. `npm run test:db` остаётся только convenience alias для чистого окружения; CI и автоматизация должны вызывать shell entrypoint напрямую.
