#!/usr/bin/env python3
"""Проверка целостности текущей линии working-test (замена build-release.py --check).

Прод-комплект в root собирается из исходников working-test/ (эталоны 7ca5007,
d01de1a), отдельного production-билдера нет. Скрипт выбирает режим по дереву:

- Режим «линия» (есть исходники working-test/source + modules.json + билдер —
  ветки разработки и release/working-test): пересборка комплекта в чистом
  temp-каталоге (в репозиторий ничего не пишем) должна байт-в-байт воспроизвести
  index-working-test.html / sw-working-test.js / version.json /
  working-test/build-manifest.json; версии version.json ↔ meta ↔ канал согласованы.

- Режим «прод root» (исходников в дереве нет, есть собранный комплект): прод-
  пересборка правит pwa.js и записи манифеста (docs/opyt-oshibok.md, п.2), поэтому
  вместо пересборки проверяем самосогласованность закоммиченного комплекта:
  каждый asset из build-manifest.json существует и его sha256 совпадает;
  build-хэш совпадает в manifest.version, meta index.html, VERSION sw-working-test.js
  и version.json.build; версия в version.json совпадает с каналом манифеста.

Выход: exit 0 — целостность подтверждена; иначе печать отличий и exit 1.
"""
import hashlib, json, re, shutil, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LINE_ARTIFACTS = ['index-working-test.html', 'sw-working-test.js', 'version.json',
                  'working-test/build-manifest.json']
LINE_SOURCES = ['working-test/modules.json', 'working-test/source/shell.html',
                'tools/build-working-test.py', 'manifest-working-test.webmanifest']

fail = []

def report(name, ok, detail=''):
    print(('OK  ' if ok else 'FAIL') + ' ' + name + ((' — ' + detail) if detail else ''))
    if not ok:
        fail.append(name)

def check_line_mode():
    """Есть исходники линии: сборка в temp + байт-в-байт воспроизводимость."""
    for rel in LINE_ARTIFACTS + LINE_SOURCES:
        if not (ROOT / rel).is_file():
            print('FAIL отсутствует ' + rel + ' — нечего сверять')
            sys.exit(1)

    with tempfile.TemporaryDirectory(prefix='wt-integrity-') as tmp:
        stage = Path(tmp) / 'repo'
        # Копируем только исходники: working-test/ без старых build/*, манифест
        # канала и сам билдер. Коммит-артефакты на втором шаге.
        shutil.copytree(ROOT / 'working-test', stage / 'working-test',
                        ignore=shutil.ignore_patterns('build'))
        shutil.copy2(ROOT / 'manifest-working-test.webmanifest', stage)
        (stage / 'tools').mkdir()
        shutil.copy2(ROOT / 'tools/build-working-test.py', stage / 'tools')

        r = subprocess.run([sys.executable, 'tools/build-working-test.py'],
                           cwd=stage, capture_output=True, text=True)
        if r.returncode != 0:
            print('FAIL сборка из исходников working-test/ упала:\n' + r.stdout + r.stderr)
            sys.exit(1)
        info = json.loads(r.stdout.strip().splitlines()[-1])
        print('Сборка в temp прошла: release {} build {} assets {}'.format(
            info['release'], info['build'], info['assets']))

        for rel in LINE_ARTIFACTS:
            target = stage / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / rel, target)
        r2 = subprocess.run([sys.executable, 'tools/build-working-test.py'],
                            cwd=stage, capture_output=True, text=True)
        if r2.returncode != 0:
            report('повторная сборка (с артефактами на месте) проходит', False, r2.stderr)
        else:
            for rel in LINE_ARTIFACTS:
                same = (ROOT / rel).read_bytes() == (stage / rel).read_bytes()
                report(rel + ' воспроизводим байт-в-байт', same,
                       '' if same else 'пересборка из исходников отличается от закоммиченного')

    vj = json.loads((ROOT / 'version.json').read_text())
    manifest = json.loads((ROOT / 'working-test/build-manifest.json').read_text())
    m = re.search(r'<meta name="working-test-version" content="([^"]+)"',
                  (ROOT / 'index-working-test.html').read_text())
    report('version.json / meta / канал согласованы',
           bool(m) and vj['version'] == m.group(1) == info['release']
           and manifest.get('version') == vj['build'],
           'version.json={} meta={} канал={} build={}'.format(
               vj['version'], m.group(1) if m else '?', manifest.get('channel'), vj['build']))

def check_prod_mode():
    """Исходников нет (ветка root): самосогласованность собранного прод-комплекта."""
    for rel in ['working-test/build-manifest.json', 'version.json', 'index.html',
                'sw-working-test.js']:
        if not (ROOT / rel).is_file():
            print('FAIL отсутствует ' + rel + ' — нечего сверять')
            sys.exit(1)

    manifest = json.loads((ROOT / 'working-test/build-manifest.json').read_text())
    channel = manifest.get('channel', '')
    build = manifest.get('version')
    vj = json.loads((ROOT / 'version.json').read_text())
    html = (ROOT / 'index.html').read_text()
    meta_build = re.search(r'<meta name="working-test-build" content="([^"]+)"', html)
    meta_ver = re.search(r'<meta name="working-test-version" content="([^"]+)"', html)
    sw = (ROOT / 'sw-working-test.js').read_text()
    sw_ver = re.search(r"const VERSION = '([^']+)'", sw)

    report('канал манифеста production-*', channel.startswith('production-'),
           'канал=' + channel)
    report('build-хэш согласован (manifest / index.html / sw-working-test.js / version.json)',
           build == (meta_build.group(1) if meta_build else None)
           == (sw_ver.group(1) if sw_ver else None) == vj.get('build'),
           'manifest={} meta={} sw={} version.json={}'.format(
               build, meta_build.group(1) if meta_build else '?',
               sw_ver.group(1) if sw_ver else '?', vj.get('build')))
    expected_ver = channel.split('-', 1)[1] if '-' in channel else None
    report('версия согласована (version.json / index.html / канал)',
           vj.get('version') == (meta_ver.group(1) if meta_ver else None) == expected_ver,
           'version.json={} meta={} канал={}'.format(
               vj.get('version'), meta_ver.group(1) if meta_ver else '?', channel))

    bad = []
    for rec in manifest.get('assets', []):
        url = rec['url']
        p = ROOT / (url[2:] if url.startswith('./') else url)
        if not p.is_file():
            bad.append(url + ' отсутствует')
        elif hashlib.sha256(p.read_bytes()).hexdigest() != rec['sha256']:
            bad.append(url + ' sha256 не совпадает')
    report('прод-комплект соответствует своему build-manifest ({} assets)'.format(
        len(manifest.get('assets', []))), not bad, '; '.join(bad[:5]))

def main():
    if all((ROOT / rel).is_file() for rel in LINE_SOURCES):
        check_line_mode()
    elif (ROOT / 'working-test/build-manifest.json').is_file():
        check_prod_mode()
    else:
        print('FAIL нет ни исходников линии, ни build-manifest — проверять нечего')
        sys.exit(1)
    if fail:
        print('\nИТОГ: FAIL (' + ', '.join(fail) + ')')
        sys.exit(1)
    print('\nИТОГ: OK — целостность подтверждена')

if __name__ == '__main__':
    main()
