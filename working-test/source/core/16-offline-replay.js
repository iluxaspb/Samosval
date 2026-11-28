  // Показывать «Работа локально» только если перебой длится дольше 3 секунд.
  // После смены сети (VPN, Wi-Fi <-> мобильная) связь обычно восстанавливается
  // сама, и мигающая надпись только пугает. Флаг недоступности и бэкофф повтора
  // при этом работают сразу — отложен только показ.
  const OFFLINE_UI_GRACE_MS=3000;
  let offlineStatusSince=0;
  function offlineTransportError(e){
    const code=String(e?.code||'').toLowerCase(),message=String(e?.message||'').toLowerCase();
    return ['unavailable','deadline-exceeded','network-request-failed','resource-exhausted'].includes(code)
      || /connection failed|failed to fetch|network error|network request failed/.test(message);
  }
  function offlineTransportFailed(error){
    offlineServerUnreachable=true;
    offlineServerRetryDelay=Math.min(60000,offlineServerRetryDelay?offlineServerRetryDelay*2:4000);
    offlineServerRetryAt=Date.now()+offlineServerRetryDelay;
    offlineStatusSince=Date.now();
    console.warn('[offline] Сервер недоступен, локальная очередь сохранена:',error?.code||error?.message||error);
    updateSyncUI();
  }
  function offlineTransportRecovered(){
    if(!offlineServerUnreachable&&!offlineServerRetryAt)return;
    offlineServerUnreachable=false;offlineServerRetryAt=0;offlineServerRetryDelay=0;
    offlineStatusSince=0;
    updateSyncUI();
  }
  // Очередь офлайн-команд принадлежит конкретной смене (uid/workspace разделены
  // ключом хранения в 15-shifts.js, shiftId — записями внутри него). Карточка
  // смены показывает только её очередь, dead-letter тоже scoped, а общий бейдж
  // вкладки — сумма по всем сменам текущего uid. Ни одна функция ниже не
  // подставляет «текущую» смену в чужую запись: shiftId записи неизменяем.
  const OFFLINE_ONLINE_ONLY_TYPES=['force-transfer','force_transfer','detached-complete','detached-trip-complete','complete-detached-trip'];
  function offlineV2Api(){return typeof WorkingTestOfflineV2!=='undefined'?WorkingTestOfflineV2:null;}
  function offlineIsOnlineOnlyCommand(type){
    const api=offlineV2Api();
    if(api&&typeof api.isOnlineOnlyCommand==='function')return api.isOnlineOnlyCommand(type);
    return OFFLINE_ONLINE_ONLY_TYPES.includes(String(type||''));
  }
  function offlineShiftQueue(shiftId){
    if(!shiftId)return [];
    return offlineJournalRead().filter(x=>x&&x.shiftId===shiftId);
  }
  function offlineShiftPending(shiftId){return offlineShiftQueue(shiftId).filter(x=>x.status==='pending');}
  function offlineShiftDeadLetter(shiftId){return offlineShiftQueue(shiftId).filter(x=>x.status==='rejected'&&x.deadLetter===true);}
  // Ответ сервера на повтор: permanent-отказ уходит в dead-letter этой смены,
  // разрешимый конфликт остаётся пользователю с кодом и безопасными details.
  function offlineReplayVerdict(code,details){
    const api=offlineV2Api();
    if(api&&typeof api.classifyReplayFailure==='function')return api.classifyReplayFailure({code,details,status:details&&details.status});
    return {code:String(code||'replay-failed'),permanent:false,deadLetter:false,conflict:false,details:{}};
  }
  function offlineUnreviewedFailures(shiftId){
    return (shiftId?offlineShiftQueue(shiftId):offlineJournalRead()).filter(x=>x.status==='rejected'&&!x.reviewed);
  }
  // Конверт §9: сохранено ровно то, что отправляется. Конверт собирается один
  // раз — при постановке в очередь — и при повторе не пересобирается из
  // текущего состояния экрана: ни смена, ни аккаунт его не подменяют.
  function offlineEnvelopeScope(op){
    return {uid:(op&&op.uid)||currentUid,workspaceId:(op&&op.workspaceId)||WORKSPACE_ID};
  }
  function offlineEnvelopeOf(op){
    const api=offlineV2Api();
    if(!api||typeof api.buildCommandEnvelope!=='function')return {ok:false,code:'journal-unavailable'};
    const scope=offlineEnvelopeScope(op);
    let envelope=op&&op.commandEnvelope?op.commandEnvelope:null;
    let expectedHash=op&&op.commandHash?op.commandHash:null;
    if(!envelope){
      // Старая запись без конверта (обновление PWA поверх прежней очереди):
      // конверт собирается ровно один раз и сохраняется вместе с хешем, чтобы
      // каждый следующий повтор доказывал тот же самый конверт.
      const built=api.buildCommandEnvelope(op,scope);
      if(!built.ok)return {ok:false,code:'operation-hash-conflict'};
      envelope=built.envelope;expectedHash=built.commandHash;
      const all=offlineJournalRead(),saved=all.find(x=>x.id===op.id);
      if(saved){
        saved.commandEnvelope=envelope;saved.commandHash=expectedHash;
        // Не смогли сохранить (переполнена память) — не теряем действие:
        // конверт соберётся заново в следующий раз из тех же полей записи.
        try{offlineJournalWrite(all);}catch(_){}
      }
    }
    let hash;
    try{hash=api.commandHash(envelope,scope);}catch(_){return {ok:false,code:'operation-hash-conflict'};}
    if(expectedHash&&expectedHash!==hash)return {ok:false,code:'operation-hash-conflict'};
    return {ok:true,envelope,commandHash:hash};
  }
  // Команда на провод собирается из сохранённого конверта: тело и expected
  // revisions берутся оттуда, а служебные поля записи (актёр, beforeStatus,
  // logId) остаются из журнала. Конверт и его хеш на сервер не уходят.
  function offlineCommandWire(op,envelope){
    const wire={...op};
    delete wire.commandEnvelope;delete wire.commandHash;
    Object.assign(wire,envelope.body,{id:envelope.operationId,type:envelope.commandType,shiftId:envelope.shiftId,createdAt:envelope.createdAt});
    const revisions=envelope.expectedRevisions||{};
    if(revisions.cycle!==undefined)wire.expectedRevision=revisions.cycle;
    if(revisions.ttn!==undefined)wire.expectedTtnRevision=revisions.ttn;
    if(revisions.shift!==undefined)wire.expectedShiftRevision=revisions.shift;
    if(revisions.status!==undefined)wire.expectedStatusRevision=revisions.status;
    return wire;
  }
  // Страж повтора: пока хеш сохранённого конверта не сходится с записью,
  // запрос не уходит вообще. Повреждённое или подменённое хранилище — это
  // dead-letter этой смены с кодом operation-hash-conflict, а не «примерно
  // та же» команда.
  function offlineReplayCommand(op){
    const prepared=offlineEnvelopeOf(op);
    if(!prepared.ok){
      offlineResolve(op.id,'rejected',prepared.code,{deadLetter:true});
      offlineProjectState();refreshLineViews();
      showErrorPanel('⚠️ '+escapeHtml(offlineReasonLabel(prepared.code)));
      return null;
    }
    return offlineCommandWire(op,prepared.envelope);
  }
  function offlineReasonLabel(reason){
    const reasons={
      'arrival-changed':'Прибытие уже изменено другим оператором',
      'duplicate-or-arrival-changed':'Погрузка уже учтена или прибытие изменилось. Лишний рейс не добавлен',
      'previous-action-rejected':'Предыдущее действие не подтверждено сервером',
      'cycle-time':'Не истекло установленное время ходки',
      'ttn-changed':'Статус ТТН изменён другим оператором',
      'duplicate':'Повторный рейс не добавлен',
      'already-exists':'Рейс с таким номером уже существует',
      'shift-changed':'Смена завершена или изменена',
      'not-on-line':'Самосвал снят с линии',
      'shift-closed':'Смена уже закрыта — действие не отправлено',
      'not-shift-member':'Вы больше не участник этой смены',
      'protocol-upgrade-required':'Обновите приложение: сервер требует новый протокол',
      'revision-conflict':'Данные уже изменились другим оператором',
      'truck-not-on-shift':'Самосвал переведён в другую смену',
      'online-only-command':'Действие доступно только при связи с сервером',
      'operation-hash-conflict':'Повтор с другими данными отклонён'
    };
    return reasons[reason]||('Ошибка: '+String(reason||'неизвестная'));
  }
  function offlineLocalTicker(){
    if(!state.shift)return null;
    const op=offlineShiftPending(state.shift.id).slice(-1)[0];if(!op)return null;
    const label=op.type==='reset'?'🔄 Сброс таймера':op.type==='load'?'⚡ Погрузка':op.type==='ttn'?(op.collect?'📄 Забрал ТТН':'↩️ Снял ТТН'):op.type==='no-return'?'🚫 Не приехал':(op.wantArrived===false?'↩️ Снял прибытие':'🚛 Приехал');
    return {id:op.id,type:'offline',offlinePending:true,createdByEmail:op.email,timestamp:op.createdAt,
      html:label+' · '+truckLabelHtml(op.truckId)+' <span style="color:#f59e0b;font-size:10px">☁️ ОФЛАЙН</span>'};
  }
  function offlineProjectTicker(){
    // ticker-v9 reads state.notifications: present a temporary local entry.
    state.notifications=(state.notifications||[]).filter(x=>!x.offlinePending);
    const local=offlineLocalTicker();
    // Полоса отбирает записи по shiftId: локальное действие офлайн-очереди
    // принадлежит выбранной смене и обязано попасть именно в её полосу.
    if(local)state.notifications.unshift({...local,shiftId:state.shift.id,userName:getUserName(),createdBy:getUserName()});
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
      st.noReturn=false;st.noReturnAt=null;st.noReturnBy=null;
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
    }else if(op.type==='no-return'){
      st.noReturn=true;st.noReturnAt=t;st.noReturnBy=op.actor;
      st.arriveStatus=null;st.arriveTimestamp=null;st.arriveBy=null;
      st.cycleRevision=Number(st.cycleRevision||0)+1;
    }else if(op.type==='ttn'){
      st.ttnStatus=op.collect?(st.loadedAfterArrive&&st.lastLoadLogId?true:'pending'):null;
      st.ttnBy=op.collect?op.actor:null;st.ttnLogId=op.collect&&st.loadedAfterArrive?st.lastLoadLogId:null;
      st.ttnRevision=Number(st.ttnRevision||0)+1;
    }
    return {status:st};
  }
  // Строки линии принадлежат одной смене. Общая основа `offlineRemoteStatuses`
  // о сменах не знает: подтверждённый повтор действия соседней смены оставлял
  // в ней её самосвал, и следующая перерисовка рисовала чужие карточки под
  // выбранной сменой. Фильтр по shiftId — единственное место, где решается,
  // чья это строка.
  function offlineStatusesForShift(base, shiftId) {
    const source = base && typeof base === 'object' ? base : {};
    const rows = Object.keys(source).map(id => source[id]).filter(row => row && typeof row === 'object');
    // Старый канал (v1) не писал shiftId вовсе: такие строки принадлежат
    // единственной линии и не должны исчезать из-за фильтра.
    const legacy = !rows.some(row => typeof row.shiftId === 'string' && row.shiftId);
    const out = {};
    for (const id of Object.keys(source)) {
      const row = source[id];
      if (!row || typeof row !== 'object') continue;
      const owner = typeof row.shiftId === 'string' ? row.shiftId : '';
      if (!owner) { if (legacy) out[id] = row; continue; }
      if (owner === shiftId) out[id] = row;
    }
    return out;
  }
  // Основа проекции := снимок выбранной смены. Вызывается сразу после
  // публикации v2-снимка и после переключения смены, когда `state` — это ещё
  // ровно серверные данные без локальных ожиданий. Иначе следующая проекция
  // начинала бы с чужой или пустой основы: карточки на миг исчезали («Нет
  // машин») либо показывали самосвалы прежней смены.
  function offlineAdoptShiftProjection() {
    const next = {};
    const statuses = state.truckStatus && typeof state.truckStatus === 'object' ? state.truckStatus : {};
    for (const id of Object.keys(statuses)) {
      const row = statuses[id];
      if (!row || typeof row !== 'object') continue;
      next[id] = { ...row, id };
    }
    offlineRemoteStatuses = next;
    const logs = Array.isArray(state.logs) ? state.logs.slice() : [];
    const known = new Set(logs.map(log => log && log.id).filter(Boolean));
    // Восстановленные архивные смены живут параллельно выбранной: их рейсы
    // нужны правкам из отчёта, иначе проекция затрёт их своим срезом.
    for (const entry of (state.restoredShifts || [])) {
      for (const log of (entry && entry.logs) || []) {
        if (log && log.id && !known.has(log.id)) { known.add(log.id); logs.push(log); }
      }
    }
    offlineRemoteLogs = logs;
    for (const id of known) confirmedLoadIds.add(id);
    return next;
  }
  // Start from the remote snapshot every time: never apply the same pending load twice.
  function offlineProjectState(){
    const shiftId=state.shift?.id||'';
    let base=offlineStatusesForShift(offlineRemoteStatuses,shiftId);
    // Страховка от пустой основы: если снимок ещё не приходил, но проекция уже
    // есть, берём её — иначе первое же действие стирало бы линию целиком.
    if(!Object.keys(base).length){
      const current=offlineStatusesForShift(state.truckStatus,shiftId);
      if(Object.keys(current).length){base=current;offlineRemoteStatuses={...current};}
    }
    const statuses={...base},logs=offlineRemoteLogs.slice();
    // Проекция читает очередь только выбранной смены: записи соседней смены
    // того же uid не попадают в её карточку.
    for(const op of offlineShiftPending(shiftId)){
      if(!state.shift||!statuses[op.truckId])continue;
      if(op.type==='reset'&&statuses[op.truckId].lastResetOperationId===op.id)continue;
      if(op.type==='load'&&(statuses[op.truckId].lastLoadLogId===op.logId||logs.some(l=>l.id===op.logId)))continue;
      if(op.type==='arrive'&&op.wantArrived!==false&&Number(statuses[op.truckId].arriveTimestamp||0)===Math.max(Number(op.createdAt),Number(op.lastLoadTimestamp||0)+1)&&statuses[op.truckId].arriveBy===op.actor)continue;
      const p=offlineProjection(statuses[op.truckId],op);statuses[op.truckId]=p.status;
      if(p.log&&!logs.some(l=>l.id===op.logId))logs.push(p.log);
    }
    state.truckStatus=statuses;state.logs=logs.sort((x,y)=>(y.timestamp||0)-(x.timestamp||0));offlineProjectTicker();
  }
  function offlineQueueAction(type,id,intent){
    // Принудительный перевод и завершение detached trip меняют сразу две смены:
    // их cross-shift CAS нельзя подтвердить из очереди (design §9). Офлайн-
    // попытка остаётся read-only с причиной и ничего не пишет на устройство.
    if(offlineIsOnlineOnlyCommand(type)){showError(offlineReasonLabel('online-only-command'));return false;}
    if(!currentUid||!intent||!intent.status||!state.shift||state.shift.id!==intent.shiftId)return false;
    if(type==='reset'&&!canAdmin()){showError('Только для администратора');return false;}
    const before=intent.status,now=Date.now(),gap=Math.max(MIN_CYCLE_MINUTES,settings.cycleMinutes||MIN_CYCLE_MINUTES)*60000;
    if(type==='no-return'&&before.noReturn===true){showToastEl('Вернуть машину — кнопкой «Приехал»',false);return false;}
    if(type==='load'&&!before.arriveStatus){showError('Сначала отметьте прибытие');return false;}
    if((type==='load'||(type==='arrive'&&!before.arriveStatus&&before.noReturn!==true))&&before.lastLoadTimestamp&&now-before.lastLoadTimestamp<gap){
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
        truckName:truck.brand+' '+truck.number,volume:truck.isGAI?0:truck.defaultVol,isGAI:!!truck.isGAI,status:'pending',
        // Конверт v2: scope и тип команды фиксируются при постановке в очередь и
        // при повторе не подменяются ни аккаунтом, ни выбранной сменой.
        protocolVersion:2,uid:currentUid,workspaceId:WORKSPACE_ID,commandType:type};
      if(type==='load')op.logId='load_'+id+'_'+op.shiftId+'_cycle_'+op.expectedRevision+'_'+op.arrivalTimestamp;
      if(isNasRuntime())op.operationScope=nasStorageScope();
      // Канонический конверт §9 сохраняется вместе с записью: при повторе
      // уходит именно он, а не тело, собранное заново из текущего экрана.
      const v2api=offlineV2Api();
      if(v2api&&typeof v2api.buildCommandEnvelope==='function'){
        const built=v2api.buildCommandEnvelope(op,{uid:currentUid,workspaceId:WORKSPACE_ID});
        if(built.ok){op.commandEnvelope=built.envelope;op.commandHash=built.commandHash;}
      }
      items.push(op);offlineJournalWrite(items); // Commit locally first; never silently lose an action.
      try{window.__gameCoinQueued?.(op);}catch(e){console.warn('[game animation]',e);}
      const old=state.truckStatus[id];offlineProjectState();signalLineTransition(id,old,state.truckStatus[id]);refreshLineViews();
      const label=type==='reset'?'🔄 Сброс таймера':type==='load'?'⚡ Погрузка':type==='ttn'?(op.collect?'📄 Забрал ТТН':'↩️ Снял ТТН'):type==='no-return'?'🚫 Не приехал':(op.wantArrived?'🚛 Приехал':'↩️ Снял прибытие');
      showToastEl(label+' · '+truckLabelHtml(id),false);
      if(navigator.onLine)offlineReplayJournal();
      return true;
    }catch(e){
      if((e&&e.storageQuota)||offlineQuotaError(e))offlineShowQuotaPanel(e);
      else showError('Действие не сохранено на устройстве: '+(e.message||e));
      return false;
    }
  }
  function offlineResolve(id,status,reason,extra){
    const all=offlineJournalRead(),op=all.find(x=>x.id===id);
    if(op&&op.status==='pending'){
      op.status=status;op.result=reason;op.resolvedAt=Date.now();
      // Permanent-отказ (закрытая смена, снятый участник, старый протокол)
      // помечается dead-letter этой смены: очередь не переигрывает его молча.
      if(extra&&extra.deadLetter)op.deadLetter=true;
      if(extra&&extra.details)op.rejectionDetails=extra.details;
      offlineJournalWrite(all);
      // Подтверждённая запись удаляется из журнала компакцией в offlineJournalWrite,
      // как только уведомление/аудит доставлены (effectsDelivered) — сервер уже
      // владеет данными, а вечный рост журнала переполнял память телефона.
    }
  }
  // Квота localStorage: панель по центру экрана с человеческим текстом;
  // техническая причина — мелким текстом внутри панели (класс error-panel-tech),
  // а не в заголовке. Флаг storageQuota ставит offlineJournalWrite после
  // неудачной аварийной чистки (её текст не содержит слова «quota»).
  function offlineShowQuotaPanel(e){
    showErrorPanel('Не удалось сохранить погрузку. Память телефона переполнена старыми записями — попробуйте ещё раз, приложение почистит их автоматически.'
      +'<div class="error-panel-tech">'+escapeHtml((e&&e.message)||String(e))+'</div>');
  }
  function offlineAdoptResult(op,result){
    // Результат чужой смены в основу выбранной не попадает: она сама придёт
    // своим снимком, а подмешивание рисовало бы её самосвал под текущей.
    const current=state.shift&&state.shift.id;
    const belongs=!!current&&op.shiftId===current;
    if(result.status&&belongs){
      const old=offlineRemoteStatuses[op.truckId];
      if(!old||old.shiftId!==op.shiftId||Number(old.cycleRevision||0)<=Number(result.status.cycleRevision||0))
        offlineRemoteStatuses[op.truckId]={id:op.truckId,...result.status};
    }
    if(result.log&&belongs&&!offlineRemoteLogs.some(l=>l.id===result.log.id)){
      offlineRemoteLogs.push(result.log);confirmedLoadIds.add(result.log.id);
    }
    offlineProjectState();refreshLineViews();
  }
  function undoLastOfflineAction(){
    if(!hasPermission('undo_action')&&!hasPermission('undo_any')){showError('Нет права отменять действия');return;}
    if(offlineReplayRunning){showToastEl('Действие отправляется на сервер',false);return;}
    const all=offlineJournalRead();let i=-1;
    for(let n=all.length-1;n>=0;n--)if(all[n].status==='pending'&&state.shift&&all[n].shiftId===state.shift.id){i=n;break;}
    if(i<0)return;all[i].status='cancelled';all[i].cancelledAt=Date.now();offlineJournalWrite(all);offlineProjectState();refreshLineViews();showToastEl('↩️ Ошибочное действие отменено. Штраф −3 🪙 будет учтён после связи с сервером.',true);window.__gameFlushPenalties?.();
  }
  async function offlineNotifyAccepted(op,result){
    let delivered=true;
    try{
      const ref=refs.notifications.doc('offline_'+op.id),snap=await ref.get({source:'server'});
      if(!snap.exists){
        const label=op.type==='reset'?'🔄 Сброс таймера':op.type==='load'?'⚡ Погрузка':op.type==='ttn'?(op.collect?'📄 Забрал ТТН':'↩️ Снял ТТН'):op.type==='no-return'?'🚫 Не приехал':(op.wantArrived?'🚛 Приехал':'↩️ Снял прибытие');
        await ref.set({...offlineUndoFields(op,result.beforeStatus||op.beforeStatus),gamePenaltyKey:window.__gamePenaltyKey(op.type,op.truckId,result.status||{},result.log?.id,op.id),type:op.type,truckId:op.truckId,logId:result.log?.id||null,
          createdBy:op.actor,createdByEmail:op.email||'',timestamp:op.createdAt,shiftId:op.shiftId,objectId:op.objectId||'',objectName:op.objectName||'',
          html:label+' · '+truckLabelHtml(op.truckId)});
      }
    }catch(e){delivered=false;console.warn('Не удалось отправить уведомление офлайн-действия',e);}
    try{
      const ref=refs.audit.doc('offline_'+op.id),snap=await ref.get({source:'server'});
      if(!snap.exists){
        const names={reset:'🔄 Сброс таймера',arrive:op.wantArrived?'🚛 Прибытие на линию':'↩️ Снято прибытие на линию',
          load:'⚡ Погрузка самосвала',ttn:op.collect?'📄 Забрана ТТН':'↩️ Снята отметка ТТН','no-return':'🚫 Самосвал не приехал'};
        await ref.set({text:(names[op.type]||op.type)+': '+op.truckName,
          timeStr:new Date(op.createdAt).toLocaleString('ru-RU'),
          objectName:state.shift?.objectName||'—',objectId:state.shift?.objectId||'',
          shiftId:op.shiftId,truckId:op.truckId,truckName:op.truckName,
          userEmail:op.email||'',userName:op.actor,createdByEmail:op.email||'',
          timestamp:op.createdAt,eventType:op.type,offlineOperationId:op.id});
      }
    }catch(e){delivered=false;console.warn('Не удалось отправить аудит офлайн-действия',e);}
      if(delivered){const all=offlineJournalRead(),saved=all.find(x=>x.id===op.id);if(saved){saved.effectsDelivered=true;offlineJournalWrite(all);}}
  }
  function offlineUndoFields(op,b){
    if(!b)return {};
    if(op.type==='load')return previousLoadSnapshot(b);
    if(op.type==='arrive')return {wasArrived:!!b.arriveStatus,prevTime:b.arriveStatus||null,prevTs:b.arriveTimestamp||null,prevArriveBy:b.arriveBy||null};
    if(op.type==='no-return')return {prevNoReturn:true,prevNoReturnAt:b.noReturnAt||null,prevNoReturnBy:b.noReturnBy||null};
    return {prevTtn:b.ttnStatus??null,prevTtnBy:b.ttnBy||null,prevTtnLogId:b.ttnLogId||null};
  }
  async function offlineReplayJournal(){
    if(isNasRuntime())return replayNasOfflineJournal();
    const sessionGeneration = authSessionGeneration;
    const sessionIsCurrent = () => sessionGeneration === authSessionGeneration;
    if(offlineReplayRunning||!navigator.onLine||!currentUid||!permissionsLoaded||currentUserStatus!=='active'||!profileServerConfirmed||!permissionsServerConfirmed||Date.now()<offlineServerRetryAt||syncState.pendingWrites.status||syncState.pendingWrites.shift)return;
    offlineReplayRunning=true;
    try{
      for(const op of offlineJournalRead().filter(x=>x.status==='confirmed'&&!x.effectsDelivered)) {
        // A confirmed operation from a closed/replaced shift must never emit
        // notifications or audit into the newly restored shift.
        if (state.shift?.id && op.shiftId !== state.shift.id) continue;
        offlineNotifyAccepted(op,op.savedResult||{}).catch(e=>console.warn('[offline effects]',e));
      }
      // Re-read the durable journal after each operation. A user can enqueue a
      // dependent action while this replay is already running; iterating a
      // one-time snapshot would leave that new action pending until another
      // online event or reload.
      while(true){
        // Сначала досылаем очередь выбранной смены, потом фоновые: карточка
        // смены и её счётчик относятся ровно к её записям.
        let op=offlineShiftPending(state.shift?.id||'')[0]||offlinePendingOps()[0];
        if(!op)break;
        if(!sessionIsCurrent()||!navigator.onLine||currentUserStatus!=='active')break;
        if(!offlineJournalRead().some(x=>x.id===op.id&&x.status==='pending'))continue;
        if(op.dependencyId){
          const previous=offlineJournalRead().find(x=>x.id===op.dependencyId);
          if(previous?.status==='pending')break;
          if(previous?.status==='rejected'){
            offlineResolve(op.id,'rejected','previous-action-rejected');offlineProjectState();refreshLineViews();continue;
          }
        }
        // Перед отправкой сверяется хеш сохранённого конверта. Расхождение —
        // dead-letter без запроса; сама отправка идёт ровно сохранённым телом.
        const command=offlineReplayCommand(op);
        if(!command)continue;
        op=command;
        try{
          if(!sessionIsCurrent())break;
          const result=await db.runTransaction(async tx=>{
          if(!sessionIsCurrent()||currentUserStatus!=='active'||!profileServerConfirmed||!permissionsServerConfirmed){
            throw {code:'auth-session-stale',message:'Сессия изменилась до чтения настроек'};
          }
          const policy=await tx.get(appConfigRef);
          if(!sessionIsCurrent()||currentUserStatus!=='active'||!profileServerConfirmed||!permissionsServerConfirmed){
            throw {code:'auth-session-stale',message:'Сессия изменилась при чтении настроек'};
          }
            const sharedCycle=policy.exists?Number(policy.data().cycleMinutes)||15:15;
            const before=await readLineState(tx,op.truckId,op.shiftId);
            const truck=findTruck(op.truckId);if(!truck)throw {code:'truck-missing',message:'Самосвал не найден'};
            const revision=Number(before.cycleRevision||0),gap=Math.max(MIN_CYCLE_MINUTES,sharedCycle,op.cycleMinutes||MIN_CYCLE_MINUTES)*60000;
            if(op.type==='reset'){
              if(!canAdmin())throw {code:'permission-denied',message:'Сброс доступен администратору'};
              if(before.lastResetOperationId===op.id)return {outcome:'confirmed',status:before};
              if(revision!==op.expectedRevision||Number(before.lastLoadTimestamp||0)!==Number(op.lastLoadTimestamp||0))return {outcome:'rejected',reason:'arrival-changed',status:before};
              const update={lastLoadTimestamp:null,lastLoadBy:null,arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false,cycleRevision:revision+1,lastResetOperationId:op.id};
              tx.update(refs.truckStatus.doc(op.truckId),update);
              return {outcome:'confirmed',status:{...before,...update},beforeStatus:before,didCommit:true,gameRewardAction:{id:op.id,type:op.type,at:Number(op.createdAt)}};
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
              return {outcome:'confirmed',status:{...before,...update},beforeStatus:before,didCommit:true,gameRewardAction:{id:op.id,type:op.type,at:Number(op.createdAt)}};
            }
            if(op.type==='load'){
              const logId=op.logId||('load_'+op.truckId+'_'+op.shiftId+'_cycle_'+op.expectedRevision+'_'+op.arrivalTimestamp);
              // The deterministic log ID is an idempotency key. Check it
              // *before* rejecting a changed status: the first commit may
              // have succeeded while its acknowledgement was lost.
              const ref=refs.logs.doc(logId),existing=await tx.get(ref);
              if(existing.exists){
                const record=existing.data();
                if(record.clientOperationId===op.id)return {outcome:'confirmed',status:before,log:{id:logId,...record}};
                return {outcome:'rejected',reason:'duplicate',status:before};
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
              return {outcome:'confirmed',status:{...before,...update},log:{id:logId,...log},beforeStatus:before,didCommit:true,gameRewardAction:{id:op.id,type:op.type,at:Number(op.createdAt)}};
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
              return {outcome:'confirmed',status:{...before,...update},beforeStatus:before,didCommit:true,gameRewardAction:{id:op.id,type:op.type,at:Number(op.createdAt)}};
            }
            return {outcome:'rejected',reason:'unsupported'};
          });
          if(!sessionIsCurrent())break;
          offlineTransportRecovered();offlineAdoptResult(op,result);
          {const all=offlineJournalRead(),saved=all.find(x=>x.id===op.id);if(saved){saved.savedResult={status:result.status||null,beforeStatus:result.beforeStatus||op.beforeStatus,log:result.log||null};offlineJournalWrite(all);}}
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
            offlineNotifyAccepted(op,result).catch(e=>console.warn('[offline effects]',e));
          }else showErrorPanel('⚠️ '+escapeHtml(offlineReasonLabel(result.reason)));
        }catch(e){
          if(e.code==='auth-session-stale')break;
          if(offlineTransportError(e)){offlineTransportFailed(e);break;}
          if(!navigator.onLine||['aborted','cancelled'].includes(e.code)){offlineServerRetryAt=Date.now()+1500;break;}
          const verdict=offlineReplayVerdict(e.code||e.message||'error',e.serverDetails||e.details||{});
          offlineResolve(op.id,'rejected',verdict.code,{deadLetter:verdict.deadLetter,details:verdict.details});offlineProjectState();refreshLineViews();
          const label=e.message||offlineReasonLabel(verdict.code);
          showToastEl('⚠️ Офлайн-действие отклонено: '+escapeHtml(label),true);
          showErrorPanel('⚠️ Офлайн-действие отклонено: '+escapeHtml(label));
        }
      }
    }finally{
      offlineReplayRunning=false;updateSyncUI();
      // A second action can be queued while this replay is in flight. The
      // enqueue call coalesces while the lock is held, so drain the durable
      // journal once the lock is released instead of waiting for reload/reconnect.
      if (navigator.onLine && offlinePendingCount() > 0) queueMicrotask(() => offlineReplayJournal());
    }
  }
  // Offline-first operations. The UI moves immediately; the journal replays
  // through server transactions even when navigator.onLine incorrectly says true.
