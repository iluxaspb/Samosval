/* Test-only local Firestore traffic dashboard. No Firebase calls. */
(function(){
'use strict';
const T=window.FirebaseTraffic;if(!T)return;
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=x=>Number(x||0).toLocaleString('ru-RU');
const pct=(n,max)=>Math.min(999,100*(n||0)/max);
let selected='',ready=false,lastRender=0;
function style(){
 const el=document.createElement('style');el.textContent=
 '.ft-panel{font-size:13px;color:var(--text,#f8fafc)}'+
 '.ft-panel .ft-note{line-height:1.55;color:var(--muted,#94a3b8);font-size:12px;margin:10px 0}'+
 '.ft-panel .ft-toolbar{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0}'+
 '.ft-panel .ft-toolbar select,.ft-panel .ft-toolbar button{max-width:100%;flex:1 1 145px}'+
 '.ft-panel .ft-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:12px 0}'+
 '.ft-panel .ft-stat{padding:11px;border:1px solid var(--border,#334155);border-radius:10px;background:rgba(100,116,139,.10);min-width:0}'+
 '.ft-panel .ft-stat b{display:block;font-size:22px;margin-top:4px;font-variant-numeric:tabular-nums}'+
 '.ft-panel .ft-stat small{font-size:11px;color:var(--muted,#94a3b8)}'+
 '.ft-panel .ft-limit{margin:11px 0 15px}'+
 '.ft-panel .ft-meter{height:9px;background:rgba(148,163,184,.24);border-radius:9px;overflow:hidden;margin-top:5px}'+
 '.ft-panel .ft-meter>i{display:block;height:100%;background:#38bdf8;border-radius:9px}'+
 '.ft-panel .ft-meter>i.warn{background:#f59e0b}.ft-panel .ft-meter>i.critical{background:#ef4444}'+
 '.ft-panel .ft-chart{display:flex;align-items:end;gap:3px;height:135px;padding:9px 2px 0;border-bottom:1px solid var(--border,#334155)}'+
 '.ft-panel .ft-col{flex:1;min-width:2px;display:flex;flex-direction:column;justify-content:end;height:100%;position:relative}'+
 '.ft-panel .ft-col>i{width:100%;min-height:1px;background:#38bdf8;border-radius:3px 3px 0 0}'+
 '.ft-panel .ft-col>span{font-size:9px;position:absolute;top:100%;left:0;white-space:nowrap;color:var(--muted,#94a3b8)}'+
 '.ft-panel .ft-scroll{overflow:auto;max-height:350px;margin:6px 0 17px;border-radius:8px;border:1px solid var(--border,#334155)}'+
 '.ft-panel table{width:100%;border-collapse:collapse;min-width:420px}'+
 '.ft-panel th,.ft-panel td{text-align:left;padding:7px;border-bottom:1px solid rgba(148,163,184,.18);font-size:11px}'+
 '.ft-panel th{position:sticky;top:0;background:var(--card,#1e293b)}'+
 '.ft-panel .ft-section{font-size:15px;font-weight:700;margin:20px 0 8px}'+
 '.ft-panel .ft-accent{color:#38bdf8}.ft-panel .ft-error{color:#f87171}'+
 '@media(min-width:700px){.ft-panel .ft-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}';
 document.head.append(el);
}
function init(){
 if(ready)return;const tabs=document.querySelector('#tab-admin .admin-tabs');
 if(!tabs)return;ready=true;style();
 const btn=document.createElement('button');btn.className='admin-tab-btn';btn.type='button';
 btn.textContent='📡 Firebase';btn.onclick=()=>{if(typeof window.switchAdminTab==='function')window.switchAdminTab('firebase-traffic',btn);render(true);};
 tabs.append(btn);
 const panel=document.createElement('div');panel.id='admin-sub-firebase-traffic';panel.className='admin-section ft-panel';
 panel.innerHTML='<div class="section-title">📡 Монитор запросов Firebase <small style="color:var(--warning)">ТЕСТ</small></div>'+
 '<p class="ft-note">Учёт обращений Firestore на этом устройстве. Никаких данных базы, номеров машин, имён или паролей не записываем. Мониторинг не выполняет дополнительных запросов к Firebase.</p>'+
 '<div class="ft-toolbar"><select class="form-control" id="ftDay" aria-label="Сутки квоты Firebase, время отображается по Москве"></select>'+
 '<button class="btn btn-secondary btn-small" id="ftExportJson">⬇️ JSON за все дни</button>'+
 '<button class="btn btn-secondary btn-small" id="ftExportCsv">⬇️ CSV событий</button></div>'+
 '<div id="ftDashboard"></div>'+
 '<div class="ft-toolbar"><button class="btn btn-secondary btn-small" id="ftClear">🗑 Очистить локальную историю</button></div>'+
 '<p class="ft-note" id="ftStoreStatus"></p>';
 tabs.parentNode.append(panel);
 panel.querySelector('#ftDay').addEventListener('change',e=>{selected=e.target.value;render(true);});
 panel.querySelector('#ftExportJson').onclick=()=>exportJSON();
 panel.querySelector('#ftExportCsv').onclick=()=>exportCSV();
 panel.querySelector('#ftClear').onclick=clearHistory;
 window.addEventListener('firebase-traffic-change',()=>{if(isVisible())render(false);});
 setInterval(()=>{if(isVisible())render(false);},2000);
 render(true);
}
function isVisible(){
 return !!(document.querySelector('#tab-admin.active')&&document.querySelector('#admin-sub-firebase-traffic.active'));
}
const box=(label,value,sub)=>'<div class="ft-stat">'+esc(label)+'<b>'+esc(value)+'</b><small>'+esc(sub||'')+'</small></div>';
function bar(label,val,total){
 const p=pct(val,total),cls=p>=90?'critical':p>=65?'warn':'';
 return '<div class="ft-limit"><div style="display:flex;justify-content:space-between;gap:8px"><span>'+esc(label)+'</span><b>'+esc(fmt(val))+' / '+fmt(total)+' ('+p.toFixed(2)+'%)</b></div><div class="ft-meter"><i class="'+cls+'" style="width:'+Math.min(100,p).toFixed(2)+'%"></i></div></div>';
}
const rows=(names,values)=>'<div class="ft-scroll"><table><thead><tr>'+names.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+values.join('')+'</tbody></table></div>';
function render(force){
 if(!ready)return;
 if(!force&&Date.now()-lastRender<850)return;
 lastRender=Date.now();const now=T.today();
 const d=selected||now;
 const select=document.querySelector('#ftDay');
 if(!select)return;
 const days=[...new Set([now,...Object.keys(T.data.days)])].sort().reverse();
 const existing=[...select.options].map(o=>o.value).join(',');
 if(existing!==days.join(','))select.innerHTML=days.map(v=>'<option value="'+esc(v)+'">'+esc(v)+' · '+(v===now?'Текущие':'Архив')+'</option>').join('');
 if(!days.includes(d))selected=now;
 select.value=selected||now;
 const key=select.value,stat=T.data.days[key]||{calls:0,reads:0,cached:0,writes:0,deletes:0,failed:0,listens:0,unsubscribes:0,snapshots:0,events:0,byPath:{},byType:{},hours:[]};
 const nextReset=T.nextQuotaReset();
 const mskReset=nextReset?T.mskTime(nextReset)+' МСК':'—';
 const isNow=key===now;
 const rate=Object.entries(stat.byPath||{}).sort((a,b)=>b[1].reads-a[1].reads||b[1].calls-a[1].calls).slice(0,25);
 const types=Object.entries(stat.byType||{}).sort((a,b)=>b[1].events-a[1].events);
 const hourly=stat.hours||[],peak=Math.max(1,...hourly.map(h=>h.reads||0));
 const length=T.periodHours(key),start=T.periodStartUTC(key);
 const chart='<div class="ft-chart">'+Array.from({length},(_,h)=>{const v=hourly[h]?.reads||0;const clock=T.mskTime(start+h*3600000).slice(11);return '<div class="ft-col" title="'+clock+' МСК · '+fmt(v)+' оценочных чтений"><i style="height:'+Math.max(1,100*v/peak).toFixed(2)+'%"></i>'+(h%3===0?'<span>'+clock+'</span>':'')+'</div>';}).join('')+'</div>';
 const recent=T.data.events.filter(e=>e.day===key).slice(-100).reverse();
 const html=
 '<div class="ft-note">Отчётные сутки Firebase: <b>'+esc(T.startMsk(key))+'</b>. Обновление автоматически, без запросов к серверу. '+(isNow?'<span class="ft-accent">● Сейчас</span>':'Архивный период')+'</div>'+
 '<div class="ft-grid">'+
 box('Вызовы SDK',fmt(stat.calls),'get, listen, запись, транзакции')+
 box('Чтения, оценка',fmt(stat.reads),'по серверным снимкам')+
 box('Записи',fmt(stat.writes),'подтверждённые операции')+
 box('Удаления',fmt(stat.deletes),'подтверждённые операции')+
 box('Чтения из кеша',fmt(stat.cached),'не считаются как серверные')+
 box('Активные подписки',isNow?fmt(T.data.active):'—','только на этом телефоне')+
 box('События подписок',fmt(stat.snapshots),'полученные обновления')+
 box('Ошибки',fmt(stat.failed),'ошибки SDK')+
 '</div>'+
 '<div class="ft-section">Использование бесплатного лимита Firestore (приближённо)</div>'+
 '<p class="ft-note">Единые отчётные сутки: Firebase (America/Los_Angeles), даты и часы показаны по Москве. Следующий сброс: <b>'+esc(mskReset)+'</b>. Учитывается только этот телефон; цифры — оценки SDK, не официальный биллинг Firebase.</p>'+
 bar('Чтения',stat.reads,T.free.reads)+bar('Записи',stat.writes,T.free.writes)+bar('Удаления',stat.deletes,T.free.deletes)+
 '<div class="ft-section">Чтения по часам (МСК)</div>'+chart+'<div style="height:18px"></div>'+
 '<div class="ft-section">Какие разделы создают нагрузку</div>'+
 rows(['Коллекция / путь','Вызовы','Чтения','Записи','Ошибки'],rate.map(([path,o])=>'<tr><td>'+esc(path)+'</td><td>'+fmt(o.calls)+'</td><td>'+fmt(o.reads)+'</td><td>'+fmt(o.writes)+'</td><td>'+fmt(o.failed)+'</td></tr>'))+
 '<div class="ft-section">Операции и типы обращений</div>'+
 rows(['Тип','События','Вызовы','Чтения','Записи / удаления'],types.map(([name,o])=>'<tr><td>'+esc(name)+'</td><td>'+fmt(o.events)+'</td><td>'+fmt(o.calls)+'</td><td>'+fmt(o.reads)+'</td><td>'+fmt(o.writes)+' / '+fmt(o.deletes)+'</td></tr>'))+
 '<div class="ft-section">Оценка нагрузки других операторов по журналу аудита</div>'+ 
 '<p class="ft-note">Одно событие журнала аудита не равно одному запросу Firebase. По общему журналу можно подсчитать действия всех операторов и применить измеренные на этом устройстве коэффициенты, но фоновые подписки, открытия вкладок, повторные подключения, ошибки и обращения других устройств без телеметрии останутся неизвестны. Для точной общей картины необходимы официальная статистика Firestore и/или локальные отчёты с других устройств. Автоматически не обращаемся к журналу: мониторинг не создаёт дополнительных чтений.</p>'+
 '<div class="ft-section">Последние 100 событий выбранных суток</div>'+
 rows(['МСК','Операция','Путь','Чтения','Записи','Статус'],recent.map(e=>'<tr><td>'+esc(new Date(e.ts+10800000).toISOString().slice(11,19))+'</td><td>'+esc(e.kind)+'</td><td>'+esc(e.path)+'</td><td>'+fmt(e.reads)+'</td><td>'+fmt(e.writes)+'</td><td>'+esc(e.code||e.source||'—')+'</td></tr>'))+
 '<p class="ft-note">Учитываются вызовы совместимого SDK Firestore, подтверждённые записи и видимые обновления подписок. Оценка чтений не включает точный учёт индексов, серверных операций других устройств, повторных подключений и инфраструктурных расходов. Для точных общих цифр сравни с Firebase Console → Firestore → Usage или Google Cloud Billing.</p>';
 document.getElementById('ftDashboard').innerHTML=html;
 document.getElementById('ftStoreStatus').textContent=(T.data.persisted?'Локальная история: IndexedDB · до 180 отчётных дней, последние 10 000 подробных событий.':'⚠ Локальное сохранение не подтверждено: '+(T.data.notice||'ошибка IndexedDB'))+' · Перехвачено методов SDK: '+T.hooks.length+'. Накопление начинается после загрузки этой версии приложения.';
}
function download(name,content,mime){
 const blob=new Blob([content],{type:mime}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),45000);
}
async function exportJSON(){
 await T.flush();const body={format:'samosval-firebase-traffic/v1',generatedAt:new Date().toISOString(),scope:'single-device',reportDay:'America/Los_Angeles midnight (displayed Europe/Moscow)',quota:T.free,hooks:T.hooks,notes:['SDK-observed estimates, not billed totals','Offline cache excluded from server-read estimate','No document contents, user identifiers, API keys or parameters saved'],daily:T.data.days,events:T.data.events};
 download('samosval-firebase-traffic-'+T.today()+'.json',JSON.stringify(body,null,2),'application/json;charset=utf-8');
}
async function exportCSV(){
 await T.flush();
 const fields=['ts','day','quotaDay','kind','path','calls','reads','cached','writes','deletes','failed','ms','source','code'];
 const csv=[fields.join(';'),...T.data.events.map(e=>fields.map(k=>'"'+String(e[k]??'').replace(/"/g,'""')+'"').join(';'))].join('\r\n');
 download('samosval-firebase-events-'+T.today()+'.csv','\ufeff'+csv,'text/csv;charset=utf-8');
}
async function clearHistory(){
 if(!confirm('Удалить ВСЮ локальную статистику Firebase на этом телефоне? Это нельзя отменить.'))return;
 const db=await new Promise(resolve=>{try{const r=indexedDB.open('samosval_firebase_traffic_v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>resolve(null);}catch(_){resolve(null);}});
 if(db)await new Promise(resolve=>{const tx=db.transaction(['daily','events'],'readwrite');tx.objectStore('daily').clear();tx.objectStore('events').clear();tx.oncomplete=resolve;tx.onerror=resolve;});
 T.data.days={};T.data.events=[];T.data.totalEvents=0;selected='';
 render(true);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();