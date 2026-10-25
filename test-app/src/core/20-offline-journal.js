  // TEST ONLY. Persistent, optimistic offline actions; server remains authoritative.
  const offlineJournalKey=()=> 'samosval_offline_v1_'+firebaseConfig.projectId+'_'+WORKSPACE_ID+'_'+currentUid;
  // One editing tab owns this account's synchronous localStorage journal.
  // Web Locks provides actual mutual exclusion; a storage-event lease does not.
  let offlineJournalOwner=null,offlineJournalSuspended=false;
  function offlineReleaseJournalOwnership(){
    const owner=offlineJournalOwner;
    offlineJournalOwner=null;
    if(owner){owner.ready=false;owner.resolveReady(false);owner.abort?.abort();owner.release?.();}
  }
  function offlineEnsureJournalOwnership(){
    if(offlineJournalSuspended)return Promise.resolve(false);
    if(!currentUid){offlineReleaseJournalOwnership();return Promise.resolve(false);}
    if(offlineJournalOwner?.uid===currentUid)return offlineJournalOwner.promise;
    offlineReleaseJournalOwnership();
    const owner={uid:currentUid,ready:false,release:null,abort:null,error:''};
    owner.promise=new Promise(resolve=>{owner.resolveReady=resolve;});
    offlineJournalOwner=owner;
    if(!navigator.locks?.request||typeof AbortController==='undefined'){
      owner.error='Этот браузер не поддерживает безопасную запись офлайн-очереди. Откройте приложение в актуальном Chrome, Safari или Firefox через HTTPS. Сейчас доступен просмотр.';
      owner.resolveReady(false);return owner.promise;
    }
    owner.abort=new AbortController();
    navigator.locks.request(offlineJournalKey()+':writer',{mode:'exclusive',signal:owner.abort.signal},async()=>{
      if(offlineJournalOwner!==owner||currentUid!==owner.uid){owner.resolveReady(false);return;}
      owner.ready=true;
      const released=new Promise(resolve=>{owner.release=resolve;});
      owner.resolveReady(true);
      // The previous tab may have added actions while this tab was waiting.
      offlineProjectState();refreshLineViews();updateSyncUI();
      offlineReplayJournal();
      await released;
      owner.ready=false;
    }).catch(error=>{
      owner.resolveReady(false);
      if(offlineJournalOwner===owner&&error?.name!=='AbortError'){
        owner.ready=false;owner.error='Не удалось получить безопасный доступ к очереди. Закройте другие окна приложения и откройте его заново.';updateSyncUI();
      }
    });
    return owner.promise;
  }
  function offlineJournalSessionToken(){return offlineJournalOwner;}
  function offlineJournalOwns(owner){return !!owner&&owner===offlineJournalOwner&&owner.ready&&owner.uid===currentUid;}
  function offlineJournalCanWrite(){offlineEnsureJournalOwnership();return offlineJournalOwns(offlineJournalOwner);}
  function offlineJournalOwnershipStatus(){
    if(!currentUid)return '';
    offlineEnsureJournalOwnership();
    return offlineJournalOwns(offlineJournalOwner)?'':offlineJournalOwner?.error||'Учёт открыт в другой вкладке. Продолжите там или закройте её.';
  }
  if(typeof window.addEventListener==='function'){
    window.addEventListener('pagehide',()=>{offlineJournalSuspended=true;offlineReleaseJournalOwnership();});
    window.addEventListener('pageshow',()=>{offlineJournalSuspended=false;offlineEnsureJournalOwnership();});
    window.addEventListener('storage',event=>{
      if(event.key===offlineJournalKey()&&!offlineJournalCanWrite()){offlineProjectState();refreshLineViews();updateSyncUI();}
    });
  }
  let offlineReplayRunning=false,offlineRemoteStatuses={},offlineRemoteLogs=[];
  function offlineJournalRead(){
    if(!currentUid)return [];
    try{const a=JSON.parse(localStorage.getItem(offlineJournalKey())||'[]');return Array.isArray(a)?a.filter(x=>x&&x.id&&x.shiftId&&x.truckId):[];}catch(e){console.error(e);return [];}
  }
  function offlineJournalCompact(items){
    // This is a transport journal, not the audit history. Bound fully settled
    // rows only; never discard unsent actions, effects, penalties or conflicts.
    const dependencies=new Set(items.filter(x=>x.status==='pending'&&x.dependencyId).map(x=>x.dependencyId));
    let settled=0;
    return items.slice().reverse().filter(x=>{
      const complete=(x.status==='confirmed'&&x.effectsDelivered)
        ||(x.status==='cancelled'&&x.penaltyDelivered)||(x.status==='rejected'&&x.reviewed);
      return !complete||dependencies.has(x.id)||++settled<=200;
    }).reverse();
  }
  function offlineJournalWrite(items){
    if(!offlineJournalCanWrite())throw new Error(offlineJournalOwnershipStatus());
    localStorage.setItem(offlineJournalKey(),JSON.stringify(offlineJournalCompact(items)));updateSyncUI();
  }
  function offlinePendingOps(){return offlineJournalRead().filter(x=>x.status==='pending');}
  function offlinePendingForTruck(id){return offlinePendingOps().some(x=>x.truckId===id&&state.shift&&x.shiftId===state.shift.id);}
  function offlinePendingCount(){return offlinePendingOps().length;}
  function offlineUndeliveredEffects(){return offlineJournalRead().filter(x=>x.status==='confirmed'&&!x.effectsDelivered);}
  // navigator.onLine is only a browser hint. Firestore may be unreachable even
  // while it remains true (Wi-Fi without internet, DNS failure, captive portal).
  let offlineServerRetryAt=0,offlineServerRetryDelay=0,offlineServerUnreachable=false;
  function offlineTransportError(e){
    const code=String(e?.code||'').toLowerCase(),message=String(e?.message||'').toLowerCase();
    return ['unavailable','deadline-exceeded','network-request-failed','resource-exhausted'].includes(code)
      || /connection failed|failed to fetch|network error|network request failed/.test(message);
  }
  function offlineTransportFailed(error){
    offlineServerUnreachable=true;
    offlineServerRetryDelay=Math.min(60000,offlineServerRetryDelay?offlineServerRetryDelay*2:4000);
    offlineServerRetryAt=Date.now()+offlineServerRetryDelay;
    console.warn('[offline] Сервер недоступен, локальная очередь сохранена:',error?.code||error?.message||error);
    updateSyncUI();
  }
  function offlineTransportRecovered(){
    if(!offlineServerUnreachable&&!offlineServerRetryAt)return;
    offlineServerUnreachable=false;offlineServerRetryAt=0;offlineServerRetryDelay=0;
    updateSyncUI();
  }
  function offlineUnreviewedFailures(){return offlineJournalRead().filter(x=>x.status==='rejected'&&!x.reviewed);}
  function offlineReasonLabel(reason,details){
    if(appConfig.testReviewFlags?.conflict_author!==false&&details)return details;
    const reasons={
      'arrival-changed':'Прибытие уже изменено другим оператором',
      'duplicate-or-arrival-changed':'Погрузка уже учтена или прибытие изменилось. Лишний рейс не добавлен',
      'previous-action-rejected':'Предыдущее действие не подтверждено сервером',
      'cycle-time':'Не истекло установленное время ходки',
      'ttn-changed':'Статус ТТН изменён другим оператором',
      'duplicate':'Повторный рейс не добавлен',
      'already-exists':'Рейс с таким номером уже существует',
      'shift-changed':'Смена завершена или изменена',
      'not-on-line':'Самосвал снят с линии'
    };
    return reasons[reason]||('Ошибка: '+String(reason||'неизвестная'));
  }
  // Explain only the authoritative transaction result. No extra network read,
  // and no attribution to the current user or to a newer, unrelated load.
  function offlineConflictDetails(op,result){
    const s=result.status||{},record=result.winningLog;
    let action='',actor='',at=0;
    if(result.reason==='duplicate'&&record&&record.truckId===op.truckId&&record.shiftId===op.shiftId&&Number(record.arrivalTimestamp||0)===Number(op.arrivalTimestamp||0)){
      action='Погрузка';actor=record.createdBy;at=record.timestamp;
    }else if(['arrival-changed','duplicate-or-arrival-changed'].includes(result.reason)){
      if(s.arriveStatus&&Number(s.arriveTimestamp||0)!==Number(op.arrivalTimestamp||0)){
        action='Приехал';actor=s.arriveBy;at=s.arriveTimestamp;
      }else if(s.loadedAfterArrive&&Number(s.lastLoadTimestamp||0)!==Number(op.lastLoadTimestamp||0)){
        action='Погрузка';actor=s.lastLoadBy;at=s.lastLoadTimestamp;
      }
    }else if(result.reason==='ttn-changed'&&s.ttnStatus){
      action='Забрал ТТН';actor=s.ttnBy;
    }
    if(!['duplicate','arrival-changed','duplicate-or-arrival-changed','ttn-changed'].includes(result.reason))return '';
    const truck=String(op.truckName||'Самосвал'),name=typeof actor==='string'?actor.trim():'';
    if(!action)return truck+': '+offlineReasonLabel(result.reason)+'. Автор изменения не сохранён.';
    const date=new Date(Number(at)),time=Number(at)>0&&Number.isFinite(date.getTime())?' · '+date.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'';
    return truck+': «'+action+'» уже отмечено. '+(name?'Пользователь: '+name+time:'Автор отметки не сохранён')+'.'+(op.type==='load'?' Повторный рейс не добавлен.':'');
  }
  function offlineLocalTicker(){
    if(!state.shift)return null;
    const op=offlinePendingOps().filter(x=>x.shiftId===state.shift.id).slice(-1)[0];if(!op)return null;
    const label=op.type==='reset'?'🔄 Сброс таймера':op.type==='load'?'⚡ Погрузка':op.type==='ttn'?(op.collect?'📄 Забрал ТТН':'↩️ Снял ТТН'):(op.wantArrived===false?'↩️ Снял прибытие':'🚛 Приехал');
    return {id:op.id,type:'offline',offlinePending:true,createdByEmail:op.email,timestamp:op.createdAt,
      html:label+' · '+truckLabelHtml(op.truckId)+' <span style="color:#f59e0b;font-size:10px">☁️ ОФЛАЙН</span>'};
  }
  function offlineProjectTicker(){
    // ticker-v9 reads state.notifications: present a temporary local entry.
    state.notifications=(state.notifications||[]).filter(x=>!x.offlinePending);
    const local=offlineLocalTicker();
    if(local)state.notifications.unshift({...local,userName:getUserName(),createdBy:getUserName()});
  }
  function offlineProjection(before,op){
    if(!before||!before.onLine||before.shiftId!==op.shiftId)return {status:before};
    const st={...before},t=Number(op.createdAt);
    if(op.type==='reset'){Object.assign(st,{lastLoadTimestamp:null,lastLoadBy:null,arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false,cycleRevision:Number(st.cycleRevision||0)+1});
    }else if(op.type==='arrive'){
      if(op.wantArrived!==false){
        const ts=Math.max(t,Number(st.lastLoadTimestamp||0)+1);
        st.arriveStatus=new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
        st.arriveTimestamp=ts;st.arriveBy=op.actor;st.loadedAfterArrive=false;
      }else{st.arriveStatus=null;st.arriveTimestamp=null;st.arriveBy=null;st.loadedAfterArrive=false;}
      st.cycleRevision=Number(st.cycleRevision||0)+1;
    }else if(op.type==='load'){
      const timestamp=Math.max(t,Number(st.arriveTimestamp||0)+1,Number(st.lastLoadTimestamp||0)+1);
      const logId=op.logId||('load_'+op.truckId+'_'+op.shiftId+'_cycle_'+op.expectedRevision+'_'+op.arrivalTimestamp);
      const log={id:'pending_'+op.id,offlinePending:true,shiftId:op.shiftId,truckId:op.truckId,
        truckName:op.truckName||truckName(op.truckId),volume:op.volume||0,isGAI:!!op.isGAI,
        timeStr:new Date(timestamp).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),
        timestamp,arrivalTimestamp:Number(st.arriveTimestamp)||null,createdBy:op.actor,createdByEmail:op.email,comment:''};
      st.lastLoadTimestamp=timestamp;st.lastLoadBy=op.actor;st.lastLoadLogId=logId;
      st.cycleRevision=Number(st.cycleRevision||0)+1;st.arriveStatus=null;st.arriveTimestamp=null;st.arriveBy=null;st.loadedAfterArrive=true;
      if(st.ttnStatus==='pending'){st.ttnStatus=true;st.ttnLogId=logId;}
      return {status:st,log};
    }else if(op.type==='ttn'){
      st.ttnStatus=op.collect?(st.loadedAfterArrive&&st.lastLoadLogId?true:'pending'):null;
      st.ttnBy=op.collect?op.actor:null;st.ttnLogId=op.collect&&st.loadedAfterArrive?st.lastLoadLogId:null;
      st.ttnRevision=Number(st.ttnRevision||0)+1;
    }
    return {status:st};
  }
  // Start from the remote snapshot every time: never apply the same pending load twice.
  function offlineProjectState(){
    const statuses={...offlineRemoteStatuses},logs=offlineRemoteLogs.slice();
    for(const op of offlinePendingOps()){
      if(!state.shift||op.shiftId!==state.shift.id||!statuses[op.truckId])continue;
      if(op.type==='reset'&&statuses[op.truckId].lastResetOperationId===op.id)continue;
      if(op.type==='load'&&(statuses[op.truckId].lastLoadLogId===op.logId||logs.some(l=>l.id===op.logId)))continue;
      if(op.type==='arrive'&&op.wantArrived!==false&&Number(statuses[op.truckId].arriveTimestamp||0)===Math.max(Number(op.createdAt),Number(op.lastLoadTimestamp||0)+1)&&statuses[op.truckId].arriveBy===op.actor)continue;
      const p=offlineProjection(statuses[op.truckId],op);statuses[op.truckId]=p.status;
      if(p.log&&!logs.some(l=>l.id===op.logId))logs.push(p.log);
    }
    state.truckStatus=statuses;state.logs=logs.sort((x,y)=>(y.timestamp||0)-(x.timestamp||0));offlineProjectTicker();
  }
  function offlineActionAllowed(type){
    if(currentUserStatus!=='active'||!permissionsLoaded)return false;
    if(type==='reset')return canAdmin();
    const action={arrive:'action_arrive',load:'action_load',ttn:'action_ttn'}[type];
    return !!action&&hasPermission(action);
  }
  function offlineQueueAction(type,id,intent){
    if(!offlineJournalCanWrite()){showError(offlineJournalOwnershipStatus());return false;}
    if(!currentUid||!intent||!intent.status||!state.shift||state.shift.id!==intent.shiftId)return false;
    if(!offlineActionAllowed(type)){showError('Нет доступа к этому действию');return false;}
    if(!editableLineShift(state.shift)||intent.status.shiftId!==intent.shiftId||!intent.status.onLine){showError('Смена закрывается, восстанавливается или самосвал снят с линии');return false;}
    const before=intent.status,now=Date.now(),gap=Math.max(MIN_CYCLE_MINUTES,settings.cycleMinutes||MIN_CYCLE_MINUTES)*60000;
    if(type==='load'&&!before.arriveStatus){showError('Сначала отметьте прибытие');return false;}
    if((type==='load'||(type==='arrive'&&!before.arriveStatus))&&before.lastLoadTimestamp&&now-before.lastLoadTimestamp<gap){
      showError('Ещё не истекло время ходки');return false;
    }
    const truck=findTruck(id);if(!truck){showError('Самосвал не найден');return false;}
    try{
      const items=offlineJournalRead(),previous=items.filter(x=>x.truckId===id&&x.shiftId===intent.shiftId&&x.status==='pending').slice(-1)[0];
      const op={id:'op_'+now+'_'+Math.random().toString(36).slice(2),type,truckId:id,shiftId:intent.shiftId,objectId:state.shift?.objectId||'',objectName:state.shift?.objectName||'',
        beforeStatus:{...before},createdAt:now,actor:getUserName(),email:currentEmail,expectedRevision:Number(before.cycleRevision||0),
        expectedTtnRevision:Number(before.ttnRevision||0),arrivalTimestamp:Number(before.arriveTimestamp||0),
        lastLoadTimestamp:Number(before.lastLoadTimestamp||0),wantArrived:!before.arriveStatus,collect:!before.ttnStatus,
        dependencyId:previous?.id||null,cycleMinutes:Math.max(MIN_CYCLE_MINUTES,settings.cycleMinutes||MIN_CYCLE_MINUTES),
        truckName:truck.brand+' '+truck.number,volume:truck.isGAI?0:truck.defaultVol,isGAI:!!truck.isGAI,status:'pending'};
      if(type==='load')op.logId='load_'+id+'_'+op.shiftId+'_cycle_'+op.expectedRevision+'_'+op.arrivalTimestamp;
      items.push(op);offlineJournalWrite(items); // Commit locally first; never silently lose an action.
      try{window.__gameCoinQueued?.(op);}catch(e){console.warn('[game animation]',e);}
      const old=state.truckStatus[id];offlineProjectState();signalLineTransition(id,old,state.truckStatus[id]);refreshLineViews();
      const label=type==='reset'?'🔄 Сброс таймера':type==='load'?'⚡ Погрузка':type==='ttn'?(op.collect?'📄 Забрал ТТН':'↩️ Снял ТТН'):(op.wantArrived?'🚛 Приехал':'↩️ Снял прибытие');
      showToastEl(label+' · '+truckLabelHtml(id),false);
      if(navigator.onLine)offlineReplayJournal();
      return true;
    }catch(e){showError('Действие не сохранено на устройстве: '+(e.message||e));return false;}
  }
  function offlineResolve(id,status,reason){
    const all=offlineJournalRead(),op=all.find(x=>x.id===id);
    if(op&&op.status==='pending'){op.status=status;op.result=reason;op.resolvedAt=Date.now();offlineJournalWrite(all);}
  }
  function offlineAdoptResult(op,result){
    if(!state.shift||state.shift.id!==op.shiftId)return;
    if(result.status&&result.status.shiftId===op.shiftId){
      const old=offlineRemoteStatuses[op.truckId];
      // Arrival/load and TTN have independent revisions. A delayed transaction
      // reply must preserve a newer TTN snapshot even when its cycle is equal.
      offlineRemoteStatuses[op.truckId]={id:op.truckId,...mergeCachedTruckStatus(result.status,old)};
    }
    if(result.log&&!offlineRemoteLogs.some(l=>l.id===result.log.id)){
      offlineRemoteLogs.push(result.log);confirmedLoadIds.add(result.log.id);
    }
    // The caller projects/renders once, after durably resolving the journal row.
  }
  function undoLastOfflineAction(){
    if(!offlineJournalCanWrite()){showError(offlineJournalOwnershipStatus());return;}
    if(!hasPermission('undo_action')&&!hasPermission('undo_any')){showError('Нет права отменять действия');return;}
    if(offlineReplayRunning){showToastEl('Действие отправляется на сервер',false);return;}
    const all=offlineJournalRead();let i=-1;
    for(let n=all.length-1;n>=0;n--)if(all[n].status==='pending'&&state.shift&&all[n].shiftId===state.shift.id){i=n;break;}
    if(i<0)return;all[i].status='cancelled';all[i].cancelledAt=Date.now();offlineJournalWrite(all);offlineProjectState();refreshLineViews();showToastEl('↩️ Ошибочное действие отменено. Штраф −3 🪙 будет учтён после связи с сервером.',true);window.__gameFlushPenalties?.();
  }
  function offlineEffectRequest(request){
    let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject({code:'deadline-exceeded',message:'Истекло время отправки журнала'}),6000);});
    return Promise.race([request,timeout]).finally(()=>clearTimeout(timer));
  }
  let offlineEffectsTask=null,offlineEffectsRetryAt=0;
  function offlineReplayEffects(){
    if(offlineEffectsTask)return offlineEffectsTask;
    if(!navigator.onLine||!currentUid||!permissionsLoaded||currentUserStatus!=='active'||Date.now()<offlineEffectsRetryAt||!offlineJournalCanWrite())return Promise.resolve();
    const uid=currentUid,owner=offlineJournalSessionToken();
    const task=(async()=>{
      const attempted=new Set();
      // New transactions may finish while an earlier effect is in flight.
      // Drain those too instead of delaying them until the next 8-second tick.
      for(let op;(op=offlineUndeliveredEffects().find(x=>!attempted.has(x.id)));){
        attempted.add(op.id);
        if(currentUid!==uid||currentUserStatus!=='active'||!navigator.onLine||!offlineJournalOwns(owner))break;
        if(!await offlineNotifyAccepted(op,op.savedResult||{},uid,owner)){
          if(currentUid===uid)offlineEffectsRetryAt=Date.now()+8000;
        }
      }
    })().catch(error=>{
      if(currentUid===uid)offlineEffectsRetryAt=Date.now()+8000;
      console.warn('[offline effects]',error);
    }).finally(()=>{if(offlineEffectsTask===task)offlineEffectsTask=null;updateSyncUI();});
    offlineEffectsTask=task;
    return task;
  }
  async function offlineNotifyAccepted(op,result,uid=currentUid,owner=offlineJournalSessionToken()){
    const sameSession=()=>currentUid===uid&&currentUserStatus==='active'&&permissionsLoaded&&offlineJournalOwns(owner);
    if(!sameSession())return false;
    let delivered=true;
    try{
      const ref=refs.notifications.doc('offline_'+op.id),snap=await offlineEffectRequest(ref.get({source:'server'}));
      if(!sameSession())return false;
      if(!snap.exists){
        const label=op.type==='reset'?'🔄 Сброс таймера':op.type==='load'?'⚡ Погрузка':op.type==='ttn'?(op.collect?'📄 Забрал ТТН':'↩️ Снял ТТН'):(op.wantArrived?'🚛 Приехал':'↩️ Снял прибытие');
        await offlineEffectRequest(ref.set({...offlineUndoFields(op,result.beforeStatus||op.beforeStatus),gamePenaltyKey:window.__gamePenaltyKey(op.type,op.truckId,result.status||{},result.log?.id,op.id),type:op.type,truckId:op.truckId,logId:result.log?.id||null,
          createdBy:op.actor,createdByEmail:op.email||'',timestamp:op.createdAt,shiftId:op.shiftId,objectId:op.objectId||'',objectName:op.objectName||'',
          html:label+' · '+truckLabelHtml(op.truckId)}));
      }
    }catch(e){delivered=false;console.warn('Не удалось отправить уведомление офлайн-действия',e);}
    if(!sameSession())return false;
    try{
      const ref=refs.audit.doc('offline_'+op.id),snap=await offlineEffectRequest(ref.get({source:'server'}));
      if(!sameSession())return false;
      if(!snap.exists){
        const names={reset:'🔄 Сброс таймера',arrive:op.wantArrived?'🚛 Прибытие на линию':'↩️ Снято прибытие на линию',
          load:'⚡ Погрузка самосвала',ttn:op.collect?'📄 Забрана ТТН':'↩️ Снята отметка ТТН'};
        await offlineEffectRequest(ref.set({text:(names[op.type]||op.type)+': '+op.truckName,
          timeStr:new Date(op.createdAt).toLocaleString('ru-RU'),
          objectName:op.objectName||'—',objectId:op.objectId||'',
          shiftId:op.shiftId,truckId:op.truckId,truckName:op.truckName,
          userEmail:op.email||'',userName:op.actor,createdByEmail:op.email||'',
          timestamp:op.createdAt,eventType:op.type,offlineOperationId:op.id}));
      }
    }catch(e){delivered=false;console.warn('Не удалось отправить аудит офлайн-действия',e);}
    if(delivered&&sameSession()){const all=offlineJournalRead(),saved=all.find(x=>x.id===op.id);if(saved){saved.effectsDelivered=true;offlineJournalWrite(all);}}
    return delivered&&sameSession();
  }
  function offlineUndoFields(op,b){
    if(!b)return {};
    if(op.type==='load')return previousLoadSnapshot(b);
    if(op.type==='arrive')return {wasArrived:!!b.arriveStatus,prevTime:b.arriveStatus||null,prevTs:b.arriveTimestamp||null,prevArriveBy:b.arriveBy||null};
    return {prevTtn:b.ttnStatus??null,prevTtnBy:b.ttnBy||null,prevTtnLogId:b.ttnLogId||null};
  }
  async function offlineReplayJournal(){
    // Delivery is durable but independent: a stalled notification must never
    // delay the next truck transaction or hold the line's in-flight guard.
    offlineReplayEffects();
    if(offlineReplayRunning||!navigator.onLine||!currentUid||!permissionsLoaded||currentUserStatus!=='active'||Date.now()<offlineServerRetryAt||syncState.pendingWrites.status||syncState.pendingWrites.shift||!offlineJournalCanWrite())return;
    const replayUid=currentUid,owner=offlineJournalSessionToken();
    offlineReplayRunning=true;
    try{
      for(const op of offlinePendingOps()){
        if(!navigator.onLine||currentUserStatus!=='active'||currentUid!==replayUid||!offlineJournalOwns(owner))break;
        if(!offlineJournalRead().some(x=>x.id===op.id&&x.status==='pending'))continue;
        if(op.dependencyId){
          const previous=offlineJournalRead().find(x=>x.id===op.dependencyId);
          if(previous?.status==='pending')break;
          if(previous?.status==='rejected'){
            offlineResolve(op.id,'rejected','previous-action-rejected');offlineProjectState();refreshLineViews();continue;
          }
        }
        try{
          const result=await db.runTransaction(async tx=>{
            const checkAccess=()=>{
              if(currentUid!==replayUid||!offlineJournalOwns(owner))throw {code:'cancelled',message:'Учётная запись или вкладка изменилась'};
              if(!offlineActionAllowed(op.type))throw {code:'permission-denied',message:'Доступ к действию ограничен'};
            };
            checkAccess();
            const policy=await tx.get(appConfigRef);
            const sharedCycle=policy.exists?Number(policy.data().cycleMinutes)||15:15;
            const before=await readLineState(tx,op.truckId,op.shiftId);
            checkAccess();
            const truck=findTruck(op.truckId);if(!truck)throw {code:'truck-missing',message:'Самосвал не найден'};
            const revision=Number(before.cycleRevision||0),gap=Math.max(MIN_CYCLE_MINUTES,sharedCycle,op.cycleMinutes||MIN_CYCLE_MINUTES)*60000;
            if(op.type==='reset'){
              if(!canAdmin())throw {code:'permission-denied',message:'Сброс доступен администратору'};
              if(before.lastResetOperationId===op.id)return {outcome:'confirmed',status:before};
              if(revision!==op.expectedRevision||Number(before.lastLoadTimestamp||0)!==Number(op.lastLoadTimestamp||0))return {outcome:'rejected',reason:'arrival-changed',status:before};
              const update={lastLoadTimestamp:null,lastLoadBy:null,arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false,cycleRevision:revision+1,lastResetOperationId:op.id};
              tx.update(refs.truckStatus.doc(op.truckId),update);
              return {outcome:'confirmed',status:{...before,...update},beforeStatus:before,didCommit:true};
            }
            if(op.type==='arrive'){
              const want=op.wantArrived!==false;
              if(want&&before.arriveStatus&&Number(before.arriveTimestamp||0)===Math.max(Number(op.createdAt),Number(op.lastLoadTimestamp||0)+1)&&before.arriveBy===op.actor)
                return {outcome:'confirmed',status:before};
              if(!want&&revision===Number(op.expectedRevision||0)+1&&!before.arriveStatus&&!before.arriveTimestamp&&before.loadedAfterArrive===false&&Number(before.lastLoadTimestamp||0)===Number(op.lastLoadTimestamp||0))return {outcome:'confirmed',status:before};
              if(revision!==Number(op.expectedRevision||0)||Number(before.arriveTimestamp||0)!==Number(op.arrivalTimestamp||0)||!!before.arriveStatus===want)
                return {outcome:'rejected',reason:'arrival-changed',status:before};
              if(want&&before.lastLoadTimestamp&&op.createdAt-before.lastLoadTimestamp<gap)
                return {outcome:'rejected',reason:'cycle-time',status:before};
              const ts=Math.max(Number(op.createdAt),Number(before.lastLoadTimestamp||0)+1);
              const update=want?{arriveStatus:new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),arriveTimestamp:ts,arriveBy:op.actor,loadedAfterArrive:false,cycleRevision:revision+1}:
                {arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false,cycleRevision:revision+1};
              tx.update(refs.truckStatus.doc(op.truckId),update);
              return {outcome:'confirmed',status:{...before,...update},beforeStatus:before,didCommit:true};
            }
            if(op.type==='load'){
              const logId=op.logId||('load_'+op.truckId+'_'+op.shiftId+'_cycle_'+op.expectedRevision+'_'+op.arrivalTimestamp);
              // The deterministic log ID is an idempotency key. Check it
              // *before* rejecting a changed status: the first commit may
              // have succeeded while its acknowledgement was lost.
              const ref=refs.logs.doc(logId),existing=await tx.get(ref);
              checkAccess();
              if(existing.exists){
                const record=existing.data();
                if(record.clientOperationId===op.id)return {outcome:'confirmed',status:before,log:{id:logId,...record}};
                return {outcome:'rejected',reason:'duplicate',status:before,winningLog:{id:logId,...record}};
              }
              if(!before.arriveStatus||revision!==Number(op.expectedRevision||0)||Number(before.arriveTimestamp||0)!==Number(op.arrivalTimestamp||0))
                return {outcome:'rejected',reason:'duplicate-or-arrival-changed',status:before};
              if(before.lastLoadTimestamp&&op.createdAt-before.lastLoadTimestamp<gap)
                return {outcome:'rejected',reason:'cycle-time',status:before};
              const ts=Math.max(Number(op.createdAt),Number(before.arriveTimestamp||0)+1,Number(before.lastLoadTimestamp||0)+1);
              const log={shiftId:op.shiftId,truckId:op.truckId,truckName:truck.brand+' '+truck.number,
                volume:truck.isGAI?0:truck.defaultVol,timeStr:new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),
                timestamp:ts,arrivalTimestamp:Number(before.arriveTimestamp)||null,createdBy:op.actor,createdByEmail:op.email||'',
                isGAI:!!truck.isGAI,comment:'',clientOperationId:op.id};
              const update={lastLoadTimestamp:ts,lastLoadBy:op.actor,lastLoadLogId:logId,cycleRevision:revision+1,
                arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:true};
              if(before.ttnStatus==='pending'){update.ttnStatus=true;update.ttnLogId=logId;}
              tx.set(ref,log);tx.update(refs.truckStatus.doc(op.truckId),update);
              return {outcome:'confirmed',status:{...before,...update},log:{id:logId,...log},beforeStatus:before,didCommit:true};
            }
            if(op.type==='ttn'){
              if(Number(before.ttnRevision||0)===Number(op.expectedTtnRevision||0)+1&&before.ttnBy=== (op.collect?op.actor:null)&&
                 (!!before.ttnStatus===!!op.collect))return {outcome:'confirmed',status:before};
              if(Number(before.ttnRevision||0)!==Number(op.expectedTtnRevision||0)||!!before.ttnStatus===!!op.collect)
                return {outcome:'rejected',reason:'ttn-changed',status:before};
              const logId=before.lastLoadLogId||null;
              const update=op.collect?{ttnStatus:before.loadedAfterArrive&&logId?true:'pending',ttnBy:op.actor,
                ttnLogId:before.loadedAfterArrive?logId:null,ttnRevision:Number(before.ttnRevision||0)+1}:
                {ttnStatus:null,ttnBy:null,ttnLogId:null,ttnRevision:Number(before.ttnRevision||0)+1};
              tx.update(refs.truckStatus.doc(op.truckId),update);
              return {outcome:'confirmed',status:{...before,...update},beforeStatus:before,didCommit:true};
            }
            return {outcome:'rejected',reason:'unsupported'};
          });
          if(currentUid!==replayUid||!offlineJournalOwns(owner))break;
          offlineTransportRecovered();offlineAdoptResult(op,result);
          {const all=offlineJournalRead(),saved=all.find(x=>x.id===op.id);if(saved){saved.savedResult={status:result.status||null,beforeStatus:result.beforeStatus||op.beforeStatus,log:result.log||null};if(result.outcome==='rejected')saved.conflictDetails=offlineConflictDetails(op,result);offlineJournalWrite(all);}}
          offlineResolve(op.id,result.outcome,result.reason||result.outcome);
          offlineProjectState();refreshLineViews();
          if(result.outcome==='confirmed'){
            if(result.didCommit){
              try{/* History is saved with the durable audit entry. */}catch(e){console.warn('[offline history]',e);}
              if(appConfig.maxEnabled){
                const actor=op.actor,name=op.truckName||truckName(op.truckId);
                if(op.type==='load'&&appConfig.notifyLoad)enqueueMax('⚡ Погрузка\n🚛 '+name+'\n👤 '+actor,{truckId:op.truckId,logId:result.log?.id||'',reis:getLogs().filter(l=>l.truckId===op.truckId).length});
                if(op.type==='arrive'&&op.wantArrived&&appConfig.notifyArrive)enqueueMax('🚛 Приехал на объект\n🚛 '+name+'\n👤 '+actor);
                if(op.type==='ttn'&&op.collect&&appConfig.notifyTtn)enqueueMax('📄 Забрал ТТН\n🚛 '+name+'\n👤 '+actor);
              }
            }
            offlineReplayEffects();
          }else showToastEl('⚠️ '+escapeHtml(offlineReasonLabel(result.reason,offlineConflictDetails(op,result))),true);
        }catch(e){
          if(currentUid!==replayUid||!offlineJournalOwns(owner))break;
          if(offlineTransportError(e)){offlineTransportFailed(e);break;}
          if(!navigator.onLine||['aborted','cancelled'].includes(e.code)){offlineServerRetryAt=Date.now()+1500;break;}
          offlineResolve(op.id,'rejected',e.code||e.message||'error');offlineProjectState();refreshLineViews();
          showToastEl('⚠️ Офлайн-действие отклонено: '+escapeHtml(e.message||e.code||'ошибка'),true);
        }
      }
    }finally{offlineReplayRunning=false;updateSyncUI();}
  }
  // Offline-first operations. The UI moves immediately; the journal replays
  // through server transactions even when navigator.onLine incorrectly says true.
  async function performLoad(id,capturedIntent){
    if(!requireEdit('action_load')||loadInFlight[id]||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=capturedIntent||captureLineIntent(id);
    if(!intent)return {outcome:'ignored'};
    return {outcome:offlineQueueAction('load',id,intent)?'queued':'failed'};
  }
  async function toggleArrive(id,capturedIntent){
    if(!requireEdit('action_arrive')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=capturedIntent||captureLineIntent(id);
    if(!intent)return {outcome:'ignored'};
    return {outcome:offlineQueueAction('arrive',id,intent)?'queued':'failed'};
  }
  async function toggleTtn(id,capturedIntent){
    if(!requireEdit('action_ttn')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=capturedIntent||captureLineIntent(id);
    if(!intent)return {outcome:'ignored'};
    return {outcome:offlineQueueAction('ttn',id,intent)?'queued':'failed'};
  }

