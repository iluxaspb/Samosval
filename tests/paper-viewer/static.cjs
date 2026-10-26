'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const viewer=read('test-app/src/features/summary-viewer.js'),production=read('index.html');
new vm.Script(viewer);
assert(!viewer.includes('new MutationObserver(()=>{copy()'));
assert(!viewer.includes('state.truckStatus'),'archive paper snapshot never reads live TTN/arrival state');
assert(!viewer.includes('onclick="toggleArchiveReportType()"'),'no normal-click GAI control');
assert(viewer.includes('}, 800)'),'hold is exactly 800 ms');
assert(viewer.includes('width:44px;height:44px'));
assert(viewer.includes('const savedName=String(ref?.truckName'));
assert(viewer.includes('!archiveSnapshot || archiveSnapshot.id!==id || !host.classList.contains(\'open\')'));
assert(!viewer.includes('data-action="save"'),'approved zoom toolbar is not redesigned');
assert(!viewer.includes('refs.')&&!viewer.includes('db.')&&!viewer.includes('fetch('));
assert.equal(production.split('/* One paper viewer.').length-1,1);
assert(!production.includes('__archiveSheetViewerInstalled'));
assert(!production.includes("const key = 'samosval:test:summary-viewer:v1'"));
assert(production.includes(viewer.trim()));
// Duplicate rendering is display-only. Verify legacy conditions on all combinations.
const marker='title="Дубликат" aria-label="Дубликат">D</span>';
for(const file of ['test-app/src/core/13-reports.js','test-app/src/core/14-archive.js']){
 const source=read(file);assert(!source.includes('>ДУБЛИКАТ</span>'));assert(source.includes(marker));
}
const reports=read('test-app/src/core/13-reports.js');
const nodes=new Map();function node(id){if(!nodes.has(id))nodes.set(id,{style:{},textContent:'',innerHTML:''});return nodes.get(id);}
const logs=[{id:'rlog',truckId:'r',truckName:'REG',volume:20,isGAI:false,timeStr:'10:00',timestamp:1,comment:'слово ДУБЛИКАТ в комментарии'},{id:'glog',truckId:'g',truckName:'GAI',volume:0,isGAI:true,timeStr:'11:00',timestamp:2}];
const c={console,state:{shift:{id:'shift',objectName:'Object',startDate:'26.10.2026'},truckStatus:{}},showGAITable:false,hasTabAccess:()=>true,hasPermission:()=>true,showError(){},getLogs:()=>logs,getActiveLineIds:()=>['r','g'],findTruck:id=>({id,brand:id,number:'',isGAI:id==='g'}),escapeHtml:s=>String(s??''),renderRussianPlate:s=>s,resolveUserDisplayName:()=>'',truckLabelHtml:()=>'',document:{getElementById:node}};c.window=c;vm.createContext(c);vm.runInContext(reports,c);
for(const enabled of [false,true])for(const ttn of [undefined,false,true,'pending']){
 c.__closedShiftDupEnabled=()=>enabled;c.state.truckStatus={r:{ttnStatus:ttn},g:{ttnStatus:ttn}};c.renderReport();
 const expectedLive=!enabled&&ttn!==true;for(const id of ['matrixTableBody','gaiTableBody'])assert.equal(node(id).innerHTML.includes(marker),expectedLive);
 assert(node('matrixTableBody').innerHTML.includes('слово ДУБЛИКАТ в комментарии'),'user comments remain verbatim');
 for(const isClosed of [false,true])for(const type of ['regular','gai']){
  const html=c.buildReportHTML({objectName:'Obj',date:'Date',logs,activeLineIds:['r','g'],type,isClosed,reportTtnStatus:{r:ttn,g:ttn}});
  const expected=enabled?isClosed&&ttn!==true&&ttn!=='pending':ttn!==true;assert.equal(html.includes(marker),expected);
 }
}
// The frozen archive renderer keeps its legacy duplicate/TTN truth table, too.
c.esc=c.escapeHtml;vm.runInContext(viewer.slice(viewer.indexOf('  function renderArchiveSheet('),viewer.indexOf('  if (host) {')),c);
for(const enabled of [false,true])for(const ttn of [undefined,false,true,'pending'])for(const gai of [false,true]){
 c.__closedShiftDupEnabled=()=>enabled;
 const snapshot={objectName:'Saved',date:'Saved date',logs:logs.map(log=>({...log,author:'Saved author'})),activeIds:['r','g'],ttn:{r:ttn,g:ttn},trucks:new Map([['r',{brand:'Saved regular',number:'',isGAI:false}],['g',{brand:'Saved GAI',number:'',isGAI:true}]])};
 const output=c.renderArchiveSheet(snapshot,gai),expected=enabled?ttn!==true&&ttn!=='pending':!ttn;
 assert.equal(output.includes(marker),expected,'archive duplicate truth table');
 assert(!output.includes('LIVE-ARRIVAL'));
}
console.log('PASS source scope, shared viewer installation, fixed hold geometry, frozen archive/no live state, D-only labels and unchanged current/export duplicate truth tables');
