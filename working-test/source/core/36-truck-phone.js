/* Phone data is deliberately separate from cached line/catalog payloads. */
let truckPhoneRows=new Map(),truckPhoneSequence=0,truckPhoneWrite=null;
function resetTruckPhones(){truckPhoneSequence++;truckPhoneRows.clear();truckPhoneWrite=null;}
async function truckPhoneRequest(body){
 const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
 if(!client||!hasPermission('view_truck_phone'))throw Error('Требуется вход и право просмотра');
 // Reads wait for the current write; an older read may never erase its result.
 if(!body&&truckPhoneWrite){await truckPhoneWrite;return;}
 if(body&&truckPhoneWrite)throw Error('Сохранение уже выполняется');
 const sequence=++truckPhoneSequence;
 const work=body?client.submitTruckPhone(body):client.readTruckPhones();
 if(body)truckPhoneWrite=work;
 try{
  const result=await work;
  if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch||sequence!==truckPhoneSequence||!hasPermission('view_truck_phone'))throw Error('Сессия или права изменились');
  truckPhoneRows=new Map(result.phones.map(row=>[row.truckId,row.phone]));
 }catch(error){if(client===nasRuntimeClient&&epoch===nasRuntimeEpoch&&sequence===truckPhoneSequence&&(error.code==='dataset-restored-reload'||error.code==='session-changed'||error.status===403))resetTruckPhones();throw error;}
 finally{if(truckPhoneWrite===work)truckPhoneWrite=null;}
}
async function refreshTruckPhones(){
 if(!hasPermission('view_truck_phone')){resetTruckPhones();return;}
 try{await truckPhoneRequest();renderLine();renderGlobalTrucksManage();}catch(e){console.warn('Телефоны недоступны');}
}
function truckPhoneMarkup(t){
 if(!hasPermission('view_truck_phone'))return '';
 const phone=truckPhoneRows.get(t.id);
 if(phone&&/^\+[1-9][0-9]{7,14}$/.test(phone))return hasPermission('call_truck_phone')?`<a class="btn truck-phone" href="tel:${phone}">☎ Позвонить ${phone}</a>`:`<span>${phone}</span>`;
 return hasPermission('call_truck_phone')&&hasPermission('add_truck_phone')?`<button class="btn truck-phone" onclick="addTruckPhone('${escapeHtml(t.id)}')">☎ Позвонить — добавить номер</button>`:'';
}
async function addTruckPhone(id){
 if(!hasPermission('view_truck_phone')||!hasPermission('add_truck_phone'))return;
 const dialog=document.createElement('dialog');
 dialog.innerHTML='<form><h3>Добавить номер телефона</h3><label>Телефон в международном формате<input name="phone" type="tel" maxlength="40" placeholder="+7 999 123-45-67" required></label><p role="alert"></p><button type="submit">Сохранить</button><button type="button">Отмена</button></form>';
 document.body.append(dialog);dialog.showModal();
 dialog.querySelector('[type=button]').onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();
 dialog.querySelector('form').onsubmit=async event=>{
  event.preventDefault();const button=dialog.querySelector('[type=submit]'),error=dialog.querySelector('[role=alert]');
  const phone=dialog.querySelector('input').value;
  if(!/^[+0-9 ()-]{1,40}$/.test(phone)||!/^\+[1-9][0-9]{7,14}$/.test(phone.replace(/[ ()-]/g,''))){error.textContent='Введите международный номер с + и 8–15 цифрами';return;}
  button.disabled=true;
  try{await truckPhoneRequest({truckId:id,phone});dialog.close();renderLine();renderGlobalTrucksManage();}
  catch(e){error.textContent=e.message;}finally{button.disabled=false;}
 };
}
