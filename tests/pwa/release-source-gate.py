#!/usr/bin/env python3
"""SOURCE release-version gate: verify-test-modules must refuse to build when the
committed release sources disagree, and must never touch committed artifacts.

Fully isolated: the gate function is extracted from the real verifier and driven
against fixture source trees in a tempdir. Real source and generated files are
never read or written, so a broken gate can never mutate the repository.
"""
import hashlib
import re
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / 'tools/verify-test-modules.py'
source = VERIFIER.read_text()

# Order guarantee: the read-only gate must run strictly before builder.build(),
# otherwise a conflicting release version could silently rebuild/mutate artifacts.
# Match the REAL call on its own line (not the word inside the # comment) by char index.
gate_call_idx = source.index('check_source_release_version(SOURCE)')
build_match = re.search(r'(?m)^builder\.build\(\)\s*$', source)
assert build_match, 'real builder.build() not found'
build_call_idx = build_match.start()
assert gate_call_idx < build_call_idx, \
    'check_source_release_version(SOURCE) must run before builder.build() in verify-test-modules.py'

# Extract exactly the shared regex + the gate function (real code), skipping the
# whole top-level audit body so no builder import/build is triggered here.
start = source.index('VERSION_FIELD = re.compile')
end = source.index('check_source_release_version(SOURCE)')
namespace = {'re': re, 'Path': Path}
exec(source[start:end], namespace)  # defines VERSION_FIELD + check_source_release_version
check = namespace['check_source_release_version']

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

# Committed artifacts we must never mutate from a failed/conflicting gate.
protected = {
    ROOT / 'index-test.html': sha(ROOT / 'index-test.html'),
    ROOT / 'sw-test.js': sha(ROOT / 'sw-test.js'),
    ROOT / 'test-app/build-manifest.json': sha(ROOT / 'test-app/build-manifest.json'),
}

SPACED = "version: '4.2.0'"
COMPACT = "version:'4.1.6'"

def fixture_sources(history_first, test_release, header_version=None):
    """Build an isolated source/ tree with chosen release versions."""
    tmp = Path(tempfile.mkdtemp(prefix='samosval-source-gate-'))
    feats = tmp / 'features'
    feats.mkdir(parents=True)
    header = header_version if header_version is not None else '4.2.0'
    (tmp / 'shell.html').write_text(
        '<meta name="test-app-version" content="4.2.0">\n'
        '<span class="version-text">' + header + '</span>')
    (feats / 'test-release.js').write_text(
        "window.TEST_APP_RELEASE={version:%r};\n" % test_release)
    (feats / 'release-history.js').write_text(
        'const r=[' + history_first + ",{version:'4.1.5'},{version:'4.1.4'}];")
    return tmp

# 1) Agreed sources read cleanly and return the release version.
ok = fixture_sources(SPACED, '4.2.0')
assert check(ok) == '4.2.0'

# 2) First history record (spaced) disagrees with meta -> must raise BEFORE build.
bad_history = fixture_sources(COMPACT, '4.2.0')  # first history is 4.1.6
try:
    check(bad_history)
    raise SystemExit('FAIL: conflicting history not rejected')
except AssertionError:
    pass

# 3) test-release.js disagrees with shell meta -> must raise.
bad_runtime = fixture_sources(SPACED, '4.1.6')
try:
    check(bad_runtime)
    raise SystemExit('FAIL: conflicting runtime not rejected')
except AssertionError:
    pass

# 4) visible header disagrees with meta -> must raise.
bad_header = fixture_sources(SPACED, '4.2.0', header_version='4.1.6')
try:
    check(bad_header)
    raise SystemExit('FAIL: conflicting header not rejected')
except AssertionError:
    pass

# The gate is read-only and ran on fixtures only: committed artifacts unchanged.
for path, digest in protected.items():
    assert sha(path) == digest, 'Committed artifact mutated by source gate: ' + str(path)

print('PASS source gate: history/runtime/header conflicts rejected before build; '
      'agreed sources accepted; order gate<build; committed artifacts untouched')
