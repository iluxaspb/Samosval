# Кнопка «Дубликат» (самосвал не приехал) — план реализации

Дата: 28.11.2026. Ветка: `feature/no-return-20261128` (от `feature/synology-snapshot-cache-20261128`).
Канал: только тестовая линия `working-test`. Рабочая версия — отдельным выпуском после испытания владельцем.

## Решение владельца (что именно делаем)

1. На карточке самосвала в вкладке «Линия», рядом с кнопкой ТТН, появляется маленькая компактная **красная кнопка «Дубликат»**.
2. Нажатие (удержание 0,5 с) = статус «самосвал не приехал» (сломался / не приехал на линию): карточка затемняется как при ТТН и уходит в конец списка.
3. Нажатие «Приехал» снимает этот статус — карточка снова активна.
4. В «Сводке» на листке: в графе **следующего после последнего рейса** — крупная красная русская **Д** тем же шрифтом, что номер рейса; в графе самосвала — маленькая красная **Д**. То же на **листе ГАИ**.
5. Латинская `D` («старый механизм»: рейсы есть, ТТН не забрана) **убирается**: вместо неё везде та же русская Д. Старый косвенный признак остаётся резервом для **архивных** листов (кнопку не нажали, смену закрыли — Д всё равно появится).
6. Новое право в админке — флажок «Кнопка „Дубликат“». По умолчанию: старший прораб, прораб, мастер, администратор — да; лопатёр, наблюдатель — нет.
7. **Размер ячеек таблицы «Сводки» не меняется.** Д вписывается в существующую клетку; лишняя колонка добавляется только если без неё букву некуда поставить.

## Контракт (единый для всех задач)

- Тип операции линии: строка `'no-return'`.
- Поле статуса самосвала в payload `line_truck_statuses`: `noReturn: true` (плюс `noReturnAt` — мс, `noReturnBy` — имя, `noReturnOperationId`). Отсутствие флага = машина работает.
- Право: `action_no_return` (клиент) / строка `action_no_return` в `role_permissions` (сервер) / v2-действие `shift.line.no-return`.
- Снятие статуса: обычная операция `arrive` с `wantArrived: true`. Она же ставит прибытие, поэтому после «Приехал» карточка сразу активна.
- Пока `noReturn === true`: `load` и `ttn` отклоняются (`truck-absent`), повторный `no-return` отклоняется (`already-absent`), `arrive` разрешён и снимает флаг.
- При выставлении `no-return` прибытие снимается (`arriveStatus/arriveTimestamp/arriveBy = null`), `lastLoadTimestamp` **не** трогается (кулдаун ходки остаётся честным).
- Д в листке: `st.noReturn === true` (новый механизм) **или** архивный резервный признак «есть рейсы, ТТН не забрана».

---

## Задача A. Сервер: тип `no-return`, право, миграция

Файлы: `server/src/line-rules.mjs`, `server/src/line-store.mjs`, `server/src/line-store-v2.mjs`, `server/src/shift-access-v2.mjs`, `server/src/identity-rules.mjs`, `server/sql/031_no_return_permission.sql`, `server/tests/*`.

1. `line-rules.mjs`
   - `validateLineOperation`: `['arrive','load','ttn','reset','no-return'].includes(input.type)`.
   - `applyLineOperation`: в проверку `!['arrive','load','ttn','reset'].includes(op.type) → reject('unsupported')` добавить `'no-return'`.
   - Новая ветка **до** ветки `ttn` (после `load`):
     ```js
     if (op.type === 'no-return') {
       if (before.noReturn === true) return reject('already-absent');
       if (revision !== expectedRevision) return reject('arrival-changed');
       const ts = Math.max(Number(op.createdAt) || 0, Number(before.lastLoadTimestamp || 0) + 1);
       const changes = {
         noReturn: true, noReturnAt: ts, noReturnBy: actor.name, noReturnOperationId: op.id,
         arriveStatus: null, arriveTimestamp: null, arriveBy: null,
         cycleRevision: revision + 1,
       };
       return { outcome: 'confirmed', status: { ...before, ...changes }, eventTime: ts, changed: true };
     }
     ```
   - Ветка `load`: первой строкой `if (before.noReturn === true) return reject('truck-absent');`
   - Ветка `ttn`: первой строкой `if (before.noReturn === true) return reject('truck-absent');`
   - Ветка `arrive`: в оба варианта `changes` (want true / want false) добавить
     `noReturn:false, noReturnAt:null, noReturnBy:null` — прибытие снимает «не приехал».
   - Ветку `reset` не менять.
2. `line-store.mjs`: `ACTIONS` → `'no-return': 'action_no_return'`.
3. `line-store-v2.mjs`: `LINE_TYPES` + `'no-return'`; `LINE_ACTIONS` + `'no-return': 'shift.line.no-return'`; в `domainRefusal` добавить
   `case 'truck-absent': return v2Error('truck-not-on-shift', 409, { truckId: context.truckId, shiftId: context.shiftId, reason: 'truck-absent' });`
   и `case 'already-absent': return v2Error('invalid-command', 400, { field: 'type' });` (повтор бессмыслен).
   `nextCycleRevision` уже увеличивает ревизию для всех типов кроме `ttn` — правок не требует.
4. `shift-access-v2.mjs`: в `SHIFT_ACTIONS` добавить
   `'shift.line.no-return': Object.freeze({ rights: Object.freeze(['action_no_return']), closing: 'blocked' }),`
5. `identity-rules.mjs`: в `ACTIONS` добавить `'action_no_return'` сразу после `'action_ttn'`.
6. `server/sql/031_no_return_permission.sql` (образец — `019_line_timer_reset.sql`):
   ```sql
   -- Право «Кнопка Дубликат» (самосвал не приехал). По умолчанию включено
   -- мастеру, прорабу и старшему прорабу; лопатёру и наблюдателю выключено.
   BEGIN;
   INSERT INTO role_permissions(role, action, allowed)
   SELECT role, 'action_no_return', false
   FROM (SELECT DISTINCT role FROM role_permissions) src
   WHERE role <> 'admin'
   ON CONFLICT (role, action) DO NOTHING;
   INSERT INTO role_permissions(role, action, allowed)
   VALUES ('senior_foreman','action_no_return',true),('foreman','action_no_return',true),('master','action_no_return',true)
   ON CONFLICT (role, action) DO UPDATE SET allowed = true;
   INSERT INTO role_permission_versions(role) VALUES ('senior_foreman') ON CONFLICT DO NOTHING;
   COMMIT;
   ```
7. Тесты `server/tests/line-rules.test.mjs` (дописать кейсы, не переписывать существующие):
   - `no-return` подтверждается, ставит `noReturn:true`, снимает прибытие, увеличивает `cycleRevision` на 1;
   - повторный `no-return` → `already-absent`;
   - `load` и `ttn` при `noReturn:true` → `truck-absent`;
   - `arrive` при `noReturn:true` → подтверждается, `noReturn:false`, `arriveStatus` заполнен.
   Прогон: `node --test server/tests/line-rules.test.mjs`.

**Готово, когда:** тест-файл зелёный, `node --check` по изменённым файлам без ошибок.

## Задача B. Клиент: право, кнопка, затемнение, сортировка, офлайн

Файлы: `working-test/source/core/00-config-state.js`, `core/17-trip-actions.js`, `core/18-line-ui.js`, `core/16-offline-replay.js`, `features/anim-speeds.js`, `styles/style-04.css`, `features/undo-redo.js`, `working-test/synology/session-client.mjs`.

1. `00-config-state.js`: в `ALL_ACTIONS` после `'action_ttn'` — `'action_no_return'`;
   в `ACTION_LABELS` — `action_no_return: 'Кнопка «Дубликат» (самосвал не приехал)'`;
   в `DEFAULT_PERMISSIONS` добавить `'action_no_return'` в `actions` для `senior_foreman`, `foreman`, `master`; `lopater` и `viewer` — не добавлять.
2. `18-line-ui.js`, `renderPermissionsMatrix`: группа `'Работа самосвалов'` → `['action_arrive','action_load','action_ttn','action_no_return','line_timer_reset']`.
3. `working-test/synology/session-client.mjs`, `submitLine`: белый список типов → `['arrive','load','ttn','reset','no-return']`.
4. `17-trip-actions.js`:
   - `toggleNoReturn(id,capturedIntent)` — по образцу `toggleTtn`, право `action_no_return`;
   - в `startHold` ветка `type==='no-return'`: право `action_no_return`, длительность `settings.holdNoReturn ?? 0.5`, проверки загрузки/прибытия не применять, но `if (st.noReturn === true) { showToastEl('Вернуть машину — кнопкой «Приехал»', false); return; }`;
   - `executeAction`: `else if (type==='no-return') { toggleNoReturn(id); }`;
   - `startNoReturnHold(e,id)`.
   - `queueLineCommand` уже пропускает любой тип, кроме online-only — правок не требует.
5. `16-offline-replay.js`:
   - `offlineProjection`: ветка
     ```js
     }else if(op.type==='no-return'){
       st.noReturn=true;st.noReturnAt=t;st.noReturnBy=op.actor;
       st.arriveStatus=null;st.arriveTimestamp=null;st.arriveBy=null;
       st.cycleRevision=Number(st.cycleRevision||0)+1;
     }
     ```
     и в ветке `arrive` (оба варианта) — `st.noReturn=false;st.noReturnAt=null;st.noReturnBy=null;`
   - `offlineQueueAction`: перед проверками `load/arrive` — `if(type==='no-return'&&before.noReturn===true){showToastEl('Вернуть машину — кнопкой «Приехал»',false);return false;}`
   - подписи в трёх местах (`offlineLocalTicker`, тост `offlineQueueAction`, `offlineNotifyAccepted`): добавить ветку `op.type==='no-return' ? '🚫 Не приехал' : ...`.
   - `offlineUndoFields`: `if(op.type==='no-return')return {prevNoReturn:true,prevNoReturnAt:b.noReturnAt||null,prevNoReturnBy:b.noReturnBy||null};`
6. `18-line-ui.js`, `renderLine`:
   - сортировка: в начало компаратора
     `let nA=sA.noReturn===true?1:0, nB=sB.noReturn===true?1:0; if(nA!==nB) return nA-nB;`
   - `let absent = st.noReturn===true; let faded = ttn===true || absent;`
   - `canEditNoReturn = hasPermission('action_no_return')`;
   - `renderKey`: добавить `st.noReturn===true` и `canEditNoReturn` в массив (иначе карточка не перерисуется после смены статуса);
   - ТТН-кнопка: `${!canEditTtn||absent?'disabled':''}`;
   - разметка строки действий: четвёртая кнопка
     `<button class="btn btn-no-return" ${!canEditNoReturn||absent?'disabled':''} ${canEditNoReturn&&!absent?`onpointerdown="startNoReturnHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''}>Дубликат</button>`
   - в блоке имени машины при `absent` — `<span class="absent-mark">не приехал</span>`.
7. `features/anim-speeds.js` (реально работающий рендерер — правку повторить полностью):
   - сортировка: `noReturn` первым ключом (машины «не приехал» — в самом конце списка);
   - `const absent = st.noReturn === true; const faded = (ttn === true && !isA) || absent;`
   - `canEditNoReturn`, ТТН-кнопка с `||absent`, четвёртая кнопка `btn-no-return` с `startNoReturnHold`, метка `absent-mark`;
   - в CSS-блоке этого файла: `.truck-card .action-row { grid-template-columns: auto 2fr 1fr auto !important; }`, `.truck-card .btn-no-return { font-size: 9.5px !important; padding: 2px 4px !important; }`.
8. `styles/style-04.css`:
   - `.action-row { display: grid; grid-template-columns: auto 2fr 1fr auto; gap: 8px; }`
   - `.btn-no-return { background: var(--danger); font-size: 10px; padding: 4px 6px; }`
   - добавить `.btn-no-return` в списки `.btn-arrive::after, .btn-quick::after, .btn-ttn::after` и `.holding::after`;
   - `.absent-mark { color: #ef4444; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .02em; }`
   - `.truck-card.faded .absent-mark { color: #f87171; }`
9. `features/undo-redo.js`: в двух словарях подписей добавить `'no-return':'Не приехал'`.
10. `18-line-ui.js`, `auditTruckAction` — `'no-return': '🚫 Самосвал не приехал'`.

**Готово, когда:** существующие тесты `working-test/source/core/*.test.mjs` (кроме известного зависающего `32-tabel-live-sync.test.mjs`) зелёные, `node --check` по изменённым файлам чист.

## Задача C. Листки: Д вместо D, без изменения размера ячеек

Файлы: `working-test/source/core/09-reports.js`, `core/08-png-export.js`, `core/10-archive.js`, `features/paper-viewer.js`, `styles/style-04.css`.

Общие правила:
- крупная Д — в клетке сразу после последнего рейса: `<div class="paper-absent-mark" title="Самосвал не приехал" aria-label="Самосвал не приехал">Д</div>`;
- маленькая Д — в графе самосвала рядом с названием: `<span class="paper-absent-badge" title="Самосвал не приехал" aria-label="Самосвал не приехал">Д</span>`;
- обе красные (`#dc2626`), шрифт Caveat (как номер рейса), крупная — `font-size:32px; line-height:1;`, маленькая — `font-size:14px`;
- `white-space:nowrap` не добавлять, ширина колонок не задаётся.

1. `09-reports.js`, обычный лист:
   - `let absent = st.noReturn === true;` вместо `isDup`/`dupHtml` (латинскую D из живого листа убрать полностью);
   - `maxT`: после расчёта по рейсам — `if (rTrucks.some(t=>{const s2=state.truckStatus[t.id]||{};return s2.noReturn===true;})) maxT = Math.max(maxT, Math.max(...rTrucks.map(t=>stdLogs.filter(l=>l.truckId===t.id).length))+1);` (одна дополнительная колонка только если есть «не приехавшие»);
   - в цикле клеток **перед** ветками `pending`/`arrive`: `else if (i === tL.length && absent) cells += '<td><div class="cell-content"><div class="paper-absent-mark">Д</div></div></td>';`
   - в графе самосвала: `${absent?'<span class="paper-absent-badge">Д</span>':''}`.
2. `09-reports.js`, лист ГАИ: то же самое (та же буква, тот же размер; `maxT` для ГАИ считать по `gaiLogs`).
3. `08-png-export.js`, `buildReportHTML` (живой PNG-лист): заменить `isDup`/`dupHtml` на `absent` (для `isClosed`-ветки оставить архивное правило) и добавить те же две метки; `maxTrips` увеличивать по тому же правилу.
4. `10-archive.js` (архивный лист): латинскую `D` заменить на маленькую Д (`.paper-absent-badge`), условие оставить архивным (`l.length>0 && ttnStatus[t.id]!==true && ttnStatus[t.id]!=='pending'`). Крупную Д в архивный лист не добавлять — в архиве нет серверного флага `noReturn`.
5. `features/paper-viewer.js`, `renderArchiveSheet`: то же — `dup` → маленькая Д.
6. `styles/style-04.css`: добавить
   ```css
   .paper-absent-mark { font-family:'Caveat',cursive; font-weight:900; font-size:32px; line-height:1; color:#dc2626; }
   .paper-absent-badge { color:#dc2626; font-family:'Caveat',cursive; font-weight:900; font-size:14px; margin-left:4px; }
   ```

**Готово, когда:** в живом листе и листе ГАИ есть крупная и маленькая Д у «не приехавшего», таблица не расширилась, `tests/paper-viewer/static.cjs` (эталон продакшена, не наш канал) не трогаем.

## Задача D. Проверки и выпуск

1. `node --test server/tests/line-rules.test.mjs`, `node --test working-test/source/core/*.test.mjs` (без `32-tabel-live-sync.test.mjs`).
2. `node --test tests/tabel-v2/*.test.mjs`.
3. Браузер Chromium 393×852 на локальном http: карточка, кнопка «Дубликат» (в ряд влезает, ничего не обрезано), удержание 0,5 с, затемнение, уход в конец, «Приехал» снимает, Д в «Сводке» и листе ГАИ, ширина таблицы не изменилась, консоль без `pageerror`.
4. Сборка `tools/build-working-test.py`, версия 1.10.6 в `shell.html` + `working-test-release.js` + первая запись `release-history.js`, миграция 031 в тестовом API, публикация, проверка live + SHA.

## Известные ограничения (сообщить владельцу)

- В архивном листе Д появляется только по резервному признаку (рейсы есть, ТТН не забрана): серверный флаг `noReturn` в архив не пишется, чтобы не менять формат архива в этом выпуске.
- Счётчик «N маш.» в шапке не меняется: «не приехавший» самосвал по-прежнему считается машиной на линии.
- Запись в журнал/аудит и монеты: операция попадает в журнал отмены (undo/redo работает), монеты за неё не начисляются.
