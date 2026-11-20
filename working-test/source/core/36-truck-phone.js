/* Phone data is deliberately separate from cached line/catalog payloads. */
let truckPhoneRows=new Map();
async function truckPhoneRequest(body){
 const user=wtAuthUser();if(!user)throw Error('Требуется вход');
 const token=await user.getIdToken();
 const response=await fetch(WORKING_TEST_UBUNTU_API_BASE+'/api/v1/truck-phones',{method:body?'POST':'GET',cache:'no-store',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 if(!response.ok)throw Error('Телефон не сохранён / недоступен (HTTP '+response.status+')');
 const result=await response.json();
 if(wtAuthUser()?.uid!==user.uid||!hasPermission('view_truck_phone'))throw Error('Права изменились');
 truckPhoneRows=new Map(result.phones.map(row=>[row.truckId,row.phone]));
}
async function refreshTruckPhones(){
 truckPhoneRows.clear();
 if(hasPermission('view_truck_phone'))try{await truckPhoneRequest();}catch(e){console.warn('Телефоны недоступны');}
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
