# Актуальная разработка тестовой версии

Исходники текущего приложения находятся в **[source/](source/README.md)**.
Основа — опубликованная 3.4.11; механическое разделение — 3.4.12.

```sh
python3 tools/build-test.py
python3 tools/verify-test-modules.py
```

Команды выполняются из корня репозитория. `index-test.html`, `sw-test.js`,
`build-manifest.json` и `build/<hash>/` — результаты сборки. Рабочий `index.html`
не участвует в этой сборке.

Каталог `src/` содержит прежние исходники и три активных подключения:
`pwa.js`, `features/timesheet-core.js`, `features/timesheet-app.js`
и `styles/timesheet-css.css`. Прочие старые файлы `src/` не являются основой
текущего приложения. Начинайте изменения с `source/README.md` и `modules.json`.
