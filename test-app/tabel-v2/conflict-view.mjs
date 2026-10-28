import {esc,btn,dialog} from './messages.mjs';
import * as D from './table-domain.mjs';
const labels={cells:'Ячейки',raw:'Значение',widths:'Ширина столбцов',heights:'Высота строк',style:'Оформление',background:'Цвет фона',color:'Цвет текста',fontSize:'Размер шрифта',fontWeight:'Жирность шрифта',fontStyle:'Начертание',textAlign:'Выравнивание',whiteSpace:'Перенос строк',border:'Граница',rows:'Строки',cols:'Столбцы',sheetAccess:'Доступ к листам',roles:'Роли',users:'Пользователи',master:'Мастера',lopater:'Лопатеры',viewer:'Наблюдатели',hours:'Часы техники / сотрудника',crewHours:'Часы машинистов / водителей',pumpHours:'Часы помпы',pump:'Помпа',name:'Название',unit:'Единица измерения',plan:'План работ',direction:'Направление',quantity:'Объём за смену',deleted:'Удаление записи',closed:'Смена закрыта',start:'Начало работ',end:'Окончание работ',date:'Дата',shift:'Смена',equipment:'Техника в составе',people:'Люди в составе',lunch:'Обед: количество',lunchNote:'Обед: примечание',note:'Примечание',metro:'Метро',pickupTime:'Время подачи',responsibleId:'Ответственный ИТР',currentMaterial:'Текущий материал',destinations:'Направления',tableMode:'Режим таблицы',section:'Раздел',ownership:'Принадлежность',plate:'Госномер',phone:'Телефон',group:'Категория',crewLabel:'Название строки персонала'};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function flatten(value,config,path='',out=new Map()){
 if(Array.isArray(value)){
  if(value.every(x=>x&&typeof x==='object'&&x.id))for(const x of value)flatten(x,config,path+(path?' · ':'')+(x.name||x.id),out);
  else out.set(path,value.map(x=>typeof x==='string'?lookup(config,x):String(x)).join(', ')||'Список пуст');
 }else if(value&&typeof value==='object')for(const [k,v]of Object.entries(value)){
  if(['id','usage','sourceImports','lineSources','lineImportConflicts'].includes(k))continue;
  const label=k==='request'?'Заявка':k==='values'?'Материалы и работы':labels[k]||lookup(config,k);
  flatten(v,config,path+(path?' · ':'')+label,out);
 }else out.set(path,value);
 return out;
}
function lookup(c,id){if(/^[A-Z]{1,3}[1-9]\d*$/.test(id))return 'Ячейка '+id;return [...(c.equipment||[]),...(c.people||[]),...(c.materials||[]),...(c.works||[])].find(x=>x.id===id)?.name||({day:'День',night:'Ночь',own:'Своя',hired:'Наёмная',worker:'Рабочий',itr:'ИТР',receipt:'Поступление',granulate:'Гранулят'}[id])||('Дополнительная настройка: '+id);}
export function conflictRows(before,current,mine,config={}){
 const maps=[before,current,mine].map(x=>flatten(x||{},config));
 return [...new Set(maps.flatMap(m=>[...m.keys()]))].filter(k=>!same(maps[1].get(k),maps[2].get(k))).map(label=>({label,before:maps[0].get(label),current:maps[1].get(label),mine:maps[2].get(label),bothChanged:!same(maps[0].get(label),maps[1].get(label))&&!same(maps[0].get(label),maps[2].get(label))}));
}
const value=x=>x===undefined?'Не указано / отсутствует':x===null||x===''?'Не заполнено':x===true?'Да':x===false?'Нет':String(x);
const time=t=>t?new Date(t).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}):'Время не записано';
export function showConflicts(s, jobId){
 const existing=document.querySelector("dialog.tn-conflict-dialog[open]");if(existing)return existing;
 const jobs=s.store.state.jobs.filter(j=>j.status==='conflict');
 if(!jobs.length)return dialog('Конфликты','<p>Конфликтов нет. Если есть ожидающие отправки изменения, их состояние показано в нижней строке табеля.</p>');
 const job=jobs.find(j=>j.id===jobId)||jobs[0],related=s.store.state.jobs.filter(j=>j.key===job.key),latest=related.at(-1),objectId=job.key.split('/')[0];
 const config=s.store.get(objectId+'/config').data||{},object=(s.host.data().objects||[]).find(x=>x.id===objectId);
 const remote=job.remote||{},date=latest.data?.date||remote.data?.date,shift=latest.data?.shift||remote.data?.shift;
 const rows=conflictRows(job.before?.data,remote.data,latest.data,config);
 const localName=latest.author?.name||latest.author?.uid||'Автор не записан',remoteName=remote.authorName||remote.author||'Автор не записан';
 const heading=`${esc(object?.name||config.name||'Объект не указан')}${date?' · '+D.display(date):''}${shift?' · '+(shift==='night'?'Ночь':'День'):''}`;
 const el=dialog('Нужно выбрать версию записи',`<p><b>${heading}</b></p><p>Другая версия этой записи уже сохранена. Автоматически заменять её нельзя: значения могут отличаться.</p><p><b>На сервере:</b> ${esc(remoteName)} · ${time(remote.time)}<br><b>На этом устройстве:</b> ${esc(localName)} · ${time(latest.time)}</p><p>Неразрешённых конфликтов: ${jobs.length}. ${related.length>1?'Показан последний вариант с этого устройства с учётом последующих правок.':''}</p><div class="tn-conflict-scroll"><table class="tn-conflict-table"><thead><tr><th>Что отличается</th><th>На сервере</th><th>На этом устройстве</th></tr></thead><tbody>${rows.map(r=>`<tr><th>${esc(r.label)}${r.bothChanged?'<small>Изменено с обеих сторон</small>':''}<small>До правок: ${esc(value(r.before))}</small></th><td>${esc(value(r.current))}</td><td>${esc(value(r.mine))}</td></tr>`).join('')||'<tr><td colspan="3">Различий в отображаемых значениях нет. Выбор всё равно применяется ко всей записи.</td></tr>'}</tbody></table></div><p><b>Выбирается вся запись целиком.</b> Часы, состав и настройки из другого столбца будут заменены. Таблица и отчёт пересчитаются. Оба варианта останутся в истории.</p>${btn('Оставить версию с сервера','server')}${btn('Отправить версию с этого устройства','local')}`);
 el.classList.add('tn-conflict-dialog');
 let busy=false;
 for(const [action,choice]of [['server','theirs'],['local','mine']])el.querySelector('[data-action='+action+']').onclick=async()=>{
  if(busy)return;
  busy=true;el.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{
   const newest=s.store.state.jobs.filter(j=>j.key===job.key).at(-1);
   if(newest && newest.id!==latest.id){el.close();showConflicts(s,job.id);return;}
   const area=job.key.includes('/sheet:')?'table':job.key.endsWith('/config')?'settings':'shift';
   s.require(area,'edit');
   await s.store.resolve(job.id,choice);
   el.close();await s.refresh();
  }catch(e){el.querySelector('[role=alert]').textContent=e.message||e;}
  finally{busy=false;el.querySelectorAll('button').forEach(b=>b.disabled=false);}
 };

 return el;
}

// Present each new conflict once while the workspace is visible, including
// conflicts returned asynchronously by Firebase after the editor has closed.
export function autoConflicts(s) {
 const presented=new Set();let timer;
 const check=()=>{
  if(s.store.closed || !s.root.getClientRects().length || document.querySelector('dialog.tn-conflict-dialog[open]'))return;
  const job=s.store.state.jobs.find(j=>j.status==='conflict'&&!presented.has(j.id));
  if(!job)return;
  presented.add(job.id);
  const el=showConflicts(s,job.id);
  el.addEventListener('close',schedule,{once:true});
 };
 const schedule=()=>{clearTimeout(timer);timer=setTimeout(check,0);};
 s.store.listeners.add(schedule);
 schedule();
 return {check:schedule,dispose(){clearTimeout(timer);s.store.listeners.delete(schedule);}};
}
