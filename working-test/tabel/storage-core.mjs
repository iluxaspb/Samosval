/* Preserved ledger validation and transaction engine, private ES module. */
const core=(function() {
  'use strict';
  const baseCollections = ['timesheetPeople', 'timesheetEquipment', 'timesheetEntries', 'timesheetMaterials'];
  const extensionCollections = ['timesheetObjects','timesheetSheets','timesheetDays','timesheetValues'];
  const collections = [...baseCollections,...extensionCollections];
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
  function validate(collection, data, id) {
    if (!collections.includes(collection)) fail('Неизвестный раздел');
    if (!data || typeof data !== 'object') fail('Пустая запись');
    text(id, 'Идентификатор', 1400); if (id.includes('/')) fail('Некорректный идентификатор');
    if (typeof data.deleted !== 'boolean') fail('Некорректное состояние записи');
    if (extensionCollections.includes(collection)) {
      text(data.objectId,'Объект',160);
      if(data.schemaVersion!==1)fail('Неизвестная версия схемы табеля');
      if(JSON.stringify(data).length>240000)fail('Запись слишком большая. Разделите лист.');
      if(collection==='timesheetObjects'){
        if(id!==encodeURIComponent(data.objectId))fail('Настройки принадлежат другому объекту');
        date(data.startDate);if(data.endDate){date(data.endDate);if(data.endDate<data.startDate)fail('Дата окончания раньше начала');}
        if(!['all','week'].includes(data.period)||!['blank','template','ask'].includes(data.newSheet)||data.volumeSource!=='manual'||!['roster','hours'].includes(data.countEquipment))fail('Некорректные настройки');
        if(!Array.isArray(data.works)||!Array.isArray(data.materials)||!Array.isArray(data.allowedSheetTypes)||!data.allowedSheetTypes.length||data.allowedSheetTypes.some(x=>!['blank','template'].includes(x)))fail('Проверьте виды работ, материалов и листов');
        for(const list of [data.works,data.materials]){if(list.length>100||new Set(list.map(x=>x.id)).size!==list.length)fail('Повторяются виды работ или материалов');for(const item of list){text(item.id,'Ключ');text(item.name,'Название');text(item.unit,'Единица');if(item.plan!==undefined&&(!Number.isFinite(item.plan)||item.plan<0))fail('Некорректный план');}}
        if(!data.request||!Array.isArray(data.request.equipment)||!Array.isArray(data.request.people)||!data.request.lunch)fail('Некорректная заявка');date(data.request.date);
        if(!data.acl||!data.acl.roles||!data.acl.users)fail('Проверьте права');
        for(const group of [data.acl.roles,data.acl.users])for(const grants of Object.values(group)){if(!grants||typeof grants!=='object'||Object.values(grants).some(x=>typeof x!=='boolean'))fail('Права должны быть логическими значениями');}
      }else if(collection==='timesheetSheets'){
        text(data.name,'Название листа',80);if(!['blank','template'].includes(data.type)||!Number.isInteger(data.rowCount)||data.rowCount<1||data.rowCount>1000||!Number.isInteger(data.colCount)||data.colCount<1||data.colCount>100||!data.cells||typeof data.cells!=='object'||Array.isArray(data.cells)||Object.keys(data.cells).length>5000)fail('Проверьте размер листа');
        for(const [key,cell] of Object.entries(data.cells)){if((!data.linked&&!/^[A-Z]+[1-9]\d*$/.test(key))||typeof cell.raw!=='string'||cell.raw.length>2000)fail('Некорректная ячейка');for(const k of ['background','color'])if(cell[k]&&!/^#[0-9a-f]{6}$/i.test(cell[k]))fail('Некорректный цвет');if(cell.align&&!['left','center','right'].includes(cell.align))fail('Некорректное выравнивание');}
      }else{
        date(data.date);if(!['day','night'].includes(data.shift)||data.scope!==scope(data.objectId,data.date))fail('Некорректный период');
        if(collection==='timesheetValues'){if(!['material','work'].includes(data.kind))fail('Неизвестный показатель');text(data.entityId,'Показатель');if(!Number.isFinite(data.quantity)||data.quantity<0||data.quantity>100000000)fail('Некорректный объём');text(data.unit,'Единица');text(data.direction||'','Направление',160,true);}
        else if(typeof data.started!=='boolean')fail('Некорректное состояние дня');
      }
    } else if (collection === 'timesheetPeople') {
      text(data.name,'ФИО');
      if (!['worker','itr','operator'].includes(data.group)) fail('Выберите группу');
    } else if (collection === 'timesheetEquipment') {
      text(data.name,'Техника'); text(data.contractor,'Организация',160,true);
      if (!['own','hired'].includes(data.ownership)) fail('Выберите принадлежность техники');
      if (!Array.isArray(data.crewIds) || data.crewIds.length > 20 || new Set(data.crewIds).size !== data.crewIds.length || data.crewIds.some(x=>typeof x!=='string'||!x||x.includes('/'))) fail('Проверьте состав экипажа');
    } else {
      text(data.objectId,'Объект'); text(data.objectName,'Название объекта'); date(data.date);
      if (!['day','night'].includes(data.shift)) fail('Выберите смену');
      if (data.scope !== scope(data.objectId,data.date)) fail('Некорректный период');
      if (collection === 'timesheetEntries') {
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
      const ack=await tx.get(receipt);
      if (ack.exists) {
        if (ack.data().uid !== actor.uid) fail('Идентификатор операции занят другой учётной записью','wrong-account');
        return {duplicate:true};
      }
      const refs=op.changes.map(ch=>ws.collection(ch.collection).doc(ch.id));
      const snapshots=[]; for (const ref of refs) snapshots.push(await tx.get(ref));
      const conflicts=[];
      snapshots.forEach((snap,i)=>{
        const before=snap.exists?snap.data():null, ch=op.changes[i];
        if ((before?.revision||0)!==ch.baseRevision) conflicts.push({collection:ch.collection,id:ch.id,before:ch.before||null,server:before,proposed:ch.data});
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
  return {collections,baseCollections,extensionCollections,units,clone,text,date,hours,quantity,fmt,scope,entryId,validate,validateOperation,project,commitOperation,csv};
})();
export default core;
