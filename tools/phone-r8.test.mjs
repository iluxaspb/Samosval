import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {capturePhoneTelGeometry,assertPhoneTelGeometry} from './phone-form-qa.mjs';
import * as qa from './phone-form-qa.mjs';
import {until} from './phone-cdp.mjs';

function harness(){
 const ancestor={localName:'section',parentElement:null,id:'private-id',textContent:'private-text'};
 const expectedTel=capturePhoneTelGeometry.toString().match(/==='(tel:[^']+)'/)[1];
 const link={localName:'a',parentElement:ancestor,getAttribute:()=>expectedTel,getBoundingClientRect:()=>({left:20,top:100,right:168,bottom:120,width:148,height:20}),contains:()=>false};
 const styles=new Map();let animations=[];
 ancestor.getAnimations=()=>animations;link.getAnimations=()=>[];
 const context=vm.createContext({innerWidth:393,innerHeight:852,document:{querySelector:()=>link,elementFromPoint:()=>link},getComputedStyle:node=>({display:'block',visibility:'visible',opacity:'1',pointerEvents:'auto',...styles.get(node)})});
 return {ancestor,link,styles,setAnimations:value=>animations=value,capture:()=>JSON.parse(JSON.stringify(vm.runInContext(`(${capturePhoneTelGeometry.toString()})()`,context)))};
}

test('safe ancestor diagnostics identify opacity/display/visibility and animation without raw values',()=>{
 const h=harness();
 h.styles.set(h.ancestor,{opacity:'0'});h.setAnimations([{playState:'running',pending:true,animationName:'private-name'}]);
 const facts=h.capture();
 assert.equal(facts.visible,false);assert.equal(facts.hitTarget,true);
 assert.deepEqual(facts.visibilityBlockers,[{depth:1,elementType:'section',displayNone:false,visibilityHidden:false,visibilityCollapse:false,opacityZero:true}]);
 assert.equal(facts.activeAnimations,1);
 assert.throws(()=>assertPhoneTelGeometry(facts));
 assert.doesNotMatch(JSON.stringify(facts),/private|tel:|120255|animationName/);
 for(const [style,flag] of [[{display:'none'},'displayNone'],[{visibility:'hidden'},'visibilityHidden'],[{visibility:'collapse'},'visibilityCollapse']]){
  h.styles.set(h.ancestor,style);assert.equal(h.capture().visibilityBlockers[0][flag],true);
 }
 h.ancestor.localName='private-custom-element';assert.equal(h.capture().visibilityBlockers[0].elementType,'other');
 h.styles.clear();h.setAnimations([]);assert.deepEqual(h.capture().visibilityBlockers,[]);
});

test('wait polls fresh geometry until ancestor animation finishes AND unchanged visible gate passes',async()=>{
 const h=harness();let polls=0;const observed=[];
 h.styles.set(h.ancestor,{opacity:'0'});h.setAnimations([{playState:'running'}]);
 const wait=async(fn,label)=>{
  assert.equal(label,'mobile Line tel settled');
  assert.equal(await fn(),false);polls++;
  h.styles.clear();assert.equal(await fn(),false);polls++;
  h.setAnimations([{playState:'finished'}]);assert.equal(await fn(),true);polls++;
 };
 const result=await qa.waitPhoneTelGeometry(async()=>h.capture(),f=>observed.push(f),wait);
 assert.equal(polls,3);assert.equal(observed.length,3);assertPhoneTelGeometry(result);
});

test('persistent hidden and stuck animation fail within existing polling deadline and retain last facts',async()=>{
 for(const kind of ['hidden','animation']){
  const h=harness();let last;
  if(kind==='hidden')h.styles.set(h.ancestor,{opacity:'0'});
  else h.setAnimations([{playState:'running'}]);
  await assert.rejects(qa.waitPhoneTelGeometry(async()=>h.capture(),f=>last=f,(fn,label)=>until(fn,label,1)),/Timeout: mobile Line tel settled/);
  assert.ok(last);
  if(kind==='hidden'){assert.equal(last.visible,false);assert.throws(()=>assertPhoneTelGeometry(last));}
  else assert.equal(last.activeAnimations,1);
 }
});

test('read failures are not converted into readiness and both stand checks use bounded helper',async()=>{
 const failure=Error('read failure');
 await assert.rejects(qa.waitPhoneTelGeometry(async()=>{throw failure;},()=>{},fn=>fn()),e=>e===failure);
 const stand=fs.readFileSync(new URL('./phone-stand-896.mjs',import.meta.url),'utf8');
 for(const key of ['telBeforeReload','telAfterReload'])assert.ok(stand.includes(`facts=>{evidence.${key}=facts;},until`));
 const css=fs.readFileSync(new URL('../working-test/source/styles/style-04.css',import.meta.url),'utf8');
 assert.match(css,/\.tab-content\.active\s*\{[^}]*animation: tabFadeSlide 0\.32s/);
 assert.match(css,/@keyframes tabFadeSlide \{ from \{ opacity: 0;[^}]*\} to \{ opacity: 1;/);
});
