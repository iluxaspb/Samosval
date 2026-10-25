try { (function(){
  if (window.__undoRedoV5) return;
  window.__undoRedoV5 = true;

  // ===== CSS =====
  const oldCss = document.getElementById('undo-redo-css');
  if (oldCss) oldCss.remove();

  const css = document.createElement('style');
  css.id = 'undo-redo-css';
  css.textContent = `
    #undoRedoGroup {
      display: none;
      gap: 3px; align-items: center; flex-shrink: 0;
    }
    #undoRedoGroup.visible { display: flex !important; }
    .undo-redo-btn {
      position: relative;
      width: 28px; height: 26px;
      padding: 0; border: 1px solid var(--border); border-radius: 6px;
      background: transparent; color: var(--text);
      font-size: 14px; font-weight: 900;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      line-height: 1; -webkit-tap-highlight-color: transparent; flex-shrink: 0;
    }
    .undo-redo-btn:active:not(:disabled) { background: rgba(255,255,255,0.12); }
    #historyBtn.has-actions {
      border-color: var(--warning); color: var(--warning);
      background: rgba(245, 158, 11, 0.1);
    }
    .ur-badge {
      position: absolute; top: -5px; right: -5px;
      min-width: 13px; height: 13px; padding: 0 3px;
      background: var(--warning); color: #000;
      font-size: 8px; font-weight: 900; line-height: 13px;
      border-radius: 7px; text-align: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.5);
      pointer-events: none;
    }
    .ur-badge.hidden { display: none; }

    .ur-history-item {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .ur-history-item.current {
      border-color: var(--warning);
      background: rgba(245, 158, 11, 0.08);
    }
    .ur-history-item.redo {
      border-style: dashed;
      opacity: 0.85;
    }
    .ur-history-item .history-info { flex: 1; min-width: 0; }
    .ur-history-item .history-desc {
      font-size: 13px; font-weight: 600; color: var(--text);
      word-break: break-word; line-height: 1.3;
    }
    .ur-history-item .history-meta {
      font-size: 10px; color: var(--muted); margin-top: 3px;
      display: flex; gap: 8px; flex-wrap: wrap;
    }
    .ur-history-item .history-action {
      flex-shrink: 0;
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text);
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      min-height: 32px;
    }
    .ur-history-item .history-action:active { transform: scale(0.96); }
    .ur-history-item .history-action.undo {
      border-color: var(--primary); color: #93c5fd;
      background: rgba(59, 130, 246, 0.1);
    }
    .ur-history-item .history-action.redo {
      border-color: var(--success); color: #86efac;
      background: rgba(34, 197, 94, 0.1);
    }
    .history-empty {
      text-align: center; color: var(--muted);
      font-size: 13px; padding: 30px 12px;
    }
    .history-section-title {
      font-size: 12px; font-weight: 800;
      color: var(--muted); text-transform: uppercase;
      letter-spacing: 0.5px; margin: 12px 0 8px 0;
    }
    .history-section-title:first-child { margin-top: 0; }
  `;
  document.head.appendChild(css);

  // ===== Стеки =====
  const stackKey=()=> 'dt_undo_redo_v3:'+firebaseConfig.projectId+':'+WORKSPACE_ID+':'+currentUid;
  const MAX_SIZE = 300;
  const MAX_CLOUD_SIZE = 30;
  let undoStack = [];
  let redoStack = [];

  // Firestore-документ со стеками
  const stacksRef = db.collection('settings').doc('undoRedoStacks');

  function loadStacksLocal() {
    try {
      const raw = localStorage.getItem(stackKey());
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.undo)) undoStack = data.undo.slice(-MAX_SIZE);
      if (Array.isArray(data.redo)) redoStack = data.redo.slice(-MAX_SIZE);
    } catch(e) {}
  }

  let cloudHistoryLoading=false;
  async function loadStacksCloud(){
    if(cloudHistoryLoading||!navigator.onLine||!canUndo())return;
    cloudHistoryLoading=true;const historyUid=currentUid;
    try{
      const snap=await Promise.race([refs.audit.orderBy('timestamp','desc').limit(300).get({source:'server'}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Нет связи с журналом')),4000))]);
      if(currentUid!==historyUid)return;
      const rows=snap.docs.map(d=>{const x=d.data();return x.eventType==='history'&&x.history?{...x.history,id:d.id}:null;}).filter(Boolean);
      const seen=new Set(rows.map(x=>x.id));
      const legacy=[...undoStack,...redoStack].filter(x=>!seen.has(x.id));
      undoStack=[...rows.filter(x=>!x.undone),...legacy.filter(x=>!x.undone)].sort((a,b)=>a.timestamp-b.timestamp).slice(-MAX_SIZE);
      redoStack=[...rows.filter(x=>x.undone),...legacy.filter(x=>x.undone)].sort((a,b)=>a.timestamp-b.timestamp).slice(-MAX_SIZE);
      saveStacks();refreshUI();
    }catch(e){console.warn('Журнал:',e.message);}finally{cloudHistoryLoading=false;}
  }
  function saveStacks(){try{localStorage.setItem(stackKey(),JSON.stringify({undo:undoStack,redo:redoStack}));}catch(e){showError('Не удалось сохранить историю на устройстве');}}
  window.__historyAcceptAudit=function(entries){
    if(!currentUid||!canUndo())return;
    const merged=new Map([...undoStack,...redoStack].map(a=>[a.id,a]));
    for(const entry of entries)if(entry.eventType==='history'&&entry.history)merged.set(entry.id,{...entry.history,id:entry.id});
    const rows=[...merged.values()].sort((a,b)=>a.timestamp-b.timestamp).slice(-MAX_SIZE);
    undoStack=rows.filter(a=>!a.undone);redoStack=rows.filter(a=>a.undone);saveStacks();refreshUI();
    if(document.getElementById('urHistoryModal'))renderHistoryModal(true);
  };
  function deepCopy(obj) {
    if (obj === null || obj === undefined) return obj;
    try { return JSON.parse(JSON.stringify(obj)); } catch(e) { return obj; }
  }
  function genId() {
    return 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }
  function canUndo() {
    return currentUserRole==='admin'||['history_view','history_undo_own','history_undo_any','history_redo_own','history_redo_any'].some(hasPermission);
  }

  function allowedHistory(direction,action){
    if(currentUserRole==='admin')return true;
    const prefix=direction==='before'?'history_undo_':'history_redo_';
    return hasPermission(prefix+'any')||(hasPermission(prefix+'own')&&action.userEmail===currentEmail);
  }
  // ===== Применение операции =====
  function sameHistoryValue(a,b){
    if(a===b)return true;
    if(a==null||b==null||typeof a!=='object'||typeof b!=='object')return false;
    const keys=new Set([...Object.keys(a),...Object.keys(b)]);
    return [...keys].every(k=>sameHistoryValue(a[k],b[k]));
  }
  const ttnFields=['ttnStatus','ttnBy','ttnLogId'];
  const revisionFields=['cycleRevision','ttnRevision'];
  function changedStatusFields(op){return [...new Set([...Object.keys(op.before||{}),...Object.keys(op.after||{})])].filter(k=>!revisionFields.includes(k)&&!sameHistoryValue(op.before?.[k]??null,op.after?.[k]??null));}
  function isTtnOnly(op){const fields=changedStatusFields(op);return op.collection==='truckStatus'&&op.before&&op.after&&fields.length>0&&fields.every(k=>ttnFields.includes(k));}
  async function applyHistoryOperations(operations,direction,action){
    return window.__historyRawTransaction(async tx=>{
      if(!allowedHistory(direction,action))throw new Error('Нет права на это действие в журнале');
      const historyRef=refs.audit.doc(action.id),historyDoc=await tx.get(historyRef);
      if(!historyDoc.exists||!historyDoc.data().history)throw new Error('Запись истории отсутствует на сервере');
      const canonical=historyDoc.data().history;
      if(!allowedHistory(direction,canonical))throw new Error('Нет права на это действие в журнале');
      if(!sameHistoryValue(canonical.operations,operations))throw new Error('История обновилась. Откройте журнал заново.');
      if(historyDoc.exists&&historyDoc.data().history?.undone!==(direction==='after'))throw new Error('Это действие уже изменено другим пользователем. Обновите журнал.');
      const entries=[];
      for(const op of operations){
        const collection=['users','settings','registration_requests'].includes(op.collection)?db.collection(op.collection):refs[op.collection];
        if(!collection)throw new Error('Неизвестный тип записи: '+op.collection);
        const ref=op.collection==='shift'?refs.shift:collection.doc(op.id),snapshot=await tx.get(ref);
        const expected=op[direction==='before'?'after':'before'];
        let current=snapshot.exists?snapshot.data():null;
        if(expected===null){if(current!==null)throw new Error('Запись уже существует. Обновите журнал.');}
        else {
          if(current===null)throw new Error('Запись удалена другим пользователем.');
          for(const key of (isTtnOnly(op)?new Set(['shiftId',...ttnFields]):new Set([...Object.keys(expected),...Object.keys(current)]))){
            
            if(op.collection==='truckStatus'&&['cycleRevision','ttnRevision'].includes(key))continue;
            if(!sameHistoryValue(current[key]??null,expected[key]??null))throw new Error('Данные изменились после действия. Сначала отмените зависимые изменения.');
          }
        }
        entries.push({op,ref,snapshot});
      }
      const penaltyKey=canonical.gamePenaltyKey||window.__gameHistoryPenaltyKey(canonical);
      const scope=window.__gameCoinsCore.scopeFor(historyDoc.data());
      const savePenalty=direction==='before'?await window.__gameStagePenalty(tx,penaltyKey,{user:canonical.userEmail,name:canonical.user,description:canonical.description,...scope}):()=>{};
      const applied=[];
      for(const {op,ref,snapshot} of entries){
        let data=op[direction];
        if(data===null){tx.delete(ref);applied.push({...op,[direction]:null});continue;}
        data={...data};
        if(op.collection==='truckStatus'){
          const current=snapshot.exists?snapshot.data():{},fields=changedStatusFields(op);
          if(isTtnOnly(op)){
            // TTN is independent of the arrival/loading cycle. Preserve newer unrelated fields.
            const target=data;data={...current};for(const key of ttnFields){if(Object.hasOwn(target,key))data[key]=target[key];else delete data[key];}
            data.ttnRevision=Number(current.ttnRevision||0)+1;
          }else{
            data.cycleRevision=Number(current.cycleRevision||0)+1;
            if(fields.some(k=>ttnFields.includes(k)))data.ttnRevision=Number(current.ttnRevision||0)+1;
            else if(Object.hasOwn(current,'ttnRevision'))data.ttnRevision=current.ttnRevision;else delete data.ttnRevision;
          }
        }
        tx.set(ref,data);
        applied.push({...op,[direction]:data});
      }
      savePenalty();
      const history={...canonical,undone:direction==='before'};
      tx.set(historyRef,{...(historyDoc.exists?historyDoc.data():{text:action.description,timestamp:action.timestamp,userName:action.user,userEmail:currentEmail,createdByEmail:currentEmail}),history});
      return applied;
    });
  }
  function updateLocalState(op, direction) {
    const data = op[direction];
    if (op.collection === 'truckStatus') {
      if (data === null) delete state.truckStatus[op.id];
      else if (Number(state.truckStatus[op.id]?.cycleRevision||0)<=Number(data.cycleRevision||0)) state.truckStatus[op.id] = Object.assign({ id: op.id }, data);
    } else if (op.collection === 'logs') {
      if (data === null) state.logs = state.logs.filter(l => l.id !== op.id);
      else {
        const idx = state.logs.findIndex(l => l.id === op.id);
        const newLog = Object.assign({ id: op.id }, data);
        if (idx >= 0) state.logs[idx] = newLog;
        else state.logs.unshift(newLog);
      }
    } else if (op.collection === 'shift') {
      state.shift=data?{...data}:null;
    } else if (op.collection === 'trucks') {
      if (data === null) state.trucks = state.trucks.filter(t => t.id !== op.id);
      else {
        const idx = state.trucks.findIndex(t => t.id === op.id);
        const newTruck = Object.assign({ id: op.id }, data);
        if (idx >= 0) state.trucks[idx] = newTruck;
        else state.trucks.push(newTruck);
      }
    } else if (op.collection === 'objects') {
      if (data === null) state.objects = state.objects.filter(o => o.id !== op.id);
      else {
        const idx = state.objects.findIndex(o => o.id === op.id);
        const newObj = Object.assign({ id: op.id }, data);
        if (idx >= 0) state.objects[idx] = newObj;
        else state.objects.push(newObj);
      }
    } else if (op.collection === 'users') {
      if (data === null) state.users = state.users.filter(u => u.id !== op.id);
      else {
        const idx = state.users.findIndex(u => u.id === op.id);
        const newUser = Object.assign({ id: op.id }, data);
        if (idx >= 0) state.users[idx] = newUser;
        else state.users.push(newUser);
      }
    }
    if (typeof saveCache === 'function') saveCache();
  }

  // ===== Проверка конфликтов =====
  async function checkConflict(op, direction) {
    // Для truckStatus и logs — читаем текущее состояние и сравниваем
    if (op.collection !== 'truckStatus' && op.collection !== 'logs') return false;

    const expected = direction === 'before' ? op.after : op.before;

    let current = null;
    try {
      const ref = op.collection === 'truckStatus' ? refs.truckStatus.doc(op.id) : refs.logs.doc(op.id);
      const snap = await ref.get();
      if (snap.exists) current = snap.data();
    } catch(e) {
      return false;
    }

    if (!current && !expected) return false;
    if (!current || !expected) return true;

    const keys = new Set([...Object.keys(current), ...Object.keys(expected)]);
    for (const k of keys) {
      if (k === 'id' || (op.collection==='truckStatus' && ['cycleRevision','ttnRevision'].includes(k))) continue;
      if (JSON.stringify(current[k]) !== JSON.stringify(expected[k])) return true;
    }
    return false;
  }

  // ===== Подтверждение =====
  async function askConfirm(title, message, opts) {
    if (typeof window.showConfirmModal === 'function') {
      return window.showConfirmModal(title, message, opts || {});
    }
    const plain = String(message || '').replace(/<[^>]*>/g, '');
    return (await appConfirm((title || '') + '\n\n' + plain));
  }

  // ===== Undo / Redo =====
  let historyBusy=false,historyFeedback='',historyFeedbackError=false;
  function setHistoryFeedback(message,isError){
    historyFeedback=message;historyFeedbackError=!!isError;
    const target=document.getElementById('urHistoryFeedback');
    if(target){target.textContent=message;target.hidden=!message;target.style.color=isError?'var(--danger)':'var(--success)';target.setAttribute('role',isError?'alert':'status');}
    else if(isError)showError(message);
  }

  async function applySelectedHistory(direction,id){
    if(!canUndo()){showError('Нет доступа к журналу');return;}
    if(historyBusy)return;
    if(!navigator.onLine||offlinePendingCount()){showError('Сначала синхронизируйте локальные действия. Их можно отменить в разделе «На устройстве».');return;}
    const stack=direction==='before'?undoStack:redoStack;
    const action=typeof id==='string'?stack.find(x=>x.id===id):stack[stack.length-1];if(!action)return;
    if(!allowedHistory(direction,action)){showError('Нет права отменять или восстанавливать это действие');return;}
    historyBusy=true;
    try{
      if(!await askConfirm(direction==='before'?'Отменить действие?':'Восстановить действие?',escapeHtml(action.description),{confirmLabel:direction==='before'?'Отменить действие':'Восстановить',cancelLabel:'Назад'}))return;
      const applied=await applyHistoryOperations(action.operations,direction,action);
      applied.forEach(op=>updateLocalState(op,direction));
      offlineRemoteStatuses={...state.truckStatus};offlineRemoteLogs=state.logs.slice();confirmedLoadIds=new Set(state.logs.map(l=>l.id));
      action.undone=direction==='before';undoStack=undoStack.filter(x=>x.id!==action.id);redoStack=redoStack.filter(x=>x.id!==action.id);(action.undone?redoStack:undoStack).push(action);
      saveStacks();refreshUI();renderAll();
      setHistoryFeedback((action.undone?'Отменено: ':'Восстановлено: ')+action.description,false);
      renderHistoryModal();
      addAudit((action.undone?'Отмена: ':'Восстановление: ')+action.description,{eventType:action.undone?'undo':'redo',actionId:action.id}).catch(e=>console.warn('[history secondary audit]',e));
    }catch(e){const denied=String(e.code||'').includes('permission-denied');setHistoryFeedback(denied?'Отмена не выполнена: правила базы не разрешают это действие вашей роли. Изменения не сохранены.':(e.message||'Действие не выполнено'),true);}finally{historyBusy=false;}
  }
  async function performUndo(id){return applySelectedHistory('before',id);}
  async function performRedo(id){return applySelectedHistory('after',id);}
  function clearStacks(){showError('История хранится вместе с аудитом и не очищается из этого окна');}
  window.performUndo = performUndo;
  window.performRedo = performRedo;
  window.clearUndoRedoStacks = clearStacks;

  async function renderHistoryModal(refreshed=false) {
    // Open immediately from local history; a network read must not block the modal.
    loadStacksLocal();
    if(!refreshed&&!cloudHistoryLoading)loadStacksCloud().then(()=>{if(document.getElementById('urHistoryModal'))renderHistoryModal(true);});

    const old = document.getElementById('urHistoryModal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'urHistoryModal';
    overlay.className = 'modal open';
    overlay.style.zIndex = '10020';overlay.style.background='transparent';overlay.style.backdropFilter='none';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '620px';
    content.style.maxHeight = '85vh';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;';
    header.innerHTML = `<h3 style="font-size:16px; font-weight:800;">📜 Отмена и восстановление</h3><button class="btn-del" onclick="document.getElementById('urHistoryModal').remove()">✕</button>`;
    content.appendChild(header);
    const feedback=document.createElement('p');feedback.id='urHistoryFeedback';feedback.textContent=historyFeedback;feedback.hidden=!historyFeedback;feedback.setAttribute('role',historyFeedbackError?'alert':'status');feedback.style.cssText='padding:10px;margin-bottom:10px;border:1px solid var(--border);border-radius:8px;font-size:13px;line-height:1.4;color:'+(historyFeedbackError?'var(--danger)':'var(--success)');content.appendChild(feedback);

    const body = document.createElement('div');
    const note=document.createElement('p');note.style.cssText='font-size:12px;color:var(--muted)';note.textContent='Последние записи. Отмена меняет только выбранную запись. Зависимые изменения нужно отменить раньше. Для выполнения также нужны права на соответствующие данные.';body.appendChild(note);
    body.style.cssText = 'overflow-y:auto; max-height:60vh; padding-right:4px;';

    const renderSection = (title, items, kind) => {
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="history-section-title">${title} (${items.length})</div>`;

      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = kind === 'undo' ? 'Нет действий для отмены' : 'Нет действий для возврата';
        sec.appendChild(empty);
        return sec;
      }

      const reversed = items.slice().reverse();

      reversed.forEach((action, revIdx) => {
        const isCurrent = revIdx === 0;
        const realIdx = items.length - 1 - revIdx;
        const countToApply = items.length - realIdx;

        const item = document.createElement('div');
        item.className = 'ur-history-item' + (isCurrent ? ' current' : '') + (kind === 'redo' ? ' redo' : '');

        const info = document.createElement('div');
        info.className = 'history-info';
        const desc = document.createElement('div');
        desc.className = 'history-desc';
        desc.innerHTML = escapeHtml(action.description || '—');
        info.appendChild(desc);

        const meta = document.createElement('div');
        meta.className = 'history-meta';
        const t = action.timestamp ? new Date(action.timestamp).toLocaleString('ru-RU') : '—';
        meta.innerHTML = `<span>👤 ${escapeHtml(action.user || '—')}</span><span>📅 ${t}</span>`;
        info.appendChild(meta);

        item.appendChild(info);

        const btn = document.createElement('button');
        btn.className = 'history-action ' + kind;
        if (kind === 'undo') {
          btn.textContent = '↶ Отменить';
          btn.onclick = () => performUndo(action.id);
        } else {
          btn.textContent = '↷ Восстановить';
          btn.onclick = () => performRedo(action.id);
        }
        btn.disabled=!allowedHistory(kind==='undo'?'before':'after',action);
        if(btn.disabled)btn.title='Это действие недоступно вашей роли';
        item.appendChild(btn);
        sec.appendChild(item);
      });

      return sec;
    };

    const pending=offlinePendingOps().filter(x=>x.shiftId===state.shift?.id);
    if(pending.length){
      const section=document.createElement('div');section.className='form-card';
      const title=document.createElement('div');title.textContent='На устройстве, ожидают синхронизации: '+pending.length;section.appendChild(title);
      for(const op of pending){const row=document.createElement('div');row.textContent=({load:'Погрузка',arrive:'Прибытие',ttn:'ТТН',reset:'Сброс таймера'}[op.type]||op.type)+' · '+op.truckName;section.appendChild(row);}
      const cancel=document.createElement('button');cancel.className='btn btn-secondary';cancel.textContent='Отменить последнее локальное действие';cancel.onclick=()=>{undoLastOfflineAction();renderHistoryModal();};section.appendChild(cancel);body.appendChild(section);
    }
    body.appendChild(renderSection('↶ Можно отменить', undoStack, 'undo'));
    if (redoStack.length > 0) {
      body.appendChild(renderSection('↷ Можно вернуть', redoStack, 'redo'));
    }

    content.appendChild(body);

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex; gap:8px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border);';

    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn btn-danger';
    clearBtn.style.cssText = 'flex:1; font-size:13px;';
    clearBtn.innerHTML = '🗑 Очистить стек';
    clearBtn.hidden=true;
    footer.appendChild(clearBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-secondary';
    closeBtn.style.cssText = 'flex:1; font-size:13px;';
    closeBtn.textContent = 'Закрыть';
    closeBtn.onclick = () => overlay.remove();
    footer.appendChild(closeBtn);

    content.appendChild(footer);
    overlay.appendChild(content);
    document.body.appendChild(overlay);
  }

  // ===== UI (только 📜) =====
  function buildUI() {
    const topRow = document.querySelector('#mainHeader .top-row')
                || document.querySelector('header .top-row')
                || document.querySelector('.top-row');
    if (!topRow) return false;

    let group = document.getElementById('undoRedoGroup');
    if (group) return true;

    const gearBtn = topRow.querySelector('.gear-btn');

    group = document.createElement('div');
    group.id = 'undoRedoGroup';

    const historyBtn = document.createElement('button');
    historyBtn.id = 'historyBtn';
    historyBtn.className = 'undo-redo-btn';
    historyBtn.innerHTML = '📜<span class="ur-badge hidden" id="historyBadge"></span>';
    historyBtn.title = 'История действий';
    historyBtn.onclick = () => renderHistoryModal();

    group.appendChild(historyBtn);

    if (gearBtn && gearBtn.parentNode === topRow) {
      topRow.insertBefore(group, gearBtn);
    } else {
      topRow.appendChild(group);
    }
    return true;
  }

  function refreshUI() {
    const g = document.getElementById('undoRedoGroup');
    if (!g) { buildUI(); return; }

    if (!canUndo()) { g.classList.remove('visible'); return; }
    g.classList.add('visible');

    const hBtn = document.getElementById('historyBtn');
    const hBadge = document.getElementById('historyBadge');

    const hasAny = undoStack.length > 0 || redoStack.length > 0;
    if (hBtn) hBtn.classList.toggle('has-actions', hasAny);

    if (hBadge) {
      if (hasAny) {
        const total = undoStack.length + redoStack.length;
        hBadge.textContent = total > 9 ? '9+' : String(total);
        hBadge.classList.remove('hidden');
      } else hBadge.classList.add('hidden');
    }
  }

  // ===== Отладка =====
  window.__undoRedoDebug = function() {
    const g = document.getElementById('undoRedoGroup');
    console.log('=== UNDO/REDO DEBUG v5 ===');
    console.log('currentUserRole:', window.currentUserRole);
    console.log('canUndo():', canUndo());
    console.log('undoStack:', undoStack.length);
    console.log('redoStack:', redoStack.length);
    console.log('Group в DOM:', !!g);
    if (g) console.log('display:', getComputedStyle(g).display);
    console.log('=== /DEBUG ===');
  };

  // ===== Запуск =====
  loadStacksLocal();
  setTimeout(() => { loadStacksCloud().then(refreshUI); }, 1500);

  let lastRole = null;
  setTimeout(() => { buildUI(); refreshUI(); }, 200);
  setTimeout(() => { buildUI(); refreshUI(); }, 800);
  setTimeout(() => { buildUI(); refreshUI(); }, 2000);

  try {
    firebase.auth().onAuthStateChanged(() => {undoStack=[];redoStack=[];
      setTimeout(() => { buildUI(); refreshUI(); }, 200);
      setTimeout(() => { buildUI(); refreshUI(); }, 1000);
      setTimeout(() => { buildUI(); refreshUI(); }, 2500);
    });
  } catch(e) {}

  setInterval(() => {
    if (window.currentUserRole !== lastRole) {
      lastRole = window.currentUserRole;
      buildUI();
      refreshUI();
    } else {
      refreshUI();
    }
  }, 700);

  console.log('[undo-redo-v5] ✅ Активен. Только 📜, синхронизация + конфликты.');
})();; }
catch (e) { console.error('[baked patch: Отмена действий]', e); }
try { (function(){
  if (window.__analyticsV2) return;
  window.__analyticsV2 = true;

  // ===== CSS (наследуем от v1, пересоздаём) =====
  const oldCss = document.getElementById('analytics-v2-css');
  if (oldCss) oldCss.remove();

  const css = document.createElement('style');
  css.id = 'analytics-v2-css';
  css.textContent = `
    .an-section {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 12px; padding: 14px; margin-bottom: 12px;
    }
    .an-title { font-size: 14px; font-weight: 800; margin-bottom: 10px; color: var(--text); }
    .an-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(115px, 1fr)); gap: 8px; }
    .an-stat { background: var(--bg); padding: 10px; border-radius: 8px; border: 1px solid var(--border); }
    .an-stat-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 4px; }
    .an-stat-value { font-size: 18px; font-weight: 800; color: var(--text); }
    .an-stat-value.green { color: var(--success); }
    .an-stat-value.blue { color: var(--primary); }
    .an-stat-value.orange { color: var(--warning); }
    .an-stat-value.red { color: var(--danger); }
    .an-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .an-table th, .an-table td { padding: 6px 4px; text-align: left; border-bottom: 1px solid var(--border); }
    .an-table th { font-size: 10px; color: var(--muted); text-transform: uppercase; font-weight: 700; }
    .an-table td.an-num { text-align: right; font-variant-numeric: tabular-nums; }
    .an-bar-wrap { position: relative; height: 22px; background: var(--bg); border-radius: 4px; overflow: hidden; border: 1px solid var(--border); }
    .an-bar-fill { height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); border-radius: 4px; }
    .an-bar-row { margin-bottom: 8px; }
    .an-bar-header { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 3px; }
    .an-filter-row { display: flex; gap: 4px; margin-bottom: 10px; flex-wrap: wrap; }
    .an-filter-btn {
      flex: 1; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px;
      background: var(--bg); color: var(--text); font-size: 11px; font-weight: 600;
      cursor: pointer; min-height: 30px; min-width: 60px;
    }
    .an-filter-btn.active { background: var(--primary); color: #fff; border-color: var(--primary); }
    .an-audit-item { padding: 8px 10px; margin-bottom: 6px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
    .an-audit-meta { font-size: 10px; color: var(--muted); margin-bottom: 3px; display: flex; gap: 8px; flex-wrap: wrap; }
    .an-audit-meta .an-audit-user { color: #93c5fd; font-weight: 600; }
    .an-audit-text { color: var(--text); font-weight: 500; line-height: 1.3; }
    .an-empty { color: var(--muted); text-align: center; padding: 20px; font-size: 12px; }
    .an-warning {
      background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 6px; padding: 8px 10px; font-size: 11px; color: #fca5a5;
      margin-bottom: 10px; line-height: 1.4;
    }
  `;
  document.head.appendChild(css);

  // ===== Хелперы =====
  function isGaiTruck(id) {
    try {
      const t = (typeof findTruck === 'function') ? findTruck(id) : null;
      return !!(t && t.isGAI);
    } catch(e) { return false; }
  }

  function getShiftLogs() {
    const shiftId = state.shift ? state.shift.id : null;
    return shiftId ? state.logs.filter(l => l.shiftId === shiftId) : [];
  }

  function calcTruckCycles(truckId, logs) {
    const truckLogs = logs.filter(l => l.truckId === truckId && !l.isGAI).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    if (truckLogs.length < 2) return [];
    const cycles = [];
    for (let i = 1; i < truckLogs.length; i++) {
      const d = (truckLogs[i].timestamp || 0) - (truckLogs[i - 1].timestamp || 0);
      if (d > 60000 && d < 4 * 3600000) cycles.push(d);
    }
    return cycles;
  }

  function formatDuration(ms) {
    if (!ms) return '—';
    const m = Math.floor(ms / 60000);
    if (m < 60) return m + 'м';
    const h = Math.floor(m / 60);
    return h + 'ч ' + (m % 60) + 'м';
  }

  function parseDate(dateStr) {
    if (!dateStr) return null;
    let m = dateStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return { day: +m[1], month: +m[2], year: +m[3] };
    m = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return { day: +m[3], month: +m[2], year: +m[1] };
    return null;
  }

  // ===== Блоки =====

  function renderCurrentShiftStats() {
    if (!state.shift) {
      return `<div class="an-section"><div class="an-title">📊 Текущая смена</div><div class="an-empty">Смена не начата</div></div>`;
    }
    const logs = getShiftLogs();
    // ТОЛЬКО обычные рейсы
    const stdLogs = logs.filter(l => !l.isGAI);
    const totalVol = stdLogs.reduce((s, l) => s + (l.volume || 0), 0);

    let duration = '—';
    if (state.shift.startedAt) {
      const ms = Date.now() - state.shift.startedAt;
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      duration = h > 0 ? `${h}ч ${m}м` : `${m}м`;
    }

    const cyc = (settings.cycleMinutes || 15);

    // Циклы — только по обычным машинам
    const cyclesIds = new Set();
    Object.keys(state.truckStatus).forEach(id => {
      const st = state.truckStatus[id];
      if (st && st.onLine && !isGaiTruck(id)) cyclesIds.add(id);
    });
    // Рейсы — только не-ГАИ
    stdLogs.forEach(l => cyclesIds.add(l.truckId));

    const allCycles = [];
    cyclesIds.forEach(id => allCycles.push(...calcTruckCycles(id, logs)));

    const avgCycle = allCycles.length ? allCycles.reduce((a, b) => a + b, 0) / allCycles.length : null;
    const avgCycleStr = avgCycle ? formatDuration(avgCycle) : '—';
    const avgClass = !avgCycle ? '' : (avgCycle <= cyc * 60000 ? 'green' : avgCycle <= cyc * 1.3 * 60000 ? 'orange' : 'red');

    // На линии — только обычные
    const activeLine = Object.keys(state.truckStatus).filter(id => {
      const st = state.truckStatus[id];
      return st && st.onLine && !isGaiTruck(id);
    }).length;

    return `
      <div class="an-section">
        <div class="an-title">📊 Текущая смена</div>
        <div class="an-grid">
          <div class="an-stat"><div class="an-stat-label">Объект</div><div class="an-stat-value" style="font-size:14px;">${escapeHtml(state.shift.objectName || '—')}</div></div>
          <div class="an-stat"><div class="an-stat-label">Длительность</div><div class="an-stat-value">${duration}</div></div>
          <div class="an-stat"><div class="an-stat-label">Рейсов</div><div class="an-stat-value blue">${stdLogs.length}</div></div>
          <div class="an-stat"><div class="an-stat-label">Объём</div><div class="an-stat-value green">${totalVol} м³</div></div>
          <div class="an-stat"><div class="an-stat-label">Средний цикл</div><div class="an-stat-value ${avgClass}">${avgCycleStr}</div></div>
          <div class="an-stat"><div class="an-stat-label">Норма</div><div class="an-stat-value">${cyc}м</div></div>
          <div class="an-stat"><div class="an-stat-label">На линии</div><div class="an-stat-value">${activeLine}</div></div>
        </div>
      </div>
    `;
  }

  function renderCycles() {
    const logs = getShiftLogs();
    const cyc = (settings.cycleMinutes || 15) * 60000;

    const ids = new Set();
    Object.keys(state.truckStatus).forEach(id => {
      const st = state.truckStatus[id];
      if (st && st.onLine && !isGaiTruck(id)) ids.add(id);
    });
    // Только обычные рейсы
    logs.forEach(l => { if (!l.isGAI) ids.add(l.truckId); });
    // Дополнительная страховка — исключить ГАИ-id
    Array.from(ids).forEach(id => { if (isGaiTruck(id)) ids.delete(id); });

    if (!ids.size) {
      return `<div class="an-section"><div class="an-title">⏱ Циклы по самосвалам</div><div class="an-empty">Нет данных</div></div>`;
    }

    const rows = [];
    ids.forEach(id => {
      const t = (typeof findTruck === 'function') ? findTruck(id) : null;
      const cycles = calcTruckCycles(id, logs);
      const avg = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null;
      const tripsCount = logs.filter(l => l.truckId === id && !l.isGAI).length;
      rows.push({ id, t, avg, tripsCount });
    });
    rows.sort((a, b) => (b.avg || 0) - (a.avg || 0));
    const maxAvg = Math.max.apply(null, rows.map(r => r.avg || 0).concat([1]));

    return `
      <div class="an-section">
        <div class="an-title">⏱ Циклы по самосвалам (норма ${Math.round(cyc/60000)}м)</div>
        ${rows.map(r => {
          const name = r.t ? (r.t.brand + ' ' + r.t.number) : r.id;
          const avgStr = r.avg ? formatDuration(r.avg) : '—';
          const pct = r.avg ? Math.min(100, (r.avg / maxAvg) * 100) : 0;
          const color = !r.avg ? '#64748b' : (r.avg <= cyc ? '#22c55e' : r.avg <= cyc * 1.3 ? '#f59e0b' : '#ef4444');
          return `
            <div class="an-bar-row">
              <div class="an-bar-header">
                <span>${escapeHtml(name)}</span>
                <span style="font-weight:700; color:${color};">${avgStr} · ${r.tripsCount} рейс</span>
              </div>
              <div class="an-bar-wrap"><div class="an-bar-fill" style="width:${pct}%; background: ${color};"></div></div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderTopTrucks() {
    const cutoff = Date.now() - 30 * 86400000;
    const recent = (state.archive || []).filter(s => (s.closedAt || 0) >= cutoff);

    if (!recent.length) {
      return `<div class="an-section"><div class="an-title">🏆 Топ самосвалов (30 дней)</div><div class="an-empty">Нет данных</div></div>`;
    }

    const byTruck = {};
    recent.forEach(s => {
      (s.logs || []).forEach(l => {
        if (l.isGAI) return; // ← без ГАИ
        const key = l.truckId || l.truckName || '?';
        if (!byTruck[key]) byTruck[key] = { name: l.truckName || key, trips: 0, volume: 0 };
        byTruck[key].trips++;
        byTruck[key].volume += (l.volume || 0);
      });
    });

    const sorted = Object.values(byTruck).sort((a, b) => b.trips - a.trips).slice(0, 10);
    if (!sorted.length) {
      return `<div class="an-section"><div class="an-title">🏆 Топ самосвалов (30 дней)</div><div class="an-empty">Нет данных</div></div>`;
    }

    return `
      <div class="an-section">
        <div class="an-title">🏆 Топ самосвалов (30 дней)</div>
        <table class="an-table">
          <thead><tr><th>#</th><th>Самосвал</th><th class="an-num">Рейсов</th><th class="an-num">Объём</th></tr></thead>
          <tbody>
            ${sorted.map((t, i) => `
              <tr>
                <td><b>${i + 1}</b></td>
                <td>${escapeHtml(t.name)}</td>
                <td class="an-num"><b>${t.trips}</b></td>
                <td class="an-num">${t.volume} м³</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderMonthly() {
    const byMonth = {};
    (state.archive || []).forEach(s => {
      const p = parseDate(s.date);
      if (!p) return;
      const key = p.year + '-' + String(p.month).padStart(2, '0');
      if (!byMonth[key]) byMonth[key] = { shifts: 0, trips: 0, volume: 0 };
      byMonth[key].shifts++;
      // ← без ГАИ
      const logs = (s.logs || []).filter(l => !l.isGAI);
      byMonth[key].trips += logs.length;
      byMonth[key].volume += logs.reduce((sum, l) => sum + (l.volume || 0), 0);
    });

    const months = Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6);
    if (!months.length) {
      return `<div class="an-section"><div class="an-title">📅 Месячная статистика</div><div class="an-empty">Нет данных</div></div>`;
    }

    return `
      <div class="an-section">
        <div class="an-title">📅 Месячная статистика</div>
        <table class="an-table">
          <thead><tr><th>Месяц</th><th class="an-num">Смен</th><th class="an-num">Рейсов</th><th class="an-num">Объём</th></tr></thead>
          <tbody>
            ${months.map(m => `
              <tr>
                <td><b>${m[0]}</b></td>
                <td class="an-num">${m[1].shifts}</td>
                <td class="an-num">${m[1].trips}</td>
                <td class="an-num">${m[1].volume} м³</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderUserActivity() {
    const cutoff = Date.now() - 7 * 86400000;
    const recent = (state.audit || []).filter(a => (a.timestamp || 0) >= cutoff);

    if (!recent.length) {
      return `<div class="an-section"><div class="an-title">👥 Активность (7 дней)</div><div class="an-empty">Нет данных</div></div>`;
    }

    const byUser = {};
    recent.forEach(a => {
      const u = a.userName || a.createdBy || '—';
      byUser[u] = (byUser[u] || 0) + 1;
    });
    const sorted = Object.entries(byUser).sort((a, b) => b[1] - a[1]);
    const maxVal = Math.max.apply(null, sorted.map(x => x[1]).concat([1]));

    return `
      <div class="an-section">
        <div class="an-title">👥 Активность (7 дней)</div>
        ${sorted.map(x => {
          const pct = (x[1] / maxVal) * 100;
          return `
            <div class="an-bar-row">
              <div class="an-bar-header">
                <span>👤 ${escapeHtml(x[0])}</span>
                <span style="font-weight:700; color:#93c5fd;">${x[1]} действий</span>
              </div>
              <div class="an-bar-wrap"><div class="an-bar-fill" style="width:${pct}%; background:#3b82f6;"></div></div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  let auditPeriod = 'today';

  function renderAuditLog() {
    let cutoff = 0;
    const now = Date.now();
    if (auditPeriod === 'today') cutoff = now - 86400000;
    else if (auditPeriod === 'week') cutoff = now - 7 * 86400000;
    else if (auditPeriod === 'month') cutoff = now - 30 * 86400000;

    const items = (state.audit || []).filter(a => (a.timestamp || 0) >= cutoff);

    if (!items.length) return '<div class="an-empty">Нет записей за выбранный период</div>';

    return items.slice(0, 200).map(a => {
      const user = a.userName || a.createdBy || a.userEmail || '—';
      const objName = a.objectName && a.objectName !== '—' ? a.objectName : '';
      return `
        <div class="an-audit-item">
          <div class="an-audit-meta">
            <span>${escapeHtml(a.timeStr || new Date(a.timestamp || 0).toLocaleString('ru-RU'))}</span>
            <span class="an-audit-user">👤 ${escapeHtml(user)}</span>
            ${objName ? `<span>🏢 ${escapeHtml(objName)}</span>` : ''}
          </div>
          <div class="an-audit-text">${escapeHtml(a.text || '')}</div>
        </div>
      `;
    }).join('');
  }

  // ===== Main render =====
  let lastRender = 0;
  window.renderAnalytics = function(force) {
    const now = Date.now();
    if (!force && now - lastRender < 500) return;
    lastRender = now;

    if (typeof hasTabAccess === 'function' && !hasTabAccess('analytics')) return;

    const tab = document.getElementById('tab-analytics');
    if (!tab) return;

    tab.innerHTML = `
      <div class="section-title">📊 Аналитика</div>
      ${renderCurrentShiftStats()}
      ${renderCycles()}
      ${renderTopTrucks()}
      ${renderMonthly()}
      ${renderUserActivity()}
      <div class="section-title">📝 Журнал действий</div>
      <div class="an-warning">⚠️ Журнал нельзя очистить. Записываются все действия всех пользователей.</div>
      <div class="an-filter-row" id="auditFilterRow">
        <button class="an-filter-btn ${auditPeriod === 'today' ? 'active' : ''}" data-period="today">Сегодня</button>
        <button class="an-filter-btn ${auditPeriod === 'week' ? 'active' : ''}" data-period="week">Неделя</button>
        <button class="an-filter-btn ${auditPeriod === 'month' ? 'active' : ''}" data-period="month">Месяц</button>
        <button class="an-filter-btn ${auditPeriod === 'all' ? 'active' : ''}" data-period="all">Все</button>
      </div>
      <div id="auditLogContainer">${renderAuditLog()}</div>
    `;

    tab.querySelectorAll('#auditFilterRow .an-filter-btn').forEach(btn => {
      btn.onclick = () => { auditPeriod = btn.dataset.period; window.renderAnalytics(true); };
    });
  };

  setTimeout(() => {
    if (document.getElementById('tab-analytics')?.classList.contains('active')) {
      window.renderAnalytics(true);
    }
  }, 500);

  console.log('[analytics-v2] ✅ Активен. ГАИ исключён из всех расчётов.');
})();; }
catch (e) { console.error('[baked patch: Расширенная аналитики и аудит]', e); }
try { (function(){
  if (window.__resetHoldV5) return;
  window.__resetHoldV5 = true;

  // ===== Значение по умолчанию для holdResetCycle =====
  (function initDefault() {
    try {
      const stored = JSON.parse(localStorage.getItem('dt_settings') || '{}');
      if (typeof stored.holdResetCycle === 'undefined') {
        stored.holdResetCycle = 0.5;
        localStorage.setItem('dt_settings', JSON.stringify(stored));
      }
    } catch(e) {}
  })();

  function getHoldResetCycle() {
    try {
      const stored = JSON.parse(localStorage.getItem('dt_settings') || '{}');
      const v = parseFloat(stored.holdResetCycle);
      return (!isNaN(v) && v >= 0.1) ? v : 0.5;
    } catch(e) { return 0.5; }
  }

  // ===== CSS =====
  ['reset-via-cooldown-css', 'reset-hold-css', 'reset-hold-v4-css', 'reset-hold-v5-css'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });

  const css = document.createElement('style');
  css.id = 'reset-hold-v5-css';
  css.textContent = `
    /* Кнопка Ходка в кулдауне для админа — выглядит как у лопатёров */
    .btn-arrive.admin-can-hold {
      background: #475569 !important;
      color: #94a3b8 !important;
      opacity: 0.6 !important;
      cursor: pointer !important;
      pointer-events: auto !important;
      touch-action: none !important;
      position: relative !important;
      overflow: hidden !important;
      user-select: none !important;
      -webkit-user-select: none !important;
    }
    /* Прогресс-бар удержания — фиолетовый */
    .btn-arrive.admin-can-hold::after {
      content: "" !important;
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      bottom: 0 !important;
      background: rgba(139, 92, 246, 0.6) !important;
      width: 0% !important;
      z-index: 0 !important;
      pointer-events: none !important;
    }
    .btn-arrive.admin-can-hold.admin-holding::after {
      width: 100% !important;
      transition: width var(--hold-duration, 0.5s) linear !important;
    }
    .btn-arrive.admin-can-hold > span {
      position: relative !important;
      z-index: 1 !important;
    }
    /* Лёгкое сжатие при нажатии, без изменения цвета */
    .btn-arrive.admin-can-hold:active {
      transform: scale(0.98) !important;
    }
  `;
  document.head.appendChild(css);

  // ===== Функция сброса =====
  window.resetCycleViaCooldown = async function(truckId) {
    if (!canAdmin()) { showError('Только для администратора'); return; }
    const st = state.truckStatus[truckId];
    if (!st) return;
    const t = findTruck(truckId);
    const tName = t ? `${t.brand} ${t.number}` : 'Машина';

    let ok;
    if (typeof window.showConfirmModal === 'function') {
      ok = await window.showConfirmModal(
        'Сбросить таймер ходки?',
        `Машина <b>${tName}</b> недавно грузилась. Сброс обнулит таймер, и кнопка «Приехал» станет доступна сразу.`,
        { confirmLabel: '🔄 Да, сбросить', cancelLabel: 'Отмена', danger: true, icon: '⏱' }
      );
    } else {
      ok = (await appConfirm(`Сбросить таймер ходки для ${tName}?`));
    }
    if (!ok) return;

    offlineQueueAction('reset',truckId,captureLineIntent(truckId));
  };

  // ===== Удержание =====
  const holdState = { truckId: null, btn: null, timer: null, vibInt: null, pointerId: null };

  function startHold(truckId, btn, pointerId) {
    cancelHold(true);
    holdState.truckId = truckId;
    holdState.btn = btn;
    holdState.pointerId = pointerId;

    const hs = getHoldResetCycle();

    if (navigator.vibrate) {
      try { navigator.vibrate(20); } catch(e) {}
      holdState.vibInt = setInterval(() => { try { navigator.vibrate(25); } catch(e) {} }, 120);
    }

    btn.style.setProperty('--hold-duration', hs + 's');
    btn.classList.add('admin-holding');

    holdState.timer = setTimeout(() => {
      const tid = holdState.truckId;
      finishHold();
      if (tid) window.resetCycleViaCooldown(tid);
    }, hs * 1000);
  }

  function cancelHold(removeClass) {
    if (holdState.timer) { clearTimeout(holdState.timer); holdState.timer = null; }
    if (holdState.vibInt) { clearInterval(holdState.vibInt); holdState.vibInt = null; }
    if (removeClass !== false && holdState.btn) {
      try { holdState.btn.classList.remove('admin-holding'); } catch(e) {}
    }
    holdState.truckId = null;
    holdState.btn = null;
    holdState.pointerId = null;
  }

  function finishHold() {
    if (holdState.timer) { clearTimeout(holdState.timer); holdState.timer = null; }
    if (holdState.vibInt) { clearInterval(holdState.vibInt); holdState.vibInt = null; }
    if (holdState.btn) { try { holdState.btn.classList.remove('admin-holding'); } catch(e) {} }
    holdState.truckId = null;
    holdState.btn = null;
    holdState.pointerId = null;
  }

  function isCooldownArrive(btn) {
    if (!btn) return false;
    if (btn.querySelector('[data-load-ts]')) return true;
    if (btn.querySelector('.cooldown-timer')) return true;
    if ((btn.textContent || '').includes('Ходка')) return true;
    return false;
  }

  document.addEventListener('pointerdown', (e) => {
    if (!canAdmin()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const btn = e.target.closest('.btn-arrive');
    if (!btn) return;
    if (!isCooldownArrive(btn)) return;
    const card = btn.closest('.truck-card[data-truck-id]');
    if (!card) return;
    const truckId = card.dataset.truckId;
    if (!truckId) return;
    e.preventDefault();
    e.stopPropagation();
    startHold(truckId, btn, e.pointerId);
  }, { capture: true, passive: false });

  document.addEventListener('pointerup', (e) => {
    if (holdState.pointerId === e.pointerId) cancelHold();
  }, { capture: true });

  document.addEventListener('pointercancel', (e) => {
    if (holdState.pointerId === e.pointerId) cancelHold();
  }, { capture: true });

  // ===== Отметка кнопок =====
  function markCooldownButtons() {
    const list = document.getElementById('trucksLineList');
    if (!list) return;
    list.querySelectorAll('.truck-card[data-truck-id] .btn-arrive').forEach(btn => {
      if (isCooldownArrive(btn)) {
        if (canAdmin()) btn.classList.add('admin-can-hold');
        else btn.classList.remove('admin-can-hold');
      } else {
        btn.classList.remove('admin-can-hold');
      }
    });
  }

  let listObs = null;
  function attachObs() {
    const list = document.getElementById('trucksLineList');
    if (!list || list.dataset.resetObsV5 === '1') return;
    list.dataset.resetObsV5 = '1';
    if (listObs) listObs.disconnect();
    listObs = new MutationObserver(() => markCooldownButtons());
    listObs.observe(list, { childList: true, subtree: true });
  }

  const origRenderLine = window.renderLine;
  if (origRenderLine) {
    window.renderLine = function() {
      origRenderLine.apply(this, arguments);
      setTimeout(markCooldownButtons, 20);
      setTimeout(markCooldownButtons, 100);
      setTimeout(markCooldownButtons, 300);
    };
  }

  setInterval(() => { attachObs(); markCooldownButtons(); }, 500);
  setTimeout(attachObs, 100);
  setTimeout(markCooldownButtons, 500);
  setTimeout(markCooldownButtons, 1500);

  // ===== Настройка в шестерёнке (только админ) =====
  function addSettingToModal() {
    if (!canAdmin()) return;
    const modalBody = document.querySelector('#settingsModal .modal-body');
    if (!modalBody) return;
    if (document.getElementById('setting-hold-reset-group')) return;

    const group = document.createElement('div');
    group.className = 'form-group';
    group.id = 'setting-hold-reset-group';
    group.innerHTML = `
      <label>🔄 Удержание «Сброс таймера» (сек)</label>
      <input type="number" step="0.1" min="0.1" max="5" id="settingHoldResetCycle" class="form-control">
      <div style="font-size:10px;color:var(--muted);margin-top:4px;">Только для админа. Кнопка «Ходка» при активном таймере.</div>
    `;

    const cycleGroup = document.getElementById('settingCycleMinutes')?.closest('.form-group');
    if (cycleGroup && cycleGroup.parentNode === modalBody) {
      cycleGroup.parentNode.insertBefore(group, cycleGroup.nextSibling);
    } else {
      modalBody.appendChild(group);
    }

    const inp = group.querySelector('#settingHoldResetCycle');
    inp.value = getHoldResetCycle();

    inp.addEventListener('change', () => {
      let v = parseFloat(inp.value);
      if (isNaN(v)) v = 0.5;
      v = Math.max(0.1, Math.min(5, v));
      v = Math.round(v * 10) / 10;

      const stored = JSON.parse(localStorage.getItem('dt_settings') || '{}');
      stored.holdResetCycle = v;
      localStorage.setItem('dt_settings', JSON.stringify(stored));
      settings.holdResetCycle = v;
      inp.value = v;

      if (window.showToastEl) window.showToastEl('⏱ Удержание сброса: ' + v + 'с', false);
    });
  }

  const origOpenSettings = window.openSettingsModal;
  window.openSettingsModal = function() {
    if (origOpenSettings) origOpenSettings.apply(this, arguments);
    setTimeout(addSettingToModal, 30);
    setTimeout(addSettingToModal, 150);
  };

  console.log('[reset-hold-v5] ✅ Активен. Настройка удержания (админ).');
})();; }
catch (e) { console.error('[baked patch: Сброс таймера]', e); }
try { (function(){
  if (window.__patchExportV2) return;
  window.__patchExportV2 = true;

  // === CSS ===
  const oldCss = document.getElementById('patch-export-css');
  if (oldCss) oldCss.remove();

  const css = document.createElement('style');
  css.id = 'patch-export-css';
  css.textContent = `
    #patchExportBtn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      font-size: 11px;
      font-weight: 700;
      background: rgba(59, 130, 246, 0.15);
      border: 1px solid rgba(59, 130, 246, 0.4);
      color: #93c5fd;
      border-radius: 6px;
      cursor: pointer;
      margin-bottom: 10px;
      -webkit-tap-highlight-color: transparent;
      min-height: 30px;
    }
    #patchExportBtn:active {
      background: rgba(59, 130, 246, 0.3);
      transform: scale(0.97);
    }
    .pe-modal-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    .pe-modal-actions button {
      flex: 1;
      min-height: 44px;
      font-size: 13px;
    }
  `;
  document.head.appendChild(css);

  // === Получить активные патчи ===
  async function getEnabledPatches() {
    try {
      const snap = await refs.patches.where('enabled', '==', true).get();
      const arr = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      arr.sort((a, b) => (a.order || 0) - (b.order || 0));
      return arr;
    } catch (e) {
      console.warn('[patch-export] Firestore read failed', e);
      return (state.patches || []).filter(p => p && p.enabled)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
    }
  }

  function escapeScriptTag(code) {
    return String(code == null ? '' : code).replace(/<\/script/gi, '<\\/script');
  }
  function safeName(s) {
    return String(s == null ? '' : s).replace(/\*\//g, '* /');
  }

  function resetDomClone(clone) {
    const ao = clone.querySelector('#authOverlay');
    if (ao) ao.style.display = 'flex';

    ['#pendingScreen', '#disabledScreen'].forEach(sel => {
      const el = clone.querySelector(sel);
      if (el) el.style.display = 'none';
    });

    ['#mainHeader', '.container', 'nav'].forEach(sel => {
      const el = clone.querySelector(sel);
      if (el) el.style.display = '';
    });

    [
      '#trucksLineList', '#logsContainer', '#archiveContainer', '#trashContainer',
      '#plugin-tabs-container', '#matrixTableBody', '#matrixTableHeadRow',
      '#gaiTableBody', '#gaiTableHeadRow', '#usersListContainer',
      '#requestsListContainer', '#globalTrucksManageList', '#globalObjectsManageList',
      '#auditLogContainer', '#patchesListContainer', '#pluginsListContainer',
      '#consoleView', '#selectorListContainer', '#existingObjectsList',
      '#changeObjList', '#statusTicker'
    ].forEach(sel => {
      const el = clone.querySelector(sel);
      if (el) el.innerHTML = '';
    });

    const ticker = clone.querySelector('#statusTicker');
    if (ticker) ticker.style.display = 'none';

    clone.querySelectorAll('.dynamic-nav-btn').forEach(el => el.remove());
    clone.querySelectorAll('.tab-content[id^="tab-plugin-"]').forEach(el => el.remove());

    clone.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    clone.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

    const lineTab = clone.querySelector('#tab-line');
    if (lineTab) lineTab.classList.add('active');
    const lineNav = clone.querySelector('#nav-line');
    if (lineNav) lineNav.classList.add('active');

    const userBadge = clone.querySelector('#userBadgeLabel');
    if (userBadge) userBadge.textContent = '👤 Не в сети';
    const syncDot = clone.querySelector('#syncDot');
    if (syncDot) syncDot.className = 'sync-dot init';
    const syncBadge = clone.querySelector('#syncBadge');
    if (syncBadge) syncBadge.classList.remove('show');

    const shiftDate = clone.querySelector('#shiftDate');
    if (shiftDate) shiftDate.textContent = 'Смена не начата';
    const headerObject = clone.querySelector('#headerObject');
    if (headerObject) headerObject.textContent = 'Объект: Не выбран';

    ['#activeLineCount', '#totalTrips', '#totalVolume'].forEach((sel, idx) => {
      const el = clone.querySelector(sel);
      if (el) el.textContent = idx === 0 ? '0 маш.' : (idx === 1 ? '0' : '0 м³');
    });

    clone.querySelectorAll('#patchExportBtn').forEach(el => el.remove());
    clone.querySelectorAll('#patchExportModal').forEach(el => el.remove());
  }

  async function buildBakedHtml() {
    let html;
    let fromFetch = false;

    try {
      const resp = await fetch(location.href, { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      html = await resp.text();
      fromFetch = true;
    } catch (e) {
      console.warn('[patch-export] fetch failed:', e);
      const clone = document.documentElement.cloneNode(true);
      resetDomClone(clone);
      html = '<!DOCTYPE html>\n' + clone.outerHTML;
    }

    if (window.TestPWA) html = await window.TestPWA.inlineHtml(html);

    const patches = await getEnabledPatches();
    let replaceOk = 0, replaceFail = 0;
    const fnPatches = [];

    for (const p of patches) {
      try {
        if (p.type === 'replace') {
          if (!p.findText) { replaceFail++; continue; }
          if (html.indexOf(p.findText) === -1) {
            replaceFail++;
            console.warn('[patch-export] not found:', p.name);
            continue;
          }
          html = html.replace(p.findText, p.replaceText || '');
          replaceOk++;
        } else if (p.type === 'function') {
          if (!p.code) continue;
          fnPatches.push({ name: p.name || 'без имени', code: p.code });
        }
      } catch (e) {
        console.warn('[patch-export] patch error:', p.name, e);
      }
    }

    if (fnPatches.length) {
      const bakedCode = fnPatches.map(fp => {
        const n = safeName(fp.name);
        const safeCode = escapeScriptTag(fp.code);
        return `/* ===== PATCH: ${n} ===== */\n` +
               `try { (0, eval)(${JSON.stringify(safeCode)}); }\n` +
               `catch (e) { console.error('[baked patch: ${n}]', e); }`;
      }).join('\n\n');

      const bakedBlock =
        '\n<!-- === BAKED PATCHES START === -->\n' +
        '<script>\n' + bakedCode + '\n<\/script>\n' +
        '<!-- === BAKED PATCHES END === -->\n';

      html = html.replace(
        /<!-- === BAKED PATCHES START === -->[\s\S]*?<!-- === BAKED PATCHES END === -->/g,
        ''
      );

      const idx = html.lastIndexOf('</body>');
      if (idx === -1) html += bakedBlock;
      else html = html.slice(0, idx) + bakedBlock + html.slice(idx);
    }

    return { html, replaceOk, replaceFail, fnCount: fnPatches.length, fromFetch };
  }

  function downloadHtml(html, filename) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  }

  function timestamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' + pad(d.getHours()) + '-' + pad(d.getMinutes());
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      console.warn('[patch-export] clipboard failed:', e);
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) return true;
    } catch (e) {
      console.warn('[patch-export] execCommand failed:', e);
    }
    showCopyFallback(text);
    return false;
  }

  function showCopyFallback(text) {
    const old = document.getElementById('copyFallbackModal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'copyFallbackModal';
    overlay.className = 'modal open';
    overlay.style.zIndex = '10025';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '720px';
    content.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="font-size:16px;">📋 Скопируйте вручную</h3>
        <button class="btn-del" onclick="document.getElementById('copyFallbackModal').remove()">✕</button>
      </div>
      <div style="font-size:12px; color:var(--muted); margin-bottom:8px; line-height:1.4;">
        Браузер не дал доступ к буферу обмена. Выделите весь код ниже и скопируйте
        (Ctrl+A → Ctrl+C на компьютере, или долгое нажатие → «Выделить всё» → «Копировать»).
      </div>
      <textarea id="copyFallbackTextarea" class="form-control" style="min-height:300px; font-family:monospace; font-size:11px;"></textarea>
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="btn btn-secondary" style="flex:1;" onclick="document.getElementById('copyFallbackModal').remove()">Закрыть</button>
        <button class="btn btn-quick" style="flex:1;" id="copyFallbackSelectBtn">📋 Выделить всё</button>
      </div>
    `;
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const ta = content.querySelector('#copyFallbackTextarea');
    ta.value = text;
    setTimeout(() => { ta.focus(); ta.select(); }, 100);

    content.querySelector('#copyFallbackSelectBtn').onclick = () => {
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); } catch(e) {}
    };
  }

  // === Модалка ===
  function openExportModal() {
    const old = document.getElementById('patchExportModal');
    if (old) old.remove();

    const all = state.patches || [];
    const enabled = all.filter(p => p && p.enabled);
    const r = enabled.filter(p => p.type === 'replace').length;
    const f = enabled.filter(p => p.type === 'function').length;

    const overlay = document.createElement('div');
    overlay.id = 'patchExportModal';
    overlay.className = 'modal open';
    overlay.style.zIndex = '10020';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '480px';
    content.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="font-size:16px;">💾 Экспорт index.html</h3>
        <button class="btn-del" onclick="document.getElementById('patchExportModal').remove()">✕</button>
      </div>

      <div style="font-size:12px; color:var(--muted); line-height:1.5; margin-bottom:12px;">
        Соберёт HTML-файл, в котором <b style="color:var(--text);">уже применены все активные патчи</b>.
        Загрузите его на сервер — после этого патчи можно удалить из базы.
      </div>

      <div style="background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 12px; margin-bottom: 12px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
          <span style="color:var(--muted);">Активных патчей:</span>
          <b>${enabled.length}</b>
        </div>
        <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
          <span style="color:var(--muted);">Replace (найти/заменить):</span>
          <b style="color:var(--warning);">${r}</b>
        </div>
        <div style="display:flex; justify-content:space-between;">
          <span style="color:var(--muted);">Function (вшить в код):</span>
          <b style="color:var(--success);">${f}</b>
        </div>
      </div>

      <div class="pe-modal-actions">
        <button class="btn btn-secondary" id="peDownloadBtn">⬇️ Скачать</button>
        <button class="btn btn-quick" id="peCopyBtn">📋 Копировать</button>
      </div>

      <div style="font-size:10px; color:var(--muted); text-align:center; margin-top:10px; line-height:1.4;">
        ⚠️ После загрузки на сервер удалите или отключите все патчи в админке — они уже вшиты в файл.
      </div>
    `;
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    content.querySelector('#peDownloadBtn').onclick = async () => {
      const btn = content.querySelector('#peDownloadBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Сборка...';
      try {
        const res = await buildBakedHtml();
        const filename = 'index_baked_' + timestamp() + '.html';
        downloadHtml(res.html, filename);
        overlay.remove();
        if (typeof showToastEl === 'function') {
          showToastEl(
            '✅ ' + filename + '<br>' +
            'replace: ' + res.replaceOk + (res.replaceFail ? ' · не найдено: ' + res.replaceFail : '') + '<br>' +
            'функций вшито: ' + res.fnCount,
            false
          );
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '⬇️ Скачать';
        if (typeof showError === 'function') showError('Ошибка сборки: ' + e.message);
      }
    };

    content.querySelector('#peCopyBtn').onclick = async () => {
      const btn = content.querySelector('#peCopyBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Сборка...';
      try {
        const res = await buildBakedHtml();
        const ok = await copyToClipboard(res.html);
        if (ok) {
          overlay.remove();
          if (typeof showToastEl === 'function') {
            showToastEl(
              '📋 Скопировано в буфер<br>' +
              'replace: ' + res.replaceOk + (res.replaceFail ? ' · не найдено: ' + res.replaceFail : '') + '<br>' +
              'функций вшито: ' + res.fnCount,
              false
            );
          }
        } else {
          btn.disabled = false;
          btn.textContent = '📋 Копировать';
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '📋 Копировать';
        if (typeof showError === 'function') showError('Ошибка сборки: ' + e.message);
      }
    };
  }

  // === Маленькая кнопка ===
  function addExportButton() {
    const section = document.getElementById('admin-sub-patches');
    if (!section) return;
    if (document.getElementById('patchExportBtn')) return;

    const list = document.getElementById('patchesListContainer');
    if (!list || !list.parentNode) return;

    const btn = document.createElement('button');
    btn.id = 'patchExportBtn';
    btn.innerHTML = '💾 Экспорт HTML';
    btn.onclick = openExportModal;

    list.parentNode.insertBefore(btn, list);
  }

  // === Перехват switchAdminTab ===
  const origSwitch = window.switchAdminTab;
  window.switchAdminTab = function(tab, btn) {
    if (origSwitch) origSwitch.apply(this, arguments);
    if (tab === 'patches') {
      setTimeout(addExportButton, 50);
    }
  };

  // === MutationObserver ===
  const obs = new MutationObserver(() => {
    if (document.getElementById('admin-sub-patches')?.classList.contains('active')) {
      if (!document.getElementById('patchExportBtn')) addExportButton();
    }
  });
  setTimeout(() => {
    const list = document.getElementById('patchesListContainer');
    if (list) obs.observe(list, { childList: true, subtree: true });
  }, 500);

  // === Интервал-страховка ===
  setInterval(() => {
    if (document.getElementById('admin-sub-patches')?.classList.contains('active')) {
      if (!document.getElementById('patchExportBtn')) addExportButton();
    }
  }, 1500);

  // === Первый запуск ===
  setTimeout(() => {
    if (document.getElementById('admin-sub-patches')?.classList.contains('active')) addExportButton();
  }, 800);

  console.log('[patch-export-v2] ✅ Активен. Компактная кнопка → модалка.');
})();; }
catch (e) { console.error('[baked patch: Скачать нтмл]', e); }
try { (function(){
  if (window.__patchesUIv1) return;
  window.__patchesUIv1 = true;

  // ===== CSS =====
  const oldCss = document.getElementById('patches-ui-css');
  if (oldCss) oldCss.remove();

  const css = document.createElement('style');
  css.id = 'patches-ui-css';
  css.textContent = `
    /* Компактный вид */
    #patchesListContainer .patch-row {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 10px; margin-bottom: 6px;
      background: var(--card); border: 1px solid var(--border); border-radius: 8px;
      transition: all 0.15s; cursor: pointer;
    }
    #patchesListContainer .patch-row.selected {
      background: rgba(59, 130, 246, 0.1); border-color: var(--primary);
    }
    #patchesListContainer .patch-row.disabled { opacity: 0.55; }
    #patchesListContainer .patch-check {
      width: 18px; height: 18px; accent-color: var(--primary);
      flex-shrink: 0; cursor: pointer;
    }
    #patchesListContainer .patch-info { flex: 1 1 auto; min-width: 0; overflow: hidden; }
    #patchesListContainer .patch-name {
      font-size: 13px; font-weight: 700;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #patchesListContainer .patch-type {
      font-size: 10px; margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #patchesListContainer .patch-type.fn { color: var(--success); }
    #patchesListContainer .patch-type.rep { color: var(--warning); }
    #patchesListContainer .patch-toggle-wrap {
      flex-shrink: 0; transform: scale(0.75); transform-origin: center;
    }
    #patchesListContainer .patch-actions { display: flex; gap: 3px; flex-shrink: 0; }
    #patchesListContainer .patch-action-btn {
      width: 30px; height: 30px; padding: 0; border-radius: 6px;
      border: 1px solid var(--border); background: transparent; color: var(--text);
      font-size: 14px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      -webkit-tap-highlight-color: transparent;
    }
    #patchesListContainer .patch-action-btn:active {
      transform: scale(0.92); background: rgba(255,255,255,0.1);
    }
    #patchesListContainer .patch-action-btn.del { color: var(--danger); border-color: rgba(239, 68, 68, 0.4); }
    #patchesListContainer .patch-action-btn.history { color: var(--warning); border-color: rgba(245, 158, 11, 0.4); }

    /* Bulk панель */
    #bulkPatchesBar {
      display: none; gap: 8px; align-items: center;
      padding: 10px; margin-bottom: 10px;
      background: rgba(59, 130, 246, 0.1);
      border: 1px solid rgba(59, 130, 246, 0.35); border-radius: 8px;
    }
    #bulkPatchesBar.visible { display: flex; }
    #bulkPatchesBar .bulk-count { flex: 1; font-size: 12px; font-weight: 700; color: #93c5fd; }

    /* Sticky кнопки Вставить/Очистить */
    .patch-code-actions {
      position: sticky !important;
      bottom: 0 !important;
      background: var(--card) !important;
      padding: 8px 0 !important;
      display: flex !important;
      gap: 8px !important;
      z-index: 10 !important;
      border-top: 1px solid var(--border) !important;
    }
    .patch-code-actions > button { flex: 1; }

    /* История */
    .history-item {
      padding: 10px; margin-bottom: 8px;
      background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    }
    .history-item-header {
      display: flex; justify-content: space-between; align-items: center;
      gap: 8px; margin-bottom: 6px; flex-wrap: wrap;
    }
    .history-item-meta { font-size: 11px; color: var(--muted); }
    .history-item-preview {
      font-family: monospace; font-size: 10px;
      background: var(--card); padding: 6px; border-radius: 4px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      color: var(--muted);
    }
  `;
  document.head.appendChild(css);

  let selectedPatchIds = new Set();

  // ===== renderPatchesList =====
  window.renderPatchesList = function() {
    const c = document.getElementById('patchesListContainer');
    if (!c) return;

    let bulkBar = document.getElementById('bulkPatchesBar');
    if (!bulkBar) {
      bulkBar = document.createElement('div');
      bulkBar.id = 'bulkPatchesBar';
      bulkBar.innerHTML = `
        <span class="bulk-count" id="bulkCount">Выбрано: 0</span>
        <button class="btn btn-secondary btn-small" id="bulkSelectAllBtn" style="font-size: 11px;">Все</button>
        <button class="btn btn-danger btn-small" id="bulkDeleteBtn" style="font-size: 11px;">🗑 Удалить</button>
      `;
      if (c.parentNode) c.parentNode.insertBefore(bulkBar, c);

      document.getElementById('bulkSelectAllBtn').onclick = () => {
        if (!state.patches) return;
        if (selectedPatchIds.size === state.patches.length) selectedPatchIds.clear();
        else selectedPatchIds = new Set(state.patches.map(p => p.id));
        window.renderPatchesList();
      };

      document.getElementById('bulkDeleteBtn').onclick = async () => {
        if (selectedPatchIds.size === 0) return;
        if (!(await appConfirm(`Удалить ${selectedPatchIds.size} патч(ей)?`))) return;
        const ids = Array.from(selectedPatchIds);
        try {
          for (const id of ids) {
            await refs.patches.doc(id).delete();
          }
          selectedPatchIds.clear();
          if (typeof showToastEl === 'function') showToastEl(`✅ Удалено: ${ids.length}. Перезагрузка...`, false);
          setTimeout(() => location.reload(), 800);
        } catch(e) {
          if (typeof showError === 'function') showError(e.message);
        }
      };
    }

    if (!state.patches || !state.patches.length) {
      c.innerHTML = '<div class="empty-state">Нет добавленных патчей</div>';
      bulkBar.classList.remove('visible');
      return;
    }

    const realIds = new Set(state.patches.map(p => p.id));
    for (const id of Array.from(selectedPatchIds)) {
      if (!realIds.has(id)) selectedPatchIds.delete(id);
    }

    if (selectedPatchIds.size > 0) {
      bulkBar.classList.add('visible');
      const cnt = document.getElementById('bulkCount');
      if (cnt) cnt.textContent = `Выбрано: ${selectedPatchIds.size}`;
    } else {
      bulkBar.classList.remove('visible');
    }

    c.innerHTML = state.patches.map(p => {
      const isSel = selectedPatchIds.has(p.id);
      const typeLabel = p.type === 'function' ? '🔁 Замена функции' : '🔍 Найти/Заменить';
      const typeCls = p.type === 'function' ? 'fn' : 'rep';
      const histCount = Array.isArray(p.history) ? p.history.length : 0;
      return `
        <div class="patch-row ${isSel ? 'selected' : ''} ${!p.enabled ? 'disabled' : ''}" data-patch-id="${p.id}">
          <input type="checkbox" class="patch-check" data-check-id="${p.id}" ${isSel ? 'checked' : ''}>
          <div class="patch-info">
            <div class="patch-name">${escapeHtml(p.name)}</div>
            <div class="patch-type ${typeCls}">${typeLabel}${histCount > 0 ? ` · 📜 ${histCount}` : ''}</div>
          </div>
          <label class="patch-toggle-wrap toggle-switch" onclick="event.stopPropagation()">
            <input type="checkbox" ${p.enabled ? 'checked' : ''} data-toggle-id="${p.id}">
            <span class="toggle-slider"></span>
          </label>
          <div class="patch-actions">
            <button class="patch-action-btn" data-edit-id="${p.id}" title="Редактировать">✏️</button>
            <button class="patch-action-btn history" data-history-id="${p.id}" title="История">🕒</button>
            <button class="patch-action-btn del" data-del-id="${p.id}" title="Удалить">🗑</button>
          </div>
        </div>
      `;
    }).join('');

    c.querySelectorAll('.patch-check').forEach(chk => {
      chk.onclick = (e) => e.stopPropagation();
      chk.onchange = () => {
        const id = chk.dataset.checkId;
        if (chk.checked) selectedPatchIds.add(id);
        else selectedPatchIds.delete(id);
        window.renderPatchesList();
      };
    });

    c.querySelectorAll('[data-toggle-id]').forEach(inp => {
      inp.onclick = (e) => e.stopPropagation();
      inp.onchange = () => {
        if (typeof togglePatchStatus === 'function') togglePatchStatus(inp.dataset.toggleId, inp.checked);
      };
    });

    c.querySelectorAll('[data-edit-id]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        window.openPatchModalWithHistory(btn.dataset.editId);
      };
    });

    c.querySelectorAll('[data-history-id]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        openHistoryModal(btn.dataset.historyId);
      };
    });

    c.querySelectorAll('[data-del-id]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const p = state.patches.find(x => x.id === btn.dataset.delId);
        if (!p) return;
        if (!(await appConfirm(`Удалить патч "${p.name}"?`))) return;
        try {
          await refs.patches.doc(p.id).delete();
          selectedPatchIds.delete(p.id);
          if (typeof showToastEl === 'function') showToastEl('🗑 Удалён. Перезагрузка...', false);
          setTimeout(() => location.reload(), 800);
        } catch(e) {
          if (typeof showError === 'function') showError(e.message);
        }
      };
    });

    c.querySelectorAll('.patch-row').forEach(row => {
      row.onclick = (e) => {
        if (e.target.closest('button, input, label')) return;
        window.openPatchModalWithHistory(row.dataset.patchId);
      };
    });
  };

  // ===== openPatchModalWithHistory =====
  window.openPatchModalWithHistory = function(id) {
    if (typeof canAdmin === 'function' && !canAdmin()) return;
    const p = id ? state.patches.find(x => x.id === id) : null;
    document.getElementById('editPatchId').value = id || '';
    document.getElementById('patchName').value = p ? p.name : '';
    document.getElementById('patchType').value = p ? (p.type || 'function') : 'function';
    document.getElementById('patchCodeFunction').value = '';
    document.getElementById('patchFnName').value = '';
    document.getElementById('patchFind').value = '';
    document.getElementById('patchReplace').value = '';
    if (p) {
      if (p.type === 'function') document.getElementById('patchCodeFunction').value = p.code || '';
      else {
        document.getElementById('patchFnName').value = p.fnName || '';
        document.getElementById('patchFind').value = p.findText || '';
        document.getElementById('patchReplace').value = p.replaceText || '';
      }
    }
    document.getElementById('patchModalTitle').textContent = p ? 'Редактировать патч' : 'Новый патч';
    if (typeof togglePatchType === 'function') togglePatchType();
    applySticky();
    document.getElementById('patchEditModal').classList.add('open');
  };

  // Переопределяем openPatchModal — чтобы тоже через историю
  const origOpenPatchModal = window.openPatchModal;
  window.openPatchModal = function(id) {
    window.openPatchModalWithHistory(id);
  };

  // ===== Sticky кнопки =====
  function applySticky() {
    ['patchCodeFunction', 'patchFind', 'patchReplace'].forEach(taId => {
      const ta = document.getElementById(taId);
      if (!ta) return;
      const group = ta.closest('.form-group');
      if (!group) return;
      group.querySelectorAll('div').forEach(div => {
        if (div.style && (div.style.display === 'flex' || div.style.display.includes('flex'))) {
          if (div.querySelectorAll('button').length >= 1 && !div.classList.contains('patch-code-actions')) {
            div.classList.add('patch-code-actions');
          }
        }
      });
    });
  }

  const origTogglePatchType = window.togglePatchType;
  window.togglePatchType = function() {
    if (origTogglePatchType) origTogglePatchType.apply(this, arguments);
    setTimeout(applySticky, 50);
  };

  // ===== savePatch — обёртка для истории =====
  const origSavePatch = window.savePatch;
  window.savePatch = async function() {
    const id = document.getElementById('editPatchId').value;
    if (!id) return origSavePatch.apply(this, arguments);

    const p = state.patches.find(x => x.id === id);
    if (!p) return origSavePatch.apply(this, arguments);

    const entry = {
      savedAt: Date.now(),
      savedBy: (typeof getUserName === 'function') ? getUserName() : '—',
      name: p.name || '',
      type: p.type || 'function',
      code: p.code || '',
      fnName: p.fnName || '',
      findText: p.findText || '',
      replaceText: p.replaceText || ''
    };
    const existing = Array.isArray(p.history) ? p.history : [];
    const newHistory = [entry, ...existing].slice(0, 5);

    try {
      await refs.patches.doc(id).update({ history: newHistory });
      p.history = newHistory;
    } catch(e) {
      console.warn('[patches-ui] history save error:', e);
    }

    return origSavePatch.apply(this, arguments);
  };

  // ===== Модалка истории =====
  function openHistoryModal(id) {
    const p = state.patches.find(x => x.id === id);
    if (!p) return;

    const history = Array.isArray(p.history) ? p.history : [];

    const old = document.getElementById('patchHistoryModal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'patchHistoryModal';
    overlay.className = 'modal open';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '700px';
    content.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="font-size:16px;">📜 История: ${escapeHtml(p.name)}</h3>
        <button class="btn-del" onclick="document.getElementById('patchHistoryModal').remove()">✕</button>
      </div>
      <div class="modal-body" style="max-height:60vh;">
        ${history.length === 0
          ? '<div class="empty-state">История пуста. Появится после первого сохранения изменений.</div>'
          : history.map((h, idx) => {
              const date = new Date(h.savedAt || 0).toLocaleString('ru-RU');
              const typeLabel = h.type === 'function' ? '🔁' : '🔍';
              const preview = h.type === 'function'
                ? (h.code || '').substring(0, 100).replace(/\n/g, ' ')
                : `${h.fnName}: ${(h.findText||'').substring(0, 40)} → ${(h.replaceText||'').substring(0, 40)}`;
              return `
                <div class="history-item">
                  <div class="history-item-header">
                    <span class="history-item-meta">📅 ${date} · 👤 ${escapeHtml(h.savedBy || '—')} · ${typeLabel}</span>
                    <button class="btn btn-quick btn-small" data-restore="${idx}" style="font-size:11px; padding:4px 10px; min-height:28px;">↩ Восстановить</button>
                  </div>
                  <div class="history-item-preview">${escapeHtml(preview)}...</div>
                </div>
              `;
            }).join('')
        }
      </div>
    `;
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    content.querySelectorAll('[data-restore]').forEach(btn => {
      btn.onclick = async () => {
        const idx = parseInt(btn.dataset.restore);
        const h = history[idx];
        if (!h) return;
        if (!(await appConfirm(`Восстановить версию от ${new Date(h.savedAt).toLocaleString('ru-RU')}?`))) return;

        const currentEntry = {
          savedAt: Date.now(),
          savedBy: (typeof getUserName === 'function') ? getUserName() : '—',
          name: p.name || '',
          type: p.type || 'function',
          code: p.code || '',
          fnName: p.fnName || '',
          findText: p.findText || '',
          replaceText: p.replaceText || ''
        };
        const newHistory = [currentEntry, ...history.filter((_, i) => i !== idx)].slice(0, 5);

        try {
          await refs.patches.doc(id).update({
            name: h.name || p.name,
            type: h.type || p.type,
            code: h.code || '',
            fnName: h.fnName || '',
            findText: h.findText || '',
            replaceText: h.replaceText || '',
            history: newHistory,
            updatedAt: Date.now(),
            updatedBy: (typeof getUserName === 'function') ? getUserName() : '—'
          });
          if (typeof showToastEl === 'function') showToastEl('↩ Версия восстановлена. Перезагрузка...', false);
          setTimeout(() => location.reload(), 800);
        } catch(e) {
          if (typeof showError === 'function') showError(e.message);
        }
      };
    });
  }

  // ===== Работающая вставка =====
  async function pasteToField(fieldId) {
    const el = document.getElementById(fieldId);
    if (!el) return;

    // 1. readText
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          el.value = (el.value || '') + text;
          if (typeof showToastEl === 'function') showToastEl('📋 Вставлено', false);
          return;
        }
      }
    } catch(e) {}

    // 2. read
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type === 'text/plain' || type === 'text/html') {
              const blob = await item.getType(type);
              const text = await blob.text();
              if (text && text.trim()) {
                el.value = (el.value || '') + text;
                if (typeof showToastEl === 'function') showToastEl('📋 Вставлено', false);
                return;
              }
            }
          }
        }
      }
    } catch(e) {}

    // 3. Fallback
    showManualPaste(fieldId);
  }

  function showManualPaste(fieldId) {
    const old = document.getElementById('manualPasteModal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'manualPasteModal';
    overlay.className = 'modal open';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '500px';
    content.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="font-size:16px;">📋 Вставка кода</h3>
        <button class="btn-del" onclick="document.getElementById('manualPasteModal').remove()">✕</button>
      </div>
      <div style="font-size:12px; color:var(--muted); margin-bottom:10px; line-height:1.4;">
        Браузер не дал прямой доступ к буферу. Вставьте код вручную: нажмите на поле → удерживайте палец → «Вставить». Или используйте <b>Ctrl+V</b> на компьютере.
      </div>
      <textarea id="manualPasteTextarea" class="form-control" placeholder="Вставьте код сюда..." style="min-height:200px; font-family:monospace; font-size:12px;"></textarea>
      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="btn btn-secondary" id="manualPasteCancel" style="flex:1;">Отмена</button>
        <button class="btn btn-quick" id="manualPasteConfirm" style="flex:1;">✅ Вставить в поле</button>
      </div>
    `;
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    setTimeout(() => {
      const ta = document.getElementById('manualPasteTextarea');
      if (ta) ta.focus();
    }, 100);

    document.getElementById('manualPasteCancel').onclick = () => overlay.remove();
    document.getElementById('manualPasteConfirm').onclick = () => {
      const text = document.getElementById('manualPasteTextarea').value;
      if (!text) { overlay.remove(); return; }
      const el = document.getElementById(fieldId);
      if (el) {
        el.value = (el.value || '') + text;
        if (typeof showToastEl === 'function') showToastEl('📋 Вставлено', false);
      }
      overlay.remove();
    };
  }

  // Переопределяем pastePatchField и pastePluginCode
  window.pastePatchField = function(fieldId) { pasteToField(fieldId); };
  window.pastePluginCode = async function() { pasteToField('pluginCode'); };

  // ===== switchAdminTab — перерисовать при переходе =====
  const origSwitchAdminTab = window.switchAdminTab;
  window.switchAdminTab = function(tab, btn) {
    if (origSwitchAdminTab) origSwitchAdminTab.apply(this, arguments);
    if (tab === 'patches') {
      setTimeout(() => {
        if (state.patches && state.patches.length > 0) window.renderPatchesList();
        applySticky();
      }, 100);
    }
  };

  // ===== Периодические проверки =====
  setInterval(() => {
    const modal = document.getElementById('patchEditModal');
    if (modal && modal.classList.contains('open')) applySticky();

    const activeTab = document.getElementById('admin-sub-patches');
    if (activeTab && activeTab.classList.contains('active')) {
      const c = document.getElementById('patchesListContainer');
      if (c && !c.querySelector('.patch-row') && state.patches && state.patches.length > 0) {
        window.renderPatchesList();
      }
    }
  }, 1500);

  setTimeout(() => {
    if (document.getElementById('admin-sub-patches')?.classList.contains('active')) {
      window.renderPatchesList();
    }
  }, 500);

  console.log('[patches-ui] ✅ Активен. Компакт + чекбоксы + история (5 версий) + работающая вставка.');
})();; }
catch (e) { console.error('[baked patch: Патчи]', e); }
try { (function(){
  if (window.__prettyConfirmV1) return;
  window.__prettyConfirmV1 = true;

  // ===== CSS =====
  const oldCss = document.getElementById('pretty-confirm-css');
  if (oldCss) oldCss.remove();

  const css = document.createElement('style');
  css.id = 'pretty-confirm-css';
  css.textContent = `
    /* Фон-затемнение с блюром */
    .pcm-overlay {
      position: fixed !important;
      inset: 0 !important;
      z-index: 10050 !important;
      background: transparent !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      padding: 20px !important;
      opacity: 0 !important;
      transition: opacity 0.22s cubic-bezier(0.4, 0, 0.2, 1) !important;
      -webkit-backdrop-filter: none !important;
      backdrop-filter: none !important;
    }
    .pcm-overlay.pcm-open {
      opacity: 1 !important;
    }

    /* Карточка */
    .pcm-card {
      background: var(--card) !important;
      border: 1px solid var(--border) !important;
      border-radius: 18px !important;
      padding: 22px 20px 18px 20px !important;
      width: 100% !important;
      max-width: 380px !important;
      box-shadow:
        0 25px 60px rgba(0, 0, 0, 0.8),
        0 0 0 1px rgba(255, 255, 255, 0.04) inset !important;
      transform: scale(0.88) translateY(24px) !important;
      opacity: 0 !important;
      transition:
        transform 0.38s cubic-bezier(0.34, 1.56, 0.64, 1),
        opacity 0.22s cubic-bezier(0.4, 0, 0.2, 1) !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 16px !important;
    }
    .pcm-overlay.pcm-open .pcm-card {
      transform: scale(1) translateY(0) !important;
      opacity: 1 !important;
    }

    /* Иконка */
    .pcm-icon-wrap {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 56px !important;
      height: 56px !important;
      border-radius: 50% !important;
      margin: 0 auto 4px auto !important;
      font-size: 28px !important;
      line-height: 1 !important;
      background: rgba(59, 130, 246, 0.15) !important;
      border: 2px solid rgba(59, 130, 246, 0.35) !important;
      box-shadow: 0 0 20px rgba(59, 130, 246, 0.15) !important;
    }
    .pcm-icon-wrap.pcm-danger {
      background: rgba(239, 68, 68, 0.15) !important;
      border-color: rgba(239, 68, 68, 0.4) !important;
      box-shadow: 0 0 20px rgba(239, 68, 68, 0.2) !important;
    }
    .pcm-icon-wrap.pcm-warning {
      background: rgba(245, 158, 11, 0.15) !important;
      border-color: rgba(245, 158, 11, 0.4) !important;
      box-shadow: 0 0 20px rgba(245, 158, 11, 0.2) !important;
    }
    .pcm-icon-wrap.pcm-success {
      background: rgba(34, 197, 94, 0.15) !important;
      border-color: rgba(34, 197, 94, 0.4) !important;
      box-shadow: 0 0 20px rgba(34, 197, 94, 0.2) !important;
    }

    /* Заголовок */
    .pcm-title {
      font-size: 18px !important;
      font-weight: 800 !important;
      color: var(--text) !important;
      text-align: center !important;
      line-height: 1.3 !important;
      letter-spacing: -0.2px !important;
    }

    /* Текст */
    .pcm-message {
      font-size: 13.5px !important;
      line-height: 1.5 !important;
      color: var(--muted) !important;
      text-align: center !important;
      word-wrap: break-word !important;
    }
    .pcm-message b, .pcm-message strong {
      color: var(--text) !important;
      font-weight: 700 !important;
    }
    .pcm-message code {
      background: var(--bg) !important;
      padding: 1px 5px !important;
      border-radius: 4px !important;
      font-family: monospace !important;
      font-size: 12px !important;
      color: #93c5fd !important;
    }

    /* Кнопки */
    .pcm-actions {
      display: flex !important;
      gap: 8px !important;
      margin-top: 4px !important;
    }
    .pcm-btn {
      flex: 1 !important;
      min-height: 46px !important;
      padding: 10px 12px !important;
      border: none !important;
      border-radius: 12px !important;
      font-size: 14px !important;
      font-weight: 700 !important;
      cursor: pointer !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 6px !important;
      transition: transform 0.12s ease, opacity 0.12s ease, box-shadow 0.15s ease !important;
      -webkit-tap-highlight-color: transparent !important;
    }
    .pcm-btn:active {
      transform: scale(0.96) !important;
      opacity: 0.9 !important;
    }
    .pcm-btn-cancel {
      background: var(--border) !important;
      color: var(--text) !important;
    }
    .pcm-btn-cancel:active {
      background: #475569 !important;
    }
    .pcm-btn-confirm {
      background: var(--primary) !important;
      color: #fff !important;
      box-shadow: 0 4px 14px rgba(59, 130, 246, 0.35) !important;
    }
    .pcm-btn-confirm.pcm-danger {
      background: var(--danger) !important;
      box-shadow: 0 4px 14px rgba(239, 68, 68, 0.4) !important;
    }
    .pcm-btn-confirm.pcm-success {
      background: var(--success) !important;
      box-shadow: 0 4px 14px rgba(34, 197, 94, 0.4) !important;
    }
    .pcm-btn-confirm.pcm-warning {
      background: var(--warning) !important;
      color: #000 !important;
      box-shadow: 0 4px 14px rgba(245, 158, 11, 0.4) !important;
    }

    /* Адаптив под очень маленькие экраны */
    @media (max-width: 340px) {
      .pcm-card { padding: 18px 14px 14px 14px !important; border-radius: 14px !important; }
      .pcm-icon-wrap { width: 48px !important; height: 48px !important; font-size: 24px !important; }
      .pcm-title { font-size: 16px !important; }
      .pcm-message { font-size: 12.5px !important; }
      .pcm-btn { min-height: 42px !important; font-size: 13px !important; }
    }
  `;
  document.head.appendChild(css);

  // ===== showConfirmModal =====
  // opts: {
  //   confirmLabel: 'Да',
  //   cancelLabel: 'Отмена',
  //   danger: false,       // → красная кнопка + красная иконка
  //   variant: 'primary' | 'danger' | 'success' | 'warning',  // альтернатива
  //   icon: '❓' | '⚠️' | ...,
  //   hideCancel: false     // если нужен только «ОК»
  // }
  window.showConfirmModal = function(title, message, opts) {
    opts = opts || {};
    const confirmLabel = opts.confirmLabel || 'Подтвердить';
    const cancelLabel = opts.cancelLabel || 'Отмена';
    const hideCancel = !!opts.hideCancel;
    const icon = opts.icon || '❓';

    // Определяем вариант
    let variant = opts.variant || (opts.danger ? 'danger' : 'primary');
    // Legacy: danger → красная кнопка
    if (opts.danger === true && !opts.variant) variant = 'danger';

    return new Promise(resolve => {
      // Уже есть открытый — принудительно закрываем
      if(window.__closeActiveConfirmation)window.__closeActiveConfirmation(false);

      const overlay = document.createElement('div');
      overlay.className = 'pcm-overlay';

      const card = document.createElement('div');
      card.className = 'pcm-card';

      const iconCls = variant === 'danger' ? 'pcm-danger'
                     : variant === 'warning' ? 'pcm-warning'
                     : variant === 'success' ? 'pcm-success' : '';

      const btnConfirmCls = 'pcm-btn-confirm ' + (
        variant === 'danger' ? 'pcm-danger'
        : variant === 'success' ? 'pcm-success'
        : variant === 'warning' ? 'pcm-warning' : ''
      );

      card.innerHTML = `
        <div class="pcm-icon-wrap ${iconCls}">${icon}</div>
        <div class="pcm-title"></div>
        <div class="pcm-message"></div>
        <div class="pcm-actions">
          ${hideCancel ? '' : `<button class="pcm-btn pcm-btn-cancel"></button>`}
          <button class="pcm-btn ${btnConfirmCls}"></button>
        </div>
      `;

      card.querySelector('.pcm-title').textContent = title || '';
      // message разрешаем с HTML
      card.querySelector('.pcm-message').innerHTML = message || '';
      if (!hideCancel) card.querySelector('.pcm-btn-cancel').textContent = cancelLabel;
      card.querySelector('.pcm-btn-confirm').textContent = confirmLabel;

      overlay.appendChild(card);
      document.body.appendChild(overlay);

      // Анимация открытия
      requestAnimationFrame(() => {
        overlay.classList.add('pcm-open');
      });

      // Хелпер закрытия
      let closed = false;
      function close(result) {
        if (closed) return;
        closed = true;document.removeEventListener('keydown',onKey);if(window.__closeActiveConfirmation===close)window.__closeActiveConfirmation=null;
        overlay.classList.remove('pcm-open');
        setTimeout(() => {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          resolve(result);
        }, 280);
      }

      // Кнопки
      if (!hideCancel) {
        card.querySelector('.pcm-btn-cancel').addEventListener('click', () => close(false));
      }
      card.querySelector('.pcm-btn-confirm').addEventListener('click', () => close(true));

      window.__closeActiveConfirmation=close;
      // Клик по фону — отмена
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });

      // Escape — отмена, Enter — подтверждение
      function onKey(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(false); }
        else if (e.key === 'Enter') { document.removeEventListener('keydown', onKey); close(true); }
      }
      document.addEventListener('keydown', onKey);

      // Фокус на подтверждение для accessibility
      setTimeout(() => {
        try { card.querySelector('.pcm-btn-confirm').focus({ preventScroll: true }); } catch(e) {}
      }, 100);
    });
  };

  // ===== Алиас на всякий случай =====
  window.confirmModal = window.showConfirmModal;

  console.log('[pretty-confirm] ✅ Красивое окно подтверждения готово.');
})();; }
catch (e) { console.error('[baked patch: Красивое окно подтверждениия]', e); }
try { (function(){
  if (window.__tickerV9) return;
  window.__tickerV9 = true;

  try {
    ['ticker-fix-css', 'ticker-compact-css', 'ticker-v3-css', 'ticker-v4-css', 'ticker-v5-css', 'ticker-v6-css', 'ticker-v7-css', 'ticker-v8-css', 'ticker-v9-css'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });

    const css = document.createElement('style');
    css.id = 'ticker-v9-css';
    css.textContent = `
      #statusTicker { padding: 4px 10px !important; gap: 1px !important; }

      #statusTicker .ticker-row-top {
        display: flex !important;
        flex-wrap: nowrap !important;
        justify-content: space-between !important;
        align-items: center !important;
        gap: 8px !important;
        padding-bottom: 2px !important;
        font-size: 10px !important;
        line-height: 1.2 !important;
        border-bottom: 1px solid rgba(255,255,255,0.2) !important;
        overflow: hidden !important;
        white-space: nowrap !important;
      }
      #statusTicker .ticker-name-line {
        display: inline-flex !important;
        flex-direction: row !important;
        flex-wrap: nowrap !important;
        align-items: center !important;
        gap: 6px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        min-width: 0 !important;
        flex: 1 1 auto !important;
      }
      #statusTicker .ticker-name-line > span { white-space: nowrap !important; }
      #statusTicker .ticker-name-line > span:first-child { flex-shrink: 0 !important; }
      #statusTicker .ticker-user {
        opacity: 0.95 !important;
        color: #fef3c7 !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        max-width: 200px !important;
        white-space: nowrap !important;
        font-size: 10px !important;
        font-weight: 700 !important;
        display: inline-block !important;
        flex-shrink: 1 !important;
        min-width: 0 !important;
        line-height: 1.2 !important;
      }
      #statusTicker .ticker-time {
        flex-shrink: 0 !important;
        font-size: 9px !important;
        padding: 0 4px !important;
        margin-left: auto !important;
      }

      #statusTicker .ticker-row-bottom {
        display: flex !important;
        justify-content: space-between !important;
        align-items: center !important;
        gap: 6px !important;
        position: relative !important;
        overflow: hidden !important;
        height: 40px !important;
        margin-top: 0 !important;
      }

      /* === ОРИГИНАЛЬНАЯ АНИМАЦИЯ === */
      #statusTicker .ticker-text-wrapper {
        flex: 1 1 auto !important;
        position: relative !important;
        overflow: hidden !important;
        height: 100% !important;
        display: flex !important;
        align-items: center !important;
        min-width: 0 !important;
      }
      #statusTicker .ticker-left {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: 100% !important;
        height: 100% !important;
        display: flex !important;
        align-items: center !important;
        gap: 4px !important;
        font-size: 11.5px !important;
        font-weight: 700 !important;
        white-space: nowrap !important;
        transition: transform 0.8s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.8s ease-out !important;
      }
      #statusTicker .ticker-left.enter { transform: translateX(-100%) !important; opacity: 0 !important; }
      #statusTicker .ticker-left.active { transform: translateX(0) !important; opacity: 1 !important; }
      #statusTicker .ticker-left.enter-reverse { transform: translateX(100%) !important; opacity: 0 !important; }
      #statusTicker .ticker-left.leave-reverse { transform: translateX(-100%) !important; opacity: 0 !important; }
      #statusTicker .ticker-left.leave { transform: translateX(100%) !important; opacity: 0 !important; }
      #statusTicker .ticker-left.enter-reverse { transform: translateX(100%) !important; opacity: 0 !important; }
      #statusTicker .ticker-left.leave-reverse { transform: translateX(-100%) !important; opacity: 0 !important; }

      #statusTicker .ru-plate {
        transform: none !important; flex-shrink: 0 !important;
        height: 30px !important; margin: 0 3px !important;
        border-width: 2px !important; border-radius: 4px !important;
      }
      #statusTicker .ru-plate-main { font-size: 16px !important; padding: 0 5px !important; gap: 1px !important; letter-spacing: 1px !important; }
      #statusTicker .ru-plate-main .plate-digit { font-size: 17px !important; letter-spacing: 1.5px !important; }
      #statusTicker .ru-plate-region { width: 28px !important; min-width: 28px !important; max-width: 28px !important; padding: 1px 0 !important; border-left-width: 2px !important; }
      #statusTicker .ru-plate-region .region-code { font-size: 11px !important; line-height: 1 !important; }
      #statusTicker .ru-plate-region .region-rus { font-size: 5px !important; line-height: 1 !important; margin-top: 0.5px !important; }
      .ru-plate-flag {
        display: block !important;
        width: 10px !important; height: 5px !important;
        margin-top: 1px !important;
        border: 0.5px solid #000 !important;
        background: linear-gradient(to bottom, #ffffff 0%, #ffffff 33.33%, #0039a6 33.33%, #0039a6 66.66%, #d52b1e 66.66%, #d52b1e 100%) !important;
        flex-shrink: 0 !important; box-sizing: border-box !important;
        min-width: 10px !important; min-height: 5px !important;
      }
      .ru-plate-flag span { display: none !important; }
      #statusTicker .ru-plate-flag { width: 13px !important; height: 7.5px !important; min-width: 13px !important; min-height: 7.5px !important; }
      #statusTicker .btn-undo { width: 24px !important; height: 22px !important; font-size: 12px !important; }
    `;
    document.head.appendChild(css);

    // ===== Утилиты =====
    function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    function stripUserName(html, name) {
      if (!html) return '';
      let s = String(html);
      if (name) {
        const n = String(name).trim();
        if (n && n !== '—') {
          const esc = escapeRegExp(n);
          s = s.replace(new RegExp('\\s*·\\s*' + esc + '\\s*$', 'i'), '');
          s = s.replace(new RegExp('^\\s*' + esc + '\\s*·\\s*', 'i'), '');
          s = s.replace(new RegExp('\\s{2,}' + esc + '\\s*$', 'i'), '');
        }
      }
      s = s.replace(/\s{2,}/g, ' ');
      s = s.replace(/\s*·\s*$/, '');
      s = s.replace(/^\s*·\s*/, '');
      return s;
    }

    const undoneTickerIds = new Set();
    window.addEventListener('samosval:action-undone', event => {
      const action = event.detail;
      const truckOp = (action.operations || []).find(op => op.collection === 'truckStatus');
      const logOp = (action.operations || []).find(op => op.collection === 'logs' && op.before === null);
      if (!truckOp && !logOp) return;
      const notification = (state.notifications || []).find(item =>
        !undoneTickerIds.has(item.id) && item.type === action.type &&
        (logOp ? item.logId === logOp.id : item.truckId === truckOp.id)
      );
      if (!notification) return;
      undoneTickerIds.add(notification.id);
      window.renderStatusTicker();
    });

    function getLastNotification() {
      try {
        if (typeof state !== 'undefined' && state && state.notifications && state.notifications.length > 0) {
          return state.notifications.find(item => !undoneTickerIds.has(item.id) && validTickerNotification(item)) || null;
        }
      } catch(e) {}
      return null;
    }

    function getUserNameForTicker(last) {
      if (!last) return '';
      const candidates = [last.userName, last.createdBy];
      try {
        if (typeof state !== 'undefined' && state && state.users && last.createdByEmail) {
          const u = state.users.find(x => x.email && x.email.toLowerCase() === String(last.createdByEmail).toLowerCase());
          if (u) {
            if (u.nickname) candidates.push(u.nickname);
            if (u.email) candidates.push(sanitizeName(u.email));
          }
        }
      } catch(e) {}
      if (last.createdByEmail) {
        try { candidates.push(sanitizeName(last.createdByEmail)); } catch(e) {}
      }
      if (last.timestamp && (Date.now() - last.timestamp) < 600000) {
        try { candidates.push(getUserName()); } catch(e) {}
        try { candidates.push(sanitizeName(currentEmail)); } catch(e) {}
      }
      try { candidates.push(getUserName()); } catch(e) {}

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!c) continue;
        const v = String(c).trim();
        if (v && v !== '—' && v !== 'undefined' && v !== 'null') return v;
      }
      return '';
    }

    // ===== Инъекция имени в верхнюю строку =====
    let _injecting = false;

    function injectUserName() {
      if (_injecting) return;
      _injecting = true;
      try {
        const t = document.getElementById('statusTicker');
        if (!t || t.style.display === 'none') return;

        const last = getLastNotification();
        if (!last) return;

        const userName = getUserNameForTicker(last);
        if (!userName) return;

        const userLabel = '· 👤 ' + userName;
        const topRow = t.querySelector('.ticker-row-top');
        if (!topRow) return;

        let nameLine = topRow.querySelector('.ticker-name-line');

        if (!nameLine) {
          const children = Array.from(topRow.children);
          let firstTextEl = null;
          for (const ch of children) {
            if (ch.classList && ch.classList.contains('ticker-time')) continue;
            if (ch.id === 'tickerTimeAgo') continue;
            if (ch.tagName === 'SPAN' && !ch.classList.contains('ticker-user')) {
              firstTextEl = ch;
              break;
            }
          }

          if (firstTextEl) {
            nameLine = document.createElement('span');
            nameLine.className = 'ticker-name-line';
            firstTextEl.parentNode.insertBefore(nameLine, firstTextEl);
            nameLine.appendChild(firstTextEl);
          } else {
            nameLine = document.createElement('span');
            nameLine.className = 'ticker-name-line';
            nameLine.innerHTML = '<span>ПОСЛЕДНЕЕ ДЕЙСТВИЕ</span>';
            const timeEl = topRow.querySelector('.ticker-time') || topRow.querySelector('#tickerTimeAgo');
            if (timeEl) topRow.insertBefore(nameLine, timeEl);
            else topRow.appendChild(nameLine);
          }
        }

        let userSpan = nameLine.querySelector('.ticker-user');
        if (!userSpan) {
          userSpan = document.createElement('span');
          userSpan.className = 'ticker-user';
          nameLine.appendChild(userSpan);
        }
        if (userSpan.textContent !== userLabel) {
          userSpan.textContent = userLabel;
        }
      } catch(e) {
        console.warn('[ticker-v9] inject error:', e.message);
      } finally {
        _injecting = false;
      }
    }

    // ===== Оригинальные трекеры =====
    let lastTickerTs = 0;
    let lastTickerId = null;

    // ===== renderStatusTicker — оригинальная логика анимации =====
    window.renderStatusTicker = function() {
      const t = document.getElementById('statusTicker');
      if (!t) return;

      const last = getLastNotification();
      if (!last) {
        const reverseEnabled = true;
        const outgoing = t.querySelector('.ticker-left.active');
        if (reverseEnabled && outgoing) {
          outgoing.classList.remove('active');
          outgoing.classList.add('leave-reverse');
          setTimeout(() => {
            if (!getLastNotification()) {
              t.style.display = 'none';
              t.innerHTML = '';
              lastTickerTs = 0;
              lastTickerId = null;
            }
          }, 800);
          return;
        }
        if (reverseEnabled && t.querySelector('.leave-reverse')) return;
        t.style.display = 'none';
        t.innerHTML = '';
        lastTickerTs = 0;
        lastTickerId = null;
        t.removeAttribute('data-ticker-v9');
        return;
      }

      const isNew = (last.timestamp || 0) !== lastTickerTs;
      const isNewId = last.id !== lastTickerId;
      const userName = getUserNameForTicker(last);
      const cleanHtml = stripUserName(last.html || '', userName);
      const userLabel = userName ? '· 👤 ' + userName : '';
      const showUndo = (typeof canUndoCurrent === 'function') ? canUndoCurrent(last) : false;

      // Первый рендер / после скрытия — полная перестройка без слайда
      if (t.style.display === 'none' || !t.querySelector('.ticker-text-wrapper')) {
        t.style.display = 'flex';
        t.innerHTML = `
          <div class="ticker-row-top">
            <span class="ticker-name-line">
              <span>ПОСЛЕДНЕЕ ДЕЙСТВИЕ</span>
              <span class="ticker-user">${userLabel ? escapeHtml(userLabel) : ''}</span>
            </span>
            <span id="tickerTimeAgo" class="ticker-time" data-timestamp="${last.timestamp||Date.now()}">${formatTimeAgo(last.timestamp)}</span>
          </div>
          <div class="ticker-row-bottom">
            <div class="ticker-text-wrapper">
              <div class="ticker-left active">${cleanHtml}</div>
            </div>
            ${showUndo ? '<button class="btn-undo" onclick="undoLastAction()" title="Отменить">↩</button>' : ''}
          </div>
        `;
        lastTickerTs = last.timestamp || 0;
        lastTickerId = last.id;
        t.classList.remove('flash');
        void t.offsetWidth;
        t.classList.add('flash');
        return;
      }

      // === Анимация слайда при новом уведомлении (как в оригинале) ===
      if (isNewId || !t.querySelector('.ticker-left.active')) {
        const reverse = isNewId && (last.timestamp || 0) <= lastTickerTs;
        const wrapper = t.querySelector('.ticker-text-wrapper');
        const oldText = wrapper.querySelector('.ticker-left.active');

        // Remove obsolete outgoing cards during rapid successive updates.
        wrapper.querySelectorAll('.ticker-left').forEach(node => {
          if (node !== oldText) node.remove();
        });
        {
          const newText = document.createElement('div');
          newText.className = reverse ? 'ticker-left enter-reverse' : 'ticker-left enter';
          newText.innerHTML = cleanHtml;
          wrapper.appendChild(newText);
          void newText.offsetWidth;
          if (oldText) {
            oldText.classList.remove('active');
            oldText.classList.add(reverse ? 'leave-reverse' : 'leave');
          }
          newText.classList.remove('enter', 'enter-reverse');
          newText.classList.add('active');
          setTimeout(() => { if (oldText && oldText.parentNode) oldText.remove(); }, 800);
        }

        // Кнопка отмены
        let undoBtn = t.querySelector('.btn-undo');
        if (showUndo && !undoBtn) {
          const btn = document.createElement('button');
          btn.className = 'btn-undo';
          btn.innerHTML = '↩';
          btn.onclick = window.undoLastAction;
          t.querySelector('.ticker-row-bottom').appendChild(btn);
        } else if (!showUndo && undoBtn) {
          undoBtn.remove();
        }

        // Время
        const timeEl = document.getElementById('tickerTimeAgo');
        if (timeEl) {
          timeEl.textContent = formatTimeAgo(last.timestamp);
          timeEl.setAttribute('data-timestamp', last.timestamp);
        }

        // Flash
        t.classList.remove('flash');
        void t.offsetWidth;
        t.classList.add('flash');

        lastTickerTs = last.timestamp || 0;
        lastTickerId = last.id;
      }

      // Имя всегда обновляем (не зависит от анимации нижней строки)
      injectUserName();
    };

    // ===== pushNotification — сохраняем имя =====
    window.pushNotification = async function(actionObj, htmlText) {
      if (typeof pendingStart === 'function') pendingStart();
      try {
        let userName = '';
        try {
          if (typeof getUserName === 'function') {
            const n = getUserName();
            if (n && n !== '—') userName = n;
          }
        } catch(e) {}
        if (!userName) {
          try {
            if (typeof currentEmail !== 'undefined' && currentEmail) userName = sanitizeName(currentEmail) || '';
          } catch(e) {}
        }
        if (!userName) userName = '—';

        const userEmail = (typeof currentEmail !== 'undefined') ? (currentEmail || '') : '';
        const cleanHtml = stripUserName(htmlText || '', userName);

        await refs.notifications.add(Object.assign({}, actionObj, {
          html: cleanHtml,
          userName: userName,
          timestamp: Date.now(),
          createdBy: userName,
          createdByEmail: userEmail
        }));

        if (typeof cleanupNotifications === 'function') cleanupNotifications().catch(()=>{});
      } catch (e) {
        console.warn('[ticker-v9] push error:', e);
      } finally {
        if (typeof pendingEnd === 'function') pendingEnd();
      }
    };

    // ===== Диагностика =====
    window.__tickerDebug = function() {
      const t = document.getElementById('statusTicker');
      console.log('=== TICKER V9 DEBUG ===');
      console.log('Патч:', !!window.__tickerV9);
      try {
        const last = getLastNotification();
        if (!last) { console.log('Нет уведомлений'); return; }
        console.log('Уведомление:', {
          id: last.id, userName: last.userName, createdBy: last.createdBy,
          createdByEmail: last.createdByEmail,
          timestamp: new Date(last.timestamp || 0).toLocaleString()
        });
        console.log('getUserNameForTicker:', getUserNameForTicker(last));
      } catch(e) { console.log('err:', e.message); }
      if (t) {
        console.log('display:', getComputedStyle(t).display);
        console.log('ticker-user:', JSON.stringify(t.querySelector('.ticker-user')?.textContent));
        console.log('ticker-left active:', !!t.querySelector('.ticker-left.active'));
      }
      console.log('=== /DEBUG ===');
    };

    window.__forceTickerName = function() {
      injectUserName();
      console.log('[ticker-v9] Инъекция выполнена');
    };

    // ===== MutationObserver + интервал =====
    function attachObserver() {
      const t = document.getElementById('statusTicker');
      if (!t || t.dataset.v9Obs) return;
      t.dataset.v9Obs = '1';
      const obs = new MutationObserver(() => injectUserName());
      obs.observe(t, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });
    }

    setInterval(() => {
      attachObserver();
      injectUserName();
    }, 300);

    // ===== Авто-миграция =====
    async function autoMigrate() {
      try {
        const snap = await refs.notifications.orderBy('timestamp', 'desc').limit(50).get();
        if (snap.empty) return;
        const batch = db.batch();
        let fixed = 0;
        snap.forEach(doc => {
          const d = doc.data();
          if (d.userName && String(d.userName).trim() && String(d.userName).trim() !== '—') return;
          let name = '';
          if (d.createdBy && String(d.createdBy).trim() && String(d.createdBy).trim() !== '—') {
            name = String(d.createdBy).trim();
          } else if (d.createdByEmail) {
            let found = '';
            try {
              if (state && state.users && state.users.length) {
                const u = state.users.find(x => x.email && x.email.toLowerCase() === String(d.createdByEmail).toLowerCase());
                if (u && u.nickname && String(u.nickname).trim() && String(u.nickname).trim() !== '—') found = String(u.nickname).trim();
              }
            } catch(e) {}
            if (!found) {
              const fromEmail = sanitizeName(d.createdByEmail);
              if (fromEmail && fromEmail !== '—') found = fromEmail;
            }
            name = found;
          }
          if (name) {
            batch.update(doc.ref, { userName: name });
            fixed++;
          }
        });
        if (fixed > 0) {
          await batch.commit();
          console.log('[ticker-v9] Мигрировано:', fixed);
          window.renderStatusTicker();
        }
      } catch(e) {
        console.warn('[ticker-v9] migrate:', e.message);
      }
    }

    setTimeout(() => { try { window.renderStatusTicker(); } catch(e) {} }, 300);
    setTimeout(() => { try { window.renderStatusTicker(); } catch(e) {} }, 1000);
    setTimeout(attachObserver, 500);
    setTimeout(() => { try { autoMigrate(); } catch(e) {} }, 2500);
    setTimeout(() => { try { window.renderStatusTicker(); } catch(e) {} }, 3500);

    console.log('[ticker-v9] ✅ Активен. Оригинальная анимация + имя.');
  } catch (err) {
    console.error('[ticker-v9] ОШИБКА:', err);
  }
})();; }
catch (e) { console.error('[baked patch: Имя пользователя в статус баре]', e); }
try { (function(){
  if (window.__navSortV2) return;
  window.__navSortV2 = true;

  const ORDER_KEY = 'dt_nav_order_v2';
  const DEFAULT_ORDER = ['nav-line', 'nav-report', 'nav-archive', 'nav-trucks', 'nav-analytics', 'nav-admin', 'nav-backup'];

  function getNav() { return document.getElementById('bottomNav'); }
  function getAllBtns() {
    const nav = getNav();
    if (!nav) return [];
    return Array.from(nav.querySelectorAll('.nav-btn'));
  }
  function readOrder() {
    try {
      const raw = localStorage.getItem(ORDER_KEY);
      if (!raw) return null;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      return arr;
    } catch(e) { return null; }
  }
  function saveOrder(arr) {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(arr)); } catch(e) {}
  }

  function applyOrder() {
    const nav = getNav();
    if (!nav) return;
    const order = readOrder();
    if (!order || !order.length) return; // не настроено — не трогаем

    const btns = getAllBtns();
    const map = {};
    btns.forEach(b => map[b.id] = b);

    const result = [];
    // Сначала по сохранённому порядку
    order.forEach(id => {
      if (map[id]) { result.push(map[id]); delete map[id]; }
    });
    // Оставшиеся (новые кнопки/плагины) — в конец
    Object.values(map).forEach(b => result.push(b));

    // Проверяем, нужна ли перестановка
    const currentIds = btns.map(b => b.id).join(',');
    const targetIds = result.map(b => b.id).join(',');
    if (currentIds === targetIds) return;

    // Переставляем
    result.forEach(b => nav.appendChild(b));
  }

  function buildOrderList() {
    const btns = getAllBtns();
    const stored = readOrder();
    const storedIds = stored ? stored.filter(id => btns.some(b => b.id === id)) : [];
    const remainingIds = btns.map(b => b.id).filter(id => !storedIds.includes(id));
    // Если stored нет — начинаем с текущего DOM-порядка
    if (!stored || !stored.length) {
      return btns.map(b => b.id);
    }
    return [...storedIds, ...remainingIds];
  }

  function renderSortUI() {
    const modalBody = document.querySelector('#settingsModal .modal-body');
    if (!modalBody) return;

    const existing = document.getElementById('nav-sort-block');
    if (existing) existing.remove();

    const block = document.createElement('div');
    block.id = 'nav-sort-block';
    block.style.cssText = 'margin-top: 20px; border-top: 2px solid var(--border); padding-top: 16px;';

    block.innerHTML = `
      <div class="settings-label" style="margin-bottom: 10px;">📱 Порядок вкладок</div>
      <div style="font-size: 11px; color: var(--muted); margin-bottom: 10px; line-height: 1.4;">Стрелками меняйте порядок. Применяется сразу. <b>Применяется только к этому устройству.</b></div>
      <div id="nav-sort-list"></div>
      <button class="btn btn-secondary btn-small" style="width: 100%; margin-top: 10px;" id="nav-sort-reset">↺ Сбросить (вернуть по умолчанию)</button>
    `;
    modalBody.appendChild(block);

    const list = block.querySelector('#nav-sort-list');

    function render() {
      const ids = buildOrderList();
      const btns = getAllBtns();
      const map = {};
      btns.forEach(b => map[b.id] = b);

      list.innerHTML = ids.map((id, idx) => {
        const btn = map[id];
        if (!btn) return '';
        const text = btn.querySelector('.nav-text')?.textContent || id.replace('nav-', '');
        const icon = btn.querySelector('.nav-icon')?.textContent || '';
        const isHidden = btn.classList.contains('perm-blocked') || btn.style.display === 'none';
        return `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 4px; ${isHidden ? 'opacity: 0.55;' : ''}">
            <span style="font-size: 13px;">${icon} ${text}${isHidden ? ' <span style="font-size: 10px; color: var(--muted);">(скрыта)</span>' : ''}</span>
            <div style="display: flex; gap: 4px;">
              <button class="btn btn-secondary btn-small" data-act="up" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''} style="padding: 4px 8px; min-height: 28px; min-width: 32px;">⬆️</button>
              <button class="btn btn-secondary btn-small" data-act="down" data-idx="${idx}" ${idx === ids.length - 1 ? 'disabled' : ''} style="padding: 4px 8px; min-height: 28px; min-width: 32px;">⬇️</button>
            </div>
          </div>
        `;
      }).join('');

      list.querySelectorAll('button[data-act]').forEach(b => {
        b.addEventListener('click', () => {
          const idx = parseInt(b.dataset.idx);
          const act = b.dataset.act;
          const target = act === 'up' ? idx - 1 : idx + 1;
          if (target < 0 || target >= ids.length) return;
          const tmp = ids[idx];
          ids[idx] = ids[target];
          ids[target] = tmp;
          saveOrder(ids);
          applyOrder();
          render();
        });
      });
    }
    render();

    block.querySelector('#nav-sort-reset').addEventListener('click', () => {
      localStorage.removeItem(ORDER_KEY);
      // Возвращаем дефолтный порядок
      const nav = getNav();
      if (nav) {
        const btns = getAllBtns();
        const map = {};
        btns.forEach(b => map[b.id] = b);
        DEFAULT_ORDER.forEach(id => {
          if (map[id]) { nav.appendChild(map[id]); delete map[id]; }
        });
        Object.values(map).forEach(b => nav.appendChild(b));
      }
      render();
      if (window.showToastEl) window.showToastEl('↺ Порядок сброшен по умолчанию', false);
    });
  }

  // Перехват открытия настроек
  const origOpen = window.openSettingsModal;
  window.openSettingsModal = function() {
    if (origOpen) origOpen.apply(this, arguments);
    setTimeout(renderSortUI, 80);
  };

  // Применение порядка при загрузке и периодически (для новых кнопок от плагинов)
  let applying = false;
  function safeApply() {
    if (applying) return;
    applying = true;
    try { applyOrder(); } finally { applying = false; }
  }

  setInterval(safeApply, 700);
  setTimeout(safeApply, 200);
  setTimeout(safeApply, 1000);
  setTimeout(safeApply, 2500);

  // При появлении новых кнопок в nav — пересортировать
  const navEl = document.getElementById('bottomNav');
  if (navEl && typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver(() => {
      if (applying) return;
      setTimeout(safeApply, 50);
    });
    obs.observe(navEl, { childList: true });
  }

  console.log('[nav-sort-v2] ✅ Сортировка вкладок активна. Ключ: ' + ORDER_KEY);
})();; }
catch (e) { console.error('[baked patch: Порядок кнопки]', e); }
try { (function(){
  if (window.__fixLogDeleteV1) return;
  window.__fixLogDeleteV1 = true;

  // ===== Обновление overlay 📄 Лист, если открыт =====
  function refreshOverlayIfOpen() {
    const overlay = document.getElementById('report-viewer-overlay');
    if (!overlay) return;
    const paper = overlay.querySelector('.paper-report-container');
    if (!paper) return;
    if (!state || !state.shift) return;
    if (typeof buildReportHTML !== 'function') return;

    try {
      const objNameEl = paper.querySelector('.paper-object-name');
      const isGaiMode = objNameEl && objNameEl.textContent.includes('ГАИ');

      const logs = getLogs().filter(l => !!l.isGAI === isGaiMode);
      const activeLineIds = getActiveLineIds();

      const checkTTN = isGaiMode ? null : (id, logId) => {
        return state.truckStatus[id] && state.truckStatus[id].ttnStatus === true && state.truckStatus[id].ttnLogId === logId;
      };

      const html = buildReportHTML({
        objectName: state.shift.objectName,
        date: state.shift.startDate,
        logs: logs,
        activeLineIds: activeLineIds,
        type: isGaiMode ? 'gai' : 'regular',
        checkTTN: checkTTN
      });

      paper.innerHTML = html;
    } catch(e) {
      console.warn('[fix-log-delete] overlay refresh:', e);
    }
  }

  // ===== Перерисовать всё =====
  function forceRenderAll() {
    if (typeof renderReport === 'function') { try { renderReport(); } catch(e) { console.warn(e); } }
    if (typeof renderLine === 'function') { try { renderLine(); } catch(e) { console.warn(e); } }
    if (typeof renderHeaderStats === 'function') { try { renderHeaderStats(); } catch(e) { console.warn(e); } }
    if (typeof renderAnalytics === 'function') { try { renderAnalytics(true); } catch(e) { console.warn(e); } }
    refreshOverlayIfOpen();
  }

  // ===== Переопределяем deleteLog =====
  window.deleteLog = async function(id) {
    if (typeof requireEdit === 'function' && !requireEdit('edit_logs')) return;
    if (!(await appConfirm('Удалить рейс?'))) return;

    const log = state.logs.find(l => l.id === id);
    if (!log) { if (typeof showError === 'function') showError('Рейс не найден'); return; }

    const snapshot = Object.assign({}, log);

    try {
      // 1. Сначала удаляем из Firestore и ждём подтверждения
      await refs.logs.doc(id).delete();

      // 2. Только после успеха — удаляем из локального состояния
      state.logs = state.logs.filter(x => x.id !== id);
      if (typeof saveCache === 'function') saveCache();

      // 3. Принудительно перерисовываем всё
      forceRenderAll();

      // 4. Дополнительные перерисовки на случай, если onSnapshot ещё не отработал
      setTimeout(forceRenderAll, 100);
      setTimeout(forceRenderAll, 400);
      setTimeout(forceRenderAll, 1000);

      // 5. Тост
      if (typeof showToastEl === 'function') {
        showToastEl('🗑 Рейс удалён: ' + (snapshot.truckName || '') + ' (+' + (snapshot.volume || 0) + ' м³)', false);
      }

      // 6. Аудит
      if (typeof addAudit === 'function') {
        addAudit('🗑 Удалён рейс: ' + (snapshot.truckName || '') + ' (+' + (snapshot.volume || 0) + ' м³)').catch(()=>{});
      }
    } catch(e) {
      // Ошибка Firestore — восстанавливаем локально
      if (!state.logs.find(l => l.id === id)) {
        state.logs.push(snapshot);
        state.logs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        if (typeof saveCache === 'function') saveCache();
      }
      forceRenderAll();
      if (typeof showError === 'function') showError('Не удалось удалить рейс: ' + e.message);
    }
  };

  // ===== Расширяем saveLogEdit (edit) =====
  const origSaveLogEdit = window.saveLogEdit;
  if (origSaveLogEdit) {
    window.saveLogEdit = async function() {
      const result = await origSaveLogEdit.apply(this, arguments);
      // После сохранения тоже перерисовываем overlay
      setTimeout(forceRenderAll, 100);
      setTimeout(forceRenderAll, 400);
      return result;
    };
  }

  // ===== Обёртка renderReport — обновляет overlay при каждом вызове =====
  const origRenderReport = window.renderReport;
  if (origRenderReport) {
    window.renderReport = function() {
      const result = origRenderReport.apply(this, arguments);
      setTimeout(refreshOverlayIfOpen, 30);
      return result;
    };
  }

  console.log('[fix-log-delete] ✅ Активен. Удаление рейсов синхронизировано с отчётом и overlay.');
})();; }
catch (e) { console.error('[baked patch: Удаление рейса с листика]', e); }
try { (function(){
  if (window.__autoBackupV1) return;
  window.__autoBackupV1 = true;

  const BACKUPS_COLL = db.collection('backups');
  const CHUNK_SIZE = 700000; // 700 KB на чанк (безопасно < 1 MB)
  const MAX_BACKUPS = 15;
  const DEFAULT_INTERVAL_H = 6;

  let backupInProgress = false;

  // ===== Утилиты =====
  function tsLabel(ts) {
    return ts ? new Date(ts).toLocaleString('ru-RU') : '—';
  }
  function sizeLabel(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
    return (bytes / (1024 * 1024)).toFixed(2) + ' МБ';
  }
  function byteLength(str) {
    try { return new Blob([str]).size; } catch(e) { return str.length; }
  }

  // ===== Список коллекций для бэкапа =====
  function collectionsForBackup() {
    return [
      { path: ['workspaces','main_workspace','trucks'], name: 'trucks', cat: 'base' },
      { path: ['workspaces','main_workspace','objects'], name: 'objects', cat: 'base' },
      { path: ['workspaces','main_workspace','archive'], name: 'archive', cat: 'archive' },
      { path: ['workspaces','main_workspace','trash'], name: 'trash', cat: 'archive' },
      { path: ['workspaces','main_workspace','logs'], name: 'logs', cat: 'shift' },
      { path: ['workspaces','main_workspace','truckStatus'], name: 'truckStatus', cat: 'shift' },
      { path: ['workspaces','main_workspace','notifications'], name: 'notifications', cat: 'shift' },
      { path: ['workspaces','main_workspace','audit'], name: 'audit', cat: 'audit', limit: 500 },
      { path: ['workspaces','main_workspace','plugins'], name: 'plugins', cat: 'settings' },
      { path: ['workspaces','main_workspace','patches'], name: 'patches', cat: 'settings' },
      { path: ['users'], name: 'users', cat: 'users' },
      { path: ['settings','permissions'], name: 'permissions', cat: 'settings', isDoc: true },
      { path: ['settings','appConfig'], name: 'appConfig', cat: 'settings', isDoc: true },
      { path: ['settings','appConfig_test'], name: 'appConfig_test', cat: 'settings', isDoc: true },
      { path: ['workspaces','main_workspace','shift','current'], name: 'shift', cat: 'shift', isDoc: true }
    ];
  }

  function refFromPath(path) {
    let ref = db;
    for (let i = 0; i < path.length - 1; i++) {
      ref = ref.collection(path[i]).doc(path[i + 1]);
      i++;
    }
    if (path.length % 2 === 1) {
      // последний — коллекция
      ref = ref.collection(path[path.length - 1]);
    }
    return ref;
  }

  async function readCollection(path, opts) {
    opts = opts || {};
    let ref = db;
    for (let i = 0; i < path.length - 1; i++) {
      if (i + 1 < path.length - 1 && path[i + 1]) {
        ref = ref.collection(path[i]).doc(path[i + 1]);
        i++;
      }
    }
    if (path.length % 2 === 1) {
      ref = ref.collection(path[path.length - 1]);
      let q = ref;
      if (opts.limit) {
        try {
          q = ref.orderBy('timestamp', 'desc').limit(opts.limit);
        } catch(e) {
          q = ref.limit(opts.limit);
        }
      }
      const snap = await q.get();
      return snap.docs.map(d => ({ id: d.id, data: d.data() }));
    } else {
      // последний элемент — id документа
      const docRef = ref.doc(path[path.length - 1]);
      const snap = await docRef.get();
      return snap.exists ? [{ id: snap.id, data: snap.data() }] : [];
    }
  }

  // ===== Создание бэкапа =====
  async function createBackup(type, description) {
    if (backupInProgress) {
      if (typeof showToastEl === 'function') showToastEl('⏳ Уже идёт создание бэкапа', true);
      return null;
    }
    backupInProgress = true;

    try {
      if (typeof showToastEl === 'function') showToastEl('💾 Создание бэкапа...', false);

      const cols = collectionsForBackup();
      const payload = {
        version: 1,
        createdAt: Date.now(),
        type: type,
        description: description || '',
        appVersion: '2.88',
        data: {}
      };
      const counts = {};

      for (const col of cols) {
        try {
          const docs = await readCollection(col.path, { limit: col.limit });
          payload.data[col.name] = docs;
          counts[col.name] = docs.length;
        } catch(e) {
          console.warn('[backup] read error:', col.name, e);
          payload.data[col.name] = [];
          counts[col.name] = 0;
        }
      }

      // Сериализация
      const jsonStr = JSON.stringify(payload);
      const totalBytes = byteLength(jsonStr);
      const chunkCount = Math.ceil(jsonStr.length / CHUNK_SIZE);

      // Метаданные
      const metaRef = BACKUPS_COLL.doc();
      const meta = {
        id: metaRef.id,
        createdAt: Date.now(),
        createdBy: (typeof getUserName === 'function') ? getUserName() : '—',
        createdByEmail: (typeof currentEmail !== 'undefined') ? currentEmail : '',
        type: type,
        description: description || '',
        sizeBytes: totalBytes,
        chunkCount: chunkCount,
        counts: counts,
        appVersion: '2.88'
      };

      // Чанки
      for (let i = 0; i < chunkCount; i++) {
        const chunk = jsonStr.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        await metaRef.collection('chunks').doc(String(i)).set({ idx: i, data: chunk });
      }

      // Метаданные последними (чтобы бэкап считался готовым только когда все чанки на месте)
      await metaRef.set(meta);

      console.log('[backup] Created:', meta.id, sizeLabel(totalBytes), counts);
      if (typeof showToastEl === 'function') showToastEl('✅ Бэкап создан (' + sizeLabel(totalBytes) + ')', false);

      // Обновить "last auto"
      if (type === 'auto') {
        try { localStorage.setItem('dt_backup_last_auto', String(Date.now())); } catch(e) {}
      }

      // Ротация (удалить старые, кроме important)
      await rotateBackups();

      // Перерисовать UI
      renderBackupUI();

      return meta;
    } catch(e) {
      console.error('[backup] Create error:', e);
      if (typeof showError === 'function') showError('Ошибка бэкапа: ' + e.message);
      return null;
    } finally {
      backupInProgress = false;
    }
  }

  // ===== Ротация =====
  async function rotateBackups() {
    try {
      const snap = await BACKUPS_COLL.orderBy('createdAt', 'desc').get();
      const docs = snap.docs;
      if (docs.length <= MAX_BACKUPS) return;

      // Удалить те, что сверх лимита, кроме important
      const toDelete = [];
      for (let i = MAX_BACKUPS; i < docs.length; i++) {
        const d = docs[i].data();
        if (d.important) continue;
        toDelete.push(docs[i]);
      }

      for (const doc of toDelete) {
        // Удалить чанки
        const chunksSnap = await doc.ref.collection('chunks').get();
        for (const ch of chunksSnap.docs) {
          await ch.ref.delete();
        }
        await doc.ref.delete();
      }

      if (toDelete.length > 0) {
        console.log('[backup] Rotated:', toDelete.length, 'old backups removed');
      }
    } catch(e) {
      console.warn('[backup] Rotate error:', e);
    }
  }

  // ===== Список бэкапов =====
  async function listBackups() {
    try {
      const snap = await BACKUPS_COLL.orderBy('createdAt', 'desc').limit(50).get();
      return snap.docs.map(d => d.data());
    } catch(e) {
      console.warn('[backup] List error:', e);
      return [];
    }
  }

  // ===== Чтение бэкапа =====
  async function readBackupData(id) {
    const metaDoc = await BACKUPS_COLL.doc(id).get();
    if (!metaDoc.exists) throw new Error('Бэкап не найден');
    const meta = metaDoc.data();
    const chunksSnap = await BACKUPS_COLL.doc(id).collection('chunks').orderBy('idx', 'asc').get();
    if (chunksSnap.size !== meta.chunkCount) {
      throw new Error('Не все чанки найдены (' + chunksSnap.size + '/' + meta.chunkCount + ')');
    }
    let json = '';
    chunksSnap.docs.forEach(d => { json += d.data().data; });
    return JSON.parse(json);
  }

  // ===== Удаление бэкапа =====
  async function deleteBackup(id) {
    if (!(await appConfirm('Удалить этот бэкап? Восстановить из него будет невозможно.'))) return;
    try {
      const chunksSnap = await BACKUPS_COLL.doc(id).collection('chunks').get();
      for (const ch of chunksSnap.docs) await ch.ref.delete();
      await BACKUPS_COLL.doc(id).delete();
      if (typeof showToastEl === 'function') showToastEl('🗑 Бэкап удалён', false);
      renderBackupUI();
    } catch(e) {
      if (typeof showError === 'function') showError(e.message);
    }
  }

  // ===== Скачать бэкап как файл =====
  async function downloadBackupFile(id) {
    try {
      if (typeof showToastEl === 'function') showToastEl('⏳ Загрузка...', false);
      const data = await readBackupData(id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'backup_' + id + '.json';
      a.click();
      URL.revokeObjectURL(url);
      if (typeof showToastEl === 'function') showToastEl('📥 Скачано', false);
    } catch(e) {
      if (typeof showError === 'function') showError(e.message);
    }
  }

  // ===== Восстановление =====
  async function restoreBackup(id, sections) {
    // sections: { base: true, archive: true, settings: true, users: true, shift: true }
    try {
      if (typeof showToastEl === 'function') showToastEl('⏳ Чтение бэкапа...', false);
      const payload = await readBackupData(id);

      // 1. Авто-бэкап текущего состояния (before_restore)
      if (typeof showToastEl === 'function') showToastEl('⏳ Бэкап текущего состояния...', false);
      await createBackup('before_restore', 'Перед восстановлением из ' + id);

      // 2. Восстановление
      if (typeof showToastEl === 'function') showToastEl('⏳ Восстановление...', false);

      const cols = collectionsForBackup();
      for (const col of cols) {
        const cat = col.cat;
        if (sections[cat] !== true) continue;

        const docs = payload.data[col.name] || [];
        const ref = refFromPath(col.path);

        // Определяем, коллекция это или документ
        const isDoc = col.isDoc === true;

        if (isDoc) {
          if (docs.length > 0) {
            await ref.set(docs[0].data, { merge: false });
          } else {
            await ref.delete().catch(() => {});
          }
          continue;
        }

        // Коллекция — удалить всё старое и добавить
        const existing = await ref.get();
        // Батчи по 400
        const existingDocs = existing.docs;
        for (let i = 0; i < existingDocs.length; i += 400) {
          const b = db.batch();
          for (let j = i; j < Math.min(i + 400, existingDocs.length); j++) {
            b.delete(existingDocs[j].ref);
          }
          await b.commit();
        }

        // Восстановление
        for (let i = 0; i < docs.length; i += 400) {
          const b = db.batch();
          for (let j = i; j < Math.min(i + 400, docs.length); j++) {
            const item = docs[j];
            b.set(ref.doc(item.id), item.data, { merge: false });
          }
          await b.commit();
        }

        console.log('[backup] Restored', col.name, ':', docs.length, 'docs');
      }

      if (typeof showToastEl === 'function') showToastEl('✅ Восстановление завершено. Перезагрузка...', false);
      setTimeout(() => location.reload(), 1500);
    } catch(e) {
      console.error('[backup] Restore error:', e);
      if (typeof showError === 'function') showError('Ошибка восстановления: ' + e.message);
    }
  }

  // ===== Модалка восстановления =====
  async function openRestoreModal(id) {
    const metaDoc = await BACKUPS_COLL.doc(id).get();
    if (!metaDoc.exists) { showError('Бэкап не найден'); return; }
    const meta = metaDoc.data();

    const old = document.getElementById('restoreBackupModal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'restoreBackupModal';
    overlay.className = 'modal open';
    overlay.style.zIndex = '10020';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '500px';
    content.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <h3 style="font-size:16px;">♻️ Восстановление бэкапа</h3>
        <button class="btn-del" onclick="document.getElementById('restoreBackupModal').remove()">✕</button>
      </div>
      <div style="font-size:12px; color:var(--muted); margin-bottom:12px; line-height:1.5;">
        📅 <b>${tsLabel(meta.createdAt)}</b><br>
        👤 ${escapeHtml(meta.createdBy || '—')} · ${sizeLabel(meta.sizeBytes)} · ${meta.type || 'manual'}
      </div>

      <div style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:10px; font-size:12px; color:#fca5a5; margin-bottom:14px; line-height:1.4;">
        ⚠️ <b>Внимание!</b> Текущие данные в выбранных секциях будут заменены данными из бэкапа.<br>
        Перед восстановлением автоматически создаётся резервная копия текущего состояния.
      </div>

      <div style="font-size:13px; font-weight:700; margin-bottom:8px;">Что восстановить:</div>
      <label style="display:flex; align-items:center; gap:8px; padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; margin-bottom:6px; cursor:pointer;">
        <input type="checkbox" id="rsBase" checked style="width:18px; height:18px; accent-color:var(--primary);">
        <span>🏢 База (самосвалы, объекты) — <b>${(meta.counts?.trucks || 0) + (meta.counts?.objects || 0)}</b> записей</span>
      </label>
      <label style="display:flex; align-items:center; gap:8px; padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; margin-bottom:6px; cursor:pointer;">
        <input type="checkbox" id="rsArchive" checked style="width:18px; height:18px; accent-color:var(--primary);">
        <span>🗄 Архив (закрытые смены) — <b>${(meta.counts?.archive || 0) + (meta.counts?.trash || 0)}</b> смен</span>
      </label>
      <label style="display:flex; align-items:center; gap:8px; padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; margin-bottom:6px; cursor:pointer;">
        <input type="checkbox" id="rsSettings" checked style="width:18px; height:18px; accent-color:var(--primary);">
        <span>⚙️ Настройки (права, MAX, патчи, расширения)</span>
      </label>
      <label style="display:flex; align-items:center; gap:8px; padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; margin-bottom:6px; cursor:pointer;">
        <input type="checkbox" id="rsUsers" checked style="width:18px; height:18px; accent-color:var(--primary);">
        <span>👥 Пользователи — <b>${meta.counts?.users || 0}</b> (метаданные, не пароли)</span>
      </label>
      <label style="display:flex; align-items:center; gap:8px; padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; margin-bottom:12px; cursor:pointer;">
        <input type="checkbox" id="rsShift" checked style="width:18px; height:18px; accent-color:var(--primary);">
        <span>🚛 Текущая смена + рейсы + статусы</span>
      </label>

      <div style="display:flex; gap:8px;">
        <button class="btn btn-secondary" onclick="document.getElementById('restoreBackupModal').remove()" style="flex:1;">Отмена</button>
        <button class="btn btn-danger" id="rsConfirmBtn" style="flex:1;">♻️ Восстановить</button>
      </div>
    `;
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    content.querySelector('#rsConfirmBtn').onclick = async () => {
      const sections = {
        base: content.querySelector('#rsBase').checked,
        archive: content.querySelector('#rsArchive').checked,
        settings: content.querySelector('#rsSettings').checked,
        users: content.querySelector('#rsUsers').checked,
        shift: content.querySelector('#rsShift').checked
      };
      if (!sections.base && !sections.archive && !sections.settings && !sections.users && !sections.shift) {
        appNotice('Выберите хотя бы одну секцию');
        return;
      }

      // Двойное подтверждение
      const ok = (await appConfirm(`Восстановить из бэкапа?\n\n${tsLabel(meta.createdAt)}\n\nТекущие данные в выбранных секциях будут перезаписаны.`));
      if (!ok) return;

      overlay.remove();
      await restoreBackup(id, sections);
    };
  }

  // ===== UI =====
  function renderBackupUI() {
    const tab = document.getElementById('tab-backup');
    if (!tab) return;

    // Удалить старый блок
    const old = document.getElementById('backupAutoBlock');
    if (old) old.remove();

    const block = document.createElement('div');
    block.id = 'backupAutoBlock';
    block.innerHTML = `
      <div class="section-title" style="margin-top:0;">💾 Автоматические бэкапы на сервере</div>
      <div class="form-card">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; gap:8px; flex-wrap:wrap;">
          <div style="flex:1; min-width:150px;">
            <div style="font-size:13px; font-weight:700;">Автобэкап</div>
            <div style="font-size:11px; color:var(--muted); margin-top:2px;">При загрузке приложения</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="autoBackupToggle">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div style="display:flex; gap:6px; align-items:center; margin-bottom:12px;">
          <label style="font-size:12px; color:var(--muted);">Интервал:</label>
          <select id="autoBackupInterval" class="form-control" style="flex:1; font-size:12px; padding:6px;">
            <option value="1">Каждый час</option>
            <option value="3">Каждые 3 часа</option>
            <option value="6" selected>Каждые 6 часов</option>
            <option value="12">Каждые 12 часов</option>
            <option value="24">Раз в день</option>
          </select>
        </div>
        <button class="btn btn-quick" id="createBackupBtn" style="width:100%;">💾 Создать бэкап сейчас</button>
        <div style="font-size:11px; color:var(--muted); margin-top:8px; text-align:center;" id="lastBackupInfo">—</div>
      </div>

      <div class="section-title">📋 Точки восстановления</div>
      <div id="backupsListContainer">
        <div class="empty-state">Загрузка...</div>
      </div>
    `;
    tab.insertBefore(block, tab.firstChild);

    // Wire
    const toggle = block.querySelector('#autoBackupToggle');
    const interval = block.querySelector('#autoBackupInterval');
    const createBtn = block.querySelector('#createBackupBtn');

    toggle.checked = localStorage.getItem('dt_backup_auto') === '1';
    interval.value = localStorage.getItem('dt_backup_interval') || '6';

    toggle.onchange = () => {
      localStorage.setItem('dt_backup_auto', toggle.checked ? '1' : '0');
      if (typeof showToastEl === 'function') showToastEl(toggle.checked ? '✅ Автобэкап включён' : '⏸ Автобэкап выключен', false);
    };
    interval.onchange = () => {
      localStorage.setItem('dt_backup_interval', interval.value);
    };
    createBtn.onclick = () => createBackup('manual', 'Ручной бэкап');

    updateLastBackupInfo();
    loadBackupsList();
  }

  function updateLastBackupInfo() {
    const el = document.getElementById('lastBackupInfo');
    if (!el) return;
    const lastAuto = parseInt(localStorage.getItem('dt_backup_last_auto') || '0');
    if (lastAuto) {
      const ago = Math.floor((Date.now() - lastAuto) / 60000);
      let agoStr;
      if (ago < 60) agoStr = ago + ' мин назад';
      else if (ago < 1440) agoStr = Math.floor(ago / 60) + ' ч назад';
      else agoStr = Math.floor(ago / 1440) + ' дн назад';
      el.textContent = 'Последний автобэкап: ' + tsLabel(lastAuto) + ' (' + agoStr + ')';
    } else {
      el.textContent = 'Автобэкапов ещё не было';
    }
  }

  async function loadBackupsList() {
    const c = document.getElementById('backupsListContainer');
    if (!c) return;

    try {
      const backups = await listBackups();

      if (!backups.length) {
        c.innerHTML = '<div class="empty-state">Пока нет бэкапов</div>';
        return;
      }

      const typeLabels = {
        auto: { label: 'Авто', color: '#3b82f6' },
        manual: { label: 'Ручной', color: '#22c55e' },
        before_restore: { label: 'Перед восст.', color: '#f59e0b' },
        before_close: { label: 'Перед закрытием', color: '#f59e0b' },
        before_import: { label: 'Перед импортом', color: '#f59e0b' }
      };

      c.innerHTML = backups.map(b => {
        const t = typeLabels[b.type] || { label: b.type || '—', color: '#94a3b8' };
        const counts = b.counts || {};
        return `
          <div class="log-item" style="display:flex; flex-direction:column; align-items:stretch; gap:8px; padding:10px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap;">
              <div style="flex:1; min-width:0;">
                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                  <span style="font-size:11px; font-weight:800; color:${t.color}; text-transform:uppercase;">${t.label}</span>
                  ${b.important ? '<span style="font-size:10px; background:rgba(139,92,246,0.2); color:#c4b5fd; padding:1px 6px; border-radius:4px; font-weight:700;">⭐ ВАЖНЫЙ</span>' : ''}
                </div>
                <div style="font-size:12px; font-weight:600; margin-top:3px;">${tsLabel(b.createdAt)}</div>
                <div style="font-size:10px; color:var(--muted); margin-top:2px;">
                  👤 ${escapeHtml(b.createdBy || '—')} · ${sizeLabel(b.sizeBytes)} · 
                  🚛${counts.trucks || 0} 🏢${counts.objects || 0} 🗄${counts.archive || 0} 👥${counts.users || 0}
                </div>
              </div>
            </div>
            <div style="display:flex; gap:4px; flex-wrap:wrap;">
              <button class="btn btn-quick btn-small" data-restore-id="${b.id}" style="flex:1; font-size:11px; padding:6px;">♻️ Восстановить</button>
              <button class="btn btn-secondary btn-small" data-download-id="${b.id}" style="flex:1; font-size:11px; padding:6px;">📥 Скачать</button>
              <button class="btn btn-secondary btn-small" data-important-id="${b.id}" data-important="${b.important ? '1' : '0'}" style="font-size:11px; padding:6px;">${b.important ? '⭐' : '☆'}</button>
              <button class="btn btn-danger btn-small" data-delete-id="${b.id}" style="font-size:11px; padding:6px;">🗑</button>
            </div>
          </div>
        `;
      }).join('');

      c.querySelectorAll('[data-restore-id]').forEach(btn => {
        btn.onclick = () => openRestoreModal(btn.dataset.restoreId);
      });
      c.querySelectorAll('[data-download-id]').forEach(btn => {
        btn.onclick = () => downloadBackupFile(btn.dataset.downloadId);
      });
      c.querySelectorAll('[data-delete-id]').forEach(btn => {
        btn.onclick = () => deleteBackup(btn.dataset.deleteId);
      });
      c.querySelectorAll('[data-important-id]').forEach(btn => {
        btn.onclick = async () => {
          const id = btn.dataset.importantId;
          const isImportant = btn.dataset.important === '1';
          try {
            await BACKUPS_COLL.doc(id).update({ important: !isImportant });
            loadBackupsList();
          } catch(e) {
            if (typeof showError === 'function') showError(e.message);
          }
        };
      });
    } catch(e) {
      c.innerHTML = '<div class="empty-state" style="color:var(--danger);">Ошибка: ' + escapeHtml(e.message) + '</div>';
    }
  }

  // ===== Автобэкап при загрузке =====
  async function checkAutoBackup() {
    if (typeof currentUserRole === 'undefined' || currentUserRole !== 'admin') return;
    if (localStorage.getItem('dt_backup_auto') !== '1') return;
    if (backupInProgress) return;

    const intervalH = parseInt(localStorage.getItem('dt_backup_interval') || '6') || 6;
    const lastAuto = parseInt(localStorage.getItem('dt_backup_last_auto') || '0');
    const elapsed = Date.now() - lastAuto;

    if (elapsed < intervalH * 3600000) {
      console.log('[backup] Auto skip: только', Math.floor(elapsed / 60000), 'мин назад было');
      return;
    }

    console.log('[backup] Auto backup: срабатывает');
    await createBackup('auto', 'Автобэкап каждые ' + intervalH + 'ч');
  }

  // ===== Хук: перед закрытием смены =====
  const origCloseShift = window.closeShift;
  if (origCloseShift) {
    window.closeShift = async function() {
      // Проверяем — смена активна и админ
      if (state.shift && state.shift.isActive && typeof currentUserRole !== 'undefined' && currentUserRole === 'admin') {
        const ok = (await appConfirm('Перед закрытием смены создать резервную копию?'));
        if (ok) {
          await createBackup('before_close', 'Перед закрытием смены ' + (state.shift.objectName || ''));
        }
      }
      return origCloseShift.apply(this, arguments);
    };
  }

  // ===== Хук: перед импортом =====
  const origImportBackup = window.importBackupFile;
  if (origImportBackup) {
    window.importBackupFile = async function(ev) {
      if (typeof currentUserRole !== 'undefined' && currentUserRole === 'admin') {
        const file = ev.target?.files?.[0];
        if (file) {
          const ok = (await appConfirm('Перед импортом создать резервную копию текущих данных?'));
          if (ok) {
            await createBackup('before_import', 'Перед импортом бэкапа');
          }
        }
      }
      return origImportBackup.apply(this, arguments);
    };
  }

  // ===== Перехват switchTab для рендера UI =====
  const origSwitchTab = window.switchTab;
  if (origSwitchTab) {
    window.switchTab = function(name, btn) {
      const result = origSwitchTab.apply(this, arguments);
      if (name === 'backup') {
        setTimeout(renderBackupUI, 100);
        setTimeout(() => {
          updateLastBackupInfo();
          loadBackupsList();
        }, 200);
      }
      return result;
    };
  }

  // ===== Первый запуск =====
  setTimeout(() => {
    if (document.getElementById('tab-backup')?.classList.contains('active')) {
      renderBackupUI();
    }
  }, 800);

  // Автобэкап через 5 секунд после загрузки (дать время всем патчам)
  setTimeout(checkAutoBackup, 5000);

  // Периодическая проверка (каждые 30 минут)
  setInterval(() => {
    if (typeof currentUserRole !== 'undefined' && currentUserRole === 'admin') {
      checkAutoBackup();
    }
  }, 30 * 60000);

  console.log('[backup-v1] ✅ Активен. Автобэкап + ручное + восстановление.');
})();; }
catch (e) { console.error('[baked patch: Резервное копирование]', e); }
try { (function(){
  if (window.__animSpeedsV7) return;
  window.__animSpeedsV7 = true;

  const SPEEDS_KEY = 'dt_anim_speeds_v1';
  const DEFAULTS = { overall: 1, fill: 1, shake: 1, wave: 1 };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function loadSpeeds() {
    try {
      const raw = localStorage.getItem(SPEEDS_KEY);
      if (!raw) return { ...DEFAULTS };
      const s = JSON.parse(raw);
      return {
        overall: clamp(s.overall ?? 1, 0.3, 2.5),
        fill: clamp(s.fill ?? 1, 0.3, 2.5),
        shake: clamp(s.shake ?? 1, 0.3, 2.5),
        wave: clamp(s.wave ?? 1, 0.3, 2.5),
      };
    } catch(e) { return { ...DEFAULTS }; }
  }
  function saveSpeeds(s) { try { localStorage.setItem(SPEEDS_KEY, JSON.stringify(s)); } catch(e) {} }

  function getTimings() {
    const s = loadSpeeds();
    return {
      ARRIVE: 3.5 * s.overall,
      LOAD_OUT: 3.5 * s.overall,
      LOAD_FILL: 1.5 * s.overall * s.fill,
      SHAKE: 0.35 * s.shake,
      WAVE_MS: 260 * s.wave,
      SETTLE: 0.8 * s.overall,
      SETTLE_DELAY_MS: 500 * s.overall,
      BUMP: 0.35 * s.overall
    };
  }

  const ANIM_EASE = 'cubic-bezier(0.4, 0.0, 0.2, 1)';

  // ===== CSS =====
  ['arrive-fix-css', 'visual-cards-css', 'visual-cards-v2-css', 'domino-bump-css', 'focus-arrive-css', 'anim-speeds-css'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });

  const css = document.createElement('style');
  css.id = 'anim-speeds-css';
  css.textContent = `
    .truck-card {
      height: 142px !important; min-height: 142px !important; max-height: 142px !important;
      padding: 10px 12px !important; margin-bottom: 10px !important;
      box-sizing: border-box !important; display: flex !important; flex-direction: column !important;
      gap: 8px !important; overflow: hidden !important; position: relative !important; z-index: 2 !important;
      border-width: 1px !important; border-radius: 12px !important; will-change: transform, box-shadow;
    }
    .truck-card.arrived {
      border-color: var(--warning) !important;
      box-shadow: 0 0 0 1px var(--warning), 0 0 10px rgba(245, 158, 11, 0.35) !important;
    }
    .truck-card.faded:not(.arrived) {
      opacity: 0.35 !important; filter: grayscale(50%) !important; background: #131b2e !important;
    }
    .truck-card .truck-top { flex: 1 1 auto !important; display: flex !important; gap: 12px !important; min-height: 0 !important; overflow: hidden !important; }
    .truck-card .truck-identity {
      flex: 0 0 130px !important; width: 130px !important;
      display: flex !important; flex-direction: column !important; justify-content: center !important;
      gap: 4px !important; min-width: 0 !important; overflow: hidden !important;
    }
    .truck-card .truck-brand {
      font-size: 10.5px !important; font-weight: 700 !important; color: var(--muted) !important;
      text-transform: uppercase !important; letter-spacing: 0.6px !important; line-height: 1 !important;
      overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important;
    }
    .truck-card .truck-plate-wrap { display: flex !important; min-width: 0 !important; }
    .truck-card .truck-plate-wrap .ru-plate { height: 34px !important; margin: 0 !important; }
    .truck-card .truck-plate-wrap .ru-plate-main { font-size: 20px !important; padding: 0 6px !important; gap: 1px !important; }
    .truck-card .truck-plate-wrap .ru-plate-main .plate-letter { font-size: 20px !important; }
    .truck-card .truck-plate-wrap .ru-plate-main .plate-digit { font-size: 21px !important; letter-spacing: 1.5px !important; }
    .truck-card .truck-plate-wrap .ru-plate-region { width: 28px !important; min-width: 28px !important; max-width: 28px !important; padding: 1px 0 !important; }
    .truck-card .truck-plate-wrap .ru-plate-region .region-code.region-2 { font-size: 13px !important; }
    .truck-card .truck-plate-wrap .ru-plate-region .region-code.region-3 { font-size: 12px !important; }
    .truck-card .truck-plate-wrap .ru-plate-region .region-rus { font-size: 5px !important; }
    .truck-card .truck-plate-wrap .ru-plate-region .ru-plate-flag { width: 12px !important; height: 7.5px !important; }
    .truck-card .truck-info {
      flex: 1 1 auto !important; min-width: 0 !important;
      display: flex !important; flex-direction: column !important;
      justify-content: center !important; gap: 3px !important; overflow: hidden !important;
    }
    .truck-card .info-row {
      font-size: 11px !important; line-height: 1.2 !important;
      white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
      color: var(--muted) !important; display: flex !important; align-items: center !important; gap: 4px !important;
    }
    .truck-card .info-row b { color: var(--text) !important; font-weight: 700 !important; }
    .truck-card .info-row.info-trip { color: #93c5fd !important; font-weight: 800 !important; font-size: 12px !important; }
    .truck-card .info-row.info-trip b { color: #93c5fd !important; }
    .truck-card .info-row.info-load b { color: #38bdf8 !important; }
    .truck-card .info-row.info-arrive { color: #f59e0b !important; font-weight: 700 !important; }
    .truck-card .info-row.info-arrive b { color: #f59e0b !important; }
    .truck-card .action-row {
      flex: 0 0 44px !important; height: 44px !important; margin: 0 !important;
      display: grid !important; grid-template-columns: auto 2fr 1fr !important;
      gap: 5px !important; align-items: stretch !important;
    }
    .truck-card .btn {
      min-height: 0 !important; height: 100% !important;
      padding: 4px 6px !important; font-size: 11px !important; font-weight: 700 !important;
      overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; line-height: 1.1 !important;
    }
    .truck-card .btn-arrive .idle-timer { font-size: 14px !important; }
    .truck-card .btn-arrive .idle-label { font-size: 8px !important; }
    .truck-card .btn-ttn { font-size: 10.5px !important; }
    .truck-card.anim-up { z-index: 100 !important; }
    .truck-card.anim-down { z-index: 1 !important; }
    .truck-card.anim-loading {
      z-index: 1 !important;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(34, 197, 94, 0.45) !important;
    }
    .truck-card.anim-front {
      z-index: 100 !important;
      box-shadow:
        0 16px 45px rgba(0, 0, 0, 0.7),
        0 0 0 2px var(--warning),
        0 0 20px rgba(245, 158, 11, 0.6) !important;
    }
    #trucksLineList { overflow: hidden !important; }

    @keyframes cardShake {
      0%, 100% { transform: translateX(0); }
      15% { transform: translateX(-6px); }
      30% { transform: translateX(6px); }
      45% { transform: translateX(-5px); }
      60% { transform: translateX(5px); }
      75% { transform: translateX(-3px); }
      90% { transform: translateX(3px); }
    }
    .truck-card.shaking {
      animation: cardShake var(--shake-dur, 0.35s) ease-in-out !important;
    }
    @keyframes dominoBump {
      0%   { transform: translateY(0); }
      30%  { transform: translateY(-3px); }
      60%  { transform: translateY(1.5px); }
      100% { transform: translateY(0); }
    }
    .truck-card.bumping {
      animation: dominoBump var(--bump-dur, 0.35s) ease-out !important;
    }
    @keyframes arriveFlyFront {
      0%   { transform: translateY(var(--from-y, 0px)) scale(1); }
      10%  { transform: translateY(calc(var(--from-y, 0px) * 0.9)) scale(1.03); }
      90%  { transform: translateY(0) scale(1.03); }
      100% { transform: translateY(0) scale(1); }
    }
    @keyframes gapFillFly {
      0%   { transform: translateY(var(--from-y, 0px)) scale(1); }
      15%  { transform: translateY(calc(var(--from-y, 0px) * 0.7)) scale(1.03); }
      85%  { transform: translateY(0) scale(1.03); }
      100% { transform: translateY(0) scale(1); }
    }

    /* ===== UI настроек ===== */
    .speed-slider-row { padding: 10px 0; border-bottom: 1px solid var(--border); }
    .speed-slider-row:last-of-type { border-bottom: none; }
    .speed-label-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .speed-label { font-size: 13px; font-weight: 600; }
    .speed-value { font-size: 13px; font-weight: 800; color: var(--primary); font-variant-numeric: tabular-nums; }
    .speed-slider { width: 100%; accent-color: var(--primary); height: 24px; }
    .speed-presets { display: flex; gap: 6px; margin-bottom: 12px; }
    .speed-preset-btn { flex: 1; padding: 8px 4px; font-size: 11px; font-weight: 700; border-radius: 8px; line-height: 1.3; }
  `;
    css.textContent += `
      .truck-card{height:auto!important;min-height:154px!important;max-height:none!important}
      .truck-card .truck-top{min-height:76px!important;flex:1 0 auto!important;align-items:center!important;gap:10px!important;overflow:visible!important}
      .truck-card .truck-identity{flex:0 0 148px!important;width:148px!important;overflow:visible!important}
      .truck-card .truck-brand{max-width:148px!important;line-height:1.25!important}
      .truck-card .truck-plate-wrap{width:max-content!important;max-width:100%!important;overflow:visible!important}
      .truck-card .truck-plate-wrap .ru-plate{flex-shrink:0!important;white-space:nowrap!important}
      .truck-card .truck-info{gap:5px!important;overflow:visible!important;align-self:stretch!important}
      .truck-card .truck-info .info-row{white-space:normal!important;overflow:visible!important;line-height:1.25!important;min-width:0!important}
      .truck-card .truck-info .info-trip{flex-wrap:wrap!important;font-size:11px!important;gap:3px!important}
      .truck-card .truck-info .info-load,.truck-card .truck-info .info-arrive{display:flex!important;flex-direction:column!important;align-items:flex-start!important;gap:1px!important;padding:4px 6px!important;border-radius:7px!important}
      .truck-card .truck-info .info-load{background:rgba(56,189,248,.08)!important}
      .truck-card .card-status-label{color:var(--muted)!important;font-size:10px!important;font-weight:500!important}
      .truck-card .load-age-card{font-size:12px!important;overflow-wrap:normal!important}
      .truck-card .truck-info .info-arrive{background:rgba(245,158,11,.08)!important;font-size:11px!important}
      .truck-card .card-arrival-author{font-size:10px!important;color:var(--muted)!important;max-width:100%!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;font-weight:500!important}
      @media(max-width:360px){
        .truck-card .truck-identity{flex-basis:132px!important;width:132px!important}
        .truck-card .truck-brand{max-width:132px!important}
        .truck-card .truck-top{gap:8px!important}
        .truck-card .truck-plate-wrap .ru-plate-main{font-size:18px!important;padding:0 4px!important}
        .truck-card .truck-plate-wrap .ru-plate-main .plate-letter{font-size:18px!important}
        .truck-card .truck-plate-wrap .ru-plate-main .plate-digit{font-size:19px!important;letter-spacing:1px!important}
        .truck-card .load-age-card{font-size:11px!important}
      }
    `;
  document.head.appendChild(css);

  // ===== Утилиты =====
  function parseCubicBezier(str) {
    const m = String(str).match(/cubic-bezier\(\s*([\d.\-]+)\s*,\s*([\d.\-]+)\s*,\s*([\d.\-]+)\s*,\s*([\d.\-]+)\s*\)/);
    if (!m) return [0.4, 0.0, 0.2, 1];
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
  }
  function cubicBezierProgress(t, p1x, p1y, p2x, p2y) {
    function A(a1, a2) { return 1 - 3 * a2 + 3 * a1; }
    function B(a1, a2) { return 3 * a2 - 6 * a1; }
    function C(a1) { return 3 * a1; }
    function calcBezier(t, a1, a2) { return ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t; }
    function getSlope(t, a1, a2) { return 3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1); }
    function getTForX(x) {
      let t = x;
      for (let i = 0; i < 8; i++) {
        const slope = getSlope(t, p1x, p2x);
        if (slope === 0) return t;
        const x2 = calcBezier(t, p1x, p2x) - x;
        t -= x2 / slope;
      }
      return t;
    }
    const tf = getTForX(t);
    return calcBezier(tf, p1y, p2y);
  }

  let activeScrollRaf = null;
  function startSyncScroll(targetDelta, durationSec, easingStr) {
    if (activeScrollRaf) { cancelAnimationFrame(activeScrollRaf); activeScrollRaf = null; }
    const startScroll = window.scrollY;
    const startTime = performance.now();
    const [p1x, p1y, p2x, p2y] = parseCubicBezier(easingStr);
    const durMs = durationSec * 1000;
    function tick() {
      const elapsed = performance.now() - startTime;
      const t = Math.min(1, elapsed / durMs);
      const eased = cubicBezierProgress(t, p1x, p1y, p2x, p2y);
      const next = startScroll + targetDelta * eased;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.max(0, Math.min(maxScroll, next)));
      if (t < 1) activeScrollRaf = requestAnimationFrame(tick);
      else activeScrollRaf = null;
    }
    activeScrollRaf = requestAnimationFrame(tick);
  }

  function formatReis(n) {
    if (n === 0) return 'Нет рейсов';
    const lastDigit = n % 10;
    const lastTwo = n % 100;
    let word = 'рейс';
    if (lastTwo < 11 || lastTwo > 14) {
      if (lastDigit === 1) word = 'рейс';
      else if (lastDigit >= 2 && lastDigit <= 4) word = 'рейса';
      else word = 'рейсов';
    } else word = 'рейсов';
    return n + '-й ' + word;
  }

  function shakeCard(id) {
    const card = document.querySelector(`.truck-card[data-truck-id="${id}"]`);
    if (!card) return Promise.resolve();
    const t = getTimings();
    return new Promise(resolve => {
      card.style.setProperty('--shake-dur', t.SHAKE + 's');
      card.classList.add('shaking');
      setTimeout(() => { card.classList.remove('shaking'); resolve(); }, t.SHAKE * 1000 + 10);
    });
  }

  // ===== Действия: намерение фиксируется до анимации, движение — после подтверждения =====
  const confirmed_toggleArrive=window.toggleArrive;
  window.toggleArrive=async function(id){
    if(!requireEdit('action_arrive')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=captureLineIntent(id);if(!intent)return {outcome:'ignored'};
    await shakeCard(id);
    return confirmed_toggleArrive.call(this,id,intent);
  };
  const confirmed_performLoad=window.performLoad;
  window.performLoad=async function(id){
    if(!requireEdit('action_load')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=captureLineIntent(id);if(!intent)return {outcome:'ignored'};
    await shakeCard(id);
    return confirmed_performLoad.call(this,id,intent);
  };
  const confirmed_toggleTtn=window.toggleTtn;
  window.toggleTtn=async function(id){
    if(!requireEdit('action_ttn')||lineActionInFlight[id])return {outcome:'ignored'};
    const intent=captureLineIntent(id);if(!intent)return {outcome:'ignored'};
    await shakeCard(id);
    return confirmed_toggleTtn.call(this,id,intent);
  };

  // ===== renderLine =====
  window.renderLine = function() {
    if (window.__lineAnimating) {
      window.__linePendingRender = true;
      return;
    }

    const T = getTimings();

    const sc = document.getElementById('startShiftContainer');
    const ac = document.getElementById('activeShiftContainer');
    const cb = document.getElementById('changeObjBtn');

    if (!state.shift) {
      sc.style.display = hasPermission('start_shift') ? 'block' : 'none';
      ac.style.display = 'none';
      cb.style.display = 'none';
      return;
    }
    sc.style.display = 'none';
    ac.style.display = 'block';
    cb.style.display = hasPermission('edit_line') ? 'inline-block' : 'none';

    const c = document.getElementById('trucksLineList');
    const oldP = {};
    c.querySelectorAll('.truck-card[data-truck-id]').forEach(x => {
      oldP[x.dataset.truckId] = x.offsetTop;
    });

    const ids = getActiveLineIds();
    if (!ids.length) {
      c.innerHTML = '<div class="form-card" style="text-align:center;color:var(--muted);">Нет машин</div>';
      return;
    }

    const logs = getLogs();
    const lastTs = {};
    logs.forEach(l => { if (lastTs[l.truckId] === undefined) lastTs[l.truckId] = l.timestamp || 0; });

    let trucks = ids.map(id => findTruck(id)).filter(Boolean);
    trucks.sort((a, b) => {
      const sA = state.truckStatus[a.id], sB = state.truckStatus[b.id];
      const aA = sA.arriveStatus ? 1 : 0, aB = sB.arriveStatus ? 1 : 0;
      if (aA !== aB) return aB - aA;
      const tA = sA.ttnStatus === true ? 1 : 0, tB = sB.ttnStatus === true ? 1 : 0;
      if (tA !== tB) return tA - tB;
      const lA = lastTs[a.id] || 0, lB = lastTs[b.id] || 0;
      if (lA === 0 && lB === 0) return 0;
      if (lA === 0) return -1;
      if (lB === 0) return 1;
      return lA - lB;
    });

    const now = Date.now();
    const cyc = (settings.cycleMinutes || 15) * 60000;
    const canEditArrive = hasPermission('action_arrive');
    const canEditLoad = hasPermission('action_load');
    const canEditTtn = hasPermission('action_ttn');
    const showStats = hasPermission('view_card_stats');

    c.innerHTML = trucks.map(t => {
      const st = state.truckStatus[t.id] || {};
      const tLogs = logs.filter(l => l.truckId === t.id);
      const sum = tLogs.reduce((s, l) => s + l.volume, 0);
      const isA = !!st.arriveStatus;
      const lastL = st.lastLoadTimestamp || 0;
      const inC = lastL > 0 && (now - lastL) < cyc;
      const ttn = st.ttnStatus;
      const faded = ttn === true && !isA;
      const lTs = Math.max(Number(lastL)||0,...tLogs.map(log=>Number(log.timestamp)||0));
      const isGAI = !!t.isGAI;
      const tripsCount = tLogs.length;

      let arrBtn;
      if (inC) {
        arrBtn = `<button class="btn btn-arrive" disabled><span style="display:flex;flex-direction:column;align-items:center;line-height:1.1;"><span class="idle-label">Ходка</span><span class="cooldown-timer" style="font-size:14px;" data-load-ts="${lastL}">${formatIdleDuration(cyc - (now - lastL))}</span></span></button>`;
      } else if (isA) {
        arrBtn = `<button class="btn btn-arrive active-arrive" ${canEditArrive ? `onpointerdown="startArriveHold(event, '${t.id}')" onpointerup="cancelHold(this)"` : ''} ${!canEditArrive ? 'disabled' : ''}><span style="display:flex;flex-direction:column;align-items:center;line-height:1.1;"><span class="idle-label">Простой</span><span class="idle-timer" data-since="${st.arriveTimestamp || now}">${formatIdleDuration(now - (st.arriveTimestamp || now))}</span></span></button>`;
      } else {
        arrBtn = `<button class="btn btn-arrive" ${canEditArrive ? `onpointerdown="startArriveHold(event, '${t.id}')" onpointerup="cancelHold(this)"` : ''} ${!canEditArrive ? 'disabled' : ''}>🚛 Приехал</button>`;
      }

      const ttnTxt = ttn ? '📄 ТТН ✓' : '📄 ТТН';
      const loadBtnTxt = '⚡ Погрузка';

      let infoHtml = '';
      if (showStats) {
        if (isGAI) infoHtml += `<div class="info-row info-trip"><b>${formatReis(tripsCount)}</b></div>`;
        else infoHtml += `<div class="info-row info-trip"><b>${formatReis(tripsCount)}</b> · <b>${sum} м³</b></div>`;
      }
      // Operational status is independent of the permission to see trip/volume totals.
      infoHtml += `<div class="info-row info-load"><span class="card-status-label">Загрузился</span><b class="load-age-card" data-timestamp="${lTs}">${formatLoadAge(lTs)}</b></div>`;
      if (isA) {
        const time = st.arriveStatus || '';
        const by = st.arriveBy || '';
        infoHtml += `<div class="info-row info-arrive"><span class="card-arrival-time">Прибыл <b>${escapeHtml(time)}</b></span>${by?`<span class="card-arrival-author" title="${escapeHtml(by)}">${escapeHtml(by)}</span>`:''}</div>`;
      }

      return `<div class="truck-card ${isA ? 'arrived' : ''} ${faded ? 'faded' : ''}" data-truck-id="${t.id}">
        <div class="truck-top">
          <div class="truck-identity">
            <div class="truck-brand">${escapeHtml(t.brand)}</div>
            <div class="truck-plate-wrap">${renderRussianPlate(t.number)}</div>
          </div>
          <div class="truck-info">${infoHtml}</div>
        </div>
        <div class="action-row">
          ${arrBtn}
          <button class="btn btn-quick" ${!canEditLoad || !isA ? 'disabled' : ''} ${canEditLoad && isA ? `onpointerdown="startQuickLoadHold(event, '${t.id}')" onpointerup="cancelHold(this)"` : ''}>${loadBtnTxt}</button>
          <button class="btn btn-ttn ${ttn ? 'active-ttn' : ''}" ${!canEditTtn ? 'disabled' : ''} ${canEditTtn ? `onpointerdown="startTtnHold(event, '${t.id}')" onpointerup="cancelHold(this)"` : ''}>${ttnTxt}</button>
        </div>
      </div>`;
    }).join('');

    // ===== АНИМАЦИЯ =====
    if (Object.keys(oldP).length) {
      const loadedInfo = window.__cardJustLoaded;
      const isFreshLoad = loadedInfo && (Date.now() - loadedInfo.time) < 5000;
      const loadedId = isFreshLoad ? loadedInfo.id : null;

      const arrivedInfo = window.__cardJustArrived;
      const isFreshArrival = arrivedInfo && (Date.now() - arrivedInfo.time) < 6000;
      const arrivedId = isFreshArrival ? arrivedInfo.id : null;
      const arrivedWasFaded = arrivedId ? arrivedInfo.wasFaded : false;

      const isLoadMode = !!loadedId && !arrivedId;

      const animList = [];
      c.querySelectorAll('.truck-card[data-truck-id]').forEach(card => {
        const oldTop = oldP[card.dataset.truckId];
        if (oldTop === undefined) return;
        const newTop = card.offsetTop;
        const delta = oldTop - newTop;
        const tid = card.dataset.truckId;
        if (Math.abs(delta) < 2) return;
        animList.push({
          card, delta, tid,
          isLoaded: (tid === loadedId) && delta < 0,
          isArrive: (tid === arrivedId) && delta > 0
        });
      });

      if (animList.length) {
        window.__lineAnimating = true;

        const allAfterRender = Array.from(c.querySelectorAll('.truck-card[data-truck-id]'));
        allAfterRender.sort((a, b) => a.offsetTop - b.offsetTop);
        const cardFinalIdx = {};
        allAfterRender.forEach((card, idx) => { cardFinalIdx[card.dataset.truckId] = idx; });

        let masterIdx = -1;
        let maxDelay = 0;
        if (!isLoadMode) {
          const masterId = arrivedId || loadedId;
          masterIdx = masterId != null ? cardFinalIdx[masterId] : -1;
          if (masterIdx >= 0) {
            animList.forEach(({ tid }) => {
              const idx = cardFinalIdx[tid];
              if (idx != null) {
                const d = Math.abs(idx - masterIdx) * T.WAVE_MS;
                if (d > maxDelay) maxDelay = d;
              }
            });
          }
        }

        // Автоскролл
        if (arrivedId) {
          const arrivedCardEl = c.querySelector(`.truck-card[data-truck-id="${arrivedId}"]`);
          if (arrivedCardEl) {
            const rect = arrivedCardEl.getBoundingClientRect();
            const cardAbsTop = rect.top + window.scrollY;
            const headerEl = document.getElementById('mainHeader');
            const headerH = headerEl ? headerEl.offsetHeight : 0;
            const desiredScroll = Math.max(0, cardAbsTop - headerH - 16);
            const scrollDelta = desiredScroll - window.scrollY;
            if (Math.abs(scrollDelta) > 2) startSyncScroll(scrollDelta, T.ARRIVE, ANIM_EASE);
          }
        }

        animList.forEach(({ card, delta, isLoaded, isArrive }) => {
          card.style.transition = 'none';
          card.style.transform = `translateY(${delta}px)`;
          if (isLoaded) {
            card.classList.add('anim-loading');
          } else if (isArrive) {
            card.classList.add('anim-front');
            if (arrivedWasFaded) {
              card.style.opacity = '0.35';
              card.style.filter = 'grayscale(50%)';
              card.style.backgroundColor = '#131b2e';
            }
          } else {
            card.classList.add(delta > 0 ? 'anim-up' : 'anim-down');
          }
        });

        void c.offsetWidth;

        let totalDur;

        if (isLoadMode) {
          totalDur = Math.max(T.LOAD_OUT, T.LOAD_FILL) * 1000 + 300;
          requestAnimationFrame(() => {
            animList.forEach(({ card, delta, isLoaded }) => {
              if (isLoaded) {
                card.style.transition = `transform ${T.LOAD_OUT}s ${ANIM_EASE}`;
                card.style.transform = 'translateY(0)';
              } else if (delta > 0) {
                card.style.setProperty('--from-y', `${delta}px`);
                card.style.transform = '';
                card.style.animation = `gapFillFly ${T.LOAD_FILL}s ${ANIM_EASE} forwards`;
              } else {
                card.style.transition = `transform ${T.LOAD_OUT}s ${ANIM_EASE}`;
                card.style.transform = 'translateY(0)';
              }
            });
          });
        } else {
          totalDur = T.ARRIVE * 1000 + maxDelay + 300;
          animList.forEach(({ card, delta, tid, isArrive }) => {
            const idx = cardFinalIdx[tid];
            let delay = 0;
            if (masterIdx >= 0 && idx != null) delay = Math.abs(idx - masterIdx) * T.WAVE_MS;

            setTimeout(() => {
              if (isArrive) {
                card.style.setProperty('--from-y', `${delta}px`);
                card.style.transform = '';
                card.style.animation = `arriveFlyFront ${T.ARRIVE}s ${ANIM_EASE} forwards`;
                const props = [];
                if (arrivedWasFaded) {
                  props.push(`opacity ${T.ARRIVE}s ease-in-out`);
                  props.push(`filter ${T.ARRIVE}s ease-in-out`);
                  props.push(`background-color ${T.ARRIVE}s ease-in-out`);
                }
                if (props.length) card.style.transition = props.join(', ');
                if (arrivedWasFaded) {
                  card.style.opacity = '1';
                  card.style.filter = 'grayscale(0%)';
                  card.style.backgroundColor = '#1e293b';
                }
              } else {
                card.style.transition = `transform ${T.ARRIVE}s ${ANIM_EASE}`;
                card.style.transform = 'translateY(0)';
              }
            }, delay);
          });
        }

        setTimeout(() => {
          animList.forEach(({ card }) => {
            card.style.transition = '';
            card.style.transform = '';
            card.style.animation = '';
            card.style.opacity = '';
            card.style.filter = '';
            card.style.backgroundColor = '';
            card.classList.remove('anim-up', 'anim-down', 'anim-loading', 'anim-front');
          });

          const freshCards = Array.from(c.querySelectorAll('.truck-card[data-truck-id]'));
          freshCards.sort((a, b) => a.offsetTop - b.offsetTop);
          const arrivedIdx2 = arrivedId ? freshCards.findIndex(cd => cd.dataset.truckId === arrivedId) : -1;

          freshCards.forEach((card, idx) => {
            let delay = 0;
            if (!isLoadMode && arrivedIdx2 >= 0) delay = Math.abs(idx - arrivedIdx2) * 40;
            setTimeout(() => {
              card.style.setProperty('--bump-dur', T.BUMP + 's');
              card.classList.add('bumping');
              setTimeout(() => card.classList.remove('bumping'), T.BUMP * 1000 + 50);
            }, delay);
          });

          if (!isLoadMode && arrivedIdx2 > 0) {
            setTimeout(() => {
              const fcs = Array.from(c.querySelectorAll('.truck-card[data-truck-id]'));
              fcs.sort((a, b) => a.offsetTop - b.offsetTop);
              const firstCard = fcs[0];
              if (!firstCard) return;
              const firstRect = firstCard.getBoundingClientRect();
              const headerEl = document.getElementById('mainHeader');
              const headerBottom = headerEl ? headerEl.getBoundingClientRect().bottom : 0;
              const delta = firstRect.top - (headerBottom + 12);
              if (delta < -4) {
                const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
                const targetScroll = Math.max(0, Math.min(maxScroll, window.scrollY + delta));
                const actualDelta = targetScroll - window.scrollY;
                if (Math.abs(actualDelta) > 2) startSyncScroll(actualDelta, T.SETTLE, ANIM_EASE);
              }
            }, T.SETTLE_DELAY_MS);
          }

          window.__lineAnimating = false;
          window.__cardJustLoaded = null;
          window.__cardJustArrived = null;
          if (window.__linePendingRender) {
            window.__linePendingRender = false;
            window.renderLine();
          }
        }, totalDur);
      }
    }
  };

  // ===== UI в настройках =====
  function renderSpeedSettings() {
    const modalBody = document.querySelector('#settingsModal .modal-body');
    if (!modalBody) return;
    if (document.getElementById('speed-settings-block')) return;

    const block = document.createElement('div');
    block.id = 'speed-settings-block';
    block.style.cssText = 'margin-top: 20px; border-top: 2px solid var(--border); padding-top: 16px;';

    block.innerHTML = `
      <div class="settings-label" style="margin-bottom: 12px;">🎬 Скорости анимаций</div>
      <div class="speed-presets">
        <button class="btn btn-secondary speed-preset-btn" data-preset="slow">🐢<br>Медленно</button>
        <button class="btn btn-quick speed-preset-btn" data-preset="normal">🚀<br>Обычно</button>
        <button class="btn btn-secondary speed-preset-btn" data-preset="fast">⚡<br>Быстро</button>
      </div>

      <div class="speed-slider-row">
        <div class="speed-label-row">
          <span class="speed-label">Общая скорость</span>
          <span class="speed-value" id="sv-overall">1.0×</span>
        </div>
        <input type="range" min="0.3" max="2.5" step="0.1" class="speed-slider" id="sl-overall">
      </div>

      <div class="speed-slider-row">
        <div class="speed-label-row">
          <span class="speed-label">Заполнение пустоты (погрузка)</span>
          <span class="speed-value" id="sv-fill">1.0×</span>
        </div>
        <input type="range" min="0.3" max="2.5" step="0.1" class="speed-slider" id="sl-fill">
      </div>

      <div class="speed-slider-row">
        <div class="speed-label-row">
          <span class="speed-label">Дрожание перед действием</span>
          <span class="speed-value" id="sv-shake">1.0×</span>
        </div>
        <input type="range" min="0.3" max="2.5" step="0.1" class="speed-slider" id="sl-shake">
      </div>

      <div class="speed-slider-row">
        <div class="speed-label-row">
          <span class="speed-label">Волна домино (приехал)</span>
          <span class="speed-value" id="sv-wave">1.0×</span>
        </div>
        <input type="range" min="0.3" max="2.5" step="0.1" class="speed-slider" id="sl-wave">
      </div>

      <button class="btn btn-secondary btn-small" style="width: 100%; margin-top: 12px;" id="speed-reset">↺ Сбросить по умолчанию</button>
    `;

    modalBody.appendChild(block);

    const setVal = (key, val) => {
      const sl = document.getElementById('sl-' + key);
      const sv = document.getElementById('sv-' + key);
      if (sl) sl.value = val;
      if (sv) sv.textContent = val.toFixed(1) + '×';
    };

    const init = loadSpeeds();
    setVal('overall', init.overall);
    setVal('fill', init.fill);
    setVal('shake', init.shake);
    setVal('wave', init.wave);

    ['overall', 'fill', 'shake', 'wave'].forEach(key => {
      const sl = document.getElementById('sl-' + key);
      if (!sl) return;
      sl.addEventListener('input', () => {
        const v = parseFloat(sl.value);
        const cur = loadSpeeds();
        cur[key] = v;
        saveSpeeds(cur);
        document.getElementById('sv-' + key).textContent = v.toFixed(1) + '×';
      });
    });

    block.querySelectorAll('.speed-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.preset;
        let v = 1;
        if (p === 'slow') v = 1.6;
        else if (p === 'fast') v = 0.7;
        saveSpeeds({ overall: v, fill: v, shake: v, wave: v });
        ['overall', 'fill', 'shake', 'wave'].forEach(k => setVal(k, v));
        if (window.showToastEl) window.showToastEl('✅ Пресет применён', false);
      });
    });

    const resetBtn = document.getElementById('speed-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        saveSpeeds({ ...DEFAULTS });
        ['overall', 'fill', 'shake', 'wave'].forEach(k => setVal(k, 1));
        if (window.showToastEl) window.showToastEl('↺ Сброшено', false);
      });
    }
  }

  const origOpenSettings = window.openSettingsModal;
  window.openSettingsModal = function() {
    if (origOpenSettings) origOpenSettings();
    setTimeout(renderSpeedSettings, 60);
  };
})();; }
catch (e) { console.error('[baked patch: Настройка скорости анимации]', e); }
try { (function(){
  if (window.__maxRetryV1) return;
  window.__maxRetryV1 = true;

  const REQUEST_TIMEOUT_MS = 60000;
  const WARMUP_TIMEOUT_MS = 90000;
  const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
  const LAST_SUCCESS_KEY = 'dt_max_last_success';
  const LAST_WARMUP_KEY = 'dt_max_last_warmup';
  const CONFIG_CACHE_MS = 30000;

  let cachedConfig = null;
  let cachedConfigAt = 0;
  let warmupInFlight = null;

  function getTs(key) {
    try { return parseInt(localStorage.getItem(key) || '0') || 0; } catch(e) { return 0; }
  }
  function setTs(key, v) {
    try { localStorage.setItem(key, String(v || Date.now())); } catch(e) {}
  }

  async function getConfig() {
    const now = Date.now();
    if (cachedConfig && (now - cachedConfigAt) < CONFIG_CACHE_MS) {
      return cachedConfig;
    }
    try {
      const doc = await firebase.firestore().collection('settings').doc('appConfig').get();
      if (doc.exists) {
        cachedConfig = doc.data();
        cachedConfigAt = now;
        return cachedConfig;
      }
    } catch(e) {
      console.warn('[MAX] Config read failed:', e.message);
    }
    return cachedConfig || {};
  }

  async function warmUpServer(url) {
    if (warmupInFlight) return warmupInFlight;
    if (!url) return false;

    warmupInFlight = (async () => {
      console.log('[MAX] 🔥 Warm-up: бужу сервер...');
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), WARMUP_TIMEOUT_MS);
        await fetch(url, {
          method: 'GET',
          signal: ctrl.signal,
          cache: 'no-store',
          keepalive: true
        });
        clearTimeout(timer);
        console.log('[MAX] ✅ Warm-up: сервер проснулся');
        setTs(LAST_WARMUP_KEY, Date.now());
        return true;
      } catch(e) {
        console.warn('[MAX] ❌ Warm-up failed:', e.name || e.message);
        return false;
      } finally {
        warmupInFlight = null;
      }
    })();

    return warmupInFlight;
  }

  window.sendMaxOnce = async function(item) {
    const cfg = await getConfig();
    if (!cfg.maxEnabled || !cfg.maxUrl) return 'drop';

    const url = cfg.maxUrl;
    const token = cfg.maxToken || '';
    const chatId = cfg.maxChatId || '';

    const lastSuccess = getTs(LAST_SUCCESS_KEY);
    const lastWarmup = getTs(LAST_WARMUP_KEY);
    const idle = Date.now() - lastSuccess;
    const sinceWarmup = Date.now() - lastWarmup;

    if (idle > IDLE_THRESHOLD_MS && sinceWarmup > 60000) {
      console.log(`[MAX] ⏰ Idle ${Math.round(idle/1000)}s — warm-up перед отправкой`);
      const ok = await warmUpServer(url);
      if (!ok) {
        console.warn('[MAX] Warm-up неудачен — retry');
        return 'retry';
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      const tk = String(token).trim();
      headers['Authorization'] = tk.startsWith('Bearer ') ? tk : 'Bearer ' + tk;
    }

    const body = item.type === 'document'
      ? { chat_id: chatId, text: item.caption || '', document: { filename: item.filename, content_base64: item.base64 } }
      : { chat_id: chatId, text: item.text };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    try {
      console.log(`[MAX] 📤 Отправка (попытка ${(item.tries || 0) + 1})...`);
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
        keepalive: true
      });
      clearTimeout(timer);

      if (resp.ok) {
        setTs(LAST_SUCCESS_KEY, Date.now());
        console.log('[MAX] ✅ Отправлено');
        return 'ok';
      }
      if (resp.status === 413) return 'too_large';
      if (resp.status === 429) return 'retry';
      if (resp.status >= 500) {
        console.warn(`[MAX] ⚠️ Server ${resp.status} — retry`);
        return 'retry';
      }
      if (resp.status === 401 || resp.status === 403) return 'auth';
      return 'http_' + resp.status;
    } catch(e) {
      clearTimeout(timer);
      console.warn(`[MAX] ⚠️ ${e.name || e.message} — retry`);
      return 'retry';
    }
  };

  console.log('[MAX] 🔄 Патч ретраев активен. POST: ' + (REQUEST_TIMEOUT_MS/1000) + 's, warm-up: ' + (WARMUP_TIMEOUT_MS/1000) + 's, idle порог: ' + (IDLE_THRESHOLD_MS/60000) + ' мин');
})();; }
catch (e) { console.error('[baked patch: Макс отправка]', e); }
try { (function(){
  if (window.__adminCompactV2) return;
  window.__adminCompactV2=true;
  const css=document.createElement('style');css.id='admin-compact-css';
  css.textContent=`body.admin-active-page #statusTicker,body.admin-active-page #headerExtraContent{display:none!important}.admin-tabs{display:grid!important;grid-template-columns:repeat(4,1fr)!important;gap:4px!important;overflow:visible!important;padding:0!important;margin-bottom:12px!important}.admin-tab-btn{padding:6px 3px!important;font-size:9.5px!important;min-height:34px!important;border-radius:6px!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}body.admin-active-page .container{padding-top:10px!important}`;
  document.head.append(css);
  function update(){const tab=document.getElementById('tab-admin');document.body.classList.toggle('admin-active-page',!!tab?.classList.contains('active'));}
  const tab=document.getElementById('tab-admin');if(tab)new MutationObserver(update).observe(tab,{attributes:true,attributeFilter:['class']});update();
})();; }
catch (e) { console.error('[baked patch: Компактная админка]', e); }
