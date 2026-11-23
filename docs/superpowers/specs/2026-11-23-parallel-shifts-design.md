# Параллельные смены: дизайн этапа 4

Дата: 23.11.2026
Статус: решения владельца и замечания reviewer зафиксированы; amendment по replica staging (вариант B) одобрен владельцем 23.11.2026; документ готов для актуализации подробного плана реализации.
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

### Выбран: несколько `shifts`, без сущности line

Shift одновременно является линией. Назначения людей находятся в `shift_members`; все зависимые записи имеют `shift_id`. Это совпадает с бизнес-языком, использует существующий `shiftId` и не вводит долгоживущую сущность.

Отклонены:

- постоянная `line`: противоречит решению владельца и требует лишнего жизненного цикла;
- workspace на линию: дублирует справочники/ACL и ломает общие отчёты;
- совместимый долгий v1/v2 rollout: владелец выбрал окно обслуживания без одновременной работы старых и новых клиентов.

## 3. Доменная модель и инварианты

### 3.1. Смена

`shift_id` — непрозрачный стабильный ID. Отображение строится из объекта, рабочей даты, типа и времени открытия.

Состояния: `active`, `closing`, `closed`. Точный дубликат активной/закрывающейся смены `(workspace_id, object_id, work_date, shift_type)` запрещён; day и night не конфликтуют.

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
| `state` | `text NOT NULL CHECK IN ('active','closing','closed')` |
| `object_id` | `text NOT NULL`, FK `(workspace_id, object_id)` → `workspace_objects` |
| `object_name_snapshot` | `text NOT NULL` |
| `work_date` | `date NOT NULL` (Europe/Moscow) |
| `shift_type` | `text NOT NULL CHECK IN ('day','night')` |
| `opened_at`, `opened_by_uid` | `timestamptz NOT NULL`, `text NOT NULL` FK `app_users(uid)` |
| `object_locked_at` | `timestamptz NULL` |
| `object_locked_by_operation_id` | `text NULL` |
| `closing_started_at`, `closing_by_uid` | nullable |
| `closed_at`, `closed_by_uid` | nullable |
| `revision` | `bigint NOT NULL DEFAULT 1` |
| `payload` | `jsonb NOT NULL`; совместимый snapshot, не источник normalized полей |

PK `(workspace_id, shift_id)`. Частичный unique index `(workspace_id, object_id, work_date, shift_type) WHERE state IN ('active','closing')`. Индексы `(workspace_id,state,opened_at)`, `(workspace_id,object_id,work_date)`. Старый `is_active` удаляется только поздней отдельной миграцией; во время перехода выводится из `state` и проверяется constraint/trigger на согласованность.

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
- reward/game events и penalties, порождённые рейсом;
- material import marker;
- `shift_archives` (`source_shift_id`, unique `(workspace,source_shift_id)`);
- табельные записи смены.

Для generic receipt допустимо хранить `shift_id` nullable только у действительно workspace-wide команды; line/shift endpoint требует NOT NULL. Каждый receipt хранит `protocol_version smallint NOT NULL`, `command_hash text NOT NULL`, `uid`, результат и уникальность `(workspace_id,operation_id)`; повтор с другим uid/hash/shift/protocol — `operation-id-reused`.

### 4.6. Архив, табель и material marker

`shift_archives`: `(workspace_id,archive_id)` PK, `source_shift_id NOT NULL`, normalized object/date/type snapshots, `archive_revision bigint NOT NULL`, `payload`, `created_at`; unique source shift.

`archive_operation_receipts`: workspace, operation_id, archive_id, uid, command_hash, result; PK workspace+operation. `archive_audit`: append-only с archive_id/source_shift_id, before/after, actor/time.

`tabel_records` для сменного листа получает `shift_id`; unique `(workspace_id,shift_id)` для листа смены и отдельный индекс `(workspace_id,object_id,work_date,shift_type)`. Производный display key — `object/day/type`; запрет точного active duplicate делает его однозначным среди активных, но постоянная идентичность листа — `shiftId`. Несменные записи табеля могут оставить `shift_id NULL` с явным `record_kind`.

`shift_material_markers`: PK `(workspace_id,shift_id)`, `material_id`, `source_archive_revision`, `volume`, `revision`, `confirmed_at/by`; повторное finish не создаёт второй перенос. Коррекция архива обновляет тот же marker только через архивный workflow с CAS.

### 4.7. JSON и миграционная проверка

Normalized столбцы — канон; JSON — snapshot совместимости. На записи сервер формирует payload из канонических значений. Миграция сверяет `payload.shiftId/objectId/date/type/state` со столбцами. Null, неизвестный shift или неоднозначное восстановление блокируют миграцию с безопасным отчётом.

### 4.8. Amendment: replica staging без фиктивных смен

**Решения владельца от 23.11.2026:** выбран вариант B — отдельная `replica_pending_documents`; `replica_placeholder` запрещён и удаляется. Replica-owned `shifts/statuses/logs` восстанавливаются только полным exact-комплектом вместе с stream/cursor/staging/heads; selective restore любого члена комплекта отклоняется до mutation. Offline rebuild не выбран.

Root cause: transport state (документ принят, но canonical parent ещё не пришёл) не может жить в `shifts`. Канонический инвариант жёсткий: каждая строка `shifts` — реальная нормализованная бизнес-смена с `state`, `object_id`, `object_name_snapshot`, `work_date`, `shift_type`, `opened_at`, `opened_by_uid`, согласованным payload и обычными FK/checks; placeholder/null-исключений нет.

#### Протокол операций, identity и hash

Одна replica operation описывает ровно один документ. Materializable kinds: только `doc.set` и `doc.delete`. Для `doc.set` exact payload envelope — `{collection,path,data}`, где `data` — object; если `data.id` присутствует, оно обязано точно совпасть с последним segment `path` (`document_id`). Для `doc.delete` единственное canonical представление — `{collection,path}`: ключ `data` отсутствует, identity берётся из path. Входной `data:null` принимается только как transport alias и **до hash/duplicate comparison** нормализуется удалением ключа; любое иное `data` у delete отвергается. Поэтому delete с отсутствующим `data` и с `data:null` имеет один v2 canonical hash, а stream хранит только canonical envelope без `data`. Разрешённые materializable collections: `shift`, `trucks`, `truckStatus`, `logs`; остальные существующие поддержанные события, включая `trip.load`, принимаются как **journal-only**: stream/cursor меняются, canonical/staging/heads — нет. Неизвестный kind/collection запрещён до записи всей пачки. Переход протокола имеет versioned allow-list; старый sender без требуемой версии после cutover получает `protocol-upgrade-required`, а не угадываемую классификацию.

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

Staging применяется только для корректного `doc.set` status/log, у которого отсутствует хотя бы один **разрешённо запаздывающий canonical parent**:

| Document | Required parents | Поведение при отсутствии |
|---|---|---|
| `shift` set | `workspace`; `workspace_objects(workspace_id,object_id)`; `app_users(opened_by_uid)` и непустые normalized fields | отсутствие object/user или malformed snapshot — ошибка и rollback; shift никогда не staging |
| `trucks` set | `workspace` | materialize сразу; malformed truck — rollback |
| `truckStatus` set | canonical shift `(workspace_id,shift_id)` и truck `(workspace_id,truck_id)`; `truck_id=document_id` | stage, если shift и/или truck ещё нет |
| `logs` set | canonical shift `(workspace_id,shift_id)` и truck `(workspace_id,truck_id)`; `log_id=document_id` | stage, если shift и/или truck ещё нет |
| любой delete | document key; parents не требуются | применить tombstone/delete сразу |

Promotion запускается после materialization как shift, так и truck и выбирает pending по обоим routing indexes; документ применяется только когда **все** parents существуют. Отсутствующие object/user родителя shift не считаются out-of-order transport и не создают staging.

#### `replica_document_heads`

Persistent head ledger доказывает возраст canonical row и сохраняет tombstone после удаления:

| Столбец | Тип/ограничение |
|---|---|
| `workspace_id` | `text NOT NULL` |
| `collection` | `text NOT NULL CHECK (collection IN ('shift','trucks','truckStatus','logs'))` |
| `document_id` | `text NOT NULL CHECK (btrim(document_id)<>'')` |
| `head_seq` | `bigint NOT NULL` |
| `stream_direction` | `text NOT NULL DEFAULT 'f2s' CHECK (stream_direction='f2s')` |
| `head_kind` | `text NOT NULL CHECK (head_kind IN ('doc.set','doc.delete'))` |
| `shift_id` | `text NULL` routing snapshot; для shift set равно document_id |
| `truck_id` | `text NULL`; для truck/truckStatus всегда document_id, для log set обязателен |
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

Unique `(workspace_id,stream_direction,head_seq)`. Indexes `(workspace_id,shift_id,head_seq)` and `(workspace_id,truck_id,head_seq)`. Every materializable set/delete advances head only by CAS `existing.head_seq < incoming_seq`; equal is replay, lower is stale no-op. Canonical replica mutations are legal only while locked head still equals incoming seq. Thus canonical status/log cannot be deleted or overwritten by an older operation.

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
- `set→delete`: newer delete advances head, deletes canonical and pending, sets `applied_seq=head_seq`, `canonical_present=false`. `truckStatus` delete always has non-null `truck_id=document_id`; only `shift_id` may be unknown/null.
- `delete→set`: newer seq is a valid new generation, including reused log ID. It materializes or stages by current parents. Older set/delete can never pass head CAS. Log ID reuse therefore follows stream generation, not a permanent identity ban.
- Status A→pending B removes canonical A before commit, stages B and points head to B. Arrival A sees no matching head; arrival B may promote. Pending→delete leaves no pending/canonical and a settled tombstone, so later parent arrival does nothing.

Heads/tombstones and their referenced stream rows are retained at least as long as any backup/replay/idempotency horizon. Compaction is a separate maintenance operation, never inline: under the same locks it may delete only a settled tombstone and old stream prefix when no backup, receipt, pending/head FK or cursor/journal consumer references it; it records a signed/checksummed low-water mark per direction. No compaction is included in stage 4 rollout.

#### Transaction, locks and crash semantics

Exact lock order for append, promotion, delete, checkpoint, exact restore verifier and any future repair is one order only:

1. `pg_advisory_xact_lock(hashtextextended('replica:'||workspace_id||':f2s',0))` (backup/full restore takes both `:f2s` then `:s2f` lexically);
2. `replica_cursor WHERE workspace_id=? FOR UPDATE`;
3. existing `replica_document_heads` and `replica_pending_documents` rows `FOR UPDATE` in `(collection,document_id)` PK order; absent document keys are serialized by the workspace lock;
4. parent `shifts` then `line_trucks`, each `FOR KEY SHARE` for read or `FOR UPDATE` for mutation, IDs sorted;
5. `line_truck_statuses FOR UPDATE` by truck id;
6. `line_logs FOR UPDATE` by log id;
7. referenced stream head/receipt rows as applicable; stream INSERT itself takes no prior row lock.

No path locks stream/status/log before pending/head. Promotion invoked by shift/truck materialization remains inside the same outer transaction and reuses already-held locks; it does not reacquire in another order.

`appendReplicaBatch`: (a) prevalidate entire batch and in-batch duplicates before writes; (b) BEGIN, auth/authority, locks 1–3, verify persisted duplicates/hash and base seq; (c) assign seq and INSERT immutable stream row; (d) advance head by seq CAS; (e) lock/check parents and materialize or replace pending; (f) promote newly satisfiable pending in PK order; (g) update cursor last; (h) COMMIT. Same-id/hash persisted replay consumes no seq and performs no materialization. Journal-only operation inserts stream and advances cursor without head.

Fault at any boundary—after stream insert, head advance, canonical delete/upsert, pending replace, promotion or before cursor—rolls back stream, head, canonical, pending and cursor together. A batch remains atomic; malformed document rolls back all fresh operations. Real concurrent tests use separate connections, observed lock waits and bounded `lock_timeout`/`statement_timeout`, not only Promise ordering.

#### Immutable stream and role boundary

026 makes stream append-only at DB level. Migration objects are owned by a non-login migration owner. The ordinary API/runtime role is distinct, receives no direct `UPDATE`/`DELETE` on `replica_stream` and no table-owner/superuser bypass; a `BEFORE UPDATE OR DELETE` trigger raises `replica-stream-immutable` even if grants drift. Runtime gets INSERT/SELECT and head/staging DML only through reviewed functions or least-privilege grants. If current deployment still runs as table owner, rollout is blocked until the migration-owner/runtime-role split is created and connection credentials switched; trigger alone is not claimed as a security boundary.

Exact restore uses a separate NOLOGIN restore owner plus a narrowly granted `SECURITY DEFINER restore_replica_exact(...)` entrypoint (fixed `search_path`, owner-qualified objects, input temp tables owned by caller, no dynamic identifiers). It is callable only by maintenance role while maintenance marker+transaction-local exact-restore flag are set. It permits INSERT of original stream rows into empty workspace range, never UPDATE history; DELETE is allowed only for clearing the target workspace after full request validation and before insert in the same transaction. Trigger checks this role/mode. Tests prove runtime/direct SQL cannot update/delete, forged GUC/role cannot bypass, and controlled exact restore can insert then validate exact bytes/hashes.

#### Full exact backup/restore policy

Replica exact bundle is indivisible: global `app_users` dependencies for referenced actors, workspace objects, trucks, shifts, statuses, logs, `replica_stream`, `replica_document_heads`, `replica_pending_documents`, `replica_cursor`, plus migration/hash/authority markers. A restore request that selects/deselects any replica-owned `shift`, status, log, parent dependency or transport member without the whole bundle is rejected during normalization/preflight **before checkpoint creation, DELETE, INSERT or restore_epoch mutation**. Non-replica sections may remain independently selective only when they do not own/reference these rows. Offline rebuild/replay from stream is not an alternative.

Checkpoint takes f2s/s2f advisory locks and cursor row, then head/pending keys, parents and children in the common lock order, producing one repeatable exact image. Restore runs with constraints deferred where declared and uses this order: validate manifest/checksums/hash versions/role/empty target plan → insert global users/authority and workspace parents → insert stream history (original seq/recorded_at/hash/version) → canonical shifts/trucks → statuses/logs → heads → pending → cursor last. FK design is DEFERRABLE for restore-only cycles where needed, but all constraints are IMMEDIATE and checked before commit.

Validation requires the same direction-aware continuity contract as 026 preflight: native un-compacted f2s exact `1..f2s_seq`, otherwise strictly ordered marker-covered subsequences; s2f ordered subsequence to its cursor with every gap justified by versioned marker; no row beyond corresponding cursor and no renumbering. Operation IDs/hashes/version markers remain valid without rewriting legacy v1; every head/pending/applied seq references matching f2s stream; deferred cross-table invariant proves exactly one pending row only for pending-set head. Для документов, у которых существует replica head, canonical replica row exists iff that head says `canonical_present`, and settled delete has none; native/non-replica canonical rows **без replica head** этим presence invariant не охватываются и сохраняются согласно full-bundle manifest. Все app_user/object/truck/shift FK resolve. Any mismatch rolls back exact restore. There is no automatic replay/rebuild and no UPDATE of history.

#### Migration boundary, observability and acceptance

025 is unreleased and its checksum intentionally changes: it contains no `replica_placeholder` column/branch/constraint, restores canonical `NOT NULL`/checks, and remains core shifts migration. 026 adds staging, heads, stream hash/protocol columns, immutable-role/trigger boundary and dependent attribution. Common DB has neither new migration applied; actual migration/server role change/deploy still requires owner-approved window. Once 025 is applied, **any build mentioning `replica_placeholder` is prohibited regardless of whether placeholder rows exist**; rollback is only a compatible transitional/new server or maintenance forward-fix. Stream/heads/pending are never dropped. API/client-visible behavior is unchanged.

Audit/metrics expose pending counts/oldest age by collection and missing-parent class, head supersession/delete/promotion/conflict/rollback, cursor lag, lock wait/timeout and promotion duration. Logs contain correlation, seq, hash version, hashed operation/document/shift IDs and stable error code; never payload/PII.

Required tests:

- status A becomes pending for B, arrival A does nothing, arrival B promotes; repeat with missing truck, and with shift/truck arriving in both orders;
- pending set→newer set, pending→delete with no resurrection, status to another shift, log set→delete→set generation reuse;
- delete before/after promotion; truckStatus delete has document truck key even with unknown shift; data.id/path mismatch and multi-document payload rollback;
- same v2 id/hash in one batch and across replay is no-op; same id different kind/hash/version conflicts; legacy v1 rows remain byte/hash stable;
- concurrent append/promotion/newer set/delete uses real lock waits/timeouts and leaves one head; crash injection after every transaction boundary leaves no partial state;
- immutable stream UPDATE/DELETE denied to runtime and trigger bypass attempts; exact restore role/mode succeeds only through controlled API;
- backup containing pending and settled delete restores exact stream/head/pending/canonical/cursors, then parent arrival promotes once; selective request touching any bundle member is rejected before mutation;
- 026 preflight на реальных v1 fixtures: native f2s exact range проходит; marker-covered interleaved/directional subsequence проходит; gap без marker, duplicate/ambiguity, missing head row и row beyond f2s/s2f cursor откатывают всю migration без PK/hash rewrite;
- deferred head↔pending triggers отвергают orphan/mismatch/extra pending и pending у materialized/delete; exact restore проходит те же triggers;
- f2s/s2f cursor continuity, app_users/object/truck dependencies, malformed snapshots и все FK/hash/head postconditions fail closed; native canonical row без replica head не ошибочно считается отсутствующей;
- old `{}`/placeholder fixtures/tests are replaced, not relaxed: every fixture row in `shifts` is a full canonical snapshot satisfying strict 025.

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

**POST `/api/v2/shifts/{shiftId}/line-operations`** body включает `{operationId,protocolVersion:2,type,truckId,expectedShiftRevision,expectedStatusRevision,expectedCycleRevision,expectedTtnRevision,...typeFields}`. Path shiftId обязан совпасть с immutable body/hash context; response содержит новые shift/status/cycle/ttn revisions. Первый confirmed `arrive` фиксирует объект. Обычный endpoint никогда не обращается к detached trip.

### 5.5. Закрытие

**POST `/api/v2/shifts/{shiftId}/close/prepare`** body `{operationId,protocolVersion:2,expectedShiftRevision}`. `200`: `{phase:'prepared',closeToken,shiftRevision,archiveId,archiveRevision,materialMarkerRevision}`. Идемпотентный replay возвращает тот же результат.

**POST `/api/v2/shifts/{shiftId}/close/finish`** body `{operationId,protocolVersion:2,closeToken,expectedShiftRevision,expectedArchiveRevision,expectedMaterialMarkerRevision}`. `200`: `{phase:'closed',...}`. Pending server receipts/inflight line operations и open detached trips, где смена является source или destination, блокируют prepare/finish (`409 pending-operations|detached-trip-open`); неизвестные офлайн-очереди не могут быть учтены и позднее получают `410`.

Пустая смена закрывается: archive создаётся с нулевыми итогами, material marker не требуется. Memberships сохраняются как история. На finish удаляются только текущие `line_truck_statuses` этой смены; logs/history, shift, memberships, receipts, audit, archive и marker сохраняются. Никаких workspace-wide DELETE.

### 5.6. Restored archive

**GET `/api/v2/archives/{archiveId}/restored`** → `200 {archiveId,sourceShiftId,archiveRevision,shiftSnapshot,trips,ttn}` по существующему archive/tabel ACL, с pagination вложенных рейсов через `?limit&cursor` при >100.
**POST `/api/v2/archives/{archiveId}/operations`** body `{operationId,protocolVersion:2,type:'trip.update'|'trip.delete'|'ttn.update'|'ttn.delete',recordId,expectedArchiveRevision,...}`. `200`; `409 archive-changed`. Другие type → `400 archive-operation-not-allowed`.

Список архива остаётся существующим versioned archive API, но получает opaque cursor/limit и `sourceShiftId`; восстановленный режим не вызывает active endpoints.

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
| archive trip/TTN edit/delete | archive rev | archive rev +1, archive audit; при влиянии на material — marker rev +1 в той же транзакции |

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
- Material marker идемпотентен per shift. Завершение detached trip и последующая коррекция меняют marker **исходной** смены, не destination и не создают новый.
- Archive хранит source shiftId, object/date/type, memberships history и snapshot техники. Open detached блокирует закрытие обеих связанных смен, поэтому архив никогда не содержит «полурейса».
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

Старые и новые клиенты одновременно не работают. Время окна и фактический деплой согласуются отдельно.

До окна разрешено: код, миграции и репетиции только на изолированной БД; новая PWA на локальном/изолированном API. Общая инфраструктура и БД не изменяются без явного согласия.

Порядок окна:

1. Получить явное «да» владельца на время окна, server deploy и миграцию общей БД.
2. Включить server maintenance mode: все v1/v2 mutations → `503 maintenance`; reads показывают обслуживание, старые клиенты не пишут.
3. Дождаться завершения inflight; зафиксировать health/schema/data counts.
4. Сделать проверенный backup фактической общей БД, SHA-256 и пробное чтение/restore verification.
5. Применить миграцию; прогнать constraints/backfill/audit и smoke на сервере при закрытом трафике.
6. Развернуть сервер v2. V1 mutation/list/snapshot возвращают `426 protocol-upgrade-required`, а не singleton data.
7. Опубликовать новую тестовую PWA. Сама публикация working-test при зелёных тестах не требует дополнительного «да», но выполняется внутри согласованной последовательности окна.
8. Проверить live manifest/HTML/SW/RECORDS, auth, list/snapshot, две изолированные смены, close и отсутствие console errors.
9. Открыть mutations v2 и снять maintenance. Старый клиент остаётся заблокирован `426` во время и после окна.
10. Наблюдать readiness/error rate и выполнить post-deploy counts.

Rollback:

- до первой v2 mutation: вернуть предыдущий server/client, восстановить режим; additive schema можно оставить;
- после v2 mutations/двух смен singleton rollback запрещён; вернуть новый server build либо оставить maintenance и исправить вперёд;
- restore общей БД из backup — разрушительная операция, только с отдельным явным согласием владельца;
- production PWA не публикуется этим rollout без отдельного поручения и согласия.

## 14. Ошибки

Минимальные stable codes: `forbidden`, `shift-not-visible`, `not-shift-member`, `shift-changed`, `shift-closing`, `shift-closed`, `shift-duplicate`, `object-locked`, `membership-changed`, `last-shift-member`, `truck-assigned-to-other-shift`, `truck-not-on-shift`, `truck-cycle-incomplete`, `truck-detached-trip-open`, `detached-trip-not-found`, `detached-trip-completed`, `detached-trip-open`, `transfer-context-changed`, `force-transfer-confirmation-required`, `online-required`, `revision-conflict`, `pending-operations`, `operation-id-reused`, `archive-changed`, `archive-context-required`, `archive-operation-not-allowed`, `protocol-upgrade-required`, `maintenance`.

После 409 клиент обновляет только исходный context; никогда не переносит команду в выбранную смену.

## 15. Проверки и критерии приёмки

### БД/сервер

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
- Archive разрешает только trip/TTN edit/delete и имеет отдельную revision/audit.
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

### Rollout

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

### Решения архитектора

- Серверный рубеж lock объекта — первый confirmed `arrive`; `load` — defensive fallback для legacy.
- Запрещён точный active/closing duplicate `(workspace,object,date,type)`; day/night совместимы.
- Обычный remove/двухшаговый transfer нельзя выполнить с незавершённым циклом; исключение — привилегированный атомарный force transfer.
- Force transfer отделяет незавершённый цикл в единственную open detached entity исходной смены, а current status переносит чистым в destination; это сохраняет инвариант одного current assignment.
- Обычный перенос без незавершённого цикла остаётся двухшаговым; старший/admin при конфликте assignment используют единый атомарный endpoint независимо от наличия цикла, чтобы исключить окно «truck нигде».
- Cross-shift force transfer и detached completion online-only; обе операции используют CAS двух смен и append-only audit.
- Пока detached open, truck нельзя снова переносить/снимать и обе связанные смены нельзя закрывать; это делает destination membership и отчётную принадлежность однозначными.
- Normalized date/type/state/revisions — канон, JSON — snapshot совместимости.
- Transport state отделён от canonical: payload остаётся только в immutable `replica_stream`, staging хранит routing/provenance; `replica_document_heads` задаёт stream-seq generation/CAS и сохраняет delete tombstones.
- Staging допустим для status/log только при отсутствии shift и/или truck; shift с отсутствующим object/user malformed и откатывается.
- Backup/restore использует неделимый exact bundle canonical replica-owned rows + parents + stream/heads/pending/cursor; selective request отклоняется до mutation, restore не делает replay/rebuild.
- Snapshot имеет workspaceId/shiftId/shiftRevision; late response — shiftId+requestGeneration.
- Membership мягко удаляется; реактивация обновляет строку.
- `activeShiftId` хранится по uid/workspace; нижняя полоса смен атомарно переключает весь клиентский context, presence key — `workspace:shiftId`.
- Только `senior_foreman`/`foreman` допустимы как участники; worker/driver — нет.
- Последнего участника снимает только admin; removed member не может finish close.
- Restored archive допускает только trip/TTN edit/delete с отдельной revision/audit.
- Close сохраняет history/memberships/logs/receipts и удаляет только current statuses своей смены.
- Старый клиент блокируется 426 во время/после окна; долгой v1/v2 совместимости нет.

## 18. Открытые вопросы

Блокирующих продуктовых вопросов владельцу для перехода к подробному плану нет. Инженерно зафиксировано: обычный перенос без незавершённого цикла остаётся двухшаговым, а при уже существующем assignment старший/admin использует атомарный force transfer; open detached trip временно блокирует следующий перенос и закрытие обеих связанных смен.

Конкретные дата/время окна, фактический target общей БД, backup path и команда deploy намеренно не фиксируются в дизайне: их надо сверить с актуальным окружением и отдельно согласовать непосредственно перед выполнением окна.
