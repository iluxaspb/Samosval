#!/usr/bin/env python3
"""Apply ONLY approved paper-viewer + duplicate-label changes to a target tree.
Parent owns invoking this tool, versioning, build, CI, and publication.
It neither writes history/game files nor pulls in unrelated reliability changes.
"""
from pathlib import Path
import argparse,re,json,hashlib
PAYLOAD=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('target',type=Path);parser.add_argument('--production-only',action='store_true');parser.add_argument('--test-only',action='store_true');args=parser.parse_args()
root=args.target.resolve();result=[]
def duplicate_badges(text,expected):
 pattern=r'<span style="(color:red; (?:font-size:10px; font-weight:bold;|font-weight:900; font-size:12px; margin-left:4px;))">ДУБЛИКАТ</span>'
 changed,n=re.subn(pattern,lambda m:'<span style="'+m[1]+'" title="Дубликат" aria-label="Дубликат">D</span>',text)
 already=len(re.findall(r'<span style="color:red; (?:font-size:10px; font-weight:bold;|font-weight:900; font-size:12px; margin-left:4px;)" title="Дубликат" aria-label="Дубликат">D</span>',text))
 if n+already!=expected:raise ValueError(f'Expected {expected} controlled duplicate badges; got {n} old + {already} updated')
 return changed

def write(path,text):
 old=path.read_bytes();new=text.encode();
 if old!=new:path.write_bytes(new)
 result.append({'path':str(path.relative_to(root)),'changed':old!=new,'before_sha256':hashlib.sha256(old).hexdigest(),'after_sha256':hashlib.sha256(new).hexdigest()})
viewer=(PAYLOAD/'test-app/src/features/summary-viewer.js').read_text()
hold=(PAYLOAD/'test-app/src/features/summary-hold.js').read_text()
if not args.production_only:
 for name,count in [('core/13-reports.js',3),('core/14-archive.js',2)]:
  path=root/'test-app/src'/name;write(path,duplicate_badges(path.read_text(),count))
 for name,text in [('summary-viewer.js',viewer),('summary-hold.js',hold)]:write(root/'test-app/src/features'/name,text)
if not args.test_only:
 path=root/'index.html';source=path.read_text();counts={'summary':0,'archive':0,'hold':0}
 def replace_script(match):
  tag,code=match.group(1),match.group(2)
  if "const key = 'samosval:test:summary-viewer:v1'" in code or 'window.__paperSheetViewerInstalled' in code:
   counts['summary']+=1;return tag+viewer+'</script>'
  if 'window.__archiveSheetViewerInstalled' in code:
   counts['archive']+=1;return '<!-- Shared paper viewer is installed with Summary. -->'
  if "const button = document.getElementById('toggleReportBtn');" in code:
   counts['hold']+=1;return tag+hold+'</script>'
  return match.group(0)
 updated=re.sub(r'(<script\b[^>]*>)([\s\S]*?)</script>',replace_script,source)
 if counts['summary']!=1 or counts['hold']!=1 or counts['archive']>1:raise ValueError(f'Unexpected viewer script layout: {counts}')
 # New archive snapshot renderer already has its own D marker. The five legacy
 # controlled templates remain reachable for non-viewer export/report callers.
 updated=duplicate_badges(updated,6)
 write(path,updated)
print(json.dumps(result,ensure_ascii=False,indent=2))
