// TEST-only control center. Server authorizes every read and mutation independently.
let serverControlSnapshot=null,serverControlSection='overview',serverControlFlight=null,serverControlBusy=false,serverControlError='',serverControlScope='';
const serverControlLabels={queued:'В очереди',running:'Выполняется',succeeded:'Завершено',failed:'Ошибка',check:'Проверка обновлений',backup:'Резервная копия БД',update:'Обновление API',restart:'Перезапуск API',rollback:'Возврат предыдущего API',downloading:'Скачивание',verifying:'Проверка',backing_up:'Копирование и проверка восстановления',switching:'Установка',validating:'Проверка запуска',rolling_back:'Возврат прежнего API',interrupted:'Прервано',ready:'Готово',unavailable:'Недоступно'};
const scText=x=>escapeHtml(String(x??'—'));
function scBytes(n){n=Number(n);if(!Number.isFinite(n)||n<0)return 'Нет данных';if(n<1024)return n+' Б';const units=['КБ','МБ','ГБ','ТБ'];let i=-1;do{n/=1024;i++;}while(n>=1024&&i<units.length-1);return n.toLocaleString('ru-RU',{maximumFractionDigits:1})+' '+units[i];}
const scDate=x=>x?new Date(x).toLocaleString('ru-RU'):'Нет данных';
function scCard(label,value,note=''){return '<article class="sc-card"><span>'+scText(label)+'</span><strong>'+scText(value)+'</strong>'+(note?'<small>'+scText(note)+'</small>':'')+'</article>';}
function scButton(action,text,disabled=false){return '<button type="button" class="btn btn-secondary btn-small" data-sc-action="'+action+'"'+(disabled?' disabled':'')+'>'+scText(text)+'</button>';}
function scAllowed(){return isNasRuntime()&&canAdmin()&&!!nasRuntimeClient;}
function scVisible(){return document.getElementById('tab-admin')?.classList.contains('active')&&document.getElementById('admin-sub-server')?.classList.contains('active')&&!document.hidden;}
function renderServerControl(){
 const root=document.getElementById('server-control-root');if(!root)return;
 if(!scAllowed()){serverControlSnapshot=null;root.textContent=isNasRuntime()?'Требуется активный администратор.':'Центр управления доступен в тестовой версии Synology.';return;}
 const s=serverControlSnapshot,a=s?.agent,fresh=!!s&&!serverControlError&&Date.now()-s.readAt<30000,available=fresh&&a?.available&&!serverControlBusy,job=s?.jobs.find(j=>['queued','running'].includes(j.status)),disabled=!available||!!job;
 let html='<div class="sc-heading"><div><h3>Центр управления</h3><span class="sc-channel">TEST · Synology</span></div>'+scButton('refresh','Обновить',!!serverControlFlight)+'</div>';
 html+='<p class="sc-status" role="status">'+scText(serverControlError||(!s?'Загружаю состояние…':!fresh?'Показаны последние полученные данные':a?.available?'Служба управления на связи':'Служба управления не подключена. Серверные действия недоступны.'))+'</p>';
 html+='<div class="sc-nav" role="group" aria-label="Разделы центра управления">'+[['overview','Обзор'],['resources','Ресурсы'],['updates','Обновления'],['backups','Копии'],['replication','Репликация'],['objects','Объекты'],['journal','Журнал']].map(([key,label])=>'<button type="button" data-sc-section="'+key+'" aria-pressed="'+(key===serverControlSection)+'">'+label+'</button>').join('')+'</div>';
 if(job)html+='<p class="sc-progress" role="status">'+scText(serverControlLabels[job.type])+' · '+scText(serverControlLabels[job.stage]||job.stage)+'. Задание продолжится на NAS после закрытия приложения.</p>';
 if(s){
  const host=a.host||{},disk=host.disk||{};
  if(serverControlSection==='overview'){
   html+='<div class="sc-grid">'+scCard('API',s.api.version,'Работает '+Math.floor(s.api.uptimeSeconds/60)+' мин')+scCard('База данных',s.database.status==='connected'?'Подключена':'Недоступна',scBytes(s.database.bytes))+scCard('Свободное место NAS',scBytes(disk.availableBytes),disk.totalBytes?'Всего '+scBytes(disk.totalBytes):'Появится после подключения службы')+scCard('Пользователи',s.users.registered,'Допущены: '+s.users.active+' · заявки: '+s.users.pending)+scCard('Объекты',s.objects.length,'Открытых смен: '+s.objects.reduce((n,o)=>n+o.active_shifts,0))+scCard('Последняя копия БД',a.backups?.[0]?scDate(a.backups[0].createdAt):'Нет подтверждения',a.backups?.[0]?.restored?'Проверено восстановлением':'Полная серверная копия')+'</div>';
   html+='<div class="sc-actions">'+scButton('check','Проверить обновления',disabled)+scButton('backup','Создать копию БД',disabled)+scButton('restart','Перезапустить API',disabled)+'</div>';
   html+='<p class="sc-note">Несинхронизированных рейсов на этом устройстве: '+scText(typeof offlinePendingCount==='function'?offlinePendingCount():'Нет данных')+'. Очереди остальных устройств доступны только на самих устройствах.</p>';
  }
  if(serverControlSection==='resources'){
   html+='<div class="sc-grid">'+scCard('Диск NAS',scBytes(disk.availableBytes)+' свободно',disk.totalBytes?'Использовано '+scBytes(disk.totalBytes-disk.availableBytes):'Нет измерений')+scCard('Оперативная память NAS',host.memory?scBytes(host.memory.usedBytes)+' / '+scBytes(host.memory.totalBytes):'Нет данных')+scCard('Нагрузка NAS',host.load?.join(' / ')||'Нет данных','Средняя нагрузка за 1, 5 и 15 минут')+scCard('Запросы API',s.api.requests,'С момента запуска API')+scCard('Ответ API, p95',s.api.p95Ms===null?'Нет измерений':s.api.p95Ms+' мс','Последние 500 запросов')+scCard('Ошибки API',s.api.errors,'Ответы 5xx с момента запуска')+scCard('Память процесса API',scBytes(s.api.memoryBytes))+scCard('Измерение NAS',scDate(a.heartbeat),a.available?'Свежие данные':'Данные устарели')+'</div><p class="sc-note">Показатели NAS получаем со службы управления. SMART, температура и состояние RAID пока не подключены: панель не подменяет их показателями контейнера.</p>';
  }
  if(serverControlSection==='updates'){
   html+='<div class="sc-grid">'+scCard('Приложение',window.TEST_APP_RELEASE?.version||'—','Номер виден всем ролям')+scCard('Сервер API',s.api.version)+scCard('Доступный серверный релиз',a.release?.version||'Нет проверенного релиза',a.release?.verified?'Проверки GitHub пройдены':'Проверка кнопкой ниже')+'</div>';
   if(a.release?.notes)html+='<p>'+scText(a.release.notes)+'</p>';
   html+='<div class="sc-actions">'+scButton('check','Проверить GitHub',disabled)+scButton('update','Обновить сервер',disabled||!a.release?.verified||a.release.version===s.api.version)+scButton('rollback','Вернуть предыдущий API',disabled||!a.rollbackAvailable)+scButton('app-update','Проверить приложение')+'</div><p class="sc-note">Перед обновлением API служба создаёт полную копию PostgreSQL и проверяет восстановление. При неудачном запуске возвращает прежний API. Рабочий контур отделён; эта панель управляет TEST.</p>';
  }
  if(serverControlSection==='backups'){
   html+='<div class="sc-actions">'+scButton('backup','Создать полную копию БД',disabled)+'</div><h4>Полные серверные копии</h4>';
   html+=(a.backups||[]).length?'<ul class="sc-list">'+a.backups.map(b=>'<li><b>'+scText(scDate(b.createdAt))+'</b><span>'+scText(scBytes(b.bytes))+' · '+(b.restored?'Восстановление проверено':'Требует проверки')+'</span></li>').join('')+'</ul>':'<p>Подтверждённых копий от службы ещё нет.</p>';
   html+='<h4>Копии данных приложения</h4><ul class="sc-list">'+s.backups.map(b=>'<li><b>'+scText(b.description||b.type)+'</b><span>'+scText(scDate(b.createdAt))+' · '+scText(scBytes(b.sizeBytes))+'</span></li>').join('')+'</ul><p class="sc-note">Выборочное восстановление данных доступно в существующем разделе резервных копий. Возврат API не откатывает рейсы и табель.</p>';
  }
  if(serverControlSection==='replication'){
   const r=s.replication||{},lag=Number.isSafeInteger(r.lag)?r.lag:'Нет квитанции';
   html+='<div class="sc-grid">'+scCard('Репликация NAS → Firebase',r.enabled?'Включена':'Не включена',r.mode==='passive-mirror'?'Только пассивное зеркало TEST':'Данные пока не передаются')+
    scCard('Владелец записи',r.activeOwner==='synology'?'Synology':'Не подтверждён')+
    scCard('Курсор PostgreSQL',r.lastSequence??'Нет данных')+
    scCard('Подтверждено Firebase',r.deliveredSequence??'Нет квитанции')+
    scCard('Отставание, событий',lag)+
    scCard('Последняя квитанция',scDate(r.lastConfirmedAt))+
    scCard('Последний успешный цикл',scDate(r.lastSuccessAt))+
    scCard('Состояние резерва',r.readyForFailover?'Готов':'НЕ готов к переключению')+
    scCard('Ошибки репликатора',r.lastError||'Не зарегистрированы')+
    scCard('Координатор записи',r.writerFence?.enabled?'TEST · включён':'Ещё не включён',r.writerFence?.epoch?'Эпоха '+r.writerFence.epoch:'Эпоха не выдана')+
    scCard('Срок полномочий NAS',scDate(r.writerFence?.leaseUntil),r.writerFence?.lastError||'Ошибок нет')+'</div>';
   html+='<p class="sc-note">Только серверная копия PostgreSQL в отдельном пространстве проекта samosval-offline. Она не совместима напрямую со старой схемой Firestore. Автопереключение и обратная синхронизация отключены: даже нулевое отставание не разрешает запись в две базы. При потере NAS сохраняйте локальные очереди телефонов.</p>';
  }
  if(serverControlSection==='objects')html+='<div class="sc-actions">'+scButton('users','Пользователи и права')+'</div><ul class="sc-list">'+s.objects.map(o=>'<li><b>'+scText(o.name||o.id)+'</b><span>Открытых смен: '+scText(o.active_shifts)+'</span></li>').join('')+'</ul>';
  if(serverControlSection==='journal'){
   html+='<h4>Задания сервера</h4><ul class="sc-list">'+s.jobs.map(j=>'<li><b>'+scText(serverControlLabels[j.type])+' · '+scText(serverControlLabels[j.status])+'</b><span>'+scText(scDate(j.updated_at))+' · '+scText(serverControlLabels[j.stage]||j.stage)+(j.detail?.error?' · '+scText(j.detail.error):'')+'</span></li>').join('')+'</ul><h4>Этапы установки</h4><ul class="sc-list">'+s.events.map(e=>'<li>'+scText(scDate(e.created_at))+' · '+scText(serverControlLabels[e.stage]||e.stage)+'</li>').join('')+'</ul><h4>Последние ошибки API</h4><ul class="sc-list">'+s.api.recentErrors.map(e=>'<li>'+scText(scDate(e.at))+' · '+scText(e.method)+' '+scText(e.path)+' · '+scText(e.status)+'</li>').join('')+'</ul>';
  }
  html+='<p class="sc-note">Получено: '+scText(scDate(s.readAt))+'. Обновление показателей каждые 15 секунд, пока открыт этот раздел.</p>';
 }
 root.innerHTML=html;
 root.querySelectorAll('[data-sc-section]').forEach(b=>b.onclick=()=>{serverControlSection=b.dataset.scSection;renderServerControl();});
 root.querySelectorAll('[data-sc-action]').forEach(b=>b.onclick=()=>void serverControlAction(b.dataset.scAction));
}
async function openServerControl(){
 if(!scAllowed()){renderServerControl();return;}
 const client=nasRuntimeClient,epoch=nasRuntimeEpoch;
 if(serverControlScope!==client.scope){serverControlScope=client.scope;serverControlSnapshot=null;serverControlError='';serverControlFlight=null;}
 if(serverControlFlight)return serverControlFlight;
 const work=(async()=>{try{const snapshot=await client.readServerControl();if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch||!scAllowed())return;serverControlSnapshot=snapshot;serverControlError='';}
 catch(e){if(client===nasRuntimeClient&&epoch===nasRuntimeEpoch)serverControlError=e.status===404?'Сервер ещё не обновлён для центра управления.':e.status===403?'Нет доступа к управлению сервером.':'Не удалось получить свежие данные. Серверные действия заблокированы.';}
 finally{if(client===nasRuntimeClient&&epoch===nasRuntimeEpoch){serverControlFlight=null;renderServerControl();}}})();
 serverControlFlight=work;renderServerControl();return work;
}
async function serverControlAction(type){
 if(type==='refresh')return openServerControl();
 if(type==='users'){switchAdminTab('users',document.querySelector('[onclick="switchAdminTab(\'users\', this)"]'));return;}
 if(type==='app-update'){await window.TestPWA?.checkForUpdates();return;}
 if(!scAllowed()||serverControlBusy||!serverControlSnapshot?.agent.available)return;
 const client=nasRuntimeClient,epoch=nasRuntimeEpoch,a=serverControlSnapshot.agent,key='samosval_server_command:'+client.scope;
 const questions={update:'Создать проверенную копию БД и обновить сервер TEST? Во время перезапуска устройства сохраняют действия локально. При неудаче служба вернёт прежний API.',restart:'Перезапустить API TEST? Связь с сервером кратковременно прервётся.',rollback:'Вернуть предыдущий API TEST? Рейсы и табель в базе останутся текущими.'};
 if(questions[type]&&!(await appConfirm(questions[type])))return;
 if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch||!scAllowed())return;
 serverControlBusy=true;renderServerControl();
 try{
  let op=JSON.parse(localStorage.getItem(key)||'null');
  const requested={type,channel:'test',...(['update','rollback'].includes(type)?{expectedImage:a.imageId}:{}),...(type==='update'?{releaseId:a.release.version}:{})};
  if(op&&(op.type!==type||op.channel!=='test'))throw Error('Предыдущее задание ещё не подтверждено. Повторите «'+(serverControlLabels[op.type]||op.type)+'», чтобы проверить его результат.');
  if(!op){op={id:'server_'+crypto.randomUUID().replaceAll('-',''),...requested};localStorage.setItem(key,JSON.stringify(op));}
  await client.submitServerCommand(op,{operationScope:client.scope});
  if(client!==nasRuntimeClient||epoch!==nasRuntimeEpoch)return;
  localStorage.removeItem(key);showToastEl('Задание принято службой NAS',false);
 }catch(e){if([400,403,409].includes(e.status))localStorage.removeItem(key);showError(e.message||'Результат пока не подтверждён. Повторная попытка использует тот же номер задания.');}
 finally{serverControlBusy=false;if(client===nasRuntimeClient&&epoch===nasRuntimeEpoch)await openServerControl();}
}
window.addEventListener('DOMContentLoaded',()=>{
 const style=document.createElement('style');style.textContent='.sc-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.sc-heading h3{margin:0 0 5px}.sc-channel{color:#f59e0b;font-size:11px;font-weight:800}.sc-nav{display:flex;gap:6px;overflow-x:auto;margin:12px 0;padding-bottom:4px}.sc-nav button{font:inherit;white-space:nowrap;border:1px solid var(--border);border-radius:9px;background:var(--card);color:var(--text);padding:9px 12px;font-size:12px}.sc-nav [aria-pressed=true]{border-color:#22c55e;color:#22c55e}.sc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.sc-card{display:flex;flex-direction:column;gap:7px;padding:13px;border:1px solid var(--border);background:var(--card);border-radius:12px;min-width:0}.sc-card>span,.sc-note,.sc-card small{font-size:11px;color:var(--muted);line-height:1.5}.sc-card strong{font-size:17px;overflow-wrap:anywhere}.sc-actions{display:flex;flex-wrap:wrap;gap:7px;margin:14px 0}.sc-list{list-style:none;padding:0}.sc-list li{display:flex;flex-direction:column;gap:5px;padding:11px 0;border-bottom:1px solid var(--border);font-size:12px;overflow-wrap:anywhere}.sc-list span{color:var(--muted)}.sc-status,.sc-progress{font-size:12px;line-height:1.5}.sc-progress{padding:12px;border:1px solid #f59e0b;border-radius:10px}@media(min-width:800px){.sc-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}';document.head.append(style);
 setInterval(()=>{if(!scAllowed()){serverControlSnapshot=null;serverControlFlight=null;if(scVisible())renderServerControl();}else if(scVisible())void openServerControl();},15000);
});
