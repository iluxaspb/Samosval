#!/usr/bin/env python3
"""Strict, local-only presentation patch. Never builds/releases or touches economics.

Usage: python tools/apply-celebration.py --root REPO --apply
Defaults to dry-run and writes nothing. Assets may be kept beside this script or
passed with --assets. An invariance proof is mandatory before any write.
"""
import argparse, hashlib, json, re
from pathlib import Path

START='  /* RANK CELEBRATION V2 START'
END='  /* RANK CELEBRATION V2 END */'
STYLE_START='/* RANK CELEBRATION V2 START'
STYLE_END='/* RANK CELEBRATION V2 END */'

def digest(s): return hashlib.sha256(s.encode()).hexdigest()
def replace_once(s, pattern, replacement, label):
    out,n=re.subn(pattern,lambda _:replacement,s,flags=re.S)
    if n!=1: raise ValueError(f'{label}: expected 1 scoped block, found {n}')
    return out

def strip_js(s):
    # The existing sound switch keeps its key/behavior; only its visible noun changes.
    s=s.replace('Игровые звуки: монеты и аплодисменты','Игровые звуки: монеты и салют')
    if START in s:
        return replace_once(s,re.escape(START)+r'.*?'+re.escape(END)+r'\n','', 'new celebration')
    s=replace_once(s,r'  function dismissRankNotice\(\)\{.*?\n  \}\n','', 'old dismiss')
    s=replace_once(s,r'  let rankFireworkCanvas=null,rankFireworkFrame=null;\n.*?(?=  function showPendingRank\(\))','', 'old effects/audio')
    return replace_once(s,r'  function showRankNotice\(milestone,preview=false\)\{.*?\n  \}\n','', 'old notice')

def transform_js(s,block):
    if START in s:
        out=replace_once(s,re.escape(START)+r'.*?'+re.escape(END),block.rstrip(),'update celebration')
    else:
        # Keep rank marker/queue/reward/coin-flight and even cancelRankCelebration byte-exact.
        out=replace_once(s,r'  function dismissRankNotice\(\)\{.*?\n  \}\n',block.rstrip()+'\n','insert celebration')
        out=replace_once(out,r'  let rankFireworkCanvas=null,rankFireworkFrame=null;\n.*?(?=  function showPendingRank\(\))','', 'remove old effects/audio')
        # The new block contains showRankNotice too: only remove the original body.
        old=r'  function showRankNotice\(milestone,preview=false\)\{\n    dismissRankNotice\(\);\n    const el=.*?\n  \}\n'
        out=replace_once(out,old,'','remove old notice')
    out=out.replace('Игровые звуки: монеты и аплодисменты','Игровые звуки: монеты и салют')
    assert strip_js(s)==strip_js(out),'NON-PRESENTATION JAVASCRIPT CHANGED'
    return out

def strip_css(s):
    if STYLE_START in s:return replace_once(s,re.escape(STYLE_START)+r'.*?'+re.escape(STYLE_END)+r'\n','', 'new style')
    return replace_once(s,r'#game-rank-celebration\{.*?(?=#disabledScreen\{)','','old style')

def transform_css(s,block):
    if STYLE_START in s:out=replace_once(s,re.escape(STYLE_START)+r'.*?'+re.escape(STYLE_END),block.rstrip(),'update style')
    else:out=replace_once(s,r'#game-rank-celebration\{.*?(?=#disabledScreen\{)',block.rstrip()+'\n','new style')
    assert strip_css(s)==strip_css(out),'NON-PRESENTATION CSS CHANGED'
    return out

def transform_html(s,js,css):
    m=re.search(r'(<script id="game-coins-v2">)(.*?)(</script>)',s,re.S)
    if not m:raise ValueError('production game-coins-v2 not found')
    out=s[:m.start(2)]+transform_js(m[2],js)+s[m.end(2):]
    m=re.search(r'(<style id="game-coins-style">)(.*?)(</style>)',out,re.S)
    if not m:raise ValueError('production game-coins-style not found')
    out=out[:m.start(2)]+transform_css(m[2],css)+out[m.end(2):]
    def mask(doc):
        doc=replace_once(doc,r'(<script id="game-coins-v2">).*?(</script>)','SCRIPT','mask script')
        return replace_once(doc,r'(<style id="game-coins-style">).*?(</style>)','STYLE','mask style')
    assert mask(s)==mask(out),'PRODUCTION OUTSIDE EFFECTS MODULES CHANGED'
    return out

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--assets',type=Path,default=Path(__file__).parent);p.add_argument('--apply',action='store_true');p.add_argument('--proof',type=Path)
    a=p.parse_args();js=(a.assets/'rank-celebration.js').read_text();css=(a.assets/'rank-celebration.css').read_text()
    plan=[('index.html',lambda s:transform_html(s,js,css)),('test-app/src/features/game-coins-v2.js',lambda s:transform_js(s,js)),('test-app/src/styles/game-coins-style.css',lambda s:transform_css(s,css))]
    output=[];proof={'scope':'celebration presentation + exact sound-switch display label only','applied':a.apply,'files':[]}
    for rel,transform in plan:
        file=a.root/rel;s=file.read_text();out=transform(s);output.append((file,out));proof['files'].append({'path':rel,'before':digest(s),'after':digest(out),'nonPresentationByteIdentical':True,'changed':s!=out})
    # All three invariance checks pass before the first write.
    if a.apply:
        for file,out in output:file.write_text(out)
    if a.proof:a.proof.write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(proof,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
