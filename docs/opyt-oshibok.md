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

## 35. Урок 26.11.2026 (клиент v2): в репозитории две копии session-client, тесты сервера проверяют не ту

**Симптом:** правишь `working-test/synology/session-client.mjs`, а `node --test server/tests/session-client.test.mjs` остаётся зелёным и ничего не доказывает.
**Причина:** `server/tests/session-client.test.mjs:3` импортирует `../../test-app/synology/session-client.mjs` — это отдельная, более старая копия клиента (без `probe`, `wake`, `restoredShifts`, `requestV2`). Активный клиент тестовой линии — `working-test/synology/session-client.mjs`; его покрывают `working-test/source/core/{session-idle-recovery,30-wake-fast-reconnect,truck-phone-transport}.test.mjs` и `working-test/source/core/v2-transport.test.mjs`.
**Что делать:** меняя общий транспорт, проверять обе копии (`diff test-app/synology/session-client.mjs working-test/synology/session-client.mjs`) и гонять клиентские тесты из `working-test/source/core/`. Копию в `test-app/` без отдельного поручения не править: это архив мёртвого канала.

## 36. Урок 26.11.2026 (v2 API): серверных маршрутов `/api/v2/shifts|archives` в репозитории ещё нет

**Симптом:** клиентский транспорт v2 (задача 14 плана параллельных смен) написан и проверен, но живой прогон против сервера невозможен: любой `/api/v2/shifts...` отдаёт 404.
**Причина:** к HEAD `b94aa5d` на сервере реализованы только `server/src/legacy-shift-resolution-route.mjs` (regex `/api/v2/admin/legacy-shifts/{shiftId}/resolve`, в `server/src/index.mjs` не подключён) и серверные задачи 6–12 (БД/миграции/архив). Модулей `v2-router`, `shift-read-v2`, `shift-members-v2`, `shift-trucks-v2`, `shift-transfer-v2`, `shift-close-v2`, `line-store-v2`, `protocol-gate` нет; `index.mjs` роутит только `/api/v1/*`.
**Что делать:** клиентский транспорт держать на инъекции `request` и проверять на фейковом запросе (`working-test/source/core/v2-transport.test.mjs`) — контракт берётся из `docs/superpowers/specs/2026-11-23-parallel-shifts-design.md` §5. Включать мост рантайма (`21-nas-runtime.js`) только флагом `WORKING_TEST_V2_SHIFTS`; без флага поллинг v2 молчит и не засоряет `syncState.errors`. Живой браузерный прогон v2 — после серверных задач 16–22.

## 37. Урок 26.11.2026 (процесс): две разные копии плана «параллельные смены» — агенты взяли нумерацию из устаревшей

**Симптом:** задачи «клиентские контексты смен» и «транспорт v2» были выполнены как «Task 13/14», хотя в актуальном плане это Task 23/24 и они идут ПОСЛЕ серверных задач 16–22. В результате клиентский транспорт написан по спецификации, без живого сервера (см. п.36).
**Причина:** в корневом checkout `/home/iluxa/Samosval-repo-main` лежит версия плана на 27 задач (коммит `29b810d`), а в ветке `feature/wtest-parallel-shifts-20261123` — обновлённая версия на 31 задачу (коммит `33c3486`, «update parallel shifts plans for legacy provenance») с другой нумерацией и другим порядком фаз. Обе версии называются одинаково — `docs/superpowers/plans/2026-11-23-parallel-shifts.md`.
**Что делать:** перед выдачей задачи по плану сверять, что читается файл ИЗ ВЕТКИ задачи (`git -C <worktree> log -1 --format=%h -- docs/superpowers/plans/`), а не из корневого checkout. Источник истины — файл в ветке. Текущий статус задач ведётся в `docs/superpowers/plans/2026-11-23-parallel-shifts-progress.md` (реестр), а не по галочкам в плане.

## 38. Урок 26.11.2026 (сборка): `check-production-integrity.py` красный в ветке этапа 4 — это устаревшие артефакты, а не поломка сборки

**Симптом:** в ветке `feature/wtest-parallel-shifts-20261123` (начиная с коммита `470d506`) `python3 tools/check-production-integrity.py` даёт 4 FAIL: `index-working-test.html`, `sw-working-test.js`, `version.json`, `working-test/build-manifest.json` «не воспроизводимы байт-в-байт». Пересборка даёт `cdc2d76d7948d25a`, закоммичено `eb4ffda80ac65ac4`.
**Причина:** сборка детерминирована (два прогона подряд дают один и тот же build id и одинаковые sha256; в хеш не входят время, hostname, версии, абсолютные пути; входы отсортированы). Закоммиченный комплект `eb4ffda80ac65ac4` целиком соответствует коммиту `fdfbfca` (сборка 1.8.6) и внутренне согласован (142 assets, 141 совпадает). После `fdfbfca` правились `working-test/source/core/15-shifts.js` (`470d506`, `4598272`) и добавлялись модули этапа 4 (`38c89eb`, `195be0c`, `11c76a0`) — артефакты по плану не пересобирались, потому что выпуск в этап 4 не входит (Global Constraints плана: release history меняется только в release-задаче).
**Что делать:** не пересобирать в задачах этапа 4. Пересборка — только в release-задаче этапа 4, вместе с bump версии (`shell.html` meta + видимая шапка «Линия», первая запись `release-history.js`), затем коммит четырёх артефактов и нового каталога `working-test/build/<id>/`. Важно: пересборка БЕЗ bump версии уедет в тестовую линию как смена build при той же версии 1.8.6, и клиенты автообновятся на невыпущенный код — так не делать. CI `production-source-integrity` гоняется только на push в `root` (`branches: [root]`), поэтому в feature-ветке FAIL никого не блокирует, но перед мержем в `root` пересборка обязательна.
**Побочные долги:** (1) `tools/verify-working-test.py:52` жёстко зашивает `REQUIRED_VERSION='1.7.22'` и красный на любом 1.8.x; (2) `working-test/source/core/32-tabel-live-sync.test.mjs` не завершается (открытый handle, внутри `crypto is not defined`), из-за чего полный `verify-working-test.py` висит; (3) `working-test/src/storage.js` входит в assets, но не в build id — его правка не сменит версию для клиентов.

## 39. Урок 26.11.2026 (Task 17): db-корень получает только шаблон baseline, `migrationsThrough` в манифесте ничего не применяет

**Помечено 26.11.2026:** запись объединена с №40 (тот же корень причины, там полный разбор и все следствия по consumers/счётчику корней). Оставлена для истории.

**Симптом:** новый `tests/v2-shift-access.test.mjs` с `kind:'db'` падает `relation "shift_members" does not exist` (42P01) в `finally`, хотя в манифесте у корня стоял `migrationsThrough` и рядом лежит `sql/025_parallel_shifts_core.sql`. Ошибка в `finally` маскирует настоящую причину: setup упал раньше, и настоящий сбой виден только после исправления уборки.
**Причина:** `scripts/test-isolated-db.mjs` не применяет миграции к цели. `provisionTarget` клонирует **готовый шаблон** `baseline` (`empty`/`S24`/`S25`), а `migrationsThrough` — описательное поле манифеста, которое рантайм не читает. S25 = S24 + ровно 025, поэтому корень на S24 не имеет ни `shift_members`, ни 026/027, а корень на S25 не имеет 026/027. Миграции сверх шаблона тест обязан применить сам — привилегированным bootstrap-соединением (`applyMigrationsThrough(27)` из `tests/helpers/isolated-db.mjs`), иначе DDL не пройдёт под `samosval_test_app`.
**Что делать:** для корня, которому нужна схема новее шаблона, ставить `baseline:'S25'` (первый такой db-корень — `v2-shift-access`), `migrationsThrough:27`, `env:['bootstrap-url']` и вызывать `applyMigrationsThrough(27)` в setup. После этого `applyMigrations` применит только отсутствующие 026/027 и выдаст app-роли гранты на новые таблицы. Импорт `tests/helpers/isolated-db.mjs` меняет вычисленный список consumers — его надо обновить в `db-test-manifest.mjs` ровно как сообщает ошибка discovery (`scripts/apply-migrations.mjs:pg`, `tests/helpers/isolated-db.mjs:{db-env,db-helper,pg}`, плюс собственные `db-env`/`pg`). Счёт корней (83 → 84) и `discovered == manifest` держать в том же коммите.

## 40. Урок 26.11.2026 (раннер тестов): `migrationsThrough` в манифесте — декларация, а не применение

**Симптом:** корень падает на отсутствующей таблице/колонке (`relation "shift_members" does not exist` 42P01, `column "protocol_version" does not exist` 42703), хотя в `tests/db-test-manifest.mjs` у него стоит `migrationsThrough`, а `loadManifest` зелёный. Дополнительно: если ошибка возникает в `finally`, она маскирует настоящую причину — setup упал раньше.
**Причина:** раннер `scripts/test-isolated-db.mjs` не применяет миграции к цели. `provisionTarget` клонирует **готовый шаблон** (`empty`/`S24`/`S25`; `scripts/isolated-db/database.mjs`, `TEMPLATE_CHAIN`), а `migrationsThrough` проходит только валидацию в `scripts/isolated-db/manifest.mjs` и на прогон не влияет. S25 = S24 + ровно 025, поэтому корень на S24 не имеет ни `shift_members`, ни 026/027, а корень на S25 не имеет 026/027.
**Что делать:** тест обязан применить недостающие миграции сам, привилегированным bootstrap-соединением: `applyMigrationsThrough(N)` из `tests/helpers/isolated-db.mjs` (иначе DDL не пройдёт под `samosval_test_app`). Для схемы новее 025 ставить `baseline:'S25'` (первый такой db-корень — `v2-shift-access`, `migrationsThrough:27`), для 026 — `applyMigrationsThrough(26)` поверх S24-клона. Побочные следствия, которые надо делать в том же коммите: (1) импорт `tests/helpers/isolated-db.mjs` меняет вычисленный список consumers — дописать `scripts/apply-migrations.mjs:pg` и `tests/helpers/isolated-db.mjs:{db-env,db-helper,pg}`, иначе `loadManifest` краснеет «consumer drift»; (2) счёт корней в `db-test-discovery.test.mjs` держать равным манифесту; (3) код, читающий новые колонки 026, обязан проверять их наличие (`to_regclass('public.replica_document_heads')`), потому что старые корни (`replica-materialize`, `replica-materialize-parallel-shifts`) живут на 024/025.

## 41. Урок 26.11.2026 (Task 18): корню с legacy-строками нужен baseline S24, а «0 байт + exit=1» — не падение теста

**Симптом 1:** новый db-корень `v2-shift-read-db` проверяет, что `historical`/`restored`/`unresolved` никогда не попадают в видимый список. На шаблоне S25 (как у `v2-shift-access`, см. п.39) такой фикстурой не обойтись: 025 уже применена, и триггер `shifts_legacy_bridge` не даст вставить «неразрешённую» legacy-строку — он требует ровно 14 ключей published v2 payload и падает `invalid-shift-v2-provenance`.
**Причина:** историческую и восстановленную строки создаёт именно классификатор 025, а не тест. Значит фикстура обязана существовать ДО 025.
**Что делать:** для такого корня ставить `baseline:'S24'` и применять `applyMigrationsThrough(27)` уже после вставки legacy-строк. Отличие от п.39: там нужна была готовая 025 в шаблоне, здесь — наоборот, отсутствие 025. Оба варианта законны; выбор диктуется тем, что тест должен доказать. `migrationsThrough` в манифесте по-прежнему только описательное поле — применяет миграции сам тест.

**Симптом 2:** `sh scripts/test-isolated-db.sh --file tests/v2-shift-read-db.test.mjs` завершается `exit=1` и **нулевым** выводом (0 байт, ни TAP, ни stderr). Сразу повторенная та же команда даёт полный TAP: сначала реальные падения, потом зелёный прогон `exit=0`, 2000 байт.
**Причина:** не доказана. Второй раз подряд (первый — задача 17, см. реестр `2026-11-23-parallel-shifts-progress.md`, «Открытые наблюдения»), на том же изолированном кластере, при неизменном коде; перенаправление вывода ни при чём — «пустые» прогоны были и с `> файл`, и через `| tee`, а последующий прогон с `> файл` прошёл.
**Что делать:** «0 байт + exit=1» НЕ считать доказательством падения теста и НЕ начинать правку кода по такому сигналу. Сначала повторить прогон (лучше с `--report <файл>`: пустой stdout при непустом отчёте сразу покажет, что дело в потере вывода раннера, а не в тесте). В отчёте фиксировать оба факта — пустой прогон и результат повтора.

## 42. Урок 26.11.2026 (Task 12): провенанс-тесты replica нельзя класть в S24-корень, а порядок материализации ≠ порядок seq

**Симптом:** по букве Task 12 кейсы «objects/users head creation», «missing object/user rollback» и «same-batch parent order» нужно было добавить в `tests/replica-materialize.test.mjs`, но этот корень живёт на baseline S24: таблиц `replica_document_heads`/`replica_pending_documents` там нет, а его `cleanup()` делает `DELETE FROM replica_stream`, что после 026 запрещено триггером `replica_stream_immutable`. Добавить туда 026 можно только ценой переписывания всего файла и `env:['bootstrap-url']` в манифесте.
**Причина:** см. п.40 — baseline корня задаёт максимальную схему, а не `migrationsThrough`. Плюс `appendReplicaBatch` нумеровал seq и материализовал в одном цикле, то есть в порядке прихода. Пачка, где shift стоял раньше своего object (или status раньше truck), падала `replica-shift-object-missing`, хотя §4.10 требует deterministic topological order и «не зависит от произвольного входного порядка».
**Что делать:** провенанс-тесты (golden-вектор, v1 byte stability, sender≠creator, delete null, id/path mismatch, heads objects/users, missing parents, same-batch order) держать в `tests/replica-store.test.mjs` — это корень на 026 с bootstrap-url, который сам применяет 026. В `appendReplicaBatch` seq по-прежнему назначается по позиции в пачке (immutable stream не перенумеровывается), но применять документы надо стабильной сортировкой по рангу `objects/users → shift/trucks → truckStatus/logs`, journal-only — последними. Тогда head хранит свой arrival-seq, а родитель из той же пачки уже записан. Регрессия ловится тестом «a batch materializes parents before children regardless of arrival order».

## 43. Урок 26.11.2026 (Task 14): у двух удалений одного документа одинаковый sha256 — поколение tombstone доказывает seq, а не хеш

**Симптом:** тест «recreate/delete generations» сравнивал `payload.deletedSha256` первой и второй tombstone одного объекта и падал «Expected actual to be strictly unequal to». Хеши совпадали, хотя head_seq и `deletedSeq` выросли.
**Причина:** `hashReplicaOperationV2(kind,payload)` хеширует только `{protocolVersion:2,kind,payload}`, а канонический `doc.delete` — это `{collection,path}`. Два удаления одного и того же документа с разными `operation_id` и разными seq дают **байт-идентичный** payload и, значит, одинаковый sha256. Хеш доказывает «тот же документ тем же способом», но не «другое поколение». Различает поколения только `head_seq`/`applied_seq`.
**Что делать:** в tombstone хранить и сверять пару `deletedSeq` + `deletedSha256`: seq обязан совпасть с `head_seq`, hash — с `sha256` строки stream этого seq. Не делать hash единственным признаком поколения и не ждать, что повторное удаление даст другой хеш. Тест на generations проверяет рост `head_seq`/`deletedSeq`/`revision`, а не различие хешей. Одинаковый hash при равном seq — это replay (идемпотентный no-op), а не новая tombstone.

## 44. Урок 26.11.2026 (окружение): `docker-compose up` из каталога `server/` в новом worktree пересоздаёт чужой кластер и падает `KeyError: 'ContainerConfig'`

**Симптом:** `docker-compose -f compose.test.yaml --profile test up -d` в worktree задачи завершается трейсбеком python-compose в `merge_volume_bindings`/`get_container_data_volumes`, `KeyError: 'ContainerConfig'`. В `docker ps -a` виден чужой `server_postgres_1` из другого worktree.
**Причина:** имя compose-проекта по умолчанию — имя каталога (`server`), а оно у всех worktree одинаковое. Compose v1 пытается пересоздать контейнер другого агента и не умеет читать его конфиг. На 55432 при этом уже слушает общий изолированный кластер.
**Что делать:** не поднимать второй кластер из каталога с тем же именем. Если общий кластер на 55432 жив (`ss -ltn | grep 55432`), работать на нём: раннер создаёт отдельные цели `samosval_parallel_shifts_test_<run>_<hash>`, параллельные агенты не мешают друг другу. Если кластер нерабочий — поднимать со своим именем проекта: `docker-compose -p stage4-t14tomb -f compose.test.yaml --profile test up -d`. `down -v` на общем кластере не выполнять.

## 45. Урок 26.11.2026 (Task 15): точный restore упирается в immediate-FK указателя серии, identity-колонки, триггер эпохи и строгий мост смен

**Симптом 1:** восстановление пачки в порядке «series → revisions» падает `shift_archive_series_latest_revision_fk`: `Key (workspace_id, archive_id, latest_finalized_revision, latest_finalized_sha256)=(…, 2, ff49…) is not present in table "shift_archive_revisions"`.
**Причина:** `latest_finalized_*` — не «мягкий» указатель, а обычный (не DEFERRABLE) composite FK на конкретную ревизию. Вставка строки серии с уже заполненным указателем требует, чтобы ревизия существовала раньше, а ревизия требует серию раньше.
**Что делать:** вставлять серию с `latest_finalized_revision/latest_finalized_sha256 = NULL`, затем все ревизии, затем точечным `UPDATE` вернуть точный указатель. `SET CONSTRAINTS ALL IMMEDIATE` этого не решает: FK не объявлен DEFERRABLE, и откладывать его нельзя.

**Симптом 2:** точное восстановление surrogate-ключей `GENERATED ALWAYS AS IDENTITY` (`restored_context_audit.audit_id`, `archive_audit.audit_id`, `legacy_line_status_snapshots.snapshot_id`, `legacy_cutover_historicalization_audit.audit_id`, `shift_legacy_resolution_audit.audit_id`) либо падает, либо мешает восстановлению в другую workspace той же БД.
**Причина:** identity-значения не являются провенансом: на них никто не ссылается по смыслу, а перенос в другой workspace в той же базе даёт конфликт последовательности.
**Что делать:** identity-колонки не вставлять (пусть генерирует sequence цели) и исключать их из digest манифеста; после вставки делать `setval` на max. Всё остальное (включая `text`-идентификаторы операций/ревизий) вставлять байт-в-байт.

**Симптом 3:** после восстановления `line_history.dataset_epoch` и `workspace_service_audit.dataset_epoch` не равны снятым в бандле.
**Причина:** `BEFORE INSERT` триггер `set_history_epoch()` принудительно ставит `dataset_epoch = workspaces.restore_epoch`, то есть перезаписывает точное значение при вставке.
**Что делать:** сразу после вставки этих строк в той же транзакции вернуть снятое значение точечным `UPDATE` (до verifier). Иначе verifier честно упадёт на расхождении digest.

**Симптом 4:** вставка смены с payload, расширенным жизненным циклом (prepare/close добавляют ключи сверх опубликованных 14), отклоняется `invalid-shift-v2-provenance: start payload is not the exact published v2 document`.
**Причина:** `shifts_legacy_bridge()` на INSERT требует ровно 14 опубликованных ключей, а на UPDATE — те же 14 обязательных плюс запрет ключей `restored*`/`originalSourceShiftId`. Историческая v2-строка одновременно не проходит ни как «старт», ни как чистый UPDATE.
**Что делать:** вставлять смену с усечённым published-подмножеством payload (14 ключей), затем в той же транзакции переписать строку точными значениями. `shifts_manual_provenance_guard` при этом не мешает: он сравнивает OLD/NEW и пропускает запись, где `identity_resolution`/`shift_type_resolution` и их значения не меняются. Legacy v1-строку (`payload_schema_version <> 2`) так восстановить нельзя — это отдельный блокер схемы 028, а не повод ослабить мост.

## 46. Урок 26.11.2026 (Task 19): strict-v2 INSERT в `shifts` требует явного `is_active=true`, а `work_date` надо читать через `to_char`

**Симптом:** `INSERT INTO shifts(workspace_id,shift_id,payload) VALUES(...)` с байт-точным published v2 payload падает `shift canonical payload mismatch` (23514), хотя все 14 ключей на месте и ни одна canonical-колонка не передана. Тот же payload через `INSERT ... (workspace_id,shift_id,is_active,payload)` проходит.
**Причина:** `is_active` объявлена в `001_init.sql` как `boolean NOT NULL DEFAULT false`, поэтому «колонка не указана» — это не `NULL`, а уже подставленный `false`. Триггер `shifts_legacy_bridge` в INSERT-ветке сравнивает `NEW.is_active` с `payload_state IN ('active','closing')` и любой не-NULL `is_active` считает утверждением писателя; `false` против `active` — это drift. Остальные canonical-колонки (state/object_id/work_date/opened_at/...) действительно NULL и проверку пропускают, поэтому ошибка выглядит необъяснимой.
**Что делать:** strict-v2 писатель передаёт `is_active` явно и согласованно с документом (`true` для `state='active'`), либо пишет `state` и полагается на D1-нормализацию. Не ослаблять проверку триггера и не «чинить» её до NULL-семантики: drift-защита нужна, ловушка — в DEFAULT.

**Второй капкан того же INSERT-пути:** `pg` отдаёт `date` (`work_date`) как JS `Date` в локальной таймзоне сервера. `row.work_date.toISOString().slice(0,10)` в MSK-контейнере даёт **предыдущий** день (локальная полночь = 21:00 UTC). Для сравнений и ответов API выбирать `to_char(work_date,'YYYY-MM-DD') AS work_date_text` и не строить дату из `Date`.

## 47. Урок 27.11.2026 (I7, isolated-db harness): три независимых allowlist'а отстали от S26-шаблона

**Симптом 1:** root-тест `replica-exact-backup` показывает 7/7 TAP pass, но официальный runner завершается exit 1, а в отчёте `leaks: [{database: "..._tpl_s26", reason: "identity"}]`.
**Симптом 2:** после починки классификации runner всё равно exit 1, теперь `cleanup: "failed"`, и в каталоге остаются `_tpl_empty`, `_tpl_s24`, `_tpl_s26`.
**Причина:** цепочка шаблонов была расширена до S26 в `prepareTemplates`/`createTemplateBroker`, но три отдельных списка остались на S25:
- `scripts/isolated-db/safety.mjs` (`validateGeneratedIdentifier`, kind=`template`) — не признавал имя `_tpl_s26`;
- `scripts/isolated-db/database.mjs` (`classifyRow` в leak-check) — считал корректный S26 «identity mismatch»;
- `scripts/test-isolated-db.mjs` (`dropTemplates`) — перечислял только `S25,S24,empty`, поэтому S26 не удалялся никогда, а цикл останавливался на первом исключении.
Плюс ловушка диагностики: `test-isolated-db.mjs` глотает исходную ошибку `dropTemplates` (в отчёт попадает только `cleanup:"failed"`), поэтому без временного вывода `name/code/message` причина не видна. Данные тестового кластера живут в `tmpfs` (`compose.test.yaml`), поэтому после перезагрузки сервера остатки и их комментарии исчезают и «пустой comment» у leftovers — артефакт уже нового кластера, а не причина отказа.
**Что делать:** при добавлении нового baseline-шаблона обновлять ВСЕ четыре места сразу и проверять их одним прогоном: `safety.mjs` (allowlist имён), `database.mjs` (`TEMPLATE_KINDS`, `TEMPLATE_CHAIN`, `classifyRow`), `admin.mjs` (`TEMPLATE_BASELINES`, `quoteLiteral`, разбор suffix) и `manifest.mjs` (`BASELINE_VERSIONS`, `FIXTURES`). Порядок удаления шаблонов держать в одном источнике — `templateDropOrder()` в `templates.mjs` (tip → база: `S26,S25,S24,empty`), иначе дочерний шаблон нельзя удалить раньше родительского. Ошибки cleanup обязаны быть видны в отчёте/логе без секретов; временную диагностику (`[diag-catalog]` probe) в коммит не тащить.
**Отдельно про `passed()` в fixtures.mjs:** гейт постусловий должен оставаться строгим (`value === true`). Ослабление до «не false/null» пропускает числовые значения и маскирует дрейф; для фикстур, которые возвращают измеренные числа, ожидаемое значение задаётся явно (`expect`) и сравнивается точно.

## 48. Урок 27.11.2026 (I7, isolated-db harness): автовакуумный воркер выглядел «подключённой сессией» и валил полный прогон

**Симптом:** официальный прогон всех 90 корней даёт 89/90, причём красный файл каждый раз разный (`isolated-db-lifecycle` тест 35 «lost bootstrap connection», `isolated-db-http-tree` «the forced failure must record exactly one orphan pid»), а в изоляции каждый из них стабильно зелёный (6+ прогонов). Ошибка в отчёте — `CLOSED_ERROR` (`admin operation failed closed`) без исходной причины, потому что `redacted()`/`classified()` в `admin.mjs` намеренно глотают детали. Вложенный HTTP-корень падал за 1.9 с вместо ~12 с, то есть до запуска проверок.
**Причина:** `freezeTemplate` (и `inspectTemplateSeal`) считали сессиями ВСЕ строки `pg_stat_activity` по этой БД. Сразу после миграции шаблона к нему приходит **autovacuum worker** — это фоновый обслуживающий backend, а не клиент, и `CREATE DATABASE ... TEMPLATE` его игнорирует (PostgreSQL проверяет только клиентские сессии). В полном прогоне шаблоны создаются под нагрузкой, воркер успевает появиться в окне между проверкой и печатью → ложный `CLOSED_ERROR`. В изоляции окно уже/нагрузки нет — отсюда «флейк».
**Как подтвердили:** временная диагностика печатала в stderr `pid/backend_type/state` всех строк `pg_stat_activity` при отказе; в логе оказалось `{"backend_type":"autovacuum worker","state":"active","usename":null}`. Отдельный probe (`prepareTemplates` × 12 подряд, конкурентность 2) воспроизводил 1–2 отказа на 8 прогонов, а после правки — 0 на 12.
**Что делать:** предикат «есть ли подключённые клиенты» — только `backend_type='client backend'` (один источник истины: `CLIENT_BACKEND_FILTER` в `safety.mjs`, используется и в `admin.mjs`, и в `templates.mjs`). Не считать по `count(*) FROM pg_stat_activity WHERE datname=...` — там же живут autovacuum worker, walsender, parallel workers. Регрессия закреплена тестом в `tests/isolated-db-templates.test.mjs` («a sealed template counts only client backends…»), который проверяет и SQL печати, и SQL гейта брокера.
**Методика поиска таких флейков:** не перезапускать «до зелёного». Сначала включить временный вывод исходной ошибки (в stderr, без абсолютных путей в коде — иначе падает `isolated-db-guard`), затем воспроизвести нагрузкой в отдельном probe-скрипте вне репозитория, и только потом править. Временную диагностику удалять до коммита.

## 49. Урок 27.11.2026 (isolated-db harness): новый корень со своей базой падал `57P01` и убивал весь файл

**Симптом:** корень `isolated-db-s26-fixtures` (он сам создаёт S25/S26 через `CREATE DATABASE`) в полном прогоне 90 корней падал с `uncaughtException: terminating connection due to administrator command` (`57P01`) на `duration_ms ~1.7–2.7 с`, то есть до проверок; в изоляции тот же файл давал 1 отказ на 5 прогонов, затем 35 прогонов подряд зелёные. В отчёте харнесса — просто `test process failed: tests/isolated-db-s26-fixtures.test.mjs`, без причины.
**Причина:** `pg.Pool`/`pg.Client` без слушателя `error`. Когда backend клиента завершают снаружи (`DROP DATABASE ... WITH (FORCE)`, `pg_terminate_backend`, а также гонка «`pool.end()` вернулся, сервер ещё держит backend, следующий шаг делает `CREATE DATABASE ... TEMPLATE`/`DROP ... FORCE`»), клиент получает `FATAL 57P01`; в Node это событие `'error'` на объекте клиента, и без обработчика оно становится `uncaughtException` — падает весь тестовый процесс, а не один шаг. Тот же класс уже был описан и вылечен в `tests/migration-registry.test.mjs` («Idle clients can be terminated by DROP DATABASE ... WITH (FORCE)»), и тот же урок есть для API (`pool.on('error')` отсутствовал — terminate сессии ронял API).
**Что делать:** в любом тесте/скрипте, который создаёт свою базу и потом клонирует/удаляет её:
1. вешать `pool.on('error', …)` и **собирать** ошибку в массив, а в конце прогона утверждать, что массив пуст (не глотать: реальная потеря соединения должна валить тест, но внятно);
2. перед `CREATE DATABASE ... TEMPLATE src` и перед `DROP DATABASE ... WITH (FORCE)` дождаться, пока у сервера реально не останется backend'ов на этой базе (`count(*) FROM pg_stat_activity WHERE datname=$1` с короткими паузами);
3. после удаления проверить, что базы действительно нет (иначе следующий прогон упрётся в остаток).
Постусловия контракта (реестр, authority, триггеры, фикстуры) при этом не ослабляются — правится только рукопожатие с сервером.
**Не искать причину в нагрузке/таймингах:** оба «флейка» полного прогона оказались разными дефектами рукопожатия (п.48 — предикат сессий, п.49 — отсутствие `error`-слушателя), а не медленным железом. Диагностику (временные `ALTER SYSTEM SET log_statement='all'`, `log_connections`, вывод шагов в stderr) обязательно откатывать: изменённые настройки кластера меняют поведение прогонов и сами становятся источником ложных выводов.

## 50. Урок 27.11.2026 (Task 20): контракт отказов force transfer, «занятый навсегда» cycle_id и таблица, которой не было в плане

**Симптом 1:** после GREEN тест «stale destination revision» не падал, а **выполнял настоящий перевод** и портил состояние для следующих подтестов (следующий тест получал `truck-not-on-shift`).
**Причина:** в тесте ожидаемое значение было захардкожено как `1` в расчёте на то, что destination shift уже сдвинут предыдущими тестами. Фактически revision destination оставался `1`, то есть «устаревшее» значение совпало с текущим — команда честно выполнилась.
**Что делать:** в тестах не хардкодить ревизии/номера, а выводить их из фактического состояния (`await shiftRevision(shiftB) + 1`), иначе тест проверяет не то, что заявлено, и оставляет за собой мутации. Это правило уже действует для шаблонов и корней — теперь и для revision-полей.

**Симптом 2:** повторный force transfer при открытом detached trip отвечал `revision-conflict` вместо `409 truck-detached-trip-open` (§3.3 требует именно этот код).
**Причина:** проверка CAS по `status_revision` стояла раньше проверки открытого рейса. Клиент со слегка устаревшими счётчиками получал «поменялось», хотя настоящая причина — структурный инвариант: у машины уже есть незавершённый цикл чужой линии.
**Что делать:** порядок отказов фиксировать осознанно: сначала структурные инварианты (владелец status, открытый detached trip, незавершённый цикл), затем CAS-счётчики. Одинаковый порядок в `shift-trucks-v2.mjs` (remove) и `shift-transfer-v2.mjs` (force transfer); оба берут блокировки в одном порядке: shifts (по возрастанию id) → status → detached row.

**Симптом 3:** в одном модуле ожидался `shift-changed`, в другом `revision-conflict` при одинаковой природе ошибки.
**Причина:** контракт разный по смыслу команды: односменные команды (assign/remove/member/object) отвечают `409 shift-changed`, двухсменные (force transfer, completion) — `409 revision-conflict` с полем `expected*/actual*`.
**Что делать:** держать это разделение явно (`requireShiftChanged` vs `requireShiftRevision`) и не «унифицировать» коды задним числом: клиент различает их, чтобы решить, какую смену перечитывать.

**Симптом 4:** таблица `detached_open_trips` (миграция `028`) не была указана в плане Task 20, хотя read-контракт §5.1 (`readDetachedOpenTrips`) её уже ожидал.
**Причина:** план перечислял только модули и тесты; схема detached-сущности осталась в дизайне (§4.4), но не попала в список файлов задачи.
**Что делать:** при обнаружении такого разрыва расширять объём контролируемо и синхронно: миграция + реестр миграций + manifest/discovery (инвентарь корней) + read-контракт в одном коммите. Не подменять таблицу fixture-маркером и не «временно» читать JSON из другой таблицы.

**Симптом 5:** после создания 028 фикстура `parallel-shift-runtime-role` («runtime read-only») покраснела бы, если выдать новой таблице DML для `samosval_runtime`/`samosval_maintenance`.
**Причина:** у этих ролей нет DML на `shifts`, `line_logs`, `line_truck_statuses`; detached-таблица — операционная, а не evidence, и обязана жить по тем же правилам.
**Что делать:** новая операционная таблица не получает прав runtime/maintenance; `REVOKE ALL ... FROM PUBLIC` обязателен, права приложения выдаются штатным `grantTargetAccess` после клонирования. Evidence-таблицы (replica/archive) — отдельный, уже описанный путь.

**Отдельно про `cycle_id`:** PK detached-рейса `(workspace_id, source_shift_id, cycle_id)` не освобождается никогда (завершённая строка не удаляется). Поэтому id нельзя выводить только из состояния цикла: при совпадении `(cycleRevision, anchor)` у более позднего перевода будет конфликт PK. Id детерминирован для одной команды — в него входит хеш `operationId`, — и остаётся непрозрачным токеном для клиента.

## 51. Урок 27.11.2026 (isolated-db harness): корень S25 заимствовал «единственный шаблон кластера» и падал от остатка прерванного прогона

**Симптом:** полный прогон 92 корней даёт 91/92; единственный красный — `isolated-db-s25-fixtures`, `AssertionError: at most one S25 template may exist for one run`. В изоляции тот же файл зелёный.
**Причина:** корень искал шаблон запросом по всему кластеру (`datname ~ '^samosval_parallel_shifts_test_[a-f0-9]{12,20}_tpl_s25$'`) и требовал, чтобы такой шаблон был ровно один. Это не контракт, который может проверить ребёнок: runid ему не передаётся, а шаблон, оставшийся от **прерванного** прогона (снятый родитель не успел выполнить `dropTemplates`, который удаляет только шаблоны своего run), делает корень красным по причине, не связанной с фикстурами. Усугубляет картину то, что раннер помечает все неисполненные файлы как `failed`, поэтому прерывание прогона выглядит как «69 красных корней».
**Что делать:** ребёнок-контракт обязан доказывать контракт **на своих** артефактах. `isolated-db-s25-fixtures` теперь всегда строит свой S25 из исходников (как это уже делает `isolated-db-s26-fixtures`), а не берёт чужой шаблон по совпадению имени/комментария. Проверка самого шаблона живёт там, где он создаётся (`prepareTemplates` → `verifyS25Target` + `inspectTemplateSeal`) и во всех db-корнях с `baseline: S25`, которые его клонируют.
**Регрессия:** проверена фактом — при специально созданной «чужой» базе `samosval_parallel_shifts_test_aaaaaaaaaaaa_tpl_s25` корень остаётся зелёным (раньше падал на этом же условии).
**Отдельно:** прерывать официальный прогон (`pkill`) нельзя — это портит отчёт и оставляет шаблоны в кластере. Если прогон нужно остановить, сначала останавливать по-настоящему (сигнал родителю с ожиданием cleanup), а остатки прерванного прогона убирать точечно: `DROP DATABASE` только для конкретной базы-шаблона, у которой ноль сессий, и никогда `down -v` на общем кластере.

## 52. Урок 27.11.2026 (Task 21): v2-актор и доменный актор — разные формы одного человека

**Симптом:** после первого GREEN-прогона `v2-line-operations-db` четыре подтеста падали на `arriveBy`/`ttnBy`/`createdBy` = `undefined` вместо `'Line senior'`, хотя команда честно подтверждалась и ревизии двигались.
**Причина:** доменные правила `line-rules.mjs` (`applyLineOperation`) читают `actor.name`, `actor.email`, `actor.isAdmin`, `actor.canResetTimer`, а `shift-access-v2.loadActor` возвращает `{uid, displayName, role, status}`. Прямая передача `context.actor` в `applyLineOperation` теряет имя: поля `name` в объекте нет, JSON-лог сохраняет `undefined` (в `jsonb` оно просто исчезает), и падает не сама операция, а более поздняя проверка документа.
**Что делать:** в v2-обёртке строить отдельный доменный актор из профиля и уже выданного права: `{name: profile.displayName, displayName: profile.displayName, email, isAdmin: role==='admin', canResetTimer: true}`. `email` читать в той же транзакции (`SELECT email FROM app_users`), иначе канонический лог рейса теряет `createdByEmail`. `canResetTimer` можно ставить `true` только после того, как `authorizeShift` для `shift.line.reset` уже прошёл: это не второй слой прав, а форма, которую ждёт доменное правило.
**Проверка:** тест обязан смотреть не только `confirmed`/ревизии, но и сохранённый документ (`arriveBy`, `createdBy`, `createdByEmail`), иначе рассинхрон форм актора проходит GREEN.

## 53. Урок 27.11.2026 (Task 21): «прибытие» и «снял прибытие» — одна команда `arrive`, но не одно событие

**Симптом:** реализация ставила блокировку объекта на любую подтверждённую команду `arrive` (`type === 'arrive'`), и смена навсегда теряла право исправить объект после того, как прораб **отменил** ошибочно отмеченное прибытие (`wantArrived:false`, в интерфейсе «↩️ Снял прибытие»).
**Причина:** в домене это одна команда с двумя смыслами. Отмена очищает `arriveStatus/arriveTimestamp/arriveBy`, не создаёт рейса и не фиксирует работу. §3.1 привязывает лок к **факту работы**: «первый успешно подтверждённый `arrive`» и, для миграции, «есть `line_logs` либо статус содержит признак прибытия/погрузки». После отмены признака в строке нет — предикат не выполнен, лок был ложным.
**Что делать:** блокировку и подобные «необратимые» последствия ставить по предикату реально записанного факта, а не по имени команды: `type === 'load' || (type === 'arrive' && wantArrived === true)`. Проверять это отдельным подтестом **на свежей смене**: на уже залоченной смене «лок не появился» неотличимо от «лок был раньше».
**Отдельно про отсутствующее поле:** `line-rules.mjs` читает пропавший `wantArrived` как «приехал» (`op.wantArrived !== false`). v2-слой обязан сохранить эту трактовку (по умолчанию `true`), иначе клиент, не приславший поле, молча отменял бы прибытие — то есть отсутствие данных превращалось бы в действие.
**Регрессия:** доказана невакуумностью — при временно возвращённом старом условии новый подтест падает на `object_locked_at` (ожидали `null`, получили timestamp), остальные остаются зелёными.

## 54. Урок 27.11.2026 (Task 22): двухфазное закрытие — ACL не имеет права отвечать за домен закрытия

**Симптом 1 (поймано на разборе до прогона):** если оставить close-команды под общим жизненным гейтом, ломаются два контракта: повторный `prepare` после `finish` (тот же `operationId`/hash) не доходит до своего receipt, а новый `finish` на закрытой смене отвечает `410 shift-closed` вместо требуемого стабильного `409`. RED-тест Task 22 падает на обоих assertions, поэтому дыра не проходит незамеченной.
**Причина:** общий жизненный гейт `requireOpenLifecycle` (`shift-access-v2.mjs`) отдаёт `410` для любой команды на `closed`/`historical` строке. Для close-действий это неверный владелец решения: `410` приходит **до** чтения receipt, поэтому идемпотентный replay физически недостижим, а клиент получает другой код, чем обещает §5.5/§11.
**Что делать:** у действия в `SHIFT_ACTIONS` есть третий признак — `terminal: 'domain'`: ACL пропускает close-команды на терминальной строке (права, членство и существование смены всё равно перепроверяются), а `409 shift-closed` с `details.state` выдаёт домен закрытия. Не «унифицировать» это обратно в `410`: 410 — про недоступный ресурс, 409 — про фазу.
**Проверка:** отдельный подтест на закрытой смене (`prepare` → `409`, replay `prepare` → сохранённый результат) плюс расширение `v2-shift-access`: ACL обязан **пропускать** `shift.close.prepare/finish` на `closed`, иначе replay снова станет недостижим.

**Симптом 2:** «подтверждённый материал» легко превратить в поле payload, и тогда `finish` смены с рейсами проходит без подтверждения.
**Причина:** v1 читает материал из `tabel_records.payload.data.lineImports[shiftId]`, а v2-смена не имеет строки табеля; кроме того `expectedMaterialMarkerRevision: null` — это **значение CAS**, а не «поле не прислали».
**Что делать:** маркер — отдельная таблица `shift_material_markers` с PK `(workspace_id,shift_id)` (второй `finish` не создаёт второй перенос), а `null` в ожидании означает «маркера быть не должно». Пустая смена (`totalTrips = 0`) закрывается без маркера; смена с рейсами без маркера — `409 revision-conflict` с `expectedMaterialMarkerRevision/actualMaterialMarkerRevision`, а не тихое закрытие. Маркер обязан ссылаться на `source_archive_revision` и совпадать по объёму с опубликованным архивом.

**Симптом 3:** close token в payload не доказывает авторство: payload правится тем же `UPDATE`, что и токен.
**Причина:** `shifts_legacy_bridge` пропускает дополнительные ключи жизненного цикла, поэтому «токен в документе» — это просто ещё одно поле, которое можно переписать вместе с остальным.
**Что делать:** `close_token`/`close_token_operation_id` — явные колонки `shifts` (миграция `029`) с CHECK-парой и форматом; токен выводится из `(shiftId, next shift revision, archive candidate hash)` и сверяется с колонкой, а не с документом.

**Симптом 4 (пробел плана):** гейт `409 pending-operations` нечем построить: `shift_operation_receipts` (`sql/003`) не знает `shift_id`, поэтому незавершённый серверный receipt нельзя отнести к смене.
**Что делать:** в той же миграции добавить nullable `shift_id` + частичный индекс; `v2-command.mjs` пишет его, только если колонка есть (старые baseline без 029 продолжают работать прежним INSERT). `pendingReceiptsByShift` в `shift-read-v2.mjs` после этого можно включать — но это отдельная задача, в Task 22 гейт читает таблицу напрямую.

**Отдельно про порядок:** оба гейта (`pending-operations`, `detached-trip-open` по source ИЛИ destination) обязаны стоять **до** CAS-счётчиков, как и в force transfer (урок 50): устаревший клиент должен узнать настоящую причину, а не «поменялось».

## 55. Урок 27.11.2026 (Task 22, ревью): правило, которое нельзя выполнить через API, — не правило

**Симптом:** `finish` требовал подтверждённый material marker, но команды подтверждения не было: в тесте маркер писался прямым `INSERT`. Смена с рейсами не закрывалась ни одним production-путём — правило существовало только в тесте.
**Причина:** в плане Task 22 интерфейс назван как `prepare/material/finish`, но реализация сделала две фазы; «material-транспорт» отнесли к другой задаче. Task 27 атрибутирует производные данные источнику, он не создаёт close-фазу.
**Что делать:** каждая фаза жизненного цикла — это команда с `runV2Command`, authorization, receipt и CAS. Для маркера: `closeToken` сверяется с колонкой `shifts.close_token` до CAS; `expectedArchiveRevision` — с последней ревизией серии, и `latest_finalized_revision` обязан быть `NULL` (после публикации маркер не подтверждают); `expectedMaterialMarkerRevision: null` = «маркера нет» (INSERT), число = UPDATE с `revision+1`; `volume` не больше `totalVolume` опубликованного кандидата; одна строка на смену (PK).
**Проверка:** тест обязан доказывать реальный путь — подтверждать маркер командой, а прямой SQL оставлять только как проверку схемы (второй `INSERT` падает на PK). Если в тесте есть прямой `INSERT` в таблицу, которая должна меняться только командой, — это сигнал о пропущенной фазе API.

## 56. Урок 27.11.2026 (Task 28): гейт в коде не заменяет `shift_id` в `WHERE`

**Симптом:** инвентарь workspace-запросов (§12) нашёл три `UPDATE`/`DELETE` по `line_truck_statuses`, где в `WHERE` были только `workspace_id` и `truck_id`: `line-store-v2.mjs` (запись операции линии), `shift-trucks-v2.mjs` (`removeTruck`), `shift-transfer-v2.mjs` (force transfer). Поведенческой утечки не было — в каждом месте выше по коду стоит гейт (`existing.shift_id !== shiftId` → отказ), — но защита держалась на порядке строк в функции, а не на самом запросе.
**Причина:** одна строка на самосвал (`PK (workspace_id,truck_id)`) делает `truck_id` «почти уникальным», и `shift_id` в `WHERE` выглядит избыточным. Избыточным он перестаёт быть при первом же изменении схемы (история статусов, detached-строка, вторая строка на тот же самосвал) и при рефакторинге, который переносит гейт ниже запроса.
**Что делать:** все `UPDATE`/`DELETE` по сменным таблицам включают полный ключ `workspace_id AND shift_id AND truck_id` (design §4.2). Гейт остаётся — но как источник **понятного кода отказа**, а не как единственная защита. Проверка — trap-тест: снимок всех строк чужой смены (canonical JSON + SHA-256) до и после **каждой** операции, а не «до и после сценария».
**Невакуумность trap-теста обязательна:** если инвентарь не нашёл поведенческих нарушений, тест всё равно нужен, и его надо доказать поломкой. Проверено: убрать `AND shift_id=$2` из `DELETE FROM line_truck_statuses` в `shift-close-v2.mjs` (workspace-wide удаление) → `B canonical digest changed after: A close finish`, остальные 6 подтестов зелёные; условие возвращено.

## 57. Урок 27.11.2026 (Task 29C): тест, повторяющий ошибку кода, эту ошибку и прячет

**Симптом:** в приёмке 393×852 любой фоновый сбой одного источника данных (в прогоне — `nas-settings`) валил отрисовку всего экрана: `renderAll` падал с `TypeError`, вместо жёлтой точки синхронизации экран оставался пустым. Нашлось только в настоящем браузере на реальном стенде.
**Причина:** `getSyncStatus` (`03-formatting.js`) читал `syncState.ever_connected`, а поле называется `everConnected` — так его объявляет `00-config-state.js:256`, пишет `markSync` (`03-formatting.js:68`) и читает проверка `required` (`03-formatting.js:107`). Обращение к отсутствующему полю даёт `undefined`, а `undefined[source]` — `TypeError`. Юнит-тест `39-line-calm.test.mjs` этот дефект **не ловил, потому что сам конструировал** `syncState` с тем же неверным ключом `ever_connected`: харнес и код ошибались одинаково.
**Что делать:** в vm-харнесах состояние собирать по **фактическому объявлению** (`00-config-state.js`, `04-subscriptions.js`), а не по строке из проверяемой функции. Если тест подставляет объект руками, ключи брать копированием из реального объявления, иначе опечатка в коде становится «контрактом» теста. Отдельный сигнал: правка потребовала изменить и тест — значит тест фиксировал не поведение, а совпадение ошибок.
**Проверка:** после правки `39-line-calm.test.mjs` (13/13) конструирует `syncState` с `everConnected`; полный клиентский набор зелёный.

## 58. Урок 27.11.2026 (Task 29C): контракт тела команды нельзя брать из своего же теста

**Симптом:** принудительный перевод самосвала между сменами из клиента не работал никогда: сервер отвечал `400 invalid-command {field:'destinationShiftId'}`. В настоящем браузере это первый же вызов перевода.
**Причина:** `forceTransferTruck` в `41-v2-transport.js` отправлял смену назначения только в пути (`/api/v2/shifts/{destinationShiftId}/trucks/{truckId}/force-transfer`), а сервер (`shift-transfer-v2.mjs`, `transferShiftId`) требует её ещё и в теле и сверяет с путём. Клиентский тест `v2-transport.test.mjs` утверждал ровно «тело без `destinationShiftId`» — то есть закреплял ошибку как контракт. Серверный `v2-truck-transfer-db.test.mjs` при этом всегда клал поле в тело и был зелёным: две стороны тестировались порознь, стык — никем.
**Что делать:** эталон тела команды — серверный обработчик и его DB-тест, а не клиентский тест транспорта. Для команд, где смена есть и в пути, и в теле, проверять оба места одним утверждением («тело называет ту же смену, что путь»). Приёмка в настоящем браузере обязательна: только она вызвала перевод end-to-end и вскрыла расхождение.
**Замечание к design §5.4:** в спецификации поле `destinationShiftId` в теле force-transfer не перечислено, хотя сервер его требует. Расхождение зафиксировано; менять контракт сервера в этом выпуске не стал — правка клиента минимальна и совпадает с фактическим поведением сервера и его DB-тестом.

## 59. Урок 27.11.2026 (Task 29C): два закрытых whitelist'а деталей ошибки разошлись — клиент молча выбросил `actual*`

**Симптом:** сервер на конфликт ревизий отвечает `409 revision-conflict` с парой `expectedStatusRevision`/`actualStatusRevision` (`statusConflict` в `shift-trucks-v2.mjs`), а клиент получал только `expected*`. В приёмке 393×852 проверка «видно, какое число разошлось» падала на пустом месте.
**Причина:** обе стороны фильтруют `details` закрытым списком, и списки разошлись: `server/src/v2-errors.mjs` `DETAIL_KEYS` — 36 ключей, `working-test/source/core/41-v2-transport.js` `SAFE_DETAIL_KEYS` — 26. В клиентском не было ни одного `actual*`, ни `expectedMembershipRevision`/`expectedDetachedCycleRevision`/`expectedArchiveRevision`/`expectedMaterialMarkerRevision`/`shiftId`/`cycleId`. Проверено пробой: сервер отдаёт `expected 2 / actual 5`, клиент возвращает только `expected 2`. Тот же разрыв был и в журнале офлайн-очереди (`42-offline-v2.js`) — пара терялась и при разборе отложенных команд; списки приведены к одному (48 ключей: 36 серверных + 12 клиентских).
**Что делать:** закрытый список деталей должен быть **один по смыслу** на обеих сторонах. Клиентский список — это тот же серверный (числа, короткие id, булево; PII там нет по построению), и при изменении серверного его надо синхронизировать, а не поддерживать «свой, поменьше». Проверка — утверждение, что пара `expected*`/`actual*` доходит целиком, плюс сохранённое утверждение «телефон и e-mail не проходят».

## 60. Урок 27.11.2026 (Task 29C): «смена в пути» не значит «смена известна серверу»

**Симптом:** завершение переведённого рейса (`detached-trips/{cycleId}/complete`) из клиента не работало никогда: `400 invalid-command {field:'sourceShiftId'}`. Одновременно не работал и перевод самосвала (`400 invalid-command {field:'destinationShiftId'}`) — это тот же класс.
**Причина:** в обоих маршрутах смена есть в **пути**, и клиент считал, что этого достаточно. Сервер читает смену ещё и из **тела** и сверяет её с путём (`transferShiftId`, `completeDetachedTrip` в `server/src/shift-transfer-v2.mjs`): расхождение — `409 transfer-context-changed`, отсутствие — `400 invalid-command`. Дополнительно завершение требует обязательный `createdAt` (`requireTimestamp`), а модуль `46-detached-trips.js` его не передавал.
**Почему не поймали:** design §5.4 в теле этих двух команд поля не перечисляет (уточнение добавлено в спецификацию), а клиентский транспортный тест утверждал ровно то, что отправлял клиент. Серверный DB-тест всегда передавал оба поля и был зелёным. Стык проверяла только браузерная приёмка.
**Что делать:** для команд, где сущность есть и в пути, и в теле, тело — не «дубль для красоты»: сервер использует его как источник и сверяет с путём. Эталон — серверный обработчик плюс его DB-тест, а не клиентский тест. Проверять одним утверждением «тело называет то же, что путь» и отдельно — обязательные timestamp-поля.

## 61. Урок 27.11.2026 (Task 29C/45): форма данных в клиенте и в его тесте — не доказательство формы сервера

**Симптом:** три модуля клиента читали данные в форме, которую не отдаёт ни один серверный сериализатор:
- `46-detached-trips.js` ждал плоские `sourceObjectName/sourceWorkDate/sourceShiftType`, сервер отдаёт вложенный `sourceShift` (`shift-read-v2.mjs`, `shiftLabel`) → подпись рейса всегда «Объект не указан · Дата не указана · Тип смены не подтверждён»;
- `45-restored-archive.js` ждал provenance `{opener, openerResolution, restoringActor}` и ревизии `{archiveRevision, archiveSha256, publishedAt, finalized}`, сервер отдаёт плоские `originalOpenedByName/originalShiftType/authorText/unresolvedAuthor` (`restored-context-store.mjs`) и `{revision, sha256, createdAt}` (`archive-latest.mjs`, `toRevision`);
- `10-archive.js` сортировал ревизии по `Number(b.archiveRevision)`, у серверной формы поля нет → `NaN`, порядок списка оставался исходным.

**Почему не поймали:** форму придумывал сам тест-харнес (`revisions()` в `45-restored-archive.test.mjs`, объект provenance в приёмочном сценарии `tools/phone-parallel-shifts.mjs`). Тест и код договаривались между собой; серверный сериализатор в этой договорённости не участвовал. Оба набора тестов были зелёными.

**Что делать:** если модуль читает ответ сервера, эталон формы — серверный сериализатор (`toXxx`/`shiftLabel`/объект, который возвращает `store`), и в тесте нужна хотя бы одна запись **в точной серверной форме**, а не в удобной. Полезная проверка при ревью: `grep` по имени поля из клиента в `server/src` — если поле встречается только в клиенте и его тесте, форма выдумана. Так же надо смотреть на производные чтения (сортировка/фильтр), а не только на разбор: `NaN` в компараторе не падает, а молча оставляет список в порядке прихода.

## 62. Урок 27.11.2026 (Task 30): владелец таблицы без `USAGE` на `public` валит свои же RI-проверки

**Симптом:** на изолированной БД `INSERT INTO legacy_cutover_historicalization_audit` падал `42501 permission denied for schema public`, причём сообщение указывало не на целевую таблицу, а на проверку внешнего ключа: `SELECT 1 FROM ONLY "public"."shifts" ... FOR KEY SHARE`. Под суперпользователем и под владельцем схемы всё работало.
**Причина:** `scripts/parallel-shifts-role-bootstrap.mjs` делает `ALTER TABLE public.shifts OWNER TO samosval_schema_owner`, а `USAGE ON SCHEMA public` выдаёт только `samosval_runtime`. Referential integrity проверки выполняются **от имени владельца** таблицы, поэтому `samosval_schema_owner` должен уметь резолвить схему. В обычной БД это не видно: `public` создаётся с `GRANT USAGE TO PUBLIC`. Изолированный harness пересоздаёт схему сам (`DROP SCHEMA public CASCADE; CREATE SCHEMA public`) и выдаёт ACL явно, без `PUBLIC`, — там дырка и проявляется. Второй слой той же проблемы: пароли ролям выдаёт harness (`scripts/isolated-db/bootstrap.sql`), а `bootstrapParallelShiftRoles` в фазе role split делает их LOGIN — то есть роли в кластере есть ещё до любого шаблона.
**Что делать:** выдавать `GRANT USAGE ON SCHEMA public TO samosval_runtime, samosval_schema_owner, samosval_migration_evidence_owner` **внутри `bootstrapParallelShiftRoles`** (`server/scripts/parallel-shifts-role-bootstrap.mjs`) — там же, где выдаётся `USAGE` для `samosval_runtime`, и рядом с `ALTER TABLE ... OWNER TO samosval_schema_owner`, из-за которого это право и нужно. И не путать: `USAGE` на схему — не право на таблицы, оно нужно только чтобы имя таблицы вообще резолвилось; права на таблицы остаются как есть.
**Ловушка, в которую легко попасть (проверено на ревью Task 30):** первая версия лечения стояла в `server/scripts/maintenance-parallel-shifts.mjs`, то есть в репетиции, а не в бутстрапе. Репетиция зеленела, а реальное окно роль-сплит делает `parallel-shifts-role-bootstrap.mjs` — и на общей базе отказ `42501` оставался возможным, особенно если окно по §13 отзывает лишние права или схема пересоздаётся. Правило: лечение ставится в тот код, который выполняется в окне; репетиция обязана вызывать **тот же** путь без своих обходных `GRANT`. Невакуумность проверять так: убрать грант из бутстрапа → репетиция обязана упасть `42501`; вернуть → зелёная.
Проверять такие вещи прогоном на изолированной БД, а не на локальной: локальный `public` с дефолтным ACL маскирует ошибку.

## 63. Урок 27.11.2026 (Task 29C/30): схема 025 запрещает legacy-восстановление архива, а API отвечал 500

**Симптом:** на стенде после миграций до `029` восстановление архивной смены (`POST /api/v1/archive/operations`, `type:'archive.restore'`) отвечало `HTTP 500`, в логе API — `[archive-api] mutation failed 23514`. На базе без `025` то же действие работало.
**Причина:** `submitArchive` (`server/src/archive-store.mjs`, ветка `archive.restore`) вставляет в `shifts` v1-документ из `restoredLine()` без `payloadSchemaVersion`. Миграция `025` вешает на `shifts` триггер `shifts_legacy_bridge`, который на INSERT требует строгий v2-документ и бросает `protocol-upgrade-required` с `ERRCODE='check_violation'` (`23514`). API превращает неизвестный код в 500. Это не дефект миграции: design §4.7 прямо требует, чтобы canonical-восстановление создавало `restored_shift_contexts`, а не строку в `shifts`, и §3.4 — «restored archive не становится active shift». Замена есть только наполовину: `restored-context-store.mjs` правит уже открытый контекст, но создать его нечем — маршрутов `/api/v2/archives/**` в `v2-router.mjs` нет.
**Что делать:** на канонической схеме отказывать **честно и до любой записи** — `fail('archive-restore-requires-v2', 409)` сразу в ветке `archive.restore`, до запросов линии/объекта и до `INSERT`. Признак схемы — не «всегда отказывать», а наличие обеих канонических колонок: `information_schema.columns` для `shifts` содержит `state` и `payload_schema_version` (кешировать только положительный ответ: устаревший `false` после применения `025` опаснее лишнего запроса к каталогу). На S24 путь остаётся прежним. Тест обязан доказывать не только код отказа, но и постусловия: ни `shifts`, ни `line_logs`, ни `line_truck_statuses`, ни `archive_overrides`, ни receipt.
**Ловушка:** «работает на моей базе» здесь ничего не значит — общая база канала живёт без `025`, поэтому дефект виден только на схеме после окна обслуживания (или на стенде, который применяет миграции вперёд). Нашли его только браузерной приёмкой, ни один юнит-тест восстановление на схеме 025 не проверял.
**Следствие для выпуска:** включение флага параллельных смен (`WORKING_TEST_V2_SHIFTS`) блокируется, пока нет v2-маршрута восстановления архивной смены: после окна §13 функция перестаёт работать, а design §10.1/§10.2 требует её как часть продукта. На выпуск 1.8.7 это не влияет — там общая база без `025`.
**Обновление 27.11.2026:** v2-маршруты восстановления добавлены (`server/src/archive-restored-v2.mjs`, `GET /api/v2/archives/{archiveId}/restored`, `POST /api/v2/archives/{archiveId}/operations`). Legacy-ветка `archive.restore` по-прежнему отказывает `archive-restore-requires-v2` на схеме 025 — это осознанная граница, а не заглушка. Подробности и ловушки — урок 68.

## 64. Урок 27.11.2026 (Task 29C/26): подмена глобального рендерера — скрытый контракт, который ломает чужие секции

**Симптом:** в собранном канале модалка архива открывалась, бумажный лист рисовался, а секции «плашка архивной смены» и «история ревизий» были пустыми, хотя разметка (`#archiveProvenanceSection`, `#archiveRevisionHistory`), стили и код рендера на месте. В исходниках всё выглядело правильно, юнит-тесты `10-archive.js` были зелёные.
**Причина:** `features/paper-viewer.js` подменяет `window.openArchiveModal`/`window.renderArchiveModalContent` своим `renderFrozenArchive()`, который рисует только бумажный лист. Он ничего не знает про секции, которые `core/10-archive.js` заполняет в `renderArchiveModalContent`. Плюс `captureArchive()` собирал замороженный снимок без `record.provenance`, то есть даже при вызове рендерера данных бы не было. Ни один тест не проверял стык: тест `core/10` вызывал `renderArchiveModalContent` напрямую, а тест `paper-viewer` проверял только лист.
**Что делать:** если модуль подменяет глобальную функцию другого модуля, он обязан сохранить **все** наблюдаемые эффекты оригинала, а оригинал — публиковать нужные части наружу (`window.__wtRenderArchiveMeta`). Проверять такой стык двумя способами: юнит-тест на публикацию хука и тест на **реальном пути** (открыть модалку как пользователь и прочитать `textContent` секций). Вызывать хук всегда, а не только при наличии данных: без данных он обязан очистить прежний HTML, иначе после смены записи в модалке остаются данные прошлой.
**Ловушка:** «секции пустые» легко списать на отсутствие данных. Проверять надо по факту: подставить данные и посмотреть, доходит ли до них рендер. Здесь пусто было именно из-за перехвата, а не из-за пустого ответа.

## 65. Урок 27.11.2026 (Task 31A): сайт канала — отдельный репозиторий, а модули вне build тоже надо публиковать

**Симптом 1 (чуть не стал дефектом выпуска):** чек-лист 31A утверждал, что `https://iluxaspb.github.io/samosval-working-test/` собирается из ветки `release/working-test` этого репозитория. Фактически Pages настроен на ветку `root` (`gh api repos/iluxaspb/Samosval/pages` → `source.branch=root`), а сайт канала живёт в **отдельном** репозитории `iluxaspb/samosval-working-test` (ветка `main`, без workflow). Push в `release/working-test` — это запись источника выпуска, но не публикация: пользователь увидит новую версию только после коммита в репозиторий сайта.
**Симптом 2:** предыдущие выпуски копировали на сайт только `index-working-test.html`, `index.html`, `sw-working-test.js`, `version.json`, `working-test/build-manifest.json` и `working-test/build/<id>/`. Этого достаточно, пока не менялись модули, которые канал загружает **во время работы** динамическим импортом: `working-test/tabel-v2/*.mjs` (в сборке `core.js` есть `import('./working-test/tabel-v2/entry.mjs')`), `working-test/synology/*.mjs`, `working-test/src/*.js`. В 1.8.7 они изменились (`material-transfer.mjs`, новый `shift-attribution.mjs`, `session-client.mjs`), и на сайте остались старые копии: манифест 1.8.7 не сходился по SHA-256 на трёх ресурсах, а клиент после обновления исполнял бы старый код рядом с новым бандлом.
**Что делать:** перед публикацией сверять **весь** манифест сборки с деревом сайта, а не список из прошлого релиза: каждый `assets[].url` обязан существовать и совпадать по SHA-256 (`python3` + `hashlib` по `working-test/build-manifest.json`). Копировать не только `build/<id>/`, но и изменившиеся runtime-модули (`tabel-v2`, `synology`, `src`, `tabel`, `vendor`, `icons`). После публикации повторить ту же сверку по live-URL: 143/143 ресурса по HTTPS совпали, только тогда выпуск закрыт.
**Ловушка:** «сайт собрался, страница открылась» ничего не доказывает — старый `session-client.mjs` не имеет `requestV2`, и это проявилось бы только при включённом флаге v2, то есть через недели после выпуска.

## 66. Урок 27.11.2026 (Task 29C/47): зелёный модуль — ещё не экран; путь пользователя надо проверять отдельно

**Симптом:** транспорт v2 умел `forceTransferTruck` и `completeDetachedTrip`, модуль `46-detached-trips.js` умел `list/describe/complete`, все их тесты были зелёные. А в приложении не было ни крупного подтверждения перевода, ни блока «Рейсы, оставшиеся в прежней смене»: добавить занятый самосвал можно было только через `addTruckToLine` → `nasChangeMembership` (v1-команда `line.add`), которая на v2-сервере либо падала, либо вообще не доходила до ответа `truck-assigned-to-other-shift`. Приёмочный сценарий честно писал «экрана нет» и дёргал транспорт напрямую, поэтому разрыв не ловился.
**Причина:** тесты проверяли модуль, но не путь пользователя. Ни один тест не утверждал, что (а) экран добавления самосвала в режиме v2 вызывает v2-транспорт, (б) в разметке есть место под блок, (в) `renderAll`/событие снимка действительно зовут рендер блока. Три независимо зелёных звена не образуют цепочку.
**Что делать:** для каждой новой серверной команды проверять не только «транспорт умеет», но и «кнопка/экран вызывает именно его». Практическая проверка при ревью: `grep` имени метода транспорта по `working-test/source/core` и `features` — если он встречается только в своём модуле и тесте, экрана нет. В интеграционном тесте утверждать факты проводки: `modules.json` содержит модуль, в `shell.html` есть смонтированный узел, `renderAll` зовёт хук, обработчик добавления самосвала уходит в v2, а без моста хук скрывает блок и v2-функция удалена. Отдельно проверять, что занятый самосвал без права даёт предупреждение, а не мёртвую кнопку.
**Ловушка с подтверждением:** общий `showConfirmModal` фокусирует кнопку подтверждения и подтверждает по Enter. Для необратимого перевода это опасный default. Добавлены `focus:'cancel'` и `enterConfirms:false` (по умолчанию поведение прежнее), и тест проверяет именно переданные опции диалога, а не только текст.
**Ловушка с CAS:** у перевода и завершения рейса CAS кросс-сменный — нужны ревизии **обеих** смен и статуса. В окне, где вторая смена не загружена, нельзя «примерно» отправить команду: модуль честно отказывает `source-shift-unavailable`/`destination-shift-unavailable` и читает недостающий контекст только по нажатию, а не на каждой перерисовке. Тест обязан утверждать отсутствие вызова транспорта в этом случае.

## 67. Урок 27.11.2026 (включение канала): флаг по умолчанию — это новый рабочий режим для всех, а не «ещё одна галочка»

**Симптом (пойман до выпуска):** после решения владельца «включай параллельные смены в канале для людей» флаг `WORKING_TEST_V2_SHIFTS` стал `true` у всех сразу. Мост v2 при этом поднимается и там, где сервер v2 ещё не отвечает (старый сервер, нет маршрутов `/api/v2/**`, пропавшая связь). Его `onError` звал `reportSyncError('nas-shifts', …)`, а `getSyncStatus()` считает источник «упавшим», если он ни разу не отмечался в `syncState.everConnected`. Итог: на весь экран «Ошибка загрузки: nas-shifts» вместо обычной работы v1, а после одного сбоя связи — навсегда «Перечитываем: nas-shifts», потому что v1-источники снимают только свои записи в `syncState.errors`.
**Причина:** необязательная подсистема отчитывалась в общий индикатор так, будто без неё экран не работает. Проверки этого не видели: юнит-тесты транспорта фейкуют `request`, а флаг в приёмке инжектировался вручную поверх живого v2-стенда — состояние «флаг включён, сервера v2 нет» не проверял никто.
**Что делать:** у дополнительной подсистемы два правила. Первое: до первого успешного ответа её сбои идут только в консоль (однократно, без спама каждые 4 с) — экран в это время живёт на прежнем пути. Второе: первый успешный ответ снимает накопленную ошибку через `markSync(source,false,…)`, иначе предупреждение «Перечитываем: …» остаётся навсегда. Проверять поведением, а не регуляркой: `working-test/source/core/v2-bridge-default.test.mjs` грузит настоящий `21-nas-runtime.js` в vm и дёргает колбэки моста.
**Ловушка с самим включением:** «по умолчанию включено» нельзя делать перезаписью — стенд, приёмка и отладочное выключение выставляют значение до загрузки модулей. Поэтому в `working-test/source/shell.html` включение защищено `if (typeof window.WORKING_TEST_V2_SHIFTS === 'undefined')`, а сценарий «выключено» в `tools/phone-parallel-shifts.mjs` теперь получает `false` инжекцией `Page.addScriptToEvaluateOnNewDocument`. Тест проверяет именно поведение оболочки (по умолчанию `true`, заранее выставленное `false` не перезаписывается), иначе «защита» остаётся словом в комментарии.
**Остаточный риск (осознанный):** пока нет v2-маршрута восстановления архивной смены (урок 63), восстановление архива на канонической схеме после окна §13 отвечает честным `archive-restore-requires-v2`; история ревизий в канале не показывается вовсе (провайдер не инжектируется). Это ограничение функции, а не поломка экрана, но в отчёте о включении его надо называть.
**Обновление 27.11.2026:** v2-маршруты восстановления добавлены (урок 68), поэтому ограничение по восстановлению архивной смены снято до клиентской проводки. История ревизий в канале по-прежнему не показывается: серверного списка ревизий клиенту не отдают.
## 68. Урок 27.11.2026 (Task 26/v2-восстановление архива): домен уже имел транзакцию, а конверт команды — свою

**Симптом:** маршрутов `/api/v2/archives/**` не было, поэтому на схеме `025` восстановление архивной смены заканчивалось `409 archive-restore-requires-v2`; клиент (`41-v2-transport.js` → `readRestoredArchive`/`submitArchiveV2`) был готов, сервер — нет.
**Причина:** домен `restored-context-store.mjs` умел только править уже открытый контекст и сам открывал `BEGIN/COMMIT`, писал `restored_context_receipts`/`restored_context_audit`. Общий `runV2Command` тоже открывает транзакцию и пишет `shift_operation_receipts`/`workspace_service_audit` со своим JCS-`commandHash` по `{uid,workspaceId,shiftId,protocolVersion,operation,type,body}`. Два «владельца» транзакции и два разных хеша — прямой путь к двойному receipt и к ложному `operation-id-reused`.
**Что делать:** разделить домен на чистое мутирующее ядро `applyRestoredCorrection(client,...)` и обёртку `submitRestoredCorrection(pool,...)`, которая владеет транзакцией для legacy/report-пути. v2-маршрут вызывает то же ядро **внутри** транзакции `runV2Command` (никакого второго пути, CAS и доменный receipt остаются в ядре). `shiftId` для конверта берётся из `restored_shift_contexts.source_shift_id`: receipt архивной коррекции принадлежит исходной (архивной) смене, а не активной линии, и `shift_operation_receipts.shift_id` не имеет FK на `shifts`, поэтому архивная смена допустима. Доменный `commandHash` (sha256 от `JSON.stringify(op)`) и JCS-хеш runner'а живут каждый в своей таблице и не смешиваются.
**Ловушка 1 (форма тела):** клиент кладёт поля правки в `fields`, транспорт отправляет их **на верхнем уровне** тела (`volume/timeStr/comment/ttnStatus`), а не в `data`. Домен ждёт `command.data`. Принимать надо клиентскую форму и нормализовать в `data` на границе; иначе правка всегда `invalid-command`.
**Ловушка 2 (повторное открытие):** идемпотентность GET нельзя строить на «всегда INSERT + ON CONFLICT». Частичный unique-индекс разрешает только один `open`-контекст на архив, а «повтор» должен вернуть уже открытый контекст **с его собственной базовой ревизией**, даже если у серии появилась более новая: актуальность видна в `baseIsLatest`. Явно запрошенная несуществующая ревизия — `404 archive-not-found`, существующая, но не эта база — `409 archive-changed`.
**Ловушка 3 (FK на технику):** `restored_context_logs.truck_id` и `restored_context_status_snapshots.truck_id` ссылаются на `line_trucks`. Удалённая техника в архивном payload — честный `409 archive-truck-not-available` до вставки, а не 500 от FK.
**Ловушка 4 (тест на 025):** проверять надо не только «контекст открылся», но и что в `shifts`, `line_logs`, `line_truck_statuses`, `archive_overrides` не появилось ни строки, а receipt'ов ровно по одному на слой. Прогон на 25 не покажет `shift_operation_receipts.shift_id` (колонка из `029`) — для проверки атрибуции receipt'а база должна быть применена до `029`.
**Доказательство невакуумности:** снятый ACL в открытии контекста делает красным тест «открытие требует архивного права», снятая проверка `context_state='open'` — тест «finalized-контекст не правится». Оба прогона дали `# pass 6 # fail 1`, после возврата — снова `7/7`.

## 69. Урок 27.11.2026 (клиент v2-восстановления): маршрут и транспорт готовы — а кнопка всё ещё зовёт legacy

**Симптом:** серверные маршруты `GET /api/v2/archives/{id}/restored` и `POST /api/v2/archives/{id}/operations` уже влиты, `readRestoredArchive`/`submitArchiveV2` в `41-v2-transport.js` работают и покрыты тестами. А кнопка «♻️ Восстановить» в `10-archive.js` по-прежнему вызывала `nasArchiveAction('archive.restore')`, получала `409 archive-restore-requires-v2` и показывала «Восстановление недоступно». Пользователь на живом стенде видел отказ при полностью готовом сервере.
**Причина:** ровно та же, что в уроке 66, но на уровень выше. Тесты проверяли транспорт (`readRestoredArchive`/`submitArchiveV2`) и серверный домен по отдельности; ни один не утверждал, что **точка входа UI** выбирает v2-путь. Зелёные звенья снова не образовали цепочку: «транспорт умеет» ≠ «кнопка вызывает».
**Что делать:** при появлении серверного маршрута сразу проверять три точки: (1) `grep` имени метода транспорта по `core/` и `features/` — если он встречается только в своём модуле и тесте, UI его не зовёт; (2) ветка в обработчике кнопки включается только при живом мосте (`nasRestoredV2Ready()` = мост + флаг), иначе остаётся прежний честный отказ; (3) тест утверждает проводку (`nasRestoredV2Ready` → `nasRestoreArchivedShift`) и поведением прогоняет runtime с подменённым транспортом.
**Ловушка «Вернуть в архив»:** в домене есть `finalizeRestoredContext`, но HTTP-маршрута финализации в `v2-router.mjs` нет. Соблазн — переиспользовать `nasCloseCurrentShift`, как для v1-restored-смены. Для v2-контекста это неверно: в `shifts` такой смены нет, закрытие либо упадёт, либо создаст фейковое состояние «смена вернулась». Правильно — честно сказать «в архив она не вернулась» и **не** публиковать ревизию. Признак проверки: после отказа `context_state` остаётся `open`, число `shift_archive_revisions` не меняется.
**Ловушка формы даты (уточнена стендом 393×852):** `work_date` приходит из pg как `date`, и в JSON это мгновение, а не `YYYY-MM-DD`. Принимать ISO-мгновение мало: дату смены **нельзя** брать как UTC-дату мгновения. node-pg собирает `date` как полночь в зоне сервера, поэтому на сервере в UTC+3 дата `27.11` уходит как `2026-11-26T21:00:00.000Z`, и `toISOString().slice(0,10)` даёт `26.11` — карточка показывала день раньше, а юнит-тест с `2026-11-27T00:00:00.000Z` этого не ловил (для UTC-сервера он проходил). Правило: ровно полночь UTC — это уже дата смены (её берём как есть), любое другое мгновение переводим в московскую дату через `Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow'})` — тем же вызовом, что и `15-shifts.js` при закрытии смены. Тест обязан проверять значение, которое реально приходит со стенда (`…T21:00:00.000Z`), `Date`-объект и независимость от `TZ` машины (отдельные процессы с `TZ=UTC/New_York/Tokyo/Moscow`).
**Ловушка cross-realm даты:** `value instanceof Date` ложно для `Date` из другого realm (iframe, `vm`), и дата молча превращается в `null`. Проверять форму надо по `Object.prototype.toString.call(value) === '[object Date]'` — иначе тест и прод расходятся в поведении.
**Ловушка правок restored-рейса:** рейс живёт в `restored_context_logs`, а не в `line_logs`. `nasReportAction('report.update'/'report.delete')` должен распознать его по id (`nasRestoredContextForLog`) и уйти в `submitArchiveV2`, иначе v1-команда либо не найдёт рейс, либо при совпадении id адресует чужую активную смену. CAS (`expectedContextRevision`/`expectedBaseArchiveRevision`/`expectedBaseSha256`) берётся только из фактически прочитанного контекста, а `operationId` фиксируется до первого запроса — повтор после `archive-changed` идёт с тем же id и не создаёт вторую операцию.
**Ловушка конверта команды (нашёл стенд 393×852 на следующем шаге):** `submitArchiveV2` — это `command()` из `41-v2-transport.js`, он возвращает ПЛОСКИЙ конверт `{ok, operationId, replayed, retried, result}`. Чтение `response.data.result` даёт `undefined`, `applyResult(card, {})` ничего не меняет: HTTP 200, ошибки нет, на экране старые значения, а тест зелёный, если фейковый транспорт повторяет ту же неверную форму. Правило: в фейковом транспорте нельзя пересказывать свой же код — надо поднимать НАСТОЯЩИЙ транспорт и подменять только `request` (HTTP-границу), возвращая ровно тот конверт, что отдаёт сервер (`{protocolVersion, operationId, replayed, result}`). И проверять отсутствие `result` как ошибку: молча «применить пустоту» — худший исход, пользователь видит «сохранено», а данных нет.
**Ловушка формы тела операции:** поля операции лежат на верхнем уровне тела (`{operationId, type, recordId, volume, timeStr, comment, ttnStatus, expected*}`), сервер читает `command.data.ttnStatus`; вложенного `fields` на проводе нет (транспорт его разворачивает). Фейковый транспорт, принимавший `input.fields`, маскировал это.
**Ловушка тестового харнесса:** `src.indexOf('function nasV2Shifts')` находит `nasV2ShiftsEnabled` (префикс имени). Извлечение функций по имени должно якориться на `(?:async\s+)?function\s+<name>\s*\(`, иначе тест молча берёт не ту функцию. Это тестовая ловушка, но она маскирует отсутствие проводки.
**Доказательство невакуумности (откат каждой правки):** снятый CAS в `commandFor` → красные 6 тестов; `restored=null` в `nasReportAction` → красный тест проводки; `if(false)` вместо `nasRestoredV2Ready()` → красный тест кнопки; удалённый `nasRestoredFinalizeText` в `closeRestoredShift` → красный тест возврата; `FINALIZED_NOTICE` вместо `FINALIZE_UNAVAILABLE` → красные 2 теста финализации; возврат старого разбора даты (`toISOString().slice(0,10)` для мгновения) → красные 3 теста даты. После возврата — снова 32/32.

## 70. Урок 28.11.2026 (синхронизация «долго висит»): сервер отдавал мегабайты на каждый опрос, а условный запрос всё равно собирал ответ

**Симптом:** владелец: «очень долго синхронизируется автомат монет, табель и всё остальное, кроме линии». На стенде (393×852) одно вращение автомата занимало 3,4–3,7 с, чужое вращение появлялось через 6,5–8,5 с, пять открытых телефонов за минуту скачивали 17,9 МБ и получали `500`/`503` (пул соединений 5 штук переполнялся, CPU API 22,7%).
**Причина — три слоя, все измеримые:**
1. `GET /api/v1/games` отдавал 2,8 МБ, `GET /api/v1/auxiliary` — 3,5 МБ (2586 и 3602 записи). Это весь журнал, целиком, на каждый опрос каждого телефона.
2. `sendJson` считал ETag **после** полной сборки и сериализации ответа: `304` экономил трафик, но не работу. Сервер всё равно пересобирал мегабайты JSON, а Node однопоточный — остальные запросы (табель, линия, погрузка) стояли в очереди. Замер: 4 одновременных тяжёлых чтения растягивали лёгкий `GET /session` с 16 мс до 1534 мс.
3. Caddy не сжимал ответы (`encode` не задан): 3,5 МБ уходили как есть.
**Что делать:**
- Версия данных = `reserve_outbox_cursor.last_sequence`. Его поднимает триггер `reserve_outbox_capture_row` на каждой записи таблиц данных (игры, линия, архив, настройки, табель, пользователи, права), поэтому «версия та же» = «данные те же». Пока версия не изменилась, ответ берётся из памяти сервера, а `If-None-Match` получает `304` без сборки тела.
- Тяжёлую часть снимка (записи раундов, журнал) сериализовать **один раз на версию** и переиспользовать для всех пользователей; по роли/пользователю склеивать только лёгкую часть (свои поправки монет, плагины и патчи по роли). Ответ при этом обязан совпадать байт-в-байт с прежним — проверяется тестом `snapshot-text.test.mjs` на всех пяти ролях.
- `encode zstd gzip` на прокси: 2,9 МБ игр → 193 мс вместо 749 мс, 3,7 МБ журнала → 245 мс вместо 692 мс (в 8–10 раз меньше байт по сети).
- Итог замера после правки: 5 телефонов за минуту — 3,6 МБ вместо 17,9 МБ, ноль ошибок `500/503`, CPU 3,9% вместо 22,7%, чужое вращение видно через 6,5 с (упёрлось в 4-секундный интервал подписки линии, а не в сервер).
**Ловушки:**
- Считать `304` доказательством дешёвого запроса нельзя: заголовок `ETag` в прежнем `sendJson` формировался уже после полной работы. Проверять надо время **сервера**, а не размер ответа.
- Кэш по `uid` для журнала бессмыслен: он одинаков для всех ролей, а `plugins`/`patches` — нет. Кэшировать надо общую часть, а ответ собирать по роли; иначе либо утечка чужих данных, либо промах кэша на каждом пользователе.
- `publicAuxiliary` вычищает служебные поля (`password`, `token`, `secret`, `maxUrl`, `maxChatId`) рекурсивно по 3,5 МБ. Проверять наличие таких полей один раз при сборке снимка, а не на каждый запрос: иначе экономия съедается фильтрацией.
- Локальный Node на сервере — 18, а проект требует 22: на 18 часть тестов падает (`crypto is not defined`) и общий прогон висит. `tools/verify-working-test.py` теперь принимает `SAMOSVAL_NODE_BIN` и прямо говорит, если Node старее 22.
- Проверка истории релиза считала версию ещё и в заголовке `window.WORKING_TEST_RELEASE` и требовала «ровно одну» — на любой версии это давало ложную ошибку. Считать версии только внутри массива `releases`.
- Механизм версии данных (`reserve_outbox_cursor` + триггер `reserve_outbox_capture_row`) создаётся **вне репозитория** — это часть резервной репликации на сервере, в `server/sql` его нет. Поэтому в `dataVersion` обязателен честный `catch` → `null`: без счётчика кэш просто выключается, а снимок собирается как раньше. Проверка на чистой базе из миграций: `snapshot-cache.test.mjs` (случай `broken`) и прогон `node --test` на базе 001–024.
- Покрытие триггером проверяется отдельной операционной командой `node server/scripts/check-snapshot-version.mjs` на настоящей базе: она печатает версию и список таблиц снимка без триггера. Запускать после миграций и при добавлении новых таблиц в снимок. В канале на 28.11.2026: версия 17022, триггер на 39 таблицах, пропусков нет.
- Изолированный DB-раннер (`scripts/test-isolated-db.mjs`) требует отдельную роль `samosval_test_orchestrator`, маркер кластера и адрес `postgres`/`127.0.0.1`: на общем рабочем кластере он падает на preflight «admin preflight failed closed» и это правильно. Локально те же файлы гоняются напрямую `node --test` на базе нужного baseline (для `game-store`/`auxiliary-store` это S24 + фикстура `import-schema`), а полноценный прогон раннера делает CI-джоб `synology-server-tests`.
**Доказательство невакуумности:** тест `snapshot-cache.test.mjs` проверяет, что пять одновременных запросов собирают снимок один раз и что `304` не вызывает сборку; тест `snapshot-text.test.mjs` — что ответы для всех пяти ролей байт-в-байт равны прежним, а служебные поля плагинов не уходят непривилегированным.

**Дополнение 1.9.1 (28.11.2026): где осталась работа после первого ускорения.** Замер по частям показал три оставшихся «горячих» места, и все три — не про базу, а про лишнюю работу в JS:
- `presentLineHistory` на 300 строк стоил 147 мс, потому что на каждую строку вызывался `new Date(x).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})`. Node каждый раз строит форматтер заново (0,33 мс на строку). Готовый `Intl.DateTimeFormat` с теми же опциями даёт ту же строку за 0,002 мс: 147 мс → 4 мс на снимок. Правило: в горячих путях (журнал, аудит, раунды автомата) держать один форматтер в модуле `server/src/moscow-time.mjs` и проверять совпадение с прежним вызовом тестом — формат даты уходит в приложение строкой, любое расхождение видно пользователю.
- Очистка журнала от служебных полей (`publicAuxiliary` по 3,5 МБ) выполнялась на каждый запрос каждого неадминского пользователя. Теперь она считается один раз при сборке снимка (`publicAuditText`/`publicNotificationsText`), а по роли склеивается только лёгкая часть. Экономия — десятки миллисекунд блокирующего CPU на каждый опрос, то есть именно то, из-за чего «всё остальное» ждало.
- Пять одновременных вращений автомата поднимали версию данных пять раз, и каждая сборка шла для своей версии. `sharedValue` теперь запоминает самую новую версию, которую уже кто-то ждёт: следующая сборка идёт сразу для неё, а не для промежуточных. Данные при этом только свежее (счётчик версии не убывает). Замер: 5 вращений → 2 сборки вместо 5.
**Ловушка локального DB-прогона (важно для следующего раза):** `game-store.test.mjs` вставляет смену «legacy» без `payloadSchemaVersion`, а миграция `025_parallel_shifts_core.sql` такой INSERT запрещает (`protocol-upgrade-required`). Поэтому база для прямого прогона должна быть собрана миграциями 001–024 (`MIGRATIONS_EXCLUDE=018_auth_credentials.sql,025_…,026_…,027_…,028_…,029_…`). Если взять шаблон `samosval_test_clean` (копия рабочей базы, где 025 уже применена), тест даёт 5 красных — и это не регрессия кода: на неизменённых исходниках результат тот же. Проверено: на базе 001–024 `game-store` 8/8, `auxiliary-store` на базе с импортом 3/3.
**Замер на 1.9.1 (живой канал):** `GET /games` 200 → 304 за 40 мс, `GET /auxiliary` 200 → 304 за 80 мс, повтор с ETag в браузере 7 мс против 235 мс у прежнего образа. Пять одновременных вращений: p50 1,2 с на запись (одна сборка на всех) вместо 5×1,1 с последовательно.
**Ловушка повторного браузерного прогона (1.9.2):** сценарий с одной и той же машиной на стенде не повторяем: после первого прогона у самосвала остаётся статус «приехал/загружен», и следующий прогон честно получает «уже учтено» или пустой `arriveStatus` — это не ошибка релиза, а грязное состояние стенда. Перед повторным прогоном чистить `line_truck_statuses` рабочей области на QA-базе (или брать новую машину). Проверено: после очистки тот же прогон даёт 14/14.
**Найденный и исправленный дефект 1.9.2:** номер версии в шапке приложения был обычным `span` — обработчик истории вешался только на первый `.version-text` (номер на экране входа). После входа нажатие на версию ничего не открывало, хотя правило требует обратного. Исправление: в кнопку превращается каждый `.version-text`; проверка `release-history-click.test.mjs` поднимает модуль в маленьком DOM и требует, чтобы каждый номер версии открывал историю, а без права — был выключен. На старом коде тест красный (2 из 4), на новом — зелёный.

## 71. Урок 28.11.2026 (включение v2-смен): две жалобы владельца — два разных корня, оба вне «линии»

**Симптом:** с включённым `WORKING_TEST_V2_SHIFTS=true` (1) после прибытия погрузка отвечала «⚠️ Погрузка уже учтена или прибытие изменилось. Лишний рейс не добавлен», HTTP 409, рейс не появлялся; (2) экран мини-игр не открывался или сам закрывался через секунду после открытия.

**Корень 1 — ревизии статуса разъехались.** v2-снимок отдаёт `cycleRevision`/`ttnRevision` из нормализованных колонок `line_truck_statuses`, а доменные правила (`applyLineOperation`) сравнивают те же поля **в payload**. v1-путь операций линии (`line-store.mjs`), а также `history-store`, `control-store`, `replica-heads` обновляли только `payload`. Колонка оставалась старой, клиент брал её из снимка, отправлял в CAS — и получал честный 409 на ровном месте. В QA-базе это было видно построчно: `payload.cycleRevision=4`, `cycle_revision=1`, следующая погрузка `rejected / duplicate-or-arrival-changed`.
**Что делать:** инвариант «payload и колонки совпадают» должен быть свойством таблицы, а не соглашением между хранилищами. Миграция `030_line_status_payload_mirror.sql`: `BEFORE INSERT OR UPDATE` выводит `cycle_revision`/`ttn_revision` из payload, если там корректное положительное целое, плюс одноразовый backfill. Явные значения v2-хранилищ совпадают с payload, поэтому для них триггер — no-op. Payload без ревизии или с нечисловым значением колонку не трогает: иначе легаси-импорт и восстановление резервной копии стали бы невозможны. Проверка — `server/tests/line-status-mirror-db.test.mjs` (INSERT без колонок, v1-обновление только payload, нечисловая ревизия, отсутствие ревизии, конфликт «колонка против payload»).
**Ловушка:** «поправить v1-хранилище» — не решение. Писателей payload несколько (операции, история/undo, control, replica, восстановление архива), и каждый новый забыл бы bump. Триггер закрывает всех сразу и переживает будущие пути записи.

**Корень 2 — проекция смены не отдавала старому коду его поля.** `projectActiveContextToLegacyState` копировал v2-снимок как есть: `state`, `workDate`, `shiftType`, `openedAt`, вложенный `payload`. Старый код читает плоские `isActive`, `closing`, `startDate`, `workShift`, `startedAt`. Поэтому `RoadArcade.available()` (`state.shift?.isActive===true`) считал смену закрытой и закрывал/не открывал экран игр; отчёты печатали пустую дату; `analytics-v2` считала длительность от `undefined`; авто-бэкап не видел активную смену.
**Что делать:** проекция обязана быть надмножеством v1-формы. `legacyShiftView` дополняет только отсутствующие поля: `isActive = state==='active'||state==='closing'`, `closing = state==='closing'||payload.closing`, `startDate` из payload или из `workDate` (ДД.ММ.ГГГГ), `workShift/type` из `shiftType`, `startedAt` — **миллисекунды** (`payload.startedAt` или `Date.parse(openedAt)`), потому что analytics вычитает его из `Date.now()`. Значения v2 не перезаписываются. Тесты — в `shift-contexts.test.mjs`.

**Ловушки проверки (чтобы не принять норму за дефект):**
- Пока открыты две смены, v1-чтение линии честно отвечает `409 multiple-active-shifts` (линия одна по контракту v1, владельца сервер не угадывает). Клиент v2 это игнорирует и ведёт линию из v2-моста, но браузер пишет «Failed to load resource: 409» в консоль. Это доменный ответ, а не `pageerror`.
- Добавление занятого самосвала — это `409 truck-assigned-to-other-shift`, повод показать крупное подтверждение перевода; следом идёт успешный `force-transfer`. Считать этот 409 сбоем нельзя.
- Админ создаёт смену **без участия** (design §3.2): прораб видит только смены, где он участник. «Прораб не видит смену» после создания админом — не дефект; сначала добавьте его в лист управления.
- Перевести самосвал с незавершённой ходкой нельзя: сервер отвечает `truck-detached-trip-open`. Сначала завершить рейс (ТТН) или оформить переведённый рейс. В прогоне это выглядело как «перевод не сработал», хотя это правило домена.

**Доказательство:** QA-стенд (`samosval_test_qa`, API 18093, статика 4181), браузер 393×852, два сценария: линия + игры — 14/14; параллельные смены (создать A, добавить самосвал, закрыть ТТН, создать B, добавить прораба в обе, перевести самосвал A→B, проверить A без машины, перезагрузку, прораба) — 14/14, ноль `pageerror`, ноль неожиданных HTTP-ошибок. До правок те же сценарии давали 409 «уже учтена», закрытый экран игр и отказ перевода.

**Дополнение к уроку 71 (выпуск 1.10.0, 28.11.2026): три ловушки CI для нового DB-корня.**
- **`permission denied for schema public` при зелёном локальном прогоне.** Причина не в тесте, а в правах: db-ребёнок раннера работает ролью `samosval_test_app`, а `applyMigrations()` начинается с `CREATE TABLE IF NOT EXISTS schema_migrations` — PostgreSQL проверяет право `CREATE` на схему **даже когда таблица уже есть**. Поэтому корень, который сам ставит миграции, обязан объявить `env: ['bootstrap-url']` в `bootstrapEnvByFile` (`tests/db-test-manifest.mjs`); тогда DDL идёт привилегированным соединением, а проверки — прежней app-ролью. Локальный прогон этого не видит, если база создана владельцем: там app-роль совпадает с владельцем.
- **Порядок фикстуры и 025.** `seedParallelShiftFixture` пишет смены в форме 024 (без `payloadSchemaVersion`), а `025_parallel_shifts_core.sql` такой INSERT запрещает (`protocol-upgrade-required`, code 23514). Правильный порядок: `applyMigrationsThrough(24)` → фикстура → `applyMigrationsThrough(25)` → создание расхождения → `applyMigrationsThrough(30)`. Проверять сам триггер надо app-ролью: v1 line-store тоже пишет ею, иначе тест докажет работу триггера только для админа.
- **Объявленный env легко положить не в ту таблицу.** В `db-test-manifest.mjs` рядом две похожие записи: `bootstrapEnvByFile` (для `kind: 'db'`) и карта `env` внутри `harnessEntries` (для `harness-contract`). Запись в неверную молча даёт `env: []` — CI падает, локально всё зелено. Проверять фактические метаданные: `node -e "import('./tests/db-test-manifest.mjs').then(m=>console.log(m.default.entries.find(x=>x.file==='tests/<файл>').env))"`.

**Итог выпуска 1.10.0:** канал `working-test` включает v2 по умолчанию; сборка `4641caba5c605cd0`, 143 ресурса; `synology-server-tests` (run 46107062419) зелёный полностью; опубликовано в `iluxaspb/samosval-working-test`, live-проверка: `version.json` = 1.10.0, страница и SW совпадают, 143/143 SHA-256 в RECORDS и manifest сходятся, браузер 393×852 — ноль ошибок страницы и запросов.

**Дополнение к уроку 71 (28.11.2026): строгий режим «только v2» — не переключатель, а незакрытая часть плана.**
**Симптом:** на стенде поднял API с `SAMOSVAL_V2_SHIFTS=1` (сервер отвечает `426 protocol-upgrade-required` на `line/snapshot`, `line/operations`, `history`, `report/operations`, `archive/operations`, `controls`, `shifts/start|close`) и прогнал обычные сценарии: линия пустая, «прибытие» и «погрузка» не подтверждаются, в консоли поток `NasClientError: api-http-426`, история и отчёты не открываются.
**Причина:** v2 закрывает чтение и запись линии, но заменить их пока нечем:
- линия читается из `GET /api/v1/line/snapshot` (`subscribeLine` → `readLine`), а v2-мост ведёт только список смен и снимок выбранной смены;
- операции линии (прибытие/погрузка/ТТН/сброс) и повтор офлайн-журнала идут через `client.submitLine` → `POST /api/v1/line/operations`, хотя `submitLineV2` в транспорте есть и никем не вызывается;
- `GET /api/v1/history` (отмена/повтор) и `POST /api/v1/report/operations` (правки отчёта) маршрутов v2 **не имеют вообще** — в `src/v2-router.mjs` таких путей нет.
**Что делать:** не включать `SAMOSVAL_V2_SHIFTS=1` на канале, пока не закрыты три вещи: запись линии и повтор журнала через `submitLineV2` (с `expectedShiftRevision` из контекста смены и `expectedStatusRevision` из снимка), замена v1-чтения линии на снимок выбранной смены, и v2-маршруты истории/отчёта. Порядок проверки — сначала стенд со строгим флагом и те же два браузерных сценария, только потом переключение API.
**Ловушка:** «включить флаг и посмотреть» на рабочем канале нельзя: клиент в строгом режиме не просто показывает ошибку, а кладёт каждую операцию в dead-letter как `protocol-upgrade-required` — очередь после этого надо чистить вручную.

## 72. Урок 28.11.2026 (working-test 1.10.1): при включённом v2 нельзя опрашивать legacy single-line снимок

**Симптом:** при двух активных сменах приложение правильно показывает выбранную v2-смену, но в консоли остаётся HTTP 409 на `GET /api/v1/line/snapshot`; временный отказ старого интерфейса также может засорять первичную диагностику.
**Причина:** v1-механизм подписки продолжает читать единый снимок линии каждые 4 секунды, хотя владение линией уже перешло к v2-мосту. Первое чтение может успеть получить 409 до ответа v2; дальше повторять его нет смысла. На старом сервере v2-маршрутов может не быть, поэтому безусловно отключать v1 нельзя.
**Что делать:** когда v2 включён, не читать legacy-снимок с начала запуска моста; если v2-маршрут отвечает unsupported (404/405/426/501), оставить legacy-чтение как совместимый путь. Отказ `multiple-active-shifts` считать окончательным для legacy-подписки данного запуска. Регрессия покрывается тестом политики `subscribeLine` и браузерным счётчиком HTTP/console ошибок.
**Дополнительно:** сценарии QA с повторно используемыми сменами должны ждать фактическую готовность всех вкладок и выбирать смену по ID/явно. Роль участника параллельной смены ограничена `foreman`/`senior_foreman`; `master` и `lopater` получают ожидаемый `invalid-member-role`.

## 73. Урок 28.11.2026 (working-test 1.10.2): «Последнее действие» было общим на все смены, а рендер полосы живёт не там, где кажется

**Симптом:** при двух открытых сменах зелёная полоса в шапке показывала прибытие на объекте A и после переключения на объект B. Уведомления разных смен смешивались, и владелец не мог понять, к какому объекту относится действие.

**Причина:** полоса брала самую свежую запись из общего журнала `state.notifications`, не глядя на `shiftId`. Сами записи смену уже знали (`offlineNotifyAccepted`, `server/src/auxiliary-store.mjs`), но фильтра не было.

**Ловушка первая (главная):** `renderStatusTicker` объявлен дважды — в `core/18-line-ui.js` и в `features/ticker-name.js`, причём второй загружается позже и перетирает первый. Правка «правильного» места в ядре не даёт никакого эффекта в браузере, а юнит-тесты по тексту исходника при этом зелёные. Если меняете полосу — правьте `features/ticker-name.js` и проверяйте именно его; тест `ticker-per-shift.test.mjs` держит оба файла вместе, чтобы расхождение не вернулось.

**Ловушка вторая:** «точка непросмотренного действия» не должна появляться после действия в **выбранной** смене — полоса его только что показала, значит оно просмотрено. Проверять точку можно только действием в **другой** смене (второй телефон/контекст). Первый браузерный прогон с ожиданием «точка на A после действия в A» был неверным тестом, а не дефектом кода.

**Ловушка третья:** отметку просмотра нельзя писать на каждом перерендере — она сдвигается вперёд и точка гаснет сама. Писать только когда `lastActionAt(shiftId) > seenAt(shiftId)`, то есть когда в выбранной смене действительно есть новое действие.

**Ловушка четвёртая:** тест истории релизов был привязан к **текущему** номеру версии (`metaVersion`) и требовал в первой записи слова «параллельные смены» и «перевод». Это верно только для выпуска 1.10.0; на первом же следующем выпуске CI покраснел. Проверку выпускного текста надо привязывать к его версии (`{version:'1.10.0'`), а совпадение первой записи с текущей версией уже держит отдельный тест синхронизации.

**Что сделано:** `lastValidNotification` отбирает записи по `shiftId` выбранной смены (запись без смены в конкретную смену не попадает); заголовок полосы при двух и более сменах называет объект; вкладка чужой смены получает точку `.shift-tab-action`, которая гаснет при выборе смены; отметки просмотра лежат на устройстве (`samosval-wt-shift-seen-v1:<workspace>:<uid>`), серверные уведомления и журнал не менялись.

**Доказательство:** QA-стенд, браузер 393×852, два контекста (два устройства): 15/15 шагов — полоса A, переключение на B без чужого действия, точка на A после действия со второго устройства, возврат на A с погасшей точкой; ноль `pageerror` и ноль HTTP-ошибок. Штатные прогоны: сценарии 15/15, параллельные смены 13/13, четыре пользователя 10/10. Юнит/доменные тесты канала — 550/550. `tools/verify-working-test.py` — УСПЕШНО.

## 74. Урок 28.11.2026 (working-test 1.10.3): интерфейсная полоса перекрывает модалки, общая офлайн-основа смешивает смены, а большой кеш блокирует действия

**Симптомы:** полоса смен висела у последней карточки и перекрывала окно выбора самосвалов; после перерисовки появлялись карточки другой смены или линия мигала «Нет машин»; при большом архиве телефон отказывал в сохранении погрузки из-за переполнения памяти; при открытых сменах нельзя было создать объект прямо из листа.

**Причины:** `.shift-strip` имела `sticky` и `z-index:10050` против `.modal` с `z-index:100`, но фактически находилась в конце потока документа; `offlineProjectState()` строила каждую смену от единственной глобальной `offlineRemoteStatuses`, куда могли попасть данные подтверждённого действия соседней смены, и снимок выбранной v2-смены не всегда обновлял эту основу; `saveCache()` дублировал в localStorage все рейсы архива, корзину и восстановленные смены, а при QuotaExceeded молча не освобождал место для журнала; форма создания смены позволяла выбрать только уже существующий объект.

**Что сделано:** полоса стала `fixed` над нижним меню (`bottom:56px`) и ниже модалок (`z-index:60`); высота резервируется внизу документа. Офлайн-проекция фильтрует статусы по `shiftId`, принимает снимок выбранной смены как новую основу, чужие подтверждённые действия в неё не подмешивает, а старые строки v1 без `shiftId` сохраняет при отсутствии строк со сменой. Форма смены получила «➕ Новый объект…» с проверкой права `manage_objects`. Кеш сессии ограничен 160 КБ: рейсы архива не дублируются, корзина/восстановленные смены не сохраняются в кеше, аудит и уведомления урезаются; при квоте сначала удаляются/ужимаются восстанавливаемые данные, pending-действия сохраняются.

**Доказательство:** 567/567 тестов исходников канала и 150/150 доменных тестов зелёные; QA Chromium 393×852 — отдельный сценарий 26/26 (реальная высота полосы и hit-test модалки, карточки и действия в нескольких сменах, создание нового объекта со сменой, заполнение localStorage до квоты и запись действия); `qa-browser-ticker.py` 15/15, `qa-browser-scenarios.py` 15/15, `qa-browser-parallel.py` 13/13, `qa-browser-multi.py` 10/10; `tools/verify-working-test.py` — УСПЕШНО. Рабочая версия и рабочая база не менялись.

## 75. Урок 28.11.2026 (закрытие смены на тестовом канале): strict-v2 мост отверг legacy-писателя, и смена не закрылась

**Симптом:** владелец нажимает «Закрыть смену», приложение пишет «Не удалось завершить закрытие (подтверждение): api-http-500. Сохранённый архив не удалён; можно повторить закрытие». Смена остаётся активной. В логе API: `[shift-api] close failed 23514`. Код 23514 — `check_violation` PostgreSQL, то есть отказ триггера, а не сети.

**Причина:** тестовая база уже на миграциях 025–030, где `shifts_legacy_bridge` — strict-v2 нормализатор. По D1 смена в состоянии `closing` продолжает занимать линию, поэтому `is_active=true`. Legacy-писатель `server/src/shift-close.mjs` в `prepare` передавал `UPDATE shifts SET is_active=false,payload=$3`, а в payload ставил `closing:true`; триггер видел противоречие и бросал `shift canonical payload mismatch`. Это же было записано в уроке 23 как известный долг Task 7, но до тестового канала долг не доходил. Вторая половина дефекта: `finish` проверял `if(row.is_active||!shift.closing)`, то есть тоже ждал `is_active=false`; после исправления `prepare` закрытие всё равно отказало бы с `shift-not-prepared`.

**Что сделано:** `prepare` пишет только `payload` (мост сам выводит `is_active=true` из `closing:true`), в payload добавлен `closingByUid`; `finish` доверяет маркеру `closing`, а не колонке `is_active`; на `finish` явный `is_active=false` оставлен — на S24 без триггера он обязателен, а на strict-v2 совпадает с выведенным `historical`. Legacy-писатель по-прежнему закрывает смену как `historical` (доказан только `closedBy`, не uid) — это осознанное поведение урока 22, а не ошибка.

**Доказательство:** прямой SQL на тестовой базе: старый `UPDATE ... is_active=false` + `closing:true` → `shift canonical payload mismatch`; без колонки — успех. Новый подтест `v2-shift-close-db.test.mjs` на baseline S25/S29 падает до фикса с `23514` и проходит после; весь файл 8/8. Legacy-тесты `shift-close.test.mjs` на baseline S24 — 10/10. `npm run check` — успешно. Рабочая версия и рабочая база не менялись: на production миграции 025–030 ещё не применялись, поэтому фикс выпускается в тестовый канал и должен идти вместе с миграциями при продвижении.

## 76. Урок 28.11.2026 (продолжение 75): выпуск 1.10.5 и ловушки QA-стенда на http

**Выпуск:** тестовая линия 1.10.5, сборка `9eb8f92fa0718727`, сайт канала `c48ec0d`. API тестовой линии (`samosval-api-working-test`, 18091) пересобран из исправленного сервера и заменён; база и данные не менялись. Live-проверка: версия 1.10.5, 143/143 SHA совпадают, SW-кэш `samosval-working-test-shell-9eb8f92fa0718727`, ошибок страницы нет.

**Доказательство закрытия на стенде (Chromium 393×852, strict-v2 база QA):** prepare и finish отвечают 200 (до фикса prepare давал 500/23514), смена уходит из полосы открытых, архив `closed_shift_…` с 1 рейсом и 30 м³ сохранён, материал перенесён в Табель 2 (`day:2026-11-28:day`, `lineImports`), ошибок консоли нет. Смена закрывается как `historical` (D2: писатель доказывает только имя), для клиента это обычная закрытая смена.

**Ловушки QA-стенда (только стенд, не продукт):** `stand-build.sh` ослабляет требование https лишь в `synology/session-client.mjs`. Ещё два места требуют https и на локальном http-стенде рвут перенос материала: `working-test/tabel-v2/backend.mjs` (`storageScope`, ошибка «Нет права переносить материалы в Табель 2» — на самом деле падала проверка адреса) и `working-test/synology/tabel-remote.mjs` (`invalid-api-url`). Для стендовой проверки их ослабляют так же, только в копии стенда.

**Ещё одна ловушка стенда:** закрытие через интерфейс — это три окна: «создать резервную копию?» (отвечать «Назад», иначе ждём бэкап), «Закрыть смену?», и при наличии рейсов — «Материал с Линии» (материал и направление), если у объекта ещё нет `currentMaterial`/`lineDestination`. Без заполнения последнего окна закрытие висит без ошибки, и это не зависание сервера.

## 77. Урок 28.11.2026 (тестовая 1.10.6): «самосвал не приехал» — новая операция линии, право и буква Д в листках

**Что добавлено:** кнопка «Дубликат» на карточке линии (четвёртая после ТТН, красная, срабатывает с удержанием 0,5 с). Нажатие ставит статус «самосвал не приехал»: карточка затемняется, уезжает в конец списка, «Погрузка» и «ТТН» блокируются, «Приехал» остаётся живым и снимает статус. В «Сводке», листе ГАИ, PNG и архиве латинская D заменена русской Д: крупная — в клетке сразу после последнего рейса, маленькая — рядом с госномером.

**Решения, которые нельзя «оптимизировать» обратно:**
- Статус хранится серверной операцией линии `no-return` (тип в `line-rules.mjs`, `line-store.mjs`, `line-store-v2.mjs`), а не в локальном кэше: его видят все операторы, он переживает перезагрузку, попадает в журнал/отмену и в офлайн-очередь (`42-offline-v2.js` — `BODY_FIELDS` фиксирован, новых полей не требует).
- Право `action_no_return` (миграция `031_no_return_permission.sql`): default deny, включено `senior_foreman`/`foreman`/`master`, выключено `lopater`/`viewer`, admin строкой не заводится. Без строки в `role_permission_versions` матрица админки не увидит новую галочку сразу.
- `deriveStage` в `shift-trucks-v2.mjs` возвращает `null` при `noReturn`, иначе машина «висит» в стадии `ttn` и перенос в другую смену требует завершить ходку.
- Кулдаун ходки (`cycle-time`) ослаблен только для `arrive`, когда `before.noReturn === true` — и на сервере, и в клиенте. Иначе отмеченную машину нельзя вернуть до конца ходки, а это прямо противоречит кнопке «Приехал».
- Буква Д не расширяет таблицу: если рейсов ровно `maxT`, Д рисуется наложением внутри последней клетки (`.paper-absent-mark.overlay`). Колонку добавлять нельзя — владелец запретил менять размер ячеек.
- Старый косвенный признак «есть рейсы, ТТН не забрана» остаётся только для архивных листов (`window.__closedShiftDupEnabled`); в живом листе он отключён, иначе Д появлялась бы у всех машин с рейсами.

**Ловушка с двумя рендерерами:** карточку линии рисуют и `core/18-line-ui.js`, и `features/anim-speeds.js` (второй перекрывает `window.renderLine`). Правку кнопки, сортировки и затемнения нужно дублировать в оба, иначе в живом приложении кнопки не будет, хотя тест ядра зелёный.

**Ловушка проверки листков в фикстуре:** если контейнер вкладки `#tab-report` в стенде `display:none`, таблица измеряется как 0 px и «доказательство, что ширина не изменилась» ничего не доказывает. Для замера нужны `class="tab-content active"` и `data-perms-ready="1"` на `body`.

**Ловушка публикации (поймана на этом выпуске):** сайт канала — отдельный репозиторий, и его публикация делалась через `git commit -am`, который **не берёт неотслеживаемый** каталог новой сборки `working-test/build/<id>/`. Коммит ушёл без бандла: страница ссылалась на несуществующий `core.js`. Правило: в репозитории сайта всегда `git add` каталог сборки явно (или `git add -A`) и перед push проверять `git status --short` — пусто. После push обязательна сверка 143/143 SHA по live-URL, иначе дефект виден только у пользователя.

**Доказательство:** 514/514 тестов исходников канала, 150/150 доменных `tests/tabel-v2`, 29/29 серверных (`line-rules`, `v2-router`, `line-store`), `migration-registry` на чистой базе, миграция 031 на временном кластере (повторный прогон идемпотентен); Chromium 393×852 — четыре кнопки влезают в ряд (52/144/72/52 px, без горизонтальной прокрутки), короткое нажатие 150 мс не даёт операции, удержание 800 мс даёт `{type:'no-return'}`, у отмеченной машины «Дубликат» и ТТН disabled; «Сводка» — 10 колонок и высота строк как до выпуска (487 px и 52/52/31), Д 32 px Caveat `rgb(220,38,38)` в свободной клетке и наложением при 8 рейсах, латинской D нет. Рабочая версия и рабочая база не менялись.

**Выпуск 1.10.6 (итог):** источник — коммиты `51637b2` (код) и `a27f9f4` (этот урок) в `release/working-test`; сборка `74c22147aca7c4fa`; сайт канала — `97bf563` + `a1578dd` (файлы бандла). Обязательные workflow на коммите кода зелёные: `Synology server test foundation` (3м53с, push), `Production source integrity`, `Full browser integration audit` (4м42с). Тестовая база: миграция `031_no_return_permission.sql` применена вручную с записью checksum в `schema_migrations` (idempotent, повтор не меняет данные), права `senior_foreman`/`foreman`/`master` = true, `lopater`/`viewer` = false. API канала пересобран из ветки (`samosval-working-test:no-return-1.10.6-20261128`), старый контейнер сохранён как `samosval-api-working-test-prev-1105` для откатa, `/health/ready` = 200. Live: `version.json` 1.10.6 / build `74c22147aca7c4fa`, 143/143 SHA-256 совпали, SW-кэш `samosval-working-test-shell-74c22147aca7c4fa`, собранная страница открывается в Chromium 393×852 без ошибок страницы и без неудачных запросов. Рабочая версия и рабочая база не менялись.

## 78. Урок 28.11.2026 (тестовая 1.10.7): на кнопках линии — только значки, отметка называется «Самосвал больше не приедет»

**Что изменено по замечаниям владельца после испытания 1.10.6:**
- Текст статуса везде заменён на **«Самосвал больше не приедет»**: карточка (`.absent-mark`), подписи офлайн-очереди и аудита, журнал NAS, журнал отмены, подписи права, `title`/`aria-label` в листках, отчётах, PNG и архиве, серверный `auxiliary-store.mjs`.
- С кнопки убрано слово «Дубликат»: остался только значок 🚫 (красный глиф на сером фоне `#4b5563`, рамка `#6b7280`). Смысл для диктора держит `aria-label="Самосвал больше не приедет"`, `title`/подсказок нет — владелец их не просил.
- С кнопки ТТН убраны «ТТН»/«Забрать ТТН»/«Забрал ТТН»: остался только 📄. Цвет — бледно-красный `#ef9a9a` (тёмный текст `#4c0d0d`), забранная ТТН по-прежнему зелёная (`active-ttn`, `#166534`). Прежние эскизы с синим/бирюзовым/индиго отменены решением владельца.
- Ряд кнопок: `grid-template-columns: auto 1fr 46px 46px` (было `auto 2fr 1fr auto`). Значки занимают фиксированные 46 px, всё освободившееся место уходит «Погрузке». Замер 393 px: 52 / 176 / 46 / 46 px, `scrollWidth == clientWidth`, прокрутки нет; на 360 px тоже без переполнения. Размеры ячеек «Сводки» и листа ГАИ не менялись.

**Ловушка, которую нельзя забыть:** цвет кнопок задан с `!important` в перекрывающем CSS `anim-speeds.js`. Поэтому серый вид выключенной кнопки приходится повторять там же правилом `.truck-card .btn:disabled` — иначе у ТТН и 🚫 `disabled` остаётся цветным и выглядит активным.

**Ловушка теста:** в `no-return-duplicate.test.mjs` были зашиты старые тексты («Кнопка «Дубликат»», `absent-mark` без текста). Тест обновлён: проверяет, что слов на кнопках нет, а значки и `aria-label` есть. При следующей смене формулировки статуса обновлять и этот тест, иначе он ловит не дефект, а переименование.

**Доказательство до выпуска:** 515/515 тестов исходников канала, 150/150 доменных `tests/tabel-v2`; Chromium 393×852 и 360×852 — четыре кнопки в ряду без прокрутки, `pageerror` нет; ТТН бледно-красная, забранная — зелёная; у отмеченной машины ТТН и 🚫 `disabled` и серые; метка «Больше не приедет» (148 px, 10 px uppercase) не выходит за блок идентификации.

## 79. Урок 28.11.2026 (тестовая 1.10.8): значки кнопок линии — векторные, монета ушла в угол

**Что изменено по замечаниям владельца после 1.10.7:** эмодзи 📄 и 🚫 в узких квадратных кнопках выглядели «топорно» и по-разному на разных телефонах, а монета 🪙 (22 px + `margin-left:4px`) не влезала в кнопку 46 px и обрезалась `overflow: hidden`.
- Значки теперь SVG в новом модуле `working-test/source/core/35-line-icons.js`: `svgTtnIcon(collected)` — листок документа (забранная ТТН — листок с галочкой), `svgNoReturnIcon()` — круг с диагональю и целым силуэтом самосвала. Модуль объявлен в `working-test/modules.json` **до** `core/18-line-ui.js`.
- Обе служебные кнопки серые `#4b5563`, значки `#ef4444` 26×26 px. Рамка ТТН нейтральная `#94a3b8`, у отметки красная `#ef4444` — две серые кнопки не путаются. Забранная ТТН зелёная `#166534` с рамкой `#4ade80`. Выключенные кнопки — `#475569` и цвет `#cbd5e1` (прежний `#94a3b8` на телефоне читался совсем бледно).
- Колёса самосвала «вырезаны» цветом фона через `--icon-hole` (по умолчанию `#4b5563`, у disabled `#475569`). Если менять фон кнопки — менять и переменную, иначе в силуэте появятся светлые пятна.
- Монета на кнопке ТТН получила класс `.game-button-coin--corner` (`position:absolute; top:1px; right:1px; font-size:12px`): она встаёт уголком и не сдвигает значок. На широких кнопках (`Погрузка`, `Простой`) монета осталась в строке.

**Ловушка проверки:** на кнопке ТТН монета появляется **только при ненулевой ставке** — по умолчанию `rewardDefaults.ttn = 0`, поэтому в обычном состоянии уголка нет, и «проверил — монеты нет» ничего не доказывает. Проверять с `appConfig.gameRewardSchedule` с `ttn > 0` и вызванным `window.__gameConfigChanged()`; тогда класс `game-button-coin--corner` и `right <= btn.right` подтверждаются замером.

**Ловушка собранной страницы:** собранный `index-working-test.html` подключает стили `game-coins-style.css` инлайном, а `game-coins-v2.js` — отдельным файлом сборки. Проверять наличие класса в бандле через `grep` по `*.css` бесполезно (файлов CSS в каталоге сборки нет) — правило ищется в самом `index-working-test.html`.

**Доказательство до выпуска:** 579/579 тестов исходников канала (включая обновлённый `no-return-duplicate.test.mjs` — проверяет SVG, `aria-label` и порядок модулей, эмодзи запрещены), 150/150 доменных `tests/tabel-v2`, 29/29 серверных (`line-rules`, `v2-router`, `line-store`); Chromium 393×852 на собранной сборке — четыре кнопки в ряду (52/176/46/46 px), `scrollWidth == clientWidth`, значки 26 px, монета-уголок внутри кнопки, `pageerror` нет; короткое касание 150 мс операции не даёт, удержание 800 мс даёт `{type:'no-return'}`. Рабочая версия и рабочая база не менялись.

## 80. Урок 28.11.2026 (срочно, тестовая 1.10.8): вход даёт «неверный логин или пароль» — у контейнера API не было каталога /secrets

**Симптом:** владелец не смог войти в тестовую версию под своей учётной записью администратора — экран входа отвечал «неверный логин или пароль». Код и БД при этом были целы.

**Причина (не код приложения):** контейнер `samosval-api-working-test` пересоздавался скриптом пересборки **без** тома `-v /home/iluxa/samosval-secrets:/secrets:ro`. У 6 учётных записей тестовой базы (`user_credentials.algorithm = 'firebase-scrypt'`, включая `iluxaspb@gmail.com` с ролью admin) пароль проверяется по `signerKey`/`rounds`/`memoryCost` из `/secrets/firebase-hash-config.json`. Файла в контейнере не было — `verifyPassword` возвращал `false` на любой пароль, и вход выглядел как «неверный пароль». Признак в логах: `[auth] firebase-scrypt config not found: login with firebase-scrypt passwords will fail`; при живом конфиге там же появляется `[auth] firebase-scrypt config loaded from /secrets/firebase-hash-config.json (algorithm=SCRYPT, rounds=8, memoryCost=14, signerKeyLen=88)`.

**Исправление:** контейнер пересоздан с томом `/home/iluxa/samosval-secrets:/secrets:ro`; скрипт `redeploy-wt-api-*.sh` дополнен этим томом, чтобы ошибка не повторилась при следующем выпуске. Проверено: `/health/ready` = 200, в логе конфиг загружен, `POST /api/v1/auth/login` с заведомо неверным паролем отвечает `401 {"error":"invalid-credentials"}` (раньше — тот же 401, но из-за отсутствия конфига), `tests/firebase-scrypt.test.mjs` — 3/3. Через внешний маршрут `https://samosval-test.iluxa.pro/api/v1/auth/login` запрос доходит до контейнера (Caddy → 127.0.0.1:18091).

**Как проверять вход, не зная пароля:** сравнивать лог контейнера, а не код ответа: `401` одинаков и при отсутствующем конфиге, и при действительно неверном пароле. Различает их только строка `config loaded` / `config not found`. Записи владельца в БД: `firebase-scrypt`, `length(password_hash)=88`, `length(salt)=16`, `password_reset_required=false` — формат корректный.

**Внимание:** у контейнеров `samosval-api-qa` и `samosval-api-qa-old` тома `/secrets` тоже нет — вход под firebase-scrypt учётками там сломан так же. `samosval-api-prod` том имеет.

## 81. Урок 28.11.2026 (тестовая 1.10.9): отладочная смена аккаунта — входить до отзыва, а тестовые учётки прятать на сервере

**Что сделано:** администратору в шапке бейдж открывает окно «Аккаунт» (выход + отладочная смена аккаунта), у остальных ролей — прежний выход. Тестовые учётки пяти ролей создаются скриптом `server/scripts/seed-debug-accounts.mjs` с пометкой `profile.debugAccount: true`, пароль копируется из записи администратора (хеш/соль/алгоритм), в репозитории пароля нет.

**Ловушка 1 — порядок отзыва сессии.** Первая версия смены аккаунта отзывала refresh-токен администратора до входа под тестовой ролью. Ошибка входа (неверный пароль) оставляла пользователя без админской сессии. Правильно: снять снимок текущей сессии → выполнить `/api/v1/auth/login` → `wtStoreSession(data)` → только затем `logout` со старым refresh-токеном → `location.reload()`. При любой ошибке восстанавливать снимок (`restoreSession`) и не перезагружать страницу.

**Ловушка 2 — `window.localStorage` префиксуется.** `working-test/src/storage.js` подменяет `Storage.prototype` и добавляет префикс `wt_<encodeURIComponent(pathname)>:`. Поэтому сохранённый пароль (`debug_account_password`) проверять только через `localStorage.getItem(...)` из приложения, а не по «сырому» ключу в devtools — иначе кажется, что запись не сохранилась.

**Ловушка 3 — тестовые учётки в общем списке.** `readMembers` (серверный `/api/v1/members`) кормит выпадающие списки пользователей в линии и табеле. Отладочные учётки оттуда исключены условием `COALESCE(profile->>'debugAccount','false')<>'true'`; `readAdministration` (`/api/v1/admin/access`) их по-прежнему отдаёт администратору. Проверка — два разных запроса, «в списке нет» само по себе ничего не доказывает.

**Ловушка 4 — `docker run` без `FIREBASE_PROJECT_ID`.** Контейнер API падает на `import './auth.mjs'` с `FIREBASE_PROJECT_ID is required`, и curl к нему возвращает `000`. Для ручного стенда переменную задавать явно вместе с `AUTH_SESSION_SECRET` и `ALLOWED_ORIGINS`.

**Ловушка 5 — порт 55432 занят чужим стендом.** `scripts/test-isolated-db.mjs` принимает admin URL только на `127.0.0.1:55432`, а этот порт может держать контейнер другого worktree (`stage4-i7_postgres_1`). Не останавливать чужой контейнер: DB-набор проверяется в CI (`synology-server-tests`), где compose поднимает свою БД на 55432.

**Доказательство до выпуска:** 591/591 тест исходников канала (включая `features/debug-accounts.test.mjs` — 7 проверок, `core/account-badge.test.mjs` — 5), 150/150 доменных `tests/tabel-v2`, `npm run check`; Chromium 393×852 на стенде — 14/14 шагов: окно открывается, пять ролей, вход лопатером и наблюдателем, недоступность вкладки «Админ», сохранение/подстановка/забывание пароля, у не-админа бейдж по-прежнему спрашивает выход, `pageerror` и HTTP ≥400 нет; серверные запросы: `/api/v1/members` без отладочных учёток, `/api/v1/admin/access` с ними.

**Ловушка 6 — тестовая база хранит Firebase SCRYPT, а не локальный scrypt.** В `samosval_test_clean` у владельца `user_credentials.algorithm='firebase-scrypt'` (hash 88 симв., salt 16). Первая версия `seed-debug-accounts.mjs` копировала только `password_hash/salt/algorithm` из локального формата и не переносила `password_reset_required` — вход отладочной учёткой отвечал `401 invalid-credentials`, хотя «пароль тот же». Копировать надо все поля credential целиком (`password_hash, salt, algorithm, password_reset_required`) и сверять в БД, что они **побайтово равны** админским; 401 при проверке заведомо чужим паролем — ожидаемый ответ, он ничего не доказывает.

## 82. Урок 28.11.2026 (тестовая 1.10.10): оформление состояний кнопок ТТН и «больше не приедет»

**Что просил владелец:** обе кнопки серые в покое и зелёные, когда действие выполнено; значок ТТН — белый контурный лист с загнутым углом (красный цвет убрать), значок отметки — цветной самосвал (как эмодзи 🚚) под красным знаком запрета; поверх выполненного действия — крупная галочка, одинаковая на обеих кнопках; значок на всю площадь кнопки, сами кнопки не расширять.

**Что сделано:**
- `core/35-line-icons.js` переписан: `svgTtnIcon(collected)` — белый контурный лист с загнутым углом и строками текста; `svgNoReturnIcon(done)` — цветной самосвал (кузов `#dbe3ec`, кабина `#3b82f6`) с красным кругом и диагональю в покое, без запрета и с галочкой в выполненном. Галочка вынесена в одну функцию `svgDoneCheck()` с подложкой `#166534`: она читается и на белом листе, и на цветном самосвале.
- Размер значка — `width/height:100%` внутри кнопки с `padding:2px`; сама кнопка осталась 46×44 (замер 393 px: 52/176/46/46, `scrollWidth == clientWidth`).
- Активные состояния: `.btn-ttn.active-ttn` и новый `.btn-no-return.active-no-return` — фон `#166534`, рамка `#4ade80`. Класс `active-no-return` ставится по `st.noReturn === true` в обоих рендерерах.
- Взаимная блокировка: кнопка отметки получает `disabled`, если `absent || ttn` (раньше только `absent`). Логика, права и сохранение не менялись.

**Ловушка: `disabled` гасит выполненное состояние.** В перекрывающем CSS `anim-speeds.js` правило `.truck-card .btn:disabled` ставит серый фон с `!important`, поэтому зелёная кнопка после выполнения выглядела выключенной. Добавлено исключение для `.active-ttn:disabled` и `.active-no-return:disabled` (фон `#166534`, `opacity: 1`).

**Ловушка: затемнение карточки гасит ряд кнопок.** `.truck-card.faded` задавал `opacity: 0.35` на всю карточку, и зелёное «выполнено» становилось серым. Теперь затемняются только дочерние блоки кроме `.action-row`, а внутри ряда — только `.btn-arrive` и `.btn-quick`: остальные элементы выглядят как раньше, служебные кнопки остаются яркими.

**Ловушка параллельного выпуска (поймана в этом же выпуске):** пока шла работа, ветку `release/working-test` занял другой выпуск — `f049cc4` «Тестовая 1.10.9: администратору — окно аккаунта» и `c1bde1e`. Мой номер `1.10.9` оказался занят, push отклонён как non-fast-forward. Правило: перед bump версии сверять `git fetch` и `git log origin/release/working-test`, а после отклонённого push не форсировать, а переносить свои правки на актуальную ветку и повышать версию до свободной (здесь — `1.10.10`).

**Доказательство до выпуска:** 580/580 тестов исходников канала (в `no-return-duplicate.test.mjs` добавлена проверка общей галочки, цветного самосвала, классов активного состояния и взаимной блокировки), 150/150 доменных `tests/tabel-v2`, 29/29 серверных; Chromium 393×852 и 360×852 на собранной сборке — ряд без переполнения, у трёх карточек проверены оба состояния, удержание ТТН 800 мс даёт `['ttn','t1']`, короткое касание отметки — ничего, у машины с забранной ТТН кнопка отметки `disabled`, после повторного рендера классы сохраняются, `pageerror` и неудачных запросов нет.
