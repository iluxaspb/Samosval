#!/usr/bin/env python3
"""Package reviewable, checksummed TEST bootstrap. Excludes credentials and live data."""
from pathlib import Path
import hashlib,subprocess,zipfile,sys
root=Path(__file__).resolve().parents[2]
server=root/'server'
output=Path(sys.argv[1]).resolve()
files={str(p.relative_to(server)):p.read_bytes() for p in sorted((server/'src').glob('*.mjs'))}
files.update({str(p.relative_to(server)):p.read_bytes() for p in sorted((server/'updater').iterdir()) if p.is_file()})
files['sql/013_server_control.sql']=(server/'sql/013_server_control.sql').read_bytes()
files['sql/014_reserve_outbox.sql']=(server/'sql/014_reserve_outbox.sql').read_bytes()
files['compose.control.test.yaml']=(server/'compose.control.test.yaml').read_bytes()
files['baseline.json']=subprocess.check_output(['node',str(server/'scripts/prepare-control-release.mjs'),'--baseline'],cwd=root)
files['SHA256SUMS']=''.join(hashlib.sha256(b).hexdigest()+'  '+name+'\n' for name,b in files.items()).encode()
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as z:
    for name,b in files.items():z.writestr(name,b)
print('BOOTSTRAP_PACKAGE',len(files),'files',output.stat().st_size,'bytes')
