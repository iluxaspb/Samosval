(function settingsHub(){
'use strict';
const sections=[
 {key:'hold',icon:'⏱️',label:'Удержание кнопок',desc:'Погрузка, прибытие, ТТН и сброс',ids:['settingHoldLoad','settingHoldArrive','settingHoldTtn','settingHoldResetCycle']},
 {key:'cycle',icon:'🚛',label:'Время ходки',desc:'Общий интервал рейсов',ids:['settingCycleMinutes']},
 {key:'vibration',icon:'📳',label:'Вибрация',desc:'Кнопки, интерфейс, сила отклика',ids:['hapticArrive','hapticLoad','hapticTtn','globalUiHaptics','globalUiHapticsLevel']},
 {key:'motion',icon:'🎬',label:'Анимации',desc:'Скорость движения карточек',blocks:['speed-settings-block']},
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
function gather(){
 for(const s of sections){
   if(s.key==='other')continue;
   const panel=panes.get(s.key);
   for(const id of s.ids||[]){
     const field=document.getElementById(id);
     const row=field?.closest('.form-group,.settings-row')||field;
     if(row&&row!==panel&&row.parentNode!==panel)panel.append(row);
   }
   for(const id of s.blocks||[]){
     const block=document.getElementById(id);
     if(block&&block.parentNode!==panel)panel.append(block);
   }
 }
 for(const item of [...original.children])panes.get('other').append(item);
 tiles.get('other').hidden=!panes.get('other').children.length;
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
