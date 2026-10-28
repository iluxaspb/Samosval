import * as D from './table-domain.mjs';
import {lineCalendarDate} from './domain.mjs';
import {Store,firestoreRemote} from './store.mjs';
import {migrate,normalizedObject} from './migration.mjs';
import {dialog,field,input} from './messages.mjs';

export function sourcePeriod(shift) {
  const date=lineCalendarDate(shift.startDate);
  let kind=shift.workShift || shift.kind;
  if(!['day','night'].includes(kind)) {
    if(!Number.isFinite(Number(shift.startedAt)) || !Number(shift.startedAt)) throw Error('Не определена дневная/ночная смена Линии');
    const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',hour:'2-digit',hourCycle:'h23'}).format(new Date(Number(shift.startedAt))));
    kind=hour>=8 && hour<20 ? 'day' : 'night';
  }
  return {date,shift:kind};
}
export function materialRecord(c,name,direction) {
  const found=c.materials.find(m=>m.name===name && m.direction===direction);
  return found || {id:D.uid(),name,direction,unit:'м³',section:'granulate'};
}
export function applyVolume(day,source,material,volume) {
  volume=D.numeric(volume);
  if(volume==null || volume<0) throw Error('Некорректный объём материала');
  const next=D.copy(day);
  next.lineImports ||= {};
  const previous=next.lineImports[source];
  if(previous) {
    if(previous.materialId!==material.id || previous.volume!==volume) throw Error('Эта смена уже перенесена с другими значениями. Проверьте историю табеля.');
    return next;
  }
  const old=next.values[material.id] || {};
  next.values[material.id]={...old,quantity:Math.round(((old.quantity || 0)+volume)*1000)/1000,direction:material.direction};
  next.lineImports[source]={materialId:material.id,volume};
  return next;
}
async function askMaterial(name,direction,period) {
  if(!document.querySelector('[data-tabel-v2-css]')) {
    const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./workspace.css',import.meta.url);link.dataset.tabelV2Css='';document.head.append(link);
  }
  return new Promise((resolve,reject)=>{
    let saved=false;
    const el=dialog('Материал с Линии',`<p>${D.display(period.date)} · ${period.shift==='night'?'Ночная':'Дневная'} смена</p>`+field('Материал',input('material',name,'required maxlength="180"'))+field('Куда направляем',input('direction',direction,'required maxlength="180"')),async f=>{
      const material=String(f.get('material')).trim(),direction=String(f.get('direction')).trim();
      if(!material || !direction) throw Error('Укажите материал и направление');
      saved=true;resolve({material,direction});
    });
    el.addEventListener('close',()=>{if(!saved)reject(Error('Перенос материала отменён. Закрытие смены можно повторить.'));},{once:true});
  });
}
// Called after durable Line archive creation and before deleting the source trips.
// The source shift ID is the import key, so retrying a partial close never doubles volume.
export async function transferClosedLine(host,shift,archive) {
  if(!archive || !archive.totalTrips) return;
  const initial=host.session();
  const guard=()=>{
    const a=host.session();
    if(a.projectId!=='samosval-offline' || !a.uid || a.uid!==initial.uid || !a.active || !a.edit) throw Error('Нет права переносить материалы в Табель 2');
    return a;
  };
  guard();
  const object=(host.objects || []).find(o=>o.id===shift.objectId);
  if(!object) throw Error('Не найден объект смены для переноса материала');
  const period=sourcePeriod(shift);
  let remote=null;
  if(host.transaction) {
    const policy=await host.workspace.collection('tabelNextMeta').doc('config').get();
    if(policy.exists && policy.data().enabled===true && policy.data().schema===1)
      remote=firestoreRemote(host,guard);
  }
  const store=await new Store(initial.projectId+'_'+initial.workspaceId+'_'+initial.uid,remote,()=>({uid:guard().uid,name:guard().name})).open();
  const confirm=async()=>{
    if(!remote)return;
    await store.flush();
    if(store.error || store.state.jobs.length)throw Error('Материал пока не подтверждён сервером: '+(store.error || 'есть очередь или конфликт')+'. Исходные рейсы сохранены.');
  };
  try {
    await store.prepareSync();
    await store.pullObject(object.id);
    await migrate(host,store,normalizedObject(object),{equipment:[],people:[]});
    await store.prepareSync();
    const configKey=object.id+'/config',base=store.get(configKey),c=base.data || D.config(normalizedObject(object));
    const dayKey=object.id+'/'+D.dayKey(period.date,period.shift);
    const existing=store.get(dayKey).data?.lineImports?.[shift.id];
    if(existing) {
      if(existing.volume!==Number(archive.totalVolume)) throw Error('Перенесённый объём отличается от архива');
      await confirm();
      return;
    }
    let material=String(c.currentMaterial || '').trim();
    let direction=String(c.lineDestination || (c.destinations?.length===1 ? c.destinations[0] : '')).trim();
    if(!material || !direction) ({material,direction}=await askMaterial(material,direction,period));
    guard();
    c.currentMaterial=material;c.lineDestination=direction;
    if(!c.destinations?.includes(direction)) c.destinations=[...(c.destinations || []),direction];
    const row=materialRecord(c,material,direction);
    if(!c.materials.some(m=>m.id===row.id)) c.materials.push(row);
    if(c.start>period.date)c.start=period.date;
    if(c.end && c.end<period.date)c.end=period.date;
    if(!await store.save(configKey,c,base,'Материал и направление с Линии')) throw Error('Конфликт настроек объекта; повторите закрытие');
    const before=store.get(dayKey),day=before.data || D.createDay(c,period.date,period.shift);
    const next=applyVolume(day,shift.id,row,archive.totalVolume);
    guard();
    if(!await store.save(dayKey,next,before,'Материал с Линии: '+material+' → '+direction)) throw Error('Конфликт переноса материала; обе версии сохранены');
    await confirm();
  } finally {await store.close();}
}
