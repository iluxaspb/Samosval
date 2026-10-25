# Локальные зависимости тестовой страницы

Те же версии, которые подключались исходной страницей с CDN. Локальные копии нужны для холодного запуска без сети; обновления библиотек в эту переработку не включены.

- Firebase JavaScript SDK 10.8.0 (app/auth/firestore/storage compat), лицензия Apache-2.0, заголовки сохранены. https://github.com/firebase/firebase-js-sdk/blob/main/LICENSE
- html2pdf.js 0.10.1, MIT, исходный bundle с уведомлениями зависимостей. https://github.com/eKoopmans/html2pdf.js/blob/v0.10.1/LICENSE
- Caveat, SIL Open Font License; полный текст в `Caveat-OFL.txt`.

`sources.json` содержит точные URL, размеры и SHA-256 скачанных файлов. Не менять содержимое библиотек вручную. Манифест сборки дополнительно фиксирует хеш каждого файла, используемого PWA.
