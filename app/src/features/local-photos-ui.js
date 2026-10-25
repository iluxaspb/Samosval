
(function(){
  const $=id=>document.getElementById('local-photos-'+id),dialog=$('dialog'),service=window.ObjectPhotos;let owner='',generation=0,shown=40,observer=null,urls=[],refreshTimer;
  const allowed=()=>permissionsLoaded&&currentUserStatus==='active'&&!!owner&&currentUid===owner;
  const say=text=>$('status').textContent=text;
  function clear(){observer?.disconnect();observer=null;urls.forEach(url=>URL.revokeObjectURL(url));urls=[];$('grid').replaceChildren();}
  function close(){generation++;clearTimeout(refreshTimer);clear();owner='';if(dialog.open)dialog.close();}
  async function open(){if(!currentUid||currentUserStatus!=='active'||!permissionsLoaded)return;owner=currentUid;shown=40;if(!dialog.open)dialog.showModal();await refresh();}
  async function image(card,row,token){try{const saved=await service.localPhoto(row.id);if(token!==generation||!allowed()||!card.isConnected)return;const url=URL.createObjectURL(saved.blob);urls.push(url);card._img.src=url;card._file=new File([saved.blob],window.PhotoFiles.filename(saved.meta),{type:'image/jpeg',lastModified:saved.meta.shotAt});card._download.disabled=false;card._share.hidden=!(navigator.share&&navigator.canShare?.({files:[card._file]}));}catch(e){if(token===generation)card._img.alt='Не удалось прочитать JPEG: '+e.message;}}
  async function refresh(){
    if(!allowed()){close();return;}const token=++generation;clear();say('Читаем снимки с устройства…');
    try{const rows=await service.localPhotos();if(token!==generation||!allowed())return;const count=rows.filter(r=>!r.synced&&!r.remoteDeleted).length,total=rows.reduce((n,r)=>n+r.size,0);say(rows.length?rows.length+' фото · '+(total/1048576).toFixed(1)+' МБ · ждут облака: '+count:'На этом устройстве пока нет сохранённых снимков.');$('more').hidden=rows.length<=shown;
      observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){observer.unobserve(entry.target);image(entry.target,entry.target._row,token);}}),{root:dialog,rootMargin:'150px'}):null;
      for(const row of rows.slice(0,shown)){
        const card=document.createElement('article');card.className='op-card';card._row=row;const img=document.createElement('img');img.className='lp-thumb';img.alt='Фото: '+row.meta.name;img.loading='lazy';card._img=img;card.append(img);
        const body=document.createElement('div');body.className='op-card-body';const title=document.createElement('b');title.textContent=row.meta.name;const info=document.createElement('div');info.textContent=new Date(row.meta.shotAt).toLocaleString('ru-RU')+' · '+(row.size/1048576).toFixed(1)+' МБ';const state=document.createElement('div');state.className='lp-status';state.textContent=row.remoteDeleted?'Локальная копия · из облака удалено':row.synced?'На устройстве и в облаке':row.error?'На устройстве · '+row.error:'На устройстве · ожидает отправки';body.append(title,info,state);
        const actions=document.createElement('div');actions.className='lp-actions';function button(label,handler){const b=document.createElement('button');b.type='button';b.className='btn btn-secondary btn-small';b.textContent=label;b.onclick=handler;actions.append(b);return b;}
        card._download=button('Скачать JPEG',()=>{if(allowed()&&card._file)window.PhotoFiles.download(card._file,card._file.name);});card._download.disabled=true;
        card._share=button('Поделиться',async()=>{if(!allowed()||!card._file)return;try{await navigator.share({files:[card._file]});}catch(e){if(e.name!=='AbortError'&&allowed())say('Меню недоступно. Нажмите «Скачать JPEG».');}});card._share.hidden=true;
        if(!row.synced&&!row.remoteDeleted)button('Отправить',async()=>{try{await service.retry(row.id);say('Синхронизация запущена. Локальная копия остаётся на устройстве.');}catch(e){say(e.message);}});
        if(row.synced||row.remoteDeleted)button('Убрать с устройства',async()=>{if(!allowed()||!window.confirm('Удалить эту локальную копию с устройства?'+(row.synced?' Облачные файлы не изменятся.':' В облаке этой фотографии уже нет.')))return;try{await service.forgetLocal(row.id);await refresh();}catch(e){say(e.message);}});
        body.append(actions);card.append(body);$('grid').append(card);if(observer)observer.observe(card);else image(card,row,token);
      }
    }catch(e){if(token===generation)say('Не удалось открыть локальный альбом: '+e.message);}
  }
  $('close').onclick=close;$('refresh').onclick=refresh;$('more').onclick=()=>{shown+=40;refresh();};$('sync').onclick=async()=>{try{await service.sync();say('Синхронизация запущена. Снимки остаются на устройстве до и после отправки.');}catch(e){say(e.message);}};dialog.addEventListener('cancel',event=>{event.preventDefault();close();});window.openLocalPhotos=open;
  window.addEventListener('object-photos-changed',()=>{if(!dialog.open||!allowed())return;clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,500);});
  const container=document.getElementById('admin-photo-storage')?.querySelector('.form-card');if(container){const b=document.createElement('button');b.type='button';b.className='btn btn-secondary btn-small';b.textContent='▧ Фото на этом устройстве';b.style.margin='8px';b.onclick=open;container.append(b);}
  setInterval(()=>{if(dialog.open&&!allowed())close();},1000);
})();
