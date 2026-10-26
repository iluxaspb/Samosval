
(function () {
  const key = 'samosval:test:summary-viewer:v1';
  const tab = document.getElementById('tab-report');
  let on = false, dialog = null, opener = null, observer = null;
  const style = document.createElement('style');
  style.textContent = `
    body.summary-viewer-on #tab-report > .action-row,
    body.summary-viewer-on #tab-report > div:first-child,
    body.summary-viewer-on #pluginPdfButtonsContainer,
    body.summary-viewer-on #tab-report .stylus-canvas {display:none!important}
    #summary-open-sheet {width:100%;margin-bottom:12px}
    body:not(.summary-viewer-on) #summary-open-sheet {display:none}
    body.summary-viewer-on #tab-report .paper-scroll-wrapper {cursor:zoom-in}
    #summary-sheet-dialog {position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;border:0;padding:0;background:#0f172a;color:#f8fafc;overscroll-behavior:none}
    #summary-sheet-dialog::backdrop {background:#0f172a}
    #summary-sheet-dialog[open] {display:flex;flex-direction:column}
    .sheet-tools {display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px;padding-top:max(12px,env(safe-area-inset-top));border-bottom:1px solid #334155}
    .sheet-tools button {min-width:44px;min-height:44px;border:1px solid #475569;border-radius:8px;background:#1e293b;color:white;padding:8px;cursor:pointer}
    .sheet-stage {position:relative;flex:1;min-height:0;overflow:hidden;touch-action:none;user-select:none;cursor:grab}
    .sheet-stage:active {cursor:grabbing}
    .sheet-page {position:absolute;left:0;top:0;transform-origin:0 0;background:white;width:max-content}
    #summary-sheet-dialog .paper-report-container {zoom:1!important;transition:none!important;width:max-content;min-width:780px}
    #summary-sheet-dialog .stylus-canvas {display:none!important}
    .sheet-hint {font-size:12px;color:#94a3b8;padding:8px;text-align:center;padding-bottom:max(8px,env(safe-area-inset-bottom))}
  `;
  document.head.append(style);

  function close() { if (!dialog) return; observer?.disconnect(); dialog.close(); dialog.remove(); dialog=null; document.body.style.overflow=oldOverflow; opener?.focus(); }
  let oldOverflow='';
  function open() {
    if (!on || dialog) return;
    const source = document.getElementById(document.getElementById('gaiReportWrapper').style.display !== 'none' ? 'gaiPaperContainer' : 'paperReportContainer');
    if (!source) return;
    opener=document.activeElement; oldOverflow=document.body.style.overflow; document.body.style.overflow='hidden';
    dialog=document.createElement('dialog'); dialog.id='summary-sheet-dialog'; dialog.setAttribute('aria-label','Просмотр сводки');
    dialog.innerHTML='<div class="sheet-tools"><strong style="flex:1">Сводка</strong><button type="button" data-action="out" aria-label="Уменьшить">−</button><span class="sheet-scale" aria-live="polite"></span><button type="button" data-action="in" aria-label="Увеличить">+</button><button type="button" data-action="fit">Лист целиком</button><button type="button" data-action="close" aria-label="Закрыть просмотр">✕</button></div><div class="sheet-stage"><div class="sheet-page"></div></div><div class="sheet-hint">Двигайте лист пальцем · Масштаб — двумя пальцами · Двойное нажатие — лист целиком</div>';
    document.body.append(dialog); dialog.showModal();
    const stage=dialog.querySelector('.sheet-stage'), page=dialog.querySelector('.sheet-page'), scaleLabel=dialog.querySelector('.sheet-scale');
    let x=0,y=0,scale=1,min=.1;
    function copy() {const clone=source.cloneNode(true); clone.removeAttribute('id'); clone.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id')); clone.querySelectorAll('canvas').forEach(el=>el.remove()); clone.classList.remove('compact'); page.replaceChildren(clone);}
    function paint() {const w=page.offsetWidth*scale,h=page.offsetHeight*scale; x=w<=stage.clientWidth?(stage.clientWidth-w)/2:Math.min(0,Math.max(stage.clientWidth-w,x)); y=h<=stage.clientHeight?(stage.clientHeight-h)/2:Math.min(0,Math.max(stage.clientHeight-h,y));page.style.transform=`translate(${x}px,${y}px) scale(${scale})`;scaleLabel.textContent=Math.round(scale*100)+'%';}
    function fit() {min=Math.min(1,(stage.clientWidth-24)/page.offsetWidth,(stage.clientHeight-24)/page.offsetHeight);min=Math.max(.02,min);scale=min;x=y=0;paint();}
    function zoom(next,cx=stage.clientWidth/2,cy=stage.clientHeight/2) {next=Math.min(4,Math.max(min,next));x=cx-(cx-x)*next/scale;y=cy-(cy-y)*next/scale;scale=next;paint();}
    copy(); fit();
    observer=new MutationObserver(()=>{copy();paint();});observer.observe(source,{childList:true,subtree:true,characterData:true});
    const resize=new ResizeObserver(()=>paint());resize.observe(stage);
    dialog.addEventListener('close',()=>resize.disconnect(),{once:true});
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    dialog.querySelector('.sheet-tools').addEventListener('click',e=>{const a=e.target.closest('button')?.dataset.action;if(a==='close')close();if(a==='fit')fit();if(a==='in')zoom(scale*1.3);if(a==='out')zoom(scale/1.3);});
    const points=new Map(); let last=null, tapTime=0;
    function geometry(){const p=[...points.values()];return {x:p.reduce((s,v)=>s+v.x,0)/p.length,y:p.reduce((s,v)=>s+v.y,0)/p.length,d:p.length>1?Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y):0};}
    stage.addEventListener('pointerdown',e=>{const r=stage.getBoundingClientRect();points.set(e.pointerId,{x:e.clientX-r.left,y:e.clientY-r.top});stage.setPointerCapture(e.pointerId);last=geometry();});
    stage.addEventListener('pointermove',e=>{if(!points.has(e.pointerId))return;const r=stage.getBoundingClientRect();points.set(e.pointerId,{x:e.clientX-r.left,y:e.clientY-r.top});const g=geometry();if(last){x+=g.x-last.x;y+=g.y-last.y;if(g.d&&last.d)zoom(scale*g.d/last.d,g.x,g.y);else paint();}last=g;});
    const release=e=>{points.delete(e.pointerId);last=points.size?geometry():null;};
    stage.addEventListener('pointerup',release);stage.addEventListener('pointercancel',release);stage.addEventListener('lostpointercapture',release);
    stage.addEventListener('click',e=>{if(Date.now()-tapTime<300){fit();tapTime=0;}else tapTime=Date.now();});
    stage.addEventListener('wheel',e=>{e.preventDefault();const r=stage.getBoundingClientRect();zoom(scale*Math.exp(-e.deltaY*.002),e.clientX-r.left,e.clientY-r.top);},{passive:false});
    if(document.fonts)document.fonts.ready.then(()=>{if(dialog)paint();});
  }
  tab.addEventListener('click',e=>{if(on&&e.target.closest('.paper-scroll-wrapper')){e.preventDefault();open();}},true);
  function apply(value){on=value;if(!on)close();document.body.classList.toggle('summary-viewer-on',on);}
  apply(true);
})();
