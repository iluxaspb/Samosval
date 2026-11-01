# ЭТАЛОННАЯ ВЕРСИЯ 4.1.6 (ТОЧКА ОТСЧЁТА И БЕЗОПАСНЫЙ ОТКАТ БЕЗ ИИ)

**Дата фиксации:** 01.11.2026  
**Коммит в Git:** `8807686d0d9a0de5baabc54e0af2ef363f7f875e`  
**Git Tag:** `v4.1.6-test-baseline`  
**Git Ветка:** `backup/test-4.1.6-baseline`  
**Сборка:** `5c8912764a49969d` (канал `test-4.1.6-modular-plus-timesheet`)

В этом каталоге сохранены исходные артефакты релиза 4.1.6 (без ИИ-помощника, без DWG и без дополнительных экспериментальных модулей):
- `index-test.html`
- `sw-test.js`
- `build-manifest.json`

## Быстрый откат на версию 4.1.6:

### Вариант 1 (через Git):
```bash
git checkout backup/test-4.1.6-baseline -- index-test.html sw-test.js test-app/build-manifest.json test-app/source/
python3 tools/build-test.py
git commit -m "revert(test): откат к проверенной версии 4.1.6"
git push origin root
```

### Вариант 2 (восстановление сохранённых файлов):
```bash
cp releases/4.1.6-baseline/index-test.html ./index-test.html
cp releases/4.1.6-baseline/sw-test.js ./sw-test.js
cp releases/4.1.6-baseline/build-manifest.json ./test-app/build-manifest.json
git commit -m "revert(test): прямое восстановление файлов 4.1.6"
git push origin root
```
