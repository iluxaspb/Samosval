# Параллельные смены: дизайн этапа 4

Дата: 23.11.2026
Статус: amendment об атрибуции legacy одобрен владельцем 23.11.2026 и внесён в дизайн; требуется повторный review дизайна. Существующий план реализации до review/approval не актуализировать и не исполнять. Реализация `025` на HEAD `03d497d` с жёсткими `NOT NULL opened_by_uid/shift_type` и часовым угадыванием не является финальной; дальнейший продуктовый код остановлен до одобрения этого документа.
Область: тестовая линия `working-test`, сервер `server/`, PostgreSQL. Реализацию и тесты до окна можно вести только на изолированной БД. Миграция общей инфраструктуры/БД и деплой сервера требуют отдельно согласованного окна обслуживания и явного «да» владельца.

## 1. Замысел, цели и границы

Сейчас workspace фактически имеет одну текущую линию: `shift-start.mjs` запрещает вторую смену, `line-read.mjs` ожидает максимум одну, клиент хранит один набор shift/status/logs. Новая модель: **каждая активная смена сама является отдельной линией**. Постоянных сущностей «Линия 1/2» нет. Пользователь переключается между назначенными активными сменами; каждое чтение и действие адресовано явным `shiftId`.

### Цели

- Несколько одновременно открытых смен в одном workspace.
- Day и night одного объекта и даты могут пересекаться.
- `senior_foreman` и `foreman` видят только назначенные активные смены; admin — все.
- Рейсы, статусы, отчёты, табель, материалы, presence, офлайн-команды и ревизии не смешиваются.
- Один самосвал имеет максимум одно **текущее назначение/status** в активной смене; незавершённый цикл прежней смены после привилегированного перевода хранится отдельно и не даёт начинать там новые рейсы.
- Восстановленный архив редактируется отдельно от активной линии.
- Сервер сохраняет ACL, CAS и идемпотентность.

### Не входит

- Постоянные линии/бригады, отдельный workspace на линию, WebSocket (этап 5).
- Изменение расчёта рейса, наград и табеля, кроме обязательного контекста смены и устранения двойного счёта.
- Автоматический скрытый перевод самосвала.
- Долгая одновременная поддержка старого и нового клиента.
- Публикация production без отдельного поручения и явного согласия владельца.

### Антицели

Решение неприемлемо, если сервер доверяет UI вместо ACL; самосвал управляется из двух смен; поздний ответ или replay попадает в выбранную сейчас чужую смену; восстановленный архив выглядит активным; закрытие A читает/меняет B; старый клиент продолжает запись после перехода на v2.

## 2. Подход

### 2.1. Атрибуция исторических смен: рассмотренные варианты

| Вариант | Смысл | Решение |
|---|---|---|
| **A. Сохранить legacy unresolved** | Перенести доказуемые поля, а недоказанные автора и/или тип хранить как `NULL` с независимой явной пометкой `unresolved`; оставить смену доступной истории и архиву, но не выдавать её за достоверно атрибутированную | **Выбран владельцем 23.11.2026**: сохраняет факты без выдумывания и не блокирует всю миграцию |
| B. Блокировать migration до ручного разбора | Не применять схему, пока человек не назначит автора и тип каждой старой смене | Отклонён: часть значений объективно недоказуема, а одна такая строка блокирует весь переход |
| C. Угадывать identity/type | Подставлять display name, UID отправителя replica, час открытия либо иные косвенные признаки | **Запрещён**: это ложная атрибуция; display name не identity, transport sender не creator, час не подтверждает День/Ночь |

`identity_resolution` и `shift_type_resolution` независимы: наличие доказанного UID не доказывает тип и наоборот. Канонические значения resolution: `source` (значение присутствует в первичном авторитетном документе), `manual` (внесено отдельной аудируемой командой) и `unresolved`. Значения `inferred` в схеме нет: никакая автоматическая эвристика не является подтверждением. Если в будущем появится детерминированное подписанное свидетельство, оно должно быть оформлено как новый versioned source-evidence contract, а не переименовано в «догадку».

### 2.2. Несколько `shifts`, без сущности line

Shift одновременно является линией. Назначения людей находятся в `shift_members`; все зависимые записи имеют `shift_id`. Это совпадает с бизнес-языком, использует существующий `shiftId` и не вводит долгоживущую сущность.

Отклонены:

- постоянная `line`: противоречит решению владельца и требует лишнего жизненного цикла;
- workspace на линию: дублирует справочники/ACL и ломает общие отчёты;
- совместимый долгий v1/v2 rollout: владелец выбрал окно обслуживания без одновременной работы старых и новых клиентов.

## 3. Доменная модель и инварианты

### 3.1. Смена

`shift_id` — непрозрачный стабильный ID. Отображение строится из объекта, рабочей даты, типа и времени открытия.

Состояния: `active`, `closing`, `closed`, `historical`. `closed` означает только завершение обычным close lifecycle с доказанными `closed_at/by`; `historical` — отдельное non-active состояние cutover/restored-row migration без synthetic close actor/time. Точный дубликат активной/закрывающейся смены `(workspace_id, object_id, work_date, shift_type)` запрещён; day и night не конфликтуют.

**Изменение объекта разрешено только до первого подтверждённого сервером события `arrive`.** Точный серверный критерий:

- в транзакции первого успешно подтверждённого `arrive` сервер атомарно ставит `shifts.object_locked_at` и `object_locked_by_operation_id` до фиксации receipt;
- после `object_locked_at IS NOT NULL` `change object` всегда возвращает `409 object-locked`;
- `load` в нормальном протоколе невозможен без `arrive`; защитный fallback также ставит lock при подтверждённом `load`, если lock отсутствует из-за старых/импортированных данных;
- миграция помечает объект заблокированным у смены, если уже есть `line_logs` либо статус содержит признак прибытия/погрузки; неоднозначность останавливает миграцию, а не угадывается;
- снятие/удаление первого рейса не разблокирует объект. Для другого объекта открывается новая смена.

### 3.2. Участники

Создатель становится активным участником в транзакции создания. Реактивация ранее снятого участника обновляет ту же строку: очищает `removed_*`, обновляет `assigned_*`, увеличивает `revision`; новая строка не создаётся.

Назначать можно только активных пользователей ролей `senior_foreman` и `foreman`. `worker`, `driver` и прочие роли не являются прорабами и участниками линии. Admin имеет обход membership для управления, но не обязан добавляться.

Последнего активного участника обычный участник снять не может. Admin может снять последнего для исправления осиротевшей смены; после этого запись доступна только admin до нового назначения. Снятый участник немедленно теряет active read/write, включая finish уже начатого им close; finish выполняет оставшийся участник с правом либо admin.

### 3.3. Самосвал, обычный и принудительный перевод

- Один текущий status/assignment на `(workspace, truck)` обеспечивается БД. Только смена из этого status может начинать для truck новые `arrive/load/ttn` циклы.
- Обычный перенос остаётся двухшаговым `remove A → add B`: он понятен, уже соответствует отдельным операциям состава и допускается только без незавершённого цикла.
- По умолчанию двойное назначение запрещено. Если truck уже назначен в A, обычный `add` в B возвращает `409 truck-assigned-to-other-shift` с безопасными данными A; обычный прораб не может продолжить.
- Исключение для пересечения day/night — атомарный `force transfer A → B`, только с отдельным правом `force_transfer_truck`. Если цикл в A завершён, операция просто атомарно переносит status. Если цикл не завершён, его канонический снимок атомарно отделяется в `detached_open_trips`, а текущий status пересоздаётся/переносится в B как чистое назначение без стадий старого цикла.
- Detached trip остаётся адресован `(source_shift_id, cycle_id)` и навсегда относится к A. Его могут завершить авторизованные участники A **или B**, но endpoint записывает событие, рейс, rewards/material/report effects, receipt и audit только в A. Новые рейсы создаются только через current status B; detached endpoint не умеет начинать новый цикл или менять destination shift.
- Одновременно для `(workspace, truck)` допускается максимум один `open` detached trip. Повторный force transfer, пока он открыт, запрещён `409 truck-detached-trip-open`; цепочка незавершённых старых циклов не накапливается.
- Завершённые рейсы, rewards, receipts и audit навсегда остаются в исходном `shiftId`.

Незавершённый цикл определяется сервером по нормализованным ревизиям и каноническому status payload в заблокированной строке, а не по UI. Force transfer не является отменой или переносом рейса: server сохраняет точную стадию, исходные revisions и данные цикла; разрешённая завершающая команда определяется этой стадией по тем же доменным правилам, что и обычное завершение.

### 3.4. Архивный режим

Restored archive не становится active shift. Он открывается из Архива как `restoredContext {archiveId, sourceShiftId, archiveRevision}`.

Разрешены только:

- исправление и удаление рейсов;
- исправление и удаление ТТН.

Запрещены изменение объекта, даты/типа, участников, состава техники и любые active line-команды (`arrive/load/reset`, add/remove truck/member, close). Изменения имеют отдельные `archive_revision`, receipt и audit; active revisions не меняются.

## 4. Точная модель БД

Это целевая логическая схема, не полный SQL. Текстовые ID сохраняют совместимость с существующими ID; времена — `timestamptz`, рабочая дата — `date`, ревизии — `bigint CHECK (>0)`.

### 4.1. `shifts`

| Столбец | Тип/ограничение |
|---|---|
| `workspace_id` | `text NOT NULL`, FK `workspaces(id)` |
| `shift_id` | `text NOT NULL` |
| `state` | `text NOT NULL CHECK IN ('active','closing','closed','historical')`; `historical` не является normal close |
| `object_id` | `text NOT NULL`, FK `(workspace_id, object_id)` → `workspace_objects` |
| `object_name_snapshot` | `text NOT NULL` |
| `work_date` | `date NOT NULL` (Europe/Moscow) |
| `shift_type` | `text NULL CHECK (shift_type IN ('day','night'))`; `NULL` только при `shift_type_resolution='unresolved'` |
| `opened_at` | `timestamptz NOT NULL`; malformed/неоднозначное время блокирует конкретную миграцию до исправления источника, потому что без времени нельзя безопасно упорядочить историю |
| `opened_by_uid` | `text NULL`, составной workspace-scoped FK `(workspace_id,opened_by_uid)` → `app_users(workspace_id,uid)` (если текущая `app_users` глобальна, 025 использует существующий глобальный FK без подмены UID); `NULL` только при `identity_resolution='unresolved'`. FK — `ON DELETE RESTRICT`: user мягко отключается (`status='disabled'`), hard delete UID, на который ссылается provenance/audit, запрещён |
| `opened_by_name_snapshot` | `text NOT NULL`; исторический display snapshot для показа, никогда не identity и не основание найти UID |
| `payload_schema_version` | `smallint NOT NULL CHECK IN (1,2)` |
| `identity_resolution` | `text NOT NULL CHECK IN ('source','manual','unresolved')` |
| `shift_type_resolution` | `text NOT NULL CHECK IN ('source','manual','unresolved')` |
| `object_locked_at` | `timestamptz NULL` |
| `object_locked_by_operation_id` | `text NULL` |
| `closing_started_at`, `closing_by_uid` | nullable |
| `closed_at`, `closed_by_uid` | nullable |
| `revision` | `bigint NOT NULL DEFAULT 1` |
| `payload` | `jsonb NOT NULL`; совместимый snapshot, не источник normalized полей |

PK `(workspace_id, shift_id)`. Обязательные согласующие constraints:

```sql
CHECK ((opened_by_uid IS NOT NULL) = (identity_resolution IN ('source','manual'))),
CHECK ((shift_type IS NOT NULL) = (shift_type_resolution IN ('source','manual'))),
CHECK (payload_schema_version = 1 OR
       (payload_schema_version = 2 AND identity_resolution='source'
        AND shift_type_resolution='source'
        AND opened_by_uid IS NOT NULL AND shift_type IS NOT NULL))
```

`payload_schema_version=2` означает только новый строгий writer; legacy/manual строка никогда не повышается до v2 и не маскируется под исходно полную. Для новых v2 строк `state/object/date/type/openedAt/openedBy` обязательны и payload точно согласован с normalized columns. Для v1 допускается `NULL` только в двух provenance-полях `opened_by_uid` и `shift_type`, и только с соответствующим `unresolved`; это не означает, что вся строка «не nullable». `closing_started_at/closing_by_uid`, `closed_at/closed_by_uid` и `object_locked_*` остаются независимо nullable по своим state/domain constraints. Остальные канонические поля строгие.

Частичный unique index `(workspace_id,object_id,work_date,shift_type) WHERE state IN ('active','closing') AND shift_type_resolution IN ('source','manual')` защищает подтверждённые линии. Отдельный constraint/trigger запрещает `active|closing` при `shift_type_resolution='unresolved'`; поэтому nullable type не обходит уникальность: unresolved legacy может существовать только как `closed|historical`, не как вкладка линии. State constraints различают lifecycle: `closed` требует `closed_at` и `closed_by_uid`, созданные normal close; `historical` требует оба поля NULL либо сохраняет их только как immutable original snapshot в historicalization audit, а в canonical row ставит `historicalized_at/by`, `historicalization_reason/report_hash` и не выдаёт это за close. Индексы `(workspace_id,state,opened_at)`, `(workspace_id,object_id,work_date)`. Старый `is_active` удаляется только поздней отдельной миграцией; во время перехода выводится как `state IN ('active','closing')` и проверяется constraint/trigger на согласованность.

### 4.2. `shift_members`

| Столбец | Тип/ограничение |
|---|---|
| `workspace_id`, `shift_id`, `uid` | `text NOT NULL`; FK shift, FK user |
| `assigned_at`, `assigned_by_uid` | `timestamptz/text NOT NULL` |
| `removed_at`, `removed_by_uid` | nullable, оба null или оба not null |
| `revision` | `bigint NOT NULL DEFAULT 1` |

PK `(workspace_id,shift_id,uid)`. Частичные индексы активных memberships: `(workspace_id,uid,shift_id) WHERE removed_at IS NULL` и `(workspace_id,shift_id,uid) WHERE removed_at IS NULL`. Мягкое удаление обязательно.

### 4.3. `line_truck_statuses`

Сохраняется один текущий status на truck: PK `(workspace_id,truck_id)`. `shift_id text NOT NULL`, составной FK `(workspace_id,shift_id)` → shifts, FK truck, `status_revision bigint NOT NULL`, `cycle_revision bigint NOT NULL`, `ttn_revision bigint NOT NULL`, `payload jsonb NOT NULL`. Индекс `(workspace_id,shift_id,truck_id)`. Все update/delete включают `workspace_id AND shift_id AND truck_id`; status удаляется при remove/finish close, история остаётся в archive/history.

### 4.4. `detached_open_trips`

Отдельная сущность хранит ровно тот незавершённый цикл, который force transfer оставил в исходной смене; она не является вторым truck status.

| Столбец | Тип/ограничение |
|---|---|
| `workspace_id`, `source_shift_id`, `truck_id`, `cycle_id` | `text NOT NULL`; FK shift/truck |
| `destination_shift_id` | `text NOT NULL`, FK shift; текущая смена, в которую выполнен перевод |
| `state` | `text NOT NULL CHECK IN ('open','completed')` |
| `stage` | нормализованная незавершённая стадия цикла |
| `cycle_revision` | `bigint NOT NULL`; отдельный CAS detached trip |
| `source_status_revision`, `source_ttn_revision` | revisions в момент отделения |
| `payload` | `jsonb NOT NULL`; канонический снимок цикла, не источник normalized полей |
| `detached_at/by_uid`, `completed_at/by_uid` | audit timestamps/actors |
| `transfer_operation_id`, `completion_operation_id` | ссылки на receipts |

PK `(workspace_id,source_shift_id,cycle_id)`. Частичный unique `(workspace_id,truck_id) WHERE state='open'` запрещает несколько оставшихся циклов одного truck. Индексы по source/destination shift позволяют показать блок участникам обеих линий. Строка после completion не удаляется. Ограничение/триггер требует, чтобы текущий `line_truck_statuses.shift_id` для open detached trip совпадал с `destination_shift_id`; последующий обычный remove/transfer truck запрещён до completion, чтобы право «участник новой линии» не стало неоднозначным.

### 4.5. Зависимые сущности

Обязательный `shift_id NOT NULL` и FK на shifts добавляются/проверяются в:

- `line_logs` (также FK truck, индекс `(workspace,shift,truck,log_id)`);
- `line_history` (индекс `(workspace,shift,created_at DESC,action_id)`);
- `line_operation_receipts`, `line_audit`, `shift_operation_receipts`, а также transfer/detached receipts и append-only audit;
- `workspace_service_receipts` и report/history receipts, если команда относится к смене;
- `shift_historical_status_snapshots(workspace_id,shift_id,truck_id,payload,status_revision,cycle_revision,ttn_revision,snapshot_reason,source_hash,snapshotted_at/by_uid)`: PK shift+truck, exact FK на `shifts` и truck, immutable; создаётся только controlled historicalization, не является current assignment и не читается active line;
- reward/game events и penalties, порождённые рейсом;
- material import marker;
- archive series/revisions/publications (`source_shift_id`, immutable revision chain и unique canonical series per source shift);
- табельные записи смены.

Для generic receipt допустимо хранить `shift_id` nullable только у действительно workspace-wide команды; line/shift endpoint требует NOT NULL. Каждый receipt хранит `protocol_version smallint NOT NULL`, `command_hash text NOT NULL`, `uid`, результат и уникальность `(workspace_id,operation_id)`; повтор с другим uid/hash/shift/protocol — `operation-id-reused`.

### 4.6. Архив, immutable revisions, табель и material marker

Архив является immutable revision chain, а не одной перезаписываемой строкой. Логическая identity отделена от содержимого:

- `shift_archive_series(workspace_id,archive_id,source_shift_id,current_location,latest_finalized_revision,latest_finalized_sha256,series_revision,created_at)`: PK `(workspace_id,archive_id)`, unique `(workspace_id,source_shift_id)` только для canonical archive одной business shift; `current_location IN ('archive','trash')` — mutable catalog placement с отдельным CAS и не переписывает revision bytes. `latest_finalized_*` — единственный authoritative default pointer;
- `shift_archive_revisions(workspace_id,archive_id,archive_revision,previous_revision,previous_sha256,payload_bytes,payload_sha256,payload_schema_version,source_kind,source_locator,created_at,created_by_uid)`: PK `(workspace_id,archive_id,archive_revision)`, unique `(workspace_id,archive_id,payload_sha256)` и unique source locator; `archive_revision>0`, revision 1 имеет `previous_* NULL`, каждая следующая требует exact previous revision/hash. `payload_bytes bytea` — authoritative UTF-8 JSON bytes, `payload_sha256` считается по ним; parsed JSON/normalized columns могут быть generated/cache projection, но не заменяют bytes. UPDATE/DELETE запрещены owner trigger/grants; actor FK `ON DELETE RESTRICT`;
- `archive_revision_publications(workspace_id,archive_id,archive_revision,restored_context_id,restore_operation_id,finalize_operation_id,base_revision,base_sha256,command_hash,published_by_uid,published_at)`: append-only provenance, unique context и finalize operation; exact FK на revision/context. Receipt links реализуются составными constraints `fk_archive_publication_restore_receipt (workspace_id,restore_operation_id) REFERENCES archive_operation_receipts(workspace_id,operation_id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED` и `fk_archive_publication_finalize_receipt (workspace_id,finalize_operation_id) REFERENCES archive_operation_receipts(workspace_id,operation_id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED`. Это допускает runtime INSERT publication до receipt в одной finalize transaction и нормативный restore publication-before-receipt, но не dangling publication к моменту explicit constraint checkpoint/commit. Revision, не созданная initial close/import либо successful finalize, не существует.

Revision 1 для native close содержит exact archive candidate; для legacy import — exact source document bytes из immutable `migration_documents` и их source locator/hash, без reserialization. Archive schema v2 копирует **original** `shift_type`, `shift_type_resolution`, `opened_by_uid`, `opened_by_name_snapshot`, `identity_resolution`, `payload_schema_version` и source shift revision; missing type остаётся `NULL/unresolved`, час не используется. `archived_by_uid/name/at` относится к созданию archive revision и не заменяет original opener. Старые `archive_overrides` мигрируют как доказанные последовательные immutable revisions, а не становятся mutable overlay.

Все обычные consumers используют один resolver `latest finalized`: archive list, default read/open, PNG/export, material calculation/correction, report sheet, analytics/monthly aggregation, tabel archive projection, backup compatibility projection и restore-start. Они получают `archiveId`, `archiveRevision`, `archiveSha256` и payload именно из `latest_finalized_revision`; cache/CAS включает все три. Ни один consumer не выбирает «первую», import source или открытую restored context неявно. Явный history API возвращает metadata всей цепочки, а explicit revision read/export принимает `(archiveId,archiveRevision)` и возвращает exact immutable bytes/hash; он read-only и никогда не меняет default pointer. Trash placement не скрывает chain от full backup/history, но default active archive list показывает только `current_location='archive'`.

Canonical восстановление не создаёт legacy row в `shifts`. Оно создаёт `restored_shift_contexts`:

| Столбец | Контракт |
|---|---|
| `workspace_id, restored_context_id` | PK |
| `archive_id, source_shift_id` | NOT NULL FK на archive и original source identity |
| `mode` | `CHECK IN ('standalone','parallel')`; режим показа/редактирования, не active state |
| `context_state` | `CHECK IN ('open','finalized')`; это lifecycle редактирования context, не `active|closing|closed|historical` бизнес-смены |
| `original_opened_by_uid/name_snapshot`, `original_identity_resolution` | копируются только из source archive provenance; nullable/`unresolved` сохраняются |
| `original_shift_type`, `original_shift_type_resolution` | копируются только из archive; missing остаётся `NULL/unresolved` |
| `restored_by_uid`, `restored_by_name_snapshot`, `restored_at` | NOT NULL, actor/time проверенной session; FK actor `ON DELETE RESTRICT` |
| `archive_revision`, `context_revision`, `restore_operation_id` | NOT NULL CAS/provenance |
| `source_state_snapshot`, `source_shift_revision`, `opened_at_snapshot`, `object_id/name/date` | NOT NULL/nullable согласно original archive; immutable source snapshot |

Restored children имеют **dedicated FK**, не polymorphic nullable pair:

- `restored_context_logs(workspace_id,restored_context_id,log_id,truck_id,payload,log_revision,source_log_id,created_from_archive_revision)`, PK context+log, FK context `ON DELETE RESTRICT`, FK truck; это latest editable trip state. `report.update/delete` для archive mode адресует context+log и никогда `line_logs`;
- `restored_context_status_snapshots(workspace_id,restored_context_id,truck_id,payload,status_revision,cycle_revision,ttn_revision)`, PK context+truck, immutable base snapshot, присутствует для **standalone и parallel**. Она сохраняет archive `activeLineIds/ttnStatus` и reconstructed latest-load metadata, но не является current assignment и не блокирует truck;
- `restored_context_history(workspace_id,restored_context_id,action_id,uid,type,before_log,after_log,before_status_snapshot,after_status_snapshot,revision,undone,created_at)`, append-only actions/undo state;
- `restored_context_receipts(workspace_id,operation_id,restored_context_id,uid,protocol_version,command_hash,result,recorded_at)` и `restored_context_audit(...)`, exact FK context/action/actor `ON DELETE RESTRICT`.

Текущая фактическая реализация правит restored рейсы в canonical `line_logs`, хранит CAS в `workspace_service_receipts/audit`, standalone создаёт synthetic current statuses, parallel — нет. Migration переносит **latest** restored `line_logs` в dedicated logs, все имеющиеся restored statuses — в status snapshots, относящиеся `workspace_service_audit/receipts` report actions — в restored history/receipts/audit с сохранением revisions/undone/hash/result/time. Отсутствующие parallel statuses реконструируются только как archive snapshot с явным `snapshot_source='archive'`, не как бизнес-события. `line_history`, line receipts/audit, если они ссылаются на legacy restored shift, также переносятся по exact shift/action/log identity либо ambiguity abort; ничего не остаётся orphan.

Legacy restored migration использует dedicated immutable evidence, а не только transient сверку. Parent `restored_context_migration_evidence(workspace_id text NOT NULL,evidence_id uuid NOT NULL,legacy_shift_id,archive_id,base_archive_revision,source_locator,source_bytes_sha256,source_counts,source_table_roots,closure_hash,migrated_context_id,migration_operation_id,created_at)` append-only с `PRIMARY KEY(workspace_id,evidence_id)`, `UNIQUE(workspace_id,migrated_context_id)`, `UNIQUE(workspace_id,legacy_shift_id)`, `UNIQUE(workspace_id,source_locator)` и exact FK `(workspace_id,migrated_context_id) → restored_shift_contexts(workspace_id,restored_context_id) ON UPDATE RESTRICT ON DELETE RESTRICT`. Один context имеет ровно один evidence manifest. `source_locator` точно называет единственный legacy archive document/revision и запрещает выбрать по совпадению object/date/name.

Child `restored_context_migration_evidence_rows(workspace_id text NOT NULL,evidence_id uuid NOT NULL,source_table,source_pk_canonical_jcs,source_pk_hash,source_row_sha256,source_bytes,representation_kind,target_table,target_pk_canonical_jcs,copied_at)` хранит одну строку на каждый перенесённый append-only audit/receipt row. Его exact constraint `fk_restored_evidence_rows_parent (workspace_id,evidence_id) REFERENCES restored_context_migration_evidence(workspace_id,evidence_id) ON UPDATE RESTRICT ON DELETE RESTRICT`; locator unique — `UNIQUE(workspace_id,evidence_id,source_table,source_pk_hash)`. `restored_context_id` в child отсутствует: context выводится только через parent FK, поэтому duplicated unchecked context identity невозможна. `source_table` ограничен versioned allow-list фактически мигрируемых таблиц: `workspace_service_audit`, `workspace_service_receipts`, `line_audit`, `line_operation_receipts`, `line_history`, `history_audit`, `history_receipts`, `shift_operation_receipts`; добавление таблицы требует schema version/review. Locator exact: `{source_table,source_pk_canonical_jcs,source_row_sha256}`, где PK object имеет реальные PK columns, JCS/RFC 8785 bytes, `source_pk_hash=SHA-256(source_pk_canonical_jcs)`; equality verifier дополнительно сравнивает canonical PK bytes, исключая hash-only identity. `source_row_sha256` считается по exact immutable row bytes, если table хранит authoritative bytes, иначе по versioned lossless canonical JCS representation всех columns с type tags, SQL NULL и timestamp/bytea encoding; representation kind/version сохраняется.

PostgreSQL authority boundary основана только на ownership/grants. Отдельный `samosval_migration_evidence_owner NOLOGIN` владеет allowlisted source append-only tables, evidence parent/child, их named immutable triggers и единственной `SECURITY DEFINER migrate_legacy_restored_context_exact(...)`; это не runtime/schema owner. Runtime — `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`, не owner/member этого owner или maintenance roles, не может `SET ROLE`; `PUBLIC`/runtime не имеют `ALTER`, `TRIGGER`, source/evidence UPDATE/DELETE и `EXECUTE` migration function. Dedicated maintenance executor — отдельный не-runtime `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`, не member owner; credentials не попадают в runtime pool. После preflight и owner confirmation ему явно временно выдаётся только `EXECUTE` на exact signature функции, а после transaction `REVOKE` выполняется и effective privilege проверяется. Function owner/signature/body checksum, `prosecdef`, safe fixed `search_path` и ownership всех tables/triggers проверяются до grant и после revoke.

В одной transaction exact function: (1) берёт advisory lock только для сериализации, не как authorization; (2) locks source rows `FOR UPDATE` в порядке table allow-list→canonical PK; (3) строит canonical row manifest; (4) создаёт context/children, parent с generated `evidence_id`, затем child rows по exact parent FK; (5) копирует exact bytes/lossless representation и проверяет per-row hash/count, per-table aggregate root, target FK closure и parent→context consistency; (6) исполняет только статические allow-list branches `ALTER TABLE <fixed-qualified-table> DISABLE TRIGGER <fixed-append-only-trigger>`, manifest-verified `DELETE` по locked exact PK, затем `ALTER TABLE ... ENABLE TRIGGER ...` для каждой source table; arbitrary table/trigger/SQL identifiers параметрами не принимаются, dynamic SQL отсутствует; (7) проверяет, что все named triggers enabled, originals отсутствуют, evidence complete, target rows принадлежат context из parent и double authority отсутствует; (8) удаляет synthetic statuses/logs и последним synthetic shift anchor. Transactional `ALTER TABLE` откатывается вместе с data: при любой ошибке исходные rows и enabled trigger state восстанавливаются, а context/copies/evidence исчезают. До commit функция повторно проверяет `pg_trigger.tgenabled` всех allowlisted triggers; postcondition после commit делает ту же проверку отдельной session.

Ни custom GUC, ни `current_user`, ни function-call identity, ни advisory lock не являются capability и trigger их не проверяет: единственный bypass — фактическое транзакционное отключение конкретного named trigger владельцем таблицы внутри статической SECURITY DEFINER function. `session_replication_role` запрещён и не используется. Runtime/PUBLIC direct DELETE, ALTER/DISABLE TRIGGER, `SET ROLE`, forged GUC, захват advisory lock, прямой вызов migration function, вызов другой owner function и arbitrary `source_table` обязаны fail/no-delete; probes отдельно доказывают, что runtime не owner/superuser/BYPASSRLS/member и что append-only triggers эффективны до и после migration.

До mutation preflight доказывает: ровно один archive source; exact SHA-256 source bytes; counts/hashes всех synthetic shift/status/log/history/audit/receipt rows; locator uniqueness и FK closure без orphan/foreign children; отсутствие material/tabel/reward/game side effects, которые пришлось бы выдумать. Synthetic shift anchor не переносится и не создаётся: target context/children ссылаются на archive series/revision напрямую. Orphan child, wrong workspace parent FK, повторный parent для context, child под evidence другого context, mutation/omission/duplicate/wrong locator, row/table-root mismatch, authority/bypass attempt, disabled trigger postcondition, source row после delete либо target/evidence gap abort всей transaction. PostgreSQL rollback автоматически возвращает originals/triggers и удаляет context/copies/evidence. После успешного commit originals отсутствуют, immutable evidence+dedicated target являются единственной authority; double authority запрещена verifier/constraints.

Она не вызывает normal close, не создаёт повторную initial archive revision, material marker, tabel/reward/game events либо `closed_at/by`; source revision остаётся byte-exact. Standalone и parallel различаются только UI-origin/legacy provenance (`mode`), а не схемой children или правами.

Пока `context_state='open'`, разрешены только archive trip/TTN corrections с `context_revision` CAS. Finalize — единственная publication operation: под archive-series lock и context `FOR UPDATE` она проверяет active ACL, `expectedContextRevision`, `expectedBaseArchiveRevision` и `expectedBaseSha256`; строит canonical next payload bytes из base revision + полной ordered context history; вычисляет next revision/hash; атомарно INSERT immutable revision и publication, переводит context в `finalized`, обновляет `latest_finalized_*`, пишет archive receipt/audit и только затем commit. Normal `closeShift`, active shift/statuses и synthetic close/material/tabel/reward/game effects не создаются. Если latest pointer уже не base — `409 archive-changed`, context остаётся open без partial revision. Identical finalize replay после повторной ACL-проверки возвращает тот же revision/hash; тот же operation/context с иным hash — `operation-id-reused`; concurrent finalize даёт ровно одну next revision. Published revision не меняет original/base bytes и хранит provenance до них через `previous_*` и publication.

Повторная restore exact `(archive_id,archive_revision,archive_sha256)` возвращает существующий open context по receipt либо `archive-changed`; одновременно допускается максимум один open context на archive series, а restore неявно выбирает latest finalized только если revision не указана. Purge запрещён при revision/context/evidence/audit/receipt FK; retention может удалить finalized context только отдельной owner-approved policy после доказательства, что immutable published revision, migration evidence, publication/audit/receipt и full-backup closure сохраняются.

Exact classification старых восстановленных данных:

| Вход | Original opener/type | Restore actor/time | Результат |
|---|---|---|---|
| Source archive содержит provenance v2 | только поля archive `opened_*`/resolution и `shift_type`/resolution | session actor/time текущей restore-команды | standalone/parallel restored context; original state active/closing/closed сохраняется только как snapshot истории, не как состояние context |
| Legacy restored row содержит `startedByUid/startedBy/startedAt` и `restoredFrom|restored=true` | **не** opener; original берётся только из source archive, а при отсутствии там доказательства остаётся unresolved | эти legacy поля классифицируются как restore actor/time только при ссылке на существующий archive и проверяемом legacy restore receipt; иначе migration блокирует строку как ambiguous | historical restored context, никогда active shift |
| Archive без type | `original_shift_type=NULL`, `unresolved`; час не используется | session/доказанный legacy restore actor отдельно | historical context; activation запрещена |

`archive_operation_receipts`: workspace, operation_id, archive_id, uid, command_hash, result; PK workspace+operation. `archive_audit`: append-only с archive_id/source_shift_id, before/after, actor/time. Все actor/opener FK используют soft-disable и `ON DELETE RESTRICT`; hard delete не может стереть provenance. Legacy unresolved archive разрешён для чтения, history, export/backup и trip/TTN corrections. Restore actor всегда берётся из session; original `workShift` — только из archive. Restore не создаёт active line/statuses и не появляется в selector. Даже после manual resolution переход в active line не является частью archive restore и требует отдельной будущей reactivate-команды с ACL/CAS/duplicate checks.

`tabel_records` для сменного листа получает `shift_id`; unique `(workspace_id,shift_id)` для листа смены и отдельный индекс `(workspace_id,object_id,work_date,shift_type)`. Производный display key — `object/day/type`; запрет точного active duplicate делает его однозначным среди активных, но постоянная идентичность листа — `shiftId`. Несменные записи табеля могут оставить `shift_id NULL` с явным `record_kind`.

`shift_material_markers`: PK `(workspace_id,shift_id)`, `material_id`, `source_archive_revision`, `volume`, `revision`, `confirmed_at/by`; повторное finish не создаёт второй перенос. Коррекция архива обновляет тот же marker только через архивный workflow с CAS.

### 4.7. JSON, trust boundary и payload schema v2

Normalized столбцы — канон; JSON — versioned snapshot совместимости. Identity определяется не именем:

- для NAS command авторитетный actor — UID проверенной NAS/Firebase session; `uid`, имя и роль из body игнорируются;
- `replica batch sender uid` удостоверяет только право доставить пачку и записывается как transport sender, но никогда не становится `opened_by_uid` документа;
- `openedByNameSnapshot`/`startedBy` — только снимок отображаемого имени, не ключ пользователя.

Exact shift payload v2 (лишние identity/provenance aliases запрещены):

```json
{
  "payloadSchemaVersion": 2,
  "id": "shift_<opaque>",
  "shiftId": "shift_<opaque>",
  "objectId": "object_<opaque>",
  "objectName": "Снимок имени объекта",
  "startDate": "23.11.2026",
  "date": "2026-11-23",
  "workShift": "night",
  "type": "night",
  "state": "active",
  "isActive": true,
  "startedAt": 1795453200000,
  "startedByUid": "firebase-uid",
  "startedBy": "Снимок отображаемого имени"
}
```

`startedAt=1795453200000` — ровно `2026-11-23T20:00:00+03:00`, поэтому согласован с `date/startDate=23.11.2026` в Europe/Moscow и значением `night`. Acceptance публикует этот exact JSON как golden classifier fixture: canonical key set должен совпасть полностью, тип каждого значения фиксирован, `id===shiftId`, aliases date/type/state согласованы, timestamp попадает в указанную MSK date; missing/extra/mismatched key даёт stable `invalid-shift-v2-provenance`. В normal v2 payload особо запрещены restore-only aliases `restoredFrom`, `restored`, `originalSourceShiftId`, `restoredBy`, `restoredByUid`, `restoredAt` и любые `restoredBy*`.

Writer обязан записать `startedByUid=currentUid` из session, текущий display snapshot, выбранный пользователем `workShift`, согласованные `type/state/isActive/date/startDate`, object и startedAt. Для NAS v2 `workShift` обязателен; старый комментарий/контракт `workShift optional + hour fallback` удаляется. Firebase writer до cutover также обязан писать эти поля, даже если Firebase уже не authoritative runtime: точный v1 fixture показывает фактический старый документ `{id,objectName,objectId,startDate,startedAt,startedBy,isActive}` без UID/type, а не выдуманные поля. Replica sender пересылает document data побайтно/семантически неизменённо внутри envelope; он не добавляет UID/type и не нормализует автора.

### 4.8. Миграция 025: legacy preflight/backfill и граница происхождения

025 классифицирует исходную строку по данным документа, а не по transport metadata:

1. v2 — только exact `payloadSchemaVersion:2` и полный согласованный payload; неизвестный user/object, malformed date/timestamp/state/type или mismatch aliases блокируют migration fail-closed;
2. legacy v1 — отсутствие `payloadSchemaVersion` либо exact version 1. Доказанный `startedByUid` с существующим FK даёт `identity_resolution='source'`; иначе `opened_by_uid=NULL`, `identity_resolution='unresolved'`. `startedBy` сохраняется в snapshot, но поиск UID по имени запрещён;
3. `workShift`/`type` дают `shift_type_resolution='source'` только если значение day/night и aliases согласованы; отсутствие оставляет `shift_type=NULL`, `unresolved`. Час `startedAt` не используется;
4. state берётся из согласованных `state/isActive/closing`; противоречие блокирует. `objectId`, object/date и timestamp должны быть доказуемы и валидны; иначе это malformed, а не «legacy unresolved»;
5. preflight создаёт versioned canonical JSON report `samosval.legacy-historicalization/v1`. Exact UTF-8 bytes строятся JCS/RFC 8785 без whitespace и содержат: `schema`, `workspaceId`, `migrationVersion`, `generatedAt`, `expiresAt`, `backupManifestSha256`, `databaseFingerprint`, `rows[]` в порядке `shiftId`. Каждая row содержит operationally необходимые `shiftId`, `objectId`, `workDate`, `currentState`, `sourcePayloadSha256`, `childCounts`, per-child deterministic SHA-256, current assignment keys/hash, original closing-field presence/hash и owner-visible `assignmentSummary`. Summary имеет exact redacted fields: `currentAssignmentCount`; `currentStatusFieldCounts` с ключами, взятыми только из фактической status model — `onLineTrue`, `arriveTimestampPresent`, `lastLoadTimestampPresent`, `loadedAfterArriveTrue`, `ttnStatusPending`, `ttnStatusCollected`; `unfinishedCycleCount` по тому же canonical server predicate незавершённого цикла, что блокирует remove/close; `statusSnapshotsToCreate` (равно числу exact current status rows, которые будут скопированы); optional `safeTruckIds` допускается только если versioned redaction policy прямо разрешает opaque internal `truck_id`, иначе ключ отсутствует. Truck names/numbers, display names, email, comments/payload, guessed type, PII и secrets запрещены. Summary также содержит фиксированные owner-visible тексты consequences: «Текущие назначения этих самосвалов будут освобождены» и «Незавершённая работа будет сохранена как неизменяемый исторический снимок и не будет считаться завершённой». Эти counts не вводят новый stage enum: они группируют только реально присутствующие status fields/values; один status может входить в несколько field counts. Все summary fields/text/redaction-policy version входят в canonical bytes/hash. Изменение assignment, любого status field/count, unfinished predicate result, snapshot count, разрешённых safe IDs или текста последствий меняет report bytes/hash и инвалидирует confirmation. Отдельно хранится `report_sha256=SHA-256(exact report bytes)` и row count; bytes immutable и доступны владельцу в безопасном preflight UI/export. Непустой список блокирует unattended cutover;
6. в конкретном maintenance window владелец подтверждает **exact report bytes/hash**, а не пересказ или только список IDs. `legacy_historicalization_confirmations` хранит confirmation id, report schema/hash, exact report bytes FK/hash, owner actor UID, confirmed_at, expires_at, backup manifest hash, database fingerprint и one-time state. Signed/DB-recorded command включает `confirmReportSha256` и повторно показывает count/expiry; обычный deploy flag/env/GUC не считается подтверждением. Перед первым mutation migration пересоздаёт report из locked source rows и требует byte-for-byte/hash equality, неизменный backup/fingerprint, active owner ACL, неистёкшее/неиспользованное confirmation. Отказ, изменение хотя бы байта, redaction/schema version, source/children hash либо повторное использование abort untouched;
7. по подтверждённому report controlled migration function переводит каждую строку в отдельное состояние `historical`, не назначая day/night и не создавая synthetic normal close actor/time. Append-only `legacy_cutover_historicalization_audit` хранит confirmation id, report schema/hash, operation/source/children hashes, shift, old/new state, reason exact `legacy-type-unresolved-at-cutover`, maintenance actor UID/time, original closing/close fields и result revision; payload получает только explicit historicalization marker, не business close. Existing logs/history/receipts/archive/material/tabel данные не удаляются и не переписываются; current `line_truck_statuses` сохраняются как immutable historical status snapshots, после count/hash verification удаляются только из current assignment table, чтобы освободить trucks без создания рейсов/reset/close effects. Closing receipts остаются historical evidence и не могут быть finish-replayed. Строка безопасно выходит из active uniqueness/selector. Confirmation consume, historicalization, child snapshot, status removal, audit и DDL — одна откатываемая transaction после backup; любая ошибка откатывает всё. Rollback после commit, если v2 traffic ещё не открыт, — только точная обратная migration по audit либо подтверждённый full restore; после v2 mutation — maintenance/forward-fix, не silent reopen. Миграция схемы не блокируется уже closed/historical unresolved строками; activation блокируется.

Обычный runtime не имеет INSERT/UPDATE-пути для `payload_schema_version=1` или `resolution='unresolved'`. Role split выполняется **до первого DDL/data change 025 либо атомарно в той же закрытой maintenance transaction**, но никогда впервые в 026: privileged bootstrap заранее создаёт отдельные NOLOGIN owners (`samosval_schema_owner`, более узкий `samosval_migration_evidence_owner`) и runtime login; секреты не входят в migration. Bootstrap/deployment role создаёт и назначает ownership, но maintenance executor и runtime не получают membership/`SET ROLE` в owners. API/runtime role — `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`, не member owner/migration/maintenance roles, не владеет schema/table/function и получает только `EXECUTE` на allowlisted ordinary v2/manual functions плюс нужный `SELECT`; migration evidence/restore entrypoints исключены. `PUBLIC` и runtime лишаются table DML, ALTER/TRIGGER и function create/replace; `SECURITY DEFINER` functions принадлежат соответствующему NOLOGIN owner, имеют fixed `search_path`, fully-qualified objects и revoke `EXECUTE FROM PUBLIC`. Deploy preflight доказывает через `pg_roles`, `pg_auth_members`, `pg_class.relowner`, `pg_proc.proowner`, `pg_trigger` и effective privilege probes, что runtime не superuser/BYPASSRLS/owner/member и не может `SET ROLE`, direct DML, disable trigger, invoke migration/other-owner function или replace function. Иначе 025 abort. 026 лишь расширяет уже существующую границу на stream/heads/staging.

Legacy classifier/write разрешён только внутри transaction 025 и отдельного full exact-restore maintenance entrypoint под migration role. После cutover ordinary replica materializer принимает для collection `shift` только strict exact v2; любой v1/missing version возвращает stable `protocol-upgrade-required` (а forged/mismatched v2 — `invalid-shift-v2-provenance`) и откатывает batch. Historical stream остаётся byte-exact для backup/audit, но v1 shift events не replay через runtime materializer. Full restore вставляет canonical history/provenance напрямую в точном порядке под owner function после manifest/checksum validation; это не online replay и не допускает selective legacy write.

Фактический `03d497d` нарушает этот контракт: требует UID/type для всех строк, угадывает тип по часу и сохраняет legacy write bridge. Поэтому прежний strict Task0A (семь `NOT NULL`) должен быть перепроектирован после review; существующие планы пока не правятся.

### 4.9. Ручное уточнение legacy

Versioned API: `POST /api/v2/admin/legacy-shifts/{shiftId}/resolve` с body:

```json
{"operationId":"...","protocolVersion":2,"expectedShiftRevision":1,"set":{"openedByUid":"uid-or-omit","shiftType":"day-or-night-or-omit"},"evidenceNote":"Краткое проверяемое основание"}
```

Только session user со `status='active'`, ролью `admin` и exact action `resolve_legacy_shift=true`. Default ACTIONS: `admin=true`, `senior_foreman=false`, остальные false; senior не проходит даже при общем edit/archive permission. Расширение — только отдельное решение владельца и migration матрицы. Минимум одно текущее `unresolved` поле должно стать `manual`. Очищать уже source/manual значение или менять его этой командой нельзя. `evidenceNote` обязателен (1..1000 UTF-8 chars), без секретов, токенов, телефонов и иных лишних персональных данных; UI предупреждает об этом. UID обязан существовать (включая disabled historical user как target provenance, но не hard-deleted), type — day/night.

В одной транзакции сначала canonical request hash и `(workspace,operationId)` receipt. Даже при найденном identical receipt сервер заново проверяет текущую session, active admin и action; отозванный admin не получает результат replay. Иной hash/uid/shift/protocol — `operation-id-reused`. Для fresh operation берётся transaction advisory lock по двум 64-bit hashes canonical `(workspace,object_id,work_date,requested_shift_type)` и блокируется/создаётся unique guard row с полным canonical key; hash collision лишь избыточно сериализует запросы, а правильность обеспечивает exact guard key, не hash. Затем `FOR UPDATE` shift, CAS/revision и constraints. Закрытая historical строка может получить manual type, не конкурируя с active unique index; advisory lock лишь сериализует её с потенциальной activation. Отдельная будущая activation/reactivation заново берёт тот же canonical lock и проверяет active duplicate key, ACL, object/user и revisions.

Затем добавляются receipt и immutable `shift_legacy_resolution_audit(workspace_id,audit_id,operation_id,shift_id,old_opened_by_uid,new_opened_by_uid,old_identity_resolution,new_identity_resolution,old_shift_type,new_shift_type,old_shift_type_resolution,new_shift_type_resolution,evidence_note,actor_uid,resolved_at,expected_revision,result_revision,command_hash)`. Audit append-only; `(workspace_id,operation_id)` unique; actor FK `ON DELETE RESTRICT`, account soft-disable. Повтор identical request после повторной ACL-проверки возвращает сохранённый result без второй audit; concurrent stale CAS — `409 shift-changed` и не создаёт receipt/audit.

Resolution type не активирует смену автоматически. После него closed/restored historical row остаётся non-active; отдельная v2 reactivate/restore-to-active команда (если когда-либо разрешена) заново проверяет duplicate index, object/user, ACL и revisions. Identity может остаться unresolved для исторического просмотра и архивного редактирования; actor восстановления хранится отдельно (`restored_by_uid/name/at`) и никогда не заменяет original opener.

### 4.10. Amendment: replica staging без фиктивных смен

**Решения владельца от 23.11.2026:** выбран вариант B — отдельная `replica_pending_documents`; `replica_placeholder` запрещён и удаляется. Replica-owned `shifts/statuses/logs` восстанавливаются только полным exact-комплектом вместе с stream/cursor/staging/heads; selective restore любого члена комплекта отклоняется до mutation. Offline rebuild не выбран.

Root cause: transport state (документ принят, но canonical parent ещё не пришёл) не может жить в `shifts`. Канонический инвариант жёсткий: каждая строка `shifts` — реальная нормализованная бизнес-смена; strict v2 имеет все canonical значения, а исторический v1 может иметь nullable opener/type только по conditional provenance constraints 4.1. Placeholder и transport-null исключений нет.

#### Протокол операций, identity и hash

Одна replica operation описывает ровно один документ. Materializable kinds: только `doc.set` и `doc.delete`. Для `doc.set` exact payload envelope — `{collection,path,data}`, где `data` — object; если `data.id` присутствует, оно обязано точно совпасть с последним segment `path` (`document_id`). Для `doc.delete` единственное canonical представление — `{collection,path}`: ключ `data` отсутствует, identity берётся из path. Входной `data:null` принимается только как transport alias и **до hash/duplicate comparison** нормализуется удалением ключа; любое иное `data` у delete отвергается. Поэтому delete с отсутствующим `data` и с `data:null` имеет один v2 canonical hash, а stream хранит только canonical envelope без `data`. Разрешённые materializable collections: `objects`, `users`, `shift`, `trucks`, `truckStatus`, `logs`; это минимальный sound allow-list, потому что фактический `replica-materialize.mjs` уже материализует objects/users, а strict shift имеет их FK. Все шесть коллекций входят в versioned allow-list, v2 hash и `replica_document_heads`; `objects/users/shift/trucks` никогда не staging. Остальные существующие поддержанные события, включая `trip.load`, принимаются как **journal-only**: stream/cursor меняются, canonical/staging/heads — нет. Неизвестный kind/collection запрещён до записи всей пачки. Переход протокола имеет versioned allow-list; старый sender без требуемой версии после cutover получает `protocol-upgrade-required`, а не угадываемую классификацию.

Миграция 026 добавляет в `replica_stream`:

| Столбец | Тип/ограничение |
|---|---|
| `protocol_version` | `smallint NOT NULL DEFAULT 1 CHECK (protocol_version IN (1,2))` |
| `hash_version` | `smallint NOT NULL DEFAULT 1 CHECK (hash_version IN (1,2))` |

Она также заменяет stream PK на `(workspace_id,direction,seq)`, сохраняя `UNIQUE(workspace_id,direction,operation_id)`: после 026 новые f2s/s2f writers используют независимые cursor sequence и не конфликтуют одинаковыми номерами. Все новые provenance FK явно содержат `direction`; materialization использует только `direction='f2s'`.

До этого DDL migration 026 выполняет fail-closed historical preflight под блокировкой stream/cursor. Фактический v1 writer в `replica-store.mjs` назначает f2s `seq := f2s_seq + 1`; s2f writer в текущем коде отсутствует, а `s2f_seq` пока используется только как read head. Старый PK `(workspace_id,seq)` делал seq глобально уникальным, но сам по себе не доказывает contiguous 1..N отдельно для направления при возможном interleaving/историческом importer. Поэтому 026 **не требует и не создаёт** per-direction renumbering. Для каждого workspace preflight проверяет: одна cursor row; уникальность старого `(workspace_id,seq)`/operation identity; `seq>0`; `max(f2s.seq)=f2s_seq` (оба 0 при пустом f2s); у текущего native f2s-префикса, созданного штатным writer без recorded compaction/import marker, exact set seq равен `1..f2s_seq`; если имеется versioned legacy import/compaction marker, разрешена только строго возрастающая уникальная subsequence в заявленных сохранённых ranges, последний seq равен cursor и каждая отсутствующая позиция покрыта marker range. Для s2f: строго возрастающая уникальная subsequence, нет строки `seq>s2f_seq`, а `max(s2f.seq)=s2f_seq` при непустом stream; cursor `>0` без строки на head либо любая внутренняя дыра без marker — ambiguity и abort. Межнаправленные одинаковые seq до смены PK невозможны; их появление — corruption и abort, не основание переписать историю. Rows beyond соответствующего cursor, duplicate/ambiguous IDs, missing cursor/head, непокрытые gaps или marker mismatch прерывают всю 026 до PK/hash/schema changes. Historical `seq`, cursor, payload и hashes не перенумеровываются и не переписываются.

Существующие строки помечаются `protocol_version=1, hash_version=1`; их `sha256` остаётся legacy hash только payload и никогда не переписывается. Новая операция обязана иметь `protocolVersion:2`, `hash_version=2`; hash равен lowercase hex SHA-256 UTF-8 байтов RFC 8785/JCS canonical JSON exact envelope `{"protocolVersion":2,"kind":<kind>,"payload":<payload>}`: object keys сортируются по JCS/UTF-16 code units, без whitespace, strings/escapes и finite numbers сериализуются по ECMAScript JSON serialization; `undefined`, NaN/Infinity, duplicate parsed keys и значения вне JSON отвергаются. Поэтому тот же operation id и payload с другим kind конфликтует.

Duplicate lookup сравнивает сохранённые `hash_version`, `protocol_version`, `sha256`: v2↔v2 тот же hash — replay/no-op; иной hash/kind/protocol — `replica-operation-conflict`. Legacy v1 duplicate подтверждается только по его сохранённому v1 payload-hash и legacy kind; v1/v2 с одним operation id всегда conflict, без пересчёта и silent rewrite. До `BEGIN`/любых writes вся входная пачка валидируется, canonical hashes считаются, и внутрипакетные duplicate IDs сворачиваются только если version/protocol/kind/hash идентичны; они считаются одним fresh candidate. Разные hashes одного id отклоняют всю пачку до writes.

#### Parent policy

Staging применяется только для корректного `doc.set` status/log, у которого отсутствует хотя бы один **разрешённо запаздывающий canonical parent**. После cutover materializer классифицирует shift только как exact v2; v1/missing version получает `protocol-upgrade-required`, malformed v2 — `invalid-shift-v2-provenance`. Ни один из них не pending/placeholder. Parent arrival order разрешён только для status/log относительно shift/truck. `objects` и `users` — versioned materializable operations, но должны быть в уже committed earlier batch/head либо стоять **раньше shift в той же atomic batch**; batch validator строит deterministic topological order `objects/users → shift/trucks → truckStatus/logs`, не зависит от произвольного входного порядка и отклоняет cycle/duplicate generation. Отсутствующий object/user отклоняет всю batch; для unresolved legacy full restore user parent не требуется только потому, что opener NULL, но object обязателен.

Таблица parent policy:

| Document | Required parents | Поведение при отсутствии |
|---|---|---|
| `objects` set | `workspace` | materialize/head сразу; обязана предшествовать referencing shift; delete при существующей provenance/FK ссылке — `parent-in-use` rollback |
| `users` set | identity/global workspace contract | materialize/head сразу; обязана предшествовать referencing shift; delete всегда soft-disable/tombstone и сохраняет FK; physical delete при provenance/audit FK — `parent-in-use` и online не выполняется |
| `shift` set | `workspace`; `workspace_objects(workspace_id,object_id)`; `app_users(opened_by_uid)` и непустые normalized v2 fields | отсутствие object/user или malformed snapshot — ошибка и rollback; shift никогда не staging; runtime v1 — `protocol-upgrade-required` |
| `trucks` set | `workspace` | materialize/head сразу; malformed truck — rollback |
| `truckStatus` set | canonical shift `(workspace_id,shift_id)` и truck `(workspace_id,truck_id)`; `truck_id=document_id` | stage, если shift и/или truck ещё нет |
| `logs` set | canonical shift `(workspace_id,shift_id)` и truck `(workspace_id,truck_id)`; `log_id=document_id` | stage, если shift и/или truck ещё нет |
| любой delete | document key; parents не требуются | применить tombstone/delete сразу |

Promotion запускается после materialization как shift, так и truck и выбирает pending по обоим routing indexes; документ применяется только когда **все** parents существуют. Отсутствующие object/user родителя shift не считаются out-of-order transport и не создают staging.

#### `replica_document_heads`

Persistent head ledger доказывает возраст canonical row и сохраняет tombstone после удаления:

| Столбец | Тип/ограничение |
|---|---|
| `workspace_id` | `text NOT NULL` |
| `collection` | `text NOT NULL CHECK (collection IN ('objects','users','shift','trucks','truckStatus','logs'))` |
| `document_id` | `text NOT NULL CHECK (btrim(document_id)<>'' AND document_id !~ '/')`; exact last path segment: object key=`object_id`, user key=`uid`, shift key=`shift_id`, truck/status key=`truck_id`, log key=`log_id` |
| `head_seq` | `bigint NOT NULL` |
| `stream_direction` | `text NOT NULL DEFAULT 'f2s' CHECK (stream_direction='f2s')` |
| `head_kind` | `text NOT NULL CHECK (head_kind IN ('doc.set','doc.delete'))` |
| `shift_id` | `text NULL` routing snapshot; для shift set/delete равно document_id, для status/log set обязателен |
| `truck_id` | `text NULL`; для trucks/truckStatus set/delete всегда document_id, для log set обязателен |
| `object_id` | `text NULL`; для objects set/delete и shift set равно canonical object key |
| `user_uid` | `text NULL`; для users set/delete и shift set с source opener равно canonical UID |
| `applied_seq` | `bigint NULL` |
| `canonical_present` | `boolean NOT NULL` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |

PK `(workspace_id,collection,document_id)`. FK `(workspace_id,stream_direction,head_seq) → replica_stream(workspace_id,direction,seq) ON DELETE RESTRICT`; nullable FK `(workspace_id,stream_direction,applied_seq) → replica_stream`; collection-shape checks. Exact row-state CHECK допускает только три состояния:

```sql
CHECK (
  (head_kind='doc.delete' AND canonical_present=false AND applied_seq IS NOT NULL AND applied_seq=head_seq)
  OR
  (head_kind='doc.set' AND canonical_present=true AND applied_seq IS NOT NULL AND applied_seq=head_seq)
  OR
  (head_kind='doc.set' AND canonical_present=false AND applied_seq IS NULL)
)
```

Unique `(workspace_id,stream_direction,head_seq)`. Indexes `(workspace_id,shift_id,head_seq)`, `(workspace_id,truck_id,head_seq)`, `(workspace_id,object_id,head_seq)`, `(workspace_id,user_uid,head_seq)`. Collection-shape CHECK exact: `objects/users/shift/trucks` никогда pending; их set имеет `canonical_present=true,applied_seq=head_seq`; object/user delete также settled tombstone. Для `objects`: `document_id=object_id`, остальные routing NULL кроме связанного snapshot у shift. Для `users`: `document_id=user_uid`; body UID, если присутствует, обязан совпасть. Для shift/truck/status/log действуют соответствующие identity равенства выше. Every materializable set/delete advances head only by CAS `existing.head_seq < incoming_seq`; equal seq+hash is replay, lower stale no-op, equal identity с иным hash конфликт.

Delete semantics задаются versioned collection policy, а presence verifier — collection-specific, не общим `canonical row exists iff canonical_present`. `replica_collection_policy_v1` фиксирует:

| Collection | Set verifier | Delete verifier |
|---|---|---|
| `objects` | physical row существует, `payload.deleted!=true`, normalized key/revision/source seq согласованы с head | physical row **сохраняется** как soft tombstone: `payload.deleted=true`, archived/deleted source seq/hash равны head; live-catalog projection отсутствует |
| `users` | physical row существует, profile не deleted, canonical status/profile generation согласованы | physical row **сохраняется**: `status='disabled'`, `profile.deleted=true`, tombstone source seq/hash равны head; auth/live-user projection отсутствует |
| `shift` | canonical shift существует и exact strict-v2 generation согласована | canonical shift generation отсутствует; delete разрешён только domain policy и FK closure, historical/archive provenance не стирается |
| `trucks` | canonical truck существует и generation согласована | canonical truck отсутствует только если FK closure допускает physical delete; иначе `parent-in-use` rollback |
| `truckStatus` | current status существует либо ровно одна pending set | current status и pending отсутствуют |
| `logs` | canonical log существует либо ровно одна pending set | canonical log и pending отсутствуют |

`canonical_present=false` у settled delete означает отсутствие **live canonical projection**, а не обязательное отсутствие physical provenance row. Verifier dispatches by `(policy_version,collection,head_kind)` и проверяет exact tombstone fields для objects/users; generic physical-presence assertion для них запрещён. `users doc.delete` атомарно soft-disables, сохраняет UID/FK/provenance; hard delete запрещён при любых provenance/audit FK. `objects doc.delete` soft-archives и увеличивает revision; при active/closing shift, restored context, archive/revision/source provenance либо другом запрещающем FK — `parent-in-use` и rollback всей batch. Hard delete object online запрещён; физическая очистка — отдельная retention maintenance только при полном доказательстве отсутствия ссылок. Для остальных collections declared delete policy выше обязательна и не может молча заменяться soft tombstone. Repeated same delete replay не меняет revision/timestamp; newer delete после recreate создаёт новую tombstone generation. Canonical replica mutations legal only while locked head equals incoming seq.

#### `replica_pending_documents`

Payload is never copied: it is read by exact FK from immutable `replica_stream.payload`, then collection/path/data and hash are revalidated before promotion.

| Столбец | Тип/ограничение |
|---|---|
| `workspace_id` | `text NOT NULL` |
| `collection` | `text NOT NULL CHECK (collection IN ('truckStatus','logs'))` |
| `document_id` | `text NOT NULL CHECK (btrim(document_id)<>'')` |
| `stream_seq` | `bigint NOT NULL` |
| `stream_direction` | `text NOT NULL DEFAULT 'f2s' CHECK (stream_direction='f2s')` |
| `shift_id` | `text NOT NULL CHECK (btrim(shift_id)<>'')` |
| `truck_id` | `text NOT NULL CHECK (btrim(truck_id)<>'')` |
| `log_id` | `text NULL` |
| `missing_shift` | `boolean NOT NULL` |
| `missing_truck` | `boolean NOT NULL` |
| `staged_at` | `timestamptz NOT NULL DEFAULT now()` |

PK `(workspace_id,collection,document_id)`. Unique `(workspace_id,stream_direction,stream_seq)`. FK `(workspace_id,stream_direction,stream_seq) → replica_stream(workspace_id,direction,seq) ON DELETE RESTRICT`; composite FK `(workspace_id,collection,document_id,stream_direction,stream_seq) → replica_document_heads(workspace_id,collection,document_id,stream_direction,head_seq) ON DELETE CAS` backed by unique head key+seq. Checks: at least one missing flag true; `truckStatus → truck_id=document_id AND log_id IS NULL`; `logs → log_id=document_id`; referenced stream is v2 `doc.set`, `direction='f2s'`, and exact routing/identity matches. Indexes `(workspace_id,shift_id,collection,document_id)` and `(workspace_id,truck_id,collection,document_id)` support promotion. Pending содержит только current unmaterialized set head; delete не нуждается в parents, удаляет pending и остаётся persistent tombstone в heads.

Cross-table transactional invariant: каждая head row в состоянии pending set (`head_kind='doc.set'`, `canonical_present=false`, `applied_seq IS NULL`) имеет **ровно одну** matching pending row с теми же `(workspace_id,stream_direction,collection,document_id,head_seq=stream_seq)`; materialized set и settled delete имеют zero pending rows. Обычный CHECK этого доказать не может. Все runtime transitions выполняются одной transactional `SECURITY DEFINER` function, а `DEFERRABLE INITIALLY DEFERRED` constraint triggers на обеих таблицах в конце transaction проверяют обе стороны и отклоняют orphan/extra pending. Прямой runtime DML на heads/pending revoked. Exact restore также обязан пройти эти deferred triggers перед commit. Contract tests отдельно пытаются commit: pending head без row, row без pending head, две logical rows/несовпавший seq, pending row у materialized/delete, а также `applied_seq IS NULL` у settled delete и materialized set; каждый случай обязан откатиться.

#### Head/tombstone state machine

- `set→set`: newer seq replaces head; if parents exist, canonical upsert and `applied_seq=head_seq`; otherwise canonical row for that key is removed (если был), pending is replaced. Old shift arrival cannot resurrect it.
- `set→delete`: newer delete advances head, removes mutable canonical status/log/shift generation where allowed, deletes pending, sets `applied_seq=head_seq`, `canonical_present=false`. Для objects/users `canonical_present=false` означает, что live catalog entity отсутствует, но physical row остаётся soft archived/disabled как provenance tombstone; presence verifier учитывает это documented exception. `truckStatus` delete всегда имеет non-null `truck_id=document_id`; only `shift_id` may be unknown/null.
- `delete→set`: newer seq is a valid new generation, including reused log ID. It materializes or stages by current parents. Older set/delete can never pass head CAS. Log ID reuse therefore follows stream generation, not a permanent identity ban.
- Status A→pending B removes canonical A before commit, stages B and points head to B. Arrival A sees no matching head; arrival B may promote. Pending→delete leaves no pending/canonical and a settled tombstone, so later parent arrival does nothing.

Heads/tombstones and their referenced stream rows are retained at least as long as any backup/replay/idempotency horizon. Compaction is a separate maintenance operation, never inline: under the same locks it may delete only a settled tombstone and old stream prefix when no backup, receipt, pending/head FK or cursor/journal consumer references it; it records a signed/checksummed low-water mark per direction. No compaction is included in stage 4 rollout.

#### Transaction, locks and crash semantics

Exact lock order for append, promotion, delete, checkpoint, exact restore verifier and any future repair is one order only:

1. `pg_advisory_xact_lock(hashtextextended('replica:'||workspace_id||':f2s',0))` (backup/full restore takes both `:f2s` then `:s2f` lexically);
2. `replica_cursor WHERE workspace_id=? FOR UPDATE`;
3. existing `replica_document_heads` and `replica_pending_documents` rows `FOR UPDATE` in `(collection,document_id)` PK order; absent document keys are serialized by the workspace lock;
4. parents in one order: `app_users` by uid, `workspace_objects` by object id, `line_trucks` by truck id, then `shifts` by shift id; `FOR KEY SHARE` for read or `FOR UPDATE` for mutation. Same-batch topological materialization follows this order;
5. `line_truck_statuses FOR UPDATE` by truck id;
6. `line_logs FOR UPDATE` by log id;
7. referenced stream head/receipt rows as applicable; stream INSERT itself takes no prior row lock.

No path locks stream/status/log before pending/head. Promotion invoked by shift/truck materialization remains inside the same outer transaction and reuses already-held locks; it does not reacquire in another order.

`appendReplicaBatch`: (a) prevalidate entire batch and in-batch duplicates before writes; (b) BEGIN, auth/authority, locks 1–3, verify persisted duplicates/hash and base seq; (c) assign seq and INSERT immutable stream row; (d) advance head by seq CAS; (e) lock/check parents and materialize or replace pending; (f) promote newly satisfiable pending in PK order; (g) update cursor last; (h) COMMIT. Same-id/hash persisted replay consumes no seq and performs no materialization. Journal-only operation inserts stream and advances cursor without head.

Fault at any boundary—after stream insert, head advance, canonical delete/upsert, pending replace, promotion or before cursor—rolls back stream, head, canonical, pending and cursor together. A batch remains atomic; malformed document rolls back all fresh operations. Real concurrent tests use separate connections, observed lock waits and bounded `lock_timeout`/`statement_timeout`, not only Promise ordering.

#### Immutable stream and role boundary

026 makes stream append-only at DB level. Migration objects are owned by a non-login migration owner. The ordinary API/runtime role is distinct, receives no direct `UPDATE`/`DELETE` on `replica_stream` and no table-owner/superuser bypass; a `BEFORE UPDATE OR DELETE` trigger raises `replica-stream-immutable` even if grants drift. Runtime gets INSERT/SELECT and head/staging DML only through reviewed functions or least-privilege grants. If current deployment still runs as table owner, rollout is blocked until the migration-owner/runtime-role split is created and connection credentials switched; trigger alone is not claimed as a security boundary.

Exact restore uses a separate NOLOGIN restore owner plus a narrowly granted `SECURITY DEFINER restore_replica_exact(...)` entrypoint (fixed `search_path`, owner-qualified objects, input temp tables owned by caller, no arbitrary identifiers/dynamic SQL). `PUBLIC`/runtime have no EXECUTE; a separate non-runtime maintenance executor receives explicit temporary EXECUTE only after destructive approval and exact owner/signature/body-checksum preflight, then grant is revoked and verified. It permits INSERT of original stream rows into empty workspace range, never UPDATE history; DELETE is allowed only through static branches for clearing the validated target workspace before insert in the same transaction. Authorization is ownership+EXECUTE only: custom GUC, advisory lock, `current_user`, session marker and `session_replication_role` are not capabilities. Tests prove runtime/direct SQL cannot update/delete/invoke/SET ROLE, forged GUC or advisory lock cannot bypass, and temporarily granted controlled exact restore can insert then validate exact bytes/hashes.

#### Full exact backup/restore policy

Full exact provenance bundle is indivisible: manifest/schema/checksums/authority and restore markers; global `app_users` dependencies; workspace objects/trucks; canonical shifts, members, statuses/logs/history/detached trips and domain children; complete archive series + every immutable revision byte/hash/link/publication; restored contexts, dedicated children and immutable migration evidence; tabel/material/game/reward effects; historicalization report bytes/confirmations, historicalization/legacy-resolution/archive/line/service audit and all receipts; replica stream, heads, pending, cursors and import/compaction markers. A restore request that selects/deselects any replica-owned shift/status/log/parent/transport member, archive revision chain without source/publication/evidence closure, restored context without children/audit/receipts, либо historical row без exact report/confirmation/audit отклоняется during normalization/preflight **before checkpoint creation, DELETE, INSERT or restore_epoch mutation**. Non-replica sections selective only when static FK/dependency closure proves they neither own nor reference bundle rows. Offline rebuild/replay from stream is not an alternative.

Restore разделён на privileged bootstrap и data restore. Bootstrap выполняется **до** data transaction отдельным allowlisted deployment step: создаёт/проверяет roles, schema, extensions, functions, grants и migration/authority registry до exact manifest versions. Он не читает bundle data, не создаёт application users/owner account/registration code, не меняет workspace/restore_epoch и не зависит от restored rows. Data restore fail-closed проверяет bootstrap fingerprint и не имеет `CREATE ROLE`, role-membership, DDL/function replacement либо пути создать первоначального admin/role/code; `app_users` восстанавливаются только как bundle data. Отсутствующий/неверный bootstrap даёт `restore-bootstrap-required` до checkpoint/mutation.

Checkpoint takes f2s/s2f advisory locks and cursor row, then head/pending keys, parents and children in the common lock order, producing one repeatable exact image. Единственный нормативный restore order для всего документа:

1. **до data restore** privileged bootstrap создаёт/проверяет exact roles/schema/functions/grants/migration+authority registry и публикует fingerprint; никаких application users/roles/codes/data;
2. вне data transaction проверить bootstrap fingerprint, manifest/schema version/checksums, authority, target identity, role boundary и destructive approval; построить полный plan и отклонить selective request до checkpoint/mutation;
3. в maintenance data transaction взять advisory locks `f2s→s2f`, cursor и workspace lock; проверить target/restore epoch, отложить только явно DEFERRABLE FK/triggers;
4. вставить `app_users`, `workspace_objects`, `line_trucks` и прочие независимые catalog parents как exact bundle rows;
5. вставить canonical `shifts`, memberships и detached/domain parent rows; затем archive series и все immutable revision bytes/link metadata; затем `restored_shift_contexts`;
6. вставить children: canonical statuses/logs/history/tabel/material/game/reward и restored context logs/status snapshots/history;
7. вставить append-only archive publications/migration evidence, historicalization report bytes+confirmations, historicalization/legacy-resolution/archive/line/service/restored audits, затем все receipts; audit идёт раньше receipt только как restore insertion order, runtime atomic semantics не меняется;
8. вставить immutable `replica_stream` с original direction/seq/time/hash/version, затем `replica_document_heads`, затем `replica_pending_documents`, и последними `replica_cursor` + import/compaction/restore markers;
9. выполнить `SET CONSTRAINTS ALL IMMEDIATE`: в частности оба `fk_archive_publication_*_receipt` обязаны разрешиться до verifier; missing/dangling/wrong-workspace restore/finalize receipt откатывает transaction. Затем выполнить archive chain/latest-pointer byte/hash equality, evidence/report-confirmation binding, collection-specific head verifier, exact counts/SHA-256/provenance equality, stream continuity и no-orphan checks; только после успешного constraint checkpoint и verifier increment/record restore epoch и COMMIT. Любая ошибка откатывает data transaction целиком.

Никакой другой раздел/plan не может задавать иной порядок; ссылки на restore обязаны ссылаться на этот список. Restore не классифицирует и не улучшает legacy, не вызывает ordinary materializer/close и не генерирует новые actor/time/revision.

Validation requires the same direction-aware continuity contract as 026 preflight: native un-compacted f2s exact `1..f2s_seq`, otherwise strictly ordered marker-covered subsequences; s2f ordered subsequence to its cursor with every gap justified by versioned marker; no row beyond corresponding cursor and no renumbering. Operation IDs/hashes/version markers remain valid without rewriting legacy v1; every head/pending/applied seq references matching f2s stream; deferred cross-table invariant proves exactly one pending row only for pending-set head. Для документов с replica head применяется только collection-specific verifier из delete policy: objects/users settled delete обязаны иметь exact physical soft tombstone при отсутствии live projection; shift/trucks/status/logs следуют объявленной physical delete/pending policy. Native/non-replica canonical rows **без replica head** этим invariant не охватываются и сохраняются согласно full-bundle manifest. Archive revisions образуют contiguous hash-linked chain, `latest_finalized_*` точно указывает последнюю published revision, original/import bytes не изменены; context/evidence/publication/report-confirmation FK closure полна. Все app_user/object/truck/shift FK resolve. Any mismatch rolls back exact restore. There is no automatic replay/rebuild and no UPDATE of history.

#### Migration boundary, observability and acceptance

025 is unreleased and its checksum intentionally changes: it contains no `replica_placeholder` column/branch/constraint; сохраняет строгими state/object/date/opened_at, но допускает nullable opener/type **только** с независимым marked legacy unresolved contract раздела 4.1/4.8; v2 остаётся полностью NOT NULL. 026 adds staging, heads, stream hash/protocol columns, immutable-role/trigger boundary and dependent attribution. Common DB has neither new migration applied; actual migration/server role change/deploy still requires owner-approved window. Once 025 is applied, **any build mentioning `replica_placeholder` is prohibited regardless of whether placeholder rows exist**; rollback is only a compatible transitional/new server or maintenance forward-fix. Stream/heads/pending are never dropped. API/client-visible behavior is unchanged.

Audit/metrics expose pending counts/oldest age by collection and missing-parent class, head supersession/delete/promotion/conflict/rollback, cursor lag, lock wait/timeout and promotion duration. Logs contain correlation, seq, hash version, hashed operation/document/shift IDs and stable error code; never payload/PII.

Required tests:

- status A becomes pending for B, arrival A does nothing, arrival B promotes; repeat with missing truck, and with shift/truck arriving in both orders;
- pending set→newer set, pending→delete with no resurrection, status to another shift, log set→delete→set generation reuse;
- objects/users set создают exact heads и parent rows; same set/delete replay сохраняет seq/revision/tombstone; newer recreate→delete следует generation CAS. User delete всегда soft-disables и сохраняет provenance FK; попытка physical user delete при ссылках даёт `parent-in-use`. Object delete soft-archives, а referenced object даёт `parent-in-use`; hard delete отсутствует. Body/path identity mismatch для object/user и multi-document payload откатывают batch;
- delete before/after promotion; truckStatus delete has document truck key even with unknown shift; data.id/path mismatch and multi-document payload rollback;
- same v2 id/hash in one batch and across replay is no-op; same id different kind/hash/version conflicts; legacy v1 rows remain byte/hash stable;
- concurrent append/promotion/newer set/delete uses real lock waits/timeouts and leaves one head; crash injection after every transaction boundary leaves no partial state;
- immutable stream UPDATE/DELETE denied to runtime and trigger bypass attempts; exact restore role/mode succeeds only through controlled API;
- backup containing pending and settled delete restores exact stream/head/pending/canonical/cursors, then parent arrival promotes once; selective request touching any bundle member is rejected before mutation; archive publication с отсутствующим, dangling либо wrong-workspace restore/finalize receipt падает на explicit `SET CONSTRAINTS ALL IMMEDIATE` до verifier/restore epoch/commit;
- 026 preflight на реальных v1 fixtures: native f2s exact range проходит; marker-covered interleaved/directional subsequence проходит; gap без marker, duplicate/ambiguity, missing head row и row beyond f2s/s2f cursor откатывают всю migration без PK/hash rewrite;
- deferred head↔pending triggers отвергают orphan/mismatch/extra pending и pending у materialized/delete; exact restore проходит те же triggers;
- f2s/s2f cursor continuity, app_users/object/truck dependencies, malformed snapshots и все FK/hash/head postconditions fail closed; native canonical row без replica head не ошибочно считается отсутствующей;
- old `{}`/placeholder fixtures/tests are replaced, not relaxed: fixtures use either a full strict v2 canonical snapshot or an exact explicitly marked v1 legacy snapshot with independent unresolved dimensions; no fixture may invent UID/type.

Rollback preserves data: before applying 025, old build remains possible; after 025, placeholder-aware builds are forbidden. Before first 026 write, a compatible transitional server may ignore additive tables; after any v2 stream/head write, only compatible new server or forward-fix under maintenance is allowed. Database restore remains separately destructive and requires explicit owner approval.

## 5. Versioned API v2

Все маршруты ниже имеют префикс `/api/v2`, Firebase bearer auth и workspace из серверной конфигурации/session, а не из доверенного body. Успех команды возвращает receipt envelope:

```json
{"protocolVersion":2,"operationId":"...","replayed":false,"result":{}}
```

Ошибки: `{ "protocolVersion":2, "error":"stable-code", "details":{...safe} }`. `400` schema, `401` auth, `403` известный доступ без права, `404 shift-not-visible`, `409` domain/CAS/idempotency, `410 shift-closed` для replay к закрытой смене, `426 protocol-upgrade-required`, `503 maintenance`.

### 5.1. List и snapshot

**GET `/api/v2/shifts?state=active,closing&limit=50&cursor=<opaque>`**
Ответ `200`: `{items:[{shiftId,objectId,objectName,workDate,shiftType,state,openedAt,shiftRevision,memberRevisionSummary,pendingServerReceipts}],nextCursor}`. Limit 1..100. Admin видит все; прораб — active membership. Pagination обязательна, сортировка `opened_at DESC, shift_id`.

**GET `/api/v2/shifts/{shiftId}/snapshot`**
Ответ `200`: `{protocolVersion:2,workspaceId,shiftId,shiftRevision,shift,members,statuses,logs,detachedOpenTrips,revisions:{...},serverGeneration}`. Snapshot маркирован `workspaceId/shiftId/shiftRevision`; каждая status/log сущность также содержит shiftId. `detachedOpenTrips` содержит доступные пользователю open записи, где эта смена source или текущая destination, с обоими shift labels и только безопасными полями для UI. `404` для отсутствующей и невидимой смены.

### 5.2. Создание и метаданные

**POST `/api/v2/shifts`** body:

```json
{"operationId":"...","protocolVersion":2,"objectId":"...","workDate":"2026-11-23","shiftType":"day","cycleMinutes":30}
```

`201` с shift + membership; replay `200`. `409 shift-duplicate`.

**PATCH `/api/v2/shifts/{shiftId}/object`** body `{operationId,protocolVersion:2,objectId,expectedShiftRevision}`. `200` новая shift. `409 object-locked|shift-duplicate|shift-changed`. Разрешено только `state=active` до lock.

### 5.3. Memberships

**POST `/api/v2/shifts/{shiftId}/members`** body `{operationId,protocolVersion:2,uid,expectedShiftRevision,expectedMembershipRevision:null|number}`. `200`; реактивация обновляет строку.
**DELETE `/api/v2/shifts/{shiftId}/members/{uid}`** body `{operationId,protocolVersion:2,expectedShiftRevision,expectedMembershipRevision}`. `200`; `409 last-shift-member|membership-changed`.

### 5.4. Техника и line events

**POST `/api/v2/shifts/{shiftId}/trucks`** body `{operationId,protocolVersion:2,truckId,expectedShiftRevision}`. `200`; `409 truck-assigned-to-other-shift` с `details` для предупреждения (`sourceShiftId`, объект, дата, day/night, незавершённая стадия без лишних персональных данных).
**DELETE `/api/v2/shifts/{shiftId}/trucks/{truckId}`** body `{operationId,protocolVersion:2,expectedShiftRevision,expectedStatusRevision,expectedCycleRevision,expectedTtnRevision}`. `200`; `409 truck-cycle-incomplete|truck-detached-trip-open|revision-conflict`.

**POST `/api/v2/shifts/{destinationShiftId}/trucks/{truckId}/force-transfer`** body `{operationId,protocolVersion:2,sourceShiftId,expectedSourceShiftRevision,expectedDestinationShiftRevision,expectedStatusRevision,expectedCycleRevision,expectedTtnRevision,confirmTransfer:true}`. Сервер заново проверяет право, memberships, обе active shifts, source assignment и все CAS. В одной транзакции блокирует truck, обе shifts и status в стабильном порядке; при незавершённом цикле создаёт detached row; переносит current status в destination как чистое назначение; увеличивает обе shift revisions; пишет receipt и audit (`actor/time/from/to/cycle/stage/consequences`). Без `confirmTransfer:true` mutation не выполняется. `409 transfer-context-changed|truck-detached-trip-open|revision-conflict`.

**POST `/api/v2/shifts/{sourceShiftId}/detached-trips/{cycleId}/complete`** body `{operationId,protocolVersion:2,truckId,destinationShiftId,type,...typeFields,expectedSourceShiftRevision,expectedDestinationShiftRevision,expectedDetachedCycleRevision}`. Только online. Сервер допускает admin либо активного участника source **или текущей destination** с обычным правом соответствующего завершающего line action; блокирует detached row, current status и обе shifts. Команда может только завершить сохранённую стадию, записывает результат и все производные эффекты в source shift, помечает detached `completed`, не меняет стадии/current cycle destination status и аудирует завершившего. Replay идемпотентен.

> **Уточнение по факту реализации (27.11.2026, Tasks 20/29C).** Два поля тела здесь не перечислены, но сервер их требует и сверяет — это фактический контракт, подтверждённый `server/src/shift-transfer-v2.mjs` и `server/tests/v2-detached-completion-db.test.mjs`:
> - `sourceShiftId` — читается из тела и сверяется со сменой в пути (`409 transfer-context-changed` при расхождении); смена не может быть задана только путём;
> - `createdAt` — обязательный timestamp (`400 invalid-command {field:'createdAt'}` без него).
>
> То же для `force-transfer`: смена назначения обязана быть и в теле (`destinationShiftId`), и в пути. Клиент, отправлявший её только в пути, не мог выполнить ни перевод, ни завершение рейса; найдено приёмкой в настоящем браузере (уроки 58–59 в `docs/opyt-oshibok.md`).

**POST `/api/v2/shifts/{shiftId}/line-operations`** body включает `{operationId,protocolVersion:2,type,truckId,expectedShiftRevision,expectedStatusRevision,expectedCycleRevision,expectedTtnRevision,...typeFields}`. Path shiftId обязан совпасть с immutable body/hash context; response содержит новые shift/status/cycle/ttn revisions. Первый confirmed `arrive` фиксирует объект. Обычный endpoint никогда не обращается к detached trip.

### 5.5. Закрытие

**POST `/api/v2/shifts/{shiftId}/close/prepare`** body `{operationId,protocolVersion:2,expectedShiftRevision}`. `200`: `{phase:'prepared',closeToken,shiftRevision,archiveId,archiveRevision,materialMarkerRevision}`. Идемпотентный replay возвращает тот же результат.

**POST `/api/v2/shifts/{shiftId}/close/finish`** body `{operationId,protocolVersion:2,closeToken,expectedShiftRevision,expectedArchiveRevision,expectedMaterialMarkerRevision}`. `200`: `{phase:'closed',...}`. Pending server receipts/inflight line operations и open detached trips, где смена является source или destination, блокируют prepare/finish (`409 pending-operations|detached-trip-open`); неизвестные офлайн-очереди не могут быть учтены и позднее получают `410`.

Пустая смена закрывается: archive создаётся с нулевыми итогами, material marker не требуется. Memberships сохраняются как история. На finish удаляются только текущие `line_truck_statuses` этой смены; logs/history, shift, memberships, receipts, audit, archive и marker сохраняются. Никаких workspace-wide DELETE.

### 5.6. Archive revisions и restored archive

**GET `/api/v2/archives?limit&cursor`** возвращает по одной latest-finalized projection на series: `{archiveId,sourceShiftId,archiveRevision,archiveSha256,...summary}`. List/open/report/material/analytics/export используют эту же revision; cursor включает series revision и latest pointer.

**GET `/api/v2/archives/{archiveId}`** без revision читает latest finalized. **GET `/api/v2/archives/{archiveId}/revisions`** возвращает immutable chain metadata; **GET `/api/v2/archives/{archiveId}/revisions/{revision}`** и `/export` возвращают explicit revision и exact bytes/hash, не меняя default. Все endpoints повторно проверяют archive ACL; history/export audit фиксирует actor, archive/revision/hash без payload/PII.

**GET `/api/v2/archives/{archiveId}/restored?revision=<n>`** → `200 {archiveId,sourceShiftId,archiveRevision,archiveSha256,restoredContextId,contextRevision,shiftSnapshot,trips,ttn,provenance}` по существующему archive/tabel ACL, с pagination вложенных рейсов через `?limit&cursor` при >100. Без `revision` выбирается latest finalized на момент транзакции; receipt привязывает exact revision/hash. `provenance` содержит original opener/type + resolution и отдельного restoring actor. Для unresolved UI возвращает явные тексты «автор не установлен» / «тип смены не подтверждён», а не fallback.

**POST `/api/v2/archives/{archiveId}/operations`** body `{operationId,protocolVersion:2,restoredContextId,type:'trip.update'|'trip.delete'|'ttn.update'|'ttn.delete',recordId,expectedContextRevision,expectedBaseArchiveRevision,expectedBaseSha256,...}`. `200`; `409 archive-changed`. Другие type → `400 archive-operation-not-allowed`.

**POST `/api/v2/archives/{archiveId}/restored/{restoredContextId}/finalize`** body `{operationId,protocolVersion:2,expectedContextRevision,expectedBaseArchiveRevision,expectedBaseSha256}`. `200` возвращает `{archiveId,archiveRevision,archiveSha256,contextState:'finalized'}`. Publication атомарна по контракту §4.6; failure оставляет pointer/context/chain untouched. Restored режим не вызывает active endpoints.

## 6. Авторизация

Проверяются независимо: активный `app_users`, глобальная role/action matrix, active membership (кроме admin), принадлежность ресурса workspace+shift.

| Действие | Роль/право | Membership |
|---|---|---|
| list/snapshot active shifts | admin либо `senior_foreman`/`foreman` + `tab_line` | admin: нет; прочие: да |
| create shift | admin либо прораб + `start_shift` | создаётся автоматически |
| change object | admin либо прораб + `edit_line` | да, кроме admin |
| add/remove member | admin либо прораб + новое `manage_shift_members` | да, кроме admin |
| add/remove truck | admin либо прораб + `manage_trucks`/`edit_line` | да, кроме admin |
| force transfer truck | только admin/`senior_foreman` + новое `force_transfer_truck` | admin: нет; senior: обязательна destination membership; source доступ даёт именно это cross-shift право |
| arrive/load/ttn/reset | соответствующее существующее action; reset — `line_timer_reset` | да, кроме admin |
| complete detached trip | admin либо участник source или текущей destination + право завершающего action | хотя бы одна из двух смен, кроме admin |
| close prepare/finish | `close_shift` | да на каждом запросе, кроме admin |
| archive read/edit/delete | существующие `tab_archive`, `archive_edit`, `archive_delete` | active membership не требуется; archive ACL не меняется |
| tabel | существующие `tab_timesheet`/timesheet actions | active membership не подменяет tabel ACL |

Новое action называется `force_transfer_truck`; миграция добавляет его в серверный allow-list и матрицу с default deny, включает по умолчанию для `admin` и `senior_foreman`, не включает для `foreman`. Admin может затем менять матрицу тем же способом, что `line_timer_reset`; роль сама по себе без action недостаточна.

`worker`/`driver` не становятся участниками и не получают active line read/write через membership. Removed member получает 404 на read и `403 not-shift-member` на известную команду; повтор receipt не выдаётся до повторной проверки текущего ACL. Для detached completion доступ пересчитывается на каждый запрос: достаточно актуальной membership source или destination; снятие из одной не лишает доступа через другую. Closing запрещает новые line/member/truck/object команды; разрешены snapshot и close finish авторизованному участнику/admin.

## 7. CAS-матрица

| Команда | Expected | Меняет |
|---|---|---|
| create shift | operation hash; DB duplicate key | shift rev=1, creator membership rev=1 |
| change object | shift rev | shift rev +1 |
| add/reactivate member | shift rev, membership rev/null | membership rev +1; shift rev +1 |
| remove member | shift rev, membership rev | membership rev +1; shift rev +1 |
| add truck | shift rev; отсутствие assignment | status/cycle/ttn rev=1; shift rev +1 |
| remove truck | shift, status, cycle, ttn rev; нет open detached | удаляет current status; shift rev +1 |
| force transfer | source+destination shift rev, source status/cycle/ttn rev; truck lock; нет open detached | current status переходит в destination и очищает cycle; при incomplete создаётся detached rev=1; обе shift rev +1 |
| complete detached trip | source+destination shift rev, detached cycle rev; current assignment всё ещё destination | detached rev +1/state completed; source logs/trip/effects/revisions; destination status/cycle не меняются |
| arrive/load/ttn/reset | shift, status, cycle, ttn согласно type | status rev +1; затронутая cycle/ttn rev +1; первый arrive также shift rev +1 из-за lock |
| close prepare | shift rev; отсутствие pending receipts/open detached | state→closing, shift rev +1; archive rev=1/сверка; marker без изменения |
| material confirm | shift/close token, archive rev, marker rev/null | marker rev +1 идемпотентно |
| close finish | shift, archive, marker revisions + close token | state→closed, shift rev +1; удаляет statuses только shift |
| archive trip/TTN edit/delete | restored context rev + base archive revision/hash | context rev +1 и restored audit; immutable archive chain/latest pointer не меняются до finalize |
| finalize restored context | context rev + base archive revision/hash + operation hash | атомарно next immutable archive revision/publication, context→finalized, latest pointer CAS; original bytes и active/material revisions не меняются |

CAS mismatch всегда `409` и не выполняет частичный update. Receipt записывается в одной транзакции с mutation/audit.

## 8. Клиент, поздние ответы и presence

Состояние:

- `shiftsById`;
- `activeShiftId` — единственный источник выбранной открытой линии; хранится по ключу `uid/workspaceId` и восстанавливается только если смена по-прежнему видима и имеет состояние `active` или `closing`;
- `contextsByShiftId[shiftId]` содержит snapshot, revisions, forms, scroll, inflight, pending;
- `detachedTripsByKey[sourceShiftId:cycleId]` хранит один объект, на который source/destination contexts только ссылаются; optimistic mutation не применяется;
- `restoredContext` полностью отдельно и не меняет `activeShiftId`.

Переключение нижней вкладки выполняется одной клиентской транзакцией: сначала выбирается целевой `activeShiftId`, затем шапка, карточки самосвалов, рейсы, отчёт, доступные действия, presence и pending-проекция читаются только из `contextsByShiftId[activeShiftId]`. Частичное переключение отдельных панелей запрещено. Если context ещё не загружен, экран показывает scoped loading для выбранной смены, но не оставляет данные прежней. Формы, фокус и прокрутка сохраняются раздельно в context каждой смены.

Каждая загрузка получает локальный монотонный `requestGeneration` на `(uid,workspace,shiftId,requestKind)`. Ответ применяется только если совпадают `uid`, `workspaceId`, `shiftId`, текущая generation и не старее shift revision. Cross-shift response force transfer/detached completion применяется только после сверки **обоих** shiftId и revisions; иначе оба context перечитываются. Поздний A никогда не меняет B. Ответ фоновой смены может обновить только её собственный context и индикатор вкладки, но не видимый экран другой смены.

Presence key: `workspaceId:shiftId`; payload также содержит uid и client instance. Presence A не отображается в B. Archive presence, если нужен, имеет отдельный namespace `workspaceId:archive:archiveId`.

## 9. Offline protocol v2

Каждая persisted command содержит неизменяемые:

`uid`, `workspaceId`, `shiftId`, `protocolVersion:2`, `operationId`, `commandType`, canonical body, исходные expected revisions, `createdAt`, `commandHash`.

`commandHash = SHA-256` от канонического JSON всех семантических полей, включая uid/workspace/shift/protocol/operation. При replay ничего из них не заменяется текущим account/selected shift.

Storage физически/логически разделён по `uid/workspaceId/shiftId/protocolVersion`; проекции и dead-letter также scoped. При смене аккаунта очередь предыдущего uid не отправляется и не показывается как очередь нового; она остаётся запечатанной до возврата того же uid либо явного локального удаления пользователем.

Replay:

- closed shift → permanent rejected `shift-closed`, в dead-letter;
- removed membership → `not-shift-member`, не переадресуется;
- protocol mismatch/старый клиент → `426 protocol-upgrade-required`;
- changed revision/truck moved → явный conflict;
- повтор с тем же hash возвращает receipt, другой hash — conflict.

`force-transfer` **никогда не ставится в offline queue**: кнопка доступна только при подтверждённом online, а потеря связи до receipt приводит к безопасному повторному GET и replay того же operationId, не к новому переводу. `detached-trip complete` также online-only из-за cross-shift CAS; офлайн UI показывает блок read-only и причину. Обычные line-команды B продолжают использовать очередь B и не могут завершить detached trip A.

Серверный признак «это не офлайн-конверт» один и тот же для обеих команд: заголовок `x-samosval-offline` со значением `1`/`true` даёт `409 online-required` **до** мутации (сразу после проверки личности, чтобы не отвечать `409` анонимному клиенту), поэтому повтор из очереди не может стать вторым переводом. Клиент этих команд заголовок не ставит и в очередь их не кладёт; проверка существует, чтобы такой повтор был отказом, а не догадкой.

Общий pending badge — сумма, карточка смены — только её очередь. Logout/обновление PWA не стирают очередь.

## 10. UX, табель, материал, архив и отчёты

### 10.1. UX sketch вкладки «Линия»

Вкладка «Линия» содержит внутренние переключатели открытых линий/смен и на мобильном viewport 393×852 строится сверху вниз так:

```text
┌─────────────────────────────────────┐
│ Объект: Невский проспект            │
│ 23.11.2026 · Ночь                   │  ← шапка activeShiftId
├─────────────────────────────────────┤
│                                     │
│ карточки самосвалов                 │
│ рейсы и действия выбранной смены    │  ← прокручиваемая область
│ отчёт/оставшиеся рейсы этой смены   │
│                                     │
├─────────────────────────────────────┤
│ Невский · Ночь  •2 │ Пулково · День│  ← горизонтальная полоса смен
├─────────────────────────────────────┤
│ глобальное нижнее меню приложения   │
└─────────────────────────────────────┘
```

- В верхней части всегда видны объект, календарная дата и тип выбранной смены (`День`/`Ночь`); эти данные берутся только из `activeShiftId`.
- Центральная прокручиваемая область содержит карточки самосвалов, рейсы, отчёт и действия только выбранной смены. При переключении данные прежней смены не остаются даже временно под новой шапкой.
- Непосредственно над глобальным нижним меню расположена отдельная горизонтальная полоса открытых смен. Краткая подпись вкладки: `Объект · День/Ночь`; при необходимости рядом размещаются компактный индикатор состояния (`closing`, offline/conflict) и счётчик pending именно этой смены.
- Выбранная вкладка заметно отличается цветом, контрастом и/или маркером, не только цветом текста. При большом числе смен полоса прокручивается пальцем по горизонтали; выбранная вкладка автоматически доводится в видимую область без сброса вертикальной прокрутки центра.
- Нажатие по вкладке атомарно меняет весь контекст по `activeShiftId`: шапку, машины, рейсы, отчёт, presence и доступные действия. Вкладки не запускают active action сами по себе.
- Полоса участвует в раскладке, а не перекрывает карточки или глобальную навигацию. Высота центральной области учитывает высоты обеих нижних панелей, `100dvh`, `env(safe-area-inset-bottom)` и экранную клавиатуру; последняя карточка и её действия остаются достижимы.
- В полосу входят только видимые пользователю смены в `active`/`closing`. Восстановленный архив открывается отдельным режимом из «Архива», имеет явную архивную плашку и никогда не появляется среди вкладок открытых линий.

### 10.2. Операции, отчётность и связанные экраны

- При обычном add занятого truck прораб видит понятное неблокируемое предупреждение «Самосвал работает в другой активной смене» с исходной сменой; кнопки обхода нет.
- Старший прораб/admin с `force_transfer_truck` видит отдельный крупный confirm, не browser-native confirm: `откуда → куда`, объект/дата/day-night обеих смен, truck, стадия незавершённого цикла и последствия: старый рейс останется в A, новые пойдут в B, завершение старого будет записано в A. Подтверждение должно быть явным (`Перевести самосвал`), cancel — безопасный default; при изменении CAS диалог закрывается и требует заново загрузить данные.
- В source и destination UI всегда показывается отдельный крупный блок **«Рейсы, оставшиеся в прежней смене»** для доступных open detached trips. Каждая карточка крупно повторяет исходную смену, объект, дату, день/ночь, стадию и предупреждение «Действие будет записано в исходную смену …». Блок не смешивается с current truck cards; offline он read-only.
- Shift sheet идентифицируется `shiftId`; display key — `object/day/type`.
- Точный duplicate запрещён, поэтому одновременно не существует двух active листов с одним display key; closed sheet всё равно различается shiftId.
- Месячная агрегация дедуплицирует по `(workspace_id,shift_id,source_record_id)` и считает каждый рейс/час один раз. Day/night агрегируются отдельно, затем суммируются; join по object/day/type без shiftId запрещён.
- Material marker идемпотентен per shift. Завершение detached trip меняет marker **исходной** смены, не destination и не создаёт новый. Archive material/report calculations всегда читают latest finalized revision; edits open restored context marker не меняют, а finalize публикует revision и отдельный material reconcile идемпотентно CAS-обновляет тот же marker по `(source_shift_id,archive_revision)` без изменения revision chain.
- Archive хранит source shiftId, object/date/type, memberships history и snapshot техники. Open detached блокирует закрытие обеих связанных смен, поэтому архив никогда не содержит «полурейса».
- В UI legacy metadata выводится буквально: `Автор не установлен` и/или `Тип смены не подтверждён`; нельзя показывать sender/display/hour-derived fallback. Кнопка ручного уточнения видна только при ACL и открывает форму evidence note с предупреждением не вводить секреты. Эти тексты и простое описание для администратора добавляются в `release-history.js` только на этапе реализации/выпуска; данный design UI-код и release history не меняет.
- Отчёт одной смены принимает shiftId/archiveId; aggregate endpoint явно принимает набор/период. Detached trip до completion показывается в оперативном отчёте A как незавершённый и не считается рейсом; после completion считается ровно один раз в A. В B он не входит ни до, ни после.
- Табель/часы/объёмы и месячная агрегация используют `source_shift_id` завершённого detached trip; перевод truck сам по себе не создаёт рейс, часы или материал.
- Rewards/penalties содержат source shiftId и event identity.

## 11. Закрытие смены

Prepare переводит только указанную смену в `closing`, замораживает line/member/truck/object commands, ждёт/блокирует зарегистрированные server inflight/receipts и запрещён при open detached trip, где смена source или destination; затем строит immutable archive candidate и close token. Другие несвязанные смены продолжают работу.

Finish проверяет token и все revisions, material marker при ненулевых рейсах, соответствие archive источнику. Затем удаляет только current statuses этой смены, ставит `closed`. Сохраняются shift row, memberships, logs/history, receipts/audit, archive и material marker. Пустая смена проходит без material marker. Повтор prepare/finish с тем же operation/hash возвращает прежний результат.

## 12. Workspace-wide query audit

До реализации составляется полный реестр запросов по `shifts`, `line_truck_statuses`, `line_logs`, receipts, history, archive, tabel, material, game, backup/import, controls/reports. Каждый запрос классифицируется:

1. действительно workspace-wide каталог/агрегация;
2. обязан иметь `workspace_id AND shift_id`;
3. admin list с явной pagination.

Особенно пересматриваются `line-read`, `shift-start`, `shift-close`, force-transfer/detached-trip stores, `control-store`, `report-store`, `history-store`, `archive-store/read`, `backup-store`, tabel/material и game economy. Запрещены singleton `LIMIT 1`, очистка всех statuses/logs workspace и поиск «текущей смены» по object/day/type.

Обязательный acceptance invariant: операции, snapshot, close, archive correction, backup section и material shift A **не читают и не меняют B**. Это проверяется query-level тестами с trap rows B и сравнением всех revisions/count/checksums до/после.

## 13. Rollout через окно обслуживания

Старые и новые клиенты одновременно не работают. Время окна и фактический деплой согласуются отдельно. Координированный порядок исключает долгий dual mode:

1. до окна подготовить client writer, server и migrations, но ничего не публиковать в общий канал;
2. в maintenance сначала развернуть transitional server, который читает v1 и v2, запрещает все shift mutations/replica materialization и ещё не создаёт v2 данные;
3. выполнить preflight 025 без mutation. Если report содержит active/closing unresolved-type, показать владельцу exact rows/hash и получить отдельное явное подтверждение historicalization именно этого списка; отказ/изменение списка — abort untouched;
4. после проверенного backup создать/проверить role split до либо атомарно с redesigned 025; controlled historicalization и 025 проходят одной transaction. Затем применить 026, который расширяет роли на staging/heads, но не создаёт исходную security boundary;
5. развернуть server v2 writer/API, затем PWA с Firebase/NAS writer v2; открыть только v2 mutations;
6. старые клиенты получают 426. Порядок «writer v2 раньше schema» запрещён, как и schema с legacy bridge, позволяющим старому клиенту создавать новые unresolved строки.

Поскольку working-test client и server переключаются в одном maintenance window, transitional compatibility длится только внутри закрытого окна.

До окна разрешено: код, миграции и репетиции только на изолированной БД; новая PWA на локальном/изолированном API. Общая инфраструктура и БД не изменяются без явного согласия.

Порядок окна:

1. Получить явное «да» владельца на время окна, server deploy и миграцию общей БД.
2. Включить server maintenance mode: все v1/v2 mutations → `503 maintenance`; reads показывают обслуживание, старые клиенты не пишут.
3. Дождаться завершения inflight; зафиксировать health/schema/data counts.
4. Сделать проверенный full provenance backup фактической общей БД, SHA-256 и пробное чтение/restore verification.
5. Запустить read-only 025 preflight. При active/closing unresolved type migration остаётся без mutation, пока владелец отдельно не подтвердит exact report rows/hash. При отказе — снять попытку, БД untouched, maintenance не открывать как v2.
6. После подтверждения применить role split + historicalization + 025 одной transaction, затем 026; прогнать constraints/backfill/audit и smoke на сервере при закрытом трафике.
7. Развернуть сервер v2. V1 mutation/list/snapshot возвращают `426 protocol-upgrade-required`, а не singleton data.
8. Опубликовать новую тестовую PWA. Сама публикация working-test при зелёных тестах не требует дополнительного «да», но выполняется внутри согласованной последовательности окна.
9. Проверить live manifest/HTML/SW/RECORDS, auth, list/snapshot, две изолированные смены, close и отсутствие console errors.
10. Открыть mutations v2 и снять maintenance. Старый клиент остаётся заблокирован `426` во время и после окна.
11. Наблюдать readiness/error rate и выполнить post-deploy counts.

Rollback:

- до commit 025: transaction rollback оставляет данные/roles/schema untouched; owner decline exact historicalization report означает именно этот путь;
- после commit 025/026, но до первой v2 mutation: оставить maintenance; допустим только проверенный reverse migration по historicalization audit либо full backup restore с отдельным явным согласием владельца — нельзя просто вернуть legacy server, потому что runtime больше не owner и v1 writes закрыты;
- после v2 mutations/двух смен singleton rollback запрещён; вернуть новый server build либо оставить maintenance и исправить вперёд;
- restore общей БД из backup — разрушительная операция, только с отдельным явным согласием владельца;
- production PWA не публикуется этим rollout без отдельного поручения и согласия.

## 14. Ошибки

Минимальные stable codes: `forbidden`, `invalid-shift-v2-provenance`, `parent-in-use`, `replica-operation-conflict`, `replica-stream-immutable`, `shift-not-visible`, `not-shift-member`, `shift-changed`, `shift-closing`, `shift-closed`, `shift-duplicate`, `object-locked`, `membership-changed`, `last-shift-member`, `truck-assigned-to-other-shift`, `truck-not-on-shift`, `truck-cycle-incomplete`, `truck-detached-trip-open`, `detached-trip-not-found`, `detached-trip-completed`, `detached-trip-open`, `transfer-context-changed`, `force-transfer-confirmation-required`, `online-required`, `revision-conflict`, `pending-operations`, `operation-id-reused`, `archive-changed`, `archive-context-required`, `archive-operation-not-allowed`, `protocol-upgrade-required`, `maintenance`.

После 409 клиент обновляет только исходный context; никогда не переносит команду в выбранную смену.

## 15. Проверки и критерии приёмки

### БД/сервер

- Exact Firebase v1 payload `{id,objectName,objectId,startDate,startedAt,startedBy,isActive}` мигрирует без UID/type как independent unresolved; display name, sender UID и hour не используются.
- Exact v2 night payload из §4.7 сохраняет session creator UID, display snapshot и night; replica transport sender, отличный от creator, остаётся только sender и не меняет opener.
- Old archive без type читается/экспортируется с «тип смены не подтверждён»; v2 archive→restoredContext сохраняет original type/opener и отдельно restoring actor.
- Manual resolution: только active admin с exact action; senior deny. Replay повторно проверяет ACL; CAS, canonical advisory lock, idempotent receipt и immutable old/new/evidence/actor/time audit; parallel stale request проигрывает без второй записи. Closed resolution не конфликтует с active uniqueness, activation проверяет duplicate отдельно.
- Trigger/function rejects forged `payloadSchemaVersion=1`, unresolved или NULL UID/type от ordinary runtime; direct DML/GUC не обходит boundary.
- Unresolved historical row доступна history/archive/edit trips, но не active selector, add/move truck, active line commands, object movement или active restore/reactivation. Type resolution само по себе не активирует.
- Malformed timestamp/object/date и v2 missing UID/type fail closed; active v1 missing type никогда не становится day.
- Две смены разных объектов; day/night одного object/date; точный duplicate блокируется конкурентно.
- Первый confirmed arrive атомарно lock object; до него change проходит, после него всегда `object-locked`, включая после удаления рейса.
- Creator membership; реактивация обновляет строку; роли worker/driver отклоняются.
- Foreman видит только membership, admin все; removed member немедленно теряет доступ и не finish close.
- Один current truck status не добавляется в две смены при race; обычный foreman получает предупреждение и не может обойти конфликт.
- Незавершённый цикл блокирует обычный remove; завершённый допускает двухшаговый transfer.
- Senior/admin без `force_transfer_truck` получает 403; с правом и явным confirm выполняет один атомарный transfer A→B. Race/CAS не создаёт двойной status или два detached trip.
- Force transfer незавершённого цикла сохраняет stage/cycle в detached entity A, очищает current status B; новые события обычного endpoint идут только в B.
- Участник A или B завершает detached trip, результат/reward/material/report появляется только в A; повтор/replay не дублирует. После completion он не может выполнить второе завершение.
- Пока detached open, повторный перевод/remove и close A/B блокируются; после completion разрешаются по обычным правилам.
- Force transfer и detached completion отвергаются offline; потеря ответа безопасно разрешается receipt replay и refresh.
- Audit фиксирует actor/time/from/to/cycle/stage и отдельного завершившего; запись append-only доступна в истории A и ссылочно в B.
- Все команды проходят CAS-матрицу и receipt hash включает оба shift context там, где операция cross-shift.
- Empty close успешен; pending receipt блокирует; prepare/finish идемпотентны.
- Archive разрешает только trip/TTN edit/delete в open restored context. Finalize CAS атомарно создаёт ровно одну next immutable revision, publication/audit/receipt и переводит context в finalized; original/base bytes не меняются, failure/replay/concurrency не оставляют partial pointer/revision.
- List/default read/open/PNG/export/material/report/analytics/backup projection используют latest finalized revision; explicit history/read/export открывают original и каждую revision exact bytes/hash и не меняют default.
- Legacy restored migration имеет unique source locator, immutable evidence, exact source bytes/count/table hashes и FK closure; synthetic shift anchor не переносится, ambiguity/hash mismatch abort untouched.
- Tabel/material per shift и месячный итог без двойного счёта.
- Для каждого workspace-wide query тест «A does not read/change B».

### Клиент/offline

- Snapshot маркирован workspace/shift/revision; late response отбрасывается по shiftId+generation.
- `activeShiftId` хранится по uid/workspace и восстанавливается только для видимой открытой смены; архивный режим его не подменяет.
- Одно нажатие внутренней нижней вкладки атомарно переключает шапку, карточки, рейсы, отчёт, presence и действия; ни один фрагмент A не отображается в контексте B, включая время загрузки.
- Формы, фокус, вертикальная прокрутка и inflight/pending сохраняются раздельно по shift context; фоновый ответ меняет только свою смену и её индикатор.
- Presence `workspace:shiftId` изолирован.
- Очереди двух uid и двух shifts изолированы; immutable hash проверяется.
- Closed shift, removed membership, account switch и moved truck не приводят к replay в иной context.
- Force transfer отсутствует в persisted offline queue; detached completion online-only и не превращается в обычную команду B.
- Detached блок всегда маркирует source shift и не смешивается с current cards B; late response не меняет другой context.
- Archive не попадает в active selector.

### Браузер 393×852, два пользователя

Admin создаёт пересекающиеся day/night смены; назначает разных прорабов; каждый видит только свою, admin обе. Во вкладке «Линия» сверху постоянно показаны объект, календарная дата и `День`/`Ночь` выбранной смены; снизу непосредственно над глобальным меню видна горизонтальная полоса только открытых смен с подписями `Объект · День/Ночь`, заметным selected-state и scoped state/pending badges. При переполнении полоса прокручивается пальцем и доводит выбранную вкладку в видимую область.

Одно нажатие на вкладку атомарно переключает `activeShiftId` и весь экран: шапку, cards, trips, report, presence и actions. На замедленной загрузке и при позднем ответе A под шапкой B не появляется ни одного элемента A; ввод, фокус и вертикальная прокрутка каждого context сохраняются отдельно. Полоса не перекрывает последнюю карточку, её действия или глобальное меню, включая `safe-area` и экранную клавиатуру на viewport 393×852. Восстановленный архив отсутствует в полосе и открывается только отдельным режимом из Архива с архивной плашкой.

Проверяются object lock, cards/presence/pending isolation, запрет обычного add занятого truck, крупный force-transfer confirm, корректные from→to/stage/consequences, cancel и stale-CAS. После transfer новые рейсы идут в B; блок «Рейсы, оставшиеся в прежней смене» виден участникам A и B, крупно маркирует A и online-only завершение; завершивший из B создаёт рейс только в A. Затем close A без влияния несвязанной смены, archive banner/allowed edits, два табельных листа и месячная сумма без дубля. Нет `pageerror`, module errors, потери ввода/scroll.

### Backup/restore, fixtures и rollout

Full exact provenance bundle, pre-mutation selective rejection и единственный bootstrap+insertion/verification order определены нормативно в §4.10 «Full exact backup/restore policy»; этот acceptance раздел не задаёт второго порядка. Проверка обязана включать complete archive revision bytes/hash chain/latest pointer/publications, restored children+migration evidence, canonical historicalization report bytes/confirmation/audit+receipts и весь replica transport closure. Replica bundle остаётся full-only согласно решению владельца. Bootstrap завершается до data restore; data restore не создаёт roles, owner/admin или registration code. Restore не «улучшает» unresolved и не replay historical v1 через ordinary materializer.

- S25 fixture matrix владеет каждым условным инвариантом без полного 3×3 перебора: `(identity,type)` = `source/source` для strict v2; `source/unresolved`, `unresolved/source`, `unresolved/unresolved` для closed v1; `manual/unresolved`, `unresolved/manual`, `manual/manual` после resolution. Отдельно active/closing unresolved type preflight выдаёт exact report и требует confirmed historicalization; без confirmation migration untouched. Reject cases: v2 с manual/unresolved/NULL; source/manual с NULL; unresolved с non-NULL; invalid enum; SQL three-valued cases `NULL IN (...)` не проходят через equivalence CHECK; malformed v2; forged runtime v1. Closing/closed/object-lock nullable проверяются отдельно и не считаются provenance NULL.
- S26 runtime fixtures допускают strict v2 shifts; legacy unresolved существует только как уже мигрированная historical S25 row/full restore, но новая v1 replica operation получает `protocol-upgrade-required`. Parent tests покрывают committed earlier и same-batch topological `objects/users → shift/trucks → status/log`, missing object/user rollback, soft-disable/RESTRICT и отсутствие parent placeholders. Manifest entries добавляются только с реально существующими files согласно isolated design.

Репетиция maintenance→backup→migration→server→PWA→smoke→open на изолированной копии. Проверка, что v1 получает 426, а не данные. Затем обязательные server/tabel/browser/Actions проверки из `AGENTS.md`, проверка собранной PWA и всех RECORDS.

## 16. Этапность для будущего плана

1. Schema/backfill/constraints и query inventory на isolated DB.
2. API v2, ACL, CAS, memberships, truck assignment, force transfer/detached trip, object lock.
3. Scoped close, archive mode, tabel/material/game/report с attribution detached trip.
4. Клиентские contexts, selector, request generations, presence и UX оставшихся рейсов.
5. Offline v2 storage/replay, account isolation и online-only gates cross-shift операций.
6. Полный test matrix и репетиция окна.
7. Отдельно согласованное окно общей инфраструктуры по разделу 13.

Параллельность включается только после готовности всей вертикали; частичный rollout не допускается.

## 17. Решения владельца и решения архитектора

### Решения владельца

- Shift сам является линией; постоянных line entities нет.
- Несколько активных смен; day/night одного объекта/даты могут пересекаться.
- По умолчанию самосвал назначен только в одной active смене; обычный перенос remove→add возможен после завершения рейса.
- Day/night могут пересекаться: старший прораб/admin с отдельным правом может явно подтвердить атомарный force transfer. Незавершённый рейс не отменяется и не переносится, остаётся в исходной смене; новые рейсы идут только в новую.
- Оставшийся рейс могут завершить участники старой или новой линии; UI всегда крупно показывает исходную смену/объект/day-night и куда запишется действие.
- Перевод и завершение старого рейса полностью аудируются: кто/когда/from/to/cycle/stage/completer.
- Объект можно менять только до первого рейса; затем для другого объекта создаётся новая смена.
- Прорабы создают, меняют объект и закрывают с учётом матрицы; видят назначенные смены; admin видит все.
- Создатель — участник; участник управляет другими прорабами своей линии; admin — любой.
- Restored archive только из Архива, с явной плашкой; данные смен не смешиваются.
- Вкладка «Линия» имеет внутреннюю нижнюю полосу открытых смен непосредственно над глобальным меню; подписи краткие `Объект · День/Ночь`, выбранная смена заметно выделена, при переполнении используется горизонтальная прокрутка.
- Сверху всегда показаны объект, календарная дата и `День`/`Ночь` выбранной смены; в центре — машины, рейсы, отчёт и действия только этой смены. Нажатие по нижней вкладке атомарно переключает весь контекст по `activeShiftId`, без смешивания данных.
- Восстановленные архивные смены в нижнюю полосу не входят. Полоса не перекрывает карточки и глобальную навигацию и учитывает safe-area мобильного viewport 393×852.
- Этап 4 включается через окно обслуживания без одновременной работы старых/новых клиентов.
- Время окна и деплой согласуются отдельно. Working-test frontend при зелёных тестах публикуется без «да»; server deploy/миграция общей инфраструктуры — только после явного «да» и согласования окна.
- **23.11.2026:** для out-of-order replica выбран вариант B — отдельная `replica_pending_documents`; `replica_placeholder` запрещён и удаляется. Видимое поведение приложения не меняется.
- **23.11.2026:** replica-owned `shifts/statuses/logs` разрешено восстанавливать только полным exact-комплектом с stream/cursor/staging/heads и всеми required parents; любой selective restore, затрагивающий часть комплекта, сервер отклоняет до mutations. Offline rebuild не выбран.
- **23.11.2026:** выбран вариант A для legacy attribution: недоказанные автор и/или День/Ночь сохраняются независимо как unresolved с честной пометкой; доступны истории/архиву, но не считаются достоверно атрибутированными и не становятся active line. Блокировать всю migration (B) отклонено; угадывать по display name, replica sender UID или часу (C) запрещено.
- **23.11.2026:** active/closing legacy с unresolved type на cutover переводится в historical/non-active без day/night только по exact preflight list и отдельному явному подтверждению владельца в конкретном maintenance window. Никакого автоматического закрытия; при отказе migration abort untouched.
- **23.11.2026:** `resolve_legacy_shift` по умолчанию только active admin; `senior_foreman` deny. Расширение возможно лишь новым решением владельца.

### Решения архитектора

- Серверный рубеж lock объекта — первый confirmed `arrive`; `load` — defensive fallback для legacy.
- Запрещён точный active/closing duplicate `(workspace,object,date,type)`; day/night совместимы.
- Обычный remove/двухшаговый transfer нельзя выполнить с незавершённым циклом; исключение — привилегированный атомарный force transfer.
- Force transfer отделяет незавершённый цикл в единственную open detached entity исходной смены, а current status переносит чистым в destination; это сохраняет инвариант одного current assignment.
- Обычный перенос без незавершённого цикла остаётся двухшаговым; старший/admin при конфликте assignment используют единый атомарный endpoint независимо от наличия цикла, чтобы исключить окно «truck нигде».
- Cross-shift force transfer и detached completion online-only; обе операции используют CAS двух смен и append-only audit.
- Пока detached open, truck нельзя снова переносить/снимать и обе связанные смены нельзя закрывать; это делает destination membership и отчётную принадлежность однозначными.
- Normalized date/type/state/revisions — канон, JSON — snapshot совместимости; type/opener nullable только для independently marked legacy unresolved, никогда для v2.
- NAS session actor авторитетен для NAS command; replica sender — только transport identity; display snapshot не identity. Runtime v2 не может создавать legacy/unresolved rows.
- Transport state отделён от canonical: payload остаётся только в immutable `replica_stream`, staging хранит routing/provenance; `replica_document_heads` задаёт stream-seq generation/CAS и сохраняет delete tombstones.
- `objects/users` — materializable versioned parents с heads; batch topologically materializes их до shift. Staging допустим только для status/log при отсутствии shift и/или truck; shift с отсутствующим object/user malformed и откатывается.
- Backup/restore использует неделимый exact bundle canonical replica-owned rows + parents + stream/heads/pending/cursor; selective request отклоняется до mutation, restore не делает replay/rebuild.
- Snapshot имеет workspaceId/shiftId/shiftRevision; late response — shiftId+requestGeneration.
- Membership мягко удаляется; реактивация обновляет строку.
- `activeShiftId` хранится по uid/workspace; нижняя полоса смен атомарно переключает весь клиентский context, presence key — `workspace:shiftId`.
- Только `senior_foreman`/`foreman` допустимы как участники; worker/driver — нет.
- Последнего участника снимает только admin; removed member не может finish close.
- Restored archive допускает только trip/TTN edit/delete с отдельной revision/audit.
- Close сохраняет history/memberships/logs/receipts и удаляет только current statuses своей смены.
- Старый клиент блокируется 426 во время/после окна; долгой v1/v2 совместимости нет.

## 18. Влияние на committed `03d497d`

Планы обновляются только после approval этого amendment; сейчас не меняются.

| Файл/область из review | Действие после approval |
|---|---|
| `server/sql/025_parallel_shifts_core.sql` | **переписать** strict schema/classifier: conditional provenance, no hour inference, role split в/до 025, cutover preflight/historicalization audit; удалить runtime legacy bridge |
| `server/src/replica-materialize.mjs` | **переписать** shift branch на exact v2-only; включить versioned objects/users parent order; v1 runtime reject; restore не через этот путь |
| `server/src/replica-store.mjs` | **расширить** protocol/hash allow-list, topological batch validation и stable errors; transport sender не opener |
| `server/src/shift-archive.mjs` | **удалить** hour fallback; сохранять original provenance exact |
| `server/src/archive-store.mjs`, `server/src/archive-read.mjs` | **переписать** на immutable archive series/revisions/publications, latest-finalized resolver для всех default consumers, explicit history/revision export и dedicated restored contexts с session restore actor отдельно от original opener |
| `server/src/report-store.mjs`, archive UI/export/analytics/material consumers | **перепривязать** restored edits к context children; default list/open/report/PNG/analytics/material используют один latest-finalized `(archiveId,revision,sha256)` projection |
| `server/src/backup-store.mjs` | **переписать** на privileged bootstrap-before-data, full exact archive/provenance/replica bundle и pre-mutation selective rejection |
| `working-test/source/core/15-shifts.js` и NAS shift-start writer | **переписать** на exact published v2 payload; запрет restore aliases |
| `server/tests/parallel-shifts-migration-core.test.mjs` | **заменить** семь unconditional NOT NULL/hour assumptions на S25 matrix и role/historicalization checks |
| `server/tests/replica-materialize-parallel-shifts.test.mjs` | **сохранить как существующий root baseline, переписать атомарно**: после 025 v1 reject/exact v2/parents; после появления 026 staging assertions могут быть перенесены в новый S26 test только в том же commit с manifest replacement, старый путь не исчезает без exact inventory update |
| `server/tests/replica-materialize.test.mjs` | **сохранить и расширить**: versioned allow-list/heads для objects/users, same-batch parent ordering, strict v2-only shift и stable v1 error |
| archive/backup/restore tests | **расширить** provenance classification, restore actor, full-only restore и selective-before-mutation |
| новые tests | **добавить после approval** для admin-only resolution/replay ACL/advisory lock/audit, restored contexts, role bypass probes и exact JSON golden classifier |
| оба implementation plans | **не исполнять и не править сейчас**; переработать только после approved amendment |

## 19. Открытые вопросы

Продуктовых решений владельца не осталось. Технические блокеры до реализации: builder re-review/approval этого amendment; подтверждение на конкретное maintenance window и отдельное подтверждение exact historicalization list появятся только после реального preflight. Инженерно зафиксировано: обычный перенос без незавершённого цикла остаётся двухшаговым, а при уже существующем assignment старший/admin использует атомарный force transfer; open detached trip временно блокирует следующий перенос и закрытие обеих связанных смен.

Конкретные дата/время окна, фактический target общей БД, backup path и команда deploy намеренно не фиксируются в дизайне: их надо сверить с актуальным окружением и отдельно согласовать непосредственно перед выполнением окна.
