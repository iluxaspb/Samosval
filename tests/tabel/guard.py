"""Reject changes outside the expressly allowed TEST ledger paths."""
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = '8b0bd65b3c94d2d51e8e611bc9644800ddd58291'
ALLOWED_FILES = {'test-app/src/features/timesheet-app.js', 'test-app/src/features/timesheet-core.js'}
ALLOWED_DIRS = ('test-app/tabel/', 'tests/tabel/')
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
