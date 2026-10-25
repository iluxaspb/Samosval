(function(){
  'use strict';
  const $=id=>document.getElementById('geo-photo-'+id),dialog=$('dialog'),video=$('video');
  const MAX_FIX_AGE=30000,MAX_EDGE=3072;
  let session=0,owner='',stream=null,watch=null,locationRequest=0,ticker=null,fix=null,mode='closed',cameraError='',gpsError='',resultURL='',resultFile=null;
  let caps={},cameraSettings={},applied={},controlBusy=false,settleUntil=0,selectedDevice='',imageCapture=null,cameraNote='',photoSource=null,photoMeta=null,turns=0,build=0,nativeContext=null,locationCoarse=false,locationStarted=0,locationBlocked=false,previewTurns=0,settingsOpen=false;
  let cameraList=[],lensMap={},focusFeedback='',focusUntil=0,focusAttempt=0;
  const pauseFor=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function loadLenses(){try{lensMap=JSON.parse(localStorage.getItem('samosval-camera-lenses')||'{}');}catch(e){lensMap={};}}
  function saveLenses(){try{localStorage.setItem('samosval-camera-lenses',JSON.stringify(lensMap));}catch(e){}}
  function feedback(text,failed=false){focusFeedback=text;focusUntil=Date.now()+7000;$('focus-ring').dataset.state=failed?'unsupported':'requested';render();}
  function lensDevice(n){return (cameraList.some(d=>d.deviceId===lensMap[String(n)])?lensMap[String(n)]:'')||(n===.6?cameraList.find(d=>/ultra[ -]?wide|сверхшир|0[.,][56]/i.test(d.label))?.deviceId:n===1?cameraList.find(d=>/back|rear|задн/i.test(d.label)&&!/ultra|сверх|tele|теле/i.test(d.label))?.deviceId:'')||'';}
  function renderLenses(){
    const activeId=cameraSettings.deviceId||selectedDevice;
    for(const n of [.6,1]){const button=$('lens-'+String(n).replace('.',''));const device=lensDevice(n),hardwareZoom=range(caps.zoom)&&n>=caps.zoom.min&&n<=caps.zoom.max;button.disabled=mode!=='preview'||controlBusy;button.dataset.available=String(!!device||hardwareZoom||n===1);button.setAttribute('aria-pressed',String(!!device&&activeId===device&&(!range(caps.zoom)||Math.abs((cameraSettings.zoom||1)-1)<.05)||!device&&hardwareZoom&&Math.abs(cameraSettings.zoom-n)<.05));}
  }
  async function chooseLens(n){
    if(mode!=='preview'||controlBusy)return;const device=lensDevice(n);
    if(device){if((cameraSettings.deviceId||selectedDevice)===device){if(range(caps.zoom)&&caps.zoom.min<=1&&caps.zoom.max>=1)await applyControl({zoom:1},'Выбран объектив '+n+'×.');return;}selectedDevice=device;previewTurns=0;await begin();return;}
    if(range(caps.zoom)&&n>=caps.zoom.min&&n<=caps.zoom.max){await applyControl({zoom:n},'Масштаб '+n+'× передан камере.');return;}
    if(n===1){selectedDevice='';await begin();return;}
    settingsOpen=true;feedback('Выберите камеру для 0,6× в настройках. Если её нет в списке, используйте «Камера телефона».',true);$('lens-ultra').focus();
  }
  async function freshVideoFrame(){
    if(video.readyState<2||!video.videoWidth)throw new Error('Камера ещё не передала кадр. Подождите и повторите.');
    if(typeof video.requestVideoFrameCallback==='function')await new Promise((resolve,reject)=>{let handle;const timer=setTimeout(()=>{video.cancelVideoFrameCallback?.(handle);reject(new Error('Не удалось получить свежий кадр. Используйте камеру телефона.'));},1800);handle=video.requestVideoFrameCallback(()=>{clearTimeout(timer);resolve();});});
    else await pauseFor(100);
  }
  async function captureFrame(token){
    let firstError;
    if(imageCapture?.grabFrame)try{const bitmap=await imageCapture.grabFrame();try{if(!live(token))throw new Error('Съёмка закрыта');return copyPhoto(bitmap,bitmap.width,bitmap.height);}finally{bitmap.close?.();}}catch(e){firstError=e;}
    await freshVideoFrame();if(!live(token))throw new Error('Съёмка закрыта');return copyPhoto(video,video.videoWidth,video.videoHeight);
  }
  function noGps(){return !!$('no-gps').checked;}
  function photoId(){return 'photo_'+Date.now().toString(36)+'_'+(crypto.randomUUID?.()||Math.random().toString(36).slice(2));}
  function allowed(){return canAdmin()&&!!currentUid&&currentUid===owner;}
  function live(token){return token===session&&dialog.open&&allowed();}
  function track(){return stream?.getVideoTracks()[0];}
  function context(){const shift=state.shift;if(!shift?.id)return null;const name=String((state.objects||[]).find(o=>o.id===shift.objectId)?.name||shift.objectName||'').trim();return name?{shiftId:shift.id,objectId:shift.objectId||'',name}:null;}
  function validFix(position,now=Date.now(),coarse=false){const c=position?.coords,t=position?.timestamp;if(!c||!Number.isFinite(c.latitude)||Math.abs(c.latitude)>90||!Number.isFinite(c.longitude)||Math.abs(c.longitude)>180||!Number.isFinite(c.accuracy)||c.accuracy<0||!Number.isFinite(t)||t>now+1000||now-t>MAX_FIX_AGE)return null;return {latitude:c.latitude,longitude:c.longitude,accuracy:c.accuracy,timestamp:t,approximate:coarse||c.accuracy>100};}
  function fresh(){return fix&&Date.now()-fix.timestamp>=-1000&&Date.now()-fix.timestamp<=MAX_FIX_AGE;}
  function coordinates(value){return value.latitude.toFixed(6)+', '+value.longitude.toFixed(6);}
  function status(text,error=false){$('status').textContent=text;$('status').dataset.error=String(error);}
  function stopLocation(){locationRequest++;if(watch!==null)navigator.geolocation?.clearWatch(watch);watch=null;}
  function stopCamera(){const old=stream;stream=null;imageCapture=null;video.onloadeddata=null;video.srcObject=null;old?.getTracks().forEach(t=>{t.onended=null;t.stop();});}
  function clearResult(){build++;if(resultURL)URL.revokeObjectURL(resultURL);resultURL='';resultFile=null;$('share').disabled=false;$('result').removeAttribute('src');$('download').removeAttribute('href');$('open-file').removeAttribute('href');if(photoSource){photoSource.width=1;photoSource.height=1;}photoSource=null;photoMeta=null;turns=0;$('upload-status').textContent='';$('upload-retry').hidden=true;}
  function cleanup(){session++;stopCamera();stopLocation();clearInterval(ticker);ticker=null;fix=null;owner='';mode='closed';controlBusy=false;nativeContext=null;clearResult();}
  function close(){cleanup();if(dialog.open)dialog.close();}
  function cameraMessage(error){if(error?.name==='NotAllowedError'||error?.name==='SecurityError')return 'Разрешите камеру в настройках сайта и нажмите «Включить камеру».';if(error?.name==='NotFoundError'||error?.name==='OverconstrainedError')return 'Эта камера недоступна. Выберите другую в настройках.';if(error?.name==='NotReadableError')return 'Камера занята. Закройте другое приложение и попробуйте снова.';return 'Не удалось включить камеру. Попробуйте «Камера телефона».';}
  function ratio(width=video.videoWidth,height=video.videoHeight){return $('format').value==='landscape'?4/3:$('format').value==='portrait'?3/4:(width&&height?width/height:4/3);}
  function cropRect(width,height,r){let w=width,h=height;if(width/height>r)w=height*r;else h=width/r;return {x:(width-w)/2,y:(height-h)/2,width:w,height:h};}
  function range(value){return value&&Number.isFinite(value.min)&&Number.isFinite(value.max)&&value.max>value.min;}
  function focusModes(){return Array.isArray(caps.focusMode)?caps.focusMode:[];}
  function canPoint(){return !!navigator.mediaDevices?.getSupportedConstraints?.().pointsOfInterest;}
  function snap(value,r){const step=r.step>0?r.step:(r.max-r.min)/100;return Math.max(r.min,Math.min(r.max,r.min+Math.round((Number(value)-r.min)/step)*step));}
  function readSettings(){try{cameraSettings=track()?.getSettings?.()||{};}catch(e){cameraSettings={};}}
  function updateControls(){
    readSettings();const enabled=mode==='preview'&&!controlBusy;
    for(const id of ['device','focus','focus-distance','zoom','zoom-1','zoom-2','refocus','torch','method'])$(id).disabled=!enabled;
    $('device').disabled=!['preview','error','paused'].includes(mode)||controlBusy;
    $('refocus').disabled=!enabled||!focusModes().some(m=>m==='continuous'||m==='single-shot');
    $('format').disabled=['opening','capturing','encoding','native','native-location'].includes(mode)||controlBusy;
    $('zoom-row').hidden=!range(caps.zoom);$('zoom-unavailable').hidden=range(caps.zoom);
    if(range(caps.zoom)){
      const r=caps.zoom,input=$('zoom');input.min=r.min;input.max=r.max;input.step=r.step>0?r.step:(r.max-r.min)/100;
      if(document.activeElement!==input)input.value=Number.isFinite(cameraSettings.zoom)?cameraSettings.zoom:1;
      $('zoom-value').textContent=Number.isFinite(cameraSettings.zoom)?Number(cameraSettings.zoom.toFixed(2))+'×':'—';
      for(const n of [1,2])$('zoom-'+n).disabled=!enabled||n<r.min||n>r.max;
    }
    const modes=focusModes(),manual=modes.includes('manual')&&range(caps.focusDistance);
    const adjustable=modes.some(m=>m==='continuous'||m==='single-shot'||m==='manual'&&manual);$('focus-row').hidden=!adjustable;$('focus-unavailable').hidden=adjustable;
    if(cameraSettings.focusMode&&document.activeElement!==$('focus'))$('focus').value=cameraSettings.focusMode;
    $('focus-distance-row').hidden=!manual||cameraSettings.focusMode!=='manual';
    if(manual){const input=$('focus-distance'),r=caps.focusDistance;input.min=r.min;input.max=r.max;input.step=r.step>0?r.step:(r.max-r.min)/100;if(document.activeElement!==input)input.value=cameraSettings.focusDistance??r.min;$('focus-value').textContent=Number.isFinite(cameraSettings.focusDistance)?Number(cameraSettings.focusDistance.toFixed(2)):'—';}
    $('torch-row').hidden=!(caps.torch===true||Array.isArray(caps.torch)&&caps.torch.includes(true));$('torch').checked=!!cameraSettings.torch;
    $('camera-info').textContent=(imageCapture?'Фото высокого качества доступно':'Доступен снимок из видеопотока')+(video.videoWidth?' · предпросмотр '+video.videoWidth+' × '+video.videoHeight:'');
    $('control-note').textContent=cameraNote||(canPoint()?'Коснитесь нужного места в кадре для фокусировки.':'Если нужная линза или фокус недоступны, используйте «Камера телефона».');
    const r=ratio(),displayRatio=previewTurns%2?1/r:r;
    $('stage').style.setProperty('--geo-ratio',String(displayRatio));
    $('video-wrap').style.width=(previewTurns%2?100/displayRatio:100)+'%';$('video-wrap').style.height=(previewTurns%2?100*displayRatio:100)+'%';$('video-wrap').style.transform='translate(-50%,-50%) rotate('+(previewTurns*90)+'deg)';
    $('format-quick').textContent=({auto:'Авто',landscape:'4:3',portrait:'3:4'})[$('format').value]||'Авто';$('format-quick').disabled=$('format').disabled;
    $('zoom-quick').hidden=mode!=='preview';$('zoom-2').hidden=!range(caps.zoom);$('zoom-1').hidden=true;renderLenses();
    for(const n of [1,2])$('zoom-'+n).setAttribute('aria-pressed',String(Number.isFinite(cameraSettings.zoom)&&Math.abs(cameraSettings.zoom-n)<.05));
    $('no-gps').disabled=['capturing','encoding','result'].includes(mode);
    $('settings-toggle').setAttribute('aria-expanded',String(settingsOpen));
    $('coin-badge').hidden=appConfig?.testReviewFlags?.game_mode===false;
    $('native').disabled=['capturing','encoding','native','native-location'].includes(mode)||controlBusy;
    $('rotate-left').disabled=$('rotate-right').disabled=!['preview','result'].includes(mode)||controlBusy;
  }
  function render(){
    if(!dialog.open)return;if(!allowed()){close();return;}
    const ctx=context(),result=mode==='result',working=['capturing','encoding'].includes(mode),native=mode==='native'||mode==='native-location';
    if(!result&&!working&&!native)$('object').textContent=ctx?.name||'Нет текущего объекта — откройте смену';
    $('stage').hidden=result||native;$('result').hidden=!result;$('native-wait').hidden=!native;
    $('save-actions').hidden=!result;$('file-row').hidden=!result;$('rotate-actions').hidden=false;$('shoot-actions').hidden=result;
    $('gps-row').hidden=result||working||mode==='native';$('settings').hidden=!settingsOpen||native||working;
    $('restart').hidden=!['paused','error','native'].includes(mode);$('shutter').hidden=['paused','error','native','native-location'].includes(mode);
    $('shutter').disabled=mode!=='preview'||controlBusy||Date.now()<settleUntil||!ctx||(!noGps()&&!fresh())||video.readyState<2||!video.videoWidth||track()?.readyState!=='live';
    $('refresh-gps').disabled=noGps()||!['preview','opening','native-location'].includes(mode);
    updateControls();if(result||working)return;
    const good=fresh(),age=fix?Math.max(0,Math.floor((Date.now()-fix.timestamp)/1000)):0;
    $('location').dataset.warning=String(!noGps()&&(!good||fix.approximate));
    $('location').textContent=noGps()?'Без GPS · координаты не добавляются':good?(fix.approximate?'Примерно: ':'')+coordinates(fix)+' · ±'+Math.ceil(fix.accuracy)+' м · '+age+' с назад':(gpsError||(fix?'Обновляем геопозицию…':'Определяем геопозицию телефона…'));
    if(mode==='native')status(noGps()?'Сделайте фото штатной камерой. GPS отключён.':'Сделайте фото штатной камерой. Координаты добавим при возврате.');
    else if(mode==='native-location')status('Фото принято. Ожидаем геопозицию — или включите «Снимать без GPS».');
    else if(mode==='paused')status('Камера приостановлена. Нажмите «Включить камеру».');
    else if(cameraError)status(cameraError,true);
    else if(mode==='opening')status('Включаем камеру…');
    else if(!ctx)status('Текущая смена закрыта. Для снимка нужен объект.',true);
    else if(video.readyState<2)status('Ожидаем изображение камеры…');
    else if(Date.now()<focusUntil&&!controlBusy)status(focusFeedback);
    else if(!good&&!noGps())status('Ждём координаты. Можно включить «Снимать без GPS».',true);
    else status(controlBusy?'Камера применяет настройку…':Date.now()<focusUntil?focusFeedback:Date.now()<settleUntil?'Камера настраивает фокус…':'Наведите камеру и нажмите «Снять».');
  }
  function startLocation(token,coarse=false,retain=false){
    stopLocation();if(noGps()){fix=null;return;}if(!retain)fix=null;gpsError='';locationBlocked=false;locationCoarse=coarse;locationStarted=Date.now();const request=locationRequest;
    if(!navigator.geolocation){gpsError='Геолокация недоступна в этом браузере.';render();return;}
    try{watch=navigator.geolocation.watchPosition(position=>{
      if(!live(token)||request!==locationRequest||!['opening','preview','native-location'].includes(mode))return;
      const next=validFix(position,Date.now(),coarse);if(next){fix=next;gpsError='';if(mode==='native-location'){finishNative(token);return;}}else if(!coarse){startLocation(token,true,true);return;}else gpsError='Не удалось получить свежую геопозицию. Нажмите «Обновить GPS».';render();
    },error=>{
      if(!live(token)||request!==locationRequest)return;
      if(error.code!==1&&!coarse){startLocation(token,true,true);return;}
      if(error.code===1){fix=null;locationBlocked=true;stopLocation();}
      gpsError=error.code===1?'Разрешите геопозицию в настройках сайта.': 'Даже примерные координаты пока недоступны. Включите геолокацию и обновите GPS.';render();
    },{enableHighAccuracy:!coarse,maximumAge:coarse?10000:0,timeout:coarse?12000:8000});}catch(e){if(!coarse){startLocation(token,true,true);return;}gpsError='Не удалось запросить геопозицию.';render();}
  }
  function tick(){if(dialog.open&&!noGps()&&!locationBlocked&&['preview','native-location'].includes(mode)&&Date.now()-locationStarted>15000&&(!fix||Date.now()-fix.timestamp>15000))startLocation(session,locationCoarse,true);render();}
  function options(select,entries,value){select.replaceChildren(...entries.map(([id,label])=>{const option=document.createElement('option');option.value=id;option.textContent=label;return option;}));select.value=value;}
  async function listCameras(token){
    try{const devices=await navigator.mediaDevices.enumerateDevices();if(!live(token))return;const list=devices.filter(d=>d.kind==='videoinput'&&d.deviceId);const current=track()?.getSettings?.().deviceId||selectedDevice;
      options($('device'),[['','Задняя камера — автоматически'],...list.map((d,i)=>[d.deviceId,d.label||'Камера '+(i+1)])],current);selectedDevice=current||'';cameraList=list;for(const [id,n] of [['lens-main',1],['lens-ultra',.6]])options($(id),[['','Автоматически'],...list.map((d,i)=>[d.deviceId,d.label||'Камера '+(i+1)])],lensMap[String(n)]||'');renderLenses();
    }catch(e){if(live(token))cameraNote='Список камер недоступен. Можно использовать камеру телефона.';}
  }
  async function applyControl(patch,message='Настройка передана камере.'){
    const token=session,t=track();if(!live(token)||mode!=='preview'||controlBusy||!t?.applyConstraints)return false;
    controlBusy=true;cameraNote='Применяем настройку…';render();
    try{
      const base={...(t.getConstraints?.()||{})};delete base.advanced;for(const key of ['focusMode','focusDistance','pointsOfInterest','zoom','torch'])delete base[key];
      const next={...applied,...patch};if(next.focusMode!=='manual')delete next.focusDistance;if(patch.focusMode==='manual')delete next.pointsOfInterest;if(patch.focusMode&&!patch.pointsOfInterest)delete next.pointsOfInterest;
      if(patch.focusMode==='single-shot'&&t.getSettings?.().focusMode==='single-shot'&&focusModes().includes('continuous')){try{const reset={...next,focusMode:'continuous'};delete reset.pointsOfInterest;await t.applyConstraints({...base,advanced:[reset]});await pauseFor(80);}catch(e){}if(!live(token)||track()!==t)return false;}
      let lastError,confirmed=false,pointUnreported=false;
      for(const form of ['advanced','direct']){
        try{
          const constraints=form==='advanced'?{...base,advanced:[next]}:{...base,...Object.fromEntries(Object.entries(next).map(([k,v])=>[k,{exact:v}]))};
          await t.applyConstraints(constraints);if(!live(token)||track()!==t)return false;await pauseFor(160);if(!live(token)||track()!==t)return false;
          const actual=t.getSettings?.()||{};
          for(const [key,value] of Object.entries(patch)){
            if(key==='pointsOfInterest'){if(!Array.isArray(actual[key])||!actual[key].length){pointUnreported=true;continue;}if(Math.abs(actual[key][0].x-value[0].x)>.03||Math.abs(actual[key][0].y-value[0].y)>.03)throw new Error('Браузер не подтвердил точку фокусировки.');}
            else if(actual[key]!==undefined&&(typeof value==='number'?Math.abs(actual[key]-value)>Math.max(.01,(caps[key]?.step||0)*1.1):actual[key]!==value))throw new Error('Камера не подтвердила эту настройку.');
            else if(actual[key]===undefined)throw new Error('Браузер не сообщает результат настройки.');
          }
          confirmed=true;break;
        }catch(e){lastError=e;}
      }
      if(!confirmed)throw lastError||new Error('Настройка недоступна.');
      applied=next;cameraNote=pointUnreported?'Точка передана, но браузер не подтверждает фокус. Проверьте резкость или используйте камеру телефона.':message;settleUntil=Date.now()+(patch.focusMode||patch.pointsOfInterest||patch.focusDistance!==undefined?700:150);focusFeedback=cameraNote;focusUntil=Date.now()+7000;return true;
    }catch(e){if(live(token)){cameraNote=(e.message||'Настройка недоступна.')+' Попробуйте другой объектив или камеру телефона.';focusFeedback=cameraNote;focusUntil=Date.now()+7000;}return false;}
    finally{if(live(token)){controlBusy=false;render();setTimeout(()=>{if(live(token))render();},750);}}
  }
  async function setupCamera(token){
    const t=track();try{caps=t.getCapabilities?.()||{};}catch(e){caps={};}applied={};readSettings();
    imageCapture=null;try{if(typeof ImageCapture==='function'){imageCapture=new ImageCapture(t);if(typeof imageCapture.takePhoto!=='function')imageCapture=null;}}catch(e){}
    options($('method'),imageCapture?[['photo','Фото высокого качества'],['video','Кадр видео — совместимость']]:[['video','Кадр видео — совместимость']],imageCapture?'photo':'video');
    const labels={'continuous':'Непрерывный автофокус','single-shot':'Разовый автофокус','manual':'Ручной фокус','none':'Фиксированный фокус'};
    options($('focus'),focusModes().filter(m=>m!=='manual'||range(caps.focusDistance)).map(m=>[m,labels[m]||m]),cameraSettings.focusMode||focusModes()[0]);
    await listCameras(token);if(focusModes().includes('continuous'))await applyControl({focusMode:'continuous'},'Включён непрерывный автофокус. Проверьте резкость в кадре.');
    else if(focusModes().includes('single-shot'))await applyControl({focusMode:'single-shot'},'Запущен автофокус. Проверьте резкость в кадре.');
    if(live(token))render();
  }
  async function begin(){
    if(!dialog.open||!allowed()||document.hidden)return;
    const token=++session;stopCamera();stopLocation();clearResult();fix=null;gpsError='';cameraError='';cameraNote='';caps={};controlBusy=false;settleUntil=0;mode='opening';render();
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){mode='error';cameraError='Камера браузера недоступна. Откройте страницу по HTTPS или используйте «Камера телефона».';render();return;}
    startLocation(token);
    try{
      const source=selectedDevice?{deviceId:{exact:selectedDevice}}:{facingMode:{ideal:'environment'}};
      const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{...source,width:{ideal:1920},height:{ideal:1080}}});
      if(!live(token)||document.hidden){acquired.getTracks().forEach(t=>t.stop());return;}
      stream=acquired;video.muted=true;video.srcObject=acquired;mode='preview';video.onloadeddata=()=>{if(live(token))render();};
      acquired.getVideoTracks().forEach(t=>{t.onended=()=>{if(live(token)&&mode==='preview'){stopCamera();stopLocation();mode='error';cameraError='Камера отключилась. Выберите камеру или включите её снова.';render();}};});
      await video.play();if(live(token))await setupCamera(token);
    }catch(e){if(!live(token))return;stopCamera();stopLocation();mode='error';cameraError=cameraMessage(e);render();}
  }
  function open(){if(!canAdmin()||!currentUid)return;if(!context()){showError('Для фото с названием объекта сначала откройте смену и выберите объект.');return;}if(dialog.open)return;owner=currentUid;loadLenses();navigator.storage?.persist?.().catch(()=>{});previewTurns=0;settingsOpen=false;$('no-gps').checked=false;dialog.showModal();ticker=setInterval(tick,1000);begin();}
  async function tapFocus(event){
    if(mode!=='preview'||controlBusy)return;
    const rect=$('stage').getBoundingClientRect(),u=(event.clientX-rect.left)/rect.width,v=(event.clientY-rect.top)/rect.height;if(u<0||u>1||v<0||v>1)return;
    const token=session,attempt=++focusAttempt,[x,y]=previewTurns===1?[v,1-u]:previewTurns===2?[1-u,1-v]:previewTurns===3?[1-v,u]:[u,v];
    const crop=cropRect(video.videoWidth,video.videoHeight,ratio()),point={x:(crop.x+x*crop.width)/video.videoWidth,y:(crop.y+y*crop.height)/video.videoHeight},ring=$('focus-ring');ring.hidden=false;ring.style.left=(u*100)+'%';ring.style.top=(v*100)+'%';ring.dataset.state='requested';
    const focusMode=focusModes().includes('single-shot')?'single-shot':focusModes().includes('continuous')?'continuous':null;
    let ok=false;
    if(canPoint())ok=await applyControl({... (focusMode?{focusMode}:{}),pointsOfInterest:[point]},'Фокусировка запрошена. Проверьте резкость в кадре.');
    if(!ok&&focusMode&&live(token))ok=await applyControl({focusMode},'Включён автофокус. Фокус по точке недоступен в этом браузере.');
    if(live(token)&&attempt===focusAttempt){ring.dataset.state=ok?'requested':'unsupported';if(!ok)feedback('Фокус по касанию недоступен. Попробуйте ручной фокус в ⚙ или камеру телефона.',true);setTimeout(()=>{if(attempt===focusAttempt)ring.hidden=true;},1800);}
  }
  function wrap(ctx,text,width){const lines=[];let line='';for(const word of String(text).trim().split(/\s+/)){const joined=line?line+' '+word:word;if(ctx.measureText(joined).width<=width){line=joined;continue;}if(line){lines.push(line);line='';}for(const char of word){if(line&&ctx.measureText(line+char).width>width){lines.push(line);line='';}line+=char;}}if(line)lines.push(line);return lines;}
  function localTime(timestamp){const d=new Date(timestamp),offset=-d.getTimezoneOffset(),zone='UTC'+(offset>=0?'+':'−')+String(Math.floor(Math.abs(offset)/60)).padStart(2,'0')+':'+String(Math.abs(offset)%60).padStart(2,'0');return d.toLocaleString('ru-RU',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})+' ('+zone+')';}
  function stamp(source,width,height,meta){
    const scale=Math.min(1,MAX_EDGE/Math.max(width,height)),w=Math.round(width*scale),h=Math.round(height*scale),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas unavailable');
    canvas.width=w;canvas.height=h;ctx.drawImage(source,0,0,w,h);
    const pad=Math.max(12,Math.round(w*.025)),maxWidth=w-pad*2;let font=Math.max(13,Math.round(Math.min(w,h)*.027));
    const rows=[{text:meta.name,bold:true},{text:meta.noGps?'Без GPS · координаты не записаны':(meta.native?'Геопозиция при добавлении: ':'')+(meta.approximate?'≈ ':'')+coordinates(meta)+' · ±'+Math.ceil(meta.accuracy)+' м'},{text:(meta.native?'Добавлено: ':'')+localTime(meta.shotAt)}];
    let lines,lineHeight;
    do{ctx.font='700 '+font+'px sans-serif';lineHeight=Math.ceil(font*1.35);lines=rows.flatMap(row=>wrap(ctx,row.text,Math.min(maxWidth,w*.83)).map(text=>({...row,text})));if(lines.length*lineHeight<h*.42||font<=11)break;font--;}while(true);
    const top=Math.max(pad,h-pad-lines.length*lineHeight);ctx.textBaseline='top';ctx.lineJoin='round';ctx.strokeStyle='rgba(0,0,0,.8)';ctx.lineWidth=Math.max(2,font*.12);ctx.shadowColor='rgba(0,0,0,.65)';ctx.shadowBlur=Math.max(2,font*.13);ctx.shadowOffsetY=1;ctx.fillStyle='#fff';
    for(const [i,line] of lines.entries()){ctx.font=(line.bold?'700 ':'500 ')+font+'px sans-serif';ctx.strokeText(line.text,pad,top+i*lineHeight);ctx.fillText(line.text,pad,top+i*lineHeight);}
    return canvas;
  }
  function copyPhoto(source,width,height){return window.PhotoFiles.copy(source,width,height);}
  function framePhoto(source,r,rotation){const crop=cropRect(source.width,source.height,r),out=document.createElement('canvas'),odd=rotation%2;out.width=Math.round(odd?crop.height:crop.width);out.height=Math.round(odd?crop.width:crop.height);const ctx=out.getContext('2d');ctx.translate(out.width/2,out.height/2);ctx.rotate(rotation*Math.PI/2);ctx.drawImage(source,crop.x,crop.y,crop.width,crop.height,-crop.width/2,-crop.height/2,crop.width,crop.height);return out;}
  async function decodePhoto(blob){return window.PhotoFiles.decode(blob);}
  function filename(meta,ext){const date=new Date(meta.shotAt),day=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join(''),time=[date.getHours(),date.getMinutes(),date.getSeconds()].map(x=>String(x).padStart(2,'0')).join('');return (meta.name.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g,'_').slice(0,60)||'Объект')+'_'+day+'_'+time+'.'+ext;}
  async function buildPhoto(token){
    if(!live(token)||!photoSource||!photoMeta)return;const version=++build;mode='encoding';status('Проверяем JPEG и сохраняем на устройстве…');render();
    try{
      const frame=framePhoto(photoSource,ratio(photoSource.width,photoSource.height),turns);window.PhotoFiles.checkPixels(frame);const canvas=stamp(frame,frame.width,frame.height,photoMeta);
      const blob=await window.PhotoFiles.encode(canvas);frame.width=frame.height=1;
      if(!live(token)||version!==build)return;
      const name=filename(photoMeta,blob.type==='image/jpeg'?'jpg':'png');resultFile=typeof File==='function'?new File([blob],name,{type:blob.type,lastModified:photoMeta.shotAt}):null;
      if(resultURL)URL.revokeObjectURL(resultURL);resultURL=URL.createObjectURL(blob);$('result').src=resultURL;$('download').href=resultURL;$('download').download=name;$('open-file').href=resultURL;
      let canShare=false;try{canShare=!!resultFile&&!!navigator.share&&!!navigator.canShare?.({files:[resultFile]});}catch(e){}$('share').hidden=!canShare;
      mode='result';settingsOpen=false;status('Фото готово · '+canvas.width+' × '+canvas.height+(photoMeta.noGps?' · без GPS':photoMeta.native?' · координаты при возврате':photoMeta.video?' · кадр видеопотока':' · фоторежим камеры'));render();
      await queuePhoto(blob);
    }catch(e){if(live(token)){mode='error';cameraError=e.message||'Не удалось подготовить фото. Попробуйте снова.';render();}}
  }
  async function capture(){
    const token=session,ctx=context();if(!live(token)||mode!=='preview'||controlBusy||Date.now()<settleUntil||!ctx||(!noGps()&&!fresh())||video.readyState<2||!video.videoWidth||track()?.readyState!=='live'){render();return;}
    const meta={...ctx,...(noGps()?{}:fix),noGps:noGps(),id:photoId(),shotAt:Date.now(),video:$('method').value==='video'};mode='capturing';$('object').textContent=meta.name;status('Снимаем фото…');render();
    try{
      let source;
      if(!meta.video&&imageCapture){try{let settings={};if(imageCapture.getPhotoCapabilities){const pc=await imageCapture.getPhotoCapabilities();if(pc.imageWidth?.max)settings.imageWidth=Math.max(pc.imageWidth.min||1,Math.min(MAX_EDGE,pc.imageWidth.max));}const blob=await imageCapture.takePhoto(settings);if(!live(token))return;source=await decodePhoto(blob);}catch(e){if(!live(token))return;source=await captureFrame(token);meta.video=true;meta.fallback=true;}}
      else source=await captureFrame(token);
      if(!live(token)){source.width=source.height=1;return;}
      photoSource=source;photoMeta=meta;turns=previewTurns;stopCamera();stopLocation();await buildPhoto(token);
    }catch(e){if(live(token)){mode='preview';cameraNote=e.message||'Фоторежим не сработал. Используйте камеру телефона.';focusFeedback=cameraNote;focusUntil=Date.now()+10000;render();}}
  }
  function nativeCamera(){
    if(!dialog.open||!allowed()||controlBusy||['capturing','encoding','native-location'].includes(mode))return;
    const ctx=context();if(!ctx){status('Сначала откройте смену с объектом.',true);return;}
    session++;stopCamera();stopLocation();clearResult();fix=null;nativeContext=ctx;mode='native';$('object').textContent=ctx.name;render();$('native-input').value='';$('native-input').click();
  }
  async function nativeSelected(){
    const file=$('native-input').files?.[0],token=session;if(!live(token)||mode!=='native')return;
    if(!file){mode='paused';render();return;}
    if(!file.type.startsWith('image/')||file.size>40*1024*1024){mode='error';cameraError='Выберите фото JPEG размером до 40 МБ. В камере используйте обычное разрешение.';render();return;}
    mode='native-location';render();
    try{const source=await decodePhoto(file);if(!live(token)){source.width=source.height=1;return;}photoSource=source;photoMeta={...nativeContext,native:true,id:photoId()};if(noGps())finishNative(token);else startLocation(token);render();}
    catch(e){if(live(token)){mode='error';cameraError=e.message;render();}}
  }
  function finishNative(token){
    if(!live(token)||mode!=='native-location'||!photoSource||(!noGps()&&!fresh()))return;
    if(context()?.shiftId!==nativeContext?.shiftId){mode='error';cameraError='Пока камера была открыта, сменилась рабочая смена. Сделайте новый снимок для текущего объекта.';stopLocation();render();return;}
    photoMeta={...photoMeta,...(noGps()?{}:fix),noGps:noGps(),shotAt:Date.now()};stopLocation();buildPhoto(token);
  }
  function changeGps(){
    if(!dialog.open||!allowed()||['capturing','encoding','result'].includes(mode))return;
    stopLocation();fix=null;gpsError='';
    if(mode==='native-location'&&noGps())finishNative(session);else if(!noGps()&&['opening','preview','native-location'].includes(mode))startLocation(session);
    render();
  }
  async function queuePhoto(blob){
    if(!photoMeta?.id||!window.ObjectPhotos)return;
    const token=session,meta={...photoMeta};$('upload-status').textContent='Сохраняем JPEG на устройстве…';
    try{await window.ObjectPhotos.queue(blob,meta);if(!live(token)||photoMeta?.id!==meta.id)return;const saved=await window.ObjectPhotos.localPhoto(meta.id);if(!live(token)||photoMeta?.id!==meta.id)return;resultFile=new File([saved.blob],filename(meta,'jpg'),{type:'image/jpeg',lastModified:meta.shotAt});$('upload-retry').hidden=true;}
    catch(e){if(!live(token)||photoMeta?.id!==meta.id)return;$('upload-status').textContent='Не сохранено на устройстве: '+e.message+' Нажмите «Скачать JPEG».';$('upload-retry').hidden=false;}
  }
  window.addEventListener('object-photo-progress',event=>{const detail=event.detail;if(!dialog.open||!allowed()||detail?.id!==photoMeta?.id)return;$('upload-status').textContent=detail.message;$('upload-retry').hidden=!detail.retry;});
  function pause(){if(!dialog.open||!['opening','preview','error','capturing'].includes(mode))return;session++;stopCamera();stopLocation();fix=null;controlBusy=false;mode='paused';render();}
  async function share(){if(!dialog.open||!allowed()||!resultFile||mode!=='result')return;const token=session;$('share').disabled=true;try{await navigator.share({files:[resultFile]});}catch(e){if(live(token)&&e.name!=='AbortError')status('Меню сохранения недоступно. Нажмите «Скачать фото» или «Открыть фото».',true);}finally{if(live(token))$('share').disabled=false;}}
  document.getElementById('admin-camera-button').addEventListener('click',open);
  $('close').onclick=close;$('shutter').onclick=capture;$('restart').onclick=begin;$('retake').onclick=begin;$('share').onclick=share;
  $('native').onclick=nativeCamera;$('native-input').onchange=nativeSelected;$('native-input').addEventListener('cancel',()=>{if(mode==='native'){mode='paused';render();}});
  $('device').onchange=()=>{selectedDevice=$('device').value;begin();};
  $('zoom').onchange=()=>{if(range(caps.zoom))applyControl({zoom:snap($('zoom').value,caps.zoom)},'Масштаб камеры изменён.');};
  for(const n of [1,2])$('zoom-'+n).onclick=()=>{if(range(caps.zoom)&&n>=caps.zoom.min&&n<=caps.zoom.max)applyControl({zoom:snap(n,caps.zoom)},'Масштаб камеры изменён.');};
  $('focus').onchange=()=>{const value=$('focus').value;if(focusModes().includes(value))applyControl({focusMode:value},'Режим фокусировки изменён. Проверьте резкость в кадре.');};
  $('focus-distance').onchange=()=>{if(range(caps.focusDistance)&&focusModes().includes('manual'))applyControl({focusMode:'manual',focusDistance:snap($('focus-distance').value,caps.focusDistance)},'Ручной фокус изменён.');};
  $('refocus').onclick=()=>{const focusMode=focusModes().includes('continuous')?'continuous':focusModes().includes('single-shot')?'single-shot':null;if(focusMode)applyControl({focusMode},'Автофокус включён. Подождите и проверьте резкость.');};
  $('torch').onchange=()=>applyControl({torch:$('torch').checked},'Подсветка изменена.');$('stage').addEventListener('click',tapFocus);
  $('format').onchange=()=>{turns=0;previewTurns=0;if(mode==='result')buildPhoto(session);else render();};
  $('format-quick').onclick=()=>{const modes=['auto','portrait','landscape'];$('format').value=modes[(modes.indexOf($('format').value)+1)%modes.length];$('format').onchange();};
  $('no-gps').onchange=changeGps;
  $('settings-toggle').onclick=()=>{settingsOpen=!settingsOpen;render();if(settingsOpen)$('settings-close').focus();};$('settings-close').onclick=()=>{settingsOpen=false;render();$('settings-toggle').focus();};
  $('upload-retry').onclick=async()=>{if(!photoMeta?.id||!resultFile)return;try{await window.ObjectPhotos.localPhoto(photoMeta.id);await window.ObjectPhotos.retry(photoMeta.id);}catch(e){queuePhoto(resultFile);}};
  for(const [id,delta] of [['rotate-left',-1],['rotate-right',1]])$(id).onclick=()=>{if(!allowed()||controlBusy)return;if(mode==='result'){turns=(turns+delta+4)%4;buildPhoto(session);}else if(mode==='preview'){previewTurns=(previewTurns+delta+4)%4;render();}};
  $('refresh-gps').onclick=()=>{if(dialog.open&&allowed()&&['opening','preview','native-location'].includes(mode)){startLocation(session);render();}};
  $('local-album').onclick=()=>{pause();window.openLocalPhotos?.();};
  $('lens-06').onclick=()=>chooseLens(.6);$('lens-1').onclick=()=>chooseLens(1);
  for(const [id,n] of [['lens-main',1],['lens-ultra',.6]])$(id).onchange=()=>{lensMap[String(n)]=$(id).value;saveLenses();renderLenses();};
  $('download').onclick=e=>{e.preventDefault();if(!dialog.open||!allowed()||mode!=='result'||!resultFile)return;window.PhotoFiles.download(resultFile,resultFile.name);};$('open-file').onclick=e=>{if(!dialog.open||!allowed()||mode!=='result'){e.preventDefault();close();}};
  dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('close',()=>{if(mode!=='closed')cleanup();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});window.addEventListener('pagehide',close);video.addEventListener('resize',render);
})();
