const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('test-app/src/core/13-reports.js','utf8');
const c={state:{truckStatus:{truck:{ttnStatus:'pending',arriveStatus:'23:59',arriveBy:'CURRENT USER'}}},findTruck:()=>({id:'truck',brand:'Test',number:'',isGAI:false}),escapeHtml:s=>String(s??''),resolveUserDisplayName:(email,name)=>name};c.window=c;c.__closedShiftDupEnabled=()=>true;
vm.createContext(c);vm.runInContext(source,c);
// Display-only request: the controlled red badge is Latin D; TTN conditions stay unchanged.
const duplicateBadge='style="color:red; font-size:10px; font-weight:bold;" title="Дубликат" aria-label="Дубликат">D</span>';
const base={objectName:'Old site',date:'Old date',logs:[{id:'log',truckId:'truck',volume:10,isGAI:false,timestamp:1,timeStr:'09:00',createdBy:'ARCHIVE USER'}],activeLineIds:['truck'],type:'regular',isClosed:true,reportTtnStatus:{truck:true}};
const saved=c.buildReportHTML(base);assert(saved.includes('ARCHIVE USER'));assert(!saved.includes('CURRENT USER'));assert(!saved.includes('23:59'));assert(!saved.includes(duplicateBadge));assert(!saved.includes('hand-drawn-circle'));
const pending=c.buildReportHTML({...base,reportTtnStatus:{truck:'pending'}});assert(pending.includes('hand-drawn-circle'),'archived pending TTN still has its own next-cell marker');assert(!pending.includes('23:59'));assert(!pending.includes(duplicateBadge));
const absent=c.buildReportHTML({...base,reportTtnStatus:{}});assert(absent.includes(duplicateBadge),'missing archived TTN not hidden by current truck status');
assert(!absent.includes('>ДУБЛИКАТ</span>'),'old printed badge text must not remain');
c.state.truckStatus.truck={ttnStatus:true,arriveStatus:'12:34'};assert.equal(c.buildReportHTML(base),saved,'editing active shift cannot alter exported archived TTN/arrival');
console.log('PASS TEST report snapshot: archived TTN/arrival isolated from live shift; pending/duplicate markers preserved');
