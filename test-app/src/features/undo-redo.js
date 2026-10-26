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
  function historyTouchesFrozenShift(op,current,shift){
    if(!shift||(!shift.closing&&!shift.restoring))return false;
    if(op.collection==='shift')return true;
    const records=[op.before,op.after,current].filter(Boolean);
    if(op.collection==='logs'||op.collection==='truckStatus')return records.some(record=>record.shiftId===shift.id);
    if(op.collection==='archive')return op.id===shift.restoredFrom
      || op.id===(shift.closeArchiveId||('closed_'+shift.id))
      || records.some(record=>record.sourceShiftId===shift.id);
    return false;
  }
  async function applyHistoryOperations(operations,direction,action){
    return window.__historyRawTransaction(async tx=>{
      if(!allowedHistory(direction,action))throw new Error('Нет права на это действие в журнале');
      const historyRef=refs.audit.doc(action.id),historyDoc=await tx.get(historyRef);
      if(!historyDoc.exists||!historyDoc.data().history)throw new Error('Запись истории отсутствует на сервере');
      const canonical=historyDoc.data().history;
      if(!allowedHistory(direction,canonical))throw new Error('Нет права на это действие в журнале');
      if(!sameHistoryValue(canonical.operations,operations))throw new Error('История обновилась. Откройте журнал заново.');
      if(historyDoc.exists&&historyDoc.data().history?.undone!==(direction==='after'))throw new Error('Это действие уже изменено другим пользователем. Обновите журнал.');
      // Reading the shift also makes a concurrent freeze invalidate this transaction.
      const shiftDoc=operations.some(op=>['shift','logs','truckStatus','archive'].includes(op.collection))?await tx.get(refs.shift):null;
      const shift=shiftDoc?.exists?shiftDoc.data():null;
      const entries=[];
      for(const op of operations){
        const collection=['users','settings','registration_requests'].includes(op.collection)?db.collection(op.collection):refs[op.collection];
        if(!collection)throw new Error('Неизвестный тип записи: '+op.collection);
        const ref=op.collection==='shift'?refs.shift:collection.doc(op.id),snapshot=await tx.get(ref);
        const expected=op[direction==='before'?'after':'before'];
        let current=snapshot.exists?snapshot.data():null;
        if(historyTouchesFrozenShift(op,current,shift))throw new Error('Смена закрывается или восстанавливается. Сначала завершите эту операцию; отмена и восстановление её данных временно недоступны.');
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
