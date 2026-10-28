import * as D from './domain.mjs';
import {esc,button,field,input,showError,formDialog} from './ui.mjs';
let current=null;
export async function whenIdle(){await current?.api.idle?.();}
export function close(expectedApi){if(!current||(expectedApi&&current.api!==expectedApi))return;current.off?.();current.editor?.dispose();current.api.release();current.root.remove();current=null;document.querySelectorAll('dialog.tb').forEach(x=>x.close());}
export async function open(api,view='request',id){
  close();
  if(!document.querySelector('link[data-tabel-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./tabel.css',import.meta.url).href;link.dataset.tabelStyle='';document.head.append(link);}
  const ctx=api.context(),root=document.createElement('section');root.className='tb tb-app'+(api.container?' tb-embedded':'');root.setAttribute('aria-label','Табель объекта');
  root.innerHTML=`<header><b>${esc(ctx.object.name)}</b><span class="tb-test">${ctx.actor.role==='admin'?'Табель '+D.VERSION+' · ТЕСТ':'Тестовый табель'}</span>${button(api.container?'На линию':'Закрыть','exit')}</header><div class="tb-context">${field('Объект',`<select data-object>${(api.objects?api.objects():[ctx.object]).map(o=>`<option value="${esc(o.id)}" ${o.id===ctx.object.id?'selected':''}>${esc(o.name)}</option>`).join('')}</select>`)}${field('Дата',input('contextDate',ctx.date,'type="date" data-date'))}${field('Смена',`<select data-shift><option value="day" ${ctx.shift==='day'?'selected':''}>День</option><option value="night" ${ctx.shift==='night'?'selected':''}>Ночь</option></select>`)}</div><nav>${[['request','Заявка'],['shift','Смена'],['table','Таблица'],['settings','Настройки'],['catalog','Справочники'],['history','История']].map(([v,t])=>button(t,'view',`data-view="${v}"`)).join('')}</nav><p data-error role="alert"></p><div class="tb-content">Загружаем сохранённые данные…</div><div class="tb-status" role="status"></div>`;
  (api.container||document.body).append(root);
  const s=current={api,ctx,root,view,config:null,configRow:null,scopes:[],data:{},editing:false};
  s.check=()=>{if(current!==s||api.context().generation!==ctx.generation||api.context().object.id!==ctx.object.id)throw Error('Объект или учётная запись изменились. Откройте табель заново.');};
  s.can=(area,mode='view')=>D.can(api.context().actor,s.config,area,mode);
  s.require=(area,mode='view')=>{s.check();if(!s.can(area,mode))throw Error('Нет права: '+area+'.'+mode);};
  s.read=async(col,scope)=>{s.check();const r=await api.read(col,ctx.object.id,scope);s.check();if(r.error)root.querySelector('[data-error]').textContent='Данные '+col+': '+r.error+' Изменения будут сохранены локально; серверное подтверждение отсутствует.';return r;};
  s.rows=col=>api.peek(col,ctx.object.id,['timesheetObjects','timesheetSheets'].includes(col)?undefined:s.scopes);
  s.change=(col,id,data,before)=>({collection:col,id,data,baseRevision:before?.revision||0,before:before?api.clean(before):null});
  s.save=async(changes,label)=>{s.check();await api.save(changes,label);s.check();refreshStatus(s);};
  s.saveConfig=async(config,label='Настройки объекта',area='settings')=>{s.require(area,'edit');const before=api.peek('timesheetObjects',ctx.object.id).find(x=>x.id===encodeURIComponent(ctx.object.id));await s.save([s.change('timesheetObjects',encodeURIComponent(ctx.object.id),config,before)],label);s.config=D.clone(config);};
  s.loadPeriod=async(start,end)=>{s.check();const scopes=[...new Set(D.days(start,end).map(d=>encodeURIComponent(ctx.object.id)+'|'+d.slice(0,7)))];s.scopes=[...new Set([...s.scopes,...scopes])];for(let i=0;i<scopes.length;i+=2)await Promise.all(scopes.slice(i,i+2).flatMap(scope=>['timesheetEntries','timesheetMaterials','timesheetValues','timesheetDays'].map(col=>s.read(col,scope))));};
  s.range=()=>{const dates=[ctx.date,...s.rows('timesheetDays').filter(x=>x.started&&!x.deleted).map(x=>x.date),...s.rows('timesheetEntries').map(x=>x.date)].filter(d=>d<=D.isoToday());const end=s.config.endDate? (s.config.endDate<D.isoToday()?s.config.endDate:D.isoToday()):dates.sort().at(-1);return {start:s.config.startDate,end:end&&end>=s.config.startDate?end:s.config.startDate};};
  s.refresh=async()=>{
    s.check();const row=api.peek('timesheetObjects',ctx.object.id).find(x=>!x.deleted);if(row){s.configRow=row;s.config=api.clean(row);}
    refreshStatus(s);s.root.dataset.hints=String(s.config.showHints);
    if(!s.editing&&s.view==='table')s.editor?.refresh();
    if(!s.editing&&['shift','catalog'].includes(s.view)&&!document.querySelector('dialog.tb')&&!(root.contains(document.activeElement)&&document.activeElement.matches('input,select,textarea'))&&!s.refreshing){s.refreshing=true;try{await(await import('./'+(s.view==='catalog'?'catalog':'shift')+'.mjs')).mount(s,root.querySelector('.tb-content'));}finally{s.refreshing=false;}}
  };
  root.querySelector('[data-t=exit]').onclick=()=>{close();api.leave?.();};
  root.querySelectorAll('.tb-context select,.tb-context input').forEach(el=>el.onchange=async()=>{try{if(!api.select)return;await api.select(root.querySelector('[data-object]').value,root.querySelector('[data-date]').value,root.querySelector('[data-shift]').value);await open(api,s.view);}catch(e){showError(root,e);}});
  root.querySelectorAll('nav button').forEach(b=>b.disabled=true);
  root.querySelector('nav').onclick=e=>{const b=e.target.closest('[data-view]');if(b)renderView(s,b.dataset.view).catch(err=>showError(root,err));};
  if(!ctx.object.id){root.querySelector('.tb-content').textContent='Создайте объект в разделе «База», затем откройте Табель.';return root;}
  try{
    const config=await s.read('timesheetObjects');s.configRow=config.rows.find(x=>!x.deleted);
    const start=/^\d{4}-\d{2}-\d{2}$/.test(ctx.object.startDate||'')?ctx.object.startDate:ctx.date;
    s.config=s.configRow?api.clean(s.configRow):D.defaults(ctx.object.id,start);
    await s.loadPeriod(ctx.date,ctx.date);s.off=api.subscribe(()=>s.refresh().catch(err=>showError(root,err)));
    if(view==='multiday'){await renderView(s,'shift');await(await import('./shift.mjs')).multiDay(s,id);}else await renderView(s,view);
  }catch(e){if(current===s)showError(root,e);}
  refreshStatus(s);root.querySelectorAll('nav button').forEach(b=>b.disabled=!s.config);
  return root;
}
function refreshStatus(s){if(current!==s)return;const jobs=s.api.queue(),pending=jobs.filter(x=>x.status==='queued'),bad=jobs.filter(x=>x.status!=='queued');const el=s.root.querySelector('.tb-status');el.textContent=`${s.api.context().online?'Сеть доступна':'Офлайн'} · на устройстве: ${pending.length} · требуют разбора: ${bad.length}`;for(const job of bad){const b=document.createElement('button');b.textContent='Разобрать: '+job.label;b.onclick=()=>s.api.resolve(job.id);el.append(b);}}
export async function renderView(s,view){
  s.check();s.editor?.dispose();s.editor=null;s.view=view;s.editing=false;
  const content=s.root.querySelector('.tb-content');content.replaceChildren();s.root.classList.toggle('tb-table-mode',view==='table');
  for(const b of s.root.querySelectorAll('nav [data-view]'))b.setAttribute('aria-pressed',String(b.dataset.view===view));
  s.root.dataset.hints=String(s.config.showHints);
  const area={request:'request',shift:'shift',table:'table',settings:'settings',catalog:'people',history:'history'}[view];if(view!=='catalog'||!s.can('equipment'))s.require(area);
  if(view==='history'){content.innerHTML='<p>История подтверждённых транзакций и локальная очередь хранят снимки до/после. Незавершённые конфликты доступны внизу.</p>'+button('Открыть журнал выбранного месяца','history');content.querySelector('button').onclick=()=>s.api.history();return;}
  if(view==='table'){const editor=await import('./editor.mjs');s.check();s.editor=await editor.mount(s,content);return;}
  const mod=await import('./'+view+'.mjs');s.check();await mod.mount(s,content);
}
export function configMissing(s,host){if(!s.configRow){const p=document.createElement('p');p.className='tb-warning';p.textContent='Настройки объекта ещё не подтверждены сервером. Проверьте дату начала в «Настройках» и сохраните настройки.';host.prepend(p);}}
