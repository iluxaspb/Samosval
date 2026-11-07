import test from 'node:test';
import assert from 'node:assert/strict';
let seq=0;
const flush=()=>new Promise(r=>setImmediate(r));
function printer(serial='A'){
 return {vendorId:2727,productId:17152,serialNumber:serial,productName:'WN HighPrint 4915xe',opened:false,
 configuration:{interfaces:[{interfaceNumber:0,alternates:[{alternateSetting:0,interfaceClass:7,endpoints:[{endpointNumber:1,direction:'out',type:'bulk'}]}]}]},
 async open(){this.opened=true},async close(){this.opened=false},async claimInterface(){},async releaseInterface(){},async selectAlternateInterface(){},async transferOut(ep,b){return {status:'ok',bytesWritten:b.length}}};
}
async function setup(devices=[]){
 const records=new Map(),events=new EventTarget(),visibility=new EventTarget(),counts={enumerate:0,chooser:0,opens:0};visibility.visibilityState='visible';
 globalThis.localStorage={getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{usb:{addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),async getDevices(){counts.enumerate++;return devices},async requestDevice(){counts.chooser++;return devices[0]}}}});
 const usb=await import(`../usb.js?monitor=${seq++}`);
 const emit=(type,d)=>{const e=new Event(type);e.device=d;events.dispatchEvent(e)};
 return {usb,counts,devices,visibility,emit,records};
}
test('visible polling attaches missing-event device once and pauses in background',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const s=await setup();const updates=[];const stop=s.usb.monitor(r=>updates.push(r),{visibility:s.visibility,interval:100});await flush();
 assert.equal(s.counts.enumerate,1);assert.equal(s.counts.chooser,0);assert.equal(updates[0].needsPermission,true);
 const d=printer();let opens=0;d.open=async()=>{opens++;d.opened=true};s.devices.push(d);t.mock.timers.tick(100);await flush();assert.equal(s.usb.connected(),true);const afterOpen=opens;
 for(let i=0;i<5;i++){t.mock.timers.tick(100);await flush()}assert.equal(opens,afterOpen);assert.equal(s.counts.chooser,0);
 s.visibility.visibilityState='hidden';s.visibility.dispatchEvent(new Event('visibilitychange'));const before=s.counts.enumerate;t.mock.timers.tick(1000);await flush();assert.equal(s.counts.enumerate,before);
 s.visibility.visibilityState='visible';s.visibility.dispatchEvent(new Event('visibilitychange'));await flush();assert.equal(s.counts.enumerate,before+1);assert.equal(opens,afterOpen);
 stop();const final=s.counts.enumerate;t.mock.timers.tick(1000);await flush();assert.equal(s.counts.enumerate,final);await s.usb.disconnect();
});
test('denied or busy unchanged device is not retried on poll, duplicate event or foreground',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const d=printer();let opens=0;d.open=async()=>{opens++;throw new DOMException('denied','SecurityError')};const s=await setup([d]);const stop=s.usb.monitor(()=>{},{visibility:s.visibility,interval:100});await flush();assert.equal(opens,1);
 for(let i=0;i<4;i++){t.mock.timers.tick(100);await flush()}s.emit('connect',d);await flush();s.visibility.dispatchEvent(new Event('visibilitychange'));await flush();assert.equal(opens,1);assert.equal(s.counts.chooser,0);
 s.devices.length=0;t.mock.timers.tick(100);await flush();const next=printer();s.devices.push(next);t.mock.timers.tick(100);await flush();assert.equal(s.usb.connected(),true);stop();await s.usb.disconnect();
});
test('unrelated VID/PID is ignored even when product name says WN4915',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const d=printer();d.vendorId=999;let opens=0;d.open=async()=>{opens++};const s=await setup([d]);const stop=s.usb.monitor(()=>{},{visibility:s.visibility,interval:100});await flush();s.emit('connect',d);await flush();t.mock.timers.tick(100);await flush();assert.equal(opens,0);assert.equal(s.counts.chooser,0);stop();
});
test('monitor does not enumerate or reopen while transfer is pending and never replays bytes',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const d=printer(),s=await setup([d]);let sends=0,finish;const stop=s.usb.monitor(()=>{},{visibility:s.visibility,interval:100});await flush();
 d.transferOut=()=>{sends++;return new Promise(r=>finish=()=>r({status:'ok',bytesWritten:1}))};const task=s.usb.sendBytes(new Uint8Array([42]));await flush();const before=s.counts.enumerate;t.mock.timers.tick(500);await flush();assert.equal(s.counts.enumerate,before);assert.equal(sends,1);finish();await task;
 s.emit('disconnect',d);s.devices.length=0;await flush();const next=printer();next.transferOut=async()=>{sends++;return {status:'ok',bytesWritten:1}};s.devices.push(next);s.emit('connect',next);await flush();assert.equal(s.usb.connected(),true);assert.equal(sends,1);stop();await s.usb.disconnect();
});
test('diagnostics preserve serial equality without raw serial or print payload',async()=>{
 const d=printer('PRIVATE-SERIAL-SECRET'),s=await setup([d]);await s.usb.searchPrinters();s.usb.savePrinter();await s.usb.sendBytes(new TextEncoder().encode('PRIVATE-PAYLOAD'));const report=JSON.stringify(s.usb.diagnostics());assert.equal(report.includes('PRIVATE-SERIAL-SECRET'),false);assert.equal(report.includes('PRIVATE-PAYLOAD'),false);assert.match(report,/serialKey/);assert.match(report,/matchesSavedSerial/);await s.usb.disconnect();
});

test('new permitted object resumes polling after stale-only failure without connect event',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const stale=printer();let staleOpens=0;stale.open=async()=>{staleOpens++;throw new DOMException('gone','NotFoundError')};
 const s=await setup([stale]),stop=s.usb.monitor(()=>{},{visibility:s.visibility,interval:100});await flush();
 assert.equal(s.usb.connected(),false);assert.equal(staleOpens,1);
 const live=printer();s.devices.push(live);t.mock.timers.tick(100);await flush();
 assert.equal(s.usb.connected(),true);assert.equal(staleOpens,1);assert.equal(s.counts.chooser,0);
 stop();await s.usb.disconnect();
});
test('new attachment does not cause an earlier denied object to be retried',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const denied=printer();let deniedOpens=0;denied.open=async()=>{deniedOpens++;throw new DOMException('denied','SecurityError')};
 const s=await setup([denied]),stop=s.usb.monitor(()=>{},{visibility:s.visibility,interval:100});await flush();
 const live=printer('B');s.devices.push(live);t.mock.timers.tick(100);await flush();
 assert.equal(s.usb.connected(),true);assert.equal(deniedOpens,1);assert.equal(s.counts.chooser,0);
 t.mock.timers.tick(100);await flush();assert.equal(deniedOpens,1);stop();await s.usb.disconnect();
});
