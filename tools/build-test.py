#!/usr/bin/env python3
"""Deterministic, dependency-free build. Never reads or writes production files."""
from pathlib import Path
import hashlib, json, re, argparse

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'test-app'
def digest(data): return hashlib.sha256(data).hexdigest()
def text(path): return path.read_text(encoding='utf-8')

def build():
    spec = json.loads(text(APP / 'modules.json'))
    # Content-addressed paths prevent a cached page from mixing releases.
    inputs = [APP / 'modules.json', Path(__file__)] + sorted((APP / 'src').rglob('*'))
    inputs += sorted((APP / 'vendor').glob('*')) + sorted((APP / 'icons').glob('*'))
    version = digest(b''.join(str(p.relative_to(ROOT)).encode()+p.read_bytes() for p in inputs if p.is_file()))[:16]
    out = APP / 'build' / version
    out.mkdir(parents=True, exist_ok=True)
    shell = text(APP / 'src/shell.html')
    release = re.search(r"version:'([^']+)'", text(APP / 'src/features/release-history.js')).group(1)
    assert 'Версия ' + release in shell, 'Shell version must match the current release history'
    shell = shell.replace('</head>', '<meta name="test-app-build" content="'+version+'">\n<meta name="test-app-version" content="'+release+'">\n</head>')
    for module in spec['modules']:
        ext = 'css' if module['kind'] == 'style' else 'js'
        code = ''.join(text(APP / 'src' / p) for p in module['sources'])
        filename = module['name'] + '.' + ext
        (out / filename).write_text(code, encoding='utf-8')
        url = './test-app/build/' + version + '/' + filename
        attrs = module['attributes']
        tag = ('<link rel="stylesheet"' + attrs + ' href="' + url + '">') if ext == 'css' else ('<script'+attrs+' src="'+url+'"></script>')
        shell = shell.replace('<!-- TEST-MODULE:' + module['name'] + ' -->', tag)
    assert '<!-- TEST-MODULE:' not in shell
    vendor = json.loads(text(APP / 'vendor/sources.json'))
    for item in vendor:
        if item['url'].endswith('.js'):
            shell = shell.replace(item['url'], './test-app/vendor/' + item['file'])
    # PWA bridge is also versioned, and remains absent from the production page.
    (out/'pwa.js').write_text(text(APP/'src/pwa.js'), encoding='utf-8')
    shell = shell.replace('<!-- TEST-PWA -->','<script id="test-pwa" src="./test-app/build/'+version+'/pwa.js"></script>')
    (ROOT/'index-test.html').write_text(shell, encoding='utf-8')
    assets = [ROOT/'index-test.html',ROOT/'manifest-test.webmanifest'] + sorted(out.glob('*'))
    # Keep legacy vendor files available to open clients, but only cache scripts used by this release.
    assets += [p for p in sorted((APP/'vendor').glob('*'))
               if p.suffix in ('.css','.ttf','.woff2')
               or (p.suffix == '.js' and './test-app/vendor/' + p.name in shell)]
    assets += sorted((APP/'icons').glob('*.png'))
    records = [{'url':'./'+str(p.relative_to(ROOT)), 'sha256':digest(p.read_bytes())} for p in assets]
    sw = text(APP/'src/service-worker.js').replace('__BUILD_VERSION__',version).replace('__PRECACHE_RECORDS__',json.dumps(records,ensure_ascii=False))
    (ROOT/'sw-test.js').write_text(sw, encoding='utf-8')
    (APP/'build-manifest.json').write_text(json.dumps({'version':version,'baseline_commit':spec['baseline_commit'],'assets':records},indent=2)+'\n')
    print(json.dumps({'version':version,'html_bytes':len(shell.encode()),'precache_files':len(records),'precache_bytes':sum(p.stat().st_size for p in assets)}))

if __name__ == '__main__': build()
