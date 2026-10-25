# Проверки модульной тестовой страницы

Быстрые проверки не требуют npm:

```sh
python3 tools/build-test.py
node tests/pwa/modules.cjs
node tests/pwa/service-worker.cjs
node tests/pwa/run-regressions.cjs
```

Для сравнения переноса `modules.cjs` читает исходный коммит из Git. Если он отсутствует в shallow clone, загрузите его либо задайте `BASELINE_HTML` с исходной версией этого коммита. Не подменять baseline собранной страницей.

Настоящий браузер и локальная база:

```sh
cd tests/pwa
npm install
npx playwright install chromium
cd ../..
NODE_PATH=./tests/pwa/node_modules FIRESTORE_EMULATOR_JAR=/absolute/path/cloud-firestore-emulator.jar node tests/pwa/browser.cjs
```

Нужны Java и Firestore Emulator JAR из официального Firebase Emulator Suite. Переменная `PWA_BROWSER` необязательна: позволяет выбрать уже установленный Chromium. Эмулятор запускается дочерним процессом и завершается после теста. Локальные порты настраиваются через `PWA_FIRESTORE_PORT` (8097 по умолчанию); HTTP-сервер выбирает свободный порт.

Тест использует настоящий Firebase SDK, IndexedDB и транзакции под `firestore-v3.rules`, но фиксированную тестовую личность вместо реального входа. Внешние HTTP-запросы браузера блокируются; Firebase перенаправляется исключительно на localhost. Проверяются устанавливаемый манифест, холодный запуск без сети, сохранение действий после закрытия браузера, повторная отправка, отдельный кэш, ожидание обновления и экспорт одного HTML-файла. Скриншоты сохраняются во временном каталоге, указанном в выводе.
