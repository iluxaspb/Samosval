#!/usr/bin/env python3
"""Exercise the real builder in an isolated fixture; never replace checked-in generated files."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='samosval-build-test-') as tmp:
    target = Path(tmp)
    for name in ['src', 'vendor', 'icons']:
        shutil.copytree(ROOT / 'test-app' / name, target / 'test-app' / name)
    shutil.copyfile(ROOT / 'test-app/modules.json', target / 'test-app/modules.json')
    shutil.copyfile(ROOT / 'manifest-test.webmanifest', target / 'manifest-test.webmanifest')
    (target / 'tools').mkdir()
    shutil.copyfile(ROOT / 'tools/build-test.py', target / 'tools/build-test.py')
    protected = ['index.html', 'sw.js', 'app/build/preserved.js', 'test-app/build/previous/pwa.js', 'pending-operations.json']
    for name in protected:
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('keep:'+name)
    spec = importlib.util.spec_from_file_location('build_test', target / 'tools/build-test.py')
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    with contextlib.redirect_stdout(io.StringIO()):
        build.build()
    manifest = json.loads((target / 'test-app/build-manifest.json').read_text())
    assert len(manifest['assets']) == 46, 'Current photo-free release has exactly 46 precache assets'
    assert not any('firebase-storage' in asset['url'] for asset in manifest['assets']), 'Unused Storage SDK must stay outside the current cache'
    assert not any('/geo-photo' in asset['url'] or '/object-photos' in asset['url'] or '/local-photos' in asset['url'] or '/photo-files' in asset['url'] for asset in manifest['assets']), 'Removed photo modules must not be precached'
    output = [target / 'index-test.html', target / 'sw-test.js', target / 'test-app/build-manifest.json']
    output += list((target / 'test-app/build' / manifest['version']).iterdir())
    first = {str(path.relative_to(target)):path.read_bytes() for path in output}
    # Filesystem enumeration order is unspecified. Reverse every glob to prove output is stable.
    original_glob = Path.glob
    Path.glob = lambda self, pattern: iter(reversed(list(original_glob(self, pattern))))
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            build.build()
    finally:
        Path.glob = original_glob
    for name, data in first.items():
        assert (target / name).read_bytes() == data, 'Nondeterministic output: '+name
    for name in protected:
        assert (target / name).read_text() == 'keep:'+name, 'Unexpected mutation: '+name
    html = (target / 'index-test.html').read_text()
    assert html.count('name="test-app-build"') == 1
    assert 'name="test-app-build" content="'+manifest['version']+'"' in html
    assert html.count('name="test-app-version"') == 1
    print('PASS repeated build with reversed filesystem order is byte-identical; exact build metadata; old builds, production and pending data untouched')
