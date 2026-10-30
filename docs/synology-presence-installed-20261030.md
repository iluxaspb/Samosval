# Проверенная установка TEST presence — 30.10.2026

Код API и клиента: a213cc98273695fe8d8d4e3e598d5d7cf6fcbe1c, PR58. CI 41018354200 / job 123939709194: 189 серверных/интеграционных тестов pass, 0 fail/skipped; отдельно 97 tests/tabel-v2 pass, 0 fail/skipped. SQL001–007, PostgreSQL 16. Модульный аудит прошёл, production untouched. PostgreSQL-проверка presence подтвердила grant конкретного листа и удаление отозванного участника.

На NAS установлен samosval-test-api:presence-v1-20261030, image e5489ca831e6. Пакет SHA256 проверен до сборки. Обновлён только samosval-test-candidate-api-1, без SQL-миграции. Штатная отключённая задача DSM Samosval TEST presence deploy 20261030 сохранена после защищённого подтверждения пароля и вручную запущена.

Перед заменой в /volume2/docker/samosval-test/migration-backups/presence-20261030 сохранены before.dump (прочитан pg_restore --list), архив source.tar.gz (прочитан tar -tzf), compose.yaml и SHA256SUMS. Архив содержит реальные running-src и running-package.json, скопированные из работавшего history API, а не устаревший host /src. Секреты и дамп в GitHub не передавались.

Журнал deploy.log завершился PRESENCE_API_VERIFIED. Health: ready/connected. Presence, history, archive, session и line без токена вернули 401. Количества до/после совпали: 4 пользователя / 23 машины / 11 статусов / 28 рейсов / 47 записей табеля / 3 объекта. Внешний HTTPS /api/v1/tabel/presence также вернул unauthorized, затем /health/ready проверен отдельно.

После запуска File Station сохранён и повторно скачан compose.yaml: размер 868 байт, побайтово совпал с подготовленной конфигурацией. Изменён только build.context: ../samosval-test/presence-deploy. Image presence-v1, env_file, сеть, порты, PostgreSQL-том и текущий процесс не менялись этой корректировкой. Это устраняет прежнюю проблему пересборки из старого host /src. Точная конфигурация: server/compose.presence.yaml.

Исполненный скрипт сохранён в server/scripts/deploy-presence-20261030.sh. Он намеренно не повторяется: существующая папка резервирования блокирует повтор. Изменение context выполнено после скрипта отдельной загрузкой конфигурации. Откат: вернуть сохранённый compose из каталога резервирования и выполнить up -d --no-deps --no-build api для проекта samosval-test-candidate. Данные и таблицы не удалять; старый history-v1 образ сохранён.

Ограничения: это подтверждение серверной установки и проверок кода, а не полного браузерного релиза. Основная TEST-страница остаётся Firebase, NAS-маркер не опубликован. Совместный пользовательский цикл двух окон ещё не выполнен. Остальные условия полного 4.0 перечислены в предыдущих документах; фото исключены.