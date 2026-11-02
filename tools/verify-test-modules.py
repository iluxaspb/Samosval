#!/usr/bin/env python3
"""Audit the CURRENT modular test release, not a frozen legacy monolith."""
import importlib.util
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'test-app'
SOURCE = APP / 'source'
spec = importlib.util.spec_from_file_location('test_builder', ROOT / 'tools/build-test.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
model = json.loads((APP / 'modules.json').read_text())
modules = model['modules']
assert modules and len({m['name'] for m in modules}) == len(modules), 'Duplicate/missing module'
assert {'core', 'test-release', 'built-in-patches'} <= {m['name'] for m in modules}
sources = set()
for module in modules:
    assert re.fullmatch(r'[a-z0-9-]+', module['name']), module['name']
    assert module['kind'] in ('script', 'style')
    assert 'sources' in module and isinstance(module['sources'], list)
    declared = [*module['sources'], *(part['source'] for part in module.get('parts', []) if 'source' in part)]
    for source in declared:
        path = (SOURCE / source).resolve()
        assert path.is_relative_to(SOURCE.resolve()) and path.is_file(), 'Missing/unsafe source: ' + source
        assert source not in sources, 'Duplicate source: ' + source
        sources.add(source)
    if 'parts' in module:
        assert all(('source' in part) != ('text' in part) for part in module['parts'])
        assert not module['sources'], 'Duplicate sources in split patch'

# Read-only gate BEFORE builder.build(): all RELEASE sources must agree on a
# single version. This runs on sources only — a legit source-only PR may produce
# artifacts that still need the next rebuild, so no source/built diff comparison
# is made here (that is the separate mainline-generated preflight). If the
# sources disagree, we must not mutate committed artifacts by rebuilding.
VERSION_FIELD = re.compile(r"version[ \t]*:[ \t]*'([^']+)'")

def check_source_release_version(source_dir):
    """Confirm IDENTICAL release version across shell meta/header, test-release.js
    and the first release-history.js record. Read-only; raises on conflict."""
    source_dir = Path(source_dir)
    shell = (source_dir / 'shell.html').read_text()
    meta = re.search(r'<meta name="test-app-version" content="([^"]+)"', shell)
    assert meta, 'test-app-version meta missing in source shell.html'
    meta_version = meta[1]
    header = re.search(r'class="version-text"[^>]*>([^<]+)', shell)
    assert header, 'version-text header missing in source shell.html'
    assert header[1] == meta_version, \
        'Source shell header (%s) differs from source meta (%s)' % (header[1], meta_version)
    runtime = VERSION_FIELD.search((source_dir / 'features' / 'test-release.js').read_text())
    assert runtime and runtime[1] == meta_version, 'Source test-release.js differs'
    history_text = (source_dir / 'features' / 'release-history.js').read_text()
    history_versions = VERSION_FIELD.findall(history_text)
    assert history_versions and history_versions[0] == meta_version, \
        'Source history first record (%s) differs from source meta (%s)' % (
            history_versions[0] if history_versions else 'MISSING', meta_version)
    assert history_versions.count(meta_version) == 1, \
        'Source release version must appear exactly once in history (first record)'
    return meta_version

check_source_release_version(SOURCE)

original_production = {p: (ROOT / p).read_bytes() for p in
    ['index.html', 'sw.js', 'manifest.json', 'firestore-v3.rules', 'firestore-coins-test.rules']}
# Generate in CI from the submitted sources before verifying. Hashed outputs may
# intentionally still be from a previous release in the source-only PR.
builder.build()
manifest = json.loads((APP / 'build-manifest.json').read_text())
build_id = manifest['version']
assert re.fullmatch(r'[a-f0-9]{16}', build_id)
html = (ROOT / 'index-test.html').read_text()
shell = (SOURCE / 'shell.html').read_text()
assert re.findall(r'<!-- TEST-MODULE:([^ ]+) -->', shell) == [m['name'] for m in modules], 'Module placement/order differs'
expected = re.sub(r'(<meta name="test-app-build" content=")[^"]+', lambda m:m[1] + build_id, shell)
built = APP / 'build' / build_id
for module in modules:
    code = builder.body(module)
    if module['kind'] == 'style':
        tag = '<style' + module['attributes'] + '>' + code + '</style>'
    else:
        name = module['name'] + '.js'
        assert (built / name).read_text() == code, 'Generated script differs: ' + name
        tag = '<script' + module['attributes'] + ' src="./test-app/build/' + build_id + '/' + name + '"></script>'
        subprocess.run(['node', '--check', str(built / name)], check=True, stdout=subprocess.DEVNULL)
    expected = expected.replace('<!-- TEST-MODULE:' + module['name'] + ' -->', tag)
assert expected == html, 'Generated markup/styles/handlers/order do not match sources'
assert '<!-- TEST-MODULE:' not in html
release = re.search(r'<meta name="test-app-version" content="([^"]+)"', html)[1]
# Release sources spell the field both as version:'X' and version: 'X'. Accept
# both spellings, but keep the exact single-quoted value and first-entry order.
VERSION_FIELD = re.compile(r"version[ \t]*:[ \t]*'([^']+)'")

def release_version(name):
    found = VERSION_FIELD.search((SOURCE / 'features' / name).read_text())
    assert found, 'Release version field missing: ' + name
    return found[1]

# Regression: release-history.js spells its first record as version: '4.2.0'
# (with a space), while older records use version:'4.1.6'. The former pattern
# version:'X' skipped the spaced first record and matched 4.1.6 instead,
# failing the audit. The first history record must be the release version and
# must appear for this release exactly once (in first position).
history_stack = (SOURCE / 'features' / 'release-history.js').read_text()
history_versions = VERSION_FIELD.findall(history_stack)
assert history_versions and history_versions[0] == release, \
    'Runtime history differs: first record is ' + (history_versions[0] if history_versions else 'MISSING')
assert history_versions.count(release) == 1, 'Release version must appear exactly once in history (first record)'
assert release_version('test-release.js') == release, 'Runtime release version differs'
assert re.search(r'class="version-text"[^>]*>([^<]+)', html)[1] == release, 'Initial header version differs'
assert release_version('release-history.js') == release, 'Runtime history version differs'
assert manifest['channel'].startswith('test-' + release + '-')
assert manifest['baseline_commit'] == model['baseline_commit']

records = manifest['assets']
assert len(records) == len({r['url'] for r in records}), 'Duplicate PWA asset'
assert records[0]['url'] == './index-test.html'
for record in records:
    path = (ROOT / record['url']).resolve()
    assert path.is_relative_to(ROOT) and path.is_file(), record['url']
    assert builder.sha(path.read_bytes()) == record['sha256'], 'PWA SHA256 mismatch: ' + record['url']
for path in (APP / 'tabel-v2').glob('*.mjs'):
    subprocess.run(['node', '--check', str(path)], check=True, stdout=subprocess.DEVNULL)
subprocess.run(['node', '--check', str(ROOT / 'sw-test.js')], check=True, stdout=subprocess.DEVNULL)
worker = (ROOT / 'sw-test.js').read_text()
assert "const VERSION = '" + build_id + "';" in worker
record_match = re.search(r'^const RECORDS = (\[.*\]);$', worker, re.M)
assert record_match and json.loads(record_match[1]) == records, 'Service worker manifest differs'
assert all((ROOT / p).read_bytes() == content for p, content in original_production.items()), 'Production changed'
saved = {p: p.read_bytes() for p in [ROOT / 'index-test.html', ROOT / 'sw-test.js', APP / 'build-manifest.json']}
builder.build()
assert all(p.read_bytes() == contents for p, contents in saved.items()), 'Non-deterministic release'
assert all((ROOT / p).read_bytes() == contents for p, contents in original_production.items())
print('PASS modular audit:', len(modules), 'modules,', len(sources),
      'source files, JS syntax, exact order, checksums, deterministic rebuild; production untouched')
