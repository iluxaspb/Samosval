import test from 'node:test';
import assert from 'node:assert/strict';
let seq=0;
function printer(serial='A'){
  return {vendorId:123,productId:456,serialNumber:serial,productName:'WN HighPrint 4915xe',opened:false,
    configuration:{interfaces:[{interfaceNumber:0,alternates:[{alternateSetting:0,interfaceClass:7,interfaceSubclass:1,endpoints:[{endpointNumber:1,direction:'out',type:'bulk'}]}]}]},
    async open(){this.opened=true},async close(){this.opened=false},async claimInterface(){},async selectAlternateInterface(){},async releaseInterface(){},
    async transferOut(ep,chunk){return {status:'ok',bytesWritten:chunk.length}}};
}
async function setup(devices=[printer()]){
  const records=new Map();let chooser=0;
  globalThis.localStorage={getItem:k=>records.get(k)||null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{usb:{getDevices:async()=>devices,requestDevice:async()=>{chooser++;return devices[0]}}}});
  const usb=await import(`../usb.js?test=${seq++}`);
  return {usb,devices,chooser:()=>chooser,records};
}
test('saved authorised printer reconnects without chooser',async()=>{
  const {usb,chooser}=await setup();await usb.connect();assert.equal(chooser(),1);assert.equal(usb.savePrinter(),'WN HighPrint 4915xe');await usb.disconnect();assert.match((await usb.connect()).message,/Сохранённый/);assert.equal(chooser(),1);assert.equal(usb.savedPrinterName(),'WN HighPrint 4915xe');await usb.disconnect();
});
test('explicit change and duplicate identities require chooser',async()=>{
  const {usb,devices,chooser}=await setup();await usb.connect();usb.savePrinter();await usb.disconnect();devices.push(printer());assert.equal((await usb.searchPrinters()).needsPermission,true);assert.equal(chooser(),1);await usb.disconnect();await usb.connect({useSaved:false});assert.equal(chooser(),2);await usb.disconnect();usb.forgetPrinter();assert.equal(usb.savedPrinterName(),'');
});
test('lost permission requires a new click, search never opens chooser',async()=>{
  const {usb,devices,chooser}=await setup();await usb.connect();usb.savePrinter();await usb.disconnect();devices.length=0;assert.equal((await usb.searchPrinters()).needsPermission,true);assert.equal(chooser(),1);
});
test('partial USB writes continue from exact byte offset',async()=>{
  const {usb,devices}=await setup();await usb.connect();const sent=[];devices[0].transferOut=async(ep,chunk)=>{sent.push(...chunk.slice(0,2));return {status:'ok',bytesWritten:Math.min(2,chunk.length)}};
  await usb.sendBytes(new Uint8Array([1,2,3,4,5]));assert.deepEqual(sent,[1,2,3,4,5]);await usb.disconnect();
});
test('15 seconds is waiting, not failure; competing transfer and reconnect blocked',async t=>{
  const {usb,devices}=await setup();await usb.connect();let resolve;devices[0].transferOut=()=>new Promise(r=>{resolve=r});
  t.mock.timers.enable({apis:['setTimeout']});const notices=[];const task=usb.sendBytes(new Uint8Array([1]),(p,d)=>notices.push(d));await Promise.resolve();
  t.mock.timers.tick(15000);assert.equal(notices[0].waiting,true);
  await assert.rejects(usb.connect(),/Дождись/);await assert.rejects(usb.disconnect(),/Дождись/);await assert.rejects(usb.sendBytes(new Uint8Array([2])),/уже/);
  resolve({status:'ok',bytesWritten:1});await task;assert.equal(notices.at(-1).waiting,false);await usb.disconnect();
});
test('hard timeout closes USB and locks until original operation settles',async t=>{
  const {usb,devices}=await setup();await usb.connect();let rejectTransfer;devices[0].transferOut=()=>new Promise((_,r)=>{rejectTransfer=r});
  t.mock.timers.enable({apis:['setTimeout']});const task=usb.sendBytes(new Uint8Array([1]));await Promise.resolve();const failed=assert.rejects(task,/2 минуты/);
  t.mock.timers.tick(120000);await failed;assert.equal(usb.connected(),false);assert.equal(devices[0].opened,false);await assert.rejects(usb.connect(),/Дождись/);
  rejectTransfer(Error('late disconnect'));await new Promise(r=>setImmediate(r));await usb.connect();await usb.disconnect();
});
test('failed transfer invalidates connection instead of allowing silent replay',async()=>{
  const {usb,devices}=await setup();await usb.connect();devices[0].transferOut=async()=>({status:'stall',bytesWritten:0});await assert.rejects(usb.sendBytes(new Uint8Array([1])),/Ошибка передачи/);assert.equal(usb.connected(),false);assert.equal(devices[0].opened,false);
});


test('search finds a single authorised printer without a saved preference or chooser',async()=>{
 const {usb,chooser}=await setup();assert.equal((await usb.searchPrinters()).ready,true);assert.equal(chooser(),0);await usb.disconnect();
});
test('explicit selection requests permission synchronously and filters printers',async()=>{
 const {usb,devices}=await setup();let called=false;const old=devices[0];await usb.searchPrinters();
 old.close=async()=>{assert.equal(called,true);old.opened=false};
 navigator.usb.getDevices=()=>{throw Error('must not enumerate before chooser')};
 navigator.usb.requestDevice=opts=>{called=true;assert.deepEqual(opts,{filters:[{classCode:7}]});return Promise.resolve(old)};
 const task=usb.connect({useSaved:false});assert.equal(called,true);assert.equal((await task).ready,true);await usb.disconnect();
});
test('failed first channel falls back across configurations without printing',async()=>{
 const {usb,devices}=await setup();const d=devices[0];const first=d.configuration;first.configurationValue=1;
 const second=structuredClone(first);second.configurationValue=2;second.interfaces[0].interfaceNumber=4;
 d.configurations=[first,second];const attempts=[];d.selectConfiguration=async n=>{d.configuration=d.configurations.find(c=>c.configurationValue===n)};
 d.claimInterface=async n=>{attempts.push(n);if(n===0)throw Error('busy')};d.transferOut=()=>{throw Error('must not print')};
 const r=await usb.searchPrinters();assert.equal(r.ready,true);assert.equal(r.diagnostics.interface,4);assert.deepEqual(attempts,[0,4]);await usb.disconnect();
});
test('cancel changing printer preserves active connection and saved preference',async()=>{
 const {usb}=await setup();await usb.searchPrinters();usb.savePrinter();navigator.usb.requestDevice=async()=>{throw new DOMException('cancel','NotFoundError')};
 const r=await usb.connect({useSaved:false});assert.equal(r.ready,true);assert.equal(usb.connected(),true);assert.equal(usb.savedPrinterName(),'WN HighPrint 4915xe');await usb.disconnect();
});
test('all channels failing reports no connection',async()=>{
 const {usb,devices}=await setup();devices[0].claimInterface=async()=>{throw Error('busy')};
 const r=await usb.searchPrinters();assert.equal(r.ready,false);assert.match(r.message,/открыть канал/);assert.equal(usb.connected(),false);assert.equal(devices[0].opened,false);
});
test('ambiguous serialless devices are not silently deduplicated',async()=>{
 const {usb,chooser}=await setup([printer(''),printer('')]);assert.equal((await usb.searchPrinters()).needsPermission,true);assert.equal(chooser(),0);assert.equal(usb.connected(),false);
});

test('USB disconnect invalidates endpoint and notifies UI',async()=>{
 const {usb,devices}=await setup();let callback,called=0;navigator.usb.addEventListener=(name,fn)=>{assert.equal(name,'disconnect');callback=fn};
 usb.onDisconnect(()=>called++);await usb.searchPrinters();callback({device:printer('other')});assert.equal(called,0);callback({device:devices[0]});assert.equal(usb.connected(),false);assert.equal(called,1);
});

test('five stale permitted entries are skipped only on NotFound and sole live Wincor connects',async()=>{
 const stale=Array.from({length:5},(_,i)=>{const d=printer(String(i));d.open=async()=>{throw new DOMException('removed','NotFoundError')};return d});
 const live=printer('7');let sent=0;live.transferOut=async()=>{sent++;return {status:'ok',bytesWritten:1}};
 const {usb}=await setup([...stale,live]);assert.equal((await usb.searchPrinters()).ready,true);assert.equal(sent,0);assert.equal(usb.diagnostics().events.filter(e=>e.phase==='probe-error').length,5);await usb.disconnect();
});
test('permission denial stops discovery without opening next device or chooser',async()=>{
 const first=printer('0'),next=printer('1');let opened=0;first.open=async()=>{throw new DOMException('denied','SecurityError')};next.open=async()=>{opened++;next.opened=true};
 const {usb,chooser}=await setup([first,next]);await assert.rejects(usb.searchPrinters(),{name:'SecurityError'});assert.equal(opened,0);assert.equal(chooser(),0);assert.equal(usb.connected(),false);
});
test('two live Wincor devices are not arbitrarily selected or claimed',async()=>{
 const a=printer('A'),b=printer('B');let claims=0;a.claimInterface=b.claimInterface=async()=>claims++;
 const {usb}=await setup([a,b]);assert.equal((await usb.searchPrinters()).ready,false);assert.equal(claims,0);assert.equal(a.opened,false);assert.equal(b.opened,false);
});
test('fresh connect replaces disconnected object without sending print bytes',async()=>{
 const first=printer(),fresh=printer();let sends=0;first.transferOut=fresh.transferOut=()=>{sends++;throw Error('no print')};
 const {usb,devices}=await setup([first]);const handlers={};navigator.usb.addEventListener=(name,fn)=>handlers[name]=fn;usb.onDisconnect(()=>{});const results=[];usb.onConnect(r=>results.push(r));
 await usb.searchPrinters();usb.savePrinter();handlers.disconnect({device:first});assert.equal(usb.connected(),false);devices.push(fresh);
 await handlers.connect({device:fresh});assert.equal(usb.connected(),true);assert.equal(results[0].ready,true);assert.equal(sends,0);assert.equal(usb.diagnostics().events.filter(e=>e.phase==='fresh-event-selected').at(-1).device.serialPresent,true);await usb.disconnect();
});
test('disconnect during pending open cannot install the removed connection',async()=>{
 const d=printer();const {usb}=await setup([d]);let finish;d.open=()=>new Promise(r=>finish=()=>{d.opened=true;r()});let unplug;navigator.usb.addEventListener=(name,fn)=>{if(name==='disconnect')unplug=fn};usb.onDisconnect(()=>{});
 const task=usb.searchPrinters();await Promise.resolve();unplug({device:d});finish();await assert.rejects(task,{name:'NotFoundError'});assert.equal(usb.connected(),false);assert.equal(d.opened,false);
});

test('unrelated printer is neither auto-connected nor opened by explicit choice',async()=>{
 const d=printer();d.productName='Other printer';d.vendorId=999;let opens=0;d.open=async()=>{opens++};const {usb}=await setup([d]);let plug;navigator.usb.addEventListener=(n,fn)=>{if(n==='connect')plug=fn};let notifications=0;usb.onConnect(()=>notifications++);await plug({device:d});assert.equal(opens,0);assert.equal(notifications,0);await assert.rejects(usb.connect({useSaved:false}),/не опознано/);assert.equal(opens,0);
});

test('fresh permitted attach selects its object even if older enumerated records open',async()=>{
 const old=printer('old'),fresh=printer('new');const {usb}=await setup([old,fresh]);let plug;navigator.usb.addEventListener=(name,fn)=>{if(name==='connect')plug=fn};usb.onConnect(()=>{});await plug({device:fresh});assert.equal(usb.connected(),true);assert.equal(fresh.opened,true);assert.equal(old.opened,false);await usb.disconnect();
});
