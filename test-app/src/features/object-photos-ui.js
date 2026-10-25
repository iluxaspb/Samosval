
(function(){
  const $=id=>document.getElementById('object-photos-'+id),dialog=$('dialog'),service=window.ObjectPhotos;let generation=0,owner='',filter={},rows=[],shown=60,busy=false,observer=null;
  const permitted=()=>currentUserStatus==='active'&&permissionsLoaded&&currentUid===owner&&(canAdmin()||hasTabAccess('archive'));
  const bytes=value=>{const n=Number(value)||0;return n<1048576?(n/1024).toFixed(1)+' КБ':n<1073741824?(n/1048576).toFixed(1)+' МБ':(n/1073741824).toFixed(2)+' ГБ';};
  const say=(text,error=false)=>{$('message').textContent=text;$('message').className=error?'op-error':'';};
  function close(){generation++;observer?.disconnect();observer=null;owner='';rows=[];$('usage').hidden=true;$('usage').replaceChildren();$('grid').replaceChildren();if(dialog.open)dialog.close();}
  const uniqueShiftIds=ids=>[...new Set(ids.filter(id=>typeof id==='string'&&id.length>0))];
  async function open(options={}){
    if(currentUserStatus!=='active'||!permissionsLoaded||!(canAdmin()||hasTabAccess('archive')))return;
    owner=currentUid;
    const photoShiftIds=uniqueShiftIds([...(Array.isArray(options.photoShiftIds)?options.photoShiftIds:[]),options.shiftId]);
    const sourceShiftIds=uniqueShiftIds([...(Array.isArray(options.sourceShiftIds)?options.sourceShiftIds:[]),options.sourceShiftId,...photoShiftIds]);
    filter={...options,photoShiftIds,sourceShiftIds};shown=60;
    if(!dialog.open)dialog.showModal();await refresh();
  }
  async function refresh(){
    if(!permitted()){close();return;}if(busy)return;const token=++generation;say('Загружаем фотографии…');$('title').textContent=filter.name?'Фото · '+filter.name:'Фотографии объектов';$('all').hidden=!filter.objectKey;$('shift').hidden=!filter.sourceShiftIds.length;$('select-label').hidden=$('delete').hidden=!canAdmin();const shiftSelected=!!filter.shiftId||filter.photoShiftIds.length>0;$('all').disabled=!shiftSelected;$('shift').disabled=shiftSelected;
    try{const result=await service.list(filter);if(token!==generation||!permitted())return;rows=result;draw();if(canAdmin())await showUsage(token);else $('usage').hidden=true;}catch(error){if(token===generation){if(!permitted()){close();return;}say(service.message(error),true);}}
  }
  function draw(){
    observer?.disconnect();const visible=rows.slice(0,shown);$('grid').replaceChildren();$('select').checked=false;$('more').hidden=rows.length<=shown;
    if(!rows.length){say('Фотографий пока нет. Они появятся после сохранения снимков на сервере.');return;}say('Фото: '+rows.filter(p=>p.status==='ready').length+' · показано '+visible.length+' из '+rows.length);
    const token=generation;observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){observer.unobserve(entry.target);loadImage(entry.target,entry.target._photo,token);}}),{root:dialog,rootMargin:'120px'}):null;
    for(const photo of visible){const card=document.createElement('article');card.className='op-card';const a=document.createElement('a');a.target='_blank';a.rel='noopener';const img=document.createElement('img');img.alt='Фото: '+photo.objectName;img.loading='lazy';img._photo=photo;a.append(img);card.append(a);
      const body=document.createElement('div');body.className='op-card-body';const title=document.createElement('b');title.textContent=photo.objectName||'Объект';body.append(title);
      const details=document.createElement('div');details.textContent=new Date(photo.capturedAt).toLocaleString('ru-RU')+' · '+resolveUserDisplayName(photo.createdByEmail,photo.createdByName)+' · '+bytes(photo.bytes||photo.pendingSize);body.append(details);
      const state=document.createElement('div');state.textContent=photo.status==='ready'?(photo.noGps?'Без GPS':photo.approximate?'Примерная геопозиция':'С координатами'):photo.status==='deleting'?'Удаление не завершено':photo.status==='error'?'Загрузка не завершена':'Загружается…';body.append(state);
      if(canAdmin()){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.dataset.photoId=photo.id;input.setAttribute('aria-label','Выбрать фото от '+new Date(photo.capturedAt).toLocaleString('ru-RU'));label.append(input,document.createTextNode('Выбрать'));body.append(label);}
      card.append(body);$('grid').append(card);if(photo.status==='ready'){if(observer)observer.observe(img);else loadImage(img,photo,token);}
    }
  }
  async function loadImage(img,photo,token){try{const url=await service.url(photo);if(token!==generation||!permitted()||!img.isConnected)return;img.src=url;img.parentElement.href=url;}catch(e){if(token===generation&&img.isConnected)img.alt='Не удалось загрузить фото: '+service.message(e);}}
  async function showUsage(token){
    const u=await service.usage();if(token!==generation||!permitted()||!canAdmin())return;const used=Number(u.usedBytes)||0,reserved=Number(u.reservedBytes)||0,remaining=Math.max(0,u.limitBytes-used-reserved);$('usage').hidden=false;$('usage').innerHTML='<b>Хранилище фотографий программы</b><div>Сохранено: '+bytes(used)+' · Фото: '+(Number(u.count)||0)+'</div><div>Зарезервировано под загрузки: '+bytes(reserved)+'</div><progress value="'+(used+reserved)+'" max="'+u.limitBytes+'"></progress><div>Свободно в лимите программы: <b>'+bytes(remaining)+'</b> из '+bytes(u.limitBytes)+'</div><div class="op-toolbar"><label>Лимит, МБ <input id="op-storage-limit" type="number" min="16" max="51200" value="'+Math.round(u.limitBytes/1048576)+'" style="width:92px"></label><button type="button" id="op-save-limit" class="btn btn-secondary btn-small">Сохранить лимит</button><button type="button" id="op-inventory" class="btn btn-secondary btn-small">Проверить файлы на сервере</button></div><p id="op-inventory-status" role="status"></p><p class="op-note">Это лимит фотографий внутри программы, а не общий свободный объём Google. Другие файлы, скрытые версии, корзина и тариф учитываются отдельно. <a target="_blank" rel="noopener" href="https://console.firebase.google.com/project/'+encodeURIComponent(firebaseConfig.projectId)+'/storage">Открыть Firebase Storage</a></p>';
    document.getElementById('op-save-limit').onclick=async()=>{try{await service.setLimit(Number(document.getElementById('op-storage-limit').value));await showUsage(token);}catch(e){say(e.message,true);}};
    document.getElementById('op-inventory').onclick=async event=>{const button=event.currentTarget;button.disabled=true;try{const result=await service.inventory(progress=>{if(token===generation)document.getElementById('op-inventory-status').textContent='Проверяем: '+progress.count+' файлов · '+bytes(progress.bytes);});if(token===generation)document.getElementById('op-inventory-status').textContent='Активные файлы фотографий на сервере: '+result.count+' · '+bytes(result.bytes)+'. Проверено '+new Date().toLocaleTimeString('ru-RU');}catch(e){if(token===generation)say(service.message(e),true);}finally{if(button.isConnected)button.disabled=false;}};
    if(u.pending.length){const pending=document.createElement('div');pending.className='op-pending';pending.textContent='На этом устройстве ожидают сохранения: '+u.pending.length;for(const job of u.pending){const row=document.createElement('div');row.textContent=job.meta.name+' · '+bytes(job.size)+(job.error?' · '+job.error:'');const retry=document.createElement('button');retry.className='btn btn-secondary btn-small';retry.textContent='Повторить';retry.onclick=()=>service.retry(job.id);row.append(retry);pending.append(row);}$('usage').append(pending);}
  }
  async function removeSelected(){
    if(busy||!canAdmin()||!permitted())return;const selected=[...$('grid').querySelectorAll('[data-photo-id]:checked')].map(input=>input.dataset.photoId);if(!selected.length){say('Выберите фотографии для удаления.');return;}if(!window.confirm('Удалить выбранные фотографии ('+selected.length+') с сервера? Полученные монеты останутся.'))return;
    busy=true;$('delete').disabled=true;let done=0;try{for(const id of selected){if(!permitted()||!canAdmin())break;await service.remove(id);done++;say('Удалено '+done+' из '+selected.length);}busy=false;await refresh();}catch(e){say('Удалено '+done+' из '+selected.length+'. '+service.message(e),true);}finally{busy=false;$('delete').disabled=false;}
  }
  $('close').onclick=close;$('refresh').onclick=refresh;$('more').onclick=()=>{shown+=60;draw();};$('delete').onclick=removeSelected;$('select').onchange=()=>{$('grid').querySelectorAll('[data-photo-id]').forEach(input=>input.checked=$('select').checked);};
  $('all').onclick=()=>{filter={...filter,shiftId:'',photoShiftIds:[]};shown=60;return refresh();};$('shift').onclick=()=>{filter={...filter,shiftId:'',photoShiftIds:[...filter.sourceShiftIds]};shown=60;return refresh();};dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  window.openObjectPhotos=open;
  window.__attachArchivePhotos=shift=>{
    const body=document.getElementById('modalArchiveBody');if(!body)return;
    const bar=document.createElement('div');bar.className='op-toolbar';
    const sourceShiftIds=uniqueShiftIds([...(Array.isArray(shift.photoShiftIds)?shift.photoShiftIds:[]),shift.sourceShiftId]);
    const settings={name:shift.objectName,objectKey:service.objectKey({objectId:shift.objectId,name:shift.objectName}),sourceShiftId:shift.sourceShiftId||'',sourceShiftIds};
    const all=document.createElement('button');all.type='button';all.className='btn btn-secondary btn-small';all.textContent='📷 Фото объекта';all.onclick=()=>open(settings);bar.append(all);
    if(sourceShiftIds.length){const one=document.createElement('button');one.type='button';one.className=all.className;one.textContent='Фото этой смены';one.onclick=()=>open({...settings,photoShiftIds:sourceShiftIds});bar.append(one);}
    body.prepend(bar);
  };
  document.addEventListener('click',event=>{const button=event.target.closest('[data-photo-object]');if(button)open({name:button.dataset.photoObject,objectKey:service.objectKey({objectId:button.dataset.photoObjectId,name:button.dataset.photoObject})});});
  const adminSettings=document.getElementById('admin-sub-appsettings');if(adminSettings){const section=document.createElement('details');section.className='admin-settings-group';section.id='admin-photo-storage';section.innerHTML='<summary>📷 Фотографии и место <span>Архив объектов, загрузки и очистка</span></summary><div class="form-card"><p class="admin-settings-note">Фотографии сохраняются по объектам и сменам. Здесь можно посмотреть объём, выбрать лимит и удалить ненужные снимки.</p><button type="button" class="btn btn-secondary btn-small">Открыть фотографии и хранилище</button></div>';section.querySelector('button').onclick=()=>open();adminSettings.append(section);}
  setInterval(()=>{if(dialog.open&&!permitted())close();},1000);
})();
