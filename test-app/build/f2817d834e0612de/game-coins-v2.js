
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
  const rewardDefaults=Object.freeze({load:1,arrive:2,ttn:0}),rewardLimit=10000;
  const rewardValue=(n,fallback)=>Number.isInteger(n)&&n>=0&&n<=rewardLimit?n:fallback;
  function rewardSchedule(policy={}){
    return (Array.isArray(policy.gameRewardSchedule)?policy.gameRewardSchedule:[])
      .filter(r=>r&&Number.isFinite(r.effectiveAt)&&r.effectiveAt>0&&['load','arrive','ttn'].every(k=>rewardValue(r[k],null)!==null))
      .slice().sort((a,b)=>a.effectiveAt-b.effectiveAt);
  }
  function rewardsAt(policy={},at=Date.now()){
    let rates=rewardDefaults;
    for(const r of rewardSchedule(policy)){if(r.effectiveAt>at)break;rates=r;}
    return {load:rates.load,arrive:rates.arrive,ttn:rates.ttn};
  }
  function rewardSnapshot(policy,action,recordedAt){
    const at=Number.isFinite(action?.at)&&action.at>0?action.at:recordedAt;
    return {version:1,actionAt:at,actionId:String(action?.id||''),kind:String(action?.type||''),...rewardsAt(policy,at)};
  }
  function recordedRewards(e){
    const r=e.history?.gameRewards;
    // No snapshot means an older release: keep its original 1 / 2 / 0 economics.
    return r?.version===1?{load:rewardValue(r.load,1),arrive:rewardValue(r.arrive,2),ttn:rewardValue(r.ttn,0)}:rewardDefaults;
  }
  window.__gameRewardSnapshot=rewardSnapshot;
  // Rebuild rewards globally before filtering: later undo/delete affects the original scope.
  function calculate(records,filter={}){
    const entries=scopedRecords(records),origins=new Map(),rewards=new Map(),penalties=[],activeTtn=new Map(),cancelled=new Map(),archivedLoads=new Map();
    const slot=(o,e)=>(o.id+':'+(o.after?.shiftId||o.before?.shiftId||e.scope.shiftId||''));
    const ttnId=(o,e)=>'ttn:'+slot(o,e)+':'+(Number.isFinite(o.after?.ttnRevision)?'rev:'+o.after.ttnRevision:'event:'+(e.history?.gameRewards?.actionId||e.id));
    function candidates(e){
      const ops=e.history?.operations||[],rates=recordedRewards(e),user=key(e.userEmail||e.history?.userEmail),name=e.userName||e.history?.user||user,at=e.history?.gameRewards?.actionAt||e.timestamp||0;
      const loading=ops.some(o=>o.collection==='logs'&&!o.before&&o.after),archiving=ops.some(o=>o.collection==='archive'&&o.after),out=[];
      for(const o of ops){const b=o.before||{},a=o.after||{};
        if(o.collection==='logs'&&!o.before&&o.after&&a.clientOperationId)out.push(['load:'+o.id,{user:key(a.createdByEmail)||user,name:a.createdBy||name,coins:rates.load,kind:'load',scope:e.scope,at,eventId:e.id}]);
        if(o.collection==='truckStatus'){
          if(a.arriveTimestamp&&a.arriveTimestamp!==b.arriveTimestamp&&b.lastLoadTimestamp&&a.arriveTimestamp>b.lastLoadTimestamp)out.push(['arrive:'+o.id+':'+(a.shiftId||'')+':'+a.arriveTimestamp,{user,name,coins:rates.arrive,kind:'arrive',scope:e.scope,at,eventId:e.id}]);
          if(o.before&&o.after&&!b.ttnStatus&&a.ttnStatus&&!loading&&!archiving)out.push([ttnId(o,e),{user,name,coins:rates.ttn,kind:'ttn',scope:e.scope,slot:slot(o,e),at,eventId:e.id}]);
        }
      }
      return out;
    }
    const remove=(id,e,description)=>{const r=rewards.get(id)||origins.get(id);if(r&&!cancelled.has(id))cancelled.set(id,{...r,at:e.timestamp||Date.now(),description});rewards.delete(id);};
    for(const e of entries)if(e.history)for(const [id,r] of candidates(e))if(!origins.has(id))origins.set(id,r);
    for(const e of entries){
      if(e.eventType==='game_penalty'){if(e.amount===-3&&e.targetEmail)penalties.push(e);continue;}
      if(!e.history)continue;
      if(e.history.undone){for(const [id,r] of candidates(e))if(origins.has(id))cancelled.set(id,{...r,at:e.timestamp||r.at,description:'Отменено начисление за действие'});continue;}
      const ops=e.history.operations||[];
      for(const op of ops)if(op.collection==='archive'&&op.after?.sourceShiftId)for(const log of op.after.logs||[])archivedLoads.set(op.after.sourceShiftId+':'+log.id,log);
      const loading=ops.some(o=>o.collection==='logs'&&!o.before&&o.after),archiving=ops.some(o=>o.collection==='archive'&&o.after);
      for(const o of ops){const b=o.before||{},a=o.after||{};
        if(o.collection==='logs'&&!o.after){
          const saved=archivedLoads.get(b.shiftId+':'+o.id);
          const archived=!!saved&&saved.truckId===b.truckId&&saved.timestamp===b.timestamp&&saved.createdByEmail===b.createdByEmail;
          if(!archived)remove('load:'+o.id,e,'Отменено начисление за погрузку');
        }
        if(o.collection==='truckStatus'){
          if(b.arriveTimestamp&&o.after&&!a.arriveTimestamp&&!loading&&!archiving&&a.shiftId===b.shiftId&&a.lastResetOperationId===b.lastResetOperationId&&a.lastLoadTimestamp===b.lastLoadTimestamp)remove('arrive:'+o.id+':'+(b.shiftId||'')+':'+b.arriveTimestamp,e,'Отменено начисление за возвращение');
          if(o.after&&b.ttnStatus&&!a.ttnStatus&&!loading&&!archiving){const k=slot(o,e),id=activeTtn.get(k);if(id)remove(id,e,'Отменено начисление за ТТН');activeTtn.delete(k);}
        }
      }
      for(const [id] of candidates(e)){const r=origins.get(id);if(r.kind==='ttn')activeTtn.set(r.slot,id);rewards.set(id,r);cancelled.delete(id);}
    }
    const users=new Map(),matches=s=>(!filter.shiftId||s.shiftId===filter.shiftId)&&(!filter.objectKey||objectKey(s)===filter.objectKey);
    function row(user,name){if(!users.has(user))users.set(user,{user,name,coins:0,loads:0,arrivals:0,ttns:0,penalties:0});return users.get(user);}
    for(const r of rewards.values()){if(!r.user||!matches(r.scope))continue;const u=row(r.user,r.name);u.coins+=r.coins;u[r.kind==='load'?'loads':r.kind==='ttn'?'ttns':'arrivals']++;}
    for(const e of penalties){if(!matches(e.scope))continue;const u=row(key(e.targetEmail),e.targetName||e.targetEmail);u.coins-=3;u.penalties++;}
    const result=[...users.values()].sort((a,b)=>b.coins-a.coins||a.name.localeCompare(b.name,'ru'));
    result.movements=[];
    for(const [id,r] of origins){if(!r.user||!r.coins||!matches(r.scope))continue;
      result.movements.push({id:'earned:'+id,user:r.user,name:r.name,amount:r.coins,at:r.at,description:({load:'Погрузка',arrive:'Возвращение после погрузки',ttn:'Забрал ТТН'}[r.kind]||'Начисление'),scope:r.scope});
      if(!rewards.has(id)){const c=cancelled.get(id);if(c)result.movements.push({id:'reversed:'+id,user:r.user,name:r.name,amount:-r.coins,at:c.at,description:c.description,scope:r.scope});}
    }
    for(const e of penalties){if(!matches(e.scope))continue;result.movements.push({id:'penalty:'+e.id,user:key(e.targetEmail),name:e.targetName||e.targetEmail,amount:-3,at:e.timestamp||0,description:e.description||'Штраф за отмену действия',scope:e.scope});}
    return result;
  }
  window.__gameCoinsCore={calculate,rank,scopeFor,scopedRecords,rewardsAt,rewardSnapshot,recordedRewards,rewardSchedule,rewardDefaults,rewardLimit};

  let records=[],unsubscribe=null,unsubscribeAdjustments=null,adjustmentListenerKey='',coinAdjustmentRows=[],owner='',ready=false,error='',board=[],configReady=false,lastView='',rankingScope='shift',rankingObject='',rankGuideOpen=false,visualBalance=null,visualOwner='',ledgerOpen=false,ledgerUser='all',ledgerLimit=50,grantTargets=[],grantTargetsLoaded=false,grantTargetsLoading=false,grantBusy=false,grantMessage='',grantAmount='',grantReason='',grantOperationId='',grantTarget='';
  const enabled=()=>configReady&&permissionsLoaded&&currentUserStatus==='active'&&!!currentUid&&appConfig?.testReviewFlags?.game_mode!==false;
  const wallet=document.createElement('button');wallet.id='game-wallet';wallet.hidden=true;wallet.type='button';wallet.setAttribute('aria-label','Монеты и рейтинг пользователей');document.querySelector('#mainHeader .top-row')?.insertBefore(wallet,document.querySelector('#mainHeader .gear-btn'));
  const modal=document.createElement('dialog');modal.id='game-ranking';modal.setAttribute('aria-labelledby','game-title');document.body.append(modal);
  const admin=document.createElement('details');admin.id='game-admin';admin.className='admin-settings-group';admin.hidden=true;
  const gameOptions=[['game_mode','Игровой режим для всех'],['game_sound','Игровые звуки: монеты и салют'],['game_effects','Анимации монет и праздничный салют']];
  admin.innerHTML='<summary>🪙 Игровой режим <span id="game-mode-state"></span></summary><div class="form-card">'
    +gameOptions.map(([id,label])=>'<div class="settings-row"><label for="'+id+'">'+label+'</label><label class="toggle-switch"><input type="checkbox" id="'+id+'" data-game-setting="'+id+'"><span class="toggle-slider"></span></label></div>').join('')
    +'<p class="game-note">Общие настройки для всех пользователей. Монеты и штрафы продолжают учитываться при выключенном игровом режиме. Уведомления о штрафах остаются доступны.</p>'
    +'<div class="game-preview-settings" id="game-reward-settings"><label>Монеты за действия</label><p class="game-note">Для новых подтверждённых действий. Ранее заработанные монеты сохраняются. 0 — не начислять.</p>'
    +[['load','⚡ Погрузка'],['arrive','🚛 Приехал после погрузки'],['ttn','📄 Забрал ТТН']].map(([id,label])=>'<label for="game-reward-'+id+'">'+label+'</label><input class="form-control" id="game-reward-'+id+'" data-game-reward="'+id+'" type="number" inputmode="numeric" min="0" max="'+rewardLimit+'" step="1" value="'+rewardDefaults[id]+'">').join('')
    +'<button type="button" id="game-rewards-save" class="btn btn-primary">Сохранить начисления</button><p id="game-rewards-status" class="game-note" role="status"></p></div>'
    +'<div class="game-preview-settings"><label for="game-preview-rank">Проверить поздравление</label><select id="game-preview-rank" class="form-control">'+levels.map(l=>'<option value="'+l.at+'"'+(l.at===25?' selected':'')+'>'+escapeHtml(l.name)+' · '+l.at.toLocaleString('ru-RU')+' 🪙</option>').join('')+'</select><button type="button" id="game-preview-rank-button" class="btn btn-secondary btn-small">🎉 Показать поздравление</button><p class="game-note">Только на вашем экране. Баланс, ранг и история достижений не меняются. Звук и анимация учитывают настройки выше.</p></div></div>';
  document.getElementById('admin-game-settings-slot')?.append(admin);
  const gameControls=[...admin.querySelectorAll('[data-game-setting]')],savingFlags=new Set();
  const rewardInputs=[...admin.querySelectorAll('[data-game-reward]')],rewardSave=admin.querySelector('#game-rewards-save'),rewardStatus=admin.querySelector('#game-rewards-status');
  let rewardSaving=false,rewardDirty=false,rewardMessage='';
  rewardInputs.forEach(input=>input.addEventListener('input',()=>{rewardDirty=true;rewardMessage='';rewardStatus.textContent='';}));
  async function saveRewardSettings(){
    if(!canAdmin()||rewardSaving)return;
    const values={};for(const input of rewardInputs){const raw=input.value.trim(),n=Number(raw);if(!raw||rewardValue(n,null)===null){rewardMessage='Введите целые числа от 0 до '+rewardLimit+'.';rewardStatus.textContent=rewardMessage;input.focus();return;}values[input.dataset.gameReward]=n;}
    if(!navigator.onLine){rewardMessage='Для сохранения настроек подключитесь к интернету.';rewardStatus.textContent=rewardMessage;return;}
    rewardSaving=true;rewardMessage='Сохраняем…';paint();const user=currentUid;
    try{
      const next=isNasRuntime()?(await nasSaveSettings(null,values)).gameRewardSchedule:await db.runTransaction(async tx=>{
        const doc=await tx.get(appConfigRef);
        if(!canAdmin()||currentUid!==user)throw Error('Доступ администратора изменился.');
        const policy=doc.exists?doc.data():{},schedule=rewardSchedule(policy),current=rewardsAt(policy);
        if(['load','arrive','ttn'].every(k=>current[k]===values[k]))return schedule;
        // Existing versions stay append-only; history snapshots keep old balances immutable.
        const effectiveAt=Math.max(Date.now(),(schedule.at(-1)?.effectiveAt||0)+1);
        const updated=[...schedule,{effectiveAt,...values}];
        if(updated.length>1000)throw Error('История настроек заполнена. Обратитесь к разработчику; старые ставки не удалены.');
        tx.set(appConfigRef,{gameRewardSchedule:updated},{merge:true});return updated;
      });
      if(currentUid===user){appConfig.gameRewardSchedule=next;rewardDirty=false;rewardMessage='Сохранено. Новые ставки действуют для следующих действий.';lastView='';window.dispatchEvent(new Event('review-flags-changed'));}
    }catch(e){rewardMessage='Не удалось сохранить: '+(e.message||'проверьте соединение');}
    finally{rewardSaving=false;paint();}
  }
  rewardSave.onclick=saveRewardSettings;
  function paintRewardSettings(){
    const rates=rewardsAt(appConfig);rewardInputs.forEach(input=>{if(!rewardDirty&&!rewardSaving)input.value=String(rates[input.dataset.gameReward]);input.disabled=!canAdmin()||rewardSaving;});
    rewardSave.disabled=!canAdmin()||rewardSaving;rewardStatus.textContent=rewardMessage;
  }

  async function saveGameSetting(input){
    const flag=input.dataset.gameSetting;
    if(!canAdmin()||!gameOptions.some(([id])=>id===flag)){paint();return;}
    const value=input.checked;savingFlags.add(flag);input.disabled=true;
    try{if(isNasRuntime())await nasSaveSettings({testReviewFlags:{[flag]:value}});else await appConfigRef.set({testReviewFlags:{[flag]:value}},{merge:true});appConfig.testReviewFlags={...appConfig.testReviewFlags,[flag]:value};window.dispatchEvent(new Event('review-flags-changed'));}
    catch(e){showError('Не удалось сохранить настройку: '+e.message);}
    finally{savingFlags.delete(flag);paint();}
  }
  gameControls.forEach(input=>input.onchange=()=>saveGameSetting(input));
  admin.querySelector('#game-preview-rank-button').onclick=previewRankCelebration;
  function ledgerEntries(rows){
    const out=[];
    const earned=window.__gameCoinsCore.calculate(rows).movements||[];
    for(const m of earned)out.push({...m,email:m.user,uid:''});
    for(const e of rows){
      if(e.eventType==='game_purchase'&&Number.isSafeInteger(e.price)&&e.price>0)
        out.push({id:'purchase:'+e.id,uid:e.userUid||'',email:e.userEmail||'',name:e.userName||e.userEmail||'',at:e.timestamp||0,amount:-e.price,description:e.text||('Покупка '+(e.itemId||'темы'))});
      if(e.eventType==='game_arcade'&&e.kind!=='purchase'){
        if(Number.isSafeInteger(e.cost)&&e.cost>0)out.push({id:'arcade-cost:'+e.id,uid:e.userUid||'',email:e.userEmail||'',name:e.userName||e.userEmail||'',at:e.timestamp||0,amount:-e.cost,description:(e.text||'Мини-игра')+' · ставка'});
        if(Number.isSafeInteger(e.payout)&&e.payout>0)out.push({id:'arcade-payout:'+e.id,uid:e.userUid||'',email:e.userEmail||'',name:e.userName||e.userEmail||'',at:e.timestamp||0,amount:e.payout,description:(e.text||'Мини-игра')+' · выплата'});
      }
      }
    for(const e of coinAdjustmentRows){if(e.eventType==='game_coin_adjustment'&&Number.isSafeInteger(e.amount)&&e.amount>0)out.push({id:'grant:'+e.id,uid:e.targetUid||'',email:e.targetEmail||'',name:e.targetName||e.targetEmail||'',at:e.timestamp||0,amount:e.amount,description:'Награда администратора: '+(e.reason||'без причины')});}
    return out.sort((a,b)=>(b.at||0)-(a.at||0)||String(a.id).localeCompare(String(b.id)));
  }
  function renderCoinLedger(rows,balance,esc){
    const all=canAdmin(),scope=all?ledgerUser:'self',target=grantTargets.find(u=>u.id===scope),targetEmail=scope==='self'?currentEmail:target?.email||'',targetUid=scope==='self'?currentUid:target?.id||'';
    const list=ledgerEntries(rows).filter(x=>all&&scope==='all'||(targetUid&&x.uid===targetUid)||(targetEmail&&key(x.email)===key(targetEmail)));
    const shown=list.slice(0,ledgerLimit);
    const userOptions=grantTargets.map(u=>'<option value="'+esc(u.id)+'" '+(ledgerUser===u.id?'selected':'')+'>'+esc(u.nickname||u.name||u.email)+' · '+esc(u.email||'')+'</option>').join('');
    const adminControls=all?'<div class="game-ledger-admin"><label>Пользователь<select id="game-ledger-user"><option value="all" '+(ledgerUser==='all'?'selected':'')+'>Все пользователи</option><option value="self" '+(ledgerUser==='self'?'selected':'')+'>Мои движения</option>'+userOptions+'</select></label><div class="game-ledger-award"><b>Начислить монеты</b><select id="game-grant-user"><option value="">Выберите пользователя</option>'+grantTargets.filter(u=>u.status==='active').map(u=>'<option value="'+esc(u.id)+'" '+(grantTarget===u.id?'selected':'')+'>'+esc(u.nickname||u.name||u.email)+' · '+esc(u.email||'')+'</option>').join('')+'</select><input id="game-grant-amount" class="form-control" type="number" min="1" max="10000" step="1" inputmode="numeric" placeholder="Количество" value="'+esc(grantAmount)+'"><input id="game-grant-reason" class="form-control" type="text" maxlength="160" placeholder="Причина начисления" value="'+esc(grantReason)+'"><button type="button" class="btn btn-primary btn-small" id="game-grant-submit" '+(grantBusy?'disabled':'')+'>Начислить</button><p role="status">'+esc(grantMessage)+'</p></div></div>':'';
    const table=shown.length?'<div class="game-ledger-scroll"><table class="game-ledger-table"><thead><tr><th>Дата</th>'+((all&&ledgerUser==='all')?'<th>Пользователь</th>':'')+'<th>Движение</th><th>Монеты</th></tr></thead><tbody>'+shown.map(x=>'<tr><td>'+esc(x.at?new Date(x.at).toLocaleString('ru-RU'):'—')+'</td>'+((all&&ledgerUser==='all')?'<td>'+esc(resolveUserDisplayName(x.email,x.name))+'</td>':'')+'<td>'+esc(x.description||'Операция')+'</td><td class="'+(x.amount>0?'positive':'negative')+'">'+(x.amount>0?'+':'')+x.amount.toLocaleString('ru-RU')+'</td></tr>').join('')+'</tbody></table></div>':'<p class="game-note">Движений пока нет.</p>';
    return '<section class="game-ledger"><h3>Движение монет</h3><p class="game-note">Ваш доступный баланс: <b>'+balance.toLocaleString('ru-RU')+' 🪙</b>. Плюс — начисление, минус — расход или отменённое начисление.</p>'+adminControls+table+'<p class="game-note">Показано '+shown.length+' из '+list.length+' движений.</p>'+(list.length>shown.length?'<button type="button" id="game-ledger-more" class="btn btn-secondary btn-small">Показать ещё</button>':'')+'</section>';
  }
  async function loadGrantTargets(){
    if(grantTargetsLoaded||grantTargetsLoading||!canAdmin())return;
    grantTargetsLoading=true;grantMessage='Загружаем пользователей…';paint();
    try{if(isNasRuntime()){await refreshNasAdministration();grantTargets=state.users.slice();}else{const snap=await usersRef.get();grantTargets=snap.docs.map(doc=>({id:doc.id,...doc.data()}));}grantTargets.sort((a,b)=>String(a.nickname||a.email||a.id).localeCompare(String(b.nickname||b.email||b.id),'ru'));grantTargetsLoaded=true;grantMessage='';}
    catch(e){grantMessage='Не удалось загрузить пользователей: '+(e.message||'проверьте связь');}
    finally{grantTargetsLoading=false;paint();}
  }
  async function submitCoinGrant(){
    if(!canAdmin()||grantBusy)return;
    const target=grantTargets.find(u=>u.id===modal.querySelector('#game-grant-user')?.value);
    const amount=Number(modal.querySelector('#game-grant-amount')?.value),reason=String(modal.querySelector('#game-grant-reason')?.value||'').trim();
    if(!target||target.status!=='active'){grantMessage='Выберите активного пользователя.';paint();return;}
    if(!Number.isSafeInteger(amount)||amount<1||amount>10000){grantMessage='Введите целое число от 1 до 10 000.';paint();return;}
    if(reason.length<3||reason.length>160){grantMessage='Укажите причину (от 3 до 160 символов).';paint();return;}
    if(!navigator.onLine){grantMessage='Для начисления нужна связь с сервером.';paint();return;}
    const actor=currentUid,operationId=grantOperationId||(crypto.randomUUID?crypto.randomUUID():Date.now()+'_'+Math.random().toString(36).slice(2));grantOperationId=operationId;const ref=refs.coinTransactions.doc('coin_grant_'+encodeURIComponent(target.id)+'_'+operationId);
    grantBusy=true;grantMessage='Сохраняем начисление…';grantAmount=String(amount);grantReason=reason;paint();
    try{
      if(isNasRuntime())await nasGrantCoins(target.id,amount,reason);else await db.runTransaction(async tx=>{
        const duplicate=await tx.get(ref);if(duplicate.exists)return;
        const profile=await tx.get(usersRef.doc(target.id));
        if(!canAdmin()||currentUid!==actor)throw Error('Права администратора изменились.');
        if(!profile.exists||profile.data().status!=='active'||profile.data().email!==target.email)throw Error('Пользователь неактивен или изменился.');
        const timestamp=Date.now(),entry={eventType:'game_coin_adjustment',amount,targetUid:target.id,targetEmail:target.email,targetName:target.nickname||target.name||target.email,reason,timestamp,userEmail:currentEmail,userName:getUserName(),createdByEmail:currentEmail,createdByUid:currentUid,text:'Начисление +'+amount+' монет: '+reason,timeStr:new Date(timestamp).toLocaleString('ru-RU')};
        tx.set(ref,entry);
      });
      grantMessage='Начислено '+amount.toLocaleString('ru-RU')+' 🪙 пользователю '+(target.nickname||target.email)+'.';
      grantAmount='';grantReason='';grantOperationId='';
    }catch(e){grantMessage='Не удалось начислить: '+(e.message||'проверьте доступ и соединение');}
    finally{grantBusy=false;lastView='';paint();}
  }
  function paint(){
    decorateButtons();wallet.hidden=!enabled();admin.hidden=!canAdmin();paintRewardSettings();
    gameControls.forEach(input=>{const id=input.dataset.gameSetting;if(!savingFlags.has(id))input.checked=appConfig?.testReviewFlags?.[id]!==false;input.disabled=!canAdmin()||savingFlags.has(id)||(id!=='game_mode'&&!enabled());});
    admin.querySelector('#game-mode-state').textContent=enabled()?'Включён':'Выключен';
    if(!enabled()){if(modal.open)modal.close();cancelCoinFeedback();cancelRankCelebration({keepPreview:canAdmin()});return;}
    if(appConfig?.testReviewFlags?.game_effects===false)cancelCoinFeedback();
    const overall=calculate(records);const me=overall.find(r=>r.user===key(currentEmail)),coins=me?.coins||0;
    const spent=window.RoadShop?.spent(records,currentUid)||0,balance=window.RoadShop?window.RoadShop.available(coins,spent,currentUserRole,currentUserStatus):coins-spent;
    if(visualOwner!==currentUid){visualOwner=currentUid;visualBalance=null;}
    if(ready&&(!window.RoadArcade||window.RoadArcade.status().hydrated)){if(visualBalance!==null&&balance<visualBalance)window.__gameMoneyFlow?.(balance-visualBalance);visualBalance=balance;}
    const objects=objectOptions(records);if(!rankingObject)rankingObject=state.shift?.objectId?'id:'+state.shift.objectId:objects[0]?.key||'';
    const filter=rankingScope==='shift'?{shiftId:state.shift?.id||'__none__'}:rankingScope==='object'?{objectKey:rankingObject||'__none__'}:{};board=calculate(records,filter);
    wallet.textContent='🪙 '+(ready?balance.toLocaleString('ru-RU'):'…');wallet.title=rank(coins).name+' · Открыть рейтинг';
    if(!modal.open)return;
    const displayNames=board.map(r=>resolveUserDisplayName(r.user,r.name)),myName=resolveUserDisplayName(currentEmail,getUserName());
    const view=JSON.stringify([board,coins,balance,currentEmail,myName,displayNames,ready,error,rankingScope,rankingObject,state.shift?.id,objects,rankGuideOpen,rewardsAt(appConfig),ledgerOpen,ledgerUser,ledgerLimit,grantTargets.map(u=>u.id),grantBusy,grantMessage,grantAmount,grantReason,grantTarget,ledgerOpen?ledgerEntries(records):null]);if(view===lastView&&modal.innerHTML)return;lastView=view;
    const level=rank(coins),next=levels.find(x=>x.at>coins),esc=escapeHtml;
    modal.innerHTML='<div class="game-head"><h2 id="game-title">Лига дорожной бригады</h2><button aria-label="Закрыть рейтинг">×</button></div>'
      +'<div class="game-profile"><div class="game-profile-name">'+esc(myName)+'</div><div class="game-profile-rank">'+esc(level.name)+'</div>'
      +'<div class="game-profile-balance"><span class="game-profile-label">Кошелёк · доступно для покупок</span><strong class="game-profile-value"><span aria-hidden="true">🪙</span>'+balance.toLocaleString('ru-RU')+'</strong><small>Рейтинг: '+coins.toLocaleString('ru-RU')+' · Покупки его не уменьшают</small></div>'
      +'<div class="game-profile-progress">'+(next?'<progress value="'+Math.max(0,coins-level.at)+'" max="'+(next.at-level.at)+'" aria-label="Прогресс до следующего ранга"></progress><div>Ещё '+(next.at-coins)+' 🪙 до ранга «'+esc(next.name)+'»</div>':'<div>👑 Высший ранг — вы легенда команды!</div>')+'</div></div>'
      +'<button type="button" id="game-ledger-toggle" aria-expanded="'+ledgerOpen+'">📒 Движение монет</button>'+(ledgerOpen?renderCoinLedger(records,balance,esc):'')
      +'<button type="button" id="game-ranks-toggle" aria-expanded="'+rankGuideOpen+'" aria-controls="game-ranks-guide">🏅 Все ранги · '+levels.length+'</button>'+renderRankGuide(coins)
      +'<div class="game-scopes" role="group" aria-label="Период рейтинга">'+[['all','Общий'],['shift','Текущая смена'],['object','Объект']].map(([id,label])=>'<button type="button" data-game-scope="'+id+'" aria-pressed="'+(rankingScope===id)+'">'+label+'</button>').join('')+'</div>'
      +(rankingScope==='object'?'<label class="game-note">Объект <select id="game-object">'+objects.map(o=>'<option value="'+esc(o.key)+'" '+(o.key===rankingObject?'selected':'')+'>'+esc(o.name)+'</option>').join('')+'</select></label>':'')
      +'<h3>Рейтинг команды'+(rankingScope==='shift'?' · текущая смена':rankingScope==='object'?' · объект':' · за всё время')+'</h3><p class="game-note">Текущие начисления: погрузка +'+rewardsAt(appConfig).load+' · возвращение после погрузки +'+rewardsAt(appConfig).arrive+' · «Забрал ТТН» +'+rewardsAt(appConfig).ttn+'. Первый приезд — без монет. Новые ставки не пересчитывают прошлые действия. Ошибочное действие: штраф −3 автору при отмене. Награда отменённого действия также аннулируется. Штраф остаётся при восстановлении; повторно за то же действие не списывается.</p>'
      +(rankingScope==='shift'&&!state.shift?.id?'<p class="game-note">Смена не начата.</p>':'')
      +(error?'<p role="status">'+esc(error)+'</p>':!ready?'<p role="status">Загружаем накопления…</p>':board.length?board.map((r,i)=>'<div class="game-row '+(r.user===key(currentEmail)?'me':'')+'"><span class="game-place">'+(['🥇','🥈','🥉'][i]||i+1)+'</span><div class="game-person"><b>'+esc(displayNames[i])+(r.user===key(currentEmail)?' · вы':'')+'</b><small>Отметки погрузки: '+r.loads+' · Возвращения: '+r.arrivals+' · ТТН: '+r.ttns+' · Штрафы: '+r.penalties+' (−'+(r.penalties*3)+')</small></div><b class="game-score">'+r.coins+' 🪙</b></div>').join(''):'<p class="game-note">Здесь появятся участники, которые отмечают машины на линии фрезерования.</p>');
    modal.querySelector('.game-head button').onclick=()=>modal.close();
    modal.querySelector('#game-ledger-toggle').onclick=()=>{ledgerOpen=!ledgerOpen;ledgerLimit=50;grantMessage='';paint();if(ledgerOpen&&canAdmin())loadGrantTargets();};
    const ledgerUserSelect=modal.querySelector('#game-ledger-user');if(ledgerUserSelect)ledgerUserSelect.onchange=()=>{ledgerUser=ledgerUserSelect.value;paint();};
    modal.querySelector('#game-ledger-more')?.addEventListener('click',()=>{ledgerLimit+=50;lastView='';paint();});
    const grantSubmit=modal.querySelector('#game-grant-submit');if(grantSubmit)grantSubmit.onclick=submitCoinGrant;
    const grantTargetInput=modal.querySelector('#game-grant-user');if(grantTargetInput)grantTargetInput.onchange=()=>{grantTarget=grantTargetInput.value;grantOperationId='';};
    const grantAmountInput=modal.querySelector('#game-grant-amount');if(grantAmountInput)grantAmountInput.oninput=()=>{grantAmount=grantAmountInput.value;grantOperationId='';};
    const grantReasonInput=modal.querySelector('#game-grant-reason');if(grantReasonInput)grantReasonInput.oninput=()=>{grantReason=grantReasonInput.value;grantOperationId='';};
    modal.querySelector('#game-ranks-toggle').onclick=()=>{rankGuideOpen=!rankGuideOpen;paint();modal.querySelector('#game-ranks-toggle')?.focus();};
    modal.querySelectorAll('[data-game-scope]').forEach(b=>b.onclick=()=>{rankingScope=b.dataset.gameScope;paint();});
    const objectSelect=modal.querySelector('#game-object');if(objectSelect)objectSelect.onchange=()=>{rankingObject=objectSelect.value;paint();};
  }
  wallet.onclick=()=>{rankingScope='shift';rankGuideOpen=false;modal.showModal();paint();};
  modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close();}});
  function decorateButtons(){
    document.querySelectorAll('.truck-card[data-truck-id]').forEach(card=>{
      const st=state.truckStatus[card.dataset.truckId]||{};
      card.querySelectorAll('.btn-quick,.btn-arrive,.btn-ttn').forEach(button=>{
        const kind=button.classList.contains('btn-quick')?'load':button.classList.contains('btn-ttn')?'ttn':'arrive',amount=rewardsAt(appConfig)[kind];
        const earns=enabled()&&!button.disabled&&amount>0&&(kind==='load'||kind==='ttn'&&!st.ttnStatus||kind==='arrive'&&!st.arriveStatus&&!!st.lastLoadTimestamp);
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
  document.addEventListener('pointerdown',e=>{if(e.target.closest('.btn-quick,.btn-arrive,.btn-ttn,#game-wallet,#game-ranks-toggle'))unlockCoinAudio();},true);
  document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.closest('.btn-quick,.btn-arrive,.btn-ttn,#game-wallet,#game-ranks-toggle'))unlockCoinAudio();},true);
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
  /* RANK CELEBRATION V2 START — presentation only; no score or reward writes. */
  let rankFireworkCanvas=null,rankFireworkFrame=null,rankLifecycleTimer=null,rankAudioBus=null;
  const rankAudioNodes=new Map();
  function stopRankAudio(){
    for(const source of [...applauseSources]){try{source.stop();}catch(e){}try{source.disconnect();}catch(e){}}
    applauseSources.clear();
    for(const nodes of rankAudioNodes.values())for(const node of nodes)try{node.disconnect();}catch(e){}
    rankAudioNodes.clear();
    if(rankAudioBus){for(const node of rankAudioBus.nodes)try{node.disconnect();}catch(e){}rankAudioBus=null;}
  }
  function dismissRankNotice(){
    stopRankFireworks();stopRankAudio();
    clearTimeout(rankLifecycleTimer);rankLifecycleTimer=null;
    clearTimeout(rankNoticeTimer);rankNoticeTimer=null;rankNotice?.remove();rankNotice=null;rankNoticePreview=false;
  }
  function stopRankFireworks(){
    if(rankFireworkFrame!==null)cancelAnimationFrame(rankFireworkFrame);
    rankFireworkFrame=null;rankFireworkCanvas?.remove();rankFireworkCanvas=null;
  }
  // Gentle, self-contained pyrotechnics: shaped noise + a low transient, not applause.
  // Sources and all graph nodes are tracked so close/revocation stops even scheduled sound.
  function rankFireworkSound(preview=false,kind='burst',pan=0,energy=1){
    if(!(preview?canAdmin():enabled())||appConfig?.testReviewFlags?.game_sound===false||!audioContext||audioContext.state!=='running')return;
    try{
      const ac=audioContext,rate=ac.sampleRate,t=ac.currentTime+.008;
      if(!rankAudioBus){
        const input=ac.createGain(),compressor=ac.createDynamicsCompressor(),output=ac.createGain();
        input.gain.value=.42;compressor.threshold.value=-14;compressor.knee.value=12;compressor.ratio.value=5;compressor.attack.value=.004;compressor.release.value=.18;output.gain.value=.6;
        input.connect(compressor);compressor.connect(output);output.connect(ac.destination);
        rankAudioBus={input,nodes:[input,compressor,output]};
      }
      const duration=kind==='launch'?.42:kind==='cue'?.72:1.12,buffer=ac.createBuffer(1,Math.ceil(rate*duration),rate),data=buffer.getChannelData(0);
      let brown=0;
      // A bounded deterministic generator avoids non-repeatable harsh impulses.
      let seed=kind==='launch'?173:827;
      const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2147483648-1;};
      for(let i=0;i<data.length;i++){
        const age=i/rate,n=noise();brown=(brown+.035*n)/1.035;
        if(kind==='cue'){const envelope=Math.min(1,age/.035)*Math.exp(-age*5)*Math.min(1,(duration-age)/.09);data[i]=(Math.sin(2*Math.PI*523.25*age)*.19+Math.sin(2*Math.PI*659.25*age)*.11+Math.sin(2*Math.PI*783.99*age)*.07)*envelope;}
        else if(kind==='launch')data[i]=n*.11*Math.sin(Math.PI*age/duration)**2;
        else{
          const attack=Math.min(1,age/.009),body=(brown*2.1+n*.13)*Math.exp(-age*6.5),thump=Math.sin(2*Math.PI*(67*age-15*age*age))*.24*Math.exp(-age*13);
          // Uneven late crackles, each with a smooth 2ms onset and soft tail.
          let crackle=0;for(const at of [.17,.235,.31,.41,.54,.67,.81]){const d=age-at;if(d>=0&&d<.045)crackle+=n*.095*Math.min(1,d/.002)*Math.exp(-d*100)*(1-at*.65);}
          data[i]=(body+thump)*attack+crackle;
        }
      }
      const source=ac.createBufferSource(),filter=ac.createBiquadFilter(),gain=ac.createGain(),nodes=[source,filter,gain];
      source.buffer=buffer;filter.type='lowpass';filter.frequency.value=kind==='launch'?1600:2600;filter.Q.value=.45;gain.gain.value=Math.max(.15,Math.min(energy,1));
      source.connect(filter);filter.connect(gain);
      if(typeof ac.createStereoPanner==='function'){const stereo=ac.createStereoPanner();stereo.pan.value=Math.max(-.7,Math.min(.7,pan));gain.connect(stereo);stereo.connect(rankAudioBus.input);nodes.push(stereo);}else gain.connect(rankAudioBus.input);
      applauseSources.add(source);rankAudioNodes.set(source,nodes);
      source.onended=()=>{applauseSources.delete(source);for(const node of rankAudioNodes.get(source)||[])try{node.disconnect();}catch(e){}rankAudioNodes.delete(source);};
      source.start(t);source.stop(t+duration+.02);
    }catch(e){stopRankAudio();/* Audio support is optional and never interrupts work. */}
  }
  function startRankFireworks(preview=false){
    stopRankFireworks();
    if(appConfig?.testReviewFlags?.game_effects===false||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const canvas=document.createElement('canvas');canvas.id='game-rank-fireworks';canvas.setAttribute('aria-hidden','true');
    let ctx;try{ctx=canvas.getContext?.('2d');}catch(e){return;}if(!ctx)return;
    document.body.append(canvas);rankFireworkCanvas=canvas;
    // Four rockets, 264 sparks total; no particle creation inside the animation loop.
    const bursts=[{at:.02,x:-.78,y:-.95,hue:42,count:72,size:1},{at:.43,x:.85,y:-.65,hue:171,count:60,size:.85},{at:.85,x:-.8,y:.8,hue:35,count:60,size:.83},{at:1.21,x:.35,y:-1.1,hue:46,count:72,size:1.03}];
    for(const b of bursts){b.flight=.49+b.size*.07;b.launched=false;b.exploded=false;b.sparks=Array.from({length:b.count},(_,i)=>({angle:Math.PI*2*i/b.count+(Math.random()-.5)*.1,speed:(.48+Math.random()*.55)*b.size,life:.82+Math.random()*.52,width:.7+Math.random()*.85,phase:Math.random()*6.28,depth:.68+Math.random()*.32}));}
    const started=performance.now();let width=0,height=0,dpr=0;
    function frame(now){
      if(!canvas.isConnected||document.hidden||!rankNotice||!(preview?canAdmin():enabled())||appConfig?.testReviewFlags?.game_effects===false||matchMedia('(prefers-reduced-motion: reduce)').matches){stopRankFireworks();stopRankAudio();return;}
      const elapsed=(now-started)/1000;if(elapsed>3.35){stopRankFireworks();return;}
      const w=window.innerWidth,h=window.innerHeight,pixelRatio=Math.min(window.devicePixelRatio||1,2);
      if(w!==width||h!==height||pixelRatio!==dpr){width=w;height=h;dpr=pixelRatio;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);}
      ctx.clearRect(0,0,width,height);ctx.globalCompositeOperation='lighter';ctx.lineCap='round';
      const radius=Math.min(width*.39,height*.34,245),spread=Math.min(width*.34,235),vertical=Math.min(height*.27,195);
      for(const b of bursts){
        const rocketAge=elapsed-b.at,age=rocketAge-b.flight;if(rocketAge<0)continue;
        const x=width/2+b.x*spread,y=height/2+b.y*vertical;
        if(!b.launched){b.launched=true;if(rocketAge<.12)rankFireworkSound(preview,'launch',b.x*.55,.48);}
        if(age<0){
          const originY=Math.min(height+12,y+radius*1.6),originX=x-b.x*radius*.28;
          const position=u=>({x:originX+(x-originX)*u,y:originY+(y-originY)*(1-(1-u)**1.55)});
          for(let j=6;j>=0;j--){const u=Math.max(0,Math.min(1,rocketAge/b.flight-j*.025)),p=position(u),q=position(Math.max(0,u-.035));ctx.strokeStyle='rgba(255,211,128,'+((1-j/7)*.85)+')';ctx.lineWidth=j?1.2:2;ctx.beginPath();ctx.moveTo(q.x,q.y);ctx.lineTo(p.x,p.y);ctx.stroke();}
          continue;
        }
        if(!b.exploded){b.exploded=true;if(age<.14)rankFireworkSound(preview,'burst',b.x*.55,b.size);}
        // Small local core only: no screen flash, and sparks fall under gravity.
        if(age<.16){const glow=ctx.createRadialGradient(x,y,0,x,y,22);glow.addColorStop(0,'rgba(255,241,190,'+(.46*(1-age/.16))+')');glow.addColorStop(1,'transparent');ctx.fillStyle=glow;ctx.fillRect(x-22,y-22,44,44);}
        for(const p of b.sparks){
          if(age>p.life)continue;
          const position=t=>{const distance=radius*p.speed*(1-Math.exp(-2.5*t));return {x:x+Math.cos(p.angle)*distance,y:y+Math.sin(p.angle)*distance*p.depth+radius*.25*t*t};};
          const head=position(age),tail=position(Math.max(0,age-.045)),fade=Math.pow(1-age/p.life,1.35),alpha=fade*(.83+.17*Math.sin(age*22+p.phase));
          ctx.strokeStyle='hsla('+b.hue+',85%,'+(70-age*17)+'%,'+alpha+')';ctx.lineWidth=p.width;ctx.beginPath();ctx.moveTo(tail.x,tail.y);ctx.lineTo(head.x,head.y);ctx.stroke();
          if(age<.55){ctx.fillStyle='rgba(255,247,210,'+(alpha*.85)+')';ctx.fillRect(head.x-.6,head.y-.6,1.2,1.2);}
        }
      }
      ctx.globalCompositeOperation='source-over';rankFireworkFrame=requestAnimationFrame(frame);
    }
    rankFireworkFrame=requestAnimationFrame(frame);
  }
  function showRankNotice(milestone,preview=false){
    dismissRankNotice();
    if(document.hidden||!(preview?canAdmin():enabled()))return;
    const el=document.createElement('aside');el.id='game-rank-celebration';el.setAttribute('role','status');el.setAttribute('aria-live','polite');el.setAttribute('aria-atomic','true');
    const effects=appConfig?.testReviewFlags?.game_effects!==false&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.classList.toggle('festive',effects);
    const index=Math.max(0,levels.findIndex(l=>l.at===milestone.at)),numerals=['I','II','III','IV','V','VI'];
    const title=document.createElement('strong');title.className='rank-eyebrow';title.textContent=milestone.at?'НОВЫЙ РАНГ':'ДОБРО ПОЖАЛОВАТЬ';
    const emblem=document.createElement('span');emblem.className='rank-emblem';emblem.setAttribute('aria-hidden','true');
    // Original inline vector artwork; no external image, font, audio or network request.
    emblem.innerHTML='<svg viewBox="0 0 116 100" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="rankGold" x1="30" y1="8" x2="83" y2="85" gradientUnits="userSpaceOnUse"><stop stop-color="#fff1b5"/><stop offset=".45" stop-color="#d4a849"/><stop offset="1" stop-color="#8e682c"/></linearGradient></defs><path d="M30 80C13 69 9 47 20 31M86 80c17-11 21-33 10-49" stroke="#c5a35e" stroke-width="1.4"/><path d="M20 63c-9-2-12-7-12-14 8 1 12 6 12 14Zm-2-15c-7-4-8-10-6-16 7 3 9 8 6 16Zm3-14c-4-6-3-12 1-17 5 6 4 11-1 17ZM25 74c-8 1-14-2-17-8 8-2 14 1 17 8Zm71-11c9-2 12-7 12-14-8 1-12 6-12 14Zm2-15c7-4 8-10 6-16-7 3-9 8-6 16Zm-3-14c4-6 3-12-1-17-5 6-4 11 1 17ZM91 74c8 1 14-2 17-8-8-2-14 1-17 8Z" fill="#c8a45c"/><path d="m58 5 31 18v37L58 88 27 60V23L58 5Z" fill="url(#rankGold)"/><path d="m58 11 25 15v32L58 81 33 58V26l25-15Z" fill="#1c2b36" stroke="#f7dc90" stroke-opacity=".65"/><path d="m58 17 19 11v27L58 73 39 55V28l19-11Z" fill="#e7bd5c" fill-opacity=".1"/><path d="m58 23 2.5 5.4 5.9.7-4.4 4 .9 5.8-4.9-2.8-5 2.8 1-5.8-4.4-4 5.9-.7L58 23Z" fill="#ffe5a0"/><path d="m38 84 20 9 20-9" stroke="#d7b564" stroke-width="1.2"/></svg><span>'+numerals[index]+'</span>';
    const text=document.createElement('p');text.className='rank-name';text.textContent=milestone.name.replace(/^\S+\s+/u,'');
    const message=document.createElement('p');message.className='rank-message';message.textContent=milestone.at?'Отличная работа. Так держать!':'Большой путь начинается с первого шага.';
    const detail=document.createElement('span');detail.className='rank-milestone';
    const tier=document.createElement('span');tier.textContent='РАНГ '+(index+1)+' / '+levels.length;
    const dot=document.createElement('i');dot.setAttribute('aria-hidden','true');
    const threshold=document.createElement('span');threshold.textContent=milestone.at.toLocaleString('ru-RU')+' МОНЕТ';detail.append(tier,dot,threshold);
    const note=document.createElement('small');note.className='rank-footnote';note.textContent=preview?'Предпросмотр · баланс не меняется':'Заслужено работой на линии';
    const close=document.createElement('button');close.className='rank-dismiss';close.type='button';close.textContent='×';close.setAttribute('aria-label','Закрыть поздравление');close.onclick=dismissRankNotice;
    el.append(title,emblem,text,message,detail,note,close);document.body.append(el);rankNotice=el;rankNoticePreview=preview;
    const sessionUid=currentUid,tab=document.querySelector('.tab-content.active')?.id;
    function watch(){
      if(!rankNotice)return;
      if(document.hidden||sessionUid!==currentUid||!(preview?canAdmin():enabled())||tab!==document.querySelector('.tab-content.active')?.id){dismissRankNotice();return;}
      if(appConfig?.testReviewFlags?.game_sound===false)stopRankAudio();
      if(appConfig?.testReviewFlags?.game_effects===false||matchMedia('(prefers-reduced-motion: reduce)').matches){if(rankFireworkCanvas){stopRankFireworks();stopRankAudio();}el.classList.remove('festive');}
      rankLifecycleTimer=setTimeout(watch,100);
    }
    rankLifecycleTimer=setTimeout(watch,100);
    if(effects)startRankFireworks(preview);
    // Independent sound preference: static card gets one gentle chord, never orphan rockets.
    if(!rankFireworkCanvas)rankFireworkSound(preview,'cue',0,.7);
    rankNoticeTimer=setTimeout(dismissRankNotice,3600);
  }
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&rankNotice)dismissRankNotice();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)dismissRankNotice();});
  for(const event of ['pagehide','popstate','hashchange'])window.addEventListener(event,dismissRankNotice);
  /* RANK CELEBRATION V2 END */
  function cancelRankCelebration({keepPreview=false}={}){
    if(!keepPreview||!rankNoticePreview)dismissRankNotice();clearTimeout(rankQueueTimer);rankQueueTimer=null;pendingRankAt=null;
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
    if(!enabled()||!(op.type==='load'||op.type==='arrive'&&op.wantArrived&&op.lastLoadTimestamp||op.type==='ttn'&&op.collect))return;
    const amount=rewardsAt(appConfig,Number(op.createdAt)||Date.now())[op.type];if(!amount)return;
    const count=Math.min(5,amount);
    if(appConfig?.testReviewFlags?.game_effects===false){coinDing();return;}
    const card=[...document.querySelectorAll('.truck-card[data-truck-id]')].find(c=>c.dataset.truckId===op.truckId),button=card?.querySelector(op.type==='load'?'.btn-quick':op.type==='ttn'?'.btn-ttn':'.btn-arrive');
    const icon=button?.querySelector('.game-button-coin'),r=(icon||button)?.getBoundingClientRect(),target=wallet.getBoundingClientRect();
    if(!target.width||!target.height){coinDing();return;}holdCoinToast();
    if(!r||matchMedia('(prefers-reduced-motion: reduce)').matches){walletImpact();resumeCoinToast();return;}
    let remaining=count;if(icon)icon.style.visibility='hidden';
    for(let i=0;i<count;i++){
      const coin=document.createElement('span');coin.className='game-flying-coin';coin.textContent='🪙';coin.setAttribute('aria-hidden','true');
      const sx=r.left+r.width/2+(i-(count-1)/2)*12,sy=r.top+r.height/2;coin.style.left=(sx-15)+'px';coin.style.top=(sy-15)+'px';document.body.append(coin);
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
      rewardDirty=false;rewardMessage='';unsubscribe?.();unsubscribe=null;unsubscribeAdjustments?.();unsubscribeAdjustments=null;adjustmentListenerKey='';coinAdjustmentRows=[];grantTargets=[];grantTargetsLoaded=false;grantTarget='';grantAmount='';grantReason='';grantOperationId='';owner=identity;ledgerUser='all';ledgerOpen=false;records=[];board=[];ready=false;error='';rankingObject='';rankingScope='shift';closePenaltyNotice();
    }
    if(isNasRuntime()){
      if(identity&&nasGameReady&&nasGameSnapshot){records=nasGameSnapshot.records;coinAdjustmentRows=nasGameSnapshot.adjustments;ready=true;error='';rankSnapshotConfirmed=true;notifyPenalties(records);}
      else{ready=false;rankSnapshotConfirmed=false;error=identity?'Дождитесь связи с игровым кошельком Synology.':'';}
      paint();observeRankProgress();return;
    }
    if(identity&&!unsubscribe){
      const session=owner;
      unsubscribe=refs.audit.where('eventType','in',['history','game_penalty','game_purchase','game_arcade']).onSnapshot({includeMetadataChanges:true},s=>{if(owner!==session)return;records=s.docs.filter(d=>!d.metadata.hasPendingWrites).map(d=>({id:d.id,...d.data()}));ready=true;error='';rankSnapshotConfirmed=!s.metadata.fromCache&&!s.metadata.hasPendingWrites;notifyPenalties(records);paint();observeRankProgress();},e=>{if(owner!==session)return;rankSnapshotConfirmed=false;cancelRankCelebration();error='Не удалось загрузить рейтинг. Проверьте подключение и доступ к истории.';ready=false;paint();console.warn('[game coins]',e);});
    }
    const adjustmentKey=identity+'|'+(canAdmin()?'admin':'own');
    if(adjustmentListenerKey!==adjustmentKey){unsubscribeAdjustments?.();unsubscribeAdjustments=null;adjustmentListenerKey=adjustmentKey;coinAdjustmentRows=[];}
    if(identity&&!unsubscribeAdjustments){
      const session=owner;
      const query=canAdmin()?refs.coinTransactions:refs.coinTransactions.where('targetUid','==',identity);
      unsubscribeAdjustments=query.onSnapshot({includeMetadataChanges:true},s=>{if(owner!==session)return;coinAdjustmentRows=s.docs.filter(d=>!d.metadata.hasPendingWrites).map(d=>({id:d.id,...d.data()}));paint();},e=>{if(owner!==session)return;console.warn('[coin ledger]',e);grantMessage='Не удалось загрузить движения монет.';paint();});
    }
    paint();
  }
  window.__gameConfigChanged=()=>{configReady=true;sync();observeRankProgress();};
  window.__gameAccessChanged=sync;
  let economyRows=null,economyEmail='',economyEarned=0;
  window.__gameEconomy={snapshot:()=>{if(economyRows!==records||economyEmail!==currentEmail){economyRows=records;economyEmail=currentEmail;economyEarned=calculate(records).find(r=>r.user===key(currentEmail))?.coins||0;}return {enabled:enabled(),ready:ready&&rankSnapshotConfirmed,records,adjustments:coinAdjustmentRows,earned:economyEarned};}};
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
    if(isNasRuntime())return;
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
