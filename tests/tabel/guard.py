"""Reject changes outside the expressly allowed TEST ledger paths."""
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = '8b0bd65b3c94d2d51e8e611bc9644800ddd58291'
ALLOWED_FILES = {
 'firestore-timesheet-test.rules', # Explicitly authorized TEST rules publication, 27.10.2026.
 'index-test.html','sw-test.js','test-app/build-manifest.json','tools/build-test.py','tools/verify-test-modules.py',
 'test-app/source/core/04-subscriptions.js','test-app/source/shell.html',
 'test-app/source/features/test-release.js','test-app/source/features/release-history.js',
 'test-app/README.md','test-app/source/README.md','tests/timesheet/core.cjs','tests/timesheet/emulator.cjs',
 'tests/timesheet/package.json','tests/pwa/service-worker.cjs','tests/pwa/update-browser.py',
 'test-app/src/features/timesheet-app.js','test-app/src/features/timesheet-core.js','test-app/src/styles/timesheet-css.css',
 'assets/timesheet.js','assets/timesheet-core.js','assets/timesheet.css'
} # Explicitly authorized TEST plugin integration only.

build = json.loads((ROOT/'test-app/build-manifest.json').read_text())['version']
ALLOWED_DIRS = ('test-app/build/e125d3cac7017870/', 'test-app/build/a56f826f30325346/', 'test-app/build/21e3174b72f1f963/', 'test-app/tabel/', 'tests/tabel/', 'test-app/build/'+build+'/')
files = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', BASE], cwd=ROOT).decode().splitlines()
protected = []
for name in files:
    if name in ALLOWED_FILES or name.startswith(ALLOWED_DIRS):
        continue
    old = subprocess.check_output(['git', 'rev-parse', BASE + ':' + name], cwd=ROOT).decode().strip()
    current = ROOT / name
    assert current.is_file(), 'Protected file removed: ' + name
    blob = subprocess.check_output(['git', 'hash-object', name], cwd=ROOT).decode().strip()
    assert blob == old, 'Protected file changed: ' + name
    protected.append(name)
changed = set(subprocess.check_output(['git', 'diff', '--name-only', BASE], cwd=ROOT).decode().splitlines())
untracked = set(subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard'], cwd=ROOT).decode().splitlines())
for name in changed | untracked:
    assert name in ALLOWED_FILES or name.startswith(ALLOWED_DIRS), 'Out-of-scope file: ' + name
print(json.dumps({'baseline': BASE, 'protected_files_identical': len(protected), 'changed': sorted(changed | untracked)}, ensure_ascii=False, indent=2))
