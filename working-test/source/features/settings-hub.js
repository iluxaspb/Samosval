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
// Стили хаба настроек вынесены в styles/style-04.css (блок «Хаб настроек»);
// старые инъекции чистим на случай обновления канала.
(document.getElementById('test-settings-hub-css')||{remove(){}}).remove?.();

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
