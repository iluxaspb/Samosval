(function settingsHub(){
'use strict';
const sections=[
 {key:'hold',icon:'⏱️',label:'Удержание кнопок',desc:'Погрузка, прибытие, ТТН и сброс',ids:['settingHoldLoad','settingHoldArrive','settingHoldTtn','settingHoldResetCycle']},
 {key:'cycle',icon:'🚛',label:'Время ходки',desc:'Общий интервал рейсов',ids:['settingCycleMinutes']},
 {key:'vibration',icon:'📳',label:'Вибрация',desc:'Кнопки, интерфейс, сила отклика',ids:['hapticArrive','hapticLoad','hapticTtn','globalUiHaptics','globalUiHapticsLevel','soft-vib-Arrive','soft-vib-Load','soft-vib-Ttn']},
 {key:'motion',icon:'🎬',label:'Анимации',desc:'Анимация карточек на «Линии»',ids:['soft-motion-pace','soft-motion-spring'],blocks:['speed-settings-block','soft-motion-setting']},
 {key:'navigation',icon:'🔀',label:'Порядок вкладок',desc:'Нижнее меню на устройстве',blocks:['nav-sort-block']},
 {key:'pwa',icon:'📱',label:'Приложение',desc:'Версия, установка и обновления',blocks:['test-pwa-settings']},
 {key:'other',icon:'🧩',label:'Другие настройки',desc:'Параметры расширений'}
];
const main=document.getElementById('settingsModal');
const original=main?.querySelector('.modal-content > .modal-body');
if(!main||!original||document.getElementById('settingsCategoryModal'))return;
const css=document.createElement('style');css.id='test-settings-hub-css';
css.textContent=`
#settingsModal.settings-hub .settings-source {display:none!important}
#settingsModal .settings-hub-intro {margin:12px 0;font-size:12px;line-height:1.5;color:var(--muted)}
#settingsModal .settings-tiles {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:10px 0}
#settingsModal .settings-tile {display:flex;flex-direction:column;min-width:0;min-height:103px;gap:7px;align-items:flex-start;
text-align:left;border-radius:14px;border:1px solid var(--border);background:var(--bg);color:var(--text);padding:12px;cursor:pointer}
#settingsModal .settings-tile:hover {border-color:var(--primary)}
#settingsModal .settings-tile:active {transform:scale(.98)}
#settingsModal .settings-tile:focus-visible,#settingsCategoryModal button:focus-visible {outline:2px solid #60a5fa;outline-offset:2px}
#settingsModal .settings-tile[hidden] {display:none!important}
#settingsModal .settings-tile-icon {font-size:21px}
#settingsModal .settings-tile-label {font-weight:750;font-size:14px;line-height:1.2}
#settingsModal .settings-tile-note {font-size:11px;line-height:1.35;color:var(--muted)}
#settingsCategoryModal .modal-content {max-width:540px;max-height:90dvh;border-radius:18px}
#settingsCategoryModal .settings-subhead {display:flex;align-items:center;gap:10px}
#settingsCategoryModal .settings-subhead h3 {flex:1;font-size:16px;line-height:1.25}
#settingsCategoryModal .settings-subhead button {min-width:40px;min-height:40px;border-radius:10px;
border:1px solid var(--border);color:var(--text);background:var(--bg);cursor:pointer;font-size:16px}
#settingsCategoryModal .settings-description {font-size:12px;color:var(--muted);margin:10px 0}
#settingsCategoryModal .modal-body {overflow-y:auto;max-height:calc(90dvh - 180px)}
#settingsCategoryModal .settings-pane[hidden] {display:none!important}
#settingsCategoryModal .settings-pane>.settings-row {gap:8px}
#settingsCategoryModal .settings-pane>.settings-row>div:first-child {font-size:13px}
#settingsCategoryModal .settings-pane>.form-group {margin:0 0 13px}
#settingsCategoryModal .settings-back-bottom {width:100%;min-height:44px}
#settingsModal.settings-hub .modal-content,#settingsCategoryModal .modal-content{
 background:var(--card,#1e293b);border:1px solid rgba(148,163,184,.3);
 border-radius:20px;box-shadow:0 22px 54px rgba(0,0,0,.48);width:min(540px,100%)}
/* Главная шестерёнка: выраженная рамка и безопасные поля вокруг всех плашек и кнопки. */
#settingsModal.settings-hub{padding:14px!important}
#settingsModal.settings-hub .modal-content{
 padding:0!important;max-height:90dvh;overflow:hidden;border-color:rgba(148,163,184,.55)!important}
#settingsModal.settings-hub .modal-content>div:first-child{
 padding:18px 20px!important;border-bottom:1px solid var(--border,#334155);flex-shrink:0}
#settingsModal.settings-hub .settings-hub-intro{
 margin:16px 18px 0!important;padding:0!important}
#settingsModal.settings-hub .settings-tiles{
 margin:12px 16px 14px!important;padding:2px;min-height:0;overflow-y:auto;overflow-x:hidden}
#settingsModal.settings-hub .modal-content>button{
 width:calc(100% - 36px)!important;margin:0 18px 18px!important;min-height:44px;flex-shrink:0}
@media(max-width:380px){
 #settingsModal.settings-hub{padding:12px!important}
 #settingsModal.settings-hub .modal-content>div:first-child{padding:16px!important}
 #settingsModal.settings-hub .settings-hub-intro{margin:14px 14px 0!important}
 #settingsModal.settings-hub .settings-tiles{margin:10px 12px 12px!important}
 #settingsModal.settings-hub .modal-content>button{
  width:calc(100% - 28px)!important;margin:0 14px 14px!important}
}
#settingsModal .settings-tile{background:linear-gradient(145deg,var(--bg,#0f172a),rgba(51,65,85,.65));
 border:1px solid rgba(148,163,184,.24);border-radius:15px;min-height:107px}
#settingsModal .settings-tile-icon{display:grid;place-items:center;width:34px;height:34px;
 background:rgba(59,130,246,.15);border-radius:10px}
#settingsCategoryModal .settings-subhead{padding-bottom:12px;border-bottom:1px solid var(--border)}
#settingsCategoryModal .modal-content{padding:16px 18px}
#settingsCategoryModal .settings-pane>.form-group,#settingsCategoryModal .settings-pane>.settings-row,
#settingsCategoryModal .settings-pane>.soft-section{background:var(--bg,#0f172a);
 border:1px solid var(--border,#334155);border-radius:12px;padding:12px;margin:0 0 10px}
#settingsCategoryModal .soft-section[hidden],#settingsCategoryModal .settings-pane>[hidden]{display:none!important}
#settingsCategoryModal .soft-original-haptic{display:none!important}
#settingsCategoryModal .soft-range-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px}
#settingsCategoryModal .soft-value{font-size:13px;color:#93c5fd;font-weight:750;white-space:nowrap}
#settingsCategoryModal .soft-ends{display:flex;justify-content:space-between;gap:10px;font-size:10px;color:var(--muted)}
#settingsCategoryModal input.soft-range{height:34px!important;background:transparent!important;border:0!important;padding:0!important}
#settingsCategoryModal .soft-preview{display:flex;gap:8px;justify-content:center;padding:16px;
 background:var(--bg,#0f172a);border:1px solid var(--border);border-radius:12px;margin:12px 0;overflow:hidden}
#settingsCategoryModal .soft-preview span{display:block;width:46px;height:28px;border-radius:6px;background:#334155;border:1px solid #64748b}
#settingsCategoryModal .soft-preview span:first-child{background:#155e75;border-color:#38bdf8}
#settingsCategoryModal .soft-preview-button{width:100%;min-height:42px;background:var(--bg,#0f172a);
 color:var(--text);border:1px solid var(--border);border-radius:12px;cursor:pointer}

#settingsCategoryModal .settings-pane input[type=range]{width:100%;accent-color:var(--primary)}
#settingsCategoryModal #speed-settings-block{border:0!important;margin:0!important;padding:0!important}
#settingsCategoryModal #speed-settings-block .speed-slider-row{background:var(--bg,#0f172a);
 border:1px solid var(--border);border-radius:12px;padding:12px;margin:0 0 9px}
#settingsCategoryModal #test-pwa-settings{margin:0!important;padding:0!important;border:0!important}
#settingsCategoryModal #test-pwa-state{padding:12px;border:1px solid var(--border);
 border-radius:12px;background:var(--bg);line-height:1.5}
#settingsCategoryModal #test-pwa-settings>button{display:flex;width:100%;min-height:44px;
 border-radius:12px;margin:0 0 9px!important;align-items:center;justify-content:center}
#settingsCategoryModal #test-pwa-install{background:var(--primary,#3b82f6);color:#fff}
#settingsCategoryModal #test-pwa-install[hidden]{display:none!important}
#settingsCategoryModal #test-pwa-recovery-link{display:block;padding:11px 12px!important;
 border:1px solid rgba(59,130,246,.4);border-radius:12px;background:rgba(59,130,246,.1);
 color:#93c5fd!important;text-decoration:none;font-size:12px!important;line-height:1.5}
#settingsCategoryModal #test-pwa-update-message:not(:empty){padding:10px 11px;
 border:1px solid var(--border);border-radius:10px;background:var(--bg)}
#settingsCategoryModal #test-pwa-settings>p:last-child{border-top:1px solid var(--border);
 padding-top:12px;margin-top:14px;font-size:12px;line-height:1.6;color:var(--muted)}
#settingsCategoryModal .settings-back-bottom{margin-top:10px;border-radius:12px}
@media(max-width:380px){#settingsCategoryModal .modal-content{padding:12px}
#settingsModal .settings-tile{min-height:100px;padding:10px}}
@media(max-width:360px){#settingsModal .settings-tile{padding:10px;min-height:110px}}
@media(prefers-reduced-motion:reduce){#settingsModal .settings-tile {transition:none}}
`;
document.head.append(css);
const intro=document.createElement('p');intro.className='settings-hub-intro';
intro.textContent='Выберите раздел. Настройки и способ их сохранения остались прежними.';
const grid=document.createElement('div');grid.className='settings-tiles';
original.parentElement.insertBefore(intro,original);
original.parentElement.insertBefore(grid,original);
original.classList.add('settings-source');main.classList.add('settings-hub');
const modal=document.createElement('div');modal.id='settingsCategoryModal';modal.className='modal';
modal.innerHTML='<div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="settingsCategoryHeading">'+
'<div class="settings-subhead"><button type="button" data-back aria-label="Назад">←</button>'+
'<h3 id="settingsCategoryHeading" tabindex="-1"></h3><button type="button" data-close aria-label="Закрыть">✕</button></div>'+
'<p class="settings-description" id="settingsCategoryDescription"></p><div class="modal-body" id="settingsCategoryArea"></div>'+
'<button type="button" class="btn btn-quick settings-back-bottom" data-back>К разделам</button></div>';
document.body.append(modal);
const panes=new Map(),tiles=new Map();
let current=null,last=null,scheduled=false;
for(const s of sections){
 const b=document.createElement('button');b.type='button';b.className='settings-tile';b.dataset.category=s.key;
 for(const [cls,value] of [['settings-tile-icon',s.icon],['settings-tile-label',s.label],['settings-tile-note',s.desc]]){
   const item=document.createElement('span');item.className=cls;item.textContent=value;b.append(item);
 }
 grid.append(b);tiles.set(s.key,b);
 const pane=document.createElement('div');pane.className='settings-pane';pane.hidden=true;pane.dataset.key=s.key;
 modal.querySelector('#settingsCategoryArea').append(pane);panes.set(s.key,pane);
 b.addEventListener('click',()=>show(s,b));
}
// 3.4.25: the test-only motion upgrade owns slider bounds and preferences.
function gather(){
 // Group optional motion-patch sections atomically so they do not leave
 // duplicated headings and orphan settings under «Другие настройки».
 for(const group of new Set([...original.querySelectorAll('.soft-section'),...modal.querySelectorAll('.soft-section')])){
   const title=group.querySelector('h4')?.textContent||'';
   const key=/Удержание кнопок/i.test(title)?'hold':/Смена/i.test(title)?'cycle':
     /Виброотдача/i.test(title)?'vibration':/Движение карточек/i.test(title)?'motion':null;
   if(key&&!panes.get(key).contains(group))panes.get(key).append(group);
 }
 for(const s of sections){
   if(s.key==='other')continue;
   const pane=panes.get(s.key);
   for(const id of s.ids||[]){
     const field=document.getElementById(id);
     if(!field||pane.contains(field))continue;
     const row=field.closest('.form-group,.settings-row')||field;
     if(!pane.contains(row))pane.append(row);
   }
   for(const id of s.blocks||[]){
     const block=document.getElementById(id);
     if(block&&!pane.contains(block))pane.append(block);
   }
 }
 // Move existing controls; never clone, rebind or reset a saved setting.
 for(const item of [...original.children])panes.get('other').append(item);
 for(const pane of panes.values())for(const item of pane.querySelectorAll('.soft-section'))
   item.hidden=!item.querySelector('input,select,textarea,button,a');
 const other=panes.get('other');
 for(const item of other.children)if(item.matches('.soft-section,.settings-row,.form-group')&&
   !item.querySelector('input,select,textarea,button,a'))item.hidden=true;
 tiles.get('other').hidden=![...other.children].some(item=>!item.hidden);
}
function queueGather(){if(scheduled)return;scheduled=true;setTimeout(()=>{scheduled=false;gather();},0);}
const observer=new MutationObserver(queueGather);observer.observe(original,{childList:true});gather();
function show(s,button){
 gather();current=s.key;last=button;
 for(const [key,pane] of panes)pane.hidden=key!==s.key;
 modal.querySelector('#settingsCategoryHeading').textContent=s.icon+' '+s.label;
 modal.querySelector('#settingsCategoryDescription').textContent=s.desc;
 main.classList.remove('open');modal.classList.add('open');
 requestAnimationFrame(()=>modal.querySelector('#settingsCategoryHeading').focus({preventScroll:true}));
 setTimeout(()=>{if(current===s.key)gather();},160);
}
function back(){
 current=null;modal.classList.remove('open');main.classList.add('open');gather();
 if(last&&!last.hidden)requestAnimationFrame(()=>last.focus({preventScroll:true}));
}
const priorOpen=window.openSettingsModal,priorClose=window.closeSettingsModal;
window.openSettingsModal=function(){const result=priorOpen?.apply(this,arguments);
 current=null;modal.classList.remove('open');main.classList.add('open');gather();
 setTimeout(gather,60);setTimeout(gather,170);return result;};
window.closeSettingsModal=function(){current=null;modal.classList.remove('open');
 if(typeof priorClose==='function')return priorClose.apply(this,arguments);main.classList.remove('open');};
modal.querySelectorAll('[data-back]').forEach(b=>b.addEventListener('click',back));
modal.querySelector('[data-close]').addEventListener('click',()=>window.closeSettingsModal());
modal.addEventListener('click',e=>{if(e.target===modal)back();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modal.classList.contains('open')){e.preventDefault();back();}});
})();
/* TEST-ONLY v3.4.25: upgrade existing Firebase line-motion patch locally.
 * Do not activate an admin-disabled patch; do not modify Firebase or production.
 */
(function upgradeInstalledLineMotion(){
'use strict';
let upgrading=false;
function upgrade(){
  if(upgrading)return;
  const old=window.__lineSoftMotionV1;
  if(!old||old.version!=='1.0.0')return;
  upgrading=true;
  try {
    old.destroy();
/* Линия: движение и настройки v1.0.0. Тип патча: «Замена функции».
 * Тестовая замена: активируется только поверх установленного патча v1.0.0.
 * Сортировка, кнопки, данные рейсов и права остаются в исходном renderLine.
 * Новые настройки: темп, пружина, длительность вибрации на этом устройстве.
 * Полное отключение: выключить этот патч в админке и перезагрузить страницу.
 * Только анимация: выключатель «Мягкое движение карточек» в шестерёнке.
 */
(function () {
  'use strict';
  if (window.__lineSoftMotionV1) return;
  if (typeof window.renderLine !== 'function' || !window.__animSpeedsV7) {
    throw new Error('Мягкая пружина: не найден совместимый модуль карточек Линии');
  }
  const original = window.renderLine;
  const KEY = 'samosval:line-soft-motion:v1';
  const CLASS = 'line-soft-motion-v1';
  const SELECTOR = '.truck-card[data-truck-id]';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const running = new Map();
  let enabled = true, scrollFrame = 0, lastGesture = -Infinity;
  const PREFS = 'samosval:line-soft-motion:preferences:v1';
  const defaults = {pace:1, spring:35};
  let prefs = {...defaults};
  try { const p=JSON.parse(localStorage.getItem(PREFS)||'{}');
    prefs.pace = Math.min(7.2,Math.max(.7,Number(p.pace)||1));
    prefs.spring = Number.isFinite(p.spring) ? Math.min(100,Math.max(0,p.spring)) : 35;
    for (const key of ['Arrive','Load','Ttn']) if (Number.isFinite(p['vib'+key])) prefs['vib'+key]=Math.min(80,Math.max(0,p['vib'+key]));
  } catch (_) {}
  function savePrefs() { try { localStorage.setItem(PREFS,JSON.stringify(prefs)); } catch (_) {} }
  try { enabled = localStorage.getItem(KEY) !== 'off'; } catch (_) {}
  const css = document.createElement('style');
  css.id = 'line-soft-motion-v1-css';
  css.textContent = `
    #trucksLineList.${CLASS} { position:relative; isolation:isolate; overflow-anchor:none; }
    #trucksLineList.${CLASS} > .truck-card {
      margin-bottom:12px!important; transition:none!important; animation:none!important;
      will-change:auto!important;
    }
    #trucksLineList.${CLASS} > .truck-card[data-soft-moving] { will-change:transform!important; }
    #trucksLineList.${CLASS} > .truck-card[data-soft-front] { z-index:5!important; }
    #trucksLineList.${CLASS} > .truck-card[data-soft-back] { z-index:1!important; }
    html.${CLASS} #speed-settings-block { display:none!important; }
    #soft-motion-setting { margin-top:16px;padding-top:16px;border-top:1px solid var(--border,#334155); }
    #soft-motion-setting label { display:flex;align-items:center;justify-content:space-between;gap:16px;font-weight:700; }
    #soft-motion-setting input { width:22px;height:22px;accent-color:#38bdf8; }
    #soft-motion-setting p { margin-top:8px;font-size:12px;line-height:1.5;color:var(--muted,#94a3b8); }
  `;
  document.head.append(css);
  const list = () => document.getElementById('trucksLineList');
  function setClasses() {
    list()?.classList.toggle(CLASS, enabled);
    document.documentElement.classList.toggle(CLASS, enabled);
  }
  function clearCard(card) {
    delete card.dataset.softMoving;
    delete card.dataset.softFront;
    delete card.dataset.softBack;
  }
  function stopScroll() { cancelAnimationFrame(scrollFrame); scrollFrame = 0; }
  function stop() {
    for (const [card, animation] of running) { animation.cancel(); clearCard(card); }
    running.clear(); stopScroll();
  }
  function animate(card, frames, duration, resumeTime) {
    if (typeof card.animate !== 'function') return;
    card.dataset.softMoving = '';
    const animation = card.animate(frames, { duration, easing:'linear', fill:'both' });
    if (resumeTime != null) animation.currentTime=resumeTime;
    running.set(card, animation);
    animation.finished.then(() => {
      if (running.get(card) !== animation) return;
      running.delete(card); animation.cancel(); clearCard(card);
    }, () => {});
  }
  // A shared spring clock keeps adjacent cards together; overshoot <= 2 px.
  // One shared spring clock: zero is smooth landing, maximum shows a visible, bounded rebound.
  function springFrames(dx, dy) {
    const frames=[], distance=Math.hypot(dx,dy);
    const strength=Math.min(1,Math.max(0,prefs.spring/100));
    const damping=.96-.58*strength, omega=10+5*strength;
    const oscillation=Math.sqrt(1-damping*damping);
    const maxBounce=Math.min(28,distance*.25);
    for(let i=0;i<=60;i++){
      const t=i/60;
      let residual;
      if(strength===0) residual=Math.pow(1-t,3);
      else {
        residual=Math.exp(-damping*omega*t) *
          (Math.cos(omega*oscillation*t)+(damping/oscillation)*Math.sin(omega*oscillation*t));
        if(residual<0) {
          residual=-maxBounce*Math.tanh(-residual*distance/Math.max(1,maxBounce))/Math.max(1,distance);
        }
      }
      if(i===60) residual=0;
      frames.push({transform:`translate3d(${dx*residual}px,${dy*residual}px,0)`,offset:t});
    }
    return frames;
  }
  function followArrival(card, duration) {
    if (performance.now() - lastGesture < 800) return;
    const header = document.getElementById('mainHeader');
    const headerBottom = Math.max(0, header?.getBoundingClientRect().bottom || 0);
    const start = window.scrollY;
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const target = Math.max(0, Math.min(max, start + card.getBoundingClientRect().top - headerBottom - 16));
    if (Math.abs(target-start) < 2) return;
    const started = performance.now();
    const tick = now => {
      const t = Math.min(1, (now-started)/duration), p = 1-Math.pow(1-t, 3);
      window.scrollTo({top:start+(target-start)*p,behavior:'instant'});
      scrollFrame = t < 1 ? requestAnimationFrame(tick) : 0;
    };
    scrollFrame = requestAnimationFrame(tick);
  }
  const fresh = hint => hint && Date.now()-hint.time >= 0 && Date.now()-hint.time < 5500;
  function render() {
    if (!enabled) return original.apply(this, arguments);
    // Let an animation already started BEFORE installation finish normally.
    if (window.__lineAnimating) return original.apply(this, arguments);
    const c = list();
    if (!c) return original.apply(this, arguments);
    setClasses();
    const visible = c.getClientRects().length > 0 && !document.hidden;
    const old = new Map(), continuing = new Map();
    c.querySelectorAll(SELECTOR).forEach(card => {
      const r = card.getBoundingClientRect();
      old.set(card.dataset.truckId, {x:r.left+scrollX, y:r.top+scrollY});
      const a=running.get(card);
      if(a && a.effect.getKeyframes()[0].transform.startsWith('translate')) {
        const matrix=new DOMMatrixReadOnly(getComputedStyle(card).transform);
        continuing.set(card.dataset.truckId,{x:r.left+scrollX-matrix.m41,y:r.top+scrollY-matrix.m42,frames:a.effect.getKeyframes(),duration:a.effect.getTiming().duration,time:a.currentTime});
      }
    });
    const loaded = window.__cardJustLoaded, arrived = window.__cardJustArrived;
    const loadId = fresh(loaded) ? loaded.id : null;
    const arriveId = fresh(arrived) ? arrived.id : null;
    stop();
    // The original renderer replaces these nodes anyway. An empty old layout
    // bypasses ONLY its legacy animation section, including queued delays.
    const previousNodes = Array.from(c.childNodes);
    c.replaceChildren();
    let result;
    try { result = original.apply(this, arguments); }
    catch (error) { c.replaceChildren(...previousNodes); throw error; }
    if (window.__cardJustLoaded === loaded) window.__cardJustLoaded = null;
    if (window.__cardJustArrived === arrived) window.__cardJustArrived = null;
    window.__linePendingRender = false;
    const cards = Array.from(c.querySelectorAll(SELECTOR));
    if (!visible || !c.getClientRects().length || reduce.matches) return result;
    const moves = cards.map(card => {
      const p = old.get(card.dataset.truckId), r = card.getBoundingClientRect();
      return {card, dx:p ? p.x-r.left-scrollX : 0, dy:p ? p.y-r.top-scrollY : 0};
    }).filter(m => Math.abs(m.dx)+Math.abs(m.dy) > .5);
    const farthest = Math.max(0, ...moves.map(m => Math.hypot(m.dx,m.dy)));
    const duration = Math.min(680, Math.max(460, 400+Math.sqrt(farthest)*9))*prefs.pace;
    const arrivalCard = cards.find(card => card.dataset.truckId === arriveId);
    if (arrivalCard && moves.some(m => m.card === arrivalCard)) followArrival(arrivalCard, duration);
    for (const {card,dx,dy} of moves) {
      const id = card.dataset.truckId;
      if (id === arriveId || (id !== loadId && dy > 0)) card.dataset.softFront = '';
      if (id === loadId) card.dataset.softBack = '';
      const continuation=continuing.get(id), final=card.getBoundingClientRect();
      if(continuation && Math.abs(continuation.x-final.left-scrollX)<.5 && Math.abs(continuation.y-final.top-scrollY)<.5)
        animate(card,continuation.frames,continuation.duration,continuation.time);
      else animate(card, springFrames(dx,dy), duration);
    }
    if (old.size) for (const card of cards) {
      if (moves.some(m => m.card === card)) continue;
      const id = card.dataset.truckId;
      if (id === loadId || id === arriveId) animate(card, [
        {transform:'scale(1)',offset:0},
        {transform:'scale(.986)',offset:.25},
        {transform:'scale(1.002)',offset:.7},
        {transform:'scale(1)',offset:1}
      ], 300);
    }
    return result;
  }
  function setEnabled(on) {
    stop(); enabled = !!on;
    try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch (_) {}
    setClasses(); mountSetting();
  }
  function mountSetting() {
    const body = document.querySelector('#settingsModal .modal-body');
    if (!body) return;
    let block = document.getElementById('soft-motion-setting');
    if (!block) {
      block = document.createElement('section'); block.id = 'soft-motion-setting';
      block.innerHTML = '<label>Мягкое движение карточек<input type="checkbox" aria-label="Мягкое движение карточек"></label><p>Выключите, чтобы вернуть прежнюю анимацию. Настройка действует на этом устройстве.</p>';
      block.querySelector('input').addEventListener('change', e => setEnabled(e.target.checked));
      body.prepend(block);
    }
    block.querySelector('input').checked = enabled;
  }
  function gesture() { lastGesture = performance.now(); stopScroll(); }
  for (const name of ['pointerdown','touchstart','wheel','keydown']) window.addEventListener(name, gesture, {passive:true});
  const onVisibility = () => { if (document.hidden) stop(); };
  const onResize = () => stop();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', onResize);
  reduce.addEventListener?.('change', onResize);
  window.renderLine = render;
  setClasses(); mountSetting();
  const restoreSettings = installSettings();
  window.__lineSoftMotionV1 = {
    version:'1.1.0-test', setEnabled,
    get enabled() { return enabled; },
    destroy() {
      stop(); enabled = false; setClasses(); css.remove();
      restoreSettings();
      document.getElementById('soft-motion-setting')?.remove();
      if (window.renderLine === render) window.renderLine = original;
      for (const name of ['pointerdown','touchstart','wheel','keydown']) window.removeEventListener(name, gesture);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      reduce.removeEventListener?.('change', onResize);
      delete window.__lineSoftMotionV1;
    }
  };
  console.info('[Линия · мягкая пружина v1.1.0-test] Патч обновлён в тестовой версии');

  function installSettings() {
    const modal=document.getElementById('settingsModal'), body=modal?.querySelector('.modal-body');
    if (!body) return () => {};
    const originalOpen=window.openSettingsModal;
    const moved=[], converted=[], owned=[], vibOriginals={};
    const style=document.createElement('style');
    style.textContent=`
      #settingsModal.soft-settings {background:transparent!important;backdrop-filter:none!important;align-items:center;padding:12px!important}
      #settingsModal.soft-settings .modal-content {width:min(540px,100%);max-height:90dvh;display:flex;flex-direction:column;padding:0!important;border:1px solid #475569;border-radius:22px!important;overflow:hidden;box-shadow:0 16px 60px #0008;background:var(--bg,#0f172a)}
      #settingsModal.soft-settings .modal-content>div:first-child {padding:18px 20px;background:var(--card,#1e293b);flex-shrink:0}
      #settingsModal.soft-settings .modal-content>div:first-child h3 {font-size:19px;margin:0}
      #settingsModal.soft-settings .modal-body {overflow-y:auto;overscroll-behavior:contain;min-height:0;padding:16px!important;margin:0!important}
      #settingsModal.soft-settings .modal-content>button {margin:12px 16px 16px;width:calc(100% - 32px);flex-shrink:0;min-height:44px}
      #settingsModal .soft-section {background:var(--card,#1e293b);border:1px solid var(--border,#334155);border-radius:16px;padding:16px;margin:0 0 12px}
      #settingsModal .soft-section h4 {font-size:15px;margin:0 0 6px;color:var(--text,#f8fafc)}
      #settingsModal .soft-note {font-size:12px;line-height:1.5;color:var(--muted,#94a3b8);margin:0 0 12px}
      #settingsModal .soft-section .form-group {margin:12px 0 0}
      #settingsModal .soft-section label {font-size:13px;color:var(--text,#f8fafc)}
      #settingsModal .soft-range-head {display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:4px}
      #settingsModal .soft-value {color:#7dd3fc;font-size:13px;font-weight:700;white-space:nowrap;font-variant-numeric:tabular-nums}
      #settingsModal input.soft-range {width:100%;height:36px!important;padding:0!important;accent-color:#38bdf8;cursor:pointer;background:transparent!important;border:0!important;touch-action:pan-y}
      #settingsModal input:disabled {opacity:.45;cursor:not-allowed}
      #settingsModal .soft-ends {display:flex;justify-content:space-between;font-size:10px;color:var(--muted,#94a3b8)}
      #settingsModal #soft-motion-setting {border:0;margin:12px 0;padding:0}
      #settingsModal .soft-preview {display:flex;gap:6px;justify-content:center;padding:16px;margin:10px 0;border-radius:12px;background:var(--bg,#0f172a);overflow:hidden}
      #settingsModal .soft-preview span {display:block;width:46px;height:28px;border-radius:6px;background:#334155;border:1px solid #64748b}
      #settingsModal .soft-preview span:first-child {background:#155e75;border-color:#38bdf8}
      #settingsModal .soft-preview-button {width:100%;min-height:40px;border:1px solid #475569;border-radius:10px;background:transparent;color:var(--text,#f8fafc);font-size:13px}
      #settingsModal .soft-section .settings-row {border:0;margin:4px 0;padding:8px 0}
      #settingsModal.soft-settings .soft-original-haptic {display:none!important}
    `;
    document.head.append(style);modal.classList.add('soft-settings');
    function section(title,note) {
      const s=document.createElement('section');s.className='soft-section';
      const h=document.createElement('h4');h.textContent=title;
      const p=document.createElement('p');p.className='soft-note';p.textContent=note;
      s.append(h,p);body.append(s);owned.push(s);return s;
    }
    const work=section('Смена','Время ходки общее для всех. Менять его может администратор при наличии связи.');
    const hold=section('Удержание кнопок','Сколько держать кнопку до действия. 0 секунд — действие сразу. Сохраняется на этом устройстве.');
    const haptic=section('Виброотдача','Длительность отклика после действия. 0 мс — выключено. Поддержка зависит от устройства и браузера.');
    const motion=section('Движение карточек','Настройте темп и мягкость завершения. Изменения видны в примере ниже.');
    function move(el,parent) {
      if (!el || el.parentElement===parent) return;
      const marker=document.createComment('soft-settings-original');
      el.before(marker);moved.push({el,marker});parent.append(el);
    }
    function range(input,title,min,max,step,format,left,right) {
      if (input.classList.contains('soft-range')) return;
      const attributes=Array.from(input.attributes).map(a=>[a.name,a.value]);
      const label=input.parentElement.querySelector('label');
      const head=document.createElement('div');head.className='soft-range-head';
      const caption=document.createElement('label');caption.htmlFor=input.id;caption.textContent=title;
      const output=document.createElement('output');output.className='soft-value';output.htmlFor=input.id;
      head.append(caption,output);input.before(head);
      if(label)label.hidden=true;
      const currentValue=input.value;
      input.min=min;input.max=max;input.step=step;input.type='range';input.value=currentValue;input.classList.add('soft-range');
      const ends=document.createElement('div');ends.className='soft-ends';
      const a=document.createElement('span'),b=document.createElement('span');a.textContent=left;b.textContent=right;ends.append(a,b);input.after(ends);
      const refresh=()=>{output.value=format(Number(input.value));input.setAttribute('aria-valuetext',output.value);};
      input.addEventListener('input',refresh);refresh();
      converted.push({input,attributes,label,head,ends,refresh});
    }
    const sec=n=>n===0?'Сразу':n.toLocaleString('ru-RU',{maximumFractionDigits:1})+' с';
    function layout() {
      move(document.getElementById('settingCycleMinutes')?.closest('.form-group'),work);
      for(const [id,title] of [['settingHoldLoad','Погрузка'],['settingHoldArrive','Прибытие на линию'],['settingHoldTtn','Получение ТТН'],['settingHoldResetCycle','Сброс таймера']]) {
        const input=document.getElementById(id);if(!input)continue;
        move(input.closest('.form-group'),hold);
        range(input,title,id==='settingHoldResetCycle'?.1:0,5,.1,sec,id==='settingHoldResetCycle'?'0,1 с':'Сразу','5 с');
      }
      move(document.getElementById('hapticArrive')?.closest('.settings-row'),haptic);
      const existingRow=document.getElementById('hapticArrive')?.closest('.settings-row');
      existingRow?.classList.add('soft-original-haptic');
      if(existingRow && !existingRow.dataset.softLabel) {
        const text=existingRow.firstElementChild; if(text){existingRow.dataset.softLabel=text.textContent;text.textContent='Вибрация при прибытии';}
      }
      move(document.getElementById('soft-motion-setting'),motion);
      const animationToggle=document.getElementById('soft-motion-setting');
      const firstSlider=motion.querySelector('.form-group');
      if(animationToggle && firstSlider && animationToggle.nextElementSibling!==firstSlider) motion.insertBefore(animationToggle,firstSlider);
      // Late-added original settings (timer reset, backups, etc.) stay intact.
      for(const key of ['Arrive','Load','Ttn']) {
        const input=document.getElementById('soft-vib-'+key);
        if(input)input.value=settings['haptic'+key] ? (prefs['vib'+key]??({Arrive:12,Load:30,Ttn:25}[key])) : 0;
      }
      for(const item of converted)item.refresh();
    }
    function newRange(parent,id,title,value,min,max,step,format,left,right,onChange) {
      const row=document.createElement('div');row.className='form-group';
      const input=document.createElement('input');input.id=id;input.value=value;row.append(input);parent.append(row);
      range(input,title,min,max,step,format,left,right);
      input.addEventListener('input',()=>onChange(Number(input.value)));return input;
    }
    for(const [key,title] of [['Arrive','Прибытие'],['Load','Погрузка'],['Ttn','Получение ТТН']]) {
      newRange(haptic,'soft-vib-'+key,title,settings['haptic'+key]?(prefs['vib'+key]??({Arrive:12,Load:30,Ttn:25}[key])):0,0,80,1,n=>n?n+' мс':'Выключено','Выкл.','80 мс',value=>{
        prefs['vib'+key]=value;savePrefs();toggleSetting('haptic'+key,value>0);
        const toggle=document.getElementById('haptic'+key);if(toggle)toggle.checked=value>0;
      });
      const name='vib'+key;
      const orig=window[name];vibOriginals[name]=orig;
      window[name]=function(){
        if(!Object.prototype.hasOwnProperty.call(prefs,name))return orig?.apply(this,arguments);
        if(settings['haptic'+key] && prefs[name]>0) vibrate(prefs[name]);
      };
    }
    // Slider has a smooth wide calm range but retains the original fastest endpoint (0.7x).
    // Normal (1x) is at 70%, giving useful control near regular/fast speeds.
    function paceForSlider(position) {
      const x=Math.min(100,Math.max(0,position));
      return x<=70 ? Math.exp(Math.log(7.2)*(1-x/70)) : 1-.3*(x-70)/30;
    }
    function sliderForPace(pace) {
      const p=Math.min(7.2,Math.max(.7,pace));
      return p>=1 ? 70*(1-Math.log(p)/Math.log(7.2)) : 70+30*(1-p)/.3;
    }
    newRange(motion,'soft-motion-pace','Темп',sliderForPace(prefs.pace),0,100,1,
      n=>paceForSlider(n).toFixed(1).replace('.',',')+'× · '+(n<60?'Спокойный':n>80?'Быстрый':'Обычный'),
      'Спокойнее · до 7,2×','Быстрее · 0,7×',
      value=>{prefs.pace=paceForSlider(value);savePrefs();});
    newRange(motion,'soft-motion-spring','Пружина',prefs.spring,0,100,5,n=>n===0?'Без отскока':n<35?'Лёгкая':n<70?'Мягкая':'Выраженная','Без отскока','Сильный отскок',value=>{prefs.spring=value;savePrefs();});
    const preview=document.createElement('div');preview.className='soft-preview';preview.setAttribute('aria-hidden','true');preview.innerHTML='<span></span><span></span><span></span>';motion.append(preview);
    const previewButton=document.createElement('button');previewButton.type='button';previewButton.className='soft-preview-button';previewButton.textContent='Посмотреть движение';motion.append(previewButton);
    // Preview never sends samples beyond its clipped window and restarts on every tap.
    let previewAnimations=[];
    previewButton.onclick=()=>{
      if(reduce.matches){previewButton.textContent='Уменьшение движения включено на устройстве';return;}
      previewAnimations.forEach(a=>a.cancel());previewAnimations=[];
      const cards=[...preview.querySelectorAll('span')];
      if(!cards.length)return;
      const travel=Math.max(4,Math.min(24,(preview.clientWidth-186)/2+8));
      const duration=560*prefs.pace;
      cards.forEach((el,i)=>{
        const dx=[travel,-travel*.55,-travel][i],dy=[8,-8,6][i];
        if(typeof el.animate==='function')
          previewAnimations.push(el.animate(springFrames(dx,dy),{duration,easing:'linear',fill:'none'}));
      });
    };
    const observer=new MutationObserver(()=>{if(modal.classList.contains('open'))layout();});
    // Only new groups matter; value/text changes must not trigger a loop.
    observer.observe(body,{childList:true});
    function open(){const r=originalOpen?.apply(this,arguments);layout();return r;}
    window.openSettingsModal=open;layout();
    return ()=>{
      observer.disconnect();modal.classList.remove('soft-settings');style.remove();
      if(window.openSettingsModal===open)window.openSettingsModal=originalOpen;
      for(const [name,fn] of Object.entries(vibOriginals))window[name]=fn;
      for(const {input,attributes,label,head,ends,refresh} of converted){
        input.removeEventListener('input',refresh);head.remove();ends.remove();if(label)label.hidden=false;
        for(const attr of Array.from(input.attributes))input.removeAttribute(attr.name);
        for(const [name,value] of attributes)input.setAttribute(name,value);
      }
      const row=document.getElementById('hapticArrive')?.closest('.settings-row');
      row?.classList.remove('soft-original-haptic');
      if(row?.dataset.softLabel){row.firstElementChild.textContent=row.dataset.softLabel;delete row.dataset.softLabel;}
      for(const {el,marker} of moved.reverse()){marker.replaceWith(el);}
      owned.forEach(el=>el.remove());
    };
  }
})();

    if(window.__lineSoftMotionV1?.version!=='1.1.0-test')
      console.warn('[test motion] Updated motion module was not installed');
  } catch(error) { console.error('[test motion] Motion upgrade failed',error); }
  finally { upgrading=false; }
}
// Firebase patches may arrive asynchronously; their UI insertion signals installation.
const source=document.querySelector('#settingsModal .modal-body');
if(source)new MutationObserver(upgrade).observe(source,{childList:true});
upgrade();
window.addEventListener('pageshow',upgrade);
})();
