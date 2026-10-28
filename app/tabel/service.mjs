import C from './storage-core.mjs';
import * as D from './domain.mjs';
export const clean=row=>Object.fromEntries(Object.entries(row).filter(([k])=>!['id','revision','lastOpId','updatedBy','updatedName','updatedAt','pending'].includes(k)));

/* The old ledger's storage names, keys, minutes, transactions and queue are retained.
   This service has no host UI wrappers, Line timers or write access to host collections. */
export async function createService(ctx){
  const initial=ctx.ledgerHost.session();
  if(initial.projectId!=='samosval-offline'||!initial.uid||!initial.tabAccess)throw Error('Нет доступа к тестовому табелю');
  const user=initial.uid,cache=new Map(),subs=new Map(),listeners=new Set(),tasks=new Set();
  let dbLocal=null,jobs=[],disposed=false,busy=false,revision=0,timer=null;
  const hostData=ctx.ledgerHost.data();
  let objectId=(hostData.objects.find(x=>x.id===hostData.shift?.objectId)||hostData.objects[0])?.id||'',day=D.isoToday(),shift='day';
  const actor=()=>ctx.ledgerHost.session();
  const allowed=()=>!disposed&&actor().uid===user&&actor().status==='active'&&actor().tabAccess;
  const check=()=>{if(!allowed())throw Error('Доступ или учётная запись изменились');};
  const track=promise=>{const task=Promise.resolve(promise).finally(()=>tasks.delete(task));tasks.add(task);return task;};
  const notify=()=>{if(!allowed())return;for(const fn of listeners)Promise.resolve(fn()).catch(e=>ctx.showToast(e.message,true));};
  const transaction=fn=>ctx.ledgerHost.transaction(fn);
  const rows=(col,obj,scopes)=>C.project([...new Map([...cache.values()].filter(x=>x.col===col&&(!obj||x.objectId===obj)&&(!scopes||scopes.includes(x.scope))).flatMap(x=>x.rows).map(x=>[x.id,x])).values()],jobs,col).filter(x=>!obj||x.objectId===obj);
  const config=obj=>rows('timesheetObjects',obj).find(x=>!x.deleted);
  const permission=(obj,area,mode='view')=>D.can(actor(),config(obj),area,mode);
  function checkChange(ch){
    check();if(!C.collections.includes(ch.collection))throw Error('Запись вне табеля');
    const catalog=['timesheetPeople','timesheetEquipment'].includes(ch.collection);
    if(catalog){if(!actor().manage)throw Error('Нет права изменять справочники');return;}
    if(!actor().permissions.edit)throw Error('Нет права записи в табель');
    const obj=ch.data.objectId;
    if(ch.collection==='timesheetObjects'){
      const before=ch.before||{},rest=x=>Object.fromEntries(Object.entries(clean(x)).filter(([k])=>!['request','acl'].includes(k)));
      if(JSON.stringify(rest(before))!==JSON.stringify(rest(ch.data))&&!permission(obj,'settings','edit'))throw Error('Нет права изменять настройки');
      for(const [field,area]of [['request','request'],['acl','permissions']])if(JSON.stringify(before[field]||{})!==JSON.stringify(ch.data[field]||{})&&!permission(obj,area,'edit'))throw Error('Нет права: '+area+'.edit');
      return;
    }
    if(['timesheetEntries','timesheetMaterials'].includes(ch.collection)&&!config(obj))return; // Legacy queued rows retain their original host permission gate.
    if(ch.collection==='timesheetEntries'){
      if(!permission(obj,'shift','edit')||!permission(obj,ch.data.kind==='person'?'people':'equipment','edit'))throw Error('Нет права изменять эту строку смены');
    }else{
      const area=ch.collection==='timesheetSheets'?'table':ch.collection==='timesheetDays'?'shift':ch.collection==='timesheetMaterials'?'materials':ch.data.kind==='work'?'plans':'materials';
      if(!permission(obj,area,'edit'))throw Error('Нет права: '+area+'.edit');
    }
  }
  function local(store,method,value){
    const database=dbLocal;if(!database)throw Error('Хранилище табеля закрыто');
    return track(new Promise((resolve,reject)=>{const tx=database.transaction(store,['get','getAll'].includes(method)?'readonly':'readwrite'),r=tx.objectStore(store)[method](value);let result;r.onsuccess=()=>result=r.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error||r.error);tx.onabort=()=>reject(tx.error||Error('Не удалось сохранить на устройстве'));}));
  }
  async function loadJobs(){const data=await local('jobs','getAll');if(!disposed)jobs=data.sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));}
  async function read(col,obj,scope){
    check();if(!C.collections.includes(col))throw Error('Чтение вне табеля');
    const key='tabel:'+col+':'+(obj||'')+':'+(scope||'');
    if(!cache.has(key)){
      let saved=await local('cache','get',key);
      // Read the same legacy cache when no extension-specific copy exists.
      if(!saved&&['timesheetPeople','timesheetEquipment'].includes(col))saved=await local('cache','get',col);
      if(!saved&&scope&&['timesheetEntries','timesheetMaterials'].includes(col))saved=await local('cache','get',col+':'+scope);
      check();cache.set(key,{col,objectId:obj,scope,rows:saved?.rows||[],complete:!!saved});
    }
    const saved=cache.get(key),result=()=>({rows:C.project(saved.rows,jobs,col).filter(x=>!obj||x.objectId===obj),complete:saved.complete,error:saved.error||(!saved.complete?'Нет подтверждённого кэша':'')});
    if(subs.has(key))return result();
    let query=ctx.ledgerHost.workspace.collection(col);if(obj)query=query.where('objectId','==',obj);if(scope)query=query.where('scope','==',scope);
    async function accept(snap){if(!allowed()||snap.metadata?.fromCache)return;saved.rows=snap.docs.map(d=>({...d.data(),id:d.id}));saved.complete=true;delete saved.error;await local('cache','put',{key,rows:saved.rows});notify();}
    if(navigator.onLine&&!saved.complete){let timeout;try{await accept(await Promise.race([query.get({source:'server'}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Нет ответа сервера. Доступны локальные данные.')),4000);})]));}catch(e){saved.error=e.message;}finally{clearTimeout(timeout);}}
    check();subs.set(key,query.onSnapshot({includeMetadataChanges:true},snap=>track(accept(snap)).catch(e=>{if(allowed()){saved.error=e.message;notify();}}),e=>{if(allowed()){saved.error=e.message;notify();}}));
    return result();
  }
  async function acceptChanges(changes){
    for(const ch of changes)for(const [key,item]of cache){if(item.col!==ch.collection||(item.objectId&&item.objectId!==ch.after.objectId)||(item.scope&&item.scope!==ch.after.scope))continue;const row={...ch.after,id:ch.id},i=item.rows.findIndex(x=>x.id===ch.id);if(i<0)item.rows.push(row);else item.rows[i]=row;await local('cache','put',{key,rows:item.rows});}
  }
  function replay(){return track(replayQueue());}
  async function replayQueue(){
    if(!allowed()||!dbLocal||busy||!navigator.onLine)return;busy=true;
    const work=async()=>{await loadJobs();for(const op of jobs.filter(x=>x.status==='queued')){
      if(!allowed()||!navigator.onLine)break;
      try{
        if(actor().role!=='admin')for(const obj of new Set(op.changes.map(x=>x.data.objectId).filter(Boolean)))await read('timesheetObjects',obj);
        op.changes.forEach(checkChange);
        const result=await C.commitOperation(ctx.db,ctx.ledgerHost.workspace,op,{uid:user,name:actor().name,serverTimestamp:ctx.ledgerHost.serverTimestamp},transaction);
        if(disposed)break;
        if(result.changes)await acceptChanges(result.changes);
        await local('jobs','delete',op.id);
      }catch(e){
        if(disposed)break;if(!navigator.onLine||['unavailable','deadline-exceeded','aborted','cancelled'].includes(e.code))break;
        op.status=e.code==='conflict'?'conflict':'rejected';op.error=e.code==='permission-denied'?'Сервер отклонил запись. Нужны права или правила тестовой базы.':e.message;if(e.conflicts)op.conflicts=C.clone(e.conflicts);await local('jobs','put',op);
      }
    }if(!disposed)await loadJobs();};
    try{if(navigator.locks)await navigator.locks.request('dt-timesheet-'+user,{ifAvailable:true},lock=>lock?work():undefined);else await work();}
    catch(e){if(allowed())ctx.showToast('Очередь табеля: '+e.message,true);}
    finally{busy=false;notify();}
  }
  async function save(changes,label){
    check();if(!changes.length)return;for(const ch of changes){checkChange(ch);if(ch.data.objectId&&ch.data.objectId!==objectId)throw Error('Объект изменился');}
    const ops=[],stamp=Math.max(Date.now(),...jobs.map(x=>x.createdAt+1));
    for(let i=0;i<changes.length;i+=4){const op={id:crypto.randomUUID(),uid:user,scope:objectId?C.scope(objectId,day):'catalog',label,createdAt:stamp+i,status:'queued',changes:changes.slice(i,i+4)};C.validateOperation(op);ops.push(op);}
    await track(new Promise((resolve,reject)=>{const tx=dbLocal.transaction('jobs','readwrite');for(const op of ops)tx.objectStore('jobs').put(op);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Очередь не сохранена'));}));
    check();await loadJobs();notify();replay();
  }
  async function resolve(id,mode){
    check();const op=jobs.find(x=>x.id===id);if(!op)return;
    await local('cache','put',{key:'tabel-resolution:'+id,value:{...C.clone(op),resolution:mode,resolvedAt:Date.now()}});
    if(mode==='server')await local('jobs','delete',id);
    else{
      if(!navigator.onLine)throw Error('Для сравнения нужна связь');op.changes.forEach(checkChange);
      const snaps=await Promise.all(op.changes.map(ch=>ctx.ledgerHost.workspace.collection(ch.collection).doc(ch.id).get({source:'server'})));check();
      if(op.conflicts&&snaps.some((snap,i)=>(snap.exists?snap.data().revision||0:0)!==(op.conflicts.find(x=>x.id===op.changes[i].id&&x.collection===op.changes[i].collection)?.server?.revision||0))){op.conflicts=snaps.map((snap,i)=>({collection:op.changes[i].collection,id:op.changes[i].id,server:snap.exists?snap.data():null,proposed:op.changes[i].data}));await local('jobs','put',op);await loadJobs();throw Error('Данные снова изменились. Сравните обновлённые версии.');}
      snaps.forEach((snap,i)=>{op.changes[i].baseRevision=snap.exists?snap.data().revision||0:0;op.changes[i].before=snap.exists?snap.data():null;});op.status='queued';delete op.error;delete op.conflicts;await local('jobs','put',op);
    }
    await loadJobs();notify();replay();
  }
  const openRequest=indexedDB.open('dt_timesheet_v1_'+initial.projectId+'_'+initial.workspaceId+'_'+user,1);
  dbLocal=await track(new Promise((resolve,reject)=>{openRequest.onupgradeneeded=()=>{openRequest.result.createObjectStore('jobs',{keyPath:'id'});openRequest.result.createObjectStore('cache',{keyPath:'key'});};openRequest.onsuccess=()=>resolve(openRequest.result);openRequest.onerror=()=>reject(openRequest.error);openRequest.onblocked=()=>reject(Error('Закройте другую вкладку табеля'));}));
  await loadJobs();await Promise.all(['timesheetPeople','timesheetEquipment'].map(col=>read(col)));
  const online=()=>{replay();notify();},offline=()=>notify();window.addEventListener('online',online);window.addEventListener('offline',offline);
  timer=setInterval(()=>{if(!allowed()){ctx.ledgerHost.leave();dispose();return;}replay();notify();},6000);
  async function idle(){do{await Promise.allSettled([...tasks]);await Promise.resolve();}while(tasks.size);}
  async function dispose(){if(disposed)return idle();disposed=true;revision++;clearInterval(timer);subs.forEach(fn=>fn());subs.clear();listeners.clear();window.removeEventListener('online',online);window.removeEventListener('offline',offline);await idle();dbLocal?.close();dbLocal=null;}
  const api={
    context:()=>{check();return {object:C.clone(ctx.ledgerHost.data().objects.find(x=>x.id===objectId)||{id:'',name:'Объект не выбран'}),date:day,shift,actor:actor(),generation:revision,online:navigator.onLine};},
    objects:()=>C.clone(ctx.ledgerHost.data().objects),
    select:async(obj,date=day,nextShift=shift)=>{check();D.date(date);if(!['day','night'].includes(nextShift))throw Error('Некорректная смена');if(!ctx.ledgerHost.data().objects.some(x=>x.id===obj))throw Error('Объект не найден');objectId=obj;day=date;shift=nextShift;},
    navigate:async date=>{D.date(date);day=date;},
    read,peek:rows,can:permission,clean,save,catalog:col=>rows(col).filter(x=>!x.deleted),
    subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},refresh:notify,
    release:()=>{for(const [key,off]of subs)if(!['timesheetPeople','timesheetEquipment'].includes(cache.get(key)?.col)){off();subs.delete(key);}},
    draft:async(key,value)=>{const k='tabel-draft:'+objectId+':'+key;if(value===undefined)return(await local('cache','get',k))?.value;await local('cache','put',{key:k,value});},
    queue:()=>C.clone(jobs),resolveOperation:resolve,replay,idle,dispose,
    historyRows:async()=>{check();const snap=await ctx.ledgerHost.workspace.collection('timesheetChanges').where('scope','==',C.scope(objectId,day)).get({source:'server'});check();return snap.docs.map(d=>({...d.data(),id:d.id}));},
    toast:message=>ctx.showToast(message,false),showError:error=>ctx.showToast(error.message,true),
    line:()=>C.clone(ctx.ledgerHost.data()),
    lineHistory:async(obj,date)=>{
      check();D.date(date);const key='tabel-line-audit:'+obj+':'+date,cached=await local('cache','get',key);
      if(!navigator.onLine)return{audit:cached?.rows||[],confirmed:false,note:'Офлайн: сохранённый журнал прибытий'};
      try{const start=Date.parse(date+'T00:00:00+03:00');let query=ctx.refs.audit.where('timestamp','>=',start).where('timestamp','<',start+86400000);if(query.limit)query=query.limit(3000);const snap=await query.get({source:'server'});check();const all=snap.docs.map(d=>({...d.data(),id:d.id})),data=all.filter(x=>x.objectId===obj);await local('cache','put',{key,rows:data});return{audit:data,confirmed:all.length<3000,note:all.length>=3000?'Лимит событий: история неполная':''};}catch(e){return{audit:cached?.rows||[],confirmed:false,note:e.message};}
    }
  };
  replay();return api;
}
