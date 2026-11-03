
(()=>{
  'use strict';
  const KEY='samosval-ui-haptics-enabled';
  const LEVEL_KEY='samosval-ui-haptics-level';
  const enabled=()=>{try{return localStorage.getItem(KEY)!=='0'}catch(_){return true}};
  const level=()=>{try{const value=localStorage.getItem(LEVEL_KEY);return value==='weak'||value==='strong'?value:'medium'}catch(_){return 'medium'}};
  const duration=()=>({weak:8,medium:15,strong:28})[level()];
  const controls='button,[role="button"],[role="tab"],[role="switch"],a[href],input[type="button"],input[type="submit"],input[type="checkbox"],input[type="radio"],input[type="range"],select,summary,.truck-card[data-truck-id],label.toggle-switch';
  const excluded=/^(приехал(?: на линию)?|погрузка|ттн)$/i;
  function controlFor(target){return target instanceof Element?target.closest(controls):null}
  function isLegacyAction(el){
    if(el.closest('[onpointerdown*="startHold"],[ontouchstart*="startHold"],[onmousedown*="startHold"],.holding,.admin-holding'))return true;
    const label=(el.innerText||el.textContent||el.getAttribute('aria-label')||'').trim().replace(/\s+/g,' ');
    return excluded.test(label);
  }
  function allowed(el){
    if(!el||el.disabled||el.getAttribute('aria-disabled')==='true'||isLegacyAction(el))return false;
    const nested=el.querySelector?.('input,button,[disabled]');
    return !nested?.disabled;
  }
  function addControl(){
    if(document.getElementById('globalUiHaptics'))return;
    const anchor=document.getElementById('hapticTtn');
    if(!anchor)return;
    const row=anchor.closest('.settings-row');if(!row)return;
    const node=document.createElement('div');node.className='settings-row';
    node.innerHTML='<div>📳 Вибрация интерфейса</div><label class="toggle-switch"><input type="checkbox" id="globalUiHaptics"><span class="toggle-slider"></span></label>';
    row.after(node);
    const input=node.querySelector('input');input.checked=enabled();
    input.addEventListener('change',()=>{try{localStorage.setItem(KEY,input.checked?'1':'0')}catch(_){}});
    const levelRow=document.createElement('div');levelRow.className='settings-row';
    levelRow.innerHTML='<div>Уровень вибрации</div><select id="globalUiHapticsLevel" class="form-control" style="width:auto;min-width:130px"><option value="weak">Слабый</option><option value="medium">Средний</option><option value="strong">Сильный</option></select>';
    node.after(levelRow);
    const select=levelRow.querySelector('select');select.value=level();
    select.addEventListener('change',()=>{try{localStorage.setItem(LEVEL_KEY,select.value)}catch(_){}});
  }
  const observer=new MutationObserver(()=>{if(document.getElementById('hapticTtn')&&!document.getElementById('globalUiHaptics'))addControl()});
  observer.observe(document.documentElement,{childList:true,subtree:true});addControl();
  let press=null,last=0,lastPointerPulse=0;
  function pulse(){
    if(!enabled()||typeof navigator.vibrate!=='function')return;
    const now=Date.now();if(now-last<90)return;last=now;
    try{navigator.vibrate(duration())}catch(_){}
  }
  document.addEventListener('pointerdown',event=>{
    press=null;
    if(!event.isTrusted||!event.isPrimary||event.button!==0)return;
    const el=controlFor(event.target);if(!allowed(el))return;
    press={id:event.pointerId,x:event.clientX,y:event.clientY,el};
  },{capture:true,passive:true});
  document.addEventListener('pointermove',event=>{
    if(!press||event.pointerId!==press.id)return;
    if(Math.hypot(event.clientX-press.x,event.clientY-press.y)>10)press=null;
  },{capture:true,passive:true});
  document.addEventListener('pointerup',event=>{
    const p=press;press=null;
    if(!p||!event.isTrusted||event.pointerId!==p.id)return;
    if(Math.hypot(event.clientX-p.x,event.clientY-p.y)>10)return;
    const el=controlFor(event.target);if(el!==p.el||!allowed(el))return;
    pulse();lastPointerPulse=Date.now();
  },{capture:true,passive:true});
  document.addEventListener('pointercancel',()=>{press=null},{capture:true,passive:true});
  document.addEventListener('click',event=>{
    if(!event.isTrusted||event.detail!==0||Date.now()-lastPointerPulse<350)return;
    const el=controlFor(event.target);if(allowed(el))pulse();
  },{capture:true,passive:true});
})();
