/* Field ledger 3.2.0. Loaded only by index-test.html. */
(function () {
  'use strict';
  if (window.Timesheet || firebaseConfig.projectId !== 'samosval-offline') return;
  const C=window.TimesheetCore, E=escapeHtml;
  const names={timesheetPeople:'Люди',timesheetEquipment:'Техника',timesheetEntries:'Табель',timesheetMaterials:'Материалы'};
  const groups={worker:'Рабочие',itr:'ИТР',operator:'Машинисты / водители'};
  const statuses={unfilled:'Не заполнено',work:'Работал',off:'Выходной',absent:'Отсутствовал'};
  const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date());
  const uid=()=>{if(crypto.randomUUID)return crypto.randomUUID();const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');};
  const S={user:'',generation:0,local:null,jobs:[],remote:{},unsubs:[],periodUnsubs:[],objectId:'',date:today(),shift:'day',view:'day',catalogGroup:'worker',scope:'',ready:{},errors:{},busy:false,dialog:null,lastHtml:'',bulkWorkers:false,bulkRows:[],bulkValue:'12',bulkSaving:false,clockDraft:null,clockSaving:false,fillBusy:false};
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
  function entries(){return C.effectiveEntries(rows('timesheetEntries').filter(x=>x.scope===C.scope(S.objectId,S.date)));}
  function dayEntries(){return entries().filter(x=>x.date===S.date&&x.shift===S.shift);}
  function object(){return state.objects.find(x=>x.id===S.objectId);}
  function ownData(row){const d={...row};for(const k of ['id','revision','lastOpId','updatedBy','updatedName','updatedAt','pending','virtual'])delete d[k];return d;}
  function change(col,id,data){const old=rows(col).find(x=>x.id===id);return {collection:col,id,baseRevision:old?.revision||0,before:old?ownData(old):null,data};}
  function choice(value,label,selected){return `<option value="${E(value)}"${value===selected?' selected':''}>${E(label)}</option>`;}
  function field(label,control){return `<label class="ts-field"><span>${label}</span>${control}</label>`;}
  function input(name,value='',extra=''){return `<input name="${name}" value="${E(value)}" ${extra}>`;}
  function btn(label,action,extra=''){return `<button type="button" class="ts-btn${['entry','crew'].includes(action)?' ts-details':''}" data-action="${action}" ${extra}>${label}</button>`;}
  function note(s){return `<p class="ts-muted">${s}</p>`;}
  function localOpen(name){return new Promise((resolve,reject)=>{const req=indexedDB.open(name,1);req.onupgradeneeded=()=>{req.result.createObjectStore('jobs',{keyPath:'id'});req.result.createObjectStore('cache',{keyPath:'key'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(Error('Закройте другие вкладки, чтобы открыть локальное хранилище'));});}
  function local(store,method,value){const database=S.local;if(!database)return Promise.reject(Error('Локальное хранилище ещё не готово'));return new Promise((resolve,reject)=>{const tx=database.transaction(store,method==='get'||method==='getAll'?'readonly':'readwrite');const req=tx.objectStore(store)[method](value);let result;req.onsuccess=()=>{result=req.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error||req.error);tx.onabort=()=>reject(tx.error||Error('Не удалось сохранить на устройстве'));});}
  async function loadJobs(){const generation=S.generation;const jobs=await local('jobs','getAll');if(generation===S.generation)S.jobs=jobs.sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));}
  function reset(){S.generation++;inlineDrafts.clear();inlineChains.clear();S.bulkWorkers=false;S.bulkRows=[];S.bulkSaving=false;S.clockDraft=null;S.clockSaving=false;S.fillBusy=false;for(const u of [...S.unsubs,...S.periodUnsubs])u();S.unsubs=[];S.periodUnsubs=[];S.local?.close();S.local=null;S.user='';S.scope='';S.jobs=[];S.ready={};S.errors={};S.busy=false;for(const k of C.collections)S.remote[k]=[];S.dialog?.close();S.lastHtml='';host.innerHTML='';}
  async function session(){
    if(!allowed()){if(S.user)reset();return;}
    if(S.user===currentUid)return;
    reset();S.user=currentUid;const generation=S.generation;
    try {
      const database=await localOpen('dt_timesheet_v1_'+firebaseConfig.projectId+'_'+WORKSPACE_ID+'_'+S.user);
      if(generation!==S.generation){database.close();return;}S.local=database;await loadJobs();
      if(generation!==S.generation)return;
      for(const col of ['timesheetPeople','timesheetEquipment','timesheetSettings']){
        const cached=await local('cache','get',col);if(generation!==S.generation)return;if(cached)S.remote[col]=cached.rows;
        S.unsubs.push(wsRef.collection(col).onSnapshot({includeMetadataChanges:true},snap=>receive(col,col,snap,generation),e=>syncError(col,e,generation)));
      }
      if(!state.objects.some(o=>o.id===S.objectId))S.objectId=state.shift?.objectId||state.objects[0]?.id||'';
      await period();render();replay();
    }catch(e){if(generation===S.generation){S.errors.local='Не удалось открыть хранилище: '+e.message;render();}}
  }
  function syncError(key,e,generation){if(generation!==S.generation)return;S.ready[key]=false;S.errors[key]=(e.code==='permission-denied'?'Нет доступа к базе табеля. Администратору нужно применить правила для тестовой базы.':e.message);render();}
  function receive(col,key,snap,generation){if(generation!==S.generation)return;if(snap.metadata.fromCache&&snap.docs.length===0&&S.remote[col].length){S.ready[col]=false;render();return;}S.remote[col]=snap.docs.map(d=>({...d.data(),id:d.id}));S.ready[col]=!snap.metadata.fromCache;delete S.errors[col];local('cache','put',{key,rows:S.remote[col]}).catch(e=>{S.errors.local='Кэш не сохранён: '+e.message;render();});render();}
  async function period(){
    if(!S.local||!S.objectId)return;
    const scope=C.scope(S.objectId,S.date);if(S.scope===scope)return;
    S.scope=scope;const generation=S.generation;
    S.periodUnsubs.forEach(u=>u());S.periodUnsubs=[];
    for(const col of ['timesheetEntries','timesheetMaterials','timesheetShifts']){S.remote[col]=[];S.ready[col]=false;delete S.errors[col];}
    render();
    for(const col of ['timesheetEntries','timesheetMaterials','timesheetShifts']){
      const key=col+':'+scope,cached=await local('cache','get',key);if(generation!==S.generation||S.scope!==scope)return;if(cached)S.remote[col]=cached.rows;
      S.periodUnsubs.push(wsRef.collection(col).where('scope','==',scope).onSnapshot({includeMetadataChanges:true},snap=>{if(S.scope===scope)receive(col,key,snap,generation);},e=>{if(S.scope===scope)syncError(col,e,generation);}));
    }
    render();
  }
  let adding=false;
  async function enqueue(changes,label,quiet=false){
    if(!allowed()||!S.local)throw Error('Войдите в приложение и дождитесь открытия табеля');
    if(!changes.length)return;
    if(changes.some(ch=>['timesheetPeople','timesheetEquipment','timesheetSettings'].includes(ch.collection)?!manage():!edit()))throw Error('Нет права на изменение этого раздела');
    const ops=[],stamp=Math.max(Date.now(),...S.jobs.map(x=>x.createdAt+1));
    for(let i=0;i<changes.length;i+=4){const op={id:uid(),uid:S.user,scope:changes[i]?.data.scope||'catalog',label,createdAt:stamp+i,status:'queued',changes:changes.slice(i,i+4)};C.validateOperation(op);ops.push(op);}
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
  function summary(){const d=dayEntries(),trucks=C.lineTrucks(state,S.objectId,S.date);return `<div class="ts-stats">${[['worker','Рабочие'],['itr','ИТР'],['operator','Машинисты'],['equipment','Техника']].map(([kind,label])=>{const a=d.filter(r=>kind==='equipment'?r.kind==='equipment':r.kind==='person'&&personGroup(r)===kind);return `<div data-summary="${kind}"><strong>${a.length+(kind==='equipment'?trucks.length:0)}</strong><span>${label}</span><small>${kind==='equipment'&&trucks.length?a.length+' ед. + '+trucks.length+' сам.':C.fmt(a.reduce((n,r)=>n+(r.minutes||0),0))+' '+(kind==='equipment'?'маш.-ч':'чел.-ч')}</small></div>`;}).join('')}</div>`;}
  const equipmentStyle=C.equipmentStyle;
  const equipmentSort=list=>list.sort((a,b)=>equipmentStyle(a).order-equipmentStyle(b).order||a.name.localeCompare(b.name,'ru',{numeric:true}));
  const crewKey=machine=>'crew:'+machine.id;
  function crewFor(machine){if(machine.ownership==='hired')return [];return entries().filter(r=>r.kind==='person'&&personGroup(r)==='operator'&&r.equipmentId===machine.entityId&&r.objectId===machine.objectId&&r.date===machine.date&&r.shift===machine.shift);}
  function editorRows(id){
    if(id.startsWith('crew:')){const machine=entries().find(r=>r.id===id.slice(5)&&r.kind==='equipment');return machine?crewFor(machine):[];}
    const r=entries().find(x=>x.id===id);return r?[r]:[];
  }
  function commonHours(list){const first=list[0];return {minutes:first?.minutes??null,status:first?.status||'unfilled',mixed:list.some(r=>r.minutes!==first.minutes||r.status!==first.status)};}
  function hoursEditor(id,label,records){
    const value=commonHours(records),draft=inlineDrafts.get(id),quick=C.fmt(defaultMinutes()),alternate=defaultMinutes()===720?'13':'12';
    if(!edit())return `<span class="ts-hours">${value.mixed?'Разные':value.status==='unfilled'?'—':['off','absent'].includes(value.status)?statuses[value.status]:C.fmt(value.minutes)+' ч'}</span>`;
    return `<div class="ts-inline-editor"><button type="button" class="ts-hour-btn" data-action="hours-preset" data-id="${E(id)}" data-value="${E(quick)}" aria-label="По времени смены: ${E(quick)} часов" title="По времени смены">${E(quick)}</button><button type="button" class="ts-hour-btn" data-action="hours-preset" data-id="${E(id)}" data-value="${alternate}" aria-label="Поставить ${alternate} часов">${alternate}</button><button type="button" class="ts-hour-btn ts-step" data-action="hours-step" data-id="${E(id)}" data-delta="-1" aria-label="Уменьшить на час">−</button><input class="ts-inline-hours" data-id="${E(id)}" value="${E(draft?.dirty?draft.raw:value.mixed?'':C.fmt(value.minutes))}" aria-invalid="${!!draft?.error}" inputmode="decimal" enterkeyhint="done" autocomplete="off" aria-label="Часы: ${E(label)}" placeholder="${value.mixed?'≠':'—'}" title="${value.mixed?'У участников разные часы. Введите часы каждому.':'Часы от 0 до 24, например 12 или 7,5'}"><button type="button" class="ts-hour-btn ts-step" data-action="hours-step" data-id="${E(id)}" data-delta="1" aria-label="Добавить час">+</button></div>`;
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
    if(!list.length)return `<div class="ts-empty-crew"><span>Экипаж не добавлен</span>${edit()?btn('＋ Экипаж','add-crew',`data-id="${E(machine.id)}"`):''}</div>`;
    const value=commonHours(list),label=(list.length===1?style.one:style.many)+' · '+list.length;
    const total=C.fmt(list.reduce((sum,r)=>sum+(r.minutes||0),0));
    const hint=value.mixed?'Разные часы · '+total+' чел.-ч':list.length>1?'Всего '+total+' чел.-ч':value.status==='work'?'За смену':statuses[value.status];
    return `<div class="ts-row ts-entry-row ts-crew-row ${list.some(r=>r.pending)?'ts-pending':''}" data-crew-id="${E(machine.entityId)}"><div class="ts-row-name"><button type="button" class="ts-crew-label" data-action="crew" data-id="${E(machine.id)}">${E(label)}${list.some(r=>r.pending)?'<span class="ts-pending-dot" aria-label="Ожидает отправки">●</span>':''}</button><small>${E(hint)}</small></div>${hoursEditor(id,'каждому в экипаже '+machine.name,list)}${btn('⋯','crew',`data-id="${E(machine.id)}" aria-label="Состав экипажа: ${E(machine.name)}" title="Состав и индивидуальные часы"`)}${rowFeedback(id)}</div>`;
  }
  function equipmentSection(title,list,ownership){return `<section class="ts-section ts-compact-section ts-ledger-equipment" data-group="equipment" data-ownership="${ownership}"><div class="ts-section-title"><h3>${title}<span class="ts-section-count">${list.length}</span></h3><span class="ts-column-label">Часы</span></div>${equipmentSort(list).map(machine=>`<div class="ts-machine-block ts-tone-${equipmentStyle(machine).tone}" data-machine-id="${E(machine.entityId)}">${rowCard(machine)}${crewRow(machine)}</div>`).join('')||note('Добавьте технику в смену.')}</section>`;}
  function workersBar(){return `<div class="ts-workers-bar"><span>Часы всем рабочим</span><div class="ts-workers-controls"><button class="ts-hour-btn" type="button" data-action="workers-value" data-value="12">12</button><button class="ts-hour-btn" type="button" data-action="workers-value" data-value="13">13</button><button class="ts-hour-btn" type="button" data-action="workers-value" data-delta="-1" aria-label="Уменьшить часы рабочим">−</button><input id="ts-workers-hours" inputmode="decimal" enterkeyhint="done" aria-label="Часы всем рабочим" value="${E(S.bulkWorkers?S.bulkValue:C.fmt(defaultMinutes()))}"><button class="ts-hour-btn" type="button" data-action="workers-value" data-delta="1" aria-label="Добавить час рабочим">+</button>${btn('Поставить всем','workers-apply',S.bulkSaving?'disabled':'')}</div></div>`;}
  function peopleSection(kind,label,list){return `<section class="ts-section ts-compact-section ts-ledger-people" data-group="${kind}"><div class="ts-section-title"><h3>${label}<span class="ts-section-count">${list.length}</span></h3>${edit()&&['worker','itr'].includes(kind)?btn('＋ Добавить','add-person',`data-group="${kind}" aria-label="Добавить: ${label}"`):''}</div>${edit()&&kind==='worker'&&list.length?workersBar():''}${sort(list).map(rowCard).join('')||note('Пока нет записей.')}</section>`;}
  function dayView(){
    const d=dayEntries(),machines=d.filter(r=>r.kind==='equipment'),own=machines.filter(r=>r.ownership!=='hired'),hired=machines.filter(r=>r.ownership==='hired');
    const grouped=new Set(machines.flatMap(m=>crewFor(m).map(p=>p.id)));
    const loose=d.filter(r=>r.kind==='person'&&personGroup(r)==='operator'&&!grouped.has(r.id));
    return clockView()+summary()+`<div class="ts-toolbar ts-day-toolbar">${edit()?btn('＋ Техника','add-equipment')+btn('Взять состав','copy')+btn('Пустым по '+C.fmt(defaultMinutes())+' ч','fill-defaults',S.fillBusy?'disabled':''):''}</div>`+truckCountView()+equipmentSection('Своя техника',own,'own')+(hired.length?equipmentSection('Привлечённая техника',hired,'hired'):'')+(loose.length?peopleSection('operator','Машинисты / водители без техники',loose):'')+materialsView(false)+peopleSection('itr','ИТР',d.filter(r=>r.kind==='person'&&personGroup(r)==='itr'))+peopleSection('worker','Рабочие',d.filter(r=>r.kind==='person'&&personGroup(r)==='worker'));
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
        const base=operation.raw!==undefined?C.hours(operation.raw):value.minutes;minutes=Math.max(0,Math.min(1440,(base??defaultMinutes())+operation.delta*60));
      }else minutes=C.hours(operation.value);
      attempted=C.fmt(minutes);const status=minutes===null?'unfilled':'work';
      if(id.startsWith('crew:')&&list[0].scope===S.scope){
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
  function captureWorkers(){if(!S.bulkWorkers){S.bulkValue=byId('ts-workers-hours')?.value||C.fmt(defaultMinutes());S.bulkRows=dayEntries().filter(r=>r.kind==='person'&&personGroup(r)==='worker').map(C.clone);S.bulkWorkers=true;}}
  function workersValue(button){const input=byId('ts-workers-hours');if(!input)return;captureWorkers();try{const minutes=button.dataset.value!==undefined?C.hours(button.dataset.value,false):Math.max(0,Math.min(1440,(C.hours(input.value)??720)+Number(button.dataset.delta)*60));input.value=C.fmt(minutes);S.bulkValue=input.value;input.removeAttribute('aria-invalid');}catch(e){input.setAttribute('aria-invalid','true');error(e);}}
  async function applyWorkers(){if(!edit()||S.bulkSaving)return;const input=byId('ts-workers-hours');if(!input)return;captureWorkers();const minutes=C.hours(input.value,false),list=S.bulkRows;if(!list.length)throw Error('В эту смену ещё не добавлены рабочие');S.bulkSaving=true;host.querySelector('[data-action=workers-apply]').disabled=true;try{await enqueue(list.map(r=>({collection:'timesheetEntries',id:r.id,baseRevision:r.revision||0,before:ownData(r),data:{...ownData(r),minutes,status:'work'}})),'Часы всем рабочим');S.bulkWorkers=false;S.bulkRows=[];}finally{S.bulkSaving=false;S.lastHtml='';render();}}
  function shiftRecord(day=S.date,shift=S.shift){return living('timesheetShifts').find(r=>r.objectId===S.objectId&&r.date===day&&r.shift===shift);}
  function shiftClock(day=S.date,shift=S.shift){const row=shiftRecord(day,shift);return {row,start:row?.startTime||(shift==='night'?'20:00':'08:00'),end:row?.endTime||(shift==='night'?'08:00':'20:00')};}
  const defaultMinutes=()=>{const clock=shiftClock();return C.duration(clock.start,clock.end);};
  function captureClock(){if(!S.clockDraft){const c=shiftClock();S.clockDraft={...c,objectId:S.objectId,objectName:object()?.name||'',date:S.date,shift:S.shift,generation:S.generation};}return S.clockDraft;}
  function clockView(){const c=S.clockDraft||shiftClock();let minutes=null;try{minutes=C.duration(c.start,c.end);}catch(_){}return `<div class="ts-clock"><div class="ts-clock-times"><label>С <input id="ts-start-time" type="time" value="${E(c.start)}" aria-label="Начало смены"${edit()?'':' disabled'}></label><label>До <input id="ts-end-time" type="time" value="${E(c.end)}" aria-label="Конец смены"${edit()?'':' disabled'}></label><strong>${minutes===null?'—':C.fmt(minutes)} ч${minutes!==null&&C.clock(c.end)<=C.clock(c.start)?'<small>до следующего дня</small>':''}</strong>${edit()?btn('Применить','clock-save',S.clockSaving?'disabled':''):''}</div>${edit()?`<div class="ts-clock-presets">${[['07:00','19:00','7–19'],['08:00','20:00','8–20'],['20:00','08:00','20–8']].map(([start,end,label])=>btn(label,'clock-preset',`data-start="${start}" data-end="${end}"${S.clockSaving?' disabled':''}`)).join('')}<span>Для быстрого заполнения часов</span></div>`:''}</div>`;}
  async function saveClock(start,end){
    if(!edit()||S.clockSaving)return;const d=captureClock();start=start||byId('ts-start-time').value;end=end||byId('ts-end-time').value;C.duration(start,end);S.clockSaving=true;
    const data={objectId:d.objectId,objectName:d.objectName,date:d.date,shift:d.shift,scope:C.scope(d.objectId,d.date),startTime:start,endTime:end,deleted:false};
    try{await enqueue([{collection:'timesheetShifts',id:C.shiftId(d.objectId,d.date,d.shift),baseRevision:d.row?.revision||0,before:d.row?ownData(d.row):null,data}],'Время смены',true);if(d.generation===S.generation){S.clockDraft=null;S.bulkWorkers=false;S.bulkValue=C.fmt(C.duration(start,end));}}finally{S.clockSaving=false;S.lastHtml='';render();}
  }
  async function goDate(day,shift=S.shift,view=S.view){
    C.date(day);S.date=day;S.shift=shift;S.view=view;S.clockDraft=null;S.bulkWorkers=false;S.bulkRows=[];S.bulkValue='';await period();S.lastHtml='';render();
  }
  function dateNav(){return `<div class="ts-date-nav">${btn('‹','date-nav','data-delta="-1" aria-label="Предыдущий день"')}${btn('Вчера','date-nav','data-day="yesterday"')}${btn('Сегодня','date-nav','data-day="today"')}${btn('›','date-nav','data-delta="1" aria-label="Следующий день"')}</div>`;}
  async function fillDefaults(){
    if(!edit()||S.fillBusy)return;const minutes=defaultMinutes(),list=dayEntries().filter(r=>r.minutes===null&&r.status==='unfilled');if(!list.length)return toast('Все часы этой смены уже заполнены');
    const changes=list.map(r=>({collection:'timesheetEntries',id:r.id,baseRevision:r.revision||0,before:r.virtual?null:ownData(r),data:{...ownData(r),minutes,status:'work'}}));changes.forEach(ch=>C.validate(ch.collection,ch.data,ch.id));S.fillBusy=true;
    try{await enqueue(changes,'Пустые строки по '+C.fmt(minutes)+' ч');}finally{S.fillBusy=false;render();}
  }
  function truckCountView(){const trucks=C.lineTrucks(state,S.objectId,S.date);if(!trucks.length)return '';return `<details class="ts-line-trucks"><summary>Самосвалы на линии за дату: <b>${trucks.length}</b></summary><div>${trucks.map(t=>`<span>${E(t.name)}</span>`).join('')}</div></details>`;}
  const directionNames={receipt:'Поступление',production:'В конус',shipment:'На завод',transfer_out:'Передано',transfer_in:'Поступило с объекта'};
  function materialRows(){return [...living('timesheetMaterials').map(r=>({...r,direction:'receipt'})),...C.materialsFromArchives(state.archive)].filter(x=>x.scope===S.scope);}
  function routeFields(route={},sourceId=S.objectId){return field('Материал',input('material',route.material||'Гранулят','required maxlength="160" placeholder="Гранулят, диабаз…"'))+field('Куда направить',`<select name="destinationType">${Object.entries(C.routeTypes).map(([k,v])=>choice(k,v,route.destinationType||'stockpile')).join('')}</select>`)+`<div data-route-place>${field('Конус / завод',input('destinationName',route.destinationName||'','maxlength="160" placeholder="Название или номер"'))}</div><div data-route-object>${field('Объект назначения',`<select name="targetObjectId"><option value="">Выберите объект</option>${state.objects.filter(o=>o.id!==sourceId).map(o=>choice(o.id,o.name,route.targetObjectId)).join('')}</select>`)}</div>`;}
  function routeToggle(el){const toggle=()=>{const transfer=el.querySelector('[name=destinationType]').value==='object';el.querySelector('[data-route-place]').hidden=transfer;el.querySelector('[data-route-object]').hidden=!transfer;el.querySelector('[name=destinationName]').required=!transfer;el.querySelector('[name=targetObjectId]').required=transfer;};el.querySelector('[name=destinationType]').addEventListener('change',toggle);toggle();}
  function readRoute(f,sourceId){const target=state.objects.find(o=>o.id===f.get('targetObjectId'));return C.materialRoute({material:f.get('material'),destinationType:f.get('destinationType'),destinationName:f.get('destinationName'),targetObjectId:target?.id||'',targetObjectName:target?.name||''},sourceId);}
  function routeForm(){
    if(!manage()||!object())return;const objectId=S.objectId,id=C.settingsId(objectId),r=living('timesheetSettings').find(x=>x.id===id);
    const el=dialog('Материал с линии · '+object().name,note('Это направление будет предложено при закрытии смены. Его можно изменить перед закрытием.')+routeFields(r,objectId),async f=>{const data={objectId,...readRoute(f,objectId),deleted:false};await enqueue([{collection:'timesheetSettings',id,baseRevision:r?.revision||0,before:r?ownData(r):null,data}],'Направление материала');});routeToggle(el);
  }
  async function prepareClose(shift,logs){
    if(!hasPermission('close_shift'))throw Error('Нет права закрывать смену');
    const quantity=C.regularVolume(logs);if(!quantity)return null;
    const source=state.objects.find(o=>o.id===shift.objectId)||state.objects.find(o=>o.name===shift.objectName);if(!source)throw Error('Выберите существующий объект для смены перед закрытием');
    let route=shift.materialRoute||living('timesheetSettings').find(r=>r.objectId===source.id),warning='';
    if(!route){try{const snap=await wsRef.collection('timesheetSettings').doc(C.settingsId(source.id)).get({source:'server'});if(snap.exists&&!snap.data().deleted)route=snap.data();}catch(_){warning='Сохранённое направление недоступно. Укажите его для этой смены.';}}
    const day=C.sourceDay(shift.startDate,shift.startedAt),hour=shift.startedAt?Number(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:'Europe/Moscow'}).format(new Date(shift.startedAt))):8,initialShift=shift.timesheetShift||(hour>=19||hour<7?'night':'day');
    return new Promise(resolve=>{
      let result=null;const el=dialog('Закрытие смены · материал',`<div class="ts-material-volume"><b>${quantity.toLocaleString('ru-RU')} м³</b><span>${E(source.name)} · ${E(fmtDate(day))}</span></div>`+note('Объём рассчитан по рейсам самосвалов без ГАИ.')+(warning?note(E(warning)):'')+field('Смена в табеле',`<select name="timesheetShift">${choice('day','День',initialShift)}${choice('night','Ночь',initialShift)}</select>`)+routeFields(route,source.id),async f=>{if(!hasPermission('close_shift'))throw Error('Нет права закрывать смену');result={materialRoute:readRoute(f,source.id),timesheetShift:f.get('timesheetShift'),objectId:source.id,objectName:source.name};});
      el.querySelector('[type=submit]').textContent='Закрыть смену';el.querySelector('.ts-dialog-actions [data-close]').textContent='Отмена';routeToggle(el);el.addEventListener('close',()=>resolve(result),{once:true});
    });
  }
  function materialsView(month){
    const list=materialRows().filter(x=>month||x.date===S.date&&x.shift===S.shift),totals=new Map();for(const r of list){const k=r.direction+'|'+r.material+'|'+r.unit;totals.set(k,{name:r.material,unit:r.unit,direction:r.direction,total:(totals.get(k)?.total||0)+r.quantity});}
    const active=state.shift,volume=active?.objectId===S.objectId&&C.sourceDay(active.startDate,active.startedAt)===S.date?C.regularVolume((state.logs||[]).filter(l=>l.shiftId===active.id)):0;
    return `<section class="ts-section ts-ledger-materials" data-group="materials"><div class="ts-section-title"><h3>Материалы</h3><div>${manage()?btn('Куда с линии','material-route'):''}${edit()&&!month?btn('＋ Поступление','material'):''}</div></div>${[...totals.values()].map(t=>`<span class="ts-chip">${E(directionNames[t.direction])} · ${E(t.name)} · ${Number(t.total.toFixed(3)).toLocaleString('ru-RU')} ${E(t.unit)}</span>`).join('')}${!month&&volume?note('С линии сейчас: <b>'+volume.toLocaleString('ru-RU')+' м³</b> · направление подтвердим при закрытии смены.'):''}${list.length?list.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(r=>`<div class="ts-row"><div class="ts-row-name"><strong>${E(r.material)}</strong><small>${E(r.supplier)}${r.document?' · № '+E(r.document):''}${month?' · '+fmtDate(r.date)+' '+shiftName(r.shift):''}</small>${r.auto?'<small>Из закрытой смены · по рейсам</small>':r.pending?'<small>Ожидает отправки</small>':''}</div><b>${r.quantity.toLocaleString('ru-RU')} ${E(r.unit)}</b>${r.auto?'':btn(edit()?'Изменить':'Открыть','material',`data-id="${E(r.id)}"`)}</div>`).join(''):note('Поступления и направления материала появятся здесь.')}</section>`;
  }
  function monthView(){
    const all=entries(),columns=[...new Map(all.filter(r=>r.minutes!==null).map(r=>[r.date+'|'+r.shift,{date:r.date,shift:r.shift}])).values()].sort((a,b)=>a.date.localeCompare(b.date)||a.shift.localeCompare(b.shift));
    const tools=`<div class="ts-toolbar">${hasPermission('timesheet_export')?btn('↓ Табель CSV','export')+btn('↓ Материалы CSV','export-materials'):''}${btn('История изменений','history')}</div>`;
    if(!columns.length)return tools+note('За месяц ещё нет заполненных часов. Даты появятся после ввода.')+materialsView(true);
    const machineMap=new Map();all.filter(r=>r.kind==='equipment').forEach(r=>machineMap.set(r.entityId,r));const machines=equipmentSort([...machineMap.values()]);
    const section=title=>`<tr class="ts-month-section"><th colspan="${columns.length+2}">${E(title)}</th></tr>`;
    function line(label,tone,filter,crew=false,unit='ч'){
      let total=0;const cells=columns.map(c=>{const rows=all.filter(r=>r.date===c.date&&r.shift===c.shift&&filter(r)),filled=rows.filter(r=>r.minutes!==null),sum=filled.reduce((n,r)=>n+r.minutes,0);total+=sum;const display=!rows.length?'':!filled.length?'—':crew?C.fmt(sum):filled.every(r=>r.status==='off')?'В':filled.every(r=>r.status==='absent')?'НЯ':C.fmt(sum);return `<td${rows.some(r=>r.pending)?' class="ts-pending"':''}>${rows.length?`<button type="button" data-action="view-shift" data-date="${c.date}" data-shift="${c.shift}" aria-label="${E(label)} · ${fmtDate(c.date)} · ${shiftName(c.shift)}">${display}</button>`:''}</td>`;}).join('');
      return `<tr class="ts-month-row ts-tone-${tone}${crew?' ts-month-crew':''}"><th>${E(label)}${crew?'<small>чел.-ч, всего</small>':''}</th>${cells}<td><b>${C.fmt(total)}</b>${unit!=='ч'?E(unit):''}</td></tr>`;
    }
    let body='';for(const ownership of ['own','hired']){const list=machines.filter(m=>m.ownership===ownership);if(!list.length)continue;body+=section(ownership==='own'?'Своя техника':'Наёмная техника');for(const m of list){const style=equipmentStyle(m);body+=line(m.name+(ownership==='hired'&&m.contractor?' · '+m.contractor:''),style.tone,r=>r.kind==='equipment'&&r.entityId===m.entityId);if(ownership==='own')body+=line(style.minimum>1?style.many:style.one,style.tone,r=>r.kind==='person'&&r.group==='operator'&&r.equipmentId===m.entityId,true);}}
    const materials=materialRows(),materialGroups=new Map();materials.forEach(r=>materialGroups.set([r.direction,r.material,r.unit,r.supplier].join('|'),r));if(materialGroups.size){body+=section('Материалы');for(const [key,r]of materialGroups){let total=0;const cells=columns.map(c=>{const list=materials.filter(x=>[x.direction,x.material,x.unit,x.supplier].join('|')===key&&x.date===c.date&&x.shift===c.shift),sum=list.reduce((n,x)=>n+x.quantity,0);total+=sum;return `<td>${list.length?Number(sum.toFixed(3)).toLocaleString('ru-RU'):''}</td>`;}).join('');body+=`<tr class="ts-month-row ts-tone-material"><th>${E(r.material)}<small>${E(r.supplier)} · ${E(r.unit)}</small></th>${cells}<td><b>${Number(total.toFixed(3)).toLocaleString('ru-RU')}</b></td></tr>`;}}
    for(const group of ['operator','itr','worker']){const list=all.filter(r=>r.kind==='person'&&personGroup(r)===group&&(group!=='operator'||!r.equipmentId||!machineMap.has(r.equipmentId))),people=[...new Map(list.map(r=>[r.entityId,r])).values()].sort((a,b)=>a.name.localeCompare(b.name,'ru'));if(!people.length)continue;body+=section(group==='operator'?'Машинисты / водители без техники':groups[group]);for(const p of people)body+=line(p.name,'people',r=>r.kind==='person'&&r.entityId===p.entityId);}
    return tools+note('Только смены с заполненными часами. Ночные даты — через дробь. Нажмите ячейку, чтобы открыть смену.')+`<div class="ts-table-wrap"><table class="ts-table ts-month-table"><thead><tr><th>${E(object()?.name||'Объект')}</th>${columns.map(c=>`<th data-date="${c.date}" data-shift="${c.shift}">${Number(c.date.slice(8))}${c.shift==='night'?'/'+Number(C.moveDate(c.date,1).slice(8)):''}</th>`).join('')}<th>Итого</th></tr></thead><tbody>${body}</tbody></table></div>`+materialsView(true);
  }
  function catalogView(){
    const category=S.catalogGroup||'worker',isEquipment=category==='equipment',col=isEquipment?'timesheetEquipment':'timesheetPeople';
    const list=living(col).filter(r=>isEquipment||r.group===category);
    const tabs=`<div class="ts-catalog-tabs">${[['worker','Рабочие'],['operator','Машинисты / водители'],['itr','ИТР'],['equipment','Техника']].map(([group,title])=>btn(title,'catalog-group',`data-group="${group}" aria-pressed="${category===group}"`)).join('')}</div>`;
    const item=r=>`<div class="ts-row"><div class="ts-row-name"><strong>${E(r.name)}</strong>${isEquipment&&r.ownership==='hired'?`<small>${E(r.contractor||'Наёмная техника')}</small>`:''}</div>${manage()?btn('Изменить','catalog',`data-col="${col}" data-group="${category}" data-id="${E(r.id)}"`):''}</div>`;
    const body=isEquipment?['own','hired'].map(ownership=>`<div class="ts-catalog-subgroup"><h4>${ownership==='own'?'Своя техника':'Наёмная техника'}</h4>${equipmentSort(list.filter(r=>r.ownership===ownership)).map(item).join('')||note('Пока пусто.')}</div>`).join(''):category==='operator'?Object.entries(C.operatorRoles).map(([role,label])=>{const members=sort(list.filter(p=>personRole(p)===role));return members.length?`<div class="ts-catalog-subgroup"><h4>${E(label)}</h4>${members.map(item).join('')}</div>`:'';}).join('')||note('Список пока пуст.'):sort(list).map(item).join('')||note('Список пока пуст.');
    return tabs+`<section class="ts-section"><div class="ts-section-title"><h3>${isEquipment?'Техника':groups[category]}</h3>${manage()?btn('＋ Добавить','catalog',`data-col="${col}" data-group="${category}"`):''}</div>${isEquipment?note('Штатный экипаж своей техники появляется в смене автоматически. Фамилии выбираются по нажатию на строку экипажа.'):''}${body}</section>`;
  }
  function render(){
    if(!active())return;
    if(host.contains(document.activeElement)&&['INPUT','SELECT'].includes(document.activeElement.tagName))return;
    if(!allowed()){host.innerHTML=note('Нет доступа к табелю.');return;}
    const pending=S.jobs.filter(x=>x.status==='queued').length,failed=S.jobs.filter(x=>x.status!=='queued');
    const syncText=pending?`На устройстве: ${pending} · ожидают отправки`:!navigator.onLine?'Нет связи · показываем сохранённые данные':S.objectId&&C.collections.every(c=>S.ready[c])?'Данные подтверждены сервером':'Проверяем данные с сервером…';
    const html=`<div class="ts-heading"><div><h2>Учёт объекта</h2><p>Люди · техника · материалы</p></div><span class="ts-version">Тест 3.2.0</span></div><div class="ts-filters">${field('Объект',`<select id="ts-object"><option value="">Выберите объект</option>${state.objects.map(o=>choice(o.id,o.name,S.objectId)).join('')}</select>`)}${field(S.view==='month'?'Месяц':'Дата начала',`<input id="ts-date" type="${S.view==='month'?'month':'date'}" value="${S.view==='month'?S.date.slice(0,7):S.date}">`)}${S.view==='day'?field('Смена',`<select id="ts-shift">${choice('day','☀ День',S.shift)}${choice('night','☾ Ночь',S.shift)}</select>`):''}</div>${S.view==='day'?dateNav():''}<div class="ts-tabs">${[['day','Смена'],['month','Месяц'],['catalog','Справочники']].map(([v,t])=>btn(t,'view',`data-view="${v}" aria-pressed="${S.view===v}"`)).join('')}</div><div class="ts-sync" role="status">${E(syncText)}${pending?btn('Повторить отправку','retry'):''}</div>${Object.values(S.errors).map(e=>`<div class="ts-warning">${E(e)}</div>`).join('')}${failed.length?`<div class="ts-warning"><b>Требуют проверки: ${failed.length}</b>${failed.map(j=>`<div>${E(j.label)} · ${E(j.error||'Конфликт')} ${btn('Разобрать','conflict',`data-id="${j.id}"`)}</div>`).join('')}</div>`:''}${!S.local?note('Открываем локальное хранилище…'):S.view==='catalog'?catalogView():S.objectId?(S.view==='day'?dayView():monthView()):note('Выберите существующий объект. Новый объект можно добавить во вкладке «База».')}`;
    if(html!==S.lastHtml){host.innerHTML=html;S.lastHtml=html;}
  }
  function dialog(title,body,onSubmit){
    S.dialog?.close();const el=document.createElement('dialog');el.className='ts-dialog';el.innerHTML=`<form><div class="ts-dialog-title"><h3>${E(title)}</h3><button type="button" data-close aria-label="Закрыть">×</button></div><div class="ts-dialog-body">${body}</div><p class="ts-form-error" role="alert"></p><div class="ts-dialog-actions">${onSubmit?'<button class="ts-btn ts-primary" type="submit">Сохранить</button>':''}<button type="button" class="ts-btn" data-close>Закрыть</button></div></form>`;document.body.append(el);S.dialog=el;el.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>el.close());el.addEventListener('close',()=>{if(S.dialog===el)S.dialog=null;el.remove();});
    el.querySelector('form').onsubmit=async e=>{e.preventDefault();if(!onSubmit||adding)return;const button=el.querySelector('[type=submit]');adding=true;button.disabled=true;try{await onSubmit(new FormData(e.target),el);el.close();}catch(err){el.querySelector('.ts-form-error').textContent=err.message;}finally{adding=false;button.disabled=false;}};el.showModal();return el;
  }
  function personRole(person){
    if(person.operatorRole&&Object.hasOwn(C.operatorRoles,person.operatorRole))return person.operatorRole;
    const roles=new Set();for(const row of rows('timesheetEntries').filter(r=>r.kind==='person'&&C.personIdentity(r)===person.id&&r.equipmentId)){
      if(row.operatorRole)roles.add(row.operatorRole);else {const m=rows('timesheetEntries').find(m=>m.kind==='equipment'&&m.entityId===row.equipmentId)||living('timesheetEquipment').find(m=>m.id===row.equipmentId);if(m)roles.add(equipmentStyle(m).role);}
    }
    return roles.size===1?[...roles][0]:'unassigned';
  }
  function catalogForm(col,id,group='worker'){
    if(!manage())return;const r=rows(col).find(x=>x.id===id),isPerson=col==='timesheetPeople',category=r?.group||group;
    const roleControl=field('Специализация',`<select name="operatorRole">${Object.entries(C.operatorRoles).map(([k,v])=>choice(k,v,r?personRole(r):'mill')).join('')}</select>`);
    const body=field(isPerson?'Фамилия и имя':'Название / номер техники',input('name',r?.name,'required maxlength="160"'))+(isPerson?(r?field('Категория',`<select name="group">${Object.entries(groups).map(([k,v])=>choice(k,v,category)).join('')}</select>`):input('group',category,'type="hidden"'))+`<div data-role-field${category==='operator'?'':' hidden'}>${roleControl}</div>`:field('Вид техники',`<select name="equipmentType">${Object.entries(C.equipmentTypes).map(([k,v])=>choice(k,v.label,r?C.equipmentType(r):'mill')).join('')}</select>`)+`<label class="ts-check"><input type="checkbox" name="hired"${r?.ownership==='hired'?' checked':''}>Наёмная техника</label><div data-contractor-field${r?.ownership==='hired'?'':' hidden'}>${field('Фирма',input('contractor',r?.contractor,'maxlength="160"'))}</div>`+note('У своей техники штатный экипаж появится автоматически. У наёмной учитываются только часы техники.'))+(r?'<label class="ts-check"><input type="checkbox" name="archive">Убрать из справочника (историю сохранить)</label>':'');
    const el=dialog(isPerson?groups[category]:'Техника',body,async f=>{
      const name=C.text(f.get('name'),'Название');if(living(col).some(p=>p.id!==id&&p.name.trim().toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru')))throw Error('Такое имя уже есть. Для тёзки добавьте отчество или табельный номер.');
      const data=isPerson?{name,group:f.get('group'),...(f.get('group')==='operator'?{operatorRole:f.get('operatorRole')}:{}),deleted:f.has('archive')}:{name,equipmentType:f.get('equipmentType'),ownership:f.has('hired')?'hired':'own',contractor:f.has('hired')?C.text(f.get('contractor'),'Фирма'):'',crewIds:[],deleted:f.has('archive')};
      await enqueue([{collection:col,id:id||uid(),baseRevision:r?.revision||0,before:r?ownData(r):null,data}],isPerson?'Справочник сотрудников':'Справочник техники');
    });
    el.querySelector('[name=hired]')?.addEventListener('change',e=>{el.querySelector('[data-contractor-field]').hidden=!e.target.checked;el.querySelector('[name=contractor]').required=e.target.checked;});
    el.querySelector('[name=group]')?.addEventListener('change',e=>{el.querySelector('[data-role-field]').hidden=e.target.value!=='operator';});
  }
  function blankEntry(kind,entity,equipmentId=''){
    if(!object())throw Error('Выберите объект');
    return {...(kind==='equipment'?{equipmentType:C.equipmentType(entity),crewCount:C.defaultCrewCount(entity)}:{}),kind,entityId:entity.id,name:entity.name,group:entity.group||'',ownership:entity.ownership||'',contractor:entity.contractor||'',objectId:S.objectId,objectName:object().name,date:S.date,shift:S.shift,scope:C.scope(S.objectId,S.date),minutes:null,idleMinutes:0,status:'unfilled',equipmentId,note:'',deleted:false};
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
  function equipmentAssignmentForm(){
    if(!edit()||!object())return;
    const machines=equipmentSort(living('timesheetEquipment').filter(m=>!dayEntries().some(r=>r.kind==='equipment'&&r.entityId===m.id)));
    const snapshots=new Map(rows('timesheetEntries').map(r=>[r.id,C.clone(r)]));
    const body=['own','hired'].map(ownership=>{const list=machines.filter(m=>m.ownership===ownership);if(!list.length)return '';return `<h4>${ownership==='own'?'Своя техника':'Наёмная техника'}</h4>${list.map(m=>`<label class="ts-check"><input type="checkbox" name="machines" value="${E(m.id)}"><span>${E(m.name)}<small class="ts-muted">${E(ownership==='hired'?m.contractor:equipmentStyle(m).many+' · '+C.defaultCrewCount(m))}</small></span></label>`).join('')}`;}).join('')||note('Вся техника уже добавлена. Новую можно внести в справочник.');
    return dialog('Добавить технику в смену',body,machines.length?async f=>{
      const changes=[];
      for(const id of f.getAll('machines')){
        const m=machines.find(m=>m.id===id);if(!m)throw Error('Техника не найдена');if(m.ownership==='hired'&&!m.contractor.trim())throw Error('Укажите фирму для '+m.name+' в справочнике.');
        const data=blankEntry('equipment',m),key=C.entryId('equipment',S.objectId,S.date,S.shift,m.id),old=snapshots.get(key);
        changes.push({collection:'timesheetEntries',id:key,baseRevision:old?.revision||0,before:old?ownData(old):null,data});
        const machine={...data,id:key};
        for(let i=0;i<C.defaultCrewCount(machine);i++){const slot=C.slotEntry(machine,i),before=snapshots.get(slot.id);changes.push({collection:'timesheetEntries',id:slot.id,baseRevision:before?.revision||0,before:before?ownData(before):null,data:ownData(slot)});}
      }
      if(!changes.length)throw Error('Выберите технику');await enqueue(changes,'Добавлена техника со штатным экипажем');
    }:null);
  }
  function crewForm(id){
    const machine=entries().find(r=>r.kind==='equipment'&&r.id===id);if(!machine||machine.ownership==='hired')return;
    const original=C.clone(crewFor(machine)),style=equipmentStyle(machine),qualified=sort(living('timesheetPeople').filter(p=>p.group==='operator'&&personRole(p)===style.role));
    let working=C.clone(original);
    const body=note(`${E(machine.name)} · ${fmtDate(machine.date)} · ${shiftName(machine.shift)}. Фамилии необязательны; часы учитываются для каждого места экипажа.`)+field('Количество',input('crewCount',working.length,`type="number" min="${style.minimum}" max="20" step="1"`))+'<div data-crew-slots></div>';
    const el=dialog(style.many,body,edit()?async f=>{
      collect();const count=Number(f.get('crewCount'));if(!Number.isInteger(count)||count<style.minimum||count>20||count!==working.length)throw Error('Проверьте количество участников');
      const selected=working.map(C.personIdentity).filter(Boolean);if(new Set(selected).size!==selected.length)throw Error('Один сотрудник выбран несколько раз');
      const others=entries().filter(r=>r.kind==='person'&&r.date===machine.date&&r.shift===machine.shift&&!original.some(x=>x.id===r.id));
      if(selected.some(personId=>others.some(r=>C.personIdentity(r)===personId)))throw Error('Сотрудник уже указан в другой строке этой смены.');
      const changes=[];
      for(const row of working){const before=original.find(r=>r.id===row.id)||rows('timesheetEntries').find(r=>r.id===row.id);changes.push({collection:'timesheetEntries',id:row.id,baseRevision:before?.revision||0,before:before?ownData(before):null,data:ownData(row)});}
      for(const row of original.filter(r=>!working.some(x=>x.id===r.id)))if(!row.virtual)changes.push({collection:'timesheetEntries',id:row.id,baseRevision:row.revision||0,before:ownData(row),data:{...ownData(row),deleted:true}});
      changes.push({collection:'timesheetEntries',id:machine.id,baseRevision:machine.revision||0,before:ownData(machine),data:{...ownData(machine),crewCount:working.length}});
      await enqueue(changes,'Состав и часы экипажа: '+machine.name);
    }:null);
    function collect(){el.querySelectorAll('[data-slot-index]').forEach(wrapper=>{const index=Number(wrapper.dataset.slotIndex),row=working[index],personId=wrapper.querySelector('select').value,minutes=C.hours(wrapper.querySelector('input').value);const person=qualified.find(p=>p.id===personId);const oldId=C.personIdentity(row);if(personId&&!person&&personId!==oldId)throw Error('Выберите сотрудника нужной специализации');row.personId=personId;row.name=person?.name||(personId?row.name:style.one+' '+(index+1));row.operatorRole=style.role;row.crewSlot=index;row.minutes=minutes;row.status=minutes===null?'unfilled':row.status==='off'&&minutes===0?'off':row.status==='absent'&&minutes===0?'absent':'work';});}
    function renderSlots(){el.querySelector('[data-crew-slots]').innerHTML=working.map((row,index)=>{const selected=C.personIdentity(row),extra=selected&&!qualified.some(p=>p.id===selected)?choice(selected,row.name+' · текущая запись',selected):'';return `<div class="ts-crew-slot" data-slot-index="${index}"><label><span>${E(style.one)} ${index+1}</span><select aria-label="${E(style.one)} ${index+1}">${choice('','Без фамилии',selected)}${extra}${qualified.map(p=>choice(p.id,p.name,selected)).join('')}</select></label><label><span>Часы</span><input inputmode="decimal" value="${E(C.fmt(row.minutes))}" aria-label="Часы участника ${index+1}" placeholder="—"></label></div>`;}).join('');if(!edit())el.querySelectorAll('input,select').forEach(input=>input.disabled=true);}
    el.querySelector('[name=crewCount]').addEventListener('change',e=>{try{collect();const count=Number(e.target.value);if(!Number.isInteger(count)||count<style.minimum||count>20)throw Error('Количество: от '+style.minimum+' до 20');while(working.length<count){let index=0,slot;do{slot=C.slotEntry(machine,index++);}while(working.some(r=>r.id===slot.id));const old=original.find(r=>r.id===slot.id)||rows('timesheetEntries').find(r=>r.id===slot.id);if(old)slot.revision=old.revision;working.push(original.find(r=>r.id===slot.id)?C.clone(original.find(r=>r.id===slot.id)):slot);}working=working.slice(0,count);renderSlots();el.querySelector('.ts-form-error').textContent='';}catch(error){el.querySelector('.ts-form-error').textContent=error.message;e.target.value=working.length;}});renderSlots();
  }
  function entryForm(id){
    const r=entries().find(x=>x.id===id);if(!r||r.deleted)return;
    const machines=entries().filter(x=>x.kind==='equipment'&&x.ownership!=='hired'&&x.date===r.date&&x.shift===r.shift);
    if(r.kind==='person'&&r.group==='operator'&&r.equipmentId){const machine=entries().find(m=>m.kind==='equipment'&&m.entityId===r.equipmentId&&m.date===r.date&&m.shift===r.shift);if(machine)return crewForm(machine.id);}
    const body=note(`${E(r.objectName)} · ${fmtDate(r.date)} · ${shiftName(r.shift)}`)+field('Отметка',`<select name="status">${Object.entries(statuses).map(([k,v])=>choice(k,v,r.status)).join('')}</select>`)+field('Отработано, часов',input('hours',C.fmt(r.minutes),'inputmode="decimal" placeholder="Например, 12 или 7,5"'))+(r.kind==='equipment'?field('Простой, часов',input('idle',C.fmt(r.idleMinutes),'inputmode="decimal"')):personGroup(r)==='operator'?field('Работал на технике',`<select name="equipmentId">${choice('','Без привязки',r.equipmentId)}${machines.map(m=>choice(m.entityId,m.name,r.equipmentId)).join('')}</select>`):'')+field('Комментарий',`<textarea name="note" maxlength="500">${E(r.note)}</textarea>`)+(edit()?'<label class="ts-check"><input type="checkbox" name="remove">Убрать строку из этой смены</label>':'');
    const el=dialog(r.name,body,edit()?async f=>{
      let status=f.get('status'),minutes=C.hours(f.get('hours'));if(status==='unfilled'&&minutes!==null)status='work';if(['off','absent'].includes(status))minutes=0;if(status==='work'&&minutes===null)throw Error('Укажите отработанные часы');
      const data={...ownData(r),status,minutes:status==='unfilled'?null:minutes,idleMinutes:r.kind==='equipment'?C.hours(f.get('idle'),false):0,equipmentId:r.kind==='person'?(personGroup(r)==='operator'?String(f.get('equipmentId')||''):r.equipmentId):'',note:String(f.get('note')||'').trim(),deleted:f.has('remove')};
      const changes=[{collection:'timesheetEntries',id,baseRevision:r.revision||0,before:ownData(r),data}];if(data.deleted&&r.kind==='equipment')for(const member of crewFor(r).filter(x=>!x.virtual))changes.push({collection:'timesheetEntries',id:member.id,baseRevision:member.revision||0,before:ownData(member),data:{...ownData(member),deleted:true}});await enqueue(changes,'Часы: '+r.name);
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
      const source=C.effectiveEntries(C.project(remote,S.jobs,'timesheetEntries')).filter(x=>!x.deleted&&x.objectId===S.objectId&&x.date===date&&x.shift===shift);
      if(!source.length)throw Error('В выбранной смене нет состава');const existing=dayEntries();const changes=[];
      for(const r of source){const id=C.entryId(r.kind,S.objectId,S.date,S.shift,r.entityId);if(existing.some(x=>x.id===id))continue;changes.push(change('timesheetEntries',id,{...ownData(r),date:S.date,shift:S.shift,scope:S.scope,objectName:object().name,minutes:null,idleMinutes:0,status:'unfilled',note:'',deleted:false}));}
      if(!changes.length)throw Error('Весь состав уже добавлен');await enqueue(changes,'Перенесён состав смены');
    });
  }
  function exportCsv(materials){
    if(!hasPermission('timesheet_export'))return;
    if(S.jobs.some(j=>j.scope===S.scope))return error(Error('Сначала отправьте и разберите все изменения этого месяца.'));
    const col=materials?'timesheetMaterials':'timesheetEntries';if(!navigator.onLine||!S.ready[col])return error(Error('Для выгрузки дождитесь подтверждения данных сервером.'));
    if(materials&&typeof syncState!=='undefined'&&syncState.fromCache?.archive!==false)return error(Error('Для выгрузки материалов дождитесь загрузки архива с сервера.'));
    const list=(materials?materialRows():entries()).filter(x=>x.scope===S.scope).sort((a,b)=>a.date.localeCompare(b.date)||a.shift.localeCompare(b.shift));
    const data=materials?[['Объект','Дата начала смены','Смена','Материал','Направление / поставщик','Количество','Ед.','Накладная','Комментарий'],...list.map(r=>[r.objectName,fmtDate(r.date),shiftName(r.shift),r.material,r.supplier,String(r.quantity).replace('.',','),r.unit,r.document,r.note])]:[['Объект','Дата начала смены','Смена','Вид','Сотрудник / техника','Отметка','Часы','Простой, ч','Организация','Комментарий'],...list.map(r=>[r.objectName,fmtDate(r.date),shiftName(r.shift),r.kind==='person'?'Сотрудник':'Техника',r.name,statuses[r.status],C.fmt(r.minutes),C.fmt(r.idleMinutes),r.contractor,r.note])];
    const a=document.createElement('a'),url=URL.createObjectURL(new Blob([C.csv(data)],{type:'text/csv;charset=utf-8;'}));a.href=url;a.download=(materials?'materialy-':'tabel-')+S.date.slice(0,7)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function describe(r){if(!r)return 'Записи нет';if('minutes'in r)return `${r.name}: ${statuses[r.status]}${r.minutes===null?'':' · '+C.fmt(r.minutes)+' ч'}${r.deleted?' · удалено':''}${r.note?' · '+r.note:''}`;if('quantity'in r)return `${r.material}: ${r.quantity} ${r.unit} · ${r.supplier}${r.deleted?' · удалено':''}`;if('startTime'in r)return 'Смена '+r.startTime+'–'+r.endTime;if('destinationType'in r)return r.material+' → '+r.destinationName;return r.name+(r.deleted?' · в архиве':'');}
  async function conflictForm(id){
    const op=S.jobs.find(x=>x.id===id);if(!op)return;const generation=S.generation;
    const canRetry=op.changes.every(ch=>['timesheetPeople','timesheetEquipment','timesheetSettings'].includes(ch.collection)?manage():edit());
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
    const actions={view:()=>{S.view=view;render();},'add-person':()=>addForm('person',group),'add-equipment':()=>addForm('equipment'),entry:()=>entryForm(id),crew:()=>crewForm(id),'add-crew':()=>crewForm(id),'hours-preset':()=>inlineButton(id,b.dataset.value),'hours-step':()=>inlineButton(id,undefined,b.dataset.delta),'fill-defaults':fillDefaults,'clock-save':()=>saveClock(),'clock-preset':()=>saveClock(b.dataset.start,b.dataset.end),'view-shift':()=>goDate(b.dataset.date,b.dataset.shift,'day'),'date-nav':()=>goDate(b.dataset.day==='today'?today():b.dataset.day==='yesterday'?C.moveDate(today(),-1):C.moveDate(S.date,Number(b.dataset.delta))),'workers-value':()=>workersValue(b),'workers-apply':applyWorkers,copy:copyForm,'catalog-group':()=>{S.catalogGroup=group;render();},catalog:()=>catalogForm(col,id,group),material:()=>materialForm(id),'material-route':routeForm,retry:replay,conflict:()=>conflictForm(id),export:()=>exportCsv(false),'export-materials':()=>exportCsv(true),history};
    try{Promise.resolve(actions[action]?.()).catch(error);}catch(e){error(e);}
  });
  host.addEventListener('change',e=>{const t=e.target;if(t.id==='ts-start-time'||t.id==='ts-end-time'){const d=captureClock();d.start=byId('ts-start-time').value;d.end=byId('ts-end-time').value;return;}if(t.matches('.ts-inline-hours')){saveInlineInput(t);return;}if(t.id==='ts-workers-hours'){S.bulkValue=t.value;return;}if(t.id==='ts-object')S.objectId=t.value;else if(t.id==='ts-date'){if(!t.value)return;S.date=t.type==='month'?t.value+'-01':t.value;}else if(t.id==='ts-shift')S.shift=t.value;else return;S.bulkWorkers=false;S.bulkRows=[];S.bulkValue='';S.clockDraft=null;t.blur();period().catch(error);render();});
  host.addEventListener('focusin',e=>{if(e.target.matches('.ts-inline-hours')){const id=e.target.dataset.id;if(!inlineDrafts.get(id)?.dirty&&!inlineChains.has(id))inlineDrafts.delete(id);captureInline(e.target);e.target.select();}else if(e.target.id==='ts-workers-hours'){captureWorkers();e.target.select();}else if(['ts-start-time','ts-end-time'].includes(e.target.id))captureClock();});
  host.addEventListener('input',e=>{if(e.target.matches('.ts-inline-hours')){const draft=captureInline(e.target);if(draft){draft.raw=e.target.value;draft.dirty=true;}e.target.removeAttribute('aria-invalid');}else if(e.target.id==='ts-workers-hours'){captureWorkers();S.bulkValue=e.target.value;}});
  host.addEventListener('focusout',e=>{if(!e.target.matches('.ts-inline-hours'))return;saveInlineInput(e.target);const id=e.target.dataset.id;setTimeout(()=>{if(document.activeElement!==e.target&&!inlineDrafts.get(id)?.dirty){inlineDrafts.delete(id);render();}},0);});
  host.addEventListener('keydown',e=>{if(!e.target.matches('.ts-inline-hours'))return;if(e.key==='Enter'){e.preventDefault();saveInlineInput(e.target);e.target.blur();}else if(e.key==='Escape'){e.preventDefault();const draft=inlineDrafts.get(e.target.dataset.id);if(draft){const value=commonHours(draft.records);e.target.value=value.mixed?'':C.fmt(value.minutes);draft.dirty=false;}e.target.blur();}});
  host.addEventListener('pointerdown',e=>{if(e.target.closest('[data-action^="hours-"]')&&document.activeElement?.matches('.ts-inline-hours'))e.preventDefault();});
  window.Timesheet={session,render,reset,prepareClose};
  const previousRender=window.renderAll;window.renderAll=function(){previousRender.apply(this,arguments);session();render();};
  const previousStop=window.stopSync;window.stopSync=function(){reset();return previousStop.apply(this,arguments);};
  auth.onAuthStateChanged(()=>{reset();session();});
  window.addEventListener('online',()=>{replay();render();});window.addEventListener('offline',render);
  setInterval(()=>{session();if(allowed()&&S.local){loadJobs().then(()=>{render();replay();}).catch(error);}},6000);
  session();
})();
