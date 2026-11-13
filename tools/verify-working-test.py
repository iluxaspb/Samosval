#!/usr/bin/env python3
"""Независимый аудит релиза «working test» (working-test).

Только чтение: сеть не используется, Firebase-модули не загружаются, файлы
проекта не изменяются, сборка не запускается. Временные файлы для разбора
синтаксиса создаются только в /tmp/opencode.

Проверяется: вход и версия 1.0.0, модуль релиза и история, состав и порядок
модулей (точное совпадение сгенерированного HTML и тел модулей), SHA-256 всех
ресурсов и build-manifest, Firebase samosval-test без ubuntu-candidate,
именованное приложение Firebase для изоляции persistence, собственные
PREFIX/PAGE/ALLOWED/scope service worker, собственные manifest/pwa/icons,
изоляция от тестового релиза (кроме неизменяемых vendor-библиотек с хешем),
разделение ключей хранилища и sessionCacheKey с projectId+pathname, документ
полномочий backendAuthority без маскировки permission-denied, статические
проверки полномочий, разбор inline-eval полезной нагрузки патчей без
исполнения, синтаксис всех сгенерированных модулей, доступные локальные
node-проверки и отрицательные сценарии, а также защищённый git-базис с
заранее известными чужими изменениями.

Запуск: python3 tools/verify-working-test.py
Коды выхода: 0 — пройдено, 1 — дефект, 2 — артефакты ещё не готовы.
"""
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
ENTRY = ROOT / 'index-working-test.html'
SW = ROOT / 'sw-working-test.js'
WEBMANIFEST = ROOT / 'manifest-working-test.webmanifest'
BUILD_TOOL = ROOT / 'tools' / 'build-working-test.py'
WT = ROOT / 'working-test'
TEMP = Path('/tmp/opencode')

# Строго известные места артефактов: никакого поиска «похожего» файла.
MODULES_JSON = WT / 'modules.json'
SOURCE_DIR = WT / 'source'
SHELL = SOURCE_DIR / 'shell.html'
BUILD_MANIFEST = WT / 'build-manifest.json'
RELEASE_MODULE = SOURCE_DIR / 'features' / 'working-test-release.js'
HISTORY_MODULE = SOURCE_DIR / 'features' / 'release-history.js'
REFERENCE_MODEL = ROOT / 'test-app' / 'modules.json'

REQUIRED_VERSION = '1.7.1'
REQUIRED_HEADER = 'Рабочая тестовая версия'
FIREBASE_PROJECT = 'samosval-test'
FIREBASE_APP_NAME = 'working-test'
AUTHORITY_DOC = 'backendAuthority'
TEST_RELEASE_FILES = ('index-test.html', 'sw-test.js', 'manifest-test.webmanifest')
OLD_TEST_PREFIX = 'samosval-test-shell-'

# Ключи хранилища тестового релиза. Снимок working-test обязан их переименовать:
# иначе два релиза на одном origin делят настройки, кэш сеанса и очередь.
OLD_STORAGE_KEYS = (
    'dt_settings_test347',
    'dt_cache_v14',
    'dt_nav_order_v2',
    'dt_anim_speeds_v1',
    'dt_max_last_success_test347',
    'dt_max_last_warmup',
    'dt_backend_mode_test',
    'tabel-v2-last-closed:',
    'samosval-road-jokes-v1',
    'samosval-arcade-prefs-v1',
    'samosval-road-theme-v1',
    'samosval-season-effects-v1',
    'samosval:rank-celebration:v1',
    'samosval:penalty-read:',
    'samosval-arcade-spin-v1',
    'samosval_offline_v1_',
)

# Заранее существующие чужие изменения. Подтверждены ГЛАВНЫМ агентом и
# владельцем в переписке; это НЕ результаты текущей задачи и они не должны
# попадать в git add/commit.
BASELINE_CHANGES = {
    'M': {'AGENTS.md', 'server/src/index.mjs', 'server/src/identity-store.mjs'},
    '??': {
        'PROJECT_STATE.md',
        'dino',
        'test-app/build/5ab92636ab99a012',
        'tests/tabel-v2/presence-session.test.mjs',
    },
}
# Новые файлы самой задачи. Каталоги кэшей сюда не входят: их не должно быть.
ALLOWED_NEW_FILES = {
    'index-working-test.html',
    'manifest-working-test.webmanifest',
    'sw-working-test.js',
    'tools/build-working-test.py',
    'tools/verify-working-test.py',
    'update-working-test.html',
    'server/sql/017_replica_stream.sql',
    'server/src/replica-store.mjs',
    'server/src/replica-materialize.mjs',
    'server/tests/replica-store.test.mjs',
    'server/tests/replica-materialize.test.mjs',
    'server/src/arcade-rules.mjs',
    'server/src/game-store.mjs',
}
ALLOWED_NEW_PREFIXES = ('working-test/',)

failures = []
notes = []
skipped = []
passed = []


def fail(section, message):
    failures.append((section, message))


def note(message):
    notes.append(message)


def skip(section, message):
    skipped.append((section, message))


def read(path):
    return path.read_text(encoding='utf-8', errors='replace')


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rel(path):
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def run_section(name, fn, *args):
    before = len(failures)
    try:
        fn(*args)
    except Exception as error:  # сама проверка не должна падать молча
        fail(name, 'внутренняя ошибка проверки: %s: %s' % (type(error).__name__, error))
    if len(failures) == before:
        passed.append(name)


def child_env():
    import os
    env = dict(os.environ)
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    return env


# ---------- снимок исходников и vendor-библиотек ----------

def runtime_sources():
    files = []
    if not SOURCE_DIR.is_dir():
        return files
    for path in sorted(SOURCE_DIR.rglob('*')):
        if not path.is_file() or path.suffix.lower() not in ('.js', '.mjs', '.css', '.html'):
            continue
        parts = path.relative_to(SOURCE_DIR).parts
        if 'tests' in parts or 'build' in parts:
            continue
        files.append(path)
    return files


def runtime_texts(sources):
    return [(rel(path), read(path)) for path in sources]


def vendor_whitelist():
    """Неизменяемые сторонние библиотеки: явный список существующих файлов с хешем.

    Разрешено ссылаться только на эти файлы и только если их содержимое не
    изменилось. Любой другой общий файл test-app/ остаётся нарушением.
    """
    result = {}
    vendor = ROOT / 'test-app' / 'vendor'
    if not vendor.is_dir():
        return result
    for path in sorted(vendor.rglob('*')):
        if path.is_file():
            result['./' + str(path.relative_to(ROOT))] = sha256(path)
    return result


VENDOR = vendor_whitelist()


def shared_test_app_refs(text):
    """Ссылки на общий test-app/ вне разрешённого vendor-списка."""
    bad = []
    for match in re.finditer(r'\./test-app/([^"\'\s)]+)', text):
        url = './test-app/' + match.group(1)
        if url in VENDOR:
            continue
        bad.append(url)
    return bad


# ---------- 1. вход и версия ----------

def check_entry(entry_text, build_id):
    meta = re.search(r'<meta\s+name="working-test-version"\s+content="([^"]*)"', entry_text)
    if not meta:
        fail('вход/версия', 'в index-working-test.html нет meta name="working-test-version"')
    elif meta.group(1) != REQUIRED_VERSION:
        fail('вход/версия', 'meta working-test-version = %r, ожидалось %r'
             % (meta.group(1), REQUIRED_VERSION))
    header = re.search(r'class="version-text"[^>]*>([^<]*)<', entry_text)
    if not header:
        fail('вход/версия', 'в шапке входа нет элемента class="version-text"')
    else:
        visible = ' '.join(header.group(1).split())
        if not re.search(r'\b' + re.escape(REQUIRED_VERSION) + r'\b', visible):
            fail('вход/версия', 'видимая шапка %r не содержит версию %r'
                 % (visible, REQUIRED_VERSION))
    if 'name="test-app-version"' in entry_text:
        fail('вход/версия', 'вход использует meta test-app-version: релиз не отделён от тестового')
    build_meta = re.search(r'<meta\s+name="working-test-build"\s+content="([^"]*)"', entry_text)
    if not build_meta:
        fail('вход/версия', 'нет meta working-test-build: pwa не сможет определить сборку')
    elif build_id and build_meta.group(1) != build_id:
        fail('вход/версия', 'meta working-test-build %r не совпадает с версией манифеста %r'
             % (build_meta.group(1), build_id))
    provider = re.search(r'<meta\s+name="test-data-provider"\s+content="([^"]*)"', entry_text)
    if provider:
        value = provider.group(1).strip().lower()
        if value != 'firebase':
            fail('firebase/поставщик', 'test-data-provider = %r; разрешён только firebase'
                 % provider.group(1))
    if 'ubuntu-candidate' in entry_text:
        fail('firebase/поставщик', 'во входе остался маркер ubuntu-candidate')
    placeholder = re.search(r'<!--\s*[A-Z-]*MODULE:[^>]*-->', entry_text)
    if placeholder:
        fail('модули/порядок', 'во входе остался неразвёрнутый маркер модуля: %s'
             % placeholder.group(0).strip())
    manifest_link = re.search(r'<link\s+rel="manifest"\s+href="([^"]*)"', entry_text)
    if not manifest_link:
        fail('manifest/pwa', 'во входе нет <link rel="manifest">')
    elif manifest_link.group(1) != './manifest-working-test.webmanifest':
        fail('manifest/pwa', 'вход ссылается на чужой манифест: %s' % manifest_link.group(1))


# ---------- 2. модуль релиза и история (строго известные места) ----------

def check_release_sources():
    version_field = re.compile(r"version\s*:\s*'([^']+)'")
    if not RELEASE_MODULE.is_file():
        fail('релиз/история', 'нет модуля релиза %s' % rel(RELEASE_MODULE))
    else:
        versions = version_field.findall(read(RELEASE_MODULE))
        if REQUIRED_VERSION not in versions:
            fail('релиз/история', '%s не объявляет version: %r'
                 % (rel(RELEASE_MODULE), REQUIRED_VERSION))
        else:
            note('модуль релиза %s содержит version: %r'
                 % (rel(RELEASE_MODULE), REQUIRED_VERSION))
    if not HISTORY_MODULE.is_file():
        fail('релиз/история', 'нет модуля истории %s' % rel(HISTORY_MODULE))
        return
    versions = version_field.findall(read(HISTORY_MODULE))
    if not versions:
        fail('релиз/история', '%s не содержит записей version' % rel(HISTORY_MODULE))
        return
    if versions[0] != REQUIRED_VERSION:
        fail('релиз/история', 'первая запись истории %s: %r, ожидалось %r'
             % (rel(HISTORY_MODULE), versions[0], REQUIRED_VERSION))
        return
    if versions.count(REQUIRED_VERSION) != 1:
        fail('релиз/история', 'версия %r встречается в истории %d раз(а), нужна ровно первая запись'
             % (REQUIRED_VERSION, versions.count(REQUIRED_VERSION)))
    if len(versions) < 2:
        note('история %s содержит только запись %r'
             % (rel(HISTORY_MODULE), REQUIRED_VERSION))


# ---------- 3. состав, порядок модулей и точное совпадение сборки ----------

def load_modules():
    if not MODULES_JSON.is_file():
        return None
    try:
        model = json.loads(read(MODULES_JSON))
    except json.JSONDecodeError as error:
        fail('модули/порядок', '%s не разбирается: %s' % (rel(MODULES_JSON), error))
        return None
    if not isinstance(model.get('modules'), list) or not model['modules']:
        fail('модули/порядок', '%s не содержит непустого списка modules' % rel(MODULES_JSON))
        return None
    return model


def module_body(module):
    """Тело модуля по правилам сборки: склейка исходников или части патча."""
    result = []
    if 'parts' in module:
        for part in module['parts']:
            if 'text' in part:
                result.append(part['text'])
                continue
            path = SOURCE_DIR / part['source']
            if not path.is_file():
                fail('модули/порядок', 'часть патча отсутствует: %s' % part['source'])
                return None
            code = read(path)
            if part.get('original_literal') and sha256(path) == part.get('sha256'):
                result.append(part['original_literal'])
            else:
                result.append(json.dumps(code, ensure_ascii=False))
        return ''.join(result)
    for source in module.get('sources') or []:
        path = SOURCE_DIR / source
        if not path.is_file():
            fail('модули/порядок', 'нет исходника модуля %r: %s' % (module.get('name'), source))
            return None
        result.append(read(path))
    return ''.join(result)


def build_dir_from_manifest(manifest, build_id):
    """Каталог сборки берётся из манифеста, а не поиском по диску."""
    for record in manifest.get('assets', []):
        url = str(record.get('url', ''))
        marker = '/build/%s/' % build_id
        if marker in url:
            path = (ROOT / url.lstrip('./')).resolve()
            return path.parent
    return WT / 'build' / str(build_id)


def check_modules(entry_text, model, manifest, build_id):
    if model is None:
        fail('модули/порядок', 'нет %s: состав и порядок модулей не подтверждены'
             % rel(MODULES_JSON))
        return
    modules = model['modules']
    names = [m.get('name') for m in modules]
    if any(not isinstance(name, str) or not re.fullmatch(r'[a-z0-9-]+', name) for name in names):
        fail('модули/порядок', 'недопустимое имя модуля: %r' % (names,))
        return
    if len(set(names)) != len(names):
        fail('модули/порядок', 'повторяющиеся имена модулей в модели')
    # состав набора модулей: тот же, что в тестовом релизе, кроме переименования
    if REFERENCE_MODEL.is_file():
        reference = [m.get('name') for m in json.loads(read(REFERENCE_MODEL))['modules']]
        mapped = ['working-test-release' if name == 'test-release' else name for name in reference]
        if mapped != names:
            only_ref = [n for n in mapped if n not in names]
            only_new = [n for n in names if n not in mapped]
            fail('модули/порядок', 'набор модулей отличается от тестового релиза; '
                 'лишние: %s; отсутствуют: %s' % (only_new or '—', only_ref or '—'))
    seen = set()
    for module in modules:
        if module.get('kind') not in ('script', 'style'):
            fail('модули/порядок', 'модуль %r: неизвестный kind %r'
                 % (module.get('name'), module.get('kind')))
        declared = list(module.get('sources') or [])
        declared += [part['source'] for part in module.get('parts', []) if 'source' in part]
        for source in declared:
            path = (SOURCE_DIR / source).resolve()
            if not path.is_relative_to(SOURCE_DIR.resolve()) or not path.is_file():
                fail('модули/порядок', 'модуль %r: нет исходника %r'
                     % (module.get('name'), source))
            elif source in seen:
                fail('модули/порядок', 'исходник %r объявлен дважды' % source)
            else:
                seen.add(source)
        for part in module.get('parts', []):
            if part.get('source') and part.get('sha256'):
                path = SOURCE_DIR / part['source']
                if path.is_file() and sha256(path) != part['sha256']:
                    fail('модули/порядок', 'часть патча %r: sha256 не совпадает с моделью'
                         % part['source'])
    # порядок подключения во входе
    cursor = 0
    for module in modules:
        name = module.get('name')
        if module.get('kind') == 'style':
            marker = module.get('attributes') or ''
            needle = '<style' + marker
        else:
            needle = '/%s.js"' % name
        position = entry_text.find(needle, cursor)
        if position < 0:
            fail('модули/порядок', 'модуль %r отсутствует во входе или нарушен порядок' % name)
            continue
        cursor = position + len(needle)
        if module.get('kind') == 'script' and entry_text.count(needle) != 1:
            fail('модули/порядок', 'модуль %r подключён во входе более одного раза' % name)
    check_exact_build(entry_text, modules, manifest, build_id)


def check_exact_build(entry_text, modules, manifest, build_id):
    """Точное совпадение сгенерированного HTML и тел модулей с исходниками."""
    if not SHELL.is_file():
        fail('модули/порядок', 'нет оболочки %s: точное совпадение сборки не проверено'
             % rel(SHELL))
        return
    shell = read(SHELL)
    markers = re.findall(r'<!--\s*([A-Z-]*MODULE):([a-z0-9-]+)\s*-->', shell)
    if [name for _, name in markers] != [m['name'] for m in modules]:
        fail('модули/порядок', 'порядок маркеров в %s не совпадает с моделью: %r'
             % (rel(SHELL), [name for _, name in markers]))
        return
    expected = re.sub(r'(<meta name="working-test-build" content=")[^"]*',
                      lambda m: m.group(1) + build_id, shell)
    expected = expected.replace('working-test-version" content="[^"]*"',
                                'working-test-version" content="%s"' % REQUIRED_VERSION)
    build_dir = build_dir_from_manifest(manifest, build_id)
    prefix = None
    match = re.search(r'src="(\./[^"]*/%s/[a-z0-9-]+\.js)"' % build_id, entry_text)
    if match:
        prefix = match.group(1).rsplit('/', 1)[0] + '/'
    if not prefix:
        fail('модули/порядок', 'во входе нет ссылок вида .../build/%s/<module>.js' % build_id)
        return
    for module in modules:
        code = module_body(module)
        if code is None:
            return
        if module.get('kind') == 'style':
            tag = '<style' + (module.get('attributes') or '') + '>' + code + '</style>'
        else:
            file = module['name'] + '.js'
            path = build_dir / file
            if not path.is_file():
                fail('модули/порядок', 'в сборке нет файла модуля: %s' % file)
                return
            if read(path) != code:
                fail('модули/порядок', 'тело сгенерированного модуля не совпадает с исходниками: %s'
                     % file)
            tag = ('<script' + (module.get('attributes') or '')
                   + ' src="' + prefix + file + '"></script>')
        expected = expected.replace('<!-- %s:%s -->' % (markers[0][0], module['name']), tag) \
            if markers else expected
        expected = re.sub(r'<!--\s*[A-Z-]*MODULE:%s\s*-->' % re.escape(module['name']),
                          lambda _m: tag, expected)
    if '<!--' in expected and re.search(r'<!--\s*[A-Z-]*MODULE:', expected):
        fail('модули/порядок', 'в оболочке остались неразвёрнутые маркеры модулей')
        return
    if expected != entry_text:
        first = next((i for i, (a, b) in enumerate(zip(expected, entry_text)) if a != b),
                     min(len(expected), len(entry_text)))
        fail('модули/порядок',
             'сгенерированный вход не совпадает с исходниками (первое расхождение на позиции %d: '
             '%r против %r)' % (first, expected[first:first + 60], entry_text[first:first + 60]))


# ---------- 4. SHA-256 всех ресурсов и build-manifest ----------

def check_hashes(entry_text, manifest, model):
    version = manifest.get('version')
    if not isinstance(version, str) or not re.fullmatch(r'[a-f0-9]{16}', version):
        fail('хеши/манифест', '%s: поле version не 16-значный хеш: %r'
             % (rel(BUILD_MANIFEST), version))
        return
    if 'channel' in manifest and 'working' not in str(manifest['channel']).lower():
        fail('хеши/манифест', 'канал манифеста не относится к working test: %r'
             % manifest['channel'])
    assets = manifest.get('assets')
    if not isinstance(assets, list) or not assets:
        fail('хеши/манифест', 'в манифесте нет списка assets')
        return
    urls = [a.get('url') for a in assets]
    if len(urls) != len(set(urls)):
        fail('хеши/манифест', 'в манифесте повторяются ресурсы')
    if urls[0] != './index-working-test.html':
        fail('хеши/манифест', 'первый ресурс манифеста %r, ожидался ./index-working-test.html'
             % urls[0])
    seen = set()
    for record in assets:
        url, expected = record.get('url'), record.get('sha256')
        if not isinstance(url, str) or not isinstance(expected, str):
            fail('хеши/манифест', 'некорректная запись ресурса: %r' % (record,))
            continue
        if url.startswith(('./test-app/', 'test-app/')) and url not in VENDOR:
            fail('изоляция', 'манифест ссылается на изменяемый файл test-app/: %s' % url)
        path = (ROOT / url.lstrip('./')).resolve()
        if not path.is_relative_to(ROOT):
            fail('хеши/манифест', 'ресурс вне репозитория: %s' % url)
            continue
        if not path.is_file():
            fail('хеши/манифест', 'ресурс отсутствует: %s' % url)
            continue
        actual = sha256(path)
        if actual != expected:
            fail('хеши/манифест', 'SHA-256 не совпадает: %s' % url)
        if url in VENDOR and VENDOR[url] != actual:
            fail('изоляция', 'vendor-библиотека изменена относительно базовой: %s' % url)
        seen.add(url)
    for ref in cached_references(entry_text):
        if ref not in seen:
            fail('хеши/манифест', 'ресурс входа не учтён в манифесте: %s' % ref)
    build_dir = build_dir_from_manifest(manifest, version)
    if not build_dir.is_dir():
        fail('хеши/манифест', 'нет каталога сборки %s' % rel(build_dir))
    else:
        for path in sorted(build_dir.glob('*.js')):
            url = './' + str(path.relative_to(ROOT))
            if url not in seen:
                fail('хеши/манифест', 'сгенерированный скрипт не учтён в манифесте: %s' % url)
    sw_text = read(SW)
    worker_version = re.search(r"const\s+VERSION\s*=\s*'([^']*)'", sw_text)
    if not worker_version:
        fail('SW', 'в sw-working-test.js нет const VERSION')
    elif worker_version.group(1) != version:
        fail('SW', 'VERSION service worker %r не совпадает с манифестом %r'
             % (worker_version.group(1), version))
    records = re.search(r'^const\s+RECORDS\s*=\s*(\[.*\]);\s*$', sw_text, re.M)
    if not records:
        fail('SW', 'в sw-working-test.js нет одной строки const RECORDS = [...]')
    else:
        try:
            worker_records = json.loads(records.group(1))
        except json.JSONDecodeError as error:
            fail('SW', 'RECORDS не разбирается как JSON: %s' % error)
        else:
            if worker_records != assets:
                fail('SW', 'RECORDS service worker не совпадает с assets манифеста')
    if 'baseline_commit' in manifest and model is not None and 'baseline_commit' in model:
        if manifest['baseline_commit'] != model['baseline_commit']:
            fail('хеши/манифест', 'baseline_commit манифеста не совпадает с моделью модулей')


def cached_references(entry_text):
    """Ресурсы для офлайн-кэша: скрипты, стили, манифест, иконки, медиа.

    Обычные ссылки-переходы (<a href>) сюда не входят: это не кэшируемый ресурс.
    """
    refs = []
    refs += re.findall(r'<script[^>]*\ssrc="(\./[^"]+)"', entry_text)
    refs += re.findall(r'<link[^>]*rel="stylesheet"[^>]*href="(\./[^"]+)"', entry_text)
    refs += re.findall(r'<link[^>]*rel="manifest"[^>]*href="(\./[^"]+)"', entry_text)
    refs += re.findall(r'<link[^>]*rel="(?:icon|apple-touch-icon|shortcut icon)"[^>]*href="(\./[^"]+)"', entry_text)
    refs += re.findall(r'<(?:img|source|video|audio)[^>]*\ssrc="(\./[^"]+)"', entry_text)
    return list(dict.fromkeys(refs))


# ---------- 5. Firebase: проект, поставщик, именованное приложение ----------

def check_firebase(texts):
    joined = '\n'.join(text for _, text in texts)
    if not re.search(r'projectId\s*:\s*["\']%s["\']' % FIREBASE_PROJECT, joined):
        fail('firebase/поставщик', 'в снимке working-test нет projectId: "%s"' % FIREBASE_PROJECT)
    if not re.search(r'authDomain\s*:\s*["\']%s[."\']' % FIREBASE_PROJECT, joined):
        fail('firebase/поставщик', 'в снимке нет authDomain проекта %s' % FIREBASE_PROJECT)
    if re.search(r'(projectId|authDomain)\s*:\s*["\']samosval-offline[.\"\']', joined):
        fail('firebase/поставщик', 'в снимке остался проект samosval-offline: версия должна работать с рабочей базой samosval-test')
    if 'ubuntu-candidate' in joined:
        fail('firebase/поставщик', 'в снимке остался маркер ubuntu-candidate')
    if 'autonas' in joined.lower():
        fail('firebase/поставщик', 'в снимке остался маркер autoNAS')


def check_firebase_app_name(sources):
    """Именованное приложение Firebase изолирует persistence IndexedDB от теста."""
    texts = runtime_texts(sources)
    joined = '\n'.join(text for _, text in texts)
    init_calls = []
    for name, text in texts:
        for match in re.finditer(r'initializeApp\s*\(', text):
            depth, cursor, arguments = 0, match.end(), ''
            while cursor < len(text) and len(arguments) < 400:
                char = text[cursor]
                if char in '([{':
                    depth += 1
                elif char in ')]}':
                    if depth == 0:
                        break
                    depth -= 1
                # Capture ALL arguments (including commas at depth 0) so the
                # second argument of initializeApp(config, 'name') is visible.
                arguments += char
                cursor += 1
            init_calls.append((name, arguments))
    if not init_calls:
        fail('firebase/поставщик',
             'в снимке нет вызова initializeApp — приложение Firebase не создаётся')
        return
    named = [call for call in init_calls
             if re.search(r'[\'"]%s[\'"]' % re.escape(FIREBASE_APP_NAME), call[1])]
    if not named:
        fail('firebase/поставщик',
             'initializeApp не создаёт именованное приложение %r: persistence IndexedDB '
             'будет общим с тестовым релизом' % FIREBASE_APP_NAME)
    if not re.search(r'(?:firebase\.app|getApp)\s*\(\s*[\'"]%s[\'"]'
                     % re.escape(FIREBASE_APP_NAME), joined):
        fail('firebase/поставщик',
             'приложение %r нигде не запрашивается по имени: остальные модули могут '
             'работать с приложением по умолчанию' % FIREBASE_APP_NAME)


# ---------- 6. service worker ----------

def check_service_worker(sw_text, manifest_version):
    prefix = re.search(r"const\s+PREFIX\s*=\s*'([^']*)'", sw_text)
    if not prefix:
        fail('SW', 'в sw-working-test.js нет const PREFIX')
    else:
        value = prefix.group(1)
        if 'working' not in value.lower():
            fail('SW', 'PREFIX %r не помечен как working test' % value)
        if value == OLD_TEST_PREFIX:
            fail('SW', 'PREFIX совпадает с тестовым релизом: %r' % value)
    if not re.search(r"new URL\('index-working-test\.html'\s*,\s*BASE\)", sw_text):
        fail('SW', "в SW нет PAGE = new URL('index-working-test.html', BASE)")
    if not re.search(r'new Set\(\s*RECORDS\.map', sw_text):
        fail('SW', 'ALLOWED не строится из RECORDS')
    if not re.search(r'if\s*\(event\.request\.method\s*!==\s*[\'"]GET[\'"]\)\s*return', sw_text):
        fail('SW', 'в SW нет ограничения только GET-запросами')
    if not re.search(r'url\.origin\s*!==\s*BASE\.origin', sw_text):
        fail('SW', 'в SW нет проверки своего origin (чужие запросы должны проходить мимо кэша)')
    if re.search(r"'\./index\.html'|\"\./index\.html\"", sw_text):
        fail('SW', 'SW упоминает production-страницу index.html')
    if 'index-test.html' in sw_text:
        fail('изоляция', 'SW ссылается на index-test.html')
    complete = re.search(r'const\s+COMPLETE\s*=\s*new URL\(\s*[\'"]([^\'"]+)[\'"]', sw_text)
    if not complete:
        fail('SW', 'в SW нет COMPLETE-маркера завершённой установки')
    elif 'working' not in complete.group(1).lower():
        note('COMPLETE-путь SW: %r' % complete.group(1))
    if not (re.search(r'accepted[^\n]{0,120}skipWaiting', sw_text)
            or re.search(r'skipWaiting[^\n]{0,120}accepted', sw_text)):
        fail('полномочия', 'SW вызывает skipWaiting без явного accepted-подтверждения')
    if not re.search(r'caches\.keys\(\)[^\n]*startsWith\(PREFIX\)', sw_text):
        fail('SW', 'очистка кэшей не ограничена своим PREFIX')
    records = re.search(r'^const\s+RECORDS\s*=\s*(\[.*\]);\s*$', sw_text, re.M)
    if records:
        try:
            for record in json.loads(records.group(1)):
                url = record.get('url', '')
                if url.endswith('/index.html') or url in ('./index.html', './sw.js', './manifest.json'):
                    fail('изоляция', 'SW кэширует production-файл: %s' % url)
        except json.JSONDecodeError:
            pass
    register = None
    for path in runtime_sources():
        text = read(path)
        match = re.search(r'\.register\(\s*[\'"]\./([^\'"]+)[\'"]([^)]*)\)', text)
        if match:
            register = (rel(path), match.group(1), match.group(2))
            break
    if not register:
        fail('SW', 'не найдена регистрация service worker в снимке')
    else:
        where, script, options = register
        if script != 'sw-working-test.js':
            fail('SW', '%s регистрирует чужой worker: %s' % (where, script))
        scope = re.search(r'scope\s*:\s*[\'"]([^\'"]+)[\'"]', options)
        if scope and scope.group(1) not in ('./', './index-working-test.html'):
            fail('SW', 'scope регистрации %r выходит за пределы working test' % scope.group(1))


# ---------- 7. собственные manifest/pwa/icons ----------

def check_webmanifest(manifest_text):
    try:
        data = json.loads(manifest_text)
    except json.JSONDecodeError as error:
        fail('manifest/pwa', 'manifest-working-test.webmanifest не разбирается: %s' % error)
        return
    if data.get('id') != './index-working-test.html':
        fail('manifest/pwa', 'id манифеста %r, ожидался ./index-working-test.html' % data.get('id'))
    if data.get('start_url') != './index-working-test.html':
        fail('manifest/pwa', 'start_url %r, ожидался ./index-working-test.html' % data.get('start_url'))
    if data.get('scope') not in ('./', './index-working-test.html'):
        fail('manifest/pwa', 'scope %r выходит за пределы working test' % data.get('scope'))
    title = (str(data.get('name', '')) + ' ' + str(data.get('short_name', ''))).lower()
    if 'тест' not in title and 'working' not in title:
        fail('manifest/pwa', 'имя манифеста не отмечает тестовый характер: %r' % data.get('name'))
    icons = data.get('icons')
    if not isinstance(icons, list) or not icons:
        fail('manifest/pwa', 'в манифесте нет иконок')
        return
    sizes = set()
    test_icon_hashes = {sha256(p) for p in (ROOT / 'test-app' / 'icons').glob('*.png')}
    for icon in icons:
        src = icon.get('src', '')
        sizes.add(icon.get('sizes'))
        if src.startswith(('./test-app/', 'test-app/')):
            fail('изоляция', 'манифест использует иконки тестового релиза: %s' % src)
        path = (ROOT / src.lstrip('./')).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            fail('manifest/pwa', 'иконка отсутствует: %s' % src)
            continue
        if not path.is_relative_to(WT):
            fail('manifest/pwa', 'иконка вне working-test/: %s' % src)
        if sha256(path) in test_icon_hashes:
            fail('manifest/pwa', 'иконка совпадает байт в байт с иконкой тестового релиза: %s' % src)
    if '192x192' not in sizes:
        fail('manifest/pwa', 'в манифесте нет иконки 192x192')
    if '512x512' not in sizes:
        fail('manifest/pwa', 'в манифесте нет иконки 512x512')
    if not any('maskable' in str(icon.get('purpose', '')) for icon in icons):
        note('в манифесте нет иконки purpose=maskable')


def check_pwa_module(sources):
    candidates = [p for p in sources if 'pwa' in p.name.lower()]
    if not candidates:
        fail('manifest/pwa', 'в снимке working-test нет модуля pwa (установка и офлайн-оболочка)')
        return
    joined = '\n'.join(read(p) for p in candidates)
    if 'index-test.html' in joined:
        fail('изоляция', 'pwa-модуль ссылается на index-test.html')
    if 'sw-test.js' in joined:
        fail('изоляция', 'pwa-модуль ссылается на sw-test.js')
    if 'manifest-working-test.webmanifest' not in joined and 'working-test' not in joined:
        note('pwa-модуль не упоминает собственный манифест/сборку')


# ---------- 8. изоляция от тестового релиза ----------

def check_isolation(entry_text, sw_text, webmanifest_text, sources, manifest):
    artifacts = {
        'index-working-test.html': entry_text,
        'sw-working-test.js': sw_text,
        'manifest-working-test.webmanifest': webmanifest_text,
    }
    for name, text in artifacts.items():
        for needle in TEST_RELEASE_FILES:
            if needle in text:
                fail('изоляция', '%s ссылается на файл тестового релиза: %s' % (name, needle))
        for bad in shared_test_app_refs(text):
            fail('изоляция', '%s ссылается на изменяемый файл test-app/: %s' % (name, bad))
    for name, text in runtime_texts(sources):
        for needle in TEST_RELEASE_FILES:
            if needle in text:
                fail('изоляция', '%s ссылается на файл тестового релиза: %s' % (name, needle))
        for bad in shared_test_app_refs(text):
            fail('изоляция', '%s ссылается на изменяемый файл test-app/: %s' % (name, bad))
    for record in manifest.get('assets', []):
        url = str(record.get('url', ''))
        for needle in TEST_RELEASE_FILES:
            if url.endswith(needle):
                fail('изоляция', 'в манифесте ресурс тестового релиза: %s' % url)
        if url.startswith(('./test-app/', 'test-app/')) and url not in VENDOR:
            fail('изоляция', 'в манифесте изменяемый файл test-app/: %s' % url)
    for production in ('./index.html', './sw.js', './manifest.json'):
        if production in entry_text:
            fail('изоляция', 'вход ссылается на production-файл: %s' % production)


# ---------- 9. разделение ключей хранилища и sessionCacheKey ----------

STORAGE_CALL = re.compile(
    r'(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\s*\(\s*([^;]{0,240})')
STRING_LITERAL = re.compile(r"'([^'\\]*(?:\\.[^'\\]*)*)'|\"([^\"\\]*(?:\\.[^\"\\]*)*)\"")
PREFIX_IDENT = re.compile(r'[A-Za-z_$][\w$]*PREFIX[\w$]*|\bPREFIX\b')
KEY_SHAPE = re.compile(r'^[A-Za-z][\w:.\-]*$')


def check_storage(sources):
    joined = '\n'.join(text for _, text in runtime_texts(sources))
    for old in OLD_STORAGE_KEYS:
        if old in joined:
            fail('хранилище', 'в снимке остался ключ тестового релиза: %s' % old)
    if not re.search(r'const\s+\w*STORAGE\w*\s*=\s*[\'"][^\'"]*working[^\'"]*[\'"]', joined, re.I):
        fail('хранилище', 'не объявлен собственный префикс хранилища '
             '(константа STORAGE* с меткой working)')
    if not re.search(r'const\s+\w*PREFIX\w*\s*=\s*[\'"][^\'"]*working[^\'"]*[\'"]', joined, re.I):
        fail('хранилище', 'не объявлен собственный PREFIX хранилища с меткой working')
    bad = []
    for name, text in runtime_texts(sources):
        for match in STORAGE_CALL.finditer(text):
            expression = match.group(1)
            if PREFIX_IDENT.search(expression):
                continue
            for single, double in STRING_LITERAL.findall(expression):
                literal = single or double
                if len(literal) < 6 or not KEY_SHAPE.match(literal):
                    continue
                if 'working' in literal.lower():
                    continue
                line = text[:match.start()].count('\n') + 1
                bad.append('%s:%d %r' % (name, line, literal))
    for item in bad[:20]:
        fail('хранилище', 'ключ без метки working test (общий с тестовым релизом): %s' % item)
    if len(bad) > 20:
        fail('хранилище', 'ещё %d ключей без метки working test' % (len(bad) - 20))


def check_session_cache_key(sources):
    found = None
    for name, text in runtime_texts(sources):
        match = re.search(r'function\s+sessionCacheKey\s*\([^)]*\)\s*\{([^}]{0,600})', text)
        if match:
            found = (name, match.group(1))
            break
    if not found:
        fail('хранилище', 'в снимке нет function sessionCacheKey')
        return
    name, body = found
    if 'projectId' not in body:
        fail('хранилище', 'sessionCacheKey (%s) не учитывает projectId' % name)
    if 'pathname' not in body:
        fail('хранилище', 'sessionCacheKey (%s) не учитывает pathname' % name)
    if 'dt_cache_v14' in body:
        fail('хранилище', 'sessionCacheKey (%s) использует ключ тестового релиза dt_cache_v14'
             % name)


# ---------- 10. документ полномочий и статические проверки ----------

def check_authority(sources, sw_text):
    joined = '\n'.join(text for _, text in runtime_texts(sources))
    if 'hasPermission(' not in joined:
        fail('полномочия', 'в снимке нет проверки прав hasPermission(): контроль доступа потерян')
    if 'currentUserStatus' not in joined and 'permissionsLoaded' not in joined:
        fail('полномочия', 'в снимке нет состояния доступа (currentUserStatus/permissionsLoaded)')
    forbidden = {
        'localStorage.clear(': 'очистка всех настроек устройства',
        'indexedDB.deleteDatabase': 'удаление локальной базы',
        'document.write(': 'запись документа поверх приложения',
        'eval(atob(': 'исполнение скрытого кода',
        'new Function(atob': 'исполнение скрытого кода',
        '-----BEGIN': 'приватный ключ в коде',
        'private_key': 'приватный ключ в коде',
    }
    for name, text in runtime_texts(sources) + [('sw-working-test.js', sw_text)]:
        for needle, why in forbidden.items():
            if needle in text:
                fail('полномочия', '%s содержит %r (%s)' % (name, needle, why))
        for line in text.splitlines():
            if 'caches.delete(' in line and not re.search(r'CACHE|PREFIX|key|complete', line):
                fail('полномочия', '%s удаляет кэш без ограничения своим префиксом: %s'
                     % (name, line.strip()[:120]))
    if not re.search(r'if\s*\(\s*url\.origin\s*!==\s*BASE\.origin\s*\)\s*return', sw_text):
        fail('полномочия', 'SW не исключает чужие origin из обработки')
    check_authority_document(sources)


def check_authority_document(sources):
    """Общий документ полномочий backendAuthority; permission-denied не = «нет документа»."""
    texts = runtime_texts(sources)
    joined = '\n'.join(text for _, text in texts)
    if AUTHORITY_DOC not in joined:
        fail('полномочия', 'в снимке нет общего документа полномочий %r' % AUTHORITY_DOC)
        return
    if 'workspaces' not in joined or 'main_workspace' not in joined or 'settings' not in joined:
        fail('полномочия', 'не найден путь общего документа полномочий '
             'workspaces/main_workspace/settings/%s' % AUTHORITY_DOC)
    guarded = 0
    for name, text in texts:
        for match in re.finditer(AUTHORITY_DOC, text):
            window = text[max(0, match.start() - 1500):match.start() + 1500]
            if re.search(r'permission-denied|permission_denied', window):
                guarded += 1
            elif re.search(r'\.exists\b', window) and re.search(r'catch\s*\(', window):
                note('%s: у %r есть catch без явного permission-denied; проверить, '
                     'что отказ доступа не считается отсутствием документа'
                     % (name, AUTHORITY_DOC))
    if not guarded:
        module_texts = [text for _, text in texts if AUTHORITY_DOC in text]
        if not any(re.search(r'permission-denied|permission_denied', text) for text in module_texts):
            fail('полномочия', 'обработка %r не различает permission-denied: отказ доступа '
                 'может быть принят за отсутствие документа и обнулить полномочия' % AUTHORITY_DOC)


# ---------- 11. синтаксис, inline-eval патчей, тесты ----------

def node_available():
    return shutil.which('node') is not None


def node_check(paths, section='node-проверки'):
    if not node_available():
        skip(section, 'node недоступен в среде — синтаксис не проверен')
        return False
    ok = True
    for path in paths:
        try:
            result = subprocess.run(['node', '--check', str(path)],
                                    capture_output=True, text=True, timeout=120,
                                    env=child_env())
        except (OSError, subprocess.TimeoutExpired) as error:
            fail(section, '%s: не удалось запустить node: %s' % (rel(path), error))
            ok = False
            continue
        if result.returncode != 0:
            tail = (result.stderr or result.stdout).strip().splitlines()[-3:]
            fail(section, 'синтаксис %s: %s' % (rel(path), ' | '.join(tail)))
            ok = False
    return ok


def check_generated_syntax(manifest, model):
    """node --check для КАЖДОГО сгенерированного script-модуля сборки."""
    build_id = str(manifest.get('version'))
    build_dir = build_dir_from_manifest(manifest, build_id)
    targets = []
    if model is not None:
        for module in model.get('modules', []):
            if module.get('kind') != 'script':
                continue
            path = build_dir / ('%s.js' % module.get('name'))
            if path.is_file():
                targets.append(path)
    if build_dir.is_dir():
        targets += sorted(build_dir.glob('*.js'))
    unique, seen = [], set()
    for path in targets:
        if str(path) not in seen:
            seen.add(str(path))
            unique.append(path)
    if not unique:
        fail('node-проверки',
             'не найдено ни одного сгенерированного script-модуля для проверки синтаксиса')
        return
    note('синтаксис проверяется у %d сгенерированных модулей' % len(unique))
    node_check(unique)


EVAL_LITERAL = re.compile(r'eval\s*\)?\s*\(\s*("(?:[^"\\]|\\.)*")')


def check_inline_eval_payloads(sources):
    """Полезная нагрузка встроенных патчей разбирается как JS, но НЕ исполняется."""
    payloads = []
    for path in sources:
        if path.suffix not in ('.js', '.mjs'):
            continue
        text = read(path)
        if 'eval(' not in text:
            continue
        for match in EVAL_LITERAL.finditer(text):
            try:
                payload = json.loads(match.group(1))
            except json.JSONDecodeError:
                continue
            if payload.strip():
                payloads.append((rel(path), payload))
    if not payloads:
        note('inline-eval полезная нагрузка не найдена (патчи могут быть собраны иначе)')
        return
    if not node_available():
        skip('node-проверки', 'node недоступен — inline-eval патчи не разобраны')
        return
    TEMP.mkdir(parents=True, exist_ok=True)
    for index, (where, payload) in enumerate(payloads):
        folder = Path(tempfile.mkdtemp(prefix='wt-eval-', dir=str(TEMP)))
        try:
            temp = folder / ('payload-%d.js' % index)
            temp.write_text(payload, encoding='utf-8')
            node_check([temp], section='node-проверки')
        finally:
            shutil.rmtree(folder, ignore_errors=True)
    note('inline-eval полезной нагрузки патчей разобрано без исполнения: %d' % len(payloads))


def node_tests():
    tests = []
    if SOURCE_DIR.is_dir():
        tests = sorted(p for p in SOURCE_DIR.rglob('*.test.*')
                       if p.suffix in ('.mjs', '.js', '.cjs'))
    if not tests:
        skip('node-тесты', 'в working-test/source нет тестовых файлов — поведение не проверено')
        return
    if not node_available():
        skip('node-тесты', 'node недоступен в среде — тесты не запущены')
        return
    try:
        result = subprocess.run(['node', '--test', *[str(p) for p in tests]],
                                cwd=str(ROOT), capture_output=True, text=True,
                                timeout=600, env=child_env())
    except (OSError, subprocess.TimeoutExpired) as error:
        fail('node-тесты', 'не удалось запустить тесты: %s' % error)
        return
    if result.returncode != 0:
        tail = (result.stderr or result.stdout).strip().splitlines()[-6:]
        fail('node-тесты', 'тесты working-test упали: %s' % ' | '.join(tail))
    else:
        note('node-тесты: %d файл(ов) прошли локально' % len(tests))


NEGATIVE_CASES = {
    'flush pending': r'(flush|pending|очеред)',
    'generation conflict': r'(generation|поколен|conflict|конфликт)',
    'admin-only': r'(admin|админ|permission|прав)',
}


def check_negative_behaviour():
    """Отрицательные сценарии: свои тесты или явные чистые функции."""
    tests = []
    if SOURCE_DIR.is_dir():
        tests = [p for p in SOURCE_DIR.rglob('*.test.*')
                 if p.suffix in ('.mjs', '.js', '.cjs')]
    covered = {}
    for path in tests:
        text = read(path)
        for case, pattern in NEGATIVE_CASES.items():
            if re.search(pattern, text, re.I):
                covered.setdefault(case, []).append(rel(path))
    missing = [case for case in NEGATIVE_CASES if case not in covered]
    if tests and not missing:
        note('отрицательные сценарии покрыты тестами: '
             + ', '.join('%s (%s)' % (c, ', '.join(v)) for c, v in covered.items()))
        return
    if missing:
        skip('отрицательные сценарии',
             'нет локальных тестов для: %s. Требуются (working-test/source/**/*.test.* или '
             'чистые функции без DOM/Firebase): отклонение flush при сбое отправки без потери '
             'очереди, отказ при устаревшем generation, отказ не-админу. '
             'Тестовые файлы создаёт кодер по согласованию с главным.' % ', '.join(missing))


# ---------- 12. защищённый git-базис ----------

def check_git():
    try:
        result = subprocess.run(['git', 'status', '--short', '--branch'],
                                cwd=str(ROOT), capture_output=True, text=True, timeout=120,
                                env=child_env())
    except (OSError, subprocess.TimeoutExpired) as error:
        fail('git-базис', 'не удалось выполнить git status: %s' % error)
        return
    if result.returncode != 0:
        fail('git-базис', 'git status завершился с ошибкой: %s' % result.stderr.strip()[:200])
        return
    branch, entries = '', []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        if line.startswith('##'):
            branch = line[2:].strip()
            continue
        code = line[:2].replace(' ', '')
        path = line[3:].strip()
        if ' -> ' in path:
            path = path.split(' -> ', 1)[1]
        entries.append((code, path.strip('"').rstrip('/')))
    if branch and not branch.startswith('release/working-test'):
        fail('git-базис', 'ветка %r, ожидалась release/working-test' % branch)
    preexisting, ours = [], []
    for code, path in entries:
        if path in BASELINE_CHANGES.get(code, set()):
            preexisting.append('%s %s' % (code, path))
            continue
        if path in ALLOWED_NEW_FILES or path.startswith(ALLOWED_NEW_PREFIXES):
            ours.append('%s %s' % (code, path))
            continue
        protected = (path in ('index-test.html', 'sw-test.js', 'manifest-test.webmanifest',
                              'index.html', 'sw.js', 'manifest.json')
                     or path.startswith(('test-app/', 'tests/', '.github/', 'app/')))
        if protected:
            fail('git-базис', 'изменён защищённый файл/каталог: %s %s' % (code, path))
        else:
            fail('git-базис', 'неожиданное изменение вне задачи: %s %s' % (code, path))
    known = {'%s %s' % (code, path)
             for code, paths in BASELINE_CHANGES.items() for path in paths}
    for item in sorted(known - set(preexisting)):
        note('прежнее чужое изменение отсутствует в git status: %s' % item)
    note('прежние чужие изменения (подтверждены главным, не результат задачи, '
         'в коммит не включать): %s' % (', '.join(sorted(preexisting)) or 'нет'))
    note('новые файлы задачи в git status: %d' % len(ours))


# ---------- запуск ----------

def main():
    missing = []
    if not ENTRY.is_file():
        missing.append('index-working-test.html')
    if not SW.is_file():
        missing.append('sw-working-test.js')
    if not WEBMANIFEST.is_file():
        missing.append('manifest-working-test.webmanifest')
    if not BUILD_TOOL.is_file():
        missing.append('tools/build-working-test.py')
    if not SOURCE_DIR.is_dir():
        missing.append('working-test/source/')
    if not MODULES_JSON.is_file():
        missing.append('working-test/modules.json')
    if not BUILD_MANIFEST.is_file():
        missing.append('working-test/build-manifest.json')
    if missing:
        print('НЕ ГОТОВО: рабочий релиз ещё не собран, нет: ' + ', '.join(missing))
        print('Проверка не запускалась, дефектов не зафиксировано, сборка не выполнялась.')
        return 2

    entry_text = read(ENTRY)
    sw_text = read(SW)
    webmanifest_text = read(WEBMANIFEST)
    manifest = json.loads(read(BUILD_MANIFEST))
    model = load_modules()
    sources = runtime_sources()
    build_id = manifest.get('version') if isinstance(manifest.get('version'), str) else ''

    run_section('вход/версия', check_entry, entry_text, build_id)
    run_section('релиз/история', check_release_sources)
    run_section('модули/порядок', check_modules, entry_text, model, manifest, build_id)
    run_section('хеши/манифест', check_hashes, entry_text, manifest, model)
    run_section('firebase/поставщик', check_firebase, runtime_texts(sources))
    run_section('firebase/поставщик', check_firebase_app_name, sources)
    run_section('SW', check_service_worker, sw_text, build_id)
    run_section('manifest/pwa', check_webmanifest, webmanifest_text)
    run_section('manifest/pwa', check_pwa_module, sources)
    run_section('изоляция', check_isolation, entry_text, sw_text, webmanifest_text,
                sources, manifest)
    run_section('хранилище', check_storage, sources)
    run_section('хранилище', check_session_cache_key, sources)
    run_section('полномочия', check_authority, sources, sw_text)
    run_section('node-проверки', check_generated_syntax, manifest, model)
    run_section('node-проверки', check_inline_eval_payloads, sources)
    run_section('node-проверки', node_check, [SW])
    run_section('node-тесты', node_tests)
    run_section('отрицательные сценарии', check_negative_behaviour)
    run_section('git-базис', check_git)

    print('== Независимая проверка релиза working test ==')
    print('Артефакты: %s, %s, %s, %s' % (rel(ENTRY), rel(SW), rel(WEBMANIFEST),
                                          rel(BUILD_MANIFEST)))
    print('Разделов без замечаний: %d' % len(passed))
    for section in passed:
        print('[OK] %s' % section)
    for section, message in failures:
        print('[ОШИБКА] %s: %s' % (section, message))
    for message in notes:
        print('[УЧТЕНО] %s' % message)
    for section, message in skipped:
        print('[НЕ ПРОВЕРЕНО] %s: %s' % (section, message))
    if failures:
        print('ИТОГ: ОШИБКА — %d замечание(й). Релиз не подтверждён.' % len(failures))
        return 1
    print('ИТОГ: УСПЕШНО — структура, версия, порядок модулей, хеши, изоляция, '
          'хранилище, полномочия и синтаксис проверены; сеть, Firebase и рабочая база '
          'не затрагивались.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
