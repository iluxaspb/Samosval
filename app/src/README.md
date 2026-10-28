# Рабочие исходники

Основное ядро находится в core/, модули — features/, исходные патчи — patches/. app/modules.json задаёт порядок классических скриптов. Табель: app/tabel-v2.

Сборка: python3 tools/build-release.py --build. Проверка без записи: python3 tools/build-release.py --check. Сгенерированные index.html, sw.js и app/build вручную не редактировать.

Перенос 3.4.48 описан в docs/production-promotion-3.4.48.md.
