
/* Trip duration is load -> next recorded arrival, never load -> next load. */
function calculateTripAnalytics(sessions, trucks, now) {
  const rows = new Map(), trips = [], waits = []; let loads = 0, volume = 0, missing = 0, pending = 0, invalid = 0;
  for (const session of sessions) {
    const grouped = new Map();
    for (const log of session.logs || []) {
      if (log.isGAI) continue;
      if (!grouped.has(log.truckId)) grouped.set(log.truckId, []);
      grouped.get(log.truckId).push(log);
    }
    for (const [id, logs] of grouped) {
      logs.sort((a,b) => Number(a.timestamp)-Number(b.timestamp));
      const truck = trucks.find(t=>t.id===id);
      if (!rows.has(id)) rows.set(id, {id, name:truck ? [truck.brand,truck.number].filter(Boolean).join(' ') : logs[logs.length-1].truckName || 'Самосвал', loads:0, volume:0, trips:[], waits:[], pending:0});
      const row = rows.get(id);
      logs.forEach((log,i)=>{
        const start = Number(log.timestamp), next = logs[i+1];
        const status = session.current ? session.status?.[id] : null;
        const liveArrival = status && (!status.shiftId || status.shiftId === session.id) ? Number(status.arriveTimestamp) : 0;
        const end = Number(log.returnedAt) || (next ? Number(next.arrivalTimestamp) : liveArrival);
        loads++; row.loads++; const vol = Number(log.volume)||0; volume+=vol; row.volume+=vol;
        if (start>0 && end>start && (!next || end<=Number(next.timestamp)) && end<=now) {
          const trip={truckId:id,start,end,ms:end-start,sessionId:session.id,objectName:session.objectName};
          trips.push(trip);row.trips.push(trip);
        } else if (end || !(start>0)) { invalid++; }
        else if (session.current && !next && start<=now && status?.onLine && (!status.shiftId || status.shiftId===session.id) && !status.ttnStatus) {pending++;row.pending++;}
        else missing++;
        const arrival=Number(log.arrivalTimestamp);
        if(arrival>0 && start>=arrival && start<=now){const wait={ms:start-arrival,start:arrival,end:start,truckId:id};waits.push(wait);row.waits.push(wait);}
      });
    }
  }
  function stats(list) {const a=list.map(t=>t.ms).sort((a,b)=>a-b),n=a.length;return {n,avg:n?a.reduce((s,v)=>s+v,0)/n:null,median:n?(a[Math.floor((n-1)/2)]+a[Math.floor(n/2)])/2:null,min:n?a[0]:null,max:n?a[n-1]:null,p90:n?a[Math.ceil(n*.9)-1]:null};}
  return {rows:[...rows.values()].map(r=>({...r,stats:stats(r.trips),wait:stats(r.waits)})),trips:trips.sort((a,b)=>a.end-b.end),waits,stats:stats(trips),wait:stats(waits),loads,volume,missing,pending,invalid};
}
(function () {
  const key='samosval:test:analytics:v2', tab=document.getElementById('tab-analytics');
  const legacy=document.createElement('div');while(tab.firstChild)legacy.append(tab.firstChild);tab.append(legacy);
  const dashboard=document.createElement('div');dashboard.id='trip-analytics';tab.prepend(dashboard);
  let enabled=false,period='current',object='all',truckId='all',sort='avg',openTruck=null;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dur=ms=>ms==null?'—':ms<60000?Math.round(ms/1000)+' с':ms<3600000?(ms/60000).toFixed(1).replace('.',',')+' мин':Math.floor(ms/3600000)+' ч '+Math.round(ms%3600000/60000)+' мин';
  const num=v=>Number(v||0).toLocaleString('ru-RU',{maximumFractionDigits:1});
  const clock=ts=>new Date(ts).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  const date=ts=>new Date(ts).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'});
  const css=document.createElement('style');css.textContent=`
    #trip-analytics{--ac:#38bdf8;--ag:#34d399;line-height:1.45}
    #trip-analytics .an-heading{font-size:25px;font-weight:800;letter-spacing:-.7px;margin:4px 0}
    #trip-analytics .an-sub{color:var(--muted);font-size:12px;margin:0 0 16px}
    #trip-analytics .an-filters{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:16px 0}
    #trip-analytics label{display:block;color:var(--muted);font-size:11px;min-width:0}
    #trip-analytics select{width:100%;min-width:0;min-height:44px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:8px;font-size:13px;margin-top:4px}
    #trip-analytics .an-hero{padding:20px;border:1px solid #24506a;border-radius:18px;background:linear-gradient(125deg,#142f46,#142137);margin-bottom:12px}
    #trip-analytics .an-hero strong{display:block;font-size:38px;letter-spacing:-1px;color:#e0f2fe;line-height:1.3}
    #trip-analytics .an-kpis{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}
    #trip-analytics .an-kpi{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px;min-width:0}
    #trip-analytics .an-kpi strong{display:block;font-size:20px;margin-top:3px}
    #trip-analytics .an-muted{font-size:11px;color:var(--muted)}
    #trip-analytics .an-panel{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px;margin-bottom:12px;overflow:hidden}
    #trip-analytics h3{font-size:15px;margin:0 0 5px}
    #trip-analytics .an-bars{display:grid;gap:12px;margin-top:16px}
    #trip-analytics .an-bar-head{display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-bottom:4px}
    #trip-analytics .an-track{height:7px;background:#0f172a;border-radius:10px;overflow:hidden}
    #trip-analytics .an-fill{height:100%;background:linear-gradient(90deg,#0ea5e9,#67e8f9);border-radius:10px}
    #trip-analytics .an-chart{width:100%;height:auto;display:block;margin-top:12px}
    #trip-analytics .an-table-wrap{overflow-x:auto;margin:12px -4px 0}
    #trip-analytics table{font-size:12px;min-width:440px}
    #trip-analytics th,#trip-analytics td{padding:10px 8px;text-align:right;border-bottom:1px solid var(--border)}
    #trip-analytics th:first-child,#trip-analytics td:first-child{text-align:left}
    #trip-analytics th{font-size:10px;color:var(--muted);font-weight:500}
    #trip-analytics .an-truck{background:none;border:0;color:#7dd3fc;text-align:left;font-size:12px;cursor:pointer;padding:6px 0;max-width:180px;white-space:normal}
    #trip-analytics .an-empty{padding:22px 8px;color:var(--muted);font-size:13px;text-align:center}
    #trip-analytics .an-note{padding:12px;background:#14293a;border-radius:10px;color:#bae6fd;font-size:12px;margin-bottom:12px}
    #trip-analytics summary{cursor:pointer;min-height:36px;font-size:13px;padding:8px 0}
    #trip-analytics .an-trip{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding:9px 0;font-size:12px}
    #trip-analytics .an-pill{display:inline-block;color:#6ee7b7;background:#0d3432;border-radius:20px;padding:3px 8px;font-size:11px;margin-top:8px}
    @media(min-width:520px){#trip-analytics .an-kpis{grid-template-columns:repeat(4,1fr)}}
  `;document.head.append(css);
  const original=window.renderAnalytics;
  function sessions(){let list=[];if(state.shift)list.push({...state.shift,current:true,logs:getLogs(),status:state.truckStatus});
    if(period!=='current')list.push(...state.archive.map(s=>({...s,current:false})));
    if(period==='current')return list.filter(s=>s.current);
    const cutoff=period==='7'?Date.now()-7*86400000:period==='30'?Date.now()-30*86400000:0;
    return list.filter(s=>s.current || (appConfig?.testReviewFlags?.analytics_workdate===false?Number(s.closedAt):analyticsWorkStart(s))>=cutoff);
  }
  function analyticsWorkStart(s){const raw=s.startedAt??s.startTimestamp??s.startAt??s.date; if(typeof raw==='number')return raw; if(raw&&typeof raw.toMillis==='function')return raw.toMillis(); if(typeof raw==='string'){const date=Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw)?raw+'T00:00:00':raw);if(Number.isFinite(date))return date;} return Number(s.closedAt)||0;}
  function objectKey(s){return s.objectId?'id:'+s.objectId:'name:'+(s.objectName||'Без объекта');}
  function bars(items){if(!items.length)return '<div class="an-empty">Пока нет завершённых ходок</div>';const max=Math.max(...items.map(i=>i.value),1);return '<div class="an-bars">'+items.map(i=>`<div><div class="an-bar-head"><span>${esc(i.label)}</span><b>${esc(i.text)}</b></div><div class="an-track"><div class="an-fill" style="width:${i.value/max*100}%"></div></div></div>`).join('')+'</div>';}
  function chart(trips){if(!trips.length)return '<div class="an-empty">График появится после первого возвращения на линию</div>';
    // Every sample remains in the model; visually group large series by consecutive arrival order.
    const size=Math.max(1,Math.ceil(trips.length/60)),pts=[];for(let i=0;i<trips.length;i+=size){const g=trips.slice(i,i+size);pts.push({ms:g.reduce((s,t)=>s+t.ms,0)/g.length,start:g[0].end,end:g[g.length-1].end,n:g.length});}
    const max=Math.max(...pts.map(p=>p.ms),60000)*1.12,W=480,H=190,left=44,bottom=155,top=14;
    const x=i=>pts.length===1?260:left+i*(W-left-12)/(pts.length-1),y=v=>bottom-v/max*(bottom-top);
    let out=`<svg class="an-chart" viewBox="0 0 480 190" role="img" aria-label="Время ходки по порядку прибытия">`;
    for(let i=0;i<4;i++){const v=max*i/3,yy=y(v);out+=`<line x1="44" x2="468" y1="${yy}" y2="${yy}" stroke="#334155"/><text x="37" y="${yy+4}" text-anchor="end" fill="#94a3b8" font-size="10">${Math.round(v/60000)}</text>`;}
    out+='<text x="4" y="10" fill="#94a3b8" font-size="10">мин</text>';
    if(pts.length>1)out+=`<polyline points="${pts.map((p,i)=>x(i)+','+y(p.ms)).join(' ')}" fill="none" stroke="#38bdf8" stroke-width="2.5"/>`;
    pts.forEach((p,i)=>{out+=`<circle cx="${x(i)}" cy="${y(p.ms)}" r="3.5" fill="#67e8f9"><title>${esc(date(p.start)+' '+clock(p.start)+' · '+dur(p.ms)+(p.n>1?' · среднее по '+p.n+' ходкам':''))}</title></circle>`;});
    out+=`<text x="44" y="180" fill="#94a3b8" font-size="10">${esc(date(pts[0].start)+' '+clock(pts[0].start))}</text><text x="468" y="180" text-anchor="end" fill="#94a3b8" font-size="10">${esc(date(pts.at(-1).end)+' '+clock(pts.at(-1).end))}</text></svg>`;
    if(size>1)out+='<div class="an-muted">Каждая точка — среднее по группе до '+size+' последовательных ходок.</div>';return out;
  }
  function render(){if(!enabled||!hasTabAccess('analytics'))return;
    const all=sessions(),objects=new Map(all.map(s=>[objectKey(s),s.objectName||'Без объекта']));if(object!=='all'&&!objects.has(object))object='all';
    const selected=all.filter(s=>object==='all'||objectKey(s)===object),model=calculateTripAnalytics(selected,state.trucks,Date.now());
    if(truckId!=='all'&&!model.rows.some(r=>r.id===truckId))truckId='all';
    const filtered=truckId==='all'?model:calculateTripAnalytics(selected.map(s=>({...s,logs:(s.logs||[]).filter(l=>l.truckId===truckId)})),state.trucks,Date.now());
    const m=filtered,st=m.stats;
    const options=(items,value)=>items.map(([id,name])=>`<option value="${esc(id)}" ${String(id)===String(value)?'selected':''}>${esc(name)}</option>`).join('');
    let rows=m.rows.slice();rows.sort((a,b)=>sort==='loads'?b.loads-a.loads:sort==='name'?a.name.localeCompare(b.name):(b.stats.avg??-1)-(a.stats.avg??-1));
    const kpi=(label,value,note)=>`<div class="an-kpi"><span class="an-muted">${label}</span><strong>${value}</strong><span class="an-muted">${note}</span></div>`;
    const bins=[{label:'До 15 мин',min:0,max:15},{label:'15–30 мин',min:15,max:30},{label:'30–60 мин',min:30,max:60},{label:'60–90 мин',min:60,max:90},{label:'90 мин и больше',min:90,max:Infinity}].map(b=>({...b,value:m.trips.filter(t=>t.ms/60000>=b.min&&t.ms/60000<b.max).length}));
    dashboard.innerHTML=`<div class="an-heading">Ритм объекта</div><p class="an-sub">Ходка: погрузка → возвращение на линию</p>
      <div class="an-filters"><label>Период<select data-filter="period">${options([['current','Текущая смена'],['7','Последние 7 дней'],['30','Последние 30 дней'],['all','Вся история']],period)}</select></label><label>Объект<select data-filter="object">${options([['all','Все объекты'],...objects],object)}</select></label><label>Самосвал<select data-filter="truck">${options([['all','Все машины'],...model.rows.map(r=>[r.id,r.name])],truckId)}</select></label><label>Порядок машин<select data-filter="sort">${options([['avg','Сначала долгие ходки'],['loads','По числу погрузок'],['name','По номеру']],sort)}</select></label></div>
      <div class="an-hero"><div class="an-muted">СРЕДНЕЕ ВРЕМЯ ХОДКИ</div><strong>${dur(st.avg)}</strong><div class="an-muted">${st.n} завершённых ходок · ${selected.length} смен · ${m.rows.length} машин</div><span class="an-pill">Медиана ${dur(st.median)}</span></div>
      <div class="an-kpis">${kpi('Быстрее всего',dur(st.min),'завершённая ходка')}${kpi('Дольше всего',dur(st.max),'завершённая ходка')}${kpi('Погрузки',num(m.loads),num(m.volume)+' м³')}${kpi('Ожидание на линии',dur(m.wait.avg),'среднее · '+m.wait.n+' замеров')}</div>
      ${!st.n?'<div class="an-note">Точных завершённых ходок пока нет. Отметьте погрузку, а после возвращения — «Приехал». Старые рейсы без времени прибытия в среднее не включаются.</div>':''}
      <div class="an-panel"><h3>Как меняется время ходки</h3><div class="an-muted">Завершённые ходки по порядку прибытия${truckId==='all'?' · все выбранные машины':''}</div>${chart(m.trips)}</div>
      <div class="an-panel"><h3>Сравнение самосвалов</h3><div class="an-muted">Среднее время · справа длительность и число замеров</div>${bars(rows.filter(r=>r.stats.n).map(r=>({label:r.name,value:r.stats.avg,text:dur(r.stats.avg)+' · '+r.stats.n})))}<div class="an-muted" style="margin-top:12px">Длительность зависит от маршрута и условий; это не оценка водителя.</div></div>
      <div class="an-panel"><h3>Распределение ходок</h3><div class="an-muted">Сколько возвращений попало в каждый интервал</div>${st.n?bars(bins.map(b=>({label:b.label,value:b.value,text:b.value+' · '+Math.round(b.value/st.n*100)+'%'}))):'<div class="an-empty">Недостаточно данных</div>'}${st.n?'<div class="an-muted" style="margin-top:14px">90% ходок не дольше '+dur(st.p90)+'.</div>':''}</div>
      <div class="an-panel"><h3>Каждый самосвал</h3><div class="an-muted">Нажмите номер машины, чтобы увидеть её ходки</div><div class="an-table-wrap"><table><thead><tr><th>Самосвал</th><th>Ходки</th><th>Среднее</th><th>Медиана</th><th>Ожидание</th><th>м³</th></tr></thead><tbody>${rows.map(r=>`<tr><td><button class="an-truck" data-truck="${esc(r.id)}">${esc(r.name)}</button><div class="an-muted">${r.loads} погрузок${r.pending?' · в пути':''}</div></td><td>${r.stats.n}</td><td>${dur(r.stats.avg)}</td><td>${dur(r.stats.median)}</td><td>${dur(r.wait.avg)}</td><td>${num(r.volume)}</td></tr>`).join('')}</tbody></table></div>${!rows.length?'<div class="an-empty">Нет погрузок за выбранный период</div>':''}</div>
      <div id="an-truck-details"></div>
      <div class="an-panel"><details><summary>Как считаются показатели</summary><div class="an-muted">Среднее и медиана считаются по завершённым ходкам, каждая имеет одинаковый вес. Ожидание — время от «Приехал» до следующей погрузки. Погрузки и объём считаются отдельно: последняя погрузка может ещё не иметь возвращения.<br><br>В пути: ${m.pending}. Без отметки возвращения: ${m.missing}. Некорректных пар времени: ${m.invalid}. Они не входят в графики и среднее. Данные ограничены загруженными сменами и архивом. Для истории период выбирается по дате начала работы смены (если соответствующий патч включён); текущая смена включается целиком.</div></details></div>
      <div class="an-panel"><details${appConfig?.testReviewFlags?.analytics_audit!==false?' open':''}><summary>Журнал действий (аудит)</summary>${renderAuditEntries()}</details></div>`;
    dashboard.querySelectorAll('[data-filter]').forEach(el=>el.onchange=()=>{if(el.dataset.filter==='period')period=el.value;if(el.dataset.filter==='object')object=el.value;if(el.dataset.filter==='truck')truckId=el.value;if(el.dataset.filter==='sort')sort=el.value;openTruck=null;render();});
    function details(id){const r=m.rows.find(r=>r.id===id),target=dashboard.querySelector('#an-truck-details');if(!r){target.innerHTML='';return;}target.innerHTML=`<div class="an-panel"><h3>${esc(r.name)}</h3><div class="an-muted">Погрузка → прибытие · ${r.trips.length} ходок</div>${r.trips.slice().reverse().map(t=>`<div class="an-trip"><span>${esc(date(t.start))} ${esc(clock(t.start))} → ${esc(date(t.end))} ${esc(clock(t.end))}<br><span class="an-muted">${esc(t.objectName)}</span></span><b>${dur(t.ms)}</b></div>`).join('')||'<div class="an-empty">Нет завершённых ходок</div>'}</div>`;}
    details(openTruck);dashboard.querySelectorAll('[data-truck]').forEach(b=>b.onclick=()=>{openTruck=b.dataset.truck;details(openTruck);dashboard.querySelector('#an-truck-details').scrollIntoView({behavior:'smooth',block:'start'});});
  }
  window.renderAnalytics=function(){if(!enabled)return original.apply(this,arguments);render();};
  function apply(value){enabled=value;legacy.hidden=value;dashboard.hidden=!value;if(hasTabAccess('analytics'))window.renderAnalytics();}
  apply(true);
})();
