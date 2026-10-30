
// Every successful database mutation and its undo snapshot share one transaction.
(function installHistoryRecorder(){
  if(window.__historyRecorderV3)return;window.__historyRecorderV3=true;
  const rawTransaction=db.runTransaction.bind(db),rawBatch=db.batch.bind(db);
  window.__historyRawTransaction=rawTransaction;
  const prefix='workspaces/'+WORKSPACE_ID+'/';
  const collections=new Set(['trucks','objects','logs','truckStatus','shift','archive','trash','plugins','patches']);
  function eligible(ref){
    if(ref.firestore!==db||!currentUid||currentUserStatus!=='active')return false;
    const p=ref.path.split('/');
    return p.length===4&&ref.path.startsWith(prefix)&&collections.has(p[2]) || p.length===2&&(['users','registration_requests'].includes(p[0])||p[0]==='settings'&&['permissions','appConfig'].includes(p[1]));
  }
  const copy=x=>x==null?x:JSON.parse(JSON.stringify(x));
  function merge(a,b){const out={...a};for(const [k,v] of Object.entries(b)){if(v&&Object.getPrototypeOf(v)===Object.prototype&&out[k]&&typeof out[k]==='object'&&!Array.isArray(out[k]))out[k]=merge(out[k],v);else out[k]=copy(v);}return out;}
  function update(a,b){const out=copy(a||{});for(const [path,value] of Object.entries(b)){const keys=path.split('.');let target=out;for(const k of keys.slice(0,-1))target=target[k]||(target[k]={});target[keys.at(-1)]=copy(value);}return out;}
  function title(ops){
    const load=ops.find(o=>o.collection==='logs'&&!o.before&&o.after),status=ops.find(o=>o.collection==='truckStatus');
    const deletedLoad=ops.find(o=>o.collection==='logs'&&o.before&&!o.after);
    if(deletedLoad&&status)return 'Отмена погрузки · '+(deletedLoad.before.truckName||deletedLoad.id);
    if(load&&status)return 'Погрузка · '+(load.after.truckName||load.id);
    if(status&&ops.length===1){const a=status.before||{},b=status.after||{},truck=typeof truckName==='function'?truckName(status.id):status.id;return (a.lastLoadTimestamp&&!b.lastLoadTimestamp?'Сброс таймера':a.arriveTimestamp!==b.arriveTimestamp?(b.arriveTimestamp?'Прибытие':'Снятие прибытия'):a.ttnStatus!==b.ttnStatus?'Отметка ТТН':!status.before?'Добавление на линию':!status.after?'Снятие с линии':'Изменение состояния')+' · '+truck;}
    const names={trucks:'Самосвал',objects:'Объект',logs:'Рейс',shift:'Смена',archive:'Архив',trash:'Корзина',users:'Пользователь',settings:'Настройки',registration_requests:'Заявка',plugins:'Расширение',patches:'Патч',truckStatus:'Линия'};
    return ops.map(o=>(names[o.collection]||o.collection)+' · '+(!o.before?'создание':!o.after?'удаление':'изменение')+' · '+((o.after||o.before)?.number||(o.after||o.before)?.name||(o.after||o.before)?.email||o.id)).slice(0,3).join('; ')+(ops.length>3?' · ещё '+(ops.length-3):'');
  }
  function refInfo(ref){const p=ref.path.split('/');return {collection:p.length===4?p[2]:p[0],id:p.at(-1),path:ref.path};}
  async function run(callback,options){
    if(isNasRuntime())throw new Error('Запись Firebase запрещена в режиме Synology');
    const historyId='history_'+(crypto.randomUUID?crypto.randomUUID():Date.now()+'_'+Math.random().toString(36).slice(2));
    const actor={uid:currentUid,email:currentEmail,name:getUserName()},time=Date.now();
    return rawTransaction(async tx=>{
      const writes=[];const facade={get:r=>tx.get(r),set:(...args)=>{writes.push(['set',args]);return facade;},update:(...args)=>{writes.push(['update',args]);return facade;},delete:(...args)=>{writes.push(['delete',args]);return facade;}};
      const result=await callback(facade),records=new Map();
      for(const [method,args] of writes){const [ref,data,opts]=args;if(!eligible(ref))continue;
        if(!records.has(ref.path)){const snap=await tx.get(ref);const before=snap.exists?snap.data():null;records.set(ref.path,{...refInfo(ref),before,after:copy(before)});}
        const op=records.get(ref.path);
        if(method==='delete')op.after=null;
        else if(method==='update'){if(!op.after)throw new Error('Обновляемая запись отсутствует');if(!data||typeof data!=='object')throw new Error('Используйте объект для изменения записи');op.after=update(op.after,data);}
        else op.after=opts?.merge?merge(op.after||{},data):copy(data);
      }
      const operations=[...records.values()].filter(op=>JSON.stringify(op.before)!==JSON.stringify(op.after));
      let entry;
      if(operations.length){
        if(currentUserRole!=='admin'&&operations.length>4)throw new Error('Одна операция этой роли может изменять не более четырёх записей. Выполните изменения по частям.');
        if(actor.uid!==currentUid)throw new Error('Учётная запись изменилась. Повторите действие.');
        const description=title(operations);entry={text:description,timestamp:time,timeStr:new Date(time).toLocaleString('ru-RU'),userName:actor.name,userEmail:actor.email,createdByEmail:actor.email,shiftId:state.shift?.id||'',objectId:state.shift?.objectId||'',objectName:state.shift?.objectName||'',eventType:'history',history:{id:historyId,version:3,description,user:actor.name,userEmail:actor.email,userUid:actor.uid,timestamp:time,operations,undone:false}};
        // Freeze the reward policy with the confirmed history entry; legacy entries are never repriced.
        if(window.__gameRewardSnapshot&&operations.some(o=>o.collection==='logs'||o.collection==='truckStatus')){
          const rewardPolicy=await tx.get(appConfigRef);
          entry.history.gameRewards=window.__gameRewardSnapshot(rewardPolicy.exists?rewardPolicy.data():{},result?.gameRewardAction,time);
        }
        if(new Blob([JSON.stringify(entry)]).size>900000)throw new Error('Изменение слишком большое для одной записи истории. Разделите его на части.');
      }
      for(const [method,args] of writes)tx[method](...args);
      if(entry)tx.set(refs.audit.doc(historyId),entry);
      return result;
    },options);
  }
  db.runTransaction=run;
  const proto=Object.getPrototypeOf(refs.trucks.doc());
  for(const method of ['set','update','delete']){const original=proto[method];proto[method]=function(...args){if(isNasRuntime())throw new Error('Запись Firebase запрещена в режиме Synology');if(!eligible(this))return original.apply(this,args);return run(tx=>tx[method](this,...args)).then(()=>undefined);};}
  const collectionProto=Object.getPrototypeOf(refs.trucks),originalAdd=collectionProto.add;
  collectionProto.add=function(data){if(isNasRuntime())throw new Error('Запись Firebase запрещена в режиме Synology');const ref=this.doc();if(!eligible(ref))return originalAdd.call(this,data);return run(tx=>tx.set(ref,data)).then(()=>ref);};
  db.batch=function(){const original=rawBatch(),writes=[];const batch={};for(const method of ['set','update','delete'])batch[method]=(...args)=>{writes.push([method,args]);return batch;};batch.commit=async()=>{if(isNasRuntime())throw new Error('Запись Firebase запрещена в режиме Synology');if(currentUserRole!=='admin'&&writes.length>4&&writes.some(([,args])=>eligible(args[0]))){for(let i=0;i<writes.length;i+=4)await run(tx=>{for(const [method,args] of writes.slice(i,i+4))tx[method](...args);});return;}if(writes.some(([,args])=>eligible(args[0])))return run(tx=>{for(const [method,args] of writes)tx[method](...args);});for(const [method,args] of writes)original[method](...args);return original.commit();};return batch;};
})();

