# Firebase TEST — опубликовано 27.10.2026

**Статус: правила проекта samosval-offline, база (default), опубликованы через Firebase Console; активная версия Today • 9:23 PM (МСК).** После перезагрузки консоли полный текст побайтно совпал с проверенным кандидатом. Контрольные суммы и границы — `firebase-live-deployment.json`.

## Сохранённый доступ

В браузере уже была действующая авторизация Google; Firebase Console и нужный проект открыты и проверены. Это отдельный доступ от плагина и CLI. Firebase-плагин не установлен. Firebase CLI 15.34.1 установлена в рабочей среде, но её отдельный вход не завершён и токен CLI не создан. Пароли/токены не запрашивались в чате и не помещались в репозиторий. Сессия браузера может истечь или быть отозвана; сохранность при пересоздании среды не гарантирована.

## Фактическая база и изменения

Резервная копия действовавших правил: `firestore.live-before-20261027.rules`, опубликованная до изменения в ветке PR #21. Она отличается от прежней копии репозитория: другой owner UID, validCoinAdjustment/coinTransactions и отсутствие ledger-блока. Поэтому применён новый diff именно поверх серверной копии: `firebase-live-integration.patch`.

Опубликованный полный текст: `firestore.live-integrated.rules`; канонический `firestore-timesheet-test.rules` приведён к нему. Префикс identity/users/settings/owner/coin helper и весь суффикс от trucks (Line/trips/archive/audit/coins/notifications) сохранены побайтно. В общем fallback исключены только коллекции табеля, сохранён запрет обхода coinTransactions. Production не открыт и не изменён.

Добавлены настройки/листы/дни/объёмы и строгий прежний протокол табеля: роли и объектная ACL, ревизия, idempotent квитанция, атомарные пакеты до четырёх строк, неизменяемая история и soft-delete. В первом кандидате запись часов превышала лимит выражений Firestore; повторная проверка главного допуска внутри каждого grant удалена, оба права записи entry проверяются по одному снимку ACL. Набор требуемых прав не расширен.

## Проверки

- Интегрированные правила на фактической серверной базе: создание/редактирование листов, настройки/заявки, реальные object/month запросы, четыре строки техники/экипажа, конкуренция, квитанции, immutable audit, запреты чужого объекта/роли/после отзыва доступа — успешно.
- Прежний suite табеля против этих правил — успешно: справочники, экипаж/часы, повтор, конфликт/атомарность, аудит, материалы, soft-delete и отзыв доступа.
- Suite монет против этих же правил — успешно: начисления, recipient queries, права, валидация, immutability и общий доступ к trucks.
- Sandbox проверен отдельно, не публиковался.
- Firebase Console приняла публикацию; активный текст после reload полностью совпал с тестовым.
- Границы live baseline, SHA-256 и соответствие канонического файла закреплены `tests/tabel/rules-boundary.py`.

Команды повторения:

```sh
TABEL_RULES_PATH=test-app/tabel/proposals/firestore.live-integrated.rules FIRESTORE_EMULATOR_JAR=/absolute/emulator.jar node tests/tabel/emulator.cjs
TIMESHEET_RULES_PATH=test-app/tabel/proposals/firestore.live-integrated.rules NODE_PATH=tests/timesheet/node_modules FIRESTORE_EMULATOR_JAR=/absolute/emulator.jar node tests/timesheet/emulator.cjs
python3 tests/tabel/rules-boundary.py
```

Не выполнены: вход в само приложение и реальный обмен двух устройств; приложение было разлогинено. Локальные тесты/Console не объявляются проверкой телефона. Физический Android/S Pen/native share также не проверены. Версия frontend не менялась: 3.4.15. Версия rules: test-tabel-20261027.1.

## Откат

Повторно опубликовать точный текст `firestore.live-before-20261027.rules` только в `samosval-offline/(default)` и проверить активную версию. Коллекции, IndexedDB и очереди не удалять. Для отката репозитория — отдельный revert PR с возвратом канонического rules-файла; он сам по себе не откатывает сервер Firebase.
