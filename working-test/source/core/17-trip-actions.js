  // Офлайн-очередь принимает только обычные line-команды выбранной смены.
  // Принудительный перевод и завершение detached trip — online-only (§9):
  // их cross-shift CAS нельзя подтвердить из очереди, поэтому офлайн-попытка
  // остаётся read-only с причиной и ничего не ставит в очередь.
  function queueLineCommand(type,id,intent){
    if(offlineIsOnlineOnlyCommand(type)){showError(offlineReasonLabel('online-only-command'));return false;}
    if(!state.shift||!intent||intent.shiftId!==state.shift.id)return false;
    return offlineQueueAction(type,id,intent);
  }
  async function performLoad(id,capturedIntent){
    if(!requireEdit('action_load')||loadInFlight[id]||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=capturedIntent||captureLineIntent(id);
    if(!intent)return {outcome:'ignored'};
    return {outcome:queueLineCommand('load',id,intent)?'queued':'failed'};
  }
  async function toggleArrive(id,capturedIntent){
    if(!requireEdit('action_arrive')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=capturedIntent||captureLineIntent(id);
    if(!intent)return {outcome:'ignored'};
    return {outcome:queueLineCommand('arrive',id,intent)?'queued':'failed'};
  }
  async function toggleTtn(id,capturedIntent){
    if(!requireEdit('action_ttn')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=capturedIntent||captureLineIntent(id);
    if(!intent)return {outcome:'ignored'};
    return {outcome:queueLineCommand('ttn',id,intent)?'queued':'failed'};
  }

  // === УДЕРЖАНИЕ ===
  let holdTimer = null, vibInt = null;
  document.addEventListener('touchstart', e=>{ if(e.touches?.length) { touchStartY = e.touches[0].clientY; touchStartX = e.touches[0].clientX; isScrolling = false; } }, {passive:true});
  document.addEventListener('touchmove', e=>{ if(e.touches?.length) { if(Math.abs(e.touches[0].clientY - touchStartY) > 10 || Math.abs(e.touches[0].clientX - touchStartX) > 10) { isScrolling = true; let b=document.querySelector('.holding'); if(b) cancelHold(b); } } }, {passive:true});
  function cancelHold(b) { if(holdTimer) clearTimeout(holdTimer); if(vibInt) clearInterval(vibInt); if(b) b.classList.remove('holding'); }
  function startHold(e, type, id) {
    let action = type === 'load' ? 'action_load' : (type === 'arrive' ? 'action_arrive' : 'action_ttn');
    if (!requireEdit(action) || !state.shift || isScrolling) return;
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

