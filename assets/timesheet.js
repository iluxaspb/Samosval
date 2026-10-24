/* Field ledger 3.1. Loaded only by index-test.html. */
(function () {
  'use strict';
  if (window.Timesheet || firebaseConfig.projectId !== 'samosval-offline') return;
  const C=window.TimesheetCore, E=escapeHtml;
  const names={timesheetPeople:'Люди',timesheetEquipment:'Техника',timesheetEntries:'Табель',timesheetMaterials:'Материалы'};
  const groups={worker:'Рабочие',itr:'ИТР',operator:'Машинисты / водители'};
  const statuses={unfilled:'Не заполнено',work:'Работал',off:'Выходной',absent:'Отсутствовал'};
  const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date());
  const uid=()=>{if(crypto.randomUUID)return crypto.randomUUID();const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');};
  const S={user:'',generation:0,local:null,jobs:[],remote:{},unsubs:[],periodUnsubs:[],objectId:'',date:today(),shift:'day',view:'day',scope:'',ready:{},errors:{},busy:false,dialog:null,lastHtml:''};
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
  function object(){return state.objects.find(x=>x.id===S.objectId);}
  function ownData(row){const d={...row};for(const k of ['id','revision','lastOpId','updatedBy','updatedName','updatedAt','pending'])delete d[k];return d;}
  function change(col,id,data){const old=rows(col).find(x=>x.id===id);return {collection:col,id,baseRevision:old?.revision||0,before:old?ownData(old):null,data};}
  function choice(value,label,selected){return `<option value="${E(value)}"${value===selected?' selected':''}>${E(label)}</option>`;}
  function field(label,control){return `<label class="ts-field"><span>${label}</span>${control}</label>`;}
  function input(name,value='',extra=''){return `<input name="${name}" value="${E(value)}" ${extra}>`;}
  function btn(label,action,extra=''){return `<button type="button" class="ts-btn" data-action="${action}" ${extra}>${label}</button>`;}
  function note(s){return `<p class="ts-muted">${s}</p>`;}
  function localOpen(name){return new Promise((resolve,reject)=>{const req=indexedDB.open(name,1);req.onupgradeneeded=()=>{req.result.createObjectStore('jobs',{keyPath:'id'});req.result.createObjectStore('cache',{keyPath:'key'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(Error('Закройте другие вкладки, чтобы открыть локальное хранилище'));});}
  function local(store,method,value){const database=S.local;if(!database)return Promise.reject(Error('Локальное хранилище ещё не готово'));return new Promise((resolve,reject)=>{const tx=database.transaction(store,method==='get'||method==='getAll'?'readonly':'readwrite');const req=tx.objectStore(store)[method](value);let result;req.onsuccess=()=>{result=req.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error||req.error);tx.onabort=()=>reject(tx.error||Error('Не удалось сохранить на устройстве'));});}
  async function loadJobs(){const generation=S.generation;const jobs=await local('jobs','getAll');if(generation===S.generation)S.jobs=jobs.sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));}
  function reset(){S.generation++;for(const u of [...S.unsubs,...S.periodUnsubs])u();S.unsubs=[];S.periodUnsubs=[];S.local?.close();S.local=null;S.user='';S.scope='';S.jobs=[];S.ready={};S.errors={};S.busy=false;for(const k of C.collections)S.remote[k]=[];S.dialog?.close();S.lastHtml='';host.innerHTML='';}
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
    for(const col of ['timesheetEntries','timesheetMaterials']){S.remote[col]=[];S.ready[col]=false;delete S.errors[col];}
    render();
    for(const col of ['timesheetEntries','timesheetMaterials']){
      const key=col+':'+scope,cached=await local('cache','get',key);if(generation!==S.generation||S.scope!==scope)return;if(cached)S.remote[col]=cached.rows;
      S.periodUnsubs.push(wsRef.collection(col).where('scope','==',scope).onSnapshot({includeMetadataChanges:true},snap=>{if(S.scope===scope)receive(col,key,snap,generation);},e=>{if(S.scope===scope)syncError(col,e,generation);}));
    }
    render();
  }
  let adding=false;
  async function enqueue(changes,label){
    if(!allowed()||!S.local)throw Error('Войдите в приложение и дождитесь открытия табеля');
    if(!changes.length)return;
    if(changes.some(ch=>['timesheetPeople','timesheetEquipment'].includes(ch.collection)?!manage():!edit()))throw Error('Нет права на изменение этого раздела');
    const ops=[],stamp=Math.max(Date.now(),...S.jobs.map(x=>x.createdAt+1));
    for(let i=0;i<changes.length;i+=4){const op={id:uid(),uid:S.user,scope:S.scope||'catalog',label,createdAt:stamp+i,status:'queued',changes:changes.slice(i,i+4)};C.validateOperation(op);ops.push(op);}
    const generation=S.generation;
    await new Promise((resolve,reject)=>{const tx=S.local.transaction('jobs','readwrite');for(const op of ops)tx.objectStore('jobs').put(op);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Очередь не сохранена'));});
    if(generation!==S.generation)return;
    await loadJobs();render();toast(navigator.onLine?'Сохранено на устройстве · отправляем':'Сохранено на устройстве · ожидает связи');replay();
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
  function summary(){const d=dayEntries();return `<div class="ts-stats"><div><strong>${d.filter(x=>x.kind==='person').length}</strong><span>человек</span></div><div><strong>${C.fmt(d.filter(x=>x.kind==='person').reduce((n,x)=>n+(x.minutes||0),0))}</strong><span>чел.-ч</span></div><div><strong>${d.filter(x=>x.kind==='equipment').length}</strong><span>ед. техники</span></div><div><strong>${d.filter(x=>x.status==='unfilled').length}</strong><span>не заполнено</span></div></div>`;}
  function rowCard(r){const machine=living('timesheetEquipment').find(x=>x.id===r.equipmentId);const crew=r.kind==='equipment'?dayEntries().filter(x=>x.kind==='person'&&x.equipmentId===r.entityId):[];return `<div class="ts-row ${r.pending?'ts-pending':''}"><div class="ts-row-name"><strong>${E(r.name)}</strong><small>${E(r.kind==='person'?(machine?.name||groups[r.group]||'Сотрудник'):(r.ownership==='hired'?'Привлечённая · '+r.contractor:'Своя техника'))}</small>${crew.length?`<small>Экипаж: ${crew.length} · ${C.fmt(crew.reduce((n,x)=>n+(x.minutes||0),0))} чел.-ч</small>`:''}${r.note?`<small>${E(r.note)}</small>`:''}</div><div class="ts-hours">${r.status==='unfilled'?'—':r.status==='work'?C.fmt(r.minutes)+' ч':E(statuses[r.status])}${r.idleMinutes?`<small>простой ${C.fmt(r.idleMinutes)} ч</small>`:''}${r.pending?'<small>Ожидает отправки</small>':''}</div>${btn(edit()?'Изменить':'Открыть','entry',`data-id="${E(r.id)}"`)}</div>`;}
  function dayView(){const d=dayEntries();return summary()+`<div class="ts-toolbar">${edit()?btn('＋ Люди','add-person')+btn('＋ Техника и экипаж','add-equipment')+btn('Часы группе','bulk')+btn('Взять состав','copy'):''}</div>`+note('Дата — начало смены. Ночная смена сохраняется целиком под этой датой; переход через полночь не создаёт вторую запись.')+['equipment','person'].map(kind=>`<section class="ts-section"><h3>${kind==='person'?'Люди':'Техника'}</h3>${sort(d.filter(x=>x.kind===kind)).map(rowCard).join('')||note(kind==='person'?'Добавьте сотрудников из справочника.':'Добавьте технику — сохранённый экипаж появится вместе с ней.')}</section>`).join('')+materialsView(false);}
  function materialsView(month){const list=living('timesheetMaterials').filter(x=>x.scope===S.scope&&(month||x.date===S.date&&x.shift===S.shift));const totals=new Map();for(const r of list){const k=r.material+'|'+r.unit;totals.set(k,{name:r.material,unit:r.unit,total:(totals.get(k)?.total||0)+r.quantity});}return `<section class="ts-section"><div class="ts-section-title"><h3>Поступление материалов</h3>${edit()&&!month?btn('＋ Поступление','material'):''}</div>${[...totals.values()].map(t=>`<span class="ts-chip">${E(t.name)} · ${Number(t.total.toFixed(3)).toLocaleString('ru-RU')} ${E(t.unit)}</span>`).join('')}${list.length?list.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(r=>`<div class="ts-row"><div class="ts-row-name"><strong>${E(r.material)}</strong><small>${E(r.supplier)}${r.document?' · № '+E(r.document):''}${month?' · '+fmtDate(r.date)+' '+shiftName(r.shift):''}</small>${r.pending?'<small>Ожидает отправки</small>':''}</div><b>${r.quantity.toLocaleString('ru-RU')} ${E(r.unit)}</b>${btn(edit()?'Изменить':'Открыть','material',`data-id="${E(r.id)}"`)}</div>`).join(''):note('Материалы считаются отдельно от часов техники подрядчиков.')}</section>`;}
  function monthView(){
    const a=entries(),month=S.date.slice(0,7),days=new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate();const keys=new Map();for(const r of a)keys.set(r.kind+'|'+r.entityId,{kind:r.kind,entityId:r.entityId,name:r.name});
    const grid=[...keys.values()].sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name,'ru'));
    const map=new Map(a.map(r=>[r.id,r]));let headers='',sub='';for(let i=1;i<=days;i++){headers+=`<th colspan="2">${i}</th>`;sub+='<th>Д</th><th>Н</th>';}
    return `<div class="ts-toolbar">${hasPermission('timesheet_export')?btn('↓ Табель CSV','export')+btn('↓ Материалы CSV','export-materials'):''}${btn('История изменений','history')}</div>`+note('Д — дневная смена, Н — ночная. Нажмите ячейку для открытия. «—» — часы ещё не заполнены; пусто — записи нет.')+`<div class="ts-table-wrap"><table class="ts-table"><thead><tr><th rowspan="2">Сотрудник / техника</th>${headers}<th rowspan="2">Итого, ч</th></tr><tr>${sub}</tr></thead><tbody>${grid.map(g=>{let total=0;let cells='';for(let i=1;i<=days;i++)for(const shift of ['day','night']){const date=month+'-'+String(i).padStart(2,'0'),id=C.entryId(g.kind,S.objectId,date,shift,g.entityId),r=map.get(id);if(r)total+=r.minutes||0;cells+=`<td class="${r?.pending?'ts-pending':''}">${r?`<button type="button" data-action="entry" data-id="${E(id)}">${r.status==='unfilled'?'—':r.status==='work'?C.fmt(r.minutes):r.status==='off'?'В':'НЯ'}</button>`:''}</td>`;}return `<tr><th>${E(g.name)}<small>${g.kind==='person'?'Сотрудник':'Техника'}</small></th>${cells}<td><b>${C.fmt(total)}</b></td></tr>`;}).join('')}</tbody></table></div>${!grid.length?note('За этот месяц пока нет записей.') : ''}`+materialsView(true);
  }
  function catalogView(){return note('Эти справочники общие для объектов. Изменение имени или экипажа не меняет уже заполненные смены.')+['timesheetPeople','timesheetEquipment'].map(col=>`<section class="ts-section"><div class="ts-section-title"><h3>${names[col]}</h3>${manage()?btn('＋ Добавить','catalog',`data-col="${col}"`):''}</div>${sort(living(col)).map(r=>`<div class="ts-row"><div class="ts-row-name"><strong>${E(r.name)}</strong><small>${E(col==='timesheetPeople'?groups[r.group]:(r.ownership==='hired'?r.contractor:'Своя техника'))}${col==='timesheetEquipment'?' · экипаж '+r.crewIds.length:''}</small></div>${manage()?btn('Изменить','catalog',`data-col="${col}" data-id="${E(r.id)}"`):''}</div>`).join('')||note('Список пока пуст.')}</section>`).join('');}
  function render(){
    if(!active())return;
    if(host.contains(document.activeElement)&&['INPUT','SELECT'].includes(document.activeElement.tagName))return;
    if(!allowed()){host.innerHTML=note('Нет доступа к табелю.');return;}
    const pending=S.jobs.filter(x=>x.status==='queued').length,failed=S.jobs.filter(x=>x.status!=='queued');
    const syncText=pending?`На устройстве: ${pending} · ожидают отправки`:!navigator.onLine?'Нет связи · показываем сохранённые данные':S.objectId&&C.collections.every(c=>S.ready[c])?'Данные подтверждены сервером':'Проверяем данные с сервером…';
    const html=`<div class="ts-heading"><div><h2>Учёт объекта</h2><p>Люди · техника · материалы</p></div><span class="ts-version">Тест 3.1</span></div><div class="ts-filters">${field('Объект',`<select id="ts-object"><option value="">Выберите объект</option>${state.objects.map(o=>choice(o.id,o.name,S.objectId)).join('')}</select>`)}${field(S.view==='month'?'Месяц':'Дата начала',`<input id="ts-date" type="${S.view==='month'?'month':'date'}" value="${S.view==='month'?S.date.slice(0,7):S.date}">`)}${S.view==='day'?field('Смена',`<select id="ts-shift">${choice('day','☀ День',S.shift)}${choice('night','☾ Ночь',S.shift)}</select>`):''}</div><div class="ts-tabs">${[['day','Смена'],['month','Месяц'],['catalog','Справочники']].map(([v,t])=>btn(t,'view',`data-view="${v}" aria-pressed="${S.view===v}"`)).join('')}</div><div class="ts-sync" role="status">${E(syncText)}${pending?btn('Повторить отправку','retry'):''}</div>${Object.values(S.errors).map(e=>`<div class="ts-warning">${E(e)}</div>`).join('')}${failed.length?`<div class="ts-warning"><b>Требуют проверки: ${failed.length}</b>${failed.map(j=>`<div>${E(j.label)} · ${E(j.error||'Конфликт')} ${btn('Разобрать','conflict',`data-id="${j.id}"`)}</div>`).join('')}</div>`:''}${!S.local?note('Открываем локальное хранилище…'):S.view==='catalog'?catalogView():S.objectId?(S.view==='day'?dayView():monthView()):note('Выберите существующий объект. Новый объект можно добавить во вкладке «База».')}`;
    if(html!==S.lastHtml){host.innerHTML=html;S.lastHtml=html;}
  }
  function dialog(title,body,onSubmit){
    S.dialog?.close();const el=document.createElement('dialog');el.className='ts-dialog';el.innerHTML=`<form><div class="ts-dialog-title"><h3>${E(title)}</h3><button type="button" data-close aria-label="Закрыть">×</button></div><div class="ts-dialog-body">${body}</div><p class="ts-form-error" role="alert"></p><div class="ts-dialog-actions">${onSubmit?'<button class="ts-btn ts-primary" type="submit">Сохранить</button>':''}<button type="button" class="ts-btn" data-close>Закрыть</button></div></form>`;document.body.append(el);S.dialog=el;el.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>el.close());el.addEventListener('close',()=>{if(S.dialog===el)S.dialog=null;el.remove();});
    el.querySelector('form').onsubmit=async e=>{e.preventDefault();if(!onSubmit||adding)return;const button=el.querySelector('[type=submit]');adding=true;button.disabled=true;try{await onSubmit(new FormData(e.target),el);el.close();}catch(err){el.querySelector('.ts-form-error').textContent=err.message;}finally{adding=false;button.disabled=false;}};el.showModal();return el;
  }
  function catalogForm(col,id){
    if(!manage())return;const r=rows(col).find(x=>x.id===id),isPerson=col==='timesheetPeople';
    const body=field(isPerson?'Фамилия и имя':'Название / номер техники',input('name',r?.name,'required maxlength="160"'))+(isPerson?field('Группа',`<select name="group">${Object.entries(groups).map(([k,v])=>choice(k,v,r?.group||'worker')).join('')}</select>`):field('Принадлежность',`<select name="ownership">${choice('own','Своя',r?.ownership||'own')}${choice('hired','Привлечённая',r?.ownership)}</select>`)+field('Организация',input('contractor',r?.contractor,'maxlength="160"'))+`<fieldset><legend>Обычный экипаж</legend>${sort(living('timesheetPeople')).map(p=>`<label class="ts-check"><input type="checkbox" name="crew" value="${E(p.id)}"${r?.crewIds.includes(p.id)?' checked':''}>${E(p.name)}</label>`).join('')||note('Сначала добавьте сотрудников.')}</fieldset>`)+(r?'<label class="ts-check"><input type="checkbox" name="archive">Убрать из справочника (историю сохранить)</label>':'');
    dialog(isPerson?'Сотрудник':'Техника и экипаж',body,async f=>{
      const name=C.text(f.get('name'),'Название');if(living(col).some(p=>p.id!==id&&p.name.trim().toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru')))throw Error('Такое имя уже есть. Для тёзки добавьте отчество или табельный номер.');
      const data=isPerson?{name,group:f.get('group'),deleted:f.has('archive')}:{name,ownership:f.get('ownership'),contractor:String(f.get('contractor')||'').trim(),crewIds:f.getAll('crew'),deleted:f.has('archive')};
      await enqueue([{collection:col,id:id||uid(),baseRevision:r?.revision||0,before:r?ownData(r):null,data}],isPerson?'Справочник сотрудников':'Справочник техники');
    });
  }
  function blankEntry(kind,entity,equipmentId=''){
    if(!object())throw Error('Выберите объект');
    return {kind,entityId:entity.id,name:entity.name,group:entity.group||'',ownership:entity.ownership||'',contractor:entity.contractor||'',objectId:S.objectId,objectName:object().name,date:S.date,shift:S.shift,scope:C.scope(S.objectId,S.date),minutes:null,idleMinutes:0,status:'unfilled',equipmentId,note:'',deleted:false};
  }
  function addForm(kind){
    if(!edit()||!object())return;const col=kind==='person'?'timesheetPeople':'timesheetEquipment',list=sort(living(col));
    const el=dialog(kind==='person'?'Добавить людей в смену':'Добавить технику и экипаж',note(kind==='person'?'Отметьте нужных сотрудников.':'Сохранённые машинисты добавятся с незаполненными часами. Уже внесённые люди без привязки будут включены в экипаж. Их часы и существующие назначения сохранятся.')+list.map(r=>`<label class="ts-check"><input type="checkbox" name="ids" value="${E(r.id)}">${E(r.name)}</label>`).join('')+(list.length?'':note('Сначала заполните справочник.')),async f=>{
      const changes=new Map(),existing=dayEntries();
      const append=(k,e,machine='')=>{const id=C.entryId(k,S.objectId,S.date,S.shift,e.id),old=existing.find(x=>x.id===id);if(changes.has(id))return;if(old){if(k==='person'&&machine&&!old.equipmentId)changes.set(id,change('timesheetEntries',id,{...ownData(old),equipmentId:machine}));return;}changes.set(id,change('timesheetEntries',id,blankEntry(k,e,machine)));};
      for(const id of f.getAll('ids')){const entity=list.find(x=>x.id===id);append(kind,entity);if(kind==='equipment')for(const personId of entity.crewIds){const p=living('timesheetPeople').find(x=>x.id===personId);if(p)append('person',p,entity.id);}}
      if(!changes.size)throw Error('Выберите новые строки для этой смены');await enqueue([...changes.values()],'Добавлен состав смены');
    });return el;
  }
  function entryForm(id){
    const r=rows('timesheetEntries').find(x=>x.id===id);if(!r||r.deleted)return;
    const machines=entries().filter(x=>x.kind==='equipment'&&x.date===r.date&&x.shift===r.shift);
    const body=note(`${E(r.objectName)} · ${fmtDate(r.date)} · ${shiftName(r.shift)}`)+field('Отметка',`<select name="status">${Object.entries(statuses).map(([k,v])=>choice(k,v,r.status)).join('')}</select>`)+field('Отработано, часов',input('hours',C.fmt(r.minutes),'inputmode="decimal" placeholder="Например, 12 или 7,5"'))+(r.kind==='equipment'?field('Простой, часов',input('idle',C.fmt(r.idleMinutes),'inputmode="decimal"')):field('Работал на технике',`<select name="equipmentId">${choice('','Без привязки',r.equipmentId)}${machines.map(m=>choice(m.entityId,m.name,r.equipmentId)).join('')}</select>`))+field('Комментарий',`<textarea name="note" maxlength="500">${E(r.note)}</textarea>`)+(edit()?'<label class="ts-check"><input type="checkbox" name="remove">Убрать строку из этой смены</label>':'');
    const el=dialog(r.name,body,edit()?async f=>{
      let status=f.get('status'),minutes=C.hours(f.get('hours'));if(status==='unfilled'&&minutes!==null)status='work';if(['off','absent'].includes(status))minutes=0;if(status==='work'&&minutes===null)throw Error('Укажите отработанные часы');
      const data={...ownData(r),status,minutes:status==='unfilled'?null:minutes,idleMinutes:r.kind==='equipment'?C.hours(f.get('idle'),false):0,equipmentId:r.kind==='person'?String(f.get('equipmentId')||''):'',note:String(f.get('note')||'').trim(),deleted:f.has('remove')};
      await enqueue([{collection:'timesheetEntries',id,baseRevision:r.revision||0,before:ownData(r),data}],'Часы: '+r.name);
    }:null);
    if(!edit())el.querySelectorAll('input,select,textarea').forEach(i=>i.disabled=true);
    else el.querySelector('[name=hours]').addEventListener('input',e=>{if(e.target.value.trim())el.querySelector('[name=status]').value='work';});
  }
  function bulkForm(){
    if(!edit())return;const list=sort(dayEntries().filter(x=>x.kind==='person'));
    dialog('Часы группе',field('Всем выбранным, часов',input('hours','12','inputmode="decimal" required'))+list.map(r=>`<label class="ts-check"><input type="checkbox" name="ids" value="${E(r.id)}"${r.status==='unfilled'?' checked':''}>${E(r.name)} <span class="ts-muted">${r.status==='unfilled'?'не заполнено':C.fmt(r.minutes)+' ч'}</span></label>`).join(''),async f=>{
      const minutes=C.hours(f.get('hours'),false),ids=f.getAll('ids');if(!ids.length)throw Error('Выберите сотрудников');
      await enqueue(ids.map(id=>{const r=list.find(x=>x.id===id);return {collection:'timesheetEntries',id,baseRevision:r.revision||0,before:ownData(r),data:{...ownData(r),minutes,status:'work'}};}),'Часы группе');
    });
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
  host.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b)return;const {action,id,col,view}=b.dataset;
    const actions={view:()=>{S.view=view;render();},'add-person':()=>addForm('person'),'add-equipment':()=>addForm('equipment'),entry:()=>entryForm(id),bulk:bulkForm,copy:copyForm,catalog:()=>catalogForm(col,id),material:()=>materialForm(id),retry:replay,conflict:()=>conflictForm(id),export:()=>exportCsv(false),'export-materials':()=>exportCsv(true),history};
    try{Promise.resolve(actions[action]?.()).catch(error);}catch(e){error(e);}
  });
  host.addEventListener('change',e=>{const t=e.target;if(t.id==='ts-object')S.objectId=t.value;else if(t.id==='ts-date'){if(!t.value)return;S.date=t.type==='month'?t.value+'-01':t.value;}else if(t.id==='ts-shift')S.shift=t.value;else return;t.blur();period().catch(error);render();});
  window.Timesheet={session,render,reset};
  const previousRender=window.renderAll;window.renderAll=function(){previousRender.apply(this,arguments);session();render();};
  const previousStop=window.stopSync;window.stopSync=function(){reset();return previousStop.apply(this,arguments);};
  auth.onAuthStateChanged(()=>{reset();session();});
  window.addEventListener('online',()=>{replay();render();});window.addEventListener('offline',render);
  setInterval(()=>{session();if(allowed()&&S.local){loadJobs().then(()=>{render();replay();}).catch(error);}},6000);
  session();
})();
