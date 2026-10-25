  // === УДЕРЖАНИЕ ===
  let holdTimer = null, vibInt = null;
  document.addEventListener('touchstart', e=>{ if(e.touches?.length) { touchStartY = e.touches[0].clientY; touchStartX = e.touches[0].clientX; isScrolling = false; } }, {passive:true});
  document.addEventListener('touchmove', e=>{ if(e.touches?.length) { if(Math.abs(e.touches[0].clientY - touchStartY) > 10 || Math.abs(e.touches[0].clientX - touchStartX) > 10) { isScrolling = true; let b=document.querySelector('.holding'); if(b) cancelHold(b); } } }, {passive:true});
  function cancelHold(b) { if(holdTimer) clearTimeout(holdTimer); if(vibInt) clearInterval(vibInt); if(b) b.classList.remove('holding'); }
  function startHold(e, type, id) {
    let action = type === 'load' ? 'action_load' : (type === 'arrive' ? 'action_arrive' : 'action_ttn');
    if (!requireEdit(action) || !state.shift?.isActive || state.shift.closing || state.shift.restoring || isScrolling) return;
    let b = e.currentTarget, hs = 0.5; if(type==='load') hs = settings.holdLoad??0.5; else if(type==='arrive') hs = settings.holdArrive??0.5; else hs = settings.holdTtn??0.5;
    let st = state.truckStatus[id]; if(!st) return;
    let lastL = st.lastLoadTimestamp||0, gap = (settings.cycleMinutes||15)*60000;
    if(type==='load' && st.loadedAfterArrive && !st.arriveStatus) { showToastEl('Погрузка уже отмечена: '+escapeHtml(st.lastLoadBy||'другой пользователь'),false); return; }
    if(type==='load' && lastL && (Date.now()-lastL)<gap) { appNotice('Не истекло время'); return; }
    if(type==='load' && !st.arriveStatus) { appNotice('Сначала Приехал'); return; }
    if(type==='arrive' && lastL && (Date.now()-lastL)<gap) { appNotice('Не истекло время'); return; }
    if(hs<=0) { executeAction(type, id); return; }
    b.style.setProperty('--hold-duration', hs+'s'); b.classList.add('holding');
    let haptic = type==='load'?settings.hapticLoad:(type==='arrive'?settings.hapticArrive:settings.hapticTtn);
    if(haptic) { vibrate(20); vibInt = setInterval(()=>vibrate(25), 120); }
    holdTimer = setTimeout(()=>{ if(!isScrolling) { cancelHold(b); executeAction(type, id); } else cancelHold(b); }, hs*1000);
  }
  function executeAction(type, id) { if(type==='arrive') { vibArrive(); toggleArrive(id); } else if(type==='load') { vibLoad(); performLoad(id); } else { vibTtn(); toggleTtn(id); } }
  function startArriveHold(e, id) { startHold(e, 'arrive', id); }
  function startQuickLoadHold(e, id) { startHold(e, 'load', id); }
  function startTtnHold(e, id) { startHold(e, 'ttn', id); }

  let shiftRestoreRetryInFlight=false;
  async function resumeShiftRestore(){
    if(shiftRestoreRetryInFlight||!requireEdit('archive_edit'))return;
    const shift=state.shift,uid=currentUid;
    if(!shift?.restoring||!shift.restoredFrom)return;
    shiftRestoreRetryInFlight=true;renderShiftLifecycle();
    try{
      let archive=state.archive.find(item=>item.id===shift.restoredFrom);
      if(!archive){
        const snapshot=await refs.archive.doc(shift.restoredFrom).get({source:'server'});
        if(currentUid!==uid||state.shift?.id!==shift.id||!state.shift?.restoring)return;
        if(!snapshot.exists)throw Error('Исходный архив не найден. Обновите страницу и проверьте архив смен.');
        archive={...snapshot.data(),id:shift.restoredFrom};
        state.archive=[...state.archive.filter(item=>item.id!==archive.id),archive];
      }
      if(currentUid!==uid||state.shift?.id!==shift.id||!state.shift?.restoring)return;
      if(hasTabAccess('archive'))openArchiveModal(archive.id);
      else viewingArchiveId=archive.id;
      await restoreArchiveToShift();
    }catch(error){showError('Не удалось продолжить восстановление: '+error.message);}
    finally{shiftRestoreRetryInFlight=false;renderShiftLifecycle();}
  }
  function renderShiftLifecycle(){
    const shift=state.shift,closing=!!shift?.closing,restoring=!!shift?.restoring;
    const active=!!shift?.isActive&&!closing&&!restoring,frozen=!!shift&&!active;
    const closeBusy=typeof closeShiftInFlight!=='undefined'&&closeShiftInFlight;
    const restoreBusy=shiftRestoreRetryInFlight||(typeof archiveRestoreInFlight!=='undefined'&&archiveRestoreInFlight);
    const sc=document.getElementById('startShiftContainer'),ac=document.getElementById('activeShiftContainer');
    const change=document.getElementById('changeObjBtn'),select=document.getElementById('selectTrucksBtn');
    const close=document.getElementById('closeShiftBtn'),start=document.getElementById('startShiftBtn');
    if(sc)sc.style.display=!shift&&hasPermission('start_shift')?'block':'none';
    if(ac)ac.style.display=shift?'block':'none';
    if(change){change.style.display=active&&hasPermission('edit_line')?'inline-block':'none';change.disabled=!active;}
    if(select){select.style.display=active&&hasPermission('edit_line')?'':'none';select.disabled=!active;}
    if(start)start.disabled=!!shift||(typeof startShiftInFlight!=='undefined'&&startShiftInFlight);
    if(close){
      close.style.display=(active||closing)&&hasPermission('close_shift')?'':'none';
      close.disabled=closeBusy||restoring||!shift;
      close.textContent=closeBusy?'⏳ Закрываем смену…':closing?'🔄 Продолжить закрытие':'🔄 Закрыть смену';
    }
    const trucks=document.getElementById('trucksLineList');if(trucks)trucks.hidden=frozen;
    let notice=document.getElementById('shiftLifecycleNotice');
    const container=document.getElementById('tab-line')?.parentElement;
    if(!notice&&container){
      notice=document.createElement('div');notice.id='shiftLifecycleNotice';notice.className='form-card';
      notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
      const title=document.createElement('b');title.id='shiftLifecycleTitle';
      const message=document.createElement('p');message.id='shiftLifecycleMessage';
      const retry=document.createElement('button');retry.id='shiftLifecycleRetry';retry.type='button';retry.className='btn btn-secondary btn-small';
      notice.append(title,message,retry);container.prepend(notice);
    }
    if(notice){
      notice.hidden=!frozen||!(hasTabAccess('line')||hasTabAccess('report')||hasTabAccess('archive'));
      if(frozen){
        const title=document.getElementById('shiftLifecycleTitle'),message=document.getElementById('shiftLifecycleMessage'),retry=document.getElementById('shiftLifecycleRetry');
        const busy=closing?closeBusy:restoreBusy,allowed=closing?hasPermission('close_shift'):restoring&&hasPermission('archive_edit');
        title.textContent=closing?(busy?'Закрываем смену…':'Закрытие смены не завершено'):restoring?(busy?'Восстанавливаем смену…':'Восстановление смены не завершено'):'Смена недоступна для отметок';
        message.textContent=closing?'Новые отметки недоступны до завершения закрытия.':restoring?'Исходный архив сохранён. Новые отметки станут доступны после восстановления.':'Обновите страницу, чтобы проверить состояние смены.';
        if(!allowed&&(closing||restoring))message.textContent+=' Продолжить операцию может сотрудник с соответствующим доступом.';
        retry.hidden=!allowed;retry.style.display=allowed?'':'none';retry.disabled=busy||!allowed;retry.textContent=closing?'Продолжить закрытие':'Продолжить восстановление';
        retry.onclick=closing?()=>closeShift():()=>resumeShiftRestore();
        cancelHold(document.querySelector('.holding'));
      }
    }
    const archiveButton=document.getElementById('archiveRestoreBtn');
    if(archiveButton&&restoring&&viewingArchiveId===shift.restoredFrom){
      archiveButton.disabled=restoreBusy;archiveButton.textContent=restoreBusy?'⏳ Восстанавливаем смену…':'♻️ Продолжить восстановление';
    }
    return frozen;
  }

  function renderLine() {
    if(renderShiftLifecycle())return;
    let sc = document.getElementById('startShiftContainer'), ac = document.getElementById('activeShiftContainer'), cb = document.getElementById('changeObjBtn');
    if (!state.shift) { sc.style.display = hasPermission('start_shift') ? 'block' : 'none'; ac.style.display = 'none'; cb.style.display = 'none'; return; }
    sc.style.display = 'none'; ac.style.display = 'block'; cb.style.display = hasPermission('edit_line') ? 'inline-block' : 'none';
    let c = document.getElementById('trucksLineList'), oldP = {};
    c.querySelectorAll('.truck-card[data-truck-id]').forEach(x => oldP[x.dataset.truckId] = x.getBoundingClientRect().top);
    let ids = getActiveLineIds(); if (!ids.length) { c.innerHTML = '<div class="form-card" style="text-align:center;color:var(--muted);">Нет машин</div>'; return; }
    let logs = getLogs(), lastTs = {}; logs.forEach(l => { if (lastTs[l.truckId] === undefined) lastTs[l.truckId] = l.timestamp||0; });
    let trucks = ids.map(id => findTruck(id)).filter(Boolean);
    trucks.sort((a,b)=>{ let sA=state.truckStatus[a.id], sB=state.truckStatus[b.id]; let tA=sA.ttnStatus===true?1:0, tB=sB.ttnStatus===true?1:0; if(tA!==tB) return tA-tB; let aA=sA.arriveStatus?1:0, aB=sB.arriveStatus?1:0; if(aA!==aB) return aB-aA; let lA=lastTs[a.id]||0, lB=lastTs[b.id]||0; if(lA===0&&lB===0) return 0; if(lA===0) return -1; if(lB===0) return 1; return lA-lB; });
    let now = Date.now(), cyc = (settings.cycleMinutes||15)*60000;
    let canEditArrive = hasPermission('action_arrive'), canEditLoad = hasPermission('action_load'), canEditTtn = hasPermission('action_ttn'); let showStats = hasPermission('view_card_stats');
    c.innerHTML = trucks.map(t => {
      let st = state.truckStatus[t.id]||{}; let offlineFlag=offlinePendingForTruck(t.id); let tLogs = logs.filter(l=>l.truckId===t.id), sum = tLogs.reduce((s,l)=>s+l.volume,0);
      let isA = !!st.arriveStatus, lastL = st.lastLoadTimestamp||0, inC = lastL > 0 && (now-lastL)<cyc; let ttn = st.ttnStatus, faded = ttn===true; let lTs = tLogs.length ? tLogs[0].timestamp||0 : 0; let isGAI = !!t.isGAI;
      let arrBtn;
      if (inC) arrBtn = `<button class="btn btn-arrive" disabled><span style="display:flex;flex-direction:column;align-items:center;line-height:1.1;"><span class="idle-label">Ходка</span><span class="cooldown-timer" style="font-size:15px;" data-load-ts="${lastL}">${formatIdleDuration(cyc-(now-lastL))}</span></span></button>`;
      else if (isA) arrBtn = `<button class="btn btn-arrive active-arrive" ${canEditArrive?`onpointerdown="startArriveHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''} ${!canEditArrive?'disabled':''}><span style="display:flex;flex-direction:column;align-items:center;line-height:1.1;"><span class="idle-label">Простой</span><span class="idle-timer" data-since="${st.arriveTimestamp||now}">${formatIdleDuration(now-(st.arriveTimestamp||now))}</span></span></button>`;
      else arrBtn = `<button class="btn btn-arrive" ${canEditArrive?`onpointerdown="startArriveHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''} ${!canEditArrive?'disabled':''}>🚛 Приехал</button>`;
      let ttnTxt = ttn ? '📄 Забрал ТТН ✓' : '📄 Забрать ТТН';
      let statsHtml = showStats ? (isGAI ? `<div class="truck-summary">Рейсов: <b>${tLogs.length}</b></div>` : `<div class="truck-summary">Рейсов: <b>${tLogs.length}</b> | <b>${sum} м³</b></div>`) : '';
      let loadBtnTxt = isGAI ? '⚡ Погрузка' : '⚡ Погрузка (+' + t.defaultVol + 'м³)';
      return `<div class="truck-card ${isA?'arrived':''} ${faded?'faded':''}" data-truck-id="${t.id}"><div class="truck-header"><div class="truck-name" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><b>${escapeHtml(t.brand)}</b>${renderRussianPlate(t.number)}<span style="font-size:13px;color:var(--muted);">${isGAI?'': '('+t.defaultVol+' м³)'}</span>${isA?`<span style="color:#f59e0b;font-size:12px;">(${escapeHtml(st.arriveBy||'')})</span>`:''}${offlineFlag?`<span style="font-size:10px;font-weight:700;color:#f59e0b;">☁️ ОФЛАЙН</span>`:''}</div>${statsHtml}</div><div class="last-load-info">⏱ Последняя: <b class="time-ago-card" data-timestamp="${lTs}">${lTs>0?formatTimeAgo(lTs):'—'}</b></div><div class="action-row">${arrBtn}<button class="btn btn-quick" ${!canEditLoad||!isA?'disabled':''} ${canEditLoad&&isA?`onpointerdown="startQuickLoadHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''}>${loadBtnTxt}</button><button class="btn btn-ttn ${ttn?'active-ttn':''}" ${!canEditTtn?'disabled':''} ${canEditTtn?`onpointerdown="startTtnHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''}>${ttnTxt}</button></div></div>`;
    }).join('');
    if (Object.keys(oldP).length) {
      c.querySelectorAll('.truck-card').forEach(card => { let old = oldP[card.dataset.truckId]; if(old === undefined) return; let delta = old - card.getBoundingClientRect().top;
        if(Math.abs(delta) > 2) { card.style.transform=`translateY(${delta}px)`; card.style.transition='none'; void card.offsetWidth; setTimeout(()=>{ requestAnimationFrame(()=>{ card.style.transition='transform 2.4s cubic-bezier(0.4,0,0.2,1)'; card.style.transform=''; setTimeout(()=>card.style.transition='', 2450); }); }, 1000); }
      });
    }
  }

  function renderHeaderStats() {
    renderShiftLifecycle();
    let d = state.shift ? `Смена от ${state.shift.startDate}` : 'Смена не начата'; let o = state.shift ? state.shift.objectName : 'Не выбран';
    if(state.shift?.closing)d='Закрытие смены · '+(state.shift.startDate||'');
    else if(state.shift?.restoring)d='Восстановление смены · '+(state.shift.startDate||'');
    let act = state.shift ? getActiveLineIds().filter(id => { let t = findTruck(id); if (!t || t.isGAI) return false; return !state.truckStatus[id] || state.truckStatus[id].ttnStatus !== true; }).length : 0;
    let logs = getLogs(); let stdLogs = logs.filter(l => !l.isGAI); let v = stdLogs.reduce((s,l)=>s+l.volume,0);
    document.getElementById('shiftDate').textContent = d; document.getElementById('headerObject').textContent = 'Объект: ' + o;
    document.getElementById('activeLineCount').textContent = act + ' маш.'; document.getElementById('totalTrips').textContent = stdLogs.length; document.getElementById('totalVolume').textContent = v + ' м³';
  }

  function tickTimers() {
    let now = Date.now(), cyc = (settings.cycleMinutes||15)*60000;
    document.querySelectorAll('.idle-timer').forEach(e=>{ let s=parseInt(e.getAttribute('data-since')); if(s) e.textContent=formatIdleDuration(now-s); });
    document.querySelectorAll('.load-age-card').forEach(el=>{el.textContent=formatLoadAge(el.dataset.timestamp);});
    document.querySelectorAll('.time-ago-card').forEach(e=>{ let t=parseInt(e.getAttribute('data-timestamp')); if(t) e.textContent=formatTimeAgo(t); });
    document.querySelectorAll('.cooldown-timer').forEach(e=>{ let l=parseInt(e.getAttribute('data-load-ts')); if(l) { let r=cyc-(now-l); if(r<=0) scheduleRenderLine(); else e.textContent=formatIdleDuration(r); } });
    let ticker = document.getElementById('tickerTimeAgo'); if(ticker) { let t=parseInt(ticker.getAttribute('data-timestamp')); if(t) ticker.textContent=formatTimeAgo(t); }
  }
  setInterval(tickTimers, 1000);

