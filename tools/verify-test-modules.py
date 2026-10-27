"""Prove the split against the approved page, not obsolete modular sources."""
import importlib.util
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('builder', ROOT / 'tools/build-test.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
data = json.loads((ROOT / 'test-app/modules.json').read_text())
baseline = subprocess.check_output(['git','show',data['baseline_commit']+':index-test.html'],cwd=ROOT).decode()
pattern = re.compile(r'<(script|style)\b([^>]*)>([\s\S]*?)</\1>')
blocks = [m for m in pattern.finditer(baseline) if not (m[1]=='script' and re.search(r'\bsrc\s*=',m[2]))]
assert len(blocks) == len(data['modules'])
for old, module in zip(blocks,data['modules']):
    assert old[1] == module['kind'] and old[2] == module['attributes']
    code = b.body(module)
    if module['name'] == 'release-history':
        code = re.sub(r"^    \{version:'3\.4\.(?:12|14|15)'.*\n",'',code,flags=re.M)
    elif module['name'] == 'test-release':
        code = code.replace('3.4.15','3.4.11').rstrip('\n')
    elif module['name'] == 'core':
        # Only the plugin manager/ctx contract may change; verify every byte outside it.
        a, z = code.index('  // === ПЛАГИНЫ ==='), code.index('  // === АВТОРИЗАЦИЯ ===')
        old_a, old_z = old[3].index('  // === ПЛАГИНЫ ==='), old[3].index('  // === АВТОРИЗАЦИЯ ===')
        code = code[:a] + old[3][old_a:old_z] + code[z:]
    elif module['name'] == 'built-in-patches':
        # Serialized wrappers keep the same eval semantics. Compare decoded
        # patch bodies individually; the sole adapter restores HTML export.
        decode = lambda s: [json.loads(m[1]) for m in re.finditer(r'\(0, eval\)\(("(?:\\.|[^"\\])*")\)',s)]
        before, after = decode(old[3]), decode(code)
        assert len(before) == len(after) == 13
        for i,(x,y) in enumerate(zip(before,after)):
            if i == 3:
                y = y.replace('    if (window.TestPWA?.inlineHtml) html = await window.TestPWA.inlineHtml(html);\n','')
                y = y.rstrip('\n')
            assert x == y, 'Patch logic changed: '+str(i)
        continue
    assert old[3] == code, 'Source changed: '+module['name']

# All markup, inline handlers, CSS positions and dependency tags are unchanged.
iterator = iter(data['modules'])
def marker(m):
    if m[1]=='script' and re.search(r'\bsrc\s*=',m[2]): return m[0]
    return '<!-- TEST-MODULE:'+next(iterator)['name']+' -->'
expected = pattern.sub(marker,baseline)
expected = ''.join(line for line in expected.splitlines(True) if not any(x in line for x in ['href="./test-app/src/styles/timesheet-css.css"','id="tab-timesheet"','id="nav-timesheet"','id="timesheet-core"','id="timesheet-app"']))
expected = expected.replace('<!-- TEST-MODULE:core -->','<script id="tabel-plugin" src="./test-app/tabel/plugin.js"></script>\n<!-- TEST-MODULE:core -->')
actual = (b.SOURCE / 'shell.html').read_text().replace('3.4.15','3.4.11')
assert actual == expected, 'HTML/handler layout changed'
for file in ['index.html','sw.js','manifest.json','firestore-v3.rules','firestore-coins-test.rules']:
    original = subprocess.check_output(['git','show',data['baseline_commit']+':'+file],cwd=ROOT)
    assert original == (ROOT/file).read_bytes(), 'Out-of-scope change: '+file

manifest = json.loads((b.APP / 'build-manifest.json').read_text())
for asset in manifest['assets']:
    assert b.sha((ROOT / asset['url']).read_bytes()) == asset['sha256'],asset['url']
for file in (b.APP / 'build' / manifest['version']).glob('*.js'):
    subprocess.run(['node','--check',str(file)],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['node','--check',str(ROOT/'sw-test.js')],check=True)
outputs = [ROOT/'index-test.html',ROOT/'sw-test.js',b.APP/'build-manifest.json']
saved = [p.read_bytes() for p in outputs]
b.build()
assert saved == [p.read_bytes() for p in outputs], 'Non-deterministic build'
print('PASS: 29 blocks, 13 patches, host logic/CSS/markup/order outside explicit plugin integration, scoped files, JS syntax, hashes, deterministic rebuild')
