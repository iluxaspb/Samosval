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

## 25. Урок 25.11.2026 (P3, Task 3-FIX3): preflight 025 падал на restored-строках и на маркерном NULL

**Симптом 1:** миграция 025 не применялась на базе, где есть восстановленные из архива смены: `restoredLine` (`server/src/archive-store.mjs:24`) пишет `startDate` исходной смены и `startedAt` = момент восстановления, поэтому preflight-сверка «Москва-дата `startedAt` = `startDate`» падала (`unsafe legacy shift payload`, 23514, вся миграция). Пустой `objectName` (`archive.objectName||''`) ломал проверку непустого имени.
**Что делать:** restored-строка — архивный снимок, а не живая смена этого дня. Признак — `payload ? 'restoredFrom'` ИЛИ `payload->>'restored'='true'` (оба встречаются: `restoredFrom` пишет `restoredLine`, `restored:true` добавляет параллельное восстановление). Для неё не требовать равенства Москва-даты, `work_date` брать из `startDate`, `opened_at` — из `startedAt`; пустое имя заполнять из `workspace_objects.payload->>'name'`, иначе `''`; всегда `state='historical'`, `is_active=false`, close-поля NULL. Остальные проверки формы (id/objectId/startedAt/workShift/startDate) сохраняются.

**Симптом 2 (моя ошибка в этом же фиксе):** маркер написал как `NOT (payload ? 'restoredFrom' OR payload->>'restored'='true')`. Для обычной строки второй операнд даёт `NULL`, `false OR NULL` = `NULL`, `NOT NULL` = `NULL` — CASE уходил в `ELSE false`, и backfill ставил всем строкам `is_active=false` при `state='active'`. Миграция падала на `shifts_legacy_active_check`, 37 тестов краснели.
**Что делать:** любой маркер из jsonb, участвующий в `NOT`/`CASE`, оборачивать в `COALESCE(..., false)`: `COALESCE(payload->>'restored','')='true'`. `payload->>'x'='y'` при отсутствии ключа — это NULL, а не false.

**Симптом 3:** триггер принимал v2-документы, которые preflight для legacy отвергает: `closing:true` без числового `closingStartedAt` (вечная closing) и `closing:true` + числовой `closedAt` (оба маркера). Плюс `payload_state` строился по алиасу `state`, поэтому guard-ы «closed requires proof» были недостижимы, а строковый `closedAt` давал `22P02` из `::double precision` вместо провенанс-ошибки.
**Что делать:** `payload_state` строить по доказательствам (маркеры → `closedAt`+uid → `isActive` → historical), алиас `state` сверять после; зеркалить в триггере маркерные правила preflight; все cast-ы `::double precision` выполнять только внутри веток, где `jsonb_typeof(...)='number'` уже проверен.

## 24. Урок 25.11.2026 (P3, Task 3-FIX2): legacy-строка повышалась до v2 через UPDATE с v2-payload

**Симптом:** UPDATE с валидным v2-документом поверх legacy-строки (`payload_schema_version=1`) проходил: строка получала `payload_schema_version=2`, `identity_resolution='source'`, `opened_by_uid` и `shift_type` из документа. Историческая строка с неизвестным провенансом начинала выглядеть как исходно полная v2-смена; живая legacy-линия получала v2-документ, которого у неё не было.
**Причина:** `document_bound := payload_write OR NEW.payload_schema_version = 2` пускал v2-payload на legacy-строку, а присваивание `NEW.payload_schema_version := 2` шло без проверки `OLD`. Проверка «не повышать» была только на смене psv без payload, а на смене payload на v2 — нет.
**Что делать:** в UPDATE-ветке до любых присваиваний канонических колонок отказывать, если `OLD.payload_schema_version <> 2` и новый payload — v2. Legacy-строка меняет payload только в рамках v1 (`protocol-upgrade-required`), а провенанс-колонки legacy-строки меняются только прямой колонковой записью при неизменном payload (ручное уточнение, §4.9). Ловушка: проверка работает только если стоит до блока присваиваний; при записи после присваиваний `OLD` уже не разделит «повышение» и «обычную запись». Тесты: legacy `historical` и legacy `active` + v2-payload → отказ, строка не меняется; ручное уточнение при неизменном payload проходит.

## 23. Урок 25.11.2026 (P3, Task 3-FIX): «доказанный» uid и канонический дрейф на UPDATE

**Симптом 1:** миграция 025 падала целиком на `23503` без workspace/shift_id, если legacy-смена была закрыта удалённым или неизвестным `closedByUid` (или висела в `closing` с неизвестным `closingByUid`). Диагностики нет, откатывается вся миграция.
**Причина:** «доказанность» актора проверялась только на непустую строку (`NULLIF(btrim(...)) IS NOT NULL`), хотя `identity_resolution` уже требовал `EXISTS (SELECT 1 FROM app_users ...)`. Затем `ADD CONSTRAINT shifts_closed_by_fk` валидировал таблицу и падал на первой такой строке.
**Что делать:** существование uid проверять в тех же `CASE`, что выводят `opened_by_uid`/`closing_by_uid`/`closed_by_uid`; строку `closed` без доказанного закрывающего приводить к `historical` в том же одноразовом блоке (close/closing-поля в NULL), а не выдумывать uid. `closing` с неизвестным `closingByUid` остаётся живой, но `closing_by_uid = NULL` (тип у неё доказан, актор — нет).

**Симптом 2:** на strict v2-строке проходил `UPDATE shifts SET state='closed', closed_at=now(), closed_by_uid=<uid>` при payload `state:'active'`: клиент/реплика видит активную смену, БД считает её закрытой. Плюс `UPDATE ... SET payload_schema_version=2` повышал legacy-строку до v2 без v2-документа, а противоречащие явные колонки молча перезаписывались из payload.
**Причина:** контроль «payload ↔ канонические колонки» остался только на INSERT; UPDATE-ветка была ничем не связана с документом.
**Что делать:** на UPDATE сравнивать не «NEW vs payload» (там ещё и не тронутые OLD-значения), а «изменённое явно vs доказанное документом»: `NEW.col IS DISTINCT FROM OLD.col AND NEW.col IS DISTINCT FROM <значение из payload>` — по всем 11 полям, иначе `shift canonical payload mismatch`. Отдельное правило: без изменения payload `payload_schema_version` менять нельзя. Следствия, которые надо помнить: «голая» колонка больше не двигает жизненный цикл v2-строки (только документ с маркером закрытия), а писатель, который передаёт `is_active=false` вместе с closing-payload (так делает `shift-close.mjs:41`), получает отказ — по D1 при `closing` `is_active=true`, и в Task 7 писатель не должен передавать этот bridge-столбец вообще. Legacy v1-строки правило не трогает: ручное уточнение (`shift_type`/`opened_by_uid`) без изменения payload остаётся законным (§4.9).

**Ловушка тестов:** ветку `shift canonical payload mismatch` до этого не исполнял ни один прогон (все INSERT-ы передавали 4 колонки). Тест на reject обязателен на каждую новую ветку триггера: удалённый старый тест «aliases match normalized columns» унёс всё покрытие молча.

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

## 19. Урок 25.11.2026 (P4): DB-тест «висит» — это исчерпание пула `max=1`, а не медленная миграция

**Симптом:** `node --test tests/parallel-shifts-historicalization.test.mjs` не завершается 20+ минут. Node в состоянии `S`, спит в `ep_poll`; в БД ровно одна idle-сессия, ноль активных запросов и ноль ожидающих блокировок.
**Причина:** тест держал единственного клиента (`const client = await pool.connect()`), а дальше обращался к тому же пулу через `pool.query(...)`. Пул создан с `max = 1`, свободных соединений нет — второй `pool.query` ждёт вечно, `await pool.end()` не может завершиться, потому что клиент не возвращён. Это не утечка `release`, а самоблокировка на пуле из одного соединения.
**Что делать:** внутри теста, где клиент уже взят, все запросы выполнять только через `client.query(...)`; `pool.query(...)` допустим лишь до `pool.connect()` или на отдельном пуле. При диагностике зависания проверять факты, а не ждать: `pgrep -af <файл>`, состояние процесса, `pg_stat_activity` (idle-сессия + ноль активных запросов = пул/соединение), затем прогон по одному тесту через `--test-name-pattern` под `timeout`.
**Второй урок того же файла:** legacy v1-строку нельзя вставить после 025 — триггер `shifts_legacy_bridge` правильно отвечает `protocol-upgrade-required`. Фикстуру legacy-смены готовить ДО 025 (`applyMigrationsThrough(24)` → вставка → `applyMigrationsThrough(25)`), иначе тест падает не по своей причине.

## 20. Урок 25.11.2026 (P4-фикс): хеш отчёта историзации не должен зависеть от коллации БД

**Симптом:** `childrenSha256`/`assignmentKeysSha256` строились по `ORDER BY truck_id`/`log_id`, то есть по коллации текущей БД. Внутри одной БД хеш стабилен, но восстановление на кластер с другой локалью/ICU меняет порядок строк и, значит, хеш подтверждённого отчёта.
**Что делать:** сортировать детей и строки отчёта в байтовом порядке, а не по локали: `ORDER BY <key> COLLATE "C"` в SQL и `Buffer.compare(Buffer.from(a,'utf8'), Buffer.from(b,'utf8'))` в JS. Тогда отчёт байт-в-байт воспроизводится на любом кластере.
**Рядом (та же задача):** `payload_sha256` снапшота нельзя вычислить из `jsonb` (PostgreSQL не воспроизводит JCS), поэтому рядом хранится `payload_canonical text` с CHECK `payload_canonical::jsonb = payload` и CHECK `payload_sha256 = encode(sha256(convert_to(payload_canonical,'UTF8')),'hex')`. Точная формулировка того, что доказано: БД проверяет, что хеш принадлежит **сохранённой канонической строке**, а эта строка jsonb-равна `payload`; jsonb-равенство игнорирует порядок ключей и форму чисел (`1` = `1.0`), поэтому точное JCS-соответствие `payload` гарантирует только JS-сторона, а не CHECK.

## 21. Урок 25.11.2026 (P4-фикс 2): отпечаток БД нельзя брать из отчёта и нельзя делать зависимым от роли/сессии

**Симптом 1 (главный):** `historicalizeConfirmedLegacy` принимал `liveDatabaseFingerprint` строкой от вызывающего и сравнивал её с `stored.databaseFingerprint`. Значение лежит в `report.json`, в `report.txt` и в колонке confirmation, поэтому «подтвердить окружение» можно было копией — проверка §4.8 п.6 не проверяла ничего.
**Что делать:** живой отпечаток вычислять **внутри** consume-шага из того же `client`, после проверок one-time/hash/expiry/ACL/workspace и **до** любых мутаций. Снаружи передаётся только backup-manifest (это файл на хосте резервных копий, в БД его нет). Тест на «другая БД» моделируется подменой `databaseFingerprint` внутри `report_bytes` с пересчётом хеша — иначе тест закрепляет само-подтверждение.

**Симптом 2:** отпечаток включал `system_identifier` из `pg_control_system()`, доступной только суперпользователю: под bootstrap-ролью значение было, под maintenance-ролью — `null`, и легитимный cutover падал с `confirmation-environment-changed`. Плюс `pg_postmaster_start_time()::text` рендерится в `TimeZone` сессии (`DateStyle` тоже влияет) — preflight и cutover на разных соединениях давали разные строки.
**Что делать:** состав отпечатка (`samosval.database-fingerprint/v2`) — только читаемое любой ролью и не зависящее от сессии: `current_database()`, oid из `pg_database`, `to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')`. Никаких `has_function_privilege`-веток: любая ветка «есть право / нет права» снова даст асимметрию. Тесты: `SET TIME ZONE 'Asia/Tokyo'` + `DateStyle` не меняют хеш; `SET LOCAL ROLE` на бесправную роль даёт тот же хеш (и тест отдельно подтверждает, что у этой роли действительно нет `EXECUTE` на `pg_control_system()`).

**Осознанное следствие:** `postmaster_start_utc` входит в отпечаток, поэтому рестарт/failover кластера между подтверждением и cutover меняет хеш и cutover отказывает (fail-closed). Это правильно: после рестарта нужен новый preflight и новое подтверждение владельца, старая confirmation не должна переезжать в другой инстанс.

**Симптом 3 (CLI):** `--database-fingerprint` был обязателен и сверялся с живым значением, но получить это значение из самого CLI было нельзя — «курица и яйцо», первый прогон в новом окружении невозможен.
**Что делать:** флаг необязательный; CLI всегда считает живой отпечаток сам и кладёт его в отчёт, а переданный флаг только сверяет (при расхождении — отказ с обоими значениями в сообщении).

## 22. Урок 26.11.2026: «сервер перезапустился» — это посторонний опросчик, а не сервер

**Симптом:** долгие прогоны (`node --test`, цикл ожидания) обрывались каждые 1–3 минуты с сообщением среды
«Command cancelled because the server restarted». Один прогон `parallel-shifts-migration-core` дал **27 красных из 55**,
хотя те же тесты поодиночке проходили. При этом `uptime -p` — 2 недели, `opencode-serve.service` без единого
перезапуска, в журнале ядра ноль OOM (`journalctl -k | grep -i oom` пусто), `systemd-oomd` не установлен.

**Причина 1 (главная):** `opencode-model-watchdog.timer` срабатывает каждые 20 с и вызывает `opencode api`. Каждый
такой вызов поднимает **полноценный временный сервер** (`opencode serve --service`): чтение конфига, загрузка плагинов,
file-watcher по `/`, `/etc`, `/home`, `/home/iluxa`, ответ `503` на `/api/info`, затем `SIGTERM`. За час — 174 цикла
и **1498 с CPU ≈ 42 % одного ядра** на двухъядерной машине; в `~/.local/share/opencode/log/opencode.log` — 547 пар
«родился/умер». Каждое такое рождение сессия видит как «сервер перезапустился» и снимает запущенные команды. Сам сторож
за всё время **ничего не сделал** (в `~/.local/state/opencode-model-watchdog/state.json` все списки пусты).

**Причина 2:** `owui-hc-panel.service` — точный дубль `hermes-owui-panel.service` (тот же `ExecStart`, тот же порт 18797).
Он падал с `OSError: [Errno 98] address already in use` и перезапускался каждые 2–3 с: **212 стартов за 10 минут**.

**Диагностика (быстро, фактами):**
- `systemctl --user list-timers --all` — какие таймеры вообще крутятся и с каким периодом;
- `grep -ac 'args="\["serve","--service"\]"' ~/.local/share/opencode/log/opencode.log` — растёт на глазах = кто-то
  дёргает CLI-клиент OpenCode вместо живого сервера;
- `journalctl --user -u <unit> | grep -c "Started"` — счётчик рестартов за минуту;
- `systemctl --user show <unit> -p ActiveEnterTimestamp` — реальный возраст юнита (доказывает, что «перезапуска» нет);
- `ss -ltnp | grep <port>` + `systemctl --user cat` двух юнитов через `diff` — искать дубли по одному порту.

**Лечение (обратимо, без sudo):**
`systemctl --user disable --now opencode-model-watchdog.timer` и `systemctl --user disable --now owui-hc-panel.service`.
Итог: load average 3,47 → 0,25, `CPU pressure some avg10` 22 % → 2 %, стартов временного сервера 0 за 60 с,
`migration-core` 55/55 и `historicalization` 40/40 начисто. `hermes-owui-panel.service` на 18797 продолжает работать.
Откат — те же команды с `enable --now`.

**Долг:** если сторож моделей нужен, он обязан ходить по HTTP с `OPENCODE_PASSWORD` из
`~/.config/opencode/opencode.env`, а не поднимать сервер на каждый вызов; интервал 20 с для такой работы неадекватен.

**Правило на будущее:** массовые красные в DB-тестах при зелёных одиночных прогонах — это почти всегда чужой активный
раннер или посторонний опросчик, пересоздающий тестовую БД. Перед разбором «красного» прогона проверять
`pgrep -af "node --test"`, `docker ps | grep postgres` и счётчик стартов `serve --service`.

## 23. Урок 26.11.2026 (P7): три ловушки миграции restored-строк

**1. `archive-parallel-restore` краснеет на схеме S25 — это не регрессия P7.**
**Симптом:** файл `server/tests/archive-parallel-restore.test.mjs` падает первым же `INSERT INTO shifts` с
`protocol-upgrade-required: shift payload schema version missing is not writable`.
**Причина:** тест — сценарий старой (S24) линии: он пишет legacy-v1 смену через `archive-store`, а 025
(`shifts_legacy_bridge`) разрешает v1 только в одноразовой классификации уже лежащих строк; новые legacy-записи
запрещены намеренно. Проверено фактом: с 025 из `HEAD` (без блока Task 7) файл даёт те же `0/1`; на базе S24 —
`7/7` зелёный. То есть файл валиден только до применения 025 и должен быть переписан вместе с Task 8/9
(`restored-context-store`, финализация ревизий), а не «починен» внутри Task 7.
**Что делать:** при разборе красного `archive-parallel-restore` сначала смотреть, применена ли 025, и не искать
причину в переносе restored-строк. То же верно для `archive-store` и `replica-materialize`: их baseline в
манифесте — `S24`, поэтому официальный harness готовит для них схему до 025; прогон «на 025» даёт ложные красные.

**2. `FOR UPDATE` требует `UPDATE`-права, даже когда строка только читается.**
**Симптом:** `SELECT ... FOR UPDATE` в `SECURITY DEFINER`-функции под владельцем evidence падает
`42501 permission denied`, хотя `SELECT` и `DELETE` выданы.
**Причина:** блокировка строки — это `UPDATE`-привилегия в PostgreSQL.
**Что делать:** владельцу миграции выдавать `SELECT, UPDATE, DELETE` на исходные таблицы (UPDATE используется
только для `FOR UPDATE`, данные не меняются) либо не блокировать строки `FOR UPDATE`.

**3. Два DB-теста на одной БД одновременно = `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`.**
**Симптом:** новый файл падает при `applyMigrationsThrough` на `CREATE TABLE`, если параллельно работает другой
файл, который делает `DROP SCHEMA public CASCADE`.
**Причина:** все DB-тесты делят одну базу `samosval_parallel_shifts_test`; `resetIsolatedDatabase()` одного файла
сносит схему под ногами другого.
**Что делать:** прогонять DB-тесты только с `--test-concurrency=1`; после «странной» ошибки `CREATE`/`pg_type`
перепроверять `pgrep -af "node --test"` и повторять прогон начисто.

## 24. Урок 26.11.2026 (P8): append-only receipt нельзя «захватить и потом дописать»

**Симптом:** домен коррекций restored-контекста падал на `append-only archive record: UPDATE is forbidden on restored_context_receipts` (SQLSTATE 23514), хотя логика CAS и записи истории уже была верной.

**Причина:** схема P6 держит `restored_context_receipts/history/audit` под append-only триггерами. Привычный паттерн `INSERT ... ON CONFLICT DO NOTHING` → выполнить работу → `UPDATE ... SET result` невозможен: вторая половина — это UPDATE.

**Что делать:** receipt пишется **одной** INSERT уже с готовым `result` в конце транзакции; повтор ищется отдельным `SELECT` в начале транзакции (до любой работы), поэтому replay не упирается в устаревшую ревизию CAS. Гонка одинаковых операций разрешается `ON CONFLICT DO NOTHING`: если строка не вставилась — `ROLLBACK` всей работы и сверка `uid/context/protocol_version/command_hash`, иначе `operation-id-reused`. Тот же приём применим к любому будущему домену на append-only receipt (finalize в Task 9).

**Попутно (фикстуры прямого SQL по схеме P6):** `restored_shift_contexts.original_opened_by_uid` и `restored_by_uid` — FK на `app_users(uid)` `ON DELETE RESTRICT`, поэтому «старого автора» надо завести в `app_users` (можно `disabled`), иначе seed падает на 23503. Живой `shifts` требует строку `workspace_objects(workspace_id,object_id)` (`shifts_object_fk`), а `line_trucks` — до `line_truck_statuses`.

**Про прогон:** официальный harness (`scripts/test-isolated-db.mjs`) принимает только порт 55432 (`validateAdminUrl`), а задачи выделяют свои порты (55433/55434/55435). Эквивалентный прогон без обхода harness: `resetIsolatedDatabase()` + `applyMigrationsThrough(25)` из `tests/helpers/isolated-db.mjs` на своей БД, затем `node --test <файл>` с `TEST_DATABASE_URL` и `SAMOSVAL_ISOLATED_TEST=1`. Для нового DB-теста не забыть манифест: имя в `dbFiles`, точные consumers (иначе `loadManifest` краснеет), `migrationsThrough: 25` и +1 к счётчику в `db-test-discovery.test.mjs`.

## 25. Урок 26.11.2026 (P10): «последняя ревизия» — только указатель серии, и тест обязан это доказывать

**1. `readArchiveEntries` до P6 брал архив из legacy-таблиц, и это молча подменяло latest.**
**Симптом:** после появления `shift_archive_series` список архива/снимок/бэкап отдавали ревизию 1 (или payload из `archive_overrides` с ревизией 9), хотя финализирована ревизия 2. RED-тест P10 на старом коде: `1 !== 2` и `9 !== 2`, а `override_trap` попадал в выдачу.
**Причина:** приоритет источников был «документ импорта → `shift_archives` → `archive_overrides`», а серия с указателем `latest_finalized_*` вообще не читалась. Для серии override задаёт только размещение (архив/корзина), но не байты.
**Что делать:** единственный default-резолвер — `server/src/archive-latest.mjs` (`readLatestFinalizedArchive`): `shift_archive_series.latest_finalized_revision/sha256` + точная ревизия по ним, без `max(revision)` и «первой строки». Override у серии меняет только `current_location`. Явная история/ревизия — отдельные read-only функции, указатель не двигают.

**2. Мутация «взять max(revision)» проходит часть тестов — нужен фикстур с более новой НЕфинализированной ревизией.**
**Симптом:** подмена `r.archive_revision=s.latest_finalized_revision` на `max(m.archive_revision)` оставляла зелёным кейс «latest = 2», если ревизия 2 и была максимальной.
**Что делать:** в тесте держать ревизию 3 в цепочке при указателе 2 и отдельную серию без указателя, но с legacy-строкой `shift_archives`. Тогда мутация краснеет (`expected 2, actual 3`), а «нет latest» не подменяется старой копией.

**3. `backup-store` DB-тест падает `relation "migration_documents" does not exist` — это не регрессия, а среда.**
**Симптом:** после `resetIsolatedDatabase()` + `applyMigrationsThrough(24)` файл `tests/backup-store.test.mjs` краснеет на первом `capture`.
**Причина:** таблицы `migration_imports`/`migration_documents` создаёт фикстура `import-schema` официального harness, а не SQL-миграции; ручной сброс их сносит.
**Что делать:** перед прогоном такого файла применять канонический DDL `import-schema` (тот же, что в `scripts/isolated-db/fixtures.mjs` и `scripts/prepare-test-import.mjs`). Проверено: на исходном коде и с правкой P10 файл даёт `3/3`.

**4. Резолвер должен переживать baseline S24.**
**Симптом:** `archive-store`/`replica-materialize`/`archive-read` в манифесте живут на S24, где таблиц ревизий ещё нет.
**Что делать:** `hasRevisionChain(client)` (`to_regclass('public.shift_archive_series')`) возвращает `false` → резолвер отдаёт `null`/пусто, а legacy-путь остаётся как был. Это не «догадка по старым строкам», а честное «ревизий нет».

## 26. Урок 26.11.2026 (P10 fix): форма ответа — часть контракта, а immutable-цепочку нельзя «править» override'ом

**1. Корзина серии обязана иметь ту же форму, что legacy-запись.**
**Симптом:** series-backed архив → `archive.trash` → `readArchiveEntries()` отдавал «голый» payload latest (`'shift' in row === false`, `deletedAt === undefined`); UI `renderTrash` падал `TypeError: Cannot read properties of undefined (reading 'objectId')` — белый экран корзины.
**Причина:** резолвер latest клал payload в `trash` без legacy-обёртки `{shift,deletedAt,deletedBy,deletedByUid}`, на которую опирается UI.
**Что делать:** в `archive-read.mjs` строить запись корзины одной функцией `trashEntry`: `shift` = immutable latest finalized payload, `deletedAt/deletedBy*` — из payload override (метаданные размещения), `archiveId/revision/archiveSha256` — аддитивно рядом. Не заменять форму ответа, а дополнять. Legacy-записи при этом обязаны всегда иметь `archiveId:null`/`archiveSha256:null`, а не отсутствие ключей (иначе consumer'ы различают формы по `in`).

**2. Payload-override на series-backed архиве — это фальшивая ревизия.**
**Симптом:** `archive.gai.delete` на серии возвращал `{location:'archive',revision:2,removedGaiTrips:1}`, хотя ревизии 2 нет, ГАИ-рейс на месте, а следующий CAS с `expectedRevision:2` ловил `archive-changed`.
**Причина:** операция писала изменённый payload в `archive_overrides`, а чтение серии override игнорирует и берёт байты latest (design §4.6: revision создаёт только close/import/successful finalize).
**Что делать:** до записи отказывать стабильным кодом `archive-series-immutable` (409), пока нет команды, публикующей новую ревизию из правки. Legacy-архив без серии по-прежнему правит payload. Проверку делать по домену (`shift_archive_series`), а не по форме ответа чтения.

**3. `trash.purge` при живой цепочке — только отказ.**
**Симптом:** purge серии «успешно» скрывал её из архива и корзины, оставляя `shift_archive_revisions = 1`.
**Что делать:** `archive-purge-blocked` (409), если у записи есть хотя бы одна ревизия (design §4.6). Purge скрывает только view и не удаляет данные; legacy-запись без провенанса остаётся purgeable. Проверка в домене, без DDL — исторические записи без ревизий должны оставаться purgeable.

**4. ACL finalize читать под series/context lock, не до них.**
**Симптом:** отзыв права (`UPDATE role_permissions`) блокировался транзакцией finalize, которая ещё ждала series-лок: `serviceActor` брал `FOR SHARE` заранее.
**Что делать:** порядок строго series `FOR UPDATE` → context `FOR UPDATE` → `serviceActor` → replay. Тогда отзыв коммитится, пока finalize ждёт лок, а finalize после лока видит уже отозванное право и получает `forbidden`. Replay-читку receipt оставлять как есть.

**5. `payload_schema_version` finalize-ревизии = 2, а не копия базы.**
**Причина:** колонка описывает схему самого документа; байты finalize всегда несут конверт `archiveRevision/previous*/restoredContext` (v2). Копия `base.payload_schema_version` делала колонку ложью для базы со схемой 1.
**Что делать:** константа `FINALIZE_PAYLOAD_SCHEMA_VERSION = 2` и явный тест «база schema 1 → новая ревизия schema 2 и её байты это подтверждают».

**6. Мутацию откатывать копией файла, а не `git checkout --`.**
**Симптом:** после мутации `git checkout -- src/restored-context-store.mjs` вернул файл к HEAD и снёс ВСЕ незакоммиченные правки задачи.
**Что делать:** перед мутацией `cp` файла в `/tmp`, после — `cp` обратно и сверять `md5sum` с зафиксированным до мутации. `git checkout --` на незакоммиченном файле допустим только как аварийный откат к HEAD, не как «восстановление мутации».

**7. Тест, который пинит точную форму legacy-записи, обязан обновиться вместе с контрактом.**
**Симптом:** `tests/archive-read.test.mjs` делал `deepEqual` всей legacy-записи и покраснел после добавления `archiveId:null/archiveSha256:null`.
**Что делать:** при аддитивном изменении формы ответа обновлять такой тест осознанно (это и есть проверка контракта), а не «чинить» код обратно.

## 27. Урок 26.11.2026 (I6): S25-шаблон и почему фикстуры провенанса не могут быть db-корнем

**1. db-ребёнок harness работает под `samosval_test_app`, поэтому фикстуры с владельческими операциями — только harness-contract.**
**Симптом:** новый `isolated-db-s25-fixtures` как `kind:'db'` получает `TEST_DATABASE_URL` под `samosval_test_app` и падает на `permission denied for schema public` (создание `samosval_fixture_registry`) и `must be owner of table shifts` (`ALTER TABLE ... DISABLE TRIGGER` для pre-025 legacy-строки).
**Причина:** `buildDbEnv` (`scripts/isolated-db/env.mjs`) даёт db-ребёнку ровно `TEST_DATABASE_URL` + маркер, без bootstrap/admin-URL; `grantTargetAccess` выдаёт app-роли только `USAGE` на схему и DML на таблицы/последовательности.
**Что делать:** фикстуры, которым нужен владелец (реестр фикстур, `DISABLE TRIGGER`, любые DDL), проверять в harness-contract с `env:['bootstrap-url']` (как `isolated-db-fixtures`). db-корень для них не подходит по устройству прав, а не по вкусу. Шаблон S25 при этом строит сам harness (`prepareTemplates`), но только когда в выборке есть db-корень или `isolated-db-integration` (`needsTarget`); иначе контракт обязан собрать эквивалентный S25 сам, иначе прогон «только harness-контракты» молча ничего не проверит.

**2. `requireIsolatedDatabase` принимает только точное имя `samosval_parallel_shifts_test` — harness-цели с суффиксом `_<runid>_<hash>` отвергаются.**
**Симптом:** `scripts/test-isolated-db.mjs tests/isolated-db-integration.test.mjs` → `ok 1 ... # SKIP`, `EXIT=1`; `parseNodeEvents` считает неразрешённый SKIP провалом. В skip-гварде `requireIsolatedDatabase(connectionString)` стоит у **10** файлов: `archive-consumers-latest`, `archive-revisions`, `archive-schema-025`, `legacy-shift-resolution`, `parallel-shifts-historicalization`, `parallel-shifts-migration-core`, `replica-materialize-parallel-shifts`, `restored-context-migration`, `restored-context-store`, `isolated-db-integration` (проверено `grep -l "skip: *!approved"` по `tests/`; ревизия I6 и бриф называли 9, пропуская `archive-revisions`). Всего хелпер импортируют 12 файлов: `isolated-db-guard` тестирует сам гвард (не скипается, вызывает его как предмет проверки), а `migration-registry` импортирует только `retargetLegacyGuard`. Поэтому полный прогон harness по всем корням сейчас красный не из-за логики тестов.
**Что делать:** до исправления helper'а (принять `^samosval_parallel_shifts_test_[a-f0-9]{12,20}_[a-f0-9]{12}$`) гонять такие файлы эквивалентным путём из §24 (своя БД с точным именем + `resetIsolatedDatabase` + `applyMigrationsThrough`). Это шов для I7/026: без него baseline S25 в манифесте нельзя честно прогонять через harness.

**3. После красного прогона bootstrap/lifecycle остаются `target_receipts` с фиксированными runid — следующие прогоны падают на «reservation rejected».**
**Симптом:** `isolated-db-bootstrap` тесты 16–17 (`runid` 111111111111/222222222222/333333333333) краснеют `isolated target reservation rejected` / `admin operation failed closed`, хотя базы уже удалены.
**Причина:** `finally` теста глушит ошибки drop (`catch(()=>{})`), а receipt остаётся; reservation видит занятое имя.
**Что делать:** перед повторным прогоном чистить `samosval_isolated_admin.target_receipts` по этим runid; при разборе «странного» отказа сначала смотреть receipts, а не код.

**4. 025 authority-блок и последовательности.** Переназначение владельцев в шаблоне должно идти по `relkind IN ('r','p','v','m')`: `ALTER SEQUENCE ... OWNER` для identity-последовательности, связанной с таблицей, падает `cannot change owner of sequence ... is linked to table`. Смена владельца таблицы тянет принадлежащие ей последовательности сама.

**5. Провенанс фикстуры проверяется от источника байтов, а `replica_stream.sha256` — не JCS (ревью I6).**
**Симптом:** фикстура `parallel-shift-restored-contexts` вставляла байты ревизии архива **без** `opened_by_uid`/`shift_type`, а затем сверяла `original_*` контекста с теми же константами, что и вставляла, — проверка доказывала только «таблица хранит вставленное». Фикстура `parallel-shift-v2-night` клала в `replica_stream.sha256` JCS-хеш, тогда как живой v1-писатель (`src/replica-store.mjs:15,55,77` — `digest`, `hash=digest(payload)`, `INSERT … operation.hash`) считает `sha256(JSON.stringify(payload))`; §4.10 задаёт JCS только для v2-конверта `{protocolVersion:2,kind,payload}`.
**Что делать:** ожидание в verify **пересчитывать из источника**: провенанс держать в `payload_bytes` ревизии и в verify парсить байты, прочитанные из БД, — подмена `opened_by_uid` в байтах обязана ронять фикстуру (писателя restored-контекста в `src/` пока нет, поэтому фикстура фиксирует форму будущего writer'а и проверяет копирование от байтов). Для v1-строки журнала считать legacy-хеш и отдельной строкой утверждать `sha256 !== canonicalSha256(...)`, чтобы было видно, что алгоритмы разные. Помнить: `replica_stream.payload` — `jsonb`, порядок ключей не сохраняется, поэтому legacy-хеш нельзя байт-в-байт пересчитать из строки — проверять payload как `jsonb`-равенство плюс хеш от точного объекта, который получил писатель.

**6. `registryHash` из `verifyS25Target` — метка для COMMENT/лога, а не вторая проверка реестра.**
**Симптом:** `assert.equal(verified.registryHash, EXPECTED_S25_HASH)` упасть не может: verifier возвращает ту же константу уже после сверки реестра и `throw` при расхождении. Строка создаёт видимость дополнительной проверки.
**Что делать:** гейт — сам `throw` (его и надо показывать негативным кейсом). Возвращённую метку пинить к содержимому: хеш фактически прочитанных строк реестра (в живом клоне — `sha256` от строк, пришедших из БД). То же в `verifyS24Target`.

**7. «Матрица доказательств restored-context» в фикстуре не должна называться матрицей (ревью I6).**
**Симптом:** фикстура `parallel-shift-runtime-role` в отчёте I6 заявлялась как проверяющая «матрицу доказательств», хотя проверяла только ACL-флаги роли. Отдельная заявка, которой нет в коде, — это ложное доказательство.
**Что делать:** держать в фикстуре только дешёвые факты, которые она действительно проверяет (FK родителя с `ON UPDATE/DELETE RESTRICT`, отказ `23503` на сироту через `SAVEPOINT`, отказ в записи от `samosval_runtime` и `samosval_maintenance` через настоящий `SET LOCAL ROLE`), и прямо писать в комментарии, что полная матрица — в `tests/restored-context-migration.test.mjs` (P8) и здесь не дублируется.

**8. `isolated-db-bootstrap.test.mjs` не перезапускается в том же кластере (найдено при I6, не исправлялось).**
**Симптом:** второй прогон `tests/isolated-db-bootstrap.test.mjs` на том же контейнере → `not ok 16 … per-run capability isolates two registered targets`, `not ok 17 … owner mismatch and reserved/template cleanup negatives`, `# pass 15 # fail 2`, `EXIT=1`. Первый прогон после чистого кластера — зелёный (17/17).
**Причина:** тесты 16–17 используют фиксированные runid `111111111111`/`222222222222`/`333333333333`, а уборка (`dropReservedTarget`) оставляет в `samosval_isolated_admin.target_receipts` надгробие `state='marked'` — это аудиторская запись, так и задумано. Повторный `prepareTarget` на то же имя падает closed. Проверено на чистом `f06dcb0` (изменения I6 отложены `git stash`): run1 `EXIT=0`, run2 `EXIT=1` — дефект не от правки I6.
**Что делать:** перед повторным прогоном в том же кластере чистить надгробия (`DELETE FROM samosval_isolated_admin.target_receipts`), либо дать тестам 16–17 случайные runid. В отчётах не выдавать этот красный за регрессию кода.

## 28. Урок 26.11.2026 (P11, Task 11): `migration-registry` краснеет на HEAD из-за смеси `public.` и неквалифицированного DDL в 025

**Симптом:** `node --test tests/migration-registry.test.mjs` падает `relation "public.restored_context_migration_evidence" does not exist`, причём и на чистом HEAD `238810e` без правок задачи (проверено отдельным worktree).
**Причина:** тест создаёт схему `mig_registry_test`, ставит её в `search_path` и прогоняет туда весь каталог `sql/`. Файл `025_parallel_shifts_core.sql` создаёт таблицы без схемы (они попадают в `mig_registry_test`), но в теле функций ссылается на них как `public.restored_context_migration_evidence` — в `public` их нет.
**Что делать:** не считать этот красный регрессией конкретной задачи и не «чинить» его правкой 026. Настоящее исправление — либо прогнать 025/026 в тесте в отдельной БД (а не в отдельной схеме), либо квалифицировать все объекты 025 единообразно; это отдельная задача с прогоном полного набора. До неё ориентир: остальные DB-файлы зелёные, `migration-registry` — известный красный.

**Исправлено 26.11.2026 (Task 12, ветка `fix/migration-registry-scratch-db`).** Тест больше не подсовывает схему: он создаёт настоящую пустую базу (`CREATE DATABASE … TEMPLATE template0`), прогоняет туда весь `sql/` (минус 018) через `applyMigrations` с `requireRoleBoundary`, проверяет 23 записи sha256 в `schema_migrations`, повторный прогон как чистый no-op и ловит дрейф чексуммы (копия каталога с изменённым файлом → `migration checksum mismatch`). Зелёный и напрямую (`node --test` с `TEST_DATABASE_URL`), и в harness. Уроки ниже — чтобы не наступить снова.

## 29. Урок 26.11.2026 (Task 12): как честно прогонять `apply-migrations` в тесте

**1. Миграции 025/026 полностью квалифицированы (`public.`) — это защита, а не баг.** Любой тест, который ставит чужой `search_path` и ждёт, что миграции «подстроятся», будет красным 42P01. Правильный путь — настоящая пустая БД. Проверка `to_regclass('public.restored_context_migration_evidence')` в тесте фиксирует именно это: объект обязан оказаться в `public`.

**2. Корень, которому нужен `CREATE DATABASE`, обязан быть `harness-contract` с `env:['bootstrap-url']`.** db-ребёнок получает только `TEST_DATABASE_URL` под `samosval_test_app` (DML, без `CREATEDB`) — создать базу он не может, а `TEST_DATABASE_URL` в harness-прогоне вообще не выставляется. Классификация задаётся **не манифестом**, а списком `HARNESS_ROOTS` в `server/scripts/isolated-db/discovery.mjs`: без строки `'migration-registry.test.mjs'` `loadManifest` падает «classification drift», даже если в `db-test-manifest.mjs` всё правильно. Это единственная правка вне тестовых файлов (одно имя в существующем Set), сделана осознанно; при следующем переводе корня в harness-contract помнить про два места.

**3. `transformLegacyMigrationGuard(sql, filename, database)` вместо `retargetLegacyGuard`.** `retargetLegacyGuard` из `tests/helpers/isolated-db.mjs` жёстко привязан к имени `samosval_parallel_shifts_test` и к `SAMOSVAL_ISOLATED_TEST=1`, поэтому для scratch-базы с суффиксом `_<pid>_<rand>` не годится. `transformLegacyMigrationGuard` проверяет те же точные чексуммы legacy-файлов, но принимает любое валидное имя базы. Имя базы обязано быть `^[a-z][a-z0-9_]*$` и ≤63 байт.

**4. Teardown: `DROP DATABASE … WITH (FORCE)` сразу после `pool.end()` даёт флейк `57P01 terminating connection due to administrator command`.** Симптом: тест зелёный 9 раз из 10, иногда `uncaughtException` из `node:internal/stream_base_commons`. Причина — гонка: сокет пула закрывается, backend ещё жив, FORCE его добивает, и клиент получает FATAL уже без обработчика. Что делать: `pool.on('error', () => {})` при создании пула **и** дождаться, пока `pg_stat_activity` не покажет ноль сессий этой базы (опрос по 50 мс, до ~2 с), только потом `DROP … WITH (FORCE)`. После teardown проверять `pg_database`: база обязана исчезнуть, иначе следующий прогон упрётся в занятое имя.

**5. Роли 025 в CI.** `requireRoleBoundary` требует `samosval_schema_owner`/`samosval_migration_evidence_owner` (NOLOGIN) и `samosval_runtime`/`samosval_maintenance` (LOGIN), все `NOSUPERUSER NOBYPASSRLS`. В `.github/workflows/synology-server-tests.yml` они создаются идемпотентно (`DO $roles$ … CREATE ROLE`, затем `ALTER ROLE …`) в том же шаге, что применяет SQL. Тест падает **явно** со списком отсутствующих ролей, а не пропускается молча.

**6. `TEST_DATABASE_URL` в тесте — это admin-URL, а не цель.** В CI база `samosval_test` принадлежит `POSTGRES_USER` (superuser), поэтому `CREATE DATABASE` разрешён; тест создаёт свою базу и не трогает содержимое `samosval_test`. Локально тот же путь работает от bootstrap-admin.

## 30. Урок 26.11.2026: гейт `synology-server-tests` был структурно недостижим — и почему

**1. Workflow не запускался на рабочей ветке вообще.** Триггер `on.push.branches` был только `feature/synology-**` и `fix/nas-ticker-plate-20261030`; последний прогон — 31.10.2026. На `root` этот workflow не гонялся ни разу. «Зелёный гейт» в отчётах означал «не запускался», а не «прошёл». Что делать: при любой ссылке на CI-гейт сначала смотреть `gh run list --workflow=<файл>` и убеждаться, что прогон для **этой** ветки существует.

**2. `npm test` не мог быть зелёным в CI по устройству.** Шаг готовил базу `samosval_test` (superuser), но 7 файлов общего глоба `tests/*.test.mjs` требуют другого окружения: `identity-store` — таблиц `user_credentials` (миграция 018 под guard-ом имени `samosval_working_test_reserve`), `shift-close` — засеянных данных, `seed-*`/`truck-phone-http`/`compose-isolated-db`/`isolated-db-runner` — изолированной или подготовленной базы. Смешанный глоб `tests/*.test.mjs` не является корректным CI-набором; официальный путь — per-file harness (`scripts/test-isolated-db.sh`) с манифестом.

**3. Раннер harness объявлял фикстуры, но никогда их не накладывал.** `tests/db-test-manifest.mjs` содержит `fixturesByFile`, `--list` печатает `fixtures=N`, но `scripts/test-isolated-db.mjs` не вызывал `applyFixtures` из `scripts/isolated-db/fixtures.mjs`. Следствие: 21 корень падал `42P01 relation "migration_documents" does not exist` — в том числе `refresh-source`, у которого фикстура `import-schema` **объявлена**. Диагностический признак: падает и корень, чья фикстура объявлена в манифесте → проблема в механизме, а не в фикстуре. Что делать: накладывать фикстуры **до** `grantTargetAccess`, привилегированным соединением: `grantTargetAccess` выдаёт DML на существующие таблицы, поэтому таблицы, созданные фикстурой позже, остались бы без прав у `samosval_test_app`. Фазу `fixtures` добавить в `CLEANUP_PHASES` (`scripts/isolated-db/database.mjs`), иначе очистка цели при падении фикстуры отвергается как «cleanup phase is not approved».

**4. `requireIsolatedDatabase` принимал только точное имя `samosval_parallel_shifts_test`.** Harness выдаёт `samosval_parallel_shifts_test_<runid>_<hash>`, поэтому 12 db-корней падали «isolated database target is not approved». Принимать надо обе формы: точное legacy-имя и точную generated-форму `^samosval_parallel_shifts_test_[a-f0-9]{12,20}_[a-f0-9]{12}$`; всё прочее (query/hash, чужие хосты, неполный хеш, `_tpl_s24`) по-прежнему отклонять. `retargetLegacyGuard` при этом обязан брать **фактическое** имя из проверенного URL: иначе на generated-цели legacy-guard перенацеливается на точное имя и падает `TEST database required`.

**5. db-ребёнок работает как `samosval_test_app` и не может делать DDL.** Симптомы по классам: `must be owner of schema public` (reset + `applyMigrationsThrough`), `must be owner of table` (drop/re-add FK), `permission denied for function` (SECURITY DEFINER), `permission denied for schema public` даже на `CREATE TABLE IF NOT EXISTS`. Причина: у app-роли только `USAGE` на `public` и DML. Что делать: setup (reset/миграции/фикстуры) выполнять привилегированным соединением, объявленным в манифесте (`env:['bootstrap-url']`), а утверждения теста — под app-ролью через `TEST_DATABASE_URL`. `bootstrap-url`, передаваемый db-ребёнку, переписывается на **его собственную** цель, чтобы DDL не мог уйти в чужую или общую базу.

**6. Зашитые имена БД в JS-гардах мешали harness-цели.** `prepare-test-refresh.mjs` (`<>'samosval_test'`), `prepare-test-import.mjs` (`NOT IN ('samosval_test','samosval_working_test_reserve')`), `seed-objects/identity/services.mjs`, `scripts/seed-tabel.mjs` (`<>'samosval_working_test_reserve'`). Правильно — параметризовать ожидаемое имя с сохранением прежнего значения по умолчанию, а тест передаёт фактическое `current_database()`; SQL-файлы `sql/*.sql` при этом **не трогать** (исторические guard не ослабляются).

**7. Порядок `relacl` — не контракт.** `replica-stream-026` сравнивал `schemaFingerprint` с массивом ACL; порядок элементов зависит от истории GRANT/REVOKE и меняется между прогонами. Сравнивать как множество.

**8. Harness-контракт с фиксированными runid обязан чистить `target_receipts`.** Иначе тест проходит ровно один раз на кластер: уборка оставляет надгробие `state='marked'`, а повторный `prepareTarget` на то же имя падает closed (`isolated-db-bootstrap`). Проверять перезапуском дважды подряд.

**9. Таймаут 60 с маскирует ошибку как «тишину».** `parallel-shifts-historicalization` «молчал» 60 с и падал по таймауту, хотя реальная причина — ACL. При таймауте без вывода сначала проверять права/ошибку на одном тесте с `--test-name-pattern`, а не увеличивать таймаут.

**10. Порт локального кластера жёстко 55432.** `scripts/isolated-db/safety.mjs` принимает только `55432`; при `POSTGRES_TEST_PORT=55433` в env-файле `adminPreflight` падает `connect ECONNREFUSED 127.0.0.1:55432`. Проверять фактический проброс (`docker port server_postgres_1`) и не полагаться на значение из старого env-файла.

## 31. Урок 26.11.2026: гейт впервые запустился и покраснел на переносимости тестов, а не на коде

Первый реальный прогон `synology-server-tests` для `feature/wtest-parallel-shifts-20261123` (run 45804417264) дал ровно **два** красных файла из 79 — оба про окружение раннера. Сам harness отработал штатно: `cleanup: complete`, `leaks: 0`, утечек и висящих баз нет.

**1. `mkdtempSync('/tmp/opencode/i5-process-')` → ENOENT на раннере.**
**Симптом:** пять проверок `isolated-db-process.test.mjs` падают `ENOENT: no such file or directory, mkdtemp '/tmp/opencode/i5-process-XXXXXX'`, при этом локально всё зелёное.
**Причина:** `/tmp/opencode` — каталог, созданный только на сервере владельца; на `ubuntu-latest` его нет, а `mkdtemp` не создаёт родителя.
**Что делать:** в тестах и harness-модулях брать `mkdtempSync(join(tmpdir(), '<prefix>-'))`. То же касается литеральных `--out /tmp/opencode/...` в тестах: заменять на `join(tmpdir(), ...)`.
**Защита:** в `tests/isolated-db-guard.test.mjs` добавлена проверка «ни тест, ни harness-модуль не содержит абсолютного пути владельца в кавычках» (сканируются `tests/` и `scripts/isolated-db/`; `scripts/*.mjs` исключены намеренно — `control-check-firebase-login.mjs` держит local-путь по умолчанию с переопределением через env и в CI не запускается).

**2. `docker compose config` без `--profile` рендерит пустой набор сервисов.**
**Симптом:** `compose-isolated-db.test.mjs` падал `The input did not match /POSTGRES_DB: postgres/. Input: 'name: server\nservices: {}\n'`.
**Причина:** сервис `postgres` объявлен в профиле `test`. `docker compose` v2 (есть на раннере) фильтрует `config` по активным профилям и отдаёт `services: {}`; legacy `docker-compose` v1 (был локально) профили игнорирует и отдавал всё — поэтому локально тест был зелёным.
**Что делать:** в тесте, который читает `config`, передавать `--profile test` именно для v2 (`compose.filtersProfilesInConfig === true`), иначе получаешь «пустой compose» вместо ошибки. Это второй случай правила: **отсутствие `docker compose` v2 локально не означает, что его нет в CI** — проверять обе ветки (см. урок 30, п. 10 про порт).

**3. Правило на будущее.** Любой новый тест, который трогает ФС или compose, обязан проходить при «чужом» окружении: другой каталог временных файлов, другой набор docker-плагинов, отсутствие `/home/iluxa`. Локальная зелень больше не считается доказательством для гейта; доказательство — push в ветку из триггеров и зелёный run.

## 32. Урок 26.11.2026 (Task 12, фикс гейта): упавший тест-файл оставлял живыми своих потомков

**Симптом:** файл падал с ненулевым кодом, но запущенный им API-сервер (и его собственные дети) оставался жив, держал соединение к целевой БД; очистка и следующий прогон висли или упирались в занятый порт 18099.

**Причина:** `runProcessGroup` снимал группу только по таймауту или внешнему сигналу (`stopGroup`). При обычном выходе лидера — в том числе с ошибкой — раннер лишь дожидался `exit` и разрешался, а выжившие члены группы оставались жить. `terminate_exact_target` убивает соединения, но не процессы, поэтому дальше начинается гонка с `DROP DATABASE` и следующим прогоном.

**Что делать:** после переиспользования (reap) лидера раннер обязан добить выживших членов группы: `kill(-pid, SIGTERM)` → `graceMs` → `SIGKILL`, и только потом разрешаться. «Группа пуста» проверяется через `kill(-pid, 0)`: ESRCH значит пусто. Регрессии — `tests/isolated-db-process.test.mjs` (юнит, синтетический потомок) и `tests/isolated-db-http-tree.test.mjs` (вложенный настоящий раннер на `truck-phone-http`). Этому корню нужен свой бюджет времени: harness-contract может объявить необязательный `timeoutMs` (1–300 с), иначе действует общий дефолт 60 с.

**Ловушка при проверке:** живучесть самого API ничего не доказывает — очистка раннера (`terminate_exact_target` + `DROP DATABASE`) роняет его на unhandled `error` пула (у `src/index.mjs` нет `pool.on('error')`), поэтому «API исчез» верно и без снятия группы. В http-tree тесте свидетелем служит отдельный потомок-«спящий» без БД, чей pid пишется в `ISOLATED_DB_PROCESS_LOG`. Принудительный сбой включается только маркером `ISOLATED_DB_HTTP_FORCED_FAILURE` из фикстуры тест-файла, а не хуком в раннере. Сам unhandled `error` пула — отдельный production-риск: перезапуск/terminate БД роняет API; это чинится `pool.on('error')` и требует отдельного решения.

**Официальный прогон — на свежем кластере:** `docker-compose -f compose.test.yaml --profile test down -v` и заново `up -d` до `healthy`. Иначе остатки шаблонов/целей от предыдущего упавшего прогона дают ложные красные.

## 33. Урок 26.11.2026 (тип смены): клиент выводил день/ночь из часа, а сервер уже нет

**Симптом:** клиентский набор `working-test/source/core/*.test.mjs` краснел на тесте «без workShift — старый фолбэк по часу открытия (совместимость)». Для смены без `workShift`/`kind` серверный `linePeriod` (`server/src/shift-archive.mjs:8`) бросает `unknown-shift-period` (409), а клиентский `sourcePeriod` (`working-test/tabel-v2/material-transfer.mjs:8`) в той же ситуации подставлял `hour>=8 && hour<20 ? 'day' : 'night'`.

**Причина:** строгое правило «доказанный тип» ввели на сервере (D4 в `server/sql/025_parallel_shifts_core.sql`: нет `workShift`/`type` → `shift_type=NULL`, `shift_type_resolution='unresolved'`, активные/закрывающиеся такие строки уводятся в `historical`), но клиентский перенос материала сохранил старый фолбэк. Одна и та же смена получала на клиенте и на сервере разный день/ночь, и материал мог лечь в чужую клетку табеля.

**Что делать:** тип смены не выводить из `startedAt` нигде; без `workShift`/`kind` обе стороны обязаны отказать. `sourcePeriod` теперь бросает «Не определён тип смены Линии (дневная или ночная): тип не был указан при открытии смены». Последствие по коду (не решено, нужно решение владельца): legacy-смену без типа нельзя закрыть — сервер на `finish` при наличии рейсов отвечает `unknown-shift-period`, а клиент падает в `transferClosedLine` ещё до `finish`, оставляя смену в `closing` с сохранённым архивом (повтор закрытия даёт ту же ошибку). Механизм ручного уточнения типа есть только как серверный модуль `server/src/legacy-shift-resolution.mjs` (`resolve_legacy_shift`, admin-only) без HTTP-маршрута и без UI. Регрессия: `working-test/source/core/shift-kind-at-start.test.mjs`.

**Решение владельца 26.11.2026 (последствие выше закрыто):** legacy-смену без выбранного типа закрываем без вопросов и без ручного уточнения типа — «смена без выбранного типа — закрываем и забываем про неё». Материал в табель при этом НЕ переносится (день/ночь неизвестны, объём класть некуда), архив сохраняется целиком, рейсы и статусы удаляются, смена получает `closedAt`/`closedBy`. Тип по-прежнему нигде не угадывается: `linePeriod`/`sourcePeriod` остаются строгими для всех, кто реально переносит материал. Сервер (`server/src/shift-close.mjs`, фаза `finish`) отличает «тип доказан» от «тип не определён» и в неопределённом случае пропускает `linePeriod`/`tabel_policy`/`requireMaterialImport`. **Аудит-поле:** в результате операции `finish` и в сохранённом `shift` появляется `materialImport:'skipped-unresolved-type'` — в истории видно, что перенос пропущен именно из-за неопределённого типа, а не забыт; для смен с доказанным типом поле не добавляется (их поведение не меняется). Клиент: переиспользуемый предикат `shiftHasProvenKind(shift)` в `working-test/tabel-v2/material-transfer.mjs` (им же пользуется `sourcePeriod`), а `nasCloseCurrentShift` в `working-test/source/core/21-nas-runtime.js` вызывает `transferClosedLine` только при доказанном типе, иначе после успешного `finish` показывает через `appNotice` (не `showError`) текст «Смена открыта без выбранного типа (дневная/ночная). Закрыто без переноса в табель — объёмы остались в архиве.». Пустая legacy-смена без рейсов и `restored`-смена закрываются как раньше. Регрессии: `server/tests/shift-close.test.mjs` (кейс legacy без типа + контрольный кейс «доказанный тип без подтверждённого материала по-прежнему падает») и `working-test/source/core/shift-kind-at-start.test.mjs`.

## 34. Урок 26.11.2026: terminate сессий БД ронял API — у пула не было обработчика `error`

**Симптом:** при обслуживании/рестарте БД, `pg_terminate_backend` или kill сессии процесс API (`server/src/index.mjs`) умирал с `Unhandled 'error' event … terminating connection due to administrator command` и не отвечал до перезапуска контейнера. То же происходило в очистке harness: terminate backend'ов гасил API как побочный эффект.
**Причина:** `new Pool(...)` создавался без слушателя события `error`. `pg-pool` эмитит `error` на простаивающем клиенте, когда сервер обрывает соединение, а `EventEmitter` без слушателя бросает исключение и завершает процесс. Это не ошибка запроса (её ловит обработчик маршрута), а именно гибель idle-клиента в пуле.
**Что делать:** сразу после создания пула ставить `pool.on('error', ...)` и логировать только код/имя ошибки (`error?.code || error?.name`), без строки подключения и пароля: `pool.on('error',error=>console.error('[pg-pool] idle client error',error?.code||error?.name||'unknown'))`. Пул сам создаёт новое соединение по следующему запросу, перезапуск API не нужен. Глобальный `process.on('uncaughtException')` для этого не применять — он глушит всё.
**Регрессия:** `server/tests/api-pool-resilience.test.mjs` (db, `indirect-http`, `env:['bootstrap-url']`, порт 18098). Поднимает настоящий `src/index.mjs`, делает успешный `/health/ready`, привилегированным соединением выполняет `pg_terminate_backend` для всех прочих сессий своей целевой БД, затем требует: процесс жив, `/health/live` отвечает 200, `/health/ready` снова 200 `database:connected`. Без `pool.on('error')` тест краснеет ровно тем самым unhandled `error`. Для рабочей линии исправление войдёт в обычный выпуск сервера, отдельного деплоя не требует.
**Наблюдение:** комментарии в `tests/truck-phone-http.test.mjs` и `tests/isolated-db-http-tree.test.mjs` о том, что API «умирает от terminate при очистке», после этого фикса устарели. Тесты по-прежнему зелёные: API убивает снятие группы процессов, а свидетелем reap остаётся потомок-«спящий» без БД.
