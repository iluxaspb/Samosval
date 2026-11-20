import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const cdp=await import(process.env.PHONE_CDP_UNIT_MODULE||'./phone-cdp.mjs');
import {capturePhoneTelGeometry,assertPhoneTelGeometry} from './phone-form-qa.mjs';

test('navigation after evaluate never serializes or releases the old objectId',async()=>{
 const lifecycle=cdp.cdpLifecycle(),calls=[];
 await assert.rejects(cdp.evaluateCdp(async method=>{
  calls.push(method);lifecycle.event('Runtime.executionContextsCleared');
  return {result:{objectId:'old-private-handle'}};
 },'private-expression',lifecycle),e=>e.code==='QA_CONTEXT_CHANGED');
 assert.deepEqual(calls,['Runtime.evaluate']);
 assert.doesNotMatch(JSON.stringify(lifecycle.snapshot()),/private|objectId|expression/);
});

test('navigation during Promise await skips stale release without replaying action',async()=>{
 const lifecycle=cdp.cdpLifecycle(),calls=[];
 await assert.rejects(cdp.evaluateCdp(async method=>{
  calls.push(method);
  if(method==='Runtime.evaluate')return {result:{subtype:'promise',objectId:'old'}};
  lifecycle.event('Page.frameNavigated');return {result:{value:7}};
 },'action()',lifecycle),e=>e.code==='QA_CONTEXT_CHANGED');
 assert.deepEqual(calls,['Runtime.evaluate','Runtime.awaitPromise']);
});

test('protocol context loss before lifecycle event also skips stale release',async()=>{
 const calls=[],lost=Object.assign(Error('Cannot find context with specified id'),{code:-32000});
 await assert.rejects(cdp.evaluateCdp(async method=>{
  calls.push(method);if(method==='Runtime.evaluate')return {result:{subtype:'promise',objectId:'old'}};
  throw lost;
 },'action()'),e=>e===lost);
 assert.deepEqual(calls,['Runtime.evaluate','Runtime.awaitPromise']);
});

test('cleanup context error cannot mask the original product exception',async()=>{
 await assert.rejects(cdp.evaluateCdp(async method=>{
  if(method==='Runtime.evaluate')return {result:{subtype:'promise',objectId:'p'}};
  if(method==='Runtime.awaitPromise')return {exceptionDetails:{text:'product failure'}};
  throw Object.assign(Error('Cannot find context with specified id'),{code:-32000});
 },'action()'),/product failure/);
});

test('product exception accompanying navigation is not converted into a retry',async()=>{
 const lifecycle=cdp.cdpLifecycle();
 await assert.rejects(cdp.navigationProbe(expression=>cdp.evaluateCdp(async()=>{
  lifecycle.event('Runtime.executionContextsCleared');
  return {exceptionDetails:{text:'product failure during navigation'}};
 },expression,lifecycle),'read'),/product failure during navigation/);
});

test('only exact protocol context errors are retryable by read-only navigation probes',async()=>{
 const lost=Object.assign(Error('Cannot find context with specified id'),{code:-32000});
 assert.equal(await cdp.navigationProbe(async()=>{throw lost;},'read'),false);
 for(const error of [Error('Cannot find context with specified id'),Error('product failure'),Object.assign(Error('other protocol failure'),{code:-32000})]){
  await assert.rejects(cdp.navigationProbe(async()=>{throw error;},'read'),e=>e===error);
 }
 // Action evaluation itself must fail, never silently replay.
 let calls=0;
 await assert.rejects(cdp.evaluateCdp(async()=>{calls++;throw lost;},'action()'),e=>e===lost);
 assert.equal(calls,1);
});

test('lifecycle diagnostics are bounded and omit parameters, values and URLs',()=>{
 const lifecycle=cdp.cdpLifecycle();
 for(let i=0;i<300;i++)lifecycle.event('Runtime.executionContextsCleared');
 assert.equal(lifecycle.snapshot().length,160);
 assert.deepEqual(Object.keys(lifecycle.snapshot()[0]).sort(),['generation','method','phase']);
});

function geometryHarness(){
 const parent={parentElement:null};
 const link={parentElement:parent,getAttribute:()=> 'tel:+12025550100',getBoundingClientRect:()=>({left:20,top:100,right:68,bottom:144,width:48,height:44}),contains:node=>node===child};
 const child={};let hit=child;const styles=new Map();
 const context=vm.createContext({innerWidth:393,innerHeight:852,document:{querySelector:()=>link,elementFromPoint:()=>hit},getComputedStyle:node=>({display:'block',visibility:'visible',opacity:'1',pointerEvents:'auto',...styles.get(node)})});
 const capture=()=>JSON.parse(JSON.stringify(vm.runInContext(`(${capturePhoneTelGeometry.toString()})()`,context)));
 return {link,parent,styles,capture,setHit:value=>hit=value};
}

test('mobile tel facts require positive geometry, visible ancestors, viewport and actual hit target',()=>{
 const h=geometryHarness();assertPhoneTelGeometry(h.capture());
 assert.doesNotMatch(JSON.stringify(h.capture()),/tel:|120255|synthetic|href/);
 for(const style of [{display:'none'},{visibility:'hidden'},{opacity:'0'},{pointerEvents:'none'}]){
  h.styles.set(h.parent,style);assert.throws(()=>assertPhoneTelGeometry(h.capture()),/geometry/);
 }
 h.styles.clear();h.setHit({});assert.throws(()=>assertPhoneTelGeometry(h.capture()),/hit-test/);
 h.setHit(h.link);assertPhoneTelGeometry(h.capture());
 const valid=h.capture();
 for(const change of [{width:0},{height:0},{x:NaN},{inViewport:false},{expectedTel:false},{viewportWidth:1280},{present:false}])assert.throws(()=>assertPhoneTelGeometry({...valid,...change}));
 h.link.getBoundingClientRect=()=>({left:390,top:100,right:438,bottom:144,width:48,height:44});
 assert.throws(()=>assertPhoneTelGeometry(h.capture()),/geometry/);
});

test('stand starts login without Promise handle and enforces tel checks before and after reload',()=>{
 const stand=fs.readFileSync(new URL('./phone-stand-896.mjs',import.meta.url),'utf8');
 assert.match(stand,/void handleLogin\(\)/);
 assert.doesNotMatch(stand,/catch\{return false;\}\},'real logout navigation'/);
 assert.match(stand,/evidence\.telBeforeReload=[\s\S]*assertPhoneTelGeometry\(evidence\.telBeforeReload\)[\s\S]*Page.reload[\s\S]*evidence\.telAfterReload=[\s\S]*assertPhoneTelGeometry\(evidence\.telAfterReload\)/);
});
