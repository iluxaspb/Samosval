
(function(){
  'use strict';
  const ROOT='workspaces/'+WORKSPACE_ID+'/objectPhotos',MAX_FILE=12*1024*1024,DEFAULT_LIMIT=512*1024*1024;
  const base=db.collection('workspaces').doc(WORKSPACE_ID),photos=base.collection('objectPhotos'),usageRef=base.collection('photoStorage').doc('usage');
  const running=new Map(),tasks=new Map(),serial=new Map(),versions=new Map();let storePromise=null,storageInstance=null;
  const active=()=>permissionsLoaded&&currentUserStatus==='active'&&!!currentUid;
  const admin=()=>active()&&canAdmin();
  const objectKey=meta=>meta.objectId?'id:'+meta.objectId:'name:'+meta.name;
  const limit=()=>Math.max(16*1024*1024,Number(appConfig?.photoStorageLimitBytes)||DEFAULT_LIMIT);
  const tx=callback=>(window.__historyRawTransaction||db.runTransaction.bind(db))(callback);
  function fail(message,code){const e=new Error(message);e.code=code;return e;}
  function guard(job){if(!admin()||currentUid!==job.uid)throw fail('Доступ к загрузке изменился. Войдите под автором снимка.','photo/access');}
  function storage(){if(!firebase.storage)throw fail('Модуль хранилища не загрузился. Обновите страницу.','photo/sdk');if(!storageInstance){storageInstance=firebase.storage();storageInstance.setMaxUploadRetryTime(20000);storageInstance.setMaxOperationRetryTime(12000);}return storageInstance;}
  function database(){
    if(!storePromise)storePromise=new Promise((resolve,reject)=>{const request=indexedDB.open('samosval-object-photos:'+firebaseConfig.projectId+':'+WORKSPACE_ID,1);request.onupgradeneeded=()=>request.result.createObjectStore('jobs',{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('Не удалось сохранить фото на устройстве. Скачайте снимок.'));});return storePromise;
  }
  async function local(action,value){const databaseRef=await database();return new Promise((resolve,reject)=>{const transaction=databaseRef.transaction('jobs',action==='get'||action==='all'?'readonly':'readwrite'),store=transaction.objectStore('jobs');const request=action==='get'?store.get(value):action==='all'?store.getAll():action==='delete'?store.delete(value):store.put(value);transaction.oncomplete=()=>resolve(request.result);transaction.onerror=()=>reject(transaction.error||new Error('Ошибка сохранения фото на устройстве'));transaction.onabort=()=>reject(transaction.error||new Error('Запись фото отменена'));});}
  async function settleLocal(job,error){const databaseRef=await database();return new Promise((resolve,reject)=>{const transaction=databaseRef.transaction('jobs','readwrite'),store=transaction.objectStore('jobs'),request=store.get(job.id);let newer=false;request.onsuccess=()=>{const latest=request.result;newer=!!latest&&latest.revision!==job.revision;if(latest?.revision===job.revision){if(error)store.put({...latest,error:message(error),errorCode:error.code||''});else store.put({...latest,synced:true,syncedAt:Date.now(),error:'',errorCode:''});}};transaction.oncomplete=()=>resolve(newer);transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);});}
  function message(error){const code=error?.code||'';if(code==='storage/unauthorized')return 'Firebase Storage не разрешает загрузку. Нужно проверить правила хранилища.';if(code==='storage/bucket-not-found'||code==='storage/project-not-found')return 'Хранилище фотографий Firebase ещё не подключено.';if(code==='storage/quota-exceeded')return 'Лимит Firebase исчерпан. Проверьте хранилище в настройках.';if(code==='storage/retry-limit-exceeded')return 'Нет устойчивого соединения с хранилищем. Фото осталось в очереди.';return error?.message||'Не удалось сохранить фото на сервере.';}
  function emit(job,state,text,retry=false){window.dispatchEvent(new CustomEvent('object-photo-progress',{detail:{id:job.id,uid:job.uid,state,message:text,retry}}));window.dispatchEvent(new Event('object-photos-changed'));}
  function record(job){const m=job.meta;return {photoId:job.id,objectKey:objectKey(m),objectId:m.objectId||'',objectName:m.name,shiftId:m.shiftId,createdByUid:job.uid,createdByEmail:job.email,createdByName:job.name,capturedAt:m.shotAt,native:!!m.native,noGps:!!m.noGps,approximate:!!m.approximate,latitude:m.noGps?null:m.latitude,longitude:m.noGps?null:m.longitude,accuracy:m.noGps?null:m.accuracy,gpsTimestamp:m.noGps?null:m.timestamp};}
  function path(job){return ROOT+'/'+encodeURIComponent(objectKey(job.meta))+'/'+encodeURIComponent(job.meta.shiftId)+'/'+job.id+'/image.jpg';}
  async function reserve(job){
    guard(job);return tx(async transaction=>{guard(job);const ref=photos.doc(job.id),[p,u]=await Promise.all([transaction.get(ref),transaction.get(usageRef)]),d=p.exists?p.data():{},usage=u.exists?u.data():{};
      if(d.status==='deleted'||d.status==='deleting')throw fail('Этот снимок удалён администратором.','photo/deleted');
      if(d.createdByUid&&d.createdByUid!==job.uid)throw fail('У снимка другой автор.','photo/access');
      if(d.status==='ready'&&d.version>=job.revision)return {skip:true};
      const bytes=Number(d.bytes)||0,reserved=Number(d.reserveBytes)||0,extra=Math.max(0,job.blob.size-bytes),delta=extra-reserved;
      if(delta>0&&(Number(usage.usedBytes)||0)+(Number(usage.reservedBytes)||0)+delta>limit())throw fail('Достигнут лимит фотографий программы. Очистите снимки или измените лимит в настройках.','photo/limit');
      transaction.set(ref,{...record(job),path:path(job),status:'uploading',bytes,reserveBytes:extra,pendingSize:job.blob.size,uploadVersion:job.revision,createdAt:d.createdAt||Date.now(),updatedAt:Date.now(),counted:!!d.counted},{merge:true});
      transaction.set(usageRef,{usedBytes:Number(usage.usedBytes)||0,reservedBytes:Math.max(0,(Number(usage.reservedBytes)||0)+delta),count:Number(usage.count)||0,updatedAt:Date.now()},{merge:true});return {skip:false};
    });
  }
  async function finalize(job,metadata){
    guard(job);return tx(async transaction=>{guard(job);const ref=photos.doc(job.id),auditRef=refs.audit.doc('photo_'+job.id),[p,u,a]=await Promise.all([transaction.get(ref),transaction.get(usageRef),transaction.get(auditRef)]);if(!p.exists)throw fail('Запись снимка не найдена.','photo/missing');const d=p.data(),usage=u.exists?u.data():{};
      if(d.status==='deleted'||d.status==='deleting'||d.uploadVersion!==job.revision)throw fail('Состояние снимка изменилось.','photo/revision');
      const actual=Number(metadata.size);if(!Number.isFinite(actual)||actual!==job.blob.size||metadata.customMetadata?.photoId!==job.id||metadata.customMetadata?.revision!==String(job.revision))throw fail('Хранилище не подтвердило целостность снимка.','photo/metadata');
      transaction.set(ref,{status:'ready',bytes:actual,reserveBytes:0,version:job.revision,counted:true,error:'',updatedAt:Date.now()},{merge:true});
      transaction.set(usageRef,{usedBytes:Math.max(0,(Number(usage.usedBytes)||0)+actual-(Number(d.bytes)||0)),reservedBytes:Math.max(0,(Number(usage.reservedBytes)||0)-(Number(d.reserveBytes)||0)),count:(Number(usage.count)||0)+(d.counted?0:1),updatedAt:Date.now()},{merge:true});
      if(!a.exists)transaction.set(auditRef,{eventType:'game_photo',amount:1,photoId:job.id,userEmail:job.email,userName:job.name,createdByEmail:job.email,createdByUid:job.uid,shiftId:job.meta.shiftId,objectId:job.meta.objectId||'',objectName:job.meta.name,timestamp:job.meta.shotAt,storedAt:Date.now(),text:'📷 Фото сохранено в объекте · +1 монета'});
      return {awarded:!a.exists};
    });
  }
  async function markError(job,error){try{await tx(async transaction=>{guard(job);const ref=photos.doc(job.id),p=await transaction.get(ref);if(p.exists&&p.data().uploadVersion===job.revision&&p.data().status==='uploading')transaction.set(ref,{status:'error',error:message(error),updatedAt:Date.now()},{merge:true});});}catch(e){}}
  async function upload(job){
    guard(job);if(!navigator.onLine)throw fail('Нет связи. Фото сохранено на устройстве и ждёт загрузки.','photo/offline');
    await window.PhotoFiles.validate(job.blob);guard(job);const reserved=await reserve(job);if(reserved.skip)return {awarded:false};const ref=storage().ref(path(job));let metadata=null;
    try{const existing=await ref.getMetadata();if(existing.customMetadata?.photoId===job.id&&existing.customMetadata?.revision===String(job.revision)&&Number(existing.size)===job.blob.size)metadata=existing;}catch(e){if(e.code!=='storage/object-not-found')throw e;}
    if(!metadata){guard(job);const task=ref.put(job.blob,{contentType:'image/jpeg',customMetadata:{photoId:job.id,revision:String(job.revision),uid:job.uid,objectKey:objectKey(job.meta),shiftId:job.meta.shiftId}});tasks.set(job.id,{uid:job.uid,task});task.on('state_changed',snapshot=>{if(admin()&&currentUid===job.uid)emit(job,'uploading','На устройстве сохранено · облако '+Math.round(snapshot.bytesTransferred/Math.max(1,snapshot.totalBytes)*100)+'%');});try{metadata=(await task).metadata;}finally{tasks.delete(job.id);}}
    return finalize(job,metadata);
  }
  function run(id){
    if(running.has(id))return running.get(id);
    const promise=(async()=>{while(admin()){
      const job=await local('get',id);if(!job||job.uid!==currentUid||job.error||job.synced||job.remoteDeleted)return;
      try{emit(job,'uploading','На устройстве сохранено · отправляем в облако…');const result=await upload(job);guard(job);const newer=await settleLocal(job,null);if(result.awarded)window.__gamePhotoSaved?.(job.id);emit(job,'ready','Сохранено на устройстве и в облаке'+(result.awarded&&appConfig?.testReviewFlags?.game_mode!==false?' · 🪙 +1':''));if(!newer)return;}
      catch(error){await markError(job,error);const newer=await settleLocal(job,error);if(newer)continue;emit(job,'error','На устройстве сохранено · '+message(error),true);return;}
    }})().catch(error=>console.warn('[photos]',error)).finally(async()=>{running.delete(id);try{const latest=await local('get',id);if(admin()&&latest?.uid===currentUid&&!latest.error&&!latest.synced&&!latest.remoteDeleted)run(id);}catch(e){}});running.set(id,promise);return promise;
  }
  async function queue(blob,meta){
    if(!admin())throw fail('Снимать и сохранять фото может активный администратор.','photo/access');
    if(!meta.id||!meta.shiftId||!meta.name||!blob?.size||blob.size>MAX_FILE||blob.type!=='image/jpeg')throw fail('Фото должно быть JPEG до 12 МБ и относиться к объекту и смене.','photo/invalid');
    const uid=currentUid,email=currentEmail,name=getUserName(),id=meta.id;await window.PhotoFiles.validate(blob);
    const promise=(serial.get(id)||Promise.resolve()).catch(()=>{}).then(async()=>{if(!admin()||currentUid!==uid)throw fail('Учётная запись изменилась.','photo/access');const old=await local('get',id);const job={id,uid,email,name,blob,meta:{...meta},revision:Math.max(old?.revision||0,versions.get(id)||0,Date.now())+1,queuedAt:Date.now(),savedAt:Date.now(),synced:false,error:''};versions.set(id,job.revision);await local('put',job);const saved=await local('get',id);if(!saved?.blob||saved.blob.size!==blob.size)throw fail('Не удалось подтвердить сохранение на устройстве. Скачайте JPEG.','photo/local');emit(job,'queued',navigator.onLine?'Сохранено на устройстве · ожидает отправки в облако':'Сохранено на устройстве · отправим после восстановления связи');setTimeout(()=>run(id),0);return id;});serial.set(id,promise);try{return await promise;}finally{if(serial.get(id)===promise)serial.delete(id);}
  }
  async function retry(id){if(!admin())return;const job=await local('get',id);if(!job||job.uid!==currentUid||job.synced||job.remoteDeleted)return;await local('put',{...job,error:'',errorCode:''});run(id);}
  async function flush(retryNetwork=false){if(!admin())return;for(const job of await local('all'))if(job.uid===currentUid&&!job.synced&&!job.remoteDeleted){if(retryNetwork&&['photo/offline','storage/retry-limit-exceeded','storage/unknown','unavailable'].includes(job.errorCode)){await local('put',{...job,error:'',errorCode:''});run(job.id);}else if(!job.error)run(job.id);}}
  async function pending(){if(!admin())return [];return (await local('all')).filter(job=>job.uid===currentUid&&!job.synced&&!job.remoteDeleted).map(({blob,...job})=>({...job,size:blob.size}));}
  async function localPhotos(){if(!active())return [];const uid=currentUid;const rows=await local('all');if(!active()||currentUid!==uid)return [];return rows.filter(job=>job.uid===uid).map(({blob,...job})=>({...job,size:blob.size})).sort((a,b)=>b.meta.shotAt-a.meta.shotAt);}
  async function localPhoto(id){const uid=currentUid;if(!active())throw fail('Войдите в программу.','photo/access');const job=await local('get',id);if(!active()||currentUid!==uid||job?.uid!==uid)throw fail('Нет доступа к локальному фото.','photo/access');return job;}
  async function forgetLocal(id){const job=await localPhoto(id);if(!job.synced&&!job.remoteDeleted)throw fail('Сначала сохраните фото в облаке или скачайте его. Неотправленный снимок остаётся на устройстве.','photo/pending');if(running.has(id))throw fail('Дождитесь завершения загрузки.','photo/busy');await local('delete',id);window.dispatchEvent(new Event('object-photos-changed'));}
  async function sync(){await flush(true);}
  async function hasShift(id){if((await localPhotos()).some(job=>job.meta.shiftId===id))return true;const result=await photos.where('shiftId','==',id).get();return result.docs.some(doc=>doc.data().status!=='deleted');}
  async function list(filter={}){if(!active()||!(canAdmin()||hasTabAccess('archive')))throw fail('Нет доступа к фотографиям.','photo/access');let query=photos;if(filter.objectKey)query=query.where('objectKey','==',filter.objectKey);const result=await query.get();return result.docs.map(doc=>({id:doc.id,...doc.data()})).filter(p=>p.status!=='deleted'&&(!filter.shiftId||p.shiftId===filter.shiftId)).sort((a,b)=>b.capturedAt-a.capturedAt);}
  async function usage(){if(!admin())throw fail('Нет прав администратора.','photo/access');const snap=await usageRef.get({source:'server'});return {...(snap.exists?snap.data():{}),limitBytes:limit(),pending:await pending()};}
  async function url(photo){if(!active()||!(canAdmin()||hasTabAccess('archive')))throw fail('Нет доступа к фото.','photo/access');if(!photo.path?.startsWith(ROOT+'/'))throw fail('Неверный путь снимка.','photo/path');return storage().ref(photo.path).getDownloadURL();}
  async function remove(id){
    if(!admin())throw fail('Нет прав администратора.','photo/access');if(running.has(id))throw fail('Фото ещё загружается. Дождитесь завершения.','photo/busy');const actor=currentUid;
    const data=await tx(async transaction=>{if(!admin()||currentUid!==actor)throw fail('Доступ изменился.','photo/access');const ref=photos.doc(id),snap=await transaction.get(ref);if(!snap.exists)return null;const d=snap.data();if(d.status==='deleted')return null;if(d.status==='uploading'&&Date.now()-d.updatedAt<15*60*1000)throw fail('Фото ещё загружается на другом устройстве. Попробуйте позже.','photo/busy');transaction.set(ref,{status:'deleting',updatedAt:Date.now()},{merge:true});return d;});
    if(data){if(!data.path?.startsWith(ROOT+'/'))throw fail('Неверный путь снимка.','photo/path');try{await storage().ref(data.path).delete();}catch(e){if(e.code!=='storage/object-not-found')throw e;}
      await tx(async transaction=>{if(!admin()||currentUid!==actor)throw fail('Доступ изменился.','photo/access');const ref=photos.doc(id),[p,u]=await Promise.all([transaction.get(ref),transaction.get(usageRef)]);if(!p.exists||p.data().status==='deleted')return;const d=p.data(),usage=u.exists?u.data():{};transaction.set(ref,{status:'deleted',bytes:0,reserveBytes:0,counted:false,deletedAt:Date.now(),deletedBy:actor},{merge:true});transaction.set(usageRef,{usedBytes:Math.max(0,(Number(usage.usedBytes)||0)-(Number(d.bytes)||0)),reservedBytes:Math.max(0,(Number(usage.reservedBytes)||0)-(Number(d.reserveBytes)||0)),count:Math.max(0,(Number(usage.count)||0)-(d.counted?1:0)),updatedAt:Date.now()},{merge:true});});
    }
    const localJob=await local('get',id);if(localJob?.uid===actor)await local('put',{...localJob,remoteDeleted:true,synced:false,error:'Фото удалено из облака. Локальная копия сохранена.'});window.dispatchEvent(new Event('object-photos-changed'));
  }
  async function inventory(onProgress=()=>{}){
    if(!admin())throw fail('Нет прав администратора.','photo/access');const actor=currentUid,folders=[storage().ref(ROOT)];let bytes=0,count=0;
    while(folders.length){const folder=folders.shift();let pageToken;
      do{if(!admin()||currentUid!==actor)throw fail('Доступ изменился.','photo/access');const page=await folder.list({maxResults:100,...(pageToken?{pageToken}:{})});folders.push(...page.prefixes);for(const ref of page.items){const meta=await ref.getMetadata();bytes+=Number(meta.size)||0;count++;onProgress({bytes,count});}pageToken=page.nextPageToken;}while(pageToken);
    }return {bytes,count,checkedAt:Date.now()};
  }
  async function setLimit(megabytes){if(!admin()||!Number.isFinite(megabytes)||megabytes<16||megabytes>51200)throw new Error('Укажите лимит от 16 до 51 200 МБ.');const photoStorageLimitBytes=Math.round(megabytes*1024*1024);await appConfigRef.set({photoStorageLimitBytes},{merge:true});appConfig.photoStorageLimitBytes=photoStorageLimitBytes;}
  window.ObjectPhotos={queue,retry,pending,localPhotos,localPhoto,forgetLocal,sync,hasShift,list,usage,url,remove,inventory,setLimit,objectKey,limit,message};
  window.addEventListener('online',()=>flush(true).catch(()=>{}));window.addEventListener('focus',()=>flush(true).catch(()=>{}));let lastRetry=0;
  let lastOwner='';setInterval(()=>{const owner=admin()?currentUid:'';for(const {uid,task} of tasks.values())if(uid!==owner)task.cancel();if(owner&&navigator.onLine&&Date.now()-lastRetry>30000){lastRetry=Date.now();flush(true).catch(()=>{});}if(owner!==lastOwner){lastOwner=owner;if(owner)flush().catch(()=>{});}},1500);
})();
