#!/usr/bin/env python3
"""Deterministic production-only build from app/source; TEST is never written."""
from pathlib import Path
import hashlib
import json
import re

ROOT=Path(__file__).resolve().parents[1]
APP=ROOT/'app'
SOURCE=APP/'source'
sha=lambda b:hashlib.sha256(b).hexdigest()

def body(module):
    if 'parts' not in module:
        return ''.join((SOURCE/p).read_text() for p in module['sources'])
    result=[]
    for part in module['parts']:
        if 'text' in part: result.append(part['text'])
        else:
            code=(SOURCE/part['source']).read_text()
            result.append(part['original_literal'] if sha(code.encode())==part['sha256'] else json.dumps(code,ensure_ascii=False))
    return ''.join(result)

def build():
    spec=json.loads((APP/'modules.json').read_text())
    inputs=[APP/'modules.json',Path(__file__),ROOT/'manifest.json']+sorted(p for p in SOURCE.rglob('*') if p.is_file())
    version=sha(b''.join(str(p.relative_to(ROOT)).encode()+p.read_bytes() for p in inputs))[:16]
    out=APP/'build'/version;out.mkdir(parents=True,exist_ok=True)
    html=(SOURCE/'shell.html').read_text()
    html=re.sub(r'(<meta name="app-build" content=")[^"]+',r'\g<1>'+version,html)
    for module in spec['modules']:
        attrs=module['attributes'];code=body(module)
        if module['kind']=='style': tag='<style'+attrs+'>'+code+'</style>'
        else:
            file=module['name']+'.js';(out/file).write_text(code)
            tag='<script'+attrs+' src="./app/build/'+version+'/'+file+'"></script>'
        html=html.replace('<!-- TEST-MODULE:'+module['name']+' -->',tag)
    (out/'pwa.js').write_text((SOURCE/'pwa.js').read_text())
    html=html.replace('<!-- APP-PWA -->','<script id="app-pwa" src="./app/build/'+version+'/pwa.js"></script>')
    assert '<!-- TEST-MODULE:' not in html and 'timesheet' not in html and 'test-app/' not in html
    (ROOT/'index.html').write_text(html)
    assets=[ROOT/'index.html',ROOT/'manifest.json',ROOT/'icon.svg']+sorted(out.glob('*.js'))
    assets += [p for p in sorted((APP/'vendor').iterdir()) if p.is_file() and p.suffix in ['.js','.css','.ttf','.woff2'] and ('./app/vendor/'+p.name in html or p.suffix in ['.css','.ttf','.woff2'])]
    records=[{'url':'./'+str(p.relative_to(ROOT)),'sha256':sha(p.read_bytes())} for p in assets]
    sw=(SOURCE/'service-worker.js').read_text()
    sw=re.sub(r"const VERSION = '[^']+';", "const VERSION = '"+version+"';",sw)
    sw=re.sub(r'^const RECORDS = .*;$',lambda m:'const RECORDS = '+json.dumps(records,separators=(',',':'))+';',sw,flags=re.M)
    (ROOT/'sw.js').write_text(sw)
    (APP/'build-manifest.json').write_text(json.dumps({'version':version,'release':spec['release'],'source_commit':spec['source_commit'],'assets':records},indent=2)+'\n')
    print(json.dumps({'release':spec['release'],'build':version,'html_bytes':len(html.encode()),'assets':len(records)}))

if __name__=='__main__':build()
