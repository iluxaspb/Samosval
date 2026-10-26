
/* Test-site field ledger. Pure validation and transaction engine; no production writes. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TimesheetCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const collections = ['timesheetPeople', 'timesheetEquipment', 'timesheetEntries', 'timesheetMaterials'];
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
    if (collection === 'timesheetPeople') {
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
      const ack=await tx.get(receipt); if (ack.exists) return {duplicate:true};
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
  return {collections,units,clone,text,date,hours,quantity,fmt,scope,entryId,validate,validateOperation,project,commitOperation,csv};
});

