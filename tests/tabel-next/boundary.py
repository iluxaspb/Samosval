"""Guard the new extension against its actual checkout baseline."""
import hashlib,json,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[2]
baseline='5bc6325c7344fb543d3388fd7c27fe459ede81dd'
def old(path):return subprocess.check_output(['git','show',baseline+':'+path],cwd=root)
paths=subprocess.check_output(['git','ls-tree','-r','--name-only',baseline],cwd=root).decode().splitlines()
allowed={'test-app/source/core/04-subscriptions.js','test-app/source/shell.html','tools/build-test.py','index-test.html','sw-test.js','test-app/build-manifest.json'}
checked=0
for path in paths:
 if path in allowed:continue
 assert (root/path).read_bytes()==old(path),'Unexpected modification: '+path
 checked+=1
p='test-app/source/core/04-subscriptions.js';before=old(p).decode();after=(root/p).read_text();a=after.index('            createObject: async');z=after.index('            session: ()',a);assert after[:a]+after[z:]==before,'Host change outside createObject contract'
p='test-app/source/shell.html';assert (root/p).read_text().replace('<script id="tabel-next-plugin" src="./test-app/tabel-next/plugin.js"></script>\n','')==old(p).decode()
manifest=json.loads((root/'test-app/build-manifest.json').read_text())
for item in manifest['assets']:assert hashlib.sha256((root/item['url']).read_bytes()).hexdigest()==item['sha256'],item['url']
outputs=['index-test.html','sw-test.js','test-app/build-manifest.json'];saved=[(root/p).read_bytes() for p in outputs];subprocess.run(['python3','tools/build-test.py'],cwd=root,check=True);assert saved==[(root/p).read_bytes() for p in outputs]
print(f'PASS {checked} baseline files identical, existing Tabel/production/rules unchanged, only narrow host contract, cache hashes and reproducible build')
