(function settingsHub(){
'use strict';
const sections=[
 {key:'hold',icon:'⏱️',label:'Удержание кнопок',desc:'Погрузка, прибытие, ТТН и сброс',ids:['settingHoldLoad','settingHoldArrive','settingHoldTtn','settingHoldResetCycle']},
 {key:'cycle',icon:'🚛',label:'Время ходки',desc:'Общий интервал рейсов',ids:['settingCycleMinutes']},
 {key:'vibration',icon:'📳',label:'Вибрация',desc:'Кнопки, интерфейс, сила отклика',ids:['hapticArrive','hapticLoad','hapticTtn','globalUiHaptics','globalUiHapticsLevel','soft-vib-Arrive','soft-vib-Load','soft-vib-Ttn']},
 {key:'motion',icon:'🎬',label:'Анимации',desc:'Анимация карточек на «Линии»',ids:['soft-motion-pace','soft-motion-spring','soft-motion-spring-speed'],blocks:['speed-settings-block','soft-motion-setting']},
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
