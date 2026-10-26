"""Isolated rank UI fixture: actual production effect blocks, synthetic app state only.
No Firebase, network, balance, reward, or trip code is loaded or changed.
"""
from pathlib import Path

PRELUDE = r'''
(() => {
  'use strict';
  let fixtureActive=true, fixtureAdmin=true, fixtureHidden=false;
  let currentUid='fixture-user';
  let appConfig={testReviewFlags:{game_mode:true,game_sound:true,game_effects:true}};
  const levels=[{at:0,name:'🦺 Новичок на линии'},{at:25,name:'👀 Зоркий учётчик'},{at:100,name:'📋 Мастер отметок'},{at:500,name:'⚙️ Знаток фрезы'},{at:1000,name:'🏗️ Опора бригады'},{at:5000,name:'👑 Легенда фрезеровки'}];
  const enabled=()=>fixtureActive&&!!currentUid&&appConfig.testReviewFlags.game_mode!==false;
  const canAdmin=()=>fixtureAdmin&&fixtureActive&&!!currentUid;
  let rankNotice=null,rankNoticePreview=false,rankNoticeTimer=null;
  const applauseSources=new Set();
  let audioContext;
  const audit={sound:[], errors:[], nodes:[], requests:[]};
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>fixtureHidden});
  window.addEventListener('error',e=>audit.errors.push(String(e.error?.stack||e.message)));
  window.addEventListener('unhandledrejection',e=>audit.errors.push(String(e.reason?.stack||e.reason)));
  document.addEventListener('securitypolicyviolation',e=>audit.requests.push(e.blockedURI));
'''

POSTLUDE = r'''
  const originalSound=rankFireworkSound;
  rankFireworkSound=function(preview=false,kind='burst',pan=0,energy=1){
    audit.sound.push({at:performance.now(),kind,pan,energy});
    return originalSound(preview,kind,pan,energy);
  };
  async function unlock() {
    if(appConfig.testReviewFlags.game_sound===false)return;
    try {
      const Audio=window.AudioContext||window.webkitAudioContext;
      if(!Audio)return;
      audioContext=audioContext||new Audio();
      if(audioContext.state==='suspended')await audioContext.resume();
    } catch(e) { audit.optionalAudioError=String(e); }
  }
  function snapshot(){
    const el=document.getElementById('game-rank-celebration');
    const box=el?.getBoundingClientRect();
    return {
      notice:!!rankNotice, noticeConnected:!!rankNotice?.isConnected,
      preview:rankNoticePreview, timer:rankNoticeTimer!==null,
      canvas:!!rankFireworkCanvas, frame:rankFireworkFrame!==null,
      lifecycle:rankLifecycleTimer!==null, sources:applauseSources.size,
      nodes:rankAudioNodes.size, bus:!!rankAudioBus,
      noticeCount:document.querySelectorAll('#game-rank-celebration').length,
      canvasCount:document.querySelectorAll('#game-rank-fireworks').length,
      viewport:{width:innerWidth,height:innerHeight},
      rect:box?{x:box.x,y:box.y,width:box.width,height:box.height}:null,
      pointerEvents:el?getComputedStyle(el).pointerEvents:null,
      text:el?.textContent||'',sound:audit.sound,errors:audit.errors,requests:audit.requests,
      activeElement:document.activeElement?.id,audioState:audioContext?.state||'unavailable'
    };
  }
  async function show(index=3,preview=true){
    audit.sound.length=0;
    await unlock();
    showRankNotice(levels[index],preview);
    return snapshot();
  }
  function set(values={}){
    if('active' in values)fixtureActive=values.active;
    if('admin' in values)fixtureAdmin=values.admin;
    if('uid' in values)currentUid=values.uid;
    if('sound' in values)appConfig.testReviewFlags.game_sound=values.sound;
    if('effects' in values)appConfig.testReviewFlags.game_effects=values.effects;
    if('mode' in values)appConfig.testReviewFlags.game_mode=values.mode;
    if('hidden' in values){fixtureHidden=values.hidden;document.dispatchEvent(new Event('visibilitychange'));}
    if('tab' in values){document.querySelectorAll('.tab-content').forEach(el=>el.classList.toggle('active',el.id===values.tab));}
    return snapshot();
  }
  function clear(){dismissRankNotice();return snapshot();}
  async function offlineRender(mode='fireworks'){
    clear();
    // Acoustic rendering is isolated from the UI preference matrix.
    appConfig.testReviewFlags.game_sound=true;appConfig.testReviewFlags.game_effects=true;
    const Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext;
    if(!Offline)throw Error('OfflineAudioContext missing');
    const old=audioContext, rate=44100, duration=4.5;
    const context=new Offline(2,Math.ceil(rate*duration),rate);
    let offset=0;
    audioContext=new Proxy(context,{get(target,key){
      if(key==='state')return 'running';
      if(key==='currentTime')return offset;
      const value=Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value;
    }});
    const events=mode==='cue'?[{at:0,kind:'cue',pan:0,energy:.7}]:[
      {at:.02,kind:'launch',pan:-.78*.55,energy:.48},
      {at:.58,kind:'burst',pan:-.78*.55,energy:1},
      {at:.43,kind:'launch',pan:.85*.55,energy:.48},
      {at:.9795,kind:'burst',pan:.85*.55,energy:.85},
      {at:.85,kind:'launch',pan:-.8*.55,energy:.48},
      {at:1.3981,kind:'burst',pan:-.8*.55,energy:.83},
      {at:1.21,kind:'launch',pan:.35*.55,energy:.48},
      {at:1.7721,kind:'burst',pan:.35*.55,energy:1.03}
    ];
    try {
      for(const event of events){offset=event.at;originalSound(true,event.kind,event.pan,event.energy);}
      const rendered=await context.startRendering();
      const channels=Array.from({length:rendered.numberOfChannels},(_,i)=>rendered.getChannelData(i));
      let peak=0,sum=0,clipped=0,nonFinite=0,maxDelta=0;
      for(const data of channels){let prior=0;for(const sample of data){
        if(!Number.isFinite(sample)){nonFinite++;continue;}
        peak=Math.max(peak,Math.abs(sample));sum+=sample*sample;
        if(Math.abs(sample)>=.999)clipped++;
        maxDelta=Math.max(maxDelta,Math.abs(sample-prior));prior=sample;
      }}
      const windows=[];
      for(let start=0;start<rendered.length;start+=Math.ceil(rate*.05)){
        let power=0,count=0;
        for(const data of channels)for(let i=start;i<Math.min(rendered.length,start+Math.ceil(rate*.05));i++){power+=data[i]*data[i];count++;}
        windows.push({at:start/rate,rms:Math.sqrt(power/count)});
      }
      const bytes=new ArrayBuffer(44+rendered.length*channels.length*2),view=new DataView(bytes);
      const text=(at,value)=>{for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i));};
      text(0,'RIFF');view.setUint32(4,bytes.byteLength-8,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);
      view.setUint16(20,1,true);view.setUint16(22,channels.length,true);view.setUint32(24,rate,true);
      view.setUint32(28,rate*channels.length*2,true);view.setUint16(32,channels.length*2,true);view.setUint16(34,16,true);
      text(36,'data');view.setUint32(40,bytes.byteLength-44,true);
      for(let i=0;i<rendered.length;i++)for(let c=0;c<channels.length;c++){
        const sample=Math.max(-1,Math.min(1,channels[c][i]));
        view.setInt16(44+(i*channels.length+c)*2,Math.round(sample*(sample<0?32768:32767)),true);
      }
      let binary='';const array=new Uint8Array(bytes);
      for(let i=0;i<array.length;i+=8192)binary+=String.fromCharCode(...array.subarray(i,i+8192));
      return {mode,rate,duration,channels:channels.length,peak,rms:Math.sqrt(sum/(rendered.length*channels.length)),
        maxDelta,clipped,nonFinite,windows,events,wav:btoa(binary)};
    } finally {dismissRankNotice();audioContext=old;}
  }
  window.fixture={show,set,clear,snapshot,offlineRender,levels,
    showWithoutUnlock:(index=3,preview=true)=>{audit.sound.length=0;showRankNotice(levels[index],preview);return snapshot();},
    setSuspended:async value=>{if(audioContext){if(value)await audioContext.suspend();else await audioContext.resume();}return snapshot();}
  };
  document.getElementById('preview-rank').onchange=()=>show(Number(document.getElementById('preview-rank').value));
  document.getElementById('preview-again').onclick=()=>show(Number(document.getElementById('preview-rank').value));
  document.getElementById('fixture-sound').onchange=e=>set({sound:e.target.checked});
  document.getElementById('fixture-effects').onchange=e=>set({effects:e.target.checked});
  document.getElementById('work-action').onclick=()=>{document.getElementById('action-count').textContent=String(Number(document.getElementById('action-count').textContent)+1);};
})();
'''

SHELL = '''<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src blob:; connect-src 'none'; form-action 'none'; base-uri 'none'">
<title>САМОСВАЛ · Проверка поздравления</title><style>
*{box-sizing:border-box}body{margin:0;background:#0a101a;color:#dce4ee;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh}header{padding:20px 24px;border-bottom:1px solid #ffffff12;display:flex;align-items:center;justify-content:space-between;background:#111a27}.brand{font-size:14px;font-weight:850;letter-spacing:.14em;color:#f2c568}.wallet{border:1px solid #c59c454a;border-radius:10px;padding:7px 12px;font-weight:750;color:#f6d58e}.workspace{max-width:1040px;margin:34px auto;padding:0 24px}h1{font-size:24px;margin:0}p.sub{color:#8c9aaf;margin:4px 0 24px}.truck{border:1px solid #ffffff14;border-radius:18px;background:#121d2d;margin-bottom:14px;padding:20px;display:flex;align-items:center;justify-content:space-between}.truck b{display:block;font-size:18px}.truck small{color:#8c9aaf}button,select{font:inherit}.action{padding:10px 16px;border:0;border-radius:10px;background:#283c57;color:#edf4fe;cursor:pointer}.preview-tools{position:fixed;left:16px;bottom:16px;z-index:1;display:flex;flex-wrap:wrap;gap:8px;align-items:center;max-width:calc(100vw - 32px);padding:12px;border:1px solid #ffffff20;background:#111a27;border-radius:12px;font-size:12px}.preview-tools button,.preview-tools select{border:1px solid #ffffff20;border-radius:6px;background:#223048;color:#edf4fe;padding:6px}.preview-tools label{white-space:nowrap;color:#a9b7ca}.tab-content:not(.active){display:none}@media(max-width:600px){header{padding:16px}.workspace{padding:0 16px;margin-top:24px}h1{font-size:20px}.truck{padding:16px}.truck b{font-size:15px}.action{padding:10px;font-size:13px}.preview-tools{bottom:8px;left:8px;max-width:calc(100vw - 16px);font-size:11px}}
__STYLE__
</style></head><body><header><span class="brand">САМОСВАЛ</span><span class="wallet">🪙 500</span></header>
<main class="workspace"><section id="tab-main" class="tab-content active"><h1>Сегодня на линии</h1><p class="sub">Смена открыта · Дорожная бригада</p>
<div class="truck"><div><b>А 123 ВС · 178</b><small>В работе · Последняя ходка 12:45</small></div><button id="work-action" class="action">Погрузка</button></div>
<div class="truck"><div><b>В 456 АР · 178</b><small>На объекте · Готов к следующей ходке</small></div><span style="color:#79d6b4">На линии</span></div>
<div class="truck"><div><b>С 789 МК · 178</b><small>В работе · Смена 08:00 — 20:00</small></div><span style="color:#f1d186">В пути</span></div>
<span hidden id="action-count">0</span></section><section id="tab-other" class="tab-content"><h1>Сводка смены</h1></section></main>
<div class="preview-tools"><select id="preview-rank" aria-label="Ранг для предпросмотра"><option value="0">Новичок на линии</option><option value="1">Зоркий учётчик</option><option value="2">Мастер отметок</option><option value="3" selected>Знаток фрезы</option><option value="4">Опора бригады</option><option value="5">Легенда фрезеровки</option></select><button id="preview-again">Посмотреть</button><label><input id="fixture-sound" type="checkbox" checked> Звук</label><label><input id="fixture-effects" type="checkbox" checked> Эффекты</label></div>
<script>__SCRIPT__</script></body></html>'''


def build_fixture(source_root: Path) -> str:
    css = (source_root / 'rank-celebration.css').read_text()
    js = (source_root / 'rank-celebration.js').read_text()
    assert '</script' not in js.lower(), 'Unexpected script terminator in source block'
    return SHELL.replace('__STYLE__', css).replace('__SCRIPT__', PRELUDE + '\n' + js + '\n' + POSTLUDE)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent / 'results' / 'rank-preview.html')
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(build_fixture(args.source_root))
    print(args.output)
