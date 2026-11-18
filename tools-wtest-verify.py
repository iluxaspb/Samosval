#!/usr/bin/env python3
"""Сверка RECORDS в wtest/sw-working-test.js с файлами на диске."""
import hashlib, json, os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
WT = os.path.join(ROOT, 'wtest')
sw = open(os.path.join(WT, 'sw-working-test.js'), encoding='utf-8').read()
m = re.search(r'const RECORDS = (\[.*?\]);', sw, re.S)
records = json.loads(m.group(1))
bad = 0
for r in records:
    p = os.path.join(WT, r['url'][2:])
    if not os.path.isfile(p):
        print('ОТСУТСТВУЕТ:', r['url']); bad += 1; continue
    if not r['sha256']:
        print('ПУСТОЙ SHA256:', r['url']); bad += 1; continue
    h = hashlib.sha256(open(p, 'rb').read()).hexdigest()
    if h != r['sha256']:
        print('НЕ СОВПАДАЕТ:', r['url']); bad += 1
print(f'records={len(records)} discrepancies={bad}')
sys.exit(1 if bad else 0)
