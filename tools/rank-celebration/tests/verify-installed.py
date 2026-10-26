#!/usr/bin/env python3
"""Prove both installed runtime copies equal the exact fixture effect/style sources."""
import argparse,hashlib,json,re
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--assets',type=Path,default=Path(__file__).resolve().parents[1]);a=p.parse_args()
checks=[]
for name,kind,targets in [('rank-celebration.js','js',['index.html','test-app/src/features/game-coins-v2.js']),('rank-celebration.css','css',['index.html','test-app/src/styles/game-coins-style.css'])]:
 expected=(a.assets/name).read_text().strip();start=('  ' if kind=='js' else '')+'/* RANK CELEBRATION V2 START';end=('  ' if kind=='js' else '')+'/* RANK CELEBRATION V2 END */'
 for target in targets:
  source=(a.root/target).read_text()
  if target=='index.html':
   tag='script' if kind=='js' else 'style';ident='game-coins-v2' if kind=='js' else 'game-coins-style'
   source=re.search('<'+tag+' id="'+ident+'">(.*?)</'+tag+'>',source,re.S)[1]
  matches=re.findall(re.escape(start)+'.*?'+re.escape(end),source,re.S)
  assert len(matches)==1,(target,kind,'duplicate or missing block')
  assert matches[0].strip()==expected,(target,kind,'fixture and installed source differ')
  checks.append({'target':target,'kind':kind,'sha256':hashlib.sha256(expected.encode()).hexdigest(),'exact':True})
print(json.dumps({'status':'passed','checks':checks},indent=2))
