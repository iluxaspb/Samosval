# Инвентарь workspace-запросов (design §12, Task 28)

Ветка `feature/wtest-parallel-shifts-20261123`, HEAD `285ef7c`. Документ составлен **по факту кода**: каждый
запрос открыт в файле и подтверждён номером строки. Классы — по design §12:

* **1** — действительно workspace-wide каталог/агрегация; обязан быть обоснован.
* **2** — данные, принадлежащие смене; обязан иметь `workspace_id AND shift_id` (design §4.2: «Все
  update/delete включают `workspace_id AND shift_id AND truck_id`»).
* **3** — admin list; требует явной pagination/limit.

Колонка «shift_id в WHERE»: `да` — параметр присутствует; `н/п` — таблица не принадлежит смене (каталог,
настройки, очередь, архивная серия и т. п.); `нет` — отсутствует (для класса 2 разбирается в вердикте).

Запрещённые design §12 конструкции (`LIMIT 1` как выбор «текущей смены», workspace-wide очистка
statuses/logs, поиск смены по object/day/type) отдельно отмечены в вердиктах.

## Реестр

| файл | запрос (кратко) | таблицы | класс | shift_id в WHERE | вердикт |
|---|---|---|---|---|---|
| `line-read.mjs` | `readLineSnapshot` L20–23: активные/closing, не restored, `ORDER BY shift_id LIMIT 2` | `shifts` | 1 | нет | ОК: legacy v1 «одна линия»; при >1 бросает `multiple-active-shifts` (fail-closed), чужая смена не читается |
| `line-read.mjs` | L28–31: список restored-смен workspace | `shifts` | 1 | нет | ОК: restored-контексты возвращаются отдельным массивом и не смешиваются с линией |
| `line-read.mjs` | L32–35: логи restored-смены по `row.shift_id` | `line_logs` | 2 | да | ОК |
| `line-read.mjs` | L38–40: каталог техники | `line_trucks` | 1 | н/п | ОК: каталог |
| `line-read.mjs` | L43–45: статусы активной смены | `line_truck_statuses` | 2 | да | ОК |
| `line-read.mjs` | L47–49: рейсы активной смены | `line_logs` | 2 | да | ОК |
| `line-read.mjs` | L52: `cycle_minutes` workspace | `workspaces` | 1 | н/п | ОК |
| `shift-start.mjs` | `startShiftOperation` L40–42: активные/closing смены workspace `FOR SHARE` | `shifts` | 1 | нет | ОК: legacy v1 старт одной линии; отказ при любой активной/закрывающейся смене, данные B не читаются |
| `shift-start.mjs` | L47–48: `EXISTS(line_logs)` + `EXISTS(line_truck_statuses)` workspace | `line_logs`, `line_truck_statuses` | 1 | нет | ОК: проверка «линия пуста» перед legacy-стартом, fail-closed; ничего не выбирает и не меняет |
| `shift-start.mjs` | L49: объект по id | `workspace_objects` | 1 | н/п | ОК |
| `shift-start.mjs` | L51–52: проверка занятости `shift_id` и INSERT | `shifts` | 2 | да | ОК |
| `shift-start.mjs` | L27/L29/L56: receipt по `operation_id` | `shift_operation_receipts` | 1 | нет | ОК: точная identity операции |
| `shift-close.mjs` | `closeShiftOperation` L24: смена по id `FOR UPDATE` | `shifts` | 2 | да | ОК |
| `shift-close.mjs` | L27: архив по смене | `shift_archives` | 2 | да | ОК |
| `shift-close.mjs` | L33–34, L66–67: логи/статусы смены | `line_logs`, `line_truck_statuses` | 2 | да | ОК |
| `shift-close.mjs` | L39: INSERT архива | `shift_archives` | 2 | н/п (новая строка) | ОК |
| `shift-close.mjs` | L41, L74: UPDATE смены по id | `shifts` | 2 | да | ОК |
| `shift-close.mjs` | L62: запись табеля по `record_id` | `tabel_records` | 1 | н/п | ОК: табель — object-level, не shift-owned |
| `shift-close.mjs` | L70–71: DELETE логов/статусов смены | `line_logs`, `line_truck_statuses` | 2 | да | ОК: чистит только свою смену |
| `shift-close-v2.mjs` | `pendingReceipts` L92–95: pending receipts смены | `shift_operation_receipts` | 2 | да | ОК |
| `shift-close-v2.mjs` | `openDetachedTripForShift` L105–108 | `detached_open_trips` | 2 | да | ОК |
| `shift-close-v2.mjs` | `loadLineSource` L134–141 | `line_logs`, `line_truck_statuses` | 2 | да | ОК |
| `shift-close-v2.mjs` | `loadCloseRow` L191–194 | `shifts` | 2 | да | ОК |
| `shift-close-v2.mjs` | `prepareShiftClose` L278–308: INSERT series/revision/audit, UPDATE shift | `shift_archive_series`, `shift_archive_revisions`, `archive_audit`, `shifts` | 2 | да (по `shift_id`/`source_shift_id`) | ОК |
| `shift-close-v2.mjs` | L389–397: series/revision по `archive_id` `FOR UPDATE` | `shift_archive_series`, `shift_archive_revisions` | 1 | н/п | ОК: архивная identity |
| `shift-close-v2.mjs` | L422–424: material marker смены `FOR UPDATE` | `shift_material_markers` | 2 | да | ОК |
| `shift-close-v2.mjs` | L531–538: series/revision по `archive_id` | `shift_archive_series`, `shift_archive_revisions` | 1 | н/п | ОК |
| `shift-close-v2.mjs` | L570–572: marker смены | `shift_material_markers` | 2 | да | ОК |
| `shift-close-v2.mjs` | L600–604: CAS `latest_finalized_*` по `archive_id` | `shift_archive_series` | 1 | н/п | ОК |
| `shift-close-v2.mjs` | L610–611: DELETE статусов смены | `line_truck_statuses` | 2 | да | ОК: §11 — удаляются только статусы этой смены |
| `shift-close-v2.mjs` | L626–629: UPDATE смены по id | `shifts` | 2 | да | ОК |
| `shift-members-v2.mjs` | `createShift`/`changeShiftObject` L165–167: объект | `workspace_objects` | 1 | н/п | ОК |
| `shift-members-v2.mjs` | L178–180: смена по id `FOR UPDATE` | `shifts` | 2 | да | ОК |
| `shift-members-v2.mjs` | L259–261: INSERT смены | `shifts` | 2 | н/п (новая строка) | ОК |
| `shift-members-v2.mjs` | L276–278: INSERT участника | `shift_members` | 2 | да | ОК |
| `shift-members-v2.mjs` | L318–323: проверка дубля `(object,date,type)` | `shifts` | 1 | нет | ОК: проверка уникальности ключа, а не выбор «текущей смены»; `shift_id<>$5` исключает саму смену |
| `shift-members-v2.mjs` | L334–338: UPDATE смены по id | `shifts` | 2 | да | ОК |
| `shift-members-v2.mjs` | L386–388: профиль участника | `app_users` | 1 | н/п | ОК |
| `shift-members-v2.mjs` | L393–395, L403–405, L425–428, L435–436: участники/ревизия смены | `shift_members`, `shifts` | 2 | да | ОК |
| `shift-members-v2.mjs` | L471–473, L483–485, L490–492, L498–499: удаление участника и ревизия смены | `shift_members`, `shifts` | 2 | да | ОК |
| `shift-trucks-v2.mjs` | `lockShift` L83–86 | `shifts` | 2 | да | ОК |
| `shift-trucks-v2.mjs` | `lockStatus` L136–138: статус по `workspace+truck` `FOR UPDATE` | `line_truck_statuses` | 2 | нет | Оставлено с причиной: общий locker по PK `(workspace,truck_id)`; владелец проверяется вызывающим кодом под той же блокировкой (`existing.shift_id === shiftId`) |
| `shift-trucks-v2.mjs` | `openDetachedTrip` L201–204 | `detached_open_trips` | 2 | нет | Оставлено: структурный инвариант «один открытый цикл на самосвал» проверяет любую смену пары; читается только факт наличия |
| `shift-trucks-v2.mjs` | `requireTruck` L210–211 | `line_trucks` | 1 | н/п | ОК |
| `shift-trucks-v2.mjs` | `bumpShiftRevision` L229–232 | `shifts` | 2 | да | ОК |
| `shift-trucks-v2.mjs` | `assignTruck` L272–274: контекст чужой смены для отказа | `shifts` | 2 | да | ОК: читается только `existing.shift_id` для безопасного отказа |
| `shift-trucks-v2.mjs` | `assignTruck` L297–300: UPDATE статуса (возврат `onLine:false`) | `line_truck_statuses` | 2 | нет | Оставлено с причиной: одна строка на самосвал (PK); `onLine:false` — не назначение линии, `shift_id` и есть изменяемое поле |
| `shift-trucks-v2.mjs` | `assignTruck` L305–308: INSERT статуса | `line_truck_statuses` | 2 | н/п (новая строка) | ОК |
| `shift-trucks-v2.mjs` | `removeTruck` L372–374: DELETE статуса | `line_truck_statuses` | 2 | нет | **НАРУШЕНИЕ** → исправлено: `AND shift_id=$3`; строка уже проверена под `FOR UPDATE` |
| `shift-transfer-v2.mjs` | `forceTransferTruck` L180–185: UPDATE статуса (перенос) | `line_truck_statuses` | 2 | нет | **НАРУШЕНИЕ** → исправлено: `AND shift_id=$5` (source); строка проверена под `FOR UPDATE` |
| `shift-transfer-v2.mjs` | L200–207: INSERT detached | `detached_open_trips` | 2 | да (`source_shift_id`) | ОК |
| `shift-transfer-v2.mjs` | L217–220, L222–225: ревизии обеих смен | `shifts` | 2 | да | ОК |
| `shift-transfer-v2.mjs` | `completeDetachedTrip` L348–350: detached по source+cycle | `detached_open_trips` | 2 | да | ОК |
| `shift-transfer-v2.mjs` | L375–376: техника | `line_trucks` | 1 | н/п | ОК |
| `shift-transfer-v2.mjs` | L381–382: автор | `app_users` | 1 | н/п | ОК |
| `shift-transfer-v2.mjs` | L398–401: INSERT рейса в source | `line_logs` | 2 | да | ОК |
| `shift-transfer-v2.mjs` | L413–417: UPDATE рейса source | `line_logs` | 2 | да | ОК |
| `shift-transfer-v2.mjs` | L432–435: завершение detached | `detached_open_trips` | 2 | да (`cycle_id`) | ОК |
| `shift-transfer-v2.mjs` | L442–445: ревизия source | `shifts` | 2 | да | ОК |
| `line-store.mjs` | `submitLineOperation` L46–48: смена по id | `shifts` | 2 | да | ОК |
| `line-store.mjs` | L52–54: статус по `workspace+truck` `FOR UPDATE` | `line_truck_statuses` | 2 | нет | Оставлено с причиной: legacy v1-канал; `before.shiftId!==op.shiftId` → отказ `truck-not-on-line` |
| `line-store.mjs` | L55–57: техника | `line_trucks` | 1 | н/п | ОК |
| `line-store.mjs` | L75–78: INSERT рейса | `line_logs` | 2 | да | ОК |
| `line-store.mjs` | L83–85: UPDATE статуса | `line_truck_statuses` | 2 | нет | Оставлено с причиной: тот же legacy CAS-гейт, строка заблокирована `FOR UPDATE` |
| `line-store.mjs` | L33–39: receipt по `operation_id` | `line_operation_receipts` | 1 | нет | ОК: identity операции |
| `line-store-v2.mjs` | `submitLineOperationV2` L201–204: lock-колонки смены | `shifts` | 2 | да | ОК |
| `line-store-v2.mjs` | L248–250: техника | `line_trucks` | 1 | н/п | ОК |
| `line-store-v2.mjs` | L288–294: UPDATE статуса | `line_truck_statuses` | 2 | нет | **НАРУШЕНИЕ** → исправлено: `AND shift_id=$7`; гейт `existing.shift_id!==shiftId` уже был |
| `line-store-v2.mjs` | L302–305: INSERT рейса | `line_logs` | 2 | да | ОК |
| `line-store-v2.mjs` | L328–333: ревизия смены | `shifts` | 2 | да | ОК |
| `control-store.mjs` | `activeShift` L13: смена по id | `shifts` | 2 | да | ОК |
| `control-store.mjs` | L33: признак restored смены | `shifts` | 2 | да | ОК |
| `control-store.mjs` | L36–37: статус по `workspace+truck` `FOR UPDATE` | `line_truck_statuses` | 2 | нет | Оставлено с причиной: legacy v1; `membershipStatus` бросает `status-shift-mismatch` при `before.shiftId!==op.shiftId` |
| `control-store.mjs` | L40: UPSERT статуса `ON CONFLICT (workspace,truck)` | `line_truck_statuses` | 2 | нет в conflict target | Оставлено: PK «один текущий статус»; `shift_id` пишется из `op.shiftId` после гейта |
| `control-store.mjs` | L52–53: статус при удалении техники | `line_truck_statuses` | 2 | нет | Оставлено: читается только флаг `onLine` перед удалением каталога |
| `control-store.mjs` | L56–57: смены, ссылающиеся на объект | `shifts` | 1 | нет | ОК: reference-check перед удалением объекта |
| `control-store.mjs` | L44/L47: объект | `workspace_objects` | 1 | н/п | ОК |
| `control-store.mjs` | L59/L65: запись каталога по id | `line_trucks`, `workspace_objects` | 1 | н/п | ОК |
| `control-store.mjs` | `readCatalog` L84: каталог техники/объектов workspace | `line_trucks`, `workspace_objects` | 1 | н/п | ОК: каталог |
| `report-store.mjs` | `currentLog` L15: рейс по `log_id` `FOR UPDATE` | `line_logs` | 2 | нет | Оставлено с причиной: точная identity `log_id` (PK); `shiftId` выводится из самой строки и попадает во все записи |
| `report-store.mjs` | `currentStatus` L18: статус по `truck+shift` | `line_truck_statuses` | 2 | да | ОК |
| `report-store.mjs` | `writeState` L20: UPSERT/DELETE рейса по `log_id` | `line_logs` | 2 | нет | Оставлено: пишет/удаляет ровно ту строку, чей `shiftId` проверен выше и чей `log_id` назван в команде |
| `report-store.mjs` | L21: UPDATE статуса по `truck+shift` | `line_truck_statuses` | 2 | да | ОК |
| `report-store.mjs` | L43: смена по `beforeLog.shiftId` | `shifts` | 2 | да | ОК |
| `report-store.mjs` | L53: предыдущий рейс `truck+shift` | `line_logs` | 2 | да | ОК |
| `report-store.mjs` | L68–69, L72: service audit по operation/action | `workspace_service_audit` | 1 | н/п | ОК |
| `report-store.mjs` | L74: смена по `next.shiftId` | `shifts` | 2 | да | ОК |
| `report-store.mjs` | L79–80: audit/game records по id | `workspace_service_audit`, `game_records` | 1 | н/п | ОК |
| `history-store.mjs` | `historyOperation` L43: история по `action_id` | `line_history` | 2 | нет | Оставлено: точная identity `action_id`; `shift_id` берётся из строки |
| `history-store.mjs` | L53: смена по `target.shift_id` | `shifts` | 2 | да | ОК |
| `history-store.mjs` | L55: строка истории `FOR UPDATE` | `line_history` | 2 | нет | Оставлено: identity `action_id` |
| `history-store.mjs` | L57: статус по `workspace+truck` `FOR UPDATE` | `line_truck_statuses` | 2 | нет | Оставлено с причиной: legacy v1; `sameLineState(current, expected)` сравнивает payload целиком, включая `shiftId` |
| `history-store.mjs` | L62, L64–65: рейс по `log_id` | `line_logs` | 2 | нет | Оставлено: identity `log_id` + сверка `stored` с `log_data` (в нём `shiftId`) |
| `history-store.mjs` | L69: UPDATE статуса | `line_truck_statuses` | 2 | нет | Оставлено: тот же `sameLineState`-гейт, строка заблокирована `FOR UPDATE` |
| `history-store.mjs` | L71: UPDATE истории по `action_id` | `line_history` | 2 | нет | Оставлено: identity `action_id` |
| `history-store.mjs` | `readLineHistory` L90–92: история workspace `LIMIT 300` | `line_history` | 1 / 3 | нет | ОК: каталог истории всего workspace, каждая строка несёт `shift_id`, явный `LIMIT 300` |
| `history-store.mjs` | L96–98: отчёты workspace `LIMIT 300` | `workspace_service_audit` | 1 / 3 | нет | ОК |
| `archive-store.mjs` | `seriesExists`/`revisionsExist` L11/L15: по `archive_id` | `shift_archive_series`, `shift_archive_revisions` | 1 | н/п | ОК: архивная identity |
| `archive-store.mjs` | `submitArchive` L88–89: активные/restored смены workspace `FOR UPDATE` | `shifts` | 1 | нет | ОК: preflight восстановления архива требует пустую линию (fail-closed) |
| `archive-store.mjs` | L98: `EXISTS(line_logs)` + `EXISTS(line_truck_statuses)` workspace | `line_logs`, `line_truck_statuses` | 1 | нет | ОК: проверка «остались ли данные», ничего не выбирает и не меняет |
| `archive-store.mjs` | L104–106: INSERT restored-смены/логов/статусов | `shifts`, `line_logs`, `line_truck_statuses` | 2 | да | ОК |
| `archive-store.mjs` | L109: UPSERT override по `record_id` | `archive_overrides` | 1 | н/п | ОК |
| `archive-read.mjs` | `readArchiveEntries` L31–55: identity state, migration documents, `shift_archives`, `archive_overrides` workspace | `identity_state`, `migration_imports`, `migration_documents`, `shift_archives`, `archive_overrides` | 1 | нет | ОК: снимок архива workspace (не shift-запрос); записи keyed `archiveId`/`sourceShiftId` |
| `archive-latest.mjs` | `listArchiveSeries` L69–74: все серии workspace | `shift_archive_series` | 1 | нет | ОК: каталог серий |
| `archive-latest.mjs` | `readLatestFinalizedArchive` L117: по `archive_id` | `shift_archive_series`, `shift_archive_revisions` | 1 | н/п | ОК |
| `archive-latest.mjs` | `listLatestFinalizedArchives` L126: все серии workspace | `shift_archive_series`, `shift_archive_revisions` | 1 | нет | ОК: каталог |
| `archive-latest.mjs` | `readArchiveRevision` L134–137: ревизия по `archive+revision` | `shift_archive_revisions` | 1 | н/п | ОК |
| `archive-latest.mjs` | `readArchiveHistory` L149–158: цепочка по `archive_id` | `shift_archive_series`, `shift_archive_revisions` | 1 | н/п | ОК |
| `archive-revisions.mjs` | `replayReceipt` L55–56: receipt по `operation_id` | `archive_operation_receipts` | 1 | н/п | ОК |
| `archive-revisions.mjs` | `loadContextState` L69–78: snapshots/logs/history контекста | `restored_context_*` | 1 | н/п | ОК: identity контекста |
| `archive-revisions.mjs` | `finalizeRestoredContext` L180–201: контекст/серия `FOR UPDATE` | `restored_shift_contexts`, `shift_archive_series` | 1 | н/п | ОК |
| `archive-revisions.mjs` | L219–220: базовая ревизия | `shift_archive_revisions` | 1 | н/п | ОК |
| `archive-revisions.mjs` | L252–315: INSERT revision/publication/audit/receipt, UPDATE context/series | `shift_archive_revisions`, `archive_revision_publications`, `archive_audit`, `archive_operation_receipts`, `restored_shift_contexts`, `shift_archive_series` | 1 | н/п | ОК: публикация ровно этой серии под её блокировкой |
| `restored-context-store.mjs` | `readRestoredContext` L63–132: контекст, ревизия, логи (limit 100/200 + cursor), snapshots, история | `restored_shift_contexts`, `shift_archive_revisions`, `restored_context_*` | 1 / 3 | н/п | ОК: identity контекста, явная пагинация |
| `restored-context-store.mjs` | `submitRestoredCorrection` L196–292: контекст `FOR UPDATE`, логи, история, audit, receipt, CAS контекста | `restored_shift_contexts`, `restored_context_*` | 1 | н/п | ОК: правки только своего контекста |
| `backup-store.mjs` | `capture` L40–41: `SELECT *` всех workspace/global таблиц | все workspace-таблицы | 1 | нет | ОК: backup-секция целиком (workspace-wide by design) |
| `backup-store.mjs` | L59–61: INSERT/ротация бэкапов | `workspace_backups` | 1 | н/п | ОК |
| `backup-store.mjs` | `readBackups` L65–66: бэкап по id / список `LIMIT 50` | `workspace_backups` | 1 / 3 | н/п | ОК |
| `backup-store.mjs` | `restore` L71–100: восстановление выбранных секций workspace | все секции | 1 | нет | ОК: полное восстановление секций workspace; не «чтение в контексте смены A» |
| `backup-store.mjs` | L104: `LOCK TABLE` секций | все секции | 1 | н/п | ОК |
| `restore-bootstrap.mjs` | `computeBootstrapFingerprint` L89–224: роли, отношения, функции, расширения, гранты, реестр | системный каталог | 1 | н/п | ОК: deployment bootstrap, не данные смен |
| `tabel-store.mjs` | `readTabel` L62–64: записи/история по `object_id` `LIMIT 51` | `tabel_records`, `tabel_receipts` | 1 / 3 | н/п | ОК: табель — object-level, не shift-owned; лимит есть |
| `tabel-store.mjs` | L88–124: advisory lock, receipt, baseline, UPSERT записи/квитанции | `tabel_records`, `tabel_receipts` | 1 | н/п | ОК |
| `tabel-presence.mjs` | SQL-запросов нет (нормализация и in-memory сервис) | — | — | н/п | ОК |
| `game-store.mjs` | `gameData` L49–53: game_records workspace + `line_history JOIN shifts` workspace | `workspace_services_state`, `game_records`, `line_history`, `shifts` | 1 | нет | ОК: игровая экономика workspace-wide по design (game-transfer: калькулятор использует факты истории всех смен) |
| `game-store.mjs` | `submitGame` L91: `EXISTS` любой активной смены | `shifts` | 1 | нет | ОК: гейт «есть открытая смена», смена не выбирается |
| `game-store.mjs` | L82, L109–110: INSERT game_records | `game_records` | 1 | н/п | ОК |
| `game-transfer.mjs` | SQL-запросов нет (фильтр полей записи) | — | — | н/п | ОК |
| `replica-heads.mjs` | `materializeCanonical`/`deleteCanonical` L316–425: UPSERT/DELETE `shifts`, `line_trucks`, `line_truck_statuses`, `line_logs`, объекты, пользователи, настройки, архивы по id документа | канонические таблицы | 1 | нет | ОК: материализация всей коллекции по id документа, не shift-контекст |
| `replica-heads.mjs` | `canonicalExists` L631–640: наличие документа по id | канонические таблицы | 1 | нет | ОК |
| `replica-materialize.mjs` | `applyReplicaDocument` L78–208: UPSERT/DELETE коллекции по id документа | канонические таблицы | 1 | нет | ОК: материализация всей коллекции |
| `server-control.mjs` | `readServerControl` L31–37: state/jobs/events/objects/users/database/backups, лимиты 20/80/200/10 | `server_control_*`, `workspace_objects`, `shifts`, `app_users`, `workspace_backups` | 3 | нет | ОК: admin list с явными лимитами; `active_shifts` — агрегация по объекту |
| `server-control.mjs` | `submitServerCommand` L45–55: job по id, advisory lock, INSERT job/event | `server_control_jobs`, `server_control_events` | 1 | н/п | ОК |
| `senior-foreman` | файла `server/src/senior-foreman.mjs` нет; реализация — `shift-access-v2.mjs` L81–82 (смена по id), L98–99 (membership по shift+uid), L124–126 (права роли), L150–151 (профиль) и DDL `sql/020_senior_foreman.sql` | `shifts`, `shift_members`, `role_permissions`, `app_users` | 2 | да (где данные смены) | ОК: ACL-путь, все shift-запросы scoped |
| `notification-store.mjs` | `enqueueNotification` L4: настройки workspace | `workspace_settings` | 1 | н/п | ОК |
| `notification-store.mjs` | L7: INSERT outbox | `notification_outbox` | 1 | н/п | ОК |
| `notification-store.mjs` | `readNotifications` L9: counts по workspace | `notification_outbox` | 1 | нет | ОК |
| `notification-store.mjs` | `deliverNotification` L11: pending `LIMIT 1 FOR UPDATE SKIP LOCKED` | `notification_outbox` | 1 | нет | ОК: `LIMIT 1` — выбор задачи очереди доставки, не «текущей смены»; outbox не принадлежит смене |
| `notification-store.mjs` | L19: UPDATE outbox по `workspace+event_id` | `notification_outbox` | 1 | н/п | ОК |
| `settings-store.mjs` | `readSettings`/`submitSettings` L39, L47: настройки workspace | `workspace_settings` | 1 | н/п | ОК |
| `settings-store.mjs` | L56–57: UPDATE `workspaces`/`workspace_settings` | `workspaces`, `workspace_settings` | 1 | н/п | ОК |
| `shift-read-v2.mjs` | `readShiftSnapshot` L276–330: смена, участники, статусы, логи, detached по `workspace+shift` | `shifts`, `shift_members`, `line_truck_statuses`, `line_logs`, `detached_open_trips` | 2 | да | ОК: единственный shift-scoped снимок |
| `shift-read-v2.mjs` | `listVisibleShifts` L135–200: keyset-страница видимых смен | `shifts`, `shift_members` | 3 | да (по каждой смене) | ОК: явная keyset-pagination (`limit`+`cursor`) |

## Сводка

* **нарушений: 3** — все класса 2, все в v2-модулях, все формальные (отсутствие `shift_id` в `WHERE`
  при уже существующем гейте по заблокированной строке):
  1. `line-store-v2.mjs:288–294` — `UPDATE line_truck_statuses` по `workspace+truck`; добавлено
     `AND shift_id=$7`. Гейт `existing.shift_id !== shiftId` был и остаётся.
  2. `shift-trucks-v2.mjs:372–374` (`removeTruck`) — `DELETE line_truck_statuses` по `workspace+truck`;
     добавлено `AND shift_id=$3`. Гейт `existing.shift_id !== shiftId` был и остаётся.
  3. `shift-transfer-v2.mjs:180–185` (`forceTransferTruck`) — `UPDATE line_truck_statuses` по
     `workspace+truck`; добавлено `AND shift_id=$5` (source). Гейт `status.shift_id !== sourceShiftId`
     был и остаётся.

  Поведение не изменилось (гейты уже отказывали чужой смене); исправление приводит код к норме design
  §4.2 «все update/delete включают `workspace_id AND shift_id AND truck_id`» и убирает зависимость
  безопасности от порядка строк в коде.

* **поведенческих нарушений (реальный доступ A к строкам B): 0.** Trap-тест
  `server/tests/v2-query-isolation-db.test.mjs` фиксирует это строками, а не намерениями.

* **оставлено с причиной:**
  * `line-store.mjs:52–54, 83–85` — legacy v1-канал; `before.shiftId !== op.shiftId` → отказ
    `truck-not-on-line`; строка под `FOR UPDATE`.
  * `history-store.mjs:57, 69` — legacy v1 undo/redo; `sameLineState(current, expected)` сравнивает
    payload целиком, включая `shiftId`; при несовпадении — `dependent-changes`.
  * `control-store.mjs:36–37, 40` — legacy v1 control; `membershipStatus` бросает `status-shift-mismatch`
    при `before.shiftId !== op.shiftId`.
  * `report-store.mjs:15, 20` и `history-store.mjs:43, 55, 62, 64–65, 71` — запросы по точной identity
    (`log_id`/`action_id`, PK) с последующей сверкой `shiftId`; двусмысленного выбора смены нет.
  * `shift-trucks-v2.mjs:136–138` (`lockStatus`), `201–204` (`openDetachedTrip`), `297–300`
    (`assignTruck`, возврат `onLine:false`) — общий locker по PK и структурный инвариант «одна строка на
    самосвал»; `shift_id` — либо проверяемое, либо изменяемое поле, а не фильтр.

* **класс 1** обоснован для: каталогов (техника/объекты/архив/история), backup-секции целиком,
  replica-материализации всей коллекции, архивных серий/ревизий (identity `archive_id`), игровой
  экономики, настроек, очереди уведомлений, deployment-bootstrap. Все они либо не принадлежат смене, либо
  по design обязаны читать workspace целиком и не смешивают строки A и B.

* **класс 3**: явные лимиты есть у `server-control` (20/80/200/10), `readBackups` (50),
  `readLineHistory` (300), `readTabel` (51), `readRestoredContext` (100, max 200 + cursor),
  `listVisibleShifts` (keyset). `readArchiveSnapshot`/`readArchiveEntries` — не admin list, а снимок
  архива workspace (класс 1): контракт legacy `/api/archive` возвращает каталог целиком, pagination
  изменила бы API и не относится к изоляции смен.

* **не найдено файла** `server/src/senior-foreman.mjs`: роль `senior_foreman` реализована в
  `shift-access-v2.mjs` + `tabel-access.mjs` + DDL `sql/020_senior_foreman.sql`; в реестре выше
  проверены все SQL-запросы этой реализации.
