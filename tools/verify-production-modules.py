"""Validate the promoted source, exact module scope and production identities."""
import importlib.util
import json
import re
import subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('release',ROOT/'tools/build-release.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
manifest=json.loads((ROOT/'app/build-manifest.json').read_text())
html=(ROOT/'index.html').read_text()
source=json.loads((ROOT/'app/modules.json').read_text())
text=''.join(b.body(m) for m in source['modules'])
assert "projectId: \"samosval-test\"" in text
assert 'PRODUCTION_FIREBASE_PROJECT_ID' in text
for bad in ['timesheet','samosval-offline','_test347','./test-app/']:
    assert bad not in html+text,bad
assert '3.4.13' in html and "version:'3.4.13'" in text
for key in ['dt_settings','dt_saved_email','dt_max_queue']:
    assert "'"+key+"'" in text
test=json.loads((ROOT/'test-app/modules.json').read_text())
def testbody(m):
    if 'parts' in m:
        return ''.join(p['text'] if 'text' in p else (ROOT/'test-app/source'/p['source']).read_text() for p in m['parts'])
    return ''.join((ROOT/'test-app/source'/p).read_text() for p in m['sources'])
# Every feature/style apart from channel/version adaptation remains byte-identical.
for before,after in zip(test['modules'],source['modules']):
    assert before['name']==after['name']
    if before['name'] in ['core','built-in-patches','release-history','test-release','style-05']:continue
    expected=testbody(before).replace('TestPWA','AppPWA').replace('./test-app/','./app/').replace('samosval-offline','samosval-test').replace('_test347','').replace('TestStorageState','AppStorageState')
    assert expected==b.body(after),before['name']
for record in manifest['assets']:
    assert record['url'].startswith(('./app/','./index.html','./manifest.json','./icon.svg'))
    assert b.sha((ROOT/record['url']).read_bytes())==record['sha256']
    if record['url'].endswith('.js'):
        subprocess.run(['node','--check',str(ROOT/record['url'])],check=True)
assert not any('timesheet' in r['url'] for r in manifest['assets'])
base=source['source_commit']
for p in ['index-test.html','sw-test.js','test-app/build-manifest.json','firestore-v3.rules','firestore-coins-test.rules']:
    assert subprocess.check_output(['git','show',base+':'+p],cwd=ROOT)==(ROOT/p).read_bytes(),p
install=json.loads((ROOT/'manifest.json').read_text())
old=json.loads(subprocess.check_output(['git','show',base+':manifest.json'],cwd=ROOT))
for key in ['id','scope','start_url']:assert old[key]==install[key]
saved={p:(ROOT/p).read_bytes() for p in ['index.html','sw.js','app/build-manifest.json','index-test.html','sw-test.js']}
b.build()
assert all(data==(ROOT/p).read_bytes() for p,data in saved.items()),'Build changed files on repeated execution'
print('PASS production: module identities, no Timesheet, production config/storage, feature/CSS parity, hashes, JS, deterministic build, test/rules unchanged')
