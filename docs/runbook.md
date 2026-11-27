# Runbook «Учёт самосвалов» — пути, команды, проверки, откат

Актуализация: 22.11.2026. Все команды выполнять от пользователя iluxa; sudo — только для docker и чтения служебных путей. Рабочая копия для разработки: `/home/iluxa/Samosval-repo-main` (ветка root). РАБОЧИЕ каталоги продакшна и их БД — только чтение.

## Окружение

- Репозиторий: github.com/iluxaspb/Samosval. Приложения: GitHub Pages (рабочее — корень, тестовое — ветка wtest-канала, адреса в `docs/project-context.md`).
- API РАБОЧЕЙ версии (с 27.11.2026): `https://api-samosval.iluxa.pro` (Caddy, TLS) → `127.0.0.1:18092` (контейнер `samosval-api-prod`) → база `samosval_working_test_reserve`.
- API ТЕСТОВОГО канала: `https://samosval-test.iluxa.pro` (Caddy, TLS) → `127.0.0.1:18091` (контейнер `samosval-api-working-test`) → база `samosval_test_clean` (пустая, без данных).
- Базы живут в контейнере `samosval-postgres-ubuntu` (порт наружу не публикуется). Тестовый API-кандидат: `127.0.0.1:18090` (`samosval-api-ubuntu-test`).
- Секреты: `/home/iluxa/samosval-secrets` (монтируется в контейнер как /secrets; не публиковать, не логировать).

## Диагностика (быстрые проверки)

```
sudo docker ps --format '{{.Names}}\t{{.Status}}' | grep samosval
curl -s https://api-samosval.iluxa.pro/health/live              # живой API рабочей версии
curl -s https://api-samosval.iluxa.pro/health/ready             # рабочая база подключена
curl -s https://samosval-test.iluxa.pro/health/live             # живой API тестового канала
curl -s https://samosval-test.iluxa.pro/health/ready            # тестовая база подключена
curl -s 'https://iluxaspb.github.io/Samosval/?cb='$RANDOM  # рабочая страница отдаётся
curl -s -o /dev/null -w '%{http_code}\n' https://api-samosval.iluxa.pro/api/v1/line/snapshot  # 401 без токена = норма
sudo docker logs --tail 50 samosval-api-prod
sudo docker logs --tail 50 samosval-api-working-test
sudo docker inspect samosval-api-prod --format '{{.HostConfig.RestartPolicy.Name}}'  # должно быть unless-stopped
sudo docker inspect samosval-api-working-test --format '{{.HostConfig.RestartPolicy.Name}}'  # должно быть unless-stopped
```

**После перезагрузки сервера** первым делом проверять, что `samosval-api-working-test` в состоянии `Up`: 27.11.2026 он остался в `Exited` (была политика `no`), и рабочая версия писала «нет связи с сервером» при живых базе и Caddy. Подъём — `sudo docker start samosval-api-working-test` (см. `docs/opyt-oshibok.md`, п.15).

**Сторож API** (поставлен 27.11.2026, расширен на рабочую версию): `systemctl status samosval-api-watchdog.timer` — должен быть `active (waiting)`, следующий запуск раз в минуту. Лог действий: `sudo tail -20 /var/log/samosval-api-watchdog.log`. Сторож сам поднимает `samosval-postgres-ubuntu`, оба API (`samosval-api-prod` и `samosval-api-working-test`), держит политику `unless-stopped` и перезапускает API, если `health/ready` не 200 (рабочая версия проверяется первой). Отключить при необходимости: `sudo systemctl disable --now samosval-api-watchdog.timer`. Исходники сторожа в репозитории — `tools/systemd/`; установка: `sudo install -m 0755 tools/systemd/samosval-api-watchdog.sh /usr/local/bin/`, юниты — в `/etc/systemd/system/`, затем `sudo systemctl daemon-reload && sudo systemctl enable --now samosval-api-watchdog.timer`.

## Тесты

- Юнит/доменные (сервер): `cd /home/iluxa/Samosval-repo-main/server && npm test` (или `node --test tests/`); CI GitHub Actions гоняет их с изолированной PostgreSQL.
- Табель: `node --test tests/tabel-v2/*.test.mjs` (из корня репозитория; модули табеля — `working-test/tabel-v2/`, для проверок отозванной модульной линии — `app/`).
- Браузерные (Chromium, мобильный вид 393×852): `tests/tabel-v2/*browser*`, `tests/tabel-v2/active-address-browser.py` (наборы pwa/backend-mode/full-audit удалены 22.11.2026 вместе с мёртвым каналом test-app).
- Изолированная БД для прогонов: поднимайте отдельный контейнер PostgreSQL из `server/compose.test.yaml`; никогда не гонять тесты на рабочей базе.

## Сборка

- Тестовая: `python3 tools/build-working-test.py` → комплект канала working-test (`index-working-test.html`, `sw-working-test.js`, `working-test/build-manifest.json`); публикация — на отдельном Pages-сайте `https://iluxaspb.github.io/samosval-working-test/`.
- Рабочая: пересборка комплекта `working-test` с production-обвязкой (manifest-production, синие иконки, `index.html`) одним коммитом в `root`. Эталоны выпуска: `7ca5007` (1.7.19), `d01de1a` (1.7.22). `tools/build-release.py` и `app/src` — отозванная модульная линия, автоматически не публиковать.
- Перед сборкой тестовой линии — проверка единой версии: `working-test/source/shell.html` (meta + шапка «Линия»), `working-test/source/features/working-test-release.js`, первая запись `release-history.js`, собранные артефакты и build-manifest. Рассинхрон блокирует выпуск.

## Публикация (только по протоколу AGENTS.md)

1. Все проверки зелёные (юнит, браузерные, Actions, консоль без pageerror, открыта именно собранная версия).
2. Подтверждение владельца: тестовая линия (working-test) — «да» НЕ требуется, публикуем сразу (решение от 23.11.2026); рабочая (production) — обязательное ручное «да» каждый раз.
3. Один коммит: HTML, SW, манифест, файлы новой сборки; файлы предыдущей сборки сохранить.
4. Проверка live: curl с cache-buster на `index-test.html`, `build-manifest.json`, `sw-test.js` — совпадение версии/build hash. «Опубликовано» = Pages реально отдаёт новое.
5. Рабочую версию не публиковать без отдельного поручения; force-push запрещён.

## Управление контейнерами (осторожно)

```
sudo docker restart samosval-api-working-test     # рестарт API (краткий простой обеих версий)
sudo docker logs -f samosval-api-working-test
```
Пересборка/замена образов API — только по отдельному заданию с бэкапом БД (см. история миграций в docs/synology-*.md: перед каждой установкой — pg_dump + копия исходников, SHA256 фиксируется).

## Откат

- Рабочая страница: восстановить `index.html` из предыдущего прод-коммита ветки `root` (эталоны: `d01de1a` — 1.7.22); ветку root не сбрасывать, force-push запрещён. Резервная ветка `backup/production-before-rewards-20261026` сохранена.
- Тестовая страница: откатный коммит с предыдущей согласованной сборкой (файлы старых сборок `working-test/build/*` сохраняются при выпуске и удалению не подлежат — на них могут стоять открытые окна пользователей).
- API: вернуть прежний compose/образ (резервные compose-файлы лежат в `server/compose.*.yaml`); базу — `pg_restore` из дампа (дампы и SHA256 перечислены в `docs/synology-v4-test-status.md`).
- Резервная копия перед любой правкой рабочей линии обязательна.

## Чего не делать

- Не менять бизнес-логику линии, разводку PWA, рабочий API и базу без отдельного поручения владельца.
- Не публиковать серверные исходники/секреты/данные в открытом репозитории.
- Не возвращать Firebase как основное хранилище; не считать «готово» без проверки фактической отдачи GitHub Pages.
