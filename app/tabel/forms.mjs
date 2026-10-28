import * as D from './domain.mjs';
import {esc,button,field,input,formDialog,showError} from './ui.mjs';
export function installForms(api){
  const requireRight=(area,mode='edit')=>{const c=api.context();if(!api.can(c.object.id,area,mode))throw Error('Нет права: '+area+'.'+mode);};
  const change=(col,id,data,before)=>({collection:col,id,data,baseRevision:before?.revision||0,before:before?api.clean(before):null});
  const find=(col,id)=>api.peek(col,api.context().object.id).find(x=>x.id===id);
  const refresh=el=>el.addEventListener('close',()=>api.refresh(),{once:true});
  api.entry=id=>{
    const r=find('timesheetEntries',id);if(!r)return;const area=r.kind==='person'?'people':'equipment',editable=api.can(r.objectId,area,'edit')&&api.can(r.objectId,'shift','edit');
    const machines=api.peek('timesheetEntries',r.objectId).filter(x=>!x.deleted&&x.kind==='equipment'&&x.date===r.date&&x.shift===r.shift);
    const el=formDialog(r.name,`<p>${D.displayDate(r.date)} · ${r.shift==='day'?'День':'Ночь'}</p>${field('Отметка',`<select name="status">${Object.entries({unfilled:'Не заполнено',work:'Работал',off:'Выходной',absent:'Отсутствовал'}).map(([key,title])=>`<option value="${key}" ${key===r.status?'selected':''}>${title}</option>`).join('')}</select>`)}${field('Часы',input('hours',r.minutes==null?'':D.fmt(r.minutes/60),'inputmode="decimal"'))}${r.kind==='equipment'?field('Простой',input('idle',D.fmt((r.idleMinutes||0)/60),'inputmode="decimal"')):r.group==='operator'?field('Техника этой смены',`<select name="machine"><option value="">Без назначения</option>${machines.map(m=>`<option value="${esc(m.entityId)}" ${m.entityId===r.equipmentId?'selected':''}>${esc(m.name)}</option>`).join('')}</select>`):''}${field('Комментарий',input('note',r.note||'','maxlength="500"'))}${r.kind==='equipment'&&r.ownership!=='hired'?button('Состав и часы экипажа','crew'):''}`,editable?async f=>{
      requireRight('shift');requireRight(area);let status=f.get('status'),minutes=D.hours(f.get('hours'));if(status==='unfilled'&&minutes!==null)status='work';if(['off','absent'].includes(status))minutes=0;if(status==='work'&&minutes===null)throw Error('Укажите часы');
      const data={...api.clean(r),status,minutes:status==='unfilled'?null:minutes,idleMinutes:r.kind==='equipment'?(D.hours(f.get('idle'))??0):0,note:String(f.get('note')||'').trim(),equipmentId:r.kind==='person'&&r.group==='operator'?String(f.get('machine')||''):r.equipmentId};
      await api.save([change('timesheetEntries',id,data,r)],'Часы: '+r.name);
    }:null);
    if(!editable)el.querySelectorAll('input,select').forEach(x=>x.disabled=true);
    el.querySelector('[data-t=crew]')?.addEventListener('click',()=>{el.close();api.crew(id);});refresh(el);return el;
  };
  api.crew=id=>{
    const machine=find('timesheetEntries',id);if(!machine||machine.ownership==='hired')return;
    const rows=api.peek('timesheetEntries',machine.objectId).filter(x=>!x.deleted&&x.date===machine.date&&x.shift===machine.shift),crew=rows.filter(x=>x.kind==='person'&&x.group==='operator'&&x.equipmentId===machine.entityId),editable=api.can(machine.objectId,'people','edit');
    const config=api.peek('timesheetObjects',machine.objectId).find(x=>!x.deleted),roster=api.catalog('timesheetPeople').filter(x=>x.group==='operator'&&(!Array.isArray(config?.operatorSkills?.[x.id])||config.operatorSkills[x.id].includes(machine.entityId)));
    const el=formDialog('Экипаж: '+machine.name,`<p>${D.displayDate(machine.date)}. Убранные из экипажа сотрудники сохраняют свои часы в смене.</p>${crew.map(r=>`<div class="tb-list-row"><strong>${esc(r.name)}</strong><span>${r.minutes==null?'—':D.fmt(r.minutes/60)+' ч'}</span>${button('Часы','person',`data-id="${esc(r.id)}"`)}</div>`).join('')}<h3>Назначение на эту смену</h3>${roster.map(p=>`<label class="tb-check"><input type="checkbox" name="crew" value="${esc(p.id)}" ${crew.some(x=>x.entityId===p.id)?'checked':''}>${esc(p.name)}</label>`).join('')}`,editable?async f=>{
      requireRight('people');requireRight('shift');const selected=new Set(f.getAll('crew')),changes=[];
      for(const p of roster){const key=D.entryId('person',machine.objectId,machine.date,machine.shift,p.id),old=rows.find(x=>x.id===key);if(selected.has(p.id)){if(old?.equipmentId&&old.equipmentId!==machine.entityId)throw Error(p.name+' уже назначен на другую технику');if(!old||old.deleted)changes.push(change('timesheetEntries',key,D.blankEntry('person',p,{id:machine.objectId,name:machine.objectName},machine.date,machine.shift,machine.entityId),old));else if(old.equipmentId!==machine.entityId)changes.push(change('timesheetEntries',key,{...api.clean(old),equipmentId:machine.entityId},old));}else if(old?.equipmentId===machine.entityId)changes.push(change('timesheetEntries',key,{...api.clean(old),equipmentId:''},old));}
      await api.save(changes,'Экипаж: '+machine.name);
    }:null);
    el.querySelectorAll('[data-t=person]').forEach(b=>b.onclick=()=>{el.close();api.entry(b.dataset.id);});if(!editable)el.querySelectorAll('input').forEach(x=>x.disabled=true);refresh(el);return el;
  };
  api.material=id=>{
    const r=find('timesheetMaterials',id);if(!r)return;
    const editable=api.can(r.objectId,'materials','edit'),el=formDialog('Поступление: '+r.material,field('Материал',input('material',r.material,'required'))+field('Поставщик',input('supplier',r.supplier,'required'))+field('Количество',input('quantity',r.quantity,'inputmode="decimal"'))+field('Единица',input('unit',r.unit,'required'))+field('Накладная',input('document',r.document||''))+field('Комментарий',input('note',r.note||'')),editable?async f=>{requireRight('materials');await api.save([change('timesheetMaterials',id,{...api.clean(r),material:String(f.get('material')).trim(),supplier:String(f.get('supplier')).trim(),quantity:D.number(f.get('quantity')),unit:String(f.get('unit')),document:String(f.get('document')),note:String(f.get('note'))},r)],'Поступление: '+r.material);}:null);if(!editable)el.querySelectorAll('input').forEach(x=>x.disabled=true);refresh(el);return el;
  };
  api.resolve=id=>{
    const op=api.queue().find(x=>x.id===id);if(!op)return;
    const el=formDialog('Разбор изменений',`<p>${esc(op.label)} · ${esc(op.error||'')}</p>${(op.conflicts||[]).map(c=>`<section class="tb-card"><p><b>Где:</b> ${esc(c.collection)} / ${esc(c.id)} · ${esc(c.proposed?.date||'')}</p><p><b>Кто / когда в базе:</b> ${esc(c.server?.updatedName||c.server?.updatedBy||'не записано')} · ${c.server?.updatedAt?esc(new Date(c.server.updatedAt).toLocaleString('ru-RU')):'не записано'}</p><p>Применение вашей версии заменит показанные значения базы и изменит связанные часы, таблицу и отчёт. Закрытие окна сохраняет обе версии для дальнейшего разбора.</p><details><summary>Полные версии до / база / ваша правка</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(c,null,2))}</pre></details></section>`).join('')}<div class="tb-tools">${button('Оставить существующее','server')}${button('Применить моё изменение','local')}</div>`);
    el.querySelectorAll('[data-t=server],[data-t=local]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api.resolveOperation(id,b.dataset.t);el.close();}catch(e){showError(el,e);b.disabled=false;}});refresh(el);return el;
  };
  api.history=async()=>{
    requireRight('history','view');const el=formDialog('История табеля','<div data-history>Загружаем…</div>');
    try{const history=await api.historyRows();if(!el.isConnected)return;el.querySelector('[data-history]').innerHTML=history.sort((a,b)=>b.createdAt-a.createdAt).slice(0,100).map(r=>`<details class="tb-card"><summary>${esc(r.label)} · ${esc(r.name)} · ${esc(new Date(r.createdAt).toLocaleString('ru-RU'))}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(r.changes,null,2))}</pre></details>`).join('')||'<p>Изменений пока нет.</p>';}catch(e){showError(el,e);}return el;
  };
  return api;
}
