import * as D from './table-domain.mjs';
import {esc,btn,input,field,dialog,error} from './messages.mjs';
const tabs=[['equipment','Техника'],['worker','Рабочие'],['itr','ИТР'],['values','Материалы и объёмы работ']];
export async function mount(s,root){
 const c=s.config(),key=s.key(D.dayKey(s.day,s.shift)),base=s.store.get(key),d=base.data;
 root.innerHTML=`<div class="tn-date-nav">${btn('‹','prev-date','aria-label="Предыдущая дата"')}<input type="date" data-day value="${s.day}" aria-label="Дата смены"><select data-shift aria-label="Смена"><option value="day">Дневная</option><option value="night" ${s.shift==='night'?'selected':''}>Ночная</option></select>${btn('›','next-date','aria-label="Следующая дата"')}</div><div class="tn-tools">${btn('Начать / добавить смену','add-day')}${d?btn('Выбрать состав','choose-roster'):''}</div><section data-shift-content></section><div class="tn-shift-tabs" role="tablist">${tabs.map(([id,label])=>btn(label,'shift-tab',`data-tab="${id}" role="tab" aria-selected="${s.shiftTab===id}"`)).join('')}</div>`;
 const navigate=async(date,shift=s.shift)=>{s.day=D.date(date);s.shift=shift;await s.refresh();};
 root.querySelector('[data-day]').onchange=e=>navigate(e.target.value).catch(error);
 root.querySelector('[data-shift]').onchange=e=>navigate(s.day,e.target.value).catch(error);
 root.querySelector('[data-action=prev-date]').onclick=()=>navigate(D.add(s.day,-1)).catch(error);
 root.querySelector('[data-action=next-date]').onclick=()=>navigate(D.add(s.day,1)).catch(error);
 root.querySelector('[data-action=add-day]').onclick=()=>s.addDay().catch(error);
 root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{s.shiftTab=b.dataset.tab;s.refresh().catch(error);});
 root.querySelector('[data-action=choose-roster]')?.addEventListener('click',()=>choose(s).catch(error));
 const content=root.querySelector('[data-shift-content]');
 if(!d){content.innerHTML='<p>Смена пока не создана. Нажмите «Начать / добавить смену».</p>';return;}
 if(s.shiftTab==='values'){
  content.innerHTML=`<form data-values>${[['materials','Материалы'],['works','Объёмы работ']].map(([kind,label])=>`<h3>${label}</h3>${c[kind].map(x=>field(x.name+' · '+x.unit,input('value:'+x.id,D.fmt(d.values[x.id]?.quantity),'inputmode="decimal"'))+(kind==='materials'?field('Направление',input('direction:'+x.id,d.values[x.id]?.direction??x.direction)):'' )).join('')}`).join('')}<button type="submit">Сохранить</button></form>`;
  content.querySelector('form').onsubmit=async e=>{e.preventDefault();try{const next=D.copy(d);for(const [name,raw] of new FormData(e.target)){const [kind,id]=name.split(':');if(kind==='value')D.setValue({kind:'value',entity:id},next,raw);else next.values[id]={...next.values[id],direction:String(raw)};}await s.save(key,next,base,'Материалы и объёмы работ');await s.refresh();}catch(e){error(e);}};return;
 }
 const equipment=s.shiftTab==='equipment';
 const list=equipment?[...d.equipment].sort((a,b)=>D.equipmentOrder(a)-D.equipmentOrder(b)):d.people.filter(p=>p.group===s.shiftTab);
 content.innerHTML=`<div class="tn-cards">${list.map(e=>`<article class="tn-equipment-card" data-card="${esc(e.id)}"><button class="tn-card-title" type="button" data-open="${esc(e.id)}">${esc(e.name)}${equipment?'<small>Последние 5 дней ›</small>':''}</button><div class="tn-card-hours">${(equipment?equipmentFields(e):[['hours','Часы за смену']]).map(([field,label])=>`<label>${esc(label)}${btn(D.fmt(e[field])||'—','hours',`data-entity="${esc(e.id)}" data-field="${field}" aria-label="${esc(e.name+' · '+label)}"`)}</label>`).join('')}</div></article>`).join('')||'<p>Состав не выбран.</p>'}</div>`;
 content.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{if(equipment)multi(s,b.dataset.open).catch(error);else quick(s,'people',b.dataset.open,'hours').catch(error);});
 content.querySelectorAll('[data-entity]').forEach(b=>b.onclick=()=>quick(s,equipment?'equipment':'people',b.dataset.entity,b.dataset.field).catch(error));
}
function equipmentFields(e){return [['hours','Техника'],...(e.ownership==='hired'?[]:[['crewHours',D.crewLabel(e)],...(D.isWater(e)&&e.pump?[['pumpHours','Помпа']]:[])])];}
export async function quick(s,kind,id,field){
 const key=s.key(D.dayKey(s.day,s.shift)),base=s.store.get(key),entry=base.data?.[kind].find(e=>e.id===id);if(!entry)throw Error('Нет в составе смены');
 let value=D.fmt(entry[field]),replace=true;
 const el=dialog(entry.name+' · '+D.display(s.day),`<output data-hours-value>${esc(value||'0')}</output><div class="tn-quick-hours">${[10,11,12,13,14].map(n=>btn(n,'preset',`data-value="${n}" ${n===12?'class="tn-twelve"':''}`)).join('')}</div><div class="tn-numberpad">${['7','8','9','4','5','6','1','2','3',',','0','⌫'].map(x=>btn(x,'digit',`data-digit="${x}"`)).join('')}</div>${btn('Очистить','clear-hours')}`,async()=>{const next=D.copy(base.data);D.setValue({kind,entity:id,field},next,value);await s.save(key,next,base,'Часы смены');await s.refresh();});
 el.classList.add('tn-hours-dialog');const update=()=>el.querySelector('[data-hours-value]').textContent=value||'0';
 el.querySelectorAll('[data-value]').forEach(b=>b.onclick=()=>{value=b.dataset.value;replace=true;update();});
 el.querySelectorAll('[data-digit]').forEach(b=>b.onclick=()=>{const x=b.dataset.digit;if(x==='⌫')value=value.slice(0,-1);else{if(replace)value='';if(x!==','||!/[.,]/.test(value))value+=x;}replace=false;update();});
 el.querySelector('[data-action=clear-hours]').onclick=()=>{value='';replace=false;update();};
}
async function choose(s){
 const c=s.config(),key=s.key(D.dayKey(s.day,s.shift)),base=s.store.get(key),d=base.data;if(!d)throw Error('Сначала начните смену');
 const equipment=s.shiftTab==='equipment',group=s.shiftTab==='itr'?'itr':'worker',kind=equipment?'equipment':'people',list=equipment?c.equipment:c.people.filter(p=>p.group===group),selected=new Set(d[kind].map(x=>x.id));
 const el=dialog('Состав: '+(equipment?'техника':group==='itr'?'ИТР':'рабочие'),'<input data-search placeholder="Поиск в базе">'+list.map(e=>`<label class="tn-check"><input type="checkbox" data-choice="${esc(e.id)}" ${selected.has(e.id)?'checked':''}>${esc(e.name)}</label>`).join(''),async()=>{const next=D.copy(d),chosen=list.filter(e=>selected.has(e.id)).map(e=>({...e,hours:e.group==='itr'&&s.day<=D.today()?12:null,crewHours:null,pumpHours:null,...d[kind].find(x=>x.id===e.id)}));next[kind]=equipment?chosen:[...d.people.filter(p=>p.group!==group),...chosen];await s.save(key,next,base,'Состав '+group);await s.refresh();});
 el.querySelector('[data-search]').oninput=e=>el.querySelectorAll('.tn-check').forEach(x=>x.hidden=!x.textContent.toLowerCase().includes(e.target.value.toLowerCase()));
 el.querySelectorAll('[data-choice]').forEach(i=>i.onchange=()=>i.checked?selected.add(i.dataset.choice):selected.delete(i.dataset.choice));
}
export async function multi(s,id){
 const c=s.config(),end=s.day,start=D.add(end,-4),dates=D.days(start,end),machine=c.equipment.find(e=>e.id===id)||s.days().flatMap(d=>d.equipment).find(e=>e.id===id);if(!machine)throw Error('Техника не найдена');
 const snapshots=dates.map(date=>({date,key:s.key(D.dayKey(date,s.shift)),...s.store.get(s.key(D.dayKey(date,s.shift)))})),fields=equipmentFields(machine),draftKey=s.key('draft:multi:'+id+':'+s.shift),draft=s.store.get(draftKey).data;
 let active=null,saving=Promise.resolve();
 const el=dialog(machine.name,`<table class="tn-five-days"><thead><tr><th></th>${dates.map(date=>`<th>${D.display(date).slice(0,5)}</th>`).join('')}</tr></thead><tbody>${fields.map(([field,label])=>`<tr><th>${esc(label)}</th>${snapshots.map(r=>{const e=r.data?.equipment.find(x=>x.id===id),name=r.key+'|'+field,enabled=r.date>=c.start&&(!c.end||r.date<=c.end)&&r.date<=D.today();return `<td><input readonly inputmode="none" name="${esc(name)}" value="${esc(draft?.values?.[name]??D.fmt(e?.[field]))}" aria-label="${esc(label+' '+r.date)}" ${enabled?'':'disabled'}></td>`;}).join('')}</tr>`).join('')}</tbody></table><div class="tn-hour-row">${Array.from({length:14},(_,i)=>btn(i+1,'hour',`data-hour="${i+1}"`)).join('')}</div>${btn('Очистить ячейку','clear-cell')}<p class="tn-hint">Выберите ячейку, затем часы.</p>`,async()=>{
  await saving;const f=new FormData(el.querySelector('form'));
  // Build and validate all days before saving any of them.
  const updates=[];
  for(const r of snapshots){const changes=fields.filter(([field])=>f.get(r.key+'|'+field)!==null&&String(f.get(r.key+'|'+field))!==D.fmt(r.data?.equipment.find(x=>x.id===id)?.[field]));if(!changes.length)continue;const before=draft?.snapshots?.[r.key]||r,next=before.data?D.copy(before.data):D.createDay(c,r.date,s.shift);if(!next.equipment.some(e=>e.id===id))next.equipment.push({...machine,hours:null,crewHours:null,pumpHours:null});for(const [field]of changes)D.setValue({kind:'equipment',entity:id,field},next,f.get(r.key+'|'+field));updates.push({r,before,next});}
  for(const {r,before,next}of updates)await s.save(r.key,next,before,'Часы техники за 5 дней');
  await s.store.serialize(async()=>{delete s.store.state.records[draftKey];await s.store.persist();});await s.refresh();
 });
 el.classList.add('tn-five-dialog');
 const cache=()=>{const values=Object.fromEntries(new FormData(el.querySelector('form')));saving=saving.then(()=>s.store.serialize(async()=>{s.store.state.records[draftKey]={revision:0,data:{values,snapshots:draft?.snapshots||Object.fromEntries(snapshots.map(r=>[r.key,r]))}};await s.store.persist();})).catch(error);};
 el.querySelectorAll('input:not(:disabled)').forEach(i=>{i.onpointerdown=e=>e.preventDefault();i.onclick=()=>{active=i;el.querySelectorAll('input').forEach(x=>x.classList.toggle('tn-active-cell',x===i));};});
 el.querySelectorAll('[data-hour]').forEach(b=>b.onclick=()=>{if(!active){error('Сначала выберите ячейку');return;}active.value=b.dataset.hour;cache();});
 el.querySelector('[data-action=clear-cell]').onclick=()=>{if(active){active.value='';cache();}};
}
