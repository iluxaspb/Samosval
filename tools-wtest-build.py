#!/usr/bin/env python3
"""Сборка независимой тестовой копии «Самосвал Тест» в wtest/ (ветка root).

Копия рабочей сборки 1.7.19 (build 19c2d7fa13ba1911) со своим красным
значком, манифестом, service worker и кэшем. Существующие файлы каналов
не меняются: всё новое лежит только внутри wtest/.
"""
import hashlib
import json
import os
import re
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC_BUILD = '19c2d7fa13ba1911'
# Новый уникальный build: 16 hex, отличается от рабочего.
WTEST_BUILD = 'afe5701dfa13ba19'
assert re.fullmatch(r'[a-f0-9]{16}', WTEST_BUILD) and WTEST_BUILD != SRC_BUILD, WTEST_BUILD
VERSION = '1.7.19-test.2'


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    wt = os.path.join(ROOT, 'wtest')
    assert not os.path.exists(wt), 'wtest/ уже существует'
    os.makedirs(wt)

    # 1. Зеркалируем всё дерево working-test (src, vendor, tabel, tabel-v2,
    # synology, build-manifest.json) + новый каталог build/<WTEST_BUILD> вместо
    # всех старых сборок. Файлы копируем как есть (копия pwa.js байт-в-байт).
    shutil.copytree(os.path.join(ROOT, 'working-test'), os.path.join(wt, 'working-test'))
    for old in os.listdir(os.path.join(wt, 'working-test', 'build')):
        shutil.rmtree(os.path.join(wt, 'working-test', 'build', old))
    shutil.copytree(os.path.join(ROOT, 'working-test', 'build', SRC_BUILD),
                    os.path.join(wt, 'working-test', 'build', WTEST_BUILD))

    # 2. Красные иконки (байт-в-байт) под именами production-канона.
    for size in ('192', '512'):
        shutil.copyfile(os.path.join(ROOT, 'test-app', 'icons', f'icon-test-red-{size}.png'),
                        os.path.join(wt, 'working-test', 'icons', f'icon-test-red-{size}.png'))

    # 3. index.html: заменяем манифест, иконку, title, хеш сборки в путях.
    with open(os.path.join(ROOT, 'index.html'), encoding='utf-8') as f:
        html = f.read()
    html = html.replace('./manifest-production.webmanifest', './manifest.webmanifest')
    html = html.replace('./working-test/icons/icon-production-blue-192.png',
                        './working-test/icons/icon-test-red-192.png')
    html = html.replace(f'./working-test/build/{SRC_BUILD}/', f'./working-test/build/{WTEST_BUILD}/')
    html = html.replace('<title>Самосвалы — Рабочая версия', '<title>Самосвалы — Тест')
    html = html.replace(f'<meta name="working-test-build" content="{SRC_BUILD}">',
                        f'<meta name="working-test-build" content="{WTEST_BUILD}">')
    html = html.replace('<meta name="working-test-version" content="1.7.19">',
                        '<meta name="working-test-version" content="' + VERSION + '">')
    html = html.replace('Версия: 1.7.19', 'Версия: ' + VERSION)
    assert 'manifest-production' not in html and 'icon-production-blue' not in html
    with open(os.path.join(wt, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(html)

    # 4. manifest.webmanifest
    manifest = {
        "id": "./index.html",
        "name": "Самосвалы — Тест",
        "short_name": "Самосвал Тест",
        "description": "Тестовая копия рабочей версии: предварительные правки перед выпуском",
        "lang": "ru",
        "start_url": "./index.html",
        "scope": "./",
        "display": "standalone",
        "background_color": "#0f172a",
        "theme_color": "#dc2626",
        "icons": [
            {"src": "./working-test/icons/icon-test-red-192.png", "sizes": "192x192",
             "type": "image/png", "purpose": "any maskable"},
            {"src": "./working-test/icons/icon-test-red-512.png", "sizes": "512x512",
             "type": "image/png", "purpose": "any maskable"},
        ],
    }
    with open(os.path.join(wt, 'manifest.webmanifest'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # Шаг 8 (правка working-test-release.js) выполняется ДО расчёта RECORDS:
    # хеш этого файла входит в RECORDS и build-manifest.
    wr_path = os.path.join(wt, 'working-test', 'build', WTEST_BUILD, 'working-test-release.js')
    wr = open(wr_path, encoding='utf-8').read()
    wr = wr.replace("version:'1.7.19',label:'Рабочая тестовая версия 1.7.19'",
                    f"version:'{VERSION}',label:'Самосвал Тест {VERSION}'")
    with open(wr_path, 'w', encoding='utf-8') as f:
        f.write(wr)

    # 5. sw-working-test.js: VERSION + RECORDS (вырезание блока и json).
    with open(os.path.join(ROOT, 'sw-working-test.js'), encoding='utf-8') as f:
        sw = f.read()
    sw = sw.replace(f"const VERSION = '{SRC_BUILD}';", f"const VERSION = '{WTEST_BUILD}';")
    sw = sw.replace("const PREFIX = 'samosval-working-test-shell-';", "const PREFIX = 'samosval-wtest-shell-';")
    assert "const PREFIX = 'samosval-wtest-shell-';" in sw
    m = re.search(r'const RECORDS = (\[.*?\]);', sw, re.S)
    assert m
    records = json.loads(m.group(1))
    new_records = []
    for r in records:
        url = r['url']
        url = url.replace(f'./working-test/build/{SRC_BUILD}/', f'./working-test/build/{WTEST_BUILD}/')
        if url == './manifest-production.webmanifest':
            url = './manifest.webmanifest'
        elif url == './working-test/icons/icon-production-blue-192.png':
            url = './working-test/icons/icon-test-red-192.png'
        elif url == './working-test/icons/icon-production-blue-512.png':
            url = './working-test/icons/icon-test-red-512.png'
        rec = {'url': url, 'sha256': sha256(os.path.join(wt, url[2:]))}
        assert rec['sha256'], url
        new_records.append(rec)
    assert any(r['url'] == './manifest.webmanifest' for r in new_records)
    sw = sw[:m.start(1)] + json.dumps(new_records, ensure_ascii=False, separators=(',', ':')) + sw[m.end(1):]
    with open(os.path.join(wt, 'sw-working-test.js'), 'w', encoding='utf-8') as f:
        f.write(sw)

    # 6. version.json
    with open(os.path.join(wt, 'version.json'), 'w', encoding='utf-8') as f:
        json.dump({"version": VERSION, "build": WTEST_BUILD}, f, ensure_ascii=False)

    # 7. build-manifest.json и working-test-release.js под новый build/версию.
    bm_path = os.path.join(wt, 'working-test', 'build-manifest.json')
    bm = json.load(open(bm_path, encoding='utf-8'))
    bm['version'] = WTEST_BUILD
    bm['channel'] = 'wtest-' + VERSION
    bm['assets'] = [
        {'url': r['url'], 'sha256': r['sha256']} for r in new_records
    ]
    with open(bm_path, 'w', encoding='utf-8') as f:
        json.dump(bm, f, ensure_ascii=False, indent=2)

    # 7. build-manifest.json под новый build/версию (assets = RECORDS).
    with open(os.path.join(wt, 'working-test', '.complete-' + WTEST_BUILD), 'w') as f:
        f.write(WTEST_BUILD)

    print('BUILD=' + WTEST_BUILD, 'VERSION=' + VERSION, 'RECORDS=' + str(len(new_records)))


if __name__ == '__main__':
    main()
