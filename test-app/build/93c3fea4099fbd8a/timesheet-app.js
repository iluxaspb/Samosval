
/* Field ledger 3.1.2. Loaded only by index-test.html. */
(function () {
  'use strict';
  if (window.Timesheet || firebaseConfig.projectId !== 'samosval-offline') return;
  const C=window.TimesheetCore, E=escapeHtml;
  const names={timesheetPeople:'Люди',timesheetEquipment:'Техника',timesheetEntries:'Табель',timesheetMaterials:'Материалы'};
  const groups={worker:'Рабочие',itr:'ИТР',operator:'Машинисты / водители'};
  const statuses={unfilled:'Не заполнено',work:'Работал',off:'Выходной',absent:'Отсутствовал'};
  const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date());
  const uid=()=>{if(crypto.randomUUID)return crypto.randomUUID();const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');};
  const S={user:'',generation:0,local:null,jobs:[],remote:{},unsubs:[],periodUnsubs:[],objectId:'',date:today(),shift:'day',view:'day',catalogGroup:'worker',scope:'',ready:{},objectRows:{timesheetEntries:[],timesheetMaterials:[]},objectReady:{},objectCached:{},objectViewId:'',objectUnsubs:[],objectRequest:0,errors:{},busy:false,dialog:null,lastHtml:'',bulkWorkers:false,bulkRows:[],bulkValue:'12',bulkSaving:false};
  for(const k of C.collections) S.remote[k]=[];
  const host=document.getElementById('tab-timesheet');
  const byId=id=>document.getElementById(id);
  const allowed=()=>!!currentUid && currentUserStatus==='active' && permissionsLoaded && hasTabAccess('timesheet');
  const edit=()=>allowed() && hasPermission('timesheet_edit');
  const manage=()=>allowed() && hasPermission('timesheet_manage');
  const fmtDate=d=>d.split('-').reverse().join('.');
  const shiftName=s=>s==='night'?'Ночь':'День';
  const active=()=>host.classList.contains('active');
  const toast=s=>showToastEl(s,false);
  const error=e=>showError(e.message||String(e));
  const sort=a=>a.sort((x,y)=>x.name.localeCompare(y.name,'ru'));
  function rows(col){return C.project(S.remote[col]||[],S.jobs,col);}
  function living(col){return rows(col).filter(x=>!x.deleted);}
  function entries(){return living('timesheetEntries').filter(x=>x.scope===C.scope(S.objectId,S.date));}
  function dayEntries(){return entries().filter(x=>x.date===S.date&&x.shift===S.shift);}
  const objectSummaryEnabled=()=>appConfig?.testReviewFlags?.object_summary!==false;
  const objectRows=col=>C.project(S.objectRows[col]||[],S.jobs,col).filter(x=>!x.deleted&&x.objectId===S.objectId);
  function object(){return state.objects.find(x=>x.id===S.objectId);}
  function ownData(row){const d={...row};for(const k of ['id','revision','lastOpId','updatedBy','updatedName','updatedAt','pending'])delete d[k];return d;}
  function change(col,id,data){const old=rows(col).find(x=>x.id===id);return {collection:col,id,baseRevision:old?.revision||0,before:old?ownData(old):null,data};}
  function choice(value,label,selected){return `<option value="${E(value)}"${value===selected?' selected':''}>${E(label)}</option>`;}
  function field(label,control){return `<label class="ts-field"><span>${label}</span>${control}</label>`;}
  function input(name,value='',extra=''){return `<input name="${name}" value="${E(value)}" ${extra}>`;}
  function btn(label,action,extra=''){return `<button type="button" class="ts-btn${['entry','crew'].includes(action)?' ts-details':''}" data-action="${action}" ${extra}>${label}</button>`;}
  function note(s){return `<p class="ts-muted">${s}</p>`;}
  function localOpen(name){return new Promise((resolve,reject)=>{const req=indexedDB.open(name,1);req.onupgradeneeded=()=>{req.result.createObjectStore('jobs',{keyPath:'id'});req.result.createObjectStore('cache',{keyPath:'key'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(Error('Закройте другие вкладки, чтобы открыть локальное хранилище'));});}
  function local(store,method,value){const database=S.local;if(!database)return Promise.reject(Error('Локальное хранилище ещё не готово'));return new Promise((resolve,reject)=>{const tx=database.transaction(store,method==='get'||method==='getAll'?'readonly':'readwrite');const req=tx.objectStore(store)[method](value);let result;req.onsuccess=()=>{result=req.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error||req.error);tx.onabort=()=>reject(tx.error||Error('Не удалось сохранить на устройстве'));});}
  async function loadJobs(){const generation=S.generation;const jobs=await local('jobs','getAll');if(generation===S.generation)S.jobs=jobs.sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));}
  function reset(){S.generation++;stopObjectView();inlineDrafts.clear();inlineChains.clear();S.bulkWorkers=false;S.bulkRows=[];S.bulkSaving=false;for(const u of [...S.unsubs,...S.periodUnsubs])u();S.unsubs=[];S.periodUnsubs=[];S.local?.close();S.local=null;S.user='';S.scope='';S.jobs=[];S.ready={};S.errors={};S.busy=false;for(const k of C.collections)S.remote[k]=[];S.dialog?.close();S.lastHtml='';host.innerHTML='';}
  async function session(){
    if(!allowed()){if(S.user)reset();return;}
    if(S.user===currentUid)return;
    reset();S.user=currentUid;const generation=S.generation;
    try {
      const database=await localOpen('dt_timesheet_v1_'+firebaseConfig.projectId+'_'+WORKSPACE_ID+'_'+S.user);
      if(generation!==S.generation){database.close();return;}S.local=database;await loadJobs();
      if(generation!==S.generation)return;
      for(const col of ['timesheetPeople','timesheetEquipment']){
        const cached=await local('cache','get',col);if(generation!==S.generation)return;if(cached)S.remote[col]=cached.rows;
        S.unsubs.push(wsRef.collection(col).onSnapshot({includeMetadataChanges:true},snap=>receive(col,col,snap,generation),e=>syncError(col,e,generation)));
      }
      if(!state.objects.some(o=>o.id===S.objectId))S.objectId=state.shift?.objectId||state.objects[0]?.id||'';
      await period();if(S.view==='object')await objectPeriod();render();replay();
    }catch(e){if(generation===S.generation){S.errors.local='Не удалось открыть хранилище: '+e.message;render();}}
  }
  function syncError(key,e,generation){if(generation!==S.generation)return;S.ready[key]=false;S.errors[key]=(e.code==='permission-denied'?'Нет доступа к базе табеля. Администратору нужно применить правила для тестовой базы.':e.message);render();}
  function receive(col,key,snap,generation){if(generation!==S.generation)return;if(snap.metadata.fromCache&&snap.docs.length===0&&S.remote[col].length){S.ready[col]=false;render();return;}S.remote[col]=snap.docs.map(d=>({...d.data(),id:d.id}));S.ready[col]=!snap.metadata.fromCache;delete S.errors[col];local('cache','put',{key,rows:S.remote[col]}).catch(e=>{S.errors.local='Кэш не сохранён: '+e.message;render();});render();}
  async function period(){
    if(!S.local||!S.objectId)return;
    const scope=C.scope(S.objectId,S.date);if(S.scope===scope)return;
    S.scope=scope;const generation=S.generation;
    S.periodUnsubs.forEach(u=>u());S.periodUnsubs=[];
    for(const col of ['timesheetEntries','timesheetMaterials']){S.remote[col]=[];S.ready[col]=false;delete S.errors[col];}
    render();
    for(const col of ['timesheetEntries','timesheetMaterials']){
      const key=col+':'+scope,cached=await local('cache','get',key);if(generation!==S.generation||S.scope!==scope)return;if(cached)S.remote[col]=cached.rows;
      S.periodUnsubs.push(wsRef.collection(col).where('scope','==',scope).onSnapshot({includeMetadataChanges:true},snap=>{if(S.scope===scope)receive(col,key,snap,generation);},e=>{if(S.scope===scope)syncError(col,e,generation);}));
    }
    render();
  }
  // Отдельная подписка на весь объект. Помесячный кэш и очередь событий не изменяются.
  function stopObjectView(){
    S.objectRequest++;S.objectUnsubs.forEach(u=>u());S.objectUnsubs=[];
    S.objectViewId='';S.objectRows={timesheetEntries:[],timesheetMaterials:[]};
    S.objectReady={};S.objectCached={};
    delete S.errors.objectEntries;delete S.errors.objectMaterials;
  }
  async function objectPeriod(){
    if(!S.local||!S.objectId||S.view!=='object'||!objectSummaryEnabled())return;
    if(S.objectViewId===S.objectId)return;
    stopObjectView();const objectId=S.objectId,request=S.objectRequest,generation=S.generation;
    S.objectViewId=objectId;
    for(const [col,errorKey] of [['timesheetEntries','objectEntries'],['timesheetMaterials','objectMaterials']]){
      const key=col+':object:'+objectId,cached=await local('cache','get',key);
      if(generation!==S.generation||request!==S.objectRequest||S.objectViewId!==objectId)return;
      if(cached?.complete&&Array.isArray(cached.rows)){S.objectRows[col]=cached.rows;S.objectCached[col]=true;}
      S.objectReady[col]=false;
      S.objectUnsubs.push(wsRef.collection(col).where('objectId','==',objectId).onSnapshot({includeMetadataChanges:true},snap=>{
        if(generation!==S.generation||request!==S.objectRequest||S.objectViewId!==objectId)return;
        if(!snap.metadata.fromCache){
          S.objectRows[col]=snap.docs.map(d=>({...d.data(),id:d.id}));
          S.objectReady[col]=true;S.objectCached[col]=true;delete S.errors[errorKey];
          local('cache','put',{key,rows:S.objectRows[col],complete:true}).catch(e=>{S.errors.local='Кэш сводки не сохранён: '+e.message;render();});
        } else S.objectReady[col]=false;
        render();
      },e=>{if(generation!==S.generation||request!==S.objectRequest||S.objectViewId!==objectId)return;S.objectReady[col]=false;S.errors[errorKey]=e.code==='permission-denied'?'Нет доступа к данным всего объекта: проверьте правила тестовой базы.':e.message;render();}));
    }
    render();
  }
  let adding=false;
  async function enqueue(changes,label,quiet=false){
    if(!allowed()||!S.local)throw Error('Войдите в приложение и дождитесь открытия табеля');
    if(!changes.length)return;
    if(changes.some(ch=>['timesheetPeople','timesheetEquipment'].includes(ch.collection)?!manage():!edit()))throw Error('Нет права на изменение этого раздела');
    const ops=[],stamp=Math.max(Date.now(),...S.jobs.map(x=>x.createdAt+1));
    for(let i=0;i<changes.length;i+=4){const op={id:uid(),uid:S.user,scope:S.scope||'catalog',label,createdAt:stamp+i,status:'queued',changes:changes.slice(i,i+4)};C.validateOperation(op);ops.push(op);}
    const generation=S.generation;
    await new Promise((resolve,reject)=>{const tx=S.local.transaction('jobs','readwrite');for(const op of ops)tx.objectStore('jobs').put(op);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Очередь не сохранена'));});
    if(generation!==S.generation)return;
    await loadJobs();render();if(!quiet)toast(navigator.onLine?'Сохранено на устройстве · отправляем':'Сохранено на устройстве · ожидает связи');replay();
  }
  async function replay(){
    if(!allowed()||!S.local||S.busy||!navigator.onLine)return;
    const generation=S.generation,owner=S.user;S.busy=true;
    const work=async()=>{
      await loadJobs();
      for(const op of S.jobs.filter(x=>x.status==='queued')){
        if(generation!==S.generation||currentUid!==owner||!allowed()||!navigator.onLine)break;
        try{
          const result=await C.commitOperation(db,wsRef,op,{uid:owner,name:getUserName(),serverTimestamp:()=>firebase.firestore.FieldValue.serverTimestamp()},window.__historyRawTransaction||db.runTransaction.bind(db));
          if(generation!==S.generation)break;
          if(result.changes)for(const ch of result.changes){if(ch.after.scope&&ch.after.scope!==S.scope)continue;const a=S.remote[ch.collection];const i=a.findIndex(x=>x.id===ch.id);const d={...ch.after,id:ch.id};if(i<0)a.push(d);else a[i]=d;}
          await local('jobs','delete',op.id);
        }catch(e){
          if(generation!==S.generation)break;
          if(['unavailable','deadline-exceeded','aborted','cancelled'].includes(e.code)||!navigator.onLine)break;
          op.status=e.code==='conflict'?'conflict':'rejected';op.error=e.code==='permission-denied'?'Нет права записи. Проверьте права роли и правила тестовой базы.':e.message;
          if(e.conflicts)op.conflicts=C.clone(e.conflicts);await local('jobs','put',op);
        }
      }
      if(generation===S.generation)await loadJobs();
    };
    try{if(navigator.locks)await navigator.locks.request('dt-timesheet-'+owner,{ifAvailable:true},lock=>lock?work():undefined);else await work();}
    catch(e){if(generation===S.generation)S.errors.queue=e.message;}
    finally{if(generation===S.generation){S.busy=false;render();}}
  }
  function personGroup(r){return Object.hasOwn(groups,r.group)?r.group:(living('timesheetPeople').find(p=>p.id===r.entityId)?.group||'worker');}
  function summary(){const d=dayEntries();return `<div class="ts-stats">${[['worker','Рабочие'],['itr','ИТР'],['operator','Машинисты'],['equipment','Техника']].map(([kind,label])=>{const a=d.filter(r=>kind==='equipment'?r.kind==='equipment':r.kind==='person'&&personGroup(r)===kind);return `<div data-summary="${kind}"><strong>${a.length}</strong><span>${label}</span><small>${C.fmt(a.reduce((n,r)=>n+(r.minutes||0),0))} ${kind==='equipment'?'маш.-ч':'чел.-ч'}</small></div>`;}).join('')}</div>`;}
  // The order and tones follow the site's paper/spreadsheet shift log.
  function equipmentStyle(machine){
    const name=machine.name.toLocaleLowerCase('ru').replace(/ё/g,'е');
    if(/полив|поле.?мо|водоле|водовоз|\bпмм\b/.test(name))return {order:0,tone:'water',one:'Водитель',many:'Водители'};
    if(/щетк|муп.?351|трактор/.test(name))return {order:1,tone:'brush',one:'Тракторист',many:'Трактористы'};
    if(/фрез|w\s*[-–]?\s*(55|1000|150|200|205|210)/.test(name))return {order:2,tone:'mill',one:'Машинист',many:'Машинисты'};
    if(/xcmg|ксмг/.test(name))return {order:5,tone:'xcmg',one:'Машинист',many:'Машинисты'};
    if(/фронтал|погруз/.test(name))return {order:3,tone:'loader',one:'Машинист',many:'Машинисты'};
    if(/автобус|паз/.test(name))return {order:4,tone:'bus',one:'Водитель',many:'Водители'};
    return {order:6,tone:'other',one:'Машинист / водитель',many:'Экипаж'};
  }
  const summaryColorsEnabled=()=>appConfig?.testReviewFlags?.summary_colors!==false;
  // Представление табеля. Ничего не меняет в сохранённых записях.
  function coloredSummaryRows(records){
    const items=new Map();
    for(const r of records){const k=r.kind+'|'+r.entityId;if(!items.has(k))items.set(k,{kind:r.kind,entityId:r.entityId,name:r.name,group:r.group||'',tone:'',crewNames:[],machineId:''});}
    const machines=[...items.values()].filter(r=>r.kind==='equipment').sort((a,b)=>equipmentStyle(a).order-equipmentStyle(b).order||a.name.localeCompare(b.name,'ru',{numeric:true}));
    const machineIds=new Set(machines.map(m=>m.entityId)),crewLinks=new Map(),teams=new Map();
    for(const r of records){
      if(r.kind!=='person'||!r.equipmentId||!machineIds.has(r.equipmentId))continue;
      const person=r.kind+'|'+r.entityId,links=crewLinks.get(person)||new Map();
      links.set(r.equipmentId,(links.get(r.equipmentId)||0)+1);crewLinks.set(person,links);
      if(!teams.has(r.equipmentId))teams.set(r.equipmentId,new Set());
      teams.get(r.equipmentId).add(r.name);
    }
    const order=new Map(machines.map((m,i)=>[m.entityId,i]));
    const list=[...items.values()];
    for(const r of list){
      if(r.kind==='equipment'){
        r.tone=equipmentStyle(r).tone;
        r.crewNames=[...(teams.get(r.entityId)||[])].sort((a,b)=>a.localeCompare(b,'ru'));
        r.rank=(order.get(r.entityId)||0)*10;
      }else{
        const links=crewLinks.get(r.kind+'|'+r.entityId);
        const machineId=links?[...links].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0]:'';
        r.machineId=machineId;
        const machine=machines.find(m=>m.entityId===machineId);
        r.tone=machine?equipmentStyle(machine).tone:'';
        r.rank=machine?((order.get(machineId)||0)*10+1):r.group==='operator'?9000:r.group==='worker'?9100:r.group==='itr'?9200:9300;
      }
    }
    return list.sort((a,b)=>a.rank-b.rank||a.name.localeCompare(b.name,'ru',{numeric:true}));
  }
  function summaryRowLabel(r){
    const caption=r.kind==='equipment'?'Техника':r.machineId?'Экипаж':r.group==='operator'?'Машинист / водитель':r.group==='itr'?'ИТР':'Сотрудник';
    const crew=r.kind==='equipment'&&r.crewNames?.length?'<small>Экипаж: '+r.crewNames.slice(0,4).map(E).join(', ')+(r.crewNames.length>4?' и ещё '+(r.crewNames.length-4):'')+'</small>':'';
    return E(r.name)+'<small>'+caption+'</small>'+crew;
  }
  const summaryRowClass=r=>summaryColorsEnabled()&&r.tone?' class="ts-tone-'+r.tone+'"':'';
  function crewSlots(machine){
    if(machine.ownership==='hired')return 0;
    const tone=equipmentStyle(machine).tone;
    return tone==='mill'?2:1;
  }
  function crewSlotPreview(machine,assigned){
    const need=crewSlots(machine);
    if(!need)return '';
    const names=assigned.map(p=>typeof p==='string'?p:p.name);
    const n=Math.max(need,names.length);
    return '<div class="ts-crew-slots"><b>Штатный экипаж: '+n+' '+(n===1?'место':n<5?'места':'мест')+'</b>'+
      Array.from({length:n},(_,i)=>'<span>'+E('Место '+(i+1)+': '+(names[i]||'не назначено'))+'</span>').join('')+
      '<small>Пустые места не создают фиктивных сотрудников и не учитываются в часах.</small></div>';
  }
  const equipmentSort=list=>list.sort((a,b)=>equipmentStyle(a).order-equipmentStyle(b).order||a.name.localeCompare(b.name,'ru',{numeric:true}));
  const crewKey=machine=>'crew:'+machine.id;
  function crewFor(machine){return dayEntries().filter(r=>r.kind==='person'&&personGroup(r)==='operator'&&r.equipmentId===machine.entityId);}
  function editorRows(id){
    if(id.startsWith('crew:')){const machine=dayEntries().find(r=>r.id===id.slice(5)&&r.kind==='equipment');return machine?crewFor(machine):[];}
    const r=rows('timesheetEntries').find(x=>x.id===id&&!x.deleted);return r?[r]:[];
  }
  function commonHours(list){const first=list[0];return {minutes:first?.minutes??null,status:first?.status||'unfilled',mixed:list.some(r=>r.minutes!==first.minutes||r.status!==first.status)};}
  function hoursEditor(id,label,records){
    const value=commonHours(records),draft=inlineDrafts.get(id);
    if(!edit())return `<span class="ts-hours">${value.mixed?'Разные':value.status==='unfilled'?'—':['off','absent'].includes(value.status)?statuses[value.status]:C.fmt(value.minutes)+' ч'}</span>`;
    return `<div class="ts-inline-editor"><button type="button" class="ts-hour-btn" data-action="hours-preset" data-id="${E(id)}" data-value="12" aria-label="Поставить 12 часов">12</button><button type="button" class="ts-hour-btn" data-action="hours-preset" data-id="${E(id)}" data-value="13" aria-label="Поставить 13 часов">13</button><button type="button" class="ts-hour-btn ts-step" data-action="hours-step" data-id="${E(id)}" data-delta="-1" aria-label="Уменьшить на час">−</button><input class="ts-inline-hours" data-id="${E(id)}" value="${E(draft?.dirty?draft.raw:value.mixed?'':C.fmt(value.minutes))}" aria-invalid="${!!draft?.error}" inputmode="decimal" enterkeyhint="done" autocomplete="off" aria-label="Часы: ${E(label)}" placeholder="${value.mixed?'≠':'—'}" title="${value.mixed?'У участников разные часы. Введите часы каждому.':'Часы от 0 до 24, например 12 или 7,5'}"><button type="button" class="ts-hour-btn ts-step" data-action="hours-step" data-id="${E(id)}" data-delta="1" aria-label="Добавить час">+</button></div>`;
  }
  function rowFeedback(id){const draft=inlineDrafts.get(id);return `<span class="ts-row-feedback${draft?.error?' ts-inline-error':''}" role="status">${E(draft?.error||'')}</span>`;}
  function rowCard(r){
    const machine=living('timesheetEquipment').find(x=>x.id===r.equipmentId);
    const detail=r.kind==='person'?(machine?.name||''):[r.ownership==='hired'?r.contractor:'',r.idleMinutes?'простой '+C.fmt(r.idleMinutes)+' ч':''].filter(Boolean).join(' · ');
    const status=['off','absent'].includes(r.status)?statuses[r.status]:'';
    return `<div class="ts-row ts-entry-row ${r.pending?'ts-pending':''}" data-entry-id="${E(r.id)}"><div class="ts-row-name"><strong title="${E(r.name)}">${E(r.name)}${r.pending?'<span class="ts-pending-dot" aria-label="Ожидает отправки">●</span>':''}</strong>${detail||status?`<small>${E([detail,status].filter(Boolean).join(' · '))}</small>`:''}</div>${hoursEditor(r.id,r.name,[r])}${btn('⋯','entry',`data-id="${E(r.id)}" aria-label="Подробности: ${E(r.name)}" title="Отметка, комментарий и другие поля"`)}${rowFeedback(r.id)}</div>`;
  }
  function crewRow(machine){
    if(machine.ownership==='hired')return '';
    const list=crewFor(machine),style=equipmentStyle(machine),id=crewKey(machine);
    const missing=Math.max(0,crewSlots(machine)-list.length);
    if(!list.length)return '<div class="ts-empty-crew">'+crewSlotPreview(machine,[])+(edit()?btn('＋ Назначить экипаж','add-crew',`data-id="${E(machine.id)}"`):'')+'</div>';
    const value=commonHours(list),label=(list.length===1?style.one:style.many)+' · '+list.length;
    const total=C.fmt(list.reduce((sum,r)=>sum+(r.minutes||0),0));
    const hint=value.mixed?'Разные часы · '+total+' чел.-ч':list.length>1?'Всего '+total+' чел.-ч':value.status==='work'?'За смену':statuses[value.status];
    return `<div class="ts-row ts-entry-row ts-crew-row ${list.some(r=>r.pending)?'ts-pending':''}" data-crew-id="${E(machine.entityId)}"><div class="ts-row-name"><strong>${E(label)}${list.some(r=>r.pending)?'<span class="ts-pending-dot" aria-label="Ожидает отправки">●</span>':''}</strong><small>${E(hint)}${missing?' · не назначено мест: '+missing:''}</small></div>${hoursEditor(id,'каждому в экипаже '+machine.name,list)}${btn('⋯','crew',`data-id="${E(machine.id)}" aria-label="Состав экипажа: ${E(machine.name)}" title="Состав и индивидуальные часы"`)}${rowFeedback(id)}</div>`+(missing?crewSlotPreview(machine,list):'');
  }
  function equipmentSection(title,list,ownership){return `<section class="ts-section ts-compact-section ts-ledger-equipment" data-group="equipment" data-ownership="${ownership}"><div class="ts-section-title"><h3>${title}<span class="ts-section-count">${list.length}</span></h3><span class="ts-column-label">Часы</span></div>${equipmentSort(list).map(machine=>`<div class="ts-machine-block ts-tone-${equipmentStyle(machine).tone}" data-machine-id="${E(machine.entityId)}">${rowCard(machine)}${crewRow(machine)}</div>`).join('')||note('Добавьте технику в смену.')}</section>`;}
  function workersBar(){return `<div class="ts-workers-bar"><span>Часы всем рабочим</span><div class="ts-workers-controls"><button class="ts-hour-btn" type="button" data-action="workers-value" data-value="12">12</button><button class="ts-hour-btn" type="button" data-action="workers-value" data-value="13">13</button><button class="ts-hour-btn" type="button" data-action="workers-value" data-delta="-1" aria-label="Уменьшить часы рабочим">−</button><input id="ts-workers-hours" inputmode="decimal" enterkeyhint="done" aria-label="Часы всем рабочим" value="${E(S.bulkValue)}"><button class="ts-hour-btn" type="button" data-action="workers-value" data-delta="1" aria-label="Добавить час рабочим">+</button>${btn('Поставить всем','workers-apply',S.bulkSaving?'disabled':'')}</div></div>`;}
  function peopleSection(kind,label,list){return `<section class="ts-section ts-compact-section ts-ledger-people" data-group="${kind}"><div class="ts-section-title"><h3>${label}<span class="ts-section-count">${list.length}</span></h3>${edit()&&['worker','itr'].includes(kind)?btn('＋ Добавить','add-person',`data-group="${kind}" aria-label="Добавить: ${label}"`):''}</div>${edit()&&kind==='worker'&&list.length?workersBar():''}${sort(list).map(rowCard).join('')||note('Пока нет записей.')}</section>`;}
  function dayView(){
    const d=dayEntries(),machines=d.filter(r=>r.kind==='equipment'),own=machines.filter(r=>r.ownership!=='hired'),hired=machines.filter(r=>r.ownership==='hired');
    const grouped=new Set(own.flatMap(m=>crewFor(m).map(p=>p.id)));
    const loose=d.filter(r=>r.kind==='person'&&personGroup(r)==='operator'&&!grouped.has(r.id));
    return summary()+`<div class="ts-toolbar ts-day-toolbar">${edit()?btn('＋ Техника','add-equipment')+btn('Взять состав','copy'):''}</div>`+equipmentSection('Своя техника',own,'own')+(hired.length?equipmentSection('Привлечённая техника',hired,'hired'):'')+(loose.length?peopleSection('operator','Машинисты / водители без техники',loose):'')+materialsView(false)+peopleSection('itr','ИТР',d.filter(r=>r.kind==='person'&&personGroup(r)==='itr'))+peopleSection('worker','Рабочие',d.filter(r=>r.kind==='person'&&personGroup(r)==='worker'));
  }
  const inlineDrafts=new Map(),inlineChains=new Map();
  function inlineInput(id){return [...host.querySelectorAll('.ts-inline-hours')].find(x=>x.dataset.id===id);}
  function inlineFeedback(id,message,invalid=false){const draft=inlineDrafts.get(id);if(draft){if(invalid)draft.error=message;else delete draft.error;}const input=inlineInput(id);if(!input)return;input.setAttribute('aria-invalid',String(invalid));input.removeAttribute('aria-busy');const feedback=input.closest('.ts-entry-row').querySelector('.ts-row-feedback');if(feedback){feedback.textContent=message;feedback.classList.toggle('ts-inline-error',invalid);}}
  function captureInline(input){const id=input.dataset.id;if(!inlineDrafts.has(id)){const list=editorRows(id);if(list.length)inlineDrafts.set(id,{records:C.clone(list),raw:input.value,dirty:false,generation:S.generation});}return inlineDrafts.get(id);}
  function inlineHours(id,operation,snapshot){
    if(!edit())return Promise.reject(Error('Нет права изменять часы'));
    let chain=inlineChains.get(id);
    if(!chain){const list=snapshot||editorRows(id);if(!list.length)return Promise.resolve();chain={records:C.clone(list),promise:Promise.resolve(),count:0,generation:S.generation};inlineChains.set(id,chain);}
    chain.count++;let attempted;
    const task=chain.promise.then(async()=>{
      if(chain.generation!==S.generation||!edit())return;
      const list=chain.records,value=commonHours(list);let minutes;
      if(operation.type==='step'){
        if(value.mixed&&operation.raw===undefined)throw Error('У экипажа разные часы. Введите часы каждому или нажмите 12 / 13.');
        const base=operation.raw!==undefined?C.hours(operation.raw):value.minutes;minutes=Math.max(0,Math.min(1440,(base??720)+operation.delta*60));
      }else minutes=C.hours(operation.value);
      attempted=C.fmt(minutes);const status=minutes===null?'unfilled':'work';
      if(id.startsWith('crew:')){
        const current=editorRows(id);
        if(current.length!==list.length||current.some(r=>!list.some(before=>before.id===r.id))){const e=Error('Состав экипажа изменился. Проверьте состав и повторите ввод.');e.code='crew-changed';throw e;}
      }
      if(list.every(r=>r.minutes===minutes&&r.status===status)){
        const input=inlineInput(id);if(!inlineDrafts.get(id)?.dirty){if(input)input.value=attempted;inlineDrafts.set(id,{records:C.clone(list),raw:attempted,dirty:false,generation:S.generation});}inlineFeedback(id,'');return;
      }
      const changes=list.map(r=>({collection:'timesheetEntries',id:r.id,baseRevision:r.revision||0,before:ownData(r),data:{...ownData(r),minutes,status}}));
      changes.forEach(ch=>C.validate('timesheetEntries',ch.data,ch.id));inlineInput(id)?.setAttribute('aria-busy','true');
      const machine=id.startsWith('crew:')?dayEntries().find(r=>r.id===id.slice(5)):null;
      await enqueue(changes,machine?'Часы экипажа: '+machine.name+' · '+list.length+' чел.':'Часы: '+list[0].name,true);
      if(chain.generation!==S.generation)return;
      chain.records=changes.map(ch=>({...ch.data,id:ch.id,revision:ch.baseRevision+1}));
      const draft=inlineDrafts.get(id),input=inlineInput(id);
      if(!draft?.dirty){if(input)input.value=attempted;inlineDrafts.set(id,{records:C.clone(chain.records),raw:attempted,dirty:false,generation:S.generation});}
      inlineFeedback(id,'');
    });
    chain.promise=task.catch(e=>{if(chain.generation===S.generation){const draft=inlineDrafts.get(id),records=e.code==='crew-changed'?editorRows(id):chain.records;if(!draft?.dirty){inlineDrafts.set(id,{records:C.clone(records),raw:attempted??inlineInput(id)?.value??'',dirty:attempted!==undefined,generation:S.generation});const input=inlineInput(id);if(input&&attempted!==undefined)input.value=attempted;}else if(e.code==='crew-changed')draft.records=C.clone(records);inlineFeedback(id,e.message,true);error(e);}});
    return chain.promise.finally(()=>{chain.count--;if(!chain.count&&inlineChains.get(id)===chain)inlineChains.delete(id);S.lastHtml='';render();});
  }
  function saveInlineInput(input){const draft=inlineDrafts.get(input.dataset.id);if(!draft?.dirty||draft.generation!==S.generation)return;draft.raw=input.value;try{C.hours(draft.raw);}catch(e){inlineFeedback(input.dataset.id,e.message,true);return;}draft.dirty=false;return inlineHours(input.dataset.id,{type:'set',value:draft.raw},draft.records);}
  function inlineButton(id,value,delta){const input=inlineInput(id),draft=inlineDrafts.get(id);const snapshot=draft&&(draft.dirty||document.activeElement===input)?draft.records:undefined;const raw=draft?.dirty?input?.value:undefined;
    if(draft)draft.dirty=false;
    return inlineHours(id,delta!==undefined?{type:'step',delta:Number(delta),raw}:{type:'set',value},snapshot);
  }
  function captureWorkers(){if(!S.bulkWorkers){S.bulkRows=dayEntries().filter(r=>r.kind==='person'&&personGroup(r)==='worker').map(C.clone);S.bulkWorkers=true;}}
  function workersValue(button){const input=byId('ts-workers-hours');if(!input)return;captureWorkers();try{const minutes=button.dataset.value!==undefined?C.hours(button.dataset.value,false):Math.max(0,Math.min(1440,(C.hours(input.value)??720)+Number(button.dataset.delta)*60));input.value=C.fmt(minutes);S.bulkValue=input.value;input.removeAttribute('aria-invalid');}catch(e){input.setAttribute('aria-invalid','true');error(e);}}
  async function applyWorkers(){if(!edit()||S.bulkSaving)return;const input=byId('ts-workers-hours');if(!input)return;captureWorkers();const minutes=C.hours(input.value,false),list=S.bulkRows;if(!list.length)throw Error('В эту смену ещё не добавлены рабочие');S.bulkSaving=true;host.querySelector('[data-action=workers-apply]').disabled=true;try{await enqueue(list.map(r=>({collection:'timesheetEntries',id:r.id,baseRevision:r.revision||0,before:ownData(r),data:{...ownData(r),minutes,status:'work'}})),'Часы всем рабочим');S.bulkWorkers=false;S.bulkRows=[];}finally{S.bulkSaving=false;S.lastHtml='';render();}}
  function materialsView(month){const list=living('timesheetMaterials').filter(x=>x.scope===S.scope&&(month||x.date===S.date&&x.shift===S.shift));const totals=new Map();for(const r of list){const k=r.material+'|'+r.unit;totals.set(k,{name:r.material,unit:r.unit,total:(totals.get(k)?.total||0)+r.quantity});}return `<section class="ts-section${month?'':' ts-ledger-materials'}" data-group="materials"><div class="ts-section-title"><h3>Поступление материалов</h3>${edit()&&!month?btn('＋ Поступление','material'):''}</div>${[...totals.values()].map(t=>`<span class="ts-chip">${E(t.name)} · ${Number(t.total.toFixed(3)).toLocaleString('ru-RU')} ${E(t.unit)}</span>`).join('')}${list.length?list.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(r=>`<div class="ts-row"><div class="ts-row-name"><strong>${E(r.material)}</strong><small>${E(r.supplier)}${r.document?' · № '+E(r.document):''}${month?' · '+fmtDate(r.date)+' '+shiftName(r.shift):''}</small>${r.pending?'<small>Ожидает отправки</small>':''}</div><b>${r.quantity.toLocaleString('ru-RU')} ${E(r.unit)}</b>${btn(edit()?'Изменить':'Открыть','material',`data-id="${E(r.id)}"`)}</div>`).join(''):note('Материалы считаются отдельно от часов техники подрядчиков.')}</section>`;}
  function monthView(){
    const a=entries(),month=S.date.slice(0,7),days=new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate();const keys=new Map();for(const r of a)keys.set(r.kind+'|'+r.entityId,{kind:r.kind,entityId:r.entityId,name:r.name});
    const grid=summaryColorsEnabled()?coloredSummaryRows(a):[...keys.values()].sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name,'ru'));
    const map=new Map(a.map(r=>[r.id,r]));let headers='',sub='';for(let i=1;i<=days;i++){headers+=`<th colspan="2">${i}</th>`;sub+='<th>Д</th><th>Н</th>';}
    return `<div class="ts-toolbar">${hasPermission('timesheet_export')?btn('↓ Табель CSV','export')+btn('↓ Материалы CSV','export-materials'):''}${btn('История изменений','history')}</div>`+note('Д — дневная смена, Н — ночная. Нажмите ячейку для открытия. «—» — часы ещё не заполнены; пусто — записи нет.')+`<div class="ts-table-wrap"><table class="ts-table${summaryColorsEnabled()?' ts-colored-summary':''}"><thead><tr><th rowspan="2">Сотрудник / техника</th>${headers}<th rowspan="2">Итого, ч</th></tr><tr>${sub}</tr></thead><tbody>${grid.map(g=>{let total=0;let cells='';for(let i=1;i<=days;i++)for(const shift of ['day','night']){const date=month+'-'+String(i).padStart(2,'0'),id=C.entryId(g.kind,S.objectId,date,shift,g.entityId),r=map.get(id);if(r)total+=r.minutes||0;cells+=`<td class="${r?.pending?'ts-pending':''}">${r?`<button type="button" data-action="entry" data-id="${E(id)}">${r.status==='unfilled'?'—':r.status==='work'?C.fmt(r.minutes):r.status==='off'?'В':'НЯ'}</button>`:''}</td>`;}return `<tr${summaryRowClass(g)}><th>${summaryColorsEnabled()?summaryRowLabel(g):E(g.name)+'<small>'+(g.kind==='person'?'Сотрудник':'Техника')+'</small>'}</th>${cells}<td><b>${C.fmt(total)}</b></td></tr>`;}).join('')}</tbody></table></div>${!grid.length?note('За этот месяц пока нет записей.') : ''}`+materialsView(true);
  }
  function objectView(){
    const entryReady=S.objectReady.timesheetEntries||S.objectCached.timesheetEntries;
    const materialReady=S.objectReady.timesheetMaterials||S.objectCached.timesheetMaterials;
    if(!entryReady||!materialReady){
      return note('Собираем сводку по всем датам объекта. Для первого открытия нужен интернет; затем сохранённая сводка доступна без сети.')+
        (!navigator.onLine?'<div class="ts-warning">Полная сводка ещё не сохранена на этом устройстве. После подключения откройте этот раздел снова.</div>':'');
    }
    const list=objectRows('timesheetEntries'),materials=objectRows('timesheetMaterials');
    const dated=new Map();
    for(const r of [...list,...materials]){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(r.date||''))continue;
      const key=r.date+'|'+(r.shift==='night'?'night':'day');
      dated.set(key,{date:r.date,shift:r.shift==='night'?'night':'day'});
    }
    const dates=[...dated.values()].sort((a,b)=>a.date.localeCompare(b.date)||(['day','night'].indexOf(a.shift)-['day','night'].indexOf(b.shift)));
    const entityMap=new Map();
    for(const r of list){const key=r.kind+'|'+r.entityId;if(!entityMap.has(key))entityMap.set(key,{kind:r.kind,entityId:r.entityId,name:r.name,group:r.group});}
    const grid=summaryColorsEnabled()?coloredSummaryRows(list):[...entityMap.values()].sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name,'ru'));
    const byEntityDate=new Map(list.map(r=>[r.kind+'|'+r.entityId+'|'+r.date+'|'+r.shift,r]));
    const personMinutes=list.filter(r=>r.kind==='person'&&r.status==='work').reduce((n,r)=>n+(r.minutes||0),0);
    const machineMinutes=list.filter(r=>r.kind==='equipment'&&r.status==='work').reduce((n,r)=>n+(r.minutes||0),0);
    const range=dates.length?fmtDate(dates[0].date)+' — '+fmtDate(dates[dates.length-1].date):'нет записей';
    const waiting=(!S.objectReady.timesheetEntries||!S.objectReady.timesheetMaterials)?'<div class="ts-warning">Данные взяты из кэша устройства. Новые записи коллег появятся после синхронизации.</div>':'';
    const headers=dates.map(d=>`<th><button type="button" data-action="object-day" data-date="${E(d.date)}" data-shift="${d.shift}" title="Открыть смену">${fmtDate(d.date)}<small>${d.shift==='night'?'Н':'Д'}</small></button></th>`).join('');
    const body=grid.map(g=>{let total=0;
      const cells=dates.map(d=>{const r=byEntityDate.get(g.kind+'|'+g.entityId+'|'+d.date+'|'+d.shift);
        if(!r)return '<td></td>';
        if(r.status==='work')total+=r.minutes||0;
        const content=r.status==='unfilled'?'—':r.status==='work'?C.fmt(r.minutes):r.status==='off'?'В':'НЯ';
        return `<td class="${r.pending?'ts-pending':''}" title="${E(r.name)} · ${fmtDate(d.date)} · ${shiftName(d.shift)}">${E(content)}</td>`;
      }).join('');
      return `<tr${summaryRowClass(g)}><th>${summaryColorsEnabled()?summaryRowLabel(g):E(g.name)+'<small>'+(g.kind==='equipment'?'Техника':'Сотрудник')+'</small>'}</th>${cells}<td><b>${C.fmt(total)}</b></td></tr>`;
    }).join('');
    const mt=new Map();
    for(const r of materials){const k=r.material+'|'+r.unit;const a=mt.get(k)||{name:r.material,unit:r.unit,total:0};a.total+=r.quantity;mt.set(k,a);}
    return `<section class="ts-section"><div class="ts-section-title"><h3>Сводка за весь объект</h3></div><p class="ts-muted">${E(object()?.name||'Объект')} · ${range}</p><div class="ts-stats"><div><strong>${dates.length}</strong><span>Смен с записями</span></div><div><strong>${grid.length}</strong><span>Людей и техники</span></div><div><strong>${C.fmt(personMinutes)}</strong><span>Человеко-часов</span></div><div><strong>${C.fmt(machineMinutes)}</strong><span>Машино-часов</span></div></div></section>`+
      waiting+note('Только даты с записями. Д — день, Н — ночь. Нажмите дату, чтобы открыть смену. Человеко-часы и машино-часы считаются отдельно; только фактически отработанные часы.')+
      `<div class="ts-table-wrap"><table class="ts-table ts-object-table${summaryColorsEnabled()?' ts-colored-summary':''}"><thead><tr><th>Сотрудник / техника</th>${headers}<th>Итого, ч</th></tr></thead><tbody>${body}</tbody></table></div>`+
      (!grid.length?note('За весь период объекта в табеле пока нет записей.'):'')+
      `<section class="ts-section"><div class="ts-section-title"><h3>Материалы за объект</h3></div>${[...mt.values()].map(x=>`<span class="ts-chip">${E(x.name)} · ${Number(x.total.toFixed(3)).toLocaleString('ru-RU')} ${E(x.unit)}</span>`).join('')||note('Поступлений материалов пока нет.')}</section>`;
  }
  function catalogView(){
    const category=S.catalogGroup||'worker',isEquipment=category==='equipment',col=isEquipment?'timesheetEquipment':'timesheetPeople';
    const list=living(col).filter(r=>isEquipment||r.group===category);
    const tabs=`<div class="ts-catalog-tabs">${[['worker','Рабочие'],['operator','Машинисты / водители'],['itr','ИТР'],['equipment','Техника']].map(([group,title])=>btn(title,'catalog-group',`data-group="${group}" aria-pressed="${category===group}"`)).join('')}</div>`;
    const item=r=>`<div class="ts-row"><div class="ts-row-name"><strong>${E(r.name)}</strong>${isEquipment&&r.ownership==='hired'?`<small>${E(r.contractor||'Наёмная техника')}</small>`:''}</div>${manage()?btn('Изменить','catalog',`data-col="${col}" data-group="${category}" data-id="${E(r.id)}"`):''}</div>`;
    const body=isEquipment?['own','hired'].map(ownership=>`<div class="ts-catalog-subgroup"><h4>${ownership==='own'?'Своя техника':'Наёмная техника'}</h4>${equipmentSort(list.filter(r=>r.ownership===ownership)).map(item).join('')||note('Пока пусто.')}</div>`).join(''):sort(list).map(item).join('')||note('Список пока пуст.');
    return tabs+`<section class="ts-section"><div class="ts-section-title"><h3>${isEquipment?'Техника':groups[category]}</h3>${manage()?btn('＋ Добавить','catalog',`data-col="${col}" data-group="${category}"`):''}</div>${isEquipment?note('Экипаж назначается при добавлении техники в смену конкретного объекта.'):''}${body}</section>`;
  }
  function render(){
    if(!active())return;
    if(host.contains(document.activeElement)&&['INPUT','SELECT'].includes(document.activeElement.tagName))return;
    if(!allowed()){host.innerHTML=note('Нет доступа к табелю.');return;}
    const pending=S.jobs.filter(x=>x.status==='queued').length,failed=S.jobs.filter(x=>x.status!=='queued');
    const syncText=pending?`На устройстве: ${pending} · ожидают отправки`:!navigator.onLine?'Нет связи · показываем сохранённые данные':S.objectId&&C.collections.every(c=>S.ready[c])?'Данные подтверждены сервером':'Проверяем данные с сервером…';
    const html=`<div class="ts-heading"><div><h2>Учёт объекта</h2><p>Люди · техника · материалы</p></div><span class="ts-version">Тест 3.1.7</span></div><div class="ts-filters">${field('Объект',`<select id="ts-object"><option value="">Выберите объект</option>${state.objects.map(o=>choice(o.id,o.name,S.objectId)).join('')}</select>`)}${S.view==='object'?'':field(S.view==='month'?'Месяц':'Дата начала',`<input id="ts-date" type="${S.view==='month'?'month':'date'}" value="${S.view==='month'?S.date.slice(0,7):S.date}">`)}${S.view==='day'?field('Смена',`<select id="ts-shift">${choice('day','☀ День',S.shift)}${choice('night','☾ Ночь',S.shift)}</select>`):''}</div><div class="ts-tabs">${[['day','Смена'],['month','Месяц'],...(objectSummaryEnabled()?[['object','Весь объект']]:[]),['catalog','Справочники']].map(([v,t])=>btn(t,'view',`data-view="${v}" aria-pressed="${S.view===v}"`)).join('')}</div><div class="ts-sync" role="status">${E(syncText)}${pending?btn('Повторить отправку','retry'):''}</div>${Object.values(S.errors).map(e=>`<div class="ts-warning">${E(e)}</div>`).join('')}${failed.length?`<div class="ts-warning"><b>Требуют проверки: ${failed.length}</b>${failed.map(j=>`<div>${E(j.label)} · ${E(j.error||'Конфликт')} ${btn('Разобрать','conflict',`data-id="${j.id}"`)}</div>`).join('')}</div>`:''}${!S.local?note('Открываем локальное хранилище…'):S.view==='catalog'?catalogView():S.objectId?(S.view==='day'?dayView():S.view==='object'?objectView():monthView()):note('Выберите существующий объект. Новый объект можно добавить во вкладке «База».')}`;
    if(html!==S.lastHtml){host.innerHTML=html;S.lastHtml=html;}
  }
  function dialog(title,body,onSubmit){
    S.dialog?.close();const el=document.createElement('dialog');el.className='ts-dialog';el.innerHTML=`<form><div class="ts-dialog-title"><h3>${E(title)}</h3><button type="button" data-close aria-label="Закрыть">×</button></div><div class="ts-dialog-body">${body}</div><p class="ts-form-error" role="alert"></p><div class="ts-dialog-actions">${onSubmit?'<button class="ts-btn ts-primary" type="submit">Сохранить</button>':''}<button type="button" class="ts-btn" data-close>Закрыть</button></div></form>`;document.body.append(el);S.dialog=el;el.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>el.close());el.addEventListener('close',()=>{if(S.dialog===el)S.dialog=null;el.remove();});
    el.querySelector('form').onsubmit=async e=>{e.preventDefault();if(!onSubmit||adding)return;const button=el.querySelector('[type=submit]');adding=true;button.disabled=true;try{await onSubmit(new FormData(e.target),el);el.close();}catch(err){el.querySelector('.ts-form-error').textContent=err.message;}finally{adding=false;button.disabled=false;}};el.showModal();return el;
  }
  function catalogForm(col,id,group='worker'){
    if(!manage())return;const r=rows(col).find(x=>x.id===id),isPerson=col==='timesheetPeople';
    const category=r?.group||group;
    const body=field(isPerson?'Фамилия и имя':'Название / номер техники',input('name',r?.name,'required maxlength="160"'))+(isPerson?(r?field('Категория',`<select name="group">${Object.entries(groups).map(([k,v])=>choice(k,v,category)).join('')}</select>`):input('group',category,'type="hidden"')):field('Принадлежность',`<select name="ownership">${choice('own','Своя',r?.ownership||'own')}${choice('hired','Наёмная',r?.ownership)}</select>`)+field('Организация',input('contractor',r?.contractor,'maxlength="160"'))+note('Машинисты / водители выбираются при добавлении техники в смену объекта.'))+(r?'<label class="ts-check"><input type="checkbox" name="archive">Убрать из справочника (историю сохранить)</label>':'');
    dialog(isPerson?groups[category]:'Техника',body,async f=>{
      const name=C.text(f.get('name'),'Название');if(living(col).some(p=>p.id!==id&&p.name.trim().toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru')))throw Error('Такое имя уже есть. Для тёзки добавьте отчество или табельный номер.');
      const data=isPerson?{name,group:f.get('group'),deleted:f.has('archive')}:{name,ownership:f.get('ownership'),contractor:String(f.get('contractor')||'').trim(),crewIds:r?.crewIds||[],deleted:f.has('archive')};
      await enqueue([{collection:col,id:id||uid(),baseRevision:r?.revision||0,before:r?ownData(r):null,data}],isPerson?'Справочник сотрудников':'Справочник техники');
    });
  }
  function blankEntry(kind,entity,equipmentId=''){
    if(!object())throw Error('Выберите объект');
    return {kind,entityId:entity.id,name:entity.name,group:entity.group||'',ownership:entity.ownership||'',contractor:entity.contractor||'',objectId:S.objectId,objectName:object().name,date:S.date,shift:S.shift,scope:C.scope(S.objectId,S.date),minutes:null,idleMinutes:0,status:'unfilled',equipmentId,note:'',deleted:false};
  }
  function addForm(kind,group='worker'){
    if(!edit()||!object())return;if(kind==='equipment')return equipmentAssignmentForm();
    if(!['worker','itr'].includes(group))return;
    const list=sort(living('timesheetPeople').filter(p=>p.group===group));
    const snapshots=new Map(rows('timesheetEntries').map(r=>[r.id,C.clone(r)]));
    return dialog('Добавить: '+groups[group],note('Отметьте нужных сотрудников для этой смены.')+list.map(r=>`<label class="ts-check"><input type="checkbox" name="ids" value="${E(r.id)}">${E(r.name)}</label>`).join('')+(list.length?'':note('Сначала заполните этот справочник.')),async f=>{
      const changes=[];
      for(const id of f.getAll('ids')){const person=list.find(x=>x.id===id);if(!person)throw Error('Сотрудник не найден');const key=C.entryId('person',S.objectId,S.date,S.shift,id),old=snapshots.get(key);if(old&&!old.deleted)continue;changes.push({collection:'timesheetEntries',id:key,baseRevision:old?.revision||0,before:old?ownData(old):null,data:blankEntry('person',person)});}
      if(!changes.length)throw Error('Выберите новых сотрудников для этой смены');await enqueue(changes,'Добавлены: '+groups[group]);
    });
  }
  function equipmentAssignmentForm(entryId){
    if(!edit()||!object())return;
    const initial=entryId?dayEntries().find(r=>r.kind==='equipment'&&r.id===entryId):null;
    const machines=equipmentSort(living('timesheetEquipment'));
    // An archived machine can still keep or change the crew in an existing shift.
    if(initial&&!machines.some(m=>m.id===initial.entityId))machines.push({...initial,id:initial.entityId});
    if(!machines.length)return dialog('Техника на объекте',note('Сначала добавьте технику в справочник.'));
    let selected=initial?.entityId||machines.find(m=>!dayEntries().some(r=>r.kind==='equipment'&&r.entityId===m.id))?.id||machines[0].id;
    let snapshots,roster;
    const header=initial?note(E(initial.name)):field('Техника',`<select name="machine">${['own','hired'].map(ownership=>`<optgroup label="${ownership==='own'?'Своя техника':'Наёмная техника'}">${machines.filter(m=>m.ownership===ownership).map(m=>choice(m.id,m.name,selected)).join('')}</optgroup>`).join('')}</select>`);
    const el=dialog(initial?'Экипаж этой смены':'Добавить технику и экипаж',note(`${E(object().name)} · ${fmtDate(S.date)} · ${shiftName(S.shift)}`)+header+'<fieldset class="ts-assignment-roster" data-crew-fieldset><legend>Машинисты / водители</legend><div data-crew-slot-preview></div><div data-operator-options></div></fieldset><p class="ts-muted" data-crew-explanation>Состав назначается только на этот объект, дату и смену. Убранные из экипажа сотрудники остаются в смене со своими часами.</p>',async f=>{
      const machine=machines.find(m=>m.id===selected);if(!machine)throw Error('Выберите технику');
      const hired=machine.ownership==='hired';const selectedIds=new Set(hired?[]:f.getAll('operatorIds'));if([...selectedIds].some(id=>!roster.some(p=>p.id===id)))throw Error('Проверьте выбранный экипаж');
      const changes=[],machineKey=C.entryId('equipment',S.objectId,S.date,S.shift,machine.id),oldMachine=snapshots.get(machineKey);
      if(!oldMachine||oldMachine.deleted)changes.push({collection:'timesheetEntries',id:machineKey,baseRevision:oldMachine?.revision||0,before:oldMachine?ownData(oldMachine):null,data:blankEntry('equipment',machine)});
      for(const person of (hired?[]:roster)){
        const key=C.entryId('person',S.objectId,S.date,S.shift,person.id),old=snapshots.get(key),present=old&&!old.deleted;
        if(selectedIds.has(person.id)){
          if(present&&old.equipmentId&&old.equipmentId!==machine.id)throw Error(person.name+' уже назначен на другую технику этой смены.');
          if(present&&old.equipmentId===machine.id)continue;
          changes.push({collection:'timesheetEntries',id:key,baseRevision:old?.revision||0,before:old?ownData(old):null,data:present?{...ownData(old),equipmentId:machine.id}:blankEntry('person',person,machine.id)});
        }else if(present&&old.equipmentId===machine.id)changes.push({collection:'timesheetEntries',id:key,baseRevision:old.revision||0,before:ownData(old),data:{...ownData(old),equipmentId:''}});
      }
      if(changes.length)await enqueue(changes,'Техника и экипаж: '+machine.name);
    });
    const renderRoster=()=>{
      snapshots=new Map(rows('timesheetEntries').map(r=>[r.id,C.clone(r)]));
      roster=sort(living('timesheetPeople').filter(p=>p.group==='operator').map(C.clone));
      for(const r of dayEntries().filter(r=>r.kind==='person'&&personGroup(r)==='operator'&&r.equipmentId===selected))if(!roster.some(p=>p.id===r.entityId))roster.push({id:r.entityId,name:r.name,group:'operator'});
      const selectedMachine=machines.find(m=>m.id===selected),hired=selectedMachine?.ownership==='hired';
      el.querySelector('[data-crew-fieldset]').hidden=!!hired;
      el.querySelector('[data-crew-explanation]').textContent=hired?'Наёмная техника учитывается одной единицей, без штатного экипажа. Ранее сохранённые назначения не изменяются автоматически.':'Пустые штатные места не создают сотрудников и часы. Назначьте фамилии из списка или оставьте места свободными.';
      el.querySelector('[data-operator-options]').innerHTML=roster.map(person=>{
        const old=snapshots.get(C.entryId('person',S.objectId,S.date,S.shift,person.id)),assigned=old&&!old.deleted?old.equipmentId:'',elsewhere=assigned&&assigned!==selected;
        const other=elsewhere?dayEntries().find(r=>r.kind==='equipment'&&r.entityId===assigned)?.name||'другая техника':'';
        return `<label class="ts-check"><input type="checkbox" name="operatorIds" value="${E(person.id)}"${assigned===selected?' checked':''}${elsewhere?' disabled':''}><span>${E(person.name)}${other?`<small class="ts-muted">Уже назначен: ${E(other)}</small>`:''}</span></label>`;
      }).join('')||note('Добавьте машинистов / водителей в отдельный справочник.');
      const paintSlots=()=>{const checked=[...el.querySelectorAll('input[name=operatorIds]:checked')].map(c=>roster.find(p=>p.id===c.value)?.name).filter(Boolean);el.querySelector('[data-crew-slot-preview]').innerHTML=hired?'':crewSlotPreview(selectedMachine,checked);};
      el.querySelector('[data-operator-options]').onchange=paintSlots;paintSlots();
    };
    el.querySelector('[name=machine]')?.addEventListener('change',e=>{selected=e.target.value;renderRoster();});renderRoster();return el;
  }
  function addCrew(id){return equipmentAssignmentForm(id);}
  function crewForm(id){
    const machine=dayEntries().find(r=>r.kind==='equipment'&&r.id===id);if(!machine)return;
    const list=sort(crewFor(machine));
    const body=(edit()?btn('Изменить состав','crew-assign'):'')+note('Состав этой смены. Часы в общей строке назначаются каждому участнику. Здесь можно открыть отдельного сотрудника для исключения или комментария.')+crewSlotPreview(machine,list)+list.map(r=>`<div class="ts-row"><div class="ts-row-name"><strong>${E(r.name)}</strong><small>${E(statuses[r.status])}${r.minutes===null?'':' · '+C.fmt(r.minutes)+' ч'}</small></div>${btn(edit()?'Изменить':'Открыть','crew-person',`data-id="${E(r.id)}"`)}</div>`).join('');
    const el=dialog('Экипаж: '+machine.name,body);el.querySelector('[data-action=crew-assign]')?.addEventListener('click',()=>equipmentAssignmentForm(id));el.querySelectorAll('[data-action=crew-person]').forEach(button=>button.onclick=()=>entryForm(button.dataset.id));
  }
  function entryForm(id){
    const r=rows('timesheetEntries').find(x=>x.id===id);if(!r||r.deleted)return;
    const machines=entries().filter(x=>x.kind==='equipment'&&x.date===r.date&&x.shift===r.shift);
    const body=note(`${E(r.objectName)} · ${fmtDate(r.date)} · ${shiftName(r.shift)}`)+field('Отметка',`<select name="status">${Object.entries(statuses).map(([k,v])=>choice(k,v,r.status)).join('')}</select>`)+field('Отработано, часов',input('hours',C.fmt(r.minutes),'inputmode="decimal" placeholder="Например, 12 или 7,5"'))+(r.kind==='equipment'?field('Простой, часов',input('idle',C.fmt(r.idleMinutes),'inputmode="decimal"')):personGroup(r)==='operator'?field('Работал на технике',`<select name="equipmentId">${choice('','Без привязки',r.equipmentId)}${machines.map(m=>choice(m.entityId,m.name,r.equipmentId)).join('')}</select>`):'')+field('Комментарий',`<textarea name="note" maxlength="500">${E(r.note)}</textarea>`)+(edit()?'<label class="ts-check"><input type="checkbox" name="remove">Убрать строку из этой смены</label>':'');
    const el=dialog(r.name,body,edit()?async f=>{
      let status=f.get('status'),minutes=C.hours(f.get('hours'));if(status==='unfilled'&&minutes!==null)status='work';if(['off','absent'].includes(status))minutes=0;if(status==='work'&&minutes===null)throw Error('Укажите отработанные часы');
      const data={...ownData(r),status,minutes:status==='unfilled'?null:minutes,idleMinutes:r.kind==='equipment'?C.hours(f.get('idle'),false):0,equipmentId:r.kind==='person'?(personGroup(r)==='operator'?String(f.get('equipmentId')||''):r.equipmentId):'',note:String(f.get('note')||'').trim(),deleted:f.has('remove')};
      await enqueue([{collection:'timesheetEntries',id,baseRevision:r.revision||0,before:ownData(r),data}],'Часы: '+r.name);
    }:null);
    if(!edit())el.querySelectorAll('input,select,textarea').forEach(i=>i.disabled=true);
    else el.querySelector('[name=hours]').addEventListener('input',e=>{if(e.target.value.trim())el.querySelector('[name=status]').value='work';});
  }
  function materialForm(id){
    if(!object()||(!id&&!edit()))return;const r=rows('timesheetMaterials').find(x=>x.id===id);
    const body=field('Материал',input('material',r?.material,'required maxlength="160" placeholder="Например, ЩПС 0–40"'))+field('Поставщик',input('supplier',r?.supplier,'required maxlength="160"'))+`<div class="ts-two">${field('Количество',input('quantity',r?.quantity??'','required inputmode="decimal"'))}${field('Единица',`<select name="unit">${C.units.map(u=>choice(u,u,r?.unit||'т')).join('')}</select>`)}</div>`+field('Номер накладной',input('document',r?.document,'maxlength="160"'))+field('Комментарий',`<textarea name="note" maxlength="500">${E(r?.note||'')}</textarea>`)+(r&&edit()?'<label class="ts-check"><input type="checkbox" name="remove">Убрать поступление (сохранить историю)</label>':'');
    const el=dialog('Поступление материала',body,edit()?async f=>{
      const data={...(r?ownData(r):{objectId:S.objectId,objectName:object().name,date:S.date,shift:S.shift,scope:S.scope}),material:C.text(f.get('material'),'Материал'),supplier:C.text(f.get('supplier'),'Поставщик'),quantity:C.quantity(f.get('quantity')),unit:f.get('unit'),document:String(f.get('document')||'').trim(),note:String(f.get('note')||'').trim(),deleted:f.has('remove')};
      await enqueue([{collection:'timesheetMaterials',id:id||uid(),baseRevision:r?.revision||0,before:r?ownData(r):null,data}],'Поступление: '+data.material);
    }:null);if(!edit())el.querySelectorAll('input,select,textarea').forEach(i=>i.disabled=true);
  }
  function copyForm(){
    if(!edit()||!object())return;const generation=S.generation;const prev=new Date(S.date+'T12:00:00Z');prev.setUTCDate(prev.getUTCDate()-1);const fromDate=S.shift==='night'?S.date:prev.toISOString().slice(0,10);
    dialog('Взять состав прошлой смены',note('Переносится только состав людей, техники и привязка машинистов. Часы будут пустыми. Заполненные строки текущей смены сохранятся.')+field('Дата исходной смены',input('date',fromDate,'type="date" required'))+field('Смена',`<select name="shift">${choice('day','День',S.shift==='night'?'day':'night')}${choice('night','Ночь',S.shift==='night'?'day':'night')}</select>`),async f=>{
      const date=C.date(f.get('date')),shift=f.get('shift'),scope=C.scope(S.objectId,date);if(date===S.date&&shift===S.shift)throw Error('Выберите другую смену');
      let remote=S.remote.timesheetEntries;if(scope!==S.scope){const cached=await local('cache','get','timesheetEntries:'+scope);if(navigator.onLine){const snap=await wsRef.collection('timesheetEntries').where('scope','==',scope).get({source:'server'});remote=snap.docs.map(d=>({...d.data(),id:d.id}));}else if(cached)remote=cached.rows;else throw Error('Эта смена не сохранена на устройстве. Подключитесь к интернету.');}
      if(generation!==S.generation)throw Error('Учётная запись изменилась. Откройте форму заново.');
      const source=C.project(remote,S.jobs,'timesheetEntries').filter(x=>!x.deleted&&x.objectId===S.objectId&&x.date===date&&x.shift===shift);
      if(!source.length)throw Error('В выбранной смене нет состава');const existing=dayEntries();const changes=[];
      for(const r of source){const id=C.entryId(r.kind,S.objectId,S.date,S.shift,r.entityId);if(existing.some(x=>x.id===id))continue;changes.push(change('timesheetEntries',id,{...ownData(r),date:S.date,shift:S.shift,scope:S.scope,objectName:object().name,minutes:null,idleMinutes:0,status:'unfilled',note:'',deleted:false}));}
      if(!changes.length)throw Error('Весь состав уже добавлен');await enqueue(changes,'Перенесён состав смены');
    });
  }
  function exportCsv(materials){
    if(!hasPermission('timesheet_export'))return;
    if(S.jobs.some(j=>j.scope===S.scope))return error(Error('Сначала отправьте и разберите все изменения этого месяца.'));
    const col=materials?'timesheetMaterials':'timesheetEntries';if(!navigator.onLine||!S.ready[col])return error(Error('Для выгрузки дождитесь подтверждения данных сервером.'));
    const list=living(col).filter(x=>x.scope===S.scope).sort((a,b)=>a.date.localeCompare(b.date)||a.shift.localeCompare(b.shift));
    const data=materials?[['Объект','Дата начала смены','Смена','Материал','Поставщик','Количество','Ед.','Накладная','Комментарий'],...list.map(r=>[r.objectName,fmtDate(r.date),shiftName(r.shift),r.material,r.supplier,String(r.quantity).replace('.',','),r.unit,r.document,r.note])]:[['Объект','Дата начала смены','Смена','Вид','Сотрудник / техника','Отметка','Часы','Простой, ч','Организация','Комментарий'],...list.map(r=>[r.objectName,fmtDate(r.date),shiftName(r.shift),r.kind==='person'?'Сотрудник':'Техника',r.name,statuses[r.status],C.fmt(r.minutes),C.fmt(r.idleMinutes),r.contractor,r.note])];
    const a=document.createElement('a'),url=URL.createObjectURL(new Blob([C.csv(data)],{type:'text/csv;charset=utf-8;'}));a.href=url;a.download=(materials?'materialy-':'tabel-')+S.date.slice(0,7)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function describe(r){if(!r)return 'Записи нет';if('minutes'in r)return `${r.name}: ${statuses[r.status]}${r.minutes===null?'':' · '+C.fmt(r.minutes)+' ч'}${r.deleted?' · удалено':''}${r.note?' · '+r.note:''}`;if('quantity'in r)return `${r.material}: ${r.quantity} ${r.unit} · ${r.supplier}${r.deleted?' · удалено':''}`;return r.name+(r.deleted?' · в архиве':'');}
  async function conflictForm(id){
    const op=S.jobs.find(x=>x.id===id);if(!op)return;const generation=S.generation;
    const canRetry=op.changes.every(ch=>['timesheetPeople','timesheetEquipment'].includes(ch.collection)?manage():edit());
    const el=dialog('Проверка изменений',`<p>${E(op.label)}</p><div class="ts-warning">${E(op.error||'Изменения не отправлены')}</div>${(op.conflicts||[]).map(c=>`<div class="ts-conflict"><p><b>В базе:</b> ${E(describe(c.server))}</p><p><b>Ваша правка:</b> ${E(describe(c.proposed))}</p></div>`).join('')}<div class="ts-toolbar">${canRetry?btn(op.status==='conflict'?'Применить мою правку':'Повторить отправку','resolve-local'):''}${btn('Оставить данные базы','resolve-server')}</div>`);
    el.querySelector('[data-action=resolve-server]').onclick=async()=>{try{await local('jobs','delete',op.id);await loadJobs();el.close();render();}catch(e){error(e);}};
    el.querySelector('[data-action=resolve-local]')?.addEventListener('click',async e=>{
      if(!navigator.onLine)return error(Error('Для проверки нужна связь'));e.target.disabled=true;
      try{
        const refs=op.changes.map(ch=>wsRef.collection(ch.collection).doc(ch.id));const snaps=await Promise.all(refs.map(r=>r.get({source:'server'})));
        if(generation!==S.generation)return;
        if(op.status==='conflict'){
          // Do not overwrite an edit that happened after the comparison was shown.
          const changedAgain=snaps.some((s,i)=>{const shown=(op.conflicts||[]).find(c=>c.id===op.changes[i].id&&c.collection===op.changes[i].collection);return shown&&(s.exists?s.data().revision||0:0)!==(shown.server?.revision||0);});
          if(changedAgain){op.conflicts=snaps.map((s,i)=>({collection:op.changes[i].collection,id:op.changes[i].id,server:s.exists?s.data():null,proposed:op.changes[i].data}));await local('jobs','put',op);await loadJobs();el.close();await conflictForm(id);throw Error('Данные снова изменились. Сравните обновлённые значения.');}
          snaps.forEach((s,i)=>{op.changes[i].baseRevision=s.exists?s.data().revision||0:0;op.changes[i].before=s.exists?s.data():null;});
        }
        op.status='queued';delete op.error;delete op.conflicts;await local('jobs','put',op);await loadJobs();el.close();render();replay();
      }catch(e){error(e);}finally{e.target.disabled=false;}
    });
  }
  async function history(){
    const el=dialog('История изменений',note('Загружаем…'));const scope=S.scope;
    try{const snap=await wsRef.collection('timesheetChanges').where('scope','==',scope).get({source:'server'});const list=snap.docs.map(d=>d.data()).sort((a,b)=>b.createdAt-a.createdAt).slice(0,100);el.querySelector('.ts-dialog-body').innerHTML=list.map(x=>`<section class="ts-history"><b>${E(x.label)}</b><small>${E(x.name)} · ${new Date(x.createdAt).toLocaleString('ru-RU')}</small>${x.changes.map(c=>`<p>${E(describe(c.before))} → ${E(describe(c.after))}</p>`).join('')}</section>`).join('')||note('Изменений пока нет.');}catch(e){el.querySelector('.ts-dialog-body').textContent='Не удалось загрузить историю: '+e.message;}
  }
  host.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b)return;const {action,id,col,view,group}=b.dataset;
    const actions={view:()=>{if(view==='object'&&!objectSummaryEnabled())return;const previous=S.view;S.view=view;if(previous==='object'&&view!=='object')stopObjectView();if(view==='object')objectPeriod().catch(error);render();},'object-day':()=>{S.date=b.dataset.date;S.shift=b.dataset.shift;S.view='day';stopObjectView();period().catch(error);render();},'add-person':()=>addForm('person',group),'add-equipment':()=>addForm('equipment'),entry:()=>entryForm(id),crew:()=>crewForm(id),'add-crew':()=>addCrew(id),'hours-preset':()=>inlineButton(id,b.dataset.value),'hours-step':()=>inlineButton(id,undefined,b.dataset.delta),'workers-value':()=>workersValue(b),'workers-apply':applyWorkers,copy:copyForm,'catalog-group':()=>{S.catalogGroup=group;render();},catalog:()=>catalogForm(col,id,group),material:()=>materialForm(id),retry:replay,conflict:()=>conflictForm(id),export:()=>exportCsv(false),'export-materials':()=>exportCsv(true),history};
    try{Promise.resolve(actions[action]?.()).catch(error);}catch(e){error(e);}
  });
  host.addEventListener('change',e=>{const t=e.target;if(t.matches('.ts-inline-hours')){saveInlineInput(t);return;}if(t.id==='ts-workers-hours'){S.bulkValue=t.value;return;}if(t.id==='ts-object')S.objectId=t.value;else if(t.id==='ts-date'){if(!t.value)return;S.date=t.type==='month'?t.value+'-01':t.value;}else if(t.id==='ts-shift')S.shift=t.value;else return;S.bulkWorkers=false;S.bulkRows=[];S.bulkValue='12';t.blur();period().catch(error);if(S.view==='object')objectPeriod().catch(error);render();});
  host.addEventListener('focusin',e=>{if(e.target.matches('.ts-inline-hours')){const id=e.target.dataset.id;if(!inlineDrafts.get(id)?.dirty&&!inlineChains.has(id))inlineDrafts.delete(id);captureInline(e.target);e.target.select();}else if(e.target.id==='ts-workers-hours'){captureWorkers();e.target.select();}});
  host.addEventListener('input',e=>{if(e.target.matches('.ts-inline-hours')){const draft=captureInline(e.target);if(draft){draft.raw=e.target.value;draft.dirty=true;}e.target.removeAttribute('aria-invalid');}else if(e.target.id==='ts-workers-hours'){captureWorkers();S.bulkValue=e.target.value;}});
  host.addEventListener('focusout',e=>{if(!e.target.matches('.ts-inline-hours'))return;saveInlineInput(e.target);const id=e.target.dataset.id;setTimeout(()=>{if(document.activeElement!==e.target&&!inlineDrafts.get(id)?.dirty){inlineDrafts.delete(id);render();}},0);});
  host.addEventListener('keydown',e=>{if(!e.target.matches('.ts-inline-hours'))return;if(e.key==='Enter'){e.preventDefault();saveInlineInput(e.target);e.target.blur();}else if(e.key==='Escape'){e.preventDefault();const draft=inlineDrafts.get(e.target.dataset.id);if(draft){const value=commonHours(draft.records);e.target.value=value.mixed?'':C.fmt(value.minutes);draft.dirty=false;}e.target.blur();}});
  host.addEventListener('pointerdown',e=>{if(e.target.closest('[data-action^="hours-"]')&&document.activeElement?.matches('.ts-inline-hours'))e.preventDefault();});
  window.addEventListener('review-flags-changed',()=>{if(!objectSummaryEnabled()&&S.view==='object'){S.view='month';stopObjectView();}render();});
  window.Timesheet={session,render,reset};
  const previousRender=window.renderAll;window.renderAll=function(){previousRender.apply(this,arguments);session();render();};
  const previousStop=window.stopSync;window.stopSync=function(){reset();return previousStop.apply(this,arguments);};
  auth.onAuthStateChanged(()=>{reset();session();});
  window.addEventListener('online',()=>{replay();render();});window.addEventListener('offline',render);
  setInterval(()=>{session();if(allowed()&&S.local){loadJobs().then(()=>{render();replay();}).catch(error);}},6000);
  session();
})();

