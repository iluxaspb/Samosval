  // Панель «Неподтверждённые изменения» (инструмент обновления, 2026-11).
  // Владелец видел: «Установить» → «Обновление отложено: есть неподтверждённые
  // изменения на сервере: 1», но инструмента разобраться не было. Панель
  // собирает ВСЕ неподтверждённые операции по категориям (рейсы, команды
  // сервера, табель), объясняет причину простым языком и позволяет повторить
  // отправку или осознанно отбросить застрявшую команду. Ничего не удаляется
  // без явного подтверждения пользователя.
  function nasCommandsQueueKey(scope){return 'samosval_nas_commands_v1:'+scope;}
  function nasToolReadQueue(key){try{const queue=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(queue)?queue:[];}catch(_){return [];}}
  function nasToolWriteQueue(key,queue){localStorage.setItem(key,JSON.stringify(queue));}
  function nasToolRemoveFromQueue(key,operationId){nasToolWriteQueue(key,nasToolReadQueue(key).filter(x=>!(x.operation&&x.operation.id===operationId)));}
  // Сервер окончательно отказал (4xx, кроме «повторите позже» 408/429):
  // команда никогда не пройдёт — её можно только осознанно отбросить в панели.
  function nasToolPermanentReject(status){const code=Number(status)||0;return code>=400&&code<500&&![408,429].includes(code);}
  // Ошибка отправки записывается в саму команду очереди: панель показывает
  // оператору причину застревания, а не безликое «изменений: 1».
  function markNasCommandFailed(key,operationId,error){
    const queue=nasToolReadQueue(key),entry=queue.find(x=>x.operation&&x.operation.id===operationId);if(!entry)return;
    entry.lastError={status:Number(error&&error.status)||0,message:String(error&&error.message||error||'').slice(0,200),at:Date.now()};
    entry.failed=nasToolPermanentReject(entry.lastError.status);
    nasToolWriteQueue(key,queue);
  }
  function markIdentityCommandFailed(key,operationId,error){markNasCommandFailed(key,operationId,error);}
  const NAS_OPERATION_TITLES={
    'shift.object':'Смена объекта','line.add':'Добавление самосвала на линию','line.remove':'Снятие самосвала с линии',
    'truck.create':'Создание самосвала','truck.update':'Изменение самосвала','truck.delete':'Удаление самосвала',
    'object.create':'Создание объекта','object.update':'Изменение объекта','object.delete':'Удаление объекта',
    'report.update':'Изменение рейса','report.delete':'Удаление рейса',
    'settings.patch':'Изменение настроек','settings.rewards':'Изменение наград',
    'game.play':'Действие в мини-игре','game.grant':'Начисление монет',
    'prepare':'Подготовка закрытия смены','finish':'Закрытие смены',
    'auxiliary.save':'Изменение записи','auxiliary.delete':'Удаление записи'
  };
  const NAS_IDENTITY_TITLES={
    'user.access':'Изменение доступа пользователя','user.nickname':'Изменение имени пользователя','user.role':'Смена роли пользователя',
    'user.delete':'Удаление пользователя','permissions.replace':'Изменение прав роли',
    'registration.approve':'Одобрение заявки','registration.reject':'Отклонение заявки'
  };
  function nasToolObjectLabel(id){
    const row=(typeof state!=='undefined'&&Array.isArray(state.objects)?state.objects:[]).find(x=>x.id===id);
    return row?(row.name||row.title||String(id)):'';
  }
  function nasToolTruckLabel(id,fallback){if(fallback)return fallback;if(typeof truckName==='function'&&id){try{return truckName(id);}catch(_){}}return '';}
  function nasOperationTitle(operation){
    const type=operation&&operation.type;
    let title=NAS_OPERATION_TITLES[type]||'';
    if(!title&&operation&&('objectId' in operation)&&!type)title='Открытие смены';
    if(!title)title='Команда сервера';
    const extras=[];
    if(operation.objectId)extras.push(nasToolObjectLabel(operation.objectId)||'объект');
    if(operation.truckId)extras.push(nasToolTruckLabel(operation.truckId));
    if(operation.uid)extras.push('пользователь');
    return extras.length?title+' · '+extras.join(', '):title;
  }
  function nasQueueStuckReason(entry){
    const error=entry&&entry.lastError;
    if(!error)return {text:entry&&entry.failed?'Команда не отправлена — повторите или отбросьте':'Ожидает отправки на сервер',stuck:!!(entry&&entry.failed)};
    const status=Number(error.status)||0,short=String(error.message||'').slice(0,140);
    if([400,409].includes(status))return {text:'Сервер отклонил навсегда (конфликт или неверные данные'+(short?': '+short:'')+'). Команда не будет применена — можно отбросить',stuck:true};
    if(status===401||status===403)return {text:'Сервер отказал в доступе (нет прав или сеанс истёк'+(short?': '+short:'')+'), команда не будет применена',stuck:true};
    if(status===408||status===429)return {text:'Сервер перегружен — повторите отправку позже',stuck:false};
    if(status>=500)return {text:'Ошибка сервера (код '+status+') — повторите отправку позже',stuck:false};
    if(!status)return {text:'Нет связи с сервером — отправится автоматически после восстановления связи',stuck:false};
    return {text:'Сервер вернул ошибку (код '+status+(short?': '+short:'')+'). Команда, вероятно, не будет применена',stuck:true};
  }
  // Единый снимок всех неподтверждённых операций по категориям.
  async function collectUnsyncedUpdates(){
    const categories=[];
    const noLink=(typeof offlineServerUnreachable!=='undefined'&&offlineServerUnreachable)||(typeof navigator!=='undefined'&&!navigator.onLine);
    const ops=(typeof offlinePendingOps==='function'?offlinePendingOps():[]).filter(op=>op&&op.status!=='resolved');
    if(ops.length){
      categories.push({id:'trips',title:'Рейсы',count:ops.length,items:ops.map(op=>({
        id:op.id,
        title:({arrive:'Прибытие',load:'Погрузка',ttn:'Отметка ТТН',reset:'Сброс таймера'})[op.type]+' · '+nasToolTruckLabel(op.truckId,op.truckName||''),
        detail:(op.createdAt?new Date(op.createdAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})+' — ':'')+'не отправлено: '+(noLink?'нет связи':'ожидает отправки')
      }))});
    }
    const commands=[];
    const client=(typeof nasRuntimeClient!=='undefined')?nasRuntimeClient:null;
    if(client&&client.scope){
      const key=nasCommandsQueueKey(client.scope);
      for(const entry of nasToolReadQueue(key))commands.push(nasCommandView(entry,key,false));
    }
    if(typeof nasIdentityJournalKey==='function'){
      const key=nasIdentityJournalKey();
      for(const entry of nasToolReadQueue(key))commands.push(nasCommandView(entry,key,true));
    }
    if(commands.length)categories.push({id:'server',title:'Команды сервера',count:commands.length,items:commands});
    let tabel={pending:0,uploading:false};
    if(typeof window!=='undefined'&&typeof window.__tabelPrepareUpdate==='function'){
      try{const result=await window.__tabelPrepareUpdate();tabel={pending:Number(result&&result.pending)||0,uploading:!!(result&&result.uploading)};}catch(_){}
    }
    if(tabel.pending||tabel.uploading){
      categories.push({id:'tabel',title:'Табель',count:tabel.pending,items:[{id:'tabel-main',
        title:'Табель: '+tabel.pending+' неподтверждённ'+(tabel.pending%10===1&&tabel.pending%100!==11?'ая запись':'ых записей')+(tabel.uploading?' — идёт отправка':''),
        detail:'Откройте табель и дождитесь сохранения или разрешения конфликта'}]});
    }
    return {categories};
  }
  function nasCommandView(entry,key,identity){
    const operation=entry.operation||{};
    const reason=nasQueueStuckReason(entry);
    return {
      key,identity,operationId:operation.id,
      title:(identity?NAS_IDENTITY_TITLES[operation.type]||'Изменение доступа':nasOperationTitle(operation)),
      createdAt:entry.createdAt||operation.createdAt||null,
      detail:reason.text+(entry.createdAt?' · с '+new Date(entry.createdAt).toLocaleString('ru-RU'):''),
      stuck:reason.stuck,canRetry:!identity||true
    };
  }
  const NAS_SUBMIT_METHODS={control:'submitControl',start:'startShift',close:'closeShift',settings:'submitSettings',archive:'submitArchive',game:'submitGame',auxiliary:'submitAuxiliary',report:'submitReport',backup:'submitBackup',notification:'submitNotificationTest'};
  // Повтор отправки одной команды из панели: тот же метод клиента, тот же ID.
  async function retryNasQueueEntry(key,operationId){
    const entry=nasToolReadQueue(key).find(x=>x.operation&&x.operation.id===operationId);
    if(!entry)throw Error('Команда уже отсутствует в очереди');
    const client=(typeof nasRuntimeClient!=='undefined')?nasRuntimeClient:null;
    if(!client)throw Error('Сеанс сервера не загружен — повторите после входа');
    if(typeof navigator!=='undefined'&&!navigator.onLine)throw Error('Нет соединения с сервером');
    const identity=typeof entry.slot!=='string';
    if(identity){
      if(typeof client.submitAdministration!=='function')throw Error('Клиент не поддерживает повтор этой команды');
    }else{
      const channel=String(entry.slot||'').split(':')[0];
      const method=NAS_SUBMIT_METHODS[channel];
      if(!method||typeof client[method]!=='function')throw Error('Неизвестный тип команды: '+channel);
    }
    entry.failed=false;delete entry.lastError;entry.identity=identity;
    nasToolWriteQueue(key,nasToolReadQueue(key).map(x=>x.operation&&x.operation.id===operationId?entry:x));
    try{
      const result=identity
        ?await client.submitAdministration(entry.operation,{operationScope:entry.scope})
        :await client[NAS_SUBMIT_METHODS[String(entry.slot||'').split(':')[0]]](entry.operation,{operationScope:entry.scope});
      nasToolRemoveFromQueue(key,operationId);
      return result;
    }catch(error){
      if([400,409].includes(error&&error.status))nasToolRemoveFromQueue(key,operationId);
      else markNasCommandFailed(key,operationId,error);
      throw error;
    }
  }
  // Удаление ТОЛЬКО с явного подтверждения пользователя; текст объясняет,
  // что именно будет отброшено. confirm — async (вопрос) => boolean.
  async function discardNasQueueEntry(key,operationId,confirm){
    const entry=nasToolReadQueue(key).find(x=>x.operation&&x.operation.id===operationId);
    if(!entry)return false;
    const view=nasCommandView(entry,key,!!entry.identity);
    const question='Отбросить «'+view.title+'»?\n\n'+view.detail+'.\n\nИзменение НЕ применено на сервере и будет отброшено (на сервере ничего не изменится). Продолжить?';
    const agreed=typeof confirm==='function'?await confirm(question):false;
    if(!agreed)return false;
    nasToolRemoveFromQueue(key,operationId);
    return true;
  }
  function showUnsyncedChangesPanel(){
    const overlay=document.createElement('div');
    overlay.id='wt-unsynced-panel';
    overlay.style.cssText='position:fixed;inset:0;z-index:12000;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.75);padding:14px;';
    const card=document.createElement('div');
    card.style.cssText='width:min(560px,100%);max-height:86dvh;overflow:auto;background:var(--card,#122135);color:var(--text,#f1f5f9);border:1px solid var(--border,#334155);border-radius:18px;padding:18px 18px 14px;font-size:15px;line-height:1.5;box-shadow:0 24px 80px #0008;';
    overlay.append(card);
    const close=()=>overlay.remove();
    overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
    const toast=(text,bad)=>{if(typeof showToastEl==='function')showToastEl(text,!!bad);};
    async function runAction(button,work){button.disabled=true;try{await work();}catch(error){toast(error&&error.message||'Не удалось',true);if(typeof showError==='function')showError(error&&error.message||'Не удалось');}finally{render();}}
    async function render(){
      const report=await collectUnsyncedUpdates();
      card.textContent='';
      const title=document.createElement('h2');
      title.style.cssText='margin:0 0 6px;font-size:19px;';
      title.textContent='Неподтверждённые изменения';
      card.append(title);
      const intro=document.createElement('p');
      intro.style.cssText='margin:0 0 12px;font-size:13px;color:var(--muted,#94a3b8);';
      intro.textContent='Пока есть неподтверждённые изменения, обновление отложено. Разберитесь с ними — затем кнопка «Установить» сработает.';
      card.append(intro);
      if(!report.categories.length){
        const ok=document.createElement('p');
        ok.style.cssText='font-weight:700;color:#4ade80;margin:12px 0;';
        ok.textContent='✅ Все изменения подтверждены сервером. Можно устанавливать обновление.';
        card.append(ok);
      }
      for(const category of report.categories){
        const head=document.createElement('h3');
        head.style.cssText='margin:14px 0 6px;font-size:15px;';
        head.textContent=category.title+(category.count?': '+category.count:'');
        card.append(head);
        for(const item of category.items){
          const row=document.createElement('div');
          row.style.cssText='border:1px solid var(--border,#334155);border-radius:12px;padding:10px;margin:8px 0;';
          const name=document.createElement('div');
          name.style.cssText='font-weight:700;';
          name.textContent=item.title;
          const detail=document.createElement('div');
          detail.style.cssText='font-size:13px;color:var(--muted,#94a3b8);margin:4px 0 8px;';
          detail.textContent=item.detail;
          row.append(name,detail);
          if(category.id==='server'){
            const retry=document.createElement('button');
            retry.type='button';retry.className='btn btn-quick btn-small';
            retry.style.marginRight='6px';retry.textContent='Повторить отправку сейчас';
            retry.onclick=()=>runAction(retry,async()=>{await retryNasQueueEntry(item.key,item.operationId);toast('Команда отправлена');});
            const discard=document.createElement('button');
            discard.type='button';discard.className='btn btn-secondary btn-small';
            discard.textContent=item.stuck?'Удалить эту команду':'Отбросить';
            discard.onclick=()=>runAction(discard,async()=>{
              const removed=await discardNasQueueEntry(item.key,item.operationId,async question=>typeof appConfirm==='function'?appConfirm(question):window.confirm(question));
              if(removed)toast('Команда отброшена — на сервере ничего не изменилось');
            });
            row.append(retry,discard);
          }
          card.append(row);
        }
        if(category.id==='trips'){
          const retry=document.createElement('button');
          retry.type='button';retry.className='btn btn-quick btn-small';
          retry.textContent='Повторить отправку рейсов сейчас';
          retry.onclick=()=>runAction(retry,async()=>{if(typeof offlineReplayJournal==='function'){void offlineReplayJournal();toast('Отправка рейсов запущена');}});
          card.append(retry);
        }
        if(category.id==='tabel'){
          const open=document.createElement('button');
          open.type='button';open.className='btn btn-quick btn-small';
          open.textContent='Открыть табель';
          open.onclick=()=>{close();if(typeof openTabelV2==='function')void openTabelV2();else document.getElementById('nav-tabel-v2')?.click();};
          card.append(open);
        }
      }
      const done=document.createElement('button');
      done.type='button';done.className='btn btn-primary';done.style.cssText='width:100%;margin-top:14px;padding:12px;font-size:16px;';
      done.textContent='Закрыть';
      done.onclick=close;
      card.append(done);
      document.body.append(overlay);
    }
    if(document.getElementById('wt-unsynced-panel'))document.getElementById('wt-unsynced-panel').remove();
    void render();
  }
  if(typeof window!=='undefined')window.__wtShowUnsyncedPanel=showUnsyncedChangesPanel;
