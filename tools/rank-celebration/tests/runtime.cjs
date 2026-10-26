'use strict';
// DOM + deterministic animation/audio-graph lifecycle checks. These are NOT a
// substitute for Chromium screenshots or OfflineAudioContext acoustic checks.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync(path.join(__dirname,'results/rank-preview.html'),'utf8');
const results=[];
function createFixture({audio='normal',reduced=false,canvas=true}={}){
  let now=0,id=0,draws=0,hidden=false;
  const queue=new Map(),errors=[],audioNodes=new Set(),audioContexts=[],sourceStarts=[];
  const schedule=(fn,delay=0)=>{const key=++id;queue.set(key,{at:now+Math.max(0,Number(delay)||0),fn});return key;};
  const advance=ms=>{const until=now+ms;let steps=0;
    while(true){const next=[...queue].filter(([,x])=>x.at<=until).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;
      if(++steps>20000)throw Error('Unbounded fixture timers');now=next[1].at;queue.delete(next[0]);next[1].fn();}
    now=until;
  };
  const stall=ms=>{now+=ms;let steps=0;while(true){const next=[...queue].filter(([,x])=>x.at<=now).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;if(++steps>20000)throw Error('Unbounded stalled timers');queue.delete(next[0]);next[1].fn();}};
  const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://local.example.invalid/',beforeParse(window){
    window.setTimeout=schedule;window.clearTimeout=key=>queue.delete(key);
    window.requestAnimationFrame=fn=>schedule(()=>fn(now),16);window.cancelAnimationFrame=key=>queue.delete(key);
    Object.defineProperty(window.performance,'now',{value:()=>now});
    window.matchMedia=()=>({matches:reduced,addEventListener(){},removeEventListener(){}});
    window.HTMLCanvasElement.prototype.getContext=()=>canvas?{setTransform(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){draws++;},fillRect(){draws++;},createRadialGradient(){return{addColorStop(){}};}}:null;
    class AudioNode{
      constructor(){this.connections=new Set();audioNodes.add(this);this.gain={value:0};this.frequency={value:0};this.Q={value:0};this.pan={value:0};this.threshold={value:0};this.knee={value:0};this.ratio={value:0};this.attack={value:0};this.release={value:0};}
      connect(node){this.connections.add(node);return node;}disconnect(){this.connections.clear();}
    }
    class Source extends AudioNode{
      constructor(context){super();this.context=context;this.ended=false;this.stopTimer=null;}
      start(at){this.started=at;sourceStarts.push({at,now});}
      stop(at=this.context.currentTime){if(this.ended)return;if(this.stopTimer!==null)queue.delete(this.stopTimer);this.stopTimer=schedule(()=>{this.ended=true;this.onended?.();},Math.max(0,(at-this.context.currentTime)*1000));}
    }
    class AudioContext{
      constructor(){if(audio==='denied')throw Error('Audio unavailable');this.state=audio==='suspended'?'suspended':'running';this.sampleRate=22050;this.destination=new AudioNode();audioContexts.push(this);}
      get currentTime(){return now/1000;}resume(){if(audio!=='suspended')this.state='running';return Promise.resolve();}
      createGain(){return new AudioNode();}createDynamicsCompressor(){return new AudioNode();}
      createBiquadFilter(){return new AudioNode();}createStereoPanner(){if(audio==='no-pan')return undefined;return new AudioNode();}
      createBuffer(channels,length,rate){const data=Array.from({length:channels},()=>new Float32Array(length));return{getChannelData:i=>data[i],sampleRate:rate,length};}
      createBufferSource(){return new Source(this);}
    }
    if(audio==='no-pan')AudioContext.prototype.createStereoPanner=undefined;
    window.AudioContext=audio==='missing'?undefined:AudioContext;
    window.addEventListener('error',e=>errors.push(String(e.error||e.message)));
  }});
  return {dom,w:dom.window,advance,stall,queue,errors,audioContexts,sourceStarts,get draws(){return draws;},audioNodes,setReduced(value){reduced=value;}};
}
function clean(f){const s=f.w.fixture.snapshot();for(const key of ['notice','noticeConnected','timer','canvas','frame','lifecycle','bus'])assert.equal(s[key],false,key);for(const key of ['sources','nodes','noticeCount','canvasCount'])assert.equal(s[key],0,key);assert.deepEqual(f.errors,[]);assert.equal(s.errors.length,0);}
async function run(name,fn){await fn();results.push({name,status:'passed'});console.log('PASS',name);}
(async()=>{
  await run('Happy path uses bounded rockets, particles, sounds and fully cleans itself',async()=>{
    const f=createFixture();await f.w.fixture.show(3);f.advance(2100);
    let s=f.w.fixture.snapshot();assert.equal(s.noticeCount,1);assert.equal(s.canvasCount,1);
    assert.equal(s.sound.filter(x=>x.kind==='launch').length,4);assert.equal(s.sound.filter(x=>x.kind==='burst').length,4);
    assert(s.sources<=4);assert(s.nodes<=4);assert(f.draws>500&&f.draws<100000,f.draws);
    for(let i=0;i<4;i++){const launch=s.sound.filter(x=>x.kind==='launch')[i],burst=s.sound.filter(x=>x.kind==='burst')[i];assert(burst.at>launch.at&&burst.at-launch.at>=500&&burst.at-launch.at<610);}
    f.advance(1800);clean(f);assert.equal(f.queue.size,0);assert.equal([...f.audioNodes].reduce((n,node)=>n+node.connections.size,0),0);f.dom.window.close();
  });
  await run('12 repeated previews leave a single card/canvas and no stale timer after dismissal',async()=>{
    const f=createFixture();for(let i=0;i<12;i++){await f.w.fixture.show(i%6);f.advance(75);assert.equal(f.w.fixture.snapshot().noticeCount,1);assert.equal(f.w.fixture.snapshot().canvasCount,1);}
    f.w.fixture.clear();f.advance(30);clean(f);assert.equal(f.queue.size,0);f.dom.window.close();
  });
  await run('Close control and Escape immediately clear visible/queued effects',async()=>{
    const f=createFixture();await f.w.fixture.show();f.advance(620);f.w.document.querySelector('.rank-dismiss').click();f.advance(10);clean(f);
    await f.w.fixture.show();f.advance(620);f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));f.advance(10);clean(f);f.dom.window.close();
  });
  for(const [name,change] of [['account change',{uid:'other'}],['revocation',{active:false}],['admin revocation',{admin:false}],['tab navigation',{tab:'tab-other'}],['hidden document',{hidden:true}]]){
    await run(name+' cancels card, canvas, sources and timers',async()=>{const f=createFixture();await f.w.fixture.show();f.advance(620);f.w.fixture.set(change);f.advance(120);clean(f);assert.equal(f.queue.size,0);f.dom.window.close();});
  }
  for(const event of ['pagehide','popstate','hashchange'])await run(event+' cleanup',async()=>{const f=createFixture();await f.w.fixture.show();f.advance(620);f.w.dispatchEvent(new f.w.Event(event));f.advance(10);clean(f);f.dom.window.close();});
  await run('Disabled sound stays silent while fireworks run',async()=>{const f=createFixture();f.w.fixture.set({sound:false});await f.w.fixture.show();f.advance(1200);const s=f.w.fixture.snapshot();assert(s.canvas);assert.equal(s.sources,0);assert.equal(s.nodes,0);assert.equal(s.bus,false);f.w.fixture.clear();f.advance(10);clean(f);f.dom.window.close();});
  await run('Disabled effects and reduced motion keep static card and one independent gentle cue',async()=>{
    for(const options of [{reduced:true},{effects:false}]){const f=createFixture(options);if(options.effects===false)f.w.fixture.set({effects:false});await f.w.fixture.show();f.advance(120);let s=f.w.fixture.snapshot();assert.equal(s.sources,1);assert.equal(s.sound.length,1);assert.equal(s.sound[0].kind,'cue');f.advance(1080);s=f.w.fixture.snapshot();assert(s.notice);assert(!s.canvas&&!s.frame);assert.equal(s.sources,0);assert.equal(s.nodes,0);assert(!f.w.document.querySelector('#game-rank-celebration').classList.contains('festive'));f.w.fixture.clear();f.advance(10);clean(f);f.dom.window.close();}
  });
  await run('Sound off suppresses gentle static cue for both reduced motion and effects off',async()=>{for(const options of [{reduced:true},{effects:false}]){const f=createFixture(options);f.w.fixture.set({sound:false,...(options.effects===false?{effects:false}:{})});await f.w.fixture.show();f.advance(500);const s=f.w.fixture.snapshot();assert(s.notice&&!s.canvas&&!s.bus);assert.equal(f.sourceStarts.length,0);f.w.fixture.clear();f.advance(10);clean(f);f.dom.window.close();}});
  await run('Disabling effects/sound mid-flight promptly disconnects audio graph',async()=>{const f=createFixture();await f.w.fixture.show();f.advance(620);assert(f.w.fixture.snapshot().sources>0);f.w.fixture.set({effects:false,sound:false});f.advance(120);let s=f.w.fixture.snapshot();assert(s.notice);assert(!s.canvas&&!s.frame&&!s.bus);assert.equal(s.sources,0);assert.equal(s.nodes,0);f.w.fixture.clear();f.advance(10);clean(f);f.dom.window.close();});
  for(const audio of ['missing','denied','no-pan'])await run(audio+' optional audio fallback never breaks the card',async()=>{const f=createFixture({audio});await f.w.fixture.show();f.advance(1250);assert(f.w.fixture.snapshot().notice);assert.equal(f.errors.length,0);f.w.fixture.clear();f.advance(30);clean(f);f.dom.window.close();});
  await run('Unavailable Canvas2D leaves readable notice and single independent gentle cue',async()=>{const f=createFixture({canvas:false});await f.w.fixture.show();f.advance(1250);const s=f.w.fixture.snapshot();assert(s.notice);assert(!s.canvas&&!s.frame);assert.equal(s.sound.length,1);assert.equal(s.sound[0].kind,'cue');assert.equal(f.sourceStarts.length,1);f.w.fixture.clear();f.advance(10);clean(f);f.dom.window.close();});
  await run('Regular rank notices honor game mode while authorized admin previews remain available',async()=>{const f=createFixture();f.w.fixture.set({mode:false});await f.w.fixture.show(3,false);clean(f);await f.w.fixture.show(3,true);assert(f.w.fixture.snapshot().notice);f.w.fixture.clear();f.advance(10);clean(f);f.dom.window.close();});
  await run('A delayed animation frame skips stale launch/burst audio instead of replaying it',async()=>{const f=createFixture();await f.w.fixture.show();f.stall(2300);f.advance(400);assert.equal(f.w.fixture.snapshot().sound.length,0);assert.equal(f.sourceStarts.length,0);f.advance(1000);clean(f);f.dom.window.close();});
  await run('Suspended AudioContext schedules no blast and does not replay after a late resume',async()=>{const f=createFixture({audio:'suspended'});await f.w.fixture.show();f.advance(2300);assert.equal(f.sourceStarts.length,0);assert.equal(f.w.fixture.snapshot().sources,0);for(const context of f.audioContexts)context.state='running';f.advance(1000);assert.equal(f.sourceStarts.length,0);f.advance(500);clean(f);f.dom.window.close();});
  await run('Muting stops active sound, and late unmute does not replay missed bursts',async()=>{const f=createFixture();await f.w.fixture.show();f.advance(620);assert(f.sourceStarts.length>0);const starts=f.sourceStarts.length;f.w.fixture.set({sound:false});f.advance(120);assert.equal(f.w.fixture.snapshot().sources,0);f.advance(1600);f.w.fixture.set({sound:true});f.advance(700);assert.equal(f.sourceStarts.length,starts);f.advance(700);clean(f);f.dom.window.close();});
  await run('Game mode switched off cancels a non-preview celebration',async()=>{const f=createFixture();await f.w.fixture.show(3,false);f.advance(620);f.w.fixture.set({mode:false});f.advance(120);clean(f);assert.equal(f.queue.size,0);f.dom.window.close();});
  await run('No active session or revoked admin cannot open preview',async()=>{const f=createFixture();f.w.fixture.set({active:false,admin:false});await f.w.fixture.show();clean(f);assert.equal(f.queue.size,0);f.dom.window.close();});
  const report={status:'passed',scope:'jsdom deterministic lifecycle/audio graph; not real browser rendering/audio',tests:results};fs.writeFileSync(path.join(__dirname,'results/runtime-report.json'),JSON.stringify(report,null,2));console.log(results.length+' lifecycle checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
