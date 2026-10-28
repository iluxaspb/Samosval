#!/usr/bin/env python3
"""Build/verify production sources. Default is a read-only integrity check."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'app' / 'src'
SPEC = ROOT / 'app' / 'modules.json'

def digest(contents):
    return hashlib.sha256(contents).hexdigest()

def render():
    spec = json.loads(SPEC.read_text(encoding='utf-8'))
    release = spec['release']
    shell = (SRC / 'shell.html').read_text(encoding='utf-8')
    sw_template = (SRC / 'service-worker.js').read_text(encoding='utf-8')
    if f'<meta name="app-version" content="{release}">' not in shell:
        raise ValueError('The shell release does not match app/modules.json')
    sources, combined = [], []
    for module in spec['modules']:
        if not module['file'].endswith('.js'):
            raise ValueError('Only classic JS modules are supported')
        pieces = [(SRC / path).read_bytes() for path in module['sources']]
        code = b''.join(pieces)
        sources.append((module, code))
        combined.append(module['file'].encode() + b'\0' + code)
    if release == spec['locked_release']:
        build = spec['locked_build']
    else:
        material = release.encode() + b'\0' + shell.encode() + b'\0' + sw_template.encode()
        material += b'\0'.join(combined)
        build = digest(material)[:16]
    generated = {}
    for module, code in sources:
        generated[f'app/build/{build}/{module["file"]}'] = code
        placeholder = '<!-- PROD-MODULE:' + module['name'] + ' -->'
        if shell.count(placeholder) != 1:
            raise ValueError('Missing or duplicate module marker: ' + module['name'])
        shell = shell.replace(placeholder, module['tag'].replace('{build}', build))
    if '<!-- PROD-MODULE:' in shell:
        raise ValueError('Unfilled production module marker')
    shell = shell.replace('__BUILD_VERSION__', build)
    generated['index.html'] = shell.encode('utf-8')
    records, seen = [], set()
    for item in spec['precache']:
        url = item.replace('{build}', build)
        if not url.startswith('./') or url in seen:
            raise ValueError('Invalid or duplicated cache path: ' + url)
        seen.add(url)
        path = url[2:]
        data = generated[path] if path in generated else (ROOT / path).read_bytes()
        records.append({'url': url, 'sha256': digest(data)})
    sw = sw_template.replace('__BUILD_VERSION__', build).replace(
        '__PRECACHE_RECORDS__', json.dumps(records, ensure_ascii=False, separators=(',', ':')))
    if '__BUILD_VERSION__' in sw or '__PRECACHE_RECORDS__' in sw:
        raise ValueError('Unfilled service worker marker')
    generated['sw.js'] = sw.encode('utf-8')
    manifest = {
        'version': build, 'release': release,
        'source_commit': spec['source_commit'],
        'source_test_build': spec['source_test_build'],
        'channel': spec['channel'], 'assets': records
    }
    generated['app/build-manifest.json'] = (
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    return spec, build, generated, len(records)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='Read-only verification (default)')
    parser.add_argument('--build', action='store_true', help='Build an explicitly versioned release')
    args = parser.parse_args()
    if args.check and args.build:
        parser.error('Choose one action')
    spec, build, generated, count = render()
    differences = [p for p, contents in generated.items()
                   if not (ROOT / p).is_file() or (ROOT / p).read_bytes() != contents]
    if args.build:
        if spec['release'] == spec['locked_release'] and differences:
            raise SystemExit('BLOCKED: Published release is locked. Bump its version first. Files: '
                             + ', '.join(differences))
        immutable = [p for p in differences
                     if p.startswith('app/build/') and (ROOT / p).exists()]
        if immutable:
            raise SystemExit('BLOCKED: Existing build files are immutable: ' + ', '.join(immutable))
        for path, contents in generated.items():
            output = ROOT / path
            output.parent.mkdir(parents=True, exist_ok=True)
            if not output.exists() or output.read_bytes() != contents:
                output.write_bytes(contents)
        print(f'BUILT production {spec["release"]}, build {build}; {count} cache assets')
    elif differences:
        raise SystemExit('MISMATCH: Source does not reproduce published build: '
                         + ', '.join(differences))
    else:
        print(f'PASS: production {spec["release"]}, build {build}: '
              f'{len(generated)} byte-identical files, {count} verified cache assets')

if __name__ == '__main__':
    main()
