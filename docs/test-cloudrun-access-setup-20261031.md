# Реальный Cloud Run TEST: одноразовое подключение Google Cloud к GitHub

**Статус на 31.10.2026:** GitHub Actions в ветке
`feature/test-replication-20261030` попытался развернуть сервис.
[Запуск 41132455549](https://github.com/iluxaspb/Samosval/actions/runs/41132455549)
остановился на предварительной проверке: отсутствуют три переменные
`TEST_GCP_WIF_PROVIDER`, `TEST_GCP_DEPLOY_SA`,
`TEST_GCP_RUNTIME_SA`. В Google Cloud **ничего не развёрнуто**.
Реальный HTTPS endpoint и два Firebase Auth токена пока не проверены.

## Для чего нужны три переменные

Процесс не принимает JSON-ключи и пароли от пользователя: GitHub
выдаёт краткоживущий OIDC-токен, который Google разрешает обменять
на права отдельной учётной записи **только** для репозитория
`iluxaspb/Samosval` и ветки `feature/test-replication-20261030`.
Резерв разворачивается строго в Google Cloud project **`samosval-offline`**.
Сервис на Cloud Run запускается от другой, минимально привилегированной
учётной записи. Рабочий сервер Synology и production не участвуют.

Один раз в Google Cloud Console убедиться, что для проекта
`samosval-offline` включён billing и API Cloud Run, Cloud Build,
Artifact Registry, IAM Credentials, Security Token Service и Firestore.
Если Firestore/Billing не включены, не менять рабочий проект — только TEST.

В Google Cloud создать две служебные учётные записи:

- `samosval-test-deployer@samosval-offline.iam.gserviceaccount.com`
  — только развёртывание Cloud Run из GitHub.
- `samosval-test-reserve@samosval-offline.iam.gserviceaccount.com`
  — исполнитель сервиса. Дать ему `roles/datastore.user` только
  в отдельном тестовом проекте; не предоставлять Owner/Editor.
  Firestore IAM является полномочием сервера и **не зависит** от
  браузерных Firestore Rules.

Выдать развёртывающей учётной записи права Cloud Run Admin,
Cloud Run Source Developer и Service Usage Consumer в TEST проекте,
а также Service Account User **только** на
`samosval-test-reserve`. Cloud Build нужно дать роль Cloud Run Builder
на фактически используемой им build-учётной записи (в документации
Google используется Compute Engine default service account). Эти права
не нужны runtime-сервису. Не создавать постоянные приватные ключи.

Создать Workload Identity Pool `samosval-gh-pool` и OIDC provider
`github` с issuer `https://token.actions.githubusercontent.com`,
mapping `google.subject=assertion.sub`,
`attribute.repository=assertion.repository`,
`attribute.ref=assertion.ref`, и условием:

```text
assertion.repository == 'iluxaspb/Samosval' &&
assertion.ref == 'refs/heads/feature/test-replication-20261030'
```

Для `samosval-test-deployer` добавить `roles/iam.workloadIdentityUser`
для principalSet данного pool со значением
`attribute.repository/iluxaspb/Samosval`. Не разрешать произвольные
репозитории и ветки.

## GitHub: ровно три переменные, без ключей

Открыть [Settings → Secrets and variables → Actions → Variables](https://github.com/iluxaspb/Samosval/settings/variables/actions).
Создать **Repository variables**:

| Имя | Значение |
| --- | --- |
| `TEST_GCP_WIF_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/samosval-gh-pool/providers/github` (подставить **числовой** Project Number из Google Cloud) |
| `TEST_GCP_DEPLOY_SA` | `samosval-test-deployer@samosval-offline.iam.gserviceaccount.com` |
| `TEST_GCP_RUNTIME_SA` | `samosval-test-reserve@samosval-offline.iam.gserviceaccount.com` |

Опционально `TEST_GCP_REGION=europe-north1`; этот регион уже задан
по умолчанию. Используются только разрешённые европейские TEST-регионы.

После настройки запустить
[Deploy independent TEST Firebase reserve (Cloud Run)](https://github.com/iluxaspb/Samosval/actions/workflows/deploy-test-firebase-reserve.yml)
через **Run workflow**, выбрав ветку `feature/test-replication-20261030`.
Если кнопка доступна только для workflow в default branch, потребуется
перевести отдельный manual-dispatch workflow в доступную ветку либо
добавить коммит в исходную TEST ветку — без слияния в production.

## Что именно делает workflow

1. Жёстко проверяет имя репозитория и TEST ветку, email обеих
   Google Cloud service accounts и формат OIDC provider; при ошибке
   завершается **до** Cloud Run.
2. Проверяет резервы и собирает независимый
   `server/Dockerfile.reserve`, а не NAS API.
3. По GitHub OIDC разворачивает `samosval-test-reserve` через
   Cloud Run Source Deploy только в `samosval-offline`,
   `min-instances=0`, `max-instances=2`, 512 МБ RAM.
4. Устанавливает `FIREBASE_PROJECT_ID=samosval-offline`,
   `TEST_RESERVE_SERVE_ENABLED=1`, не затрагивает Synology.
   Публичный Cloud Run HTTPS принимает запросы, но сервер
   проверяет Firebase Auth токен перед каждым бизнес-ответом.
5. Проверяет реальный URL: `/health/live` должен вернуть
   projectId `samosval-offline` и режим `line-test-only`;
   отсутствие токена/поддельный токен → HTTP 401;
   попытка записи с поддельным токеном → 401;
   чужой Origin → 403; разрешённый CORS preflight → 204.
   Проверка **не отправляет** настоящие бизнес-операции.

**Не выполняет:** автоматическое повышение Firebase до единственного
владельца записи, включение `readyForFailover`, миграцию тестовой БД,
изменение Firebase Rules, отключение NAS или обновление PWA телефона.
Настоящий live-тест с двумя пользователями и обратной синхронизацией
будет отдельным этапом после появления Cloud Run URL.
