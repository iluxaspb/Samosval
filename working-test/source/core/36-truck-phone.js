/* Phone data is deliberately separate from cached line/catalog payloads. */
let truckPhoneRows=new Map(),truckPhoneSequence=0,truckPhoneWrite=null,truckPhoneModalNode=null;
function resetTruckPhones(){truckPhoneSequence++;truckPhoneRows.clear();truckPhoneWrite=null;}
function truckPhoneEntry(id){const row=truckPhoneRows.get(id);return row?{phone:row.phone||'',driverName:row.driverName==null?null:row.driverName}:null;}
function truckPhoneValidNumber(phone){return typeof phone==='string'&&/^\+[1-9][0-9]{7,14}$/.test(phone);}
// Same input rules as the server: plus, digits, space, brackets and hyphen only.
function truckPhoneNormalizeInput(value){
 const raw=String(value==null?'':value).trim();
 if(!/^[+0-9 ()-]{1,40}$/.test(raw))return '';
 const phone=raw.replace(/[ ()-]/g,'');
 return truckPhoneValidNumber(phone)?phone:'';
}
// null = no name, undefined = rejected name, string = cleaned name (same charset as the server).
function truckPhoneCleanName(value){
 const raw=String(value==null?'':value).trim().replace(/\s+/g,' ');
 if(!raw)return null;
 if(raw.length>80||/[\u0000-\u001F\u007F]/.test(raw)||!/^[\p{L}\p{N} .'-]+$/u.test(raw))return undefined;
 return raw;
}
async function truckPhoneRequest(body){
 const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
 if(!client||!hasPermission('view_truck_phone'))throw Error('Требуется вход и право просмотра');
 // Reads wait for the current write; an older read may never erase its result.
 if(!body&&truckPhoneWrite){await truckPhoneWrite;return;}
 if(body&&truckPhoneWrite)throw Error('Сохранение уже выполняется');
 const sequence=++truckPhoneSequence;
 const patch=body?{truckId:body.truckId,phone:body.phone,driverName:body.driverName==null?null:body.driverName}:null;
 const work=patch?client.submitTruckPhone(patch):client.readTruckPhones();
 if(patch)truckPhoneWrite=work;
 try{
  const result=await work;
  if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch||sequence!==truckPhoneSequence||!hasPermission('view_truck_phone'))throw Error('Сессия или права изменились');
  truckPhoneRows=new Map(result.phones.map(row=>[row.truckId,{phone:row.phone,driverName:row.driverName==null?null:row.driverName}]));
 }catch(error){if(client===nasRuntimeClient&&epoch===nasRuntimeEpoch&&sequence===truckPhoneSequence&&(error.code==='dataset-restored-reload'||error.code==='session-changed'||error.status===403))resetTruckPhones();throw error;}
 finally{if(truckPhoneWrite===work)truckPhoneWrite=null;}
}
async function refreshTruckPhones(){
 if(!hasPermission('view_truck_phone')){resetTruckPhones();return;}
 try{await truckPhoneRequest();renderLine();renderGlobalTrucksManage();}catch(e){console.warn('Телефоны недоступны');}
}
// The line card only carries a small icon: the number lives in the dialog, never in a tel link.
function truckPhoneIcon(t){
 if(!hasPermission('view_truck_phone')||!t)return '';
 const id=escapeHtml(String(t.id==null?'':t.id));
 return `<button class="truck-phone-btn" type="button" onclick="openTruckPhoneModal('${id}')" aria-label="Телефон самосвала" title="Телефон водителя"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7A2 2 0 0 1 22 16.9z"/></svg></button>`;
}
function truckPhoneModalMarkup(view){
 const truck=view.truck||{},entry=truckPhoneEntry(truck.id),phone=entry?entry.phone:'',name=entry&&entry.driverName?entry.driverName:'';
 const head=`<div class="tp-head"><div><div class="tp-title">Телефон водителя</div><div class="tp-sub">${escapeHtml(String(truck.brand||''))} ${escapeHtml(String(truck.number||''))}</div></div><button type="button" class="tp-close" data-tp="close" aria-label="Закрыть">×</button></div>`;
 if(view.editing)return head+`<form class="tp-form" novalidate><label class="tp-label">Телефон<input class="form-control" data-tp="phone" type="tel" inputmode="tel" maxlength="40" placeholder="+7 999 123-45-67" value="${escapeHtml(phone)}"></label><label class="tp-label">Имя водителя<input class="form-control" data-tp="driver" type="text" maxlength="80" placeholder="Имя водителя" value="${escapeHtml(name)}"></label><p class="tp-error" data-tp="error" role="alert"></p><div class="tp-actions"><button type="submit" class="btn btn-quick" data-tp="save">Сохранить</button><button type="button" class="btn btn-secondary" data-tp="cancel">Отмена</button></div></form>`;
 const rows=`<div class="tp-rows"><div class="tp-row"><span class="tp-row-label">Водитель</span><span class="tp-row-value" data-tp="name">${escapeHtml(name||'Имя не указано')}</span></div><div class="tp-row"><span class="tp-row-label">Телефон</span><span class="tp-row-value" data-tp="phone-value">${escapeHtml(phone||'Телефон не добавлен')}</span></div></div>`;
 const call=hasPermission('call_truck_phone')&&truckPhoneValidNumber(phone)?`<a class="btn btn-quick tp-call" data-tp="call" href="tel:${escapeHtml(phone)}">📞 Позвонить</a>`:'';
 const edit=hasPermission('add_truck_phone')?'<button type="button" class="btn btn-secondary" data-tp="edit">Изменить/добавить</button>':'';
 return head+rows+`<div class="tp-actions">${call}${edit}</div>`;
}
function closeTruckPhoneModal(){
 const node=truckPhoneModalNode;truckPhoneModalNode=null;
 if(node&&node.remove)node.remove();
}
function openTruckPhoneModal(id,options){
 if(!hasPermission('view_truck_phone'))return;
 const truck=typeof findTruck==='function'?findTruck(id):null;
 if(!truck)return;
 closeTruckPhoneModal();
 const overlay=document.createElement('div');
 overlay.className='tp-overlay';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');
 const card=document.createElement('div');card.className='tp-card';
 overlay.appendChild(card);
 const view={truck,editing:!!(options&&options.edit)&&hasPermission('add_truck_phone')};
 const draw=focus=>{
  card.innerHTML=truckPhoneModalMarkup(view);
  const pick=selector=>card.querySelector(selector);
  const close=pick('[data-tp=close]');if(close)close.onclick=closeTruckPhoneModal;
  const cancel=pick('[data-tp=cancel]');if(cancel)cancel.onclick=closeTruckPhoneModal;
  const edit=pick('[data-tp=edit]');
  if(edit)edit.onclick=()=>{view.editing=true;draw(true);};
  const form=pick('form');
  if(form)form.onsubmit=async event=>{
   event.preventDefault();
   const phoneField=pick('[data-tp=phone]'),nameField=pick('[data-tp=driver]'),errorNode=pick('[data-tp=error]'),saveBtn=pick('[data-tp=save]');
   const phone=truckPhoneNormalizeInput(phoneField?phoneField.value:'');
   if(!phone){if(errorNode)errorNode.textContent='Введите номер: плюс и 8–15 цифр';return;}
   const driverName=truckPhoneCleanName(nameField?nameField.value:'');
   if(driverName===undefined){if(errorNode)errorNode.textContent='Имя: буквы, цифры, пробел, точка, дефис, апостроф — до 80 символов';return;}
   if(saveBtn)saveBtn.disabled=true;
   try{
    await truckPhoneRequest({truckId:view.truck.id,phone,driverName});
    view.editing=false;draw(false);
    if(typeof renderLine==='function')renderLine();
    if(typeof renderGlobalTrucksManage==='function')renderGlobalTrucksManage();
   }catch(error){if(errorNode)errorNode.textContent=error&&error.message?error.message:'Не удалось сохранить номер';}
   finally{if(saveBtn)saveBtn.disabled=false;}
  };
  if(focus){const first=pick('[data-tp=phone]');if(first&&first.focus)first.focus();}
 };
 overlay.addEventListener('click',event=>{if(event.target===overlay)closeTruckPhoneModal();});
 document.body.appendChild(overlay);
 truckPhoneModalNode=overlay;
 draw(view.editing);
}
// Kept as the entry point for the "add a number" buttons of earlier releases.
function addTruckPhone(id){
 if(!hasPermission('view_truck_phone')||!hasPermission('add_truck_phone'))return;
 openTruckPhoneModal(id,{edit:true});
}
