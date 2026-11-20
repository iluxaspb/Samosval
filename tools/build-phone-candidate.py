#!/usr/bin/env python3
"""Build only in an explicit NEW scratch directory; never modifies channel files."""
import pathlib,subprocess,sys,tarfile,io,shutil,json,hashlib
repo=pathlib.Path(__file__).resolve().parents[1]
out=pathlib.Path(sys.argv[1]).resolve()
base=repo.parent
assert out.parent==base and not out.exists(), 'use a NEW sibling scratch directory'
out.mkdir()
data=subprocess.check_output(['git','archive','537499e'],cwd=repo)
with tarfile.open(fileobj=io.BytesIO(data)) as archive: archive.extractall(out,members=[m for m in archive.getmembers() if not m.issym() and not m.islnk()],filter='data')
shutil.copytree(repo/'working-test/source',out/'working-test/source',dirs_exist_ok=True)
shutil.copy2(repo/'working-test/modules.json',out/'working-test/modules.json')
version='1.7.22-test.1'
for rel in ['working-test/source/shell.html','working-test/source/features/working-test-release.js']:
 p=out/rel;p.write_text(p.read_text().replace('1.7.21',version))
p=out/'working-test/source/features/release-history.js'
p.write_text(p.read_text().replace('const releases=[',"const releases=[{version:'"+version+"',date:'2026-11-20',title:'Телефоны самосвалов',items:['Телефон в справочнике и на Линии; отдельные права чтения, звонка и добавления.']},"))
subprocess.run(['python3','tools/build-working-test.py'],cwd=out,check=True)
m=json.loads((out/'working-test/build-manifest.json').read_text())
for asset in m['assets']:
 assert hashlib.sha256((out/asset['url'].removeprefix('./')).read_bytes()).hexdigest()==asset['sha256'],asset
print(json.dumps({'directory':str(out),'verified_assets':len(m['assets']),'build':m['version'],'version':version}))
