  // TEST runtime is hosted on Ubuntu. Firebase is used only for authentication
  // tokens; application data and writes go through the Ubuntu API.
  const UBUNTU_API_BASE = WORKING_TEST_UBUNTU_API_BASE;
  function nasProvider() {
    // Единственный сервер данных — Ubuntu. Firebase используется только для
    // входа пользователей, переключения режимов больше нет.
    return 'ubuntu';
  }
  function isNasRuntime() { return nasProvider() !== 'firebase'; }
  function nasApiBase() { return UBUNTU_API_BASE; }
  function nasStorageScope() { const base=nasApiBase();let datasetEpoch=0;try{datasetEpoch=Number(localStorage.getItem('samosval-working-test-nas-epoch:'+JSON.stringify([base,WORKSPACE_ID,currentUid]))||0)||0;}catch{}return JSON.stringify([nasProvider(),base,WORKSPACE_ID,currentUid,...(datasetEpoch?[datasetEpoch]:[])]); }
  let nasRuntimeClient = null, nasRuntimeStop = null, nasRuntimeEpoch = 0, nasResumePolling=null, nasPollHolds=0, nasReadGeneration=0, nasPresenceTimer=null, nasGamesTimer=null;
  // Мост параллельных смен v2 (40-shift-contexts.js + 41-v2-transport.js).
  let nasV2Bridge = null;
  // Сбой моста до первого успешного ответа пишется в консоль один раз.
  let nasV2BridgeErrorLogged = false;
  // Мост уже ответил хотя бы одним списком смен: с этого момента линию ведёт
  // v2, а v1-снимок (ровно одна смена по контракту) больше не спрашиваем.
  let nasV2BridgeLive = false;
  // Сервер уже отказал v1-снимку линии кодом multiple-active-shifts: это не
  // временный сбой, а контракт (линия одна). Повторять запрос бессмысленно,
  // даже если мост ещё не подтвердился.
  let nasV2LineRefused = false;
  // Мост поднят и отвечает за линию. v1-снимок в этом режиме не запрашивается
  // вовсе: иначе первая же секунда после входа давала лишний 409 в консоли.
  let nasV2BridgeActive = false;
  // Сервер не знает маршрутов v2 (старый релиз): линия возвращается на v1.
  let nasV2Unsupported = false;
  // Пробуждение после смены сети: обработчики событий и защита от наложения.
  let nasWakeStop=null, nasWakeInFlight=false, nasWakeAt=0;
  // Активное обновление: пока приложение на экране, данные читаются сами.
  let nasActivityTimer=null, nasActivityInFlight=false, nasActivityPending=false, nasActivityGate=null;
  // Single-writer authority as announced by the server. The phone never decides
  // this on its own: it mirrors the server and stops writing when it is not the
  // declared authority.
  let nasAuthority = { provider: 'ubuntu', generation: 0 };
  const nasReceiptFloors = new Map();
  const nasPresenceLeavers=new Set();
  let nasAdministration=null,nasAdminRead=null,nasCatalogRead=null,nasCatalogSnapshot=null;
  let nasSettingsSnapshot=null,nasSettingsRead=null;
  let nasArchiveRead=null;
  let nasGameRead=null,nasGameSnapshot=null,nasGameReady=false,nasGameReceiptFloor=0;
  let nasAuxSnapshot=null,nasAuxRead=null;
  // Хэши значимых данных линии и сеанса: неизменный снапшот не должен
  // гонать полную перерисовку (карточки «Линии» дёргались на каждом цикле).
  function nasStableHash(value){try{return JSON.stringify(value);}catch(_){return null;}}
  let nasLineHash=null,nasSessionHash=null;
  // После сворачивания приложения сокет и таймеры могут «умереть». Пока
  // «сторож» промиса не пуст, повторный вызов возвращает тот же мёртвый
  // промис, и ошибка источника никогда не снимается. При возврате в
  // приложение сторожа сбрасываются, и чтение начинается заново.
  // Флаги серии и пробуждения сбрасываются тоже: на замороженной вкладке их
  // «finally» может не выполниться никогда, и тогда каждый новый возврат из
  // фона уходил в «pending», а реальный запрос с прерыванием мёртвого сокета
  // (nasNetworkWake → abortInflight) не запускался — оставался «не в сети».
  function nasDropHungReads(){nasSettingsRead=null;nasArchiveRead=null;nasGameRead=null;nasAuxRead=null;nasCatalogRead=null;nasAdminRead=null;nasActivityInFlight=false;nasActivityPending=false;nasActivityGate=null;}
  // Правила повторов живут в отдельном файле 26-nas-resume.js. До его
  // загрузки (и в тестах) пользуемся безопасной копией того же состояния.
  function nasSyncNewState(){return typeof WorkingTestNasResume!=='undefined'?WorkingTestNasResume.createState():{items:{}};}
  function nasSyncApi(){return typeof WorkingTestNasResume!=='undefined'?WorkingTestNasResume:null;}
  let nasSyncRetry=nasSyncNewState(), nasSyncTimer=null, nasLastSessionAt=0, nasHiddenAt=0;
  const nasCommandFlights=new Map();
  function stopNasRuntime() {
    if(typeof resetTruckPhones==='function')resetTruckPhones();
    nasStopV2Shifts();
    nasRuntimeEpoch++;nasReadGeneration++;nasResumePolling=null;nasPollHolds=0;
    nasConnectionStop();
    nasWakeStop?.();nasWakeStop=null;nasWakeInFlight=false;nasWakeAt=0;
    if(nasActivityTimer&&typeof clearInterval==='function'){clearInterval(nasActivityTimer);nasActivityTimer=null;}
    nasActivityTimer=null;nasActivityInFlight=false;nasActivityPending=false;nasActivityGate=null;
    if(nasSyncTimer&&typeof clearInterval==='function'){clearInterval(nasSyncTimer);nasSyncTimer=null;}
    nasSyncTimer=null;nasSyncRetry=nasSyncNewState();nasLastSessionAt=0;nasHiddenAt=0;
    if(nasPresenceTimer&&typeof clearInterval==='function'){clearInterval(nasPresenceTimer);nasPresenceTimer=null;}
    if(nasGamesTimer&&typeof clearInterval==='function'){clearInterval(nasGamesTimer);nasGamesTimer=null;}
    nasRuntimeStop?.(); nasRuntimeStop = null;
    nasRuntimeClient?.stop(); nasRuntimeClient = null;
    nasReceiptFloors.clear();
    nasPresenceLeavers.clear();
    nasAdministration=null;nasAdminRead=null;nasCatalogRead=null;nasCatalogSnapshot=null;nasCommandFlights.clear();
    nasSettingsSnapshot=null;nasSettingsRead=null;
    nasArchiveRead=null;
    nasGameRead=null;nasGameSnapshot=null;nasGameReady=false;nasGameReceiptFloor=0;
    nasAuxSnapshot=null;nasAuxRead=null;
    nasLineHash=null;nasSessionHash=null;
  }
  // Резерв может быть ещё не наполнен: администратору нужен выход обратно на
  // Firebase прямо с экрана ожидания, иначе режим не вернуть из интерфейса.
  function installNasReturnToFirebase(){
    const card=document.querySelector('#pendingScreen .pending-card');
    if(!card||document.getElementById('nasReturnFirebaseBtn'))return;
    const btn=document.createElement('button');
    btn.id='nasReturnFirebaseBtn';btn.className='btn btn-secondary';
    btn.style.width='100%';btn.style.marginTop='10px';
    btn.textContent='Вернуться на Firebase (администратор)';
    btn.addEventListener('click',async()=>{
      btn.disabled=true;
      try{
        const snap=await db.collection('users').doc(currentUid).get();
        if(!snap.exists||snap.data().role!=='admin')throw Error('Вернуть режим может только администратор');
        const current=await readWorkingAuthority();
        await writeAuthority('firebase',current.generation);
        showToastEl('Сервер данных: Firebase',false);
        location.reload();
      }catch(error){
        btn.disabled=false;
        showError(error.message||'Не удалось вернуть режим');
      }
    });
    card.append(btn);
  }
  function loadNasSessionClient() { return import(new URL('./working-test/synology/session-client.mjs',document.baseURI).href); }
  function applyNasSession(session) {
    const profile=session.profile, active=session.identityReady&&profile?.status==='active'&&!profile.deleted;
    // Значимая часть сеанса — права и профиль. Пока она не изменилась, полная
    // перерисовка не нужна: снапшоты линии приходят своим путём.
    const sessionChanged=nasStableHash([session.permissions,profile?.role,profile?.status,profile?.deleted,profile?.nickname])!==nasSessionHash;
    if(sessionChanged)nasSessionHash=nasStableHash([session.permissions,profile?.role,profile?.status,profile?.deleted,profile?.nickname]);
    if(session.authority&&Number.isSafeInteger(session.authority.generation)&&session.authority.generation>0){
      const next={provider:session.authority.provider==='firebase'?'firebase':'ubuntu',generation:session.authority.generation};
      if(next.provider!==nasAuthority.provider||next.generation!==nasAuthority.generation){
        const previous=nasAuthority;nasAuthority=next;
        try{if(typeof CustomEvent==='function')window.dispatchEvent(new CustomEvent('samosval-working-test-authority-changed',{detail:{previous,current:next}}));}catch(_){}
      }
    }
    if(currentUserRole&&currentUserRole!==profile?.role){nasReadGeneration++;nasGameSnapshot=null;nasGameReady=false;nasGameReceiptFloor=0;window.__gameAccessChanged?.();}
    currentUserRole=profile?.role||null;currentUserStatus=active?'active':profile?.status==='disabled'||profile?.deleted?'disabled':'pending';
    currentUserNickname=profile?.nickname||sanitizeName(currentEmail);
    permissionsConfig=active?{...(currentUserRole==='admin'?permissionsConfig:{}),[currentUserRole]:session.permissions}:{};permissionsLoaded=!!active;
    if((!active||!hasPermission('view_truck_phone'))&&typeof resetTruckPhones==='function')resetTruckPhones();
    // The NAS session arrives over authenticated HTTPS from the server, so it
    // is the server confirmation for profile and permissions. Without this the
    // game wallet reported "ready" while every action was refused as unsynced.
    profileServerConfirmed=!!active;permissionsServerConfirmed=!!active;
    if(active)document.body.setAttribute('data-perms-ready','1');else document.body.removeAttribute('data-perms-ready');
    document.getElementById('pendingScreen').style.display=currentUserStatus==='pending'?'flex':'none';
    document.getElementById('disabledScreen').style.display=currentUserStatus==='disabled'?'flex':'none';
    document.getElementById('mainHeader').style.display=active?'':'none';
    document.querySelector('.container').style.display=active?'':'none';document.querySelector('nav').style.display=active?'flex':'none';
    if(!active){
      nasSettingsSnapshot=null;appConfig={};nasGameSnapshot=null;nasGameReady=false;nasGameReceiptFloor=0;window.__gameAccessChanged?.();
      state.trucks=[];state.logs=[];state.truckStatus={};state.shift=null;state.restoredShifts=[];state.archive=[];state.trash=[];state.audit=[];state.users=[];
      offlineRemoteStatuses={};offlineRemoteLogs=[];initialized=false;cancelHold();
      document.querySelectorAll('dialog[open]').forEach(d=>d.close());
      document.getElementById('registrationStatusText').textContent = session.identityReady
        ? 'Учётная запись ожидает допуска на сервере Ubuntu.'
        : 'В Ubuntu-резерве нет вашей учётной записи: резерв ещё не наполнен рабочими данными. Вернитесь на Firebase, если вы администратор.';
      document.getElementById('disabledStatusText').textContent=profile?.rejectionReason||'Доступ ограничен администратором.';
      installNasReturnToFirebase();
    }
    markSync('profile',false,false,profile?1:0);markSync('permissions',false,false,active?1:0);
    if(!sessionChanged)return;
    updateUserBadge();updateNavUI();applyRoleUI();renderAll();
  }
  // NAS versions deployed before the server ticker fix return opaque truck IDs.
  // The browser can safely render its verified catalog without changing NAS data.
  function presentNasLineNotification(item){
    if(!item||typeof item.id!=='string'||!item.id.startsWith('nas_')||!['arrive','load','ttn','reset','no-return'].includes(item.type))return item;
    const labels={arrive:'Прибытие на линию',load:'Погрузка',ttn:'Отметка ТТН',reset:'Сброс таймера','no-return':'Самосвал не приехал'};
    const truck=state.trucks.find(row=>row.id===item.truckId);
    const visibleTruck=truck?truckLabelHtml(item.truckId):'<b>Самосвал</b>';
    const log=item.type==='load'&&!item.logId?state.logs.find(row=>row.clientOperationId===item.actionId&&row.truckId===item.truckId&&row.shiftId===item.shiftId):null;
    return {...item,html:labels[item.type]+' · '+visibleTruck,...(log?{logId:log.id}:{})};
  }
  function refreshNasLineNotificationDisplay(){
    state.notifications=(state.notifications||[]).map(presentNasLineNotification);
  }
  function acceptNasLineSnapshot(snapshot) {
    // A snapshot read before a committed receipt must not roll the UI backwards.
    for(const floor of nasReceiptFloors.values()){
      if(floor.shiftId!==snapshot.shift?.id)continue;
      const status=snapshot.statuses.find(s=>s.id===floor.truckId);
      if(!status||Number(status.cycleRevision||0)<floor.cycle||Number(status.ttnRevision||0)<floor.ttn)return false;
    }
    nasReceiptFloors.clear();
    // Неизменный снапшот не перерисовывает интерфейс: полная перерисовка
    // гоняет все вкладки, а таймеры ходки пересортировывают карточки каждый
    // цикл. Хэш покрывает всё значимое: смены, машины, статусы и рейсы.
    const significant=[snapshot.shift,snapshot.trucks,snapshot.statuses,snapshot.logs,snapshot.restoredShifts||[],snapshot.cycleMinutes];
    const nextHash=nasStableHash(significant);
    const lineChanged=nextHash!==null&&nextHash!==nasLineHash;
    if(lineChanged)nasLineHash=nextHash;
    state.shift=snapshot.shift;state.trucks=snapshot.trucks;
    // Восстановленные для правок архивные смены живут параллельно активной
    // линии: пользователь редактирует их через отчёт, не закрывая текущую.
    // v1-снапшот отдаёт их только на старом сервере; на канонической схеме
    // карточки приходят из v2-контекстов (nasRestoredShiftsCombined).
    nasRestoredV1=snapshot.restoredShifts||[];
    state.restoredShifts=nasRestoredShiftsCombined();
    // Рейсы восстановленных смен попадают в общий список: правки (✏️/X) ищут
    // лог по id, а сводки активной смены фильтруются по shiftId и их не видят.
    // offlineRemoteLogs — источник офлайн-проекции: кладём их туда, иначе
    // offlineProjectState затрёт список своим срезом.
    const restoredLogs=state.restoredShifts.flatMap(r=>r.logs);
    offlineRemoteLogs=[...snapshot.logs,...restoredLogs];
    settings.cycleMinutes=snapshot.cycleMinutes;
    offlineRemoteStatuses=Object.fromEntries(snapshot.statuses.map(s=>[s.id,s]));
    // NAS snapshots are authoritative: ticker load events must match confirmed logs.
    confirmedLoadIds=new Set(snapshot.logs.map(log=>log.id));
    offlineProjectState();initialized=true;
    refreshNasLineNotificationDisplay();
    for(const [source,count] of [['trucks',snapshot.trucks.length],['status',snapshot.statuses.length],['logs',snapshot.logs.length],['shift',snapshot.shift?1:0]])markSync(source,false,false,count);
    markSync('nas',false,false,snapshot.logs.length);
    // Кеш и перерисовку обновляем только при реальных изменениях линии.
    if(!lineChanged)return true;
    saveCache();renderAll();return true;
  }
  // Разовое пробуждение после смены сети (VPN, Wi-Fi <-> мобильная) или
  // возврата во вкладку. Один короткий запрос probe(); при успехе сбрасываем
  // флаг «Работа локально», сразу читаем линию и отправляем накопленную
  // очередь. Отдельного цикла нет — только существующая подписка.
  async function nasNetworkWake(epoch,client,{force=false}={}){
    if(!client||epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||nasWakeInFlight)return;
    if(typeof navigator!=='undefined'&&!navigator.onLine)return;
    const now=Date.now();
    if(!force&&now-nasWakeAt<2500)return;
    nasWakeAt=now;nasWakeInFlight=true;
    const live=()=>epoch===nasRuntimeEpoch&&client===nasRuntimeClient;
    try{
      // Зависшие чтения прошлого соединения не должны перекрывать проверку.
      nasDropHungReads();
      try{nasRuntimeClient?.abortInflight?.();}catch(_){}
      // Probe идёт отдельным запросом: зависшие фоновые чтения его не держат.
      let probeOk=false;
      try{if(typeof client.probe==='function')await client.probe(15000);else await client.readSession();probeOk=true;}catch(_){probeOk=false;}
      // Результат пробы питает единый супервизор связи: восстановление
      // подтверждается сразу, а не по 15-с таймауту его цикла.
      if(probeOk)nasConnection?.reportSuccess?.();else nasConnection?.reportFailure?.('transport');
      if(!probeOk)return;
      if(!live())return;
      offlineTransportRecovered();
      // Связь подтверждена: ошибки источников читаем заново без задержки.
      nasSyncApi()?.reset?.(nasSyncRetry);
      nasResumePolling?.();
      await nasRefreshLine().catch(()=>{});
      if(live())void replayNasOfflineJournal().catch(()=>{});
    }catch(_){
      // Краткий обрыв связи: подписка повторит попытку сама. Без уведомлений.
    }finally{nasWakeInFlight=false;}
  }
  function nasActivityApi(){return typeof WorkingTestNasActivity!=='undefined'?WorkingTestNasActivity:null;}
  // Единый канал восстановления связи (1.7.10): состояние одно на всё
  // приложение, повторы — только здесь. Пока супервизор считает связь
  // потерянной, каналы не шлют собственных повторов.
  let nasConnection=null;
  function nasConnectionOnline(){return !nasConnection||nasConnection.snapshot().online;}
  function nasConnectionStop(){try{nasConnection?.stop?.();}catch(_){}nasConnection=null;}
  // «Сердце» связи: любой успешный ответ канала подтверждает связь, любая
  // транспортная ошибка любого канала — единственный сигнал потери.
  // Вызывается из markSync/reportSyncError (03-formatting.js).
  function nasConnectionHeart(ok,error){
    if(!nasConnection)return;
    try{
      if(ok)nasConnection.reportSuccess();
      else nasConnection.reportFailure(error?.name==='TypeError'||!navigator?.onLine?'browser-offline':'transport');
    }catch(_){}
  }
  function nasStartConnection(client,epoch){
    const api=typeof WorkingTestNasConnection!=='undefined'?WorkingTestNasConnection:null;
    if(!api)return;
    nasConnectionStop();
    nasConnection=api.create({
      probe:async()=>{
        if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Сеанс изменился');
        // Проба — лёгкий GET /api/v1/session с 15-с таймаутом.
        if(typeof client.probe==='function')return await client.probe(15000);
        return await client.readSession();
      },
      log:text=>{console.log(text);},
      emit:(kind,detail)=>{
        try{window.dispatchEvent(new CustomEvent('samosval-working-test-connection',{detail:{kind,...detail}}));}catch(_){}
        if(kind==='offline'){
          // Одно сообщение на переход, а не по одному на каждый канал.
          showToastEl('📴 Нет связи с сервером, переподключаюсь…',true);
        }else if(kind==='online'){
          showToastEl('✅ Связь восстановлена',false);
          // Один общий цикл перечитывания: линия первой (урок 1.6.0).
          nasDropHungReads();
          nasSyncApi()?.reset?.(nasSyncRetry);
          nasResumePolling?.();
          void nasRefreshLine().catch(()=>{}).then(()=>{
            if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)return;
            const reads=[refreshNasObjects,refreshNasSettings,refreshNasAuxiliary,refreshNasGames];
            if(hasTabAccess('archive')||hasTabAccess('analytics'))reads.push(refreshNasArchive);
            if(canAdmin())reads.push(refreshNasAdministration);
            return Promise.allSettled(reads.map(read=>{try{return Promise.resolve(read());}catch(_){return Promise.resolve();}}));
          }).then(()=>{if(epoch===nasRuntimeEpoch&&client===nasRuntimeClient)void replayNasOfflineJournal().catch(()=>{});});
        }
        try{updateSyncUI();}catch(_){}
      }
    });
  }
  // Быстрая проверка связи при возврате из фона: лёгкий probe() прерывает
  // мёртвые сокеты (abortInflight) и снимает «Работа локально» за секунды,
  // не дожидаясь полной серии nasActiveRefresh и её reads.
  function nasFastLinkCheck(epoch,client){
    if(!client||epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)return;
    if(typeof navigator!=='undefined'&&navigator.onLine===false)return;
    if(typeof document!=='undefined'&&document.hidden)return;
    try{client.abortInflight?.();}catch(_){}
    Promise.resolve(client.probe()).then(()=>{if(epoch===nasRuntimeEpoch&&client===nasRuntimeClient){offlineTransportRecovered();nasConnection?.reportSuccess?.();}},()=>{if(epoch===nasRuntimeEpoch&&client===nasRuntimeClient)nasConnection?.reportFailure?.('transport');});
  }
  function nasActivityGateState(){if(!nasActivityGate){const api=nasActivityApi();nasActivityGate=api?api.createGate({minGap:4000}):{lastAt:0,minGap:4000,pending:false};}return nasActivityGate;}
  // Приложение активно на экране: вкладка видима и сеть есть.
  function nasScreenActive(){if(typeof document!=='undefined'&&document.hidden)return false;if(typeof navigator!=='undefined'&&navigator.onLine===false)return false;return true;}
  // Полное обновление всех данных, пока приложение активно. Ничего не экономим:
  // линия, справочники, игры, настройки, архив и админка перечитываются при
  // каждом возврате на экран и по таймеру. Порядок важен: линия первой, потому
  // что она поднимает поколение чтений и отменяет устаревшие ответы.
  async function nasActiveRefresh(reason,{force=true}={}){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||epoch!==nasRuntimeEpoch||currentUserStatus!=='active')return false;
    if(!nasScreenActive())return false;
    // Периодический опрос не идёт, пока супервизор считает связь потерянной:
    // он сам перечитает все источники после первой успешной пробы.
    if(reason==='poll'&&!nasConnectionOnline())return false;
    // Оффлайн по решению супервизора: не шлём новые запросы каналов до
    // восстановления пробы. Исключение — браузер сообщил «сеть вернулась»:
    // это и есть сигнал для пробуждения.
    if(reason!=='online'&&!nasConnectionOnline())return false;
    const api=nasActivityApi(),gate=nasActivityGateState();
    const allowed=api?api.allow(gate,Date.now(),force):true;
    if(!allowed){nasActivityPending=true;return false;}
    if(nasActivityInFlight){nasActivityPending=true;return false;}
    nasActivityInFlight=true;
    const live=()=>epoch===nasRuntimeEpoch&&client===nasRuntimeClient&&currentUserStatus==='active'&&nasScreenActive();
    try{
      if(reason==='poll'){
        // Периодический опрос не рвёт текущие запросы пользователя и не
        // перезапускает подписку: перечитываем линию и остальные источники.
        await nasRefreshLine().catch(()=>{});
      }else{
        // Возврат на экран: полный путь пробуждения — проверка связи,
        // подписка и линия.
        await nasNetworkWake(epoch,client,{force:true});
      }
      if(!live())return false;
      // Бэкофф надзирателя (26-nas-resume) уважается и здесь: источник, чья
      // последняя ошибка моложе текущей паузы повтора, не перечитывается
      // этим циклом — его повторит надзиратель по расписанию. Раньше 15-с
      // цикл и надзиратель конкурировали, и ретраи шли в 2–3 раза чаще
      // номинала.
      const resume=nasSyncApi(),syncErrors=(typeof syncState!=='undefined'&&syncState.errors)||{};
      const reads=[['nas-objects',refreshNasObjects],['nas-settings',refreshNasSettings],['nas-auxiliary',refreshNasAuxiliary],['nas-games',refreshNasGames]];
      if(hasTabAccess('archive')||hasTabAccess('analytics'))reads.push(['nas-archive',refreshNasArchive]);
      if(canAdmin())reads.push(['nas-admin',refreshNasAdministration]);
      await Promise.allSettled(reads.map(([source,read])=>{
        if(resume&&syncErrors[source]&&!resume.due(nasSyncRetry,source,Date.now()))return Promise.resolve();
        try{return Promise.resolve(read());}catch(error){return Promise.reject(error);}
      }));
      if(live())void replayNasOfflineJournal().catch(()=>{});
      return true;
    }catch(_){return false;}
    finally{nasActivityInFlight=false;
      if(nasActivityPending){nasActivityPending=false;setTimeout(()=>{void nasActiveRefresh('pending',{force:false});},0);}}
  }
  // Ключ ошибки источника → повторное чтение. Успешное чтение само снимает
  // ошибку через markSync, поэтому отдельной очистки здесь не нужно.
  function nasSyncSources(){
    return {'nas':nasRefreshLine,'nas-objects':refreshNasObjects,'nas-games':refreshNasGames,
      'nas-auxiliary':refreshNasAuxiliary,'nas-archive':refreshNasArchive,
      'nas-settings':refreshNasSettings,'nas-admin':refreshNasAdministration};
  }
  // Надзиратель: повторяет чтение только упавших источников с нарастающей
  // паузой. Ничего не делает, когда приложение свёрнуто, сети нет или связь
  // потеряна по решению единого супервизора (повторы делает только он).
  function nasSyncSupervisorTick(){
    if(typeof document!=='undefined'&&document.hidden)return;
    if(typeof navigator!=='undefined'&&!navigator.onLine)return;
    if(!nasConnectionOnline())return;
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||epoch!==nasRuntimeEpoch||currentUserStatus!=='active')return;
    const resume=nasSyncApi();if(!resume)return;
    const errors=(typeof syncState!=='undefined'&&syncState.errors)||{},sources=nasSyncSources(),now=Date.now();
    for(const source of Object.keys(errors)){
      const read=sources[source];if(typeof read!=='function')continue;
      if(!resume.due(nasSyncRetry,source,now))continue;
      let pending;
      try{pending=read();}catch(_){resume.recordFailure(nasSyncRetry,source,now);continue;}
      Promise.resolve(pending).then(()=>{resume.recordSuccess(nasSyncRetry,source);},
        ()=>{resume.recordFailure(nasSyncRetry,source,Date.now());});
    }
    // Долгая тишина в подписке: поднимаем её и проверяем связь принудительно.
    if(now-nasLastSessionAt>20000&&!nasWakeInFlight){nasLastSessionAt=now;nasResumePolling?.();void nasNetworkWake(epoch,client,{force:true});}
  }
  // Мост параллельных смен v2: сервер v2 ↔ store контекстов (задача 13).
  // Каждый ответ несёт generation-токен, поэтому поздний ответ не публикуется и
  // не меняет выбранную смену. Мост работает только при включённом флаге
  // WORKING_TEST_V2_SHIFTS; в канале он включён по умолчанию в shell.html
  // (решение владельца 28.11.2026 — проверяем новую линию смен). Стенд может
  // выключить его через window.WORKING_TEST_V2_SHIFTS=false: тогда v1-рантайм
  // работает как раньше.
  function nasV2ShiftsEnabled(){
    return typeof WORKING_TEST_V2_SHIFTS!=='undefined'&&WORKING_TEST_V2_SHIFTS===true;
  }
  function nasV2Shifts(){return nasV2Bridge;}
  // Кто владеет линией. Пока v2-мост жив, v1-снимок линии спрашивать нельзя:
  // при двух открытых сменах сервер честно отвечает 409 multiple-active-shifts,
  // и каждый такой отказ — лишний запрос и шум в консоли каждые 4 секунды.
  // Без живого моста (старый сервер, выключенный флаг) работает прежний путь.
  function nasLegacyLineReadAllowed(){
    if(!nasV2ShiftsEnabled())return true;
    // v2 включён и мост поднят — линия его. Отказ сервера «маршрута нет»
    // возвращает прежний путь, чтобы канал не остался без линии вовсе.
    if(nasV2BridgeActive&&!nasV2Unsupported)return false;
    return !nasV2BridgeLive&&!nasV2LineRefused;
  }
  function nasStopV2Shifts(){
    try{nasV2Bridge?.handle?.close?.();}catch(_){}
    nasV2Bridge=null;nasV2BridgeErrorLogged=false;nasV2BridgeLive=false;nasV2LineRefused=false;
    nasV2BridgeActive=false;nasV2Unsupported=false;
    nasRestoredV1=[];nasRestoredContexts=[];nasRestoredRead=null;nasRestoredReadAt=0;
  }

  // === Восстановленные архивные смены (v2, design §5.6, §10.1) ===
  // Старый сервер отдаёт restored-смены в v1-снапшоте (`shifts` +
  // `payload.restored`). На канонической схеме их место — restored_shift_contexts:
  // клиент читает их через GET /api/v2/archives/{id}/restored и правит через
  // POST /api/v2/archives/{id}/operations. Карточка и рейсы выглядят как в
  // 1.8.3, но в active-таблицы (shifts, line_logs, line_truck_statuses) этот
  // путь не пишет ничего.
  let nasRestoredV1 = [];          // restored-смены из v1-снапшота (старый сервер)
  let nasRestoredContexts = [];    // [{card}] открытые v2-контексты
  let nasRestoredRead = null;
  let nasRestoredReadAt = 0;

  function nasRestoredArchiveApi(){
    return typeof WorkingTestArchiveRestoredV2!=='undefined'?WorkingTestArchiveRestoredV2:null;
  }
  function nasRestoredArchiveTransport(){
    const transport=nasV2Shifts()?.transport;
    if(!transport||typeof transport.readRestoredArchive!=='function'||typeof transport.submitArchiveV2!=='function')return null;
    return transport;
  }
  // v2-путь восстановления доступен только при живом мосте. Без него остаётся
  // прежний честный отказ, а не «похожий» локальный контекст (урок 63).
  function nasRestoredV2Ready(){return !!(nasRestoredArchiveApi()&&nasRestoredArchiveTransport());}

  function nasRestoredCards(){
    return nasRestoredContexts.map(entry=>{
      const card=entry.card;
      // Опубликованный (finalized) контекст неприкосновенен: карточка остаётся,
      // но правки и возврат в архив недоступны.
      const readOnly=card.context.contextState!=='open';
      const logs=(card.logs||[]).map(log=>log.restoredReadOnly===readOnly?log:{...log,restoredReadOnly:readOnly});
      return {...card,readOnly,logs};
    });
  }
  function nasRestoredShiftsCombined(){
    const v2=nasRestoredCards();
    const ids=new Set(v2.map(card=>card.shift.id));
    return [...nasRestoredV1.filter(row=>row?.shift&&!ids.has(row.shift.id)),...v2];
  }
  function nasRestoredContextForShift(shiftId){
    return nasRestoredContexts.find(entry=>entry.card.shift.id===shiftId)||null;
  }
  function nasRestoredContextForLog(logId){
    if(!logId)return null;
    for(const entry of nasRestoredContexts){
      const log=(entry.card.logs||[]).find(row=>row.id===logId);
      if(log)return {context:entry,log};
    }
    return null;
  }
  // Единая публикация восстановленных смен: карточка в отчёте и рейсы в журнале.
  // Рейсы кладутся в offlineRemoteLogs, иначе offlineProjectState затрёт их
  // своим срезом (как и для v1-снапшота).
  function nasApplyRestoredShifts(){
    state.restoredShifts=nasRestoredShiftsCombined();
    const restoredIds=new Set(state.restoredShifts.map(row=>row?.shift?.id).filter(Boolean));
    const baseLogs=(Array.isArray(offlineRemoteLogs)?offlineRemoteLogs:[]).filter(log=>!restoredIds.has(log.shiftId));
    offlineRemoteLogs=[...baseLogs,...state.restoredShifts.flatMap(row=>row.logs||[])];
    offlineProjectState();saveCache();renderAll();
  }
  // Карточки переживают перезагрузку: они лежат в кэше сессии (saveCache), а
  // сервер перечитывается, как только мост готов.
  function nasSeedRestoredContexts(){
    // Без живого v2-моста кэш не поднимаем: карточка без маршрута правок
    // выглядела бы рабочей, а любая правка упиралась бы в отказ (урок 69).
    if(!nasRestoredV2Ready())return;
    const cached=(state.restoredShifts||[]).filter(row=>row&&row.context&&row.shift&&row.shift.restoredContextId);
    if(!cached.length)return;
    const known=new Set(nasRestoredContexts.map(entry=>entry.card.shift.id));
    for(const card of cached){
      if(known.has(card.shift.id))continue;
      nasRestoredContexts.push({card:{...card,readOnly:card.context.contextState!=='open'}});
      known.add(card.shift.id);
    }
  }

  // GET /api/v2/archives/{id}/restored идемпотентен: повторное открытие
  // возвращает уже открытый контекст с его собственной базовой ревизией.
  // Большие архивы листаются курсором, чтобы карточка не потеряла рейсы.
  async function nasReadRestoredContext(archiveId){
    const api=nasRestoredArchiveApi(),transport=nasRestoredArchiveTransport();
    if(!api||!transport)return {ok:false,error:{code:'v2-unavailable',status:0}};
    const pages=[];let cursor=null;
    for(let page=0;page<20;page++){
      const response=await transport.readRestoredArchive({archiveId,limit:200,...(cursor?{cursor}:{})});
      if(!response||response.ok!==true)return {ok:false,error:response?.error||{code:'invalid-api-response',status:0}};
      const normalized=api.normalizeContext(response.data);
      if(!normalized.ok)return {ok:false,error:{code:'invalid-api-response',status:0}};
      pages.push(normalized.view);
      const next=normalized.view.tripsPage?.nextCursor;
      if(normalized.view.tripsPage?.hasMore!==true||!next)break;
      cursor=next;
    }
    if(!pages.length)return {ok:false,error:{code:'invalid-api-response',status:0}};
    const merged=pages.length===1?pages[0]:{...pages[0],trips:pages.flatMap(view=>view.trips),
      tripsPage:{...pages[0].tripsPage,hasMore:false,nextCursor:null}};
    const card=api.cardOf(merged);
    const index=nasRestoredContexts.findIndex(entry=>entry.card.shift.id===card.shift.id);
    const entry={card};
    if(index>=0)nasRestoredContexts[index]=entry;else nasRestoredContexts.push(entry);
    return {ok:true,context:entry,card};
  }
  // Фоновое перечитывание открытых контекстов: ошибка не стирает карточку, а
  // правка сама перечитает контекст при CAS-конфликте.
  async function nasRefreshRestoredContexts(options){
    const force=options?.force===true;
    if(!nasRestoredV2Ready()||!nasRestoredContexts.length)return {ok:false,count:0};
    const now=Date.now();
    if(!force&&now-nasRestoredReadAt<30000)return {ok:true,count:nasRestoredContexts.length};
    if(nasRestoredRead)return nasRestoredRead;
    nasRestoredReadAt=now;
    const work=(async()=>{
      let ok=0;
      for(const entry of nasRestoredContexts.slice()){
        const result=await nasReadRestoredContext(entry.card.context.archiveId);
        if(result.ok)ok+=1;
      }
      if(ok)nasApplyRestoredShifts();
      return {ok:ok>0,count:ok};
    })();
    nasRestoredRead=work;
    try{return await work;}finally{if(nasRestoredRead===work)nasRestoredRead=null;}
  }
  function nasRestoredOperationId(){
    if(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function')return 'restored_'+crypto.randomUUID().replaceAll('-','');
    return 'restored_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,12);
  }
  function nasRestoredFieldText(code){
    if(code==='invalid-volume')return 'Проверьте объём: от 0 до 1000 м³';
    if(code==='invalid-time')return 'Проверьте время: формат ЧЧ:ММ';
    if(code==='invalid-ttn')return 'Проверьте отметку ТТН';
    if(code==='invalid-comment')return 'Комментарий слишком длинный';
    return 'Проверьте поля правки восстановленной смены';
  }
  // Правка рейса/ТТН архивной смены. CAS берётся из фактически прочитанного
  // контекста; operationId фиксируется ДО первого запроса, поэтому повтор после
  // конфликта не создаёт вторую операцию на сервере.
  async function nasRestoredCorrect(entry,command){
    const api=nasRestoredArchiveApi(),transport=nasRestoredArchiveTransport();
    if(!api||!transport)throw Error('Сервер не поддерживает правку восстановленной смены: обновите приложение.');
    if(entry.card.context.contextState!=='open')throw Error(api.FINALIZED_NOTICE);
    const operationId=nasRestoredOperationId();
    const build=()=>api.commandFor(entry.card,{...command,operationId});
    let prepared=build();
    if(!prepared.ok)throw Error(nasRestoredFieldText(prepared.code));
    let response=await transport.submitArchiveV2(prepared.input);
    if(response?.ok!==true&&response?.error?.code==='archive-changed'){
      const fresh=await nasReadRestoredContext(entry.card.context.archiveId);
      if(fresh.ok){
        entry=fresh.context;
        prepared=build();
        if(prepared.ok)response=await transport.submitArchiveV2(prepared.input);
      }
    }
    if(response?.ok!==true){
      const code=response?.error?.code,status=response?.error?.status;
      const error=Error(api.correctionText(code,status));
      error.serverCode=code;error.status=status;throw error;
    }
    // Конверт команды (`41-v2-transport.js` → `command`) плоский:
    // `{ok,operationId,replayed,retried,result}`. Чтение `response.data.result`
    // давало undefined, и правка молча «применялась» к пустому объекту: HTTP 200,
    // ноль изменений на экране (нашёл стенд 393×852). Отсутствие результата —
    // ошибка, а не повод сделать вид, что всё сохранилось.
    const result=response.result;
    if(!result||typeof result!=='object'||Array.isArray(result)){
      const error=Error(api.correctionText('invalid-api-response',0));
      error.serverCode='invalid-api-response';
      throw error;
    }
    entry.card=api.applyResult(entry.card,result);
    nasApplyRestoredShifts();
    return result;
  }
  async function nasRestoredTripUpdate(found,data){
    const fields=data||{};
    return nasRestoredCorrect(found.context,{type:'trip.update',recordId:found.log.id,
      fields:{volume:Number(fields.volume),timeStr:String(fields.timeStr||''),
        comment:typeof fields.comment==='string'?fields.comment:''}});
  }
  async function nasRestoredTripDelete(found){
    return nasRestoredCorrect(found.context,{type:'trip.delete',recordId:found.log.id});
  }
  async function nasRestoredTtnChange(shiftId,truckId,status){
    const entry=nasRestoredContextForShift(shiftId);
    if(!entry)throw Error('Восстановленная смена не найдена: обновите страницу.');
    return nasRestoredCorrect(entry,status===null
      ?{type:'ttn.delete',recordId:truckId}
      :{type:'ttn.update',recordId:truckId,fields:{ttnStatus:status}});
  }
  // Кнопка в карточке восстановленной смены: отметка ТТН архивного рейса.
  async function markRestoredTtn(shiftId,truckId,status){
    try{await nasRestoredTtnChange(shiftId,truckId,status);showToastEl(status===null?'↩️ Отметка ТТН снята':'📄 ТТН отмечена',false);}
    catch(error){showError(error.message);}
  }
  // Восстановление архивной смены через v2. Возвращает карточку и ничего не
  // пишет в active-таблицы: контекст правок — отдельное хранилище.
  async function nasRestoreArchivedShift(archiveId){
    const api=nasRestoredArchiveApi();
    const result=await nasReadRestoredContext(archiveId);
    if(!result.ok){
      const code=result.error?.code,status=result.error?.status;
      const error=Error(api?api.refusalFor(code,status).text:'Не удалось восстановить архивную смену');
      error.serverCode=code;error.status=status;throw error;
    }
    nasApplyRestoredShifts();
    return result;
  }
  function nasRestoredRefusalText(code,status){
    const api=nasRestoredArchiveApi();
    return api?api.refusalFor(code,status).text:null;
  }
  // Текст для «Вернуть в архив»: null значит «это не v2-контекст», и работает
  // прежний путь закрытия восстановленной смены (старый сервер).
  function nasRestoredFinalizeText(shiftId){
    const api=nasRestoredArchiveApi();
    const entry=nasRestoredContextForShift(shiftId);
    if(!entry)return null;
    return api?api.finalizeText(entry.card):null;
  }
  // Флаг включён в канале по умолчанию (shell.html), поэтому мост поднимается
  // и там, где сервер v2 ещё не отвечает (старый сервер, нет маршрутов, связь
  // пропала). Сбой дополнительной подсистемы не должен красить общий индикатор
  // «Ошибка загрузки: nas-shifts»: пока мост ни разу не отдал данные, экран
  // живёт на v1 и работает как раньше, а причина остаётся в консоли.
  function nasV2BridgeError(store,error){
    // 404/405/426/501 — сервер этого канала ещё не знает v2-маршрутов.
    // Это не сбой связи: линию честно продолжает вести v1, как до перехода.
    const status=Number(error?.status)||0;
    if(status===404||status===405||status===426||status===501)nasV2Unsupported=true;
    let rows=null;
    try{rows=store?.visibleShifts?.();}catch(_){rows=null;}
    if(!Array.isArray(rows)||rows.length===0){
      if(!nasV2BridgeErrorLogged){nasV2BridgeErrorLogged=true;console.warn('[sync:nas-shifts]',error);}
      return;
    }
    reportSyncError('nas-shifts',error);
  }
  // Успешный ответ моста снимает накопленную ошибку: иначе один сбой связи
  // оставлял «Перечитываем: nas-shifts» навсегда, потому что v1-источники
  // снимают только свои записи в syncState.errors.
  function nasV2BridgeSynced(store){
    nasV2BridgeErrorLogged=false;nasV2BridgeLive=true;
    try{
      if(typeof syncState==='undefined'||!syncState||!syncState.errors||!syncState.errors['nas-shifts'])return;
      if(typeof markSync!=='function')return;
      const rows=store?.visibleShifts?.();
      markSync('nas-shifts',false,false,Array.isArray(rows)?rows.length:0);
    }catch(_){}
  }
  function nasStartV2Shifts(epoch,client){
    nasStopV2Shifts();
    if(!nasV2ShiftsEnabled())return null;
    if(typeof WorkingTestV2Transport==='undefined'||typeof WorkingTestShiftContexts==='undefined')return null;
    if(typeof client?.requestV2!=='function')return null;
    let storage=null;try{storage=localStorage;}catch(_){}
    const store=WorkingTestShiftContexts.createShiftContextStore({uid:client.uid,workspaceId:client.workspaceId,storage});
    const transport=WorkingTestV2Transport.createV2Transport({
      request:(path,options)=>client.requestV2({method:options?.method,path,body:options?.operation,validate:options?.validate}),
      uid:client.uid,workspaceId:client.workspaceId,store
    });
    const live=()=>epoch===nasRuntimeEpoch&&client===nasRuntimeClient;
    const handle=transport.subscribeShifts({
      intervalMs:4000,
      onList:list=>{if(!live())return;
        nasV2BridgeSynced(store);
        try{window.dispatchEvent(new CustomEvent('samosval-working-test-shifts',{detail:{generation:list.listGeneration,items:list.items,nextCursor:list.nextCursor}}));}catch(_){}
      },
      onSnapshot:result=>{if(!live())return;
        nasV2BridgeSynced(store);
        if(result?.applied===true&&result?.visible===true){
          const context=store.visibleContext?.();
          const snapshot=context?.snapshot;
          if(snapshot&&context.shiftId===result.shiftId){
            const logs=Array.isArray(snapshot.logs)?snapshot.logs:[];
            const statuses=Array.isArray(snapshot.statuses)?snapshot.statuses:[];
            for(const [source,count] of [['shift',context.shift?1:0],['status',statuses.length],['logs',logs.length]])markSync(source,false,false,count);
            // V2-снимок — авторитетная линия, когда legacy single-line API
            // закономерно отвечает multiple-active-shifts. Он подтверждает
            // начальную загрузку и очищает ошибки старого чтения: без этого
            // шапка навсегда оставалась «Загрузка данных и прав…», а любая
            // случайная ошибка — неснимаемой плашкой «Ошибка загрузки: nas».
            markSync('nas',false,false,logs.length);
            initialized=true;
          }
        }
        try{window.dispatchEvent(new CustomEvent('samosval-working-test-shift-snapshot',{detail:{generation:result.generation,shiftId:result.shiftId,revision:result.revision,applied:result.applied,visible:result.visible}}));}catch(_){}
      },
      onError:error=>{if(!live())return;nasV2BridgeError(store,error);}
    });
    nasV2Bridge={store,transport,handle,epoch};
    nasV2BridgeActive=true;
    return nasV2Bridge;
  }
  async function startNasRuntime(user) {
    const epoch=nasRuntimeEpoch;
    // Nothing is server-confirmed until the first NAS session arrives.
    profileServerConfirmed=false;permissionsServerConfirmed=false;
    try{
      const {createNasClient}=await loadNasSessionClient();
      if(epoch!==nasRuntimeEpoch||wtAuthUser()!==user||currentUid!==user.uid)return;
      const client=createNasClient({baseUrl: nasApiBase(), getUser:()=>wtAuthUser(),workspaceId:WORKSPACE_ID,timeoutMs:15000});nasRuntimeClient=client;
      nasStartConnection(client,epoch);
      nasStartV2Shifts(epoch,client);
      // Карточки восстановленных смен переживают перезагрузку: они лежат в
      // кэше сессии, а сервер перечитывается, как только мост готов.
      nasSeedRestoredContexts();
      // Pulse: proves this phone is alive and tells the servers how many phones
      // still see the primary. Failover needs many phones, not one.
      const pulse=()=>{if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||!navigator.onLine)return;if(typeof client.writeAuthorityPresence!=='function')return;try{client.writeAuthorityPresence({}).catch(()=>{});}catch(_){}};
      if(nasPresenceTimer&&typeof clearInterval==='function')clearInterval(nasPresenceTimer);
      nasPresenceTimer=typeof setInterval==='function'?setInterval(pulse,30000):null;pulse();
      for(const name of ['plugins','patches','audit','notifications'])refs[name]=nasAuxCollection(name,client,epoch);
      let registering=false;
      nasResumePolling=()=>{if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||nasPollHolds)return;nasRuntimeStop?.();nasRuntimeStop=client.subscribeLine({
        lineEnabled:nasLegacyLineReadAllowed,
        onSession:session=>{if(epoch!==nasRuntimeEpoch)return;
          // Отмечаем живой ответ сервера: по этой метке надзиратель понимает,
          // что подписка молчит слишком долго.
          nasLastSessionAt=Date.now();
          // Любой успешный ответ сервера доказывает, что связь есть: снимаем
          // «Работа локально» и накопленный бэкофф повтора очереди.
          offlineTransportRecovered();applyNasSession(session);
          if(session.profile?.status==='active'&&!session.profile.deleted)void refreshNasSettings().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-settings',error);});
          if(session.profile?.status==='active'&&!session.profile.deleted)void refreshNasGames().catch(error=>{if(epoch===nasRuntimeEpoch)nasGameReadError(error);});
          if(session.profile?.status==='active'&&!session.profile.deleted)void refreshNasAuxiliary().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-auxiliary',error);});
          if(session.profile?.status==='active'&&(hasTabAccess('archive')||hasTabAccess('analytics')))void refreshNasArchive().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-archive',error);});
          if(session.identityReady&&!session.profile&&!registering){registering=true;void ensureNasPendingAccount(user).catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-registration',error);}).finally(()=>{registering=false;});}
          if(session.profile?.status==='active'&&(session.permissions.tabs.includes('line')||session.permissions.tabs.includes('trucks')||session.permissions.tabs.includes('timesheet')))void refreshNasObjects().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-objects',error);});
          if(canAdmin())void refreshNasAdministration().catch(error=>{if(epoch===nasRuntimeEpoch)reportSyncError('nas-admin',error);});},
        onSnapshot:snapshot=>{if(epoch!==nasRuntimeEpoch)return;acceptNasLineSnapshot(snapshot);void replayNasOfflineJournal().catch(()=>{});},
        onError:error=>{if(epoch!==nasRuntimeEpoch)return;
          // Пока открыты две смены, legacy-чтение линии отвечает 409
          // `multiple-active-shifts`: линия одна по контракту v1, и выбрать
          // владельца сервер не имеет права. Линию в этом режиме ведёт v2-мост,
          // поэтому постоянная плашка «Перечитываем: nas» была бы ложью о сбое.
          // Без моста (старый клиент) отказ остаётся видимым: там он настоящий.
          if(nasV2Shifts()&&(error?.serverCode||error?.code)==='multiple-active-shifts'){nasV2LineRefused=true;return;}
          reportSyncError('nas',error);}
      });};nasResumePolling();
      // Отсчёт тишины подписки начинается сразу: иначе до первого сеанса
      // надзиратель каждые 2,5 секунды заново перезапускал бы подписку.
      nasLastSessionAt=Date.now();
      // Открытые контексты восстановленных смен перечитываются один раз при
      // старте: GET идемпотентен и отдаёт уже открытый контекст.
      if(nasRestoredContexts.length)void nasRefreshRestoredContexts({force:true}).catch(()=>{});
      // Надзиратель повторов: раз в 2,5 секунды проверяет, не застряла ли
      // подписка и не остались ли ошибки источников без повторного чтения.
      if(nasSyncTimer&&typeof clearInterval==='function')clearInterval(nasSyncTimer);
      nasSyncTimer=typeof setInterval==='function'?setInterval(nasSyncSupervisorTick,2500):null;
      // После смены сети браузер часто НЕ присылает 'online', а старые сокеты
      // висят до собственного таймаута. Любой возврат на экран — это полное
      // обновление данных: видимость, фокус, сеть, pageshow, разблокировка.
      nasWakeStop?.();
      const wakeOnline=()=>{if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||!navigator.onLine)return;
        nasResumePolling?.();void nasActiveRefresh('online',{force:true});};
      const wakeVisible=()=>{if(typeof document!=='undefined'&&document.visibilityState==='hidden'){nasHiddenAt=Date.now();return;}
        nasDropHungReads();nasFastLinkCheck(epoch,client);void nasActiveRefresh('visibilitychange',{force:true});};
      const wakeFocus=()=>{nasDropHungReads();void nasActiveRefresh('focus',{force:true});};
      // Возврат из кэша браузера (bfcache): страница «оживает» без перезагрузки.
      const wakePageShow=event=>{const persisted=!!(event&&event.persisted);if(!persisted&&!nasHiddenAt)return;
        nasDropHungReads();nasFastLinkCheck(epoch,client);void nasActiveRefresh('pageshow',{force:true});};
      // Разблокировка экрана телефона и выход из фона в мобильной оболочке.
      // Page Lifecycle API отправляет freeze/resume на document, а НЕ на window:
      // без document-слушателя разблокировка экрана в PWA не будила приложение,
      // и данные после пробуждения не обновлялись.
      const wakeResume=()=>{nasDropHungReads();nasFastLinkCheck(epoch,client);void nasActiveRefresh('resume',{force:true});};
      const wakeFreeze=()=>{nasHiddenAt=Date.now();};
      if(typeof window!=='undefined'&&typeof window.addEventListener==='function'){
        window.addEventListener('online',wakeOnline);window.addEventListener('focus',wakeFocus);
        window.addEventListener('pageshow',wakePageShow);window.addEventListener('resume',wakeResume);
        if(typeof document!=='undefined'&&typeof document.addEventListener==='function'){
          document.addEventListener('visibilitychange',wakeVisible);
          document.addEventListener('resume',wakeResume);
          document.addEventListener('freeze',wakeFreeze);
        }
        nasWakeStop=()=>{window.removeEventListener('online',wakeOnline);window.removeEventListener('focus',wakeFocus);
          window.removeEventListener('pageshow',wakePageShow);window.removeEventListener('resume',wakeResume);
          if(typeof document!=='undefined'&&typeof document.removeEventListener==='function'){
            document.removeEventListener('visibilitychange',wakeVisible);
            document.removeEventListener('resume',wakeResume);
            document.removeEventListener('freeze',wakeFreeze);
          }nasWakeStop=null;};
      }
      // Пока приложение активно на экране — обновляем всё каждые 15 секунд.
      if(nasActivityTimer&&typeof clearInterval==='function')clearInterval(nasActivityTimer);
      // Страховка: в фоне/на заблокированном экране таймеры замирают, а события
      // пробуждения могут не прийти. Разрыв между тиками больше двух интервалов
      // (30 с) означает, что приложение спало — обновляем всё принудительно.
      let nasActivityTickAt=Date.now();
      nasActivityTimer=typeof setInterval==='function'?setInterval(()=>{const now=Date.now(),gap=now-nasActivityTickAt;nasActivityTickAt=now;if(!nasScreenActive())return;void nasActiveRefresh(gap>45000?'resume':'poll',{force:gap>45000});},15000):null;
      // Если игровая книга не загрузилась при входе (сбой сети), без повтора
      // кнопки игр оставались вечно неактивными. Пробуем снова каждые 30 секунд.
      if(nasGamesTimer&&typeof clearInterval==='function')clearInterval(nasGamesTimer);
      nasGamesTimer=typeof setInterval==='function'?setInterval(()=>{if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||currentUserStatus!=='active'||nasGameReady)return;void refreshNasGames().catch(error=>{if(epoch===nasRuntimeEpoch)nasGameReadError(error);});},30000):null;
    }catch(error){if(epoch===nasRuntimeEpoch)reportSyncError('nas',error);}
  }
  function loadNasTabelRemote(){return import(new URL('./working-test/synology/tabel-remote.mjs',document.baseURI).href);}
  async function refreshNasAuxiliary(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=nasReadGeneration;if(!client||currentUserStatus!=='active')return;
    if(nasAuxRead)return nasAuxRead;
    const work=(async()=>{const snapshot=await client.readAuxiliary();if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||currentUserStatus!=='active'||generation!==nasReadGeneration)return;
      const pluginsChanged=JSON.stringify(state.plugins)!==JSON.stringify(snapshot.plugins),patchesChanged=JSON.stringify(state.patches)!==JSON.stringify(snapshot.patches);
      markSync('nas-auxiliary',false,false,1);nasAuxSnapshot=snapshot;state.plugins=snapshot.plugins;state.patches=snapshot.patches;state.audit=snapshot.audit.slice(0,200);state.lineAudit=snapshot.audit;
      state.notifications=snapshot.notifications;offlineProjectTicker();refreshNasLineNotificationDisplay();
      for(const key of ['plugins','patches','audit','notifications'])markSync(key,false,false,snapshot[key].length);
      if(pluginsChanged)initPlugins();if(patchesChanged){state.patches.sort((a,b)=>(a.order||0)-(b.order||0));if(!window.__nasPatchesApplied){window.__nasPatchesApplied=true;applyAllPatches();}}
      saveCache();renderStatusTicker();renderHeaderStats();if(canAdmin()){renderPluginsList();renderPatchesList();}
    })();nasAuxRead=work;try{return await work;}finally{if(nasAuxRead===work)nasAuxRead=null;}
  }
  function nasAuxCollection(name,client,epoch,filters=[],ordering=null,maximum=null){
    const guard=()=>{if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch||currentUid!==client.uid||currentUserStatus!=='active')throw Error('Сеанс Ubuntu изменился');};
    const document=id=>({id,ref:null,exists:true,data:()=>{const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id);if(!row)return undefined;const {id:_,revision,...data}=row;return data;}});
    const wrap=row=>{const snap=document(row.id);snap.ref=collection.doc(row.id);return snap;};
    const collection={
      doc:(id='record_'+crypto.randomUUID().replaceAll('-',''))=>({id,path:'workspaces/'+WORKSPACE_ID+'/'+name+'/'+id,
        get:async()=>{guard();await refreshNasAuxiliary();guard();const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id);return {id,exists:!!row,data:()=>{if(!row)return undefined;const {id:_,revision,...data}=row;return data;}};},
        set:async(data,options)=>{guard();if(!nasAuxSnapshot)await refreshNasAuxiliary();guard();const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id),{id:_,revision,...before}=row||{};
          await nasBusinessCommand('auxiliary',name+':'+id,{type:'auxiliary.save',collection:name,recordId:id,expectedRevision:row?.revision||0,data:options?.merge?{...before,...data}:data});guard();await refreshNasAuxiliary();},
        update:async data=>{guard();if(!nasAuxSnapshot)await refreshNasAuxiliary();guard();const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id);if(!row)throw Error('Запись уже отсутствует');return collection.doc(id).set(data,{merge:true});},
        delete:async()=>{guard();if(!nasAuxSnapshot)await refreshNasAuxiliary();guard();const row=nasAuxSnapshot?.[name]?.find(r=>r.id===id);if(!row)return;await nasBusinessCommand('auxiliary',name+':'+id,{type:'auxiliary.delete',collection:name,recordId:id,expectedRevision:row.revision});guard();await refreshNasAuxiliary();}}),
      add:async data=>{const ref=collection.doc();await ref.set(data);return ref;},
      where:(field,operator,value)=>nasAuxCollection(name,client,epoch,[...filters,[field,operator,value]],ordering,maximum),
      orderBy:(field,direction='asc')=>nasAuxCollection(name,client,epoch,filters,[field,direction],maximum),
      limit:n=>nasAuxCollection(name,client,epoch,filters,ordering,n),
      get:async()=>{guard();await refreshNasAuxiliary();guard();let rows=(nasAuxSnapshot?.[name]||[]).filter(row=>filters.every(([k,op,v])=>{if(op==='==')return row[k]===v;if(op==='>=')return row[k]>=v;if(op==='<')return row[k]<v;throw Error('Неподдерживаемый фильтр');}));
        if(ordering){const [k,d]=ordering;rows=rows.slice().sort((a,b)=>(a[k]>b[k]?1:a[k]<b[k]?-1:0)*(d==='desc'?-1:1));}if(maximum!==null)rows=rows.slice(0,maximum);const docs=rows.map(wrap);return {docs,size:docs.length,empty:!docs.length,forEach:fn=>docs.forEach(fn),metadata:{fromCache:false,hasPendingWrites:false}};}
    };return collection;
  }
  async function nasBackupRead(id){if(!canAdmin()||!nasRuntimeClient)throw Error('Требуется администратор Ubuntu');return nasRuntimeClient.readBackups(id);}
  async function nasBackupCommand(target,fields){return nasBusinessCommand('backup',target,fields);}
  async function nasReportAction(type,log,data){
    // Рейс восстановленной архивной смены живёт в restored_context_logs, а не в
    // line_logs активной линии: v1-команда report.* его не найдёт, а при
    // совпадении id адресовала бы чужую смену. Правка и удаление идут
    // v2-маршрутом архивного контекста с CAS из прочитанного контекста.
    const restored=nasRestoredContextForLog(log?.id);
    if(restored){
      if(type==='report.update')return nasRestoredTripUpdate(restored,data);
      if(type==='report.delete')return nasRestoredTripDelete(restored);
      throw Error('Для восстановленной архивной смены доступны правка и удаление рейса');
    }
    const expected={volume:log.volume,timestamp:log.timestamp,timeStr:log.timeStr,comment:log.comment||'',truckId:log.truckId,shiftId:log.shiftId};
    const result=await nasBusinessCommand('report',log.id,{type,logId:log.id,expected,...(data?{data}:{})});
    await nasRefreshLine();await Promise.allSettled([refreshNasGames(),refreshNasAuxiliary()]);return result;
  }
  async function nasHistoryAction(action,direction){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;if(!client)throw Error('Сеанс Ubuntu не загружен');
    const key='samosval_working_test_nas_history_v1:'+client.scope+':'+action.id+':'+direction;
    let op=JSON.parse(localStorage.getItem(key)||'null');if(!op){op={id:'history_'+crypto.randomUUID().replaceAll('-',''),actionId:action.id,direction,expectedRevision:action.revision};localStorage.setItem(key,JSON.stringify(op));}
    let result;try{result=await client.submitHistory(op,{operationScope:client.scope});}catch(error){if([400,409].includes(error.status)&&epoch===nasRuntimeEpoch)localStorage.removeItem(key);throw error;}if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Учётная запись изменилась');
    localStorage.removeItem(key);await nasRefreshLine();await Promise.allSettled([refreshNasGames(),refreshNasAuxiliary()]);return result;
  }
  window.addEventListener('load',()=>{
    if(!isNasRuntime())return;
    const oldUndo=window.undoLastAction;
    window.undoLastAction=async()=>{
      if(offlineLocalTicker())return undoLastOfflineAction();
      try{const snapshot=await nasRuntimeClient.readHistory(),last=lastValidNotification();const action=snapshot.items.find(x=>x.id===last?.actionId);if(!action?.canUndo)throw Error('Откройте журнал: это действие уже изменено или недоступно для отмены');if(await appConfirm('Отменить действие?'))await nasHistoryAction(action,'undo');}catch(error){showError(error.message);}
    };
  });
  function acceptNasSettings(snapshot){
    markSync('nas-settings',false,false,1);nasSettingsSnapshot=snapshot;appConfig={...snapshot.data};
    settings.cycleMinutes=snapshot.data.cycleMinutes;renderAppSettingsIfActive();window.__gameConfigChanged?.();
    window.dispatchEvent(new Event('review-flags-changed'));
  }
  async function refreshNasSettings(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=nasReadGeneration;if(!client||currentUserStatus!=='active')return;
    if(nasSettingsRead)return nasSettingsRead;
    const work=(async()=>{const snapshot=await client.readSettings();if(epoch===nasRuntimeEpoch&&client===nasRuntimeClient&&currentUserStatus==='active'&&generation===nasReadGeneration&&(!nasSettingsSnapshot||snapshot.revision>=nasSettingsSnapshot.revision))acceptNasSettings(snapshot);})();
    nasSettingsRead=work;try{return await work;}finally{if(nasSettingsRead===work)nasSettingsRead=null;}
  }
  async function nasSaveSettings(patch,values){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;if(!canAdmin())throw Error('Требуется администратор');
    if(!nasSettingsSnapshot)await refreshNasSettings();
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||!nasSettingsSnapshot)throw Error('Обновите настройки Ubuntu');
    const result=await nasBusinessCommand('settings','config',{type:values?'settings.rewards':'settings.patch',expectedRevision:nasSettingsSnapshot.revision,...(values?{values}:{patch})});
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||!canAdmin())throw Error('Сеанс администратора изменился');
    acceptNasSettings({revision:result.result.revision,data:result.result.data});return result.result.data;
  }
  async function refreshNasArchive(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=nasReadGeneration;if(!client||currentUserStatus!=='active')return;
    if(nasArchiveRead)return nasArchiveRead;
    const work=(async()=>{const snapshot=await client.readArchive();if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||currentUserStatus!=='active'||generation!==nasReadGeneration||!hasTabAccess('archive')&&!hasTabAccess('analytics'))return;
      markSync('nas-archive',false,false,snapshot.archives.length);state.archive=snapshot.archives;state.trash=snapshot.trash;markSync('archive',false,false,state.archive.length);markSync('trash',false,false,state.trash.length);saveCache();renderAll();})();
    nasArchiveRead=work;try{return await work;}finally{if(nasArchiveRead===work)nasArchiveRead=null;}
  }
  async function nasArchiveAction(type,id){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    const row=(type==='trash.purge'?state.trash:state.archive).find(x=>x.id===id);if(!row)throw Error('Обновите архив');
    const result=await nasBusinessCommand('archive',id,{type,recordId:id,expectedRevision:row.revision});
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Учётная запись изменилась');
    await refreshNasArchive();if(type==='archive.restore')await nasRefreshLine();return result;
  }
  async function refreshNasGames(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=nasReadGeneration;if(!client||currentUserStatus!=='active')return;
    if(nasGameRead)return nasGameRead;
    const work=(async()=>{const snapshot=await client.readGames();if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||currentUserStatus!=='active'||generation!==nasReadGeneration)return;
      if(snapshot.head.gameRound<nasGameReceiptFloor)return;
      markSync('nas-games',false,false,snapshot.records.length);nasGameSnapshot=snapshot;nasGameReady=true;window.__gameAccessChanged?.();window.RoadArcade?.sync();})();
    nasGameRead=work;try{return await work;}finally{if(nasGameRead===work)nasGameRead=null;}
  }
  function nasGameReadError(error){
    if([401,403].includes(error.status)){nasGameReady=false;nasGameSnapshot=null;nasGameReceiptFloor=0;}
    // A failed background read cannot revoke a previously confirmed wallet.
    // Every play still needs an authenticated server transaction and receipt.
    // Кошелёк уже подтверждён → этот сбой чисто фоновый: жёлтый баннер
    // «Ошибка загрузки» не поднимается (getSyncStatus показывает такое как
    // degraded), ошибка остаётся на точке синхронизации и в диагностике.
    window.__gameAccessChanged?.();window.RoadArcade?.sync();reportSyncError('nas-games',error);
  }
  function acceptNasGameReceipt(result){
    const h=result?.confirmedHead;
    if(!nasGameSnapshot||!h||!Number.isSafeInteger(h.gameRound)||h.gameRound<1||!Number.isSafeInteger(h.bank)||h.bank<0||h.userUid!==currentUid||h.player?.uid!==currentUid||typeof h.id!=='string')return false;
    nasGameReceiptFloor=Math.max(nasGameReceiptFloor,h.gameRound);
    const records=nasGameSnapshot.records.filter(r=>r.id!==h.id).concat(h);
    const newer=h.gameRound>=nasGameSnapshot.head.gameRound;
    nasGameSnapshot={...nasGameSnapshot,records,...(newer?{head:h}:{}),players:{...nasGameSnapshot.players,...(h.gameRound>=(nasGameSnapshot.players[currentUid]?._round||0)?{[currentUid]:{...h.player,_round:h.gameRound}}:{})}};
    nasGameReady=true;window.__gameAccessChanged?.();window.RoadArcade?.sync();return true;
  }
  async function nasGameAction(action){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    // Roll фиксируется на клиенте до анимации остановки, и сервер обязан
    // засчитать именно его: иначе барабаны останавливаются на одной
    // комбинации, а серверная выплата считается по другой — подмена.
    const {id,...gameAction}=action;
    const target=gameAction.kind==='slot'||gameAction.kind==='dino'?(gameAction.kind+':'+id):gameAction.kind==='purchase'?'theme:'+gameAction.itemId:gameAction.kind+':'+gameAction.level+':'+(gameAction.coin??'');
    const receipt=await nasBusinessCommand('game',target,{type:'game.play',action:gameAction});
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Учётная запись изменилась');
    if(gameAction.kind!=='purchase'&&acceptNasGameReceipt(receipt.result)){
      void refreshNasGames().catch(error=>{if(epoch===nasRuntimeEpoch&&client===nasRuntimeClient)nasGameReadError(error);});
      return receipt.result;
    }
    await refreshNasGames();return receipt.result;
  }
  async function nasGrantCoins(targetUid,amount,reason){
    const receipt=await nasBusinessCommand('game','grant:'+targetUid,{type:'game.grant',targetUid,amount,reason});
    await refreshNasGames();return receipt.result;
  }
  async function refreshNasObjects(){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;if(!client||currentUserStatus!=='active')return;
    if(nasCatalogRead)return nasCatalogRead;
    const work=(async()=>{const catalog=await client.readCatalog();if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||currentUserStatus!=='active'||!hasTabAccess('line')&&!hasTabAccess('trucks')&&!hasTabAccess('timesheet'))return;
      markSync('nas-objects',false,false,catalog.objects.length);nasCatalogSnapshot=catalog;state.trucks=catalog.trucks.map(row=>({...row.data,id:row.id,revision:row.revision}));state.objects=catalog.objects.map(row=>({...row.data,id:row.id,revision:row.revision}));if(state.shift?.objectId)state.shift.objectName=objectTitle(state.shift.objectId,state.shift.objectName);
      void refreshTruckPhones();
      markSync('objects',false,false,state.objects.length);
      // Справочник техники — единственный источник списка машин в режиме v2:
      // legacy-снимок линии недоступен (две смены → 409), а индикатор считает
      // источник «trucks» обязательным для подтверждённой загрузки.
      markSync('trucks',false,false,state.trucks.length);
      saveCache();window.dispatchEvent(new Event('samosval-working-test-objects-changed'));
    })();nasCatalogRead=work;try{return await work;}finally{if(nasCatalogRead===work)nasCatalogRead=null;}
  }
  function nasTabelHost(){
    const client=nasRuntimeClient,user=wtAuthUser(),epoch=nasRuntimeEpoch;
    if(!client||!user)throw Error('Сеанс Ubuntu не загружен');
    const guard=()=>{if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||wtAuthUser()!==user||currentUid!==client.uid||currentUserStatus!=='active'||!permissionsLoaded||!hasTabAccess('timesheet'))throw Error('Доступ к табелю изменился');};
    const remoteFactory=async jobGuard=>{
      guard();const {createTabelRemote}=await loadNasTabelRemote();guard();
      return createTabelRemote({datasetEpoch:client.datasetEpoch,baseUrl:nasApiBase(),
        getIdToken:async force=>{guard();const token=await user.getIdToken(force);guard();return token;},
        guard:job=>{guard();jobGuard?.(job);}});
    };
    return {session:()=>({projectId:firebaseConfig.projectId,workspaceId:WORKSPACE_ID,uid:currentUid,name:getUserName(),role:currentUserRole,
      active:epoch===nasRuntimeEpoch&&client===nasRuntimeClient&&currentUserStatus==='active',view:epoch===nasRuntimeEpoch&&permissionsLoaded&&hasTabAccess('timesheet'),edit:hasPermission('timesheet_edit'),tabelTabs:tabelTabViews(),objectId:state.shift?.objectId,runtimeId:epoch,
      provider:nasProvider(),providerScope:client.scope}),remoteFactory,
      presenceRemote:{list:target=>{guard();return client.readPresence(target);},write:payload=>{guard();return client.writePresence(payload);},remove:payload=>client.removePresence(payload)},
      registerPresenceLeave:callback=>{nasPresenceLeavers.add(callback);return ()=>nasPresenceLeavers.delete(callback);},
      get shift(){return state.shift;},get objects(){return state.objects;},
      users:async()=>{guard();const result=await client.readMembers();guard();return result.members.map(m=>({...m,id:m.uid}));},
      readCatalog:async()=>{const remote=await remoteFactory();const row=await remote.read('_catalog/config');guard();const data=row.data||{};
        if(data.equipment!==undefined&&!Array.isArray(data.equipment)||data.people!==undefined&&!Array.isArray(data.people))throw Error('Не подтверждён формат справочника табеля');
        return {equipment:data.equipment||[],people:data.people||[]};},
      snapshot:()=>({shift:state.shift,trucks:state.trucks,statuses:state.truckStatus,logs:state.logs,audit:state.audit,lineAudit:state.lineAudit,archive:state.archive}),
      createObject:async(name,startDate)=>{guard();const result=await nasSaveRecord('object','',{name,...(startDate?{startDate}:{})},0);guard();return {...result.result.data,id:result.result.id};}
    };
  }
  async function leaveNasPresence(){
    let timer;try{await Promise.race([Promise.allSettled([...nasPresenceLeavers].map(fn=>Promise.resolve().then(fn))),new Promise(resolve=>{timer=setTimeout(resolve,1500);})]);}finally{clearTimeout(timer);}
  }
  async function ensureNasPendingAccount(user,getUser=()=>wtAuthUser()) {
    if(getUser()!==user)throw Error('Сеанс регистрации изменился');
    const {createNasClient}=await loadNasSessionClient();
    if(getUser()!==user)throw Error('Сеанс регистрации изменился');
    const client=createNasClient({baseUrl: nasApiBase(), getUser,workspaceId:WORKSPACE_ID,timeoutMs:15000});
    try{return await client.registerPending({nickname:sanitizeName(user.email||'')});}finally{client.stop();}
  }
  async function refreshNasAdministration() {
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||!canAdmin())throw Error('Требуется активный администратор Ubuntu');
    if(nasAdminRead)return nasAdminRead;
    const work=(async()=>{
      const snapshot=await client.readAdministration();
      if(epoch!==nasRuntimeEpoch||nasRuntimeClient!==client||!canAdmin())throw Error('Сеанс администратора изменился');
      markSync('nas-admin',false,false,snapshot.users.length);nasAdministration=snapshot;state.users=snapshot.users.map(u=>({...u,id:u.uid}));state.requests=snapshot.requests.map(r=>({...r,id:r.uid}));
      permissionsConfig={...snapshot.permissions,admin:permissionsConfig.admin};
      requestSyncStatus.requests=true;requestSyncStatus.users=true;requestSyncStatus.errors={};renderAdminPanel();return snapshot;
    })();nasAdminRead=work;
    try{return await work;}finally{if(nasAdminRead===work)nasAdminRead=null;}
  }
  function nasIdentityJournalKey(){return 'samosval_working_test_nas_identity_v1:'+nasStorageScope();}
  async function nasAdminAction(type,payload) {
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||!canAdmin()||!navigator.onLine)throw Error('Для изменения доступа нужен администратор и соединение с Ubuntu');
    if(!nasAdministration)await refreshNasAdministration();
    if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||!canAdmin())throw Error('Сеанс администратора изменился');
    const key=nasIdentityJournalKey(),intent=JSON.stringify({type,...payload});
    const stored=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(stored))throw Error('Не удалось прочитать очередь изменения доступа');
    const target=payload.uid||payload.role,existing=stored.find(x=>x.type===type&&x.target===target);
    if(existing&&existing.intent!==intent)throw Error('Предыдущее изменение ещё ожидает подтверждения. Повторите его перед новым изменением');
    let queued=existing;
    if(!queued){
      const operation={id:'identity_'+crypto.randomUUID().replaceAll('-',''),type,...payload};
      if(type==='permissions.replace'){
        const config=nasAdministration.permissions[payload.role];if(!config)throw Error('Обновите матрицу прав');operation.expectedRevision=config.revision;
      }else{
        const profile=[...nasAdministration.users,...nasAdministration.deletedUsers].find(u=>u.uid===payload.uid);if(!profile)throw Error('Обновите список пользователей');
        if(type.startsWith('registration.')){
          const request=nasAdministration.requests.find(r=>r.uid===payload.uid);if(!request)throw Error('Заявка уже рассмотрена. Обновите список');
          operation.expectedRevision=request.revision;operation.expectedProfileRevision=profile.revision;
        }else operation.expectedRevision=profile.revision;
      }
      queued={type,target,intent,operation,scope:client.scope};stored.push(queued);localStorage.setItem(key,JSON.stringify(stored));
    }
    try{
      const result=await client.submitAdministration(queued.operation,{operationScope:queued.scope});
      if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient)throw Error('Сеанс администратора изменился');
      const latest=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify(latest.filter(x=>x.operation.id!==queued.operation.id)));
      await refreshNasAdministration().catch(error=>reportSyncError('nas-admin',error));return result;
    }catch(error){
      // A conflict is authoritative; a transport/auth failure retains the same ID.
      if([400,409].includes(error.status)&&epoch===nasRuntimeEpoch){const latest=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify(latest.filter(x=>x.operation.id!==queued.operation.id)));await refreshNasAdministration().catch(()=>{});}
      // Ошибки, кроме 400/409, остаются в очереди: панель «Неподтверждённые
      // изменения» покажет причину застревания (markNasCommandFailed).
      else if(typeof markIdentityCommandFailed==='function'&&epoch===nasRuntimeEpoch){try{markIdentityCommandFailed(key,queued.operation.id,error);}catch(_){}}
      throw error;
    }
  }
  async function runNasAdminAction(type,payload) {
    try{await nasAdminAction(type,payload);showToastEl('Изменение сохранено на Ubuntu',false);return true;}
    catch(error){if(canAdmin())renderAdminPanel();showError(error.message||'Изменение не подтверждено');return false;}
  }
  async function replayNasOfflineJournal() {
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||offlineReplayRunning||!navigator.onLine||!permissionsLoaded||currentUserStatus!=='active'||Date.now()<offlineServerRetryAt)return;
    // Never replay into a server that is not the declared authority.
    if(!nasCanWrite())return;
    const live=()=>epoch===nasRuntimeEpoch&&nasRuntimeClient===client&&client.uid===currentUid;
    offlineReplayRunning=true;
    try{
      for(const op of offlinePendingOps()){
        if(!live()||!navigator.onLine||currentUserStatus!=='active')break;
        if(op.dependencyId){const previous=offlineJournalRead().find(x=>x.id===op.dependencyId);if(previous?.status==='pending')break;if(previous?.status==='rejected'){offlineResolve(op.id,'rejected','previous-action-rejected');offlineProjectState();refreshLineViews();continue;}}
        try{
          const result=await client.submitLine(op,{operationScope:op.operationScope});
          if(!live())return;
          if(result.status)nasReceiptFloors.set(op.truckId,{truckId:op.truckId,shiftId:op.shiftId,cycle:Number(result.status.cycleRevision||0),ttn:Number(result.status.ttnRevision||0)});
          // The NAS transaction owns audit/history. Never deliver Firebase effects.
          const all=offlineJournalRead(),saved=all.find(x=>x.id===op.id&&x.status==='pending');
          if(!saved)continue;
          Object.assign(saved,{status:result.outcome,result:result.reason||result.outcome,resolvedAt:Date.now(),effectsDelivered:true,savedResult:{status:result.status||null,log:result.log||null}});
          offlineJournalWrite(all);offlineAdoptResult(op,result);offlineTransportRecovered();
          if(result.outcome==='rejected')showErrorPanel('⚠️ '+escapeHtml(offlineReasonLabel(result.reason)));
        }catch(error){
          if(!live())return;
          // HTTP/auth/transport failures have no business receipt. Keep the intent.
          reportSyncError('nas',error);
          if(error.retryable||error.uncertain)offlineTransportFailed(error);
          break;
        }
      }
    }finally{offlineReplayRunning=false;if(live())updateSyncUI();}
  }

  function nasCanWrite(){return nasAuthority.provider==='ubuntu';}
  function nasAuthorityError(){return Error('Сейчас данные принимает резервный сервер. Запись на этом сервере закрыта — действия сохраняются на телефоне.');}
  // Persist the complete immutable intent before sending. Lost replies reuse IDs.
  async function nasBusinessCommand(channel,target,fields) {
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    if(!client||currentUserStatus!=='active'||!navigator.onLine)throw Error('Нужно соединение с Ubuntu');
    if(!nasCanWrite())throw nasAuthorityError();
    const captured=JSON.parse(JSON.stringify(fields));
    const key='samosval_working_test_nas_commands_v1:'+client.scope,slot=channel+':'+target;
    const {expectedRevision,expectedTtnRevision,expectedObjectId,expected,...desired}=captured,intent=JSON.stringify(desired);
    const flightKey=key+':'+slot;
    const inflight=nasCommandFlights.get(flightKey);
    if(inflight){if(inflight.intent!==intent)throw Error('Предыдущее изменение ещё отправляется');return inflight.work;}
    const live=()=>epoch===nasRuntimeEpoch&&client===nasRuntimeClient&&client.uid===currentUid;
    const run=async()=>{
      if(!live())throw Error('Учётная запись изменилась');
      const queue=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(queue))throw Error('Не удалось прочитать очередь Ubuntu');
      let pending=queue.find(x=>x.slot===slot);
      if(pending&&pending.intent!==intent)throw Error('Сначала повторите предыдущее неподтверждённое изменение');
      if(!pending){
        const id=(channel==='report'?'report_':'cmd_')+crypto.randomUUID().replaceAll('-',''),operation={id,...captured};
        if(channel==='control'&&operation.type.endsWith('.create'))operation.recordId='record_'+id;
        if(channel==='start')operation.createdAt=Date.now();
        pending={slot,intent,operation,scope:client.scope};queue.push(pending);localStorage.setItem(key,JSON.stringify(queue));
      }
      const remove=()=>{if(!live())return;const latest=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify(latest.filter(x=>x.operation.id!==pending.operation.id)));};
      nasReadGeneration++;nasPollHolds++;nasRuntimeStop?.();nasRuntimeStop=null;
      try{
        const method={control:'submitControl',start:'startShift',close:'closeShift',settings:'submitSettings',archive:'submitArchive',game:'submitGame',auxiliary:'submitAuxiliary',report:'submitReport',backup:'submitBackup',notification:'submitNotificationTest'}[channel];
        const result=await client[method](pending.operation,{operationScope:pending.scope});
        if(!live())throw Error('Учётная запись изменилась');
        remove();return result;
      }catch(error){
        // 400/409 — сервер сам отказал: команды гарантированно нет на сервере.
        // Остальные ошибки сохраняются в самой команде (markNasCommandFailed):
        // панель «Неподтверждённые изменения» покажет причину застревания,
        // окончательный отказ (4xx кроме 408/429) помечается failed и
        // удаляется только явным решением пользователя в панели, не молча.
        if([400,409].includes(error.status))remove();
        else if(typeof markNasCommandFailed==='function'&&live()){try{markNasCommandFailed(key,pending.operation.id,error);}catch(_){}}
        throw error;
      }
      finally{if(live()){nasPollHolds--;if(!nasPollHolds)nasResumePolling?.();}}
    };
    const work=navigator.locks?navigator.locks.request(key,run):Promise.resolve().then(run);nasCommandFlights.set(flightKey,{work,intent});
    try{return await work;}finally{if(nasCommandFlights.get(flightKey)?.work===work)nasCommandFlights.delete(flightKey);}
  }
  function nasRecordRevision(kind,id){
    const rows=kind==='truck'?nasCatalogSnapshot?.trucks:nasCatalogSnapshot?.objects;
    return rows?.find(row=>row.id===id)?.revision;
  }
  async function nasRefreshLine(){
    // Линию ведёт v2-мост: v1-снимок в этом режиме законно отказывает, и
    // повторять его — значит выдавать ожидаемый отказ за сбой синхронизации.
    // Вместо этого будим подписку v2: она перечитает список и снимок
    // выбранной смены, то есть сделает ровно то, чего ждёт вызывающий слой.
    if(!nasLegacyLineReadAllowed()){try{nasV2Bridge?.handle?.wake?.();}catch(_){}return;}
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch,generation=++nasReadGeneration;if(!client)return;
    const snapshot=await client.readLine();if(client===nasRuntimeClient&&epoch===nasRuntimeEpoch&&generation===nasReadGeneration)acceptNasLineSnapshot(snapshot);
  }
  async function nasSaveRecord(kind,id,data,revision){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
    const result=await nasBusinessCommand('control',kind+':'+(id||'new'),{type:kind+(id?'.update':'.create'),...(id?{recordId:id}:{}),expectedRevision:id?revision:0,data});
    await Promise.allSettled([refreshNasObjects(),nasRefreshLine()]);if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch)throw Error('Учётная запись изменилась');renderAll();return result;
  }
  async function nasDeleteRecord(kind,id,revision){
    await nasBusinessCommand('control',kind+':'+id,{type:kind+'.delete',recordId:id,expectedRevision:revision});
    await Promise.allSettled([refreshNasObjects(),nasRefreshLine()]);renderAll();
  }
  async function nasChangeMembership(id,adding){
    if(offlinePendingForTruck(id))throw Error('Сначала синхронизируйте действия этого самосвала');
    const status=state.truckStatus[id],shiftId=state.shift?.id;if(!shiftId)throw Error('Смена не открыта');
    const result=await nasBusinessCommand('control','membership:'+id,{type:adding?'line.add':'line.remove',truckId:id,shiftId,expectedRevision:Number(status?.cycleRevision||0),expectedTtnRevision:Number(status?.ttnRevision||0)});
    const row=result.result;nasReceiptFloors.set(id,{truckId:id,shiftId,cycle:Number(row.cycleRevision||0),ttn:Number(row.ttnRevision||0)});
    offlineRemoteStatuses[id]=row;offlineProjectState();saveCache();renderAll();await nasRefreshLine();
  }

  function loadNasMaterialTransfer(){return import(new URL('./working-test/tabel-v2/material-transfer.mjs',document.baseURI).href);}
  const unresolvedShiftTypeNotice='Смена открыта без выбранного типа (дневная/ночная). Закрыто без переноса в табель — объёмы остались в архиве.';
  async function nasCloseCurrentShift(shiftId){
    const client=nasRuntimeClient,epoch=nasRuntimeEpoch;if(!client)throw Error('Сеанс Ubuntu не загружен');
    const guard=()=>{if(epoch!==nasRuntimeEpoch||client!==nasRuntimeClient||currentUid!==client.uid)throw Error('Учётная запись изменилась');};
    const key='samosval_working_test_nas_close_v1:'+client.scope+':'+shiftId;
    let prepared=JSON.parse(localStorage.getItem(key)||'null');
    if(!prepared){prepared=await nasBusinessCommand('close',shiftId+':prepare',{type:'prepare',shiftId});guard();localStorage.setItem(key,JSON.stringify(prepared));}
    if(prepared.shift?.id!==shiftId||prepared.archive&&prepared.archive.sourceShiftId!==shiftId)throw Error('Сохранённое закрытие относится к другой смене');
    await nasRefreshLine();guard();
    // Восстановленная архивная смена уже переносила материал при исходном
    // закрытии: повторного переноса в табель не делаем, только архивация.
    const restoredShift=(state.restoredShifts||[]).some(r=>r.shift.id===shiftId);
    let skippedUnresolvedType=false;
    if(prepared.archive&&!restoredShift){
      const module=await loadNasMaterialTransfer();guard();
      // Legacy-смена, открытая до обязательного выбора типа: день/ночь не
      // доказан, класть объём некуда. Закрываем штатно, материал не переносим
      // и предупреждаем (решение владельца 26.11.2026).
      if(module.shiftHasProvenKind(prepared.shift))await module.transferClosedLine(nasTabelHost(),prepared.shift,prepared.archive);
      else skippedUnresolvedType=true;
      guard();
    }
    await nasBusinessCommand('close',shiftId+':finish',{type:'finish',shiftId});guard();
    localStorage.removeItem(key);
    await nasRefreshLine().catch(error=>reportSyncError('nas',error));guard();
    if(skippedUnresolvedType)appNotice(unresolvedShiftTypeNotice);
  }
