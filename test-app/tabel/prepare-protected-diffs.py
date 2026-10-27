"""Prepare a review artifact only. Never write to the protected targets."""
import difflib
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
old = (ROOT / 'test-app/build-manifest.json').read_text()
data = json.loads(old)
assets = data['assets']
for record in assets:
    if record['url'] in ['./test-app/src/features/timesheet-core.js', './test-app/src/features/timesheet-app.js']:
        record['sha256'] = sha(ROOT / record['url'])
for file in sorted([*HERE.glob('*.mjs'), HERE / 'tabel.css']):
    url = './' + str(file.relative_to(ROOT))
    record = {'url': url, 'sha256': sha(file)}
    existing = next((r for r in assets if r['url'] == url), None)
    if existing:
        existing.update(record)
    else:
        assets.append(record)
version = 'tabel-' + hashlib.sha256(json.dumps(assets,sort_keys=True).encode()).hexdigest()[:16]
data['version'] = version
data['channel'] = 'test-tabel-1.0.0-test.1-proposal-only'
new = json.dumps(data,indent=2)+'\n'
old_sw = (ROOT / 'sw-test.js').read_text()
new_sw = re.sub(r"const VERSION = '[^']+';", "const VERSION = '"+version+"';", old_sw)
new_sw = re.sub(r'^const RECORDS = .*;$', lambda m:'const RECORDS = '+json.dumps(assets,separators=(',',':'))+';', new_sw, flags=re.M)
out = HERE / 'proposals'
out.mkdir(exist_ok=True)
patch = ''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/test-app/build-manifest.json',tofile='b/test-app/build-manifest.json'))
patch += ''.join(difflib.unified_diff(old_sw.splitlines(True),new_sw.splitlines(True),fromfile='a/sw-test.js',tofile='b/sw-test.js'))
(out / 'pwa-cache-NOT-APPLIED.patch').write_text(patch)
(out / 'sw-test.CANDIDATE.js').write_text(new_sw)
(out / 'build-manifest.CANDIDATE.json').write_text(new)

# Proposed rules stay inside this module as review/emulator artifacts.
# The protected rules file is only read. Legacy validation is retained.
rules_old = (ROOT / 'firestore-timesheet-test.rules').read_text()
sandbox = (HERE / 'firestore.sandbox.rules').read_text()
helpers = sandbox[sandbox.index('    function tab()'):sandbox.index('    match /workspaces/main_workspace/{c}/{id}')]
helpers = helpers.replace("['timesheetObjects','timesheetSheets','timesheetDays','timesheetValues','timesheetEntries']", "['timesheetObjects','timesheetSheets','timesheetDays','timesheetValues']")
names = ['tab','hostEdit','config','grant','readArea','writeArea','known','dataValid','matchingChange','envelope','receiptChange']
for name in names:
    helpers = re.sub(r'\b'+name+r'(?=\()', 'tabel'+name[0].upper()+name[1:], helpers)
match = sandbox[sandbox.index('    match /workspaces/main_workspace/{c}/{id}'):sandbox.index('    match /workspaces/main_workspace/timesheetChanges/{id}')]
match = match.replace('match /workspaces/main_workspace/{c}/{id}', 'match /{c}/{id}')
for name in names:
    match = re.sub(r'\b'+name+r'(?=\()', 'tabel'+name[0].upper()+name[1:], match)
rules_new = rules_old.replace("'timesheetMaterials','timesheetChanges']", "'timesheetMaterials','timesheetChanges','timesheetObjects','timesheetSheets','timesheetDays','timesheetValues']")
rules_new = rules_new.replace("['timesheetPeople','timesheetEquipment','timesheetEntries','timesheetMaterials'];", "['timesheetPeople','timesheetEquipment','timesheetEntries','timesheetMaterials','timesheetObjects','timesheetSheets','timesheetDays','timesheetValues'];")
insert = '''
      // Object grants apply to configured objects; legacy objects retain existing rules.
      function tabelLegacyView(d,area) {
        return !exists(/databases/$(database)/documents/workspaces/main_workspace/timesheetObjects/$(d.objectId))
          || tabelGrant(d.objectId,area+'.view') || tabelGrant(d.objectId,'table.view');
      }
      function tabelLegacyWrite(d,area) {
        return !exists(/databases/$(database)/documents/workspaces/main_workspace/timesheetObjects/$(d.objectId))
          || tabelGrant(d.objectId,area+'.edit');
      }
'''
rules_new = rules_new.replace('      // Field ledger: enabled only', helpers + match + insert + '\n      // Field ledger: enabled only', 1)
for collection,area in [('timesheetEntries','shift'),('timesheetMaterials','materials')]:
    start = rules_new.index('      match /'+collection+'/{id} {')
    end = rules_new.index('\n      }',start)+len('\n      }')
    block = rules_new[start:end]
    block = block.replace('allow read: if ledgerRead();', "allow read: if ledgerRead() && (!exists(/databases/$(database)/documents/workspaces/main_workspace/"+collection+"/$(id)) || tabelLegacyView(resource.data,'"+area+"'));")
    extra = " && tabelLegacyWrite(request.resource.data,'"+area+"')"
    if collection == 'timesheetEntries':
        extra += " && tabelLegacyWrite(request.resource.data,request.resource.data.kind == 'person' ? 'people' : 'equipment')"
    block = block.replace('if ledgerEdit() &&', 'if ledgerEdit()'+extra+' &&')
    rules_new = rules_new[:start]+block+rules_new[end:]
(out / 'firebase-integration-NOT-APPLIED.patch').write_text(''.join(difflib.unified_diff(rules_old.splitlines(True),rules_new.splitlines(True),fromfile='a/firestore-timesheet-test.rules',tofile='b/firestore-timesheet-test.rules')))
(out / 'firestore.integrated-emulator.rules').write_text(rules_new)

builder_old = (ROOT / 'tools/build-test.py').read_text()
builder_new = builder_old.replace(
    "    build_id = sha(b''.join",
    "    inputs += [APP / 'src/features/timesheet-core.js', APP / 'src/features/timesheet-app.js']\n"
    "    inputs += sorted((APP / 'tabel').glob('*.mjs')) + [APP / 'tabel/tabel.css']\n"
    "    build_id = sha(b''.join", 1)
builder_new = builder_new.replace(
    "    records = [{'url':",
    "    assets += sorted((APP / 'tabel').glob('*.mjs')) + [APP / 'tabel/tabel.css']\n"
    "    assets = list(dict.fromkeys(assets))\n"
    "    records = [{'url':", 1)
(out / 'test-builder-NOT-APPLIED.patch').write_text(''.join(difflib.unified_diff(builder_old.splitlines(True),builder_new.splitlines(True),fromfile='a/tools/build-test.py',tofile='b/tools/build-test.py')))
print(json.dumps({'proposal_only':True,'targets':['sw-test.js','test-app/build-manifest.json'],'version':version,'new_assets':len(assets)}))
