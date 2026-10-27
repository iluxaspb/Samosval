"""Pin the deployed TEST policy to its actual server backup outside ledger integration."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parents[2]
p=root/'test-app/tabel/proposals'
before=(p/'firestore.live-before-20261027.rules').read_text()
after=(root/'firestore-timesheet-test.rules').read_text()
start='      match /{collection}/{id} {'
end='      match /trucks/{id} {'
a,z=before.index(start),before.index(end)
assert after[:a]==before[:a], 'Identity/settings/owner/coin helper changed'
assert after[after.index(end):]==before[z:], 'Line/trips/audit/coins/notifications changed'
assert after==(p/'firestore.live-integrated.rules').read_text(), 'Canonical and published candidate differ'
for action in ['read','write']:
 assert 'allow '+action+": if collection != 'coinTransactions' && !(collection in " in after
m=json.loads((p/'firebase-live-deployment.json').read_text())
assert hashlib.sha256(before.encode()).hexdigest()==m['beforeSha256']
assert hashlib.sha256(after.encode()).hexdigest()==m['proposedSha256']
assert m['projectId']=='samosval-offline'
print('PASS actual live baseline preserved outside explicit ledger integration, coin fallback exclusion, canonical/candidate SHA256 match')
