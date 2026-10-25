
(function(){
  'use strict';
  const levels=[{at:0,name:'🦺 Новичок на линии'},{at:25,name:'👀 Зоркий учётчик'},{at:100,name:'📋 Мастер отметок'},{at:500,name:'⚙️ Знаток фрезы'},{at:1000,name:'🏗️ Опора бригады'},{at:5000,name:'👑 Легенда фрезеровки'}];
  const rank=n=>levels.filter(x=>n>=x.at).at(-1)||levels[0];
  const key=s=>String(s||'').trim().toLowerCase();
  const objectKey=s=>s?.objectId?'id:'+s.objectId:s?.objectName?'name:'+s.objectName:'';
  function scopedRecords(rows){
    const shifts=new Map(),seen=new Set();
    return rows.slice().sort((a,b)=>(a.timestamp||0)-(b.timestamp||0)||String(a.id).localeCompare(String(b.id))).filter(e=>{if(!e.id||seen.has(e.id))return false;seen.add(e.id);return true;}).map(e=>{
      const ops=e.history?.operations||[];
      for(const o of ops)if(o.collection==='shift'&&o.before?.id)shifts.set(o.before.id,o.before);
      const shiftId=e.shiftId||ops.map(o=>o.after?.shiftId||o.before?.shiftId).find(Boolean)||'';
      const known=shifts.get(shiftId)||{};
      const scope={shiftId,objectId:e.objectId||known.objectId||'',objectName:e.objectName||known.objectName||''};
      if(e.eventType==='game_penalty'&&e.scope)Object.assign(scope,e.scope);
      for(const o of ops)if(o.collection==='shift'&&o.after?.id&&!e.history?.undone)shifts.set(o.after.id,o.after);
      return {...e,scope};
    });
  }
  function scopeFor(e){return scopedRecords([...records.filter(x=>x.id!==e.id),{...e,id:e.id||e.history?.id||'scope'}]).find(x=>x.id===(e.id||e.history?.id||'scope'))?.scope||{};}
  function objectOptions(rows){
    const options=new Map();
    for(const e of scopedRecords(rows)){const k=objectKey(e.scope);if(k)options.set(k,{key:k,name:e.scope.objectName||e.scope.objectId});}
    for(const o of state.objects||[])options.set('id:'+o.id,{key:'id:'+o.id,name:o.name});
    return [...options.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  }
  // Rebuild rewards globally before filtering: later undo/delete must affect its original scope.
  function calculate(records,filter={}){
    const rewards=new Map(),penalties=[];
    for(const e of scopedRecords(records)){
      if(e.eventType==='game_penalty'){if(e.amount===-3&&e.targetEmail)penalties.push(e);continue;}
      if(e.eventType==='game_photo'){if(e.amount===1&&e.photoId&&e.id==='photo_'+e.photoId&&e.userEmail)rewards.set('photo:'+e.photoId,{user:key(e.userEmail),name:e.userName||e.userEmail,coins:1,kind:'photo',scope:e.scope});continue;}
      if(!e.history||e.history.undone)continue;
      const ops=e.history.operations||[],user=key(e.userEmail||e.history.userEmail),name=e.userName||e.history.user||user;
      const loading=ops.some(o=>o.collection==='logs'&&!o.before&&o.after),archiving=ops.some(o=>o.collection==='archive'&&o.after);
      for(const o of ops){
        const b=o.before||{},a=o.after||{};
        if(o.collection==='logs'){
          const id='load:'+o.id;
          if(!o.after){if(!archiving)rewards.delete(id);}
          else if(!o.before&&a.clientOperationId)rewards.set(id,{user:key(a.createdByEmail)||user,name:a.createdBy||name,coins:1,kind:'load',scope:e.scope});
        }
        if(o.collection==='truckStatus'){
          const id=t=>'arrive:'+o.id+':'+(t.shiftId||'')+':'+t.arriveTimestamp;
          if(b.arriveTimestamp&&o.after&&!a.arriveTimestamp&&!loading&&!archiving&&a.shiftId===b.shiftId&&a.lastResetOperationId===b.lastResetOperationId&&a.lastLoadTimestamp===b.lastLoadTimestamp)rewards.delete(id(b));
          if(a.arriveTimestamp&&a.arriveTimestamp!==b.arriveTimestamp&&b.lastLoadTimestamp&&a.arriveTimestamp>b.lastLoadTimestamp)rewards.set(id(a),{user,name,coins:2,kind:'arrive',scope:e.scope});
        }
      }
    }
    const users=new Map(),matches=s=>(!filter.shiftId||s.shiftId===filter.shiftId)&&(!filter.objectKey||objectKey(s)===filter.objectKey);
    function row(user,name){if(!users.has(user))users.set(user,{user,name,coins:0,loads:0,arrivals:0,penalties:0});return users.get(user);}
    for(const r of rewards.values()){if(!r.user||!matches(r.scope))continue;const u=row(r.user,r.name);u.coins+=r.coins;const field=r.kind==='load'?'loads':r.kind==='photo'?'photos':'arrivals';u[field]=(u[field]||0)+1;}
    for(const e of penalties){if(!matches(e.scope))continue;const u=row(key(e.targetEmail),e.targetName||e.targetEmail);u.coins-=3;u.penalties++;}
    return [...users.values()].sort((a,b)=>b.coins-a.coins||a.name.localeCompare(b.name,'ru'));
  }
  window.__gameCoinsCore={calculate,rank,scopeFor,scopedRecords};

  let records=[],unsubscribe=null,owner='',ready=false,error='',board=[],configReady=false,lastView='',rankingScope='shift',rankingObject='',rankGuideOpen=false,visualBalance=null,visualOwner='';
  const enabled=()=>configReady&&permissionsLoaded&&currentUserStatus==='active'&&!!currentUid&&appConfig?.testReviewFlags?.game_mode!==false;
  const wallet=document.createElement('button');wallet.id='game-wallet';wallet.hidden=true;wallet.type='button';wallet.setAttribute('aria-label','Монеты и рейтинг пользователей');document.querySelector('#mainHeader .top-row')?.insertBefore(wallet,document.querySelector('#mainHeader .gear-btn'));
  const modal=document.createElement('dialog');modal.id='game-ranking';modal.setAttribute('aria-labelledby','game-title');document.body.append(modal);
  const admin=document.createElement('details');admin.id='game-admin';admin.className='admin-settings-group';admin.hidden=true;
  const gameOptions=[['game_mode','Игровой режим для всех'],['game_sound','Игровые звуки: монеты и аплодисменты'],['game_effects','Анимации монет и праздничный салют']];
  admin.innerHTML='<summary>🪙 Игровой режим <span id="game-mode-state"></span></summary><div class="form-card">'
    +gameOptions.map(([id,label])=>'<div class="settings-row"><label for="'+id+'">'+label+'</label><label class="toggle-switch"><input type="checkbox" id="'+id+'" data-game-setting="'+id+'"><span class="toggle-slider"></span></label></div>').join('')
    +'<p class="game-note">Общие настройки для всех пользователей. Монеты и штрафы продолжают учитываться при выключенном игровом режиме. Уведомления о штрафах остаются доступны.</p>'
    +'<div class="game-preview-settings"><label for="game-preview-rank">Проверить поздравление</label><select id="game-preview-rank" class="form-control">'+levels.map(l=>'<option value="'+l.at+'"'+(l.at===25?' selected':'')+'>'+escapeHtml(l.name)+' · '+l.at.toLocaleString('ru-RU')+' 🪙</option>').join('')+'</select><button type="button" id="game-preview-rank-button" class="btn btn-secondary btn-small">🎉 Показать поздравление</button><p class="game-note">Только на вашем экране. Баланс, ранг и история достижений не меняются. Звук и анимация учитывают настройки выше.</p></div></div>';
  document.getElementById('admin-game-settings-slot')?.append(admin);
  const gameControls=[...admin.querySelectorAll('[data-game-setting]')],savingFlags=new Set();
  async function saveGameSetting(input){
    const flag=input.dataset.gameSetting;
    if(!canAdmin()||!gameOptions.some(([id])=>id===flag)){paint();return;}
    const value=input.checked;savingFlags.add(flag);input.disabled=true;
    try{await appConfigRef.set({testReviewFlags:{[flag]:value}},{merge:true});appConfig.testReviewFlags={...appConfig.testReviewFlags,[flag]:value};window.dispatchEvent(new Event('review-flags-changed'));}
    catch(e){showError('Не удалось сохранить настройку: '+e.message);}
    finally{savingFlags.delete(flag);paint();}
  }
  gameControls.forEach(input=>input.onchange=()=>saveGameSetting(input));
  admin.querySelector('#game-preview-rank-button').onclick=previewRankCelebration;
  function paint(){
    decorateButtons();wallet.hidden=!enabled();admin.hidden=!canAdmin();
    gameControls.forEach(input=>{const id=input.dataset.gameSetting;if(!savingFlags.has(id))input.checked=appConfig?.testReviewFlags?.[id]!==false;input.disabled=!canAdmin()||savingFlags.has(id)||(id!=='game_mode'&&!enabled());});
    admin.querySelector('#game-mode-state').textContent=enabled()?'Включён':'Выключен';
    if(!enabled()){if(modal.open)modal.close();cancelCoinFeedback();cancelRankCelebration({keepPreview:canAdmin()});return;}
    if(appConfig?.testReviewFlags?.game_effects===false)cancelCoinFeedback();
    const overall=calculate(records);const me=overall.find(r=>r.user===key(currentEmail)),coins=me?.coins||0;
    const spent=window.RoadShop?.spent(records,currentUid)||0,balance=window.RoadShop?window.RoadShop.available(coins,spent,currentUserRole,currentUserStatus):Math.max(0,coins-spent);
    if(visualOwner!==currentUid){visualOwner=currentUid;visualBalance=null;}
    if(ready&&(!window.RoadArcade||window.RoadArcade.status().hydrated)){if(visualBalance!==null&&balance<visualBalance)window.__gameMoneyFlow?.(balance-visualBalance);visualBalance=balance;}
    const objects=objectOptions(records);if(!rankingObject)rankingObject=state.shift?.objectId?'id:'+state.shift.objectId:objects[0]?.key||'';
    const filter=rankingScope==='shift'?{shiftId:state.shift?.id||'__none__'}:rankingScope==='object'?{objectKey:rankingObject||'__none__'}:{};board=calculate(records,filter);
    wallet.textContent='🪙 '+(ready?balance.toLocaleString('ru-RU'):'…');wallet.title=rank(coins).name+' · Открыть рейтинг';
    if(!modal.open)return;
    const displayNames=board.map(r=>resolveUserDisplayName(r.user,r.name)),myName=resolveUserDisplayName(currentEmail,getUserName());
    const view=JSON.stringify([board,coins,balance,currentEmail,myName,displayNames,ready,error,rankingScope,rankingObject,state.shift?.id,objects,rankGuideOpen]);if(view===lastView&&modal.innerHTML)return;lastView=view;
    const level=rank(coins),next=levels.find(x=>x.at>coins),esc=escapeHtml;
    modal.innerHTML='<div class="game-head"><h2 id="game-title">Лига дорожной бригады</h2><button aria-label="Закрыть рейтинг">×</button></div>'
      +'<div class="game-profile"><div class="game-profile-name">'+esc(myName)+'</div><div class="game-profile-rank">'+esc(level.name)+'</div>'
      +'<div class="game-profile-balance"><span class="game-profile-label">Кошелёк · доступно для покупок</span><strong class="game-profile-value"><span aria-hidden="true">🪙</span>'+balance.toLocaleString('ru-RU')+'</strong><small>Рейтинг: '+coins.toLocaleString('ru-RU')+' · Покупки его не уменьшают</small></div>'
      +'<div class="game-profile-progress">'+(next?'<progress value="'+Math.max(0,coins-level.at)+'" max="'+(next.at-level.at)+'" aria-label="Прогресс до следующего ранга"></progress><div>Ещё '+(next.at-coins)+' 🪙 до ранга «'+esc(next.name)+'»</div>':'<div>👑 Высший ранг — вы легенда команды!</div>')+'</div></div>'
      +'<button type="button" id="game-ranks-toggle" aria-expanded="'+rankGuideOpen+'" aria-controls="game-ranks-guide">🏅 Все ранги · '+levels.length+'</button>'+renderRankGuide(coins)
      +'<div class="game-scopes" role="group" aria-label="Период рейтинга">'+[['all','Общий'],['shift','Текущая смена'],['object','Объект']].map(([id,label])=>'<button type="button" data-game-scope="'+id+'" aria-pressed="'+(rankingScope===id)+'">'+label+'</button>').join('')+'</div>'
      +(rankingScope==='object'?'<label class="game-note">Объект <select id="game-object">'+objects.map(o=>'<option value="'+esc(o.key)+'" '+(o.key===rankingObject?'selected':'')+'>'+esc(o.name)+'</option>').join('')+'</select></label>':'')
      +'<h3>Рейтинг команды'+(rankingScope==='shift'?' · текущая смена':rankingScope==='object'?' · объект':' · за всё время')+'</h3><p class="game-note">За фото, сохранённое в объекте, +1 · За отметку погрузки +1 · За отметку возвращения после погрузки +2. Первый приезд — без монет. Ошибочное действие: штраф −3 автору при отмене. Награда отменённого действия также аннулируется. Штраф остаётся при восстановлении; повторно за то же действие не списывается.</p>'
      +(rankingScope==='shift'&&!state.shift?.id?'<p class="game-note">Смена не начата.</p>':'')
      +(error?'<p role="status">'+esc(error)+'</p>':!ready?'<p role="status">Загружаем накопления…</p>':board.length?board.map((r,i)=>'<div class="game-row '+(r.user===key(currentEmail)?'me':'')+'"><span class="game-place">'+(['🥇','🥈','🥉'][i]||i+1)+'</span><div class="game-person"><b>'+esc(displayNames[i])+(r.user===key(currentEmail)?' · вы':'')+'</b><small>Отметки погрузки: '+r.loads+' · Возвращения: '+r.arrivals+' · Фото: '+(r.photos||0)+' · Штрафы: '+r.penalties+' (−'+(r.penalties*3)+')</small></div><b class="game-score">'+r.coins+' 🪙</b></div>').join(''):'<p class="game-note">Здесь появятся участники, которые отмечают машины на линии фрезерования.</p>');
    modal.querySelector('.game-head button').onclick=()=>modal.close();
    modal.querySelector('#game-ranks-toggle').onclick=()=>{rankGuideOpen=!rankGuideOpen;paint();modal.querySelector('#game-ranks-toggle')?.focus();};
    modal.querySelectorAll('[data-game-scope]').forEach(b=>b.onclick=()=>{rankingScope=b.dataset.gameScope;paint();});
    const objectSelect=modal.querySelector('#game-object');if(objectSelect)objectSelect.onchange=()=>{rankingObject=objectSelect.value;paint();};
  }
  wallet.onclick=()=>{rankingScope='shift';rankGuideOpen=false;modal.showModal();paint();};
  modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close();}});
  function decorateButtons(){
    document.querySelectorAll('.truck-card[data-truck-id]').forEach(card=>{
      const st=state.truckStatus[card.dataset.truckId]||{};
      card.querySelectorAll('.btn-quick,.btn-arrive').forEach(button=>{
        const earns=enabled()&&!button.disabled&&(button.classList.contains('btn-quick')||(!st.arriveStatus&&!!st.lastLoadTimestamp));
        const icon=button.querySelector('.game-button-coin');
        if(earns&&!icon){const span=document.createElement('span');span.className='game-button-coin';span.textContent='🪙';span.setAttribute('aria-hidden','true');button.append(span);}
        else if(!earns&&icon)icon.remove();
      });
    });
  }
  let audioContext;
  function unlockCoinAudio(preview=false){
    if(!(preview?canAdmin():enabled())||appConfig?.testReviewFlags?.game_sound===false)return;
    try{const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)return;
      audioContext=audioContext||new Audio();if(audioContext.state==='suspended')audioContext.resume().catch(()=>{});
    }catch(e){/* Audio is optional; action and animation must still work. */}
  }
  document.addEventListener('pointerdown',e=>{if(e.target.closest('.btn-quick,.btn-arrive,#game-wallet,#game-ranks-toggle,#geo-photo-shutter,#geo-photo-native'))unlockCoinAudio();},true);
  document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.closest('.btn-quick,.btn-arrive,#game-wallet,#game-ranks-toggle,#geo-photo-shutter,#geo-photo-native'))unlockCoinAudio();},true);
  function coinDing(){
    if(!enabled()||appConfig?.testReviewFlags?.game_sound===false||!audioContext||audioContext.state!=='running')return;
    try{const t=audioContext.currentTime;
      [1318.51,2637.02].forEach((frequency,i)=>{const osc=audioContext.createOscillator(),gain=audioContext.createGain();
        osc.type='sine';osc.frequency.value=frequency;gain.gain.setValueAtTime(0,t);gain.gain.linearRampToValueAtTime(i?.025:.07,t+.008);gain.gain.exponentialRampToValueAtTime(.0001,t+.65);
        osc.connect(gain);gain.connect(audioContext.destination);osc.start(t);osc.stop(t+.7);osc.onended=()=>{osc.disconnect();gain.disconnect();};
      });
    }catch(e){/* Sound must never interrupt the action. */}
  }
  // Only server-confirmed balance changes can unlock a celebration.
  function advanceRankMarker(previous,coins,celebrate){
    const at=rank(coins).at;
    if(!previous)return {peak:at,pending:null};
    const pending=at<Number(previous.pending)?null:previous.pending;
    return {peak:Math.max(previous.peak,at),pending:!celebrate?null:at>previous.peak?at:pending};
  }
  const rankMarkers=new Map();
  let rankNoticePreview=false;
  let rankSnapshotConfirmed=false,pendingRankAt=null,rankNotice=null,rankNoticeTimer=null,rankQueueTimer=null;
  const applauseSources=new Set();
  const rankMarkerKey=()=> 'samosval:rank-celebration:v1:'+firebaseConfig.projectId+':'+WORKSPACE_ID+':'+currentUid;
  function readRankMarker(){
    const id=rankMarkerKey();if(rankMarkers.has(id))return rankMarkers.get(id);
    try{const saved=JSON.parse(localStorage.getItem(id)||'null');
      if(saved&&levels.some(l=>l.at===saved.peak)&&(saved.pending===null||levels.some(l=>l.at===saved.pending&&l.at<=saved.peak))){rankMarkers.set(id,saved);return saved;}
    }catch(e){}return null;
  }
  function saveRankMarker(marker){
    rankMarkers.set(rankMarkerKey(),marker);
    try{localStorage.setItem(rankMarkerKey(),JSON.stringify(marker));}catch(e){/* Session memory still prevents duplicate celebrations. */}
  }
  function dismissRankNotice(){
    stopRankFireworks();
    clearTimeout(rankNoticeTimer);rankNoticeTimer=null;rankNotice?.remove();rankNotice=null;rankNoticePreview=false;
    for(const source of [...applauseSources])try{source.stop();}catch(e){}
    applauseSources.clear();
  }
  function cancelRankCelebration({keepPreview=false}={}){
    if(!keepPreview||!rankNoticePreview)dismissRankNotice();clearTimeout(rankQueueTimer);rankQueueTimer=null;pendingRankAt=null;
  }
  let rankFireworkCanvas=null,rankFireworkFrame=null;
  function stopRankFireworks(){
    if(rankFireworkFrame!==null)cancelAnimationFrame(rankFireworkFrame);
    rankFireworkFrame=null;rankFireworkCanvas?.remove();rankFireworkCanvas=null;
  }
  function startRankFireworks(){
    stopRankFireworks();
    if(appConfig?.testReviewFlags?.game_effects===false||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const canvas=document.createElement('canvas');canvas.id='game-rank-fireworks';canvas.setAttribute('aria-hidden','true');
    const ctx=canvas.getContext?.('2d');if(!ctx)return;
    document.body.append(canvas);rankFireworkCanvas=canvas;
    // Five overlapping bursts around the screen centre; bounded particle count.
    const bursts=[
      {at:0,x:0,y:0,hue:43,count:64,size:1},
      {at:.32,x:-.55,y:-.3,hue:185,count:48,size:.78},
      {at:.65,x:.58,y:-.16,hue:320,count:48,size:.82},
      {at:1.02,x:-.2,y:.18,hue:48,count:56,size:.92},
      {at:1.36,x:.22,y:-.35,hue:38,count:64,size:1.05}
    ];
    for(const b of bursts)b.sparks=Array.from({length:b.count},(_,i)=>({angle:Math.PI*2*i/b.count+(Math.random()-.5)*.06,speed:(.68+Math.random()*.4)*b.size,life:1.12+Math.random()*.3,width:1+Math.random()*.8,phase:Math.random()*6.28}));
    const started=performance.now();let width=0,height=0;
    function frame(now){
      if(!canvas.isConnected||document.hidden||!rankNotice||!(rankNoticePreview?canAdmin():enabled())||appConfig?.testReviewFlags?.game_effects===false||matchMedia('(prefers-reduced-motion: reduce)').matches){stopRankFireworks();return;}
      const elapsed=(now-started)/1000;if(elapsed>2.85){stopRankFireworks();return;}
      const w=window.innerWidth,h=window.innerHeight,dpr=Math.min(window.devicePixelRatio||1,2);
      if(w!==width||h!==height){width=w;height=h;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);}
      ctx.clearRect(0,0,width,height);ctx.globalCompositeOperation='lighter';
      const radius=Math.min(width,height)*.28;
      for(const b of bursts){
        const age=elapsed-b.at;if(age<0||age>1.45)continue;
        const x=width/2+b.x*radius,y=height/2+b.y*radius;
        // Local glow only: no full-screen flash or dark overlay.
        if(age<.24){const glow=ctx.createRadialGradient(x,y,0,x,y,radius*.34);glow.addColorStop(0,'hsla('+b.hue+',100%,90%,'+(.5*(1-age/.24))+')');glow.addColorStop(1,'transparent');ctx.fillStyle=glow;ctx.fillRect(x-radius*.34,y-radius*.34,radius*.68,radius*.68);}
        for(const p of b.sparks){
          if(age>p.life)continue;
          const distance=t=>radius*p.speed*(1-Math.exp(-2.8*t)),fall=t=>radius*.3*t*t;
          const px=x+Math.cos(p.angle)*distance(age),py=y+Math.sin(p.angle)*distance(age)+fall(age);
          const tail=Math.max(0,age-.07),tx=x+Math.cos(p.angle)*distance(tail),ty=y+Math.sin(p.angle)*distance(tail)+fall(tail);
          const alpha=Math.pow(1-age/p.life,.75)*(.78+.22*Math.sin(age*16+p.phase));
          ctx.strokeStyle='hsla('+b.hue+',95%,72%,'+alpha+')';ctx.lineWidth=p.width;ctx.lineCap='round';ctx.shadowColor='hsl('+b.hue+',100%,65%)';ctx.shadowBlur=5;
          ctx.beginPath();ctx.moveTo(tx,ty);ctx.lineTo(px,py);ctx.stroke();
          ctx.fillStyle='rgba(255,251,222,'+alpha+')';ctx.fillRect(px-.65,py-.65,1.3,1.3);
        }
      }
      ctx.shadowBlur=0;ctx.globalCompositeOperation='source-over';rankFireworkFrame=requestAnimationFrame(frame);
    }
    rankFireworkFrame=requestAnimationFrame(frame);
  }

  function rankApplause(preview=false){
    if(!(preview?canAdmin():enabled())||appConfig?.testReviewFlags?.game_sound===false||!audioContext||audioContext.state!=='running')return;
    try{
      const start=audioContext.currentTime,rate=audioContext.sampleRate;
      // Layered, spatial handclaps with a small room tail, fading after 1.8 seconds.
      const room=audioContext.createConvolver(),wet=audioContext.createGain(),impulse=audioContext.createBuffer(2,Math.ceil(rate*.24),rate);
      for(let channel=0;channel<2;channel++){const data=impulse.getChannelData(channel);for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*Math.pow(1-i/data.length,3);}
      room.buffer=impulse;wet.gain.value=.17;room.connect(wet);wet.connect(audioContext.destination);
      const buffer=audioContext.createBuffer(1,Math.ceil(rate*.12),rate),samples=buffer.getChannelData(0);
      for(let i=0;i<samples.length;i++){const t=i/rate,envelope=Math.exp(-t*80)+(t>.009?.65*Math.exp(-(t-.009)*100):0)+(t>.019?.4*Math.exp(-(t-.019)*110):0);samples[i]=(Math.random()*2-1)*envelope*.65;}
      let remaining=32;
      for(let i=0;i<32;i++){
        const source=audioContext.createBufferSource(),filter=audioContext.createBiquadFilter(),gain=audioContext.createGain(),pan=audioContext.createStereoPanner();
        const t=start+i*.048+(i%3)*.007,fade=Math.min(1,(32-i)/8);
        source.buffer=buffer;source.playbackRate.value=.82+(i%6)*.08;
        filter.type='highpass';filter.frequency.value=500+(i%4)*100;
        gain.gain.value=(.24+(i%3)*.025)*fade;pan.pan.value=((i%7)-3)/4;
        source.connect(filter);filter.connect(gain);gain.connect(pan);pan.connect(audioContext.destination);pan.connect(room);applauseSources.add(source);
        source.onended=()=>{applauseSources.delete(source);source.disconnect();filter.disconnect();gain.disconnect();pan.disconnect();if(--remaining===0){room.disconnect();wet.disconnect();}};
        source.start(t);source.stop(t+.17);
      }
    }catch(e){/* A browser audio restriction must not interrupt work. */}
  }
  function showPendingRank(){
    clearTimeout(rankQueueTimer);rankQueueTimer=null;
    if(pendingRankAt===null||!enabled()||!rankSnapshotConfirmed)return;
    const toast=document.getElementById('toast');
    if(document.hidden||rankNotice||coinFlights.size||Date.now()<feedbackUntil||penaltyNotice||toast?.classList.contains('show')||document.querySelector('.modal.open,dialog[open]')){
      rankQueueTimer=setTimeout(showPendingRank,400);return;
    }
    const milestone=levels.find(l=>l.at===pendingRankAt);if(!milestone)return;
    showRankNotice(milestone);
    const marker=readRankMarker();if(marker)saveRankMarker({...marker,pending:null});pendingRankAt=null;
  }
  function showRankNotice(milestone,preview=false){
    dismissRankNotice();
    const el=document.createElement('aside');el.id='game-rank-celebration';el.setAttribute('role','status');el.setAttribute('aria-live','polite');el.setAttribute('aria-atomic','true');
    const effects=appConfig?.testReviewFlags?.game_effects!==false&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.classList.toggle('festive',effects);
    const title=document.createElement('strong');title.textContent=milestone.at?'🎉 Ура, новый ранг!':'🎉 Добро пожаловать в бригаду!';
    const text=document.createElement('p');text.textContent='Поздравляем! Ваш ранг — '+milestone.name+'.';
    const note=document.createElement('small');note.textContent=(preview?'Предпросмотр · ':'')+milestone.at.toLocaleString('ru-RU')+' монет'+(preview?' · баланс не меняется':' — заслуженно!');
    const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','Закрыть поздравление');close.onclick=dismissRankNotice;
    el.append(title,text,note,close);document.body.append(el);rankNotice=el;rankNoticePreview=preview;
    if(effects)startRankFireworks();
    rankApplause(preview);rankNoticeTimer=setTimeout(dismissRankNotice,3000);
  }
  async function previewRankCelebration(){
    if(!canAdmin())return;
    const at=Number(admin.querySelector('#game-preview-rank').value),milestone=levels.find(l=>l.at===at);if(!milestone)return;
    unlockCoinAudio(true);
    if(audioContext?.state==='suspended')try{await audioContext.resume();}catch(e){}
    if(!canAdmin())return;
    showRankNotice(milestone,true);
  }
  function observeRankProgress(){
    if(!rankSnapshotConfirmed||!configReady||!currentUid||currentUid!==owner)return;
    const coins=calculate(records).find(r=>r.user===key(currentEmail))?.coins||0;
    const previous=readRankMarker(),marker=advanceRankMarker(previous,coins,enabled());
    if(JSON.stringify(previous)!==JSON.stringify(marker))saveRankMarker(marker);
    pendingRankAt=marker.pending;
    if(!enabled()){cancelRankCelebration({keepPreview:canAdmin()});return;}
    if(pendingRankAt!==null)showPendingRank();
  }
  function renderRankGuide(coins){
    const current=rank(coins),next=levels.find(l=>l.at>coins),esc=escapeHtml;
    return '<section id="game-ranks-guide" class="game-ranks-guide"'+(rankGuideOpen?'':' hidden')+' aria-label="Все ранги и пороги монет">'
      +'<p>Всего рангов: <b>'+levels.length+'</b>. Ранги за работу с отметками на линии фрезерования; зависят от рабочих очков. Покупки и мини-игры на ранг не влияют.</p>'
      +(ready?'<p>'+(next?'До ранга «'+esc(next.name)+'» осталось <b>'+(next.at-coins).toLocaleString('ru-RU')+' 🪙</b>.':'Вы достигли высшего ранга!')+'</p>':'<p>Загружаем ваш баланс…</p>')
      +'<table><thead><tr><th scope="col">Ранг</th><th scope="col">Нужно монет</th></tr></thead><tbody>'
      +levels.map((l,i)=>'<tr'+(ready&&l.at===current.at?' class="current" aria-current="true"':'')+'><th scope="row">'+esc(l.name)+(ready&&l.at===current.at?'<small>Ваш ранг</small>':i===levels.length-1?'<small>Высший ранг</small>':'')+'</th><td>'+l.at.toLocaleString('ru-RU')+' 🪙</td></tr>').join('')
      +'</tbody></table></section>';
  }

  // Coordinate the toast with all in-flight coins and the last wallet impact.
  const coinFlights=new Set();
  let feedbackUntil=0,feedbackTimer=null,walletHitTimer=null,deferredToast=null;
  function resumeCoinToast(){
    clearTimeout(feedbackTimer);feedbackTimer=null;
    if(coinFlights.size)return;
    const remaining=feedbackUntil-Date.now();
    if(remaining>0){feedbackTimer=setTimeout(resumeCoinToast,remaining);return;}
    document.body.classList.remove('game-coin-feedback');
    const message=deferredToast;deferredToast=null;
    if(message)showToastEl(...message);
  }
  function holdCoinToast(){
    const toast=document.getElementById('toast');
    if(toast?.classList.contains('show')&&!toast.classList.contains('error')&&!deferredToast)
      deferredToast=[toast.innerHTML,false,toast.classList.contains('slide-right-to-left')];
    clearTimeout(toastTimer1);clearTimeout(toastTimer2);
    if(toast)resetToast(toast);
    document.body.classList.add('game-coin-feedback');
    clearTimeout(feedbackTimer);feedbackTimer=null;
  }
  function walletImpact(){
    if(!enabled()||wallet.hidden)return;
    if(appConfig?.testReviewFlags?.game_effects===false){coinDing();return;}
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    feedbackUntil=Date.now()+(reduced?300:550);
    clearTimeout(walletHitTimer);wallet.classList.remove('game-wallet-hit');void wallet.offsetWidth;wallet.classList.add('game-wallet-hit');
    walletHitTimer=setTimeout(()=>wallet.classList.remove('game-wallet-hit'),reduced?300:520);
    if(!reduced){
      const target=wallet.getBoundingClientRect(),burst=document.createElement('span');burst.className='game-wallet-burst';burst.setAttribute('aria-hidden','true');
      burst.style.left=(target.left+target.width/2-24)+'px';burst.style.top=(target.top+target.height/2-24)+'px';document.body.append(burst);
      setTimeout(()=>burst.remove(),550);
    }
    coinDing();
  }
  window.__gamePhotoSaved=()=>{if(enabled()){walletImpact();resumeCoinToast();}};
  function cancelCoinFeedback(){
    deferredToast=null;feedbackUntil=0;
    for(const finish of [...coinFlights])finish(false);
    clearTimeout(feedbackTimer);clearTimeout(walletHitTimer);feedbackTimer=null;walletHitTimer=null;
    wallet.classList.remove('game-wallet-hit');document.body.classList.remove('game-coin-feedback');
    document.querySelectorAll('.game-wallet-burst').forEach(e=>e.remove());
  }
  window.__gameDeferToast=(html,isError,isUndo)=>{
    // Errors take precedence and must never be hidden behind a celebration.
    if(isError){dismissRankNotice();cancelCoinFeedback();return false;}
    if(!coinFlights.size&&Date.now()>=feedbackUntil)return false;
    deferredToast=[html,isError,isUndo];resumeCoinToast();return true;
  };
  const line=document.getElementById('trucksLineList');
  if(line)new MutationObserver(decorateButtons).observe(line,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
  window.__gameCoinQueued=function(op){
    if(!enabled()||!(op.type==='load'||op.type==='arrive'&&op.wantArrived&&op.lastLoadTimestamp))return;
    const amount=op.type==='arrive'?2:1;
    if(appConfig?.testReviewFlags?.game_effects===false){coinDing();return;}
    const card=[...document.querySelectorAll('.truck-card[data-truck-id]')].find(c=>c.dataset.truckId===op.truckId),button=card?.querySelector(op.type==='load'?'.btn-quick':'.btn-arrive');
    const icon=button?.querySelector('.game-button-coin'),r=(icon||button)?.getBoundingClientRect(),target=wallet.getBoundingClientRect();
    if(!target.width||!target.height){coinDing();return;}holdCoinToast();
    if(!r||matchMedia('(prefers-reduced-motion: reduce)').matches){walletImpact();resumeCoinToast();return;}
    let remaining=amount;if(icon)icon.style.visibility='hidden';
    for(let i=0;i<amount;i++){
      const coin=document.createElement('span');coin.className='game-flying-coin';coin.textContent='🪙';coin.setAttribute('aria-hidden','true');
      const sx=r.left+r.width/2+(i-(amount-1)/2)*12,sy=r.top+r.height/2;coin.style.left=(sx-15)+'px';coin.style.top=(sy-15)+'px';document.body.append(coin);
      const dx=target.left+target.width/2-sx,dy=target.top+target.height/2-sy;let finished=false,animation=null,failsafe=null;
      function finish(sound){if(finished)return;finished=true;clearTimeout(failsafe);animation?.cancel();coin.remove();remaining--;if(!remaining&&icon)icon.style.visibility='';coinFlights.delete(finish);if(sound)walletImpact();resumeCoinToast();}
      coinFlights.add(finish);if(typeof coin.animate!=='function'){finish(true);continue;}
      try{animation=coin.animate([{transform:'translate(0,0)',opacity:1},{transform:'translate('+dx+'px,'+dy+'px)',opacity:1}],{duration:1800,delay:i*220,easing:'linear',fill:'backwards'});animation.onfinish=()=>finish(coin.isConnected);animation.oncancel=()=>finish(false);failsafe=setTimeout(()=>finish(false),2300+i*220);}catch(e){finish(false);}
    }
  };
  window.__gameMoneyFlow=function(delta){
    if(!enabled()||delta>=0||document.hidden||appConfig?.testReviewFlags?.game_effects===false)return;
    const host=document.querySelector('dialog[open]')||document.body,source=host.querySelector?.('[data-arcade-balance],.shop-balance b')||wallet,r=source.getBoundingClientRect();if(!r.width||!r.height)return;
    const label=document.createElement('span');label.className='arcade-debit-label';label.textContent='−'+Math.abs(delta).toLocaleString('ru-RU')+' 🪙';label.setAttribute('aria-hidden','true');label.style.left=Math.max(8,Math.min(innerWidth-110,r.left))+'px';label.style.top=(r.bottom+4)+'px';host.append(label);setTimeout(()=>label.remove(),1600);
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const count=Math.min(5,Math.abs(Math.round(delta)));
    for(let i=0;i<count;i++){const coin=document.createElement('span');coin.className='game-flying-coin';coin.textContent='🪙';coin.setAttribute('aria-hidden','true');coin.style.left=(r.left+r.width/2-15)+'px';coin.style.top=(r.top+r.height/2-15)+'px';host.append(coin);
      let done=false,animation;const finish=()=>{if(done)return;done=true;animation?.cancel();coin.remove();coinFlights.delete(finish);};coinFlights.add(finish);
      if(typeof coin.animate!=='function'){finish();continue;}try{animation=coin.animate([{transform:'translate(0,0) scale(.7)',opacity:1},{transform:'translate('+((i-(count-1)/2)*34)+'px,'+(90+i*16)+'px) scale(.4)',opacity:0}],{duration:1400,delay:i*100,easing:'ease-in'});animation.onfinish=finish;animation.oncancel=finish;setTimeout(finish,2100);}catch(e){finish();}
    }
  };
  function sync(){
    const identity=permissionsLoaded&&currentUserStatus==='active'?String(currentUid||''):'';
    if(identity!==owner){
      cancelCoinFeedback();cancelRankCelebration();rankSnapshotConfirmed=false;rankGuideOpen=false;
      unsubscribe?.();unsubscribe=null;owner=identity;records=[];board=[];ready=false;error='';rankingObject='';rankingScope='shift';closePenaltyNotice();
    }
    if(identity&&!unsubscribe){
      const session=owner;
      unsubscribe=refs.audit.where('eventType','in',['history','game_penalty','game_photo','game_purchase']).onSnapshot({includeMetadataChanges:true},s=>{if(owner!==session)return;records=s.docs.filter(d=>!d.metadata.hasPendingWrites).map(d=>({id:d.id,...d.data()}));ready=true;error='';rankSnapshotConfirmed=!s.metadata.fromCache&&!s.metadata.hasPendingWrites;notifyPenalties(records);paint();observeRankProgress();},e=>{if(owner!==session)return;rankSnapshotConfirmed=false;cancelRankCelebration();error='Не удалось загрузить рейтинг. Проверьте подключение и доступ к истории.';ready=false;paint();console.warn('[game coins]',e);});
    }
    paint();
  }
  window.__gameConfigChanged=()=>{configReady=true;sync();observeRankProgress();};
  window.__gameAccessChanged=sync;
  let economyRows=null,economyEmail='',economyEarned=0;
  window.__gameEconomy={snapshot:()=>{if(economyRows!==records||economyEmail!==currentEmail){economyRows=records;economyEmail=currentEmail;economyEarned=calculate(records).find(r=>r.user===key(currentEmail))?.coins||0;}return {enabled:enabled(),ready:ready&&rankSnapshotConfirmed,records,earned:economyEarned};}};
  // One durable penalty per original action, shared by both undo routes.
  window.__gamePenaltyKey=(type,truck,s,logId,fallback)=>type==='load'&&logId?'load:'+logId:type==='arrive'?'arrive:'+truck+':'+s.shiftId+':'+s.cycleRevision:type==='ttn'?'ttn:'+truck+':'+s.shiftId+':'+s.ttnRevision:'history:'+fallback;
  window.__gameHistoryPenaltyKey=h=>{
    const ops=h.operations||[],load=ops.find(o=>o.collection==='logs'&&!o.before&&o.after),st=ops.find(o=>o.collection==='truckStatus'&&o.after&&o.before);
    if(load)return 'load:'+load.id;
    if(st&&ops.length===1){const a=st.after,b=st.before;
      if(a.arriveTimestamp!==b.arriveTimestamp)return window.__gamePenaltyKey('arrive',st.id,a,null,h.id);
      if(a.ttnStatus!==b.ttnStatus)return window.__gamePenaltyKey('ttn',st.id,a,null,h.id);
    }
    return 'history:'+h.id;
  };
  window.__gamePenaltyScope=(id,notification,status)=>{
    const original=records.find(e=>e.history&&window.__gameHistoryPenaltyKey(e.history)===id);
    if(original)return scopeFor(original);
    return {shiftId:notification.shiftId||status.shiftId||'',objectId:notification.objectId||state.shift?.objectId||'',objectName:notification.objectName||state.shift?.objectName||''};
  };
  window.__gameStagePenalty=async(tx,id,data)=>{
    const ref=refs.audit.doc('game_penalty_'+encodeURIComponent(id)),existing=await tx.get(ref);
    if(existing.exists)return ()=>{};
    const targetEmail=key(data.user);if(!targetEmail)throw new Error('Не найден автор действия для штрафа');
    const timestamp=Date.now(),entry={eventType:'game_penalty',amount:-3,actionId:id,targetEmail,targetName:data.name||targetEmail,description:data.description||'Ошибочное действие',scope:{shiftId:data.shiftId||'',objectId:data.objectId||'',objectName:data.objectName||''},timestamp,userEmail:currentEmail,userName:getUserName(),createdByEmail:currentEmail,text:'Штраф −3 монеты за отменённое ошибочное действие',timeStr:new Date(timestamp).toLocaleString('ru-RU')};
    return ()=>tx.set(ref,entry);
  };
  let penaltyNotice=null,penaltyNoticeKey='',flushBusy=false;
  const ackKey=()=> 'samosval:penalty-read:'+firebaseConfig.projectId+':'+WORKSPACE_ID+':'+currentUid;
  function acknowledged(){try{return new Set(JSON.parse(localStorage.getItem(ackKey())||'[]'));}catch(e){return new Set();}}
  function closePenaltyNotice(){penaltyNotice?.remove();penaltyNotice=null;penaltyNoticeKey='';}
  function notifyPenalties(rows){
    if(!currentUid)return;
    const read=acknowledged(),pending=rows.filter(e=>e.eventType==='game_penalty'&&key(e.targetEmail)===key(currentEmail)&&!read.has(e.id)).sort((a,b)=>a.timestamp-b.timestamp);
    const signature=JSON.stringify(pending.map(e=>e.id));if(signature===penaltyNoticeKey)return;closePenaltyNotice();if(!pending.length)return;
    dismissRankNotice();penaltyNoticeKey=signature;const el=document.createElement('aside');el.id='game-penalty-notice';el.setAttribute('role','alert');el.setAttribute('aria-label','Списание монет за ошибочное действие');
    const heading=document.createElement('strong');heading.textContent='Списано '+(pending.length*3)+' 🪙 за ошибочные действия';el.append(heading);
    for(const e of pending){const p=document.createElement('p');p.textContent='−3 🪙 · '+e.description+'. '+(key(e.userEmail)===key(currentEmail)?'Вы отменили своё действие.':'Действие отменил '+(e.userName||'администратор')+'.');el.append(p);}
    const button=document.createElement('button');button.type='button';button.textContent='Понятно';button.onclick=()=>{for(const e of pending)read.add(e.id);try{localStorage.setItem(ackKey(),JSON.stringify([...read]));closePenaltyNotice();}catch(e){showError('Не удалось сохранить прочтение уведомления');}};el.append(button);document.body.append(el);penaltyNotice=el;
  }
  window.__gameFlushPenalties=async()=>{
    if(flushBusy||!navigator.onLine||!currentUid||!permissionsLoaded||currentUserStatus!=='active')return;
    const session=currentUid;flushBusy=true;
    try{for(const op of offlineJournalRead().filter(o=>o.status==='cancelled'&&!o.penaltyDelivered)){
      if(session!==currentUid)break;
      await window.__historyRawTransaction(async tx=>{if(session!==currentUid)throw new Error('Учётная запись изменилась');const save=await window.__gameStagePenalty(tx,'local:'+op.id,{user:op.email,name:op.actor,description:({load:'Погрузка',arrive:'Прибытие',ttn:'ТТН',reset:'Сброс таймера'}[op.type]||op.type)+' · '+op.truckName,shiftId:op.shiftId,objectId:op.objectId,objectName:op.objectName});save();});
      if(session!==currentUid)break;const all=offlineJournalRead(),saved=all.find(o=>o.id===op.id);if(saved){saved.penaltyDelivered=true;offlineJournalWrite(all);}
    }}catch(e){console.warn('[game penalty sync]',e);}finally{flushBusy=false;}
  };
  setInterval(()=>window.__gameFlushPenalties(),5000);

  // Existing appConfig listener is registered first and applies the shared flags.
  setInterval(sync,1000);
})();
