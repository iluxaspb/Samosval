  // Явный реестр хуков Линии вместо подмен window.renderLine из фич.
  // Все модули канала выполняются в общем глобальном скоупе, поэтому фичи
  // вызывают registerLineHook напрямую. Хук оборачивает ТЕКУЩИЙ
  // window.renderLine (включая анимационную версию из anim-speeds), так что
  // порядок эффектов задаётся порядком регистрации и совпадает с прежними
  // вложенными обёртками: line-motion-test → offline-feedback → anim-speeds.
  // before и after одной регистрации делят общий объект ctx: before может
  // положить туда состояние, after — прочитать (в т.ч. ctx.error).
  const registeredLineHooks = [];
  function registerLineHook(phaseOrSpec, maybeFn) {
    const spec = (typeof phaseOrSpec === 'object' && phaseOrSpec !== null)
      ? phaseOrSpec
      : { [phaseOrSpec]: maybeFn };
    if (typeof spec.before !== 'function' && typeof spec.after !== 'function') return () => {};
    const original = window.renderLine;
    const entry = { spec, original, wrapped: null };
    entry.wrapped = function () {
      const ctx = {};
      if (typeof spec.before === 'function') {
        try { spec.before(ctx); } catch (e) { console.error('[line-hook:before]', e); }
      }
      let result, failed = false;
      try { result = original.apply(this, arguments); }
      catch (e) { ctx.error = e; failed = true; }
      ctx.result = result;
      if (typeof spec.after === 'function') {
        try { spec.after(ctx); } catch (e) { console.error('[line-hook:after]', e); }
      }
      if (failed) throw ctx.error;
      return result;
    };
    registeredLineHooks.push(entry);
    window.renderLine = entry.wrapped;
    return () => {
      const i = registeredLineHooks.indexOf(entry);
      if (i < 0) return;
      registeredLineHooks.splice(i, 1);
      if (window.renderLine === entry.wrapped) window.renderLine = entry.original;
    };
  }
  // === П4: заморозка пересборки линии при удержании/касании ===
  // Карточки линии пересобираются через innerHTML; событие другого оператора
  // могло уничтожить кнопку прямо во время удержания (holdTimer из core/17
  // применяется к верному id, но кнопка «уезжала» из-под пальца). Пока идёт
  // удержание (кнопка .holding) или касание контейнера линии (pointerdown до
  // pointerup/cancel + грейс ~400 мс), перерисовка откладывается: расписание
  // renderLine (scheduleRenderLine в core/04) при активном флаге только
  // запоминает долг, а после снятия флага вызывает __lineFlushDeferred —
  // ни одно чужое действие не теряется, перерисовка выполняется позже.
  const LINE_HOLD_GRACE_MS = 400;
  let linePointerDown = false, linePointerGraceTimer = null;
  function lineHoldActive() {
    const holding = (typeof document.querySelector === 'function') ? !!document.querySelector('.holding') : false;
    return holding || linePointerDown || linePointerGraceTimer !== null;
  }
  window.__lineHoldActive = lineHoldActive;
  function linePointerEnd() {
    if (!linePointerDown) return;
    linePointerDown = false;
    clearTimeout(linePointerGraceTimer);
    linePointerGraceTimer = setTimeout(() => {
      linePointerGraceTimer = null;
      if (!lineHoldActive() && typeof window.__lineFlushDeferred === 'function') window.__lineFlushDeferred();
    }, LINE_HOLD_GRACE_MS);
  }
  // Регистрация слушателей вынесена за пределы vm-моков юнит-тестов
  // (truck-phone-line.test.mjs исполняет этот файл без document.addEventListener).
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('pointerdown', e => {
      const t = e.target;
      if (t && typeof t.closest === 'function' && t.closest('#trucksLineList')) {
        linePointerDown = true;
        clearTimeout(linePointerGraceTimer);
        linePointerGraceTimer = null;
      }
    }, true);
    document.addEventListener('pointerup', linePointerEnd, true);
    document.addEventListener('pointercancel', linePointerEnd, true);
  }

  // Ключ последнего отрисованного порядка карточек: FLIP-анимация сдвига
  // нужна только когда порядок реально изменился.
  let renderLineOrderKey = null;
  // Ключ значимых данных последней отрисовки линии (страховка от лишних
  // пересборок карточек при неизменном снапшоте).
  let renderLineDataKey = null;
  function renderLine() {
    let sc = document.getElementById('startShiftContainer'), ac = document.getElementById('activeShiftContainer'), cb = document.getElementById('changeObjBtn');
    if (!state.shift) { sc.style.display = (hasPermission('start_shift') || hasTabAccess('timesheet')) ? 'block' : 'none'; ac.style.display = 'none'; cb.style.display = 'none'; return; }
    sc.style.display = 'none'; ac.style.display = 'block'; cb.style.display = hasPermission('edit_line') ? 'inline-block' : 'none';
    let c = document.getElementById('trucksLineList'), oldP = {};
    c.querySelectorAll('.truck-card[data-truck-id]').forEach(x => oldP[x.dataset.truckId] = x.getBoundingClientRect().top);
    let ids = getActiveLineIds(); if (!ids.length) { c.innerHTML = '<div class="form-card" style="text-align:center;color:var(--muted);">Нет машин</div>'; return; }
    let logs = getLogs(), lastTs = {}; logs.forEach(l => { if (lastTs[l.truckId] === undefined) lastTs[l.truckId] = l.timestamp||0; });
    let trucks = ids.map(id => findTruck(id)).filter(Boolean);
    trucks.sort((a,b)=>{ let sA=state.truckStatus[a.id], sB=state.truckStatus[b.id]; let nA=sA.noReturn===true?1:0, nB=sB.noReturn===true?1:0; if(nA!==nB) return nA-nB; let tA=sA.ttnStatus===true?1:0, tB=sB.ttnStatus===true?1:0; if(tA!==tB) return tA-tB; let aA=sA.arriveStatus?1:0, aB=sB.arriveStatus?1:0; if(aA!==aB) return aB-aA; let lA=lastTs[a.id]||0, lB=lastTs[b.id]||0; if(lA===0&&lB===0) return 0; if(lA===0) return -1; if(lB===0) return 1; return lA-lB; });
    let now = Date.now(), cyc = (settings.cycleMinutes||15)*60000;
    let canEditArrive = hasPermission('action_arrive'), canEditLoad = hasPermission('action_load'), canEditTtn = hasPermission('action_ttn'), canEditNoReturn = hasPermission('action_no_return'); let showStats = hasPermission('view_card_stats');
    // Страховка: если значимые для разметки данные не изменились, карточки не
    // пересобираются вообще. Таймеры внутри карточек обновляет tickTimers.
    let stats = {}; logs.forEach(l => { stats[l.truckId] = stats[l.truckId] || { n: 0, v: 0, ts: 0 }; stats[l.truckId].n++; stats[l.truckId].v += l.volume; if ((l.timestamp||0) > stats[l.truckId].ts) stats[l.truckId].ts = l.timestamp||0; });
    let renderKey = JSON.stringify([trucks.map(t => { let st = state.truckStatus[t.id]||{}; let lastL = st.lastLoadTimestamp||0; let s = stats[t.id]||{n:0,v:0,ts:0};
      return [t.id, t.brand, t.number, t.defaultVol, !!t.isGAI, !!st.arriveStatus, st.arriveTimestamp||0, st.arriveBy||'', lastL, lastL > 0 && (now-lastL) < cyc, st.ttnStatus===true, st.noReturn===true, s.n, s.v, s.ts, offlinePendingForTruck(t.id)]; }),
      canEditArrive, canEditLoad, canEditTtn, canEditNoReturn, showStats, typeof truckPhoneEntry==='function' ? trucks.map(t=>truckPhoneEntry(t.id)) : null]);
    if (renderKey === renderLineDataKey) return;
    renderLineDataKey = renderKey;
    // Порядок карточек не изменился — пересортировка FLIP не нужна: таймеры
    // ходки пересортировывают список каждый рендер, и анимация сдвига
    // запускалась даже когда карточки остались на своих местах.
    const orderKey = trucks.map(t => t.id).join('|');
    const flipNeeded = renderLineOrderKey === null || renderLineOrderKey !== orderKey;
    renderLineOrderKey = orderKey;
    c.innerHTML = trucks.map(t => {
      let st = state.truckStatus[t.id]||{}; let offlineFlag=offlinePendingForTruck(t.id); let tLogs = logs.filter(l=>l.truckId===t.id), sum = tLogs.reduce((s,l)=>s+l.volume,0);
      let isA = !!st.arriveStatus, lastL = st.lastLoadTimestamp||0, inC = lastL > 0 && (now-lastL)<cyc; let ttn = st.ttnStatus, absent = st.noReturn===true, faded = ttn===true || absent; let lTs = tLogs.length ? tLogs[0].timestamp||0 : 0; let isGAI = !!t.isGAI;
      let arrBtn;
      // «Больше не приедет» снимается только кнопкой «Приехал»: кулдаун ходки не
      // должен запирать машину в этом статусе.
      if (inC && !absent) arrBtn = `<button class="btn btn-arrive" disabled><span style="display:flex;flex-direction:column;align-items:center;line-height:1.1;"><span class="idle-label">Ходка</span><span class="cooldown-timer" style="font-size:15px;" data-load-ts="${lastL}">${formatIdleDuration(cyc-(now-lastL))}</span></span></button>`;
      else if (isA) arrBtn = `<button class="btn btn-arrive active-arrive" ${canEditArrive?`onpointerdown="startArriveHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''} ${!canEditArrive?'disabled':''}><span style="display:flex;flex-direction:column;align-items:center;line-height:1.1;"><span class="idle-label">Простой</span><span class="idle-timer" data-since="${st.arriveTimestamp||now}">${formatIdleDuration(now-(st.arriveTimestamp||now))}</span></span></button>`;
      else arrBtn = `<button class="btn btn-arrive" ${canEditArrive?`onpointerdown="startArriveHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''} ${!canEditArrive?'disabled':''}>🚛 Приехал</button>`;
      // Значок листка без слова: кнопка узкая, а смысл держат цвет и подсказка
      // для экранного диктора. Собранная ТТН — зелёная кнопка (active-ttn).
      let ttnTxt = '<span aria-hidden="true">📄</span>', ttnAria = ttn ? 'ТТН забрана' : 'Забрать ТТН';
      let statsHtml = showStats ? (isGAI ? `<div class="truck-summary">Рейсов: <b>${tLogs.length}</b></div>` : `<div class="truck-summary">Рейсов: <b>${tLogs.length}</b> | <b>${sum} м³</b></div>`) : '';
      let loadBtnTxt = isGAI ? '⚡ Погрузка' : '⚡ Погрузка (+' + t.defaultVol + 'м³)';
      return `<div class="truck-card ${isA?'arrived':''} ${faded?'faded':''}" data-truck-id="${t.id}"><div class="truck-header"><div class="truck-name" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><b>${escapeHtml(t.brand)}</b>${renderRussianPlate(t.number)}<span style="font-size:13px;color:var(--muted);">${isGAI?'': '('+t.defaultVol+' м³)'}</span>${isA?`<span style="color:#f59e0b;font-size:12px;">(${escapeHtml(st.arriveBy||'')})</span>`:''}${absent?'<span class="absent-mark">Больше не приедет</span>':''}${offlineFlag?`<span style="font-size:10px;font-weight:700;color:#f59e0b;">☁️ ОФЛАЙН</span>`:''}</div>${truckPhoneIcon(t)}${statsHtml}</div><div class="last-load-info">⏱ Последняя: <b class="time-ago-card" data-timestamp="${lTs}">${lTs>0?formatTimeAgo(lTs):'—'}</b></div><div class="action-row">${arrBtn}<button class="btn btn-quick" ${!canEditLoad||!isA?'disabled':''} ${canEditLoad&&isA?`onpointerdown="startQuickLoadHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''}>${loadBtnTxt}</button><button class="btn btn-ttn ${ttn?'active-ttn':''}" aria-label="${ttnAria}" ${!canEditTtn||absent?'disabled':''} ${canEditTtn&&!absent?`onpointerdown="startTtnHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''}>${ttnTxt}</button><button class="btn btn-no-return" aria-label="Самосвал больше не приедет" ${!canEditNoReturn||absent?'disabled':''} ${canEditNoReturn&&!absent?`onpointerdown="startNoReturnHold(event, '${t.id}')" onpointerup="cancelHold(this)"`:''}><span aria-hidden="true">🚫</span></button></div></div>`;
    }).join('');
    if (flipNeeded && Object.keys(oldP).length) {
      c.querySelectorAll('.truck-card').forEach(card => { let old = oldP[card.dataset.truckId]; if(old === undefined) return; let delta = old - card.getBoundingClientRect().top;
        if(Math.abs(delta) > 2) { card.style.transform=`translateY(${delta}px)`; card.style.transition='none'; void card.offsetWidth; setTimeout(()=>{ requestAnimationFrame(()=>{ card.style.transition='transform 2.4s cubic-bezier(0.4,0,0.2,1)'; card.style.transform=''; setTimeout(()=>card.style.transition='', 2450); }); }, 1000); }
      });
    }
  }

  window.addEventListener('working-test-tabel-v2-records-change', () => scheduleRender('renderHeaderStats'));
  // Шапка всегда показывает объект, календарную дату и тип выбранной смены
  // (design §10.1). v1 хранит дату в startDate, v2 — в workDate (ГГГГ-ММ-ДД);
  // тип приходит только от смены, а не выводится из времени.
  const SHIFT_TYPE_HEADER = { day: 'День', night: 'Ночь' };
  function shiftHeaderText() {
    if (!state.shift) return 'Смена не начата';
    const raw = String(state.shift.workDate || state.shift.startDate || '');
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const date = iso ? iso[3] + '.' + iso[2] + '.' + iso[1] : raw;
    // v1 line snapshot хранит тот же факт как workShift/type, v2-документ — как
    // shiftType. Без алиасов тип пропадал из шапки после любого v1-обновления,
    // хотя сама смена не менялась.
    const type = SHIFT_TYPE_HEADER[state.shift.shiftType || state.shift.workShift || state.shift.type] || '';
    return ['Смена от ' + (date || '—'), type].filter(Boolean).join(' · ');
  }
  function renderHeaderStats() {
    window.dispatchEvent(new Event('line-equipment-change'));
    let d = shiftHeaderText(); let o = state.shift ? objectTitle(state.shift.objectId,state.shift.objectName) : 'Не выбран';
    let act = state.shift ? getActiveLineIds().filter(id => { let t = findTruck(id); if (!t || t.isGAI) return false; return !state.truckStatus[id] || state.truckStatus[id].ttnStatus !== true; }).length : 0;
    let logs = getLogs(); let stdLogs = logs.filter(l => !l.isGAI); let v = stdLogs.reduce((s,l)=>s+l.volume,0);
    document.getElementById('shiftDate').textContent = d; document.getElementById('headerObject').textContent = 'Объект: ' + o;
    document.getElementById('activeLineCount').textContent = act + ' маш.'; document.getElementById('totalTrips').textContent = stdLogs.length; document.getElementById('totalVolume').textContent = v + ' м³';
    const tabelCounts=document.getElementById('tabelV2Counts');if(tabelCounts&&permissionsLoaded&&hasTabAccess('timesheet'))import(new URL('./working-test/tabel-v2/summary.mjs',document.baseURI).href).then(m=>m.updateHeader(isNasRuntime()?nasTabelHost():{session:()=>({projectId:firebaseConfig.projectId,workspaceId:WORKSPACE_ID,uid:currentUid,role:currentUserRole,active:currentUserStatus==='active',view:hasTabAccess('timesheet')}),snapshot:()=>({shift:state.shift,trucks:state.trucks,statuses:state.truckStatus,logs:state.logs,audit:state.audit,lineAudit:state.lineAudit,archive:state.archive})},tabelCounts)).catch(()=>{tabelCounts.hidden=true;});else if(tabelCounts)tabelCounts.hidden=true;
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

  // === БАЗА САМОСВАЛОВ И ОБЪЕКТОВ ===
  // Единая точка ветвления транспорта сохранения: в рабочей версии все
  // записи идут через сервер Ubuntu (nasProvider всегда 'ubuntu'), поэтому
  // firebase-ветки из функций сохранения удалены — ветвление живёт здесь.
  async function saveLineEvent(nasWork) {
    if (!isNasRuntime()) throw Error('Сохранение доступно только через сервер Ubuntu');
    return nasWork();
  }
  async function saveTruckToGlobalBase() {
    if (!requireEdit('manage_trucks')) return;
    let id = document.getElementById('editTruckId').value;
    let brand = document.getElementById('newTruckBrand').value.trim();
    let num = document.getElementById('newTruckNumber').value.trim();
    let vol = parseFloat(document.getElementById('newTruckVol').value);
    let type = document.getElementById('newTruckType').value;
    let isGAI = type === 'gai';
    if (!brand || !num) { appNotice('Заполните марку и госномер'); return; }
    if (!isGAI && (isNaN(vol) || vol <= 0)) { appNotice('Укажите объем'); return; }
    try {
      const editedId = id;
      await saveLineEvent(()=>nasSaveRecord('truck',id,{brand,number:num,defaultVol:isGAI?0:vol,isGAI},Number(document.getElementById('editTruckId').dataset.nasRevision)));
      await saveTruckPhoneFromBase(editedId);
      cancelEditTruck();
    } catch(e) { showError(e.message); }
  }
  // Телефон и имя водителя сохраняются отдельной записью: сбой телефона не отменяет
  // сохранение самого самосвала. Пустое поле телефона = «телефон не менять».
  async function saveTruckPhoneFromBase(id) {
    if(!id || !hasPermission('view_truck_phone') || !hasPermission('add_truck_phone')) return;
    // Телефон живёт только на Ubuntu-бэкенде: в firebase-режиме поля не сохраняем.
    if(typeof isNasRuntime === 'function' && !isNasRuntime()) return;
    const field = document.getElementById('newTruckPhone'); if(!field) return;
    if(!String(field.value||'').trim()) return;
    const phone = truckPhoneNormalizeInput(field.value);
    if(!phone) { appNotice('Телефон не сохранён: нужен номер с плюсом и 8–15 цифрами'); return; }
    const nameField = document.getElementById('newTruckDriver');
    const driverName = truckPhoneCleanName(nameField ? nameField.value : '');
    if(driverName === undefined) { appNotice('Телефон не сохранён: в имени допустимы буквы, цифры, пробел, точка, дефис, апостроф (до 80)'); return; }
    try { await truckPhoneRequest({ truckId:id, phone, driverName }); }
    catch(e) { showError('Телефон не сохранён: ' + (e && e.message ? e.message : 'ошибка')); }
  }
  function fillTruckPhoneFields(id) {
    const phoneGroup = document.getElementById('truckPhoneGroup'), driverGroup = document.getElementById('truckDriverGroup');
    const phoneField = document.getElementById('newTruckPhone'), driverField = document.getElementById('newTruckDriver');
    if(!phoneGroup || !driverGroup || !phoneField || !driverField) return;
    const canView = hasPermission('view_truck_phone'), canEdit = canView && hasPermission('add_truck_phone');
    const entry = canView ? truckPhoneEntry(id) : null;
    phoneGroup.style.display = canView ? 'block' : 'none';
    driverGroup.style.display = canView ? 'block' : 'none';
    phoneField.value = entry && entry.phone ? entry.phone : '';
    driverField.value = entry && entry.driverName ? entry.driverName : '';
    phoneField.disabled = !canEdit; phoneField.readOnly = !canEdit;
    driverField.disabled = !canEdit; driverField.readOnly = !canEdit;
  }
  function editGlobalTruck(id) {
    if(!requireEdit('manage_trucks')) return; let t=findTruck(id); if(!t) return;
    document.getElementById('editTruckId').dataset.nasRevision=String(nasRecordRevision('truck',id)||'');document.getElementById('editTruckId').value=t.id; document.getElementById('newTruckType').value=t.isGAI?'gai':'regular';
    document.getElementById('newTruckBrand').value=t.brand; document.getElementById('newTruckNumber').value=t.number; document.getElementById('newTruckVol').value=t.defaultVol||'';
    document.getElementById('formCardTitle').textContent='Редактировать'; document.getElementById('saveTruckBtn').textContent='💾 Сохранить'; document.getElementById('cancelEditBtn').style.display='block'; window.scrollTo(0,0); toggleVolInput();
    fillTruckPhoneFields(t.id);
    if(hasPermission('view_truck_phone')&&!truckPhoneEntry(t.id))truckPhoneRequest().then(()=>{if(document.getElementById('editTruckId').value===t.id)fillTruckPhoneFields(t.id);}).catch(()=>{});
  }
  function cancelEditTruck() {
    document.getElementById('editTruckId').value=''; document.getElementById('newTruckType').value='regular'; document.getElementById('newTruckBrand').value=''; document.getElementById('newTruckNumber').value=''; document.getElementById('newTruckVol').value='';
    const phoneGroup=document.getElementById('truckPhoneGroup'),driverGroup=document.getElementById('truckDriverGroup'),phoneField=document.getElementById('newTruckPhone'),driverField=document.getElementById('newTruckDriver');
    if(phoneGroup)phoneGroup.style.display='none'; if(driverGroup)driverGroup.style.display='none';
    if(phoneField){phoneField.value='';phoneField.disabled=true;phoneField.readOnly=true;} if(driverField){driverField.value='';driverField.disabled=true;driverField.readOnly=true;}
    document.getElementById('formCardTitle').textContent='Добавить самосвал'; document.getElementById('saveTruckBtn').textContent='➕ Добавить'; document.getElementById('cancelEditBtn').style.display='none'; toggleVolInput();
  }
  function toggleVolInput() { document.getElementById('volumeGroup').style.display = document.getElementById('newTruckType').value === 'gai' ? 'none' : 'block'; }
  async function deleteGlobalTruck(id) {
    if(!requireEdit('manage_trucks')) return; let t=findTruck(id); if(!t || !(await appConfirm('Удалить?'))) return;
    try { await saveLineEvent(()=>nasDeleteRecord('truck',id,nasRecordRevision('truck',id))); } catch(e){ showError(e.message); }
  }
  async function saveObjectToBase() {
    if (!requireEdit('manage_objects')) return;
    let id = document.getElementById('editObjectId').value, name = document.getElementById('newObjectNameBase').value.trim();
    if (!name) { appNotice('Введите имя'); return; }
    try { await saveLineEvent(()=>nasSaveRecord('object',id,{name},Number(document.getElementById('editObjectId').dataset.nasRevision)));cancelEditObject(); } catch(e){ showError(e.message); }
  }
  function editGlobalObject(id) { if(!requireEdit('manage_objects')) return; let o=state.objects.find(x=>x.id===id); if(!o) return; document.getElementById('editObjectId').dataset.nasRevision=String(nasRecordRevision('object',id)||'');document.getElementById('editObjectId').value=o.id; document.getElementById('newObjectNameBase').value=o.name; document.getElementById('formObjectCardTitle').textContent='Редактировать'; document.getElementById('saveObjectBtn').textContent='💾 Сохранить'; document.getElementById('cancelEditObjectBtn').style.display='block'; window.scrollTo(0,0); }
  function cancelEditObject() { document.getElementById('editObjectId').value=''; document.getElementById('newObjectNameBase').value=''; document.getElementById('formObjectCardTitle').textContent='Добавить объект'; document.getElementById('saveObjectBtn').textContent='➕ Добавить'; document.getElementById('cancelEditObjectBtn').style.display='none'; }
  async function deleteGlobalObject(id) {
    if(!requireEdit('manage_objects')) return; let o=state.objects.find(x=>x.id===id); if(!o || !(await appConfirm('Удалить?'))) return;
    try { await saveLineEvent(()=>nasDeleteRecord('object',id,nasRecordRevision('object',id))); } catch(e){ showError(e.message); }
  }

  // === АДМИН ПАНЕЛЬ ===
  const userAccessWrites=new Set();
  // Черновик ника: ввод живёт в поле до явного «Сохранить». Фоновые
  // перестроения списка (nasActiveRefresh ~15 с, снапшоты users/requests)
  // не должны уничтожать напечатанный текст: пока поле в фокусе,
  // перерисовка откладывается (паттерн refreshIncoming из
  // tabel-v2/workspace.mjs), а при перестроении значения и фокус полей
  // переживают innerHTML (сохранение/восстановление по data-nickname-uid).
  // Ф1 (1.8.1): то же удержание действует для select роли — открытый
  // список ролей не должен закрываться фоновой перерисовкой; выбор роли
  // по-прежнему отправляется мгновенно по onchange.
  // Ф2 (1.8.1): кнопки «Сохранить/Отмена» скрыты, пока не начат ввод ника.
  const nicknameDrafts=new Set();
  let adminDraftHoldTimer=null;
  function adminDraftFieldActive() {
    const active=document.activeElement, container=document.getElementById('usersListContainer');
    if (!active || typeof active.matches!=='function' || !container || typeof container.contains!=='function' || !container.contains(active)) return false;
    return active.matches('input:not([readonly]),textarea,select[data-role-uid]');
  }
  function adminDraftHoldActive() { return adminDraftFieldActive(); }
  function scheduleRenderAdminPanel() {
    clearTimeout(adminDraftHoldTimer);
    adminDraftHoldTimer=setTimeout(()=>{adminDraftHoldTimer=null;renderAdminPanel();},1000);
  }
  function collectDraftFields(container) {
    const drafts={};
    container.querySelectorAll('[data-nickname-uid]').forEach(f=>drafts[f.dataset.nicknameUid]={value:f.value,focused:f===document.activeElement});
    return drafts;
  }
  function restoreDraftFields(container,drafts) {
    container.querySelectorAll('[data-nickname-uid]').forEach(f=>{const d=drafts[f.dataset.nicknameUid];if(!d)return;f.value=d.value;if(d.focused)f.focus();});
  }
  // Ф2: кнопки «Сохранить/Отмена» видны только у полей с несохранённым
  // вводом. Признак «идёт ввод» — nicknameDrafts (uid), переживает
  // фоновые перерисовки, очищается сохранением/отменой.
  function setNicknameActionsVisible(container) {
    container.querySelectorAll('[data-nickname-uid]').forEach(f=>{
      const actions=f.parentElement?.querySelector('[data-nickname-actions]');
      if (actions) actions.style.display=nicknameDrafts.has(f.dataset.nicknameUid)?'inline-flex':'none';
    });
  }
  function onNicknameInput() {
    const uid=this.dataset.nicknameUid;
    const original=state.users.find(u=>u.id===uid)?.nickname||'';
    if (this.value!==original) nicknameDrafts.add(uid); else nicknameDrafts.delete(uid);
    const actions=this.parentElement?.querySelector('[data-nickname-actions]');
    if (actions) actions.style.display=nicknameDrafts.has(uid)?'inline-flex':'none';
  }
  function cancelUserNicknameDraft(uid) {
    const field=document.querySelector('[data-nickname-uid="'+uid+'"]');
    const original=state.users.find(u=>u.id===uid)?.nickname||'';
    if (field) field.value=original;
    nicknameDrafts.delete(uid);
    const actions=field?.parentElement?.querySelector('[data-nickname-actions]');
    if (actions) actions.style.display='none';
  }
  function renderAdminPanel() {
    if (!canAdmin()) return;
    renderRegistrationRequests();
    if (adminDraftHoldActive()) { scheduleRenderAdminPanel(); return; }
    const active = state.users.filter(u => u.status !== 'pending');
    const container=document.getElementById('usersListContainer');
    const drafts=collectDraftFields(container);
    container.innerHTML = active.map(u => { const isMe = u.id === currentUid; const isLocked = isNasRuntime()?u.protected===true:isForcedAdminEmail(u.email); const accessible=u.status!=='disabled'; return `<div class="user-row ${accessible?'':'user-access-limited'}"> <div class="user-row-top"><div class="user-email">${escapeHtml(u.email)}</div><div style="display:flex;gap:4px;align-items:center;"><input type="text" class="form-control" style="width:100px; padding:4px; font-size:12px;" data-nickname-uid="${escapeHtml(u.id)}" value="${escapeHtml(u.nickname||'')}" aria-label="Ник: ${escapeHtml(u.email)}"><span data-nickname-actions style="display:none;gap:4px;align-items:center;"><button type="button" class="btn btn-secondary btn-small" style="padding:4px 10px; font-size:12px; min-height:0;" data-nickname-cancel="${escapeHtml(u.id)}">Отмена</button><button type="button" class="btn btn-secondary btn-small" style="padding:4px 10px; font-size:12px; min-height:0;" data-nickname-save="${escapeHtml(u.id)}">Сохранить</button></span></div></div><div class="user-row-bottom"><select class="form-control" data-role-uid="${escapeHtml(u.id)}" onchange="changeUserRole('${u.id}', this.value)">${Object.keys(ROLES).map(r=>`<option value="${r}" ${r===u.role?'selected':''}>${ROLES[r].label}</option>`).join('')}</select>${!isMe&&!isLocked?`<button class="btn-del" onclick="deleteUser('${u.id}')">Удалить</button>`:''}</div><div class="user-access-row"><span>${accessible?'Доступ разрешён':'Доступ ограничен'}${isMe?'<small>Ваша учётная запись</small>':isLocked?'<small>Владелец приложения</small>':''}</span><label class="toggle-switch" title="${isMe?'Нельзя ограничить собственный доступ':isLocked?'Доступ владельца защищён':'Временно разрешить или ограничить доступ'}"><input type="checkbox" role="switch" data-user-access="${escapeHtml(u.id)}" aria-label="Доступ: ${escapeHtml(u.nickname||u.email)}" ${accessible?'checked':''} ${isMe||isLocked||userAccessWrites.has(u.id)?'disabled':''}><span class="toggle-slider"></span></label></div></div>`; }).join('');
    restoreDraftFields(container,drafts);
    container.querySelectorAll('[data-nickname-uid]').forEach(f=>f.oninput=onNicknameInput);
    setNicknameActionsVisible(container);
    container.querySelectorAll('[data-nickname-save]').forEach(b=>b.onclick=()=>saveUserNicknameDraft(b.dataset.nicknameSave));
    container.querySelectorAll('[data-nickname-cancel]').forEach(b=>b.onclick=()=>cancelUserNicknameDraft(b.dataset.nicknameCancel));
    document.querySelectorAll('[data-user-access]').forEach(input=>input.onchange=()=>setUserAccess(input.dataset.userAccess,input.checked));
  }
  async function setUserAccess(uid, enabled) {
    return saveLineEvent(()=>runNasAdminAction('user.access',{uid,enabled}));
  }
  async function saveUserNicknameDraft(uid) {
    if (!canAdmin()) return;
    const field=document.querySelector('[data-nickname-uid="'+uid+'"]');
    if (!field) return;
    // Ошибку показывает runNasAdminAction (21-nas-runtime); поле не
    // очищается — черновик защищён восстановлением после перерисовки,
    // кнопки остаются, чтобы повторить или отменить.
    const ok=await updateUserNickname(uid, field.value);
    if (ok) cancelUserNicknameDraft(uid);
  }
  async function updateUserNickname(uid, nickname) { if (!canAdmin()) return; return saveLineEvent(()=>runNasAdminAction('user.nickname',{uid,nickname:nickname.trim()})); }
  async function changeUserRole(uid, newRole) { if (!canAdmin()) return; return saveLineEvent(()=>runNasAdminAction('user.role',{uid,role:newRole})); }
  async function deleteUser(uid) { if (!canAdmin() || !(await appConfirm('Удалить доступ?'))) return; return saveLineEvent(()=>runNasAdminAction('user.delete',{uid})); }
  const registrationDecisions = new Set();
  async function decideRegistration(reqId, approve) {
    if (!canAdmin() || registrationDecisions.has(reqId)) return;
    const role=document.getElementById('req_role_'+reqId)?.value || 'viewer';
    if (approve && !Object.prototype.hasOwnProperty.call(ROLES,role)) {showError('Выберите роль');return;}
    if (!approve && !(await appConfirm('Отклонить заявку и закрыть доступ пользователю?'))) return;
    return saveLineEvent(()=>runNasAdminAction(approve?'registration.approve':'registration.reject',approve?{uid:reqId,role}:{uid:reqId}));
  }
  async function approveRequest(reqId) { return decideRegistration(reqId,true); }
  async function rejectRequest(reqId) { return decideRegistration(reqId,false); }
  async function addNewUser() {
    if (!canAdmin()) return;
    const email = document.getElementById('newUserEmail').value.trim(); const pass = document.getElementById('newUserPassword').value; const role = document.getElementById('newUserRole').value;
    if (!email || !pass) { showError('Заполните поля'); return; }
    // Учётную запись создаёт сервер Ubuntu. Пароль уходит только в запросе
    // регистрации, в интерфейсе и журналах не сохраняется.
    try{
      const base=(typeof nasApiBase==='function'?nasApiBase():'').replace(/\/+$/,'');
      if(!base)throw Error('Не настроен адрес сервера Ubuntu');
      const response=await fetch(base+'/api/v1/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pass,device:wtDeviceInfo()}),credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
      let payload=null;try{payload=await response.json();}catch(_){}
      if(!response.ok)throw Error(wtAuthMessage(payload&&typeof payload.error==='string'?payload.error:'http-'+response.status));
      const uid=payload&&payload.profile&&typeof payload.profile.uid==='string'?payload.profile.uid:'';
      if(!uid)throw Error('Сервер не вернул учётную запись');
      await refreshNasAdministration();
      await nasAdminAction('registration.approve',{uid,role});
      showToastEl('Пользователь создан на Ubuntu',false);
    }
    catch(error){showError('Создание доступа не завершено: '+error.message);}
    finally{document.getElementById('newUserPassword').value='';}
  }
  function renderPermissionsMatrix(){
    const role=document.getElementById('permRoleSelect').value,config=permissionsConfig[role]||{tabs:[],actions:[]},cont=document.getElementById('permissionsMatrixContainer');
    const groups=[['Смена и линия',['start_shift','close_shift','edit_line']],['Работа самосвалов',['action_arrive','action_load','action_ttn','action_no_return','line_timer_reset']],['Последнее действие в статусе',['undo_action','undo_any']],['Журнал отмены и восстановления',['history_view','history_undo_own','history_undo_any','history_redo_own','history_redo_any']],['Данные и архив',['edit_logs','manage_trucks','manage_objects','archive_edit','archive_delete','import_backup']],['Отображение',['view_card_stats','view_header','view_gai_report','view_reis_in_ticker']]];
    const known=new Set(groups.flatMap(g=>g[1])),extra=[...new Set([...ALL_ACTIONS,...(config.actions||[])])].filter(x=>!known.has(x)&&!x.startsWith('tabel_tab_'));if(extra.length)groups.push(['Другие возможности',extra]);
    cont.innerHTML='<input id="permissionSearch" class="form-control" type="search" placeholder="Найти право…" aria-label="Поиск прав" style="margin-bottom:12px"><p style="color:var(--muted);font-size:12px">Администратор имеет полный доступ. Новые права журнала у остальных ролей выключены, пока вы их не включите. Изменения применяются кнопкой сохранения.</p>';
    function section(title,ids,type,labels,selected){const block=document.createElement('section');block.className='perm-group';const h=document.createElement('div');h.className='perm-group-header';h.textContent=title;block.append(h);const list=document.createElement('div');list.className='perm-list';for(const id of ids){const label=document.createElement('label');label.className='perm-item';label.dataset.search=(title+' '+(labels[id]||id)).toLowerCase();const input=document.createElement('input');input.type='checkbox';input.dataset.type=type;input.value=id;input.checked=selected.includes(id);label.append(input,document.createTextNode(' '+(labels[id]||id)));list.append(label);}block.append(list);cont.append(block);}
    section('Доступные вкладки',ALL_TABS.filter(t=>t!=='admin'),'tab',TAB_LABELS,config.tabs||[]);for(const [title,ids] of groups)section(title,ids,'action',ACTION_LABELS,config.actions||[]);
    // Табель: гранулярные вкладки. Пока роли не выдано ни одного права tabel_tab_*,
    // показываем состояние «по умолчанию: все вкладки» и ничего не сохраняем,
    // пока администратор не включит выборочный набор.
    if(role!=='admin'){
      const tabelIds=['tabel_tab_request','tabel_tab_shift','tabel_tab_table','tabel_tab_catalog','tabel_tab_history'];
      const configured=(config.actions||[]).filter(x=>tabelIds.includes(x));
      const customized=configured.length>0;
      const block=document.createElement('section');block.className='perm-group';
      const h=document.createElement('div');h.className='perm-group-header';h.textContent='Табель';block.append(h);
      const note=document.createElement('p');note.style='color:var(--muted);font-size:12px;margin:0 0 8px';
      note.textContent=customized?'Отмечены только вкладки табеля, доступные этой роли.':'По умолчанию: все вкладки. Снимите галочки, чтобы ограничить вкладки табеля для этой роли (полный сброс галочек вернёт все вкладки).';
      block.append(note);
      const list=document.createElement('div');list.className='perm-list';
      for(const id of tabelIds){
        const label=document.createElement('label');label.className='perm-item';label.dataset.search=('Табель '+(ACTION_LABELS[id]||id)).toLowerCase();
        const input=document.createElement('input');input.type='checkbox';input.dataset.type='action';input.value=id;
        input.checked=customized?configured.includes(id):true;
        label.append(input,document.createTextNode(' '+(ACTION_LABELS[id]||id).replace('Табель: ','')));
        list.append(label);
      }
      block.append(list);cont.append(block);
    }
    document.getElementById('permissionSearch').oninput=e=>{const q=e.target.value.trim().toLowerCase();cont.querySelectorAll('.perm-item').forEach(x=>x.hidden=!x.dataset.search.includes(q));cont.querySelectorAll('.perm-group').forEach(x=>x.hidden=![...x.querySelectorAll('.perm-item')].some(l=>!l.hidden));};
  }

  async function savePermissions() {
    if (!canAdmin()) return;
    const role = document.getElementById('permRoleSelect').value;
    const cont = document.getElementById('permissionsMatrixContainer');
    const tabs = Array.from(cont.querySelectorAll('input[data-type="tab"]:checked')).map(i => i.value);
    let actions = Array.from(cont.querySelectorAll('input[data-type="action"]:checked')).map(i => i.value);
    // Полный набор вкладок табеля == состояние по умолчанию: не записываем
    // tabel_tab_* в роль, чтобы старые конфигурации не менялись без причины.
    const tabelAll = ['tabel_tab_request','tabel_tab_shift','tabel_tab_table','tabel_tab_catalog','tabel_tab_history'];
    if (tabelAll.every(id => actions.includes(id))) actions = actions.filter(id => !tabelAll.includes(id));
    return saveLineEvent(()=>runNasAdminAction('permissions.replace',{role,permissions:{tabs,actions}}));
  }

  // Панель длинных ошибок: одна на всё приложение, по центру экрана,
  // закрывается только кнопкой «Понятно» (без таймера и закрытия по клику
  // мимо панели).
  function showErrorPanel(html) {
    let panel = document.getElementById('errorPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'errorPanel';
      panel.className = 'error-panel';
      panel.setAttribute('role', 'alert');
      panel.innerHTML = '<div class="error-panel-text"></div><button type="button" class="btn btn-secondary error-panel-close">Понятно</button>';
      panel.querySelector('.error-panel-close').addEventListener('click', () => panel.classList.remove('open'));
      document.body.appendChild(panel);
    }
    panel.querySelector('.error-panel-text').innerHTML = html;
    panel.classList.add('open');
  }
  function showError(msg) {
    console.error(msg);
    if (!navigator.onLine) { showToastEl(`📴 Нет сети`, true); return; }
    if (String(msg).length > 60) { showErrorPanel(`⚠️ ${escapeHtml(msg)}`); return; }
    showToastEl(`⚠️ ${escapeHtml(msg)}`, true);
  }
  function resetToast(t) { t.className = 'toast'; t.innerHTML = ''; }
  function showToastEl(html, isError, isUndo) {
    if(window.__gameDeferToast?.(html,isError,isUndo))return;
    let t = document.getElementById('toast'); if (!t) return;
    clearTimeout(toastTimer1); clearTimeout(toastTimer2);
    t.className = 'toast' + (isError ? ' error' : '') + (isUndo ? ' slide-right-to-left' : '');
    t.innerHTML = html; void t.offsetWidth; t.classList.add('show');
    toastTimer1 = setTimeout(() => { t.classList.remove('show'); t.classList.add('hide'); toastTimer2 = setTimeout(() => resetToast(t), 700); }, 2500);
  }
  function showToast(msgHtml, tickerHtml, actionObj) { if (actionObj) pushNotification(actionObj, tickerHtml || msgHtml); else showToastEl(msgHtml, false); }
  async function pushNotification(actionObj, htmlText) {
    pendingStart();
    try { await refs.notifications.add(Object.assign({}, actionObj, { html: htmlText, timestamp: Date.now(), createdBy: getUserName(), createdByEmail: currentEmail || '' })); cleanupNotifications().catch(()=>{}); }
    catch(e) { console.warn(e); } finally { pendingEnd(); }
  }
  let notifCleanupPending = false;
  async function cleanupNotifications() {
    if (notifCleanupPending) return; notifCleanupPending = true;
    try { let snap = await refs.notifications.orderBy('timestamp', 'desc').limit(100).get(); if (snap.size < 100) return; let oldTs = snap.docs[snap.docs.length - 1].data().timestamp; let oldSnap = await refs.notifications.where('timestamp', '<', oldTs).get(); let batch = db.batch(); let cnt=0; oldSnap.forEach(d=>{batch.delete(d.ref);cnt++;}); if(cnt>0) await tfAwait(batch.commit()); }
    catch(e) {} finally { notifCleanupPending = false; }
  }
  async function clearAllNotifications() { try { let snap = await refs.notifications.get(); if(!snap.size) return; let b=db.batch(); snap.forEach(d=>b.delete(d.ref)); await tfAwait(b.commit()); } catch(e){} }
  function canUndoCurrent(last) { if (!hasPermission('undo_action') && !hasPermission('undo_any')) return false; if (hasPermission('undo_any')) return true; return last.createdByEmail === currentEmail; }

  function renderStatusTicker() {
    let t = document.getElementById('statusTicker'); if (!t) return;
    // Заголовок полосы называет объект, когда открыто несколько смен: иначе
    // действие одного объекта легко принять за действие другого.
    function scopeLabel(item) {
      let count = 0;
      try { count = Number(window.__wtVisibleShiftCount && window.__wtVisibleShiftCount()) || 0; } catch (_) { count = 0; }
      if (count < 2) return 'ПОСЛЕДНЕЕ ДЕЙСТВИЕ';
      const name = String((item && item.objectName) || (state.shift && state.shift.objectName) || '').trim();
      return name ? 'ПОСЛЕДНЕЕ ДЕЙСТВИЕ · ' + name : 'ПОСЛЕДНЕЕ ДЕЙСТВИЕ';
    }
    function refreshStripBadges() { try { window.__wtRefreshShiftBadges && window.__wtRefreshShiftBadges(); } catch (_) {} }
    let last = offlineLocalTicker() || lastValidNotification();
    if (!last) { t.style.display = 'none'; t.innerHTML = ''; lastTickerTs = 0; lastTickerId = null; refreshStripBadges(); return; }
    let isNew = (last.timestamp || 0) !== lastTickerTs; let isNewId = last.id !== lastTickerId;
    if (t.style.display === 'none' || !t.querySelector('.ticker-text-wrapper')) {
      t.style.display = 'flex';
      t.innerHTML = `<div class="ticker-row-top"><span id="tickerScope">${escapeHtml(scopeLabel(last))}</span><span id="tickerTimeAgo" class="ticker-time" data-timestamp="${last.timestamp||Date.now()}">${formatTimeAgo(last.timestamp)}</span></div><div class="ticker-row-bottom"><div class="ticker-text-wrapper"><div class="ticker-left active">${last.html||''}</div></div>${canUndoCurrent(last) ? `<button class="btn-undo" onclick="${last.offlinePending?'undoLastOfflineAction()':'undoLastAction()'}" title="Отменить">↩</button>` : ''}</div>`;
      lastTickerTs = last.timestamp || 0; lastTickerId = last.id; t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); refreshStripBadges(); return;
    }
    // Смена могла переключиться, а запись остаться той же: заголовок полосы
    // обязан называть объект выбранной смены, иначе он врёт.
    const scopeEl = document.getElementById('tickerScope');
    const scopeText = scopeLabel(last);
    if (scopeEl && scopeEl.textContent !== scopeText) scopeEl.textContent = scopeText;
    if (isNew && isNewId) {
      let wrapper = t.querySelector('.ticker-text-wrapper'); let oldText = wrapper.querySelector('.ticker-left.active');
      if (oldText) { let newText = document.createElement('div'); newText.className = 'ticker-left enter'; newText.innerHTML = last.html || ''; wrapper.appendChild(newText); void newText.offsetWidth; oldText.classList.remove('active'); oldText.classList.add('leave'); newText.classList.remove('enter'); newText.classList.add('active'); setTimeout(() => { if (oldText.parentNode) oldText.remove(); }, 800); }
      let undoBtn = t.querySelector('.btn-undo'); let canUndo = canUndoCurrent(last);
      if (canUndo && !undoBtn) { let btn = document.createElement('button'); btn.className = 'btn-undo'; btn.innerHTML = '↩'; btn.onclick = last.offlinePending?undoLastOfflineAction:undoLastAction; t.querySelector('.ticker-row-bottom').appendChild(btn); } else if (!canUndo && undoBtn) { undoBtn.remove(); }
      if(undoBtn&&canUndo)undoBtn.onclick=last.offlinePending?undoLastOfflineAction:undoLastAction;
      let timeEl = document.getElementById('tickerTimeAgo'); if(timeEl) { timeEl.textContent = formatTimeAgo(last.timestamp); timeEl.setAttribute('data-timestamp', last.timestamp); }
      t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); lastTickerTs = last.timestamp || 0; lastTickerId = last.id;
    }
  }
  let undoActionInFlight = false;
  async function undoLastAction() {
    if (undoActionInFlight) return;
    if (!hasPermission('undo_action') && !hasPermission('undo_any')) { showError('Нет права отменять действия'); return; }
    const last = lastValidNotification(); if (!last) return;
    if (!hasPermission('undo_any') && last.createdByEmail !== currentEmail) { showError('Можно отменить только своё действие'); return; }
    if (!['arrive','load','ttn'].includes(last.type)) { showError('Это действие отменяется через историю администратора'); return; }
    if (!(await appConfirm('Отменить действие?'))) return;
    undoActionInFlight = true; pendingStart();
    try {
      if (truckStatusWrites[last.truckId]) await truckStatusWrites[last.truckId];
      const localStatus = state.truckStatus[last.truckId];
      if (!localStatus) throw {code:'status-missing',message:'Статус машины не загружен. Обновите страницу'};
      const before = {...localStatus};
      const observedRevision=truckServerRevisions[last.truckId]||0;
      const notificationRef = refs.notifications.doc(last.id), statusRef = refs.truckStatus.doc(last.truckId);
      let update = null;
      await db.runTransaction(async tx => {
        const notification = await tx.get(notificationRef);
        const status = await tx.get(statusRef);
        const logRef = last.type === 'load' && last.logId ? refs.logs.doc(last.logId) : null;
        const log = logRef ? await tx.get(logRef) : null;
        // A notification is a presentation record, not the source of truth for
        // the current TTN state. It may be absent after cleanup or a delayed
        // listener update; the status transaction still proves whether this
        // exact TTN can be undone. Arrive/load keep the stricter notification
        // requirement because they also need their durable history/log.
        if (!notification.exists && last.type !== 'ttn') throw {code:'already-undone',message:'Действие уже отменено'};
        if (notification.exists && !hasPermission('undo_any') && notification.data().createdByEmail !== currentEmail) throw {code:'not-owner',message:'Можно отменить только своё действие'};
        if (!status.exists) throw {code:'status-missing',message:'Самосвал отсутствует на линии'};
        const current = status.data();
        const keys=['shiftId','onLine','arriveStatus','arriveTimestamp','arriveBy','lastLoadTimestamp','lastLoadBy','loadedAfterArrive','ttnStatus','ttnBy','ttnLogId','cycleRevision','lastLoadLogId','ttnRevision'];
        if (keys.some(key => JSON.stringify(current[key] ?? null) !== JSON.stringify(before[key] ?? null))) throw {code:'action-conflict',message:'Данные машины изменились. Обновите страницу перед отменой'};
        if (last.type === 'arrive') {
          update = last.wasArrived ? {arriveStatus:last.prevTime||null,arriveTimestamp:last.prevTs||null,arriveBy:last.prevArriveBy||null} : {arriveStatus:null,arriveTimestamp:null,arriveBy:null,loadedAfterArrive:false};
        } else if (last.type === 'load') {
          if (!log || !log.exists) throw {code:'log-missing',message:'Рейс уже удалён или не был сохранён'};
          if (!hasPermission('undo_any') && log.data().createdByEmail !== currentEmail) throw {code:'not-owner',message:'Нельзя отменить чужую погрузку'};
          if (Number(current.lastLoadTimestamp) !== Number(log.data().timestamp)) throw {code:'action-conflict',message:'У самосвала уже есть более новая погрузка'};
          update={loadedAfterArrive:false,lastLoadTimestamp:last.prevLoadTs??null,lastLoadBy:last.prevLoadBy??null};
          if (last.wasArrived) Object.assign(update,{arriveStatus:last.prevArriveStatus||null,arriveTimestamp:last.prevArriveTs||null,arriveBy:last.prevArriveBy||null});
          update.lastLoadLogId=last.prevLoadLogId||null;
          if (last.prevTtn !== undefined) update.ttnStatus=last.prevTtn;
          if (last.prevTtnBy !== undefined) update.ttnBy=last.prevTtnBy||null;
          if (last.prevTtnLogId !== undefined) update.ttnLogId=last.prevTtnLogId;
        } else {
          update={ttnStatus:last.prevTtn??null,ttnBy:last.prevTtnBy??null,ttnLogId:last.prevTtnLogId??null};
        }
        if(last.type==='arrive'||last.type==='load')update.cycleRevision=Number(current.cycleRevision||0)+1;
        if(last.type==='ttn'||last.type==='load')update.ttnRevision=Number(current.ttnRevision||0)+1;
        // TTN can be confirmed by truckStatus even when its presentation
        // notification has not arrived (or was cleaned up). Build the penalty
        // scope from the durable action in that case instead of dereferencing
        // an absent notification snapshot.
        const original=notification.exists ? notification.data() : {
          ...last,
          createdByEmail:last.createdByEmail||last.email||currentEmail,
          createdBy:last.createdBy||last.actor||getUserName(),
          type:last.type,
          truckId:last.truckId,
          logId:last.logId||current.ttnLogId||null
        };
        const penaltyKey=original.gamePenaltyKey||window.__gamePenaltyKey(last.type,last.truckId,current,last.logId,last.id);
        const savePenalty=await window.__gameStagePenalty(tx,penaltyKey,{user:original.createdByEmail,name:original.createdBy,description:({load:'Погрузка',arrive:'Прибытие',ttn:'Отметка ТТН'}[last.type])+' · '+truckName(last.truckId),...window.__gamePenaltyScope(penaltyKey,original,current)});
        tx.update(statusRef,update);
        if (logRef) tx.delete(logRef);
        savePenalty();
        tx.delete(notificationRef);
      });
      if (state.truckStatus[last.truckId] && (truckServerRevisions[last.truckId]||0)===observedRevision) {const next={...state.truckStatus[last.truckId],...update};signalLineTransition(last.truckId,state.truckStatus[last.truckId],next);state.truckStatus[last.truckId]=next;truckServerRevisions[last.truckId]=observedRevision+1;}
      if (last.type === 'load') { state.logs=state.logs.filter(l=>l.id!==last.logId); confirmedLoadIds.delete(last.logId); }
      state.notifications=state.notifications.filter(n=>n.id!==last.id);
      if (syncState.errors) delete syncState.errors.undo;
      saveCache(); renderAll();
      await addAudit('↶ Отмена: ' + ({load:'погрузка самосвала',arrive:last.wasArrived?'снятие прибытия':'прибытие на линию',ttn:'отметка ТТН'}[last.type]) + ': ' + truckName(last.truckId),{eventType:'undo',originalType:last.type,truckId:last.truckId,originalUserEmail:last.createdByEmail||''});
      showToastEl('↩️ Отменено',false,true);
    } catch(e) {
      reportSyncError('undo',e);
      showErrorPanel('Действие не отменено: ' + escapeHtml(e.message || 'Ошибка Firebase') + ' [' + escapeHtml(e.code || 'unknown') + ']');
    } finally { pendingEnd(); undoActionInFlight=false; }
  }
  async function addAudit(text, details = {}) {
    const timestamp = Date.now();
    const entry = { text, timeStr: new Date(timestamp).toLocaleString('ru-RU'), objectName: state.shift ? objectTitle(state.shift.objectId,state.shift.objectName) : '—', objectId: state.shift?.objectId || '', shiftId: state.shift?.id || '', userEmail: currentEmail || '', userName: getUserName(), createdByEmail: currentEmail || '', timestamp, ...details };
    pendingStart();
    try { await refs.audit.add(entry); }
    catch(e) { console.warn('Audit error:', e); showError('Не удалось записать событие в аудит: ' + e.message); }
    finally { pendingEnd(); }
  }
  function auditTruckAction(type, id, extra = {}) {
    const labels = { arrive: '🚛 Прибытие на линию', arrive_cancel: '↩️ Снято прибытие на линию', load: '⚡ Погрузка самосвала', ttn: '📄 Забрана ТТН', ttn_cancel: '↩️ Снята отметка ТТН', 'no-return': '🚫 Самосвал больше не приедет' };
    const name = truckName(id);
    return addAudit((labels[type] || type) + ': ' + name + (type === 'load' ? ' · ' + (extra.volume || 0) + ' м³' : ''), {eventType:type,truckId:id,truckName:name,...extra});
  }
  function renderAuditEntries() {
    return '<div style="font-size:11px;color:var(--muted);margin:8px 0">Последние ' + state.audit.length + ' событий всех пользователей (до 200). Новые события сверху.</div>' + state.audit.map(a => {
      const name = resolveUserDisplayName(a.userEmail || a.createdByEmail, a.userName);
      return `<div class="audit-item"><div class="audit-time">${escapeHtml(a.timeStr)} · ${escapeHtml(name)}</div><div>${escapeHtml(a.text)}</div><div class="audit-time" style="margin-top:5px">${escapeHtml(objectTitle(a.objectId,a.objectName))}</div></div>`;
    }).join('');
  }

  // === НАСТРОЙКИ ===
  function openSettingsModal() {
    document.getElementById('settingHoldLoad').value = settings.holdLoad;
    document.getElementById('settingHoldArrive').value = settings.holdArrive;
    document.getElementById('settingHoldTtn').value = settings.holdTtn;
    document.getElementById('settingCycleMinutes').disabled=!canAdmin();
    document.getElementById('settingCycleMinutes').value = Math.max(MIN_CYCLE_MINUTES, settings.cycleMinutes || MIN_CYCLE_MINUTES);
    for(const name of ['hapticArrive','hapticLoad','hapticTtn'])document.getElementById(name).checked=!!settings[name];
    document.getElementById('settingsModal').classList.add('open');
  }
  function closeSettingsModal() { document.getElementById('settingsModal').classList.remove('open'); }
  function updateHoldSetting(t,v) { let f=parseFloat(v); f = isNaN(f)?0.5:Math.max(0,Math.min(5,f)); if(t==='load') settings.holdLoad=f; else if(t==='arrive') settings.holdArrive=f; else settings.holdTtn=f; localStorage.setItem('working-test-settings', JSON.stringify(settings)); }
  async function updateCycleMinutes(v) {
    if(!canAdmin()){showError('Время ходки задаёт администратор');return;}
    if(!navigator.onLine){showError('Для изменения общего времени ходки требуется связь');return;}
    const n=Math.max(15,parseInt(v)||15);
    try{await saveLineEvent(()=>nasSaveSettings({cycleMinutes:n}));settings.cycleMinutes=n;localStorage.setItem('working-test-settings',JSON.stringify(settings));renderAll();}
    catch(e){showError('Время ходки не сохранено: '+e.message);}
  }
  function toggleSetting(k,v) { settings[k]=v; localStorage.setItem('working-test-settings', JSON.stringify(settings)); }

  function renderAll() {
    renderHeaderStats();
    // П4: перерисовка линии идёт через расписание, чтобы уважать удержания.
    if (hasTabAccess('line')) scheduleRenderLine();
    // Полоса открытых смен — отдельный элемент, а не карточки линии: порядок
    // хуков и удержаний она не меняет (задача 25).
    window.__wtRenderShiftStrip?.();
    // Рейсы, оставшиеся в прежней смене: свой блок, тоже без влияния на
    // порядок карточек (design §10.2).
    window.__wtRenderDetachedTrips?.();
    if (hasTabAccess('report')) renderReport();
    if (hasTabAccess('archive')) renderArchive();
    if (hasTabAccess('trucks')) { renderGlobalTrucksManage(); renderGlobalObjectsManage(); }
    if (hasTabAccess('analytics')) renderAnalytics();
    if (canAdmin()) renderAdminPanel();
    renderStatusTicker();
    updateSyncUI();
  }

  // === SWITCH TAB (с жёсткой проверкой безопасности) ===
