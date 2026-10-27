"""Refresh standalone TEST build identity and worker integrity; never touches index.html."""
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
page = root / 'index-test.html'
worker = root / 'sw-test.js'
manifest = root / 'test-app/build-manifest.json'
html, sw = page.read_text(), worker.read_text()
records = json.loads(re.search(r'^const RECORDS = (.*);$', sw, re.M)[1])
pattern = r'(<meta name="test-app-build" content=")[^"]+(">)'
normalized, count = re.subn(pattern, r'\1BUILD\2', html)
assert count == 1
assets = b''.join((root / r['url']).read_bytes() for r in records if r['url'] != './index-test.html')
build = hashlib.sha256(normalized.encode() + assets).hexdigest()[:16]
html = re.sub(pattern, lambda m: m[1] + build + m[2], html)
page.write_text(html)
for record in records:
    record['sha256'] = hashlib.sha256((root / record['url']).read_bytes()).hexdigest()
sw = re.sub(r"const VERSION = '[^']+';", "const VERSION = '" + build + "';", sw)
sw = re.sub(r'^const RECORDS = .*;$', 'const RECORDS = ' + json.dumps(records, separators=(',', ':')) + ';', sw, flags=re.M)
worker.write_text(sw)
data = json.loads(manifest.read_text())
data.update(version=build, assets=records)
manifest.write_text(json.dumps(data, indent=2) + '\n')
print(build)
