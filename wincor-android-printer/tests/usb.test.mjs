import test from 'node:test';
import assert from 'node:assert/strict';
let seq=0;
function printer(serial='A'){
  return {vendorId:123,productId:456,serialNumber:serial,productName:'4915',opened:false,
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
  const {usb,chooser}=await setup();await usb.connect();assert.equal(chooser(),1);assert.equal(usb.savePrinter(),'4915');await usb.disconnect();assert.match((await usb.connect()).message,/Сохранённый/);assert.equal(chooser(),1);assert.equal(usb.savedPrinterName(),'4915');await usb.disconnect();
});
test('explicit change and duplicate identities require chooser',async()=>{
  const {usb,devices,chooser}=await setup();await usb.connect();usb.savePrinter();await usb.disconnect();devices.push(printer());await usb.connect();assert.equal(chooser(),2);await usb.disconnect();await usb.connect({useSaved:false});assert.equal(chooser(),3);await usb.disconnect();usb.forgetPrinter();assert.equal(usb.savedPrinterName(),'');
});
test('lost permission falls back to selection',async()=>{
  const {usb,devices,chooser}=await setup();await usb.connect();usb.savePrinter();await usb.disconnect();devices[0]=printer('B');assert.equal((await usb.connect()).message,'USB подключён.');assert.equal(chooser(),2);await usb.disconnect();
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
