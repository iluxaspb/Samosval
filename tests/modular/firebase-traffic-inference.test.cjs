/* Local inference is bounded by real registered accounts and never uses network. */
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../test-app/source/features/firebase-traffic-inference.js'),'utf8');
const events=[];
const traffic={active:()=>true,quotaDay:ts=>{
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ts)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
 return parts.year+'-'+parts.month+'-'+parts.day;
}};
const context={window:{FirebaseTraffic:traffic,dispatchEvent:e=>events.push(e.type),addEventListener(){}},
 CustomEvent:class{constructor(type){this.type=type;}},Intl,Date,Promise,Symbol,Set,Map,WeakMap,Object,Array,JSON,Number,String,Math,console,
 setTimeout(){return 1;},clearTimeout(){},indexedDB:undefined};
vm.runInNewContext(source,context,{filename:'firebase-traffic-inference.js'});
const I=context.window.FirebaseTrafficInference;
async function main(){
 assert.ok(I);
 I.enable();
 await new Promise(resolve=>setImmediate(resolve));
 const now=Date.now(),day=traffic.quotaDay(now);
 I.captureUsers([
  {id:'admin',email:'administrator@example.test',status:'active',role:'admin'},
  {id:'person1',email:'lopater@example.test',status:'active',role:'lopater'},
  {id:'person2',email:'master@example.test',status:'active',role:'master'},
  {id:'pending',email:'pending@example.test',status:'pending',role:'lopater'}
 ]);
 I.captureAudit([
  {id:'load-1',eventType:'load',timestamp:now,userEmail:'lopater@example.test',text:'Погрузка'},
  {id:'arrive-1',eventType:'arrive',timestamp:now-30000,userEmail:'master@example.test',text:'Приехал на линию'},
  {id:'game-1',eventType:'game_arcade',timestamp:now-60000,userEmail:'lopater@example.test',gameRound:5},
  {id:'my-1',eventType:'load',timestamp:now-20000,userEmail:'administrator@example.test'},
  {id:'unknown',eventType:'load',timestamp:now-10000,userEmail:'notregistered@example.test'}
 ]);
 const first=I.summary(day,'admin','administrator@example.test');
 assert.equal(first.registered,3,'Pending account excluded');
 assert.equal(first.actions.load,1,'Own action excluded and unregistered ignored');
 assert.equal(first.actions.arrive,1);
 assert.equal(first.actions.game,1);
 assert.equal(first.unassigned,1);
 assert.equal(first.otherUsers,2);
 assert.ok(first.reads.low<=first.reads.expected&&first.reads.expected<=first.reads.high);
 assert.ok(first.writes.low<=first.writes.expected&&first.writes.expected<=first.writes.high);
 assert.ok(first.participants.length<=first.registered-1);
 const auditBefore=first.auditRows;
 I.captureAudit([{id:'load-1',eventType:'load',timestamp:now,userEmail:'lopater@example.test'}]);
 assert.equal(I.summary(day,'admin','administrator@example.test').auditRows,auditBefore,'Repeated snapshots deduplicated');
 const json=JSON.stringify(I.data);
 assert.ok(!json.includes('lopater@example.test'),'Email is not stored');
 assert.ok(!json.includes('administrator@example.test'),'Own email is not stored');
 assert.ok(!json.includes('Погрузка'),'Audit contents are not stored');
 assert.ok(!json.includes('notregistered@example.test'));
 console.log('LOCAL_INFERENCE_TEST_OK',JSON.stringify({registered:first.registered,actions:first.actions,records:first.auditRows}));
}
main().catch(err=>{console.error(err);process.exitCode=1;});