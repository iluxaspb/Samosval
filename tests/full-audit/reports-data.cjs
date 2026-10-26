'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('test-app/src/core/13-reports.js','utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const downloads=[],blobs=[],revoked=[];
const c={console,Blob,state:{shift:{id:'s'},truckStatus:{}},showGAITable:false,
 findTruck:id=>id==='active'?{id,brand:'=SUM(1,2)',number:'A123',isGAI:false}:null,
 escapeHtml:esc,resolveUserDisplayName:(email,name)=>name,renderRussianPlate:n=>esc(n),
 hasTabAccess:()=>true,hasPermission:()=>true,showError(){},showToastEl(){},
 getActiveLineIds:()=>['active'],getLogs:()=>c.logs,
 document:{createElement:()=>({click(){downloads.push(this.download);}})},
 URL:{createObjectURL:b=>{blobs.push(b);return 'blob:fixture';},revokeObjectURL:u=>revoked.push(u)},
 setTimeout:fn=>{fn();return 1;}};c.window=c;vm.createContext(c);vm.runInContext(source,c);
assert.equal(c.reportVolumeTotal([{volume:'20'},{volume:10}]),30,'numeric legacy strings do not concatenate');
for(const value of [null,true,undefined,{},'',-1,Infinity,'Infinity','<b>invalid</b>'])assert(Number.isNaN(c.reportVolumeNumber(value)));
const logs=[{id:'one',truckId:'active',truckName:'Known',volume:'20',timestamp:1,timeStr:'09:00',createdBy:'A'},
 {id:'two',truckId:'removed',truckName:'Old; "truck"',volume:10,timestamp:2,timeStr:'09:30',createdBy:'B',comment:'line1\nline2; detail'}];
const options={objectName:'Site',date:'2026-10-25',logs,activeLineIds:['active'],type:'regular'};
assert(c.buildReportHTML(options).includes('30 м³'));
const corrupt=c.buildReportHTML({...options,logs:[{...logs[0],volume:'<b>invalid</b>'}]});
assert(corrupt.includes('некорректный объём'));assert(!corrupt.includes('<b>invalid</b>'),'untrusted volume never enters markup');
const map=c.reportLogsByTruck(logs);assert.equal(map.size,2);assert.equal(map.get('active')[0].id,'one');
assert(!c.reportActionId("quote'id").includes("'"));assert.equal(decodeURIComponent(c.reportActionId("quote'id")),"quote'id");
(async()=>{
 c.logs=logs;c.exportCSV();assert.equal(downloads[0],'report.csv');
 const csv=await blobs[0].text();assert(csv.includes("\"'=SUM(1,2) A123\""),'spreadsheet formula prefix neutralized');
 assert(csv.includes('"Old; ""truck"""'),'removed truck retained and quotes escaped');
 assert(csv.includes('line1\nline2; detail'),'comment newlines preserved inside quoted cell');
 assert.equal(revoked.length,1);c.hasTabAccess=()=>false;c.exportCSV();assert.equal(downloads.length,1);
 console.log('PASS report data: numeric totals, corrupt-volume warning without markup, linear grouping, safe action IDs, complete/quoted CSV, permission guard');
})().catch(e=>{console.error(e);process.exitCode=1;});

// Archive summaries and sheets share numeric safety/linear grouping while retaining the new UI.
const archiveSource=fs.readFileSync('test-app/src/core/14-archive.js','utf8');
const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',style:{},classList:{add(){},remove(){}}});return nodes.get(id);};
c.document.getElementById=node;c.viewingArchiveId=null;c.viewingArchiveGAITable=false;
c.state.archive=[{id:"archive'id",objectName:'__proto__',date:'26.10.2026',logs,activeLineIds:['active'],ttnStatus:{active:'pending'}}];c.state.trash=[];
vm.runInContext(archiveSource,c);
c.renderArchive();const archiveList=node('archiveContainer').innerHTML;
assert(archiveList.includes('30 м³'),'archive numeric strings summed, not concatenated');
assert(archiveList.includes("archive%27id"),'archive action ID safely encoded');
assert(!archiveList.includes('data-photo-object'),'removed photo controls stay absent');
c.renderArchiveModalContent(c.state.archive[0]);const sheet=node('modalArchiveBody').innerHTML;
assert(sheet.includes('30 м³'));assert(sheet.includes('Old; &quot;truck&quot;'),'removed truck retained in archive');
assert.equal((sheet.match(/hand-drawn-circle/g)||[]).length,1,'pending TTN only marks next cell, not last trip too');
assert(sheet.includes('archive-toggle-icon'));assert(!sheet.includes('draw-canvas'));
c.state.archive[0].logs=[{...logs[0],volume:'<img onerror=bad>'}];c.renderArchive();c.renderArchiveModalContent(c.state.archive[0]);
assert(node('archiveContainer').innerHTML.includes('некорректный объём'));
assert(node('modalArchiveBody').innerHTML.includes('некорректный объём'));assert(!node('modalArchiveBody').innerHTML.includes('<img'));
assert.equal(c.archiveRestoreJSON(JSON.parse('{"__proto__":{"a":1},"normal":2}')),'{"__proto__":{"a":1},"normal":2}','fingerprint retains reserved-name fields');
console.log('PASS archive report data: numeric/corrupt totals, complete truck list, reserved object names/action IDs, pending TTN marker, no removed controls');
