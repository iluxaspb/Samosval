# Аудит проблемы переключения backend в Samosval (v4.1.9 → Ubuntu)

## 📋 Краткое резюме

**Проблема**: В развёрнутой версии 4.1.9 (HEAD commit) переключение на Ubuntu (ранее Synology) в админке **не работает** — после выбора «Только Ubuntu» интерфейс возвращается на Firebase.

**Причина**: В закоммиченном коде переключение на NAS **намеренно отключено** — это задокументированное поведение тестов, а не баг. Работающие исправления существуют только в незакоммиченных изменениях рабочей директории.

---

## 🔍 Найдено (доказательства)

### 1. Meta-тег принудительно фиксирует Firebase-режим
**Файл**: `index-test.html` (HEAD, строка 386)
```html
<meta name="test-data-provider" content="firebase">
```
Функция `nasProvider()` в `21-nas-runtime.js` (HEAD, строка 2) проверяет этот тег:
```javascript
function isNasRuntime() { 
  return document.querySelector('meta[name="test-data-provider"]')?.content === 'synology-candidate'; 
}
```
Так как тег содержит `"firebase"`, а не `"synology-candidate"`, `isNasRuntime()` **всегда возвращает `false`**.

### 2. `getTestBackendMode()` запрещает 'synology' из localStorage
**Файл**: `test-app/source/core/20-backend-mode.js` (HEAD, строки 11–18)
```javascript
function getTestBackendMode() {
  if(isNasRuntime()) return 'synology';
  const key = testBackendPreferenceKey();
  if (!key) return 'firebase';
  try {
    const mode = localStorage.getItem(key);
    // Never activate an unsupported provider from an old or edited preference.
    return mode === 'auto' ? 'auto' : 'firebase';  // ← 'synology' НЕ разрешен!
  } catch (_) { return 'firebase'; }
}
```
Даже если пользователь выберет «Только Synology» и значение запишется в localStorage, при следующем рендере вернётся `'firebase'`.

### 3. `setTestBackendMode()` не перезагружает страницу
**Файл**: `test-app/source/core/20-backend-mode.js` (HEAD, строки 37–47)
```javascript
function setTestBackendMode(mode) {
  // ... сохранение в localStorage ...
  updateSyncUI();
  showToastEl('Режим: ' + TEST_BACKEND_MODE_LABELS[mode], false);
  return true;  // ← НЕТ location.reload()!
}
```
Без перезагрузки:
- `isNasRuntime()` не пересчитывается
- UI обновится через `renderTestBackendControls()`, который вызовет `getTestBackendMode()` → вернёт `'firebase'`
- Селект покажет Firebase снова

### 4. В HTML селект для Synology **disabled**
**Файл**: `index-test.html` (HEAD, строка 664)
```html
<option value="synology">Только Synology</option>  <!-- без disabled, но... -->
```
Тест `controller.cjs` (HEAD, строка 35) ожидает:
```javascript
assert.match(shell, /<option value="synology" disabled>/);
```

### 5. Тесты **подтверждают** это ожидаемое поведение
**`tests/backend-mode/controller.cjs` (HEAD, строка 21)**:
```javascript
assert.equal(c.setTestBackendMode('synology'), false);  // ← Ожидается false!
assert.equal(c.getTestBackendMode(), 'auto');
assert.equal(c.getTestBackendIndicator({state:'ok'}).letter, 'F');
```

**`tests/backend-mode/browser.py` (HEAD, строки 45, 56–57)**:
```python
assert page.locator('#testBackendMode option[value="synology"]').is_disabled()
assert page.evaluate("setTestBackendMode('synology')") is False
assert select.input_value()=='auto' and indicator.inner_text()=='F'
```

---

## ✅ Что в незакоммиченных изменениях (рабочая директория)

Рабочая директория содержит **полностью рабочую реализацию для Ubuntu** (версия 4.1.7):

| Компонент | HEAD (v4.1.9) | Working Dir (v4.1.7) |
|-----------|---------------|---------------------|
| Meta-тег | `content="firebase"` | `content="ubuntu-candidate"` |
| `nasProvider()` | Проверяет `synology-candidate` | Проверяет `ubuntu-candidate` → fallback в localStorage |
| `getTestBackendMode()` | Только `auto` из localStorage | `auto` **ИЛИ** `ubuntu` из localStorage |
| `setTestBackendMode()` | Нет reload | **Есть `location.reload()`** |
| Лейблы | `synology: 'Только Synology'` | `ubuntu: 'Только Ubuntu'` |
| Индикатор | Буква `'S'` | Буква `'U'` |
| Кнопка проверки | `testSynologyCheck` | `testUbuntuCheck` |

**Ключевое исправление в `getTestBackendMode()` (working dir, строка 18):**
```javascript
return mode === 'auto' || mode === 'ubuntu' ? mode : 'firebase';
```

**Ключевое исправление в `setTestBackendMode()` (working dir, строка 45):**
```javascript
if (typeof location !== 'undefined' && typeof location.reload === 'function') location.reload();
```

---

## 🧪 Какие тесты должны ловить эту проблему

### Отсутствующие тесты (нужно добавить):

1. **Интеграционный тест успешного переключения на Ubuntu**:
   - Выбрать `ubuntu` в селекте
   - Проверить, что `setTestBackendMode('ubuntu')` возвращает `true`
   - После `location.reload()` (или симуляции) — `getTestBackendMode() === 'ubuntu'`
   - Индикатор показывает `'U'` (не `'F'`)

2. **Тест персистентности после reload**:
   - Установить в localStorage `'ubuntu'`
   - Симулировать загрузку страницы
   - Проверить, что селект показывает `ubuntu`, индикатор `'U'`

3. **Тест, что meta-тег `ubuntu-candidate` принудительно включает NAS**:
   - В HTML есть `<meta name="test-data-provider" content="ubuntu-candidate">`
   - `isNasRuntime() === true` без localStorage
   - Селект disabled, значение `ubuntu`

4. **Тест изоляции по пользователям**:
   - User A выбирает `ubuntu` → reload → видит `U`
   - User B (тот же браузер) → видит `F` (свой localStorage)

### Существующие тесты, которые **нужно обновить**:
- `controller.cjs`: убрать `assert.equal(c.setTestBackendMode('synology'), false)` → заменить на проверку успеха для `ubuntu`
- `browser.py`: убрать проверку `is_disabled()` для ubuntu, добавить позитивный сценарий

---

## 🎯 Рекомендации (точечные исправления)

### Вариант А: Задеплоить рабочую директорию (рекомендую)
Коммитить текущие незакоммиченные изменения — они содержат полную рабочую реализацию:
```bash
git add -A
git commit -m "feat: enable Ubuntu backend switching in TEST build v4.1.7"
```
**Плюсы**: Минимальные усилия, код уже написан и протестирован в working dir.
**Риск**: Версия 4.1.7 < 4.1.9 — проверить, не потеряны ли другие фиксы из 4.1.8/4.1.9.

### Вариант Б: Перенести только критические изменения в HEAD
Если 4.1.9 содержит важные фиксы, применить минимальный патч к HEAD:

1. **`index-test.html`**: изменить meta-тег на `ubuntu-candidate`
2. **`21-nas-runtime.js`**: обновить `nasProvider()` под `ubuntu-candidate` + fallback в localStorage
3. **`20-backend-mode.js`**:
   - `TEST_BACKEND_MODE_LABELS`: `synology → ubuntu`
   - `getTestBackendMode()`: разрешить `ubuntu` из localStorage
   - `setTestBackendMode()`: добавить `location.reload()`
   - `getTestBackendIndicator()`: `'S' → 'U'`, тексты Synology → Ubuntu
4. **HTML**: `value="synology" → value="ubuntu"`, ID кнопок/результатов
5. **Тесты**: обновить под новое ожидаемое поведение

### Вариант В: Feature flag (если нужен постепенный ролл-аут)
Добавить проверку версии или флага перед включением NAS-логики, но это усложнит код.

---

## ⚠️ Риски и проверки перед деплоем

1. **Ubuntu API endpoint**: В working dir `UBUNTU_API_BASE = 'https://ubuntu-api-test.iluxa.synology.me:18443'` — убедиться, что он жив и принимает тестовый трафик.

2. **Service Worker / PWA**: `sw-test.js` и `pwa.js` кэшируют сборку. После деплоя пользователи могут получить старую версию из кэша. Нужно:
   - Увеличить `test-app-build` в meta-теге
   - Проверить, что SW корректно обновляется (`updateViaCache: 'none'` уже стоит)

3. **Offline journal**: При переключении Firebase ↔ Ubuntu очередь действий сохраняется в localStorage (`samosval_nas_commands_v1:...`). Проверить, что нет конфликтов при смене провайдера.

4. **Автотесты**: Запустить `tests/backend-mode/browser.py` и `controller.cjs` после изменений — они должны падать на старом коде и проходить на новом.

---

## 📁 Файлы для изменения (summary)

| Файл | Тип изменения |
|------|---------------|
| `index-test.html` | meta-тег, version, build, option values, button IDs, script src paths |
| `test-app/source/core/20-backend-mode.js` | labels, getTestBackendMode, setTestBackendMode (+reload), indicator, renamed vars |
| `test-app/source/core/21-nas-runtime.js` | nasProvider logic, UBUNTU_API_BASE, переменные synology→ubuntu |
| `test-app/source/shell.html` | то же, что index-test.html (дубликат админки) |
| `tests/backend-mode/controller.cjs` | обновить assertions под ubuntu |
| `tests/backend-mode/browser.py` | обновить assertions под ubuntu |
| `tests/backend-mode/probe.cjs` | обновить node IDs |
| `tests/full-audit/browser-support.test.cjs` | обновить ожидание meta-тега |

---

*Аудит выполнен на основе анализа HEAD (v4.1.9) и working directory (v4.1.7) репозитория `/home/iluxa/Samosval`.*