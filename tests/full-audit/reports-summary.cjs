'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const read=file=>fs.readFileSync('test-app/src/'+file,'utf8');
const viewer=read('features/summary-viewer.js'),shell=read('shell.html');
const reportMarkup=shell.slice(shell.indexOf('<div id="tab-report"'),shell.indexOf('<div id="tab-archive"'));
assert.match(reportMarkup,/<div id="tab-report"[^>]*>\s*<div id="paperReportWrapper">/,'regular sheet is the current first child, not a removed toolbar');
assert(!viewer.includes('#tab-report > div:first-child'),'viewer must not hide the actual regular sheet');
assert(viewer.includes('#tab-report > .action-row {display:none!important}'),'minimal fix must not re-expose legacy PDF/MAX controls');
assert(viewer.includes('#pluginPdfButtonsContainer {display:none!important}'),'legacy plugin PDF controls remain hidden');
assert(viewer.includes("e.target.closest('.paper-scroll-wrapper')"),'actual sheets remain viewer entry points');
assert(viewer.includes('summary-sheet-dialog')&&viewer.includes('archive-sheet-dialog'),'both full-screen viewers retained');
assert.match(reportMarkup,/<div id="gaiReportToggleContainer"[^>]*justify-content:flex-end/,'small paper toggle remains below sheets at the right');
assert.match(reportMarkup,/<button[^>]*width:44px[^>]*height:44px[^>]*id="toggleReportBtn"[^>]*>📄<\/button>/,'paper icon kept small without replacing the familiar control');

let now=0,seq=0,calls=0;const timers=new Map(),nodes=new Map(),documentEvents=new Map(),windowEvents=new Map(),errors=[];
function listen(map,name,fn){if(!map.has(name))map.set(name,[]);map.get(name).push(fn);}
function node(id){if(!nodes.has(id))nodes.set(id,{id,style:{},attributes:{},events:new Map(),isConnected:true,visible:true,
 setAttribute(k,v){this.attributes[k]=String(v);},classList:{add(){},remove(){}},
 addEventListener(name,fn){listen(this.events,name,fn);},setPointerCapture(){},
 getClientRects(){return this.visible?[{}]:[];},getBoundingClientRect(){return {left:200,right:244,top:0,bottom:44};}});return nodes.get(id);}
const trucks=[{id:'regular',brand:'Regular truck',number:'R',isGAI:false},{id:'gai',brand:'GAI truck',number:'G',isGAI:true}];
const logs=trucks.map((t,i)=>({id:'log'+i,truckId:t.id,truckName:t.brand,volume:10,isGAI:t.isGAI,timeStr:'10:0'+i,timestamp:i+1,createdBy:'User'}));
const c={console,state:{shift:{id:'shift',objectName:'Object',startDate:'26.10.2026'},truckStatus:{}},showGAITable:false,
 hasTabAccess:()=>true,hasPermission:()=>true,showError:e=>errors.push(e),getLogs:()=>logs,getActiveLineIds:()=>trucks.map(t=>t.id),
 findTruck:id=>trucks.find(t=>t.id===id),escapeHtml:s=>String(s??''),renderRussianPlate:s=>s,resolveUserDisplayName:()=>'',truckLabelHtml:()=>'',
 setTimeout:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id),
 document:{hidden:false,getElementById:node,addEventListener:(name,fn)=>listen(documentEvents,name,fn)},addEventListener:(name,fn)=>listen(windowEvents,name,fn)};
c.window=c;vm.createContext(c);vm.runInContext(read('core/13-reports.js'),c);
const toggle=c.toggleReportType;c.toggleReportType=()=>{calls++;toggle();};vm.runInContext(read('features/summary-hold.js'),c);
function fire(map,name,detail={}){const e={type:name,isPrimary:true,button:0,pointerId:1,clientX:220,clientY:22,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...detail};for(const fn of map.get(name)||[])fn(e);return e;}
const button=node('toggleReportBtn'),press=detail=>fire(button.events,'pointerdown',detail),release=()=>fire(button.events,'pointerup');
function tick(ms){const end=now+ms;while(true){const entry=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;now=entry[1].at;timers.delete(entry[0]);entry[1].fn();}now=end;}
function regular(){assert.equal(node('paperReportWrapper').style.display,'block');assert.equal(node('gaiReportWrapper').style.display,'none');assert(node('matrixTableBody').innerHTML.includes('Regular truck'));assert(node('gaiTableBody').innerHTML.includes('GAI truck'));}
function gai(){assert.equal(node('paperReportWrapper').style.display,'none');assert.equal(node('gaiReportWrapper').style.display,'block');}
c.renderReport();regular();assert.match(button.attributes['aria-label'],/0,8.*переключения листа/);
const click=fire(button.events,'click');assert(click.prevented&&click.stopped);assert.equal(calls,0);regular();
press();tick(799);assert.equal(calls,0);release();tick(1000);assert.equal(calls,0);regular();
press();tick(800);assert.equal(calls,1);gai();tick(2000);assert.equal(calls,1,'one switch per continuous hold');release();
assert.match(button.attributes['aria-label'],/0,8.*переключения листа/);
press();tick(800);release();assert.equal(calls,2);regular();
for(const name of ['pointerup','pointercancel','pointerleave','lostpointercapture','blur']){const before=calls;press();tick(400);fire(button.events,name);tick(1000);assert.equal(calls,before,name+' cancels held switch');}
for(const [map,name] of [[documentEvents,'scroll'],[documentEvents,'visibilitychange'],[windowEvents,'blur']]){const before=calls;press();tick(400);fire(map,name);tick(1000);assert.equal(calls,before,name+' cancels held switch');}
for(const move of [{clientX:245},{clientX:233},{clientY:50}]){const before=calls;press();tick(400);fire(button.events,'pointermove',move);tick(1000);assert.equal(calls,before,'leaving/drifting away cancels');}
for(const reason of ['permission','tab','hidden','detached','invisible']){
 const before=calls;press();tick(400);
 if(reason==='permission')c.hasPermission=()=>false;
 if(reason==='tab')c.hasTabAccess=()=>false;
 if(reason==='hidden')c.document.hidden=true;
 if(reason==='detached')button.isConnected=false;
 if(reason==='invisible')button.visible=false;
 tick(800);assert.equal(calls,before,reason+' rechecked when hold fires');release();
 c.hasPermission=()=>true;c.hasTabAccess=()=>true;c.document.hidden=false;button.isConnected=true;button.visible=true;
}
for(const key of ['Enter',' ']){const before=calls;fire(button.events,'keydown',{key});tick(400);fire(button.events,'keydown',{key,repeat:true});tick(400);assert.equal(calls,before+1,'keyboard hold reaches 800 ms without restart');tick(1000);assert.equal(calls,before+1);fire(button.events,'keyup',{key});}
const before=calls;fire(button.events,'keydown',{key:'Enter'});tick(799);fire(button.events,'keyup',{key:'Enter'});tick(1000);assert.equal(calls,before,'short keyboard activation cancels');
press({isPrimary:false});tick(1000);press({button:2});tick(1000);assert.equal(calls,before,'secondary pointer/buttons cannot switch');
c.showGAITable=false;c.renderReport();regular();
assert.equal(timers.size,0);
console.log('PASS Summary regression: actual regular/GAI sheets retained, legacy PDF/MAX controls unchanged, familiar lower-right icon, 800 ms hold-only, early release/leave/cancel/scroll/key safeguards, one switch per hold and permission recheck');
