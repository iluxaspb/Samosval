'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const source=fs.readFileSync(path.join(root,'test-app/source/features/line-motion-test.js'),'utf8');
const shell=fs.readFileSync(path.join(root,'test-app/source/shell.html'),'utf8');
const hub=fs.readFileSync(path.join(root,'test-app/source/features/settings-hub.js'),'utf8');
assert.doesNotThrow(()=>new Function(source));
assert(shell.includes('content="3.4.30"'),'test shell must expose updated release');
assert(hub.includes("'soft-motion-spring-speed'"),'separate control stays in motion category');
assert(source.includes("prefs.springSpeed = Number.isFinite(p.springSpeed)"),'restores saved spring speed');
assert(source.includes("prefs.springSpeed=value;savePrefs()"),'spring speed change is persisted');
assert(source.includes("['1.0.0','1.1.0-test'].includes(old.version)"),'upgrades existing patch, never installs absent one');
const springBlock=source.slice(source.indexOf('  function springFrames(dx, dy) {'),source.indexOf('  // Follow the ARRIVING card'));
assert(springBlock.startsWith('  function springFrames'));
function samples(amplitude,speed){
 const spring=new Function('prefs',springBlock+';return springFrames')({spring:amplitude,springSpeed:speed});
 const frames=spring(0,170);
 assert.equal(frames.length,61);
 return frames.map(x=>Number(x.transform.split(',')[1].slice(0,-2)));
}
for(const speed of [0,50,100]) {
 const none=samples(0,speed);
 assert(Math.min(...none)>=0,'amplitude 0 must have no rebound');
 const medium=samples(50,speed), strong=samples(100,speed);
 assert(Math.min(...medium)<-8,'medium spring must be visible');
 assert(Math.min(...strong)<-20,'strong spring must be visible');
 assert(Math.min(...strong)>=-28.01,'bounce remains bounded');
 assert(Math.abs(strong.at(-1))<.001,'ends at exact final position');
}
const slow=samples(100,0),fast=samples(100,100);
assert(Math.abs(Math.min(...slow)-Math.min(...fast))<1,'speed cannot change spring amplitude');
assert(slow.indexOf(Math.min(...slow))>fast.indexOf(Math.min(...fast))+8,
 'speed changes the time of bounce, not the overall motion tempo');
const preview=source.slice(source.indexOf('    // A single, vertical demonstration lane'),source.indexOf('    const observer=new MutationObserver'));
assert(preview.includes('soft-preview-track')&&preview.includes('soft-preview-demo-card'),'single preview lane and card');
assert(preview.includes('springFrames(0,distance)'),'only Y moves in preview');
assert(!preview.includes('springFrames(dx,dy)'),'preview must not move in sideways directions');
assert(preview.includes('previewAnimations.forEach(a=>a.cancel())'),'repeated previews restart');
const followBlock=source.slice(source.indexOf('  function followArrival(card, duration) {'),source.indexOf('  const fresh = hint =>'));
assert(followBlock.startsWith('  function followArrival'));
assert(followBlock.includes("getElementById('mainHeader')")&&followBlock.includes("getElementById('bottomNav')"),
 'follow uses current sticky header and bottom navigation');
assert(!followBlock.includes('lastGesture < 800'),'arrival click must not suppress follow');
let now=0,nextFrame=null,frameCalls=0;
const duration=1680,finishY=250,travel=900,height=150;
const motion=new Function('prefs',springBlock+';return springFrames')({spring:60,springSpeed:50})(0,travel);
const yValue=k=>Number(motion[k].transform.split(',')[1].slice(0,-2));
function moveNow(){
 const x=Math.max(0,Math.min(60,(now/duration)*60)),before=Math.floor(x),after=Math.min(60,before+1);
 return yValue(before)+(yValue(after)-yValue(before))*(x-before);
}
const win={
 scrollY:700,
 scrollTo({top}){this.scrollY=top;}
};
const doc={
 hidden:false,documentElement:{scrollHeight:2400},
 getElementById(id){
  if(id==='mainHeader')return {getBoundingClientRect:()=>({bottom:155})};
  if(id==='bottomNav')return {getBoundingClientRect:()=>({top:742})};
  throw Error('Unexpected element '+id);
 }
};
const card={
 isConnected:true,offsetHeight:height,
 getBoundingClientRect(){
  const top=finishY+moveNow()-win.scrollY;
  return {top,bottom:top+height};
 }
};
const raf=callback=>{nextFrame=callback;frameCalls++;return frameCalls;};
const follow=new Function('window','document','performance','requestAnimationFrame','innerHeight','reduce',
 'let enabled=true,scrollFrame=0;'+followBlock+';return followArrival;')
 (win,doc,{now:()=>now},raf,800,{matches:false});
follow(card,duration);
assert(nextFrame,'arrival must trigger follow even after the operator just pressed Arrived');
for(now=16;now<=duration+210;now+=16){
 const cb=nextFrame;nextFrame=null;
 if(!cb)break;
 cb(now);
 const rect=card.getBoundingClientRect();
 if(win.scrollY>0 && win.scrollY<1600)
  assert(rect.top>=169-3,'moving card must not disappear behind status header at '+now+'ms');
}
const last=card.getBoundingClientRect();
assert(last.top>=170-3,'arrived truck remains below status bar');
assert(last.bottom<742-14+4,'arrived truck and Load button are above bottom navigation');
assert(win.scrollY<700,'focus followed the truck upwards instead of staying at bottom');
assert(frameCalls>20,'follows entire duration instead of a one-shot jump');
console.log('MOTION_3426_OK','bounce_speed_independent','vertical_preview','arrival_visible','scrollY='+win.scrollY.toFixed(0));
