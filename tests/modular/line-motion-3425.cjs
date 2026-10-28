'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const source=fs.readFileSync(path.join(root,'test-app/source/features/line-motion-test.js'),'utf8');
const hub=fs.readFileSync(path.join(root,'test-app/source/features/settings-hub.js'),'utf8');
const modules=JSON.parse(fs.readFileSync(path.join(root,'test-app/modules.json'),'utf8'));
assert.doesNotThrow(()=>new Function(source),'test-only motion script syntax');
const module=modules.modules.find(m=>m.name==='settings-hub');
assert(module.sources.includes('features/line-motion-test.js'),'physics runs in the hashed offline settings module');
assert(source.includes("if(!old||old.version!=='1.0.0')return;"),'only upgrade existing motion patch');
assert(source.includes("if(window.__lineSoftMotionV1?.version!=='1.1.0-test')"),'upgrade version is verified');
assert(source.includes("localStorage.getItem(KEY) !== 'off'"),'user-disabled animation remains disabled');
assert(!hub.includes('extendCalmTempo'),'obsolete slider shim must not overwrite new controls');
// Extract functions from shipped script; test the actual arithmetic, independently of Firebase.
const paceStart=source.indexOf('    function paceForSlider(position) {');
const paceEnd=source.indexOf("    newRange(motion,'soft-motion-pace'",paceStart);
assert(paceStart>0&&paceEnd>paceStart,'speed mapping functions found');
const pace=new Function(source.slice(paceStart,paceEnd)+';return {paceForSlider,sliderForPace};')();
function approx(actual,expected,tolerance=.001){assert(Math.abs(actual-expected)<tolerance,actual+' !== '+expected);}
approx(pace.paceForSlider(0),7.2);approx(pace.paceForSlider(70),1);approx(pace.paceForSlider(100),.7);
for(const value of [.7,1,1.4,2.4,4,7.2])approx(pace.paceForSlider(pace.sliderForPace(value)),value);
const start=source.indexOf('  function springFrames(dx, dy) {');
const end=source.indexOf('  function followArrival(card, duration) {',start);
assert(start>0&&end>start,'spring function found');
function yCoords(strength){
 const spring=new Function('prefs',source.slice(start,end)+';return springFrames;')({spring:strength});
 return spring(0,170).map(frame=>{
  const pieces=frame.transform.split(',');
  assert(pieces.length===3&&pieces[1].endsWith('px'),'frame has vertical translation');
  return Number(pieces[1].slice(0,-2));
 });
}
const off=yCoords(0),soft=yCoords(50),strong=yCoords(100);
approx(off[0],170);approx(off.at(-1),0);approx(strong.at(-1),0);
assert(Math.min(...off)>=0,'spring off has no overshoot');
assert(Math.min(...soft)<-3,'medium spring rebounds');
assert(Math.min(...strong)<-12,'strong spring visibly rebounds');
assert(Math.min(...strong)>=-28.01,'strong rebound stays within 28px');
assert(source.includes('previewAnimations.forEach(a=>a.cancel());previewAnimations=[];'),'preview restarts');
assert(source.includes('preview.clientWidth'),'preview bounds follow its container');
console.log('MOTION_3425_OK','slow=7.2x','fast=0.7x','spring_min='+Math.min(...strong).toFixed(1)+'px');
