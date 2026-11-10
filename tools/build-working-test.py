#!/usr/bin/env python3
"""Build the isolated working-test application without touching TEST/production."""
import hashlib, json, re
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
APP=ROOT/'working-test'; SOURCE=APP/'source'
sha=lambda b: hashlib.sha256(b).hexdigest()

def body(module):
    if 'parts' in module:
        out=[]
        for part in module['parts']:
            if 'text' in part: out.append(part['text'])
            else:
                code=(SOURCE/part['source']).read_text()
                out.append(part.get('original_literal') if part.get('sha256')==sha(code.encode()) else json.dumps(code,ensure_ascii=False))
        return ''.join(out)
    return ''.join((SOURCE/p).read_text() for p in module['sources'])

def build():
    spec=json.loads((APP/'modules.json').read_text())
    inputs=[APP/'modules.json',Path(__file__)]+sorted(p for p in SOURCE.rglob('*') if p.is_file() and p.suffix in ('.js','.css','.html'))
    inputs += [APP/'src'/'pwa.js',ROOT/'manifest-working-test.webmanifest']
    inputs += sorted(p for d in ('tabel-v2','tabel','synology','vendor','icons') if (APP/d).is_dir() for p in (APP/d).rglob('*') if p.is_file())
    build_id=sha(b''.join(str(p.relative_to(ROOT)).encode()+p.read_bytes() for p in inputs))[:16]
    out=APP/'build'/build_id; out.mkdir(parents=True,exist_ok=True)
    html=(SOURCE/'shell.html').read_text(); html=re.sub(r'(<meta name="working-test-build" content=")[^"]+',r'\g<1>'+build_id,html)
    release=re.search(r'<meta name="working-test-version" content="([^"]+)"',html).group(1)
    for module in spec['modules']:
        code=body(module)
        if module['kind']=='style': tag='<style'+module.get('attributes','')+'>'+code+'</style>'
        else:
            name=module['name']+'.js'; (out/name).write_text(code)
            tag='<script'+module.get('attributes','')+' src="./working-test/build/'+build_id+'/'+name+'"></script>'
        html=html.replace('<!-- TEST-MODULE:'+module['name']+' -->',tag)
    (ROOT/'index-working-test.html').write_text(html)
    assets=[ROOT/'index-working-test.html',ROOT/'manifest-working-test.webmanifest']
    assets += sorted(p for d in ('src','tabel-v2','tabel','synology','vendor','icons') if (APP/d).is_dir() for p in (APP/d).rglob('*') if p.is_file())
    assets += sorted(out.glob('*.js'))
    assets=list(dict.fromkeys(assets)); records=[{'url':'./'+str(p.relative_to(ROOT)),'sha256':sha(p.read_bytes())} for p in assets]
    sw=(SOURCE/'service-worker.js').read_text(); sw=re.sub(r"const VERSION = '[^']+';","const VERSION = '"+build_id+"';",sw); sw=re.sub(r'^const PREFIX = .*;$',"const PREFIX = 'samosval-working-test-shell-';",sw,flags=re.M); sw=re.sub(r'^const RECORDS = .*;$',lambda m:'const RECORDS = '+json.dumps(records,separators=(',',':'))+';',sw,flags=re.M); sw=sw.replace('index-test.html','index-working-test.html'); sw=re.sub(r'(?:WORKING_)?TEST_PWA_','WORKING_TEST_PWA_',sw)
    (ROOT/'sw-working-test.js').write_text(sw)
    (APP/'build-manifest.json').write_text(json.dumps({'version':build_id,'channel':'working-'+release,'baseline_commit':spec.get('baseline_commit'),'assets':records},indent=2)+'\n')
    print(json.dumps({'release':release,'build':build_id,'assets':len(records)}))
if __name__=='__main__': build()
