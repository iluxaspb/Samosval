#!/usr/bin/env python3
"""Build the production 4.0 shell from app/, without changing the test release."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'app'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def build():
    spec = json.loads((APP / 'modules.json').read_text(encoding='utf-8'))
    inputs = [APP / 'modules.json', Path(__file__)] + sorted((APP / 'src').rglob('*'))
    inputs += sorted((APP / 'vendor').glob('*')) + sorted((APP / 'icons').glob('*'))
    inputs += [ROOT / 'manifest.json']
    version = digest(b''.join(str(p.relative_to(ROOT)).encode() + p.read_bytes()
                              for p in inputs if p.is_file()))[:16]
    out = APP / 'build' / version
    out.mkdir(parents=True, exist_ok=True)
    shell = (APP / 'src/shell.html').read_text(encoding='utf-8')
    for module in spec['modules']:
        ext = 'css' if module['kind'] == 'style' else 'js'
        code = ''.join((APP / 'src' / p).read_text(encoding='utf-8') for p in module['sources'])
        filename = module['name'] + '.' + ext
        (out / filename).write_text(code, encoding='utf-8')
        url = './app/build/' + version + '/' + filename
        attrs = module['attributes']
        tag = ('<link rel="stylesheet"' + attrs + ' href="' + url + '">') if ext == 'css' else ('<script' + attrs + ' src="' + url + '"></script>')
        shell = shell.replace('<!-- TEST-MODULE:' + module['name'] + ' -->', tag)
    assert '<!-- TEST-MODULE:' not in shell
    vendor = json.loads((APP / 'vendor/sources.json').read_text(encoding='utf-8'))
    for item in vendor:
        if item['url'].endswith('.js'):
            shell = shell.replace(item['url'], './app/vendor/' + item['file'])
    shell = shell.replace('./test-app/vendor/', './app/vendor/')
    (out / 'pwa.js').write_text((APP / 'src/pwa.js').read_text(encoding='utf-8'), encoding='utf-8')
    shell = shell.replace('<!-- TEST-PWA -->', '<script id="app-pwa" src="./app/build/' + version + '/pwa.js"></script>')
    (ROOT / 'index.html').write_text(shell, encoding='utf-8')
    assets = [ROOT / 'index.html', ROOT / 'manifest.json', ROOT / 'icon.svg'] + sorted(out.glob('*'))
    assets += [p for p in sorted((APP / 'vendor').glob('*')) if p.suffix in ('.js', '.css', '.ttf', '.woff2')]
    assets += sorted((APP / 'icons').glob('*.png'))
    records = [{'url': './' + str(p.relative_to(ROOT)), 'sha256': digest(p.read_bytes())} for p in assets]
    sw = (APP / 'src/service-worker.js').read_text(encoding='utf-8')
    sw = sw.replace('__BUILD_VERSION__', version).replace('__PRECACHE_RECORDS__', json.dumps(records, ensure_ascii=False))
    (ROOT / 'sw.js').write_text(sw, encoding='utf-8')
    (APP / 'build-manifest.json').write_text(json.dumps({'version': version, 'release': spec['release'], 'source_commit': spec['source_commit'], 'assets': records}, indent=2) + '\n')
    print(json.dumps({'release': spec['release'], 'build': version, 'html_bytes': len(shell.encode()), 'precache_files': len(records), 'precache_bytes': sum(p.stat().st_size for p in assets)}))

if __name__ == '__main__':
    build()
