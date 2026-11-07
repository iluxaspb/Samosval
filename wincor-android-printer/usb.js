import {rasterBytes} from './core.js';
const SAVED_KEY='wincor-android-printer.usb.v1';
let device,iface,endpoint,connecting=false,sending=false,pending=false;
function saved(){try{const p=JSON.parse(localStorage.getItem(SAVED_KEY));return p&&Number.isInteger(p.vendorId)&&Number.isInteger(p.productId)?p:null}catch{return null}}
export const savedPrinterName=()=>saved()?.name||'';
export function savePrinter(){if(!connected())throw Error('Сначала подключи принтер');const p={vendorId:device.vendorId,productId:device.productId,serialNumber:device.serialNumber||'',name:device.productName||'USB-принтер'};localStorage.setItem(SAVED_KEY,JSON.stringify(p));return p.name}
export function forgetPrinter(){localStorage.removeItem(SAVED_KEY)}
export function onDisconnect(listener){
  const handler=e=>{if(e.device!==device)return;endpoint=undefined;iface=undefined;listener()};
  navigator.usb?.addEventListener?.('disconnect',handler);
  return ()=>navigator.usb?.removeEventListener?.('disconnect',handler);
}
export const connected=()=>!!device?.opened&&endpoint!==undefined&&!pending;
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
async function openPrinter(chosen,reused=false){
  const options=channels(chosen);
  if(!options.length)return {ready:false,message:'Устройство найдено, но стандартный канал USB-печати отсутствует. Данные не отправлялись.'};
  if(device?.opened)await device.close();
  device=chosen;endpoint=undefined;iface=undefined;
  const failures=[];
  for(const o of options){
    let claimed=false;
    try{
      if(!device.opened)await device.open();
      if(!device.configuration||device.configuration.configurationValue!==o.c.configurationValue)await device.selectConfiguration(o.c.configurationValue);
      await device.claimInterface(o.i.interfaceNumber);claimed=true;
      await device.selectAlternateInterface(o.i.interfaceNumber,o.a.alternateSetting);
      iface=o.i.interfaceNumber;endpoint=o.ep.endpointNumber;
      return {ready:true,name:device.productName||'USB-принтер',message:(reused?'Сохранённый принтер найден: ':'Принтер найден: ')+(device.productName||'USB-принтер')+'. Канал USB открыт. Проверь печать одним бланком.',diagnostics:{vendorId:device.vendorId,productId:device.productId,configuration:o.c.configurationValue,interface:iface,alternate:o.a.alternateSetting,endpoint}};
    }catch(error){
      failures.push({configuration:o.c.configurationValue,interface:o.i.interfaceNumber,alternate:o.a.alternateSetting,error:error.name||'Error'});
      if(claimed)await device.releaseInterface(o.i.interfaceNumber).catch(()=>{});
      if(device.opened)await device.close();
    }
  }
  return {ready:false,message:'Принтер найден, но открыть канал USB не удалось. Закрой другие программы печати, переподключи OTG и нажми «Поиск принтера».',diagnostics:{attempts:failures}};
}
export async function searchPrinters(){
  available();connecting=true;
  try{
    const permitted=(await navigator.usb.getDevices()).filter(d=>channels(d).length),preference=saved();
    const matches=preference?permitted.filter(d=>d.vendorId===preference.vendorId&&d.productId===preference.productId&&(d.serialNumber||'')===preference.serialNumber):[];
    const candidates=matches.length===1?matches:permitted;
    if(!candidates.length)return {ready:false,needsPermission:true,message:'Разрешённый принтер не найден. Проверь питание и OTG, затем нажми «Разрешить доступ к принтеру».'};
    if(candidates.length!==1)return {ready:false,needsPermission:true,message:'Найдено несколько принтеров. Оставь подключённым один нужный принтер и повтори поиск или нажми «Выбрать другой принтер».'};
    return await openPrinter(candidates[0],matches.length===1);
  }finally{connecting=false}
}
export async function connect({useSaved=true}={}){
  if(useSaved&&saved())return searchPrinters();
  available();connecting=true;
  try{
    // Must be called synchronously from the click, before getDevices/close/other awaits.
    const chosen=await navigator.usb.requestDevice({filters:[{classCode:7}]});
    return await openPrinter(chosen);
  }catch(error){
    if(error.name==='NotFoundError')return {ready:connected(),message:'Выбор отменён. Сохранённый принтер не изменён.'};
    throw error;
  }finally{connecting=false}
}
export async function sendCanvas(canvas,progress,signal){const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);return sendBytes(rasterBytes(data.data,canvas.width,canvas.height),progress,signal)}
export async function sendBytes(bytes,progress=()=>{},signal={cancelled:false}){
  if(sending||pending||connecting)throw Error('Передача уже выполняется. Не отправляй задание повторно.');
  if(!connected())throw Error('Сначала подключи принтер по USB');
  sending=true;const activeDevice=device,activeEndpoint=endpoint;
  try{
    for(let i=0;i<bytes.length;){
      if(signal.cancelled)throw Error('Отправка остановлена. Часть страницы могла попасть в принтер. Не повторяй автоматически.');
      const chunk=bytes.slice(i,i+4096),percent=Math.round(i/bytes.length*100);
      let noticeTimer,deadlineTimer;
      // A deadline must not orphan a still-running transfer and permit a second job.
      pending=true;
      const transfer=Promise.resolve().then(()=>activeDevice.transferOut(activeEndpoint,chunk));
      let timedOut=false;
      const deadline=new Promise((_,reject)=>{deadlineTimer=setTimeout(()=>{
        timedOut=true;endpoint=undefined;
        const closing=Promise.resolve().then(()=>activeDevice.close());
        // Retain the lock until both the original transfer and close have settled.
        Promise.allSettled([transfer,closing]).then(()=>{pending=false});
        reject(Error('Принтер не принял данные за 2 минуты. USB закрывается. Часть задания могла попасть в принтер; не повторяй печать без проверки очереди.'));
      },120000)});
      noticeTimer=setTimeout(()=>{try{progress(percent,{waiting:true,message:'Ожидаем приём данных принтером. Проверь бумагу и состояние принтера; кабель не отключай.'})}catch{}},15000);
      let result;
      try{result=await Promise.race([transfer,deadline])}finally{clearTimeout(noticeTimer);clearTimeout(deadlineTimer);if(!timedOut)pending=false}
      if(result.status!=='ok'||!Number.isInteger(result.bytesWritten)||result.bytesWritten<=0||result.bytesWritten>chunk.length)throw Error('Ошибка передачи USB. Часть задания могла быть передана; проверь очередь перед повтором.');
      i+=result.bytesWritten;progress(Math.round(i/bytes.length*100),{waiting:false,bytesSent:i,totalBytes:bytes.length});
    }
    return true;
  }catch(error){endpoint=undefined;if(!pending&&activeDevice.opened)await activeDevice.close().catch(()=>{});throw error}finally{sending=false}
}
export async function disconnect(){if(connecting||sending||pending)throw Error('Дождись завершения передачи или закрытия USB');endpoint=undefined;if(device?.opened){try{if(iface!==undefined)await device.releaseInterface(iface)}finally{await device.close()}}iface=undefined}

