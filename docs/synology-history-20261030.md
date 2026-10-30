# TEST Synology: отмена, восстановление и архив — 30.10.2026

Проверенный код: e8fe4c36455b6a0d7b7a8f444eafe3478725a63f, PR54.

GitHub Actions 41013664493 / job 123924973419 применил SQL001–007 в отдельном PostgreSQL 16 и выполнил 131 тест: 131 pass, 0 fail, 0 skipped. Все 11 ранее пропущенных PostgreSQL-групп выполнены, включая вложенные сценарии.

На NAS установлен samosval-test-api:history-v1-20261030, image eb3cb9a60aec. Файлы пакета проверены SHA256 до сборки; SQL007 применён успешно. Обновлён только samosval-test-candidate-api-1. Запуск выполнен штатной задачей DSM после защищённого подтверждения пароля; существующая отключённая задача identity переименована в Samosval TEST history deploy 20261030, её команда заменена. Автоматическое расписание не включалось.

Перед миграцией сохранены и прочитаны pg_restore --list / tar -tzf:
- /volume2/docker/samosval-test/migration-backups/history-20261030/before.dump
- source.tar.gz, compose.yaml и SHA256SUMS в том же каталоге.

Журнал deploy.log завершился HISTORY_API_VERIFIED. До/после: 4 пользователя, 23 машины, 11 статусов, 28 рейсов, 47 записей табеля, 3 объекта. Health вернул ready/connected. History, archive/snapshot, session, line/snapshot без токена вернули 401. После установки внешние HTTPS /health/ready и /api/v1/history повторно вернули ready/connected и unauthorized.

Сборка использует отдельный staging-каталог /volume2/docker/samosval-test/history-deploy. Основные исходники /src не перезаписывались; будущая пересборка из них не воспроизводит history-образ. Следующий этап обязан либо синхронизировать проверенные исходники, либо собирать из этого staging/нового релиза. Повторный запуск deploy-history.sh защищён существующим каталогом резервирования и не допускается.

Откат API: вернуть сохранённый compose.yaml в /volume2/docker/samosval-test-candidate/compose.yaml и выполнить compose up -d --no-deps --no-build api для того же проекта. SQL007 аддитивен; таблицы при откате не удалять. Скрипт автоматически возвращает старый compose при ошибке перезапуска, health, количества записей или защиты endpoint.

Это установка серверного блока, а не полный релиз. Авторизованный пользовательский цикл новых endpoint и подключение основных экранов ещё не проверены. Интерфейс TEST остаётся на Firebase. Production, Firebase Rules и фото не менялись.
