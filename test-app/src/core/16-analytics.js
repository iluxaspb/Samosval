  const TEST_GAME_MODE_KEY='samosval_test_game_mode_visible_v1';
  function testGameModeVisible(){
    try{return localStorage.getItem(TEST_GAME_MODE_KEY)==='1';}catch(e){return false;}
  }
  function toggleTestGameMode(visible){
    if(!canAdmin())return;
    try{localStorage.setItem(TEST_GAME_MODE_KEY,visible?'1':'0');}
    catch(e){showError('Не удалось сохранить настройку на этом устройстве');return;}
    renderAnalytics();
  }
  function renderAnalytics() {
    if (!hasTabAccess('analytics')) return; // === SECURITY ===
    let c = document.getElementById('auditLogContainer'); if(!c) return;
    c.innerHTML = renderAuditEntries();
    const controls=document.getElementById('testGameModeControls');
    const details=document.getElementById('testActivityCoinsDetails');
    const visible=testGameModeVisible();
    if(controls)controls.style.display='none';
    const checkbox=document.getElementById('testGameModeEnabled');
    if(checkbox)checkbox.checked=visible;
    if(details)details.hidden=true;
    const host=document.getElementById('userActivityRanking');
    if(host) {
      const records=Array.isArray(state.audit)?state.audit:[];
      const unique=new Set(),users=new Map(),gameEvents=[];
      for(const event of records){
        if(!event || !event.id || unique.has(event.id))continue;
        unique.add(event.id);
        const type=String(event.eventType||event.type||'').toLowerCase();
        const arrive=/^(arrive|arrival|truck_arrive)$/.test(type);
        const load=/^(load|loading|truck_load)$/.test(type);
        if(!arrive && !load)continue;
        gameEvents.push({type,arrive,load,at:Number(event.timestamp||0),shiftId:String(event.shiftId||''),truckId:String(event.truckId||''),user:String(event.userEmail||event.createdByEmail||event.uid||'').trim(),id:event.id});
        const key=String(event.userEmail||event.createdByEmail||event.uid||'').trim();
        if(!key)continue;
        const row=users.get(key)||{name:resolveUserDisplayName(key,event.userName)||key,arrivals:0,loads:0};
        if(arrive)row.arrivals++;else row.loads++;
        users.set(key,row);
      }
      const sorted=[...users.values()].sort((a,b)=>(b.arrivals+b.loads)-(a.arrivals+a.loads)||a.name.localeCompare(b.name,'ru'));
      const gameHost=document.getElementById('testActivityCoins');
      if(gameHost){
        const loaded=new Set(),points=new Map();
        for(const event of gameEvents.sort((a,b)=>a.at-b.at||String(a.id).localeCompare(String(b.id)))){
          if(!event.shiftId||!event.truckId||!event.user)continue;
          const key=event.shiftId+'|'+event.truckId;
          const value=event.load?1:(loaded.has(key)?2:0);
          if(value)points.set(event.user,(points.get(event.user)||0)+value);
          if(event.load)loaded.add(key);
        }
        const board=[...points.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ru'));
        gameHost.innerHTML='<p style="font-size:12px;color:var(--muted)">Пробный расчёт по последним '+records.length+' загруженным записям: погрузка — 1, возвращение после погрузки — 2, первый приезд — 0. История может быть неполной, отмены и штрафы пока не учтены. Очки не сохраняются в базу.</p>'
        +(board.length?'<ol style="padding-left:24px;margin-top:8px">'+board.map(([email,coins])=>'<li>'+escapeHtml(resolveUserDisplayName(email,email))+' — <b>'+coins+'</b> 🪙</li>').join('')+'</ol>':'<p>Нет подходящих событий для расчёта.</p>');
      }
      host.innerHTML='<p style="font-size:12px;color:var(--muted);margin-bottom:8px">На основе последних '+records.length+' событий аудита; не полный рейтинг за всё время.</p>'
        +(sorted.length?'<div style="overflow-x:auto"><table class="paper-table" style="width:100%"><thead><tr><th>Пользователь</th><th>Приезды</th><th>Погрузки</th><th>Всего</th></tr></thead><tbody>'+sorted.map(row=>'<tr><td>'+escapeHtml(row.name)+'</td><td>'+row.arrivals+'</td><td>'+row.loads+'</td><td><b>'+(row.arrivals+row.loads)+'</b></td></tr>').join('')+'</tbody></table></div>':'<div class="empty-state">Нет распознанных событий приезда или погрузки в загруженном аудите</div>');
    }
  }
