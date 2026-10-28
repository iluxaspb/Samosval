/* One paper viewer. Summary is the approved visual benchmark; archive captures a
 * selected record once and uses the same paper markup, scale and hold control. */
(function () {
  if (window.__paperSheetViewerInstalled) return;
  window.__paperSheetViewerInstalled = true;
  const tab = document.getElementById('tab-report');
  const host = document.getElementById('archiveModal');
  let viewer = null, archiveSnapshot = null, disposeArchiveHold = null;
  const esc = value => escapeHtml(value);
  const allowed = kind => hasTabAccess(kind === 'archive' ? 'archive' : 'report');
  const gaiAllowed = kind => allowed(kind) && hasPermission('view_gai_report');
  const style = document.createElement('style');
  style.id = 'shared-paper-viewer-style';
  style.textContent = `
    body.summary-viewer-on #tab-report > .action-row {display:none!important}
    body.summary-viewer-on #pluginPdfButtonsContainer {display:none!important}
    body.summary-viewer-on #tab-report .stylus-canvas {display:none!important}
    #summary-open-sheet {width:100%;margin-bottom:12px}
    body:not(.summary-viewer-on) #summary-open-sheet {display:none}
    body.summary-viewer-on #tab-report .paper-scroll-wrapper,
    #archive-paper-wrapper .paper-scroll-wrapper {cursor:zoom-in}
    .archive-view-switch {display:flex;justify-content:flex-end;margin:-8px 0 0}
    .archive-toggle-icon {display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:0;border-radius:0;background:none;box-shadow:none;color:inherit;font-size:20px;cursor:pointer;-webkit-tap-highlight-color:transparent}
    .paper-sheet-dialog {position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;border:0;padding:0;background:#0f172a;color:#f8fafc;overscroll-behavior:none}
    .paper-sheet-dialog::backdrop {background:#0f172a}
    .paper-sheet-dialog[open] {display:flex;flex-direction:column}
    .sheet-tools {display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px;padding-top:max(12px,env(safe-area-inset-top));border-bottom:1px solid #334155}
    .sheet-tools button {min-width:44px;min-height:44px;border:1px solid #475569;border-radius:8px;background:#1e293b;color:white;padding:8px;cursor:pointer}
    .sheet-stage {position:relative;flex:1;min-height:0;overflow:hidden;touch-action:none;user-select:none;cursor:grab}
    .sheet-stage:active {cursor:grabbing}
    .sheet-page {position:absolute;left:0;top:0;transform-origin:0 0;background:white;width:max-content}
    .paper-sheet-dialog .paper-report-container {zoom:1!important;transition:none!important;width:max-content;min-width:780px}
    .paper-sheet-dialog canvas {display:none!important}
    .sheet-hint {font-size:12px;color:#94a3b8;padding:8px;text-align:center;padding-bottom:max(8px,env(safe-area-inset-bottom))}
  `;
  document.head.append(style);
  document.body.classList.add('summary-viewer-on');

  // Same cancellation rules as the benchmark Summary button. This binds only
  // archive's newly created button; summary-hold.js owns the original control.
  function bindHold(button, callback, canRun) {
    button.title = 'Удерживайте 0,8 с для переключения листа';
    button.setAttribute('aria-label', button.title);
    button.style.touchAction = 'none';
    button.style.userSelect = button.style.webkitUserSelect = 'none';
    button.style.webkitTouchCallout = 'none';
    let timer = null, pointer = null, startX = 0, startY = 0, heldKey = null;
    const listeners = [];
    function listen(node, event, fn, options) {
      node.addEventListener(event, fn, options);
      listeners.push(() => node.removeEventListener(event, fn, options));
    }
    function cancel() { clearTimeout(timer); timer = null; pointer = null; heldKey = null; }
    function start() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!document.hidden && button.isConnected && button.getClientRects().length && canRun()) callback();
      }, 800);
    }
    listen(button, 'click', e => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
    listen(button, 'contextmenu', e => e.preventDefault());
    listen(button, 'pointerdown', e => {
      if (!e.isPrimary || e.button !== 0) { cancel(); return; }
      cancel(); pointer = e.pointerId; startX = e.clientX; startY = e.clientY;
      button.setPointerCapture(e.pointerId); start();
    });
    listen(button, 'pointermove', e => {
      if (e.pointerId !== pointer) return;
      const r = button.getBoundingClientRect();
      if (Math.hypot(e.clientX-startX, e.clientY-startY)>12 ||
          e.clientX<r.left || e.clientX>r.right || e.clientY<r.top || e.clientY>r.bottom) cancel();
    });
    ['pointerup','pointercancel','pointerleave','lostpointercapture','blur','keyup'].forEach(type => listen(button, type, cancel));
    listen(button, 'keydown', e => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      if (e.repeat || heldKey) return;
      heldKey = e.key; start();
    });
    listen(window, 'blur', cancel);
    listen(document, 'visibilitychange', cancel);
    listen(document, 'scroll', cancel, true);
    return () => { cancel(); listeners.forEach(remove => remove()); };
  }

  function clonePaper(source) {
    const clone = source.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    clone.querySelectorAll('canvas').forEach(node => node.remove());
    clone.classList.remove('compact');
    clone.style.zoom = '1';
    clone.style.transform = 'none';
    clone.style.transition = 'none';
    return clone;
  }
  function closeViewer() { viewer?.close(); }
  function openViewer(source, kind) {
    if (!source || !allowed(kind) || viewer) return;
    // Clone before showing the dialog. No observers copy later/live report data.
    const frozenPaper = clonePaper(source);
    const opener = document.activeElement, oldOverflow = document.body.style.overflow;
    const dialog = document.createElement('dialog');
    dialog.id = kind === 'archive' ? 'archive-sheet-dialog' : 'summary-sheet-dialog';
    dialog.className = 'paper-sheet-dialog';
    dialog.setAttribute('aria-label', 'Просмотр сводки');
    dialog.innerHTML = '<div class="sheet-tools"><strong style="flex:1">Сводка</strong><button type="button" data-action="out" aria-label="Уменьшить">−</button><span class="sheet-scale" aria-live="polite"></span><button type="button" data-action="in" aria-label="Увеличить">+</button><button type="button" data-action="fit">Лист целиком</button><button type="button" data-action="close" aria-label="Закрыть просмотр">✕</button></div><div class="sheet-stage"><div class="sheet-page"></div></div><div class="sheet-hint">Двигайте лист пальцем · Масштаб — двумя пальцами · Двойное нажатие — лист целиком</div>';
    const stage = dialog.querySelector('.sheet-stage'), page = dialog.querySelector('.sheet-page'), scaleLabel = dialog.querySelector('.sheet-scale');
    page.append(frozenPaper);
    let x = 0, y = 0, scale = 1, min = .02, fitted = true, closed = false;
    const points = new Map();
    function close() {
      if (closed) return;
      closed = true;
      resize.disconnect(); hostObserver?.disconnect();
      points.clear();
      if (dialog.open) dialog.close();
      dialog.remove();
      if (viewer?.dialog === dialog) viewer = null;
      document.body.style.overflow = oldOverflow;
      if (opener?.isConnected) opener.focus();
    }
    function paint() {
      if (closed || !page.offsetWidth || !page.offsetHeight) return;
      const w = page.offsetWidth*scale, h = page.offsetHeight*scale;
      x = w<=stage.clientWidth ? (stage.clientWidth-w)/2 : Math.min(0,Math.max(stage.clientWidth-w,x));
      y = h<=stage.clientHeight ? (stage.clientHeight-h)/2 : Math.min(0,Math.max(stage.clientHeight-h,y));
      page.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
      scaleLabel.textContent = Math.round(scale*100)+'%';
    }
    function fit() {
      if (closed || !page.offsetWidth || !page.offsetHeight) return;
      min = Math.max(.02,Math.min(1,(stage.clientWidth-24)/page.offsetWidth,(stage.clientHeight-24)/page.offsetHeight));
      scale = min; x = y = 0; fitted = true; paint();
    }
    function zoom(next, cx=stage.clientWidth/2, cy=stage.clientHeight/2) {
      next = Math.min(4,Math.max(min,next));
      x = cx-(cx-x)*next/scale; y = cy-(cy-y)*next/scale;
      scale = next; fitted = false; paint();
    }
    const resize = new ResizeObserver(() => fitted ? fit() : paint());
    const hostObserver = kind === 'archive' && host ? new MutationObserver(() => {
      if (!host.classList.contains('open')) close();
    }) : null;
    viewer = {kind, dialog, close};
    document.body.style.overflow = 'hidden';
    document.body.append(dialog); dialog.showModal(); fit(); resize.observe(stage);
    hostObserver?.observe(host, {attributes:true,attributeFilter:['class']});
    dialog.addEventListener('close', close);
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dialog.querySelector('.sheet-tools').addEventListener('click', e => {
      const action = e.target.closest('button')?.dataset.action;
      if (action === 'close') close();
      if (action === 'fit') fit();
      if (action === 'in') zoom(scale*1.3);
      if (action === 'out') zoom(scale/1.3);
    });
    let last = null, lastTap = 0, tapStart = null, gestureMoved = false;
    function geometry() {
      const p = [...points.values()];
      return p.length ? {x:p.reduce((s,v)=>s+v.x,0)/p.length,y:p.reduce((s,v)=>s+v.y,0)/p.length,d:p.length>1?Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y):0} : null;
    }
    stage.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const r = stage.getBoundingClientRect();
      points.set(e.pointerId,{x:e.clientX-r.left,y:e.clientY-r.top});
      if (points.size === 1) { tapStart={x:e.clientX,y:e.clientY}; gestureMoved=false; }
      else gestureMoved = true;
      stage.setPointerCapture(e.pointerId); last=geometry();
    });
    stage.addEventListener('pointermove', e => {
      if (!points.has(e.pointerId)) return;
      if (tapStart && Math.hypot(e.clientX-tapStart.x,e.clientY-tapStart.y)>8) gestureMoved=true;
      const r=stage.getBoundingClientRect();
      points.set(e.pointerId,{x:e.clientX-r.left,y:e.clientY-r.top});
      const g=geometry();
      if(last){x+=g.x-last.x;y+=g.y-last.y;if(g.d&&last.d)zoom(scale*g.d/last.d,g.x,g.y);else paint();}
      last=g;
    });
    function release(e) {
      if (!points.has(e.pointerId)) return;
      if(e.type==='pointerup' && points.size===1 && !gestureMoved) {
        if(Date.now()-lastTap<300) {fit();lastTap=0;} else lastTap=Date.now();
      } else lastTap=0;
      points.delete(e.pointerId); last=geometry();
    }
    ['pointerup','pointercancel','lostpointercapture'].forEach(type=>stage.addEventListener(type,release));
    stage.addEventListener('wheel',e=>{e.preventDefault();const r=stage.getBoundingClientRect();zoom(scale*Math.exp(-e.deltaY*.002),e.clientX-r.left,e.clientY-r.top);},{passive:false});
    if(document.fonts) document.fonts.ready.then(()=>{if(!closed)fitted?fit():paint();});
  }
  tab?.addEventListener('click', e => {
    if (!e.target.closest('.paper-scroll-wrapper') || !allowed('report')) return;
    const gai = document.getElementById('gaiReportWrapper')?.style.display !== 'none';
    if (gai && !gaiAllowed('report')) return;
    e.preventDefault();
    openViewer(document.getElementById(gai ? 'gaiPaperContainer' : 'paperReportContainer'), 'report');
  }, true);

  // Archive uses only its own logs/TTN. Directory labels are copied synchronously
  // on date-open; no later GAI toggle, zoom or PNG reads a live directory/status.
  function captureArchive(record) {
    const logs = (record.logs || []).map(log => ({...log, author:resolveUserDisplayName(log.createdByEmail,log.createdBy)}));
    const activeIds = [...(record.activeLineIds || [])], ttn = {...(record.ttnStatus || {})};
    const trucks = new Map();
    new Set([...activeIds,...logs.map(log=>log.truckId)]).forEach(id => {
      const truck=findTruck(id), ref=logs.find(log=>log.truckId===id);
      if(!truck && !ref)return;
      const savedName=String(ref?.truckName||'').trim();
      // Closed records contain a saved truck label, not a live directory link.
      // Split only the recognizable Russian plate suffix; never invent a plate.
      const plate=savedName.match(/^(.*?)\s+([а-яёa-z]\s*\d{3}\s*[а-яёa-z]{2}\s*\d{2,3})$/iu);
      trucks.set(id, savedName ? {id,brand:plate?plate[1]:savedName,number:plate?plate[2]:'',isGAI:!!ref.isGAI}
        : truck ? {...truck} : {id,brand:'Машина',number:'',isGAI:!!ref?.isGAI});
    });
    const snapshot = {id:record.id,objectName:record.objectName||'—',date:record.date||'',logs,activeIds,ttn,trucks};
    return Object.freeze({id:snapshot.id,objectName:snapshot.objectName,date:snapshot.date,
      regular:renderArchiveSheet(snapshot,false),gai:renderArchiveSheet(snapshot,true)});
  }
  function renderArchiveSheet(snapshot, gai) {
    const logs=snapshot.logs.filter(log=>!!log.isGAI===gai);
    // A closed shift keeps Firestore's arbitrary log order. Rebuild the same
    // chronological trip columns as Summary, irrespective of storage order.
    const orderedLogs=logs.slice().sort((a,b)=>(Number(a.timestamp)||0)-(Number(b.timestamp)||0) ||
      String(a.id||'').localeCompare(String(b.id||'')));
    const active=snapshot.activeIds.filter(id=>snapshot.trucks.has(id) && !!snapshot.trucks.get(id).isGAI===gai);
    const ids=[...new Set([...active,...orderedLogs.map(log=>log.truckId)])];
    const first={}; orderedLogs.forEach(log=>{if(first[log.truckId]===undefined)first[log.truckId]=Number(log.timestamp)||0;});
    // Summary benchmark: earliest first load leads; trucks with no trips last.
    ids.sort((a,b)=>((first[a]===undefined)-(first[b]===undefined)) ||
      ((first[a]||0)-(first[b]||0)) || String(a).localeCompare(String(b)));
    const max=Math.max(8,...ids.map(id=>logs.filter(log=>log.truckId===id).length));
    let head='<th>№</th><th style="text-align:left;">Самосвал</th>';
    for(let i=1;i<=max;i++)head+=`<th>Рейс ${i}</th>`;
    const rows=ids.map((id,index)=>{
      const truck=snapshot.trucks.get(id), trips=orderedLogs.filter(log=>log.truckId===id), ttn=snapshot.ttn[id];
      const duplicate=(typeof window.__closedShiftDupEnabled==='function' && window.__closedShiftDupEnabled()) ? (trips.length>0 && ttn!==true && ttn!=='pending') : (trips.length>0 && !ttn);
      const dup=duplicate?' <span style="color:red; font-weight:900; font-size:12px; margin-left:4px;" title="Дубликат" aria-label="Дубликат">D</span>':'';
      let cells='';
      for(let i=0;i<max;i++) {
        const log=trips[i];
        if(log) {
          const circle=!gai && ttn && i===trips.length-1?'<div class="hand-drawn-circle"></div>':'';
          const comment=log.comment?`<div style="font-size:10px; color:#c2410c; margin-top:2px; font-family:sans-serif; line-height:1.1;">${esc(log.comment)}</div>`:'';
          cells+=`<td><div class="cell-content">${circle}<div class="paper-time">${esc(log.timeStr)} </div><div class="paper-trip-num">${i+1}</div><div class="paper-author">${esc(log.author)}</div>${comment}</div></td>`;
        } else if(!gai && i===trips.length && ttn==='pending')cells+='<td><div class="cell-content"><div class="hand-drawn-circle"></div></div></td>';
        else cells+='<td></td>';
      }
      const volume=gai?'Рейсов: '+trips.length:trips.reduce((sum,log)=>sum+log.volume,0)+' м³';
      return `<tr><td style="font-weight:bold;">${index+1}</td><td class="truck-cell"><div class="paper-truck-brand">${esc(truck.brand)} <span class="paper-truck-volume">${volume}</span>${dup}</div>${truck.number?renderRussianPlate(truck.number):''}</td>${cells}</tr>`;
    }).join('');
    const total=gai?'Всего рейсов ГАИ: <b>'+logs.length+'</b>':'Общий объем: <b>'+logs.reduce((sum,log)=>sum+log.volume,0)+' м³</b>';
    return `<div class="paper-report-container compact"><div class="paper-header"><div class="paper-object-name">Объект: ${esc(snapshot.objectName)}</div><div class="paper-date-vol-row"><div class="paper-report-title">${esc(snapshot.date)}</div><div class="paper-total-info">${total}</div></div></div><table class="paper-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  if (host) {
    const legacyClose = window.closeArchiveModal;
    function renderFrozenArchive() {
      if (!archiveSnapshot || !allowed('archive')) return;
      if (!gaiAllowed('archive')) viewingArchiveGAITable=false;
      document.getElementById('modalArchiveTitle').textContent=archiveSnapshot.date;
      document.getElementById('archiveRestoreBtn').style.display=hasPermission('archive_edit')?'':'none';
      document.getElementById('archiveDeleteBtn').style.display=hasPermission('archive_delete')?'':'none';
      disposeArchiveHold?.(); disposeArchiveHold=null;
      const body=document.getElementById('modalArchiveBody');
      body.innerHTML='<div id="archive-paper-wrapper"><div class="paper-scroll-wrapper">'+archiveSnapshot[viewingArchiveGAITable?'gai':'regular']+'</div></div>'+
        (gaiAllowed('archive')?'<div class="archive-view-switch"><button type="button" class="archive-toggle-icon">📄</button></div>':'');
      const button=body.querySelector('.archive-toggle-icon');
      if(button) {
        button.setAttribute('aria-pressed',String(viewingArchiveGAITable));
        disposeArchiveHold=bindHold(button,()=>window.toggleArchiveReportType(),()=>host.classList.contains('open')&&!!archiveSnapshot&&gaiAllowed('archive'));
      }
    }
    window.openArchiveModal=function(id) {
      if(!allowed('archive'))return;
      const record=state.archive.find(item=>item.id===id);
      if(!record)return;
      // Realtime list refresh calls this same entry point. Do not silently replace
      // the selected frozen record or reset its current regular/GAI choice.
      if(!archiveSnapshot || archiveSnapshot.id!==id || !host.classList.contains('open')) {
        if(viewer?.kind==='archive')closeViewer();
        archiveSnapshot=captureArchive(record); viewingArchiveGAITable=false;
      }
      viewingArchiveId=id; renderFrozenArchive(); host.classList.add('open');
    };
    window.renderArchiveModalContent=function(record) {
      if(!allowed('archive') || !record)return;
      if(!archiveSnapshot || archiveSnapshot.id!==record.id)archiveSnapshot=captureArchive(record);
      renderFrozenArchive();
    };
    window.toggleArchiveReportType=function() {
      if(!archiveSnapshot || !gaiAllowed('archive') || !host.classList.contains('open'))return;
      viewingArchiveGAITable=!viewingArchiveGAITable; renderFrozenArchive();
    };
    window.closeArchiveModal=function() {
      if(viewer?.kind==='archive')closeViewer();
      disposeArchiveHold?.(); disposeArchiveHold=null; archiveSnapshot=null;
      if(typeof legacyClose==='function')legacyClose();
      else {host.classList.remove('open');viewingArchiveId=null;}
    };
    host.addEventListener('click',e=>{
      if(!e.target.closest('#archive-paper-wrapper .paper-report-container'))return;
      if(viewingArchiveGAITable&&!gaiAllowed('archive'))return;
      e.preventDefault();openViewer(host.querySelector('#archive-paper-wrapper .paper-report-container'),'archive');
    },true);

    // Both supported release entry names use the frozen date/type and paper.
    // The controls stay outside the paper, exactly as before.
    window.saveArchivePNG=window.exportArchivePNG=async function() {
      if(!archiveSnapshot || !allowed('archive') || (viewingArchiveGAITable&&!gaiAllowed('archive')))return;
      const selected=archiveSnapshot, gai=!!viewingArchiveGAITable;
      const source=host.querySelector('#archive-paper-wrapper .paper-report-container');
      if(!source || typeof window.html2pdf!=='function') {showError('Экспорт изображения недоступен');return;}
      const sheet=clonePaper(source);
      sheet.style.width='max-content';sheet.style.maxWidth='none';
      const holder=document.createElement('div');
      holder.style.cssText='position:fixed;left:-100000px;top:0;width:max-content;background:#fdfdfd;pointer-events:none;z-index:-1';
      holder.append(sheet);document.body.append(holder);
      const button=host.querySelector('#archiveSavePngBtn,button[onclick="exportArchivePNG()"]');
      if(button?.disabled){holder.remove();return;}
      if(button)button.disabled=true;
      let worker;
      try {
        if(document.fonts?.ready)await Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,2500))]);
        const table=sheet.querySelector('.paper-table'),bounds=sheet.getBoundingClientRect();
        const width=Math.ceil(Math.max(1,sheet.scrollWidth,bounds.width,table?table.getBoundingClientRect().right-bounds.left+12:0));
        const height=Math.ceil(Math.max(1,sheet.scrollHeight,bounds.height));
        const scale=Math.min(2,Math.sqrt(16000000/(width*height)),8192/width,8192/height);
        worker=window.html2pdf().set({margin:0,pagebreak:{mode:[],before:[],after:[],avoid:[]},html2canvas:{scale,width,height,windowWidth:Math.max(window.innerWidth,width),windowHeight:Math.max(window.innerHeight,height),scrollX:0,scrollY:0,useCORS:true,logging:false,backgroundColor:'#fdfdfd'},jsPDF:{unit:'px',format:'a4'}}).from(sheet).toContainer().then(function(){
          this.prop.container.style.width=width+'px';this.prop.container.style.maxWidth='none';this.prop.container.style.height='auto';this.prop.container.style.overflow='visible';
        });
        const canvas=await worker.toCanvas().get('canvas');
        if(!canvas || canvas.width<width*scale*.97 || canvas.height<height*scale*.97)throw new Error('PNG получился обрезанным');
        const blob=await new Promise((resolve,reject)=>canvas.toBlob(result=>result?resolve(result):reject(new Error('Браузер не смог создать PNG')),'image/png'));
        const clean=value=>String(value||'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_');
        const url=URL.createObjectURL(blob),link=document.createElement('a');
        link.href=url;link.download=clean(selected.objectName).slice(0,70)+'_'+clean(selected.date)+(gai?'_ГАИ':'')+'.png';
        document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
        showToastEl('Отчёт PNG сохранён',false);
      } catch(error) {console.warn('Archive PNG',error);showError('Не удалось сохранить PNG: '+error.message);}
      finally {worker?.prop?.overlay?.remove();holder.remove();if(button)button.disabled=false;}
    };
  }
})();
