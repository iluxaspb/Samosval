"""Prepare a Firebase rules review artifact only; never edit or deploy shared rules."""
import difflib
import re
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
out=HERE/'proposals'
out.mkdir(exist_ok=True)
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

print('Prepared Firebase rules proposal only; no deployed or protected rules changed.')
