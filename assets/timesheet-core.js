/* Test-site field ledger. Pure validation and transaction engine; no production writes. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TimesheetCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const collections = ['timesheetPeople', 'timesheetEquipment', 'timesheetEntries', 'timesheetMaterials', 'timesheetShifts', 'timesheetSettings'];
  const units = ['т', 'м³', 'шт', 'л', 'кг', 'м²', 'м.п.'];
  const clone = value => JSON.parse(JSON.stringify(value));
  function fail(message, code = 'invalid') { const e = new Error(message); e.code = code; throw e; }
  function text(value, label, max = 160, optional = false) {
    const s = String(value == null ? '' : value).trim();
    if ((!s && !optional) || s.length > max) fail(label + ': проверьте значение');
    return s;
  }
  function date(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value + 'T12:00:00Z').toISOString().slice(0,10) !== value) fail('Некорректная дата');
    return value;
  }
  function hours(value, optional = true) {
    const s = String(value == null ? '' : value).trim().replace(',', '.');
    if (!s && optional) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) fail('Часы: введите число от 0 до 24');
    const n = Number(s); if (n > 24) fail('Часы: не больше 24 за смену');
    return Math.round(n * 60);
  }
  function quantity(value) {
    const s = String(value).trim().replace(',', '.');
    if (!/^\d+(\.\d{1,3})?$/.test(s) || Number(s) <= 0 || Number(s) > 100000000) fail('Количество: введите положительное число');
    return Math.round(Number(s)*1000) / 1000;
  }
  const fmt = minutes => minutes == null ? '' : Number((minutes / 60).toFixed(2)).toLocaleString('ru-RU');
  const scope = (objectId, day) => encodeURIComponent(objectId) + '|' + day.slice(0,7);
  const entryId = (kind, objectId, day, shift, entityId) => [kind,objectId,day,shift,entityId].map(encodeURIComponent).join('~');
  const operatorRoles={mill:'Машинисты фрезы',tractor:'Трактористы',water:'Водители поливомойки',loader:'Машинисты погрузчика',bus:'Водители автобуса',driver:'Водители',other:'Другие машинисты',unassigned:'Специализация не указана'};
  const equipmentTypes={
    water:{label:'Поливомоечная',order:0,tone:'water',role:'water',minimum:1,one:'Водитель поливомойки',many:'Водители поливомойки'},
    brush:{label:'МТЗ / щётка',order:1,tone:'brush',role:'tractor',minimum:1,one:'Тракторист',many:'Трактористы'},
    mill:{label:'Фреза',order:2,tone:'mill',role:'mill',minimum:2,one:'Машинист фрезы',many:'Машинисты фрезы'},
    loader:{label:'Фронтальный погрузчик',order:3,tone:'loader',role:'loader',minimum:1,one:'Машинист погрузчика',many:'Машинисты погрузчика'},
    bus:{label:'Автобус / развозка',order:4,tone:'bus',role:'bus',minimum:1,one:'Водитель',many:'Водители'},
    xcmg:{label:'Погрузчик XCMG',order:5,tone:'xcmg',role:'loader',minimum:1,one:'Машинист погрузчика',many:'Машинисты погрузчика'},
    other:{label:'Другая техника',order:6,tone:'other',role:'other',minimum:1,one:'Машинист / водитель',many:'Экипаж'}
  };
  function equipmentType(machine){
    if(Object.hasOwn(equipmentTypes,machine.equipmentType))return machine.equipmentType;
    const name=String(machine.name||'').toLocaleLowerCase('ru').replace(/ё/g,'е');
    if(/полив|полево.*мо|водоле|водовоз|пмм/.test(name))return 'water';
    if(/щетк|муп.?351|трактор|мтз/.test(name))return 'brush';
    if(/фрез|w\s*[-–]?\s*(55|1000|150|200|205|210)/.test(name))return 'mill';
    if(/xcmg|ксмг/.test(name))return 'xcmg';
    if(/фронтал|погруз/.test(name))return 'loader';
    if(/автобус|паз|развоз/.test(name))return 'bus';
    return 'other';
  }
  const equipmentStyle=machine=>equipmentTypes[equipmentType(machine)];
  const defaultCrewCount=machine=>machine.ownership==='hired'?0:Math.max(equipmentStyle(machine).minimum,Number(machine.crewCount)||0);
  const personIdentity=row=>Object.hasOwn(row,'personId')?row.personId:String(row.entityId||'').startsWith('tscrew_')?'':row.entityId;
  const shiftId=(objectId,day,shift)=>['shift',objectId,day,shift].map(encodeURIComponent).join('~');
  function clock(value){if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))fail('Укажите время в формате ЧЧ:ММ');return Number(value.slice(0,2))*60+Number(value.slice(3));}
  function duration(start,end){const a=clock(start),b=clock(end);return b>a?b-a:b-a+1440;}
  function moveDate(day,delta){date(day);const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+delta);return d.toISOString().slice(0,10);}
  function slotEntry(machine,index,prior){
    const entityId='tscrew_'+machine.entityId+'_'+index,role=equipmentStyle(machine).role;
    return {kind:'person',entityId,name:equipmentStyle(machine).one+' '+(index+1),group:'operator',operatorRole:role,personId:'',crewSlot:index,ownership:'',contractor:'',objectId:machine.objectId,objectName:machine.objectName,date:machine.date,shift:machine.shift,scope:machine.scope,minutes:null,idleMinutes:0,status:'unfilled',equipmentId:machine.entityId,note:'',deleted:false,id:entryId('person',machine.objectId,machine.date,machine.shift,entityId),revision:prior?.revision||0,virtual:true};
  }
  function effectiveEntries(raw){
    const live=raw.filter(r=>!r.deleted),machines=live.filter(r=>r.kind==='equipment');
    const key=(r,equipment)=>[r.objectId,r.date,r.shift,equipment].join('|');
    const hired=new Set(machines.filter(r=>r.ownership==='hired').map(r=>key(r,r.entityId)));
    const result=live.filter(r=>!(r.kind==='person'&&r.group==='operator'&&hired.has(key(r,r.equipmentId))));
    for(const machine of machines){
      if(machine.ownership==='hired')continue;
      const crew=result.filter(r=>r.kind==='person'&&r.group==='operator'&&key(r,r.equipmentId)===key(machine,machine.entityId));
      const target=Math.max(defaultCrewCount(machine),crew.length);let index=0;
      while(crew.length<target){
        let slot=slotEntry(machine,index++);if(result.some(r=>r.id===slot.id))continue;
        const prior=raw.find(r=>r.id===slot.id);slot.revision=prior?.revision||0;crew.push(slot);result.push(slot);
      }
    }
    return result;
  }
  function sourceDay(value,timestamp){
    if(typeof value==='string'){if(/^\d{4}-\d{2}-\d{2}$/.test(value))return value;const m=value.match(/^(\d{2})\.(\d{2})\.(\d{4})/);if(m)return `${m[3]}-${m[2]}-${m[1]}`;}
    return timestamp?new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date(timestamp)):'';
  }
  function lineTrucks(state,objectId,day){
    const catalog=state.trucks||[],result=new Map();
    const add=(ids,logs,snapshots=[])=>{
      for(const id of ids||[]){const truck=catalog.find(t=>t.id===id),saved=snapshots.find(t=>t.id===id),evidence=(logs||[]).filter(l=>l.truckId===id);
        if(truck?.isGAI||saved?.isGAI||evidence.some(l=>l.isGAI))continue;
        if(!truck&&!saved&&!evidence.some(l=>l.isGAI===false))continue;
        result.set(id,{id,name:saved?.name||(truck?[truck.brand,truck.number].filter(Boolean).join(' '):evidence[0]?.truckName)||id});
      }
    };
    const active=state.shift;
    if(active&&active.isActive!==false&&active.objectId===objectId&&sourceDay(active.startDate,active.startedAt)===day){
      const ids=Object.entries(state.truckStatus||{}).filter(([,s])=>s?.onLine===true&&(!s.shiftId||s.shiftId===active.id)).map(([id])=>id);
      add(ids,(state.logs||[]).filter(l=>!l.shiftId||l.shiftId===active.id));
    }
    for(const archive of state.archive||[])if(archive.objectId===objectId&&sourceDay(archive.date,archive.startedAt)===day)add(archive.activeLineIds,archive.logs,archive.lineTrucks);
    return [...result.values()];
  }
  const routeTypes={stockpile:'В конус',plant:'На завод',object:'На другой объект'};
  const settingsId=objectId=>'object_'+encodeURIComponent(objectId);
  function materialRoute(value,sourceObjectId){
    const material=text(value.material,'Материал'),destinationType=value.destinationType;
    if(!Object.hasOwn(routeTypes,destinationType))fail('Выберите направление материала');
    const targetObjectId=destinationType==='object'?text(value.targetObjectId,'Объект назначения'):'';
    if(targetObjectId===sourceObjectId)fail('Выберите другой объект назначения');
    const targetObjectName=destinationType==='object'?text(value.targetObjectName,'Название объекта назначения'):'';
    const destinationName=destinationType==='object'?targetObjectName:text(value.destinationName,destinationType==='plant'?'Завод':'Конус');
    return {material,destinationType,destinationName,targetObjectId,targetObjectName};
  }
  function regularVolume(logs){return Math.round((logs||[]).reduce((sum,l)=>sum+(!l.isGAI&&Number.isFinite(Number(l.volume))&&Number(l.volume)>0?Number(l.volume):0),0)*1000)/1000;}
  function materialsFromArchives(archives){
    const unique=new Map();for(const a of archives||[]){if(!a.materialRoute||!a.objectId||!a.id)continue;const key=a.materialSourceId||a.id,old=unique.get(key);if(!old||Number(a.closedAt)>Number(old.closedAt))unique.set(key,a);}
    const result=[];
    for(const [sourceId,a]of unique){try{
      const route=materialRoute(a.materialRoute,a.objectId),quantity=regularVolume(a.logs),day=date(sourceDay(a.date,a.startedAt)),shift=a.timesheetShift==='night'?'night':'day';if(!quantity)continue;
      const direction=route.destinationType==='stockpile'?'production':route.destinationType==='plant'?'shipment':'transfer_out';
      const base={...route,material:route.material,quantity,unit:'м³',date:day,shift,document:'',note:'Из рейсов закрытой смены',deleted:false,auto:true,sourceArchiveId:a.id,sourceObjectId:a.objectId,sourceObjectName:a.objectName||a.objectId};
      result.push({...base,id:'auto_'+sourceId+'_out',objectId:a.objectId,objectName:a.objectName||a.objectId,scope:scope(a.objectId,day),direction,supplier:(route.destinationType==='stockpile'?'В конус: ':route.destinationType==='plant'?'На завод: ':'Передано: ')+route.destinationName});
      if(route.destinationType==='object')result.push({...base,id:'auto_'+sourceId+'_in',objectId:route.targetObjectId,objectName:route.targetObjectName,scope:scope(route.targetObjectId,day),direction:'transfer_in',supplier:'С объекта: '+(a.objectName||a.objectId)});
    }catch(_){/* Legacy archives without a valid route stay visible in the archive. */}}
    return result;
  }
  function validate(collection, data, id) {
    if (!collections.includes(collection)) fail('Неизвестный раздел');
    if (!data || typeof data !== 'object') fail('Пустая запись');
    text(id, 'Идентификатор', 1400); if (id.includes('/')) fail('Некорректный идентификатор');
    if (typeof data.deleted !== 'boolean') fail('Некорректное состояние записи');
    if (collection === 'timesheetPeople') {
      text(data.name,'ФИО');
      if (!['worker','itr','operator'].includes(data.group)) fail('Выберите группу');
      if(data.operatorRole!==undefined&&!Object.hasOwn(operatorRoles,data.operatorRole))fail('Выберите специализацию');
    } else if (collection === 'timesheetEquipment') {
      text(data.name,'Техника'); text(data.contractor,'Организация',160,true);
      if (!['own','hired'].includes(data.ownership)) fail('Выберите принадлежность техники');
      if(data.equipmentType!==undefined&&!Object.hasOwn(equipmentTypes,data.equipmentType))fail('Выберите вид техники');
      if(data.equipmentType!==undefined&&data.ownership==='hired'&&!String(data.contractor).trim())fail('Укажите фирму наёмной техники');
      if (!Array.isArray(data.crewIds) || data.crewIds.length > 20 || new Set(data.crewIds).size !== data.crewIds.length || data.crewIds.some(x=>typeof x!=='string'||!x||x.includes('/'))) fail('Проверьте состав экипажа');
    } else if (collection === 'timesheetSettings') {
      text(data.objectId,'Объект');if(id!==settingsId(data.objectId))fail('Некорректный ключ настроек');materialRoute(data,data.objectId);
    } else {
      text(data.objectId,'Объект'); text(data.objectName,'Название объекта'); date(data.date);
      if (!['day','night'].includes(data.shift)) fail('Выберите смену');
      if (data.scope !== scope(data.objectId,data.date)) fail('Некорректный период');
      if(collection==='timesheetShifts'){
        if(id!==shiftId(data.objectId,data.date,data.shift))fail('Некорректный ключ смены');duration(data.startTime,data.endTime);
      } else if (collection === 'timesheetEntries') {
        if (!['person','equipment'].includes(data.kind)) fail('Некорректный вид записи');
        text(data.entityId,'Сотрудник или техника'); text(data.name,'Имя'); text(data.equipmentId,'Машина',160,true);
        if (entryId(data.kind,data.objectId,data.date,data.shift,data.entityId)!==id) fail('Некорректный ключ табеля');
        if (!['unfilled','work','off','absent'].includes(data.status)) fail('Выберите отметку');
        for (const k of ['minutes','idleMinutes']) if (data[k] !== null && (!Number.isInteger(data[k]) || data[k]<0 || data[k]>1440)) fail('Часы вне диапазона');
        if (data.status==='unfilled' && data.minutes !== null) fail('Незаполненная строка не содержит часов');
        if (data.status==='work' && data.minutes === null) fail('Укажите часы');
        if (['off','absent'].includes(data.status) && data.minutes !== 0) fail('Для отсутствия часы равны нулю');
        if (data.kind==='person' && data.idleMinutes !== 0) fail('Простой указывается у техники');
        if (data.kind==='equipment' && (data.minutes||0)+(data.idleMinutes||0)>1440) fail('Работа и простой вместе не больше 24 часов');
        text(data.note,'Комментарий',500,true);
        if(data.equipmentType!==undefined&&!Object.hasOwn(equipmentTypes,data.equipmentType))fail('Некорректный вид техники');
        if(data.operatorRole!==undefined&&!Object.hasOwn(operatorRoles,data.operatorRole))fail('Некорректная специализация');
        if(data.personId!==undefined)text(data.personId,'Сотрудник',160,true);
        if(data.crewSlot!==undefined&&(!Number.isInteger(data.crewSlot)||data.crewSlot<0||data.crewSlot>19))fail('Некорректное место экипажа');
        if(data.crewCount!==undefined&&(!Number.isInteger(data.crewCount)||data.crewCount<defaultCrewCount({...data,crewCount:0})||data.crewCount>20))fail('Проверьте численность экипажа');
      } else {
        text(data.material,'Материал'); text(data.supplier,'Поставщик'); text(data.document,'Накладная',160,true);
        if (!units.includes(data.unit)) fail('Выберите единицу измерения');
        if (typeof data.quantity!=='number' || !Number.isFinite(data.quantity) || data.quantity<=0 || data.quantity>100000000) fail('Некорректное количество');
        text(data.note,'Комментарий',500,true);
      }
    }
    return data;
  }
  function validateOperation(op) {
    text(op.id,'Операция'); text(op.uid,'Пользователь');
    if (!Array.isArray(op.changes) || !op.changes.length || op.changes.length>4) fail('За одно сохранение можно изменить до 4 строк');
    const seen = new Set();
    for (const ch of op.changes) {
      const k=ch.collection+'/'+ch.id; if (seen.has(k)) fail('Строка повторяется в операции'); seen.add(k);
      if (!Number.isInteger(ch.baseRevision)||ch.baseRevision<0) fail('Некорректная версия');
      validate(ch.collection,ch.data,ch.id);
    }
    return op;
  }
  function project(remote, jobs, collection) {
    const map = new Map(remote.map(d=>[d.id,clone(d)]));
    for (const op of jobs.filter(x=>x.status==='queued').sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id))) {
      for (const ch of op.changes.filter(x=>x.collection===collection)) {
        const old=map.get(ch.id);
        // A listener may acknowledge the server write before the local receipt is removed.
        if (old && (old.lastOpId===op.id || (old.revision||0)>ch.baseRevision)) continue;
        map.set(ch.id,{...clone(ch.data),id:ch.id,revision:ch.baseRevision+1,lastOpId:op.id,pending:true});
      }
    }
    return [...map.values()];
  }
  async function commitOperation(db, ws, op, actor, runTransaction) {
    validateOperation(op);
    if (actor.uid !== op.uid) fail('Операция принадлежит другой учётной записи','wrong-account');
    const receipt=ws.collection('timesheetChanges').doc(op.id);
    return runTransaction(async tx=>{
      const ack=await tx.get(receipt); if (ack.exists) return {duplicate:true};
      const refs=op.changes.map(ch=>ws.collection(ch.collection).doc(ch.id));
      const snapshots=[]; for (const ref of refs) snapshots.push(await tx.get(ref));
      const conflicts=[];
      snapshots.forEach((snap,i)=>{
        const before=snap.exists?snap.data():null, ch=op.changes[i];
        if ((before?.revision||0)!==ch.baseRevision) conflicts.push({collection:ch.collection,id:ch.id,before:ch.before||null,server:before,proposed:ch.data});
        if(before&&ch.collection==='timesheetSettings'&&before.objectId!==ch.data.objectId)fail('Нельзя перенести настройки на другой объект');
        if(before&&ch.collection==='timesheetShifts')for(const k of ['objectId','date','shift'])if(before[k]!==ch.data[k])fail('Нельзя перенести время смены');
        if (before && ch.collection==='timesheetEntries') for(const k of ['objectId','date','shift','entityId','kind']) if(before[k]!==ch.data[k]) fail('Нельзя перенести существующую запись в другой период');
      });
      if (conflicts.length) {const e=new Error('Эти строки уже изменены другим пользователем');e.code='conflict';e.conflicts=snapshots.map((snap,i)=>({collection:op.changes[i].collection,id:op.changes[i].id,before:op.changes[i].before||null,server:snap.exists?snap.data():null,proposed:op.changes[i].data}));throw e;}
      const changes=snapshots.map((snap,i)=>{
        const ch=op.changes[i], before=snap.exists?snap.data():null;
        const after={...clone(ch.data),revision:ch.baseRevision+1,lastOpId:op.id,updatedBy:actor.uid,updatedName:actor.name,updatedAt:op.createdAt};
        tx.set(refs[i],after); return {collection:ch.collection,id:ch.id,before,after};
      });
      tx.set(receipt,{uid:actor.uid,name:actor.name,scope:op.scope||'catalog',createdAt:op.createdAt,committedAt:actor.serverTimestamp ? actor.serverTimestamp() : Date.now(),label:op.label,changes});
      return {duplicate:false,changes};
    }).catch(async error=>{
      // Rules can reject a losing concurrent commit before the SDK retries it.
      // Re-read only to explain the conflict; never weaken permissions or resend blindly.
      if (error.code !== 'permission-denied') throw error;
      let snapshots;
      try {
        const receiptSnapshot=await receipt.get({source:'server'});
        if(receiptSnapshot.exists && receiptSnapshot.data().uid===actor.uid)return {duplicate:true};
        snapshots=await Promise.all(op.changes.map(ch=>ws.collection(ch.collection).doc(ch.id).get({source:'server'})));
      } catch (_) { throw error; }
      if(snapshots.some((snap,i)=>(snap.exists?snap.data().revision||0:0)!==op.changes[i].baseRevision)) {
        const conflict=new Error('Эти строки уже изменены другим пользователем');conflict.code='conflict';
        conflict.conflicts=snapshots.map((snap,i)=>({collection:op.changes[i].collection,id:op.changes[i].id,before:op.changes[i].before||null,server:snap.exists?snap.data():null,proposed:op.changes[i].data}));throw conflict;
      }
      throw error;
    });
  }
  function csv(rows) {
    return '\ufeff'+rows.map(row=>row.map(v=>{
      let s=String(v==null?'':v); if (/^[\s]*[=+\-@\t\r]/.test(s)) s="'"+s;
      return '"'+s.replace(/"/g,'""')+'"';
    }).join(';')).join('\r\n');
  }
  return {collections,units,clone,text,date,hours,quantity,fmt,scope,entryId,operatorRoles,equipmentTypes,equipmentType,equipmentStyle,defaultCrewCount,personIdentity,shiftId,clock,duration,moveDate,slotEntry,effectiveEntries,lineTrucks,sourceDay,routeTypes,settingsId,materialRoute,regularVolume,materialsFromArchives,validate,validateOperation,project,commitOperation,csv};
});
