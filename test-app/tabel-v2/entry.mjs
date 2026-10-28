import {lineCalendarDate} from './domain.mjs';
import {mount} from './ui.mjs';
let opened=null;
export async function open(host,settingsOnly=false){
  const initial=host.session();
  function check(edit=false){const s=host.session();if(s.projectId!=='samosval-offline'||!s.uid||!s.active||!s.view||s.uid!==initial.uid||s.workspaceId!==initial.workspaceId||s.objectId!==initial.objectId)throw Error('Нет доступа или объект сменился. Откройте табель заново.');if(edit&&!s.edit)throw Error('Нет права редактировать табель');}
  check();if(!initial.objectId)throw Error('Сначала выберите объект и начните смену на «Линии»');
  if(opened){opened.close();opened.remove();opened=null;}
  const object=host.objects.find(x=>x.id===initial.objectId);if(!object)throw Error('Объект отсутствует в доступном справочнике');
  const url=name=>new URL(name,import.meta.url);
  const text=async name=>{const r=await fetch(url(name));if(!r.ok)throw Error('Не удалось загрузить экран табеля');return r.text()};
  const catalog=async name=>{const s=await host.workspace.collection(name).get();return s.docs.map(d=>({...d.data(),id:d.id})).filter(x=>!x.deleted)};
  const [html,css,equipment,people]=await Promise.all([text('view.html'),text('ui.css'),catalog('timesheetEquipment'),catalog('timesheetPeople')]);check();
  const key=JSON.stringify(['tabel-v2-draft',1,initial.projectId,initial.workspaceId,initial.uid,object.id]);
  const load=()=>{const value=localStorage.getItem(key);if(!value)return null;try{const data=JSON.parse(value);if(!data.settings||!Array.isArray(data.shifts))throw Error();return data}catch{throw Error('Черновик повреждён. Он сохранён без изменений; восстановление требуется отдельно.')}};
  load();
  const dialog=document.createElement('dialog');dialog.style.cssText='padding:0;border:0;width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;margin:0';
  const surface=document.createElement('div');dialog.append(surface);const root=surface.attachShadow({mode:'open'});root.innerHTML=`<style>${css}:host{display:block;height:100%;overflow:auto;background:#f3f6f8}header{position:sticky;top:0;z-index:2}</style>${html}`;
  root.querySelectorAll('[data-object]').forEach(el=>el.textContent=object.name);
  const close=document.createElement('button');close.textContent='Закрыть';close.onclick=()=>dialog.close();root.querySelector('header').append(close);
  document.body.append(dialog);opened=dialog;let timer;
  dialog.addEventListener('close',()=>{clearInterval(timer);dialog.remove();if(opened===dialog)opened=null},{once:true});
  try{const ui=mount(root,{object,date:lineCalendarDate(host.shift?.startDate),startDate:'2000-01-01',equipment:equipment.map(x=>({...x,ownership:x.ownership==='hired'?'hired':'owned'})),people,load,save:data=>{check(true);localStorage.setItem(key,JSON.stringify(data))},check,canEdit:initial.edit});dialog.showModal();if(settingsOnly)ui.openSettings();timer=setInterval(()=>{try{check()}catch{dialog.close()}},500)}catch(e){dialog.remove();opened=null;throw e}
}
