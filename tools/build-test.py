#!/usr/bin/env python3
"""Build current TEST sources only. Classic script order/scope is preserved."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'test-app'
SOURCE = APP / 'source'
sha = lambda b: hashlib.sha256(b).hexdigest()

def body(module):
    if 'parts' in module:
        result = []
        for part in module['parts']:
            if 'text' in part:
                result.append(part['text'])
            else:
                code = (SOURCE / part['source']).read_text()
                result.append(part['original_literal'] if sha(code.encode()) == part['sha256']
                              else json.dumps(code, ensure_ascii=False))
        return ''.join(result)
    return ''.join((SOURCE / p).read_text() for p in module['sources'])

def build():
    spec = json.loads((APP / 'modules.json').read_text())
    inputs = [APP / 'modules.json', Path(__file__)] + sorted(p for p in SOURCE.rglob('*') if p.is_file())
    inputs += sorted(p for p in (APP / 'tabel').iterdir() if p.suffix in ['.js','.mjs','.css'])
    build_id = sha(b''.join(str(p.relative_to(ROOT)).encode()+p.read_bytes() for p in inputs))[:16]
    out = APP / 'build' / build_id
    out.mkdir(parents=True, exist_ok=True)
    html = (SOURCE / 'shell.html').read_text()
    html = re.sub(r'(<meta name="test-app-build" content=")[^"]+',r'\g<1>'+build_id,html)
    release = re.search(r'<meta name="test-app-version" content="([^"]+)"',html)[1]
    for module in spec['modules']:
        code, attrs = body(module), module['attributes']
        if module['kind'] == 'style':
            # Keep CSS at exactly the original cascade position and base URL.
            tag = '<style'+attrs+'>'+code+'</style>'
        else:
            file = module['name']+'.js'
            (out / file).write_text(code)
            tag = '<script'+attrs+' src="./test-app/build/'+build_id+'/'+file+'"></script>'
        html = html.replace('<!-- TEST-MODULE:'+module['name']+' -->',tag)
    assert '<!-- TEST-MODULE:' not in html
    (ROOT / 'index-test.html').write_text(html)
    old = json.loads((APP / 'build-manifest.json').read_text())
    assets = [ROOT / 'index-test.html']
    assets += [ROOT / r['url'] for r in old['assets'] if r['url'] != './index-test.html' and not r['url'].startswith('./test-app/build/') and 'timesheet-' not in r['url'] and '/test-app/tabel/' not in r['url']]
    assets += sorted(out.glob('*.js'))
    assets += sorted(p for p in (APP / 'tabel').iterdir() if p.suffix in ['.js','.mjs','.css'])
    assets = list(dict.fromkeys(assets))
    records = [{'url':'./'+str(p.relative_to(ROOT)), 'sha256':sha(p.read_bytes())} for p in assets]
    sw = (SOURCE / 'service-worker.js').read_text()
    sw = re.sub(r"const VERSION = '[^']+';", "const VERSION = '"+build_id+"';",sw)
    sw = re.sub(r'^const RECORDS = .*;$',lambda m:'const RECORDS = '+json.dumps(records,separators=(',',':'))+';',sw,flags=re.M)
    (ROOT / 'sw-test.js').write_text(sw)
    (APP / 'build-manifest.json').write_text(json.dumps({'version':build_id,'channel':'test-'+release+'-modular-plus-timesheet','baseline_commit':spec['baseline_commit'],'assets':records},indent=2)+'\n')
    print(json.dumps({'release':release,'build':build_id,'html_bytes':len(html.encode()),'scripts':len(list(out.glob('*.js'))),'assets':len(records)}))

if __name__ == '__main__':
    build()
