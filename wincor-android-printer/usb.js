import {rasterBytes} from './core.js';
const SAVED_KEY='wincor-android-printer.usb.v1';
let device,iface,endpoint,connecting=false,sending=false,pending=false,epoch=0,nextId=0,droppedEvents=0,lastTransfer=null;
const ids=new WeakMap(),removed=new WeakSet(),history=[],serialKeys=new Map();
function serialKey(d){if(!d.serialNumber)return null;if(!serialKeys.has(d.serialNumber))serialKeys.set(d.serialNumber,serialKeys.size+1);return serialKeys.get(d.serialNumber)}
function id(d){if(!d)return null;if(!ids.has(d))ids.set(d,++nextId);return ids.get(d)}
function info(d){return {id:id(d),vendorId:d.vendorId,productId:d.productId,name:d.productName||'',serialPresent:!!d.serialNumber,serialKey:serialKey(d),matchesSavedSerial:!!saved()?.serialNumber&&d.serialNumber===saved().serialNumber,opened:!!d.opened,channels:channels(d).map(o=>({configuration:o.c.configurationValue,interface:o.i.interfaceNumber,alternate:o.a.alternateSetting,endpoint:o.ep.endpointNumber}))}}
function log(phase,details={}){history.push({time:new Date().toISOString(),epoch,phase,...details});if(history.length>4096){history.shift();droppedEvents++}}
export const diagnostics=()=>({version:2,appVersion:'0.1.5',droppedEvents,lastTransfer:lastTransfer?structuredClone(lastTransfer):null,userAgent:navigator.userAgent||'',epoch,events:history.map(e=>structuredClone(e))});
function saved(){try{const p=JSON.parse(localStorage.getItem(SAVED_KEY));return p&&Number.isInteger(p.vendorId)&&Number.isInteger(p.productId)?p:null}catch{return null}}
export const savedPrinterName=()=>saved()?.name||'';
export function savePrinter(){if(!connected())throw Error('Сначала подключи принтер');const p={vendorId:device.vendorId,productId:device.productId,serialNumber:device.serialNumber||'',name:device.productName||'USB-принтер'};localStorage.setItem(SAVED_KEY,JSON.stringify(p));log('save',{device:info(device)});return p.name}
export function forgetPrinter(){localStorage.removeItem(SAVED_KEY)}
function knownName(d){return ['wn highprint 4915','wn highprint 4915xe','wincor highprint 4915','wincor highprint 4915xe','highprint 4915','highprint 4915xe'].includes((d.productName||'').trim().toLowerCase())}
function allowedPreference(){const p=saved();return p&&(p.vendorId===2727&&p.productId===17152||knownName({productName:p.name}))?p:null}
function target(d){const p=allowedPreference();return d.vendorId===2727&&d.productId===17152||!!p&&d.vendorId===p.vendorId&&d.productId===p.productId}

export function onDisconnect(listener){
  const handler=e=>{removed.add(e.device);epoch++;log('disconnect',{device:info(e.device)});if(e.device!==device)return;device=undefined;endpoint=undefined;iface=undefined;listener()};
  navigator.usb?.addEventListener?.('disconnect',handler);
  return ()=>navigator.usb?.removeEventListener?.('disconnect',handler);
}
export function onConnect(listener){
  const handler=async e=>{
    removed.delete(e.device);epoch++;log('connect',{device:info(e.device),target:target(e.device)});
    if(!target(e.device)||connected()||connecting||sending||pending)return;
    try{const result=await searchPrinters({fresh:e.device});listener(result)}catch(error){log('connect-error',{error:error.name,message:error.message});listener({ready:false,message:'Подключение не подтверждено: '+error.message})}
  };
  navigator.usb?.addEventListener?.('connect',handler);
  return ()=>navigator.usb?.removeEventListener?.('connect',handler);
}
export const connected=()=>!!device?.opened&&endpoint!==undefined&&!pending&&!removed.has(device);
// Enumeration is read-only. Opening is attempted only on a changed attachment set,
// once per stable failure; neither timer nor foreground requests a chooser.
export function monitor(listener,{interval=2000,visibility=globalThis.document}={}){
  let stopped=false,timer,scanning=false,lastObjects=null,lastFingerprint=null,blocked=false,fresh=null,suppressed=new WeakSet();
  const visible=()=>visibility?.visibilityState!=='hidden';
  const emit=r=>{if(!stopped)listener(r)};
  const schedule=()=>{clearTimeout(timer);if(!stopped&&visible())timer=setTimeout(tick,interval)};
  const fingerprint=ds=>JSON.stringify(ds.map(d=>[d.vendorId,d.productId,serialKey(d),channels(d).map(o=>[o.c.configurationValue,o.i.interfaceNumber,o.a.alternateSetting,o.ep.endpointNumber])]).sort());
  async function tick(){
    clearTimeout(timer);
    if(stopped||!visible())return;
    if(scanning||connecting||sending||pending){schedule();return}
    scanning=true;let attempted=[];
    try{
      if(!navigator.usb){emit({ready:false,message:'Для USB нужен Chrome на Android и HTTPS.'});stopped=true;return}
      const all=await navigator.usb.getDevices();if(stopped||!visible()||connecting||sending||pending)return;
      const matches=all.filter(d=>target(d)&&channels(d).length&&!removed.has(d));
      const objects=matches.map(id).sort((a,b)=>a-b).join(','),fp=fingerprint(matches);
      const changed=objects!==lastObjects||fp!==lastFingerprint;
      if(changed)log('monitor-snapshot',{devices:all.map(info)});
      lastObjects=objects;lastFingerprint=fp;
      if(device&&!all.includes(device)&&!sending&&!pending){removed.add(device);device=undefined;endpoint=undefined;iface=undefined;epoch++;log('monitor-detached')}
      if(connected()){fresh=null;return}
      if(!matches.length){blocked=false;suppressed=new WeakSet();fresh=null;if(changed)emit({ready:false,needsPermission:true,message:'Подключи Wincor через OTG. Если он уже подключён, нажми «Разрешить доступ»: браузер пока не предоставил устройство приложению.'});return}
      const eligible=matches.filter(d=>!suppressed.has(d));
      // Android can replace the permitted object without a connect event.
      // A previous stale/denied set must not block a genuinely new attachment,
      // but polling must never reopen the objects that already failed.
      if(blocked){if(!changed||!eligible.length)return;blocked=false}
      if(!changed&&!fresh)return;
      const candidate=fresh;fresh=null;attempted=candidate?[candidate]:eligible;
      const result=await searchPrinters({fresh:candidate,enumerated:all.filter(d=>!suppressed.has(d))});
      if(!result.ready){blocked=true;attempted.forEach(d=>suppressed.add(d))}emit(result);
    }catch(error){
      blocked=true;attempted.forEach(d=>suppressed.add(d));fresh=null;log('monitor-error',{error:error.name,message:error.message});
      emit({ready:false,needsPermission:true,message:'Автоподключение остановлено: '+error.message+' Повтор возможен после переподключения OTG или явного разрешения доступа.'});
    }finally{scanning=false;schedule()}
  }
  const attach=e=>{if(!target(e.device)||suppressed.has(e.device))return;const repeated=fresh===e.device;removed.delete(e.device);if(!repeated){epoch++;log('monitor-connect',{device:info(e.device)});fresh=e.device;blocked=false}if(visible())void tick()};
  const detach=e=>{if(!target(e.device))return;suppressed.delete(e.device);removed.add(e.device);epoch++;log('monitor-disconnect',{device:info(e.device)});blocked=false;fresh=null;if(e.device===device){device=undefined;endpoint=undefined;iface=undefined;emit({ready:false,needsPermission:true,message:'Принтер отключён. Подключи Wincor через OTG; доступ будет проверен автоматически.'})}if(visible())void tick()};
  const foreground=()=>{clearTimeout(timer);if(visible())void tick()};
  navigator.usb?.addEventListener?.('connect',attach);navigator.usb?.addEventListener?.('disconnect',detach);
  visibility?.addEventListener?.('visibilitychange',foreground);void tick();
  return ()=>{stopped=true;clearTimeout(timer);navigator.usb?.removeEventListener?.('connect',attach);navigator.usb?.removeEventListener?.('disconnect',detach);visibility?.removeEventListener?.('visibilitychange',foreground)};
}
function available(){
  if(connecting||sending||pending)throw Error('Дождись завершения передачи или закрытия USB');
  if(!navigator.usb)throw Error('WebUSB недоступен. Открой приложение в Chrome на Android по HTTPS.');
}
function channels(d){
  const configurations=d.configurations?.length?d.configurations:[d.configuration].filter(Boolean),result=[];
  for(const c of configurations)for(const i of c.interfaces)for(const a of i.alternates)for(const ep of a.endpoints)
    if(a.interfaceClass===7&&ep.direction==='out'&&ep.type==='bulk')result.push({c,i,a,ep});
  return result;
}
function ensurePresent(d,startEpoch){if(removed.has(d)||epoch!==startEpoch)throw new DOMException('USB изменился во время подключения. Ожидаем стабильное подключение.','NotFoundError')}
async function openPrinter(chosen,reused=false){
  const options=channels(chosen),startEpoch=epoch;
  if(!options.length)return {ready:false,message:'Устройство найдено, но стандартный канал USB-печати отсутствует. Данные не отправлялись.'};
  if(device?.opened)await device.close();
  device=undefined;endpoint=undefined;iface=undefined;
  const failures=[];
  for(const o of options){
    let claimed=false,phase='open';
    try{
      ensurePresent(chosen,startEpoch);log(phase,{device:info(chosen)});
      if(!chosen.opened)await chosen.open();ensurePresent(chosen,startEpoch);
      phase='selectConfiguration';
      if(!chosen.configuration||chosen.configuration.configurationValue!==o.c.configurationValue)await chosen.selectConfiguration(o.c.configurationValue);
      ensurePresent(chosen,startEpoch);phase='claimInterface';await chosen.claimInterface(o.i.interfaceNumber);claimed=true;
      ensurePresent(chosen,startEpoch);phase='selectAlternateInterface';await chosen.selectAlternateInterface(o.i.interfaceNumber,o.a.alternateSetting);ensurePresent(chosen,startEpoch);
      device=chosen;iface=o.i.interfaceNumber;endpoint=o.ep.endpointNumber;log('ready',{device:info(chosen),interface:iface,endpoint});
      return {ready:true,name:chosen.productName||'USB-принтер',message:(reused?'Сохранённый принтер найден: ':'Принтер найден: ')+(chosen.productName||'USB-принтер')+'. Канал USB открыт. Проверь печать одним бланком.',diagnostics:{vendorId:chosen.vendorId,productId:chosen.productId,configuration:o.c.configurationValue,interface:iface,alternate:o.a.alternateSetting,endpoint}};
    }catch(error){
      const failure={phase,configuration:o.c.configurationValue,interface:o.i.interfaceNumber,alternate:o.a.alternateSetting,error:error.name||'Error',message:error.message};failures.push(failure);log('channel-error',failure);
      if(claimed)await chosen.releaseInterface(o.i.interfaceNumber).catch(()=>{});
      if(chosen.opened)await chosen.close();
      if(error.name==='SecurityError'||error.name==='NotAllowedError'||error.name==='NotFoundError')throw error;
    }
  }
  return {ready:false,message:'Принтер найден, но открыть канал USB не удалось. Закрой другие программы печати, переподключи OTG. Подключение будет проверено автоматически.',diagnostics:{attempts:failures}};
}
export async function searchPrinters({fresh,enumerated}={}){
  available();connecting=true;const startEpoch=epoch;
  try{
    const all=enumerated||await navigator.usb.getDevices();log('enumerate',{devices:all.map(info)});
    const candidates=all.filter(d=>target(d)&&channels(d).length&&!removed.has(d));
    // The event object is considered only when it is also currently permitted.
    if(fresh&&candidates.includes(fresh)){ensurePresent(fresh,startEpoch);log('fresh-event-selected',{device:info(fresh)});return await openPrinter(fresh,!!saved())}
    if(!candidates.length)return {ready:false,needsPermission:true,message:'Доступный Wincor не найден. После переподключения Android может потребовать разрешение заново. Нажми «Разрешить доступ к принтеру». Список и его номера показывает Chrome.'};
    const live=[];
    for(const d of candidates){
      ensurePresent(d,startEpoch);log('probe-open',{device:info(d)});
      const wasOpen=d.opened;
      try{if(!wasOpen)await d.open();ensurePresent(d,startEpoch);live.push(d);log('probe-live',{id:id(d)})}
      catch(error){log('probe-error',{id:id(d),error:error.name,message:error.message});if(error.name==='NotFoundError'&&epoch===startEpoch){removed.add(d);continue}throw error}
      finally{if(!wasOpen&&d.opened)await d.close()}
    }
    if(live.length!==1)return {ready:false,needsPermission:true,message:live.length?'Найдено несколько доступных Wincor. Оставь один подключённый принтер или выбери его явно.':'Старые записи недоступны. Разреши доступ к подключённому Wincor заново.'};
    return await openPrinter(live[0],!!saved());
  }finally{connecting=false}
}
export async function connect({useSaved=true}={}){
  if(useSaved&&saved())return searchPrinters();
  available();connecting=true;let chosen;
  try{
    const p=allowedPreference();
    // No await before the chooser: retain the click's transient activation.
    chosen=await navigator.usb.requestDevice({filters:p?[{vendorId:p.vendorId,productId:p.productId,classCode:7}]:[{vendorId:2727,productId:17152,classCode:7}]});
    log('chooser-selected',{device:info(chosen)});if(!target(chosen))throw Error('Выбранное устройство не опознано как WN HighPrint 4915. Подключение не открывалось.');removed.delete(chosen);
    return await openPrinter(chosen);
  }catch(error){
    log('chooser-error',{phase:chosen?'open':'requestDevice',error:error.name,message:error.message});
    if(!chosen&&error.name==='NotFoundError')return {ready:connected(),message:'Выбор отменён. Сохранённый принтер не изменён.'};
    throw error;
  }finally{connecting=false}
}
export async function sendCanvas(canvas,progress,signal){const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);return sendBytes(rasterBytes(data.data,canvas.width,canvas.height),progress,signal)}
export async function sendBytes(bytes,progress=()=>{},signal={cancelled:false},options={}){
  if(sending||pending||connecting)throw Error('Передача уже выполняется. Не отправляй задание повторно.');
  if(!connected())throw Error('Сначала подключи принтер по USB');
  sending=true;const activeDevice=device,activeEndpoint=endpoint,chunkSize=options.testSmallChunks?64:4096,startTime=Date.now();lastTransfer={mode:options.testSmallChunks?'small-chunks-test':'standard',chunkSize,totalBytes:bytes.length,startedAt:new Date().toISOString(),bytesAcknowledged:0,offset:0,status:'sending'};log('transfer-start',{id:id(activeDevice),...lastTransfer});
  try{
    for(let i=0;i<bytes.length;){
      if(removed.has(activeDevice)||device!==activeDevice)throw Error('Принтер отключён во время передачи. Повтор автоматически не запускается.');
      if(signal.cancelled)throw Error('Отправка остановлена. Часть страницы могла попасть в принтер. Не повторяй автоматически.');
      const chunk=bytes.slice(i,i+chunkSize),percent=Math.round(i/bytes.length*100);
      let noticeTimer,deadlineTimer;const requestTime=Date.now();lastTransfer.offset=i;
      // A deadline must not orphan a still-running transfer and permit a second job.
      pending=true;log('transfer-chunk',{id:id(activeDevice),offset:i,requested:chunk.length});
      const transfer=Promise.resolve().then(()=>activeDevice.transferOut(activeEndpoint,chunk));
      let timedOut=false;
      const deadline=new Promise((_,reject)=>{deadlineTimer=setTimeout(()=>{
        timedOut=true;endpoint=undefined;
        const closing=Promise.resolve().then(()=>activeDevice.close());
        // Retain the lock until both the original transfer and close have settled.
        Promise.allSettled([transfer,closing]).then(()=>{pending=false});
        reject(Error('Принтер не принял данные за 2 минуты. USB закрывается. Часть задания могла попасть в принтер; не повторяй печать без проверки очереди.'));
      },120000)});
      noticeTimer=setTimeout(()=>{log('transfer-wait',{offset:i,elapsedMs:Date.now()-requestTime});try{progress(percent,{waiting:true,bytesSent:i,totalBytes:bytes.length,message:`Принято по USB ${i} из ${bytes.length} байт. Ожидаем принтер: проверь бумагу; кабель не отключай.`})}catch{}},15000);
      let result;
      try{result=await Promise.race([transfer,deadline])}finally{clearTimeout(noticeTimer);clearTimeout(deadlineTimer);if(!timedOut)pending=false}
      if(result.status!=='ok'||!Number.isInteger(result.bytesWritten)||result.bytesWritten<=0||result.bytesWritten>chunk.length)throw Error('Ошибка передачи USB. Часть задания могла быть передана; проверь очередь перед повтором.');
      log('transfer-result',{id:id(activeDevice),offset:i,status:result.status,bytesWritten:result.bytesWritten,elapsedMs:Date.now()-requestTime});i+=result.bytesWritten;lastTransfer.bytesAcknowledged=i;lastTransfer.offset=i;progress(Math.round(i/bytes.length*100),{waiting:false,bytesSent:i,totalBytes:bytes.length});
    }
    Object.assign(lastTransfer,{status:'complete',endedAt:new Date().toISOString(),elapsedMs:Date.now()-startTime});log('transfer-complete',{id:id(activeDevice),...lastTransfer});return true;
  }catch(error){Object.assign(lastTransfer,{status:'error',endedAt:new Date().toISOString(),elapsedMs:Date.now()-startTime});log('transfer-error',{id:id(activeDevice),stage:'transferOut',offset:lastTransfer.offset,error:error.name,message:error.message,elapsedMs:lastTransfer.elapsedMs});endpoint=undefined;if(!pending&&activeDevice.opened)await activeDevice.close().catch(()=>{});throw error}finally{sending=false}
}
export async function disconnect(){if(connecting||sending||pending)throw Error('Дождись завершения передачи или закрытия USB');endpoint=undefined;if(device?.opened){try{if(iface!==undefined)await device.releaseInterface(iface)}finally{await device.close()}}iface=undefined}


