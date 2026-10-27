# Firebase TEST — подготовка правил, 27.10.2026

Приложение 3.4.15. Тестовый проект: `samosval-offline`. Production не входит в поручение.

**НЕ опубликовано в Firebase.** Сохранённая авторизация CLI/подключение Firebase не подтверждены. Действующие опубликованные rules не прочитаны; перед развёртыванием требуется их backup и сравнение с базой репозитория. Пользователь явно разрешил публикацию необходимых тестовых правил.

## Исправленный кандидат

Полный файл: `firestore.integrated-emulator.rules`; diff: `firebase-integration-NOT-APPLIED.patch`. В первом кандидате запись часов на настроенном объекте превышала лимит выражений правил. Убрана повторная проверка главного допуска внутри каждого объектного grant: вызывающие read/write-правила уже проверяют активный аккаунт и доступ к табелю. Для записи часов права смены и категории проверяются по одному снимку ACL. Набор требуемых прав не расширен.

## Проверено

- Интегрированный кандидат: создание/редактирование листов, настройки/заявки, конкурирующие клиенты, квитанции, immutable audit, запреты без прав и после отзыва доступа.
- Настоящие запросы плагина по objectId/month: настройки, листы, дни, объёмы, часы и материалы. Незаданные права другого объекта не допускают чтение/запись.
- Пакет из четырёх записей техники/экипажа на объекте с ACL проходит в пределах лимитов Firestore.
- Те же новые сценарии в изолированном sandbox (без legacy materials, которые он намеренно не предоставляет).
- Прежний протокол табеля против интегрированного кандидата: справочники/экипаж, часы, повтор, конфликт/атомарность, аудит, материалы, soft-delete и отзыв доступа — успешно. Чтение строк/материалов ограничено объектом и месяцем, как в плагине; общий запрос всех объектов не подменяет объектную ACL.
- Префикс правил аккаунтов/ролей/настроек и суффикс trucks/Line/trips/archive/audit побайтно совпадают с каноническим `firestore-timesheet-test.rules`. Сам канонический файл, frontend и production не изменены.

Команды из корня репозитория:

```sh
FIRESTORE_EMULATOR_JAR=/absolute/emulator.jar node tests/tabel/emulator.cjs
TABEL_RULES_PATH=test-app/tabel/proposals/firestore.integrated-emulator.rules FIRESTORE_EMULATOR_JAR=/absolute/emulator.jar node tests/tabel/emulator.cjs
TIMESHEET_RULES_PATH=test-app/tabel/proposals/firestore.integrated-emulator.rules NODE_PATH=tests/timesheet/node_modules FIRESTORE_EMULATOR_JAR=/absolute/emulator.jar node tests/timesheet/emulator.cjs
```

## Перед публикацией и откат

Прочитать действующий ruleset тестового проекта, сохранить его ID и полный текст; перенести только проверенный табельный diff на эту базу; повторить эмулятор. Сначала test/compile, затем deploy только Firestore rules и только project `samosval-offline`. Проверить фактический активный ruleset и сохранение/чтение через клиента. Для отката повторно опубликовать точный предыдущий ruleset. Не удалять данные/IndexedDB и не менять production.

SHA-256 подготовленного кандидата: `c0323524eb2245dcba0fdbaaf03a10cd8430281a9ff20cf890b38336785b701e`.

## Прочитанная серверная база

Firebase Console открылась с действующим сохранённым входом Google. ID выбранного проекта подтверждён URL: `samosval-offline`, database `(default)`. CLI 15.34.1 установлена, её отдельный вход не завершён; сохранённый браузерный вход и CLI не отождествляются. Плагин Firebase не установлен.

Опубликованный ruleset отличается от репозитория: другой owner UID, добавлены coinTransactions/validCoinAdjustment, прежних ledger-правил на сервере нет. Резервная копия — `firestore.live-before-20261027.rules`. Новый кандидат строится поверх неё: `firestore.live-integrated.rules`, diff — `firebase-live-integration.patch`, контрольные суммы/статус — `firebase-live-deployment.json`. Весь префикс до рабочего collection fallback и суффикс от match trucks сохранены побайтно, включая владельца и монеты. В общем fallback добавлены только исключения коллекций табеля; запрет обхода coinTransactions сохранён.

На этой фактической базе повторены оба эмуляторных набора (табель и legacy), все завершились успешно. Перед публикацией в Console дополнительно проверить сохранность монет и отсутствие смены server revision.
